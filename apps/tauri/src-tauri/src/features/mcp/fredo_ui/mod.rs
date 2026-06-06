use rmcp::ErrorData;

use crate::infrastructure::comm::{
    EventBus, EventProvider, EventState, EventType, FredoEvent, Transport,
};
use tauri::Manager;

fn no_app() -> ErrorData {
    ErrorData::internal_error(
        "fredo_ui tools require the Fredo desktop app to be running. \
         Start fredo and retry, or use fredo mcp from inside the app.",
        None,
    )
}

pub fn alert(
    app: Option<&tauri::AppHandle>,
    message: &str,
    level: Option<&str>,
) -> Result<String, ErrorData> {
    let handle = app.ok_or_else(no_app)?;

    let bus = handle.state::<EventBus>();
    bus.emit(FredoEvent::builder()
        .event_type(EventType::Ui)
        .state(EventState::Response)
        .provider(EventProvider::Internal)
        .transport(Transport::Hook)
        .tool_name("fredo_ui_alert")
        .payload(serde_json::json!({
            "message": message,
            "level": level.unwrap_or("info"),
        }))
        .build());

    Ok(format!("Alert displayed: {message}"))
}

pub fn stepper(
    app: Option<&tauri::AppHandle>,
    title: &str,
    steps: &[String],
    current_step: Option<u32>,
) -> Result<String, ErrorData> {
    let handle = app.ok_or_else(no_app)?;

    let bus = handle.state::<EventBus>();
    bus.emit(FredoEvent::builder()
        .event_type(EventType::Ui)
        .state(EventState::Response)
        .provider(EventProvider::Internal)
        .transport(Transport::Hook)
        .tool_name("fredo_ui_stepper")
        .payload(serde_json::json!({
            "title": title,
            "steps": steps,
            "currentStep": current_step.unwrap_or(0),
        }))
        .build());

    Ok(format!(
        "Stepper '{title}' shown with {} steps.",
        steps.len()
    ))
}

pub fn collect_responses(
    app: Option<&tauri::AppHandle>,
    prompt: &str,
    placeholder: Option<&str>,
) -> Result<String, ErrorData> {
    let handle = app.ok_or_else(no_app)?;

    let bus = handle.state::<EventBus>();
    bus.emit(FredoEvent::builder()
        .event_type(EventType::Ui)
        .state(EventState::Init)
        .provider(EventProvider::Internal)
        .transport(Transport::Hook)
        .tool_name("fredo_ui_collect_responses")
        .payload(serde_json::json!({
            "prompt": prompt,
            "placeholder": placeholder.unwrap_or(""),
        }))
        .build());

    // In an MCP context the agent can't block waiting for UI input; return
    // an acknowledgement and let the UI emit a follow-up stream event.
    Ok(format!(
        "Prompt displayed to user: \"{prompt}\". \
         The user's response will appear as an fredo_ui_collect_responses Response event."
    ))
}

#[cfg(test)]
mod tests {
    use crate::features::mcp::server::{
        FredoUiAlertParams, FredoUiCollectResponsesParams, FredoUiStepperParams,
    };
    use serde_json::json;

    // ── FredoUiAlertParams ─────────────────────────────────────────────────────

    #[test]
    fn fredo_ui_alert_full_json_deserializes() {
        let p: FredoUiAlertParams = serde_json::from_value(json!({
            "message": "Hello",
            "level": "info"
        }))
        .unwrap();
        let debug = format!("{:?}", p);
        assert!(debug.contains("Hello"), "message field should be present");
        assert!(debug.contains("info"), "level field should be present");
    }

    #[test]
    fn fredo_ui_alert_minimal_json_deserializes() {
        let p: FredoUiAlertParams = serde_json::from_value(json!({
            "message": "Alert"
        }))
        .unwrap();
        let debug = format!("{:?}", p);
        assert!(debug.contains("Alert"));
    }

    #[test]
    fn fredo_ui_alert_missing_message_fails() {
        let result: Result<FredoUiAlertParams, _> =
            serde_json::from_value(json!({ "level": "error" }));
        assert!(result.is_err(), "missing 'message' must fail");
    }

    #[test]
    fn fredo_ui_alert_invalid_type_fails() {
        let result: Result<FredoUiAlertParams, _> =
            serde_json::from_value(json!({ "message": 99 }));
        assert!(result.is_err(), "message as integer must fail");
    }

    // ── FredoUiStepperParams ───────────────────────────────────────────────────

    #[test]
    fn fredo_ui_stepper_full_json_deserializes() {
        let p: FredoUiStepperParams = serde_json::from_value(json!({
            "title": "Wizard",
            "steps": ["One", "Two", "Three"],
            "current_step": 1
        }))
        .unwrap();
        let debug = format!("{:?}", p);
        assert!(debug.contains("Wizard"), "title field should be present");
        assert!(debug.contains("One"), "steps should contain items");
        assert!(debug.contains("\"Two\""), "steps should contain items");
    }

    #[test]
    fn fredo_ui_stepper_empty_steps_deserializes() {
        let p: FredoUiStepperParams = serde_json::from_value(json!({
            "title": "Empty",
            "steps": []
        }))
        .unwrap();
        let debug = format!("{:?}", p);
        assert!(debug.contains("Empty"));
    }

    #[test]
    fn fredo_ui_stepper_missing_title_fails() {
        let result: Result<FredoUiStepperParams, _> =
            serde_json::from_value(json!({ "steps": ["One"] }));
        assert!(result.is_err(), "missing 'title' must fail");
    }

    #[test]
    fn fredo_ui_stepper_steps_wrong_type_fails() {
        let result: Result<FredoUiStepperParams, _> =
            serde_json::from_value(json!({
                "title": "Test",
                "steps": "not-array"
            }));
        assert!(result.is_err(), "steps as string must fail");
    }

    // ── FredoUiCollectResponsesParams ──────────────────────────────────────────

    #[test]
    fn fredo_ui_collect_full_json_deserializes() {
        let p: FredoUiCollectResponsesParams = serde_json::from_value(json!({
            "prompt": "Enter name",
            "placeholder": "Your name"
        }))
        .unwrap();
        let debug = format!("{:?}", p);
        assert!(debug.contains("Enter name"), "prompt field should be present");
        assert!(debug.contains("Your name"), "placeholder should be present");
    }

    #[test]
    fn fredo_ui_collect_minimal_json_deserializes() {
        let p: FredoUiCollectResponsesParams = serde_json::from_value(json!({
            "prompt": "What?"
        }))
        .unwrap();
        let debug = format!("{:?}", p);
        assert!(debug.contains("What?"));
    }

    #[test]
    fn fredo_ui_collect_missing_prompt_fails() {
        let result: Result<FredoUiCollectResponsesParams, _> =
            serde_json::from_value(json!({ "placeholder": "test" }));
        assert!(result.is_err(), "missing 'prompt' must fail");
    }
}
