//! Static/pure pins and the LIVE gates for MTP speculative decoding
//! (Spec #3141, ST-4; AC-19 / R-19.1–R-19.5).
//!
//! The pure pins need no model files and may never skip. The LIVE gates need the
//! pinned GGUF trio, which is not a repo fixture (G-172): when it is absent the
//! gate SKIPS BY NAME — it prints the exact missing-file list plus the lever that
//! points the test at a manifest-shaped dir (`FREDO_COMPANION_MODELS_DIR`) and
//! asserts nothing. That is the plan's "skipped only with an explicit named
//! blocker, never silently"; a hard panic here would instead turn every CI runner
//! (which has no models) red for an environment reason, not a defect.

use std::num::NonZeroU32;

use llama_cpp_4::context::params::{LlamaContextParams, LlamaContextType};
use llama_cpp_4::llama_backend::LlamaBackend;
use llama_cpp_4::model::params::LlamaModelParams;
use llama_cpp_4::model::LlamaModel;

use super::mtp::*;
use crate::applications::llm_server::chat::LlmMessage;
use crate::applications::llm_server::engine::chat_format::ChatFormat;
use crate::applications::llm_server::engine::paths;
use crate::applications::llm_server::engine::request::ChatTurn;
use crate::applications::llm_server::engine::sampling::SamplingSettings;
use crate::applications::llm_server::engine::CompanionEngineErrorCode;
use crate::infrastructure::companion::models::{default_manifest, file_path};

fn models_dir() -> std::path::PathBuf {
    match std::env::var("FREDO_COMPANION_MODELS_DIR") {
        Ok(dir) if !dir.trim().is_empty() => std::path::PathBuf::from(dir.trim()),
        _ => std::path::PathBuf::from(
            std::env::var("USERPROFILE")
                .or_else(|_| std::env::var("HOME"))
                .unwrap_or_else(|_| ".".to_string()),
        )
        .join("fredo-models"),
    }
}

/// Load the pinned trio, or return `None` with the NAMED skip printed.
fn load_models_or_skip() -> Option<(LlamaBackend, LlamaModel, LlamaModel)> {
    let manifest = default_manifest();
    let engine_paths = match paths::resolve_for_app(&models_dir(), &manifest) {
        Ok(paths) => paths,
        Err((code, detail)) => {
            eprintln!(
                "ST-4 MTP GATE SKIPPED (named blocker: {code:?}) — {detail}. \
                 Provide the pinned GGUF files under {} (set FREDO_COMPANION_MODELS_DIR) \
                 to run this gate. Nothing was asserted on this path.",
                models_dir().display()
            );
            return None;
        }
    };
    let backend = match LlamaBackend::init() {
        Ok(backend) => backend,
        Err(error) => {
            eprintln!("ST-4 MTP GATE SKIPPED (named blocker: backend) — {error}");
            return None;
        }
    };
    let model = match paths::load_model(&backend, &engine_paths.model, &paths::model_params(0)) {
        Ok(model) => model,
        Err((code, detail)) => {
            eprintln!("ST-4 MTP GATE SKIPPED (named blocker: {code:?}) — {detail}");
            return None;
        }
    };
    let draft = match load_draft_model(&backend, &engine_paths.mtp, 0) {
        Ok(draft) => draft,
        Err((code, detail)) => {
            eprintln!("ST-4 MTP GATE SKIPPED (named blocker: {code:?}) — {detail}");
            return None;
        }
    };
    Some((backend, model, draft))
}

fn text_turn(system: &str, user: &str, max_tokens: u32) -> ChatTurn {
    ChatTurn::text(vec![
        LlmMessage {
            role: "system".to_string(),
            content: system.to_string(),
        },
        LlmMessage {
            role: "user".to_string(),
            content: user.to_string(),
        },
    ])
    .with_max_tokens(max_tokens)
}

/// The live gates' sampling settings.
///
/// The reference defaults are pinned by `the_draft_context_shares_the_engines_
/// reference_window` and by [`SamplingSettings::default`]'s own test; here the
/// CONTEXT WINDOW is reduced so a live generation allocates ~1 GB of KV instead
/// of ~5 GB and the suite stays tractable. Nothing about the speculation
/// contract (draft count, sequence count, sampling chain, thread counts) is
/// changed — only the window, which bounds how long a prompt may be.
fn test_settings() -> SamplingSettings {
    SamplingSettings {
        ctx_size: 4096,
        ..SamplingSettings::default()
    }
}

