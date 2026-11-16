//! Headless `fredo ingest` descriptor (Spec #2992, CU-1/ST-1).
//!
//! The embedded PostgreSQL server binds an OS-assigned ephemeral loopback port
//! ([`super::runtime::PgRuntime`]), so a second process (the GUI) cannot discover
//! it by convention. The headless daemon publishes a small JSON descriptor next
//! to the exclusive lock (`<lock_dir>/headless-ingest.json`) carrying the owning
//! PID and the bound port; the GUI reads it after a lock conflict and attaches
//! ONLY when the descriptor is LIVE (R-3).
//!
//! Liveness is deliberately conservative ([`is_live`]): the published PID must
//! still be the `fredo.exe` daemon (a PID-reuse guard, mirroring the postmaster
//! sweep's image guard) AND a bounded TCP connect to `127.0.0.1:<port>` must
//! succeed. A missing, malformed, or stale descriptor yields `None`/`false`, so
//! the GUI keeps its fail-closed `Failed` path and never attaches to a dead
//! cluster (G-263: the probe is finite).
//!
//! # G-296 (seam semantics)
//!
//! The descriptor path is the non-blank [`FREDO_INGEST_DESCRIPTOR_ENV`] override
//! when set, else `<lock_dir>/<HEADLESS_DESCRIPTOR_FILENAME>`. A caller-supplied
//! value always wins; the default applies only when the env is unset/blank. This
//! module never mutates the process environment.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use super::{
    DEFAULT_PG_HOST, FREDO_IMAGE, FREDO_INGEST_DESCRIPTOR_ENV, HEADLESS_DESCRIPTOR_FILENAME,
};

/// Bound on the liveness TCP connect (G-263: every wait is finite). Kept small
/// because the probe runs on the GUI startup path.
pub const IS_LIVE_PROBE_BOUND: Duration = Duration::from_millis(500);

/// The published descriptor of a running headless `fredo ingest` daemon
/// (`#[serde(rename_all = "camelCase")]`: `pid`, `port`, `dataDir`, `startedAt`,
/// `exe`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadlessDescriptor {
    /// The owning daemon process id (image-guarded to `fredo.exe` by
    /// [`is_live`]).
    pub pid: u32,
    /// The bound ephemeral loopback PostgreSQL port.
    pub port: u16,
    /// The PostgreSQL data dir the daemon owns (the same dir the GUI resolves).
    pub data_dir: String,
    /// The RFC-3339 start timestamp.
    pub started_at: String,
    /// The daemon executable path.
    pub exe: String,
}

/// The descriptor path: the non-blank [`FREDO_INGEST_DESCRIPTOR_ENV`] override
/// when set, else `<lock_dir>/<HEADLESS_DESCRIPTOR_FILENAME>`. A caller-supplied
/// value wins; the default applies only when the env is unset/blank.
pub fn descriptor_path(lock_dir: &Path) -> PathBuf {
    descriptor_path_with(
        std::env::var(FREDO_INGEST_DESCRIPTOR_ENV).ok().as_deref(),
        lock_dir,
    )
}

/// The pure descriptor-path rule (unit-testable without global env state,
/// G-222).
fn descriptor_path_with(override_value: Option<&str>, lock_dir: &Path) -> PathBuf {
    match override_value {
        Some(value) if !value.trim().is_empty() => PathBuf::from(value.trim()),
        _ => lock_dir.join(HEADLESS_DESCRIPTOR_FILENAME),
    }
}

/// Atomically publish `d`: serialize, write a sibling temp file, flush it to
/// disk, then rename over the descriptor (temp + rename). Parent directories are
/// created. A reader therefore sees either the previous descriptor or the new
/// one — never a torn write.
pub fn write(lock_dir: &Path, d: &HeadlessDescriptor) -> Result<()> {
    let path = descriptor_path(lock_dir);
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create descriptor dir {}", parent.display()))?;
        }
    }
    let bytes = serde_json::to_vec_pretty(d).context("serialize headless descriptor")?;
    // A per-process temp name so a concurrent writer cannot collide.
    let temp = path.with_extension(format!("tmp{}", std::process::id()));
    {
        let mut file = std::fs::File::create(&temp)
            .with_context(|| format!("create descriptor temp {}", temp.display()))?;
        file.write_all(&bytes)
            .with_context(|| format!("write descriptor temp {}", temp.display()))?;
        file.sync_all()
            .with_context(|| format!("sync descriptor temp {}", temp.display()))?;
    }
    // `fs::rename` replaces an existing destination on Windows and Unix, so the
    // publish is atomic w.r.t. a concurrent `read`.
    std::fs::rename(&temp, &path)
        .with_context(|| format!("publish descriptor {}", path.display()))?;
    Ok(())
}

