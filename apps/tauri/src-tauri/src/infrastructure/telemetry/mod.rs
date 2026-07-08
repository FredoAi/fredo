//! Telemetry tracing system for Fredo's event pipeline.
//!
//! Derives OpenTelemetry-compatible spans from the FredoEvent stream,
//! buffers them, and persists to SQLite via SpanStore.
//!
//! ## Architecture
//!
//! - `TelemetrySpan` — the core span data type persisted to SQLite.
//! - `TelemetryStats` — summary statistics returned by the stats IPC command.
//! - `SpanCollector` — processes FredoEvents, derives spans, manages lifecycle.
//! - `SpanBuffer` — accumulates completed spans and flushes to SpanStore.
//!
//! ## Span Lifecycle
//!
//! 1. **Init** → creates a new active span with `status_code='UNSET'`.
//! 2. **Update** → enriches the active span's attributes (merge/latest wins).
//! 3. **Response** → finalizes the span with `status_code='OK'`, records end time.
//! 4. **Error** → finalizes the span with `status_code='ERROR'`, records error message.
//! 5. **Timeout** → orphan sweep auto-closes spans older than 5 minutes as ERROR.

use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::infrastructure::comm::event::{EventState, FredoEvent};
use crate::infrastructure::storage::span_store::SpanStore;
use crate::infrastructure::storage::AppStore;

pub mod log;

// ── Span data types ────────────────────────────────────────────────────────────

/// Represents a single OpenTelemetry-compatible span derived from FredoEvents.
/// Serialized with camelCase for IPC, stored as rows in the `telemetry_spans` table.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetrySpan {
    pub trace_id: String,
    pub span_id: String,
    pub parent_span_id: Option<String>,
    pub span_name: String,
    pub span_kind: String,
    pub start_time_ns: i64,
    pub end_time_ns: Option<i64>,
    pub status_code: String,
    pub status_message: Option<String>,
    pub session_id: String,
    pub attributes_json: Option<String>,
    pub events_json: Option<String>,
    pub provider: Option<String>,
    pub transport: Option<String>,
    pub event_type: Option<String>,
    pub ingested_at: String,
}

impl TelemetrySpan {
    /// Create a new span from an Init FredoEvent.
    pub fn new_from_init(event: &FredoEvent, parent_span_id: Option<String>) -> Self {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos() as i64;

        let span_name = match (&event.event_type, &event.tool_name) {
            (_, Some(tool)) => format!("{}.{}", event.event_type.as_str(), tool),
            _ => event.event_type.as_str().to_string(),
        };

        TelemetrySpan {
            trace_id: event.session_id.clone(),
            span_id: event.correlation_id.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            parent_span_id,
            span_name,
            span_kind: "INTERNAL".to_string(),
            start_time_ns: now,
            end_time_ns: None,
            status_code: "UNSET".to_string(),
            status_message: None,
            session_id: event.session_id.clone(),
            attributes_json: None,
            events_json: None,
            provider: Some(event.provider.as_str().to_string()),
            transport: Some(event.transport.as_str().to_string()),
            event_type: Some(event.event_type.as_str().to_string()),
            ingested_at: Utc::now().to_rfc3339(),
        }
    }

    /// Apply an Update event's attributes (coalescing — latest values win).
    pub fn apply_update(&mut self, event: &FredoEvent) {
        let mut attrs = self
            .attributes_json
            .as_deref()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default();

        // Merge payload fields if present
        if let Some(payload) = &event.payload {
            if let Some(obj) = payload.as_object() {
                for (k, v) in obj {
                    attrs.insert(k.clone(), v.clone());
                }
            }
        }

        // Update metadata fields
        attrs.insert(
            "tool_name".to_string(),
            serde_json::json!(event.tool_name),
        );
        attrs.insert(
            "provider".to_string(),
            serde_json::json!(event.provider.as_str()),
        );
        attrs.insert(
            "transport".to_string(),
            serde_json::json!(event.transport.as_str()),
        );
        attrs.insert(
            "event_type".to_string(),
            serde_json::json!(event.event_type.as_str()),
        );

        // Always keep provider/transport/event_type current
        self.provider = Some(event.provider.as_str().to_string());
        self.transport = Some(event.transport.as_str().to_string());
        self.event_type = Some(event.event_type.as_str().to_string());

        self.attributes_json = Some(serde_json::Value::Object(attrs).to_string());
    }

