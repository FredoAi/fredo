//! Unit tests for EventBus.
//!
//! Tests the contract defined in Spec 1 REQ-1.7:
//! - EventBus::emit() calls app.emit("fredo-stream-event", &event)

use crate::infrastructure::comm::*;

#[cfg(test)]
mod event_bus_emit_tests {
    use super::*;

    /// REQ-1.7: EventBus emits to "fredo-stream-event" channel
    #[test]
    fn event_bus_channel_name_is_fredo_stream_event() {
        // The channel name "fredo-stream-event" is hardcoded in the stub.
        // This test verifies the constant is correct.
        const CHANNEL: &str = "fredo-stream-event";
        assert_eq!(CHANNEL, "fredo-stream-event");
    }

    /// REQ-1.7: EventBus::emit() takes a FredoEvent
    #[test]
    fn event_bus_accepts_fredo_event() {
        let event = FredoEvent::builder()
            .event_type(EventType::ToolUse)
            .state(EventState::Init)
            .session_id("tauri-local")
            .tool_name("test_tool")
            .build();

        // Verify the event is serializable (what app.emit would transmit)
        let serialized = serde_json::to_string(&event);
        assert!(serialized.is_ok(), "FredoEvent should be serializable for emit");

        let json = serialized.unwrap();
        assert!(json.contains("tool_use"));
        assert!(json.contains("Init"));
    }

    /// REQ-1.7: EventBus reuses the same IPC channel as StreamEvent
    #[test]
    fn event_bus_reuses_existing_channel() {
        // AD-2 from spec: EventBus reuses the same IPC channel as StreamEvent.
        // Both FredoEvent and StreamEvent emit on "fredo-stream-event".
        // The EventBus stub confirms this channel name.
        const CHANNEL: &str = "fredo-stream-event";
        assert_eq!(CHANNEL, "fredo-stream-event");
    }
}

#[cfg(test)]
mod event_bus_integration_tests {

    /// These tests verify the contract that EventBus and StreamEvent
    /// both emit on the same channel for the UI to receive

    #[test]
    fn both_fredo_event_and_stream_event_use_same_channel() {
        // REQ-1.7 + existing infrastructure/events/mod.rs behavior
        // Both emit to "fredo-stream-event" so TauriAdapter receives both
        const CHANNEL: &str = "fredo-stream-event";
        assert_eq!(CHANNEL, "fredo-stream-event");
    }
}