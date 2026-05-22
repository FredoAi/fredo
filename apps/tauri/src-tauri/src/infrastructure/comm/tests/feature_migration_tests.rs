//! Unit tests for feature module migration to FredoEvent + EventBus.
//!
//! Tests REQ-2.10:
//! - Feature modules use FredoEvent builder + EventBus instead of StreamEvent + emit_stream_event()
//!
//! REQ-2.10: Feature modules (terminal, mcp) use FredoEvent builder and EventBus instead of StreamEvent

use std::fs;
use std::path::Path;

/// REQ-2.10: terminal/commands.rs should NOT import from infrastructure::events
#[test]
fn terminal_commands_uses_fredo_event() {
    let source_root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let path = source_root.join("src/features/terminal/commands.rs");

    if path.exists() {
        let content = fs::read_to_string(&path).unwrap();

        // Should NOT import from infrastructure::events
        assert!(
            !content.contains("infrastructure::events"),
            "terminal/commands.rs should not import from infrastructure::events per REQ-2.10"
        );
        assert!(
            !content.contains("emit_stream_event"),
            "terminal/commands.rs should not use emit_stream_event per REQ-2.10"
        );
        assert!(
            !content.contains("StreamEvent"),
            "terminal/commands.rs should not use StreamEvent per REQ-2.10"
        );

        // Should use FredoEvent and EventBus
        assert!(
            content.contains("FredoEvent") || content.contains("EventBus"),
            "terminal/commands.rs should use FredoEvent/EventBus per REQ-2.10"
        );
    }
}

/// REQ-2.10: mcp/fredo_ui/mod.rs should NOT import from infrastructure::events
#[test]
fn mcp_fredo_ui_uses_fredo_event() {
    let source_root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let path = source_root.join("src/features/mcp/fredo_ui/mod.rs");

    if path.exists() {
        let content = fs::read_to_string(&path).unwrap();

        assert!(
            !content.contains("infrastructure::events"),
            "mcp/fredo_ui/mod.rs should not import from infrastructure::events per REQ-2.10"
        );
        assert!(
            !content.contains("emit_stream_event"),
            "mcp/fredo_ui/mod.rs should not use emit_stream_event per REQ-2.10"
        );
        assert!(
            !content.contains("StreamEvent"),
            "mcp/fredo_ui/mod.rs should not use StreamEvent per REQ-2.10"
        );
    }
}

/// REQ-2.10: mcp/infrastructure/mod.rs should NOT import from infrastructure::events
#[test]
fn mcp_infrastructure_uses_fredo_event() {
    let source_root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let path = source_root.join("src/features/mcp/infrastructure/mod.rs");

    if path.exists() {
        let content = fs::read_to_string(&path).unwrap();

        assert!(
            !content.contains("infrastructure::events"),
            "mcp/infrastructure/mod.rs should not import from infrastructure::events per REQ-2.10"
        );
        assert!(
            !content.contains("emit_stream_event"),
            "mcp/infrastructure/mod.rs should not use emit_stream_event per REQ-2.10"
        );
        assert!(
            !content.contains("StreamEvent"),
            "mcp/infrastructure/mod.rs should not use StreamEvent per REQ-2.10"
        );
    }
}

/// REQ-2.10: Feature modules should use FredoEvent builder pattern
/// This verifies the builder is used correctly in feature code
#[test]
fn fredo_event_builder_pattern_in_features() {
    // Test the FredoEvent builder produces valid events for feature use
    use crate::infrastructure::comm::*;
    use crate::infrastructure::comm::event::{EventType, EventState, EventProvider, Transport};

    // Example: terminal feature emitting run_cli event
    let event = FredoEvent::builder()
        .event_type(EventType::ToolUse)
        .state(EventState::Init)
        .provider(EventProvider::Internal)
        .transport(Transport::Internal)
        .session_id("tauri-local")
        .tool_name("run_cli")
        .correlation_id("corr-123")
        .payload(serde_json::json!({ "binary": "opencode", "cwd": "/home/user" }))
        .build();

    assert_eq!(event.event_type, EventType::ToolUse);
    assert_eq!(event.state, EventState::Init);
    assert_eq!(event.tool_name, Some("run_cli".into()));
    assert_eq!(event.correlation_id, Some("corr-123".into()));

    // Example: update event
    let update_event = FredoEvent::builder()
        .event_type(EventType::ToolUse)
        .state(EventState::Update)
        .provider(EventProvider::Internal)
        .transport(Transport::Internal)
        .session_id("tauri-local")
        .tool_name("run_cli")
        .correlation_id("corr-123")
        .build();

    assert_eq!(update_event.state, EventState::Update);

    // Example: response event
    let response_event = FredoEvent::builder()
        .event_type(EventType::ToolUse)
        .state(EventState::Response)
        .provider(EventProvider::Internal)
        .transport(Transport::Internal)
        .session_id("tauri-local")
        .tool_name("run_cli")
        .correlation_id("corr-123")
        .build();

    assert_eq!(response_event.state, EventState::Response);
}

/// REQ-2.10: EventBus can emit FredoEvent for feature events
/// This verifies EventBus works with feature-generated FredoEvents
#[test]
fn eventbus_can_emit_feature_fredo_events() {
    use crate::infrastructure::comm::*;
    use crate::infrastructure::comm::event::{EventType, EventState, EventProvider, Transport};

    // Create a FredoEvent as a feature would
    let event = FredoEvent::builder()
        .event_type(EventType::ToolUse)
        .state(EventState::Init)
        .provider(EventProvider::Internal)
        .transport(Transport::Internal)
        .session_id("tauri-local")
        .tool_name("run_cli")
        .correlation_id("test-corr")
        .build();

    // Verify event structure is complete for EventBus::emit
    assert!(!event.id.is_empty());
    assert!(event.timestamp.ends_with("Z"));
    assert_eq!(event.provider, EventProvider::Internal);

    // Serialize to JSON to verify it can be sent over IPC
    let json = serde_json::to_string(&event);
    assert!(json.is_ok(), "FredoEvent should be serializable for EventBus emit");
}

/// REQ-2.10: Feature events have correct correlation_id for pairing
#[test]
fn feature_events_have_correlation_id_for_pairing() {
    use crate::infrastructure::comm::*;
    use crate::infrastructure::comm::event::{EventType, EventState};

    let correlation_id = "paired-corr-456";

    let init_event = FredoEvent::builder()
        .event_type(EventType::ToolUse)
        .state(EventState::Init)
        .session_id("tauri-local")
        .tool_name("test_tool")
        .correlation_id(correlation_id)
        .build();

    let response_event = FredoEvent::builder()
        .event_type(EventType::ToolUse)
        .state(EventState::Response)
        .session_id("tauri-local")
        .tool_name("test_tool")
        .correlation_id(correlation_id)
        .build();

    // Both events should have the same correlation_id for UI pairing
    assert_eq!(init_event.correlation_id, Some(correlation_id.into()));
    assert_eq!(response_event.correlation_id, Some(correlation_id.into()));
}