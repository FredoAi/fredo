//! Doom autoplay control loop (Spec #2969, ST-3).
//!
//! The continuous-state owner (G-123): the read → decide → validate → step loop
//! that drives the frozen (`-apilockstep`) engine on its own, reacts to a terminal
//! observation with exactly ONE bounded [`restart_with`] within the next
//! iteration, and fails safe on an unusable decision within a consecutive-failure
//! budget. It performs NO model call (the [`DoomDecisionSource`] is injected), NO
//! UI, and NO Tauri command — ST-5 owns the command surface and the event.
//!
//! ## Loop shape (R-1)
//!
//! ```text
//! GET /api/state ─▶ decide(observation) ─▶ validate {tics, actions}
//!                ─▶ POST /api/step {tics, actions} ─▶ post-step observation
//!                ─▶ repeat
//! ```
//!
//! ## Bounded, never-hang (G-263 / R-4 / R-5)
//!
//! * every engine request keeps the slice-1 client's `DOOM_REQUEST_TIMEOUT_S`;
//! * every decision is wrapped in [`DoomAutoplayConfig::decision_timeout`]
//!   ([`DOOM_AUTOPLAY_DECISION_TIMEOUT_S`]);
//! * unusable decisions issue NO step and retry after
//!   [`DoomAutoplayConfig::failure_backoff`] ([`DOOM_AUTOPLAY_FAILURE_BACKOFF_MS`]),
//!   stopping with `Failed` / `DecisionFailed` on the
//!   [`DoomAutoplayConfig::max_failures`]-th consecutive failure
//!   ([`DOOM_AUTOPLAY_MAX_FAILURES`]);
//! * the total engine-advancing budget ([`DoomAutoplayConfig::max_steps`],
//!   [`DOOM_AUTOPLAY_MAX_STEPS`]) bounds steps AND restarts, so a persistently
//!   terminal engine can never repeat one terminal step indefinitely (R-3).
//!
//! ## Recorded rate target (R-5)
//!
//! [`DOOM_AUTOPLAY_RATE_TARGET_STEPS_PER_S`] is DERIVED from ST-1's live-measured
//! `POST /api/step` RTT (median [`DOOM_AGENT_ENGINE_STEP_RTT_MEDIAN_MS`]) — never a
//! guessed round number and never an idle-frame rate (G-316). See
//! `spikes/2969-doom-agent/action-vocabulary.md` §5.
//!
//! ## Progress observable (ST-1 finding)
//!
//! [`is_progress`] encodes the composite observable: `tic` strictly increases AND
//! at least one of `level.kills` / `level.items` / `player.{x,y}` improves.
//! `exit.distance` is fair-play gated (absent until the exit wall is mapped) and is
//! therefore OPTIONAL — never required.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::Value;

use crate::infrastructure::companion::doom_decision::{
    DoomDecision, DoomDecisionError, DoomDecisionSource,
};

use super::actions::{DOOM_STEP_TICS_MAX, DOOM_STEP_TICS_MIN};
use super::autoplay::{
    DoomAutoplayErrorCode, DoomAutoplayPhase, DoomAutoplayResult, DoomAutoplayStatus,
    DOOM_AUTOPLAY_DECISION_TIMEOUT_S, DOOM_AUTOPLAY_FAILURE_BACKOFF_MS, DOOM_AUTOPLAY_MAX_FAILURES,
    DOOM_AUTOPLAY_MAX_STEPS,
};
use super::client::{read_state_with, restart_with, step_with, DoomHttpTransport};
use super::progress::DoomProgressWriter;
use super::save::DoomCampaign;

// ── Measured rate basis (R-5 / AC5) ──────────────────────────────────────────

/// ST-1's live-measured `POST /api/step {"tics":1,"actions":[]}` RTT median in
/// milliseconds (N=25 against the staged `restful-doom.exe` under `-apilockstep`).
///
/// Source: `spikes/2969-doom-agent/action-vocabulary.md` §5. This is the measured
/// engine cost the recorded rate target is derived from — never guessed (G-316).
pub const DOOM_AGENT_ENGINE_STEP_RTT_MEDIAN_MS: f64 = 12.37;

/// The engine-only step ceiling (steps/s) implied by the measured median RTT:
/// `1000 / 12.37 ≈ 80.8` → `80`.
pub const DOOM_AGENT_ENGINE_STEP_CEILING_STEPS_PER_S: u32 = 80;

/// The recorded **sustained decision-rate target** (steps/s) for the autoplay loop.
///
/// DERIVED from ST-1's measured per-step RTT, not guessed and not an idle-frame
/// rate (G-316): each loop iteration pays TWO engine round-trips — one
/// `GET /api/state` read and one `POST /api/step` — each anchored to the measured
/// median [`DOOM_AGENT_ENGINE_STEP_RTT_MEDIAN_MS`], so the sustained target is
/// `1000 / (2 × 12.37) ≈ 40` steps/s (half the engine-only ceiling
/// [`DOOM_AGENT_ENGINE_STEP_CEILING_STEPS_PER_S`]).
pub const DOOM_AUTOPLAY_RATE_TARGET_STEPS_PER_S: u32 = 40;

// ── Configuration ────────────────────────────────────────────────────────────

/// The bounded budgets and pacing of one autoplay run.
///
/// The campaign coordinates the loop plays (and advances) are NOT part of this
/// config: they are resolved at the composition root and passed to
/// [`run_autoplay_loop`] as a [`DoomCampaign`] (Spec #2972 R-1/R-3), so the loop
/// owns no default level and no `AppHandle`.
#[derive(Clone, Copy, Debug)]
pub struct DoomAutoplayConfig {
    /// Total engine-advancing operations (steps + episode restarts/advances,
    /// including the initial resume positioning) allowed.
    pub max_steps: u32,
    /// Consecutive unusable decisions allowed before the run fails.
    pub max_failures: u32,
    /// Bound on a single decision.
    pub decision_timeout: Duration,
    /// Backoff between a failed decision and its retry.
    pub failure_backoff: Duration,
}

impl Default for DoomAutoplayConfig {
    fn default() -> Self {
        Self {
            max_steps: DOOM_AUTOPLAY_MAX_STEPS,
            max_failures: DOOM_AUTOPLAY_MAX_FAILURES,
            decision_timeout: Duration::from_secs(DOOM_AUTOPLAY_DECISION_TIMEOUT_S),
            failure_backoff: Duration::from_millis(DOOM_AUTOPLAY_FAILURE_BACKOFF_MS),
        }
    }
}

// ── Pure validation + observation helpers ────────────────────────────────────