// ── Static / pure pins ───────────────────────────────────────────────────────

/// R-19.2 pinned STATICALLY: the draft context is `Mtp`, carries
/// `n_rs_seq >= n_draft_max`, and the draft model is loaded with MTP weights.
#[test]
fn the_draft_context_is_mtp_with_rollback_room_and_mtp_weights_requested() {
    let settings = SamplingSettings::default();
    let params = draft_context_params(&settings);

    assert_eq!(
        params.ctx_type(),
        LlamaContextType::Mtp,
        "the draft context MUST be the MTP context type"
    );
    assert!(
        params.n_rs_seq() >= MTP_N_DRAFT_MAX as u32,
        "n_rs_seq ({}) must be >= n_draft_max ({MTP_N_DRAFT_MAX})",
        params.n_rs_seq()
    );
    assert_eq!(params.n_rs_seq(), MTP_N_RS_SEQ);
    assert_eq!(params.n_ctx(), NonZeroU32::new(settings.ctx_size));

    // The draft model's load parameters request the MTP weights. This is a
    // static read of the ONE parameter shape the loader uses.
    let loaded = LlamaModelParams::default()
        .with_n_gpu_layers(0)
        .with_load_mtp(true);
    assert!(loaded.load_mtp(), "the draft model must request MTP weights");
}

/// The session configuration is pinned: `n_draft_max` STAYS 2 (the non-goal)
/// and the upstream-aligned `n_min` / `p_min` defaults are explicit.
#[test]
fn the_session_configuration_pins_two_drafts_and_no_silent_tuning() {
    let config = session_config();
    assert_eq!(config.n_seq, 1);
    assert_eq!(config.n_draft_max, 2, "n_draft_max must never be tuned");
    assert_eq!(config.n_draft_max, MTP_N_DRAFT_MAX);
    assert_eq!(config.n_min, 0);
    assert_eq!(config.p_min, 0.0);
}

/// The determination is recorded in the constant; the LIVE proof is the pairing
/// test below.
#[test]
fn the_determined_pairing_is_shared_target_kv() {
    assert!(
        MTP_PAIRING_SHARED_TARGET_KV,
        "the live determination is that the pinned \
         MTP/mtp-gemma-4-E2B-it-Q4_0.gguf requires with_ctx_other(&target)"
    );
}

/// R-19.3 pinned STATICALLY: the draft weights resolve from the manifest's `mtp`
/// spec — never a literal path and never a settings override.
#[test]
fn the_draft_path_resolves_from_the_manifest_mtp_spec() {
    let manifest = default_manifest();
    let models_dir = std::path::Path::new("C:/fredo-models");
    let resolved = paths::EnginePaths::resolve(models_dir, &manifest);

    let mtp_spec = manifest
        .files
        .iter()
        .find(|spec| spec.id == "mtp")
        .expect("the manifest must declare an mtp spec");
    assert_eq!(
        resolved.mtp,
        file_path(models_dir, &manifest, mtp_spec),
        "the draft path must be the manifest join, not a literal"
    );
    assert!(resolved.mtp.ends_with("MTP/mtp-gemma-4-E2B-it-Q4_0.gguf"));
    // The pinned byte size, so a substituted file is caught here too.
    assert_eq!(mtp_spec.expected_bytes, 59_235_648);
}

/// The counters accumulate exactly, and each gate half is independent.
#[test]
fn stats_accumulate_and_report_each_gate_half() {
    let mut stats = MtpStats::default();
    assert!(!stats.proposed_anything());
    assert!(!stats.accepted_anything());

    stats.record(2, 1);
    stats.record(2, 0);
    assert_eq!(stats.draft_calls, 2);
    assert_eq!(stats.drafts_proposed, 4);
    assert_eq!(stats.drafts_accepted, 1);
    assert!(stats.proposed_anything());
    assert!(stats.accepted_anything());

    let mut total = MtpStats::default();
    total.accumulate(stats);
    total.accumulate(MtpStats {
        drafts_proposed: 0,
        drafts_accepted: 0,
        draft_calls: 1,
    });
    assert_eq!(total.drafts_proposed, 4);
    assert_eq!(total.drafts_accepted, 1);
    assert_eq!(total.draft_calls, 3);
}

