#![allow(dead_code)]

pub mod commands;

use anyhow::Result;
use clap::{Args, Parser, Subcommand};

use crate::infrastructure::ipc::{send_cli_command, CliCommand};
use commands::hook::HookArgs;

/// fredo — infrastructure AI CLI
///
/// Forwards agent lifecycle hook events (PreToolUse, PostToolUse, etc.) into the
/// running Fredo desktop app for real-time observability.
#[derive(Debug, Parser)]
#[command(name = "fredo", version, about, long_about = None)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Commands,
}

#[derive(Debug, Subcommand)]
pub enum Commands {
    /// Forward an agent lifecycle hook event (used by the OpenCode plugin)
    Hook(HookArgs),
    /// Start the Fredo MCP server (exposes all tools to AI agents)
    Mcp(McpArgs),
}

/// Arguments for the `fredo mcp` subcommand.
#[derive(Debug, Args)]
pub struct McpArgs {
    /// Start an SSE/HTTP server instead of using stdio transport.
    #[arg(long)]
    pub sse: bool,

    /// Port for the SSE/HTTP server (only used with --sse, default: 3001).
    #[arg(long, default_value_t = 3001)]
    pub port: u16,
}

/// Run the CLI. Connects to the running Fredo app over the local socket,
/// sends the command, and reports the outcome.
/// Falls back to printing JSON to stdout if the app is not running.
pub fn run(cli: Cli) -> Result<()> {
    let rt = tokio::runtime::Runtime::new()?;
    rt.block_on(async { run_async(cli).await })
}

async fn run_async(cli: Cli) -> Result<()> {
    match cli.command {
        Commands::Mcp(args) => {
            // MCP server runs standalone — does NOT connect to the running app.
            if args.sse {
                crate::features::mcp::runner::run_sse(args.port).await?;
            } else {
                crate::features::mcp::runner::run_stdio().await?;
            }
        }
        cmd => {
            let ipc_cmd = build_ipc_command(cmd);
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
        }
    }

    Ok(())
}

fn build_ipc_command(cmd: Commands) -> CliCommand {
    match cmd {
        Commands::Hook(args) => {
            // Payload comes from --payload flag or, when absent, stdin.
            let raw = args.payload.unwrap_or_else(|| {
                use std::io::Read;
                let mut buf = String::new();
                std::io::stdin().read_to_string(&mut buf).unwrap_or(0);
                buf
            });
            let payload = serde_json::from_str::<serde_json::Value>(&raw)
                .unwrap_or(serde_json::Value::Null);
            CliCommand::AgentHook {
                event_type: args.event_type,
                payload,
            }
        }
        // Mcp is handled before this function is called.
        Commands::Mcp(_) => unreachable!(),
    }
}