/// Validate a decision against the engine's `POST /api/step` contract: `tics` must
/// be within [`DOOM_STEP_TICS_MIN`]..=[`DOOM_STEP_TICS_MAX`] and `actions` must be
/// an array.
///
/// `actions` is a `Vec<Value>` in [`DoomDecision`], so array-ness is structural at
/// the contract boundary; the engine itself rejects an invalid action object with
/// HTTP 400. The `tics` range is the loop's own responsibility — ST-2's scripted
/// lever deliberately passes an out-of-range value through unvalidated.
pub fn validate_decision(decision: &DoomDecision) -> Result<(), String> {
    if decision.tics < DOOM_STEP_TICS_MIN || decision.tics > DOOM_STEP_TICS_MAX {
        return Err(format!(
            "decision tics {} is out of range {}..={}",
            decision.tics, DOOM_STEP_TICS_MIN, DOOM_STEP_TICS_MAX
        ));
    }
    Ok(())
}

/// The terminal kind of an engine observation (Spec #2972 R-3).
///
/// A death restarts the SAME level (no advance); a level exit advances the
/// campaign (or completes it at the final level).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TerminalKind {
    /// The player died (`outcome == "dead"`).
    Death,
    /// The level was exited (`done == true`, not a death).
    Exit,
}

/// Classify a terminal observation, or `None` when the level is still running.
///
/// Death is checked first: `outcome == "dead"` is a death even if `done` is also
/// set (the stub's death latches `done` off, but the real engine's precedence is
/// not assumed). Everything else with `done == true` is a level exit.
pub fn terminal_kind(observation: &Value) -> Option<TerminalKind> {
    if observation.get("outcome").and_then(Value::as_str) == Some("dead") {
        return Some(TerminalKind::Death);
    }
    if observation
        .get("done")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Some(TerminalKind::Exit);
    }
    None
}

/// Whether the engine's observation reports a terminal state: the level is done or
/// the player is dead (R-3).
pub fn is_terminal(observation: &Value) -> bool {
    terminal_kind(observation).is_some()
}

/// The composite progress observable (ST-1 finding): `tic` strictly increases AND
/// at least one of `level.kills` / `level.items` / `player.{x,y}` improves.
///
/// `exit.distance` is fair-play gated — the field is absent until the exit wall is
/// mapped — so a decrease in `exit.distance` also counts as progress but is NEVER
/// required (the plan's binding decision 4).
pub fn is_progress(previous: &Value, next: &Value) -> bool {
    let advanced = match (
        previous.get("tic").and_then(Value::as_u64),
        next.get("tic").and_then(Value::as_u64),
    ) {
        (Some(before), Some(after)) => after > before,
        _ => false,
    };
    advanced && component_improved(previous, next)
}

/// At least one non-terminal progress component improved (see [`is_progress`]).
fn component_improved(previous: &Value, next: &Value) -> bool {
    let counter_up = |key: &str| {
        let path = format!("/level/{key}");
        match (
            previous.pointer(&path).and_then(Value::as_i64),
            next.pointer(&path).and_then(Value::as_i64),
        ) {
            (Some(before), Some(after)) => after > before,
            _ => false,
        }
    };
    if counter_up("kills") || counter_up("items") {
        return true;
    }

    let position_moved = |key: &str| {
        let path = format!("/player/{key}");
        match (
            previous.pointer(&path).and_then(Value::as_i64),
            next.pointer(&path).and_then(Value::as_i64),
        ) {
            (Some(before), Some(after)) => before != after,
            _ => false,
        }
    };
    if position_moved("x") || position_moved("y") {
        return true;
    }

    // exit.distance is OPTIONAL (fair-play gated): a decrease counts, absence never
    // counts against progress.
    match (
        previous.pointer("/exit/distance").and_then(Value::as_i64),
        next.pointer("/exit/distance").and_then(Value::as_i64),
    ) {
        (Some(before), Some(after)) => after < before,
        _ => false,
    }
}

/// Update the status' observation-derived fields from an engine observation.
///
/// Reads `tic`, `outcome`, and the live `level.episode` / `level.map` (Spec #2972:
/// the resume path starts reading the level coordinates the loop previously
/// ignored).
fn apply_observation(status: &mut DoomAutoplayStatus, observation: &Value) {
    if let Some(tic) = observation.get("tic").and_then(Value::as_u64) {
        status.last_tic = Some(tic);
    }
    if let Some(outcome) = observation.get("outcome").and_then(Value::as_str) {
        status.outcome = Some(outcome.to_string());
    }
    if let Some(episode) = observation.pointer("/level/episode").and_then(Value::as_i64) {
        status.episode = Some(episode);
    }
    if let Some(map) = observation.pointer("/level/map").and_then(Value::as_i64) {
        status.map = Some(map);
    }
}

/// The running status seeded from the resolved campaign (so the resume point is
/// visible before the first engine observation).
fn running_status(campaign: &DoomCampaign) -> DoomAutoplayStatus {
    DoomAutoplayStatus {
        phase: DoomAutoplayPhase::Running,
        running: true,
        steps: 0,
        decisions: 0,
        failures: 0,
        consecutive_failures: 0,
        last_tic: None,
        outcome: None,
        episode: Some(campaign.episode),
        map: Some(campaign.map),
        completed: false,
        started_at: Some(chrono::Utc::now().to_rfc3339()),
        last_error: None,
        code: None,
    }
}

/// The terminal completion status for a resolved `completed:true` campaign
/// (Spec #2972 G-321 terminality).
fn completed_status(campaign: &DoomCampaign) -> DoomAutoplayStatus {
    DoomAutoplayStatus {
        phase: DoomAutoplayPhase::Completed,
        running: false,
        steps: 0,
        decisions: 0,
        failures: 0,
        consecutive_failures: 0,
        last_tic: None,
        outcome: None,
        episode: Some(campaign.episode),
        map: Some(campaign.map),
        completed: true,
        started_at: Some(chrono::Utc::now().to_rfc3339()),
        last_error: None,
        code: Some(DoomAutoplayErrorCode::CampaignComplete),
    }
}

/// The terminal result for a completed campaign (R-3).
fn campaign_complete_result(steps: u32) -> DoomAutoplayResult {
    DoomAutoplayResult {
        success: true,
        phase: DoomAutoplayPhase::Completed,
        steps,
        code: Some(DoomAutoplayErrorCode::CampaignComplete),
        error: None,
    }
}

/// Record one unusable decision. Returns `Some(result)` when the consecutive
/// budget is exhausted (the caller then observes the terminal status and returns).
fn record_decision_failure(
    status: &mut DoomAutoplayStatus,
    config: &DoomAutoplayConfig,
    detail: String,
) -> Option<DoomAutoplayResult> {
    status.failures += 1;
    status.consecutive_failures += 1;
    status.last_error = Some(detail);
    if status.consecutive_failures >= config.max_failures {
        status.phase = DoomAutoplayPhase::Failed;
        status.running = false;
        status.code = Some(DoomAutoplayErrorCode::DecisionFailed);
        Some(DoomAutoplayResult {
            success: false,
            phase: DoomAutoplayPhase::Failed,
            steps: status.steps,
            code: Some(DoomAutoplayErrorCode::DecisionFailed),
            error: status.last_error.clone(),
        })
    } else {
        None
    }
}

