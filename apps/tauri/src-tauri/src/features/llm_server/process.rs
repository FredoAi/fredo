//! Process lifecycle helpers for the managed `llama-server` (Spec #2857, ST-3;
//! startup orphan sweep ST-7).
//!
//! Owns the pure filesystem layout (companion dir / config / log), the port
//! selection seam, the `std::process::Command` spawn (no shell, log redirect),
//! the process-tree kill, and the PID marker + startup orphan sweep (R-3.3).
//! Nothing here performs HTTP — readiness lives in [`super::health`].

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;

use anyhow::{Context, Result};
use tauri::{AppHandle, Manager};

use crate::infrastructure::storage::AppStore;

use super::config::LlamaServerConfig;
use super::state::ManagedServer;
use super::{LLAMA_SERVER_COMPANION_DIR_KEY, LLAMA_SERVER_PID_KEY};

/// Default subdirectory under the app data dir that holds generated companion
/// artifacts when no override is configured.
pub const COMPANION_DIR: &str = "companion";
/// The generated launch `.bat` filename.
pub const CONFIG_FILENAME: &str = "llama-server-launch.bat";
/// The server stdout/stderr log filename.
pub const LOG_FILENAME: &str = "llama-server.log";

/// The DEFAULT companion artifact directory under the app data dir
/// (`{app_data_dir}/companion`). Used only when the persisted override is
/// blank/absent — see [`resolve_companion_dir`].
pub fn default_companion_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(COMPANION_DIR)
}

/// Absolute path of the generated launch config inside `companion_dir`.
pub fn config_path(companion_dir: &Path) -> PathBuf {
    companion_dir.join(CONFIG_FILENAME)
}

/// Absolute path of the server log inside `companion_dir`.
pub fn log_path(companion_dir: &Path) -> PathBuf {
    companion_dir.join(LOG_FILENAME)
}

/// Pure companion-dir resolution: a non-blank, trimmed override wins; anything
/// else (absent, empty, whitespace-only) yields `default`.
pub fn resolve_companion_dir_from(configured: Option<&str>, default: PathBuf) -> PathBuf {
    match configured {
        Some(value) if !value.trim().is_empty() => PathBuf::from(value.trim()),
        _ => default,
    }
}

/// Resolve the companion artifact directory from the persisted setting
/// ([`LLAMA_SERVER_COMPANION_DIR_KEY`]), falling back to the product default
/// `{app_data_dir}/companion` when the setting is blank/absent.
pub fn resolve_companion_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let default = default_companion_dir(
        &app.path()
            .app_data_dir()
            .map_err(|e| format!("could not resolve the app data dir: {e}"))?,
    );
    let store = app.state::<Arc<AppStore>>();
    let configured = store
        .get(LLAMA_SERVER_COMPANION_DIR_KEY)
        .ok()
        .flatten()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    Ok(resolve_companion_dir_from(configured.as_deref(), default))
}

// ── Startup orphan sweep (ST-7, R-3.3) ────────────────────────────────────────
//
// The `RunEvent::Exit` hook (ST-4) cannot run on a hard-kill (SIGKILL/Task
// Manager), so a `llama-server` child can outlive Fredo. The launch flow
// persists its PID (`llama_server_pid`); on the next startup we inspect that
// PID and reclaim it — but ONLY after confirming the live image is our server,
// so an OS-reused PID is never killed.

/// Image name the managed server process must report for the sweep to treat a
/// persisted PID as OUR server (the PID-reuse guard's expected value).
const LLAMA_SERVER_IMAGE: &str = "llama-server.exe";

/// Persist the managed server PID marker; `None` clears it.
///
/// AppStore is the single source of truth for the marker — this helper owns the
/// key so the write and clear paths cannot drift. A failed write is ignored: the
/// marker is best-effort recovery metadata, never load-bearing state.
pub fn persist_pid(store: &AppStore, pid: Option<u32>) {
    let value = pid.map(|pid| pid.to_string()).unwrap_or_default();
    let _ = store.set(LLAMA_SERVER_PID_KEY, &value);
}

/// Read the persisted managed server PID marker (blank / malformed => `None`).
pub fn persisted_pid(store: &AppStore) -> Option<u32> {
    store
        .get(LLAMA_SERVER_PID_KEY)
        .ok()
        .flatten()
        .and_then(|value| value.trim().parse().ok())
}

/// Pure PID-reuse guard: a persisted PID may be swept ONLY when the live process
/// image is the expected server binary. A reused PID (any other image), an empty
/// name, or an unreadable image is NEVER killed.
pub fn is_llama_server_image(image: Option<&str>, expected: &str) -> bool {
    match image {
        Some(name) => {
            let name = name.trim();
            !name.is_empty() && name.eq_ignore_ascii_case(expected)
        }
        None => false,
    }
}

/// The OS-reported image name for `pid`, or `None` when the process is gone or
/// unreadable. Windows queries `tasklist`; other platforms return `None` (the
/// companion runtime is Windows-only).
pub fn process_image_name(pid: u32) -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        let output = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
            .stdin(Stdio::null())
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        parse_tasklist_image_name(&stdout).map(str::to_string)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = pid;
        None
    }
}

