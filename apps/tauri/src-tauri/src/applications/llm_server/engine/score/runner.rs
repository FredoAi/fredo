//! The score runner (Spec #3232, ST-2): drive the fixture set through the ONE
//! engine seam.
//!
//! Every fixture runs as ONE `ChatRequest` on the SHIPPED
//! [`CompanionEngineHandle`] — the same request/handle seam the chat command
//! drives — and this module drains the engine's [`EngineEvent`] channel exactly
//! as the shipped streaming consumers do. There is no second loader, shaper or
//! sampler.
//!
//! ## Cumulative counters are diffed per fixture
//!
//! [`EngineStatusSnapshot::mtp_stats`] is **cumulative for the process**, so the
//! runner snapshots it before and after each fixture's turn and records the
//! delta — never the running total.

use std::sync::Arc;
use std::time::Instant;

use super::super::handle::{CompanionEngineHandle, EngineSlot};
use super::super::paths::EnginePaths;
use super::super::stream::{EngineEvent, TurnMeasurement};
use super::super::{ChatRequest, CompanionBackendMode};
use super::expect::{evaluate, ObservedCall, ObservedTurn};
use super::{CompanionScoreResult, ScoreFixture, ScoreMeasurements};

/// The engine-event buffer for one turn (the shipped streaming buffer's size).
pub const EVENT_BUFFER: usize = 256;

/// Score every fixture through `handle`, returning one record per fixture in the
/// fixture set's order.
///
/// The engine must already be started by the caller (the CLI starts it, exactly
/// as the `companion probe` diagnostic does).
pub async fn score_fixtures(
    handle: &CompanionEngineHandle,
    fixtures: &[ScoreFixture],
    paths: &EnginePaths,
    mode: CompanionBackendMode,
) -> Vec<CompanionScoreResult> {
    let mut results = Vec::with_capacity(fixtures.len());
    for fixture in fixtures {
        results.push(score_one(handle, fixture, paths, mode).await);
    }
    results
}

/// Run one fixture's turn and score it against its OWN expectation.
async fn score_one(
    handle: &CompanionEngineHandle,
    fixture: &ScoreFixture,
    paths: &EnginePaths,
    mode: CompanionBackendMode,
) -> CompanionScoreResult {
    let before = mtp_snapshot(handle);
    let started = Instant::now();

    let (events_tx, mut events_rx) = tokio::sync::mpsc::channel(EVENT_BUFFER);
    let request = ChatRequest {
        turn: fixture.turn.clone(),
        events: events_tx,
        paths: paths.clone(),
        mode,
        seed: fixture.seed,
    };

    let mut content = String::new();
    let mut calls: Vec<ObservedCall> = Vec::new();
    let mut failure: Option<String> = None;
    // The engine's per-turn cost readout, carried on the terminal `Finished` event
    // (Spec #3234, ST-5). A turn that settled WITHOUT a `Finished` (a typed
    // failure) leaves this at the zeroes, which is the truthful "not measured".
    let mut measurement = TurnMeasurement::default();

    match handle.chat(request) {
        Err((_code, detail)) => failure = Some(detail),
        Ok(()) => {
            while let Some(event) = events_rx.recv().await {
                match event {
                    EngineEvent::Token(piece) => {
                        content.push_str(&piece);
                    }
                    EngineEvent::ToolCall {
                        name, arguments, ..
                    } => calls.push(ObservedCall { name, arguments }),
                    EngineEvent::Failed { detail, .. } => failure = Some(detail),
                    // The hidden reasoning channel is never part of the reply.
                    EngineEvent::Reasoning(_) => {}
                    // The terminal event carries the engine's own cost readout
                    // (Spec #3234, ST-5): the prompt's token count, its prefill and
                    // decode spans, and the generated-token count.
                    EngineEvent::Finished {
                        measurement: turn_measurement,
                        ..
                    } => measurement = turn_measurement,
                }
            }
        }
    }

    let latency_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    let after = mtp_snapshot(handle);
    let mtp = (
        after.0.saturating_sub(before.0),
        after.1.saturating_sub(before.1),
        after.2.saturating_sub(before.2),
    );
    let measurements = measurements_from(latency_ms, measurement, mtp);

    let observed = ObservedTurn {
        calls,
        content,
        failure,
    };
    let outcome = evaluate(&fixture.expect, &observed);
    if outcome.passed {
        CompanionScoreResult::passed(fixture.id, fixture.seed, measurements)
    } else {
        CompanionScoreResult::failed(fixture.id, fixture.seed, measurements, outcome.detail)
    }
}