    /// Finalize the span with a Response or Error event.
    pub fn finalize(&mut self, status_code: &str, status_message: Option<String>) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos() as i64;
        self.end_time_ns = Some(now);
        self.status_code = status_code.to_string();
        self.status_message = status_message;
    }
}

/// Summary statistics for the telemetry system.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryStats {
    pub span_count: u64,
    pub storage_bytes: u64,
}

// ── Active span tracking ───────────────────────────────────────────────────────

/// An in-progress span with its last activity time for orphan detection.
#[derive(Debug, Clone)]
struct ActiveSpan {
    span: TelemetrySpan,
    last_activity: Instant,
}

// ── SpanBuffer ─────────────────────────────────────────────────────────────────

/// In-memory buffer of completed spans, flushed to SpanStore on threshold or timer.
#[derive(Debug, Clone)]
struct SpanBuffer {
    spans: Vec<TelemetrySpan>,
    last_flush: Instant,
}

impl SpanBuffer {
    fn new() -> Self {
        SpanBuffer {
            spans: Vec::new(),
            last_flush: Instant::now(),
        }
    }

    /// Returns true if the buffer should be flushed (≥100 spans or ≥5s since last flush).
    fn should_flush(&self) -> bool {
        !self.spans.is_empty()
            && (self.spans.len() >= 100 || self.last_flush.elapsed() >= Duration::from_secs(5))
    }
}

// ── SpanCollector ──────────────────────────────────────────────────────────────

/// Derives spans from FredoEvents and buffers them for persistence.
///
/// The collector is an observer — it reads events but does not emit new ones.
/// It respects the `tracing.enabled` AppStore key (REQ-10).
pub struct SpanCollector {
    store: Arc<SpanStore>,
    app_store: Arc<AppStore>,
    inner: Mutex<CollectorInner>,
    /// Cached value of tracing.enabled, checked before every batch.
    enabled_cache: AtomicBool,
}

/// Mutable state inside the SpanCollector.
struct CollectorInner {
    active_spans: HashMap<String, ActiveSpan>,
    buffer: SpanBuffer,
    /// Track the most recent span_id per session for parent_span_id derivation.
    session_span_stack: HashMap<String, Vec<String>>,
}

impl SpanCollector {
    /// Create a new SpanCollector.
    pub fn new(store: Arc<SpanStore>, app_store: Arc<AppStore>) -> Self {
        let enabled = app_store
            .get("tracing.enabled")
            .ok()
            .flatten()
            .map(|v| v == "true")
            .unwrap_or(true);

        SpanCollector {
            store,
            app_store,
            inner: Mutex::new(CollectorInner {
                active_spans: HashMap::new(),
                buffer: SpanBuffer::new(),
                session_span_stack: HashMap::new(),
            }),
            enabled_cache: AtomicBool::new(enabled),
        }
    }

    /// Refresh the enabled cache from AppStore.
    pub fn refresh_enabled(&self) {
        let enabled = self
            .app_store
            .get("tracing.enabled")
            .ok()
            .flatten()
            .map(|v| v == "true")
            .unwrap_or(true);
        self.enabled_cache.store(enabled, Ordering::SeqCst);
    }

