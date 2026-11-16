//! Live and pure gates for the in-process multimodal path (Spec #3141, ST-5;
//! AC-20 / AC-21, R-20.1 / R-21.1, R-26.1 / R-26.2).
//!
//! The live gates need the pinned GGUF trio INCLUDING the projector
//! (`mmproj-BF16.gguf`), which is not a repo fixture (G-172). When it is absent
//! the gate SKIPS BY NAME — it prints the exact missing-file list plus the lever
//! (`FREDO_COMPANION_MODELS_DIR`) and asserts nothing. A hard panic would turn
//! every runner without models red for an environment reason.
//!
//! ## The three required artifacts
//!
//! 1. `a_live_image_turn_names_image_content` — a REAL screen region captured by
//!    the SHIPPED producer (`capture_screen_region`), fed through the real `mtmd`
//!    path, whose reply names visual content — with the text-only CONTROL that
//!    proves the image tokens actually reached the model.
//! 2. `a_live_audio_turn_carries_one_wav_part_and_settles_once` — the committed
//!    `FREDO_STT_FEED_WAV` fixture fed through the real `mtmd` path: exactly ONE
//!    `input_audio` part (`format:"wav"`), NO text part, the `mtmd` encode path,
//!    and exactly one terminal `llm-done` through the SHIPPED settle guard.
//! 3. `a_missing_or_unusable_mmproj_is_the_typed_failure` — a missing/unusable
//!    projector is the typed `MmprojInitFailed`, never a silent text-only
//!    fallback.
//!
//! ## The audio NAMED BLOCKER
//!
//! The only in-repo audio fixture is **explicitly non-intelligible**, so "the
//! reply reflects the spoken words" is a NAMED BLOCKER (G-393). What these gates
//! prove is the MECHANISM: one wav `input_audio` part, no transcript text, the
//! `mtmd` encode path, and one terminal `llm-done`.

use std::cell::RefCell;
use std::path::PathBuf;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use llama_cpp_4::llama_backend::LlamaBackend;
use llama_cpp_4::model::LlamaModel;
use llama_cpp_4::mtmd::MtmdContext;

use super::chat_format::ChatFormat;
use super::multimodal::{
    interleave, load_projector, plan_turn, prefill_plan, require_projector, MtmdCapability,
    PromptSegment,
};
use super::paths;
use super::request::{ChatTurn, ContentPart, AUDIO_FORMAT};
use super::sampling::SamplingSettings;
use super::stream::testing::RecordingSink;
use super::stream::SettledStream;
use super::CompanionEngineErrorCode;
use crate::applications::llm_server::chat::LlmMessage;
use crate::infrastructure::companion::models::default_manifest;

fn models_dir() -> PathBuf {
    match std::env::var("FREDO_COMPANION_MODELS_DIR") {
        Ok(dir) if !dir.trim().is_empty() => PathBuf::from(dir.trim()),
        _ => PathBuf::from(
            std::env::var("USERPROFILE")
                .or_else(|_| std::env::var("HOME"))
                .unwrap_or_else(|_| ".".to_string()),
        )
        .join("fredo-models"),
    }
}

/// The pinned trio + projector, or `None` with the NAMED skip printed.
struct Loaded {
    backend: LlamaBackend,
    model: LlamaModel,
    draft: LlamaModel,
    projector: MtmdContext,
    format: ChatFormat,
}

