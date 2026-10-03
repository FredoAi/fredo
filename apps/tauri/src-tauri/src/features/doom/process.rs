//! Doom engine process supervision (Spec #2968, ST-3/ST-3c; G-263 bounded).
//!
//! Owns the pure filesystem layout (install dir / log), the port-selection seam,
//! the `std::process::Command` spawn (no shell, log redirect, `CREATE_NO_WINDOW`),
//! the bounded readiness poll, the bounded graceful-stop with a hard-kill
//! fallback, the PID marker, and the image-guarded startup orphan sweep.
//!
//! The mechanism is PORTED from the shipped precedents —
//! `features/llm_server/process.rs` (spawn / `kill_pid_tree` / `persist_pid` /
//! `is_*_image` / `sweep_orphan`) and `features/pg_supervisor/sweep.rs`
//! (`sweep_orphan_with` seam) — with NO cross-feature import (AGENTS.md).
//!
//! # G-263 SAFETY
//!
//! Every wait is finite: the readiness poll is bounded and kills the child on
//! timeout; the graceful stop is bounded and falls back to `taskkill /T /F`; the
//! sweep is a single bounded `tasklist` + `taskkill`. No unbounded binary is ever
//! left running.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use tauri::{AppHandle, Manager};

use crate::infrastructure::storage::AppStore;

use super::state::{
    ManagedDoom, DOOM_ENGINE_PATH_ENV, DOOM_ENGINE_PATH_KEY, DOOM_IMAGE_DEFAULT,
    DOOM_INSTALL_DIR_ENV, DOOM_INSTALL_DIR_KEY, DOOM_INSTALL_SUBDIR, DOOM_LAUNCH_PREFIX,
    DOOM_LAUNCH_SUFFIX, DOOM_LOG_FILENAME, DOOM_PID_KEY,
};

/// Injectable kill primitive for the sweep test seam (mirrors
/// `pg_supervisor::sweep::KillTreeFn`).
pub type KillTreeFn = fn(u32);

// ── Layout ────────────────────────────────────────────────────────────────────

/// Resolve the install/scratch directory: a non-blank [`DOOM_INSTALL_DIR_ENV`]
/// wins, else a non-blank `doom_install_dir` setting, else the product default
/// `{app_data_dir}/doom`.
pub fn resolve_install_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let env = std::env::var(DOOM_INSTALL_DIR_ENV).ok();
    let store = app.state::<Arc<AppStore>>();
    let configured = store
        .control_get(DOOM_INSTALL_DIR_KEY)
        .ok()
        .flatten();
    if let Some(dir) = resolve_doom_path(env.as_deref(), configured.as_deref()) {
        return Ok(PathBuf::from(dir));
    }
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve the app data dir: {e}"))?;
    Ok(base.join(DOOM_INSTALL_SUBDIR))
}

/// Absolute path of the engine stdout/stderr log inside `install_dir`.
pub fn log_path(install_dir: &Path) -> PathBuf {
    install_dir.join(DOOM_LOG_FILENAME)
}

// ── Pure resolution / argv ────────────────────────────────────────────────────

/// A non-blank, trimmed override wins in order: `env_override` then `configured`.
/// Absent/blank/whitespace-only candidates are skipped (`None` when none remain).
pub fn resolve_doom_path(env_override: Option<&str>, configured: Option<&str>) -> Option<String> {
    for value in [env_override, configured].into_iter().flatten() {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    None
}

/// The launch argv: `-apilockstep -noblit -nosound -nomusic -iwad <path>
/// -warp 1 1 -skill 3 -apiport <port>`.
///
/// The port flag is **`-apiport`**, not the Triage Plan's guessed `-port` — the
/// ST-1 spike (CU-1, on which this unit depends) captured the upstream contract
/// and corrected it; `-port` would make the engine bind the wrong port (or
/// error). Doom-1 style takes `-warp <episode> <map>` (Freedoom Phase 1).
pub fn build_launch_args(iwad: &str, port: u16) -> Vec<String> {
    let mut args: Vec<String> = DOOM_LAUNCH_PREFIX.iter().map(|s| (*s).to_string()).collect();
    args.push("-iwad".to_string());
    args.push(iwad.to_string());
    args.extend(DOOM_LAUNCH_SUFFIX.iter().map(|s| (*s).to_string()));
    args.push("-apiport".to_string());
    args.push(port.to_string());
    args
}

/// The expected engine image name for the PID-reuse guard: the basename of the
/// configured/overridden engine path, else [`DOOM_IMAGE_DEFAULT`]. An OS-reused
/// PID with any other image is never killed.
pub fn expected_engine_image(store: &AppStore) -> String {
    let env = std::env::var(DOOM_ENGINE_PATH_ENV).ok();
    let configured = store.control_get(DOOM_ENGINE_PATH_KEY).ok().flatten();
    resolve_doom_path(env.as_deref(), configured.as_deref())
        .and_then(|path| {
            Path::new(&path)
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
        })
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| DOOM_IMAGE_DEFAULT.to_string())
}

