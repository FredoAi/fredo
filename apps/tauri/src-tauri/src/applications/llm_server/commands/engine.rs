//! Engine lifecycle + status commands (Spec #3141, ST-1).
//!
//! Two layers coexist here:
//!
//! * **The pre-migration `llama-server` lifecycle** (`generate_llama_server_config`,
//!   `launch_llama_server`, `stop_llama_server`, `stop_llama_server_on_exit`).
//!   These still exist because their live consumers (the readiness wizard, the
//!   app-exit hook) are re-pointed by ST-6. ST-1 does NOT delete them.
//! * **The in-process engine surface** (`start_companion_engine`,
//!   `get_llama_server_status`). The status command is the EXISTING IPC name with
//!   the ADDITIVE backend/device fields; it reads the engine slot when a
//!   [`CompanionEngineState`] is managed and falls back to the legacy
//!   managed-process snapshot while that path still runs.

use std::time::Duration;

use tauri::{AppHandle, Manager, State};

use crate::applications::llm_server::engine::paths;
use crate::applications::llm_server::engine::{
    CompanionEngineErrorCode, CompanionEngineStartResult,
};
use crate::applications::llm_server::{
    DEFAULT_LLAMA_SERVER_HEALTH_TIMEOUT_S, DEFAULT_LLAMA_SERVER_HOST,
    LLAMA_SERVER_ACTIVE_PORT_KEY, LLAMA_SERVER_HEALTH_TIMEOUT_S_KEY, LLAMA_SERVER_LOG_PATH_KEY,
    LLAMA_SERVER_STARTED_AT_KEY,
};
use crate::infrastructure::companion::models::{resolve_manifest, resolve_models_dir};
use crate::infrastructure::companion::resolve_llama_server;

use super::super::health::{self, ReqwestHealthClient};
use super::super::process;
use super::super::state::LlamaServerState;
use super::{
    backend_mode, build_launch_config, companion_paths, current_status, executable_or_code,
    failure, get_setting, get_u64, health_probe_once, lock_state, materialize_config,
    missing_model_files_detail, persist_managed_pid, running_snapshot, set_setting, stop_managed,
    wait_for_health, CompanionEngineState, LlamaServerConfigPreview, LlamaServerLaunchCode,
    LlamaServerLaunchResult, LlamaServerStatus, PrerequisiteState, LLAMA_SERVER_LAST_ERROR_KEY,
};

/// Build the launch config from persisted settings and materialize the `.bat`.
#[tauri::command]
pub fn generate_llama_server_config(app: AppHandle) -> Result<LlamaServerConfigPreview, String> {
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
        stop_managed(&app);
    }

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
        process::kill_process_tree(&mut server);
        if let Some(detail) = &result.error {
            set_setting(&app, LLAMA_SERVER_LAST_ERROR_KEY, detail);
        }
        return result;
    }

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
pub fn stop_llama_server(app: AppHandle, state: State<'_, LlamaServerState>) -> Result<(), String> {
    let mut guard = lock_state(state.inner());
    if let Some(mut server) = guard.take() {
        process::kill_process_tree(&mut server);
    }
    drop(guard);

    persist_managed_pid(&app, None);
    for key in [LLAMA_SERVER_STARTED_AT_KEY, LLAMA_SERVER_ACTIVE_PORT_KEY] {
        set_setting(&app, key, "");
    }
    // Also stop the in-process engine when one is managed.
    if let Some(engine) = app.try_state::<CompanionEngineState>() {
        engine.0.stop();
    }
    Ok(())
}

/// Start the in-process companion engine.
///
/// A typed result is ALWAYS returned (never a hang): a missing model file, a
/// `gpu` request with no usable GPU, or a start that exceeds its budget each map
/// to a [`CompanionEngineErrorCode`].
#[tauri::command]
pub async fn start_companion_engine(app: AppHandle) -> CompanionEngineStartResult {
    let Some(handle) = app.try_state::<CompanionEngineState>().map(|state| state.0.clone()) else {
        return CompanionEngineStartResult::failure(CompanionEngineErrorCode::BackendInitFailed);
    };
    let paths = match paths::resolve_for_handle(&app) {
        Ok(paths) => paths,
        Err((code, detail)) => return CompanionEngineStartResult::failure_with(code, detail),
    };
    let mode = backend_mode(&app);

    // The bounded start blocks on the engine thread; run it off the async worker
    // so the IPC call never stalls the runtime. `tauri::async_runtime::spawn`
    // (never `tokio::spawn`) hosts ONLY this adapter — no engine value crosses it.
    let (tx, rx) = tokio::sync::oneshot::channel();
    tauri::async_runtime::spawn(async move {
        let outcome = handle.start(paths, mode);
        let _ = tx.send(outcome);
    });
    match rx.await {
        Ok(outcome) => outcome,
        Err(_) => CompanionEngineStartResult::failure(CompanionEngineErrorCode::StartTimeout),
    }
}

/// Status snapshot for the wizard/QA poll.
///
/// Reads the in-process engine slot when a [`CompanionEngineState`] is managed;
/// otherwise falls back to the legacy managed-process snapshot (so the wizard
/// keeps working until ST-6 re-points it). The ADDITIVE fields are always
/// present on the type; the OPTIONAL ones serialize as absent keys when unset.
#[tauri::command]
pub async fn get_llama_server_status(
    app: AppHandle,
    state: State<'_, LlamaServerState>,
) -> Result<LlamaServerStatus, String> {
    if app.try_state::<CompanionEngineState>().is_some() {
        return Ok(current_status(&app));
    }
    // Legacy path: a managed out-of-process server (still live until ST-6).
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
        last_error_code: None,
        backend: None,
        backend_mode: backend_mode(&app),
        devices: Vec::new(),
        model_id: None,
    })
}

/// App-exit hook: terminate the managed server tree and stop the engine.
pub fn stop_llama_server_on_exit(app: &AppHandle) {
    stop_managed(app);
    if let Some(engine) = app.try_state::<CompanionEngineState>() {
        engine.0.stop();
    }
}