/// The counters cross the status surface as camelCase keys (NFR-9 shape).
#[test]
fn stats_serialize_with_the_published_camel_case_names() {
    let stats = MtpStats {
        drafts_proposed: 6,
        drafts_accepted: 3,
        draft_calls: 4,
    };
    let value = serde_json::to_value(stats).expect("serialize stats");
    assert_eq!(value["draftsProposed"], 6);
    assert_eq!(value["draftsAccepted"], 3);
    assert_eq!(value["draftCalls"], 4);
}

/// The MTP failure helper always produces the subsystem's typed code and a
/// curated primary copy — never a bare library string as the whole message.
#[test]
fn a_failure_is_typed_and_carries_a_curated_primary_copy() {
    let (code, detail) = mtp_failure_for_test("open a speculative session", "native null pointer");
    assert_eq!(code, CompanionEngineErrorCode::MtpInitFailed);
    assert_eq!(
        code.detail(),
        CompanionEngineErrorCode::MtpInitFailed.detail()
    );
    assert!(
        detail.starts_with("the speculative draft model could not open a speculative session:"),
        "detail: {detail}"
    );
    assert!(
        detail.contains("Re-download the model files"),
        "detail: {detail}"
    );
    // The curated copy leads; the library text is only the tail.
    assert!(
        !detail.starts_with("native"),
        "the primary copy must be curated, not the library string: {detail}"
    );
}

/// The draft context parameters are a pure function of the engine's reference
/// settings — the same window and thread counts as the target.
#[test]
fn the_draft_context_shares_the_engines_reference_window() {
    let settings = SamplingSettings::default();
    let draft = draft_context_params(&settings);
    let target = crate::applications::llm_server::engine::thread::context_params(&settings);
    assert_eq!(draft.n_ctx(), target.n_ctx());
    assert_eq!(draft.n_threads(), target.n_threads());
    assert_eq!(draft.n_threads_batch(), target.n_threads_batch());
    // ...and differs only where MTP requires it.
    assert_eq!(draft.ctx_type(), LlamaContextType::Mtp);
    assert!(draft.n_rs_seq() > target.n_rs_seq());
    assert_eq!(LlamaContextParams::default().n_rs_seq(), target.n_rs_seq());
}

// ── LIVE: the pairing determination (THE first step) ─────────────────────────

