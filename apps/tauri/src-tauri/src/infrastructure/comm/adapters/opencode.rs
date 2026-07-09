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

/// Whitelist of known @-subagent agent names whose child sessions should be
/// merged into the parent session via sessionId rewrite. Only user-requested
/// subagent dispatches (via @-mention in opencode) are whitelisted. Internal
/// tool-execution agents (build, plan, bash, read, etc.) are excluded so their
/// sessions remain independent and don't flood the graph with SubagentNodes.
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

    /// REQ-1: Child-to-parent session mapping for subagent session rewrite.
    /// Key: child_session_id, Value: parent_session_id.
    /// When a Hook event's session_id is found in this map, the session_id
    /// is rewritten to the parent session_id. Populated from:
    /// - PostToolUse `task` events that carry tool_response.metadata.parentSessionId
    /// - session.updated events with properties.info.parentID where
    ///   properties.info.agent is in WHITELIST_SUBAGENT_NAMES
    /// Capped at 10,000 entries with oldest-first eviction.
    child_to_parent: Arc<Mutex<HashMap<String, String>>>,
}

impl OpenCodeAdapter {
    /// Create a new OpenCodeAdapter.
    pub fn new() -> Self {
        OpenCodeAdapter {
            trace_to_session: Arc::new(Mutex::new(HashMap::new())),
            session_to_correlation: Arc::new(Mutex::new(HashMap::new())),
            tool_call_id: Arc::new(Mutex::new(HashMap::new())),
            child_to_parent: Arc::new(Mutex::new(HashMap::new())),
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
        // Extract session_id from the SDK event's nested payload.
        // The OpenCode SDK uses camelCase `sessionID`, nested inside
        // `properties`, `tool_input`, or `input` — never at the top level.
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
            None => return Ok(vec![]),
        };

        // REQ-1, REQ-3: Check child_to_parent map for session rewrite.
        // If the extracted session_id is a known child session, rewrite it
        // to the parent session_id so all downstream consumers see parent events.
        let (session_id_str, original_session_id) = {
            let map_guard = self.child_to_parent.lock().ok();
            match map_guard.and_then(|m| m.get(&extracted_session_id).cloned()) {
                Some(parent_sid) => (parent_sid, Some(extracted_session_id.clone())),
                None => (extracted_session_id.clone(), None),
            }
        };
        let session_id = session_id_str.as_str();
        let original_sid = original_session_id.as_deref();

        // REQ-1: Log when session ID is rewritten via child_to_parent map
        if original_session_id.is_some() {
            let event_type = raw.get("event_type").and_then(|v| v.as_str()).unwrap_or("unknown");
            tracing::info!(
                target: "fredo::compositing",
                child_session_id = extracted_session_id.as_str(),
                parent_session_id = session_id_str.as_str(),
                event_type = event_type,
                "adapter.session.rewrite"
            );
        }

        // Detect hook event type by examining the payload structure
        // PreToolUse: has tool_input
        // PostToolUse: has tool_response (and no error)
        // PostToolUseFailure: has error field
        // Lifecycle: has session_id or explicit event_type field

        // Check for explicit event_type first
        if let Some(event_type) = raw.get("event_type").and_then(|v| v.as_str()) {
            match event_type {
                // --- Tool use events ---
                "PreToolUse" => return self.transform_pre_tool_use(raw, session_id, original_sid),
                "PostToolUse" => return self.transform_post_tool_use(raw, session_id, original_sid),
                "PostToolUseFailure" => {
                    return self.transform_post_tool_use_failure(raw, session_id, original_sid)
                }

                // --- Permission events ---
                "permission.asked" => {
                    return self.transform_with_event_type(
                        raw,
                        EventType::Custom,
                        EventState::Init,
                        "permission.asked",
                        session_id,
                        original_sid,
                    )
                }
                "permission.replied" => {
                    return self.transform_with_event_type(
                        raw,
                        EventType::Custom,
                        EventState::Response,
                        "permission.replied",
                        session_id,
                        original_sid,
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
                        original_sid,
                    )
                }
                "command.executed" => {
                    return self.transform_with_event_type(
                        raw,
                        EventType::Custom,
                        EventState::Response,
                        "command.executed",
                        session_id,
                        original_sid,
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
                        original_sid,
                    )
                }
                "chat.message" => {
                    return self.transform_with_event_type(
                        raw,
                        EventType::Chat,
                        EventState::Response,
                        "chat.message",
                        session_id,
                        original_sid,
                    )
                }
                // Message update/delta events: extract properties for cleaner payload
                "message.updated"
                | "message.part.updated"
                | "message.part.delta"
                | "message.removed"
                | "message.part.removed" => {
                    let inner = raw.get("properties").unwrap_or(&raw);
                    return self.transform_with_event_type(
                        inner.clone(),
                        EventType::Chat,
                        EventState::Update,
                        event_type,
                        session_id,
                        original_sid,
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
                        original_sid,
                    )
                }
                "SessionEnd" => {
                    return self.transform_with_event_type(
                        raw,
                        EventType::AgentSession,
                        EventState::Response,
                        "SessionEnd",
                        session_id,
                        original_sid,
                    )
                }
                "session.created" => {
                    return self.transform_with_event_type(
                        raw,
                        EventType::AgentSession,
                        EventState::Init,
                        "session.created",
                        session_id,
                        original_sid,
                    )
                }
                "session.updated" => {
                    // REQ-5: Detect @-subagent child sessions via whitelist check
                    // on properties.info.agent. Populate child_to_parent map BEFORE
                    // emitting the event so SUBSEQUENT events get sessionId rewritten.
                    // The session.updated event itself passes through with the ORIGINAL
                    // sessionId (not rewritten), but the map population ensures
                    // subsequent events (session.created, chat.message, etc.) for this
                    // child session get rewritten to the parent sessionId.
                    if let Some(info) = raw.get("properties").and_then(|v| v.get("info")) {
                        if let Some(parent_id) = info.get("parentID").and_then(|v| v.as_str()) {
                            let agent_name = info.get("agent").and_then(|v| v.as_str());
                            let is_whitelisted = agent_name
                                .map(|name| WHITELIST_SUBAGENT_NAMES.contains(&name))
                                .unwrap_or(false);
                            if is_whitelisted {
                                // Populate child_to_parent map (child_sid → parent_sid)
                                // Same pattern as PostToolUse detection (lines ~528-537).
                                if let Ok(mut map) = self.child_to_parent.lock() {
                                    // Cap at 10K entries — evict oldest if at capacity
                                    if map.len() >= 10_000 {
                                        if let Some(k) = map.keys().next().cloned() {
                                            map.remove(&k);
                                        }
                                    }
                                    if !map.contains_key(&extracted_session_id) {
                                        map.insert(
                                            extracted_session_id.clone(),
                                            parent_id.to_string(),
                                        );
                                    }
                                }
                            }
                        }
                    }
                    return self.transform_with_event_type(
                        raw,
                        EventType::AgentSession,
                        EventState::Update,
                        "session.updated",
                        session_id,
                        original_sid,
                    )
                }
                "session.deleted" => {
                    return self.transform_with_event_type(
                        raw,
                        EventType::AgentSession,
                        EventState::Response,
                        "session.deleted",
                        session_id,
                        original_sid,
                    )
                }
                "session.status" => {
                    return self.transform_with_event_type(
                        raw,
                        EventType::AgentSession,
                        EventState::Update,
                        "session.status",
                        session_id,
                        original_sid,
                    )
                }
                "session.error" => {
                    return self.transform_with_event_type(
                        raw,
                        EventType::AgentSession,
                        EventState::Error,
                        "session.error",
                        session_id,
                        original_sid,
                    )
                }
                "session.idle" => {
                    return self.transform_with_event_type(
                        raw,
                        EventType::AgentSession,
                        EventState::Update,
                        "session.idle",
                        session_id,
                        original_sid,
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
                        original_sid,
                    )
                }
                "session.next.tool.success" => {
                    return self.transform_with_event_type(
                        raw,
                        EventType::ToolUse,
                        EventState::Response,
                        "session.next.tool.success",
                        session_id,
                        original_sid,
                    )
                }
                "session.next.tool.failed" => {
                    return self.transform_with_event_type(
                        raw,
                        EventType::ToolUse,
                        EventState::Error,
                        "session.next.tool.failed",
                        session_id,
                        original_sid,
                    )
                }
                "session.next.text.delta" => {
                    return self.transform_with_event_type(
                        raw,
                        EventType::Chat,
                        EventState::Update,
                        "session.next.text.delta",
                        session_id,
                        original_sid,
                    )
                }
                "session.next.text.started" => {
                    return self.transform_with_event_type(
                        raw,
                        EventType::Chat,
                        EventState::Init,
                        "session.next.text.started",
                        session_id,
                        original_sid,
                    )
                }
                "session.next.text.ended" => {
                    return self.transform_with_event_type(
                        raw,
                        EventType::Chat,
                        EventState::Response,
                        "session.next.text.ended",
                        session_id,
                        original_sid,
                    )
                }
                "session.next.step.started" => {
                    return self.transform_with_event_type(
                        raw,
                        EventType::AgentSession,
                        EventState::Init,
                        "session.next.step.started",
                        session_id,
                        original_sid,
                    )
                }
                "session.next.step.ended" => {
                    return self.transform_with_event_type(
                        raw,
                        EventType::AgentSession,
                        EventState::Response,
                        "session.next.step.ended",
                        session_id,
                        original_sid,
                    )
                }
                "session.next.agent.switched" => {
                    return self.transform_with_event_type(
                        raw,
                        EventType::AgentSession,
                        EventState::Update,
                        "session.next.agent.switched",
                        session_id,
                        original_sid,
                    )
                }

                _ => {
                    // Other lifecycle events with session_id
                    let raw_clone = raw.clone();
                    let sid = raw_clone.get("session_id").and_then(|v| v.as_str());
                    if let Some(s) = sid {
                        return self.transform_lifecycle_event(raw, s);
                    }
                    return Ok(vec![]);
                }
            }
        }

        // Detect by field presence
        if raw.get("tool_input").is_some() {
            // PreToolUse
            return self.transform_pre_tool_use(raw, session_id, original_sid);
        }
        if raw.get("error").is_some() {
            // PostToolUseFailure
            return self.transform_post_tool_use_failure(raw, session_id, original_sid);
        }
        if raw.get("tool_response").is_some() {
            // PostToolUse
            return self.transform_post_tool_use(raw, session_id, original_sid);
        }

        // Check for lifecycle events (has session_id)
        let raw_clone = raw.clone();
        if let Some(sid) = raw_clone.get("session_id").and_then(|v| v.as_str()) {
            return self.transform_lifecycle_event(raw, sid);
        }

        // Unknown event type — return empty vec (graceful handling)
        Ok(vec![])
    }

