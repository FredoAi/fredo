//! Skill-aware inference path (Spec #2893, ST-5; EARS R-3.1–R-3.5; re-pointed
//! in-process by Spec #3141, ST-3).
//!
//! Offers the ST-3 companion skill registry to the in-process engine and turns a
//! model-selected tool call into a validated `llm-skill-call` event — while
//! ordinary chat stays token-for-token unchanged:
//!
//! * the request shapes the registry into the engine turn's `tools` +
//!   `tool_choice: "auto"` (and the pinned `parallel_tool_calls: false`
//!   mitigation, enforced by the single-call terminal plan);
//! * the engine's decoded tool calls buffer VERBATIM and are JSON-parsed
//!   **exactly once** at the finish (#22722 split escapes), then validated
//!   through ST-3's [`validate`] BEFORE anything is emitted or executed (fail
//!   closed);
//! * a validated selection emits `llm-skill-call`; a rejected one emits a
//!   readable `llm-error`; `llm-done` is emitted on every path (never hang).
//!
//! Non-goals / regression invariants:
//! - `llm_chat` / `llm_chat_with_image` payload shapes are byte-identical (joke,
//!   TicTacToe, vision untouched).
//! - Raw tool-call JSON is NEVER forwarded as `llm-token`.
//! - No window or CLI work here (execution is bound by the caller).

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

use crate::infrastructure::companion::skills::{validate, SkillRegistry};

use super::chat::LlmMessage;
use super::engine::request::ChatTurn;
use super::engine::stream::{AppSink, SettledStream, StreamEvent, TurnSource};

/// `tool_choice` sent with the registry offer — the model decides when to call.
pub const TOOL_CHOICE_AUTO: &str = "auto";

/// `parallel_tool_calls` semantics of the registry offer. Explicitly false so
/// the documented Gemma4 parallel-call loop hazard is mitigated (spike finding
/// b). In-process the production turn enforces single-call through the shared
/// terminal plan; this constant is the wire-shape value the test-only builders
/// render, so it is gated to test builds.
#[cfg(test)]
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

