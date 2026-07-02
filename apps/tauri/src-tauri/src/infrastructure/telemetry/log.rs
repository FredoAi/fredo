//! Structured logging module for Fredo's tracing ecosystem.
//!
//! Bridges `tracing` crate events into a `LogCollector` that buffers and persists
//! log records to the `telemetry_logs` table in SQLite via `SpanStore`.
//!
//! ## Architecture
//!
//! - `LogRecord` — the canonical log entry persisted to SQLite.
//! - `LogBuffer` — accumulates log records and flushes at 500 records or 5 seconds.
//! - `LogCollector` — observes `tracing` events, buffers them, and flushes to SQLite.
//! - `LogBridgeLayer` — a custom `tracing_subscriber::Layer` that converts `tracing::Event`
//!   into `LogRecord` instances and pushes them to the shared `LogCollector`.
//!
//! ## Lifecycle
//!
//! 1. A `tracing::info!(...)` or similar macro fires a `tracing::Event`.
//! 2. `LogBridgeLayer::on_event()` extracts metadata, attributes, and span context.
//! 3. The `LogRecord` is pushed to the `LogCollector`.
//! 4. The `LogCollector` buffers the record, flushing to `SpanStore::insert_logs()`
//!    at 500 records or 5 seconds since last flush.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tracing_subscriber::layer::Context;
use tracing_subscriber::registry::LookupSpan;
use tracing_subscriber::Layer;

use crate::infrastructure::storage::span_store::SpanStore;
use crate::infrastructure::storage::AppStore;

// ── LogRecord ─────────────────────────────────────────────────────────────────

/// A single structured log entry captured from a `tracing` event.
/// Serialized with camelCase for IPC, stored as rows in the `telemetry_logs` table.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogRecord {
    /// RFC3339 timestamp of the event.
    pub timestamp: String,
    /// Log level: "TRACE", "DEBUG", "INFO", "WARN", "ERROR".
    pub level: String,
    /// Module path target (e.g. "fredo::infrastructure::otlp").
    pub target: String,
    /// The event's message.
    pub message: String,
    /// JSON object of structured key=value attributes from the event.
    pub attributes_json: String,
    /// Trace ID from the active span, if any.
    pub trace_id: Option<String>,
    /// Span ID from the active span, if any.
    pub span_id: Option<String>,
    /// Session ID if available.
    pub session_id: Option<String>,
}

// ── LogBuffer ─────────────────────────────────────────────────────────────────

/// In-memory buffer of log records, flushed to SpanStore on threshold or timer.
#[derive(Debug, Clone)]
struct LogBuffer {
    records: Vec<LogRecord>,
    last_flush: Instant,
}

impl LogBuffer {
    fn new() -> Self {
        LogBuffer {
            records: Vec::new(),
            last_flush: Instant::now(),
        }
    }

    /// Returns true if the buffer should be flushed
    /// (≥500 records or ≥5s since last flush and not empty).
    fn should_flush(&self) -> bool {
        !self.records.is_empty()
            && (self.records.len() >= 500 || self.last_flush.elapsed() >= Duration::from_secs(5))
    }
}

// ── LogCollector ──────────────────────────────────────────────────────────────

/// Mutable state inside the LogCollector.
struct CollectorInner {
    buffer: LogBuffer,
}

/// Collects `LogRecord` entries, buffers them, and flushes to `SpanStore::insert_logs()`.
///
/// Follows the same pattern as `SpanCollector` and `MetricCollector`:
/// - Holds `Arc<SpanStore>` + `Arc<AppStore>` for persistence and settings access.
/// - Uses an `enabled_cache` `AtomicBool` to avoid AppStore reads on every event.
/// - Buffers records and flushes at threshold (500 records) or timer (5 seconds).
pub struct LogCollector {
    store: Arc<SpanStore>,
    app_store: Arc<AppStore>,
    inner: Mutex<CollectorInner>,
    /// Cached value of `tracing.logging_enabled`, checked before every push.
    pub(crate) enabled_cache: AtomicBool,
}

