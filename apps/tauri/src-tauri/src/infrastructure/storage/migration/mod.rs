//! One-shot `fredo.db` → PostgreSQL data migration (Spec #2977, slice 4).
//!
//! This is the missing **pre-install** leg of the swap-once boot: after the
//! managed PostgreSQL server is ready, the candidate pool has its schema inits
//! applied, and *before* the pool is installed into the shared [`EngineHandle`],
//! every physical table of `fredo.db` is copied into PostgreSQL keyed on its
//! primary key — with a per-table count + SHA-256 parity gate, and an executable
//! SQLite snapshot rollback.
//!
//! Fail-closed contract (R-2.2): the completion marker
//! ([`MIGRATION_COMPLETED_KEY`]) is written ONLY after a fully parity-clean run;
//! any mismatch returns `Err` having written no marker, so the caller installs
//! nothing and the app stays on SQLite. The next startup re-runs the idempotent
//! read-only export.
//!
//! Module layout (one concern per file):
//! - [`tables`] — source enumeration + PostgreSQL target DDL derivation
//! - [`copy`] — PK-ordered 512-row chunked copy + per-table parity
//! - [`parity`] — the ONE canonical row encoding + SHA-256
//! - [`snapshot`] — `VACUUM INTO` snapshot, verify, restore (backout)
//! - [`gate`] — the exclusive migration barrier (writer quiesce primitive)
//! - [`run`] — `run_pre_install` + the read-only `migration_status` hook

pub mod copy;
pub mod gate;
pub mod parity;
pub mod run;
pub mod snapshot;
pub mod tables;

use std::path::{Path, PathBuf};
use std::time::Duration;

pub use gate::{MigrationGate, MigrationGuard, MigrationWriterGuard};
pub use parity::{canonical_row_checksum, encode_row, CellValue, RowHasher};
pub use run::{run_pre_install, MigrationStatusView};
pub use snapshot::{restore_snapshot, take_snapshot, verify_snapshot, SnapshotRecord};
pub use tables::{enumerate_tables, ColumnSpec, TableSpec};

/// PostgreSQL `settings` key marking a completed cutover. Written ONLY after a
/// fully parity-clean run, before the pool is installed; read before copying so
/// a completed cutover is skipped on the next boot.
pub const MIGRATION_COMPLETED_KEY: &str = "migration.postgres.completed";

/// **G-275** app-data-dir override: when set (non-blank) the app data root used
/// to resolve the source `fredo.db` AND the AC3 backout target is this path
/// instead of the OS `app_data_dir()`.
///
/// The managed-PostgreSQL distribution install dir ([`super`] FS-1 precedent:
/// `PG_INSTALL_SUBDIR`) and `postgres.lock` deliberately stay under the OS dir,
/// so a fixture run reuses the existing install (no network) and the exclusive
/// lock keeps its stable location. Inert when unset.
pub const DATA_DIR_ENV: &str = "FREDO_DATA_DIR";

/// **G-275** override for the writable scratch/snapshot dir. Default
/// `<app_data_dir>/migration`. Inert when unset.
pub const MIGRATION_DIR_ENV: &str = "FREDO_MIGRATION_DIR";

/// **G-275** the ONE binding fault seam (no second name). Accepted values:
///
/// * `<table>` — drop one row from that table's copy → parity mismatch;
/// * `1` / `true` — drop one row from the first non-empty table (sorted name);
/// * `<table>:export_error` — abort that table's copy with an injected I/O error
///   before parity;
/// * `snapshot_fail` — force the snapshot step to fail.
///
/// Unset ⇒ inert (the default path is byte-identical).
pub const MIGRATION_FORCE_MISMATCH_ENV: &str = "FREDO_MIGRATION_FORCE_MISMATCH";

/// The parsed value of [`MIGRATION_FORCE_MISMATCH_ENV`] — the ONE fault seam.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MigrationFault {
    /// Drop one row from the named table's copy → parity mismatch.
    DropRow(String),
    /// Drop one row from the first non-empty table (sorted name).
    DropRowFirstNonEmpty,
    /// Abort the named table's copy with an injected I/O error before parity.
    ExportError(String),
    /// Force the snapshot step to fail.
    SnapshotFail,
}

