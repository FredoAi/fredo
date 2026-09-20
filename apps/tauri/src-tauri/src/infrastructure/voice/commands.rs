//! Voice Tauri commands.
//!
//! [`stt_list_devices`] enumerates the host input devices and reports the
//! persisted selection. The session commands delegate to [`super::session`];
//! there is no model probe, no engine warm and no engine release — the captured
//! clip is the ONE thing this module hands out (`stt_take_audio_clip`).

use tauri::AppHandle;

use super::capture;
use super::session;
use super::state::{SttAudioClipResult, SttDevicesResult, SttErrorCode, SttStartResult, SttStateEvent};

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

/// Stop listening and commit the bounded model-audio clip.
#[tauri::command]
pub async fn stt_stop(app: AppHandle) -> SttStateEvent {
    session::stop(&app).await
}

/// Cancel listening and discard the accumulated audio.
#[tauri::command]
pub async fn stt_cancel(app: AppHandle) -> SttStateEvent {
    session::cancel(&app).await
}

/// The current listening state.
#[tauri::command]
pub fn stt_status(app: AppHandle) -> SttStateEvent {
    session::status(&app)
}

/// #2897 ST-2 — take (and clear) the bounded model-audio clip a stop committed.
/// Taking is destructive: a second call returns `clip: None`. The clip is the
/// ENTIRE captured audio as a 16 kHz mono 16-bit PCM WAV (`truncated` always
/// false), and it leaves via this IPC command only — `infrastructure/voice/`
/// never transmits it (REQ-8).
#[tauri::command]
pub fn stt_take_audio_clip(app: AppHandle) -> SttAudioClipResult {
    session::take_audio_clip(&app)
}
