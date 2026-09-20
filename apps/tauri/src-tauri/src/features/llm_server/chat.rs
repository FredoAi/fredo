//! Companion chat/vision routing to the managed `llama-server` (Spec #2857, ST-4;
//! EARS R-3, R-4.2).
//!
//! Replaces the deleted in-process transport with the server's OpenAI-compatible
//! streaming API while preserving the frontend contract byte-for-byte:
//!
//! * ensure-healthy (launch if needed) → `POST /v1/chat/completions`
//!   `{ messages, stream: true, max_tokens: 1024 }`,
//! * each SSE `data: {"choices":[{"delta":{"content":"…"}}]}` frame emits
//!   `llm-token` with the delta,
//! * `data: [DONE]` emits `llm-done` (a stream that closes early still emits it —
//!   the UI must never hang),
//! * a connection / non-200 / stream error emits the ADDITIVE `llm-error` line
//!   followed by `llm-done` (R-4 actionable), then stops.
//!
//! Sampling parameters (`--temp` / `--top-p` / `--top-k`) are NOT sent per
//! request — the generated launch config is authoritative (R-1).
//!
//! Vision attaches the image as an `image_url` data URL on the LAST user message
//! (R-3.2). The SSE line/JSON mapping is a pure seam so it is unit-testable
//! without a running server.

use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::infrastructure::companion::skills::SkillRegistry;
use crate::infrastructure::storage::AppStore;

use super::commands::launch_llama_server;
use super::{DEFAULT_LLAMA_SERVER_HOST, LLAMA_SERVER_HOST_KEY};

/// Maximum completion tokens per request (mirrors the legacy in-process cap).
pub const MAX_TOKENS: u32 = 1024;

/// Path of the OpenAI-compatible chat-completions endpoint.
pub const CHAT_COMPLETIONS_PATH: &str = "/v1/chat/completions";

/// Path of the llama.cpp server properties endpoint (`GET /props`).
pub const PROPS_PATH: &str = "/props";

/// Maximum characters of a non-200 body included in the readable error line.
const ERROR_TAIL_CHARS: usize = 400;

// ── Pure URL / host helpers (unit-tested seam) ────────────────────────────────

/// The OpenAI-compatible chat-completions URL for a bound host/port.
pub fn chat_completions_url(host: &str, port: u16) -> String {
    format!("http://{host}:{port}{CHAT_COMPLETIONS_PATH}")
}

/// The llama.cpp `/props` URL for a bound host/port.
pub fn props_url(host: &str, port: u16) -> String {
    format!("http://{host}:{port}{PROPS_PATH}")
}

/// Pure host resolution: a non-blank, trimmed configured value wins; otherwise
/// the product default. Shared by the chat path and the ST-1 probe, so both
/// address the same server.
pub fn resolve_host(configured: Option<&str>) -> String {
    configured
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_LLAMA_SERVER_HOST.to_string())
}

/// A single message in an LLM conversation.
///
/// Wire-compatible with the frontend `LlmMessage` (`{ role, content }`) and the
/// deleted in-process DTO, so the `llm_chat` argument shape is byte-identical.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct LlmMessage {
    pub role: String,
    pub content: String,
}

/// A decoded event from the chat-completions SSE stream.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChatStreamEvent {
    /// A content delta to forward as `llm-token`.
    Delta(String),
    /// One fragment of a model-selected tool call (Spec #2893, ST-5).
    ///
    /// `name` is present only on the opening fragment; `arguments_fragment` is a
    /// RAW piece of the (possibly split) JSON argument string. Callers MUST
    /// buffer the fragments verbatim and JSON-parse ONCE at the finish — never
    /// per chunk (#22722 split escapes; #21375 parallel-call loop). Raw
    /// tool-call text is NEVER forwarded as `llm-token`.
    ToolCallDelta {
        index: usize,
        name: Option<String>,
        arguments_fragment: Option<String>,
    },
    /// The `data: [DONE]` terminator.
    Done,
}

