//! Telemetry metrics collector — aggregates FredoEvents into telemetry_metrics.
//!
//! `MetricCollector` observes FredoEvents in parallel with `SpanCollector`,
//! maintaining counters, gauges, and histograms and persisting pre-aggregated
//! `MetricPoint` rows to the `telemetry_metrics` table. The `MetricType` enum
//! values (`counter`, `gauge`, `histogram`) are a persisted data contract —
//! renaming them is a migration.

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::Result;
use serde::{Deserialize, Serialize};

// Forward references — actual types from the codebase.
use crate::infrastructure::comm::event::EventState;
pub use crate::infrastructure::comm::event::FredoEvent;
pub use crate::infrastructure::storage::span_store::SpanStore;
pub use crate::infrastructure::storage::AppStore;

// ── MetricPoint ────────────────────────────────────────────────────────────────

/// A single pre-aggregated metric data point written to telemetry_metrics.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricPoint {
    pub metric_name: String,
    pub metric_type: MetricType,
    pub labels_json: String,
    pub value: f64,
    pub timestamp: String,
    pub aggregation_window_s: i64,
}

// ── MetricType ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MetricType {
    Counter,
    Gauge,
    Histogram,
}

// ── MetricCollector contract ───────────────────────────────────────────────────

/// REQ-1 through REQ-8, REQ-13, REQ-17, REQ-18:
/// MetricCollector observes FredoEvents in parallel with SpanCollector.
pub struct MetricCollector {
    pub(crate) store: Arc<SpanStore>,
    pub(crate) app_store: Arc<AppStore>,
    pub(crate) inner: Mutex<CollectorInner>,
    pub(crate) enabled_cache: AtomicBool,
}

pub(crate) struct CollectorInner {
    // REQ-2: counters by label_key -> value
    pub(crate) counters: std::collections::HashMap<String, u64>,
    // REQ-6: histograms by span_name -> bucket_counts
    pub(crate) histograms: std::collections::HashMap<String, [u64; HISTOGRAM_BUCKET_COUNT]>,
    // REQ-5: active session IDs (session has active spans iff count > 0)
    pub(crate) active_sessions: std::collections::HashSet<String>,
    // REQ-5: per-session active span count — increment on Init, decrement on Response/Error
    pub(crate) session_span_counts: std::collections::HashMap<String, u64>,
    // REQ-3: events_received per (event_type, transport)
    pub(crate) events_received: std::collections::HashMap<String, u64>,
    // Flush timer
    pub(crate) last_flush: Instant,
    // Completion tracking: span start times for duration calculation
    pub(crate) span_starts: std::collections::HashMap<String, Instant>,
}

impl MetricCollector {
    pub fn new(store: Arc<SpanStore>, app_store: Arc<AppStore>) -> Self {
        let enabled = app_store
            .get("tracing.metrics_enabled")
            .ok()
            .flatten()
            .map(|v| v == "true")
            .unwrap_or(true);

        MetricCollector {
            store,
            app_store,
            inner: Mutex::new(CollectorInner {
                counters: std::collections::HashMap::new(),
                histograms: std::collections::HashMap::new(),
                active_sessions: std::collections::HashSet::new(),
                session_span_counts: std::collections::HashMap::new(),
                events_received: std::collections::HashMap::new(),
                last_flush: Instant::now(),
                span_starts: std::collections::HashMap::new(),
            }),
            enabled_cache: AtomicBool::new(enabled),
        }
    }

    pub fn refresh_enabled(&self) {
        let enabled = self
            .app_store
            .get("tracing.metrics_enabled")
            .ok()
            .flatten()
            .map(|v| v == "true")
            .unwrap_or(true);
        self.enabled_cache
            .store(enabled, std::sync::atomic::Ordering::SeqCst);
    }

    /// REQ-13: Toggle-off flushes remaining metrics before stopping.
    pub fn disable_and_flush(&self) -> u64 {
        let flushed = self.flush_all();
        self.enabled_cache
            .store(false, std::sync::atomic::Ordering::SeqCst);
        flushed
    }

    /// REQ-1,2,3,5,6: Process FredoEvents to derive metrics.
    pub fn process_events(&self, events: &[FredoEvent]) {
        if !self.enabled_cache.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }

