use clap::{Parser, ValueEnum};
use serde::{Deserialize, Serialize};

use crate::infrastructure::comm::event::{EventProvider, EventState, EventType, FredoEvent, Transport};

/// Emit a FredoEvent into the running application (classified into RTDB rows).
#[derive(Parser, Debug)]
pub struct EmitArgs {
    /// Event type (snake_case): tool_use, agent_session, chat, infrastructure, ui, custom
    #[arg(long, value_enum)]
    pub event_type: CliEventType,

    /// Event state (snake_case): init (default), update, response, error
    #[arg(long, value_enum, default_value = "init")]
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

    /// Event provider (snake_case): open_code, claude_code, internal
    #[arg(long, value_enum, default_value = "internal")]
    pub provider: CliEventProvider,

    /// JSON payload — the event body
    #[arg(long)]
    pub payload: Option<String>,

    /// Read event payload JSON from file (use - for stdin)
    #[arg(long)]
    pub file: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[value(rename_all = "snake_case")]
pub enum CliEventType {
    ToolUse,
    AgentSession,
    Chat,
    Infrastructure,
    Ui,
    Custom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
#[value(rename_all = "snake_case")]
pub enum CliEventState {
    Init,
    Update,
    Response,
    Error,
}

#[derive(Debug, Clone, ValueEnum, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[value(rename_all = "snake_case")]
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
        .payload(payload)
        .transport(Transport::Hook);

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_fredo_event_from_args_maps_all_fields() {
        let args = EmitArgs {
            event_type: CliEventType::ToolUse,
            state: CliEventState::Init,
            tool_name: Some("test-tool".into()),
            session_id: "test-session".into(),
            correlation_id: Some("test-corr".into()),
            provider: CliEventProvider::Internal,
            payload: Some(r#"{"key":"value"}"#.into()),
            file: None,
        };

        let event = build_fredo_event_from_args(args).unwrap();

        assert_eq!(event.event_type, EventType::ToolUse);
        assert_eq!(event.state, EventState::Init);
        assert_eq!(event.provider, EventProvider::Internal);
        assert_eq!(event.transport, Transport::Hook);
        assert_eq!(event.session_id, "test-session");
        assert_eq!(event.tool_name, Some("test-tool".into()));
        assert_eq!(event.correlation_id, Some("test-corr".into()));
        let expected_payload = serde_json::json!({"key": "value"});
        assert_eq!(event.payload, Some(expected_payload));
    }

    #[test]
    fn build_fredo_event_from_args_handles_missing_optionals() {
        let args = EmitArgs {
            event_type: CliEventType::Infrastructure,
            state: CliEventState::Update,
            tool_name: None,
            session_id: "tauri-local".into(),
            correlation_id: None,
            provider: CliEventProvider::OpenCode,
            payload: None,
            file: None,
        };

        let event = build_fredo_event_from_args(args).unwrap();

        assert_eq!(event.event_type, EventType::Infrastructure);
        assert_eq!(event.state, EventState::Update);
        assert_eq!(event.provider, EventProvider::OpenCode);
        assert_eq!(event.transport, Transport::Hook);
        assert_eq!(event.tool_name, None);
        assert_eq!(event.correlation_id, None);
        assert_eq!(event.payload, Some(serde_json::Value::Null));
    }

    #[test]
    fn build_fredo_event_from_args_maps_custom_event_type() {
        let args = EmitArgs {
            event_type: CliEventType::Custom,
            state: CliEventState::Error,
            tool_name: None,
            session_id: "custom-session".into(),
            correlation_id: None,
            provider: CliEventProvider::ClaudeCode,
            payload: None,
            file: None,
        };

        let event = build_fredo_event_from_args(args).unwrap();

        assert_eq!(event.event_type, EventType::Custom);
        assert_eq!(event.state, EventState::Error);
        assert_eq!(event.provider, EventProvider::ClaudeCode);
    }

    #[test]
    fn build_fredo_event_from_args_agent_session_type() {
        let args = EmitArgs {
            event_type: CliEventType::AgentSession,
            state: CliEventState::Response,
            tool_name: Some("agent".into()),
            session_id: "session-1".into(),
            correlation_id: None,
            provider: CliEventProvider::OpenCode,
            payload: None,
            file: None,
        };

        let event = build_fredo_event_from_args(args).unwrap();

        assert_eq!(event.event_type, EventType::AgentSession);
        assert_eq!(event.state, EventState::Response);
        assert_eq!(event.tool_name, Some("agent".into()));
    }

    #[test]
    fn build_fredo_event_from_args_invalid_json_payload_falls_back_to_null() {
        let args = EmitArgs {
            event_type: CliEventType::Ui,
            state: CliEventState::Init,
            tool_name: None,
            session_id: "test".into(),
            correlation_id: None,
            provider: CliEventProvider::Internal,
            payload: Some("not valid json".into()),
            file: None,
        };

        let event = build_fredo_event_from_args(args).unwrap();

        assert_eq!(event.event_type, EventType::Ui);
        // Invalid JSON payload should result in Null
        assert_eq!(event.payload, Some(serde_json::Value::Null));
    }

    #[test]
    fn build_fredo_event_from_args_round_trips_event_states() {
        // Verify all four EventState values map correctly
        for (cli_state, expected) in [
            (CliEventState::Init, EventState::Init),
            (CliEventState::Update, EventState::Update),
            (CliEventState::Response, EventState::Response),
            (CliEventState::Error, EventState::Error),
        ] {
            let args = EmitArgs {
                event_type: CliEventType::ToolUse,
                state: cli_state,
                tool_name: None,
                session_id: "roundtrip".into(),
                correlation_id: None,
                provider: CliEventProvider::Internal,
                payload: None,
                file: None,
            };
            let event = build_fredo_event_from_args(args).unwrap();
            assert_eq!(event.state, expected, "EventState::{:?} should map correctly", expected);
        }
    }

    #[test]
    fn emit_args_state_defaults_to_init_when_omitted() {
        // Nit (c), Fix Plan round 4: `fredo emit` WITHOUT --state used to fail
        // its own value parser (the clap default "Init" did not match the
        // kebab/snake possible value). The default must parse and map to
        // EventState::Init.
            let args: EmitArgs = clap::Parser::try_parse_from([
            "emit",
            "--event-type",
            "tool_use",
            "--session-id",
            "default-state",
        ])
        .expect("--event-type tool_use must parse (nit b: snake_case value rename)");

        assert_eq!(args.state, CliEventState::Init);
        assert_eq!(args.event_type, CliEventType::ToolUse);

        let event = build_fredo_event_from_args(args).unwrap();
        assert_eq!(event.state, EventState::Init);
    }

    #[test]
    fn emit_args_accepts_snake_case_event_types_and_states() {
        // Nit (b), Fix Plan round 4: SKILL.md documents snake_case values
        // (tool_use, agent_session, chat) — clap's ValueEnum must accept them.
        for (raw, expected_type) in [
            ("tool_use", CliEventType::ToolUse),
            ("agent_session", CliEventType::AgentSession),
            ("chat", CliEventType::Chat),
            ("infrastructure", CliEventType::Infrastructure),
            ("ui", CliEventType::Ui),
            ("custom", CliEventType::Custom),
        ] {
            let args: EmitArgs = clap::Parser::try_parse_from(["emit", "--event-type", raw])
                .unwrap_or_else(|e| panic!("--event-type {raw} must parse: {e}"));
            assert_eq!(args.event_type, expected_type);
        }

        for (raw, expected_state) in [
            ("init", CliEventState::Init),
            ("update", CliEventState::Update),
            ("response", CliEventState::Response),
            ("error", CliEventState::Error),
        ] {
        let args: EmitArgs = clap::Parser::try_parse_from([
                "emit",
                "--event-type",
                "chat",
                "--state",
                raw,
            ])
            .unwrap_or_else(|e| panic!("--state {raw} must parse: {e}"));
            assert_eq!(args.state, expected_state);
        }
    }
}