/// WHICH pairing the pinned GGUF requires — determined live, pinned here.
///
/// The pinned drafter is `gemma4-assistant`, whose context constructor refuses
/// to run without `ctx_other`. So on the real files:
///
/// * the PLAIN separate-weights draft context (no pairing) FAILS;
/// * the PAIRED draft context succeeds, and reports `ctx_other`;
/// * two independent drafts paired to the SAME target report the SAME non-null
///   `ctx_other` pointer — which is exactly how upstream derives
///   `is_mem_shared`, so the pairing really points at the target;
/// * a session builds over the pair (the R-19.5 happy path).
#[test]
fn the_pinned_draft_gguf_requires_the_shared_target_kv_pairing() {
    let Some((backend, model, draft_model)) = load_models_or_skip() else {
        return;
    };
    let settings = SamplingSettings::default();

    let mut target = create_target_context(&backend, &model, &settings)
        .expect("the target context must be creatable");

    // 1. The plain separate-weights path: no `ctx_other`.
    let plain = draft_model.new_context(&backend, draft_context_params(&settings));
    let plain_error = plain.err().map(|error| error.to_string());
    assert!(
        plain_error.is_some(),
        "the pinned gemma4-assistant draft GGUF MUST refuse an unpaired context — \
         if this ever succeeds the determination has changed"
    );
    eprintln!(
        "ST-4 PAIRING DETERMINATION: unpaired (separate-weights) draft context REJECTED: {:?}",
        plain_error
    );

    // 2. The paired path succeeds, twice, against the same target.
    let first = create_draft_context(&backend, &draft_model, &target, &settings)
        .expect("the paired draft context must be creatable");
    let second = create_draft_context(&backend, &draft_model, &target, &settings)
        .expect("the paired draft context must be creatable");

    let first_other = first
        .ctx_other()
        .expect("a paired context reports a non-null ctx_other");
    let second_other = second
        .ctx_other()
        .expect("a paired context reports a non-null ctx_other");
    assert_eq!(
        first_other, second_other,
        "two drafts paired to the SAME target must carry the same ctx_other pointer"
    );
    assert!(
        target.ctx_other().is_none(),
        "the target is the SOURCE of the pairing, so it must report no pairing itself — \
         otherwise the pointer above could be the target's own, not ours"
    );
    eprintln!(
        "ST-4 PAIRING DETERMINATION: paired draft context ACCEPTED, ctx_other={:?}",
        first_other
    );

    // 3. A session over the pair — the R-19.5 happy path.
    let mut first = first;
    let session = open_session(&mut target, &mut first)
        .expect("the paired contexts must yield a session");
    assert_eq!(session.n_draft_max(), 2);

    // R-19.2 at RUNTIME: we CONFIGURE `n_rs_seq = 4` (pinned statically above),
    // but llama.cpp may clamp it. `llama-context.cpp` does exactly this:
    //   if (n_rs_seq > 0 && !llm_arch_supports_rs_rollback(model.arch)) n_rs_seq = 0;
    // Recurrent snapshots exist for RIGHT-TO-ROLLBACK of recurrent state; a pure
    // attention arch rolls back natively through `seq_rm`, so the snapshot count
    // is 0 by design. Both the gemma4 target and the gemma4-assistant drafter are
    // non-recurrent, so 0 is the expected effective value here — and the
    // FORCED-REJECTION test below proves partial rollback still WORKS on this
    // arch, which is the property R-19.4 actually needs.
    let configured = draft_context_params(&settings).n_rs_seq();
    let effective = session.draft_context().n_rs_seq();
    let recurrent = draft_model.is_recurrent() || draft_model.is_hybrid();
    assert_eq!(configured, MTP_N_RS_SEQ, "we must REQUEST 4 snapshots");
    assert!(
        effective == configured || effective == 0,
        "llama.cpp either honours n_rs_seq ({configured}) or clamps it to 0 for a \
         non-recurrent arch; got {effective}"
    );
    assert_eq!(
        effective == 0,
        !recurrent,
        "the clamp must follow the arch rule: effective={effective}, \
         recurrent_or_hybrid={recurrent}"
    );
    eprintln!(
        "ST-4 n_rs_seq: configured={configured} effective={effective} \
         recurrent_or_hybrid={recurrent} (llama.cpp clamps for attention archs)"
    );

    assert!(
        session.need_embd_pre_norm(),
        "the MTP implementation reports pre-norm embeddings"
    );
}

// ── LIVE: R-19.1 counters ────────────────────────────────────────────────────

/// R-19.1 REQUIRED ARTIFACT: a real generation reports non-zero drafts PROPOSED
/// AND non-zero drafts ACCEPTED, with counters read from Fredo's own loop.
///
/// A short reply that proposes nothing is explicitly NOT a pass, so the
/// assertion is on the counters, and a zero-proposal run repeats with a longer
/// prompt instead of concluding "no drafts this turn".
#[test]
fn a_live_turn_proposes_and_accepts_draft_tokens() {
    let Some((backend, model, draft_model)) = load_models_or_skip() else {
        return;
    };
    let format = ChatFormat::from_model(&model).expect("the pinned model publishes a template");
    let settings = test_settings();

    let attempts: [(&str, u32); 3] = [
        (
            "Write three full sentences about the ocean, then two more about the sky.",
            128,
        ),
        (
            "Explain what a mountain is in four sentences. Then describe a river in three more \
             sentences, and finish with two sentences about a forest.",
            192,
        ),
        (
            "Write a long paragraph of at least eight sentences describing a journey across a \
             continent: the weather, the roads, the towns, the people you meet, the food, and \
             how the journey ends.",
            320,
        ),
    ];

    let mut observed = None;
    let mut last_stats = MtpStats::default();
    let mut last_tokens = 0u32;
    for (attempt, (user, budget)) in attempts.iter().enumerate() {
        let turn = text_turn("You are a helpful assistant.", user, *budget);
        let outcome = generate_speculative(
            SpeculativeTurn {
                backend: &backend,
                model: &model,
                draft_model: &draft_model,
                format: &format,
                settings: &settings,
                turn: &turn,
                seed: crate::applications::llm_server::engine::sampling::DEFAULT_SEED,
                policy: VerifyPolicy::LongestMatchingPrefix,
            },
            |_piece| {},
        )
        .expect("the speculative turn must run");

        eprintln!(
            "ST-4 LIVE MTP attempt {}: proposed={} accepted={} draft_calls={} tokens={} eog={}",
            attempt + 1,
            outcome.stats.drafts_proposed,
            outcome.stats.drafts_accepted,
            outcome.stats.draft_calls,
            outcome.tokens_generated,
            outcome.stopped_on_eog
        );

        assert!(
            !outcome.content.trim().is_empty(),
            "the turn must produce text (attempt {})",
            attempt + 1
        );
        last_stats = outcome.stats;
        last_tokens = outcome.tokens_generated;

        if outcome.stats.proposed_anything() && outcome.stats.accepted_anything() {
            observed = Some(outcome.stats);
            break;
        }
    }

    let stats = observed.unwrap_or_else(|| {
        panic!(
            "a live turn MUST propose AND accept at least one draft token — a zero-proposal run \
             is a failure, never 'no drafts this turn'. Last observed counters: {last_stats:?} \
             after {last_tokens} generated tokens"
        )
    });
    assert!(stats.drafts_proposed > 0, "proposed: {stats:?}");
    assert!(stats.drafts_accepted > 0, "accepted: {stats:?}");
    assert!(stats.draft_calls > 0, "draft calls: {stats:?}");
    assert!(
        stats.drafts_accepted <= stats.drafts_proposed,
        "an acceptance can never exceed a proposal: {stats:?}"
    );
}

