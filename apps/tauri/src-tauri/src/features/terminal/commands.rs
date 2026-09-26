use std::io::{Read, Write};
#[cfg(target_os = "windows")]
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, PtySize};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use uuid::Uuid;

use crate::features::terminal::persistence::{self, PersistedSession};
use crate::features::terminal::resume::{
    resume_args, run_bounded, ResumeOutcome, ResumeResult, RESUME_PREFLIGHT_TIMEOUT,
};
use crate::features::terminal::state::{
    append_capped, finalize_exited, finalize_resume_failed, mark_resumed, now_ms, SessionKind,
    TerminalErrorKind, TerminalPresentation, TerminalSession, TerminalSessionStatus, TerminalState,
    DEFAULT_PRESENTATION, OUTPUT_BUFFER_CAP, TERMINAL_PRESENTATION_KEY,
};
use crate::infrastructure::storage::feature_store::FeatureStore;
use crate::infrastructure::storage::AppStore;

/// The native terminal window label (window-targeted events + lifecycle).
pub const WINDOW_LABEL: &str = "terminal";

/// The main Fredo window label — the Terminal host when the persisted
/// presentation mode is `same-window` (Spec #2947 ST-2).
pub const MAIN_WINDOW_LABEL: &str = "main";

// ── Terminal host resolution (Spec #2947 ST-2) ────────────────────────────────

/// Map a resolved presentation mode onto the label every terminal event is
/// emitted to. Pure — the unit-tested half of [`terminal_host_label`].
fn host_label_for(presentation: TerminalPresentation) -> &'static str {
    match presentation {
        TerminalPresentation::SameWindow => MAIN_WINDOW_LABEL,
        TerminalPresentation::NewWindow => WINDOW_LABEL,
    }
}

/// Map a persisted raw value onto the host label, applying the
/// absent/unrecognized → [`DEFAULT_PRESENTATION`] fallback (R-4.1). Pure — the
/// exact parse+fallback chain [`terminal_host_label`] delegates to.
fn host_label_for_stored(raw: Option<&str>) -> &'static str {
    host_label_for(
        raw.and_then(TerminalPresentation::parse).unwrap_or(DEFAULT_PRESENTATION),
    )
}

/// The ONE label every terminal event is emitted to. Resolved from AppStore PER
/// EMIT (never cached at spawn), so a mode change reroutes live output on the
/// next chunk: `same-window` → [`MAIN_WINDOW_LABEL`], otherwise the native
/// [`WINDOW_LABEL`]. An absent/unrecognized stored value falls back to
/// [`DEFAULT_PRESENTATION`] (`new-window`).
pub fn terminal_host_label(app: &AppHandle) -> &'static str {
    let stored = app
        .try_state::<Arc<AppStore>>()
        .and_then(|store| store.get(TERMINAL_PRESENTATION_KEY).ok().flatten());
    host_label_for_stored(stored.as_deref())
}

/// Unrendered diagnostic override: a Copilot binary used BEFORE the PATH search.
const COPILOT_PATH_KEY: &str = "terminal_copilot_path";
/// Unrendered diagnostic override: the PowerShell executable for the prereq gate.
const PWSH_PATH_KEY: &str = "terminal_pwsh_path";

/// Copilot requires PowerShell 6+ (Windows PowerShell 5.1 is not acceptable).
const MIN_POWERSHELL_MAJOR: u32 = 6;

/// Best-effort Copilot auth-failure markers in the CLI's own output.
const AUTH_MARKERS: &[&str] = &[
    "not logged in",
    "please sign in",
    "not authenticated",
    "authentication failed",
    "unauthorized",
];

/// FX-3 (RC-1): bytes of reader output scanned for an auth marker, per session.
/// ConPTY reliably delivers the 16 B mode-escape prefix as the FIRST read and
/// the CLI's own text in a later one, so a first-chunk-only scan misses the
/// marker. The window is bounded (≤ 4 KiB/session) and stops growing once
/// exhausted — no unbounded state.
const AUTH_SCAN_WINDOW: usize = 4096;

/// FX-4 (RC-2): how often a session's child liveness is probed (ms).
const EXIT_POLL_MS: u64 = 250;

/// FX-4 (RC-2): settle window after a detected child exit, so trailing PTY bytes
/// land in the per-session buffer before `exited` is published (R-5.3).
const EXIT_DRAIN_MS: u64 = 250;

// ── Best-effort CLI-native session-id capture (Spec #2935 ST-2) ───────────────
//
// ST-1 pinned that OpenCode exposes a non-interactive listing surface
// (`opencode session list --format json`), so an OpenCode record can carry its
// CLI-native session id and resume with `--session <id>`. Copilot exposes none,
// so its records keep `cli_session_id = None` and fall back to `--continue`.

/// Delay after a spawn before the first listing attempt (the CLI's session is
/// usually created at TUI start).
const CAPTURE_DELAY_MS: u64 = 2_000;
/// Bounded number of listing attempts before giving up.
const CAPTURE_ATTEMPTS: u32 = 4;
/// Hard timeout for ONE listing invocation.
const CAPTURE_TIMEOUT_MS: u64 = 15_000;
/// Clock-skew slack when matching a listed session's `created` time to a spawn.
const CAPTURE_CLOCK_SLACK_MS: u64 = 5_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Run `where` (Windows) / `which` (Unix) and return the first matching path.
fn where_first(name: &str) -> Option<String> {
    #[cfg(target_os = "windows")]
    let finder = "where";
    #[cfg(not(target_os = "windows"))]
    let finder = "which";

    std::process::Command::new(finder)
        .arg(name)
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| s.lines().next().map(|l| l.trim().to_string()))
        .filter(|s| !s.is_empty())
}

/// Returns true if the file at `path` is a Unix shell script (starts with `#!`).
/// Used on Windows to detect binaries that cannot be executed by CreateProcessW.
#[cfg(target_os = "windows")]
fn is_unix_script(path: &str) -> bool {
    std::fs::read(path)
        .map(|bytes| bytes.starts_with(b"#!"))
        .unwrap_or(false)
}

/// Find a usable bash executable for running Unix shell scripts on Windows.
/// Prefers Git for Windows bash over WSL bash (WSL bash is interactive-only).
#[cfg(target_os = "windows")]
fn find_git_bash() -> Option<String> {
    let candidates = [
        r"C:\Program Files\Git\bin\bash.exe",
        r"C:\Program Files\Git\usr\bin\bash.exe",
        r"C:\Program Files (x86)\Git\bin\bash.exe",
    ];
    candidates.iter()
        .find(|p| std::path::Path::new(p).exists())
        .map(|s| s.to_string())
        .or_else(|| where_first("bash"))
}

/// Windows candidate order, mirroring the committed Copilot probe
/// (`.opencode/scripts/copilot-otel-probe.ts`: `resolveCopilotCandidates` +
/// `pickCopilot`): a native `.exe` first, then the `.cmd`/`.bat` shims, then a
/// `.ps1`, then the bare name. On non-Windows the extension probes are harmless
/// misses and the bare name resolves.
///
/// The plain-shell chain (Spec #2942 R-3.2) is platform-specific: Windows tries
/// the modern PowerShell (`pwsh.exe`) first, then Windows PowerShell
/// (`powershell.exe`), then always-present `cmd.exe` — so a host without `pwsh`
/// still has a shell. Non-Windows prefers `$SHELL`, then `sh`.
fn cli_candidates(cli: SessionKind) -> Vec<String> {
    match cli {
        SessionKind::OpenCode => vec![
            "opencode.exe".to_string(),
            "opencode.cmd".to_string(),
            "opencode.bat".to_string(),
            "opencode".to_string(),
        ],
        SessionKind::Copilot => vec![
            "copilot.exe".to_string(),
            "copilot.cmd".to_string(),
            "copilot.bat".to_string(),
            "copilot.ps1".to_string(),
            "copilot".to_string(),
        ],
        SessionKind::Shell => {
            #[cfg(target_os = "windows")]
            {
                vec![
                    "pwsh.exe".to_string(),
                    "powershell.exe".to_string(),
                    "cmd.exe".to_string(),
                ]
            }
            #[cfg(not(target_os = "windows"))]
            {
                let mut candidates = Vec::new();
                if let Ok(shell) = std::env::var("SHELL") {
                    let trimmed = shell.trim();
                    if !trimmed.is_empty() {
                        candidates.push(trimmed.to_string());
                    }
                }
                candidates.push("sh".to_string());
                candidates
            }
        }
    }
}

/// Message shown when a CLI cannot be resolved. Names the CLI so the in-window
/// error (and the AC4 receipt) can identify the cause without string parsing.
fn not_found_message(cli: SessionKind) -> String {
    match cli {
        SessionKind::OpenCode => "`opencode` not found in PATH. \
             Install OpenCode from https://opencode.ai or via your package manager."
            .to_string(),
        SessionKind::Copilot => "GitHub Copilot CLI (`copilot`) not found in PATH. \
             Install the GitHub Copilot CLI, then retry."
            .to_string(),
        SessionKind::Shell => "No system shell found in PATH. \
             On Windows `cmd.exe` should always be present; on Unix set `$SHELL` or install `sh`."
            .to_string(),
    }
}

/// Resolve the CLI binary. A non-empty override (diagnostic setting or the
/// TEST-ONLY seam) is used BEFORE the PATH search and must exist.
fn resolve_binary(cli: SessionKind, override_path: Option<&str>) -> Result<String, String> {
    if let Some(path) = override_path.map(str::trim).filter(|p| !p.is_empty()) {
        if std::path::Path::new(path).exists() {
            tracing::debug!(target: "fredo::terminal", path = ?path, "using override binary");
            return Ok(path.to_string());
        }
        return Err(not_found_message(cli));
    }

    for candidate in cli_candidates(cli) {
        if let Some(path) = where_first(&candidate) {
            tracing::debug!(target: "fredo::terminal", path = ?path, "found CLI binary");
            return Ok(path);
        }
    }
    Err(not_found_message(cli))
}

/// The concrete way a resolved binary must be launched. Pure data so the
/// resolution rules are unit-testable without spawning.
#[derive(Debug, PartialEq, Eq)]
enum LaunchForm {
    /// Run the binary directly (`.exe`, bare name, or non-Windows).
    Direct(String),
    /// `.cmd` / `.bat`: the command interpreter must run it.
    CmdShim { interpreter: String, target: String },
    /// `.ps1`: run through PowerShell.
    PowerShellScript { shell: String, target: String },
    /// A Unix shell script wrapped with Git bash (Windows only).
    UnixBash { bash: String, target: String },
}

