//! The companion **IPC message DTO** (Spec #2857 ST-4; reduced by Spec #3141
//! ST-3, retired to its DTO by ST-6).
//!
//! The transport is GONE: companion inference runs in-process on the engine
//! thread (`engine/`), so there is no loopback POST, no SSE frame, no health
//! wait, and no `llama-server` launch. ST-6 retired the frozen OpenAI wire-shape
//! renderers (`render_messages`, `audio_content_part`, the `build_*` body
//! builders) from production together with the HTTP capability probe that was
//! their last consumer.
//!
//! What remains is the ONE thing that crosses IPC: [`LlmMessage`] — the
//! byte-identical `llm_chat` argument shape (AC-26) — plus [`MAX_TOKENS`], the
//! per-request completion budget the engine's request model carries.
//!
//! The engine's own request model ([`super::engine::request::ChatTurn`]) is the
//! production path; its media rule (audio = one `input_audio` part, image =
//! `text` + `image_url`) lives there and nowhere else (NFR-6).
//!
//! ## The frozen wire shape (TEST ONLY)
//!
//! The payload pins still assert the SHIPPED OpenAI-JSON shape byte-for-byte, so
//! the renderers that describe it are kept under `#[cfg(test)]` — a reference the
//! production code must stay equal to, and not dead production code. They are
//! gated to test builds exactly like `mod.rs`'s retired-key constant.

use serde::{Deserialize, Serialize};

/// Maximum completion tokens per request (mirrors the legacy in-process cap).
pub const MAX_TOKENS: u32 = 1024;

/// A single message in an LLM conversation.
///
/// Wire-compatible with the frontend `LlmMessage` (`{ role, content }`) and the
/// deleted in-process DTO, so the `llm_chat` argument shape is byte-identical.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct LlmMessage {
    pub role: String,
    pub content: String,
}

// ── Frozen wire-shape reference (TEST ONLY) ──────────────────────────────────
//
// The production turn is `ChatTurn` (`engine/request.rs`). These renderers are
// the retired HTTP body's shape, kept so the payload pins and the engine's media
// parity pin can assert the engine still produces it. No production code calls
// them; they are compiled only for tests.

/// The ONE production `input_audio` content part (#2897 ST-3; REQ-5).
///
/// Shape is exact and carries NO transcript text (REQ-3):
/// `{ "type": "input_audio", "input_audio": { "data": "<base64 wav>", "format": "wav" } }`
#[cfg(test)]
pub fn audio_content_part(audio_base64: &str) -> serde_json::Value {
    serde_json::json!({
        "type": "input_audio",
        "input_audio": { "data": audio_base64, "format": "wav" },
    })
}

/// Render `LlmMessage`s into the retired OpenAI wire shape.
///
/// Exactly one of `audio_base64` / `image_base64` may be present:
///
/// * **audio** — the LAST user message's `content` becomes
///   `[{ "type": "input_audio", … }]`; no transcript text part is ever emitted.
/// * **image** — the LAST user message's `content` becomes
///   `[{"type":"text",…},{"type":"image_url",…}]`.
#[cfg(test)]
pub fn render_messages(
    messages: &[LlmMessage],
    image_base64: Option<&str>,
    audio_base64: Option<&str>,
) -> Vec<serde_json::Value> {
    let mut rendered: Vec<serde_json::Value> = messages
        .iter()
        .map(|message| serde_json::json!({ "role": message.role, "content": message.content }))
        .collect();

    if let Some(audio) = audio_base64 {
        if let Some(index) = messages.iter().rposition(|message| message.role == "user") {
            rendered[index] = serde_json::json!({
                "role": messages[index].role,
                "content": [ audio_content_part(audio) ],
            });
        }
        return rendered;
    }

    if let Some(image) = image_base64 {
        if let Some(index) = messages.iter().rposition(|message| message.role == "user") {
            rendered[index] = serde_json::json!({
                "role": messages[index].role,
                "content": [
                    { "type": "text", "text": messages[index].content },
                    {
                        "type": "image_url",
                        "image_url": { "url": format!("data:image/png;base64,{image}") }
                    }
                ],
            });
        }
    }

    rendered
}

