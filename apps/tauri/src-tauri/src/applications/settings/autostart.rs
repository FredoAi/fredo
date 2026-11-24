//! Per-user login auto-start backend (Spec #2992 ST-6 / R-4; reworked by
//! Spec #3193 ST-2).
//!
//! Installs or removes ONE per-user
//! `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` value (`FredoIngest`)
//! whose data is exactly `"<current_exe>" --background` — the login launch
//! enters the SAME resident, windowless instance
//! ([`crate::infrastructure::launch`]), so capture is running the moment the
//! operator signs in. The registry value is the effective state (G-272); the
//! `ingest.autostart` control-plane KV key mirrors it for the settings surface.
//! Every `reg.exe` invocation is wall-clock bounded ([`REG_TIMEOUT`], G-263).
//!
//! **One builder.** [`background_launch_command`] owns the installed string and
//! [`crate::infrastructure::launch::BACKGROUND_FLAG`] owns the flag literal, so
//! the flag spelling has exactly one definition. No code path builds the
//! retired `fredo ingest` form.
//!
//! **Ownership, not presence.** [`classify_run_entry`] is the ONE normaliser
//! shared by the startup migration and the settings toggle:
//!
//! * [`RunEntryClass::OwnedCurrent`] — the value is this product's current form.
//! * [`RunEntryClass::OwnedLegacy`] — the value is the retired `"<exe>" ingest`
//!   form for THIS executable; it is migrated in place (startup AND toggle),
//!   preserving the enabled state.
//! * [`RunEntryClass::Foreign`] — anything else: another application, a
//!   different Fredo installation, or an unparseable command. It is NEVER
//!   rewritten and NEVER deleted, so it stays byte-identical after startup and
//!   after a disable (R-3).
//!
//! Non-goals: no OS service, no elevation, no `HKLM`, and no
//! `tauri-plugin-autostart` (it cannot express the resident shell). On a
//! platform without a per-user Run key both commands answer
//! `Ok(… available: false)` instead of failing on a missing `reg.exe`, so the
//! settings surface renders its "unavailable" state truthfully.

use std::path::Path;
use std::process::{Output, Stdio};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;

use crate::infrastructure::launch::BACKGROUND_FLAG;
use crate::infrastructure::storage::SettingsStore;

/// The per-user (HKCU) login auto-start registry key.
pub const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";

/// The registry value name of the login entry.
pub const VALUE_NAME: &str = "FredoIngest";

/// The control-plane KV key mirroring the effective registry state.
pub const AUTOSTART_KEY: &str = "ingest.autostart";

/// The bounded wall-clock ceiling on any single `reg.exe` invocation (G-263).
pub const REG_TIMEOUT: Duration = Duration::from_secs(10);

/// Whether this platform exposes a per-user login `Run` key.
///
/// `false` everywhere except Windows. Both commands then answer
/// `Ok(… available: false)` without ever spawning `reg.exe` (which does not
/// exist there), which is what lets the settings surface render an honest
/// "unavailable" state instead of a plain `Off` or an error.
pub const AUTOSTART_AVAILABLE: bool = cfg!(target_os = "windows");

/// The settings-surface view of the login auto-start entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestAutostartView {
    /// Whether a value with this name is present (the registry is the source
    /// of truth, G-272 — a foreign value is present too).
    pub enabled: bool,
    /// The raw command data as read back (`"<exe>" --background`, the legacy
    /// form, or a foreign command).
    pub command: Option<String>,
    /// The full registry value path when present.
    pub entry: Option<String>,
    /// Whether this platform can install a per-user login entry at all.
    pub available: bool,
    /// Whether the present value is THIS product's
    /// ([`RunEntryClass::is_owned`]) — `false` when absent or foreign.
    pub owned: bool,
}

/// How a `FredoIngest` registry value classifies against THIS executable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunEntryClass {
    /// No value with this name exists — the normal "off" state.
    Absent,
    /// The value is exactly [`background_launch_command`].
    OwnedCurrent,
    /// The value is the retired `"<exe>" ingest` form for this executable.
    OwnedLegacy,
    /// Present, but the command belongs to something else.
    Foreign,
}