        let mut inner = self.inner.lock().unwrap();

        for event in events {
            match event.state {
                EventState::Init => {
                    // REQ-3: Increment events_received counter per (event_type, transport)
                    let er_key = format!(
                        "events_received|{}|{}",
                        event.event_type.as_str(),
                        event.transport.as_str()
                    );
                    *inner.events_received.entry(er_key).or_insert(0) += 1;

                    // REQ-5: Increment per-session active span count; session is active iff count > 0
                    let session_count = inner
                        .session_span_counts
                        .entry(event.session_id.clone())
                        .or_insert(0);
                    *session_count += 1;
                    inner.active_sessions.insert(event.session_id.clone());

                    // REQ-6: Record span start time for duration calculation
                    if let Some(correlation_id) = &event.correlation_id {
                        inner
                            .span_starts
                            .insert(correlation_id.clone(), Instant::now());
                    }
                }
                EventState::Update => {
                    // Updates keep sessions active and spans alive — already tracked
                }
                EventState::Response | EventState::Error => {
                    let status = if event.state == EventState::Error {
                        "error"
                    } else {
                        "ok"
                    };

                    // REQ-5: Decrement per-session active span count; remove when count reaches 0
                    if let Some(count) = inner.session_span_counts.get_mut(&event.session_id) {
                        *count = count.saturating_sub(1);
                        if *count == 0 {
                            inner.active_sessions.remove(&event.session_id);
                        }
                    }

                    if let Some(correlation_id) = &event.correlation_id {
                        if let Some(start_time) = inner.span_starts.remove(correlation_id) {
                            let span_name = match (&event.event_type, &event.tool_name) {
                                (_, Some(tool)) => {
                                    format!("{}.{}", event.event_type.as_str(), tool)
                                }
                                _ => event.event_type.as_str().to_string(),
                            };

                            // REQ-2: Increment span_count counter
                            let counter_key = format!("span_count|{}|{}", span_name, status);
                            *inner.counters.entry(counter_key).or_insert(0) += 1;

                            // REQ-6: Record duration in histogram
                            let duration_ms = start_time.elapsed().as_millis() as u64;
                            let bucket_idx = find_histogram_bucket(duration_ms);
                            let hist_entry = inner
                                .histograms
                                .entry(span_name)
                                .or_insert([0u64; HISTOGRAM_BUCKET_COUNT]);
                            hist_entry[bucket_idx] += 1;
                        }
                    }
                }
            }
        }
    }

    /// REQ-4: Record swept orphan count from SpanCollector.
    pub fn record_orphan_count(&self, count: u64) {
        if !self.enabled_cache.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        let mut inner = self.inner.lock().unwrap();
        *inner.counters.entry("orphan_spans".to_string()).or_insert(0) += count;
    }

    /// REQ-8,17: Flush if aggregation window elapsed.
    pub fn flush_if_needed(&self) -> u64 {
        if !self.enabled_cache.load(std::sync::atomic::Ordering::SeqCst) {
            return 0;
        }

        let aggregation_window_s = self
            .app_store
            .get("tracing.metrics_aggregation_s")
            .ok()
            .flatten()
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(60);

        let should_flush = {
            let inner = self.inner.lock().unwrap();
            inner.last_flush.elapsed() >= Duration::from_secs(aggregation_window_s as u64)
        };

        if should_flush {
            self.flush_all()
        } else {
            0
        }
    }

    /// REQ-18: Force-flush all buffered metrics.
    pub fn flush_all(&self) -> u64 {
        let points = {
            let inner = self.inner.lock().unwrap();
            let mut points: Vec<MetricPoint> = Vec::new();
            let timestamp = chrono::Utc::now().to_rfc3339();

            // Get aggregation window from settings
            let aggregation_window_s = self
                .app_store
                .get("tracing.metrics_aggregation_s")
                .ok()
                .flatten()
                .and_then(|v| v.parse::<i64>().ok())
                .unwrap_or(60);

            // REQ-2: Flush counter metrics (span_count, events_received, orphan_spans)
            for (key, &value) in inner.counters.iter() {
                if value == 0 {
                    continue;
                }

                let (metric_name, labels_json) = if key == "orphan_spans" {
                    ("orphan_spans".to_string(), "{}".to_string())
                } else if let Some(rest) = key.strip_prefix("span_count|") {
                    let parts: Vec<&str> = rest.splitn(2, '|').collect();
                    if parts.len() == 2 {
                        let labels = serde_json::json!({
                            "span_name": parts[0],
                            "status": parts[1]
                        });
                        ("span_count".to_string(), labels.to_string())
                    } else {
                        continue;
                    }
                } else if let Some(rest) = key.strip_prefix("events_received|") {
                    let parts: Vec<&str> = rest.splitn(2, '|').collect();
                    if parts.len() == 2 {
                        let labels = serde_json::json!({
                            "event_type": parts[0],
                            "transport": parts[1]
                        });
                        ("events_received".to_string(), labels.to_string())
                    } else {
                        continue;
                    }
                } else {
                    continue;
                };

                points.push(MetricPoint {
                    metric_name,
                    metric_type: MetricType::Counter,
                    labels_json,
                    value: value as f64,
                    timestamp: timestamp.clone(),
                    aggregation_window_s,
                });
            }

            // REQ-5: Snapshot active sessions gauge (only if > 0)
            let active_count = inner.active_sessions.len() as f64;
            if active_count > 0.0 {
                points.push(MetricPoint {
                    metric_name: "active_sessions".to_string(),
                    metric_type: MetricType::Gauge,
                    labels_json: "{}".to_string(),
                    value: active_count,
                    timestamp: timestamp.clone(),
                    aggregation_window_s,
                });
            }

            // REQ-6: Flush histogram bucket counts
            for (span_name, buckets) in inner.histograms.iter() {
                for (bucket_idx, &count) in buckets.iter().enumerate() {
                    if count == 0 {
                        continue;
                    }
                    let le = if bucket_idx < HISTOGRAM_BUCKETS_MS.len() {
                        HISTOGRAM_BUCKETS_MS[bucket_idx] as f64
                    } else {
                        f64::INFINITY
                    };
                    let labels = serde_json::json!({
                        "span_name": span_name,
                        "le": le
                    });
                    points.push(MetricPoint {
                        metric_name: "span_duration_ms".to_string(),
                        metric_type: MetricType::Histogram,
                        labels_json: labels.to_string(),
                        value: count as f64,
                        timestamp: timestamp.clone(),
                        aggregation_window_s,
                    });
                }
            }

            // NOTE: Do NOT reset here — reset only after successful insert to avoid data loss.
            points
        };

        let count = points.len() as u64;
        if points.is_empty() {
            return 0;
        }

        match self.store.insert_metrics(&points) {
            Ok(_inserted) => {
                // REQ-18: Reset only after successful insert — if insert fails, data is preserved
                let mut inner = self.inner.lock().unwrap();
                inner.counters.clear();
                inner.histograms.clear();
                inner.last_flush = Instant::now();
                count
            }
            Err(e) => {
                tracing::error!(target: "fredo::telemetry", error = %e, "metrics flush error");
                0
            }
        }
    }

    /// REQ-5: Current active session count.
    pub fn active_session_count(&self) -> u64 {
        let inner = self.inner.lock().unwrap();
        inner.active_sessions.len() as u64
    }
}

