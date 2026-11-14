//! Capability probe command surface (Spec #3141, ST-1; re-pointed in ST-5).
//!
//! ST-5 re-points the model-audio capability read off the retired loopback
//! `llama-server` onto the IN-PROCESS engine's loaded projector:
//! [`MtmdCapability`] is read from the live `MtmdContext`
//! (`MtmdContext::supports_audio()` + `audio_sample_rate()`) and published into
//! the engine status slot at start, so this command is a pure state read — no
//! HTTP client, no synthetic probe clip, and no network symbol anywhere near the
//! voice module (#2897 REQ-7 / R-21.1).
//!
//! The [`SttAudioCapability`] wire shape is UNTOUCHED: the same five fields, the
//! same camelCase state vocabulary, the same typed `code`. Only the source of the
//! verdict changed.

use tauri::{AppHandle, Manager};

use crate::infrastructure::voice::{SttAudioCapability, SttAudioCapabilityState, VoiceState};

use super::super::engine::multimodal::MtmdCapability;
use super::{current_status, CompanionEngineState};

/// The model name reported to the readiness row: the loaded engine's model id.
///
/// It is a DISPLAY detail (never the capability verdict), read from the engine
/// slot rather than parsed out of a filename at the call site.
fn loaded_model(app: &AppHandle) -> Option<String> {
    current_status(app).model_id
}

/// Map the loaded projector's capability onto the shipped closed state.
///
/// Pure, so the mapping can be pinned without an app handle. `None` means the
/// engine is not running — the truthful `serverUnavailable`, never a guessed
/// verdict.
pub(crate) fn capability_state_for(
    capability: Option<MtmdCapability>,
) -> SttAudioCapabilityState {
    match capability {
        Some(capability) if capability.audio_ready() => SttAudioCapabilityState::Ready,
        Some(_) => SttAudioCapabilityState::Unsupported,
        None => SttAudioCapabilityState::ServerUnavailable,
    }
}

/// The readable qualifier for the demoted technical line.
///
/// Curated copy for every state, naming the OBSERVED projector fact (never a
/// model name): the sample rate on success, the reported flags on refusal, and
/// the engine-not-running case.
pub(crate) fn capability_detail(
    capability: Option<MtmdCapability>,
) -> Option<String> {
    match capability {
        Some(capability) if capability.audio_ready() => Some(format!(
            "the companion projector accepts audio at {} Hz",
            capability.audio_sample_rate
        )),
        Some(capability) => Some(format!(
            "the companion projector reports audio={} at sample rate {}",
            capability.audio, capability.audio_sample_rate
        )),
        None => Some(
            "the companion engine is not running, so Fredo cannot interpret audio.".to_string(),
        ),
    }
}

/// Probe the managed model's audio-input capability.
///
/// Backend-owned: the UI NEVER infers capability from a model name. The verdict
/// comes from the loaded in-process projector, which is the same object the turn
/// uses to encode the clip — so the readiness row and the pre-start gate can
/// never disagree.
///
/// The verdict is stored on `VoiceState` so the pre-start gate can consult it
/// WITHOUT any network symbol entering the voice module.
#[tauri::command]
pub async fn stt_audio_capability(app: AppHandle) -> SttAudioCapability {
    let capability = read_capability(&app);
    if let Some(state) = app.try_state::<VoiceState>() {
        state.set_audio_capability(capability.clone());
    }
    capability
}

/// Build the capability answer from the engine's published projector read.
///
/// A pure read of the engine slot: no I/O, no probe, no model-name inference.
/// `None` capability (engine not loaded) is `serverUnavailable` with the typed
/// `modelAudioUnavailable` code the readiness row already renders.
fn read_capability(app: &AppHandle) -> SttAudioCapability {
    let capability = read_published_capability(app);
    let model = loaded_model(app);
    let detail = capability_detail(capability);
    match capability_state_for(capability) {
        SttAudioCapabilityState::Ready => SttAudioCapability::ready(model),
        SttAudioCapabilityState::Unsupported => {
            SttAudioCapability::unsupported(model, detail.unwrap_or_default())
        }
        _ => SttAudioCapability::server_unavailable(
            detail.unwrap_or_else(|| "the companion engine is not running.".to_string()),
        ),
    }
}

