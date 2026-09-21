//! Companion reply status (Spec #2918, ST-1; ST-6 separation; EARS R-1, R-3–R-10).
//!
//! The reply and its status are obtained WITHOUT ever putting the tool offer and
//! the structured status in one request (ST-6 — on the pinned managed server the
//! `json_schema` grammar displaces the native tool-call path when both coexist):
//!
//! * a SKILL-CAPABLE turn (`offer_skills = true`) runs the SHIPPED tools body
//!   byte-identically (`tools` / `tool_choice:"auto"` /
//!   `parallel_tool_calls:false`, NO `response_format`) through
//!   [`run_tools_attempt`], so native tool calling keeps working; a tool-call or
//!   failed turn settles through the SHIPPED
//!   [`super::skills::plan_terminal_events`], and ONLY a content-only prose turn
//!   obtains its status from ONE bounded status-only pass
//!   ([`build_status_only_request_body`]) whose `{status}` object is
//!   schema-constrained by [`fredo_status_only_schema`];
//! * a TOOLS-FREE turn (`offer_skills = false`, e.g. the avatar joke) keeps the
//!   shipped single-object `{ reply, status }` contract
//!   ([`build_structured_status_request_body`]) — [`ReplyEnvelopeExtractor`]
//!   forwards ONLY decoded `reply` characters as `llm-token` (progressive
//!   rendering preserved) and withholds every incomplete fragment (the
//!   `{"reply":"` prefix, a split escape, a split multi-byte character) so no
//!   raw JSON can surface;
//! * the parsed status travels on the ADDITIVE `llm-status` event, emitted
//!   BEFORE the shipped `llm-done` and NEVER on a skill/error turn;
//! * on the tools-free path, empty (R-5) or `{`-bearing non-conforming (R-6)
//!   content takes the bounded retry ([`STATUS_EMPTY_RETRY_MAX`]) through the
//!   shipped plain path, so the turn always settles with exactly one `llm-done`
//!   and never hangs.
//!
//! Regression invariants: `llm_chat` / `llm_chat_with_image` request bodies stay
//! byte-identical; `build_tools_request_body` / `build_skill_request_body` /
//! `build_audio_skill_request_body` are untouched; the `open_app` / `close_app` /
//! `llm-skill-call` contract is untouched; a content turn and a tool-call turn
//! stay disjoint ([`super::skills::ToolCallAccumulator`] is unchanged); the
//! frontend never parses JSON.

use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::infrastructure::companion::skills::SkillRegistry;

use super::chat::{self, ChatSseFrame, ChatStreamEvent, LlmMessage};
use super::skills::{
    self, build_audio_skill_request_body, build_skill_request_body, emit_terminal_event,
    plan_stream_error_events, plan_terminal_events, TerminalEvent, ToolCallAccumulator,
};

// ── Contract constants (converged; plan API contract §1/§2/§4/§8) ─────────────

/// The `response_format` JSON-Schema name for the structured reply contract.
pub const FREDO_STATUS_SCHEMA_NAME: &str = "fredo_reply";

/// The `response_format` JSON-Schema name for the ST-6 status-only pass.
pub const FREDO_STATUS_ONLY_SCHEMA_NAME: &str = "fredo_status";

/// The model-emittable status vocabulary — the closed set the schema's `enum`
/// admits. Every value outside it heals to [`DEFAULT_FREDO_STATUS`] in the
/// frontend's lenient resolver (R-8), never in the backend parse.
pub const FREDO_STATUS_VALUES: [&str; 7] = [
    "happy", "playful", "joking", "thinking", "working", "listening", "idle",
];

/// The status used when the model omits it (the shipped success settle), so an
/// absent status is a zero-visual-regression default.
pub const DEFAULT_FREDO_STATUS: &str = "happy";

/// The bounded number of retries when the structured attempt yields no usable
/// content (R-5). One, no backoff — the server is loopback/local and a backoff
/// would add visible latency.
pub const STATUS_EMPTY_RETRY_MAX: usize = 1;

/// The bounded budget (seconds) for the ST-6 status-only pass, so it can never
/// outlive the turn envelope. One attempt; no retry (a missing status is the
/// safe default).
pub const STATUS_PASS_TIMEOUT_S: u64 = 10;

/// The ADDITIVE wire event carrying the parsed status (payload `string`).
pub const LLM_STATUS_EVENT: &str = "llm-status";

/// The structured-output prompt fragment. Contains the literal word `json` and a
/// concrete example, and never instructs free-text JSON (binding in-repo
/// structured-output guidance).
pub const STATUS_INSTRUCTION: &str =
    "Respond with a single json object and nothing else, in exactly this shape:\n\
{\"reply\": \"<your reply to the user>\", \"status\": \"<one of: happy, playful, joking, thinking, working, listening, idle>\"}\n\
Example: {\"reply\": \"Settings is open — anything else?\", \"status\": \"happy\"}";

/// The ST-6 status-only prompt fragment, sent as a user turn AFTER the
/// just-streamed prose reply. Contains the literal word `json` and a concrete
/// example, states the closed 7-value set, and never instructs free-text JSON.
pub const STATUS_ONLY_INSTRUCTION: &str =
    "Given your reply above, respond with a single json object and nothing else, in exactly this shape:\n\
{\"status\": \"<one of: happy, playful, joking, thinking, working, listening, idle>\"}\n\
Example: {\"status\": \"happy\"}";

/// The readable detail for the (unreachable with the shipped bound of 1) case
/// where the structured path yields nothing and no retry budget remains.
const NO_STATUS_RETRY_DETAIL: &str =
    "the companion returned no usable reply under the structured contract.";

// ── The schema (pure) ─────────────────────────────────────────────────────────

/// The ONE `response_format` JSON Schema for the reply contract (name
/// [`FREDO_STATUS_SCHEMA_NAME`]). Closed over the 7-value status `enum` and
/// `additionalProperties: false`; `reply` is required.
pub fn fredo_status_schema() -> Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "reply": {
                "type": "string",
                "description": "The companion's reply, plain text only."
            },
            "status": {
                "type": "string",
                "enum": FREDO_STATUS_VALUES,
                "description": "How Fredo should present himself for this turn."
            }
        },
        "required": ["reply", "status"],
        "additionalProperties": false
    })
}

