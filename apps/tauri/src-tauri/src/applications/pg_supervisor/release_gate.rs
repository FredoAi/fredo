//! Cutover release gate (Spec #2978, S6; REQ-7.1/REQ-7.2).
//!
//! The ONE read-only decision source slice 6 consumes: it reports the
//! compile-time [`PgAcquisitionMode`], the presence of the one-shot cutover
//! marker (`migration.postgres.completed`, [`MIGRATION_COMPLETED_KEY`]), whether
//! the one-shot leg will run this boot, and the resolved `shippedDefault`.
//!
//! # Unconditional PostgreSQL default (Spec #2979 CU-1)
//!
//! [`decide_shipped_default`] now returns [`ShippedDefault::Postgres`]
//! UNCONDITIONALLY: PostgreSQL is the shipped default regardless of the marker
//! or the acquisition mode. The marker gates ONLY the one-shot export leg (see
//! [`migration_will_run`]). This module NEVER writes the marker, changes the
//! engine selection, or flips the engine; it only reads.
//!
//! # Where the marker is read (read-only)
//!
//! The marker is written by the pre-install migration into the PostgreSQL
//! `settings` table (`infrastructure/storage/migration/run.rs`). It is therefore
//! read through the active [`AppStore`] data plane — PostgreSQL once the pool is
//! installed; absent otherwise. A read error is fail-closed to `false`.

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::infrastructure::storage::boot_config::resolve_app_data_dir;
use crate::infrastructure::storage::migration::{MIGRATION_COMPLETED_KEY, ROLLBACK_VERIFIED_KEY};
use crate::infrastructure::storage::AppStore;

use super::acquisition::{PgAcquisitionMode, ACQUISITION_MODE};

/// The engine the shipped build defaults to. Serialized camelCase
/// (`postgres`).
///
/// Since Spec #2979 CU-1 the shipped default is UNCONDITIONALLY PostgreSQL, so
/// the historical `Sqlite` variant was removed (no dead code).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ShippedDefault {
    /// PostgreSQL — the unconditional shipped default since Spec #2979 CU-1.
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
    /// Whether the one-shot cutover leg will run on this boot
    /// (`fredo.db exists && !migration_completed`).
    pub migration_will_run: bool,
    /// Whether the production backout has been verified
    /// (`rollback.verified == "true"`, Spec #2979 CU-4 / R-2.2). Read-only:
    /// written only by `verify_rollback`.
    pub rollback_verified: bool,
    /// The resolved shipped default (unconditionally PostgreSQL since CU-1).
    pub shipped_default: ShippedDefault,
    /// Human-readable explanation of the decision.
    pub reason: String,
}

/// The ONE decision rule slice 6 consumes.
///
/// Spec #2979 CU-1: the shipped default is UNCONDITIONALLY PostgreSQL. The
/// acquisition mode and the cutover marker are reported by the gate but do NOT
/// select the engine — the marker gates only the one-shot export leg.
pub fn decide_shipped_default(_mode: PgAcquisitionMode, _migration_completed: bool) -> ShippedDefault {
    ShippedDefault::Postgres
}

/// Whether the one-shot cutover leg will run on this boot (Spec #2979 CU-1):
/// a legacy `fredo.db` exists AND the marker is absent. A fresh install (no
/// `fredo.db`) yields `false` (R-1.1/R-4.1) — the leg reports
/// `MigrationStatus::Fresh` and PostgreSQL installs normally.
pub fn migration_will_run(fredo_db_exists: bool, migration_completed: bool) -> bool {
    fredo_db_exists && !migration_completed
}

/// The human-readable decision reason (names the unconditional default, the
/// acquisition mode, and the marker posture so the gate is self-explanatory).
fn decision_reason(mode: PgAcquisitionMode, migration_completed: bool) -> String {
    let marker = if migration_completed {
        "present"
    } else {
        "absent"
    };
    format!(
        "shipped default is unconditionally postgres ({mode:?} acquisition, {MIGRATION_COMPLETED_KEY} {marker})"
    )
}

/// Read-only marker probe over the active store: `true` only when
/// `migration.postgres.completed` is present. A missing store or a read error is
/// fail-closed to `false` (SQLite).
async fn migration_marker_present(store: &AppStore) -> bool {
    matches!(store.get(MIGRATION_COMPLETED_KEY).await, Ok(Some(_)))
}