/// Decide how to launch `bin` (mirrors the probe's `buildSpawnSpec`).
///
/// `CreateProcessW` (what the PTY spawns with) does not reliably execute a
/// `.cmd`/`.bat`; the probe encodes the `.cmd → command interpreter` requirement
/// and the product precedent for wrapping a non-directly-executable script is
/// the former `build_pty_command` (Git bash).
fn plan_launch(bin: &str, pwsh: &str) -> Result<LaunchForm, String> {
    let lower = bin.to_ascii_lowercase();

    #[cfg(target_os = "windows")]
    {
        if lower.ends_with(".ps1") {
            return Ok(LaunchForm::PowerShellScript {
                shell: pwsh.to_string(),
                target: bin.to_string(),
            });
        }
        if lower.ends_with(".cmd") || lower.ends_with(".bat") {
            return Ok(LaunchForm::CmdShim {
                interpreter: "cmd.exe".to_string(),
                target: bin.to_string(),
            });
        }
        if is_unix_script(bin) {
            let bash = find_git_bash().ok_or_else(|| {
                format!(
                    "`{bin}` is a Unix shell script and cannot run directly on Windows. \
                     Install Git for Windows (https://gitforwindows.org) to provide bash, \
                     or install the Windows-native version of this tool."
                )
            })?;
            return Ok(LaunchForm::UnixBash {
                bash,
                target: bin.to_string(),
            });
        }
    }

    let _ = (lower, pwsh);
    Ok(LaunchForm::Direct(bin.to_string()))
}

/// Turn a [`LaunchForm`] into the PTY command.
fn build_pty_command(form: LaunchForm) -> portable_pty::CommandBuilder {
    match form {
        LaunchForm::Direct(bin) => portable_pty::CommandBuilder::new(bin),
        LaunchForm::CmdShim { interpreter, target } => {
            let mut cmd = portable_pty::CommandBuilder::new(interpreter);
            cmd.arg("/C");
            cmd.arg(target);
            cmd
        }
        LaunchForm::PowerShellScript { shell, target } => {
            let mut cmd = portable_pty::CommandBuilder::new(shell);
            cmd.arg("-NoProfile");
            cmd.arg("-ExecutionPolicy");
            cmd.arg("Bypass");
            cmd.arg("-File");
            cmd.arg(target);
            cmd
        }
        LaunchForm::UnixBash { bash, target } => {
            let mut cmd = portable_pty::CommandBuilder::new(bash);
            cmd.arg(target);
            cmd
        }
    }
}

/// The PowerShell executable used by the prereq gate / `.ps1` launch: the
/// diagnostic override when set, else `pwsh`.
fn powershell_shell(override_path: Option<&str>) -> String {
    override_path
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .unwrap_or("pwsh")
        .to_string()
}

/// Parse the major version from `$PSVersionTable.PSVersion.Major` output.
#[cfg(target_os = "windows")]
fn parse_powershell_major(stdout: &str) -> Option<u32> {
    stdout.lines().map(str::trim).find(|l| !l.is_empty())?.parse().ok()
}

/// Whether the Copilot PowerShell prerequisite gate applies to a launch.
///
/// It applies only when the launch actually executes PowerShell — a `.ps1`
/// target, which [`plan_launch`] maps to [`LaunchForm::PowerShellScript`]. A
/// `.cmd`/`.bat` shim (launched via `cmd.exe /C`) or a `.exe`/bare binary
/// (launched directly) never invokes PowerShell, so it must not be rejected on
/// a host without pwsh 6+. The TEST-ONLY `override_major` seam (AC4 4c) still
/// forces the check so a below-six observation stays deterministic.
#[cfg(target_os = "windows")]
fn powershell_gate_applies(form: &LaunchForm, override_major: Option<u32>) -> bool {
    matches!(form, LaunchForm::PowerShellScript { .. }) || override_major.is_some()
}

/// Windows-only Copilot gate: PowerShell 6+ must be available BEFORE any PTY is
/// opened. `override_major` is the TEST-ONLY deterministic seam (AC4 4c).
#[cfg(target_os = "windows")]
fn check_powershell_prereq(shell: &str, override_major: Option<u32>) -> Result<(), String> {
    let major = match override_major {
        Some(major) => Some(major),
        None => std::process::Command::new(shell)
            .args(["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .and_then(|o| parse_powershell_major(&String::from_utf8_lossy(&o.stdout))),
    };
    match major {
        Some(major) if major >= MIN_POWERSHELL_MAJOR => Ok(()),
        _ => Err(
            "GitHub Copilot requires PowerShell 6 or newer (pwsh). \
             Install PowerShell 7+ and retry."
                .to_string(),
        ),
    }
}

/// Best-effort Copilot auth-failure detection over the CLI's own output.
fn detect_auth_marker(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    AUTH_MARKERS.iter().any(|marker| lower.contains(marker))
}

/// FX-3 pure decision: is the bounded auth scan finished?
///
/// It finishes as soon as a marker is present (nothing further to look for) or
/// once the whole [`AUTH_SCAN_WINDOW`] has been scanned (a later chunk can no
/// longer introduce a marker). Keeping this pure makes the ConPTY
/// chunk-splitting cases unit-testable without a PTY.
fn auth_marker_reached(accumulated: &str, scanned: usize) -> bool {
    detect_auth_marker(accumulated) || scanned >= AUTH_SCAN_WINDOW
}

/// FX-3: an `auth` marker may only be recorded when no other (stronger,
/// pre-spawn) kind is already set — `missing-binary` / `invalid-cwd` / `prereq`
/// / `launch` must never be overwritten.
fn auth_kind_may_be_recorded(current: Option<TerminalErrorKind>) -> bool {
    current.is_none()
}

/// FX-3 (RC-1): a bounded, order-independent auth-marker scan window.
///
/// ConPTY's first `read()` is reliably the mode-escape prefix, not the text, so
/// the detector must accumulate reader output rather than inspect chunk 1 only.
/// Every chunk is appended (capped at [`AUTH_SCAN_WINDOW`] bytes) and the
/// accumulated text is re-scanned after each chunk until it matches or the
/// window closes.
struct AuthScanWindow {
    bytes: Vec<u8>,
    done: bool,
}

impl AuthScanWindow {
    fn new() -> Self {
        Self { bytes: Vec::with_capacity(AUTH_SCAN_WINDOW), done: false }
    }

    /// Feed one reader chunk. Returns `true` exactly once — the first time a
    /// marker is present in the accumulated window. Afterwards it is inert.
    fn feed(&mut self, chunk: &[u8]) -> bool {
        if self.done {
            return false;
        }
        let remaining = AUTH_SCAN_WINDOW.saturating_sub(self.bytes.len());
        if remaining > 0 {
            let take = remaining.min(chunk.len());
            self.bytes.extend_from_slice(&chunk[..take]);
        }
        let text = String::from_utf8_lossy(&self.bytes);
        if !auth_marker_reached(&text, self.bytes.len()) {
            return false;
        }
        self.done = true;
        detect_auth_marker(&text)
    }
}

/// Validate that a resolved working directory exists and is a directory.
///
/// ConPTY does NOT validate `cwd` at spawn time on Windows, so a nonexistent
/// work dir must fail deterministically BEFORE the spawn (in-window error).
fn validate_cwd(cwd: &str) -> Result<(), String> {
    let path = std::path::Path::new(cwd);
    if path.is_dir() {
        Ok(())
    } else {
        Err(format!("Working directory not found: {cwd}"))
    }
}

/// Kill a session's whole process TREE (not just the direct child): the CLIs
/// launch through `.cmd`/bash shims whose descendants (`cmd.exe` → `node.exe`)
/// survive a direct-child kill (AC5). Mirrors the committed probe's `killTree`
/// and the `llm_server::process::kill_pid_tree` precedent.
fn kill_session_tree(pid: Option<u32>, child: Option<Box<dyn portable_pty::Child + Send>>) {
    #[cfg(target_os = "windows")]
    if let Some(pid) = pid {
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(target_os = "windows"))]
    let _ = pid;

    // Fallback / Unix path: kill the direct child.
    if let Some(mut child) = child {
        let _ = child.kill();
    }
}

// ── Event payloads ────────────────────────────────────────────────────────────

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutputPayload {
    session_id: String,
    data: Vec<u8>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExitedPayload {
    session_id: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionsChangedPayload {
    sessions: Vec<TerminalSessionInfo>,
}

/// ADDITIVE event payload for persisted-record changes (Spec #2935 ST-2). The
/// shipped `terminal-sessions-changed` / `terminal-output` / `terminal-exited`
/// payloads are unchanged.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedSessionsChangedPayload {
    sessions: Vec<PersistedSession>,
}

/// The window event carrying a `fredo open-terminal` launch intent (Spec #2935
/// ST-3), mirroring `APP_OPEN_REQUEST_EVENT`. The webview consumes it ONCE and
/// spawns the session — the backend NEVER spawns (single-spawner adjudication).
pub const TERMINAL_OPEN_REQUEST_EVENT: &str = "terminal-open-request";

/// A validated launch intent: the CLI + working directory a `fredo
/// open-terminal` invocation asked for.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOpenRequestPayload {
    pub cli: String,
    pub work_dir: String,
}

/// One-shot cold-launch handshake (Spec #2940 ST-8).
///
/// A freshly created `terminal` window ARMS the validated `fredo
/// open-terminal` intent here BEFORE `build()`; the window's own mount
/// handshake — its first `list_terminal_sessions` call, which runs only after
/// its `terminal-open-request` listener is registered — DRAINS it and emits
/// the event. The intent is therefore pulled, never pushed on a page-load
/// timer: Tauri delivers an event only to listeners already in its map, so a
/// `PageLoadEvent`-timed emit races (and loses to) the webview's async
/// listener registration. `take` is destructive, so a window reload or a
/// second list call cannot re-spawn (one-shot by construction).
///
/// Never armed while a window already exists — the warm path emits directly.
#[derive(Default)]
pub struct PendingTerminalOpen(pub Mutex<Option<TerminalOpenRequestPayload>>);

impl PendingTerminalOpen {
    /// Arm the one-shot intent (called before the window is built).
    pub fn arm(&self, payload: TerminalOpenRequestPayload) {
        *self.0.lock().unwrap() = Some(payload);
    }

    /// Destructively drain the intent; every later call yields `None`.
    pub fn take(&self) -> Option<TerminalOpenRequestPayload> {
        self.0.lock().unwrap().take()
    }

    /// Drop any armed intent (build failure / window `CloseRequested`).
    pub fn clear(&self) {
        *self.0.lock().unwrap() = None;
    }
}

/// Per-session wire record. `pid` + `startedAt` let the QA prove that switching
/// or replaying a session never re-spawns it; `errorKind` is typed so the UI
/// selects a distinct error state without parsing `error`.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionInfo {
    pub id: String,
    pub cli: SessionKind,
    pub status: TerminalSessionStatus,
    pub error: Option<String>,
    pub error_kind: Option<TerminalErrorKind>,
    pub work_dir: String,
    pub cols: u16,
    pub rows: u16,
    pub pid: Option<u32>,
    pub started_at: u64,
}

