//! The pre-install entry point + the read-only status hook (ST-4 core half).
//!
//! [`run_pre_install`] is called by the supervisor BETWEEN
//! `run_pg_schema_inits` and `install_postgres`, against the **candidate** pool.
//! It is fail-closed: any error (or the whole-leg [`MIGRATION_HARD_CEILING`]
//! timeout) returns `Err` having written no marker, so the caller installs
//! nothing (the handle stays `Pending`) — there is NO SQLite data-plane fallback
//! (R-1.4).
//!
//! Each table is copied under its OWN proportional budget (ST-8a/ST-8b), checked
//! cooperatively between chunks, so a single oversized table can never starve the
//! tables ordered after it — every physical table is attempted. The whole-leg
//! [`MIGRATION_HARD_CEILING`] remains the fail-closed backstop.
//!
//! Ordering contract:
//! 0. a data dir with no `fredo.db` has nothing to migrate — return `Fresh`
//!    BEFORE reading the marker or snapshotting, so PostgreSQL installs
//!    normally (R-1.1/R-4.1);
//! 1. read the completion marker from the candidate pool — present ⇒ `Skipped`;
//! 2. the caller holds the EXCLUSIVE migration gate (bounded by
//!    [`GATE_WAIT_BOUND`]) from BEFORE this call THROUGH `install_postgres`
//!    (R-3.5: the barrier spans copy + parity + engine install);
//! 3. snapshot `fredo.db` while writers are quiesced;
//! 4. copy + parity-gate every source table from the read-only snapshot;
//! 5. write the marker ONLY after a fully parity-clean run.

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use rusqlite::Connection;
use sqlx::PgPool;

use crate::infrastructure::storage::engine::{quote_ident, StorageEngineState};
use crate::infrastructure::storage::AppStore;

use super::copy::copy_table_with_fault;
use super::gate::MigrationGuard;
use super::snapshot::{
    open_snapshot_read_only, take_snapshot_with_fault, verify_rollback_snapshot, PreCutoverTable,
    RollbackTableCheck, SNAPSHOT_FILENAME,
};
use super::tables::{enumerate_tables, TableSpec};
use super::{
    current_migration_fault, migration_table_budget, resolve_app_data_dir, resolve_migration_dir,
    MigrationFault, MigrationOutcome, MigrationStatus, MIGRATION_COMPLETED_KEY,
    MIGRATION_HARD_CEILING, ROLLBACK_PRECUTOVER_PARITY_KEY, ROLLBACK_VERIFIED_AT_KEY,
    ROLLBACK_VERIFIED_KEY,
};

