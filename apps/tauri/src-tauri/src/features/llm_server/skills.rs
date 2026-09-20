//! Skill-aware inference path (Spec #2893, ST-5; EARS R-3.1–R-3.5).
//!
//! Offers the ST-3 companion skill registry to the managed inference path and
//! turns a model-selected tool call into a validated `llm-skill-call` event —
//! while ordinary chat stays token-for-token unchanged:
//!
//! * the request renders the registry into OpenAI-style `tools` +
//!   `tool_choice: "auto"` + `parallel_tool_calls: false` (the documented Gemma4
//!   parallel-call loop mitigation);
//! * the pure SSE seam (`chat::parse_sse_frame`) buffers tool-call argument
//!   fragments VERBATIM and JSON-parses them **exactly once** at the finish
//!   (#22722 split escapes), then validates the selection through ST-3's
//!   [`validate`] BEFORE anything is emitted or executed (fail closed);
//! * a validated selection emits `llm-skill-call`; a rejected one emits a
//!   readable `llm-error`; `llm-done` is emitted on every path (never hang).
//!
//! Non-goals / regression invariants:
//! - `llm_chat` / `llm_chat_with_image` are byte-identical (joke, TicTacToe,
//!   vision untouched); this module never touches the legacy request/response.
//! - Raw tool-call JSON is NEVER forwarded as `llm-token`.
//! - No window or CLI work here (execution is bound by the caller).
//!
//! Mechanism contingency: the native `tools` request is the primary path. The
//! request renderer (`render_tools` / `build_skill_request_body`) and the frame
//! accumulation (`ToolCallAccumulator`) are the only places a documented
//! `response_format` fallback would change — the HTTP/SSE handling lives once in
//! `chat::run_stream`.

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::infrastructure::companion::skills::{validate, SkillRegistry};

use super::chat::{self, ChatSseFrame, ChatStreamEvent, LlmMessage};

/// `tool_choice` sent with the registry offer — the model decides when to call.
pub const TOOL_CHOICE_AUTO: &str = "auto";

/// `parallel_tool_calls` sent with the registry offer. Explicitly false so the
/// documented Gemma4 parallel-call loop hazard is mitigated at the request
/// (spike finding b).
pub const PARALLEL_TOOL_CALLS: bool = false;

/// Render the registry into the OpenAI-compatible `tools` array.
///
/// The registry is the SINGLE source of the schema: each skill's declared
/// `parameters` is forwarded verbatim. There is deliberately no second copy of
/// the `open_app` schema here (ST-3 owns the declaration).
pub fn render_tools(registry: &SkillRegistry) -> Value {
    let tools: Vec<Value> = registry
        .list()
        .map(|skill| {
            serde_json::json!({
                "type": "function",
                "function": {
                    "name": skill.name,
                    "description": skill.description,
                    "parameters": skill.parameters,
                }
            })
        })
        .collect();
    Value::Array(tools)
}

/// Build the skill-aware streaming request body.
///
/// Identical to the legacy body (`messages` / `stream` / `max_tokens`) plus the
/// registry `tools`, `tool_choice: "auto"` and `parallel_tool_calls: false`.
/// Reuses the pure ST-1/ST-4 builder so the rendering lives in one place.
pub fn build_skill_request_body(messages: &[LlmMessage], registry: &SkillRegistry) -> Value {
    chat::build_tools_request_body(
        messages,
        &render_tools(registry),
        TOOL_CHOICE_AUTO,
        PARALLEL_TOOL_CALLS,
    )
}

/// Build the skill-aware streaming request body for a model-audio turn
/// (Spec #2903).
///
/// The captured clip is attached by the ONE audio renderer
/// ([`chat::build_audio_request_body`]) — exactly ONE `input_audio` part on the
/// LAST user message and never a `text` part (#2897 REQ-3) — and the SAME
/// registry offer as the typed path ([`build_skill_request_body`]) is layered on
/// top: `tools` from [`render_tools`], `tool_choice: "auto"` and
/// `parallel_tool_calls: false`. The two bodies are therefore identical except
/// the last user message's `content`, and there is no second copy of any schema.
pub fn build_audio_skill_request_body(
    messages: &[LlmMessage],
    audio_base64: &str,
    registry: &SkillRegistry,
) -> Value {
    let mut body = chat::build_audio_request_body(messages, audio_base64);
    body["tools"] = render_tools(registry);
    body["tool_choice"] = Value::String(TOOL_CHOICE_AUTO.to_string());
    body["parallel_tool_calls"] = Value::Bool(PARALLEL_TOOL_CALLS);
    body
}

/// The `llm-skill-call` payload: a VALIDATED selection, e.g.
/// `{"skill":"open_app","arguments":{"app":"Mission Monitor"}}`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillCall {
    pub skill: String,
    pub arguments: Value,
}

/// One buffered tool call assembled from the SSE fragments.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
struct PartialToolCall {
    name: Option<String>,
    /// Raw argument fragments, concatenated verbatim. Never parsed per chunk.
    raw_arguments: String,
}

/// A finalized raw tool call: the (possibly absent) name and the argument JSON
/// parsed exactly once, or the parse failure detail.
#[derive(Debug, Clone, PartialEq)]
pub struct RawSkillCall {
    pub index: usize,
    pub name: Option<String>,
    pub arguments: RawSkillCallArguments,
}

/// The outcome of the single JSON parse of a buffered tool call.
#[derive(Debug, Clone, PartialEq)]
pub enum RawSkillCallArguments {
    Parsed(Value),
    Malformed(String),
}

/// A defensive accumulator for streaming tool-call fragments.
///
/// Fragments are buffered RAW per index; [`finalize`](Self::finalize) performs
/// the ONLY JSON parse, at the finish. This is what survives a JSON escape or
/// token split across two chunks (#22722) and never loops per chunk (#21375).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ToolCallAccumulator {
    calls: BTreeMap<usize, PartialToolCall>,
    finish_reason: Option<String>,
}