// ── Helper: find histogram bucket for a duration ─────────────────────────────

/// Given a duration in milliseconds, return the bucket index (0..HISTOGRAM_BUCKET_COUNT).
fn find_histogram_bucket(duration_ms: u64) -> usize {
    for (i, &boundary) in HISTOGRAM_BUCKETS_MS.iter().enumerate() {
        if duration_ms < boundary {
            return i;
        }
    }
    HISTOGRAM_BUCKET_COUNT - 1 // +Inf bucket
}

// ── Histogram constants ────────────────────────────────────────────────────────

/// REQ-6: Histogram bucket boundaries in milliseconds.
pub const HISTOGRAM_BUCKETS_MS: [u64; 12] = [
    1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000,
];

/// Number of histogram buckets (12 boundaries → 13 buckets: one per boundary + +Inf).
pub const HISTOGRAM_BUCKET_COUNT: usize = 13;

// ── Extended TelemetryStats ──────────────────────────────────────────────────────

/// Extended telemetry stats including metric point count.
/// Used by IPC commands while infrastructure::telemetry::TelemetryStats remains unchanged.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryStatsExt {
    pub span_count: u64,
    pub storage_bytes: u64,
    pub metric_point_count: u64,
    pub log_count: u64,
}

// ── SpanStore extension contract ───────────────────────────────────────────────