/// Every seam event carried by ONE `data:` payload, plus the chunk's
/// `finish_reason`.
///
/// A single SSE chunk can carry a content delta AND tool-call fragments AND the
/// terminal `finish_reason`, so the skill-aware path consumes the whole frame.
/// `parse_sse_data` remains the legacy single-event view (first event).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ChatSseFrame {
    pub events: Vec<ChatStreamEvent>,
    /// The chunk's `choices[0].finish_reason` when present and non-empty
    /// (`"tool_calls"` / `"stop"` / `"length"`). Read to know the stream ended
    /// on a tool call.
    pub finish_reason: Option<String>,
}

// ── Pure SSE mapping (unit-tested seam) ───────────────────────────────────────

/// Parse the payload of one `data:` SSE line into every event it carries
/// (content / tool-call fragments / `[DONE]`) plus its `finish_reason`.
///
/// Returns an empty frame for a blank payload or a malformed JSON chunk — never
/// a panic and never a spurious `llm-token`.
pub fn parse_sse_frame(payload: &str) -> ChatSseFrame {
    let payload = payload.trim();
    if payload.is_empty() {
        return ChatSseFrame::default();
    }
    if payload == "[DONE]" {
        return ChatSseFrame {
            events: vec![ChatStreamEvent::Done],
            finish_reason: None,
        };
    }

    let Ok(chunk) = serde_json::from_str::<ChatChunk>(payload) else {
        return ChatSseFrame::default();
    };
    let Some(choice) = chunk.choices.into_iter().next() else {
        return ChatSseFrame::default();
    };

    let mut events = Vec::new();
    if let Some(delta) = choice.delta {
        if let Some(content) = delta.content {
            if !content.is_empty() {
                events.push(ChatStreamEvent::Delta(content));
            }
        }
        for call in delta.tool_calls.into_iter().flatten() {
            let (name, arguments_fragment) = match call.function {
                Some(function) => (
                    function.name.filter(|name| !name.is_empty()),
                    function.arguments.filter(|args| !args.is_empty()),
                ),
                None => (None, None),
            };
            if name.is_some() || arguments_fragment.is_some() {
                events.push(ChatStreamEvent::ToolCallDelta {
                    index: call.index.unwrap_or(0),
                    name,
                    arguments_fragment,
                });
            }
        }
    }

    ChatSseFrame {
        events,
        finish_reason: choice.finish_reason.filter(|reason| !reason.is_empty()),
    }
}

/// Parse the payload of one `data:` SSE line into the FIRST event it carries.
///
/// The legacy single-event view of [`parse_sse_frame`]: `None` for a blank
/// payload, a malformed JSON chunk, or a chunk with no content/tool-call event.
/// The shared HTTP/SSE shell streams frames, so this view is test-only.
#[cfg(test)]
pub fn parse_sse_data(payload: &str) -> Option<ChatStreamEvent> {
    parse_sse_frame(payload).events.into_iter().next()
}

/// Parse one complete raw SSE line into its frame. Non-`data:` lines (`event:`,
/// `id:`, `:` comments, blank separators) are ignored.
pub fn parse_sse_frame_line(line: &str) -> Option<ChatSseFrame> {
    let line = line.trim_end_matches(['\r', '\n']);
    let data = line.strip_prefix("data:")?;
    Some(parse_sse_frame(data))
}

/// Parse one complete raw SSE line into the FIRST event it carries.
///
/// The single-event view of [`parse_sse_frame_line`]; test-only because the
/// shared shell streams frames.
#[cfg(test)]
pub fn parse_sse_line(line: &str) -> Option<ChatStreamEvent> {
    parse_sse_frame_line(line).and_then(|frame| frame.events.into_iter().next())
}

/// The OpenAI-compatible chunk envelope, reduced to the fields ST-4/ST-5 consume.
#[derive(Deserialize)]
struct ChatChunk {
    choices: Vec<ChatChoice>,
}

#[derive(Deserialize)]
struct ChatChoice {
    delta: Option<ChatDelta>,
    finish_reason: Option<String>,
}

#[derive(Deserialize)]
struct ChatDelta {
    content: Option<String>,
    tool_calls: Option<Vec<ChatToolCallDelta>>,
}

#[derive(Deserialize)]
struct ChatToolCallDelta {
    index: Option<usize>,
    function: Option<ChatFunctionCallDelta>,
}