impl ToolCallAccumulator {
    /// An empty accumulator.
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed one decoded seam event.
    ///
    /// Returns the content delta to forward as `llm-token` (`None` for a buffered
    /// tool-call fragment or the terminator — raw tool-call text is never a
    /// token).
    pub fn push(&mut self, event: ChatStreamEvent) -> Option<String> {
        match event {
            ChatStreamEvent::Delta(content) => Some(content),
            ChatStreamEvent::ToolCallDelta {
                index,
                name,
                arguments_fragment,
            } => {
                let call = self.calls.entry(index).or_default();
                if let Some(name) = name {
                    if !name.is_empty() {
                        call.name = Some(name);
                    }
                }
                if let Some(fragment) = arguments_fragment {
                    call.raw_arguments.push_str(&fragment);
                }
                None
            }
            ChatStreamEvent::Done => None,
        }
    }

    /// Record the chunk's terminal `finish_reason` (blank values are ignored).
    pub fn set_finish_reason(&mut self, reason: impl Into<String>) {
        let reason = reason.into();
        if !reason.trim().is_empty() {
            self.finish_reason = Some(reason);
        }
    }

    /// The recorded `finish_reason`, when the stream reported one
    /// (observability seam; `ended_on_tool_call` is the production read).
    #[cfg(test)]
    pub fn finish_reason(&self) -> Option<&str> {
        self.finish_reason.as_deref()
    }

    /// Whether the stream ended on a tool-call turn (`finish_reason ==
    /// "tool_calls"`). Read to know a tool-call turn happened even when no
    /// fragment arrived.
    pub fn ended_on_tool_call(&self) -> bool {
        self.finish_reason.as_deref() == Some("tool_calls")
    }

    /// Whether any tool-call fragment was buffered (test observability).
    #[cfg(test)]
    pub fn has_tool_calls(&self) -> bool {
        !self.calls.is_empty()
    }

    /// The number of distinct buffered tool calls (test observability).
    #[cfg(test)]
    pub fn tool_call_count(&self) -> usize {
        self.calls.len()
    }

    /// The buffered RAW argument text for an index (test observability).
    #[cfg(test)]
    pub fn raw_arguments(&self, index: usize) -> Option<&str> {
        self.calls.get(&index).map(|call| call.raw_arguments.as_str())
    }

    /// Finalize: JSON-parse each buffered call EXACTLY ONCE, in index order.
    ///
    /// Must only be called at the finish — never per chunk.
    pub fn finalize(&self) -> Vec<RawSkillCall> {
        self.calls
            .iter()
            .map(|(index, partial)| {
                let arguments = if partial.raw_arguments.trim().is_empty() {
                    RawSkillCallArguments::Malformed("no arguments were received".to_string())
                } else {
                    match serde_json::from_str::<Value>(&partial.raw_arguments) {
                        Ok(arguments) => RawSkillCallArguments::Parsed(arguments),
                        Err(error) => RawSkillCallArguments::Malformed(error.to_string()),
                    }
                };
                RawSkillCall {
                    index: *index,
                    name: partial.name.clone(),
                    arguments,
                }
            })
            .collect()
    }
}

/// A terminal (post-stream) `llm-*` event the skill path emits.
#[derive(Debug, Clone, PartialEq)]
pub enum TerminalEvent {
    /// A validated selection → `llm-skill-call`.
    SkillCall(SkillCall),
    /// A fail-closed selection → readable `llm-error` (nothing executed).
    Error(String),
    /// `llm-done` — emitted on EVERY path.
    Done,
}

/// The recorded reason a tool-call turn produced no usable call.
const NO_NAME_DETAIL: &str =
    "the model selected a tool call without a name; nothing was executed.";
const TOOL_CALL_TURN_WITHOUT_CALL_DETAIL: &str =
    "the model ended on a tool call but no tool call was received; nothing was executed.";

/// Resolve the accumulated stream into the terminal events to emit.
///
/// Fail-closed (R-3.3/R-3.4): an unknown skill name, malformed argument JSON, a
/// missing/empty declared argument, or a tool-call turn with no call emits a
/// readable `llm-error` and NEVER an `llm-skill-call`. `llm-done` is always the
/// last event. An ordinary content turn yields just `Done`.
pub fn plan_terminal_events(
    registry: &SkillRegistry,
    accumulator: &ToolCallAccumulator,
) -> Vec<TerminalEvent> {
    let mut events = Vec::new();

    for call in accumulator.finalize() {
        match call.name {
            None => events.push(TerminalEvent::Error(NO_NAME_DETAIL.to_string())),
            Some(name) => match call.arguments {
                RawSkillCallArguments::Malformed(detail) => {
                    events.push(TerminalEvent::Error(format!(
                        "the model's skill request could not be read ({detail}); nothing was executed."
                    )));
                }
                RawSkillCallArguments::Parsed(arguments) => match validate(registry, &name, &arguments)
                {
                    Ok(invocation) => events.push(TerminalEvent::SkillCall(SkillCall {
                        skill: invocation.skill,
                        arguments: invocation.arguments,
                    })),
                    Err(error) => events.push(TerminalEvent::Error(format!(
                        "the companion could not run the requested skill: {error}"
                    ))),
                },
            },
        }
    }

    // A tool-call turn that produced no call must still settle with a reason.
    if events.is_empty() && accumulator.ended_on_tool_call() {
        events.push(TerminalEvent::Error(TOOL_CALL_TURN_WITHOUT_CALL_DETAIL.to_string()));
    }

    // ALWAYS complete — never hang (R-3.4 / ST-9).
    events.push(TerminalEvent::Done);
    events
}

/// The terminal events for a failed skill-aware stream (transport / launch /
/// non-200): a readable `llm-error` followed by `llm-done`.
///
/// The stream died before any accumulated call could be finalized, so there is
/// no plan to run — but a failed generation MUST still settle (R-1.4): a
/// `llm-done` is always the last event. Pure so the never-hang guarantee is
/// pinned without a live `AppHandle`.
pub fn plan_stream_error_events(detail: &str) -> Vec<TerminalEvent> {
    vec![
        TerminalEvent::Error(detail.to_string()),
        TerminalEvent::Done,
    ]
}

