//! Companion `llama-server` lifecycle commands (Spec #2857, ST-3; EARS R-2, R-4).
//!
//! Four Tauri commands own the out-of-process server end to end:
//!
//! * [`generate_llama_server_config`] — build the launch config from persisted
//!   settings and materialize the `.bat` (AC1 evidence without launching),
//! * [`launch_llama_server`] — generate → resolve executable → spawn → bounded
//!   `/health` poll → record the managed server; idempotent when already healthy,
//!   ALWAYS resolves (never hangs),
//! * [`stop_llama_server`] — kill the process tree and clear the managed state,
//! * [`get_llama_server_status`] — the UI/QA poll target.
//!
//! Registration in `lib.rs` is owned by ST-4; chat routing by ST-4; the
//! exit hook / orphan sweep by ST-7. This module does NOT use a Tauri sidecar
//! (`new_sidecar`/`externalBin`) — the child is a plain `std::process::Command`.

use std::path::{Path, PathBuf};
use std::sync::{Arc, MutexGuard};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::infrastructure::companion::models::{
    file_path, is_step_complete, missing_files, resolve_manifest, resolve_models_dir,
    ModelManifest,
};
use crate::infrastructure::companion::resolve_llama_server;
use crate::infrastructure::storage::AppStore;

use super::chat::{self, LlmMessage};
use super::config::LlamaServerConfig;
use super::health::{self, HealthProbeSource, ReqwestHealthClient};
use super::process;
use super::state::{LlamaServerState, ManagedServer};
use super::{
    DEFAULT_LLAMA_SERVER_HEALTH_TIMEOUT_S, DEFAULT_LLAMA_SERVER_HOST, DEFAULT_LLAMA_SERVER_PORT,
    LLAMA_SERVER_ACTIVE_PORT_KEY, LLAMA_SERVER_ARGS_KEY, LLAMA_SERVER_HEALTH_TIMEOUT_S_KEY,
    LLAMA_SERVER_HOST_KEY, LLAMA_SERVER_LOG_PATH_KEY, LLAMA_SERVER_MMPROJ_PATH_KEY,
    LLAMA_SERVER_MODEL_PATH_KEY, LLAMA_SERVER_MTP_PATH_KEY, LLAMA_SERVER_PORT_KEY,
    LLAMA_SERVER_STARTED_AT_KEY,
};

// ── Internal settings keys ────────────────────────────────────────────────────

/// AppStore key for the last launch error, surfaced by `get_llama_server_status`.
/// Internal to this feature — not part of the persisted-settings contract.
const LLAMA_SERVER_LAST_ERROR_KEY: &str = "llama_server_last_error";

/// Maximum characters of the server log included in a health-timeout error.
const LOG_TAIL_CHARS: usize = 400;

// ── Wire models (camelCase, IPC) ──────────────────────────────────────────────

/// Why a launch could not reach a healthy server.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum LlamaServerLaunchCode {
    SpawnFailed,
    PortInUse,
    HealthTimeout,
    NotConfigured,
}

/// The launch state vocabulary, wire-identical to `features::setup`'s
/// `PrerequisiteState` (`installed` / `missing` / `error`). Declared locally
/// because a cross-FEATURE import is forbidden (`AGENTS.md`); the JSON shape is
/// deliberately the same so the wizard can consume either.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum PrerequisiteState {
    Installed,
    Missing,
    Error,
}

/// Result of [`launch_llama_server`] — always returned, never a hang.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LlamaServerLaunchResult {
    pub success: bool,
    pub state: PrerequisiteState,
    pub detail: String,
    pub port: Option<u16>,
    pub config_path: String,
    pub error: Option<String>,
    pub code: Option<LlamaServerLaunchCode>,
}

/// Status snapshot for the UI/QA poll target.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LlamaServerStatus {
    pub running: bool,
    pub healthy: bool,
    pub port: Option<u16>,
    pub pid: Option<u32>,
    pub config_path: String,
    pub log_path: String,
    pub last_error: Option<String>,
}

/// The generated launch config plus its materialized path and contents.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LlamaServerConfigPreview {
    pub config: LlamaServerConfig,
    pub path: String,
    pub contents: String,
}

// ── Settings access (AppStore is the single source of truth) ──────────────────

