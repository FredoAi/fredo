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
//!
//! Packaging slice #2978 appends: [`acquisition`] (S1/S2/S3 — build-time mode +
//! SHA-pinned archive), the Q-17 postmaster-log configuration in [`runtime`] and
//! the bounded log tail in [`state`] (S4), and [`release_gate`] (S6 — the
//! read-only cutover decision source slice 6 consumes).

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
/// Log subdirectory under the PostgreSQL data dir (`<data_dir>/log`). The
/// postmaster's logging collector is pointed here through the crate's
/// `Settings::configuration` hook (Spec #2978 S4 / Q-17), so this is the ONE
/// directory [`state::pg_server_log_tail`] reads.
pub const PG_LOG_SUBDIR: &str = "log";
/// Postmaster log filename (`<data_dir>/log/postgres.log`); fixed by the
/// `log_filename` server configuration so the tail path is deterministic.
pub const PG_LOG_FILENAME: &str = "postgres.log";
/// Ephemeral loopback bind host (never `0.0.0.0`).
pub const DEFAULT_PG_HOST: &str = "127.0.0.1";

// ── Test hooks (Spec #2974 fix round: inert when unset — default behaviour is
//    byte-identical to the slice-1 path) ───────────────────────────────────────

/// **FS-1** test hook: when set (non-blank) the managed PostgreSQL data dir is
/// this path instead of `<app_data_dir>/<PG_DATA_SUBDIR>`. The distribution
/// (install) dir has its own override ([`PG_INSTALL_DIR_ENV`]); the
/// `<app_data_dir>/postgres.lock` file stays deliberately NOT overridable, so the
/// exclusive lock keeps its stable location. Inert when unset.
pub const PG_DATA_DIR_ENV: &str = "FREDO_PG_DATA_DIR";
/// **G-275** induction seam (Spec #2978 S2): when set (non-blank) the managed
/// PostgreSQL distribution/installation dir is this path instead of
/// `<app_data_dir>/<PG_INSTALL_SUBDIR>`. Both the [`runtime::PgRuntime`] install
/// dir and the [`acquisition`] archive staging dir resolve through
/// [`resolve_install_dir`], so the override can never make them diverge. Inert
/// when unset — the default path is byte-identical.
pub const PG_INSTALL_DIR_ENV: &str = "FREDO_PG_INSTALL_DIR";
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
/// **FS-5** test hook (Spec #2975 ST-7, AC5): when set to a non-blank,
/// non-`0`/`false` value the managed PostgreSQL server is started WITHOUT the
/// [`PG_SERVER_KNOBS`] overlay, so the **untuned** baseline (the AC5 "before"
/// leg) is live-drivable in-repo (G-275). [`runtime::PgRuntime::apply_server_knobs`]
/// becomes a no-op; the server runs on the `initdb` defaults. Inert when unset —
/// the default path appends the overlay byte-identically.
///
/// NOTE: the overlay is guarded by `PG_KNOB_MARKER` idempotence, so an
/// already-knobbed data dir is NOT un-knobbed. A FRESH `FREDO_PG_DATA_DIR`
/// (initdb defaults) is required for the "before" measurement.
pub const PG_SKIP_SERVER_KNOBS_ENV: &str = "FREDO_PG_SKIP_SERVER_KNOBS";

/// Resolve the **FS-5** untuned-baseline lever (mirrors [`stop_hang_duration`]):
/// `true` when [`PG_SKIP_SERVER_KNOBS_ENV`] is set to a non-blank value other
/// than `0`/`false`, else `false`. One shared rule so `apply_server_knobs` and
/// any future status/telemetry read agree; inert by default.
pub fn skip_server_knobs() -> bool {
    match std::env::var(PG_SKIP_SERVER_KNOBS_ENV) {
        Ok(value) => {
            let raw = value.trim();
            !raw.is_empty() && !raw.eq_ignore_ascii_case("0") && !raw.eq_ignore_ascii_case("false")
        }
        Err(_) => false,
    }
}

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

/// Resolve the managed distribution/installation dir (Spec #2978 S2): the
/// non-blank [`PG_INSTALL_DIR_ENV`] override when set, else
/// `<app_data_dir>/<PG_INSTALL_SUBDIR>`. ONE shared rule so [`runtime::PgRuntime`]
/// and [`acquisition::acquire_pg_archive`] can never diverge.
pub fn resolve_install_dir(app_data_dir: &Path) -> PathBuf {
    match std::env::var(PG_INSTALL_DIR_ENV) {
        Ok(value) if !value.trim().is_empty() => PathBuf::from(value.trim()),
        _ => app_data_dir.join(PG_INSTALL_SUBDIR),
    }
}

/// `<data_dir>/log/postgres.log` — the ONE path rule for the postmaster log,
/// shared by the crate settings that create it ([`runtime::PgRuntime`]) and the
/// read-only tail ([`state::pg_server_log_tail`]), so the writer and the reader
/// can never diverge.
pub fn pg_log_path(data_dir: &Path) -> PathBuf {
    data_dir.join(PG_LOG_SUBDIR).join(PG_LOG_FILENAME)
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

pub mod acquisition; // S1/S2/S3 (#2978): acquisition mode + pinned archive
pub mod release_gate; // S6 (#2978): cutover release gate
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
