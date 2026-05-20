#![allow(dead_code)]

use anyhow::Result;
use interprocess::local_socket::{
    tokio::{prelude::*, Stream},
    GenericFilePath, ListenerOptions,
};
use serde::{Deserialize, Serialize};
use std::io;
use tauri::AppHandle;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::infrastructure::events::{EventState, StreamEvent};
use crate::infrastructure::events::emit_stream_event;

/// The local socket path / named pipe name used by both the IPC server (app)
/// and the CLI client.
#[cfg(windows)]
pub const SOCKET_NAME: &str = r"\\.\pipe\fredo-ipc";

#[cfg(not(windows))]
pub const SOCKET_NAME: &str = "/tmp/fredo-ipc.sock";

// ── Command types ─────────────────────────────────────────────────────────────

/// Commands the CLI sends over the local socket as newline-delimited JSON.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CliCommand {
    /// Forward an agent lifecycle hook event (PreToolUse, PostToolUse, etc.).
    /// The `payload` is the raw JSON object supplied by the agent runtime.
    AgentHook {
        event_type: String,
        #[serde(default)]
        payload: serde_json::Value,
    },
}

/// Response the server sends back to the CLI after processing a command.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

impl CliResponse {
    pub fn ok(data: serde_json::Value) -> Self {
        CliResponse {
            ok: true,
            message: None,
            data: Some(data),
        }
    }

    pub fn err(msg: impl Into<String>) -> Self {
        CliResponse {
            ok: false,
            message: Some(msg.into()),
            data: None,
        }
    }
}

// ── IPC server ────────────────────────────────────────────────────────────────

/// Start the IPC socket server. Spawned as a background task when the Tauri app launches.
///
/// Accepts newline-delimited JSON `CliCommand` messages from CLI clients,
/// executes the corresponding handler, and emits a `StreamEvent` to the webview.
pub async fn start_ipc_server(app: AppHandle) -> Result<()> {
    // Clean up stale socket on Unix before binding
    #[cfg(not(windows))]
    let _ = std::fs::remove_file(SOCKET_NAME);

    let name = SOCKET_NAME.to_fs_name::<GenericFilePath>()?;
    let opts = ListenerOptions::new().name(name);
    let listener = opts.create_tokio()?;

    loop {
        match listener.accept().await {
            Ok(conn) => {
                let app_clone = app.clone();
                tokio::spawn(handle_connection(conn, app_clone));
            }
            Err(e) if e.kind() == io::ErrorKind::ConnectionAborted => {
                // Client disconnected before completing handshake — ignore
            }
            Err(_) => {
                // ignore accept errors
            }
        }
    }
}

async fn handle_connection(conn: Stream, app: AppHandle) {
    let (reader, mut writer) = tokio::io::split(conn);
    let mut lines = BufReader::new(reader).lines();

    while let Ok(Some(line)) = lines.next_line().await {
        let response = match serde_json::from_str::<CliCommand>(&line) {
            Ok(cmd) => dispatch_command(cmd, &app).await,
            Err(e) => CliResponse::err(format!("Invalid command JSON: {e}")),
        };

        let mut json = serde_json::to_string(&response).unwrap_or_else(|_| {
            r#"{"ok":false,"message":"Failed to serialize response"}"#.into()
        });
        json.push('\n');

        if let Err(_) = writer.write_all(json.as_bytes()).await {
            break;
        }
    }
}

async fn dispatch_command(cmd: CliCommand, app: &AppHandle) -> CliResponse {
    match cmd {
        CliCommand::AgentHook { event_type, payload } => {
            dispatch_agent_hook(&event_type, payload, app)
        }
    }
}

