use std::io::{Read, Write};
#[cfg(target_os = "windows")]
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, PtySize};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use uuid::Uuid;

use crate::features::terminal::state::{
    append_capped, TerminalCli, TerminalErrorKind, TerminalSession, TerminalSessionStatus,
    TerminalState, OUTPUT_BUFFER_CAP,
};
use crate::infrastructure::storage::AppStore;

/// The ONE terminal window label (window-targeted events + lifecycle).
const WINDOW_LABEL: &str = "terminal";

/// Unrendered diagnostic override: a Copilot binary used BEFORE the PATH search.
const COPILOT_PATH_KEY: &str = "terminal_copilot_path";
/// Unrendered diagnostic override: the PowerShell executable for the prereq gate.
const PWSH_PATH_KEY: &str = "terminal_pwsh_path";

/// Copilot requires PowerShell 6+ (Windows PowerShell 5.1 is not acceptable).
const MIN_POWERSHELL_MAJOR: u32 = 6;

/// Best-effort Copilot auth-failure markers in the CLI's own first output.
const AUTH_MARKERS: &[&str] = &[
    "not logged in",
    "please sign in",
    "not authenticated",
    "authentication failed",
    "unauthorized",
];

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
fn cli_candidates(cli: TerminalCli) -> Vec<String> {
    match cli {
        TerminalCli::OpenCode => vec![
            "opencode.exe".to_string(),
            "opencode.cmd".to_string(),
            "opencode.bat".to_string(),
            "opencode".to_string(),
        ],
        TerminalCli::Copilot => vec![
            "copilot.exe".to_string(),
            "copilot.cmd".to_string(),
            "copilot.bat".to_string(),
            "copilot.ps1".to_string(),
            "copilot".to_string(),
        ],
    }
}

/// Message shown when a CLI cannot be resolved. Names the CLI so the in-window
/// error (and the AC4 receipt) can identify the cause without string parsing.
fn not_found_message(cli: TerminalCli) -> String {
    match cli {
        TerminalCli::OpenCode => "`opencode` not found in PATH. \
             Install OpenCode from https://opencode.ai or via your package manager."
            .to_string(),
        TerminalCli::Copilot => "GitHub Copilot CLI (`copilot`) not found in PATH. \
             Install the GitHub Copilot CLI, then retry."
            .to_string(),
    }
}

