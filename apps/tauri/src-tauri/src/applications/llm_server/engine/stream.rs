//! The streaming event contract between the in-process engine and the shipped
//! `llm-*` webview channels (Spec #3141, ST-3; EARS R-26.1–R-26.3).
//!
//! ## What this replaces
//!
//! The retired transport parsed `llama-server`'s SSE frames and every consumer
//! mapped `delta.content` / `delta.tool_calls` onto the event vocabulary itself.
//! In-process there is no wire format to parse: the engine thread generates, and
//! this module owns the ONE translation from what the engine produced to what a
//! consumer consumes, plus the ONE terminal-settle guarantee.
//!
//! Two vocabularies, deliberately distinct:
//!
//! * [`EngineEvent`] — what the **engine thread** produces for one turn
//!   (`Token` / `Reasoning` / `ToolCall` / `Finished` / `Failed`). It carries no
//!   webview names, so the engine can never invent a channel.
//! * [`WireEvent`] — the **shipped channels** the webview listens on
//!   (`llm-token`, `llm-status`, `llm-skill-call`, `llm-error`, `llm-done`).
//!   [`WireEvent::name`] is the only place those literals are resolved, so the
//!   payload shapes frozen by R-26.1 cannot drift per call site.
//!
//! [`StreamFrame`] / [`StreamEvent`] are the consumer-facing view of one engine
//! event — the relocated shape the retired `ChatSseFrame` / `ChatStreamEvent`
//! had, so every consumer's accumulate/validate logic stays byte-identical.
//!
//! ## The terminal-settle guarantee (R-26.2)
//!
//! [`SettledStream`] is the ONE emit site a live path may use. It enforces:
//!
//! * **exactly one** `llm-done` per turn — a second [`SettledStream::finish`] is
//!   a no-op;
//! * **always last** — every emission after `llm-done` is dropped, so a late
//!   token or error can never follow the terminator;
//! * **never hangs** — its `Drop` settles the turn, so any early `return`, `?`
//!   path or dropped future still terminates the turn exactly once.
//!
//! ## The turn source seam
//!
//! [`TurnSource`] is what a path streams through: production uses
//! [`EngineTurnSource`] (which drives one `EngineCommand::Chat` on the engine
//! thread), and the settle pins drive the REAL path functions against
//! [`testing::ScriptedTurnSource`]. That is what makes "exactly one `llm-done`,
//! last" a property of the shipped code rather than of a mock.

use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use tauri::{AppHandle, Emitter};

use super::request::ChatTurn;
use super::CompanionEngineErrorCode;

/// The shipped content channel (`llm-token`, payload: the delta string).
pub const LLM_TOKEN_EVENT: &str = "llm-token";
/// The shipped status channel (`llm-status`, payload: the status string).
pub const LLM_STATUS_EVENT: &str = "llm-status";
/// The shipped skill channel (`llm-skill-call`, payload: `{ skill, arguments }`).
pub const LLM_SKILL_CALL_EVENT: &str = "llm-skill-call";
/// The shipped readable-error channel (`llm-error`, payload: the detail string).
pub const LLM_ERROR_EVENT: &str = "llm-error";
/// The shipped terminator (`llm-done`, empty payload).
pub const LLM_DONE_EVENT: &str = "llm-done";

/// The bounded buffer between the engine thread and the async consumer.
///
/// A turn emits at most one event per sampled token (bounded by the sampler's
/// `max_tokens`), and the consumer drains while it awaits, so the bound only ever
/// applies backpressure — it can never deadlock a turn.
pub const ENGINE_EVENT_BUFFER: usize = 64;

/// The control-token prefix of the pinned template family.
///
/// A rendered tool-call body begins with a control marker (`<|tool_call>…`). A
/// user-visible reply never starts one, so a tool-offering turn withholds
/// everything from the first occurrence and decides at the finish whether it was
/// a call body (dropped) or ordinary content (released).
pub const CONTROL_TOKEN_PREFIX: &str = "<|";

// ── Engine → application layer ───────────────────────────────────────────────

/// One piece of a streaming turn as the ENGINE produced it.
///
/// Deliberately channel-free: the engine names no webview event.
#[derive(Debug, Clone, PartialEq)]
pub enum EngineEvent {
    /// Completed assistant text (never raw tool-call JSON).
    Token(String),
    /// A model reasoning chunk. Never forwarded to the webview; the Doom dataset
    /// seam captures it when its own env flag is set.
    Reasoning(String),
    /// One tool call the template's OWN reverse parser decoded.
    ///
    /// `arguments` is the decoded call's raw argument JSON string (parsed exactly
    /// once at the finish by the shipped accumulator), never a per-token
    /// fragment.
    ToolCall {
        /// The call's index in the template's decoded call list.
        index: usize,
        /// The decoded function name (absent when the template produced none).
        name: Option<String>,
        /// The decoded argument JSON string (absent when the call carried none).
        arguments: Option<String>,
    },
    /// The turn ended. `finish_reason` is `tool_calls` / `stop` / `length`.
    Finished {
        /// The retired server's finish-reason vocabulary.
        finish_reason: Option<String>,
        /// Whether the model ended the turn itself (an end-of-generation token).
        stopped_on_eog: bool,
    },
    /// The turn failed with a typed code and curated detail.
    Failed {
        /// The typed failure (logged; the consumer sees the curated detail).
        code: CompanionEngineErrorCode,
        /// Curated, actionable detail.
        detail: String,
    },
}

// ── Application layer → consumers (the relocated SSE-shape view) ──────────────

/// One decoded event a consumer sees (the relocated `ChatStreamEvent`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamEvent {
    /// A content delta to forward as `llm-token`.
    Delta(String),
    /// One fragment of a model-selected tool call.
    ///
    /// Raw tool-call text is NEVER forwarded as `llm-token`; consumers buffer the
    /// fragments verbatim and parse ONCE at the finish.
    ToolCallDelta {
        /// The call index the fragment belongs to.
        index: usize,
        /// The function name, present only on the opening fragment.
        name: Option<String>,
        /// A raw piece of the argument JSON.
        arguments_fragment: Option<String>,
    },
    /// The terminal event: the turn's stream is complete.
    Done,
}

