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

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::infrastructure::comm::bus::EventBus;
use crate::infrastructure::companion::doom_decision::DoomDecisionSourceState;
use crate::infrastructure::companion::PerformanceModeState;
use crate::infrastructure::storage::application_store::ApplicationStore;
use crate::infrastructure::storage::AppStore;

use super::agent::{run_autoplay_loop, AutoplayRun, DoomAutoplayConfig};
use super::autoplay::{
    DoomAutoplayErrorCode, DoomAutoplayPhase, DoomAutoplayResult, DoomAutoplayStatus,
};
use super::decision;
use super::progress::DoomProgressWriter;
use super::save::{self, DoomCampaign, DoomSaveStatus};
use super::mode::{
    fail_enter_requested, DoomModeOrigin, DoomModeResult, DoomModeState, DoomModeStatus,
    DOOM_MODE_EVENT,
};
use super::state::{
    derive_phase, DoomErrorCode, DoomLaunchResult, DoomRuntimePhase, DoomRuntimeState, DoomStatus,
    DEFAULT_DOOM_PORT, DOOM_EXIT_HOOK_BOUND, DOOM_INSTALL_DIR_KEY, DOOM_LAST_ERROR_CODE_KEY,
    DOOM_LAST_ERROR_KEY, DOOM_PORT_KEY, DOOM_READY_TIMEOUT_ENV, DOOM_READY_TIMEOUT_S,
    DOOM_STATUS_EVENT, DOOM_STOP_TIMEOUT_ENV, DOOM_STOP_TIMEOUT_S, DOOM_WINDOW_LABEL,
};
use super::{acquisition, client, failure_seam, process, provision, resolver};

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

/// `Some((port, pid, engine_path))` iff a live managed child exists. A child that
/// has exited is reaped out of the state and its PID marker cleared.
fn running_snapshot(app: &AppHandle) -> Option<(u16, u32, String)> {
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
    guard
        .as_ref()
        .map(|managed| (managed.port, managed.pid, managed.engine_path.clone()))
}

/// Persist (or clear) the `doom_pid` marker through the SINGLE implementation in
/// [`process::persist_pid`], so the launch WRITE and the stop CLEAR cannot drift.
fn persist_managed_pid(app: &AppHandle, pid: Option<u32>) {
    let store = app.state::<Arc<AppStore>>();
    process::persist_pid(store.inner(), pid);
}

fn set_last_error(app: &AppHandle, message: &str, code: DoomErrorCode) {
    let store = app.state::<Arc<AppStore>>();
    let _ = store.cached_set(DOOM_LAST_ERROR_KEY, message);
    let _ = store.cached_set(DOOM_LAST_ERROR_CODE_KEY, code.as_str());
}

fn clear_last_error(app: &AppHandle) {
    let store = app.state::<Arc<AppStore>>();
    let _ = store.cached_set(DOOM_LAST_ERROR_KEY, "");
    let _ = store.cached_set(DOOM_LAST_ERROR_CODE_KEY, "");
}

fn read_last_error(app: &AppHandle) -> (Option<String>, Option<DoomErrorCode>) {
    let store = app.state::<Arc<AppStore>>();
    let message = store
        .cached_get(DOOM_LAST_ERROR_KEY)
        .ok()
        .flatten()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let code = store
        .cached_get(DOOM_LAST_ERROR_CODE_KEY)
        .ok()
        .flatten()
        .and_then(|value| DoomErrorCode::parse(&value));
    (message, code)
}

// ── Settings / env resolution (ST-4 extends acquisition) ─────────────────────

fn env_u64(key: &str) -> Option<u64> {
    std::env::var(key)
        .ok()
        .and_then(|value| value.trim().parse().ok())
}

