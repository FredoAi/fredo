//! Doom autoplay contract (Spec #2969, ST-2).
//!
//! This module is the SINGLE producer of the autoplay wire contract every other
//! Doom sub-task compiles against (G-255): the lifecycle phase vocabulary, the
//! typed failure vocabulary, the status/result wire models, and the bounded
//! budget constants. It holds NO loop logic and performs no I/O.
//!
//! The enums serialize **camelCase over IPC** — the convergence adjudication for
//! this slice, matching the `DoomRuntimePhase`/`DoomErrorCode` precedent in
//! [`super::state`]. The wire values are pinned by unit test.
//!
//! Consumers:
//! * ST-3 (loop) — budgets + status construction,
//! * ST-4 (model source) — the status/result shape,
//! * ST-5 (commands) — the wire models + event payload,
//! * ST-7 (UI) — mirrors these names verbatim in TypeScript.

use serde::Serialize;

// ── Bounded budgets (G-263: every wait/budget is finite) ─────────────────────

/// The classic Doom continuous simulation rate (ticks/s) the continuous loop
/// targets (Spec #3026 lever A). The nominal tick period is
/// [`super::clock::DOOM_CONTINUOUS_TICK_PERIOD_MS`].
pub const DOOM_CONTINUOUS_RATE_HZ: u32 = 35;

/// Maximum number of advance steps a single autoplay run may issue.
///
/// Retained for the legacy decision-gated loop; the continuous loop bounds
/// itself on [`super::clock::DOOM_CONTINUOUS_MAX_TICKS`] instead.
pub const DOOM_AUTOPLAY_MAX_STEPS: u32 = 600;
/// Maximum consecutive decision failures before the run stops with a typed error.
pub const DOOM_AUTOPLAY_MAX_FAILURES: u32 = 3;
/// Bound on a single decision, in seconds (the per-decision timeout).
pub const DOOM_AUTOPLAY_DECISION_TIMEOUT_S: u64 = 30;
/// Engine tics advanced per step (the lockstep step granularity).
pub const DOOM_AUTOPLAY_STEP_TICS: i64 = 1;
/// Backoff between a failed decision and the retry, in milliseconds.
pub const DOOM_AUTOPLAY_FAILURE_BACKOFF_MS: u64 = 250;

// ── Lifecycle phase + failure vocabulary ─────────────────────────────────────

/// The Doom autoplay lifecycle phase (binding enum; camelCase over IPC).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DoomAutoplayPhase {
    /// No autoplay run is active.
    Idle,
    /// A run is in flight.
    Running,
    /// A bounded cooperative stop is in flight.
    Stopping,
    /// The run reached its step budget cleanly.
    Completed,
    /// The run stopped on a typed failure.
    Failed,
}

/// The typed autoplay failure vocabulary (binding enum; camelCase over IPC).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DoomAutoplayErrorCode {
    /// The engine was not ready to accept autoplay.
    NotReady,
    /// The decision source could not produce a usable decision within the
    /// consecutive-failure budget.
    DecisionFailed,
    /// An engine HTTP request failed during the run.
    EngineRequestFailed,
    /// The run reached its total step budget.
    BudgetExhausted,
    /// The campaign's final level was exited — the whole game is complete
    /// (Spec #2972 R-3).
    CampaignComplete,
}

// ── Wire models (camelCase, IPC) ─────────────────────────────────────────────

/// The autoplay status snapshot — the `doom-autoplay-changed` event payload and
/// the return of `get_doom_autoplay_status` (ST-5).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoomAutoplayStatus {
    /// The current lifecycle phase.
    pub phase: DoomAutoplayPhase,
    /// Whether a run is active (convenience mirror of `phase == Running`).
    pub running: bool,
    /// Total advance steps issued this run.
    pub steps: u32,
    /// Total decisions obtained this run.
    pub decisions: u32,
    /// Total escape maneuvers issued this run (Spec #3031 ST-2).
    pub escapes: u32,
    /// Total unusable decisions this run.
    pub failures: u32,
    /// Unusable decisions since the last success (reset to 0 on success).
    pub consecutive_failures: u32,
    /// The current consecutive no-move tick streak (Spec #3031 ST-2): the number
    /// of successive ticks over which the player's position has not changed.
    pub stuck_ticks: u32,
    /// Total plans obtained this run (Spec #3039 ST-4, AC2/AC3).
    pub plans: u32,
    /// Total re-plans requested this run (Spec #3039 ST-4, AC3).
    pub replans: u32,
    /// The current plan-step index (Spec #3039 ST-4, AC2).
    pub plan_index: u32,
    /// The last observed engine tic, when known.
    pub last_tic: Option<u64>,
    /// The last observed engine outcome (e.g. `alive`, `dead`, `exited`).
    pub outcome: Option<String>,
    /// The campaign episode currently being played (Spec #2972 R-3), when known.
    pub episode: Option<i64>,
    /// The campaign map currently being played (Spec #2972 R-3), when known.
    pub map: Option<i64>,
    /// Whether the campaign reached its final level and completed (R-3).
    pub completed: bool,
    /// Whether the continuous loop has degraded its pacing because the decision
    /// source is unavailable or slower than the tick loop (Spec #3026 R-4).
    pub degraded: bool,
    /// RFC3339 start timestamp of the run, when started.
    pub started_at: Option<String>,
    /// Human-readable failure detail, when the run failed.
    pub last_error: Option<String>,
    /// The typed failure code, when the run failed.
    pub code: Option<DoomAutoplayErrorCode>,
    /// Total enemy kills observed this run: a read-only projection of the engine
    /// observation's `level.kills`. Additive field — existing fields keep their
    /// order and serde names.
    ///
    /// DEAD OBSERVABLE (Spec #3053 AC2 amendment, Option D): the pinned
    /// `neurodoom 0.6.7` never increments `PlayerState.kill_count`, so this is
    /// permanently `0`. It is an additive/always-`0` telemetry signal, **not** an
    /// AC — never assert it non-zero and never re-target it in a later cycle.
    pub kills: i64,
    /// Total engaged ticks this run (Spec #3053 ST-2): the combat policy's
    /// per-run engagement count. An observability signal carried on the wire.
    pub engagements: u32,
}

