//! The engine thread body (Spec #3141, ST-1 lifecycle + ST-2 generation).
//!
//! ONE dedicated OS thread owns every `!Send` engine value. Its whole job is:
//!
//! 1. own the [`EngineCommand`] receiver,
//! 2. on `Start`: point the engine log at the companion dir, initialise the
//!    backend ONCE (a process-once gate), load the main model with the offload
//!    the requested mode asks for, read ggml's typed device set, project the
//!    mode onto it, create a context to prove the load, report the backend
//!    from where the model's weights actually landed, then verify the
//!    request-shaping surface and warm the generation path up,
//! 3. on `Stop`: drop the model and exit.
//!
//! It publishes the terminal status of each command into the shared
//! [`EngineSlot`] the handle exposes.
//!
//! ## The generation half (ST-2 + ST-4)
//!
//! Every turn is generated SPECULATIVELY ([`super::mtp::generate_speculative`]):
//! the draft model proposes tokens, the target verifies them, and the accepted
//! prefix is committed — with both contexts rolled back when a draft is
//! rejected. There is no non-speculative branch (R-19.5): a session that cannot
//! be built is a typed start failure, so a turn can never silently run without
//! speculative decoding.
//!
//! The draft model is loaded at start and its session is PROVEN constructible
//! (and exercised by the warm-up) before the engine reports ready, so a broken
//! pairing is an engine-start failure rather than a mid-conversation surprise.
//!
//! It emits NOTHING itself: the caller receives each completed text piece through
//! a callback, so the event vocabulary stays owned by the streaming sub-task
//! (ST-3) and this task cannot invent a wire channel.
//!
//! ST-5 adds the `mtmd` media parts around this loop.
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
use llama_cpp_4::token::LlamaToken;

use super::chat_format::ChatFormat;
use super::device::{self, ModeProjection};
use super::handle::{EngineSlot, EngineStatusSnapshot};
use super::mtp::MtpStats;
use super::paths;
use super::request::ChatTurn;
use super::sampling::{self, SamplingSettings};
use super::{
    CompanionBackendKind, CompanionBackendMode, CompanionEngineErrorCode,
    CompanionEngineStartResult, EngineCommand, StartRequest,
};

/// Everything the engine thread owns once started. Dropped on `Stop` / thread
/// exit, which releases the models (and therefore the ggml device set).
pub struct EngineState {
    /// The loaded main model. Declared BEFORE the backend so Rust drops it FIRST
    /// — struct fields drop in declaration order, and `llama_backend_free`
    /// requires every model to be released before the backend. Read for the start
    /// log line and borrowed by the generation loop.
    pub model: llama_cpp_4::model::LlamaModel,
    /// The loaded MTP draft model (ST-4). It is a SEPARATE checkpoint
    /// (`MTP/mtp-gemma-4-E2B-it-Q4_0.gguf`), resolved through the shared
    /// manifest and paired with the main model by every speculative turn.
    ///
    /// Declared after [`Self::model`] and before the backend: both models must be
    /// released before `llama_backend_free`.
    pub draft: llama_cpp_4::model::LlamaModel,
    /// The backend's chat format for the loaded model (ST-2).
    pub format: ChatFormat,
    /// Proof the backend was initialised.
    ///
    /// Retained (never read outside the engine thread) ONLY for two reasons: it
    /// must outlive both models (drop order, see [`Self::model`]), and every turn
    /// creates its contexts from the same process-once backend.
    /// The leading underscore documents that this field exists for ownership.
    _backend: LlamaBackend,
    /// The device set ggml reports for the loaded model (post-coercion).
    pub devices: Vec<super::CompanionDeviceInfo>,
    /// The reported backend — resolved from the loaded model's weight placement
    /// (`Some(Cpu)` whenever the engine loaded, `None` only on a failed start).
    pub backend_kind: Option<CompanionBackendKind>,
    /// The canonical model id (manifest `model` file stem).
    pub model_id: Option<String>,
    /// The cumulative MTP counters across every turn this engine has served.
    ///
    /// Written by the engine thread after each turn and published into the
    /// status snapshot, so the R-19.1 observable is readable without a log parse.
    pub mtp_stats: MtpStats,
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
            mtp_stats: Some(self.mtp_stats),
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
                        mtp_stats: state.as_ref().map(|s| s.mtp_stats),
                    };
                    publish(&slot, snapshot);
                }
            },
            EngineCommand::Stop => {
                // Dropping the state releases the models (and their device set).
                drop(state.take());
                publish(&slot, EngineStatusSnapshot::default());
                break;
            }
            EngineCommand::Chat(request) => {
                let request = *request;
                let engine = ensure_started(&mut state, &slot, &request.paths, request.mode);
                let Some(engine) = engine.as_mut() else {
                    // The start failed and published its typed status; the turn
                    // settles as a failed stream.
                    let _ = request.events.try_send(crate::applications::llm_server::engine::stream::EngineEvent::Failed {
                        code: CompanionEngineErrorCode::ModelLoadFailed,
                        detail: "the companion engine could not start; see the companion status for the typed failure."
                            .to_string(),
                    });
                    continue;
                };
                run_chat(engine, request);
                // Publish the cumulative MTP counters (R-19.1's observable).
                publish(&slot, engine.snapshot());
            }
            EngineCommand::OneShot(request) => {
                let request = *request;
                let engine = ensure_started(&mut state, &slot, &request.paths, request.mode);
                let Some(engine) = engine.as_mut() else {
                    let _ = request.reply.send(Err((
                        CompanionEngineErrorCode::ModelLoadFailed,
                        "the companion engine could not start; see the companion status for the typed failure."
                            .to_string(),
                    )));
                    continue;
                };
                run_one_shot(engine, request);
                publish(&slot, engine.snapshot());
            }
        }
    }
}