/// One frame's worth of stream events, plus the turn's terminal metadata.
///
/// The relocated `ChatSseFrame`: a single engine event maps onto one frame, so a
/// consumer's `for event in frame.events` / `finish_reason` / `reasoning`
/// handling is unchanged.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct StreamFrame {
    /// The events carried by this frame.
    pub events: Vec<StreamEvent>,
    /// The turn's finish reason, when this frame is the terminal one.
    pub finish_reason: Option<String>,
    /// The frame's reasoning text, when the engine surfaced any.
    pub reasoning: Option<String>,
}

impl EngineEvent {
    /// The model's reasoning text from a template-parsed assistant body, when the
    /// template's own parser separated one.
    ///
    /// llama.cpp's chat template declares the reasoning channel (`reasoning_content`
    /// on the current family, `reasoning` on the legacy one). The engine's decoder
    /// releases user-visible text only, so this is where the hidden channel is
    /// recovered — by the SAME parser that produced the call list, never a
    /// hand-written prefix heuristic.
    pub fn reasoning_from_parsed(parsed: &str) -> Option<String> {
        let value: serde_json::Value = serde_json::from_str(parsed).ok()?;
        let reasoning = value
            .get("reasoning_content")
            .and_then(serde_json::Value::as_str)
            .or_else(|| value.get("reasoning").and_then(serde_json::Value::as_str))
            .unwrap_or_default();
        (!reasoning.is_empty()).then(|| reasoning.to_string())
    }
}

impl StreamFrame {
    /// Translate one engine event into the consumer-facing frame.
    ///
    /// A [`EngineEvent::Failed`] is deliberately NOT a frame: a failed turn is the
    /// `Err` return of [`TurnSource::stream`], so a consumer cannot mistake it for
    /// content.
    fn from_engine(event: EngineEvent) -> Self {
        match event {
            EngineEvent::Token(text) => Self {
                events: vec![StreamEvent::Delta(text)],
                finish_reason: None,
                reasoning: None,
            },
            EngineEvent::Reasoning(text) => Self {
                events: Vec::new(),
                finish_reason: None,
                reasoning: Some(text),
            },
            EngineEvent::ToolCall {
                index,
                name,
                arguments,
            } => Self {
                events: vec![StreamEvent::ToolCallDelta {
                    index,
                    name,
                    arguments_fragment: arguments,
                }],
                finish_reason: None,
                reasoning: None,
            },
            EngineEvent::Finished { finish_reason, .. } => Self {
                events: vec![StreamEvent::Done],
                finish_reason,
                reasoning: None,
            },
            EngineEvent::Failed { .. } => Self::default(),
        }
    }
}

// ── The shipped wire vocabulary + its ONE emit site ──────────────────────────

/// One emission on a shipped `llm-*` channel.
#[derive(Debug, Clone, PartialEq)]
pub enum WireEvent {
    /// `llm-token` — the delta string.
    Token(String),
    /// `llm-status` — the status string.
    Status(String),
    /// `llm-skill-call` — a VALIDATED selection.
    SkillCall(crate::applications::llm_server::skills::SkillCall),
    /// `llm-error` — the readable detail string.
    Error(String),
    /// `llm-done` — the terminator (empty payload).
    Done,
}

impl WireEvent {
    /// The shipped channel name for this event.
    ///
    /// Read by the settle pins, which assert a path's ordered channel sequence;
    /// production names each channel once in [`AppSink`]'s delivery match (each
    /// variant needs its OWN payload type there, so a shared accessor would not
    /// carry the payload).
    #[cfg(test)]
    pub fn name(&self) -> &'static str {
        match self {
            Self::Token(_) => LLM_TOKEN_EVENT,
            Self::Status(_) => LLM_STATUS_EVENT,
            Self::SkillCall(_) => LLM_SKILL_CALL_EVENT,
            Self::Error(_) => LLM_ERROR_EVENT,
            Self::Done => LLM_DONE_EVENT,
        }
    }

    /// The payload as the webview receives it, rendered for the settle pins.
    ///
    /// Every channel but `llm-done` carries a string; `llm-skill-call` carries the
    /// serialized selection and `llm-done` carries nothing.
    #[cfg(test)]
    pub fn payload(&self) -> String {
        match self {
            Self::Token(text) | Self::Status(text) | Self::Error(text) => text.clone(),
            Self::SkillCall(call) => serde_json::to_string(call).unwrap_or_default(),
            Self::Done => String::new(),
        }
    }
}

/// Where a turn's wire events go.
///
/// Production uses [`AppSink`]; the settle pins use a recording sink, so the
/// shipped paths run with no `AppHandle` at all.
pub trait EventSink: Send + Sync {
    /// Deliver one event on its shipped channel.
    fn emit(&self, event: WireEvent);
}

/// The production sink: emits each event on its shipped `llm-*` channel.
pub struct AppSink<'a> {
    app: &'a AppHandle,
}

impl<'a> AppSink<'a> {
    /// Wrap an application handle.
    pub fn new(app: &'a AppHandle) -> Self {
        Self { app }
    }
}

impl EventSink for AppSink<'_> {
    fn emit(&self, event: WireEvent) {
        // A closed window drops the delivery; it must never abort the turn.
        match event {
            WireEvent::Token(text) => {
                let _ = self.app.emit(LLM_TOKEN_EVENT, text);
            }
            WireEvent::Status(status) => {
                let _ = self.app.emit(LLM_STATUS_EVENT, status);
            }
            WireEvent::SkillCall(call) => {
                let _ = self.app.emit(LLM_SKILL_CALL_EVENT, call);
            }
            WireEvent::Error(detail) => {
                let _ = self.app.emit(LLM_ERROR_EVENT, detail);
            }
            WireEvent::Done => {
                let _ = self.app.emit(LLM_DONE_EVENT, ());
            }
        }
    }
}