/// Record a bounded engine-request failure (R-4: never a hang).
fn engine_failure(status: &mut DoomAutoplayStatus, detail: String) -> DoomAutoplayResult {
    status.phase = DoomAutoplayPhase::Failed;
    status.running = false;
    status.last_error = Some(detail.clone());
    status.code = Some(DoomAutoplayErrorCode::EngineRequestFailed);
    DoomAutoplayResult {
        success: false,
        phase: DoomAutoplayPhase::Failed,
        steps: status.steps,
        code: Some(DoomAutoplayErrorCode::EngineRequestFailed),
        error: Some(detail),
    }
}

/// A bounded cooperative backoff: a single finite sleep (zero is a no-op).
async fn backoff(duration: Duration) {
    if !duration.is_zero() {
        tokio::time::sleep(duration).await;
    }
}

// ── The loop ─────────────────────────────────────────────────────────────────

/// The campaign the loop plays plus the progress writer that persists its level
/// transitions (Spec #2972 R-1/R-3/R-5).
///
/// Bundled so [`run_autoplay_loop`] keeps a focused argument list
/// (`clippy::too_many_arguments`): the composition root resolves the campaign and
/// injects the writer; the loop stays engine-agnostic and owns no `AppHandle`.
pub struct AutoplayRun {
    /// The resolved campaign to position at and advance.
    pub campaign: DoomCampaign,
    /// The continuous-state owner invoked on every level transition.
    pub progress: DoomProgressWriter,
}

