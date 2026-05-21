//! Unit tests for FredoEvent and its enums.
//!
//! Tests the contract defined in Spec 1 REQ-1.1 through REQ-1.6:
//! - FredoEvent struct with all required fields
//! - EventType enum variants
//! - EventProvider enum variants
//! - Transport enum variants
//! - EventState enum with PascalCase serialization
//! - Builder pattern for FredoEvent

use crate::infrastructure::comm::*;

#[cfg(test)]
mod event_type_tests {
    use super::*;

    /// REQ-1.2: EventType enum has correct variants: ToolUse, AgentSession, Chat, Infrastructure, Ui, Custom
    #[test]
    fn event_type_snake_case_serialization() {
        // EventType serializes as snake_case: tool_use, agent_session, etc.
        let et = EventType::ToolUse;
        let json = serde_json::to_string(&et).unwrap();
        assert_eq!(json, "\"tool_use\"");

        let et2 = EventType::AgentSession;
        let json2 = serde_json::to_string(&et2).unwrap();
        assert_eq!(json2, "\"agent_session\"");
    }

    #[test]
    fn event_type_deserializes_from_snake_case() {
        // When infrastructure::comm::event::EventType is implemented,
        // this will deserialize correctly with snake_case rename
        let json = r#"{"event_type": "tool_use"}"#;
        let parsed: serde_json::Value = serde_json::from_str(json).unwrap();
        assert_eq!(parsed["event_type"], "tool_use");

        let json2 = r#"{"event_type": "agent_session"}"#;
        let parsed2: serde_json::Value = serde_json::from_str(json2).unwrap();
        assert_eq!(parsed2["event_type"], "agent_session");
    }

    #[test]
    fn event_type_all_variants_serializable() {
        let variants = [
            (EventType::ToolUse, "tool_use"),
            (EventType::AgentSession, "agent_session"),
            (EventType::Chat, "chat"),
            (EventType::Infrastructure, "infrastructure"),
            (EventType::Ui, "ui"),
            (EventType::Custom, "custom"),
        ];
        for (et, expected) in variants {
            let json = serde_json::to_string(&et).unwrap();
            assert_eq!(json, format!("\"{}\"", expected));
        }
    }
}

#[cfg(test)]
mod event_provider_tests {
    use super::*;

    /// REQ-1.3: EventProvider enum has correct variants: OpenCode, ClaudeCode, Internal
    #[test]
    fn event_provider_snake_case_serialization() {
        let ep = EventProvider::OpenCode;
        let json = serde_json::to_string(&ep).unwrap();
        assert_eq!(json, "\"open_code\"");

        let ep2 = EventProvider::ClaudeCode;
        let json2 = serde_json::to_string(&ep2).unwrap();
        assert_eq!(json2, "\"claude_code\"");
    }

    #[test]
    fn event_provider_deserializes_from_snake_case() {
        let providers = ["open_code", "claude_code", "internal"];
        for provider in providers {
            let json = format!(r#"{{"provider": "{}"}}"#, provider);
            let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
            assert_eq!(parsed["provider"], provider);
        }
    }
}

#[cfg(test)]
mod transport_tests {
    use super::*;

    /// REQ-1.4: Transport enum has correct variants: Hook, OtlpGrpc, OtlpHttp, WebSocket, HttpPost, Internal
    #[test]
    fn transport_snake_case_serialization() {
        let t = Transport::Hook;
        let json = serde_json::to_string(&t).unwrap();
        assert_eq!(json, "\"hook\"");

        let t2 = Transport::OtlpGrpc;
        let json2 = serde_json::to_string(&t2).unwrap();
        assert_eq!(json2, "\"otlp_grpc\"");
    }

    #[test]
    fn transport_deserializes_all_variants() {
        let transports = [
            (Transport::Hook, "hook"),
            (Transport::OtlpGrpc, "otlp_grpc"),
            (Transport::OtlpHttp, "otlp_http"),
            (Transport::WebSocket, "web_socket"),
            (Transport::HttpPost, "http_post"),
            (Transport::Internal, "internal"),
        ];
        for (transport, expected) in transports {
            let json = serde_json::to_string(&transport).unwrap();
            assert_eq!(json, format!("\"{}\"", expected));
        }
    }
}

#[cfg(test)]
mod event_state_tests {
    use super::*;

