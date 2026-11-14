//! Engine lifecycle + status commands (Spec #3141, ST-1; teardown ST-6).
//!
//! The out-of-process surface is GONE (Spec #3141 ST-6): there is no
//! `llama-server` child, no generated `.bat`, no port selection, no health poll,
//! and no managed-process slot. Every command here addresses the IN-PROCESS
//! engine on its owned OS thread ([`super::super::engine::handle`]).
//!
//! The IPC names are preserved because the webview has live consumers:
//!
//! * `launch_llama_server` — the wizard's start action. It now performs the
//!   engine's bounded start and returns the typed
//!   [`CompanionEngineStartResult`] (the migrated replacement for the retired
//!   `LlamaServerLaunchResult`).
//! * `stop_llama_server` — the engine stop (release the model + thread).
//! * `get_llama_server_status` — the status snapshot; port/pid stay `null` (no
//!   process exists), `configPath` stays empty (no `.bat`).

use tauri::{AppHandle, Manager};

use crate::applications::llm_server::engine::paths;
use crate::applications::llm_server::engine::{
    CompanionEngineErrorCode, CompanionEngineStartResult,
};

use super::{backend_mode, current_status, CompanionEngineState, LlamaServerStatus};

/// Start the in-process companion engine.
///
/// The IPC name is the pre-migration one (`launch_llama_server`) because the
/// wizard calls it; the result is the engine's typed start outcome. A typed
/// result is ALWAYS returned (never a hang): a missing model file, a `gpu`
/// request with no usable GPU, or a start that exceeds its budget each map to a
/// [`CompanionEngineErrorCode`].
#[tauri::command]
pub async fn launch_llama_server(app: AppHandle) -> CompanionEngineStartResult {
    start(&app).await
}

/// Start the engine (the shared body behind `launch_llama_server` and
/// `start_companion_engine`).
async fn start(app: &AppHandle) -> CompanionEngineStartResult {
    let Some(handle) = app.try_state::<CompanionEngineState>().map(|state| state.0.clone()) else {
        return CompanionEngineStartResult::failure(CompanionEngineErrorCode::BackendInitFailed);
    };
    let model_paths = match paths::resolve_for_handle(app) {
        Ok(resolved) => resolved,
        Err((code, detail)) => return CompanionEngineStartResult::failure_with(code, detail),
    };
    let mode = backend_mode(app);

    // The bounded start blocks on the engine thread; run it off the async worker
    // so the IPC call never stalls the runtime. `tauri::async_runtime::spawn`
    // (never `tokio::spawn`) hosts ONLY this adapter — no engine value crosses it.
    let (tx, rx) = tokio::sync::oneshot::channel();
    tauri::async_runtime::spawn(async move {
        let outcome = handle.start(model_paths, mode);
        let _ = tx.send(outcome);
    });
    match rx.await {
        Ok(outcome) => outcome,
        Err(_) => CompanionEngineStartResult::failure(CompanionEngineErrorCode::StartTimeout),
    }
}

/// Start the in-process companion engine (the ST-1 name, kept as the explicit
/// engine command).
#[tauri::command]
pub async fn start_companion_engine(app: AppHandle) -> CompanionEngineStartResult {
    start(&app).await
}

/// Stop the in-process engine (release the model and end the engine thread).
#[tauri::command]
pub fn stop_llama_server(app: AppHandle) -> Result<(), String> {
    if let Some(engine) = app.try_state::<CompanionEngineState>() {
        engine.0.stop();
    }
    Ok(())
}

/// Status snapshot for the wizard/QA poll.
///
/// Reads the in-process engine slot. The ADDITIVE fields are always present on
/// the type; the OPTIONAL ones serialize as absent keys when unset (NFR-9).
#[tauri::command]
pub async fn get_llama_server_status(app: AppHandle) -> Result<LlamaServerStatus, String> {
    Ok(current_status(&app))
}

/// App-exit hook: stop the engine thread so no model/context outlives Fredo.
pub fn stop_llama_server_on_exit(app: &AppHandle) {
    if let Some(engine) = app.try_state::<CompanionEngineState>() {
        engine.0.stop();
    }
}
