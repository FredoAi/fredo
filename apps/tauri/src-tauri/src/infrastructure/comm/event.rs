//! Stub event types for FredoEvent and related enums.
//!
//! Minimal implementations so tests compile. The coder will flesh these out.
//!
//! Spec 1, GitHub issue #26: Communication Layer Foundation

use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// EventState uses PascalCase serialization per REQ-1.5.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub enum EventState {
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

/// The provider that originated the event per REQ-1.3.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventProvider {
    OpenCode,
    ClaudeCode,
    Internal,
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

impl FredoEvent {
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

impl FredoEventBuilder {
    pub fn event_type(mut self, v: EventType) -> Self {
        self.event_type = v;
        self
    }

    pub fn state(mut self, v: EventState) -> Self {
        self.state = v;
        self
    }

    pub fn provider(mut self, v: EventProvider) -> Self {
        self.provider = v;
        self
    }

    pub fn session_id(mut self, v: impl Into<String>) -> Self {
        self.session_id = v.into();
        self
    }

    pub fn tool_name(mut self, v: impl Into<String>) -> Self {
        self.tool_name = Some(v.into());
        self
    }

    pub fn payload(mut self, v: serde_json::Value) -> Self {
        self.payload = Some(v);
        self
    }

    pub fn correlation_id(mut self, v: impl Into<String>) -> Self {
        self.correlation_id = Some(v.into());
        self
    }

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