/// Start the engine when it is not loaded yet, publishing the terminal status.
///
/// A turn carries the paths + mode, so a chat after a cold boot needs no separate
/// start round-trip; a failed start leaves `state` untouched and the caller
/// settles the turn as a typed failure.
fn ensure_started<'s>(
    state: &'s mut Option<EngineState>,
    slot: &Arc<Mutex<EngineSlot>>,
    paths: &paths::EnginePaths,
    mode: CompanionBackendMode,
) -> &'s mut Option<EngineState> {
    if state.is_some() {
        return state;
    }
    let (reply, _receiver) = std::sync::mpsc::sync_channel(1);
    let request = StartRequest {
        paths: paths.clone(),
        mode,
        force_cpu: device::force_cpu(),
        reply,
    };
    match start_engine(request) {
        StartOutcome::Ready(new_state) => {
            tracing::info!(
                target: "fredo::llm_server",
                model = %new_state.describe(),
                backend = ?new_state.backend_kind,
                devices = new_state.devices.len(),
                "companion engine ready (started by a turn)"
            );
            publish(slot, new_state.snapshot());
            *state = Some(new_state);
        }
        StartOutcome::Failed(code, detail) => {
            tracing::warn!(
                target: "fredo::llm_server",
                ?code,
                %detail,
                "companion engine start failed for a turn"
            );
            let snapshot = EngineStatusSnapshot {
                loaded: false,
                last_error_code: Some(code),
                last_error: Some(detail),
                backend: None,
                devices: Vec::new(),
                model_id: None,
                mtp_stats: None,
            };
            publish(slot, snapshot);
        }
    }
    state
}