impl RunEntryClass {
    /// The ONE ownership predicate — consulted by the startup migration, the
    /// settings toggle and the view projection so they cannot drift.
    pub fn is_owned(self) -> bool {
        matches!(self, RunEntryClass::OwnedCurrent | RunEntryClass::OwnedLegacy)
    }
}

/// The full registry value path shown in the settings surface.
pub fn entry_path() -> String {
    format!(r"{RUN_KEY}\{VALUE_NAME}")
}

/// The ONE command line installed in the login entry: the quoted current
/// executable followed by exactly one space and the launch flag —
/// `"<exe>" --background`. No trailing space, no extra arguments.
pub fn background_launch_command(exe: &Path) -> String {
    format!("\"{}\" {BACKGROUND_FLAG}", exe.display())
}

/// Classify a present (or absent) registry value against this executable.
///
/// `None` is [`RunEntryClass::Absent`]; the current string is
/// [`RunEntryClass::OwnedCurrent`]; the retired `ingest` form for this
/// executable is [`RunEntryClass::OwnedLegacy`]; everything else is
/// [`RunEntryClass::Foreign`].
pub fn classify_run_entry(data: Option<&str>, exe: &Path) -> RunEntryClass {
    let Some(data) = data else {
        return RunEntryClass::Absent;
    };
    if data == background_launch_command(exe) {
        return RunEntryClass::OwnedCurrent;
    }
    if matches_legacy_ingest(data, exe) {
        return RunEntryClass::OwnedLegacy;
    }
    RunEntryClass::Foreign
}

/// Whether `data` is the retired login form for THIS executable: a quoted
/// executable token, then a lone `ingest` argument (ASCII case-insensitive),
/// and the token denotes the SAME FILE as `exe`.
///
/// Same-file test: `fs::canonicalize` on both sides (the primary rule); when
/// canonicalisation fails (moved/uninstalled target) a case-insensitive string
/// comparison decides. Unquoted, unbalanced-quoted and extra-argument commands
/// never match, so they stay foreign.
pub fn matches_legacy_ingest(data: &str, exe: &Path) -> bool {
    let Some((token, rest)) = split_quoted_executable(data) else {
        return false;
    };
    if !rest.trim().eq_ignore_ascii_case("ingest") {
        return false;
    }
    same_executable(token, exe)
}

/// Split `"<token>" <rest>` into the quoted executable token and everything
/// after the closing quote. `None` when the value is not quoted or the quote is
/// unbalanced — an unparseable command is never "fixed".
fn split_quoted_executable(data: &str) -> Option<(&str, &str)> {
    let quoted = data.trim_start().strip_prefix('"')?;
    let (token, rest) = quoted.split_once('"')?;
    if token.is_empty() {
        return None;
    }
    Some((token, rest))
}

