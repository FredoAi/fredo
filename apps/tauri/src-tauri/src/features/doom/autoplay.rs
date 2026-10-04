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

/// Maximum number of advance steps a single autoplay run may issue.
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
    /// Total unusable decisions this run.
    pub failures: u32,
    /// Unusable decisions since the last success (reset to 0 on success).
    pub consecutive_failures: u32,
    /// The last observed engine tic, when known.
    pub last_tic: Option<u64>,
    /// The last observed engine outcome (e.g. `alive`, `dead`, `exited`).
    pub outcome: Option<String>,
    /// RFC3339 start timestamp of the run, when started.
    pub started_at: Option<String>,
    /// Human-readable failure detail, when the run failed.
    pub last_error: Option<String>,
    /// The typed failure code, when the run failed.
    pub code: Option<DoomAutoplayErrorCode>,
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
    }

    #[test]
    fn status_serializes_camel_case_fields() {
        let status = DoomAutoplayStatus {
            phase: DoomAutoplayPhase::Running,
            running: true,
            steps: 42,
            decisions: 42,
            failures: 1,
            consecutive_failures: 1,
            last_tic: Some(42),
            outcome: Some("alive".to_string()),
            started_at: Some("2026-01-01T00:00:00Z".to_string()),
            last_error: Some("boom".to_string()),
            code: Some(DoomAutoplayErrorCode::DecisionFailed),
        };
        let value = serde_json::to_value(&status).expect("serialize");
        assert_eq!(value["phase"], "running");
        assert_eq!(value["running"], true);
        assert_eq!(value["steps"], 42);
        assert_eq!(value["decisions"], 42);
        assert_eq!(value["failures"], 1);
        assert_eq!(value["consecutiveFailures"], 1);
        assert_eq!(value["lastTic"], 42);
        assert_eq!(value["outcome"], "alive");
        assert_eq!(value["startedAt"], "2026-01-01T00:00:00Z");
        assert_eq!(value["lastError"], "boom");
        assert_eq!(value["code"], "decisionFailed");
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