#[derive(Deserialize)]
struct ChatFunctionCallDelta {
    name: Option<String>,
    arguments: Option<String>,
}

// ── Request body (pure) ────────────────────────────────────────────────────────

/// The ONE production `input_audio` content part (#2897 ST-3; REQ-5).
///
/// Shape is exact and carries NO transcript text (REQ-3):
/// `{ "type": "input_audio", "input_audio": { "data": "<base64 wav>", "format": "wav" } }`
///
/// `wav` is the only format the capture path produces (`stt_take_audio_clip`
/// always returns a 16 kHz mono 16-bit PCM WAV), so the renderer pins it.
pub const AUDIO_FORMAT: &str = "wav";

/// The single `input_audio` content part carried on a model-audio user turn.
pub fn audio_content_part(audio_base64: &str) -> serde_json::Value {
    serde_json::json!({
        "type": "input_audio",
        "input_audio": { "data": audio_base64, "format": AUDIO_FORMAT },
    })
}

/// Render `LlmMessage`s into the OpenAI wire shape WITHOUT any request options.
///
/// Exactly one of `audio_base64` / `image_base64` may be present:
///
/// * **audio** (#2897 ST-3, REQ-5) — the LAST user message's `content` becomes
///   `[{ "type": "input_audio", "input_audio": { data, format } }]`. Model audio
///   IS the turn's input, so NO transcript text part is ever emitted (REQ-3);
///   the message's string content is deliberately discarded, never rendered.
/// * **image** (R-3.2) — the LAST user message's `content` becomes
///   `[{"type":"text",…},{"type":"image_url",…}]`.
///
/// Every other message keeps its plain string content. Pure and shared by every
/// request builder, so the legacy chat body and the ST-1 probe bodies render
/// identically.
pub fn render_messages(
    messages: &[LlmMessage],
    image_base64: Option<&str>,
    audio_base64: Option<&str>,
) -> Vec<serde_json::Value> {
    let mut rendered: Vec<serde_json::Value> = messages
        .iter()
        .map(|message| {
            serde_json::json!({ "role": message.role, "content": message.content })
        })
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

/// Build the OpenAI-compatible request body.
///
/// `stream: true` and `max_tokens: 1024` are fixed; sampling parameters are the
/// server defaults from the generated config and are deliberately NOT set. When
/// `image_base64` is present, the LAST user message's `content` becomes the
/// multimodal array `[{"type":"text",…},{"type":"image_url",…}]` (R-3.2); every
/// other message keeps its plain string content.
pub fn build_request_body(messages: &[LlmMessage], image_base64: Option<&str>) -> serde_json::Value {
    serde_json::json!({
        "messages": render_messages(messages, image_base64, None),
        "stream": true,
        "max_tokens": MAX_TOKENS,
    })
}

/// Build the OpenAI-compatible body for a model-audio turn (#2897 ST-3; REQ-5).
///
/// The captured clip is attached to the LAST user message as the SINGLE
/// `input_audio` part ([`audio_content_part`]) — no transcript text is fabricated
/// for the turn (REQ-3). `stream: true` / `max_tokens` are identical to every
/// other request body, and sampling stays with the generated launch config.
///
/// This is the ONE audio request builder; the delivery command renders through it
/// (NFR-6) and the ST-0 probe's shape is validated against the same contract.
pub fn build_audio_request_body(
    messages: &[LlmMessage],
    audio_base64: &str,
) -> serde_json::Value {
    serde_json::json!({
        "messages": render_messages(messages, None, Some(audio_base64)),
        "stream": true,
        "max_tokens": MAX_TOKENS,
    })
}

/// Build a streaming body that OFFERS JSON-Schema `tools` to the model
/// (native OpenAI-style tool calling). Pure — the ST-1 probe uses this to test
/// the managed server's `tools` path without changing the legacy chat body.
///
/// `tool_choice` is forwarded verbatim (`"auto"` in the probe);
/// `parallel_tool_calls` is explicit so the documented Gemma4 parallel-call
/// loop hazard is mitigated at the request (spike finding b).
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

/// Build a streaming body constrained to a JSON Schema via `response_format`
/// (the documented fallback mechanism). Pure — the ST-1 probe uses this to test
/// the schema-constrained path.
pub fn build_response_format_request_body(
    messages: &[LlmMessage],
    schema: &serde_json::Value,
) -> serde_json::Value {
    serde_json::json!({
        "messages": render_messages(messages, None, None),
        "stream": true,
        "max_tokens": MAX_TOKENS,
        "response_format": {
            "type": "json_schema",
            "json_schema": { "name": "fredo_probe", "schema": schema },
        },
    })
}

// ── Streaming task entry point ─────────────────────────────────────────────────

/// Kick off a streaming chat on a background task and return immediately.
///
/// Registration lives in `lib.rs` (ST-4); the command itself never blocks, so a
/// slow launch/health wait can never hang the IPC call (R-4.2).
pub fn spawn_chat(app: AppHandle, messages: Vec<LlmMessage>, image_base64: Option<String>) {
    tauri::async_runtime::spawn(async move {
        if let Err(detail) = run_chat(&app, messages, image_base64).await {
            emit_error_and_done(&app, &detail);
        }
    });
}

async fn run_chat(
    app: &AppHandle,
    messages: Vec<LlmMessage>,
    image_base64: Option<String>,
) -> Result<(), String> {
    let port = ensure_healthy(app).await?;
    let host = server_host(app);
    stream_completion(app, &host, port, &messages, image_base64.as_deref()).await
}

/// Kick off a model-audio streaming turn (#2897 ST-3; skill-aware #2903) and
/// return immediately.
///
/// The captured clip ([`build_audio_request_body`]) is attached to the last user
/// message and the turn now OFFERS the shared companion skill registry — the
/// SAME registry offer as the typed path — so a spoken app open/close request is
/// buffered, validated once at the finish, and routed as `llm-skill-call`
/// through the shared terminal plan. Ordinary replies stream on the SAME shipped
/// channels the vision path uses: `llm-token` per delta, `llm-done` at the end,
/// and the ADDITIVE readable `llm-error` line before `llm-done` on any failure
/// (never hangs).
pub fn spawn_audio_chat(app: AppHandle, messages: Vec<LlmMessage>, audio_base64: String) {
    tauri::async_runtime::spawn(async move {
        if let Err(detail) = run_audio_chat(&app, messages, audio_base64).await {
            // The stream died before any accumulated call could be finalized —
            // still settle on the SAME terminal vocabulary (`llm-error` then
            // `llm-done`) so the frontend's `llm-done` handler always fires.
            for event in super::skills::plan_stream_error_events(&detail) {
                super::skills::emit_terminal_event(&app, event);
            }
        }
    });
}

/// Deliver ONE skill-aware model-audio turn through the shared [`run_stream`]
/// shell, so it resolves the managed loopback host exactly like the vision/skill
/// paths and accumulates/validates/emits through the ONE skill terminal plan.
async fn run_audio_chat(
    app: &AppHandle,
    messages: Vec<LlmMessage>,
    audio_base64: String,
) -> Result<(), String> {
    let registry = SkillRegistry::with_app_control();
    let body = super::skills::build_audio_skill_request_body(&messages, &audio_base64, &registry);
    super::skills::run_skill_stream(app, &registry, &body).await
}

/// Ensure a healthy managed server, launching one if needed.
///
/// Reuses the ST-3 `launch_llama_server` command as a plain async function; it is
/// idempotent when a healthy server already exists and ALWAYS resolves within the
/// configured health budget (R-2, R-4.2).
async fn ensure_healthy(app: &AppHandle) -> Result<u16, String> {
    let result = launch_llama_server(app.clone()).await;
    if result.success {
        result.port.ok_or_else(|| {
            "the companion server reported success without an active port.".to_string()
        })
    } else {
        Err(result.error.unwrap_or(result.detail))
    }
}

/// The configured bind host (localhost in the reference deployment).
fn server_host(app: &AppHandle) -> String {
    let configured = app
        .state::<Arc<AppStore>>()
        .get(LLAMA_SERVER_HOST_KEY)
        .ok()
        .flatten();
    resolve_host(configured.as_deref())
}

/// POST a request body and drive `on_frame` for every decoded SSE frame, in
/// order. `on_frame` returns `true` when the stream is complete (stop early).
///
/// This is the ONE HTTP/SSE shell: the legacy chat path and the skill-aware path
/// (ST-5) both stream through it, so the byte-buffered line handling — including
/// a UTF-8 character split across two network chunks — exists exactly once.
async fn stream_chat_frames(
    host: &str,
    port: u16,
    body: &serde_json::Value,
    mut on_frame: impl FnMut(ChatSseFrame) -> bool,
) -> Result<(), String> {
    let endpoint = chat_completions_url(host, port);

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| format!("could not build the chat HTTP client: {e}"))?;

    let response = client
        .post(&endpoint)
        .json(body)
        .send()
        .await
        .map_err(|e| format!("Fredo can't reach the companion server at {endpoint}: {e}"))?;

    let status = response.status();
    if !status.is_success() {
        let detail = response.text().await.unwrap_or_default();
        let tail = truncate(detail.trim(), ERROR_TAIL_CHARS);
        return Err(if tail.is_empty() {
            format!(
                "the companion server returned HTTP {} for {endpoint}",
                status.as_u16()
            )
        } else {
            format!(
                "the companion server returned HTTP {}: {tail}",
                status.as_u16()
            )
        });
    }

    let mut stream = response.bytes_stream();
    let mut buffer: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk =
            chunk.map_err(|e| format!("the companion server stream failed: {e}"))?;
        buffer.extend_from_slice(&chunk);
        for line in drain_complete_lines(&mut buffer) {
            if let Some(frame) = parse_sse_frame_line(&line) {
                if on_frame(frame) {
                    return Ok(());
                }
            }
        }
    }

    // A residual line with no trailing newline, then the closed stream.
    if !buffer.is_empty() {
        let residual = String::from_utf8_lossy(&buffer).into_owned();
        if let Some(frame) = parse_sse_frame_line(&residual) {
            if on_frame(frame) {
                return Ok(());
            }
        }
    }
    Ok(())
}

