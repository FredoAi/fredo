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
//!   configs, sentinels) are read from. In production the default is
//!   `<app_data_dir>/dbclient` (resolved at startup and passed to
//!   [`crate::features::db_client::state::DbClientState::from_env`]); the
//!   repo-relative [`DEFAULT_DBCLIENT_STATE_DIR`] remains only as the inert
//!   test fallback. The env override always wins.

use std::path::{Path, PathBuf};

/// Failure-injection env var (`connect|auth|timeout|query`; inert when unset).
pub const DBCLIENT_FORCE_FAIL_ENV: &str = "FREDO_DBCLIENT_FORCE_FAIL";
/// Writable state-dir override env var (inert in production).
pub const DBCLIENT_STATE_DIR_ENV: &str = "FREDO_DBCLIENT_STATE_DIR";
/// Repo-relative state dir used only as the inert fallback (tests / `Default`).
pub const DEFAULT_DBCLIENT_STATE_DIR: &str = ".opencode/tmp/2950/dbclient";
/// Production subdirectory under the Tauri app-data dir (`<app_data_dir>/dbclient`).
pub const DBCLIENT_APP_SUBDIR: &str = "dbclient";

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

/// Resolve the state dir rooted at the Tauri app-data dir. A non-blank
/// [`DBCLIENT_STATE_DIR_ENV`] override wins (test fixtures); otherwise the
/// production default `<app_data_dir>/dbclient`. This is the resolver the app
/// uses at startup — [`resolve_state_dir`] is retained only as the inert
/// repo-relative fallback.
pub fn resolve_state_dir_in(override_value: Option<&str>, app_data_dir: &Path) -> PathBuf {
    match override_value {
        Some(value) if !value.trim().is_empty() => PathBuf::from(value.trim()),
        _ => app_data_dir.join(DBCLIENT_APP_SUBDIR),
    }
}

/// Resolve the active state dir from [`DBCLIENT_STATE_DIR_ENV`], rooted at
/// `app_data_dir` in production.
pub fn state_dir_in(app_data_dir: &Path) -> PathBuf {
    let override_value = std::env::var(DBCLIENT_STATE_DIR_ENV).ok();
    resolve_state_dir_in(override_value.as_deref(), app_data_dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_data_default_is_used_only_when_the_override_is_blank() {
        let app_data = Path::new("C:/app-data");
        assert_eq!(
            resolve_state_dir_in(None, app_data),
            PathBuf::from("C:/app-data/dbclient")
        );
        assert_eq!(
            resolve_state_dir_in(Some(""), app_data),
            PathBuf::from("C:/app-data/dbclient")
        );
        assert_eq!(
            resolve_state_dir_in(Some("  "), app_data),
            PathBuf::from("C:/app-data/dbclient")
        );
        // A non-blank override always wins (test fixtures).
        assert_eq!(
            resolve_state_dir_in(Some(" C:/tmp/dbclient "), app_data),
            PathBuf::from("C:/tmp/dbclient")
        );
    }
}
