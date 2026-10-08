//! Per-user login auto-start backend (Spec #2992, ST-6 / R-4).
//!
//! Installs or removes a `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
//! value (`FredoIngest`) that launches the headless ingest daemon
//! (`"<exe>" ingest`) at login. The registry value is the effective state
//! (G-272); the `ingest.autostart` control-plane KV key mirrors it for the
//! settings surface. Every `reg.exe` invocation is wall-clock bounded (G-263).
//!
//! Non-goals (Spec #2992): no OS-level service, no elevation, and no
//! `tauri-plugin-autostart` (it would launch the GUI, not `fredo ingest`).

use std::path::Path;
use std::process::{Output, Stdio};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;

use crate::infrastructure::storage::AppStore;

/// The per-user (HKCU) login auto-start registry key.
pub const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";

/// The registry value name of the headless-ingest login entry.
pub const VALUE_NAME: &str = "FredoIngest";

/// The control-plane KV key mirroring the effective registry state.
pub const AUTOSTART_KEY: &str = "ingest.autostart";

/// The bounded wall-clock ceiling on any single `reg.exe` invocation (G-263).
pub const REG_TIMEOUT: Duration = Duration::from_secs(10);

/// The settings-surface view of the login auto-start entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestAutostartView {
    /// Whether the per-user login entry is currently installed.
    pub enabled: bool,
    /// The command the entry launches when enabled (`"<exe>" ingest`).
    pub command: Option<String>,
    /// The full registry value path when enabled.
    pub entry: Option<String>,
}

/// The full registry value path shown in the settings surface.
pub fn entry_path() -> String {
    format!(r"{RUN_KEY}\{VALUE_NAME}")
}

/// The command line installed in the login entry: the quoted current
/// executable followed by the `ingest` subcommand.
pub fn autostart_command(exe: &Path) -> String {
    format!("\"{}\" ingest", exe.display())
}

/// Parse the data column of a `reg query <key> /v <name>` line for
/// [`VALUE_NAME`]. Returns the raw command string when the value is present.
pub fn parse_reg_query_value(stdout: &str) -> Option<String> {
    for line in stdout.lines() {
        let trimmed = line.trim();
        let Some(rest) = trimmed.strip_prefix(VALUE_NAME) else {
            continue;
        };
        // The name token must be complete — a longer name that merely starts
        // with `FredoIngest` is a different value.
        if !rest.starts_with(|c: char| c.is_whitespace()) {
            continue;
        }
        let rest = rest.trim_start();
        // `rest` is now `<TYPE> <DATA...>`; the data is everything after the
        // first whitespace (it may itself contain spaces).
        if let Some((_kind, data)) = rest.split_once(|c: char| c.is_whitespace()) {
            return Some(data.trim().to_string());
        }
    }
    None
}

/// Run a bounded `reg.exe` invocation (G-263): the child is killed on drop and
/// the whole wait is capped at [`REG_TIMEOUT`].
async fn run_reg(args: &[&str]) -> Result<Output, String> {
    let mut command = tokio::process::Command::new("reg.exe");
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    match tokio::time::timeout(REG_TIMEOUT, command.output()).await {
        Ok(Ok(output)) => Ok(output),
        Ok(Err(error)) => Err(format!("Failed to run reg.exe: {error}")),
        Err(_) => Err(format!(
            "reg.exe exceeded the {} s bound",
            REG_TIMEOUT.as_secs()
        )),
    }
}

/// Render a failed `reg.exe` invocation as a user-facing message.
fn reg_error(action: &str, output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let detail = stderr.trim();
    if detail.is_empty() {
        format!(
            "Failed to {action}: reg.exe exited with code {}",
            output.status.code().unwrap_or(-1)
        )
    } else {
        format!("Failed to {action}: {detail}")
    }
}

