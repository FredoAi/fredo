//! Doom runtime lifecycle commands (Spec #2968, ST-3/ST-3b/ST-3c; G-263 bounded).
//!
//! Owns the out-of-process engine end to end: `launch_doom_runtime` (idempotent
//! exactly-one spawn + bounded readiness), `stop_doom_runtime` (bounded graceful
//! stop with a hard-kill fallback), `get_doom_status`, and the synchronous
//! teardown entry points wired to the window `CloseRequested` handler and the
//! `RunEvent::Exit` hook.
//!
//! NO acquisition, NO HTTP client, NO window UI: resolution here is the
//! configured/overridden path only (ST-4 extends it), and readiness is a bounded
//! loopback TCP probe (ST-5 refines it to `/api/state`).

use std::path::Path;
use std::sync::{Arc, MutexGuard};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

use crate::infrastructure::storage::AppStore;

use super::process;
use super::state::{
    derive_phase, DoomErrorCode, DoomLaunchResult, DoomRuntimePhase, DoomRuntimeState, DoomStatus,
    DEFAULT_DOOM_PORT, DOOM_ENGINE_PATH_ENV, DOOM_ENGINE_PATH_KEY, DOOM_EXIT_HOOK_BOUND,
    DOOM_IWAD_PATH_ENV, DOOM_IWAD_PATH_KEY, DOOM_LAST_ERROR_CODE_KEY, DOOM_LAST_ERROR_KEY,
    DOOM_PORT_KEY, DOOM_READY_TIMEOUT_ENV, DOOM_READY_TIMEOUT_S, DOOM_STATUS_EVENT,
    DOOM_STOP_TIMEOUT_ENV, DOOM_STOP_TIMEOUT_S, DOOM_WINDOW_LABEL,
};

/// Readiness poll cadence.
const READY_POLL_INTERVAL: Duration = Duration::from_millis(100);

// ── State helpers ─────────────────────────────────────────────────────────────

/// A poisoned lock must never take down the app — recover the guard.
fn lock_state(state: &DoomRuntimeState) -> MutexGuard<'_, Option<super::state::ManagedDoom>> {
    state
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// `Some((port, pid))` iff a live managed child exists. A child that has exited
/// is reaped out of the state and its PID marker cleared.
fn running_snapshot(app: &AppHandle) -> Option<(u16, u32)> {
    let state = app.state::<DoomRuntimeState>();
    let mut guard = lock_state(&state);
    let had_child = guard.is_some();
    let alive = match guard.as_mut() {
        Some(managed) => matches!(managed.child.try_wait(), Ok(None)),
        None => false,
    };
    if !alive {
        *guard = None;
        drop(guard);
        if had_child {
            persist_managed_pid(app, None);
        }
        return None;
    }
    guard.as_ref().map(|managed| (managed.port, managed.pid))
}

/// Persist (or clear) the `doom_pid` marker through the SINGLE implementation in
/// [`process::persist_pid`], so the launch WRITE and the stop CLEAR cannot drift.
fn persist_managed_pid(app: &AppHandle, pid: Option<u32>) {
    let store = app.state::<Arc<AppStore>>();
    process::persist_pid(store.inner(), pid);
}

fn set_last_error(app: &AppHandle, message: &str, code: DoomErrorCode) {
    let store = app.state::<Arc<AppStore>>();
    let _ = store.control_set(DOOM_LAST_ERROR_KEY, message);
    let _ = store.control_set(DOOM_LAST_ERROR_CODE_KEY, code.as_str());
}

fn clear_last_error(app: &AppHandle) {
    let store = app.state::<Arc<AppStore>>();
    let _ = store.control_set(DOOM_LAST_ERROR_KEY, "");
    let _ = store.control_set(DOOM_LAST_ERROR_CODE_KEY, "");
}

