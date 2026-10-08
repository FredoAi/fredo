//! Doom-playing agent persona + schema-constrained request builder + model-backed
//! decision source + bounded request audit (Spec #2969, ST-4; EARS R-2).
//!
//! This module gives the out-of-process companion a distinct Doom-playing persona
//! and a request contract that carries **structured game state only**:
//!
//! * [`DOOM_AGENT_SYSTEM_PROMPT`] is the persona (forward progress, engage blocking
//!   threats, respond with ONLY the `{tics, actions}` JSON, never request pixels or
//!   audio);
//! * [`build_doom_agent_request_body`] renders a schema-constrained
//!   (`response_format: json_schema`, name [`DOOM_ACTION_SCHEMA_NAME`]) request via
//!   `chat::render_messages(..., None, None)`, so **no `image_url`/`input_audio`
//!   part can appear** (the F-25 audit surface);
//! * [`ModelDoomDecisionSource`] implements the shared
//!   [`DoomDecisionSource`](crate::infrastructure::companion::doom_decision::DoomDecisionSource)
//!   trait over the existing `chat::run_stream` shell, with a bounded per-decision
//!   timeout ([`DOOM_AUTOPLAY_DECISION_TIMEOUT_S`]), accumulating the structured
//!   `delta.content` and parsing a `DoomDecision`;
//! * every request appends ONE compact audit record to a bounded JSONL (last
//!   [`DOOM_AGENT_AUDIT_MAX_RECORDS`]) under `FREDO_DOOM_AGENT_LOG_DIR` — the live
//!   AC2 receipt.
//!
//! # Cross-application boundary
//!
//! The action vocabulary is a **parameter** of [`build_doom_agent_request_body`]
//! and [`ModelDoomDecisionSource::new`] — this module never imports
//! `applications/doom` (cross-application imports are forbidden, `AGENTS.md`). The
//! composition root (`lib.rs`, ST-5) passes `applications/doom/actions::action_vocabulary_json()`.
//! `FREDO_DOOM_AGENT_LOG_DIR` is read directly via `std::env::var` here (an env
//! var is not a cross-application import).

use std::path::{Path, PathBuf};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::infrastructure::companion::doom_decision::{
    DoomDecision, DoomDecisionError, DoomDecisionSource,
};

use super::chat::{self, ChatStreamEvent, LlmMessage};

/// The Doom-playing persona.
///
/// It states: you are Fredo's Doom-playing agent; you receive the engine's
/// structured observation and the allowed action objects; choose actions that make
/// forward progress toward the level exit, engage threats when they block the
/// route, and respond with ONLY the `{tics, actions}` JSON object matching the
/// schema; never request pixels or audio.
pub const DOOM_AGENT_SYSTEM_PROMPT: &str = "You are Fredo's Doom-playing agent. On each turn you receive the engine's structured observation of the game state and the list of allowed action objects. Choose actions that make forward progress toward the level exit, and engage threats when they block the route. Respond with ONLY a single JSON object of the form {\"tics\": <integer 1-350>, \"actions\": [<allowed action objects>]} that matches the provided schema - no prose, no markdown, no extra keys. Never request pixels, images, or audio; the structured observation is the only input you need.";

/// The `response_format.json_schema.name` of the Doom decision contract.
pub const DOOM_ACTION_SCHEMA_NAME: &str = "doom_action";

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

/// File name of the bounded request-audit JSONL inside the log directory.
pub const DOOM_AGENT_AUDIT_FILE: &str = "doom-agent-requests.jsonl";

// ── Pure request contract ─────────────────────────────────────────────────────

/// The `doom_action` response schema: `{tics: integer 1..350, actions: array}`.
pub fn doom_action_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "tics": { "type": "integer", "minimum": 1, "maximum": 350 },
            "actions": { "type": "array", "items": { "type": "object" } }
        },
        "required": ["tics", "actions"],
        "additionalProperties": false
    })
}

/// Build the schema-constrained Doom decision request body.
///
/// Pure. The system message is [`DOOM_AGENT_SYSTEM_PROMPT`]; the user message is a
/// plain STRING carrying `{"observation": <state JSON>, "allowedActions":
/// [<vocabulary>]}`. Rendered through `chat::build_response_format_request_body`
/// (which uses `chat::render_messages(..., None, None)`), so no `image_url`/
/// `input_audio` part and no image/audio field can appear (R-2).
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
    chat::build_response_format_request_body(
        &messages,
        DOOM_ACTION_SCHEMA_NAME,
        &doom_action_schema(),
    )
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