/// Reduce one turn's engine cost readout plus its MTP-counter diff into the
/// harness's [`ScoreMeasurements`] (Spec #3234, ST-5).
///
/// The cost numbers are the engine's OWN per-turn readout carried on the terminal
/// [`EngineEvent::Finished`] — never a hard-coded `0` and never the visible
/// text-piece count:
///
/// * `prompt_tokens` is the engine's media-inclusive prompt token count;
/// * `completion_tokens` is the tokens the engine GENERATED;
/// * `prefill_micros` / `decode_micros` are the two wall-clock spans, so the
///   decode rate is `completion_tokens` over `decode_micros`.
///
/// Pure and engine-free, so the mapping — the whole point of ST-5 — is pinned
/// directly (a reddening control would show the pre-change `prompt_tokens: 0`
/// failing it).
pub fn measurements_from(
    latency_ms: u64,
    measurement: TurnMeasurement,
    mtp: (u64, u64, u64),
) -> ScoreMeasurements {
    ScoreMeasurements {
        latency_ms,
        prompt_tokens: measurement.prompt_tokens,
        completion_tokens: measurement.generated_tokens,
        prefill_micros: measurement.prefill_micros,
        decode_micros: measurement.decode_micros,
        mtp_drafts_proposed: mtp.0,
        mtp_drafts_accepted: mtp.1,
        mtp_draft_calls: mtp.2,
    }
}

/// The process-cumulative MTP counters `(proposed, accepted, calls)`.
fn mtp_snapshot(handle: &CompanionEngineHandle) -> (u64, u64, u64) {
    let slot: Arc<std::sync::Mutex<EngineSlot>> = handle.slot();
    let guard = slot
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match guard.snapshot.mtp_stats {
        Some(stats) => (stats.drafts_proposed, stats.drafts_accepted, stats.draft_calls),
        None => (0, 0, 0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The MTP snapshot reads the engine's published cumulative counters (and
    /// reports zero before the first load) — the per-fixture diff's source.
    #[test]
    fn the_mtp_snapshot_reads_the_published_counters() {
        let handle = CompanionEngineHandle::spawn();
        assert_eq!(mtp_snapshot(&handle), (0, 0, 0));
        {
            let slot = handle.slot();
            let mut guard = slot.lock().expect("slot");
            guard.snapshot.mtp_stats = Some(super::super::super::mtp::MtpStats {
                drafts_proposed: 5,
                drafts_accepted: 3,
                draft_calls: 2,
            });
        }
        assert_eq!(mtp_snapshot(&handle), (5, 3, 2));
        handle.stop();
    }

    /// Spec #3234, ST-5: the harness's measurements are the ENGINE's readout —
    /// the media-inclusive prompt token count, the GENERATED token count, and the
    /// two wall-clock spans — never a hard-coded `prompt_tokens: 0` and never the
    /// count of visible text pieces a consumer assembled.
    ///
    /// The non-vacuity control is IN the assertion: `prompt_tokens` and
    /// `completion_tokens` are DIFFERENT values from the ones the pre-change code
    /// produced (`0` and the piece count), so the pre-change code fails this pin.
    #[test]
    fn the_measurements_come_from_the_engines_readout() {
        let measurement = TurnMeasurement {
            // The 1120-budget media turn: a prompt far larger than the 512 default
            // the old code reported as `0`.
            prompt_tokens: 1_248,
            prefill_micros: 91_000,
            decode_micros: 40_000,
            // The engine generated 16 tokens; a consumer assembling DELTAS would
            // have counted a different (piece) number, which this pin forbids.
            generated_tokens: 16,
        };
        let measurements = measurements_from(1_500, measurement, (5, 3, 2));
        assert_eq!(measurements.latency_ms, 1_500);
        assert_eq!(measurements.prompt_tokens, 1_248);
        assert_eq!(measurements.completion_tokens, 16);
        assert_eq!(measurements.prefill_micros, 91_000);
        assert_eq!(measurements.decode_micros, 40_000);
        assert_eq!(measurements.mtp_drafts_proposed, 5);
        assert_eq!(measurements.mtp_drafts_accepted, 3);
        assert_eq!(measurements.mtp_draft_calls, 2);
        // The decode rate the record's docs promise is derivable directly.
        assert_eq!(
            measurements.completion_tokens * 1_000_000 / measurements.decode_micros,
            400
        );
    }

    /// A turn that settled WITHOUT a `Finished` (a typed failure) reports the
    /// zeroes — the truthful "not measured", never a fabricated cost.
    #[test]
    fn a_settled_failed_turn_reports_the_zero_readout() {
        let measurements = measurements_from(7, TurnMeasurement::default(), (0, 0, 0));
        assert_eq!(measurements.prompt_tokens, 0);
        assert_eq!(measurements.completion_tokens, 0);
        assert_eq!(measurements.prefill_micros, 0);
        assert_eq!(measurements.decode_micros, 0);
    }
}
