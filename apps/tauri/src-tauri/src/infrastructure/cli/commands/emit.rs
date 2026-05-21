use clap::{Parser, ValueEnum};
use serde::{Deserialize, Serialize};

use crate::infrastructure::comm::event::{EventProvider, EventState, EventType, FredoEvent};

/// Emit a FredoEvent into the running application.
#[derive(Parser, Debug)]
pub struct EmitArgs {
    /// Event type: tool_use, agent_session, chat, infrastructure, ui, custom
    #[arg(long, value_enum)]
    pub event_type: CliEventType,

    /// Event state: Init, Update, Response, Error
    #[arg(long, value_enum, default_value = "Init")]
    pub state: CliEventState,

    /// Tool name (required for tool_use events)
    #[arg(long)]
    pub tool_name: Option<String>,

    /// Session ID (defaults to "tauri-local")
    #[arg(long, default_value = "tauri-local")]
    pub session_id: String,

    /// Correlation ID (links Init↔Response pairs)
    #[arg(long)]
    pub correlation_id: Option<String>,

    /// Event provider: open_code, claude_code, internal
    #[arg(long, value_enum, default_value = "internal")]
    pub provider: CliEventProvider,

    /// JSON payload — the event body
    #[arg(long)]
    pub payload: Option<String>,

    /// Read event JSON from file (use - for stdin)
    #[arg(long)]
    pub file: Option<String>,
}

#[derive(Debug, Clone, ValueEnum, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CliEventType {
    ToolUse,
    AgentSession,
    Chat,
    Infrastructure,
    Ui,
    Custom,
}

#[derive(Debug, Clone, ValueEnum, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub enum CliEventState {
    Init,
    Update,
    Response,
    Error,
}

#[derive(Debug, Clone, ValueEnum, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CliEventProvider {
    OpenCode,
    ClaudeCode,
    Internal,
}

/// Build a FredoEvent from CLI emit arguments.
pub fn build_fredo_event_from_args(args: EmitArgs) -> anyhow::Result<FredoEvent> {
    let event_type = match args.event_type {
        CliEventType::ToolUse => EventType::ToolUse,
        CliEventType::AgentSession => EventType::AgentSession,
        CliEventType::Chat => EventType::Chat,
        CliEventType::Infrastructure => EventType::Infrastructure,
        CliEventType::Ui => EventType::Ui,
        CliEventType::Custom => EventType::Custom,
    };

    let state = match args.state {
        CliEventState::Init => EventState::Init,
        CliEventState::Update => EventState::Update,
        CliEventState::Response => EventState::Response,
        CliEventState::Error => EventState::Error,
    };

    let provider = match args.provider {
        CliEventProvider::OpenCode => EventProvider::OpenCode,
        CliEventProvider::ClaudeCode => EventProvider::ClaudeCode,
        CliEventProvider::Internal => EventProvider::Internal,
    };

    let payload = if let Some(ref file) = args.file {
        if file == "-" {
            let mut buf = String::new();
            std::io::Read::read_to_string(&mut std::io::stdin(), &mut buf)?;
            serde_json::from_str(&buf).unwrap_or(serde_json::Value::Null)
        } else {
            let content = std::fs::read_to_string(file)?;
            serde_json::from_str(&content).unwrap_or(serde_json::Value::Null)
        }
    } else if let Some(ref payload_str) = args.payload {
        serde_json::from_str(payload_str).unwrap_or(serde_json::Value::Null)
    } else {
        serde_json::Value::Null
    };

    let mut event = FredoEvent::builder()
        .event_type(event_type)
        .state(state)
        .provider(provider)
        .session_id(args.session_id)
        .payload(payload);

    if let Some(tn) = args.tool_name {
        event = event.tool_name(tn);
    }

    if let Some(cid) = args.correlation_id {
        event = event.correlation_id(cid);
    }

    // CLI events default to Hook transport, not Internal
    // (Internal is reserved for internal system events)
    let event = event.build();

    Ok(event)
}