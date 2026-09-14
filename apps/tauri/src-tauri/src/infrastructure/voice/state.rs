// SPIKE #2876 — THROWAWAY POC — replaced by #2877/#2878
//!
//! STT IPC wire types (camelCase; `serde(rename_all = "camelCase")`) exactly as
//! pinned in the #2876 plan's API Contracts. ST-3 owns this file; #2877 replaces
//! it.

use serde::Serialize;

/// Typed STT failure vocabulary. Serialized as `noDevice`, `permissionDenied`,
/// `modelMissing`, `modelCorrupt`, `engineStartFailed`, `alreadyListening`,
/// `disabled`, `internal`.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum SttErrorCode {
    NoDevice,
    PermissionDenied,
    ModelMissing,
    ModelCorrupt,
    EngineStartFailed,
    AlreadyListening,
    Disabled,
    Internal,
}

/// Result of `stt_start`. `started:false` always carries a typed `code` and a
/// human-readable `detail`.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SttStartResult {
    pub started: bool,
    pub code: Option<SttErrorCode>,
    pub detail: Option<String>,
    pub device_name: Option<String>,
    /// The DEVICE rate; the engine is fed [`super::engine::ENGINE_SAMPLE_RATE`].
    pub sample_rate: Option<u32>,
}

/// One `stt:transcript` payload. `text` is the CUMULATIVE text of the CURRENT
/// segment; `isFinal` is true on endpoint (segment closed).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SttTranscriptEvent {
    pub session_id: String,
    /// Monotonic per session; every emitted partial/final strictly increases it.
    pub revision: u64,
    /// Increments on each endpoint.
    pub segment_id: u32,
    pub text: String,
    pub is_final: bool,
    /// Last `accept_waveform` → this emit, in milliseconds.
    pub latency_ms: u64,
}

/// One `stt:state` payload.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SttStateEvent {
    pub listening: bool,
    pub code: Option<SttErrorCode>,
    pub detail: Option<String>,
    /// `"launcher"` | `"companion"` (echoed from `stt_start`).
    pub origin: Option<String>,
}

/// Internal typed error carried from capture/engine/session to the command
/// boundary. Never surfaced as a panic.
#[derive(Clone, Debug)]
pub struct VoiceError {
    pub code: SttErrorCode,
    pub detail: String,
}

impl VoiceError {
    pub fn new(code: SttErrorCode, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }

    pub fn no_device() -> Self {
        Self::new(
            SttErrorCode::NoDevice,
            "No input device is available on this host.",
        )
    }

    pub fn permission_denied(detail: impl Into<String>) -> Self {
        Self::new(SttErrorCode::PermissionDenied, detail)
    }

    pub fn model_missing(detail: impl Into<String>) -> Self {
        Self::new(SttErrorCode::ModelMissing, detail)
    }

    pub fn model_corrupt(detail: impl Into<String>) -> Self {
        Self::new(SttErrorCode::ModelCorrupt, detail)
    }

    pub fn engine_start_failed(detail: impl Into<String>) -> Self {
        Self::new(SttErrorCode::EngineStartFailed, detail)
    }

    pub fn already_listening() -> Self {
        Self::new(
            SttErrorCode::AlreadyListening,
            "A listening session is already active.",
        )
    }

    pub fn disabled() -> Self {
        Self::new(
            SttErrorCode::Disabled,
            "Voice input is disabled in Companion settings.",
        )
    }

    pub fn internal(detail: impl Into<String>) -> Self {
        Self::new(SttErrorCode::Internal, detail)
    }

    /// Shape this failure into the `stt_start` wire result.
    pub fn into_start_result(self) -> SttStartResult {
        SttStartResult {
            started: false,
            code: Some(self.code),
            detail: Some(self.detail),
            device_name: None,
            sample_rate: None,
        }
    }
}
