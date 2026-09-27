//! Embedded-PostgreSQL lifecycle supervisor (Spec #2974).
//!
//! Slice 1 of the mandated SQLite → embedded-PostgreSQL migration. This module
//! owns the **bounded** managed-server lifecycle — nothing here migrates a store;
//! persistence is unchanged while PostgreSQL is disabled (the default).
//!
//! The module is a **feature** module (not `infrastructure/`) per AGENTS.md
//! ("state belongs in the feature module") and the direct precedent of
//! `features/llm_server/{state,process,commands}.rs` — the mechanism is ported,
//! never imported (no cross-feature imports).
//!
//! # G-263 SAFETY — the named failure mode
//!
//! The named failure mode is #2948's `pg.stop()` that blocked for **~11 h** when
//! `Settings::timeout` was left `None`. The owning bound is closed in
//! [`runtime`]: every control/start/readiness/stop wait carries a finite
//! wall-clock timeout, [`runtime::PgRuntime::stop_bounded`] falls back to
//! `taskkill /PID <pid> /T /F` on graceful-stop expiry, and teardown is
//! guaranteed on normal return, error return, and panic unwind (RAII `Drop`).
//! `Settings::timeout` is ALWAYS `Some(PG_CONTROL_TIMEOUT)`, never `None`.
//!
//! # Module tree
//!
//! `ST-1` creates this root and [`runtime`]; `ST-2` appends `sweep`/`lock`;
//! `ST-3` appends `state` and wires `lib.rs` (the `requires:` chain sequences
//! the shared-root appends so they are never concurrent). With the `lib.rs`
//! wiring in place the module is live, so it carries NO `#![allow(dead_code)]`
//! (AGENTS.md forbids a permanent suppression).

use std::path::{Path, PathBuf};
use std::time::Duration;

// ── AppStore `settings` KV keys (AppStore remains the single source of truth) ──

/// Engine-enabled flag: `"true"` enables the managed server; absent means
/// disabled (the default, so persistence is unchanged).
pub const PG_ENABLED_KEY: &str = "postgres.enabled";
/// PID marker for the managed postmaster (decimal; blank = cleared).
pub const PG_PID_KEY: &str = "postgres_pid";
/// Loopback-only cluster password (generated on first start).
pub const PG_PASSWORD_KEY: &str = "postgres.password";

// ── Paths ─────────────────────────────────────────────────────────────────────

/// Image name the managed postmaster must report for the PID-reuse guard to
/// treat a persisted PID as OUR server.
pub const POSTGRES_IMAGE: &str = "postgres.exe";
/// Data-directory subdirectory under the app data dir (`{app_data_dir}/postgres`).
pub const PG_DATA_SUBDIR: &str = "postgres";
/// Distribution-directory subdirectory under the app data dir.
pub const PG_INSTALL_SUBDIR: &str = "postgres-install";
/// Exclusive data-dir lock filename under the app data dir.
pub const PG_LOCK_FILENAME: &str = "postgres.lock";
/// Ephemeral loopback bind host (never `0.0.0.0`).
pub const DEFAULT_PG_HOST: &str = "127.0.0.1";

// ── Test hooks (Spec #2974 fix round: inert when unset — default behaviour is
//    byte-identical to the slice-1 path) ───────────────────────────────────────

/// **FS-1** test hook: when set (non-blank) the managed PostgreSQL data dir is
/// this path instead of `<app_data_dir>/<PG_DATA_SUBDIR>`. The distribution
/// (install) dir and the `<app_data_dir>/postgres.lock` file are deliberately
/// NOT overridable, so the existing download is reused (no network) and the
/// exclusive lock keeps its stable location. Inert when unset.
pub const PG_DATA_DIR_ENV: &str = "FREDO_PG_DATA_DIR";
/// **FS-3** test hook: when set to a positive millisecond count the graceful
/// stop sleeps that long (capped at [`PG_CONTROL_TIMEOUT`]) before calling the
/// real `pg.stop()`, so the bounded hard-kill watchdog in
/// [`runtime::PgRuntime::stop_bounded`] is observable on a live quit. The hang
/// is finitely bounded by that same watchdog (G-263). Inert when unset.
pub const PG_STOP_HANG_ENV: &str = "FREDO_PG_STOP_HANG_MS";
/// **FS-4** injectable fault seam (Spec #2975 ST-2): when set (non-blank) the
/// shared PostgreSQL pool build is forced to fail at a named stage (`connect` |
/// `schemaInit`; `1`/`true` => `connect`), so the fail-closed SQLite fallback is
/// observable WITHOUT corrupting a real data dir (G-275). The value is parsed by
/// [`crate::infrastructure::storage::engine::PgPoolStage::parse`]. Inert when
/// unset — the default build is byte-identical to the un-forced path.
pub const PG_POOL_FORCE_FAIL_ENV: &str = "FREDO_PG_POOL_FORCE_FAIL";