/// Whether the executable token denotes the same file as `exe`.
fn same_executable(token: &str, exe: &Path) -> bool {
    if let (Ok(candidate), Ok(target)) =
        (std::fs::canonicalize(token), std::fs::canonicalize(exe))
    {
        return candidate == target;
    }
    token.eq_ignore_ascii_case(&exe.display().to_string())
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

/// This process's own executable.
fn current_exe() -> Result<std::path::PathBuf, String> {
    std::env::current_exe().map_err(|e| format!("Failed to resolve the Fredo executable: {e}"))
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

/// Install the current form (`reg add … /t REG_SZ /d <command> /f`) and return
/// the command that was written.
async fn write_current_entry(exe: &Path) -> Result<String, String> {
    let command = background_launch_command(exe);
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
    Ok(command)
}

/// Remove the value (`reg delete … /f`).
async fn delete_entry() -> Result<(), String> {
    let output = run_reg(&["delete", RUN_KEY, "/v", VALUE_NAME, "/f"]).await?;
    if !output.status.success() {
        return Err(reg_error("remove the login auto-start entry", &output));
    }
    Ok(())
}

/// The non-Windows / no-Run-key view: nothing installed, nothing available.
fn unavailable_view() -> IngestAutostartView {
    IngestAutostartView {
        enabled: false,
        command: None,
        entry: None,
        available: false,
        owned: false,
    }
}

/// Project a read-back command + its classification onto the wire view (the
/// ONE projection, so `get`, `set` and the tests cannot diverge).
fn project_view(command: Option<String>, class: RunEntryClass) -> IngestAutostartView {
    let enabled = command.is_some();
    IngestAutostartView {
        enabled,
        entry: if enabled { Some(entry_path()) } else { None },
        available: AUTOSTART_AVAILABLE,
        owned: class.is_owned(),
        command,
    }
}

/// The effective view read straight from the registry (the source of truth).
async fn read_view() -> Result<IngestAutostartView, String> {
    if !AUTOSTART_AVAILABLE {
        return Ok(unavailable_view());
    }
    let exe = current_exe()?;
    let command = query_value().await?;
    let class = classify_run_entry(command.as_deref(), &exe);
    Ok(project_view(command, class))
}

/// Mirror the effective registry state onto the `ingest.autostart` KV key.
fn mirror_autostart(store: &Arc<SettingsStore>, enabled: bool) -> Result<(), String> {
    store
        .cached_set(AUTOSTART_KEY, if enabled { "true" } else { "false" })
        .map_err(|e| e.to_string())
}

/// What startup migration does with an observed entry class — the ONE decision
/// table (pure and total, so migration and its unit table cannot drift).
fn migration_outcome(class: RunEntryClass) -> MigrationOutcome {
    match class {
        RunEntryClass::Absent => MigrationOutcome::NoEntry,
        RunEntryClass::OwnedCurrent => MigrationOutcome::AlreadyCurrent,
        RunEntryClass::OwnedLegacy => MigrationOutcome::Migrated,
        RunEntryClass::Foreign => MigrationOutcome::ForeignUntouched,
    }
}

/// The observed effect of one startup migration pass.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MigrationOutcome {
    /// No value with this name exists — startup never enables anything.
    NoEntry,
    /// Already the current form — no `reg add` is performed (idempotent).
    AlreadyCurrent,
    /// An owned legacy entry was rewritten in place; presence preserved.
    Migrated,
    /// A value this product does not own — left byte-identical.
    ForeignUntouched,
}

/// Migrate the login entry AT STARTUP (AC3): an owned legacy
/// `"<exe>" ingest` value is rewritten in place to the current form, preserving
/// the enabled state; an absent, current or foreign value performs no write.
///
/// The same [`classify_run_entry`] normaliser drives the settings toggle, so
/// "at startup" and "on toggle" cannot drift.
pub async fn migrate_owned_entry(exe: &Path) -> Result<MigrationOutcome, String> {
    if !AUTOSTART_AVAILABLE {
        return Ok(MigrationOutcome::NoEntry);
    }
    let current = query_value().await?;
    let class = classify_run_entry(current.as_deref(), exe);
    let outcome = migration_outcome(class);
    match outcome {
        MigrationOutcome::Migrated => {
            let from = current.unwrap_or_default();
            let to = write_current_entry(exe).await?;
            tracing::info!(
                target: "fredo::settings::autostart",
                from = %from,
                to = %to,
                "login entry migrated"
            );
            Ok(MigrationOutcome::Migrated)
        }
        MigrationOutcome::ForeignUntouched => {
            tracing::info!(
                target: "fredo::settings::autostart",
                command = %current.unwrap_or_default(),
                "login entry is not Fredo's; leaving it untouched"
            );
            Ok(MigrationOutcome::ForeignUntouched)
        }
        MigrationOutcome::NoEntry | MigrationOutcome::AlreadyCurrent => Ok(outcome),
    }
}

/// Spawn the startup migration (AC3).
///
/// Spawned through `tauri::async_runtime::spawn` (never `tokio::spawn`) and
/// never awaited, so the bounded `reg.exe` call can neither block nor fail
/// startup; a failure is logged. A no-op on platforms without a Run key.
///
/// The `AppHandle` is accepted to keep the composition root's startup hooks
/// uniform (`start_companion_engine_on_launch(app.handle())`); the migration
/// itself needs no managed state — it reads the registry and exits.
pub fn spawn_startup_migration(_app: tauri::AppHandle) {
    if !AUTOSTART_AVAILABLE {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let exe = match current_exe() {
            Ok(exe) => exe,
            Err(error) => {
                tracing::warn!(
                    target: "fredo::settings::autostart",
                    error = %error,
                    "login entry migration failed"
                );
                return;
            }
        };
        if let Err(error) = migrate_owned_entry(&exe).await {
            tracing::warn!(
                target: "fredo::settings::autostart",
                error = %error,
                "login entry migration failed"
            );
        }
    });
}

