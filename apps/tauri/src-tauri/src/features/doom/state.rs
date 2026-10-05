//! Doom runtime lifecycle state + shared contract (Spec #2968, ST-2).
//!
//! This module is the SINGLE producer of the Doom runtime contract every other
//! Doom sub-task compiles against: the managed-child handle, the Tauri-managed
//! state, the phase/error vocabularies, the launch/status wire models, the
//! bounded-timeout constants, and the AppStore/env keys.
//!
//! Nothing here performs I/O, spawns a process, or speaks HTTP — the lifecycle
//! ([`super::process`]) and the command surface ([`super::commands`]) consume
//! this shape. The engine is GPL and runs as an arm's-length separate process
//! over loopback; this module never links it.

use std::path::PathBuf;
use std::process::Child;
use std::sync::Mutex;

use serde::Serialize;

// ── Bounded-timeout constants (G-263: every wait is finite) ───────────────────
//
// Every start/stop/request wait in the Doom runtime is bounded by one of these.
// There is NO unbounded wait: a readiness timeout kills the child before
// returning, and a stop that outlives its bound is hard-killed.

/// Bounded readiness poll after spawn: the engine must answer before this many
/// seconds elapse, else the child is killed and `readyTimeout` is returned.
pub const DOOM_READY_TIMEOUT_S: u64 = 30;
/// Bound on the graceful stop before the hard-kill fallback fires.
pub const DOOM_STOP_TIMEOUT_S: u64 = 5;
/// Bound the synchronous `RunEvent::Exit` teardown may spend before hard-kill.
pub const DOOM_EXIT_HOOK_BOUND: u64 = 5;
/// Bound on a single engine HTTP request (ST-5 client).
pub const DOOM_REQUEST_TIMEOUT_S: u64 = 10;
/// Frame polling cadence for the `doom` window (~15 fps, ST-6).
pub const DOOM_FRAME_POLL_MS: u64 = 66;

// ── AppStore keys (AppStore remains the single source of truth) ───────────────

/// Absolute path to the resolved Doom engine executable.
pub const DOOM_ENGINE_PATH_KEY: &str = "doom_engine_path";
/// Absolute path to the game data (IWAD) the engine launches with.
pub const DOOM_IWAD_PATH_KEY: &str = "doom_iwad_path";
/// Directory holding the Doom runtime's staged artifacts + log.
pub const DOOM_INSTALL_DIR_KEY: &str = "doom_install_dir";
/// Configured (preferred) loopback port for the engine API.
pub const DOOM_PORT_KEY: &str = "doom_port";
/// Last runtime error message, surfaced by `get_doom_status`.
pub const DOOM_LAST_ERROR_KEY: &str = "doom_last_error";
/// Internal: PID of the managed engine process (orphan-sweep marker).
pub const DOOM_PID_KEY: &str = "doom_pid";
/// Internal: the typed code paired with [`DOOM_LAST_ERROR_KEY`].
pub const DOOM_LAST_ERROR_CODE_KEY: &str = "doom_last_error_code";
/// Persisted Doom resume point — the bounded `DoomSave` JSON in the control
/// plane (Spec #2972 ST-2). One fixed key; never an append log.
pub const DOOM_SAVE_KEY: &str = "doom_save_v1";

// ── G-275 env-override seams ──────────────────────────────────────────────────
//
// Every seam is inert when unset, so the production path is unchanged and QA can
// deterministically drive the error/lifecycle paths without a real engine.