/// The ST-6 status-only schema (name [`FREDO_STATUS_ONLY_SCHEMA_NAME`]): closed
/// over the SAME [`FREDO_STATUS_VALUES`] and `additionalProperties: false`, with
/// `status` required and NO `reply` property.
pub fn fredo_status_only_schema() -> Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "status": {
                "type": "string",
                "enum": FREDO_STATUS_VALUES,
                "description": "How Fredo should present himself for this turn."
            }
        },
        "required": ["status"],
        "additionalProperties": false
    })
}

/// The `response_format` wrapper for the reply schema — the ONE block inserted
/// into the structured audio body; the text body reaches it through
/// [`chat::build_response_format_request_body`].
fn status_response_format() -> Value {
    serde_json::json!({
        "type": "json_schema",
        "json_schema": {
            "name": FREDO_STATUS_SCHEMA_NAME,
            "schema": fredo_status_schema(),
        },
    })
}

// ── The prompt fragment (pure) ────────────────────────────────────────────────

/// Append [`STATUS_INSTRUCTION`] to the FIRST `system` message (inserting a
/// system turn when the conversation carries none).
///
/// Present iff the structured contract is used — the plain fallback never
/// receives it.
pub fn with_status_instruction(messages: &mut Vec<LlmMessage>) {
    if let Some(system) = messages.iter_mut().find(|message| message.role == "system") {
        if !system.content.is_empty() {
            system.content.push('\n');
        }
        system.content.push_str(STATUS_INSTRUCTION);
        return;
    }
    messages.insert(
        0,
        LlmMessage {
            role: "system".to_string(),
            content: STATUS_INSTRUCTION.to_string(),
        },
    );
}

// ── Request body (pure) ───────────────────────────────────────────────────────

/// Build the STRUCTURED, tools-free request body for one companion turn.
///
/// This is the single-object `{ reply, status }` contract, used ONLY for a
/// tools-free turn (`offer_skills = false`, e.g. the avatar joke). A
/// skill-capable turn runs the SHIPPED tools body with NO `response_format`
/// ([`run_tools_attempt`]) — the tool offer and the structured status never
/// coexist in one request (ST-6).
///
/// The probe-proven no-tools [`chat::build_response_format_request_body`] with
/// the `fredo_reply` schema name; audio, when present, rides the shipped audio
/// body plus the same block.
///
/// The [`with_status_instruction`] fragment is appended to the FIRST `system`
/// message of the supplied conversation.
pub fn build_structured_status_request_body(
    messages: &mut Vec<LlmMessage>,
    audio_base64: Option<&str>,
) -> Value {
    with_status_instruction(messages);

    match audio_base64 {
        Some(audio) => {
            let mut body = chat::build_audio_request_body(messages, audio);
            body["response_format"] = status_response_format();
            body
        }
        None => chat::build_response_format_request_body(
            messages,
            FREDO_STATUS_SCHEMA_NAME,
            &fredo_status_schema(),
        ),
    }
}

/// Build the ST-6 status-only request body: the turn's original conversation,
/// the just-streamed reply as an `assistant` turn, and
/// [`STATUS_ONLY_INSTRUCTION`] as the next `user` turn — constrained to the
/// [`fredo_status_only_schema`] `{status}` object.
///
/// It never offers `tools` (the status pass is a second, tools-free request over
/// the tools-path reply), and its own content is never forwarded as a token.
pub fn build_status_only_request_body(messages: &[LlmMessage], streamed_reply: &str) -> Value {
    let mut conversation: Vec<LlmMessage> = messages.to_vec();
    conversation.push(LlmMessage {
        role: "assistant".to_string(),
        content: streamed_reply.to_string(),
    });
    conversation.push(LlmMessage {
        role: "user".to_string(),
        content: STATUS_ONLY_INSTRUCTION.to_string(),
    });
    chat::build_response_format_request_body(
        &conversation,
        FREDO_STATUS_ONLY_SCHEMA_NAME,
        &fredo_status_only_schema(),
    )
}

// ── Incremental reply-only extraction (pure; R-3/R-4) ─────────────────────────

/// The terminal verdict of one structured stream.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReplyEnvelope {
    /// A valid object carrying a non-empty `reply` string; `status` is the raw
    /// declared value, or [`DEFAULT_FREDO_STATUS`] when absent/blank.
    Parsed { reply: String, status: String },
    /// R-6: non-empty content with NO JSON object syntax — the plain reply text,
    /// forwarded verbatim with the default status.
    Plain { reply: String },
    /// Empty / whitespace-only content (R-5) — the caller takes the bounded plain
    /// retry.
    Empty,
    /// `{`-bearing content that is not a valid object carrying a `reply` string
    /// (R-6) — the caller takes the bounded plain retry; the raw content is never
    /// forwarded.
    NonConforming,
}

/// The state of the incremental scanner.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum ScanPhase {
    /// Outside the top-level object.
    #[default]
    Ground,
    /// Inside the top-level object, between members.
    Object,
    /// Inside a key string.
    Key,
    /// After a key string closed, expecting `:`.
    ExpectColon,
    /// After `:`, expecting the value.
    ExpectValue,
    /// Inside the `reply` string value — decoded characters are forwarded.
    Reply,
    /// Inside a non-`reply` string value — skipped.
    SkipValue,
    /// The `reply` value closed (or could not be a string) — stop scanning.
    Done,
}

/// The step result of decoding a (possibly incomplete) escape sequence.
enum EscapeStep {
    /// More characters are needed (the fragment is withheld).
    Incomplete,
    /// A complete escape decoded to an optional character (a lone `\uXXXX`
    /// surrogate decodes to nothing).
    Decoded(Option<char>),
}

/// Incrementally decode the `reply` string value out of a streamed JSON object.
///
/// `push` returns ONLY the decoded reply characters safe to forward as
/// `llm-token` — empty before the `reply` value opens and after it closes — and
/// withholds an incomplete fragment across token/SSE boundaries. The UTF-8 byte
/// splits are handled once by the shared SSE line drainer; `push` therefore
/// always receives valid `&str` and a multi-byte character is never torn here.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReplyEnvelopeExtractor {
    phase: ScanPhase,
    /// The key string currently being read (compared against `reply`).
    key: String,
    /// Whether the previous key character was an escape backslash.
    key_escaped: bool,
    /// The pending escape sequence inside the reply value.
    escape: String,
    /// Whether the previous skipped-value character was an escape backslash.
    skip_escaped: bool,
    /// The full raw content, kept for the finish-time verdict.
    raw: String,
    /// Every character already forwarded as `llm-token`.
    forwarded: String,
}