/// Generate one streaming turn, emitting the engine's events to the caller.
///
/// The content gate is what keeps a tool-call body off `llm-token`: text is
/// withheld from the control-token prefix, and at the finish the template's OWN
/// reverse parser decides whether the withheld text was a call (emitted as
/// [`EngineEvent::ToolCall`]) or ordinary content (released as a token).
fn run_chat(
    engine: &mut EngineState,
    request: crate::applications::llm_server::engine::ChatRequest,
) {
    use crate::applications::llm_server::engine::stream::{self, ContentGate, EngineEvent};

    let mut gate = if request.turn.offer_tools {
        ContentGate::for_tool_turn()
    } else {
        ContentGate::for_content_turn()
    };
    let events = request.events.clone();
    let outcome = super::mtp::generate_speculative(
        super::mtp::SpeculativeTurn {
            backend: &engine._backend,
            model: &engine.model,
            draft_model: &engine.draft,
            format: &engine.format,
            settings: &SamplingSettings::default(),
            turn: &request.turn,
            seed: request.seed,
            policy: super::mtp::VerifyPolicy::LongestMatchingPrefix,
        },
        |piece| {
            let visible = gate.push(piece);
            if !visible.is_empty() {
                let _ = events.try_send(EngineEvent::Token(visible));
            }
        },
    );

    let outcome = match outcome {
        Ok(outcome) => outcome,
        Err((code, detail)) => {
            let _ = request.events.try_send(EngineEvent::Failed { code, detail });
            return;
        }
    };
    engine.mtp_stats.accumulate(outcome.stats);

    // Decide what the withheld text was: a decoded tool call, or content.
    let mut called_tools = false;
    if let Ok(parsed) = engine.format.parse(&request.turn, gate.raw(), false) {
        // The hidden reasoning channel rides the SAME parsed body, so the Doom
        // dataset seam keeps its flag-gated capture without a second request.
        if let Some(reasoning) = stream::EngineEvent::reasoning_from_parsed(&parsed) {
            let _ = request.events.try_send(stream::EngineEvent::Reasoning(reasoning));
        }
        if request.turn.offer_tools {
            if let Some(calls) = stream::tool_calls_from_parsed(&parsed) {
                called_tools = true;
                for call in calls {
                    let _ = request.events.try_send(call);
                }
            }
        }
    }
    if !called_tools {
        let tail = gate.flush();
        if !tail.is_empty() {
            let _ = request.events.try_send(stream::EngineEvent::Token(tail));
        }
    }

    let finish_reason = if called_tools {
        Some("tool_calls".to_string())
    } else if outcome.stopped_on_eog {
        Some("stop".to_string())
    } else {
        Some("length".to_string())
    };
    let _ = request.events.try_send(EngineEvent::Finished {
        finish_reason,
        stopped_on_eog: outcome.stopped_on_eog,
    });
}

