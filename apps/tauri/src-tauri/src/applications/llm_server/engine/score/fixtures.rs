//! The committed fixture set (Spec #3232, ST-1; AC-1).
//!
//! Every fixture is a [`ScoreFixture`] whose `turn` is the product's OWN
//! [`ChatTurn`] and whose `expect` is a structural [`Expectation`]. Fixtures are
//! shaped by the SAME producers the product uses — `skills::skill_turn` for the
//! skill/vision/audio turns and `doom_agent::doom_turn` for the schema-constrained
//! Doom turn — so the harness can never drift from the shipped path.
//!
//! ## Coverage (AC-1)
//!
//! * `text-chat` — a plain text turn under the shipped structured-reply schema.
//! * `skill-open-app` — an expected skill call (`open_app` with its argument).
//! * `schema-doom-plan` — a schema-constrained Doom-plan reply.
//! * `vision-screen-text` — a vision turn whose committed image carries small
//!   on-screen text naming a shipped application.
//! * `audio-clip` — a model-audio turn (structural expectation only; the existing
//!   clip is recorded as non-intelligible, so the expectation is never "the reply
//!   reflects the spoken words").
//!
//! The set is capped at [`MAX_FIXTURES`](super::MAX_FIXTURES): this is a scoring
//! harness, never a benchmark suite.
//!
//! ## Committed media
//!
//! `fixtures/screen-small-text.png` (a NEW committed asset) and
//! `fixtures/audio-clip.wav` (a committed copy of the feed WAV) are embedded at
//! build time and base64-encoded through the product's own
//! [`ChatTurn::with_image`]/[`ChatTurn::with_audio`] builders.
//!
//! ## The absence guard (AC-1)
//!
//! The `absence_guard` module scans the harness source for OpenAI-shaped request
//! vocabulary — the AC's LITERAL predicate, scanned RAW (comments included) and
//! paired with a non-vacuity control — so "no parallel request model" is an
//! assertion, not a claim.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::json;

use crate::applications::llm_server::chat::LlmMessage;
use crate::applications::llm_server::doom_agent;
use crate::applications::llm_server::engine::request::ChatTurn;
use crate::applications::llm_server::skills;
use crate::applications::llm_server::status::{
    self, fredo_status_schema, FREDO_STATUS_SCHEMA_NAME,
};

use super::{Expectation, ScoreFixture};

/// The committed image carrying small on-screen text (a window named
/// `Mission Monitor`).
const SCREEN_SMALL_TEXT_PNG: &[u8] = include_bytes!("fixtures/screen-small-text.png");

/// The committed audio clip (a copy of the feed WAV).
const AUDIO_CLIP_WAV: &[u8] = include_bytes!("fixtures/audio-clip.wav");

/// The application name the committed image renders (the vision fixture's
/// expected `open_app` argument).
pub const SCREEN_TEXT_APP_NAME: &str = "Mission Monitor";

/// Fixture id: a plain text turn.
pub const TEXT_CHAT: &str = "text-chat";
/// Fixture id: an expected skill call.
pub const SKILL_OPEN_APP: &str = "skill-open-app";
/// Fixture id: a schema-constrained Doom-plan reply.
pub const SCHEMA_DOOM_PLAN: &str = "schema-doom-plan";
/// Fixture id: a vision turn with small on-screen text.
pub const VISION_SCREEN_TEXT: &str = "vision-screen-text";
/// Fixture id: a model-audio turn.
pub const AUDIO_CLIP: &str = "audio-clip";

/// The committed fixture ids, in report order.
pub const FIXTURE_IDS: [&str; 5] = [
    TEXT_CHAT,
    SKILL_OPEN_APP,
    SCHEMA_DOOM_PLAN,
    VISION_SCREEN_TEXT,
    AUDIO_CLIP,
];

/// A single conversation message (the product's IPC DTO).
fn message(role: &str, content: &str) -> LlmMessage {
    LlmMessage {
        role: role.to_string(),
        content: content.to_string(),
    }
}

