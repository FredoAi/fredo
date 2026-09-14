//! Voice input / speech-to-text infrastructure (Spec #2876 — THROWAWAY POC).
//!
//! ST-2 adds the STT model manifest + presence probe + the acquisition entry
//! point; ST-3 adds the native `cpal` capture, the `sherpa-onnx` engine wrapper,
//! and the one-session state machine behind the Tauri commands. The manifest
//! reuses the shared companion model vocabulary
//! (`infrastructure::companion::models`) so the streamed download + SHA-256
//! verify engine is the ONE acquisition rule (NFR-6). Replaced by #2877/#2878.

pub mod capture;
pub mod commands;
pub mod engine;
pub mod manifest;
pub mod session;
pub mod state;

pub use commands::SttModelStatus;
pub use engine::{Recognizer, CAPTURE_CHUNK_SAMPLES, ENGINE_SAMPLE_RATE};
pub use manifest::{
    resolve_stt_manifest, STT_DEFAULT_MANIFEST, STT_HF_REPO, STT_REVISION, STT_SUBDIR,
    STT_TOTAL_BYTES,
};
pub use session::{AppHandleSink, TranscriptSink, VoiceState, VOICE_ENABLED_KEY};
pub use state::{
    SttErrorCode, SttStartResult, SttStateEvent, SttTranscriptEvent, VoiceError,
};