    /// Transform PreToolUse hook event.
    fn transform_pre_tool_use(
        &self,
        raw: Value,
        session_id: &str,
        original_session_id: Option<&str>,
    ) -> anyhow::Result<Vec<FredoEvent>> {
        let tool_name = raw
            .get("tool_name")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let tool_input = raw.get("tool_input").cloned();

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
            .correlation_id(correlation_id)
            .build();

        if let Some(input) = tool_input {
            event.payload = Some(input);
        }

        // REQ-3: Add metadata with original sessionId if session was rewritten
        if let Some(orig_sid) = original_session_id {
            event.metadata = Some(json!({"originalSessionId": orig_sid}));
        }

        Ok(vec![event])
    }

    /// Transform PostToolUse hook event.
    fn transform_post_tool_use(
        &self,
        raw: Value,
        session_id: &str,
        original_session_id: Option<&str>,
    ) -> anyhow::Result<Vec<FredoEvent>> {
        let tool_name = raw
            .get("tool_name")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let tool_response = raw.get("tool_response").cloned();

        // REQ-1: Detect PostToolUse `task` events for subagent session merge.
        // When tool_name == "task" and tool_response.metadata contains
        // sessionId and parentSessionId, store the child→parent mapping
        // so subsequent events from the child session are rewritten to
        // the parent sessionId by the session rewrite check (lines 105-114).
        if tool_name.as_deref() == Some("task") {
            if let Some(metadata) = raw
                .get("tool_response")
                .and_then(|v| v.get("metadata"))
            {
                let child_sid = metadata.get("sessionId").and_then(|v| v.as_str());
                let parent_sid = metadata.get("parentSessionId").and_then(|v| v.as_str());
                if let (Some(child), Some(parent)) = (child_sid, parent_sid) {
                    if let Ok(mut map) = self.child_to_parent.lock() {
                        // Cap at 10K entries — evict oldest if at capacity
                        if map.len() >= 10_000 {
                            if let Some(k) = map.keys().next().cloned() {
                                map.remove(&k);
                            }
                        }
                        let inserted = !map.contains_key(child);
                        if !map.contains_key(child) {
                            map.insert(child.to_string(), parent.to_string());
                        }
                        tracing::info!(
                            target: "fredo::compositing",
                            session_id = session_id,
                            child_session_id = child,
                            parent_session_id = parent,
                            inserted = inserted,
                            "adapter.relationship.detect"
                        );
                    }
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
            .correlation_id(correlation_id)
            .build();

        if let Some(response) = tool_response {
            event.payload = Some(response);
        }

        // REQ-3: Add metadata with original sessionId if session was rewritten
        if let Some(orig_sid) = original_session_id {
            event.metadata = Some(json!({"originalSessionId": orig_sid}));
        }

        Ok(vec![event])
    }

    /// Transform PostToolUseFailure hook event.
    fn transform_post_tool_use_failure(
        &self,
        raw: Value,
        session_id: &str,
        original_session_id: Option<&str>,
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

        let event = FredoEvent::builder()
            .event_type(EventType::ToolUse)
            .state(EventState::Error)
            .provider(EventProvider::OpenCode)
            .transport(Transport::Hook)
            .session_id(session_id)
            .tool_name(tool_name.unwrap_or_default())
            .correlation_id(correlation_id)
            .error(crate::infrastructure::comm::event::FredoEventError {
                message: error_msg,
                code: None,
                details: None,
            })
            .build();

        // REQ-4: Add metadata with original sessionId if session was rewritten,
        // so the frontend can detect subagent events via originalSessionId presence.
        // Note: event is immutable, so we return it as-is when no rewrite.
        if let Some(orig_sid) = original_session_id {
            // Need to clone and add metadata since event is immutable above
            let mut event_with_meta = event;
            event_with_meta.metadata = Some(json!({"originalSessionId": orig_sid}));
            return Ok(vec![event_with_meta]);
        }

        Ok(vec![event])
    }

    /// Generic helper for events that map 1:1 to a single FredoEvent.
    ///
    /// REQ-1 / AC-R1, AC-R2, AC-R7: For Chat events, extracts `messageID` from the
    /// raw payload (checking multiple structural paths) and sets it as `correlationId`.
    /// Falls back to a UUID v4 if no `messageID` is found at any path.
    ///
    /// REQ-4: When `original_session_id` is Some, the event's session_id has been
    /// rewritten from a child to parent. For AgentSession events, the correlationId
    /// is derived from original_session_id (child session ID) to create a separate
    /// ECE buffer from the parent. For Chat events, the session_to_correlation map
    /// key is derived from original_session_id.
    fn transform_with_event_type(
        &self,
        raw: Value,
        event_type: EventType,
        state: EventState,
        tool_name: &str,
        session_id: &str,
        original_session_id: Option<&str>,
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
        // REQ-4: For rewritten (child) sessions, use original_session_id as the
        // map key so child chat events have a different correlationId from parent.
        if event_type == EventType::Chat {
            // Use original_session_id as correlation key if present (child session),
            // otherwise use session_id (parent or non-rewritten session).
            let correlation_key = original_session_id.unwrap_or(session_id);

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
        // REQ-4: For rewritten (child) sessions, use original_session_id as the
        // correlationId and map key so child events create a separate ECE buffer
        // from parent events (keyed by child_sid, not parent_sid).
        if event_type == EventType::AgentSession {
            // Use original_session_id if present (child session), otherwise session_id
            let cid_key = original_session_id.unwrap_or(session_id);
            let cid = cid_key.to_string();
            if let Ok(mut map) = self.session_to_correlation.lock() {
                // REQ-10: Cap at 10K entries — evict oldest if at capacity
                if map.len() >= 10_000 && !map.contains_key(cid_key) {
                    if let Some(key) = map.keys().next().cloned() {
                        map.remove(&key);
                    }
                }
                map.entry(cid_key.to_string()).or_insert_with(|| cid.clone());
            }
            builder = builder.correlation_id(cid);
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

        // REQ-3: Add metadata with original sessionId if session was rewritten,
        // so the frontend can detect subagent events.
        if let Some(orig_sid) = original_session_id {
            event.metadata = Some(json!({"originalSessionId": orig_sid}));
            tracing::info!(
                target: "fredo::compositing",
                session_id = session_id,
                original_session_id = orig_sid,
                event_type = event.event_type.as_str(),
                state = format!("{:?}", event.state),
                tool_name = event.tool_name.as_deref().unwrap_or(""),
                "adapter.metadata.annotate"
            );
        }

        // Pass through the raw payload so the frontend can extract
        // scope/tool details, user decisions, file paths, etc.
        event.payload = Some(raw);

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
    fn normalize_op_name(name: &str) -> Option<&'static str> {
        for op in &[
            "chat",
            "invoke_agent",
            "execute_tool",
            "permission",
            "elicitation",
        ] {
            if name == *op || name.starts_with(&format!("{} ", op)) {
                return Some(op);
            }
        }
        None
    }

    /// Map OTLP flat attributes to the nested payload structure expected by the frontend.
    ///
    /// REQ-2 / AC-2: Maps OTLP attribute keys to:
    /// - `gen_ai.usage.input_tokens` → `info.turnInputTokens`
    /// - `gen_ai.usage.output_tokens` → `info.turnOutputTokens`
    /// - `gen_ai.response.body` → `part.text` (agent reply)
    /// - `gen_ai.request.body` or `gen_ai.prompt` → `info.text` (user message)
    /// - `gen_ai.response.model` → `info.modelID`
    ///
    /// Flat OTLP attributes are preserved at the top level for backward compatibility.
    fn otlp_attrs_to_payload(attrs: Map<String, Value>) -> Value {
        let mut payload = attrs.clone();

        // ——— Extract mapped values from flat OTLP attributes ———
        let turn_input_tokens = attrs
            .get("gen_ai.usage.input_tokens")
            .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse::<i64>().ok())));
        let turn_output_tokens = attrs
            .get("gen_ai.usage.output_tokens")
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
        let model = attrs
            .get("gen_ai.response.model")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        // ——— Build info object (user message, model, token counts) ———
        let mut info = Map::new();
        // User message text: prefer gen_ai.request.body, fall back to gen_ai.prompt
        let user_text = request_body.or(prompt);
        if let Some(text) = user_text {
            info.insert("text".to_string(), Value::String(text));
        }
        if let Some(model_id) = model {
            info.insert("modelID".to_string(), Value::String(model_id));
        }
        if let Some(tokens) = turn_input_tokens {
            info.insert("turnInputTokens".to_string(), json!(tokens));
        }
        if let Some(tokens) = turn_output_tokens {
            info.insert("turnOutputTokens".to_string(), json!(tokens));
        }

        // ——— Build part object (agent reply text, reasoning) ———
        let mut part = Map::new();
        if let Some(text) = response_body {
            part.insert("text".to_string(), Value::String(text));
        }

        // Insert nested objects into payload, preserving flat attrs
        if !info.is_empty() {
            payload.insert("info".to_string(), Value::Object(info));
        }
        if !part.is_empty() {
            payload.insert("part".to_string(), Value::Object(part));
        }

        Value::Object(payload)
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
                            .or_else(|| Self::normalize_op_name(span_name));

                        let op_name = match op_name {
                            Some(op) => op,
                            None => continue, // chat, metrics, unknown — drop
                        };

                        // Resolve session id
                        let trace_id = span
                            .get("traceId")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let session_id = span_attrs
                            .get("gen_ai.conversation.id")
                            .and_then(|v| v.as_str())
                            .map(str::to_owned)
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

                        // Store trace-to-conversation mapping if we have conversation.id
                        if let Some(conv_id) = span_attrs
                            .get("gen_ai.conversation.id")
                            .and_then(|v| v.as_str())
                        {
                            if let Ok(mut map) = self.trace_to_session.lock() {
                                // REQ-10: Cap at 10K entries — evict oldest if at capacity
                                if map.len() >= 10_000 {
                                    if let Some(key) = map.keys().next().cloned() {
                                        map.remove(&key);
                                    }
                                }
                                map.insert(trace_id.clone(), conv_id.to_string());
                            }
                        }

                        // Merge resource attrs + span attrs
                        let mut merged = res_attrs.clone();
                        merged.extend(span_attrs);

                        // Determine event type based on op_name
                        // REQ-1.1, REQ-1.2: chat + invoke_agent → Chat/Response
                        // execute_tool, permission, elicitation → ToolUse/Response
                        let event_type = match op_name {
                            "chat" | "invoke_agent" => EventType::Chat,
                            _ => EventType::ToolUse,
                        };

                        // REQ-3: Use stored correlationId from Hook events when available,
                        // otherwise fall back to traceId (or UUID if empty).
                        let otlp_correlation_id = self
                            .session_to_correlation
                            .lock()
                            .ok()
                            .and_then(|m| m.get(&session_id).cloned())
                            .unwrap_or_else(|| {
                                if !trace_id.is_empty() {
                                    trace_id.clone()
                                } else {
                                    Uuid::new_v4().to_string()
                                }
                            });

                        // REQ-2 / AC-2: Map flat OTLP attributes to nested payload structure
                        let mapped_payload = Self::otlp_attrs_to_payload(merged);

                        events.push(
                            FredoEvent::builder()
                                .event_type(event_type)
                                .state(EventState::Response)
                                .provider(provider)
                                .transport(Transport::OtlpGrpc)
                                .session_id(session_id)
                                .tool_name(op_name)
                                .correlation_id(otlp_correlation_id)
                                .payload(mapped_payload)
                                .build(),
                        );
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

        // Normalize op_name for correct event type classification
        let op_name = Self::normalize_op_name(raw_name).unwrap_or(raw_name);

        // REQ-1.1, REQ-1.2: chat + invoke_agent → Chat/Response
        let event_type = match op_name {
            "chat" | "invoke_agent" => EventType::Chat,
            _ => EventType::ToolUse,
        };

        let session_id = attrs
            .get("gen_ai.conversation.id")
            .and_then(|v| v.as_str())
            .map(str::to_owned)
            .unwrap_or_else(|| Uuid::new_v4().to_string());

        // REQ-3: Use stored correlationId from Hook events when available,
        // otherwise fall back to traceId (or UUID if empty).
        let flat_trace_id = raw
            .get("traceId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let flat_correlation_id = self
            .session_to_correlation
            .lock()
            .ok()
            .and_then(|m| m.get(&session_id).cloned())
            .unwrap_or_else(|| {
                if !flat_trace_id.is_empty() {
                    flat_trace_id
                } else {
                    Uuid::new_v4().to_string()
                }
            });

        // REQ-2 / AC-2: Map flat OTLP attributes to nested payload structure
        let mapped_attrs = Self::otlp_attrs_to_payload(attrs);

        events.push(
            FredoEvent::builder()
                .event_type(event_type)
                .state(EventState::Response)
                .provider(provider)
                .transport(Transport::OtlpGrpc)
                .session_id(session_id)
                .tool_name(op_name)
                .correlation_id(flat_correlation_id)
                .payload(mapped_attrs)
                .build(),
        );

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

    // ——— AC-R3: OTLP chat span traceId → correlationId ———

    #[test]
    fn ac_r3_otlp_chat_span_trace_id_to_correlation() {
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
        assert_eq!(events[0].correlation_id, Some("abc123".to_string()));
    }

    // ——— AC-R4: OTLP invoke_agent span traceId → correlationId ———

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
        assert_eq!(events[0].correlation_id, Some("xyz789".to_string()));
    }

    // ——— AC-R5: OTLP chat span without traceId → UUID correlationId ———

    #[test]
    fn ac_r5_otlp_chat_span_without_trace_id_uses_uuid() {
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
        assert!(
            !cid.as_deref().unwrap().is_empty(),
            "correlationId should not be empty"
        );
        assert_eq!(
            cid.as_deref().unwrap().len(),
            36,
            "UUID v4 should be 36 chars"
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

        // 5. OTLP chat span with traceId
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
        assert_eq!(events[0].correlation_id.as_deref().unwrap(), "trace-r7");

        // 6. OTLP chat span without traceId → UUID fallback
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
        assert!(
            !cid.as_deref().unwrap().is_empty(),
            "UUID fallback should not be empty"
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

    // ——— AC-8 (REQ-3): OTLP chat span uses Hook-stored correlationId via bridging ———

    #[test]
    fn ac_8_otlp_uses_hook_stored_correlation_id() {
        let adapter = OpenCodeAdapter::new();
        let rt = tokio::runtime::Runtime::new().unwrap();

        // Step 1: Send a Hook Chat event (UserPromptSubmit) with messageID.
        // This stores (sessionId → correlationId) via REQ-3 bridging.
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
        // traceId is different ("otlp-trace-xyz") — bridging should override it.
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

        // REQ-3: The OTLP span should use the Hook-stored correlationId,
        // NOT the traceId.
        assert_eq!(
            otlp_events[0].correlation_id,
            Some("hook-correlation-abc".into()),
            "OTLP span should use Hook-stored correlationId 'hook-correlation-abc', not traceId 'otlp-trace-xyz'"
        );
    }

    // ——— REQ-3: OTLP falls back to traceId when no Hook mapping exists ———

    #[test]
    fn ac_8_otlp_falls_back_to_trace_id_without_hook_mapping() {
        let adapter = OpenCodeAdapter::new();
        let rt = tokio::runtime::Runtime::new().unwrap();

        // Send an OTLP chat span for a session that has no prior Hook event.
        // Should fall back to traceId as correlationId.
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
        // No prior Hook mapping — should use traceId as before
        assert_eq!(
            events[0].correlation_id,
            Some("fallback-trace-789".into()),
            "OTLP span without Hook mapping should fall back to traceId"
        );
    }

    // ——— REQ-13: Subagent session rewrite tests ———

    #[test]
    fn req_13_subsequent_child_session_event_rewrites_session_id_and_preserves_correlation_id() {
        let adapter = OpenCodeAdapter::new();
        let rt = tokio::runtime::Runtime::new().unwrap();

        // Pre-populate child_to_parent mapping (simulating prior session.updated)
        {
            let mut map = adapter.child_to_parent.lock().unwrap();
            map.insert("child-ses-2".to_string(), "parent-ses-2".to_string());
        }

        // Send a chat event for the child session
        let payload = serde_json::json!({
            "event_type": "UserPromptSubmit",
            "properties": {
                "sessionID": "child-ses-2",
                "messageID": "msg-child-2"
            }
        });

        let result = rt.block_on(adapter.transform(Transport::Hook, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        assert_eq!(events.len(), 1);

        // Session ID should be rewritten to parent
        assert_eq!(events[0].session_id, "parent-ses-2");
        assert_eq!(events[0].event_type, EventType::Chat);

        // Correlation ID should be derived from original (child) session ID
        // Since AgentSession hasn't been processed for this session, the
        // Chat event uses messageID as correlationId (stored in session_to_correlation
        // keyed by child-ses-2 which is original_session_id).
        assert_eq!(
            events[0].correlation_id,
            Some("msg-child-2".to_string()),
            "Chat event should use messageID as correlationId for child session"
        );

        // Should have metadata with originalSessionId
        let metadata = events[0].metadata.as_ref().unwrap();
        assert_eq!(
            metadata.get("originalSessionId").and_then(|v| v.as_str()),
            Some("child-ses-2")
        );
    }

    #[test]
    fn req_13_child_session_agent_session_uses_child_session_id_as_correlation_id() {
        let adapter = OpenCodeAdapter::new();
        let rt = tokio::runtime::Runtime::new().unwrap();

        // Pre-populate child_to_parent mapping
        {
            let mut map = adapter.child_to_parent.lock().unwrap();
            map.insert("child-ses-3".to_string(), "parent-ses-3".to_string());
        }

        // Send an AgentSession event (session.created) for the child session
        let payload = serde_json::json!({
            "event_type": "session.created",
            "properties": {
                "sessionID": "child-ses-3",
                "info": { "id": "child-ses-3" }
            }
        });

        let result = rt.block_on(adapter.transform(Transport::Hook, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        assert_eq!(events.len(), 1);

        // Session ID rewritten to parent
        assert_eq!(events[0].session_id, "parent-ses-3");
        assert_eq!(events[0].event_type, EventType::AgentSession);

        // REQ-4: correlationId should be the ORIGINAL (child) session ID
        assert_eq!(
            events[0].correlation_id,
            Some("child-ses-3".to_string()),
            "AgentSession correlationId should use original child session ID, not parent"
        );

        // Now send a subsequent Chat event — it should get the same child-ses-3 correlationId
        // from the session_to_correlation map (which was populated by the AgentSession event)
        let chat_payload = serde_json::json!({
            "event_type": "UserPromptSubmit",
            "properties": {
                "sessionID": "child-ses-3",
                "messageID": "msg-3"
            }
        });

        let chat_result = rt.block_on(adapter.transform(Transport::Hook, chat_payload));
        assert!(chat_result.is_ok());
        let chat_events = chat_result.unwrap();
        assert_eq!(chat_events.len(), 1);

        // Chat event should reuse the stored correlationId = child-ses-3 (not messageID)
        assert_eq!(
            chat_events[0].correlation_id,
            Some("child-ses-3".to_string()),
            "Child session Chat should reuse AgentSession correlationId (child session ID)"
        );

        // Both should have same correlationId ensuring single ECE buffer
        assert_eq!(events[0].correlation_id, chat_events[0].correlation_id);
    }

    #[test]
    fn req_13_event_without_parent_id_does_not_rewrite() {
        let adapter = OpenCodeAdapter::new();
        let rt = tokio::runtime::Runtime::new().unwrap();

        // Normal session.updated WITHOUT parentID
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

        // Session ID unchanged
        assert_eq!(events[0].session_id, "normal-session");
        assert_eq!(events[0].event_type, EventType::AgentSession);

        // No metadata
        assert!(events[0].metadata.is_none());

        // No mapping stored
        let map = adapter.child_to_parent.lock().unwrap();
        assert!(map.is_empty());
    }

    #[test]
    fn req_13_multiple_child_sessions_have_unique_correlation_ids() {
        let adapter = OpenCodeAdapter::new();
        let rt = tokio::runtime::Runtime::new().unwrap();

        // Pre-populate mappings for two child sessions under the same parent
        {
            let mut map = adapter.child_to_parent.lock().unwrap();
            map.insert("child-A".to_string(), "parent-X".to_string());
            map.insert("child-B".to_string(), "parent-X".to_string());
        }

        // Send AgentSession events for both child sessions
        let payload_a = serde_json::json!({
            "event_type": "session.created",
            "properties": {
                "sessionID": "child-A",
                "info": { "id": "child-A" }
            }
        });

        let payload_b = serde_json::json!({
            "event_type": "session.created",
            "properties": {
                "sessionID": "child-B",
                "info": { "id": "child-B" }
            }
        });

        let result_a = rt.block_on(adapter.transform(Transport::Hook, payload_a));
        assert!(result_a.is_ok());
        let events_a = result_a.unwrap();
        assert_eq!(events_a.len(), 1);
        assert_eq!(events_a[0].correlation_id, Some("child-A".to_string()));

        let result_b = rt.block_on(adapter.transform(Transport::Hook, payload_b));
        assert!(result_b.is_ok());
        let events_b = result_b.unwrap();
        assert_eq!(events_b.len(), 1);
        assert_eq!(events_b[0].correlation_id, Some("child-B".to_string()));

        // Both rewrite sessionId to same parent
        assert_eq!(events_a[0].session_id, "parent-X");
        assert_eq!(events_b[0].session_id, "parent-X");

        // But correlationIds are DIFFERENT (unique per child)
        assert_ne!(
            events_a[0].correlation_id,
            events_b[0].correlation_id,
            "Each child session should have a unique correlationId"
        );

        // Verify they have correct metadata
        let meta_a = events_a[0].metadata.as_ref().unwrap();
        assert_eq!(
            meta_a.get("originalSessionId").and_then(|v| v.as_str()),
            Some("child-A")
        );
        let meta_b = events_b[0].metadata.as_ref().unwrap();
        assert_eq!(
            meta_b.get("originalSessionId").and_then(|v| v.as_str()),
            Some("child-B")
        );
    }

    // ——— REQ-1: PostToolUse `task` populates child_to_parent map ———

    #[test]
    fn req_1_post_tool_use_task_populates_child_to_parent_map() {
        let adapter = OpenCodeAdapter::new();
        let rt = tokio::runtime::Runtime::new().unwrap();

        // PostToolUse `task` event with tool_response.metadata containing
        // sessionId (child) and parentSessionId (parent).
        let payload = serde_json::json!({
            "event_type": "PostToolUse",
            "tool_name": "task",
            "tool_response": {
                "metadata": {
                    "sessionId": "child-ses-task",
                    "parentSessionId": "parent-ses-task"
                },
                "result": "Subagent completed successfully"
            },
            "properties": {
                "sessionID": "parent-ses-task"
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
        assert_eq!(events[0].session_id, "parent-ses-task");

        // Verify the mapping was stored internally: child_sesion → parent_sesion
        let map = adapter.child_to_parent.lock().unwrap();
        assert_eq!(
            map.get("child-ses-task").map(|s| s.as_str()),
            Some("parent-ses-task")
        );
        assert_eq!(map.len(), 1);
    }

    // ——— REQ-5: Whitelist-based @-subagent detection via session.updated ———

    #[test]
    fn req_5_general_subagent_session_updated_populates_map() {
        let adapter = OpenCodeAdapter::new();
        let rt = tokio::runtime::Runtime::new().unwrap();

        // session.updated with agent="general" (whitelisted) + parentID
        let payload = serde_json::json!({
            "event_type": "session.updated",
            "properties": {
                "sessionID": "child-ses-gen",
                "info": {
                    "id": "child-ses-gen",
                    "parentID": "parent-ses-gen",
                    "agent": "general"
                }
            }
        });

        let result = rt.block_on(adapter.transform(Transport::Hook, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        assert_eq!(events.len(), 1);

        // Event passes through with original sessionId (not rewritten)
        assert_eq!(events[0].event_type, EventType::AgentSession);
        assert_eq!(events[0].state, EventState::Update);
        assert_eq!(events[0].session_id, "child-ses-gen");

        // Map populated: child_sesion → parent_sesion
        let map = adapter.child_to_parent.lock().unwrap();
        assert_eq!(
            map.get("child-ses-gen").map(|s| s.as_str()),
            Some("parent-ses-gen")
        );
        assert_eq!(map.len(), 1);
    }

    #[test]
    fn req_5_architect_subagent_session_updated_populates_map() {
        let adapter = OpenCodeAdapter::new();
        let rt = tokio::runtime::Runtime::new().unwrap();

        // session.updated with agent="architect" (whitelisted) + parentID
        let payload = serde_json::json!({
            "event_type": "session.updated",
            "properties": {
                "sessionID": "child-ses-arch",
                "info": {
                    "id": "child-ses-arch",
                    "parentID": "parent-ses-arch",
                    "agent": "architect"
                }
            }
        });

        let result = rt.block_on(adapter.transform(Transport::Hook, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].session_id, "child-ses-arch");

        let map = adapter.child_to_parent.lock().unwrap();
        assert_eq!(
            map.get("child-ses-arch").map(|s| s.as_str()),
            Some("parent-ses-arch")
        );
        assert_eq!(map.len(), 1);
    }

    #[test]
    fn req_5_subsequent_event_after_whitelist_detection_gets_rewritten() {
        let adapter = OpenCodeAdapter::new();
        let rt = tokio::runtime::Runtime::new().unwrap();

        // Step 1: session.updated with whitelisted agent → populates map
        let session_updated = serde_json::json!({
            "event_type": "session.updated",
            "properties": {
                "sessionID": "child-ses-seq",
                "info": {
                    "id": "child-ses-seq",
                    "parentID": "parent-ses-seq",
                    "agent": "general"
                }
            }
        });
        let result1 = rt.block_on(adapter.transform(Transport::Hook, session_updated));
        assert!(result1.is_ok());
        let events1 = result1.unwrap();
        assert_eq!(events1.len(), 1);
        // session.updated itself passes through with original sessionId
        assert_eq!(events1[0].session_id, "child-ses-seq");

        // Step 2: session.created (subsequent event) — sessionId should be rewritten
        let session_created = serde_json::json!({
            "event_type": "session.created",
            "properties": {
                "sessionID": "child-ses-seq",
                "info": {
                    "id": "child-ses-seq"
                }
            }
        });
        let result2 = rt.block_on(adapter.transform(Transport::Hook, session_created));
        assert!(result2.is_ok());
        let events2 = result2.unwrap();
        assert_eq!(events2.len(), 1);

        // Session ID rewritten to parent
        assert_eq!(events2[0].session_id, "parent-ses-seq");
        assert_eq!(events2[0].event_type, EventType::AgentSession);
        assert_eq!(events2[0].state, EventState::Init);

        // CorrelationId should be the original (child) session ID
        assert_eq!(
            events2[0].correlation_id,
            Some("child-ses-seq".to_string())
        );

        // Metadata should preserve originalSessionId
        let meta = events2[0].metadata.as_ref().unwrap();
        assert_eq!(
            meta.get("originalSessionId").and_then(|v| v.as_str()),
            Some("child-ses-seq")
        );

        // Map has 1 entry
        let map = adapter.child_to_parent.lock().unwrap();
        assert_eq!(map.len(), 1);
        assert_eq!(
            map.get("child-ses-seq").map(|s| s.as_str()),
            Some("parent-ses-seq")
        );
    }

    #[test]
    fn req_5_bash_subagent_session_updated_skips_map() {
        let adapter = OpenCodeAdapter::new();
        let rt = tokio::runtime::Runtime::new().unwrap();

        // session.updated with agent="bash" (NOT whitelisted) + parentID
        let payload = serde_json::json!({
            "event_type": "session.updated",
            "properties": {
                "sessionID": "child-ses-bash",
                "info": {
                    "id": "child-ses-bash",
                    "parentID": "parent-ses-bash",
                    "agent": "bash"
                }
            }
        });

        let result = rt.block_on(adapter.transform(Transport::Hook, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].session_id, "child-ses-bash");

        // Map should NOT be populated
        let map = adapter.child_to_parent.lock().unwrap();
        assert!(map.is_empty());
    }

    #[test]
    fn req_5_read_subagent_session_updated_skips_map() {
        let adapter = OpenCodeAdapter::new();
        let rt = tokio::runtime::Runtime::new().unwrap();

        let payload = serde_json::json!({
            "event_type": "session.updated",
            "properties": {
                "sessionID": "child-ses-read",
                "info": {
                    "id": "child-ses-read",
                    "parentID": "parent-ses-read",
                    "agent": "read"
                }
            }
        });

        let result = rt.block_on(adapter.transform(Transport::Hook, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].session_id, "child-ses-read");

        let map = adapter.child_to_parent.lock().unwrap();
        assert!(map.is_empty());
    }

    #[test]
    fn req_5_build_subagent_session_updated_skips_map() {
        let adapter = OpenCodeAdapter::new();
        let rt = tokio::runtime::Runtime::new().unwrap();

        let payload = serde_json::json!({
            "event_type": "session.updated",
            "properties": {
                "sessionID": "child-ses-build",
                "info": {
                    "id": "child-ses-build",
                    "parentID": "parent-ses-build",
                    "agent": "build"
                }
            }
        });

        let result = rt.block_on(adapter.transform(Transport::Hook, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].session_id, "child-ses-build");

        let map = adapter.child_to_parent.lock().unwrap();
        assert!(map.is_empty());
    }

    #[test]
    fn req_5_plan_subagent_session_updated_skips_map() {
        let adapter = OpenCodeAdapter::new();
        let rt = tokio::runtime::Runtime::new().unwrap();

        let payload = serde_json::json!({
            "event_type": "session.updated",
            "properties": {
                "sessionID": "child-ses-plan",
                "info": {
                    "id": "child-ses-plan",
                    "parentID": "parent-ses-plan",
                    "agent": "plan"
                }
            }
        });

        let result = rt.block_on(adapter.transform(Transport::Hook, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].session_id, "child-ses-plan");

        let map = adapter.child_to_parent.lock().unwrap();
        assert!(map.is_empty());
    }

    #[test]
    fn req_5_session_updated_without_agent_field_no_parent_id_skips_map() {
        let adapter = OpenCodeAdapter::new();
        let rt = tokio::runtime::Runtime::new().unwrap();

        // session.updated with parentID but NO agent field → conservative: skip
        let payload = serde_json::json!({
            "event_type": "session.updated",
            "properties": {
                "sessionID": "child-ses-noagent",
                "info": {
                    "id": "child-ses-noagent",
                    "parentID": "parent-ses-noagent"
                    // no "agent" field
                }
            }
        });

        let result = rt.block_on(adapter.transform(Transport::Hook, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].session_id, "child-ses-noagent");

        // Map should NOT be populated
        let map = adapter.child_to_parent.lock().unwrap();
        assert!(map.is_empty());
    }

}


