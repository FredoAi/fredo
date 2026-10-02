//! Pre-cutover snapshot, verification, and the executable SQLite backout
//! (ST-3, R-3.1/R-3.3/R-3.4).
//!
//! - [`take_snapshot`] runs `PRAGMA wal_checkpoint(TRUNCATE)` then
//!   `VACUUM INTO <migration_dir>/fredo.pre-cutover.db`. Exactly ONE snapshot is
//!   kept, overwritten per attempt, and never auto-deleted (Q-13) — it IS the
//!   backout. `fredo.db` itself is never mutated or deleted by the migration leg.
//! - [`verify_snapshot`] re-opens the snapshot read-only and recomputes the same
//!   per-table counts/checksums, so a caller can compare them against the
//!   pre-cutover values.
//! - [`verify_rollback_snapshot`] / [`compare_rollback_parity`] recompute the
//!   retained snapshot and compare it, table by table, against the recorded
//!   pre-cutover parity — the pure decision `verify_rollback` persists (R-2.2).
//! - [`restore_snapshot`] copies the snapshot over the target `fredo.db` through
//!   an atomic temp-file + rename, then clears any stale WAL sidecars.
//!
//! # Snapshot retention — Q-13 (Spec #2979 CU-4)
//!
//! There is exactly ONE snapshot, `<migration_dir>/fredo.pre-cutover.db`
//! ([`SNAPSHOT_FILENAME`]) under [`super::resolve_migration_dir`]. It is
//! overwritten per cutover attempt (a re-run after a failed parity gate replaces
//! it), retained **read-only for the life of the release** alongside `fredo.db`,
//! and pruned only at the NEXT release's cleanup — never automatically by the
//! migration leg. `take_snapshot` never mutates the source `fredo.db`, and
//! `verify_rollback` never mutates the snapshot or `fredo.db` (it opens the
//! snapshot with a strictly read-only handle). This is the executable SQLite
//! backout artifact.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use chrono::Utc;
use rusqlite::{Connection, OpenFlags};

use crate::infrastructure::storage::engine::quote_ident;

use super::copy::source_cell;
use super::parity::RowHasher;
use super::tables::{enumerate_tables, TableSpec};
use super::{MigrationFault, TableParity, MIGRATION_FORCE_MISMATCH_ENV};

/// The single, stable snapshot filename under the migration dir (Q-13).
pub const SNAPSHOT_FILENAME: &str = "fredo.pre-cutover.db";

/// One pre-cutover snapshot artifact.
#[derive(Clone, Debug)]
pub struct SnapshotRecord {
    /// `<migration_dir>/fredo.pre-cutover.db`.
    pub path: PathBuf,
    /// ISO-8601 UTC creation timestamp.
    pub created_at: String,
    /// `true` when the pre-snapshot `wal_checkpoint(TRUNCATE)` completed without
    /// a busy result.
    pub checkpointed: bool,
    /// The source `fredo.db` byte size at snapshot time.
    pub source_bytes: u64,
}

/// Take the ONE pre-cutover snapshot of `source_db` into `migration_dir`
/// (fault-seam-free default path).
pub fn take_snapshot(source_db: &Path, migration_dir: &Path) -> Result<SnapshotRecord> {
    take_snapshot_with_fault(source_db, migration_dir, None)
}