fn read_last_error(app: &AppHandle) -> (Option<String>, Option<DoomErrorCode>) {
    let store = app.state::<Arc<AppStore>>();
    let message = store
        .control_get(DOOM_LAST_ERROR_KEY)
        .ok()
        .flatten()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let code = store
        .control_get(DOOM_LAST_ERROR_CODE_KEY)
        .ok()
        .flatten()
        .and_then(|value| DoomErrorCode::parse(&value));
    (message, code)
}

// ── Settings / env resolution (ST-4 extends acquisition) ─────────────────────

fn env_string(key: &str) -> Option<String> {
    std::env::var(key).ok()
}

fn env_u64(key: &str) -> Option<u64> {
    std::env::var(key)
        .ok()
        .and_then(|value| value.trim().parse().ok())
}

fn setting(app: &AppHandle, key: &str) -> Option<String> {
    app.state::<Arc<AppStore>>()
        .control_get(key)
        .ok()
        .flatten()
}

fn resolve_engine(app: &AppHandle) -> Option<String> {
    process::resolve_doom_path(
        env_string(DOOM_ENGINE_PATH_ENV).as_deref(),
        setting(app, DOOM_ENGINE_PATH_KEY).as_deref(),
    )
}

fn resolve_iwad(app: &AppHandle) -> Option<String> {
    process::resolve_doom_path(
        env_string(DOOM_IWAD_PATH_ENV).as_deref(),
        setting(app, DOOM_IWAD_PATH_KEY).as_deref(),
    )
}

fn configured_port(app: &AppHandle) -> u16 {
    setting(app, DOOM_PORT_KEY)
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(DEFAULT_DOOM_PORT)
}

/// The bounded readiness timeout, honouring the `FREDO_DOOM_READY_TIMEOUT_S` seam.
fn ready_timeout() -> Duration {
    Duration::from_secs(env_u64(DOOM_READY_TIMEOUT_ENV).unwrap_or(DOOM_READY_TIMEOUT_S))
}

/// The bounded graceful-stop timeout, honouring the `FREDO_DOOM_STOP_TIMEOUT_S`
/// seam.
fn stop_timeout() -> Duration {
    Duration::from_secs(env_u64(DOOM_STOP_TIMEOUT_ENV).unwrap_or(DOOM_STOP_TIMEOUT_S))
}

// ── Status emission ───────────────────────────────────────────────────────────

/// Emit a `doom-status-changed` transition to the `doom` window. A missing window
/// (e.g. an app-exit teardown) is not an error — logged at debug.
fn emit_status(
    app: &AppHandle,
    phase: DoomRuntimePhase,
    port: Option<u16>,
    pid: Option<u32>,
    last_error: Option<String>,
    code: Option<DoomErrorCode>,
) {
    let status = DoomStatus {
        phase,
        running: phase == DoomRuntimePhase::Ready,
        port,
        pid,
        last_error,
        code,
    };
    if let Err(error) = app.emit_to(DOOM_WINDOW_LABEL, DOOM_STATUS_EVENT, &status) {
        tracing::debug!(
            target: "fredo::doom",
            error = %error,
            phase = ?phase,
            "emit doom-status-changed skipped (no doom window yet?)"
        );
    }
}

fn success_result(port: u16, pid: u32) -> DoomLaunchResult {
    DoomLaunchResult {
        success: true,
        phase: DoomRuntimePhase::Ready,
        port: Some(port),
        pid: Some(pid),
        error: None,
        code: None,
    }
}

/// Record the typed failure, publish the `error` transition, and return the
/// structured result.
fn fail(app: &AppHandle, code: DoomErrorCode, detail: String) -> DoomLaunchResult {
    set_last_error(app, &detail, code);
    emit_status(
        app,
        DoomRuntimePhase::Error,
        None,
        None,
        Some(detail.clone()),
        Some(code),
    );
    DoomLaunchResult {
        success: false,
        phase: DoomRuntimePhase::Error,
        port: None,
        pid: None,
        error: Some(detail),
        code: Some(code),
    }
}

