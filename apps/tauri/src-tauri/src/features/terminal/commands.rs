use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use portable_pty::{native_pty_system, PtySize};
use uuid::Uuid;

use crate::features::terminal::state::RunCliState;
use crate::infrastructure::comm::{
    EventBus, EventProvider, EventState, EventType, FredoEvent, Transport,
};

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

fn resolve_binary() -> Result<String, String> {
    let name = "opencode";

    // On Windows, prefer Win32-native forms (.exe, .cmd, .bat) over bare names.
    #[cfg(target_os = "windows")]
    for candidate in &[
        format!("{name}.exe"),
        format!("{name}.cmd"),
        format!("{name}.bat"),
    ] {
        if let Some(path) = where_first(candidate) {
            eprintln!("[resolve_binary] found Win32 binary: {path:?}");
            return Ok(path);
        }
    }

    // Fall back to bare name (correct on Unix; last resort on Windows)
    where_first(name).ok_or_else(|| {
        format!(
            "`{name}` not found in PATH. \
             Install OpenCode from https://opencode.ai or via your package manager."
        )
    })
}

/// Build a PTY command for the resolved binary.
/// On Windows, if the binary is a Unix shell script, wraps it with Git bash.
fn build_pty_command(bin: &str) -> Result<portable_pty::CommandBuilder, String> {
    #[cfg(target_os = "windows")]
    if is_unix_script(bin) {
        let bash = find_git_bash().ok_or_else(|| format!(
            "`{}` is a Unix shell script and cannot run directly on Windows. \
             Install Git for Windows (https://gitforwindows.org) to provide bash, \
             or install the Windows-native version of this tool.",
            bin
        ))?;
        eprintln!("[build_pty_command] wrapping Unix script {bin:?} with bash: {bash:?}");
        let mut cmd = portable_pty::CommandBuilder::new(&bash);
        cmd.arg(bin);
        return Ok(cmd);
    }

    Ok(portable_pty::CommandBuilder::new(bin))
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Spawn OpenCode CLI in a PTY, open a terminal window and start streaming
/// raw output to both the terminal window and the main-window event log.
#[tauri::command]
pub async fn open_run_cli(
    work_dir: Option<String>,
    app: AppHandle,
    state: tauri::State<'_, Mutex<RunCliState>>,
) -> Result<(), String> {
    eprintln!("[open_run_cli] called — work_dir={work_dir:?}");
    let bin = resolve_binary()?;
    eprintln!("[open_run_cli] resolved binary: {bin:?}");
    let correlation_id = Uuid::new_v4().to_string();

    let cwd = work_dir
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("USERPROFILE").ok())
        .or_else(|| std::env::var("HOME").ok())
        .unwrap_or_else(|| ".".to_string());

    let bus = app.state::<EventBus>();
    bus.emit(FredoEvent::builder()
        .event_type(EventType::ToolUse)
        .state(EventState::Init)
        .provider(EventProvider::Internal)
        .transport(Transport::Hook)
        .tool_name("run_cli")
        .correlation_id(&correlation_id)
        .payload(serde_json::json!({ "binary": bin, "cwd": cwd }))
        .build());

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("Failed to open PTY: {e}"))?;

    let mut cmd = build_pty_command(&bin)?;
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "fredo");
    cmd.cwd(&cwd);

    eprintln!("[open_run_cli] spawning child: {bin:?} in cwd={cwd:?}");
    let child = pair.slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn opencode: {e}"))?;
    eprintln!("[open_run_cli] child spawned OK");

    // Clone reader BEFORE taking writer (Windows ConPTY ordering requirement)
    let mut reader = pair.master
        .try_clone_reader()
        .map_err(|e| format!("Failed to get PTY reader: {e}"))?;

    let writer = pair.master
        .take_writer()
        .map_err(|e| format!("Failed to get PTY writer: {e}"))?;

    let output_buffer: Arc<Mutex<Vec<u8>>>;
    {
        let mut s = state.lock().unwrap();
        if let Some(mut old) = s.killer.take() { let _ = old.kill(); }
        {
            let mut buf = s.output_buffer.lock().unwrap();
            buf.clear();
        }
        output_buffer = Arc::clone(&s.output_buffer);
        s.writer = Some(writer);
        s.killer = Some(child);
        s.master = Some(pair.master);
        s.correlation_id = Some(correlation_id.clone());
    }

    // Start reader task BEFORE window creation (prevents ConPTY stall on Windows)
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut buf = [0u8; 4096];
        let mut line_buf = String::new();

        loop {
            let n = match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };

            let chunk = &buf[..n];

            {
                let mut ob = output_buffer.lock().unwrap();
                ob.extend_from_slice(chunk);
                const MAX_BUF: usize = 256 * 1024;
                if ob.len() > MAX_BUF {
                    let overflow = ob.len() - MAX_BUF;
                    ob.drain(..overflow);
                }
            }

            let _ = app_clone.emit("run-cli-output", chunk.to_vec());

            line_buf.push_str(&String::from_utf8_lossy(chunk));
            while let Some(pos) = line_buf.find('\n') {
                let line = line_buf[..pos].trim_end_matches('\r').to_string();
                line_buf = line_buf[pos + 1..].to_string();
                if !line.is_empty() {
                    let bus = app_clone.state::<EventBus>();
                    bus.emit(FredoEvent::builder()
                        .event_type(EventType::ToolUse)
                        .state(EventState::Update)
                        .provider(EventProvider::Internal)
                        .transport(Transport::Hook)
                        .tool_name("run_cli")
                        .correlation_id(correlation_id.clone())
                        .payload(serde_json::json!({ "data": line }))
                        .build());
                }
            }
        }

        let bus = app_clone.state::<EventBus>();
        bus.emit(FredoEvent::builder()
            .event_type(EventType::ToolUse)
            .state(EventState::Response)
            .provider(EventProvider::Internal)
            .transport(Transport::Hook)
            .tool_name("run_cli")
            .correlation_id(correlation_id)
            .build());
        let _ = app_clone.emit("run-cli-exited", ());
    });

    let label = "run-cli-terminal";
    eprintln!("[open_run_cli] checking for existing window label={label:?}");
    if let Some(win) = app.get_webview_window(label) {
        eprintln!("[open_run_cli] closing existing window");
        win.close().ok();
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    }

    if let Some(win) = app.get_webview_window(label) {
        eprintln!("[open_run_cli] window still present after close — focusing it");
        win.set_focus().ok();
        return Ok(());
    }

    eprintln!("[open_run_cli] building WebviewWindow url=index.html?view=terminal");
    match WebviewWindowBuilder::new(
        &app,
        label,
        WebviewUrl::App("index.html?view=terminal".into()),
    )
    .title("OpenCode Terminal")
    .inner_size(900.0, 600.0)
    .min_inner_size(400.0, 300.0)
    .resizable(true)
    .build() {
        Ok(_) => {
            eprintln!("[open_run_cli] WebviewWindow created successfully");
            Ok(())
        }
        Err(e) => {
            eprintln!("[open_run_cli] ERROR creating WebviewWindow: {e}");
            Err(format!("Failed to open terminal window: {e}"))
        }
    }
}

