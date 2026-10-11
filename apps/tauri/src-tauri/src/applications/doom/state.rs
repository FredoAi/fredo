//! Doom runtime lifecycle state + shared contract (Spec #2968, ST-2).
//!
//! This module is the SINGLE producer of the Doom runtime contract every other
//! Doom sub-task compiles against: the phase/error vocabularies, the
//! launch/status wire models, the bounded-timeout constants, and the AppStore/env
//! keys.
//!
//! Spec #3023 ST-2 moved the runtime onto the native in-process engine adapter
//! ([`super::engine`]); the `port` / `pid` / `enginePath` wire fields are dropped
//! and the native engine's typed failures are bridged onto [`DoomErrorCode`]
//! (see the `From<DoomEngineErrorCode>` impl).
//!
//! Spec #3023 ST-6 removed the out-of-process surface (`ManagedDoom` /
//! `DoomRuntimeState`) together with the loopback HTTP client, the supervised
//! child process, and the from-source provisioning. The native engine runs
//! in-process; teardown is take-and-drop.

use serde::Serialize;

use super::engine::DoomEngineErrorCode;

// ── Bounded-timeout constants (G-263: every wait is finite) ───────────────────
//
// The Doom runtime's waits are bounded; there is no unbounded wait.

/// Bounded readiness poll: the engine must become ready before this many
/// seconds elapse, else `readyTimeout` is returned.
pub const DOOM_READY_TIMEOUT_S: u64 = 30;
/// Bound on a bounded stop before the teardown fallback fires.
pub const DOOM_STOP_TIMEOUT_S: u64 = 5;
/// Bound the synchronous `RunEvent::Exit` teardown may spend.
pub const DOOM_EXIT_HOOK_BOUND: u64 = 5;
/// Bound on a single engine request.
pub const DOOM_REQUEST_TIMEOUT_S: u64 = 10;

// ── AppStore keys (AppStore remains the single source of truth) ───────────────

/// Last runtime error message, surfaced by `get_doom_status`.
pub const DOOM_LAST_ERROR_KEY: &str = "doom_last_error";
/// Internal: the typed code paired with [`DOOM_LAST_ERROR_KEY`].
pub const DOOM_LAST_ERROR_CODE_KEY: &str = "doom_last_error_code";

// ── Product defaults / identity ───────────────────────────────────────────────

/// The window label hosting the Doom view (binding name).
pub const DOOM_WINDOW_LABEL: &str = "doom";
/// The status-transition event the `doom` window subscribes to.
pub const DOOM_STATUS_EVENT: &str = "doom-status-changed";

// ── Lifecycle phase vocabulary ────────────────────────────────────────────────

/// The Doom runtime lifecycle phase (binding enum; camelCase over IPC).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DoomRuntimePhase {
    /// No managed engine process.
    Idle,
    /// A launch is in flight (spawned, awaiting readiness).
    Starting,
    /// The engine is spawned and readiness-confirmed.
    Ready,
    /// A bounded stop is in flight.
    Stopping,
    /// The last lifecycle action failed; `last_error`/`code` describe why.
    Error,
}

/// The typed failure vocabulary (binding enum; camelCase over IPC).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DoomErrorCode {
    /// No engine executable or IWAD is configured/resolvable.
    NotConfigured,
    /// The engine/IWAD could not be acquired.
    AcquireFailed,
    /// The engine process failed to spawn.
    SpawnFailed,
    /// The engine did not become ready within `DOOM_READY_TIMEOUT_S` (killed).
    ReadyTimeout,
    /// The engine survived `DOOM_STOP_TIMEOUT_S` and was hard-killed.
    StopTimeout,
    /// An engine HTTP request failed (ST-5 client).
    RequestFailed,
    /// The engine is serving but its graphics are not up yet (`GET /api/frame`
    /// returned HTTP 503). **Transient** — the frame loop keeps polling and the
    /// window never enters the `error` phase.
    FrameNotReady,
    /// Spec #3023 ST-2: the bundled game data (`DOOM1.WAD`) was not found at the
    /// resolved path. Mirrors [`DoomEngineErrorCode::WadMissing`] on the wire.
    WadMissing,
    /// Spec #3023 ST-2: the bundled game data exists but could not be read or
    /// parsed as a valid IWAD. Mirrors [`DoomEngineErrorCode::WadCorrupt`].
    WadCorrupt,
    /// Spec #3023 ST-2: the native in-process engine failed to start or a level
    /// could not be loaded. Mirrors [`DoomEngineErrorCode::EngineStartFailed`].
    EngineStartFailed,
}

