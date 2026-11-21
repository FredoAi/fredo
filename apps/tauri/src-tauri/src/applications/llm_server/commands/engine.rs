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
//! * `stop_llama_server` — the engine stop (release the model; the engine thread
//!   stays alive and parks, so a later start re-initialises on the SAME thread).
//! * `get_llama_server_status` — the status snapshot; port/pid stay `null` (no
//!   process exists), `configPath` stays empty (no `.bat`).

use tauri::{AppHandle, Manager};

use crate::applications::llm_server::engine::paths;
use crate::applications::llm_server::engine::{
    CompanionEngineErrorCode, CompanionEngineStartResult,
};
use crate::infrastructure::comm::bus::EventBus;

use super::{backend_mode, current_status, CompanionEngineState, LlamaServerStatus};

/// The global push event carrying the CURRENT [`LlamaServerStatus`].
///
/// The webview already listens on this channel (`useFredoHealth` /
/// `useCompanionReadiness`); until Spec #3180 ST-2 there was no producer at all.
pub const COMPANION_ENGINE_STATUS_EVENT: &str = "llama-server-status";

/// Broadcast the current engine status to every webview through the EventBus —
/// the sanctioned global emission path (application code never calls
/// `AppHandle::emit` directly).
///
/// Best-effort: before the `EventBus` is managed (a very early launch start)
/// there is simply nothing to publish to, so the push is skipped rather than
/// failing the start.
pub(crate) fn publish_engine_status(app: &AppHandle) {
    let Some(bus) = app.try_state::<EventBus>() else {
        return;
    };
    let status = current_status(app);
    bus.emit_global(COMPANION_ENGINE_STATUS_EVENT, &status);
}

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
    let outcome = match rx.await {
        Ok(outcome) => outcome,
        Err(_) => CompanionEngineStartResult::failure(CompanionEngineErrorCode::StartTimeout),
    };
    // BOTH explicit start adapters funnel through here, so the webview is pushed
    // the terminal status on completion AND failure (Spec #3180 ST-2). The row
    // therefore stops reading "not running" the moment a start settles instead
    // of waiting for the next poll.
    publish_engine_status(app);
    outcome
}

/// Start the in-process companion engine (the ST-1 name, kept as the explicit
/// engine command).
#[tauri::command]
pub async fn start_companion_engine(app: AppHandle) -> CompanionEngineStartResult {
    start(&app).await
}

/// Stop the in-process engine: release the model/backend memory. The engine
/// thread stays alive and parks, so a later start re-initialises on the SAME
/// thread (Spec #3141 fix D1 — stop is not a one-way door).
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

/// App-exit hook: release the engine's model/backend memory. The thread itself
/// ends when the handle is dropped (the command sender drops first, so the
/// engine loop's `recv()` returns and the thread joins).
pub fn stop_llama_server_on_exit(app: &AppHandle) {
    if let Some(engine) = app.try_state::<CompanionEngineState>() {
        engine.0.stop();
    }
}