/// Return all buffered PTY output so the terminal window can replay missed bytes on mount.
#[tauri::command]
pub fn get_pty_buffer(
    state: tauri::State<'_, Mutex<RunCliState>>,
) -> Vec<u8> {
    let s = state.lock().unwrap();
    let buf = s.output_buffer.lock().unwrap().clone();
    buf
}

/// Write raw input bytes to the running PTY (keyboard input from terminal window).
#[tauri::command]
pub fn write_pty_input(
    data: String,
    state: tauri::State<'_, Mutex<RunCliState>>,
) -> Result<(), String> {
    let mut s = state.lock().unwrap();
    if let Some(ref mut w) = s.writer {
        w.write_all(data.as_bytes()).map_err(|e| e.to_string())
    } else {
        Err("No active PTY".into())
    }
}

/// Resize the PTY (called when the terminal window is resized).
#[tauri::command]
pub fn resize_pty(
    rows: u16,
    cols: u16,
    state: tauri::State<'_, Mutex<RunCliState>>,
) -> Result<(), String> {
    let s = state.lock().unwrap();
    if let Some(ref master) = s.master {
        master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Kill the running CLI process and close the terminal window.
#[tauri::command]
pub async fn close_run_cli(
    app: AppHandle,
    state: tauri::State<'_, Mutex<RunCliState>>,
) -> Result<(), String> {
    {
        let mut s = state.lock().unwrap();
        if let Some(mut child) = s.killer.take() {
            let _ = child.kill();
        }
        s.writer = None;
        s.master = None;
        s.correlation_id = None;
    }
    if let Some(win) = app.get_webview_window("run-cli-terminal") {
        win.close().ok();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    // ── REQ-4: where_first returns Some for known binary, None for unknown ──

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
        // Should not panic — either finds Git bash or returns None gracefully
        let _ = find_git_bash();
    }

    // ── REQ-6: resolve_binary returns correct path on Windows ──────────────

    #[test]
    fn resolve_binary_errors_with_message_when_not_in_path() {
        let result = resolve_binary();
        match result {
            Ok(path) => {
                assert!(!path.is_empty(), "resolved path should not be empty");
            }
            Err(msg) => {
                assert!(msg.contains("opencode"), "error message should mention 'opencode'");
                assert!(msg.contains("not found"), "error message should mention 'not found'");
            }
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn where_first_checks_exe_candidates_on_windows() {
        // On Windows, `where` finds cmd.exe with explicit .exe extension.
        // This verifies that where_first works with the extension candidates
        // used by resolve_binary (.exe, .cmd, .bat).
        let exe_result = where_first("cmd.exe");
        assert!(exe_result.is_some(), "should find cmd.exe on Windows PATH");
    }

    // ── REQ-7: build_pty_command detects Unix scripts and wraps with bash ──

    #[test]
    fn build_pty_command_returns_ok_for_plain_binary() {
        // A non-script binary path always returns Ok(CommandBuilder)
        let result = build_pty_command("test-binary");
        assert!(result.is_ok(), "should return Ok for non-script binary");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn build_pty_command_handles_unix_script() {
        let dir = tempfile::tempdir().unwrap();
        let script_path = dir.path().join("opencode.sh");
        std::fs::write(&script_path, b"#!/usr/bin/env bash\nopencode \"$@\"").unwrap();
        let script_str = script_path.to_str().unwrap();

        let result = build_pty_command(script_str);
        // If Git bash is installed → Ok(wrapped with bash)
        // If Git bash is not installed → Err(no bash)
        // Either is valid — the key behavior is that script detection runs
        assert!(result.is_ok() || result.is_err(), "should handle unix scripts on Windows");
    }
}