/// Override the engine executable path (`doom_engine_path`).
pub const DOOM_ENGINE_PATH_ENV: &str = "FREDO_DOOM_ENGINE_PATH";
/// Override the IWAD path (`doom_iwad_path`).
pub const DOOM_IWAD_PATH_ENV: &str = "FREDO_DOOM_IWAD_PATH";
/// Override the install/scratch directory (`doom_install_dir`).
pub const DOOM_INSTALL_DIR_ENV: &str = "FREDO_DOOM_INSTALL_DIR";
/// Override the bounded readiness timeout, in seconds.
pub const DOOM_READY_TIMEOUT_ENV: &str = "FREDO_DOOM_READY_TIMEOUT_S";
/// Override the bounded graceful-stop timeout, in seconds.
pub const DOOM_STOP_TIMEOUT_ENV: &str = "FREDO_DOOM_STOP_TIMEOUT_S";
/// **G-275** anti-stub guard: when set to `1`, the launch path refuses an engine
/// whose basename is not [`DOOM_IMAGE_DEFAULT`] (`restful-doom.exe`). Inert when
/// unset, so the production path is unchanged.
pub const DOOM_REQUIRE_REAL_ENGINE_ENV: &str = "FREDO_DOOM_REQUIRE_REAL_ENGINE";

// ── Product defaults / identity ───────────────────────────────────────────────

/// Default subdirectory under the app data dir that holds Doom artifacts.
pub const DOOM_INSTALL_SUBDIR: &str = "doom";
/// The engine stdout/stderr log filename inside the install dir.
pub const DOOM_LOG_FILENAME: &str = "doom.log";
/// Default preferred port for the RESTful-DOOM API (OS-assigned fallback on use).
pub const DEFAULT_DOOM_PORT: u16 = 6666;
/// The window label hosting the Doom view (binding name, ST-6).
pub const DOOM_WINDOW_LABEL: &str = "doom";
/// The status-transition event the `doom` window subscribes to.
pub const DOOM_STATUS_EVENT: &str = "doom-status-changed";
/// Fallback expected image name for the PID-reuse guard when no engine path is
/// configured (the upstream RESTful-DOOM Windows binary).
pub const DOOM_IMAGE_DEFAULT: &str = "restful-doom.exe";

/// The engine launch argv prefix: deterministic lockstep API mode, no blit, no
/// audio. Followed by `-iwad <path>`, [`DOOM_LAUNCH_SUFFIX`], then
/// `-apiport <port>`.
pub const DOOM_LAUNCH_PREFIX: &[&str] = &["-apilockstep", "-noblit", "-nosound", "-nomusic"];
/// The engine launch argv suffix after the IWAD: a fixed Doom-1 warp
/// (`<episode> <map>`) and skill (ST-1 spike: `freedoom1.wad` is Phase 1).
pub const DOOM_LAUNCH_SUFFIX: &[&str] = &["-warp", "1", "1", "-skill", "3"];

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
            _ => None,
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

// ── Managed process + Tauri state ─────────────────────────────────────────────

/// A live Doom engine child managed by the runtime (at most ONE exists).
pub struct ManagedDoom {
    /// The spawned child; stdout/stderr are redirected to `log_path`.
    pub child: Child,
    /// OS process id, kept for the persisted PID marker + `taskkill`.
    pub pid: u32,
    /// The loopback port the engine was launched to bind.
    pub port: u16,
    /// Absolute path to the engine executable that was spawned (identity, G-033).
    pub engine_path: String,
    /// Absolute path to the engine's stdout/stderr log.
    pub log_path: PathBuf,
}

/// Tauri-managed wrapper around the single optional managed engine.
///
/// The `Mutex` only ever guards a short synchronous critical section (the
/// check→spawn→store launch decision / a state read) — it is NEVER held across
/// an `.await`.
#[derive(Default)]
pub struct DoomRuntimeState(pub Mutex<Option<ManagedDoom>>);

// ── Wire models (camelCase, IPC) ──────────────────────────────────────────────

/// Result of `launch_doom_runtime` — always returned, never a hang.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoomLaunchResult {
    /// Whether the engine is ready.
    pub success: bool,
    /// The phase after the launch attempt.
    pub phase: DoomRuntimePhase,
    /// The bound loopback port, once ready.
    pub port: Option<u16>,
    /// The managed engine PID, once ready.
    pub pid: Option<u32>,
    /// The resolved **absolute** engine executable path, once resolved.
    pub engine_path: Option<String>,
    /// Human-readable failure detail, when `success` is false.
    pub error: Option<String>,
    /// The typed failure code, when `success` is false.
    pub code: Option<DoomErrorCode>,
}

