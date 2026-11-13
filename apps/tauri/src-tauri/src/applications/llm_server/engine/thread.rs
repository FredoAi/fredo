//! The engine thread body (Spec #3141, ST-1).
//!
//! ONE dedicated OS thread owns every `!Send` engine value. Its whole job is:
//!
//! 1. own the [`EngineCommand`] receiver,
//! 2. on `Start`: point the engine log at the companion dir, initialise the
//!    backend ONCE (a process-once gate), load the main model with the offload
//!    the requested mode asks for, read ggml's typed device set, project the
//!    mode onto it, and verify a context can be created,
//! 3. on `Stop`: drop the model and exit.
//!
//! It publishes the terminal status of each command into the shared
//! [`EngineSlot`] the handle exposes.
//!
//! Later sub-tasks (ST-2 generation, ST-4 MTP, ST-5 multimodal) extend the run
//! loop. ST-1 deliberately loads the MAIN model only — the projector and draft
//! contexts arrive in their own sub-tasks — but the manifest path rule is
//! already the only path rule.
//!
//! ## Why nothing here is `async`
//!
//! `LlamaContext`/`MtpSession` are `!Send`, and the backend is a process-once
//! global. An async executor could migrate the future between worker threads
//! (and would need every engine value to be `Send`), so the engine body is a
//! plain blocking loop on its own thread. The async command adapters bridge to
//! it over a bounded channel.

use std::num::NonZeroU32;
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex};

use llama_cpp_4::context::params::LlamaContextParams;
use llama_cpp_4::llama_backend::LlamaBackend;

use super::device::{self, ModeProjection};
use super::handle::{EngineSlot, EngineStatusSnapshot};
use super::paths;
use super::sampling::SamplingSettings;
use super::{
    CompanionBackendKind, CompanionBackendMode, CompanionEngineErrorCode,
    CompanionEngineStartResult, EngineCommand, StartRequest,
};

/// Everything the engine thread owns once started. Dropped on `Stop` / thread
/// exit, which releases the model (and therefore the ggml device set).
pub struct EngineState {
    /// The loaded main model. Declared BEFORE the backend so Rust drops it FIRST
    /// — struct fields drop in declaration order, and `llama_backend_free`
    /// requires every model to be released before the backend. Read for the start
    /// log line; ST-2 owns the generation loop that keeps using it.
    pub model: llama_cpp_4::model::LlamaModel,
    /// Proof the backend was initialised.
    ///
    /// Retained (never read) ONLY for two reasons: it must outlive the model
    /// (drop order, see [`Self::model`]), and ST-2's generation loop creates its
    /// retained context from the same process-once backend. The leading
    /// underscore documents that this field exists for ownership, not reads.
    _backend: LlamaBackend,
    /// The device set ggml reports for the loaded model (post-coercion).
    pub devices: Vec<super::CompanionDeviceInfo>,
    /// The reported backend (`None` only when the enumeration is empty).
    pub backend_kind: Option<CompanionBackendKind>,
    /// The canonical model id (manifest `model` file stem).
    pub model_id: Option<String>,
}

impl EngineState {
    /// The status snapshot this state publishes.
    fn snapshot(&self) -> EngineStatusSnapshot {
        EngineStatusSnapshot {
            loaded: true,
            last_error_code: None,
            last_error: None,
            backend: self.backend_kind,
            devices: self.devices.clone(),
            model_id: self.model_id.clone(),
        }
    }

    /// A one-line description of the loaded model, for the start log.
    fn describe(&self) -> String {
        format!(
            "{} ({} parameters, {} training context)",
            self.model_id.as_deref().unwrap_or("companion model"),
            self.model.n_params(),
            self.model.n_ctx_train()
        )
    }
}

