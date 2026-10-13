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

/// The local socket path / named pipe name for THIS process's environment.
///
/// Resolved at runtime from `FREDO_CLI_PIPE` (Spec #2944 ST-2, R-1.2): the
/// app's IPC server and the `fredo` CLI client run in separate processes, so
/// each resolves its OWN environment's pipe. When unset it is the legacy
/// default (`\\.\pipe\fredo-ipc`), byte-identical to the pre-#2944 constant.
pub fn socket_name() -> String {
    resolve_socket_name_with(|key| std::env::var(key).ok())
}

/// Pure resolution seam (G-222): the legacy default when `FREDO_CLI_PIPE` is
/// absent/blank, else the injected value. Delegates to [`EnvConfig`] so the
/// pipe is never re-derived.
fn resolve_socket_name_with(get: impl Fn(&str) -> Option<String>) -> String {
    crate::infrastructure::env::EnvConfig::resolve_with(get).cli_pipe
}

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
    /// Open a Fredo app window by identity (Spec #2893). The server waits for
    /// the webview's `confirm_app_open_request` before answering the CLI.
    OpenApp { identity: String },
    /// Open (or focus) the Terminal window, optionally starting a CLI in a
    /// folder (Spec #2935 ST-3). The server validates the args FIRST (no window
    /// and no spawn on a refusal), then delivers a `terminal-open-request`
    /// launch intent the webview consumes to spawn the session.
    OpenTerminal {
        cli: Option<String>,
        work_dir: Option<String>,
    },
    /// Export the Doom fine-tuning dataset to a LOCAL path (Spec #3032 ST-5).
    /// `format` is the canonical lowercase token (`raw|sft|dpo`; default `raw`);
    /// `out` may be relative (resolved under the dataset dir) or absent. The
    /// server calls ST-3's `export_doom_dataset` — no network I/O.
    DoomExportDataset {
        format: Option<String>,
        out: Option<String>,
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
    let socket = socket_name();

    // Clean up stale socket on Unix before binding
    #[cfg(not(windows))]
    let _ = std::fs::remove_file(&socket);

    let name = socket.as_str().to_fs_name::<GenericFilePath>()?;
    let opts = ListenerOptions::new().name(name);
    let listener = opts.create_tokio()?;

    // SEC-REQ-1: On Unix, restrict socket to owner-only to prevent
    // unauthorized local processes from injecting events.
    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;
        let path = socket.trim_start_matches("unix:");
        if let Ok(permissions) = std::fs::metadata(path) {
            let mut perms = permissions.permissions();
            perms.set_mode(0o600);
            let _ = std::fs::set_permissions(path, perms);
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
        CliCommand::EmitEvent { event } => dispatch_emit_event(event, app).await,
        CliCommand::OpenApp { identity } => {
            crate::infrastructure::app_open::dispatch_open_app(identity, app).await
        }
        CliCommand::OpenTerminal { cli, work_dir } => {
            crate::applications::terminal::open_terminal::dispatch_open_terminal(cli, work_dir, app).await
        }
        CliCommand::DoomExportDataset { format, out } => {
            dispatch_doom_export_dataset(format, out, app).await
        }
    }
}

/// Handle one `CliCommand::DoomExportDataset` from the IPC server: validate the
/// format token against the declared value set (G-254), run ST-3's LOCAL export
/// command, and translate the typed outcome into the CLI response (`ok` → exit 0;
/// a typed error → exit 1). The CLI performs no network I/O.
async fn dispatch_doom_export_dataset(
    format: Option<String>,
    out: Option<String>,
    app: &AppHandle,
) -> CliResponse {
    let format = match format.as_deref() {
        Some(token) => match crate::applications::doom::dataset::DoomDatasetFormat::parse(token) {
            Some(parsed) => Some(parsed),
            None => {
                return CliResponse::err(format!(
                    "invalid dataset format `{token}` (expected raw, sft, or dpo)"
                ))
            }
        },
        None => None,
    };

    match crate::applications::doom::commands::export_doom_dataset(app.clone(), format, out).await {
        Ok(result) => {
            CliResponse::ok(serde_json::to_value(result).unwrap_or(serde_json::Value::Null))
        }
        Err(error) => {
            let message = error.message.clone();
            CliResponse {
                ok: false,
                message: Some(message),
                data: Some(serde_json::to_value(error).unwrap_or(serde_json::Value::Null)),
            }
        }
    }
}

/// Dispatch a `CliCommand::EmitEvent` by enriching the FredoEvent and feeding
/// it to the RTDB ingest classifier.
///
/// Per REQ-1.9, the InternalAdapter stamps defaults on the event. The
/// classifier maps the enriched event's payload fields onto RTDB rows
/// (mock/CLI shapes per the fredo-cli-events skill conventions — real
/// OTLP-derived rows remain the primary shape).
async fn dispatch_emit_event(
    event: crate::infrastructure::comm::event::FredoEvent,
    app: &AppHandle,
) -> CliResponse {
    // Use InternalAdapter to enrich the event with server-side defaults
    let adapter = crate::infrastructure::comm::InternalAdapter::new();
    let enriched = adapter.enrich(event);
    let payload = &enriched.payload;
    tracing::debug!(target: "fredo::ipc", ?payload, ?enriched.event_type, "IPC emit");

    // Spec #2788 P3.1: the classifier maps the event's payload fields onto
    // RTDB rows (mock/CLI shapes per the fredo-cli-events skill conventions —
    // real OTLP-derived rows remain the primary shape).
    let classifier = app.state::<crate::infrastructure::rtdb::ingest::IngestClassifierState>();
    let rows = classifier.ingest_event(&enriched).await;
    tracing::debug!(target: "fredo::rtdb::ingest", rows = rows, "IPC emit classified into RTDB rows");

    CliResponse::ok(serde_json::json!({ "queued": true }))
}