/// Read the descriptor; `None` when it is absent, unreadable, or malformed. A
/// stale/broken descriptor must never attach the GUI (R-3), so every parse
/// failure is a silent `None`.
pub fn read(lock_dir: &Path) -> Option<HeadlessDescriptor> {
    let path = descriptor_path(lock_dir);
    let bytes = std::fs::read(&path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Remove the descriptor; idempotent (a missing file is `Ok`). The daemon calls
/// this on every teardown path (R-2).
pub fn clear(lock_dir: &Path) -> Result<()> {
    let path = descriptor_path(lock_dir);
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("clear descriptor {}", path.display())),
    }
}

/// A LIVE descriptor: the owning PID is still the `fredo.exe` daemon (PID-reuse
/// guard) AND a bounded TCP connect to `127.0.0.1:<port>` succeeds. Both legs
/// are required, so neither a reused PID nor a stale port can attach the GUI.
pub fn is_live(d: &HeadlessDescriptor) -> bool {
    is_live_with(d, super::sweep::process_image_name, tcp_connect)
}

/// Test seam for [`is_live`]: the image query and the bounded connect are
/// injectable so both the PID-reuse and the reachability branches are
/// deterministic without a real daemon.
fn is_live_with<F, C>(d: &HeadlessDescriptor, image_query: F, connect: C) -> bool
where
    F: Fn(u32) -> Option<String>,
    C: Fn(&str, u16, Duration) -> bool,
{
    d.port != 0
        && is_fredo_image_name(image_query(d.pid).as_deref())
        && connect(DEFAULT_PG_HOST, d.port, IS_LIVE_PROBE_BOUND)
}

/// Pure PID-reuse guard: the live process image must be exactly `fredo.exe`
/// (case- and whitespace-insensitive). Any other / missing image is NOT live.
pub fn is_fredo_image_name(image: Option<&str>) -> bool {
    match image {
        Some(name) => {
            let name = name.trim();
            !name.is_empty() && name.eq_ignore_ascii_case(FREDO_IMAGE)
        }
        None => false,
    }
}