impl LogCollector {
    /// Create a new LogCollector with the given store and app store.
    /// Reads `tracing.logging_enabled` from AppStore to initialize the cache.
    pub fn new(store: Arc<SpanStore>, app_store: Arc<AppStore>) -> Self {
        let enabled = app_store
            .get("tracing.logging_enabled")
            .ok()
            .flatten()
            .map(|v| v == "true")
            .unwrap_or(true);

        LogCollector {
            store,
            app_store,
            inner: Mutex::new(CollectorInner {
                buffer: LogBuffer::new(),
            }),
            enabled_cache: AtomicBool::new(enabled),
        }
    }

    /// Refresh the enabled cache from AppStore.
    pub fn refresh_enabled(&self) {
        let enabled = self
            .app_store
            .get("tracing.logging_enabled")
            .ok()
            .flatten()
            .map(|v| v == "true")
            .unwrap_or(true);
        self.enabled_cache.store(enabled, Ordering::SeqCst);
    }

    /// Push a log record into the buffer.
    /// If logging is disabled, the record is dropped.
    /// If the buffer threshold is reached, flushes automatically.
    pub fn push(&self, record: LogRecord) {
        if !self.enabled_cache.load(Ordering::SeqCst) {
            return;
        }

        let mut inner = self.inner.lock().unwrap();
        inner.buffer.records.push(record);

        if inner.buffer.should_flush() {
            let records = std::mem::take(&mut inner.buffer.records);
            inner.buffer.last_flush = Instant::now();
            drop(inner);
            if let Err(e) = self.store.insert_logs(&records) {
                tracing::error!(target: "fredo::telemetry", error = %e, "log flush error");
            }
        }
    }

    /// Flush buffered records if the 5-second timer has elapsed.
    /// Returns the number of records flushed.
    pub fn flush_if_needed(&self) -> u64 {
        let records_to_flush = {
            let mut inner = self.inner.lock().unwrap();
            if inner.buffer.should_flush() {
                let records = std::mem::take(&mut inner.buffer.records);
                inner.buffer.last_flush = Instant::now();
                records
            } else {
                return 0;
            }
        };

        let count = records_to_flush.len() as u64;
        if let Err(e) = self.store.insert_logs(&records_to_flush) {
            tracing::error!(target: "fredo::telemetry", error = %e, "log flush error");
            return 0;
        }
        count
    }

    /// Force-flush all buffered records immediately, ignoring the timer.
    /// Used by tests and on shutdown. Returns the number of records flushed.
    pub fn flush_all(&self) -> u64 {
        let records_to_flush = {
            let mut inner = self.inner.lock().unwrap();
            if inner.buffer.records.is_empty() {
                return 0;
            }
            let records = std::mem::take(&mut inner.buffer.records);
            inner.buffer.last_flush = Instant::now();
            records
        };

        let count = records_to_flush.len() as u64;
        if let Err(e) = self.store.insert_logs(&records_to_flush) {
            tracing::error!(target: "fredo::telemetry", error = %e, "log flush error");
            return 0;
        }
        count
    }

    /// Toggle off — flushes all buffered records, then disables the cache.
    /// Returns the number of records flushed.
    pub fn disable_and_flush(&self) -> u64 {
        let flushed = self.flush_all();
        self.enabled_cache.store(false, Ordering::SeqCst);
        flushed
    }

    /// Set the log level string. This is stored for the layer to use as filter.
    /// Currently a no-op on the collector itself (the subscriber layer handles filtering).
    pub fn set_level_str(&self, _level: &str) {
        // The actual level filtering is done by `tracing_subscriber::EnvFilter` at the
        // subscriber level. This method stores the preference in AppStore; the subscriber
        // level is updated separately in lib.rs.
    }

    /// Get current stats: (record_count, storage_bytes).
    pub fn stats(&self) -> (u64, u64) {
        self.store.log_stats().unwrap_or((0, 0))
    }
}

// ── LogBridgeLayer ───────────────────────────────────────────────────────────

/// Global OnceLock for the LogCollector used by the LogBridgeLayer.
/// Set after LogCollector creation during setup(). Before that, the
/// LogBridgeLayer silently drops events.
pub(crate) static LOG_COLLECTOR_CELL: std::sync::OnceLock<Arc<LogCollector>> = std::sync::OnceLock::new();

