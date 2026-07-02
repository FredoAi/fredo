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

    /// REQ-12: Delete all rows from the telemetry_spans table.
    /// Returns the count of deleted spans.
    pub fn purge_all(&self) -> Result<u64> {
        let conn = self.conn.lock().unwrap();

        let count: u64 = conn
            .query_row("SELECT COUNT(*) FROM telemetry_spans", [], |row| {
                row.get(0)
            })?;

        conn.execute_batch("DELETE FROM telemetry_spans;")?;

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
}