/// Bounded loopback TCP connect (`connect_timeout` caps the attempt; G-263). A
/// malformed host is a safe `false` (never a panic).
fn tcp_connect(host: &str, port: u16, bound: Duration) -> bool {
    let Ok(addr) = format!("{host}:{port}").parse::<std::net::SocketAddr>() else {
        return false;
    };
    std::net::TcpStream::connect_timeout(&addr, bound).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn descriptor(pid: u32, port: u16) -> HeadlessDescriptor {
        HeadlessDescriptor {
            pid,
            port,
            data_dir: "C:/data/postgres".to_string(),
            started_at: "2026-10-03T12:00:00Z".to_string(),
            exe: "C:/Program Files/Fredo/fredo.exe".to_string(),
        }
    }

    /// The descriptor is camelCase on the wire (`pid`/`port`/`dataDir`/
    /// `startedAt`/`exe`) and round-trips unchanged.
    #[test]
    fn descriptor_serializes_camel_case_round_trip() {
        let json = serde_json::to_value(descriptor(12345, 54321)).expect("serialize");
        assert_eq!(json["pid"], 12345);
        assert_eq!(json["port"], 54321);
        assert_eq!(json["dataDir"], "C:/data/postgres");
        assert_eq!(json["startedAt"], "2026-10-03T12:00:00Z");
        assert_eq!(json["exe"], "C:/Program Files/Fredo/fredo.exe");
        assert!(json.get("data_dir").is_none(), "no snake_case leakage");
        assert!(json.get("started_at").is_none(), "no snake_case leakage");

        let parsed: HeadlessDescriptor = serde_json::from_value(json).expect("deserialize");
        assert_eq!(parsed, descriptor(12345, 54321));
    }

    /// `write` publishes at `<lock_dir>/headless-ingest.json`, `read` round-trips
    /// it, and the atomic temp file is gone afterwards.
    #[test]
    fn write_then_read_round_trips_at_the_lock_dir_path() {
        let dir = tempfile::tempdir().expect("tempdir");
        let d = descriptor(4242, 54321);
        write(dir.path(), &d).expect("write");

        let path = dir.path().join(HEADLESS_DESCRIPTOR_FILENAME);
        assert!(path.exists(), "descriptor written at {}", path.display());
        assert_eq!(read(dir.path()), Some(d));

        let temp_leftover = std::fs::read_dir(dir.path())
            .expect("read_dir")
            .filter_map(|entry| entry.ok())
            .any(|entry| entry.file_name().to_string_lossy().contains("tmp"));
        assert!(!temp_leftover, "atomic write left temp files");
    }

    /// A re-publish atomically replaces the previous descriptor.
    #[test]
    fn write_replaces_an_existing_descriptor() {
        let dir = tempfile::tempdir().expect("tempdir");
        write(dir.path(), &descriptor(1, 2)).expect("first write");
        write(dir.path(), &descriptor(3, 4)).expect("second write");
        assert_eq!(read(dir.path()), Some(descriptor(3, 4)));
    }

    /// A missing or malformed descriptor reads as `None` (the GUI then keeps its
    /// fail-closed `Failed` path).
    #[test]
    fn read_is_none_when_absent_or_malformed() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert_eq!(read(dir.path()), None, "absent descriptor is None");

        std::fs::write(dir.path().join(HEADLESS_DESCRIPTOR_FILENAME), "{ not json")
            .expect("seed malformed");
        assert_eq!(read(dir.path()), None, "malformed descriptor is None");
    }

    /// `clear` removes the descriptor and is idempotent on an absent file.
    #[test]
    fn clear_removes_and_is_idempotent() {
        let dir = tempfile::tempdir().expect("tempdir");
        clear(dir.path()).expect("clear absent is Ok");
        write(dir.path(), &descriptor(1, 2)).expect("write");
        assert!(read(dir.path()).is_some());
        clear(dir.path()).expect("clear present");
        assert_eq!(read(dir.path()), None);
        clear(dir.path()).expect("clear again is Ok");
    }

    /// The descriptor path defaults under the lock dir and honours a non-blank
    /// caller override (G-296); blank is inert.
    #[test]
    fn descriptor_path_defaults_under_the_lock_dir_and_honours_override() {
        let lock_dir = Path::new("C:/locks");
        assert_eq!(
            descriptor_path_with(None, lock_dir),
            lock_dir.join(HEADLESS_DESCRIPTOR_FILENAME)
        );
        assert_eq!(
            descriptor_path_with(Some("   "), lock_dir),
            lock_dir.join(HEADLESS_DESCRIPTOR_FILENAME),
            "blank is inert"
        );
        assert_eq!(
            descriptor_path_with(Some("C:/custom/desc.json"), lock_dir),
            PathBuf::from("C:/custom/desc.json"),
            "a caller value wins"
        );
    }

    /// The image guard accepts only the exact `fredo.exe` basename.
    #[test]
    fn image_guard_accepts_only_the_exact_fredo_basename() {
        assert!(is_fredo_image_name(Some("fredo.exe")));
        assert!(is_fredo_image_name(Some("FREDO.EXE")));
        assert!(is_fredo_image_name(Some("  Fredo.Exe  ")));
        assert!(!is_fredo_image_name(Some("fredo")));
        assert!(!is_fredo_image_name(Some("fredo.exe.bak")));
        assert!(!is_fredo_image_name(Some("notfredo.exe")));
        assert!(!is_fredo_image_name(Some("postgres.exe")));
        assert!(!is_fredo_image_name(Some("")));
        assert!(!is_fredo_image_name(Some("   ")));
        assert!(!is_fredo_image_name(None));
    }

    /// `is_live` requires BOTH the `fredo.exe` image and a reachable port.
    #[test]
    fn is_live_requires_the_fredo_image_and_a_reachable_port() {
        let d = descriptor(4242, 54321);

        assert!(is_live_with(
            &d,
            |_| Some("fredo.exe".to_string()),
            |_, _, _| true
        ));
        // A reused PID (wrong image) is not live even when the port answers.
        assert!(!is_live_with(
            &d,
            |_| Some("notepad.exe".to_string()),
            |_, _, _| true
        ));
        // A stale port is not live even when the image is right.
        assert!(!is_live_with(
            &d,
            |_| Some("fredo.exe".to_string()),
            |_, _, _| false
        ));
        // A gone process is not live.
        assert!(!is_live_with(&d, |_| None, |_, _, _| true));
    }

    /// A zero port is never live and is never probed (no wasted connect).
    #[test]
    fn is_live_is_false_for_a_zero_port_without_probing() {
        let d = descriptor(4242, 0);
        let probed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let probe = probed.clone();
        assert!(!is_live_with(
            &d,
            |_| Some("fredo.exe".to_string()),
            move |_, _, _| {
                probe.store(true, std::sync::atomic::Ordering::SeqCst);
                true
            }
        ));
        assert!(
            !probed.load(std::sync::atomic::Ordering::SeqCst),
            "a zero port must not probe"
        );
    }

    /// The liveness probe is bounded at 500 ms (G-263).
    #[test]
    fn the_liveness_probe_bound_is_500ms() {
        assert_eq!(IS_LIVE_PROBE_BOUND, Duration::from_millis(500));
    }

    /// The real bounded connect returns `false` quickly for a dead loopback port
    /// and never panics on a malformed host.
    #[test]
    fn tcp_connect_is_bounded_and_false_for_a_dead_loopback_port() {
        assert!(!tcp_connect(DEFAULT_PG_HOST, 1, Duration::from_millis(50)));
        assert!(!tcp_connect("not a host", 1, Duration::from_millis(50)));
    }
}