impl ReplyEnvelopeExtractor {
    /// A fresh extractor.
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed one content delta; return ONLY the decoded `reply` characters safe to
    /// forward as `llm-token`.
    pub fn push(&mut self, delta: &str) -> String {
        self.raw.push_str(delta);
        let mut out = String::new();
        for character in delta.chars() {
            self.step(character, &mut out);
        }
        self.forwarded.push_str(&out);
        out
    }

    /// The characters already forwarded (the progressive reply so far).
    pub fn forwarded(&self) -> &str {
        &self.forwarded
    }

    /// At finish: the parsed object, the plain-prose fallback, or
    /// [`ReplyEnvelope::Empty`] / [`ReplyEnvelope::NonConforming`].
    pub fn finish(self) -> ReplyEnvelope {
        let trimmed = self.raw.trim();
        if trimmed.is_empty() {
            return ReplyEnvelope::Empty;
        }
        match serde_json::from_str::<Value>(trimmed) {
            Ok(Value::Object(object)) => match object.get("reply") {
                Some(Value::String(reply)) if !reply.trim().is_empty() => {
                    let status = object
                        .get("status")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|status| !status.is_empty())
                        .unwrap_or(DEFAULT_FREDO_STATUS)
                        .to_string();
                    ReplyEnvelope::Parsed {
                        reply: reply.clone(),
                        status,
                    }
                }
                // A present-but-empty reply is the documented empty failure (R-5).
                Some(Value::String(_)) => ReplyEnvelope::Empty,
                _ => fallback_envelope(trimmed),
            },
            _ => fallback_envelope(trimmed),
        }
    }

    /// Advance the scanner by one character, appending forwardable reply text.
    fn step(&mut self, character: char, out: &mut String) {
        match self.phase {
            ScanPhase::Ground => {
                // Only the top-level object opens key scanning, so prose quotes
                // before the object can never be mistaken for a key.
                if character == '{' {
                    self.phase = ScanPhase::Object;
                }
            }
            ScanPhase::Object => {
                if character == '"' {
                    self.key.clear();
                    self.key_escaped = false;
                    self.phase = ScanPhase::Key;
                }
            }
            ScanPhase::Key => {
                if self.key_escaped {
                    self.key.push(character);
                    self.key_escaped = false;
                } else if character == '\\' {
                    self.key_escaped = true;
                } else if character == '"' {
                    self.phase = ScanPhase::ExpectColon;
                } else {
                    self.key.push(character);
                }
            }
            ScanPhase::ExpectColon => {
                if character == ':' {
                    self.phase = ScanPhase::ExpectValue;
                }
            }
            ScanPhase::ExpectValue => match character {
                '"' => {
                    if self.key == "reply" {
                        self.escape.clear();
                        self.phase = ScanPhase::Reply;
                    } else {
                        self.skip_escaped = false;
                        self.phase = ScanPhase::SkipValue;
                    }
                }
                // A non-string value: `reply` is non-conforming; any other key
                // resyncs at the next member.
                _ if character.is_whitespace() => {}
                _ if self.key == "reply" => self.phase = ScanPhase::Done,
                _ => self.phase = ScanPhase::Object,
            },
            ScanPhase::Reply => {
                if !self.escape.is_empty() {
                    self.escape.push(character);
                    if let EscapeStep::Decoded(decoded) = decode_escape(&self.escape) {
                        if let Some(decoded) = decoded {
                            out.push(decoded);
                        }
                        self.escape.clear();
                    }
                } else if character == '\\' {
                    self.escape.push('\\');
                } else if character == '"' {
                    self.phase = ScanPhase::Done;
                } else {
                    out.push(character);
                }
            }
            ScanPhase::SkipValue => {
                if self.skip_escaped {
                    self.skip_escaped = false;
                } else if character == '\\' {
                    self.skip_escaped = true;
                } else if character == '"' {
                    self.phase = ScanPhase::Object;
                }
            }
            ScanPhase::Done => {}
        }
    }
}

/// The R-6 verdict for non-object content: prose with no `{` is forwarded
/// verbatim, while `{`-bearing content is treated as a failed object.
fn fallback_envelope(trimmed: &str) -> ReplyEnvelope {
    if trimmed.contains('{') {
        ReplyEnvelope::NonConforming
    } else {
        ReplyEnvelope::Plain {
            reply: trimmed.to_string(),
        }
    }
}

/// Decode a complete JSON escape sequence, or report that more input is needed.
fn decode_escape(escape: &str) -> EscapeStep {
    let mut characters = escape.chars();
    if characters.next() != Some('\\') {
        return EscapeStep::Decoded(None);
    }
    let Some(kind) = characters.next() else {
        return EscapeStep::Incomplete;
    };
    match kind {
        '"' => EscapeStep::Decoded(Some('"')),
        '\\' => EscapeStep::Decoded(Some('\\')),
        '/' => EscapeStep::Decoded(Some('/')),
        'n' => EscapeStep::Decoded(Some('\n')),
        't' => EscapeStep::Decoded(Some('\t')),
        'r' => EscapeStep::Decoded(Some('\r')),
        'b' => EscapeStep::Decoded(Some('\u{08}')),
        'f' => EscapeStep::Decoded(Some('\u{0c}')),
        'u' => {
            let hex: String = characters.collect();
            if hex.chars().count() < 4 {
                return EscapeStep::Incomplete;
            }
            let code: String = hex.chars().take(4).collect();
            let decoded = u32::from_str_radix(&code, 16)
                .ok()
                .and_then(char::from_u32);
            EscapeStep::Decoded(decoded)
        }
        _ => EscapeStep::Decoded(Some(kind)),
    }
}

// ── Streaming orchestration ───────────────────────────────────────────────────

/// The outcome of ONE structured stream attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StructuredAttempt {
    /// The turn settled (the terminal events were emitted).
    Settled,
    /// No usable object — empty (R-5) or `{`-bearing non-conforming (R-6): the
    /// caller takes the bounded plain retry.
    Retry,
}

