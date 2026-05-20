use rmcp::ErrorData;

use crate::infrastructure::events::{emit_stream_event, EventState, StreamEvent};

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

    emit_stream_event(
        handle,
        StreamEvent::new("fredo_ui_alert", EventState::Response).with_response(
            serde_json::json!({
                "message": message,
                "level": level.unwrap_or("info"),
            }),
        ),
    );

    Ok(format!("Alert displayed: {message}"))
}

pub fn stepper(
    app: Option<&tauri::AppHandle>,
    title: &str,
    steps: &[String],
    current_step: Option<u32>,
) -> Result<String, ErrorData> {
    let handle = app.ok_or_else(no_app)?;

    emit_stream_event(
        handle,
        StreamEvent::new("fredo_ui_stepper", EventState::Response).with_response(
            serde_json::json!({
                "title": title,
                "steps": steps,
                "currentStep": current_step.unwrap_or(0),
            }),
        ),
    );

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

    emit_stream_event(
        handle,
        StreamEvent::new("fredo_ui_collect_responses", EventState::Init).with_input(
            serde_json::json!({
                "prompt": prompt,
                "placeholder": placeholder.unwrap_or(""),
            }),
        ),
    );

    // In an MCP context the agent can't block waiting for UI input; return
    // an acknowledgement and let the UI emit a follow-up stream event.
    Ok(format!(
        "Prompt displayed to user: \"{prompt}\". \
         The user's response will appear as an fredo_ui_collect_responses Response event."
    ))
}
