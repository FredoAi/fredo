//! Integration tests for OpenCodeAdapter wiring in IPC and OTLP callers.
//!
//! Tests REQ-2.5, REQ-2.6:
//! - ipc.rs calls OpenCodeAdapter::transform(Transport::Hook, payload)
//! - otlp/grpc.rs and otlp/http.rs call OpenCodeAdapter::transform()
//!
//! REQ-2.5: ipc.rs calls OpenCodeAdapter::transform(Transport::Hook, payload)
//! REQ-2.6: otlp/grpc.rs and otlp/http.rs call OpenCodeAdapter::transform()

use crate::infrastructure::comm::*;
use crate::infrastructure::comm::adapter::CommAdapter;
use crate::infrastructure::comm::adapters::opencode::OpenCodeAdapter;

#[cfg(test)]
mod ipc_opencode_adapter_wiring_tests {
    use super::*;

    /// REQ-2.5: ipc.rs dispatch_opencode_plugin should use OpenCodeAdapter::transform
    ///
    /// This test verifies the contract that ipc.rs (after refactoring) will call
    /// OpenCodeAdapter::transform(Transport::Hook, payload) instead of the current
    /// StreamEvent + emit_stream_event path.
    ///
    /// NOTE: This test requires the coder to refactor ipc.rs first. The test
    /// documents the expected behavior.
    #[test]
    fn opencode_adapter_handles_hook_payload_from_ipc() {
        let adapter = OpenCodeAdapter::new();

        // Simulate what ipc.rs sends after refactoring:
        // The raw payload from OpenCode plugin hook
        let hook_payload = serde_json::json!({
            "event_type": "PreToolUse",
            "tool_name": "Bash",
            "tool_input": { "command": "ls" },
            "tool_use_id": "hook-id-123"
        });

        let events = tokio_test::block_on(
            adapter.transform(Transport::Hook, hook_payload)
        );

        assert!(events.is_ok(), "OpenCodeAdapter should handle IPC hook payload");
        let events = events.unwrap();
        assert!(!events.is_empty(), "Hook payload should produce at least 1 event");

        // Verify the event structure matches what the UI expects
        let event = &events[0];
        assert_eq!(event.provider, EventProvider::OpenCode);
        assert_eq!(event.transport, Transport::Hook);
    }

    /// REQ-2.5: PostToolUse hook from ipc.rs produces Response state event
    #[test]
    fn ipc_posttooluse_yields_response_event() {
        let adapter = OpenCodeAdapter::new();
        let payload = serde_json::json!({
            "event_type": "PostToolUse",
            "tool_name": "Bash",
            "tool_response": { "stdout": "result" },
            "tool_use_id": "post-hook-456"
        });

        let events = tokio_test::block_on(
            adapter.transform(Transport::Hook, payload)
        );

        assert!(events.is_ok());
        let events = events.unwrap();
        let event = &events[0];
        assert_eq!(event.state, EventState::Response);
    }

    /// REQ-2.5: PostToolUseFailure hook from ipc.rs produces Error state event
    #[test]
    fn ipc_posttoolusefailure_yields_error_event() {
        let adapter = OpenCodeAdapter::new();
        let payload = serde_json::json!({
            "event_type": "PostToolUseFailure",
            "tool_name": "Bash",
            "error": "Failed",
            "tool_use_id": "fail-hook-789"
        });

        let events = tokio_test::block_on(
            adapter.transform(Transport::Hook, payload)
        );

        assert!(events.is_ok());
        let events = events.unwrap();
        let event = &events[0];
        assert_eq!(event.state, EventState::Error);
    }
}

#[cfg(test)]
mod otlp_grpc_opencode_adapter_wiring_tests {
    use super::*;

