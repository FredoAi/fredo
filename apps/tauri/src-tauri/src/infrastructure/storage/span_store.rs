//! SpanStore — engine-selected persistence for telemetry spans, logs, and
//! metrics (Spec #2449; PostgreSQL migration Spec #2976, ST-5).
//!
//! Every read and write routes through the ONE shared [`EngineHandle`]
//! (Spec #2975): the incumbent SQLite `fredo.db` by default, the shared
//! PostgreSQL pool once the managed server installs it — no per-store
//! `Mutex<Connection>`, no second pool, no per-store `Connection::open`.
//!
//! ## Schema (1:1 SQLite ⇄ PostgreSQL)
//!
//! ```sql
//! CREATE TABLE telemetry_spans (
//!     trace_id        TEXT NOT NULL,
//!     span_id         TEXT PRIMARY KEY,
//!     parent_span_id  TEXT,
//!     span_name       TEXT NOT NULL,
//!     span_kind       TEXT NOT NULL DEFAULT 'INTERNAL',
//!     start_time_ns   BIGINT NOT NULL,
//!     end_time_ns     BIGINT,
//!     status_code     TEXT NOT NULL DEFAULT 'UNSET',
//!     status_message  TEXT,
//!     session_id      TEXT NOT NULL,
//!     attributes_json TEXT,
//!     events_json     TEXT,
//!     provider        TEXT,
//!     transport       TEXT,
//!     event_type      TEXT,
//!     ingested_at     TEXT NOT NULL
//! );
//! ```
//!
//! The PostgreSQL DDL lives in ONE place — [`PG_TELEMETRY_DDL`] in
//! `storage/engine.rs` — and is run by the startup schema-init registry
//! (`StorageEngineState::register_slice3_pg_schema_inits`) as well as this
//! store's PostgreSQL `ensure_*` arms (NFR-6 spirit: no second DDL source).
//!
//! ## Idempotency
//!
//! `telemetry_spans.span_id` is the PRIMARY KEY. Raw OTLP spans are inserted
//! with `INSERT OR IGNORE` on SQLite and `ON CONFLICT (span_id) DO NOTHING` on
//! PostgreSQL, so a re-exported span is ignored, never overwritten (REQ-12).
//!
//! ## Retention
//!
//! `delete_expired` / `delete_logs_expired` / `delete_metrics_expired` delete
//! in 1000-row batches. `PRAGMA incremental_vacuum` is DROPPED — PostgreSQL
//! autovacuum (and SQLite's own page reuse) owns reclaim; the shared engine's
//! WAL settings are managed by `SqliteEngine::open`.

use anyhow::Result;
use chrono::Utc;
use rusqlite::{params, Connection};
use std::sync::Arc;

use crate::infrastructure::storage::engine::{EngineHandle, StoreEngine, PG_TELEMETRY_DDL};
use crate::infrastructure::telemetry::metrics_collector::{
    MetricPoint, SpanStoreMetricsExt, TelemetryStatsExt,
};
use crate::infrastructure::otlp::raw::RawSpan;
use crate::infrastructure::telemetry::log::LogRecord;
use crate::infrastructure::telemetry::{TelemetrySpan, TelemetryStats};

/// The physical column order of `telemetry_spans` — the ONE source shared by
/// every insert statement and the PostgreSQL multi-row builder.
const SPAN_COLUMNS: &str = "trace_id, span_id, parent_span_id, span_name, span_kind, \
     start_time_ns, end_time_ns, status_code, status_message, session_id, \
     attributes_json, events_json, provider, transport, event_type, ingested_at";

/// Rows per PostgreSQL multi-row INSERT statement (mirrors the RTDB chunking
/// idiom so a large export never becomes one giant statement).
const SPAN_INSERT_CHUNK: usize = 512;

/// Retention delete batch size (rows per statement). Preserved verbatim.
const RETENTION_BATCH: i64 = 1000;

// ── SQLite DDL (unchanged 1:1) ───────────────────────────────────────────────

const SQLITE_SPANS_DDL: &str = "CREATE TABLE IF NOT EXISTS telemetry_spans (
                trace_id        TEXT NOT NULL,
                span_id         TEXT PRIMARY KEY,
                parent_span_id  TEXT,
                span_name       TEXT NOT NULL,
                span_kind       TEXT NOT NULL DEFAULT 'INTERNAL',
                start_time_ns   INTEGER NOT NULL,
                end_time_ns     INTEGER,
                status_code     TEXT NOT NULL DEFAULT 'UNSET',
                status_message  TEXT,
                session_id      TEXT NOT NULL,
                attributes_json TEXT,
                events_json     TEXT,
                provider        TEXT,
                transport       TEXT,
                event_type      TEXT,
                ingested_at     TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_telemetry_spans_trace_id
                ON telemetry_spans(trace_id);
            CREATE INDEX IF NOT EXISTS idx_telemetry_spans_start_time
                ON telemetry_spans(start_time_ns);
            CREATE INDEX IF NOT EXISTS idx_telemetry_spans_session
                ON telemetry_spans(session_id, start_time_ns);
            CREATE INDEX IF NOT EXISTS idx_telemetry_spans_event_type
                ON telemetry_spans(event_type, start_time_ns);
            CREATE INDEX IF NOT EXISTS idx_telemetry_spans_error
                ON telemetry_spans(status_code) WHERE status_code = 'ERROR';";

const SQLITE_LOGS_DDL: &str = "CREATE TABLE IF NOT EXISTS telemetry_logs (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp       TEXT NOT NULL,
                level           TEXT NOT NULL,
                target          TEXT NOT NULL,
                message         TEXT NOT NULL,
                attributes_json TEXT DEFAULT '{}',
                trace_id        TEXT,
                span_id         TEXT,
                session_id      TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON telemetry_logs(timestamp);
            CREATE INDEX IF NOT EXISTS idx_logs_level ON telemetry_logs(level);
            CREATE INDEX IF NOT EXISTS idx_logs_trace_id ON telemetry_logs(trace_id);
            CREATE INDEX IF NOT EXISTS idx_logs_session_id ON telemetry_logs(session_id);";

const SQLITE_METRICS_DDL: &str = "CREATE TABLE IF NOT EXISTS telemetry_metrics (
                id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                metric_name         TEXT NOT NULL,
                metric_type         TEXT NOT NULL,
                labels_json         TEXT DEFAULT '{}',
                value               REAL NOT NULL,
                timestamp           TEXT NOT NULL,
                aggregation_window_s INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_metrics_name_time
                ON telemetry_metrics(metric_name, timestamp);";

/// Engine-selected store for telemetry spans / logs / metrics.
///
/// Holds an `Arc` clone of the ONE shared [`EngineHandle`] — no per-store
/// `Mutex<Connection>`, no second pool.
pub struct SpanStore {
    engine: Arc<EngineHandle>,
}

impl SpanStore {
    /// Wrap the shared engine handle. Every read/write routes through the active
    /// engine; the store never opens its own connection.
    pub fn open(engine: Arc<EngineHandle>) -> Result<Self> {
        Ok(SpanStore { engine })
    }

    /// Test-only convenience: a SQLite-backed store at `<data_dir>/fredo.db`.
    ///
    /// Production callers always pass the shared `EngineHandle` built in
    /// `lib.rs`; this keeps unit tests terse and hermetic without a live pool.
    #[cfg(test)]
    pub fn open_sqlite_for_tests(data_dir: std::path::PathBuf) -> Result<Self> {
        let sqlite = crate::infrastructure::storage::SqliteEngine::open(&data_dir.join("fredo.db"))?;
        Self::open(EngineHandle::new(StoreEngine::Sqlite(sqlite)))
    }

    /// REQ-1: Create the `telemetry_spans` + `telemetry_logs` tables and indexes
    /// if they don't exist, 1:1 with SQLite on PostgreSQL.
    pub async fn ensure_schema(&self) -> Result<()> {
        self.ensure_spans_schema().await?;
        self.ensure_logs_schema().await
    }