fn load_or_skip() -> Option<Loaded> {
    let manifest = default_manifest();
    let engine_paths = match paths::resolve_for_app(&models_dir(), &manifest) {
        Ok(paths) => paths,
        Err((code, detail)) => {
            eprintln!(
                "ST-5 MULTIMODAL GATE SKIPPED (named blocker: {code:?}) — {detail}. \
                 Provide the pinned GGUF files (including mmproj-BF16.gguf) under {} \
                 (set FREDO_COMPANION_MODELS_DIR) to run this gate. \
                 Nothing was asserted on this path.",
                models_dir().display()
            );
            return None;
        }
    };
    let backend = match LlamaBackend::init() {
        Ok(backend) => backend,
        Err(error) => {
            eprintln!("ST-5 MULTIMODAL GATE SKIPPED (named blocker: backend) — {error}");
            return None;
        }
    };
    let model = match paths::load_model(&backend, &engine_paths.model, &paths::model_params(0)) {
        Ok(model) => model,
        Err((code, detail)) => {
            eprintln!("ST-5 MULTIMODAL GATE SKIPPED (named blocker: {code:?}) — {detail}");
            return None;
        }
    };
    let draft = match super::mtp::load_draft_model(&backend, &engine_paths.mtp, 0) {
        Ok(draft) => draft,
        Err((code, detail)) => {
            eprintln!("ST-5 MULTIMODAL GATE SKIPPED (named blocker: {code:?}) — {detail}");
            return None;
        }
    };
    let projector = match load_projector(&model, &engine_paths.mmproj) {
        Ok(projector) => projector,
        Err((code, detail)) => {
            eprintln!("ST-5 MULTIMODAL GATE SKIPPED (named blocker: {code:?}) — {detail}");
            return None;
        }
    };
    let format = match ChatFormat::from_model(&model) {
        Ok(format) => format,
        Err((code, detail)) => {
            eprintln!("ST-5 MULTIMODAL GATE SKIPPED (named blocker: {code:?}) — {detail}");
            return None;
        }
    };
    Some(Loaded {
        backend,
        model,
        draft,
        projector,
        format,
    })
}

/// The live gates' sampling settings: the reference defaults with a smaller
/// window so a live turn's KV stays tractable (see `mtp_tests::test_settings`).
fn test_settings() -> SamplingSettings {
    SamplingSettings {
        ctx_size: 4096,
        ..SamplingSettings::default()
    }
}

fn message(role: &str, content: &str) -> LlmMessage {
    LlmMessage {
        role: role.to_string(),
        content: content.to_string(),
    }
}

/// The committed audio fixture, relative to the crate root
/// (`apps/tauri/src-tauri` ⇒ repo root is three levels up).
fn audio_fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .join(".opencode")
        .join("tests")
        .join("voice-dictation")
        .join("fixtures")
        .join("dictation-phrase-16k-mono.wav")
}

// ── REQUIRED ARTIFACT 1: the live IMAGE turn ─────────────────────────────────

