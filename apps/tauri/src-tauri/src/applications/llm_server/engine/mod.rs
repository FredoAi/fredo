//! In-process companion inference engine (Spec #3141, ST-1).
//!
//! Companion inference runs **in this process** on the `llama-cpp-4` Rust
//! bindings. There is no `llama-server` child process, no generated `.bat`, and
//! no loopback HTTP hop: the engine owns the backend, the model, the contexts
//! and the sampler directly.
//!
//! ## Why one owned OS thread
//!
//! `LlamaContext` and `MtpSession` are `!Send` / `!Sync` (the crate documents
//! `MtpSession`'s `PhantomData<Rc<()>>` deliberately), so engine state can never
//! cross an `.await` or be touched by two threads at once. The engine therefore
//! lives on ONE dedicated OS thread ([`thread`]) and every caller talks to it
//! over a bounded channel ([`handle`]). `tauri::async_runtime::spawn` is used
//! only by the command adapters that bridge IPC to that channel — never
//! `tokio::spawn`, and never to host engine state.
//!
//! ## Module map (ST-1 + ST-2)
//!
//! * [`device`] — the typed device enumeration, `CompanionBackendKind` mapping,
//!   the backend-mode projection, and the TEST-ONLY force-CPU seam
//!   ([`device::COMPANION_FORCE_CPU_ENV`]) owned entirely by that module.
//! * [`paths`] — the ONE model-path rule (the shared #2856 manifest via
//!   [`crate::infrastructure::companion::models::file_path`]) plus the engine
//!   log file location.
//! * [`sampling`] — the relocated sampling defaults (values preserved byte for
//!   byte from the retired launch config) and the sampler chain built from them.
//! * [`request`] — the request model: [`request::ChatTurn`] and the ONE media
//!   shaping rule (audio = one `input_audio` part, image = text + image_url).
//! * [`chat_format`] — chat templating through the GGUF's own template, the
//!   tool-call grammar, and the `response_format` schema grammar.
//! * [`detokenize`] — incremental UTF-8 detokenisation so no multi-byte
//!   character is ever torn at a token boundary.
//! * [`thread`] — the engine thread body: `LlamaBackend::init()` once, model
//!   load, device readout, the request-shaping verification, the warm-up, and
//!   the generation loop.
//! * [`handle`] — the bounded command channel, the bounded start, the status
//!   snapshot, and the process-scoped engine slot.
//!
//! Later sub-tasks extend this module (ST-3 streaming, ST-4 MTP, ST-5
//! multimodal) without redefining the names published here.

pub mod chat_format;
pub mod detokenize;
pub mod device;
pub mod handle;
pub mod mtp;
pub mod paths;
pub mod request;
pub mod sampling;
pub mod stream;
pub mod thread;

/// The model-file-dependent engine integration gate (constructs the engine
/// twice). Kept in its own file so the hardware-free unit pins above stay
/// readable.
#[cfg(test)]
mod integration;

/// The MTP (speculative-decoding) gates: pure pins plus the LIVE pairing,
/// counter, forced-rejection and typed-failure legs (ST-4).
#[cfg(test)]
mod mtp_tests;

use serde::{Deserialize, Serialize};

// ── Backend mode (the persisted selection) ────────────────────────────────────

/// The user's backend selection.
///
/// `Auto` is the default: no persisted setting means "request full offload and
/// let ggml pick the best available device".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum CompanionBackendMode {
    /// Full GPU offload when a usable GPU exists, CPU otherwise.
    #[default]
    Auto,
    /// Full GPU offload; a machine with no usable GPU is a typed refusal.
    Gpu,
    /// Zero GPU offload — run on the CPU.
    Cpu,
}

impl CompanionBackendMode {
    /// Parse a persisted setting value. Anything outside the closed set — an
    /// unknown token, blank, or absent — coerces to [`Self::Auto`], so a
    /// free-form value can never reach engine configuration.
    pub fn from_persisted(value: Option<&str>) -> Self {
        match value.map(str::trim) {
            Some(raw) if raw.eq_ignore_ascii_case("gpu") => Self::Gpu,
            Some(raw) if raw.eq_ignore_ascii_case("cpu") => Self::Cpu,
            _ => Self::Auto,
        }
    }
}

