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

/// The opening delimiter of the pinned template family's control tokens.
///
/// A rendered tool-call body opens a control token with this prefix. A user-visible
/// reply never does, so a tool-offering turn withholds everything from the first
/// occurrence and decides at the finish whether it was a call body (dropped) or
/// ordinary content (released). This is a DELIMITER, not a marker: the markers
/// themselves always come from the template's declaration (NFR-6).
pub const CONTROL_TOKEN_PREFIX: &str = "<|";

/// The closing delimiter of the pinned template family's control tokens.
///
/// Read by [`cut_control_spans`] — the last-resort cut applied to the non-call
/// release path, so an undeclared or truncated control span can never reach
/// `llm-token` (Spec #3141 fix D3). It is a DELIMITER, not a marker: the markers
/// themselves always come from the template's declaration.
pub const CONTROL_TOKEN_CLOSE: &str = "|>";

// ── Engine → application layer ───────────────────────────────────────────────

/// The engine's own cost readout for one settled turn (Spec #3234, ST-5).
///
/// Every field is a value the engine ALREADY computes for the turn — this struct
/// adds no second request shaper, no second loader and no second sampler. It is
/// the minimal readout a harness needs to price a turn's prompt/decoding cost:
///
/// * [`Self::prompt_tokens`] — the prompt's TOKEN count as the engine evaluated
///   it, media-inclusive for an image/audio turn (the multimodal plan's chunk
///   token count, so the projector's visual tokens are counted), the tokenised
///   prompt length (after truncation) for a text turn.
/// * [`Self::prefill_micros`] — wall-clock time the prompt evaluation took.
/// * [`Self::decode_micros`] — wall-clock time the token-sampling loop took.
/// * [`Self::generated_tokens`] — how many tokens the turn generated (the engine's
///   own count, never the number of visible text pieces the consumer assembled).
///
/// A consumer derives the decode rate as
/// `generated_tokens / (decode_micros / 1_000_000)`. All values are measured at
/// the engine seam; nothing here is a claim from an unmeasured field.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct TurnMeasurement {
    /// The prompt's token count (media-inclusive for a media turn).
    pub prompt_tokens: u64,
    /// Wall-clock prompt-evaluation time, in microseconds.
    pub prefill_micros: u64,
    /// Wall-clock token-loop time, in microseconds.
    pub decode_micros: u64,
    /// How many tokens the turn generated.
    pub generated_tokens: u64,
}

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
        /// The engine's own cost readout for this turn (Spec #3234, ST-5). The
        /// harness diffs nothing here — it is the turn's own measurement, so a
        /// cumulative counter can never be misread as a per-fixture delta.
        measurement: TurnMeasurement,
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

/// Where the gate's scanner is in the marker grammar.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GateState {
    /// Ordinary text is being released.
    Streaming,
    /// Inside the template's declared hidden-reasoning span: nothing is released.
    Skipping,
    /// A rendered tool-call body is withheld (the finish path decides).
    ToolBody,
}

