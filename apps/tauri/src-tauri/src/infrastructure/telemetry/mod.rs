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
pub mod metrics_collector;

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
            .cached_get("tracing.enabled")
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
            .cached_get("tracing.enabled")
            .ok()
            .flatten()
            .map(|v| v == "true")
            .unwrap_or(true);
        self.enabled_cache.store(enabled, Ordering::SeqCst);
    }

    /// Process a batch of FredoEvents, creating/updating/completing spans.
    ///
    /// REQ-10: No-op when `tracing.enabled` is `false`.
    pub async fn process_events(&self, events: &[FredoEvent]) {
        if !self.enabled_cache.load(Ordering::SeqCst) {
            return;
        }

        // Collect under the lock; release it before the flush await (a std
        // MutexGuard is not Send and must not cross an await).
        let flush_batch = {
            let mut inner = self.inner.lock().unwrap();
            let mut flush_batch: Option<Vec<TelemetrySpan>> = None;

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

                    // Spec #1499 (GA-4/AC-4): Session spans are delivered as
                    // EventState::Init for the ECE delivery contract (REQ-609).
                    // Raw OTLP ingestion (Spec #2449 R1) persists session spans
                    // on receipt, so SpanCollector keeps Init-only session spans
                    // in active_spans until a Response/Error or the orphan sweep.
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
                flush_batch = Some(spans);
                break; // preserve the incumbent early-return
            }
            }
            flush_batch
        };

        if let Some(spans) = flush_batch {
            if let Err(e) = self.store.insert_spans(&spans).await {
                tracing::error!(target: "fredo::telemetry", error = %e, "span flush error");
            }
        }
    }

    /// Flush any buffered spans if the 5-second timer has elapsed (REQ-6b).
    /// Returns the number of spans flushed.
    pub async fn flush_if_needed(&self) -> u64 {
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
        if let Err(e) = self.store.insert_spans(&spans_to_flush).await {
            tracing::error!(target: "fredo::telemetry", error = %e, "span flush error");
            return 0;
        }
        count
    }

    /// Force-flush all buffered spans immediately, ignoring the timer.
    /// Used by tests and on shutdown. Returns the number of spans flushed.
    pub async fn flush_all(&self) -> u64 {
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
        if let Err(e) = self.store.insert_spans(&spans_to_flush).await {
            tracing::error!(target: "fredo::telemetry", error = %e, "span flush error");
            return 0;
        }
        count
    }

    /// Sweep orphan spans that have been active for more than 5 minutes.
    /// Auto-closes them with status_code='ERROR', status_message='timeout'.
    /// Returns the number of spans closed by the sweep.
    pub async fn sweep_orphans(&self) -> u64 {
        let timeout = Duration::from_secs(300); // 5 minutes

        // Collect + buffer under the lock, then RELEASE it before the flush
        // await (a std MutexGuard is not Send and must not cross an await).
        let (swept_count, flush_batch) = {
            let mut inner = self.inner.lock().unwrap();
            let mut swept_spans: Vec<TelemetrySpan> = Vec::new();
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
            let flush_batch = if !swept_spans.is_empty() && inner.buffer.should_flush() {
                let spans = std::mem::take(&mut inner.buffer.spans);
                inner.buffer.last_flush = Instant::now();
                Some(spans)
            } else {
                None
            };

            (swept_spans.len() as u64, flush_batch)
        };

        if let Some(spans) = flush_batch {
            if let Err(e) = self.store.insert_spans(&spans).await {
                tracing::error!(target: "fredo::telemetry", error = %e, "sweep flush error");
            }
        }

        swept_count
    }

    /// Get a copy of the current stats for the stats IPC command.
    pub async fn stats(&self) -> TelemetryStats {
        self.store.stats().await.unwrap_or(TelemetryStats {
            span_count: 0,
            storage_bytes: 0,
        })
    }

    /// Purge all spans from the store. Returns count of deleted spans.
    pub async fn purge_all(&self) -> u64 {
        self.store.purge_all().await.unwrap_or(0)
    }
}