/// Read-only rollback-verification probe over the active store (Spec #2979
/// CU-4, R-2.2): `true` only when `rollback.verified` is exactly `"true"`. A
/// missing store or a read error is fail-closed to `false`.
async fn rollback_verification_present(store: &AppStore) -> bool {
    matches!(
        store.get(ROLLBACK_VERIFIED_KEY).await,
        Ok(Some(value)) if value == "true"
    )
}

/// Whether the legacy source `<app_data_dir>/fredo.db` exists (Spec #2979 CU-1).
/// Uses the SAME app-data-dir resolver as the migration leg, so the reported
/// `migrationWillRun` can never diverge from the leg's source.
fn legacy_fredo_db_exists(app: &AppHandle) -> bool {
    app.path()
        .app_data_dir()
        .ok()
        .map(|os_dir| resolve_app_data_dir(&os_dir).join("fredo.db").exists())
        .unwrap_or(false)
}

/// The read-only cutover release gate command (REQ-7.1). Registered in `lib.rs`.
#[tauri::command]
pub async fn cutover_release_gate(app: AppHandle) -> CutoverReleaseGate {
    let (migration_completed, rollback_verified) = match app.try_state::<Arc<AppStore>>() {
        Some(store) => (
            migration_marker_present(store.inner()).await,
            rollback_verification_present(store.inner()).await,
        ),
        None => (false, false),
    };
    let shipped_default = decide_shipped_default(ACQUISITION_MODE, migration_completed);
    let will_run = migration_will_run(legacy_fredo_db_exists(&app), migration_completed);
    CutoverReleaseGate {
        acquisition_mode: ACQUISITION_MODE,
        migration_completed,
        migration_will_run: will_run,
        rollback_verified,
        shipped_default,
        reason: decision_reason(ACQUISITION_MODE, migration_completed),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// CU-1: the shipped default is unconditionally PostgreSQL — for BOTH
    /// acquisition modes, with and without the marker.
    #[test]
    fn decide_shipped_default_is_unconditionally_postgres() {
        for mode in [
            PgAcquisitionMode::RuntimeDownload,
            PgAcquisitionMode::Bundled,
        ] {
            for completed in [false, true] {
                assert_eq!(
                    decide_shipped_default(mode, completed),
                    ShippedDefault::Postgres,
                    "mode {mode:?} / marker {completed} must default to postgres"
                );
            }
        }
    }

    /// CU-1: `migrationWillRun = fredo.db exists && !migration_completed`.
    #[test]
    fn migration_will_run_requires_a_source_and_no_marker() {
        assert!(
            !migration_will_run(false, false),
            "a fresh install (no fredo.db) runs no leg"
        );
        assert!(
            migration_will_run(true, false),
            "an upgraded install runs the one-shot leg"
        );
        assert!(
            !migration_will_run(true, true),
            "the marker skips the leg on every subsequent startup"
        );
        assert!(!migration_will_run(false, true));
    }

    /// The reason names the unconditional default and the marker posture.
    #[test]
    fn decision_reason_names_the_unconditional_default_and_marker() {
        let absent = decision_reason(PgAcquisitionMode::RuntimeDownload, false);
        assert!(absent.contains("unconditionally postgres"), "{absent}");
        assert!(absent.contains(MIGRATION_COMPLETED_KEY), "{absent}");
        assert!(absent.contains("absent"), "{absent}");

        let present = decision_reason(PgAcquisitionMode::Bundled, true);
        assert!(present.contains("unconditionally postgres"), "{present}");
        assert!(present.contains("present"), "{present}");
    }

    /// The gate serializes camelCase and the enums use their declared values.
    #[test]
    fn gate_serializes_camel_case() {
        let gate = CutoverReleaseGate {
            acquisition_mode: PgAcquisitionMode::RuntimeDownload,
            migration_completed: false,
            migration_will_run: true,
            rollback_verified: true,
            shipped_default: ShippedDefault::Postgres,
            reason: "test".to_string(),
        };
        let json = serde_json::to_value(&gate).expect("serialize");
        assert_eq!(json["acquisitionMode"], "runtimeDownload");
        assert_eq!(json["migrationCompleted"], false);
        assert_eq!(json["migrationWillRun"], true);
        assert_eq!(json["rollbackVerified"], true);
        assert_eq!(json["shippedDefault"], "postgres");
        assert_eq!(json["reason"], "test");

        assert_eq!(
            serde_json::to_value(ShippedDefault::Postgres).expect("serialize"),
            "postgres"
        );
    }
}