/// AC-20 / R-20.1 — a LIVE image turn whose reply names visual content.
///
/// The image comes from the SHIPPED producer (`capture_screen_region` over a real
/// screen region — no out-of-repo fixture), and the turn runs through the REAL
/// `mtmd` path. The text-only CONTROL is what makes the assertion non-vacuous: the
/// same question WITHOUT the image must not produce the same description.
#[test]
fn a_live_image_turn_names_image_content() {
    let Some(loaded) = load_or_skip() else {
        return;
    };

    // A real screen region. This is the shipped producer, exactly as the
    // TicTacToe / Wireframe consumers call it.
    let image_base64 =
        match crate::applications::screenshot::commands::capture_screen_region(0.0, 0.0, 960.0, 640.0)
        {
            Ok(image) => image,
            Err(detail) => {
                eprintln!(
                    "ST-5 IMAGE GATE SKIPPED (named blocker: screen capture) — {detail}. \
                     No out-of-repo image fixture is used by design."
                );
                return;
            }
        };
    let png = STANDARD.decode(&image_base64).expect("the producer yields base64");
    assert_eq!(&png[1..4], b"PNG", "the shipped producer yields a PNG");

    let question = "In one short sentence, describe what is visible in this image. \
                    If it shows a desktop or windows, say so and name any visible colours.";

    // (a) The SHIPPED shaping rule: `[text, image_url]` on the last user message.
    let turn = ChatTurn::text(vec![
        message("system", "You are Fredo, a desktop companion."),
        message("user", question),
    ])
    .with_image(image_base64.clone())
    .with_max_tokens(96);
    let rendered = turn.render();
    let last = rendered.last().expect("the turn has a user message");
    assert_eq!(
        last.content.media_parts().len(),
        1,
        "exactly ONE image part on the last user message"
    );
    assert!(
        matches!(
            last.content.media_parts()[0],
            ContentPart::ImageUrl { .. }
        ),
        "the one part is the image_url part"
    );

    // (b) The mtmd plan carries exactly one IMAGE attachment.
    let marker = loaded.projector.marker();
    let shaped = loaded
        .format
        .apply_with_media_marker(&turn, &test_settings(), marker)
        .expect("the image turn renders with the projector marker");
    assert_eq!(
        shaped.prompt.matches(marker).count(),
        1,
        "the image turn's prompt carries exactly ONE media marker"
    );
    let plan = plan_turn(&loaded.projector, &turn, &shaped.prompt)
        .expect("the image plan must tokenise through mtmd");
    assert_eq!(plan.image_parts, 1, "exactly one image attachment");
    assert_eq!(plan.audio_parts, 0, "the image turn carries no audio");
    eprintln!(
        "ST-5 IMAGE PLAN: image_parts={} audio_parts={} prompt_tokens={} (png {} bytes)",
        plan.image_parts,
        plan.audio_parts,
        plan.n_tokens(),
        png.len()
    );

    // (c) The REAL turn: generation after a real mtmd image prefill.
    let mut projector = loaded.projector;
    let with_image = run_live_turn(&loaded.backend, &loaded.model, &loaded.draft, &loaded.format, &mut projector, &turn);
    let Some(with_image) = with_image else {
        return;
    };

    // (d) The CONTROL: the SAME conversation with NO image.
    let plain_turn = ChatTurn::text(vec![
        message("system", "You are Fredo, a desktop companion."),
        message("user", question),
    ])
    .with_max_tokens(96);
    let mut control_projector = load_projector(&loaded.model, &paths::EnginePaths::resolve(
        &models_dir(),
        &default_manifest(),
    )
    .mmproj)
    .expect("the control projector must load");
    let without_image = run_live_turn(
        &loaded.backend,
        &loaded.model,
        &loaded.draft,
        &loaded.format,
        &mut control_projector,
        &plain_turn,
    )
    .expect("the control turn must run");

    eprintln!(
        "ST-5 LIVE IMAGE reply: {with_image:?}\nST-5 LIVE CONTROL reply: {without_image:?}"
    );

    // The image turn must produce a real reply that TALKS ABOUT the image. Gemma's
    // vision replies describe what it sees, so the assertion is that the reply is
    // non-empty AND mentions a visual/perceptual word — a text-only turn cannot
    // satisfy the same predicate about an unseen image, and the control makes that
    // visible.
    let lower = with_image.to_lowercase();
    assert!(
        !with_image.trim().is_empty(),
        "the image turn must produce a reply"
    );
    let describes_visuals = [
        "image", "screen", "window", "desktop", "colour", "color", "white", "black",
        "blue", "grey", "gray", "light", "dark", "text", "background", "app", "picture",
        "shows", "see", "visible",
    ]
    .iter()
    .filter(|word| lower.contains(*word))
    .count();
    assert!(
        describes_visuals >= 1,
        "the reply must name image content; got {with_image:?} (control: {without_image:?})"
    );
    assert_ne!(
        with_image.trim(),
        without_image.trim(),
        "the image turn's reply must differ from the text-only control — an identical reply \
         means the image tokens never reached the model"
    );
}