/// Separates a turn's user-visible content from its tool-call body AND from the
/// template's hidden reasoning channel, while the model streams.
///
/// Two things must never reach `llm-token` (R-26.1 / R-26.3):
///
/// * a **tool-call body**, whose control marker ([`CONTROL_TOKEN_PREFIX`]) opens
///   the call the template's reverse parser decodes at the finish; and
/// * the **hidden reasoning channel**, which the template declares as an opening
///   reasoning marker followed by one of its declared closing markers (Spec
///   #3141 fix D2). The gate receives those markers as DATA — it never spells
///   them.
///
/// ## Why the old gate collapsed streaming
///
/// The previous gate withheld everything from the FIRST `<|` occurrence, so a
/// reply that OPENED with the reasoning marker withheld the whole generation and
/// released it as ONE token at the finish — leaked chain-of-thought included.
///
/// ## The span-aware state machine
///
/// The gate is driven by the template's OWN declared markers (carried on
/// [`super::chat_format::AppliedChatFormat`]) — never a hand-written literal:
///
/// * **Streaming** — release text, holding back at most the trailing partial
///   marker bytes while the buffer is still a proper prefix of a known marker
///   (so a marker split across two pieces never leaks its prefix);
/// * **Skipping** — the declared reasoning start marker matched: release nothing
///   until one of the declared end markers matches, then return to Streaming, so
///   every piece AFTER the span is emitted immediately (deltas genuinely stream);
/// * **ToolBody** — a reserved control marker opened a tool-call body:
///   withhold it; [`Self::flush`] releases it (minus the reserved markers) unless
///   the finish path classified it as a call (then it is never released).
///
/// A withheld reasoning span is NEVER released by [`Self::flush`]: it is a hidden
/// channel, forwarded once as [`EngineEvent::Reasoning`] by the finish path.
///
/// ## The gate is the ONE classifying (deleting) stage (Spec #3141 fix D3)
///
/// The decoder is a UTF-8 boundary and removes nothing, so every control marker
/// reaches this gate. Per class:
///
/// | class | gate behaviour |
/// |---|---|
/// | ordinary text | released immediately |
/// | reasoning span markers (declared start / end) | consumed; body withheld as the hidden channel |
/// | tool-call structure (the reserved opener / argument quote / closer) | enters ToolBody together with the body, so `raw()` stays complete for the template's reverse parser |
/// | a reserved delimiter no state consumes | dropped from `pending`, RETAINED in `raw` |
///
/// Dropping at the decoder instead (round 3) ate the tool-call opener before the
/// reverse parser could see it, so a real call decoded as content and the raw body
/// was released as prose. `raw` therefore never loses a character; only the
/// released `llm-token` text is filtered.
#[derive(Debug, Clone)]
pub struct ContentGate {
    /// Every byte the model produced (what the reverse parser decodes).
    raw: String,
    /// The not-yet-classified suffix of `raw`.
    pending: String,
    /// Visible text produced since the last drain (`push`/`flush` takes it).
    visible: String,
    /// The tool-call control prefix to withhold from, when the turn offers tools.
    hold: Option<&'static str>,
    /// The template's declared reasoning start marker (empty when none).
    start_tag: String,
    /// The template's declared reasoning end markers.
    end_tags: Vec<String>,
    /// The template's reserved control markers: never released as visible text,
    /// but always retained in `raw` so the reverse parser stays complete.
    reserved: Vec<String>,
    /// The scanner's position.
    state: GateState,
    /// Whether a declared reasoning span was ever entered.
    skipped: bool,
}

impl ContentGate {
    /// A gate for a turn that offers tools.
    ///
    /// `start_tag` / `end_tags` are the template's DECLARED reasoning markers
    /// ([`super::chat_format::StreamMarkers::start`] / `::ends`); `reserved` is
    /// every reserved control marker (declared, and never forwarded).
    pub fn for_tool_turn(start_tag: &str, end_tags: &[String], reserved: &[String]) -> Self {
        Self::new(Some(CONTROL_TOKEN_PREFIX), start_tag, end_tags, reserved)
    }

    /// A gate for a turn that offers no tools (no tool body to withhold, but the
    /// reasoning span is still hidden from the reply and reserved markers are
    /// still never released).
    pub fn for_content_turn(start_tag: &str, end_tags: &[String], reserved: &[String]) -> Self {
        Self::new(None, start_tag, end_tags, reserved)
    }

    fn new(
        hold: Option<&'static str>,
        start_tag: &str,
        end_tags: &[String],
        reserved: &[String],
    ) -> Self {
        Self {
            raw: String::new(),
            pending: String::new(),
            visible: String::new(),
            hold,
            start_tag: start_tag.to_string(),
            end_tags: end_tags.to_vec(),
            reserved: reserved.to_vec(),
            state: GateState::Streaming,
            skipped: false,
        }
    }

    /// Append one released piece and return the newly user-visible text.
    ///
    /// Returns an empty string when the piece only advanced withheld text (that
    /// means "hold", not "nothing arrived").
    pub fn push(&mut self, piece: &str) -> String {
        self.raw.push_str(piece);
        self.pending.push_str(piece);
        self.advance();
        std::mem::take(&mut self.visible)
    }

    /// The whole raw text the model produced (what the reverse parser decodes).
    pub fn raw(&self) -> &str {
        &self.raw
    }

    /// Release every withheld PROSE / TOOL BODY character (the turn was content,
    /// not a call).
    ///
    /// A withheld reasoning span is never released: it is the hidden channel, and
    /// the finish path forwards it as [`EngineEvent::Reasoning`] instead.
    ///
    /// Reserved control markers are STRIPPED from the released text, and any
    /// residual protocol prefix is cut, so this non-call release path can never
    /// emit `<|`-syntax to a consumer (Spec #3141 fix D3).
    ///
    /// Returns an empty string when nothing releasable was withheld.
    pub fn flush(&mut self) -> String {
        if self.state == GateState::Skipping {
            // An unclosed reasoning span is still the hidden channel: releasing it
            // would leak the chain-of-thought as the reply.
            return String::new();
        }
        if !self.pending.is_empty() {
            self.release_prefix(self.pending.len());
        }
        let released = std::mem::take(&mut self.visible);
        strip_control_syntax(&released, &self.reserved)
    }