/// Implemented by SpanStore. Capsule A calls these during flush; Capsule B provides the impl.
pub trait SpanStoreMetricsExt {
    /// REQ-9: Create telemetry_metrics table and indexes.
    fn ensure_metrics_schema(&self) -> Result<()>;

    /// REQ-10: Batch-insert pre-aggregated metric points.
    fn insert_metrics(&self, points: &[MetricPoint]) -> Result<usize>;

    /// Stats for telemetry_metrics: (point_count, storage_bytes).
    fn metric_stats(&self) -> Result<(u64, u64)>;

    /// REQ-11: Delete expired metric points.
    fn delete_metrics_expired(&self, retention_days: i64) -> Result<u64>;

    /// REQ-12: Delete all metric points.
    fn purge_metrics(&self) -> Result<u64>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::comm::event::{EventProvider, EventType, Transport};
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

    fn make_collector() -> (Arc<SpanStore>, Arc<AppStore>, Arc<MetricCollector>) {
        let dir = tempdir().unwrap();
        let store = Arc::new(SpanStore::open(dir.path().to_path_buf()).unwrap());
        store.ensure_schema().unwrap();
        store.ensure_metrics_schema().unwrap();
        let app_store = Arc::new(AppStore::open(dir.path().to_path_buf()).unwrap());
        app_store.set("tracing.metrics_enabled", "true").unwrap();
        app_store.set("tracing.metrics_aggregation_s", "60").unwrap();
        let collector = Arc::new(MetricCollector::new(store.clone(), app_store.clone()));
        (store, app_store, collector)
    }

    // ── AC-9: insert_metrics + metric_stats ──────────────────────────────────

    #[test]
    fn test_insert_metrics_and_stats() {
        let (store, _app_store, _collector) = make_collector();

        let points = vec![
            MetricPoint {
                metric_name: "span_count".to_string(),
                metric_type: MetricType::Counter,
                labels_json: "{}".to_string(),
                value: 5.0,
                timestamp: "2025-01-01T00:00:00+00:00".to_string(),
                aggregation_window_s: 60,
            },
            MetricPoint {
                metric_name: "span_count".to_string(),
                metric_type: MetricType::Counter,
                labels_json: "{}".to_string(),
                value: 3.0,
                timestamp: "2025-01-01T00:00:00+00:00".to_string(),
                aggregation_window_s: 60,
            },
            MetricPoint {
                metric_name: "active_sessions".to_string(),
                metric_type: MetricType::Gauge,
                labels_json: "{}".to_string(),
                value: 2.0,
                timestamp: "2025-01-01T00:00:00+00:00".to_string(),
                aggregation_window_s: 60,
            },
            MetricPoint {
                metric_name: "span_duration_ms".to_string(),
                metric_type: MetricType::Histogram,
                labels_json: r#"{"span_name":"read","le":"50"}"#.to_string(),
                value: 1.0,
                timestamp: "2025-01-01T00:00:00+00:00".to_string(),
                aggregation_window_s: 60,
            },
            MetricPoint {
                metric_name: "span_duration_ms".to_string(),
                metric_type: MetricType::Histogram,
                labels_json: r#"{"span_name":"read","le":"100"}"#.to_string(),
                value: 2.0,
                timestamp: "2025-01-01T00:00:00+00:00".to_string(),
                aggregation_window_s: 60,
            },
        ];

        let inserted = store.insert_metrics(&points).unwrap();
        assert_eq!(inserted, 5, "AC-9: should insert 5 MetricPoints");

        let (point_count, _storage) = store.metric_stats().unwrap();
        assert_eq!(point_count, 5, "AC-9: metric_stats returns point_count=5");
    }

    // ── AC-2: Init+Response increments span_count counter ────────────────