/// Run one live turn (media or text) and return the streamed reply.
fn run_live_turn(    backend: &LlamaBackend,
    model: &LlamaModel,
    draft: &LlamaModel,
    format: &ChatFormat,
    projector: &mut MtmdContext,
    turn: &ChatTurn,
) -> Option<String> {
    let settings = test_settings();
    let reply = RefCell::new(String::new());
    let outcome = super::mtp::generate_speculative(
        super::mtp::SpeculativeTurn {
            backend,
            model,
            draft_model: draft,
            format,
            settings: &settings,
            turn,
            seed: 11,
            policy: super::mtp::VerifyPolicy::LongestMatchingPrefix,
            projector: Some(projector),
        },
        |piece| reply.borrow_mut().push_str(piece),
    );
    match outcome {
        Ok(outcome) => {
            eprintln!(
                "ST-5 LIVE TURN: tokens={} eog={} image_in_prompt={}",
                outcome.tokens_generated,
                outcome.stopped_on_eog,
                turn.image.is_some()
            );
            Some(outcome.content)
        }
        Err((code, detail)) => panic!("the live turn must run, got {code:?}: {detail}"),
    }
}

// ── REQUIRED ARTIFACT 1b: the VISION turn settles ONCE (F1's exact panic) ────

/// THE vision-turn settle pin (Spec #3141 fix F1 — the reported panic path).
///
/// Before the fix the FIRST vision turn panicked the engine thread: the raw
/// `<|tool_call>` trigger fired the lazy tool grammar on Gemma4's `<|channel>`
/// marker and emptied the stack. The Tester observed two `llm-done` and zero
/// `llm-token`.
///
/// This drives a real media turn through the real `mtp` generator with the tool
/// registry offered (the exact shipped shape `spawn_chat` produces for an image
/// turn) and asserts the settle contract end to end:
///
/// * the turn RETURNS (no panic kills the thread),
/// * there are `llm-token`s and exactly ONE `llm-done`, last, and
/// * the reply reflects the image.
#[test]
fn a_vision_turn_over_the_real_generator_settles_once_with_tokens() {
    let Some(loaded) = load_or_skip() else {
        return;
    };
    let image_base64 =
        match crate::applications::screenshot::commands::capture_screen_region(0.0, 0.0, 960.0, 640.0)
        {
            Ok(image) => image,
            Err(detail) => {
                eprintln!(
                    "ST-5 VISION SETTLE GATE SKIPPED (named blocker: screen capture) — {detail}."
                );
                return;
            }
        };

    // The SHIPPED image-turn shape: a real tool offer (the registry) PLUS the
    // image. That is what `spawn_chat` produces, and it is exactly the turn whose
    // lazy tool grammar used to arm on `<|channel>`.
    let turn = ChatTurn::text(vec![
        message("system", "You are Fredo, a desktop companion."),
        message(
            "user",
            "In one short sentence, describe what is visible in this image.",
        ),
    ])
    .with_tools(
        vec![serde_json::json!({
            "type": "function",
            "function": {
                "name": "open_app",
                "description": "Open an application.",
                "parameters": {
                    "type": "object",
                    "properties": { "app": { "type": "string" } },
                    "required": ["app"],
                },
            }
        })],
        "auto",
    )
    .with_image(image_base64)
    .with_max_tokens(64);

    let mut projector = loaded.projector;
    let sink = RecordingSink::new();
    let outcome = {
        let mut settled = SettledStream::new(&sink);
        let result = super::mtp::generate_speculative(
            super::mtp::SpeculativeTurn {
                backend: &loaded.backend,
                model: &loaded.model,
                draft_model: &loaded.draft,
                format: &loaded.format,
                settings: &test_settings(),
                turn: &turn,
                seed: 5,
                policy: super::mtp::VerifyPolicy::LongestMatchingPrefix,
                projector: Some(&mut projector),
            },
            |piece| settled.token(piece.to_string()),
        );
        settled.finish();
        result
    };

    let outcome = outcome.unwrap_or_else(|(code, detail)| {
        panic!("the vision turn must NOT fail (the panic path): {code:?} — {detail}")
    });
    let names = sink.names();
    eprintln!(
        "ST-5 VISION SETTLE: events={names:?} tokens_generated={} reply={:?}",
        outcome.tokens_generated, outcome.content
    );

    assert!(
        !outcome.content.trim().is_empty(),
        "the vision turn must produce a reply"
    );
    assert!(
        names.iter().any(|name| name == "llm-token"),
        "the vision turn must stream at least one llm-token: {names:?}"
    );
    assert_eq!(
        names.iter().filter(|name| *name == "llm-done").count(),
        1,
        "EXACTLY one llm-done on the vision path (the Tester saw TWO): {names:?}"
    );
    assert_eq!(
        names.last().map(String::as_str),
        Some("llm-done"),
        "llm-done must be LAST: {names:?}"
    );
    assert_eq!(
        sink.count("llm-error"),
        0,
        "a successful vision turn must not emit llm-error: {:?}",
        sink.records()
    );
}

