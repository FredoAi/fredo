use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

/// The state of a stream event — mirrors the TypeScript `EventState` type.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub enum EventState {
    Init,
    Update,
    Response,
    Error,
}

/// Error detail attached to an Error-state event.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamEventError {
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

/// Identifies where the event originated — hook-based IPC or OTLP transport.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum EventSource {
    /// Originated from the local socket IPC (legacy fredo hook CLI path).
    #[default]
    Hook,
    /// Originated from the embedded OTLP/gRPC receiver (:4317) — OpenCode.
    OtlpGrpc,
    /// Originated from the embedded OTLP/HTTP receiver (:4318) — OpenCode.
    OtlpHttp,
}

/// OTLP signal type carried when `source` is `OtlpGrpc` or `OtlpHttp`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OtlpSignal {
    Span,
    Metric,
    Log,
}

/// OTLP-specific payload attached to events that arrive via the OTLP transport.
///
/// `attributes` holds the flattened resource + signal attributes
/// (e.g. `session.id`, `service.name`, `gen_ai.operation.name`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OtlpPayload {
    pub signal: OtlpSignal,
    /// Flattened key-value attributes from the OTLP resource + record.
    pub attributes: serde_json::Value,
}

/// StreamEvent — emitted via Tauri's event system as "fredo-stream-event" and
/// received by TauriAdapter in the webview, which forwards it to
/// StreamContext.addEvent().
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamEvent {
    pub tool_name: String,
    pub session_id: String,
    pub state: EventState,
    /// Where this event originated (hook IPC or OTLP transport).
    #[serde(default)]
    pub source: EventSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    pub timestamp: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<StreamEventError>,
    /// Populated for OTLP-sourced events; absent for hook-sourced events.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub otlp: Option<OtlpPayload>,
}

impl StreamEvent {
    pub fn new(tool_name: impl Into<String>, state: EventState) -> Self {
        StreamEvent {
            tool_name: tool_name.into(),
            session_id: "tauri-local".into(),
            state,
            source: EventSource::Hook,
            input: None,
            response: None,
            data: None,
            timestamp: Utc::now().to_rfc3339(),
            event_id: Some(Uuid::new_v4().to_string()),
            correlation_id: None,
            error: None,
            otlp: None,
        }
    }

    pub fn with_input(mut self, input: serde_json::Value) -> Self {
        self.input = Some(input);
        self
    }

    pub fn with_response(mut self, response: serde_json::Value) -> Self {
        self.response = Some(response);
        self
    }

    pub fn with_data(mut self, data: impl Into<String>) -> Self {
        self.data = Some(data.into());
        self
    }

    pub fn with_correlation(mut self, id: impl Into<String>) -> Self {
        self.correlation_id = Some(id.into());
        self
    }

    pub fn with_error(mut self, message: impl Into<String>) -> Self {
        self.error = Some(StreamEventError {
            message: message.into(),
            code: None,
            details: None,
        });
        self
    }
}

/// Emit a StreamEvent to the Tauri webview.
///
/// The webview's TauriAdapter listens on "fredo-stream-event" and
/// forwards the payload into StreamContext.addEvent().
pub fn emit_stream_event(app: &AppHandle, event: StreamEvent) {
    if let Err(e) = app.emit("fredo-stream-event", &event) {
        eprintln!("[fredo] Failed to emit stream event: {e}");
    }
}