    #[test]
    fn test_init_response_increments_span_count() {
        let (_store, _app_store, collector) = make_collector();

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

        // Verify inner state directly
        let inner = collector.inner.lock().unwrap();
        let expected_key = "span_count|tool_use.read|ok".to_string();
        assert_eq!(
            inner.counters.get(&expected_key),
            Some(&1),
            "span_count{{span_name='tool_use.read', status='ok'}} should be 1"
        );
    }

    #[test]
    fn test_init_response_does_not_affect_other_span_counters() {
        let (_store, _app_store, collector) = make_collector();

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

        collector.process_events(&[init, resp]);

        let inner = collector.inner.lock().unwrap();
        // Other counter variants should not exist
        assert!(
            !inner.counters.contains_key("span_count|tool_use.read|error"),
            "error status counter should not exist for ok span"
        );
        assert!(
            !inner.counters.contains_key("span_count|chat|ok"),
            "unrelated span counter should not exist"
        );
    }

    // ── AC-3: Multiple Init events increment events_received ─────────────

    #[test]
    fn test_three_init_events_increment_events_received() {
        let (_store, _app_store, collector) = make_collector();

        // Three Init events with different (event_type, transport) combos
        let init1 = FredoEvent::builder()
            .state(EventState::Init)
            .correlation_id("c1")
            .session_id("s1")
            .event_type(EventType::ToolUse)
            .transport(Transport::Hook)
            .build();

        let init2 = FredoEvent::builder()
            .state(EventState::Init)
            .correlation_id("c2")
            .session_id("s2")
            .event_type(EventType::Chat)
            .transport(Transport::OtlpGrpc)
            .build();

        let init3 = FredoEvent::builder()
            .state(EventState::Init)
            .correlation_id("c3")
            .session_id("s3")
            .event_type(EventType::AgentSession)
            .transport(Transport::Hook)
            .build();

        collector.process_events(&[init1, init2, init3]);

        let inner = collector.inner.lock().unwrap();
        // Total distinct (event_type, transport) combos should be 3
        assert_eq!(
            inner.events_received.len(),
            3,
            "should have 3 distinct event_type/transport combos"
        );

        // Verify each specific counter
        assert_eq!(
            *inner.events_received.get("events_received|tool_use|hook").unwrap_or(&0),
            1,
            "tool_use/hook should have 1 observation"
        );
        assert_eq!(
            *inner.events_received.get("events_received|chat|otlp_grpc").unwrap_or(&0),
            1,
            "chat/otlp_grpc should have 1 observation"
        );
        assert_eq!(
            *inner.events_received.get("events_received|agent_session|hook").unwrap_or(&0),
            1,
            "agent_session/hook should have 1 observation"
        );

        // Verify the sum of all events_received values is 3
        let total: u64 = inner.events_received.values().sum();
        assert_eq!(total, 3, "total events_received should be 3");
    }

    // ── AC-5: Active sessions gauge flush ────────────────────────────────

    #[test]
    fn test_flush_writes_active_sessions_gauge() {
        let (store, _app_store, collector) = make_collector();

        // Create 3 active sessions (Init events without matching Response)
        let init1 = make_event(EventState::Init, "c1", "session-a", EventType::Chat, None);
        let init2 = make_event(EventState::Init, "c2", "session-b", EventType::ToolUse, None);
        let init3 = make_event(EventState::Init, "c3", "session-c", EventType::AgentSession, None);

        collector.process_events(&[init1, init2, init3]);

        // Verify 3 active sessions before flush
        assert_eq!(
            collector.active_session_count(),
            3,
            "should have 3 active sessions"
        );

        // Flush and verify the active_sessions gauge point was written
        let flushed = collector.flush_all();
        assert!(flushed >= 1, "should flush at least the active_sessions gauge");

        // Verify the active_sessions metric point exists in the store
        let conn = store.conn.lock().unwrap();
        let gauge_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM telemetry_metrics WHERE metric_name = 'active_sessions'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(gauge_count, 1, "should have 1 active_sessions gauge point");

        let gauge_value: f64 = conn
            .query_row(
                "SELECT value FROM telemetry_metrics WHERE metric_name = 'active_sessions'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            gauge_value, 3.0,
            "active_sessions gauge should be 3.0"
        );
    }

    // ── AC-6: Histogram bucket for 45ms ──────────────────────────────────