/// The committed fixture set, in report order.
///
/// Rebuilt on each call (the media base64 is cheap); callers that need it once
/// should bind it to a local.
pub fn fixtures() -> Vec<ScoreFixture> {
    let registry = status::companion_skill_registry();
    vec![
        text_chat_fixture(),
        skill_open_app_fixture(&registry),
        schema_doom_plan_fixture(),
        vision_screen_text_fixture(&registry),
        audio_clip_fixture(),
    ]
}

/// `text-chat` — a plain text turn scored by the shipped structured-reply schema.
fn text_chat_fixture() -> ScoreFixture {
    let turn = ChatTurn::text(vec![
        message("system", "You are Fredo, a concise desktop assistant."),
        message("user", "In one short sentence, what colour is the sky?"),
    ])
    .with_json_schema(FREDO_STATUS_SCHEMA_NAME, fredo_status_schema());
    ScoreFixture {
        id: TEXT_CHAT,
        seed: 101,
        turn,
        expect: Expectation::Schema {
            name: FREDO_STATUS_SCHEMA_NAME,
            require: &["reply", "status"],
        },
    }
}

/// `skill-open-app` — the shipped three-skill registry offered, expecting a
/// validated `open_app` call.
fn skill_open_app_fixture(registry: &crate::infrastructure::companion::skills::SkillRegistry) -> ScoreFixture {
    let turn = skills::skill_turn(
        vec![
            message("system", "You are Fredo, a concise desktop assistant."),
            message("user", "Open the Mission Monitor application for me."),
        ],
        registry,
        None,
        None,
    );
    ScoreFixture {
        id: SKILL_OPEN_APP,
        seed: 202,
        turn,
        expect: Expectation::Call {
            name: "open_app",
            required_args: &[("app", "Mission Monitor")],
        },
    }
}

/// `schema-doom-plan` — the schema-constrained Doom decision turn.
///
/// The observation + action vocabulary are the fixture's own INPUT data (the
/// production composition root supplies the real vocabulary; this module may not
/// import the Doom application).
fn schema_doom_plan_fixture() -> ScoreFixture {
    let observation = json!({
        "health": 100,
        "position": { "x": 10, "y": 20 },
        "facing": 90,
        "exit": { "bearing": 90, "distance": 30 },
        "blockingThreats": 0,
        "doors": [],
    });
    let vocabulary = json!([
        { "op": "move", "bearing": "<0-359>", "distance": "<1-1024>" },
        { "op": "open-door", "bearing": "<0-359>" },
        { "op": "shoot", "tics": "<1-350>" },
        { "op": "wait", "tics": "<1-350>" },
    ]);
    let turn = doom_agent::doom_turn(&observation, &vocabulary);
    ScoreFixture {
        id: SCHEMA_DOOM_PLAN,
        seed: 303,
        turn,
        expect: Expectation::Schema {
            name: "doom_plan",
            require: &["steps"],
        },
    }
}

/// `vision-screen-text` — a vision turn whose committed image renders small
/// on-screen text naming [`SCREEN_TEXT_APP_NAME`].
fn vision_screen_text_fixture(
    registry: &crate::infrastructure::companion::skills::SkillRegistry,
) -> ScoreFixture {
    let image = STANDARD.encode(SCREEN_SMALL_TEXT_PNG);
    let turn = skills::skill_turn(
        vec![
            message("system", "You are Fredo, a concise desktop assistant."),
            message(
                "user",
                "Open the application named in the window shown in this screenshot.",
            ),
        ],
        registry,
        None,
        Some(&image),
    );
    ScoreFixture {
        id: VISION_SCREEN_TEXT,
        seed: 404,
        turn,
        expect: Expectation::Call {
            name: "open_app",
            required_args: &[("app", SCREEN_TEXT_APP_NAME)],
        },
    }
}

/// `audio-clip` — a model-audio turn under the structured-reply schema.
///
/// The clip is the committed feed WAV; the expectation is STRUCTURAL (the reply
/// object's required fields), never a claim about the spoken words.
fn audio_clip_fixture() -> ScoreFixture {
    let audio = STANDARD.encode(AUDIO_CLIP_WAV);
    let turn = ChatTurn::text(vec![message("user", "")])
        .with_audio(audio)
        .with_json_schema(FREDO_STATUS_SCHEMA_NAME, fredo_status_schema());
    ScoreFixture {
        id: AUDIO_CLIP,
        seed: 505,
        turn,
        expect: Expectation::Schema {
            name: FREDO_STATUS_SCHEMA_NAME,
            require: &["reply", "status"],
        },
    }
}