/// Project a session onto its wire record.
pub fn session_info(session: &TerminalSession) -> TerminalSessionInfo {
    TerminalSessionInfo {
        id: session.id.clone(),
        cli: session.cli,
        status: session.status,
        error: session.launch_error.clone(),
        // Safety net: an error present without a typed kind still reports one.
        error_kind: session
            .error_kind
            .or_else(|| session.launch_error.is_some().then_some(TerminalErrorKind::Generic)),
        work_dir: session.work_dir.clone(),
        cols: session.cols,
        rows: session.rows,
        pid: session.pid,
        started_at: session.started_at,
    }
}

fn snapshot(state: &TerminalState) -> Vec<TerminalSessionInfo> {
    state.sessions.iter().map(session_info).collect()
}

/// Broadcast the current session list to the terminal window.
fn emit_sessions_changed(app: &AppHandle, sessions: Vec<TerminalSessionInfo>) {
    if let Err(e) = app.emit_to(
        terminal_host_label(app),
        "terminal-sessions-changed",
        SessionsChangedPayload { sessions },
    ) {
        tracing::error!(target: "fredo::terminal", error = %e, "emit terminal-sessions-changed failed");
    }
}

/// FX-4: publish a session's ONE-SHOT exit notification.
///
/// Called only by the caller that won the [`finalize_exited`] transition, so
/// exactly one `terminal-exited` (and one session-list refresh) is emitted per
/// session (AC2/R-5.3).
fn emit_session_exited(app: &AppHandle, id: &str) {
    if let Err(e) = app.emit_to(
        terminal_host_label(app),
        "terminal-exited",
        TerminalExitedPayload { session_id: id.to_string() },
    ) {
        tracing::error!(target: "fredo::terminal", error = %e, "emit terminal-exited failed");
    }
    let sessions = {
        let s = app.state::<Mutex<TerminalState>>();
        let guard = s.lock().unwrap();
        snapshot(&guard)
    };
    emit_sessions_changed(app, sessions);

    // Self-exit does not remove the record: stamp its last-active time and keep
    // it resumable (R-1.4/R-2.2).
    if let Some(feature_store) = app.try_state::<Arc<FeatureStore>>() {
        if let Err(e) = persistence::touch(feature_store.inner(), id, now_ms()) {
            tracing::error!(target: "fredo::terminal", error = %e, "touch record on exit failed");
        }
        emit_persisted_sessions_changed(
            app,
            persistence::list(feature_store.inner()).unwrap_or_default(),
        );
    }
}

/// Mark a session failed (before any process exists) and broadcast the list.
fn fail_session(
    app: &AppHandle,
    state: &Mutex<TerminalState>,
    id: &str,
    kind: TerminalErrorKind,
    message: String,
) {
    let sessions = {
        let mut guard = state.lock().unwrap();
        if let Some(session) = guard.get_mut(id) {
            session.fail(kind, message);
        }
        snapshot(&guard)
    };
    emit_sessions_changed(app, sessions);
}

/// Broadcast the persisted-record list to the terminal window (additive).
fn emit_persisted_sessions_changed(app: &AppHandle, sessions: Vec<PersistedSession>) {
    if let Err(e) = app.emit_to(
        terminal_host_label(app),
        "terminal-persisted-sessions-changed",
        PersistedSessionsChangedPayload { sessions },
    ) {
        tracing::error!(target: "fredo::terminal", error = %e, "emit terminal-persisted-sessions-changed failed");
    }
}

/// Window-targeted delivery of a `fredo open-terminal` launch intent.
fn emit_terminal_open_request(app: &AppHandle, payload: TerminalOpenRequestPayload) {
    if let Err(e) = app.emit_to(terminal_host_label(app), TERMINAL_OPEN_REQUEST_EVENT, payload) {
        tracing::error!(target: "fredo::terminal", error = %e, "emit terminal-open-request failed");
    }
}

/// Persist a record for a session that SUCCEEDED in spawning.
///
/// Deliberately after the process exists: a failed launch must never leave a
/// bogus resumable record (a fresh spawn failure keeps only a live error row,
/// never a persisted record). The title is minted once from the existing
/// records and persisted, so ordinals never renumber on restart.
fn persist_new_record(
    feature_store: &FeatureStore,
    app: &AppHandle,
    id: &str,
    cli: SessionKind,
    work_dir: &str,
    created_at: u64,
) {
    if let Err(e) = persistence::ensure_table(feature_store) {
        tracing::error!(target: "fredo::terminal", error = %e, "ensure record table failed");
        return;
    }
    let existing = persistence::list(feature_store).unwrap_or_default();
    let record = PersistedSession {
        id: id.to_string(),
        cli,
        work_dir: work_dir.to_string(),
        title: persistence::mint_title(cli, &existing),
        created_at,
        last_active_at: created_at,
        cli_session_id: None,
    };
    if let Err(e) = persistence::insert(feature_store, &record) {
        tracing::error!(target: "fredo::terminal", error = %e, "persist session record failed");
        return;
    }
    emit_persisted_sessions_changed(app, persistence::list(feature_store).unwrap_or_default());
}

/// Remove a live session and tree-kill its process (used when a resume must not
/// leave a partial session behind, and when a record with a live process is
/// deleted).
fn remove_live_session(app: &AppHandle, state: &Mutex<TerminalState>, id: &str) {
    let removed = {
        let mut guard = state.lock().unwrap();
        guard.remove(id)
    };
    if let Some(session) = removed {
        kill_session_tree(session.pid, session.killer);
    }
    let sessions = {
        let guard = state.lock().unwrap();
        snapshot(&guard)
    };
    emit_sessions_changed(app, sessions);
}

/// Map a launch-preparation failure kind onto the typed resume outcome. Only the
/// pre-flight kinds reach here; anything else is a launch failure.
fn resume_outcome_for(kind: TerminalErrorKind) -> ResumeOutcome {
    match kind {
        TerminalErrorKind::MissingBinary => ResumeOutcome::MissingBinary,
        TerminalErrorKind::InvalidCwd => ResumeOutcome::InvalidCwd,
        _ => ResumeOutcome::LaunchFailed,
    }
}

/// A `std::process::Command` for a resolved CLI, mirroring [`plan_launch`]'s
/// wrapping (`.cmd`/`.bat` → `cmd.exe /C`, `.ps1` → `pwsh -File`).
fn list_command(bin: &str) -> std::process::Command {
    let lower = bin.to_ascii_lowercase();
    #[cfg(target_os = "windows")]
    {
        if lower.ends_with(".ps1") {
            let mut cmd = std::process::Command::new("pwsh");
            cmd.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", bin]);
            return cmd;
        }
        if lower.ends_with(".cmd") || lower.ends_with(".bat") {
            let mut cmd = std::process::Command::new("cmd.exe");
            cmd.arg("/C");
            cmd.arg(bin);
            return cmd;
        }
    }
    let _ = lower;
    std::process::Command::new(bin)
}

/// Best-effort, bounded: list OpenCode's sessions (ST-1 pinned
/// `opencode session list --format json`) and return stdout.
fn list_opencode_sessions() -> Option<String> {
    let bin = resolve_binary(SessionKind::OpenCode, None).ok()?;
    let mut command = list_command(&bin);
    command.args(["session", "list", "--format", "json"]);
    match run_bounded(command, Duration::from_millis(CAPTURE_TIMEOUT_MS)) {
        Ok(output) if output.status.success() => {
            Some(String::from_utf8_lossy(&output.stdout).to_string())
        }
        Ok(output) => {
            tracing::debug!(target: "fredo::terminal", status = ?output.status, "session list exited non-zero");
            None
        }
        Err(e) => {
            tracing::debug!(target: "fredo::terminal", error = %e, "session list probe failed");
            None
        }
    }
}

/// Best-effort capture of an OpenCode session's CLI-native id, persisted onto the
/// record so a later resume uses `--session <id>` instead of the last-session
/// fallback. A no-op for Copilot (ST-1: no listing surface) and for a plain
/// Shell (Spec #2942: no CLI-native session exists, so `cli_session_id` stays
/// NULL and the shell reopen appends no args). Never spawns a session and never
/// blocks a command — it runs on the async runtime, bounded.
fn capture_cli_session_id(
    app: AppHandle,
    cli: SessionKind,
    work_dir: String,
    session_id: String,
    spawned_at: u64,
) {
    if cli != SessionKind::OpenCode {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let since = spawned_at.saturating_sub(CAPTURE_CLOCK_SLACK_MS);
        for _ in 0..CAPTURE_ATTEMPTS {
            tokio::time::sleep(Duration::from_millis(CAPTURE_DELAY_MS)).await;
            let Some(json) = list_opencode_sessions() else {
                continue;
            };
            let Some(native_id) =
                persistence::newest_session_id_for_dir(&json, &work_dir, since)
            else {
                continue;
            };
            let Some(feature_store) = app.try_state::<Arc<FeatureStore>>() else {
                return;
            };
            match persistence::set_cli_session_id(feature_store.inner(), &session_id, &native_id) {
                Ok(()) => {
                    tracing::debug!(target: "fredo::terminal", id = %native_id, "captured CLI session id");
                    emit_persisted_sessions_changed(
                        &app,
                        persistence::list(feature_store.inner()).unwrap_or_default(),
                    );
                    return;
                }
                Err(e) => tracing::error!(
                    target: "fredo::terminal",
                    error = %e,
                    "persist CLI session id failed"
                ),
            }
        }
    });
}

