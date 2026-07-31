//! OpenCodeAdapter — transforms OpenCode hook and OTLP events into FredoEvents.
//!
//! Spec 2, GitHub issue #43: OpenCode Adapter + Consolidation
//! REQ-2.1, REQ-2.2, REQ-2.3, REQ-2.4

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::infrastructure::comm::adapter::CommAdapter;
use crate::infrastructure::comm::event::{
    EventProvider, EventState, EventType, FredoEvent, Transport,
};

// Spec #633 AC-6c: Parent prompt cache + subagent instruction injection contract
use super::contract_633_ac6c;

// Spec #601 contract constants (see contract_601.rs for source definitions).
// Inlined here because the contract module may not be registered in the module tree
// until all capsules are merged.
const CC_ATTR_SESSION_ID: &str = "session.id";
const CC_ATTR_INPUT_TOKENS: &str = "input_tokens";
const CC_ATTR_OUTPUT_TOKENS: &str = "output_tokens";
const CC_ATTR_MODEL: &str = "model";
const CC_ATTR_SPAN_TYPE: &str = "span.type";
const CC_LEGACY_ATTR_CONVERSATION_ID: &str = "gen_ai.conversation.id";
const CC_LEGACY_ATTR_INPUT_TOKENS: &str = "gen_ai.usage.input_tokens";
const CC_LEGACY_ATTR_OUTPUT_TOKENS: &str = "gen_ai.usage.output_tokens";
const CC_LEGACY_ATTR_RESPONSE_MODEL: &str = "gen_ai.response.model";
const CC_OP_CHAT: &str = "chat";
const CC_OP_SESSION: &str = "session";
const CC_OP_TOOL_PREFIX: &str = "tool.";
const CC_SPAN_LLM_PREFIX: &str = "fredo.llm";
const CC_SPAN_SESSION_PREFIX: &str = "fredo.session";
const CC_SPAN_TOOL_PREFIX: &str = "fredo.tool.";

/// Whitelist of known @-subagent agent names whose child sessions should be
/// merged into the parent session via ECE compositing. Only user-requested
/// subagent dispatches (via @-mention in opencode) are whitelisted. Internal
/// tool-execution agents (build, plan, bash, read, etc.) are excluded so their
/// sessions remain independent and don't flood the graph with SubagentNodes.
/// Spec #523: Used for session.updated-based relationship detection.
const WHITELIST_SUBAGENT_NAMES: &[&str] = &[
    "general", "architect", "coder", "reviewer",
    "e2e-tester", "retro-analyst", "planner-subagent", "explore",
];

/// OpenCodeAdapter transforms OpenCode plugin hook events and OTLP spans into FredoEvents.
///
/// REQ-2.1: Implements CommAdapter for both IPC hook and OTLP transports
/// REQ-2.2: Hook transform maps PreToolUse → ToolUse/Init, PostToolUse → ToolUse/Response,
///          PostToolUseFailure → ToolUse/Error, lifecycle → AgentSession/Init
/// REQ-2.3: OTLP transform extracts invoke_agent → AgentSession and execute_tool → ToolUse
/// REQ-2.4: Holds trace-to-conversation mapping internally (Mutex<HashMap>)
#[derive(Debug)]
pub struct OpenCodeAdapter {
    /// Internal state for trace-to-conversation mapping.
    /// Key: traceId, Value: session_id (conversation.id)
    trace_to_session: Arc<Mutex<HashMap<String, String>>>,

    /// REQ-3: Internal state for Hook→OTLP correlationId bridging.
    /// Key: session_id, Value: correlationId (messageID from Hook Chat events).
    /// When an OTLP span arrives for the same session, this stored correlationId
    /// is used instead of traceId, so Hook and OTLP events share a single ECE buffer.
    session_to_correlation: Arc<Mutex<HashMap<String, String>>>,

    /// REQ-3 (Spec #382): Tool callID bridging for PreToolUse→PostToolUse correlation.
    /// Key: (session_id, tool_name), Value: callID from tool_input.callID.
    /// Since tool_use_id is always empty in opencode hook events, we derive
    /// correlationId from callID. PostToolUse events lack callID, so we look
    /// it up from this map. The same (session, tool_name) pair is unique within
    /// a turn (sequential tool calls).
    tool_call_id: Arc<Mutex<HashMap<(String, String), String>>>,

    /// Spec #615: OTLP subagent parent-child relationship tracking.
    /// Key: child_session_id, Value: parent_session_id.
    /// Populated by Hook transport when it detects parent-child relationships
    /// (session.updated with parentID, or PostToolUse task with metadata).
    /// OTLP transport looks up parent by the subagent span's session_id.
    /// Unlike trace_id (which differs per session), session_id is the canonical
    /// cross-transport identifier, so Hook→OTLP bridging works correctly.
    session_to_parent: Arc<Mutex<HashMap<String, String>>>,

    /// Spec #639 (REQ-2): Per-session turn counter for pure-OTLP multi-turn sessions.
    /// Key: session_id, Value: turn counter (1-based, incremented on each Init event).
    /// Used to generate unique per-turn correlationIds for pure OTLP sessions
    /// so that each turn's composite ECE key (sessionId, correlationId) is unique.
    /// Hook-bridged sessions do NOT use this counter — they use the stored Hook
    /// correlationId from session_to_correlation. Capped at 10,000 entries with
    /// oldest-first eviction (same pattern as other maps).
    session_turn_counter: Arc<Mutex<HashMap<String, u64>>>,

    /// Bug 1 (Spec #633): Pending task instructions from task tool spans.
    /// Key: parent_session_id (the session where the task tool was called),
    /// Value: task instruction text extracted from the tool_input JSON.
    /// When a task tool span (fredo.tool.task) is processed, the instruction
    /// from tool_input.task is stored here. When a subagent session span is
    /// later processed, it looks up the instruction by the parent session ID
    /// from the relationship metadata.
    pending_task_instructions: Arc<Mutex<HashMap<String, String>>>,

    /// REQ-1 (Spec #633 AC-6c): Cache parent session prompts for subagent instruction injection.
    /// Key: session_id, Value: prompt text from gen_ai.prompt or prompt OTLP attribute.
    /// Capped at 10,000 entries with oldest-first eviction (same pattern as other maps).
    parent_prompts: Arc<Mutex<HashMap<String, String>>>,
}

impl OpenCodeAdapter {
    /// Create a new OpenCodeAdapter.
    pub fn new() -> Self {
        OpenCodeAdapter {
            trace_to_session: Arc::new(Mutex::new(HashMap::new())),
            session_to_correlation: Arc::new(Mutex::new(HashMap::new())),
            tool_call_id: Arc::new(Mutex::new(HashMap::new())),
            session_to_parent: Arc::new(Mutex::new(HashMap::new())),
            session_turn_counter: Arc::new(Mutex::new(HashMap::new())),
            pending_task_instructions: Arc::new(Mutex::new(HashMap::new())),
            parent_prompts: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Transform a Hook transport payload into FredoEvents.
    ///
    /// Handles:
    /// - PreToolUse → ToolUse + Init (detected by tool_input presence)
    /// - PostToolUse → ToolUse + Response (detected by tool_response presence)
    /// - PostToolUseFailure → ToolUse + Error (detected by error presence)
    /// - Lifecycle events (SessionStart, SessionEnd, etc.) → AgentSession + Init
    fn transform_hook(&self, raw: Value) -> anyhow::Result<Vec<FredoEvent>> {
        // Spec #523: Debug logging to capture raw plugin event structures
        let raw_str = serde_json::to_string(&raw).unwrap_or_default();
        let truncated = if raw_str.len() > 2048 {
            format!("{}...<truncated, total {} bytes>", &raw_str[..raw_str.floor_char_boundary(2048)], raw_str.len())
        } else {
            raw_str
        };
        tracing::info!(target: "fredo::plugin", event_type = %raw.get("event_type").and_then(|v| v.as_str()).unwrap_or("(none)"), raw = %truncated, "RAW PLUGIN EVENT");

        // Extract session_id from the SDK event's nested payload.
        // The OpenCode SDK uses camelCase `sessionID`, nested inside
        // `properties`, `tool_input`, or `input` — or at the top level
        // for certain events like experimental.compaction.autocontinue.
        // Events without a sessionID in any path are dropped (no session = no context).
        let extracted_session_id = match raw
            .get("properties")
            .and_then(|v| v.get("sessionID"))
            .and_then(|v| v.as_str())
            .or_else(|| {
                raw.get("tool_input")
                    .and_then(|v| v.get("sessionID"))
                    .and_then(|v| v.as_str())
            })
            .or_else(|| {
                raw.get("input")
                    .and_then(|v| v.get("sessionID"))
                    .and_then(|v| v.as_str())
            })
            .or_else(|| {
                raw.get("sessionID").and_then(|v| v.as_str())
            })
            .or_else(|| {
                // Spec #382: session.created / session.updated / session.deleted
                // etc. nest session ID at properties.info.id (not properties.sessionID).
                // Without this path, session lifecycle events are silently dropped,
                // preventing ChatNode creation (AC-4) and token extraction (AC-3).
                raw.get("properties")
                    .and_then(|v| v.get("info"))
                    .and_then(|v| v.get("id"))
                    .and_then(|v| v.as_str())
            }) {
            Some(s) => s.to_string(),
            None => {
                // REQ-1: Events without a session_id still produce a Custom
                // event so they remain observable, even without session context
                // for ECE buffering.
                tracing::warn!(
                    target: "fredo::adapter",
                    "Hook event with no session_id — emitting as EventType::Custom without session context"
                );

                let mut builder = FredoEvent::builder()
                    .event_type(EventType::Custom)
                    .state(EventState::Init)
                    .provider(EventProvider::OpenCode)
                    .transport(Transport::Hook)
                    .session_id(String::new())
                    .tool_name("no-session-id");

                // Try to extract event_type for the tool_name
                if let Some(et) = raw.get("event_type").and_then(|v| v.as_str()) {
                    builder = builder.tool_name(et);
                }

                let mut event = builder.build();
                event.payload = Some(raw);
                return Ok(vec![event]);
            }
        };

        // Spec #523: No more sessionId rewriting. The session_id flows through
        // as-is. Relationship metadata (when present) is handled by the ECE.
        let session_id = extracted_session_id.as_str();

        // Detect hook event type by examining the payload structure
        // PreToolUse: has tool_input
        // PostToolUse: has tool_response (and no error)
        // PostToolUseFailure: has error field
        // Lifecycle: has session_id or explicit event_type field

        // Check for explicit event_type first
        if let Some(event_type) = raw.get("event_type").and_then(|v| v.as_str()) {
            match event_type {
                // --- Tool use events ---
                "PreToolUse" => return self.transform_pre_tool_use(raw, session_id),
                "PostToolUse" => return self.transform_post_tool_use(raw, session_id),
                "PostToolUseFailure" => {
                    return self.transform_post_tool_use_failure(raw, session_id)
                }

                // --- Permission events ---
                "permission.asked" => {
                    return self.transform_with_event_type(
                        raw,
                        EventType::Custom,
                        EventState::Init,
                        "permission.asked",
                        session_id,
                    )
                }
                "permission.replied" => {
                    return self.transform_with_event_type(
                        raw,
                        EventType::Custom,
                        EventState::Response,
                        "permission.replied",
                        session_id,
                    )
                }

                // --- File / command events ---
                "file.edited" => {
                    return self.transform_with_event_type(
                        raw,
                        EventType::Custom,
                        EventState::Response,
                        "file.edited",
                        session_id,
                    )
                }
                "command.executed" => {
                    return self.transform_with_event_type(
                        raw,
                        EventType::Custom,
                        EventState::Response,
                        "command.executed",
                        session_id,
                    )
                }

                // --- Chat / message events ---
                "UserPromptSubmit" => {
                    return self.transform_with_event_type(
                        raw,
                        EventType::Chat,
                        EventState::Init,
                        "UserPromptSubmit",
                        session_id,
                    )
                }
                "chat.message" => {
                    // FIX-586: Check output.message.role to distinguish user vs assistant
                    let state = raw
                        .get("output")
                        .and_then(|v| v.get("message"))
                        .and_then(|v| v.get("role"))
                        .and_then(|v| v.as_str())
                        .map(|role| match role {
                            "user" => EventState::Init,       // User message → start of turn
                            "assistant" => EventState::Response, // Assistant response → end of turn
                            _ => EventState::Response,         // Default (backward compat)
                        })
                        .unwrap_or(EventState::Response);

                    return self.transform_with_event_type(
                        raw,
                        EventType::Chat,
                        state,
                        "chat.message",
                        session_id,
                    )
                }
                // Message update/delta events: extract properties for cleaner payload
                "message.updated"
                | "message.part.updated"
                | "message.part.delta"
                | "message.removed"
                | "message.part.removed" => {
                    // DIAGNOSTIC (FIX-586 V3): Detect if Deepseek emits message.part.updated
                    // at the END of the stream with COMPLETE text alongside delta events.
                    let has_delta = raw
                        .get("properties")
                        .and_then(|v| v.get("delta"))
                        .and_then(|v| v.as_str())
                        .map(|s| !s.is_empty())
                        .unwrap_or(false);
                    let has_part_text = raw
                        .get("properties")
                        .and_then(|v| v.get("part"))
                        .and_then(|v| v.get("text"))
                        .and_then(|v| v.as_str())
                        .map(|s| !s.is_empty())
                        .unwrap_or(false);
                    tracing::info!(
                        target: "fredo::adapter",
                        event_type,
                        session_id,
                        has_delta,
                        has_part_text,
                        "message event — delta vs part.text presence"
                    );

                    let inner = raw.get("properties").unwrap_or(&raw);
                    return self.transform_with_event_type(
                        inner.clone(),
                        EventType::Chat,
                        EventState::Update,
                        event_type,
                        session_id,
                    );
                }

                // --- Session lifecycle events ---
                "SessionStart" => {
                    return self.transform_with_event_type(
                        raw,
                        EventType::AgentSession,
                        EventState::Init,
                        "SessionStart",
                        session_id,
                    )
                }
                "SessionEnd" => {
                    return self.transform_with_event_type(
                        raw,
                        EventType::AgentSession,
                        EventState::Response,
                        "SessionEnd",
                        session_id,
                    )
                }
                "session.created" => {
                    return self.transform_with_event_type(
                        raw,
                        EventType::AgentSession,
                        EventState::Init,
                        "session.created",
                        session_id,
                    )
                }
                "session.updated" => {
                    // REQ-1 / REQ-5: Check if this session.updated carries actual agent
                    // output (properties.output is present and not null). If so, emit
                    // EventState::Response to trigger ECE completeWhen. If no output,
                    // emit EventState::Update for intermediate updates (e.g., during
                    // agent thinking phase) — backward compatible.
                    let has_output = raw
                        .get("properties")
                        .and_then(|v| v.get("output"))
                        .map_or(false, |v| !v.is_null());
                    let session_state = if has_output {
                        EventState::Response
                    } else {
                        EventState::Update
                    };

                    // Spec #523: Detect @-subagent child sessions via session.updated
                    // events that carry properties.info.parentID. Emit relationship
                    // metadata so the ECE can handle parent-child compositing generically.
                    // Extract parent-child relationship data BEFORE transform consumes raw.
                    // Real opencode events carry parentID here; PostToolUse task events
                    // do NOT carry the expected metadata fields (confirmed via telemetry).
                    let relationship_meta = raw
                        .get("properties")
                        .and_then(|v| v.get("info"))
                        .and_then(|info| {
                            let parent_id = info.get("parentID").and_then(|v| v.as_str())?;
                            let agent_name = info.get("agent").and_then(|v| v.as_str());
                            let is_whitelisted = agent_name
                                .map(|name| WHITELIST_SUBAGENT_NAMES.contains(&name))
                                .unwrap_or(false);
                            if is_whitelisted && !parent_id.is_empty() && parent_id != session_id
                            {
                                Some(json!({
                                    "relationship": {
                                        "type": "parent-child",
                                        "parentSessionId": parent_id,
                                        "childSessionId": session_id
                                    }
                                }))
                            } else {
                                None
                            }
                        });

                    let raw_for_subagent = raw.clone();
                    let mut events = self.transform_with_event_type(
                        raw,
                        EventType::AgentSession,
                        session_state,
                        "session.updated",
                        session_id,
                    )?;

                    if let (Some(meta), Some(event)) = (relationship_meta, events.first_mut()) {
                        // Extract parent_id before moving meta into metadata
                        let parent_id = meta
                            .get("relationship")
                            .and_then(|v| v.get("parentSessionId"))
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string());

                        // Spec #615: Store child→parent mapping so OTLP adapter
                        // can emit relationship metadata for subagent session spans.
                        // Unlike trace_id (which differs per session in OTLP),
                        // session_id is the canonical cross-transport identifier.
                        if let Some(ref pid) = parent_id {
                            let child_sid = session_id.to_string();
                            if let Ok(mut map) = self.session_to_parent.lock() {
                                // Cap at 10K entries — evict oldest if at capacity
                                if map.len() >= 10_000 && !map.contains_key(&child_sid) {
                                    if let Some(key) = map.keys().next().cloned() {
                                        map.remove(&key);
                                    }
                                }
                                map.insert(child_sid, pid.clone());
                            }
                        }

                        event.metadata = Some(meta);

                        // REQ-4: Also merge subagent-specific normalized fields
                        // (name, instruction, output, parentCorrelationId)
                        if let Some(pid) = parent_id {
                            let cid = event.correlation_id.clone().unwrap_or_default();
                            let subagent_payload = self.normalize_subagent_payload(
                                &raw_for_subagent,
                                session_id,
                                &cid,
                                &pid,
                            );
                            if let (Some(obj), Some(sub_obj)) = (
                                event.payload.as_mut().and_then(|p| p.as_object_mut()),
                                subagent_payload.as_object(),
                            ) {
                                for (k, v) in sub_obj {
                                    obj.entry(k.clone()).or_insert_with(|| v.clone());
                                }
                            }
                        }
                    }

                    return Ok(events);
                }
                "session.deleted" => {
                    return self.transform_with_event_type(
                        raw,
                        EventType::AgentSession,
                        EventState::Response,
                        "session.deleted",
                        session_id,
                    )
                }
                "session.status" => {
                    return self.transform_with_event_type(
                        raw,
                        EventType::AgentSession,
                        EventState::Update,
                        "session.status",
                        session_id,
                    )
                }
                "session.error" => {
                    return self.transform_with_event_type(
                        raw,
                        EventType::AgentSession,
                        EventState::Error,
                        "session.error",
                        session_id,
                    )
                }
                "session.idle" => {
                    return self.transform_with_event_type(
                        raw,
                        EventType::AgentSession,
                        EventState::Update,
                        "session.idle",
                        session_id,
                    )
                }

                // --- Session next-turn events ---
                "session.next.tool.called" => {
                    return self.transform_with_event_type(
                        raw,
                        EventType::ToolUse,
                        EventState::Init,
                        "session.next.tool.called",
                        session_id,
                    )
                }
                "session.next.tool.success" => {
                    return self.transform_with_event_type(
                        raw,
                        EventType::ToolUse,
                        EventState::Response,
                        "session.next.tool.success",
                        session_id,
                    )
                }
                "session.next.tool.failed" => {
                    return self.transform_with_event_type(
                        raw,
                        EventType::ToolUse,
                        EventState::Error,
                        "session.next.tool.failed",
                        session_id,
                    )
                }
                "session.next.text.delta" => {
                    return self.transform_with_event_type(
                        raw,
                        EventType::Chat,
                        EventState::Update,
                        "session.next.text.delta",
                        session_id,
                    )
                }
                "session.next.text.started" => {
                    return self.transform_with_event_type(
                        raw,
                        EventType::Chat,
                        EventState::Init,
                        "session.next.text.started",
                        session_id,
                    )
                }
                "session.next.text.ended" => {
                    return self.transform_with_event_type(
                        raw,
                        EventType::Chat,
                        EventState::Response,
                        "session.next.text.ended",
                        session_id,
                    )
                }
                "session.next.step.started" => {
                    return self.transform_with_event_type(
                        raw,
                        EventType::AgentSession,
                        EventState::Init,
                        "session.next.step.started",
                        session_id,
                    )
                }
                "session.next.step.ended" => {
                    return self.transform_with_event_type(
                        raw,
                        EventType::AgentSession,
                        EventState::Response,
                        "session.next.step.ended",
                        session_id,
                    )
                }
                "session.next.agent.switched" => {
                    return self.transform_with_event_type(
                        raw,
                        EventType::AgentSession,
                        EventState::Update,
                        "session.next.agent.switched",
                        session_id,
                    )
                }

                // --- Compaction event (Spec #555) ---
                "experimental.compaction.autocontinue" => {
                    return self.transform_compaction_event(raw, session_id);
                }

                _ => {
                    // REQ-1: Unrecognized event types produce EventType::Custom
                    // with a tracing::warn! log — never silently dropped.
                    let et = event_type.to_string();
                    tracing::warn!(
                        target: "fredo::adapter",
                        unrecognized_event_type = %et,
                        session_id = %session_id,
                        "Unrecognized hook event type — emitting as EventType::Custom"
                    );

                    return self.transform_with_event_type(
                        raw,
                        EventType::Custom,
                        EventState::Init,
                        &et,
                        session_id,
                    );
                }
            }
        }

        // Detect by field presence
        if raw.get("tool_input").is_some() {
            // PreToolUse
            return self.transform_pre_tool_use(raw, session_id);
        }
        if raw.get("error").is_some() {
            // PostToolUseFailure
            return self.transform_post_tool_use_failure(raw, session_id);
        }
        if raw.get("tool_response").is_some() {
            // PostToolUse
            return self.transform_post_tool_use(raw, session_id);
        }

        // Check for lifecycle events (has session_id)
        let raw_clone = raw.clone();
        if let Some(sid) = raw_clone.get("session_id").and_then(|v| v.as_str()) {
            return self.transform_lifecycle_event(raw, sid);
        }

        // REQ-1: Unknown event type with no explicit event_type field —
        // emit as EventType::Custom with tracing::warn!
        tracing::warn!(
            target: "fredo::adapter",
            session_id = %session_id,
            "Hook event with no recognized event_type field — emitting as EventType::Custom"
        );

        return self.transform_with_event_type(
            raw,
            EventType::Custom,
            EventState::Init,
            "unknown",
            session_id,
        );
    }

    /// Transform PreToolUse hook event.
    fn transform_pre_tool_use(
        &self,
        raw: Value,
        session_id: &str,
    ) -> anyhow::Result<Vec<FredoEvent>> {
        let tool_name = raw
            .get("tool_name")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let _tool_input = raw.get("tool_input").cloned();

        // REQ-3 (Spec #382): CorrelationId from callID (tool_input.callID) since
        // tool_use_id is always empty in opencode hook events. callID is consistent
        // across PreToolUse and PostToolUse for the same tool invocation.
        // Store the callID in tool_call_id map keyed by (session_id, tool_name)
        // so PostToolUse can look it up (it lacks callID).
        let call_id = raw
            .get("tool_input")
            .and_then(|v| v.get("callID"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let tool_name_str = tool_name.as_deref().unwrap_or("unknown");
        let correlation_id = match &call_id {
            Some(cid) => {
                // Store for PostToolUse lookup
                if let Ok(mut map) = self.tool_call_id.lock() {
                    // REQ-10: Cap at 10K entries — evict oldest if at capacity
                    let key = (session_id.to_string(), tool_name_str.to_string());
                    if map.len() >= 10_000 && !map.contains_key(&key) {
                        if let Some(k) = map.keys().next().cloned() {
                            map.remove(&k);
                        }
                    }
                    map.entry(key).or_insert_with(|| cid.clone());
                }
                cid.clone()
            }
            None => {
                // Fallback: try tool_use_id (typically empty), then UUID
                raw.get("tool_use_id")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| Uuid::new_v4().to_string())
            }
        };

        let mut event = FredoEvent::builder()
            .event_type(EventType::ToolUse)
            .state(EventState::Init)
            .provider(EventProvider::OpenCode)
            .transport(Transport::Hook)
            .session_id(session_id)
            .tool_name(tool_name.unwrap_or_default())
            .correlation_id(correlation_id.clone())
            .build();

        // Apply normalized payload (backward compatible — merges into raw)
        event.payload = Some(self.normalize_tool_payload(&raw, session_id, &correlation_id));

        Ok(vec![event])
    }

    /// Transform PostToolUse hook event.
    fn transform_post_tool_use(
        &self,
        raw: Value,
        session_id: &str,
    ) -> anyhow::Result<Vec<FredoEvent>> {
        let tool_name = raw
            .get("tool_name")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let _tool_response = raw.get("tool_response").cloned();

        // Spec #523: Instead of populating child_to_parent map (which is removed),
        // attach relationship metadata so the ECE can handle compositing generically.
        // Note: Real opencode does NOT emit PostToolUse "task" tool events
        // for @-subagent dispatches. The primary detection path is
        // session.updated with properties.info.parentID (see above).
        let relationship_metadata = if tool_name.as_deref() == Some("task") {
            if let Some(metadata) = raw.get("tool_response").and_then(|v| v.get("metadata")) {
                let child_sid = metadata
                    .get("sessionId")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty());
                let parent_sid = metadata
                    .get("parentSessionId")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .or(Some(session_id));
                if let (Some(child), Some(parent)) = (child_sid, parent_sid) {
                    if child != parent {
                        Some(json!({
                            "relationship": {
                                "type": "parent-child",
                                "parentSessionId": parent,
                                "childSessionId": child
                            }
                        }))
                    } else {
                        None
                    }
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            None
        };

        // Spec #615: Store child→parent mapping in session_to_parent so the
        // OTLP adapter can also detect subagent sessions. The OTLP plugin uses
        // a different trace_id per session, so cross-referencing via trace_id
        // fails — but session_id is the same across both transports.
        if let Some(ref rel_meta) = relationship_metadata {
            let child = rel_meta
                .get("relationship")
                .and_then(|v| v.get("childSessionId"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let parent = rel_meta
                .get("relationship")
                .and_then(|v| v.get("parentSessionId"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            if let (Some(child_sid), Some(parent_sid)) = (child, parent) {
                if let Ok(mut map) = self.session_to_parent.lock() {
                    // Cap at 10K entries — evict oldest if at capacity
                    if map.len() >= 10_000 && !map.contains_key(&child_sid) {
                        if let Some(key) = map.keys().next().cloned() {
                            map.remove(&key);
                        }
                    }
                    map.insert(child_sid, parent_sid);
                }
            }
        }

        // REQ-3 (Spec #382): CorrelationId — look up callID from the
        // tool_call_id map (stored by transform_pre_tool_use). PostToolUse
        // events lack callID, so we retrieve it using (session_id, tool_name).
        let tool_name_str = tool_name.as_deref().unwrap_or("unknown");
        let correlation_id = self
            .tool_call_id
            .lock()
            .ok()
            .and_then(|map| map.get(&(session_id.to_string(), tool_name_str.to_string())).cloned())
            .or_else(|| {
                // Fallback: try tool_use_id (typically empty), then UUID
                raw.get("tool_use_id")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string())
            })
            .unwrap_or_else(|| Uuid::new_v4().to_string());

        let mut event = FredoEvent::builder()
            .event_type(EventType::ToolUse)
            .state(EventState::Response)
            .provider(EventProvider::OpenCode)
            .transport(Transport::Hook)
            .session_id(session_id)
            .tool_name(tool_name.unwrap_or_default())
            .correlation_id(correlation_id.clone())
            .build();

        // Apply normalized tool payload (backward compatible — merges into raw)
        let mut payload = self.normalize_tool_payload(&raw, session_id, &correlation_id);

        // Spec #523: If this is a PostToolUse `task` with relationship metadata,
        // also merge subagent-specific normalized fields (name, instruction, output, parentCorrelationId).
        if let Some(rel_meta) = &relationship_metadata {
            if let Some(parent_sid) = rel_meta
                .get("relationship")
                .and_then(|v| v.get("parentSessionId"))
                .and_then(|v| v.as_str())
            {
                let subagent_payload = self.normalize_subagent_payload(
                    &raw, session_id, &correlation_id, parent_sid,
                );
                // Merge subagent fields (existing normalized fields take precedence)
                if let (Some(obj), Some(sub_obj)) =
                    (payload.as_object_mut(), subagent_payload.as_object())
                {
                    for (k, v) in sub_obj {
                        obj.entry(k.clone()).or_insert_with(|| v.clone());
                    }
                }
            }

            event.metadata = Some(rel_meta.clone());
        }

        event.payload = Some(payload);

        Ok(vec![event])
    }

    /// Transform PostToolUseFailure hook event.
    fn transform_post_tool_use_failure(
        &self,
        raw: Value,
        session_id: &str,
    ) -> anyhow::Result<Vec<FredoEvent>> {
        let tool_name = raw
            .get("tool_name")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let error_msg = raw
            .get("error")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| "Unknown error".to_string());

        // REQ-3 (Spec #382): CorrelationId — look up callID from the
        // tool_call_id map (stored by transform_pre_tool_use).
        let tool_name_str = tool_name.as_deref().unwrap_or("unknown");
        let correlation_id = self
            .tool_call_id
            .lock()
            .ok()
            .and_then(|map| map.get(&(session_id.to_string(), tool_name_str.to_string())).cloned())
            .or_else(|| {
                raw.get("tool_use_id")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string())
            })
            .unwrap_or_else(|| Uuid::new_v4().to_string());

        let mut event = FredoEvent::builder()
            .event_type(EventType::ToolUse)
            .state(EventState::Error)
            .provider(EventProvider::OpenCode)
            .transport(Transport::Hook)
            .session_id(session_id)
            .tool_name(tool_name.unwrap_or_default())
            .correlation_id(correlation_id.clone())
            .error(crate::infrastructure::comm::event::FredoEventError {
                message: error_msg,
                code: None,
                details: None,
            })
            .build();

        // Apply normalized tool payload (backward compatible — merges into raw)
        event.payload = Some(self.normalize_tool_payload(&raw, session_id, &correlation_id));

        Ok(vec![event])
    }

    /// Generic helper for events that map 1:1 to a single FredoEvent.
    ///
    /// REQ-1 / AC-R1, AC-R2, AC-R7: For Chat events, extracts `messageID` from the
    /// raw payload (checking multiple structural paths) and sets it as `correlationId`.
    /// Falls back to a UUID v4 if no `messageID` is found at any path.
    ///
    /// Spec #523: No more sessionId rewriting — correlation keys always use the
    /// event's real session_id. The ECE handles compositing via relationship metadata.
    fn transform_with_event_type(
        &self,
        raw: Value,
        event_type: EventType,
        state: EventState,
        tool_name: &str,
        session_id: &str,
    ) -> anyhow::Result<Vec<FredoEvent>> {
        let mut builder = FredoEvent::builder()
            .event_type(event_type)
            .state(state)
            .provider(EventProvider::OpenCode)
            .transport(Transport::Hook)
            .session_id(session_id)
            .tool_name(tool_name);

        // REQ-3: Derive correlationId for Chat events, unifying ALL events
        // from the same session under a single correlationId to prevent ECE
        // buffer fragmentation (multiple nodes per logical turn).
        //
        // Strategy (map-first):
        // 1. If the session_to_correlation map already has a stored correlationId
        //    for this session, use it unconditionally. This ensures that message.*
        //    events, session.next.text.* events, and UserPromptSubmit all share
        //    one correlationId, producing exactly ONE ECE buffer / ONE node.
        // 2. If no stored entry exists, compute a correlationId from the event's
        //    own messageID paths. If none found, generate a UUID. Then STORE the
        //    result in the map so all subsequent Chat events reuse it.
        // 3. Use entry().or_insert() (first-write-wins) so concurrent events
        //    share the first-computed correlationId.
        //
        // Spec #523: No more sessionId rewriting — the real session_id is always
        // used as the correlation map key. The ECE handles compositing.
        if event_type == EventType::Chat {
            let correlation_key = session_id;

            // Step 1: Check map first — if we already have a stored correlationId
            // for this session, use it unconditionally.
            let stored_cid = self.session_to_correlation.lock().ok()
                .and_then(|map| map.get(correlation_key).cloned());

            let correlation_id = match stored_cid {
                Some(cid) => cid,
                None => {
                    // Step 2: No stored entry — compute from messageID paths or UUID
                    let mid = raw
                        .get("messageID")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                        .or_else(|| {
                            raw.get("part")
                                .and_then(|v| v.get("messageID"))
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string())
                        })
                        .or_else(|| {
                            raw.get("properties")
                                .and_then(|v| v.get("messageID"))
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string())
                        })
                        .or_else(|| {
                            raw.get("properties")
                                .and_then(|v| v.get("part"))
                                .and_then(|v| v.get("messageID"))
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string())
                        })
                        .or_else(|| {
                            // Double-check map (race condition guard)
                            if let Ok(map) = self.session_to_correlation.lock() {
                                map.get(correlation_key).cloned()
                            } else {
                                None
                            }
                        })
                        .unwrap_or_else(|| Uuid::new_v4().to_string());

                    // Store the computed correlationId (always — even for UUID
                    // fallbacks) so subsequent events reuse it. First-write-wins
                    // prevents races.
                    if let Ok(mut map) = self.session_to_correlation.lock() {
                        // REQ-10: Cap at 10K entries — evict oldest if at capacity
                        if map.len() >= 10_000 && !map.contains_key(correlation_key) {
                            if let Some(key) = map.keys().next().cloned() {
                                map.remove(&key);
                            }
                        }
                        map.entry(correlation_key.to_string()).or_insert_with(|| mid.clone());
                    }

                    // Initialize turn counter so that subsequent OTLP events
                    // for this session generate per-turn correlationIds instead
                    // of reusing the single Hook-bridged correlationId.
                    // Without this, all OTLP chat events reuse the same
                    // correlationId → one ECE buffer → one ChatNode.
                    if let Ok(mut tm) = self.session_turn_counter.lock() {
                        if tm.len() >= 10_000 && !tm.contains_key(correlation_key) {
                            if let Some(key) = tm.keys().next().cloned() {
                                tm.remove(&key);
                            }
                        }
                        tm.entry(correlation_key.to_string()).or_insert(0);
                    }

                    mid
                }
            };

            builder = builder.correlation_id(correlation_id);
        }

        // REQ-3b (Spec #382 bug fix): For AgentSession events (session.created,
        // session.updated, etc.), derive correlationId from the session_id.
        // Real opencode events of this type have no messageID/tool_use_id,
        // causing correlationId=None and ECE key resolution failure.
        // Using session_id ensures at least the ECE creates a buffer.
        //
        // Also STORE this in session_to_correlation so subsequent Chat events
        // for the SAME session share the same correlationId (one ECE buffer
        // per session). Without this, chat.message would use its messageID,
        // creating a DIFFERENT buffer and splitting the session's lifecycle.
        //
        // Spec #523: No more sessionId rewriting — the real session_id is used
        // as the correlation key. The ECE handles compositing.
        if event_type == EventType::AgentSession {
            let correlation_key = session_id;

            // Step 1: Check map first — if we already have a stored correlationId
            // for this session (from a prior Chat event), use it unconditionally.
            let stored_cid = self.session_to_correlation.lock().ok()
                .and_then(|map| map.get(correlation_key).cloned());

            let correlation_id = match stored_cid {
                Some(cid) => cid,
                None => {
                    // Step 2: No stored entry — derive from session_id, then STORE it
                    let cid = session_id.to_string();
                    if let Ok(mut map) = self.session_to_correlation.lock() {
                        // REQ-10: Cap at 10K entries — evict oldest if at capacity
                        if map.len() >= 10_000 && !map.contains_key(session_id) {
                            if let Some(key) = map.keys().next().cloned() {
                                map.remove(&key);
                            }
                        }
                        map.entry(session_id.to_string()).or_insert_with(|| cid.clone());
                    }
                    cid
                }
            };

            builder = builder.correlation_id(correlation_id);
        }

        // REQ-3: For ToolUse events (session.next.tool.*), derive correlationId
        // from tool_use_id at multiple paths or UUID if absent.
        // Do NOT fall back to session→correlation map — tool events must
        // use their OWN correlationId to create separate ECE buffers from
        // chat-node events, allowing subagent/tool-lifecycle contracts to
        // fire independently (AC-4, AC-7).
        if event_type == EventType::ToolUse {
            let tool_cid = raw
                .get("tool_use_id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .or_else(|| {
                    raw.get("properties")
                        .and_then(|v| v.get("tool_use_id"))
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                })
                .unwrap_or_else(|| Uuid::new_v4().to_string());
            builder = builder.correlation_id(tool_cid);
        }

        let mut event = builder.build();

        // Extract correlationId that was set on the event for normalization
        let cid = event.correlation_id.clone().unwrap_or_else(|| session_id.to_string());

        // Apply normalized payload based on event type (backward compatible —
        // normalized fields are merged alongside the raw event structure).
        event.payload = Some(match event_type {
            EventType::Chat | EventType::AgentSession => {
                self.normalize_agent_payload(&raw, session_id, &cid)
            }
            EventType::ToolUse => {
                self.normalize_tool_payload(&raw, session_id, &cid)
            }
            EventType::Custom => {
                Self::normalize_custom_payload(&raw, tool_name)
            }
            // Infrastructure and Ui events pass through raw unchanged
            EventType::Infrastructure | EventType::Ui => raw.clone(),
        });

        Ok(vec![event])
    }

