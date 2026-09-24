#![allow(dead_code)]

pub mod commands;

use anyhow::Result;
use clap::{Parser, Subcommand};
use std::io::IsTerminal;

use crate::infrastructure::ipc::{send_cli_command, CliCommand, CliResponse};
use commands::emit::EmitArgs;
use commands::open_app::OpenAppArgs;
use commands::open_terminal::OpenTerminalArgs;
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
    /// Emit a FredoEvent into the running application
    Emit(EmitArgs),
    /// Check or perform Fredo setup operations (PATH, plugin, model, OTEL)
    Setup(SetupArgs),
    /// Open a Fredo app window by stable id or display name
    OpenApp(OpenAppArgs),
    /// Open the Terminal window, optionally starting a CLI in a folder
    OpenTerminal(OpenTerminalArgs),
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
    let response = send_cli_command(&ipc_cmd).await?;

    match exit_code_for_response(response.as_ref()) {
        0 => {
            if let Some(resp) = response {
                match resp.data {
                    Some(data) => println!("{}", serde_json::to_string_pretty(&data)?),
                    None => println!("ok"),
                }
            }
        }
        1 => {
            // Machine-readable failure data (e.g. the app-open outcome) goes to
            // stdout; the human-readable message stays on the log line.
            if let Some(data) = response.as_ref().and_then(|resp| resp.data.clone()) {
                println!("{}", serde_json::to_string_pretty(&data)?);
            }
            let message = response
                .as_ref()
                .and_then(|resp| resp.message.clone())
                .unwrap_or_else(|| "unknown error".to_string());
            tracing::error!(target: "fredo::cli", message = %message, "CLI error response");
            std::process::exit(1);
        }
        _ => {
            if std::io::stderr().is_terminal() {
                tracing::error!(target: "fredo::cli", "IPC socket not found");
                tracing::info!(target: "fredo::cli", "Tip: run `fredo` to launch the desktop app.");
            }
            std::process::exit(2);
        }
    }

    Ok(())
}

/// The CLI process exit code for an IPC round trip:
/// `0` — the command succeeded; `1` — the app handled it but reported failure;
/// `2` — the app is not running (the unchanged fallback).
pub fn exit_code_for_response(response: Option<&CliResponse>) -> i32 {
    match response {
        Some(resp) if resp.ok => 0,
        Some(_) => 1,
        None => 2,
    }
}

/// The process exit code for a clap parse failure: `0` for `--help` /
/// `--version` (a successful, informative request), `1` for a malformed
/// invocation (`invalid-argument`) — NEVER clap's default `2`, which this CLI
/// reserves for app-not-running (R-3.3 / R-4.4).
pub fn exit_code_for_parse_error(kind: clap::error::ErrorKind) -> i32 {
    match kind {
        clap::error::ErrorKind::DisplayHelp
        | clap::error::ErrorKind::DisplayVersion
        | clap::error::ErrorKind::DisplayHelpOnMissingArgumentOrSubcommand => 0,
        _ => 1,
    }
}