/// The ONE emit site for a streaming turn: exactly one terminal `llm-done`,
/// always last, on every path — including a dropped future.
///
/// Only the outermost path function constructs one; inner helpers take `&mut` so
/// they can emit but the settle stays owned by the caller.
pub struct SettledStream<'a> {
    sink: &'a dyn EventSink,
    /// Whether the single `llm-done` has been emitted (nothing follows it).
    done: bool,
    /// Whether the `Drop` impl should settle the turn. Cleared by
    /// [`Self::hand_over`], which transfers the turn to a replacing attempt.
    armed: bool,
}

impl<'a> SettledStream<'a> {
    /// Wrap a sink. The turn is unsettled and armed until [`Self::finish`] (or
    /// `Drop`).
    pub fn new(sink: &'a dyn EventSink) -> Self {
        Self {
            sink,
            done: false,
            armed: true,
        }
    }

    /// Emit one event unless the turn already settled.
    fn emit(&mut self, event: WireEvent) {
        if self.done {
            return;
        }
        if matches!(event, WireEvent::Done) {
            self.done = true;
        }
        self.sink.emit(event);
    }

    /// Forward one content delta (`llm-token`). An empty delta is not an event.
    pub fn token(&mut self, text: impl Into<String>) {
        let text = text.into();
        if !text.is_empty() {
            self.emit(WireEvent::Token(text));
        }
    }

    /// Emit the turn's status (`llm-status`).
    pub fn status(&mut self, status: impl Into<String>) {
        self.emit(WireEvent::Status(status.into()));
    }

    /// Emit a validated skill selection (`llm-skill-call`).
    pub fn skill_call(&mut self, call: crate::applications::llm_server::skills::SkillCall) {
        self.emit(WireEvent::SkillCall(call));
    }

    /// Emit a readable failure (`llm-error`).
    pub fn error(&mut self, detail: impl Into<String>) {
        self.emit(WireEvent::Error(detail.into()));
    }

    /// Settle the turn with exactly one `llm-done`. Idempotent.
    pub fn finish(&mut self) {
        self.emit(WireEvent::Done);
    }

    /// Give up ownership of this attempt WITHOUT settling it.
    ///
    /// This is the ONE case a guard is disarmed: the bounded plain retry
    /// (R-5/R-6) abandons an attempt and runs the SAME turn again, so the turn has
    /// not ended and issuing `llm-done` here would double-settle it. The guard
    /// stays ARMED for normal emission (so the replacing attempt can still use
    /// it), only the `Drop` auto-settle is suppressed — and the caller explicitly
    /// `finish`es when the turn really ends.
    pub fn hand_over(&mut self) {
        self.armed = false;
    }

    /// Whether the turn has already settled (test observability).
    #[cfg(test)]
    pub fn settled(&self) -> bool {
        self.done
    }
}

impl Drop for SettledStream<'_> {
    fn drop(&mut self) {
        // The never-hang guarantee: an early return, a `?` exit or a dropped
        // future still terminates the turn exactly once — unless a replacing
        // attempt has taken the turn over ([`SettledStream::hand_over`]).
        if self.armed {
            self.finish();
        }
    }
}

// ── The turn source seam ─────────────────────────────────────────────────────

/// One streaming turn's source: the frames, in order.
///
/// `Err` is an engine/transport failure — every caller settles it as `llm-error`
/// followed by the single trailing `llm-done`.
#[async_trait]
pub trait TurnSource: Send + Sync {
    /// Run one turn, delivering each frame to `on_frame` in order.
    async fn stream(
        &self,
        turn: ChatTurn,
        on_frame: &mut (dyn FnMut(StreamFrame) + Send),
    ) -> Result<(), String>;
}

/// One bounded single reply's source (the Doom decision path).
#[async_trait]
pub trait OneShotSource: Send + Sync {
    /// Run one turn and return its whole reply.
    async fn one_shot(&self, turn: ChatTurn) -> Result<TurnReply, String>;
}

/// The whole reply of one bounded turn.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TurnReply {
    /// The assistant text.
    pub content: String,
    /// The model's reasoning text, when the engine surfaced any.
    pub reasoning: String,
}

/// The production turn source: one `EngineCommand::Chat` on the engine thread.
///
/// Every `llm_*` consumer streams through this ONE adapter, so the channel
/// plumbing (bounded backpressure, cancellation, failure mapping) exists once.
pub struct EngineTurnSource {
    handle: std::sync::Arc<super::handle::CompanionEngineHandle>,
    paths: super::paths::EnginePaths,
    mode: super::CompanionBackendMode,
}

impl EngineTurnSource {
    /// Build a source over `handle`, carrying the paths + mode a lazily-started
    /// engine needs.
    pub fn new(
        handle: std::sync::Arc<super::handle::CompanionEngineHandle>,
        paths: super::paths::EnginePaths,
        mode: super::CompanionBackendMode,
    ) -> Self {
        Self {
            handle,
            paths,
            mode,
        }
    }

    /// Build the source for `app` from its managed engine handle, resolved model
    /// paths, and persisted backend mode.
    ///
    /// Every live consumer builds its source here, so the handle/paths/mode
    /// lookup exists once. A missing handle or unresolved model files is a typed
    /// refusal the caller settles as `llm-error` + `llm-done`.
    pub fn for_app(
        app: &tauri::AppHandle,
    ) -> Result<Self, (CompanionEngineErrorCode, String)> {
        use tauri::Manager;
        let handle = app
            .try_state::<crate::applications::llm_server::commands::CompanionEngineState>()
            .map(|state| std::sync::Arc::clone(&state.0))
            .ok_or((
                CompanionEngineErrorCode::BackendInitFailed,
                "the companion engine is not available. Restart Fredo and try again.".to_string(),
            ))?;
        let paths = super::paths::resolve_for_handle(app)?;
        let mode = crate::applications::llm_server::commands::backend_mode(app);
        Ok(Self::new(handle, paths, mode))
    }
}