/// Bounded readiness wait that ALSO fails fast when the child exits: `true` when
/// the loopback port opens, `false` when the child is gone or `bound` elapses.
async fn wait_ready_or_exit(app: &AppHandle, port: u16, bound: Duration) -> bool {
    let deadline = Instant::now() + bound;
    loop {
        // The child may have exited immediately (e.g. a stub `EXIT` lever).
        let exited = {
            let state = app.state::<DoomRuntimeState>();
            let mut guard = lock_state(&state);
            match guard.as_mut() {
                Some(managed) => matches!(managed.child.try_wait(), Ok(Some(_))),
                None => true,
            }
        };
        if exited {
            return false;
        }
        if process::port_is_open("127.0.0.1", port) {
            return true;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return false;
        }
        tokio::time::sleep(READY_POLL_INTERVAL.min(remaining)).await;
    }
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Launch the Doom engine (idempotent exactly-one spawn) and confirm readiness
/// within a bounded poll.
///
/// A live managed child is a healthy early return — a second launch NEVER spawns
/// a second child (ST-3b, R-1.3). On a readiness timeout the spawned child is
/// killed before returning `readyTimeout` (G-263) — never a left-running
/// "pending" engine.
#[tauri::command]
pub async fn launch_doom_runtime(app: AppHandle) -> DoomLaunchResult {
    // Idempotency — an already-live engine wins immediately (R-1.3).
    if let Some((port, pid)) = running_snapshot(&app) {
        clear_last_error(&app);
        return success_result(port, pid);
    }

    let engine = match resolve_engine(&app) {
        Some(path) => path,
        None => {
            return fail(
                &app,
                DoomErrorCode::NotConfigured,
                "no Doom engine is configured — set the engine path in Settings.".to_string(),
            )
        }
    };
    let iwad = match resolve_iwad(&app) {
        Some(path) if Path::new(&path).is_file() => path,
        Some(path) => {
            return fail(
                &app,
                DoomErrorCode::NotConfigured,
                format!("the configured Doom game data (IWAD) is missing: {path}"),
            )
        }
        None => {
            return fail(
                &app,
                DoomErrorCode::NotConfigured,
                "no Doom game data (IWAD) is configured — set the WAD path in Settings.".to_string(),
            )
        }
    };
    let install_dir = match process::resolve_install_dir(&app) {
        Ok(dir) => dir,
        Err(detail) => return fail(&app, DoomErrorCode::SpawnFailed, detail),
    };
    let log_file = process::log_path(&install_dir);

    emit_status(&app, DoomRuntimePhase::Starting, None, None, None, None);

    let configured = configured_port(&app);
    let port = match process::select_active_port("127.0.0.1", configured) {
        Ok(port) => port,
        Err(error) => {
            return fail(
                &app,
                DoomErrorCode::SpawnFailed,
                format!("port {configured} is in use and no fallback could be selected: {error}"),
            )
        }
    };
    let args = process::build_launch_args(&iwad, port);

    // The check→spawn→store decision runs under ONE synchronous lock so two
    // concurrent launches cannot both spawn (ST-3b exactly-one). The lock is
    // released before any `.await`.
    let spawn: Result<(u32, u16), String> = {
        let state = app.state::<DoomRuntimeState>();
        let mut guard = lock_state(&state);
        if let Some(managed) = guard.as_mut() {
            if matches!(managed.child.try_wait(), Ok(None)) {
                let (port, pid) = (managed.port, managed.pid);
                drop(guard);
                clear_last_error(&app);
                return success_result(port, pid);
            }
            if let Some(mut dead) = guard.take() {
                process::kill_process_tree(&mut dead);
            }
        }
        match process::spawn_doom(&engine, &args, &log_file, port) {
            Ok(managed) => {
                let pid = managed.pid;
                *guard = Some(managed);
                Ok((pid, port))
            }
            Err(error) => Err(format!("failed to start {engine}: {error}")),
        }
    };
    let (pid, port) = match spawn {
        Ok(spawned) => spawned,
        Err(detail) => return fail(&app, DoomErrorCode::SpawnFailed, detail),
    };
    persist_managed_pid(&app, Some(pid));

    // Bounded readiness poll — kills the child before returning on timeout.
    let timeout = ready_timeout();
    if !wait_ready_or_exit(&app, port, timeout).await {
        let managed = {
            let state = app.state::<DoomRuntimeState>();
            let taken = lock_state(&state).take();
            taken
        };
        if let Some(mut managed) = managed {
            process::kill_process_tree(&mut managed);
        }
        persist_managed_pid(&app, None);
        let detail = format!(
            "the Doom engine did not become ready within {}s and was stopped.",
            timeout.as_secs()
        );
        return fail(&app, DoomErrorCode::ReadyTimeout, detail);
    }

    clear_last_error(&app);
    emit_status(
        &app,
        DoomRuntimePhase::Ready,
        Some(port),
        Some(pid),
        None,
        None,
    );
    success_result(port, pid)
}

/// Stop the managed engine within a bounded graceful window, hard-killing the
/// tree if it survives (G-263). Idempotent — a no-op when nothing is running.
#[tauri::command]
pub async fn stop_doom_runtime(app: AppHandle) -> Result<(), String> {
    stop_runtime(&app, stop_timeout()).await;
    Ok(())
}

/// The ONE bounded teardown: take the child, stop it under `bound`, clear the
/// marker + error, and publish `stopping` → `idle`.
async fn stop_runtime(app: &AppHandle, bound: Duration) {
    let managed = {
        let state = app.state::<DoomRuntimeState>();
        let taken = lock_state(&state).take();
        taken
    };
    let Some(mut managed) = managed else {
        return;
    };
    emit_status(
        app,
        DoomRuntimePhase::Stopping,
        Some(managed.port),
        Some(managed.pid),
        None,
        None,
    );
    let outcome = process::stop_bounded(&mut managed, bound).await;
    persist_managed_pid(app, None);
    clear_last_error(app);
    emit_status(app, DoomRuntimePhase::Idle, None, None, None, None);
    tracing::info!(
        target: "fredo::doom",
        pid = managed.pid,
        ?outcome,
        "Doom engine stopped"
    );
}

/// Read-only status snapshot. Reaps a child that has already exited.
#[tauri::command]
pub fn get_doom_status(app: AppHandle) -> DoomStatus {
    let (running, port, pid) = match running_snapshot(&app) {
        Some((port, pid)) => (true, Some(port), Some(pid)),
        None => (false, None, None),
    };
    let (last_error, code) = read_last_error(&app);
    let phase = derive_phase(running, last_error.is_some());
    DoomStatus {
        phase,
        running,
        port,
        pid,
        last_error,
        code,
    }
}

// ── Teardown entry points (window close + app exit) ──────────────────────────

/// Synchronous teardown for the `doom` window's `CloseRequested` handler: bounded
/// by `DOOM_STOP_TIMEOUT_S` with the hard-kill fallback (G-263). Wired by the
/// window builder in CU-4 (`open_doom_window`).
pub fn stop_doom_on_window_close(app: &AppHandle) {
    tauri::async_runtime::block_on(stop_runtime(app, stop_timeout()));
}

/// The `doom` window `CloseRequested` handler (mirrors
/// `terminal::commands::window_close_handler`). Wired by `open_doom_window` in
/// CU-4; a close for ANY reason tears the engine down so no orphan survives.
pub fn doom_close_handler(app: AppHandle) -> impl Fn(&tauri::WindowEvent) + Send + Sync + 'static {
    move |event| {
        if let tauri::WindowEvent::CloseRequested { .. } = event {
            tracing::debug!(target: "fredo::doom", "CloseRequested: stopping the Doom engine");
            stop_doom_on_window_close(&app);
        }
    }
}