// ── The committed pins (AC-1 / NFR bounded) ───────────────────────────────────

#[cfg(test)]
mod pins {
    use super::*;
    use crate::applications::llm_server::engine::score::expect::{evaluate, ObservedCall, ObservedTurn};
    use crate::applications::llm_server::engine::score::MAX_FIXTURES;

    /// AC-1: every fixture is a `ChatTurn` and the required coverage set is
    /// present, exactly once each.
    #[test]
    fn every_fixture_is_a_chat_turn_and_the_coverage_set_is_present() {
        let set = fixtures();
        let ids: Vec<&str> = set.iter().map(|fixture| fixture.id).collect();
        assert_eq!(ids, FIXTURE_IDS, "the coverage set and its order are committed");

        // The `turn` field is a `ChatTurn` by TYPE; the media coverage is the
        // observable assertion that the right producer shaped each turn.
        let by_id = |id: &str| set.iter().find(|fixture| fixture.id == id).expect("fixture");
        assert!(
            !by_id(TEXT_CHAT).turn.has_media(),
            "text-chat must carry no media"
        );
        assert!(
            !by_id(SKILL_OPEN_APP).turn.has_media(),
            "skill-open-app is a tool turn, not a media turn"
        );
        assert!(
            !by_id(SCHEMA_DOOM_PLAN).turn.has_media(),
            "the Doom turn carries structured text only"
        );
        assert!(
            by_id(VISION_SCREEN_TEXT).turn.image.is_some(),
            "the vision turn must carry the committed PNG"
        );
        assert!(
            by_id(AUDIO_CLIP).turn.audio.is_some(),
            "the audio turn must carry the committed WAV"
        );

        // The tool/schema shaping is the product's own (non-vacuity).
        assert!(by_id(SKILL_OPEN_APP).turn.offer_tools);
        assert_eq!(
            by_id(SCHEMA_DOOM_PLAN).turn.json_schema.as_ref().map(|(name, _)| name.as_str()),
            Some("doom_plan")
        );
        assert_eq!(
            by_id(TEXT_CHAT).turn.json_schema.as_ref().map(|(name, _)| name.as_str()),
            Some(FREDO_STATUS_SCHEMA_NAME)
        );
    }

    /// The bounded NFR: a fixed committed list never exceeds the cap, so a 21st
    /// fixture (which would reclassify this as a benchmark suite) reddens here.
    #[test]
    fn the_fixture_cap_is_enforced_not_conventional() {
        let set = fixtures();
        assert!(
            set.len() <= MAX_FIXTURES,
            "the fixture set ({}) must stay within the {MAX_FIXTURES}-fixture cap",
            set.len()
        );
        // The cap is a real bound over a FIXED list: the committed ids equal the
        // returned ids, so the count cannot grow at runtime.
        assert_eq!(set.len(), FIXTURE_IDS.len());
        assert_eq!(MAX_FIXTURES, 20);
    }

    /// Every fixture id is unique (a duplicate id would alias two records in the
    /// baseline and the persisted span set).
    #[test]
    fn fixture_ids_are_unique() {
        let set = fixtures();
        let mut ids: Vec<&str> = set.iter().map(|fixture| fixture.id).collect();
        ids.sort_unstable();
        let mut deduped = ids.clone();
        deduped.dedup();
        assert_eq!(ids, deduped, "duplicate fixture id in the committed set");
    }

    /// The committed media really decode as the images the turns carry.
    #[test]
    fn the_committed_media_are_embedded_and_base64_encoded() {
        // A PNG signature and a WAV/RIFF header prove the embedded bytes are the
        // real committed assets, not a placeholder.
        assert_eq!(&SCREEN_SMALL_TEXT_PNG[..8], b"\x89PNG\r\n\x1a\n", "committed PNG signature");
        assert_eq!(&AUDIO_CLIP_WAV[..4], b"RIFF", "committed WAV is a RIFF container");
        assert_eq!(&AUDIO_CLIP_WAV[8..12], b"WAVE", "committed WAV is a WAVE file");

        let image = STANDARD.encode(SCREEN_SMALL_TEXT_PNG);
        let decoded = STANDARD.decode(&image).expect("the embedded image is valid base64");
        assert_eq!(decoded, SCREEN_SMALL_TEXT_PNG);
    }

