//! SpanStore — persistence for telemetry spans, logs, and metrics
//! (Spec #2449; PostgreSQL migration Spec #2976, ST-5; PostgreSQL-only Spec #3005).
//!
//! Every read and write routes through the ONE shared [`EngineHandle`]
//! (Spec #2975): the shared PostgreSQL pool once the managed server installs it —
//! no per-store `Mutex<Connection>`, no second pool, no per-store `Connection::open`.
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
//! with `ON CONFLICT (span_id) DO NOTHING`, so a re-exported span is ignored,
//! never overwritten (REQ-12).
//!
//! ## Retention
//!
//! `delete_expired` / `delete_logs_expired` / `delete_metrics_expired` delete
//! in 1000-row batches. Reclaim is the engine's concern — PostgreSQL autovacuum
//! owns it (Spec #2979 CU-2 removed the SQLite data plane).

use anyhow::Result;
use chrono::Utc;
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

    /// REQ-1: Create the `telemetry_spans` + `telemetry_logs` tables and indexes
    /// if they don't exist, 1:1 with SQLite on PostgreSQL.
    pub async fn ensure_schema(&self) -> Result<()> {
        self.ensure_spans_schema().await?;
        self.ensure_logs_schema().await
    }

    /// Create the `telemetry_spans` table and indexes (idempotent).
    async fn ensure_spans_schema(&self) -> Result<()> {
        let active = self.engine.engine_or_err()?;
        match active.as_ref() {
            
            StoreEngine::Postgres(pg) => {
                sqlx::raw_sql(PG_TELEMETRY_DDL).execute(&pg.pool).await?;
            }
        }
        Ok(())
    }

    /// REQ-4: Create the `telemetry_logs` table and indexes (idempotent).
    pub async fn ensure_logs_schema(&self) -> Result<()> {
        let active = self.engine.engine_or_err()?;
        match active.as_ref() {
            
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

        let active = self.engine.engine_or_err()?;
        match active.as_ref() {
            
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

        let active = self.engine.engine_or_err()?;
        match active.as_ref() {
            
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
        let active = self.engine.engine_or_err()?;
        match active.as_ref() {
            
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
        let active = self.engine.engine_or_err()?;
        match active.as_ref() {
            
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

        let active = self.engine.engine_or_err()?;
        match active.as_ref() {
            
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
        let active = self.engine.engine_or_err()?;
        match active.as_ref() {
            
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
        let active = self.engine.engine_or_err()?;
        match active.as_ref() {
            
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
        let active = self.engine.engine_or_err()?;
        match active.as_ref() {
            
            StoreEngine::Postgres(pg) => {
                let deleted = sqlx::query("DELETE FROM telemetry_logs")
                    .execute(&pg.pool)
                    .await?
                    .rows_affected();
                Ok(deleted)
            }
        }
    }

}

// ── SpanStoreMetricsExt implementation ──────────────────────────────────────────

#[async_trait::async_trait]
impl SpanStoreMetricsExt for SpanStore {
    /// REQ-9: Create the `telemetry_metrics` table and indexes (idempotent).
    async fn ensure_metrics_schema(&self) -> Result<()> {
        let active = self.engine.engine_or_err()?;
        match active.as_ref() {
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

        let active = self.engine.engine_or_err()?;
        match active.as_ref() {
            
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
        let active = self.engine.engine_or_err()?;
        match active.as_ref() {
            
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
        let active = self.engine.engine_or_err()?;
        match active.as_ref() {
            
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
        let active = self.engine.engine_or_err()?;
        match active.as_ref() {
            
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
