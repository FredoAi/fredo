//! Generic application command intent relay (Spec #3099, ST-5).
//!
//! A `llm-skill-call` for a published application surface arrives ONCE, in the
//! main window. The application that owns the command may mount later (it had
//! to be opened first) and, under a multi-window presentation, lives in a
//! DIFFERENT webview — so a module-scoped frontend bus is not sufficient. The
//! relay therefore lives on the host, application-agnostic:
//!
//! 1. [`app_command_intent`] persists the intent in managed state **and** emits
//!    `app-command-intent` app-wide. The owning application executes on the
//!    event when it is already mounted.
//! 2. [`app_command_intent_take`] drains the bounded queue on application mount
//!    (filtered by `appId`), so an intent emitted before the application's
//!    listener existed is never dropped.
//! 3. [`app_command_intent_result`] emits `app-command-intent-result` app-wide;
//!    the dispatcher resolves the matching `requestId` and composes the honest
//!    reply.
//!
//! The queue is bounded ([`APP_COMMAND_INTENT_QUEUE_LIMIT`]) — a stuck consumer
//! cannot grow it without bound; the oldest intent is evicted first.
//!
//! Nothing here executes an application command: execution belongs to the
//! owning application's frontend, so this module stays pure relay.

use std::collections::VecDeque;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

/// Host -> every webview: one intent to execute.
pub const APP_COMMAND_INTENT_EVENT: &str = "app-command-intent";
/// Every webview -> host -> dispatcher: the outcome for a request.
pub const APP_COMMAND_INTENT_RESULT_EVENT: &str = "app-command-intent-result";
/// The bounded queue depth. Oldest-first eviction keeps it from growing.
pub const APP_COMMAND_INTENT_QUEUE_LIMIT: usize = 16;

/// One relayed intent, addressed to exactly one application. Camel-case over
/// IPC/events (`requestId`, `appId`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppCommandIntent {
    pub request_id: String,
    pub app_id: String,
    pub action: String,
    pub arguments: Value,
}

/// The outcome the owning application reports for one intent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub enum AppCommandOutcome {
    Performed,
    Noop,
    Invalid,
    Failed,
}

/// The reported outcome for one intent. `performed` lists the executed command
/// ids in order (0..1 today); `detail` is set only when there is something to
/// say (e.g. the list reply text for the reserved `listActions` action).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppCommandIntentResult {
    pub request_id: String,
    pub app_id: String,
    pub outcome: AppCommandOutcome,
    pub performed: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// The managed intent queue (bounded, FIFO, drained by
/// `app_command_intent_take`).
#[derive(Debug, Default)]
pub struct AppCommandIntentState {
    pending: Mutex<VecDeque<AppCommandIntent>>,
}

impl AppCommandIntentState {
    /// An empty relay queue.
    pub fn new() -> Self {
        Self::default()
    }

    /// Append one intent. At the bound the OLDEST intent is evicted first, so
    /// memory stays bounded without ever failing a live request.
    pub fn push(&self, intent: AppCommandIntent) -> Result<(), String> {
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| "app command intent state is unavailable".to_string())?;
        if pending.len() >= APP_COMMAND_INTENT_QUEUE_LIMIT {
            pending.pop_front();
        }
        pending.push_back(intent);
        Ok(())
    }

    /// Drain only the intents addressed to `app_id`, oldest first. Entries for
    /// every other application stay queued in arrival order.
    pub fn take(&self, app_id: &str) -> Vec<AppCommandIntent> {
        let mut pending = match self.pending.lock() {
            Ok(pending) => pending,
            Err(_) => return Vec::new(),
        };
        let mut drained = Vec::new();
        let mut remaining = VecDeque::with_capacity(pending.len());
        while let Some(intent) = pending.pop_front() {
            if intent.app_id == app_id {
                drained.push(intent);
            } else {
                remaining.push_back(intent);
            }
        }
        *pending = remaining;
        drained
    }

    /// The current queue depth (test observability).
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.pending.lock().map(|pending| pending.len()).unwrap_or(0)
    }
}

/// Fail-closed identity validation shared by both commands, pure so the
/// commands stay thin.
fn validate_identifiers(request_id: &str, app_id: &str) -> Result<(), String> {
    if request_id.trim().is_empty() {
        return Err("an app command intent needs a request id".to_string());
    }
    if app_id.trim().is_empty() {
        return Err("an app command intent needs an app id".to_string());
    }
    Ok(())
}

