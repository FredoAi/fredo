//! Wireframe companion intent relay (Spec #3070, ST-7, C5 / G-124).
//!
//! A `llm-skill-call` arrives ONCE, in the main window. The Wireframe editor may
//! mount later (the app had to be opened first) and, under the `new-window`
//! presentation, lives in a DIFFERENT webview — so a module-scoped frontend bus
//! is not sufficient. The relay therefore lives on the host:
//!
//! 1. [`wireframe_intent`] persists the intent in managed state **and** emits
//!    `wireframe-intent` app-wide. The editor executes on the event when it is
//!    already mounted.
//! 2. [`wireframe_intent_take`] drains the bounded queue on editor mount, so an
//!    intent emitted before the editor's listener existed is never dropped.
//! 3. [`wireframe_intent_result`] emits `wireframe-intent-result` app-wide; the
//!    Home hook resolves the matching `requestId` and composes the honest reply.
//!
//! The queue is bounded ([`WIREFRAME_INTENT_QUEUE_LIMIT`]) — a stuck consumer
//! cannot grow it without bound; the oldest intent is evicted first.
//!
//! Nothing here executes a wireframe action: execution belongs to the editor
//! (`applications/wireframe` frontend), so this module stays pure relay.

use std::collections::VecDeque;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

/// Host -> every webview: one intent to execute (C5 binding).
pub const WIREFRAME_INTENT_EVENT: &str = "wireframe-intent";
/// Every webview -> host -> Home: the performed subset for a request (C5).
pub const WIREFRAME_INTENT_RESULT_EVENT: &str = "wireframe-intent-result";
/// The bounded queue depth. Oldest-first eviction keeps it from growing.
pub const WIREFRAME_INTENT_QUEUE_LIMIT: usize = 16;

/// One relayed intent. Camel-case over IPC/events (`requestId`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireframeIntent {
    pub request_id: String,
    pub action: String,
    pub arguments: Value,
}

/// The outcome the editor reports for one intent. `detail` is the list reply
/// text for `wireframe.companion.listActions` (only set when there is one).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireframeIntentResult {
    pub request_id: String,
    pub performed: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// The managed intent queue (bounded, FIFO, drained by `wireframe_intent_take`).
#[derive(Debug, Default)]
pub struct WireframeIntentState {
    pending: Mutex<VecDeque<WireframeIntent>>,
}

impl WireframeIntentState {
    /// An empty relay queue.
    pub fn new() -> Self {
        Self::default()
    }

    /// Append one intent. At the bound the OLDEST intent is evicted first, so
    /// memory stays bounded without ever failing a live request.
    pub fn push(&self, intent: WireframeIntent) -> Result<(), String> {
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| "wireframe intent state is unavailable".to_string())?;
        if pending.len() >= WIREFRAME_INTENT_QUEUE_LIMIT {
            pending.pop_front();
        }
        pending.push_back(intent);
        Ok(())
    }

    /// Drain every queued intent, oldest first. The queue is empty afterwards.
    pub fn take(&self) -> Vec<WireframeIntent> {
        match self.pending.lock() {
            Ok(mut pending) => pending.drain(..).collect(),
            Err(_) => Vec::new(),
        }
    }

    /// The current queue depth (test observability).
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.pending.lock().map(|pending| pending.len()).unwrap_or(0)
    }
}

/// Fail-closed request validation, pure so the command stays thin.
pub fn validate_intent_request(request_id: &str, action: &str) -> Result<(), String> {
    if request_id.trim().is_empty() {
        return Err("a wireframe intent needs a request id".to_string());
    }
    if action.trim().is_empty() {
        return Err("a wireframe intent needs an action".to_string());
    }
    Ok(())
}

/// Persist an intent and broadcast it app-wide (C5 binding name).
#[tauri::command]
pub fn wireframe_intent(
    app: AppHandle,
    state: State<'_, WireframeIntentState>,
    request_id: String,
    action: String,
    arguments: Value,
) -> Result<(), String> {
    validate_intent_request(&request_id, &action)?;
    let intent = WireframeIntent {
        request_id: request_id.trim().to_string(),
        action: action.trim().to_string(),
        arguments,
    };
    state.push(intent.clone())?;
    app.emit(WIREFRAME_INTENT_EVENT, &intent)
        .map_err(|error| format!("wireframe intent could not be broadcast: {error}"))
}

