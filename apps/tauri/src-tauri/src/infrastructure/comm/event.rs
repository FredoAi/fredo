//! Event types for FredoEvent and related enums.
//!
//! Spec 1, GitHub issue #26: Communication Layer Foundation

use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// EventState uses PascalCase serialization per REQ-1.5.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "PascalCase")]
pub enum EventState {
    #[default]
    Init,
    Update,
    Response,
    Error,
}

/// Error detail attached to an Error-state FredoEvent.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FredoEventError {
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

/// The type of event per REQ-1.2.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventType {
    ToolUse,
    AgentSession,
    Chat,
    Infrastructure,
    Ui,
    Custom,
}

impl EventType {
    /// Returns the snake_case string representation matching serde serialization.
    /// Used by the ECE engine for contract filtering (eventTypes matching).
    pub fn as_str(&self) -> &'static str {
        match self {
            EventType::ToolUse => "tool_use",
            EventType::AgentSession => "agent_session",
            EventType::Chat => "chat",
            EventType::Infrastructure => "infrastructure",
            EventType::Ui => "ui",
            EventType::Custom => "custom",
        }
    }
}

/// The provider that originated the event per REQ-1.3.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventProvider {
    OpenCode,
    ClaudeCode,
    Internal,
}

impl EventProvider {
    /// Returns the snake_case string representation matching serde serialization.
    /// Used by the ECE engine for contract filtering (providers matching).
    pub fn as_str(&self) -> &'static str {
        match self {
            EventProvider::OpenCode => "open_code",
            EventProvider::ClaudeCode => "claude_code",
            EventProvider::Internal => "internal",
        }
    }
}

/// The transport mechanism per REQ-1.4.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Transport {
    Hook,
    OtlpGrpc,
    OtlpHttp,
    WebSocket,
    HttpPost,
    Internal,
}

impl Transport {
    /// Returns the snake_case string representation matching serde serialization.
    /// Used by the ECE engine for contract filtering (transports matching).
    pub fn as_str(&self) -> &'static str {
        match self {
            Transport::Hook => "hook",
            Transport::OtlpGrpc => "otlp_grpc",
            Transport::OtlpHttp => "otlp_http",
            Transport::WebSocket => "web_socket",
            Transport::HttpPost => "http_post",
            Transport::Internal => "internal",
        }
    }
}

/// FredoEvent — the canonical event shape for the Fredo desktop app.
///
/// Per REQ-1.1, all fields use camelCase serialization.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FredoEvent {
    pub id: String,
    pub event_type: EventType,
    pub state: EventState,
    pub provider: EventProvider,
    pub transport: Transport,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<FredoEventError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
    pub timestamp: String,
}

impl FredoEvent {
    /// Creates a new FredoEvent with required defaults for Internal/Hook.
    pub fn new(event_type: EventType, state: EventState) -> Self {
        FredoEvent {
            id: Uuid::new_v4().to_string(),
            event_type,
            state,
            provider: EventProvider::Internal,
            transport: Transport::Hook,
            session_id: "tauri-local".into(),
            correlation_id: None,
            tool_name: None,
            payload: None,
            error: None,
            metadata: None,
            timestamp: Utc::now().to_rfc3339(),
        }
    }

    /// Start a builder chain for FredoEvent.
    pub fn builder() -> FredoEventBuilder {
        FredoEventBuilder {
            event_type: EventType::ToolUse,
            state: EventState::Init,
            provider: EventProvider::Internal,
            transport: Transport::Hook,
            session_id: "tauri-local".into(),
            correlation_id: None,
            tool_name: None,
            payload: None,
            error: None,
            metadata: None,
        }
    }
}

/// Builder for FredoEvent.
#[derive(Debug, Clone)]
pub struct FredoEventBuilder {
    event_type: EventType,
    state: EventState,
    provider: EventProvider,
    transport: Transport,
    session_id: String,
    correlation_id: Option<String>,
    tool_name: Option<String>,
    payload: Option<serde_json::Value>,
    error: Option<FredoEventError>,
    metadata: Option<serde_json::Value>,
}

impl FredoEventBuilder {
    /// Set the event type.
    pub fn event_type(mut self, v: EventType) -> Self {
        self.event_type = v;
        self
    }

    /// Set the event state.
    pub fn state(mut self, v: EventState) -> Self {
        self.state = v;
        self
    }

    /// Set the provider.
    pub fn provider(mut self, v: EventProvider) -> Self {
        self.provider = v;
        self
    }

    /// Set the transport.
    pub fn transport(mut self, v: Transport) -> Self {
        self.transport = v;
        self
    }

    /// Set the session ID.
    pub fn session_id(mut self, v: impl Into<String>) -> Self {
        self.session_id = v.into();
        self
    }

    /// Set the tool name.
    pub fn tool_name(mut self, v: impl Into<String>) -> Self {
        self.tool_name = Some(v.into());
        self
    }

    /// Set the payload.
    pub fn payload(mut self, v: serde_json::Value) -> Self {
        self.payload = Some(v);
        self
    }

    /// Set the correlation ID.
    pub fn correlation_id(mut self, v: impl Into<String>) -> Self {
        self.correlation_id = Some(v.into());
        self
    }

    /// Set the error.
    pub fn error(mut self, v: FredoEventError) -> Self {
        self.error = Some(v);
        self
    }

    /// Set the metadata.
    pub fn metadata(mut self, v: serde_json::Value) -> Self {
        self.metadata = Some(v);
        self
    }

    /// Build the FredoEvent.
    pub fn build(self) -> FredoEvent {
        FredoEvent {
            id: Uuid::new_v4().to_string(),
            event_type: self.event_type,
            state: self.state,
            provider: self.provider,
            transport: self.transport,
            session_id: self.session_id,
            correlation_id: self.correlation_id,
            tool_name: self.tool_name,
            payload: self.payload,
            error: self.error,
            metadata: self.metadata,
            timestamp: Utc::now().to_rfc3339(),
        }
    }
}

// ── Spec #1499 (GA-4 / AC-4): session-span completion metadata keys ───────────
//
// Session spans (`fredo.session` → EventType::AgentSession) are forced to
// `EventState::Init` by REQ-609 so they never complete an ECE buffer early.
// `SpanCollector` only persists spans on `Response`/`Error`, so a completed
// session span would never land in `telemetry_spans`. The OtlpGrpc adapter
// attaches these metadata keys to the session-span Init event when the OTLP
// span is complete (endTimeUnixNano present); `SpanCollector` reads them to
// finalize + persist the span while the ECE delivery stays Init-only.
pub const OTEL_META_SPAN_COMPLETED: &str = "otel.span.completed";
pub const OTEL_META_SPAN_STATUS: &str = "otel.span.status";
pub const OTEL_META_SPAN_STATUS_MESSAGE: &str = "otel.span.statusMessage";
