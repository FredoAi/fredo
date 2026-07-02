//! SpanStore — SQLite-backed persistence for telemetry spans.
//!
//! Follows the same pattern as `FeatureStore`:
//! - Own `Mutex<Connection>` to `fredo.db` with WAL mode.
//! - Schema managed via `ensure_schema()`.
//! - Batch inserts, retention cleanup, stats, and purge.
//!
//! ## Schema
//!
//! ```sql
//! CREATE TABLE telemetry_spans (
//!     trace_id        TEXT NOT NULL,
//!     span_id         TEXT PRIMARY KEY,
//!     parent_span_id  TEXT,
//!     span_name       TEXT NOT NULL,
//!     span_kind       TEXT NOT NULL DEFAULT 'INTERNAL',
//!     start_time_ns   INTEGER NOT NULL,
//!     end_time_ns     INTEGER,
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

use anyhow::Result;
use chrono::Utc;
use rusqlite::{params, Connection};
use std::path::PathBuf;
use std::sync::Mutex;

use crate::infrastructure::contract_407::{MetricPoint, SpanStoreMetricsExt, TelemetryStatsExt};
use crate::infrastructure::telemetry::{TelemetrySpan, TelemetryStats};

/// SQLite-backed store for telemetry spans.
///
/// Uses the same `fredo.db` as `AppStore` and `FeatureStore`, with its own
/// `Mutex<Connection>` for thread-safe access.
pub struct SpanStore {
    pub(crate) conn: Mutex<Connection>,
}

impl SpanStore {
    /// Open (or create) `fredo.db` with WAL journal mode.
    pub fn open(data_dir: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&data_dir)?;
        let db_path = data_dir.join("fredo.db");
        let conn = Connection::open(&db_path)?;
        conn.execute_batch("PRAGMA journal_mode=WAL;")?;
        Ok(SpanStore {
            conn: Mutex::new(conn),
        })
    }

    /// REQ-1: Create the `telemetry_spans` table and indexes if they don't exist.
    pub fn ensure_schema(&self) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS telemetry_spans (
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
                ON telemetry_spans(status_code) WHERE status_code = 'ERROR';",
        )?;
        Ok(())
    }

    /// REQ-6: Insert completed spans in a batch transaction.
    /// Returns the number of rows inserted.
    pub fn insert_spans(&self, spans: &[TelemetrySpan]) -> Result<usize> {
        if spans.is_empty() {
            return Ok(0);
        }

        let conn = self.conn.lock().unwrap();
        let mut total = 0usize;

        conn.execute_batch("BEGIN TRANSACTION;")?;
        for span in spans {
            let affected = conn.execute(
                "INSERT OR IGNORE INTO telemetry_spans
                 (trace_id, span_id, parent_span_id, span_name, span_kind,
                  start_time_ns, end_time_ns, status_code, status_message,
                  session_id, attributes_json, events_json,
                  provider, transport, event_type, ingested_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
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
            total += affected as usize;
        }
        conn.execute_batch("COMMIT;")?;

        Ok(total)
    }

    /// REQ-9: Delete spans whose `ingested_at` is older than `retention_days` days.
    /// Deletes in batches of 1000 rows per transaction, running `PRAGMA incremental_vacuum`
    /// after each batch.
    /// Returns the total number of rows deleted.
    pub fn delete_expired(&self, retention_days: i64) -> Result<u64> {
        let cutoff = Utc::now() - chrono::Duration::days(retention_days);
        let cutoff_str = cutoff.to_rfc3339();

        let conn = self.conn.lock().unwrap();
        let mut total_deleted = 0u64;

        // Delete expired spans
        loop {
            let deleted = conn.execute(
                "DELETE FROM telemetry_spans WHERE span_id IN (SELECT span_id FROM telemetry_spans WHERE ingested_at < ?1 LIMIT 1000)",
                params![cutoff_str],
            )? as u64;

            if deleted == 0 {
                break;
            }

            total_deleted += deleted;

            // Run incremental vacuum after each batch to reclaim space
            conn.execute_batch("PRAGMA incremental_vacuum;")?;
        }

        // REQ-11: Also delete expired metrics
        loop {
            let deleted = conn.execute(
                "DELETE FROM telemetry_metrics WHERE id IN (SELECT id FROM telemetry_metrics WHERE timestamp < ?1 LIMIT 1000)",
                params![cutoff_str],
            )? as u64;

            if deleted == 0 {
                break;
            }

            total_deleted += deleted;

            conn.execute_batch("PRAGMA incremental_vacuum;")?;
        }

        Ok(total_deleted)
    }

    /// REQ-12: Return span count and approximate storage size metadata.
    pub fn stats(&self) -> Result<TelemetryStats> {
        let conn = self.conn.lock().unwrap();

        let span_count: u64 = conn
            .query_row("SELECT COUNT(*) FROM telemetry_spans", [], |row| {
                row.get(0)
            })?;

        // Approximate storage: sum of byte lengths of all key columns
        let storage_bytes: u64 = conn
            .query_row(
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
            span_count,
            storage_bytes,
        })
    }

    /// REQ-15: Return extended stats including metric point count.
    pub fn stats_ext(&self) -> Result<TelemetryStatsExt> {
        let stats = self.stats()?;
        let (metric_point_count, _) = self.metric_stats()?;
        Ok(TelemetryStatsExt {
            span_count: stats.span_count,
            storage_bytes: stats.storage_bytes,
            metric_point_count,
        })
    }

    /// REQ-12: Delete all rows from the telemetry_spans and telemetry_metrics tables.
    /// Returns the count of deleted rows.
    pub fn purge_all(&self) -> Result<u64> {
        let conn = self.conn.lock().unwrap();

        let span_count: u64 = conn
            .query_row("SELECT COUNT(*) FROM telemetry_spans", [], |row| {
                row.get(0)
            })?;

        conn.execute_batch("DELETE FROM telemetry_spans;")?;

        // REQ-12: Also delete all metrics
        let metric_count: u64 = conn
            .query_row("SELECT COUNT(*) FROM telemetry_metrics", [], |row| {
                row.get(0)
            })?;

        conn.execute_batch("DELETE FROM telemetry_metrics;")?;

        Ok(span_count + metric_count)
    }
}