/// Resolve the managed data dir (**FS-1**): the non-blank [`PG_DATA_DIR_ENV`]
/// override when set, else `<app_data_dir>/<PG_DATA_SUBDIR>`. One shared rule so
/// the sweep, the [`runtime::PgRuntime`] settings, and the reported `data_dir`
/// can never diverge.
pub fn resolve_data_dir(app_data_dir: &Path) -> PathBuf {
    match std::env::var(PG_DATA_DIR_ENV) {
        Ok(value) if !value.trim().is_empty() => PathBuf::from(value.trim()),
        _ => app_data_dir.join(PG_DATA_SUBDIR),
    }
}

/// The **FS-3** stop-hang duration, capped at [`PG_CONTROL_TIMEOUT`]; `None` when
/// [`PG_STOP_HANG_ENV`] is unset, blank, unparseable, or zero — so the default
/// path is unchanged.
pub fn stop_hang_duration() -> Option<Duration> {
    let millis: u64 = std::env::var(PG_STOP_HANG_ENV).ok()?.trim().parse().ok()?;
    (millis > 0).then(|| Duration::from_millis(millis).min(PG_CONTROL_TIMEOUT))
}

// ── Server memory knobs (Spec #2975 ST-2, REQ-5/EARS-5.1) ─────────────────────

/// Server-memory knobs appended to `<data_dir>/postgresql.conf` after `setup()`
/// and before `start()` (ST-2), then verified live via `SHOW` (ST-7/QA).
/// `max_connections = 8` matches the pool-sizing band (`PG_POOL_MAX_CONNECTIONS`);
/// `synchronous_commit = off` replaces SQLite's `PRAGMA synchronous=NORMAL`
/// (store-migration.md §3); the memory sizes are the desktop profile.
pub const PG_SERVER_KNOBS: &[(&str, &str)] = &[
    ("shared_buffers", "32MB"),
    ("work_mem", "4MB"),
    ("maintenance_work_mem", "32MB"),
    ("max_connections", "8"),
    ("synchronous_commit", "off"),
];

// ── Wall-clock bounds (G-263: every wait is finite; the #2948 `None` is banned) ─

/// Bounds every `pg_ctl`-driven control command (download / initdb / start /
/// stop). MUST be assigned to `Settings::timeout` as `Some(...)`, never `None`.
pub const PG_CONTROL_TIMEOUT: Duration = Duration::from_secs(180);
/// Bound around `PostgreSQL::setup()` (first run may download the archive).
pub const PG_SETUP_BOUND: Duration = Duration::from_secs(600);
/// Bound around `PostgreSQL::start()`.
pub const PG_START_BOUND: Duration = Duration::from_secs(180);
/// Readiness poll bound (spawn → first successful real-client connect).
pub const PG_READY_BOUND: Duration = Duration::from_secs(60);
/// Per-attempt TCP connect timeout for the readiness probe.
pub const PG_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Bound around the graceful `PostgreSQL::stop()` (the measured ~11 h hang).
pub const PG_STOP_BOUND: Duration = Duration::from_secs(30);
/// Bound the `RunEvent::Exit` hook will allow the graceful stop before hard-kill.
pub const PG_EXIT_HOOK_BOUND: Duration = Duration::from_secs(5);
/// Upper bound on how long to wait for a killed PID tree to disappear.
pub const PG_DEATH_WAIT_BOUND: Duration = Duration::from_secs(20);

pub mod runtime; // ST-1
pub mod sweep; // ST-2
pub mod lock; // ST-2
pub mod state; // ST-3

// The supervisor entry points live in `state`; re-export the two `lib.rs`
// wiring functions at the module root so `lib.rs` reads
// `features::pg_supervisor::{start_supervisor, stop_on_exit}`. The rest of the
// public contract (`PgState`, `PgStatusView`, `PgSupervisorState`, `await_ready`,
// `pg_supervisor_status`) is reached through `state::`.
pub use state::{start_supervisor, stop_on_exit};