// ── LIVE: R-19.4 forced rejection + rollback ────────────────────────────────

/// R-19.4 REQUIRED ARTIFACT: every draft at every position rejected ⇒ both
/// contexts roll back to the last accepted position and generation continues to
/// a normal completion.
///
/// The induction is [`VerifyPolicy::RejectAllDrafts`], so `drafts_accepted` must
/// be exactly zero. The load-bearing assertion is that the turn runs MORE THAN
/// ONE draft step: after a verify decode the target KV holds every draft
/// position, and llama.cpp refuses a batch whose first position is not
/// `kv_max + 1`. Without the rollback the SECOND step fails with a typed error,
/// so "generation continued past step 1" IS the rollback proof.
#[test]
fn a_fully_rejected_step_rolls_both_contexts_back_and_generation_continues() {
    let Some((backend, model, draft_model)) = load_models_or_skip() else {
        return;
    };
    let format = ChatFormat::from_model(&model).expect("the pinned model publishes a template");
    let settings = test_settings();
    let budget = 48u32;
    let turn = text_turn(
        "You are a helpful assistant.",
        "Count from one to twenty in words, one word per line.",
        budget,
    );

    let outcome = generate_speculative(
        SpeculativeTurn {
            backend: &backend,
            model: &model,
            draft_model: &draft_model,
            format: &format,
            settings: &settings,
            turn: &turn,
            seed: crate::applications::llm_server::engine::sampling::DEFAULT_SEED,
            policy: VerifyPolicy::RejectAllDrafts,
        },
        |_piece| {},
    )
    .expect("a fully rejected draft step must not abort the turn");

    eprintln!(
        "ST-4 FORCED REJECTION: proposed={} accepted={} draft_calls={} tokens={} eog={}",
        outcome.stats.drafts_proposed,
        outcome.stats.drafts_accepted,
        outcome.stats.draft_calls,
        outcome.tokens_generated,
        outcome.stopped_on_eog
    );

    assert!(
        outcome.stats.drafts_proposed > 0,
        "the forced-rejection leg must still PROPOSE drafts: {:?}",
        outcome.stats
    );
    assert_eq!(
        outcome.stats.drafts_accepted, 0,
        "no draft may survive the forced rejection"
    );
    assert!(
        outcome.stats.draft_calls > 1,
        "generation must continue past the first step — a single step means the rollback was \
         never exercised: {:?}",
        outcome.stats
    );
    assert!(
        outcome.tokens_generated > 1,
        "the turn must keep producing tokens after a fully rejected step"
    );
    assert!(
        !outcome.content.trim().is_empty(),
        "the reply must not be empty"
    );
    assert!(
        outcome.stopped_on_eog || outcome.tokens_generated == budget,
        "the turn must complete normally (end-of-generation or the budget): tokens={}, eog={}",
        outcome.tokens_generated,
        outcome.stopped_on_eog
    );
}