/// Parse the [`MIGRATION_FORCE_MISMATCH_ENV`] value.
///
/// `None` (inert) for unset/blank, or an unknown `:`-suffixed form (never
/// guessed). A bare non-blank value names a table to drop a row from.
pub fn parse_migration_fault(raw: &str) -> Option<MigrationFault> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    if raw.eq_ignore_ascii_case("snapshot_fail") {
        return Some(MigrationFault::SnapshotFail);
    }
    if raw == "1" || raw.eq_ignore_ascii_case("true") {
        return Some(MigrationFault::DropRowFirstNonEmpty);
    }
    if let Some((table, kind)) = raw.split_once(':') {
        let table = table.trim();
        if table.is_empty() {
            return None;
        }
        if kind.trim().eq_ignore_ascii_case("export_error") {
            return Some(MigrationFault::ExportError(table.to_string()));
        }
        // Unknown suffix: inert (never guess a fault).
        return None;
    }
    Some(MigrationFault::DropRow(raw.to_string()))
}

/// Read + parse the fault seam from the process environment (inert when unset).
pub fn current_migration_fault() -> Option<MigrationFault> {
    parse_migration_fault(&std::env::var(MIGRATION_FORCE_MISMATCH_ENV).ok()?)
}

/// The ONE app-data-dir resolver (**G-275**): the non-blank [`DATA_DIR_ENV`]
/// override when set, else the OS `app_data_dir()`.
///
/// Injected at `lib.rs` in place of the hardcoded `app.path().app_data_dir()`;
/// the supervisor resolves the SAME dir for the migration source so
/// `<dir>/fredo.db` and `restore_snapshot`'s target can never diverge.
pub fn resolve_app_data_dir(os_app_data_dir: &Path) -> PathBuf {
    match std::env::var(DATA_DIR_ENV) {
        Ok(value) if !value.trim().is_empty() => PathBuf::from(value.trim()),
        _ => os_app_data_dir.to_path_buf(),
    }
}

/// Resolve the writable scratch/snapshot dir (**G-275**): the non-blank
/// [`MIGRATION_DIR_ENV`] override when set, else `<app_data_dir>/migration`.
pub fn resolve_migration_dir(app_data_dir: &Path) -> PathBuf {
    match std::env::var(MIGRATION_DIR_ENV) {
        Ok(value) if !value.trim().is_empty() => PathBuf::from(value.trim()),
        _ => app_data_dir.join("migration"),
    }
}

/// Rows per copy statement — mirrors `RTDB_MAX_EMISSION_BATCH` (R-5.1).
pub const MIGRATION_CHUNK_ROWS: usize = 512;

/// Per-table copy budget floor (ST-8a). Every table gets at least this long for
/// its copy + target re-read, regardless of its size — it covers the per-table
/// overhead (source count, target count/checksum re-read) even for a tiny table.
pub const MIGRATION_TABLE_FLOOR: Duration = Duration::from_secs(120);

/// Conservative per-table throughput floor (ST-8a), in rows per second. Each
/// table's budget is derived from its source row count at this rate; it sits
/// ~2× under the measured real-corpus rate (~21k rows/s), leaving margin for the
/// full target re-read and slower disks.
pub const MIGRATION_MIN_ROWS_PER_SEC: u64 = 10_000;

/// The whole-leg absolute fail-closed ceiling (ST-8a; G-263: still bounded,
/// never unbounded). The per-table budgets are proportional to each table's
/// source size; this caps the total even if many large tables are present. For
/// the real dev corpus the dominant `telemetry_metrics` table's budget is
/// ~1,168 s, so 1,800 s leaves headroom for every other table.
pub const MIGRATION_HARD_CEILING: Duration = Duration::from_secs(1_800);

/// The per-table copy budget for a table with `rows` source rows (ST-8a):
/// [`MIGRATION_TABLE_FLOOR`] + `rows / MIGRATION_MIN_ROWS_PER_SEC` seconds.
///
/// Monotonic in `rows` and always below [`MIGRATION_HARD_CEILING`] for any
/// realistic corpus (the hard ceiling still backstops the whole leg).
pub fn migration_table_budget(rows: i64) -> Duration {
    let rows = rows.max(0) as u64;
    MIGRATION_TABLE_FLOOR + Duration::from_secs(rows / MIGRATION_MIN_ROWS_PER_SEC)
}

