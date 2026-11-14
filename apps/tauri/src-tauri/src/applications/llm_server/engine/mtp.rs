//! MTP (multi-token-prediction) speculative decoding for the in-process engine
//! (Spec #3141, ST-4; AC-19 / R-19.1–R-19.5).
//!
//! ## What this replaces
//!
//! The retired `llama-server` launch config asked the server for speculative
//! decoding with a SEPARATE draft checkpoint
//! (`--spec-type draft-mtp --model-draft MTP/mtp-gemma-4-E2B-it-Q4_0.gguf
//! --spec-draft-n-max 2`). In-process there is no server to do that: this module
//! owns the draft model, the paired draft/target contexts, and the
//! draft → verify → accept → rollback loop.
//!
//! ## The pinned pairing — a LIVE determination, not a doc claim
//!
//! Gemma4's drafter is a **separate** checkpoint whose architecture is
//! `gemma4-assistant` (read from the pinned GGUF's own metadata on this host:
//! `general.architecture = gemma4-assistant`, `gemma4-assistant.nextn_predict_layers
//! = 4`, `embedding_length_out = 1536`; the target GGUF is `gemma4` with no
//! `nextn_predict_layers`). That architecture reads the target's token embedding
//! and hidden state through `llama_get_ctx_other`, so llama.cpp's context
//! constructor REFUSES to build such a context unless the caller paired it:
//! `src/models/gemma4-assistant.cpp` asserts `cparams.ctx_other != nullptr`, and
//! `src/llama-context.cpp` throws
//! `"Gemma4Assistant requires ctx_other to be set"` before any allocation.
//!
//! The pairing is also what selects the speculative driver's gemma4 mode:
//! upstream derives `is_mem_shared = llama_get_ctx_other(ctx_dft) == ctx_tgt`
//! (`common/speculative.cpp`, `common_speculative_impl_draft_mtp` ctor), and only
//! that mode shares the target KV and runs all draft heads in one graph.
//!
//! So the pinned trio requires **the shared-target-KV pairing** —
//! [`LlamaContextParams::with_ctx_other`] pointing at the target context, which
//! is what [`MTP_PAIRING_SHARED_TARGET_KV`] records. The plain separate-weights
//! path is not merely slower for this checkpoint: it cannot construct the draft
//! context at all. The live test
//! `the_pinned_draft_gguf_requires_the_shared_target_kv_pairing` asserts BOTH
//! halves (plain FAILS, paired succeeds with a non-null `ctx_other`).
//!
//! ## The counters are Fredo's own
//!
//! [`MtpStats`] is incremented by THIS loop: `drafts.len()` from
//! [`MtpSession::draft`] and the accepted length from [`verify_drafts`]. It is
//! never parsed from a log line and never read from [`MtpSession::print_stats`]
//! (which only emits counters through llama.cpp's log callback — not a typed
//! API).
//!
//! ## The rollback contract (R-19.4)
//!
//! After the verify batch decodes `[last_token, drafts…]`, the target KV holds
//! every draft position. When the verifier accepts fewer than were proposed, the
//! rejected suffix is removed from **both** contexts
//! ([`MtpSession::clear_target_kv_cache_seq`] /
//! [`MtpSession::clear_draft_kv_cache_seq`]) before [`MtpSession::accept`] syncs
//! the draft's recurrent carry-over. A rejected step therefore costs one
//! verification pass, never a corrupted position sequence.
//!
//! ## No non-speculative fallback (R-19.5)
//!
//! A session that cannot be built is a TYPED
//! [`CompanionEngineErrorCode::MtpInitFailed`] failure: the engine start fails
//! and the turn never runs. There is deliberately no "continue without drafts"
//! branch — a migration that silently dropped speculative decoding would look
//! identical to a working one.

use std::num::NonZeroU32;
use std::path::Path;

use serde::Serialize;

use llama_cpp_4::context::params::{LlamaContextParams, LlamaContextType};
use llama_cpp_4::context::LlamaContext;
use llama_cpp_4::llama_backend::LlamaBackend;
use llama_cpp_4::llama_batch::LlamaBatch;
use llama_cpp_4::model::params::LlamaModelParams;
use llama_cpp_4::model::{AddBos, LlamaModel};
use llama_cpp_4::mtmd::MtmdContext;
use llama_cpp_4::mtp::{MtpSession, MtpSessionConfig};
use llama_cpp_4::sampling::LlamaSampler;
use llama_cpp_4::token::LlamaToken;