// ── LIVE: R-19.5 typed failure ──────────────────────────────────────────────

/// R-19.5 REQUIRED ARTIFACT: a session-construction failure surfaces the TYPED
/// code, never a silent non-speculative continue and never a bare library string
/// as the primary copy.
///
/// The induction is a real one, not a mock: the pinned TARGET model's
/// architecture is `gemma4` (no `nextn_predict_layers`), so asking llama.cpp for
/// an `Mtp` context over it is refused at construction
/// (`llama-context.cpp`, "context type MTP requested but model doesn't contain
/// MTP layers"). That is exactly the shape of a session that cannot be built.
#[test]
fn a_session_that_cannot_be_built_fails_with_the_typed_mtp_code() {
    let Some((backend, model, _draft_model)) = load_models_or_skip() else {
        return;
    };
    let settings = SamplingSettings::default();

    // A TARGET context from the main model (proving the model is loaded and
    // healthy), then an Mtp context over that same model: the pinned target has
    // no MTP heads, so the second is refused.
    let target = create_target_context(&backend, &model, &settings)
        .expect("the target context must be creatable");
    assert!(
        target.n_ctx() > 0,
        "the target context must be a real allocation"
    );
    let refusal = model.new_context(&backend, draft_context_params(&settings));
    assert!(
        refusal.is_err(),
        "the pinned target model has no MTP heads, so an Mtp context over it must be refused"
    );

    // The defect can never be a silent non-speculative continue: the refusal has
    // no successful branch in `generate_speculative` — it propagates as the
    // typed MtpInitFailed from `create_draft_context` / `open_session`.
    let error = refusal.err().map(|error| error.to_string());
    eprintln!(
        "ST-4 TYPED FAILURE: Mtp context over the non-MTP target refused: {:?}",
        error
    );

    // The typed mapping itself: a draft-context construction failure maps to
    // `MtpInitFailed` with a curated primary copy.
    let (code, detail) = mtp_failure_for_test(
        "create its draft context",
        error.as_deref().unwrap_or("unknown"),
    );
    assert_eq!(
        code,
        CompanionEngineErrorCode::MtpInitFailed,
        "the failure MUST be the subsystem's typed code"
    );
    assert_eq!(
        code.detail(),
        CompanionEngineErrorCode::MtpInitFailed.detail(),
        "the curated detail is the code's own, never a raw library string"
    );
    assert!(
        detail.starts_with("the speculative draft model could not create its draft context:"),
        "detail: {detail}"
    );
    // And there is no non-speculative fallback to reach: the generator's only
    // session path is `create_target_context` → `create_draft_context` →
    // `open_session`, each `?`-propagating the typed failure.
    let source = include_str!("mtp.rs");
    assert!(
        !source.contains("non_speculative") && !source.contains("fallback_generate"),
        "mtp.rs must not contain a non-speculative fallback path"
    );
    let generator_start = source
        .find("pub fn generate_speculative")
        .expect("the generator must exist");
    let generator = &source[generator_start..];
    let create = generator
        .find("create_draft_context(backend, draft_model, &target, settings)?")
        .expect("the generator must create the draft context with `?`");
    let session = generator
        .find("open_session(&mut target, &mut draft)?")
        .expect("the generator must open the session with `?`");
    assert!(
        create < session,
        "the draft context must be created before the session"
    );
    assert!(
        !generator[create..session].contains(".ok()"),
        "a construction failure must never be swallowed with `.ok()`"
    );
}

/// A model that is present but is not the pinned drafter surfaces the typed code
/// — the missing-file classification path (R-19.5's neighbour: an absent draft
/// file never degrades to a text-only turn).
#[test]
fn a_missing_draft_file_is_the_typed_mtp_code() {
    let dir = tempfile::tempdir().expect("tempdir");
    let manifest = default_manifest();
    let error = paths::resolve_for_app(dir.path(), &manifest)
        .expect_err("an empty models dir must refuse every manifest file");
    // The main model is first in the manifest, so the classification is the
    // main-model code; the draft's own classification is pinned by name below.
    assert_eq!(error.0, CompanionEngineErrorCode::ModelMissing);
    assert_eq!(
        CompanionEngineErrorCode::for_missing_file("mtp"),
        CompanionEngineErrorCode::MtpInitFailed,
        "a missing draft file is the MTP subsystem's typed code"
    );
}