    /// Whether the gate suppressed a declared reasoning span.
    pub fn skipped_reasoning(&self) -> bool {
        self.skipped
    }

    /// Move the first `len` bytes of `pending` into the visible buffer.
    fn release_prefix(&mut self, len: usize) {
        if len == 0 {
            return;
        }
        let released: String = self.pending.drain(..len).collect();
        self.visible.push_str(&released);
    }

    /// Drop the first `len` bytes of `pending` WITHOUT releasing them (a skipped
    /// reasoning span, or a marker the gate consumed).
    fn drop_prefix(&mut self, len: usize) {
        if len == 0 {
            return;
        }
        self.pending.drain(..len);
    }

    /// Classify `pending` and move what is visible into the output buffer.
    fn advance(&mut self) {
        loop {
            match self.state {
                GateState::ToolBody => return,
                GateState::Skipping => {
                    let Some((at, len)) = find_first(&self.pending, &self.end_tags) else {
                        // The span has not closed yet: withhold everything. The
                        // pending buffer keeps the partial end marker so it can
                        // still be matched once the rest arrives.
                        return;
                    };
                    self.drop_prefix(at + len);
                    self.state = GateState::Streaming;
                }
                GateState::Streaming => {
                    // The DECLARED reasoning start marker, exactly — it wins over
                    // the generic control prefix because it BEGINS with one.
                    if !self.start_tag.is_empty() && self.pending.starts_with(&self.start_tag) {
                        self.drop_prefix(self.start_tag.len());
                        self.state = GateState::Skipping;
                        self.skipped = true;
                        continue;
                    }
                    // A SPLIT start marker: the pending buffer is a proper prefix
                    // of the declared start tag, so it could still become the span
                    // opener. Hold it — bounded by the marker length — instead of
                    // mistaking its `<|` for a tool body.
                    if !self.start_tag.is_empty()
                        && !self.pending.is_empty()
                        && self.start_tag.starts_with(&self.pending)
                    {
                        return;
                    }

                    // Earliest classification site. Precedence on a tie:
                    // reasoning start (0) > reserved marker (1) > bare control
                    // prefix (2) — a reserved marker begins with `<|`, so the
                    // full-marker hit must win over the prefix-only hit.
                    let mut candidates: Vec<(usize, u8, usize)> = Vec::new();
                    if !self.start_tag.is_empty() {
                        if let Some(at) = self.pending.find(&self.start_tag) {
                            candidates.push((at, 0, self.start_tag.len()));
                        }
                    }
                    if let Some((at, len)) = find_first(&self.pending, &self.reserved) {
                        candidates.push((at, 1, len));
                    }
                    if let Some(at) = self.pending.find(CONTROL_TOKEN_PREFIX) {
                        candidates.push((at, 2, CONTROL_TOKEN_PREFIX.len()));
                    }
                    let Some(&(at, rank, len)) =
                        candidates.iter().min_by_key(|(at, rank, _)| (*at, *rank))
                    else {
                        // Plain text: release it, holding back only a trailing
                        // proper prefix of a known marker (a split marker).
                        let mut hold = trailing_partial(&self.pending, &self.start_tag)
                            .max(trailing_partial(&self.pending, CONTROL_TOKEN_PREFIX));
                        for marker in &self.reserved {
                            hold = hold.max(trailing_partial(&self.pending, marker));
                        }
                        let release = self.pending.len() - hold;
                        self.release_prefix(release);
                        return;
                    };
                    self.release_prefix(at);
                    if rank == 0 {
                        self.drop_prefix(self.start_tag.len());
                        self.state = GateState::Skipping;
                        self.skipped = true;
                        continue;
                    }
                    if self.hold.is_some() {
                        // A tool-call body: withhold it INCLUDING its opener; the
                        // finish path decides whether it was a call or ordinary
                        // content. `raw` keeps every byte either way, so the
                        // template's reverse parser still sees a complete body.
                        self.state = GateState::ToolBody;
                        return;
                    }
                    // No tool body on this turn: a reserved delimiter (rank 1) is
                    // protocol syntax, never reply text — drop it from `pending`
                    // but RETAIN it in `raw`, and keep scanning. A bare control
                    // prefix (rank 2) that is not a declared marker is dropped the
                    // same way, so a content/status turn never releases `<|`.
                    self.drop_prefix(len);
                }
            }
        }
    }
}