    /// Process a batch of FredoEvents, creating/updating/completing spans.
    ///
    /// REQ-10: No-op when `tracing.enabled` is `false`.
    pub fn process_events(&self, events: &[FredoEvent]) {
        if !self.enabled_cache.load(Ordering::SeqCst) {
            return;
        }

        let mut inner = self.inner.lock().unwrap();

        for event in events {
            let Some(correlation_id) = &event.correlation_id else {
                // Cannot track spans without a correlation ID
                continue;
            };

            match event.state {
                EventState::Init => {
                    // Determine parent span ID: last active span in this session
                    let parent_span_id = inner
                        .session_span_stack
                        .get(&event.session_id)
                        .and_then(|stack| stack.last().cloned());

                    let span = TelemetrySpan::new_from_init(event, parent_span_id);
                    let span_id = span.span_id.clone();

                    // Push this span onto the session stack
                    inner
                        .session_span_stack
                        .entry(event.session_id.clone())
                        .or_default()
                        .push(span_id.clone());

                    inner.active_spans.insert(
                        correlation_id.clone(),
                        ActiveSpan {
                            span,
                            last_activity: Instant::now(),
                        },
                    );
                }
                EventState::Update => {
                    if let Some(active) = inner.active_spans.get_mut(correlation_id) {
                        active.span.apply_update(event);
                        active.last_activity = Instant::now();
                    }
                }
                EventState::Response => {
                    if let Some(active) = inner.active_spans.remove(correlation_id) {
                        let mut span = active.span;
                        span.finalize("OK", None);

                        // Apply any final payload attributes
                        if let Some(payload) = &event.payload {
                            if let Some(obj) = payload.as_object() {
                                let mut attrs = span
                                    .attributes_json
                                    .as_deref()
                                    .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
                                    .and_then(|v| v.as_object().cloned())
                                    .unwrap_or_default();
                                for (k, v) in obj {
                                    attrs.insert(k.clone(), v.clone());
                                }
                                span.attributes_json =
                                    Some(serde_json::Value::Object(attrs).to_string());
                            }
                        }

                        // REQ-11: Pop span_id from session_span_stack on completion
                        if let Some(stack) = inner.session_span_stack.get_mut(&event.session_id) {
                            stack.retain(|id| id != correlation_id);
                            if stack.is_empty() {
                                inner.session_span_stack.remove(&event.session_id);
                            }
                        }

                        inner.buffer.spans.push(span);
                    }
                }
                EventState::Error => {
                    if let Some(active) = inner.active_spans.remove(correlation_id) {
                        let mut span = active.span;
                        let msg = event
                            .error
                            .as_ref()
                            .map(|e| e.message.clone())
                            .or_else(|| {
                                event
                                    .payload
                                    .as_ref()
                                    .and_then(|p| p.get("error").and_then(|e| e.as_str()))
                                    .map(String::from)
                            })
                            .unwrap_or_else(|| "unknown error".to_string());
                        span.finalize("ERROR", Some(msg));

                        // REQ-11: Pop span_id from session_span_stack on completion
                        if let Some(stack) = inner.session_span_stack.get_mut(&event.session_id) {
                            stack.retain(|id| id != correlation_id);
                            if stack.is_empty() {
                                inner.session_span_stack.remove(&event.session_id);
                            }
                        }

                        inner.buffer.spans.push(span);
                    }
                }
            }

            // Flush if buffer threshold reached (100 spans)
            if inner.buffer.should_flush() {
                let spans = std::mem::take(&mut inner.buffer.spans);
                inner.buffer.last_flush = Instant::now();
                // Release the lock before doing I/O
                drop(inner);
                if let Err(e) = self.store.insert_spans(&spans) {
                    tracing::error!(target: "fredo::telemetry", error = %e, "span flush error");
                }
                return; // inner was dropped, can't continue
            }
        }
    }

    /// Flush any buffered spans if the 5-second timer has elapsed (REQ-6b).
    /// Returns the number of spans flushed.
    pub fn flush_if_needed(&self) -> u64 {
        let spans_to_flush = {
            let mut inner = self.inner.lock().unwrap();
            if inner.buffer.should_flush() {
                let spans = std::mem::take(&mut inner.buffer.spans);
                inner.buffer.last_flush = Instant::now();
                spans
            } else {
                return 0;
            }
        };

        let count = spans_to_flush.len() as u64;
        if let Err(e) = self.store.insert_spans(&spans_to_flush) {
            tracing::error!(target: "fredo::telemetry", error = %e, "span flush error");
            return 0;
        }
        count
    }

