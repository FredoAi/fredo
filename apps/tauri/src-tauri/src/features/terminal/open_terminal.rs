//! `fredo open-terminal` — the in-app side of the CLI command (Spec #2935 ST-3).
//!
//! Validation runs BEFORE anything is opened or spawned: an unknown CLI, a
//! missing directory, or a malformed value is refused with a named outcome and
//! NO window is created and NO session starts (R-3.4 / R-4.1 / R-4.2). Only a
//! validated invocation opens/focuses the `terminal` window and delivers the
//! one-shot `terminal-open-request` launch intent.
//!
//! SINGLE SPAWNER (binding SI adjudication): the backend never spawns a session
//! here — the webview consumes the intent and calls `spawn_terminal_session`.
//! A backend spawn would double-spawn against the landed UI listener.

use std::sync::Arc;

use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

use crate::features::terminal::commands::{
    open_terminal_window_with_intent, terminal_host_label, PendingTerminalOpen,
    TerminalOpenRequestPayload,
};
use crate::features::terminal::state::{
    SessionKind, TerminalPresentation, DEFAULT_KIND, DEFAULT_PRESENTATION,
    TERMINAL_INTENT_AVAILABLE_EVENT, TERMINAL_PRESENTATION_KEY,
};
use crate::infrastructure::app_open::{confirm_feature_open, AppOpenOutcome};
use crate::infrastructure::ipc::CliResponse;
use crate::infrastructure::storage::AppStore;

/// The saved working directory a new session defaults to (mirrors the UI's
/// `WORK_DIR_KEY`, `apps/ui/src/features/terminal/settings.ts`).
pub const TERMINAL_WORK_DIR_KEY: &str = "terminal_work_dir";
/// The saved default session kind (mirrors the UI's `DEFAULT_CLI_KEY`); absent →
/// a plain shell (the UI's `DEFAULT_KIND`). The stored value domain now also
/// includes `"shell"` (Spec #2942 R-3.1/R-4.3).
pub const TERMINAL_DEFAULT_CLI_KEY: &str = "terminal_default_cli";

/// The named reasons an `open-terminal` invocation is refused in-app. Every one
/// exits 1 (`invalid-argument`/`invalid-cli`/`invalid-directory`) — distinct from
/// app-not-running's exit 2.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpenTerminalRejection {
    UnknownCli,
    MissingDirectory,
    Malformed,
}

impl OpenTerminalRejection {
    /// The machine-readable outcome (also the exit-1 discriminator).
    pub fn outcome(self) -> &'static str {
        match self {
            Self::UnknownCli => "invalid-cli",
            Self::MissingDirectory => "invalid-directory",
            Self::Malformed => "invalid-argument",
        }
    }
}

/// Validate the `--cli` value. `Ok(None)` = absent (use the saved default); a
/// blank value is malformed (`invalid-argument`) and an unknown name is
/// `invalid-cli` — never a clap parse error (the field is a free-form String).
pub fn parse_cli_arg(
    raw: Option<&str>,
) -> Result<Option<SessionKind>, (OpenTerminalRejection, String)> {
    let Some(value) = raw else { return Ok(None) };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err((
            OpenTerminalRejection::Malformed,
            "`--cli` requires a non-empty value".to_string(),
        ));
    }
    match SessionKind::parse(trimmed) {
        Some(kind) => Ok(Some(kind)),
        None => Err((
            OpenTerminalRejection::UnknownCli,
            format!("Unknown session type `{trimmed}` — use `shell`, `opencode` or `copilot`"),
        )),
    }
}

/// Validate the `--dir` value. `Ok(None)` = absent OR blank (the persisted
/// default is used — a blank `--dir` is never an error, R-4.2); a supplied path
/// that is not an existing directory is `invalid-directory`.
pub fn parse_dir_arg(
    raw: Option<&str>,
) -> Result<Option<String>, (OpenTerminalRejection, String)> {
    let Some(value) = raw else { return Ok(None) };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if !std::path::Path::new(trimmed).is_dir() {
        return Err((
            OpenTerminalRejection::MissingDirectory,
            format!("Working directory not found: {trimmed}"),
        ));
    }
    Ok(Some(trimmed.to_string()))
}