/// Read-only status snapshot (`get_doom_status` / `doom-status-changed`).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoomStatus {
    /// The current lifecycle phase.
    pub phase: DoomRuntimePhase,
    /// Whether a live managed child exists.
    pub running: bool,
    /// The bound loopback port, when running.
    pub port: Option<u16>,
    /// The managed engine PID, when running.
    pub pid: Option<u32>,
    /// The resolved **absolute** engine executable path, when running.
    pub engine_path: Option<String>,
    /// The last recorded error message, if any.
    pub last_error: Option<String>,
    /// The typed code paired with `last_error`, if any.
    pub code: Option<DoomErrorCode>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_state_holds_no_engine() {
        let state = DoomRuntimeState::default();
        let guard = state.0.lock().expect("state lock is not poisoned");
        assert!(guard.is_none());
    }

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
            port: None,
            pid: None,
            engine_path: None,
            error: Some("boom".to_string()),
            code: Some(DoomErrorCode::ReadyTimeout),
        };
        let value = serde_json::to_value(&result).expect("serialize");
        assert_eq!(value["success"], false);
        assert_eq!(value["phase"], "error");
        assert_eq!(value["code"], "readyTimeout");
        assert!(value["port"].is_null());
        assert!(value["enginePath"].is_null());

        let status = DoomStatus {
            phase: DoomRuntimePhase::Ready,
            running: true,
            port: Some(6666),
            pid: Some(4242),
            engine_path: Some(r"C:\app\doom\engine\restful-doom.exe".to_string()),
            last_error: None,
            code: None,
        };
        let value = serde_json::to_value(&status).expect("serialize");
        assert_eq!(value["phase"], "ready");
        assert_eq!(value["running"], true);
        assert_eq!(value["port"], 6666);
        assert_eq!(value["pid"], 4242);
        assert_eq!(
            value["enginePath"],
            r"C:\app\doom\engine\restful-doom.exe"
        );
        assert!(value["lastError"].is_null());
        assert!(value["code"].is_null());
    }

    #[test]
    fn the_binding_timeout_constants_are_pinned() {
        assert_eq!(DOOM_READY_TIMEOUT_S, 30);
        assert_eq!(DOOM_STOP_TIMEOUT_S, 5);
        assert_eq!(DOOM_EXIT_HOOK_BOUND, 5);
        assert_eq!(DOOM_REQUEST_TIMEOUT_S, 10);
        assert_eq!(DOOM_FRAME_POLL_MS, 66);
    }

    #[test]
    fn the_appstore_keys_and_seams_are_pinned() {
        assert_eq!(DOOM_ENGINE_PATH_KEY, "doom_engine_path");
        assert_eq!(DOOM_IWAD_PATH_KEY, "doom_iwad_path");
        assert_eq!(DOOM_INSTALL_DIR_KEY, "doom_install_dir");
        assert_eq!(DOOM_PORT_KEY, "doom_port");
        assert_eq!(DOOM_LAST_ERROR_KEY, "doom_last_error");
        assert_eq!(DOOM_ENGINE_PATH_ENV, "FREDO_DOOM_ENGINE_PATH");
        assert_eq!(DOOM_IWAD_PATH_ENV, "FREDO_DOOM_IWAD_PATH");
        assert_eq!(DOOM_INSTALL_DIR_ENV, "FREDO_DOOM_INSTALL_DIR");
        assert_eq!(DOOM_READY_TIMEOUT_ENV, "FREDO_DOOM_READY_TIMEOUT_S");
        assert_eq!(DOOM_STOP_TIMEOUT_ENV, "FREDO_DOOM_STOP_TIMEOUT_S");
        assert_eq!(
            DOOM_REQUIRE_REAL_ENGINE_ENV,
            "FREDO_DOOM_REQUIRE_REAL_ENGINE"
        );
        assert_eq!(DOOM_WINDOW_LABEL, "doom");
        assert_eq!(DOOM_STATUS_EVENT, "doom-status-changed");
    }
}
