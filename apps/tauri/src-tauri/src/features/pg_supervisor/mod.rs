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
//! the shared-root appends so they are never concurrent).
//!
//! # Why `allow(dead_code)` is scoped to this module root
//!
//! This slice declares the module's complete bounded-lifecycle contract (the
//! AppStore keys, path constants, and wall-clock bounds) and [`runtime`]'s API
//! for `ST-2`/`ST-3` to consume. `lib.rs` is owned by `ST-3` and is deliberately
//! untouched here, so until that wiring lands NOTHING in the crate references
//! these items and rustc reports every one as dead code. This is the same
//! staged-feature situation already handled the same way in sibling modules
//! (`features/setup/mod.rs`, `features/terminal/mod.rs`,
//! `features/settings/mod.rs`, `runtime/capability.rs`). The attribute is
//! removed by `ST-3` when its `lib.rs` wiring makes the module live.
#![allow(dead_code)]

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