/// Resolve the CLI binary. A non-empty override (diagnostic setting or the
/// TEST-ONLY seam) is used BEFORE the PATH search and must exist.
fn resolve_binary(cli: TerminalCli, override_path: Option<&str>) -> Result<String, String> {
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

/// Best-effort Copilot auth-failure detection over the CLI's own first output.
fn detect_auth_marker(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    AUTH_MARKERS.iter().any(|marker| lower.contains(marker))
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

/// Per-session wire record. `pid` + `startedAt` let the QA prove that switching
/// or replaying a session never re-spawns it; `errorKind` is typed so the UI
/// selects a distinct error state without parsing `error`.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionInfo {
    pub id: String,
    pub cli: TerminalCli,
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
        WINDOW_LABEL,
        "terminal-sessions-changed",
        SessionsChangedPayload { sessions },
    ) {
        tracing::error!(target: "fredo::terminal", error = %e, "emit terminal-sessions-changed failed");
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

/// Handler wired to the `terminal` window: closing the window for ANY reason
/// (OS X button, Alt+F4, `close_terminal_window`) tree-kills EVERY session so no
/// process orphans (AC5).
fn window_close_handler(
    app: AppHandle,
) -> impl Fn(&tauri::WindowEvent) + Send + Sync + 'static {
    move |event| {
        if let tauri::WindowEvent::CloseRequested { .. } = event {
            tracing::debug!(target: "fredo::terminal", "CloseRequested: tree-killing every session");
            let drained = {
                let s = app.state::<Mutex<TerminalState>>();
                let mut guard = s.lock().unwrap();
                guard.drain_sessions()
            };
            for session in drained {
                kill_session_tree(session.pid, session.killer);
            }
        }
    }
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Create or focus the ONE `terminal` window. NO session is spawned here — the
/// first session is created by the in-window add-session flow
/// (`spawn_terminal_session`).
#[tauri::command]
pub async fn open_terminal_window(app: AppHandle) -> Result<(), String> {
    tracing::debug!(target: "fredo::terminal", "open_terminal_window called");

    match app.get_webview_window(WINDOW_LABEL) {
        Some(win) => {
            tracing::debug!(target: "fredo::terminal", "reusing existing terminal window");
            win.set_focus().ok();
        }
        None => {
            tracing::debug!(target: "fredo::terminal", "building WebviewWindow");
            let window = WebviewWindowBuilder::new(
                &app,
                WINDOW_LABEL,
                WebviewUrl::App("index.html?view=terminal".into()),
            )
            .title("Terminal")
            .inner_size(900.0, 600.0)
            .min_inner_size(560.0, 360.0)
            .resizable(true)
            .build()
            .map_err(|e| {
                tracing::error!(target: "fredo::terminal", error = %e, "WebviewWindow creation failed");
                format!("Failed to open terminal window: {e}")
            })?;
            // Wire CloseRequested → tree-kill every session (no orphans).
            window.on_window_event(window_close_handler(app.clone()));
        }
    }

    Ok(())
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
/// Deterministic order: allocate id → insert `starting` → resolve binary →
/// validate cwd → Copilot-only PowerShell-6+ gate → openpty/spawn → store
/// handles + pid → spawn the reader task. ANY failure before `spawn_command`
/// sets `status=error`, a typed `error_kind`, and `launch_error`, and still
/// returns `Ok(sessionId)` so the sidebar row is the in-window error surface.
/// Nothing is spawned on a failure path, so no orphan can exist.
#[tauri::command]
pub async fn spawn_terminal_session(
    cli: String,
    work_dir: Option<String>,
    test_override: Option<SpawnTestOverride>,
    app: AppHandle,
    state: tauri::State<'_, Mutex<TerminalState>>,
    store: tauri::State<'_, Arc<AppStore>>,
) -> Result<String, String> {
    let cli = TerminalCli::parse(&cli).ok_or_else(|| format!("Unknown CLI: {cli}"))?;

    let cwd = work_dir
        .filter(|s| !s.trim().is_empty())
        .or_else(|| std::env::var("USERPROFILE").ok())
        .or_else(|| std::env::var("HOME").ok())
        .unwrap_or_else(|| ".".to_string());

    let session_id = Uuid::new_v4().to_string();
    {
        let mut guard = state.lock().unwrap();
        guard.insert_starting(session_id.clone(), cli, cwd.clone(), 80, 24);
    }
    let sessions = {
        let guard = state.lock().unwrap();
        snapshot(&guard)
    };
    emit_sessions_changed(&app, sessions);

    // Diagnostic override settings (unrendered). The TEST-ONLY seam wins over
    // the stored Copilot path (which only applies to a Copilot session).
    let binary_override = test_override.as_ref().and_then(|o| o.binary.clone()).or_else(|| {
        if cli == TerminalCli::Copilot {
            store.get(COPILOT_PATH_KEY).ok().flatten()
        } else {
            None
        }
    });
    let pwsh = powershell_shell(store.get(PWSH_PATH_KEY).ok().flatten().as_deref());

    // ── Resolve binary ─────────────────────────────────────────────────────
    let bin = match resolve_binary(cli, binary_override.as_deref()) {
        Ok(bin) => bin,
        Err(msg) => {
            tracing::error!(target: "fredo::terminal", error = %msg, "binary resolution failed");
            fail_session(&app, &state, &session_id, TerminalErrorKind::MissingBinary, msg);
            return Ok(session_id);
        }
    };
    tracing::debug!(target: "fredo::terminal", bin = ?bin, "resolved binary");

    // ── Validate cwd (ConPTY does not) ─────────────────────────────────────
    if let Err(msg) = validate_cwd(&cwd) {
        tracing::error!(target: "fredo::terminal", error = %msg, "cwd validation failed");
        fail_session(&app, &state, &session_id, TerminalErrorKind::InvalidCwd, msg);
        return Ok(session_id);
    }

    // ── Copilot-only PowerShell 6+ gate (pre-spawn) ────────────────────────
    #[cfg(target_os = "windows")]
    if cli == TerminalCli::Copilot {
        let override_major = test_override.as_ref().and_then(|o| o.pwsh_major);
        if let Err(msg) = check_powershell_prereq(&pwsh, override_major) {
            tracing::error!(target: "fredo::terminal", error = %msg, "PowerShell prerequisite failed");
            fail_session(&app, &state, &session_id, TerminalErrorKind::Prereq, msg);
            return Ok(session_id);
        }
    }

    // ── Open the PTY and spawn ─────────────────────────────────────────────
    let pty_system = native_pty_system();
    let pair = match pty_system.openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
    {
        Ok(pair) => pair,
        Err(e) => {
            let msg = format!("Failed to open PTY: {e}");
            tracing::error!(target: "fredo::terminal", error = %e, "openpty failed");
            fail_session(&app, &state, &session_id, TerminalErrorKind::Launch, msg);
            return Ok(session_id);
        }
    };

    let form = match plan_launch(&bin, &pwsh) {
        Ok(form) => form,
        Err(msg) => {
            tracing::error!(target: "fredo::terminal", error = %msg, "launch planning failed");
            fail_session(&app, &state, &session_id, TerminalErrorKind::Launch, msg);
            return Ok(session_id);
        }
    };
    let mut cmd = build_pty_command(form);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "fredo");
    cmd.cwd(&cwd);

    tracing::debug!(target: "fredo::terminal", bin = ?bin, cwd = ?cwd, "spawning child");
    let child = match pair.slave.spawn_command(cmd) {
        Ok(child) => child,
        Err(e) => {
            let msg = format!("Could not start session: {e}");
            tracing::error!(target: "fredo::terminal", error = %e, "spawn failed");
            fail_session(&app, &state, &session_id, TerminalErrorKind::Launch, msg);
            return Ok(session_id);
        }
    };
    let pid = child.process_id();
    tracing::debug!(target: "fredo::terminal", pid = ?pid, "child spawned OK");

    // Clone reader BEFORE taking writer (Windows ConPTY ordering requirement)
    let mut reader = match pair.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(e) => {
            let msg = format!("Failed to get PTY reader: {e}");
            tracing::error!(target: "fredo::terminal", error = %e, "reader clone failed");
            kill_session_tree(pid, Some(child));
            fail_session(&app, &state, &session_id, TerminalErrorKind::Launch, msg);
            return Ok(session_id);
        }
    };
    let writer = match pair.master.take_writer() {
        Ok(writer) => writer,
        Err(e) => {
            let msg = format!("Failed to get PTY writer: {e}");
            tracing::error!(target: "fredo::terminal", error = %e, "writer take failed");
            kill_session_tree(pid, Some(child));
            fail_session(&app, &state, &session_id, TerminalErrorKind::Launch, msg);
            return Ok(session_id);
        }
    };

    // ── Store handles + make the session live ──────────────────────────────
    let output_buffer = {
        let mut guard = state.lock().unwrap();
        match guard.get_mut(&session_id) {
            Some(session) => {
                session.pid = pid;
                session.writer = Some(writer);
                session.killer = Some(child);
                session.master = Some(pair.master);
                session.status = TerminalSessionStatus::Running;
                session.cols = 80;
                session.rows = 24;
                Arc::clone(&session.output_buffer)
            }
            None => {
                // The session was closed mid-spawn: kill the fresh child and stop.
                tracing::warn!(target: "fredo::terminal", "session vanished before spawn completed");
                kill_session_tree(pid, Some(child));
                return Ok(session_id);
            }
        }
    };
    let sessions = {
        let guard = state.lock().unwrap();
        snapshot(&guard)
    };
    emit_sessions_changed(&app, sessions);

    // ── Reader task (never holds the state lock across a read) ─────────────
    let app_task = app.clone();
    let task_id = session_id.clone();
    tauri::async_runtime::spawn(async move {
        let mut buf = [0u8; 4096];
        let mut line_buf = String::new();
        let mut first_chunk_checked = false;

        loop {
            let n = match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            let chunk = &buf[..n];

            append_capped(&output_buffer, chunk, OUTPUT_BUFFER_CAP);

            if !first_chunk_checked {
                first_chunk_checked = true;
                if detect_auth_marker(&String::from_utf8_lossy(chunk)) {
                    let s = app_task.state::<Mutex<TerminalState>>();
                    let mut guard = s.lock().unwrap();
                    if let Some(session) = guard.get_mut(&task_id) {
                        session.error_kind = Some(TerminalErrorKind::Auth);
                    }
                }
            }

            // Window-targeted emit: the terminal window is the only consumer,
            // and the payload carries the sessionId so routing is session-scoped.
            if let Err(e) = app_task.emit_to(
                WINDOW_LABEL,
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
        // stays open (R-5.3) — the removed auto-close is intentional.
        {
            let s = app_task.state::<Mutex<TerminalState>>();
            let mut guard = s.lock().unwrap();
            if let Some(session) = guard.get_mut(&task_id) {
                session.status = TerminalSessionStatus::Exited;
                session.writer = None;
                session.master = None;
                let _ = session.killer.take();
            }
        }

        if let Err(e) = app_task.emit_to(
            WINDOW_LABEL,
            "terminal-exited",
            TerminalExitedPayload { session_id: task_id.clone() },
        ) {
            tracing::error!(target: "fredo::terminal", error = %e, "emit terminal-exited failed");
        }

        let sessions = {
            let s = app_task.state::<Mutex<TerminalState>>();
            let guard = s.lock().unwrap();
            snapshot(&guard)
        };
        emit_sessions_changed(&app_task, sessions);
    });

    Ok(session_id)
}

/// Session list — the mount-time source of truth for the window (and the QA's
/// per-session read of status / errorKind / pid / startedAt).
#[tauri::command]
pub fn list_terminal_sessions(state: tauri::State<'_, Mutex<TerminalState>>) -> Vec<TerminalSessionInfo> {
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
/// and the window are untouched.
#[tauri::command]
pub async fn close_terminal_session(
    session_id: String,
    app: AppHandle,
    state: tauri::State<'_, Mutex<TerminalState>>,
) -> Result<(), String> {
    let removed = {
        let mut guard = state.lock().unwrap();
        guard.remove(&session_id)
    };
    if let Some(session) = removed {
        kill_session_tree(session.pid, session.killer);
    }
    let sessions = {
        let guard = state.lock().unwrap();
        snapshot(&guard)
    };
    emit_sessions_changed(&app, sessions);
    Ok(())
}

/// Close the terminal window: tree-kill EVERY session, then close. Also reached
/// via the window's `CloseRequested` handler.
#[tauri::command]
pub async fn close_terminal_window(
    app: AppHandle,
    state: tauri::State<'_, Mutex<TerminalState>>,
) -> Result<(), String> {
    let drained = {
        let mut guard = state.lock().unwrap();
        guard.drain_sessions()
    };
    for session in drained {
        kill_session_tree(session.pid, session.killer);
    }
    emit_sessions_changed(&app, Vec::new());
    if let Some(win) = app.get_webview_window(WINDOW_LABEL) {
        win.close().ok();
    }
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
            cli_candidates(TerminalCli::OpenCode),
            vec!["opencode.exe", "opencode.cmd", "opencode.bat", "opencode"]
        );
        assert_eq!(
            cli_candidates(TerminalCli::Copilot),
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
    fn resolve_binary_uses_a_diagnostic_override_that_exists() {
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join("copilot.exe");
        std::fs::write(&fake, b"stub").unwrap();
        let resolved = resolve_binary(TerminalCli::Copilot, Some(fake.to_str().unwrap())).unwrap();
        assert_eq!(resolved, fake.to_str().unwrap());
    }

    #[test]
    fn resolve_binary_rejects_a_missing_override_naming_the_cli() {
        let err = resolve_binary(TerminalCli::Copilot, Some(r"C:\Nonexistent\copilot.exe"))
            .unwrap_err();
        assert!(err.contains("copilot"), "message should name copilot: {err}");
        assert!(err.contains("not found"), "message should say not found: {err}");
    }

    #[test]
    fn resolve_binary_not_found_message_names_opencode() {
        let msg = not_found_message(TerminalCli::OpenCode);
        assert!(msg.contains("opencode"));
        assert!(msg.contains("not found"));
    }

    #[test]
    fn resolve_binary_succeeds_or_reports_not_found() {
        let result = resolve_binary(TerminalCli::OpenCode, None);
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
            TerminalCli::Copilot,
            r"C:\fredo".into(),
            100,
            30,
        );
        let info = session_info(&session);
        assert_eq!(info.id, "abc");
        assert_eq!(info.cli, TerminalCli::Copilot);
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
            TerminalCli::OpenCode,
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
            TerminalCli::Copilot,
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
            TerminalCli::OpenCode,
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
}