/// Dispatch a single agent lifecycle hook event.
///
/// - `PreToolUse` → Init event with the real MCP tool name
/// - `PostToolUse` → Response event with the real MCP tool name
/// - `PostToolUseFailure` → Error event with the real MCP tool name
/// - All other lifecycle events → a generic `agent_session` event
///
/// `tool_use_id` from the agent payload is used as `correlationId`
/// so Init and Response events for the same tool call are paired in the UI.
fn dispatch_agent_hook(event_type: &str, payload: serde_json::Value, app: &AppHandle) -> CliResponse {
    match event_type {
        "PreToolUse" | "preToolUse" => {
            let tool_name = payload
                .get("tool_name")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown_tool")
                .to_string();
            let tool_input = payload.get("tool_input").cloned().unwrap_or(serde_json::Value::Null);
            let correlation_id = payload
                .get("tool_use_id")
                .and_then(|v| v.as_str())
                .map(String::from)
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

            emit_stream_event(
                app,
                StreamEvent::new(tool_name, EventState::Init)
                    .with_input(tool_input)
                    .with_correlation(&correlation_id),
            );

            CliResponse::ok(serde_json::json!({ "queued": true, "correlation_id": correlation_id }))
        }

        "PostToolUse" | "postToolUse" => {
            let tool_name = payload
                .get("tool_name")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown_tool")
                .to_string();
            let tool_response = payload.get("tool_response").cloned().unwrap_or(serde_json::Value::Null);
            let correlation_id = payload
                .get("tool_use_id")
                .and_then(|v| v.as_str())
                .map(String::from)
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

            emit_stream_event(
                app,
                StreamEvent::new(tool_name, EventState::Response)
                    .with_response(tool_response)
                    .with_correlation(&correlation_id),
            );

            CliResponse::ok(serde_json::json!({ "queued": true, "correlation_id": correlation_id }))
        }

        "PostToolUseFailure" | "postToolUseFailure" => {
            let tool_name = payload
                .get("tool_name")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown_tool")
                .to_string();
            let error_msg = payload
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("Tool call failed")
                .to_string();
            let correlation_id = payload
                .get("tool_use_id")
                .and_then(|v| v.as_str())
                .map(String::from)
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

            emit_stream_event(
                app,
                StreamEvent::new(tool_name, EventState::Error)
                    .with_error(error_msg)
                    .with_correlation(&correlation_id),
            );

            CliResponse::ok(serde_json::json!({ "queued": true, "correlation_id": correlation_id }))
        }

        // Lifecycle events: SessionStart, SessionEnd, UserPromptSubmit, Stop, etc.
        _ => {
            let correlation_id = uuid::Uuid::new_v4().to_string();
            emit_stream_event(
                app,
                StreamEvent::new("agent_session", EventState::Init)
                    .with_input(serde_json::json!({ "event_type": event_type, "payload": payload }))
                    .with_correlation(&correlation_id),
            );

            CliResponse::ok(serde_json::json!({ "queued": true, "correlation_id": correlation_id }))
        }
    }
}

// ── CLI client helper (used by the CLI path in main.rs) ───────────────────────

/// Connect to the running Fredo app IPC socket, send a command, and return the response.
/// Returns `None` if the app is not running.
pub async fn send_cli_command(cmd: &CliCommand) -> Result<Option<CliResponse>> {
    let name = match SOCKET_NAME.to_fs_name::<GenericFilePath>() {
        Ok(n) => n,
        Err(e) => return Err(anyhow::anyhow!("Invalid socket name: {e}")),
    };

    let conn = match Stream::connect(name).await {
        Ok(c) => c,
        Err(e) if e.kind() == io::ErrorKind::NotFound || e.kind() == io::ErrorKind::ConnectionRefused => {
            return Ok(None); // App not running
        }
        Err(e) => return Err(e.into()),
    };

    let (reader, mut writer) = tokio::io::split(conn);
    let mut json = serde_json::to_string(cmd)?;
    json.push('\n');
    writer.write_all(json.as_bytes()).await?;

    let mut lines = BufReader::new(reader).lines();
    if let Some(line) = lines.next_line().await? {
        let resp: CliResponse = serde_json::from_str(&line)?;
        Ok(Some(resp))
    } else {
        Ok(None)
    }
}