/// Parse an accumulated model reply into a [`DoomDecision`].
///
/// `Malformed` on any non-object / missing / wrong-typed field; the `tics` range
/// is deliberately NOT checked here — the loop (ST-3) validates it.
pub fn parse_doom_decision(content: &str) -> Result<DoomDecision, DoomDecisionError> {
    let value: Value = serde_json::from_str(content.trim()).map_err(|error| {
        DoomDecisionError::Malformed(format!("model reply is not valid JSON: {error}"))
    })?;
    let object = value.as_object().ok_or_else(|| {
        DoomDecisionError::Malformed("model reply is not a JSON object".to_string())
    })?;
    let tics = object.get("tics").and_then(Value::as_i64).ok_or_else(|| {
        DoomDecisionError::Malformed("model reply is missing an integer `tics`".to_string())
    })?;
    let actions = object
        .get("actions")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| {
            DoomDecisionError::Malformed("model reply is missing an `actions` array".to_string())
        })?;
    Ok(DoomDecision { tics, actions })
}

// ── Model-backed decision source ──────────────────────────────────────────────

/// A [`DoomDecisionSource`] backed by the managed companion model.
///
/// Built over the existing `chat::run_stream` shell: it renders
/// [`build_doom_agent_request_body`], accumulates the structured `delta.content`
/// within [`DOOM_AUTOPLAY_DECISION_TIMEOUT_S`], and parses a [`DoomDecision`]
/// (`Malformed` on parse failure, `ModelUnavailable` on a stream/transport error,
/// `TimedOut` on the per-decision bound). Each request appends one audit record
/// (best-effort) when [`DOOM_AGENT_LOG_DIR_ENV`] names a directory.
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
    async fn decide(&self, observation: &Value) -> Result<DoomDecision, DoomDecisionError> {
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
            Ok(Ok(())) => parse_doom_decision(&content),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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

        // The response_format is the schema-constrained `doom_action`.
        assert_eq!(body["stream"], true);
        assert_eq!(body["max_tokens"], 1024);
        assert_eq!(body["response_format"]["type"], "json_schema");
        assert_eq!(
            body["response_format"]["json_schema"]["name"],
            DOOM_ACTION_SCHEMA_NAME
        );
        let schema = &body["response_format"]["json_schema"]["schema"];
        assert_eq!(schema["properties"]["tics"]["type"], "integer");
        assert_eq!(schema["properties"]["tics"]["minimum"], 1);
        assert_eq!(schema["properties"]["tics"]["maximum"], 350);
        assert_eq!(schema["properties"]["actions"]["type"], "array");
        assert_eq!(schema["properties"]["actions"]["items"]["type"], "object");
        assert_eq!(schema["required"], json!(["tics", "actions"]));
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

    #[test]
    fn schema_name_and_persona_are_pinned() {
        assert_eq!(DOOM_ACTION_SCHEMA_NAME, "doom_action");
        assert_eq!(DOOM_AUTOPLAY_DECISION_TIMEOUT_S, 30);
        assert!(DOOM_AGENT_SYSTEM_PROMPT.contains("Doom"));
        assert!(DOOM_AGENT_SYSTEM_PROMPT.contains("tics"));
        assert!(DOOM_AGENT_SYSTEM_PROMPT.contains("actions"));
        assert!(DOOM_AGENT_SYSTEM_PROMPT.contains("pixels"));
        assert!(DOOM_AGENT_SYSTEM_PROMPT.contains("audio"));
    }

    #[test]
    fn parse_doom_decision_accepts_a_valid_object() {
        let decision = parse_doom_decision(r#"{ "tics": 5, "actions": [{ "type": "forward" }] }"#)
            .expect("valid decision");
        assert_eq!(decision.tics, 5);
        assert_eq!(decision.actions, vec![json!({ "type": "forward" })]);
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
        assert!(matches!(
            parse_doom_decision(r#"{ "actions": [] }"#),
            Err(DoomDecisionError::Malformed(_))
        ));
        assert!(matches!(
            parse_doom_decision(r#"{ "tics": 1 }"#),
            Err(DoomDecisionError::Malformed(_))
        ));
        // A non-integer `tics` is malformed.
        assert!(matches!(
            parse_doom_decision(r#"{ "tics": 1.5, "actions": [] }"#),
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