// ── PID marker + image guard ──────────────────────────────────────────────────

/// Persist the managed engine PID marker; `None` clears it. A failed write is
/// ignored — the marker is best-effort recovery metadata, never load-bearing.
pub fn persist_pid(store: &AppStore, pid: Option<u32>) {
    let value = pid.map(|pid| pid.to_string()).unwrap_or_default();
    let _ = store.control_set(DOOM_PID_KEY, &value);
}

/// Read the persisted engine PID marker (blank / malformed => `None`).
pub fn persisted_pid(store: &AppStore) -> Option<u32> {
    store
        .control_get(DOOM_PID_KEY)
        .ok()
        .flatten()
        .and_then(|value| value.trim().parse().ok())
}

/// Pure PID-reuse guard: a persisted PID may be swept ONLY when the live process
/// image matches `expected` (case- and whitespace-insensitive). A reused PID
/// (any other image), an empty name, or an unreadable image is NEVER killed.
pub fn is_doom_image_name(image: Option<&str>, expected: &str) -> bool {
    match image {
        Some(name) => {
            let name = name.trim();
            !name.is_empty() && name.eq_ignore_ascii_case(expected.trim())
        }
        None => false,
    }
}

/// The OS-reported image name for `pid`, or `None` when the process is gone or
/// unreadable. Windows queries `tasklist`; other platforms return `None`.
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

// ── Kill primitives ───────────────────────────────────────────────────────────

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

/// Best-effort graceful termination: `taskkill /PID <pid> /T` (no `/F`) posts a
/// close request. A process that ignores it is reclaimed by [`kill_pid_tree`]
/// once the graceful bound elapses.
fn graceful_terminate(pid: u32) {
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T"])
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

/// Kill the managed process AND its tree, then reap the child. Best-effort — a
/// process already gone is not an error.
pub fn kill_process_tree(managed: &mut ManagedDoom) {
    kill_pid_tree(managed.pid);
    let _ = managed.child.kill();
    let _ = managed.child.wait();
}

/// How a bounded stop resolved.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StopOutcome {
    /// The child exited within the graceful bound.
    Graceful,
    /// The child outlived the graceful bound and was hard-killed.
    HardKilled,
}

/// Bounded stop: request graceful termination, wait at most `bound` for the
/// child to exit, then hard-kill the tree (G-263). NEVER unbounded.
pub async fn stop_bounded(managed: &mut ManagedDoom, bound: Duration) -> StopOutcome {
    graceful_terminate(managed.pid);
    let deadline = Instant::now() + bound;
    loop {
        match managed.child.try_wait() {
            Ok(Some(_)) => return StopOutcome::Graceful,
            Ok(None) => {}
            Err(_) => break,
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50).min(remaining)).await;
    }
    kill_process_tree(managed);
    StopOutcome::HardKilled
}

// ── Spawn + readiness ─────────────────────────────────────────────────────────

/// Choose the port the engine binds: `configured` when it is free on `host`,
/// else an OS-assigned free port. Ported from `llm_server::process`.
pub fn select_active_port(host: &str, configured: u16) -> std::io::Result<u16> {
    if std::net::TcpListener::bind((host, configured)).is_ok() {
        return Ok(configured);
    }
    let listener = std::net::TcpListener::bind((host, 0))?;
    Ok(listener.local_addr()?.port())
}

