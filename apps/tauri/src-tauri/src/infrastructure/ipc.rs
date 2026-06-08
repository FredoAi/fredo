#![allow(dead_code, unused_variables)]

use anyhow::Result;
use interprocess::local_socket::{
    tokio::{prelude::*, Stream},
    GenericFilePath, ListenerOptions,
};
use serde::{Deserialize, Serialize};
use std::io;
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::infrastructure::comm::adapter::CommAdapter;
use crate::infrastructure::comm::bus::EventBus;
use crate::infrastructure::comm::event::Transport;
use crate::infrastructure::comm::OpenCodeAdapter;

/// The local socket path / named pipe name used by both the IPC server (app)
/// and the CLI client.
#[cfg(windows)]
pub const SOCKET_NAME: &str = r"\\.\pipe\fredo-ipc";

#[cfg(not(windows))]
pub const SOCKET_NAME: &str = "/tmp/fredo-ipc.sock";

// ── Event type allowlist (SEC-REQ-2) ──────────────────────────────────────────

const ALLOWED_EVENT_TYPES: &[&str] = &[
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "chat.message",
    "message.updated", "message.part.updated", "message.part.delta",
    "message.removed", "message.part.removed",
    "permission.asked", "permission.replied",
    "file.edited", "command.executed",
    "session.created", "session.updated", "session.deleted",
    "session.status", "session.error", "session.idle",
    "session.next.tool.called", "session.next.tool.success", "session.next.tool.failed",
    "session.next.text.delta", "session.next.text.started", "session.next.text.ended",
    "session.next.step.started", "session.next.step.ended",
    "session.next.agent.switched",
];

/// Maximum payload size accepted over the IPC socket (1 MB).
const MAX_PAYLOAD_BYTES: usize = 1024 * 1024;

// ── Command types ─────────────────────────────────────────────────────────────

/// Commands the CLI sends over the local socket as newline-delimited JSON.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[allow(clippy::large_enum_variant)]
pub enum CliCommand {
    /// Forward an OpenCode plugin event (tool hooks, chat events, lifecycle events).
    /// The `payload` is the raw JSON object supplied by the OpenCode runtime.
    OpenCodePlugin {
        event_type: String,
        #[serde(default)]
        payload: serde_json::Value,
    },
    /// Generic Fredo event emission — speaks the FredoEvent contract directly.
    EmitEvent {
        event: crate::infrastructure::comm::event::FredoEvent,
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

    // SEC-REQ-1: On Unix, restrict socket to owner-only to prevent
    // unauthorized local processes from injecting events.
    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(permissions) = std::fs::metadata(SOCKET_NAME.trim_start_matches("unix:")) {
            let mut perms = permissions.permissions();
            perms.set_mode(0o600);
            let _ = std::fs::set_permissions(SOCKET_NAME.trim_start_matches("unix:"), perms);
        }
    }

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

        #[allow(clippy::redundant_pattern_matching)]
        if let Err(_) = writer.write_all(json.as_bytes()).await {
            break;
        }
    }
}

async fn dispatch_command(cmd: CliCommand, app: &AppHandle) -> CliResponse {
    match cmd {
        CliCommand::OpenCodePlugin {
            event_type,
            payload,
        } => dispatch_opencode_plugin(&event_type, payload, app).await,
        CliCommand::EmitEvent { event } => dispatch_emit_event(event, app),
    }
}

/// Dispatch a single OpenCode plugin event using OpenCodeAdapter.
///
/// Uses OpenCodeAdapter::transform(Transport::Hook, payload) to convert
/// the plugin event into FredoEvents, then emits them via EventBus.
///
/// `tool_use_id` from the plugin payload is used as `correlationId`
/// so Init and Response events for the same tool call are paired in the UI.
async fn dispatch_opencode_plugin(
    event_type: &str,
    payload: serde_json::Value,
    app: &AppHandle,
) -> CliResponse {
    // SEC-REQ-2: Validate event type against allowlist
    if !ALLOWED_EVENT_TYPES.contains(&event_type) {
        return CliResponse::err(format!("Unknown event type: {event_type}"));
    }

    // SEC-REQ-4: Reject payloads larger than 1 MB
    let payload_len = serde_json::to_vec(&payload).map(|v| v.len()).unwrap_or(0);
    if payload_len > MAX_PAYLOAD_BYTES {
        return CliResponse::err(format!(
            "Payload too large: {payload_len} bytes (max {MAX_PAYLOAD_BYTES})"
        ));
    }

    // Construct payload with explicit event_type for OpenCodeAdapter
    let payload_with_type = if payload.get("event_type").is_none() {
        let p = payload;
        let mut obj = serde_json::Map::new();
        obj.insert("event_type".to_string(), serde_json::Value::String(event_type.to_string()));
        if let serde_json::Value::Object(m) = &p {
            for (k, v) in m {
                obj.insert(k.clone(), v.clone());
            }
        }
        serde_json::Value::Object(obj)
    } else {
        payload
    };

    // Append raw event to debug dump file (~/.fredo/event-dump.jsonl)
    crate::utils::dump::append_event_dump(&payload_with_type);

    // Use OpenCodeAdapter to transform the payload into FredoEvents
    let adapter = OpenCodeAdapter::new();
    let transport = Transport::Hook;

match adapter.transform(transport, payload_with_type).await {
        Ok(events) => {
            let count = events.len();
            // Emit all FredoEvents via EventBus
            let bus = app.state::<EventBus>();
            for event in events {
                bus.emit(event);
            }
            CliResponse::ok(serde_json::json!({ "queued": count }))
        }
        Err(e) => CliResponse::err(format!("Transform failed: {e}")),
    }
}

/// Dispatch a `CliCommand::EmitEvent` by enriching the FredoEvent and emitting it
/// via the EventBus registered in Tauri state.
///
/// Per REQ-1.9, the InternalAdapter stamps defaults on the event.
/// Per REQ-1.17, the EventBus emits on the "fredo-stream-event" Tauri channel.
fn dispatch_emit_event(event: crate::infrastructure::comm::event::FredoEvent, app: &AppHandle) -> CliResponse {
    // Use InternalAdapter to enrich the event with server-side defaults
    let adapter = crate::infrastructure::comm::InternalAdapter::new();
    let enriched = adapter.enrich(event);

    // Emit via EventBus from Tauri state
    let bus = app.state::<crate::infrastructure::comm::EventBus>();
    bus.emit(enriched);

    CliResponse::ok(serde_json::json!({ "queued": true }))
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