/// The exit-1 response for a validated-in-app refusal.
fn rejection_response(rejection: OpenTerminalRejection, message: String) -> CliResponse {
    CliResponse {
        ok: false,
        message: Some(message.clone()),
        data: Some(json!({ "outcome": rejection.outcome(), "message": message })),
    }
}

/// The exit-1 response for an open request that reported `failed` (both the
/// native-window build failure and the same-window non-`opened` confirmation):
/// nothing was spawned — validation and the intent arm/disarm are the only
/// effects.
fn failed_response(message: String) -> CliResponse {
    CliResponse {
        ok: false,
        message: Some(message.clone()),
        data: Some(json!({ "outcome": "failed", "message": message })),
    }
}

/// The persisted presentation mode, applying the absent/unrecognized →
/// [`DEFAULT_PRESENTATION`] fallback (R-4.1). Read per dispatch.
fn persisted_presentation(app: &AppHandle) -> TerminalPresentation {
    app.try_state::<Arc<AppStore>>()
        .and_then(|state| state.get(TERMINAL_PRESENTATION_KEY).ok().flatten())
        .and_then(|raw| TerminalPresentation::parse(&raw))
        .unwrap_or(DEFAULT_PRESENTATION)
}

/// Tell the active Terminal host an armed launch intent is ready to drain (the
/// WARM same-window path: the workspace is already mounted, so no mount
/// handshake will run). A cold workspace already drained the one-shot intent on
/// its mount — `take` is destructive, so exactly one spawn happens either way.
fn emit_terminal_intent_available(app: &AppHandle) {
    if let Err(error) = app.emit_to(
        terminal_host_label(app),
        TERMINAL_INTENT_AVAILABLE_EVENT,
        (),
    ) {
        tracing::error!(
            target: "fredo::terminal",
            error = %error,
            "emit terminal-intent-available failed"
        );
    }
}