// ── Reported backend (from ggml's typed enumeration) ──────────────────────────

/// The backend class ggml reports for a loaded device.
///
/// A 1:1 mirror of `llama_cpp_4::model::LlamaBackendDeviceType`
/// (`Cpu=0, Gpu=1, IntegratedGpu=2, Accel=3, Meta=4`) — the enumeration, never a
/// log line and never the requested setting.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CompanionBackendKind {
    Cpu,
    Gpu,
    IntegratedGpu,
    Accel,
    Meta,
}

/// One backend device the loaded model's tensors are spread across.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionDeviceInfo {
    /// ggml device name, e.g. `CUDA0`, `Vulkan0`, `CPU`.
    pub name: String,
    /// ggml device description (usually the hardware name).
    pub description: String,
    /// The device class.
    pub device_type: CompanionBackendKind,
    /// Free device memory, in bytes.
    pub memory_free_bytes: u64,
    /// Total device memory, in bytes.
    pub memory_total_bytes: u64,
}

// ── Typed engine failures ─────────────────────────────────────────────────────

/// Every user-reachable engine failure. A raw library string is never the
/// primary copy — the detail carries curated, actionable text.
///
/// `Serialize` is what crosses IPC; `Deserialize` is derived too because the
/// code is a wire VALUE (a UI/test harness may echo one back), and it is the
/// shape ST-4/ST-5 reuse for their own failures.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CompanionEngineErrorCode {
    /// Mode is `gpu` and no usable non-CPU device exists.
    GpuUnavailable,
    /// `LlamaBackend::init()` (or the ggml backend registry) failed.
    BackendInitFailed,
    /// A manifest-declared model file is absent or the wrong size.
    ModelMissing,
    /// The GGUF exists but `LlamaModel::load_from_file` failed.
    ModelLoadFailed,
    /// MTP draft session construction failed (ST-4).
    MtpInitFailed,
    /// The multimodal projector failed to initialise (ST-5).
    MmprojInitFailed,
    /// A context could not be created.
    ContextCreateFailed,
    /// A turn is already running (one generation at a time per process).
    Busy,
    /// Engine start exceeded its wall-clock budget.
    StartTimeout,
}

impl CompanionEngineErrorCode {
    /// The typed code for a missing required model file, classified by the
    /// manifest subsystem that owns it.
    ///
    /// A missing main model is [`Self::ModelMissing`]; a missing projector or
    /// draft file is the subsystem-specific [`Self::MmprojInitFailed`] /
    /// [`Self::MtpInitFailed`], so the status surface names the failing subsystem
    /// even though ST-1 loads only the main model (ST-5/ST-4 own the loads).
    pub fn for_missing_file(file_id: &str) -> Self {
        match file_id {
            "vision" => Self::MmprojInitFailed,
            "mtp" => Self::MtpInitFailed,
            _ => Self::ModelMissing,
        }
    }

    /// Curated, actionable detail for this code.
    pub fn detail(self) -> &'static str {
        match self {
            Self::GpuUnavailable => {
                "The GPU backend was selected but no usable GPU was found. Choose Auto or CPU in Companion settings, then start again."
            }
            Self::BackendInitFailed => {
                "The inference backend could not initialise. Restart Fredo and try again."
            }
            Self::ModelMissing => {
                "A required model file is missing. Open Companion setup and download the model files."
            }
            Self::ModelLoadFailed => {
                "The model file could not be loaded. Re-download it from Companion setup."
            }
            Self::MtpInitFailed => {
                "The draft model could not be initialised. Re-download the model files from Companion setup."
            }
            Self::MmprojInitFailed => {
                "The vision projector could not be initialised. Re-download the model files from Companion setup."
            }
            Self::ContextCreateFailed => {
                "The model context could not be created. Restart Fredo and try again."
            }
            Self::Busy => "The companion is still finishing the previous turn. Try again in a moment.",
            Self::StartTimeout => {
                "The companion took too long to start. Try again, or restart Fredo."
            }
        }
    }
}

