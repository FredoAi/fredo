//! Unit tests for OpenCodeAdapter.
//!
//! Tests the contract defined in Spec 2 REQ-2.1 through REQ-2.4:
//! - OpenCodeAdapter implements CommAdapter
//! - Hook transform produces FredoEvent with correct event_type, state, correlation_id
//! - OTLP transform produces FredoEvent from invoke_agent and execute_tool spans
//! - Session tracking (trace-to-conversation) consolidated into adapter
//!
//! REQ-2.1: OpenCodeAdapter implements CommAdapter and handles both IPC hook and OTLP events
//! REQ-2.2: Hook transform produces correct FredoEvent for PreToolUse, PostToolUse, PostToolUseFailure
//! REQ-2.3: OTLP transform produces FredoEvent for invoke_agent (AgentSession) and execute_tool (ToolUse) spans
//! REQ-2.4: Session tracking (trace-to-conversation) held internally as Mutex<HashMap>

use crate::infrastructure::comm::*;
use crate::infrastructure::comm::adapter::CommAdapter;
use crate::infrastructure::comm::adapters::opencode::OpenCodeAdapter;

// ── CommAdapter implementation tests ─────────────────────────────────────────

#[cfg(test)]
mod opencode_adapter_comm_adapter_tests {
    use super::*;

    /// REQ-2.1: OpenCodeAdapter implements CommAdapter
    #[test]
    fn opencode_adapter_implements_comm_adapter() {
        let adapter = OpenCodeAdapter::new();
        // OpenCodeAdapter must satisfy the CommAdapter trait
        // This test verifies name() and provider() work
        assert_eq!(adapter.name(), "opencode");
        assert_eq!(adapter.provider(), EventProvider::OpenCode);
    }

    /// REQ-2.1: OpenCodeAdapter can be shared across threads (Send + Sync)
    #[test]
    fn opencode_adapter_is_send_and_sync() {
        fn assert_send<T: Send + Sync>() {}
        assert_send::<OpenCodeAdapter>();
    }
}

// ── Hook transform tests ───────────────────────────────────────────────────────

#[cfg(test)]
mod opencode_adapter_hook_transform_tests {
    use super::*;

    /// REQ-2.2: PreToolUse hook produces FredoEvent with event_type: ToolUse, state: Init, correlation_id from tool_use_id
    #[test]
    fn pretooluse_hook_produces_tool_use_init_event() {
        let adapter = OpenCodeAdapter::new();
        let payload = serde_json::json!({
            "tool_name": "Bash",
            "tool_input": { "command": "ls -la" },
            "tool_use_id": "pre-tool-123"
        });

        let events = tokio_test::block_on(
            adapter.transform(Transport::Hook, payload)
        );

        assert!(events.is_ok(), "PreToolUse transform should succeed: {:?}", events);
        let events = events.unwrap();
        assert_eq!(events.len(), 1, "PreToolUse should produce exactly 1 event");

        let event = &events[0];
        assert_eq!(event.event_type, EventType::ToolUse, "PreToolUse should produce ToolUse event");
        assert_eq!(event.state, EventState::Init, "PreToolUse should have Init state");
        assert_eq!(event.correlation_id, Some("pre-tool-123".into()), "correlation_id should be tool_use_id");
        assert_eq!(event.provider, EventProvider::OpenCode, "Provider should be OpenCode");
        assert_eq!(event.transport, Transport::Hook, "Transport should be Hook");
        assert_eq!(event.tool_name, Some("Bash".into()), "tool_name should be extracted");
    }