/// Finite bound on the whole `verify_rollback` flow (G-263). The snapshot
/// recompute runs on a blocking worker under this wall-clock cap; the caller is
/// never left waiting on an unbounded read. On expiry the verification fails
/// closed and writes nothing.
pub const VERIFY_ROLLBACK_BOUND: Duration = Duration::from_secs(600);

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
/// pre-cutover snapshot. A source-absent data dir short-circuits to
/// [`MigrationStatus::Fresh`] (fresh install, R-1.1/R-4.1); a present completion
/// marker short-circuits to [`MigrationStatus::Skipped`] (R-1.3).
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

    // 0. Fresh-install guard (R-1.1/R-4.1): a data dir with no `fredo.db` has
    //    nothing to migrate. Return `Fresh` BEFORE reading the marker or taking a
    //    snapshot, so the leg is a clean no-op and PostgreSQL installs normally.
    //    Without this guard `take_snapshot` rejects the missing source and fails
    //    the whole boot (the pre-CU-3 gap).
    if !source_db.exists() {
        tracing::info!(
            target: "fredo::migration",
            path = %source_db.display(),
            "no legacy fredo.db; skipping the one-shot cutover leg (fresh install)"
        );
        return Ok(MigrationOutcome {
            status: MigrationStatus::Fresh,
            tables: Vec::new(),
            snapshot: None,
            elapsed_ms: started.elapsed().as_millis(),
        });
    }

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

    // 2-5. The whole leg under the hard ceiling (ST-8a; G-263). Per-table
    //      budgets are enforced cooperatively inside `run_locked`; this ceiling
    //      is the fail-closed backstop. The G-275 fault seam is read ONCE here;
    //      unset ⇒ `None` ⇒ the default path is byte-identical. The exclusive
    //      barrier is held by the caller.
    let fault = current_migration_fault();
    match tokio::time::timeout(
        MIGRATION_HARD_CEILING,
        run_locked(source_db, migration_dir, pool, started, fault.as_ref()),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => Err(anyhow!(
            "[migration] the migration leg exceeded its {MIGRATION_HARD_CEILING:?} hard ceiling"
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
        // ST-8a/ST-8b: give each table its own proportional budget (derived from
        // its source row count) and enforce it cooperatively between chunks. A
        // single oversized table can no longer starve the tables after it — the
        // loop always advances to the next table.
        let rows = source_row_count(&conn, spec)?;
        let deadline = Instant::now() + migration_table_budget(rows);
        let parity = copy_table_with_fault(&mut conn, pool, spec, fault, deadline).await?;
        tracing::info!(
            target: "fredo::migration",
            table = %spec.name,
            rows = parity.source_rows,
            elapsed_ms = parity.elapsed_ms as u64,
            "table copied"
        );
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

    // CU-4 (R-2.1): record the pre-cutover per-table counts + SHA-256 checksums
    // as the durable reference `verify_rollback` compares the retained snapshot
    // against (R-2.2). The source side of each parity pair IS the pre-cutover
    // value (the export reads the read-only snapshot of `fredo.db`).
    let pre_cutover: Vec<PreCutoverTable> = parities
        .iter()
        .map(|parity| PreCutoverTable {
            table: parity.table.clone(),
            rows: parity.source_rows,
            checksum: parity.source_checksum.clone(),
        })
        .collect();
    let pre_cutover_json =
        serde_json::to_string(&pre_cutover).context("[migration] encode the pre-cutover parity")?;
    sqlx::query(
        "INSERT INTO settings (key, value) VALUES ($1, $2)
         ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value",
    )
    .bind(ROLLBACK_PRECUTOVER_PARITY_KEY)
    .bind(&pre_cutover_json)
    .execute(pool)
    .await
    .context("[migration] record the pre-cutover parity")?;

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
                if source_row_count(conn, spec)? > 0 {
                    return Ok(Some(MigrationFault::DropRow(spec.name.clone())));
                }
            }
            Ok(None)
        }
        other => Ok(other.cloned()),
    }
}