/// Wall-clock bound on a migration-gate acquire (writers + the exclusive
/// migration leg). The gate's ACQUIRE bound only waits for in-flight writers to
/// drain — it does not wait for the leg to finish — so it is deliberately
/// unchanged by the per-table budget: a writer still sheds at `GATE_WAIT_BOUND`
/// (the documented bounded-write contract, G-263) even though the leg itself may
/// now run longer.
pub const GATE_WAIT_BOUND: Duration = Duration::from_secs(330);

/// The migration leg's terminal status (R-4).
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "PascalCase")]
pub enum MigrationStatus {
    /// The completion marker was already present — nothing to do.
    Skipped,
    /// The whole export ran and every table passed the parity gate.
    Completed,
    /// The export failed closed; the engine stays on SQLite.
    Failed,
}

/// One table's independent parity pair (R-2.1): row count AND a SHA-256 content
/// checksum over the PK-ordered canonical row encoding. BOTH must match.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableParity {
    /// The physical table name.
    pub table: String,
    /// Source `fredo.db` row count.
    pub source_rows: i64,
    /// PostgreSQL row count.
    pub target_rows: i64,
    /// `source_rows == target_rows`.
    pub count_match: bool,
    /// SHA-256 over the source's PK-ordered canonical encoding.
    pub source_checksum: String,
    /// SHA-256 over the target's PK-ordered canonical encoding.
    pub target_checksum: String,
    /// `source_checksum == target_checksum`.
    pub checksum_match: bool,
    /// Always `true`: the export reads the source through a read-only handle.
    pub read_only_source: bool,
    /// Wall-clock milliseconds spent copying this table (ST-8d diagnostics) —
    /// surfaced as `elapsedMs` in `migration_status`, so a real-corpus
    /// measurement shows exactly which table dominates.
    pub elapsed_ms: u128,
}

/// The result of one `run_pre_install` invocation.
#[derive(Clone, Debug)]
pub struct MigrationOutcome {
    pub status: MigrationStatus,
    pub tables: Vec<TableParity>,
    pub snapshot: Option<SnapshotRecord>,
    pub elapsed_ms: u128,
}

impl MigrationOutcome {
    /// `true` when the marker is set or the run completed cleanly — the two
    /// states in which the store is authoritative on PostgreSQL.
    pub fn completed(&self) -> bool {
        matches!(
            self.status,
            MigrationStatus::Completed | MigrationStatus::Skipped
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Serializes the tests that mutate process-global environment variables.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    struct EnvGuard(&'static str);

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            std::env::remove_var(self.0);
        }
    }

    fn set_env(key: &'static str, value: &str) -> EnvGuard {
        std::env::set_var(key, value);
        EnvGuard(key)
    }

    fn unset_env(key: &'static str) -> EnvGuard {
        std::env::remove_var(key);
        EnvGuard(key)
    }

    #[test]
    fn force_mismatch_parse_table() {
        // Inert: unset/blank, an unknown `:`-suffix, or an empty table name.
        assert_eq!(parse_migration_fault(""), None);
        assert_eq!(parse_migration_fault("   "), None);
        assert_eq!(parse_migration_fault("settings:unknown"), None);
        assert_eq!(parse_migration_fault(":export_error"), None);

        // `1` / `true` → first non-empty table.
        assert_eq!(
            parse_migration_fault("1"),
            Some(MigrationFault::DropRowFirstNonEmpty)
        );
        assert_eq!(
            parse_migration_fault("true"),
            Some(MigrationFault::DropRowFirstNonEmpty)
        );
        assert_eq!(
            parse_migration_fault("TRUE"),
            Some(MigrationFault::DropRowFirstNonEmpty)
        );

        // `snapshot_fail`.
        assert_eq!(
            parse_migration_fault("snapshot_fail"),
            Some(MigrationFault::SnapshotFail)
        );
        assert_eq!(
            parse_migration_fault("Snapshot_Fail"),
            Some(MigrationFault::SnapshotFail)
        );

        // A bare value names a table to drop a row from (trimmed).
        assert_eq!(
            parse_migration_fault("settings"),
            Some(MigrationFault::DropRow("settings".to_string()))
        );
        assert_eq!(
            parse_migration_fault("  chat_rows  "),
            Some(MigrationFault::DropRow("chat_rows".to_string()))
        );

        // `<table>:export_error`.
        assert_eq!(
            parse_migration_fault("telemetry_spans:export_error"),
            Some(MigrationFault::ExportError("telemetry_spans".to_string()))
        );
        assert_eq!(
            parse_migration_fault("telemetry_spans:EXPORT_ERROR"),
            Some(MigrationFault::ExportError("telemetry_spans".to_string()))
        );
    }

    #[test]
    fn resolve_app_data_dir_prefers_a_non_blank_override() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let os = Path::new("C:/os/appdata");
        {
            let _g = unset_env(DATA_DIR_ENV);
            assert_eq!(resolve_app_data_dir(os), PathBuf::from(os));
        }
        {
            let _g = set_env(DATA_DIR_ENV, "  ");
            assert_eq!(
                resolve_app_data_dir(os),
                PathBuf::from(os),
                "a blank override is inert"
            );
        }
        {
            let _g = set_env(DATA_DIR_ENV, "  C:/fixture  ");
            assert_eq!(
                resolve_app_data_dir(os),
                PathBuf::from("C:/fixture"),
                "a non-blank override wins (trimmed)"
            );
        }
    }