// ── CLI client helper (used by the CLI path in main.rs) ───────────────────────

/// Connect to the running Fredo app IPC socket, send a command, and return the response.
/// Returns `None` if the app is not running.
pub async fn send_cli_command(cmd: &CliCommand) -> Result<Option<CliResponse>> {
    let socket = socket_name();
    let name = match socket.as_str().to_fs_name::<GenericFilePath>() {
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

    #[test]
    fn open_app_command_serializes_with_snake_case_tag() {
        let cmd = CliCommand::OpenApp {
            identity: "mission-monitor".into(),
        };
        let json = serde_json::to_value(&cmd).expect("CliCommand serializes");
        assert_eq!(
            json,
            serde_json::json!({ "type": "open_app", "identity": "mission-monitor" })
        );
    }

    #[test]
    fn open_app_command_round_trips() {
        let cmd = CliCommand::OpenApp {
            identity: "Mission Monitor".into(),
        };
        let json = serde_json::to_string(&cmd).expect("serialize");
        let decoded: CliCommand = serde_json::from_str(&json).expect("deserialize");
        match decoded {
            CliCommand::OpenApp { identity } => assert_eq!(identity, "Mission Monitor"),
            other => panic!("expected OpenApp, got {other:?}"),
        }
    }

    #[test]
    fn open_terminal_command_serializes_with_snake_case_tag_and_fields() {
        let cmd = CliCommand::OpenTerminal {
            cli: Some("opencode".into()),
            work_dir: Some(r"C:\Code\fredo".into()),
        };
        let json = serde_json::to_value(&cmd).expect("CliCommand serializes");
        assert_eq!(
            json,
            serde_json::json!({
                "type": "open_terminal",
                "cli": "opencode",
                "work_dir": "C:\\Code\\fredo",
            })
        );
    }

    #[test]
    fn open_terminal_command_round_trips_including_absent_args() {
        let cmd = CliCommand::OpenTerminal {
            cli: None,
            work_dir: None,
        };
        let json = serde_json::to_string(&cmd).expect("serialize");
        let decoded: CliCommand = serde_json::from_str(&json).expect("deserialize");
        match decoded {
            CliCommand::OpenTerminal { cli, work_dir } => {
                assert!(cli.is_none());
                assert!(work_dir.is_none());
            }
            other => panic!("expected OpenTerminal, got {other:?}"),
        }
    }

    /// ST-5 (R-4): the `DoomExportDataset` wire command serializes with the
    /// snake_case tag and its `format`/`out` fields.
    #[test]
    fn doom_export_dataset_command_serializes_with_snake_case_tag_and_fields() {
        let cmd = CliCommand::DoomExportDataset {
            format: Some("sft".into()),
            out: Some(".opencode/tmp/3032/export.jsonl".into()),
        };
        let json = serde_json::to_value(&cmd).expect("CliCommand serializes");
        assert_eq!(
            json,
            serde_json::json!({
                "type": "doom_export_dataset",
                "format": "sft",
                "out": ".opencode/tmp/3032/export.jsonl",
            })
        );
    }

    /// ST-5: an absent `out` round-trips (the server then uses the default
    /// `<dataset_dir>/exports/` path).
    #[test]
    fn doom_export_dataset_command_round_trips_including_absent_out() {
        let cmd = CliCommand::DoomExportDataset {
            format: Some("raw".into()),
            out: None,
        };
        let json = serde_json::to_string(&cmd).expect("serialize");
        let decoded: CliCommand = serde_json::from_str(&json).expect("deserialize");
        match decoded {
            CliCommand::DoomExportDataset { format, out } => {
                assert_eq!(format.as_deref(), Some("raw"));
                assert!(out.is_none());
            }
            other => panic!("expected DoomExportDataset, got {other:?}"),
        }
    }

    /// ST-2 regression invariant (R-1.2): with `FREDO_CLI_PIPE` unset the pipe
    /// name is the legacy literal, so the single-env IPC path is unchanged.
    #[test]
    fn socket_name_defaults_to_the_legacy_pipe_when_unset() {
        assert_eq!(
            resolve_socket_name_with(|_| None),
            crate::infrastructure::env::DEFAULT_CLI_PIPE
        );
    }

    /// ST-2 (R-1.2): a non-blank `FREDO_CLI_PIPE` selects the environment's own
    /// pipe at runtime (deterministic — injected lookup, no process env).
    #[test]
    fn socket_name_resolves_the_environment_pipe() {
        let pipe = r"\\.\pipe\fredo-ipc-spec2944";
        let resolved = resolve_socket_name_with(|key| {
            (key == crate::infrastructure::env::CLI_PIPE_ENV).then(|| pipe.to_string())
        });
        assert_eq!(resolved, pipe);
    }
}

