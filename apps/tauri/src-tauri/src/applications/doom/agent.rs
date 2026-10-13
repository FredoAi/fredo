//! Doom autoplay control loop (Spec #2969, ST-3; native transport Spec #3023 ST-3).
//!
//! The continuous-state owner (G-123): the read → decide → validate → step loop
//! that drives the **native in-process engine** on its own, reacts to a terminal
//! observation with exactly ONE bounded native `reset` within the next iteration,
//! and fails safe on an unusable decision within a consecutive-failure budget. It
//! performs NO model call (the [`DoomDecisionSource`] is injected), NO UI, and NO
//! Tauri command — ST-5 owns the command surface and the event.
//!
//! ## Loop shape (R-1)
//!
//! ```text
//! read_state ─▶ decide(observation) ─▶ validate {tics, actions}
//!            ─▶ step {tics, actions} ─▶ post-step observation
//!            ─▶ repeat
//! ```
//!
//! Every engine operation is a native adapter call ([`DoomEngineState::read_state`]
//! / [`DoomEngineState::step`] / [`DoomEngineState::reset`]) run through
//! [`tauri::async_runtime::spawn_blocking`] via the [`DoomAutoplayEngine`] seam —
//! there is no HTTP bridge, no port, and no child process (Spec #3023).
//!
//! ## Bounded, never-hang (G-263 / R-4 / R-5)
//!
//! * every engine operation runs on the blocking pool ([`run_blocking`]) — the
//!   native adapter owns no thread, no process, and no socket;
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
//! per-step engine cost (median [`DOOM_AGENT_ENGINE_STEP_RTT_MEDIAN_MS`]) — never a
//! guessed round number and never an idle-frame rate (G-316). See
//! `spikes/2969-doom-agent/action-vocabulary.md` §5.
//!
//! ## Progress observable (ST-1 finding)
//!
//! [`is_progress`] encodes the composite observable: `tic` strictly increases AND
//! at least one of `level.kills` / `level.items` / `player.{x,y}` improves.
//! `exit.distance` is fair-play gated (absent until the exit wall is mapped) and is
//! therefore OPTIONAL — never required.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::infrastructure::companion::doom_decision::{
    DoomDecision, DoomDecisionError, DoomDecisionSource, DoomDecisionTrace, DoomPlan, DoomPlanStep,
    DOOM_PLAN_SCHEMA_NAME,
};
use crate::infrastructure::storage::boot_config::DATA_DIR_ENV;

use super::actions::{
    DOOM_ACTION_BACKWARD, DOOM_ACTION_FORWARD, DOOM_ACTION_SHOOT, DOOM_ACTION_STRAFE_LEFT,
    DOOM_ACTION_STRAFE_RIGHT, DOOM_ACTION_TURN_TO, DOOM_ACTION_USE, DOOM_STEP_TICS_MAX,
    DOOM_STEP_TICS_MIN,
};
use super::autoplay::{
    DoomAutoplayErrorCode, DoomAutoplayPhase, DoomAutoplayResult, DoomAutoplayStatus,
    DOOM_AUTOPLAY_DECISION_TIMEOUT_S, DOOM_AUTOPLAY_FAILURE_BACKOFF_MS, DOOM_AUTOPLAY_MAX_FAILURES,
    DOOM_AUTOPLAY_MAX_STEPS,
};
use super::clock::{
    DoomTickClock, DOOM_CONTINUOUS_MAX_TICKS, DOOM_CONTINUOUS_TICS_PER_TICK,
    DOOM_CONTINUOUS_TICK_PERIOD_MS, DOOM_DEGRADED_AFTER_FAILURES, DOOM_DEGRADED_TICK_PERIOD_MS,
    DOOM_STATUS_EMIT_MS,
};
use super::dataset::{
    dataset_dir_from, dataset_enabled_from_env, decision_id_for, episode_id_for,
    plan_steps_to_values, DoomDatasetConfig, DoomDatasetDecision, DoomDatasetDecisionError,
    DoomDatasetExecution, DoomDatasetExecutionStep, DoomDatasetLevel, DoomDatasetLevelResult,
    DoomDatasetModel, DoomDatasetRecord, DoomDatasetReplan, DoomDatasetReward, DoomDatasetTerminal,
    DoomDatasetWriter, DOOM_DATASET_DIR_ENV, DOOM_DATASET_SCHEMA_VERSION,
};
use super::engine::{DoomEngineError, DoomEngineErrorCode, DoomEngineState};
use super::plan::{
    observation_has_front_enemy, PlanAction, PlanExecutor, ReplanCounters,
};
use super::progress::DoomProgressWriter;
use super::save::DoomCampaign;

// ── Measured rate basis (R-5 / AC5) ──────────────────────────────────────────

/// ST-1's live-measured per-step engine cost in milliseconds (N=25 against the
/// staged engine).
///
/// Source: `spikes/2969-doom-agent/action-vocabulary.md` §5. This is the measured
/// engine cost the recorded rate target is derived from — never guessed (G-316).
pub const DOOM_AGENT_ENGINE_STEP_RTT_MEDIAN_MS: f64 = 12.37;

/// The engine-only step ceiling (steps/s) implied by the measured median cost:
/// `1000 / 12.37 ≈ 80.8` → `80`.
pub const DOOM_AGENT_ENGINE_STEP_CEILING_STEPS_PER_S: u32 = 80;

/// The recorded **sustained decision-rate target** (steps/s) for the autoplay loop.
///
/// DERIVED from ST-1's measured per-step cost, not guessed and not an idle-frame
/// rate (G-316): each loop iteration performs TWO engine operations — one state
/// read and one step — each anchored to the measured median
/// [`DOOM_AGENT_ENGINE_STEP_RTT_MEDIAN_MS`], so the sustained target is
/// `1000 / (2 × 12.37) ≈ 40` steps/s (half the engine-only ceiling
/// [`DOOM_AGENT_ENGINE_STEP_CEILING_STEPS_PER_S`]).
pub const DOOM_AUTOPLAY_RATE_TARGET_STEPS_PER_S: u32 = 40;

// ── Safety-reflex constants (Spec #3026 R-3 / lever B) ───────────────────────

/// Consecutive ticks `forward` may be commanded without the player moving before
/// the reflex drops it and issues the bounded step-back (R-3a).
pub const DOOM_REFLEX_BLOCKED_TICKS: u32 = 4;

/// The bounded step-back length (held tics) the reflex issues when it drops a
/// wall-running `forward` (R-3a).
pub const DOOM_REFLEX_STEP_BACK_TICKS: i64 = 2;

// ── Unstick / escape + local-locomotion policy (Spec #3031 ST-3) ─────────────

/// K — consecutive no-move ticks before the escape maneuver fires (R-1 / AC1).
pub const DOOM_ESCAPE_STUCK_TICKS: u32 = 12;

/// Consecutive escapes with no net movement before the heading is re-routed to a
/// different (less-blocked) direction (R-1).
pub const DOOM_ESCAPE_REROUTE_AFTER: u32 = 2;

/// Ticks one escape intent overrides the model intent (bounds one escape) (R-1).
pub const DOOM_ESCAPE_WINDOW_TICKS: u32 = 24;

/// Bounded forward burst an escape maneuver issues, in tics (R-1).
pub const DOOM_ESCAPE_FORWARD_AMOUNT: i64 = 16;

/// Bounded local-locomotion hold injected when the effective intent has no
/// movement action (R-2 / R-3) — the "act between slow decisions" guarantee. The
/// issued-locomotion gap is at most ONE tick.
pub const DOOM_LOCAL_FORWARD_AMOUNT: i64 = 10;

/// Tick cadence of the local `use` press when a near door is in front (R-5
/// explore aids level completion).
pub const DOOM_LOCAL_DOOR_USE_TICKS: u32 = 30;

/// Near range (map units) at which a front door earns the local `use` press —
/// mirrors the perception near range (`DOOM_PERCEPTION_NEAR_RANGE = 64`).
pub const DOOM_LOCAL_DOOR_NEAR_RANGE: i64 = 64;

// ── Stop-on-exit: the test-only seam (Spec #3039 ST-4b) ──────────────────────

/// The `FREDO_DOOM_AGENT_STOP_ON_EXIT` test-only seam (G-275/G-300). When set to
/// `1`, [`run_continuous_loop`] terminates STABLY at the FIRST non-final level
/// exit ([`TerminalKind::Exit`]) instead of advancing the campaign — the
/// deterministic AC5 completion surface. Inert when unset, so the shipped
/// advance path is byte-identical.
pub const DOOM_AGENT_STOP_ON_EXIT_ENV: &str = "FREDO_DOOM_AGENT_STOP_ON_EXIT";

/// The `FREDO_DOOM_AGENT_STOP_ON_EXIT` lever: `true` iff set to `"1"` (mirrors
/// [`super::engine::force_exit_requested`]).
pub fn stop_on_level_exit_requested() -> bool {
    stop_on_level_exit_from(std::env::var(DOOM_AGENT_STOP_ON_EXIT_ENV).ok().as_deref())
}

/// Pure parser for the stop-on-exit lever (unit-testable without env mutation).
/// Only the exact trimmed `"1"` enables it; unset/blank/anything else is inert.
pub fn stop_on_level_exit_from(value: Option<&str>) -> bool {
    matches!(value.map(str::trim), Some("1"))
}

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
    /// including the initial resume positioning) allowed by the LEGACY
    /// decision-gated loop.
    pub max_steps: u32,
    /// Total engine-advancing TICKS allowed by the continuous loop
    /// ([`run_continuous_loop`]) — bounds every exit path (R-4/G-263). The
    /// `FREDO_DOOM_AGENT_MAX_STEPS` env seam maps onto this (compat, see
    /// [`DoomAutoplayConfig::from_env`]).
    pub max_ticks: u32,
    /// Consecutive unusable decisions allowed before the run fails.
    pub max_failures: u32,
    /// Bound on a single decision.
    pub decision_timeout: Duration,
    /// Backoff between a failed decision and its retry.
    pub failure_backoff: Duration,
    /// The nominal continuous tick period (R-1).
    pub tick_period: Duration,
    /// The degraded continuous tick period (R-4) — the fallback cadence used
    /// while the decision source is unavailable or slower than the tick loop.
    pub degraded_tick_period: Duration,
    /// Test-only (Spec #3039 ST-4b): when `true`, [`run_continuous_loop`]
    /// terminates STABLY at the first non-final level exit instead of advancing
    /// the campaign — the deterministic AC5 completion surface. Defaults to
    /// `false` (unset/inert), so the shipped advance path is byte-identical.
    pub stop_on_level_exit: bool,
}

impl Default for DoomAutoplayConfig {
    fn default() -> Self {
        Self {
            max_steps: DOOM_AUTOPLAY_MAX_STEPS,
            max_ticks: DOOM_CONTINUOUS_MAX_TICKS,
            max_failures: DOOM_AUTOPLAY_MAX_FAILURES,
            decision_timeout: Duration::from_secs(DOOM_AUTOPLAY_DECISION_TIMEOUT_S),
            failure_backoff: Duration::from_millis(DOOM_AUTOPLAY_FAILURE_BACKOFF_MS),
            tick_period: Duration::from_millis(DOOM_CONTINUOUS_TICK_PERIOD_MS),
            degraded_tick_period: Duration::from_millis(DOOM_DEGRADED_TICK_PERIOD_MS),
            stop_on_level_exit: false,
        }
    }
}

impl DoomAutoplayConfig {
    /// The binding default with the `FREDO_DOOM_AGENT_*` env seams applied
    /// (inert when unset, so the cloud/production default is unchanged).
    ///
    /// The legacy `FREDO_DOOM_AGENT_MAX_STEPS` seam maps onto `max_ticks` (the
    /// continuous tick budget) — one seam, kept for compatibility (Spec #3026).
    /// The `FREDO_DOOM_AGENT_STOP_ON_EXIT` test-only seam (Spec #3039 ST-4b) is
    /// inert when unset.
    pub fn from_env() -> Self {
        let mut config = Self::default();
        if let Some(max_ticks) = super::decision::max_steps_from_env() {
            config.max_ticks = max_ticks;
        }
        if let Some(max_failures) = super::decision::max_failures_from_env() {
            config.max_failures = max_failures;
        }
        config.stop_on_level_exit = stop_on_level_exit_requested();
        config
    }
}

// ── Native engine seam ────────────────────────────────────────────────────────

/// The native engine operations the autoplay loop drives.
///
/// A thin async seam over the in-process adapter ([`DoomEngineState`]) so the
/// loop stays unit-testable with a deterministic fake — the direct successor of
/// the retired `DoomHttpTransport` seam. Production uses [`DoomEngineState`]:
/// there is no HTTP bridge, no port, and no child process (Spec #3023).
#[async_trait]
pub trait DoomAutoplayEngine: Send + Sync {
    /// Read the current observation (the Spec #3023 parity surface).
    async fn read_state(&self) -> Result<Value, DoomEngineError>;
    /// Advance the engine by `tics` with `actions` held, answering the post-step
    /// observation.
    async fn step(&self, tics: i64, actions: &Value) -> Result<Value, DoomEngineError>;
    /// Re-position at `(episode, map, skill)` (resume / advance / death restart).
    async fn reset(&self, episode: i64, map: i64, skill: i64) -> Result<Value, DoomEngineError>;
}

/// Run one synchronous, CPU-bound native engine call on the blocking pool.
///
/// [`DoomEngineState`] is `Arc`-backed and cloneable, so the handle moves into the
/// blocking task without holding the session lock across an `.await`. A task panic
/// maps to a typed [`DoomEngineErrorCode::EngineStartFailed`] instead of wedging
/// the loop.
async fn run_blocking<T>(
    task: impl FnOnce() -> Result<T, DoomEngineError> + Send + 'static,
) -> Result<T, DoomEngineError>
where
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .unwrap_or_else(|join_error| {
            Err(DoomEngineError::new(
                DoomEngineErrorCode::EngineStartFailed,
                format!("the Doom engine task failed: {join_error}"),
            ))
        })
}

#[async_trait]
impl DoomAutoplayEngine for DoomEngineState {
    async fn read_state(&self) -> Result<Value, DoomEngineError> {
        let engine = self.clone();
        run_blocking(move || engine.read_state()).await
    }

    async fn step(&self, tics: i64, actions: &Value) -> Result<Value, DoomEngineError> {
        let engine = self.clone();
        let actions = actions.clone();
        run_blocking(move || engine.step(tics, &actions)).await
    }

    async fn reset(&self, episode: i64, map: i64, skill: i64) -> Result<Value, DoomEngineError> {
        let engine = self.clone();
        run_blocking(move || engine.reset(episode, map, skill)).await
    }
}

// ── Pure validation + observation helpers ────────────────────────────────────

/// Validate a decision against the native `step` contract: `tics` must be within
/// [`DOOM_STEP_TICS_MIN`]..=[`DOOM_STEP_TICS_MAX`] and `actions` must be an array.
///
/// `actions` is a `Vec<Value>` in [`DoomDecision`], so array-ness is structural at
/// the contract boundary; the native adapter ignores a malformed action object.
/// The `tics` range is the loop's own responsibility — the scripted lever
/// deliberately passes an out-of-range value through unvalidated.
pub fn validate_decision(decision: &DoomDecision) -> Result<(), String> {
    if decision.tics < DOOM_STEP_TICS_MIN || decision.tics > DOOM_STEP_TICS_MAX {
        return Err(format!(
            "decision tics {} is out of range {}..={}",
            decision.tics, DOOM_STEP_TICS_MIN, DOOM_STEP_TICS_MAX
        ));
    }
    Ok(())
}