/// Result of `start_doom_autoplay` — always returned, never a hang.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoomAutoplayResult {
    /// Whether the run was started successfully.
    pub success: bool,
    /// The phase after the start attempt.
    pub phase: DoomAutoplayPhase,
    /// Steps completed when the result was produced.
    pub steps: u32,
    /// The typed failure code, when `success` is false.
    pub code: Option<DoomAutoplayErrorCode>,
    /// Human-readable failure detail, when `success` is false.
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn autoplay_phases_serialize_camel_case() {
        let cases = [
            (DoomAutoplayPhase::Idle, "\"idle\""),
            (DoomAutoplayPhase::Running, "\"running\""),
            (DoomAutoplayPhase::Stopping, "\"stopping\""),
            (DoomAutoplayPhase::Completed, "\"completed\""),
            (DoomAutoplayPhase::Failed, "\"failed\""),
        ];
        for (phase, expected) in cases {
            assert_eq!(serde_json::to_string(&phase).expect("serialize"), expected);
        }
    }

    #[test]
    fn autoplay_error_codes_serialize_camel_case() {
        let cases = [
            (DoomAutoplayErrorCode::NotReady, "\"notReady\""),
            (DoomAutoplayErrorCode::DecisionFailed, "\"decisionFailed\""),
            (
                DoomAutoplayErrorCode::EngineRequestFailed,
                "\"engineRequestFailed\"",
            ),
            (DoomAutoplayErrorCode::BudgetExhausted, "\"budgetExhausted\""),
            (
                DoomAutoplayErrorCode::CampaignComplete,
                "\"campaignComplete\"",
            ),
        ];
        for (code, expected) in cases {
            assert_eq!(serde_json::to_string(&code).expect("serialize"), expected);
        }
    }

    #[test]
    fn the_binding_budgets_are_pinned() {
        assert_eq!(DOOM_AUTOPLAY_MAX_STEPS, 600);
        assert_eq!(DOOM_AUTOPLAY_MAX_FAILURES, 3);
        assert_eq!(DOOM_AUTOPLAY_DECISION_TIMEOUT_S, 30);
        assert_eq!(DOOM_AUTOPLAY_STEP_TICS, 1);
        assert_eq!(DOOM_AUTOPLAY_FAILURE_BACKOFF_MS, 250);
        // Spec #3026 lever A — the continuous sim rate.
        assert_eq!(DOOM_CONTINUOUS_RATE_HZ, 35);
    }

    #[test]
    fn status_serializes_camel_case_fields() {
        let status = DoomAutoplayStatus {
            phase: DoomAutoplayPhase::Running,
            running: true,
            steps: 42,
            decisions: 42,
            escapes: 5,
            failures: 1,
            consecutive_failures: 1,
            stuck_ticks: 3,
            plans: 2,
            replans: 1,
            plan_index: 4,
            last_tic: Some(42),
            outcome: Some("alive".to_string()),
            episode: Some(2),
            map: Some(3),
            completed: false,
            degraded: true,
            started_at: Some("2026-01-01T00:00:00Z".to_string()),
            last_error: Some("boom".to_string()),
            code: Some(DoomAutoplayErrorCode::DecisionFailed),
            kills: 9,
            engagements: 4,
        };
        let value = serde_json::to_value(&status).expect("serialize");
        assert_eq!(value["phase"], "running");
        assert_eq!(value["running"], true);
        assert_eq!(value["steps"], 42);
        assert_eq!(value["decisions"], 42);
        assert_eq!(value["escapes"], 5);
        assert_eq!(value["failures"], 1);
        assert_eq!(value["consecutiveFailures"], 1);
        assert_eq!(value["stuckTicks"], 3);
        assert_eq!(value["plans"], 2);
        assert_eq!(value["replans"], 1);
        assert_eq!(value["planIndex"], 4);
        assert_eq!(value["lastTic"], 42);
        assert_eq!(value["outcome"], "alive");
        assert_eq!(value["episode"], 2);
        assert_eq!(value["map"], 3);
        assert_eq!(value["completed"], false);
        assert_eq!(value["degraded"], true);
        assert_eq!(value["startedAt"], "2026-01-01T00:00:00Z");
        assert_eq!(value["lastError"], "boom");
        assert_eq!(value["code"], "decisionFailed");
        assert_eq!(value["kills"], 9);
        assert_eq!(value["engagements"], 4);
    }

    #[test]
    fn result_serializes_camel_case_fields() {
        let result = DoomAutoplayResult {
            success: false,
            phase: DoomAutoplayPhase::Failed,
            steps: 7,
            code: Some(DoomAutoplayErrorCode::NotReady),
            error: Some("engine not ready".to_string()),
        };
        let value = serde_json::to_value(&result).expect("serialize");
        assert_eq!(value["success"], false);
        assert_eq!(value["phase"], "failed");
        assert_eq!(value["steps"], 7);
        assert_eq!(value["code"], "notReady");
        assert_eq!(value["error"], "engine not ready");
    }
}