    /// REQ-2.6: otlp/grpc.rs should use OpenCodeAdapter::transform(Transport::OtlpGrpc, spans)
    ///
    /// This test verifies the OTLP gRPC path produces FredoEvents correctly.
    #[test]
    fn grpc_otlp_produces_valid_fredo_events() {
        let adapter = OpenCodeAdapter::new();

        // OTLP spans as received by otlp/grpc.rs
        let otlp_spans = serde_json::json!({
            "resourceSpans": [{
                "resource": {
                    "attributes": [
                        { "key": "service.name", "value": { "stringValue": "opencode" } }
                    ]
                },
                "scopeSpans": [{
                    "spans": [{
                        "name": "invoke_agent",
                        "traceId": "0123abcd",
                        "spanId": "spanabc",
                        "kind": 1,
                        "attributes": [
                            { "key": "gen_ai.operation.name", "value": { "stringValue": "invoke_agent" } },
                            { "key": "gen_ai.conversation.id", "value": { "stringValue": "grpc-conv" } },
                            { "key": "gen_ai.request.model", "value": { "stringValue": "claude-3-5-sonnet" } }
                        ]
                    }]
                }]
            }]
        });

        let events = tokio_test::block_on(
            adapter.transform(Transport::OtlpGrpc, otlp_spans)
        );

        assert!(events.is_ok(), "OTLP gRPC transform should succeed: {:?}", events);
        let events = events.unwrap();
        assert!(!events.is_empty(), "OTLP spans should produce events");

        let event = &events[0];
        assert_eq!(event.provider, EventProvider::OpenCode);
        assert_eq!(event.transport, Transport::OtlpGrpc);
        assert_eq!(event.event_type, EventType::AgentSession);
        assert_eq!(event.session_id, "grpc-conv");
    }
}

#[cfg(test)]
mod otlp_http_opencode_adapter_wiring_tests {
    use super::*;

    /// REQ-2.6: otlp/http.rs should use OpenCodeAdapter::transform(Transport::OtlpHttp, spans)
    ///
    /// This test verifies the OTLP HTTP path produces FredoEvents correctly.
    #[test]
    fn http_otlp_produces_valid_fredo_events() {
        let adapter = OpenCodeAdapter::new();

        let otlp_spans = serde_json::json!({
            "resourceSpans": [{
                "scopeSpans": [{
                    "spans": [{
                        "name": "execute_tool",
                        "traceId": "def456abc",
                        "attributes": [
                            { "key": "gen_ai.operation.name", "value": { "stringValue": "execute_tool" } },
                            { "key": "gen_ai.conversation.id", "value": { "stringValue": "http-conv" } },
                            { "key": "tool.name", "value": { "stringValue": "Bash" } }
                        ]
                    }]
                }]
            }]
        });

        let events = tokio_test::block_on(
            adapter.transform(Transport::OtlpHttp, otlp_spans)
        );

        assert!(events.is_ok(), "OTLP HTTP transform should succeed: {:?}", events);
        let events = events.unwrap();
        assert!(!events.is_empty());

        let event = &events[0];
        assert_eq!(event.provider, EventProvider::OpenCode);
        assert_eq!(event.transport, Transport::OtlpHttp);
        assert_eq!(event.event_type, EventType::ToolUse);
        assert_eq!(event.session_id, "http-conv");
    }