/// Whether the structured-status path should be used for this turn.
///
/// ST-2 wires the CACHED `response_format` capability verdict into this ONE
/// decision point. The cache is keyed by the resolved managed `(host, port)`
/// (`probe::resolved_status_capability`), populated by
/// `companion_status_capability`; the probe therefore never runs per turn. When
/// the cached verdict says unsupported / unreachable / erroring, the turn
/// delegates to the shipped plain path (R-7): plain-text reply, no `llm-status`,
/// no user-visible error. An unprobed `(host, port)` attempts the structured path,
/// which already degrades through the bounded plain retry (R-5/R-6).
fn should_use_structured_status(app: &AppHandle) -> bool {
    should_use_structured_status_for(super::probe::resolved_status_capability(app).as_ref())
}

/// Pure: the gate decision for a cached capability (`None` = not probed yet).
fn should_use_structured_status_for(
    capability: Option<&super::probe::StatusCapability>,
) -> bool {
    capability.map(|capability| capability.supported).unwrap_or(true)
}

/// Emit the parsed status on the ADDITIVE `llm-status` channel (before the
/// shipped `llm-done`), healing a blank value to the default.
fn emit_status(app: &AppHandle, status: &str) {
    let status = if status.trim().is_empty() {
        DEFAULT_FREDO_STATUS
    } else {
        status
    };
    let _ = app.emit(LLM_STATUS_EVENT, status.to_string());
}

/// Run ONE structured stream: reply-only tokens, the shipped terminal plan for a
/// tool-call turn, and `llm-status` + `llm-done` for a content turn.
///
/// The body is the TOOLS-FREE `{ reply, status }` contract (ST-6) — a
/// skill-capable turn never reaches here. `Err` is a transport/launch failure
/// (the caller retries the plain path).
async fn run_structured_attempt(
    app: &AppHandle,
    messages: &[LlmMessage],
    audio_base64: Option<&str>,
) -> Result<StructuredAttempt, String> {
    let mut structured_messages = messages.to_vec();
    let body = build_structured_status_request_body(&mut structured_messages, audio_base64);

    let registry = SkillRegistry::with_app_control();
    let mut accumulator = ToolCallAccumulator::new();
    let mut extractor = ReplyEnvelopeExtractor::new();

    chat::run_stream(app, &body, |frame: ChatSseFrame| {
        for event in frame.events {
            match event {
                ChatStreamEvent::Delta(delta) => {
                    let reply = extractor.push(&delta);
                    if !reply.is_empty() {
                        let _ = app.emit("llm-token", reply);
                    }
                }
                // Tool-call fragments buffer VERBATIM in the shipped accumulator.
                other => {
                    let _ = accumulator.push(other);
                }
            }
        }
        if let Some(reason) = frame.finish_reason {
            accumulator.set_finish_reason(reason);
        }
        // The turn always settles after the stream, never mid-frame.
        false
    })
    .await?;

    // A tool-call turn is disjoint from a content turn: it settles through the
    // SHIPPED terminal plan (`llm-skill-call` / readable `llm-error` / one
    // `llm-done`) and NEVER emits `llm-status`.
    let planned = plan_terminal_events(&registry, &accumulator);
    if planned
        .iter()
        .any(|event| !matches!(event, TerminalEvent::Done))
    {
        for event in planned {
            emit_terminal_event(app, event);
        }
        return Ok(StructuredAttempt::Settled);
    }

    let forwarded = extractor.forwarded().to_string();
    match extractor.finish() {
        ReplyEnvelope::Parsed { reply, status } => {
            // Progressive forwarding already sent the reply; the guarded tail
            // guarantees the full text even if the scanner could not.
            let tail = reply_tail(&reply, &forwarded);
            if !tail.is_empty() {
                let _ = app.emit("llm-token", tail);
            }
            emit_status(app, &status);
            emit_terminal_event(app, TerminalEvent::Done);
            Ok(StructuredAttempt::Settled)
        }
        ReplyEnvelope::Plain { reply } => {
            // R-6: non-object prose is forwarded VERBATIM as the plain reply; no
            // status was declared, so no `llm-status` is emitted (the frontend's
            // safe default applies).
            let tail = reply_tail(&reply, &forwarded);
            if !tail.is_empty() {
                let _ = app.emit("llm-token", tail);
            }
            emit_terminal_event(app, TerminalEvent::Done);
            Ok(StructuredAttempt::Settled)
        }
        ReplyEnvelope::Empty | ReplyEnvelope::NonConforming => Ok(StructuredAttempt::Retry),
    }
}

/// The still-unforwarded suffix of `reply` given what already crossed IPC.
///
/// A non-prefix divergence (only reachable through exotic escape decoding) is
/// not re-emitted, so a reply can never be duplicated.
fn reply_tail(reply: &str, forwarded: &str) -> String {
    match reply.strip_prefix(forwarded) {
        Some(rest) => rest.to_string(),
        None if forwarded.is_empty() => reply.to_string(),
        None => String::new(),
    }
}

/// Run ONE bounded status-only pass over the just-streamed prose reply (ST-6).
///
/// Returns the declared status when the pass produced a non-empty `status`
/// string, or `None` — the safe default — on a transport failure, malformed
/// output, an empty value, or the [`STATUS_PASS_TIMEOUT_S`] budget. The pass's
/// own content is accumulated for parsing only and is NEVER forwarded as
/// `llm-token`.
async fn run_status_pass(
    app: &AppHandle,
    messages: &[LlmMessage],
    streamed_reply: &str,
) -> Option<String> {
    let body = build_status_only_request_body(messages, streamed_reply);

    let mut content = String::new();
    let stream = chat::run_stream(app, &body, |frame: ChatSseFrame| {
        for event in frame.events {
            if let ChatStreamEvent::Delta(delta) = event {
                content.push_str(&delta);
            }
        }
        // The turn always settles after the stream, never mid-frame.
        false
    });

    // One attempt, bounded so it can never outlive the turn envelope.
    let Ok(Ok(())) = tokio::time::timeout(Duration::from_secs(STATUS_PASS_TIMEOUT_S), stream).await
    else {
        return None;
    };

    serde_json::from_str::<Value>(content.trim())
        .ok()?
        .get("status")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|status| !status.is_empty())
        .map(str::to_string)
}

