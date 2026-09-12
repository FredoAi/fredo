//! Process lifecycle helpers for the managed `llama-server` (Spec #2857, ST-3).
//!
//! Owns the pure filesystem layout (companion dir / config / log), the port
//! selection seam, the `std::process::Command` spawn (no shell, log redirect),
//! and the process-tree kill. Nothing here performs HTTP — readiness lives in
//! [`super::health`].

use std::path::{Path, PathBuf};
use std::process::Stdio;

use anyhow::{Context, Result};

use super::config::LlamaServerConfig;
use super::state::ManagedServer;

/// Subdirectory under the app data dir that holds generated companion artifacts.
pub const COMPANION_DIR: &str = "companion";
/// The generated launch `.bat` filename.
pub const CONFIG_FILENAME: &str = "llama-server-launch.bat";
/// The server stdout/stderr log filename.
pub const LOG_FILENAME: &str = "llama-server.log";

/// The companion artifact directory under the app data dir.
pub fn companion_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(COMPANION_DIR)
}

/// Absolute path of the generated launch config.
pub fn config_path(app_data_dir: &Path) -> PathBuf {
    companion_dir(app_data_dir).join(CONFIG_FILENAME)
}

/// Absolute path of the server log.
pub fn log_path(app_data_dir: &Path) -> PathBuf {
    companion_dir(app_data_dir).join(LOG_FILENAME)
}

/// Choose the port the server binds: `configured` when it is free on `host`,
/// else an OS-assigned free port (bound on `host:0`).
///
/// The caller persists the result as the active port and uses it for the spawn
/// argv, the `/health` poll, and chat (R-2.3). Returns `Err` only when neither
/// the configured nor an ephemeral port can be bound — the caller maps that to
/// the `PortInUse` launch code.
pub fn select_active_port(host: &str, configured: u16) -> std::io::Result<u16> {
    if std::net::TcpListener::bind((host, configured)).is_ok() {
        return Ok(configured);
    }
    let listener = std::net::TcpListener::bind((host, 0))?;
    Ok(listener.local_addr()?.port())
}

/// Spawn the server on the resolved executable with the generated argv.
///
/// stdout/stderr are appended to `log_file`; stdin is null. No shell is involved
/// (a path containing spaces stays one token). On Windows the process is created
/// with `CREATE_NO_WINDOW` so a GUI launch never flashes a console.
pub fn spawn_server(config: &LlamaServerConfig, log_file: &Path) -> Result<ManagedServer> {
    if let Some(parent) = log_file.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("create companion log dir {}", parent.display()))?;
    }
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_file)
        .with_context(|| format!("open log file {}", log_file.display()))?;
    let log_err = log
        .try_clone()
        .context("clone the log file handle for stderr")?;

    let mut command = std::process::Command::new(&config.executable);
    command
        .args(config.to_args())
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err));

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW — the server is a console app; keep the GUI clean.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let child = command
        .spawn()
        .with_context(|| format!("spawn {}", config.executable))?;
    let pid = child.id();
    Ok(ManagedServer {
        child,
        pid,
        port: config.port,
        log_path: log_file.to_path_buf(),
    })
}

/// Kill the managed process AND its tree (a server may spawn child workers).
///
/// Windows uses `taskkill /T /F`; every platform then falls back to
/// [`std::process::Child::kill`] and reaps the child. Best-effort — a process
/// already gone is not an error.
pub fn kill_process_tree(server: &mut ManagedServer) {
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &server.pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }

    let _ = server.child.kill();
    let _ = server.child.wait();
}

/// The last `max_chars` characters of a log file, trimmed (empty when unreadable).
/// Used for the actionable tail in a launch/health failure (R-4).
pub fn read_log_tail(path: &Path, max_chars: usize) -> String {
    match std::fs::read_to_string(path) {
        Ok(contents) => tail_chars(&contents, max_chars),
        Err(_) => String::new(),
    }
}

/// Tail of a string by CHARACTER count (UTF-8 safe).
fn tail_chars(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim_end();
    let count = trimmed.chars().count();
    if count <= max_chars {
        return trimmed.to_string();
    }
    trimmed.chars().skip(count - max_chars).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn config_and_log_paths_live_under_the_companion_dir() {
        let dir = PathBuf::from(r"C:\data\fredo");
        assert_eq!(
            config_path(&dir),
            dir.join("companion").join("llama-server-launch.bat")
        );
        assert_eq!(log_path(&dir), dir.join("companion").join("llama-server.log"));
    }

    #[test]
    fn select_active_port_returns_the_configured_port_when_free() {
        // Bind-then-release to obtain an ephemeral port; if another process steals
        // it in the gap, retry — we assert we observed the configured (free) branch.
        for _ in 0..5 {
            let probe = TcpListener::bind(("127.0.0.1", 0)).expect("bind ephemeral");
            let port = probe.local_addr().expect("local addr").port();
            drop(probe);
            let selected = select_active_port("127.0.0.1", port).expect("select port");
            if selected == port {
                return;
            }
        }
        panic!("could not observe a free configured port across 5 attempts");
    }

    #[test]
    fn select_active_port_falls_back_to_a_free_port_when_configured_is_bound() {
        let held = TcpListener::bind(("127.0.0.1", 0)).expect("bind occupied port");
        let occupied = held.local_addr().expect("local addr").port();

        let selected = select_active_port("127.0.0.1", occupied).expect("select fallback");

        assert_ne!(selected, occupied);
        // The fallback port must actually be bindable (i.e. genuinely free).
        let verify = TcpListener::bind(("127.0.0.1", selected)).expect("fallback port is free");
        drop(verify);
        drop(held);
    }

    #[test]
    fn read_log_tail_returns_only_the_tail_and_empty_when_absent() {
        let dir = tempfile::tempdir().expect("tempdir");
        let log = dir.path().join("server.log");
        std::fs::write(&log, "0123456789").expect("write log");

        assert_eq!(read_log_tail(&log, 4), "6789");
        assert_eq!(read_log_tail(&log, 100), "0123456789");
        assert_eq!(read_log_tail(&dir.path().join("missing.log"), 4), "");
    }
}