/// The steps that must succeed BEFORE any PTY is opened: resolve the binary,
/// validate the working directory, plan the launch form, and apply the
/// Copilot-only PowerShell prerequisite gate. A failure is typed so the caller
/// can choose an in-window error row (fresh spawn) or a typed `ResumeOutcome`
/// (resume).
fn prepare_session(
    cli: SessionKind,
    cwd: &str,
    binary_override: Option<String>,
    pwsh: &str,
    test_override: Option<&SpawnTestOverride>,
) -> Result<LaunchForm, (TerminalErrorKind, String)> {
    let bin = resolve_binary(cli, binary_override.as_deref())
        .map_err(|msg| (TerminalErrorKind::MissingBinary, msg))?;
    tracing::debug!(target: "fredo::terminal", bin = ?bin, "resolved binary");

    validate_cwd(cwd).map_err(|msg| (TerminalErrorKind::InvalidCwd, msg))?;

    let form = plan_launch(&bin, pwsh).map_err(|msg| (TerminalErrorKind::Launch, msg))?;

    // The PowerShell-6+ prerequisite gate is Copilot-ONLY (Spec #2942 R-3.2): a
    // plain Shell must NOT be gated on pwsh — its candidate chain falls back to
    // `powershell.exe`/`cmd.exe`, which are not PowerShell-6+ shells.
    #[cfg(target_os = "windows")]
    if cli == SessionKind::Copilot {
        let override_major = test_override.and_then(|o| o.pwsh_major);
        if powershell_gate_applies(&form, override_major) {
            check_powershell_prereq(pwsh, override_major)
                .map_err(|msg| (TerminalErrorKind::Prereq, msg))?;
        }
    }
    let _ = test_override;

    Ok(form)
}

/// The historical PTY default, used when a caller omits the grid (Spec #2942
/// ST-5 keeps every pre-existing caller and QA IPC recipe valid).
const DEFAULT_PTY_COLS: u16 = 80;
const DEFAULT_PTY_ROWS: u16 = 24;
/// Upper bound on a UI-supplied grid: a bogus value can never ask ConPTY for an
/// absurd scrollback-sized buffer (the UI always derives a real pane grid).
const MAX_PTY_COLS: u16 = 1000;
const MAX_PTY_ROWS: u16 = 1000;

/// Resolve the requested `cols`/`rows` for a PTY spawn/resume.
///
/// Spec #2942 ST-5 (the "OpenCode TUI doesn't fill the pane" root cause): the
/// PTY used to be born at a hardcoded 80×24 and only corrected by a later
/// `resize_pty` — which fires solely on a CHANGED grid, so a cold mount whose
/// fit latched the pane size could leave the CLI rendering for 80×24 until an
/// unrelated resize event. The webview now passes the grid it last applied, so
/// the PTY is born at pane size. `None`/`0` keeps the 80×24 default, so a
/// caller that omits the args is byte-identical to before.
fn resolve_grid(cols: Option<u16>, rows: Option<u16>) -> (u16, u16) {
    (
        cols.filter(|c| *c > 0).unwrap_or(DEFAULT_PTY_COLS).min(MAX_PTY_COLS),
        rows.filter(|r| *r > 0).unwrap_or(DEFAULT_PTY_ROWS).min(MAX_PTY_ROWS),
    )
}

/// Open the PTY, spawn the process (with any resume args appended), store the
/// handles, and start the reader + exit-watcher tasks.
///
/// Returns `Ok(true)` when the session is live, `Ok(false)` when it vanished
/// mid-spawn (closed by the user), and a typed `Err` on a launch failure. The
/// session row is expected to exist in `state`; the caller owns that row's fate.
///
/// `size` is the caller's resolved grid (Spec #2942 ST-5): the PTY is born at
/// pane size and the session's recorded dims match, so the UI's first fit
/// receipt already agrees with the PTY.
fn spawn_and_wire(
    app: &AppHandle,
    state: &Mutex<TerminalState>,
    session_id: &str,
    form: LaunchForm,
    cwd: &str,
    extra_args: &[String],
    size: PtySize,
) -> Result<bool, (TerminalErrorKind, String)> {
    // ── Open the PTY and spawn ─────────────────────────────────────────────
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(size)
        .map_err(|e| {
            tracing::error!(target: "fredo::terminal", error = %e, "openpty failed");
            (TerminalErrorKind::Launch, format!("Failed to open PTY: {e}"))
        })?;

    let mut cmd = build_pty_command(form);
    for arg in extra_args {
        cmd.arg(arg);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "fredo");
    cmd.cwd(cwd);

    tracing::debug!(target: "fredo::terminal", cwd = ?cwd, "spawning child");
    let child = pair.slave.spawn_command(cmd).map_err(|e| {
        tracing::error!(target: "fredo::terminal", error = %e, "spawn failed");
        (TerminalErrorKind::Launch, format!("Could not start session: {e}"))
    })?;
    let pid = child.process_id();
    tracing::debug!(target: "fredo::terminal", pid = ?pid, "child spawned OK");

    // Clone reader BEFORE taking writer (Windows ConPTY ordering requirement)
    let mut reader = match pair.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(e) => {
            let msg = format!("Failed to get PTY reader: {e}");
            tracing::error!(target: "fredo::terminal", error = %e, "reader clone failed");
            kill_session_tree(pid, Some(child));
            return Err((TerminalErrorKind::Launch, msg));
        }
    };
    let writer = match pair.master.take_writer() {
        Ok(writer) => writer,
        Err(e) => {
            let msg = format!("Failed to get PTY writer: {e}");
            tracing::error!(target: "fredo::terminal", error = %e, "writer take failed");
            kill_session_tree(pid, Some(child));
            return Err((TerminalErrorKind::Launch, msg));
        }
    };

    // ── Store handles + make the session live ──────────────────────────────
    let output_buffer = {
        let mut guard = state.lock().unwrap();
        match guard.get_mut(session_id) {
            Some(session) => {
                session.pid = pid;
                session.writer = Some(writer);
                session.killer = Some(child);
                session.master = Some(pair.master);
                session.status = TerminalSessionStatus::Running;
                session.cols = size.cols;
                session.rows = size.rows;
                Arc::clone(&session.output_buffer)
            }
            None => {
                // The session was closed mid-spawn: kill the fresh child and stop.
                tracing::warn!(target: "fredo::terminal", "session vanished before spawn completed");
                kill_session_tree(pid, Some(child));
                return Ok(false);
            }
        }
    };
    let sessions = {
        let guard = state.lock().unwrap();
        snapshot(&guard)
    };
    emit_sessions_changed(app, sessions);

    // ── Reader task (never holds the state lock across a read) ─────────────
    let app_task = app.clone();
    let task_id = session_id.to_string();
    tauri::async_runtime::spawn(async move {
        let mut buf = [0u8; 4096];
        let mut line_buf = String::new();
        let mut auth_scan = AuthScanWindow::new();

        loop {
            let n = match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            let chunk = &buf[..n];

            append_capped(&output_buffer, chunk, OUTPUT_BUFFER_CAP);

            // FX-3: scan the BOUNDED ACCUMULATED window, not just the first
            // chunk (RC-1 — ConPTY puts the mode-escape prefix in chunk 1 and
            // the CLI's text in a later one). Never overwrites a stronger kind
            // and never sets `status` (the CLI's own sign-in prompt must stay
            // visible).
            if auth_scan.feed(chunk) {
                let s = app_task.state::<Mutex<TerminalState>>();
                let mut guard = s.lock().unwrap();
                if let Some(session) = guard.get_mut(&task_id) {
                    if auth_kind_may_be_recorded(session.error_kind) {
                        session.error_kind = Some(TerminalErrorKind::Auth);
                    }
                }
            }

            if let Err(e) = app_task.emit_to(
                terminal_host_label(&app_task),
                "terminal-output",
                TerminalOutputPayload { session_id: task_id.clone(), data: chunk.to_vec() },
            ) {
                tracing::error!(target: "fredo::terminal", error = %e, "emit terminal-output failed");
            }

            line_buf.push_str(&String::from_utf8_lossy(chunk));
            while let Some(pos) = line_buf.find('\n') {
                let line = line_buf[..pos].trim_end_matches('\r').to_string();
                line_buf = line_buf[pos + 1..].to_string();
                if !line.is_empty() {
                    tracing::debug!(target: "fredo::terminal", line = %line, "pty line");
                }
            }
        }

        // Mark ONLY this session exited; retain its row + buffer. The window
        // stays open (R-5.3). A RESUMED session defers its transition to the
        // exit watcher, which can distinguish a clean exit from a failed
        // reconnect (`resume-failed`, R-4.3).
        let s = app_task.state::<Mutex<TerminalState>>();
        let resumed = {
            let guard = s.lock().unwrap();
            guard.get(&task_id).map(|session| session.resumed).unwrap_or(false)
        };
        if !resumed && finalize_exited(&s, &task_id) {
            emit_session_exited(&app_task, &task_id);
        }
    });

    // ── Per-session exit watcher (FX-4 / RC-2) ─────────────────────────────
    let watcher_app = app.clone();
    let watcher_id = session_id.to_string();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(EXIT_POLL_MS)).await;

            let (exit_status, resumed) = {
                let s = watcher_app.state::<Mutex<TerminalState>>();
                let mut guard = s.lock().unwrap();
                match guard.get_mut(&watcher_id) {
                    None => return,
                    Some(session) if session.status == TerminalSessionStatus::Exited => return,
                    Some(session) if session.status == TerminalSessionStatus::Error => return,
                    Some(session) => {
                        let resumed = session.resumed;
                        match session.killer.as_mut() {
                            None => return,
                            Some(child) => match child.try_wait() {
                                Ok(None) => continue,
                                Ok(Some(status)) => (status, resumed),
                                Err(e) => {
                                    tracing::error!(
                                        target: "fredo::terminal",
                                        error = %e,
                                        "child liveness probe failed"
                                    );
                                    return;
                                }
                            },
                        }
                    }
                }
            };

            tracing::debug!(target: "fredo::terminal", exit = ?exit_status, "child exited");

            tokio::time::sleep(std::time::Duration::from_millis(EXIT_DRAIN_MS)).await;

            // A resumed session whose CLI exited NON-ZERO could not reconnect:
            // classify a typed `resume-failed` rather than a clean exit (R-4.3).
            let failed = resumed && exit_status.exit_code() != 0;
            let s = watcher_app.state::<Mutex<TerminalState>>();
            let transitioned = if failed {
                finalize_resume_failed(&s, &watcher_id)
            } else {
                finalize_exited(&s, &watcher_id)
            };
            if transitioned {
                emit_session_exited(&watcher_app, &watcher_id);
            }
            return;
        }
    });

    Ok(true)
}