/// Shape one engine turn that offers `registry` (and, when given, the turn's
/// audio or image).
///
/// The ONE production shaping rule: the registry's `tools` go on the turn, the
/// tool choice is [`TOOL_CHOICE_AUTO`], and the media rides the turn (so the
/// engine's own media rule applies, never a second renderer).
pub fn skill_turn(
    messages: Vec<LlmMessage>,
    registry: &SkillRegistry,
    audio_base64: Option<&str>,
    image_base64: Option<&str>,
) -> ChatTurn {
    let mut turn = ChatTurn::text(messages).with_tools(
        render_tools(registry)
            .as_array()
            .cloned()
            .unwrap_or_default(),
        TOOL_CHOICE_AUTO,
    );
    if let Some(audio) = audio_base64 {
        turn = turn.with_audio(audio);
    } else if let Some(image) = image_base64 {
        turn = turn.with_image(image);
    }
    turn
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
    /// Whether any NON-EMPTY content delta was forwarded (the empty-turn
    /// guarantee's predicate, Spec #3233 AC-2). A buffered tool-call fragment
    /// and an empty delta are NOT visible content.
    saw_content: bool,
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
    pub fn push(&mut self, event: StreamEvent) -> Option<String> {
        match event {
            StreamEvent::Delta(content) => {
                // Only a NON-EMPTY delta is visible content (the settle guard
                // drops an empty token), so an empty piece never satisfies the
                // empty-turn guarantee.
                if !content.is_empty() {
                    self.saw_content = true;
                }
                Some(content)
            }
            StreamEvent::ToolCallDelta {
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
            StreamEvent::Done => None,
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

    /// Whether the turn produced any visible content (a non-empty delta).
    ///
    /// The empty-turn guarantee (Spec #3233, AC-2) reads this: a turn that
    /// produced no visible content, no tool call, and did not end on a tool-call
    /// turn must not terminate silently.
    pub fn content_seen(&self) -> bool {
        self.saw_content
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

/// The empty-turn guarantee's readable detail (Spec #3233, AC-2).
///
/// MUST contain the exact phrase `no visible reply` (case-sensitive): the
/// frontend copy branch matches `/no visible reply/i` (Adjudication #3), so a
/// later reword that drops the phrase would silently disable that branch. The
/// [`tests::the_empty_reply_detail_carries_the_discriminator_phrase`] pin reddens
/// first. It is also [`super::engine::CompanionEngineErrorCode::EmptyReply`]'s
/// curated detail, so the code and the wire text share ONE source.
pub const EMPTY_REPLY_DETAIL: &str =
    "the companion produced no visible reply for this turn; the model may have spent its whole budget reasoning.";

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

    // The empty-turn guarantee (Spec #3233, AC-2): a turn that produced NO
    // visible content, NO tool call, and did not END on a tool-call turn must
    // never terminate silently. A tool-call turn keeps its OWN reason (above), a
    // turn with content stays error-free, and a settled error turn never reaches
    // this plan (it goes through `plan_stream_error_events`).
    if events.is_empty() && !accumulator.content_seen() {
        events.push(TerminalEvent::Error(EMPTY_REPLY_DETAIL.to_string()));
    }

    // ALWAYS complete — never hang (R-3.4 / ST-9).
    events.push(TerminalEvent::Done);
    events
}

/// Whether a terminal event is the empty-turn guarantee's own failure (Spec
/// #3233, AC-2).
///
/// Extracted so a caller that owns a RETRY — the schema-constrained status
/// attempt, which must NOT be retyped with an empty reply but re-runs its plain
/// path (Risk 6) — can defer the guarantee to the terminal path instead of
/// settling a retryable attempt on it.
pub fn is_empty_reply_event(event: &TerminalEvent) -> bool {
    matches!(event, TerminalEvent::Error(detail) if detail == EMPTY_REPLY_DETAIL)
}

/// The terminal events for a failed skill-aware stream (engine start / model
/// failure / a refused turn): a readable `llm-error` followed by `llm-done`.
///
/// The stream died before any accumulated call could be finalized, so there is
/// no plan to run — but a failed generation MUST still settle (R-26.2): a
/// `llm-done` is always the last event. Pure so the never-hang guarantee is
/// pinned without a live `AppHandle`.
pub fn plan_stream_error_events(detail: &str) -> Vec<TerminalEvent> {
    vec![
        TerminalEvent::Error(detail.to_string()),
        TerminalEvent::Done,
    ]
}

/// Emit one terminal event on its wire channel (`llm-skill-call` / `llm-error` /
/// `llm-done`).
///
/// The ONE terminal-emit site, shared by the normal plan and the stream-failure
/// path — so no backend branch can emit a `Done`-less terminal sequence, and the
/// trailing `llm-done` is owned by [`SettledStream`].
pub(crate) fn emit_terminal_event(settled: &mut SettledStream<'_>, event: TerminalEvent) {
    match event {
        TerminalEvent::SkillCall(call) => settled.skill_call(call),
        TerminalEvent::Error(detail) => settled.error(detail),
        TerminalEvent::Done => settled.finish(),
    }
}

/// Run ONE skill-aware turn against `source`: content deltas → `llm-token`;
/// tool calls buffered VERBATIM; at the finish the selection is validated and
/// routed through the terminal plan (`llm-skill-call` / readable `llm-error` /
/// always a trailing `llm-done`).
///
/// This is the ONE accumulate/validate/emit loop. It takes a source and an
/// ALREADY-CONSTRUCTED settle guard, so the shipped behaviour is exactly what
/// the settle pins execute and the trailing `llm-done` stays owned by the
/// outermost caller.
pub(crate) async fn stream_skill_turn(
    source: &dyn TurnSource,
    settled: &mut SettledStream<'_>,
    registry: &SkillRegistry,
    turn: ChatTurn,
) -> Result<(), String> {
    let mut accumulator = ToolCallAccumulator::new();

    let outcome = source
        .stream(turn, &mut |frame| {
            for event in frame.events {
                if let Some(delta) = accumulator.push(event) {
                    settled.token(delta);
                }
            }
            if let Some(reason) = frame.finish_reason {
                accumulator.set_finish_reason(reason);
            }
            // Never stop early: always reach the finalize/emit phase.
        })
        .await;

    if let Err(detail) = outcome {
        // The stream failed before the plan could run: settle on the SAME
        // terminal vocabulary (never hang, whatever the failure).
        for event in plan_stream_error_events(&detail) {
            emit_terminal_event(settled, event);
        }
        return Ok(());
    }

    for event in plan_terminal_events(registry, &accumulator) {
        emit_terminal_event(settled, event);
    }
    Ok(())
}

/// Stream ONE skill-aware turn through the production engine source.
///
/// The adapter the typed path ([`run_skill_chat`]) and the model-audio path
/// (`run_audio_chat`) share, so both routes settle on the SAME vocabulary and
/// raw tool-call JSON is never forwarded as a token.
pub(crate) async fn run_skill_stream(
    app: &AppHandle,
    registry: &SkillRegistry,
    turn: ChatTurn,
) -> Result<(), String> {
    let sink = AppSink::new(app);
    let mut settled = SettledStream::new(&sink);
    let outcome = match super::engine::stream::EngineTurnSource::for_app(app) {
        Ok(source) => stream_skill_turn(&source, &mut settled, registry, turn).await,
        Err((_code, detail)) => {
            for event in plan_stream_error_events(&detail) {
                emit_terminal_event(&mut settled, event);
            }
            Ok(())
        }
    };
    // Explicit settle so the intent reads at the call site; the guard's `Drop`
    // would do the same, and both are idempotent.
    settled.finish();
    outcome
}

/// Stream ONE content-only turn (NO tools offered): each content delta is
/// forwarded on the SHIPPED `llm-token` channel and the turn settles with
/// exactly one `llm-done`.
///
/// The content-turn entry shared by the status path's bounded plain retry
/// (Spec #2918, R-5/R-6). A content turn and a tool-call turn remain disjoint.
/// Carries the SAME empty-turn guarantee as the skill path (Spec #3233, AC-2):
/// a turn that produced no visible content settles `[llm-error, llm-done]`,
/// never a silent bare `llm-done`.
pub(crate) async fn stream_plain_turn(
    source: &dyn TurnSource,
    settled: &mut SettledStream<'_>,
    turn: ChatTurn,
) -> Result<(), String> {
    let mut accumulator = ToolCallAccumulator::new();
    let outcome = source
        .stream(turn, &mut |frame| {
            for event in frame.events {
                if let Some(delta) = accumulator.push(event) {
                    settled.token(delta);
                }
            }
        })
        .await;
    match outcome {
        Err(detail) => settled.error(detail),
        // The SAME empty-turn guarantee as the skill path: a content turn that
        // produced no visible content must never settle silently (AC-2).
        Ok(()) if !accumulator.content_seen() => settled.error(EMPTY_REPLY_DETAIL),
        Ok(()) => {}
    }
    Ok(())
}

// ── The skill path's terminal-settle pins (R-26.2) ────────────────────────────
//
// Each pin drives the REAL `stream_skill_turn` against a scripted source and a
// recording sink, so "exactly one `llm-done`, always last" is a property of the
// shipped code — not of a re-implementation. Every path is covered: a validated
// skill call, an ordinary content turn, a fail-closed parse error, a rejected
// selection, a tool-call turn with no call, an engine failure, and an empty
// stream.

#[cfg(test)]
mod settle_tests {
    use super::*;
    use crate::applications::llm_server::engine::stream::testing::{
        assert_settles_once, finished, RecordingSink, ScriptedResponse, ScriptedTurnSource,
    };
    use crate::applications::llm_server::engine::stream::{StreamEvent, StreamFrame};
    use crate::infrastructure::companion::skills::SkillRegistry;

    fn message(role: &str, content: &str) -> LlmMessage {
        LlmMessage {
            role: role.to_string(),
            content: content.to_string(),
        }
    }

    fn tool_call_frame(name: &str, arguments: &str) -> StreamFrame {
        StreamFrame {
            events: vec![StreamEvent::ToolCallDelta {
                index: 0,
                name: Some(name.to_string()),
                arguments_fragment: Some(arguments.to_string()),
            }],
            finish_reason: None,
            reasoning: None,
        }
    }

    async fn run(
        registry: &SkillRegistry,
        responses: Vec<ScriptedResponse>,
        sink: &RecordingSink,
    ) {
        let source = ScriptedTurnSource::new(responses);
        let mut settled = SettledStream::new(sink);
        stream_skill_turn(&source, &mut settled, registry, ChatTurn::text(vec![]))
            .await
            .expect("the skill path never returns an error (it settles instead)");
        settled.finish();
    }

    /// A VALIDATED `open_app` selection settles with `[llm-skill-call, llm-done]`
    /// — the skill call BEFORE the terminator, exactly once each.
    #[tokio::test]
    async fn a_validated_skill_call_settles_once_with_the_call_before_done() {
        let registry = SkillRegistry::with_open_app();
        let sink = RecordingSink::new();
        run(
            &registry,
            vec![ScriptedResponse::ok(vec![
                tool_call_frame("open_app", r#"{"app":"Mission Monitor"}"#),
                finished("tool_calls"),
            ])],
            &sink,
        )
        .await;

        assert_settles_once(&sink, "validated skill call");
        assert_eq!(
            sink.names(),
            vec!["llm-skill-call", "llm-done"],
            "the skill call precedes the single terminator"
        );
        assert_eq!(sink.count("llm-skill-call"), 1);
        assert_eq!(
            sink.payloads("llm-skill-call"),
            vec![r#"{"skill":"open_app","arguments":{"app":"Mission Monitor"}}"#]
        );
    }

    /// An ordinary content turn streams its deltas and settles with exactly the
    /// single trailing `llm-done` — and NO skill call, and NO terminal error.
    #[tokio::test]
    async fn an_ordinary_content_turn_settles_once_with_no_skill_call() {
        let registry = SkillRegistry::with_open_app();
        let sink = RecordingSink::new();
        run(&registry, vec![ScriptedResponse::content("hello there")], &sink).await;

        assert_settles_once(&sink, "ordinary content");
        assert_eq!(sink.count("llm-skill-call"), 0);
        assert_eq!(
            sink.count("llm-error"),
            0,
            "a content turn emits no terminal error"
        );
        assert_eq!(sink.payloads("llm-token"), vec!["hello there"]);
    }

    /// A malformed argument JSON fails closed: a readable `llm-error`, ZERO skill
    /// calls, and the trailing `llm-done`.
    #[tokio::test]
    async fn a_malformed_arguments_turn_settles_once_with_error_before_done() {
        let registry = SkillRegistry::with_open_app();
        let sink = RecordingSink::new();
        run(
            &registry,
            vec![ScriptedResponse::ok(vec![
                tool_call_frame("open_app", r#"{"app": "#),
                finished("tool_calls"),
            ])],
            &sink,
        )
        .await;

        assert_settles_once(&sink, "malformed arguments");
        assert_eq!(sink.count("llm-skill-call"), 0, "nothing may be executed");
        assert_eq!(sink.count("llm-error"), 1);
        assert_eq!(sink.names(), vec!["llm-error", "llm-done"]);
    }

    /// A rejected (unknown) selection fails closed the same way.
    #[tokio::test]
    async fn a_rejected_selection_settles_once_with_error_before_done() {
        let registry = SkillRegistry::with_open_app();
        let sink = RecordingSink::new();
        run(
            &registry,
            vec![ScriptedResponse::ok(vec![
                tool_call_frame("open_the_pod_bay", r#"{"app":"x"}"#),
                finished("tool_calls"),
            ])],
            &sink,
        )
        .await;

        assert_settles_once(&sink, "rejected selection");
        assert_eq!(sink.count("llm-skill-call"), 0);
        assert_eq!(sink.count("llm-error"), 1);
    }

    /// A `tool_calls` finish with NO call still settles with a reason then done.
    ///
    /// POSITIVE CONTROL: a tool-call turn keeps its OWN reason — the empty-reply
    /// guarantee never fires for it (Risk 6).
    #[tokio::test]
    async fn a_tool_call_turn_without_a_call_settles_once() {
        let registry = SkillRegistry::with_open_app();
        let sink = RecordingSink::new();
        run(&registry, vec![ScriptedResponse::finish_only("tool_calls")], &sink).await;

        assert_settles_once(&sink, "tool-call turn without a call");
        assert_eq!(sink.count("llm-error"), 1);
        assert_eq!(sink.count("llm-skill-call"), 0);
        assert_eq!(
            sink.payloads("llm-error"),
            vec![TOOL_CALL_TURN_WITHOUT_CALL_DETAIL.to_string()],
            "a tool-call turn keeps its own detail, never the empty-reply one"
        );
        assert_ne!(sink.payloads("llm-error")[0], EMPTY_REPLY_DETAIL);
    }

    /// An ENGINE FAILURE (`Err` from the source) still settles: a readable
    /// `llm-error` then exactly one trailing `llm-done` — never a hang.
    #[tokio::test]
    async fn an_engine_failure_settles_once_with_error_before_done() {
        let registry = SkillRegistry::with_open_app();
        let sink = RecordingSink::new();
        run(
            &registry,
            vec![ScriptedResponse::failed("the companion engine stopped")],
            &sink,
        )
        .await;

        assert_settles_once(&sink, "engine failure");
        assert_eq!(sink.count("llm-error"), 1);
        assert_eq!(sink.count("llm-skill-call"), 0);
        assert_eq!(sink.names(), vec!["llm-error", "llm-done"]);
        // POSITIVE CONTROL: an engine failure keeps ITS OWN detail (via
        // `plan_stream_error_events`), never the empty-reply one.
        assert_eq!(
            sink.payloads("llm-error"),
            vec!["the companion engine stopped".to_string()]
        );
    }

    /// THE pin for the failed-turn settle contract (Spec #3141 fix F1).
    ///
    /// An engine whose channel closes WITHOUT `Finished` — the exact state a
    /// panicked engine thread leaves behind — now fails the turn through the REAL
    /// [`crate::applications::llm_server::engine::stream`] drain, and the shipped
    /// skill path settles it as `llm-error` followed by **exactly one**
    /// `llm-done`, last. Before the fix the closed channel was mapped to `Ok(())`,
    /// so the turn settled with a bare `llm-done` and NO `llm-error` — the failure
    /// was invisible.
    #[tokio::test]
    async fn an_engine_that_dies_mid_turn_settles_error_then_exactly_one_done() {
        use crate::applications::llm_server::engine::stream::testing::ChannelTurnSource;

        let registry = SkillRegistry::with_open_app();
        let sink = RecordingSink::new();
        let source = ChannelTurnSource::new();
        {
            let mut settled = SettledStream::new(&sink);
            stream_skill_turn(&source, &mut settled, &registry, ChatTurn::text(vec![]))
                .await
                .expect("the skill path never returns an error (it settles instead)");
            settled.finish();
        }

        let names = sink.names();
        assert_eq!(
            names.iter().filter(|name| *name == "llm-done").count(),
            1,
            "exactly ONE llm-done on a dead-engine turn: {names:?}"
        );
        assert_eq!(
            names.last().map(String::as_str),
            Some("llm-done"),
            "llm-done must be LAST: {names:?}"
        );
        assert_eq!(
            sink.count("llm-error"),
            1,
            "a dead engine MUST emit a readable llm-error (never a silent bare llm-done): {names:?}"
        );
        assert_eq!(
            names,
            vec!["llm-error", "llm-done"],
            "the settle is exactly [llm-error, llm-done]"
        );
        // The error copy is the production one, and it names the cause.
        let detail = &sink.payloads("llm-error")[0];
        assert!(
            detail.contains("stopped before the turn finished"),
            "the failure must name the cause: {detail}"
        );
    }

    /// An EMPTY stream (a source that yields no frames at all) is an EMPTY TURN:
    /// the shipped empty-turn guarantee (Spec #3233, AC-2) settles it with the
    /// typed `llm-error` and the single trailing `llm-done`.
    ///
    /// Before Spec #3233 this pinned a bare `["llm-done"]` — the silent
    /// termination the guarantee exists to eliminate. That sequence is now the
    /// negative control this pin REJECTS.
    #[tokio::test]
    async fn an_empty_stream_settles_once() {
        let registry = SkillRegistry::with_open_app();
        let sink = RecordingSink::new();
        run(&registry, vec![ScriptedResponse::ok(vec![])], &sink).await;

        assert_settles_once(&sink, "empty stream");
        assert_eq!(
            sink.names(),
            vec!["llm-error", "llm-done"],
            "an empty turn surfaces the typed error, never a silent bare llm-done"
        );
        assert_eq!(
            sink.payloads("llm-error"),
            vec![EMPTY_REPLY_DETAIL.to_string()],
            "the detail is the shipped const, byte for byte (never a paraphrase)"
        );
    }

    /// AC-2 / R-2 (QA-2 / FR-36) — THE decisive pin. A turn whose budget was
    /// exhausted by reasoning ends on `finish_reason "length"` with zero visible
    /// content and no tool call, so it MUST surface the typed empty-reply error
    /// BEFORE the single trailing `llm-done`.
    ///
    /// A bare `["llm-done"]` — the pre-change behaviour this lever was chosen to
    /// expose — is the FAIL this pin rejects.
    #[tokio::test]
    async fn a_length_limited_turn_with_no_content_settles_with_the_empty_reply_error() {
        let registry = SkillRegistry::with_open_app();
        let sink = RecordingSink::new();
        run(&registry, vec![ScriptedResponse::finish_only("length")], &sink).await;

        assert_settles_once(&sink, "length-limited empty turn");
        assert_eq!(
            sink.names(),
            vec!["llm-error", "llm-done"],
            "the empty turn emits the typed error before the single terminator"
        );
        assert_eq!(
            sink.payloads("llm-error"),
            vec![EMPTY_REPLY_DETAIL.to_string()],
            "the detail is the shipped EMPTY_REPLY_DETAIL, byte for byte (never a paraphrase)"
        );
    }

    /// An EARLY STOP (`length`) with partial content settles once: the partial
    /// text streams, then the single terminator — no "streaming forever".
    #[tokio::test]
    async fn an_early_stop_settles_once_with_its_partial_content() {
        let registry = SkillRegistry::with_open_app();
        let sink = RecordingSink::new();
        run(
            &registry,
            vec![ScriptedResponse::ok(vec![
                StreamFrame {
                    events: vec![StreamEvent::Delta("half a rep".to_string())],
                    finish_reason: None,
                    reasoning: None,
                },
                finished("length"),
            ])],
            &sink,
        )
        .await;

        assert_settles_once(&sink, "early stop");
        assert_eq!(sink.payloads("llm-token"), vec!["half a rep"]);
        assert_eq!(sink.count("llm-skill-call"), 0);
    }

    /// A MULTI-CHUNK content turn still forwards each delta exactly once and
    /// settles once — the single-frame pins cannot see a duplicate/emission bug.
    #[tokio::test]
    async fn a_multi_chunk_content_turn_settles_once_with_every_delta() {
        let registry = SkillRegistry::with_open_app();
        let sink = RecordingSink::new();
        run(
            &registry,
            vec![ScriptedResponse::content_chunks(&["a", "b", "c"])],
            &sink,
        )
        .await;

        assert_settles_once(&sink, "multi-chunk content");
        assert_eq!(sink.payloads("llm-token"), vec!["a", "b", "c"]);
    }

    /// The content-only entry also settles exactly once — the plain path the
    /// status retry uses.
    #[tokio::test]
    async fn the_plain_stream_settles_once_on_success_and_failure() {
        for (label, response) in [
            ("plain success", ScriptedResponse::content("hi")),
            ("plain failure", ScriptedResponse::failed("engine stopped")),
        ] {
            let sink = RecordingSink::new();
            let source = ScriptedTurnSource::new(vec![response]);
            let mut settled = SettledStream::new(&sink);
            stream_plain_turn(&source, &mut settled, ChatTurn::text(vec![]))
                .await
                .expect("the plain path settles instead of erroring");
            settled.finish();
            assert_settles_once(&sink, label);
            assert_eq!(sink.count("llm-skill-call"), 0, "{label}");
        }
    }

    /// AC-2 / R-2 positive control — `stream_plain_turn` carries the SAME
    /// empty-turn guarantee as the skill path: a content-only turn that produced
    /// no visible content settles `[llm-error, llm-done]` with the SHIPPED
    /// `EMPTY_REPLY_DETAIL`.
    #[tokio::test]
    async fn a_plain_turn_with_no_content_settles_with_the_empty_reply_error() {
        let sink = RecordingSink::new();
        let source = ScriptedTurnSource::new(vec![ScriptedResponse::finish_only("length")]);
        let mut settled = SettledStream::new(&sink);
        stream_plain_turn(&source, &mut settled, ChatTurn::text(vec![]))
            .await
            .expect("the plain path settles instead of erroring");
        settled.finish();

        assert_settles_once(&sink, "plain empty turn");
        assert_eq!(
            sink.names(),
            vec!["llm-error", "llm-done"],
            "the plain path never terminates an empty turn silently"
        );
        assert_eq!(
            sink.payloads("llm-error"),
            vec![EMPTY_REPLY_DETAIL.to_string()]
        );
    }

    /// The typed path's turn really offers the registry (a non-vacuity control
    /// for the settle pins above, which drive `stream_skill_turn` directly).
    #[test]
    fn the_production_skill_turn_offers_the_registry() {
        let registry = SkillRegistry::with_app_control();
        let turn = skill_turn(
            vec![message("user", "open Settings")],
            &registry,
            None,
            None,
        );
        assert!(turn.offer_tools);
        assert_eq!(turn.tools.len(), registry.list().count());
        assert_eq!(turn.tool_choice.as_deref(), Some(TOOL_CHOICE_AUTO));
        assert!(turn.audio.is_none());
        assert!(turn.json_schema.is_none());
    }

    /// The audio turn carries the clip and offers the SAME registry.
    #[test]
    fn the_audio_skill_turn_carries_the_clip_and_the_offer() {
        let registry = SkillRegistry::with_app_control();
        let turn = skill_turn(vec![message("user", "")], &registry, Some("UklGRg=="), None);
        assert!(turn.offer_tools);
        assert_eq!(turn.audio.as_deref(), Some("UklGRg=="));
        assert!(turn.image.is_none());
    }

    /// The image turn carries the image (never audio) on the same offer.
    #[test]
    fn the_image_skill_turn_carries_the_image_and_the_offer() {
        let registry = SkillRegistry::with_app_control();
        let turn = skill_turn(vec![message("user", "look")], &registry, None, Some("QUJD"));
        assert!(turn.offer_tools);
        assert_eq!(turn.image.as_deref(), Some("QUJD"));
        assert!(turn.audio.is_none());
    }
}

/// Stream one skill-aware generation: content deltas → `llm-token`; tool calls
/// buffered; at the finish the selection is validated and routed.
async fn run_skill_chat(app: &AppHandle, messages: Vec<LlmMessage>) -> Result<(), String> {
    // Spec #3073 ST-2 (R-2): the registry SOURCE is the ONE shared accessor, so
    // this second same-content construction site can never drift from the live
    // companion offer. The offer is the shipped static three and nothing
    // generated (Spec #3152).
    let registry = super::status::companion_skill_registry();
    let turn = skill_turn(messages, &registry, None, None);
    run_skill_stream(app, &registry, turn).await
}

/// Kick off a skill-aware streaming chat on a background task and return
/// immediately (never blocks the IPC call).
///
/// `run_skill_chat` owns the settle, so nothing here can double-settle: it
/// either emits through the shared terminal plan or through its own failure
/// branch, and its `SettledStream` guarantees exactly one trailing `llm-done`.
pub fn spawn_chat_with_skills(app: AppHandle, messages: Vec<LlmMessage>) {
    tauri::async_runtime::spawn(async move {
        let _ = run_skill_chat(&app, messages).await;
    });
}

/// Stream a companion chat with the companion skill registry offered to the
/// model (Spec #2893, ST-5).
///
/// Additive to `llm_chat` / `llm_chat_with_image`, whose payload shapes stay
/// byte-identical.
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

    fn fragment(index: usize, name: Option<&str>, arguments: Option<&str>) -> StreamEvent {
        StreamEvent::ToolCallDelta {
            index,
            name: name.map(str::to_string),
            arguments_fragment: arguments.map(str::to_string),
        }
    }

    /// The pure wire-shape view of the offer the production turn renders
    /// ([`skill_turn`]), retained so the payload pins can assert the shipped shape
    /// byte-for-byte. Test-only: production shapes a `ChatTurn` directly.
    fn build_skill_request_body(messages: &[LlmMessage], registry: &SkillRegistry) -> Value {
        crate::applications::llm_server::chat::build_tools_request_body(
            messages,
            &render_tools(registry),
            TOOL_CHOICE_AUTO,
            PARALLEL_TOOL_CALLS,
        )
    }

    /// The pure wire-shape view of a model-audio skill turn (Spec #2903): the clip
    /// rides as exactly one `input_audio` part on the LAST user message and never a
    /// `text` part (#2897 REQ-3), with the SAME registry offer as the typed path.
    fn build_audio_skill_request_body(
        messages: &[LlmMessage],
        audio_base64: &str,
        registry: &SkillRegistry,
    ) -> Value {
        let mut body = serde_json::json!({
            "messages": crate::applications::llm_server::chat::render_messages(
                messages,
                None,
                Some(audio_base64),
            ),
            "stream": true,
            "max_tokens": crate::applications::llm_server::chat::MAX_TOKENS,
        });
        body["tools"] = render_tools(registry);
        body["tool_choice"] = Value::String(TOOL_CHOICE_AUTO.to_string());
        body["parallel_tool_calls"] = Value::Bool(PARALLEL_TOOL_CALLS);
        body
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
            accumulator.push(StreamEvent::Delta("Hello".to_string())),
            Some("Hello".to_string())
        );
        // Raw tool-call fragments and the terminator are never tokens.
        assert_eq!(accumulator.push(fragment(0, Some("open_app"), Some("{}"))), None);
        assert_eq!(accumulator.push(StreamEvent::Done), None);
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

    /// Spec #3233 (AC-2) — `content_seen` is TRUE only after a NON-EMPTY content
    /// delta: a tool-call fragment and an empty delta are not visible content.
    #[test]
    fn content_seen_tracks_only_non_empty_content_deltas() {
        let mut accumulator = ToolCallAccumulator::new();
        assert!(!accumulator.content_seen(), "a fresh accumulator saw no content");

        // A buffered tool-call fragment is NOT visible content.
        accumulator.push(fragment(0, Some("open_app"), Some("{}")));
        assert!(!accumulator.content_seen(), "a tool-call fragment is not content");

        // An EMPTY delta is not visible content (the settle guard drops it).
        accumulator.push(StreamEvent::Delta(String::new()));
        assert!(!accumulator.content_seen(), "an empty delta is not visible content");

        // A non-empty delta IS visible content.
        assert_eq!(
            accumulator.push(StreamEvent::Delta("hello".to_string())),
            Some("hello".to_string())
        );
        assert!(accumulator.content_seen());
    }

    /// Adjudication #3 — the frontend copy branch matches `/no visible reply/i`,
    /// so `EMPTY_REPLY_DETAIL` MUST carry the exact phrase `no visible reply`
    /// (case-sensitive). A later reword that drops it would silently disable the
    /// branch; this pin reddens first.
    #[test]
    fn the_empty_reply_detail_carries_the_discriminator_phrase() {
        assert!(
            EMPTY_REPLY_DETAIL.contains("no visible reply"),
            "the frontend discriminator phrase is missing: {EMPTY_REPLY_DETAIL}"
        );
    }

    /// Spec #3233 (AC-2) — the terminal plan emits the typed empty-reply error
    /// for a contentless, call-less, non-tool-call turn, and NOT for a content
    /// turn (R-5: nothing else moved).
    #[test]
    fn an_empty_turn_plans_the_empty_reply_error_and_a_content_turn_does_not() {
        let registry = SkillRegistry::with_open_app();

        let empty = ToolCallAccumulator::new();
        assert_eq!(
            plan_terminal_events(&registry, &empty),
            vec![
                TerminalEvent::Error(EMPTY_REPLY_DETAIL.to_string()),
                TerminalEvent::Done,
            ]
        );

        let mut content = ToolCallAccumulator::new();
        content.push(StreamEvent::Delta("hi".to_string()));
        content.set_finish_reason("stop");
        assert_eq!(
            plan_terminal_events(&registry, &content),
            vec![TerminalEvent::Done]
        );
    }

    /// Spec #3233 — `is_empty_reply_event` matches ONLY the empty-turn
    /// guarantee's own detail, so the schema status attempt can defer exactly
    /// that event and keep its own retry (Risk 6).
    #[test]
    fn the_empty_reply_event_predicate_matches_only_its_own_detail() {
        assert!(is_empty_reply_event(&TerminalEvent::Error(
            EMPTY_REPLY_DETAIL.to_string()
        )));
        assert!(!is_empty_reply_event(&TerminalEvent::Error(
            TOOL_CALL_TURN_WITHOUT_CALL_DETAIL.to_string()
        )));
        assert!(!is_empty_reply_event(&TerminalEvent::Done));
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
            accumulator.push(StreamEvent::Delta("Hello ".to_string())),
            Some("Hello ".to_string())
        );
        assert_eq!(
            accumulator.push(StreamEvent::Delta("there".to_string())),
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
            accumulator.push(StreamEvent::Delta(format!("reply about {message}: ")));
            accumulator.push(StreamEvent::Delta("the normal chat reply".to_string()));
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
        content.push(StreamEvent::Delta("hello".to_string()));
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
            serde_json::json!([crate::applications::llm_server::chat::audio_content_part(
                "UklGRg=="
            )]);
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
            accumulator.push(StreamEvent::Delta(format!("reply about {message}: ")));
            accumulator.push(StreamEvent::Delta("the normal chat reply".to_string()));
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