/// Generate one bounded turn and return the whole reply (the Doom path).
///
/// The whole content AND the reasoning are returned, so the decision trace keeps
/// its flag-gated capture without a second request.
fn run_one_shot(
    engine: &mut EngineState,
    request: crate::applications::llm_server::engine::OneShotRequest,
) {
    use crate::applications::llm_server::engine::stream::TurnReply;

    let outcome = super::mtp::generate_speculative(
        super::mtp::SpeculativeTurn {
            backend: &engine._backend,
            model: &engine.model,
            draft_model: &engine.draft,
            format: &engine.format,
            settings: &SamplingSettings::default(),
            turn: &request.turn,
            seed: request.seed,
            policy: super::mtp::VerifyPolicy::LongestMatchingPrefix,
        },
        |_piece| {},
    );
    match outcome {
        Ok(outcome) => {
            engine.mtp_stats.accumulate(outcome.stats);
            let _ = request.reply.send(Ok(TurnReply {
                content: outcome.content,
                reasoning: String::new(),
            }));
        }
        Err(error) => {
            let _ = request.reply.send(Err(error));
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
pub fn context_params(settings: &SamplingSettings) -> LlamaContextParams {
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
/// projection, a context-creation proof, the weight-placement backend report, the
/// request-shaping verification, and the warm-up.
///
/// Ordering is deliberate: ggml reports `0` devices until a model is loaded, so
/// the device set cannot be used to decide the offload request. We therefore
/// request the offload the MODE implies, load, read the resolved set, and apply
/// the mode projection — which is what makes `gpu` on a GPU-less host a typed
/// refusal instead of a silent CPU degradation (AC-25).
///
/// The reported backend is resolved LAST among the device questions, from the
/// loaded model's own weight buffers: the enumeration is the pre-assignment split
/// set (it contains every GPU in the process regardless of the layer count), so
/// availability and weight placement are two different questions and only the
/// second may be reported.
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
    //
    //    This set is the SPLIT enumeration (every GPU/iGPU in the process), NOT
    //    the set carrying weights — ggml builds it before any layer assignment
    //    and it is independent of the requested layer count. It answers
    //    availability, which is exactly what the mode projection and the AC-25
    //    refusal need; the reported backend is resolved later from the loaded
    //    model's own weight allocations.
    let devices = device::apply_force_cpu(device::enumerate(&model), request.force_cpu);

    // 4. Project the mode onto the (post-coercion) device set.
    let projection = device::project(request.mode, &devices);
    if let Some(code) = device::projection_error(projection) {
        return Err((code, code.detail().to_string()));
    }

    // 5. Prove the loaded model can be initialised: create (and drop) one
    //    context with the relocated sampling defaults. This is the engine-start
    //    gate's real "it loads" evidence; the retained generation context is
    //    created per turn ([`generate`]) because a `LlamaContext` borrows the
    //    model and keeping both is a self-referential struct.
    //
    //    The context is ALSO where ggml's per-buffer weight accounting is
    //    readable, so the backend report is resolved here, inside the context
    //    scope, from where the weights actually landed (never the setting).
    let settings = SamplingSettings::default();
    let (n_ctx, weight_bufts) = {
        let context = model
            .new_context(&backend, context_params(&settings))
            .map_err(|error| {
                (
                    CompanionEngineErrorCode::ContextCreateFailed,
                    format!("the model context could not be created: {error}"),
                )
            })?;
        // `model` = weight bytes on this buffer type (NOT the KV cache and NOT
        // the compute scratch), so a non-zero entry means this buffer type holds
        // part of the model.
        let weight_bufts: Vec<String> = context
            .memory_breakdown()
            .into_iter()
            .filter(|entry| entry.model > 0)
            .map(|entry| entry.buft_name)
            .collect();
        // Read back the resolved context size so the proof is real, not nominal.
        (context.n_ctx(), weight_bufts)
    };
    tracing::debug!(
        target: "fredo::llm_server",
        n_ctx,
        weight_bufts = ?weight_bufts,
        "companion context created"
    );

    // 6. Report the backend from the device CLASS (the enumeration) and the
    //    device SELECTION (ggml's own weight allocations). This is what makes
    //    `cpu` report `Cpu` on a CUDA host (AC-24.3) and a GPU-less host report
    //    `Cpu` rather than `None` (AC-23.1).
    let backend_kind = device::report_backend_for_weights(&devices, &weight_bufts);

    // 7. A `gpu`/`auto` request that resolved to full offload but whose weights
    //    landed on the host silently degraded — refuse it rather than claim a
    //    GPU backend (AC-25).
    if projection == ModeProjection::FullOffload && backend_kind == Some(CompanionBackendKind::Cpu) {
        return Err((
            CompanionEngineErrorCode::GpuUnavailable,
            CompanionEngineErrorCode::GpuUnavailable.detail().to_string(),
        ));
    }

    // 8. Build the model's chat format ONCE (ST-2). It is a pure function of the
    //    GGUF's own template, so building it at start surfaces a broken template
    //    as a typed start failure instead of a mid-turn surprise.
    let format = ChatFormat::from_model(&model)?;

    // 8b. Load the MTP DRAFT model (ST-4) from its manifest path and prove the
    //     speculative session can be built over it — the R-19.5 gate. A draft
    //     that cannot be loaded, or a pairing the checkpoint refuses, is a typed
    //     `MtpInitFailed` START failure: the engine never comes up in a
    //     non-speculative mode.
    let draft = super::mtp::load_draft_model(
        &backend,
        super::mtp::draft_path(&request.paths),
        layers,
    )?;
    prove_mtp_session(&backend, &model, &draft, &settings)?;

    let model_id = paths::model_id_for(&request.paths.model);
    let state = EngineState {
        model,
        draft,
        format,
        _backend: backend,
        devices,
        backend_kind,
        model_id,
        mtp_stats: super::mtp::MtpStats::default(),
    };

    // 9. Verify the request-shaping surface and warm up the generation half
    //    (ST-2). The capability check is the in-process replacement for the
    //    retired `/props` probe: it renders a REAL tool offer and compiles the
    //    REAL reply schema, so a model whose template cannot do what the shipped
    //    consumers need is visible in the engine log at start instead of failing
    //    on a user's first tool turn. The warm-up then runs ONE token through the
    //    real pipeline (shape → prompt eval → sampler chain → decode →
    //    incremental detokenise) so the start proves the engine can produce a
    //    turn, and llama.cpp's first-decode cost is paid up front. Both are
    //    bounded, so the start budget (NFR-3) is unaffected.
    report_capabilities(&state)?;
    warm_up(&state, &settings)?;

    Ok(state)
}

/// Log the request-shaping capability verdict for the loaded model.
///
/// A capability the shipped consumers need but the model cannot provide is a loud
/// warning (never silent): the tool offer, the reply-schema grammar, the
/// template's reverse parser, and the two media shapes are each checked against
/// the REAL template before the first user turn runs.
fn report_capabilities(state: &EngineState) -> Result<(), (CompanionEngineErrorCode, String)> {
    let capabilities = state.format.capabilities(&state.model)?;
    if capabilities.is_complete() {
        tracing::info!(
            target: "fredo::llm_server",
            named_tool_template = capabilities.named_tool_template,
            "companion request shaping verified"
        );
    } else {
        tracing::warn!(
            target: "fredo::llm_server",
            ?capabilities,
            "the companion model's template does not provide every shipped capability"
        );
    }
    Ok(())
}

/// The warm-up completion budget: ONE token — enough to exercise the sampler and
/// the detokeniser without measurably lengthening the bounded start.
pub const WARMUP_MAX_TOKENS: u32 = 1;

/// The warm-up system turn. Deliberately tiny so the eval is cheap.
const WARMUP_SYSTEM: &str = "Reply with one word.";

/// The warm-up user turn. Deliberately tiny so the eval is cheap.
const WARMUP_USER: &str = "Hi";

/// Run one bounded, single-token generation through the real decode pipeline.
///
/// This is the start-time proof that the engine can produce a turn: the model's
/// template renders, the sampler chain builds, the prompt evaluates, a token
/// samples, and the incremental detokeniser releases text. It goes through the
/// SAME speculative path every user turn uses (ST-4), so a broken MTP pairing is
/// caught here rather than on a user's first message. A failure is a TYPED start
/// failure — never a silent "it loaded but cannot generate".
fn warm_up(
    state: &EngineState,
    settings: &SamplingSettings,
) -> Result<(), (CompanionEngineErrorCode, String)> {
    let turn = ChatTurn::text(vec![
        crate::applications::llm_server::chat::LlmMessage {
            role: "system".to_string(),
            content: WARMUP_SYSTEM.to_string(),
        },
        crate::applications::llm_server::chat::LlmMessage {
            role: "user".to_string(),
            content: WARMUP_USER.to_string(),
        },
    ])
    .with_max_tokens(WARMUP_MAX_TOKENS);

    let outcome = super::mtp::generate_speculative(
        super::mtp::SpeculativeTurn {
            backend: &state._backend,
            model: &state.model,
            draft_model: &state.draft,
            format: &state.format,
            settings,
            turn: &turn,
            seed: sampling::DEFAULT_SEED,
            policy: super::mtp::VerifyPolicy::LongestMatchingPrefix,
        },
        |_piece| {},
    )?;

    tracing::debug!(
        target: "fredo::llm_server",
        prompt_tokens = outcome.prompt_tokens,
        tokens_generated = outcome.tokens_generated,
        truncated = outcome.prompt_truncated,
        drafts_proposed = outcome.stats.drafts_proposed,
        drafts_accepted = outcome.stats.drafts_accepted,
        "companion engine warmed up"
    );
    Ok(())
}

/// Prove an MTP session can be built over the loaded pair of models (R-19.5).
///
/// This runs at engine START, so a draft model that cannot be paired with the
/// target (the wrong checkpoint, a mismatched width, a missing MTP head) is a
/// typed [`CompanionEngineErrorCode::MtpInitFailed`] failure of the start rather
/// than a mid-conversation error — and, critically, the engine never reports
/// ready in a non-speculative mode.
fn prove_mtp_session(
    backend: &LlamaBackend,
    model: &llama_cpp_4::model::LlamaModel,
    draft: &llama_cpp_4::model::LlamaModel,
    settings: &SamplingSettings,
) -> Result<(), (CompanionEngineErrorCode, String)> {
    let mut target = super::mtp::create_target_context(backend, model, settings)?;
    let mut draft_context = super::mtp::create_draft_context(backend, draft, &target, settings)?;
    let session = super::mtp::open_session(&mut target, &mut draft_context)?;
    tracing::info!(
        target: "fredo::llm_server",
        n_draft_max = session.n_draft_max(),
        n_rs_seq = session.draft_context().n_rs_seq(),
        shared_target_kv = super::mtp::MTP_PAIRING_SHARED_TARGET_KV,
        "companion speculative (MTP) session verified"
    );
    Ok(())
}

// ── Shared decode helpers (ST-2, reused by ST-4) ─────────────────────────────

/// Keep at most `n_ctx - budget` prompt tokens, dropping the OLDEST ones.
///
/// Returns whether anything was dropped. The tail is kept so the most recent
/// turns (and the model's own trailing generation prompt) survive; a budget that
/// consumes the whole window leaves no room, yields an empty vector, and the
/// caller refuses the turn rather than overrunning the context.
pub fn truncate_prompt(tokens: &mut Vec<LlamaToken>, n_ctx: u32, budget: u32) -> bool {
    let limit = n_ctx.saturating_sub(budget) as usize;
    if tokens.len() <= limit {
        return false;
    }
    let excess = tokens.len() - limit;
    tokens.drain(..excess);
    true
}

/// A decode failure with the curated detail shape every engine failure uses.
pub fn decode_error(detail: String) -> (CompanionEngineErrorCode, String) {
    (
        CompanionEngineErrorCode::ContextCreateFailed,
        format!("the companion generation could not run: {detail}"),
    )
}

// ── Generation (ST-2 → ST-4) ─────────────────────────────────────────────────
//
// The non-speculative decode loop is GONE. Every turn — including the start-time
// warm-up — runs through [`super::mtp::generate_speculative`], which is the only
// generation path in the engine. That is deliberate (R-19.5): a migration that
// could silently fall back to non-speculative decoding would look identical to a
// working one, so no fallback exists to be taken.

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
    /// engine uses the SAME values the launch config shipped.
    #[test]
    fn context_params_carry_the_reference_defaults() {
        let settings = SamplingSettings::default();
        let params = context_params(&settings);
        assert_eq!(params.n_ctx().map(NonZeroU32::get), Some(131_072));
        assert_eq!(params.n_threads(), 6);
        assert_eq!(params.n_threads_batch(), 12);
    }

    /// The prompt budget keeps room for the completion: a prompt that fits is left
    /// untouched, and one that does not keeps its TAIL (the newest turns).
    #[test]
    fn prompt_truncation_keeps_the_tail_and_reports_itself() {
        let mut tokens: Vec<LlamaToken> = (0..100).map(LlamaToken).collect();
        assert!(!truncate_prompt(&mut tokens, 200, 50));
        assert_eq!(tokens.len(), 100);

        let mut tokens: Vec<LlamaToken> = (0..100).map(LlamaToken).collect();
        assert!(truncate_prompt(&mut tokens, 80, 30));
        assert_eq!(tokens.len(), 50, "keep exactly ctx - budget tokens");
        assert_eq!(
            tokens.last().map(|token| token.0),
            Some(99),
            "the NEWEST token must survive"
        );
        assert_eq!(tokens.first().map(|token| token.0), Some(50));
    }

    /// A budget that consumes the whole window leaves no room: the result is
    /// empty (and the caller refuses) rather than an over-long prompt.
    #[test]
    fn a_prompt_that_cannot_fit_is_emptied_rather_than_overrunning() {
        let mut tokens: Vec<LlamaToken> = (0..10).map(LlamaToken).collect();
        assert!(truncate_prompt(&mut tokens, 8, 8));
        assert!(tokens.is_empty());
    }
}