/// Ensure a healthy managed server, resolve the bound host, then stream `body`
/// through the shared HTTP/SSE shell.
///
/// This is the adapter boundary the ST-5 skill path uses so a mechanism swap
/// (e.g. the documented `response_format` fallback) is contained to the request
/// renderer + frame accumulation in `skills.rs` — the HTTP/SSE handling is never
/// duplicated or scattered.
pub async fn run_stream(
    app: &AppHandle,
    body: &serde_json::Value,
    on_frame: impl FnMut(ChatSseFrame) -> bool,
) -> Result<(), String> {
    let port = ensure_healthy(app).await?;
    let host = server_host(app);
    stream_chat_frames(&host, port, body, on_frame).await
}

/// POST the chat request and stream the SSE frames to the webview.
async fn stream_completion(
    app: &AppHandle,
    host: &str,
    port: u16,
    messages: &[LlmMessage],
    image_base64: Option<&str>,
) -> Result<(), String> {
    let body = build_request_body(messages, image_base64);
    let mut finished = false;
    stream_chat_frames(host, port, &body, |frame| {
        for event in frame.events {
            if apply_event(app, event) {
                finished = true;
                return true;
            }
        }
        false
    })
    .await?;

    // A stream that closed early without `[DONE]` still signals completion so the
    // UI can never hang (R-4.2).
    if !finished {
        let _ = app.emit("llm-done", ());
    }
    Ok(())
}