    /// REQ-2.2: PostToolUse hook produces FredoEvent with event_type: ToolUse, state: Response
    #[test]
    fn posttooluse_hook_produces_tool_use_response_event() {
        let adapter = OpenCodeAdapter::new();
        let payload = serde_json::json!({
            "tool_name": "Bash",
            "tool_response": { "stdout": "file1 file2" },
            "tool_use_id": "post-tool-456"
        });

        let events = tokio_test::block_on(
            adapter.transform(Transport::Hook, payload)
        );

        assert!(events.is_ok(), "PostToolUse transform should succeed: {:?}", events);
        let events = events.unwrap();
        assert_eq!(events.len(), 1);

        let event = &events[0];
        assert_eq!(event.event_type, EventType::ToolUse);
        assert_eq!(event.state, EventState::Response, "PostToolUse should have Response state");
        assert_eq!(event.correlation_id, Some("post-tool-456".into()));
        assert_eq!(event.provider, EventProvider::OpenCode);
    }

    /// REQ-2.2: PostToolUseFailure hook produces FredoEvent with state: Error
    #[test]
    fn posttoolusefailure_hook_produces_error_event() {
        let adapter = OpenCodeAdapter::new();
        let payload = serde_json::json!({
            "tool_name": "Bash",
            "error": "Command failed with exit code 1",
            "tool_use_id": "fail-tool-789"
        });

        let events = tokio_test::block_on(
            adapter.transform(Transport::Hook, payload)
        );

        assert!(events.is_ok(), "PostToolUseFailure transform should succeed: {:?}", events);
        let events = events.unwrap();
        assert_eq!(events.len(), 1);

        let event = &events[0];
        assert_eq!(event.event_type, EventType::ToolUse);
        assert_eq!(event.state, EventState::Error, "PostToolUseFailure should have Error state");
        assert_eq!(event.correlation_id, Some("fail-tool-789".into()));
        assert!(event.error.is_some(), "Error state should have error detail");
    }

    /// REQ-2.2: Lifecycle events (SessionStart, SessionEnd, etc.) produce AgentSession events
    #[test]
    fn lifecycle_hook_produces_agent_session_event() {
        let adapter = OpenCodeAdapter::new();
        let payload = serde_json::json!({
            "session_id": "session-abc",
            "timestamp": "2026-05-21T10:00:00Z"
        });

        let events = tokio_test::block_on(
            adapter.transform(Transport::Hook, serde_json::json!({
                "event_type": "SessionStart",
                "payload": payload
            }))
        );

        assert!(events.is_ok(), "Lifecycle event transform should succeed: {:?}", events);
        let events = events.unwrap();
        assert_eq!(events.len(), 1);

        let event = &events[0];
        assert_eq!(event.event_type, EventType::AgentSession, "Lifecycle events should produce AgentSession");
        assert_eq!(event.state, EventState::Init, "Lifecycle events should have Init state");
        assert_eq!(event.provider, EventProvider::OpenCode);
    }

    /// REQ-2.2: Unknown event types are gracefully handled (return empty vec or error)
    #[test]
    fn unknown_hook_event_type_returns_empty_or_error() {
        let adapter = OpenCodeAdapter::new();
        let payload = serde_json::json!({
            "event_type": "UnknownEvent",
            "payload": {}
        });

        let events = tokio_test::block_on(
            adapter.transform(Transport::Hook, payload)
        );

        // Unknown events should either return empty vec or be gracefully handled
        // (not panic, not crash)
        assert!(events.is_ok(), "Unknown hook event should be handled gracefully");
    }
}

// ── OTLP transform tests ───────────────────────────────────────────────────────

#[cfg(test)]
mod opencode_adapter_otlp_transform_tests {
    use super::*;

