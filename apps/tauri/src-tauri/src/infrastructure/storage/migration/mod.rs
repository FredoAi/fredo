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

/// Rows per copy statement — mirrors `RTDB_MAX_EMISSION_BATCH` (R-5.1).
pub const MIGRATION_CHUNK_ROWS: usize = 512;

/// Wall-clock bound on the whole migration leg (G-263: no unbounded wait).
pub const MIGRATION_BOUND: Duration = Duration::from_secs(300);

/// Wall-clock bound on a migration-gate acquire (writers + the exclusive
/// migration leg). Deliberately larger than [`MIGRATION_BOUND`] so a writer can
/// wait out a full migration leg before giving up (G-263).
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
