//! Resume engine for persisted Terminal session records (Spec #2935 ST-2).
//!
//! Resume uses each CLI's OWN mechanism — never a keep-alive/detach and never a
//! silently substituted fresh session:
//!
//! | CLI      | exact id (`cli_session_id`) | last-session fallback |
//! |----------|-----------------------------|-----------------------|
//! | OpenCode | `--session <id>`            | `--continue`          |
//! | Copilot  | `--resume=<id>`             | `--continue`          |
//!
//! The flags were pinned by the ST-1 Phase-0 probe
//! (`apps/tauri/src-tauri/tests/terminal_cli_resume_probe.rs`,
//! `.opencode/tmp/2935/resume-probe.md`). Copilot's bare `--resume` opens an
//! INTERACTIVE session picker, so its deterministic last-session flag is
//! `--continue` (documented limitation: a Copilot resume targets the last
//! session in that directory, not a distinct conversation — Copilot exposes no
//! non-interactive listing surface to capture a native id).
//!
//! Every resume is bounded by [`RESUME_PREFLIGHT_TIMEOUT`] and returns a typed
//! [`ResumeOutcome`]; `resume_args` is pure and unit-tested.

use std::io::Read;
use std::process::{Command, Output, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use crate::features::terminal::state::TerminalCli;

/// The hard bound on the resume pre-flight: no resume path may block
/// indefinitely (NFR).
pub const RESUME_PREFLIGHT_TIMEOUT: Duration = Duration::from_secs(5);

/// The typed result of a resume attempt (kebab-case wire form).
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ResumeOutcome {
    /// A live session was started for the record (reusing its id).
    Resumed,
    /// The record does not exist, or the resume could not be attempted (no
    /// silent fresh session is substituted).
    Unresumable,
    /// The CLI binary could not be resolved.
    MissingBinary,
    /// The record's working directory no longer exists.
    InvalidCwd,
    /// The PTY / process launch failed.
    LaunchFailed,
}

/// The wire result of `resume_terminal_session`.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeResult {
    pub outcome: ResumeOutcome,
    /// The live session id on [`ResumeOutcome::Resumed`].
    pub session_id: Option<String>,
    /// A clear human message on every non-`Resumed` outcome.
    pub message: Option<String>,
}

impl ResumeResult {
    pub fn resumed(session_id: String) -> Self {
        Self {
            outcome: ResumeOutcome::Resumed,
            session_id: Some(session_id),
            message: None,
        }
    }

    pub fn failure(outcome: ResumeOutcome, message: impl Into<String>) -> Self {
        Self {
            outcome,
            session_id: None,
            message: Some(message.into()),
        }
    }
}

/// Build the exact argv appended to the CLI's launch command to resume a
/// session. Pure — the whole resume contract is here, so it is unit-testable
/// without a PTY.
///
/// `cli_session_id` is the record's captured CLI-native id. When it is present
/// the CLI's exact-id flag is used; otherwise the deterministic last-session
/// flag.
pub fn resume_args(cli: TerminalCli, cli_session_id: Option<&str>) -> Vec<String> {
    match cli {
        TerminalCli::OpenCode => match cli_session_id {
            Some(id) => vec!["--session".to_string(), id.to_string()],
            None => vec!["--continue".to_string()],
        },
        TerminalCli::Copilot => match cli_session_id {
            Some(id) => vec![format!("--resume={id}")],
            None => vec!["--continue".to_string()],
        },
    }
}

