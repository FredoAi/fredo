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
use super::super::stream::EngineEvent;
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
    let mut token_pieces: u64 = 0;

    match handle.chat(request) {
        Err((_code, detail)) => failure = Some(detail),
        Ok(()) => {
            while let Some(event) = events_rx.recv().await {
                match event {
                    EngineEvent::Token(piece) => {
                        token_pieces += 1;
                        content.push_str(&piece);
                    }
                    EngineEvent::ToolCall {
                        name, arguments, ..
                    } => calls.push(ObservedCall { name, arguments }),
                    EngineEvent::Failed { detail, .. } => failure = Some(detail),
                    // The hidden reasoning channel is never part of the reply, and
                    // the terminal `Finished` carries no measurement this seam exposes.
                    EngineEvent::Reasoning(_) | EngineEvent::Finished { .. } => {}
                }
            }
        }
    }

    let latency_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    let after = mtp_snapshot(handle);

    let measurements = ScoreMeasurements {
        latency_ms,
        // The streaming seam exposes no prompt-token count, so it is reported as 0;
        // the completion figure is the visible text pieces the engine released.
        prompt_tokens: 0,
        completion_tokens: token_pieces,
        mtp_drafts_proposed: after.0.saturating_sub(before.0),
        mtp_drafts_accepted: after.1.saturating_sub(before.1),
        mtp_draft_calls: after.2.saturating_sub(before.2),
    };

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
}
