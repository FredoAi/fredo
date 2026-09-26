//! Process-tree peak working-set sampler.
//!
//! The spike must report memory footprint as the peak working set of the
//! harness process tree **including the Postgres child processes**. Windows
//! reparents an orphaned `pg_ctl`-spawned postmaster, so walking the parent
//! chain alone is unreliable; when a name-prefix filter is supplied we sum
//! every matching process (in a clean measurement sandbox that is exactly the
//! one PostgreSQL instance we started). Without a filter we sum our own
//! process plus its descendants.

use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use sysinfo::{Pid, System};

/// Spawn a background thread that polls until `stop` is set and returns the
/// peak total working set (bytes) of this process tree.
pub fn spawn_peak_sampler(
    stop: Arc<AtomicBool>,
    name_prefixes: Vec<String>,
) -> Arc<AtomicU64> {
    spawn_peak_sampler_for(std::process::id(), stop, name_prefixes)
}

/// Same as [`spawn_peak_sampler`] but for an arbitrary root process id (used by
/// `measure` to observe a benchmark child and its Postgres descendants).
pub fn spawn_peak_sampler_for(
    root_pid: u32,
    stop: Arc<AtomicBool>,
    name_prefixes: Vec<String>,
) -> Arc<AtomicU64> {
    let peak = Arc::new(AtomicU64::new(0));
    let peak_thread = Arc::clone(&peak);
    std::thread::spawn(move || {
        let mut sys = System::new_all();
        while !stop.load(Ordering::Relaxed) {
            sys.refresh_all();
            let mut total: u64 = 0;
            if let Some(p) = sys.process(Pid::from_u32(root_pid)) {
                total += p.memory();
                if name_prefixes.is_empty() {
                    total += descendants_memory(&sys, root_pid);
                }
            }
            if !name_prefixes.is_empty() {
                for p in sys.processes().values() {
                    let name = p.name().to_string_lossy().to_lowercase();
                    if name_prefixes.iter().any(|prefix| name.starts_with(prefix.as_str())) {
                        total += p.memory();
                    }
                }
            }
            peak_thread.fetch_max(total, Ordering::Relaxed);
            std::thread::sleep(Duration::from_millis(25));
        }
    });
    peak
}

fn descendants_memory(sys: &System, root: u32) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![root];
    while let Some(pid) = stack.pop() {
        for (&child_pid, proc_info) in sys.processes() {
            if proc_info.parent().map(|p| p.as_u32()) == Some(pid) {
                total += proc_info.memory();
                stack.push(child_pid.as_u32());
            }
        }
    }
    total
}

/// Recursively sum the byte size of every file under `path`.
pub fn dir_size(path: &Path) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let p = entry.path();
            match entry.file_type() {
                Ok(ft) if ft.is_dir() => stack.push(p),
                Ok(ft) if ft.is_file() => {
                    if let Ok(meta) = entry.metadata() {
                        total += meta.len();
                    }
                }
                _ => {}
            }
        }
    }
    total
}

/// RFC3339 UTC timestamp of "now".
pub fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}