/// The earliest occurrence of any of `markers` in `text`, as `(offset, length)`.
///
/// Ties at the same offset go to the LONGEST marker, so a marker that is a prefix
/// of another (e.g. a bare opener and the opener followed by a channel name) never
/// shadows the longer declaration.
fn find_first(text: &str, markers: &[String]) -> Option<(usize, usize)> {
    markers
        .iter()
        .filter(|marker| !marker.is_empty())
        .filter_map(|marker| text.find(marker.as_str()).map(|at| (at, marker.len())))
        .min_by(|left, right| left.0.cmp(&right.0).then(right.1.cmp(&left.1)))
}

/// Remove the template's control syntax from text the non-call release path is
/// about to emit.
///
/// This is the last line of the non-call release path (Spec #3141 fix D3): a turn
/// that turns out not to be a tool call must never show the template's control
/// syntax to a consumer. Two passes, in order:
///
/// 1. the template's OWN declared reserved markers are removed by exact text —
///    the only set the text-matching gate can be certain of, since it deliberately
///    never names a marker itself (NFR-6);
/// 2. every residual control DELIMITER span is cut — the protocol's grammar
///    ([`CONTROL_TOKEN_PREFIX`] … [`CONTROL_TOKEN_CLOSE`]) is a delimiter PAIR, not
///    a named marker, so a marker the template did not declare, or a body the token
///    budget cut mid-marker, still cannot reach `llm-token`.
///
/// Every byte involved is ASCII, so the offsets stay on character boundaries.
fn strip_control_syntax(text: &str, reserved: &[String]) -> String {
    let mut cleaned = text.to_string();
    for marker in reserved.iter().filter(|marker| !marker.is_empty()) {
        if cleaned.contains(marker.as_str()) {
            cleaned = cleaned.replace(marker.as_str(), "");
        }
    }
    cut_control_spans(&cleaned)
}

/// Cut every control-token span out of `text`.
///
/// The pinned template family delimits a control token in one of two DELIMITER
/// forms — an opener `<|name>` and a closer `<name|>` — and this cuts both. It names
/// no MARKER (NFR-6): the only bytes spelled here are the delimiters
/// [`CONTROL_TOKEN_PREFIX`] and `|>`. That is what guarantees the non-call release
/// path emits no `<|`-syntax (Spec #3141 fix D3) even for a marker the template did
/// not declare, or a body the token budget cut mid-marker (the remaining span is
/// dropped, since everything after an opener is protocol text).
///
/// A closer form's NAME must be marker-shaped (non-empty, no whitespace) so ordinary
/// prose like `a < b |>` is preserved. A `<` that opens neither form is literal text
/// and is kept.
fn cut_control_spans(text: &str) -> String {
    let mut kept = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find('<') {
        kept.push_str(&rest[..open]);
        let candidate = &rest[open..];
        if let Some(after_prefix) = candidate.strip_prefix(CONTROL_TOKEN_PREFIX) {
            // Opener form: `<|name>` — the first `>` terminates it.
            match after_prefix.find('>') {
                Some(offset) => rest = &after_prefix[offset + 1..],
                // Cut short mid-marker: everything after an opener is protocol text.
                None => return kept,
            }
            continue;
        }
        // Closer form: `<name|>` — the name must sit between the delimiters, and no
        // OTHER `<`/`>` may intervene (which would make this a literal `<`). The
        // name must also be marker-shaped, so a comparison like `a < b |>` survives.
        // (`candidate` starts with the `<` being examined, so inspect `candidate[1..]`.)
        match candidate.find(CONTROL_TOKEN_CLOSE) {
            Some(offset)
                if is_marker_shaped(&candidate[1..offset])
                    && !candidate[1..offset].contains(['<', '>']) =>
            {
                rest = &candidate[offset + CONTROL_TOKEN_CLOSE.len()..];
            }
            _ => {
                kept.push('<');
                rest = &candidate[1..];
            }
        }
    }
    kept.push_str(rest);
    kept
}

