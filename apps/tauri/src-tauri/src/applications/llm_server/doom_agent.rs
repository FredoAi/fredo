//! Doom-playing agent persona + schema-constrained request builder + model-backed
//! decision source (Spec #2969, ST-4; EARS R-2; Spec #3032, ST-4).
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
//! * the source records an ADDITIVE
//!   [`DoomDecisionTrace`](crate::infrastructure::companion::doom_decision::DoomDecisionTrace)
//!   for its most recent decision (model id / server flags / prompt + schema
//!   versions, plus the flag-gated, size-bounded raw reply + reasoning text) and
//!   exposes it via `last_decision_trace` for the loop-side dataset assembler.
//!
//! The earlier bounded request-audit JSONL (`doom-agent-requests.jsonl`) is
//! **RETIRED** (Spec #3032 ST-4): the dataset's `model`/`modelRaw` blocks carry
//! the same structured-text-only receipt, correlated to the decision (no dead
//! dual-writer).
//!
//! # Cross-application boundary
//!
//! The action vocabulary is a **parameter** of [`build_doom_agent_request_body`]
//! and [`ModelDoomDecisionSource::new`] — this module never imports
//! `applications/doom` (cross-application imports are forbidden, `AGENTS.md`). The
//! composition root (`lib.rs`) passes `applications/doom/actions::action_vocabulary_json()`.
//! The dataset capture env seams ([`DOOM_DATASET_RAW_ENV`] /
//! [`DOOM_DATASET_REASONING_ENV`]) and the persisted server settings are read
//! directly here (an env var / the SettingsStore is not a cross-application import).

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::infrastructure::companion::doom_decision::{
    parse_doom_plan, DoomDecisionError, DoomDecisionSource, DoomDecisionTrace, DoomPlan,
    DOOM_PLAN_DISTANCE_MAX, DOOM_PLAN_MAX_STEPS, DOOM_PLAN_SCHEMA_NAME, DOOM_PLAN_TICS_MAX,
};
use crate::infrastructure::storage::SettingsStore;

use super::chat::{self, ChatStreamEvent, LlmMessage};
use super::config::LlamaServerConfig;
use super::{LLAMA_SERVER_ARGS_KEY, LLAMA_SERVER_MODEL_PATH_KEY};

/// The Doom-playing persona.
///
/// It states: you are Fredo's Doom-playing agent; you receive the engine's
/// structured observation and the allowed action objects; plan a short route that
/// makes forward progress toward the level exit, opening a door the route
/// requires and engaging threats that block the way; respond with ONLY the
/// `{"steps": [...]}` JSON object matching the schema; never request pixels or
/// audio.
pub const DOOM_AGENT_SYSTEM_PROMPT: &str = "You are Fredo's Doom-playing agent. On each turn you receive the engine's structured observation of the game state and the list of allowed action objects. Plan a short route that makes forward progress toward the level exit, opening a door when the route requires one and engaging threats when they block the way. Respond with ONLY a single JSON object of the form {\"steps\": [{\"op\": \"move\", \"bearing\": <0-359>, \"distance\": <1-1024>}, {\"op\": \"open-door\", \"bearing\": <0-359>}, {\"op\": \"shoot\", \"tics\": <1-350>}, {\"op\": \"wait\", \"tics\": <1-350>}]} that matches the provided schema - no prose, no markdown, no extra keys. Never request pixels, images, or audio; the structured observation is the only input you need.";

/// Bound on a single model decision, in seconds (the per-decision timeout).
///
/// Mirrors `applications/doom/autoplay::DOOM_AUTOPLAY_DECISION_TIMEOUT_S`; duplicated
/// locally because this application may not import the doom application.
pub const DOOM_AUTOPLAY_DECISION_TIMEOUT_S: u64 = 30;

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

/// Persona/prompt version stamped into the decision trace (Spec #3032 ST-4).
///
/// Bump when [`DOOM_AGENT_SYSTEM_PROMPT`] changes materially, so a dataset record
/// can be correlated with the prompt that produced it.
pub const DOOM_AGENT_PROMPT_VERSION: &str = "1";

/// Env seam: capture the model's raw reply text into the decision trace (the
/// dataset `modelRaw` block). Inert when unset (Spec #3032 ST-4).
pub const DOOM_DATASET_RAW_ENV: &str = "FREDO_DOOM_DATASET_RAW";