/// Drain the queue on editor mount (covers late-mount / other-webview, G-124).
#[tauri::command]
pub fn wireframe_intent_take(state: State<'_, WireframeIntentState>) -> Vec<WireframeIntent> {
    state.take()
}

/// Broadcast the performed subset for `request_id` (C5 binding name).
#[tauri::command]
pub fn wireframe_intent_result(
    app: AppHandle,
    request_id: String,
    performed: Vec<String>,
    detail: Option<String>,
) -> Result<(), String> {
    validate_intent_request(&request_id, "wireframe_intent_result")?;
    let detail = detail.filter(|value| !value.trim().is_empty());
    let result = WireframeIntentResult {
        request_id: request_id.trim().to_string(),
        performed,
        detail,
    };
    app.emit(WIREFRAME_INTENT_RESULT_EVENT, &result)
        .map_err(|error| format!("wireframe intent result could not be broadcast: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn intent(request_id: &str, action: &str) -> WireframeIntent {
        WireframeIntent {
            request_id: request_id.to_string(),
            action: action.to_string(),
            arguments: json!({ "action": action }),
        }
    }

    #[test]
    fn the_relay_binding_names_are_pinned() {
        assert_eq!(WIREFRAME_INTENT_EVENT, "wireframe-intent");
        assert_eq!(WIREFRAME_INTENT_RESULT_EVENT, "wireframe-intent-result");
        assert_eq!(WIREFRAME_INTENT_QUEUE_LIMIT, 16);
    }

    #[test]
    fn the_queue_is_fifo_and_take_drains_it() {
        let state = WireframeIntentState::new();
        state.push(intent("req-1", "wireframe.add.card")).unwrap();
        state.push(intent("req-2", "wireframe.add.text")).unwrap();

        let drained = state.take();
        let ids: Vec<&str> = drained.iter().map(|i| i.request_id.as_str()).collect();
        assert_eq!(ids, vec!["req-1", "req-2"], "oldest first");
        assert!(state.take().is_empty(), "take drains the queue");
        assert_eq!(state.len(), 0);
    }

    #[test]
    fn the_queue_is_bounded_and_evicts_the_oldest_intent() {
        let state = WireframeIntentState::new();
        for index in 0..(WIREFRAME_INTENT_QUEUE_LIMIT + 3) {
            state
                .push(intent(&format!("request-{index}"), "wireframe.add.line"))
                .unwrap();
        }

        assert_eq!(state.len(), WIREFRAME_INTENT_QUEUE_LIMIT);
        let drained = state.take();
        assert_eq!(drained.len(), WIREFRAME_INTENT_QUEUE_LIMIT);
        assert_eq!(drained.first().unwrap().request_id, "request-3");
        assert_eq!(
            drained.last().unwrap().request_id,
            format!("request-{}", WIREFRAME_INTENT_QUEUE_LIMIT + 2)
        );
    }

    #[test]
    fn the_intent_payload_is_camel_case_and_keeps_the_arguments() {
        let payload = serde_json::to_value(intent("req-9", "wireframe.add.section")).unwrap();
        assert_eq!(
            payload,
            json!({
                "requestId": "req-9",
                "action": "wireframe.add.section",
                "arguments": { "action": "wireframe.add.section" }
            })
        );
    }

    #[test]
    fn the_result_payload_is_camel_case_and_omits_an_absent_detail() {
        let without_detail = serde_json::to_value(WireframeIntentResult {
            request_id: "req-9".to_string(),
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
                "performed": ["wireframe.document.new", "wireframe.add.section"]
            })
        );
        assert!(
            without_detail.get("detail").is_none(),
            "an absent detail must not serialize a null"
        );

        let with_detail = serde_json::to_value(WireframeIntentResult {
            request_id: "req-9".to_string(),
            performed: Vec::new(),
            detail: Some("Wireframe actions: a — b".to_string()),
        })
        .unwrap();
        assert_eq!(with_detail["detail"], "Wireframe actions: a — b");
    }

    #[test]
    fn intent_requests_are_validated_fail_closed() {
        assert!(validate_intent_request("req-1", "wireframe.add.text").is_ok());
        assert_eq!(
            validate_intent_request("  ", "wireframe.add.text"),
            Err("a wireframe intent needs a request id".to_string())
        );
        assert_eq!(
            validate_intent_request("req-1", "   "),
            Err("a wireframe intent needs an action".to_string())
        );
    }
}