impl DoomErrorCode {
    /// The stable wire string (matches `#[serde(rename_all = "camelCase")]`).
    pub fn as_str(self) -> &'static str {
        match self {
            DoomErrorCode::NotConfigured => "notConfigured",
            DoomErrorCode::AcquireFailed => "acquireFailed",
            DoomErrorCode::SpawnFailed => "spawnFailed",
            DoomErrorCode::ReadyTimeout => "readyTimeout",
            DoomErrorCode::StopTimeout => "stopTimeout",
            DoomErrorCode::RequestFailed => "requestFailed",
            DoomErrorCode::FrameNotReady => "frameNotReady",
            DoomErrorCode::WadMissing => "wadMissing",
            DoomErrorCode::WadCorrupt => "wadCorrupt",
            DoomErrorCode::EngineStartFailed => "engineStartFailed",
        }
    }

    /// Parse the persisted wire string back to the typed code (`None` when
    /// blank/unknown, e.g. an upgraded install with a stale value).
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim() {
            "notConfigured" => Some(DoomErrorCode::NotConfigured),
            "acquireFailed" => Some(DoomErrorCode::AcquireFailed),
            "spawnFailed" => Some(DoomErrorCode::SpawnFailed),
            "readyTimeout" => Some(DoomErrorCode::ReadyTimeout),
            "stopTimeout" => Some(DoomErrorCode::StopTimeout),
            "requestFailed" => Some(DoomErrorCode::RequestFailed),
            "frameNotReady" => Some(DoomErrorCode::FrameNotReady),
            "wadMissing" => Some(DoomErrorCode::WadMissing),
            "wadCorrupt" => Some(DoomErrorCode::WadCorrupt),
            "engineStartFailed" => Some(DoomErrorCode::EngineStartFailed),
            _ => None,
        }
    }
}

/// Bridge the native engine adapter's typed failure vocabulary
/// ([`DoomEngineErrorCode`]) onto the shared wire vocabulary ([`DoomErrorCode`]).
///
/// The three native classes are the UI/UX-bound error surface
/// (`wadMissing` / `wadCorrupt` / `engineStartFailed`); this `From` impl is the
/// single mapping so the command layer never re-derives the code strings.
impl From<DoomEngineErrorCode> for DoomErrorCode {
    fn from(code: DoomEngineErrorCode) -> Self {
        match code {
            DoomEngineErrorCode::WadMissing => DoomErrorCode::WadMissing,
            DoomEngineErrorCode::WadCorrupt => DoomErrorCode::WadCorrupt,
            DoomEngineErrorCode::EngineStartFailed => DoomErrorCode::EngineStartFailed,
        }
    }
}

/// Pure phase derivation for the status snapshot: a live child is `Ready`; else a
/// recorded error is `Error`; else `Idle`. The transient `Starting`/`Stopping`
/// phases are emitted as events by the lifecycle commands.
pub fn derive_phase(running: bool, has_error: bool) -> DoomRuntimePhase {
    if running {
        DoomRuntimePhase::Ready
    } else if has_error {
        DoomRuntimePhase::Error
    } else {
        DoomRuntimePhase::Idle
    }
}

// ── Wire models (camelCase, IPC) ──────────────────────────────────────────────

/// Result of `launch_doom_runtime` — always returned, never a hang.
///
/// Spec #3023 ST-2: the out-of-process surface is gone, so the process-only
/// fields (`port` / `pid` / `enginePath`) are DROPPED — the native engine runs
/// in-process with no child and no loopback port.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoomLaunchResult {
    /// Whether the engine is ready.
    pub success: bool,
    /// The phase after the launch attempt.
    pub phase: DoomRuntimePhase,
    /// Human-readable failure detail, when `success` is false.
    pub error: Option<String>,
    /// The typed failure code, when `success` is false.
    pub code: Option<DoomErrorCode>,
}