use super::chat_format::ChatFormat;
use super::detokenize::TokenStreamDecoder;
use super::paths;
use super::request::ChatTurn;
use super::sampling::{GrammarSpec, SamplingSettings};
use super::thread::{decode_error, truncate_prompt};
use super::CompanionEngineErrorCode;// ── The pinned configuration ─────────────────────────────────────────────────

/// Maximum tokens drafted per step.
///
/// Parity with the retired `--spec-draft-n-max 2`, and a NON-GOAL of this
/// sub-task: it is a constant, never a setting and never a per-turn argument, so
/// nothing can silently tune it.
pub const MTP_N_DRAFT_MAX: i32 = 2;

/// Recurrent-state snapshots per sequence.
///
/// The crate requires `n_rs_seq >= n_draft_max` on the draft context; the
/// reference implementation uses 4, so the pin holds with margin (R-19.2).
pub const MTP_N_RS_SEQ: u32 = 4;

/// The one sequence a turn uses (the retired config pinned `--parallel 1`).
pub const MTP_SEQ_ID: i32 = 0;

/// Minimum draft tokens to propose (upstream `n_min`, default `0`).
pub const MTP_N_MIN: i32 = 0;

/// Draft probability floor (upstream `p_min`; `0.0` since llama.cpp #23269).
pub const MTP_P_MIN: f32 = 0.0;

/// Which pairing the pinned `MTP/mtp-gemma-4-E2B-it-Q4_0.gguf` requires.
///
/// Determined LIVE on the pinned GGUF pair (see the module docs): the draft
/// checkpoint is `gemma4-assistant`, which cannot be given a context without
/// `ctx_other`, and `is_mem_shared` (the mode that shares the target KV) is
/// exactly `llama_get_ctx_other(ctx_dft) == ctx_tgt`. `true` therefore means
/// "pair the draft context with the target".
///
/// The alternative (a plain separate-weights draft context) is not a fallback
/// that could be selected silently — the live test named above asserts that it
/// FAILS to construct on this checkpoint.
pub const MTP_PAIRING_SHARED_TARGET_KV: bool = true;

// ── The counters (Fredo's own) ───────────────────────────────────────────────

/// Speculative-decoding counters measured by Fredo's generation loop.
///
/// Serialized into the status surface (camelCase), so the R-19.1 observable —
/// non-zero proposed AND accepted — is readable without a log.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MtpStats {
    /// How many draft tokens were PROPOSED across every draft step.
    pub drafts_proposed: u64,
    /// How many of the proposed drafts the target verifier ACCEPTED.
    pub drafts_accepted: u64,
    /// How many draft steps ran.
    pub draft_calls: u64,
}

impl MtpStats {
    /// Record one draft step's outcome.
    pub fn record(&mut self, proposed: usize, accepted: usize) {
        self.draft_calls = self.draft_calls.saturating_add(1);
        self.drafts_proposed = self.drafts_proposed.saturating_add(proposed as u64);
        self.drafts_accepted = self.drafts_accepted.saturating_add(accepted as u64);
    }

    /// Add another turn's counters into this (cumulative) set.
    pub fn accumulate(&mut self, other: Self) {
        self.drafts_proposed = self.drafts_proposed.saturating_add(other.drafts_proposed);
        self.drafts_accepted = self.drafts_accepted.saturating_add(other.drafts_accepted);
        self.draft_calls = self.draft_calls.saturating_add(other.draft_calls);
    }

    /// Whether a draft step ever proposed anything (R-19.1's first half).
    pub fn proposed_anything(&self) -> bool {
        self.drafts_proposed > 0
    }

    /// Whether the verifier ever accepted a draft (R-19.1's second half).
    pub fn accepted_anything(&self) -> bool {
        self.drafts_accepted > 0
    }
}

// ── The typed failure ────────────────────────────────────────────────────────

/// A curated detail for an MTP-subsystem failure.
///
/// The typed code is always [`CompanionEngineErrorCode::MtpInitFailed`] — the
/// code that names the subsystem — while `what` says which step failed. The
/// primary copy a user sees is therefore curated, never a bare library string
/// (NFR-5).
fn mtp_failure(what: &str, error: impl std::fmt::Display) -> (CompanionEngineErrorCode, String) {
    (
        CompanionEngineErrorCode::MtpInitFailed,
        format!(
            "the speculative draft model could not {what}: {error}. \
             Re-download the model files from Companion setup."
        ),
    )
}

