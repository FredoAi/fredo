//! Voice input infrastructure.
//!
//! Owns the shipped, opt-in voice-input path: the native `cpal` capture
//! (device-selectable, plus the env-gated in-repo feed seam) and the ONE session
//! state machine behind the Tauri commands. There is exactly ONE speech path —
//! the captured clip is handed to the locally-managed multimodal model over IPC
//! (`stt_take_audio_clip`); this module never transmits it. There is no
//! on-device recognizer, no engine and no transcript: everything except the
//! model turn is on-device, and no network symbol enters this module.

pub mod capture;
pub mod commands;
pub mod session;
pub mod state;

pub use capture::{AUDIO_SAMPLE_RATE, CAPTURE_CHUNK_SAMPLES};
pub use session::{VoiceState, VOICE_DEVICE_KEY, VOICE_ENABLED_KEY};
pub use state::{
    SttAudioCapability, SttAudioCapabilityState, SttAudioClip, SttAudioClipResult, SttDeviceInfo,
    SttDevicesResult, SttErrorCode, SttPhaseWire, SttStartResult, SttStateEvent, VoiceError,
    MAX_AUDIO_CLIP_MS,
};