/// Kick off a skill-aware streaming chat on a background task and return
/// immediately (never blocks the IPC call).
pub fn spawn_chat_with_skills(app: AppHandle, messages: Vec<LlmMessage>) {
    tauri::async_runtime::spawn(async move {
        if let Err(detail) = run_skill_chat(&app, messages).await {
            // The transport failed before any accumulated call existed — still
            // settle on the SAME terminal vocabulary so the frontend's `llm-done`
            // handler always fires (ST-9 / R-1.4: never hang, whatever the
            // failure). HTTP / connection / launch failure all land here.
            for event in plan_stream_error_events(&detail) {
                emit_terminal_event(&app, event);
            }
        }
    });
}

/// Emit one terminal event on its wire channel (`llm-skill-call` / `llm-error` /
/// `llm-done`).
///
/// The ONE terminal-emit site, shared by the normal plan and the stream-failure
/// path — so no backend branch can emit a `Done`-less terminal sequence. Shared
/// with the model-audio path (#2903) via `chat::run_audio_chat`.
pub(crate) fn emit_terminal_event(app: &AppHandle, event: TerminalEvent) {
    match event {
        TerminalEvent::SkillCall(call) => {
            let _ = app.emit("llm-skill-call", call);
        }
        TerminalEvent::Error(detail) => {
            let _ = app.emit("llm-error", detail);
        }
        TerminalEvent::Done => {
            let _ = app.emit("llm-done", ());
        }
    }
}

/// Drive ONE skill-aware generation body through the shared HTTP/SSE shell:
/// content deltas → `llm-token`; tool-call fragments buffered VERBATIM; at the
/// finish the selection is validated and routed through the terminal plan
/// (`llm-skill-call` / readable `llm-error` / always a trailing `llm-done`).
///
/// The ONE accumulate/validate/emit loop, shared by the typed path
/// ([`run_skill_chat`]) and the model-audio path (`chat::run_audio_chat`,
/// #2903), so both routes settle on the SAME vocabulary and raw tool-call JSON
/// is never forwarded as a token.
pub(crate) async fn run_skill_stream(
    app: &AppHandle,
    registry: &SkillRegistry,
    body: &Value,
) -> Result<(), String> {
    let mut accumulator = ToolCallAccumulator::new();
    chat::run_stream(app, body, |frame: ChatSseFrame| {
        for event in frame.events {
            if let Some(delta) = accumulator.push(event) {
                let _ = app.emit("llm-token", delta);
            }
        }
        if let Some(reason) = frame.finish_reason {
            accumulator.set_finish_reason(reason);
        }
        // Never stop early: always reach the finalize/emit phase.
        false
    })
    .await?;

    for event in plan_terminal_events(registry, &accumulator) {
        emit_terminal_event(app, event);
    }
    Ok(())
}

/// Stream one skill-aware generation: content deltas → `llm-token`; tool-call
/// fragments buffered; at the finish the selection is validated and routed.
async fn run_skill_chat(app: &AppHandle, messages: Vec<LlmMessage>) -> Result<(), String> {
    let registry = SkillRegistry::with_app_control();
    let body = build_skill_request_body(&messages, &registry);
    run_skill_stream(app, &registry, &body).await
}