/// First CSV field of the first `tasklist /FO CSV` data line
/// (`"image","pid",…`), or `None` for a no-match / info line.
#[cfg(target_os = "windows")]
fn parse_tasklist_image_name(output: &str) -> Option<&str> {
    let line = output
        .lines()
        .map(str::trim)
        .find(|line| line.starts_with('"'))?;
    let rest = line.strip_prefix('"')?;
    let end = rest.find('"')?;
    let name = &rest[..end];
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

/// Kill a process AND its tree by PID alone (used to reclaim an orphan found by
/// the startup sweep, for which no `Child` handle exists).
pub fn kill_pid_tree(pid: u32) {
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = pid;
    }
}

/// Startup sweep: reclaim a `llama-server` orphaned by a prior hard-kill.
///
/// Reads the persisted PID marker; kills that PID ONLY when its live image is
/// `llama-server.exe` (the PID-reuse guard), then clears the marker. A missing
/// marker, a gone process, and a reused PID are all safe no-kill paths, so the
/// sweep can never terminate an unrelated process.
pub fn sweep_orphan(app: &AppHandle) {
    let store = app.state::<Arc<AppStore>>();
    let store: &AppStore = store.inner();
    let Some(pid) = persisted_pid(store) else {
        return;
    };
    if is_llama_server_image(process_image_name(pid).as_deref(), LLAMA_SERVER_IMAGE) {
        kill_pid_tree(pid);
    }
    // Always clear after inspection — the launch flow rewrites it on the next
    // successful launch, and a stale marker must not be re-inspected forever.
    persist_pid(store, None);
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
    kill_pid_tree(server.pid);

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
    use crate::infrastructure::storage::AppStore;
    use std::net::TcpListener;

    #[test]
    fn pid_reuse_guard_only_accepts_the_server_image() {
        // Our own server image (case- and whitespace-insensitive).
        assert!(is_llama_server_image(
            Some("llama-server.exe"),
            LLAMA_SERVER_IMAGE
        ));
        assert!(is_llama_server_image(
            Some("LLAMA-SERVER.EXE"),
            LLAMA_SERVER_IMAGE
        ));
        assert!(is_llama_server_image(
            Some("  llama-server.exe  "),
            LLAMA_SERVER_IMAGE
        ));
        // A reused PID: any other live image must NEVER be killed.
        assert!(!is_llama_server_image(Some("chrome.exe"), LLAMA_SERVER_IMAGE));
        assert!(!is_llama_server_image(
            Some("llama-server-helper.exe"),
            LLAMA_SERVER_IMAGE
        ));
        assert!(!is_llama_server_image(Some(""), LLAMA_SERVER_IMAGE));
        // A gone / unreadable process is a safe no-kill path.
        assert!(!is_llama_server_image(None, LLAMA_SERVER_IMAGE));
    }

    #[test]
    fn persist_pid_round_trips_and_clears() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = AppStore::open(dir.path().to_path_buf()).expect("open app store");

        persist_pid(&store, Some(4242));
        assert_eq!(persisted_pid(&store), Some(4242));

        persist_pid(&store, None);
        assert_eq!(persisted_pid(&store), None);

        // A blank / malformed marker is not a PID (never parsed as 0).
        let _ = store.set(
            crate::features::llm_server::LLAMA_SERVER_PID_KEY,
            "not-a-pid",
        );
        assert_eq!(persisted_pid(&store), None);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn parse_tasklist_image_name_reads_the_first_csv_field() {
        let output = "\"llama-server.exe\",\"4242\",\"Console\",\"1\",\"12,345 K\"\r\n";
        assert_eq!(
            parse_tasklist_image_name(output),
            Some("llama-server.exe")
        );
        // A no-match / info line is not an image name.
        assert_eq!(
            parse_tasklist_image_name("INFO: No tasks are running which match\r\n"),
            None
        );
        assert_eq!(parse_tasklist_image_name(""), None);
    }

    #[test]
    fn config_and_log_paths_live_under_the_companion_dir() {
        // Both helpers now take the companion DIRECTORY and join only their
        // filename — no implicit `companion` segment is re-appended, so an
        // override dir is not double-nested.
        let dir = PathBuf::from(r"C:\data\fredo\companion");
        assert_eq!(config_path(&dir), dir.join("llama-server-launch.bat"));
        assert_eq!(log_path(&dir), dir.join("llama-server.log"));
    }

    #[test]
    fn default_companion_dir_appends_the_companion_subdir() {
        let app_data = PathBuf::from(r"C:\data\fredo");
        assert_eq!(
            default_companion_dir(&app_data),
            app_data.join("companion")
        );
    }

    #[test]
    fn resolve_companion_dir_from_prefers_a_non_blank_trimmed_override() {
        let default = PathBuf::from(r"C:\data\fredo\companion");

        assert_eq!(
            resolve_companion_dir_from(
                Some(r"C:\Code\fredo\.runtime\companion\"),
                default.clone()
            ),
            PathBuf::from(r"C:\Code\fredo\.runtime\companion\")
        );
        // Surrounding whitespace is trimmed off the override.
        assert_eq!(
            resolve_companion_dir_from(Some("  C:\\runtime\\companion  "), default.clone()),
            PathBuf::from(r"C:\runtime\companion")
        );
    }

    #[test]
    fn resolve_companion_dir_from_falls_back_when_blank_or_absent() {
        let default = PathBuf::from(r"C:\data\fredo\companion");

        assert_eq!(resolve_companion_dir_from(None, default.clone()), default);
        assert_eq!(
            resolve_companion_dir_from(Some(""), default.clone()),
            default
        );
        assert_eq!(
            resolve_companion_dir_from(Some("   "), default.clone()),
            default
        );
        assert_eq!(
            resolve_companion_dir_from(Some("\t\n"), default.clone()),
            default
        );
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
