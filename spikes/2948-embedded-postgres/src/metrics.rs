//! Per-run measurement record emitted by `bench-sqlite` and `bench-pg` as a
//! single JSON line on stdout. `measure` consumes these to build
//! `results/measurements.json`.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RunReport {
    /// `sqlite-baseline` | `embedded-postgres`
    pub name: String,
    /// `bundled-sqlite` | `runtime-download` | `bundled`
    pub mode: String,
    pub run: u32,
    /// Size of the benchmark executable itself.
    pub binary_bytes: u64,
    /// Installed PostgreSQL distribution size (embedded-postgres only).
    #[serde(default)]
    pub distribution_bytes: Option<u64>,
    /// Process start -> first successful query on a fresh data dir.
    pub cold_start_ms: f64,
    /// Peak process-tree working set observed by the bin's own sampler.
    pub peak_rss_bytes: u64,
    /// On-disk size of the data dir after the workload (server stopped).
    pub data_dir_bytes: u64,
    pub upsert_ms: f64,
    pub point_read_ms: f64,
    pub range_read_ms: f64,
    pub rows_final: i64,
    pub measured_at: String,
    pub notes: String,
}
