//! Startup PID-marker bookkeeping + the image-guarded orphan sweep
//! (Spec #2974, ST-2).
//!
//! The `RunEvent::Exit` hook cannot run on a hard-kill (Task Manager / power
//! loss), so a managed `postgres.exe` can outlive Fredo. The start flow persists
//! its postmaster PID into the AppStore marker (`postgres_pid`); on the next
//! startup we inspect that PID and reclaim it — but ONLY after confirming the
//! live image is `postgres.exe`, so an OS-reused PID (or a wiped data dir with a
//! stale marker) is never killed (R-3.1/R-3.2/R-4.4).
//!
//! The marker is ALWAYS cleared when the sweep completes (R-3.3). A second
//! backstop reads the crate-owned `<data_dir>/postmaster.pid` to cover the
//! spawn-to-marker-write window, under the same image guard (R-3.4).
//!
//! The mechanism is PORTED from `features/llm_server/process.rs` (ST-7) — no
//! cross-feature import (AGENTS.md). The kill primitive is ST-1's
//! [`super::runtime::kill_pid_tree`], reused rather than duplicated.
//!
//! # G-263 SAFETY
//!
//! Every process query here is a single bounded `tasklist` invocation; the kill
//! is a single bounded `taskkill /T /F`. The sweep performs no unbounded wait —
//! a dead PID is detected by `tasklist` reporting no match and handled without
//! blocking.

use std::path::Path;

use crate::infrastructure::storage::AppStore;

use super::runtime::{kill_pid_tree, read_postmaster_pid, KillTreeFn};
use super::{PG_PID_KEY, POSTGRES_IMAGE};

/// Persist the managed postmaster PID marker; `None` clears it.
///
/// The [`AppStore`] **control plane** (`control.db`, Spec #2979 CU-1) is the
/// single source of truth for the marker — this helper owns the key so the write
/// and clear paths can never drift. A failed write is ignored: the marker is
/// best-effort recovery metadata, never load-bearing state.
pub fn persist_pid(store: &AppStore, pid: Option<u32>) {
    let value = pid.map(|pid| pid.to_string()).unwrap_or_default();
    let _ = store.control_set(PG_PID_KEY, &value);
}

/// Read the persisted postmaster PID marker (blank / malformed => `None`).
pub fn persisted_pid(store: &AppStore) -> Option<u32> {
    store
        .control_get(PG_PID_KEY)
        .ok()
        .flatten()
        .and_then(|value| value.trim().parse().ok())
}

/// Pure PID-reuse guard: a persisted PID may be swept ONLY when the live process
/// image is exactly the `postgres.exe` basename (case- and
/// whitespace-insensitive). A reused PID (any other image), an empty name, or an
/// unreadable/gone image is NEVER killed.
pub fn is_postgres_image_name(image: Option<&str>) -> bool {
    match image {
        Some(name) => {
            let name = name.trim();
            !name.is_empty() && name.eq_ignore_ascii_case(POSTGRES_IMAGE)
        }
        None => false,
    }
}

/// The OS-reported image name for `pid`, or `None` when the process is gone or
/// unreadable. Windows queries `tasklist`; other platforms return `None` (this
/// Windows-first slice has no cross-platform process observer).
pub fn process_image_name(pid: u32) -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        use std::process::{Command, Stdio};
        let output = Command::new("tasklist")
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

/// Startup sweep of the AppStore PID marker.
///
/// Reads the persisted PID; kills that PID ONLY when its live image is
/// `postgres.exe` (the PID-reuse guard), then clears the marker UNCONDITIONALLY
/// (R-3.3). A missing marker, a gone process, a malformed marker, and a reused
/// PID are all safe no-kill paths, so the sweep can never terminate an unrelated
/// process (R-3.2/R-4.4). Returns the reclaimed PID when a kill was performed.
pub fn sweep_orphan(store: &AppStore) -> Option<u32> {
    sweep_orphan_with(store, process_image_name, kill_pid_tree)
}

/// Test seam for [`sweep_orphan`]: the image query and kill primitive are
/// injectable so the no-kill / kill paths are deterministic without a real
/// `postgres.exe`.
fn sweep_orphan_with<F>(store: &AppStore, image_query: F, kill: KillTreeFn) -> Option<u32>
where
    F: Fn(u32) -> Option<String>,
{
    let mut reclaimed = None;
    if let Some(pid) = persisted_pid(store) {
        if is_postgres_image_name(image_query(pid).as_deref()) {
            kill(pid);
            reclaimed = Some(pid);
        }
    }
    persist_pid(store, None);
    reclaimed
}