/// Fail-closed request validation: non-blank identifiers, a non-blank action,
/// and `arguments` that is an object or `null` (never a scalar or array).
pub fn validate_app_command_intent(
    request_id: &str,
    app_id: &str,
    action: &str,
    arguments: &Value,
) -> Result<(), String> {
    validate_identifiers(request_id, app_id)?;
    if action.trim().is_empty() {
        return Err("an app command intent needs an action".to_string());
    }
    if !(arguments.is_object() || arguments.is_null()) {
        return Err("an app command intent's arguments must be an object or null".to_string());
    }
    Ok(())
}

/// Persist an intent and broadcast it app-wide.
#[tauri::command]
pub fn app_command_intent(
    app: AppHandle,
    state: State<'_, AppCommandIntentState>,
    request_id: String,
    app_id: String,
    action: String,
    arguments: Value,
) -> Result<(), String> {
    validate_app_command_intent(&request_id, &app_id, &action, &arguments)?;
    let intent = AppCommandIntent {
        request_id: request_id.trim().to_string(),
        app_id: app_id.trim().to_string(),
        action: action.trim().to_string(),
        arguments,
    };
    state.push(intent.clone())?;
    app.emit(APP_COMMAND_INTENT_EVENT, &intent)
        .map_err(|error| format!("app command intent could not be broadcast: {error}"))
}

/// Drain the queued intents for one application on mount (covers late-mount /
/// other-webview delivery). Intents addressed to other applications stay
/// queued, oldest first.
#[tauri::command]
pub fn app_command_intent_take(
    state: State<'_, AppCommandIntentState>,
    app_id: String,
) -> Vec<AppCommandIntent> {
    state.take(app_id.trim())
}