    /// Transform a compaction event (experimental.compaction.autocontinue) into
    /// a FredoEvent with EventType::AgentSession, state=Response, and payload
    /// containing compacted: true.
    ///
    /// REQ-5/6/7 (Spec #555): The compacted session's sessionId is resolved from
    /// the hook input payload. Its correlationId is looked up from the adapter's
    /// session_to_correlation map. Falls back to UUID if no mapping exists.
    fn transform_compaction_event(
        &self,
        raw: Value,
        session_id: &str,
    ) -> anyhow::Result<Vec<FredoEvent>> {
        // Look up correlationId from session_to_correlation map
        let correlation_id = self
            .session_to_correlation
            .lock()
            .ok()
            .and_then(|map| map.get(session_id).cloned())
            .unwrap_or_else(|| Uuid::new_v4().to_string());

        // Build payload with compacted: true plus original hook input fields
        let mut payload = raw.clone();
        if let Some(obj) = payload.as_object_mut() {
            obj.insert("compacted".to_string(), Value::Bool(true));
            obj.insert(
                "sessionId".to_string(),
                Value::String(session_id.to_string()),
            );
        }

        let event = FredoEvent::builder()
            .event_type(EventType::AgentSession)
            .state(EventState::Response)
            .provider(EventProvider::OpenCode)
            .transport(Transport::Hook)
            .session_id(session_id)
            .tool_name("experimental.compaction.autocontinue")
            .correlation_id(correlation_id)
            .payload(payload)
            .build();

        Ok(vec![event])
    }

    /// Transform lifecycle event (SessionStart, SessionEnd, etc.) into AgentSession/Init.
    fn transform_lifecycle_event(
        &self,
        raw: Value,
        session_id: &str,
    ) -> anyhow::Result<Vec<FredoEvent>> {
        // Extract any inner payload if present
        let payload = raw.get("payload").cloned();

        let mut event = FredoEvent::builder()
            .event_type(EventType::AgentSession)
            .state(EventState::Init)
            .provider(EventProvider::OpenCode)
            .transport(Transport::Hook)
            .session_id(session_id.to_string())
            .build();

        if let Some(p) = payload {
            event.payload = Some(p);
        }

        Ok(vec![event])
    }

    /// Convert OTLP attribute array to flat JSON object.
    fn otlp_attrs_to_map(attrs_json: Option<&Value>) -> Map<String, Value> {
        let mut map = Map::new();
        let arr = match attrs_json.and_then(|v| v.as_array()) {
            Some(a) => a,
            None => return map,
        };
        for kv in arr {
            let key = match kv.get("key").and_then(|v| v.as_str()) {
                Some(k) => k.to_string(),
                None => continue,
            };
            let value = if let Some(v) = kv.get("value") {
                if let Some(s) = v.get("stringValue").and_then(|x| x.as_str()) {
                    Value::String(s.to_string())
                } else if let Some(i) = v.get("intValue") {
                    if let Some(n) = i.as_i64() {
                        json!(n)
                    } else if let Some(s) = i.as_str() {
                        if let Ok(n) = s.parse::<i64>() {
                            json!(n)
                        } else {
                            Value::String(s.to_string())
                        }
                    } else {
                        i.clone()
                    }
                } else if let Some(d) = v.get("doubleValue") {
                    d.clone()
                } else if let Some(b) = v.get("boolValue") {
                    b.clone()
                } else {
                    v.clone()
                }
            } else {
                Value::Null
            };
            map.insert(key, value);
        }
        map
    }

    /// Resolve canonical operation name from span name or gen_ai.operation.name attribute.
    ///
    /// Handles:
    /// - Legacy patterns: chat, invoke_agent, execute_tool, permission, elicitation
    /// - Fredo patterns: fredo.session → "session", fredo.llm → "chat",
    ///   fredo.tool.<name> → "tool.<name>"
    /// - Falls back to checking span.type attribute if `attrs` is provided.
    fn normalize_op_name(name: &str) -> Option<String> {
        // Legacy exact-match patterns (preserved for backward compatibility)
        for op in &["chat", "invoke_agent", "execute_tool", "permission", "elicitation"] {
            if name == *op || name.starts_with(&format!("{} ", op)) {
                return Some(op.to_string());
            }
        }

        // Fredo OTLP span name patterns (REQ-10)
        if name == CC_SPAN_SESSION_PREFIX || name.starts_with("fredo.session ") {
            return Some(CC_OP_SESSION.to_string());
        }
        if name == CC_SPAN_LLM_PREFIX || name.starts_with("fredo.llm ") {
            return Some(CC_OP_CHAT.to_string());
        }
        if let Some(suffix) = name.strip_prefix(CC_SPAN_TOOL_PREFIX) {
            // fredo.tool.<name> → "tool.<name>"
            return Some(format!("{}{}", CC_OP_TOOL_PREFIX, suffix));
        }

        None
    }

    /// Resolve canonical op name with span.type attribute fallback.
    /// Checks fredo.* span names, legacy exact matches, and span.type attribute.
    fn normalize_op_name_with_fallback(name: &str, attrs: &Map<String, Value>) -> Option<String> {
        // First try the span name
        if let Some(op) = Self::normalize_op_name(name) {
            return Some(op);
        }

        // Fallback: check span.type attribute (REQ-10)
        if let Some(span_type) = attrs.get(CC_ATTR_SPAN_TYPE).and_then(|v| v.as_str()) {
            if let Some(op) = Self::normalize_op_name(span_type) {
                return Some(op);
            }
        }

        None
    }

