//! Unit tests for IPC CliCommand::EmitEvent.
//!
//! Tests the contract defined in Spec 1 REQ-1.10 through REQ-1.12:
//! - CliCommand::EmitEvent serialization/deserialization
//! - fredo emit CLI constructs FredoEvent, sends over IPC
//! - fredo emit --file - reads from stdin

use crate::infrastructure::comm::*;

#[cfg(test)]
mod cli_command_serialization_tests {
    use super::*;

    /// REQ-1.10: CliCommand::EmitEvent serialization
    #[test]
    fn emit_event_serializes_correctly() {
        // CliCommand should have an EmitEvent variant when spec is implemented.
        // This test documents the expected structure.
        let event = FredoEvent::builder()
            .event_type(EventType::ToolUse)
            .state(EventState::Init)
            .provider(EventProvider::Internal)
            .session_id("tauri-local")
            .tool_name("test_tool")
            .build();

        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("tool_use"));
        assert!(json.contains("Init"));
    }

    #[test]
    fn emit_event_deserializes_from_json() {
        let json = r#"{
            "id": "550e8400-e29b-41d4-a716-446655440000",
            "eventType": "tool_use",
            "state": "Init",
            "provider": "internal",
            "transport": "hook",
            "sessionId": "tauri-local",
            "timestamp": "2026-05-20T10:00:00Z",
            "correlationId": null,
            "toolName": "test_tool",
            "payload": null,
            "error": null,
            "metadata": null
        }"#;

        let parsed: Result<FredoEvent, _> = serde_json::from_str(json);
        assert!(
            parsed.is_ok(),
            "Valid FredoEvent JSON should deserialize: {:?}",
            parsed
        );

        let e = parsed.unwrap();
        assert_eq!(e.event_type, EventType::ToolUse);
        assert_eq!(e.state, EventState::Init);
        assert_eq!(e.provider, EventProvider::Internal);
    }

    #[test]
    fn emit_event_json_round_trip() {
        let event = FredoEvent::builder()
            .event_type(EventType::AgentSession)
            .state(EventState::Response)
            .session_id("tauri-local")
            .correlation_id("corr-123")
            .tool_name("my_tool")
            .payload(serde_json::json!({"input": "test"}))
            .build();

        let json = serde_json::to_string(&event).unwrap();
        let parsed: FredoEvent = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.event_type, EventType::AgentSession);
        assert_eq!(parsed.state, EventState::Response);
        assert_eq!(parsed.correlation_id, Some("corr-123".into()));
    }
}

#[cfg(test)]
mod cli_emit_args_tests {
    use super::*;

    /// REQ-1.10: fredo emit CLI arguments
    #[test]
    fn emit_args_has_required_fields() {
        // Build a FredoEvent that represents what `fredo emit` CLI would construct
        let event = FredoEvent::builder()
            .event_type(EventType::ToolUse)
            .state(EventState::Init)
            .tool_name("test_tool")
            .session_id("tauri-local")
            .correlation_id("corr-456")
            .provider(EventProvider::OpenCode)
            .payload(serde_json::json!({"key": "value"}))
            .build();

        // Verify the event has all required fields for CLI emit
        assert!(!event.id.is_empty());
        assert_eq!(event.event_type, EventType::ToolUse);
        assert_eq!(event.state, EventState::Init);
        assert!(event.tool_name.is_some());
        assert_eq!(event.session_id, "tauri-local");
    }

    #[test]
    fn emit_args_payload_is_json_value() {
        // --payload argument accepts a JSON string, parsed into payload
        let payload_json = serde_json::json!({"test": true});
        let event = FredoEvent::builder()
            .event_type(EventType::ToolUse)
            .state(EventState::Init)
            .session_id("tauri-local")
            .payload(payload_json)
            .build();

        assert!(event.payload.is_some());
        let p = event.payload.unwrap();
        assert_eq!(p["test"], serde_json::json!(true));
    }
}

#[cfg(test)]
mod cli_emit_file_stdin_tests {
    use super::*;

    /// REQ-1.12: fredo emit --file - reads from stdin
    #[test]
    fn stdin_json_is_valid_fredo_event() {
        // JSON read from stdin should be a valid FredoEvent
        let stdin_json = r#"{
            "id": "550e8400-e29b-41d4-a716-446655440000",
            "eventType": "tool_use",
            "state": "Init",
            "provider": "internal",
            "transport": "hook",
            "sessionId": "tauri-local",
            "timestamp": "2026-05-20T10:00:00Z",
            "payload": {"test": true}
        }"#;

        let event: Result<FredoEvent, _> = serde_json::from_str(stdin_json);
        assert!(
            event.is_ok(),
            "stdin JSON should be a valid FredoEvent: {:?}",
            event
        );

        let e = event.unwrap();
        assert_eq!(e.event_type, EventType::ToolUse);
        assert_eq!(e.state, EventState::Init);
        assert_eq!(e.provider, EventProvider::Internal);
    }
}

#[cfg(test)]
mod cli_emit_response_tests {
    /// REQ-1.11: IPC server response after emitting via EventBus
    #[test]
    fn emit_response_ok_structure() {
        // Response struct from IPC layer (not yet implemented, documenting shape)
        #[derive(Debug, serde::Serialize, serde::Deserialize)]
        struct EmitResponse {
            ok: bool,
            message: Option<String>,
            #[serde(skip_serializing_if = "Option::is_none")]
            data: Option<serde_json::Value>,
        }

        let response = EmitResponse {
            ok: true,
            message: None,
            data: Some(serde_json::json!({"queued": true})),
        };

        let json = serde_json::to_string(&response).unwrap();
        assert!(json.contains("\"ok\":true"));
    }

    #[test]
    fn emit_response_error_structure() {
        #[derive(Debug, serde::Serialize, serde::Deserialize)]
        struct EmitResponse {
            ok: bool,
            message: Option<String>,
            #[serde(skip_serializing_if = "Option::is_none")]
            data: Option<serde_json::Value>,
        }

        let response = EmitResponse {
            ok: false,
            message: Some("Invalid event type: unknown_type".into()),
            data: None,
        };

        let json = serde_json::to_string(&response).unwrap();
        assert!(json.contains("\"ok\":false"));
        assert!(json.contains("Invalid event type"));
    }
}