    /// Create the `telemetry_spans` table and indexes (idempotent).
    async fn ensure_spans_schema(&self) -> Result<()> {
        let active = self.engine.engine();
        match active.as_ref() {
            StoreEngine::Sqlite(engine) => {
                engine.write_conn().execute_batch(SQLITE_SPANS_DDL)?;
            }
            StoreEngine::Postgres(pg) => {
                sqlx::raw_sql(PG_TELEMETRY_DDL).execute(&pg.pool).await?;
            }
        }
        Ok(())
    }

    /// REQ-4: Create the `telemetry_logs` table and indexes (idempotent).
    pub async fn ensure_logs_schema(&self) -> Result<()> {
        let active = self.engine.engine();
        match active.as_ref() {
            StoreEngine::Sqlite(engine) => {
                engine.write_conn().execute_batch(SQLITE_LOGS_DDL)?;
            }
            StoreEngine::Postgres(pg) => {
                sqlx::raw_sql(PG_TELEMETRY_DDL).execute(&pg.pool).await?;
            }
        }
        Ok(())
    }

    /// REQ-6: Insert completed spans in a batch. Idempotent on `span_id`
    /// (REQ-12): a duplicate is ignored, never overwritten. Returns the number
    /// of rows inserted.
    pub async fn insert_spans(&self, spans: &[TelemetrySpan]) -> Result<usize> {
        if spans.is_empty() {
            return Ok(0);
        }

        let active = self.engine.engine();
        match active.as_ref() {
            StoreEngine::Sqlite(engine) => {
                let conn = engine.write_conn();
                let sql = format!(
                    "INSERT OR IGNORE INTO telemetry_spans ({SPAN_COLUMNS}) VALUES \
                     (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)"
                );
                let mut total = 0usize;
                for span in spans {
                    total += conn.execute(
                        &sql,
                        params![
                            span.trace_id,
                            span.span_id,
                            span.parent_span_id,
                            span.span_name,
                            span.span_kind,
                            span.start_time_ns,
                            span.end_time_ns,
                            span.status_code,
                            span.status_message,
                            span.session_id,
                            span.attributes_json,
                            span.events_json,
                            span.provider,
                            span.transport,
                            span.event_type,
                            span.ingested_at,
                        ],
                    )?;
                }
                Ok(total)
            }
            StoreEngine::Postgres(pg) => {
                let mut total = 0usize;
                for chunk in spans.chunks(SPAN_INSERT_CHUNK) {
                    let sql = pg_span_insert_sql(chunk.len());
                    let mut query = sqlx::query(&sql);
                    for span in chunk {
                        query = query
                            .bind(&span.trace_id)
                            .bind(&span.span_id)
                            .bind(&span.parent_span_id)
                            .bind(&span.span_name)
                            .bind(&span.span_kind)
                            .bind(span.start_time_ns)
                            .bind(span.end_time_ns)
                            .bind(&span.status_code)
                            .bind(&span.status_message)
                            .bind(&span.session_id)
                            .bind(&span.attributes_json)
                            .bind(&span.events_json)
                            .bind(&span.provider)
                            .bind(&span.transport)
                            .bind(&span.event_type)
                            .bind(&span.ingested_at);
                    }
                    total += query.execute(&pg.pool).await?.rows_affected() as usize;
                }
                Ok(total)
            }
        }
    }

    /// Spec #2449 (Capsule S3, R1/R4): Insert raw OTLP spans on receipt at the
    /// OTLP receivers, before and independent of any delivery processing.
    ///
    /// The raw OTLP `span_id` is the row identity, so distinct spans never
    /// collide and a re-exported span is ignored (`ON CONFLICT(span_id) DO
    /// NOTHING`, REQ-12). Shares the ONE insert path with [`Self::insert_spans`].
    /// Returns the number of rows inserted.
    pub async fn insert_raw_spans(&self, spans: &[RawSpan]) -> Result<usize> {
        if spans.is_empty() {
            return Ok(0);
        }
        let converted: Vec<TelemetrySpan> = spans.iter().map(raw_to_telemetry).collect();
        self.insert_spans(&converted).await
    }