/// Run ONE skill-capable turn through the SHIPPED tools path (ST-6).
///
/// The body is the SHIPPED [`build_skill_request_body`] /
/// [`build_audio_skill_request_body`] output with NO `response_format`, so the
/// native tool call is never displaced by the schema grammar. Content deltas are
/// forwarded VERBATIM as `llm-token` while tool-call fragments buffer in the
/// SHIPPED [`ToolCallAccumulator`]. A tool-call or failed turn settles through
/// the SHIPPED [`plan_terminal_events`] and NEVER emits `llm-status`; only a
/// content-only prose turn obtains its status from ONE bounded status-only pass.
async fn run_tools_attempt(
    app: &AppHandle,
    messages: &[LlmMessage],
    audio_base64: Option<&str>,
) -> Result<(), String> {
    let registry = SkillRegistry::with_app_control();
    let body = match audio_base64 {
        Some(audio) => build_audio_skill_request_body(messages, audio, &registry),
        None => build_skill_request_body(messages, &registry),
    };

    let mut accumulator = ToolCallAccumulator::new();
    let mut prose = String::new();

    chat::run_stream(app, &body, |frame: ChatSseFrame| {
        for event in frame.events {
            match event {
                // The prose streams exactly as the shipped tools path does.
                ChatStreamEvent::Delta(delta) => {
                    prose.push_str(&delta);
                    let _ = app.emit("llm-token", delta);
                }
                // Tool-call fragments buffer VERBATIM in the shipped accumulator.
                other => {
                    let _ = accumulator.push(other);
                }
            }
        }
        if let Some(reason) = frame.finish_reason {
            accumulator.set_finish_reason(reason);
        }
        // The turn always settles after the stream, never mid-frame.
        false
    })
    .await?;

    // A tool-call (or failed) turn is disjoint from a content turn: it settles
    // through the SHIPPED terminal plan (`llm-skill-call` / readable `llm-error`
    // / one `llm-done`) and NEVER emits `llm-status`.
    let planned = plan_terminal_events(&registry, &accumulator);
    if planned
        .iter()
        .any(|event| !matches!(event, TerminalEvent::Done))
    {
        for event in planned {
            emit_terminal_event(app, event);
        }
        return Ok(());
    }

    // Content-only prose turn: the status comes from ONE bounded status-only
    // pass (never from the tools body). An empty prose, a false gate, a failed
    // pass, or a timeout emits NO `llm-status` — the frontend's default applies.
    if should_use_structured_status(app) && !prose.trim().is_empty() {
        if let Some(status) = run_status_pass(app, messages, &prose).await {
            emit_status(app, &status);
        }
    }
    emit_terminal_event(app, TerminalEvent::Done);
    Ok(())
}

/// Re-run the SHIPPED plain path for the SAME turn (R-5/R-6).
///
/// A skill-offered turn reuses the skill stream (tools offered, no
/// `response_format`); the tools-free turn streams content-only. Every path
/// settles with exactly one `llm-done`.
async fn run_plain_retry(
    app: &AppHandle,
    messages: &[LlmMessage],
    offer_skills: bool,
    audio_base64: Option<&str>,
) -> Result<(), String> {
    if offer_skills {
        let registry = SkillRegistry::with_app_control();
        let body = match audio_base64 {
            Some(audio) => build_audio_skill_request_body(messages, audio, &registry),
            None => build_skill_request_body(messages, &registry),
        };
        skills::run_skill_stream(app, &registry, &body).await
    } else {
        let body = match audio_base64 {
            Some(audio) => chat::build_audio_request_body(messages, audio),
            None => chat::build_request_body(messages, None),
        };
        skills::run_plain_stream(app, &body).await
    }
}

/// The turn orchestrator (ST-6 split).
///
/// * `offer_skills = true` — the SHIPPED tools path (NO `response_format`),
///   never gated by the capability verdict, so skills always work; a
///   content-only turn then takes ONE bounded status-only pass.
/// * `offer_skills = false` — the tools-free structured attempt (when the
///   capability gate allows it), then the bounded plain retry for the same turn.
async fn run_status_chat(
    app: &AppHandle,
    messages: Vec<LlmMessage>,
    offer_skills: bool,
    audio_base64: Option<String>,
) -> Result<(), String> {
    if offer_skills {
        return run_tools_attempt(app, &messages, audio_base64.as_deref()).await;
    }

    let mut attempt = 0usize;
    loop {
        if attempt == 0 && should_use_structured_status(app) {
            match run_structured_attempt(app, &messages, audio_base64.as_deref()).await {
                Ok(StructuredAttempt::Settled) => return Ok(()),
                Ok(StructuredAttempt::Retry) | Err(_) => {}
            }
            attempt += 1;
            if attempt > STATUS_EMPTY_RETRY_MAX {
                for event in plan_stream_error_events(NO_STATUS_RETRY_DETAIL) {
                    emit_terminal_event(app, event);
                }
                return Ok(());
            }
            continue;
        }
        // R-5/R-6 — the bounded retry re-runs the shipped plain path for the SAME
        // turn; it always settles with exactly one `llm-done`.
        return run_plain_retry(app, &messages, offer_skills, audio_base64.as_deref()).await;
    }
}

/// Kick off a structured-status streaming turn on a background task and return
/// immediately (never blocks the IPC call).
pub fn spawn_chat_with_status(
    app: AppHandle,
    messages: Vec<LlmMessage>,
    offer_skills: bool,
    audio_base64: Option<String>,
) {
    tauri::async_runtime::spawn(async move {
        if let Err(detail) = run_status_chat(&app, messages, offer_skills, audio_base64).await {
            // Never hang: the shipped terminal vocabulary (`llm-error` then one
            // `llm-done`) for any failure that escaped the attempt logic.
            for event in plan_stream_error_events(&detail) {
                emit_terminal_event(&app, event);
            }
        }
    });
}