    /// THE FIXTURE-LEVEL WRONG-EXPECTATION CONTROL (AC-2 / INVEST "T").
    ///
    /// The positive twin of a synthetic turn satisfies a matched expectation; a
    /// deliberately-WRONG expectation over the SAME turn FAILS. This is the unit
    /// tier of the mandated control — a green run without it proves nothing.
    #[test]
    fn a_deliberately_wrong_expectation_fails_the_same_observed_turn() {
        let observed = ObservedTurn {
            calls: vec![ObservedCall {
                name: Some("open_app".to_string()),
                arguments: Some(format!(r#"{{"app":"{SCREEN_TEXT_APP_NAME}"}}"#)),
            }],
            content: String::new(),
            failure: None,
        };
        let matched = Expectation::Call {
            name: "open_app",
            required_args: &[("app", SCREEN_TEXT_APP_NAME)],
        };
        assert!(evaluate(&matched, &observed).passed, "the matched twin must pass");

        let wrong = Expectation::Call {
            name: "close_app",
            required_args: &[("app", SCREEN_TEXT_APP_NAME)],
        };
        assert!(
            !evaluate(&wrong, &observed).passed,
            "a deliberately-wrong expectation must FAIL the same turn"
        );
    }

    /// The Doom fixture's schema expectation accepts a valid `{"steps": [...]}`
    /// object and rejects an object missing `steps`.
    #[test]
    fn the_doom_schema_expectation_is_structural() {
        let fixture = schema_doom_plan_fixture();
        let valid = ObservedTurn {
            calls: Vec::new(),
            content: r#"{"steps":[{"op":"move","bearing":10,"distance":5}]}"#.to_string(),
            failure: None,
        };
        assert!(evaluate(&fixture.expect, &valid).passed);
        let missing = ObservedTurn {
            calls: Vec::new(),
            content: r#"{"plan":[]}"#.to_string(),
            failure: None,
        };
        assert!(!evaluate(&fixture.expect, &missing).passed);
    }

    /// The template projection of every fixture is text-only where it must be —
    /// media bytes never leak into a prompt as text (the product invariant the
    /// harness reuses rather than re-implements).
    #[test]
    fn media_bytes_never_reach_a_prompt_projection() {
        for fixture in fixtures() {
            let projection = fixture.turn.template_messages_json();
            if let Some(image) = fixture.turn.image.as_deref() {
                assert!(!projection.contains(image), "{}: image bytes leaked", fixture.id);
            }
            if let Some(audio) = fixture.turn.audio.as_deref() {
                assert!(!projection.contains(audio), "{}: audio bytes leaked", fixture.id);
            }
        }
    }
}

// ── The AC-1 absence guard (raw scan + non-vacuity + named universe) ──────────

#[cfg(test)]
mod absence_guard {
    use std::path::{Path, PathBuf};

    /// The OpenAI-shaped request-vocabulary tokens this harness must never carry.
    ///
    /// Every token is CONSTRUCTED from fragments so the guard's own source cannot
    /// satisfy it (the "quote the banned token" trap). The tokens capture the
    /// REQUEST vocabulary (an OpenAI endpoint path, the quoted `response_format`
    /// request key, an API-key/authorization seam) and the provider/adapter SEAM
    /// type identifiers. The bare lowercase telemetry column `provider` is
    /// deliberately NOT banned — it is the legitimate `telemetry_spans.provider`
    /// column that `persist.rs` sets to `internal`; banning it would make the
    /// guard unsatisfiable against a valid, non-request use.
    fn banned_tokens() -> Vec<String> {
        vec![
            ["chat", "completions"].join("/"),
            ["\"response", "_format\""].concat(),
            ["api", "key"].join("_"),
            ["api", "Key"].concat(),
            ["api", "key"].join("-"),
            ["open", "ai"].concat(),
            ["Bearer", " "].concat(),
            ["Provider", "Seam"].concat(),
            ["Model", "Provider"].concat(),
            ["Provider", "Ada", "pter"].concat(),
            ["Ada", "pter"].concat(),
        ]
    }

    /// The offending tokens present in `text` (empty ⇒ clean).
    fn scan(text: &str) -> Vec<String> {
        banned_tokens()
            .into_iter()
            .filter(|token| text.contains(token.as_str()))
            .collect()
    }

    /// Recursively collect `.rs` files under `dir`.
    fn collect_rs(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                collect_rs(&path, out);
            } else if path.extension().and_then(|ext| ext.to_str()) == Some("rs") {
                out.push(path);
            }
        }
    }