/// Validate an adopted [`DoomPlan`] (Spec #3039 ST-4).
///
/// The native plan steps (`Move`/`OpenDoor`/`Shoot`/`Wait`) are range-checked by
/// the shared [`parse_doom_plan`](crate::infrastructure::companion::doom_decision::parse_doom_plan)
/// parser; only the LEGACY `Hold` step's `tics` is deliberately passed through
/// unvalidated by the parser, so the loop validates it here — exactly as the
/// pre-ST-4 loop validated the legacy single-step reply. An out-of-range hold is
/// an unusable decision (the bounded consecutive-failure stop is retained).
pub fn validate_plan(plan: &DoomPlan) -> Result<(), String> {
    for step in &plan.steps {
        if let DoomPlanStep::Hold { tics, .. } = step {
            validate_decision(&DoomDecision {
                tics: *tics,
                actions: Vec::new(),
            })
            .map_err(|detail| format!("plan hold step: {detail}"))?;
        }
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
        escapes: 0,
        failures: 0,
        consecutive_failures: 0,
        stuck_ticks: 0,
        plans: 0,
        replans: 0,
        plan_index: 0,
        last_tic: None,
        outcome: None,
        episode: Some(campaign.episode),
        map: Some(campaign.map),
        completed: false,
        degraded: false,
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
        escapes: 0,
        failures: 0,
        consecutive_failures: 0,
        stuck_ticks: 0,
        plans: 0,
        replans: 0,
        plan_index: 0,
        last_tic: None,
        outcome: None,
        episode: Some(campaign.episode),
        map: Some(campaign.map),
        completed: true,
        degraded: false,
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
/// call fails (R-1/R-3/R-4/R-5). NEVER hangs: every wait is bounded and the
/// total engine-advancing budget is finite.
///
/// `engine` is the native in-process adapter seam ([`DoomAutoplayEngine`], backed
/// by [`DoomEngineState`] in production); every call runs on the blocking pool.
/// `observe` is called on every status transition (including the terminal one),
/// so ST-5 can mirror the status into `DoomAutoplayState` and emit
/// `doom-autoplay-changed`. The returned [`DoomAutoplayResult`] is the same
/// terminal state.
pub async fn run_autoplay_loop(
    engine: &dyn DoomAutoplayEngine,
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
    // with exactly ONE native `reset` BEFORE the first step. A failure is a typed
    // engine failure (never a hang).
    match engine
        .reset(campaign.episode, campaign.map, campaign.skill)
        .await
    {
        Ok(observation) => {
            budget_used += 1;
            apply_observation(&mut status, &observation);
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
                    match engine
                        .reset(campaign.episode, campaign.map, campaign.skill)
                        .await
                    {
                        Ok(observation) => {
                            budget_used += 1;
                            apply_observation(&mut status, &observation);
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
                    match engine
                        .reset(campaign.episode, campaign.map, campaign.skill)
                        .await
                    {
                        Ok(observation) => {
                            budget_used += 1;
                            apply_observation(&mut status, &observation);
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

        // 1. Read the whole observation (native `read_state`).
        let observation = match engine.read_state().await {
            Ok(observation) => observation,
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
            Ok(Ok(plan)) => {
                status.decisions += 1;
                // ST-3 compatibility shim: consume the plan as a single `Hold`
                // step until the ST-4 tick-by-tick executor lands. A legacy
                // `{tics, actions}` reply round-trips through a single `Hold`.
                let decision = plan.as_single_hold();
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

                // 4. Advance the world (native `step {tics, actions}`).
                let tics = decision.tics;
                let actions = Value::Array(decision.actions);
                match engine.step(tics, &actions).await {
                    Ok(observation) => {
                        status.steps += 1;
                        budget_used += 1;
                        // A good decision resets the consecutive-failure budget.
                        status.consecutive_failures = 0;
                        apply_observation(&mut status, &observation);
                        if let Some(kind) = terminal_kind(&observation) {
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

// ── Continuous loop: pure helpers (Spec #3026 ST-2) ───────────────────────────

/// The player's integer map-unit `(x, y)` from an observation, or `None` when
/// either coordinate is absent.
fn player_position(observation: &Value) -> Option<(i64, i64)> {
    let x = observation.pointer("/player/x").and_then(Value::as_i64)?;
    let y = observation.pointer("/player/y").and_then(Value::as_i64)?;
    Some((x, y))
}

/// Whether an action array commands `forward`.
fn intent_has_forward(intent: &[Value]) -> bool {
    intent
        .iter()
        .any(|action| action.get("type").and_then(Value::as_str) == Some(DOOM_ACTION_FORWARD))
}

/// Whether the observation's `enemies` list reports at least one `front` target.
/// Delegates to the single shared predicate in [`super::plan`] (Spec #3039 ST-4).
fn has_front_enemy(observation: &Value) -> bool {
    observation_has_front_enemy(observation)
}

/// The safety reflex (Spec #3026 R-3, lever B): given the current observation,
/// the persisted intent, and the running count of consecutive blocked-forward
/// ticks, return the possibly-overridden action array.
///
/// Pure — no I/O, no clock, no state. Two overrides:
/// * (a) `forward` commanded while the player has not moved for
///   [`DOOM_REFLEX_BLOCKED_TICKS`] consecutive ticks → drop `forward` and issue a
///   bounded [`DOOM_ACTION_BACKWARD`] step-back of [`DOOM_REFLEX_STEP_BACK_TICKS`];
/// * (b) `shoot` commanded while `enemies` reports no `front` target → drop
///   `shoot`.
pub fn safety_reflex(
    observation: &Value,
    intent: &[Value],
    blocked_forward_ticks: u32,
) -> Vec<Value> {
    let blocked = blocked_forward_ticks >= DOOM_REFLEX_BLOCKED_TICKS;
    let release_fire = !has_front_enemy(observation);
    let mut out: Vec<Value> = Vec::with_capacity(intent.len() + 1);
    for action in intent {
        let kind = action.get("type").and_then(Value::as_str);
        if blocked && kind == Some(DOOM_ACTION_FORWARD) {
            continue;
        }
        if release_fire && kind == Some(DOOM_ACTION_SHOOT) {
            continue;
        }
        out.push(action.clone());
    }
    if blocked && intent_has_forward(intent) {
        // (a) bounded un-stick nudge, replacing the dropped forward.
        out.push(json!({
            "type": DOOM_ACTION_BACKWARD,
            "amount": DOOM_REFLEX_STEP_BACK_TICKS,
        }));
    }
    out
}

// ── Unstick / escape + local-locomotion policy (Spec #3031 ST-3) ─────────────

/// The mutable per-run state of the unstick/escape + local-locomotion policy.
///
/// Pure data: the policy has no RNG and reads no clock. [`effective_intent`]
/// reads it and updates it exactly once per tick.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DoomLocalPolicy {
    /// The current consecutive no-move tick streak, reset on any position change
    /// (the AC1/R-1 detector input).
    pub no_move_ticks: u32,
    /// Total escape maneuvers issued this run (mirrors `status.escapes`).
    pub escapes: u32,
    /// Ticks remaining in the active escape window (`0` = none active).
    pub escape_ticks_remaining: u32,
}

impl DoomLocalPolicy {
    /// Reset the transient detector state on a level transition (death restart /
    /// advance): the no-move streak and the escape window do NOT carry across
    /// levels. The cumulative escape count does.
    pub fn reset_detector(&mut self) {
        self.no_move_ticks = 0;
        self.escape_ticks_remaining = 0;
    }
}

/// The next consecutive no-move tick streak: reset to `0` on any move, else
/// `no_move + 1` (saturating). Pure.
pub fn next_no_move_ticks(no_move: u32, moved: bool) -> u32 {
    if moved {
        0
    } else {
        no_move.saturating_add(1)
    }
}

/// Whether an intent contains a locomotion action: `forward`, `backward`,
/// `strafe-left`, or `strafe-right` (the R-2 local-locomotion guard input).
/// `turn-*`, `shoot`, `use`, `run`, `switch-weapon`, and an empty intent are NOT
/// locomotion.
pub fn intent_has_locomotion(intent: &[Value]) -> bool {
    intent.iter().any(|action| {
        matches!(
            action.get("type").and_then(Value::as_str),
            Some(DOOM_ACTION_FORWARD)
                | Some(DOOM_ACTION_BACKWARD)
                | Some(DOOM_ACTION_STRAFE_LEFT)
                | Some(DOOM_ACTION_STRAFE_RIGHT)
        )
    })
}

/// The player's facing in integer degrees from an observation (`0` when absent).
fn observation_angle(observation: &Value) -> i64 {
    observation
        .pointer("/player/angle")
        .and_then(Value::as_i64)
        .unwrap_or(0)
}

/// The observation's `walls` array slice, empty when absent (the AC4 fallback).
fn observation_walls(observation: &Value) -> &[Value] {
    observation
        .get("walls")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

/// The escape heading in absolute map degrees (0-359) for a direction bucket and
/// the current facing.
///
/// Mapping (ST-1 measured on the real engine): `turn-to A ⇒ player.angle == A`,
/// `turn-left` = **+90° relative**, `turn-right` = **−90° relative**. Therefore:
///
/// * `front` → `angle`
/// * `left`  → `(angle + 90).rem_euclid(360)`
/// * `right` → `(angle + 270).rem_euclid(360)`
///
/// (The plan wrote `right = +90 / left = +270`; that is INVERTED and would turn
/// AWAY from the target — this is the corrected mapping.) Pure.
pub fn escape_heading(direction: &str, current_angle: i64) -> i64 {
    let delta = match direction {
        "left" => 90,
        "right" => 270,
        _ => 0,
    };
    (current_angle + delta).rem_euclid(360)
}

/// The direction bucket (`"front"` / `"left"` / `"right"`) the escape should
/// face, from the observation's `walls` and the cumulative escape count.
///
/// Groups `walls` by `direction`; per direction the clearance is the minimum
/// `distance` (an absent direction is open). The rotation
/// `["front", "left", "right"]` starts at `escapes % 3`; the first non-`blocked`
/// direction wins, else the maximum-clearance one. Once `escapes` has reached
/// [`DOOM_ESCAPE_REROUTE_AFTER`], the rotation is re-ordered by clearance so a
/// repeatedly blocked heading is abandoned for a different (less-blocked) one
/// (R-1 re-route). Pure — no RNG, no clock.
pub fn escape_direction(walls: &[Value], escapes: u32) -> &'static str {
    const ORDER: [&str; 3] = ["front", "left", "right"];
    let start = (escapes % 3) as usize;
    let rotation = [
        ORDER[start],
        ORDER[(start + 1) % 3],
        ORDER[(start + 2) % 3],
    ];
    let candidates = if escapes >= DOOM_ESCAPE_REROUTE_AFTER {
        by_clearance(walls, rotation)
    } else {
        rotation
    };

    for direction in candidates {
        if !wall_direction_blocked(walls, direction) {
            return direction;
        }
    }

    // Every candidate is blocked → the maximum-clearance (least-blocked) one.
    let mut best = candidates[0];
    let mut best_clearance = i64::MIN;
    for direction in candidates {
        let clearance = wall_direction_clearance(walls, direction).unwrap_or(i64::MAX);
        if clearance > best_clearance {
            best_clearance = clearance;
            best = direction;
        }
    }
    best
}

/// Re-order `rotation` by descending clearance (absent ⇒ open = `i64::MAX`),
/// stable, so equal-clearance directions keep their rotation order.
fn by_clearance(walls: &[Value], rotation: [&'static str; 3]) -> [&'static str; 3] {
    let mut ordered = rotation;
    for i in 1..ordered.len() {
        let mut j = i;
        while j > 0 {
            let left = wall_direction_clearance(walls, ordered[j - 1]).unwrap_or(i64::MAX);
            let right = wall_direction_clearance(walls, ordered[j]).unwrap_or(i64::MAX);
            if left < right {
                ordered.swap(j - 1, j);
                j -= 1;
            } else {
                break;
            }
        }
    }
    ordered
}

/// The minimum `distance` over the `walls` entries facing `direction`, or `None`
/// when no ray faces it (an open direction).
fn wall_direction_clearance(walls: &[Value], direction: &str) -> Option<i64> {
    walls
        .iter()
        .filter(|wall| wall.get("direction").and_then(Value::as_str) == Some(direction))
        .filter_map(|wall| wall.get("distance").and_then(Value::as_i64))
        .min()
}

/// Whether any `walls` ray facing `direction` is `blocked` (within the near
/// range).
fn wall_direction_blocked(walls: &[Value], direction: &str) -> bool {
    walls.iter().any(|wall| {
        wall.get("direction").and_then(Value::as_str) == Some(direction)
            && wall.get("blocked").and_then(Value::as_bool) == Some(true)
    })
}

/// Whether the observation reports a door in front within
/// [`DOOM_LOCAL_DOOR_NEAR_RANGE`] map units (the R-5 explore trigger). Pure.
pub fn has_front_near_door(observation: &Value) -> bool {
    observation
        .get("doors")
        .and_then(Value::as_array)
        .map(|doors| {
            doors.iter().any(|door| {
                door.get("direction").and_then(Value::as_str) == Some("front")
                    && door
                        .get("distance")
                        .and_then(Value::as_i64)
                        .is_some_and(|distance| distance <= DOOM_LOCAL_DOOR_NEAR_RANGE)
            })
        })
        .unwrap_or(false)
}

/// Whether the local `use` explore press is due this tick: a front near door and
/// the [`DOOM_LOCAL_DOOR_USE_TICKS`] cadence (`ticks % cadence == 0`). Pure.
pub fn door_use_due(observation: &Value, ticks: u32) -> bool {
    has_front_near_door(observation) && ticks.is_multiple_of(DOOM_LOCAL_DOOR_USE_TICKS)
}

/// Compose the effective per-tick intent from the retained [`safety_reflex`] and
/// the Spec #3031 unstick/escape + local-locomotion policy.
///
/// Pure: a function of the observation, the persisted intent, the counters, and
/// `ticks` — no RNG, no clock, no I/O.
///
/// 1. `base` = [`safety_reflex`] (R-3a — semantics retained, never changed here).
/// 2. **Escape / re-route (R-1 / AC1):** when the no-move streak reaches
///    [`DOOM_ESCAPE_STUCK_TICKS`] OR an escape window is active, the intent
///    becomes a `turn-to` (toward a less-blocked heading) AND a bounded
///    `forward` — a turn and a movement in the SAME action set. `escapes`
///    increments on window entry; the window is [`DOOM_ESCAPE_WINDOW_TICKS`].
/// 3. **Local-locomotion guard (R-2 / R-3):** a locomotion-free intent (empty,
///    `shoot`-only, `turn-*`-only, `use`) gets a bounded `forward` appended, so
///    the issued-locomotion gap is at most ONE tick.
/// 4. **Door explore (R-5):** a front near door earns a `use` press on the
///    [`DOOM_LOCAL_DOOR_USE_TICKS`] cadence.
pub fn effective_intent(
    observation: &Value,
    last_intent: &[Value],
    blocked_forward_ticks: u32,
    policy: &mut DoomLocalPolicy,
    ticks: u32,
) -> Vec<Value> {
    // 1. Retained safety reflex.
    let mut intent = safety_reflex(observation, last_intent, blocked_forward_ticks);

    // 2. Escape / re-route.
    let stuck = policy.no_move_ticks >= DOOM_ESCAPE_STUCK_TICKS;
    let in_window = policy.escape_ticks_remaining > 0;
    if stuck || in_window {
        if !in_window {
            policy.escapes = policy.escapes.saturating_add(1);
            policy.escape_ticks_remaining = DOOM_ESCAPE_WINDOW_TICKS;
        }
        let direction = escape_direction(observation_walls(observation), policy.escapes);
        let heading = escape_heading(direction, observation_angle(observation));
        intent = vec![
            json!({ "type": DOOM_ACTION_TURN_TO, "angle": heading }),
            json!({ "type": DOOM_ACTION_FORWARD, "amount": DOOM_ESCAPE_FORWARD_AMOUNT }),
        ];
    }
    policy.escape_ticks_remaining = policy.escape_ticks_remaining.saturating_sub(1);

    // 3. Local-locomotion guard — the act-between-decisions guarantee.
    if !intent_has_locomotion(&intent) {
        intent.push(json!({
            "type": DOOM_ACTION_FORWARD,
            "amount": DOOM_LOCAL_FORWARD_AMOUNT,
        }));
    }

    // 4. Door explore.
    if door_use_due(observation, ticks) {
        intent.push(json!({ "type": DOOM_ACTION_USE }));
    }

    intent
}

/// `ceil(duration / unit)`, at least 1 — the number of `unit`-length waits that
/// cover `duration`. A zero `unit` (an immediate deterministic clock) is 1.
fn pacing_ticks(duration: Duration, unit: Duration) -> u32 {
    if unit.is_zero() {
        return 1;
    }
    let unit_nanos = unit.as_nanos();
    let duration_nanos = duration.as_nanos();
    let mut ticks = duration_nanos / unit_nanos;
    if !duration_nanos.is_multiple_of(unit_nanos) {
        ticks += 1;
    }
    ticks.clamp(1, u128::from(u32::MAX)) as u32
}

/// Await the injected clock until `period` of pacing has elapsed, expressed as a
/// whole number of the clock's own period. This is the loop's ONLY wall-clock
/// dependency (R-5): no `Instant::now`, no bare `tokio::time::sleep`.
async fn pace(clock: &dyn DoomTickClock, period: Duration) {
    let count = pacing_ticks(period, clock.period());
    for _ in 0..count {
        clock.tick().await;
    }
}

// ── Dataset assembly (Spec #3032, ST-2) ──────────────────────────────────────

/// The embedded shareware WAD name stamped on every dataset record's
/// `level.wadId`. The engine plays the bundled `DOOM1.WAD`; the observation
/// carries no WAD id, so the name is pinned here (G-255).
pub const DOOM_DATASET_WAD_ID: &str = "DOOM1.WAD";

/// The engine tic of an observation (`0` when absent).
fn observation_tic(observation: &Value) -> u64 {
    observation.get("tic").and_then(Value::as_u64).unwrap_or(0)
}

/// An integer field of an observation at a JSON pointer, when present.
fn observation_int(observation: &Value, pointer: &str) -> Option<i64> {
    observation.pointer(pointer).and_then(Value::as_i64)
}

/// The level identity of a record, from the observation (falling back to the
/// resolved campaign coordinates).
fn dataset_level(observation: &Value, campaign: &DoomCampaign) -> DoomDatasetLevel {
    DoomDatasetLevel {
        episode: observation_int(observation, "/level/episode").unwrap_or(campaign.episode),
        map: observation_int(observation, "/level/map").unwrap_or(campaign.map),
        skill: observation_int(observation, "/level/skill").unwrap_or(campaign.skill),
        wad_id: DOOM_DATASET_WAD_ID.to_string(),
    }
}

/// The model metadata of a record: the decision trace's model identity when a
/// source reported one, else the absent-string shape (a scripted/local source).
/// `schemaVersion` is always the `doom_plan` contract name.
fn dataset_model(trace: Option<&DoomDecisionTrace>) -> DoomDatasetModel {
    DoomDatasetModel {
        id: trace.and_then(|trace| trace.model_id.clone()),
        server_flags: trace.and_then(|trace| trace.server_flags.clone()),
        prompt_version: trace.and_then(|trace| trace.prompt_version.clone()),
        schema_version: trace
            .map(|trace| trace.schema_version.to_string())
            .unwrap_or_else(|| DOOM_PLAN_SCHEMA_NAME.to_string()),
    }
}

/// The decision source of a record: the trace's source when the source reported
/// one (the model path), else the active `FREDO_DOOM_AGENT_DECISION_SOURCE`
/// selector resolved at loop start.
fn dataset_source(trace: Option<&DoomDecisionTrace>, selector: &str) -> String {
    trace
        .map(|trace| trace.source.to_string())
        .unwrap_or_else(|| selector.to_string())
}

/// The typed failure of a decision error (`decisionError.kind`).
fn dataset_decision_error(error: &DoomDecisionError) -> DoomDatasetDecisionError {
    let kind = match error {
        DoomDecisionError::Malformed(_) => "malformed",
        DoomDecisionError::ModelUnavailable(_) => "modelUnavailable",
        DoomDecisionError::TimedOut => "timedOut",
    };
    DoomDatasetDecisionError {
        kind: kind.to_string(),
        detail: error.to_string(),
    }
}

/// The shaped reward between the adoption observation and `next` — the deltas of
/// the observation's counters plus the `moved` flag. `dDistanceToExit` is `null`
/// when either side is fair-play gated (no exit info).
fn shaped_reward(baseline: &Value, next: &Value) -> DoomDatasetReward {
    let delta = |pointer: &str| {
        observation_int(next, pointer).unwrap_or(0) - observation_int(baseline, pointer).unwrap_or(0)
    };
    let d_distance_to_exit = match (
        observation_int(baseline, "/exit/distance"),
        observation_int(next, "/exit/distance"),
    ) {
        (Some(before), Some(after)) => Some(after - before),
        _ => None,
    };
    let moved = match (player_position(baseline), player_position(next)) {
        (Some(before), Some(after)) => before != after,
        _ => false,
    };
    DoomDatasetReward {
        d_kills: delta("/level/kills"),
        d_items: delta("/level/items"),
        d_secrets: delta("/level/secrets"),
        d_health: delta("/player/health"),
        d_distance_to_exit,
        moved,
    }
}

/// The engine-tic duration of a level, in milliseconds. Deterministic — derived
/// from the observation's own engine-tic counter and the pinned nominal pacing,
/// never a wall clock (NFR-5).
fn dataset_tic_ms(observation: &Value) -> u64 {
    observation_tic(observation) * DOOM_CONTINUOUS_TICK_PERIOD_MS
        / (DOOM_CONTINUOUS_TICS_PER_TICK.max(1) as u64)
}

/// The terminal level result at `observation` (`terminal.levelResult`).
fn dataset_level_result(observation: &Value, campaign: &DoomCampaign) -> DoomDatasetLevelResult {
    let level = dataset_level(observation, campaign);
    let count = |pointer: &str| observation_int(observation, pointer).unwrap_or(0).max(0) as u64;
    DoomDatasetLevelResult {
        episode: level.episode,
        map: level.map,
        outcome: observation
            .get("outcome")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string(),
        kills: count("/level/kills"),
        items: count("/level/items"),
        secrets: count("/level/secrets"),
        tic_ms: dataset_tic_ms(observation),
    }
}

/// The `runId` of a run: a compact, process-local-stable stamp every record
/// correlates with. The ONE clock read for run identity (shared with the record
/// `ts`); no RNG.
fn dataset_run_id() -> String {
    format!(
        "{:016x}",
        chrono::Utc::now().timestamp_micros().unsigned_abs()
    )
}

/// Resolve the dataset directory from the env seams (G-275): the
/// [`DOOM_DATASET_DIR_ENV`] override wins, else `<FREDO_DATA_DIR>/doom-dataset`.
/// `None` when neither is set — the loop then captures nothing and never guesses
/// a directory (R-5).
fn dataset_dir_from_env() -> Option<PathBuf> {
    if let Some(dir) = std::env::var(DOOM_DATASET_DIR_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        return Some(PathBuf::from(dir));
    }
    let data_dir = std::env::var(DATA_DIR_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())?;
    Some(dataset_dir_from(Path::new(&data_dir), None))
}

/// A partially-assembled per-decision record (the in-flight window).
#[derive(Clone, Debug)]
struct OpenRecord {
    /// The RFC3339 adoption timestamp.
    ts: String,
    /// The correlation id (`<runId>:<n>`, monotonic per run).
    decision_id: String,
    /// The decision source (`model|scripted|local`).
    source: String,
    /// The level identity.
    level: DoomDatasetLevel,
    /// The model metadata.
    model: DoomDatasetModel,
    /// The observation at adoption.
    observation: Value,
    /// The adopted plan (`null` for a failed attempt).
    decision: Option<DoomDatasetDecision>,
    /// The gated raw reply (present only when the source captured it).
    model_raw: Option<String>,
    /// The gated reasoning text (present only when the source captured it).
    reasoning: Option<String>,
    /// The typed failure (present only for a failed attempt).
    decision_error: Option<DoomDatasetDecisionError>,
    /// The loop-stamped latency, in ms.
    latency_ms: u64,
    /// The engine tic at adoption.
    tic: u64,
    /// The executor cursor at adoption.
    step_index: u32,
    /// The planned step count.
    planned_steps: u32,
    /// The executed steps (one entry per plan step, coalesced across its ticks).
    steps: Vec<DoomDatasetExecutionStep>,
    /// The re-plan events (the #3039 five-reason vocabulary).
    replans: Vec<DoomDatasetReplan>,
    /// The last `(index, controller)` coalesced into `steps`.
    last_step: Option<(u32, String)>,
    /// The latest observation (the record's `nextState`).
    next_state: Value,
}

impl OpenRecord {
    /// Coalesce one executed tick into `steps`: a same-step tick increments its
    /// `tics`; a new step (index or controller) starts a fresh entry holding this
    /// tick's issued actions. Only plan steps are recorded here — the no-plan
    /// fallback is attached separately (R-6).
    fn record_tick(&mut self, index: u32, controller: &str, actions: &[Value]) {
        let key = (index, controller.to_string());
        if self.last_step.as_ref() == Some(&key) {
            if let Some(step) = self.steps.last_mut() {
                step.tics = step.tics.saturating_add(1);
            }
            return;
        }
        self.steps.push(DoomDatasetExecutionStep {
            index,
            controller: controller.to_string(),
            actions: actions.to_vec(),
            tics: 1,
        });
        self.last_step = Some(key);
    }

    /// Build the final published record.
    fn finish(self, run_id: &str, terminal: Option<DoomDatasetTerminal>) -> DoomDatasetRecord {
        let reward = shaped_reward(&self.observation, &self.next_state);
        DoomDatasetRecord {
            v: DOOM_DATASET_SCHEMA_VERSION,
            run_id: run_id.to_string(),
            episode_id: episode_id_for(run_id, self.level.episode, self.level.map),
            decision_id: self.decision_id,
            ts: self.ts,
            tic: self.tic,
            step_index: self.step_index,
            source: self.source,
            level: self.level,
            model: self.model,
            observation: self.observation,
            decision: self.decision,
            model_raw: self.model_raw,
            reasoning: self.reasoning,
            latency_ms: self.latency_ms,
            decision_error: self.decision_error,
            execution: DoomDatasetExecution {
                adopted_tic: self.tic,
                exhausted_tic: observation_tic(&self.next_state),
                planned_steps: self.planned_steps,
                executed_steps: self.steps.len() as u32,
                steps: self.steps,
                replans: self.replans,
            },
            next_state: self.next_state,
            reward,
            terminal,
        }
    }
}

/// The loop-side dataset assembler (Spec #3032 ST-2).
///
/// Accumulates ONE correlated record per decision attempt inside
/// [`run_continuous_loop`] and appends it through ST-1's [`DoomDatasetWriter`] —
/// ONLY when capture is enabled (R-5). Disabled (the default) ⇒ no writer ⇒ no
/// directory, no file, no record; the loop's control behaviour is unchanged.
///
/// The writer is resolved once per run from the opt-in seams
/// ([`DOOM_DATASET_ENABLED_ENV`](super::dataset::DOOM_DATASET_ENABLED_ENV) +
/// [`DOOM_DATASET_DIR_ENV`] / `FREDO_DATA_DIR`) — one writer per run, best-effort
/// (a write failure is logged, never fatal). The record's `runId`/`ts` are the
/// ONE clock read; assembly otherwise reads no RNG and no hidden clock.
struct DoomDatasetAssembler {
    run_id: String,
    writer: Option<Arc<DoomDatasetWriter>>,
    /// The `FREDO_DOOM_AGENT_DECISION_SOURCE` selector resolved at loop start —
    /// the fallback `source` when a decision carried no trace.
    source: String,
    next_decision: u64,
    /// The record of the plan currently executing.
    active: Option<OpenRecord>,
    /// The record of a resolved-but-not-yet-adopted (prefetched) plan.
    prefetch: Option<OpenRecord>,
    /// A failed attempt's record, awaiting its applied-fallback step.
    failed: Option<OpenRecord>,
}

impl DoomDatasetAssembler {
    /// Build an assembler over an explicit writer (tests, or a caller that
    /// resolved the writer itself).
    fn new(writer: Option<Arc<DoomDatasetWriter>>, run_id: String, source: String) -> Self {
        Self {
            run_id,
            writer,
            source,
            next_decision: 0,
            active: None,
            prefetch: None,
            failed: None,
        }
    }

    /// Resolve the assembler from the process environment: no writer (and no id
    /// generated) unless capture is enabled AND a directory is resolvable.
    fn from_env() -> Self {
        let selector = super::decision::decision_source_from_env();
        let dir = if dataset_enabled_from_env() {
            dataset_dir_from_env()
        } else {
            None
        };
        match dir {
            Some(dir) => {
                let writer = Arc::new(DoomDatasetWriter::new(DoomDatasetConfig::from_env(dir)));
                Self::new(Some(writer), dataset_run_id(), selector)
            }
            None => Self::new(None, String::new(), selector),
        }
    }

    /// Whether capture is enabled (a writer is present).
    fn is_enabled(&self) -> bool {
        self.writer.is_some()
    }

    /// Append one finished record. Best-effort: a failure is logged, never fatal.
    fn append(&self, record: DoomDatasetRecord) {
        if let Some(writer) = &self.writer {
            if let Err(error) = writer.append(&record) {
                tracing::warn!(
                    target: "fredo::doom",
                    error = %error,
                    "could not append a Doom dataset record"
                );
            }
        }
    }

    /// Open a record for a resolved (and validated) plan. `deferred` is `true`
    /// when the plan is prefetched (a plan is already executing) — the record is
    /// then held until the plan is adopted; otherwise it supersedes the active
    /// record and becomes it.
    fn open_plan(
        &mut self,
        plan: &DoomPlan,
        observation: &Value,
        trace: Option<&DoomDecisionTrace>,
        latency_ms: u64,
        campaign: &DoomCampaign,
        deferred: bool,
    ) {
        if !self.is_enabled() {
            return;
        }
        self.next_decision += 1;
        let record = self.open_record(
            Some(plan),
            observation,
            trace,
            latency_ms,
            campaign,
            None,
        );
        if deferred {
            if let Some(previous) = self.prefetch.take() {
                self.append(previous.finish(&self.run_id, None));
            }
            self.prefetch = Some(record);
        } else {
            self.close_active(observation, None);
            self.active = Some(record);
        }
    }

    /// Open a failed attempt's record (R-6): `decision` is `null` and the typed
    /// error is carried; the applied fallback is attached by [`Self::set_fallback`]
    /// and the record is closed by [`Self::after_step`].
    fn record_failure(
        &mut self,
        error: &DoomDecisionError,
        observation: &Value,
        trace: Option<&DoomDecisionTrace>,
        latency_ms: u64,
        campaign: &DoomCampaign,
    ) {
        if !self.is_enabled() {
            return;
        }
        self.next_decision += 1;
        self.failed = Some(self.open_record(
            None,
            observation,
            trace,
            latency_ms,
            campaign,
            Some(dataset_decision_error(error)),
        ));
    }

    /// Build an [`OpenRecord`] for `plan` (or a failed attempt when `plan` is
    /// `None`).
    fn open_record(
        &self,
        plan: Option<&DoomPlan>,
        observation: &Value,
        trace: Option<&DoomDecisionTrace>,
        latency_ms: u64,
        campaign: &DoomCampaign,
        decision_error: Option<DoomDatasetDecisionError>,
    ) -> OpenRecord {
        OpenRecord {
            ts: chrono::Utc::now().to_rfc3339(),
            decision_id: decision_id_for(&self.run_id, self.next_decision),
            source: dataset_source(trace, &self.source),
            level: dataset_level(observation, campaign),
            model: dataset_model(trace),
            observation: observation.clone(),
            decision: plan.map(|plan| DoomDatasetDecision {
                plan: plan_steps_to_values(plan),
            }),
            model_raw: trace.and_then(|trace| trace.raw_reply.clone()),
            reasoning: trace.and_then(|trace| trace.reasoning.clone()),
            decision_error,
            latency_ms: trace
                .and_then(|trace| trace.latency_ms)
                .unwrap_or(latency_ms),
            tic: observation_tic(observation),
            step_index: 0,
            planned_steps: plan.map_or(0, |plan| plan.steps.len() as u32),
            steps: Vec::new(),
            replans: Vec::new(),
            last_step: None,
            next_state: observation.clone(),
        }
    }

    /// Promote the prefetched plan's record to active (the plan was adopted). The
    /// superseded active record is closed with no terminal.
    fn adopt_prefetch(&mut self, observation: &Value) {
        let Some(next) = self.prefetch.take() else {
            return;
        };
        self.close_active(observation, None);
        self.active = Some(next);
    }

    /// Record one executed plan-step tick on the active record.
    fn record_tick(&mut self, index: u32, controller: &str, actions: &[Value]) {
        if let Some(active) = self.active.as_mut() {
            active.record_tick(index, controller, actions);
        }
    }

    /// Record one re-plan event on the active record (the #3039 reason
    /// vocabulary: `blocked|noProgress|frontEnemy|doorClosed|exhausted`).
    fn record_replan(&mut self, index: u32, reason: &str, tic: u64) {
        if let Some(active) = self.active.as_mut() {
            active.replans.push(DoomDatasetReplan {
                index,
                reason: reason.to_string(),
                tic,
            });
        }
    }

    /// Attach the fallback action(s) actually issued after the failed attempt
    /// (`controller` ∈ `reflex|fallback`).
    fn set_fallback(&mut self, controller: &str, actions: &[Value]) {
        if let Some(failed) = self.failed.as_mut() {
            if failed.steps.is_empty() {
                failed.record_tick(0, controller, actions);
            }
        }
    }

    /// Close the in-flight record after an engine tick: a failed attempt (if any)
    /// is published with the post-step state; otherwise the active record's
    /// `nextState` is refreshed.
    fn after_step(&mut self, observation: &Value) {
        if let Some(mut failed) = self.failed.take() {
            failed.next_state = observation.clone();
            self.append(failed.finish(&self.run_id, None));
            return;
        }
        if let Some(active) = self.active.as_mut() {
            active.next_state = observation.clone();
        }
    }

    /// Stamp a terminal onto the open record(s) at run end / a level-terminal
    /// observation (AC2): the active (in-flight) record carries
    /// `terminal{kind,levelResult}`; the never-executed prefetched record and any
    /// unauthorised failed record close plain. Idempotent — after it, a fresh
    /// decision opens a fresh record (a death restart / campaign advance).
    fn finalize(&mut self, kind: &str, observation: &Value, campaign: &DoomCampaign) {
        if !self.is_enabled() {
            return;
        }
        let terminal = DoomDatasetTerminal {
            kind: kind.to_string(),
            level_result: dataset_level_result(observation, campaign),
        };
        self.close_active(observation, Some(terminal));
        if let Some(prefetch) = self.prefetch.take() {
            self.append(prefetch.finish(&self.run_id, None));
        }
        if let Some(mut failed) = self.failed.take() {
            failed.next_state = observation.clone();
            self.append(failed.finish(&self.run_id, None));
        }
    }

    /// Close and publish the active record with `next_state = observation`.
    fn close_active(&mut self, observation: &Value, terminal: Option<DoomDatasetTerminal>) {
        if let Some(mut active) = self.active.take() {
            active.next_state = observation.clone();
            self.append(active.finish(&self.run_id, terminal));
        }
    }
}

/// The non-blocking pending-decision future the continuous loop polls once per
/// tick. It OWNS a clone of the observation, so it is self-contained apart from
/// the borrowed decision source.
type PendingDecision<'s> =
    Pin<Box<dyn Future<Output = Result<DoomPlan, DoomDecisionError>> + Send + 's>>;

/// Run the continuous autoplay loop (Spec #3026 ST-2) until the tick budget is
/// exhausted, a stop is requested, a terminal campaign completes, or an engine
/// call fails (R-1/R-3/R-4). NEVER hangs and NEVER freezes while a decision is in
/// flight: the loop advances one tick every `clock` period regardless of the
/// decision source, polling the in-flight decision once per tick through a noop
/// waker (no thread, no timer, no wall clock — R-5).
///
/// The persisted last intent is reissued between decisions, guarded by
/// [`safety_reflex`] and the Spec #3031 unstick/escape + local-locomotion policy
/// ([`effective_intent`]) — so the loop keeps acting between slow decisions and
/// escapes an obstacle it cannot walk through. An unavailable or timed-out
/// decision degrades the pacing (R-4) but never stops the run; a malformed
/// decision retains the bounded consecutive-failure stop. `observe` is invoked on
/// the seeded/terminal transitions and throttled to ~[`DOOM_STATUS_EMIT_MS`]
/// elsewhere.
pub async fn run_continuous_loop(
    engine: &dyn DoomAutoplayEngine,
    source: &dyn DoomDecisionSource,
    config: &DoomAutoplayConfig,
    clock: &dyn DoomTickClock,
    run: AutoplayRun,
    stop: &AtomicBool,
    mut observe: impl FnMut(&DoomAutoplayStatus) + Send,
) -> DoomAutoplayResult {
    let AutoplayRun { campaign, progress } = run;

    // Completed-save terminality (G-321, BINDING): a resolved `completed:true`
    // campaign is terminal AT START — report completion immediately, issue NO
    // engine request.
    if campaign.completed {
        let status = completed_status(&campaign);
        observe(&status);
        return campaign_complete_result(status.steps);
    }

    let mut status = running_status(&campaign);
    observe(&status);

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

    // Pacing / emission / timeout thresholds derived ONCE from the injected
    // clock's declared period — never from the wall clock (R-5).
    let unit = clock.period();
    let emit_interval = pacing_ticks(Duration::from_millis(DOOM_STATUS_EMIT_MS), unit);
    let timeout_ticks = pacing_ticks(config.decision_timeout, unit);
    let backoff_ticks = pacing_ticks(config.failure_backoff, unit);

    // The loop-side dataset assembler (Spec #3032 ST-2): ONE correlated record
    // per decision attempt, appended through ST-1's bounded writer — but ONLY
    // when capture is enabled (R-5). Disabled ⇒ no writer ⇒ no file, and the
    // loop's control behaviour is byte-identical.
    let mut dataset = DoomDatasetAssembler::from_env();

    let mut campaign = campaign;
    let mut budget_used: u32 = 0;
    let mut pending_terminal: Option<TerminalKind> = None;

    // The persisted last intent (R-3) plus the blocked-forward window.
    let mut last_intent: Vec<Value> = Vec::new();
    let mut previous_position: Option<(i64, i64)> = None;
    let mut blocked_forward_ticks: u32 = 0;
    // The unstick/escape + local-locomotion policy state (Spec #3031 ST-3).
    let mut policy = DoomLocalPolicy::default();

    // The Plan Executor (Spec #3039 ST-4): runs the adopted plan one step per
    // tick and requests a re-plan on divergence (AC2/AC3/AC4). The retained
    // reflex + escape/local-locomotion policy above is its FALLBACK when no plan
    // step is active.
    let mut executor = PlanExecutor::new();
    // A resolved plan prefetched while the current one still executes — adopted
    // on exhaustion/divergence without interrupting the in-flight step (AC2:
    // one model call amortized across many ticks).
    let mut next_plan: Option<DoomPlan> = None;

    // The non-blocking pending decision and its pacing bookkeeping.
    let mut pending: Option<PendingDecision<'_>> = None;
    let mut pending_ticks: u32 = 0;
    let mut cooldown_ticks: u32 = 0;
    let mut degraded_consecutive: u32 = 0;
    // The last degraded value the caller observed — a degrade/recover transition
    // is always emitted regardless of the throttle (R-4 observability).
    let mut observed_degraded = false;

    // R-1 resume positioning: exactly ONE native `reset` before the first tick.
    let mut observation = match engine
        .reset(campaign.episode, campaign.map, campaign.skill)
        .await
    {
        Ok(observation) => {
            budget_used += 1;
            apply_observation(&mut status, &observation);
            observe(&status);
            observation
        }
        Err(error) => {
            let result = engine_failure(&mut status, error.message);
            observe(&status);
            return result;
        }
    };
    if let Some(kind) = terminal_kind(&observation) {
        pending_terminal = Some(kind);
    }

    while budget_used < config.max_ticks {
        if stop.load(Ordering::Relaxed) {
            dataset.finalize("aborted", &observation, &campaign);
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

        // React to a terminal observation with exactly ONE bounded action (R-3).
        if let Some(kind) = pending_terminal.take() {
            // AC2: stamp the terminal `levelResult` onto the run's in-flight
            // dataset record at the terminal observation. The run then either
            // restarts the level on a death or advances/completes on an exit.
            let terminal_kind = match kind {
                TerminalKind::Death => "dead",
                TerminalKind::Exit => "exited",
            };
            dataset.finalize(terminal_kind, &observation, &campaign);
            match kind {
                TerminalKind::Death => {
                    match engine
                        .reset(campaign.episode, campaign.map, campaign.skill)
                        .await
                    {
                        Ok(next) => {
                            budget_used += 1;
                            apply_observation(&mut status, &next);
                            observation = next;
                            previous_position = None;
                            blocked_forward_ticks = 0;
                            policy.reset_detector();
                            last_intent.clear();
                            executor.reset_positioning();
                            next_plan = None;
                            observe(&status);
                            continue;
                        }
                        Err(error) => {
                            dataset.finalize("aborted", &observation, &campaign);
                            let result = engine_failure(&mut status, error.message);
                            observe(&status);
                            return result;
                        }
                    }
                }
                TerminalKind::Exit => {
                    // Test-only stop-on-exit (Spec #3039 ST-4b): when enabled,
                    // terminate STABLY at the FIRST non-final level exit instead
                    // of advancing the campaign — the observation's single-level
                    // `outcome == "exited"` is carried on the terminal status.
                    // Inert when the config is `false` (the shipped default), so
                    // the advance path below is byte-identical.
                    if config.stop_on_level_exit && !campaign.at_final_level() {
                        status.phase = DoomAutoplayPhase::Completed;
                        status.running = false;
                        status.outcome = Some("exited".to_string());
                        status.code = Some(DoomAutoplayErrorCode::CampaignComplete);
                        status.episode = Some(campaign.episode);
                        status.map = Some(campaign.map);
                        observe(&status);
                        return campaign_complete_result(status.steps);
                    }
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
                    match engine
                        .reset(campaign.episode, campaign.map, campaign.skill)
                        .await
                    {
                        Ok(next) => {
                            budget_used += 1;
                            apply_observation(&mut status, &next);
                            observation = next;
                            previous_position = None;
                            blocked_forward_ticks = 0;
                            policy.reset_detector();
                            last_intent.clear();
                            executor.reset_positioning();
                            next_plan = None;
                            observe(&status);
                            continue;
                        }
                        Err(error) => {
                            dataset.finalize("aborted", &observation, &campaign);
                            let result = engine_failure(&mut status, error.message);
                            observe(&status);
                            return result;
                        }
                    }
                }
            }
        }

        // The intent that produced the PREVIOUS step (for the blocked-forward
        // window), captured before a new decision may replace it.
        let stepped_forward = intent_has_forward(&last_intent);

        // 1. Start a decision if none is in flight, no plan is prefetched, and
        //    the backoff has elapsed. A prefetched plan suppresses a new call so
        //    exactly one decision is ever in flight (AC2).
        if pending.is_none() && next_plan.is_none() && cooldown_ticks == 0 {
            let obs = observation.clone();
            pending = Some(Box::pin(async move { source.decide(&obs).await }));
            pending_ticks = 0;
        }

        // 2. Poll the pending decision once — NON-blocking (noop waker).
        let polled = if let Some(future) = pending.as_mut() {
            let waker = std::task::Waker::noop();
            let mut context = Context::from_waker(waker);
            Some(future.as_mut().poll(&mut context))
        } else {
            None
        };

        // The loop-measured latency of a resolved decision: the pending ticks it
        // spanned × the clock's declared period (NFR-5 — never a hidden clock).
        let decision_latency_ms = u64::from(pending_ticks) * (unit.as_millis() as u64);
        match polled {
            Some(Poll::Ready(result)) => {
                pending = None;
                pending_ticks = 0;
                // Read the source's side-channel trace IMMEDIATELY after `decide`
                // resolves (ST-4): model metadata plus the flag-gated raw reply /
                // reasoning. Skipped entirely when capture is disabled (R-5).
                let trace = dataset
                    .is_enabled()
                    .then(|| source.last_decision_trace())
                    .flatten();
                match result {
                    Ok(plan) => {
                        // An out-of-range legacy `Hold` step retains the bounded
                        // consecutive-failure stop (the native steps are already
                        // range-checked by the shared parser).
                        if let Err(detail) = validate_plan(&plan) {
                            let error = DoomDecisionError::Malformed(detail.clone());
                            dataset.record_failure(
                                &error,
                                &observation,
                                trace.as_ref(),
                                decision_latency_ms,
                                &campaign,
                            );
                            if let Some(result) =
                                record_decision_failure(&mut status, config, detail)
                            {
                                dataset.finalize("aborted", &observation, &campaign);
                                observe(&status);
                                return result;
                            }
                            cooldown_ticks = backoff_ticks;
                        } else {
                            status.decisions += 1;
                            status.consecutive_failures = 0;
                            degraded_consecutive = 0;
                            status.degraded = false;
                            if executor.is_idle() {
                                // No plan is executing → adopt and start now.
                                dataset.open_plan(
                                    &plan,
                                    &observation,
                                    trace.as_ref(),
                                    decision_latency_ms,
                                    &campaign,
                                    false,
                                );
                                executor.adopt(plan, &observation);
                            } else {
                                // A plan is mid-execution: prefetch this one and
                                // adopt it on exhaustion/divergence WITHOUT
                                // interrupting the in-flight step (AC2).
                                dataset.open_plan(
                                    &plan,
                                    &observation,
                                    trace.as_ref(),
                                    decision_latency_ms,
                                    &campaign,
                                    true,
                                );
                                next_plan = Some(plan);
                            }
                        }
                    }
                    Err(DoomDecisionError::Malformed(detail)) => {
                        // R-6: the failed attempt closes a record carrying the
                        // typed error; the applied fallback is attached at step 3c.
                        let error = DoomDecisionError::Malformed(detail.clone());
                        dataset.record_failure(
                            &error,
                            &observation,
                            trace.as_ref(),
                            decision_latency_ms,
                            &campaign,
                        );
                        if let Some(result) = record_decision_failure(&mut status, config, detail) {
                            dataset.finalize("aborted", &observation, &campaign);
                            observe(&status);
                            return result;
                        }
                        cooldown_ticks = backoff_ticks;
                    }
                    Err(other) => {
                        // `ModelUnavailable` / `TimedOut` — non-fatal (R-4): the
                        // failed attempt is recorded (R-6), the count climbs,
                        // motion continues.
                        dataset.record_failure(
                            &other,
                            &observation,
                            trace.as_ref(),
                            decision_latency_ms,
                            &campaign,
                        );
                        status.failures += 1;
                        degraded_consecutive += 1;
                        if degraded_consecutive >= DOOM_DEGRADED_AFTER_FAILURES {
                            status.degraded = true;
                        }
                        cooldown_ticks = backoff_ticks;
                    }
                }
            }
            Some(Poll::Pending) => {
                pending_ticks = pending_ticks.saturating_add(1);
                if pending_ticks >= timeout_ticks {
                    // Slower than the tick loop → abandon + degrade (R-4). The
                    // source has not returned, so no fresh trace is read — the
                    // failure is recorded as a timeout (R-6).
                    pending = None;
                    pending_ticks = 0;
                    dataset.record_failure(
                        &DoomDecisionError::TimedOut,
                        &observation,
                        None,
                        decision_latency_ms,
                        &campaign,
                    );
                    status.failures += 1;
                    degraded_consecutive += 1;
                    if degraded_consecutive >= DOOM_DEGRADED_AFTER_FAILURES {
                        status.degraded = true;
                    }
                    cooldown_ticks = backoff_ticks;
                }
            }
            None => {
                cooldown_ticks = cooldown_ticks.saturating_sub(1);
            }
        }

        // 3a. Update the divergence counters from the observation — the executor
        //     consumes them (AC3).
        let current_position = player_position(&observation);
        let moved = match (previous_position, current_position) {
            (Some(previous), Some(current)) => previous != current,
            _ => true,
        };
        policy.no_move_ticks = next_no_move_ticks(policy.no_move_ticks, moved);
        if stepped_forward && !moved {
            blocked_forward_ticks = blocked_forward_ticks.saturating_add(1);
        } else {
            blocked_forward_ticks = 0;
        }

        // 3b. Executor (Spec #3039 ST-4): evaluate divergence, then produce this
        //     tick's plan action (one step per tick — AC2). A re-plan request stops
        //     the divergent plan; the retained fallback drives until the next plan
        //     (the prefetched one, or the in-flight call) is adopted.
        let counters = ReplanCounters {
            blocked_forward_ticks,
            no_move_ticks: policy.no_move_ticks,
        };
        // The executor cursor at the START of this tick — the plan-step index a
        // re-plan fires at (the executor reports index 0 on a re-plan).
        let tick_index = executor.index();
        let plan_tick = executor.tick(&observation, &counters);
        if let Some(reason) = plan_tick.replan {
            // Preserve the #3039 re-plan observable in the dataset's
            // `execution.replans[]` — the retired action-audit `replan` record's
            // successor (`reason` is the five-reason vocabulary).
            dataset.record_replan(tick_index, reason.wire(), observation_tic(&observation));
            if let Some(plan) = next_plan.take() {
                dataset.adopt_prefetch(&observation);
                executor.adopt(plan, &observation);
            }
        }
        status.plans = executor.plans();
        status.replans = executor.replans();
        status.plan_index = plan_tick.index;

        // 3c. Compose the effective intent. A NATIVE plan step is issued directly
        //     (guarded by the retained safety reflex); the LEGACY `Hold` step and
        //     the no-step fallback run through the retained reflex + unstick/escape
        //     + local-locomotion pipeline (composed, never replaced).
        let step_controller = match &plan_tick.action {
            PlanAction::Native(_) => Some("plan"),
            PlanAction::Legacy(_) => Some("legacy"),
            PlanAction::None => None,
        };
        let effective = match plan_tick.action {
            PlanAction::Native(actions) => {
                last_intent = actions.clone();
                safety_reflex(&observation, &actions, blocked_forward_ticks)
            }
            PlanAction::Legacy(actions) => {
                last_intent = actions;
                effective_intent(
                    &observation,
                    &last_intent,
                    blocked_forward_ticks,
                    &mut policy,
                    status.steps,
                )
            }
            PlanAction::None => effective_intent(
                &observation,
                &last_intent,
                blocked_forward_ticks,
                &mut policy,
                status.steps,
            ),
        };
        status.escapes = policy.escapes;
        status.stuck_ticks = policy.no_move_ticks;
        let reflex_fired = effective != last_intent;

        // 3d. Dataset assembly (Spec #3032 ST-2): append the executed plan step
        //     with its controller; on a no-plan tick the retained reflex/fallback
        //     drives, and if a decision just failed this is its applied fallback
        //     (R-6). Both are no-ops when capture is disabled or no failure is
        //     pending.
        if let Some(controller) = step_controller {
            dataset.record_tick(plan_tick.index, controller, &effective);
        } else {
            dataset.set_fallback(if reflex_fired { "reflex" } else { "fallback" }, &effective);
        }

        // 4. Advance one tick with the persisted (reflex-guarded) intent (R-1).
        let actions = Value::Array(effective.clone());
        match engine.step(DOOM_CONTINUOUS_TICS_PER_TICK, &actions).await {
            Ok(next) => {
                budget_used += 1;
                status.steps += 1;
                previous_position = current_position;
                apply_observation(&mut status, &next);
                if let Some(kind) = terminal_kind(&next) {
                    pending_terminal = Some(kind);
                }
                // Publish/refresh the dataset record for the tick just taken.
                dataset.after_step(&next);
                observation = next;
            }
            Err(error) => {
                dataset.finalize("aborted", &observation, &campaign);
                let result = engine_failure(&mut status, error.message);
                observe(&status);
                return result;
            }
        }

        // 5. Throttled status emission (terminal transitions emit above); a
        // degrade/recover transition always emits.
        if status.degraded != observed_degraded || budget_used.is_multiple_of(emit_interval) {
            observe(&status);
            observed_degraded = status.degraded;
        }

        // 6. Pace the next tick through the injected clock (R-5).
        let period = if status.degraded {
            config.degraded_tick_period
        } else {
            config.tick_period
        };
        pace(clock, period).await;
    }

    // The tick budget was reached cleanly — a bounded exit on every path (R-4).
    dataset.finalize("timeout", &observation, &campaign);
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

    use crate::applications::doom::clock::FixedTickClock;

    /// A typed native-engine failure for the fakes.
    fn engine_error(message: &str) -> DoomEngineError {
        DoomEngineError::new(DoomEngineErrorCode::EngineStartFailed, message.to_string())
    }

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

    /// A programmable fake native engine: serves `read_state` / `step` / `reset`
    /// from scripted queues (falling back to a simple advancing world), resets the
    /// tick on `reset` unless a scripted result is set, and records every call.
    #[derive(Default)]
    struct FakeEngine {
        calls: Mutex<Vec<String>>,
        tic: Mutex<u64>,
        episode: Mutex<i64>,
        map: Mutex<i64>,
        get_queue: Mutex<VecDeque<Result<Value, DoomEngineError>>>,
        step_queue: Mutex<VecDeque<Result<Value, DoomEngineError>>>,
        reset_queue: Mutex<VecDeque<Result<Value, DoomEngineError>>>,
        reset_always_error: Mutex<Option<String>>,
    }

    impl FakeEngine {
        fn queue_get(&self, value: Value) {
            self.get_queue.lock().unwrap().push_back(Ok(value));
        }
        /// Make EVERY `reset` call fail (the positioning-failure lever).
        fn set_reset_error(&self, message: &str) {
            *self.reset_always_error.lock().unwrap() = Some(message.to_string());
        }
        /// Script the next `reset` results in order (advance-failure lever).
        fn queue_reset(&self, result: Result<Value, DoomEngineError>) {
            self.reset_queue.lock().unwrap().push_back(result);
        }
        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
        fn count(&self, needle: &str) -> usize {
            self.calls().iter().filter(|call| call.contains(needle)).count()
        }
        /// The `(episode, map)` of every `reset` call, in order.
        fn reset_calls(&self) -> Vec<(i64, i64)> {
            self.calls()
                .into_iter()
                .filter(|call| call.starts_with("reset"))
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
    impl DoomAutoplayEngine for FakeEngine {
        async fn read_state(&self) -> Result<Value, DoomEngineError> {
            self.calls.lock().unwrap().push("read_state".to_string());
            if let Some(scripted) = self.get_queue.lock().unwrap().pop_front() {
                return scripted;
            }
            Ok(state_at(
                *self.tic.lock().unwrap(),
                false,
                false,
                *self.episode.lock().unwrap(),
                *self.map.lock().unwrap(),
            ))
        }

        async fn step(&self, tics: i64, actions: &Value) -> Result<Value, DoomEngineError> {
            self.calls.lock().unwrap().push(format!("step {actions}"));
            if let Some(scripted) = self.step_queue.lock().unwrap().pop_front() {
                return scripted;
            }
            let tics = tics.max(0) as u64;
            let tic = {
                let mut tic = self.tic.lock().unwrap();
                *tic += tics;
                *tic
            };
            Ok(state_at(
                tic,
                false,
                false,
                *self.episode.lock().unwrap(),
                *self.map.lock().unwrap(),
            ))
        }

        async fn reset(&self, episode: i64, map: i64, skill: i64) -> Result<Value, DoomEngineError> {
            self.calls.lock().unwrap().push(format!(
                "reset {{\"episode\":{episode},\"map\":{map},\"skill\":{skill}}}"
            ));
            if let Some(message) = self.reset_always_error.lock().unwrap().clone() {
                return Err(engine_error(&message));
            }
            if let Some(scripted) = self.reset_queue.lock().unwrap().pop_front() {
                return scripted;
            }
            *self.episode.lock().unwrap() = episode;
            *self.map.lock().unwrap() = map;
            *self.tic.lock().unwrap() = 0;
            Ok(state_at(0, false, false, episode, map))
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
        async fn decide(&self, _observation: &Value) -> Result<DoomPlan, DoomDecisionError> {
            *self.decide_calls.lock().unwrap() += 1;
            let mut queue = self.queue.lock().unwrap();
            match queue.pop_front() {
                Some(next) => next.map(DoomPlan::from),
                None => self.fallback.clone().map(DoomPlan::from),
            }
        }
    }

    /// A source that outlives a short decision timeout (the G-300 timeout pin).
    struct SleepingSource {
        delay: Duration,
    }

    #[async_trait]
    impl DoomDecisionSource for SleepingSource {
        async fn decide(&self, _observation: &Value) -> Result<DoomPlan, DoomDecisionError> {
            tokio::time::sleep(self.delay).await;
            Ok(DoomPlan::from(DoomDecision {
                tics: 1,
                actions: vec![],
            }))
        }
    }

    /// A source whose decision NEVER resolves — induces R-1 "decision in flight"
    /// and R-4 "slower than the tick loop" deterministically (no live model).
    struct PendingSource;

    #[async_trait]
    impl DoomDecisionSource for PendingSource {
        async fn decide(&self, _observation: &Value) -> Result<DoomPlan, DoomDecisionError> {
            std::future::pending::<Result<DoomPlan, DoomDecisionError>>().await
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
            max_ticks: DOOM_CONTINUOUS_MAX_TICKS,
            max_failures,
            decision_timeout: Duration::from_secs(1),
            failure_backoff: Duration::ZERO,
            tick_period: Duration::from_millis(DOOM_CONTINUOUS_TICK_PERIOD_MS),
            degraded_tick_period: Duration::from_millis(DOOM_DEGRADED_TICK_PERIOD_MS),
            stop_on_level_exit: false,
        }
    }

    /// A continuous-loop config with an explicit tick budget and decision timeout.
    fn continuous_config(max_ticks: u32, max_failures: u32, timeout: Duration) -> DoomAutoplayConfig {
        DoomAutoplayConfig {
            max_steps: DOOM_AUTOPLAY_MAX_STEPS,
            max_ticks,
            max_failures,
            decision_timeout: timeout,
            failure_backoff: Duration::ZERO,
            tick_period: Duration::from_millis(DOOM_CONTINUOUS_TICK_PERIOD_MS),
            degraded_tick_period: Duration::from_millis(DOOM_DEGRADED_TICK_PERIOD_MS),
            stop_on_level_exit: false,
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
            &source,
            &config(4, 3),
            AutoplayRun {
                campaign: campaign(1, 3),
                progress,
            },
            &stop,
            |_| {},
        )
        .await;

        // Exactly ONE resume positioning, with the resolved coords.
        assert_eq!(engine.reset_calls(), vec![(1, 3)]);
        let calls = engine.calls();
        let first_reset = calls
            .iter()
            .position(|call| call.contains("reset"))
            .expect("a positioning call");
        let first_step = calls
            .iter()
            .position(|call| call.contains("step"))
            .expect("a step call");
        assert!(
            first_reset < first_step,
            "positioning precedes the first step"
        );
        // Positioning is not a level transition -> nothing persisted (R-5).
        assert!(
            seen.lock().unwrap().is_empty(),
            "no persist before the first advance"
        );
        assert_eq!(engine.count("step"), 3);
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
        assert_eq!(engine.count("step"), 5);
        assert_eq!(engine.count("reset"), 1);
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
        assert_eq!(engine.count("step"), 0, "an unusable decision issues NO step");
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
        assert_eq!(engine.count("step"), 0);
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
        assert_eq!(engine.count("step"), 1, "only the good decision steps");
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
        assert_eq!(engine.reset_calls(), vec![(1, 2), (1, 3)]);
        let recorded = seen.lock().unwrap().clone();
        assert_eq!(recorded.len(), 1, "exactly one persist per level transition");
        assert_eq!((recorded[0].episode, recorded[0].map), (1, 3));
        assert!(!recorded[0].completed);
        assert_eq!(result.phase, DoomAutoplayPhase::Completed);
        assert_eq!(result.code, Some(DoomAutoplayErrorCode::BudgetExhausted));
    }

    #[tokio::test]
    async fn a_death_restarts_the_same_level_without_advancing_or_persisting() {
        let engine = FakeEngine::default();
        engine.queue_get(state_at(7, false, true, 1, 5));
        let source = FakeSource::repeating(Ok(decision(1)));
        let stop = AtomicBool::new(false);
        let (progress, seen) = recording_progress();

        let _ = run_autoplay_loop(
            &engine,
            &source,
            &config(4, 3),
            AutoplayRun {
                campaign: campaign(1, 5),
                progress,
            },
            &stop,
            |_| {},
        )
        .await;

        // The death restart re-issues the SAME level coords — never an advance.
        assert_eq!(engine.reset_calls(), vec![(1, 5), (1, 5)]);
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
            engine.count("reset"),
            2,
            "positioning + exactly one advance restart per terminal observation"
        );
        let resets: Vec<String> = engine
            .calls()
            .into_iter()
            .filter(|call| call.starts_with("reset"))
            .collect();
        assert!(resets[0].contains("reset"));
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

        assert_eq!(engine.count("reset"), 2, "positioning + one death restart");
        assert_eq!(source.decide_calls(), 1);
        assert_eq!(result.steps, 1);
        assert_eq!(result.phase, DoomAutoplayPhase::Completed);
    }

    #[tokio::test]
    async fn completion_at_the_final_level_persists_completed_and_stops() {
        let engine = FakeEngine::default();
        // A level exit at the final campaign level (E1M9 — the single shareware
        // episode; there is no E2/E4).
        engine.queue_get(state_at(9, true, false, 1, 9));
        let source = FakeSource::repeating(Ok(decision(1)));
        let stop = AtomicBool::new(false);
        let (progress, seen) = recording_progress();
        let mut statuses: Vec<DoomAutoplayStatus> = Vec::new();

        let result = run_autoplay_loop(
            &engine,
            &source,
            &config(10, 3),
            AutoplayRun {
                campaign: campaign(1, 9),
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
        // Positioning only — the final level is not re-entered, and the campaign
        // never wraps into a second episode.
        assert_eq!(engine.reset_calls(), vec![(1, 9)]);
        let recorded = seen.lock().unwrap().clone();
        assert_eq!(recorded.len(), 1);
        assert_eq!((recorded[0].episode, recorded[0].map), (1, 9));
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
            ..campaign(1, 9)
        };
        let mut statuses: Vec<DoomAutoplayStatus> = Vec::new();

        let result = run_autoplay_loop(
            &engine,
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
            engine.count("reset"),
            0,
            "no positioning for a completed save"
        );
        assert_eq!(engine.count("read_state"), 0);
        assert_eq!(engine.count("step"), 0);
        assert_eq!(source.decide_calls(), 0);
        let last = statuses.last().unwrap();
        assert_eq!(last.phase, DoomAutoplayPhase::Completed);
        assert!(last.completed);
        assert_eq!((last.episode, last.map), (Some(1), Some(9)));
    }

    #[tokio::test]
    async fn a_failed_positioning_is_a_typed_engine_failure() {
        let engine = FakeEngine::default();
        engine.set_reset_error("the native reset failed");
        let source = FakeSource::repeating(Ok(decision(1)));
        let stop = AtomicBool::new(false);

        let result = run_autoplay_loop(
            &engine,
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
        assert_eq!(engine.count("reset"), 1);
        assert_eq!(engine.count("step"), 0);
    }

    #[tokio::test]
    async fn a_failed_advance_restart_is_a_typed_engine_failure() {
        let engine = FakeEngine::default();
        // Positioning succeeds; the level exit's advance restart fails.
        engine.queue_reset(Ok(state_at(0, false, false, 1, 1)));
        engine.queue_reset(Err(engine_error("the native reset failed")));
        engine.queue_get(state_json(5, true, false));
        let source = FakeSource::repeating(Ok(decision(1)));
        let stop = AtomicBool::new(false);

        let result = run_autoplay_loop(
            &engine,
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
        assert_eq!(engine.count("reset"), 2, "positioning + the failed advance");
        assert_eq!(engine.count("step"), 0);
    }

    #[tokio::test]
    async fn a_stop_request_exits_without_positioning() {
        let engine = FakeEngine::default();
        let source = FakeSource::repeating(Ok(decision(1)));
        let stop = AtomicBool::new(true);

        let result = run_autoplay_loop(
            &engine,
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
        assert_eq!(engine.count("read_state"), 0);
        assert_eq!(
            engine.count("reset"),
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
            max_ticks: DOOM_CONTINUOUS_MAX_TICKS,
            max_failures: 1,
            decision_timeout: Duration::from_millis(5),
            failure_backoff: Duration::ZERO,
            tick_period: Duration::from_millis(DOOM_CONTINUOUS_TICK_PERIOD_MS),
            degraded_tick_period: Duration::from_millis(DOOM_DEGRADED_TICK_PERIOD_MS),
            stop_on_level_exit: false,
        };

        let result = run_autoplay_loop(
            &engine,
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
        assert_eq!(engine.count("step"), 0);
    }

    #[tokio::test]
    async fn an_engine_state_failure_is_a_typed_engine_failure() {
        let engine = FakeEngine::default();
        // Make the first native read_state (after positioning) fail.
        engine
            .get_queue
            .lock()
            .unwrap()
            .push_back(Err(engine_error("the native read_state failed")));
        let source = FakeSource::repeating(Ok(decision(1)));
        let stop = AtomicBool::new(false);

        let result = run_autoplay_loop(
            &engine,
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
        assert_eq!(engine.count("step"), 0);
    }

    // ── The real native engine through the loop seam ─────────────────────────

    #[tokio::test]
    async fn a_bounded_scripted_run_drives_the_native_engine_to_a_terminal_phase() {
        use crate::applications::doom::decision::ScriptedDecisionSource;

        // The real native adapter (ST-1), launched at E1M1 / skill 3.
        let engine = DoomEngineState::default();
        engine
            .launch(1, 3)
            .expect("the native engine launches from the bundled DOOM1.WAD");

        // The deterministic scripted lever (the documented QA driver): hold
        // forward for 1 tic, forever — no model, no network.
        let source = ScriptedDecisionSource::new(
            vec![json!({ "tics": 1, "actions": [{ "type": "forward" }] })],
            true,
        );

        let stop = AtomicBool::new(false);
        let mut statuses: Vec<DoomAutoplayStatus> = Vec::new();
        let result = run_autoplay_loop(
            &engine,
            &source,
            &config(5, 3),
            AutoplayRun {
                campaign: campaign(1, 1),
                progress: no_progress(),
            },
            &stop,
            |status| statuses.push(status.clone()),
        )
        .await;

        // Bounded: the run reaches a terminal phase at the step budget.
        assert!(result.success);
        assert_eq!(result.phase, DoomAutoplayPhase::Completed);
        assert_eq!(result.code, Some(DoomAutoplayErrorCode::BudgetExhausted));
        // Budget 5 = 1 native reset + 4 native steps.
        assert_eq!(result.steps, 4);

        // Step-driven: the engine's tic strictly advances on real native steps
        // (G-316) — the run is NOT an idle-frame assertion.
        let tics: Vec<u64> = statuses.iter().filter_map(|status| status.last_tic).collect();
        assert!(
            tics.windows(2).any(|pair| pair[0] < pair[1]),
            "the native world advanced (step-driven): {tics:?}"
        );
        assert!(
            tics.last().copied().unwrap_or(0) >= 4,
            "four native steps advanced the tic"
        );
    }

    // ── Spec #3031 ST-3: driven escape + determinism ─────────────────────────

    /// **ST-3 (R-1/AC1, REQ-1).** A locomotion-free scripted hold (a `shoot`-only
    /// intent) commands NO movement; the local-locomotion guard injects `forward`,
    /// so the player walks into the wall and the no-move detector fires an escape
    /// — asserted from the deterministic driver report (`escapes >= 1` AND the
    /// player's `(x,y)` changed).
    #[tokio::test]
    async fn a_locomotion_free_scripted_run_escapes_and_moves() {
        use crate::applications::doom::decision::ScriptedDecisionSource;
        use crate::applications::doom::engine::{run_bounded_driver, DoomDriverConfig};

        let engine = DoomEngineState::default();
        let source = ScriptedDecisionSource::new(
            vec![json!({ "tics": 1, "actions": [{ "type": "shoot" }] })],
            true,
        );
        let clock = FixedTickClock::from_millis(DOOM_CONTINUOUS_TICK_PERIOD_MS);

        let report = run_bounded_driver(
            &engine,
            &source,
            DoomDriverConfig {
                map: 1,
                skill: 3,
                max_steps: 1_500,
                max_failures: 3,
                stop_at_first_exit: false,
            },
            &clock,
        )
        .await
        .expect("the native driver runs");

        assert!(
            report.escapes >= 1,
            "a locomotion-free hold must trigger the escape: {report:?}"
        );
        assert!(
            report.moved(),
            "the escape must change the player's position: {report:?}"
        );
    }

    /// **ST-3 (NFR-DET, REQ-1).** The same driven run twice with a locomotion-free
    /// script + [`FixedTickClock`] yields a field-for-field identical report —
    /// including the ST-2 `escapes` counter — step-driven, no wall clock (G-316).
    #[tokio::test]
    async fn the_driven_report_is_deterministic_with_the_escape_policy() {
        use crate::applications::doom::decision::ScriptedDecisionSource;
        use crate::applications::doom::engine::{run_bounded_driver, DoomDriverConfig, DoomDriverReport};

        async fn run() -> DoomDriverReport {
            let engine = DoomEngineState::default();
            let source = ScriptedDecisionSource::new(
                vec![json!({ "tics": 1, "actions": [{ "type": "shoot" }] })],
                true,
            );
            let clock = FixedTickClock::from_millis(DOOM_CONTINUOUS_TICK_PERIOD_MS);
            run_bounded_driver(
                &engine,
                &source,
                DoomDriverConfig {
                    map: 1,
                    skill: 3,
                    max_steps: 600,
                    max_failures: 3,
                    stop_at_first_exit: false,
                },
                &clock,
            )
            .await
            .expect("driven run")
        }

        let first = run().await;
        let second = run().await;
        assert_eq!(first, second, "identical script ⇒ identical report");
        assert_eq!(first.escapes, second.escapes);
        assert_eq!(
            (first.last_x, first.last_y),
            (second.last_x, second.last_y)
        );
    }

    // ── Safety reflex (pure, R-3) ────────────────────────────────────────────

    #[test]
    fn safety_reflex_drops_blind_forward_and_releases_fire_without_a_target() {
        let forward = vec![json!({ "type": "forward" })];
        // Below the blocked threshold → unchanged.
        assert_eq!(
            safety_reflex(&json!({}), &forward, DOOM_REFLEX_BLOCKED_TICKS - 1),
            forward
        );
        // Blocked → forward dropped, bounded step-back added.
        assert_eq!(
            safety_reflex(&json!({}), &forward, DOOM_REFLEX_BLOCKED_TICKS),
            vec![json!({ "type": "backward", "amount": DOOM_REFLEX_STEP_BACK_TICKS })]
        );

        let shoot = vec![json!({ "type": "shoot" })];
        // No front target → fire released.
        assert!(safety_reflex(&json!({ "enemies": [] }), &shoot, 0).is_empty());
        assert!(safety_reflex(
            &json!({ "enemies": [{ "direction": "back" }] }),
            &shoot,
            0
        )
        .is_empty());
        // A front target → fire kept.
        let front = json!({ "enemies": [{ "direction": "front" }] });
        assert_eq!(safety_reflex(&front, &shoot, 0), shoot);

        // Both edges at once: drop the blind forward, keep fire on a valid target.
        let both = vec![json!({ "type": "forward" }), json!({ "type": "shoot" })];
        assert_eq!(
            safety_reflex(&front, &both, DOOM_REFLEX_BLOCKED_TICKS),
            vec![
                json!({ "type": "shoot" }),
                json!({ "type": "backward", "amount": DOOM_REFLEX_STEP_BACK_TICKS }),
            ]
        );

        // An empty intent stays empty.
        assert!(safety_reflex(&front, &[], DOOM_REFLEX_BLOCKED_TICKS).is_empty());
    }

    // ── Unstick / escape + local policy (pure, Spec #3031 ST-3) ──────────────

    #[test]
    fn escape_heading_uses_the_corrected_live_mapping() {
        // ST-1 measured on the real engine: turn-to A ⇒ angle A; left = +90°
        // relative, right = +270° relative (the plan's sign was inverted).
        assert_eq!(escape_heading("front", 90), 90);
        assert_eq!(escape_heading("left", 90), 180);
        assert_eq!(escape_heading("right", 90), 0); // (90 + 270) % 360
        assert_eq!(escape_heading("right", 45), 315);
        assert_eq!(escape_heading("left", 300), 30); // wraps past 360
        assert_eq!(escape_heading("right", 350), 260);
        assert_eq!(escape_heading("front", 0), 0);
        // Never negative and always within turn-to's accepted 0..=359.
        for angle in [0, 45, 90, 180, 270, 359] {
            for direction in ["front", "left", "right"] {
                let heading = escape_heading(direction, angle);
                assert!((0..=359).contains(&heading), "{direction} @ {angle}");
            }
        }
    }

    #[test]
    fn escape_direction_rotates_and_prefers_open_directions() {
        let blocked_front = json!([{ "direction": "front", "distance": 40, "blocked": true }]);
        let walls = blocked_front.as_array().unwrap();
        // escapes 0 → rotation starts at "front" (blocked) → "left" (absent=open).
        assert_eq!(escape_direction(walls, 0), "left");
        // escapes 1 → starts at "left" (open).
        assert_eq!(escape_direction(walls, 1), "left");
        // escapes 2 reaches the re-route threshold: the rotation is re-ordered by
        // clearance (right/left ties at open, front blocked) → a DIFFERENT heading.
        assert_eq!(escape_direction(walls, 2), "right");

        // All blocked → the maximum-clearance (least-blocked) direction wins.
        let all_blocked = json!([
            { "direction": "front", "distance": 10, "blocked": true },
            { "direction": "left", "distance": 20, "blocked": true },
            { "direction": "right", "distance": 30, "blocked": true },
        ]);
        assert_eq!(escape_direction(all_blocked.as_array().unwrap(), 0), "right");
        assert_eq!(escape_direction(all_blocked.as_array().unwrap(), 2), "right");

        // Empty walls: everything is open; the rotation start advances each escape.
        assert_eq!(escape_direction(&[], 0), "front");
        assert_eq!(escape_direction(&[], 1), "left");
        assert_eq!(escape_direction(&[], 2), "right");

        // A non-blocked direction is preferred over a more distant but blocked one.
        let mixed = json!([
            { "direction": "front", "distance": 10, "blocked": true },
            { "direction": "left", "distance": 900, "blocked": false },
        ]);
        assert_eq!(escape_direction(mixed.as_array().unwrap(), 0), "left");
    }

    #[test]
    fn intent_has_locomotion_covers_movement_actions_only() {
        assert!(!intent_has_locomotion(&[]));
        assert!(!intent_has_locomotion(&[json!({ "type": "shoot" })]));
        assert!(!intent_has_locomotion(&[json!({ "type": "turn-to", "angle": 90 })]));
        assert!(!intent_has_locomotion(&[json!({ "type": "turn-left", "amount": 10 })]));
        assert!(!intent_has_locomotion(&[json!({ "type": "use" })]));
        assert!(!intent_has_locomotion(&[json!({ "type": "run", "amount": 10 })]));

        assert!(intent_has_locomotion(&[json!({ "type": "forward" })]));
        assert!(intent_has_locomotion(&[json!({ "type": "backward", "amount": 2 })]));
        assert!(intent_has_locomotion(&[json!({ "type": "strafe-left" })]));
        assert!(intent_has_locomotion(&[json!({ "type": "strafe-right" })]));
        // Any locomotion action in a mixed set counts.
        assert!(intent_has_locomotion(&[
            json!({ "type": "shoot" }),
            json!({ "type": "forward" }),
        ]));
    }

    #[test]
    fn next_no_move_ticks_resets_on_movement() {
        assert_eq!(next_no_move_ticks(0, true), 0);
        assert_eq!(next_no_move_ticks(5, true), 0);
        assert_eq!(next_no_move_ticks(0, false), 1);
        assert_eq!(next_no_move_ticks(11, false), 12);
        assert_eq!(next_no_move_ticks(u32::MAX, false), u32::MAX);
    }

    #[test]
    fn effective_intent_escapes_with_a_turn_and_a_movement_when_stuck() {
        let observation = json!({
            "player": { "angle": 90 },
            "walls": [
                { "direction": "front", "distance": 40, "blocked": true },
                { "direction": "left", "distance": 200, "blocked": false },
                { "direction": "right", "distance": 150, "blocked": false },
            ],
        });
        let mut policy = DoomLocalPolicy {
            no_move_ticks: DOOM_ESCAPE_STUCK_TICKS,
            ..DoomLocalPolicy::default()
        };
        let intent = effective_intent(&observation, &[json!({ "type": "shoot" })], 0, &mut policy, 1);
        let types: Vec<&str> = intent.iter().filter_map(|a| a["type"].as_str()).collect();
        // A turn AND a movement in the SAME action set (R-1 / REQ-1).
        assert!(types.contains(&"turn-to"), "{intent:?}");
        assert!(types.contains(&"forward"), "{intent:?}");
        assert_eq!(policy.escapes, 1);
        assert_eq!(policy.escape_ticks_remaining, DOOM_ESCAPE_WINDOW_TICKS - 1);
    }

    #[test]
    fn effective_intent_injects_locomotion_for_every_locomotion_free_intent() {
        for actions in [
            Vec::new(),
            vec![json!({ "type": "shoot" })],
            vec![json!({ "type": "turn-to", "angle": 90 })],
            vec![json!({ "type": "turn-right", "amount": 10 })],
            vec![json!({ "type": "use" })],
        ] {
            let mut policy = DoomLocalPolicy::default();
            let intent = effective_intent(&json!({}), &actions, 0, &mut policy, 1);
            assert!(
                intent_has_locomotion(&intent),
                "a locomotion-free intent must gain locomotion: {actions:?} -> {intent:?}"
            );
        }
    }

    #[test]
    fn effective_intent_does_not_duplicate_an_existing_locomotion_action() {
        let mut policy = DoomLocalPolicy::default();
        let intent = effective_intent(
            &json!({}),
            &[json!({ "type": "forward", "amount": 3 })],
            0,
            &mut policy,
            0,
        );
        assert_eq!(intent, vec![json!({ "type": "forward", "amount": 3 })]);
    }

    #[test]
    fn a_stuck_player_keeps_escaping_then_reroutes_after_the_window() {
        let observation = json!({ "player": { "angle": 0 }, "walls": [] });
        let mut policy = DoomLocalPolicy {
            no_move_ticks: DOOM_ESCAPE_STUCK_TICKS,
            ..DoomLocalPolicy::default()
        };
        // Entry increments once and opens the window.
        let _ = effective_intent(&observation, &[], 0, &mut policy, 0);
        assert_eq!(policy.escapes, 1);
        // The window holds the escape without re-incrementing for its full length.
        for _ in 0..(DOOM_ESCAPE_WINDOW_TICKS - 1) {
            let _ = effective_intent(&observation, &[], 0, &mut policy, 0);
        }
        assert_eq!(policy.escapes, 1, "no re-entry while the window is active");
        assert_eq!(policy.escape_ticks_remaining, 0);
        // Still stuck and the window expired → a fresh escape (re-route).
        let _ = effective_intent(&observation, &[], 0, &mut policy, 0);
        assert_eq!(policy.escapes, 2, "a new escape begins after the window");
    }

    #[test]
    fn reset_detector_clears_the_streak_and_window_but_not_the_escape_count() {
        let mut policy = DoomLocalPolicy {
            no_move_ticks: 20,
            escapes: 3,
            escape_ticks_remaining: 7,
        };
        policy.reset_detector();
        assert_eq!(policy.no_move_ticks, 0);
        assert_eq!(policy.escape_ticks_remaining, 0);
        assert_eq!(policy.escapes, 3, "the run-total escape count is retained");
    }

    #[test]
    fn door_use_presses_on_the_cadence_for_a_front_near_door() {
        let near = json!({ "doors": [{ "direction": "front", "distance": 40 }] });
        let far = json!({ "doors": [{ "direction": "front", "distance": 400 }] });
        let back = json!({ "doors": [{ "direction": "back", "distance": 40 }] });
        assert!(has_front_near_door(&near));
        assert!(!has_front_near_door(&far));
        assert!(!has_front_near_door(&back));
        assert!(!has_front_near_door(&json!({})));

        assert!(door_use_due(&near, 0));
        assert!(door_use_due(&near, DOOM_LOCAL_DOOR_USE_TICKS));
        assert!(!door_use_due(&near, 1));
        assert!(!door_use_due(&far, 0));
        assert!(!door_use_due(&back, 0));
    }

    #[test]
    fn the_escape_intent_carries_the_issued_turn_and_forward_action_set() {
        let observation = json!({ "player": { "angle": 0 }, "walls": [] });
        let mut policy = DoomLocalPolicy {
            no_move_ticks: DOOM_ESCAPE_STUCK_TICKS,
            ..DoomLocalPolicy::default()
        };
        let intent = effective_intent(&observation, &[], 0, &mut policy, 1);
        assert!(intent.iter().any(|action| action["type"] == "turn-to"));
        assert!(intent.iter().any(|action| action["type"] == "forward"));
    }

    #[test]
    fn pacing_ticks_rounds_up_from_the_injected_unit() {
        let unit = Duration::from_millis(28);
        assert_eq!(pacing_ticks(Duration::from_millis(28), unit), 1);
        assert_eq!(pacing_ticks(Duration::from_millis(50), unit), 2);
        assert_eq!(pacing_ticks(Duration::ZERO, unit), 1);
        // A zero unit (immediate deterministic clock) is always one wait.
        assert_eq!(pacing_ticks(Duration::from_millis(50), Duration::ZERO), 1);
    }

    #[test]
    fn autoplay_config_defaults_and_env_are_pinned_and_inert_when_unset() {
        let default = DoomAutoplayConfig::default();
        assert_eq!(default.max_ticks, DOOM_CONTINUOUS_MAX_TICKS);
        assert_eq!(
            default.tick_period,
            Duration::from_millis(DOOM_CONTINUOUS_TICK_PERIOD_MS)
        );
        assert_eq!(
            default.degraded_tick_period,
            Duration::from_millis(DOOM_DEGRADED_TICK_PERIOD_MS)
        );

        // The stop-on-exit seam default is inert.
        assert!(!default.stop_on_level_exit);

        if crate::applications::doom::decision::max_steps_from_env().is_none()
            && crate::applications::doom::decision::max_failures_from_env().is_none()
            && std::env::var(DOOM_AGENT_STOP_ON_EXIT_ENV).is_err()
        {
            let resolved = DoomAutoplayConfig::from_env();
            assert_eq!(resolved.max_ticks, default.max_ticks);
            assert_eq!(resolved.max_failures, default.max_failures);
            assert_eq!(resolved.stop_on_level_exit, default.stop_on_level_exit);
        }
    }

    #[test]
    fn the_stop_on_exit_env_seam_is_inert_when_unset() {
        assert_eq!(
            DOOM_AGENT_STOP_ON_EXIT_ENV,
            "FREDO_DOOM_AGENT_STOP_ON_EXIT"
        );
        assert!(!stop_on_level_exit_from(None));
        assert!(!stop_on_level_exit_from(Some("")));
        assert!(!stop_on_level_exit_from(Some("0")));
        assert!(!stop_on_level_exit_from(Some("true")));
        assert!(stop_on_level_exit_from(Some("1")));
        assert!(stop_on_level_exit_from(Some(" 1 ")));
    }

    // ── The continuous loop (Spec #3026 R-1/R-3/R-4) ─────────────────────────

    #[tokio::test]
    async fn continuous_loop_advances_every_tick_while_a_decision_is_in_flight() {
        let engine = FakeEngine::default();
        let source = PendingSource;
        let clock = FixedTickClock::from_millis(DOOM_CONTINUOUS_TICK_PERIOD_MS);
        let stop = AtomicBool::new(false);
        let mut statuses: Vec<DoomAutoplayStatus> = Vec::new();
        // timeout_ticks = ceil(50 / 28) = 2 -> the stalled source times out and
        // the loop degrades WHILE keeping motion.
        let cfg = continuous_config(12, 3, Duration::from_millis(50));

        let result = run_continuous_loop(
            &engine,
            &source,
            &cfg,
            &clock,
            AutoplayRun {
                campaign: campaign(1, 1),
                progress: no_progress(),
            },
            &stop,
            |status| statuses.push(status.clone()),
        )
        .await;

        // Positioning + 11 steps = the 12-tick budget.
        assert_eq!(result.steps, 11);
        assert_eq!(engine.count("step"), 11, "motion never waits for a decision");
        assert_eq!(engine.count("reset"), 1, "exactly one resume positioning");
        assert_eq!(result.phase, DoomAutoplayPhase::Completed);
        assert_eq!(result.code, Some(DoomAutoplayErrorCode::BudgetExhausted));
        assert!(
            statuses.last().unwrap().degraded,
            "a stalled source degrades the pacing (R-4)"
        );
        let tics: Vec<u64> = statuses.iter().filter_map(|status| status.last_tic).collect();
        assert!(tics.last().copied().unwrap_or(0) >= 4, "the world advanced");
    }

    #[tokio::test]
    async fn continuous_loop_completes_at_the_tick_budget_with_a_live_decision() {
        let engine = FakeEngine::default();
        let source = FakeSource::repeating(Ok(decision(1)));
        let clock = FixedTickClock::from_millis(DOOM_CONTINUOUS_TICK_PERIOD_MS);
        let stop = AtomicBool::new(false);
        let mut statuses: Vec<DoomAutoplayStatus> = Vec::new();
        let cfg = continuous_config(6, 3, Duration::from_secs(1));

        let result = run_continuous_loop(
            &engine,
            &source,
            &cfg,
            &clock,
            AutoplayRun {
                campaign: campaign(1, 1),
                progress: no_progress(),
            },
            &stop,
            |status| statuses.push(status.clone()),
        )
        .await;

        assert!(result.success);
        assert_eq!(result.phase, DoomAutoplayPhase::Completed);
        assert_eq!(result.code, Some(DoomAutoplayErrorCode::BudgetExhausted));
        // Budget 6 = positioning + 5 ticks.
        assert_eq!(result.steps, 5);
        assert_eq!(engine.count("step"), 5);
        assert_eq!(source.decide_calls(), 5, "one decision per tick");
        assert!(
            !statuses.last().unwrap().degraded,
            "a live source never degrades"
        );
    }

    #[tokio::test]
    async fn continuous_loop_a_stop_request_exits_without_positioning() {
        let engine = FakeEngine::default();
        let source = FakeSource::repeating(Ok(decision(1)));
        let clock = FixedTickClock::from_millis(DOOM_CONTINUOUS_TICK_PERIOD_MS);
        let stop = AtomicBool::new(true);
        let cfg = continuous_config(10, 3, Duration::from_secs(1));

        let result = run_continuous_loop(
            &engine,
            &source,
            &cfg,
            &clock,
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
        assert_eq!(engine.count("reset"), 0, "a stop before start positions nothing");
        assert_eq!(engine.count("step"), 0);
        assert_eq!(source.decide_calls(), 0);
    }

    #[tokio::test]
    async fn continuous_loop_a_malformed_decision_retains_the_bounded_failure_stop() {
        let engine = FakeEngine::default();
        let source = FakeSource::repeating(Err(DoomDecisionError::Malformed("bad".to_string())));
        let clock = FixedTickClock::from_millis(DOOM_CONTINUOUS_TICK_PERIOD_MS);
        let stop = AtomicBool::new(false);
        let cfg = continuous_config(100, 2, Duration::from_secs(1));

        let result = run_continuous_loop(
            &engine,
            &source,
            &cfg,
            &clock,
            AutoplayRun {
                campaign: campaign(1, 1),
                progress: no_progress(),
            },
            &stop,
            |_| {},
        )
        .await;

        assert!(!result.success);
        assert_eq!(result.phase, DoomAutoplayPhase::Failed);
        assert_eq!(result.code, Some(DoomAutoplayErrorCode::DecisionFailed));
        // Motion continued between the malformed decisions (never froze).
        assert!(engine.count("step") > 0, "the world kept advancing");
    }

    #[tokio::test]
    async fn continuous_loop_recovers_from_degrade_on_a_valid_decision() {
        // A source that is unavailable twice, then valid: the loop degrades (R-4)
        // then recovers to nominal on the good decision.
        let engine = FakeEngine::default();
        let unavailable = || Err(DoomDecisionError::ModelUnavailable("down".to_string()));
        let source = FakeSource::sequence(
            vec![unavailable(), unavailable(), Ok(decision(1))],
            Ok(decision(1)),
        );
        let clock = FixedTickClock::from_millis(DOOM_CONTINUOUS_TICK_PERIOD_MS);
        let stop = AtomicBool::new(false);
        let mut statuses: Vec<DoomAutoplayStatus> = Vec::new();
        // Big tick budget so the run is bounded by the source, not the clock.
        let cfg = continuous_config(6, 5, Duration::from_secs(1));

        let result = run_continuous_loop(
            &engine,
            &source,
            &cfg,
            &clock,
            AutoplayRun {
                campaign: campaign(1, 1),
                progress: no_progress(),
            },
            &stop,
            |status| statuses.push(status.clone()),
        )
        .await;

        assert!(result.success);
        assert_eq!(result.steps, 5);
        assert!(
            statuses.iter().any(|status| status.degraded),
            "two unavailable decisions degrade the pacing"
        );
        assert!(
            !statuses.last().unwrap().degraded,
            "a valid decision recovers to nominal pacing"
        );
    }

    // ── Executor action-set observability (Spec #3039 ST-4b, F-4) ────────────

    #[test]
    fn the_open_door_step_issues_use_and_a_repeated_move_tick_repeats_identically() {
        let observation = json!({ "player": { "x": 0, "y": 0, "angle": 0 } });

        // (a) An `open-door` native step's FIRST tick issues `[turn-to, use]` —
        // the observable the retired audit record carried, now preserved in the
        // dataset's `execution.steps[].actions`.
        let mut executor = PlanExecutor::new();
        executor.adopt(
            DoomPlan {
                steps: vec![DoomPlanStep::OpenDoor { bearing: 90 }],
            },
            &observation,
        );
        let open_door_tick = executor.tick(&observation, &ReplanCounters::default());
        let PlanAction::Native(open_door_actions) = open_door_tick.action else {
            panic!("an open-door step must issue native actions");
        };
        assert!(
            open_door_actions
                .iter()
                .any(|action| action["type"] == DOOM_ACTION_USE),
            "the open-door first tick issues `use`"
        );

        // (b) A repeated IDENTICAL `Move` tick re-issues its action set: the
        // dataset coalesces the two ticks into ONE step entry (its `tics` counts
        // both), so the bounded writer is not flooded.
        let mut executor = PlanExecutor::new();
        executor.adopt(
            DoomPlan {
                steps: vec![DoomPlanStep::Move {
                    bearing: 0,
                    distance: 8,
                }],
            },
            &observation,
        );
        let first_tick = executor.tick(&observation, &ReplanCounters::default());
        let PlanAction::Native(first_actions) = first_tick.action else {
            panic!("a move step must issue native actions");
        };
        let second_tick = executor.tick(&observation, &ReplanCounters::default());
        let PlanAction::Native(second_actions) = second_tick.action else {
            panic!("a move step must keep issuing native actions");
        };
        assert_eq!(
            second_actions, first_actions,
            "an unchanged move step re-issues an identical action set"
        );
    }

    // ── Stop-on-exit (Spec #3039 ST-4b) ──────────────────────────────────────

    #[tokio::test]
    async fn stop_on_level_exit_holds_at_the_first_non_final_level_exit() {
        let engine = FakeEngine::default();
        // The FIRST step reports the terminal single-level exit (`outcome == "exited"`).
        engine
            .step_queue
            .lock()
            .unwrap()
            .push_back(Ok(state_json(10, true, false)));
        let source = FakeSource::repeating(Ok(decision(1)));
        let clock = FixedTickClock::from_millis(DOOM_CONTINUOUS_TICK_PERIOD_MS);
        let stop = AtomicBool::new(false);
        let mut statuses: Vec<DoomAutoplayStatus> = Vec::new();
        let mut cfg = continuous_config(50, 3, Duration::from_secs(1));
        cfg.stop_on_level_exit = true;

        let result = run_continuous_loop(
            &engine,
            &source,
            &cfg,
            &clock,
            AutoplayRun {
                campaign: campaign(1, 1),
                progress: no_progress(),
            },
            &stop,
            |status| statuses.push(status.clone()),
        )
        .await;

        assert!(result.success);
        assert_eq!(result.phase, DoomAutoplayPhase::Completed);
        assert_eq!(result.code, Some(DoomAutoplayErrorCode::CampaignComplete));
        // Terminated AT the exit: only the resume positioning reset — the
        // campaign was NOT advanced.
        assert_eq!(engine.count("reset"), 1, "the campaign was not advanced");
        let last = statuses.last().unwrap();
        assert_eq!(last.outcome.as_deref(), Some("exited"));
        assert_eq!(last.map, Some(1), "still at the exit level");
        assert!(
            !last.completed,
            "a single-level exit is not campaign-complete"
        );
    }

    #[tokio::test]
    async fn the_default_stop_on_exit_flag_advances_the_campaign() {
        let engine = FakeEngine::default();
        engine
            .step_queue
            .lock()
            .unwrap()
            .push_back(Ok(state_json(10, true, false)));
        let source = FakeSource::repeating(Ok(decision(1)));
        let clock = FixedTickClock::from_millis(DOOM_CONTINUOUS_TICK_PERIOD_MS);
        let stop = AtomicBool::new(false);
        // The shipped default (`stop_on_level_exit == false`) is byte-identical:
        // the exit advances the campaign to map 2.
        let cfg = continuous_config(6, 3, Duration::from_secs(1));

        let result = run_continuous_loop(
            &engine,
            &source,
            &cfg,
            &clock,
            AutoplayRun {
                campaign: campaign(1, 1),
                progress: no_progress(),
            },
            &stop,
            |_| {},
        )
        .await;

        assert_eq!(
            engine.reset_calls(),
            vec![(1, 1), (1, 2)],
            "the exit advanced the campaign"
        );
        assert_eq!(result.phase, DoomAutoplayPhase::Completed);
        assert_eq!(result.code, Some(DoomAutoplayErrorCode::BudgetExhausted));
    }

    // ── Dataset assembly (Spec #3032 ST-2) ───────────────────────────────────

    use crate::applications::doom::dataset::DOOM_DATASET_FILE;

    /// A capture-enabled assembler writing into `dir`.
    fn dataset_assembler(dir: &Path) -> DoomDatasetAssembler {
        let writer = Arc::new(DoomDatasetWriter::new(DoomDatasetConfig::new(dir)));
        DoomDatasetAssembler::new(Some(writer), "run-test".to_string(), "scripted".to_string())
    }

    /// Every record currently in the active dataset file, in order.
    fn dataset_records(dir: &Path) -> Vec<DoomDatasetRecord> {
        std::fs::read_to_string(dir.join(DOOM_DATASET_FILE))
            .unwrap_or_default()
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| DoomDatasetRecord::from_json_line(line).expect("a dataset record"))
            .collect()
    }

    /// An alive observation at E1M1 with the shaped-reward counters set.
    fn level_observation(
        tic: u64,
        kills: i64,
        items: i64,
        secrets: i64,
        health: i64,
        x: i64,
        y: i64,
    ) -> Value {
        json!({
            "tic": tic,
            "done": false,
            "outcome": "alive",
            "level": {
                "episode": 1, "map": 1, "skill": 3,
                "kills": kills, "items": items, "secrets": secrets,
            },
            "player": { "x": x, "y": y, "angle": 90, "health": health },
            "exit": { "distance": 400 },
            "forward": { "rays": [], "openings": [], "doorBearings": [] },
        })
    }

    fn sample_plan() -> DoomPlan {
        DoomPlan {
            steps: vec![DoomPlanStep::Move {
                bearing: 90,
                distance: 256,
            }],
        }
    }

    fn forward_tick_actions() -> Vec<Value> {
        vec![
            json!({ "type": "turn-to", "angle": 90 }),
            json!({ "type": "forward", "amount": 1 }),
        ]
    }

    #[test]
    fn capture_disabled_writes_no_record_and_no_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut assembler =
            DoomDatasetAssembler::new(None, "run".to_string(), "scripted".to_string());
        assert!(!assembler.is_enabled());
        let observation = level_observation(10, 0, 0, 0, 100, 0, 0);
        assembler.open_plan(&sample_plan(), &observation, None, 0, &campaign(1, 1), false);
        assembler.record_tick(0, "plan", &forward_tick_actions());
        assembler.finalize("exited", &observation, &campaign(1, 1));
        assert!(
            !dir.path().join(DOOM_DATASET_FILE).exists(),
            "capture OFF creates no dataset file (R-5)"
        );
    }

    #[test]
    fn a_resolved_plan_opens_one_correlated_record_with_plan_and_execution() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut assembler = dataset_assembler(dir.path());
        assert!(assembler.is_enabled());
        let baseline = level_observation(10, 1, 0, 0, 100, 0, 0);
        let next = level_observation(12, 2, 0, 0, 90, 20, 0);
        assembler.open_plan(&sample_plan(), &baseline, None, 7, &campaign(1, 1), false);
        // Two ticks of the SAME plan step coalesce into ONE step entry (tics 2).
        assembler.record_tick(0, "plan", &forward_tick_actions());
        assembler.record_tick(0, "plan", &forward_tick_actions());
        assembler.record_replan(1, "exhausted", 12);
        assembler.after_step(&next);
        assembler.finalize("timeout", &next, &campaign(1, 1));

        let records = dataset_records(dir.path());
        assert_eq!(records.len(), 1, "ONE record per decision attempt");
        let record = &records[0];
        assert_eq!(record.run_id, "run-test");
        assert_eq!(record.decision_id, "run-test:1");
        assert_eq!(record.episode_id, "run-test:e1-m1");
        assert_eq!(record.source, "scripted");
        assert_eq!(record.latency_ms, 7);
        assert_eq!(record.tic, 10);
        assert_eq!(record.step_index, 0);
        assert_eq!(record.level.wad_id, DOOM_DATASET_WAD_ID);
        assert_eq!(record.model.schema_version, DOOM_PLAN_SCHEMA_NAME);
        assert_eq!(record.observation, baseline);
        // The adopted decision is the PLAN (`doom_plan` steps), not `{tics,actions}`.
        let plan = record.decision.as_ref().expect("the adopted plan").plan.clone();
        assert_eq!(plan, vec![json!({ "op": "move", "bearing": 90, "distance": 256 })]);
        // Execution: one coalesced step, the re-plan reason, and the window.
        assert_eq!(record.execution.adopted_tic, 10);
        assert_eq!(record.execution.exhausted_tic, 12);
        assert_eq!(record.execution.planned_steps, 1);
        assert_eq!(record.execution.executed_steps, 1);
        assert_eq!(record.execution.steps[0].index, 0);
        assert_eq!(record.execution.steps[0].controller, "plan");
        assert_eq!(record.execution.steps[0].tics, 2);
        assert_eq!(record.execution.replans[0].index, 1);
        assert_eq!(record.execution.replans[0].reason, "exhausted");
        assert_eq!(record.execution.replans[0].tic, 12);
        // nextState + the shaped reward (the adoption→next deltas).
        assert_eq!(record.next_state, next);
        assert_eq!(record.reward.d_kills, 1);
        assert_eq!(record.reward.d_items, 0);
        assert_eq!(record.reward.d_health, -10);
        assert_eq!(record.reward.d_distance_to_exit, Some(0));
        assert!(record.reward.moved, "the player moved between the two states");
        // The run-end terminal stamp.
        assert_eq!(record.terminal.as_ref().expect("terminal").kind, "timeout");
    }

    #[test]
    fn a_fair_play_gated_exit_yields_a_null_distance_delta() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut assembler = dataset_assembler(dir.path());
        let baseline = json!({ "tic": 1, "level": { "episode": 1, "map": 1 } });
        let next = json!({ "tic": 2, "level": { "episode": 1, "map": 1 } });
        assembler.open_plan(&sample_plan(), &baseline, None, 0, &campaign(1, 1), false);
        assembler.after_step(&next);
        assembler.finalize("timeout", &next, &campaign(1, 1));
        let records = dataset_records(dir.path());
        assert_eq!(
            records[0].reward.d_distance_to_exit, None,
            "no exit info ⇒ a null distance delta (fair-play gated)"
        );
    }

    #[test]
    fn the_terminal_stamp_lands_on_the_in_flight_record() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut assembler = dataset_assembler(dir.path());
        let start = level_observation(10, 4, 1, 1, 100, 0, 0);
        assembler.open_plan(&sample_plan(), &start, None, 0, &campaign(1, 1), false);
        assembler.record_tick(0, "plan", &forward_tick_actions());
        let terminal = json!({
            "tic": 40, "done": true, "outcome": "exited",
            "level": { "episode": 1, "map": 1, "skill": 3, "kills": 5, "items": 2, "secrets": 1 },
            "player": { "x": 5, "y": 6, "angle": 90, "health": 80 },
        });
        assembler.finalize("exited", &terminal, &campaign(1, 1));

        let records = dataset_records(dir.path());
        assert_eq!(records.len(), 1);
        let stamp = records[0].terminal.as_ref().expect("the terminal stamp");
        assert_eq!(stamp.kind, "exited");
        assert_eq!(stamp.level_result.episode, 1);
        assert_eq!(stamp.level_result.map, 1);
        assert_eq!(stamp.level_result.outcome, "exited");
        assert_eq!(stamp.level_result.kills, 5);
        assert_eq!(stamp.level_result.items, 2);
        assert_eq!(stamp.level_result.secrets, 1);
    }

    #[test]
    fn a_decision_error_records_the_applied_fallback_with_its_controller() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut assembler = dataset_assembler(dir.path());
        let observation = level_observation(10, 0, 0, 0, 100, 0, 0);
        assembler.record_failure(
            &DoomDecisionError::TimedOut,
            &observation,
            None,
            3,
            &campaign(1, 1),
        );
        assembler.set_fallback(
            "fallback",
            &[
                json!({ "type": "turn-to", "angle": 90 }),
                json!({ "type": "forward", "amount": 10 }),
            ],
        );
        assembler.after_step(&observation);

        let records = dataset_records(dir.path());
        assert_eq!(records.len(), 1);
        let record = &records[0];
        assert!(record.decision.is_none(), "a failed attempt has no plan");
        let error = record.decision_error.as_ref().expect("the typed error");
        assert_eq!(error.kind, "timedOut");
        assert_eq!(record.execution.steps.len(), 1);
        assert_eq!(record.execution.steps[0].controller, "fallback");
        assert_eq!(record.execution.steps[0].actions[0]["type"], "turn-to");
    }

    #[test]
    fn the_decision_error_kinds_are_pinned() {
        assert_eq!(
            dataset_decision_error(&DoomDecisionError::Malformed("x".to_string())).kind,
            "malformed"
        );
        assert_eq!(
            dataset_decision_error(&DoomDecisionError::ModelUnavailable("x".to_string())).kind,
            "modelUnavailable"
        );
        assert_eq!(
            dataset_decision_error(&DoomDecisionError::TimedOut).kind,
            "timedOut"
        );
    }

    #[test]
    fn a_prefetched_plan_gets_its_own_record_and_is_promoted_on_adoption() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut assembler = dataset_assembler(dir.path());
        let observation = level_observation(10, 0, 0, 0, 100, 0, 0);
        let plan = sample_plan();
        // Plan A adopted; plan B resolves while A still executes (prefetched).
        assembler.open_plan(&plan, &observation, None, 0, &campaign(1, 1), false);
        assembler.record_tick(0, "plan", &forward_tick_actions());
        assembler.open_plan(&plan, &observation, None, 0, &campaign(1, 1), true);
        // B is adopted on A's exhaustion: A closes (superseded), B becomes active.
        assembler.adopt_prefetch(&observation);
        assembler.record_tick(0, "plan", &forward_tick_actions());
        assembler.finalize("timeout", &observation, &campaign(1, 1));

        let records = dataset_records(dir.path());
        assert_eq!(records.len(), 2, "one record per resolved decision");
        assert_eq!(records[0].decision_id, "run-test:1");
        assert!(records[0].terminal.is_none(), "the superseded record has no terminal");
        assert_eq!(records[1].decision_id, "run-test:2");
        assert_eq!(records[1].terminal.as_ref().expect("terminal").kind, "timeout");
    }

    #[test]
    fn the_retired_action_audit_file_is_never_written() {
        // The captured run writes ONLY the dataset; the capped
        // `doom-agent-actions.jsonl` writer is gone (ST-2 retires it).
        let dir = tempfile::tempdir().expect("tempdir");
        let mut assembler = dataset_assembler(dir.path());
        let observation = level_observation(10, 0, 0, 0, 100, 0, 0);
        assembler.open_plan(&sample_plan(), &observation, None, 0, &campaign(1, 1), false);
        assembler.record_tick(0, "plan", &forward_tick_actions());
        assembler.finalize("timeout", &observation, &campaign(1, 1));
        assert!(dir.path().join(DOOM_DATASET_FILE).exists());
        assert!(
            !dir.path().join("doom-agent-actions.jsonl").exists(),
            "the retired action-audit file is never written"
        );
    }
}
