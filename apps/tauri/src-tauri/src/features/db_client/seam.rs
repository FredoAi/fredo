//! db_client induction seams (Spec #2950, ST-1; G-275).
//!
//! Mirrors the shipped `pg_supervisor` precedent (`FREDO_PG_POOL_FORCE_FAIL` /
//! `FREDO_PG_DATA_DIR`, `features/pg_supervisor/mod.rs`): a named failure stage
//! and a writable state-dir override, **both inert when unset** so the default
//! path is byte-identical to production.
//!
//! * [`DBCLIENT_FORCE_FAIL_ENV`] — `connect | auth | timeout | query`. ST-2
//!   consumes `connect`/`auth`/`timeout`; ST-4 consumes `timeout`/`query` and
//!   the connection-lost leg. When unset/blank/unknown the seam is inert.
//! * [`DBCLIENT_STATE_DIR_ENV`] — the writable directory test fixtures (error
//!   configs, sentinels) are read from. Defaults to
//!   [`DEFAULT_DBCLIENT_STATE_DIR`] (`.opencode/tmp/2950/dbclient/`).

use std::path::PathBuf;

/// Failure-injection env var (`connect|auth|timeout|query`; inert when unset).
pub const DBCLIENT_FORCE_FAIL_ENV: &str = "FREDO_DBCLIENT_FORCE_FAIL";
/// Writable state-dir override env var (inert in production).
pub const DBCLIENT_STATE_DIR_ENV: &str = "FREDO_DBCLIENT_STATE_DIR";
/// Default state dir used when [`DBCLIENT_STATE_DIR_ENV`] is unset/blank.
pub const DEFAULT_DBCLIENT_STATE_DIR: &str = ".opencode/tmp/2950/dbclient";

/// The named stage a forced failure is injected at.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ForceFailStage {
    /// The TCP/handshake connect is forced to fail (`unreachable`).
    Connect,
    /// The credential exchange is forced to fail (`auth`).
    Auth,
    /// The bounded connect/query wait is forced to time out (`timeout`).
    Timeout,
    /// Query execution is forced to fail (`query`).
    Query,
}

impl ForceFailStage {
    /// The wire/env token for this stage.
    pub fn as_str(self) -> &'static str {
        match self {
            ForceFailStage::Connect => "connect",
            ForceFailStage::Auth => "auth",
            ForceFailStage::Timeout => "timeout",
            ForceFailStage::Query => "query",
        }
    }
}

/// Parse a [`DBCLIENT_FORCE_FAIL_ENV`] value. Returns `None` (inert) for
/// blank/unknown input. `1`/`true` map to [`ForceFailStage::Connect`], mirroring
/// the `pg_supervisor` FS-4 seam.
pub fn parse_force_fail(value: &str) -> Option<ForceFailStage> {
    match value.trim().to_ascii_lowercase().as_str() {
        "connect" => Some(ForceFailStage::Connect),
        "auth" => Some(ForceFailStage::Auth),
        "timeout" => Some(ForceFailStage::Timeout),
        "query" => Some(ForceFailStage::Query),
        "1" | "true" => Some(ForceFailStage::Connect),
        _ => None,
    }
}

/// Resolve the active forced-failure stage from the environment. Inert
/// (`None`) when the env var is unset, blank, or unrecognised.
pub fn force_fail_stage() -> Option<ForceFailStage> {
    let raw = std::env::var(DBCLIENT_FORCE_FAIL_ENV).ok()?;
    parse_force_fail(&raw)
}

/// Resolve the state dir from an explicit override value. ONE shared rule so
/// the state holder and any future reader can never diverge: a non-blank
/// override wins, otherwise the default.
pub fn resolve_state_dir(override_value: Option<&str>) -> PathBuf {
    match override_value {
        Some(value) if !value.trim().is_empty() => PathBuf::from(value.trim()),
        _ => PathBuf::from(DEFAULT_DBCLIENT_STATE_DIR),
    }
}

/// Resolve the active state dir from [`DBCLIENT_STATE_DIR_ENV`].
pub fn state_dir() -> PathBuf {
    let override_value = std::env::var(DBCLIENT_STATE_DIR_ENV).ok();
    resolve_state_dir(override_value.as_deref())
}