    /// Map OTLP flat attributes to the nested payload structure expected by the frontend.
    ///
    /// REQ-2 / AC-2: Maps legacy OTLP attribute keys:
    /// - `gen_ai.usage.input_tokens` → `info.turnInputTokens`
    /// - `gen_ai.usage.output_tokens` → `info.turnOutputTokens`
    /// - `gen_ai.response.body` → `part.text` (agent reply)
    /// - `gen_ai.request.body` or `gen_ai.prompt` → `info.text` (user message)
    /// - `gen_ai.response.model` → `info.modelID`
    ///
    /// REQ-12: Maps Claude Code convention attribute keys:
    /// - `input_tokens` → `info.turnInputTokens`
    /// - `output_tokens` → `info.turnOutputTokens`
    /// - `model` → `info.modelID`
    /// - `tool_name`, `duration_ms`, `success` preserved as-is in flat payload
    ///
    /// Flat OTLP attributes are preserved at the top level for backward compatibility.
    fn otlp_attrs_to_payload(attrs: Map<String, Value>) -> Value {
        let mut payload = attrs.clone();

        // ——— Extract mapped values from flat OTLP attributes ———
        // Legacy gen_ai.* convention
        let turn_input_tokens = attrs
            .get(CC_LEGACY_ATTR_INPUT_TOKENS)
            .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse::<i64>().ok())));
        // REQ-12: Claude Code convention (input_tokens)
        let turn_input_tokens_cc = attrs
            .get(CC_ATTR_INPUT_TOKENS)
            .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse::<i64>().ok())));

        let turn_output_tokens = attrs
            .get(CC_LEGACY_ATTR_OUTPUT_TOKENS)
            .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse::<i64>().ok())));
        // REQ-12: Claude Code convention (output_tokens)
        let turn_output_tokens_cc = attrs
            .get(CC_ATTR_OUTPUT_TOKENS)
            .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse::<i64>().ok())));

        let response_body = attrs
            .get("gen_ai.response.body")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let request_body = attrs
            .get("gen_ai.request.body")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let prompt = attrs
            .get("gen_ai.prompt")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        // REQ-609 (REQ-2): Real OTLP plugin sends top-level attribute keys
        let prompt_flat = attrs
            .get("prompt")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let response_text_flat = attrs
            .get("response_text")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        // Legacy model (gen_ai.response.model) and REQ-12: Claude Code convention (model)
        let model = attrs
            .get(CC_LEGACY_ATTR_RESPONSE_MODEL)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let model_cc = attrs
            .get(CC_ATTR_MODEL)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        // ——— Build info object (user message, model, token counts) ———
        let mut info = Map::new();
        // User message text: prefer gen_ai.request.body, fall back to gen_ai.prompt, then prompt (flat)
        let user_text = request_body.or(prompt).or(prompt_flat);
        // REQ-609 (REQ-2): Save userMessage for canonical field injection
        let canonical_user_message = user_text.clone();
        if let Some(text) = user_text {
            info.insert("text".to_string(), Value::String(text));
        }

        // Model: prefer Claude Code convention (model), fall back to gen_ai.response.model
        let model_value = model_cc.or(model);
        // REQ-609 (REQ-2): Save model for canonical field injection
        let canonical_model = model_value.clone();
        if let Some(model_id) = model_value {
            info.insert("modelID".to_string(), Value::String(model_id));
        }

        // Token counts: prefer gen_ai.usage.* (REQ-7), fall back to flat keys (CC convention)
        let prompt_tokens_value = turn_input_tokens.or(turn_input_tokens_cc);
        let completion_tokens_value = turn_output_tokens.or(turn_output_tokens_cc);
        if let Some(tokens) = prompt_tokens_value {
            info.insert("turnInputTokens".to_string(), json!(tokens));
        }
        if let Some(tokens) = completion_tokens_value {
            info.insert("turnOutputTokens".to_string(), json!(tokens));
        }

        // ——— Build part object (agent reply text, reasoning) ———
        let mut part = Map::new();
        // Agent reply text: prefer gen_ai.response.body, fall back to response_text (flat)
        let agent_reply = response_body.or(response_text_flat);
        // REQ-609 (REQ-2): Save agentReply for canonical field injection
        let canonical_agent_reply = agent_reply.clone();
        if let Some(text) = agent_reply {
            part.insert("text".to_string(), Value::String(text));
        }

        // Insert nested objects into payload, preserving flat attrs
        if !info.is_empty() {
            payload.insert("info".to_string(), Value::Object(info));
        }
        if !part.is_empty() {
            payload.insert("part".to_string(), Value::Object(part));
        }

        // REQ-609 (REQ-2): Inject canonical fields at payload top level for frontend
        // compatibility. These match the field names injected by normalize_agent_payload()
        // for Hook events, so the frontend's makeAgentNodePayload() can read them
        // regardless of transport (Hook or OTLP).
        if let Some(user_msg) = canonical_user_message {
            payload.insert("userMessage".to_string(), Value::String(user_msg));
        }
        if let Some(reply) = canonical_agent_reply {
            payload.insert("agentReply".to_string(), Value::String(reply));
        }
        if let Some(tokens) = prompt_tokens_value {
            payload.insert("promptTokens".to_string(), json!(tokens));
        }
        if let Some(tokens) = completion_tokens_value {
            payload.insert("completionTokens".to_string(), json!(tokens));
        }
        if let Some(model_name) = canonical_model {
            payload.insert("model".to_string(), Value::String(model_name));
        }

        // REQ-633 (REQ-2): Inject instruction for subagent spans from prompt attribute.
        // When this is a subagent span, the gen_ai.prompt or flat prompt attribute
        // contains the subagent instruction text (set by the plugin's startMessageSpan).
        // Inject it as "instruction" at the top level of the payload so the frontend
        // can display it in the SubagentNode INPUT section.
        let is_subagent_span = attrs.get("is_subagent")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
            || attrs.get("agent.type")
                .and_then(|v| v.as_str())
                .map(|s| s == "subagent")
                .unwrap_or(false);

        if is_subagent_span {
            // Inject instruction from gen_ai.prompt, flat prompt attribute,
            // or the instruction attribute set directly on the session span.
            // AC-6 (Spec #633): The plugin sets instruction directly on the
            // fredo.session span for subagent sessions so it survives even
            // when the fredo.llm span is never created (non-streaming subagent).
            let instruction = attrs.get("gen_ai.prompt")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .or_else(|| attrs.get("prompt")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()))
                .or_else(|| attrs.get("instruction")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()))
                .filter(|s| !s.is_empty());
            if let Some(ref instr) = instruction {
                payload.insert("instruction".to_string(), Value::String(instr.clone()));
            }
        }

        // REQ-633 (REQ-2): Preserve is_subagent and agent.type from OTLP span
        // attributes in the delivery payload for frontend subagent detection
        // (isOtlpSubagent detection path in useMissionMonitor.ts).
        if let Some(b) = attrs.get("is_subagent").and_then(|v| v.as_bool()) {
            payload.insert("is_subagent".to_string(), Value::Bool(b));
        }
        if let Some(s) = attrs.get("agent.type").and_then(|v| v.as_str()) {
            payload.insert("agent.type".to_string(), Value::String(s.to_string()));
        }

        Value::Object(payload)
    }

    /// Determine EventState from OTLP span timing.
    ///
    /// REQ-11: Returns EventState::Response if span has endTimeUnixNano set,
    /// EventState::Init otherwise. Accepts both Value (serde_json) and
    /// Map<String, Value> by checking the object field directly.
    fn req_11_event_state_from_span(span: &Value) -> EventState {
        if span.get("endTimeUnixNano").is_some() {
            EventState::Response
        } else {
            EventState::Init
        }
    }

    // ——— Payload normalization helpers ———

    /// Extract prompt and completion token counts as typed numbers from all known paths.
    /// Checks: properties.info.tokens.{input,output}, properties.info.{turnInputTokens,turnOutputTokens},
    /// info.tokens.{input,output}, info.{turnInputTokens,turnOutputTokens}, top-level {turnInputTokens,turnOutputTokens}.
    /// Returns (prompt_tokens, completion_tokens), defaulting to (0, 0) when absent.
    fn extract_typed_tokens(raw: &Value) -> (i64, i64) {
        let prompt = raw
            // properties.info.tokens.input
            .get("properties").and_then(|v| v.get("info")).and_then(|v| v.get("tokens"))
            .and_then(|v| v.get("input")).and_then(Self::value_as_i64)
            // properties.info.turnInputTokens
            .or_else(|| raw.get("properties").and_then(|v| v.get("info")).and_then(|v| v.get("turnInputTokens")).and_then(Self::value_as_i64))
            // info.tokens.input
            .or_else(|| raw.get("info").and_then(|v| v.get("tokens")).and_then(|v| v.get("input")).and_then(Self::value_as_i64))
            // info.turnInputTokens
            .or_else(|| raw.get("info").and_then(|v| v.get("turnInputTokens")).and_then(Self::value_as_i64))
            // top-level turnInputTokens
            .or_else(|| raw.get("turnInputTokens").and_then(Self::value_as_i64))
            .unwrap_or(0);

        let completion = raw
            // properties.info.tokens.output
            .get("properties").and_then(|v| v.get("info")).and_then(|v| v.get("tokens"))
            .and_then(|v| v.get("output")).and_then(Self::value_as_i64)
            // properties.info.turnOutputTokens
            .or_else(|| raw.get("properties").and_then(|v| v.get("info")).and_then(|v| v.get("turnOutputTokens")).and_then(Self::value_as_i64))
            // info.tokens.output
            .or_else(|| raw.get("info").and_then(|v| v.get("tokens")).and_then(|v| v.get("output")).and_then(Self::value_as_i64))
            // info.turnOutputTokens
            .or_else(|| raw.get("info").and_then(|v| v.get("turnOutputTokens")).and_then(Self::value_as_i64))
            // top-level turnOutputTokens
            .or_else(|| raw.get("turnOutputTokens").and_then(Self::value_as_i64))
            .unwrap_or(0);

        (prompt, completion)
    }

    /// Convert a JSON value to i64, supporting both numeric and string-encoded integers.
    fn value_as_i64(value: &Value) -> Option<i64> {
        value.as_i64().or_else(|| value.as_str().and_then(|s| s.parse::<i64>().ok()))
    }

    /// Extract a string field from a value by following a sequence of keys.
    /// Returns None if any intermediate key is missing or the final value is not a string.
    fn extract_nested_str<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a str> {
        let mut current = value;
        for key in keys {
            current = current.get(*key)?;
        }
        current.as_str()
    }

    /// Find the first part with type="text" (or no type at all — backward compat)
    /// in a parts array. Returns the text content, or None if no suitable part found.
    /// This is necessary because DeepSeek (and other reasoning models) produce
    /// multi-part outputs where parts[0] may be type="thinking" and the actual
    /// response text is in a subsequent part. Using arr.first() blindly picks up
    /// the thinking text, causing the agentReply to contain reasoning instead of
    /// the actual answer (Bug #593).
    fn find_text_part<'a>(parts: &'a [Value]) -> Option<&'a str> {
        // Prefer a part with explicit type="text"
        for part in parts {
            let part_type = part.get("type").and_then(|v| v.as_str());
            if part_type == Some("text") {
                if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
                    return Some(text);
                }
            }
        }
        // Fallback: if no type="text" part exists, accept the first part with text
        // regardless of type (backward compat with models that don't set part type)
        for part in parts {
            if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
                return Some(text);
            }
        }
        None
    }

    /// Extract text from the first text-type part in output.parts array.
    /// Real opencode chat.message events have the structure:
    ///   { "output": { "message": {...}, "parts": [{"text": "...", "type": "text"}] } }
    /// DeepSeek reasoning models may produce parts[0].type="thinking" first —
    /// this function correctly skips thinking parts.
    fn extract_output_parts_text<'a>(raw: &'a Value) -> Option<&'a str> {
        let parts = raw.get("output")
            .and_then(|v| v.get("parts"))
            .and_then(|v| v.as_array())?;
        Self::find_text_part(parts)
    }

    /// Extract text from the first text-type part in properties.output.message.parts array.
    /// Used for session.updated events that carry agent output at:
    ///   { "properties": { "output": { "message": { "parts": [...] } } } }
    /// Also tries properties.output.parts (without message wrapper) as a fallback
    /// for opencode versions that omit the message nesting.
    fn extract_properties_output_parts_text<'a>(raw: &'a Value) -> Option<&'a str> {
        let output = raw.get("properties").and_then(|v| v.get("output"))?;

        // Primary path: properties.output.message.parts[].text (type="text")
        if let Some(text) = output.get("message")
            .and_then(|v| v.get("parts"))
            .and_then(|v| v.as_array())
            .and_then(|parts| Self::find_text_part(parts))
        {
            return Some(text);
        }

        // Fallback: properties.output.parts[].text (without message wrapper)
        output.get("parts")
            .and_then(|v| v.as_array())
            .and_then(|parts| Self::find_text_part(parts))
    }

    /// Extract file operations from tool events.
    /// Checks tool_name (Write, Edit, Read) and extracts file paths from
    /// tool_input.file_path, tool_input.path, tool_response.path.
    /// Returns Vec of {filePath: String, operation: "read" | "write"}.
    fn extract_files(raw: &Value) -> Vec<Value> {
        let tool_name = raw.get("tool_name").and_then(|v| v.as_str()).unwrap_or("");
        let operation = match tool_name {
            "Write" | "Edit" => "write",
            "Read" => "read",
            _ => {
                // Also check for Bash with file outputs
                if raw.get("tool_response").and_then(|v| v.get("path")).is_some() {
                    "write"
                } else {
                    return vec![];
                }
            }
        };

        let mut files = Vec::new();
        let mut seen_paths = std::collections::HashSet::new();

        // Check tool_input.file_path
        if let Some(fp) = raw.get("tool_input")
            .and_then(|v| v.get("file_path"))
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
        {
            if seen_paths.insert(fp.to_string()) {
                files.push(json!({"filePath": fp, "operation": operation}));
            }
        }

        // Check tool_input.path
        if let Some(fp) = raw.get("tool_input")
            .and_then(|v| v.get("path"))
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
        {
            if seen_paths.insert(fp.to_string()) {
                files.push(json!({"filePath": fp, "operation": operation}));
            }
        }

        // Check tool_response.path
        if let Some(fp) = raw.get("tool_response")
            .and_then(|v| v.get("path"))
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
        {
            if seen_paths.insert(fp.to_string()) {
                files.push(json!({"filePath": fp, "operation": operation}));
            }
        }

        files
    }

    /// Resolve a parent session's correlationId from the session_to_correlation map.
    /// Returns None if no mapping exists.
    fn resolve_parent_correlation_id(&self, parent_session_id: &str) -> Option<String> {
        self.session_to_correlation
            .lock()
            .ok()
            .and_then(|map| map.get(parent_session_id).cloned())
    }

    /// Build a normalized agent payload for Chat and AgentSession events.
    /// Merges extracted typed fields (userMessage, agentReply, agentThinking,
    /// promptTokens, completionTokens, agent, model, correlationId, sessionId)
    /// into the raw event structure for backward compatibility.
    fn normalize_agent_payload(
        &self,
        raw: &Value,
        session_id: &str,
        correlation_id: &str,
    ) -> Value {
        let mut payload = raw.clone();

        // DIAGNOSTIC (FIX-586): Log raw event keys for debugging extraction failures
        let raw_keys: Vec<&str> = raw
            .as_object()
            .map(|o| o.keys().map(|k| k.as_str()).collect())
            .unwrap_or_default();
        tracing::info!(
            target: "fredo::adapter",
            session_id,
            raw_keys = ?raw_keys,
            "normalize_agent_payload raw keys"
        );

        // DIAGNOSTIC (FIX-586 V2): Check part.text (agent response in message.part.updated)
        let part_has_text = raw
            .get("part")
            .and_then(|v| v.get("text"))
            .and_then(|v| v.as_str())
            .map(|s| !s.is_empty())
            .unwrap_or(false);
        let part_type = raw
            .get("part")
            .and_then(|v| v.get("type"))
            .and_then(|v| v.as_str());
        tracing::info!(
            target: "fredo::adapter",
            session_id,
            part_type = ?part_type,
            part_has_text = part_has_text,
            "normalize_agent_payload part check"
        );

        let (prompt_tokens, completion_tokens) = Self::extract_typed_tokens(raw);

        // Extract user message from opencode paths
        // First try output.parts[0].text (real opencode chat.message structure)
        // with role guard: only extract for user messages (role != "assistant")
        let user_message = Self::extract_output_parts_text(raw)
            .filter(|_| {
                // Only extract userMessage from output.parts when the role is
                // NOT "assistant" — prevents assistant text leaking into userMessage
                raw.get("output")
                    .and_then(|v| v.get("message"))
                    .and_then(|v| v.get("role"))
                    .and_then(|v| v.as_str())
                    .map(|role| role != "assistant")
                    .unwrap_or(true) // No role or unknown role → allow extraction
            })
            // session.updated — properties.output.message.parts.text (type="text")
            // with role guard: only extract when role is explicitly "user".
            // session.updated events always carry assistant output; extracting
            // assistant text as userMessage corrupts the displayed user prompt
            // (showing "—" instead of the actual prompt, per QA e2e-1038fd26).
            .or_else(|| {
                let output_role = raw.get("properties")
                    .and_then(|v| v.get("output"))
                    .and_then(|v| v.get("message"))
                    .and_then(|v| v.get("role"))
                    .and_then(|v| v.as_str());
                // Only extract userMessage from properties.output when role is
                // explicitly "user". Anything else (assistant, absent, unknown)
                // is not a user message — skip to avoid corrupting userMessage.
                if output_role != Some("user") {
                    return None;
                }
                // Check properties.output.message.parts and properties.output.parts
                raw.get("properties")
                    .and_then(|v| v.get("output"))
                    .and_then(|v| {
                        v.get("message")
                            .and_then(|m| m.get("parts"))
                            .or_else(|| v.get("parts"))
                    })
                    .and_then(|v| v.as_array())
                    .and_then(|parts| Self::find_text_part(parts))
            })
            // UserPromptSubmit: properties.text
            .or_else(|| Self::extract_nested_str(raw, &["properties", "text"]))
            // properties.info.text
            .or_else(|| Self::extract_nested_str(raw, &["properties", "info", "text"]))
            // FIX-586 V2: info.text (message.updated events where properties already extracted)
            .or_else(|| Self::extract_nested_str(raw, &["info", "text"]))
            // REQ-3: Session titles (properties.info.title) are NOT user messages —
            // removed to prevent session.updated from corrupting userMessage with
            // "New session - 2026-..." style titles.
            .unwrap_or("")
            .to_string();

        // Extract agent reply from message/text paths
        // REQ-2 / REQ-4: Check properties.output.message.parts[0].text FIRST —
        // this carries the actual agent response text from session.updated events
        // (higher priority than thinking/reasoning text at properties.part.text).
        //
        // Priority order:
        // 1. properties.output.message.parts[0].text — session.updated with agent output
        // 2. output.parts[0].text — chat.message assistant response (real opencode structure)
        // 3. properties.part.text — thinking/reasoning text (fallback)
        // ... (remaining fallbacks for other event types)
        let agent_reply = Self::extract_properties_output_parts_text(raw)
            // REQ-2 / FIX-593: output.parts[0].text for chat.message assistant events.
            // Real opencode has parts as a sibling of message under output, not nested.
            // Only extract when role is "assistant" to avoid using user's text as response.
            .or_else(|| {
                let role = raw.get("output")
                    .and_then(|v| v.get("message"))
                    .and_then(|v| v.get("role"))
                    .and_then(|v| v.as_str());
                if role == Some("assistant") {
                    Self::extract_output_parts_text(raw)
                } else {
                    None
                }
            })
            .or_else(|| Self::extract_nested_str(raw, &["properties", "part", "text"]))
            .or_else(|| Self::extract_nested_str(raw, &["properties", "text"]))
            .or_else(|| Self::extract_nested_str(raw, &["part", "text"]))
            .or_else(|| {
                // type=text payload
                let t = raw.get("type").and_then(|v| v.as_str());
                if t == Some("text") {
                    raw.get("text").and_then(|v| v.as_str())
                } else {
                    None
                }
            })
            // FIX-586 V3: message.part.delta — streaming delta text from deepseek
            .or_else(|| Self::extract_nested_str(raw, &["delta"]))
            .or_else(|| Self::extract_nested_str(raw, &["text"]))
            .or_else(|| Self::extract_nested_str(raw, &["properties", "info", "text"]))
            .unwrap_or("")
            .to_string();

        // Extract agent thinking/reasoning
        let agent_thinking = Self::extract_nested_str(raw, &["properties", "part", "reasoning"])
            .or_else(|| Self::extract_nested_str(raw, &["part", "reasoning"]))
            .or_else(|| Self::extract_nested_str(raw, &["properties", "info", "reasoning"]))
            .unwrap_or("")
            .to_string();

        // Extract agent name
        let agent = Self::extract_nested_str(raw, &["properties", "info", "agent"])
            .or_else(|| Self::extract_nested_str(raw, &["input", "agent"]))
            .or_else(|| Self::extract_nested_str(raw, &["agent"]))
            .map(|s| s.to_string());

        // Extract model ID
        let model = Self::extract_nested_str(raw, &["properties", "info", "modelID"])
            .or_else(|| Self::extract_nested_str(raw, &["input", "model", "modelID"]))
            .or_else(|| Self::extract_nested_str(raw, &["model"]))
            .or_else(|| Self::extract_nested_str(raw, &["properties", "modelID"]))
            .map(|s| s.to_string());

        // DIAGNOSTIC (FIX-586 V2): Log extracted values before injection
        tracing::info!(
            target: "fredo::adapter",
            session_id,
            user_message = %user_message,
            agent_reply = %agent_reply,
            agent_thinking = %agent_thinking,
            prompt_tokens = prompt_tokens,
            completion_tokens = completion_tokens,
            "normalize_agent_payload extracted values"
        );

        // Add normalized fields into payload (preserving all original fields)
        // Only insert string scalars when non-empty — empty strings overwrite
        // Init-time data during ECE deep-merge, causing missing user prompts,
        // truncated agent responses, etc. (Bug #593: userMessage "" overwrote
        // actual prompt, showing "—" in Mission Monitor).
        if let Some(obj) = payload.as_object_mut() {
            if !user_message.is_empty() {
                obj.insert("userMessage".to_string(), Value::String(user_message));
            }
            if !agent_reply.is_empty() {
                obj.insert("agentReply".to_string(), Value::String(agent_reply));
            }
            if !agent_thinking.is_empty() {
                obj.insert("agentThinking".to_string(), Value::String(agent_thinking));
            }
            obj.insert("promptTokens".to_string(), json!(prompt_tokens));
            obj.insert("completionTokens".to_string(), json!(completion_tokens));
            if let Some(a) = agent {
                obj.insert("agent".to_string(), Value::String(a));
            }
            if let Some(m) = model {
                obj.insert("model".to_string(), Value::String(m));
            }
            obj.insert("correlationId".to_string(), Value::String(correlation_id.to_string()));
            obj.insert("sessionId".to_string(), Value::String(session_id.to_string()));
        }

        payload
    }

    /// Build a normalized tool payload for ToolUse events.
    /// Merges extracted fields (toolName, input, output, parentCorrelationId,
    /// correlationId, sessionId, files[]) into the raw structure.
    fn normalize_tool_payload(
        &self,
        raw: &Value,
        session_id: &str,
        correlation_id: &str,
    ) -> Value {
        let mut payload = raw.clone();

        let tool_name = raw.get("tool_name").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let tool_input = raw.get("tool_input").cloned();
        let tool_output = raw.get("tool_response").cloned();
        let files = Self::extract_files(raw);

        // Derive parentCorrelationId: for events with explicit parent session
        // context (PostToolUse task with metadata.parentSessionId), resolve it.
        let parent_cid = if tool_name == "task" {
            raw.get("tool_response")
                .and_then(|v| v.get("metadata"))
                .and_then(|v| v.get("parentSessionId"))
                .and_then(|v| v.as_str())
                .and_then(|pid| self.resolve_parent_correlation_id(pid))
                .unwrap_or_default()
        } else {
            String::new()
        };

        if let Some(obj) = payload.as_object_mut() {
            obj.insert("toolName".to_string(), Value::String(tool_name));
            obj.insert("input".to_string(), tool_input.unwrap_or(Value::Null));
            obj.insert("output".to_string(), tool_output.unwrap_or(Value::Null));
            obj.insert("parentCorrelationId".to_string(), Value::String(parent_cid));
            obj.insert("correlationId".to_string(), Value::String(correlation_id.to_string()));
            obj.insert("sessionId".to_string(), Value::String(session_id.to_string()));
            if !files.is_empty() {
                obj.insert("files".to_string(), Value::Array(files));
            }
        }

        payload
    }

    /// Build a normalized subagent payload for subagent-related events.
    /// Merges fields (name, instruction, output, parentCorrelationId,
    /// correlationId, sessionId) into the raw structure.
    fn normalize_subagent_payload(
        &self,
        raw: &Value,
        session_id: &str,
        correlation_id: &str,
        parent_session_id: &str,
    ) -> Value {
        let mut payload = raw.clone();

        let name = Self::extract_nested_str(raw, &["properties", "info", "agent"])
            .or_else(|| {
                raw.get("tool_response")
                    .and_then(|v| v.get("metadata"))
                    .and_then(|v| v.get("sessionId"))
                    .and_then(|v| v.as_str())
            })
            .unwrap_or("")
            .to_string();

        let instruction = Self::extract_nested_str(raw, &["tool_input", "task"])
            .or_else(|| Self::extract_nested_str(raw, &["tool_input", "instruction"]))
            .or_else(|| Self::extract_nested_str(raw, &["properties", "info", "instruction"]))
            .unwrap_or("")
            .to_string();

        let output = Self::extract_nested_str(raw, &["tool_response", "result"])
            .or_else(|| Self::extract_nested_str(raw, &["tool_response", "output"]))
            .or_else(|| Self::extract_nested_str(raw, &["state", "output"]))
            .or_else(|| Self::extract_nested_str(raw, &["properties", "info", "output"]))
            .unwrap_or("")
            .to_string();

        let parent_cid = self
            .resolve_parent_correlation_id(parent_session_id)
            .unwrap_or_else(|| parent_session_id.to_string());

        if let Some(obj) = payload.as_object_mut() {
            obj.insert("name".to_string(), Value::String(name));
            obj.insert("instruction".to_string(), Value::String(instruction));
            obj.insert("output".to_string(), Value::String(output));
            obj.insert("parentCorrelationId".to_string(), Value::String(parent_cid));
            obj.insert("correlationId".to_string(), Value::String(correlation_id.to_string()));
            obj.insert("sessionId".to_string(), Value::String(session_id.to_string()));
        }

        payload
    }

    /// Build a normalized custom payload for custom event types.
    /// Adds typed fields depending on the event type:
    /// - file.edited: filePath, operation
    /// - permission.*: toolName, scope, decision
    /// - command.executed: command, exitCode
    fn normalize_custom_payload(raw: &Value, tool_name: &str) -> Value {
        let mut payload = raw.clone();
        if let Some(obj) = payload.as_object_mut() {
            match tool_name {
                "file.edited" => {
                    let file_path = Self::extract_nested_str(raw, &["properties", "path"])
                        .or_else(|| Self::extract_nested_str(raw, &["path"]))
                        .unwrap_or("")
                        .to_string();
                    obj.insert("filePath".to_string(), Value::String(file_path));
                    obj.insert("operation".to_string(), Value::String("edited".to_string()));
                }
                "permission.asked" | "permission.replied" => {
                    let t = Self::extract_nested_str(raw, &["properties", "tool_name"])
                        .or_else(|| Self::extract_nested_str(raw, &["tool_name"]))
                        .unwrap_or("")
                        .to_string();
                    let scope = Self::extract_nested_str(raw, &["properties", "scope"])
                        .or_else(|| Self::extract_nested_str(raw, &["scope"]))
                        .unwrap_or("")
                        .to_string();
                    let decision = if tool_name == "permission.replied" {
                        Self::extract_nested_str(raw, &["properties", "decision"])
                            .or_else(|| Self::extract_nested_str(raw, &["decision"]))
                            .unwrap_or("")
                            .to_string()
                    } else {
                        String::new()
                    };
                    obj.insert("toolName".to_string(), Value::String(t));
                    obj.insert("scope".to_string(), Value::String(scope));
                    obj.insert("decision".to_string(), Value::String(decision));
                }
                "command.executed" => {
                    let cmd = Self::extract_nested_str(raw, &["properties", "command"])
                        .or_else(|| Self::extract_nested_str(raw, &["command"]))
                        .unwrap_or("")
                        .to_string();
                    let exit_code = raw.get("properties")
                        .and_then(|v| v.get("exitCode"))
                        .or_else(|| raw.get("exitCode"))
                        .and_then(Self::value_as_i64);
                    obj.insert("command".to_string(), Value::String(cmd));
                    obj.insert("exitCode".to_string(), exit_code.map(|v| json!(v)).unwrap_or(Value::Null));
                }
                _ => {}
            }
        }
        payload
    }

    /// Transform an OTLP transport payload (gRPC or HTTP) into FredoEvents.
    ///
    /// Handles:
    /// - chat spans → Chat/Response events (REQ-1.1)
    /// - invoke_agent spans → Chat/Response events (REQ-1.2)
    /// - execute_tool spans → ToolUse/Response events
    /// - Stores traceId → conversation.id mappings for session derivation
    fn transform_otlp(&self, raw: Value) -> anyhow::Result<Vec<FredoEvent>> {
        let provider = EventProvider::OpenCode;
        let mut events = Vec::new();

        // Check if this is standard OTLP format with resourceSpans
        if let Some(resource_spans) = raw.get("resourceSpans").and_then(|v| v.as_array()) {
            for rs in resource_spans {
                let res_attrs =
                    Self::otlp_attrs_to_map(rs.get("resource").and_then(|r| r.get("attributes")));
                let scope_spans = rs
                    .get("scopeSpans")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default();
                for scope in &scope_spans {
                    let spans = scope
                        .get("spans")
                        .and_then(|v| v.as_array())
                        .cloned()
                        .unwrap_or_default();

                    for span in &spans {
                        let span_name = span.get("name").and_then(|v| v.as_str()).unwrap_or("span");
                        let span_attrs = Self::otlp_attrs_to_map(span.get("attributes"));

                        // Resolve canonical op name
                        let op_name = span_attrs
                            .get("gen_ai.operation.name")
                            .and_then(|v| v.as_str())
                            .and_then(Self::normalize_op_name)
                            .or_else(|| Self::normalize_op_name_with_fallback(span_name, &span_attrs));

                        let op_name = match op_name {
                            Some(op) => op,
                            None => {
                                // REQ-10: Log dropped spans with tracing::debug!
                                tracing::debug!(
                                    target: "fredo::adapter::otlp",
                                    span_name = %span_name,
                                    "Dropping unrecognised OTLP span"
                                );
                                continue;
                            }
                        };

                        // Resolve session id (REQ-12: prefer session.id, fall back to
                        // gen_ai.conversation.id, then trace_id, then UUID)
                        let trace_id = span
                            .get("traceId")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let session_id = span_attrs
                            .get(CC_ATTR_SESSION_ID)
                            .and_then(|v| v.as_str())
                            .map(str::to_owned)
                            .or_else(|| {
                                span_attrs
                                    .get(CC_LEGACY_ATTR_CONVERSATION_ID)
                                    .and_then(|v| v.as_str())
                                    .map(str::to_owned)
                            })
                            .or_else(|| {
                                self.trace_to_session
                                    .lock()
                                    .ok()
                                    .and_then(|m| m.get(&trace_id).cloned())
                            })
                            .unwrap_or_else(|| {
                                if !trace_id.is_empty() {
                                    trace_id.clone()
                                } else {
                                    Uuid::new_v4().to_string()
                                }
                            });

                        // Store trace-to-session mapping if we have a session.id or conversation.id
                        if let Some(sid) = span_attrs
                            .get(CC_ATTR_SESSION_ID)
                            .and_then(|v| v.as_str())
                            .or_else(|| {
                                span_attrs
                                    .get(CC_LEGACY_ATTR_CONVERSATION_ID)
                                    .and_then(|v| v.as_str())
                            })
                        {
                            if let Ok(mut map) = self.trace_to_session.lock() {
                                // Cap at 10K entries — evict oldest if at capacity
                                if map.len() >= 10_000 {
                                    if let Some(key) = map.keys().next().cloned() {
                                        map.remove(&key);
                                    }
                                }
                                map.insert(trace_id.clone(), sid.to_string());
                            }
                        }

                        // Merge resource attrs + span attrs
                        let mut merged = res_attrs.clone();
                        merged.extend(span_attrs);

                        // Determine event type based on op_name
                        // REQ-10: fredo.session → AgentSession, fredo.llm → Chat,
                        // fredo.tool.* → ToolUse; legacy: chat/invoke_agent → Chat,
                        // execute_tool/permission/elicitation → ToolUse
                        let event_type = match op_name.as_str() {
                            "session" => EventType::AgentSession,
                            "chat" | "invoke_agent" => EventType::Chat,
                            _ => EventType::ToolUse,
                        };

                        // REQ-11: Determine EventState from span timing.
                        // If endTimeUnixNano is present → Response, otherwise → Init.
                        // REQ-609 (REQ-1): Session spans always emit Init only — never Response.
                        // Prevents premature ECE buffer completion that blocks fredo.llm span data.
                        let event_state = if op_name == "session" {
                            EventState::Init
                        } else {
                            Self::req_11_event_state_from_span(span)
                        };

                        // REQ-3: Use stored correlationId from Hook events when available.
                        // REQ-639 (REQ-2): For pure-OTLP sessions, generate unique per-turn
                        // correlationIds so each turn's ECE composite key is unique.
                        //
                        // Logic:
                        // 1. If session_to_correlation has a stored entry AND session_turn_counter
                        //    has NO entry → Hook-bridged → use stored entry unconditionally.
                        // 2. If no stored entry OR session_turn_counter has an entry (pure OTLP):
                        //    - On Init: increment turn counter, generate "session_N", UPSERT in map
                        //    - On non-Init: use stored entry from map (or session_id fallback)
                        let otlp_correlation_id = {
                            let stored = self
                                .session_to_correlation
                                .lock()
                                .ok()
                                .and_then(|m| m.get(&session_id).cloned());
                            let has_turn_counter = self
                                .session_turn_counter
                                .lock()
                                .ok()
                                .map(|m| m.contains_key(&session_id))
                                .unwrap_or(false);

                            if let Some(ref cid) = stored {
                                if !has_turn_counter {
                                    // Hook-bridged: stored correlationId came from Hook transport
                                    cid.clone()
                                } else if event_state == EventState::Init {
                                    // Pure OTLP Init: generate new per-turn correlationId
                                    let mut turn_map = self.session_turn_counter.lock().ok();
                                    let counter = turn_map
                                        .as_mut()
                                        .map(|m| {
                                            let entry = m.entry(session_id.clone()).or_insert(0);
                                            *entry += 1;
                                            *entry
                                        })
                                        .unwrap_or(1);
                                    let new_cid = format!("{}_{}", session_id, counter);

                                    // Upsert in session_to_correlation
                                    if let Ok(mut map) = self.session_to_correlation.lock() {
                                        if map.len() >= 10_000 && !map.contains_key(&session_id) {
                                            if let Some(key) = map.keys().next().cloned() {
                                                map.remove(&key);
                                            }
                                        }
                                        map.insert(session_id.clone(), new_cid.clone());
                                    }

                                    // Cap turn_counter at 10K entries
                                    if let Some(ref mut tm) = turn_map {
                                        if tm.len() >= 10_000 {
                                            if let Some(key) = tm.keys().next().cloned() {
                                                tm.remove(&key);
                                            }
                                        }
                                    }

                                    new_cid
                                } else {
                                    // Pure OTLP non-Init: use stored entry
                                    cid.clone()
                                }
                            } else if event_state == EventState::Init {
                                // Pure OTLP first Init: generate new per-turn correlationId
                                let mut turn_map = self.session_turn_counter.lock().ok();
                                let counter = turn_map
                                    .as_mut()
                                    .map(|m| {
                                        let entry = m.entry(session_id.clone()).or_insert(0);
                                        *entry += 1;
                                        *entry
                                    })
                                    .unwrap_or(1);
                                let new_cid = format!("{}_{}", session_id, counter);

                                // Store in session_to_correlation with cap logic
                                if let Ok(mut map) = self.session_to_correlation.lock() {
                                    if map.len() >= 10_000 && !map.contains_key(&session_id) {
                                        if let Some(key) = map.keys().next().cloned() {
                                            map.remove(&key);
                                        }
                                    }
                                    map.insert(session_id.clone(), new_cid.clone());
                                }

                                // Cap turn_counter at 10K entries
                                if let Some(ref mut tm) = turn_map {
                                    if tm.len() >= 10_000 {
                                        if let Some(key) = tm.keys().next().cloned() {
                                            tm.remove(&key);
                                        }
                                    }
                                }

                                new_cid
                            } else {
                                // Non-Init with no stored entry: use session_id as fallback
                                let cid = session_id.clone();
                                if let Ok(mut map) = self.session_to_correlation.lock() {
                                    if map.len() >= 10_000 && !map.contains_key(&session_id) {
                                        if let Some(key) = map.keys().next().cloned() {
                                            map.remove(&key);
                                        }
                                    }
                                    map.entry(session_id.clone()).or_insert_with(|| cid.clone());
                                }
                                cid
                            }
                        };

                        // REQ-6 (Spec #633 Redesign): Extract parent from OTLP span links
                        // for order-independent parent-child relationship detection.
                        // Span links are set by the plugin when creating subagent session spans,
                        // embedding the parent session's span context with a parent.session_id
                        // attribute. This resolves relationships regardless of OTLP batch arrival order
                        // — no cross-batch deferred delivery state needed.
                        //
                        // Span links are on the OTLP span JSON, not in merged attributes.
                        // Each link has an "attributes" array (same key-value format as span attrs).
                        let parent_from_links: Option<String> = span.get("links")
                            .and_then(|l| l.as_array())
                            .and_then(|links| {
                                for link in links {
                                    let link_attrs = Self::otlp_attrs_to_map(link.get("attributes"));
                                    if let Some(pid) = link_attrs.get("parent.session_id")
                                        .and_then(|v| v.as_str())
                                        .filter(|pid| !pid.is_empty() && *pid != session_id)
                                    {
                                        return Some(pid.to_string());
                                    }
                                }
                                None
                            });

                        if let Some(ref parent_sid) = parent_from_links {
                            if let Ok(mut map) = self.session_to_parent.lock() {
                                if map.len() >= 10_000 && !map.contains_key(&session_id) {
                                    if let Some(key) = map.keys().next().cloned() {
                                        map.remove(&key);
                                    }
                                }
                                map.insert(session_id.clone(), parent_sid.clone());
                            }
                        }

                        // REQ-9 (Spec #633 Redesign): Fallback to session.parent_id attribute
                        // for backward compatibility with old plugin spans that don't carry span links.
                        // Span links take priority when present (checked above); attribute-based
                        // detection serves as fallback for older plugin versions.
                        let parent_from_attrs = merged.get("session.parent_id")
                            .and_then(|v| v.as_str())
                            .filter(|psid| !psid.is_empty() && *psid != session_id)
                            .map(|s| s.to_string());

                        if let Some(ref parent_sid) = parent_from_attrs {
                            if let Ok(mut map) = self.session_to_parent.lock() {
                                // Only insert if not already set by span links (REQ-6 takes priority)
                                if !map.contains_key(&session_id) {
                                    if map.len() >= 10_000 {
                                        if let Some(key) = map.keys().next().cloned() {
                                            map.remove(&key);
                                        }
                                    }
                                    map.insert(session_id.clone(), parent_sid.clone());
                                }
                            }
                        }

                        let is_subagent = merged.get("is_subagent")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false)
                            || merged.get("agent.type")
                                .and_then(|v| v.as_str())
                                .map(|s| s == "subagent")
                                .unwrap_or(false);

                        let relationship_meta: Option<serde_json::Value> = if is_subagent {
                            // Subagent session: look up parent by session_id from session_to_parent.
                            // Map is populated from OTLP session.parent_id attributes (self-population)
                            // and Hook transport events (fallback). The dual-source approach handles
                            // timing edge cases where one transport arrives before the other.
                            self.session_to_parent.lock().ok()
                                .and_then(|m| m.get(&session_id).cloned())
                                .filter(|psid| psid != &session_id)
                                .map(|parent| json!({
                                    "relationship": {
                                        "type": "parent-child",
                                        "parentSessionId": parent,
                                        "childSessionId": session_id
                                    }
                                }))
                        } else {
                            None
                        };

                        // Bug 1 (Spec #633): Extract task instruction from tool_input attribute
                        // when this is a fredo.tool.task span. The instruction is stored in
                        // pending_task_instructions keyed by session_id (the parent session that
                        // called the task tool). When the subagent session span is processed
                        // later, it looks up the instruction by the parent session ID from
                        // relationship_meta.
                        //
                        // Must happen BEFORE otlp_attrs_to_payload consumes `merged`.
                        if op_name == "tool.task" {
                            let tool_input_str = merged.get("tool_input")
                                .and_then(|v| v.as_str())
                                .or_else(|| merged.get("fredo.tool.task.input")
                                    .and_then(|v| v.as_str()));
                            if let Some(input_json) = tool_input_str {
                                if let Ok(parsed) = serde_json::from_str::<Value>(input_json) {
                                    let task_instruction = parsed.get("task")
                                        .or_else(|| parsed.get("instruction"))
                                        .and_then(|v| v.as_str())
                                        .filter(|s| !s.is_empty())
                                        .map(|s| s.to_string());
                                    if let Some(instr) = task_instruction {
                                        if let Ok(mut map) = self.pending_task_instructions.lock() {
                                            if map.len() >= 10_000 && !map.contains_key(&session_id) {
                                                if let Some(key) = map.keys().next().cloned() {
                                                    map.remove(&key);
                                                }
                                            }
                                            map.insert(session_id.clone(), instr);
                                        }
                                    }
                                }
                            }
                        }

                        // REQ-1 (Spec #633 AC-6c): Cache parent session prompts for subagent
                        // instruction injection. Extract prompt from non-subagent spans.
                        if !is_subagent {
                            let parent_prompt = merged.get("gen_ai.prompt")
                                .and_then(|v| v.as_str())
                                .or_else(|| merged.get("prompt").and_then(|v| v.as_str()))
                                .filter(|s| !s.trim().is_empty());
                            if let Some(prompt) = parent_prompt {
                                if let Ok(mut map) = self.parent_prompts.lock() {
                                    contract_633_ac6c::req_1_cache_parent_prompt(&mut map, &session_id, prompt);
                                }
                            }
                        }

                        // REQ-2 / AC-2: Map flat OTLP attributes to nested payload structure
                        let mut mapped_payload = Self::otlp_attrs_to_payload(merged);

                        // Bug 1 (Spec #633): Inject instruction field for OTLP subagent sessions.
                        // Look up the instruction from the pending_task_instructions map
                        // (keyed by parent session ID from relationship_meta). This is the
                        // task instruction extracted from the fredo.tool.task span's
                        // tool_input attribute when the parent agent dispatched the subagent.
                        if is_subagent {
                            let instruction: Option<String> = relationship_meta
                                .as_ref()
                                .and_then(|meta| meta.get("relationship"))
                                .and_then(|rel| rel.get("parentSessionId"))
                                .and_then(|v| v.as_str())
                                .and_then(|parent_sid| {
                                    self.pending_task_instructions.lock().ok()
                                        .and_then(|m| m.get(parent_sid).cloned())
                                });
                            if let Some(ref instr) = instruction {
                                if !instr.is_empty() {
                                    if let Some(obj) = mapped_payload.as_object_mut() {
                                        obj.insert("instruction".to_string(), Value::String(instr.clone()));
                                    }
                                }
                            }
                        }

                        // Fallback: try parent_prompts cache if pending_task_instructions didn't find anything
                        if is_subagent {
                            let has_instruction = mapped_payload.get("instruction")
                                .and_then(|v| v.as_str())
                                .map(|s| !s.trim().is_empty())
                                .unwrap_or(false);
                            if !has_instruction {
                                if let (Ok(parent_prompts), Ok(session_to_parent)) = (
                                    self.parent_prompts.lock(),
                                    self.session_to_parent.lock(),
                                ) {
                                    contract_633_ac6c::req_2_inject_parent_prompt_as_instruction(
                                        &parent_prompts,
                                        &session_to_parent,
                                        &session_id,
                                        &mut mapped_payload,
                                    );
                                }
                            }
                        }

                        // REQ-3: Clone payload before move — may be needed for synthetic Init event
                        let init_payload = mapped_payload.clone();

                        // REQ-12: Extract tool_name from op_name for fredo.tool.* spans
                        let tool_name = if op_name.starts_with(CC_OP_TOOL_PREFIX) {
                            // op_name is "tool.Bash" → extract just the tool name suffix
                            op_name.strip_prefix(CC_OP_TOOL_PREFIX).map(|s| s.to_string())
                        } else {
                            None
                        };

                        let tool_name_str = tool_name.as_deref().unwrap_or(&op_name).to_string();
                        let event_session_id = session_id.clone();
                        let event_correlation_id = otlp_correlation_id.clone();

                        let mut event_builder = FredoEvent::builder()
                            .event_type(event_type)
                            .state(event_state)
                            .provider(provider)
                            .transport(Transport::OtlpGrpc)
                            .session_id(event_session_id)
                            .correlation_id(event_correlation_id)
                            .payload(mapped_payload);

                        // Spec #615: Attach relationship metadata for subagent compositing
                        if let Some(ref meta) = relationship_meta {
                            event_builder = event_builder.metadata(meta.clone());
                        }

                        // Use tool_name for fredo.tool.* spans; for other span types,
                        // use op_name as tool_name for backward compatibility
                        if let Some(ref tn) = tool_name {
                            event_builder = event_builder.tool_name(tn);
                        } else {
                            event_builder = event_builder.tool_name(&op_name);
                        }

                        // REQ-11 fix: For completed spans (Response state), emit both
                        // an Init event (so SpanCollector creates the span) and the
                        // Response event. Without this, spans that arrive already
                        // completed (common for short-lived sessions) are silently
                        // dropped because SpanCollector expects Init before Response.
                        if event_state == EventState::Response {
                            let mut init_builder = FredoEvent::builder()
                                .event_type(event_type)
                                .state(EventState::Init)
                                .provider(provider)
                                .transport(Transport::OtlpGrpc)
                                .session_id(session_id.clone())
                                .correlation_id(otlp_correlation_id.clone())
                                .tool_name(&tool_name_str)
                                .payload(init_payload);

                            // Spec #615: Also attach relationship metadata to synthetic Init
                            if let Some(ref meta) = relationship_meta {
                                init_builder = init_builder.metadata(meta.clone());
                            }

                            events.push(init_builder.build());
                        }
                        events.push(event_builder.build());
                    }
                }
            }
            return Ok(events);
        }

        // Flat/custom JSON (OpenCode file-exporter style)
        let raw_name = raw
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("otlp.span");
        let attrs = Self::otlp_attrs_to_map(raw.get("attributes"));

        // Normalize op_name with span.type fallback
        let op_name = Self::normalize_op_name_with_fallback(raw_name, &attrs)
            .unwrap_or_else(|| raw_name.to_string());

        // REQ-10: fredo.session → AgentSession, fredo.llm → Chat,
        // fredo.tool.* → ToolUse; legacy: chat/invoke_agent → Chat
        let event_type = match op_name.as_str() {
            "session" => EventType::AgentSession,
            "chat" | "invoke_agent" => EventType::Chat,
            _ => EventType::ToolUse,
        };

        // REQ-11: Determine EventState from span timing.
        // REQ-609 (REQ-1): Session spans always emit Init only — never Response.
        let event_state = if op_name == "session" {
            EventState::Init
        } else if raw.get("endTimeUnixNano").is_some() {
            EventState::Response
        } else {
            EventState::Init
        };

        // REQ-12: session.id preferred over gen_ai.conversation.id
        let session_id = attrs
            .get(CC_ATTR_SESSION_ID)
            .and_then(|v| v.as_str())
            .map(str::to_owned)
            .or_else(|| {
                attrs
                    .get(CC_LEGACY_ATTR_CONVERSATION_ID)
                    .and_then(|v| v.as_str())
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| Uuid::new_v4().to_string());

        // REQ-3: Use stored correlationId from Hook events when available.
        // REQ-639 (REQ-2): For pure-OTLP sessions, generate unique per-turn
        // correlationIds so each turn's ECE composite key is unique.
        let flat_correlation_id = {
            let stored = self
                .session_to_correlation
                .lock()
                .ok()
                .and_then(|m| m.get(&session_id).cloned());
            let has_turn_counter = self
                .session_turn_counter
                .lock()
                .ok()
                .map(|m| m.contains_key(&session_id))
                .unwrap_or(false);

            if let Some(ref cid) = stored {
                if !has_turn_counter {
                    // Hook-bridged: stored correlationId came from Hook transport
                    cid.clone()
                } else if event_state == EventState::Init {
                    // Pure OTLP Init: generate new per-turn correlationId
                    let mut turn_map = self.session_turn_counter.lock().ok();
                    let counter = turn_map
                        .as_mut()
                        .map(|m| {
                            let entry = m.entry(session_id.clone()).or_insert(0);
                            *entry += 1;
                            *entry
                        })
                        .unwrap_or(1);
                    let new_cid = format!("{}_{}", session_id, counter);

                    // Upsert in session_to_correlation
                    if let Ok(mut map) = self.session_to_correlation.lock() {
                        if map.len() >= 10_000 && !map.contains_key(&session_id) {
                            if let Some(key) = map.keys().next().cloned() {
                                map.remove(&key);
                            }
                        }
                        map.insert(session_id.clone(), new_cid.clone());
                    }

                    // Cap turn_counter at 10K entries
                    if let Some(ref mut tm) = turn_map {
                        if tm.len() >= 10_000 {
                            if let Some(key) = tm.keys().next().cloned() {
                                tm.remove(&key);
                            }
                        }
                    }

                    new_cid
                } else {
                    // Pure OTLP non-Init: use stored entry
                    cid.clone()
                }
            } else if event_state == EventState::Init {
                // Pure OTLP first Init: generate new per-turn correlationId
                let mut turn_map = self.session_turn_counter.lock().ok();
                let counter = turn_map
                    .as_mut()
                    .map(|m| {
                        let entry = m.entry(session_id.clone()).or_insert(0);
                        *entry += 1;
                        *entry
                    })
                    .unwrap_or(1);
                let new_cid = format!("{}_{}", session_id, counter);

                // Store in session_to_correlation with cap logic
                if let Ok(mut map) = self.session_to_correlation.lock() {
                    if map.len() >= 10_000 && !map.contains_key(&session_id) {
                        if let Some(key) = map.keys().next().cloned() {
                            map.remove(&key);
                        }
                    }
                    map.insert(session_id.clone(), new_cid.clone());
                }

                // Cap turn_counter at 10K entries
                if let Some(ref mut tm) = turn_map {
                    if tm.len() >= 10_000 {
                        if let Some(key) = tm.keys().next().cloned() {
                            tm.remove(&key);
                        }
                    }
                }

                new_cid
            } else {
                // Non-Init with no stored entry: use session_id as fallback
                let cid = session_id.clone();
                if let Ok(mut map) = self.session_to_correlation.lock() {
                    if map.len() >= 10_000 && !map.contains_key(&session_id) {
                        if let Some(key) = map.keys().next().cloned() {
                            map.remove(&key);
                        }
                    }
                    map.entry(session_id.clone()).or_insert_with(|| cid.clone());
                }
                cid
            }
        };

        // REQ-639 (REQ-1): Self-populate session_to_parent from session.parent_id attribute
        // (same pattern as resourceSpans path at lines 2182-2198)
        let parent_from_attrs = attrs
            .get("session.parent_id")
            .and_then(|v| v.as_str())
            .filter(|psid| !psid.is_empty() && *psid != session_id)
            .map(|s| s.to_string());

        if let Some(ref parent_sid) = parent_from_attrs {
            if let Ok(mut map) = self.session_to_parent.lock() {
                if map.len() >= 10_000 && !map.contains_key(&session_id) {
                    if let Some(key) = map.keys().next().cloned() {
                        map.remove(&key);
                    }
                }
                map.entry(session_id.clone()).or_insert_with(|| parent_sid.clone());
            }
        }

        // REQ-639 (REQ-1): Detect subagent from span attributes
        let is_subagent = attrs
            .get("is_subagent")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
            || attrs
                .get("agent.type")
                .and_then(|v| v.as_str())
                .map(|s| s == "subagent")
                .unwrap_or(false);

        let relationship_meta: Option<serde_json::Value> = if is_subagent {
            self.session_to_parent.lock().ok()
                .and_then(|m| m.get(&session_id).cloned())
                .filter(|psid| psid != &session_id)
                .map(|parent| json!({
                    "relationship": {
                        "type": "parent-child",
                        "parentSessionId": parent,
                        "childSessionId": session_id
                    }
                }))
        } else {
            None
        };

        // Bug 1 (Spec #633): Extract task instruction from tool_input attribute
        // when this is a fredo.tool.task span (same pattern as Branch A above).
        // Must happen BEFORE otlp_attrs_to_payload consumes `attrs`.
        if op_name == "tool.task" {
            let tool_input_str = attrs.get("tool_input")
                .and_then(|v| v.as_str())
                .or_else(|| attrs.get("fredo.tool.task.input")
                    .and_then(|v| v.as_str()));
            if let Some(input_json) = tool_input_str {
                if let Ok(parsed) = serde_json::from_str::<Value>(input_json) {
                    let task_instruction = parsed.get("task")
                        .or_else(|| parsed.get("instruction"))
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.is_empty())
                        .map(|s| s.to_string());
                    if let Some(instr) = task_instruction {
                        if let Ok(mut map) = self.pending_task_instructions.lock() {
                            if map.len() >= 10_000 && !map.contains_key(&session_id) {
                                if let Some(key) = map.keys().next().cloned() {
                                    map.remove(&key);
                                }
                            }
                            map.insert(session_id.clone(), instr);
                        }
                    }
                }
            }
        }

        // REQ-1 (Spec #633 AC-6c): Cache parent session prompts for subagent instruction injection.
        // Extract prompt from non-subagent spans in the flat span path.
        if !is_subagent {
            let parent_prompt = attrs.get("gen_ai.prompt")
                .and_then(|v| v.as_str())
                .or_else(|| attrs.get("prompt").and_then(|v| v.as_str()))
                .filter(|s| !s.trim().is_empty());
            if let Some(prompt) = parent_prompt {
                if let Ok(mut map) = self.parent_prompts.lock() {
                    contract_633_ac6c::req_1_cache_parent_prompt(&mut map, &session_id, prompt);
                }
            }
        }

        // REQ-2 / AC-2: Map flat OTLP attributes to nested payload structure
        let mut mapped_attrs = Self::otlp_attrs_to_payload(attrs);

        // Bug 1 (Spec #633): Inject instruction field for OTLP subagent sessions.
        // Look up from pending_task_instructions keyed by parent session ID.
        if is_subagent {
            let instruction: Option<String> = relationship_meta
                .as_ref()
                .and_then(|meta| meta.get("relationship"))
                .and_then(|rel| rel.get("parentSessionId"))
                .and_then(|v| v.as_str())
                .and_then(|parent_sid| {
                    self.pending_task_instructions.lock().ok()
                        .and_then(|m| m.get(parent_sid).cloned())
                });
            if let Some(ref instr) = instruction {
                if !instr.is_empty() {
                    if let Some(obj) = mapped_attrs.as_object_mut() {
                        obj.insert("instruction".to_string(), Value::String(instr.clone()));
                    }
                }
            }
        }

        // Fallback: try parent_prompts cache if pending_task_instructions didn't find anything
        if is_subagent {
            let has_instruction = mapped_attrs.get("instruction")
                .and_then(|v| v.as_str())
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false);
            if !has_instruction {
                if let (Ok(parent_prompts), Ok(session_to_parent)) = (
                    self.parent_prompts.lock(),
                    self.session_to_parent.lock(),
                ) {
                    contract_633_ac6c::req_2_inject_parent_prompt_as_instruction(
                        &parent_prompts,
                        &session_to_parent,
                        &session_id,
                        &mut mapped_attrs,
                    );
                }
            }
        }

        // REQ-3: Clone payload before move — may be needed for synthetic Init event
        let flat_init_payload = mapped_attrs.clone();

        // REQ-12: Extract tool_name from op_name for fredo.tool.* spans
        let tool_name = if op_name.starts_with(CC_OP_TOOL_PREFIX) {
            op_name.strip_prefix(CC_OP_TOOL_PREFIX).map(|s| s.to_string())
        } else {
            None
        };

        let tool_name_str = tool_name.as_deref().unwrap_or(&op_name).to_string();
        let flat_session_id = session_id.clone();
        let flat_corr_id = flat_correlation_id.clone();

        let mut event_builder = FredoEvent::builder()
            .event_type(event_type)
            .state(event_state)
            .provider(provider)
            .transport(Transport::OtlpGrpc)
            .session_id(flat_session_id)
            .correlation_id(flat_corr_id)
            .payload(mapped_attrs);

        // Spec #615: Attach relationship metadata for subagent compositing
        if let Some(ref meta) = relationship_meta {
            event_builder = event_builder.metadata(meta.clone());
        }

        if let Some(ref tn) = tool_name {
            event_builder = event_builder.tool_name(tn);
        } else {
            event_builder = event_builder.tool_name(&op_name);
        }

        // REQ-11 fix: Emit Init event before Response for completed spans
        if event_state == EventState::Response {
            let mut init_builder = FredoEvent::builder()
                .event_type(event_type)
                .state(EventState::Init)
                .provider(provider)
                .transport(Transport::OtlpGrpc)
                .session_id(session_id.clone())
                .correlation_id(flat_correlation_id.clone())
                .tool_name(&tool_name_str)
                .payload(flat_init_payload);

            // Spec #615: Also attach relationship metadata to synthetic Init
            if let Some(ref meta) = relationship_meta {
                init_builder = init_builder.metadata(meta.clone());
            }

            events.push(init_builder.build());
        }
        events.push(event_builder.build());

        Ok(events)
    }
}

