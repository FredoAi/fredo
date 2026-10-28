//! Doom runtime lifecycle commands (Spec #2968 ST-3; Spec #3023 ST-2).
//!
//! Owns the **in-process native engine** end to end: `launch_doom_runtime`
//! (idempotent exactly-one session), `stop_doom_runtime` (take-and-drop),
//! `get_doom_status`, the parity control surface (`doom_read_state` / `doom_step`
//! / `doom_frame_raw`), and the synchronous teardown entry points wired to the window
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
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::infrastructure::comm::bus::EventBus;
use crate::infrastructure::companion::doom_decision::DoomDecisionSourceState;
use crate::infrastructure::companion::PerformanceModeState;
use crate::infrastructure::storage::application_store::DynamicTableStore;
use crate::infrastructure::storage::SettingsStore;

use super::agent::{run_continuous_loop_with_writer, AutoplayControl, AutoplayRun, DoomAutoplayConfig};
use super::dataset::{
    self, DoomDatasetConfig, DoomDatasetError, DoomDatasetExportResult, DoomDatasetFormat,
    DoomDatasetStatus, DoomDatasetWriter, DOOM_DATASET_ENABLED_ENV, DOOM_DATASET_ENABLED_KEY,
};
use super::autoplay::{
    DoomAutoplayErrorCode, DoomAutoplayPhase, DoomAutoplayResult, DoomAutoplayStatus,
};
use super::clock::TokioTickClock;
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
    DOOM_LAST_ERROR_CODE_KEY, DOOM_LAST_ERROR_KEY, DOOM_STATUS_EVENT, DOOM_WINDOW_LABEL,
};

/// The default campaign map the native engine constructs at (E1M1).
const DOOM_DEFAULT_MAP: i64 = 1;
/// The default skill (matches the retired launch argv `-skill 3`).
const DOOM_DEFAULT_SKILL: i64 = 3;

// ── Command wire models (Spec #3023 ST-2) ─────────────────────────────────────
//
// The response shapes the `doom` window consumes. Moved here from the retired
// HTTP client (`client.rs`) so the command surface no longer depends on it; the
// camelCase wire shapes are unchanged (`{raw}` / `{state}`).

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

    /// Map a typed dataset error onto the command error surface (Spec #3032
    /// ST-3): an empty dataset is a clear `requestFailed` with a descriptive
    /// message and no partial file; any other dataset failure carries its detail.
    pub fn from_dataset(error: DoomDatasetError) -> Self {
        match error {
            DoomDatasetError::Empty => Self::new(
                DoomErrorCode::RequestFailed,
                "the dataset is empty — there is nothing to export",
            ),
            DoomDatasetError::Io(detail) => Self::new(
                DoomErrorCode::RequestFailed,
                format!("dataset export failed: {detail}"),
            ),
        }
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
    let store = app.state::<Arc<SettingsStore>>();
    let _ = store.cached_set(DOOM_LAST_ERROR_KEY, message);
    let _ = store.cached_set(DOOM_LAST_ERROR_CODE_KEY, code.as_str());
}

fn clear_last_error(app: &AppHandle) {
    let store = app.state::<Arc<SettingsStore>>();
    let _ = store.cached_set(DOOM_LAST_ERROR_KEY, "");
    let _ = store.cached_set(DOOM_LAST_ERROR_CODE_KEY, "");
}