/// Handler wired to the `terminal` window: closing the window for ANY reason
/// (OS X button, Alt+F4, `close_terminal_window`) tree-kills EVERY session so no
/// process orphans (AC5), and stamps every live record's `last_active_at` while
/// KEEPING every record (R-1.4/R-2.2).
fn window_close_handler(
    app: AppHandle,
) -> impl Fn(&tauri::WindowEvent) + Send + Sync + 'static {
    move |event| {
        if let tauri::WindowEvent::CloseRequested { .. } = event {
            tracing::debug!(target: "fredo::terminal", "CloseRequested: tree-killing every session");
            // Bound the pending intent's lifetime to the window instance: a
            // window that never mounted must not leak a stale launch into a
            // later window (Spec #2940 ST-8).
            app.state::<PendingTerminalOpen>().clear();
            let drained = {
                let s = app.state::<Mutex<TerminalState>>();
                let mut guard = s.lock().unwrap();
                guard.drain_sessions()
            };
            let feature_store = app.try_state::<Arc<FeatureStore>>();
            let closed_at = now_ms();
            for session in drained {
                if let Some(store) = feature_store.as_ref() {
                    if let Err(e) = persistence::touch(store.inner(), &session.id, closed_at) {
                        tracing::error!(target: "fredo::terminal", error = %e, "touch record on window close failed");
                    }
                }
                kill_session_tree(session.pid, session.killer);
            }
        }
    }
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Create or focus the ONE `terminal` window, optionally delivering a `fredo
/// open-terminal` launch intent (Spec #2935 ST-3).
///
/// The backend NEVER spawns here (single-spawner adjudication): the intent
/// carries the VALIDATED `{ cli, workDir }` and the webview consumes it to spawn
/// the session. Delivery mirrors `APP_OPEN_REQUEST_EVENT`:
/// - the window already exists → its listener is mounted, so emit immediately;
/// - the window is freshly created → ARM the intent in [`PendingTerminalOpen`]
///   before `build()`; the window's mount handshake drains + emits it once its
///   listener is registered (Spec #2940 ST-8 — a page-load-timed emit is a race
///   the webview loses). `take` is destructive, so a dev reload cannot re-spawn.
pub async fn open_terminal_window_with_intent(
    app: &AppHandle,
    intent: Option<TerminalOpenRequestPayload>,
) -> Result<(), String> {
    tracing::debug!(target: "fredo::terminal", "open_terminal_window_with_intent called");

    match app.get_webview_window(WINDOW_LABEL) {
        Some(win) => {
            tracing::debug!(target: "fredo::terminal", "reusing existing terminal window");
            win.set_focus().ok();
            if let Some(payload) = intent {
                emit_terminal_open_request(app, payload);
            }
        }
        None => {
            tracing::debug!(target: "fredo::terminal", "building WebviewWindow");
            let builder = WebviewWindowBuilder::new(
                app,
                WINDOW_LABEL,
                WebviewUrl::App("index.html?view=terminal".into()),
            )
            .title("Terminal")
            .inner_size(900.0, 600.0)
            .min_inner_size(560.0, 360.0)
            .resizable(true);

            // Spec #2940 ST-8: hold the validated intent in managed state —
            // NEVER a page-load-timed emit — until the freshly built window's
            // mount handshake drains it (its first `list_terminal_sessions`,
            // after its `terminal-open-request` listener is registered).
            if let Some(payload) = intent {
                app.state::<PendingTerminalOpen>().arm(payload);
            }

            let window = match builder.build() {
                Ok(window) => window,
                Err(e) => {
                    // A failed window must never leave a stale intent behind.
                    app.state::<PendingTerminalOpen>().clear();
                    tracing::error!(target: "fredo::terminal", error = %e, "WebviewWindow creation failed");
                    return Err(format!("Failed to open terminal window: {e}"));
                }
            };
            // Wire CloseRequested → tree-kill every session (no orphans).
            window.on_window_event(window_close_handler(app.clone()));
        }
    }

    Ok(())
}

/// Create or focus the ONE `terminal` window. NO session is spawned here — the
/// first session is created by the in-window add-session flow
/// (`spawn_terminal_session`).
#[tauri::command]
pub async fn open_terminal_window(app: AppHandle) -> Result<(), String> {
    open_terminal_window_with_intent(&app, None).await
}

/// TEST-ONLY override seam for the AC4 negative rows. Never set by the
/// production UI: it deterministically forces a missing binary or an unmet
/// PowerShell prerequisite without touching the host PATH.
#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnTestOverride {
    pub binary: Option<String>,
    pub pwsh_major: Option<u32>,
}

/// Spawn a new CLI session in its own PTY and start streaming its output.
///
/// Deterministic order: allocate id → insert `starting` → pre-flight (resolve
/// binary, validate cwd, Copilot-only PowerShell-6+ gate) → openpty/spawn →
/// store handles + pid → spawn the reader task → persist the record. ANY
/// failure before `spawn_command` sets `status=error`, a typed `error_kind`,
/// and `launch_error`, and still returns `Ok(sessionId)` so the sidebar row is
/// the in-window error surface. Nothing is spawned on a failure path, so no
/// orphan can exist; and no record is persisted for a failed launch (a bogus
/// resumable record would violate AC4's "never a wrong session").
///
/// `cols`/`rows` (Spec #2942 ST-5): the pane grid the webview last applied, so
/// the PTY is born at pane size instead of a hardcoded 80×24. Omitting them
/// keeps the historical 80×24 default.
#[tauri::command]
pub async fn spawn_terminal_session(
    cli: String,
    work_dir: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    test_override: Option<SpawnTestOverride>,
    app: AppHandle,
    state: tauri::State<'_, Mutex<TerminalState>>,
) -> Result<String, String> {
    // AppStore / FeatureStore are injected state, NOT wire arguments — reading
    // them off the handle keeps the command's wire shape unchanged and its
    // argument count under clippy's limit.
    let store = app.state::<Arc<AppStore>>();
    let feature_store = app.state::<Arc<FeatureStore>>();

    let cwd = work_dir
        .filter(|s| !s.trim().is_empty())
        .or_else(|| std::env::var("USERPROFILE").ok())
        .or_else(|| std::env::var("HOME").ok())
        .unwrap_or_else(|| ".".to_string());

    let (grid_cols, grid_rows) = resolve_grid(cols, rows);
    let size = PtySize { rows: grid_rows, cols: grid_cols, pixel_width: 0, pixel_height: 0 };

    let session_id = Uuid::new_v4().to_string();

    // An unknown CLI is refused BEFORE any process exists: the row carries the
    // typed `invalid-cli` kind so the UI renders the "Unknown CLI" state (R-4.1)
    // and no PTY is opened. No record is persisted for a failed launch.
    let Some(cli) = SessionKind::parse(&cli) else {
        {
            let mut guard = state.lock().unwrap();
            guard.insert_starting(
                session_id.clone(),
                SessionKind::OpenCode,
                cwd,
                grid_cols,
                grid_rows,
            );
        }
        fail_session(
            &app,
            &state,
            &session_id,
            TerminalErrorKind::InvalidCli,
            format!("Unknown CLI: {cli}"),
        );
        return Ok(session_id);
    };

    {
        let mut guard = state.lock().unwrap();
        guard.insert_starting(session_id.clone(), cli, cwd.clone(), grid_cols, grid_rows);
    }
    let sessions = {
        let guard = state.lock().unwrap();
        snapshot(&guard)
    };
    emit_sessions_changed(&app, sessions);

    // Diagnostic override settings (unrendered). The TEST-ONLY seam wins over
    // the stored Copilot path (which only applies to a Copilot session).
    let binary_override = test_override.as_ref().and_then(|o| o.binary.clone()).or_else(|| {
        if cli == SessionKind::Copilot {
            store.get(COPILOT_PATH_KEY).ok().flatten()
        } else {
            None
        }
    });
    let pwsh = powershell_shell(store.get(PWSH_PATH_KEY).ok().flatten().as_deref());

    let created_at = now_ms();

    // ── Pre-flight: resolve / validate / plan / Copilot prereq gate ────────
    let form = match prepare_session(cli, &cwd, binary_override, &pwsh, test_override.as_ref()) {
        Ok(form) => form,
        Err((kind, msg)) => {
            tracing::error!(target: "fredo::terminal", error = %msg, "launch preparation failed");
            fail_session(&app, &state, &session_id, kind, msg);
            return Ok(session_id);
        }
    };

    // ── Open the PTY, spawn, and wire the reader/watcher ───────────────────
    match spawn_and_wire(&app, &state, &session_id, form, &cwd, &[], size) {
        Ok(true) => {
            // A record is persisted ONLY for a session that actually spawned: a
            // failed launch must never leave a bogus resumable record.
            persist_new_record(&feature_store, &app, &session_id, cli, &cwd, created_at);
            capture_cli_session_id(app.clone(), cli, cwd, session_id.clone(), created_at);
        }
        Ok(false) => {}
        Err((kind, msg)) => {
            tracing::error!(target: "fredo::terminal", error = %msg, "spawn failed");
            fail_session(&app, &state, &session_id, kind, msg);
        }
    }

    Ok(session_id)
}

/// Session list — the mount-time source of truth for the window (and the QA's
/// per-session read of status / errorKind / pid / startedAt).
///
/// Also the cold-launch MOUNT HANDSHAKE (Spec #2940 ST-8): a freshly created
/// window's first list call drains the armed `fredo open-terminal` intent and
/// emits it over the now-registered listener. One-shot by construction, so a
/// reload or a later list call cannot re-spawn. The return value is unchanged,
/// so the frontend invoke contract does not change.
#[tauri::command]
pub fn list_terminal_sessions(
    app: AppHandle,
    state: tauri::State<'_, Mutex<TerminalState>>,
    pending: tauri::State<'_, PendingTerminalOpen>,
) -> Vec<TerminalSessionInfo> {
    if let Some(payload) = pending.take() {
        tracing::debug!(
            target: "fredo::terminal",
            cli = %payload.cli,
            work_dir = %payload.work_dir,
            "mount handshake: drained pending terminal-open intent"
        );
        emit_terminal_open_request(&app, payload);
    }
    let guard = state.lock().unwrap();
    snapshot(&guard)
}

/// Return one session's buffered PTY output so its terminal can replay missed
/// bytes on mount / switch.
#[tauri::command]
pub fn get_pty_buffer(
    session_id: String,
    state: tauri::State<'_, Mutex<TerminalState>>,
) -> Result<Vec<u8>, String> {
    let guard = state.lock().unwrap();
    match guard.get(&session_id) {
        Some(session) => Ok(session.output_buffer.lock().unwrap().clone()),
        None => Err(format!("Unknown session: {session_id}")),
    }
}

/// Write raw input bytes to a session's PTY (keyboard input from the window).
#[tauri::command]
pub fn write_pty_input(
    session_id: String,
    data: String,
    state: tauri::State<'_, Mutex<TerminalState>>,
) -> Result<(), String> {
    let mut guard = state.lock().unwrap();
    match guard.get_mut(&session_id) {
        Some(session) => match session.writer.as_mut() {
            Some(writer) => writer.write_all(data.as_bytes()).map_err(|e| e.to_string()),
            None => Err(format!("No active PTY for session {session_id}")),
        },
        None => Err(format!("Unknown session: {session_id}")),
    }
}