/// Take the ONE pre-cutover snapshot, honouring the **G-275** fault seam.
///
/// The source is opened read-write ONLY for the sanctioned
/// `wal_checkpoint(TRUNCATE)` touch and the `VACUUM INTO` (which reads the
/// source and writes the destination — it never mutates `fredo.db`). A missing
/// source is an error, never an accidentally-created empty database.
///
/// When `fault` is [`MigrationFault::SnapshotFail`] the step fails closed before
/// touching the source (no snapshot is written), so the caller installs nothing.
pub fn take_snapshot_with_fault(
    source_db: &Path,
    migration_dir: &Path,
    fault: Option<&MigrationFault>,
) -> Result<SnapshotRecord> {
    if matches!(fault, Some(MigrationFault::SnapshotFail)) {
        bail!("[migration] snapshot forced to fail via {MIGRATION_FORCE_MISMATCH_ENV}");
    }
    if !source_db.exists() {
        bail!(
            "[migration] source database '{}' does not exist",
            source_db.display()
        );
    }
    std::fs::create_dir_all(migration_dir).with_context(|| {
        format!(
            "[migration] create migration dir '{}'",
            migration_dir.display()
        )
    })?;

    let snapshot_path = migration_dir.join(SNAPSHOT_FILENAME);
    let conn = Connection::open_with_flags(source_db, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .with_context(|| format!("[migration] open source '{}'", source_db.display()))?;

    // The sanctioned pre-snapshot touch: fold WAL content into the main db file
    // so the snapshot is complete and self-contained.
    let (busy, _log, _checkpointed): (i64, i64, i64) = conn
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .context("[migration] wal_checkpoint(TRUNCATE)")?;

    // One snapshot, overwritten per attempt (never auto-deleted).
    if snapshot_path.exists() {
        std::fs::remove_file(&snapshot_path).with_context(|| {
            format!(
                "[migration] replace the previous snapshot '{}'",
                snapshot_path.display()
            )
        })?;
    }
    conn.execute(
        "VACUUM INTO ?1",
        rusqlite::params![snapshot_path.to_string_lossy()],
    )
    .with_context(|| format!("[migration] snapshot into '{}'", snapshot_path.display()))?;
    drop(conn);

    let source_bytes = std::fs::metadata(source_db)
        .with_context(|| format!("[migration] stat source '{}'", source_db.display()))?
        .len();

    Ok(SnapshotRecord {
        path: snapshot_path,
        created_at: Utc::now().to_rfc3339(),
        checkpointed: busy == 0,
        source_bytes,
    })
}

/// Open a snapshot with a strictly read-only handle (the export's source).
pub fn open_snapshot_read_only(snapshot: &Path) -> Result<Connection> {
    Connection::open_with_flags(snapshot, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .with_context(|| format!("[migration] open snapshot '{}' read-only", snapshot.display()))
}

/// Re-open the snapshot read-only and recompute every table's count + checksum.
///
/// The returned [`TableParity`] carries the snapshot's own values on BOTH sides
/// (the export has no target here); a caller compares them against the
/// pre-cutover parity to prove the backout is checksum-equal.
pub fn verify_snapshot(snapshot: &Path) -> Result<Vec<TableParity>> {
    let conn = open_snapshot_read_only(snapshot)?;
    let tables = enumerate_tables(&conn)?;
    let mut out = Vec::with_capacity(tables.len());
    for spec in &tables {
        let (rows, checksum) = snapshot_table_parity(&conn, spec)?;
        out.push(TableParity {
            table: spec.name.clone(),
            source_rows: rows,
            target_rows: rows,
            count_match: true,
            source_checksum: checksum.clone(),
            target_checksum: checksum,
            checksum_match: true,
            read_only_source: true,
            // Snapshot verification is a local re-read, not a copy — no copy
            // duration applies.
            elapsed_ms: 0,
        });
    }
    Ok(out)
}

/// One recorded pre-cutover table: its row count and SHA-256 checksum, captured
/// by a parity-clean cutover (Spec #2979 CU-4, R-2.1) and persisted under
/// [`super::ROLLBACK_PRECUTOVER_PARITY_KEY`]. This is the durable reference
/// [`verify_rollback_snapshot`] compares the retained snapshot against.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreCutoverTable {
    /// The physical table name.
    pub table: String,
    /// Pre-cutover row count.
    pub rows: i64,
    /// SHA-256 over the pre-cutover PK-ordered canonical encoding.
    pub checksum: String,
}

/// One table's rollback verification result (recorded vs recomputed).
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RollbackTableCheck {
    /// The physical table name.
    pub table: String,
    /// The recorded pre-cutover row count.
    pub recorded_rows: i64,
    /// The recomputed snapshot row count.
    pub recomputed_rows: i64,
    /// The recorded pre-cutover SHA-256 checksum.
    pub recorded_checksum: String,
    /// The recomputed snapshot SHA-256 checksum.
    pub recomputed_checksum: String,
    /// `recorded_rows == recomputed_rows && recorded_checksum == recomputed_checksum`.
    pub matches: bool,
}

/// The pure outcome of comparing the retained snapshot's recomputed parity
/// against the recorded pre-cutover parity.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RollbackVerification {
    /// `true` only when EVERY recorded table matched exactly (R-2.2).
    pub verified: bool,
    /// One result per recorded table.
    pub tables: Vec<RollbackTableCheck>,
    /// The first mismatch, when any (the fail-closed reason).
    pub mismatch: Option<String>,
}

/// Recompute the retained `snapshot` read-only and compare it, table by table,
/// against `recorded` — the pre-cutover reference (R-2.2).
///
/// Read-only end-to-end: the snapshot is opened with
/// [`open_snapshot_read_only`], so neither the snapshot nor `fredo.db` is
/// mutated. `verified` is `true` ONLY when every recorded table is present with
/// an equal row count AND checksum; any missing table or mismatch leaves it
/// `false` with a human-readable [`RollbackVerification::mismatch`].
pub fn verify_rollback_snapshot(
    snapshot: &Path,
    recorded: &[PreCutoverTable],
) -> Result<RollbackVerification> {
    let recomputed = verify_snapshot(snapshot)?;
    Ok(compare_rollback_parity(recorded, &recomputed))
}