fn setting(app: &AppHandle, key: &str) -> Option<String> {
    app.state::<Arc<AppStore>>()
        .cached_get(key)
        .ok()
        .flatten()
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
    engine_path: Option<String>,
    last_error: Option<String>,
    code: Option<DoomErrorCode>,
) {
    let status = DoomStatus {
        phase,
        running: phase == DoomRuntimePhase::Ready,
        port,
        pid,
        engine_path,
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

fn success_result(port: u16, pid: u32, engine_path: String) -> DoomLaunchResult {
    DoomLaunchResult {
        success: true,
        phase: DoomRuntimePhase::Ready,
        port: Some(port),
        pid: Some(pid),
        engine_path: Some(engine_path),
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
        None,
        Some(detail.clone()),
        Some(code),
    );
    DoomLaunchResult {
        success: false,
        phase: DoomRuntimePhase::Error,
        port: None,
        pid: None,
        engine_path: None,
        error: Some(detail),
        code: Some(code),
    }
}

/// Bounded readiness wait that ALSO fails fast when the child exits.
///
/// Readiness means "the engine can SERVE", not "the TCP port is open" (ST-4):
/// once the loopback port accepts a connection, this polls `GET /api/state` until
/// it answers **200**. `true` when the engine serves state; `false` when the child
/// is gone or `bound` elapses (the caller then kills the child — G-263).
async fn wait_ready_or_exit(
    app: &AppHandle,
    port: u16,
    bound: Duration,
    transport: &dyn client::DoomHttpTransport,
) -> bool {
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
        // The port must accept a connection before /api/state can answer; once it
        // does, a 200 from /api/state is the real readiness signal.
        if process::port_is_open("127.0.0.1", port) {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return false;
            }
            if let Ok(Ok(_)) =
                tokio::time::timeout(remaining, client::read_state_with(transport, port)).await
            {
                return true;
            }
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
    if let Some((port, pid, engine_path)) = running_snapshot(&app) {
        clear_last_error(&app);
        return success_result(port, pid, engine_path);
    }

    // Engine: managed-only (#3013 AC1/AC2). The ONLY engine is the one Fredo
    // built into the chosen install dir (`<install_dir>/engine/restful-doom.exe`).
    // There is no PATH lookup, no configured override, and no runtime download: an
    // absent or unbuilt managed engine reports the provisioning state and leaves
    // the mode inactive — never a substitute.
    let engine = match resolver::resolve_engine(&app) {
        Some(path) => path,
        None => {
            return fail(
                &app,
                DoomErrorCode::ProvisionRequired,
                "the managed Doom engine is not built — open Doom Mode to build it.".to_string(),
            )
        }
    };
    // IWAD: a configured-but-missing path is `notConfigured` (F-11) and never
    // triggers a download; only an entirely unconfigured IWAD falls through to
    // the pinned Freedoom acquisition.
    let iwad = match resolver::resolve_iwad(&app) {
        Some(path) if Path::new(&path).is_file() => path,
        Some(path) => {
            return fail(
                &app,
                DoomErrorCode::NotConfigured,
                format!("the configured Doom game data (IWAD) is missing: {path}"),
            )
        }
        None => match acquisition::acquire_iwad(&app).await {
            Ok(Some(path)) => path,
            Ok(None) => {
                return fail(
                    &app,
                    DoomErrorCode::NotConfigured,
                    "no Doom game data (IWAD) is configured — set the WAD path in Settings."
                        .to_string(),
                )
            }
            Err(detail) => return fail(&app, DoomErrorCode::AcquireFailed, detail),
        },
    };
    let install_dir = match process::resolve_install_dir(&app) {
        Ok(dir) => dir,
        Err(detail) => return fail(&app, DoomErrorCode::SpawnFailed, detail),
    };
    let log_file = process::log_path(&install_dir);

    emit_status(&app, DoomRuntimePhase::Starting, None, None, None, None, None);

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
                let (port, pid, engine_path) =
                    (managed.port, managed.pid, managed.engine_path.clone());
                drop(guard);
                clear_last_error(&app);
                return success_result(port, pid, engine_path);
            }
            if let Some(mut dead) = guard.take() {
                process::kill_process_tree(&mut dead);
            }
        }
        // AC3 failure lever (test-only, inert when unset): fail BEFORE any real
        // spawn so no engine process is ever created when the lever is set.
        if failure_seam::fail_engine_spawn_requested() {
            drop(guard);
            return fail(
                &app,
                DoomErrorCode::SpawnFailed,
                "the Doom engine spawn was refused by the test seam (FREDO_DOOM_FAIL_ENGINE_SPAWN=1)."
                    .to_string(),
            );
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

    // Bounded readiness poll — readiness now means the engine can SERVE (a
    // `GET /api/state` 200), not merely that the TCP port opened (ST-4). The
    // child is killed before returning on timeout (G-263).
    let timeout = ready_timeout();
    let transport = match client::ReqwestDoomTransport::new() {
        Ok(transport) => transport,
        Err(detail) => {
            let managed = {
                let state = app.state::<DoomRuntimeState>();
                let taken = lock_state(&state).take();
                taken
            };
            if let Some(mut managed) = managed {
                process::kill_process_tree(&mut managed);
            }
            persist_managed_pid(&app, None);
            return fail(&app, DoomErrorCode::SpawnFailed, detail);
        }
    };
    if !wait_ready_or_exit(&app, port, timeout, &transport).await {
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
        Some(engine.clone()),
        None,
        None,
    );
    success_result(port, pid, engine)
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
        Some(managed.engine_path.clone()),
        None,
        None,
    );
    let outcome = process::stop_bounded(&mut managed, bound).await;
    persist_managed_pid(app, None);
    clear_last_error(app);
    emit_status(app, DoomRuntimePhase::Idle, None, None, None, None, None);
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
    let (running, port, pid, engine_path) = match running_snapshot(&app) {
        Some((port, pid, engine_path)) => (true, Some(port), Some(pid), Some(engine_path)),
        None => (false, None, None, None),
    };
    let (last_error, code) = read_last_error(&app);
    let phase = derive_phase(running, last_error.is_some());
    DoomStatus {
        phase,
        running,
        port,
        pid,
        engine_path,
        last_error,
        code,
    }
}

// ── HTTP control surface (ST-5) ──────────────────────────────────────────────

/// One `GET /api/state` against the live engine. Never polls — the caller drives
/// the cadence. A not-running engine is a typed `requestFailed` with no request.
#[tauri::command]
pub async fn doom_read_state(
    app: AppHandle,
) -> Result<client::DoomStateView, client::DoomRequestError> {
    let port = client::active_port(&app).ok_or_else(|| {
        client::DoomRequestError::request_failed("the Doom engine is not running")
    })?;
    let transport =
        client::ReqwestDoomTransport::new().map_err(client::DoomRequestError::request_failed)?;
    client::read_state_with(&transport, port).await
}

/// One `POST /api/step` with the corrected `{tics, actions}` body. `tics`
/// defaults to 1 and `actions` to an empty list; `actions` is passed through
/// verbatim (the engine takes action objects).
#[tauri::command]
pub async fn doom_step(
    app: AppHandle,
    tics: Option<i64>,
    actions: Option<serde_json::Value>,
) -> Result<client::DoomStepResult, client::DoomRequestError> {
    let port = client::active_port(&app).ok_or_else(|| {
        client::DoomRequestError::request_failed("the Doom engine is not running")
    })?;
    let transport =
        client::ReqwestDoomTransport::new().map_err(client::DoomRequestError::request_failed)?;
    let tics = tics.unwrap_or(1);
    let actions = actions.unwrap_or_else(|| serde_json::Value::Array(Vec::new()));
    client::step_with(&transport, port, tics, &actions).await
}