/// Read-only status snapshot (`get_doom_status` / `doom-status-changed`).
///
/// Spec #3023 ST-2: `port` / `pid` / `enginePath` are dropped (in-process engine).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoomStatus {
    /// The current lifecycle phase.
    pub phase: DoomRuntimePhase,
    /// Whether a live session exists.
    pub running: bool,
    /// The last recorded error message, if any.
    pub last_error: Option<String>,
    /// The typed code paired with `last_error`, if any.
    pub code: Option<DoomErrorCode>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phases_serialize_camel_case() {
        let cases = [
            (DoomRuntimePhase::Idle, "\"idle\""),
            (DoomRuntimePhase::Starting, "\"starting\""),
            (DoomRuntimePhase::Ready, "\"ready\""),
            (DoomRuntimePhase::Stopping, "\"stopping\""),
            (DoomRuntimePhase::Error, "\"error\""),
        ];
        for (phase, expected) in cases {
            assert_eq!(serde_json::to_string(&phase).expect("serialize"), expected);
        }
    }

    #[test]
    fn error_codes_serialize_and_parse_round_trip() {
        let all = [
            DoomErrorCode::NotConfigured,
            DoomErrorCode::AcquireFailed,
            DoomErrorCode::SpawnFailed,
            DoomErrorCode::ReadyTimeout,
            DoomErrorCode::StopTimeout,
            DoomErrorCode::RequestFailed,
            DoomErrorCode::FrameNotReady,
            DoomErrorCode::WadMissing,
            DoomErrorCode::WadCorrupt,
            DoomErrorCode::EngineStartFailed,
        ];
        for code in all {
            let wire = serde_json::to_string(&code).expect("serialize");
            assert_eq!(wire, format!("\"{}\"", code.as_str()));
            assert_eq!(DoomErrorCode::parse(code.as_str()), Some(code));
        }
        // Unknown / blank persisted values never panic.
        assert_eq!(DoomErrorCode::parse(""), None);
        assert_eq!(DoomErrorCode::parse("  nope  "), None);
    }

    #[test]
    fn derive_phase_prefers_a_live_child_over_a_stale_error() {
        assert_eq!(derive_phase(true, false), DoomRuntimePhase::Ready);
        assert_eq!(derive_phase(true, true), DoomRuntimePhase::Ready);
        assert_eq!(derive_phase(false, true), DoomRuntimePhase::Error);
        assert_eq!(derive_phase(false, false), DoomRuntimePhase::Idle);
    }

    #[test]
    fn launch_result_and_status_serialize_camel_case() {
        let result = DoomLaunchResult {
            success: false,
            phase: DoomRuntimePhase::Error,
            error: Some("boom".to_string()),
            code: Some(DoomErrorCode::EngineStartFailed),
        };
        let value = serde_json::to_value(&result).expect("serialize");
        assert_eq!(value["success"], false);
        assert_eq!(value["phase"], "error");
        assert_eq!(value["code"], "engineStartFailed");
        // The process-only fields are dropped (no child, no port).
        assert!(value.get("port").is_none());
        assert!(value.get("pid").is_none());
        assert!(value.get("enginePath").is_none());

        let status = DoomStatus {
            phase: DoomRuntimePhase::Ready,
            running: true,
            last_error: None,
            code: None,
        };
        let value = serde_json::to_value(&status).expect("serialize");
        assert_eq!(value["phase"], "ready");
        assert_eq!(value["running"], true);
        assert!(value["lastError"].is_null());
        assert!(value["code"].is_null());
        assert!(value.get("port").is_none());
        assert!(value.get("pid").is_none());
        assert!(value.get("enginePath").is_none());
    }

    #[test]
    fn native_engine_error_codes_bridge_onto_the_wire_vocabulary() {
        assert_eq!(
            DoomErrorCode::from(DoomEngineErrorCode::WadMissing),
            DoomErrorCode::WadMissing
        );
        assert_eq!(
            DoomErrorCode::from(DoomEngineErrorCode::WadCorrupt),
            DoomErrorCode::WadCorrupt
        );
        assert_eq!(
            DoomErrorCode::from(DoomEngineErrorCode::EngineStartFailed),
            DoomErrorCode::EngineStartFailed
        );
        // The wire strings are the camelCase codes the UI/UX + QA classes bind to.
        assert_eq!(DoomErrorCode::WadMissing.as_str(), "wadMissing");
        assert_eq!(DoomErrorCode::WadCorrupt.as_str(), "wadCorrupt");
        assert_eq!(DoomErrorCode::EngineStartFailed.as_str(), "engineStartFailed");
    }

    #[test]
    fn the_binding_timeout_constants_are_pinned() {
        assert_eq!(DOOM_READY_TIMEOUT_S, 30);
        assert_eq!(DOOM_STOP_TIMEOUT_S, 5);
        assert_eq!(DOOM_EXIT_HOOK_BOUND, 5);
        assert_eq!(DOOM_REQUEST_TIMEOUT_S, 10);
    }

    #[test]
    fn the_appstore_keys_and_identity_are_pinned() {
        assert_eq!(DOOM_LAST_ERROR_KEY, "doom_last_error");
        assert_eq!(DOOM_LAST_ERROR_CODE_KEY, "doom_last_error_code");
        assert_eq!(DOOM_WINDOW_LABEL, "doom");
        assert_eq!(DOOM_STATUS_EVENT, "doom-status-changed");
    }
}
