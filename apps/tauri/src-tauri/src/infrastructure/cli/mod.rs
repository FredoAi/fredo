#![allow(dead_code)]

pub mod commands;

use anyhow::Result;
use clap::{Parser, Subcommand};

use crate::infrastructure::ipc::{send_cli_command, CliCommand};
use commands::emit::EmitArgs;
use commands::opencode_plugin::OpenCodePluginArgs;

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
}

/// Run the CLI. Connects to the running Fredo app over the local socket,
/// sends the command, and reports the outcome.
/// Falls back to printing JSON to stdout if the app is not running.
pub fn run(cli: Cli) -> Result<()> {
    let rt = tokio::runtime::Runtime::new()?;
    rt.block_on(async { run_async(cli).await })
}

async fn run_async(cli: Cli) -> Result<()> {
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
            eprintln!(
                "Fredo app is not running. Start it first with `fredo` (no arguments), then retry."
            );
            eprintln!("Tip: run `fredo` to launch the desktop app.");
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
    }
}