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
            .control_get("tracing.metrics_enabled")
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
            .control_get("tracing.metrics_enabled")
            .ok()
            .flatten()
            .map(|v| v == "true")
            .unwrap_or(true);
        self.enabled_cache
            .store(enabled, std::sync::atomic::Ordering::SeqCst);
    }

    /// REQ-13: Toggle-off flushes remaining metrics before stopping.
    pub async fn disable_and_flush(&self) -> u64 {
        let flushed = self.flush_all().await;
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
    pub async fn flush_if_needed(&self) -> u64 {
        if !self.enabled_cache.load(std::sync::atomic::Ordering::SeqCst) {
            return 0;
        }

        let aggregation_window_s = self
            .app_store
            .control_get("tracing.metrics_aggregation_s")
            .ok()
            .flatten()
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(60);

        let should_flush = {
            let inner = self.inner.lock().unwrap();
            inner.last_flush.elapsed() >= Duration::from_secs(aggregation_window_s as u64)
        };

        if should_flush {
            self.flush_all().await
        } else {
            0
        }
    }

    /// REQ-18: Force-flush all buffered metrics.
    pub async fn flush_all(&self) -> u64 {
        let points = {
            let inner = self.inner.lock().unwrap();
            let mut points: Vec<MetricPoint> = Vec::new();
            let timestamp = chrono::Utc::now().to_rfc3339();

            // Get aggregation window from settings
            let aggregation_window_s = self
                .app_store
                .control_get("tracing.metrics_aggregation_s")
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

        match self.store.insert_metrics(&points).await {
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
#[async_trait::async_trait]
pub trait SpanStoreMetricsExt {
    /// REQ-9: Create telemetry_metrics table and indexes.
    async fn ensure_metrics_schema(&self) -> Result<()>;

    /// REQ-10: Batch-insert pre-aggregated metric points.
    async fn insert_metrics(&self, points: &[MetricPoint]) -> Result<usize>;

    /// Stats for telemetry_metrics: (point_count, storage_bytes).
    async fn metric_stats(&self) -> Result<(u64, u64)>;

    /// REQ-11: Delete expired metric points.
    async fn delete_metrics_expired(&self, retention_days: i64) -> Result<u64>;

    /// REQ-12: Delete all metric points.
    async fn purge_metrics(&self) -> Result<u64>;
}