impl Default for OpenCodeAdapter {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl CommAdapter for OpenCodeAdapter {
    fn name(&self) -> &str {
        "opencode"
    }

    fn provider(&self) -> EventProvider {
        EventProvider::OpenCode
    }

    async fn transform(
        &self,
        transport: Transport,
        raw: serde_json::Value,
    ) -> anyhow::Result<Vec<FredoEvent>> {
        match transport {
            Transport::Hook => self.transform_hook(raw),
            Transport::OtlpGrpc | Transport::OtlpHttp => self.transform_otlp(raw),
            // Unknown transport — return empty vec (graceful handling)
            _ => Ok(vec![]),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opencode_adapter_name() {
        let adapter = OpenCodeAdapter::new();
        assert_eq!(adapter.name(), "opencode");
    }

    #[test]
    fn opencode_adapter_provider() {
        let adapter = OpenCodeAdapter::new();
        assert_eq!(adapter.provider(), EventProvider::OpenCode);
    }

    #[test]
    fn transform_hook_pretooluse() {
        let adapter = OpenCodeAdapter::new();
        let payload = serde_json::json!({
            "tool_name": "Bash",
            "tool_input": { "command": "ls -la" },
            "tool_use_id": "pre-tool-123",
            "properties": { "sessionID": "test-session" }
        });

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(adapter.transform(Transport::Hook, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, EventType::ToolUse);
        assert_eq!(events[0].state, EventState::Init);
        assert_eq!(events[0].correlation_id, Some("pre-tool-123".into()));
    }

    #[test]
    fn transform_hook_posttooluse() {
        let adapter = OpenCodeAdapter::new();
        let payload = serde_json::json!({
            "tool_name": "Bash",
            "tool_response": { "stdout": "file1 file2" },
            "tool_use_id": "post-tool-456",
            "properties": { "sessionID": "test-session" }
        });

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(adapter.transform(Transport::Hook, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].state, EventState::Response);
    }

    #[test]
    fn transform_hook_posttoolusefailure() {
        let adapter = OpenCodeAdapter::new();
        let payload = serde_json::json!({
            "tool_name": "Bash",
            "error": "Command failed",
            "tool_use_id": "fail-tool-789",
            "properties": { "sessionID": "test-session" }
        });

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(adapter.transform(Transport::Hook, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].state, EventState::Error);
        assert!(events[0].error.is_some());
    }

    // ——— AC-R1: Hook message.part.updated with messageID sets correlationId ———

    #[test]
    fn ac_r1_message_part_updated_with_message_id() {
        let adapter = OpenCodeAdapter::new();
        // message.part.updated extracts inner = properties, so raw inside
        // transform_with_event_type is the properties object.
        // messageID lives at properties.part.messageID → matched by raw.part.messageID path.
        let payload = serde_json::json!({
            "event_type": "message.part.updated",
            "properties": {
                "sessionID": "sess-r1",
                "part": {
                    "messageID": "msg-abc",
                    "text": "hello"
                }
            }
        });

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(adapter.transform(Transport::Hook, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, EventType::Chat);
        assert_eq!(events[0].correlation_id, Some("msg-abc".to_string()));
    }

    // ——— AC-R2: Hook Chat event without messageID uses UUID fallback ———

    #[test]
    fn ac_r2_chat_without_message_id_uses_uuid_fallback() {
        let adapter = OpenCodeAdapter::new();
        // session.next.text.delta is a Chat event but typically has no messageID.
        let payload = serde_json::json!({
            "event_type": "session.next.text.delta",
            "properties": {
                "sessionID": "sess-r2",
                "text": "some delta text"
            }
        });

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(adapter.transform(Transport::Hook, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, EventType::Chat);
        let cid = events[0].correlation_id.clone();
        assert!(cid.is_some(), "correlationId should not be None");
        assert!(
            !cid.as_deref().unwrap().is_empty(),
            "correlationId should not be empty"
        );
        // UUID v4 format: 8-4-4-4-12 = 36 chars
        assert_eq!(
            cid.as_deref().unwrap().len(),
            36,
            "UUID v4 should be 36 chars"
        );
    }

    // ——— AC-R3: OTLP chat span uses session_id as correlationId ———

    #[test]
    fn ac_r3_otlp_chat_span_uses_session_id_as_correlation() {
        let adapter = OpenCodeAdapter::new();
        let payload = serde_json::json!({
            "resourceSpans": [{
                "resource": { "attributes": [] },
                "scopeSpans": [{
                    "spans": [{
                        "name": "chat",
                        "traceId": "abc123",
                        "attributes": [
                            { "key": "gen_ai.operation.name", "value": { "stringValue": "chat" } },
                            { "key": "gen_ai.conversation.id", "value": { "stringValue": "conv-r3" } }
                        ]
                    }]
                }]
            }]
        });

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(adapter.transform(Transport::OtlpGrpc, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, EventType::Chat);
        // REQ-639 (REQ-2): Pure-OTLP Init generates unique per-turn correlationId
        assert_eq!(events[0].correlation_id, Some("conv-r3_1".to_string()));
    }

    // ——— AC-R4: OTLP invoke_agent span uses session_id as correlationId ———

    #[test]
    fn ac_r4_otlp_invoke_agent_span_trace_id_to_correlation() {
        let adapter = OpenCodeAdapter::new();
        let payload = serde_json::json!({
            "resourceSpans": [{
                "resource": { "attributes": [] },
                "scopeSpans": [{
                    "spans": [{
                        "name": "invoke_agent",
                        "traceId": "xyz789",
                        "attributes": [
                            { "key": "gen_ai.operation.name", "value": { "stringValue": "invoke_agent" } },
                            { "key": "gen_ai.conversation.id", "value": { "stringValue": "conv-r4" } }
                        ]
                    }]
                }]
            }]
        });

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(adapter.transform(Transport::OtlpGrpc, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, EventType::Chat);
        // REQ-639 (REQ-2): Pure-OTLP Init generates unique per-turn correlationId
        assert_eq!(events[0].correlation_id, Some("conv-r4_1".to_string()));
    }

    // ——— AC-R5: OTLP chat span without traceId uses session_id as correlationId ———

    #[test]
    fn ac_r5_otlp_chat_span_without_trace_id_uses_session_id() {
        let adapter = OpenCodeAdapter::new();
        let payload = serde_json::json!({
            "resourceSpans": [{
                "resource": { "attributes": [] },
                "scopeSpans": [{
                    "spans": [{
                        "name": "chat",
                        "traceId": "",
                        "attributes": [
                            { "key": "gen_ai.operation.name", "value": { "stringValue": "chat" } },
                            { "key": "gen_ai.conversation.id", "value": { "stringValue": "conv-r5" } }
                        ]
                    }]
                }]
            }]
        });

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(adapter.transform(Transport::OtlpGrpc, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, EventType::Chat);
        let cid = events[0].correlation_id.clone();
        assert!(cid.is_some(), "correlationId should not be None");
        // REQ-639 (REQ-2): Pure-OTLP Init generates unique per-turn correlationId
        assert_eq!(
            cid.as_deref().unwrap(),
            "conv-r5_1",
            "Pure-OTLP Init should generate unique per-turn correlationId"
        );
    }

    // ——— AC-R6: PreToolUse tool_use_id → correlationId unchanged ———

    #[test]
    fn ac_r6_pretool_use_preserves_tool_use_id_correlation() {
        let adapter = OpenCodeAdapter::new();
        let payload = serde_json::json!({
            "event_type": "PreToolUse",
            "tool_name": "Bash",
            "tool_input": { "command": "ls" },
            "tool_use_id": "tool-1",
            "properties": { "sessionID": "sess-r6" }
        });

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(adapter.transform(Transport::Hook, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, EventType::ToolUse);
        assert_eq!(events[0].correlation_id, Some("tool-1".to_string()));
    }

    // ——— AC-R7: No Chat event returns with None correlationId ———

    #[test]
    fn ac_r7_no_chat_event_returns_none_correlation_id() {
        let adapter = OpenCodeAdapter::new();
        let rt = tokio::runtime::Runtime::new().unwrap();

        // 1. UserPromptSubmit with properties.messageID
        let result = rt.block_on(adapter.transform(
            Transport::Hook,
            serde_json::json!({
                "event_type": "UserPromptSubmit",
                "properties": {
                    "sessionID": "sess-r7",
                    "messageID": "msg-1"
                }
            }),
        ));
        assert!(result.is_ok());
        let events = result.unwrap();
        assert_eq!(events[0].event_type, EventType::Chat);
        assert!(events[0].correlation_id.is_some());
        assert_eq!(events[0].correlation_id.as_deref().unwrap(), "msg-1");

        // 2. chat.message with properties.part.messageID
        let result = rt.block_on(adapter.transform(
            Transport::Hook,
            serde_json::json!({
                "event_type": "chat.message",
                "properties": {
                    "sessionID": "sess-r7b",
                    "part": { "messageID": "msg-2" }
                }
            }),
        ));
        assert!(result.is_ok());
        let events = result.unwrap();
        assert_eq!(events[0].event_type, EventType::Chat);
        assert!(events[0].correlation_id.is_some());
        assert_eq!(events[0].correlation_id.as_deref().unwrap(), "msg-2");

        // 3. session.next.text.delta without messageID → UUID fallback
        let result = rt.block_on(adapter.transform(
            Transport::Hook,
            serde_json::json!({
                "event_type": "session.next.text.delta",
                "properties": {
                    "sessionID": "sess-r7c",
                    "text": "delta text"
                }
            }),
        ));
        assert!(result.is_ok());
        let events = result.unwrap();
        assert_eq!(events[0].event_type, EventType::Chat);
        let cid = events[0].correlation_id.clone();
        assert!(
            cid.is_some(),
            "Chat event should have non-None correlationId (UUID fallback)"
        );
        assert!(
            !cid.as_deref().unwrap().is_empty(),
            "UUID fallback should not be empty"
        );

        // 4. message.part.updated with properties.part.messageID → inner extraction
        let result = rt.block_on(adapter.transform(
            Transport::Hook,
            serde_json::json!({
                "event_type": "message.part.updated",
                "properties": {
                    "sessionID": "sess-r7d",
                    "part": { "messageID": "msg-4" }
                }
            }),
        ));
        assert!(result.is_ok());
        let events = result.unwrap();
        assert_eq!(events[0].event_type, EventType::Chat);
        assert!(events[0].correlation_id.is_some());
        assert_eq!(events[0].correlation_id.as_deref().unwrap(), "msg-4");

        // 5. OTLP chat span with traceId — uses session_id, not traceId
        let result = rt.block_on(adapter.transform(Transport::OtlpGrpc, serde_json::json!({
            "resourceSpans": [{
                "resource": { "attributes": [] },
                "scopeSpans": [{
                    "spans": [{
                        "name": "chat",
                        "traceId": "trace-r7",
                        "attributes": [
                            { "key": "gen_ai.operation.name", "value": { "stringValue": "chat" } },
                            { "key": "gen_ai.conversation.id", "value": { "stringValue": "conv-r7" } }
                        ]
                    }]
                }]
            }]
        })));
        assert!(result.is_ok());
        let events = result.unwrap();
        assert_eq!(events[0].event_type, EventType::Chat);
        assert!(events[0].correlation_id.is_some());
        // REQ-639 (REQ-2): Pure-OTLP Init generates unique per-turn correlationId
        assert_eq!(events[0].correlation_id.as_deref().unwrap(), "conv-r7_1");

        // 6. OTLP chat span without traceId uses session_id as correlationId
        let result = rt.block_on(adapter.transform(Transport::OtlpGrpc, serde_json::json!({
            "resourceSpans": [{
                "resource": { "attributes": [] },
                "scopeSpans": [{
                    "spans": [{
                        "name": "chat",
                        "traceId": "",
                        "attributes": [
                            { "key": "gen_ai.operation.name", "value": { "stringValue": "chat" } },
                            { "key": "gen_ai.conversation.id", "value": { "stringValue": "conv-r7b" } }
                        ]
                    }]
                }]
            }]
        })));
        assert!(result.is_ok());
        let events = result.unwrap();
        assert_eq!(events[0].event_type, EventType::Chat);
        let cid = events[0].correlation_id.clone();
        assert!(
            cid.is_some(),
            "OTLP Chat event should have non-None correlationId"
        );
        // REQ-639 (REQ-2): Pure-OTLP Init generates unique per-turn correlationId
        assert_eq!(
            cid.as_deref().unwrap(),
            "conv-r7b_1",
            "Pure-OTLP Init should generate unique per-turn correlationId"
        );
    }

    // ——— AC-2: OTLP attribute mapping tests ———

    #[test]
    fn ac_2_otlp_attrs_to_payload_maps_tokens() {
        let mut attrs = Map::new();
        attrs.insert("gen_ai.usage.input_tokens".to_string(), json!(42));
        attrs.insert("gen_ai.usage.output_tokens".to_string(), json!(128));
        attrs.insert("gen_ai.conversation.id".to_string(), json!("conv-1"));

        let result = OpenCodeAdapter::otlp_attrs_to_payload(attrs);
        let obj = result.as_object().unwrap();

        // Flat attrs preserved
        assert_eq!(
            obj.get("gen_ai.usage.input_tokens")
                .and_then(|v| v.as_i64()),
            Some(42)
        );
        assert_eq!(
            obj.get("gen_ai.usage.output_tokens")
                .and_then(|v| v.as_i64()),
            Some(128)
        );

        // Nested info object
        let info = obj.get("info").and_then(|v| v.as_object()).unwrap();
        assert_eq!(
            info.get("turnInputTokens").and_then(|v| v.as_i64()),
            Some(42)
        );
        assert_eq!(
            info.get("turnOutputTokens").and_then(|v| v.as_i64()),
            Some(128)
        );

        // No part object (no response body)
        assert!(obj.get("part").is_none());
    }

    #[test]
    fn ac_2_otlp_attrs_to_payload_maps_response_body() {
        let mut attrs = Map::new();
        attrs.insert(
            "gen_ai.response.body".to_string(),
            json!("Hello, I am an AI assistant."),
        );
        attrs.insert("gen_ai.conversation.id".to_string(), json!("conv-2"));

        let result = OpenCodeAdapter::otlp_attrs_to_payload(attrs);
        let obj = result.as_object().unwrap();

        // Flat attr preserved
        assert_eq!(
            obj.get("gen_ai.response.body").and_then(|v| v.as_str()),
            Some("Hello, I am an AI assistant.")
        );

        // Nested part.text
        let part = obj.get("part").and_then(|v| v.as_object()).unwrap();
        assert_eq!(
            part.get("text").and_then(|v| v.as_str()),
            Some("Hello, I am an AI assistant.")
        );

        // No info object (no request body or prompt)
        assert!(obj.get("info").is_none());
    }

    #[test]
    fn ac_2_otlp_attrs_to_payload_maps_request_body() {
        let mut attrs = Map::new();
        attrs.insert(
            "gen_ai.request.body".to_string(),
            json!("What is the capital of France?"),
        );
        attrs.insert("gen_ai.conversation.id".to_string(), json!("conv-3"));

        let result = OpenCodeAdapter::otlp_attrs_to_payload(attrs);
        let obj = result.as_object().unwrap();

        // Nested info.text from request body
        let info = obj.get("info").and_then(|v| v.as_object()).unwrap();
        assert_eq!(
            info.get("text").and_then(|v| v.as_str()),
            Some("What is the capital of France?")
        );

        // No part object (no response body)
        assert!(obj.get("part").is_none());
    }

    #[test]
    fn ac_2_otlp_attrs_to_payload_falls_back_to_prompt() {
        let mut attrs = Map::new();
        // No gen_ai.request.body, but gen_ai.prompt is present
        attrs.insert("gen_ai.prompt".to_string(), json!("Write a poem."));
        attrs.insert("gen_ai.conversation.id".to_string(), json!("conv-4"));

        let result = OpenCodeAdapter::otlp_attrs_to_payload(attrs);
        let obj = result.as_object().unwrap();

        // Nested info.text from prompt fallback
        let info = obj.get("info").and_then(|v| v.as_object()).unwrap();
        assert_eq!(
            info.get("text").and_then(|v| v.as_str()),
            Some("Write a poem.")
        );
    }

    #[test]
    fn ac_2_otlp_attrs_to_payload_request_body_preferred_over_prompt() {
        let mut attrs = Map::new();
        // Both present — request.body should win
        attrs.insert(
            "gen_ai.request.body".to_string(),
            json!("Preferred request"),
        );
        attrs.insert("gen_ai.prompt".to_string(), json!("Fallback prompt"));
        attrs.insert("gen_ai.conversation.id".to_string(), json!("conv-5"));

        let result = OpenCodeAdapter::otlp_attrs_to_payload(attrs);
        let obj = result.as_object().unwrap();

        let info = obj.get("info").and_then(|v| v.as_object()).unwrap();
        assert_eq!(
            info.get("text").and_then(|v| v.as_str()),
            Some("Preferred request")
        );
    }

    #[test]
    fn ac_2_otlp_attrs_to_payload_maps_model() {
        let mut attrs = Map::new();
        attrs.insert("gen_ai.response.model".to_string(), json!("gpt-4o"));
        attrs.insert("gen_ai.conversation.id".to_string(), json!("conv-6"));

        let result = OpenCodeAdapter::otlp_attrs_to_payload(attrs);
        let obj = result.as_object().unwrap();

        let info = obj.get("info").and_then(|v| v.as_object()).unwrap();
        assert_eq!(info.get("modelID").and_then(|v| v.as_str()), Some("gpt-4o"));
    }

    #[test]
    fn ac_2_otlp_attrs_to_payload_empty_attrs() {
        let attrs = Map::new();
        let result = OpenCodeAdapter::otlp_attrs_to_payload(attrs);
        let obj = result.as_object().unwrap();

        // Empty payload — no info, no part, no flat attrs
        assert!(obj.is_empty());
    }

    #[test]
    fn ac_2_otlp_span_transform_produces_nested_payload() {
        let adapter = OpenCodeAdapter::new();
        let payload = serde_json::json!({
            "resourceSpans": [{
                "resource": { "attributes": [] },
                "scopeSpans": [{
                    "spans": [{
                        "name": "chat",
                        "traceId": "trace-ac2",
                        "attributes": [
                            { "key": "gen_ai.operation.name", "value": { "stringValue": "chat" } },
                            { "key": "gen_ai.conversation.id", "value": { "stringValue": "conv-ac2" } },
                            { "key": "gen_ai.usage.input_tokens", "value": { "intValue": "150" } },
                            { "key": "gen_ai.usage.output_tokens", "value": { "intValue": "300" } },
                            { "key": "gen_ai.response.body", "value": { "stringValue": "The capital of France is Paris." } },
                            { "key": "gen_ai.request.body", "value": { "stringValue": "What is the capital of France?" } },
                            { "key": "gen_ai.response.model", "value": { "stringValue": "claude-3-opus" } }
                        ]
                    }]
                }]
            }]
        });

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(adapter.transform(Transport::OtlpGrpc, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        assert_eq!(events.len(), 1);

        let p = events[0].payload.as_ref().unwrap().as_object().unwrap();

        // Flat attrs preserved
        assert_eq!(
            p.get("gen_ai.usage.input_tokens").and_then(|v| v.as_i64()),
            Some(150)
        );
        assert_eq!(
            p.get("gen_ai.usage.output_tokens").and_then(|v| v.as_i64()),
            Some(300)
        );
        assert_eq!(
            p.get("gen_ai.response.body").and_then(|v| v.as_str()),
            Some("The capital of France is Paris.")
        );

        // Nested info
        let info = p.get("info").and_then(|v| v.as_object()).unwrap();
        assert_eq!(
            info.get("turnInputTokens").and_then(|v| v.as_i64()),
            Some(150)
        );
        assert_eq!(
            info.get("turnOutputTokens").and_then(|v| v.as_i64()),
            Some(300)
        );
        assert_eq!(
            info.get("text").and_then(|v| v.as_str()),
            Some("What is the capital of France?")
        );
        assert_eq!(
            info.get("modelID").and_then(|v| v.as_str()),
            Some("claude-3-opus")
        );

        // Nested part
        let part = p.get("part").and_then(|v| v.as_object()).unwrap();
        assert_eq!(
            part.get("text").and_then(|v| v.as_str()),
            Some("The capital of France is Paris.")
        );
    }

    #[test]
    fn ac_2_otlp_span_transform_execute_tool_preserves_flat_payload() {
        let adapter = OpenCodeAdapter::new();
        let payload = serde_json::json!({
            "resourceSpans": [{
                "resource": { "attributes": [] },
                "scopeSpans": [{
                    "spans": [{
                        "name": "execute_tool",
                        "traceId": "trace-tool",
                        "attributes": [
                            { "key": "gen_ai.operation.name", "value": { "stringValue": "execute_tool" } },
                            { "key": "gen_ai.conversation.id", "value": { "stringValue": "conv-tool" } },
                            { "key": "tool.name", "value": { "stringValue": "Bash" } },
                            { "key": "tool.result", "value": { "stringValue": "stdout output" } }
                        ]
                    }]
                }]
            }]
        });

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(adapter.transform(Transport::OtlpGrpc, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, EventType::ToolUse);

        let p = events[0].payload.as_ref().unwrap().as_object().unwrap();

        // Tool-specific flat attrs preserved
        assert_eq!(p.get("tool.name").and_then(|v| v.as_str()), Some("Bash"));
        assert_eq!(
            p.get("tool.result").and_then(|v| v.as_str()),
            Some("stdout output")
        );

        // No info or part (no gen_ai.* fields to map)
        assert!(
            p.get("info").is_none()
                || p.get("info")
                    .and_then(|v| v.as_object())
                    .map(|o| o.is_empty())
                    .unwrap_or(true)
        );
        assert!(
            p.get("part").is_none()
                || p.get("part")
                    .and_then(|v| v.as_object())
                    .map(|o| o.is_empty())
                    .unwrap_or(true)
        );
    }

    // ——— AC-8 (REQ-3): OTLP chat span generates per-turn correlationId after Hook bridging ———
    //
    // When a Hook event stores a correlationId first and the turn counter is initialized,
    // subsequent OTLP Init events should generate a unique per-turn correlationId
    // (e.g., sess-ac8_1) instead of reusing the Hook-stored correlationId.
    // This ensures multi-turn conversations produce multiple ChatNodes, not just one.

    #[test]
    fn ac_8_otlp_uses_hook_stored_correlation_id() {
        let adapter = OpenCodeAdapter::new();
        let rt = tokio::runtime::Runtime::new().unwrap();

        // Step 1: Send a Hook Chat event (UserPromptSubmit) with messageID.
        // This stores (sessionId → correlationId) via REQ-3 bridging AND
        // initializes the turn counter (Bug 2 fix — ensures per-turn correlationIds).
        let hook_payload = serde_json::json!({
            "event_type": "UserPromptSubmit",
            "properties": {
                "sessionID": "sess-ac8",
                "messageID": "hook-correlation-abc"
            }
        });
        let hook_result = rt.block_on(adapter.transform(Transport::Hook, hook_payload));
        assert!(hook_result.is_ok());
        let hook_events = hook_result.unwrap();
        assert_eq!(hook_events.len(), 1);
        assert_eq!(hook_events[0].correlation_id, Some("hook-correlation-abc".into()));

        // Step 2: Send an OTLP chat span for the same session.
        // The session_id from Hook events is "sess-ac8".
        // For OTLP, gen_ai.conversation.id is "sess-ac8" to match.
        let otlp_payload = serde_json::json!({
            "resourceSpans": [{
                "resource": { "attributes": [] },
                "scopeSpans": [{
                    "spans": [{
                        "name": "chat",
                        "traceId": "otlp-trace-xyz",
                        "attributes": [
                            { "key": "gen_ai.operation.name", "value": { "stringValue": "chat" } },
                            { "key": "gen_ai.conversation.id", "value": { "stringValue": "sess-ac8" } }
                        ]
                    }]
                }]
            }]
        });
        let otlp_result = rt.block_on(adapter.transform(Transport::OtlpGrpc, otlp_payload));
        assert!(otlp_result.is_ok());
        let otlp_events = otlp_result.unwrap();
        assert_eq!(otlp_events.len(), 1);
        assert_eq!(otlp_events[0].event_type, EventType::Chat);

        // Bug 2 fix: When Hook-stored correlationId exists AND turn counter is
        // initialized, OTLP Init events generate per-turn correlationIds instead
        // of reusing the Hook-stored ID. This ensures multi-turn conversations
        // produce multiple ChatNodes.
        assert_eq!(
            otlp_events[0].correlation_id,
            Some("sess-ac8_1".into()),
            "OTLP Init should generate per-turn correlationId when turn counter is initialized"
        );
    }

    // ——— REQ-1: OTLP uses session_id as correlationId when no Hook mapping exists ———

    #[test]
    fn ac_8_otlp_uses_session_id_without_hook_mapping() {
        let adapter = OpenCodeAdapter::new();
        let rt = tokio::runtime::Runtime::new().unwrap();

        // Send an OTLP chat span for a session that has no prior Hook event.
        // Should use session_id (from gen_ai.conversation.id) as correlationId.
        let otlp_payload = serde_json::json!({
            "resourceSpans": [{
                "resource": { "attributes": [] },
                "scopeSpans": [{
                    "spans": [{
                        "name": "chat",
                        "traceId": "fallback-trace-789",
                        "attributes": [
                            { "key": "gen_ai.operation.name", "value": { "stringValue": "chat" } },
                            { "key": "gen_ai.conversation.id", "value": { "stringValue": "sess-no-hook" } }
                        ]
                    }]
                }]
            }]
        });
        let result = rt.block_on(adapter.transform(Transport::OtlpGrpc, otlp_payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        assert_eq!(events.len(), 1);
        // REQ-639 (REQ-2): Pure-OTLP Init generates unique per-turn correlationId
        assert_eq!(
            events[0].correlation_id,
            Some("sess-no-hook_1".into()),
            "Pure-OTLP Init should generate unique per-turn correlationId"
        );
    }

    // ——— Spec #523: Relationship metadata emission tests ———

    #[test]
    fn post_tool_use_task_emits_relationship_metadata() {
        let adapter = OpenCodeAdapter::new();
        let rt = tokio::runtime::Runtime::new().unwrap();

        // PostToolUse `task` event with tool_response.metadata containing
        // sessionId (child) and parentSessionId (parent).
        let payload = serde_json::json!({
            "event_type": "PostToolUse",
            "tool_name": "task",
            "tool_response": {
                "metadata": {
                    "sessionId": "child-ses-rel",
                    "parentSessionId": "parent-ses-rel"
                },
                "result": "Subagent completed successfully"
            },
            "properties": {
                "sessionID": "parent-ses-rel"
            }
        });

        let result = rt.block_on(adapter.transform(Transport::Hook, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        assert_eq!(events.len(), 1);

        // Event should be emitted normally as a ToolUse/Response
        assert_eq!(events[0].event_type, EventType::ToolUse);
        assert_eq!(events[0].state, EventState::Response);
        assert_eq!(events[0].tool_name.as_deref(), Some("task"));

        // Session ID should be the parent's session (PostToolUse fires on parent ses)
        assert_eq!(events[0].session_id, "parent-ses-rel");

        // Verify relationship metadata is attached
        let metadata = events[0].metadata.as_ref().expect("metadata should exist");
        let rel = metadata.get("relationship").expect("relationship key should exist");
        assert_eq!(rel.get("type").and_then(|v| v.as_str()), Some("parent-child"));
        assert_eq!(
            rel.get("parentSessionId").and_then(|v| v.as_str()),
            Some("parent-ses-rel")
        );
        assert_eq!(
            rel.get("childSessionId").and_then(|v| v.as_str()),
            Some("child-ses-rel")
        );
    }

    #[test]
    fn post_tool_use_task_without_metadata_no_relationship() {
        let adapter = OpenCodeAdapter::new();
        let rt = tokio::runtime::Runtime::new().unwrap();

        // PostToolUse `task` event WITHOUT tool_response.metadata fields
        let payload = serde_json::json!({
            "event_type": "PostToolUse",
            "tool_name": "task",
            "tool_response": {
                "result": "Task completed"
            },
            "properties": {
                "sessionID": "sess-no-rel"
            }
        });

        let result = rt.block_on(adapter.transform(Transport::Hook, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        assert_eq!(events.len(), 1);

        // Event should be emitted normally
        assert_eq!(events[0].event_type, EventType::ToolUse);
        assert_eq!(events[0].tool_name.as_deref(), Some("task"));

        // No relationship metadata
        assert!(
            events[0].metadata.is_none(),
            "PostToolUse task without parentSessionId should not have relationship metadata"
        );
    }

    #[test]
    fn post_tool_use_non_task_no_relationship_metadata() {
        let adapter = OpenCodeAdapter::new();
        let rt = tokio::runtime::Runtime::new().unwrap();

        // PostToolUse for a non-task tool (e.g. Bash) — no relationship metadata
        let payload = serde_json::json!({
            "event_type": "PostToolUse",
            "tool_name": "Bash",
            "tool_response": {
                "stdout": "output"
            },
            "tool_use_id": "tool-bash",
            "properties": {
                "sessionID": "sess-bash"
            }
        });

        let result = rt.block_on(adapter.transform(Transport::Hook, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        assert_eq!(events.len(), 1);

        // Event should be emitted normally
        assert_eq!(events[0].event_type, EventType::ToolUse);
        assert_eq!(events[0].tool_name.as_deref(), Some("Bash"));

        // No relationship metadata (not a "task" tool)
        assert!(
            events[0].metadata.is_none(),
            "PostToolUse non-task should not have relationship metadata"
        );
    }

    #[test]
    fn normal_events_no_rewrite() {
        let adapter = OpenCodeAdapter::new();
        let rt = tokio::runtime::Runtime::new().unwrap();

        // Normal event — sessionId should pass through unchanged
        let payload = serde_json::json!({
            "event_type": "session.updated",
            "properties": {
                "sessionID": "normal-session",
                "info": { "id": "normal-session" }
            }
        });

        let result = rt.block_on(adapter.transform(Transport::Hook, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        assert_eq!(events.len(), 1);

        // Session ID unchanged (no rewriting)
        assert_eq!(events[0].session_id, "normal-session");
        assert_eq!(events[0].event_type, EventType::AgentSession);

        // No metadata
        assert!(events[0].metadata.is_none());
    }

    #[test]
    fn adapter_fields_count() {
        // Verify the adapter struct has the correct number of fields.
        // OpenCodeAdapter has 7 Arc<Mutex<HashMap>> fields after Spec #633 AC-6c:
        // trace_to_session, session_to_correlation, tool_call_id,
        // session_to_parent, session_turn_counter, pending_task_instructions,
        // parent_prompts
        let adapter = OpenCodeAdapter::new();
        let _ = adapter; // suppress unused warning
        assert_eq!(
            std::mem::size_of::<OpenCodeAdapter>(),
            std::mem::size_of::<(
                Arc<Mutex<HashMap<String, String>>>,
                Arc<Mutex<HashMap<String, String>>>,
                Arc<Mutex<HashMap<(String, String), String>>>,
                Arc<Mutex<HashMap<String, String>>>,
                Arc<Mutex<HashMap<String, u64>>>,
                Arc<Mutex<HashMap<String, String>>>,
                Arc<Mutex<HashMap<String, String>>>,
            )>(),
            "OpenCodeAdapter should have exactly 7 fields (parent_prompts added for Spec #633 AC-6c REQ-1)"
        );
    }

    // ——— Spec #523: Session.Updated Relationship Detection tests ———

    #[test]
    fn session_updated_with_parent_id_and_whitelisted_agent_emits_relationship_metadata() {
        let adapter = OpenCodeAdapter::new();
        let rt = tokio::runtime::Runtime::new().unwrap();

        // session.updated event with properties.info.parentID and a whitelisted
        // agent name (general) — real opencode emits this for @-subagent dispatches.
        let payload = serde_json::json!({
            "event_type": "session.updated",
            "properties": {
                "info": {
                    "id": "child-session",
                    "parentID": "parent-session",
                    "agent": "general"
                }
            }
        });

        let result = rt.block_on(adapter.transform(Transport::Hook, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        assert_eq!(events.len(), 1);

        // Event should be emitted as AgentSession/Update
        assert_eq!(events[0].event_type, EventType::AgentSession);
        assert_eq!(events[0].state, EventState::Update);
        assert_eq!(events[0].session_id, "child-session");

        // Verify relationship metadata is attached
        let metadata = events[0].metadata.as_ref().expect("metadata should exist");
        let rel = metadata.get("relationship").expect("relationship key should exist");
        assert_eq!(rel.get("type").and_then(|v| v.as_str()), Some("parent-child"));
        assert_eq!(
            rel.get("parentSessionId").and_then(|v| v.as_str()),
            Some("parent-session")
        );
        assert_eq!(
            rel.get("childSessionId").and_then(|v| v.as_str()),
            Some("child-session")
        );
    }

    #[test]
    fn session_updated_with_parent_id_non_whitelisted_agent_no_relationship() {
        let adapter = OpenCodeAdapter::new();
        let rt = tokio::runtime::Runtime::new().unwrap();

        // session.updated with parentID but a non-whitelisted agent (build).
        // Internal tool-execution agents should NOT create relationships.
        let payload = serde_json::json!({
            "event_type": "session.updated",
            "properties": {
                "info": {
                    "id": "child-build",
                    "parentID": "parent-build",
                    "agent": "build"
                }
            }
        });

        let result = rt.block_on(adapter.transform(Transport::Hook, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        assert_eq!(events.len(), 1);

        // Event should be emitted normally
        assert_eq!(events[0].event_type, EventType::AgentSession);
        assert_eq!(events[0].session_id, "child-build");

        // No relationship metadata (non-whitelisted agent)
        assert!(
            events[0].metadata.is_none(),
            "Non-whitelisted agent (build) should not produce relationship metadata"
        );
    }

    #[test]
    fn session_updated_without_parent_id_no_relationship() {
        let adapter = OpenCodeAdapter::new();
        let rt = tokio::runtime::Runtime::new().unwrap();

        // session.updated without parentID — no parent-child relationship
        let payload = serde_json::json!({
            "event_type": "session.updated",
            "properties": {
                "info": {
                    "id": "standalone-session",
                    "agent": "general"
                }
            }
        });

        let result = rt.block_on(adapter.transform(Transport::Hook, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        assert_eq!(events.len(), 1);

        // Session ID unchanged
        assert_eq!(events[0].session_id, "standalone-session");

        // No relationship metadata (no parentID)
        assert!(
            events[0].metadata.is_none(),
            "session.updated without parentID should not produce relationship metadata"
        );
    }

    #[test]
    fn session_updated_self_referencing_parent_id_no_relationship() {
        let adapter = OpenCodeAdapter::new();
        let rt = tokio::runtime::Runtime::new().unwrap();

        // session.updated where parentID equals the session's own ID.
        // This should NOT produce a self-referencing relationship.
        let payload = serde_json::json!({
            "event_type": "session.updated",
            "properties": {
                "info": {
                    "id": "same-id",
                    "parentID": "same-id",
                    "agent": "general"
                }
            }
        });

        let result = rt.block_on(adapter.transform(Transport::Hook, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        assert_eq!(events.len(), 1);

        // Session ID unchanged
        assert_eq!(events[0].session_id, "same-id");

        // No relationship metadata (self-referencing is skipped)
        assert!(
            events[0].metadata.is_none(),
            "Self-referencing parentID should not produce relationship metadata"
        );
    }

    #[test]
    fn session_updated_all_whitelisted_agents_emit_relationship() {
        let adapter = OpenCodeAdapter::new();
        let rt = tokio::runtime::Runtime::new().unwrap();

        // Test that every whitelisted agent name produces relationship metadata
        for agent in WHITELIST_SUBAGENT_NAMES.iter() {
            let payload = serde_json::json!({
                "event_type": "session.updated",
                "properties": {
                    "info": {
                        "id": format!("child-{}", agent),
                        "parentID": "parent-multi",
                        "agent": *agent
                    }
                }
            });

            let result = rt.block_on(adapter.transform(Transport::Hook, payload));
            assert!(
                result.is_ok(),
                "session.updated with whitelisted agent '{}' should succeed",
                agent
            );
            let events = result.unwrap();
            assert_eq!(events.len(), 1);

            let metadata = events[0].metadata.as_ref().expect(
                &format!("Whitelisted agent '{}' should produce relationship metadata", agent)
            );
            let rel = metadata.get("relationship").expect("relationship key should exist");
            assert_eq!(rel.get("type").and_then(|v| v.as_str()), Some("parent-child"));
        }
    }

    #[test]
    fn post_tool_use_task_without_parent_session_id_falls_back_to_event_session() {
        let adapter = OpenCodeAdapter::new();
        let rt = tokio::runtime::Runtime::new().unwrap();

        // PostToolUse `task` with sessionId but NO parentSessionId —
        // real opencode only emits sessionId. The adapter should fall back
        // to using the event's own session_id (from properties.sessionID)
        // as the parent, since PostToolUse fires in the parent session context.
        let payload = serde_json::json!({
            "event_type": "PostToolUse",
            "tool_name": "task",
            "tool_response": {
                "metadata": {
                    "sessionId": "child-only"
                    // no parentSessionId — real opencode doesn't emit this field
                },
                "result": "partial"
            },
            "properties": {
                "sessionID": "parent-partial"
            }
        });

        let result = rt.block_on(adapter.transform(Transport::Hook, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        assert_eq!(events.len(), 1);

        // Should emit relationship metadata with parentSessionId
        // derived from the event's own session ID (fallback).
        let metadata = events[0].metadata.as_ref().expect(
            "PostToolUse task with only sessionId should still emit relationship metadata"
        );
        let rel = metadata.get("relationship").expect("relationship key should exist");
        assert_eq!(rel.get("type").and_then(|v| v.as_str()), Some("parent-child"));
        assert_eq!(
            rel.get("parentSessionId").and_then(|v| v.as_str()),
            Some("parent-partial"),
            "parentSessionId should fall back to event's session_id"
        );
        assert_eq!(
            rel.get("childSessionId").and_then(|v| v.as_str()),
            Some("child-only"),
            "childSessionId should come from metadata.sessionId"
        );
    }

    #[test]
    fn post_tool_use_task_empty_chid_session_id_no_relationship() {
        let adapter = OpenCodeAdapter::new();
        let rt = tokio::runtime::Runtime::new().unwrap();

        // PostToolUse `task` with empty sessionId — should not emit relationship
        let payload = serde_json::json!({
            "event_type": "PostToolUse",
            "tool_name": "task",
            "tool_response": {
                "metadata": {
                    "sessionId": ""
                    // empty child sessionId
                },
                "result": "partial"
            },
            "properties": {
                "sessionID": "parent-empty"
            }
        });

        let result = rt.block_on(adapter.transform(Transport::Hook, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        assert_eq!(events.len(), 1);

        // No relationship metadata (empty child sessionId)
        assert!(
            events[0].metadata.is_none(),
            "PostToolUse task with empty sessionId should not produce relationship metadata"
        );
    }

    #[test]
    fn post_tool_use_task_self_referencing_session_no_relationship() {
        let adapter = OpenCodeAdapter::new();
        let rt = tokio::runtime::Runtime::new().unwrap();

        // PostToolUse `task` where child sessionId equals parent (self-referencing).
        // This could happen if the tool's metadata.sessionId is the same as the
        // parent session — should NOT register a relationship.
        let payload = serde_json::json!({
            "event_type": "PostToolUse",
            "tool_name": "task",
            "tool_response": {
                "metadata": {
                    "sessionId": "same-session"
                    // same as parent's session ID
                },
                "result": "partial"
            },
            "properties": {
                "sessionID": "same-session"
            }
        });

        let result = rt.block_on(adapter.transform(Transport::Hook, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        assert_eq!(events.len(), 1);

        // No relationship metadata (self-referencing)
        assert!(
            events[0].metadata.is_none(),
            "PostToolUse task with self-referencing session should not produce relationship metadata"
        );
    }

    // ——— Phase 1: Payload Normalization Tests ———

    #[test]
    fn normalize_agent_payload_adds_typed_fields() {
        let adapter = OpenCodeAdapter::new();
        let raw = serde_json::json!({
            "event_type": "chat.message",
            "properties": {
                "info": {
                    "agent": "general",
                    "modelID": "claude-4",
                    "text": "Hello, user!"
                },
                "part": {
                    "text": "I am an AI assistant.",
                    "reasoning": "Thinking step by step..."
                }
            },
            "output": {
                "message": {
                    "role": "user"
                },
                "parts": [{"text": "User prompt here", "type": "text"}]
            }
        });

        let result = adapter.normalize_agent_payload(&raw, "test-session", "test-corr-1");
        let obj = result.as_object().unwrap();

        // Check normalized fields exist
        assert_eq!(obj.get("userMessage").and_then(|v| v.as_str()), Some("User prompt here"));
        assert_eq!(obj.get("agentReply").and_then(|v| v.as_str()), Some("I am an AI assistant."));
        assert_eq!(obj.get("agentThinking").and_then(|v| v.as_str()), Some("Thinking step by step..."));
        assert_eq!(obj.get("agent").and_then(|v| v.as_str()), Some("general"));
        assert_eq!(obj.get("model").and_then(|v| v.as_str()), Some("claude-4"));
        assert_eq!(obj.get("correlationId").and_then(|v| v.as_str()), Some("test-corr-1"));
        assert_eq!(obj.get("sessionId").and_then(|v| v.as_str()), Some("test-session"));

        // Prompt/completion tokens default to 0
        assert_eq!(obj.get("promptTokens").and_then(|v| v.as_i64()), Some(0));
        assert_eq!(obj.get("completionTokens").and_then(|v| v.as_i64()), Some(0));

        // Raw structure preserved (backward compat)
        assert!(obj.get("event_type").and_then(|v| v.as_str()).is_some());
        assert!(obj.get("properties").is_some());
    }

    #[test]
    fn normalize_agent_payload_extracts_reply_from_various_paths() {
        let adapter = OpenCodeAdapter::new();

        // Test properties.part.text path
        let raw = serde_json::json!({
            "properties": { "part": { "text": "Reply from part" } }
        });
        let result = adapter.normalize_agent_payload(&raw, "s1", "c1");
        assert_eq!(result.get("agentReply").and_then(|v| v.as_str()), Some("Reply from part"));

        // Test properties.text path
        let raw = serde_json::json!({
            "properties": { "text": "Reply from props" }
        });
        let result = adapter.normalize_agent_payload(&raw, "s1", "c1");
        assert_eq!(result.get("agentReply").and_then(|v| v.as_str()), Some("Reply from props"));

        // Test part.text path (inner extraction)
        let raw = serde_json::json!({
            "part": { "text": "Reply from inner part" }
        });
        let result = adapter.normalize_agent_payload(&raw, "s1", "c1");
        assert_eq!(result.get("agentReply").and_then(|v| v.as_str()), Some("Reply from inner part"));

        // Test bare text with type=text
        let raw = serde_json::json!({
            "type": "text",
            "text": "Bare text reply"
        });
        let result = adapter.normalize_agent_payload(&raw, "s1", "c1");
        assert_eq!(result.get("agentReply").and_then(|v| v.as_str()), Some("Bare text reply"));

        // FIX-586 V3: Test delta extraction (message.part.delta from deepseek)
        let raw = serde_json::json!({
            "delta": "deepseek streaming delta",
            "field": "text",
            "messageID": "msg_1",
            "partID": "prt_1",
            "sessionID": "ses_1"
        });
        let result = adapter.normalize_agent_payload(&raw, "s1", "c1");
        assert_eq!(result.get("agentReply").and_then(|v| v.as_str()), Some("deepseek streaming delta"));
    }

    #[test]
    fn normalize_agent_payload_does_not_insert_empty_scalars() {
        let adapter = OpenCodeAdapter::new();

        // A session.status or session.updated event with no user message paths
        // (no output.parts, no properties.text, no info.text, etc.).
        // Empty userMessage/agentReply/agentThinking must NOT be inserted —
        // they would overwrite Init-time data during ECE deep-merge.
        let raw = serde_json::json!({
            "event_type": "session.status",
            "properties": {
                "info": { "status": "running" }
            }
        });

        let result = adapter.normalize_agent_payload(&raw, "test-session", "test-corr-3");
        let obj = result.as_object().unwrap();

        // Empty scalars must NOT be present in the payload
        assert!(
            !obj.contains_key("userMessage"),
            "userMessage must not be present when extraction returned empty string"
        );
        assert!(
            !obj.contains_key("agentReply"),
            "agentReply must not be present when extraction returned empty string"
        );
        assert!(
            !obj.contains_key("agentThinking"),
            "agentThinking must not be present when extraction returned empty string"
        );

        // Optional fields (agent, model) that resolved to None must also be absent
        assert!(
            !obj.contains_key("agent"),
            "agent must not be present when extraction returned None"
        );
        assert!(
            !obj.contains_key("model"),
            "model must not be present when extraction returned None"
        );

        // Non-guarded fields must still be present
        assert_eq!(obj.get("promptTokens").and_then(|v| v.as_i64()), Some(0));
        assert_eq!(obj.get("completionTokens").and_then(|v| v.as_i64()), Some(0));
        assert_eq!(obj.get("correlationId").and_then(|v| v.as_str()), Some("test-corr-3"));
        assert_eq!(obj.get("sessionId").and_then(|v| v.as_str()), Some("test-session"));

        // Raw structure preserved
        assert!(obj.get("event_type").and_then(|v| v.as_str()).is_some());
    }

    #[test]
    fn normalize_tool_payload_adds_typed_fields() {
        let adapter = OpenCodeAdapter::new();
        let raw = serde_json::json!({
            "tool_name": "Bash",
            "tool_input": { "command": "ls -la" },
            "tool_response": { "stdout": "file1\nfile2\n" }
        });

        let result = adapter.normalize_tool_payload(&raw, "test-session", "test-corr-2");
        let obj = result.as_object().unwrap();

        assert_eq!(obj.get("toolName").and_then(|v| v.as_str()), Some("Bash"));
        assert_eq!(
            obj.get("input").and_then(|v| v.get("command")).and_then(|v| v.as_str()),
            Some("ls -la")
        );
        assert_eq!(
            obj.get("output").and_then(|v| v.get("stdout")).and_then(|v| v.as_str()),
            Some("file1\nfile2\n")
        );
        assert_eq!(obj.get("parentCorrelationId").and_then(|v| v.as_str()), Some(""));
        assert_eq!(obj.get("correlationId").and_then(|v| v.as_str()), Some("test-corr-2"));
        assert_eq!(obj.get("sessionId").and_then(|v| v.as_str()), Some("test-session"));
    }

    #[test]
    fn normalize_tool_payload_includes_files_for_file_tools() {
        let adapter = OpenCodeAdapter::new();

        // Write tool with file_path
        let raw = serde_json::json!({
            "tool_name": "Write",
            "tool_input": { "file_path": "/tmp/test.ts", "content": "console.log('hi')" }
        });
        let result = adapter.normalize_tool_payload(&raw, "s1", "c1");
        let files = result.get("files").and_then(|v| v.as_array());
        assert!(files.is_some(), "Write tool should have files array");
        let files = files.unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].get("filePath").and_then(|v| v.as_str()), Some("/tmp/test.ts"));
        assert_eq!(files[0].get("operation").and_then(|v| v.as_str()), Some("write"));

        // Read tool with file_path
        let raw = serde_json::json!({
            "tool_name": "Read",
            "tool_input": { "file_path": "/tmp/readme.md" }
        });
        let result = adapter.normalize_tool_payload(&raw, "s1", "c1");
        let files = result.get("files").and_then(|v| v.as_array()).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].get("operation").and_then(|v| v.as_str()), Some("read"));

        // Non-file tool — no files array
        let raw = serde_json::json!({
            "tool_name": "Bash",
            "tool_input": { "command": "ls" }
        });
        let result = adapter.normalize_tool_payload(&raw, "s1", "c1");
        assert!(result.get("files").is_none(), "Bash without file path should not have files array");
    }

    #[test]
    fn extract_typed_tokens_from_all_known_paths() {
        // Test 1: properties.info.tokens.{input,output} (real opencode)
        let raw = serde_json::json!({
            "properties": {
                "info": {
                    "tokens": { "input": 42, "output": 128 }
                }
            }
        });
        let (prompt, completion) = OpenCodeAdapter::extract_typed_tokens(&raw);
        assert_eq!(prompt, 42);
        assert_eq!(completion, 128);

        // Test 2: properties.info.turnInputTokens / turnOutputTokens (Hook)
        let raw = serde_json::json!({
            "properties": {
                "info": { "turnInputTokens": 150, "turnOutputTokens": 300 }
            }
        });
        let (prompt, completion) = OpenCodeAdapter::extract_typed_tokens(&raw);
        assert_eq!(prompt, 150);
        assert_eq!(completion, 300);

        // Test 3: info.tokens.{input,output} (inner payload)
        let raw = serde_json::json!({
            "info": {
                "tokens": { "input": 7, "output": 14 }
            }
        });
        let (prompt, completion) = OpenCodeAdapter::extract_typed_tokens(&raw);
        assert_eq!(prompt, 7);
        assert_eq!(completion, 14);

        // Test 4: top-level turnInputTokens / turnOutputTokens
        let raw = serde_json::json!({
            "turnInputTokens": 99,
            "turnOutputTokens": 199
        });
        let (prompt, completion) = OpenCodeAdapter::extract_typed_tokens(&raw);
        assert_eq!(prompt, 99);
        assert_eq!(completion, 199);

        // Test 5: Tokens as strings (parseable)
        let raw = serde_json::json!({
            "properties": {
                "info": {
                    "tokens": { "input": "50", "output": "75" }
                }
            }
        });
        let (prompt, completion) = OpenCodeAdapter::extract_typed_tokens(&raw);
        assert_eq!(prompt, 50);
        assert_eq!(completion, 75);

        // Test 6: Missing tokens default to 0
        let raw = serde_json::json!({});
        let (prompt, completion) = OpenCodeAdapter::extract_typed_tokens(&raw);
        assert_eq!(prompt, 0);
        assert_eq!(completion, 0);

        // Test 7: Only input tokens (no output)
        let raw = serde_json::json!({
            "properties": {
                "info": { "turnInputTokens": 200 }
            }
        });
        let (prompt, completion) = OpenCodeAdapter::extract_typed_tokens(&raw);
        assert_eq!(prompt, 200);
        assert_eq!(completion, 0);
    }

    #[test]
    fn extract_files_detects_file_operations() {
        // Write with file_path
        let raw = serde_json::json!({
            "tool_name": "Write",
            "tool_input": { "file_path": "/tmp/test.ts" }
        });
        let files = OpenCodeAdapter::extract_files(&raw);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].get("filePath").and_then(|v| v.as_str()), Some("/tmp/test.ts"));
        assert_eq!(files[0].get("operation").and_then(|v| v.as_str()), Some("write"));

        // Read with path
        let raw = serde_json::json!({
            "tool_name": "Read",
            "tool_input": { "path": "/tmp/readme.md" }
        });
        let files = OpenCodeAdapter::extract_files(&raw);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].get("operation").and_then(|v| v.as_str()), Some("read"));

        // Edit with file_path
        let raw = serde_json::json!({
            "tool_name": "Edit",
            "tool_input": { "file_path": "/tmp/edit.ts" }
        });
        let files = OpenCodeAdapter::extract_files(&raw);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].get("operation").and_then(|v| v.as_str()), Some("write"));

        // Bash with tool_response.path (file output)
        let raw = serde_json::json!({
            "tool_name": "Bash",
            "tool_response": { "path": "/tmp/output.txt" }
        });
        let files = OpenCodeAdapter::extract_files(&raw);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].get("filePath").and_then(|v| v.as_str()), Some("/tmp/output.txt"));

        // No file operation
        let raw = serde_json::json!({ "tool_name": "Bash" });
        let files = OpenCodeAdapter::extract_files(&raw);
        assert!(files.is_empty());

        // No tool_name
        let raw = serde_json::json!({});
        let files = OpenCodeAdapter::extract_files(&raw);
        assert!(files.is_empty());
    }

    #[test]
    fn resolve_parent_correlation_id_from_map() {
        let adapter = OpenCodeAdapter::new();
        let rt = tokio::runtime::Runtime::new().unwrap();

        // First, store a correlationId for a session
        rt.block_on(adapter.transform(Transport::Hook, serde_json::json!({
            "event_type": "UserPromptSubmit",
            "properties": {
                "sessionID": "parent-session",
                "messageID": "parent-corr-123"
            }
        }))).unwrap();

        // Now resolve the parent's correlationId
        let resolved = adapter.resolve_parent_correlation_id("parent-session");
        assert_eq!(resolved, Some("parent-corr-123".to_string()));

        // Non-existent session returns None
        let resolved = adapter.resolve_parent_correlation_id("non-existent");
        assert_eq!(resolved, None);
    }

    #[test]
    fn unrecognized_event_type_produces_custom_event() {
        let adapter = OpenCodeAdapter::new();
        let rt = tokio::runtime::Runtime::new().unwrap();

        // Send a completely unknown event type with session_id
        let payload = serde_json::json!({
            "event_type": "completely.unknown.event",
            "properties": {
                "sessionID": "test-session-unknown"
            },
            "some_data": "value"
        });

        let result = rt.block_on(adapter.transform(Transport::Hook, payload));
        assert!(result.is_ok());
        let events = result.unwrap();

        // Should produce exactly 1 event (not empty!)
        assert_eq!(events.len(), 1, "Unrecognized event types must produce exactly 1 Custom event");

        // Should be EventType::Custom
        assert_eq!(events[0].event_type, EventType::Custom);
        assert_eq!(events[0].state, EventState::Init);
        assert_eq!(events[0].session_id, "test-session-unknown");

        // Raw data should be in payload (backward compat)
        let payload_obj = events[0].payload.as_ref().unwrap();
        assert_eq!(
            payload_obj.get("event_type").and_then(|v| v.as_str()),
            Some("completely.unknown.event")
        );
    }

    #[test]
    fn event_without_session_id_produces_custom_event() {
        let adapter = OpenCodeAdapter::new();
        let rt = tokio::runtime::Runtime::new().unwrap();

        // Event with no sessionID at any path
        let payload = serde_json::json!({
            "event_type": "some.event",
            "data": "no session context"
        });

        let result = rt.block_on(adapter.transform(Transport::Hook, payload));
        assert!(result.is_ok());
        let events = result.unwrap();

        // Should produce a Custom event (not silently dropped)
        assert_eq!(events.len(), 1, "Events without session_id must produce a Custom event");
        assert_eq!(events[0].event_type, EventType::Custom);
        // tool_name should reflect the event_type from the payload when available
        assert_eq!(events[0].tool_name.as_deref(), Some("some.event"));
    }

    #[test]
    fn event_without_session_id_and_without_event_type_produces_custom_event() {
        let adapter = OpenCodeAdapter::new();
        let rt = tokio::runtime::Runtime::new().unwrap();

        // Event with no sessionID and no event_type field
        let payload = serde_json::json!({
            "data": "orphan data"
        });

        let result = rt.block_on(adapter.transform(Transport::Hook, payload));
        assert!(result.is_ok());
        let events = result.unwrap();

        // Should produce a Custom event with fallback tool_name
        assert_eq!(events.len(), 1, "Events without session_id or event_type must produce a Custom event");
        assert_eq!(events[0].event_type, EventType::Custom);
        assert_eq!(events[0].tool_name.as_deref(), Some("no-session-id"));
    }

    #[test]
    fn normalized_fields_present_alongside_raw_structure() {
        let adapter = OpenCodeAdapter::new();
        let rt = tokio::runtime::Runtime::new().unwrap();

        // PreToolUse — should have both raw tool_input AND normalized fields
        let payload = serde_json::json!({
            "event_type": "PreToolUse",
            "tool_name": "Bash",
            "tool_input": { "command": "ls" },
            "tool_use_id": "tool-1",
            "properties": { "sessionID": "sess-backward" }
        });

        let result = rt.block_on(adapter.transform(Transport::Hook, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        assert_eq!(events.len(), 1);

        let p = events[0].payload.as_ref().unwrap().as_object().unwrap();

        // Raw structure preserved
        assert!(p.get("tool_name").is_some(), "Raw tool_name must be preserved");
        assert!(p.get("tool_input").is_some(), "Raw tool_input must be preserved");
        assert!(p.get("tool_use_id").is_some(), "Raw tool_use_id must be preserved");
        assert!(p.get("properties").is_some(), "Raw properties must be preserved");
        assert!(p.get("event_type").is_some(), "Raw event_type must be preserved");

        // Normalized fields added alongside raw
        assert_eq!(p.get("toolName").and_then(|v| v.as_str()), Some("Bash"));
        assert_eq!(p.get("correlationId").and_then(|v| v.as_str()), Some("tool-1"));
        assert!(p.get("sessionId").is_some());
        assert!(p.get("input").is_some());
        assert!(p.get("output").is_some());
        assert!(p.get("parentCorrelationId").is_some());
    }

    #[test]
    fn custom_permission_events_have_typed_fields() {
        // Test permission.asked normalization
        let raw = serde_json::json!({
            "properties": {
                "tool_name": "Bash",
                "scope": "/tmp"
            }
        });
        let result = OpenCodeAdapter::normalize_custom_payload(&raw, "permission.asked");
        let obj = result.as_object().unwrap();
        assert_eq!(obj.get("toolName").and_then(|v| v.as_str()), Some("Bash"));
        assert_eq!(obj.get("scope").and_then(|v| v.as_str()), Some("/tmp"));

        // Test file.edited normalization
        let raw = serde_json::json!({
            "properties": {
                "path": "/tmp/file.ts"
            }
        });
        let result = OpenCodeAdapter::normalize_custom_payload(&raw, "file.edited");
        let obj = result.as_object().unwrap();
        assert_eq!(obj.get("filePath").and_then(|v| v.as_str()), Some("/tmp/file.ts"));
        assert_eq!(obj.get("operation").and_then(|v| v.as_str()), Some("edited"));

        // Test command.executed normalization
        let raw = serde_json::json!({
            "properties": {
                "command": "ls -la",
                "exitCode": 0
            }
        });
        let result = OpenCodeAdapter::normalize_custom_payload(&raw, "command.executed");
        let obj = result.as_object().unwrap();
        assert_eq!(obj.get("command").and_then(|v| v.as_str()), Some("ls -la"));
        assert_eq!(obj.get("exitCode").and_then(|v| v.as_i64()), Some(0));
    }

    #[test]
    fn chat_event_normalized_payload_through_transform() {
        let adapter = OpenCodeAdapter::new();
        let rt = tokio::runtime::Runtime::new().unwrap();

        // Send a chat.message event through the full transform pipeline
        let payload = serde_json::json!({
            "event_type": "chat.message",
            "properties": {
                "sessionID": "sess-chat-norm",
                "messageID": "msg-norm-1",
                "info": {
                    "agent": "coder",
                    "modelID": "gpt-4o",
                    "tokens": { "input": 100, "output": 50 }
                },
                "text": "Here is my solution."
            },
            "output": {
                "message": {
                    "role": "user"
                },
                "parts": [{"text": "Write a function to sort an array.", "type": "text"}]
            }
        });

        let result = rt.block_on(adapter.transform(Transport::Hook, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, EventType::Chat);

        let p = events[0].payload.as_ref().unwrap().as_object().unwrap();

        // Normalized fields present
        assert_eq!(p.get("userMessage").and_then(|v| v.as_str()), Some("Write a function to sort an array."));
        assert_eq!(p.get("agentReply").and_then(|v| v.as_str()), Some("Here is my solution."));
        assert_eq!(p.get("agent").and_then(|v| v.as_str()), Some("coder"));
        assert_eq!(p.get("model").and_then(|v| v.as_str()), Some("gpt-4o"));
        assert_eq!(p.get("promptTokens").and_then(|v| v.as_i64()), Some(100));
        assert_eq!(p.get("completionTokens").and_then(|v| v.as_i64()), Some(50));
        assert_eq!(p.get("correlationId").and_then(|v| v.as_str()), Some("msg-norm-1"));
        assert_eq!(p.get("sessionId").and_then(|v| v.as_str()), Some("sess-chat-norm"));

        // Raw structure preserved
        assert!(p.get("output").is_some());
        assert!(p.get("properties").is_some());
        assert!(p.get("event_type").is_some());
    }

    #[test]
    fn tool_event_normalized_payload_through_transform() {
        let adapter = OpenCodeAdapter::new();
        let rt = tokio::runtime::Runtime::new().unwrap();

        // Send a PostToolUse for a Write tool through the full pipeline
        let payload = serde_json::json!({
            "event_type": "PostToolUse",
            "tool_name": "Write",
            "tool_input": { "file_path": "/tmp/newfile.ts", "content": "export const x = 1;" },
            "tool_response": { "path": "/tmp/newfile.ts", "success": true },
            "tool_use_id": "write-call-1",
            "properties": { "sessionID": "sess-tool-norm" }
        });

        let result = rt.block_on(adapter.transform(Transport::Hook, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, EventType::ToolUse);

        let p = events[0].payload.as_ref().unwrap().as_object().unwrap();

        // Normalized fields
        assert_eq!(p.get("toolName").and_then(|v| v.as_str()), Some("Write"));
        assert_eq!(p.get("sessionId").and_then(|v| v.as_str()), Some("sess-tool-norm"));

        // Files array present for Write tool
        let files = p.get("files").and_then(|v| v.as_array()).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].get("filePath").and_then(|v| v.as_str()), Some("/tmp/newfile.ts"));

        // Raw structure preserved
        assert!(p.get("tool_name").is_some());
        assert!(p.get("tool_input").is_some());
        assert!(p.get("tool_response").is_some());
    }

    #[test]
    fn subagent_payload_normalized_correctly() {
        let adapter = OpenCodeAdapter::new();

        // Test normalize_subagent_payload directly
        let raw = serde_json::json!({
            "properties": {
                "info": {
                    "agent": "general",
                    "instruction": "Help the user with their task"
                }
            },
            "tool_response": {
                "result": "Task completed successfully",
                "metadata": {
                    "sessionId": "child-session",
                    "agentName": "general"
                }
            },
            "tool_input": {
                "task": "Solve the problem"
            }
        });

        let result = adapter.normalize_subagent_payload(
            &raw, "child-session", "child-corr", "parent-session"
        );
        let obj = result.as_object().unwrap();

        assert_eq!(obj.get("name").and_then(|v| v.as_str()), Some("general"));
        assert_eq!(obj.get("instruction").and_then(|v| v.as_str()), Some("Solve the problem"));
        assert_eq!(obj.get("output").and_then(|v| v.as_str()), Some("Task completed successfully"));
        assert_eq!(obj.get("parentCorrelationId").and_then(|v| v.as_str()), Some("parent-session"));
        assert_eq!(obj.get("correlationId").and_then(|v| v.as_str()), Some("child-corr"));
        assert_eq!(obj.get("sessionId").and_then(|v| v.as_str()), Some("child-session"));
    }

    #[test]
    fn pre_tool_use_failure_has_normalized_fields() {
        let adapter = OpenCodeAdapter::new();
        let rt = tokio::runtime::Runtime::new().unwrap();

        let payload = serde_json::json!({
            "tool_name": "Bash",
            "error": "Command not found",
            "tool_use_id": "fail-1",
            "properties": { "sessionID": "sess-fail" }
        });

        let result = rt.block_on(adapter.transform(Transport::Hook, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, EventType::ToolUse);
        assert_eq!(events[0].state, EventState::Error);

        // Verify normalized fields in payload
        let p = events[0].payload.as_ref().unwrap().as_object().unwrap();
        assert_eq!(p.get("toolName").and_then(|v| v.as_str()), Some("Bash"));
        assert_eq!(p.get("correlationId").and_then(|v| v.as_str()), Some("fail-1"));
        assert_eq!(p.get("sessionId").and_then(|v| v.as_str()), Some("sess-fail"));
    }

    // ——— Spec #582: CorrelationId sharing tests ———

    #[test]
    fn agent_session_reuses_chat_correlation_id() {
        // Verify an AgentSession event reuses a correlationId previously stored
        // by a Chat event for the same session (Chat arrives first).
        let adapter = OpenCodeAdapter::new();
        let rt = tokio::runtime::Runtime::new().unwrap();

        // First transform a Chat event to store a correlationId in the map
        let chat_payload = serde_json::json!({
            "event_type": "chat.message",
            "properties": {
                "sessionID": "shared-session",
                "messageID": "chat-msg-1"
            },
            "output": {
                "message": {
                    "role": "user"
                },
                "parts": [{"text": "Hello from user", "type": "text"}]
            }
        });
        let chat_result = rt.block_on(adapter.transform(Transport::Hook, chat_payload));
        assert!(chat_result.is_ok());
        let chat_events = chat_result.unwrap();
        assert_eq!(chat_events.len(), 1);
        assert_eq!(chat_events[0].event_type, EventType::Chat);

        let chat_cid = chat_events[0].correlation_id.clone();

        // Then transform an AgentSession event for the same session
        let session_payload = serde_json::json!({
            "event_type": "session.created",
            "properties": {
                "sessionID": "shared-session"
            }
        });
        let session_result = rt.block_on(adapter.transform(Transport::Hook, session_payload));
        assert!(session_result.is_ok());
        let session_events = session_result.unwrap();
        assert_eq!(session_events.len(), 1);
        assert_eq!(session_events[0].event_type, EventType::AgentSession);

        // AgentSession should have the same correlationId as the Chat event
        assert_eq!(session_events[0].correlation_id, chat_cid);
    }

    #[test]
    fn chat_reuses_agent_session_correlation_id() {
        // Verify a Chat event reuses a correlationId previously stored
        // by an AgentSession event for the same session (AgentSession arrives first).
        let adapter = OpenCodeAdapter::new();
        let rt = tokio::runtime::Runtime::new().unwrap();

        // First transform an AgentSession event to store session_id as correlationId
        let session_payload = serde_json::json!({
            "event_type": "session.created",
            "properties": {
                "sessionID": "shared-session-2"
            }
        });
        let session_result = rt.block_on(adapter.transform(Transport::Hook, session_payload));
        assert!(session_result.is_ok());
        let session_events = session_result.unwrap();
        assert_eq!(session_events.len(), 1);
        assert_eq!(session_events[0].event_type, EventType::AgentSession);

        // AgentSession stores its session_id as correlationId
        let session_cid = session_events[0].correlation_id.clone();
        assert_eq!(session_cid, Some("shared-session-2".to_string()));

        // Then transform a Chat event for the same session
        let chat_payload = serde_json::json!({
            "event_type": "chat.message",
            "properties": {
                "sessionID": "shared-session-2",
                "messageID": "chat-msg-2"
            },
            "output": {
                "message": {
                    "role": "user"
                },
                "parts": [{"text": "Hello again", "type": "text"}]
            }
        });
        let chat_result = rt.block_on(adapter.transform(Transport::Hook, chat_payload));
        assert!(chat_result.is_ok());
        let chat_events = chat_result.unwrap();
        assert_eq!(chat_events.len(), 1);
        assert_eq!(chat_events[0].event_type, EventType::Chat);

        // Chat should reuse the AgentSession-stored correlationId (session_id)
        assert_eq!(chat_events[0].correlation_id, session_cid);
    }

    // ——— Spec #593: Session Updated Output Detection ———

    #[test]
    fn session_updated_with_output_emits_response_state() {
        let adapter = OpenCodeAdapter::new();
        let rt = tokio::runtime::Runtime::new().unwrap();

        // session.updated with properties.output containing agent response
        let payload = serde_json::json!({
            "event_type": "session.updated",
            "properties": {
                "sessionID": "test-session-1",
                "info": { "id": "test-session-1" },
                "output": {
                    "message": {
                        "parts": [{"text": "Actual agent response"}]
                    }
                }
            }
        });

        let result = rt.block_on(adapter.transform(Transport::Hook, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, EventType::AgentSession);
        // REQ-1: With properties.output → EventState::Response
        assert_eq!(events[0].state, EventState::Response);
        assert_eq!(events[0].session_id, "test-session-1");
    }

    #[test]
    fn session_updated_without_output_emits_update() {
        let adapter = OpenCodeAdapter::new();
        let rt = tokio::runtime::Runtime::new().unwrap();

        // session.updated WITHOUT properties.output — intermediate thinking update
        let payload = serde_json::json!({
            "event_type": "session.updated",
            "properties": {
                "sessionID": "test-session-2",
                "info": {
                    "id": "test-session-2",
                    "agent": "general"
                }
            }
        });

        let result = rt.block_on(adapter.transform(Transport::Hook, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, EventType::AgentSession);
        // REQ-5: Without properties.output → EventState::Update (backward compat)
        assert_eq!(events[0].state, EventState::Update);
        assert_eq!(events[0].session_id, "test-session-2");
    }

    // ——— Spec #593: Agent Reply Extraction Priority ———

    #[test]
    fn agent_reply_from_properties_output_before_part_text() {
        let adapter = OpenCodeAdapter::new();

        // Payload with BOTH properties.output.message.parts[0].text (actual response)
        // AND properties.part.text (thinking text). The output path must win.
        let raw = serde_json::json!({
            "properties": {
                "output": {
                    "message": {
                        "parts": [{"text": "actual response"}]
                    }
                },
                "part": {
                    "text": "thinking text"
                }
            }
        });

        let result = adapter.normalize_agent_payload(&raw, "test-session", "test-corr");
        let obj = result.as_object().unwrap();
        // REQ-2: agentReply should come from properties.output.message.parts[0].text,
        // NOT from properties.part.text (thinking text is lower priority)
        assert_eq!(
            obj.get("agentReply").and_then(|v| v.as_str()),
            Some("actual response")
        );
    }

    // ——— Spec #593: User Message Title Protection ———

    #[test]
    fn user_message_does_not_use_title_fallback() {
        let adapter = OpenCodeAdapter::new();

        // Payload with ONLY properties.info.title (session title) — no other
        // userMessage paths. With the title fallback removed, userMessage must be empty.
        let raw = serde_json::json!({
            "properties": {
                "info": {
                    "title": "New session - 2026-07-15T02:19:05.645Z"
                }
            }
        });

        let result = adapter.normalize_agent_payload(&raw, "test-session", "test-corr");
        let obj = result.as_object().unwrap();
        // REQ-3: Session titles are NOT user messages — key must be absent,
        // not present with empty string (which would overwrite Init-time data
        // during ECE deep-merge, per Bug #593).
        assert!(
            obj.get("userMessage").is_none(),
            "userMessage must not be present — session titles are not user messages"
        );
    }

    // ——— Spec #593 E2E Recovery: Multi-Part Output (DeepSeek Reasoning) ———

    #[test]
    fn find_text_part_type_text_before_thinking() {
        // When parts array has thinking before text, find_text_part
        // must return the text-type part, not the thinking part.
        let parts = vec![
            serde_json::json!({"text": "reasoning here...", "type": "thinking"}),
            serde_json::json!({"text": "actual response", "type": "text"}),
        ];
        let result = OpenCodeAdapter::find_text_part(&parts);
        assert_eq!(result, Some("actual response"));
    }

    #[test]
    fn find_text_part_all_thinking_no_text() {
        // When all parts are thinking type, fall back to first part with text
        // (backward compat).
        let parts = vec![
            serde_json::json!({"text": "reasoning only", "type": "thinking"}),
        ];
        let result = OpenCodeAdapter::find_text_part(&parts);
        assert_eq!(result, Some("reasoning only"));
    }

    #[test]
    fn find_text_part_no_type_field() {
        // When parts have no type field, accept the first part with text
        // But when a later part has type="text", prefer that (first pass wins)
        let parts = vec![
            serde_json::json!({"text": "plain text without type"}),
            serde_json::json!({"text": "second", "type": "text"}),
        ];
        let result = OpenCodeAdapter::find_text_part(&parts);
        // First pass: finds type="text" → returns "second"
        assert_eq!(result, Some("second"));
    }

    #[test]
    fn find_text_part_fallback_when_no_text_type() {
        // When NO parts have type="text", fall back to first part with text
        let parts = vec![
            serde_json::json!({"text": "no type at all"}),
            serde_json::json!({"text": "also no type"}),
        ];
        let result = OpenCodeAdapter::find_text_part(&parts);
        assert_eq!(result, Some("no type at all"));
    }

    #[test]
    fn extract_output_parts_text_skips_thinking() {
        let adapter = OpenCodeAdapter::new();
        // chat.message structure with thinking before text in output.parts
        let raw = serde_json::json!({
            "output": {
                "message": {"role": "assistant"},
                "parts": [
                    {"text": "deepseek reasoning", "type": "thinking"},
                    {"text": "actual agent response", "type": "text"}
                ]
            }
        });
        let result = adapter.normalize_agent_payload(&raw, "sess", "corr");
        let obj = result.as_object().unwrap();
        // agentReply must come from the text-type part, not the thinking part
        assert_eq!(
            obj.get("agentReply").and_then(|v| v.as_str()),
            Some("actual agent response")
        );
    }

    #[test]
    fn extract_properties_output_parts_text_skips_thinking() {
        let adapter = OpenCodeAdapter::new();
        // session.updated structure with thinking before text
        let raw = serde_json::json!({
            "properties": {
                "output": {
                    "message": {
                        "role": "assistant",
                        "parts": [
                            {"text": "deepseek reasoning text here", "type": "thinking"},
                            {"text": "e2e-1038fd26 — the actual response", "type": "text"}
                        ]
                    }
                },
                "info": {
                    "tokens": {"input": 81, "output": 110}
                }
            }
        });
        let result = adapter.normalize_agent_payload(&raw, "sess", "corr");
        let obj = result.as_object().unwrap();
        // agentReply must be the text-type part, not the thinking part
        assert_eq!(
            obj.get("agentReply").and_then(|v| v.as_str()),
            Some("e2e-1038fd26 — the actual response")
        );
        // Token counts should still be extracted
        assert_eq!(
            obj.get("promptTokens").and_then(|v| v.as_i64()),
            Some(81)
        );
        assert_eq!(
            obj.get("completionTokens").and_then(|v| v.as_i64()),
            Some(110)
        );
    }

    #[test]
    fn extract_properties_output_parts_falls_back_to_direct_parts() {
        let adapter = OpenCodeAdapter::new();
        // session.updated structure WITHOUT message wrapper (output.parts directly)
        let raw = serde_json::json!({
            "properties": {
                "output": {
                    "parts": [
                        {"text": "thinking", "type": "thinking"},
                        {"text": "direct response", "type": "text"}
                    ]
                }
            }
        });
        let result = adapter.normalize_agent_payload(&raw, "sess", "corr");
        let obj = result.as_object().unwrap();
        // Should fall back to properties.output.parts (no message wrapper)
        assert_eq!(
            obj.get("agentReply").and_then(|v| v.as_str()),
            Some("direct response")
        );
    }

    // ——— Spec #593 E2E Recovery: UserMessage Role Guards ———

    #[test]
    fn user_message_skips_assistant_output_from_properties() {
        let adapter = OpenCodeAdapter::new();
        // session.updated event with assistant output — must NOT overwrite userMessage
        let raw = serde_json::json!({
            "properties": {
                "output": {
                    "message": {
                        "role": "assistant",
                        "parts": [
                            {"text": "the agent's response text", "type": "text"}
                        ]
                    }
                }
            }
        });
        let result = adapter.normalize_agent_payload(&raw, "sess", "corr");
        let obj = result.as_object().unwrap();
        // userMessage must be absent (assistant output should not become userMessage;
        // empty string must not be inserted to avoid overwriting Init-time data)
        assert!(
            obj.get("userMessage").is_none(),
            "userMessage must not be present — assistant output is not a user message"
        );
        // agentReply still gets the output correctly
        assert_eq!(
            obj.get("agentReply").and_then(|v| v.as_str()),
            Some("the agent's response text")
        );
    }

    #[test]
    fn user_message_skips_assistant_output_without_explicit_role() {
        let adapter = OpenCodeAdapter::new();
        // session.updated event with output but no explicit role field
        // (role is absent from message — should still skip since output is
        // from an agent, not a user)
        let raw = serde_json::json!({
            "properties": {
                "output": {
                    "message": {
                        "parts": [
                            {"text": "agent output without role", "type": "text"}
                        ]
                    }
                }
            }
        });
        let result = adapter.normalize_agent_payload(&raw, "sess", "corr");
        let obj = result.as_object().unwrap();
        // userMessage must be absent — no explicit role means it's not user content;
        // empty string must not be inserted to avoid overwriting Init-time data
        assert!(
            obj.get("userMessage").is_none(),
            "userMessage must not be present — no explicit role means not user content"
        );
    }

    // ——— Spec #601 / REQ-10: Span name normalisation tests ———

    #[test]
    fn req_10_normalize_op_name_fredo_session() {
        // fredo.session → "session"
        let result = OpenCodeAdapter::normalize_op_name("fredo.session");
        assert_eq!(result, Some("session".to_string()));
    }

    #[test]
    fn req_10_normalize_op_name_fredo_llm() {
        // fredo.llm → "chat"
        let result = OpenCodeAdapter::normalize_op_name("fredo.llm");
        assert_eq!(result, Some("chat".to_string()));
    }

    #[test]
    fn req_10_normalize_op_name_fredo_tool_bash() {
        // fredo.tool.Bash → "tool.Bash"
        let result = OpenCodeAdapter::normalize_op_name("fredo.tool.Bash");
        assert_eq!(result, Some("tool.Bash".to_string()));
    }

    #[test]
    fn req_10_normalize_op_name_fredo_tool_task() {
        // fredo.tool.task → "tool.task"
        let result = OpenCodeAdapter::normalize_op_name("fredo.tool.task");
        assert_eq!(result, Some("tool.task".to_string()));
    }

    #[test]
    fn req_10_normalize_op_name_fredo_tool_read() {
        // fredo.tool.Read → "tool.Read"
        let result = OpenCodeAdapter::normalize_op_name("fredo.tool.Read");
        assert_eq!(result, Some("tool.Read".to_string()));
    }

    #[test]
    fn req_10_normalize_op_name_unknown_span_dropped() {
        // unknown.span → None
        let result = OpenCodeAdapter::normalize_op_name("unknown.span");
        assert_eq!(result, None);
    }

    #[test]
    fn req_10_normalize_op_name_legacy_chat_preserved() {
        // Legacy chat → still works
        let result = OpenCodeAdapter::normalize_op_name("chat");
        assert_eq!(result, Some("chat".to_string()));
    }

    #[test]
    fn req_10_normalize_op_name_legacy_execute_tool_preserved() {
        // Legacy execute_tool → still works
        let result = OpenCodeAdapter::normalize_op_name("execute_tool");
        assert_eq!(result, Some("execute_tool".to_string()));
    }

    #[test]
    fn req_10_normalize_op_name_legacy_invoke_agent_preserved() {
        // Legacy invoke_agent → still works
        let result = OpenCodeAdapter::normalize_op_name("invoke_agent");
        assert_eq!(result, Some("invoke_agent".to_string()));
    }

    #[test]
    fn req_10_normalize_op_name_fredo_session_with_suffix() {
        // fredo.session with a suffix (e.g. fredo.session.idle)
        let result = OpenCodeAdapter::normalize_op_name("fredo.session.idle");
        // Currently only exact fredo.session match, so this should be None
        // (fredo.session.idle is a sub-span that carries other identifying attrs)
        // We match exact fredo.session or fredo.session with space suffix
        assert_eq!(result, None);
    }

    #[test]
    fn req_10_normalize_op_name_with_fallback_span_type() {
        // span name unrecognised but span.type attribute provides fallback
        let mut attrs = Map::new();
        attrs.insert(CC_ATTR_SPAN_TYPE.to_string(), json!("chat"));
        let result = OpenCodeAdapter::normalize_op_name_with_fallback("custom.span", &attrs);
        assert_eq!(result, Some("chat".to_string()));
    }

    #[test]
    fn req_10_normalize_op_name_with_fallback_span_type_unknown() {
        // span name unrecognised AND span.type doesn't help → None
        let mut attrs = Map::new();
        attrs.insert(CC_ATTR_SPAN_TYPE.to_string(), json!("custom.type"));
        let result = OpenCodeAdapter::normalize_op_name_with_fallback("weird.name", &attrs);
        assert_eq!(result, None);
    }

    #[test]
    fn req_10_normalize_op_name_with_fallback_no_span_type() {
        // span name unrecognised, no span.type attribute → None
        let attrs = Map::new();
        let result = OpenCodeAdapter::normalize_op_name_with_fallback("foo.bar", &attrs);
        assert_eq!(result, None);
    }

    // ——— Spec #601 / REQ-11: EventState from span timing tests ———

    #[test]
    fn req_11_event_state_response_when_end_time_present() {
        // Span with endTimeUnixNano → EventState::Response
        let mut span = Map::new();
        span.insert("endTimeUnixNano".to_string(), json!("123456789"));
        let state = OpenCodeAdapter::req_11_event_state_from_span(&Value::Object(span));
        assert_eq!(state, EventState::Response);
    }

    #[test]
    fn req_11_event_state_init_when_no_end_time() {
        // Span without endTimeUnixNano → EventState::Init
        let span = Map::new();
        let state = OpenCodeAdapter::req_11_event_state_from_span(&Value::Object(span));
        assert_eq!(state, EventState::Init);
    }

    #[test]
    fn req_11_event_state_from_otlp_span_with_end_time() {
        // Full OTLP span transform: fredo.llm with endTimeUnixNano → Chat/Response
        let adapter = OpenCodeAdapter::new();
        let payload = serde_json::json!({
            "resourceSpans": [{
                "resource": { "attributes": [] },
                "scopeSpans": [{
                    "spans": [{
                        "name": "fredo.llm",
                        "traceId": "trace-req11-a",
                        "endTimeUnixNano": "987654321",
                        "attributes": [
                            { "key": "session.id", "value": { "stringValue": "sess-req11-a" } }
                        ]
                    }]
                }]
            }]
        });

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(adapter.transform(Transport::OtlpGrpc, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        // REQ-11 fix: completed spans emit both Init + Response
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].event_type, EventType::Chat);
        assert_eq!(events[0].state, EventState::Init);
        assert_eq!(events[1].event_type, EventType::Chat);
        assert_eq!(events[1].state, EventState::Response);
    }

    #[test]
    fn req_11_event_state_from_otlp_span_without_end_time() {
        // Full OTLP span transform: fredo.llm without endTimeUnixNano → Chat/Init
        let adapter = OpenCodeAdapter::new();
        let payload = serde_json::json!({
            "resourceSpans": [{
                "resource": { "attributes": [] },
                "scopeSpans": [{
                    "spans": [{
                        "name": "fredo.llm",
                        "traceId": "trace-req11-b",
                        "attributes": [
                            { "key": "session.id", "value": { "stringValue": "sess-req11-b" } }
                        ]
                    }]
                }]
            }]
        });

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(adapter.transform(Transport::OtlpGrpc, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, EventType::Chat);
        assert_eq!(events[0].state, EventState::Init);
    }

    #[test]
    fn req_11_event_state_fredo_session_with_end_time() {
        // fredo.session with endTimeUnixNano → AgentSession/Response
        let adapter = OpenCodeAdapter::new();
        let payload = serde_json::json!({
            "resourceSpans": [{
                "resource": { "attributes": [] },
                "scopeSpans": [{
                    "spans": [{
                        "name": "fredo.session",
                        "traceId": "trace-sess-end",
                        "endTimeUnixNano": "55555",
                        "attributes": [
                            { "key": "session.id", "value": { "stringValue": "sess-end" } }
                        ]
                    }]
                }]
            }]
        });

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(adapter.transform(Transport::OtlpGrpc, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        // REQ-609 (REQ-1): Session spans emit exactly ONE Init event (no Response).
        // Even with endTimeUnixNano present, session events must NOT complete the ECE buffer.
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, EventType::AgentSession);
        assert_eq!(events[0].state, EventState::Init);
    }

    #[test]
    fn req_11_event_state_fredo_session_without_end_time() {
        // fredo.session without endTimeUnixNano → AgentSession/Init
        let adapter = OpenCodeAdapter::new();
        let payload = serde_json::json!({
            "resourceSpans": [{
                "resource": { "attributes": [] },
                "scopeSpans": [{
                    "spans": [{
                        "name": "fredo.session",
                        "traceId": "trace-sess-init",
                        "attributes": [
                            { "key": "session.id", "value": { "stringValue": "sess-init" } }
                        ]
                    }]
                }]
            }]
        });

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(adapter.transform(Transport::OtlpGrpc, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, EventType::AgentSession);
        assert_eq!(events[0].state, EventState::Init);
    }

    // ——— Spec #601 / REQ-12: Attribute extraction tests ———

    #[test]
    fn req_12_otlp_attrs_to_payload_claude_code_tokens() {
        // input_tokens/output_tokens → info.turnInputTokens/info.turnOutputTokens
        let mut attrs = Map::new();
        attrs.insert(CC_ATTR_INPUT_TOKENS.to_string(), json!(500));
        attrs.insert(CC_ATTR_OUTPUT_TOKENS.to_string(), json!(200));

        let result = OpenCodeAdapter::otlp_attrs_to_payload(attrs);
        let obj = result.as_object().unwrap();

        let info = obj.get("info").and_then(|v| v.as_object()).unwrap();
        assert_eq!(info.get("turnInputTokens").and_then(|v| v.as_i64()), Some(500));
        assert_eq!(info.get("turnOutputTokens").and_then(|v| v.as_i64()), Some(200));
    }

    #[test]
    fn req_12_otlp_attrs_to_payload_claude_code_model() {
        // model → info.modelID
        let mut attrs = Map::new();
        attrs.insert(CC_ATTR_MODEL.to_string(), json!("claude-sonnet-4-20250514"));

        let result = OpenCodeAdapter::otlp_attrs_to_payload(attrs);
        let obj = result.as_object().unwrap();

        let info = obj.get("info").and_then(|v| v.as_object()).unwrap();
        assert_eq!(
            info.get("modelID").and_then(|v| v.as_str()),
            Some("claude-sonnet-4-20250514")
        );
    }

    #[test]
    fn req_12_otlp_attrs_to_payload_gen_ai_tokens_preferred_over_claude_code() {
        // REQ-7: gen_ai.usage.* tokens preferred over flat Claude Code convention tokens.
        // This was flipped from the Spec #601 preference (CC convention > gen_ai.*).
        let mut attrs = Map::new();
        attrs.insert(CC_ATTR_INPUT_TOKENS.to_string(), json!(999));
        attrs.insert(CC_LEGACY_ATTR_INPUT_TOKENS.to_string(), json!(111));
        attrs.insert(CC_ATTR_OUTPUT_TOKENS.to_string(), json!(888));
        attrs.insert(CC_LEGACY_ATTR_OUTPUT_TOKENS.to_string(), json!(222));

        let result = OpenCodeAdapter::otlp_attrs_to_payload(attrs);
        let obj = result.as_object().unwrap();

        let info = obj.get("info").and_then(|v| v.as_object()).unwrap();
        // REQ-7: gen_ai.usage.* should win over flat convention
        assert_eq!(info.get("turnInputTokens").and_then(|v| v.as_i64()), Some(111));
        assert_eq!(info.get("turnOutputTokens").and_then(|v| v.as_i64()), Some(222));
    }

    #[test]
    fn req_12_otlp_attrs_to_payload_model_preferred_over_gen_ai() {
        // Claude Code model preferred over gen_ai.response.model
        let mut attrs = Map::new();
        attrs.insert(CC_ATTR_MODEL.to_string(), json!("claude-pref"));
        attrs.insert(CC_LEGACY_ATTR_RESPONSE_MODEL.to_string(), json!("gpt-4o"));

        let result = OpenCodeAdapter::otlp_attrs_to_payload(attrs);
        let obj = result.as_object().unwrap();

        let info = obj.get("info").and_then(|v| v.as_object()).unwrap();
        assert_eq!(info.get("modelID").and_then(|v| v.as_str()), Some("claude-pref"));
    }

    #[test]
    fn req_12_otlp_claude_code_attrs_legacy_fallback() {
        // When Claude Code convention attrs absent, fall back to gen_ai.*
        let mut attrs = Map::new();
        attrs.insert(CC_LEGACY_ATTR_INPUT_TOKENS.to_string(), json!(42));
        attrs.insert(CC_LEGACY_ATTR_OUTPUT_TOKENS.to_string(), json!(128));
        attrs.insert(CC_LEGACY_ATTR_RESPONSE_MODEL.to_string(), json!("gpt-4o"));

        let result = OpenCodeAdapter::otlp_attrs_to_payload(attrs);
        let obj = result.as_object().unwrap();

        let info = obj.get("info").and_then(|v| v.as_object()).unwrap();
        assert_eq!(info.get("turnInputTokens").and_then(|v| v.as_i64()), Some(42));
        assert_eq!(info.get("turnOutputTokens").and_then(|v| v.as_i64()), Some(128));
        assert_eq!(info.get("modelID").and_then(|v| v.as_str()), Some("gpt-4o"));
    }

    // ——— Spec #601 / REQ-12: Session id preference tests ———

    #[test]
    fn req_12_session_id_prefers_session_dot_id() {
        // session.id preferred over gen_ai.conversation.id
        let adapter = OpenCodeAdapter::new();
        let payload = serde_json::json!({
            "resourceSpans": [{
                "resource": { "attributes": [] },
                "scopeSpans": [{
                    "spans": [{
                        "name": "fredo.session",
                        "traceId": "trace-sid-pref",
                        "attributes": [
                            { "key": "session.id", "value": { "stringValue": "preferred-sid" } },
                            { "key": "gen_ai.conversation.id", "value": { "stringValue": "fallback-cid" } }
                        ]
                    }]
                }]
            }]
        });

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(adapter.transform(Transport::OtlpGrpc, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].session_id, "preferred-sid");
    }

    #[test]
    fn req_12_session_id_falls_back_to_conversation_id() {
        // When session.id absent, fall back to gen_ai.conversation.id
        let adapter = OpenCodeAdapter::new();
        let payload = serde_json::json!({
            "resourceSpans": [{
                "resource": { "attributes": [] },
                "scopeSpans": [{
                    "spans": [{
                        "name": "fredo.session",
                        "traceId": "trace-cid",
                        "attributes": [
                            { "key": "gen_ai.conversation.id", "value": { "stringValue": "conv-fallback" } }
                        ]
                    }]
                }]
            }]
        });

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(adapter.transform(Transport::OtlpGrpc, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        assert_eq!(events[0].session_id, "conv-fallback");
    }

    // ——— Spec #601 / REQ-10 + REQ-12: Full OTLP span mapping tests ———

    #[test]
    fn req_10_fredo_tool_span_maps_to_tool_use() {
        // fredo.tool.Bash → EventType::ToolUse
        let adapter = OpenCodeAdapter::new();
        let payload = serde_json::json!({
            "resourceSpans": [{
                "resource": { "attributes": [] },
                "scopeSpans": [{
                    "spans": [{
                        "name": "fredo.tool.Bash",
                        "traceId": "trace-tool-bash",
                        "endTimeUnixNano": "123",
                        "attributes": [
                            { "key": "session.id", "value": { "stringValue": "sess-tool" } }
                        ]
                    }]
                }]
            }]
        });

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(adapter.transform(Transport::OtlpGrpc, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].event_type, EventType::ToolUse);
        assert_eq!(events[0].tool_name.as_deref(), Some("Bash"));
        assert_eq!(events[0].state, EventState::Init);
        assert_eq!(events[1].event_type, EventType::ToolUse);
        assert_eq!(events[1].tool_name.as_deref(), Some("Bash"));
        assert_eq!(events[1].state, EventState::Response);
    }

    #[test]
    fn req_10_fredo_tool_span_without_end_time_init() {
        // fredo.tool.Read without endTime → ToolUse/Init
        let adapter = OpenCodeAdapter::new();
        let payload = serde_json::json!({
            "resourceSpans": [{
                "resource": { "attributes": [] },
                "scopeSpans": [{
                    "spans": [{
                        "name": "fredo.tool.Read",
                        "traceId": "trace-tool-read",
                        "attributes": [
                            { "key": "session.id", "value": { "stringValue": "sess-tool-read" } }
                        ]
                    }]
                }]
            }]
        });

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(adapter.transform(Transport::OtlpGrpc, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, EventType::ToolUse);
        assert_eq!(events[0].tool_name.as_deref(), Some("Read"));
        assert_eq!(events[0].state, EventState::Init);
    }

    #[test]
    fn req_10_fredo_session_span_maps_to_agent_session() {
        // fredo.session → EventType::AgentSession
        let adapter = OpenCodeAdapter::new();
        let payload = serde_json::json!({
            "resourceSpans": [{
                "resource": { "attributes": [] },
                "scopeSpans": [{
                    "spans": [{
                        "name": "fredo.session",
                        "traceId": "trace-session",
                        "endTimeUnixNano": "999",
                        "attributes": [
                            { "key": "session.id", "value": { "stringValue": "sess-final" } },
                            { "key": "agent.type", "value": { "stringValue": "opencode" } }
                        ]
                    }]
                }]
            }]
        });

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(adapter.transform(Transport::OtlpGrpc, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        // REQ-609 (REQ-1): Session spans emit exactly ONE Init event.
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, EventType::AgentSession);
        assert_eq!(events[0].session_id, "sess-final");
        assert_eq!(events[0].state, EventState::Init);
    }

    #[test]
    fn req_10_unrecognized_span_dropped_with_debug_log() {
        // Unknown span should be dropped (not produce any events)
        let adapter = OpenCodeAdapter::new();
        let payload = serde_json::json!({
            "resourceSpans": [{
                "resource": { "attributes": [] },
                "scopeSpans": [{
                    "spans": [{
                        "name": "completely.unknown.span",
                        "traceId": "trace-unknown",
                        "attributes": [
                            { "key": "some.attr", "value": { "stringValue": "value" } }
                        ]
                    }]
                }]
            }]
        });

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(adapter.transform(Transport::OtlpGrpc, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        // No events produced — span dropped
        assert_eq!(events.len(), 0);
    }

    // ——— Spec #601: Legacy gen_ai.* path still works alongside fredo.* ———

    #[test]
    fn req_10_legacy_gen_ai_op_name_still_works() {
        // gen_ai.operation.name = "chat" should still produce Chat events
        let adapter = OpenCodeAdapter::new();
        let payload = serde_json::json!({
            "resourceSpans": [{
                "resource": { "attributes": [] },
                "scopeSpans": [{
                    "spans": [{
                        "name": "some.name",
                        "traceId": "trace-legacy-chat",
                        "endTimeUnixNano": "1",
                        "attributes": [
                            { "key": "gen_ai.operation.name", "value": { "stringValue": "chat" } },
                            { "key": "gen_ai.conversation.id", "value": { "stringValue": "legacy-conv" } }
                        ]
                    }]
                }]
            }]
        });

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(adapter.transform(Transport::OtlpGrpc, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].event_type, EventType::Chat);
        assert_eq!(events[0].state, EventState::Init);
        assert_eq!(events[1].event_type, EventType::Chat);
        assert_eq!(events[1].state, EventState::Response);
    }

    // ——— Spec #609 / REQ-1: Session span Init-only tests ———

    #[test]
    fn req_609_fredo_session_flat_json_with_end_time_emits_one_init() {
        // Flat JSON path: fredo.session with endTimeUnixNano emits exactly one Init
        let adapter = OpenCodeAdapter::new();
        let payload = serde_json::json!({
            "name": "fredo.session",
            "traceId": "trace-sess-flat",
            "endTimeUnixNano": "99999",
            "attributes": [
                { "key": "session.id", "value": { "stringValue": "sess-flat-end" } },
                { "key": "model", "value": { "stringValue": "claude-3" } }
            ]
        });

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(adapter.transform(Transport::OtlpGrpc, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        // REQ-609 (REQ-1): Session spans emit exactly ONE Init event, even in flat JSON path
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, EventType::AgentSession);
        assert_eq!(events[0].state, EventState::Init);
        assert_eq!(events[0].session_id, "sess-flat-end");
    }

    // ——— Spec #609 / REQ-2: Canonical field injection tests ———

    #[test]
    fn req_609_otlp_attrs_to_payload_includes_canonical_fields() {
        // otlp_attrs_to_payload should inject userMessage, agentReply, promptTokens,
        // completionTokens, and model at the top level when OTLP attributes are present.
        // Tests with gen_ai.* (legacy) and CC (Claude Code) attribute key conventions.
        // Fallback paths (prompt, response_text) are tested in
        // req_609_otlp_attrs_to_payload_includes_canonical_fields_from_real_plugin_keys.
        let mut attrs = Map::new();
        attrs.insert("gen_ai.request.body".to_string(), json!("What is the weather?"));
        attrs.insert("gen_ai.response.body".to_string(), json!("The weather is sunny."));
        attrs.insert(CC_ATTR_INPUT_TOKENS.to_string(), json!(150));
        attrs.insert(CC_ATTR_OUTPUT_TOKENS.to_string(), json!(75));
        attrs.insert(CC_ATTR_MODEL.to_string(), json!("claude-sonnet-4-20250514"));

        let result = OpenCodeAdapter::otlp_attrs_to_payload(attrs);
        let obj = result.as_object().unwrap();

        // Verify canonical fields at top level
        assert_eq!(
            obj.get("userMessage").and_then(|v| v.as_str()),
            Some("What is the weather?")
        );
        assert_eq!(
            obj.get("agentReply").and_then(|v| v.as_str()),
            Some("The weather is sunny.")
        );
        assert_eq!(obj.get("promptTokens").and_then(|v| v.as_i64()), Some(150));
        assert_eq!(obj.get("completionTokens").and_then(|v| v.as_i64()), Some(75));
        assert_eq!(
            obj.get("model").and_then(|v| v.as_str()),
            Some("claude-sonnet-4-20250514")
        );

        // Also verify nested info/part objects still present (backward compat)
        let info = obj.get("info").and_then(|v| v.as_object()).unwrap();
        assert_eq!(
            info.get("text").and_then(|v| v.as_str()),
            Some("What is the weather?")
        );
        assert_eq!(
            info.get("modelID").and_then(|v| v.as_str()),
            Some("claude-sonnet-4-20250514")
        );
        assert_eq!(info.get("turnInputTokens").and_then(|v| v.as_i64()), Some(150));
        assert_eq!(info.get("turnOutputTokens").and_then(|v| v.as_i64()), Some(75));
        let part = obj.get("part").and_then(|v| v.as_object()).unwrap();
        assert_eq!(
            part.get("text").and_then(|v| v.as_str()),
            Some("The weather is sunny.")
        );
    }

    #[test]
    fn req_609_otlp_attrs_to_payload_canonical_fields_empty_when_attrs_absent() {
        // When no OTLP attributes that map to canonical fields are present,
        // the canonical fields should not be inserted (no empty strings).
        let mut attrs = Map::new();
        attrs.insert("unrelated.attr".to_string(), json!("some_value"));

        let result = OpenCodeAdapter::otlp_attrs_to_payload(attrs);
        let obj = result.as_object().unwrap();

        // No canonical fields should be present when source attributes are absent
        assert!(obj.get("userMessage").is_none());
        assert!(obj.get("agentReply").is_none());
        assert!(obj.get("promptTokens").is_none());
        assert!(obj.get("completionTokens").is_none());
        assert!(obj.get("model").is_none());
    }

    #[test]
    fn req_609_otlp_attrs_to_payload_includes_canonical_fields_from_real_plugin_keys() {
        // REQ-609 (REQ-2): The real OTLP plugin sends `prompt` and `response_text`
        // as top-level attribute keys (not gen_ai.request.body / gen_ai.response.body).
        // The fallback paths must extract userMessage and agentReply from these keys.
        let mut attrs = Map::new();
        attrs.insert("prompt".to_string(), json!("What is the weather?"));
        attrs.insert("response_text".to_string(), json!("The weather is sunny."));
        attrs.insert(CC_ATTR_INPUT_TOKENS.to_string(), json!(150));
        attrs.insert(CC_ATTR_OUTPUT_TOKENS.to_string(), json!(75));
        attrs.insert(CC_ATTR_MODEL.to_string(), json!("claude-sonnet-4-20250514"));

        let result = OpenCodeAdapter::otlp_attrs_to_payload(attrs);
        let obj = result.as_object().unwrap();

        // Verify canonical fields at top level extracted from real plugin keys
        assert_eq!(
            obj.get("userMessage").and_then(|v| v.as_str()),
            Some("What is the weather?")
        );
        assert_eq!(
            obj.get("agentReply").and_then(|v| v.as_str()),
            Some("The weather is sunny.")
        );
        assert_eq!(obj.get("promptTokens").and_then(|v| v.as_i64()), Some(150));
        assert_eq!(obj.get("completionTokens").and_then(|v| v.as_i64()), Some(75));
        assert_eq!(
            obj.get("model").and_then(|v| v.as_str()),
            Some("claude-sonnet-4-20250514")
        );

        // Also verify nested info/part objects still present (backward compat)
        let info = obj.get("info").and_then(|v| v.as_object()).unwrap();
        assert_eq!(
            info.get("text").and_then(|v| v.as_str()),
            Some("What is the weather?")
        );
        assert_eq!(
            info.get("modelID").and_then(|v| v.as_str()),
            Some("claude-sonnet-4-20250514")
        );
        assert_eq!(info.get("turnInputTokens").and_then(|v| v.as_i64()), Some(150));
        assert_eq!(info.get("turnOutputTokens").and_then(|v| v.as_i64()), Some(75));
        let part = obj.get("part").and_then(|v| v.as_object()).unwrap();
        assert_eq!(
            part.get("text").and_then(|v| v.as_str()),
            Some("The weather is sunny.")
        );
    }

    #[test]
    fn req_609_otlp_attrs_to_payload_fallback_priority() {
        // REQ-609 (REQ-2): When both gen_ai.request.body and prompt are present,
        // gen_ai.request.body takes priority. Same for gen_ai.response.body vs response_text.
        let mut attrs = Map::new();
        // Primary and fallback both present — primary should win
        attrs.insert("gen_ai.request.body".to_string(), json!("primary user message"));
        attrs.insert("gen_ai.response.body".to_string(), json!("primary agent reply"));
        attrs.insert("prompt".to_string(), json!("fallback prompt"));
        attrs.insert("response_text".to_string(), json!("fallback response text"));

        let result = OpenCodeAdapter::otlp_attrs_to_payload(attrs);
        let obj = result.as_object().unwrap();

        // Primary paths should win over fallback
        assert_eq!(
            obj.get("userMessage").and_then(|v| v.as_str()),
            Some("primary user message")
        );
        assert_eq!(
            obj.get("agentReply").and_then(|v| v.as_str()),
            Some("primary agent reply")
        );
    }

    #[test]
    fn req_609_otlp_attrs_to_payload_gen_ai_prompt_fallback() {
        // REQ-609 (REQ-2): When gen_ai.request.body is absent but gen_ai.prompt is present,
        // gen_ai.prompt should be used for userMessage (middle priority).
        let mut attrs = Map::new();
        attrs.insert("gen_ai.prompt".to_string(), json!("middle priority prompt"));
        attrs.insert("prompt".to_string(), json!("low priority flat prompt"));

        let result = OpenCodeAdapter::otlp_attrs_to_payload(attrs);
        let obj = result.as_object().unwrap();

        assert_eq!(
            obj.get("userMessage").and_then(|v| v.as_str()),
            Some("middle priority prompt")
        );
    }

    // ——— REQ-1: OTLP Chat event stores session_id in session_to_correlation ———

    #[test]
    fn otlp_chat_stores_session_id_in_correlation_map() {
        let adapter = OpenCodeAdapter::new();
        let payload = serde_json::json!({
            "resourceSpans": [{
                "resource": { "attributes": [] },
                "scopeSpans": [{
                    "spans": [{
                        "name": "chat",
                        "traceId": "trace-1",
                        "attributes": [
                            { "key": "gen_ai.operation.name", "value": { "stringValue": "chat" } },
                            { "key": "gen_ai.conversation.id", "value": { "stringValue": "session-1" } }
                        ]
                    }]
                }]
            }]
        });

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(adapter.transform(Transport::OtlpGrpc, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        // Should emit 1 event (no endTimeUnixNano → Init state, no dual-emit)
        assert_eq!(events.len(), 1);
        // REQ-639 (REQ-2): Pure-OTLP Init generates unique per-turn correlationId
        assert_eq!(events[0].correlation_id, Some("session-1_1".into()));

        // Verify the map now contains session-1 → session-1_1 (per-turn ID)
        let map = adapter.session_to_correlation.lock().unwrap();
        assert_eq!(map.get("session-1"), Some(&"session-1_1".to_string()));
    }

    // ——— REQ-639 (REQ-2): Multi-turn pure-OTLP sessions get unique correlationIds ———

    #[test]
    fn otlp_chat_per_turn_correlation_id_for_multi_turn() {
        let adapter = OpenCodeAdapter::new();
        let rt = tokio::runtime::Runtime::new().unwrap();

        // First Init event: generates "shared-session_1"
        let payload1 = serde_json::json!({
            "resourceSpans": [{
                "resource": { "attributes": [] },
                "scopeSpans": [{
                    "spans": [{
                        "name": "chat",
                        "traceId": "trace-first",
                        "attributes": [
                            { "key": "gen_ai.operation.name", "value": { "stringValue": "chat" } },
                            { "key": "gen_ai.conversation.id", "value": { "stringValue": "shared-session" } }
                        ]
                    }]
                }]
            }]
        });
        let result1 = rt.block_on(adapter.transform(Transport::OtlpGrpc, payload1));
        assert!(result1.is_ok());
        let events1 = result1.unwrap();
        // REQ-639 (REQ-2): Pure-OTLP Init generates unique correlationId per turn
        assert_eq!(events1[0].correlation_id, Some("shared-session_1".into()));

        // Second Init event: same session, different turn — generates "shared-session_2"
        let payload2 = serde_json::json!({
            "resourceSpans": [{
                "resource": { "attributes": [] },
                "scopeSpans": [{
                    "spans": [{
                        "name": "chat",
                        "traceId": "trace-second",
                        "attributes": [
                            { "key": "gen_ai.operation.name", "value": { "stringValue": "chat" } },
                            { "key": "gen_ai.conversation.id", "value": { "stringValue": "shared-session" } }
                        ]
                    }]
                }]
            }]
        });
        let result2 = rt.block_on(adapter.transform(Transport::OtlpGrpc, payload2));
        assert!(result2.is_ok());
        let events2 = result2.unwrap();
        // REQ-639 (REQ-2): Second turn gets a NEW unique correlationId
        assert_eq!(
            events2[0].correlation_id,
            Some("shared-session_2".into()),
            "Second OTLP Init for same session should generate a new per-turn correlationId"
        );

        // Map should have one entry pointing to the most recent ID
        let map = adapter.session_to_correlation.lock().unwrap();
        assert_eq!(map.len(), 1);
        assert_eq!(map.get("shared-session"), Some(&"shared-session_2".to_string()));
    }

    // ——— REQ-3: Init event payload is non-empty when span has attributes ———

    #[test]
    fn otlp_chat_init_event_payload_contains_mapped_attributes() {
        let adapter = OpenCodeAdapter::new();
        // Span with endTimeUnixNano → Response state → dual-emit (Init + Response)
        let payload = serde_json::json!({
            "resourceSpans": [{
                "resource": { "attributes": [] },
                "scopeSpans": [{
                    "spans": [{
                        "name": "chat",
                        "traceId": "trace-init-payload",
                        "endTimeUnixNano": "1000000",
                        "attributes": [
                            { "key": "gen_ai.operation.name", "value": { "stringValue": "chat" } },
                            { "key": "gen_ai.conversation.id", "value": { "stringValue": "session-init-payload" } },
                            { "key": "gen_ai.usage.input_tokens", "value": { "intValue": "50" } },
                            { "key": "gen_ai.usage.output_tokens", "value": { "intValue": "100" } },
                            { "key": "gen_ai.request.body", "value": { "stringValue": "What is Rust?" } },
                            { "key": "gen_ai.response.body", "value": { "stringValue": "Rust is a systems language." } }
                        ]
                    }]
                }]
            }]
        });

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(adapter.transform(Transport::OtlpGrpc, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        // Should emit 2 events: Init + Response
        assert_eq!(events.len(), 2, "Completed span should dual-emit Init + Response");

        // First event is Init
        assert_eq!(events[0].state, EventState::Init);
        let init_payload = events[0].payload.as_ref().unwrap().as_object().unwrap();

        // Init payload should NOT be empty — it contains the mapped attributes
        assert!(!init_payload.is_empty(), "Init payload should not be empty");

        // Verify canonical fields are present in Init payload
        let info = init_payload.get("info").and_then(|v| v.as_object());
        assert!(info.is_some(), "Init payload should have info object");

        // userMessage from gen_ai.request.body
        assert_eq!(
            info.and_then(|i| i.get("text")).and_then(|v| v.as_str()),
            Some("What is Rust?"),
            "Init payload should contain userMessage from request body"
        );

        // Token counts
        assert_eq!(
            info.and_then(|i| i.get("turnInputTokens")).and_then(|v| v.as_i64()),
            Some(50),
            "Init payload should contain input tokens"
        );

        // Second event is Response (payload also populated)
        assert_eq!(events[1].state, EventState::Response);
        let resp_payload = events[1].payload.as_ref().unwrap().as_object().unwrap();
        assert!(!resp_payload.is_empty(), "Response payload should not be empty");
    }

    // ——— REQ-1: Flat/custom JSON path also stores session_id in map ———

    #[test]
    fn otlp_flat_json_stores_session_id_in_correlation_map() {
        let adapter = OpenCodeAdapter::new();
        // Flat/custom JSON format (non-resourceSpans path)
        let payload = serde_json::json!({
            "name": "chat",
            "traceId": "flat-trace",
            "attributes": [
                { "key": "gen_ai.operation.name", "value": { "stringValue": "chat" } },
                { "key": "gen_ai.conversation.id", "value": { "stringValue": "flat-session" } }
            ]
        });

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(adapter.transform(Transport::OtlpGrpc, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        assert_eq!(events.len(), 1);
        // REQ-639 (REQ-2): Pure-OTLP Init generates unique per-turn correlationId
        assert_eq!(events[0].correlation_id, Some("flat-session_1".into()));

        // Verify the map was written with per-turn ID
        let map = adapter.session_to_correlation.lock().unwrap();
        assert_eq!(map.get("flat-session"), Some(&"flat-session_1".to_string()));
    }

    // ——— Spec #615: OTLP plugin parent_session_id attribute + adapter self-population ———

    #[test]
    fn otlp_span_with_session_parent_id_populates_session_to_parent() {
        // An OTLP span with session.parent_id attribute should self-populate
        // the session_to_parent map without needing Hook transport.
        let adapter = OpenCodeAdapter::new();
        let payload = serde_json::json!({
            "resourceSpans": [{
                "resource": { "attributes": [] },
                "scopeSpans": [{
                    "spans": [{
                        "name": "fredo.session",
                        "traceId": "trace-parent-test",
                        "attributes": [
                            { "key": "session.id", "value": { "stringValue": "child-session" } },
                            { "key": "session.parent_id", "value": { "stringValue": "parent-session" } },
                            { "key": "gen_ai.operation.name", "value": { "stringValue": "fredo.session" } }
                        ]
                    }]
                }]
            }]
        });

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(adapter.transform(Transport::OtlpGrpc, payload));
        assert!(result.is_ok());

        // Verify session_to_parent was populated
        let map = adapter.session_to_parent.lock().unwrap();
        assert_eq!(
            map.get("child-session"),
            Some(&"parent-session".to_string()),
            "session_to_parent should be populated from session.parent_id attribute"
        );
    }

    #[test]
    fn otlp_subagent_span_uses_self_populated_session_to_parent_for_relationship() {
        // A subagent span with session.parent_id attribute + is_subagent=true
        // should find the parent from the self-populated session_to_parent
        // and emit relationship metadata.
        let adapter = OpenCodeAdapter::new();
        let payload = serde_json::json!({
            "resourceSpans": [{
                "resource": { "attributes": [] },
                "scopeSpans": [{
                    "spans": [{
                        "name": "fredo.session",
                        "traceId": "trace-subagent",
                        "attributes": [
                            { "key": "session.id", "value": { "stringValue": "child-subagent" } },
                            { "key": "session.parent_id", "value": { "stringValue": "parent-main" } },
                            { "key": "gen_ai.operation.name", "value": { "stringValue": "fredo.session" } },
                            { "key": "is_subagent", "value": { "boolValue": true } }
                        ]
                    }]
                }]
            }]
        });

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(adapter.transform(Transport::OtlpGrpc, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        assert!(!events.is_empty(), "Should produce at least one event");

        // Verify relationship metadata is attached with correct parent-child IDs
        let event_with_meta = events.iter().find(|e| e.metadata.is_some());
        assert!(
            event_with_meta.is_some(),
            "Subagent session with self-populated parent should emit relationship metadata"
        );

        let metadata = event_with_meta.unwrap().metadata.as_ref().unwrap();
        let rel = metadata.get("relationship").expect("relationship key should exist");
        assert_eq!(rel.get("type").and_then(|v| v.as_str()), Some("parent-child"));
        assert_eq!(
            rel.get("parentSessionId").and_then(|v| v.as_str()),
            Some("parent-main")
        );
        assert_eq!(
            rel.get("childSessionId").and_then(|v| v.as_str()),
            Some("child-subagent")
        );
    }

    #[test]
    fn otlp_subagent_span_uses_hook_populated_session_to_parent() {
        // OTLP subagent spans should still find parents from session_to_parent
        // even when the map was populated by Hook transport (backward compat).
        let adapter = OpenCodeAdapter::new();

        // Simulate Hook transport populating session_to_parent
        {
            let mut map = adapter.session_to_parent.lock().unwrap();
            map.insert("hook-child".to_string(), "hook-parent".to_string());
        }

        // Now process an OTLP subagent span for the same child session
        let payload = serde_json::json!({
            "resourceSpans": [{
                "resource": { "attributes": [] },
                "scopeSpans": [{
                    "spans": [{
                        "name": "fredo.session",
                        "traceId": "trace-hook",
                        "attributes": [
                            { "key": "session.id", "value": { "stringValue": "hook-child" } },
                            { "key": "gen_ai.operation.name", "value": { "stringValue": "fredo.session" } },
                            { "key": "is_subagent", "value": { "boolValue": true } }
                        ]
                    }]
                }]
            }]
        });

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(adapter.transform(Transport::OtlpGrpc, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        assert!(!events.is_empty(), "Should produce at least one event");

        // Verify relationship metadata is attached
        let event_with_meta = events.iter().find(|e| e.metadata.is_some());
        assert!(
            event_with_meta.is_some(),
            "OTLP subagent should find parent from Hook-populated session_to_parent"
        );

        let metadata = event_with_meta.unwrap().metadata.as_ref().unwrap();
        let rel = metadata.get("relationship").expect("relationship key should exist");
        assert_eq!(rel.get("type").and_then(|v| v.as_str()), Some("parent-child"));
        assert_eq!(
            rel.get("parentSessionId").and_then(|v| v.as_str()),
            Some("hook-parent")
        );
        assert_eq!(
            rel.get("childSessionId").and_then(|v| v.as_str()),
            Some("hook-child")
        );
    }

    // ——— Spec #633 Redesign: Span Link + gen_ai.* Attribute tests ———

    #[test]
    fn span_link_resolves_parent_for_subagent() {
        // REQ-6 (AC-6): Subagent span with span link to parent + gen_ai.prompt
        // on the subagent span itself → instruction set from gen_ai.prompt.
        let adapter = OpenCodeAdapter::new();
        let rt = tokio::runtime::Runtime::new().unwrap();

        let payload = serde_json::json!({
            "resourceSpans": [{
                "resource": { "attributes": [] },
                "scopeSpans": [{
                    "spans": [{
                        "name": "fredo.llm",
                        "traceId": "trace-subagent",
                        "endTimeUnixNano": "1000000",
                        "links": [{
                            "traceId": "trace-parent",
                            "spanId": "parent-span",
                            "attributes": [
                                {"key": "parent.session_id", "value": {"stringValue": "parent-session"}},
                                {"key": "relationship.type", "value": {"stringValue": "parent-child"}}
                            ]
                        }],
                        "attributes": [
                            { "key": "session.id", "value": { "stringValue": "child-session" } },
                            { "key": "gen_ai.operation.name", "value": { "stringValue": "fredo.llm" } },
                            { "key": "gen_ai.prompt", "value": { "stringValue": "Subagent instruction from plugin" } },
                            { "key": "is_subagent", "value": { "boolValue": true } },
                            { "key": "agent.type", "value": { "stringValue": "subagent" } }
                        ]
                    }]
                }]
            }]
        });
        let result = rt.block_on(adapter.transform(Transport::OtlpGrpc, payload));
        assert!(result.is_ok(), "Span link subagent should succeed");
        let events = result.unwrap();
        assert!(!events.is_empty(), "Should produce events");

        // Verify session_to_parent was populated from span links
        {
            let map = adapter.session_to_parent.lock().unwrap();
            assert_eq!(map.get("child-session").map(|s| s.as_str()), Some("parent-session"));
        }

        // Verify instruction was set from gen_ai.prompt on the subagent span itself
        let event = events.iter().find(|e| e.session_id == "child-session");
        assert!(event.is_some(), "Child event should exist");
        let payload_val = event.unwrap().payload.as_ref().unwrap();
        let instruction = payload_val.get("instruction").and_then(|v| v.as_str());
        assert_eq!(instruction, Some("Subagent instruction from plugin"));
    }

    #[test]
    fn span_link_absent_falls_back_to_session_parent_id() {
        // REQ-9: Old plugin spans (no span links, only session.parent_id attribute)
        // continue to populate session_to_parent via attribute-based detection.
        let adapter = OpenCodeAdapter::new();
        let rt = tokio::runtime::Runtime::new().unwrap();

        let payload = serde_json::json!({
            "resourceSpans": [{
                "resource": { "attributes": [] },
                "scopeSpans": [{
                    "spans": [{
                        "name": "fredo.llm",
                        "traceId": "trace-old",
                        "endTimeUnixNano": "1000000",
                        "attributes": [
                            { "key": "session.id", "value": { "stringValue": "old-child" } },
                            { "key": "session.parent_id", "value": { "stringValue": "old-parent" } },
                            { "key": "gen_ai.operation.name", "value": { "stringValue": "fredo.llm" } },
                            { "key": "gen_ai.prompt", "value": { "stringValue": "Old format instruction" } },
                            { "key": "is_subagent", "value": { "boolValue": true } },
                            { "key": "agent.type", "value": { "stringValue": "subagent" } }
                        ]
                    }]
                }]
            }]
        });
        let result = rt.block_on(adapter.transform(Transport::OtlpGrpc, payload));
        assert!(result.is_ok(), "Old format should succeed");
        let events = result.unwrap();
        assert!(!events.is_empty(), "Should produce events");

        // Verify session_to_parent was populated from session.parent_id attribute
        {
            let map = adapter.session_to_parent.lock().unwrap();
            assert_eq!(map.get("old-child").map(|s| s.as_str()), Some("old-parent"));
        }

        // Instruction should come from gen_ai.prompt on the span (REQ-7 path)
        let event = events.iter().find(|e| e.session_id == "old-child");
        assert!(event.is_some());
        let payload_val = event.unwrap().payload.as_ref().unwrap();
        let instruction = payload_val.get("instruction").and_then(|v| v.as_str());
        assert_eq!(instruction, Some("Old format instruction"));
    }

    #[test]
    fn no_parent_info_no_instruction_injected() {
        // REQ-6 graceful degradation: Subagent without span links or session.parent_id
        // → no parent resolved → no instruction from parent injection.
        // Instruction may still come from gen_ai.prompt on the span itself.
        let adapter = OpenCodeAdapter::new();
        let rt = tokio::runtime::Runtime::new().unwrap();

        let payload = serde_json::json!({
            "resourceSpans": [{
                "resource": { "attributes": [] },
                "scopeSpans": [{
                    "spans": [{
                        "name": "fredo.llm",
                        "traceId": "trace-orphan",
                        "endTimeUnixNano": "1000000",
                        "attributes": [
                            { "key": "session.id", "value": { "stringValue": "orphan-subagent" } },
                            { "key": "gen_ai.operation.name", "value": { "stringValue": "fredo.llm" } },
                            // NO span links, NO session.parent_id, NO gen_ai.prompt
                            { "key": "is_subagent", "value": { "boolValue": true } },
                            { "key": "agent.type", "value": { "stringValue": "subagent" } }
                        ]
                    }]
                }]
            }]
        });
        let result = rt.block_on(adapter.transform(Transport::OtlpGrpc, payload));
        assert!(result.is_ok(), "Orphan should succeed");
        let events = result.unwrap();
        assert!(!events.is_empty(), "Should produce events");

        // Verify no relationship metadata (no parent found)
        let event = events.iter().find(|e| e.session_id == "orphan-subagent");
        assert!(event.is_some());
        assert!(event.unwrap().metadata.is_none(), "No parent → no relationship metadata");

        // Verify no instruction payload field (nothing to inject)
        let payload_val = event.unwrap().payload.as_ref().unwrap();
        let has_instruction = payload_val.get("instruction")
            .and_then(|v| v.as_str())
            .map(|s| !s.is_empty())
            .unwrap_or(false);
        assert!(!has_instruction, "Orphan subagent should not have instruction");
    }

    #[test]
    fn non_subagent_span_has_no_instruction_field() {
        // REQ-3 AC-6: Primary (non-subagent) span payload has NO instruction field.
        let adapter = OpenCodeAdapter::new();
        let rt = tokio::runtime::Runtime::new().unwrap();

        let payload = serde_json::json!({
            "resourceSpans": [{
                "resource": { "attributes": [] },
                "scopeSpans": [{
                    "spans": [{
                        "name": "fredo.llm",
                        "traceId": "trace-primary",
                        "endTimeUnixNano": "1000000",
                        "attributes": [
                            { "key": "session.id", "value": { "stringValue": "primary-session" } },
                            { "key": "gen_ai.operation.name", "value": { "stringValue": "fredo.llm" } },
                            { "key": "gen_ai.prompt", "value": { "stringValue": "Do something important" } },
                            { "key": "is_subagent", "value": { "boolValue": false } }
                        ]
                    }]
                }]
            }]
        });
        let result = rt.block_on(adapter.transform(Transport::OtlpGrpc, payload));
        assert!(result.is_ok(), "Primary should succeed");
        let events = result.unwrap();
        assert!(!events.is_empty(), "Should produce events");

        // Verify NO instruction field in primary span payload
        let event = events.iter().find(|e| e.session_id == "primary-session");
        assert!(event.is_some());
        let payload_val = event.unwrap().payload.as_ref().unwrap();
        let has_instruction = payload_val.get("instruction")
            .and_then(|v| v.as_str())
            .map(|s| !s.is_empty())
            .unwrap_or(false);
        assert!(!has_instruction, "Non-subagent span should NOT have instruction field");
    }

    #[test]
    fn gen_ai_prompt_preferred_over_prompt_in_otlp_payload() {
        // REQ-7: In otlp_attrs_to_payload, gen_ai.prompt is preferred over
        // flat prompt attribute for instruction extraction on subagent spans.
        let adapter = OpenCodeAdapter::new();
        let rt = tokio::runtime::Runtime::new().unwrap();

        let payload = serde_json::json!({
            "resourceSpans": [{
                "resource": { "attributes": [] },
                "scopeSpans": [{
                    "spans": [{
                        "name": "fredo.llm",
                        "traceId": "trace-pref",
                        "endTimeUnixNano": "1000000",
                        "links": [{
                            "traceId": "trace-parent",
                            "spanId": "parent-span",
                            "attributes": [
                                {"key": "parent.session_id", "value": {"stringValue": "parent-x"}},
                                {"key": "relationship.type", "value": {"stringValue": "parent-child"}}
                            ]
                        }],
                        "attributes": [
                            { "key": "session.id", "value": { "stringValue": "child-pref" } },
                            { "key": "gen_ai.operation.name", "value": { "stringValue": "fredo.llm" } },
                            // BOTH gen_ai.prompt AND prompt present — gen_ai.prompt should win for instruction
                            { "key": "gen_ai.prompt", "value": { "stringValue": "gen_ai path text" } },
                            { "key": "prompt", "value": { "stringValue": "flat prompt text" } },
                            { "key": "is_subagent", "value": { "boolValue": true } },
                            { "key": "agent.type", "value": { "stringValue": "subagent" } }
                        ]
                    }]
                }]
            }]
        });
        let result = rt.block_on(adapter.transform(Transport::OtlpGrpc, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        let event = events.iter().find(|e| e.session_id == "child-pref").unwrap();
        let payload_val = event.payload.as_ref().unwrap();
        let instruction = payload_val.get("instruction").and_then(|v| v.as_str());
        assert_eq!(instruction, Some("gen_ai path text"));
    }

    #[test]
    fn gen_ai_usage_tokens_preferred_over_flat_tokens() {
        // REQ-7: gen_ai.usage.input_tokens preferred over input_tokens (flat).
        let adapter = OpenCodeAdapter::new();
        let rt = tokio::runtime::Runtime::new().unwrap();

        let payload = serde_json::json!({
            "resourceSpans": [{
                "resource": { "attributes": [] },
                "scopeSpans": [{
                    "spans": [{
                        "name": "fredo.llm",
                        "traceId": "trace-tokens",
                        "endTimeUnixNano": "2000000",
                        "attributes": [
                            { "key": "session.id", "value": { "stringValue": "token-session" } },
                            { "key": "gen_ai.operation.name", "value": { "stringValue": "fredo.llm" } },
                            // BOTH paths present — gen_ai.usage.* should win
                            { "key": "gen_ai.usage.input_tokens", "value": { "intValue": "100" } },
                            { "key": "gen_ai.usage.output_tokens", "value": { "intValue": "50" } },
                            { "key": "input_tokens", "value": { "intValue": "999" } },
                            { "key": "output_tokens", "value": { "intValue": "888" } }
                        ]
                    }]
                }]
            }]
        });
        let result = rt.block_on(adapter.transform(Transport::OtlpGrpc, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        let event = events.iter().find(|e| e.session_id == "token-session").unwrap();
        let payload_val = event.payload.as_ref().unwrap();
        // Check info.turnInputTokens uses gen_ai.usage.input_tokens (100), not input_tokens (999)
        let input_tokens = payload_val.get("info")
            .and_then(|i| i.get("turnInputTokens"))
            .and_then(|v| v.as_i64());
        assert_eq!(input_tokens, Some(100), "gen_ai.usage.input_tokens should win");
        let output_tokens = payload_val.get("info")
            .and_then(|i| i.get("turnOutputTokens"))
            .and_then(|v| v.as_i64());
        assert_eq!(output_tokens, Some(50), "gen_ai.usage.output_tokens should win");
        // Also check canonical top-level fields
        assert_eq!(payload_val.get("promptTokens").and_then(|v| v.as_i64()), Some(100));
        assert_eq!(payload_val.get("completionTokens").and_then(|v| v.as_i64()), Some(50));
    }

    #[test]
    fn span_link_resolves_order_independent() {
        // REQ-6 AC-6: Span link parent-child resolution is order-independent.
        // Even when the child span arrives WITHOUT the parent in session_to_parent
        // (no session.parent_id either), the span link populates session_to_parent
        // and produces correct relationship_meta.
        let adapter = OpenCodeAdapter::new();
        let rt = tokio::runtime::Runtime::new().unwrap();

        let payload = serde_json::json!({
            "resourceSpans": [{
                "resource": { "attributes": [] },
                "scopeSpans": [{
                    "spans": [{
                        "name": "fredo.llm",
                        "traceId": "trace-child-first",
                        "endTimeUnixNano": "1000000",
                        "links": [{
                            "traceId": "trace-parent",
                            "spanId": "parent-span",
                            "attributes": [
                                {"key": "parent.session_id", "value": {"stringValue": "parent-ses"}},
                                {"key": "relationship.type", "value": {"stringValue": "parent-child"}}
                            ]
                        }],
                        "attributes": [
                            { "key": "session.id", "value": { "stringValue": "child-ses" } },
                            { "key": "gen_ai.operation.name", "value": { "stringValue": "fredo.llm" } },
                            { "key": "gen_ai.prompt", "value": { "stringValue": "Do task" } },
                            // Intentionally NO session.parent_id attribute —
                            // span link should be sufficient for parent resolution
                            { "key": "is_subagent", "value": { "boolValue": true } },
                            { "key": "agent.type", "value": { "stringValue": "subagent" } }
                        ]
                    }]
                }]
            }]
        });
        let result = rt.block_on(adapter.transform(Transport::OtlpGrpc, payload));
        assert!(result.is_ok());
        let events = result.unwrap();

        // session_to_parent populated from span links even without session.parent_id
        {
            let map = adapter.session_to_parent.lock().unwrap();
            assert_eq!(
                map.get("child-ses").map(|s| s.as_str()),
                Some("parent-ses"),
                "Span links should populate session_to_parent without session.parent_id"
            );
        }

        // Relationship metadata should be present
        let event = events.iter().find(|e| e.session_id == "child-ses");
        assert!(event.is_some());
        let meta = event.unwrap().metadata.as_ref();
        assert!(meta.is_some(), "Should have relationship metadata from span link resolution");
    }

    #[test]
    fn pending_task_instructions_still_works() {
        // REQ-9: pending_task_instructions injection (from fredo.tool.task spans)
        // still works — it was NOT removed.
        let adapter = OpenCodeAdapter::new();
        let rt = tokio::runtime::Runtime::new().unwrap();

        // Pre-populate pending_task_instructions (simulating prior tool.task span processing)
        {
            let mut pti = adapter.pending_task_instructions.lock().unwrap();
            pti.insert("parent-task".to_string(), "Task instruction".to_string());
        }
        // Pre-populate session_to_parent
        {
            let mut stp = adapter.session_to_parent.lock().unwrap();
            stp.insert("child-task".to_string(), "parent-task".to_string());
        }

        // Process subagent span
        let payload = serde_json::json!({
            "resourceSpans": [{
                "resource": { "attributes": [] },
                "scopeSpans": [{
                    "spans": [{
                        "name": "fredo.llm",
                        "traceId": "trace-task",
                        "endTimeUnixNano": "1000000",
                        "attributes": [
                            { "key": "session.id", "value": { "stringValue": "child-task" } },
                            { "key": "session.parent_id", "value": { "stringValue": "parent-task" } },
                            { "key": "gen_ai.operation.name", "value": { "stringValue": "fredo.llm" } },
                            { "key": "is_subagent", "value": { "boolValue": true } },
                            { "key": "agent.type", "value": { "stringValue": "subagent" } }
                        ]
                    }]
                }]
            }]
        });
        let result = rt.block_on(adapter.transform(Transport::OtlpGrpc, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        let event = events.iter().find(|e| e.session_id == "child-task").unwrap();
        let payload_val = event.payload.as_ref().unwrap();
        let instruction = payload_val.get("instruction").and_then(|v| v.as_str());
        assert_eq!(
            instruction,
            Some("Task instruction"),
            "pending_task_instructions should still inject"
        );
    }
}


