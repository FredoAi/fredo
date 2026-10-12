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
use std::path::Path;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::task::{Context, Poll};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::infrastructure::companion::doom_decision::{
    DoomDecision, DoomDecisionError, DoomDecisionSource, DoomPlan, DoomPlanStep,
};

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
use super::engine::{DoomEngineError, DoomEngineErrorCode, DoomEngineState};
use super::plan::{
    build_replan_audit_record, observation_has_front_enemy, PlanAction, PlanExecutor,
    ReplanCounters,
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

/// File name of the bounded issued-action / reflex audit JSONL inside
/// [`super::decision::DOOM_AGENT_LOG_DIR_ENV`].
pub const DOOM_AGENT_ACTION_AUDIT_FILE: &str = "doom-agent-actions.jsonl";

/// Maximum records retained in the issued-action audit JSONL (the last-N bound).
pub const DOOM_AGENT_ACTION_AUDIT_MAX_RECORDS: usize = 256;

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
        }
    }
}

impl DoomAutoplayConfig {
    /// The binding default with the `FREDO_DOOM_AGENT_*` env seams applied
    /// (inert when unset, so the cloud/production default is unchanged).
    ///
    /// The legacy `FREDO_DOOM_AGENT_MAX_STEPS` seam maps onto `max_ticks` (the
    /// continuous tick budget) — one seam, kept for compatibility (Spec #3026).
    pub fn from_env() -> Self {
        let mut config = Self::default();
        if let Some(max_ticks) = super::decision::max_steps_from_env() {
            config.max_ticks = max_ticks;
        }
        if let Some(max_failures) = super::decision::max_failures_from_env() {
            config.max_failures = max_failures;
        }
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

/// One compact issued-action / reflex audit record (Spec #3026 R-3 / G-273).
pub fn build_action_audit_record(
    tic: Option<u64>,
    actions: &[Value],
    reflex: bool,
    degraded: bool,
) -> Value {
    json!({
        "at": chrono::Utc::now().to_rfc3339(),
        "tic": tic,
        "actions": actions,
        "reflex": reflex,
        "degraded": degraded,
    })
}

/// Append one record to the bounded issued-action JSONL under `dir`, retaining
/// the last [`DOOM_AGENT_ACTION_AUDIT_MAX_RECORDS`] lines. Best-effort: a caller
/// treats a failure as non-fatal (an audit write never fails the run).
pub fn append_action_audit(dir: &Path, record: &Value) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join(DOOM_AGENT_ACTION_AUDIT_FILE);
    let mut lines: Vec<String> = std::fs::read_to_string(&path)
        .map(|text| {
            text.lines()
                .filter(|line| !line.trim().is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    lines.push(record.to_string());
    if lines.len() > DOOM_AGENT_ACTION_AUDIT_MAX_RECORDS {
        let excess = lines.len() - DOOM_AGENT_ACTION_AUDIT_MAX_RECORDS;
        lines.drain(..excess);
    }
    let mut content = lines.join("\n");
    content.push('\n');
    std::fs::write(&path, content)
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
    let audit_dir = super::decision::log_dir_from_env();

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
                            let result = engine_failure(&mut status, error.message);
                            observe(&status);
                            return result;
                        }
                    }
                }
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

        let mut adopted = false;
        match polled {
            Some(Poll::Ready(result)) => {
                pending = None;
                pending_ticks = 0;
                match result {
                    Ok(plan) => {
                        // An out-of-range legacy `Hold` step retains the bounded
                        // consecutive-failure stop (the native steps are already
                        // range-checked by the shared parser).
                        if let Err(detail) = validate_plan(&plan) {
                            if let Some(result) =
                                record_decision_failure(&mut status, config, detail)
                            {
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
                                executor.adopt(plan, &observation);
                                adopted = true;
                            } else {
                                // A plan is mid-execution: prefetch this one and
                                // adopt it on exhaustion/divergence WITHOUT
                                // interrupting the in-flight step (AC2).
                                next_plan = Some(plan);
                            }
                        }
                    }
                    Err(DoomDecisionError::Malformed(detail)) => {
                        if let Some(result) = record_decision_failure(&mut status, config, detail) {
                            observe(&status);
                            return result;
                        }
                        cooldown_ticks = backoff_ticks;
                    }
                    Err(DoomDecisionError::ModelUnavailable(_))
                    | Err(DoomDecisionError::TimedOut) => {
                        // Non-fatal (R-4): count it, maybe degrade, keep motion.
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
                    // Slower than the tick loop → abandon + degrade (R-4).
                    pending = None;
                    pending_ticks = 0;
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
        let plan_tick = executor.tick(&observation, &counters);
        if let Some(reason) = plan_tick.replan {
            if let Some(dir) = &audit_dir {
                let record = build_replan_audit_record(reason);
                if let Err(error) = append_action_audit(dir, &record) {
                    tracing::warn!(
                        target: "fredo::doom",
                        error = %error,
                        "could not append the Doom re-plan audit record"
                    );
                }
            }
            if let Some(plan) = next_plan.take() {
                executor.adopt(plan, &observation);
                adopted = true;
            }
        }
        status.plans = executor.plans();
        status.replans = executor.replans();
        status.plan_index = plan_tick.index;

        // 3c. Compose the effective intent. A NATIVE plan step is issued directly
        //     (guarded by the retained safety reflex); the LEGACY `Hold` step and
        //     the no-step fallback run through the retained reflex + unstick/escape
        //     + local-locomotion pipeline (composed, never replaced).
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
                observation = next;
            }
            Err(error) => {
                let result = engine_failure(&mut status, error.message);
                observe(&status);
                return result;
            }
        }

        // 5. Issued-action / reflex audit on adoption or override (G-273).
        if adopted || reflex_fired {
            if let Some(dir) = &audit_dir {
                let record = build_action_audit_record(
                    status.last_tic,
                    &effective,
                    reflex_fired,
                    status.degraded,
                );
                if let Err(error) = append_action_audit(dir, &record) {
                    tracing::warn!(
                        target: "fredo::doom",
                        error = %error,
                        "could not append the Doom action audit record"
                    );
                }
            }
        }

        // 6. Throttled status emission (terminal transitions emit above); a
        // degrade/recover transition always emits.
        if status.degraded != observed_degraded || budget_used.is_multiple_of(emit_interval) {
            observe(&status);
            observed_degraded = status.degraded;
        }

        // 7. Pace the next tick through the injected clock (R-5).
        let period = if status.degraded {
            config.degraded_tick_period
        } else {
            config.tick_period
        };
        pace(clock, period).await;
    }

    // The tick budget was reached cleanly — a bounded exit on every path (R-4).
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
    fn the_audit_record_carries_the_issued_escape_action_set() {
        let observation = json!({ "player": { "angle": 0 }, "walls": [] });
        let mut policy = DoomLocalPolicy {
            no_move_ticks: DOOM_ESCAPE_STUCK_TICKS,
            ..DoomLocalPolicy::default()
        };
        let intent = effective_intent(&observation, &[], 0, &mut policy, 1);
        let record = build_action_audit_record(Some(42), &intent, true, false);
        let actions = record["actions"].as_array().expect("issued actions array");
        assert!(actions.iter().any(|action| action["type"] == "turn-to"));
        assert!(actions.iter().any(|action| action["type"] == "forward"));
        assert_eq!(record["tic"], 42);
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
    fn action_audit_record_is_compact_and_the_jsonl_is_bounded() {
        let record = build_action_audit_record(
            Some(17),
            &[json!({ "type": "backward", "amount": 2 })],
            true,
            true,
        );
        assert_eq!(record["tic"], 17);
        assert_eq!(record["reflex"], true);
        assert_eq!(record["degraded"], true);
        assert_eq!(record["actions"][0]["type"], "backward");
        assert!(record["at"].as_str().map(|at| !at.is_empty()).unwrap_or(false));

        let dir = tempfile::tempdir().expect("tempdir");
        let total = DOOM_AGENT_ACTION_AUDIT_MAX_RECORDS + 5;
        for tic in 0..total {
            let record = build_action_audit_record(Some(tic as u64), &[], false, false);
            append_action_audit(dir.path(), &record).expect("append");
        }
        let text = std::fs::read_to_string(dir.path().join(DOOM_AGENT_ACTION_AUDIT_FILE))
            .expect("read audit");
        let lines: Vec<&str> = text.lines().filter(|line| !line.trim().is_empty()).collect();
        assert_eq!(lines.len(), DOOM_AGENT_ACTION_AUDIT_MAX_RECORDS);
        let last: Value = serde_json::from_str(lines[lines.len() - 1]).expect("last line JSON");
        assert_eq!(last["tic"], (total - 1) as u64);
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

        if crate::applications::doom::decision::max_steps_from_env().is_none()
            && crate::applications::doom::decision::max_failures_from_env().is_none()
        {
            let resolved = DoomAutoplayConfig::from_env();
            assert_eq!(resolved.max_ticks, default.max_ticks);
            assert_eq!(resolved.max_failures, default.max_failures);
        }
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
}