fn read_last_error(app: &AppHandle) -> (Option<String>, Option<DoomErrorCode>) {
    let store = app.state::<Arc<SettingsStore>>();
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

/// The current frame as raw RGBA bytes (`320 * 200 * 4 = 256_000`), row-major,
/// byte order R, G, B, A — NO PNG and NO base64 (Spec #3026 ST-4). The webview
/// receives the bytes as an `ArrayBuffer`, wraps them in an `ImageData`, and
/// draws with `putImageData` on a ≥30 fps cadence.
#[tauri::command]
pub async fn doom_frame_raw(app: AppHandle) -> Result<tauri::ipc::Response, DoomCommandError> {
    let state = app.state::<DoomEngineState>().inner().clone();
    if !state.is_running() {
        return Err(DoomCommandError::not_running());
    }
    run_engine(move || state.frame_rgba())
        .await
        .map(tauri::ipc::Response::new)
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
        escapes: 0,
        failures: 0,
        consecutive_failures: 0,
        stuck_ticks: 0,
        plans: 0,
        replans: 0,
        plan_index: 0,
        last_tic: None,
        outcome: None,
        episode: None,
        map: None,
        completed: false,
        degraded: false,
        started_at: None,
        last_error: None,
        code: None,
        kills: 0,
        engagements: 0,
        items_collected: 0,
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
        completed: campaign.completed,
        degraded: false,
        started_at: Some(chrono::Utc::now().to_rfc3339()),
        last_error: None,
        code: None,
        kills: 0,
        engagements: 0,
        items_collected: 0,
    }
}