/// Read the effective per-user login auto-start state.
#[tauri::command]
pub async fn ingest_autostart_get(
    store: tauri::State<'_, Arc<SettingsStore>>,
) -> Result<IngestAutostartView, String> {
    let view = read_view().await?;
    mirror_autostart(store.inner(), view.enabled)?;
    Ok(view)
}

/// Enable or disable the per-user login auto-start entry.
///
/// Both directions run through the SAME [`classify_run_entry`] normaliser as
/// the startup migration:
///
/// * enable — always writes the current form, which migrates a legacy entry in
///   place and recovers a foreign one (the recovery path);
/// * disable — removes the value only when this product owns it, so a foreign
///   value survives byte-identical and the returned view reports it truthfully
///   (`enabled: true`, `owned: false`).
///
/// Disable is idempotent: an absent value is already removed.
#[tauri::command]
pub async fn ingest_autostart_set(
    enabled: bool,
    store: tauri::State<'_, Arc<SettingsStore>>,
) -> Result<IngestAutostartView, String> {
    let view = apply_toggle(enabled).await?;
    mirror_autostart(store.inner(), view.enabled)?;
    Ok(view)
}

/// The toggle itself (one normaliser with [`migrate_owned_entry`]).
async fn apply_toggle(enabled: bool) -> Result<IngestAutostartView, String> {
    if !AUTOSTART_AVAILABLE {
        return Ok(unavailable_view());
    }
    let exe = current_exe()?;
    if enabled {
        let before = query_value().await?;
        let class = classify_run_entry(before.as_deref(), &exe);
        let to = write_current_entry(&exe).await?;
        if class == RunEntryClass::OwnedLegacy {
            tracing::info!(
                target: "fredo::settings::autostart",
                from = %before.unwrap_or_default(),
                to = %to,
                "login entry migrated"
            );
        }
    } else {
        let current = query_value().await?;
        let class = classify_run_entry(current.as_deref(), &exe);
        if class.is_owned() {
            delete_entry().await?;
        } else if class == RunEntryClass::Foreign {
            tracing::info!(
                target: "fredo::settings::autostart",
                command = %current.unwrap_or_default(),
                "login entry is not Fredo's; leaving it untouched"
            );
        }
    }
    read_view().await
}

#[cfg(test)]
mod tests {
    use super::*;

    use serde_json::json;

    fn test_exe() -> std::path::PathBuf {
        std::env::current_exe().expect("the test process has an executable path")
    }

    /// The retired form, built from the executable so the table never contains a
    /// hard-coded install path.
    fn legacy_command(exe: &Path) -> String {
        format!("\"{}\" ingest", exe.display())
    }

    #[test]
    fn background_launch_command_is_the_quoted_exe_then_the_launch_flag() {
        let command = background_launch_command(Path::new(r"C:\Program Files\Fredo\fredo.exe"));
        assert_eq!(
            command,
            "\"C:\\Program Files\\Fredo\\fredo.exe\" --background"
        );
        // The flag literal has exactly ONE owner: the launch seam.
        assert!(command.ends_with(BACKGROUND_FLAG));
        // Exactly one quoted token, one separator space, no trailing space.
        assert_eq!(command.matches('"').count(), 2);
        assert_eq!(command, command.trim_end());
        assert_eq!(command.split('"').count(), 3);
        assert_eq!(command.rsplit('"').next(), Some(" --background"));
    }