/// Env seam: capture the model's hidden reasoning text into the decision trace
/// (the dataset `reasoning` block). Inert when unset; has its OWN opt-in flag
/// (Spec #3032 ST-4).
pub const DOOM_DATASET_REASONING_ENV: &str = "FREDO_DOOM_DATASET_REASONING";

/// Byte bound applied to a captured raw reply before it enters the trace.
pub const DOOM_DATASET_RAW_MAX_BYTES: usize = 8192;

/// Byte bound applied to a captured reasoning text before it enters the trace.
///
/// Mirrors the dataset's `DOOM_DATASET_REASONING_MAX_BYTES` (Spec #3032 ST-1);
/// duplicated because `applications/llm_server` may not import `applications/doom`.
pub const DOOM_DATASET_REASONING_MAX_BYTES: usize = 4096;

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

// ── Model-source metadata + dataset capture gates (Spec #3032 ST-4) ──────────

/// The best-effort model identity for the decision trace: the persisted served
/// `alias` when set, else the model file's stem. `None` when neither is known.
///
/// Pure — the caller reads the persisted settings; this only shapes them.
pub fn model_id_from(model_path: Option<&str>, args_json: Option<&str>) -> Option<String> {
    let alias = args_json
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .and_then(|value| value.get("alias").and_then(Value::as_str).map(str::to_string))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    alias.or_else(|| {
        model_path
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .and_then(|path| {
                Path::new(path)
                    .file_stem()
                    .map(|stem| stem.to_string_lossy().into_owned())
            })
            .filter(|value| !value.is_empty())
    })
}

/// The best-effort server flags for the decision trace: the persisted
/// `--reasoning` mode (else the launch-config default), rendered as
/// `reasoning=<mode>`. Pure.
pub fn server_flags_from(args_json: Option<&str>) -> String {
    let reasoning = args_json
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .and_then(|value| value.get("reasoning").and_then(Value::as_str).map(str::to_string))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| LlamaServerConfig::default().reasoning);
    format!("reasoning={reasoning}")
}

/// Read the dataset capture flags from [`DOOM_DATASET_RAW_ENV`] /
/// [`DOOM_DATASET_REASONING_ENV`]. `1` / `true` (case-insensitive) enables; unset
/// or anything else is inert.
pub fn dataset_capture_flags() -> (bool, bool) {
    (
        env_flag_enabled(DOOM_DATASET_RAW_ENV),
        env_flag_enabled(DOOM_DATASET_REASONING_ENV),
    )
}

/// `true` iff the env var `name` is set to trimmed `1` / `true` (case-insensitive).
fn env_flag_enabled(name: &str) -> bool {
    std::env::var(name)
        .ok()
        .map(|value| {
            let value = value.trim().to_ascii_lowercase();
            value == "1" || value == "true"
        })
        .unwrap_or(false)
}

/// Gate + bound the captured reply/reasoning: each is `None` unless its flag is
/// on, and is UTF-8-safely truncated to its byte bound otherwise.
pub fn gate_decision_capture(
    raw_enabled: bool,
    reasoning_enabled: bool,
    raw_reply: &str,
    reasoning: &str,
) -> (Option<String>, Option<String>) {
    let raw = raw_enabled.then(|| truncate_bytes(raw_reply, DOOM_DATASET_RAW_MAX_BYTES));
    let reason =
        reasoning_enabled.then(|| truncate_bytes(reasoning, DOOM_DATASET_REASONING_MAX_BYTES));
    (raw, reason)
}

/// Build the decision trace for one model decision (pure; no I/O).
///
/// The raw reply and reasoning are attached ONLY when their capture flags are on,
/// and each is bounded. `latency_ms` is left `None` — the driving loop stamps it
/// (the source never reads a clock, R-1 / NFR-5).
pub fn build_decision_trace(
    model_id: Option<String>,
    server_flags: Option<String>,
    raw_reply: &str,
    reasoning: &str,
    raw_enabled: bool,
    reasoning_enabled: bool,
) -> DoomDecisionTrace {
    let (raw, reason) =
        gate_decision_capture(raw_enabled, reasoning_enabled, raw_reply, reasoning);
    DoomDecisionTrace {
        source: "model",
        model_id,
        server_flags,
        prompt_version: Some(DOOM_AGENT_PROMPT_VERSION.to_string()),
        schema_version: DOOM_PLAN_SCHEMA_NAME,
        latency_ms: None,
        raw_reply: raw,
        reasoning: reason,
    }
}