fn get_setting(app: &AppHandle, key: &str) -> Option<String> {
    app.state::<Arc<AppStore>>()
        .get(key)
        .ok()
        .flatten()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn set_setting(app: &AppHandle, key: &str, value: &str) {
    let _ = app.state::<Arc<AppStore>>().set(key, value);
}

fn get_u16(app: &AppHandle, key: &str, default: u16) -> u16 {
    get_setting(app, key)
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

fn get_u64(app: &AppHandle, key: &str, default: u64) -> u64 {
    get_setting(app, key)
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

/// A persisted override when set, else the absolute path derived from the SHARED
/// #2856 manifest (`<models_dir>/<subdir>/<spec.path>` — NFR-6, one path rule).
/// `file_id` is the manifest id (`model` | `vision` | `mtp`).
fn resolve_model_path(
    app: &AppHandle,
    override_key: &str,
    models_dir: &Path,
    manifest: &ModelManifest,
    file_id: &str,
) -> String {
    if let Some(override_path) = get_setting(app, override_key) {
        return override_path;
    }
    manifest
        .files
        .iter()
        .find(|spec| spec.id == file_id)
        .map(|spec| {
            file_path(models_dir, manifest, spec)
                .to_string_lossy()
                .into_owned()
        })
        .unwrap_or_default()
}

/// R-1c: a config is never valid/launchable while a required model file is
/// absent. Uses the SHARED #2856 manifest as the single rule source and NAMES
/// the missing file(s). `None` means every required file is present.
fn missing_model_files_detail(models_dir: &Path, manifest: &ModelManifest) -> Option<String> {
    if is_step_complete(models_dir, manifest) {
        return None;
    }
    let missing: Vec<String> = missing_files(models_dir, manifest)
        .into_iter()
        .map(|status| status.relative_path)
        .collect();
    if missing.is_empty() {
        Some("missing model file(s): model manifest declares no required files".to_string())
    } else {
        Some(format!("missing model file(s): {}", missing.join(", ")))
    }
}

/// The optional persisted parameter subset (`llama_server_args`). Every field is
/// optional; unset fields keep the ST-2 [`LlamaServerConfig::default`] value.
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct LlamaServerArgsOverride {
    host: Option<String>,
    port: Option<u16>,
    spec_type: Option<String>,
    spec_draft_n_max: Option<u32>,
    fit: Option<String>,
    load_mode: Option<String>,
    gpu_layers: Option<String>,
    threads: Option<u32>,
    threads_batch: Option<u32>,
    reasoning: Option<String>,
    ctx_size: Option<u32>,
    temp: Option<f32>,
    top_p: Option<f32>,
    top_k: Option<u32>,
    parallel: Option<u32>,
    kv_unified: Option<bool>,
    log_verbosity: Option<u32>,
    alias: Option<String>,
}

/// Overlay the persisted `llama_server_args` JSON onto `base`. A blank/absent
/// value is a no-op; malformed JSON is a hard error (never a silently-ignored
/// config). Pure — unit-tested without a Tauri app.
fn apply_args_override(base: &mut LlamaServerConfig, json: Option<&str>) -> Result<(), String> {
    let raw = match json {
        Some(raw) if !raw.trim().is_empty() => raw,
        _ => return Ok(()),
    };
    let over: LlamaServerArgsOverride = serde_json::from_str(raw)
        .map_err(|e| format!("invalid {LLAMA_SERVER_ARGS_KEY} JSON: {e}"))?;

    if let Some(value) = over.host {
        base.host = value;
    }
    if let Some(value) = over.port {
        base.port = value;
    }
    if let Some(value) = over.spec_type {
        base.spec_type = value;
    }
    if let Some(value) = over.spec_draft_n_max {
        base.spec_draft_n_max = value;
    }
    if let Some(value) = over.fit {
        base.fit = value;
    }
    if let Some(value) = over.load_mode {
        base.load_mode = value;
    }
    if let Some(value) = over.gpu_layers {
        base.gpu_layers = value;
    }
    if let Some(value) = over.threads {
        base.threads = value;
    }
    if let Some(value) = over.threads_batch {
        base.threads_batch = value;
    }
    if let Some(value) = over.reasoning {
        base.reasoning = value;
    }
    if let Some(value) = over.ctx_size {
        base.ctx_size = value;
    }
    if let Some(value) = over.temp {
        base.temp = value;
    }
    if let Some(value) = over.top_p {
        base.top_p = value;
    }
    if let Some(value) = over.top_k {
        base.top_k = value;
    }
    if let Some(value) = over.parallel {
        base.parallel = value;
    }
    if let Some(value) = over.kv_unified {
        base.kv_unified = value;
    }
    if let Some(value) = over.log_verbosity {
        base.log_verbosity = value;
    }
    if let Some(value) = over.alias {
        base.alias = value;
    }
    Ok(())
}

/// Build the launch config from persisted settings. `executable` is already
/// resolved by the caller (ST-1 resolver); model paths fall back to the
/// `models_dir`-resolved absolute paths, and `llama_server_args` overlays the
/// reference defaults.
fn build_launch_config(app: &AppHandle, executable: &Path) -> Result<LlamaServerConfig, String> {
    let models_dir = resolve_models_dir(app);
    let manifest = resolve_manifest(app);
    let mut config = LlamaServerConfig {
        executable: executable.to_string_lossy().into_owned(),
        host: get_setting(app, LLAMA_SERVER_HOST_KEY)
            .unwrap_or_else(|| DEFAULT_LLAMA_SERVER_HOST.to_string()),
        port: get_u16(app, LLAMA_SERVER_PORT_KEY, DEFAULT_LLAMA_SERVER_PORT),
        model: resolve_model_path(
            app,
            LLAMA_SERVER_MODEL_PATH_KEY,
            &models_dir,
            &manifest,
            "model",
        ),
        mmproj: resolve_model_path(
            app,
            LLAMA_SERVER_MMPROJ_PATH_KEY,
            &models_dir,
            &manifest,
            "vision",
        ),
        model_draft: resolve_model_path(
            app,
            LLAMA_SERVER_MTP_PATH_KEY,
            &models_dir,
            &manifest,
            "mtp",
        ),
        ..LlamaServerConfig::default()
    };

    if let Some(json) = get_setting(app, LLAMA_SERVER_ARGS_KEY) {
        apply_args_override(&mut config, Some(&json))?;
    }
    Ok(config)
}

/// Map a resolver outcome to an executable path or the launch code explaining
/// the failure. Pure — the `NotConfigured` seam unit test hooks here.
fn executable_or_code(
    resolved: Result<Option<PathBuf>, String>,
) -> Result<PathBuf, (LlamaServerLaunchCode, String)> {
    match resolved {
        Ok(Some(path)) => Ok(path),
        Ok(None) => Err((
            LlamaServerLaunchCode::NotConfigured,
            "llama-server executable not found — install llama.cpp or set llama_server_path."
                .to_string(),
        )),
        Err(error) => Err((
            LlamaServerLaunchCode::NotConfigured,
            format!("could not resolve the llama-server executable: {error}"),
        )),
    }
}

/// `{app_data_dir}/companion/...` for the config and the log.
fn companion_paths(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve the app data dir: {e}"))?;
    Ok((process::config_path(&data_dir), process::log_path(&data_dir)))
}

/// Write `config.to_bat()` to `path` and return the preview. Pure seam — no Tauri.
fn materialize_config(
    config: &LlamaServerConfig,
    path: &Path,
) -> Result<LlamaServerConfigPreview, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
    }
    let contents = config.to_bat();
    std::fs::write(path, &contents)
        .map_err(|e| format!("could not write {}: {e}", path.display()))?;
    Ok(LlamaServerConfigPreview {
        config: config.clone(),
        path: path.to_string_lossy().into_owned(),
        contents,
    })
}

// ── Managed-state helpers ─────────────────────────────────────────────────────

/// A poisoned lock must never take down the app — recover the guard.
fn lock_state(state: &LlamaServerState) -> MutexGuard<'_, Option<ManagedServer>> {
    state
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// `Some((port, pid, log_path))` iff a live managed child exists. A child that
/// has exited is reaped out of the state.
fn running_snapshot(state: &LlamaServerState) -> Option<(u16, u32, PathBuf)> {
    let mut guard = lock_state(state);
    let alive = match guard.as_mut() {
        Some(server) => matches!(server.child.try_wait(), Ok(None)),
        None => false,
    };
    if !alive {
        if guard.is_some() {
            *guard = None;
        }
        return None;
    }
    guard
        .as_ref()
        .map(|server| (server.port, server.pid, server.log_path.clone()))
}

/// Kill and forget the managed server (used to reclaim an unhealthy slot).
fn stop_managed(app: &AppHandle) {
    let state = app.state::<LlamaServerState>();
    let mut guard = lock_state(state.inner());
    if let Some(mut server) = guard.take() {
        process::kill_process_tree(&mut server);
    }
}

/// Persist (or clear) the `llama_server_pid` marker through the SINGLE
/// implementation in [`process::persist_pid`], so the launch WRITE and the stop
/// CLEAR cannot drift (NFR-6, one implementation per rule).
fn persist_managed_pid(app: &AppHandle, pid: Option<u32>) {
    let store = app.state::<Arc<AppStore>>();
    process::persist_pid(store.inner(), pid);
}

/// A single bounded health probe (used for idempotency + status).
async fn health_probe_once(app: &AppHandle, port: u16) -> bool {
    let host = get_setting(app, LLAMA_SERVER_HOST_KEY)
        .unwrap_or_else(|| DEFAULT_LLAMA_SERVER_HOST.to_string());
    match ReqwestHealthClient::new() {
        Ok(client) => client.probe(&health::health_url(&host, port)).await.is_ready(),
        Err(_) => false,
    }
}

fn failure(
    code: LlamaServerLaunchCode,
    state: PrerequisiteState,
    detail: String,
    config_path: String,
    port: Option<u16>,
) -> LlamaServerLaunchResult {
    LlamaServerLaunchResult {
        success: false,
        state,
        error: Some(detail.clone()),
        detail,
        port,
        config_path,
        code: Some(code),
    }
}

/// Bounded `/health` wait for a freshly spawned server (R-4.2, never hang).
///
/// `Ok(())` = the server answered ready. `Err(result)` = the structured
/// `HealthTimeout` failure: `state: Error` (NEVER `Installed`), `code:
/// HealthTimeout`, and a detail carrying the bounded-timeout description plus
/// the server log tail. The function ALWAYS resolves within `timeout`; the
/// caller owns killing/discarding the child, so a timed-out launch never leaves
/// a left-running but "pending" server.
async fn wait_for_health<S: HealthProbeSource + ?Sized>(
    source: &S,
    url: &str,
    timeout: Duration,
    interval: Duration,
    config_path: &str,
    port: u16,
    log_path: &Path,
) -> Result<(), LlamaServerLaunchResult> {
    match health::wait_until_healthy(source, url, timeout, interval).await {
        Ok(()) => Ok(()),
        Err(last) => {
            let log_tail = process::read_log_tail(log_path, LOG_TAIL_CHARS);
            let detail = if log_tail.is_empty() {
                format!("llama-server started but {last}")
            } else {
                format!("llama-server started but {last}. Server log tail: {log_tail}")
            };
            Err(failure(
                LlamaServerLaunchCode::HealthTimeout,
                PrerequisiteState::Error,
                detail,
                config_path.to_string(),
                Some(port),
            ))
        }
    }
}

// ── Commands (NOT registered here — ST-4 owns `lib.rs`) ───────────────────────

/// Build the launch config from persisted settings and materialize the `.bat`.
#[tauri::command]
pub fn generate_llama_server_config(app: AppHandle) -> Result<LlamaServerConfigPreview, String> {
    // R-1c — never produce a "valid" config while a required model file is
    // absent. Checked first so the refusal is observable even when the
    // llama-server executable is not installed.
    if let Some(detail) =
        missing_model_files_detail(&resolve_models_dir(&app), &resolve_manifest(&app))
    {
        return Err(detail);
    }
    let executable = executable_or_code(resolve_llama_server(&app)).map_err(|(_, detail)| detail)?;
    let config = build_launch_config(&app, &executable)?;
    let (config_path, _log_path) = companion_paths(&app)?;
    materialize_config(&config, &config_path)
}

/// Launch `llama-server` and confirm readiness via a bounded `/health` poll.
///
/// Idempotent: when a live managed server already answers `/health`, returns
/// success immediately. ALWAYS resolves within the configured health timeout.
#[tauri::command]
pub async fn launch_llama_server(app: AppHandle) -> LlamaServerLaunchResult {
    let (config_path, log_path) = match companion_paths(&app) {
        Ok(paths) => paths,
        Err(detail) => {
            return failure(
                LlamaServerLaunchCode::SpawnFailed,
                PrerequisiteState::Error,
                detail,
                String::new(),
                None,
            );
        }
    };
    let config_path_string = config_path.to_string_lossy().into_owned();

    // R-1c — a missing required model file makes any launch doomed. Refuse and
    // name the missing file(s). Checked BEFORE resolving the executable so the
    // refusal (a models problem) is not masked by an absent llama-server binary.
    if let Some(detail) =
        missing_model_files_detail(&resolve_models_dir(&app), &resolve_manifest(&app))
    {
        set_setting(&app, LLAMA_SERVER_LAST_ERROR_KEY, &detail);
        return failure(
            LlamaServerLaunchCode::NotConfigured,
            PrerequisiteState::Missing,
            detail,
            config_path_string,
            None,
        );
    }

    // Idempotency — an already-healthy managed server wins immediately (R-2).
    let snapshot = {
        let state = app.state::<LlamaServerState>();
        running_snapshot(state.inner())
    };
    if let Some((port, pid, _log_path)) = snapshot {
        if health_probe_once(&app, port).await {
            set_setting(&app, LLAMA_SERVER_ACTIVE_PORT_KEY, &port.to_string());
            set_setting(&app, LLAMA_SERVER_LAST_ERROR_KEY, "");
            return LlamaServerLaunchResult {
                success: true,
                state: PrerequisiteState::Installed,
                detail: format!(
                    "llama-server already running on http://{}:{port} (pid {pid}).",
                    DEFAULT_LLAMA_SERVER_HOST
                ),
                port: Some(port),
                config_path: config_path_string,
                error: None,
                code: None,
            };
        }
        // Live child but not healthy — reclaim it before relaunching.
        stop_managed(&app);
    }

    // Resolve the executable (ST-1 resolver: configured → PATH → winget shim).
    let executable = match executable_or_code(resolve_llama_server(&app)) {
        Ok(path) => path,
        Err((code, detail)) => {
            set_setting(&app, LLAMA_SERVER_LAST_ERROR_KEY, &detail);
            return failure(
                code,
                PrerequisiteState::Missing,
                detail,
                config_path_string,
                None,
            );
        }
    };

    let mut config = match build_launch_config(&app, &executable) {
        Ok(config) => config,
        Err(detail) => {
            set_setting(&app, LLAMA_SERVER_LAST_ERROR_KEY, &detail);
            return failure(
                LlamaServerLaunchCode::NotConfigured,
                PrerequisiteState::Error,
                detail,
                config_path_string,
                None,
            );
        }
    };

    // Port: configured when free, else an OS-assigned fallback (R-2.3).
    let active_port = match process::select_active_port(&config.host, config.port) {
        Ok(port) => port,
        Err(e) => {
            let detail = format!(
                "port {} is in use and no fallback port could be selected: {e}",
                config.port
            );
            set_setting(&app, LLAMA_SERVER_LAST_ERROR_KEY, &detail);
            return failure(
                LlamaServerLaunchCode::PortInUse,
                PrerequisiteState::Error,
                detail,
                config_path_string,
                Some(config.port),
            );
        }
    };
    config.port = active_port;
    set_setting(&app, LLAMA_SERVER_ACTIVE_PORT_KEY, &active_port.to_string());

    // Regenerate the `.bat` from the SAME builder as the spawn argv (no drift).
    if let Err(detail) = materialize_config(&config, &config_path) {
        set_setting(&app, LLAMA_SERVER_LAST_ERROR_KEY, &detail);
        return failure(
            LlamaServerLaunchCode::SpawnFailed,
            PrerequisiteState::Error,
            detail,
            config_path_string,
            Some(active_port),
        );
    }

    // Spawn (std::process::Command; stdout/stderr → the log).
    let mut server = match process::spawn_server(&config, &log_path) {
        Ok(server) => server,
        Err(e) => {
            let detail = format!("failed to start {}: {e}", config.executable);
            set_setting(&app, LLAMA_SERVER_LAST_ERROR_KEY, &detail);
            return failure(
                LlamaServerLaunchCode::SpawnFailed,
                PrerequisiteState::Error,
                detail,
                config_path_string,
                Some(active_port),
            );
        }
    };
    let pid = server.pid;

    // Bounded /health poll — never hangs (R-4.2).
    let timeout_s = get_u64(
        &app,
        LLAMA_SERVER_HEALTH_TIMEOUT_S_KEY,
        DEFAULT_LLAMA_SERVER_HEALTH_TIMEOUT_S,
    );
    let url = health::health_url(&config.host, active_port);
    let client = match ReqwestHealthClient::new() {
        Ok(client) => client,
        Err(detail) => {
            process::kill_process_tree(&mut server);
            set_setting(&app, LLAMA_SERVER_LAST_ERROR_KEY, &detail);
            return failure(
                LlamaServerLaunchCode::SpawnFailed,
                PrerequisiteState::Error,
                detail,
                config_path_string,
                Some(active_port),
            );
        }
    };
    if let Err(result) = wait_for_health(
        &client,
        &url,
        Duration::from_secs(timeout_s),
        health::DEFAULT_HEALTH_POLL_INTERVAL,
        &config_path_string,
        active_port,
        &log_path,
    )
    .await
    {
        // On timeout the child is discarded — never a left-running "pending"
        // server (R-4.2). `result` already carries the `HealthTimeout` code,
        // `Error` state (never `Installed`), and the log-tail detail.
        process::kill_process_tree(&mut server);
        if let Some(detail) = &result.error {
            set_setting(&app, LLAMA_SERVER_LAST_ERROR_KEY, detail);
        }
        return result;
    }

    // Success — record the managed server + persisted markers.
    {
        let state = app.state::<LlamaServerState>();
        let mut guard = lock_state(state.inner());
        *guard = Some(server);
    }
    persist_managed_pid(&app, Some(pid));
    set_setting(&app, LLAMA_SERVER_STARTED_AT_KEY, &chrono::Utc::now().to_rfc3339());
    set_setting(&app, LLAMA_SERVER_LOG_PATH_KEY, &log_path.to_string_lossy());
    set_setting(&app, LLAMA_SERVER_LAST_ERROR_KEY, "");

    LlamaServerLaunchResult {
        success: true,
        state: PrerequisiteState::Installed,
        detail: format!(
            "llama-server running on http://{}:{active_port} (pid {pid}).",
            config.host
        ),
        port: Some(active_port),
        config_path: config_path_string,
        error: None,
        code: None,
    }
}

/// Kill the managed process tree and clear the managed state + PID markers.
#[tauri::command]
pub fn stop_llama_server(
    app: AppHandle,
    state: State<'_, LlamaServerState>,
) -> Result<(), String> {
    let mut guard = lock_state(state.inner());
    if let Some(mut server) = guard.take() {
        process::kill_process_tree(&mut server);
    }
    drop(guard);

    // Clear the PID marker through the SAME single implementation the launch
    // path writes with (NFR-6), then the remaining launch markers.
    persist_managed_pid(&app, None);
    for key in [LLAMA_SERVER_STARTED_AT_KEY, LLAMA_SERVER_ACTIVE_PORT_KEY] {
        set_setting(&app, key, "");
    }
    Ok(())
}

/// Status snapshot for the wizard/QA poll. `healthy` is a live bounded probe.
#[tauri::command]
pub async fn get_llama_server_status(
    app: AppHandle,
    state: State<'_, LlamaServerState>,
) -> Result<LlamaServerStatus, String> {
    let (config_path, log_path) = companion_paths(&app)
        .map(|(config, log)| {
            (
                config.to_string_lossy().into_owned(),
                log.to_string_lossy().into_owned(),
            )
        })
        .unwrap_or_else(|_| (String::new(), String::new()));

    let (running, port, pid, managed_log) = match running_snapshot(state.inner()) {
        Some((port, pid, log_path)) => (true, Some(port), Some(pid), Some(log_path)),
        None => (false, None, None, None),
    };
    let healthy = if running {
        match port {
            Some(port) => health_probe_once(&app, port).await,
            None => false,
        }
    } else {
        false
    };

    // Prefer the managed server's actual log path when one is running.
    let log_path = managed_log
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or(log_path);

    Ok(LlamaServerStatus {
        running,
        healthy,
        port,
        pid,
        config_path,
        log_path,
        last_error: get_setting(&app, LLAMA_SERVER_LAST_ERROR_KEY),
    })
}

// ── Rerouted chat/vision (ST-4) ───────────────────────────────────────────────
//
// SAME IPC names + argument shapes as the deleted in-process commands. The
// command returns immediately and the HTTP streaming happens on a background
// task: `llm-token` per delta, `llm-done` at the end, and the ADDITIVE
// `llm-error` readable line before `llm-done` on any failure (R-4, never hangs).

/// Stream a companion chat message through the managed server.
#[tauri::command]
pub fn llm_chat(messages: Vec<LlmMessage>, app: AppHandle) -> Result<(), String> {
    chat::spawn_chat(app, messages, None);
    Ok(())
}

/// Stream a companion vision chat: the image is attached to the last user message.
#[tauri::command]
pub fn llm_chat_with_image(
    messages: Vec<LlmMessage>,
    image_base64: String,
    app: AppHandle,
) -> Result<(), String> {
    chat::spawn_chat(app, messages, Some(image_base64));
    Ok(())
}

/// App-exit hook: terminate the managed server tree (Spec #2857, ST-4 owns the
/// hook mechanism here; ST-7 owns the PID sweep + the kill-on-exit test).
pub fn stop_llama_server_on_exit(app: &AppHandle) {
    stop_managed(app);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::companion::models::ModelFileSpec;
    use std::path::{Path, PathBuf};

    /// A small KB-scale manifest so tests never touch the 3.67 GB default.
    fn test_manifest(specs: &[(&str, &str, u64)]) -> ModelManifest {
        ModelManifest {
            revision: "test-rev".to_string(),
            subdir: "gemma-4-e2b-it-qat".to_string(),
            files: specs
                .iter()
                .map(|(id, path, expected)| ModelFileSpec {
                    id: (*id).to_string(),
                    path: (*path).to_string(),
                    url: format!("https://example.invalid/{path}"),
                    expected_bytes: *expected,
                    sha256: None,
                })
                .collect(),
        }
    }

    fn write_sized(path: &Path, len: u64) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create parent dir");
        }
        let file = std::fs::File::create(path).expect("create file");
        file.set_len(len).expect("set file length");
    }

    // ── ST-9: config refusal names missing model files (R-1c) ────────────────

    #[test]
    fn missing_model_files_detail_names_every_absent_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let manifest = test_manifest(&[
            ("model", "model.gguf", 4),
            ("vision", "mmproj.gguf", 5),
            ("mtp", "MTP/mtp.gguf", 6),
        ]);

        // No files at all — every required file is named in the refusal.
        let detail = missing_model_files_detail(dir.path(), &manifest).expect("refusal");
        assert!(
            detail.starts_with("missing model file(s): "),
            "detail: {detail}"
        );
        assert!(detail.contains("gemma-4-e2b-it-qat/model.gguf"), "detail: {detail}");
        assert!(detail.contains("gemma-4-e2b-it-qat/mmproj.gguf"), "detail: {detail}");
        assert!(
            detail.contains("gemma-4-e2b-it-qat/MTP/mtp.gguf"),
            "detail: {detail}"
        );

        // With every file exactly the expected size the config is launchable.
        let base = dir.path().join("gemma-4-e2b-it-qat");
        write_sized(&base.join("model.gguf"), 4);
        write_sized(&base.join("mmproj.gguf"), 5);
        write_sized(&base.join("MTP").join("mtp.gguf"), 6);
        assert!(missing_model_files_detail(dir.path(), &manifest).is_none());
    }

    #[test]
    fn missing_model_files_detail_flags_a_truncated_file_and_ignores_present_ones() {
        let dir = tempfile::tempdir().expect("tempdir");
        let manifest = test_manifest(&[
            ("model", "model.gguf", 4),
            ("vision", "mmproj.gguf", 5),
            ("mtp", "MTP/mtp.gguf", 6),
        ]);
        let base = dir.path().join("gemma-4-e2b-it-qat");
        write_sized(&base.join("model.gguf"), 4);
        write_sized(&base.join("mmproj.gguf"), 5);
        write_sized(&base.join("MTP").join("mtp.gguf"), 2); // truncated

        let detail = missing_model_files_detail(dir.path(), &manifest).expect("refusal");
        assert!(detail.contains("gemma-4-e2b-it-qat/MTP/mtp.gguf"), "detail: {detail}");
        assert!(
            !detail.contains("gemma-4-e2b-it-qat/model.gguf"),
            "present model must not be named: {detail}"
        );
        assert!(
            !detail.contains("gemma-4-e2b-it-qat/mmproj.gguf"),
            "present mmproj must not be named: {detail}"
        );
    }

    #[test]
    fn missing_model_files_detail_refuses_an_empty_manifest() {
        let dir = tempfile::tempdir().expect("tempdir");
        let manifest = test_manifest(&[]);
        let detail = missing_model_files_detail(dir.path(), &manifest).expect("refusal");
        assert!(detail.contains("missing model file(s)"), "detail: {detail}");
    }

    #[test]
    fn args_override_replaces_only_the_named_fields() {
        let mut config = LlamaServerConfig::default();
        apply_args_override(
            &mut config,
            Some(r#"{"ctxSize":4096,"threads":3,"alias":"Local"}"#),
        )
        .expect("valid override");

        assert_eq!(config.ctx_size, 4096);
        assert_eq!(config.threads, 3);
        assert_eq!(config.alias, "Local");
        // Untouched fields keep the ST-2 reference default.
        assert_eq!(config.top_p, 0.95);
        assert_eq!(config.spec_type, "draft-mtp");
        assert!(config.kv_unified);
    }

    #[test]
    fn args_override_is_absent_and_blank_safe() {
        let mut config = LlamaServerConfig::default();
        apply_args_override(&mut config, None).expect("absent is a no-op");
        apply_args_override(&mut config, Some("   ")).expect("blank is a no-op");
        assert_eq!(config, LlamaServerConfig::default());
    }

    #[test]
    fn args_override_rejects_invalid_json() {
        let mut config = LlamaServerConfig::default();
        assert!(apply_args_override(&mut config, Some("{ not json")).is_err());
    }

    #[test]
    fn executable_or_code_reports_not_configured_when_absent() {
        let (code, _detail) = executable_or_code(Ok(None)).expect_err("no executable resolved");
        assert_eq!(code, LlamaServerLaunchCode::NotConfigured);

        let (code, _detail) =
            executable_or_code(Err("settings read failed".to_string())).expect_err("resolver error");
        assert_eq!(code, LlamaServerLaunchCode::NotConfigured);

        let path = executable_or_code(Ok(Some(PathBuf::from("llama-server.exe"))))
            .expect("resolved executable");
        assert_eq!(path, PathBuf::from("llama-server.exe"));
    }

    #[test]
    fn materialize_config_writes_the_bat_and_returns_its_contents() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir
            .path()
            .join("companion")
            .join("llama-server-launch.bat");

        let mut config = LlamaServerConfig::default();
        config.executable = r"C:\llama\llama-server.exe".to_string();
        config.model = r"C:\models\gemma.gguf".to_string();

        let preview = materialize_config(&config, &path).expect("materialize");

        assert_eq!(preview.path, path.to_string_lossy());
        assert_eq!(preview.contents, config.to_bat());
        assert_eq!(preview.config, config);
        let on_disk = std::fs::read_to_string(&path).expect("read back the .bat");
        assert_eq!(on_disk, preview.contents);
        assert!(on_disk.contains("--model"));
    }

    #[test]
    fn status_serializes_camel_case_with_every_field() {
        let status = LlamaServerStatus {
            running: true,
            healthy: false,
            port: Some(8080),
            pid: Some(4242),
            config_path: "c.bat".to_string(),
            log_path: "l.log".to_string(),
            last_error: None,
        };
        let value = serde_json::to_value(&status).expect("serialize");

        assert_eq!(value["running"], true);
        assert_eq!(value["healthy"], false);
        assert_eq!(value["port"], 8080);
        assert_eq!(value["pid"], 4242);
        assert_eq!(value["configPath"], "c.bat");
        assert_eq!(value["logPath"], "l.log");
        assert!(value["lastError"].is_null());
    }

    #[test]
    fn launch_codes_serialize_camel_case() {
        let cases = [
            (LlamaServerLaunchCode::SpawnFailed, "\"spawnFailed\""),
            (LlamaServerLaunchCode::PortInUse, "\"portInUse\""),
            (LlamaServerLaunchCode::HealthTimeout, "\"healthTimeout\""),
            (LlamaServerLaunchCode::NotConfigured, "\"notConfigured\""),
        ];
        for (code, expected) in cases {
            assert_eq!(serde_json::to_string(&code).expect("serialize"), expected);
        }
    }

    #[test]
    fn prerequisite_state_serializes_with_the_setup_wire_vocabulary() {
        assert_eq!(
            serde_json::to_string(&PrerequisiteState::Installed).expect("serialize"),
            "\"installed\""
        );
        assert_eq!(
            serde_json::to_string(&PrerequisiteState::Missing).expect("serialize"),
            "\"missing\""
        );
        assert_eq!(
            serde_json::to_string(&PrerequisiteState::Error).expect("serialize"),
            "\"error\""
        );
    }

    // ── ST-8: bounded health — never hang, never a false `installed` ──────────

    /// A health source that never answers (an unreachable port, or a server that
    /// never becomes ready). Drives the bounded-timeout path.
    struct NeverReadyProbe;

    #[async_trait::async_trait]
    impl HealthProbeSource for NeverReadyProbe {
        async fn probe(&self, _url: &str) -> health::HealthProbe {
            health::HealthProbe::Unreachable
        }
    }

    #[tokio::test]
    async fn health_timeout_is_bounded_actionable_and_never_installed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let log = dir.path().join("llama-server.log");
        std::fs::write(&log, "ggml: loading model weights").expect("write log");

        let started = std::time::Instant::now();
        let outcome = wait_for_health(
            &NeverReadyProbe,
            "http://127.0.0.1:1/health",
            Duration::from_millis(50),
            Duration::from_millis(5),
            "C:\\data\\companion\\llama-server-launch.bat",
            8080,
            &log,
        )
        .await;

        // Never hangs — resolves within the bound.
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "the health wait must be bounded"
        );

        let failed = outcome.expect_err("a never-answering health source must time out");
        assert!(!failed.success);
        assert_eq!(failed.code, Some(LlamaServerLaunchCode::HealthTimeout));
        // Non-`Installed` on timeout is the R-2.2/R-4.2 contract.
        assert_eq!(failed.state, PrerequisiteState::Error);
        assert_ne!(failed.state, PrerequisiteState::Installed);
        assert_eq!(failed.port, Some(8080));
        assert_eq!(
            failed.config_path,
            "C:\\data\\companion\\llama-server-launch.bat"
        );
        // Actionable: bounded-timeout description PLUS the server log tail.
        assert!(
            failed.detail.contains("health check timed out"),
            "detail: {}",
            failed.detail
        );
        assert!(
            failed.detail.contains("ggml: loading model weights"),
            "detail: {}",
            failed.detail
        );
        assert_eq!(failed.error.as_deref(), Some(failed.detail.as_str()));
    }

    #[tokio::test]
    async fn wait_for_health_resolves_ok_when_the_probe_is_ready() {
        struct ReadyProbe;

        #[async_trait::async_trait]
        impl HealthProbeSource for ReadyProbe {
            async fn probe(&self, _url: &str) -> health::HealthProbe {
                health::HealthProbe::Ready
            }
        }

        let dir = tempfile::tempdir().expect("tempdir");
        let log = dir.path().join("llama-server.log");
        let outcome = wait_for_health(
            &ReadyProbe,
            "http://127.0.0.1:8080/health",
            Duration::from_secs(1),
            Duration::from_millis(5),
            "c.bat",
            8080,
            &log,
        )
        .await;
        assert!(outcome.is_ok(), "a ready probe must succeed");
    }
}