/// One `GET /api/frame`, converted from the engine's indexed8+palette JSON to a
/// base64 PNG for the CU-4 canvas.
#[tauri::command]
pub async fn doom_frame(app: AppHandle) -> Result<client::DoomFrame, client::DoomRequestError> {
    let port = client::active_port(&app).ok_or_else(|| {
        client::DoomRequestError::request_failed("the Doom engine is not running")
    })?;
    let transport =
        client::ReqwestDoomTransport::new().map_err(client::DoomRequestError::request_failed)?;
    client::frame_with(&transport, port).await
}

// ── Autoplay commands + state (Spec #2969, ST-5) ─────────────────────────────
//
// The reachable trigger host (G-265): the Tauri command surface over the ST-3
// bounded loop. This section owns the ONE autoplay run's stop flag + last
// status ([`DoomAutoplayState`], application-module state), selects nothing itself
// (the composition root installs the decision source), and publishes every
// status transition to the `doom` window through the EventBus.

/// The autoplay status-transition event the `doom` window subscribes to
/// (binding name; payload [`DoomAutoplayStatus`]).
pub const DOOM_AUTOPLAY_EVENT: &str = "doom-autoplay-changed";

/// Tauri-managed autoplay state (Spec #2969 ST-5): the ONE live run's stop flag
/// plus the last observed status. Application-module state (binding decision 2) —
/// no Doom runtime state lives in `infrastructure/`.
pub struct DoomAutoplayState {
    inner: Mutex<DoomAutoplayInner>,
}

struct DoomAutoplayInner {
    /// The stop flag of the live run, or `None` when no run is active.
    active: Option<Arc<AtomicBool>>,
    /// The last observed/known status (the `get_doom_autoplay_status` return).
    status: DoomAutoplayStatus,
}

impl Default for DoomAutoplayState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(DoomAutoplayInner {
                active: None,
                status: idle_status(),
            }),
        }
    }
}

impl DoomAutoplayState {
    fn lock(&self) -> MutexGuard<'_, DoomAutoplayInner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The last observed status.
    pub fn status(&self) -> DoomAutoplayStatus {
        self.lock().status.clone()
    }

    /// The current status when a run is active; `None` when idle. Lets `start`
    /// return the live run immediately without touching readiness.
    pub fn active_status(&self) -> Option<DoomAutoplayStatus> {
        let inner = self.lock();
        inner.active.as_ref().map(|_| inner.status.clone())
    }

    /// Atomically begin a run with `stop`. `Err(current)` when a run is already
    /// active, so two concurrent starts can never spawn two loops (R-1
    /// idempotency).
    ///
    /// The `Err` is boxed: `DoomAutoplayStatus` carries the live campaign fields
    /// (Spec #2972) and would otherwise make the `Result` an over-large value
    /// (`clippy::result_large_err`). Callers read the fields through deref.
    pub fn try_begin(
        &self,
        stop: Arc<AtomicBool>,
        campaign: &DoomCampaign,
    ) -> Result<DoomAutoplayStatus, Box<DoomAutoplayStatus>> {
        let mut inner = self.lock();
        if inner.active.is_some() {
            return Err(Box::new(inner.status.clone()));
        }
        inner.active = Some(stop);
        inner.status = running_status(campaign);
        Ok(inner.status.clone())
    }

    /// Fold one loop observation into the state, returning the status to emit.
    ///
    /// While a stop is winding down a `Running` observation is reported as
    /// `Stopping` (so the UI never flickers back to `Running`), and any
    /// non-`Running`/`Stopping` observation clears the live run.
    pub fn apply(&self, observed: &DoomAutoplayStatus) -> DoomAutoplayStatus {
        let mut inner = self.lock();
        let stop_requested = inner
            .active
            .as_ref()
            .map(|flag| flag.load(Ordering::Relaxed))
            .unwrap_or(false);
        let mut status = observed.clone();
        if status.phase == DoomAutoplayPhase::Running && stop_requested {
            status.phase = DoomAutoplayPhase::Stopping;
        }
        if !matches!(
            status.phase,
            DoomAutoplayPhase::Running | DoomAutoplayPhase::Stopping
        ) {
            inner.active = None;
        }
        inner.status = status.clone();
        status
    }

    /// Request a cooperative stop of the live run: sets the flag and returns the
    /// `Stopping` status to emit. `None` when idle (idempotent).
    pub fn request_stop(&self) -> Option<DoomAutoplayStatus> {
        let mut inner = self.lock();
        let flag = inner.active.clone()?;
        flag.store(true, Ordering::Relaxed);
        inner.status.phase = DoomAutoplayPhase::Stopping;
        inner.status.running = true;
        Some(inner.status.clone())
    }

    /// Defensive cleanup once the loop task has returned: clear the live-run
    /// marker if the terminal observation did not already. Returns the status to
    /// emit only when the loop exited WITHOUT a terminal observation (every
    /// normal exit observes one first).
    pub fn finish(&self) -> Option<DoomAutoplayStatus> {
        let mut inner = self.lock();
        inner.active.take()?;
        if matches!(
            inner.status.phase,
            DoomAutoplayPhase::Running | DoomAutoplayPhase::Stopping
        ) {
            inner.status.phase = DoomAutoplayPhase::Idle;
            inner.status.running = false;
            return Some(inner.status.clone());
        }
        None
    }
}

/// The initial idle status (no run has ever started).
fn idle_status() -> DoomAutoplayStatus {
    DoomAutoplayStatus {
        phase: DoomAutoplayPhase::Idle,
        running: false,
        steps: 0,
        decisions: 0,
        failures: 0,
        consecutive_failures: 0,
        last_tic: None,
        outcome: None,
        episode: None,
        map: None,
        completed: false,
        started_at: None,
        last_error: None,
        code: None,
    }
}

