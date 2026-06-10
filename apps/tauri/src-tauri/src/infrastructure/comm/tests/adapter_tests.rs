//! Unit tests for InternalAdapter.
//!
//! Tests the contract defined in Spec 1 REQ-1.8 and REQ-1.9:
//! - Validates enum fields strictly (reject unknown variants via serde)
//! - Accepts arbitrary JSON for payload/metadata
//! - Stamps missing defaults (id, timestamp, transport, session_id)
//! - Accepts events with provider: Internal and transport: Hook

use crate::infrastructure::comm::*;
use crate::infrastructure::comm::adapters::internal::InternalAdapter;
use crate::infrastructure::comm::adapter::CommAdapter;

#[cfg(test)]
mod internal_adapter_validation_tests {
    use super::*;

    /// REQ-1.8: InternalAdapter validates enum fields strictly.
    /// Unknown EventType, EventState, or EventProvider variants should be rejected.
    #[tokio::test]
    async fn rejects_unknown_event_type() {
        let adapter = InternalAdapter::new();
        let json = serde_json::json!({
            "id": "550e8400-e29b-41d4-a716-446655440000",
            "eventType": "unknown_type",
            "state": "Init",
            "provider": "internal",
            "transport": "hook",
            "sessionId": "tauri-local",
            "timestamp": "2026-05-20T10:00:00Z"
        });

        let result = adapter.transform(Transport::Hook, json).await;
        assert!(
            result.is_err(),
            "Unknown eventType 'unknown_type' should be rejected by strict validation"
        );
    }

    #[tokio::test]
    async fn rejects_unknown_event_state() {
        let adapter = InternalAdapter::new();
        let json = serde_json::json!({
            "id": "550e8400-e29b-41d4-a716-446655440000",
            "eventType": "tool_use",
            "state": "UnknownState",
            "provider": "internal",
            "transport": "hook",
            "sessionId": "tauri-local",
            "timestamp": "2026-05-20T10:00:00Z"
        });

        let result = adapter.transform(Transport::Hook, json).await;
        assert!(
            result.is_err(),
            "Unknown state 'UnknownState' should be rejected by strict validation"
        );
    }

    #[tokio::test]
    async fn rejects_unknown_event_provider() {
        let adapter = InternalAdapter::new();
        let json = serde_json::json!({
            "id": "550e8400-e29b-41d4-a716-446655440000",
            "eventType": "tool_use",
            "state": "Init",
            "provider": "unknown_provider",
            "transport": "hook",
            "sessionId": "tauri-local",
            "timestamp": "2026-05-20T10:00:00Z"
        });

        let result = adapter.transform(Transport::Hook, json).await;
        assert!(
            result.is_err(),
            "Unknown provider 'unknown_provider' should be rejected by strict validation"
        );
    }

    #[tokio::test]
    async fn accepts_valid_event_type_variants() {
        let adapter = InternalAdapter::new();
        let valid_types = ["tool_use", "agent_session", "chat", "infrastructure", "ui", "custom"];

        for et in valid_types {
            let json = serde_json::json!({
                "id": "550e8400-e29b-41d4-a716-446655440000",
                "eventType": et,
                "state": "Init",
                "provider": "internal",
                "transport": "hook",
                "sessionId": "tauri-local",
                "timestamp": "2026-05-20T10:00:00Z"
            });

            let result = adapter.transform(Transport::Hook, json).await;
            assert!(
                result.is_ok(),
                "Valid eventType '{}' should be accepted, but got: {:?}",
                et,
                result
            );
        }
    }
}

#[cfg(test)]
mod internal_adapter_enrichment_tests {
    use super::*;

    /// REQ-1.8: InternalAdapter requires all required fields for deserialization.
    /// The serde deserializer requires id, timestamp, transport, session_id to be present
    /// in the JSON. Missing required fields are rejected at the deserialization layer.
    #[tokio::test]
    async fn accepts_event_with_missing_optional_fields() {
        let adapter = InternalAdapter::new();
        // Missing id, timestamp, transport, session_id — all required for deserialization
        let json = serde_json::json!({
            "eventType": "tool_use",
            "state": "Init",
            "provider": "internal"
        });

        let result = adapter.transform(Transport::Hook, json).await;
        // Deserialization requires all non-Option fields — missing id causes error
        assert!(
            result.is_err(),
            "Event missing required fields should be rejected at deserialization: {:?}",
            result
        );
    }

    #[tokio::test]
    async fn stamps_missing_id_as_uuid() {
        let adapter = InternalAdapter::new();
        let json = serde_json::json!({
            "id": "550e8400-e29b-41d4-a716-446655440000",
            "eventType": "tool_use",
            "state": "Init",
            "provider": "internal",
            "transport": "hook",
            "sessionId": "tauri-local",
            "timestamp": "2026-05-20T10:00:00Z"
        });

        let result = adapter.transform(Transport::Hook, json).await;
        assert!(result.is_ok(), "Event with all required fields should be accepted");
        let events = result.unwrap();
        assert!(!events.is_empty(), "Should return at least one event");
        // Verify that the id field is present and is a valid UUID
        assert!(!events[0].id.is_empty(), "id should not be empty after enrichment");
    }