/// The typed failure **and** its curated copy, for the R-19.5 gates.
///
/// `mtp_failure` is the production path; this alias exists so the tests can
/// assert the mapping without reaching into a private item.
#[cfg(test)]
pub(super) fn mtp_failure_for_test(
    what: &str,
    error: &str,
) -> (CompanionEngineErrorCode, String) {
    mtp_failure(what, error)
}

// ── Model + context construction ─────────────────────────────────────────────

/// The draft model path for a resolved engine-path set.
///
/// The ONE place a caller may learn the draft path: it is the shared manifest's
/// `mtp` spec (already resolved by [`paths::EnginePaths::resolve`]) — never a
/// literal path and never a persisted override (R-19.3 / R-18.2).
pub fn draft_path(engine_paths: &paths::EnginePaths) -> &Path {
    &engine_paths.mtp
}

/// Load the draft model from its resolved manifest path.
///
/// The path is ALWAYS [`paths::EnginePaths::mtp`], i.e. the shared manifest's
/// `mtp` spec (`MTP/mtp-gemma-4-E2B-it-Q4_0.gguf` under the pinned revision) —
/// never a literal, never a settings override (R-19.3 / R-18.2).
///
/// `load_mtp(true)` is requested because upstream skips a checkpoint's MTP
/// tensors when it is off; for the pinned drafter those ARE the model (R-19.2).
pub fn load_draft_model(
    backend: &LlamaBackend,
    draft_path: &Path,
    gpu_layers: u32,
) -> Result<LlamaModel, (CompanionEngineErrorCode, String)> {
    let params = LlamaModelParams::default()
        .with_n_gpu_layers(gpu_layers)
        .with_load_mtp(true);
    LlamaModel::load_from_file(backend, draft_path, &params)
        .map_err(|error| mtp_failure("be loaded", error))
}

/// The draft context parameters: the `Mtp` context type and the rollback
/// snapshots (R-19.2).
///
/// The context size and thread counts are the engine's reference values, so the
/// draft sees the same window as the target.
pub fn draft_context_params(settings: &SamplingSettings) -> LlamaContextParams {
    LlamaContextParams::default()
        .with_n_ctx(NonZeroU32::new(settings.ctx_size))
        .with_n_threads(settings.threads)
        .with_n_threads_batch(settings.threads_batch)
        .with_ctx_type(LlamaContextType::Mtp)
        .with_n_rs_seq(MTP_N_RS_SEQ)
}

/// The target (verifier) context for a speculative turn.
///
/// It is the engine's `Default` context (the same parameters every non-media
/// turn uses), so the verifier sees exactly the context a non-speculative turn
/// would.
pub fn create_target_context<'m>(
    backend: &LlamaBackend,
    model: &'m LlamaModel,
    settings: &SamplingSettings,
) -> Result<LlamaContext<'m>, (CompanionEngineErrorCode, String)> {
    model
        .new_context(backend, super::thread::context_params(settings))
        .map_err(|error| mtp_failure("create its verification context", error))
}

/// The draft context for a speculative turn, paired with `target`.
///
/// When [`MTP_PAIRING_SHARED_TARGET_KV`] holds (the determined pairing for the
/// pinned GGUF), the context is created with
/// [`LlamaContextParams::with_ctx_other`] so upstream selects gemma4's
/// `is_mem_shared` mode. Without it llama.cpp refuses this checkpoint outright.
pub fn create_draft_context<'m>(
    backend: &LlamaBackend,
    draft_model: &'m LlamaModel,
    target: &LlamaContext<'m>,
    settings: &SamplingSettings,
) -> Result<LlamaContext<'m>, (CompanionEngineErrorCode, String)> {
    let params = draft_context_params(settings);
    let params = if MTP_PAIRING_SHARED_TARGET_KV {
        params.with_ctx_other(target)
    } else {
        params
    };
    draft_model
        .new_context(backend, params)
        .map_err(|error| mtp_failure("create its draft context", error))
}

