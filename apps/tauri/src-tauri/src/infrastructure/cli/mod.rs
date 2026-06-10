#![allow(dead_code)]

pub mod commands;

use anyhow::Result;
use clap::{Parser, Subcommand};
use std::io::IsTerminal;

use crate::infrastructure::ipc::{send_cli_command, CliCommand};
use commands::emit::EmitArgs;
use commands::opencode_plugin::OpenCodePluginArgs;
use commands::setup::SetupArgs;

/// fredo — infrastructure AI CLI
///
/// Forwards OpenCode plugin events into the running Fredo desktop app
/// for real-time observability in the mission-control panel.
#[derive(Debug, Parser)]
#[command(name = "fredo", version, about, long_about = None)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Commands,
}

#[derive(Debug, Subcommand)]
pub enum Commands {
    /// Forward an OpenCode plugin event (used by the OpenCode plugin)
    OpenCodePlugin(OpenCodePluginArgs),
    /// Emit a FredoEvent into the running application
    Emit(EmitArgs),
    /// Check or perform Fredo setup operations (PATH, plugin, model, OTEL)
    Setup(SetupArgs),
}

/// Run the CLI. Connects to the running Fredo app over the local socket,
/// sends the command, and reports the outcome.
/// Falls back to printing JSON to stdout if the app is not running.
pub fn run(cli: Cli) -> Result<()> {
    let rt = tokio::runtime::Runtime::new()?;
    rt.block_on(async { run_async(cli).await })
}

async fn run_async(cli: Cli) -> Result<()> {
    // Setup commands run locally without requiring the app to be running
    if let Commands::Setup(ref args) = cli.command {
        return commands::setup::run_setup(args).await;
    }

    let ipc_cmd = build_ipc_command(cli.command);
    match send_cli_command(&ipc_cmd).await? {
        Some(resp) if resp.ok => {
            if let Some(data) = resp.data {
                println!("{}", serde_json::to_string_pretty(&data)?);
            } else {
                println!("ok");
            }
        }
        Some(resp) => {
            eprintln!("Error: {}", resp.message.unwrap_or_else(|| "unknown error".into()));
            std::process::exit(1);
        }
        None => {
            if std::io::stderr().is_terminal() {
                eprintln!(
                    "Fredo app is not running. Start it first with `fredo` (no arguments), then retry."
                );
                eprintln!("Tip: run `fredo` to launch the desktop app.");
            }
            std::process::exit(2);
        }
    }

    Ok(())
}

fn build_ipc_command(cmd: Commands) -> CliCommand {
    match cmd {
        Commands::OpenCodePlugin(args) => {
            // Payload comes from --payload flag or, when absent, stdin.
            let raw = args.payload.unwrap_or_else(|| {
                use std::io::Read;
                let mut buf = String::new();
                std::io::stdin().read_to_string(&mut buf).unwrap_or(0);
                buf
            });
            let payload = serde_json::from_str::<serde_json::Value>(&raw)
                .unwrap_or(serde_json::Value::Null);
            CliCommand::OpenCodePlugin {
                event_type: args.event_type,
                payload,
            }
        }
        Commands::Emit(args) => {
            let event = commands::emit::build_fredo_event_from_args(args)
                .expect("Failed to build FredoEvent from args");
            CliCommand::EmitEvent { event }
        }
        Commands::Setup(_) => {
            // Setup commands are handled locally in run_async, not via IPC.
            unreachable!("Setup command should be handled before IPC dispatch")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::cli::commands::{emit::EmitArgs, opencode_plugin::OpenCodePluginArgs};

    #[test]
    fn build_ipc_command_emit_event_maps_all_fields() {
        let args = EmitArgs {
            event_type: crate::infrastructure::cli::commands::emit::CliEventType::ToolUse,
            state: crate::infrastructure::cli::commands::emit::CliEventState::Init,
            tool_name: Some("test-tool".into()),
            session_id: "test-session".into(),
            correlation_id: Some("test-corr".into()),
            provider: crate::infrastructure::cli::commands::emit::CliEventProvider::Internal,
            payload: Some(r#"{"key":"value"}"#.into()),
            file: None,
        };
        let cmd = Commands::Emit(args);
        let ipc_cmd = build_ipc_command(cmd);

        match ipc_cmd {
            CliCommand::EmitEvent { event } => {
                assert_eq!(
                    event.event_type,
                    crate::infrastructure::comm::event::EventType::ToolUse
                );
                assert_eq!(event.state, crate::infrastructure::comm::event::EventState::Init);
                assert_eq!(
                    event.provider,
                    crate::infrastructure::comm::event::EventProvider::Internal
                );
                assert_eq!(event.session_id, "test-session");
                assert_eq!(event.tool_name, Some("test-tool".into()));
                assert_eq!(event.correlation_id, Some("test-corr".into()));
            }
            _ => panic!("Expected CliCommand::EmitEvent variant"),
        }
    }

    #[test]
    fn build_ipc_command_opencode_plugin_with_payload() {
        let args = OpenCodePluginArgs {
            event_type: "chat.message".into(),
            payload: Some(r#"{"text":"hello"}"#.into()),
        };
        let cmd = Commands::OpenCodePlugin(args);
        let ipc_cmd = build_ipc_command(cmd);

        match ipc_cmd {
            CliCommand::OpenCodePlugin { event_type, payload } => {
                assert_eq!(event_type, "chat.message");
                assert_eq!(payload, serde_json::json!({"text": "hello"}));
            }
            _ => panic!("Expected CliCommand::OpenCodePlugin variant"),
        }
    }

    #[test]
    fn build_ipc_command_opencode_plugin_no_payload_falls_back_to_stdin_null() {
        // Empty string payload fails serde parse, becomes Null (avoids blocking stdin read)
        let args = OpenCodePluginArgs {
            event_type: "session.created".into(),
            payload: Some("".into()),
        };
        let cmd = Commands::OpenCodePlugin(args);
        let ipc_cmd = build_ipc_command(cmd);

        match ipc_cmd {
            CliCommand::OpenCodePlugin { event_type, payload } => {
                assert_eq!(event_type, "session.created");
                assert_eq!(payload, serde_json::Value::Null);
            }
            _ => panic!("Expected CliCommand::OpenCodePlugin variant"),
        }
    }

    #[test]
    fn build_ipc_command_opencode_plugin_payload_invalid_json_falls_back_to_null() {
        let args = OpenCodePluginArgs {
            event_type: "permission.asked".into(),
            payload: Some("not valid json".into()),
        };
        let cmd = Commands::OpenCodePlugin(args);
        let ipc_cmd = build_ipc_command(cmd);

        match ipc_cmd {
            CliCommand::OpenCodePlugin { event_type, payload } => {
                assert_eq!(event_type, "permission.asked");
                assert_eq!(payload, serde_json::Value::Null);
            }
            _ => panic!("Expected CliCommand::OpenCodePlugin variant"),
        }
    }

    #[test]
    #[should_panic(expected = "Setup command should be handled before IPC dispatch")]
    fn build_ipc_command_setup_panics() {
        let args = commands::setup::SetupArgs {
            check: false,
            add_to_path: false,
            install_plugin: false,
            download_model: false,
        };
        let cmd = Commands::Setup(args);
        build_ipc_command(cmd);
    }
}