/// Read the installed login-entry command, if any. `reg query` exits non-zero
/// when the value is absent — that is the normal "off" state, not an error.
async fn query_value() -> Result<Option<String>, String> {
    let output = run_reg(&["query", RUN_KEY, "/v", VALUE_NAME]).await?;
    if !output.status.success() {
        return Ok(None);
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(parse_reg_query_value(&stdout))
}

/// The effective view read straight from the registry (the source of truth).
async fn read_view() -> Result<IngestAutostartView, String> {
    match query_value().await? {
        Some(command) => Ok(IngestAutostartView {
            enabled: true,
            command: Some(command),
            entry: Some(entry_path()),
        }),
        None => Ok(IngestAutostartView {
            enabled: false,
            command: None,
            entry: None,
        }),
    }
}

/// Mirror the effective registry state onto the `ingest.autostart` KV key.
fn mirror_autostart(store: &Arc<AppStore>, enabled: bool) -> Result<(), String> {
    store
        .cached_set(AUTOSTART_KEY, if enabled { "true" } else { "false" })
        .map_err(|e| e.to_string())
}

/// Read the effective per-user login auto-start state.
#[tauri::command]
pub async fn ingest_autostart_get(
    store: tauri::State<'_, Arc<AppStore>>,
) -> Result<IngestAutostartView, String> {
    let view = read_view().await?;
    mirror_autostart(store.inner(), view.enabled)?;
    Ok(view)
}

/// Enable or disable the per-user login auto-start entry. Disable is
/// idempotent: an absent value is treated as already removed.
#[tauri::command]
pub async fn ingest_autostart_set(
    enabled: bool,
    store: tauri::State<'_, Arc<AppStore>>,
) -> Result<IngestAutostartView, String> {
    if enabled {
        let exe = std::env::current_exe()
            .map_err(|e| format!("Failed to resolve the Fredo executable: {e}"))?;
        let command = autostart_command(&exe);
        let output = run_reg(&[
            "add",
            RUN_KEY,
            "/v",
            VALUE_NAME,
            "/t",
            "REG_SZ",
            "/d",
            command.as_str(),
            "/f",
        ])
        .await?;
        if !output.status.success() {
            return Err(reg_error("install the login auto-start entry", &output));
        }
    } else if query_value().await?.is_some() {
        let output = run_reg(&["delete", RUN_KEY, "/v", VALUE_NAME, "/f"]).await?;
        if !output.status.success() {
            return Err(reg_error("remove the login auto-start entry", &output));
        }
    }

    let view = read_view().await?;
    mirror_autostart(store.inner(), view.enabled)?;
    Ok(view)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_quotes_exe_and_appends_ingest() {
        let command = autostart_command(Path::new(r"C:\Program Files\Fredo\fredo.exe"));
        assert_eq!(command, "\"C:\\Program Files\\Fredo\\fredo.exe\" ingest");
    }

    #[test]
    fn entry_path_is_the_run_value() {
        assert_eq!(
            entry_path(),
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run\FredoIngest"
        );
    }

    #[test]
    fn parse_reg_query_reads_the_value_data() {
        let stdout = "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n    FredoIngest    REG_SZ    \"C:\\Program Files\\Fredo\\fredo.exe\" ingest\r\n";
        assert_eq!(
            parse_reg_query_value(stdout),
            Some("\"C:\\Program Files\\Fredo\\fredo.exe\" ingest".to_string())
        );
    }

    #[test]
    fn parse_reg_query_ignores_a_missing_value() {
        let stdout =
            "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n";
        assert_eq!(parse_reg_query_value(stdout), None);
    }

    #[test]
    fn parse_reg_query_rejects_a_longer_name_with_the_same_prefix() {
        let stdout = "    FredoIngestOther    REG_SZ    other\r\n";
        assert_eq!(parse_reg_query_value(stdout), None);
    }

    #[test]
    fn view_serializes_the_contract_fields() {
        let enabled = IngestAutostartView {
            enabled: true,
            command: Some("cmd".to_string()),
            entry: Some("entry".to_string()),
        };
        let value = serde_json::to_value(&enabled).unwrap();
        assert_eq!(value["enabled"], serde_json::json!(true));
        assert_eq!(value["command"], serde_json::json!("cmd"));
        assert_eq!(value["entry"], serde_json::json!("entry"));

        let disabled = IngestAutostartView {
            enabled: false,
            command: None,
            entry: None,
        };
        let value = serde_json::to_value(&disabled).unwrap();
        assert_eq!(value["enabled"], serde_json::json!(false));
        assert!(value["command"].is_null());
        assert!(value["entry"].is_null());
    }
}
