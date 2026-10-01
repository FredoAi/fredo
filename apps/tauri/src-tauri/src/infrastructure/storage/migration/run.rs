//! The pre-install entry point + the read-only status hook (ST-4 core half).
//!
//! [`run_pre_install`] is called by the supervisor BETWEEN
//! `run_pg_schema_inits` and `install_postgres`, against the **candidate** pool.
//! It is fail-closed: any error (or the whole-leg [`MIGRATION_BOUND`] timeout)
//! returns `Err` having written no marker, so the caller installs nothing and
//! the app stays on SQLite (R-2.2/R-2.3).
//!
//! Ordering contract:
//! 1. read the completion marker from the candidate pool — present ⇒ `Skipped`;
//! 2. take the EXCLUSIVE migration gate (bounded by [`GATE_WAIT_BOUND`]);
//! 3. snapshot `fredo.db` while writers are quiesced;
//! 4. copy + parity-gate every source table from the read-only snapshot;
//! 5. write the marker ONLY after a fully parity-clean run.

use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use anyhow::{anyhow, Context, Result};
use sqlx::PgPool;

use crate::infrastructure::storage::engine::StorageEngineState;

use super::copy::copy_table;
use super::gate::MigrationGate;
use super::snapshot::{open_snapshot_read_only, take_snapshot};
use super::tables::enumerate_tables;
use super::{MigrationOutcome, MigrationStatus, MIGRATION_BOUND, MIGRATION_COMPLETED_KEY};

/// The read-only status view the `migration_status` command exposes.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationStatusView {
    /// The terminal status of the last recorded leg.
    pub status: MigrationStatus,
    /// Per-table parity pairs from the last recorded leg.
    pub tables: Vec<super::TableParity>,
    /// The pre-cutover snapshot path, when one was taken.
    pub snapshot_path: Option<String>,
    /// `true` when the marker is set / the run completed cleanly.
    pub completed: bool,
}

impl Default for MigrationStatusView {
    fn default() -> Self {
        MigrationStatusView {
            status: MigrationStatus::Skipped,
            tables: Vec::new(),
            snapshot_path: None,
            completed: false,
        }
    }
}

/// Copy every physical table of `source_db` into the candidate `pool`, gated by
/// the per-table parity check and the exclusive `gate`.
///
/// `source_db` is the path to `fredo.db`; `migration_dir` receives the single
/// pre-cutover snapshot. A present completion marker short-circuits to
/// [`MigrationStatus::Skipped`].
pub async fn run_pre_install(
    source_db: &Path,
    migration_dir: &Path,
    pool: &PgPool,
    gate: &Arc<MigrationGate>,
) -> Result<MigrationOutcome> {
    let started = Instant::now();

    // 1. Marker gate: read from the candidate pool BEFORE copying.
    let marker: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = $1")
        .bind(MIGRATION_COMPLETED_KEY)
        .fetch_optional(pool)
        .await
        .context("[migration] read the completion marker")?;
    if marker.is_some() {
        return Ok(MigrationOutcome {
            status: MigrationStatus::Skipped,
            tables: Vec::new(),
            snapshot: None,
            elapsed_ms: started.elapsed().as_millis(),
        });
    }

    // 2. Exclusive barrier, held across snapshot → copy → parity. The acquire is
    //    bounded separately from (and more loosely than) the migration leg, so a
    //    writer can wait out a full leg before giving up.
    let _guard = gate.migration_enter().await?;

    // 3-5. The whole leg under the wall-clock bound (G-263).
    match tokio::time::timeout(
        MIGRATION_BOUND,
        run_locked(source_db, migration_dir, pool, started),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => Err(anyhow!(
            "[migration] the migration leg exceeded its {MIGRATION_BOUND:?} wall-clock bound"
        )),
    }
}

async fn run_locked(
    source_db: &Path,
    migration_dir: &Path,
    pool: &PgPool,
    started: Instant,
) -> Result<MigrationOutcome> {
    let snapshot = take_snapshot(source_db, migration_dir)?;
    let mut conn = open_snapshot_read_only(&snapshot.path)?;
    let tables = enumerate_tables(&conn)?;

    let mut parities = Vec::with_capacity(tables.len());
    for spec in &tables {
        let parity = copy_table(&mut conn, pool, spec).await?;
        if !parity.count_match || !parity.checksum_match {
            return Err(anyhow!(
                "[migration] parity mismatch on '{}': rows {}/{} checksums {}/{}",
                parity.table,
                parity.source_rows,
                parity.target_rows,
                parity.source_checksum,
                parity.target_checksum
            ));
        }
        parities.push(parity);
    }

    // 5. Marker written ONLY after a fully parity-clean run, before install.
    let completed_at = chrono::Utc::now().to_rfc3339();
    sqlx::query(
        "INSERT INTO settings (key, value) VALUES ($1, $2)
         ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value",
    )
    .bind(MIGRATION_COMPLETED_KEY)
    .bind(&completed_at)
    .execute(pool)
    .await
    .context("[migration] write the completion marker")?;

    Ok(MigrationOutcome {
        status: MigrationStatus::Completed,
        tables: parities,
        snapshot: Some(snapshot),
        elapsed_ms: started.elapsed().as_millis(),
    })
}

/// The read-only live status hook (no state mutation). Registered in `lib.rs`.
#[tauri::command]
pub async fn migration_status(app: tauri::AppHandle) -> MigrationStatusView {
    use tauri::Manager as _;
    match app.try_state::<Arc<StorageEngineState>>() {
        Some(state) => state.migration_status_view(),
        None => MigrationStatusView::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::Future;
    use std::path::Path;

    /// CU-B awaits this future inside `tauri::async_runtime::spawn`, which
    /// requires `Send`. Pin the contract here so a non-`Send` regression fails
    /// at compile time (the future is never polled).
    #[tokio::test]
    async fn pre_install_future_is_send() {
        fn assert_send<F: Future + Send>(_: F) {}
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://postgres:pw@127.0.0.1:1/none")
            .expect("lazy pool should build without connecting");
        let gate = MigrationGate::new();
        let dir = Path::new(".");
        assert_send(run_pre_install(dir, dir, &pool, &gate));
    }

    #[test]
    fn status_view_defaults_to_skipped() {
        let view = MigrationStatusView::default();
        assert_eq!(view.status, MigrationStatus::Skipped);
        assert!(!view.completed);
        assert!(view.tables.is_empty());
        assert!(view.snapshot_path.is_none());
    }

    #[test]
    fn status_view_serializes_camel_case() {
        let json = serde_json::to_value(MigrationStatusView::default()).unwrap();
        assert_eq!(json["status"], "Skipped");
        assert_eq!(json["snapshotPath"], serde_json::Value::Null);
        assert_eq!(json["completed"], false);
    }
}