/// Run a prepared command with a hard timeout, returning its captured output.
/// stdin is null so a CLI cannot block on a prompt; the child is killed at the
/// deadline (bounded pre-flight).
pub fn run_bounded(mut command: Command, timeout: Duration) -> Result<Output, String> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;

    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();
    let (out_tx, out_rx) = mpsc::channel::<Vec<u8>>();
    let (err_tx, err_rx) = mpsc::channel::<Vec<u8>>();
    if let Some(mut pipe) = stdout_pipe.take() {
        thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = pipe.read_to_end(&mut buf);
            let _ = out_tx.send(buf);
        });
    }
    if let Some(mut pipe) = stderr_pipe.take() {
        thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = pipe.read_to_end(&mut buf);
            let _ = err_tx.send(buf);
        });
    }

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("command timed out after {timeout:?}"));
                }
                thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(e.to_string()),
        }
    };

    let stdout = out_rx
        .recv_timeout(Duration::from_secs(2))
        .map_err(|_| "stdout read timed out".to_string())?;
    let stderr = err_rx
        .recv_timeout(Duration::from_secs(2))
        .map_err(|_| "stderr read timed out".to_string())?;
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── resume_args: exact-id vs last-session fallback ──────────────────────

    #[test]
    fn opencode_resume_uses_the_exact_session_flag_when_an_id_is_known() {
        assert_eq!(
            resume_args(TerminalCli::OpenCode, Some("ses_abc")),
            vec!["--session".to_string(), "ses_abc".to_string()]
        );
    }

    #[test]
    fn opencode_resume_falls_back_to_continue_without_an_id() {
        assert_eq!(
            resume_args(TerminalCli::OpenCode, None),
            vec!["--continue".to_string()]
        );
    }

    #[test]
    fn copilot_resume_uses_the_exact_resume_equals_form_when_an_id_is_known() {
        assert_eq!(
            resume_args(TerminalCli::Copilot, Some("a1b2")),
            vec!["--resume=a1b2".to_string()]
        );
    }

    #[test]
    fn copilot_resume_falls_back_to_continue_without_an_id() {
        // ST-1 pinned `--continue` ("Resume the most recent session") as
        // Copilot's deterministic last-session flag; a bare `--resume` opens an
        // interactive picker.
        assert_eq!(
            resume_args(TerminalCli::Copilot, None),
            vec!["--continue".to_string()]
        );
    }

    #[test]
    fn resume_never_emits_a_flag_for_the_other_cli() {
        assert!(!resume_args(TerminalCli::OpenCode, Some("x")).iter().any(|a| a.starts_with("--resume")));
        assert!(!resume_args(TerminalCli::Copilot, Some("x")).iter().any(|a| a == "--session"));
    }

    // ── Wire contract ───────────────────────────────────────────────────────

    #[test]
    fn outcome_serializes_kebab_case() {
        assert_eq!(serde_json::to_value(ResumeOutcome::Resumed).unwrap(), serde_json::json!("resumed"));
        assert_eq!(
            serde_json::to_value(ResumeOutcome::Unresumable).unwrap(),
            serde_json::json!("unresumable")
        );
        assert_eq!(
            serde_json::to_value(ResumeOutcome::MissingBinary).unwrap(),
            serde_json::json!("missing-binary")
        );
        assert_eq!(
            serde_json::to_value(ResumeOutcome::InvalidCwd).unwrap(),
            serde_json::json!("invalid-cwd")
        );
        assert_eq!(
            serde_json::to_value(ResumeOutcome::LaunchFailed).unwrap(),
            serde_json::json!("launch-failed")
        );
    }

    #[test]
    fn resumed_result_carries_the_session_id_and_no_message() {
        let json = serde_json::to_value(ResumeResult::resumed("s1".into())).unwrap();
        assert_eq!(json["outcome"], serde_json::json!("resumed"));
        assert_eq!(json["sessionId"], serde_json::json!("s1"));
        assert!(json["message"].is_null());
    }

    #[test]
    fn failure_result_carries_the_message_and_no_session_id() {
        let json = serde_json::to_value(ResumeResult::failure(
            ResumeOutcome::MissingBinary,
            "`opencode` not found in PATH",
        ))
        .unwrap();
        assert_eq!(json["outcome"], serde_json::json!("missing-binary"));
        assert!(json["sessionId"].is_null());
        assert_eq!(json["message"], serde_json::json!("`opencode` not found in PATH"));
    }

    #[test]
    fn preflight_timeout_is_five_seconds() {
        assert_eq!(RESUME_PREFLIGHT_TIMEOUT, Duration::from_secs(5));
    }

    // ── Bounded runner ──────────────────────────────────────────────────────

    #[test]
    fn run_bounded_captures_output_of_a_short_command() {
        let cmd = if cfg!(target_os = "windows") {
            let mut c = Command::new("cmd.exe");
            c.args(["/C", "echo", "hello"]);
            c
        } else {
            let mut c = Command::new("sh");
            c.args(["-c", "echo hello"]);
            c
        };
        let output = run_bounded(cmd, Duration::from_secs(5)).unwrap();
        assert!(output.status.success());
        assert!(String::from_utf8_lossy(&output.stdout).contains("hello"));
    }

    #[test]
    fn run_bounded_times_out_rather_than_hanging() {
        let cmd = if cfg!(target_os = "windows") {
            let mut c = Command::new("cmd.exe");
            c.args(["/C", "ping", "-n", "30", "127.0.0.1"]);
            c
        } else {
            let mut c = Command::new("sh");
            c.args(["-c", "sleep 30"]);
            c
        };
        let err = run_bounded(cmd, Duration::from_millis(300)).unwrap_err();
        assert!(err.contains("timed out"), "unexpected error: {err}");
    }
}
