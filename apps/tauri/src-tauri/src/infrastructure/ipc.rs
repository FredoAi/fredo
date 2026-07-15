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
use crate::infrastructure::comm::adapters::opencode::OpenCodeAdapter;
use crate::infrastructure::comm::bus::EventBus;
use crate::infrastructure::comm::contract::engine::ContractEngine;
use crate::infrastructure::comm::contract::EventContractEngine;
use crate::infrastructure::comm::event::Transport;
use crate::infrastructure::contract_407::MetricCollector;
use crate::infrastructure::telemetry::SpanCollector;

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
    "experimental.compaction.autocontinue",
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

        if writer.write_all(json.as_bytes()).await.is_err() {
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

    // Spec #523: Debug logging for subagent detection — capture raw before injection
    let raw_payload_str = serde_json::to_string(&payload).unwrap_or_default();
    let truncated = if raw_payload_str.len() > 2048 {
        format!("{}...<truncated, total {} bytes>", &raw_payload_str[..raw_payload_str.floor_char_boundary(2048)], raw_payload_str.len())
    } else {
        raw_payload_str
    };
    tracing::info!(target: "fredo::plugin", event_type = %event_type, raw = %truncated, "IPC RECEIVED");

    // Construct payload with authoritative CLI event_type, ALWAYS overriding
    // any existing event_type from the raw plugin event. The CLI's event_type
    // is the authoritative value — it's what the opencode plugin explicitly
    // forwarded (e.g., "session.status" from the catch-all event hook).
    // Without this override, the raw plugin's internal event_type (e.g.,
    // "agent_session") would be used instead, routing the event to the wrong
    // adapter handler (Bug #593).
    let payload_with_type = build_payload_with_event_type(event_type, payload);

    // Use shared OpenCodeAdapter from Tauri state (Spec #382 AC-4 fix).
    // The adapter must be a singleton so its internal session_to_correlation
    // map persists across events, preventing duplicate ECE buffers/nodes.
    let adapter = app.state::<std::sync::Arc<OpenCodeAdapter>>();
    let transport = Transport::Hook;

match adapter.transform(transport, payload_with_type).await {
        Ok(events) => {
            let count = events.len();

            // Telemetry: collect spans from events before routing to ContractEngine
            let collector = app.state::<std::sync::Arc<SpanCollector>>();
            collector.process_events(&events);

            // Metrics: collect metrics from events in parallel (REQ-1)
            let metric_collector = app.state::<std::sync::Arc<MetricCollector>>();
            metric_collector.process_events(&events);

            // Route FredoEvents through the ContractEngine, then emit deliveries
            let engine = app.state::<std::sync::Arc<ContractEngine>>();
            let bus = app.state::<EventBus>();
            for fredo_event in events {
                let deliveries = engine.req_2_3_process(fredo_event);
                for delivery in deliveries {
                    bus.emit_delivery(delivery);
                }
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
    let payload = &enriched.payload;
    tracing::debug!(target: "fredo::ipc", ?payload, ?enriched.event_type, "IPC emit");

    // Route through ContractEngine, then emit deliveries
    let engine = app.state::<std::sync::Arc<ContractEngine>>();
    let bus = app.state::<crate::infrastructure::comm::EventBus>();
    let deliveries = engine.req_2_3_process(enriched);
    for delivery in deliveries {
        bus.emit_delivery(delivery);
    }

    CliResponse::ok(serde_json::json!({ "queued": true }))
}

// ── Payload construction (extracted for testability) ─────────────────────────

/// Build a new payload object with the authoritative CLI `event_type` injected
/// as the first key, overriding any existing `event_type` from the raw payload.
///
/// All other fields from the original payload are preserved. If `payload` is
/// not a JSON Object (edge case), a new Object is created containing only the
/// `event_type` field.
fn build_payload_with_event_type(event_type: &str, payload: serde_json::Value) -> serde_json::Value {
    let mut obj = serde_json::Map::new();
    obj.insert(
        "event_type".to_string(),
        serde_json::Value::String(event_type.to_string()),
    );
    if let serde_json::Value::Object(m) = &payload {
        for (k, v) in m {
            // Skip event_type — the CLI's authoritative value was already set above.
            // Without this skip, the original payload's event_type would overwrite
            // the CLI's value (serde_json::Map::insert replaces existing keys).
            if k != "event_type" {
                obj.insert(k.clone(), v.clone());
            }
        }
    }
    serde_json::Value::Object(obj)
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

#[cfg(test)]
mod tests {
    use super::*;

    /// REQ-1: `event_type` is injected when the raw payload has no `event_type` field.
    #[test]
    fn injects_event_type_when_missing() {
        let payload = serde_json::json!({
            "properties": {
                "sessionID": "sess-001",
                "text": "hello"
            }
        });
        let result = build_payload_with_event_type("session.status", payload);

        let obj = result.as_object().unwrap();
        assert_eq!(
            obj.get("event_type").and_then(|v| v.as_str()),
            Some("session.status"),
            "event_type should be injected when missing from payload"
        );
    }

    /// REQ-2: `event_type` is overridden when the raw payload HAS an `event_type` field.
    #[test]
    fn overrides_event_type_when_present() {
        let payload = serde_json::json!({
            "event_type": "agent_session",
            "properties": {
                "sessionID": "sess-002"
            }
        });
        let result = build_payload_with_event_type("session.status", payload);

        let obj = result.as_object().unwrap();
        assert_eq!(
            obj.get("event_type").and_then(|v| v.as_str()),
            Some("session.status"),
            "event_type should be overridden when already present in payload"
        );
        // The overridden value must NOT be the original
        assert_ne!(
            obj.get("event_type").and_then(|v| v.as_str()),
            Some("agent_session"),
            "event_type must not retain the original value"
        );
    }

    /// REQ-3: All other fields from the raw payload are preserved.
    #[test]
    fn preserves_other_fields() {
        let payload = serde_json::json!({
            "event_type": "chat",
            "properties": {
                "sessionID": "sess-003",
                "text": "Hello world"
            },
            "tool_input": {
                "sessionID": "sess-003"
            }
        });
        let result = build_payload_with_event_type("chat.message", payload);

        let obj = result.as_object().unwrap();
        // event_type was overridden
        assert_eq!(
            obj.get("event_type").and_then(|v| v.as_str()),
            Some("chat.message"),
            "event_type should be overridden"
        );
        // All other fields preserved
        assert!(
            obj.contains_key("properties"),
            "properties field should be preserved"
        );
        assert!(
            obj.contains_key("tool_input"),
            "tool_input field should be preserved"
        );
        assert_eq!(
            obj.get("properties")
                .and_then(|v| v.get("sessionID"))
                .and_then(|v| v.as_str()),
            Some("sess-003"),
            "nested properties.sessionID should be preserved"
        );
    }

    /// REQ-4: Specific `session.status` scenario — raw event has
    /// `event_type: "agent_session"`, CLI event_type is `"session.status"` →
    /// payload has `event_type: "session.status"` with all other fields preserved.
    #[test]
    fn session_status_overrides_agent_session() {
        let payload = serde_json::json!({
            "event_type": "agent_session",
            "sessionID": "sess-004",
            "properties": {
                "sessionID": "sess-004",
                "info": {
                    "id": "sess-004",
                    "delta": "some delta text"
                }
            }
        });
        let result = build_payload_with_event_type("session.status", payload);

        let obj = result.as_object().unwrap();
        // event_type must be the CLI's authoritative value
        assert_eq!(
            obj.get("event_type").and_then(|v| v.as_str()),
            Some("session.status"),
            "session.status CLI event_type must override agent_session"
        );
        // sessionID preserved
        assert_eq!(
            obj.get("sessionID").and_then(|v| v.as_str()),
            Some("sess-004"),
            "sessionID should be preserved"
        );
        // Nested properties preserved
        assert!(
            obj.contains_key("properties"),
            "properties should be preserved"
        );
        assert_eq!(
            obj.get("properties")
                .and_then(|v| v.get("info"))
                .and_then(|v| v.get("delta"))
                .and_then(|v| v.as_str()),
            Some("some delta text"),
            "delta text should be preserved"
        );
        // The original agent_session value is gone
        assert_ne!(
            obj.get("event_type").and_then(|v| v.as_str()),
            Some("agent_session"),
            "original event_type 'agent_session' must not survive"
        );
    }
}