/// The projector read the engine published into its status slot, if any.
///
/// The guard is bound to a named local BEFORE it is read, so its borrow is tied
/// to this function's scope rather than to the enclosing statement.
fn read_published_capability(app: &AppHandle) -> Option<MtmdCapability> {
    let state = app.try_state::<CompanionEngineState>()?;
    let slot = state.0.slot();
    let published = slot
        .lock()
        .map(|guard| guard.snapshot.mtmd_capability)
        .unwrap_or_else(|poisoned| poisoned.into_inner().snapshot.mtmd_capability);
    published
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The closed mapping: a usable projector is `ready`, a projector without
    /// audio is `unsupported`, and no engine is `serverUnavailable` — never a
    /// guessed verdict.
    #[test]
    fn the_projector_read_maps_onto_the_shipped_closed_state() {
        assert_eq!(
            capability_state_for(Some(MtmdCapability {
                vision: true,
                audio: true,
                audio_sample_rate: 16_000,
            })),
            SttAudioCapabilityState::Ready
        );
        assert_eq!(
            capability_state_for(Some(MtmdCapability {
                vision: true,
                audio: false,
                audio_sample_rate: -1,
            })),
            SttAudioCapabilityState::Unsupported
        );
        assert_eq!(
            capability_state_for(Some(MtmdCapability {
                vision: true,
                audio: true,
                audio_sample_rate: -1,
            })),
            SttAudioCapabilityState::Unsupported,
            "the audio flag without a real sample rate is NOT usable"
        );
        assert_eq!(
            capability_state_for(None),
            SttAudioCapabilityState::ServerUnavailable
        );
    }

    /// The wire vocabulary of the verdict is untouched: `ready` carries no code,
    /// `unsupported` is the typed `modelAudioUnsupported`, and
    /// `serverUnavailable` is the typed `modelAudioUnavailable`.
    #[test]
    fn the_verdict_keeps_the_shipped_wire_shape() {
        let ready = SttAudioCapability::ready(Some("gemma-4-E2B".to_string()));
        assert_eq!(ready.state, SttAudioCapabilityState::Ready);
        assert!(ready.code.is_none());
        assert!(ready.detail.is_none());

        let unsupported = SttAudioCapability::unsupported(
            Some("gemma-4-E2B".to_string()),
            capability_detail(Some(MtmdCapability::default())).unwrap_or_default(),
        );
        let value = serde_json::to_value(&unsupported).expect("serialize");
        assert_eq!(value["state"], "unsupported");
        assert!(value.get("model").is_some());
        assert!(value.get("limitMs").is_some());

        let unavailable = SttAudioCapability::server_unavailable(
            capability_detail(None).unwrap_or_default(),
        );
        let value = serde_json::to_value(&unavailable).expect("serialize");
        assert_eq!(value["state"], "serverUnavailable");
        assert_eq!(value["code"], "modelAudioUnavailable");
        assert!(value["detail"]
            .as_str()
            .unwrap_or_default()
            .contains("not running"));
    }

    /// The detail names the OBSERVED projector fact — the sample rate on success,
    /// never a model name.
    #[test]
    fn the_detail_names_the_observed_projector_fact() {
        let ready = capability_detail(Some(MtmdCapability {
            vision: true,
            audio: true,
            audio_sample_rate: 16_000,
        }))
        .expect("a ready verdict has a detail");
        assert!(ready.contains("16000"), "detail: {ready}");
        assert!(ready.contains("Hz"), "detail: {ready}");

        let unsupported = capability_detail(Some(MtmdCapability {
            vision: true,
            audio: false,
            audio_sample_rate: -1,
        }))
        .expect("an unsupported verdict names the flags");
        assert!(unsupported.contains("audio=false"), "detail: {unsupported}");

        let unavailable = capability_detail(None).expect("the not-running case is named");
        assert!(unavailable.contains("not running"), "detail: {unavailable}");
    }
}