/// The source row count of one enumerated table (ST-8b), read through the
/// read-only snapshot handle. Drives the per-table budget (ST-8a) and the
/// `1`/`true` fault-seam resolution.
fn source_row_count(conn: &Connection, spec: &TableSpec) -> Result<i64> {
    conn.query_row(
        &format!("SELECT COUNT(*) FROM {}", quote_ident(&spec.name)),
        [],
        |row| row.get(0),
    )
    .with_context(|| format!("[migration] count source table '{}'", spec.name))
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

/// The structured result of one `verify_rollback` invocation (Spec #2979 CU-4).
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyRollbackReport {
    /// `true` only when every recomputed snapshot checksum equals the recorded
    /// pre-cutover value (R-2.2).
    pub verified: bool,
    /// The retained snapshot that was verified, when resolvable.
    pub snapshot_path: Option<String>,
    /// One recorded-vs-recomputed result per table.
    pub tables: Vec<RollbackTableCheck>,
    /// The first mismatch, when any.
    pub mismatch: Option<String>,
    /// Human-readable summary (the fail-closed reason on a non-verification).
    pub reason: String,
}

impl VerifyRollbackReport {
    /// A fail-closed report (nothing verified, no table detail).
    fn unavailable(snapshot_path: Option<String>, reason: impl Into<String>) -> Self {
        VerifyRollbackReport {
            verified: false,
            snapshot_path,
            tables: Vec::new(),
            mismatch: None,
            reason: reason.into(),
        }
    }
}

/// The store writes `verify_rollback` performs for a verdict (R-2.2).
///
/// A full match writes `rollback.verified = "true"` AND
/// `rollback.verified_at` = `verified_at` (RFC-3339). Any mismatch writes ONLY
/// `rollback.verified = "false"` — the timestamp is never stamped without a
/// verification.
pub fn rollback_verdict_writes(verified: bool, verified_at: &str) -> Vec<(&'static str, String)> {
    if verified {
        vec![
            (ROLLBACK_VERIFIED_KEY, "true".to_string()),
            (ROLLBACK_VERIFIED_AT_KEY, verified_at.to_string()),
        ]
    } else {
        vec![(ROLLBACK_VERIFIED_KEY, "false".to_string())]
    }
}

/// Recompute the retained pre-cutover snapshot read-only and set
/// `rollback.verified` (R-2.2). Registered in `lib.rs`.
///
/// Reads the recorded pre-cutover parity from the active store (written by a
/// parity-clean cutover under [`ROLLBACK_PRECUTOVER_PARITY_KEY`]), recomputes the
/// snapshot's per-table counts + SHA-256 checksums, and sets
/// `rollback.verified = "true"` (plus `rollback.verified_at` = RFC-3339) ONLY
/// when EVERY recomputed checksum equals the recorded value. On any mismatch it
/// records `"false"` and reports the mismatch; nothing is verified.
///
/// **G-263:** the whole flow is capped by [`VERIFY_ROLLBACK_BOUND`] and the
/// synchronous snapshot recompute runs on a blocking worker. **Read-only:** the
/// snapshot is opened read-only and `fredo.db` is never touched.
#[tauri::command]
pub async fn verify_rollback(app: tauri::AppHandle) -> VerifyRollbackReport {
    use tauri::Manager as _;

    // The active store holds the recorded pre-cutover parity + the verdict keys.
    let Some(store) = app.try_state::<Arc<AppStore>>() else {
        return VerifyRollbackReport::unavailable(None, "the store is not available");
    };

    let snapshot = match app.path().app_data_dir() {
        Ok(os_dir) => resolve_migration_dir(&resolve_app_data_dir(&os_dir)).join(SNAPSHOT_FILENAME),
        Err(error) => {
            return VerifyRollbackReport::unavailable(
                None,
                format!("resolve the app data dir: {error}"),
            )
        }
    };
    let snapshot_path = Some(snapshot.display().to_string());

    if !snapshot.exists() {
        return VerifyRollbackReport::unavailable(
            snapshot_path,
            "no retained pre-cutover snapshot to verify",
        );
    }

    let recorded = match store.get(ROLLBACK_PRECUTOVER_PARITY_KEY).await {
        Ok(Some(json)) => match serde_json::from_str::<Vec<PreCutoverTable>>(&json) {
            Ok(recorded) => recorded,
            Err(error) => {
                return VerifyRollbackReport::unavailable(
                    snapshot_path,
                    format!("the recorded pre-cutover parity is unreadable: {error}"),
                )
            }
        },
        Ok(None) => {
            return VerifyRollbackReport::unavailable(
                snapshot_path,
                "no recorded pre-cutover parity (no parity-clean cutover)",
            )
        }
        Err(error) => {
            return VerifyRollbackReport::unavailable(
                snapshot_path,
                format!("read the recorded pre-cutover parity: {error:#}"),
            )
        }
    };

    // G-263: bound the flow; the synchronous snapshot recompute runs on a
    // blocking worker so the async runtime is never blocked.
    let snapshot_for_task = snapshot.clone();
    let bounded = tokio::time::timeout(
        VERIFY_ROLLBACK_BOUND,
        tokio::task::spawn_blocking(move || {
            verify_rollback_snapshot(&snapshot_for_task, &recorded)
        }),
    )
    .await;

    let verification = match bounded {
        Ok(Ok(Ok(verification))) => verification,
        Ok(Ok(Err(error))) => {
            return VerifyRollbackReport::unavailable(
                snapshot_path,
                format!("recompute the retained snapshot: {error:#}"),
            )
        }
        Ok(Err(join_error)) => {
            return VerifyRollbackReport::unavailable(
                snapshot_path,
                format!("the verification worker failed: {join_error}"),
            )
        }
        Err(_) => {
            return VerifyRollbackReport::unavailable(
                snapshot_path,
                format!("verification exceeded its {VERIFY_ROLLBACK_BOUND:?} bound"),
            )
        }
    };

    // Persist the verdict: `rollback.verified = "true"` ONLY on a full match
    // (R-2.2); any mismatch records `"false"` and never stamps a timestamp.
    let verified_at = chrono::Utc::now().to_rfc3339();
    for (key, value) in rollback_verdict_writes(verification.verified, &verified_at) {
        if let Err(error) = store.set(key, &value).await {
            return VerifyRollbackReport::unavailable(
                snapshot_path,
                format!("record {key}: {error:#}"),
            );
        }
    }

    let reason = if verification.verified {
        "every retained-snapshot checksum equals the recorded pre-cutover value".to_string()
    } else {
        verification
            .mismatch
            .clone()
            .unwrap_or_else(|| "a retained-snapshot checksum mismatch".to_string())
    };
    VerifyRollbackReport {
        verified: verification.verified,
        snapshot_path,
        tables: verification.tables,
        mismatch: verification.mismatch,
        reason,
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

    /// CU-3 (R-1.1/R-4.1): a data dir with no `fredo.db` must NOT run the leg —
    /// it returns `Fresh` and writes NO snapshot, and (because the guard fires
    /// before the marker read) never dials the lazily-connected pool.
    #[tokio::test]
    async fn run_pre_install_returns_fresh_when_the_source_is_absent() {
        let dir = tempfile::tempdir().unwrap();
        // A path that does not exist — no `fredo.db` in this data dir.
        let missing = dir.path().join("fredo.db");
        let migration_dir = dir.path().join("migration");
        assert!(!missing.exists());

        let gate = MigrationGate::new();
        let guard = gate.migration_enter().await.unwrap();
        let outcome = run_pre_install(&missing, &migration_dir, &lazy_pool(), &guard)
            .await
            .expect("a source-absent install must not fail the leg");

        assert_eq!(
            outcome.status,
            MigrationStatus::Fresh,
            "no source ⇒ Fresh, never Failed (the pre-CU-3 gap)"
        );
        assert!(outcome.tables.is_empty(), "a fresh install copies nothing");
        assert!(outcome.snapshot.is_none(), "a fresh install snapshots nothing");
        assert!(
            outcome.completed(),
            "a fresh install installs PostgreSQL normally (R-1.1)"
        );
        assert!(
            !migration_dir.join(SNAPSHOT_FILENAME).exists(),
            "a fresh install must write no snapshot"
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

    // ── CU-4 (R-2.2): the verify_rollback verdict persistence ───────────────

    /// A checksum match sets `rollback.verified = "true"` AND stamps
    /// `rollback.verified_at` (RFC-3339).
    #[test]
    fn rollback_verdict_writes_sets_true_and_the_timestamp_on_a_match() {
        let writes = rollback_verdict_writes(true, "2026-10-02T00:00:00+00:00");
        assert_eq!(writes.len(), 2);
        assert!(writes.contains(&(ROLLBACK_VERIFIED_KEY, "true".to_string())));
        assert!(writes.contains(&(
            ROLLBACK_VERIFIED_AT_KEY,
            "2026-10-02T00:00:00+00:00".to_string()
        )));
    }

    /// A checksum mismatch records ONLY `rollback.verified = "false"` — no
    /// timestamp is stamped, so `rollbackVerified` can never read true.
    #[test]
    fn rollback_verdict_writes_records_false_without_a_timestamp_on_a_mismatch() {
        let writes = rollback_verdict_writes(false, "2026-10-02T00:00:00+00:00");
        assert_eq!(
            writes,
            vec![(ROLLBACK_VERIFIED_KEY, "false".to_string())],
            "a mismatch must not stamp rollback.verified_at"
        );
        assert!(
            !writes.iter().any(|(key, _)| *key == ROLLBACK_VERIFIED_AT_KEY),
            "no verification timestamp on a mismatch"
        );
    }

    /// The report serializes camelCase, matching the wire contract.
    #[test]
    fn verify_rollback_report_serializes_camel_case() {
        let report = VerifyRollbackReport {
            verified: true,
            snapshot_path: Some("C:/m/fredo.pre-cutover.db".to_string()),
            tables: vec![RollbackTableCheck {
                table: "settings".to_string(),
                recorded_rows: 2,
                recomputed_rows: 2,
                recorded_checksum: "a".to_string(),
                recomputed_checksum: "a".to_string(),
                matches: true,
            }],
            mismatch: None,
            reason: "ok".to_string(),
        };
        let json = serde_json::to_value(&report).unwrap();
        assert_eq!(json["verified"], true);
        assert_eq!(json["snapshotPath"], "C:/m/fredo.pre-cutover.db");
        assert_eq!(json["tables"][0]["recordedRows"], 2);
        assert_eq!(json["tables"][0]["recomputedChecksum"], "a");
        assert_eq!(json["mismatch"], serde_json::Value::Null);
    }

    /// An unavailable report is fail-closed: never verified, no table detail.
    #[test]
    fn verify_rollback_report_unavailable_is_fail_closed() {
        let report = VerifyRollbackReport::unavailable(None, "no snapshot");
        assert!(!report.verified);
        assert!(report.tables.is_empty());
        assert!(report.mismatch.is_none());
        assert_eq!(report.reason, "no snapshot");
    }
}