/// The terminal outcome of one engine start.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionEngineStartResult {
    /// `true` iff the engine is loaded and able to serve.
    pub success: bool,
    /// The typed failure, when `success` is `false`.
    pub code: Option<CompanionEngineErrorCode>,
    /// Curated, actionable detail.
    pub detail: String,
    /// The backend ggml reports for the loaded device set.
    pub backend: Option<CompanionBackendKind>,
    /// The device set ggml reports for the loaded model (empty before a load).
    pub devices: Vec<CompanionDeviceInfo>,
}

impl CompanionEngineStartResult {
    /// A typed failure with the code's curated detail.
    pub fn failure(code: CompanionEngineErrorCode) -> Self {
        Self {
            success: false,
            code: Some(code),
            detail: code.detail().to_string(),
            backend: None,
            devices: Vec::new(),
        }
    }

    /// A typed failure with a caller-supplied detail (already curated).
    pub fn failure_with(code: CompanionEngineErrorCode, detail: impl Into<String>) -> Self {
        Self {
            success: false,
            code: Some(code),
            detail: detail.into(),
            backend: None,
            devices: Vec::new(),
        }
    }
}

// ── Engine-internal channel vocabulary (NOT IPC) ──────────────────────────────

/// A command addressed to the engine thread.
///
/// ST-1 needed only lifecycle; ST-3 adds the two generation commands the live
/// consumers stream through (`Chat` for a token stream, `OneShot` for the Doom
/// decision path). Every variant carries the model paths + requested mode of a
/// lazily-started engine, so a turn can start it itself.
pub enum EngineCommand {
    /// Load the backend + main model and report devices.
    Start(Box<StartRequest>),
    /// Release the model and stop the thread.
    Stop,
    /// Generate one turn, streaming [`stream::EngineEvent`]s to the caller.
    Chat(Box<ChatRequest>),
    /// Generate one turn, returning the whole reply (the Doom decision path).
    OneShot(Box<OneShotRequest>),
}

/// Everything one streaming turn needs. Boxed inside [`EngineCommand`] to keep
/// the command enum small.
pub struct ChatRequest {
    /// The turn to generate.
    pub turn: request::ChatTurn,
    /// Where each [`stream::EngineEvent`] goes (bounded — a slow consumer applies
    /// backpressure, never an unbounded queue).
    pub events: tokio::sync::mpsc::Sender<stream::EngineEvent>,
    /// The model files a lazily-started engine loads.
    pub paths: paths::EnginePaths,
    /// The backend mode a lazily-started engine uses.
    pub mode: CompanionBackendMode,
    /// The distribution seed for this turn.
    pub seed: u32,
}

/// Everything one bounded one-shot turn needs. Boxed inside [`EngineCommand`].
pub struct OneShotRequest {
    /// The turn to generate.
    pub turn: request::ChatTurn,
    /// Where the terminal reply (or typed failure) goes.
    pub reply: tokio::sync::oneshot::Sender<
        Result<stream::TurnReply, (CompanionEngineErrorCode, String)>,
    >,
    /// The model files a lazily-started engine loads.
    pub paths: paths::EnginePaths,
    /// The backend mode a lazily-started engine uses.
    pub mode: CompanionBackendMode,
    /// The distribution seed for this turn.
    pub seed: u32,
}