    #[test]
    fn test_45ms_falls_in_25_50_bucket() {
        let (_store, _app_store, collector) = make_collector();

        // Create Init+Response for tool_use.read with a 45ms duration
        let init = make_event(
            EventState::Init,
            "corr-hist",
            "sess-hist",
            EventType::ToolUse,
            Some("read"),
        );

        collector.process_events(&[init]);

        // Manually set the span_start to 45ms ago so elapsed() returns ~45ms
        {
            let mut inner = collector.inner.lock().unwrap();
            if let Some(start) = inner.span_starts.get_mut("corr-hist") {
                *start = Instant::now() - Duration::from_millis(45);
            }
        }

        // Now process the Response to trigger duration calculation
        let resp = make_event(
            EventState::Response,
            "corr-hist",
            "sess-hist",
            EventType::ToolUse,
            Some("read"),
        );
        collector.process_events(&[resp]);

        let inner = collector.inner.lock().unwrap();
        let buckets = inner
            .histograms
            .get("tool_use.read")
            .expect("should have histogram for tool_use.read");

        // Bucket [25, 50) is index 4 (boundaries: 1, 5, 10, 25, 50, ...)
        assert_eq!(
            buckets[4], 1,
            "bucket [25, 50) should have count=1 for 45ms duration"
        );

        // All other buckets should be 0
        for (i, &count) in buckets.iter().enumerate() {
            if i != 4 {
                assert_eq!(
                    count, 0,
                    "bucket {} should be 0 for 45ms duration",
                    i
                );
            }
        }
    }

    #[test]
    fn test_histogram_1ms_boundary() {
        let (_store, _app_store, collector) = make_collector();

        let init = make_event(EventState::Init, "c-fast", "s-fast", EventType::Chat, None);
        collector.process_events(&[init]);

        // Set duration to 0ms (below first bucket boundary)
        {
            let mut inner = collector.inner.lock().unwrap();
            if let Some(start) = inner.span_starts.get_mut("c-fast") {
                *start = Instant::now(); // ~0ms elapsed
            }
        }

        let resp = make_event(EventState::Response, "c-fast", "s-fast", EventType::Chat, None);
        collector.process_events(&[resp]);

        let inner = collector.inner.lock().unwrap();
        let buckets = inner.histograms.get("chat").expect("should have histogram");
        // 0ms < 1 → bucket 0
        assert_eq!(buckets[0], 1, "<1ms should be in bucket 0");
    }

    #[test]
    fn test_histogram_over_10s_boundary() {
        let (_store, _app_store, collector) = make_collector();

        let init = make_event(EventState::Init, "c-slow", "s-slow", EventType::Chat, None);
        collector.process_events(&[init]);

        // Set duration to 15000ms (over the last boundary of 10000ms)
        {
            let mut inner = collector.inner.lock().unwrap();
            if let Some(start) = inner.span_starts.get_mut("c-slow") {
                *start = Instant::now() - Duration::from_millis(15000);
            }
        }

        let resp = make_event(EventState::Response, "c-slow", "s-slow", EventType::Chat, None);
        collector.process_events(&[resp]);

        let inner = collector.inner.lock().unwrap();
        let buckets = inner.histograms.get("chat").expect("should have histogram");
        // Bucket 12 is the +Inf bucket (HISTOGRAM_BUCKET_COUNT - 1)
        assert_eq!(
            buckets[HISTOGRAM_BUCKET_COUNT - 1], 1,
            "15000ms should be in +Inf bucket"
        );
    }

    // ── AC-12: Metrics disabled = no-op; toggle-off flushes ──────────────

    #[test]
    fn test_metrics_disabled_no_op() {
        let (_store, app_store, collector) = make_collector();
        app_store.set("tracing.metrics_enabled", "false").unwrap();
        collector.refresh_enabled();

        // Process events — should be a no-op since disabled
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

        let inner = collector.inner.lock().unwrap();
        assert!(
            inner.counters.is_empty(),
            "counters should be empty when disabled"
        );
        assert!(
            inner.events_received.is_empty(),
            "events_received should be empty when disabled"
        );
        assert!(
            inner.span_starts.is_empty(),
            "span_starts should be empty when disabled"
        );
        assert!(
            inner.active_sessions.is_empty(),
            "active_sessions should be empty when disabled"
        );
    }