/// The seeded status at the moment a run begins (replaced by the loop's first
/// observation almost immediately). Seeded with the resolved campaign's resume
/// point so the `doom-autoplay-changed` payload carries it from the start.
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
        completed: campaign.completed,
        started_at: Some(chrono::Utc::now().to_rfc3339()),
        last_error: None,
        code: None,
    }
}

/// The bounded autoplay config: the `maxSteps` argument wins, then the
/// `FREDO_DOOM_AGENT_MAX_STEPS` seam, then the binding default. The remaining
/// budgets honour their env seams over the defaults.
fn autoplay_config(max_steps: Option<u32>) -> DoomAutoplayConfig {
    let base = DoomAutoplayConfig::default();
    DoomAutoplayConfig {
        max_steps: max_steps
            .or_else(decision::max_steps_from_env)
            .unwrap_or(base.max_steps),
        max_failures: decision::max_failures_from_env().unwrap_or(base.max_failures),
        ..base
    }
}

/// A typed `NotReady` start result — always `success: false` with
/// `phase: Failed` and NO engine request.
fn not_ready(detail: impl Into<String>) -> DoomAutoplayResult {
    DoomAutoplayResult {
        success: false,
        phase: DoomAutoplayPhase::Failed,
        steps: 0,
        code: Some(DoomAutoplayErrorCode::NotReady),
        error: Some(detail.into()),
    }
}

/// Publish a `doom-autoplay-changed` transition to the `doom` window through the
/// EventBus — the sanctioned emission path (application code never calls
/// `AppHandle::emit_to` directly). A missing window is not an error.
fn publish_autoplay(app: &AppHandle, status: &DoomAutoplayStatus) {
    let bus = app.state::<EventBus>();
    bus.emit_to_window(DOOM_WINDOW_LABEL, DOOM_AUTOPLAY_EVENT, status);
}

/// Start the bounded Doom autoplay loop (Spec #2969 ST-5).
///
/// Idempotent: a live run wins immediately and a second loop is never spawned.
/// When the engine is not serving (`client::active_port` is `None`) or the
/// composition root installed no decision source, returns a typed
/// `code = NotReady` result with **NO engine request** (F-32). The `doom-
/// autoplay-changed` event (not this result) is the source of truth for
/// `running`; the result only reports the start.
#[tauri::command]
pub async fn start_doom_autoplay(
    app: AppHandle,
    max_steps: Option<u32>,
    fresh_start: Option<bool>,
) -> DoomAutoplayResult {
    // Idempotency — a live run wins immediately (no second loop).
    if let Some(status) = app.state::<DoomAutoplayState>().active_status() {
        return DoomAutoplayResult {
            success: true,
            phase: status.phase,
            steps: status.steps,
            code: None,
            error: None,
        };
    }

    // Readiness — the engine must be serving. Not ready ⇒ typed `NotReady` with
    // NO engine request (F-32).
    let Some(port) = client::active_port(&app) else {
        return not_ready("the Doom engine is not ready — start the engine, then try again.");
    };

    // The composition root installs the decision source; absent ⇒ `NotReady`.
    let Some(source) = app.state::<DoomDecisionSourceState>().get() else {
        return not_ready("no Doom decision source is installed.");
    };

    let transport = match client::ReqwestDoomTransport::new() {
        Ok(transport) => transport,
        Err(detail) => {
            return DoomAutoplayResult {
                success: false,
                phase: DoomAutoplayPhase::Failed,
                steps: 0,
                code: Some(DoomAutoplayErrorCode::EngineRequestFailed),
                error: Some(detail),
            }
        }
    };

    // Resolve the campaign to play (Spec #2972 R-1/R-5): an explicit fresh start
    // → the campaign initial; otherwise a valid loaded save, else the initial.
    // A `completed:true` save is preserved and reported terminal at start
    // (G-321) — never a silent fresh run. The save lives in the dedicated
    // `feature_doom_save` PostgreSQL feature table (Spec #3011).
    let store = app.state::<Arc<ApplicationStore>>().inner().clone();
    let campaign = save::resolve_start_campaign(
        fresh_start,
        save::load(&store).map(|saved| saved.to_campaign()),
    );
    let progress = DoomProgressWriter::for_store(store);

    let config = autoplay_config(max_steps);
    let stop = Arc::new(AtomicBool::new(false));
    if let Err(current) = app
        .state::<DoomAutoplayState>()
        .try_begin(stop.clone(), &campaign)
    {
        // Lost the race to a concurrent start — report the live run.
        return DoomAutoplayResult {
            success: true,
            phase: current.phase,
            steps: current.steps,
            code: None,
            error: None,
        };
    }

    // Spawn the bounded loop. Every status transition is folded into the state
    // and published; the terminal observation clears the live-run marker.
    let loop_app = app.clone();
    let observe_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let transport_ref: &dyn client::DoomHttpTransport = &transport;
        let source_ref: &dyn crate::infrastructure::companion::doom_decision::DoomDecisionSource =
            source.as_ref();
        run_autoplay_loop(
            transport_ref,
            port,
            source_ref,
            &config,
            AutoplayRun { campaign, progress },
            &stop,
            move |observed| {
                let state = observe_app.state::<DoomAutoplayState>();
                let published = state.apply(observed);
                publish_autoplay(&observe_app, &published);
            },
        )
        .await;
        // Defensive: clear the run marker if the loop returned without a
        // terminal observation (every normal exit observes one first).
        let state = loop_app.state::<DoomAutoplayState>();
        if let Some(status) = state.finish() {
            publish_autoplay(&loop_app, &status);
        }
    });

    // Report terminal completion synchronously for an already-completed save;
    // otherwise the run is starting (the event remains the source of truth).
    DoomAutoplayResult {
        success: true,
        phase: if campaign.completed {
            DoomAutoplayPhase::Completed
        } else {
            DoomAutoplayPhase::Running
        },
        steps: 0,
        code: if campaign.completed {
            Some(DoomAutoplayErrorCode::CampaignComplete)
        } else {
            None
        },
        error: None,
    }
}