/// Everything one bounded start needs. Boxed inside [`EngineCommand`] to keep
/// the command enum small.
pub struct StartRequest {
    /// The model files resolved through the shared manifest.
    pub paths: paths::EnginePaths,
    /// The requested backend mode.
    pub mode: CompanionBackendMode,
    /// Whether the TEST-ONLY force-CPU seam is engaged.
    pub force_cpu: bool,
    /// Where to send the terminal start outcome.
    pub reply: std::sync::mpsc::SyncSender<CompanionEngineStartResult>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persisted_mode_coerces_unknown_values_to_auto() {
        assert_eq!(CompanionBackendMode::from_persisted(Some("gpu")), CompanionBackendMode::Gpu);
        assert_eq!(CompanionBackendMode::from_persisted(Some(" CPU ")), CompanionBackendMode::Cpu);
        assert_eq!(CompanionBackendMode::from_persisted(Some("auto")), CompanionBackendMode::Auto);
        // Anything outside the closed set is Auto — never an error, never free-form.
        assert_eq!(CompanionBackendMode::from_persisted(Some("tensorrt")), CompanionBackendMode::Auto);
        assert_eq!(CompanionBackendMode::from_persisted(Some("")), CompanionBackendMode::Auto);
        assert_eq!(CompanionBackendMode::from_persisted(None), CompanionBackendMode::Auto);
    }

    #[test]
    fn backend_mode_defaults_to_auto_and_round_trips_lowercase() {
        assert_eq!(CompanionBackendMode::default(), CompanionBackendMode::Auto);
        for (mode, token) in [
            (CompanionBackendMode::Auto, "auto"),
            (CompanionBackendMode::Gpu, "gpu"),
            (CompanionBackendMode::Cpu, "cpu"),
        ] {
            let json = serde_json::to_string(&mode).expect("serialize mode");
            assert_eq!(json, format!("\"{token}\""));
            let restored: CompanionBackendMode =
                serde_json::from_str(&json).expect("deserialize mode");
            assert_eq!(restored, mode);
            // The persisted-token parse round-trips every wire token.
            assert_eq!(CompanionBackendMode::from_persisted(Some(token)), mode);
        }
    }

    #[test]
    fn engine_error_codes_serialize_camel_case() {
        // Every published code (the C-1 contract ST-4/ST-5 also produce) must
        // serialize under its camelCase wire name and carry a curated detail.
        let codes = [
            (CompanionEngineErrorCode::GpuUnavailable, "\"gpuUnavailable\""),
            (CompanionEngineErrorCode::BackendInitFailed, "\"backendInitFailed\""),
            (CompanionEngineErrorCode::ModelMissing, "\"modelMissing\""),
            (CompanionEngineErrorCode::ModelLoadFailed, "\"modelLoadFailed\""),
            (CompanionEngineErrorCode::MtpInitFailed, "\"mtpInitFailed\""),
            (CompanionEngineErrorCode::MmprojInitFailed, "\"mmprojInitFailed\""),
            (CompanionEngineErrorCode::ContextCreateFailed, "\"contextCreateFailed\""),
            (CompanionEngineErrorCode::Busy, "\"busy\""),
            (CompanionEngineErrorCode::StartTimeout, "\"startTimeout\""),
        ];
        for (code, wire) in codes {
            assert_eq!(
                serde_json::to_string(&code).expect("serialize code"),
                wire,
                "code {code:?} wire name"
            );
            // Every code carries a non-empty curated detail (never a raw string).
            assert!(!code.detail().trim().is_empty(), "code {code:?} has no detail");
        }
    }

    #[test]
    fn missing_file_classification_maps_each_subsystem() {
        assert_eq!(
            CompanionEngineErrorCode::for_missing_file("model"),
            CompanionEngineErrorCode::ModelMissing
        );
        assert_eq!(
            CompanionEngineErrorCode::for_missing_file("vision"),
            CompanionEngineErrorCode::MmprojInitFailed
        );
        assert_eq!(
            CompanionEngineErrorCode::for_missing_file("mtp"),
            CompanionEngineErrorCode::MtpInitFailed
        );
    }

    #[test]
    fn failure_results_carry_the_typed_code_and_curated_detail() {
        let result = CompanionEngineStartResult::failure(CompanionEngineErrorCode::GpuUnavailable);
        assert!(!result.success);
        assert_eq!(result.code, Some(CompanionEngineErrorCode::GpuUnavailable));
        assert_eq!(result.detail, CompanionEngineErrorCode::GpuUnavailable.detail());
        assert!(result.backend.is_none());
        assert!(result.devices.is_empty());
    }
}