/// The engine thread's entry point. Runs until a `Stop` (or the sender drops),
/// publishing each command's terminal status into `slot`.
pub fn run(receiver: Receiver<EngineCommand>, slot: Arc<Mutex<EngineSlot>>) {
    // The ONE engine state slot. `Some` between a successful start and a stop.
    let mut state: Option<EngineState> = None;

    while let Ok(command) = receiver.recv() {
        match command {
            EngineCommand::Start(request) => match start_engine(*request) {
                StartOutcome::Ready(new_state) => {
                    tracing::info!(
                        target: "fredo::llm_server",
                        model = %new_state.describe(),
                        backend = ?new_state.backend_kind,
                        devices = new_state.devices.len(),
                        "companion engine ready"
                    );
                    publish(&slot, new_state.snapshot());
                    state = Some(new_state);
                }
                StartOutcome::Failed(code, detail) => {
                    // A failed start leaves any previously loaded state intact
                    // (it is still usable) and publishes the typed failure.
                    tracing::warn!(
                        target: "fredo::llm_server",
                        ?code,
                        %detail,
                        "companion engine start failed"
                    );
                    let snapshot = EngineStatusSnapshot {
                        loaded: state.is_some(),
                        last_error_code: Some(code),
                        last_error: Some(detail),
                        backend: state.as_ref().and_then(|s| s.backend_kind),
                        devices: state.as_ref().map(|s| s.devices.clone()).unwrap_or_default(),
                        model_id: state.as_ref().and_then(|s| s.model_id.clone()),
                    };
                    publish(&slot, snapshot);
                }
            },
            EngineCommand::Stop => {
                // Dropping the state releases the model (and its device set).
                drop(state.take());
                publish(&slot, EngineStatusSnapshot::default());
                break;
            }
        }
    }
}

/// Publish a snapshot into the shared slot, preserving the requested mode.
fn publish(slot: &Arc<Mutex<EngineSlot>>, snapshot: EngineStatusSnapshot) {
    if let Ok(mut guard) = slot.lock() {
        guard.snapshot = snapshot;
    }
}

/// The terminal outcome of one start attempt.
enum StartOutcome {
    /// The engine is loaded and usable.
    Ready(EngineState),
    /// The start failed with a typed code + curated detail.
    Failed(CompanionEngineErrorCode, String),
}

/// Execute one bounded start, reporting the terminal outcome on the request's
/// reply channel and returning the outcome to the run loop.
///
/// Never panics on a fallible path: every failure is a typed
/// [`StartOutcome::Failed`].
fn start_engine(request: StartRequest) -> StartOutcome {
    match try_start(&request) {
        Ok(state) => {
            let outcome = CompanionEngineStartResult {
                success: true,
                code: None,
                detail: "the companion engine is ready.".to_string(),
                backend: state.backend_kind,
                devices: state.devices.clone(),
            };
            // A dropped receiver means the caller gave up (its start budget
            // elapsed); the state is still valid, so keep it.
            let _ = request.reply.send(outcome);
            StartOutcome::Ready(state)
        }
        Err((code, detail)) => {
            let _ = request.reply.send(CompanionEngineStartResult {
                success: false,
                code: Some(code),
                detail: detail.clone(),
                backend: None,
                devices: Vec::new(),
            });
            StartOutcome::Failed(code, detail)
        }
    }
}

/// The number of GPU layers to request for a mode BEFORE the device set is
/// known. `cpu` asks for zero; `auto`/`gpu` ask for every layer and the loaded
/// device set then decides whether that was honoured.
///
/// The mapping is expressed through [`device::gpu_layers_for`] so the projection
/// and the load request share ONE rule (NFR-6).
pub fn requested_offload_layers(mode: CompanionBackendMode) -> u32 {
    let projection = match mode {
        CompanionBackendMode::Cpu => ModeProjection::CpuOnly,
        CompanionBackendMode::Auto | CompanionBackendMode::Gpu => ModeProjection::FullOffload,
    };
    device::gpu_layers_for(projection)
}

/// Build the context parameters from the relocated sampling defaults.
///
/// ST-1 creates the context ONLY to prove the loaded model can be initialised
/// (the engine start gate); the generation loop that uses it belongs to ST-2.
fn context_params(settings: &SamplingSettings) -> LlamaContextParams {
    LlamaContextParams::default()
        .with_n_ctx(NonZeroU32::new(settings.ctx_size))
        .with_n_threads(settings.threads)
        .with_n_threads_batch(settings.threads_batch)
}

/// Serialises one engine start at a time across the whole process.
///
/// `LlamaBackend::init()` is a process-once gate and `LlamaBackend` frees the
/// backend on drop, so two overlapping starts (two handles, or a test harness
/// with several cases) would race the global. This lock makes the
/// "one engine at a time per process" rule (NFR-2) structural rather than
/// assumed — and it is what keeps the engine's start path deterministic.
static START_LOCK: Mutex<()> = Mutex::new(());