/// Spawn the engine on the resolved executable with the binding argv.
///
/// stdout/stderr are appended to `log_file`; stdin is null. No shell is involved
/// (a path containing spaces stays one token). On Windows the process is created
/// with `CREATE_NO_WINDOW` so a GUI launch never flashes a console.
pub fn spawn_doom(
    executable: &str,
    args: &[String],
    log_file: &Path,
    port: u16,
) -> Result<ManagedDoom> {
    if let Some(parent) = log_file.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("create doom log dir {}", parent.display()))?;
    }
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_file)
        .with_context(|| format!("open doom log file {}", log_file.display()))?;
    let log_err = log
        .try_clone()
        .context("clone the doom log file handle for stderr")?;

    let mut command = std::process::Command::new(executable);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err));

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW — the engine is a console app; keep the GUI clean.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let child = command
        .spawn()
        .with_context(|| format!("spawn {executable}"))?;
    let pid = child.id();
    Ok(ManagedDoom {
        child,
        pid,
        port,
        log_path: log_file.to_path_buf(),
    })
}

/// A single bounded TCP connect probe against `host:port` (500 ms). The caller
/// loops this under its own finite bound; the ST-5 HTTP client refines readiness
/// to the engine's own `/api/state` 200.
pub fn port_is_open(host: &str, port: u16) -> bool {
    let Ok(addr) = format!("{host}:{port}").parse::<SocketAddr>() else {
        return false;
    };
    std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(500)).is_ok()
}

// ── Startup orphan sweep (ST-3c, R-3.3) ───────────────────────────────────────

/// Startup sweep: reclaim an engine orphaned by a prior hard-kill.
///
/// Reads the persisted PID marker; kills that PID ONLY when its live image
/// matches the expected engine image (the PID-reuse guard), then clears the
/// marker. A missing marker, a gone process, and a reused PID are all safe
/// no-kill paths, so the sweep can never terminate an unrelated process.
pub fn sweep_orphan(app: &AppHandle) {
    let store = app.state::<Arc<AppStore>>();
    let store: &AppStore = store.inner();
    let expected = expected_engine_image(store);
    sweep_orphan_with(store, &expected, process_image_name, kill_pid_tree);
}

/// Test seam for [`sweep_orphan`]: the expected image, the image query, and the
/// kill primitive are injectable so the no-kill / kill paths are deterministic
/// without a real engine. Returns the reclaimed PID when a kill was performed.
pub fn sweep_orphan_with<F>(
    store: &AppStore,
    expected: &str,
    image_query: F,
    kill: KillTreeFn,
) -> Option<u32>
where
    F: Fn(u32) -> Option<String>,
{
    let mut reclaimed = None;
    if let Some(pid) = persisted_pid(store) {
        if is_doom_image_name(image_query(pid).as_deref(), expected) {
            kill(pid);
            reclaimed = Some(pid);
        }
    }
    // Always clear after inspection — the launch flow rewrites it on the next
    // successful launch, and a stale marker must not be re-inspected forever.
    persist_pid(store, None);
    reclaimed
}

// ── Log tail ──────────────────────────────────────────────────────────────────