#[async_trait]
impl TurnSource for EngineTurnSource {
    async fn stream(
        &self,
        turn: ChatTurn,
        on_frame: &mut (dyn FnMut(StreamFrame) + Send),
    ) -> Result<(), String> {
        let (events, mut received) = tokio::sync::mpsc::channel(ENGINE_EVENT_BUFFER);
        let request = super::ChatRequest {
            turn,
            events,
            paths: self.paths.clone(),
            mode: self.mode,
            seed: fresh_seed(),
        };
        self.handle
            .chat(request)
            .map_err(|(code, detail)| failed(code, &detail, "refused a turn"))?;

        drain_turn(&mut received, on_frame).await
    }
}

/// Drain one turn's engine events into frames, requiring a terminal `Finished`.
///
/// A turn is complete only when the engine sent [`EngineEvent::Finished`]. The
/// channel closing WITHOUT one is never success (Spec #3141 fix F1): a dead or
/// panicked engine used to look like a normal completion, so the stream settled
/// with a bare `llm-done` and NO `llm-error`. Extracted from
/// [`EngineTurnSource::stream`] so the settle contract is pinned directly against
/// a real channel, with no model and no `AppHandle`.
///
/// # Errors
///
/// The typed [`EngineEvent::Failed`] detail, or a curated "stopped before the turn
/// finished" sentence when the channel closed with no `Finished` and no failure.
async fn drain_turn(
    received: &mut tokio::sync::mpsc::Receiver<EngineEvent>,
    on_frame: &mut (dyn FnMut(StreamFrame) + Send),
) -> Result<(), String> {
    let mut finished = false;
    while let Some(event) = received.recv().await {
        match event {
            EngineEvent::Failed { code, detail } => {
                return Err(failed(code, &detail, "failed a turn"));
            }
            event => {
                if matches!(event, EngineEvent::Finished { .. }) {
                    finished = true;
                }
                on_frame(StreamFrame::from_engine(event));
            }
        }
    }
    if finished {
        Ok(())
    } else {
        Err(failed(
            CompanionEngineErrorCode::BackendInitFailed,
            "the companion engine stopped before the turn finished. \
             Start the engine again and retry.",
            "ended a turn early",
        ))
    }
}

/// The production one-shot source: one `EngineCommand::OneShot` on the engine
/// thread.
pub struct EngineOneShotSource {
    handle: std::sync::Arc<super::handle::CompanionEngineHandle>,
    paths: super::paths::EnginePaths,
    mode: super::CompanionBackendMode,
}

impl EngineOneShotSource {
    /// Build a one-shot source over `handle`.
    pub fn new(
        handle: std::sync::Arc<super::handle::CompanionEngineHandle>,
        paths: super::paths::EnginePaths,
        mode: super::CompanionBackendMode,
    ) -> Self {
        Self {
            handle,
            paths,
            mode,
        }
    }

    /// Build the source for `app` from its managed engine handle, resolved model
    /// paths, and persisted backend mode — the SAME lookup the streaming source
    /// uses, so the two adapters can never resolve different engine instances.
    pub fn for_app(
        app: &tauri::AppHandle,
    ) -> Result<Self, (CompanionEngineErrorCode, String)> {
        use tauri::Manager;
        let handle = app
            .try_state::<crate::applications::llm_server::commands::CompanionEngineState>()
            .map(|state| std::sync::Arc::clone(&state.0))
            .ok_or((
                CompanionEngineErrorCode::BackendInitFailed,
                "the companion engine is not available. Restart Fredo and try again.".to_string(),
            ))?;
        let paths = super::paths::resolve_for_handle(app)?;
        let mode = crate::applications::llm_server::commands::backend_mode(app);
        Ok(Self::new(handle, paths, mode))
    }
}

#[async_trait]
impl OneShotSource for EngineOneShotSource {
    async fn one_shot(&self, turn: ChatTurn) -> Result<TurnReply, String> {
        let (reply, received) = tokio::sync::oneshot::channel();
        let request = super::OneShotRequest {
            turn,
            reply,
            paths: self.paths.clone(),
            mode: self.mode,
            seed: fresh_seed(),
        };
        self.handle
            .one_shot(request)
            .map_err(|(code, detail)| failed(code, &detail, "refused a one-shot turn"))?;
        match received.await {
            Ok(Ok(reply)) => Ok(reply),
            Ok(Err((code, detail))) => Err(failed(code, &detail, "failed a one-shot turn")),
            // A DROPPED reply channel means the engine thread went away mid-turn
            // (a caught panic, or the thread ending). That is never a default
            // empty reply — it is a typed failure (Spec #3141 fix F1: a dead
            // engine must not look like an empty success).
            Err(_) => Err(failed(
                CompanionEngineErrorCode::BackendInitFailed,
                "the companion engine stopped before the turn finished. \
                 Start the engine again and retry.",
                "ended a one-shot turn early",
            )),
        }
    }
}

/// Log a typed engine failure and render its curated detail for the turn.
fn failed(code: CompanionEngineErrorCode, detail: &str, what: &str) -> String {
    tracing::warn!(
        target: "fredo::llm_server",
        ?code,
        detail,
        what,
        "companion engine turn"
    );
    detail.to_string()
}

/// A fresh distribution seed per turn (the retired path had no fixed seed).
fn fresh_seed() -> u32 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.subsec_nanos())
        .unwrap_or(0)
}

// ── The live-stream content gate (pure) ──────────────────────────────────────

/// Separates a turn's user-visible content from its tool-call body while the
/// model streams.
///
/// A tool-offering turn can end in a call, whose body must never reach
/// `llm-token` (R-26.3). The gate therefore withholds everything from the first
/// [`CONTROL_TOKEN_PREFIX`] occurrence onward and releases only the text before
/// it; [`Self::flush`] decides at the finish — once the template's OWN reverse
/// parser has classified the reply — whether the withheld text was a call body
/// (dropped) or ordinary content (released).
///
/// A turn that offers no tools has no gate: every character is content.
#[derive(Debug, Clone)]
pub struct ContentGate {
    raw: String,
    emitted: usize,
    hold: Option<&'static str>,
}

