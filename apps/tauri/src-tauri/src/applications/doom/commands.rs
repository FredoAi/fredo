//! Doom runtime lifecycle commands (Spec #2968 ST-3; Spec #3023 ST-2).
//!
//! Owns the **in-process native engine** end to end: `launch_doom_runtime`
//! (idempotent exactly-one session), `stop_doom_runtime` (take-and-drop),
//! `get_doom_status`, the parity control surface (`doom_read_state` / `doom_step`
//! / `doom_frame`), and the synchronous teardown entry points wired to the window
//! `CloseRequested` handler and the `RunEvent::Exit` hook.
//!
//! Spec #3023 ST-2 replaced the out-of-process GPL engine + loopback HTTP bridge
//! (`client.rs` / `process.rs` / `resolver.rs` / `acquisition.rs`) with the native
//! in-process adapter ([`super::engine`]). There is **no child process, no PID, no
//! port, no readiness poll**: the command surface routes every call through the
//! Tauri-managed [`DoomEngineState`] via `spawn_blocking`, and teardown is
//! take-and-drop — so no orphan is constructible (G-263).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
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
use super::engine::{DoomEngineError, DoomEngineErrorCode, DoomEngineState};
use super::progress::DoomProgressWriter;
use super::save::{self, DoomCampaign, DoomSaveStatus};
use super::mode::{
    fail_enter_requested, DoomModeOrigin, DoomModeResult, DoomModeState, DoomModeStatus,
    DOOM_MODE_EVENT,
};
use super::state::{
    derive_phase, DoomErrorCode, DoomLaunchResult, DoomRuntimePhase, DoomStatus,
    DOOM_INSTALL_DIR_KEY, DOOM_LAST_ERROR_CODE_KEY, DOOM_LAST_ERROR_KEY, DOOM_STATUS_EVENT,
    DOOM_WINDOW_LABEL,
};
use super::{client, process, provision};

/// The default campaign map the native engine constructs at (E1M1).
const DOOM_DEFAULT_MAP: i64 = 1;
/// The default skill (matches the retired launch argv `-skill 3`).
const DOOM_DEFAULT_SKILL: i64 = 3;

// ── Command wire models (Spec #3023 ST-2) ─────────────────────────────────────
//
// The response shapes the `doom` window consumes. Moved here from the retired
// HTTP client (`client.rs`) so the command surface no longer depends on it; the
// camelCase wire shapes are unchanged (`{raw}` / `{state}` / `{pngBase64}`).

/// `doom_read_state` result — the engine observation, verbatim.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoomStateView {
    /// The engine's observation JSON, unmodified.
    pub raw: serde_json::Value,
}

/// `doom_step` result — the post-step observation, verbatim.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoomStepResult {
    /// The engine's post-step observation JSON, unmodified.
    pub state: serde_json::Value,
}

/// `doom_frame` result — a renderable base64 PNG (no data-URI prefix).
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoomFrame {
    /// Base64-encoded PNG bytes (no data-URI prefix).
    pub png_base64: String,
}

/// The typed command error surface (`{ code, message }`, camelCase over IPC).
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoomCommandError {
    /// The typed failure code (the UI/UX error vocabulary).
    pub code: DoomErrorCode,
    /// Human-readable detail (safe to log/show).
    pub message: String,
}