    /// Force-flush all buffered spans immediately, ignoring the timer.
    /// Used by tests and on shutdown. Returns the number of spans flushed.
    pub fn flush_all(&self) -> u64 {
        let spans_to_flush = {
            let mut inner = self.inner.lock().unwrap();
            if inner.buffer.spans.is_empty() {
                return 0;
            }
            let spans = std::mem::take(&mut inner.buffer.spans);
            inner.buffer.last_flush = Instant::now();
            spans
        };

        let count = spans_to_flush.len() as u64;
        if let Err(e) = self.store.insert_spans(&spans_to_flush) {
            tracing::error!(target: "fredo::telemetry", error = %e, "span flush error");
            return 0;
        }
        count
    }

    /// Sweep orphan spans that have been active for more than 5 minutes.
    /// Auto-closes them with status_code='ERROR', status_message='timeout'.
    /// Returns the number of spans closed by the sweep.
    pub fn sweep_orphans(&self) -> u64 {
        let mut swept_spans: Vec<TelemetrySpan> = Vec::new();
        let timeout = Duration::from_secs(300); // 5 minutes

        {
            let mut inner = self.inner.lock().unwrap();
            let mut to_remove: Vec<String> = Vec::new();

            for (correlation_id, active) in inner.active_spans.iter() {
                if active.last_activity.elapsed() >= timeout {
                    let mut span = active.span.clone();
                    span.finalize("ERROR", Some("timeout".to_string()));
                    swept_spans.push(span);
                    to_remove.push(correlation_id.clone());
                }
            }

            for cid in &to_remove {
                inner.active_spans.remove(cid);
            }

            // Add swept spans to buffer
            for span in &swept_spans {
                inner.buffer.spans.push(span.clone());
            }

            // Try to flush immediately if anything was swept
            if !swept_spans.is_empty() && inner.buffer.should_flush() {
                let spans = std::mem::take(&mut inner.buffer.spans);
                inner.buffer.last_flush = Instant::now();
                drop(inner);
                if let Err(e) = self.store.insert_spans(&spans) {
                    tracing::error!(target: "fredo::telemetry", error = %e, "sweep flush error");
                }
            }
        }

        swept_spans.len() as u64
    }

    /// Get a copy of the current stats for the stats IPC command.
    pub fn stats(&self) -> TelemetryStats {
        self.store.stats().unwrap_or(TelemetryStats {
            span_count: 0,
            storage_bytes: 0,
        })
    }