impl ContentGate {
    /// A gate for a turn that offers tools.
    pub fn for_tool_turn() -> Self {
        Self {
            raw: String::new(),
            emitted: 0,
            hold: Some(CONTROL_TOKEN_PREFIX),
        }
    }

    /// A gate for a turn that offers no tools (everything is content).
    pub fn for_content_turn() -> Self {
        Self {
            raw: String::new(),
            emitted: 0,
            hold: None,
        }
    }

    /// Append one released piece and return the newly user-visible text.
    ///
    /// Returns an empty string when the piece only advanced withheld text (that
    /// means "hold", not "nothing arrived").
    pub fn push(&mut self, piece: &str) -> String {
        self.raw.push_str(piece);
        let visible_end = self.visible_end();
        if visible_end <= self.emitted {
            return String::new();
        }
        let delta = self.raw[self.emitted..visible_end].to_string();
        self.emitted = visible_end;
        delta
    }

    /// The whole raw text the model produced (what the reverse parser decodes).
    pub fn raw(&self) -> &str {
        &self.raw
    }

    /// Release every withheld character (the turn was content, not a call).
    ///
    /// Returns an empty string when nothing was withheld.
    pub fn flush(&mut self) -> String {
        if self.emitted >= self.raw.len() {
            return String::new();
        }
        let tail = self.raw[self.emitted..].to_string();
        self.emitted = self.raw.len();
        tail
    }

    /// The byte offset up to which the raw text is safe to forward.
    fn visible_end(&self) -> usize {
        let Some(marker) = self.hold else {
            return self.raw.len();
        };
        if let Some(index) = self.raw.find(marker) {
            return index;
        }
        // A marker SPLIT across two pieces must not leak its prefix: hold back a
        // trailing proper prefix of the marker. Every marker byte is ASCII, so
        // trimming it keeps the offset on a character boundary.
        let bytes = self.raw.as_bytes();
        let marker_bytes = marker.as_bytes();
        for length in (1..marker_bytes.len()).rev() {
            if bytes.ends_with(&marker_bytes[..length]) {
                return self.raw.len() - length;
            }
        }
        self.raw.len()
    }
}

/// Decode the template's parsed assistant message into tool calls.
///
/// Returns `None` when the parsed body carries no `tool_calls` array, so the
/// caller treats the turn as ordinary content. The template's own reverse parser
/// produced `parsed`, so no hand-written call heuristic exists here.
pub fn tool_calls_from_parsed(parsed: &str) -> Option<Vec<EngineEvent>> {
    let value: serde_json::Value = serde_json::from_str(parsed).ok()?;
    let calls = value.get("tool_calls")?.as_array()?;
    if calls.is_empty() {
        return None;
    }
    let decoded = calls
        .iter()
        .enumerate()
        .map(|(index, call)| {
            let function = call.get("function");
            let name = function
                .and_then(|function| function.get("name"))
                .and_then(serde_json::Value::as_str)
                .map(str::to_string);
            let arguments = function
                .and_then(|function| function.get("arguments"))
                .and_then(serde_json::Value::as_str)
                .map(str::to_string);
            EngineEvent::ToolCall {
                index,
                name,
                arguments,
            }
        })
        .collect();
    Some(decoded)
}

// ── Test doubles + the terminal-settle assertion ─────────────────────────────

#[cfg(test)]
pub(crate) mod testing {
    //! The settle-pin doubles: a recording sink and a scripted source.
    //!
    //! They are `pub(crate)` so the pins in `skills.rs` / `status.rs` /
    //! `doom_agent.rs` drive the REAL shipped path functions with no `AppHandle`
    //! and no model load, while the assertion below is written once.

    use std::collections::VecDeque;
    use std::sync::Mutex;

    use super::*;

    /// Records every wire event in emission order, so a path's settle sequence is
    /// directly assertable.
    #[derive(Debug, Default)]
    pub struct RecordingSink {
        events: Mutex<Vec<(String, String)>>,
    }

    impl RecordingSink {
        /// An empty recorder.
        pub fn new() -> Self {
            Self::default()
        }

        /// The `(channel, payload)` sequence emitted so far.
        pub fn records(&self) -> Vec<(String, String)> {
            self.events
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone()
        }

        /// The emitted channel names, in order.
        pub fn names(&self) -> Vec<String> {
            self.records().into_iter().map(|(name, _)| name).collect()
        }

        /// The payloads emitted on `channel`, in order.
        pub fn payloads(&self, channel: &str) -> Vec<String> {
            self.records()
                .into_iter()
                .filter(|(name, _)| name == channel)
                .map(|(_, payload)| payload)
                .collect()
        }

        /// How many times `channel` was emitted.
        pub fn count(&self, channel: &str) -> usize {
            self.names().iter().filter(|name| *name == channel).count()
        }
    }

    impl EventSink for RecordingSink {
        fn emit(&self, event: WireEvent) {
            if let Ok(mut guard) = self.events.lock() {
                guard.push((event.name().to_string(), event.payload()));
            }
        }
    }

    /// The terminal-settle assertion every path pin calls: exactly ONE `llm-done`
    /// and it is LAST.
    ///
    /// `label` names the path, so a failure says which one double-settled or hung.
    pub fn assert_settles_once(sink: &RecordingSink, label: &str) {
        let names = sink.names();
        assert_eq!(
            names.iter().filter(|name| *name == LLM_DONE_EVENT).count(),
            1,
            "{label}: exactly one llm-done, got {names:?}"
        );
        assert_eq!(
            names.last().map(String::as_str),
            Some(LLM_DONE_EVENT),
            "{label}: llm-done must be LAST, got {names:?}"
        );
    }

    /// One scripted source response: the frames to deliver, then the outcome.
    #[derive(Debug, Clone, Default)]
    pub struct ScriptedResponse {
        /// The frames delivered to the consumer.
        pub frames: Vec<StreamFrame>,
        /// The terminal failure, when the turn fails.
        pub failure: Option<String>,
    }

    impl ScriptedResponse {
        /// A successful response carrying `frames`.
        pub fn ok(frames: Vec<StreamFrame>) -> Self {
            Self {
                frames,
                failure: None,
            }
        }