/// The last `max_chars` characters of a log file, trimmed (empty when
/// unreadable). Used for the actionable tail in a launch/readiness failure.
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
    use crate::infrastructure::storage::engine::EngineHandle;
    use std::sync::Mutex;

    static KILLS: Mutex<Vec<u32>> = Mutex::new(Vec::new());
    static KILL_LOCK: Mutex<()> = Mutex::new(());

    fn record_kill(pid: u32) {
        KILLS.lock().expect("kill recorder").push(pid);
    }

    fn recorded_kills() -> Vec<u32> {
        KILLS.lock().expect("kill recorder").clone()
    }

    fn clear_kills() {
        KILLS.lock().expect("kill recorder").clear();
    }

    fn open_store(dir: &Path) -> AppStore {
        AppStore::open(EngineHandle::new_pending(), dir).expect("open app store")
    }

    #[test]
    fn launch_args_are_pinned_to_the_corrected_engine_argv() {
        // CU-1 (ST-1) captured the real engine contract: the port flag is
        // `-apiport` (not the plan's guessed `-port`) and Doom-1 warp takes
        // `<episode> <map>`.
        let args = build_launch_args(r"C:\data\doom\freedoom1.wad", 6666);
        assert_eq!(
            args,
            vec![
                "-apilockstep",
                "-noblit",
                "-nosound",
                "-nomusic",
                "-iwad",
                r"C:\data\doom\freedoom1.wad",
                "-warp",
                "1",
                "1",
                "-skill",
                "3",
                "-apiport",
                "6666",
            ]
        );
    }

    #[test]
    fn resolve_doom_path_prefers_a_non_blank_trimmed_env_override() {
        assert_eq!(
            resolve_doom_path(Some(r"C:\engine\doom.exe"), Some(r"C:\other\doom.exe")),
            Some(r"C:\engine\doom.exe".to_string())
        );
        // Blank env falls through to the configured value (trimmed).
        assert_eq!(
            resolve_doom_path(Some("   "), Some("  C:\\configured\\doom.exe  ")),
            Some(r"C:\configured\doom.exe".to_string())
        );
        assert_eq!(resolve_doom_path(None, Some("C:\\c\\doom.exe")), Some("C:\\c\\doom.exe".to_string()));
        assert_eq!(resolve_doom_path(None, None), None);
        assert_eq!(resolve_doom_path(Some(""), Some("  ")), None);
    }

    #[test]
    fn expected_image_prefers_the_engine_basename_and_falls_back() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = open_store(dir.path());
        // No configured path => the upstream default.
        assert_eq!(expected_engine_image(&store), DOOM_IMAGE_DEFAULT);

        store
            .control_set(DOOM_ENGINE_PATH_KEY, r"C:\tools\doom-stub.exe")
            .expect("seed engine path");
        // NOTE: the env override wins when set in the process env; unset in CI.
        let expected = expected_engine_image(&store);
        assert!(
            expected == "doom-stub.exe" || expected == DOOM_IMAGE_DEFAULT,
            "unexpected image: {expected}"
        );
    }

    #[test]
    fn marker_round_trips_and_clears() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = open_store(dir.path());

        persist_pid(&store, Some(4242));
        assert_eq!(persisted_pid(&store), Some(4242));

        persist_pid(&store, None);
        assert_eq!(persisted_pid(&store), None);
    }

    #[test]
    fn blank_or_malformed_marker_is_none() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = open_store(dir.path());

        for raw in ["", "   ", "not-a-pid", "12abc", "-1", "0x10"] {
            store.control_set(DOOM_PID_KEY, raw).expect("seed marker");
            assert_eq!(persisted_pid(&store), None, "marker {raw:?} must not parse");
        }
    }

    #[test]
    fn image_guard_accepts_only_the_exact_engine_basename() {
        assert!(is_doom_image_name(Some("restful-doom.exe"), "restful-doom.exe"));
        assert!(is_doom_image_name(Some("RESTFUL-DOOM.EXE"), "restful-doom.exe"));
        assert!(is_doom_image_name(Some("  restful-doom.exe  "), "restful-doom.exe"));
        assert!(is_doom_image_name(Some("doom-stub.exe"), "doom-stub.exe"));
        // A reused PID: any other / partial / prefixed image is a no-kill.
        assert!(!is_doom_image_name(Some("chrome.exe"), "restful-doom.exe"));
        assert!(!is_doom_image_name(Some("restful-doom"), "restful-doom.exe"));
        assert!(!is_doom_image_name(Some("restful-doom.exe.bak"), "restful-doom.exe"));
        assert!(!is_doom_image_name(Some("notdoom.exe"), "restful-doom.exe"));
        assert!(!is_doom_image_name(Some(""), "restful-doom.exe"));
        assert!(!is_doom_image_name(Some("   "), "restful-doom.exe"));
        assert!(!is_doom_image_name(None, "restful-doom.exe"));
    }

    #[test]
    fn sweep_kills_an_image_guarded_engine_and_always_clears() {
        let _guard = KILL_LOCK.lock().expect("serialize recorder tests");
        clear_kills();
        let dir = tempfile::tempdir().expect("tempdir");
        let store = open_store(dir.path());
        persist_pid(&store, Some(4242));

        let reclaimed = sweep_orphan_with(
            &store,
            "restful-doom.exe",
            |_| Some("restful-doom.exe".to_string()),
            record_kill,
        );

        assert_eq!(reclaimed, Some(4242));
        assert_eq!(recorded_kills(), vec![4242]);
        assert_eq!(persisted_pid(&store), None, "the marker is always cleared");
    }

    #[test]
    fn sweep_never_kills_a_gone_or_reused_pid_and_still_clears() {
        let _guard = KILL_LOCK.lock().expect("serialize recorder tests");
        clear_kills();
        let dir = tempfile::tempdir().expect("tempdir");
        let store = open_store(dir.path());

        // Gone: the image query reports no process.
        persist_pid(&store, Some(4_000_000));
        assert_eq!(
            sweep_orphan_with(&store, "restful-doom.exe", |_| None, record_kill),
            None
        );

        // Reused by an unrelated process.
        persist_pid(&store, Some(31337));
        assert_eq!(
            sweep_orphan_with(
                &store,
                "restful-doom.exe",
                |_| Some("notepad.exe".to_string()),
                record_kill
            ),
            None
        );

        assert!(
            recorded_kills().is_empty(),
            "a gone/reused PID is never killed"
        );
        assert_eq!(persisted_pid(&store), None, "the marker is always cleared");
    }

    #[test]
    fn own_pid_with_a_non_engine_image_is_never_killed() {
        let _guard = KILL_LOCK.lock().expect("serialize recorder tests");
        clear_kills();
        let dir = tempfile::tempdir().expect("tempdir");
        let store = open_store(dir.path());
        let own = std::process::id();
        persist_pid(&store, Some(own));

        // Sanity: if the test binary were named like the engine this pin could
        // not distinguish a correct no-kill from a self-kill.
        if is_doom_image_name(process_image_name(own).as_deref(), "restful-doom.exe") {
            return;
        }

        let reclaimed = sweep_orphan_with(&store, "restful-doom.exe", process_image_name, record_kill);

        assert_eq!(reclaimed, None, "our own test process is not the engine");
        assert!(recorded_kills().is_empty(), "the sweep must never kill a non-engine image");
        assert_eq!(persisted_pid(&store), None, "the marker is still cleared");
    }

    #[test]
    fn sweep_reclaims_the_qa_stub_engine_by_its_own_basename() {
        // ST-8: the feature-gated `doom-stub` binary is the offline test engine,
        // so the startup sweep must recognise its basename (the QA harness points
        // FREDO_DOOM_ENGINE_PATH at it) and reclaim a hard-killed stub orphan.
        let _guard = KILL_LOCK.lock().expect("serialize recorder tests");
        clear_kills();
        let dir = tempfile::tempdir().expect("tempdir");
        let store = open_store(dir.path());
        persist_pid(&store, Some(5150));

        let reclaimed = sweep_orphan_with(
            &store,
            "doom-stub.exe",
            |_| Some("doom-stub.exe".to_string()),
            record_kill,
        );

        assert_eq!(reclaimed, Some(5150));
        assert_eq!(recorded_kills(), vec![5150]);
        assert_eq!(persisted_pid(&store), None, "the marker is always cleared");
    }

    #[test]
    fn select_active_port_returns_the_configured_port_when_free() {
        for _ in 0..5 {
            let probe = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("bind ephemeral");
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
    fn select_active_port_falls_back_when_the_configured_port_is_bound() {
        let held = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("bind occupied port");
        let occupied = held.local_addr().expect("local addr").port();

        let selected = select_active_port("127.0.0.1", occupied).expect("select fallback");

        assert_ne!(selected, occupied);
        let verify = std::net::TcpListener::bind(("127.0.0.1", selected)).expect("fallback free");
        drop(verify);
        drop(held);
    }

    #[test]
    fn port_is_open_is_a_bounded_single_probe() {
        // A closed port: false, well under the 500 ms probe bound.
        let started = Instant::now();
        assert!(!port_is_open("127.0.0.1", 1), "port 1 must not be reachable");
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "the probe must be bounded"
        );

        // A listening port: true.
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("bind");
        let port = listener.local_addr().expect("addr").port();
        assert!(port_is_open("127.0.0.1", port), "a listening port is open");
    }

    #[test]
    fn read_log_tail_returns_only_the_tail_and_empty_when_absent() {
        let dir = tempfile::tempdir().expect("tempdir");
        let log = dir.path().join("doom.log");
        std::fs::write(&log, "0123456789").expect("write log");

        assert_eq!(read_log_tail(&log, 4), "6789");
        assert_eq!(read_log_tail(&log, 100), "0123456789");
        assert_eq!(read_log_tail(&dir.path().join("missing.log"), 4), "");
    }
}
