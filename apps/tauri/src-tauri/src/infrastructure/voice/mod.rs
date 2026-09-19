//! Voice input / speech-to-text infrastructure.
//!
//! Owns the shipped, opt-in local voice-transcription foundation: the STT model
//! manifest + presence probe + acquisition entry point, the native `cpal`
//! capture (device-selectable), the `sherpa-onnx` engine wrapper behind the
//! [`Recognizer`] seam, and the one-session state machine behind the Tauri
//! commands. The manifest reuses the shared companion model vocabulary
//! (`infrastructure::companion::models`) so the streamed download + SHA-256
//! verify engine is the ONE acquisition rule (NFR-6). Everything except model
//! acquisition is on-device: no webview audio, no network in the decode path.

pub mod capture;
pub mod commands;
pub mod engine;
pub mod manifest;
pub mod resident;
pub mod session;
pub mod state;

pub use commands::SttModelStatus;
pub use engine::{Recognizer, CAPTURE_CHUNK_SAMPLES, ENGINE_SAMPLE_RATE};
pub use manifest::{
    resolve_stt_manifest, STT_DEFAULT_MANIFEST, STT_HF_REPO, STT_REVISION, STT_SUBDIR,
    STT_TOTAL_BYTES,
};
pub use resident::ResidentEngine;
pub use session::{
    AppHandleSink, TranscriptSink, VoiceState, VOICE_DEVICE_KEY, VOICE_ENABLED_KEY,
    VOICE_HANDLING_KEY,
};
pub use state::{
    SttDeviceInfo, SttDevicesResult, SttErrorCode, SttStartResult, SttStateEvent,
    SttTranscriptEvent, SttWarmResult, VoiceError,
};