impl DoomCommandError {
    /// A typed command error.
    pub fn new(code: DoomErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    /// The typed error for a control call with no live session.
    pub fn not_running() -> Self {
        Self::new(DoomErrorCode::RequestFailed, "the Doom engine is not running")
    }
}

impl From<DoomEngineError> for DoomCommandError {
    fn from(error: DoomEngineError) -> Self {
        Self {
            code: DoomErrorCode::from(error.code),
            message: error.message,
        }
    }
}

/// Run one synchronous engine call on the blocking pool.
///
/// The native engine is CPU-bound and synchronous; the async command awaits it
/// off the async runtime thread. A task panic maps to a typed
/// [`DoomEngineErrorCode::EngineStartFailed`] instead of wedging the caller.
async fn run_engine<T>(
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

// ── State helpers ─────────────────────────────────────────────────────────────

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

// ── Status emission ───────────────────────────────────────────────────────────

/// Emit a `doom-status-changed` transition to the `doom` window. A missing window
/// (e.g. an app-exit teardown) is not an error — logged at debug.
fn emit_status(
    app: &AppHandle,
    phase: DoomRuntimePhase,
    last_error: Option<String>,
    code: Option<DoomErrorCode>,
) {
    let status = DoomStatus {
        phase,
        running: phase == DoomRuntimePhase::Ready,
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

/// A successful launch result.
fn ready_result() -> DoomLaunchResult {
    DoomLaunchResult {
        success: true,
        phase: DoomRuntimePhase::Ready,
        error: None,
        code: None,
    }
}

/// Record the typed failure, publish the `error` transition, and return the
/// structured result.
fn fail(app: &AppHandle, code: DoomErrorCode, detail: String) -> DoomLaunchResult {
    set_last_error(app, &detail, code);
    emit_status(app, DoomRuntimePhase::Error, Some(detail.clone()), Some(code));
    DoomLaunchResult {
        success: false,
        phase: DoomRuntimePhase::Error,
        error: Some(detail),
        code: Some(code),
    }
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Launch the native in-process engine (idempotent exactly-one session) at the
/// default E1M1 / skill 3.
///
/// A live session is a healthy early return — a second engine instance is NEVER
/// constructed (REQ-1.3). Construction failures surface as typed errors
/// (`wadMissing` / `wadCorrupt` / `engineStartFailed`) with no process and no
/// orphan (G-263 / REQ-5.2).
#[tauri::command]
pub async fn launch_doom_runtime(app: AppHandle) -> DoomLaunchResult {
    let state = app.state::<DoomEngineState>().inner().clone();

    // Idempotency — an already-live session wins immediately (REQ-1.3).
    if state.is_running() {
        clear_last_error(&app);
        emit_status(&app, DoomRuntimePhase::Ready, None, None);
        return ready_result();
    }

    emit_status(&app, DoomRuntimePhase::Starting, None, None);

    let handle = state.clone();
    let launched = run_engine(move || handle.launch(DOOM_DEFAULT_MAP, DOOM_DEFAULT_SKILL)).await;
    match launched {
        Ok(_session) => {
            clear_last_error(&app);
            emit_status(&app, DoomRuntimePhase::Ready, None, None);
            ready_result()
        }
        Err(error) => fail(&app, DoomErrorCode::from(error.code), error.message),
    }
}

/// Drop the native engine session (take-and-drop). Idempotent — a no-op when no
/// session is live. Bounded by construction (no thread, no process to join).
#[tauri::command]
pub async fn stop_doom_runtime(app: AppHandle) -> Result<(), String> {
    stop_runtime(&app);
    Ok(())
}

/// The ONE take-and-drop teardown: drop the session, clear the last error, and
/// publish `stopping` → `idle`. Bounded — the session drop owns no thread and no
/// process, so no orphan is constructible (G-263).
fn stop_runtime(app: &AppHandle) {
    let state = app.state::<DoomEngineState>();
    if !state.is_running() {
        return;
    }
    emit_status(app, DoomRuntimePhase::Stopping, None, None);
    state.stop();
    clear_last_error(app);
    emit_status(app, DoomRuntimePhase::Idle, None, None);
    tracing::info!(target: "fredo::doom", "Doom engine session dropped");
}

/// Read-only status snapshot.
#[tauri::command]
pub fn get_doom_status(app: AppHandle) -> DoomStatus {
    let running = app.state::<DoomEngineState>().is_running();
    let (last_error, code) = read_last_error(&app);
    let phase = derive_phase(running, last_error.is_some());
    DoomStatus {
        phase,
        running,
        last_error,
        code,
    }
}

// ── In-process control surface (Spec #3023 ST-2) ─────────────────────────────

/// One parity observation read from the live native engine via the adapter.
///
/// Never polls — the caller drives the cadence. A not-running engine is a typed
/// `requestFailed` with no engine call.
#[tauri::command]
pub async fn doom_read_state(app: AppHandle) -> Result<DoomStateView, DoomCommandError> {
    let state = app.state::<DoomEngineState>().inner().clone();
    if !state.is_running() {
        return Err(DoomCommandError::not_running());
    }
    run_engine(move || state.read_state())
        .await
        .map(|raw| DoomStateView { raw })
        .map_err(DoomCommandError::from)
}

/// Advance the native engine by `tics` with `actions` held, answering the
/// post-step observation. `tics` defaults to 1 and `actions` to an empty list;
/// the existing action vocabulary is passed through verbatim.
#[tauri::command]
pub async fn doom_step(
    app: AppHandle,
    tics: Option<i64>,
    actions: Option<serde_json::Value>,
) -> Result<DoomStepResult, DoomCommandError> {
    let state = app.state::<DoomEngineState>().inner().clone();
    if !state.is_running() {
        return Err(DoomCommandError::not_running());
    }
    let tics = tics.unwrap_or(1);
    let actions = actions.unwrap_or_else(|| serde_json::Value::Array(Vec::new()));
    run_engine(move || state.step(tics, &actions))
        .await
        .map(|state| DoomStepResult { state })
        .map_err(DoomCommandError::from)
}

/// The current frame as a base64 PNG (the native 320×200 RGBA framebuffer,
/// encoded in-process — no HTTP, no indexed8 decode).
#[tauri::command]
pub async fn doom_frame(app: AppHandle) -> Result<DoomFrame, DoomCommandError> {
    let state = app.state::<DoomEngineState>().inner().clone();
    if !state.is_running() {
        return Err(DoomCommandError::not_running());
    }
    run_engine(move || state.frame_png())
        .await
        .map(|png_base64| DoomFrame { png_base64 })
        .map_err(DoomCommandError::from)
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

/// Synchronous teardown for the `doom` window's `CloseRequested` handler:
/// take-and-drop of the native session — bounded by construction (no thread, no
/// process to join, so no orphan can survive; G-263). Wired by the window builder
/// in `open_doom_window`.
pub fn stop_doom_on_window_close(app: &AppHandle) {
    stop_runtime(app);
}

/// The ordered stages of the `doom` window close-path teardown, in EXECUTION
/// order. Pinned by a unit test so a future edit cannot silently reorder them:
/// the playing agent is stopped (reused cooperative stop) BEFORE the bounded
/// engine stop, and Doom Mode is cleared last (Spec #3007 R-4.a).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DoomCloseTeardownStage {
    /// Stop the playing agent through the reused
    /// `DoomAutoplayState::request_stop` primitive (one control path).
    StopAgent,
    /// Take-and-drop the native engine session (bounded; G-263).
    StopRuntime,
    /// Clear Doom Mode + suppression and publish `doom-mode-changed`.
    ClearMode,
}

/// The close-path teardown order (agent → engine → mode clear), executed
/// verbatim by [`teardown_doom_on_window_close`].
pub(crate) const DOOM_CLOSE_TEARDOWN_ORDER: [DoomCloseTeardownStage; 3] = [
    DoomCloseTeardownStage::StopAgent,
    DoomCloseTeardownStage::StopRuntime,
    DoomCloseTeardownStage::ClearMode,
];

/// Cooperative agent stop for the close path (Spec #3007 R-4.a): reuse the live
/// run's `DoomAutoplayState::request_stop` primitive — the SAME stop control path
/// as `stop_doom_autoplay` — returning the `Stopping` status to publish when a run
/// was live (`None` when idle: idempotent).
fn stop_agent_on_window_close(state: &DoomAutoplayState) -> Option<DoomAutoplayStatus> {
    state.request_stop()
}

/// Synchronous teardown for the `doom` window close path (Spec #3007 R-4.a): stop
/// the playing agent FIRST (reused cooperative stop), then the engine (bounded,
/// hard-kill fallback, G-263), then clear Doom Mode and publish
/// `doom-mode-changed`. Reuses the existing primitives — no new command or
/// control path. Invoked by [`doom_close_handler`].
pub fn teardown_doom_on_window_close(app: &AppHandle) {
    for stage in DOOM_CLOSE_TEARDOWN_ORDER {
        match stage {
            DoomCloseTeardownStage::StopAgent => {
                let state = app.state::<DoomAutoplayState>();
                if let Some(status) = stop_agent_on_window_close(&state) {
                    publish_autoplay(app, &status);
                }
            }
            DoomCloseTeardownStage::StopRuntime => stop_doom_on_window_close(app),
            DoomCloseTeardownStage::ClearMode => clear_mode_teardown(app),
        }
    }
}

/// The `doom` window `CloseRequested` handler (mirrors
/// `terminal::commands::window_close_handler`). Wired by `open_doom_window` in
/// CU-4; a close for ANY reason stops the playing agent + the engine so no orphan
/// survives AND clears Doom Mode (Spec #2970 R-3.b / Spec #3007 R-4: closing the
/// window is the only exit path).
pub fn doom_close_handler(app: AppHandle) -> impl Fn(&tauri::WindowEvent) + Send + Sync + 'static {
    move |event| {
        if let tauri::WindowEvent::CloseRequested { .. } = event {
            tracing::debug!(
                target: "fredo::doom",
                "CloseRequested: stopping the Doom agent + engine and clearing the mode"
            );
            teardown_doom_on_window_close(&app);
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

/// `RunEvent::Exit` hook (SYNCHRONOUS entry): take-and-drop the native session
/// then clear Doom Mode. Quit can never block on a hung engine — the drop owns no
/// thread and no process (there is no child to sweep; G-263).
///
/// Spec #2970 R-3.b: an app exit is an exit path, so it also clears Doom Mode
/// (and its suppression) without starving the llama-server/PG exit hooks.
pub fn stop_doom_on_exit(app: &AppHandle) {
    stop_runtime(app);
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
    use crate::infrastructure::storage::engine::EngineHandle;

    fn open_store(dir: &Path) -> AppStore {
        AppStore::open(EngineHandle::new_pending(), dir).expect("open app store")
    }

    #[test]
    fn ready_and_failure_results_carry_the_typed_contract() {
        // Spec #3023 ST-2: the process-only fields are dropped — the result is
        // success/phase/error/code only.
        let ok = ready_result();
        assert!(ok.success);
        assert_eq!(ok.phase, DoomRuntimePhase::Ready);
        assert!(ok.error.is_none());
        assert!(ok.code.is_none());

        let failed = DoomLaunchResult {
            success: false,
            phase: DoomRuntimePhase::Error,
            error: Some("nope".to_string()),
            code: Some(DoomErrorCode::EngineStartFailed),
        };
        assert_eq!(failed.code, Some(DoomErrorCode::EngineStartFailed));

        let value = serde_json::to_value(&ok).expect("serialize");
        assert!(value.get("port").is_none());
        assert!(value.get("pid").is_none());
        assert!(value.get("enginePath").is_none());
    }

    #[test]
    fn command_wire_models_serialize_camel_case() {
        let view = DoomStateView {
            raw: serde_json::json!({ "tic": 1 }),
        };
        assert_eq!(serde_json::to_value(&view).unwrap()["raw"]["tic"], 1);

        let step = DoomStepResult {
            state: serde_json::json!({ "tic": 2 }),
        };
        assert_eq!(serde_json::to_value(&step).unwrap()["state"]["tic"], 2);

        let frame = DoomFrame {
            png_base64: "AA==".to_string(),
        };
        assert_eq!(serde_json::to_value(&frame).unwrap()["pngBase64"], "AA==");

        let error = DoomCommandError::not_running();
        let value = serde_json::to_value(&error).unwrap();
        assert_eq!(value["code"], "requestFailed");
        assert_eq!(value["message"], "the Doom engine is not running");
    }

    #[test]
    fn engine_errors_bridge_onto_the_command_error_surface() {
        let error = DoomCommandError::from(DoomEngineError::new(
            DoomEngineErrorCode::WadMissing,
            "no WAD file",
        ));
        assert_eq!(error.code, DoomErrorCode::WadMissing);
        assert_eq!(error.message, "no WAD file");

        let corrupt = DoomCommandError::from(DoomEngineError::new(
            DoomEngineErrorCode::WadCorrupt,
            "bad lump",
        ));
        assert_eq!(corrupt.code, DoomErrorCode::WadCorrupt);
    }

    #[test]
    fn error_persistence_round_trips_through_the_store() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = open_store(dir.path());
        store.cached_set(DOOM_LAST_ERROR_KEY, "boom").expect("set");
        store
            .cached_set(DOOM_LAST_ERROR_CODE_KEY, "wadMissing")
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
            Some(DoomErrorCode::WadMissing)
        );
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

    // ── Close-path teardown (Spec #3007 ST-3) ────────────────────────────────

    #[test]
    fn close_teardown_order_stops_the_agent_before_the_engine() {
        // R-4.a — the playing agent is stopped BEFORE the bounded engine stop,
        // and Doom Mode is cleared last. Pinned so a reorder cannot regress it.
        assert_eq!(
            DOOM_CLOSE_TEARDOWN_ORDER,
            [
                DoomCloseTeardownStage::StopAgent,
                DoomCloseTeardownStage::StopRuntime,
                DoomCloseTeardownStage::ClearMode,
            ]
        );
    }

    #[test]
    fn close_path_stops_the_agent_through_the_reused_primitive() {
        // Identity (one control path): the close path stops the agent via the
        // SAME `DoomAutoplayState::request_stop` primitive as
        // `stop_doom_autoplay` — no parallel stop implementation.
        let state = DoomAutoplayState::default();
        // Idle → no-op (idempotent); nothing to publish.
        assert!(stop_agent_on_window_close(&state).is_none());

        let stop = Arc::new(AtomicBool::new(false));
        state
            .try_begin(stop.clone(), &DoomCampaign::initial())
            .expect("begin");
        let status = stop_agent_on_window_close(&state).expect("a live run can be stopped");
        assert_eq!(status.phase, DoomAutoplayPhase::Stopping);
        assert!(status.running);
        assert!(stop.load(Ordering::Relaxed), "the cooperative flag is set");
    }
}