    /// REQ-9: Delete spans whose `ingested_at` is older than `retention_days`
    /// days, in [`RETENTION_BATCH`]-row batches. Also deletes expired metrics
    /// and logs (REQ-11). Returns the total number of rows deleted.
    pub async fn delete_expired(&self, retention_days: i64) -> Result<u64> {
        let cutoff_str = (Utc::now() - chrono::Duration::days(retention_days)).to_rfc3339();

        let active = self.engine.engine();
        match active.as_ref() {
            StoreEngine::Sqlite(engine) => {
                let conn = engine.write_conn();
                let mut total = 0u64;
                total += delete_expired_sqlite(
                    &conn,
                    "DELETE FROM telemetry_spans WHERE span_id IN (
                        SELECT span_id FROM telemetry_spans WHERE ingested_at < ?1 LIMIT ?2
                    )",
                    &cutoff_str,
                )?;
                total += delete_expired_sqlite(
                    &conn,
                    "DELETE FROM telemetry_metrics WHERE id IN (
                        SELECT id FROM telemetry_metrics WHERE timestamp < ?1 LIMIT ?2
                    )",
                    &cutoff_str,
                )?;
                total += delete_expired_sqlite(
                    &conn,
                    "DELETE FROM telemetry_logs WHERE id IN (
                        SELECT id FROM telemetry_logs WHERE timestamp < ?1 LIMIT ?2
                    )",
                    &cutoff_str,
                )?;
                Ok(total)
            }
            StoreEngine::Postgres(pg) => {
                let mut total = 0u64;
                total += delete_expired_pg(
                    &pg.pool,
                    "DELETE FROM telemetry_spans WHERE span_id IN (
                        SELECT span_id FROM telemetry_spans WHERE ingested_at < $1 LIMIT $2
                    )",
                    &cutoff_str,
                )
                .await?;
                total += delete_expired_pg(
                    &pg.pool,
                    "DELETE FROM telemetry_metrics WHERE id IN (
                        SELECT id FROM telemetry_metrics WHERE timestamp < $1 LIMIT $2
                    )",
                    &cutoff_str,
                )
                .await?;
                total += delete_expired_pg(
                    &pg.pool,
                    "DELETE FROM telemetry_logs WHERE id IN (
                        SELECT id FROM telemetry_logs WHERE timestamp < $1 LIMIT $2
                    )",
                    &cutoff_str,
                )
                .await?;
                Ok(total)
            }
        }
    }

    /// REQ-12: Return span count and approximate storage size metadata.
    pub async fn stats(&self) -> Result<TelemetryStats> {
        let active = self.engine.engine();
        match active.as_ref() {
            StoreEngine::Sqlite(engine) => {
                let conn = engine.write_conn();
                let span_count: i64 =
                    conn.query_row("SELECT COUNT(*) FROM telemetry_spans", [], |row| row.get(0))?;
                let storage_bytes: i64 = conn.query_row(
                    "SELECT COALESCE(SUM(
                        LENGTH(span_id) + LENGTH(trace_id) + LENGTH(session_id) +
                        LENGTH(span_name) + LENGTH(span_kind) +
                        LENGTH(COALESCE(status_message, '')) +
                        LENGTH(COALESCE(attributes_json, '')) +
                        LENGTH(COALESCE(events_json, '')) +
                        LENGTH(COALESCE(provider, '')) +
                        LENGTH(COALESCE(transport, '')) +
                        LENGTH(COALESCE(event_type, '')) +
                        LENGTH(COALESCE(parent_span_id, '')) +
                        LENGTH(ingested_at)
                    ), 0) FROM telemetry_spans",
                    [],
                    |row| row.get(0),
                )?;
                Ok(TelemetryStats {
                    span_count: span_count as u64,
                    storage_bytes: storage_bytes as u64,
                })
            }
            StoreEngine::Postgres(pg) => {
                let span_count: i64 =
                    sqlx::query_scalar("SELECT COUNT(*) FROM telemetry_spans")
                        .fetch_one(&pg.pool)
                        .await?;
                let storage_bytes: i64 = sqlx::query_scalar(
                    "SELECT CAST(COALESCE(SUM(
                        LENGTH(span_id) + LENGTH(trace_id) + LENGTH(session_id) +
                        LENGTH(span_name) + LENGTH(span_kind) +
                        LENGTH(COALESCE(status_message, '')) +
                        LENGTH(COALESCE(attributes_json, '')) +
                        LENGTH(COALESCE(events_json, '')) +
                        LENGTH(COALESCE(provider, '')) +
                        LENGTH(COALESCE(transport, '')) +
                        LENGTH(COALESCE(event_type, '')) +
                        LENGTH(COALESCE(parent_span_id, '')) +
                        LENGTH(ingested_at)
                    ), 0) AS BIGINT) FROM telemetry_spans",
                )
                .fetch_one(&pg.pool)
                .await?;
                Ok(TelemetryStats {
                    span_count: span_count as u64,
                    storage_bytes: storage_bytes as u64,
                })
            }
        }
    }

    /// REQ-15: Return extended stats including metric point count and log count.
    pub async fn stats_ext(&self) -> Result<TelemetryStatsExt> {
        let stats = self.stats().await?;
        let (metric_point_count, _) = self.metric_stats().await?;
        let (log_count, _) = self.log_stats().await?;
        Ok(TelemetryStatsExt {
            span_count: stats.span_count,
            storage_bytes: stats.storage_bytes,
            metric_point_count,
            log_count,
        })
    }

    /// REQ-12: Delete all rows from the telemetry_spans / telemetry_metrics /
    /// telemetry_logs tables. Returns the count of deleted rows.
    pub async fn purge_all(&self) -> Result<u64> {
        let active = self.engine.engine();
        match active.as_ref() {
            StoreEngine::Sqlite(engine) => {
                let conn = engine.write_conn();
                let spans = conn.execute("DELETE FROM telemetry_spans", [])? as u64;
                let metrics = conn.execute("DELETE FROM telemetry_metrics", [])? as u64;
                let logs = conn.execute("DELETE FROM telemetry_logs", [])? as u64;
                Ok(spans + metrics + logs)
            }
            StoreEngine::Postgres(pg) => {
                let spans = sqlx::query("DELETE FROM telemetry_spans")
                    .execute(&pg.pool)
                    .await?
                    .rows_affected();
                let metrics = sqlx::query("DELETE FROM telemetry_metrics")
                    .execute(&pg.pool)
                    .await?
                    .rows_affected();
                let logs = sqlx::query("DELETE FROM telemetry_logs")
                    .execute(&pg.pool)
                    .await?
                    .rows_affected();
                Ok(spans + metrics + logs)
            }
        }
    }

    // ── Log methods ─────────────────────────────────────────────────────────

    /// REQ-4: Batch-insert log records. Returns the number of rows inserted.
    pub async fn insert_logs(&self, records: &[LogRecord]) -> Result<usize> {
        if records.is_empty() {
            return Ok(0);
        }

        let active = self.engine.engine();
        match active.as_ref() {
            StoreEngine::Sqlite(engine) => {
                let conn = engine.write_conn();
                let sql = "INSERT INTO telemetry_logs
                     (timestamp, level, target, message, attributes_json,
                      trace_id, span_id, session_id)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)";
                let mut total = 0usize;
                for record in records {
                    total += conn.execute(
                        sql,
                        params![
                            record.timestamp,
                            record.level,
                            record.target,
                            record.message,
                            record.attributes_json,
                            record.trace_id,
                            record.span_id,
                            record.session_id,
                        ],
                    )?;
                }
                Ok(total)
            }
            StoreEngine::Postgres(pg) => {
                let sql = "INSERT INTO telemetry_logs
                     (timestamp, level, target, message, attributes_json,
                      trace_id, span_id, session_id)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)";
                let mut total = 0usize;
                for record in records {
                    total += sqlx::query(sql)
                        .bind(&record.timestamp)
                        .bind(&record.level)
                        .bind(&record.target)
                        .bind(&record.message)
                        .bind(&record.attributes_json)
                        .bind(&record.trace_id)
                        .bind(&record.span_id)
                        .bind(&record.session_id)
                        .execute(&pg.pool)
                        .await?
                        .rows_affected() as usize;
                }
                Ok(total)
            }
        }
    }

    /// REQ-4: Stats for telemetry_logs: (record_count, storage_bytes).
    pub async fn log_stats(&self) -> Result<(u64, u64)> {
        let active = self.engine.engine();
        match active.as_ref() {
            StoreEngine::Sqlite(engine) => {
                let conn = engine.write_conn();
                let record_count: i64 =
                    conn.query_row("SELECT COUNT(*) FROM telemetry_logs", [], |row| row.get(0))?;
                let storage_bytes: i64 = conn.query_row(
                    "SELECT COALESCE(SUM(
                        LENGTH(level) + LENGTH(target) + LENGTH(message) +
                        LENGTH(COALESCE(attributes_json, '')) +
                        LENGTH(timestamp)
                    ), 0) FROM telemetry_logs",
                    [],
                    |row| row.get(0),
                )?;
                Ok((record_count as u64, storage_bytes as u64))
            }
            StoreEngine::Postgres(pg) => {
                let record_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM telemetry_logs")
                    .fetch_one(&pg.pool)
                    .await?;
                let storage_bytes: i64 = sqlx::query_scalar(
                    "SELECT CAST(COALESCE(SUM(
                        LENGTH(level) + LENGTH(target) + LENGTH(message) +
                        LENGTH(COALESCE(attributes_json, '')) +
                        LENGTH(timestamp)
                    ), 0) AS BIGINT) FROM telemetry_logs",
                )
                .fetch_one(&pg.pool)
                .await?;
                Ok((record_count as u64, storage_bytes as u64))
            }
        }
    }

    /// REQ-9: Delete expired log entries in [`RETENTION_BATCH`]-row batches.
    pub async fn delete_logs_expired(&self, retention_days: i64) -> Result<u64> {
        let cutoff_str = (Utc::now() - chrono::Duration::days(retention_days)).to_rfc3339();
        let active = self.engine.engine();
        match active.as_ref() {
            StoreEngine::Sqlite(engine) => {
                let conn = engine.write_conn();
                delete_expired_sqlite(
                    &conn,
                    "DELETE FROM telemetry_logs WHERE id IN (
                        SELECT id FROM telemetry_logs WHERE timestamp < ?1 LIMIT ?2
                    )",
                    &cutoff_str,
                )
            }
            StoreEngine::Postgres(pg) => {
                delete_expired_pg(
                    &pg.pool,
                    "DELETE FROM telemetry_logs WHERE id IN (
                        SELECT id FROM telemetry_logs WHERE timestamp < $1 LIMIT $2
                    )",
                    &cutoff_str,
                )
                .await
            }
        }
    }

    /// REQ-9: Delete all log entries.
    pub async fn purge_logs(&self) -> Result<u64> {
        let active = self.engine.engine();
        match active.as_ref() {
            StoreEngine::Sqlite(engine) => {
                let deleted = engine.write_conn().execute("DELETE FROM telemetry_logs", [])?;
                Ok(deleted as u64)
            }
            StoreEngine::Postgres(pg) => {
                let deleted = sqlx::query("DELETE FROM telemetry_logs")
                    .execute(&pg.pool)
                    .await?
                    .rows_affected();
                Ok(deleted)
            }
        }
    }

    /// Test-only: run `f` against the shared SQLite write connection.
    #[cfg(test)]
    pub(crate) fn with_sqlite_conn<R>(&self, f: impl FnOnce(&Connection) -> R) -> R {
        let active = self.engine.engine();
        match active.as_ref() {
            StoreEngine::Sqlite(engine) => {
                let conn = engine.write_conn();
                f(&conn)
            }
            StoreEngine::Postgres(_) => {
                panic!("with_sqlite_conn is test-only and requires the SQLite engine")
            }
        }
    }
}

// ── SpanStoreMetricsExt implementation ──────────────────────────────────────────