/// The fallible core of a start: log wiring, backend init, load, device readout,
/// projection, and a context-creation proof.
///
/// Ordering is deliberate: ggml reports `0` devices until a model is loaded, so
/// the device set cannot be used to decide the offload request. We therefore
/// request the offload the MODE implies, load, read the resolved set, and only
/// then apply the mode projection — which is what makes `gpu` on a GPU-less
/// host a typed refusal instead of a silent CPU degradation (AC-25).
fn try_start(request: &StartRequest) -> Result<EngineState, (CompanionEngineErrorCode, String)> {
    // Serialise with any other start in the process (NFR-2, process-once backend).
    let _guard = START_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    // 0. Point llama.cpp's log at the companion dir (explicit path — no temp
    //    dir, no stdout redirect). A failure here is non-fatal: the engine can
    //    still run, it just logs to stderr.
    if let Some(log_path) = request.paths.log.as_deref() {
        if let Err(error) = llama_cpp_4::runtime::log::set_file(Some(log_path)) {
            tracing::warn!(
                target: "fredo::llm_server",
                %error,
                path = log_path,
                "could not point the engine log at the companion dir"
            );
        }
    }

    // 1. Backend: process-once. `init()` yields `BackendAlreadyInitialized` when
    //    an engine is already live in this process; the handle layer owns the
    //    single engine slot, so a duplicate start is a caller bug surfaced as a
    //    backend-init failure rather than a panic.
    let backend = LlamaBackend::init().map_err(|error| {
        (
            CompanionEngineErrorCode::BackendInitFailed,
            format!("the inference backend could not initialise: {error}"),
        )
    })?;

    // 2. Load the main model with the offload the mode requests.
    let layers = requested_offload_layers(request.mode);
    let params = paths::model_params(layers);
    let model = paths::load_model(&backend, &request.paths.model, &params)?;

    // 3. Read ggml's typed device set, then apply the TEST-ONLY seam. The
    //    coercion happens HERE so the forced set is what every reader sees.
    let devices = device::apply_force_cpu(device::enumerate(&model), request.force_cpu);
    let backend_kind = device::report_backend(&devices);

    // 4. Project the mode onto the REPORTED (post-coercion) device set.
    let projection = device::project(request.mode, &devices);
    if let Some(code) = device::projection_error(projection) {
        return Err((code, code.detail().to_string()));
    }
    // A `gpu` request that resolved to a CPU-only set silently degraded — refuse
    // it rather than claim a GPU backend (AC-25).
    if projection == ModeProjection::FullOffload && backend_kind == Some(CompanionBackendKind::Cpu) {
        return Err((
            CompanionEngineErrorCode::GpuUnavailable,
            CompanionEngineErrorCode::GpuUnavailable.detail().to_string(),
        ));
    }

    // 5. Prove the loaded model can be initialised: create (and drop) one
    //    context with the relocated sampling defaults. This is the engine-start
    //    gate's real "it loads" evidence; ST-2 owns the retained generation
    //    context (a `LlamaContext` borrows the model, so keeping both is a
    //    self-referential struct this sub-task does not need).
    let settings = SamplingSettings::default();
    let n_ctx = {
        let context = model
            .new_context(&backend, context_params(&settings))
            .map_err(|error| {
                (
                    CompanionEngineErrorCode::ContextCreateFailed,
                    format!("the model context could not be created: {error}"),
                )
            })?;
        // Read back the resolved context size so the proof is real, not nominal.
        context.n_ctx()
    };
    tracing::debug!(
        target: "fredo::llm_server",
        n_ctx,
        "companion context created"
    );

    let model_id = paths::model_id_for(&request.paths.model);
    Ok(EngineState {
        model,
        _backend: backend,
        devices,
        backend_kind,
        model_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The offload request is a pure function of the mode: `cpu` ⇒ zero,
    /// `auto`/`gpu` ⇒ every layer. This is the pure half of the ST-1
    /// full-vs-zero-offload discriminator (the executed half needs the model
    /// files and lives in the engine integration test).
    #[test]
    fn requested_offload_follows_the_mode() {
        assert_eq!(requested_offload_layers(CompanionBackendMode::Cpu), 0);
        assert_eq!(requested_offload_layers(CompanionBackendMode::Auto), u32::MAX);
        assert_eq!(requested_offload_layers(CompanionBackendMode::Gpu), u32::MAX);
    }

    /// The context params are built from the relocated sampling defaults, so the
    /// engine start gate uses the SAME values the launch config shipped.
    #[test]
    fn context_params_carry_the_reference_defaults() {
        let settings = SamplingSettings::default();
        let params = context_params(&settings);
        assert_eq!(params.n_ctx().map(NonZeroU32::get), Some(131_072));
        assert_eq!(params.n_threads(), 6);
        assert_eq!(params.n_threads_batch(), 12);
    }
}