    #[test]
    fn entry_path_is_the_run_value() {
        assert_eq!(
            entry_path(),
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run\FredoIngest"
        );
        assert_eq!(RUN_KEY, r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run");
        assert_eq!(VALUE_NAME, "FredoIngest");
        assert_eq!(REG_TIMEOUT, Duration::from_secs(10));
        assert_eq!(AUTOSTART_KEY, "ingest.autostart");
    }

    /// The ownership-predicate table (AC3): every row states its expected
    /// classification, so a regression in the normaliser is a named failure.
    #[test]
    fn ownership_predicate_classifies_every_entry_shape() {
        let exe = test_exe();
        let exe_display = exe.display().to_string();

        let cases: Vec<(String, RunEntryClass)> = vec![
            // Owned current: the shipped form.
            (
                format!("\"{exe_display}\" --background"),
                RunEntryClass::OwnedCurrent,
            ),
            // Owned legacy: the quoted exe + an `ingest` tail.
            (legacy_command(&exe), RunEntryClass::OwnedLegacy),
            // The same executable spelled with a different path case is still
            // ours (canonicalisation first, case-insensitive fallback second).
            (
                format!("\"{}\" ingest", exe_display.to_uppercase()),
                RunEntryClass::OwnedLegacy,
            ),
            // The tail is matched ASCII case-insensitively.
            (
                format!("\"{exe_display}\" INGEST"),
                RunEntryClass::OwnedLegacy,
            ),
            // Foreign: a DIFFERENT executable.
            (
                r#""C:\Program Files\Contoso\contoso.exe" ingest"#.to_string(),
                RunEntryClass::Foreign,
            ),
            // Foreign: the same executable but no `ingest` tail.
            (format!("\"{exe_display}\""), RunEntryClass::Foreign),
            // Foreign: the same executable with a different tail.
            (format!("\"{exe_display}\" emit"), RunEntryClass::Foreign),
            // Foreign: extra arguments after the legacy tail.
            (
                format!("\"{exe_display}\" ingest --now"),
                RunEntryClass::Foreign,
            ),
            // Foreign: unquoted.
            (format!("{exe_display} ingest"), RunEntryClass::Foreign),
            // Foreign: unbalanced quoting is never "fixed".
            (format!("\"{exe_display} ingest"), RunEntryClass::Foreign),
        ];

        for (data, expected) in cases {
            assert_eq!(
                classify_run_entry(Some(&data), &exe),
                expected,
                "classification of {data:?}"
            );
        }

        // Absent is the only `None` answer.
        assert_eq!(classify_run_entry(None, &exe), RunEntryClass::Absent);
    }

    #[test]
    fn only_the_owned_classes_count_as_owned() {
        assert!(RunEntryClass::OwnedCurrent.is_owned());
        assert!(RunEntryClass::OwnedLegacy.is_owned());
        assert!(!RunEntryClass::Foreign.is_owned());
        assert!(!RunEntryClass::Absent.is_owned());
    }

    /// The migration decision table (AC3): ONLY the owned legacy form is
    /// rewritten — presence is preserved, a foreign value is untouched.
    #[test]
    fn migration_rewrites_only_the_owned_legacy_form() {
        assert_eq!(migration_outcome(RunEntryClass::Absent), MigrationOutcome::NoEntry);
        assert_eq!(
            migration_outcome(RunEntryClass::OwnedCurrent),
            MigrationOutcome::AlreadyCurrent
        );
        assert_eq!(
            migration_outcome(RunEntryClass::OwnedLegacy),
            MigrationOutcome::Migrated
        );
        assert_eq!(
            migration_outcome(RunEntryClass::Foreign),
            MigrationOutcome::ForeignUntouched
        );
    }

    /// The STATIC pin that no production code path builds the retired `ingest`
    /// command: the ONE builder emits the quoted executable + the launch flag,
    /// and the file's production half contains neither a legacy builder nor the
    /// `ingest` tail. Read from the real source (`include_str!`), never a
    /// transcription.
    #[test]
    fn no_production_code_path_builds_the_ingest_command() {
        let source = include_str!("autostart.rs");
        let production = source
            .split("#[cfg(test)]")
            .next()
            .expect("the module has a production half");
        // Prose may NAME the retired form; the pin is about CODE. Comments are
        // dropped so a doc sentence is never mistaken for a builder.
        let code = production
            .lines()
            .filter(|line| !line.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");

        // Non-vacuity: the pin really reads the builder.
        assert!(
            code.contains("pub fn background_launch_command(exe: &Path) -> String"),
            "the ONE command builder must exist in the production source"
        );
        assert!(
            code.contains("BACKGROUND_FLAG"),
            "the builder must consume the launch flag constant, not a copy"
        );

        // Exactly ONE builder: the retired name is gone.
        assert!(
            !code.contains("fn autostart_command"),
            "the retired builder name must not survive anywhere in production code"
        );
        assert_eq!(
            code.matches("fn background_launch_command").count(),
            1,
            "exactly one command builder may exist"
        );

        // No production code line appends an `ingest` argument (the needle is
        // built here so the test's own source cannot masquerade as a hit).
        let retired_tail = format!("{} ingest", '"');
        assert!(
            !code.contains(&retired_tail),
            "no production code path may build the retired `ingest` form"
        );

        // The flag is never re-spelled as a literal — `BACKGROUND_FLAG` owns it.
        let flag_literal = format!("{}{}{}", '"', BACKGROUND_FLAG, '"');
        assert!(
            !code.contains(&flag_literal),
            "the launch flag literal must come from `BACKGROUND_FLAG`"
        );
    }

    #[test]
    fn parse_reg_query_reads_the_value_data() {
        let stdout = "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n    FredoIngest    REG_SZ    \"C:\\Program Files\\Fredo\\fredo.exe\" --background\r\n";
        assert_eq!(
            parse_reg_query_value(stdout),
            Some("\"C:\\Program Files\\Fredo\\fredo.exe\" --background".to_string())
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

    /// The wire contract (AC3/F-8): the two new fields cross IPC in camelCase
    /// beside the three existing ones, and `available` reports THIS platform's
    /// capability (pinned against the constant, so the pin holds everywhere).
    #[test]
    fn view_serializes_the_contract_fields_in_camel_case() {
        let view = project_view(
            Some("\"C:\\Program Files\\Fredo\\fredo.exe\" --background".to_string()),
            RunEntryClass::OwnedCurrent,
        );
        let value = serde_json::to_value(&view).unwrap();
        let keys: std::collections::BTreeSet<&str> = value
            .as_object()
            .expect("the view is a JSON object")
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            ["available", "command", "enabled", "entry", "owned"]
                .into_iter()
                .collect::<std::collections::BTreeSet<&str>>()
        );
        assert_eq!(value["enabled"], json!(true));
        assert_eq!(value["available"], json!(AUTOSTART_AVAILABLE));
        assert_eq!(value["owned"], json!(true));
        assert_eq!(
            value["entry"],
            json!(r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run\FredoIngest")
        );
    }

    /// The non-Windows shape (F-7): `available: false` serialises as a real
    /// JSON boolean beside an all-empty, off view — never an error, never a
    /// missing key.
    #[test]
    fn unavailable_view_serialises_the_non_windows_shape() {
        let value = serde_json::to_value(unavailable_view()).unwrap();
        assert_eq!(value["available"], json!(false));
        assert_eq!(value["owned"], json!(false));
        assert_eq!(value["enabled"], json!(false));
        assert!(value["command"].is_null());
        assert!(value["entry"].is_null());
    }

    /// A present-but-foreign value reads as `enabled: true, owned: false` — the
    /// stale-entry state the settings surface derives `Off` from.
    #[test]
    fn a_foreign_entry_is_present_but_not_owned() {
        let view = project_view(
            Some(r#""C:\Program Files\Contoso\contoso.exe" ingest"#.to_string()),
            RunEntryClass::Foreign,
        );
        assert!(view.enabled);
        assert!(!view.owned);
        assert_eq!(view.entry, Some(entry_path()));
    }

    #[test]
    fn an_absent_entry_is_off_and_not_owned() {
        let view = project_view(None, RunEntryClass::Absent);
        assert!(!view.enabled);
        assert!(!view.owned);
        assert!(view.command.is_none());
        assert!(view.entry.is_none());
    }

    /// The migration outcome is exposed for the call site's log routing; it is
    /// exhaustive by construction (every class has exactly one outcome).
    #[test]
    fn every_entry_class_has_exactly_one_migration_outcome() {
        let outcomes = [
            migration_outcome(RunEntryClass::Absent),
            migration_outcome(RunEntryClass::OwnedCurrent),
            migration_outcome(RunEntryClass::OwnedLegacy),
            migration_outcome(RunEntryClass::Foreign),
        ];
        let distinct: std::collections::BTreeSet<String> = outcomes
            .iter()
            .map(|outcome| format!("{outcome:?}"))
            .collect();
        assert_eq!(distinct.len(), outcomes.len(), "outcomes are one-to-one");
    }
}
