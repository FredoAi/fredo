//! Voice input / speech-to-text infrastructure (Spec #2876).
//!
//! ST-2 adds the STT model manifest + presence probe + the acquisition entry
//! point. The manifest reuses the shared companion model vocabulary
//! (`infrastructure::companion::models`) so the streamed download + SHA-256
//! verify engine is the ONE acquisition rule (NFR-6). Capture/engine/session
//! land in ST-3.

pub mod commands;
pub mod manifest;

pub use commands::SttModelStatus;
pub use manifest::{
    resolve_stt_manifest, STT_DEFAULT_MANIFEST, STT_HF_REPO, STT_REVISION, STT_SUBDIR,
    STT_TOTAL_BYTES,
};