    #[test]
    fn test_toggle_off_flushes_before_stopping() {
        let (store, _app_store, collector) = make_collector();

        // Process some events while enabled
        let init = make_event(
            EventState::Init,
            "corr-flush",
            "sess-flush",
            EventType::ToolUse,
            Some("read"),
        );
        let resp = make_event(
            EventState::Response,
            "corr-flush",
            "sess-flush",
            EventType::ToolUse,
            Some("read"),
        );
        collector.process_events(&[init, resp]);

        // Toggle off — should flush remaining metrics
        let flushed = collector.disable_and_flush();

        // Should have flushed at least the span_count point (active_sessions was already
        // removed because the session's last span completed before disable)
        assert!(
            flushed >= 1,
            "should flush at least 1 metric point, got {}",
            flushed
        );

        // Verify metrics were persisted to store
        let (point_count, _) = store.metric_stats().unwrap();
        assert!(
            point_count >= 1,
            "should have at least 1 metric point in store, got {}",
            point_count
        );

        // Subsequent process_events should be no-op
        let init2 = make_event(
            EventState::Init,
            "corr-after",
            "sess-after",
            EventType::Chat,
            None,
        );
        collector.process_events(&[init2]);

        let inner = collector.inner.lock().unwrap();
        assert!(
            inner.counters.is_empty(),
            "counters should be empty after disable"
        );
    }

    // ── Active session count ─────────────────────────────────────────────

    #[test]
    fn test_active_session_count_returns_count() {
        let (_store, _app_store, collector) = make_collector();

        assert_eq!(
            collector.active_session_count(),
            0,
            "should start with 0 active sessions"
        );

        collector.process_events(&[make_event(
            EventState::Init,
            "c1",
            "sess-1",
            EventType::Chat,
            None,
        )]);
        assert_eq!(collector.active_session_count(), 1);

        collector.process_events(&[make_event(
            EventState::Init,
            "c2",
            "sess-2",
            EventType::ToolUse,
            None,
        )]);
        assert_eq!(collector.active_session_count(), 2);
    }

    // ── REQ-5: Session lifecycle — init increments, response/error decrements ──

    #[test]
    fn test_session_lifecycle_single_span() {
        let (_store, _app_store, collector) = make_collector();

        // Init: session becomes active
        collector.process_events(&[make_event(
            EventState::Init,
            "c1",
            "sess-lifecycle",
            EventType::Chat,
            None,
        )]);
        assert_eq!(collector.active_session_count(), 1);

        // Response: session becomes inactive (last span completed)
        collector.process_events(&[make_event(
            EventState::Response,
            "c1",
            "sess-lifecycle",
            EventType::Chat,
            None,
        )]);
        assert_eq!(collector.active_session_count(), 0);
    }

    #[test]
    fn test_session_lifecycle_multiple_spans_on_same_session() {
        let (_store, _app_store, collector) = make_collector();

        // Two concurrent spans on the same session
        collector.process_events(&[make_event(
            EventState::Init,
            "c1",
            "sess-multi",
            EventType::ToolUse,
            Some("read"),
        )]);
        collector.process_events(&[make_event(
            EventState::Init,
            "c2",
            "sess-multi",
            EventType::ToolUse,
            Some("write"),
        )]);
        assert_eq!(collector.active_session_count(), 1);

        // One span completes — session still active (other span still in flight)
        collector.process_events(&[make_event(
            EventState::Response,
            "c1",
            "sess-multi",
            EventType::ToolUse,
            Some("read"),
        )]);
        assert_eq!(collector.active_session_count(), 1);

        // Second span completes — session becomes inactive
        collector.process_events(&[make_event(
            EventState::Response,
            "c2",
            "sess-multi",
            EventType::ToolUse,
            Some("write"),
        )]);
        assert_eq!(collector.active_session_count(), 0);
    }

    #[test]
    fn test_session_lifecycle_error_removes_session() {
        let (_store, _app_store, collector) = make_collector();

        collector.process_events(&[make_event(
            EventState::Init,
            "c1",
            "sess-err",
            EventType::ToolUse,
            Some("deploy"),
        )]);
        assert_eq!(collector.active_session_count(), 1);

        // Error also decrements the span count
        collector.process_events(&[make_event(
            EventState::Error,
            "c1",
            "sess-err",
            EventType::ToolUse,
            Some("deploy"),
        )]);
        assert_eq!(collector.active_session_count(), 0);
    }