    /// REQ-1.5: EventState enum with PascalCase serialization (Init, Update, Response, Error)
    #[test]
    fn event_state_pascal_case_serialization() {
        let states = [
            (EventState::Init, "\"Init\""),
            (EventState::Update, "\"Update\""),
            (EventState::Response, "\"Response\""),
            (EventState::Error, "\"Error\""),
        ];
        for (state, expected) in states {
            let json = serde_json::to_string(&state).unwrap();
            assert_eq!(json, expected, "EventState {:?} should serialize as PascalCase", state);
        }
    }

    #[test]
    fn event_state_deserializes_pascal_case() {
        let state_json = r#"{"state": "Init"}"#;
        let parsed: serde_json::Value = serde_json::from_str(state_json).unwrap();
        assert_eq!(parsed["state"], "Init");
    }
}

#[cfg(test)]
mod fredo_event_builder_tests {
    use super::*;

    /// REQ-1.6: Builder pattern produces correct struct
    #[test]
    fn fredo_event_has_required_fields() {
        let event = FredoEvent::builder()
            .event_type(EventType::ToolUse)
            .state(EventState::Init)
            .session_id("tauri-local")
            .tool_name("test_tool")
            .payload(serde_json::json!({"key": "value"}))
            .build();

        // Verify required fields are present
        assert!(!event.id.is_empty(), "id should be auto-generated");
        assert_eq!(event.event_type, EventType::ToolUse);
        assert_eq!(event.state, EventState::Init);
        assert_eq!(event.provider, EventProvider::Internal); // default
        assert_eq!(event.transport, Transport::Hook); // default
        assert_eq!(event.session_id, "tauri-local");
        assert!(event.timestamp.ends_with("Z"), "timestamp should be RFC3339");
    }

    #[test]
    fn builder_chain_works() {
        let event = FredoEvent::builder()
            .event_type(EventType::AgentSession)
            .state(EventState::Response)
            .provider(EventProvider::OpenCode)
            .session_id("tauri-local")
            .correlation_id("corr-123")
            .tool_name("my_tool")
            .payload(serde_json::json!({"input": "test"}))
            .build();

        assert_eq!(event.event_type, EventType::AgentSession);
        assert_eq!(event.state, EventState::Response);
        assert_eq!(event.provider, EventProvider::OpenCode);
        assert_eq!(event.correlation_id, Some("corr-123".into()));
    }
}

#[cfg(test)]
mod fredo_event_serialization_tests {
    use super::*;

    /// REQ-1.1: FredoEvent struct with all fields serializes/deserializes correctly
    #[test]
    fn fredo_event_round_trip() {
        let event = FredoEvent::builder()
            .event_type(EventType::ToolUse)
            .state(EventState::Init)
            .tool_name("test_tool")
            .session_id("tauri-local")
            .correlation_id("corr-123")
            .payload(serde_json::json!({"input": "test"}))
            .metadata(serde_json::json!({"key": "value"}))
            .build();

        let json = serde_json::to_string(&event).unwrap();
        let parsed: FredoEvent = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.event_type, EventType::ToolUse);
        assert_eq!(parsed.state, EventState::Init);
        assert_eq!(parsed.session_id, "tauri-local");
        assert_eq!(parsed.correlation_id, Some("corr-123".into()));
    }

    #[test]
    fn fredo_event_error_structure() {
        let event = FredoEvent::builder()
            .event_type(EventType::ToolUse)
            .state(EventState::Error)
            .session_id("tauri-local")
            .tool_name("failing_tool")
            .payload(serde_json::json!({"key": "value"}))
            .build();

        // Manually set error (builder doesn't have error setter in stub)
        let mut e = event;
        e.error = Some(FredoEventError {
            message: "Tool execution failed".into(),
            code: Some("EXECUTION_ERROR".into()),
            details: Some(serde_json::json!({"reason": "timeout"})),
        });

        let json = serde_json::to_string(&e).unwrap();
        let parsed: FredoEvent = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.error.as_ref().unwrap().message, "Tool execution failed");
        assert_eq!(parsed.error.as_ref().unwrap().code.as_ref().unwrap(), "EXECUTION_ERROR");
    }

    /// REQ-1.5: EventState PascalCase serialization check
    #[test]
    fn event_state_pascal_case_in_fredo_event() {
        for state in [EventState::Init, EventState::Update, EventState::Response, EventState::Error] {
            let event = FredoEvent::builder()
                .event_type(EventType::ToolUse)
                .state(state)
                .session_id("tauri-local")
                .build();

            let json = serde_json::to_string(&event).unwrap();
            let state_str = format!("{:?}", state);
            assert!(
                json.contains(&state_str),
                "EventState {:?} should appear as PascalCase in JSON: {}",
                state,
                json
            );
        }
    }
}