//! STT Tauri commands.
//!
//! [`stt_check_model`] probes the pinned STT model files with the shared
//! exact-size classifier (NFR-6); [`stt_list_devices`] enumerates the host input
//! devices and reports the persisted selection. Acquisition lives in
//! `features::setup::commands::download_stt_model`, which reuses the companion
//! streamed download + SHA-256 verify engine. The session commands delegate to
//! [`super::session`].

use serde::Serialize;
use tauri::AppHandle;

use crate::infrastructure::companion::models::{
    is_step_complete, probe_files, resolve_models_dir, ModelFileStatus,
};

use super::capture;
use super::manifest::resolve_stt_manifest;
use super::session;
use super::state::{SttDevicesResult, SttErrorCode, SttStartResult, SttStateEvent};

/// Per-file STT model probe result returned by [`stt_check_model`].
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SttModelStatus {
    /// true iff EVERY pinned STT file is present-and-complete.
    pub ready: bool,
    /// Per-file status, ordered tokens → encoder → decoder → joiner.
    pub files: Vec<ModelFileStatus>,
}

/// Probe the pinned STT model files. Presence is the shared exact-size gate
/// (`classify_file`, reused through `probe_files`/`is_step_complete`) — SHA-256
/// is verified by the download path, never re-read on every probe.
#[tauri::command]
pub fn stt_check_model(app: AppHandle) -> SttModelStatus {
    let manifest = resolve_stt_manifest();
    let models_dir = resolve_models_dir(&app);
    let files = probe_files(&models_dir, &manifest);
    let ready = is_step_complete(&models_dir, &manifest);
    SttModelStatus { ready, files }
}

/// Enumerate the host input devices for the Companion settings picker, marking
/// the system default and echoing the persisted selection
/// (`Fredo_companion_voice_device_id`). Never panics: an empty host or an
/// enumeration failure reports the typed `noDevice` code with an empty list.
#[tauri::command]
pub fn stt_list_devices(app: AppHandle) -> SttDevicesResult {
    let selected_id = session::persisted_device(&app);
    match capture::list_input_devices() {
        Ok(devices) if !devices.is_empty() => SttDevicesResult {
            devices,
            selected_id,
            code: None,
        },
        Ok(devices) => SttDevicesResult {
            devices,
            selected_id,
            code: Some(SttErrorCode::NoDevice),
        },
        Err(error) => SttDevicesResult {
            devices: Vec::new(),
            selected_id,
            code: Some(error.code),
        },
    }
}

/// Start a listening session (context-dependent Ctrl+Space path). Never panics;
/// every failure is a typed [`super::state::SttErrorCode`].
#[tauri::command]
pub async fn stt_start(app: AppHandle, origin: String) -> SttStartResult {
    session::start(&app, &origin).await
}

/// Stop listening and commit the final partial (R-3.3).
#[tauri::command]
pub async fn stt_stop(app: AppHandle) -> SttStateEvent {
    session::stop(&app).await
}

/// Cancel listening and discard the current partial.
#[tauri::command]
pub async fn stt_cancel(app: AppHandle) -> SttStateEvent {
    session::cancel(&app).await
}

/// The current listening state.
#[tauri::command]
pub fn stt_status(app: AppHandle) -> SttStateEvent {
    session::status(&app)
}
