//! Doom-playing agent persona + schema-constrained request builder + model-backed
//! decision source + bounded request audit (Spec #2969, ST-4; EARS R-2).
//!
//! This module gives the out-of-process companion a distinct Doom-playing persona
//! and a request contract that carries **structured game state only**:
//!
//! * [`DOOM_AGENT_SYSTEM_PROMPT`] is the persona (plan a short route ahead, open
//!   doors, engage blocking threats, respond with ONLY the `{"steps": [...]}`
//!   JSON, never request pixels or audio);
//! * [`build_doom_agent_request_body`] renders a schema-constrained
//!   (`response_format: json_schema`, name
//!   [`DOOM_PLAN_SCHEMA_NAME`](crate::infrastructure::companion::doom_decision::DOOM_PLAN_SCHEMA_NAME))
//!   request via `chat::render_messages(..., None, None)`, so **no
//!   `image_url`/`input_audio` part can appear** (the F-25 audit surface);
//! * [`ModelDoomDecisionSource`] implements the shared
//!   [`DoomDecisionSource`](crate::infrastructure::companion::doom_decision::DoomDecisionSource)
//!   trait over the existing `chat::run_stream` shell, with a bounded per-decision
//!   timeout ([`DOOM_AUTOPLAY_DECISION_TIMEOUT_S`]), accumulating the structured
//!   `delta.content` and parsing a
//!   [`DoomPlan`](crate::infrastructure::companion::doom_decision::DoomPlan);
//! * every request appends ONE compact audit record to a bounded JSONL (last
//!   [`DOOM_AGENT_AUDIT_MAX_RECORDS`]) under `FREDO_DOOM_AGENT_LOG_DIR` — the live
//!   AC2 receipt.
//!
//! # Cross-application boundary
//!
//! The action vocabulary is a **parameter** of [`build_doom_agent_request_body`]
//! and [`ModelDoomDecisionSource::new`] — this module never imports
//! `applications/doom` (cross-application imports are forbidden, `AGENTS.md`). The
//! composition root (`lib.rs`) passes `applications/doom/actions::action_vocabulary_json()`.
//! `FREDO_DOOM_AGENT_LOG_DIR` is read directly via `std::env::var` here (an env
//! var is not a cross-application import).

use std::path::{Path, PathBuf};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::infrastructure::companion::doom_decision::{
    parse_doom_plan, DoomDecisionError, DoomDecisionSource, DoomPlan, DOOM_PLAN_DISTANCE_MAX,
    DOOM_PLAN_MAX_STEPS, DOOM_PLAN_SCHEMA_NAME, DOOM_PLAN_TICS_MAX,
};

use super::chat::{self, ChatStreamEvent, LlmMessage};

/// The Doom-playing persona.
///
/// It states: you are Fredo's Doom-playing agent; you receive the engine's
/// structured observation and the allowed action objects; plan a short route that
/// makes forward progress toward the level exit, opening a door the route
/// requires and engaging threats that block the way; respond with ONLY the
/// `{"steps": [...]}` JSON object matching the schema; never request pixels or
/// audio.
pub const DOOM_AGENT_SYSTEM_PROMPT: &str = "You are Fredo's Doom-playing agent. On each turn you receive the engine's structured observation of the game state and the list of allowed action objects. Plan a short route that makes forward progress toward the level exit, opening a door when the route requires one and engaging threats when they block the way. Respond with ONLY a single JSON object of the form {\"steps\": [{\"op\": \"move\", \"bearing\": <0-359>, \"distance\": <1-1024>}, {\"op\": \"open-door\", \"bearing\": <0-359>}, {\"op\": \"shoot\", \"tics\": <1-350>}, {\"op\": \"wait\", \"tics\": <1-350>}]} that matches the provided schema - no prose, no markdown, no extra keys. Never request pixels, images, or audio; the structured observation is the only input you need.";

/// Environment seam naming the directory for the bounded request-audit JSONL.
///
/// Read directly here (an env var is not a cross-application import); inert when unset.
pub const DOOM_AGENT_LOG_DIR_ENV: &str = "FREDO_DOOM_AGENT_LOG_DIR";