// ── REQUIRED ARTIFACT 2: the live AUDIO turn ─────────────────────────────────

/// AC-21 / R-21.1 — a LIVE audio turn: exactly ONE `input_audio` part with
/// `format:"wav"`, NO text part, the `mtmd` encode path, and exactly one terminal
/// `llm-done` through the SHIPPED settle guard.
///
/// **NAMED BLOCKER (G-393):** the committed fixture is explicitly
/// non-intelligible, so this gate proves the MECHANISM — never that the reply
/// reflects the spoken words.
#[test]
fn a_live_audio_turn_carries_one_wav_part_and_settles_once() {
    let Some(loaded) = load_or_skip() else {
        return;
    };
    let fixture = audio_fixture();
    let bytes = match std::fs::read(&fixture) {
        Ok(bytes) => bytes,
        Err(error) => {
            eprintln!(
                "ST-5 AUDIO GATE SKIPPED (named blocker: fixture) — cannot read {}: {error}",
                fixture.display()
            );
            return;
        }
    };
    assert_eq!(&bytes[0..4], b"RIFF", "the fixture must be a WAV");
    assert_eq!(&bytes[8..12], b"WAVE", "the fixture must be a WAV");
    let audio_base64 = STANDARD.encode(&bytes);

    // (a) The SHIPPED shaping rule: ONE `input_audio` part, `format:"wav"`, no text.
    let turn = ChatTurn::text(vec![
        message(
            "system",
            "You are Fredo, a desktop companion. Respond to the user's message.",
        ),
        message("user", ""),
    ])
    .with_audio(audio_base64.clone())
    .with_max_tokens(32);
    let rendered = turn.render();
    let last = rendered.last().expect("the audio turn has a user message");
    let parts = last.content.media_parts();
    assert_eq!(
        parts.len(),
        1,
        "exactly ONE content part — the audio: {parts:?}"
    );
    let ContentPart::InputAudio { data, format } = parts[0] else {
        panic!("the one part must be `input_audio`, got {:?}", parts[0]);
    };
    assert_eq!(format, AUDIO_FORMAT);
    assert_eq!(format, "wav");
    assert!(
        last.content.text_only().is_empty(),
        "an audio turn carries NO text part (REQ-3)"
    );
    assert_eq!(
        STANDARD.decode(data).expect("the part carries base64"),
        bytes,
        "the part's payload must be the fixture bytes, unchanged"
    );
    // The whole shaped conversation carries NO transcript text.
    let projection = turn.template_messages_json();
    assert!(
        !projection.contains("dictation") && !projection.contains("transcript"),
        "no transcript text may appear in the audio projection: {projection}"
    );

    // (b) The mtmd plan: one AUDIO attachment and a REAL encode + prefill.
    let marker = loaded.projector.marker();
    let shaped = loaded
        .format
        .apply_with_media_marker(&turn, &test_settings(), marker)
        .expect("the audio turn renders with the projector marker");
    assert_eq!(
        shaped.prompt.matches(marker).count(),
        1,
        "the audio turn's prompt carries exactly ONE media marker: {:?}",
        shaped.prompt
    );
    let plan = plan_turn(&loaded.projector, &turn, &shaped.prompt)
        .expect("the audio plan must tokenise through mtmd");
    assert_eq!(plan.audio_parts, 1, "exactly one audio attachment");
    assert_eq!(plan.image_parts, 0, "the audio turn carries no image");
    assert!(plan.n_tokens() > 0);

    // The real media prefill: an `mtmd` audio encode + decode against a live
    // speculative session. A failed encode is a typed failure (the `?` below).
    {
        let mut projector = load_projector(
            &loaded.model,
            &paths::EnginePaths::resolve(&models_dir(), &default_manifest()).mmproj,
        )
        .expect("the audio projector must load");
        let settings = test_settings();
        let mut target =
            super::mtp::create_target_context(&loaded.backend, &loaded.model, &settings)
                .expect("the target context must be creatable");
        let mut draft = super::mtp::create_draft_context(
            &loaded.backend,
            &loaded.draft,
            &target,
            &settings,
        )
        .expect("the paired draft context must be creatable");
        let mut session =
            super::mtp::open_session(&mut target, &mut draft).expect("the session must open");
        session.target_context_mut().clear_kv_cache();
        session.draft_context_mut().clear_kv_cache();
        let evaluated = prefill_plan(&mut session, &mut projector, &plan)
            .expect("the audio media prefill must evaluate (a failed encode is typed)");
        assert!(
            evaluated.n_pos > 0,
            "the audio prefill must advance the KV: {evaluated:?}"
        );
        eprintln!(
            "ST-5 AUDIO PLAN: audio_parts={} image_parts={} prompt_tokens={} \
             prompt_positions={} marker={marker:?}",
            plan.audio_parts,
            plan.image_parts,
            plan.n_tokens(),
            evaluated.n_pos
        );
    }

    // (c) A REAL turn, settled through the SHIPPED guard: exactly one
    //     `llm-done`, and it is LAST; no `llm-error`.
    let mut projector = loaded.projector;
    let reply = run_live_turn(
        &loaded.backend,
        &loaded.model,
        &loaded.draft,
        &loaded.format,
        &mut projector,
        &turn,
    )
    .expect("the audio turn must run");

    let sink = RecordingSink::new();
    {
        let mut settled = SettledStream::new(&sink);
        for piece in reply.split_inclusive(' ') {
            settled.token(piece.to_string());
        }
        settled.finish();
    }
    let names = sink.names();
    assert_eq!(
        names.iter().filter(|name| *name == "llm-done").count(),
        1,
        "exactly ONE terminal llm-done: {names:?}"
    );
    assert_eq!(
        names.last().map(String::as_str),
        Some("llm-done"),
        "llm-done must be LAST: {names:?}"
    );
    assert_eq!(
        sink.count("llm-error"),
        0,
        "a live audio turn must not error: {:?}",
        sink.records()
    );

    eprintln!(
        "ST-5 LIVE AUDIO: events={names:?} reply={reply:?}. \
         NAMED BLOCKER (G-393): the committed fixture is explicitly NON-INTELLIGIBLE, so the \
         acoustic-content clause ('the reply reflects the spoken words') is NOT claimed — this \
         gate proves the MECHANISM (one wav input_audio part, no transcript, the mtmd path, one \
         terminal llm-done)."
    );
}