/// The pure comparison behind [`verify_rollback_snapshot`]: every `recorded`
/// table must be present in `recomputed` with an equal row count and checksum.
///
/// An empty `recorded` set can never verify (there is nothing to prove), so it
/// fails closed with a mismatch.
pub fn compare_rollback_parity(
    recorded: &[PreCutoverTable],
    recomputed: &[TableParity],
) -> RollbackVerification {
    if recorded.is_empty() {
        return RollbackVerification {
            verified: false,
            tables: Vec::new(),
            mismatch: Some("no recorded pre-cutover parity to verify against".to_string()),
        };
    }

    let mut tables = Vec::with_capacity(recorded.len());
    let mut mismatch = None;
    for expected in recorded {
        let found = recomputed.iter().find(|parity| parity.table == expected.table);
        let (rows, checksum) = match found {
            Some(parity) => (parity.source_rows, parity.source_checksum.clone()),
            None => (0, String::new()),
        };
        let matches = found.is_some() && rows == expected.rows && checksum == expected.checksum;
        if !matches && mismatch.is_none() {
            mismatch = Some(format!(
                "table '{}' mismatch: recorded {} rows / {} checksum, recomputed {} rows / {} checksum",
                expected.table, expected.rows, expected.checksum, rows, checksum
            ));
        }
        tables.push(RollbackTableCheck {
            table: expected.table.clone(),
            recorded_rows: expected.rows,
            recomputed_rows: rows,
            recorded_checksum: expected.checksum.clone(),
            recomputed_checksum: checksum,
            matches,
        });
    }

    let verified = mismatch.is_none();
    RollbackVerification {
        verified,
        tables,
        mismatch,
    }
}

/// Restore `snapshot` over `target_db` through an atomic temp-file + rename.
///
/// Any stale `-wal` / `-shm` sidecar of the previous target is removed so the
/// restored database is authoritative. The caller is responsible for having
/// stopped the app first (a live holder can lock the target on Windows).
pub fn restore_snapshot(snapshot: &Path, target_db: &Path) -> Result<()> {
    if !snapshot.exists() {
        bail!(
            "[migration] snapshot '{}' does not exist",
            snapshot.display()
        );
    }
    let parent = target_db
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent)
        .with_context(|| format!("[migration] create '{}'", parent.display()))?;

    let file_name = target_db
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "fredo.db".to_string());
    let temp = parent.join(format!(".{file_name}.{}.restore.tmp", std::process::id()));

    std::fs::copy(snapshot, &temp).with_context(|| {
        format!(
            "[migration] stage snapshot '{}' -> '{}'",
            snapshot.display(),
            temp.display()
        )
    })?;
    // On Windows `std::fs::rename` replaces an existing file
    // (MOVEFILE_REPLACE_EXISTING), so the swap is atomic on one volume.
    std::fs::rename(&temp, target_db).with_context(|| {
        format!(
            "[migration] atomically replace '{}'",
            target_db.display()
        )
    })?;

    for suffix in ["-wal", "-shm"] {
        let sidecar = PathBuf::from(format!("{}{suffix}", target_db.display()));
        if sidecar.exists() {
            std::fs::remove_file(&sidecar).with_context(|| {
                format!("[migration] remove stale sidecar '{}'", sidecar.display())
            })?;
        }
    }
    Ok(())
}