    // ── Flush returns count ──────────────────────────────────────────────

    #[test]
    fn test_flush_all_returns_zero_when_empty() {
        let (_store, _app_store, collector) = make_collector();

        let flushed = collector.flush_all();
        assert_eq!(flushed, 0, "flush of empty buffer should return 0");
    }

    #[test]
    fn test_flush_all_with_data() {
        let (store, _app_store, collector) = make_collector();

        // Create a completed span
        let init = make_event(
            EventState::Init,
            "corr-flush2",
            "sess-flush2",
            EventType::ToolUse,
            Some("read"),
        );
        let resp = make_event(
            EventState::Response,
            "corr-flush2",
            "sess-flush2",
            EventType::ToolUse,
            Some("read"),
        );
        collector.process_events(&[init, resp]);

        let flushed = collector.flush_all();
        // span_count counter is emitted (active_sessions was already removed because the
        // span completed before flush)
        assert!(flushed >= 1, "should flush at least 1 metric point, got {}", flushed);

        // Verify in store
        let (point_count, _) = store.metric_stats().unwrap();
        assert_eq!(point_count, flushed as u64);
    }

    // ── Record orphan count ──────────────────────────────────────────────

    #[test]
    fn test_record_orphan_count_increments_counter() {
        let (_store, _app_store, collector) = make_collector();

        collector.record_orphan_count(2);

        {
            let inner = collector.inner.lock().unwrap();
            assert_eq!(
                *inner.counters.get("orphan_spans").unwrap_or(&0),
                2,
                "orphan_spans counter should be 2"
            );
        } // drop inner lock

        collector.record_orphan_count(3);

        {
            let inner = collector.inner.lock().unwrap();
            assert_eq!(
                *inner.counters.get("orphan_spans").unwrap_or(&0),
                5,
                "orphan_spans counter should accumulate to 5"
            );
        }
    }

    #[test]
    fn test_record_orphan_disabled_no_op() {
        let (_store, app_store, collector) = make_collector();
        app_store.set("tracing.metrics_enabled", "false").unwrap();
        collector.refresh_enabled();

        collector.record_orphan_count(5);

        let inner = collector.inner.lock().unwrap();
        assert!(
            inner.counters.is_empty(),
            "counters should be empty when disabled"
        );
    }

    // ── Error event produces status='error' counter ──────────────────────

    #[test]
    fn test_error_event_increments_error_span_count() {
        let (_store, _app_store, collector) = make_collector();

        let init = make_event(
            EventState::Init,
            "corr-err",
            "sess-err",
            EventType::ToolUse,
            Some("deploy"),
        );
        let err = make_event(
            EventState::Error,
            "corr-err",
            "sess-err",
            EventType::ToolUse,
            Some("deploy"),
        );

        collector.process_events(&[init, err]);

        let inner = collector.inner.lock().unwrap();
        assert_eq!(
            *inner
                .counters
                .get("span_count|tool_use.deploy|error")
                .unwrap_or(&0),
            1,
            "error span_count should be 1"
        );
        assert!(
            !inner
                .counters
                .contains_key("span_count|tool_use.deploy|ok"),
            "ok counter should not exist for error span"
        );
    }

    // ── Refresh enabled ──────────────────────────────────────────────────

    #[test]
    fn test_refresh_enabled_reads_app_store() {
        let (_store, app_store, collector) = make_collector();

        // Initially enabled
        assert!(collector.enabled_cache.load(std::sync::atomic::Ordering::SeqCst));

        // Change in AppStore and refresh
        app_store.set("tracing.metrics_enabled", "false").unwrap();
        collector.refresh_enabled();
        assert!(!collector.enabled_cache.load(std::sync::atomic::Ordering::SeqCst));

        // Change back
        app_store.set("tracing.metrics_enabled", "true").unwrap();
        collector.refresh_enabled();
        assert!(collector.enabled_cache.load(std::sync::atomic::Ordering::SeqCst));
    }
}