    /// REQ-2.4: otlp/http.rs trace-to-conversation mapping should be handled by adapter
    /// (verify same traceId across batches gets same session)
    #[test]
    fn http_otlp_trace_mapping_across_batches() {
        let adapter = OpenCodeAdapter::new();

        // Batch 1: invoke_agent with conversation.id
        let batch1 = serde_json::json!({
            "resourceSpans": [{
                "scopeSpans": [{
                    "spans": [{
                        "name": "invoke_agent",
                        "traceId": "shared-trace-http",
                        "attributes": [
                            { "key": "gen_ai.operation.name", "value": { "stringValue": "invoke_agent" } },
                            { "key": "gen_ai.conversation.id", "value": { "stringValue": "batch-session" } }
                        ]
                    }]
                }]
            }]
        });

        // Batch 2: execute_tool without conversation.id (same traceId)
        let batch2 = serde_json::json!({
            "resourceSpans": [{
                "scopeSpans": [{
                    "spans": [{
                        "name": "execute_tool",
                        "traceId": "shared-trace-http",
                        "attributes": [
                            { "key": "gen_ai.operation.name", "value": { "stringValue": "execute_tool" } }
                        ]
                    }]
                }]
            }]
        });

        tokio_test::block_on(adapter.transform(Transport::OtlpHttp, batch1)).unwrap();
        let batch2_events = tokio_test::block_on(adapter.transform(Transport::OtlpHttp, batch2)).unwrap();

        let tool_event = batch2_events.iter().find(|e| e.event_type == EventType::ToolUse).unwrap();
        assert_eq!(
            tool_event.session_id, "batch-session",
            "execute_tool without conversation.id should use trace mapping"
        );
    }
}

// ── Adapter registry tests ─────────────────────────────────────────────────────

#[cfg(test)]
mod adapter_registry_tests {
    use super::*;

    /// REQ-2.8: lib.rs registers both InternalAdapter and OpenCodeAdapter
    ///
    /// This test verifies the adapter registry pattern works correctly.
    #[test]
    fn adapter_registry_contains_both_adapters() {
        use std::collections::HashMap;
        use std::sync::{Arc, Mutex};

        // Simulate the adapter registry from lib.rs
        let registry: Arc<Mutex<HashMap<String, Box<dyn CommAdapter>>>> =
            Arc::new(Mutex::new(HashMap::new()));

        // Register InternalAdapter
        registry.lock().unwrap().insert(
            "internal".to_string(),
            Box::new(crate::infrastructure::comm::InternalAdapter::new()) as Box<dyn CommAdapter>
        );

        // Register OpenCodeAdapter
        registry.lock().unwrap().insert(
            "opencode".to_string(),
            Box::new(OpenCodeAdapter::new()) as Box<dyn CommAdapter>
        );

        // Verify both adapters are present
        let reg = registry.lock().unwrap();
        assert!(reg.contains_key("internal"), "Registry should contain InternalAdapter");
        assert!(reg.contains_key("opencode"), "Registry should contain OpenCodeAdapter");

        // Verify they can be used
        let internal = reg.get("internal").unwrap();
        assert_eq!(internal.name(), "internal");
        assert_eq!(internal.provider(), EventProvider::Internal);

        let opencode = reg.get("opencode").unwrap();
        assert_eq!(opencode.name(), "opencode");
        assert_eq!(opencode.provider(), EventProvider::OpenCode);
    }

    /// REQ-2.8: Adapters can be retrieved by name and used
    #[test]
    fn adapters_can_be_retrieved_by_name() {
        use std::collections::HashMap;
        use std::sync::{Arc, Mutex};

        let registry: Arc<Mutex<HashMap<String, Box<dyn CommAdapter>>>> =
            Arc::new(Mutex::new(HashMap::new()));

        registry.lock().unwrap().insert(
            "internal".to_string(),
            Box::new(crate::infrastructure::comm::InternalAdapter::new()) as Box<dyn CommAdapter>
        );
        registry.lock().unwrap().insert(
            "opencode".to_string(),
            Box::new(OpenCodeAdapter::new()) as Box<dyn CommAdapter>
        );

        // Get OpenCodeAdapter and use it
        let opencode_adapter = {
            let reg = registry.lock().unwrap();
            reg.get("opencode").unwrap().box_clone()
        };

        let payload = serde_json::json!({
            "tool_name": "Test",
            "tool_use_id": "test-123"
        });

        let events = tokio_test::block_on(
            opencode_adapter.transform(Transport::Hook, payload)
        );

        assert!(events.is_ok(), "Retrieved OpenCodeAdapter should work");
    }
}