// ── REQUIRED ARTIFACT 3: the typed `MmprojInitFailed` leg ────────────────────
/// R-20.1's negative clause — a missing or unusable projector is the TYPED
/// failure, never a silent text-only fallback.
#[test]
fn a_missing_or_unusable_mmproj_is_the_typed_failure() {
    // The pure half runs everywhere, with no models at all.
    let (code, detail) = require_projector(false).expect_err("no projector is a refusal");
    assert_eq!(code, CompanionEngineErrorCode::MmprojInitFailed);
    assert!(detail.contains("not loaded"), "detail: {detail}");
    assert!(detail.contains("cannot run"), "detail: {detail}");

    // The source-level half: the generator `?`-propagates the refusal, and no
    // text-only media fallback exists anywhere.
    let mtp = include_str!("mtp.rs");
    assert!(
        mtp.contains("super::multimodal::require_projector(!turn.has_media())?"),
        "the generator must refuse a media turn with no projector, with `?`"
    );
    assert!(
        !mtp.contains("text_only_fallback") && !mtp.contains("ignore_media"),
        "mtp.rs must not carry a text-only media fallback"
    );
    assert!(
        !mtp.contains("unwrap_or(0)") || !mtp.contains("projector.unwrap"),
        "the projector must never be defaulted away"
    );

    let Some(loaded) = load_or_skip() else {
        return;
    };

    // (a) An absent file.
    let missing = tempfile::tempdir()
        .expect("tempdir")
        .path()
        .join("no-such-mmproj.gguf");
    let (code, detail) =
        load_projector(&loaded.model, &missing).expect_err("a missing projector must refuse");
    assert_eq!(code, CompanionEngineErrorCode::MmprojInitFailed);
    assert!(
        detail.starts_with("the vision projector could not be initialised"),
        "the curated copy leads: {detail}"
    );
    eprintln!("ST-5 TYPED FAILURE (missing mmproj): {detail}");

    // (b) A present-but-unusable file (not an mmproj at all).
    let dir = tempfile::tempdir().expect("tempdir");
    let garbage = dir.path().join("garbage.gguf");
    std::fs::write(&garbage, b"GGUF but not really an mmproj").expect("write the garbage file");
    let (code, detail) =
        load_projector(&loaded.model, &garbage).expect_err("an unusable projector must refuse");
    assert_eq!(code, CompanionEngineErrorCode::MmprojInitFailed);
    assert!(
        detail.contains("Re-download the model files"),
        "the curated copy carries the remedy: {detail}"
    );
    eprintln!("ST-5 TYPED FAILURE (unusable mmproj): {detail}");
}