/// Read the persisted resume point (Spec #2972 R-1/R-2). Never fails: an absent,
/// corrupt, or unreadable save reports `hasSave:false` with every coordinate null.
#[tauri::command]
pub fn get_doom_save(app: AppHandle) -> DoomSaveStatus {
    let store = app.state::<Arc<ApplicationStore>>().inner().clone();
    save::load(&store)
        .map(|saved| DoomSaveStatus::from_save(&saved))
        .unwrap_or_else(DoomSaveStatus::absent)
}

/// Explicitly discard the persisted resume point (Spec #2972). Idempotent; always
/// reports `hasSave:false` afterwards. A clear failure is logged, never fatal.
#[tauri::command]
pub fn reset_doom_save(app: AppHandle) -> DoomSaveStatus {
    let store = app.state::<Arc<ApplicationStore>>().inner().clone();
    if let Err(detail) = save::clear(&store) {
        tracing::warn!(
            target: "fredo::doom",
            error = %detail,
            "doom save reset failed"
        );
    }
    DoomSaveStatus::absent()
}

/// Cooperatively stop the live autoplay run (Spec #2969 ST-5).
///
/// Bounded and idempotent: sets the run's stop flag and returns immediately; the
/// loop observes it at its next bounded check (every engine wait is capped by
/// `DOOM_REQUEST_TIMEOUT_S` and every decision by the per-decision timeout). A
/// no-op when idle.
#[tauri::command]
pub async fn stop_doom_autoplay(app: AppHandle) -> Result<(), String> {
    if let Some(status) = app.state::<DoomAutoplayState>().request_stop() {
        publish_autoplay(&app, &status);
    }
    Ok(())
}

/// Read-only autoplay status snapshot (the ST-7 mount-hydration source).
#[tauri::command]
pub fn get_doom_autoplay_status(app: AppHandle) -> DoomAutoplayStatus {
    app.state::<DoomAutoplayState>().status()
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
/// CU-4; a close for ANY reason tears the engine down so no orphan survives AND
/// clears Doom Mode (Spec #2970 R-3.b: closing the window is an exit path).
pub fn doom_close_handler(app: AppHandle) -> impl Fn(&tauri::WindowEvent) + Send + Sync + 'static {
    move |event| {
        if let tauri::WindowEvent::CloseRequested { .. } = event {
            tracing::debug!(target: "fredo::doom", "CloseRequested: stopping the Doom engine");
            stop_doom_on_window_close(&app);
            clear_mode_teardown(&app);
        }
    }
}

// ── Dedicated window (ST-6) ──────────────────────────────────────────────────

/// Create or focus the ONE `doom` window (singleton keyed by the binding label
/// [`DOOM_WINDOW_LABEL`] = `"doom"`).
///
/// Mirrors `terminal::commands::open_terminal_window_with_intent`: an existing
/// window is focused and NEVER rebuilt (R-1.2 exactly-one), while a fresh window
/// is built against the `index.html?view=doom` route with the CU-2
/// [`doom_close_handler`] wired to `CloseRequested`, so closing the window for
/// ANY reason tears the engine down (G-263). The window title matches the
/// in-webview `doom-window-title` heading ("Doom").
#[tauri::command]
pub async fn open_doom_window(app: AppHandle) -> Result<(), String> {
    match app.get_webview_window(DOOM_WINDOW_LABEL) {
        Some(window) => {
            tracing::debug!(target: "fredo::doom", "reusing existing doom window");
            window.set_focus().ok();
        }
        None => {
            tracing::debug!(target: "fredo::doom", "building the doom WebviewWindow");
            let builder = WebviewWindowBuilder::new(
                &app,
                DOOM_WINDOW_LABEL,
                WebviewUrl::App("index.html?view=doom".into()),
            )
            .title("Doom")
            .inner_size(900.0, 600.0)
            .min_inner_size(560.0, 360.0)
            .resizable(true);
            let window = builder
                .build()
                .map_err(|e| format!("Failed to open Doom window: {e}"))?;
            // Wire CloseRequested → bounded engine teardown (no orphan, G-263).
            window.on_window_event(doom_close_handler(app.clone()));
        }
    }
    Ok(())
}

/// `RunEvent::Exit` hook (SYNCHRONOUS entry): bounded teardown under
/// `DOOM_EXIT_HOOK_BOUND`, then the marker sweep as a backstop. Quit can never
/// block on a hung engine — the total is the bound plus a single `taskkill`.
///
/// Spec #2970 R-3.b: an app exit is an exit path, so it also clears Doom Mode
/// (and its suppression) without starving the llama-server/PG exit hooks.
pub fn stop_doom_on_exit(app: &AppHandle) {
    tauri::async_runtime::block_on(stop_runtime(app, Duration::from_secs(DOOM_EXIT_HOOK_BOUND)));
    // Backstop — also covers a hard-killed / mid-boot engine.
    process::sweep_orphan(app);
    clear_mode_teardown(app);
}

// ── Doom Mode lifecycle (Spec #2970 ST-2) ────────────────────────────────────
//
// The mode is the single source of truth for "is Doom Mode active" (G-124). The
// three commands below own the enter/exit orchestration and the global
// `doom-mode-changed` broadcast; the suppression gate lives in
// [`PerformanceModeState`] (shared infrastructure) so ST-3 can read it without
// importing this application. The mode is NEVER persisted.