/// Stream one snapshot table PK-ordered and fold it into a count + checksum.
fn snapshot_table_parity(conn: &Connection, spec: &TableSpec) -> Result<(i64, String)> {
    let sql = format!(
        "SELECT {} FROM {} ORDER BY {}",
        spec.select_columns(),
        quote_ident(&spec.name),
        spec.order_by_sqlite()
    );
    let mut statement = conn
        .prepare(&sql)
        .with_context(|| format!("[migration] prepare snapshot read of '{}'", spec.name))?;
    let mut rows = statement.query([])?;
    let mut hasher = RowHasher::new();
    let mut count: i64 = 0;
    while let Some(row) = rows.next()? {
        let mut cells = Vec::with_capacity(spec.columns.len());
        for (index, column) in spec.columns.iter().enumerate() {
            let value: rusqlite::types::Value = row.get(index)?;
            cells.push(source_cell(value, column));
        }
        hasher.update_row(&cells);
        count += 1;
    }
    Ok((count, hasher.finish()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed_source(path: &Path) {
        let conn = Connection::open(path).expect("open source");
        conn.execute_batch(
            "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             INSERT INTO settings (key, value) VALUES ('a', '1'), ('b', 'two');
             CREATE TABLE rows (id INTEGER PRIMARY KEY, note TEXT);
             INSERT INTO rows (id, note) VALUES (1, 'x'), (2, NULL), (3, 'z');",
        )
        .expect("seed source");
    }

    #[test]
    fn snapshot_verify_and_restore_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("fredo.db");
        let migration_dir = dir.path().join("migration");
        seed_source(&source);

        let record = take_snapshot(&source, &migration_dir).unwrap();
        assert!(record.path.exists(), "the snapshot must exist");
        assert!(record.source_bytes > 0);
        assert!(!record.created_at.is_empty());

        let parity = verify_snapshot(&record.path).unwrap();
        let settings = parity
            .iter()
            .find(|table| table.table == "settings")
            .expect("settings parity");
        assert_eq!(settings.source_rows, 2);
        assert!(settings.count_match && settings.checksum_match);
        let rows = parity
            .iter()
            .find(|table| table.table == "rows")
            .expect("rows parity");
        assert_eq!(rows.source_rows, 3);

        // Restore over a fresh target and confirm the rows came back.
        let restored = dir.path().join("restored").join("fredo.db");
        restore_snapshot(&record.path, &restored).unwrap();
        assert!(restored.exists());
        let conn = open_snapshot_read_only(&restored).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM settings", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 2);
        let null_note: i64 = conn
            .query_row("SELECT COUNT(*) FROM rows WHERE note IS NULL", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(null_note, 1);
    }

    #[test]
    fn take_snapshot_overwrites_the_single_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("fredo.db");
        let migration_dir = dir.path().join("migration");
        seed_source(&source);

        let first = take_snapshot(&source, &migration_dir).unwrap();
        let second = take_snapshot(&source, &migration_dir).unwrap();
        assert_eq!(first.path, second.path, "one stable snapshot path");

        // Exactly one snapshot file is present.
        let snapshots: Vec<_> = std::fs::read_dir(&migration_dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name() == SNAPSHOT_FILENAME)
            .collect();
        assert_eq!(snapshots.len(), 1);
    }

    #[test]
    fn restore_replaces_an_existing_target() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("fredo.db");
        let migration_dir = dir.path().join("migration");
        seed_source(&source);
        let record = take_snapshot(&source, &migration_dir).unwrap();

        let target = dir.path().join("fredo.db");
        // Corrupt the target, then restore over it.
        {
            let conn = Connection::open(&target).unwrap();
            conn.execute_batch("DELETE FROM settings;").unwrap();
        }
        restore_snapshot(&record.path, &target).unwrap();
        let conn = open_snapshot_read_only(&target).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM settings", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 2, "the snapshot must replace the target");
    }

    #[test]
    fn snapshot_fault_fails_closed_without_writing_a_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("fredo.db");
        let migration_dir = dir.path().join("migration");
        seed_source(&source);

        let error =
            take_snapshot_with_fault(&source, &migration_dir, Some(&MigrationFault::SnapshotFail))
                .unwrap_err();
        assert!(error.to_string().contains("forced to fail"), "{error}");
        assert!(
            !migration_dir.join(SNAPSHOT_FILENAME).exists(),
            "a forced snapshot failure must not write a snapshot"
        );
    }

    #[test]
    fn take_snapshot_rejects_a_missing_source_without_creating_it() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nope.db");
        let error = take_snapshot(&missing, &dir.path().join("migration")).unwrap_err();
        assert!(error.to_string().contains("does not exist"), "{error}");
        assert!(!missing.exists(), "a missing source must never be created");
    }

    // ── CU-4 (R-2.2): the rollback verification decision ────────────────────

    fn recorded(table: &str, rows: i64, checksum: &str) -> PreCutoverTable {
        PreCutoverTable {
            table: table.to_string(),
            rows,
            checksum: checksum.to_string(),
        }
    }

    fn recomputed(table: &str, rows: i64, checksum: &str) -> TableParity {
        TableParity {
            table: table.to_string(),
            source_rows: rows,
            target_rows: rows,
            count_match: true,
            source_checksum: checksum.to_string(),
            target_checksum: checksum.to_string(),
            checksum_match: true,
            read_only_source: true,
            elapsed_ms: 0,
        }
    }

    /// A full match on every table sets `verified = true`.
    #[test]
    fn rollback_verification_sets_on_a_checksum_match() {
        let recorded = vec![
            recorded("settings", 2, "aaa"),
            recorded("rows", 3, "bbb"),
        ];
        let recomputed = vec![
            recomputed("settings", 2, "aaa"),
            recomputed("rows", 3, "bbb"),
        ];
        let verdict = compare_rollback_parity(&recorded, &recomputed);
        assert!(verdict.verified, "every equal checksum must verify: {verdict:?}");
        assert!(verdict.mismatch.is_none());
        assert_eq!(verdict.tables.len(), 2);
        assert!(verdict.tables.iter().all(|check| check.matches));
    }

    /// One checksum mismatch leaves `verified = false` and names the mismatch.
    #[test]
    fn rollback_verification_rejects_a_checksum_mismatch() {
        let recorded = vec![
            recorded("settings", 2, "aaa"),
            recorded("rows", 3, "bbb"),
        ];
        // The snapshot's `rows` checksum drifted.
        let recomputed = vec![
            recomputed("settings", 2, "aaa"),
            recomputed("rows", 3, "bbb-tampered"),
        ];
        let verdict = compare_rollback_parity(&recorded, &recomputed);
        assert!(!verdict.verified, "a checksum mismatch must NOT verify");
        assert_eq!(
            verdict.mismatch.as_deref().map(|m| m.contains("rows")),
            Some(true),
            "the mismatch must name the offending table: {verdict:?}"
        );
        let rows = verdict
            .tables
            .iter()
            .find(|check| check.table == "rows")
            .expect("rows check");
        assert!(!rows.matches);
        assert_eq!(rows.recorded_checksum, "bbb");
        assert_eq!(rows.recomputed_checksum, "bbb-tampered");
        // The matching table is still reported as matching.
        assert!(verdict
            .tables
            .iter()
            .find(|check| check.table == "settings")
            .unwrap()
            .matches);
    }

    /// A recorded table absent from the recomputed set fails closed.
    #[test]
    fn rollback_verification_rejects_a_missing_table() {
        let recorded = vec![recorded("settings", 2, "aaa"), recorded("gone", 1, "zzz")];
        let recomputed = vec![recomputed("settings", 2, "aaa")];
        let verdict = compare_rollback_parity(&recorded, &recomputed);
        assert!(!verdict.verified);
        let missing = verdict
            .tables
            .iter()
            .find(|check| check.table == "gone")
            .expect("missing table check");
        assert!(!missing.matches);
        assert_eq!(missing.recomputed_checksum, "");
    }

    /// An empty recorded set can never verify (nothing to prove).
    #[test]
    fn rollback_verification_rejects_an_empty_reference() {
        let verdict = compare_rollback_parity(&[], &[recomputed("settings", 2, "aaa")]);
        assert!(!verdict.verified);
        assert!(verdict.mismatch.is_some());
    }

    /// The full read-only path: a real snapshot's recomputed parity matches the
    /// recorded pre-cutover values, and a tampered copy does not.
    #[test]
    fn verify_rollback_snapshot_matches_a_real_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("fredo.db");
        let migration_dir = dir.path().join("migration");
        seed_source(&source);
        let record = take_snapshot(&source, &migration_dir).unwrap();

        // Record the pre-cutover reference from the snapshot itself (exactly what
        // the cutover does) — the same values the source `fredo.db` holds.
        let recorded: Vec<PreCutoverTable> = verify_snapshot(&record.path)
            .unwrap()
            .into_iter()
            .map(|parity| PreCutoverTable {
                table: parity.table,
                rows: parity.source_rows,
                checksum: parity.source_checksum,
            })
            .collect();

        let verdict = verify_rollback_snapshot(&record.path, &recorded).unwrap();
        assert!(verdict.verified, "the retained snapshot must verify: {verdict:?}");

        // A tampered copy of the snapshot must NOT verify (read-only check).
        let tampered = dir.path().join("tampered.db");
        std::fs::copy(&record.path, &tampered).unwrap();
        {
            let conn = Connection::open(&tampered).unwrap();
            conn.execute_batch("DELETE FROM settings WHERE key = 'a';").unwrap();
        }
        let tampered_verdict = verify_rollback_snapshot(&tampered, &recorded).unwrap();
        assert!(
            !tampered_verdict.verified,
            "a tampered snapshot must NOT verify: {tampered_verdict:?}"
        );

        // The verification never mutated the retained snapshot.
        let after = verify_snapshot(&record.path).unwrap();
        assert_eq!(after.len(), recorded.len());
        for expected in &recorded {
            let found = after
                .iter()
                .find(|parity| parity.table == expected.table)
                .expect("table after verification");
            assert_eq!(found.source_checksum, expected.checksum);
        }
    }
}