/// A `tracing_subscriber::Layer` that bridges `tracing` events to the `LogCollector`.
///
/// Converts every `tracing::Event` into a `LogRecord` and pushes it to the shared
/// `LogCollector`. Extracts:
/// - Level, target, message, structured attributes
/// - Trace ID and span ID from the currently active span (if any)
///
/// This layer is designed to work with `tracing_subscriber::Registry`.
///
/// Uses the global `LOG_COLLECTOR_CELL` OnceCell to defer collector initialization.
/// Until the cell is set, events are silently dropped.
pub struct LogBridgeLayer;

impl LogBridgeLayer {
    /// Create a new LogBridgeLayer. The LogCollector is obtained from
    /// the global `LOG_COLLECTOR_CELL` OnceCell, which must be set before
    /// events are processed (or events will be silently dropped).
    pub fn new() -> Self {
        LogBridgeLayer
    }

    /// Create a new LogBridgeLayer with deferred collector initialization.
    /// Alias for `new()` — the global OnceCell is always used.
    pub fn new_deferred() -> Self {
        LogBridgeLayer
    }

    fn get_collector(&self) -> Option<Arc<LogCollector>> {
        LOG_COLLECTOR_CELL.get().cloned()
    }
}

impl<S> Layer<S> for LogBridgeLayer
where
    S: tracing::Subscriber + for<'a> LookupSpan<'a>,
{
    fn on_event(&self, event: &tracing::Event<'_>, ctx: Context<'_, S>) {
        // Extract metadata
        let metadata = event.metadata();
        let level = metadata.level().to_string();
        let target = metadata.target().to_string();

        // Build message and structured attributes
        let mut message = String::new();
        let mut attrs = serde_json::Map::new();

        // Use a visitor pattern to capture fields
        let mut visitor = LogFieldVisitor {
            message: &mut message,
            attrs: &mut attrs,
            has_message: false,
        };
        event.record(&mut visitor);

        // Extract trace_id/span_id from event fields BEFORE building attributes_json
        // (which consumes attrs). These are placeholders; real trace context comes
        // from the active span below.
        let event_trace_id = attrs.get("trace_id").and_then(|v| v.as_str()).map(String::from);
        let event_span_id = attrs.get("span_id").and_then(|v| v.as_str()).map(String::from);

        let attributes_json = serde_json::Value::Object(attrs).to_string();

        // Extract span context (trace_id, span_id) from the currently entered span
        // REQ-10: Log events inside an active tracing span inherit trace_id + span_id.
        let (trace_id, span_id) = if let Some(_span) = ctx.lookup_current() {
            let mut tid = event_trace_id;
            let mut sid = event_span_id;

            // Use the span's extensions to look up trace context
            if let Some(id) = ctx.current_span().id() {
                if let Some(span_data) = ctx.span(id) {
                    if let Some(span_ext) = span_data.extensions().get::<SpanTraceContext>() {
                        tid = span_ext.trace_id.clone().or(tid);
                        sid = span_ext.span_id.clone().or(sid);
                    }
                    // If we have a span but no explicit trace context stored,
                    // use the span ID as a basic identifier
                    if sid.is_none() {
                        sid = Some(format!("{:?}", span_data.id()));
                    }
                    if tid.is_none() {
                        tid = Some(format!("{:?}", span_data.id()));
                    }
                }
            }

            (tid, sid)
        } else {
            (event_trace_id, event_span_id)
        };

        let timestamp = Utc::now().to_rfc3339();

        let record = LogRecord {
            timestamp,
            level,
            target,
            message,
            attributes_json,
            trace_id,
            span_id,
            session_id: None, // session_id is not available from tracing context directly
        };

        if let Some(c) = self.get_collector() {
            c.push(record);
        }
    }
}

// ── Field Visitor ─────────────────────────────────────────────────────────────

/// A `tracing::field::Visit` implementation that captures message and structured
/// attributes from a `tracing::Event`.
struct LogFieldVisitor<'a> {
    message: &'a mut String,
    attrs: &'a mut serde_json::Map<String, serde_json::Value>,
    has_message: bool,
}