/// Dispatch `CliCommand::OpenTerminal`. Validates FIRST (no window / no spawn on
/// a refusal), then branches on the persisted presentation:
///
/// - `same-window` → arm the one-shot intent (when a flag was supplied) BEFORE
///   the request, run the shipped `app-open-request` round trip so the in-window
///   workspace opens/focuses its single `terminal` kernel entry, then on an
///   `opened` confirmation emit [`TERMINAL_INTENT_AVAILABLE_EVENT`] so a warm
///   workspace drains the intent. A non-`opened` confirmation is `failed`
///   (exit 1) having spawned nothing.
/// - `new-window` → the shipped [`open_terminal_window_with_intent`] path
///   (`opened`/`started`/`failed`), byte-identical to before.
///
/// The backend NEVER spawns a session (single-spawner adjudication): the webview
/// consumes the intent.
pub async fn dispatch_open_terminal(
    cli: Option<String>,
    work_dir: Option<String>,
    app: &AppHandle,
) -> CliResponse {
    let cli_arg = match parse_cli_arg(cli.as_deref()) {
        Ok(value) => value,
        Err((rejection, message)) => return rejection_response(rejection, message),
    };
    let dir_arg = match parse_dir_arg(work_dir.as_deref()) {
        Ok(value) => value,
        Err((rejection, message)) => return rejection_response(rejection, message),
    };

    // A supplied flag (even a blank `--dir`) is a launch request; no flag at all
    // is a plain open (`opened`, no session).
    let has_args = cli.is_some() || work_dir.is_some();

    let store = app.try_state::<Arc<AppStore>>();
    let stored_cli = store
        .as_ref()
        .and_then(|state| state.get(TERMINAL_DEFAULT_CLI_KEY).ok().flatten())
        .and_then(|value| SessionKind::parse(value.trim()));
    let stored_dir = store
        .as_ref()
        .and_then(|state| state.get(TERMINAL_WORK_DIR_KEY).ok().flatten())
        .filter(|value| !value.trim().is_empty());

    // `--cli` omitted → the saved default (else a plain shell, the shipped
    // `DEFAULT_KIND`); `--dir` omitted → the saved work dir (an empty dir lets
    // `spawn_terminal_session` apply its home fallback).
    let effective_cli = cli_arg.or(stored_cli).unwrap_or(DEFAULT_KIND);
    let effective_dir = dir_arg
        .or_else(|| stored_dir.map(|value| value.trim().to_string()))
        .unwrap_or_default();

    let intent = has_args.then(|| TerminalOpenRequestPayload {
        cli: effective_cli.wire().to_string(),
        work_dir: effective_dir.clone(),
    });

    let presentation = persisted_presentation(app);
    // The resolved mode is the branch discriminator; `TerminalPresentation::wire`
    // reports it in the diagnostic (the same kebab-case value the frontend
    // persists), so the shared contract's inverse-of-parse is exercised in
    // production, not only by tests.
    tracing::debug!(
        target: "fredo::terminal",
        presentation = presentation.wire(),
        has_args,
        "fredo open-terminal dispatch"
    );

    if presentation == TerminalPresentation::SameWindow {
        // Arm BEFORE the request: a cold workspace's mount handshake
        // (`list_terminal_sessions`) drains the intent and can run before the
        // confirmation resolves.
        if let Some(payload) = intent {
            app.state::<PendingTerminalOpen>().arm(payload);
        }

        return match confirm_feature_open(app, "terminal").await {
            Some(confirmation) if confirmation.outcome == AppOpenOutcome::Opened => {
                if has_args {
                    emit_terminal_intent_available(app);
                    CliResponse::ok(json!({
                        "outcome": "started",
                        "cli": effective_cli.wire(),
                        "workDir": effective_dir,
                    }))
                } else {
                    CliResponse::ok(json!({ "outcome": "opened" }))
                }
            }
            other => failed_response(
                other
                    .and_then(|confirmation| confirmation.message)
                    .unwrap_or_else(|| "Terminal did not open in the main window".to_string()),
            ),
        };
    }

    if let Err(message) = open_terminal_window_with_intent(app, intent).await {
        return failed_response(message);
    }

    if has_args {
        CliResponse::ok(json!({
            "outcome": "started",
            "cli": effective_cli.wire(),
            "workDir": effective_dir,
        }))
    } else {
        CliResponse::ok(json!({ "outcome": "opened" }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::cli::exit_code_for_response;

    // ── --cli validation ────────────────────────────────────────────────────

    #[test]
    fn parse_cli_accepts_the_known_wire_values() {
        assert_eq!(parse_cli_arg(Some("opencode")), Ok(Some(SessionKind::OpenCode)));
        assert_eq!(parse_cli_arg(Some("copilot")), Ok(Some(SessionKind::Copilot)));
        // Spec #2942 R-3.2 — `--cli shell` is a first-class plain-shell request.
        assert_eq!(parse_cli_arg(Some("shell")), Ok(Some(SessionKind::Shell)));
    }

    #[test]
    fn parse_cli_rejection_names_all_three_valid_values() {
        let (rejection, message) = parse_cli_arg(Some("bogus")).unwrap_err();
        assert_eq!(rejection, OpenTerminalRejection::UnknownCli);
        assert!(message.contains("shell"), "message should name shell: {message}");
        assert!(message.contains("opencode"), "message should name opencode: {message}");
        assert!(message.contains("copilot"), "message should name copilot: {message}");
    }

    #[test]
    fn the_no_cli_fallback_kind_is_the_plain_shell() {
        // Mirrors `dispatch_open_terminal`'s `cli_arg.or(stored).unwrap_or(...)`.
        assert_eq!(DEFAULT_KIND, SessionKind::Shell);
    }

    #[test]
    fn parse_cli_is_absent_when_not_supplied() {
        assert_eq!(parse_cli_arg(None), Ok(None));
    }

    #[test]
    fn parse_cli_rejects_an_unknown_name_as_invalid_cli() {
        let (rejection, message) = parse_cli_arg(Some("bogus")).unwrap_err();
        assert_eq!(rejection, OpenTerminalRejection::UnknownCli);
        assert_eq!(rejection.outcome(), "invalid-cli");
        assert!(message.contains("bogus"), "message should name the value: {message}");
    }

    #[test]
    fn parse_cli_is_case_sensitive_so_wrong_case_is_invalid_cli() {
        assert_eq!(
            parse_cli_arg(Some("OpenCode")).unwrap_err().0,
            OpenTerminalRejection::UnknownCli
        );
    }

    #[test]
    fn parse_cli_treats_a_blank_value_as_a_malformed_invocation() {
        for blank in ["", "   ", "\t"] {
            let (rejection, _) = parse_cli_arg(Some(blank)).unwrap_err();
            assert_eq!(rejection, OpenTerminalRejection::Malformed);
            assert_eq!(rejection.outcome(), "invalid-argument");
        }
    }

    #[test]
    fn parse_cli_trims_a_valid_value() {
        assert_eq!(parse_cli_arg(Some("  opencode  ")), Ok(Some(SessionKind::OpenCode)));
    }

    // ── --dir validation ────────────────────────────────────────────────────

    #[test]
    fn parse_dir_accepts_an_existing_directory() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_str().unwrap();
        assert_eq!(parse_dir_arg(Some(path)), Ok(Some(path.to_string())));
    }

    #[test]
    fn parse_dir_is_absent_when_not_supplied_or_blank() {
        assert_eq!(parse_dir_arg(None), Ok(None));
        assert_eq!(parse_dir_arg(Some("")), Ok(None));
        assert_eq!(parse_dir_arg(Some("   ")), Ok(None));
    }

    #[test]
    fn parse_dir_rejects_a_nonexistent_path_as_invalid_directory() {
        let (rejection, message) = parse_dir_arg(Some(r"C:\NonexistentDir2935")).unwrap_err();
        assert_eq!(rejection, OpenTerminalRejection::MissingDirectory);
        assert_eq!(rejection.outcome(), "invalid-directory");
        assert!(message.contains(r"C:\NonexistentDir2935"));
    }

    #[test]
    fn parse_dir_rejects_a_file_as_invalid_directory() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("not-a-dir.txt");
        std::fs::write(&file, b"x").unwrap();
        let (rejection, message) = parse_dir_arg(file.to_str()).unwrap_err();
        assert_eq!(rejection, OpenTerminalRejection::MissingDirectory);
        assert!(message.contains("not-a-dir.txt"));
    }

    // ── Exit-code contract ──────────────────────────────────────────────────

    #[test]
    fn a_rejection_is_a_handled_failure_exit_one() {
        for (rejection, outcome) in [
            (OpenTerminalRejection::UnknownCli, "invalid-cli"),
            (OpenTerminalRejection::MissingDirectory, "invalid-directory"),
            (OpenTerminalRejection::Malformed, "invalid-argument"),
        ] {
            let response = rejection_response(rejection, format!("{outcome} reason"));
            assert!(!response.ok);
            let data = response.data.clone().expect("a rejection carries machine-readable data");
            assert_eq!(data["outcome"], serde_json::json!(outcome));
            assert_eq!(data["message"], serde_json::json!(format!("{outcome} reason")));
            assert_eq!(
                exit_code_for_response(Some(&response)),
                1,
                "`{outcome}` must exit 1"
            );
        }
    }

    #[test]
    fn opened_and_started_are_success_contracts_exit_zero() {
        let opened = CliResponse::ok(serde_json::json!({ "outcome": "opened" }));
        assert_eq!(exit_code_for_response(Some(&opened)), 0);

        let started = CliResponse::ok(serde_json::json!({
            "outcome": "started",
            "cli": "opencode",
            "workDir": r"C:\Code\fredo",
        }));
        assert_eq!(exit_code_for_response(Some(&started)), 0);
    }

    #[test]
    fn app_not_running_is_the_only_exit_two() {
        assert_eq!(exit_code_for_response(None), 2);
    }

    #[test]
    fn failed_outcome_is_a_handled_failure_exit_one() {
        // Spec #2947 ST-5 — BOTH the native-window build failure and the
        // same-window non-`opened` confirmation map to `failed` (exit 1) with
        // machine-readable data, having spawned nothing (R-4.2/R-4.3).
        let response = failed_response("Terminal did not open in the main window".into());
        assert!(!response.ok);
        let data = response.data.clone().expect("a failed response carries data");
        assert_eq!(data["outcome"], serde_json::json!("failed"));
        assert_eq!(
            data["message"],
            serde_json::json!("Terminal did not open in the main window")
        );
        assert_eq!(exit_code_for_response(Some(&response)), 1);
    }
}