/// The suppression gate read from its owner (single source, no drift).
fn is_voice_suppressed(app: &AppHandle) -> bool {
    app.state::<PerformanceModeState>().is_suppressed()
}

/// Build the current status from the mode state + the suppression owner.
fn current_mode_status(app: &AppHandle) -> DoomModeStatus {
    let suppressed = is_voice_suppressed(app);
    app.state::<DoomModeState>().status(suppressed)
}

/// Set (or clear) the shared suppression gate.
fn set_suppression(app: &AppHandle, on: bool) {
    app.state::<PerformanceModeState>().set_suppressed(on);
}

/// Broadcast the mode status to EVERY window through the EventBus (the
/// sanctioned global emission path).
fn publish_mode(app: &AppHandle, status: &DoomModeStatus) {
    let bus = app.state::<EventBus>();
    bus.emit_global(DOOM_MODE_EVENT, status);
}

/// Project a [`DoomModeStatus`] into a [`DoomModeResult`].
fn mode_result(
    status: &DoomModeStatus,
    success: bool,
    error: Option<String>,
    code: Option<DoomErrorCode>,
) -> DoomModeResult {
    mode_result_with_needs(status, success, error, code, false)
}

/// As [`mode_result`], also flagging the first-use install-dir requirement
/// (`code: provisionRequired`, Spec #3012 ST-3).
fn mode_result_with_needs(
    status: &DoomModeStatus,
    success: bool,
    error: Option<String>,
    code: Option<DoomErrorCode>,
    needs_install_dir: bool,
) -> DoomModeResult {
    DoomModeResult {
        success,
        phase: status.phase,
        active: status.active,
        voice_suppressed: status.voice_suppressed,
        origin: status.origin,
        error,
        code,
        needs_install_dir,
    }
}

/// Roll an enter back to `inactive` with a typed failure and publish it — never
/// a half-entered state (R-1.b / R-5).
fn fail_enter(app: &AppHandle, message: String, code: Option<DoomErrorCode>) -> DoomModeResult {
    app.state::<DoomModeState>()
        .mark_enter_failed(message.clone(), code);
    set_suppression(app, false);
    let status = current_mode_status(app);
    publish_mode(app, &status);
    mode_result(&status, false, Some(message), code)
}

/// Clear Doom Mode + suppression on a teardown path (window close / app exit).
/// Idempotent and broadcast only when the mode actually changed.
fn clear_mode_teardown(app: &AppHandle) {
    set_suppression(app, false);
    if app.state::<DoomModeState>().clear() {
        let status = current_mode_status(app);
        publish_mode(app, &status);
    }
}

/// Whether the runtime can launch WITHOUT provisioning: a staged managed engine
/// carrying the pinned commit marker. Managed-only resolution (#3013 ST-1) leaves
/// no configured/PATH leg; only when the staged engine is absent is first-use
/// provisioning required (Spec #3012 ST-3, R-3.1).
fn engine_available_without_provisioning(install_dir: &Path) -> bool {
    provision::is_engine_staged(install_dir)
}

/// Enter Doom Mode: idempotently launch the runtime, start the playing agent,
/// open the `doom` window, then set the mode active + suppression on (R-1).
///
/// A no-op success when already `entering`/`active` (R-1.a — no second runtime,
/// no second window). Any activation failure rolls back fully to `inactive`
/// with no window, no runtime, and no suppression (R-1.b / R-5).
#[tauri::command]
pub async fn enter_doom_mode(app: AppHandle, origin: Option<String>) -> DoomModeResult {
    let origin = origin.as_deref().and_then(DoomModeOrigin::parse);

    // Idempotent — an enter already in flight, or an active mode, wins.
    if !app.state::<DoomModeState>().begin_enter(origin) {
        let status = current_mode_status(&app);
        return mode_result(&status, true, None, None);
    }
    let entering = current_mode_status(&app);
    publish_mode(&app, &entering);

    // Injected failure seam (G-275) — R-1.b / F-35.
    if fail_enter_requested() {
        return fail_enter(
            &app,
            "Doom Mode enter failed (FREDO_DOOM_MODE_FAIL_ENTER=1).".to_string(),
            Some(DoomErrorCode::SpawnFailed),
        );
    }

    // First-use provisioning guard (Spec #3012 ST-3). An engine that already
    // resolves — configured/overridden, on PATH, or a staged+marker build —
    // skips provisioning entirely (R-3.1); only an engine that is absent
    // everywhere is built before the runtime can launch.
    let install_dir = match process::resolve_install_dir(&app) {
        Ok(dir) => dir,
        Err(detail) => return fail_enter(&app, detail, Some(DoomErrorCode::SpawnFailed)),
    };
    if !engine_available_without_provisioning(&install_dir) {
        match provision::configured_install_dir(&app) {
            // No stored dir → require the owner to choose one WITHOUT entering
            // the mode (the frontend opens the provisioning dialog).
            None => {
                let message =
                    "Choose an install location before Doom Mode can build its engine.".to_string();
                app.state::<DoomModeState>()
                    .mark_enter_failed(message.clone(), Some(DoomErrorCode::ProvisionRequired));
                app.state::<DoomModeState>().set_needs_provisioning(true);
                set_suppression(&app, false);
                let status = current_mode_status(&app);
                publish_mode(&app, &status);
                return mode_result_with_needs(
                    &status,
                    false,
                    Some(message),
                    Some(DoomErrorCode::ProvisionRequired),
                    true,
                );
            }
            // A stored dir → provision (idempotent), reflecting `provisioning`
            // in the mode, then continue to launch once the engine is ready.
            Some(stored) => {
                let _ = app
                    .state::<Arc<AppStore>>()
                    .cached_set(DOOM_INSTALL_DIR_KEY, &stored);
                app.state::<DoomModeState>()
                    .set_provisioning(provision::DoomProvisionPhase::DownloadingToolchain);
                let provisioning = current_mode_status(&app);
                publish_mode(&app, &provisioning);

                provision::start_provisioning(app.clone(), PathBuf::from(&stored));
                let bound = provision::overall_timeout() + Duration::from_secs(30);
                if let Err((_code, message)) =
                    provision::await_provision_outcome(&app, bound).await
                {
                    app.state::<DoomModeState>().clear_provisioning();
                    return fail_enter(&app, message, Some(DoomErrorCode::ProvisionFailed));
                }
                app.state::<DoomModeState>().clear_provisioning();
            }
        }
    }

    // 1. Runtime (idempotent exactly-one launch + bounded readiness).
    let launch = launch_doom_runtime(app.clone()).await;
    if !launch.success {
        return fail_enter(
            &app,
            launch
                .error
                .unwrap_or_else(|| "the Doom runtime failed to start".to_string()),
            launch.code,
        );
    }

    // 2. Playing agent (idempotent bounded autoplay run). Entering Doom Mode is
    // resume-by-default: `freshStart` is deliberately absent (Spec #2972 R-5).
    let autoplay = start_doom_autoplay(app.clone(), None, None).await;
    if !autoplay.success {
        stop_doom_autoplay(app.clone()).await.ok();
        stop_doom_runtime(app.clone()).await.ok();
        return fail_enter(
            &app,
            autoplay
                .error
                .unwrap_or_else(|| "the Doom playing agent failed to start".to_string()),
            None,
        );
    }

    // 3. Window (singleton keyed by DOOM_WINDOW_LABEL).
    if let Err(detail) = open_doom_window(app.clone()).await {
        stop_doom_autoplay(app.clone()).await.ok();
        stop_doom_runtime(app.clone()).await.ok();
        return fail_enter(&app, detail, Some(DoomErrorCode::SpawnFailed));
    }

    // 4. Fully entered: mark active + turn suppression on, then broadcast.
    app.state::<DoomModeState>().mark_active();
    set_suppression(&app, true);
    let status = current_mode_status(&app);
    publish_mode(&app, &status);
    mode_result(&status, true, None, None)
}