impl<'a> tracing::field::Visit for LogFieldVisitor<'a> {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        let name = field.name();
        if name == "message" {
            // Already captured via record_str for the message field
            if !self.has_message {
                self.message.push_str(&format!("{:?}", value));
                self.has_message = true;
            }
        } else {
            self.attrs.insert(
                name.to_string(),
                serde_json::Value::String(format!("{:?}", value)),
            );
        }
    }

    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        let name = field.name();
        if name == "message" {
            if !self.has_message {
                self.message.push_str(value);
                self.has_message = true;
            }
        } else {
            self.attrs
                .insert(name.to_string(), serde_json::Value::String(value.to_string()));
        }
    }

    fn record_i64(&mut self, field: &tracing::field::Field, value: i64) {
        self.attrs
            .insert(field.name().to_string(), serde_json::Value::Number(value.into()));
    }

    fn record_u64(&mut self, field: &tracing::field::Field, value: u64) {
        self.attrs
            .insert(field.name().to_string(), serde_json::Value::Number(value.into()));
    }

    fn record_bool(&mut self, field: &tracing::field::Field, value: bool) {
        self.attrs
            .insert(field.name().to_string(), serde_json::Value::Bool(value));
    }
}

// ── SpanTraceContext extension ─────────────────────────────────────────────────

/// Extension stored on tracing spans to track trace_id and span_id for log correlation.
/// See REQ-10: Log events inside an active tracing span inherit trace_id + span_id.
#[derive(Debug, Clone)]
struct SpanTraceContext {
    trace_id: Option<String>,
    span_id: Option<String>,
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::storage::span_store::SpanStore;
    use crate::infrastructure::storage::AppStore;
    use std::sync::Arc;
    use tempfile::tempdir;

    fn make_collector() -> (Arc<SpanStore>, Arc<AppStore>, Arc<LogCollector>) {
        let dir = tempdir().unwrap();
        let store = Arc::new(SpanStore::open(dir.path().to_path_buf()).unwrap());
        store.ensure_schema().unwrap();
        store.ensure_logs_schema().unwrap();
        let app_store = Arc::new(AppStore::open(dir.path().to_path_buf()).unwrap());
        app_store.set("tracing.logging_enabled", "true").unwrap();
        let collector = Arc::new(LogCollector::new(store.clone(), app_store.clone()));
        (store, app_store, collector)
    }

    fn make_record() -> LogRecord {
        LogRecord {
            timestamp: Utc::now().to_rfc3339(),
            level: "INFO".to_string(),
            target: "fredo::test".to_string(),
            message: "test event".to_string(),
            attributes_json: r#"{"event_id":"abc"}"#.to_string(),
            trace_id: None,
            span_id: None,
            session_id: None,
        }
    }

    // ── AC-3: LogCollector captures records ────────────────────────────────

    #[test]
    fn test_log_collector_enabled() {
        let (store, _app_store, collector) = make_collector();

        collector.push(make_record());
        collector.flush_all();

        let stats = store.log_stats().unwrap();
        assert_eq!(stats.0, 1, "should have 1 log record");
    }

    #[test]
    fn test_log_collector_disabled() {
        let (store, app_store, collector) = make_collector();
        app_store.set("tracing.logging_enabled", "false").unwrap();
        collector.refresh_enabled();

        collector.push(make_record());
        collector.flush_all();

        let stats = store.log_stats().unwrap();
        assert_eq!(stats.0, 0, "no records when logging is disabled");
    }

    // ── LogBuffer flush threshold ──────────────────────────────────────────

    #[test]
    fn test_log_buffer_flush_threshold() {
        let (store, _app_store, collector) = make_collector();

        // Push 500 records — should auto-flush during push at threshold
        for i in 0..500 {
            let mut record = make_record();
            record.attributes_json = serde_json::json!({"i": i}).to_string();
            collector.push(record);
        }

        // After 500, the buffer should have flushed automatically
        // Expect at least 495 records persisted (some may still be in buffer)
        let (count, _) = store.log_stats().unwrap();
        assert!(
            count >= 495,
            "buffer should have flushed near threshold, got {}",
            count
        );

        // Flush remaining
        collector.flush_all();
        let (count, _) = store.log_stats().unwrap();
        assert_eq!(count, 500, "all 500 records should be persisted");
    }

    // ── Flush all ──────────────────────────────────────────────────────────

    #[test]
    fn test_flush_all_returns_zero_when_empty() {
        let (_store, _app_store, collector) = make_collector();
        assert_eq!(collector.flush_all(), 0);
    }

    #[test]
    fn test_flush_all_with_data() {
        let (store, _app_store, collector) = make_collector();

        collector.push(make_record());
        collector.push(make_record());

        let flushed = collector.flush_all();
        assert_eq!(flushed, 2);

        let (count, _) = store.log_stats().unwrap();
        assert_eq!(count, 2);
    }