fn build_ipc_command(cmd: Commands) -> CliCommand {
    match cmd {
        Commands::Emit(args) => {
            let event = commands::emit::build_fredo_event_from_args(args)
                .expect("Failed to build FredoEvent from args");
            tracing::debug!(target: "fredo::cli", payload = ?event.payload, "CLI payload");
            let json = serde_json::to_string(&event).unwrap_or_default();
            let json_truncated = &json[..std::cmp::min(200, json.len())];
            tracing::debug!(target: "fredo::cli", json = %json_truncated, "CLI event JSON");
            CliCommand::EmitEvent { event }
        }
        Commands::OpenApp(args) => CliCommand::OpenApp {
            identity: args.identity,
        },
        Commands::OpenTerminal(args) => CliCommand::OpenTerminal {
            cli: args.cli,
            work_dir: args.dir,
        },
        Commands::Setup(_) => {
            // Setup commands are handled locally in run_async, not via IPC.
            unreachable!("Setup command should be handled before IPC dispatch")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::cli::commands::emit::EmitArgs;

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

        let event = match ipc_cmd {
            CliCommand::EmitEvent { event } => event,
            other => panic!("expected CliCommand::EmitEvent, got {other:?}"),
        };
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

    #[test]
    fn build_ipc_command_open_app_maps_identity() {
        let cmd = Commands::OpenApp(commands::open_app::OpenAppArgs {
            identity: "Mission Monitor".into(),
        });
        match build_ipc_command(cmd) {
            CliCommand::OpenApp { identity } => assert_eq!(identity, "Mission Monitor"),
            other => panic!("expected CliCommand::OpenApp, got {other:?}"),
        }
    }

    #[test]
    fn cli_help_lists_open_app_emit_and_setup() {
        use clap::CommandFactory;

        let mut root = Cli::command();
        let help = root.render_long_help().to_string();
        assert!(help.contains("open-app"), "`fredo --help` must list open-app:\n{help}");
        assert!(help.contains("open-terminal"), "`fredo --help` must list open-terminal:\n{help}");
        assert!(help.contains("emit"), "`fredo --help` must keep listing emit:\n{help}");
        assert!(help.contains("setup"), "`fredo --help` must keep listing setup:\n{help}");

        let sub = root
            .find_subcommand_mut("open-app")
            .expect("open-app is a registered subcommand");
        let sub_help = sub.render_long_help().to_string();
        assert!(
            sub_help.contains("IDENTITY"),
            "`fredo open-app --help` must name the identity argument:\n{sub_help}"
        );

        let terminal = root
            .find_subcommand_mut("open-terminal")
            .expect("open-terminal is a registered subcommand");
        let terminal_help = terminal.render_long_help().to_string();
        assert!(
            terminal_help.contains("--cli"),
            "`fredo open-terminal --help` must name --cli:\n{terminal_help}"
        );
        assert!(
            terminal_help.contains("--dir"),
            "`fredo open-terminal --help` must name --dir:\n{terminal_help}"
        );
    }

    #[test]
    fn build_ipc_command_open_terminal_maps_cli_and_dir() {
        let cmd = Commands::OpenTerminal(commands::open_terminal::OpenTerminalArgs {
            cli: Some("copilot".into()),
            dir: Some(r"C:\Code\fredo".into()),
        });
        match build_ipc_command(cmd) {
            CliCommand::OpenTerminal { cli, work_dir } => {
                assert_eq!(cli.as_deref(), Some("copilot"));
                assert_eq!(work_dir.as_deref(), Some(r"C:\Code\fredo"));
            }
            other => panic!("expected CliCommand::OpenTerminal, got {other:?}"),
        }
    }

    #[test]
    fn open_terminal_subcommand_parses_free_form_values() {
        // Free-form `Option<String>`s: an unknown CLI and a bogus dir parse
        // cleanly so the RUNNING APP (not clap) decides the outcome (R-3.4).
        let cli = Cli::try_parse_from([
            "fredo",
            "open-terminal",
            "--cli",
            "bogus",
            "--dir",
            r"C:\no-such-dir",
        ])
        .expect("free-form values parse as one invocation");
        match cli.command {
            Commands::OpenTerminal(args) => {
                assert_eq!(args.cli.as_deref(), Some("bogus"));
                assert_eq!(args.dir.as_deref(), Some(r"C:\no-such-dir"));
            }
            other => panic!("expected OpenTerminal, got {other:?}"),
        }
    }

    #[test]
    fn open_terminal_subcommand_accepts_no_args() {
        let cli = Cli::try_parse_from(["fredo", "open-terminal"]).expect("no-arg form parses");
        match cli.command {
            Commands::OpenTerminal(args) => {
                assert!(args.cli.is_none());
                assert!(args.dir.is_none());
            }
            other => panic!("expected OpenTerminal, got {other:?}"),
        }
    }

    #[test]
    fn exit_code_for_parse_error_never_returns_clap_default_two() {
        use clap::error::ErrorKind;
        // Help / version are successful, informative requests.
        assert_eq!(exit_code_for_parse_error(ErrorKind::DisplayHelp), 0);
        assert_eq!(exit_code_for_parse_error(ErrorKind::DisplayVersion), 0);
        // A malformed invocation is `invalid-argument` — exit 1, never 2.
        assert_eq!(exit_code_for_parse_error(ErrorKind::UnknownArgument), 1);
        assert_eq!(exit_code_for_parse_error(ErrorKind::InvalidValue), 1);
        assert_eq!(exit_code_for_parse_error(ErrorKind::MissingSubcommand), 1);
        assert_eq!(exit_code_for_parse_error(ErrorKind::ArgumentConflict), 1);
    }

    #[test]
    fn a_malformed_open_terminal_invocation_is_a_parse_error_exit_one() {
        // `--cli` with no value is clap's own parse error (the app never sees
        // it): main.rs turns that into `invalid-argument` / exit 1.
        let err = Cli::try_parse_from(["fredo", "open-terminal", "--cli"])
            .expect_err("a missing value is a parse error");
        assert_eq!(exit_code_for_parse_error(err.kind()), 1);

        let unknown = Cli::try_parse_from(["fredo", "open-terminal", "--bogus-flag"])
            .expect_err("an unknown flag is a parse error");
        assert_eq!(exit_code_for_parse_error(unknown.kind()), 1);
    }

    #[test]
    fn open_app_subcommand_parses_quoted_display_name() {
        let cli = Cli::try_parse_from(["fredo", "open-app", "Mission Monitor"])
            .expect("a quoted display name parses as ONE positional");
        match cli.command {
            Commands::OpenApp(args) => assert_eq!(args.identity, "Mission Monitor"),
            other => panic!("expected OpenApp, got {other:?}"),
        }
    }

    #[test]
    fn exit_code_for_response_maps_all_three_outcomes() {
        let ok = CliResponse::ok(serde_json::json!({ "outcome": "opened" }));
        assert_eq!(exit_code_for_response(Some(&ok)), 0);

        let failed = CliResponse {
            ok: false,
            message: Some("unknown app".into()),
            data: Some(serde_json::json!({ "outcome": "unknown" })),
        };
        assert_eq!(exit_code_for_response(Some(&failed)), 1);

        assert_eq!(exit_code_for_response(None), 2);
    }
}