/// Truncate `text` to at most `max` BYTES on a UTF-8 character boundary.
fn truncate_bytes(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut end = max;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_string()
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
/// the per-decision bound).
///
/// Each decision also records a [`DoomDecisionTrace`] for the MOST RECENT decision
/// (Spec #3032 ST-4), exposed through
/// [`DoomDecisionSource::last_decision_trace`] for the loop-side dataset
/// assembler. The request-audit JSONL this source used to append is retired.
pub struct ModelDoomDecisionSource {
    app: AppHandle,
    vocabulary: Value,
    /// The MOST RECENT decision's trace. The `Mutex` guards a short synchronous
    /// read/write — it is NEVER held across an `.await`.
    last_trace: Mutex<Option<DoomDecisionTrace>>,
}

impl ModelDoomDecisionSource {
    /// Build a model-backed source over `app` with the allowed-action `vocabulary`
    /// (the composition root supplies it — no cross-application import).
    pub fn new(app: AppHandle, vocabulary: Value) -> Self {
        Self {
            app,
            vocabulary,
            last_trace: Mutex::new(None),
        }
    }

    /// The best-effort model identity + server flags for the trace, read from the
    /// persisted server settings (an absent setting yields `None` / the config
    /// default). Never fails a decision.
    fn model_metadata(&self) -> (Option<String>, Option<String>) {
        let store = self.app.state::<Arc<SettingsStore>>();
        let model_path = store.cached_get(LLAMA_SERVER_MODEL_PATH_KEY).ok().flatten();
        let args_json = store.cached_get(LLAMA_SERVER_ARGS_KEY).ok().flatten();
        (
            model_id_from(model_path.as_deref(), args_json.as_deref()),
            Some(server_flags_from(args_json.as_deref())),
        )
    }
}

#[async_trait]
impl DoomDecisionSource for ModelDoomDecisionSource {
    async fn decide(&self, observation: &Value) -> Result<DoomPlan, DoomDecisionError> {
        let body = build_doom_agent_request_body(observation, &self.vocabulary);

        let mut content = String::new();
        let mut reasoning = String::new();
        let stream_result = tokio::time::timeout(
            Duration::from_secs(DOOM_AUTOPLAY_DECISION_TIMEOUT_S),
            chat::run_stream(&self.app, &body, |frame| {
                // The reasoning channel is separate from `content` (Spec #3032
                // ST-4); capture it (gated later) without disturbing the plan
                // reply accumulation.
                if let Some(chunk) = frame.reasoning {
                    reasoning.push_str(&chunk);
                }
                for event in frame.events {
                    if let ChatStreamEvent::Delta(delta) = event {
                        content.push_str(&delta);
                    }
                }
                false
            }),
        )
        .await;

        // Record the trace BEFORE returning: the failure paths (R-6) then also
        // carry the model metadata + whatever reply/reasoning was captured.
        let (model_id, server_flags) = self.model_metadata();
        let (raw_enabled, reasoning_enabled) = dataset_capture_flags();
        let trace = build_decision_trace(
            model_id,
            server_flags,
            &content,
            &reasoning,
            raw_enabled,
            reasoning_enabled,
        );
        *self
            .last_trace
            .lock()
            .expect("the Doom decision trace lock is not poisoned") = Some(trace);

        match stream_result {
            Err(_elapsed) => Err(DoomDecisionError::TimedOut),
            Ok(Err(detail)) => Err(DoomDecisionError::ModelUnavailable(detail)),
            // An empty reply is a source-availability condition (R-4), not a
            // malformed decision — `classify_doom_reply` maps it to
            // `ModelUnavailable` so the loop degrades and keeps advancing.
            Ok(Ok(())) => classify_doom_reply(&content),
        }
    }

    fn last_decision_trace(&self) -> Option<DoomDecisionTrace> {
        self.last_trace
            .lock()
            .expect("the Doom decision trace lock is not poisoned")
            .clone()
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

    // ── ST-4: decision-trace contract + dataset capture (Spec #3032) ──────────

    #[test]
    fn dataset_capture_env_seams_are_pinned() {
        assert_eq!(DOOM_DATASET_RAW_ENV, "FREDO_DOOM_DATASET_RAW");
        assert_eq!(DOOM_DATASET_REASONING_ENV, "FREDO_DOOM_DATASET_REASONING");
        assert_eq!(DOOM_DATASET_REASONING_MAX_BYTES, 4096);
        assert_eq!(DOOM_AGENT_PROMPT_VERSION, "1");
    }

    /// **Spec #3032 ST-4 (R-1).** The trace carries the model metadata, the
    /// prompt/schema versions, and the raw reply — and leaves `latency_ms` for the
    /// driving loop.
    #[test]
    fn build_decision_trace_carries_the_model_metadata() {
        let trace = build_decision_trace(
            Some("Gemma-4-E2B".to_string()),
            Some("reasoning=on".to_string()),
            "{}",
            "hidden chain",
            true,
            true,
        );
        assert_eq!(trace.source, "model");
        assert_eq!(trace.model_id.as_deref(), Some("Gemma-4-E2B"));
        assert_eq!(trace.server_flags.as_deref(), Some("reasoning=on"));
        assert_eq!(trace.prompt_version.as_deref(), Some("1"));
        assert_eq!(trace.schema_version, DOOM_PLAN_SCHEMA_NAME);
        assert!(
            trace.latency_ms.is_none(),
            "the loop stamps latency, not the source"
        );
        assert_eq!(trace.raw_reply.as_deref(), Some("{}"));
        assert_eq!(trace.reasoning.as_deref(), Some("hidden chain"));
    }

    /// **Spec #3032 ST-4 (NFR-4).** `modelRaw` / `reasoning` are captured ONLY
    /// under their OWN flags; each is inert when its flag is off.
    #[test]
    fn capture_is_inert_unless_its_own_flag_is_on() {
        let (raw, reasoning) = gate_decision_capture(false, false, "reply", "why");
        assert!(raw.is_none(), "modelRaw off => absent");
        assert!(reasoning.is_none(), "reasoning off => absent");

        let (raw, reasoning) = gate_decision_capture(true, false, "reply", "why");
        assert_eq!(raw.as_deref(), Some("reply"));
        assert!(reasoning.is_none(), "reasoning has its OWN flag");

        let (raw, reasoning) = gate_decision_capture(false, true, "reply", "why");
        assert!(raw.is_none(), "modelRaw has its OWN flag");
        assert_eq!(reasoning.as_deref(), Some("why"));
    }

    /// **Spec #3032 ST-4 (NFR-1/NFR-4).** A captured reply/reasoning is bounded to
    /// its byte bound and truncated UTF-8-safely (no split character).
    #[test]
    fn capture_is_bounded_and_utf8_safe() {
        let big = "a".repeat(DOOM_DATASET_REASONING_MAX_BYTES + 100);
        let (_, reasoning) = gate_decision_capture(false, true, "", &big);
        assert_eq!(
            reasoning.as_deref().map(str::len),
            Some(DOOM_DATASET_REASONING_MAX_BYTES),
            "reasoning is truncated to the byte bound"
        );

        // A multi-byte character straddling the raw bound is not split.
        let mut text = "é".repeat(DOOM_DATASET_RAW_MAX_BYTES);
        text.push('x');
        let (raw, _) = gate_decision_capture(true, false, &text, "");
        let raw = raw.expect("raw captured");
        assert!(raw.len() <= DOOM_DATASET_RAW_MAX_BYTES);
        assert!(raw.is_char_boundary(raw.len()));
        assert!(raw.chars().all(|character| character == 'é'));
    }

    /// **Spec #3032 ST-4.** The model identity prefers the served alias and falls
    /// back to the model file stem; the server flags render the reasoning mode.
    #[test]
    fn model_metadata_prefers_alias_and_falls_back_to_the_file_stem() {
        assert_eq!(
            model_id_from(
                Some(r"C:\models\gemma.gguf"),
                Some(r#"{"alias":"Gemma-4-E2B"}"#)
            )
            .as_deref(),
            Some("Gemma-4-E2B")
        );
        assert_eq!(
            model_id_from(Some(r"C:\models\gemma.gguf"), None).as_deref(),
            Some("gemma")
        );
        assert_eq!(model_id_from(None, None), None);
        assert_eq!(model_id_from(Some("   "), Some("not json")), None);

        assert_eq!(server_flags_from(None), "reasoning=on");
        assert_eq!(
            server_flags_from(Some(r#"{"reasoning":"off"}"#)),
            "reasoning=off"
        );
        assert_eq!(server_flags_from(Some("not json")), "reasoning=on");
    }
}
