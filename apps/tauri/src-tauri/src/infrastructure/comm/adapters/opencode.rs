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
use crate::infrastructure::comm::event::{EventProvider, EventState, EventType, FredoEvent, Transport};

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
}

impl OpenCodeAdapter {
    /// Create a new OpenCodeAdapter.
    pub fn new() -> Self {
        OpenCodeAdapter {
            trace_to_session: Arc::new(Mutex::new(HashMap::new())),
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
        // Extract session_id once from the top-level raw event — all events
        // from the SDK include it. Falls back to "opencode-session" for legacy.
        let session_id = raw
            .get("session_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| "opencode-session".to_string());
        let session_id = session_id.as_str();

        // Detect hook event type by examining the payload structure
        // PreToolUse: has tool_input
        // PostToolUse: has tool_response (and no error)
        // PostToolUseFailure: has error field
        // Lifecycle: has session_id or explicit event_type field

        // Check for explicit event_type first
        if let Some(event_type) = raw.get("event_type").and_then(|v| v.as_str()) {
            match event_type {
                // ── Tool use events ──────────────────────────────────────────
                "PreToolUse" => return self.transform_pre_tool_use(raw, session_id),
                "PostToolUse" => return self.transform_post_tool_use(raw, session_id),
                "PostToolUseFailure" => return self.transform_post_tool_use_failure(raw, session_id),

                // ── Permission events ────────────────────────────────────────
                "permission.asked" => return self.transform_with_event_type(raw, EventType::Custom, EventState::Init, "permission.asked", session_id),
                "permission.replied" => return self.transform_with_event_type(raw, EventType::Custom, EventState::Response, "permission.replied", session_id),

                // ── File / command events ────────────────────────────────────
                "file.edited" => return self.transform_with_event_type(raw, EventType::Custom, EventState::Response, "file.edited", session_id),
                "command.executed" => return self.transform_with_event_type(raw, EventType::Custom, EventState::Response, "command.executed", session_id),

                // ── Chat / message events ────────────────────────────────────
                "UserPromptSubmit" => return self.transform_with_event_type(raw, EventType::Chat, EventState::Init, "UserPromptSubmit", session_id),
                "chat.message" => return self.transform_with_event_type(raw, EventType::Chat, EventState::Response, "chat.message", session_id),
                // Message update/delta events: extract properties for cleaner payload
                "message.updated"
                | "message.part.updated"
                | "message.part.delta"
                | "message.removed"
                | "message.part.removed" => {
                    let inner = raw.get("properties").unwrap_or(&raw);
                    return self.transform_with_event_type(inner.clone(), EventType::Chat, EventState::Update, event_type, session_id);
                }

                // ── Subagent events ──────────────────────────────────────────
                "SubagentStart" => return self.transform_with_event_type(raw, EventType::Chat, EventState::Init, "SubagentStart", session_id),

                // ── Session lifecycle events ─────────────────────────────────
                "SessionStart" => return self.transform_with_event_type(raw, EventType::AgentSession, EventState::Init, "SessionStart", session_id),
                "SessionEnd" => return self.transform_with_event_type(raw, EventType::AgentSession, EventState::Response, "SessionEnd", session_id),
                "session.created" => return self.transform_with_event_type(raw, EventType::AgentSession, EventState::Init, "session.created", session_id),
                "session.updated" => return self.transform_with_event_type(raw, EventType::AgentSession, EventState::Update, "session.updated", session_id),
                "session.deleted" => return self.transform_with_event_type(raw, EventType::AgentSession, EventState::Response, "session.deleted", session_id),
                "session.status" => return self.transform_with_event_type(raw, EventType::AgentSession, EventState::Update, "session.status", session_id),
                "session.error" => return self.transform_with_event_type(raw, EventType::AgentSession, EventState::Error, "session.error", session_id),
                "session.idle" => return self.transform_with_event_type(raw, EventType::AgentSession, EventState::Update, "session.idle", session_id),

                // ── Session next-turn events ─────────────────────────────────
                "session.next.tool.called" => return self.transform_with_event_type(raw, EventType::ToolUse, EventState::Init, "session.next.tool.called", session_id),
                "session.next.tool.success" => return self.transform_with_event_type(raw, EventType::ToolUse, EventState::Response, "session.next.tool.success", session_id),
                "session.next.tool.failed" => return self.transform_with_event_type(raw, EventType::ToolUse, EventState::Error, "session.next.tool.failed", session_id),
                "session.next.text.delta" => return self.transform_with_event_type(raw, EventType::Chat, EventState::Update, "session.next.text.delta", session_id),
                "session.next.text.started" => return self.transform_with_event_type(raw, EventType::Chat, EventState::Init, "session.next.text.started", session_id),
                "session.next.text.ended" => return self.transform_with_event_type(raw, EventType::Chat, EventState::Response, "session.next.text.ended", session_id),
                "session.next.step.started" => return self.transform_with_event_type(raw, EventType::AgentSession, EventState::Init, "session.next.step.started", session_id),
                "session.next.step.ended" => return self.transform_with_event_type(raw, EventType::AgentSession, EventState::Response, "session.next.step.ended", session_id),
                "session.next.agent.switched" => return self.transform_with_event_type(raw, EventType::AgentSession, EventState::Update, "session.next.agent.switched", session_id),

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

        // Unknown event type — return empty vec (graceful handling)
        Ok(vec![])
    }

    /// Transform PreToolUse hook event.
    fn transform_pre_tool_use(&self, raw: Value, session_id: &str) -> anyhow::Result<Vec<FredoEvent>> {
        let tool_name = raw
            .get("tool_name")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let tool_input = raw.get("tool_input").cloned();
        let tool_use_id = raw
            .get("tool_use_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let correlation_id = tool_use_id.clone();

        let mut event = FredoEvent::builder()
            .event_type(EventType::ToolUse)
            .state(EventState::Init)
            .provider(EventProvider::OpenCode)
            .transport(Transport::Hook)
            .session_id(session_id)
            .tool_name(tool_name.unwrap_or_default())
            .correlation_id(correlation_id.unwrap_or_default())
            .build();

        if let Some(input) = tool_input {
            event.payload = Some(input);
        }

        Ok(vec![event])
    }

    /// Transform PostToolUse hook event.
    fn transform_post_tool_use(&self, raw: Value, session_id: &str) -> anyhow::Result<Vec<FredoEvent>> {
        let tool_name = raw
            .get("tool_name")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let tool_response = raw.get("tool_response").cloned();
        let tool_use_id = raw
            .get("tool_use_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let correlation_id = tool_use_id.clone();

        let mut event = FredoEvent::builder()
            .event_type(EventType::ToolUse)
            .state(EventState::Response)
            .provider(EventProvider::OpenCode)
            .transport(Transport::Hook)
            .session_id(session_id)
            .tool_name(tool_name.unwrap_or_default())
            .correlation_id(correlation_id.unwrap_or_default())
            .build();

        if let Some(response) = tool_response {
            event.payload = Some(response);
        }

        Ok(vec![event])
    }

    /// Transform PostToolUseFailure hook event.
    fn transform_post_tool_use_failure(&self, raw: Value, session_id: &str) -> anyhow::Result<Vec<FredoEvent>> {
        let tool_name = raw
            .get("tool_name")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let error_msg = raw
            .get("error")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| "Unknown error".to_string());
        let tool_use_id = raw
            .get("tool_use_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let correlation_id = tool_use_id.clone();

        let event = FredoEvent::builder()
            .event_type(EventType::ToolUse)
            .state(EventState::Error)
            .provider(EventProvider::OpenCode)
            .transport(Transport::Hook)
            .session_id(session_id)
            .tool_name(tool_name.unwrap_or_default())
            .correlation_id(correlation_id.unwrap_or_default())
            .error(crate::infrastructure::comm::event::FredoEventError {
                message: error_msg,
                code: None,
                details: None,
            })
            .build();

        Ok(vec![event])
    }

    /// Generic helper for events that map 1:1 to a single FredoEvent.
    fn transform_with_event_type(
        &self,
        raw: Value,
        event_type: EventType,
        state: EventState,
        tool_name: &str,
        session_id: &str,
    ) -> anyhow::Result<Vec<FredoEvent>> {
        let mut event = FredoEvent::builder()
            .event_type(event_type)
            .state(state)
            .provider(EventProvider::OpenCode)
            .transport(Transport::Hook)
            .session_id(session_id)
            .tool_name(tool_name)
            .build();

        // Pass through the raw payload so the frontend can extract
        // scope/tool details, user decisions, file paths, etc.
        event.payload = Some(raw);

        Ok(vec![event])
    }

    /// Transform lifecycle event (SessionStart, SessionEnd, etc.) into AgentSession/Init.
    fn transform_lifecycle_event(&self, raw: Value, session_id: &str) -> anyhow::Result<Vec<FredoEvent>> {
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
                        Value::String(s.to_string())
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
        for op in &["chat", "invoke_agent", "execute_tool", "permission", "elicitation"] {
            if name == *op || name.starts_with(&format!("{} ", op)) {
                return Some(op);
            }
        }
        None
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
                let res_attrs = Self::otlp_attrs_to_map(rs.get("resource").and_then(|r| r.get("attributes")));
                let scope_spans = rs.get("scopeSpans").and_then(|v| v.as_array()).cloned().unwrap_or_default();
                for scope in &scope_spans {
                    let spans = scope.get("spans").and_then(|v| v.as_array()).cloned().unwrap_or_default();
                    for span in &spans {
                        let span_name = span.get("name").and_then(|v| v.as_str()).unwrap_or("span");
                        let span_attrs = Self::otlp_attrs_to_map(span.get("attributes"));

                        // Resolve canonical op name
                        let op_name = span_attrs.get("gen_ai.operation.name")
                            .and_then(|v| v.as_str())
                            .and_then(Self::normalize_op_name)
                            .or_else(|| Self::normalize_op_name(span_name));

                        let op_name = match op_name {
                            Some(op) => op,
                            None => continue, // chat, metrics, unknown — drop
                        };

                        // Resolve session id
                        let trace_id = span.get("traceId").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let session_id = span_attrs.get("gen_ai.conversation.id")
                            .and_then(|v| v.as_str())
                            .map(str::to_owned)
                            .or_else(|| {
                                self.trace_to_session
                                    .lock()
                                    .ok()
                                    .and_then(|m| m.get(&trace_id).cloned())
                            })
                            .unwrap_or_else(|| {
                                if !trace_id.is_empty() { trace_id.clone() }
                                else { Uuid::new_v4().to_string() }
                            });

                        // Store trace-to-conversation mapping if we have conversation.id
                        if let Some(conv_id) = span_attrs.get("gen_ai.conversation.id").and_then(|v| v.as_str()) {
                            if let Ok(mut map) = self.trace_to_session.lock() {
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

                        events.push(FredoEvent::builder()
                            .event_type(event_type)
                            .state(EventState::Response)
                            .provider(provider)
                            .transport(Transport::OtlpGrpc)
                            .session_id(session_id)
                            .tool_name(op_name)
                            .payload(Value::Object(merged))
                            .build());
                    }
                }
            }
            return Ok(events);
        }

        // Flat/custom JSON (OpenCode file-exporter style)
        let raw_name = raw.get("name").and_then(|v| v.as_str()).unwrap_or("otlp.span");
        let attrs = Self::otlp_attrs_to_map(raw.get("attributes"));

        // Normalize op_name for correct event type classification
        let op_name = Self::normalize_op_name(raw_name).unwrap_or(raw_name);

        // REQ-1.1, REQ-1.2: chat + invoke_agent → Chat/Response
        let event_type = match op_name {
            "chat" | "invoke_agent" => EventType::Chat,
            _ => EventType::ToolUse,
        };

        let session_id = attrs.get("gen_ai.conversation.id")
            .and_then(|v| v.as_str())
            .map(str::to_owned)
            .unwrap_or_else(|| Uuid::new_v4().to_string());

        events.push(FredoEvent::builder()
            .event_type(event_type)
            .state(EventState::Response)
            .provider(provider)
            .transport(Transport::OtlpGrpc)
            .session_id(session_id)
            .tool_name(op_name)
            .payload(Value::Object(attrs))
            .build());

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
            "tool_use_id": "pre-tool-123"
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
            "tool_use_id": "post-tool-456"
        });

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(adapter.transform(Transport::Hook, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].state, EventState::Response);
    }

    #[test]
    fn transform_hook_subagent_start() {
        let adapter = OpenCodeAdapter::new();
        let payload = serde_json::json!({
            "event_type": "SubagentStart",
            "session_id": "session-sub-001",
            "subagent_name": "CodeAnalyzer",
            "task": "analyze codebase structure"
        });

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(adapter.transform(Transport::Hook, payload.clone()));
        assert!(result.is_ok());
        let events = result.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, EventType::Chat);
        assert_eq!(events[0].state, EventState::Init);
        assert_eq!(events[0].tool_name, Some("SubagentStart".into()));
        assert_eq!(events[0].session_id, "session-sub-001");
        // Payload should contain the full raw data preserving subagent name
        if let Some(ref payload_val) = events[0].payload {
            assert_eq!(payload_val.get("subagent_name").and_then(|v| v.as_str()), Some("CodeAnalyzer"));
            assert_eq!(payload_val.get("task").and_then(|v| v.as_str()), Some("analyze codebase structure"));
        } else {
            panic!("Expected payload to be present");
        }
    }

    #[test]
    fn transform_hook_posttoolusefailure() {
        let adapter = OpenCodeAdapter::new();
        let payload = serde_json::json!({
            "tool_name": "Bash",
            "error": "Command failed",
            "tool_use_id": "fail-tool-789"
        });

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(adapter.transform(Transport::Hook, payload));
        assert!(result.is_ok());
        let events = result.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].state, EventState::Error);
        assert!(events[0].error.is_some());
    }
}