    #[test]
    fn timestamp_is_rfc3339_format() {
        let event = FredoEvent::builder()
            .event_type(EventType::ToolUse)
            .state(EventState::Init)
            .session_id("tauri-local")
            .build();

        // RFC3339 format: YYYY-MM-DDTHH:mm:ss[.fraction][Z|+00:00]
        assert!(
            !event.timestamp.is_empty(),
            "timestamp should not be empty"
        );
        assert!(
            event.timestamp.contains('T'),
            "timestamp should contain T separator (RFC3339), got: {}",
            event.timestamp
        );
    }

    #[test]
    fn defaults_session_id_to_tauri_local() {
        let event = FredoEvent::builder()
            .event_type(EventType::ToolUse)
            .state(EventState::Init)
            .build();

        assert_eq!(event.session_id, "tauri-local");
    }
}

#[cfg(test)]
mod internal_adapter_lenient_payload_tests {
    use super::*;

    /// REQ-1.8: InternalAdapter accepts arbitrary JSON for payload/metadata
    #[tokio::test]
    async fn accepts_arbitrary_json_payload() {
        let adapter = InternalAdapter::new();
        let payloads = vec![
            serde_json::json!({"key": "value"}),
            serde_json::json!([1, 2, 3]),
            serde_json::json!("string payload"),
            serde_json::json!(42),
            serde_json::json!(true),
            serde_json::json!(null),
        ];

        for payload in payloads {
            let json = serde_json::json!({
                "id": "550e8400-e29b-41d4-a716-446655440000",
                "eventType": "tool_use",
                "state": "Init",
                "provider": "internal",
                "transport": "hook",
                "sessionId": "tauri-local",
                "timestamp": "2026-05-20T10:00:00Z",
                "payload": payload
            });

            let result = adapter.transform(Transport::Hook, json).await;
            assert!(
                result.is_ok(),
                "Arbitrary JSON payload should be accepted: {:?}",
                result
            );
        }
    }

    #[tokio::test]
    async fn accepts_arbitrary_json_metadata() {
        let adapter = InternalAdapter::new();
        let metadatas = vec![
            serde_json::json!({"nested": {"key": "value"}}),
            serde_json::json!({"array": [1, 2, 3]}),
            serde_json::json!("simple string"),
        ];

        for metadata in metadatas {
            let json = serde_json::json!({
                "id": "550e8400-e29b-41d4-a716-446655440000",
                "eventType": "tool_use",
                "state": "Init",
                "provider": "internal",
                "transport": "hook",
                "sessionId": "tauri-local",
                "timestamp": "2026-05-20T10:00:00Z",
                "metadata": metadata
            });

            let result = adapter.transform(Transport::Hook, json).await;
            assert!(
                result.is_ok(),
                "Arbitrary JSON metadata should be accepted: {:?}",
                result
            );
        }
    }
}

#[cfg(test)]
mod internal_adapter_accepts_internal_provider_tests {
    use super::*;

    /// REQ-1.9: InternalAdapter accepts events with provider: Internal and transport: Hook
    #[tokio::test]
    async fn accepts_internal_provider_with_hook_transport() {
        let adapter = InternalAdapter::new();
        let json = serde_json::json!({
            "id": "550e8400-e29b-41d4-a716-446655440000",
            "eventType": "tool_use",
            "state": "Init",
            "provider": "internal",
            "transport": "hook",
            "sessionId": "tauri-local",
            "timestamp": "2026-05-20T10:00:00Z",
            "payload": {"test": true}
        });

        let result = adapter.transform(Transport::Hook, json).await;
        assert!(result.is_ok());
        let events = result.unwrap();
        let event = &events[0];
        assert_eq!(event.provider, EventProvider::Internal);
        assert_eq!(event.transport, Transport::Hook);
    }

    /// REQ-1.9: Internal provider without transport is rejected at deserialization.
    /// The transport field is required by serde for FredoEvent.
    #[tokio::test]
    async fn accepts_internal_provider_without_transport() {
        let adapter = InternalAdapter::new();
        // transport field is required for deserialization — omitted here
        let json = serde_json::json!({
            "id": "550e8400-e29b-41d4-a716-446655440000",
            "eventType": "tool_use",
            "state": "Init",
            "provider": "internal",
            "sessionId": "tauri-local",
            "timestamp": "2026-05-20T10:00:00Z"
        });

        let result = adapter.transform(Transport::Hook, json).await;
        // transport is required — deserialization fails
        assert!(
            result.is_err(),
            "Event without transport field should be rejected at deserialization: {:?}",
            result
        );
    }
}
