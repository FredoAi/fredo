//! Capability probe command surface (Spec #3141, ST-1).
//!
//! ST-1 creates this module so ST-5 can re-point it onto the in-process
//! `MtmdContext::supports_audio()` read WITHOUT touching ST-1's or ST-3's files.
//! In ST-1 the probe still runs against the pre-migration managed
//! `llama-server` loopback surface — behaviour is unchanged, and the
//! [`SttAudioCapability`] wire shape is untouched.

use tauri::{AppHandle, Manager};

use crate::infrastructure::voice::{SttAudioCapability, VoiceState};

use super::super::probe;

/// Probe the managed model's audio-input capability.
///
/// Backend-owned: the UI NEVER infers capability from a model name. The probe
/// reads the managed LOOPBACK server (read-only app state) and runs ONE
/// `input_audio` acceptance request rendered by the ONE production renderer
/// ([`probe::probe_model_audio_capability`]), so the readiness row and the
/// pre-start gate share the SAME verdict. It never panics: an unreachable server
/// reports `serverUnavailable`.
///
/// The verdict is stored on `VoiceState` so the pre-start gate can consult it
/// WITHOUT any network symbol entering the voice module.
#[tauri::command]
pub async fn stt_audio_capability(app: AppHandle) -> SttAudioCapability {
    let capability = probe::probe_model_audio_capability(&app).await;
    if let Some(state) = app.try_state::<VoiceState>() {
        state.set_audio_capability(capability.clone());
    }
    capability
}
