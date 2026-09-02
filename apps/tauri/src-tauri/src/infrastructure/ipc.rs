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
#[allow(clippy::large_enum_variant)]
pub enum CliCommand {
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

        if writer.write_all(json.as_bytes()).await.is_err() {
            break;
        }
    }
}

async fn dispatch_command(cmd: CliCommand, app: &AppHandle) -> CliResponse {
    match cmd {
        CliCommand::EmitEvent { event } => dispatch_emit_event(event, app),
    }
}

/// Dispatch a `CliCommand::EmitEvent` by enriching the FredoEvent and feeding
/// it to the RTDB ingest classifier.
///
/// Per REQ-1.9, the InternalAdapter stamps defaults on the event. The
/// classifier maps the enriched event's payload fields onto RTDB rows
/// (mock/CLI shapes per the fredo-cli-events skill conventions — real
/// OTLP-derived rows remain the primary shape).
fn dispatch_emit_event(event: crate::infrastructure::comm::event::FredoEvent, app: &AppHandle) -> CliResponse {
    // Use InternalAdapter to enrich the event with server-side defaults
    let adapter = crate::infrastructure::comm::InternalAdapter::new();
    let enriched = adapter.enrich(event);
    let payload = &enriched.payload;
    tracing::debug!(target: "fredo::ipc", ?payload, ?enriched.event_type, "IPC emit");

    // Spec #2788 P3.1: the classifier maps the event's payload fields onto
    // RTDB rows (mock/CLI shapes per the fredo-cli-events skill conventions —
    // real OTLP-derived rows remain the primary shape).
    let classifier = app.state::<crate::infrastructure::rtdb::ingest::IngestClassifierState>();
    let rows = classifier.ingest_event(&enriched);
    tracing::debug!(target: "fredo::rtdb::ingest", rows = rows, "IPC emit classified into RTDB rows");

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