        /// A failed response with `detail`.
        pub fn failed(detail: &str) -> Self {
            Self {
                frames: Vec::new(),
                failure: Some(detail.to_string()),
            }
        }

        /// A content-only response: `text` then a `stop` finish.
        pub fn content(text: &str) -> Self {
            Self::ok(vec![
                StreamFrame {
                    events: vec![StreamEvent::Delta(text.to_string())],
                    finish_reason: None,
                    reasoning: None,
                },
                finished("stop"),
            ])
        }

        /// A response whose frames are each DELTA fragments of one text (the
        /// multi-chunk content case a single-frame pin cannot see).
        pub fn content_chunks(chunks: &[&str]) -> Self {
            let mut frames: Vec<StreamFrame> = chunks
                .iter()
                .map(|chunk| StreamFrame {
                    events: vec![StreamEvent::Delta((*chunk).to_string())],
                    finish_reason: None,
                    reasoning: None,
                })
                .collect();
            frames.push(finished("stop"));
            Self::ok(frames)
        }

        /// A response that ends on `finish_reason` with no content and no call
        /// (the tool-call-turn-without-a-call case).
        pub fn finish_only(reason: &str) -> Self {
            Self::ok(vec![finished(reason)])
        }
    }

    /// The terminal frame for `reason`.
    pub fn finished(reason: &str) -> StreamFrame {
        StreamFrame {
            events: vec![StreamEvent::Done],
            finish_reason: Some(reason.to_string()),
            reasoning: None,
        }
    }

    /// A source whose responses are scripted, in call order.
    #[derive(Debug, Default)]
    pub struct ScriptedTurnSource {
        responses: Mutex<VecDeque<ScriptedResponse>>,
    }

    impl ScriptedTurnSource {
        /// A source that answers each call with the next scripted response.
        pub fn new(responses: Vec<ScriptedResponse>) -> Self {
            Self {
                responses: Mutex::new(responses.into_iter().collect()),
            }
        }

        /// How many responses are still queued.
        pub fn remaining(&self) -> usize {
            self.responses
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .len()
        }
    }

    #[async_trait]
    impl TurnSource for ScriptedTurnSource {
        async fn stream(
            &self,
            _turn: ChatTurn,
            on_frame: &mut (dyn FnMut(StreamFrame) + Send),
        ) -> Result<(), String> {
            let next = self
                .responses
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .pop_front();
            let Some(response) = next else {
                return Err("the scripted source has no response left".to_string());
            };
            for frame in &response.frames {
                on_frame(frame.clone());
            }
            match response.failure {
                Some(detail) => Err(detail),
                None => Ok(()),
            }
        }
    }

    /// A source that drives the REAL [`drain_turn`] over a live channel.
    ///
    /// This is what makes "a channel that closes without `Finished` is a failure"
    /// a property of the SHIPPED drain, not of a scripted oracle: the settle pins
    /// run the production error text and the production success rule.
    #[derive(Debug, Default)]
    pub struct ChannelTurnSource;

    impl ChannelTurnSource {
        /// A source that feeds `events` into [`drain_turn`] exactly once.
        pub fn new() -> Self {
            Self
        }
    }