/// Forward one decoded event; returns `true` when the stream is complete.
fn apply_event(app: &AppHandle, event: ChatStreamEvent) -> bool {
    match event {
        ChatStreamEvent::Delta(delta) => {
            let _ = app.emit("llm-token", delta);
            false
        }
        // Defensive: the legacy chat path offers no tools, so a tool-call chunk
        // is unexpected here. It is dropped — raw tool-call JSON is NEVER
        // forwarded as `llm-token` (ST-5 invariant).
        ChatStreamEvent::ToolCallDelta { .. } => false,
        ChatStreamEvent::Done => {
            let _ = app.emit("llm-done", ());
            true
        }
    }
}

/// Emit the additive readable error line, then completion (never hang, R-4).
fn emit_error_and_done(app: &AppHandle, detail: &str) {
    let _ = app.emit("llm-error", detail.to_string());
    let _ = app.emit("llm-done", ());
}

/// Drain every `\n`-terminated line from `buffer`, leaving the incomplete tail.
///
/// Operates on bytes so a UTF-8 character split across two network chunks is
/// still decoded correctly once its line completes.
fn drain_complete_lines(buffer: &mut Vec<u8>) -> Vec<String> {
    let mut lines = Vec::new();
    let mut consumed = 0;
    while let Some(position) = buffer[consumed..].iter().position(|byte| *byte == b'\n') {
        let end = consumed + position;
        lines.push(String::from_utf8_lossy(&buffer[consumed..end]).into_owned());
        consumed = end + 1;
    }
    if consumed > 0 {
        buffer.drain(..consumed);
    }
    lines
}