    /// REQ-2.3: OTLP invoke_agent spans produce FredoEvent with event_type: AgentSession
    #[test]
    fn invoke_agent_span_produces_agent_session_event() {
        let adapter = OpenCodeAdapter::new();

        // Simulate OTLP span data (invoke_agent)
        let span_data = serde_json::json!({
            "resourceSpans": [{
                "resource": {
                    "attributes": [
                        { "key": "service.name", "value": { "stringValue": "opencode" } }
                    ]
                },
                "scopeSpans": [{
                    "spans": [{
                        "name": "invoke_agent",
                        "traceId": "abc123def456",
                        "spanId": "span001",
                        "kind": 1,
                        "attributes": [
                            { "key": "gen_ai.operation.name", "value": { "stringValue": "invoke_agent" } },
                            { "key": "gen_ai.conversation.id", "value": { "stringValue": "conv-789" } },
                            { "key": "gen_ai.request.model", "value": { "stringValue": "claude-3-5-sonnet" } }
                        ]
                    }]
                }]
            }]
        });

        let events = tokio_test::block_on(
            adapter.transform(Transport::OtlpGrpc, span_data)
        );

        assert!(events.is_ok(), "invoke_agent OTLP transform should succeed: {:?}", events);
        let events = events.unwrap();
        assert!(!events.is_empty(), "invoke_agent span should produce at least 1 event");

        // Find the invoke_agent event
        let invoke_event = events.iter().find(|e| e.event_type == EventType::AgentSession);
        assert!(invoke_event.is_some(), "invoke_agent span should produce AgentSession event");
        let event = invoke_event.unwrap();
        assert_eq!(event.provider, EventProvider::OpenCode);
        assert_eq!(event.transport, Transport::OtlpGrpc);
        assert_eq!(event.session_id, "conv-789", "session_id from gen_ai.conversation.id");
    }

    /// REQ-2.3: OTLP execute_tool spans produce FredoEvent with event_type: ToolUse
    #[test]
    fn execute_tool_span_produces_tool_use_event() {
        let adapter = OpenCodeAdapter::new();

        let span_data = serde_json::json!({
            "resourceSpans": [{
                "resource": {
                    "attributes": [
                        { "key": "service.name", "value": { "stringValue": "opencode" } }
                    ]
                },
                "scopeSpans": [{
                    "spans": [{
                        "name": "execute_tool",
                        "traceId": "abc123def456",
                        "spanId": "span002",
                        "kind": 1,
                        "attributes": [
                            { "key": "gen_ai.operation.name", "value": { "stringValue": "execute_tool" } },
                            { "key": "gen_ai.conversation.id", "value": { "stringValue": "conv-789" } },
                            { "key": "tool.name", "value": { "stringValue": "Bash" } }
                        ]
                    }]
                }]
            }]
        });

        let events = tokio_test::block_on(
            adapter.transform(Transport::OtlpHttp, span_data)
        );

        assert!(events.is_ok(), "execute_tool OTLP transform should succeed: {:?}", events);
        let events = events.unwrap();
        assert!(!events.is_empty(), "execute_tool span should produce at least 1 event");

        let tool_event = events.iter().find(|e| e.event_type == EventType::ToolUse);
        assert!(tool_event.is_some(), "execute_tool span should produce ToolUse event");
        let event = tool_event.unwrap();
        assert_eq!(event.provider, EventProvider::OpenCode);
        assert_eq!(event.transport, Transport::OtlpHttp);
    }