/// Broadcast the outcome for `request_id`.
#[tauri::command]
pub fn app_command_intent_result(
    app: AppHandle,
    request_id: String,
    app_id: String,
    outcome: AppCommandOutcome,
    performed: Vec<String>,
    detail: Option<String>,
) -> Result<(), String> {
    validate_identifiers(&request_id, &app_id)?;
    let result = AppCommandIntentResult {
        request_id: request_id.trim().to_string(),
        app_id: app_id.trim().to_string(),
        outcome,
        performed,
        detail: detail.filter(|value| !value.trim().is_empty()),
    };
    app.emit(APP_COMMAND_INTENT_RESULT_EVENT, &result)
        .map_err(|error| format!("app command intent result could not be broadcast: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn intent(request_id: &str, app_id: &str, action: &str) -> AppCommandIntent {
        AppCommandIntent {
            request_id: request_id.to_string(),
            app_id: app_id.to_string(),
            action: action.to_string(),
            arguments: json!({}),
        }
    }

    #[test]
    fn the_relay_binding_names_are_pinned() {
        assert_eq!(APP_COMMAND_INTENT_EVENT, "app-command-intent");
        assert_eq!(APP_COMMAND_INTENT_RESULT_EVENT, "app-command-intent-result");
        assert_eq!(APP_COMMAND_INTENT_QUEUE_LIMIT, 16);
    }

    #[test]
    fn the_queue_is_fifo_and_take_drains_it() {
        let state = AppCommandIntentState::new();
        state
            .push(intent("req-1", "wireframe", "wireframe.add.card"))
            .unwrap();
        state
            .push(intent("req-2", "wireframe", "wireframe.add.text"))
            .unwrap();

        let drained = state.take("wireframe");
        let ids: Vec<&str> = drained.iter().map(|i| i.request_id.as_str()).collect();
        assert_eq!(ids, vec!["req-1", "req-2"], "oldest first");
        assert!(state.take("wireframe").is_empty(), "take drains the queue");
        assert_eq!(state.len(), 0);
    }

    #[test]
    fn the_queue_is_bounded_and_evicts_the_oldest_intent() {
        let state = AppCommandIntentState::new();
        for index in 0..(APP_COMMAND_INTENT_QUEUE_LIMIT + 3) {
            state
                .push(intent(
                    &format!("request-{index}"),
                    "wireframe",
                    "wireframe.add.line",
                ))
                .unwrap();
        }

        assert_eq!(state.len(), APP_COMMAND_INTENT_QUEUE_LIMIT);
        let drained = state.take("wireframe");
        assert_eq!(drained.len(), APP_COMMAND_INTENT_QUEUE_LIMIT);
        assert_eq!(drained.first().unwrap().request_id, "request-3");
        assert_eq!(
            drained.last().unwrap().request_id,
            format!("request-{}", APP_COMMAND_INTENT_QUEUE_LIMIT + 2)
        );
    }

    #[test]
    fn take_filters_by_app_and_keeps_the_untouched_remainder_in_order() {
        let state = AppCommandIntentState::new();
        state.push(intent("req-1", "wireframe", "a")).unwrap();
        state.push(intent("req-2", "mission-monitor", "b")).unwrap();
        state.push(intent("req-3", "wireframe", "c")).unwrap();
        state.push(intent("req-4", "mission-monitor", "d")).unwrap();

        let drained = state.take("wireframe");
        let ids: Vec<&str> = drained.iter().map(|i| i.request_id.as_str()).collect();
        assert_eq!(ids, vec!["req-1", "req-3"], "only this app's intents");

        let remainder = state.take("mission-monitor");
        let ids: Vec<&str> = remainder.iter().map(|i| i.request_id.as_str()).collect();
        assert_eq!(ids, vec!["req-2", "req-4"], "remainder keeps arrival order");
        assert_eq!(state.len(), 0);
    }

    #[test]
    fn the_intent_payload_is_camel_case_and_keeps_the_arguments() {
        let payload = serde_json::to_value(AppCommandIntent {
            request_id: "req-9".to_string(),
            app_id: "wireframe".to_string(),
            action: "wireframe.add.section".to_string(),
            arguments: json!({ "fill": "blue" }),
        })
        .unwrap();
        assert_eq!(
            payload,
            json!({
                "requestId": "req-9",
                "appId": "wireframe",
                "action": "wireframe.add.section",
                "arguments": { "fill": "blue" }
            })
        );
    }

    #[test]
    fn the_result_payload_is_camel_case_and_omits_an_absent_detail() {
        let without_detail = serde_json::to_value(AppCommandIntentResult {
            request_id: "req-9".to_string(),
            app_id: "wireframe".to_string(),
            outcome: AppCommandOutcome::Performed,
            performed: vec![
                "wireframe.document.new".to_string(),
                "wireframe.add.section".to_string(),
            ],
            detail: None,
        })
        .unwrap();
        assert_eq!(
            without_detail,
            json!({
                "requestId": "req-9",
                "appId": "wireframe",
                "outcome": "Performed",
                "performed": ["wireframe.document.new", "wireframe.add.section"]
            })
        );
        assert!(
            without_detail.get("detail").is_none(),
            "an absent detail must not serialize a null"
        );

        let with_detail = serde_json::to_value(AppCommandIntentResult {
            request_id: "req-9".to_string(),
            app_id: "wireframe".to_string(),
            outcome: AppCommandOutcome::Noop,
            performed: Vec::new(),
            detail: Some("Wireframe actions: a - b".to_string()),
        })
        .unwrap();
        assert_eq!(with_detail["detail"], "Wireframe actions: a - b");
        assert_eq!(with_detail["outcome"], "Noop");
    }

    #[test]
    fn the_outcome_round_trips_through_its_pascal_case_names() {
        for outcome in [
            AppCommandOutcome::Performed,
            AppCommandOutcome::Noop,
            AppCommandOutcome::Invalid,
            AppCommandOutcome::Failed,
        ] {
            let encoded = serde_json::to_value(&outcome).unwrap();
            let decoded: AppCommandOutcome = serde_json::from_value(encoded.clone()).unwrap();
            assert_eq!(decoded, outcome);
            assert_eq!(encoded, json!(format!("{outcome:?}")));
        }
    }

    #[test]
    fn intent_requests_are_validated_fail_closed() {
        assert!(validate_app_command_intent(
            "req-1",
            "wireframe",
            "wireframe.add.text",
            &json!({})
        )
        .is_ok());
        assert!(validate_app_command_intent(
            "req-1",
            "wireframe",
            "wireframe.add.text",
            &Value::Null
        )
        .is_ok());
        assert_eq!(
            validate_app_command_intent("  ", "wireframe", "wireframe.add.text", &Value::Null),
            Err("an app command intent needs a request id".to_string())
        );
        assert_eq!(
            validate_app_command_intent("req-1", "  ", "wireframe.add.text", &Value::Null),
            Err("an app command intent needs an app id".to_string())
        );
        assert_eq!(
            validate_app_command_intent("req-1", "wireframe", "   ", &Value::Null),
            Err("an app command intent needs an action".to_string())
        );
        assert_eq!(
            validate_app_command_intent(
                "req-1",
                "wireframe",
                "wireframe.add.text",
                &json!(["not", "an", "object"])
            ),
            Err("an app command intent's arguments must be an object or null".to_string())
        );
        assert_eq!(
            validate_app_command_intent("req-1", "wireframe", "wireframe.add.text", &json!("text")),
            Err("an app command intent's arguments must be an object or null".to_string())
        );
    }
}