    /// The scan universe: the whole `engine/score/` subtree plus the CLI
    /// subcommand file when it lands (its own sub-task). Printed so the scanned
    /// set is auditable (G-441).
    fn harness_source_files() -> Vec<PathBuf> {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = Vec::new();
        collect_rs(&src.join("applications/llm_server/engine/score"), &mut files);
        let companion_score = src.join("infrastructure/cli/commands/companion_score.rs");
        if companion_score.is_file() {
            files.push(companion_score);
        }
        files.sort();
        files
    }

    /// AC-1: zero OpenAI-shaped request vocabulary anywhere in the harness — the
    /// AC's literal predicate, scanned RAW (comments and doc-comments included).
    #[test]
    fn no_shaped_request_vocabulary_in_the_harness() {
        let files = harness_source_files();
        assert!(
            !files.is_empty(),
            "the absence guard must scan a non-empty universe"
        );
        eprintln!("absence-guard universe: {} file(s)", files.len());
        let mut scanned = 0usize;
        for path in &files {
            let text = std::fs::read_to_string(path)
                .unwrap_or_else(|error| panic!("scan {}: {error}", path.display()));
            scanned += 1;
            let hits = scan(&text);
            assert!(
                hits.is_empty(),
                "{} contains OpenAI-shaped request vocabulary {hits:?}",
                path.display()
            );
            eprintln!("  scanned {} ({} bytes)", path.display(), text.len());
        }
        assert_eq!(scanned, files.len());
    }

    /// NON-VACUITY CONTROL: a seeded hit inside the universe's root IS caught, and
    /// an out-of-root synthetic hit is NOT scanned (the universe is scoped).
    #[test]
    fn the_absence_guard_catches_a_seeded_hit_and_is_scoped_to_its_root() {
        // A seeded hit — built from fragments so this control file stays clean.
        let seeded = format!("let body = {}\"json\";", ["\"response", "_format\""].concat());
        assert_eq!(
            scan(&seeded),
            vec!["\"response_format\"".to_string()],
            "a seeded OpenAI request token must be caught"
        );

        // The out-of-root probe: a file that WOULD trip the scan, placed under a
        // directory the universe does not walk.
        let cache = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/absence-probe");
        std::fs::create_dir_all(&cache).expect("create the probe dir");
        let probe = cache.join("out_of_root.rs");
        std::fs::write(&probe, seeded.as_bytes()).expect("write the probe");
        let universe = harness_source_files();
        assert!(
            !universe.iter().any(|path| path == &probe),
            "an out-of-root probe must NOT be part of the scan universe"
        );
        let _ = std::fs::remove_file(&probe);

        // And the universe really contains this module's own directory.
        let score_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src/applications/llm_server/engine/score");
        assert!(
            universe.iter().any(|path| path.starts_with(&score_dir)),
            "the universe must include the score module"
        );
    }

    /// The positive half of the AC: the ONLY request-shaping calls are the
    /// product's own producers (`skills::skill_turn` / `doom_agent::doom_turn`).
    #[test]
    fn the_only_shaping_calls_are_the_product_producers() {
        let files = harness_source_files();
        let combined: String = files
            .iter()
            .map(|path| std::fs::read_to_string(path).expect("read"))
            .collect();
        assert!(
            combined.contains("skill_turn("),
            "the harness must shape turns through `skills::skill_turn`"
        );
        assert!(
            combined.contains("doom_turn("),
            "the harness must shape the Doom turn through `doom_agent::doom_turn`"
        );
    }
}