#[async_trait::async_trait]
impl SpanStoreMetricsExt for SpanStore {
    /// REQ-9: Create the `telemetry_metrics` table and indexes (idempotent).
    async fn ensure_metrics_schema(&self) -> Result<()> {
        let active = self.engine.engine();
        match active.as_ref() {
            StoreEngine::Sqlite(engine) => {
                engine.write_conn().execute_batch(SQLITE_METRICS_DDL)?;
            }
            StoreEngine::Postgres(pg) => {
                sqlx::raw_sql(PG_TELEMETRY_DDL).execute(&pg.pool).await?;
            }
        }
        Ok(())
    }

    /// REQ-10: Batch-insert pre-aggregated metric points.
    async fn insert_metrics(&self, points: &[MetricPoint]) -> Result<usize> {
        if points.is_empty() {
            return Ok(0);
        }

        let active = self.engine.engine();
        match active.as_ref() {
            StoreEngine::Sqlite(engine) => {
                let conn = engine.write_conn();
                let sql = "INSERT INTO telemetry_metrics
                     (metric_name, metric_type, labels_json, value, timestamp, aggregation_window_s)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)";
                let mut total = 0usize;
                for point in points {
                    total += conn.execute(
                        sql,
                        params![
                            point.metric_name,
                            metric_type_str(point.metric_type),
                            point.labels_json,
                            point.value,
                            point.timestamp,
                            point.aggregation_window_s,
                        ],
                    )?;
                }
                Ok(total)
            }
            StoreEngine::Postgres(pg) => {
                let sql = "INSERT INTO telemetry_metrics
                     (metric_name, metric_type, labels_json, value, timestamp, aggregation_window_s)
                     VALUES ($1, $2, $3, $4, $5, $6)";
                let mut total = 0usize;
                for point in points {
                    total += sqlx::query(sql)
                        .bind(&point.metric_name)
                        .bind(metric_type_str(point.metric_type))
                        .bind(&point.labels_json)
                        .bind(point.value)
                        .bind(&point.timestamp)
                        .bind(point.aggregation_window_s)
                        .execute(&pg.pool)
                        .await?
                        .rows_affected() as usize;
                }
                Ok(total)
            }
        }
    }

    /// Stats for telemetry_metrics: (point_count, storage_bytes).
    async fn metric_stats(&self) -> Result<(u64, u64)> {
        let active = self.engine.engine();
        match active.as_ref() {
            StoreEngine::Sqlite(engine) => {
                let conn = engine.write_conn();
                let point_count: i64 =
                    conn.query_row("SELECT COUNT(*) FROM telemetry_metrics", [], |row| row.get(0))?;
                let storage_bytes: i64 = conn.query_row(
                    "SELECT COALESCE(SUM(
                        LENGTH(metric_name) + LENGTH(metric_type) +
                        LENGTH(COALESCE(labels_json, '')) +
                        LENGTH(timestamp)
                    ), 0) FROM telemetry_metrics",
                    [],
                    |row| row.get(0),
                )?;
                Ok((point_count as u64, storage_bytes as u64))
            }
            StoreEngine::Postgres(pg) => {
                let point_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM telemetry_metrics")
                    .fetch_one(&pg.pool)
                    .await?;
                let storage_bytes: i64 = sqlx::query_scalar(
                    "SELECT CAST(COALESCE(SUM(
                        LENGTH(metric_name) + LENGTH(metric_type) +
                        LENGTH(COALESCE(labels_json, '')) +
                        LENGTH(timestamp)
                    ), 0) AS BIGINT) FROM telemetry_metrics",
                )
                .fetch_one(&pg.pool)
                .await?;
                Ok((point_count as u64, storage_bytes as u64))
            }
        }
    }

    /// REQ-11: Delete expired metric points in [`RETENTION_BATCH`]-row batches.
    async fn delete_metrics_expired(&self, retention_days: i64) -> Result<u64> {
        let cutoff_str = (Utc::now() - chrono::Duration::days(retention_days)).to_rfc3339();
        let active = self.engine.engine();
        match active.as_ref() {
            StoreEngine::Sqlite(engine) => {
                let conn = engine.write_conn();
                delete_expired_sqlite(
                    &conn,
                    "DELETE FROM telemetry_metrics WHERE id IN (
                        SELECT id FROM telemetry_metrics WHERE timestamp < ?1 LIMIT ?2
                    )",
                    &cutoff_str,
                )
            }
            StoreEngine::Postgres(pg) => {
                delete_expired_pg(
                    &pg.pool,
                    "DELETE FROM telemetry_metrics WHERE id IN (
                        SELECT id FROM telemetry_metrics WHERE timestamp < $1 LIMIT $2
                    )",
                    &cutoff_str,
                )
                .await
            }
        }
    }

    /// REQ-12: Delete all metric points.
    async fn purge_metrics(&self) -> Result<u64> {
        let active = self.engine.engine();
        match active.as_ref() {
            StoreEngine::Sqlite(engine) => {
                let deleted = engine.write_conn().execute("DELETE FROM telemetry_metrics", [])?;
                Ok(deleted as u64)
            }
            StoreEngine::Postgres(pg) => {
                let deleted = sqlx::query("DELETE FROM telemetry_metrics")
                    .execute(&pg.pool)
                    .await?
                    .rows_affected();
                Ok(deleted)
            }
        }
    }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/// The persisted `metric_type` token for a [`MetricPoint`] (a data contract —
/// renaming is a migration).
fn metric_type_str(metric_type: crate::infrastructure::telemetry::metrics_collector::MetricType) -> &'static str {
    use crate::infrastructure::telemetry::metrics_collector::MetricType;
    match metric_type {
        MetricType::Counter => "counter",
        MetricType::Gauge => "gauge",
        MetricType::Histogram => "histogram",
    }
}

/// Map a raw OTLP span onto the `telemetry_spans` row shape (identical fields).
fn raw_to_telemetry(span: &RawSpan) -> TelemetrySpan {
    TelemetrySpan {
        trace_id: span.trace_id.clone(),
        span_id: span.span_id.clone(),
        parent_span_id: span.parent_span_id.clone(),
        span_name: span.span_name.clone(),
        span_kind: span.span_kind.clone(),
        start_time_ns: span.start_time_ns,
        end_time_ns: span.end_time_ns,
        status_code: span.status_code.clone(),
        status_message: span.status_message.clone(),
        session_id: span.session_id.clone(),
        attributes_json: span.attributes_json.clone(),
        events_json: span.events_json.clone(),
        provider: span.provider.clone(),
        transport: span.transport.clone(),
        event_type: span.event_type.clone(),
        ingested_at: span.ingested_at.clone(),
    }
}

/// The PostgreSQL multi-row insert for `rows` spans, idempotent on `span_id`.
fn pg_span_insert_sql(rows: usize) -> String {
    let mut value_rows = Vec::with_capacity(rows);
    for r in 0..rows {
        let cols: Vec<String> = (0..16).map(|c| format!("${}", r * 16 + c + 1)).collect();
        value_rows.push(format!("({})", cols.join(", ")));
    }
    format!(
        "INSERT INTO telemetry_spans ({SPAN_COLUMNS}) VALUES {} ON CONFLICT (span_id) DO NOTHING",
        value_rows.join(", ")
    )
}

/// Run one batched SQLite retention DELETE until it deletes nothing. No
/// `PRAGMA incremental_vacuum` — reclaim is the engine's concern.
fn delete_expired_sqlite(conn: &Connection, sql: &str, cutoff: &str) -> Result<u64> {
    let mut total = 0u64;
    loop {
        let deleted = conn.execute(sql, params![cutoff, RETENTION_BATCH])? as u64;
        if deleted == 0 {
            break;
        }
        total += deleted;
    }
    Ok(total)
}