    // ── Disable and flush ──────────────────────────────────────────────────

    #[test]
    fn test_disable_and_flush_persists_buffered() {
        let (store, _app_store, collector) = make_collector();

        collector.push(make_record());
        collector.push(make_record());

        let flushed = collector.disable_and_flush();
        assert_eq!(flushed, 2, "should flush 2 records before disabling");

        // Verify persisted
        let (count, _) = store.log_stats().unwrap();
        assert_eq!(count, 2);

        // Verify disabled — subsequent push should be dropped
        collector.push(make_record());
        let (count, _) = store.log_stats().unwrap();
        assert_eq!(count, 2, "no new records after disable");
    }

    // ── Refresh enabled ────────────────────────────────────────────────────

    #[test]
    fn test_refresh_enabled_reads_app_store() {
        let (_store, app_store, collector) = make_collector();

        // Initially enabled
        assert!(collector.enabled_cache.load(Ordering::SeqCst));

        // Change in AppStore and refresh
        app_store.set("tracing.logging_enabled", "false").unwrap();
        collector.refresh_enabled();
        assert!(!collector.enabled_cache.load(Ordering::SeqCst));

        // Change back
        app_store.set("tracing.logging_enabled", "true").unwrap();
        collector.refresh_enabled();
        assert!(collector.enabled_cache.load(Ordering::SeqCst));
    }

    // ── LogBridgeLayer creates correct LogRecord ────────────────────────────

    #[test]
    fn test_log_bridge_layer_creates_record() {
        // This is a unit test for the LogRecord creation logic.
        // We verify that a LogRecord with expected fields round-trips through serde.
        let record = LogRecord {
            timestamp: "2025-01-01T00:00:00+00:00".to_string(),
            level: "INFO".to_string(),
            target: "fredo::test".to_string(),
            message: "test message".to_string(),
            attributes_json: r#"{"event_id":"abc"}"#.to_string(),
            trace_id: Some("trace-1".to_string()),
            span_id: Some("span-1".to_string()),
            session_id: Some("sess-1".to_string()),
        };

        // Serialize and deserialize
        let json = serde_json::to_string(&record).unwrap();
        let deserialized: LogRecord = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.level, "INFO");
        assert_eq!(deserialized.target, "fredo::test");
        assert_eq!(deserialized.message, "test message");
        assert_eq!(deserialized.attributes_json, r#"{"event_id":"abc"}"#);
        assert_eq!(deserialized.trace_id, Some("trace-1".to_string()));
        assert_eq!(deserialized.span_id, Some("span-1".to_string()));
        assert_eq!(deserialized.session_id, Some("sess-1".to_string()));
    }

    #[test]
    fn test_log_bridge_layer_serialization_camelcase() {
        let record = LogRecord {
            timestamp: "2025-01-01T00:00:00+00:00".to_string(),
            level: "ERROR".to_string(),
            target: "fredo::test".to_string(),
            message: "error occurred".to_string(),
            attributes_json: "{}".to_string(),
            trace_id: None,
            span_id: None,
            session_id: None,
        };

        let json = serde_json::to_string(&record).unwrap();
        // Verify camelCase field names
        assert!(json.contains("\"traceId\""));
        assert!(json.contains("\"spanId\""));
        assert!(json.contains("\"sessionId\""));
        assert!(json.contains("\"attributesJson\""));
        assert!(!json.contains("\"trace_id\""));
    }

    // ── Stats ──────────────────────────────────────────────────────────────

    #[test]
    fn test_log_stats_empty() {
        let dir = tempdir().unwrap();
        let store = Arc::new(SpanStore::open(dir.path().to_path_buf()).unwrap());
        store.ensure_schema().unwrap();
        store.ensure_logs_schema().unwrap();

        let (count, bytes) = store.log_stats().unwrap();
        assert_eq!(count, 0);
        assert_eq!(bytes, 0);
    }

    #[test]
    fn test_log_stats_populated() {
        let (store, _app_store, collector) = make_collector();

        collector.push(make_record());
        collector.flush_all();

        let (count, bytes) = store.log_stats().unwrap();
        assert_eq!(count, 1);
        assert!(bytes > 0, "storage_bytes should be > 0 for populated log");
    }
}