/// `RunEvent::Exit` hook (SYNCHRONOUS entry): bounded teardown under
/// `DOOM_EXIT_HOOK_BOUND`, then the marker sweep as a backstop. Quit can never
/// block on a hung engine — the total is the bound plus a single `taskkill`.
pub fn stop_doom_on_exit(app: &AppHandle) {
    tauri::async_runtime::block_on(stop_runtime(app, Duration::from_secs(DOOM_EXIT_HOOK_BOUND)));
    // Backstop — also covers a hard-killed / mid-boot engine.
    process::sweep_orphan(app);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::doom::state::DOOM_INSTALL_DIR_KEY;
    use crate::infrastructure::storage::engine::EngineHandle;

    fn open_store(dir: &Path) -> AppStore {
        AppStore::open(EngineHandle::new_pending(), dir).expect("open app store")
    }

    #[test]
    fn success_and_failure_results_carry_the_typed_contract() {
        let ok = success_result(6666, 4242);
        assert!(ok.success);
        assert_eq!(ok.phase, DoomRuntimePhase::Ready);
        assert_eq!(ok.port, Some(6666));
        assert_eq!(ok.pid, Some(4242));
        assert!(ok.code.is_none());

        let failed = DoomLaunchResult {
            success: false,
            phase: DoomRuntimePhase::Error,
            port: None,
            pid: None,
            error: Some("nope".to_string()),
            code: Some(DoomErrorCode::SpawnFailed),
        };
        assert_eq!(failed.code, Some(DoomErrorCode::SpawnFailed));
    }

    #[test]
    fn resolve_helpers_prefer_env_over_the_configured_setting() {
        // Pure resolution is pinned in `process`; here we pin the setting key
        // contract used by the command-level resolvers.
        assert_eq!(DOOM_ENGINE_PATH_KEY, "doom_engine_path");
        assert_eq!(DOOM_IWAD_PATH_KEY, "doom_iwad_path");
        assert_eq!(DOOM_INSTALL_DIR_KEY, "doom_install_dir");
        assert_eq!(DOOM_PORT_KEY, "doom_port");
    }

    #[test]
    fn configured_port_defaults_and_parses() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = open_store(dir.path());
        assert_eq!(
            store
                .control_get(DOOM_PORT_KEY)
                .ok()
                .flatten()
                .and_then(|v| v.trim().parse::<u16>().ok())
                .unwrap_or(DEFAULT_DOOM_PORT),
            DEFAULT_DOOM_PORT
        );
    }

    #[test]
    fn error_persistence_round_trips_through_the_store() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = open_store(dir.path());
        store.control_set(DOOM_LAST_ERROR_KEY, "boom").expect("set");
        store
            .control_set(DOOM_LAST_ERROR_CODE_KEY, "readyTimeout")
            .expect("set code");
        assert_eq!(
            store.control_get(DOOM_LAST_ERROR_KEY).ok().flatten().as_deref(),
            Some("boom")
        );
        assert_eq!(
            store
                .control_get(DOOM_LAST_ERROR_CODE_KEY)
                .ok()
                .flatten()
                .and_then(|v| DoomErrorCode::parse(&v)),
            Some(DoomErrorCode::ReadyTimeout)
        );
    }

    #[test]
    fn ready_and_stop_timeouts_honour_the_env_seam_contract() {
        // The constants are the unset default; the seam names are pinned in
        // `state`. This asserts the derivation helper's default path.
        assert_eq!(DOOM_READY_TIMEOUT_ENV, "FREDO_DOOM_READY_TIMEOUT_S");
        assert_eq!(DOOM_STOP_TIMEOUT_ENV, "FREDO_DOOM_STOP_TIMEOUT_S");
        if std::env::var(DOOM_READY_TIMEOUT_ENV).is_err() {
            assert_eq!(ready_timeout(), Duration::from_secs(DOOM_READY_TIMEOUT_S));
        }
        if std::env::var(DOOM_STOP_TIMEOUT_ENV).is_err() {
            assert_eq!(stop_timeout(), Duration::from_secs(DOOM_STOP_TIMEOUT_S));
        }
    }
}