    /// REQ-2.3: execute_tool spans without conversation.id use trace-to-conversation mapping
    #[test]
    fn execute_tool_derives_session_from_trace_mapping() {
        let adapter = OpenCodeAdapter::new();

        // First: invoke_agent span with conversation.id (populates the map)
        let invoke_payload = serde_json::json!({
            "resourceSpans": [{
                "scopeSpans": [{
                    "spans": [{
                        "name": "invoke_agent",
                        "traceId": "trace-shared-001",
                        "attributes": [
                            { "key": "gen_ai.operation.name", "value": { "stringValue": "invoke_agent" } },
                            { "key": "gen_ai.conversation.id", "value": { "stringValue": "mapped-conv-001" } }
                        ]
                    }]
                }]
            }]
        });

        // Second: execute_tool span WITHOUT conversation.id (should use trace mapping)
        let execute_payload = serde_json::json!({
            "resourceSpans": [{
                "scopeSpans": [{
                    "spans": [{
                        "name": "execute_tool",
                        "traceId": "trace-shared-001",
                        "attributes": [
                            { "key": "gen_ai.operation.name", "value": { "stringValue": "execute_tool" } }
                            // Note: no gen_ai.conversation.id here
                        ]
                    }]
                }]
            }]
        });

        // First call populates the trace-to-conversation map
        let invoke_events = tokio_test::block_on(
            adapter.transform(Transport::OtlpGrpc, invoke_payload)
        );
        assert!(invoke_events.is_ok());

        // Second call should derive session from the trace mapping
        let execute_events = tokio_test::block_on(
            adapter.transform(Transport::OtlpGrpc, execute_payload)
        );
        assert!(execute_events.is_ok(), "execute_tool with mapped trace should succeed: {:?}", execute_events);
        let execute_events = execute_events.unwrap();

        // The execute_tool event should have the mapped session_id
        let tool_event = execute_events.iter().find(|e| e.event_type == EventType::ToolUse);
        assert!(tool_event.is_some(), "execute_tool event should exist");
        let event = tool_event.unwrap();
        assert_eq!(
            event.session_id, "mapped-conv-001",
            "execute_tool without conversation.id should use trace-to-conversation mapping"
        );
    }
}

// ── Session tracking tests ─────────────────────────────────────────────────────

#[cfg(test)]
mod opencode_adapter_session_tracking_tests {
    use super::*;

    /// REQ-2.4: OpenCodeAdapter holds trace-to-conversation state internally
    #[test]
    fn adapter_holds_trace_to_conversation_state() {
        let adapter = OpenCodeAdapter::new();

        // The adapter should have internal state for trace-to-conversation mapping
        // This is verified by the fact that subsequent execute_tool calls can derive
        // session_id from earlier invoke_agent calls with the same traceId

        let invoke_payload = serde_json::json!({
            "resourceSpans": [{
                "scopeSpans": [{
                    "spans": [{
                        "name": "invoke_agent",
                        "traceId": "same-trace-for-session",
                        "attributes": [
                            { "key": "gen_ai.operation.name", "value": { "stringValue": "invoke_agent" } },
                            { "key": "gen_ai.conversation.id", "value": { "stringValue": "session-from-invoke" } }
                        ]
                    }]
                }]
            }]
        });

        let execute_payload = serde_json::json!({
            "resourceSpans": [{
                "scopeSpans": [{
                    "spans": [{
                        "name": "execute_tool",
                        "traceId": "same-trace-for-session",
                        "attributes": [
                            { "key": "gen_ai.operation.name", "value": { "stringValue": "execute_tool" } }
                        ]
                    }]
                }]
            }]
        });

        // Call invoke_agent first
        let invoke_events = tokio_test::block_on(
            adapter.transform(Transport::OtlpGrpc, invoke_payload)
        );
        assert!(invoke_events.is_ok());

        // Call execute_tool second with same traceId but no conversation.id
        let execute_events = tokio_test::block_on(
            adapter.transform(Transport::OtlpGrpc, execute_payload)
        );
        assert!(execute_events.is_ok());

        let execute_events = execute_events.unwrap();
        let tool_event = execute_events.iter().find(|e| e.event_type == EventType::ToolUse);
        assert!(tool_event.is_some());

        // Session should be derived from trace-to-conversation mapping
        assert_eq!(
            tool_event.unwrap().session_id, "session-from-invoke",
            "Session should be derived from trace-to-conversation mapping"
        );
    }