/// Whether `name` looks like a control-token name rather than prose: non-empty and
/// containing no whitespace. Used to keep the closer-form cut from eating a
/// comparison like `a < b |>`.
fn is_marker_shaped(name: &str) -> bool {
    !name.is_empty() && !name.chars().any(char::is_whitespace)
}

/// The length of the longest trailing proper prefix of `marker` that `text` ends
/// with — the bytes that could still become a marker once more text arrives.
///
/// Every marker byte is ASCII, so trimming it keeps the offset on a character
/// boundary.
fn trailing_partial(text: &str, marker: &str) -> usize {
    if marker.is_empty() {
        return 0;
    }
    let bytes = text.as_bytes();
    let marker_bytes = marker.as_bytes();
    for length in (1..marker_bytes.len()).rev() {
        if bytes.ends_with(&marker_bytes[..length]) {
            return length;
        }
    }
    0
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
        let mut gate = ContentGate::for_content_turn("", &[], &[]);
        assert_eq!(gate.push("hello"), "hello");
        assert_eq!(gate.push(" there"), " there");
        assert_eq!(gate.raw(), "hello there");
        assert_eq!(gate.flush(), "");
    }

    #[test]
    fn a_tool_turn_holds_from_the_control_marker_and_keeps_the_prose() {
        let mut gate = ContentGate::for_tool_turn("", &[], &[]);
        assert_eq!(gate.push("Opening it now. "), "Opening it now. ");
        // The call body starts with the control marker and is never forwarded.
        assert_eq!(gate.push("<|tool_call>call:open_app{"), "");
        assert_eq!(gate.push("app:1}<tool_call|>"), "");
        // Non-call release: the body comes back WITHOUT its control syntax.
        assert_eq!(gate.flush(), "call:open_app{app:1}");
    }

    #[test]
    fn a_marker_split_across_two_pieces_never_leaks_its_prefix() {
        let mut gate = ContentGate::for_tool_turn("", &[], &[]);
        // The trailing `<` could start a marker, so it is withheld.
        assert_eq!(gate.push("done <"), "done ");
        // The completion of the marker forwards nothing more.
        assert_eq!(gate.push("|tool_call>call:wait{"), "");
        assert_eq!(gate.flush(), "call:wait{");
    }

    #[test]
    fn a_content_turn_with_no_marker_never_holds_anything_back() {
        let mut gate = ContentGate::for_tool_turn("", &[], &[]);
        let text = "a plain reply with no control tokens at all";
        assert_eq!(gate.push(text), text);
        assert_eq!(gate.flush(), "");
    }

    // ── D2: the template's DECLARED reasoning span is skipped, and the answer
    //        after it still STREAMS ──────────────────────────────────────────

    /// The declared markers the pinned template family emits. The PRODUCTION gate
    /// never spells these: they arrive on `AppliedChatFormat` from the GGUF's own
    /// template (asserted by `chat_format`'s template pins). These gate pins feed
    /// them as data so the state machine is exercised with no model load.
    const START: &str = "<|channel>thought";
    const END: &str = "<channel|>";

    fn end_tags() -> Vec<String> {
        vec![END.to_string()]
    }

    /// The pinned template family's reserved control markers, as the gate receives
    /// them from `chat_format::stream_markers` (the template's own declaration).
    ///
    /// Spelled only in this test module (production never names a marker — NFR-6,
    /// enforced by `production_code_never_spells_the_reasoning_markers` and
    /// `production_code_never_names_a_tool_marker`).
    fn reserved_markers() -> Vec<String> {
        vec![
            "<|tool_call>".to_string(),
            "<tool_call|>".to_string(),
            ["<|", "\"", "|>"].concat(),
        ]
    }

    /// THE D2 pin: a reasoning-FIRST reply must stream its answer as ≥2 deltas,
    /// and NO delta may carry the reasoning markers (or the thought itself).
    ///
    /// Before the fix the blanket `<|` hold withheld the whole generation and the
    /// finish path released it as ONE token beginning `<|channel>thought`.
    #[test]
    fn a_reasoning_first_reply_streams_the_answer_and_never_leaks_the_span() {
        let mut gate = ContentGate::for_tool_turn(START, &end_tags(), &[]);
        let thought = "<|channel>thought\nThe user wants one word.\n<channel|>";
        // The reasoning span streams in pieces, exactly as the model emits them.
        assert_eq!(gate.push(&thought[..10]), "", "the span is withheld");
        assert_eq!(gate.push(&thought[10..]), "", "still inside the span");
        // The ANSWER, released as it arrives — this is what used to collapse.
        let first = gate.push("Yes");
        let second = gate.push(".");
        assert_eq!(first, "Yes", "the answer must stream from the first piece");
        assert_eq!(second, ".", "each delta must carry only its own text");
        assert_eq!(gate.flush(), "", "nothing withheld remains");
        assert!(gate.skipped_reasoning(), "the span was recognised and skipped");

        // The receipt: the concatenated visible text is the ANSWER ONLY.
        let visible = format!("{first}{second}");
        assert_eq!(visible, "Yes.");
        assert!(
            !visible.contains("<|channel>") && !visible.contains(END),
            "no marker may reach the reply: {visible:?}"
        );
        assert!(
            !visible.contains("The user wants one word"),
            "the chain-of-thought must never reach the reply: {visible:?}"
        );
        // Non-vacuity: the RAW text still carries the span (so the skip is real).
        assert!(gate.raw().contains(START) && gate.raw().contains(END));
    }

    /// A marker SPLIT across pieces is matched once complete — the bounded hold is
    /// at most the marker length, never the whole generation.
    #[test]
    fn a_reasoning_marker_split_across_pieces_is_still_matched() {
        let mut gate = ContentGate::for_tool_turn(START, &end_tags(), &[]);
        // Split the START marker across two pieces, mid-token.
        assert_eq!(gate.push("<|channel>"), "");
        assert_eq!(gate.push("thought why"), "");
        assert_eq!(gate.push("<channel|>"), "");
        // The answer streams immediately after the closing marker.
        assert_eq!(gate.push("Hi"), "Hi");
        assert_eq!(gate.flush(), "");
        // The partial START was held, never leaked.
        assert!(!gate.push("").contains("<|channel>"));
    }

    /// A span may be followed by ANOTHER span (the template allows empty/recurring
    /// channels); each pair flips back to streaming between them.
    #[test]
    fn recurring_reasoning_spans_are_each_skipped() {
        let mut gate = ContentGate::for_content_turn(START, &end_tags(), &[]);
        assert_eq!(gate.push(START), "");
        assert_eq!(gate.push("one"), "");
        assert_eq!(gate.push(END), "");
        assert_eq!(gate.push("A"), "A");
        assert_eq!(gate.push(START), "");
        assert_eq!(gate.push("two"), "");
        assert_eq!(gate.push(END), "");
        assert_eq!(gate.push("B"), "B");
        assert_eq!(gate.flush(), "");
    }

    /// A turn with NO declared reasoning span streams exactly as before: prose is
    /// released from byte one and only a trailing partial control marker is held.
    #[test]
    fn a_turn_without_a_declared_span_streams_every_character() {
        let mut gate = ContentGate::for_tool_turn("", &[], &[]);
        let text = "a plain reply with no reasoning span at all";
        assert_eq!(gate.push(text), text);
        assert_eq!(gate.flush(), "");
        assert!(!gate.skipped_reasoning());
    }

    /// A prose reply keeps the tool-body contract: the prose streams, the call
    /// body is withheld until the finish path classifies it. If that classification
    /// says "content", the released text carries the BODY but no control syntax
    /// (fix D3's non-call release rule).
    #[test]
    fn prose_before_a_tool_body_streams_and_the_body_is_withheld() {
        let reserved = reserved_markers();
        let mut gate = ContentGate::for_tool_turn(START, &end_tags(), &reserved);
        assert_eq!(gate.push("Opening Mission Monitor. "), "Opening Mission Monitor. ");
        assert_eq!(gate.push("<|tool_call>call:open_app{"), "");
        let released = gate.flush();
        assert_eq!(released, "call:open_app{");
        assert!(
            !released.contains("<|"),
            "the non-call release path must never emit control syntax: {released:?}"
        );
        // Non-vacuity: `raw` still carries the complete body, so the template's
        // reverse parser can decode the call that was withheld.
        assert_eq!(gate.raw(), "Opening Mission Monitor. <|tool_call>call:open_app{");
    }

    /// An UNCLOSED reasoning span is never released by `flush` — releasing it
    /// would leak the chain-of-thought as the reply.
    #[test]
    fn an_unclosed_reasoning_span_is_never_released_at_the_finish() {
        let mut gate = ContentGate::for_tool_turn(START, &end_tags(), &[]);
        assert_eq!(gate.push(START), "");
        assert_eq!(gate.push("a thought that never closes"), "");
        assert_eq!(gate.flush(), "", "the hidden span must never be flushed");
        assert!(gate.skipped_reasoning());
    }

    /// NFR-6 / the F1 lesson: the reasoning markers must come from the GGUF's own
    /// template, never a hand-written literal in PRODUCTION code.
    ///
    /// The gate above is driven with the markers as DATA; this guard proves that
    /// no production source spells them. A future edit that hardcodes the marker
    /// (the F1 regex-vs-literal failure mode) fails here.
    ///
    /// The scan is RAW over the production modules (comments included), which is
    /// the G-430 discipline: the predicate is exactly "the literal does not appear
    /// in production code". This test module is the ONLY place allowed to spell it.
    #[test]
    fn production_code_never_spells_the_reasoning_markers() {
        // Constructed at runtime so this very file can be scanned without the
        // guard tripping on its own assertion text.
        let start = ["<|", "channel>", "thought"].concat();
        let end = ["<", "channel|>"].concat();
        let sources: [(&str, &str); 3] = [
            ("stream.rs", include_str!("stream.rs")),
            ("chat_format.rs", include_str!("chat_format.rs")),
            ("thread.rs", include_str!("thread.rs")),
        ];
        for (name, source) in sources {
            // The TEST modules are allowed to name the marker (this file's own
            // pins do); scan only the production code above the first top-level
            // `#[cfg(test)]` module.
            let production = source.split("\n#[cfg(test)]").next().unwrap_or(source);
            // Non-vacuity: every scanned file DOES have a test module, so the
            // production slice must be strictly shorter than the whole file. A
            // scan that covered nothing would make the two assertions below pass
            // for the wrong reason.
            assert!(
                production.len() < source.len(),
                "{name}: the production scan must exclude the file's test module"
            );
            assert!(
                !production.contains(&start),
                "{name}: production code must not spell the reasoning START marker \
                 — it must come from the template's declaration"
            );
            assert!(
                !production.contains(&end),
                "{name}: production code must not spell a reasoning END marker \
                 — it must come from the template's declaration"
            );
        }
    }

    // ── D3: the non-call release path can never emit control syntax ──────────

    /// THE D3 pin for the release path: whatever a withheld ToolBody contains, the
    /// non-call release (`flush`) emits NO `<|`-syntax.
    ///
    /// Round 3's regression released the withheld body VERBATIM as prose, so the
    /// companion bubble showed `call:open_app{app:<|"|>Mission Monitor<|"|>}`. The
    /// gate now strips the template's declared markers AND cuts any residual
    /// control-token span, so only the call's own text can reach `llm-token`.
    #[test]
    fn the_non_call_release_path_never_emits_control_syntax() {
        let reserved = reserved_markers();
        // A complete body, exactly as the pinned template renders it.
        let quote = ["<|", "\"", "|>"].concat();
        let body = format!(
            "<|tool_call>call:open_app{{app:{quote}Mission Monitor{quote}}}<tool_call|>"
        );
        let mut gate = ContentGate::for_tool_turn(START, &end_tags(), &reserved);
        assert_eq!(gate.push("Okay."), "Okay.");
        assert_eq!(gate.push(&body), "", "the whole body is withheld");
        let released = gate.flush();
        eprintln!("D3 RELEASE: {released:?}");

        assert!(
            !released.contains("<|"),
            "the release path must emit NO opener syntax: {released:?}"
        );
        assert!(
            !released.contains(&quote),
            "the release path must emit NO argument-quote marker: {released:?}"
        );
        // Non-vacuity: `raw` still carries the complete marker-bearing body, so the
        // template's reverse parser decodes a real call rather than prose.
        assert!(
            gate.raw().contains("<|tool_call>") && gate.raw().contains("<tool_call|>"),
            "the raw buffer must retain the complete call body: {:?}",
            gate.raw()
        );
    }

    /// A body the token budget CUT mid-marker (the common truncation) is also
    /// released without control syntax — the delimiter rule does not depend on a
    /// well-formed body.
    #[test]
    fn a_truncated_call_body_is_released_without_control_syntax() {
        let reserved = reserved_markers();
        let mut gate = ContentGate::for_tool_turn(START, &end_tags(), &reserved);
        // No closer: the generation stopped inside the call body.
        assert_eq!(gate.push("<|tool_call>call:open_app{app:"), "");
        let released = gate.flush();
        assert!(
            !released.contains("<|"),
            "a truncated body must not leak opener syntax: {released:?}"
        );
        assert_eq!(released, "call:open_app{app:");
    }

    /// The pin that the release path cannot emit control syntax must be
    /// non-vacuous: WITHOUT the template's boundary the same bytes are preserved,
    /// so the pass above is the boundary doing work rather than a body that never
    /// contained a marker.
    #[test]
    fn the_marker_boundary_is_what_strips_control_syntax() {
        let reserved = reserved_markers();
        let quote = ["<|", "\"", "|>"].concat();
        let body = format!("call:open_app{{app:{quote}Settings{quote}}}");
        let mut gate = ContentGate::for_tool_turn(START, &end_tags(), &reserved);
        assert_eq!(gate.push("<|tool_call>"), "");
        assert_eq!(gate.push(&body), "");
        let released = gate.flush();
        assert_eq!(released, "call:open_app{app:Settings}");
        assert!(!released.contains(&quote));
        // The raw body still has everything the reverse parser needs.
        assert!(gate.raw().starts_with("<|tool_call>"));
    }

    /// `cut_control_spans` leaves ordinary `<`/`>` text alone: a reply about
    /// comparisons must not be mangled by the delimiter rule.
    #[test]
    fn ordinary_angle_brackets_survive_the_release_filter() {
        assert_eq!(cut_control_spans("a < b and c > d"), "a < b and c > d");
        assert_eq!(cut_control_spans("use <div> tags"), "use <div> tags");
        assert_eq!(cut_control_spans("plain text"), "plain text");
        // A comparison with a stray `|>` must survive: the closer-form NAME is
        // prose (it has whitespace), so it is not treated as a control token.
        assert_eq!(cut_control_spans("a < b |> c"), "a < b |> c");
        // Non-vacuity: a REAL control span IS cut — both forms.
        assert_eq!(cut_control_spans("a<|x|>b"), "ab");
        assert_eq!(cut_control_spans("a<tool_call|>b"), "ab");
        // An unterminated opener drops the remainder (a body cut mid-marker).
        assert_eq!(cut_control_spans("ok<|tool_call"), "ok");
    }

    /// NFR-6 / the F1 lesson applied to the TOOL path (Spec #3141 fix D3): the
    /// tool-call markers must come from the template's declaration, never a literal
    /// in PRODUCTION code.
    ///
    /// This is what makes the chosen design the only correct one: because we never
    /// name a tool marker, no "filter the tool markers by name" tweak is possible —
    /// the decoder must stop classifying and the gate must match marker TEXT it was
    /// handed.
    ///
    /// The scan is RAW over the production modules (comments included) — the G-430
    /// predicate is exactly "the literal does not appear in production code". Only
    /// the DELIMITERS are allowed in production (protocol grammar, not markers), and
    /// the declaration block / argument quote are owned by `chat_format` as its
    /// `TOOL_DECLARATION_*` / `TOOL_ARGUMENT_QUOTE` constants — what must never be
    /// spelled is the CALL marker itself.
    #[test]
    fn production_code_never_names_a_tool_marker() {
        // Constructed at runtime so this very file can be scanned without the
        // guard tripping on its own assertion text.
        let opener = ["<|", "tool_call", ">"].concat();
        let closer = ["<", "tool_call|>"].concat();
        let sources: [(&str, &str); 4] = [
            ("stream.rs", include_str!("stream.rs")),
            ("chat_format.rs", include_str!("chat_format.rs")),
            ("thread.rs", include_str!("thread.rs")),
            ("detokenize.rs", include_str!("detokenize.rs")),
        ];
        for (name, source) in sources {
            let production = source.split("\n#[cfg(test)]").next().unwrap_or(source);
            assert!(
                production.len() < source.len(),
                "{name}: the production scan must exclude the file's test module"
            );
            assert!(
                !production.contains(&opener),
                "{name}: production code must not spell the tool-call OPENER — it \
                 must come from the template's declaration (NFR-6 / fix D3)"
            );
            assert!(
                !production.contains(&closer),
                "{name}: production code must not spell the tool-call CLOSER — it \
                 must come from the template's declaration (NFR-6 / fix D3)"
            );
        }
        // Non-vacuity: the pinned template DOES declare these, so the knowledge
        // lives in the declaration (asserted by `chat_format`'s template pins).
        assert!(opener.starts_with(CONTROL_TOKEN_PREFIX));
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
            measurement: TurnMeasurement::default(),
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
            measurement: TurnMeasurement::default(),
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