/// The bounded autoplay config for the continuous loop: the `maxSteps` argument
/// (then the `FREDO_DOOM_AGENT_MAX_STEPS` seam, kept for compat) maps onto the
/// continuous TICK budget; unset falls back to the binding default. The
/// remaining budgets honour their env seams over the defaults.
fn autoplay_config(max_steps: Option<u32>) -> DoomAutoplayConfig {
    let base = DoomAutoplayConfig::default();
    let ticks = max_steps
        .or_else(decision::max_steps_from_env)
        .unwrap_or(base.max_ticks);
    DoomAutoplayConfig {
        max_steps: ticks,
        max_ticks: ticks,
        max_failures: decision::max_failures_from_env().unwrap_or(base.max_failures),
        combat_low_health: None,
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

/// Start the bounded Doom autoplay **continuous** loop (Spec #2969 ST-5;
/// Spec #3026 ST-4 wires the production clock).
///
/// Runs `run_continuous_loop` paced by the production `TokioTickClock`: the world
/// advances every tick independent of the model decision, so motion never stops
/// while a decision is in flight (R-1).
///
/// Idempotent: a live run wins immediately and a second loop is never spawned.
/// When the native engine has no live session or the composition root installed
/// no decision source, returns a typed `code = NotReady` result with **NO engine
/// request** (F-32). The `doom-autoplay-changed` event (not this result) is the
/// source of truth for `running`; the result only reports the start.
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

    // Readiness — a live native engine session must exist. Not ready ⇒ typed
    // `NotReady` with NO engine request (F-32).
    let engine = app.state::<DoomEngineState>().inner().clone();
    if !engine.is_running() {
        return not_ready("the Doom engine is not ready — start the engine, then try again.");
    }

    // The composition root installs the decision source; absent ⇒ `NotReady`.
    let Some(source) = app.state::<DoomDecisionSourceState>().get() else {
        return not_ready("no Doom decision source is installed.");
    };

    // Opt-in capture gate (Spec #3032 ST-3, R-5): resolve the persisted KV (the
    // `FREDO_DOOM_DATASET_ENABLED` env override wins) and, when ON, build the ONE
    // shared dataset writer and hand it to the loop (ST-2), so the assembler
    // appends through the SAME instance the export IPC reads — a single
    // `export_in_progress` guard defers eviction for both (AC3). OFF ⇒ no writer
    // is built and no dataset file is ever created.
    let dataset_enabled =
        dataset_enabled_from_store(app.state::<Arc<SettingsStore>>().inner().as_ref());
    let dataset_writer =
        dataset_enabled.then(|| app.state::<Arc<DoomDatasetState>>().writer());

    // Resolve the campaign to play (Spec #2972 R-1/R-5): an explicit fresh start
    // → the campaign initial; otherwise a valid loaded save, else the initial.
    // A `completed:true` save is preserved and reported terminal at start
    // (G-321) — never a silent fresh run. The save lives in the dedicated
    // `feature_doom_save` PostgreSQL feature table (Spec #3011).
    let store = app.state::<Arc<DynamicTableStore>>().inner().clone();
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

    // Spawn the bounded continuous loop over the native in-process engine,
    // paced by the production `TokioTickClock`. Every status transition is folded
    // into the state and published; the terminal observation clears the
    // live-run marker. Teardown stays bounded: the loop checks the shared stop
    // flag every tick (G-263).
    let loop_app = app.clone();
    let observe_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let source_ref: &dyn crate::infrastructure::companion::doom_decision::DoomDecisionSource =
            source.as_ref();
        let clock = TokioTickClock::new(config.tick_period);
        run_continuous_loop_with_writer(
            &engine,
            source_ref,
            &config,
            &clock,
            AutoplayRun { campaign, progress },
            AutoplayControl {
                stop: stop.as_ref(),
                dataset: dataset_writer,
            },
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
    let store = app.state::<Arc<DynamicTableStore>>().inner().clone();
    save::load(&store)
        .map(|saved| DoomSaveStatus::from_save(&saved))
        .unwrap_or_else(DoomSaveStatus::absent)
}

/// Explicitly discard the persisted resume point (Spec #2972). Idempotent; always
/// reports `hasSave:false` afterwards. A clear failure is logged, never fatal.
#[tauri::command]
pub fn reset_doom_save(app: AppHandle) -> DoomSaveStatus {
    let store = app.state::<Arc<DynamicTableStore>>().inner().clone();
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

// ── Fine-tuning dataset opt-in + export (Spec #3032 ST-3) ─────────────────────
//
// The capture gate's SINGLE source of truth is the Rust-readable SettingsStore KV
// [`DOOM_DATASET_ENABLED_KEY`] (`doom_dataset_enabled`), written by
// `set_doom_dataset_enabled` and read by the start path; the
// [`DOOM_DATASET_ENABLED_ENV`] env seam overrides it for tests (G-275, inert when
// unset). A frontend `usePersistedSetting` localStorage value is NOT readable by
// the Rust loop, so the opt-in is persisted here (default OFF).
//
// The ONE shared [`DoomDatasetWriter`] lives in the Tauri-managed
// [`DoomDatasetState`] (resolved from the app-data dir via
// `resolve_app_data_dir` + `resolve_dataset_dir`), so the loop assembler (ST-2)
// and the export IPC share a single `export_in_progress` guard — an in-flight
// export DEFERS the writer's retention eviction (AC3). Default OFF builds no
// writer and creates no dataset file (R-5). The export is LOCAL-ONLY: `std::fs`
// writes the target file and performs NO network I/O (R-4, no egress).

/// The Tauri-managed dataset state: the resolved dataset directory plus the ONE
/// shared writer, built lazily (never before capture is enabled or an export is
/// requested — so a default-off install creates no dataset file; R-5).
pub struct DoomDatasetState {
    inner: Mutex<DoomDatasetInner>,
}

struct DoomDatasetInner {
    /// The resolved dataset directory (`FREDO_DOOM_DATASET_DIR` override honoured
    /// once at construction).
    dir: PathBuf,
    /// The shared writer, built on first use and cheap to clone (an `Arc`
    /// interior). `None` until capture is enabled or an export is requested.
    writer: Option<DoomDatasetWriter>,
}

impl DoomDatasetState {
    /// Build the state from the app-data dir, resolving the dataset directory
    /// once via ST-1's [`resolve_dataset_dir`](super::dataset::resolve_dataset_dir)
    /// (the `FREDO_DOOM_DATASET_DIR` test override wins). Builds NO writer and
    /// creates no directory/file (R-5).
    pub fn new(app_data_dir: &Path) -> Self {
        Self {
            inner: Mutex::new(DoomDatasetInner {
                dir: dataset::resolve_dataset_dir(app_data_dir),
                writer: None,
            }),
        }
    }

    fn lock(&self) -> MutexGuard<'_, DoomDatasetInner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The resolved dataset directory.
    pub fn dir(&self) -> PathBuf {
        self.lock().dir.clone()
    }

    /// The ONE shared writer, built on first use. `DoomDatasetWriter::new`
    /// performs no directory/file I/O (a read-only scan at most), so building it
    /// never violates R-5. Sharing the instance with the loop (ST-2) and the
    /// export IPC gives ONE `export_in_progress` guard for both (AC3).
    pub fn writer(&self) -> DoomDatasetWriter {
        let mut inner = self.lock();
        if let Some(writer) = &inner.writer {
            return writer.clone();
        }
        let writer = DoomDatasetWriter::new(DoomDatasetConfig::from_env(inner.dir.clone()));
        inner.writer = Some(writer.clone());
        writer
    }

    /// The status snapshot for the given opt-in `enabled` value. Reads the
    /// on-disk counts through the shared writer when it exists, else a transient
    /// read-only writer — a disabled gate never caches a writer.
    pub fn status(&self, enabled: bool) -> DoomDatasetStatus {
        let (dir, existing) = {
            let inner = self.lock();
            (inner.dir.clone(), inner.writer.clone())
        };
        match existing {
            Some(writer) => writer.status(enabled),
            None => DoomDatasetWriter::new(DoomDatasetConfig::from_env(dir)).status(enabled),
        }
    }
}

/// Resolve the capture gate: a non-blank [`DOOM_DATASET_ENABLED_ENV`] override
/// wins (G-275 test seam); otherwise the persisted KV; default OFF. Pure.
pub fn dataset_enabled_from(kv_value: Option<&str>, env_value: Option<&str>) -> bool {
    match env_value.filter(|value| !value.trim().is_empty()) {
        Some(value) => dataset::flag_from_value(Some(value)),
        None => dataset::flag_from_value(kv_value),
    }
}

/// Read the capture gate from the persisted store KV + the process env override.
pub fn dataset_enabled_from_store(store: &SettingsStore) -> bool {
    let kv = store
        .cached_get(DOOM_DATASET_ENABLED_KEY)
        .ok()
        .flatten();
    let env = std::env::var(DOOM_DATASET_ENABLED_ENV).ok();
    dataset_enabled_from(kv.as_deref(), env.as_deref())
}

/// Resolve an export target path: a relative `out` is joined to the dataset dir
/// (never the process CWD); an absolute `out` is honoured verbatim; `None` uses
/// ST-1's default `<dir>/exports/…` path. Pure.
pub fn resolve_export_target(writer: &DoomDatasetWriter, out: Option<&str>) -> Option<PathBuf> {
    let out = out?;
    let path = Path::new(out);
    if path.is_absolute() {
        Some(path.to_path_buf())
    } else {
        Some(writer.dir().join(path))
    }
}

/// Drive ST-1's exporter for the command surface (IPC-free so it is unit
/// testable): resolve a relative `out`, map the typed dataset error onto
/// [`DoomCommandError`]. Writes ONLY the target file locally (no egress).
pub fn export_dataset(
    writer: &DoomDatasetWriter,
    format: DoomDatasetFormat,
    out: Option<&str>,
) -> Result<DoomDatasetExportResult, DoomCommandError> {
    let target = resolve_export_target(writer, out);
    writer
        .export(format, target.as_deref())
        .map_err(DoomCommandError::from_dataset)
}

/// Read-only dataset status (the opt-in gate + the on-disk record/byte counts).
/// The on-disk scan runs off the main thread; it never creates a file.
#[tauri::command]
pub async fn get_doom_dataset_status(app: AppHandle) -> DoomDatasetStatus {
    let enabled = dataset_enabled_from_store(app.state::<Arc<SettingsStore>>().inner().as_ref());
    let state = app.state::<Arc<DoomDatasetState>>().inner().clone();
    let fallback_dir = state.dir().to_string_lossy().into_owned();
    tauri::async_runtime::spawn_blocking(move || state.status(enabled))
        .await
        .unwrap_or(DoomDatasetStatus {
            enabled,
            dir: fallback_dir,
            records: 0,
            bytes: 0,
        })
}

/// Persist the opt-in capture gate ([`DOOM_DATASET_ENABLED_KEY`]) and return the
/// status. Enabling builds the shared writer; disabling NEVER deletes existing
/// records (retention is the only deletion path).
#[tauri::command]
pub async fn set_doom_dataset_enabled(app: AppHandle, enabled: bool) -> DoomDatasetStatus {
    let store = app.state::<Arc<SettingsStore>>().inner().clone();
    let state = app.state::<Arc<DoomDatasetState>>().inner().clone();
    let fallback_dir = state.dir().to_string_lossy().into_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let value = if enabled { "true" } else { "false" };
        if let Err(error) = store.cached_set(DOOM_DATASET_ENABLED_KEY, value) {
            tracing::warn!(
                target: "fredo::doom",
                %error,
                "doom dataset opt-in persistence failed"
            );
        }
        if enabled {
            // R-5: the writer is built ONLY once capture is enabled; the disabled
            // path leaves it unbuilt, so no dataset file is ever created.
            state.writer();
        }
        state.status(enabled)
    })
    .await
    .unwrap_or(DoomDatasetStatus {
        enabled,
        dir: fallback_dir,
        records: 0,
        bytes: 0,
    })
}

/// Export the dataset locally in `format` (default `raw`) to `out` (default
/// ST-1's `<dir>/exports/…` path). LOCAL-ONLY: no network I/O; the source files
/// are never mutated; an empty dataset is a typed error with no partial file
/// (R-4).
#[tauri::command]
pub async fn export_doom_dataset(
    app: AppHandle,
    format: Option<DoomDatasetFormat>,
    out: Option<String>,
) -> Result<DoomDatasetExportResult, DoomCommandError> {
    let state = app.state::<Arc<DoomDatasetState>>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let writer = state.writer();
        export_dataset(&writer, format.unwrap_or_default(), out.as_deref())
    })
    .await
    .unwrap_or_else(|join_error| {
        Err(DoomCommandError::new(
            DoomErrorCode::RequestFailed,
            format!("the dataset export task failed: {join_error}"),
        ))
    })
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
    DoomModeResult {
        success,
        phase: status.phase,
        active: status.active,
        voice_suppressed: status.voice_suppressed,
        origin: status.origin,
        error,
        code,
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

    // 1. Runtime (idempotent exactly-one launch + bounded readiness).
    let launch = launch_doom_runtime(app.clone()).await;
    if !launch.success {
        // Round-2 fix (F-11 / F-12, AC5): the `doom` window is the ONLY typed
        // error surface, so open it BEFORE rolling the mode back. Its own mount
        // re-runs `launch_doom_runtime` through the SAME failure lever and
        // renders `engineStartFailed` / `wadMissing` / `wadCorrupt` in-window
        // (`DoomWindow.tsx`). Singleton (focus-if-exists); a window opened here
        // still tears down bounded via its `CloseRequested` handler (REQ-5.3).
        // Best-effort — never mask the original launch error. The mode rollback
        // in `fail_enter` (→ inactive, suppression off, `doom-mode-changed`) is
        // unchanged.
        if let Err(detail) = open_doom_window(app.clone()).await {
            tracing::warn!(
                target: "fredo::doom",
                detail,
                "could not open the doom window on the engine-launch failure branch"
            );
        }
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
    use super::dataset::{DoomDatasetRecord, DOOM_DATASET_FILE, DOOM_DATASET_SUBDIR};
    use super::*;
    use crate::infrastructure::storage::engine::EngineHandle;

    fn open_store(dir: &std::path::Path) -> SettingsStore {
        SettingsStore::open(EngineHandle::new_pending(), dir).expect("open app store")
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
        // The `maxSteps` argument maps onto the continuous tick budget and wins.
        assert_eq!(autoplay_config(Some(7)).max_ticks, 7);
        assert_eq!(autoplay_config(Some(7)).max_steps, 7);

        // With no argument and no env seam, the binding defaults are used.
        if std::env::var(decision::DOOM_AGENT_MAX_STEPS_ENV).is_err() {
            assert_eq!(autoplay_config(None).max_ticks, base.max_ticks);
        }
        if std::env::var(decision::DOOM_AGENT_MAX_FAILURES_ENV).is_err() {
            assert_eq!(autoplay_config(None).max_failures, base.max_failures);
        }
    }

    // ── AC5 completion target wiring (Spec #3039 ST-5) ───────────────────────

    #[test]
    fn the_start_path_positions_at_the_ac5_target_from_a_target_save_and_e1m1_fresh() {
        // `start_doom_autoplay` resolves the campaign from the persisted save
        // (`save::resolve_start_campaign`) then seeds `running_status` from it.
        // A `feature_doom_save` written at the AC5 target resumes there; an
        // explicit fresh start (or an absent save) still starts at E1M1.
        let resumed =
            save::resolve_start_campaign(Some(false), Some(save::completion_target_campaign()));
        let status = running_status(&resumed);
        assert_eq!(status.map, Some(save::DOOM_COMPLETION_TARGET_MAP));
        assert_eq!(status.episode, Some(save::DOOM_CAMPAIGN_FIRST_EPISODE));

        // The resume path uses the PERSISTED map, never the fresh default — a save
        // at a different map resumes there.
        let other = save::DoomCampaign {
            map: save::DOOM_COMPLETION_TARGET_MAP + 1,
            ..save::completion_target_campaign()
        };
        let resumed_other = running_status(&save::resolve_start_campaign(Some(false), Some(other)));
        assert_eq!(resumed_other.map, Some(save::DOOM_COMPLETION_TARGET_MAP + 1));

        let fresh = running_status(&save::resolve_start_campaign(
            Some(true),
            Some(save::completion_target_campaign()),
        ));
        assert_eq!(
            fresh.map,
            Some(DOOM_DEFAULT_MAP),
            "a fresh run still starts at E1M1"
        );
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

    // ── Dataset opt-in + export (Spec #3032 ST-3) ────────────────────────────

    /// One valid reconciled record line for the export tests.
    fn sample_record_line() -> String {
        serde_json::json!({
            "v": 1,
            "runId": "run-1",
            "episodeId": "run-1:e1-m1",
            "decisionId": "run-1:1",
            "ts": "2026-10-12T00:00:00Z",
            "tic": 1,
            "stepIndex": 0,
            "source": "scripted",
            "level": { "episode": 1, "map": 1, "skill": 3, "wadId": "DOOM1.WAD" },
            "model": { "schemaVersion": "doom_plan" },
            "observation": { "tic": 1 },
            "decision": { "plan": [ { "op": "move", "bearing": 90, "distance": 256 } ] },
            "latencyMs": 5,
            "execution": {
                "adoptedTic": 1,
                "exhaustedTic": 2,
                "plannedSteps": 1,
                "executedSteps": 1,
                "steps": [ {
                    "index": 0,
                    "controller": "plan",
                    "actions": [ { "type": "forward", "amount": 1 } ],
                    "tics": 1
                } ],
                "replans": []
            },
            "nextState": { "tic": 2 },
            "reward": {
                "dKills": 1, "dItems": 0, "dSecrets": 0, "dHealth": 0,
                "dDistanceToExit": null, "moved": true
            },
            "terminal": null
        })
        .to_string()
    }

    fn seeded_writer() -> (tempfile::TempDir, DoomDatasetWriter) {
        let dir = tempfile::tempdir().expect("tempdir");
        let writer = DoomDatasetWriter::new(DoomDatasetConfig::new(dir.path()));
        let record = DoomDatasetRecord::from_json_line(&sample_record_line()).expect("record");
        writer.append(&record).expect("append");
        (dir, writer)
    }

    #[test]
    fn the_dataset_gate_defaults_off_and_the_env_override_flips_it() {
        // Default OFF: no persisted KV row and no env override.
        assert!(!dataset_enabled_from(None, None));
        // The persisted KV (the SINGLE source of truth) drives it.
        assert!(dataset_enabled_from(Some("true"), None));
        assert!(dataset_enabled_from(Some("1"), None));
        assert!(!dataset_enabled_from(Some("false"), None));
        assert!(!dataset_enabled_from(Some("garbage"), None));
        // The env override wins in BOTH directions (G-275); a blank env is inert
        // (it falls through to the persisted KV).
        assert!(dataset_enabled_from(Some("false"), Some("1")));
        assert!(!dataset_enabled_from(Some("true"), Some("0")));
        assert!(!dataset_enabled_from(None, Some("")));
        assert!(dataset_enabled_from(Some("true"), Some("   ")));
    }

    #[test]
    fn the_dataset_enabled_key_is_the_rust_readable_source_of_truth() {
        assert_eq!(DOOM_DATASET_ENABLED_KEY, "doom_dataset_enabled");
        assert_eq!(DOOM_DATASET_ENABLED_ENV, "FREDO_DOOM_DATASET_ENABLED");
    }

    #[test]
    fn a_disabled_gate_builds_no_writer_and_creates_no_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let state = DoomDatasetState::new(dir.path());
        assert!(
            !dir.path().join(DOOM_DATASET_SUBDIR).join(DOOM_DATASET_FILE).exists(),
            "constructing the state for a disabled gate creates no dataset file"
        );
        // A status read (disabled) reports OFF and zero records.
        let status = state.status(false);
        assert!(!status.enabled);
        assert_eq!(status.records, 0);
        assert_eq!(status.bytes, 0);
    }

    #[test]
    fn export_writes_the_target_file_and_returns_the_typed_result() {
        let dir = tempfile::tempdir().expect("tempdir");
        let writer = DoomDatasetWriter::new(DoomDatasetConfig::new(dir.path()));
        let record = DoomDatasetRecord::from_json_line(&sample_record_line()).expect("record");
        writer.append(&record).expect("append");
        // The active file is ST-1's canonical re-serialization of the record.
        let expected = record.json_line().expect("re-serialize");
        // A relative `out` resolves against the DATASET DIR (never the CWD).
        let result =
            export_dataset(&writer, DoomDatasetFormat::Raw, Some("out.jsonl")).expect("export");
        assert_eq!(result.format, DoomDatasetFormat::Raw);
        assert_eq!(Path::new(&result.path), dir.path().join("out.jsonl"));
        assert_eq!(result.records, 1);
        assert!(result.bytes > 0);
        let written = std::fs::read_to_string(&result.path).expect("read export");
        assert_eq!(written.trim_end(), expected);
    }

    #[test]
    fn export_of_an_empty_dataset_is_a_typed_error_with_no_partial_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let writer = DoomDatasetWriter::new(DoomDatasetConfig::new(dir.path()));
        let target = dir.path().join("empty.jsonl");
        let error = export_dataset(
            &writer,
            DoomDatasetFormat::Raw,
            Some(target.to_str().expect("utf8")),
        )
        .expect_err("an empty dataset exports to a typed error");
        assert_eq!(error.code, DoomErrorCode::RequestFailed);
        assert!(error.message.contains("empty"));
        // The empty path never writes a partial file.
        assert!(!target.exists());
    }

    #[test]
    fn a_relative_out_never_escapes_to_the_process_cwd() {
        let (dir, writer) = seeded_writer();
        assert_eq!(
            resolve_export_target(&writer, Some("nested/a.jsonl")),
            Some(dir.path().join("nested/a.jsonl"))
        );
        let absolute = dir.path().join("abs.jsonl");
        assert_eq!(
            resolve_export_target(&writer, Some(absolute.to_str().expect("utf8"))),
            Some(absolute)
        );
        // No `out` falls through to ST-1's default `<dir>/exports/…` path.
        assert_eq!(resolve_export_target(&writer, None), None);
    }

    #[test]
    fn export_is_local_only_and_never_mutates_the_source() {
        // NFR-3 (no egress) at the unit level: the export path is `std::fs` only
        // — it writes the target synchronously and returns; no socket or child
        // process is constructed. (The live absence-of-socket proof is QA's
        // netstat / process-inventory leg.) Here we pin that the export writes
        // ONLY the local target and leaves the source byte-identical.
        let (dir, writer) = seeded_writer();
        let source = dir.path().join(DOOM_DATASET_FILE);
        let before = std::fs::read(&source).expect("read source");
        let result =
            export_dataset(&writer, DoomDatasetFormat::Raw, Some("copy.jsonl")).expect("export");
        let after = std::fs::read(&source).expect("read source");
        assert_eq!(before, after, "the export never mutates a source file");
        assert!(Path::new(&result.path).starts_with(dir.path()));
        assert_eq!(
            std::fs::read(&result.path).expect("read export"),
            before,
            "raw export is the source JSONL verbatim"
        );
    }
}