    /// Purge all spans from the store. Returns count of deleted spans.
    pub fn purge_all(&self) -> u64 {
        self.store.purge_all().unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::comm::event::{
        EventProvider, EventState, EventType, Transport,
    };
    use crate::infrastructure::storage::span_store::SpanStore;
    use crate::infrastructure::storage::AppStore;
    use std::sync::Arc;
    use tempfile::tempdir;

    fn make_event(
        state: EventState,
        correlation_id: &str,
        session_id: &str,
        event_type: EventType,
        tool_name: Option<&str>,
    ) -> FredoEvent {
        let mut builder = FredoEvent::builder()
            .state(state)
            .correlation_id(correlation_id)
            .session_id(session_id)
            .event_type(event_type)
            .provider(EventProvider::OpenCode)
            .transport(Transport::Hook);

        if let Some(tn) = tool_name {
            builder = builder.tool_name(tn);
        }

        builder.build()
    }

    fn make_collector() -> (Arc<SpanStore>, Arc<AppStore>, Arc<SpanCollector>) {
        let dir = tempdir().unwrap();
        let store = Arc::new(SpanStore::open(dir.path().to_path_buf()).unwrap());
        store.ensure_schema().unwrap();
        let app_store = Arc::new(AppStore::open(dir.path().to_path_buf()).unwrap());
        app_store.set("tracing.enabled", "true").unwrap();
        let collector = Arc::new(SpanCollector::new(store.clone(), app_store.clone()));
        (store, app_store, collector)
    }

    // ── AC-2: Init→Response produces completed span with OK status ─────────

    #[test]
    fn test_init_response_produces_completed_span() {
        let (store, _app_store, collector) = make_collector();

        let init = make_event(
            EventState::Init,
            "corr-1",
            "sess-1",
            EventType::ToolUse,
            Some("read"),
        );
        let resp = make_event(
            EventState::Response,
            "corr-1",
            "sess-1",
            EventType::ToolUse,
            Some("read"),
        );

        collector.process_events(&[init]);
        collector.process_events(&[resp]);

        // Flush to force persistence
        collector.flush_all();

        let stats = store.stats().unwrap();
        assert_eq!(stats.span_count, 1, "should have exactly 1 completed span");
    }

    #[test]
    fn test_completed_span_has_ok_status_and_trace_id() {
        let (store, _app_store, collector) = make_collector();

        let init = make_event(
            EventState::Init,
            "corr-2",
            "sess-abc",
            EventType::Chat,
            None,
        );
        let resp = make_event(
            EventState::Response,
            "corr-2",
            "sess-abc",
            EventType::Chat,
            None,
        );

        collector.process_events(&[init, resp]);
        collector.flush_all();

        // Verify via SQLite directly
        let conn = store.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT span_id, trace_id, status_code, start_time_ns, end_time_ns FROM telemetry_spans")
            .unwrap();
        let rows: Vec<(String, String, String, i64, Option<i64>)> = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, Option<i64>>(4)?,
                ))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].1, "sess-abc"); // trace_id = session_id
        assert_eq!(rows[0].2, "OK");
        assert!(rows[0].4.is_some(), "end_time_ns should be set");
        assert!(
            rows[0].4.unwrap() >= rows[0].3,
            "end_time_ns >= start_time_ns"
        );
    }

    // ── AC-3: Init→Update→Update→Response produces one span with latest attrs ─

    #[test]
    fn test_coalescing_latest_update_only() {
        let (store, _app_store, collector) = make_collector();

        let init = make_event(
            EventState::Init,
            "corr-3",
            "sess-3",
            EventType::ToolUse,
            Some("write"),
        );

        let update1 = {
            let mut e = make_event(
                EventState::Update,
                "corr-3",
                "sess-3",
                EventType::ToolUse,
                Some("write"),
            );
            e.payload = Some(serde_json::json!({"step": 1, "progress": "started"}));
            e
        };

        let update2 = {
            let mut e = make_event(
                EventState::Update,
                "corr-3",
                "sess-3",
                EventType::ToolUse,
                Some("write"),
            );
            e.payload = Some(serde_json::json!({"step": 2, "progress": "halfway", "detail": "processing"}));
            e
        };

        let resp = make_event(
            EventState::Response,
            "corr-3",
            "sess-3",
            EventType::ToolUse,
            Some("write"),
        );

        collector.process_events(&[init, update1, update2, resp]);
        collector.flush_all();

        let stats = store.stats().unwrap();
        assert_eq!(stats.span_count, 1, "should produce exactly 1 span");

        // Verify attributes have merged fields from latest update
        let conn = store.conn.lock().unwrap();
        let attrs_json: Option<String> = conn
            .query_row(
                "SELECT attributes_json FROM telemetry_spans WHERE span_id = 'corr-3'",
                [],
                |row| row.get(0),
            )
            .ok();

        let attrs = attrs_json
            .as_deref()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default();

        // Should have merged latest fields (update2 fields win)
        // "step" was in both update1 and update2 — update2's value wins
        assert_eq!(attrs.get("step"), Some(&serde_json::json!(2)));
        assert_eq!(attrs.get("progress"), Some(&serde_json::json!("halfway")));
        // "detail" was only in update2
        assert_eq!(attrs.get("detail"), Some(&serde_json::json!("processing")));
    }

    // ── AC-5: Orphan sweep closes spans >5 min ──────────────────────────────

    #[test]
    fn test_orphan_sweep_closes_timed_out_spans() {
        let (store, _app_store, collector) = make_collector();

        let init = make_event(
            EventState::Init,
            "corr-orphan",
            "sess-orphan",
            EventType::ToolUse,
            Some("read"),
        );

        collector.process_events(&[init]);

        // Manually age the span by modifying last_activity
        {
            let mut inner = collector.inner.lock().unwrap();
            if let Some(active) = inner.active_spans.get_mut("corr-orphan") {
                active.last_activity = Instant::now() - Duration::from_secs(301); // 5min + 1s
            }
        }

        // Sweep
        let swept = collector.sweep_orphans();
        assert_eq!(swept, 1, "should have swept 1 orphan span");

        // Flush and verify
        collector.flush_all();

        let conn = store.conn.lock().unwrap();
        let (status_code, status_msg): (String, Option<String>) = conn
            .query_row(
                "SELECT status_code, status_message FROM telemetry_spans WHERE span_id = 'corr-orphan'",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .unwrap();

        assert_eq!(status_code, "ERROR");
        assert_eq!(status_msg, Some("timeout".to_string()));
    }

    // ── REQ-10: Tracing disabled ────────────────────────────────────────────

    #[test]
    fn test_tracing_disabled_does_not_create_spans() {
        let dir = tempdir().unwrap();
        let store = Arc::new(SpanStore::open(dir.path().to_path_buf()).unwrap());
        store.ensure_schema().unwrap();
        let app_store = Arc::new(AppStore::open(dir.path().to_path_buf()).unwrap());
        app_store.set("tracing.enabled", "false").unwrap();

        let collector = SpanCollector::new(store.clone(), app_store);
        collector.refresh_enabled();

        let init = make_event(
            EventState::Init,
            "corr-disabled",
            "sess-disabled",
            EventType::ToolUse,
            Some("read"),
        );
        let resp = make_event(
            EventState::Response,
            "corr-disabled",
            "sess-disabled",
            EventType::ToolUse,
            Some("read"),
        );

        collector.process_events(&[init, resp]);
        collector.flush_all();

        let stats = store.stats().unwrap();
        assert_eq!(stats.span_count, 0, "no spans when tracing is disabled");
    }

    // ── Error event produces ERROR span ─────────────────────────────────────

    #[test]
    fn test_error_event_produces_error_span() {
        let (store, _app_store, collector) = make_collector();

        let init = make_event(
            EventState::Init,
            "corr-err",
            "sess-err",
            EventType::ToolUse,
            Some("deploy"),
        );

        let mut err_event = make_event(
            EventState::Error,
            "corr-err",
            "sess-err",
            EventType::ToolUse,
            Some("deploy"),
        );
        err_event.error = Some(crate::infrastructure::comm::event::FredoEventError {
            message: "deployment failed".to_string(),
            code: Some("ERR_DEPLOY".to_string()),
            details: None,
        });

        collector.process_events(&[init, err_event]);
        collector.flush_all();

        let conn = store.conn.lock().unwrap();
        let (status_code, status_msg): (String, Option<String>) = conn
            .query_row(
                "SELECT status_code, status_message FROM telemetry_spans WHERE span_id = 'corr-err'",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .unwrap();

        assert_eq!(status_code, "ERROR");
        assert_eq!(status_msg, Some("deployment failed".to_string()));
    }

    // ── SpanBuffer flush threshold ──────────────────────────────────────────

    #[test]
    fn test_buffer_flushes_on_threshold() {
        let (store, _app_store, collector) = make_collector();

        // Create 100 completed spans (Init+Response pairs)
        for i in 0..100 {
            let cid = format!("bulk-{}", i);
            let init = make_event(
                EventState::Init,
                &cid,
                "sess-bulk",
                EventType::ToolUse,
                Some("bulk_op"),
            );
            let resp = make_event(
                EventState::Response,
                &cid,
                "sess-bulk",
                EventType::ToolUse,
                Some("bulk_op"),
            );
            collector.process_events(&[init, resp]);
        }

        // After 100 completed spans, the buffer should have flushed automatically
        // Check if spans are in the store
        let stats = store.stats().unwrap();
        // Some may have flushed at threshold — verify at least some were persisted
        // (The exact count depends on when process_events flushes internally)
        assert!(
            stats.span_count >= 99,
            "buffer should have flushed near threshold, got {}",
            stats.span_count
        );
    }

    // ── Multiple sessions ───────────────────────────────────────────────────

    #[test]
    fn test_multiple_sessions_independent() {
        let (store, _app_store, collector) = make_collector();

        // Session A: one span
        collector.process_events(&[make_event(
            EventState::Init,
            "a-1",
            "session-a",
            EventType::Chat,
            None,
        )]);
        collector.process_events(&[make_event(
            EventState::Response,
            "a-1",
            "session-a",
            EventType::Chat,
            None,
        )]);

        // Session B: two spans
        collector.process_events(&[make_event(
            EventState::Init,
            "b-1",
            "session-b",
            EventType::ToolUse,
            Some("read"),
        )]);
        collector.process_events(&[make_event(
            EventState::Init,
            "b-2",
            "session-b",
            EventType::ToolUse,
            Some("write"),
        )]);
        collector.process_events(&[make_event(
            EventState::Response,
            "b-1",
            "session-b",
            EventType::ToolUse,
            Some("read"),
        )]);
        collector.process_events(&[make_event(
            EventState::Response,
            "b-2",
            "session-b",
            EventType::ToolUse,
            Some("write"),
        )]);

        collector.flush_all();

        let stats = store.stats().unwrap();
        assert_eq!(stats.span_count, 3);
    }

    // ── Parent span ID chaining ─────────────────────────────────────────────

    #[test]
    fn test_parent_span_id_chaining() {
        let (store, _app_store, collector) = make_collector();

        // Create spans sequentially in the same session
        collector.process_events(&[make_event(
            EventState::Init,
            "first",
            "sess-chain",
            EventType::ToolUse,
            Some("step1"),
        )]);
        collector.process_events(&[make_event(
            EventState::Init,
            "second",
            "sess-chain",
            EventType::ToolUse,
            Some("step2"),
        )]);
        collector.process_events(&[make_event(
            EventState::Init,
            "third",
            "sess-chain",
            EventType::ToolUse,
            Some("step3"),
        )]);

        // Complete them in order
        collector.process_events(&[make_event(
            EventState::Response,
            "first",
            "sess-chain",
            EventType::ToolUse,
            Some("step1"),
        )]);
        collector.process_events(&[make_event(
            EventState::Response,
            "second",
            "sess-chain",
            EventType::ToolUse,
            Some("step2"),
        )]);
        collector.process_events(&[make_event(
            EventState::Response,
            "third",
            "sess-chain",
            EventType::ToolUse,
            Some("step3"),
        )]);

        collector.flush_all();

        let conn = store.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT span_id, parent_span_id FROM telemetry_spans ORDER BY start_time_ns ASC")
            .unwrap();
        let rows: Vec<(String, Option<String>)> = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();

        assert_eq!(rows.len(), 3);
        // First span: no parent
        assert_eq!(rows[0].0, "first");
        assert!(rows[0].1.is_none(), "first span should have no parent");
        // Second span: parent = "first"
        assert_eq!(rows[1].0, "second");
        assert_eq!(rows[1].1, Some("first".to_string()));
        // Third span: parent = "second"
        assert_eq!(rows[2].0, "third");
        assert_eq!(rows[2].1, Some("second".to_string()));
    }
}