    #[test]
    fn resolve_migration_dir_defaults_under_the_app_data_dir() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let app = Path::new("C:/os/appdata");
        {
            let _g = unset_env(MIGRATION_DIR_ENV);
            assert_eq!(resolve_migration_dir(app), app.join("migration"));
        }
        {
            let _g = set_env(MIGRATION_DIR_ENV, "C:/scratch/migration");
            assert_eq!(
                resolve_migration_dir(app),
                PathBuf::from("C:/scratch/migration")
            );
        }
    }

    #[test]
    fn current_migration_fault_is_inert_when_unset() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        {
            let _g = unset_env(MIGRATION_FORCE_MISMATCH_ENV);
            assert_eq!(current_migration_fault(), None);
        }
        {
            let _g = set_env(MIGRATION_FORCE_MISMATCH_ENV, "snapshot_fail");
            assert_eq!(
                current_migration_fault(),
                Some(MigrationFault::SnapshotFail)
            );
        }
    }

    #[test]
    fn migration_table_budget_is_the_floor_at_zero_and_monotonic_in_rows() {
        // A table with no rows still gets the floor (per-table overhead).
        assert_eq!(migration_table_budget(0), MIGRATION_TABLE_FLOOR);
        // A negative count (defensive) clamps to the floor, never subtracts.
        assert_eq!(migration_table_budget(-42), MIGRATION_TABLE_FLOOR);
        // Strictly monotonic in rows.
        assert!(migration_table_budget(10_000) > migration_table_budget(0));
        assert!(migration_table_budget(1_000_000) > migration_table_budget(10_000));
        // The floor is the minimum for every table.
        assert!(migration_table_budget(0) >= MIGRATION_TABLE_FLOOR);
    }

    #[test]
    fn migration_table_budget_fits_the_hard_ceiling_for_the_real_corpus() {
        assert!(
            MIGRATION_TABLE_FLOOR < MIGRATION_HARD_CEILING,
            "the per-table floor must sit under the whole-leg hard ceiling"
        );
        // The real dev corpus' dominant table (`telemetry_metrics`,
        // 10,480,700 rows) needs ~1,168 s at the conservative 10k rows/s floor:
        // >= 1,000 s and strictly under the 1,800 s hard ceiling.
        let real_largest = migration_table_budget(10_480_700);
        assert!(
            real_largest >= Duration::from_secs(1_000),
            "the real corpus' dominant table needs a >= 1,000 s budget, got {real_largest:?}"
        );
        assert!(
            real_largest < MIGRATION_HARD_CEILING,
            "the per-table budget must fit under the hard ceiling, got {real_largest:?}"
        );
    }

    #[test]
    fn table_parity_serializes_elapsed_ms_in_camel_case() {
        let parity = TableParity {
            table: "settings".to_string(),
            source_rows: 2,
            target_rows: 2,
            count_match: true,
            source_checksum: "a".to_string(),
            target_checksum: "a".to_string(),
            checksum_match: true,
            read_only_source: true,
            elapsed_ms: 1_234,
        };
        let json = serde_json::to_value(&parity).unwrap();
        assert_eq!(json["elapsedMs"], 1_234);
    }
}