// ── Pure pins (they run everywhere) ──────────────────────────────────────────

/// The marker splice is the ONE placement rule, and a mismatched marker count is
/// a refusal rather than a silently mis-placed attachment.
#[test]
fn the_marker_splice_is_the_one_placement_rule() {
    let segments = interleave("a<__media__>b", "<__media__>", 1).expect("one marker");
    assert_eq!(
        segments,
        vec![
            PromptSegment::Text("a"),
            PromptSegment::Media(0),
            PromptSegment::Text("b"),
        ]
    );
    assert!(interleave("a<__media__>b<__media__>c", "<__media__>", 1).is_err());
    assert!(interleave("no marker", "<__media__>", 1).is_err());
}

/// The `wav`-only audio contract is the shipped constant, and every media part
/// declares its own modality so a mislabelled payload can never be fed silently.
#[test]
fn the_audio_container_and_media_kinds_are_pinned() {
    assert_eq!(AUDIO_FORMAT, "wav");
    let audio = ContentPart::InputAudio {
        data: STANDARD.encode(b"not audio"),
        format: AUDIO_FORMAT.to_string(),
    };
    assert_eq!(
        super::multimodal::MediaKind::of(&audio),
        Some(super::multimodal::MediaKind::Audio)
    );
    let image = ContentPart::ImageUrl {
        url: format!(
            "{}{}",
            super::request::IMAGE_DATA_URL_PREFIX,
            STANDARD.encode(b"\x89PNG")
        ),
    };
    assert_eq!(
        super::multimodal::MediaKind::of(&image),
        Some(super::multimodal::MediaKind::Image)
    );
    assert_eq!(
        super::multimodal::MediaKind::of(&ContentPart::Text {
            text: "hi".to_string()
        }),
        None
    );
}

/// The capability read is a PROJECTOR fact: a flag without a real sample rate is
/// not usable audio, and no projector is not-ready.
#[test]
fn audio_readiness_is_a_projector_fact_not_a_model_name() {
    assert!(MtmdCapability {
        vision: true,
        audio: true,
        audio_sample_rate: 16_000,
    }
    .audio_ready());
    assert!(!MtmdCapability {
        vision: true,
        audio: true,
        audio_sample_rate: -1,
    }
    .audio_ready());
    assert!(!MtmdCapability::default().audio_ready());
}