// ── SpanStoreMetricsExt implementation ──────────────────────────────────────────

impl SpanStoreMetricsExt for SpanStore {
    /// REQ-9: Create telemetry_metrics table and indexes.
    fn ensure_metrics_schema(&self) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS telemetry_metrics (
                id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                metric_name         TEXT NOT NULL,
                metric_type         TEXT NOT NULL,
                labels_json         TEXT DEFAULT '{}',
                value               REAL NOT NULL,
                timestamp           TEXT NOT NULL,
                aggregation_window_s INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_metrics_name_time
                ON telemetry_metrics(metric_name, timestamp);",
        )?;
        Ok(())
    }

    /// REQ-10: Batch-insert pre-aggregated metric points.
    fn insert_metrics(&self, points: &[MetricPoint]) -> Result<usize> {
        if points.is_empty() {
            return Ok(0);
        }

        let conn = self.conn.lock().unwrap();
        let mut total = 0usize;

        conn.execute_batch("BEGIN TRANSACTION;")?;
        for point in points {
            let metric_type_str = match point.metric_type {
                crate::infrastructure::contract_407::MetricType::Counter => "counter",
                crate::infrastructure::contract_407::MetricType::Gauge => "gauge",
                crate::infrastructure::contract_407::MetricType::Histogram => "histogram",
            };
            let affected = conn.execute(
                "INSERT INTO telemetry_metrics
                 (metric_name, metric_type, labels_json, value, timestamp, aggregation_window_s)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    point.metric_name,
                    metric_type_str,
                    point.labels_json,
                    point.value,
                    point.timestamp,
                    point.aggregation_window_s,
                ],
            )?;
            total += affected as usize;
        }
        conn.execute_batch("COMMIT;")?;

        Ok(total)
    }

    /// Stats for telemetry_metrics: (point_count, storage_bytes).
    fn metric_stats(&self) -> Result<(u64, u64)> {
        let conn = self.conn.lock().unwrap();

        let point_count: u64 = conn
            .query_row("SELECT COUNT(*) FROM telemetry_metrics", [], |row| {
                row.get(0)
            })?;

        let storage_bytes: u64 = conn
            .query_row(
                "SELECT COALESCE(SUM(
                    LENGTH(metric_name) + LENGTH(metric_type) +
                    LENGTH(COALESCE(labels_json, '')) +
                    LENGTH(timestamp)
                ), 0) FROM telemetry_metrics",
                [],
                |row| row.get(0),
            )?;

        Ok((point_count, storage_bytes))
    }

    /// REQ-11: Delete expired metric points.
    fn delete_metrics_expired(&self, retention_days: i64) -> Result<u64> {
        let cutoff = Utc::now() - chrono::Duration::days(retention_days);
        let cutoff_str = cutoff.to_rfc3339();

        let conn = self.conn.lock().unwrap();
        let mut total_deleted = 0u64;

        loop {
            let deleted = conn.execute(
                "DELETE FROM telemetry_metrics WHERE id IN (SELECT id FROM telemetry_metrics WHERE timestamp < ?1 LIMIT 1000)",
                params![cutoff_str],
            )? as u64;

            if deleted == 0 {
                break;
            }

            total_deleted += deleted;
            conn.execute_batch("PRAGMA incremental_vacuum;")?;
        }

        Ok(total_deleted)
    }

    /// REQ-12: Delete all metric points.
    fn purge_metrics(&self) -> Result<u64> {
        let conn = self.conn.lock().unwrap();

        let count: u64 = conn
            .query_row("SELECT COUNT(*) FROM telemetry_metrics", [], |row| {
                row.get(0)
            })?;

        conn.execute_batch("DELETE FROM telemetry_metrics;")?;

        Ok(count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::telemetry::TelemetrySpan;

    fn make_store() -> SpanStore {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA journal_mode=WAL;").ok();
        SpanStore {
            conn: Mutex::new(conn),
        }
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

    #[test]
    fn test_ensure_schema_creates_table() {
        let store = make_store();
        store.ensure_schema().unwrap();

        let conn = store.conn.lock().unwrap();
        // Verify table exists
        let table_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='telemetry_spans'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(table_count, 1, "telemetry_spans table should exist");

        // Verify column count (16 columns)
        let col_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('telemetry_spans')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(col_count, 16, "telemetry_spans should have 16 columns");

        // Verify specific columns exist
        let cols: Vec<String> = conn
            .prepare("SELECT name FROM pragma_table_info('telemetry_spans')")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
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

    #[test]
    fn test_ensure_schema_creates_indexes() {
        let store = make_store();
        store.ensure_schema().unwrap();

        let conn = store.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT name FROM pragma_index_list('telemetry_spans')")
            .unwrap();
        let indexes: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();

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

    #[test]
    fn test_insert_spans_returns_count() {
        let store = make_store();
        store.ensure_schema().unwrap();

        let span = make_span("s1", "sess-1", "OK");
        let span2 = make_span("s2", "sess-1", "ERROR");

        let inserted = store.insert_spans(&[span, span2]).unwrap();
        assert_eq!(inserted, 2);
    }

    #[test]
    fn test_insert_spans_empty_slice() {
        let store = make_store();
        store.ensure_schema().unwrap();

        let inserted = store.insert_spans(&[]).unwrap();
        assert_eq!(inserted, 0);
    }

    #[test]
    fn test_insert_duplicate_span_id_is_ignored() {
        let store = make_store();
        store.ensure_schema().unwrap();

        let span = make_span("dup", "sess-1", "OK");
        let span_dup = make_span("dup", "sess-2", "ERROR");

        let first = store.insert_spans(&[span]).unwrap();
        assert_eq!(first, 1);

        let second = store.insert_spans(&[span_dup]).unwrap();
        assert_eq!(second, 0, "duplicate span_id should be ignored");
    }

    // ── Stats ───────────────────────────────────────────────────────────────

    #[test]
    fn test_stats_empty_store() {
        let store = make_store();
        store.ensure_schema().unwrap();

        let stats = store.stats().unwrap();
        assert_eq!(stats.span_count, 0);
        assert_eq!(stats.storage_bytes, 0);
    }

    #[test]
    fn test_stats_with_spans() {
        let store = make_store();
        store.ensure_schema().unwrap();

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

        store.insert_spans(&[span]).unwrap();

        let stats = store.stats().unwrap();
        assert_eq!(stats.span_count, 1);
        assert!(
            stats.storage_bytes > 0,
            "storage_bytes should be > 0 for a populated span"
        );
    }

    // ── Purge ───────────────────────────────────────────────────────────────

    #[test]
    fn test_purge_all_returns_count() {
        let store = make_store();
        store.ensure_schema().unwrap();
        store.ensure_metrics_schema().unwrap();

        store
            .insert_spans(&[
                make_span("p1", "sess", "OK"),
                make_span("p2", "sess", "ERROR"),
            ])
            .unwrap();

        let deleted = store.purge_all().unwrap();
        assert_eq!(deleted, 2);

        let stats = store.stats().unwrap();
        assert_eq!(stats.span_count, 0);
    }

    // ── Delete expired ──────────────────────────────────────────────────────

    #[test]
    fn test_delete_expired_removes_old_spans() {
        let store = make_store();
        store.ensure_schema().unwrap();
        store.ensure_metrics_schema().unwrap();

        // Insert a span with a very old ingested_at
        let old_span = TelemetrySpan {
            ingested_at: "2020-01-01T00:00:00+00:00".to_string(),
            ..make_span("old", "sess-old", "OK")
        };
        let fresh_span = make_span("fresh", "sess-fresh", "OK");

        store.insert_spans(&[old_span, fresh_span]).unwrap();

        // Delete with retention of 1 day — the old span (2020) should be deleted
        let deleted = store.delete_expired(1).unwrap();
        assert_eq!(deleted, 1, "should delete the old span");

        let stats = store.stats().unwrap();
        assert_eq!(stats.span_count, 1, "fresh span should remain");
    }

    #[test]
    fn test_delete_expired_no_spans_to_delete() {
        let store = make_store();
        store.ensure_schema().unwrap();
        store.ensure_metrics_schema().unwrap();

        let span = make_span("current", "sess", "OK");
        store.insert_spans(&[span]).unwrap();

        // Retention of 365 days — spans ingested today should not be deleted
        let deleted = store.delete_expired(365).unwrap();
        assert_eq!(deleted, 0);

        let stats = store.stats().unwrap();
        assert_eq!(stats.span_count, 1);
    }

    // ── Insert many spans ───────────────────────────────────────────────────

    #[test]
    fn test_insert_many_spans() {
        let store = make_store();
        store.ensure_schema().unwrap();

        let spans: Vec<TelemetrySpan> = (0..100)
            .map(|i| make_span(&format!("batch-{}", i), "sess-batch", "OK"))
            .collect();

        let inserted = store.insert_spans(&spans).unwrap();
        assert_eq!(inserted, 100);

        let stats = store.stats().unwrap();
        assert_eq!(stats.span_count, 100);
    }

    // ── Metrics Schema (AC-8) ───────────────────────────────────────────────

    #[test]
    fn test_ensure_metrics_schema_creates_table() {
        let store = make_store();
        store.ensure_metrics_schema().unwrap();

        let conn = store.conn.lock().unwrap();
        let table_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='telemetry_metrics'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(table_count, 1, "telemetry_metrics table should exist");

        // Verify columns
        let col_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('telemetry_metrics')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(col_count, 7, "telemetry_metrics should have 7 columns");

        let cols: Vec<String> = conn
            .prepare("SELECT name FROM pragma_table_info('telemetry_metrics')")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();

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

    #[test]
    fn test_ensure_metrics_schema_creates_index() {
        let store = make_store();
        store.ensure_metrics_schema().unwrap();

        let conn = store.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT name FROM pragma_index_list('telemetry_metrics')")
            .unwrap();
        let indexes: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();

        assert!(
            indexes.contains(&"idx_metrics_name_time".to_string()),
            "index 'idx_metrics_name_time' should exist"
        );
    }

    // ── Insert Metrics (AC-9) ───────────────────────────────────────────────

    #[test]
    fn test_insert_metrics_returns_count() {
        let store = make_store();
        store.ensure_metrics_schema().unwrap();

        let points = vec![
            MetricPoint {
                metric_name: "span_count".to_string(),
                metric_type: crate::infrastructure::contract_407::MetricType::Counter,
                labels_json: r#"{"span_name":"tool_use.read","status":"ok"}"#.to_string(),
                value: 5.0,
                timestamp: "2025-01-01T00:00:00+00:00".to_string(),
                aggregation_window_s: 60,
            },
            MetricPoint {
                metric_name: "span_duration_ms".to_string(),
                metric_type: crate::infrastructure::contract_407::MetricType::Histogram,
                labels_json: r#"{"span_name":"tool_use.read","le":"50"}"#.to_string(),
                value: 3.0,
                timestamp: "2025-01-01T00:00:00+00:00".to_string(),
                aggregation_window_s: 60,
            },
        ];

        let inserted = store.insert_metrics(&points).unwrap();
        assert_eq!(inserted, 2);
    }

    #[test]
    fn test_insert_metrics_empty_slice() {
        let store = make_store();
        store.ensure_metrics_schema().unwrap();

        let inserted = store.insert_metrics(&[]).unwrap();
        assert_eq!(inserted, 0);
    }

    #[test]
    fn test_metric_stats_empty() {
        let store = make_store();
        store.ensure_metrics_schema().unwrap();

        let (point_count, storage_bytes) = store.metric_stats().unwrap();
        assert_eq!(point_count, 0);
        assert_eq!(storage_bytes, 0);
    }

    #[test]
    fn test_metric_stats_after_insert() {
        let store = make_store();
        store.ensure_metrics_schema().unwrap();

        let points: Vec<MetricPoint> = (0..5)
            .map(|i| MetricPoint {
                metric_name: format!("test.metric.{}", i),
                metric_type: crate::infrastructure::contract_407::MetricType::Counter,
                labels_json: "{}".to_string(),
                value: i as f64,
                timestamp: "2025-01-01T00:00:00+00:00".to_string(),
                aggregation_window_s: 60,
            })
            .collect();

        let inserted = store.insert_metrics(&points).unwrap();
        assert_eq!(inserted, 5);

        let (point_count, storage_bytes) = store.metric_stats().unwrap();
        assert_eq!(point_count, 5, "should return point_count=5");
        assert!(storage_bytes > 0, "storage_bytes should be > 0");
    }

    // ── Delete expired metrics (AC-10) ───────────────────────────────────────

    #[test]
    fn test_delete_metrics_expired_removes_old_points() {
        let store = make_store();
        store.ensure_metrics_schema().unwrap();

        let old_metric = MetricPoint {
            metric_name: "old_counter".to_string(),
            metric_type: crate::infrastructure::contract_407::MetricType::Counter,
            labels_json: "{}".to_string(),
            value: 1.0,
            timestamp: "2020-01-01T00:00:00+00:00".to_string(),
            aggregation_window_s: 60,
        };
        let fresh_metric = MetricPoint {
            metric_name: "fresh_counter".to_string(),
            metric_type: crate::infrastructure::contract_407::MetricType::Counter,
            labels_json: "{}".to_string(),
            value: 2.0,
            timestamp: chrono::Utc::now().to_rfc3339(),
            aggregation_window_s: 60,
        };

        store.insert_metrics(&[old_metric, fresh_metric]).unwrap();

        let (before_count, _) = store.metric_stats().unwrap();
        assert_eq!(before_count, 2);

        let deleted = store.delete_metrics_expired(1).unwrap();
        assert_eq!(deleted, 1, "should delete the old metric point");

        let (after_count, _) = store.metric_stats().unwrap();
        assert_eq!(after_count, 1, "fresh metric point should remain");
    }

    #[test]
    fn test_delete_metrics_expired_no_points_to_delete() {
        let store = make_store();
        store.ensure_metrics_schema().unwrap();

        let metric = MetricPoint {
            metric_name: "current_counter".to_string(),
            metric_type: crate::infrastructure::contract_407::MetricType::Counter,
            labels_json: "{}".to_string(),
            value: 1.0,
            timestamp: chrono::Utc::now().to_rfc3339(),
            aggregation_window_s: 60,
        };

        store.insert_metrics(&[metric]).unwrap();

        let deleted = store.delete_metrics_expired(365).unwrap();
        assert_eq!(deleted, 0);
    }

    // ── Purge metrics (AC-11) ────────────────────────────────────────────────

    #[test]
    fn test_purge_metrics_clears_all() {
        let store = make_store();
        store.ensure_metrics_schema().unwrap();

        let points: Vec<MetricPoint> = (0..3)
            .map(|i| MetricPoint {
                metric_name: format!("m{}", i),
                metric_type: crate::infrastructure::contract_407::MetricType::Counter,
                labels_json: "{}".to_string(),
                value: i as f64,
                timestamp: "2025-01-01T00:00:00+00:00".to_string(),
                aggregation_window_s: 60,
            })
            .collect();

        store.insert_metrics(&points).unwrap();

        let deleted = store.purge_metrics().unwrap();
        assert_eq!(deleted, 3);

        let (point_count, _) = store.metric_stats().unwrap();
        assert_eq!(point_count, 0);
    }

    #[test]
    fn test_purge_all_includes_metrics() {
        let store = make_store();
        store.ensure_schema().unwrap();
        store.ensure_metrics_schema().unwrap();

        // Insert a span
        store.insert_spans(&[make_span("s1", "sess", "OK")]).unwrap();

        // Insert a metric
        let metric = MetricPoint {
            metric_name: "counter".to_string(),
            metric_type: crate::infrastructure::contract_407::MetricType::Counter,
            labels_json: "{}".to_string(),
            value: 1.0,
            timestamp: "2025-01-01T00:00:00+00:00".to_string(),
            aggregation_window_s: 60,
        };
        store.insert_metrics(&[metric]).unwrap();

        let deleted = store.purge_all().unwrap();
        assert_eq!(deleted, 2, "should delete 1 span + 1 metric");

        let stats = store.stats().unwrap();
        assert_eq!(stats.span_count, 0);

        let (point_count, _) = store.metric_stats().unwrap();
        assert_eq!(point_count, 0);
    }

    // ── Extended stats (REQ-15) ──────────────────────────────────────────────

    #[test]
    fn test_stats_ext_includes_metric_count() {
        let store = make_store();
        store.ensure_schema().unwrap();
        store.ensure_metrics_schema().unwrap();

        // Insert a span
        store.insert_spans(&[make_span("s-ext", "sess", "OK")]).unwrap();

        // Insert a metric
        let metric = MetricPoint {
            metric_name: "test_counter".to_string(),
            metric_type: crate::infrastructure::contract_407::MetricType::Counter,
            labels_json: "{}".to_string(),
            value: 42.0,
            timestamp: "2025-01-01T00:00:00+00:00".to_string(),
            aggregation_window_s: 60,
        };
        store.insert_metrics(&[metric]).unwrap();

        let ext_stats = store.stats_ext().unwrap();
        assert_eq!(ext_stats.span_count, 1);
        assert_eq!(ext_stats.metric_point_count, 1);
        assert!(ext_stats.storage_bytes > 0);
    }
}