/// Resize one session's PTY (called when the terminal surface is resized).
#[tauri::command]
pub fn resize_pty(
    session_id: String,
    rows: u16,
    cols: u16,
    state: tauri::State<'_, Mutex<TerminalState>>,
) -> Result<(), String> {
    let mut guard = state.lock().unwrap();
    match guard.get_mut(&session_id) {
        Some(session) => {
            if let Some(master) = session.master.as_ref() {
                master
                    .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
                    .map_err(|e| e.to_string())?;
            }
            session.cols = cols;
            session.rows = rows;
            Ok(())
        }
        None => Err(format!("Unknown session: {session_id}")),
    }
}

/// Close ONE session: remove its row and tree-kill its process. Other sessions
/// and the window are untouched. The session's RECORD is kept (only its process
/// ended), stamped with a fresh `last_active_at` (R-1.4/R-2.2).
#[tauri::command]
pub async fn close_terminal_session(
    session_id: String,
    app: AppHandle,
    state: tauri::State<'_, Mutex<TerminalState>>,
    feature_store: tauri::State<'_, Arc<FeatureStore>>,
) -> Result<(), String> {
    let removed = {
        let mut guard = state.lock().unwrap();
        guard.remove(&session_id)
    };
    if let Some(session) = removed {
        kill_session_tree(session.pid, session.killer);
    }
    if let Err(e) = persistence::touch(&feature_store, &session_id, now_ms()) {
        tracing::error!(target: "fredo::terminal", error = %e, "touch record on session close failed");
    }
    let sessions = {
        let guard = state.lock().unwrap();
        snapshot(&guard)
    };
    emit_sessions_changed(&app, sessions);
    emit_persisted_sessions_changed(&app, persistence::list(&feature_store).unwrap_or_default());
    Ok(())
}

/// Close the terminal window: tree-kill EVERY session, keep every record, then
/// close. Also reached via the window's `CloseRequested` handler.
#[tauri::command]
pub async fn close_terminal_window(
    app: AppHandle,
    state: tauri::State<'_, Mutex<TerminalState>>,
    feature_store: tauri::State<'_, Arc<FeatureStore>>,
) -> Result<(), String> {
    let drained = {
        let mut guard = state.lock().unwrap();
        guard.drain_sessions()
    };
    let closed_at = now_ms();
    for session in drained {
        if let Err(e) = persistence::touch(&feature_store, &session.id, closed_at) {
            tracing::error!(target: "fredo::terminal", error = %e, "touch record on window close failed");
        }
        kill_session_tree(session.pid, session.killer);
    }
    emit_sessions_changed(&app, Vec::new());
    emit_persisted_sessions_changed(&app, persistence::list(&feature_store).unwrap_or_default());
    if let Some(win) = app.get_webview_window(WINDOW_LABEL) {
        win.close().ok();
    }
    Ok(())
}

// ── Persisted-record commands (Spec #2935 ST-2) ───────────────────────────────

/// Every persisted session record, newest `lastActiveAt` first. The mount-time
/// source of truth for the "Previous sessions" group.
#[tauri::command]
pub fn list_persisted_terminal_sessions(
    feature_store: tauri::State<'_, Arc<FeatureStore>>,
) -> Result<Vec<PersistedSession>, String> {
    persistence::list(&feature_store).map_err(|e| e.to_string())
}

/// Resume a persisted record through its CLI's own mechanism.
///
/// The source record is REUSED (its id becomes the live session id) — no new
/// record is inserted, so one logical session is exactly one record. On any
/// failure no partial session is left behind and no fresh session is silently
/// substituted (AC4/R-4.3).
///
/// `cols`/`rows` (Spec #2942 ST-5): the pane grid the webview last applied, so
/// a resumed PTY is born at pane size; omitting them keeps 80×24.
#[tauri::command]
pub async fn resume_terminal_session(
    session_id: String,
    cols: Option<u16>,
    rows: Option<u16>,
    app: AppHandle,
    state: tauri::State<'_, Mutex<TerminalState>>,
    store: tauri::State<'_, Arc<AppStore>>,
    feature_store: tauri::State<'_, Arc<FeatureStore>>,
) -> Result<ResumeResult, String> {
    let preflight_started = Instant::now();
    let (grid_cols, grid_rows) = resolve_grid(cols, rows);
    let size = PtySize { rows: grid_rows, cols: grid_cols, pixel_width: 0, pixel_height: 0 };

    let record = match persistence::get(&feature_store, &session_id) {
        Ok(Some(record)) => record,
        Ok(None) => {
            return Ok(ResumeResult::failure(
                ResumeOutcome::Unresumable,
                format!("No saved session matches {session_id}"),
            ))
        }
        Err(e) => return Err(e.to_string()),
    };

    // Diagnostic override settings, same precedence as a fresh spawn.
    let binary_override = if record.cli == SessionKind::Copilot {
        store.get(COPILOT_PATH_KEY).ok().flatten()
    } else {
        None
    };
    let pwsh = powershell_shell(store.get(PWSH_PATH_KEY).ok().flatten().as_deref());

    let form = match prepare_session(record.cli, &record.work_dir, binary_override, &pwsh, None) {
        Ok(form) => form,
        Err((kind, msg)) => return Ok(ResumeResult::failure(resume_outcome_for(kind), msg)),
    };

    // Bounded pre-flight: no resume path may block indefinitely (NFR).
    if preflight_started.elapsed() > RESUME_PREFLIGHT_TIMEOUT {
        return Ok(ResumeResult::failure(
            ResumeOutcome::Unresumable,
            format!("Resume pre-flight exceeded {RESUME_PREFLIGHT_TIMEOUT:?}"),
        ));
    }

    let args = resume_args(record.cli, record.cli_session_id.as_deref());

    // The record exists and passed the pre-flight: reuse its id for the live row.
    {
        let mut guard = state.lock().unwrap();
        guard.insert_starting(
            session_id.clone(),
            record.cli,
            record.work_dir.clone(),
            grid_cols,
            grid_rows,
        );
    }
    // Flag it so a non-zero exit is surfaced as `resume-failed`, not a clean exit.
    mark_resumed(state.inner(), &session_id);
    let sessions = {
        let guard = state.lock().unwrap();
        snapshot(&guard)
    };
    emit_sessions_changed(&app, sessions);

    match spawn_and_wire(&app, &state, &session_id, form, &record.work_dir, &args, size) {
        Ok(true) => {}
        Ok(false) => {
            remove_live_session(&app, &state, &session_id);
            return Ok(ResumeResult::failure(
                ResumeOutcome::LaunchFailed,
                format!("Session {session_id} was closed before it could start"),
            ));
        }
        Err((kind, msg)) => {
            remove_live_session(&app, &state, &session_id);
            return Ok(ResumeResult::failure(resume_outcome_for(kind), msg));
        }
    }

    // REUSE the source record: bump last_active_at only (no new record).
    if let Err(e) = persistence::touch(&feature_store, &session_id, now_ms()) {
        tracing::error!(target: "fredo::terminal", error = %e, "touch resumed record failed");
    }
    emit_persisted_sessions_changed(&app, persistence::list(&feature_store).unwrap_or_default());
    capture_cli_session_id(
        app.clone(),
        record.cli,
        record.work_dir.clone(),
        session_id.clone(),
        now_ms(),
    );

    Ok(ResumeResult::resumed(session_id))
}

/// Delete a persisted record. If a live session shares its id (a resumed or
/// freshly spawned session), terminate that process tree FIRST so deletion
/// leaves no orphan; then remove the record.
#[tauri::command]
pub async fn delete_terminal_session_record(
    session_id: String,
    app: AppHandle,
    state: tauri::State<'_, Mutex<TerminalState>>,
    feature_store: tauri::State<'_, Arc<FeatureStore>>,
) -> Result<(), String> {
    let is_live = {
        let guard = state.lock().unwrap();
        guard.get(&session_id).is_some()
    };
    if is_live {
        remove_live_session(&app, &state, &session_id);
    }
    persistence::delete(&feature_store, &session_id).map_err(|e| e.to_string())?;
    emit_persisted_sessions_changed(&app, persistence::list(&feature_store).unwrap_or_default());
    Ok(())
}