/// The single MTP session configuration: `n_seq = 1`, `n_draft_max = 2`.
///
/// Built in ONE place so no caller can vary it (the non-goal is "n_draft_max
/// stays 2").
pub fn session_config() -> MtpSessionConfig {
    MtpSessionConfig::new(1, MTP_N_DRAFT_MAX)
        .with_n_min(MTP_N_MIN)
        .with_p_min(MTP_P_MIN)
}

/// Construct the MTP session over the two paired contexts.
///
/// A failure here is the R-19.5 typed refusal: the caller surfaces
/// [`CompanionEngineErrorCode::MtpInitFailed`] and the engine start fails.
pub fn open_session<'ctx, 'model>(
    target: &'ctx mut LlamaContext<'model>,
    draft: &'ctx mut LlamaContext<'model>,
) -> Result<MtpSession<'ctx, 'model>, (CompanionEngineErrorCode, String)> {
    let config = session_config();
    MtpSession::new_with_config(target, draft, config)
        .map_err(|error| mtp_failure("open a speculative session", error))
}

// ── The acceptance policy (the one verifier) ─────────────────────────────────

/// How a verification step's drafts are judged.
///
/// [`Self::LongestMatchingPrefix`] is the shipped rule (and the one the crate's
/// `examples/mtp/src/main.rs::run_speculative` implements): sample the target at
/// each position and accept the longest prefix whose sampled token equals the
/// proposed draft.
///
/// [`Self::RejectAllDrafts`] is the FORCED-REJECTION induction R-19.4 requires:
/// every draft at every position is refused, so the loop must roll both contexts
/// back and keep generating. It is a test seam, never selected in production.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerifyPolicy {
    /// Accept the longest prefix where the target's token matches the draft.
    LongestMatchingPrefix,
    /// Accept nothing — every draft is rejected at every position.
    RejectAllDrafts,
}

/// Sample the target's verification tokens and decide how many drafts survive.
///
/// Returns `(n_accepted, next_token)`. `next_token` is the token the model
/// produced ONE STEP FURTHER than the last accepted draft — the loop's next
/// `last_token`.
///
/// `n_verify` is the verify batch's token count, which bounds the logits row
/// index (`i + 1`) that may be sampled.
///
/// ## No double accept, and a recoverable failure is TYPED
///
/// `try_sample` already accepts the token it sampled (llama.cpp's
/// `llama_sampler_sample` ends with `llama_sampler_accept`), so the loop must
/// NOT accept it again: a second accept advances the grammar twice per token and
/// desynchronises it even when the trigger was translated correctly.
///
/// A grammar that can no longer accept anything is recoverable — the crate
/// documents it as "a property of the model/grammar pair, not a bug" — so every
/// call goes through the fallible API and a failure becomes a typed turn
/// failure, never a panic that kills the engine thread.
pub fn verify_drafts(
    target: &LlamaContext<'_>,
    sampler: &mut LlamaSampler,
    drafts: &[LlamaToken],
    n_verify: usize,
    policy: VerifyPolicy,
) -> Result<(usize, LlamaToken), (CompanionEngineErrorCode, String)> {
    // The token that follows `last_token` sits in the verify batch's row 0.
    // `try_sample` accepts it (see the doc above) — no second accept here.
    let mut next_token = sampler
        .try_sample(target, 0)
        .map_err(|error| sampling_failure("sample the companion reply", error))?;

    if policy == VerifyPolicy::RejectAllDrafts {
        return Ok((0, next_token));
    }

    let mut n_accepted: usize = 0;
    for (index, draft) in drafts.iter().enumerate() {
        if next_token != *draft {
            break;
        }
        n_accepted = index + 1;
        if index + 1 < n_verify {
            next_token = sampler
                .try_sample(target, (index + 1) as i32)
                .map_err(|error| sampling_failure("verify a draft token", error))?;
        }
    }
    Ok((n_accepted, next_token))
}

/// A curated detail for a sampling failure.
///
/// The typed code is [`CompanionEngineErrorCode::ContextCreateFailed`] — the
/// engine's "generation could not run" code — while `what` names the step, so
/// the primary copy is curated and the library string is the tail (NFR-5).
///
/// This is the recovery the plan requires: a grammar rejection must fail the
/// TURN, not the engine thread. The caller settles it as `llm-error` + one
/// `llm-done`, and the engine keeps serving the next turn.
fn sampling_failure(
    what: &str,
    error: impl std::fmt::Display,
) -> (CompanionEngineErrorCode, String) {
    (
        CompanionEngineErrorCode::ContextCreateFailed,
        format!("the companion could not {what}: {error}. Start the engine again and retry."),
    )
}

