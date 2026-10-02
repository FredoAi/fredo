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
//! [`migration_will_run`]). This module NEVER writes the marker, changes
//! [`select_engine`] precedence, or flips the engine; it only reads.
//!
//! # Where the marker is read (read-only)
//!
//! The marker is written by the pre-install migration into the PostgreSQL
//! `settings` table (`infrastructure/storage/migration/run.rs`). It is therefore
//! read through the active [`AppStore`] data plane — PostgreSQL once the pool is
//! installed, SQLite (absent) otherwise. A read error is fail-closed to `false`.
//!
//! [`select_engine`]: crate::infrastructure::storage::engine::select_engine

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::infrastructure::storage::migration::{resolve_app_data_dir, MIGRATION_COMPLETED_KEY};
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
/// `fredo.db`) yields `false` (R-1.1/R-4.1).
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
    let migration_completed = match app.try_state::<Arc<AppStore>>() {
        Some(store) => migration_marker_present(store.inner()).await,
        None => false,
    };
    let shipped_default = decide_shipped_default(ACQUISITION_MODE, migration_completed);
    let will_run = migration_will_run(legacy_fredo_db_exists(&app), migration_completed);
    CutoverReleaseGate {
        acquisition_mode: ACQUISITION_MODE,
        migration_completed,
        migration_will_run: will_run,
        shipped_default,
        reason: decision_reason(ACQUISITION_MODE, migration_completed),
    }
}