/// Bound on a single model decision, in seconds (the per-decision timeout).
///
/// Mirrors `applications/doom/autoplay::DOOM_AUTOPLAY_DECISION_TIMEOUT_S`; duplicated
/// locally because this application may not import the doom application.
pub const DOOM_AUTOPLAY_DECISION_TIMEOUT_S: u64 = 30;

/// Maximum number of audit records retained in the JSONL (the last-N bound).
pub const DOOM_AGENT_AUDIT_MAX_RECORDS: usize = 64;

/// Maximum `max_tokens` for a single Doom decision reply (lever D, #3026 ST-5).
///
/// Collapsed to the shared [`chat::MAX_TOKENS`] default. The earlier
/// "256 is ample for a tiny `{tics, actions}` object" premise was falsified by the
/// shipped managed config: the server runs reasoning **on** (`--reasoning on`) and
/// its reasoning prefix is not surfaced to this path yet still consumes the token
/// budget, so a 256-token cap could starve the reply to empty. The Doom request is
/// therefore bounded to the SAME value as the shared builder — the override remains
/// Doom-path-only, and `chat::build_response_format_request_body`'s own default and
/// every other caller are untouched.
pub const DOOM_AGENT_MAX_TOKENS: u32 = chat::MAX_TOKENS;

/// File name of the bounded request-audit JSONL inside the log directory.
pub const DOOM_AGENT_AUDIT_FILE: &str = "doom-agent-requests.jsonl";

// ── Pure request contract ─────────────────────────────────────────────────────

/// The `doom_plan` response schema: `{"steps": [{"op": ..., ...}]}`.
///
/// Each step advertises `op` plus the optional typed fields, with
/// `additionalProperties: false` at BOTH levels (Spec #3039 ST-3).
pub fn doom_plan_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "steps": {
                "type": "array",
                "minItems": 1,
                "maxItems": DOOM_PLAN_MAX_STEPS,
                "items": {
                    "type": "object",
                    "properties": {
                        "op": { "type": "string", "enum": ["move", "open-door", "shoot", "wait"] },
                        "bearing": { "type": "integer", "minimum": 0, "maximum": 359 },
                        "distance": { "type": "integer", "minimum": 1, "maximum": DOOM_PLAN_DISTANCE_MAX },
                        "tics": { "type": "integer", "minimum": 1, "maximum": DOOM_PLAN_TICS_MAX }
                    },
                    "required": ["op"],
                    "additionalProperties": false
                }
            }
        },
        "required": ["steps"],
        "additionalProperties": false
    })
}

/// Build the schema-constrained Doom plan request body.
///
/// Pure. The system message is [`DOOM_AGENT_SYSTEM_PROMPT`]; the user message is a
/// plain STRING carrying `{"observation": <state JSON>, "allowedActions":
/// [<vocabulary>]}`. Rendered through `chat::build_response_format_request_body`
/// (which uses `chat::render_messages(..., None, None)`), so no `image_url`/
/// `input_audio` part and no image/audio field can appear (R-2).
///
/// The shared builder's `max_tokens` default is left untouched; the returned
/// Doom body is then bounded to [`DOOM_AGENT_MAX_TOKENS`] (lever D, #3026 ST-5) —
/// a Doom-path-only override, so no other feature inherits this token bound.
///
/// `vocabulary` is a PARAMETER — this module never imports `applications/doom`.
pub fn build_doom_agent_request_body(observation: &Value, vocabulary: &Value) -> Value {
    let user_payload = json!({
        "observation": observation,
        "allowedActions": vocabulary,
    });
    let messages = vec![
        LlmMessage {
            role: "system".to_string(),
            content: DOOM_AGENT_SYSTEM_PROMPT.to_string(),
        },
        LlmMessage {
            role: "user".to_string(),
            content: user_payload.to_string(),
        },
    ];
    let mut body = chat::build_response_format_request_body(
        &messages,
        DOOM_PLAN_SCHEMA_NAME,
        &doom_plan_schema(),
    );
    // Lever D (#3026 ST-5): bound generation on the Doom path ONLY, at the
    // shared `chat::MAX_TOKENS` default (the reasoning-enabled server's invisible
    // reasoning prefix consumes the budget, so a smaller cap can starve the
    // reply). `chat::build_response_format_request_body`'s own default is
    // deliberately NOT changed.
    body["max_tokens"] = json!(DOOM_AGENT_MAX_TOKENS);
    body
}