// ── The speculative generation loop ─────────────────────────────────────────

/// Everything one speculative turn produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpeculativeOutcome {
    /// The full assistant text as released by the incremental decoder.
    pub content: String,
    /// How many tokens were emitted (including the end-of-generation token when
    /// one was produced).
    pub tokens_generated: u32,
    /// How many prompt tokens the turn evaluated after truncation.
    pub prompt_tokens: u32,
    /// Whether the model ended the turn itself rather than the budget running out.
    pub stopped_on_eog: bool,
    /// Whether the prompt had to be truncated to fit the context window.
    pub prompt_truncated: bool,
    /// The counters measured by THIS loop (R-19.1).
    pub stats: MtpStats,
}

/// Prefill the prompt on the target context, in batch-sized chunks with explicit
/// positions, delivering each chunk to the MTP session's process hook.
///
/// Explicit positions are required because a batch's implicit positions restart
/// at zero after a clear, which would corrupt a multi-chunk prompt. Only the
/// prompt's FINAL token is flagged for logits — that is the row the first sample
/// reads. Every chunk goes through `decode_target_and_process`, so the draft
/// side sees every prefill position.
fn prefill<'model>(
    session: &mut MtpSession<'_, 'model>,
    prompt_tokens: &[LlamaToken],
) -> Result<(), (CompanionEngineErrorCode, String)> {
    let n_batch = (session.target_context().n_batch().max(1) as usize).max(1);
    let total = prompt_tokens.len();
    let mut position: i32 = 0;
    let mut consumed = 0usize;

    while consumed < total {
        let end = (consumed + n_batch).min(total);
        let chunk = &prompt_tokens[consumed..end];
        let mut batch = LlamaBatch::new(chunk.len(), 1);
        for (offset, token) in chunk.iter().enumerate() {
            let is_last_of_prompt = consumed + offset + 1 == total;
            batch
                .add(*token, position, &[0], is_last_of_prompt)
                .map_err(|error| decode_error(error.to_string()))?;
            position += 1;
        }
        session
            .decode_target_and_process(&mut batch)
            .map_err(|error| mtp_failure("verify the prompt", error))?;
        consumed = end;
    }
    Ok(())
}

/// Release one token through the incremental decoder.
fn release_token(
    decoder: &mut TokenStreamDecoder<'_>,
    token: LlamaToken,
    content: &mut String,
    on_text: &mut dyn FnMut(&str),
) -> Result<(), (CompanionEngineErrorCode, String)> {
    let piece = decoder.push(token).map_err(|error| {
        (
            CompanionEngineErrorCode::ContextCreateFailed,
            format!("the companion reply could not be decoded: {error}"),
        )
    })?;
    if !piece.is_empty() {
        content.push_str(&piece);
        on_text(&piece);
    }
    Ok(())
}

/// The fixed inputs of one speculative turn.
///
/// These travel together on every call — the engine's backend, the two models,
/// the template, the decoding settings, the turn, its seed, and the verification
/// policy — so grouping them keeps [`generate_speculative`]'s signature cohesive.
pub struct SpeculativeTurn<'a, 'model> {
    /// The process-once backend every context is created on.
    pub backend: &'a LlamaBackend,
    /// The target (verifier) model.
    pub model: &'model LlamaModel,
    /// The draft model loaded from the manifest's `mtp` spec.
    pub draft_model: &'model LlamaModel,
    /// The target model's chat template / grammars.
    pub format: &'a ChatFormat,
    /// The decoding settings (window, threads, sampling chain inputs).
    pub settings: &'a SamplingSettings,
    /// The turn to generate.
    pub turn: &'a ChatTurn,
    /// The sampler seed.
    pub seed: u32,
    /// How the verifier judges drafts.
    pub policy: VerifyPolicy,
    /// The loaded multimodal projector, when the turn carries an image or audio
    /// attachment (ST-5). `None` for a text-only turn — and a media turn with
    /// `None` is a typed refusal, never a text-only answer.
    pub projector: Option<&'a mut MtmdContext>,
}

