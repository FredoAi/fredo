//! REQ-10: Field extraction from FredoEvent by dot-notation path.
//!
//! Extracts a field value from a serialized FredoEvent using a dot-separated
//! path such as "state", "sessionId", "correlationId", "payload.result",
//! "metadata.quality_score".  Returns `None` gracefully for missing fields
//! (no error per REQ-10).

use crate::infrastructure::comm::event::FredoEvent;

/// Extract a field value from a FredoEvent by dot-notation path.
///
/// The path is resolved against the camelCase JSON serialization of the
/// FredoEvent (which aligns with the frontend's field naming).
///
/// Examples:
/// - `"state"`        → `"Init"` / `"Update"` / `"Response"` / `"Error"`
/// - `"sessionId"`    → the `session_id` field (serialized as `sessionId`)
/// - `"payload.result"` → the `result` key inside the Payload object
///
/// Returns `None` if the field (or any intermediate segment) does not exist.
pub fn extract_field(event: &FredoEvent, path: &str) -> Option<serde_json::Value> {
    // Serialize the whole FredoEvent to JSON (camelCase per #[serde])
    let root = serde_json::to_value(event).ok()?;

    let parts: Vec<&str> = path.split('.').collect();
    let mut current = root;

    for part in parts {
        // Try as object field
        if let Some(obj) = current.as_object() {
            current = obj.get(part)?.clone(); // field not found at this level -> None
            continue;
        }
        // Try as array index
        if let Some(arr) = current.as_array() {
            if let Ok(idx) = part.parse::<usize>() {
                current = arr.get(idx)?.clone();
                continue;
            }
        }
        // Cannot navigate into this value
        return None;
    }

    Some(current)
}

/// Extract a field as a string value, or `None` if missing / not a string.
pub fn extract_string(event: &FredoEvent, path: &str) -> Option<String> {
    extract_field(event, path).and_then(|v| match v {
        serde_json::Value::String(s) => Some(s),
        serde_json::Value::Number(n) => Some(n.to_string()),
        serde_json::Value::Bool(b) => Some(b.to_string()),
        _ => None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::comm::event::{
        FredoEvent, EventType, EventState, EventProvider,
    };

    fn make_test_event(payload: Option<serde_json::Value>) -> FredoEvent {
        FredoEvent::builder()
            .event_type(EventType::ToolUse)
            .state(EventState::Init)
            .provider(EventProvider::OpenCode)
            .session_id("session-1")
            .correlation_id("tool-123")
            .tool_name("read_file")
            .payload(payload.unwrap_or(serde_json::json!({
                "result": "file content",
                "status": "ok"
            })))
            .build()
    }

    #[test]
    fn extracts_top_level_string_field() {
        let event = make_test_event(None);
        let val = extract_field(&event, "state").unwrap();
        assert_eq!(val, serde_json::json!("Init"));
    }

    #[test]
    fn extracts_session_id() {
        let event = make_test_event(None);
        let val = extract_field(&event, "sessionId").unwrap();
        assert_eq!(val, serde_json::json!("session-1"));
    }

    #[test]
    fn extracts_correlation_id() {
        let event = make_test_event(None);
        let val = extract_field(&event, "correlationId").unwrap();
        assert_eq!(val, serde_json::json!("tool-123"));
    }

    #[test]
    fn extracts_tool_name() {
        let event = make_test_event(None);
        let val = extract_field(&event, "toolName").unwrap();
        assert_eq!(val, serde_json::json!("read_file"));
    }

    #[test]
    fn extracts_payload_nested_field() {
        let event = make_test_event(None);
        let val = extract_field(&event, "payload.result").unwrap();
        assert_eq!(val, serde_json::json!("file content"));
    }

    #[test]
    fn extracts_payload_nested_field_status() {
        let event = make_test_event(None);
        let val = extract_field(&event, "payload.status").unwrap();
        assert_eq!(val, serde_json::json!("ok"));
    }

    #[test]
    fn missing_field_returns_none() {
        let event = make_test_event(None);
        let val = extract_field(&event, "nonexistent");
        assert!(val.is_none());
    }

    #[test]
    fn missing_nested_field_returns_none() {
        let event = make_test_event(None);
        let val = extract_field(&event, "payload.nonexistent");
        assert!(val.is_none());
    }

    #[test]
    fn missing_payload_returns_none() {
        let event = make_test_event(Some(serde_json::json!(null)));
        let val = extract_field(&event, "payload.result");
        assert!(val.is_none());
    }

    #[test]
    fn extracts_nested_three_level() {
        let event = make_test_event(Some(serde_json::json!({
            "info": {"text": "hello world", "modelID": "test"},
            "part": {"text": "response", "reasoning": "thinking"}
        })));
        let val = extract_field(&event, "payload.info.text").unwrap();
        assert_eq!(val, serde_json::json!("hello world"));
        let val2 = extract_field(&event, "payload.part.reasoning").unwrap();
        assert_eq!(val2, serde_json::json!("thinking"));
    }

    #[test]
    fn extracts_payload_top_level() {
        let event = make_test_event(Some(serde_json::json!({
            "info": {"text": "hello"},
            "part": {"text": "response"}
        })));
        let val = extract_field(&event, "payload").unwrap();
        assert_eq!(val, serde_json::json!({"info": {"text": "hello"}, "part": {"text": "response"}}));
    }
}