/// Run one batched PostgreSQL retention DELETE until it deletes nothing.
async fn delete_expired_pg(pool: &sqlx::PgPool, sql: &str, cutoff: &str) -> Result<u64> {
    let mut total = 0u64;
    loop {
        let deleted = sqlx::query(sql)
            .bind(cutoff)
            .bind(RETENTION_BATCH)
            .execute(pool)
            .await?
            .rows_affected();
        if deleted == 0 {
            break;
        }
        total += deleted;
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::telemetry::TelemetrySpan;
    use tempfile::TempDir;

    fn make_store() -> (TempDir, SpanStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = SpanStore::open_sqlite_for_tests(dir.path().to_path_buf()).unwrap();
        (dir, store)
    }

    fn make_span(span_id: &str, session_id: &str, status: &str) -> TelemetrySpan {
        TelemetrySpan {
            trace_id: session_id.to_string(),
            span_id: span_id.to_string(),
            parent_span_id: None,
            span_name: "test.op".to_string(),
            span_kind: "INTERNAL".to_string(),
            start_time_ns: 1000,
            end_time_ns: None,
            status_code: status.to_string(),
            status_message: None,
            session_id: session_id.to_string(),
            attributes_json: None,
            events_json: None,
            provider: Some("open_code".to_string()),
            transport: Some("hook".to_string()),
            event_type: Some("tool_use".to_string()),
            ingested_at: Utc::now().to_rfc3339(),
        }
    }

    // ── AC-1: Schema creation ───────────────────────────────────────────────

    #[tokio::test]
    async fn test_ensure_schema_creates_table() {
        let (_dir, store) = make_store();
        store.ensure_schema().await.unwrap();

        let table_count: i64 = store.with_sqlite_conn(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='telemetry_spans'",
                [],
                |row| row.get(0),
            )
            .unwrap()
        });
        assert_eq!(table_count, 1, "telemetry_spans table should exist");

        // Verify column count (16 columns)
        let col_count: i64 = store.with_sqlite_conn(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM pragma_table_info('telemetry_spans')",
                [],
                |row| row.get(0),
            )
            .unwrap()
        });
        assert_eq!(col_count, 16, "telemetry_spans should have 16 columns");

        // Verify specific columns exist
        let cols: Vec<String> = store.with_sqlite_conn(|conn| {
            conn.prepare("SELECT name FROM pragma_table_info('telemetry_spans')")
                .unwrap()
                .query_map([], |row| row.get::<_, String>(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        });
        for required in &[
            "trace_id",
            "span_id",
            "parent_span_id",
            "span_name",
            "span_kind",
            "start_time_ns",
            "end_time_ns",
            "status_code",
            "status_message",
            "session_id",
            "attributes_json",
            "events_json",
            "provider",
            "transport",
            "event_type",
            "ingested_at",
        ] {
            assert!(
                cols.contains(&required.to_string()),
                "column '{}' should exist",
                required
            );
        }
    }

    #[tokio::test]
    async fn test_ensure_schema_creates_indexes() {
        let (_dir, store) = make_store();
        store.ensure_schema().await.unwrap();

        let indexes: Vec<String> = store.with_sqlite_conn(|conn| {
            conn.prepare("SELECT name FROM pragma_index_list('telemetry_spans')")
                .unwrap()
                .query_map([], |row| row.get::<_, String>(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        });

        let expected = [
            "idx_telemetry_spans_trace_id",
            "idx_telemetry_spans_start_time",
            "idx_telemetry_spans_session",
            "idx_telemetry_spans_event_type",
            "idx_telemetry_spans_error",
        ];
        for name in &expected {
            assert!(
                indexes.contains(&name.to_string()),
                "index '{}' should exist",
                name
            );
        }
    }

    // ── Insert spans ────────────────────────────────────────────────────────

    #[tokio::test]
    async fn test_insert_spans_returns_count() {
        let (_dir, store) = make_store();
        store.ensure_schema().await.unwrap();

        let span = make_span("s1", "sess-1", "OK");
        let span2 = make_span("s2", "sess-1", "ERROR");

        let inserted = store.insert_spans(&[span, span2]).await.unwrap();
        assert_eq!(inserted, 2);
    }

    #[tokio::test]
    async fn test_insert_spans_empty_slice() {
        let (_dir, store) = make_store();
        store.ensure_schema().await.unwrap();

        let inserted = store.insert_spans(&[]).await.unwrap();
        assert_eq!(inserted, 0);
    }

    #[tokio::test]
    async fn test_insert_duplicate_span_id_is_ignored() {
        let (_dir, store) = make_store();
        store.ensure_schema().await.unwrap();

        let span = make_span("dup", "sess-1", "OK");
        let span_dup = make_span("dup", "sess-2", "ERROR");

        let first = store.insert_spans(&[span]).await.unwrap();
        assert_eq!(first, 1);

        let second = store.insert_spans(&[span_dup]).await.unwrap();
        assert_eq!(second, 0, "duplicate span_id should be ignored");
    }

    // ── Spec #2449 (Capsule S3): Raw OTLP span ingestion ───────────────────

    fn make_raw_span(span_id: &str, session_id: &str, status: &str) -> RawSpan {
        RawSpan {
            trace_id: session_id.to_string(),
            span_id: span_id.to_string(),
            parent_span_id: None,
            span_name: "my.llm".to_string(),
            span_kind: "INTERNAL".to_string(),
            start_time_ns: 1000,
            end_time_ns: None,
            status_code: status.to_string(),
            status_message: None,
            session_id: session_id.to_string(),
            attributes_json: None,
            events_json: None,
            provider: Some("copilot-cli".to_string()),
            transport: Some("otlp_grpc".to_string()),
            event_type: Some("chat".to_string()),
            ingested_at: Utc::now().to_rfc3339(),
        }
    }

    #[tokio::test]
    async fn test_insert_raw_spans_returns_count() {
        let (_dir, store) = make_store();
        store.ensure_schema().await.unwrap();

        let span = make_raw_span("raw-a", "sess-raw-1", "OK");
        let span2 = make_raw_span("raw-b", "sess-raw-2", "ERROR");

        let inserted = store.insert_raw_spans(&[span, span2]).await.unwrap();
        assert_eq!(inserted, 2);

        let stats = store.stats().await.unwrap();
        assert_eq!(stats.span_count, 2);
    }

    #[tokio::test]
    async fn test_insert_raw_spans_empty_slice() {
        let (_dir, store) = make_store();
        store.ensure_schema().await.unwrap();

        let inserted = store.insert_raw_spans(&[]).await.unwrap();
        assert_eq!(inserted, 0);
    }

    #[tokio::test]
    async fn test_insert_raw_spans_distinct_span_ids_both_persist() {
        // R4: no PRIMARY KEY collision between distinct raw OTLP span_ids.
        let (_dir, store) = make_store();
        store.ensure_schema().await.unwrap();

        let span_a = make_raw_span("span-id-a", "sess-raw-1", "OK");
        let span_b = make_raw_span("span-id-b", "sess-raw-2", "OK");

        let inserted = store.insert_raw_spans(&[span_a, span_b]).await.unwrap();
        assert_eq!(inserted, 2, "both distinct span_ids must insert");

        let (count, session_a, session_b) = store.with_sqlite_conn(|conn| {
            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM telemetry_spans WHERE span_id IN ('span-id-a', 'span-id-b')",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            let session_a: String = conn
                .query_row(
                    "SELECT session_id FROM telemetry_spans WHERE span_id = 'span-id-a'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            let session_b: String = conn
                .query_row(
                    "SELECT session_id FROM telemetry_spans WHERE span_id = 'span-id-b'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            (count, session_a, session_b)
        });
        assert_eq!(count, 2, "both rows must exist — no PK collision");
        assert_eq!(session_a, "sess-raw-1");
        assert_eq!(session_b, "sess-raw-2");
    }

    #[tokio::test]
    async fn test_insert_raw_spans_preserves_raw_identity() {
        let (_dir, store) = make_store();
        store.ensure_schema().await.unwrap();

        let raw = RawSpan {
            trace_id: "trace-raw".to_string(),
            span_id: "raw-span-1".to_string(),
            parent_span_id: Some("raw-parent-1".to_string()),
            span_name: "fredo.tool.Read".to_string(),
            span_kind: "INTERNAL".to_string(),
            start_time_ns: 1_700_000_000_000_000_000,
            end_time_ns: Some(1_700_000_000_500_000_000),
            status_code: "OK".to_string(),
            status_message: Some("done".to_string()),
            session_id: "sess-raw".to_string(),
            attributes_json: Some(r#"{"gen_ai.operation.name":"execute_tool"}"#.to_string()),
            events_json: None,
            provider: Some("open-code".to_string()),
            transport: Some("otlp_http".to_string()),
            event_type: Some("tool_use".to_string()),
            ingested_at: "2026-08-08T00:00:00+00:00".to_string(),
        };
        store.insert_raw_spans(&[raw]).await.unwrap();

        let (span_name, transport, event_type, parent): (String, String, String, String) =
            store.with_sqlite_conn(|conn| {
                conn.query_row(
                    "SELECT span_name, transport, event_type, parent_span_id
                     FROM telemetry_spans WHERE span_id = 'raw-span-1'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .unwrap()
            });
        assert_eq!(span_name, "fredo.tool.Read", "raw span name preserved");
        assert_eq!(transport, "otlp_http");
        assert_eq!(event_type, "tool_use");
        assert_eq!(parent, "raw-parent-1");
    }

    #[tokio::test]
    async fn test_insert_raw_spans_duplicate_span_id_is_ignored() {
        let (_dir, store) = make_store();
        store.ensure_schema().await.unwrap();

        let first = store
            .insert_raw_spans(&[make_raw_span("raw-dup", "sess-1", "OK")])
            .await
            .unwrap();
        assert_eq!(first, 1);

        let second = store
            .insert_raw_spans(&[make_raw_span("raw-dup", "sess-2", "ERROR")])
            .await
            .unwrap();
        assert_eq!(second, 0, "duplicate raw span_id should be ignored (idempotent re-export)");

        let stats = store.stats().await.unwrap();
        assert_eq!(stats.span_count, 1);
    }

    // ── Stats ───────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn test_stats_empty_store() {
        let (_dir, store) = make_store();
        store.ensure_schema().await.unwrap();

        let stats = store.stats().await.unwrap();
        assert_eq!(stats.span_count, 0);
        assert_eq!(stats.storage_bytes, 0);
    }

    #[tokio::test]
    async fn test_stats_with_spans() {
        let (_dir, store) = make_store();
        store.ensure_schema().await.unwrap();

        let span = TelemetrySpan {
            trace_id: "trace-1".to_string(),
            span_id: "span-1".to_string(),
            parent_span_id: None,
            span_name: "test".to_string(),
            span_kind: "INTERNAL".to_string(),
            start_time_ns: 1000,
            end_time_ns: Some(2000),
            status_code: "OK".to_string(),
            status_message: None,
            session_id: "sess-1".to_string(),
            attributes_json: Some(r#"{"key":"value"}"#.to_string()),
            events_json: None,
            provider: Some("open_code".to_string()),
            transport: Some("hook".to_string()),
            event_type: Some("tool_use".to_string()),
            ingested_at: Utc::now().to_rfc3339(),
        };

        store.insert_spans(&[span]).await.unwrap();

        let stats = store.stats().await.unwrap();
        assert_eq!(stats.span_count, 1);
        assert!(
            stats.storage_bytes > 0,
            "storage_bytes should be > 0 for a populated span"
        );
    }

    // ── Purge ───────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn test_purge_all_returns_count() {
        let (_dir, store) = make_store();
        store.ensure_schema().await.unwrap();
        store.ensure_metrics_schema().await.unwrap();

        store
            .insert_spans(&[
                make_span("p1", "sess", "OK"),
                make_span("p2", "sess", "ERROR"),
            ])
            .await
            .unwrap();

        let deleted = store.purge_all().await.unwrap();
        assert_eq!(deleted, 2);

        let stats = store.stats().await.unwrap();
        assert_eq!(stats.span_count, 0);
    }

    // ── Delete expired ──────────────────────────────────────────────────────

    #[tokio::test]
    async fn test_delete_expired_removes_old_spans() {
        let (_dir, store) = make_store();
        store.ensure_schema().await.unwrap();
        store.ensure_metrics_schema().await.unwrap();

        // Insert a span with a very old ingested_at
        let old_span = TelemetrySpan {
            ingested_at: "2020-01-01T00:00:00+00:00".to_string(),
            ..make_span("old", "sess-old", "OK")
        };
        let fresh_span = make_span("fresh", "sess-fresh", "OK");

        store.insert_spans(&[old_span, fresh_span]).await.unwrap();

        // Delete with retention of 1 day — the old span (2020) should be deleted
        let deleted = store.delete_expired(1).await.unwrap();
        assert_eq!(deleted, 1, "should delete the old span");

        let stats = store.stats().await.unwrap();
        assert_eq!(stats.span_count, 1, "fresh span should remain");
    }

    #[tokio::test]
    async fn test_delete_expired_no_spans_to_delete() {
        let (_dir, store) = make_store();
        store.ensure_schema().await.unwrap();
        store.ensure_metrics_schema().await.unwrap();

        let span = make_span("current", "sess", "OK");
        store.insert_spans(&[span]).await.unwrap();

        // Retention of 365 days — spans ingested today should not be deleted
        let deleted = store.delete_expired(365).await.unwrap();
        assert_eq!(deleted, 0);

        let stats = store.stats().await.unwrap();
        assert_eq!(stats.span_count, 1);
    }

    // ── Insert many spans ───────────────────────────────────────────────────

    #[tokio::test]
    async fn test_insert_many_spans() {
        let (_dir, store) = make_store();
        store.ensure_schema().await.unwrap();

        let spans: Vec<TelemetrySpan> = (0..100)
            .map(|i| make_span(&format!("batch-{}", i), "sess-batch", "OK"))
            .collect();

        let inserted = store.insert_spans(&spans).await.unwrap();
        assert_eq!(inserted, 100);

        let stats = store.stats().await.unwrap();
        assert_eq!(stats.span_count, 100);
    }

    // ── Metrics Schema (AC-8) ───────────────────────────────────────────────

    #[tokio::test]
    async fn test_ensure_metrics_schema_creates_table() {
        let (_dir, store) = make_store();
        store.ensure_metrics_schema().await.unwrap();

        let (table_count, col_count, cols) = store.with_sqlite_conn(|conn| {
            let table_count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='telemetry_metrics'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            let col_count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('telemetry_metrics')",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            let cols: Vec<String> = conn
                .prepare("SELECT name FROM pragma_table_info('telemetry_metrics')")
                .unwrap()
                .query_map([], |row| row.get::<_, String>(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            (table_count, col_count, cols)
        });
        assert_eq!(table_count, 1, "telemetry_metrics table should exist");
        assert_eq!(col_count, 7, "telemetry_metrics should have 7 columns");

        for required in &[
            "id", "metric_name", "metric_type", "labels_json",
            "value", "timestamp", "aggregation_window_s",
        ] {
            assert!(
                cols.contains(&required.to_string()),
                "column '{}' should exist",
                required
            );
        }
    }

    #[tokio::test]
    async fn test_ensure_metrics_schema_creates_index() {
        let (_dir, store) = make_store();
        store.ensure_metrics_schema().await.unwrap();

        let indexes: Vec<String> = store.with_sqlite_conn(|conn| {
            conn.prepare("SELECT name FROM pragma_index_list('telemetry_metrics')")
                .unwrap()
                .query_map([], |row| row.get::<_, String>(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        });

        assert!(
            indexes.contains(&"idx_metrics_name_time".to_string()),
            "index 'idx_metrics_name_time' should exist"
        );
    }

    // ── Insert Metrics (AC-9) ───────────────────────────────────────────────

    #[tokio::test]
    async fn test_insert_metrics_returns_count() {
        let (_dir, store) = make_store();
        store.ensure_metrics_schema().await.unwrap();

        let points = vec![
            MetricPoint {
                metric_name: "span_count".to_string(),
                metric_type: crate::infrastructure::telemetry::metrics_collector::MetricType::Counter,
                labels_json: r#"{"span_name":"tool_use.read","status":"ok"}"#.to_string(),
                value: 5.0,
                timestamp: "2025-01-01T00:00:00+00:00".to_string(),
                aggregation_window_s: 60,
            },
            MetricPoint {
                metric_name: "span_duration_ms".to_string(),
                metric_type: crate::infrastructure::telemetry::metrics_collector::MetricType::Histogram,
                labels_json: r#"{"span_name":"tool_use.read","le":"50"}"#.to_string(),
                value: 3.0,
                timestamp: "2025-01-01T00:00:00+00:00".to_string(),
                aggregation_window_s: 60,
            },
        ];

        let inserted = store.insert_metrics(&points).await.unwrap();
        assert_eq!(inserted, 2);
    }

    #[tokio::test]
    async fn test_insert_metrics_empty_slice() {
        let (_dir, store) = make_store();
        store.ensure_metrics_schema().await.unwrap();

        let inserted = store.insert_metrics(&[]).await.unwrap();
        assert_eq!(inserted, 0);
    }

    #[tokio::test]
    async fn test_metric_stats_empty() {
        let (_dir, store) = make_store();
        store.ensure_metrics_schema().await.unwrap();

        let (point_count, storage_bytes) = store.metric_stats().await.unwrap();
        assert_eq!(point_count, 0);
        assert_eq!(storage_bytes, 0);
    }

    #[tokio::test]
    async fn test_metric_stats_after_insert() {
        let (_dir, store) = make_store();
        store.ensure_metrics_schema().await.unwrap();

        let points: Vec<MetricPoint> = (0..5)
            .map(|i| MetricPoint {
                metric_name: format!("test.metric.{}", i),
                metric_type: crate::infrastructure::telemetry::metrics_collector::MetricType::Counter,
                labels_json: "{}".to_string(),
                value: i as f64,
                timestamp: "2025-01-01T00:00:00+00:00".to_string(),
                aggregation_window_s: 60,
            })
            .collect();

        let inserted = store.insert_metrics(&points).await.unwrap();
        assert_eq!(inserted, 5);

        let (point_count, storage_bytes) = store.metric_stats().await.unwrap();
        assert_eq!(point_count, 5, "should return point_count=5");
        assert!(storage_bytes > 0, "storage_bytes should be > 0");
    }

    // ── Delete expired metrics (AC-10) ───────────────────────────────────────

    #[tokio::test]
    async fn test_delete_metrics_expired_removes_old_points() {
        let (_dir, store) = make_store();
        store.ensure_metrics_schema().await.unwrap();

        let old_metric = MetricPoint {
            metric_name: "old_counter".to_string(),
            metric_type: crate::infrastructure::telemetry::metrics_collector::MetricType::Counter,
            labels_json: "{}".to_string(),
            value: 1.0,
            timestamp: "2020-01-01T00:00:00+00:00".to_string(),
            aggregation_window_s: 60,
        };
        let fresh_metric = MetricPoint {
            metric_name: "fresh_counter".to_string(),
            metric_type: crate::infrastructure::telemetry::metrics_collector::MetricType::Counter,
            labels_json: "{}".to_string(),
            value: 2.0,
            timestamp: chrono::Utc::now().to_rfc3339(),
            aggregation_window_s: 60,
        };

        store.insert_metrics(&[old_metric, fresh_metric]).await.unwrap();

        let (before_count, _) = store.metric_stats().await.unwrap();
        assert_eq!(before_count, 2);

        let deleted = store.delete_metrics_expired(1).await.unwrap();
        assert_eq!(deleted, 1, "should delete the old metric point");

        let (after_count, _) = store.metric_stats().await.unwrap();
        assert_eq!(after_count, 1, "fresh metric point should remain");
    }

    #[tokio::test]
    async fn test_delete_metrics_expired_no_points_to_delete() {
        let (_dir, store) = make_store();
        store.ensure_metrics_schema().await.unwrap();

        let metric = MetricPoint {
            metric_name: "current_counter".to_string(),
            metric_type: crate::infrastructure::telemetry::metrics_collector::MetricType::Counter,
            labels_json: "{}".to_string(),
            value: 1.0,
            timestamp: chrono::Utc::now().to_rfc3339(),
            aggregation_window_s: 60,
        };

        store.insert_metrics(&[metric]).await.unwrap();

        let deleted = store.delete_metrics_expired(365).await.unwrap();
        assert_eq!(deleted, 0);
    }

    // ── Purge metrics (AC-11) ────────────────────────────────────────────────

    #[tokio::test]
    async fn test_purge_metrics_clears_all() {
        let (_dir, store) = make_store();
        store.ensure_metrics_schema().await.unwrap();

        let points: Vec<MetricPoint> = (0..3)
            .map(|i| MetricPoint {
                metric_name: format!("m{}", i),
                metric_type: crate::infrastructure::telemetry::metrics_collector::MetricType::Counter,
                labels_json: "{}".to_string(),
                value: i as f64,
                timestamp: "2025-01-01T00:00:00+00:00".to_string(),
                aggregation_window_s: 60,
            })
            .collect();

        store.insert_metrics(&points).await.unwrap();

        let deleted = store.purge_metrics().await.unwrap();
        assert_eq!(deleted, 3);

        let (point_count, _) = store.metric_stats().await.unwrap();
        assert_eq!(point_count, 0);
    }

    #[tokio::test]
    async fn test_purge_all_includes_metrics() {
        let (_dir, store) = make_store();
        store.ensure_schema().await.unwrap();
        store.ensure_metrics_schema().await.unwrap();

        // Insert a span
        store.insert_spans(&[make_span("s1", "sess", "OK")]).await.unwrap();

        // Insert a metric
        let metric = MetricPoint {
            metric_name: "counter".to_string(),
            metric_type: crate::infrastructure::telemetry::metrics_collector::MetricType::Counter,
            labels_json: "{}".to_string(),
            value: 1.0,
            timestamp: "2025-01-01T00:00:00+00:00".to_string(),
            aggregation_window_s: 60,
        };
        store.insert_metrics(&[metric]).await.unwrap();

        let deleted = store.purge_all().await.unwrap();
        assert_eq!(deleted, 2, "should delete 1 span + 1 metric");

        let stats = store.stats().await.unwrap();
        assert_eq!(stats.span_count, 0);

        let (point_count, _) = store.metric_stats().await.unwrap();
        assert_eq!(point_count, 0);
    }

    // ── Extended stats (REQ-15) ──────────────────────────────────────────────

    #[tokio::test]
    async fn test_stats_ext_includes_metric_and_log_count() {
        let (_dir, store) = make_store();
        store.ensure_schema().await.unwrap();
        store.ensure_metrics_schema().await.unwrap();

        // Insert a span
        store.insert_spans(&[make_span("s-ext", "sess", "OK")]).await.unwrap();

        // Insert a metric
        let metric = MetricPoint {
            metric_name: "test_counter".to_string(),
            metric_type: crate::infrastructure::telemetry::metrics_collector::MetricType::Counter,
            labels_json: "{}".to_string(),
            value: 42.0,
            timestamp: "2025-01-01T00:00:00+00:00".to_string(),
            aggregation_window_s: 60,
        };
        store.insert_metrics(&[metric]).await.unwrap();

        // Insert a log record
        let log = crate::infrastructure::telemetry::log::LogRecord {
            timestamp: "2025-01-01T00:00:00+00:00".to_string(),
            level: "INFO".to_string(),
            target: "fredo::test".to_string(),
            message: "test log".to_string(),
            attributes_json: "{}".to_string(),
            trace_id: None,
            span_id: None,
            session_id: None,
        };
        store.insert_logs(&[log]).await.unwrap();

        let ext_stats = store.stats_ext().await.unwrap();
        assert_eq!(ext_stats.span_count, 1);
        assert_eq!(ext_stats.metric_point_count, 1);
        assert_eq!(ext_stats.log_count, 1);
        assert!(ext_stats.storage_bytes > 0);
    }

    // ── Log methods tests ──────────────────────────────────────────────────

    fn make_log_record() -> crate::infrastructure::telemetry::log::LogRecord {
        crate::infrastructure::telemetry::log::LogRecord {
            timestamp: chrono::Utc::now().to_rfc3339(),
            level: "INFO".to_string(),
            target: "fredo::test".to_string(),
            message: "test log".to_string(),
            attributes_json: r#"{"key":"value"}"#.to_string(),
            trace_id: None,
            span_id: None,
            session_id: None,
        }
    }

    #[tokio::test]
    async fn test_ensure_logs_schema_creates_table() {
        let (_dir, store) = make_store();
        store.ensure_logs_schema().await.unwrap();

        let (table_count, col_count, cols) = store.with_sqlite_conn(|conn| {
            let table_count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='telemetry_logs'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            let col_count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('telemetry_logs')",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            let cols: Vec<String> = conn
                .prepare("SELECT name FROM pragma_table_info('telemetry_logs')")
                .unwrap()
                .query_map([], |row| row.get::<_, String>(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            (table_count, col_count, cols)
        });
        assert_eq!(table_count, 1, "telemetry_logs table should exist");
        assert_eq!(col_count, 9, "telemetry_logs should have 9 columns");

        for required in &[
            "id", "timestamp", "level", "target", "message",
            "attributes_json", "trace_id", "span_id", "session_id",
        ] {
            assert!(
                cols.contains(&required.to_string()),
                "column '{}' should exist",
                required
            );
        }
    }

    #[tokio::test]
    async fn test_ensure_logs_schema_creates_indexes() {
        let (_dir, store) = make_store();
        store.ensure_logs_schema().await.unwrap();

        let indexes: Vec<String> = store.with_sqlite_conn(|conn| {
            conn.prepare("SELECT name FROM pragma_index_list('telemetry_logs')")
                .unwrap()
                .query_map([], |row| row.get::<_, String>(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        });

        let expected = [
            "idx_logs_timestamp",
            "idx_logs_level",
            "idx_logs_trace_id",
            "idx_logs_session_id",
        ];
        for name in &expected {
            assert!(
                indexes.contains(&name.to_string()),
                "index '{}' should exist",
                name
            );
        }
    }

    #[tokio::test]
    async fn test_insert_logs_returns_count() {
        let (_dir, store) = make_store();
        store.ensure_logs_schema().await.unwrap();

        let log = make_log_record();
        let log2 = crate::infrastructure::telemetry::log::LogRecord {
            level: "ERROR".to_string(),
            ..make_log_record()
        };

        let inserted = store.insert_logs(&[log, log2]).await.unwrap();
        assert_eq!(inserted, 2);
    }

    #[tokio::test]
    async fn test_insert_logs_empty_slice() {
        let (_dir, store) = make_store();
        store.ensure_logs_schema().await.unwrap();

        let inserted = store.insert_logs(&[]).await.unwrap();
        assert_eq!(inserted, 0);
    }

    #[tokio::test]
    async fn test_log_stats_empty() {
        let (_dir, store) = make_store();
        store.ensure_logs_schema().await.unwrap();

        let (count, bytes) = store.log_stats().await.unwrap();
        assert_eq!(count, 0);
        assert_eq!(bytes, 0);
    }

    #[tokio::test]
    async fn test_log_stats_after_insert() {
        let (_dir, store) = make_store();
        store.ensure_logs_schema().await.unwrap();

        let logs: Vec<crate::infrastructure::telemetry::log::LogRecord> = (0..3)
            .map(|i| crate::infrastructure::telemetry::log::LogRecord {
                level: "INFO".to_string(),
                target: "fredo::test".to_string(),
                message: format!("test {}", i),
                attributes_json: "{}".to_string(),
                timestamp: "2025-01-01T00:00:00+00:00".to_string(),
                trace_id: None,
                span_id: None,
                session_id: None,
            })
            .collect();

        let inserted = store.insert_logs(&logs).await.unwrap();
        assert_eq!(inserted, 3);

        let (count, bytes) = store.log_stats().await.unwrap();
        assert_eq!(count, 3);
        assert!(bytes > 0, "storage_bytes should be > 0");
    }

    #[tokio::test]
    async fn test_delete_logs_expired_removes_old_entries() {
        let (_dir, store) = make_store();
        store.ensure_logs_schema().await.unwrap();

        // Insert a log with old timestamp
        let old_log = crate::infrastructure::telemetry::log::LogRecord {
            timestamp: "2020-01-01T00:00:00+00:00".to_string(),
            level: "INFO".to_string(),
            target: "fredo::test".to_string(),
            message: "old".to_string(),
            attributes_json: "{}".to_string(),
            trace_id: None,
            span_id: None,
            session_id: None,
        };
        let fresh_log = make_log_record();

        store.insert_logs(&[old_log, fresh_log]).await.unwrap();

        let (before_count, _) = store.log_stats().await.unwrap();
        assert_eq!(before_count, 2);

        let deleted = store.delete_logs_expired(1).await.unwrap();
        assert_eq!(deleted, 1, "should delete the old log entry");

        let (after_count, _) = store.log_stats().await.unwrap();
        assert_eq!(after_count, 1, "fresh log entry should remain");
    }

    #[tokio::test]
    async fn test_delete_logs_expired_no_entries_to_delete() {
        let (_dir, store) = make_store();
        store.ensure_logs_schema().await.unwrap();

        let log = make_log_record();
        store.insert_logs(&[log]).await.unwrap();

        let deleted = store.delete_logs_expired(365).await.unwrap();
        assert_eq!(deleted, 0);
    }

    #[tokio::test]
    async fn test_purge_logs_clears_all() {
        let (_dir, store) = make_store();
        store.ensure_logs_schema().await.unwrap();

        let logs: Vec<crate::infrastructure::telemetry::log::LogRecord> = (0..3)
            .map(|i| crate::infrastructure::telemetry::log::LogRecord {
                level: "INFO".to_string(),
                target: "fredo::test".to_string(),
                message: format!("test {}", i),
                attributes_json: "{}".to_string(),
                timestamp: "2025-01-01T00:00:00+00:00".to_string(),
                trace_id: None,
                span_id: None,
                session_id: None,
            })
            .collect();

        store.insert_logs(&logs).await.unwrap();

        let deleted = store.purge_logs().await.unwrap();
        assert_eq!(deleted, 3);

        let (count, _) = store.log_stats().await.unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn test_purge_all_includes_logs() {
        let (_dir, store) = make_store();
        store.ensure_schema().await.unwrap();
        store.ensure_metrics_schema().await.unwrap();

        // Insert a span
        store.insert_spans(&[make_span("s1", "sess", "OK")]).await.unwrap();

        // Insert a metric
        let metric = MetricPoint {
            metric_name: "counter".to_string(),
            metric_type: crate::infrastructure::telemetry::metrics_collector::MetricType::Counter,
            labels_json: "{}".to_string(),
            value: 1.0,
            timestamp: "2025-01-01T00:00:00+00:00".to_string(),
            aggregation_window_s: 60,
        };
        store.insert_metrics(&[metric]).await.unwrap();

        // Insert a log
        store.insert_logs(&[make_log_record()]).await.unwrap();

        let deleted = store.purge_all().await.unwrap();
        assert_eq!(deleted, 3, "should delete 1 span + 1 metric + 1 log");

        let stats = store.stats().await.unwrap();
        assert_eq!(stats.span_count, 0);

        let (point_count, _) = store.metric_stats().await.unwrap();
        assert_eq!(point_count, 0);

        let (log_count, _) = store.log_stats().await.unwrap();
        assert_eq!(log_count, 0);
    }

    #[tokio::test]
    async fn test_delete_expired_includes_logs() {
        let (_dir, store) = make_store();
        store.ensure_schema().await.unwrap();
        store.ensure_metrics_schema().await.unwrap();

        // Insert an old log
        let old_log = crate::infrastructure::telemetry::log::LogRecord {
            timestamp: "2020-01-01T00:00:00+00:00".to_string(),
            level: "INFO".to_string(),
            target: "fredo::test".to_string(),
            message: "old".to_string(),
            attributes_json: "{}".to_string(),
            trace_id: None,
            span_id: None,
            session_id: None,
        };
        store.insert_logs(&[old_log]).await.unwrap();

        // Insert a fresh span
        let fresh_span = make_span("fresh", "sess-fresh", "OK");
        store.insert_spans(&[fresh_span]).await.unwrap();

        // Delete with retention of 1 day
        let deleted = store.delete_expired(1).await.unwrap();
        assert_eq!(deleted, 1, "should delete the old log entry");

        // Fresh span should remain
        let stats = store.stats().await.unwrap();
        assert_eq!(stats.span_count, 1);
    }
}
