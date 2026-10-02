//! Cutover release gate (Spec #2978, S6; REQ-7.1/REQ-7.2).
//!
//! The ONE read-only decision source slice 6 consumes: it reports the
//! compile-time [`PgAcquisitionMode`] and the presence of the one-shot cutover
//! marker (`migration.postgres.completed`, [`MIGRATION_COMPLETED_KEY`]), and
//! resolves the `shippedDefault`.
//!
//! # Fail-closed rule (no engine flip here)
//!
//! [`decide_shipped_default`] returns [`ShippedDefault::Postgres`] ONLY when the
//! cutover marker is present; while it is absent the default stays
//! [`ShippedDefault::Sqlite`]. A `bundled` build cannot flip without the marker
//! either — the acquisition mode prices the flip but never selects the engine.
//! This module NEVER writes the marker, changes [`select_engine`] precedence, or
//! flips the engine; it only reads.
//!
//! # Where the marker is read (read-only)
//!
//! The marker is written by the pre-install migration into the PostgreSQL
//! `settings` table (`infrastructure/storage/migration/run.rs`). It is therefore
//! read through the active [`AppStore`] data plane — PostgreSQL once the pool is
//! installed, SQLite (absent) otherwise. A read error is fail-closed to SQLite.
//!
//! [`select_engine`]: crate::infrastructure::storage::engine::select_engine

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::infrastructure::storage::migration::MIGRATION_COMPLETED_KEY;
use crate::infrastructure::storage::AppStore;

use super::acquisition::{PgAcquisitionMode, ACQUISITION_MODE};

/// The engine the shipped build should default to. Serialized camelCase
/// (`sqlite` / `postgres`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ShippedDefault {
    /// Persistence stays on SQLite (the fail-closed default).
    Sqlite,
    /// The cutover marker is present; slice 6 may default to PostgreSQL.
    Postgres,
}

/// Read-only snapshot of the cutover release gate
/// (`#[serde(rename_all = "camelCase")]`).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CutoverReleaseGate {
    /// The compile-time acquisition mode ([`ACQUISITION_MODE`]).
    pub acquisition_mode: PgAcquisitionMode,
    /// Whether the `migration.postgres.completed` marker is present.
    pub migration_completed: bool,
    /// The resolved shipped default (fail-closed to SQLite).
    pub shipped_default: ShippedDefault,
    /// Human-readable explanation of the decision.
    pub reason: String,
}

/// The ONE decision rule slice 6 consumes.
///
/// SQLite unless the cutover marker is present; fail-closed while it is absent.
/// The acquisition mode is part of the gate's report but does NOT itself select
/// PostgreSQL — a `bundled` build still requires the marker (Q-1 is an open
/// product input and is never assumed here).
pub fn decide_shipped_default(_mode: PgAcquisitionMode, migration_completed: bool) -> ShippedDefault {
    if migration_completed {
        ShippedDefault::Postgres
    } else {
        ShippedDefault::Sqlite
    }
}

/// The human-readable decision reason (names the marker and the fail-closed
/// posture so the gate is self-explanatory).
fn decision_reason(mode: PgAcquisitionMode, migration_completed: bool) -> String {
    match (migration_completed, mode) {
        (true, _) => format!(
            "{} is present; shipped default flips to postgres",
            MIGRATION_COMPLETED_KEY
        ),
        (false, PgAcquisitionMode::Bundled) => format!(
            "{} is absent; fail-closed to sqlite (bundled acquisition cannot flip without the marker)",
            MIGRATION_COMPLETED_KEY
        ),
        (false, PgAcquisitionMode::RuntimeDownload) => format!(
            "{} is absent; fail-closed to sqlite",
            MIGRATION_COMPLETED_KEY
        ),
    }
}

/// Read-only marker probe over the active store: `true` only when
/// `migration.postgres.completed` is present. A missing store or a read error is
/// fail-closed to `false` (SQLite).
async fn migration_marker_present(store: &AppStore) -> bool {
    matches!(store.get(MIGRATION_COMPLETED_KEY).await, Ok(Some(_)))
}