/// Run the bounded read → decide → validate → step loop until the step budget is
/// exhausted, the failure budget is exhausted, a stop is requested, or an engine
/// request fails (R-1/R-3/R-4/R-5). NEVER hangs: every wait is bounded and the
/// total engine-advancing budget is finite.
///
/// `observe` is called on every status transition (including the terminal one), so
/// ST-5 can mirror the status into `DoomAutoplayState` and emit
/// `doom-autoplay-changed`. The returned [`DoomAutoplayResult`] is the same
/// terminal state.
pub async fn run_autoplay_loop(
    transport: &dyn DoomHttpTransport,
    port: u16,
    source: &dyn DoomDecisionSource,
    config: &DoomAutoplayConfig,
    run: AutoplayRun,
    stop: &AtomicBool,
    mut observe: impl FnMut(&DoomAutoplayStatus) + Send,
) -> DoomAutoplayResult {
    let AutoplayRun { campaign, progress } = run;
    // Completed-save terminality (G-321, BINDING): a resolved `completed:true`
    // campaign is terminal AT START — report completion immediately, issue NO
    // engine request, and never silently start a fresh run or re-loop the final
    // level. The explicit fresh-start path is the only replay path.
    if campaign.completed {
        let status = completed_status(&campaign);
        observe(&status);
        return campaign_complete_result(status.steps);
    }

    let mut status = running_status(&campaign);
    observe(&status);

    // A stop requested before the run begins positions nothing.
    if stop.load(Ordering::Relaxed) {
        status.phase = DoomAutoplayPhase::Idle;
        status.running = false;
        observe(&status);
        return DoomAutoplayResult {
            success: true,
            phase: DoomAutoplayPhase::Idle,
            steps: status.steps,
            code: None,
            error: None,
        };
    }

    // Steps AND episode restarts/advances share the total budget so a
    // persistently-terminal engine terminates instead of restarting forever (R-3).
    let mut budget_used: u32 = 0;
    // The campaign the loop plays; `advance()` walks it on a level exit.
    let mut campaign = campaign;
    // Set when a terminal observation was seen; consumed by exactly one
    // restart/advance on the next iteration — the terminal state is never
    // re-decided (R-3).
    let mut pending_terminal: Option<TerminalKind> = None;

    // R-1 resume positioning: position the engine at the resolved campaign coords
    // with exactly ONE `POST /api/episode {episode,map,skill,seed}` BEFORE the
    // first step. A failure is a typed engine failure (never a hang).
    match restart_with(
        transport,
        port,
        campaign.episode,
        campaign.map,
        campaign.skill,
        campaign.seed,
    )
    .await
    {
        Ok(result) => {
            budget_used += 1;
            apply_observation(&mut status, &result.state);
            observe(&status);
        }
        Err(error) => {
            let result = engine_failure(&mut status, error.message);
            observe(&status);
            return result;
        }
    }

    while budget_used < config.max_steps {
        if stop.load(Ordering::Relaxed) {
            status.phase = DoomAutoplayPhase::Idle;
            status.running = false;
            observe(&status);
            return DoomAutoplayResult {
                success: true,
                phase: DoomAutoplayPhase::Idle,
                steps: status.steps,
                code: None,
                error: None,
            };
        }

        // React to a terminal observation with exactly ONE bounded action on the
        // next iteration, then resume (R-3).
        if let Some(kind) = pending_terminal.take() {
            match kind {
                // Death restarts the SAME level: no advance, no persist.
                TerminalKind::Death => {
                    match restart_with(
                        transport,
                        port,
                        campaign.episode,
                        campaign.map,
                        campaign.skill,
                        campaign.seed,
                    )
                    .await
                    {
                        Ok(result) => {
                            budget_used += 1;
                            apply_observation(&mut status, &result.state);
                            observe(&status);
                            continue;
                        }
                        Err(error) => {
                            let result = engine_failure(&mut status, error.message);
                            observe(&status);
                            return result;
                        }
                    }
                }
                // A level exit advances the campaign, or completes it at the
                // final level (R-3).
                TerminalKind::Exit => {
                    if campaign.at_final_level() {
                        campaign.completed = true;
                        progress.record(&campaign);
                        status.phase = DoomAutoplayPhase::Completed;
                        status.running = false;
                        status.completed = true;
                        status.code = Some(DoomAutoplayErrorCode::CampaignComplete);
                        status.episode = Some(campaign.episode);
                        status.map = Some(campaign.map);
                        observe(&status);
                        return campaign_complete_result(status.steps);
                    }
                    if let Some(next) = campaign.advance() {
                        campaign = next;
                    }
                    progress.record(&campaign);
                    status.episode = Some(campaign.episode);
                    status.map = Some(campaign.map);
                    match restart_with(
                        transport,
                        port,
                        campaign.episode,
                        campaign.map,
                        campaign.skill,
                        campaign.seed,
                    )
                    .await
                    {
                        Ok(result) => {
                            budget_used += 1;
                            apply_observation(&mut status, &result.state);
                            observe(&status);
                            continue;
                        }
                        Err(error) => {
                            let result = engine_failure(&mut status, error.message);
                            observe(&status);
                            return result;
                        }
                    }
                }
            }
        }

        // 1. Read the whole observation (GET /api/state).
        let observation = match read_state_with(transport, port).await {
            Ok(view) => view.raw,
            Err(error) => {
                let result = engine_failure(&mut status, error.message);
                observe(&status);
                return result;
            }
        };
        apply_observation(&mut status, &observation);

        // Terminal states are restarted/advanced, never decided on (R-3).
        if let Some(kind) = terminal_kind(&observation) {
            pending_terminal = Some(kind);
            observe(&status);
            continue;
        }

        // 2. Decide, bounded by the per-decision timeout (R-4/R-5).
        match tokio::time::timeout(config.decision_timeout, source.decide(&observation)).await {
            Ok(Ok(decision)) => {
                status.decisions += 1;
                // 3. Validate the decision against the engine contract.
                if let Err(detail) = validate_decision(&decision) {
                    if let Some(result) = record_decision_failure(&mut status, config, detail) {
                        observe(&status);
                        return result;
                    }
                    observe(&status);
                    backoff(config.failure_backoff).await;
                    continue;
                }

                // 4. Advance the frozen world (POST /api/step {tics, actions}).
                let tics = decision.tics;
                let actions = Value::Array(decision.actions);
                match step_with(transport, port, tics, &actions).await {
                    Ok(result) => {
                        status.steps += 1;
                        budget_used += 1;
                        // A good decision resets the consecutive-failure budget.
                        status.consecutive_failures = 0;
                        apply_observation(&mut status, &result.state);
                        if let Some(kind) = terminal_kind(&result.state) {
                            pending_terminal = Some(kind);
                        }
                        observe(&status);
                    }
                    Err(error) => {
                        let result = engine_failure(&mut status, error.message);
                        observe(&status);
                        return result;
                    }
                }
            }
            Ok(Err(error)) => {
                if let Some(result) =
                    record_decision_failure(&mut status, config, error.to_string())
                {
                    observe(&status);
                    return result;
                }
                observe(&status);
                backoff(config.failure_backoff).await;
            }
            Err(_elapsed) => {
                if let Some(result) = record_decision_failure(
                    &mut status,
                    config,
                    DoomDecisionError::TimedOut.to_string(),
                ) {
                    observe(&status);
                    return result;
                }
                observe(&status);
                backoff(config.failure_backoff).await;
            }
        }
    }

    // The total step budget was reached cleanly (R-5).
    status.phase = DoomAutoplayPhase::Completed;
    status.running = false;
    status.code = Some(DoomAutoplayErrorCode::BudgetExhausted);
    observe(&status);
    DoomAutoplayResult {
        success: true,
        phase: DoomAutoplayPhase::Completed,
        steps: status.steps,
        code: Some(DoomAutoplayErrorCode::BudgetExhausted),
        error: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};

    use async_trait::async_trait;
    use serde_json::json;

    use crate::applications::doom::client::TransportError;

    /// The campaign the loop plays in a test (E1M1 defaults otherwise).
    fn campaign(episode: i64, map: i64) -> DoomCampaign {
        DoomCampaign {
            episode,
            map,
            ..DoomCampaign::initial()
        }
    }

    /// A no-op progress writer for tests that do not assert persistence.
    fn no_progress() -> DoomProgressWriter {
        DoomProgressWriter::new(|_| Ok(()))
    }

    /// A progress writer that records every persisted campaign, in order.
    fn recording_progress() -> (DoomProgressWriter, Arc<Mutex<Vec<DoomCampaign>>>) {
        let seen: Arc<Mutex<Vec<DoomCampaign>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let writer = DoomProgressWriter::new(move |save| {
            sink.lock().unwrap().push(DoomCampaign {
                episode: save.episode,
                map: save.map,
                skill: save.skill,
                seed: save.seed,
                completed: save.completed,
            });
            Ok(())
        });
        (writer, seen)
    }

    // ── Fakes ────────────────────────────────────────────────────────────────

    /// A programmable fake engine: serves `/api/state` and `/api/step` from
    /// scripted queues (falling back to a simple advancing world), resets the tick
    /// on `/api/episode` unless a scripted result is set, and records every call.
    #[derive(Default)]
    struct FakeEngine {
        calls: Mutex<Vec<String>>,
        tic: Mutex<u64>,
        episode: Mutex<i64>,
        map: Mutex<i64>,
        get_queue: Mutex<VecDeque<Result<Value, TransportError>>>,
        step_queue: Mutex<VecDeque<Result<Value, TransportError>>>,
        episode_queue: Mutex<VecDeque<Result<Value, TransportError>>>,
        episode_always_error: Mutex<Option<String>>,
    }

    impl FakeEngine {
        fn queue_get(&self, value: Value) {
            self.get_queue.lock().unwrap().push_back(Ok(value));
        }
        /// Make EVERY `/api/episode` call fail (the positioning-failure lever).
        fn set_episode_error(&self, message: &str) {
            *self.episode_always_error.lock().unwrap() = Some(message.to_string());
        }
        /// Script the next `/api/episode` results in order (advance-failure lever).
        fn queue_episode(&self, result: Result<Value, TransportError>) {
            self.episode_queue.lock().unwrap().push_back(result);
        }
        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
        fn count(&self, needle: &str) -> usize {
            self.calls().iter().filter(|call| call.contains(needle)).count()
        }
        /// The `(episode, map)` of every `POST /api/episode` body, in order.
        fn episode_calls(&self) -> Vec<(i64, i64)> {
            self.calls()
                .into_iter()
                .filter(|call| call.contains("/api/episode"))
                .filter_map(|call| {
                    let start = call.find('{')?;
                    let value: Value = serde_json::from_str(&call[start..]).ok()?;
                    Some((value.get("episode")?.as_i64()?, value.get("map")?.as_i64()?))
                })
                .collect()
        }
    }

    /// A state observation at explicit level coordinates.
    fn state_at(tic: u64, done: bool, dead: bool, episode: i64, map: i64) -> Value {
        json!({
            "tic": tic,
            "done": done,
            "outcome": if dead { "dead" } else if done { "exited" } else { "alive" },
            "level": { "episode": episode, "map": map, "kills": 0, "items": 0 },
            "player": { "x": 0, "y": 0 },
        })
    }

    /// A state observation at E1M1.
    fn state_json(tic: u64, done: bool, dead: bool) -> Value {
        state_at(tic, done, dead, 1, 1)
    }

    #[async_trait]
    impl DoomHttpTransport for FakeEngine {
        async fn get_json(&self, url: &str) -> Result<Value, TransportError> {
            self.calls.lock().unwrap().push(format!("GET {url}"));
            if url.ends_with("/api/state") {
                if let Some(scripted) = self.get_queue.lock().unwrap().pop_front() {
                    return scripted;
                }
                return Ok(state_at(
                    *self.tic.lock().unwrap(),
                    false,
                    false,
                    *self.episode.lock().unwrap(),
                    *self.map.lock().unwrap(),
                ));
            }
            Err(TransportError::message(format!("unexpected GET {url}")))
        }

        async fn post_json(&self, url: &str, body: &Value) -> Result<Value, TransportError> {
            self.calls.lock().unwrap().push(format!("POST {url} {body}"));
            if url.ends_with("/api/step") {
                if let Some(scripted) = self.step_queue.lock().unwrap().pop_front() {
                    return scripted;
                }
                let tics = body
                    .get("tics")
                    .and_then(Value::as_i64)
                    .unwrap_or(1)
                    .max(0) as u64;
                let tic = {
                    let mut tic = self.tic.lock().unwrap();
                    *tic += tics;
                    *tic
                };
                return Ok(state_at(
                    tic,
                    false,
                    false,
                    *self.episode.lock().unwrap(),
                    *self.map.lock().unwrap(),
                ));
            }
            if url.ends_with("/api/episode") {
                if let Some(message) = self.episode_always_error.lock().unwrap().clone() {
                    return Err(TransportError::message(message));
                }
                if let Some(scripted) = self.episode_queue.lock().unwrap().pop_front() {
                    return scripted;
                }
                *self.episode.lock().unwrap() = body
                    .get("episode")
                    .and_then(Value::as_i64)
                    .unwrap_or(1);
                *self.map.lock().unwrap() = body.get("map").and_then(Value::as_i64).unwrap_or(1);
                *self.tic.lock().unwrap() = 0;
                return Ok(state_at(
                    0,
                    false,
                    false,
                    *self.episode.lock().unwrap(),
                    *self.map.lock().unwrap(),
                ));
            }
            Err(TransportError::message(format!("unexpected POST {url}")))
        }
    }

    /// A decision source returning queued results in order, then a fallback.
    struct FakeSource {
        queue: Mutex<VecDeque<Result<DoomDecision, DoomDecisionError>>>,
        fallback: Result<DoomDecision, DoomDecisionError>,
        decide_calls: Mutex<u32>,
    }

    impl FakeSource {
        fn repeating(result: Result<DoomDecision, DoomDecisionError>) -> Self {
            Self {
                queue: Mutex::new(VecDeque::new()),
                fallback: result,
                decide_calls: Mutex::new(0),
            }
        }
        fn sequence(
            results: Vec<Result<DoomDecision, DoomDecisionError>>,
            fallback: Result<DoomDecision, DoomDecisionError>,
        ) -> Self {
            Self {
                queue: Mutex::new(results.into()),
                fallback,
                decide_calls: Mutex::new(0),
            }
        }
        fn decide_calls(&self) -> u32 {
            *self.decide_calls.lock().unwrap()
        }
    }

    #[async_trait]
    impl DoomDecisionSource for FakeSource {
        async fn decide(&self, _observation: &Value) -> Result<DoomDecision, DoomDecisionError> {
            *self.decide_calls.lock().unwrap() += 1;
            let mut queue = self.queue.lock().unwrap();
            match queue.pop_front() {
                Some(next) => next,
                None => self.fallback.clone(),
            }
        }
    }

    /// A source that outlives a short decision timeout (the G-300 timeout pin).
    struct SleepingSource {
        delay: Duration,
    }

    #[async_trait]
    impl DoomDecisionSource for SleepingSource {
        async fn decide(&self, _observation: &Value) -> Result<DoomDecision, DoomDecisionError> {
            tokio::time::sleep(self.delay).await;
            Ok(DoomDecision {
                tics: 1,
                actions: vec![],
            })
        }
    }

    fn decision(tics: i64) -> DoomDecision {
        DoomDecision {
            tics,
            actions: vec![],
        }
    }

    fn config(max_steps: u32, max_failures: u32) -> DoomAutoplayConfig {
        DoomAutoplayConfig {
            max_steps,
            max_failures,
            decision_timeout: Duration::from_secs(1),
            failure_backoff: Duration::ZERO,
        }
    }

    // ── Pure validation + progress observable ────────────────────────────────

    #[test]
    fn validate_decision_enforces_the_engine_tic_range() {
        assert!(validate_decision(&decision(1)).is_ok());
        assert!(validate_decision(&decision(350)).is_ok());
        assert!(validate_decision(&decision(0)).is_err());
        assert!(validate_decision(&decision(351)).is_err());
        assert!(validate_decision(&decision(-1)).is_err());
        assert!(validate_decision(&decision(9999)).is_err());
    }

    #[test]
    fn terminal_detection_covers_death_and_level_exit() {
        assert!(is_terminal(&state_json(1, true, false)));
        assert!(is_terminal(&state_json(1, false, true)));
        assert!(is_terminal(&state_json(1, true, true)));
        assert!(!is_terminal(&state_json(1, false, false)));
        assert!(!is_terminal(&json!({})));

        // The death/exit discriminator (R-3): death wins even if `done` is set;
        // a bare `done` is a level exit; neither is `None`.
        assert_eq!(terminal_kind(&state_json(1, true, false)), Some(TerminalKind::Exit));
        assert_eq!(terminal_kind(&state_json(1, false, true)), Some(TerminalKind::Death));
        assert_eq!(terminal_kind(&state_json(1, true, true)), Some(TerminalKind::Death));
        assert_eq!(terminal_kind(&state_json(1, false, false)), None);
    }

    #[test]
    fn progress_requires_a_tic_bump_and_one_component() {
        let before = json!({
            "tic": 27,
            "level": { "kills": 0, "items": 0 },
            "player": { "x": -417, "y": 183 },
            "exit": {},
        });
        // tic increases + player.y improves.
        let moved = json!({
            "tic": 28,
            "level": { "kills": 0, "items": 0 },
            "player": { "x": -417, "y": 200 },
            "exit": {},
        });
        assert!(is_progress(&before, &moved));

        // tic increases but nothing improves.
        let stuck = json!({
            "tic": 28,
            "level": { "kills": 0, "items": 0 },
            "player": { "x": -417, "y": 183 },
            "exit": {},
        });
        assert!(!is_progress(&before, &stuck));

        // a component moves but tic does not increase.
        let no_tic = json!({
            "tic": 27,
            "level": { "kills": 1, "items": 0 },
            "player": { "x": -400, "y": 200 },
            "exit": {},
        });
        assert!(!is_progress(&before, &no_tic));

        // exit.distance is optional: absent is never required.
        let exit_absent = json!({
            "tic": 28,
            "level": { "kills": 0, "items": 0 },
            "player": { "x": -417, "y": 183 },
            "exit": {},
        });
        assert!(!is_progress(&before, &exit_absent));

        // ...but a decrease in exit.distance counts when both sides carry it.
        let exit_before = json!({ "tic": 27, "exit": { "distance": 100 } });
        let exit_after = json!({ "tic": 28, "exit": { "distance": 50 } });
        assert!(is_progress(&exit_before, &exit_after));
    }

    #[test]
    fn the_rate_target_is_derived_from_the_measured_step_rtt() {
        // ST-1 measured median: 12.37 ms -> engine ceiling 1000/12.37 ~= 80.8.
        assert_eq!(DOOM_AGENT_ENGINE_STEP_RTT_MEDIAN_MS, 12.37);
        assert_eq!(DOOM_AGENT_ENGINE_STEP_CEILING_STEPS_PER_S, 80);
        // Sustained target = half the ceiling (two round-trips per iteration).
        assert_eq!(DOOM_AUTOPLAY_RATE_TARGET_STEPS_PER_S, 40);
        assert_eq!(
            DOOM_AGENT_ENGINE_STEP_CEILING_STEPS_PER_S,
            DOOM_AUTOPLAY_RATE_TARGET_STEPS_PER_S * 2
        );
    }

    // ── The loop ─────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn resume_positions_the_engine_once_before_the_first_step() {
        let engine = FakeEngine::default();
        let source = FakeSource::repeating(Ok(decision(1)));
        let stop = AtomicBool::new(false);
        let (progress, seen) = recording_progress();

        // Budget 4 = 1 resume positioning + 3 steps.
        let result = run_autoplay_loop(
            &engine,
            6666,
            &source,
            &config(4, 3),
            AutoplayRun {
                campaign: campaign(2, 3),
                progress,
            },
            &stop,
            |_| {},
        )
        .await;

        // Exactly ONE resume positioning, with the resolved coords.
        assert_eq!(engine.episode_calls(), vec![(2, 3)]);
        let calls = engine.calls();
        let first_episode = calls
            .iter()
            .position(|call| call.contains("/api/episode"))
            .expect("a positioning call");
        let first_step = calls
            .iter()
            .position(|call| call.contains("/api/step"))
            .expect("a step call");
        assert!(
            first_episode < first_step,
            "positioning precedes the first step"
        );
        // Positioning is not a level transition -> nothing persisted (R-5).
        assert!(
            seen.lock().unwrap().is_empty(),
            "no persist before the first advance"
        );
        assert_eq!(engine.count("/api/step"), 3);
        assert_eq!(result.steps, 3);
        assert_eq!(result.phase, DoomAutoplayPhase::Completed);
        assert_eq!(result.code, Some(DoomAutoplayErrorCode::BudgetExhausted));
    }

    #[tokio::test]
    async fn happy_path_runs_the_full_step_budget() {
        let engine = FakeEngine::default();
        let source = FakeSource::repeating(Ok(decision(1)));
        let stop = AtomicBool::new(false);
        let mut statuses: Vec<DoomAutoplayStatus> = Vec::new();

        // Budget 6 = 1 positioning + 5 steps.
        let result = run_autoplay_loop(
            &engine,
            6666,
            &source,
            &config(6, 3),
            AutoplayRun {
                campaign: campaign(1, 1),
                progress: no_progress(),
            },
            &stop,
            |status| {
                statuses.push(status.clone());
            },
        )
        .await;

        assert!(result.success);
        assert_eq!(result.phase, DoomAutoplayPhase::Completed);
        assert_eq!(result.code, Some(DoomAutoplayErrorCode::BudgetExhausted));
        assert_eq!(result.steps, 5);
        assert_eq!(engine.count("/api/step"), 5);
        assert_eq!(engine.count("/api/episode"), 1);
        assert_eq!(statuses.last().unwrap().phase, DoomAutoplayPhase::Completed);
        assert_eq!(statuses.last().unwrap().steps, 5);
        // The resume position is visible on the status.
        assert!(statuses
            .iter()
            .any(|status| status.episode == Some(1) && status.map == Some(1)));

        // tic strictly increases across the step transitions (step-driven). The
        // terminal `Completed` observe repeats the last tic, so dedupe first.
        let mut tics: Vec<u64> = statuses.iter().filter_map(|status| status.last_tic).collect();
        tics.dedup();
        assert!(tics.windows(2).all(|pair| pair[0] < pair[1]));
        assert_eq!(tics, vec![0, 1, 2, 3, 4, 5]);
    }

    #[tokio::test]
    async fn a_malformed_decision_never_steps_and_fails_after_the_budget() {
        let engine = FakeEngine::default();
        let source = FakeSource::repeating(Err(DoomDecisionError::Malformed("bad".to_string())));
        let stop = AtomicBool::new(false);
        let mut statuses: Vec<DoomAutoplayStatus> = Vec::new();

        let result = run_autoplay_loop(
            &engine,
            6666,
            &source,
            &config(600, 3),
            AutoplayRun {
                campaign: campaign(1, 1),
                progress: no_progress(),
            },
            &stop,
            |status| {
                statuses.push(status.clone());
            },
        )
        .await;

        assert!(!result.success);
        assert_eq!(result.phase, DoomAutoplayPhase::Failed);
        assert_eq!(result.code, Some(DoomAutoplayErrorCode::DecisionFailed));
        assert!(result.error.as_deref().unwrap().contains("malformed"));
        assert_eq!(engine.count("/api/step"), 0, "an unusable decision issues NO step");
        assert_eq!(source.decide_calls(), 3, "retries are bounded by the failure budget");
        assert_eq!(statuses.last().unwrap().failures, 3);
        assert_eq!(statuses.last().unwrap().consecutive_failures, 3);
    }

    #[tokio::test]
    async fn out_of_range_tics_is_rejected_without_a_step() {
        let engine = FakeEngine::default();
        let source = FakeSource::repeating(Ok(decision(9999)));
        let stop = AtomicBool::new(false);

        let result = run_autoplay_loop(
            &engine,
            6666,
            &source,
            &config(600, 3),
            AutoplayRun {
                campaign: campaign(1, 1),
                progress: no_progress(),
            },
            &stop,
            |_| {},
        )
        .await;

        assert_eq!(result.phase, DoomAutoplayPhase::Failed);
        assert_eq!(result.code, Some(DoomAutoplayErrorCode::DecisionFailed));
        assert!(result.error.as_deref().unwrap().contains("out of range"));
        assert_eq!(engine.count("/api/step"), 0);
    }

    #[tokio::test]
    async fn a_good_decision_resets_consecutive_failures() {
        let engine = FakeEngine::default();
        let ok = || Ok(decision(1));
        let bad = || Err(DoomDecisionError::Malformed("bad".to_string()));
        let source = FakeSource::sequence(vec![bad(), bad(), ok(), bad(), bad(), bad()], ok());
        let stop = AtomicBool::new(false);
        let mut statuses: Vec<DoomAutoplayStatus> = Vec::new();

        let result = run_autoplay_loop(
            &engine,
            6666,
            &source,
            &config(600, 3),
            AutoplayRun {
                campaign: campaign(1, 1),
                progress: no_progress(),
            },
            &stop,
            |status| {
                statuses.push(status.clone());
            },
        )
        .await;

        assert_eq!(result.phase, DoomAutoplayPhase::Failed);
        assert_eq!(result.code, Some(DoomAutoplayErrorCode::DecisionFailed));
        assert_eq!(engine.count("/api/step"), 1, "only the good decision steps");
        assert_eq!(statuses.last().unwrap().failures, 5);
        assert_eq!(statuses.last().unwrap().consecutive_failures, 3);
        // The success reset the consecutive counter to 0 after two failures.
        assert!(
            statuses
                .iter()
                .any(|status| status.failures == 2 && status.consecutive_failures == 0),
            "a good decision must reset consecutiveFailures to 0"
        );
    }

    #[tokio::test]
    async fn a_level_exit_advances_the_campaign_and_persists() {
        let engine = FakeEngine::default();
        // The first post-positioning observation is a level exit at E1M2.
        engine.queue_get(state_at(5, true, false, 1, 2));
        let source = FakeSource::repeating(Ok(decision(1)));
        let stop = AtomicBool::new(false);
        let (progress, seen) = recording_progress();

        let result = run_autoplay_loop(
            &engine,
            6666,
            &source,
            &config(4, 3),
            AutoplayRun {
                campaign: campaign(1, 2),
                progress,
            },
            &stop,
            |_| {},
        )
        .await;

        // Positioning at the resolved coords, then ONE advance to E1M3.
        assert_eq!(engine.episode_calls(), vec![(1, 2), (1, 3)]);
        let recorded = seen.lock().unwrap().clone();
        assert_eq!(recorded.len(), 1, "exactly one persist per level transition");
        assert_eq!((recorded[0].episode, recorded[0].map), (1, 3));
        assert!(!recorded[0].completed);
        assert_eq!(result.phase, DoomAutoplayPhase::Completed);
        assert_eq!(result.code, Some(DoomAutoplayErrorCode::BudgetExhausted));
    }

    #[tokio::test]
    async fn a_level_exit_wraps_to_the_next_episode() {
        let engine = FakeEngine::default();
        engine.queue_get(state_at(5, true, false, 1, 9));
        let source = FakeSource::repeating(Ok(decision(1)));
        let stop = AtomicBool::new(false);
        let (progress, seen) = recording_progress();

        let _ = run_autoplay_loop(
            &engine,
            6666,
            &source,
            &config(4, 3),
            AutoplayRun {
                campaign: campaign(1, 9),
                progress,
            },
            &stop,
            |_| {},
        )
        .await;

        assert_eq!(engine.episode_calls(), vec![(1, 9), (2, 1)]);
        let recorded = seen.lock().unwrap().clone();
        assert_eq!((recorded[0].episode, recorded[0].map), (2, 1));
        assert!(!recorded[0].completed);
    }

    #[tokio::test]
    async fn a_death_restarts_the_same_level_without_advancing_or_persisting() {
        let engine = FakeEngine::default();
        engine.queue_get(state_at(7, false, true, 2, 5));
        let source = FakeSource::repeating(Ok(decision(1)));
        let stop = AtomicBool::new(false);
        let (progress, seen) = recording_progress();

        let _ = run_autoplay_loop(
            &engine,
            6666,
            &source,
            &config(4, 3),
            AutoplayRun {
                campaign: campaign(2, 5),
                progress,
            },
            &stop,
            |_| {},
        )
        .await;

        // The death restart re-issues the SAME level coords — never an advance.
        assert_eq!(engine.episode_calls(), vec![(2, 5), (2, 5)]);
        assert!(
            seen.lock().unwrap().is_empty(),
            "death never advances and never persists a new point"
        );
    }

    #[tokio::test]
    async fn a_terminal_observation_restarts_once_then_resumes() {
        let engine = FakeEngine::default();
        engine.queue_get(state_json(5, true, false));
        let source = FakeSource::repeating(Ok(decision(1)));
        let stop = AtomicBool::new(false);

        let result = run_autoplay_loop(
            &engine,
            6666,
            &source,
            &config(3, 3),
            AutoplayRun {
                campaign: campaign(1, 1),
                progress: no_progress(),
            },
            &stop,
            |_| {},
        )
        .await;

        // Budget 3 = positioning + one advance restart + one step.
        assert_eq!(
            engine.count("/api/episode"),
            2,
            "positioning + exactly one advance restart per terminal observation"
        );
        let posts: Vec<String> = engine
            .calls()
            .into_iter()
            .filter(|call| call.starts_with("POST"))
            .collect();
        assert!(posts[0].contains("/api/episode"));
        assert_eq!(
            source.decide_calls(),
            1,
            "the terminal observation is never decided on"
        );
        assert_eq!(result.steps, 1);
        assert_eq!(result.phase, DoomAutoplayPhase::Completed);
    }

    #[tokio::test]
    async fn a_dead_observation_restarts_once_then_resumes() {
        let engine = FakeEngine::default();
        engine.queue_get(state_json(7, false, true));
        let source = FakeSource::repeating(Ok(decision(1)));
        let stop = AtomicBool::new(false);

        let result = run_autoplay_loop(
            &engine,
            6666,
            &source,
            &config(3, 3),
            AutoplayRun {
                campaign: campaign(1, 1),
                progress: no_progress(),
            },
            &stop,
            |_| {},
        )
        .await;

        assert_eq!(engine.count("/api/episode"), 2, "positioning + one death restart");
        assert_eq!(source.decide_calls(), 1);
        assert_eq!(result.steps, 1);
        assert_eq!(result.phase, DoomAutoplayPhase::Completed);
    }

    #[tokio::test]
    async fn completion_at_the_final_level_persists_completed_and_stops() {
        let engine = FakeEngine::default();
        // A level exit at the final campaign level (E4M9).
        engine.queue_get(state_at(9, true, false, 4, 9));
        let source = FakeSource::repeating(Ok(decision(1)));
        let stop = AtomicBool::new(false);
        let (progress, seen) = recording_progress();
        let mut statuses: Vec<DoomAutoplayStatus> = Vec::new();

        let result = run_autoplay_loop(
            &engine,
            6666,
            &source,
            &config(10, 3),
            AutoplayRun {
                campaign: campaign(4, 9),
                progress,
            },
            &stop,
            |status| {
                statuses.push(status.clone());
            },
        )
        .await;

        assert!(result.success);
        assert_eq!(result.phase, DoomAutoplayPhase::Completed);
        assert_eq!(result.code, Some(DoomAutoplayErrorCode::CampaignComplete));
        // Positioning only — the final level is not re-entered.
        assert_eq!(engine.episode_calls(), vec![(4, 9)]);
        let recorded = seen.lock().unwrap().clone();
        assert_eq!(recorded.len(), 1);
        assert_eq!((recorded[0].episode, recorded[0].map), (4, 9));
        assert!(recorded[0].completed, "completion persists completed=true");
        let last = statuses.last().unwrap();
        assert_eq!(last.phase, DoomAutoplayPhase::Completed);
        assert!(last.completed);
        assert!(!last.running);
    }

    #[tokio::test]
    async fn a_completed_campaign_is_terminal_at_start() {
        let engine = FakeEngine::default();
        let source = FakeSource::repeating(Ok(decision(1)));
        let stop = AtomicBool::new(false);
        let completed = DoomCampaign {
            completed: true,
            ..campaign(4, 9)
        };
        let mut statuses: Vec<DoomAutoplayStatus> = Vec::new();

        let result = run_autoplay_loop(
            &engine,
            6666,
            &source,
            &config(10, 3),
            AutoplayRun {
                campaign: completed,
                progress: no_progress(),
            },
            &stop,
            |status| {
                statuses.push(status.clone());
            },
        )
        .await;

        assert!(result.success);
        assert_eq!(result.phase, DoomAutoplayPhase::Completed);
        assert_eq!(result.code, Some(DoomAutoplayErrorCode::CampaignComplete));
        // Terminal at start: NO engine request of any kind.
        assert_eq!(
            engine.count("/api/episode"),
            0,
            "no positioning for a completed save"
        );
        assert_eq!(engine.count("/api/state"), 0);
        assert_eq!(engine.count("/api/step"), 0);
        assert_eq!(source.decide_calls(), 0);
        let last = statuses.last().unwrap();
        assert_eq!(last.phase, DoomAutoplayPhase::Completed);
        assert!(last.completed);
        assert_eq!((last.episode, last.map), (Some(4), Some(9)));
    }

    #[tokio::test]
    async fn a_failed_positioning_is_a_typed_engine_failure() {
        let engine = FakeEngine::default();
        engine.set_episode_error("POST /api/episode returned HTTP 500");
        let source = FakeSource::repeating(Ok(decision(1)));
        let stop = AtomicBool::new(false);

        let result = run_autoplay_loop(
            &engine,
            6666,
            &source,
            &config(10, 3),
            AutoplayRun {
                campaign: campaign(1, 1),
                progress: no_progress(),
            },
            &stop,
            |_| {},
        )
        .await;

        assert_eq!(result.phase, DoomAutoplayPhase::Failed);
        assert_eq!(result.code, Some(DoomAutoplayErrorCode::EngineRequestFailed));
        assert_eq!(engine.count("/api/episode"), 1);
        assert_eq!(engine.count("/api/step"), 0);
    }

    #[tokio::test]
    async fn a_failed_advance_restart_is_a_typed_engine_failure() {
        let engine = FakeEngine::default();
        // Positioning succeeds; the level exit's advance restart fails.
        engine.queue_episode(Ok(state_at(0, false, false, 1, 1)));
        engine.queue_episode(Err(TransportError::message(
            "POST /api/episode returned HTTP 500",
        )));
        engine.queue_get(state_json(5, true, false));
        let source = FakeSource::repeating(Ok(decision(1)));
        let stop = AtomicBool::new(false);

        let result = run_autoplay_loop(
            &engine,
            6666,
            &source,
            &config(10, 3),
            AutoplayRun {
                campaign: campaign(1, 1),
                progress: no_progress(),
            },
            &stop,
            |_| {},
        )
        .await;

        assert_eq!(result.phase, DoomAutoplayPhase::Failed);
        assert_eq!(result.code, Some(DoomAutoplayErrorCode::EngineRequestFailed));
        assert_eq!(engine.count("/api/episode"), 2, "positioning + the failed advance");
        assert_eq!(engine.count("/api/step"), 0);
    }

    #[tokio::test]
    async fn a_stop_request_exits_without_positioning() {
        let engine = FakeEngine::default();
        let source = FakeSource::repeating(Ok(decision(1)));
        let stop = AtomicBool::new(true);

        let result = run_autoplay_loop(
            &engine,
            6666,
            &source,
            &config(600, 3),
            AutoplayRun {
                campaign: campaign(1, 1),
                progress: no_progress(),
            },
            &stop,
            |_| {},
        )
        .await;

        assert!(result.success);
        assert_eq!(result.phase, DoomAutoplayPhase::Idle);
        assert_eq!(engine.count("/api/state"), 0);
        assert_eq!(
            engine.count("/api/episode"),
            0,
            "a stop before start positions nothing"
        );
        assert_eq!(source.decide_calls(), 0);
    }

    #[tokio::test]
    async fn a_decision_timeout_takes_the_bounded_failure_path() {
        let engine = FakeEngine::default();
        let source = SleepingSource {
            delay: Duration::from_millis(50),
        };
        let stop = AtomicBool::new(false);
        let short_timeout = DoomAutoplayConfig {
            max_steps: 600,
            max_failures: 1,
            decision_timeout: Duration::from_millis(5),
            failure_backoff: Duration::ZERO,
        };

        let result = run_autoplay_loop(
            &engine,
            6666,
            &source,
            &short_timeout,
            AutoplayRun {
                campaign: campaign(1, 1),
                progress: no_progress(),
            },
            &stop,
            |_| {},
        )
        .await;

        assert_eq!(result.phase, DoomAutoplayPhase::Failed);
        assert_eq!(result.code, Some(DoomAutoplayErrorCode::DecisionFailed));
        assert!(result.error.as_deref().unwrap().contains("timed out"));
        assert_eq!(engine.count("/api/step"), 0);
    }

    #[tokio::test]
    async fn an_engine_state_failure_is_a_typed_engine_failure() {
        let engine = FakeEngine::default();
        // Make the first GET /api/state (after positioning) fail.
        engine
            .get_queue
            .lock()
            .unwrap()
            .push_back(Err(TransportError::message(
                "GET /api/state returned HTTP 500",
            )));
        let source = FakeSource::repeating(Ok(decision(1)));
        let stop = AtomicBool::new(false);

        let result = run_autoplay_loop(
            &engine,
            6666,
            &source,
            &config(10, 3),
            AutoplayRun {
                campaign: campaign(1, 1),
                progress: no_progress(),
            },
            &stop,
            |_| {},
        )
        .await;

        assert_eq!(result.phase, DoomAutoplayPhase::Failed);
        assert_eq!(result.code, Some(DoomAutoplayErrorCode::EngineRequestFailed));
        assert_eq!(engine.count("/api/step"), 0);
    }
}