/// Stream a companion chat with the companion skill registry offered to the
/// model (Spec #2893, ST-5).
///
/// Additive to `llm_chat` / `llm_chat_with_image`, which stay byte-identical.
#[tauri::command]
pub fn llm_chat_with_skills(messages: Vec<LlmMessage>, app: AppHandle) -> Result<(), String> {
    spawn_chat_with_skills(app, messages);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::companion::skills::{CLOSE_APP_ARGUMENT, OPEN_APP_ARGUMENT};
    use serde_json::json;

    fn messages() -> Vec<LlmMessage> {
        vec![
            LlmMessage {
                role: "system".to_string(),
                content: "be terse".to_string(),
            },
            LlmMessage {
                role: "user".to_string(),
                content: "open Mission Monitor".to_string(),
            },
        ]
    }

    fn fragment(index: usize, name: Option<&str>, arguments: Option<&str>) -> ChatStreamEvent {
        ChatStreamEvent::ToolCallDelta {
            index,
            name: name.map(str::to_string),
            arguments_fragment: arguments.map(str::to_string),
        }
    }

    // ── R-3.1/R-3.2: the registry is offered to the inference path ────────────

    #[test]
    fn build_skill_request_body_offers_the_registry_tools_and_flags() {
        let registry = SkillRegistry::with_open_app();
        let body = build_skill_request_body(&messages(), &registry);

        // The legacy shape is preserved and extended, never replaced.
        assert_eq!(body["stream"], true);
        assert_eq!(body["max_tokens"], 1024);
        assert_eq!(body["messages"][1]["content"], "open Mission Monitor");

        assert_eq!(body["tool_choice"], TOOL_CHOICE_AUTO);
        assert_eq!(body["tool_choice"], "auto");
        assert_eq!(body["parallel_tool_calls"], PARALLEL_TOOL_CALLS);
        assert_eq!(body["parallel_tool_calls"], false);

        assert_eq!(body["tools"][0]["type"], "function");
        assert_eq!(body["tools"][0]["function"]["name"], "open_app");
        assert_eq!(
            body["tools"][0]["function"]["description"],
            registry.get("open_app").expect("registered").description
        );
        // The registry is the SINGLE source of the schema.
        assert_eq!(
            body["tools"][0]["function"]["parameters"],
            registry.get("open_app").expect("registered").parameters
        );
        assert_eq!(body["tools"][0]["function"]["parameters"]["required"][0], "app");
    }

    #[test]
    fn render_tools_forwards_every_declared_skill_verbatim_in_order() {
        let mut registry = SkillRegistry::new();
        registry
            .register(crate::infrastructure::companion::skills::CompanionSkill::new(
                "first",
                "the first skill",
                json!({ "type": "object", "properties": { "a": { "type": "string" } } }),
            ))
            .register(crate::infrastructure::companion::skills::CompanionSkill::new(
                "second",
                "the second skill",
                json!({ "type": "object", "properties": { "b": { "type": "number" } } }),
            ));

        let tools = render_tools(&registry);
        let tools = tools.as_array().expect("array");
        assert_eq!(tools.len(), 2);
        assert_eq!(tools[0]["function"]["name"], "first");
        assert_eq!(tools[1]["function"]["name"], "second");
        assert_eq!(tools[0]["function"]["parameters"]["properties"]["a"]["type"], "string");
        assert_eq!(tools[1]["function"]["parameters"]["properties"]["b"]["type"], "number");
    }

    #[test]
    fn build_skill_request_body_with_an_empty_registry_offers_no_tools() {
        let registry = SkillRegistry::new();
        let body = build_skill_request_body(&messages(), &registry);
        assert_eq!(body["tools"], json!([]));
        // No second copy of the open_app schema leaks in when it is not declared.
        assert!(body["tools"].as_array().expect("array").is_empty());
    }

    // ── The defensive accumulator (raw buffer, parse once at finish) ──────────

    #[test]
    fn accumulator_buffers_split_fragments_raw_and_parses_once_at_finish() {
        let mut accumulator = ToolCallAccumulator::new();

        accumulator.push(fragment(0, Some("open_app"), Some("{\"app\":\"Miss")));
        // The first fragment is NOT valid JSON on its own — a per-chunk parse
        // would have failed here (#22722). Nothing is parsed until finish.
        assert!(serde_json::from_str::<Value>("{\"app\":\"Miss").is_err());
        assert_eq!(accumulator.raw_arguments(0), Some("{\"app\":\"Miss"));

        accumulator.push(fragment(0, None, Some("ion \\\"Mon")));
        accumulator.push(fragment(0, None, Some("itor\\\"\"}")));
        assert_eq!(
            accumulator.raw_arguments(0),
            Some("{\"app\":\"Mission \\\"Monitor\\\"\"}")
        );
        assert!(accumulator.has_tool_calls());
        assert_eq!(accumulator.tool_call_count(), 1);

        let calls = accumulator.finalize();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].index, 0);
        assert_eq!(calls[0].name.as_deref(), Some("open_app"));
        assert_eq!(
            calls[0].arguments,
            RawSkillCallArguments::Parsed(json!({ "app": "Mission \"Monitor\"" }))
        );
    }

    #[test]
    fn accumulator_keeps_parallel_indices_separate_and_ordered() {
        let mut accumulator = ToolCallAccumulator::new();
        accumulator.push(fragment(1, Some("second"), Some("{\"app\":\"B\"}")));
        accumulator.push(fragment(0, Some("first"), Some("{\"app\":\"A\"}")));

        let calls = accumulator.finalize();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].index, 0);
        assert_eq!(calls[0].name.as_deref(), Some("first"));
        assert_eq!(calls[1].index, 1);
        assert_eq!(calls[1].name.as_deref(), Some("second"));
    }

    #[test]
    fn a_content_delta_is_the_only_event_forwarded_as_a_token() {
        let mut accumulator = ToolCallAccumulator::new();
        assert_eq!(
            accumulator.push(ChatStreamEvent::Delta("Hello".to_string())),
            Some("Hello".to_string())
        );
        // Raw tool-call fragments and the terminator are never tokens.
        assert_eq!(accumulator.push(fragment(0, Some("open_app"), Some("{}"))), None);
        assert_eq!(accumulator.push(ChatStreamEvent::Done), None);
    }

    #[test]
    fn accumulator_records_the_finish_reason_and_detects_a_tool_call_turn() {
        let mut accumulator = ToolCallAccumulator::new();
        accumulator.set_finish_reason("stop");
        assert_eq!(accumulator.finish_reason(), Some("stop"));
        assert!(!accumulator.ended_on_tool_call());

        accumulator.set_finish_reason("tool_calls");
        assert!(accumulator.ended_on_tool_call());
        // Blank reasons never overwrite a real one.
        accumulator.set_finish_reason("  ");
        assert_eq!(accumulator.finish_reason(), Some("tool_calls"));
    }

    #[test]
    fn finalize_reports_malformed_arguments_and_missing_argument_text() {
        let mut accumulator = ToolCallAccumulator::new();
        accumulator.push(fragment(0, Some("open_app"), Some("{\"app\": ")));
        accumulator.push(fragment(1, Some("open_app"), None));

        let calls = accumulator.finalize();
        assert_eq!(calls.len(), 2);
        assert!(matches!(calls[0].arguments, RawSkillCallArguments::Malformed(_)));
        assert_eq!(
            calls[1].arguments,
            RawSkillCallArguments::Malformed("no arguments were received".to_string())
        );
    }

    // ── R-3.3/R-3.4: validate before emitting, fail closed ────────────────────

    #[test]
    fn a_valid_open_app_call_validates_and_emits_skill_call_then_done() {
        let registry = SkillRegistry::with_open_app();
        let mut accumulator = ToolCallAccumulator::new();
        accumulator.push(fragment(0, Some("open_app"), Some("{\"app\":")));
        accumulator.push(fragment(0, None, Some("\"Mission Monitor\"}")));
        accumulator.set_finish_reason("tool_calls");

        assert_eq!(
            plan_terminal_events(&registry, &accumulator),
            vec![
                TerminalEvent::SkillCall(SkillCall {
                    skill: "open_app".to_string(),
                    arguments: json!({ "app": "Mission Monitor" }),
                }),
                TerminalEvent::Done,
            ]
        );
    }

    #[test]
    fn an_unknown_skill_fails_closed_with_a_readable_error_then_done() {
        let registry = SkillRegistry::with_open_app();
        let mut accumulator = ToolCallAccumulator::new();
        accumulator.push(fragment(0, Some("open_the_pod_bay"), Some("{\"app\":\"x\"}")));
        accumulator.set_finish_reason("tool_calls");

        let events = plan_terminal_events(&registry, &accumulator);
        assert_eq!(events.len(), 2, "no llm-skill-call: {events:?}");
        match &events[0] {
            TerminalEvent::Error(detail) => {
                assert!(detail.contains("unknown skill 'open_the_pod_bay'"), "{detail}");
            }
            other => panic!("expected a fail-closed error, got {other:?}"),
        }
        assert_eq!(events[1], TerminalEvent::Done);
        assert!(!events.iter().any(|event| matches!(event, TerminalEvent::SkillCall(_))));
    }

    #[test]
    fn malformed_or_empty_arguments_fail_closed_with_done() {
        let registry = SkillRegistry::with_open_app();

        for bad in ["{\"app\": ", "not json", "", "{"] {
            let mut accumulator = ToolCallAccumulator::new();
            accumulator.push(fragment(0, Some("open_app"), Some(bad)));
            accumulator.set_finish_reason("tool_calls");

            let events = plan_terminal_events(&registry, &accumulator);
            assert!(
                matches!(events.first(), Some(TerminalEvent::Error(_))),
                "arguments {bad:?} must fail closed: {events:?}"
            );
            assert_eq!(events.last(), Some(&TerminalEvent::Done));
            assert!(!events.iter().any(|event| matches!(event, TerminalEvent::SkillCall(_))));
        }
    }

    #[test]
    fn a_missing_or_blank_app_fails_closed_with_done() {
        let registry = SkillRegistry::with_open_app();

        for bad in [json!({}), json!({ "app": null }), json!({ "app": "   " })] {
            let mut accumulator = ToolCallAccumulator::new();
            accumulator.push(fragment(0, Some("open_app"), Some(&bad.to_string())));
            accumulator.set_finish_reason("tool_calls");

            let events = plan_terminal_events(&registry, &accumulator);
            assert!(
                matches!(events.first(), Some(TerminalEvent::Error(_))),
                "arguments {bad:?} must fail closed: {events:?}"
            );
            assert!(!events.iter().any(|event| matches!(event, TerminalEvent::SkillCall(_))));
            assert_eq!(events.last(), Some(&TerminalEvent::Done));
        }
    }

    #[test]
    fn a_nameless_tool_call_fails_closed_with_done() {
        let registry = SkillRegistry::with_open_app();
        let mut accumulator = ToolCallAccumulator::new();
        accumulator.push(fragment(0, None, Some("{\"app\":\"Mission Monitor\"}")));
        accumulator.set_finish_reason("tool_calls");

        let events = plan_terminal_events(&registry, &accumulator);
        assert!(matches!(events.first(), Some(TerminalEvent::Error(_))));
        assert_eq!(events.last(), Some(&TerminalEvent::Done));
    }

    #[test]
    fn a_tool_call_turn_with_no_call_still_reports_then_done() {
        let registry = SkillRegistry::with_open_app();
        let mut accumulator = ToolCallAccumulator::new();
        accumulator.set_finish_reason("tool_calls");

        let events = plan_terminal_events(&registry, &accumulator);
        assert!(matches!(events.first(), Some(TerminalEvent::Error(_))));
        assert_eq!(events.last(), Some(&TerminalEvent::Done));
    }

    // ── Regression invariant: ordinary chat is untouched ─────────────────────

    #[test]
    fn an_ordinary_content_stream_never_emits_a_skill_call() {
        let registry = SkillRegistry::with_open_app();
        let mut accumulator = ToolCallAccumulator::new();
        assert_eq!(
            accumulator.push(ChatStreamEvent::Delta("Hello ".to_string())),
            Some("Hello ".to_string())
        );
        assert_eq!(
            accumulator.push(ChatStreamEvent::Delta("there".to_string())),
            Some("there".to_string())
        );
        accumulator.set_finish_reason("stop");

        assert_eq!(
            plan_terminal_events(&registry, &accumulator),
            vec![TerminalEvent::Done]
        );
    }

    // ── The open_app contract is the ST-3 registry's, verbatim ───────────────

    #[test]
    fn the_offered_open_app_schema_is_the_registry_declaration() {
        let registry = SkillRegistry::with_open_app();
        let body = build_skill_request_body(&messages(), &registry);
        let parameters = &body["tools"][0]["function"]["parameters"];
        assert_eq!(parameters["type"], "object");
        assert_eq!(parameters["properties"]["app"]["type"], "string");
        assert_eq!(parameters["required"], json!(["app"]));
        assert_eq!(OPEN_APP_ARGUMENT, "app");
    }

    // ── ST-8: continuous invariant — zero spurious opens (R-4.4/R-4.5) ────────

    /// Build the terminal plan for one raw buffered tool call (a tool-call turn).
    fn plan_for(
        registry: &SkillRegistry,
        name: Option<&str>,
        raw_arguments: &str,
    ) -> Vec<TerminalEvent> {
        let mut accumulator = ToolCallAccumulator::new();
        accumulator.push(fragment(0, name, Some(raw_arguments)));
        accumulator.set_finish_reason("tool_calls");
        plan_terminal_events(registry, &accumulator)
    }

    /// R-4.4 — a content-only turn is exactly `Done`: zero `llm-skill-call`s, so
    /// the hook never invokes the CLI and zero windows open. Pinned for the
    /// action's named non-app-open messages (including `Missing all the time`,
    /// which contains `Miss`, and `MM`, which is not an alias).
    #[test]
    fn non_app_open_messages_stream_content_and_never_a_skill_call() {
        let registry = SkillRegistry::with_open_app();
        for message in ["tell me a joke", "hi", "Missing all the time", "MM"] {
            let mut accumulator = ToolCallAccumulator::new();
            accumulator.push(ChatStreamEvent::Delta(format!("reply about {message}: ")));
            accumulator.push(ChatStreamEvent::Delta("the normal chat reply".to_string()));
            accumulator.set_finish_reason("stop");

            let events = plan_terminal_events(&registry, &accumulator);
            assert_eq!(events, vec![TerminalEvent::Done], "message {message:?}");
            assert!(
                !events
                    .iter()
                    .any(|event| matches!(event, TerminalEvent::SkillCall(_))),
                "message {message:?} must open zero windows"
            );
        }
    }

    /// R-4.5 — every spurious or malformed `open_app` selection is fail-closed:
    /// no `SkillCall` (hence no CLI invocation and zero windows) and `Done` last,
    /// for EVERY argument shape — including the non-string `app` values the
    /// declared contract forbids.
    #[test]
    fn every_spurious_open_app_selection_is_fail_closed_and_settles() {
        let registry = SkillRegistry::with_open_app();

        let cases: [(&str, Option<&str>, &str); 12] = [
            (
                "unknown skill name",
                Some("open_the_pod_bay"),
                "{\"app\":\"Mission Monitor\"}",
            ),
            ("app is a number", Some("open_app"), "{\"app\":123}"),
            ("app is a boolean", Some("open_app"), "{\"app\":true}"),
            ("app is an array", Some("open_app"), "{\"app\":[\"Mission Monitor\"]}"),
            (
                "app is an object",
                Some("open_app"),
                "{\"app\":{\"name\":\"Mission Monitor\"}}",
            ),
            ("app is null", Some("open_app"), "{\"app\":null}"),
            ("app is missing", Some("open_app"), "{}"),
            ("app is blank", Some("open_app"), "{\"app\":\"   \"}"),
            ("arguments are not JSON", Some("open_app"), "not json"),
            ("arguments are empty", Some("open_app"), ""),
            ("the call has no name", None, "{\"app\":\"Mission Monitor\"}"),
            (
                "an undeclared extra argument",
                Some("open_app"),
                "{\"app\":\"Mission Monitor\",\"force\":true}",
            ),
        ];

        for (label, name, raw) in cases {
            let events = plan_for(&registry, name, raw);
            assert!(
                matches!(events.first(), Some(TerminalEvent::Error(_))),
                "{label}: expected a fail-closed error, got {events:?}"
            );
            assert!(
                !events
                    .iter()
                    .any(|event| matches!(event, TerminalEvent::SkillCall(_))),
                "{label}: nothing may be executed, got {events:?}"
            );
            assert_eq!(
                events.last(),
                Some(&TerminalEvent::Done),
                "{label}: every path must settle with llm-done"
            );
        }
    }

    // ── ST-9: continuous invariant — always settle / never stuck (R-1.4) ──────

    /// R-1.4 — EVERY backend termination branch emits exactly ONE `llm-done`
    /// and emits it LAST: a validated tool call, an ordinary content turn, a
    /// parse failure, a rejected/fail-closed selection, a tool-call turn with no
    /// call, and an empty stream. One extra or missing `Done` would either
    /// double-settle or hang the Companion.
    #[test]
    fn every_backend_path_settles_with_exactly_one_done() {
        let registry = SkillRegistry::with_open_app();

        let mut valid = ToolCallAccumulator::new();
        valid.push(fragment(0, Some("open_app"), Some("{\"app\":\"Mission Monitor\"}")));
        valid.set_finish_reason("tool_calls");

        let mut content = ToolCallAccumulator::new();
        content.push(ChatStreamEvent::Delta("hello".to_string()));
        content.set_finish_reason("stop");

        let mut parse_failure = ToolCallAccumulator::new();
        parse_failure.push(fragment(0, Some("open_app"), Some("{\"app\": ")));
        parse_failure.set_finish_reason("tool_calls");

        let mut rejected = ToolCallAccumulator::new();
        rejected.push(fragment(0, Some("open_the_pod_bay"), Some("{\"app\":\"x\"}")));
        rejected.set_finish_reason("tool_calls");

        let mut no_call = ToolCallAccumulator::new();
        no_call.set_finish_reason("tool_calls");

        let empty = ToolCallAccumulator::new();

        for (label, accumulator, expect_skill_call) in [
            ("valid tool call", valid, true),
            ("ordinary content", content, false),
            ("parse failure", parse_failure, false),
            ("rejected selection", rejected, false),
            ("tool-call turn with no call", no_call, false),
            ("empty stream", empty, false),
        ] {
            let events = plan_terminal_events(&registry, &accumulator);
            let done_count = events
                .iter()
                .filter(|event| matches!(event, TerminalEvent::Done))
                .count();
            assert_eq!(done_count, 1, "{label}: exactly one llm-done: {events:?}");
            assert_eq!(
                events.last(),
                Some(&TerminalEvent::Done),
                "{label}: llm-done is always last: {events:?}"
            );
            assert_eq!(
                events
                    .iter()
                    .any(|event| matches!(event, TerminalEvent::SkillCall(_))),
                expect_skill_call,
                "{label}: skill-call presence: {events:?}"
            );
        }
    }

    /// R-1.4 — a transport/launch failure (the `Err` return of the stream) still
    /// settles: a readable `llm-error` followed by exactly one `llm-done`, and
    /// never a `llm-skill-call` (nothing can execute on a dead stream).
    #[test]
    fn a_failed_stream_plan_settles_with_error_then_done() {
        let events = plan_stream_error_events("the companion server returned HTTP 500");
        assert_eq!(events.len(), 2);
        assert!(matches!(events[0], TerminalEvent::Error(_)));
        assert_eq!(events[1], TerminalEvent::Done);
        assert!(
            !events
                .iter()
                .any(|event| matches!(event, TerminalEvent::SkillCall(_))),
            "a dead stream must not execute a skill: {events:?}"
        );
    }

    // ── #2903: the model-audio turn offers the SAME registry as the typed path ─

    /// R-1.3(a) — the audio skill body offers the registry `tools` VERBATIM
    /// (`render_tools`, no second schema copy) plus the shipped
    /// `tool_choice: "auto"` / `parallel_tool_calls: false` / `stream: true`.
    #[test]
    fn build_audio_skill_request_body_offers_the_same_registry_tools_and_flags() {
        let registry = SkillRegistry::with_app_control();
        let body = build_audio_skill_request_body(&messages(), "UklGRg==", &registry);

        assert_eq!(body["stream"], true);
        assert_eq!(body["max_tokens"], 1024);
        assert_eq!(body["tools"], render_tools(&registry));
        assert_eq!(body["tools"][0]["function"]["name"], "open_app");
        assert_eq!(body["tools"][1]["function"]["name"], "close_app");
        assert_eq!(
            body["tools"][1]["function"]["parameters"],
            registry.get("close_app").expect("registered").parameters,
            "the close_app schema is the registry declaration, not a copy"
        );
        assert_eq!(body["tool_choice"], TOOL_CHOICE_AUTO);
        assert_eq!(body["tool_choice"], "auto");
        assert_eq!(body["parallel_tool_calls"], PARALLEL_TOOL_CALLS);
        assert_eq!(body["parallel_tool_calls"], false);
    }

    /// R-1.3(a) — the two request bodies are IDENTICAL modulo the last user
    /// message's `content` (the ONE audio part). No second registry copy.
    #[test]
    fn the_audio_skill_body_equals_the_skill_body_plus_the_single_input_audio_part() {
        let registry = SkillRegistry::with_app_control();
        let skill_body = build_skill_request_body(&messages(), &registry);
        let audio_body = build_audio_skill_request_body(&messages(), "UklGRg==", &registry);

        let mut expected = skill_body.clone();
        expected["messages"][1]["content"] =
            serde_json::json!([chat::audio_content_part("UklGRg==")]);
        assert_eq!(
            audio_body, expected,
            "the audio skill body differs from the typed body only in the last user content"
        );

        // The registry offer is shared verbatim — tools + flags cannot diverge.
        assert_eq!(audio_body["tools"], skill_body["tools"]);
        assert_eq!(audio_body["tool_choice"], skill_body["tool_choice"]);
        assert_eq!(
            audio_body["parallel_tool_calls"],
            skill_body["parallel_tool_calls"]
        );
        assert_eq!(audio_body["messages"][0], skill_body["messages"][0]);
    }

    /// R-1.3(a) — the clip rides as exactly ONE `input_audio` part on the last
    /// user message and NEVER as a `text` part (extends the shipped audio-body
    /// pins to the skill-aware body the audio path actually sends).
    #[test]
    fn build_audio_skill_request_body_keeps_one_input_audio_part_and_no_text_part() {
        let registry = SkillRegistry::with_app_control();
        let body = build_audio_skill_request_body(&messages(), "UklGRg==", &registry);

        let parts = body["messages"][1]["content"]
            .as_array()
            .expect("the last user content must be the audio array");
        assert_eq!(parts.len(), 1, "exactly the ONE audio part: {parts:?}");
        assert_eq!(parts[0]["type"], "input_audio");
        assert_eq!(parts[0]["input_audio"]["data"], "UklGRg==");
        assert_eq!(parts[0]["input_audio"]["format"], "wav");
        assert_eq!(
            parts[0].as_object().map(serde_json::Map::len),
            Some(2),
            "the part carries only type + input_audio"
        );

        let serialized = body.to_string();
        assert!(
            !serialized.contains("\"type\":\"text\""),
            "the audio skill body must not carry a text part: {serialized}"
        );
        assert!(!serialized.contains("\"text\""), "no text key: {serialized}");
    }

    /// R-1.3(b) — a buffered `tool_calls` turn on the AUDIO path (split
    /// fragments) routes through the SAME shipped `plan_terminal_events`:
    /// `[SkillCall, Done]`, never a token for the raw tool-call JSON.
    #[test]
    fn audio_skill_stream_routes_a_tool_call_through_the_shared_terminal_plan() {
        let registry = SkillRegistry::with_app_control();
        let mut accumulator = ToolCallAccumulator::new();

        // Fragment split mid-argument: never parsed per chunk.
        assert_eq!(
            accumulator.push(fragment(0, Some("open_app"), Some("{\"app\":\"Miss"))),
            None
        );
        assert_eq!(
            accumulator.push(fragment(0, None, Some("ion Monitor\"}"))),
            None,
            "raw tool-call fragments are never forwarded as tokens"
        );
        accumulator.set_finish_reason("tool_calls");

        assert_eq!(
            plan_terminal_events(&registry, &accumulator),
            vec![
                TerminalEvent::SkillCall(SkillCall {
                    skill: "open_app".to_string(),
                    arguments: json!({ "app": "Mission Monitor" }),
                }),
                TerminalEvent::Done,
            ]
        );
    }

    /// R-1.3(b) — `llm-done` is emitted exactly ONCE and LAST on the audio path:
    /// a validated call, a rejected selection, an empty stream, and a transport
    /// failure all settle exactly once.
    #[test]
    fn an_audio_skill_stream_settles_with_exactly_one_done() {
        let registry = SkillRegistry::with_app_control();

        let mut valid = ToolCallAccumulator::new();
        valid.push(fragment(0, Some("close_app"), Some("{\"app\":\"Settings\"}")));
        valid.set_finish_reason("tool_calls");

        let mut rejected = ToolCallAccumulator::new();
        rejected.push(fragment(0, Some("open_the_pod_bay"), Some("{\"app\":\"Settings\"}")));
        rejected.set_finish_reason("tool_calls");

        let empty = ToolCallAccumulator::new();

        for (label, accumulator) in [
            ("valid selection", valid),
            ("rejected selection", rejected),
            ("empty stream", empty),
        ] {
            let events = plan_terminal_events(&registry, &accumulator);
            assert_eq!(
                events
                    .iter()
                    .filter(|event| matches!(event, TerminalEvent::Done))
                    .count(),
                1,
                "{label}: exactly one llm-done: {events:?}"
            );
            assert_eq!(
                events.last(),
                Some(&TerminalEvent::Done),
                "{label}: llm-done is always last: {events:?}"
            );
        }

        // The transport-failure leg (`Err`) settles once, last.
        let failure = plan_stream_error_events("the companion server stream failed");
        assert_eq!(
            failure
                .iter()
                .filter(|event| matches!(event, TerminalEvent::Done))
                .count(),
            1,
            "a failed audio stream must not double-settle: {failure:?}"
        );
        assert_eq!(failure.last(), Some(&TerminalEvent::Done));
    }

    /// R-1.3(b)/R-5.2 — a malformed or rejected audio selection fails closed: a
    /// readable `llm-error`, ZERO `llm-skill-call`, and `llm-done` last.
    #[test]
    fn a_rejected_audio_selection_emits_error_and_never_a_skill_call() {
        let registry = SkillRegistry::with_app_control();
        let cases: [(&str, Option<&str>, &str); 6] = [
            (
                "unknown skill name",
                Some("open_the_pod_bay"),
                "{\"app\":\"Settings\"}",
            ),
            ("close_app with no app", Some("close_app"), "{}"),
            ("close_app blank app", Some("close_app"), "{\"app\":\"   \"}"),
            ("close_app non-string app", Some("close_app"), "{\"app\":7}"),
            ("malformed arguments", Some("close_app"), "{\"app\": "),
            ("the call has no name", None, "{\"app\":\"Settings\"}"),
        ];

        for (label, name, raw) in cases {
            let events = plan_for(&registry, name, raw);
            assert!(
                matches!(events.first(), Some(TerminalEvent::Error(_))),
                "{label}: expected a fail-closed error, got {events:?}"
            );
            assert!(
                !events
                    .iter()
                    .any(|event| matches!(event, TerminalEvent::SkillCall(_))),
                "{label}: nothing may be executed, got {events:?}"
            );
            assert_eq!(
                events.last(),
                Some(&TerminalEvent::Done),
                "{label}: every path must settle with llm-done"
            );
        }
    }

    // ── #2903 (ST-3 dispatch contract): `close_app` on the ONE shared registry ─

    /// R-2/R-3 — a valid `close_app` selection validates against the SAME `app`
    /// contract and emits `[SkillCall{skill:"close_app"}, Done]`.
    #[test]
    fn a_valid_close_app_call_validates_and_emits_skill_call_then_done() {
        let registry = SkillRegistry::with_app_control();
        assert_eq!(CLOSE_APP_ARGUMENT, OPEN_APP_ARGUMENT);

        let mut accumulator = ToolCallAccumulator::new();
        accumulator.push(fragment(0, Some("close_app"), Some("{\"app\":")));
        accumulator.push(fragment(0, None, Some("\"Settings\"}")));
        accumulator.set_finish_reason("tool_calls");

        assert_eq!(
            plan_terminal_events(&registry, &accumulator),
            vec![
                TerminalEvent::SkillCall(SkillCall {
                    skill: "close_app".to_string(),
                    arguments: json!({ "app": "Settings" }),
                }),
                TerminalEvent::Done,
            ]
        );
    }

    /// R-5.2 — every spurious or malformed `close_app` selection is fail-closed:
    /// no `SkillCall` (hence zero closes) and `Done` last, for EVERY argument
    /// shape the declared contract forbids.
    #[test]
    fn every_spurious_close_app_selection_is_fail_closed_and_settles() {
        let registry = SkillRegistry::with_app_control();

        let cases: [(&str, Option<&str>, &str); 11] = [
            (
                "unknown skill name",
                Some("open_the_pod_bay"),
                "{\"app\":\"Settings\"}",
            ),
            ("app is a number", Some("close_app"), "{\"app\":123}"),
            ("app is a boolean", Some("close_app"), "{\"app\":true}"),
            ("app is an array", Some("close_app"), "{\"app\":[\"Settings\"]}"),
            (
                "app is an object",
                Some("close_app"),
                "{\"app\":{\"name\":\"Settings\"}}",
            ),
            ("app is null", Some("close_app"), "{\"app\":null}"),
            ("app is missing", Some("close_app"), "{}"),
            ("app is blank", Some("close_app"), "{\"app\":\"   \"}"),
            ("arguments are not JSON", Some("close_app"), "not json"),
            ("arguments are empty", Some("close_app"), ""),
            (
                "an undeclared extra argument",
                Some("close_app"),
                "{\"app\":\"Settings\",\"force\":true}",
            ),
        ];

        for (label, name, raw) in cases {
            let events = plan_for(&registry, name, raw);
            assert!(
                matches!(events.first(), Some(TerminalEvent::Error(_))),
                "{label}: expected a fail-closed error, got {events:?}"
            );
            assert!(
                !events
                    .iter()
                    .any(|event| matches!(event, TerminalEvent::SkillCall(_))),
                "{label}: nothing may be executed, got {events:?}"
            );
            assert_eq!(
                events.last(),
                Some(&TerminalEvent::Done),
                "{label}: every path must settle with llm-done"
            );
        }
    }

    /// R-2.1 — a content-only close-sounding turn is exactly `Done`: zero
    /// `llm-skill-call`s, so the hook never closes a window.
    #[test]
    fn a_close_sounding_message_streams_content_and_never_a_skill_call() {
        let registry = SkillRegistry::with_app_control();
        for message in [
            "close the pod bay doors",
            "closing time",
            "please shut it down",
            "what does close_app do?",
        ] {
            let mut accumulator = ToolCallAccumulator::new();
            accumulator.push(ChatStreamEvent::Delta(format!("reply about {message}: ")));
            accumulator.push(ChatStreamEvent::Delta("the normal chat reply".to_string()));
            accumulator.set_finish_reason("stop");

            let events = plan_terminal_events(&registry, &accumulator);
            assert_eq!(events, vec![TerminalEvent::Done], "message {message:?}");
            assert!(
                !events
                    .iter()
                    .any(|event| matches!(event, TerminalEvent::SkillCall(_))),
                "message {message:?} must close zero windows"
            );
        }
    }
}