/// Head of a string by character count (UTF-8 safe), with an ellipsis marker.
fn truncate(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let mut head: String = text.chars().take(max_chars).collect();
    head.push('…');
    head
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

    #[test]
    fn parse_sse_data_extracts_delta_content() {
        let payload = r#"{"choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}"#;
        assert_eq!(
            parse_sse_data(payload),
            Some(ChatStreamEvent::Delta("Hello".to_string()))
        );
    }

    #[test]
    fn parse_sse_data_recognizes_done() {
        assert_eq!(parse_sse_data("[DONE]"), Some(ChatStreamEvent::Done));
        assert_eq!(parse_sse_data("  [DONE]  "), Some(ChatStreamEvent::Done));
    }

    #[test]
    fn parse_sse_data_ignores_blank_role_only_and_malformed_chunks() {
        assert_eq!(parse_sse_data(""), None);
        assert_eq!(parse_sse_data("   "), None);
        // Opening chunk carries a role but no content.
        assert_eq!(
            parse_sse_data(r#"{"choices":[{"index":0,"delta":{"role":"assistant"}}]}"#),
            None
        );
        // Empty delta content is not a token.
        assert_eq!(
            parse_sse_data(r#"{"choices":[{"index":0,"delta":{"content":""}}]}"#),
            None
        );
        // Malformed JSON is skipped, never a panic.
        assert_eq!(parse_sse_data("{ not json"), None);
    }

    #[test]
    fn parse_sse_line_only_accepts_data_lines() {
        assert_eq!(
            parse_sse_line(r#"data: {"choices":[{"delta":{"content":"x"}}]}"#),
            Some(ChatStreamEvent::Delta("x".to_string()))
        );
        assert_eq!(parse_sse_line("data: [DONE]\r"), Some(ChatStreamEvent::Done));
        assert_eq!(parse_sse_line("event: message"), None);
        assert_eq!(parse_sse_line(": keep-alive comment"), None);
        assert_eq!(parse_sse_line(""), None);
    }

    #[test]
    fn drain_complete_lines_splits_and_keeps_the_partial_tail() {
        let mut buffer = b"data: a\ndata: b\r\ndata: par".to_vec();
        assert_eq!(
            drain_complete_lines(&mut buffer),
            vec!["data: a".to_string(), "data: b\r".to_string()]
        );
        assert_eq!(buffer, b"data: par".to_vec());
    }

    #[test]
    fn drain_complete_lines_preserves_split_multibyte_characters() {
        // "é" is 0xC3 0xA9; the chunk boundary splits it, but line decoding
        // happens after both bytes are buffered.
        let mut buffer = vec![b'x', 0xC3];
        assert!(drain_complete_lines(&mut buffer).is_empty());
        buffer.push(0xA9);
        buffer.push(b'\n');
        assert_eq!(drain_complete_lines(&mut buffer), vec!["xé".to_string()]);
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
        // No per-request sampling overrides — the generated config is authoritative.
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
        assert_eq!(
            last[1]["image_url"]["url"],
            "data:image/png;base64,QUJD"
        );

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

    // ── #2897 ST-3: model-audio delivery (REQ-5; no-transcript REQ-3) ─────────

    /// Validation-style pin for the REQ-3 no-transcript invariant and the exact
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
        // No per-request sampling overrides — the generated config is authoritative.
        assert!(body.get("temperature").is_none());
        assert!(body.get("top_p").is_none());
        assert!(body.get("top_k").is_none());

        let last = &body["messages"][3]["content"];
        assert!(last.is_array(), "last user content must be the audio array");
        assert_eq!(last.as_array().map(Vec::len), Some(1), "exactly the audio part");
        assert_eq!(last[0]["type"], "input_audio");
        assert_eq!(last[0]["input_audio"]["data"], "UklGRg==");
        assert_eq!(last[0]["input_audio"]["format"], AUDIO_FORMAT);
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
        // A text part beside the audio part violates REQ-3.
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

    #[test]
    fn truncate_is_utf8_safe() {
        assert_eq!(truncate("hello", 10), "hello");
        assert_eq!(truncate("héllo world", 5), "héllo…");
    }

    #[test]
    fn resolve_host_prefers_a_non_blank_trimmed_value() {
        assert_eq!(resolve_host(Some("192.168.0.9")), "192.168.0.9");
        assert_eq!(resolve_host(Some("  127.0.0.1  ")), "127.0.0.1");
        assert_eq!(resolve_host(Some("   ")), DEFAULT_LLAMA_SERVER_HOST);
        assert_eq!(resolve_host(None), DEFAULT_LLAMA_SERVER_HOST);
    }

    #[test]
    fn endpoint_urls_target_the_managed_server() {
        assert_eq!(
            chat_completions_url("127.0.0.1", 8080),
            "http://127.0.0.1:8080/v1/chat/completions"
        );
        assert_eq!(props_url("127.0.0.1", 8080), "http://127.0.0.1:8080/props");
    }

    // ── ST-5: tool-call seam (additive) ──────────────────────────────────────

    #[test]
    fn parse_sse_frame_extracts_tool_call_fragments_and_finish_reason() {
        let opener = r#"{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"open_app","arguments":"{\"app\":"}}]},"finish_reason":null}]}"#;
        let frame = parse_sse_frame(opener);
        assert_eq!(
            frame.events,
            vec![ChatStreamEvent::ToolCallDelta {
                index: 0,
                name: Some("open_app".to_string()),
                arguments_fragment: Some("{\"app\":".to_string()),
            }]
        );
        assert_eq!(frame.finish_reason, None);

        // A later fragment carries only more raw argument text.
        let closer = r#"{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"Mission Monitor\"}"}}]},"finish_reason":"tool_calls"}]}"#;
        let frame = parse_sse_frame(closer);
        assert_eq!(
            frame.events,
            vec![ChatStreamEvent::ToolCallDelta {
                index: 0,
                name: None,
                arguments_fragment: Some("\"Mission Monitor\"}".to_string()),
            }]
        );
        assert_eq!(frame.finish_reason.as_deref(), Some("tool_calls"));
    }

    #[test]
    fn parse_sse_frame_collects_a_content_delta_and_finish_reason_from_one_chunk() {
        let payload = r#"{"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}"#;
        let frame = parse_sse_frame(payload);
        assert_eq!(frame.events, vec![ChatStreamEvent::Delta("hi".to_string())]);
        assert_eq!(frame.finish_reason.as_deref(), Some("stop"));
    }

    #[test]
    fn parse_sse_frame_treats_done_blank_and_garbage_as_empty_frames() {
        assert_eq!(parse_sse_frame("  "), ChatSseFrame::default());
        assert_eq!(parse_sse_frame("{ not json"), ChatSseFrame::default());
        assert_eq!(parse_sse_frame(r#"{"choices":[]}"#), ChatSseFrame::default());

        let done = parse_sse_frame("[DONE]");
        assert_eq!(done.events, vec![ChatStreamEvent::Done]);
        assert_eq!(done.finish_reason, None);
    }

    #[test]
    fn parse_sse_frame_line_ignores_non_data_lines() {
        assert_eq!(parse_sse_frame_line("event: message"), None);
        assert_eq!(parse_sse_frame_line(": keep-alive"), None);
        assert!(parse_sse_frame_line(r#"data: {"choices":[{"delta":{"content":"x"}}]}"#).is_some());
        // The legacy single-event view still yields the first event.
        assert_eq!(
            parse_sse_data(r#"{"choices":[{"delta":{"content":"x"}}]}"#),
            Some(ChatStreamEvent::Delta("x".to_string()))
        );
    }
}