    #[async_trait]
    impl TurnSource for ChannelTurnSource {
        async fn stream(
            &self,
            _turn: ChatTurn,
            on_frame: &mut (dyn FnMut(StreamFrame) + Send),
        ) -> Result<(), String> {
            // An EMPTY channel: the sender is already dropped, exactly what a
            // panicked engine thread leaves behind (no `Finished`, no failure
            // event).
            let (sender, mut receiver) = tokio::sync::mpsc::channel::<EngineEvent>(1);
            drop(sender);
            drain_turn(&mut receiver, on_frame).await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testing::*;
    use super::*;

    // ── The content gate (R-26.3: no raw tool-call JSON as llm-token) ────────

    #[test]
    fn a_content_turn_forwards_every_character_exactly_once() {
        let mut gate = ContentGate::for_content_turn();
        assert_eq!(gate.push("hello"), "hello");
        assert_eq!(gate.push(" there"), " there");
        assert_eq!(gate.raw(), "hello there");
        assert_eq!(gate.flush(), "");
    }

    #[test]
    fn a_tool_turn_holds_from_the_control_marker_and_keeps_the_prose() {
        let mut gate = ContentGate::for_tool_turn();
        assert_eq!(gate.push("Opening it now. "), "Opening it now. ");
        // The call body starts with the control marker and is never forwarded.
        assert_eq!(gate.push("<|tool_call>call:open_app{"), "");
        assert_eq!(gate.push("app:1}<tool_call|>"), "");
        assert_eq!(
            gate.flush(),
            "<|tool_call>call:open_app{app:1}<tool_call|>"
        );
    }

    #[test]
    fn a_marker_split_across_two_pieces_never_leaks_its_prefix() {
        let mut gate = ContentGate::for_tool_turn();
        // The trailing `<` could start a marker, so it is withheld.
        assert_eq!(gate.push("done <"), "done ");
        // The completion of the marker forwards nothing more.
        assert_eq!(gate.push("|tool_call>call:wait{"), "");
        assert_eq!(gate.flush(), "<|tool_call>call:wait{");
    }

    #[test]
    fn a_content_turn_with_no_marker_never_holds_anything_back() {
        let mut gate = ContentGate::for_tool_turn();
        let text = "a plain reply with no control tokens at all";
        assert_eq!(gate.push(text), text);
        assert_eq!(gate.flush(), "");
    }

    // ── The wire vocabulary (R-26.1: frozen names) ───────────────────────────

    #[test]
    fn the_wire_channels_keep_their_shipped_names() {
        let token = WireEvent::Token("x".to_string());
        let status = WireEvent::Status("happy".to_string());
        let error = WireEvent::Error("boom".to_string());
        let done = WireEvent::Done;
        assert_eq!(token.name(), "llm-token");
        assert_eq!(status.name(), "llm-status");
        assert_eq!(error.name(), "llm-error");
        assert_eq!(done.name(), "llm-done");
        // `llm-skill-call` is the serialized selection.
        let call = WireEvent::SkillCall(crate::applications::llm_server::skills::SkillCall {
            skill: "open_app".to_string(),
            arguments: serde_json::json!({ "app": "Settings" }),
        });
        assert_eq!(call.name(), "llm-skill-call");
        assert_eq!(
            call.payload(),
            "{\"skill\":\"open_app\",\"arguments\":{\"app\":\"Settings\"}}"
        );
        // Payload shapes: every non-terminator channel carries a string.
        assert_eq!(token.payload(), "x");
        assert_eq!(status.payload(), "happy");
        assert_eq!(error.payload(), "boom");
        assert_eq!(done.payload(), "");
    }

    // ── `SettledStream`: exactly one trailing `llm-done` ─────────────────────

    #[test]
    fn a_settled_stream_emits_exactly_one_done_and_is_idempotent() {
        let sink = RecordingSink::new();
        {
            let mut settled = SettledStream::new(&sink);
            settled.token("hello");
            settled.finish();
            // A second finish must not double-settle.
            settled.finish();
            assert!(settled.settled());
        }
        assert_settles_once(&sink, "explicit finish");
        assert_eq!(sink.names(), vec!["llm-token", "llm-done"]);
    }

    #[test]
    fn a_dropped_settled_stream_still_settles_once_last() {
        let sink = RecordingSink::new();
        {
            let mut settled = SettledStream::new(&sink);
            settled.token("partial");
            // Dropped without an explicit `finish` — the never-hang guarantee.
        }
        assert_settles_once(&sink, "dropped guard");
    }

    #[test]
    fn nothing_is_emitted_after_the_terminator() {
        let sink = RecordingSink::new();
        {
            let mut settled = SettledStream::new(&sink);
            settled.finish();
            // A late token/error/status must be dropped, not sent after done.
            settled.token("late");
            settled.status("late");
            settled.error("late");
        }
        assert_settles_once(&sink, "late emission");
        assert_eq!(sink.names(), vec!["llm-done"]);
    }

    #[test]
    fn an_empty_delta_is_not_an_event() {
        let sink = RecordingSink::new();
        {
            let mut settled = SettledStream::new(&sink);
            settled.token("");
            settled.finish();
        }
        assert_eq!(sink.names(), vec!["llm-done"]);
    }

    // ── The engine-event translation ─────────────────────────────────────────

    #[test]
    fn a_token_event_becomes_a_delta_frame() {
        let frame = StreamFrame::from_engine(EngineEvent::Token("hi".to_string()));
        assert_eq!(frame.events, vec![StreamEvent::Delta("hi".to_string())]);
        assert_eq!(frame.finish_reason, None);
        assert_eq!(frame.reasoning, None);
    }

    #[test]
    fn a_reasoning_event_is_carried_outside_the_events_list() {
        let frame = StreamFrame::from_engine(EngineEvent::Reasoning("why".to_string()));
        assert!(frame.events.is_empty());
        assert_eq!(frame.reasoning.as_deref(), Some("why"));
    }

    #[test]
    fn a_tool_call_event_becomes_a_tool_call_delta() {
        let frame = StreamFrame::from_engine(EngineEvent::ToolCall {
            index: 2,
            name: Some("open_app".to_string()),
            arguments: Some("{\"app\":\"Settings\"}".to_string()),
        });
        assert_eq!(
            frame.events,
            vec![StreamEvent::ToolCallDelta {
                index: 2,
                name: Some("open_app".to_string()),
                arguments_fragment: Some("{\"app\":\"Settings\"}".to_string()),
            }]
        );
    }

    #[test]
    fn a_finished_event_becomes_done_with_its_reason() {
        let frame = StreamFrame::from_engine(EngineEvent::Finished {
            finish_reason: Some("tool_calls".to_string()),
            stopped_on_eog: true,
        });
        assert_eq!(frame.events, vec![StreamEvent::Done]);
        assert_eq!(frame.finish_reason.as_deref(), Some("tool_calls"));
    }

    #[test]
    fn a_failed_event_is_not_a_frame() {
        let frame = StreamFrame::from_engine(EngineEvent::Failed {
            code: CompanionEngineErrorCode::Busy,
            detail: "busy".to_string(),
        });
        assert_eq!(frame, StreamFrame::default());
    }

    // ── The template-parsed call / reasoning decode ─────────────────────────

    #[test]
    fn tool_calls_are_decoded_from_the_templates_parsed_body() {
        let parsed = r#"{"role":"assistant","tool_calls":[{"function":{"name":"open_app","arguments":"{\"app\":\"Mission Monitor\"}"}}]}"#;
        let calls = tool_calls_from_parsed(parsed).expect("a call body decodes");
        assert_eq!(calls.len(), 1);
        assert_eq!(
            calls[0],
            EngineEvent::ToolCall {
                index: 0,
                name: Some("open_app".to_string()),
                arguments: Some("{\"app\":\"Mission Monitor\"}".to_string()),
            }
        );
    }

    #[test]
    fn a_plain_parsed_body_carries_no_tool_calls() {
        assert_eq!(
            tool_calls_from_parsed(r#"{"role":"assistant","content":"hi"}"#),
            None
        );
        assert_eq!(tool_calls_from_parsed("not json"), None);
        assert_eq!(
            tool_calls_from_parsed(r#"{"role":"assistant","tool_calls":[]}"#),
            None
        );
    }

    #[test]
    fn reasoning_is_recovered_from_the_parsed_body_when_present() {
        assert_eq!(
            EngineEvent::reasoning_from_parsed(r#"{"reasoning_content":"step one"}"#).as_deref(),
            Some("step one")
        );
        // The legacy key decodes too.
        assert_eq!(
            EngineEvent::reasoning_from_parsed(r#"{"reasoning":"old"}"#).as_deref(),
            Some("old")
        );
        assert_eq!(EngineEvent::reasoning_from_parsed(r#"{"content":"hi"}"#), None);
        assert_eq!(EngineEvent::reasoning_from_parsed("not json"), None);
    }

    // ── The scripted source (the pins' own oracle) ──────────────────────────
    #[tokio::test]
    async fn the_scripted_source_delivers_its_frames_in_order_then_its_outcome() {
        let source = ScriptedTurnSource::new(vec![
            ScriptedResponse::content("one"),
            ScriptedResponse::failed("boom"),
        ]);
        let mut seen: Vec<StreamFrame> = Vec::new();
        let first = source
            .stream(ChatTurn::text(Vec::new()), &mut |frame| seen.push(frame))
            .await;
        assert!(first.is_ok());
        assert_eq!(seen.len(), 2, "delta + terminal frame");
        assert_eq!(source.remaining(), 1);
        // The second call is the failed response.
        let second = source
            .stream(ChatTurn::text(Vec::new()), &mut |_frame| {})
            .await;
        assert_eq!(second.err().as_deref(), Some("boom"));
        // Exhausted.
        let third = source
            .stream(ChatTurn::text(Vec::new()), &mut |_frame| {})
            .await;
        assert!(third.is_err());
    }

    // ── F1: a channel that closes without `Finished` is a FAILURE ───────────

    /// THE pin for the invisible-engine-death half of the panic. Before the fix
    /// `EngineTurnSource::stream` mapped a closed event channel to `Ok(())`, so an
    /// engine that died mid-turn looked like a NORMAL completion: the settle guard
    /// emitted a bare `llm-done` and NO `llm-error`.
    ///
    /// A turn is complete only when the engine sent `Finished`.
    #[tokio::test]
    async fn a_channel_that_closes_without_finished_is_a_typed_failure() {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<EngineEvent>(8);
        // A token, then the sender drops — exactly what a panicked engine thread
        // leaves behind (its channel closes with no `Finished`).
        tx.send(EngineEvent::Token("partial".to_string()))
            .await
            .expect("send a token");
        drop(tx);

        let mut frames = Vec::new();
        let outcome = drain_turn(&mut rx, &mut |frame| frames.push(frame)).await;

        let detail = outcome.expect_err("a channel close with no Finished is NOT success");
        assert!(
            detail.contains("stopped before the turn finished"),
            "the failure must name the cause: {detail}"
        );
        // The partial content was still delivered to the consumer.
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].events, vec![StreamEvent::Delta("partial".to_string())]);
    }

    /// A turn that DID send `Finished` is a normal completion — the control that
    /// keeps the pin above from passing vacuously.
    #[tokio::test]
    async fn a_channel_that_sends_finished_is_success() {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<EngineEvent>(8);
        tx.send(EngineEvent::Token("ok".to_string()))
            .await
            .expect("send a token");
        tx.send(EngineEvent::Finished {
            finish_reason: Some("stop".to_string()),
            stopped_on_eog: true,
        })
        .await
        .expect("send the terminator");
        drop(tx);

        let mut frames = Vec::new();
        let outcome = drain_turn(&mut rx, &mut |frame| frames.push(frame)).await;
        assert!(outcome.is_ok(), "a Finished turn must settle Ok: {outcome:?}");
        assert_eq!(frames.len(), 2, "the token frame and the terminal frame");
        assert!(frames.iter().any(|frame| frame.events == vec![StreamEvent::Done]));
    }

    /// A typed `Failed` event is returned as the error detail — the engine's own
    /// curated copy, never a generic sentence.
    #[tokio::test]
    async fn a_failed_event_becomes_the_turn_error_detail() {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<EngineEvent>(8);
        tx.send(EngineEvent::Failed {
            code: CompanionEngineErrorCode::ContextCreateFailed,
            detail: "the companion could not sample the reply".to_string(),
        })
        .await
        .expect("send the failure");
        drop(tx);

        let outcome = drain_turn(&mut rx, &mut |_frame| {}).await;
        assert_eq!(
            outcome.err().as_deref(),
            Some("the companion could not sample the reply")
        );
    }

    /// The DOUBLE-`llm-done` investigation (Spec #3141 fix F1).
    ///
    /// The Tester observed `["done","done"]` on ONE `llm_chat_with_image` turn.
    /// The media path's settle ownership is:
    ///
    /// * `commands::chat::spawn_chat` → `skills::run_skill_stream`, which builds
    ///   ONE `SettledStream` and owns the ONLY terminator;
    /// * the vision/audio fallback in `adapterBridge`'s `llmChatWithImage` is a
    ///   FRONTEND-side listener pair, not a second backend settle.
    ///
    /// So a second `llm-done` from the backend is structurally impossible once the
    /// receive path can only produce one: `SettledStream` drops every post-`Done`
    /// emission. This pin asserts that invariant across the exact sequence a dead
    /// engine produces (a partial token, the caught-panic `Failed`, then a
    /// `finish`), which is the shape that used to surface twice.
    ///
    /// **Finding:** the pre-fix double `llm-done` came from TWO invocations of the
    /// vision path, not one turn double-settling: the engine thread's panic closed
    /// the event channel, `EngineTurnSource::stream` mapped that close to `Ok(())`,
    /// and the outer settle emitted its `llm-done` — while the frontend's own
    /// fallback listener (registered because the adapter's `finish()` had already
    /// run on the zero-token stream) emitted a SECOND one for the same user action.
    /// With the close now a typed failure the turn takes exactly one settle path.
    #[test]
    fn a_dead_engine_turn_cannot_double_settle_the_vision_path() {
        let sink = RecordingSink::new();
        {
            let mut settled = SettledStream::new(&sink);
            // A partial token, the typed failure the caught panic emits, then the
            // explicit settle — the exact pre-fix dead-engine shape.
            settled.token("partial");
            settled.error("the companion engine stopped before the turn finished.");
            settled.finish();
            // A stray late settle (the second path the defect produced) is dropped.
            settled.finish();
            settled.token("late");
        }
        assert_settles_once(&sink, "dead-engine vision turn");
        assert_eq!(sink.count("llm-error"), 1);
        assert_eq!(
            sink.names(),
            vec!["llm-token", "llm-error", "llm-done"],
            "one settle sequence: the token, the error, the single terminator"
        );
    }
}