/// Stream a companion reply under the JSON-Schema status contract (Spec #2918,
/// ST-1; ST-6 separation).
///
/// Additive to `llm_chat` / `llm_chat_with_skills`, which stay unchanged. A
/// skill-capable turn (`offer_skills = true`) runs the SHIPPED tools path with
/// NO `response_format` (skills keep working) and, on a content-only turn,
/// derives the status from ONE bounded status-only pass; a tools-free turn
/// (`offer_skills = false`) obtains `{ reply, status }` in one object. In both
/// cases the parsed status is emitted on `llm-status` before the shipped
/// `llm-done`, never on a skill/error turn.
#[tauri::command]
pub async fn llm_chat_with_status(
    messages: Vec<LlmMessage>,
    offer_skills: bool,
    audio_base64: Option<String>,
    app: AppHandle,
) -> Result<(), String> {
    spawn_chat_with_status(app, messages, offer_skills, audio_base64);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn message(role: &str, content: &str) -> LlmMessage {
        LlmMessage {
            role: role.to_string(),
            content: content.to_string(),
        }
    }

    fn parsed(reply: &str, status: &str) -> ReplyEnvelope {
        ReplyEnvelope::Parsed {
            reply: reply.to_string(),
            status: status.to_string(),
        }
    }

    // ── R-3: reply-only forwarding ────────────────────────────────────────────

    #[test]
    fn push_forwards_only_the_reply_value_and_never_the_envelope() {
        let mut extractor = ReplyEnvelopeExtractor::new();
        let forwarded = extractor.push(r#"{"reply":"Hello there","status":"happy"}"#);
        assert_eq!(forwarded, "Hello there");
        assert_eq!(extractor.forwarded(), "Hello there");
        assert_eq!(extractor.finish(), parsed("Hello there", "happy"));
    }

    #[test]
    fn push_skips_a_non_reply_value_and_still_finds_the_reply() {
        let mut extractor = ReplyEnvelopeExtractor::new();
        // `status` first (the schema's declared property order) must not leak.
        let forwarded = extractor.push(r#"{"status":"happy","reply":"hi"}"#);
        assert_eq!(forwarded, "hi");
        assert_eq!(extractor.finish(), parsed("hi", "happy"));
    }

    // ── R-4: split-boundary withholding ───────────────────────────────────────

    #[test]
    fn push_withholds_every_incomplete_fragment_across_splits() {
        let mut extractor = ReplyEnvelopeExtractor::new();
        let mut forwarded = String::new();

        // Split 1: inside the `"reply"` key — nothing may leak.
        forwarded.push_str(&extractor.push(r#"{"rep"#));
        assert_eq!(forwarded, "");
        // Split 2: through `":{"` and into the value; ends on a lone escape.
        forwarded.push_str(&extractor.push(r#"ly":"line1\"#));
        assert_eq!(forwarded, "line1");
        // Split 3: completes `\n`, then ends on a lone escape.
        forwarded.push_str(&extractor.push("nline2 \\"));
        assert_eq!(forwarded, "line1\nline2 ");
        // Split 4: two split escapes and a trailing space.
        forwarded.push_str(&extractor.push("\"q\\\" "));
        assert_eq!(forwarded, "line1\nline2 \"q\" ");
        // Split 5: a multi-byte character starts the delta, then the close.
        forwarded.push_str(&extractor.push("🚀\",\"status\":\"happy\"}"));
        assert_eq!(forwarded, "line1\nline2 \"q\" 🚀");

        // No envelope character or key ever surfaced.
        assert!(!forwarded.contains('{'));
        assert!(!forwarded.contains('}'));
        assert!(!forwarded.contains("reply"));
        assert!(!forwarded.contains("status"));
        assert_eq!(
            extractor.finish(),
            parsed("line1\nline2 \"q\" 🚀", "happy")
        );
    }

    #[test]
    fn push_forwards_a_multibyte_character_that_starts_a_delta() {
        let mut extractor = ReplyEnvelopeExtractor::new();
        assert_eq!(extractor.push("{\"reply\":\"a"), "a");
        // The boundary is between deltas; the character itself is whole.
        assert_eq!(extractor.push("é"), "é");
        assert_eq!(extractor.push("b\"}"), "b");
        assert_eq!(
            extractor.finish(),
            parsed("aéb", DEFAULT_FREDO_STATUS)
        );
    }

    #[test]
    fn push_withholds_the_prefix_of_the_reply_value() {
        let mut extractor = ReplyEnvelopeExtractor::new();
        assert_eq!(extractor.push("{\"re"), "");
        assert_eq!(extractor.push("ply\":"), "");
        assert_eq!(extractor.push("\""), "");
        assert_eq!(extractor.push("Hi"), "Hi");
        assert_eq!(extractor.push("\",\"status\":\"happy\"}"), "");
        assert_eq!(extractor.finish(), parsed("Hi", "happy"));
    }

    // ── R-5/R-6: the finish verdict ───────────────────────────────────────────

    #[test]
    fn finish_defaults_the_status_when_absent_or_blank() {
        let mut extractor = ReplyEnvelopeExtractor::new();
        extractor.push(r#"{"reply":"hello"}"#);
        assert_eq!(extractor.finish(), parsed("hello", DEFAULT_FREDO_STATUS));

        let mut extractor = ReplyEnvelopeExtractor::new();
        extractor.push(r#"{"reply":"hello","status":"   "}"#);
        assert_eq!(extractor.finish(), parsed("hello", DEFAULT_FREDO_STATUS));
    }

    #[test]
    fn finish_treats_empty_and_blank_reply_content_as_empty() {
        assert_eq!(ReplyEnvelopeExtractor::new().finish(), ReplyEnvelope::Empty);

        let mut blank = ReplyEnvelopeExtractor::new();
        blank.push("   \n  ");
        assert_eq!(blank.finish(), ReplyEnvelope::Empty);

        let mut empty_reply = ReplyEnvelopeExtractor::new();
        empty_reply.push(r#"{"reply":"","status":"happy"}"#);
        assert_eq!(empty_reply.finish(), ReplyEnvelope::Empty);

        let mut whitespace_reply = ReplyEnvelopeExtractor::new();
        whitespace_reply.push(r#"{"reply":"   ","status":"happy"}"#);
        assert_eq!(whitespace_reply.finish(), ReplyEnvelope::Empty);
    }

    #[test]
    fn finish_forwards_brace_free_prose_verbatim() {
        let mut extractor = ReplyEnvelopeExtractor::new();
        extractor.push("not json at all");
        assert_eq!(
            extractor.finish(),
            ReplyEnvelope::Plain {
                reply: "not json at all".to_string()
            }
        );

        // A valid non-object JSON value carries no `{`, so it is plain too.
        let mut scalar = ReplyEnvelopeExtractor::new();
        scalar.push("123");
        assert_eq!(
            scalar.finish(),
            ReplyEnvelope::Plain {
                reply: "123".to_string()
            }
        );
    }

    #[test]
    fn finish_marks_brace_bearing_nonconforming_content() {
        // A truncated object.
        let mut truncated = ReplyEnvelopeExtractor::new();
        truncated.push(r#"{"reply":"half"#);
        assert_eq!(truncated.finish(), ReplyEnvelope::NonConforming);

        // An object with no `reply` string.
        let mut no_reply = ReplyEnvelopeExtractor::new();
        no_reply.push(r#"{"status":"happy"}"#);
        assert_eq!(no_reply.finish(), ReplyEnvelope::NonConforming);

        // A non-string `reply` value.
        let mut typed = ReplyEnvelopeExtractor::new();
        typed.push(r#"{"reply":123}"#);
        assert_eq!(typed.forwarded(), "");
        assert_eq!(typed.finish(), ReplyEnvelope::NonConforming);
    }

    // ── R-8: the closed schema + the prompt contract ──────────────────────────

    #[test]
    fn the_status_schema_is_closed_over_the_seven_statuses() {
        let schema = fredo_status_schema();
        assert_eq!(schema["type"], "object");
        assert_eq!(schema["required"], json!(["reply", "status"]));
        assert_eq!(schema["additionalProperties"], false);
        assert_eq!(schema["properties"]["reply"]["type"], "string");
        assert_eq!(schema["properties"]["status"]["type"], "string");

        let values = schema["properties"]["status"]["enum"]
            .as_array()
            .expect("the status enum must be an array");
        let values: Vec<&str> = values.iter().filter_map(Value::as_str).collect();
        assert_eq!(values, FREDO_STATUS_VALUES.to_vec());
        assert_eq!(values.len(), 7);
        assert!(values.contains(&DEFAULT_FREDO_STATUS));
    }

    #[test]
    fn the_status_instruction_has_the_literal_json_word_and_an_example() {
        assert!(
            STATUS_INSTRUCTION.contains("json"),
            "must contain the literal word json: {STATUS_INSTRUCTION}"
        );
        assert!(STATUS_INSTRUCTION.contains("Example"));
        assert!(STATUS_INSTRUCTION.contains("\"reply\""));
        assert!(STATUS_INSTRUCTION.contains("\"status\""));
        assert!(STATUS_INSTRUCTION.contains("nothing else"));
        // Never instruct free-text JSON.
        assert!(!STATUS_INSTRUCTION.to_lowercase().contains("free"));
    }

    #[test]
    fn with_status_instruction_appends_to_the_first_system_message() {
        let mut messages = vec![message("system", "be terse"), message("user", "hi")];
        with_status_instruction(&mut messages);
        assert_eq!(messages.len(), 2);
        assert!(messages[0].content.starts_with("be terse"));
        assert!(messages[0].content.contains("json"));
        assert_eq!(messages[1].content, "hi");
    }

    #[test]
    fn with_status_instruction_inserts_a_system_turn_when_none_exists() {
        let mut messages = vec![message("user", "hi")];
        with_status_instruction(&mut messages);
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, "system");
        assert_eq!(messages[0].content, STATUS_INSTRUCTION);
        assert_eq!(messages[1].content, "hi");
    }

    #[test]
    fn with_status_instruction_targets_only_the_first_of_several_system_turns() {
        let mut messages = vec![message("system", "first"), message("system", "second")];
        with_status_instruction(&mut messages);
        assert!(messages[0].content.contains("json"));
        assert_eq!(messages[1].content, "second");
    }

    // ── #2918 ST-6: the request bodies (the tool offer and the structured
    //    status never coexist in one request) ─────────────────────────────────

    /// (i) The tools bodies the status path uses carry **NO `response_format`
    /// key** — the combined body that displaced the native tool call is gone.
    #[test]
    fn the_tools_bodies_on_the_status_path_carry_no_response_format() {
        let registry = SkillRegistry::with_app_control();
        let messages = vec![
            message("system", "be terse"),
            message("user", "open Mission Monitor"),
        ];

        let skill = build_skill_request_body(&messages, &registry);
        let audio_skill = build_audio_skill_request_body(&messages, "UklGRg==", &registry);
        let tools = chat::build_tools_request_body(
            &messages,
            &skills::render_tools(&registry),
            "auto",
            false,
        );

        for (label, body) in [
            ("skill", &skill),
            ("audio skill", &audio_skill),
            ("tools", &tools),
        ] {
            assert!(
                body.get("response_format").is_none(),
                "{label} body must carry NO response_format: {body}"
            );
            assert_eq!(body["tools"], skills::render_tools(&registry), "{label} tools");
            assert_eq!(body["tool_choice"], "auto", "{label} tool_choice");
            assert_eq!(body["parallel_tool_calls"], false, "{label}");
            assert_eq!(body["stream"], true, "{label}");
            assert_eq!(body["max_tokens"], 1024, "{label}");
        }

        // The tools-free structured contract is a DIFFERENT body entirely: it
        // carries the `response_format` block and NO tools.
        let mut structured_messages = vec![message("user", "tell me a joke")];
        let structured = build_structured_status_request_body(&mut structured_messages, None);
        assert!(structured.get("tools").is_none());
        assert!(structured.get("response_format").is_some());
    }

    /// (ii) The status-only schema is closed over the SAME 7 values with
    /// `additionalProperties: false` and carries NO `reply` property.
    #[test]
    fn the_status_only_schema_is_closed_over_the_same_seven_statuses() {
        let schema = fredo_status_only_schema();
        assert_eq!(schema["type"], "object");
        assert_eq!(schema["required"], json!(["status"]));
        assert_eq!(schema["additionalProperties"], false);
        assert_eq!(schema["properties"]["status"]["type"], "string");
        assert!(schema["properties"].get("reply").is_none());

        let values = schema["properties"]["status"]["enum"]
            .as_array()
            .expect("the status enum must be an array");
        let values: Vec<&str> = values.iter().filter_map(Value::as_str).collect();
        assert_eq!(values, FREDO_STATUS_VALUES.to_vec());
        assert_eq!(values.len(), 7);
        assert!(values.contains(&DEFAULT_FREDO_STATUS));
    }

    /// (iii) `STATUS_ONLY_INSTRUCTION` contains the literal `json` word + a
    /// concrete example + the closed 7-value set, and never instructs free-text
    /// JSON.
    #[test]
    fn the_status_only_instruction_has_the_literal_json_word_and_an_example() {
        assert!(
            STATUS_ONLY_INSTRUCTION.contains("json"),
            "must contain the literal word json: {STATUS_ONLY_INSTRUCTION}"
        );
        assert!(STATUS_ONLY_INSTRUCTION.contains("Example"));
        assert!(STATUS_ONLY_INSTRUCTION.contains("\"status\""));
        assert!(STATUS_ONLY_INSTRUCTION.contains("nothing else"));
        for value in FREDO_STATUS_VALUES {
            assert!(
                STATUS_ONLY_INSTRUCTION.contains(value),
                "the closed set must be stated: {value}"
            );
        }
        // Never instruct free-text JSON.
        assert!(!STATUS_ONLY_INSTRUCTION.to_lowercase().contains("free"));
    }

    /// The status-only body is tools-free, constrained to the status-only
    /// schema, and appends the streamed reply as an assistant turn plus the
    /// status instruction as the next user turn.
    #[test]
    fn the_status_only_body_is_tools_free_and_carries_the_reply_and_instruction() {
        let messages = vec![message("system", "be terse"), message("user", "hi")];
        let body = build_status_only_request_body(&messages, "Hello there");

        assert!(body.get("tools").is_none());
        assert_eq!(body["stream"], true);
        assert_eq!(body["max_tokens"], 1024);
        assert_eq!(body["response_format"]["type"], "json_schema");
        assert_eq!(
            body["response_format"]["json_schema"]["name"],
            FREDO_STATUS_ONLY_SCHEMA_NAME
        );
        assert_eq!(
            body["response_format"]["json_schema"]["schema"],
            fredo_status_only_schema()
        );

        let rendered = body["messages"].as_array().expect("messages array");
        assert_eq!(rendered.len(), 4);
        assert_eq!(rendered[0]["role"], "system");
        assert_eq!(rendered[1]["role"], "user");
        assert_eq!(rendered[1]["content"], "hi");
        assert_eq!(rendered[2]["role"], "assistant");
        assert_eq!(rendered[2]["content"], "Hello there");
        assert_eq!(rendered[3]["role"], "user");
        assert_eq!(rendered[3]["content"], STATUS_ONLY_INSTRUCTION);
    }

    #[test]
    fn the_tools_free_status_body_is_the_probe_proven_no_tools_variant() {
        let mut messages = vec![message("user", "tell me a joke")];
        let body = build_structured_status_request_body(&mut messages, None);
        assert!(body.get("tools").is_none());
        assert_eq!(body["stream"], true);
        assert_eq!(body["max_tokens"], 1024);
        assert_eq!(body["response_format"]["type"], "json_schema");
        assert_eq!(
            body["response_format"]["json_schema"]["name"],
            FREDO_STATUS_SCHEMA_NAME
        );
        assert_eq!(
            body["response_format"]["json_schema"]["schema"],
            fredo_status_schema()
        );
        // The structured prompt fragment is on the FIRST system turn.
        assert!(body["messages"][0]["content"]
            .as_str()
            .unwrap_or_default()
            .contains("json"));
    }

    #[test]
    fn the_status_schema_name_is_fredo_reply() {
        assert_eq!(FREDO_STATUS_SCHEMA_NAME, "fredo_reply");
    }

    #[test]
    fn the_status_only_schema_name_is_fredo_status() {
        assert_eq!(FREDO_STATUS_ONLY_SCHEMA_NAME, "fredo_status");
        assert_ne!(FREDO_STATUS_ONLY_SCHEMA_NAME, FREDO_STATUS_SCHEMA_NAME);
    }

    /// (iv) The shipped `plan_terminal_events` still routes a buffered `open_app`
    /// call to `[SkillCall, Done]` through the new orchestration's accumulator
    /// path: content deltas are forwarded, tool-call fragments buffer VERBATIM,
    /// and the raw tool-call JSON is never a token.
    #[test]
    fn the_tools_attempt_accumulator_path_still_routes_an_open_app_call() {
        let registry = SkillRegistry::with_app_control();
        let mut accumulator = ToolCallAccumulator::new();

        assert_eq!(
            accumulator.push(ChatStreamEvent::Delta("Opening…".to_string())),
            Some("Opening…".to_string())
        );
        assert_eq!(
            accumulator.push(ChatStreamEvent::ToolCallDelta {
                index: 0,
                name: Some("open_app".to_string()),
                arguments_fragment: Some("{\"app\":\"Miss".to_string()),
            }),
            None
        );
        assert_eq!(
            accumulator.push(ChatStreamEvent::ToolCallDelta {
                index: 0,
                name: None,
                arguments_fragment: Some("ion Monitor\"}".to_string()),
            }),
            None,
            "raw tool-call fragments are never forwarded as tokens"
        );
        accumulator.set_finish_reason("tool_calls");

        assert_eq!(
            plan_terminal_events(&registry, &accumulator),
            vec![
                TerminalEvent::SkillCall(skills::SkillCall {
                    skill: "open_app".to_string(),
                    arguments: json!({ "app": "Mission Monitor" }),
                }),
                TerminalEvent::Done,
            ]
        );
    }

    // ── #2918 ST-2: the capability gate (R-7) ─────────────────────────────────

    /// The gate only takes the plain path when the cached capability is KNOWN
    /// unsupported; an unprobed `(host, port)` or a supported verdict uses the
    /// structured path (which degrades through the bounded plain retry).
    #[test]
    fn the_capability_gate_takes_the_plain_path_only_when_known_unsupported() {
        // Not probed for this (host, port) → attempt the structured path.
        assert!(should_use_structured_status_for(None));

        // A cached supported verdict → the structured path.
        assert!(should_use_structured_status_for(Some(
            &super::super::probe::StatusCapability {
                supported: true,
                detail: "schema-constrained content".to_string(),
            }
        )));

        // Unsupported / unreachable / erroring → the shipped plain path (R-7).
        assert!(!should_use_structured_status_for(Some(
            &super::super::probe::StatusCapability {
                supported: false,
                detail: "the response_format capability probe failed: connection refused"
                    .to_string(),
            }
        )));
    }
}