    /// REQ-2.4: Multiple traces are tracked independently
    #[test]
    fn multiple_traces_tracked_independently() {
        let adapter = OpenCodeAdapter::new();

        // Two separate traces
        let payload1 = serde_json::json!({
            "resourceSpans": [{
                "scopeSpans": [{
                    "spans": [{
                        "name": "invoke_agent",
                        "traceId": "trace-A",
                        "attributes": [
                            { "key": "gen_ai.operation.name", "value": { "stringValue": "invoke_agent" } },
                            { "key": "gen_ai.conversation.id", "value": { "stringValue": "session-A" } }
                        ]
                    }]
                }]
            }]
        });

        let payload2 = serde_json::json!({
            "resourceSpans": [{
                "scopeSpans": [{
                    "spans": [{
                        "name": "invoke_agent",
                        "traceId": "trace-B",
                        "attributes": [
                            { "key": "gen_ai.operation.name", "value": { "stringValue": "invoke_agent" } },
                            { "key": "gen_ai.conversation.id", "value": { "stringValue": "session-B" } }
                        ]
                    }]
                }]
            }]
        });

        // Setup both traces
        tokio_test::block_on(adapter.transform(Transport::OtlpGrpc, payload1.clone())).unwrap();
        tokio_test::block_on(adapter.transform(Transport::OtlpGrpc, payload2.clone())).unwrap();

        // Now send execute_tool for each trace without conversation.id
        let execute1 = serde_json::json!({
            "resourceSpans": [{
                "scopeSpans": [{
                    "spans": [{
                        "name": "execute_tool",
                        "traceId": "trace-A",
                        "attributes": [
                            { "key": "gen_ai.operation.name", "value": { "stringValue": "execute_tool" } }
                        ]
                    }]
                }]
            }]
        });

        let execute2 = serde_json::json!({
            "resourceSpans": [{
                "scopeSpans": [{
                    "spans": [{
                        "name": "execute_tool",
                        "traceId": "trace-B",
                        "attributes": [
                            { "key": "gen_ai.operation.name", "value": { "stringValue": "execute_tool" } }
                        ]
                    }]
                }]
            }]
        });

        let events1 = tokio_test::block_on(adapter.transform(Transport::OtlpGrpc, execute1)).unwrap();
        let events2 = tokio_test::block_on(adapter.transform(Transport::OtlpGrpc, execute2)).unwrap();

        let tool1 = events1.iter().find(|e| e.event_type == EventType::ToolUse).unwrap();
        let tool2 = events2.iter().find(|e| e.event_type == EventType::ToolUse).unwrap();

        assert_eq!(tool1.session_id, "session-A", "trace-A should map to session-A");
        assert_eq!(tool2.session_id, "session-B", "trace-B should map to session-B");
    }
}

// ── EventBus emit integration ─────────────────────────────────────────────────

#[cfg(test)]
mod opencode_adapter_eventbus_tests {
    use super::*;

    /// REQ-2.9: OpenCodeAdapter events reach the UI on fredo-stream-event channel
    /// This test verifies that the events produced by OpenCodeAdapter are valid
    /// FredoEvents that could be emitted via EventBus (structure validation only)
    #[test]
    fn events_have_valid_fredo_event_structure() {
        let adapter = OpenCodeAdapter::new();

        let payload = serde_json::json!({
            "tool_name": "TestTool",
            "tool_input": {},
            "tool_use_id": "test-id-001"
        });

        let events = tokio_test::block_on(
            adapter.transform(Transport::Hook, payload)
        );

        assert!(events.is_ok());
        let events = events.unwrap();
        assert!(!events.is_empty());

        for event in events {
            // Verify event has all required fields for EventBus::emit
            assert!(!event.id.is_empty(), "id should be populated");
            assert!(event.timestamp.ends_with("Z"), "timestamp should be RFC3339");
            assert_eq!(event.provider, EventProvider::OpenCode, "Provider should be OpenCode");

            // EventType and State should be valid enum values
            match event.event_type {
                EventType::ToolUse | EventType::AgentSession | EventType::Chat
                | EventType::Infrastructure | EventType::Ui | EventType::Custom => {}
            }

            match event.state {
                EventState::Init | EventState::Update | EventState::Response | EventState::Error => {}
            }
        }
    }
}