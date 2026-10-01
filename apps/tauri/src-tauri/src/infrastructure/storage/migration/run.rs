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
//! 2. the caller holds the EXCLUSIVE migration gate (bounded by
//!    [`GATE_WAIT_BOUND`]) from BEFORE this call THROUGH `install_postgres`
//!    (R-3.5: the barrier spans copy + parity + engine install);
//! 3. snapshot `fredo.db` while writers are quiesced;
//! 4. copy + parity-gate every source table from the read-only snapshot;
//! 5. write the marker ONLY after a fully parity-clean run.

use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use anyhow::{anyhow, Context, Result};
use rusqlite::Connection;
use sqlx::PgPool;

use crate::infrastructure::storage::engine::{quote_ident, StorageEngineState};

use super::copy::copy_table_with_fault;
use super::gate::MigrationGuard;
use super::snapshot::{open_snapshot_read_only, take_snapshot_with_fault};
use super::tables::{enumerate_tables, TableSpec};
use super::{
    current_migration_fault, MigrationFault, MigrationOutcome, MigrationStatus, MIGRATION_BOUND,
    MIGRATION_COMPLETED_KEY,
};

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
/// the per-table parity check.
///
/// `source_db` is the path to `fredo.db`; `migration_dir` receives the single
/// pre-cutover snapshot. A present completion marker short-circuits to
/// [`MigrationStatus::Skipped`].
///
/// **R-3.5 (G-123):** the caller MUST hold the exclusive migration barrier
/// (`guard`) from BEFORE this call through `install_postgres` — this function
/// never acquires or releases it, so the copy, the parity gate, AND the engine
/// install all sit inside ONE quiesced window. The held `guard` is accepted (not
/// re-acquired: an exclusive lock is not re-entrant) purely to make the hold
/// scope explicit at the call site.
pub async fn run_pre_install(
    source_db: &Path,
    migration_dir: &Path,
    pool: &PgPool,
    _guard: &MigrationGuard<'_>,
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

    // 2-5. The whole leg under the wall-clock bound (G-263). The G-275 fault
    //      seam is read ONCE here; unset ⇒ `None` ⇒ the default path is
    //      byte-identical. The exclusive barrier is held by the caller.
    let fault = current_migration_fault();
    match tokio::time::timeout(
        MIGRATION_BOUND,
        run_locked(source_db, migration_dir, pool, started, fault.as_ref()),
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
    fault: Option<&MigrationFault>,
) -> Result<MigrationOutcome> {
    let snapshot = take_snapshot_with_fault(source_db, migration_dir, fault)?;
    let mut conn = open_snapshot_read_only(&snapshot.path)?;
    let tables = enumerate_tables(&conn)?;

    // Resolve `1`/`true` to the first non-empty table (sorted name), so the copy
    // seam only ever sees a concrete table.
    let resolved_fault = resolve_fault(fault, &conn, &tables)?;
    let fault = resolved_fault.as_ref();

    let mut parities = Vec::with_capacity(tables.len());
    for spec in &tables {
        let parity = copy_table_with_fault(&mut conn, pool, spec, fault).await?;
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

/// Resolve the fault seam against the enumerated source tables.
///
/// [`MigrationFault::DropRowFirstNonEmpty`] (`1`/`true`) becomes a concrete
/// [`MigrationFault::DropRow`] for the first non-empty table in name order (the
/// enumeration is already name-sorted). Any other fault is passed through. The
/// count query runs ONLY for the first-non-empty form, so the default and every
/// other fault path is untouched.
fn resolve_fault(
    fault: Option<&MigrationFault>,
    conn: &Connection,
    tables: &[TableSpec],
) -> Result<Option<MigrationFault>> {
    match fault {
        Some(MigrationFault::DropRowFirstNonEmpty) => {
            for spec in tables {
                let count: i64 = conn
                    .query_row(
                        &format!("SELECT COUNT(*) FROM {}", quote_ident(&spec.name)),
                        [],
                        |row| row.get(0),
                    )
                    .with_context(|| {
                        format!("[migration] count source table '{}'", spec.name)
                    })?;
                if count > 0 {
                    return Ok(Some(MigrationFault::DropRow(spec.name.clone())));
                }
            }
            Ok(None)
        }
        other => Ok(other.cloned()),
    }
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
    use crate::infrastructure::storage::migration::snapshot::SNAPSHOT_FILENAME;
    use crate::infrastructure::storage::migration::MigrationGate;
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
        // The caller holds the exclusive barrier (R-3.5) and passes it in.
        let guard = gate.migration_enter().await.unwrap();
        let dir = Path::new(".");
        assert_send(run_pre_install(dir, dir, &pool, &guard));
    }

    /// A lazily-connected pool that never dials a live server.
    fn lazy_pool() -> PgPool {
        sqlx::postgres::PgPoolOptions::new()
            .min_connections(0)
            .max_connections(1)
            .connect_lazy("postgres://postgres:pw@127.0.0.1:1/none")
            .expect("lazy pool should build without connecting")
    }

    fn seed_fixture(path: &Path) {
        let conn = Connection::open(path).expect("open fixture");
        conn.execute_batch(
            "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             INSERT INTO settings (key, value) VALUES ('a', '1');
             CREATE TABLE rows (id INTEGER PRIMARY KEY, note TEXT);
             INSERT INTO rows (id, note) VALUES (1, 'x'), (2, NULL);",
        )
        .expect("seed fixture");
    }

    /// The fail-closed decision: a forced snapshot failure returns `Err` on a
    /// temp SQLite fixture and writes NO snapshot — and, crucially, never reaches
    /// the (unreachable) pool, so the decision is deterministic without a server.
    #[tokio::test]
    async fn run_locked_fails_closed_on_snapshot_fault() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("fredo.db");
        let migration_dir = dir.path().join("migration");
        seed_fixture(&source);

        let result = run_locked(
            &source,
            &migration_dir,
            &lazy_pool(),
            Instant::now(),
            Some(&MigrationFault::SnapshotFail),
        )
        .await;

        assert!(result.is_err(), "a forced snapshot failure must fail closed");
        assert!(
            !migration_dir.join(SNAPSHOT_FILENAME).exists(),
            "a failed snapshot step must write no snapshot"
        );
    }

    /// `1`/`true` resolves to the first NON-empty table in name order; the
    /// fault seam never fires for an unknown/blank value.
    #[test]
    fn resolve_fault_maps_first_non_empty_to_a_concrete_table() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE empty_table (id INTEGER PRIMARY KEY);
             CREATE TABLE zebra (id INTEGER PRIMARY KEY);
             CREATE TABLE apple (id INTEGER PRIMARY KEY, note TEXT);
             INSERT INTO apple (id, note) VALUES (1, 'x');
             INSERT INTO zebra (id) VALUES (1);",
        )
        .unwrap();
        let tables = enumerate_tables(&conn).unwrap();

        let resolved = resolve_fault(Some(&MigrationFault::DropRowFirstNonEmpty), &conn, &tables)
            .unwrap()
            .expect("a non-empty table exists");
        // Name order: apple < empty_table < zebra; apple is the first non-empty.
        assert_eq!(resolved, MigrationFault::DropRow("apple".to_string()));

        assert_eq!(resolve_fault(None, &conn, &tables).unwrap(), None);
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