/// The read-only cutover release gate command (REQ-7.1). Registered in `lib.rs`.
#[tauri::command]
pub async fn cutover_release_gate(app: AppHandle) -> CutoverReleaseGate {
    let migration_completed = match app.try_state::<Arc<AppStore>>() {
        Some(store) => migration_marker_present(store.inner()).await,
        None => false,
    };
    let shipped_default = decide_shipped_default(ACQUISITION_MODE, migration_completed);
    CutoverReleaseGate {
        acquisition_mode: ACQUISITION_MODE,
        migration_completed,
        shipped_default,
        reason: decision_reason(ACQUISITION_MODE, migration_completed),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// REQ-7.2: while the marker is absent the default stays SQLite — for BOTH
    /// acquisition modes (a `bundled` build cannot flip without the marker).
    #[test]
    fn decide_shipped_default_is_fail_closed_without_the_marker() {
        assert_eq!(
            decide_shipped_default(PgAcquisitionMode::RuntimeDownload, false),
            ShippedDefault::Sqlite
        );
        assert_eq!(
            decide_shipped_default(PgAcquisitionMode::Bundled, false),
            ShippedDefault::Sqlite
        );
    }

    /// REQ-7.1: the default flips to PostgreSQL only once the marker is present.
    #[test]
    fn decide_shipped_default_flips_only_with_the_marker() {
        assert_eq!(
            decide_shipped_default(PgAcquisitionMode::RuntimeDownload, true),
            ShippedDefault::Postgres
        );
        assert_eq!(
            decide_shipped_default(PgAcquisitionMode::Bundled, true),
            ShippedDefault::Postgres
        );
    }

    /// The reason names the marker and the fail-closed posture.
    #[test]
    fn decision_reason_names_the_marker() {
        assert!(
            decision_reason(PgAcquisitionMode::RuntimeDownload, false)
                .contains(MIGRATION_COMPLETED_KEY)
        );
        assert!(
            decision_reason(PgAcquisitionMode::Bundled, false).contains("fail-closed"),
            "a bundled build must be explicitly fail-closed without the marker"
        );
        assert!(
            decision_reason(PgAcquisitionMode::RuntimeDownload, true).contains("flips to postgres")
        );
    }

    /// The read-only probe is fail-closed: absent ⇒ false; present ⇒ true.
    /// Exercised against the always-available SQLite store (the marker's
    /// authoritative location is PostgreSQL; this pins the read rule).
    #[tokio::test]
    async fn migration_marker_present_is_fail_closed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = AppStore::open_sqlite_for_tests(dir.path().to_path_buf())
            .expect("open sqlite store");

        assert!(
            !migration_marker_present(&store).await,
            "an absent marker must read as false"
        );
        store
            .set(MIGRATION_COMPLETED_KEY, "2026-10-01T00:00:00Z")
            .await
            .expect("seed the marker");
        assert!(
            migration_marker_present(&store).await,
            "a present marker must read as true"
        );
    }

    /// The gate serializes camelCase and the enums use their declared values.
    #[test]
    fn gate_serializes_camel_case() {
        let gate = CutoverReleaseGate {
            acquisition_mode: PgAcquisitionMode::RuntimeDownload,
            migration_completed: false,
            shipped_default: ShippedDefault::Sqlite,
            reason: "test".to_string(),
        };
        let json = serde_json::to_value(&gate).expect("serialize");
        assert_eq!(json["acquisitionMode"], "runtimeDownload");
        assert_eq!(json["migrationCompleted"], false);
        assert_eq!(json["shippedDefault"], "sqlite");
        assert_eq!(json["reason"], "test");

        assert_eq!(
            serde_json::to_value(ShippedDefault::Postgres).expect("serialize"),
            "postgres"
        );
    }
}