/// Data-dir backstop: reclaim the postmaster named by `<data_dir>/postmaster.pid`
/// under the same `postgres.exe` image guard (R-3.4). Covers the window between
/// the crate writing `postmaster.pid` and Fredo persisting the KV marker.
/// Returns the reclaimed PID when a kill was performed.
pub fn sweep_postmaster_pid_file(data_dir: &Path) -> Option<u32> {
    sweep_postmaster_pid_file_with(data_dir, process_image_name, kill_pid_tree)
}

/// Test seam for [`sweep_postmaster_pid_file`].
fn sweep_postmaster_pid_file_with<F>(
    data_dir: &Path,
    image_query: F,
    kill: KillTreeFn,
) -> Option<u32>
where
    F: Fn(u32) -> Option<String>,
{
    let pid = read_postmaster_pid(data_dir)?;
    if is_postgres_image_name(image_query(pid).as_deref()) {
        kill(pid);
        Some(pid)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
        use crate::infrastructure::storage::engine::{EngineHandle, SqliteEngine, StoreEngine};
        let sqlite = SqliteEngine::open(&dir.join("fredo.db")).expect("open sqlite engine");
        AppStore::open(EngineHandle::new(StoreEngine::Sqlite(sqlite))).expect("open app store")
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
    fn the_pid_marker_lives_on_the_control_plane() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = open_store(dir.path());
        persist_pid(&store, Some(777));
        assert!(
            dir.path()
                .join(crate::infrastructure::storage::CONTROL_DB_FILENAME)
                .exists(),
            "the postmaster PID marker must live on control.db (CU-1)"
        );
        assert_eq!(persisted_pid(&store), Some(777));
    }

    #[test]
    fn blank_or_malformed_marker_is_none() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = open_store(dir.path());

        for raw in ["", "   ", "not-a-pid", "12abc", "-1", "0x10"] {
            store.control_set(PG_PID_KEY, raw).expect("seed marker");
            assert_eq!(
                persisted_pid(&store),
                None,
                "marker {raw:?} must not parse as a PID"
            );
        }
    }

    #[test]
    fn image_guard_accepts_only_the_exact_postgres_basename() {
        assert!(is_postgres_image_name(Some("postgres.exe")));
        assert!(is_postgres_image_name(Some("POSTGRES.EXE")));
        assert!(is_postgres_image_name(Some("  Postgres.Exe  ")));
        // Any other / partial / prefixed name is a reused-PID no-kill.
        assert!(!is_postgres_image_name(Some("postgresql.exe")));
        assert!(!is_postgres_image_name(Some("postgres")));
        assert!(!is_postgres_image_name(Some("postgres.exe.bak")));
        assert!(!is_postgres_image_name(Some("notpostgres.exe")));
        assert!(!is_postgres_image_name(Some("")));
        assert!(!is_postgres_image_name(Some("   ")));
        assert!(!is_postgres_image_name(None));
    }

    #[test]
    fn sweep_orphan_kills_an_image_guarded_postgres_and_always_clears() {
        let _guard = KILL_LOCK.lock().expect("serialize recorder tests");
        clear_kills();
        let dir = tempfile::tempdir().expect("tempdir");
        let store = open_store(dir.path());
        persist_pid(&store, Some(4242));

        let reclaimed = sweep_orphan_with(&store, |_| Some(POSTGRES_IMAGE.to_string()), record_kill);

        assert_eq!(reclaimed, Some(4242));
        assert_eq!(recorded_kills(), vec![4242]);
        assert_eq!(persisted_pid(&store), None, "the marker is always cleared");
    }

    #[test]
    fn sweep_orphan_never_kills_a_gone_or_reused_pid_and_still_clears() {
        let _guard = KILL_LOCK.lock().expect("serialize recorder tests");
        clear_kills();
        let dir = tempfile::tempdir().expect("tempdir");
        let store = open_store(dir.path());

        // Gone: the image query reports no process.
        persist_pid(&store, Some(4_000_000));
        assert_eq!(sweep_orphan_with(&store, |_| None, record_kill), None);

        // Reused by an unrelated process.
        persist_pid(&store, Some(31337));
        assert_eq!(
            sweep_orphan_with(&store, |_| Some("notepad.exe".to_string()), record_kill),
            None
        );

        assert!(
            recorded_kills().is_empty(),
            "a gone/reused PID is never killed"
        );
        assert_eq!(persisted_pid(&store), None, "the marker is always cleared");
    }

    #[test]
    fn sweep_orphan_clears_a_malformed_marker_without_killing() {
        let _guard = KILL_LOCK.lock().expect("serialize recorder tests");
        clear_kills();
        let dir = tempfile::tempdir().expect("tempdir");
        let store = open_store(dir.path());
        store.control_set(PG_PID_KEY, "not-a-pid").expect("seed marker");

        let reclaimed =
            sweep_orphan_with(&store, |_| Some(POSTGRES_IMAGE.to_string()), record_kill);

        assert_eq!(reclaimed, None);
        assert!(recorded_kills().is_empty());
        assert_eq!(persisted_pid(&store), None);
    }

    #[test]
    fn own_pid_with_a_non_postgres_image_is_never_killed() {
        let _guard = KILL_LOCK.lock().expect("serialize recorder tests");
        clear_kills();
        let dir = tempfile::tempdir().expect("tempdir");
        let store = open_store(dir.path());
        let own = std::process::id();
        persist_pid(&store, Some(own));

        // Sanity: if the test binary itself were named `postgres.exe` this pin
        // could not distinguish a correct no-kill from a self-kill.
        if is_postgres_image_name(process_image_name(own).as_deref()) {
            return;
        }

        let reclaimed = sweep_orphan_with(&store, process_image_name, record_kill);

        assert_eq!(reclaimed, None, "our own test process is not postgres.exe");
        assert!(
            recorded_kills().is_empty(),
            "the sweep must never kill a non-postgres.exe image"
        );
        assert_eq!(persisted_pid(&store), None, "the marker is still cleared");
        #[cfg(target_os = "windows")]
        assert!(
            process_image_name(own).is_some(),
            "the non-postgres process must have survived the sweep"
        );
    }

    #[test]
    fn wiped_data_dir_with_a_stale_marker_never_kills_an_unrelated_process() {
        let _guard = KILL_LOCK.lock().expect("serialize recorder tests");
        clear_kills();
        let dir = tempfile::tempdir().expect("tempdir");
        let store = open_store(dir.path());
        persist_pid(&store, Some(20_000_000));

        // Wiped data dir: no `postmaster.pid` for the backstop to lean on.
        assert!(!dir
            .path()
            .join(super::super::PG_DATA_SUBDIR)
            .join("postmaster.pid")
            .exists());
        let reclaimed = sweep_orphan_with(&store, |_| Some("unrelated.exe".to_string()), record_kill);

        assert_eq!(reclaimed, None);
        assert!(recorded_kills().is_empty());
        assert_eq!(persisted_pid(&store), None);
    }

    #[test]
    fn postmaster_pid_file_backstop_respects_the_image_guard() {
        let _guard = KILL_LOCK.lock().expect("serialize recorder tests");
        clear_kills();
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join("postmaster.pid"), "5150\n").expect("write postmaster.pid");

        // Image-guarded reclaim.
        let reclaimed = sweep_postmaster_pid_file_with(
            dir.path(),
            |_| Some(POSTGRES_IMAGE.to_string()),
            record_kill,
        );
        assert_eq!(reclaimed, Some(5150));
        assert_eq!(recorded_kills(), vec![5150]);

        // A reused image is a safe no-kill path.
        clear_kills();
        let reclaimed = sweep_postmaster_pid_file_with(
            dir.path(),
            |_| Some("chrome.exe".to_string()),
            record_kill,
        );
        assert_eq!(reclaimed, None);
        assert!(recorded_kills().is_empty());
    }

    #[test]
    fn postmaster_pid_file_backstop_is_none_when_absent_or_malformed() {
        let dir = tempfile::tempdir().expect("tempdir");

        // Absent.
        assert_eq!(
            sweep_postmaster_pid_file_with(
                dir.path(),
                |_| Some(POSTGRES_IMAGE.to_string()),
                record_kill
            ),
            None
        );

        // Malformed first line.
        std::fs::write(dir.path().join("postmaster.pid"), "not-a-pid\n").expect("write pid file");
        assert_eq!(
            sweep_postmaster_pid_file_with(
                dir.path(),
                |_| Some(POSTGRES_IMAGE.to_string()),
                record_kill
            ),
            None
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn parse_tasklist_image_name_reads_the_first_csv_field() {
        let output = "\"postgres.exe\",\"4242\",\"Console\",\"1\",\"12,345 K\"\r\n";
        assert_eq!(parse_tasklist_image_name(output), Some("postgres.exe"));
        // A no-match / info line is not an image name.
        assert_eq!(
            parse_tasklist_image_name("INFO: No tasks are running which match\r\n"),
            None
        );
        assert_eq!(parse_tasklist_image_name(""), None);
    }
}