/// The retired streaming body that offers JSON-Schema `tools` (test reference).
#[cfg(test)]
pub fn build_tools_request_body(
    messages: &[LlmMessage],
    tools: &serde_json::Value,
    tool_choice: &str,
    parallel_tool_calls: bool,
) -> serde_json::Value {
    serde_json::json!({
        "messages": render_messages(messages, None, None),
        "stream": true,
        "max_tokens": MAX_TOKENS,
        "tools": tools,
        "tool_choice": tool_choice,
        "parallel_tool_calls": parallel_tool_calls,
    })
}

/// The retired streaming body constrained to a JSON Schema via `response_format`
/// (test reference).
#[cfg(test)]
pub fn build_response_format_request_body(
    messages: &[LlmMessage],
    schema_name: &str,
    schema: &serde_json::Value,
) -> serde_json::Value {
    serde_json::json!({
        "messages": render_messages(messages, None, None),
        "stream": true,
        "max_tokens": MAX_TOKENS,
        "response_format": {
            "type": "json_schema",
            "json_schema": { "name": schema_name, "schema": schema },
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text_message(role: &str, content: &str) -> LlmMessage {
        LlmMessage {
            role: role.to_string(),
            content: content.to_string(),
        }
    }

    /// The pure wire-shape view of a text-or-image turn, retained so the payload
    /// pins can assert the shipped shape byte-for-byte.
    fn build_request_body(
        messages: &[LlmMessage],
        image_base64: Option<&str>,
    ) -> serde_json::Value {
        serde_json::json!({
            "messages": render_messages(messages, image_base64, None),
            "stream": true,
            "max_tokens": MAX_TOKENS,
        })
    }

    /// The pure wire-shape view of a model-audio turn: the clip rides the LAST
    /// user message as the SINGLE `input_audio` part and no transcript text is
    /// fabricated.
    fn build_audio_request_body(
        messages: &[LlmMessage],
        audio_base64: &str,
    ) -> serde_json::Value {
        serde_json::json!({
            "messages": render_messages(messages, None, Some(audio_base64)),
            "stream": true,
            "max_tokens": MAX_TOKENS,
        })
    }

    #[test]
    fn the_message_dto_round_trips_its_wire_shape() {
        let message = text_message("user", "hi");
        let json = serde_json::to_value(&message).expect("serialize");
        assert_eq!(json, serde_json::json!({ "role": "user", "content": "hi" }));
        let restored: LlmMessage = serde_json::from_value(json).expect("deserialize");
        assert_eq!(restored, message);
    }

    #[test]
    fn the_token_budget_matches_the_retired_contract() {
        assert_eq!(MAX_TOKENS, 1024);
    }

    #[test]
    fn build_request_body_streams_with_max_tokens() {
        let messages = vec![text_message("system", "be terse"), text_message("user", "hi")];
        let body = build_request_body(&messages, None);

        assert_eq!(body["stream"], true);
        assert_eq!(body["max_tokens"], MAX_TOKENS);
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][0]["content"], "be terse");
        assert_eq!(body["messages"][1]["content"], "hi");
        // No per-request sampling overrides — the engine defaults are authoritative.
        assert!(body.get("temperature").is_none());
        assert!(body.get("top_p").is_none());
        assert!(body.get("top_k").is_none());
    }

    #[test]
    fn build_request_body_attaches_image_to_last_user_message() {
        let messages = vec![
            text_message("system", "be terse"),
            text_message("user", "first"),
            text_message("assistant", "ok"),
            text_message("user", "look at this"),
        ];
        let body = build_request_body(&messages, Some("QUJD"));

        let last = &body["messages"][3]["content"];
        assert!(last.is_array(), "last user content must be the multimodal array");
        assert_eq!(last[0]["type"], "text");
        assert_eq!(last[0]["text"], "look at this");
        assert_eq!(last[1]["type"], "image_url");
        assert_eq!(last[1]["image_url"]["url"], "data:image/png;base64,QUJD");

        // Earlier user/system messages keep their plain string content.
        assert_eq!(body["messages"][0]["content"], "be terse");
        assert_eq!(body["messages"][1]["content"], "first");
    }

    #[test]
    fn build_request_body_without_image_keeps_string_content() {
        let messages = vec![text_message("user", "hello")];
        let body = build_request_body(&messages, None);
        assert_eq!(body["messages"][0]["content"], "hello");
    }

    /// The schema name is a parameter: it is forwarded verbatim and the
    /// schema-constrained body still offers NO tools (it is the fallback
    /// mechanism).
    #[test]
    fn build_response_format_request_body_forwards_the_schema_name() {
        let messages = vec![text_message("user", "hi")];
        let schema = serde_json::json!({
            "type": "object",
            "properties": { "app": { "type": "string" } },
            "required": ["app"],
        });
        let body = build_response_format_request_body(&messages, "fredo_probe", &schema);

        assert_eq!(body["stream"], true);
        assert_eq!(body["max_tokens"], MAX_TOKENS);
        assert_eq!(body["response_format"]["type"], "json_schema");
        assert_eq!(body["response_format"]["json_schema"]["name"], "fredo_probe");
        assert_eq!(body["response_format"]["json_schema"]["schema"], schema);
        assert!(body.get("tools").is_none());
    }

    // ── #2897 ST-3: model-audio delivery (REQ-5; no-transcript REQ-3) ─────────

    /// Validation-style pin for the no-transcript invariant and the exact
    /// `input_audio` shape: the last user message carries EXACTLY one
    /// `input_audio` part (non-empty `data` + `format`) and never a `text` part.
    fn validate_audio_body(body: &serde_json::Value) -> Result<(), String> {
        let messages = body
            .get("messages")
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| "body.messages must be an array".to_string())?;
        let last_user = messages
            .iter()
            .rev()
            .find(|message| message.get("role").and_then(serde_json::Value::as_str) == Some("user"))
            .ok_or_else(|| "body.messages must contain a user message".to_string())?;
        let parts = last_user
            .get("content")
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| "the last user content must be the audio array".to_string())?;
        if parts
            .iter()
            .any(|part| part.get("type").and_then(serde_json::Value::as_str) == Some("text"))
        {
            return Err(
                "the audio turn must not carry a text part (REQ-3 no-transcript)".to_string(),
            );
        }
        if parts.len() != 1 {
            return Err(format!(
                "the audio user turn must carry exactly one content part, got {}",
                parts.len()
            ));
        }
        let part = &parts[0];
        if part.get("type").and_then(serde_json::Value::as_str) != Some("input_audio") {
            return Err("the single content part must be an input_audio part".to_string());
        }
        let audio = part
            .get("input_audio")
            .and_then(serde_json::Value::as_object)
            .ok_or_else(|| "the input_audio part must carry an input_audio object".to_string())?;
        if audio
            .get("data")
            .and_then(serde_json::Value::as_str)
            .map(str::is_empty)
            .unwrap_or(true)
        {
            return Err("the input_audio part must carry a non-empty base64 data string".to_string());
        }
        if audio
            .get("format")
            .and_then(serde_json::Value::as_str)
            .map(str::is_empty)
            .unwrap_or(true)
        {
            return Err("the input_audio part must carry a non-empty format string".to_string());
        }
        Ok(())
    }

    #[test]
    fn build_audio_request_body_attaches_one_input_audio_part_to_the_last_user_message() {
        // The empty user content is the shape the dispatch path sends: the audio
        // IS the turn's input, so no transcript text is fabricated.
        let messages = vec![
            text_message("system", "be terse"),
            text_message("user", "first"),
            text_message("assistant", "ok"),
            text_message("user", ""),
        ];
        let body = build_audio_request_body(&messages, "UklGRg==");

        assert_eq!(body["stream"], true);
        assert_eq!(body["max_tokens"], MAX_TOKENS);
        // No per-request sampling overrides — the engine defaults are authoritative.
        assert!(body.get("temperature").is_none());
        assert!(body.get("top_p").is_none());
        assert!(body.get("top_k").is_none());

        let last = &body["messages"][3]["content"];
        assert!(last.is_array(), "last user content must be the audio array");
        assert_eq!(last.as_array().map(Vec::len), Some(1), "exactly the audio part");
        assert_eq!(last[0]["type"], "input_audio");
        assert_eq!(last[0]["input_audio"]["data"], "UklGRg==");
        assert_eq!(last[0]["input_audio"]["format"], "wav");
        assert_eq!(
            last[0].as_object().map(|part| part.len()),
            Some(2),
            "the part carries only type + input_audio"
        );

        // Earlier messages keep their plain string content.
        assert_eq!(body["messages"][0]["content"], "be terse");
        assert_eq!(body["messages"][1]["content"], "first");
        assert_eq!(body["messages"][2]["content"], "ok");

        // REQ-3: no transcript/text part is fabricated anywhere in the body.
        let serialized = body.to_string();
        assert!(
            !serialized.contains("\"type\":\"text\""),
            "the audio body must not carry a text part: {serialized}"
        );
        assert!(!serialized.contains("\"text\""), "no text key: {serialized}");
        assert!(validate_audio_body(&body).is_ok());
    }

    #[test]
    fn build_audio_request_body_places_the_audio_on_the_last_of_several_user_turns() {
        let messages = vec![
            text_message("user", "old turn"),
            text_message("assistant", "sure"),
            text_message("user", ""),
        ];
        let body = build_audio_request_body(&messages, "QUJD");
        // The FIRST user message is untouched; the LAST carries the audio.
        assert_eq!(body["messages"][0]["content"], "old turn");
        assert_eq!(body["messages"][2]["content"][0]["type"], "input_audio");
        assert_eq!(body["messages"][2]["content"][0]["input_audio"]["data"], "QUJD");
        assert!(validate_audio_body(&body).is_ok());
    }

    #[test]
    fn audio_content_part_is_the_exact_reference_shape() {
        let part = audio_content_part("QUJD");
        assert_eq!(part["type"], "input_audio");
        assert_eq!(part["input_audio"]["data"], "QUJD");
        assert_eq!(part["input_audio"]["format"], "wav");
        assert_eq!(part.as_object().map(|object| object.len()), Some(2));
    }

    #[test]
    fn validate_audio_body_rejects_text_bearing_and_malformed_turns() {
        // A text part beside the audio part violates the no-transcript rule.
        let text_body = serde_json::json!({
            "messages": [{
                "role": "user",
                "content": [
                    { "type": "text", "text": "what did I say?" },
                    audio_content_part("QUJD"),
                ],
            }],
        });
        let error = validate_audio_body(&text_body).expect_err("text part must be rejected");
        assert!(error.contains("no-transcript"), "error: {error}");

        // A plain string user message is not the multimodal shape.
        assert!(validate_audio_body(&serde_json::json!({
            "messages": [{ "role": "user", "content": "hello" }]
        }))
        .is_err());

        // Empty data / empty format are rejected.
        let empty = serde_json::json!({
            "messages": [{ "role": "user", "content": [ audio_content_part("") ] }]
        });
        assert!(validate_audio_body(&empty).is_err());
    }

    #[test]
    fn audio_renderer_leaves_the_text_and_image_bodies_byte_identical() {
        let messages = vec![
            text_message("system", "be terse"),
            text_message("user", "hello"),
        ];

        // The text body has NO audio branch influence (exact literal equality).
        assert_eq!(
            build_request_body(&messages, None),
            serde_json::json!({
                "messages": [
                    { "role": "system", "content": "be terse" },
                    { "role": "user", "content": "hello" },
                ],
                "stream": true,
                "max_tokens": MAX_TOKENS,
            })
        );

        // The image body keeps the shipped `text` + `image_url` array.
        let image_body = build_request_body(&messages, Some("QUJD"));
        assert_eq!(
            image_body,
            serde_json::json!({
                "messages": [
                    { "role": "system", "content": "be terse" },
                    {
                        "role": "user",
                        "content": [
                            { "type": "text", "text": "hello" },
                            {
                                "type": "image_url",
                                "image_url": { "url": "data:image/png;base64,QUJD" },
                            },
                        ],
                    },
                ],
                "stream": true,
                "max_tokens": MAX_TOKENS,
            })
        );
    }
}