// ── Bounded request audit ─────────────────────────────────────────────────────

/// The audit directory from [`DOOM_AGENT_LOG_DIR_ENV`], or `None` when unset/blank.
pub fn doom_agent_log_dir() -> Option<PathBuf> {
    std::env::var(DOOM_AGENT_LOG_DIR_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

/// Build one compact audit record for a request (the live AC2 receipt).
///
/// `tic` is read from the observation when present (else `null`). The record
/// carries exactly: `{at, tic, contentParts:["text"], hasImage:false,
/// hasAudio:false, systemPrompt}`.
pub fn build_audit_record(observation: &Value) -> Value {
    json!({
        "at": chrono::Utc::now().to_rfc3339(),
        "tic": observation.get("tic").cloned().unwrap_or(Value::Null),
        "contentParts": ["text"],
        "hasImage": false,
        "hasAudio": false,
        "systemPrompt": DOOM_AGENT_SYSTEM_PROMPT,
    })
}

/// Append one record to the bounded JSONL under `dir`, retaining the last
/// [`DOOM_AGENT_AUDIT_MAX_RECORDS`] lines.
///
/// The directory is created when absent. Reads-modifies-writes the file so the
/// bound holds across process restarts; callers treat a failure as best-effort
/// (an audit write must never fail a decision).
pub fn append_audit_record(dir: &Path, record: &Value) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join(DOOM_AGENT_AUDIT_FILE);
    let mut lines: Vec<String> = std::fs::read_to_string(&path)
        .map(|text| {
            text.lines()
                .filter(|line| !line.trim().is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    lines.push(record.to_string());
    if lines.len() > DOOM_AGENT_AUDIT_MAX_RECORDS {
        let excess = lines.len() - DOOM_AGENT_AUDIT_MAX_RECORDS;
        lines.drain(..excess);
    }
    let mut content = lines.join("\n");
    content.push('\n');
    std::fs::write(&path, content)
}

// ── Model reply parsing ───────────────────────────────────────────────────────

/// Parse an accumulated model reply into a [`DoomPlan`].
///
/// Delegates to the shared boundary parser
/// ([`parse_doom_plan`](crate::infrastructure::companion::doom_decision::parse_doom_plan)),
/// so the model path and the scripted lever derive the SAME plan from the SAME
/// JSON. A non-object / missing `steps` / unknown `op` / out-of-bounds field /
/// more than [`DOOM_PLAN_MAX_STEPS`] steps is
/// [`DoomDecisionError::Malformed`]. A legacy `{tics, actions}` object maps to a
/// single `Hold` step (the legacy `tics` is not range-checked here — the loop
/// validates it).
pub fn parse_doom_decision(content: &str) -> Result<DoomPlan, DoomDecisionError> {
    let value: Value = serde_json::from_str(content.trim()).map_err(|error| {
        DoomDecisionError::Malformed(format!("model reply is not valid JSON: {error}"))
    })?;
    parse_doom_plan(&value)
}

/// Classify the accumulated streaming reply into a [`DoomPlan`].
///
/// An **empty/whitespace** reply is an availability condition, NOT a malformed
/// decision: the reasoning-enabled server may return nothing on the `content`
/// channel (its reasoning prefix is not surfaced here and can consume the whole
/// budget), and a transport/compaction hiccup yields the same shape. It therefore
/// maps to [`DoomDecisionError::ModelUnavailable`], which the continuous loop routes
/// to its NON-fatal degrade branch (R-4/AC4, #3026 ST-2 rework) — the run keeps
/// advancing with the last intent instead of taking the fatal malformed stop.
///
/// A **non-empty** reply is parsed as before: any invalid JSON or unusable plan
/// stays [`DoomDecisionError::Malformed`], so the bounded failure-stop semantics
/// for genuinely malformed decisions are unchanged.
pub fn classify_doom_reply(content: &str) -> Result<DoomPlan, DoomDecisionError> {
    if content.trim().is_empty() {
        return Err(DoomDecisionError::ModelUnavailable(
            "model returned an empty reply".to_string(),
        ));
    }
    parse_doom_decision(content)
}

// ── Model-backed decision source ──────────────────────────────────────────────

/// A [`DoomDecisionSource`] backed by the managed companion model.
///
/// Built over the existing `chat::run_stream` shell: it renders
/// [`build_doom_agent_request_body`], accumulates the structured `delta.content`
/// within [`DOOM_AUTOPLAY_DECISION_TIMEOUT_S`], and classifies the reply via
/// [`classify_doom_reply`] (`Malformed` on invalid non-empty JSON,
/// `ModelUnavailable` on an empty reply or a stream/transport error, `TimedOut` on
/// the per-decision bound). Each request appends one audit record (best-effort)
/// when [`DOOM_AGENT_LOG_DIR_ENV`] names a directory.
pub struct ModelDoomDecisionSource {
    app: AppHandle,
    vocabulary: Value,
}

impl ModelDoomDecisionSource {
    /// Build a model-backed source over `app` with the allowed-action `vocabulary`
    /// (the composition root supplies it — no cross-application import).
    pub fn new(app: AppHandle, vocabulary: Value) -> Self {
        Self { app, vocabulary }
    }
}

#[async_trait]
impl DoomDecisionSource for ModelDoomDecisionSource {
    async fn decide(&self, observation: &Value) -> Result<DoomPlan, DoomDecisionError> {
        let body = build_doom_agent_request_body(observation, &self.vocabulary);

        // One compact audit record per request (best-effort; never fails a decision).
        if let Some(dir) = doom_agent_log_dir() {
            let record = build_audit_record(observation);
            if let Err(error) = append_audit_record(&dir, &record) {
                tracing::warn!(
                    target: "fredo::llm_server",
                    error = %error,
                    "could not append the Doom request audit record"
                );
            }
        }

        let mut content = String::new();
        let stream_result = tokio::time::timeout(
            Duration::from_secs(DOOM_AUTOPLAY_DECISION_TIMEOUT_S),
            chat::run_stream(&self.app, &body, |frame| {
                for event in frame.events {
                    if let ChatStreamEvent::Delta(delta) = event {
                        content.push_str(&delta);
                    }
                }
                false
            }),
        )
        .await;

        match stream_result {
            Err(_elapsed) => Err(DoomDecisionError::TimedOut),
            Ok(Err(detail)) => Err(DoomDecisionError::ModelUnavailable(detail)),
            // An empty reply is a source-availability condition (R-4), not a
            // malformed decision — `classify_doom_reply` maps it to
            // `ModelUnavailable` so the loop degrades and keeps advancing.
            Ok(Ok(())) => classify_doom_reply(&content),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::companion::doom_decision::{DoomPlanStep, DOOM_PLAN_SCHEMA_NAME};
    use serde_json::json;

    /// **F-25 (QA unit pin, R-2/AC2).** The serialized request body carries
    /// `DOOM_AGENT_SYSTEM_PROMPT` as the system message + the structured
    /// observation, and contains NO `image_url`/`input_audio` part and no
    /// image/audio field.
    #[test]
    fn f25_request_body_is_structured_text_only() {
        let observation = json!({
            "tic": 42,
            "player": { "health": 100, "x": 1.5, "y": 2.5 },
            "exit": { "distance": 12.0 },
            "done": false,
        });
        let vocabulary = json!([
            { "type": "forward", "summary": "hold forward" },
            { "type": "shoot", "summary": "hold fire" },
        ]);

        let body = build_doom_agent_request_body(&observation, &vocabulary);

        // The system message IS the Doom persona, as a plain string.
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][0]["content"], DOOM_AGENT_SYSTEM_PROMPT);
        assert!(body["messages"][0]["content"].is_string());

        // The user message is a plain STRING carrying the structured observation.
        assert_eq!(body["messages"][1]["role"], "user");
        let user_content = body["messages"][1]["content"]
            .as_str()
            .expect("the user content must be a plain string");
        let payload: Value = serde_json::from_str(user_content).expect("structured JSON payload");
        assert_eq!(payload["observation"], observation);
        assert_eq!(payload["allowedActions"], vocabulary);

        // The response_format is the schema-constrained `doom_plan` (ST-3).
        assert_eq!(body["stream"], true);
        // Lever D (ST-5): the Doom body is bounded to DOOM_AGENT_MAX_TOKENS.
        assert_eq!(body["max_tokens"], DOOM_AGENT_MAX_TOKENS);
        assert_eq!(body["response_format"]["type"], "json_schema");
        assert_eq!(
            body["response_format"]["json_schema"]["name"],
            DOOM_PLAN_SCHEMA_NAME
        );
        let schema = &body["response_format"]["json_schema"]["schema"];
        assert_eq!(schema["properties"]["steps"]["type"], "array");
        assert_eq!(schema["properties"]["steps"]["minItems"], 1);
        assert_eq!(schema["properties"]["steps"]["maxItems"], DOOM_PLAN_MAX_STEPS);
        let step = &schema["properties"]["steps"]["items"];
        assert_eq!(step["type"], "object");
        assert_eq!(
            step["properties"]["op"]["enum"],
            json!(["move", "open-door", "shoot", "wait"])
        );
        assert_eq!(step["properties"]["bearing"]["minimum"], 0);
        assert_eq!(step["properties"]["bearing"]["maximum"], 359);
        assert_eq!(step["properties"]["distance"]["minimum"], 1);
        assert_eq!(step["properties"]["distance"]["maximum"], DOOM_PLAN_DISTANCE_MAX);
        assert_eq!(step["properties"]["tics"]["minimum"], 1);
        assert_eq!(step["properties"]["tics"]["maximum"], DOOM_PLAN_TICS_MAX);
        assert_eq!(step["required"], json!(["op"]));
        assert_eq!(step["additionalProperties"], false);
        assert_eq!(schema["required"], json!(["steps"]));
        assert_eq!(schema["additionalProperties"], false);

        // F-25: NO image/audio part and NO image/audio field can appear.
        let serialized = body.to_string();
        assert!(
            !serialized.contains("image_url"),
            "no image_url part: {serialized}"
        );
        assert!(
            !serialized.contains("input_audio"),
            "no input_audio part: {serialized}"
        );
        assert!(
            !serialized.contains("\"image\""),
            "no image field: {serialized}"
        );
        assert!(
            !serialized.contains("\"audio\""),
            "no audio field: {serialized}"
        );
    }

    /// **ST-5 (REQ-1 model receipt, NFR-BOUND, Spec #3030 S1).** A
    /// `walls`-bearing observation is forwarded **verbatim** into
    /// `messages[1].content` (`{"observation": <state>, "allowedActions": ...}`):
    /// the exact `walls` array survives with no field dropped and no size/budget
    /// guard rejecting it. Constructed as a generic `serde_json::json!` value —
    /// this module NEVER imports `applications/doom` (cross-application imports
    /// are forbidden).
    #[test]
    fn st5_walls_bearing_observation_passes_through_verbatim() {
        let observation = json!({
            "tic": 123,
            "done": false,
            "outcome": "alive",
            "level": { "episode": 1, "map": 1, "skill": 3, "kills": 0, "items": 0, "secrets": 0 },
            "player": {
                "x": 1056, "y": -3616, "angle": 90, "health": 100, "armor": 0,
                "ammo": { "bullets": 50, "shells": 0, "rockets": 0, "cells": 0 },
                "weapon": "pistol",
            },
            "enemies": [],
            "items": [],
            "doors": [],
            "exit": { "distance": 812 },
            "walls": [
                { "direction": "left",  "distance": 96,  "blocked": false },
                { "direction": "front", "distance": 48,  "blocked": true  },
                { "direction": "right", "distance": 640, "blocked": false },
            ],
        });
        let vocabulary = json!([
            { "type": "forward", "summary": "hold forward" },
            { "type": "turn-to", "summary": "face an absolute angle", "params": ["angle"] },
        ]);

        let body = build_doom_agent_request_body(&observation, &vocabulary);

        let user_content = body["messages"][1]["content"]
            .as_str()
            .expect("the user content is a plain string");
        let payload: Value = serde_json::from_str(user_content).expect("structured JSON payload");

        // The `walls` array (and the whole observation) survives VERBATIM.
        assert_eq!(
            payload["observation"], observation,
            "the observation is forwarded byte-for-byte"
        );
        assert_eq!(payload["allowedActions"], vocabulary);

        let walls = payload["observation"]["walls"]
            .as_array()
            .expect("walls is an array in the request");
        assert_eq!(walls.len(), 3, "no wall entry was dropped");
        assert_eq!(
            walls[0],
            json!({ "direction": "left", "distance": 96, "blocked": false })
        );
        assert_eq!(
            walls[1],
            json!({ "direction": "front", "distance": 48, "blocked": true })
        );
        assert_eq!(
            walls[2],
            json!({ "direction": "right", "distance": 640, "blocked": false })
        );

        // No size/budget guard rejected the payload: the builder bounds only
        // `max_tokens` (unchanged), so the walls-bearing observation is intact.
        assert_eq!(body["max_tokens"], DOOM_AGENT_MAX_TOKENS);
        assert!(
            user_content.contains("\"walls\""),
            "the serialized user message carries the walls array: {user_content}"
        );
    }

    #[test]
    fn schema_name_and_persona_are_pinned() {
        assert_eq!(DOOM_PLAN_SCHEMA_NAME, "doom_plan");
        assert_eq!(DOOM_AUTOPLAY_DECISION_TIMEOUT_S, 30);
        assert!(DOOM_AGENT_SYSTEM_PROMPT.contains("Doom"));
        assert!(DOOM_AGENT_SYSTEM_PROMPT.contains("steps"));
        assert!(DOOM_AGENT_SYSTEM_PROMPT.contains("move"));
        assert!(DOOM_AGENT_SYSTEM_PROMPT.contains("open-door"));
        assert!(DOOM_AGENT_SYSTEM_PROMPT.contains("pixels"));
        assert!(DOOM_AGENT_SYSTEM_PROMPT.contains("audio"));
        // ST-5 rework: the Doom bound is collapsed to the shared default.
        assert_eq!(DOOM_AGENT_MAX_TOKENS, chat::MAX_TOKENS);
        assert_eq!(DOOM_AGENT_MAX_TOKENS, 1024);
    }

    /// **ST-5 (lever D, R-1; rework round 2).** The Doom body is bounded to
    /// [`DOOM_AGENT_MAX_TOKENS`], which is now the shared `chat::MAX_TOKENS`
    /// default, while `chat::build_response_format_request_body`'s OWN default is
    /// left byte-for-byte unchanged (the override stays Doom-path-only).
    #[test]
    fn st5_doom_body_uses_the_shared_token_budget_and_leaves_the_shared_builder_untouched() {
        let body = build_doom_agent_request_body(&json!({ "tic": 1 }), &json!([]));
        assert_eq!(body["max_tokens"], chat::MAX_TOKENS);
        assert_eq!(body["max_tokens"], DOOM_AGENT_MAX_TOKENS);
        assert_eq!(body["max_tokens"], 1024);

        // The shared builder still renders its own (unchanged) default.
        let shared = chat::build_response_format_request_body(
            &[LlmMessage {
                role: "user".to_string(),
                content: "hello".to_string(),
            }],
            "fredo_reply",
            &doom_plan_schema(),
        );
        assert_eq!(shared["max_tokens"], chat::MAX_TOKENS);
        assert_eq!(shared["max_tokens"], DOOM_AGENT_MAX_TOKENS);
    }

    /// **ST-2 rework (R-4/AC4).** An EMPTY/whitespace accumulated reply is a
    /// source-availability condition → [`DoomDecisionError::ModelUnavailable`]
    /// (the loop's NON-fatal degrade branch), NOT the fatal `Malformed`; a
    /// NON-empty invalid reply stays `Malformed`.
    #[test]
    fn an_empty_reply_is_model_unavailable_not_malformed() {
        assert!(matches!(
            classify_doom_reply(""),
            Err(DoomDecisionError::ModelUnavailable(_))
        ));
        assert!(matches!(
            classify_doom_reply("   \n\t "),
            Err(DoomDecisionError::ModelUnavailable(_))
        ));

        // Non-empty invalid JSON keeps the fatal `Malformed` classification.
        assert!(matches!(
            classify_doom_reply("not json"),
            Err(DoomDecisionError::Malformed(_))
        ));
        assert!(matches!(
            classify_doom_reply("[1, 2]"),
            Err(DoomDecisionError::Malformed(_))
        ));

        // A valid plan reply still parses.
        let plan = classify_doom_reply(r#"{ "steps": [{ "op": "wait", "tics": 3 }] }"#)
            .expect("a valid plan reply parses");
        assert_eq!(plan.steps, vec![DoomPlanStep::Wait { tics: 3 }]);
    }

    /// **ST-3 (R-2).** The model parser accepts the plan shape AND the legacy
    /// `{tics, actions}` shape (→ a single `Hold` step).
    #[test]
    fn parse_doom_decision_accepts_a_plan_and_a_legacy_object() {
        let plan = parse_doom_decision(r#"{ "steps": [{ "op": "move", "bearing": 90, "distance": 256 }] }"#)
            .expect("a valid plan");
        assert_eq!(
            plan.steps,
            vec![DoomPlanStep::Move {
                bearing: 90,
                distance: 256,
            }]
        );

        let legacy =
            parse_doom_decision(r#"{ "tics": 5, "actions": [{ "type": "forward" }] }"#)
                .expect("a legacy decision");
        assert_eq!(
            legacy.steps,
            vec![DoomPlanStep::Hold {
                tics: 5,
                actions: vec![json!({ "type": "forward" })],
            }]
        );
        assert_eq!(legacy.as_single_hold().tics, 5);
    }

    #[test]
    fn parse_doom_decision_is_malformed_on_bad_shapes() {
        assert!(matches!(
            parse_doom_decision("not json"),
            Err(DoomDecisionError::Malformed(_))
        ));
        assert!(matches!(
            parse_doom_decision("[1, 2]"),
            Err(DoomDecisionError::Malformed(_))
        ));
        // Neither a plan nor a legacy reply.
        assert!(matches!(
            parse_doom_decision(r#"{ "actions": [] }"#),
            Err(DoomDecisionError::Malformed(_))
        ));
        assert!(matches!(
            parse_doom_decision(r#"{ "tics": 1 }"#),
            Err(DoomDecisionError::Malformed(_))
        ));
        // A non-integer legacy `tics` is malformed.
        assert!(matches!(
            parse_doom_decision(r#"{ "tics": 1.5, "actions": [] }"#),
            Err(DoomDecisionError::Malformed(_))
        ));
        // A plan with an unknown op is malformed.
        assert!(matches!(
            parse_doom_decision(r#"{ "steps": [{ "op": "nope" }] }"#),
            Err(DoomDecisionError::Malformed(_))
        ));
    }

    #[test]
    fn audit_record_carries_the_f30_shape() {
        let record = build_audit_record(&json!({ "tic": 17 }));
        assert_eq!(record["tic"], 17);
        assert_eq!(record["contentParts"], json!(["text"]));
        assert_eq!(record["hasImage"], false);
        assert_eq!(record["hasAudio"], false);
        assert_eq!(record["systemPrompt"], DOOM_AGENT_SYSTEM_PROMPT);
        assert!(
            record["at"]
                .as_str()
                .map(|at| !at.is_empty())
                .unwrap_or(false),
            "the audit record must carry a non-empty timestamp"
        );
        assert_eq!(record.as_object().map(|object| object.len()), Some(6));
    }

    #[test]
    fn audit_record_tic_is_null_when_absent() {
        let record = build_audit_record(&json!({}));
        assert!(record["tic"].is_null());
    }

    #[test]
    fn append_audit_record_bounds_the_jsonl_to_the_last_64() {
        let dir = tempfile::tempdir().expect("tempdir");
        let total = DOOM_AGENT_AUDIT_MAX_RECORDS + 5;
        for tic in 0..total {
            let record = build_audit_record(&json!({ "tic": tic }));
            append_audit_record(dir.path(), &record).expect("append");
        }
        let text =
            std::fs::read_to_string(dir.path().join(DOOM_AGENT_AUDIT_FILE)).expect("read audit");
        let lines: Vec<&str> = text
            .lines()
            .filter(|line| !line.trim().is_empty())
            .collect();
        assert_eq!(lines.len(), DOOM_AGENT_AUDIT_MAX_RECORDS);
        // The retained window is the LAST 64: tics 5..=68.
        let first: Value = serde_json::from_str(lines[0]).expect("first line JSON");
        let last: Value = serde_json::from_str(lines[lines.len() - 1]).expect("last line JSON");
        assert_eq!(first["tic"], 5);
        assert_eq!(last["tic"], (total - 1) as i64);
    }
}