/// Rename a persisted session record — the ONLY name-mutating write (Spec #2942
/// ST-3, R-2.1–R-2.5).
///
/// The name is the session's ONLY editable field. `name` is trimmed; a blank /
/// whitespace-only value is refused with `Err` (R-2.3) and no row is touched.
/// The write is an atomic `title` UPDATE on the record's own row
/// ([`persistence::rename`], the same `FeatureStore::update` path as
/// `touch`/`set_cli_session_id`) — never delete+insert — so a rename cannot end
/// the session, clear scrollback, or change the record's key
/// (`id`/`created_at`/`cli`/`work_dir`/`cli_session_id` unchanged, one row, no
/// orphan/duplicate — R-2.4/G-242).
///
/// Re-emits `terminal-persisted-sessions-changed`, so the live row AND the
/// previous-session row resolve the new name from the one record map (R-2.2).
#[tauri::command]
pub fn rename_terminal_session_record(
    session_id: String,
    name: String,
    app: AppHandle,
    feature_store: tauri::State<'_, Arc<FeatureStore>>,
) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("A session name can't be empty".to_string());
    }
    persistence::rename(&feature_store, &session_id, trimmed).map_err(|e| e.to_string())?;
    emit_persisted_sessions_changed(&app, persistence::list(&feature_store).unwrap_or_default());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    // ── where_first ────────────────────────────────────────────────────────

    #[test]
    fn where_first_finds_known_binary() {
        let name = if cfg!(target_os = "windows") { "cmd.exe" } else { "sh" };
        let result = where_first(name);
        assert!(result.is_some(), "should find {name} on PATH");
        assert!(!result.as_ref().unwrap().is_empty(), "path should not be empty");
    }

    #[test]
    fn where_first_returns_none_for_unknown_binary() {
        let result = where_first("this-command-does-not-exist-xyz-12345");
        assert!(result.is_none(), "should return None for non-existent binary");
    }

    // ── is_unix_script (Windows only) ───────────────────────────────────────

    #[cfg(target_os = "windows")]
    #[test]
    fn is_unix_script_detects_shebang() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.sh");
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(b"#!/usr/bin/env bash\necho hello").unwrap();
        drop(f);

        assert!(is_unix_script(path.to_str().unwrap()), "should detect #! shebang");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn is_unix_script_returns_false_without_shebang() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.sh");
        std::fs::write(&path, b"echo hello").unwrap();

        assert!(!is_unix_script(path.to_str().unwrap()), "should return false for plain script");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn is_unix_script_returns_false_for_nonexistent_file() {
        let result = is_unix_script(r"C:\nonexistent-file-12345.sh");
        assert!(!result, "should return false for non-existent file");
    }

    // ── find_git_bash (Windows only) ────────────────────────────────────────

    #[cfg(target_os = "windows")]
    #[test]
    fn find_git_bash_runs_without_panicking() {
        let _ = find_git_bash();
    }

    // ── resolve_binary ─────────────────────────────────────────────────────

    #[test]
    fn candidate_order_prefers_win32_shims_then_bare() {
        assert_eq!(
            cli_candidates(SessionKind::OpenCode),
            vec!["opencode.exe", "opencode.cmd", "opencode.bat", "opencode"]
        );
        assert_eq!(
            cli_candidates(SessionKind::Copilot),
            vec![
                "copilot.exe",
                "copilot.cmd",
                "copilot.bat",
                "copilot.ps1",
                "copilot"
            ]
        );
    }

    #[test]
    fn shell_candidate_chain_always_offers_a_shell() {
        // Spec #2942 R-3.2 — the chain must terminate in a shell that exists on
        // the host: `cmd.exe` on Windows, `sh` on Unix.
        let candidates = cli_candidates(SessionKind::Shell);
        assert!(!candidates.is_empty());
        #[cfg(target_os = "windows")]
        assert_eq!(candidates, vec!["pwsh.exe", "powershell.exe", "cmd.exe"]);
        #[cfg(not(target_os = "windows"))]
        assert_eq!(candidates.last().map(String::as_str), Some("sh"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn resolve_binary_finds_a_shell_on_windows() {
        // The chain terminates in `cmd.exe` (always present) so a plain-shell
        // session resolves even on a host without `pwsh` (R-3.2).
        let resolved = resolve_binary(SessionKind::Shell, None);
        assert!(resolved.is_ok(), "a shell must resolve on Windows: {resolved:?}");
    }

    #[test]
    fn shell_not_found_message_names_the_shell() {
        let msg = not_found_message(SessionKind::Shell);
        assert!(msg.contains("shell"), "message should name the shell: {msg}");
    }

    #[test]
    fn resolve_binary_uses_a_diagnostic_override_that_exists() {
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join("copilot.exe");
        std::fs::write(&fake, b"stub").unwrap();
        let resolved = resolve_binary(SessionKind::Copilot, Some(fake.to_str().unwrap())).unwrap();
        assert_eq!(resolved, fake.to_str().unwrap());
    }

    #[test]
    fn resolve_binary_rejects_a_missing_override_naming_the_cli() {
        let err = resolve_binary(SessionKind::Copilot, Some(r"C:\Nonexistent\copilot.exe"))
            .unwrap_err();
        assert!(err.contains("copilot"), "message should name copilot: {err}");
        assert!(err.contains("not found"), "message should say not found: {err}");
    }

    #[test]
    fn resolve_binary_not_found_message_names_opencode() {
        let msg = not_found_message(SessionKind::OpenCode);
        assert!(msg.contains("opencode"));
        assert!(msg.contains("not found"));
    }

    #[test]
    fn resolve_binary_succeeds_or_reports_not_found() {
        let result = resolve_binary(SessionKind::OpenCode, None);
        match result {
            Ok(path) => assert!(!path.is_empty()),
            Err(msg) => assert!(msg.contains("not found")),
        }
    }

    // ── plan_launch: resolution → launch form ──────────────────────────────

    #[test]
    fn plan_launch_direct_for_a_plain_binary() {
        let form = plan_launch("opencode", "pwsh").unwrap();
        assert_eq!(form, LaunchForm::Direct("opencode".to_string()));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn plan_launch_wraps_cmd_and_bat_with_the_command_interpreter() {
        assert_eq!(
            plan_launch(r"C:\nvm4w\nodejs\copilot.cmd", "pwsh").unwrap(),
            LaunchForm::CmdShim {
                interpreter: "cmd.exe".to_string(),
                target: r"C:\nvm4w\nodejs\copilot.cmd".to_string(),
            }
        );
        assert_eq!(
            plan_launch(r"C:\tools\copilot.BAT", "pwsh").unwrap(),
            LaunchForm::CmdShim {
                interpreter: "cmd.exe".to_string(),
                target: r"C:\tools\copilot.BAT".to_string(),
            }
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn plan_launch_runs_ps1_through_powershell() {
        let form = plan_launch(r"C:\tools\copilot.ps1", r"C:\pwsh\pwsh.exe").unwrap();
        assert_eq!(
            form,
            LaunchForm::PowerShellScript {
                shell: r"C:\pwsh\pwsh.exe".to_string(),
                target: r"C:\tools\copilot.ps1".to_string(),
            }
        );
    }

    #[test]
    fn build_pty_command_direct_keeps_the_binary() {
        let cmd = build_pty_command(LaunchForm::Direct("opencode".to_string()));
        assert_eq!(cmd.get_argv()[0].to_string_lossy(), "opencode");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn build_pty_command_cmd_shim_uses_cmd_exe_slash_c() {
        let cmd = build_pty_command(LaunchForm::CmdShim {
            interpreter: "cmd.exe".to_string(),
            target: r"C:\tools\copilot.cmd".to_string(),
        });
        let argv: Vec<String> = cmd.get_argv().iter().map(|a| a.to_string_lossy().to_string()).collect();
        assert_eq!(argv, vec![
            "cmd.exe".to_string(),
            "/C".to_string(),
            r"C:\tools\copilot.cmd".to_string(),
        ]);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn build_pty_command_ps1_uses_no_profile_and_file() {
        let cmd = build_pty_command(LaunchForm::PowerShellScript {
            shell: "pwsh".to_string(),
            target: r"C:\tools\copilot.ps1".to_string(),
        });
        let argv: Vec<String> = cmd.get_argv().iter().map(|a| a.to_string_lossy().to_string()).collect();
        assert_eq!(argv, vec![
            "pwsh".to_string(),
            "-NoProfile".to_string(),
            "-ExecutionPolicy".to_string(),
            "Bypass".to_string(),
            "-File".to_string(),
            r"C:\tools\copilot.ps1".to_string(),
        ]);
    }

    // ── PowerShell prerequisite ────────────────────────────────────────────

    #[test]
    fn powershell_shell_prefers_override_then_pwsh() {
        assert_eq!(powershell_shell(Some(r"C:\pwsh\pwsh.exe")), r"C:\pwsh\pwsh.exe");
        assert_eq!(powershell_shell(Some("   ")), "pwsh");
        assert_eq!(powershell_shell(None), "pwsh");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn parse_powershell_major_reads_the_first_non_empty_line() {
        assert_eq!(parse_powershell_major("7\r\n"), Some(7));
        assert_eq!(parse_powershell_major("\n  6  \n"), Some(6));
        assert_eq!(parse_powershell_major("not-a-number"), None);
        assert_eq!(parse_powershell_major(""), None);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn prereq_override_below_six_fails_and_names_powershell() {
        let err = check_powershell_prereq("pwsh", Some(5)).unwrap_err();
        assert!(err.contains("PowerShell 6"), "message should name the requirement: {err}");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn prereq_override_six_or_above_passes() {
        assert!(check_powershell_prereq("pwsh", Some(6)).is_ok());
        assert!(check_powershell_prereq("pwsh", Some(7)).is_ok());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn prereq_missing_shell_fails_without_panicking() {
        let err = check_powershell_prereq(r"C:\Nonexistent\pwsh.exe", None).unwrap_err();
        assert!(err.contains("PowerShell 6"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn powershell_gate_applies_only_to_a_ps1_form_or_a_forced_override() {
        let cmd_shim = LaunchForm::CmdShim {
            interpreter: "cmd.exe".to_string(),
            target: r"C:\nvm4w\nodejs\copilot.cmd".to_string(),
        };
        let direct = LaunchForm::Direct(r"C:\tools\copilot.exe".to_string());
        let ps1 = LaunchForm::PowerShellScript {
            shell: "pwsh".to_string(),
            target: r"C:\tools\copilot.ps1".to_string(),
        };

        // A `.cmd`/`.bat` shim never runs PowerShell → the gate must NOT apply.
        assert!(!powershell_gate_applies(&cmd_shim, None));
        // A `.ps1` genuinely runs PowerShell → the gate applies.
        assert!(powershell_gate_applies(&ps1, None));
        // Any forced override still applies the gate (AC4 4c non-vacuity).
        assert!(powershell_gate_applies(&cmd_shim, Some(5)));
        assert!(powershell_gate_applies(&cmd_shim, Some(7)));
        // A directly-launched binary does not run PowerShell either.
        assert!(!powershell_gate_applies(&direct, None));
        assert!(powershell_gate_applies(&direct, Some(7)));
    }

    // ── Auth marker ────────────────────────────────────────────────────────

    #[test]
    fn detect_auth_marker_matches_copilot_sign_in_copy() {
        assert!(detect_auth_marker("You are not logged in."));
        assert!(detect_auth_marker("Please sign in to continue"));
        assert!(detect_auth_marker("authentication failed"));
    }

    #[test]
    fn detect_auth_marker_ignores_normal_output() {
        assert!(!detect_auth_marker("Welcome to GitHub Copilot"));
        assert!(!detect_auth_marker("opencode v1.2.3"));
        assert!(!detect_auth_marker(""));
    }

    // ── FX-3: bounded accumulated auth scan (RC-1) ─────────────────────────

    #[test]
    fn auth_scan_detects_a_marker_in_the_first_chunk() {
        let mut scan = AuthScanWindow::new();
        assert!(scan.feed(b"GitHub Copilot CLI\r\nYou are not logged in.\r\n"));
        assert!(scan.done);
    }

    #[test]
    fn auth_scan_detects_a_marker_split_across_chunks() {
        let mut scan = AuthScanWindow::new();
        assert!(!scan.feed(b"GitHub Copilot CLI\r\nYou are not logg"));
        assert!(scan.feed(b"ed in. Please sign in.\r\n"));
    }

    #[test]
    fn auth_scan_skips_a_conpty_escape_only_first_chunk() {
        // The observed F-17 case: chunk 1 is the 16 B ConPTY mode-escape
        // prefix, chunk 2 carries the CLI's own auth copy.
        let mut scan = AuthScanWindow::new();
        assert!(!scan.feed(b"\x1b[?9001h\x1b[?1004h"));
        assert!(scan.feed(b"GitHub Copilot CLI\r\nYou are not logged in. Please sign in.\r\n"));
    }

    #[test]
    fn auth_scan_reports_no_marker_and_stops_when_the_window_closes() {
        let mut scan = AuthScanWindow::new();
        assert!(!scan.feed(&vec![b'x'; AUTH_SCAN_WINDOW]));
        assert!(scan.done, "window exhausted without a match stops the scan");
        // A later marker can no longer be introduced.
        assert!(!scan.feed(b"not logged in"));
        assert!(!auth_marker_reached("still normal output", 12));
    }

    #[test]
    fn auth_scan_window_never_exceeds_the_cap() {
        let mut scan = AuthScanWindow::new();
        let _ = scan.feed(&vec![b'x'; 10 * AUTH_SCAN_WINDOW]);
        assert_eq!(scan.bytes.len(), AUTH_SCAN_WINDOW);
    }

    #[test]
    fn auth_kind_is_only_recorded_when_unset() {
        assert!(auth_kind_may_be_recorded(None));
        assert!(!auth_kind_may_be_recorded(Some(TerminalErrorKind::Prereq)));
        assert!(!auth_kind_may_be_recorded(Some(TerminalErrorKind::Launch)));
        assert!(!auth_kind_may_be_recorded(Some(TerminalErrorKind::MissingBinary)));
        assert!(!auth_kind_may_be_recorded(Some(TerminalErrorKind::InvalidCwd)));
        assert!(!auth_kind_may_be_recorded(Some(TerminalErrorKind::Auth)));
        assert!(!auth_kind_may_be_recorded(Some(TerminalErrorKind::Generic)));
    }

    #[test]
    fn auth_marker_reached_stops_on_a_match_or_a_full_window() {
        assert!(auth_marker_reached("You are not logged in.", 22));
        assert!(!auth_marker_reached("Welcome to GitHub Copilot", 25));
        assert!(auth_marker_reached("Welcome to GitHub Copilot", AUTH_SCAN_WINDOW));
    }

    // ── validate_cwd ───────────────────────────────────────────────────────

    #[test]
    fn validate_cwd_accepts_existing_directory() {
        let dir = tempfile::tempdir().unwrap();
        assert!(validate_cwd(dir.path().to_str().unwrap()).is_ok());
    }

    #[test]
    fn validate_cwd_rejects_nonexistent_path() {
        let result = validate_cwd(r"C:\NonexistentDir12345");
        assert!(result.is_err(), "nonexistent dir must fail validation");
        let msg = result.unwrap_err();
        assert!(msg.contains("Working directory not found"), "unexpected message: {msg}");
        assert!(msg.contains(r"C:\NonexistentDir12345"));
    }

    #[test]
    fn validate_cwd_rejects_plain_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("file.txt");
        std::fs::write(&file, b"x").unwrap();
        assert!(validate_cwd(file.to_str().unwrap()).is_err());
    }

    // ── Wire record mapping ────────────────────────────────────────────────

    #[test]
    fn session_info_carries_every_required_field() {
        let session = TerminalSession::starting(
            "abc".into(),
            SessionKind::Copilot,
            r"C:\fredo".into(),
            100,
            30,
        );
        let info = session_info(&session);
        assert_eq!(info.id, "abc");
        assert_eq!(info.cli, SessionKind::Copilot);
        assert_eq!(info.status, TerminalSessionStatus::Starting);
        assert_eq!(info.work_dir, r"C:\fredo");
        assert_eq!(info.cols, 100);
        assert_eq!(info.rows, 30);
        assert!(info.pid.is_none());
        assert!(info.error.is_none());
        assert!(info.error_kind.is_none());
        assert!(info.started_at > 0);
    }

    #[test]
    fn session_info_falls_back_to_generic_kind_when_kind_missing() {
        let mut session = TerminalSession::starting(
            "abc".into(),
            SessionKind::OpenCode,
            "~".into(),
            80,
            24,
        );
        session.launch_error = Some("boom".into());
        session.status = TerminalSessionStatus::Error;
        let info = session_info(&session);
        assert_eq!(info.error_kind, Some(TerminalErrorKind::Generic));
    }

    #[test]
    fn session_info_serializes_camel_case_with_typed_error_kind() {
        let mut session = TerminalSession::starting(
            "abc".into(),
            SessionKind::Copilot,
            r"C:\fredo".into(),
            80,
            24,
        );
        session.fail(TerminalErrorKind::MissingBinary, "`copilot` not found in PATH".into());
        let json = serde_json::to_value(session_info(&session)).unwrap();
        assert_eq!(json["id"], serde_json::json!("abc"));
        assert_eq!(json["cli"], serde_json::json!("copilot"));
        assert_eq!(json["status"], serde_json::json!("error"));
        assert_eq!(json["errorKind"], serde_json::json!("missing-binary"));
        assert_eq!(json["workDir"], serde_json::json!("C:\\fredo"));
        assert!(json["startedAt"].as_u64().is_some());
        assert!(json["pid"].is_null());
    }

    #[test]
    fn sessions_changed_payload_serializes_the_list() {
        let session = TerminalSession::starting(
            "s1".into(),
            SessionKind::OpenCode,
            "~".into(),
            80,
            24,
        );
        let payload = SessionsChangedPayload { sessions: vec![session_info(&session)] };
        let json = serde_json::to_value(payload).unwrap();
        assert_eq!(json["sessions"][0]["id"], serde_json::json!("s1"));
        assert_eq!(json["sessions"][0]["cli"], serde_json::json!("opencode"));
    }

    #[test]
    fn output_payload_carries_session_id_and_bytes() {
        let payload = TerminalOutputPayload {
            session_id: "s1".into(),
            data: b"hi".to_vec(),
        };
        let json = serde_json::to_value(payload).unwrap();
        assert_eq!(json["sessionId"], serde_json::json!("s1"));
        assert_eq!(json["data"], serde_json::json!([104, 105]));
    }

    #[test]
    fn exited_payload_carries_session_id() {
        let payload = TerminalExitedPayload { session_id: "s1".into() };
        let json = serde_json::to_value(payload).unwrap();
        assert_eq!(json["sessionId"], serde_json::json!("s1"));
    }

    #[test]
    fn now_ms_is_a_nonzero_epoch_value() {
        assert!(crate::features::terminal::state::now_ms() > 1_600_000_000_000);
    }

    // ── Resume pre-flight (Spec #2935 ST-2) ────────────────────────────────

    #[test]
    fn resume_outcome_maps_preflight_kinds_and_falls_back_to_launch_failed() {
        assert_eq!(
            resume_outcome_for(TerminalErrorKind::MissingBinary),
            ResumeOutcome::MissingBinary
        );
        assert_eq!(resume_outcome_for(TerminalErrorKind::InvalidCwd), ResumeOutcome::InvalidCwd);
        assert_eq!(resume_outcome_for(TerminalErrorKind::Prereq), ResumeOutcome::LaunchFailed);
        assert_eq!(resume_outcome_for(TerminalErrorKind::Launch), ResumeOutcome::LaunchFailed);
    }

    #[test]
    fn persisted_sessions_changed_payload_serializes_the_records() {
        let record = PersistedSession {
            id: "s1".into(),
            cli: SessionKind::OpenCode,
            work_dir: "~".into(),
            title: "OpenCode".into(),
            created_at: 1,
            last_active_at: 2,
            cli_session_id: None,
        };
        let json = serde_json::to_value(PersistedSessionsChangedPayload { sessions: vec![record] })
            .unwrap();
        assert_eq!(json["sessions"][0]["id"], serde_json::json!("s1"));
        assert_eq!(json["sessions"][0]["workDir"], serde_json::json!("~"));
        assert_eq!(json["sessions"][0]["title"], serde_json::json!("OpenCode"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn list_command_wraps_a_cmd_shim_with_the_command_interpreter() {
        let argv: Vec<String> = list_command(r"C:\nvm4w\nodejs\copilot.cmd")
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert_eq!(argv, vec!["/C".to_string(), r"C:\nvm4w\nodejs\copilot.cmd".to_string()]);
    }

    // ── PendingTerminalOpen: cold-launch one-shot handshake (Spec #2940 ST-8) ─

    fn intent(cli: &str, work_dir: &str) -> TerminalOpenRequestPayload {
        TerminalOpenRequestPayload {
            cli: cli.to_string(),
            work_dir: work_dir.to_string(),
        }
    }

    #[test]
    fn pending_terminal_open_is_unarmed_by_default() {
        let pending = PendingTerminalOpen::default();
        assert!(pending.take().is_none(), "an unarmed intent must yield nothing");
    }

    #[test]
    fn pending_terminal_open_drains_once_then_yields_nothing() {
        let pending = PendingTerminalOpen::default();
        pending.arm(intent("opencode", r"C:\repo"));

        let drained = pending.take().expect("first take drains the armed intent");
        assert_eq!(drained.cli, "opencode");
        assert_eq!(drained.work_dir, r"C:\repo");
        assert!(
            pending.take().is_none(),
            "a second take must yield nothing (reload / re-list safety)"
        );
    }

    #[test]
    fn pending_terminal_open_clear_drops_the_armed_intent() {
        let pending = PendingTerminalOpen::default();
        pending.arm(intent("copilot", "~"));
        pending.clear();
        assert!(pending.take().is_none(), "clear must drop the intent");
    }

    // ── Terminal host resolution (Spec #2947 ST-2) ─────────────────────────

    // `AppHandle` is not constructible under `cfg(test)` (the `tauri` `test`
    // feature is off, and enabling it would edit Cargo.toml outside this
    // sub-task's scope), so the store-read wrapper `terminal_host_label` is
    // pinned through its pure core `host_label_for_stored` — the exact
    // parse+fallback chain it delegates to. R-2.2 / R-3.2.

    #[test]
    fn stored_same_window_routes_to_main() {
        assert_eq!(host_label_for_stored(Some("same-window")), MAIN_WINDOW_LABEL);
        assert_eq!(host_label_for_stored(Some("same-window")), "main");
    }

    #[test]
    fn stored_new_window_routes_to_terminal() {
        assert_eq!(host_label_for_stored(Some("new-window")), WINDOW_LABEL);
        assert_eq!(host_label_for_stored(Some("new-window")), "terminal");
    }

    #[test]
    fn absent_or_unrecognized_value_defaults_to_the_native_host() {
        for raw in [None, Some(""), Some("  "), Some("garbage"), Some("Same-Window")] {
            assert_eq!(
                host_label_for_stored(raw),
                WINDOW_LABEL,
                "raw {raw:?} must fall back to DEFAULT_PRESENTATION's native host"
            );
        }
    }

    #[test]
    fn default_presentation_targets_the_native_host() {
        assert_eq!(host_label_for(DEFAULT_PRESENTATION), WINDOW_LABEL);
    }
}