/// Run one speculative turn: prefill, then draft → verify → accept → rollback.
///
/// The loop is the crate's own `run_speculative` shape, driven by Fredo's
/// sampler and Fredo's counters:
///
/// 1. `draft(seq, n_past, last_token)` proposes up to `n_draft_max` tokens;
/// 2. the draft-side KV range for the step is cleared BEFORE the verify decode
///    (the draft's own advance for `last_token` must not be read twice);
/// 3. the verify batch `[last_token, drafts…]` decodes on the target;
/// 4. the verifier accepts the longest matching prefix;
/// 5. a partial acceptance clears the rejected suffix on BOTH contexts;
/// 6. `accept(seq, n_accepted)` syncs the draft carry-over (0 = full rollback).
///
/// A MEDIA turn (ST-5) takes the same loop after a different prefill: the prompt
/// is rendered with the projector's own media marker and tokenised by `mtmd`, so
/// the attachment is spliced in at exactly the message position that carried it
/// (`super::multimodal::plan_turn` / `prefill_plan`). Everything from the first
/// sample onward is shared, which is why a vision/audio reply emits the SAME
/// `llm-*` events as a text reply.
///
/// `policy` is [`VerifyPolicy::LongestMatchingPrefix`] in production; the
/// forced-rejection test passes [`VerifyPolicy::RejectAllDrafts`].
pub fn generate_speculative<'model>(
    turn: SpeculativeTurn<'_, 'model>,
    mut on_text: impl FnMut(&str),
) -> Result<SpeculativeOutcome, (CompanionEngineErrorCode, String)> {
    // The turn's fixed inputs are grouped in [`SpeculativeTurn`] so the loop has
    // one cohesive parameter set rather than a long positional list.
    let SpeculativeTurn {
        backend,
        model,
        draft_model,
        format,
        settings,
        turn,
        seed,
        policy,
        projector,
    } = turn;
    let mut projector = projector;

    // A media turn renders the projector's marker where its attachment sits; a
    // text turn renders the text-only projection (the empty marker).
    let shaped = match projector.as_deref_mut() {
        Some(projector) => {
            format.apply_with_media_marker(turn, settings, projector.marker())?
        }
        None => format.apply(turn, settings)?,
    };

    // Grammar triggers must outlive the sampler borrow, and the translation is
    // the ONE rule ([`super::sampling::translate_triggers`]). The templates'
    // TYPED triggers are handed to `GrammarSpec::Lazy` — never a raw `value`
    // string, which was the engine-thread panic (a raw `<|tool_call>` is a regex
    // meaning `<` OR `tool_call>`).
    let triggers = shaped.grammar_triggers();
    let grammar_spec = shaped.active_grammar().map(|grammar| {
        if shaped.grammar_is_lazy() && !triggers.is_empty() {
            GrammarSpec::Lazy { grammar, triggers }
        } else {
            GrammarSpec::Strict(grammar)
        }
    });

    // Tokenise the rendered prompt. A model template always prefixes its own
    // beginning-of-sequence marker, so the tokeniser must not add a second. A
    // MEDIA prompt is tokenised by the projector instead (the marker is a media
    // splice point, not text).
    let budget = shaped.max_tokens;
    let mut media_plan: Option<super::multimodal::MediaPlan> = match projector.as_deref_mut() {
        Some(projector) if turn.has_media() => {
            Some(super::multimodal::plan_turn(projector, turn, &shaped.prompt)?)
        }
        _ => {
            // A MEDIA turn with no projector is the typed refusal — never a silent
            // text-only answer (R-20.1's negative clause). A text turn needs none.
            super::multimodal::require_projector(!turn.has_media())?;
            None
        }
    };

    // Defensive context sizing for the TEXT path: keep room for the completion
    // and drop the OLDEST turns when the conversation does not fit. A prompt that
    // cannot fit at all is a typed refusal, never a silently empty generation.
    // A multimodal prompt is NOT truncated (dropping its head would drop template
    // structure or the attachment itself): it is refused when it does not fit.
    let mut prompt_truncated = false;
    let prompt_tokens = match &media_plan {
        Some(plan) => {
            let needed = plan.n_tokens() as u64 + u64::from(budget);
            if needed > u64::from(settings.ctx_size) {
                return Err((
                    CompanionEngineErrorCode::ContextCreateFailed,
                    "the multimodal prompt and its reply do not fit the engine's context window."
                        .to_string(),
                ));
            }
            Vec::new()
        }
        None => {
            let mut tokens = model
                .str_to_token(&shaped.prompt, AddBos::Never)
                .map_err(|error| {
                    (
                        CompanionEngineErrorCode::ContextCreateFailed,
                        format!("the companion prompt could not be tokenised: {error}"),
                    )
                })?;
            prompt_truncated = truncate_prompt(&mut tokens, settings.ctx_size, budget);
            if tokens.is_empty() {
                return Err((
                    CompanionEngineErrorCode::ContextCreateFailed,
                    "the companion prompt does not fit the engine's context window.".to_string(),
                ));
            }
            tokens
        }
    };

    // The paired contexts, then the session over them. Every failure here is the
    // R-19.5 typed refusal — there is no fallback branch.
    let mut target = create_target_context(backend, model, settings)?;
    let mut draft = create_draft_context(backend, draft_model, &target, settings)?;
    let mut session = open_session(&mut target, &mut draft)?;

    tracing::debug!(
        target: "fredo::llm_server",
        n_draft_max = session.n_draft_max(),
        n_min = session.n_min(),
        p_min = session.p_min(),
        n_rs_seq = session.draft_context().n_rs_seq(),
        need_embd_pre_norm = session.need_embd_pre_norm(),
        shared_target_kv = MTP_PAIRING_SHARED_TARGET_KV,
        "companion MTP session opened"
    );

    // A turn is independent: start from empty caches on BOTH sides.
    session.target_context_mut().clear_kv_cache();
    session.draft_context_mut().clear_kv_cache();

    // The prefill: one text path, one multimodal path, both feeding the session's
    // `process()` hook so the draft side sees every prompt position. Each reports
    // the KV position after the prompt — for a media turn that is the projector's
    // position count (M-RoPE media positions are not 1:1 with tokens).
    let (tracked_tokens, prompt_positions) = match media_plan.take() {
        Some(plan) => {
            let unavailable = || {
                (
                    CompanionEngineErrorCode::MmprojInitFailed,
                    "the multimodal projector disappeared between planning and prefill"
                        .to_string(),
                )
            };
            let Some(projector) = projector.as_mut() else {
                return Err(unavailable());
            };
            let evaluated = super::multimodal::prefill_plan(&mut session, projector, &plan)?;
            tracing::debug!(
                target: "fredo::llm_server",
                image_parts = plan.image_parts,
                audio_parts = plan.audio_parts,
                prompt_tokens = plan.n_tokens(),
                prompt_positions = evaluated.n_pos,
                "companion multimodal prompt evaluated"
            );
            (plan.text_tokens, evaluated.n_pos)
        }
        None => {
            prefill(&mut session, &prompt_tokens)?;
            (prompt_tokens.clone(), prompt_tokens.len() as i32)
        }
    };

    // Tell the session which prompt was prefilled (upstream prompt tracking; it
    // also resets the draft sampler so two identical turns cannot drift).
    session
        .begin(MTP_SEQ_ID, &tracked_tokens)
        .map_err(|error| mtp_failure("track the prompt", error))?;

    let mut sampler: LlamaSampler =
        super::sampling::build_sampler(model, settings, grammar_spec, seed)?;
    let mut decoder = TokenStreamDecoder::new(model, &shaped.reserved_tokens);
    let mut content = String::new();
    let mut stats = MtpStats::default();
    let mut tokens_generated: u32 = 0;
    let mut stopped_on_eog = false;

    // The first token comes straight from the prefill's last output row.
    // `try_sample` already ACCEPTS the token it sampled — an extra `accept` here
    // would advance the grammar twice per token and desynchronise it.
    let mut last_token = sampler
        .try_sample(session.target_context(), -1)
        .map_err(|error| sampling_failure("sample the companion reply", error))?;
    let mut n_past = prompt_positions;

    if model.is_eog_token(last_token) {
        stopped_on_eog = true;
    } else {
        release_token(&mut decoder, last_token, &mut content, &mut on_text)?;
        tokens_generated += 1;
    }

    while !stopped_on_eog && tokens_generated < budget {
        let drafts = session
            .draft(MTP_SEQ_ID, n_past, last_token)
            .map_err(|error| mtp_failure("propose draft tokens", error))?;

        // Verify batch: `[last_token, drafts…]`, every row flagged for logits so
        // the verifier can sample each position.
        let mut verify = LlamaBatch::new((drafts.len() + 1).max(1), 1);
        verify
            .add(last_token, n_past, &[0], true)
            .map_err(|error| decode_error(error.to_string()))?;
        for (index, token) in drafts.iter().enumerate() {
            verify
                .add(*token, n_past + 1 + index as i32, &[0], true)
                .map_err(|error| decode_error(error.to_string()))?;
        }
        let n_verify = verify.n_tokens() as usize;

        // Roll the draft side back to the step's start before the verify decode:
        // `draft()` advanced its own state for `last_token`, and the verify batch
        // re-decodes that position with the target's hidden row injected. Under
        // the shared-target-KV pairing this is a no-op by construction (the
        // draft's cells ARE the target's) — which is why the write is
        // unconditional and never inspected for a "did anything move" signal.
        let _ = session
            .clear_draft_kv_cache_seq(Some(MTP_SEQ_ID as u32), Some(n_past as u32), None)
            .map_err(|error| mtp_failure("roll its draft context forward", error))?;

        session
            .decode_target_and_process(&mut verify)
            .map_err(|error| mtp_failure("verify a draft step", error))?;

        let (n_accepted, next_token) = verify_drafts(
            session.target_context(),
            &mut sampler,
            &drafts,
            n_verify,
            policy,
        )?;
        stats.record(drafts.len(), n_accepted);

        let new_n_past = n_past + 1 + n_accepted as i32;

        // R-19.4: a rejected suffix is removed from BOTH contexts before the
        // session is told how much survived. Under the shared-target-KV pairing
        // the draft's view IS the target's cells, so the target clear is the one
        // that frees positions — both are cleared so the loop is correct under
        // either pairing.
        if n_accepted < drafts.len() {
            let target_cleared = session
                .clear_target_kv_cache_seq(Some(MTP_SEQ_ID as u32), Some(new_n_past as u32), None)
                .map_err(|error| mtp_failure("roll its target context back", error))?;
            if !target_cleared {
                return Err(mtp_failure(
                    "roll its target context back",
                    "the target context refused a partial sequence removal",
                ));
            }
            let _ = session
                .clear_draft_kv_cache_seq(Some(MTP_SEQ_ID as u32), Some(new_n_past as u32), None)
                .map_err(|error| mtp_failure("roll its draft context back", error))?;
        }

        // Only a non-empty proposal created a pending proposal to accept.
        if !drafts.is_empty() {
            session
                .accept(MTP_SEQ_ID, n_accepted as u16)
                .map_err(|error| mtp_failure("accept a verified prefix", error))?;
        }

        // Emit the accepted drafts, then the token the verifier produced beyond
        // them — under the same budget and end-of-generation rules.
        let mut stop = false;
        for draft_token in drafts.iter().take(n_accepted) {
            if tokens_generated >= budget {
                stop = true;
                break;
            }
            if model.is_eog_token(*draft_token) {
                stopped_on_eog = true;
                stop = true;
                break;
            }
            release_token(&mut decoder, *draft_token, &mut content, &mut on_text)?;
            tokens_generated += 1;
        }
        if stop || tokens_generated >= budget {
            break;
        }
        if model.is_eog_token(next_token) {
            stopped_on_eog = true;
            break;
        }
        release_token(&mut decoder, next_token, &mut content, &mut on_text)?;
        tokens_generated += 1;

        last_token = next_token;
        n_past = new_n_past;
    }

    // Flush whatever the decoder still holds (a truncated reply stays visible).
    let tail = decoder.finish().map_err(|error| {
        (
            CompanionEngineErrorCode::ContextCreateFailed,
            format!("the companion reply could not be decoded: {error}"),
        )
    })?;
    if !tail.is_empty() {
        content.push_str(&tail);
        on_text(&tail);
    }

    tracing::debug!(
        target: "fredo::llm_server",
        drafts_proposed = stats.drafts_proposed,
        drafts_accepted = stats.drafts_accepted,
        draft_calls = stats.draft_calls,
        speculation_engaged = stats.proposed_anything() && stats.accepted_anything(),
        tokens_generated,
        "companion speculative turn finished"
    );

    Ok(SpeculativeOutcome {
        content,
        tokens_generated,
        prompt_tokens: prompt_positions as u32,
        stopped_on_eog,
        prompt_truncated,
        stats,
    })
}