/// Exit Doom Mode: bounded stop of the agent + runtime, clear suppression, close
/// the `doom` window, and clear the mode (R-3.b).
///
/// Idempotent — an exit while `inactive` is a no-op success (R-3.c).
#[tauri::command]
pub async fn exit_doom_mode(app: AppHandle, reason: Option<String>) -> DoomModeResult {
    if let Some(reason) = reason.as_deref() {
        tracing::debug!(target: "fredo::doom", reason, "exit_doom_mode requested");
    }

    // Idempotent — nothing to exit (R-3.c).
    if !app.state::<DoomModeState>().begin_exit() {
        let status = current_mode_status(&app);
        return mode_result(&status, true, None, None);
    }
    let exiting = current_mode_status(&app);
    publish_mode(&app, &exiting);

    // 1. Stop the playing agent + the runtime (bounded, hard-kill fallback).
    stop_doom_autoplay(app.clone()).await.ok();
    stop_doom_runtime(app.clone()).await.ok();

    // 2. Clear suppression + the mode, then close the window.
    set_suppression(&app, false);
    app.state::<DoomModeState>().clear();
    if let Some(window) = app.get_webview_window(DOOM_WINDOW_LABEL) {
        window.close().ok();
    }

    let status = current_mode_status(&app);
    publish_mode(&app, &status);
    mode_result(&status, true, None, None)
}

/// Read-only Doom Mode snapshot (the frontend mount seed + poll fallback).
#[tauri::command]
pub fn get_doom_mode_status(app: AppHandle) -> DoomModeStatus {
    current_mode_status(&app)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::applications::doom::state::{DOOM_INSTALL_DIR_KEY, DOOM_IWAD_PATH_KEY};
    use crate::infrastructure::storage::engine::EngineHandle;

    fn open_store(dir: &Path) -> AppStore {
        AppStore::open(EngineHandle::new_pending(), dir).expect("open app store")
    }

    #[test]
    fn success_and_failure_results_carry_the_typed_contract() {
        let ok = success_result(6666, 4242, r"C:\app\doom\engine\restful-doom.exe".to_string());
        assert!(ok.success);
        assert_eq!(ok.phase, DoomRuntimePhase::Ready);
        assert_eq!(ok.port, Some(6666));
        assert_eq!(ok.pid, Some(4242));
        assert_eq!(
            ok.engine_path.as_deref(),
            Some(r"C:\app\doom\engine\restful-doom.exe")
        );
        assert!(ok.code.is_none());

        let failed = DoomLaunchResult {
            success: false,
            phase: DoomRuntimePhase::Error,
            port: None,
            pid: None,
            engine_path: None,
            error: Some("nope".to_string()),
            code: Some(DoomErrorCode::SpawnFailed),
        };
        assert_eq!(failed.code, Some(DoomErrorCode::SpawnFailed));
        assert!(failed.engine_path.is_none());
    }

    #[test]
    fn resolve_helpers_prefer_env_over_the_configured_setting() {
        // Pure resolution is pinned in `process`; here we pin the setting key
        // contract used by the command-level resolvers.
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
                .cached_get(DOOM_PORT_KEY)
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
        store.cached_set(DOOM_LAST_ERROR_KEY, "boom").expect("set");
        store
            .cached_set(DOOM_LAST_ERROR_CODE_KEY, "readyTimeout")
            .expect("set code");
        assert_eq!(
            store.cached_get(DOOM_LAST_ERROR_KEY).ok().flatten().as_deref(),
            Some("boom")
        );
        assert_eq!(
            store
                .cached_get(DOOM_LAST_ERROR_CODE_KEY)
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

    // ── Autoplay state machine (ST-5) ────────────────────────────────────────

    #[test]
    fn autoplay_event_and_status_shapes_are_pinned() {
        assert_eq!(DOOM_AUTOPLAY_EVENT, "doom-autoplay-changed");

        let idle = idle_status();
        assert_eq!(idle.phase, DoomAutoplayPhase::Idle);
        assert!(!idle.running);
        assert!(idle.started_at.is_none());

        let running = running_status(&DoomCampaign::initial());
        assert_eq!(running.phase, DoomAutoplayPhase::Running);
        assert!(running.running);
        assert!(running.started_at.is_some());
        // The seed carries the resolved resume point (Spec #2972).
        assert_eq!(running.episode, Some(1));
        assert_eq!(running.map, Some(1));
        assert!(!running.completed);
    }

    #[test]
    fn try_begin_is_idempotent() {
        let state = DoomAutoplayState::default();
        let first = state
            .try_begin(Arc::new(AtomicBool::new(false)), &DoomCampaign::initial())
            .expect("the first start begins a run");
        assert_eq!(first.phase, DoomAutoplayPhase::Running);

        let second = state.try_begin(
            Arc::new(AtomicBool::new(false)),
            &DoomCampaign::initial(),
        );
        assert!(
            second.is_err(),
            "a second concurrent start must not begin a second loop"
        );
    }

    #[test]
    fn request_stop_is_idempotent_and_marks_stopping() {
        let state = DoomAutoplayState::default();
        assert!(state.request_stop().is_none(), "idle stop is a no-op");

        let stop = Arc::new(AtomicBool::new(false));
        state
            .try_begin(stop.clone(), &DoomCampaign::initial())
            .expect("begin");
        let stopping = state.request_stop().expect("a live run can be stopped");
        assert_eq!(stopping.phase, DoomAutoplayPhase::Stopping);
        assert!(stopping.running);
        assert!(stop.load(Ordering::Relaxed), "the cooperative flag is set");

        // A second request while winding down still reports Stopping.
        let again = state.request_stop().expect("still active");
        assert_eq!(again.phase, DoomAutoplayPhase::Stopping);
    }

    #[test]
    fn apply_reports_stopping_while_a_stop_winds_down() {
        let state = DoomAutoplayState::default();
        let stop = Arc::new(AtomicBool::new(false));
        state
            .try_begin(stop.clone(), &DoomCampaign::initial())
            .expect("begin");

        let mut running = running_status(&DoomCampaign::initial());
        running.steps = 3;
        let published = state.apply(&running);
        assert_eq!(published.phase, DoomAutoplayPhase::Running);
        assert_eq!(published.steps, 3);

        // Once a stop is requested, a Running observation reports Stopping so
        // the UI never flickers back to Running while winding down.
        stop.store(true, Ordering::Relaxed);
        let published = state.apply(&running);
        assert_eq!(published.phase, DoomAutoplayPhase::Stopping);
        assert!(
            state.active_status().is_some(),
            "the run is still active until the loop returns"
        );
    }

    #[test]
    fn apply_clears_the_run_on_a_terminal_observation() {
        let state = DoomAutoplayState::default();
        state
            .try_begin(Arc::new(AtomicBool::new(false)), &DoomCampaign::initial())
            .expect("begin");

        let mut completed = running_status(&DoomCampaign::initial());
        completed.phase = DoomAutoplayPhase::Completed;
        completed.running = false;
        let published = state.apply(&completed);
        assert_eq!(published.phase, DoomAutoplayPhase::Completed);
        assert!(
            state.active_status().is_none(),
            "a terminal observation ends the run"
        );
        assert_eq!(state.status().phase, DoomAutoplayPhase::Completed);
    }

    #[test]
    fn finish_clears_a_run_without_a_terminal_observation() {
        let state = DoomAutoplayState::default();
        state
            .try_begin(Arc::new(AtomicBool::new(false)), &DoomCampaign::initial())
            .expect("begin");

        let status = state.finish().expect("finish publishes idle");
        assert_eq!(status.phase, DoomAutoplayPhase::Idle);
        assert!(!status.running);
        assert!(state.active_status().is_none());
        // A second finish is a no-op (idempotent).
        assert!(state.finish().is_none());
    }

    #[test]
    fn not_ready_result_is_typed_and_failed() {
        let result = not_ready("engine not ready");
        assert!(!result.success);
        assert_eq!(result.phase, DoomAutoplayPhase::Failed);
        assert_eq!(result.code, Some(DoomAutoplayErrorCode::NotReady));
        assert_eq!(result.error.as_deref(), Some("engine not ready"));
        assert_eq!(result.steps, 0);
    }

    #[test]
    fn autoplay_config_prefers_the_argument_then_env_then_default() {
        let base = DoomAutoplayConfig::default();
        // The `maxSteps` argument always wins.
        assert_eq!(autoplay_config(Some(7)).max_steps, 7);

        // With no argument and no env seam, the binding defaults are used.
        if std::env::var(decision::DOOM_AGENT_MAX_STEPS_ENV).is_err() {
            assert_eq!(autoplay_config(None).max_steps, base.max_steps);
        }
        if std::env::var(decision::DOOM_AGENT_MAX_FAILURES_ENV).is_err() {
            assert_eq!(autoplay_config(None).max_failures, base.max_failures);
        }
    }
}
