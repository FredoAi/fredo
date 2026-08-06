/// grpc.rs — OTLP/gRPC receiver on 127.0.0.1:4317 (OpenCode).
///
/// Implements the three standard OTLP collector services:
///   • TraceService   — receives spans
///   • MetricsService — receives metrics
///   • LogsService    — receives log records / events
///
/// Each exported batch is mapped to FredoEvents via OpenCodeAdapter and
/// emitted to the webview via EventBus. Metrics and logs are additionally
/// persisted to `telemetry_metrics` / `telemetry_logs` (Spec #1499, GA-5/6/7).
use std::sync::Arc;

use tauri::{AppHandle, Manager};
use tonic::{Request, Response, Status};

use opentelemetry_proto::tonic::collector::{
    logs::v1::{
        logs_service_server::{LogsService, LogsServiceServer},
        ExportLogsServiceRequest, ExportLogsServiceResponse,
    },
    metrics::v1::{
        metrics_service_server::{MetricsService, MetricsServiceServer},
        ExportMetricsServiceRequest, ExportMetricsServiceResponse,
    },
    trace::v1::{
        trace_service_server::{TraceService, TraceServiceServer},
        ExportTraceServiceRequest, ExportTraceServiceResponse,
    },
};
use opentelemetry_proto::tonic::common::v1::{any_value, AnyValue, KeyValue};
use opentelemetry_proto::tonic::metrics::v1 as otlp_metrics;

use crate::infrastructure::comm::adapter::CommAdapter;
use crate::infrastructure::comm::adapters::opencode::OpenCodeAdapter;
use crate::infrastructure::comm::bus::EventBus;
use crate::infrastructure::comm::contract::engine::ContractEngine;
use crate::infrastructure::comm::contract::EventContractEngine;
use crate::infrastructure::comm::event::Transport;
use crate::infrastructure::contract_407::{
    MetricCollector, MetricPoint, MetricType, SpanStoreMetricsExt,
};
use crate::infrastructure::storage::span_store::SpanStore;
use crate::infrastructure::telemetry::log::LogRecord;
use crate::infrastructure::telemetry::SpanCollector;

// ── TraceService ──────────────────────────────────────────────────────────────

pub struct OtlpTraceService(pub AppHandle);

#[tonic::async_trait]
impl TraceService for OtlpTraceService {
    async fn export(
        &self,
        request: Request<ExportTraceServiceRequest>,
    ) -> Result<Response<ExportTraceServiceResponse>, Status> {
        let resource_spans = request.into_inner().resource_spans;
        let span_count: usize = resource_spans.iter()
            .flat_map(|rs| rs.scope_spans.iter())
            .flat_map(|ss| ss.spans.iter())
            .count();
        tracing::info!(target: "fredo::otlp", span_count = %span_count, "gRPC export received");
        let json_value = serde_json::json!({
            "resourceSpans": resource_spans
        });
        tracing::debug!(target: "fredo::otlp", json_size = %json_value.to_string().len(), "gRPC JSON serialized");
        // Use shared OpenCodeAdapter from Tauri state (Spec #382 AC-4 fix).
        let adapter = self.0.state::<std::sync::Arc<OpenCodeAdapter>>();
        tracing::info!(target: "fredo::otlp", "calling adapter.transform");
        match adapter.transform(Transport::OtlpGrpc, json_value).await {
            Ok(events) => {
                tracing::info!(target: "fredo::otlp", event_count = %events.len(), "adapter transform success");
                if !events.is_empty() {
                    tracing::info!(target: "fredo::otlp", first_event_type = %events[0].event_type.as_str(), first_session = %events[0].session_id, "first event details");
                }
                // Telemetry: collect spans from events before routing to ContractEngine
                let collector = self.0.state::<std::sync::Arc<SpanCollector>>();
                collector.process_events(&events);

                // Metrics: collect metrics from events in parallel (REQ-1)
                let metric_collector = self.0.state::<std::sync::Arc<MetricCollector>>();
                metric_collector.process_events(&events);

                let engine = self.0.state::<std::sync::Arc<ContractEngine>>();
                let bus = self.0.state::<EventBus>();
                for fredo_event in events {
                    let deliveries = engine.req_2_3_process(fredo_event);
                    for delivery in deliveries {
                        bus.emit_delivery(delivery);
                    }
                }
            }
            Err(e) => {
                tracing::error!(target: "fredo::otlp", error = %e, "adapter transform failed");
            }
        }
        Ok(Response::new(ExportTraceServiceResponse {
            partial_success: None,
        }))
    }
}

// ── MetricsService ────────────────────────────────────────────────────────────

pub struct OtlpMetricsService(pub AppHandle);

#[tonic::async_trait]
impl MetricsService for OtlpMetricsService {
    async fn export(
        &self,
        request: Request<ExportMetricsServiceRequest>,
    ) -> Result<Response<ExportMetricsServiceResponse>, Status> {
        let request = request.into_inner();
        let points = otlp_metrics_to_points(&request);
        if !points.is_empty() {
            // Spec #1499 (GA-7): persist OTLP metrics to telemetry_metrics.
            let store = self.0.state::<Arc<SpanStore>>();
            match store.insert_metrics(&points) {
                Ok(n) => tracing::info!(target: "fredo::otlp", inserted = n, "OTLP metrics persisted"),
                Err(e) => tracing::error!(target: "fredo::otlp", error = %e, "OTLP metrics insert failed"),
            }
        }
        Ok(Response::new(ExportMetricsServiceResponse {
            partial_success: None,
        }))
    }
}

// ── LogsService ───────────────────────────────────────────────────────────────

pub struct OtlpLogsService(pub AppHandle);

#[tonic::async_trait]
impl LogsService for OtlpLogsService {
    async fn export(
        &self,
        request: Request<ExportLogsServiceRequest>,
    ) -> Result<Response<ExportLogsServiceResponse>, Status> {
        let request = request.into_inner();
        let records = otlp_logs_to_records(&request);
        if !records.is_empty() {
            // Spec #1499 (GA-5/GA-6): persist OTLP log records / events to telemetry_logs.
            let store = self.0.state::<Arc<SpanStore>>();
            match store.insert_logs(&records) {
                Ok(n) => tracing::info!(target: "fredo::otlp", inserted = n, "OTLP log records persisted"),
                Err(e) => tracing::error!(target: "fredo::otlp", error = %e, "OTLP log insert failed"),
            }
        }
        Ok(Response::new(ExportLogsServiceResponse {
            partial_success: None,
        }))
    }
}

// ── OTLP conversion helpers (Spec #1499) ─────────────────────────────────────

/// Convert an OTLP `AnyValue` to a serde_json value.
fn any_value_to_json(value: &Option<AnyValue>) -> serde_json::Value {
    use any_value::Value as AnyVal;
    match value.as_ref().and_then(|v| v.value.as_ref()) {
        Some(AnyVal::StringValue(s)) => serde_json::Value::String(s.clone()),
        Some(AnyVal::BoolValue(b)) => serde_json::Value::Bool(*b),
        Some(AnyVal::IntValue(i)) => serde_json::json!(*i),
        Some(AnyVal::DoubleValue(d)) => serde_json::json!(*d),
        Some(AnyVal::BytesValue(b)) => serde_json::Value::String(bytes_to_hex(b)),
        Some(AnyVal::ArrayValue(arr)) => {
            let vals = arr.values.iter().map(|v| any_value_to_json(&Some(v.clone()))).collect();
            serde_json::Value::Array(vals)
        }
        Some(AnyVal::KvlistValue(kv)) => {
            let mut map = serde_json::Map::new();
            for kv in &kv.values {
                map.insert(kv.key.clone(), any_value_to_json(&kv.value));
            }
            serde_json::Value::Object(map)
        }
        None => serde_json::Value::Null,
    }
}

/// Convert an OTLP attribute array to a JSON object string (labels_json).
fn attrs_to_json(attrs: &[KeyValue]) -> String {
    let mut map = serde_json::Map::new();
    for kv in attrs {
        map.insert(kv.key.clone(), any_value_to_json(&kv.value));
    }
    serde_json::Value::Object(map).to_string()
}

/// Convert OTLP unix-nano timestamp to RFC3339 (falls back to now when 0).
fn unix_nano_to_rfc3339(ns: u64) -> String {
    if ns == 0 {
        return chrono::Utc::now().to_rfc3339();
    }
    let secs = (ns / 1_000_000_000) as i64;
    let nsecs = (ns % 1_000_000_000) as u32;
    chrono::DateTime::from_timestamp(secs, nsecs)
        .map(|dt| dt.to_rfc3339())
        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339())
}

/// Small hex encoder (no external hex dependency in this crate).
fn bytes_to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Map an OTLP severity number to a Fredo log level string.
fn severity_number_to_level(n: i32) -> String {
    match n {
        1..=4 => "TRACE",
        5..=8 => "DEBUG",
        9..=12 => "INFO",
        13..=16 => "WARN",
        17..=20 => "ERROR",
        _ => "FATAL",
    }
    .to_string()
}

/// Extract all metric data points from an OTLP metrics export as MetricPoints.
fn otlp_metrics_to_points(request: &ExportMetricsServiceRequest) -> Vec<MetricPoint> {
    use otlp_metrics::metric::Data as MetricData;

    let mut points: Vec<MetricPoint> = Vec::new();
    for rm in &request.resource_metrics {
        for sm in &rm.scope_metrics {
            for metric in &sm.metrics {
                let Some(data) = &metric.data else {
                    continue;
                };
                match data {
                    MetricData::Gauge(gauge) => {
                        for dp in &gauge.data_points {
                            let Some(value) = point_value(dp) else {
                                continue;
                            };
                            points.push(MetricPoint {
                                metric_name: metric.name.clone(),
                                metric_type: MetricType::Gauge,
                                labels_json: attrs_to_json(&dp.attributes),
                                value,
                                timestamp: unix_nano_to_rfc3339(dp.time_unix_nano),
                                aggregation_window_s: aggregation_window(dp),
                            });
                        }
                    }
                    MetricData::Sum(sum) => {
                        for dp in &sum.data_points {
                            let Some(value) = point_value(dp) else {
                                continue;
                            };
                            points.push(MetricPoint {
                                metric_name: metric.name.clone(),
                                metric_type: MetricType::Counter,
                                labels_json: attrs_to_json(&dp.attributes),
                                value,
                                timestamp: unix_nano_to_rfc3339(dp.time_unix_nano),
                                aggregation_window_s: aggregation_window(dp),
                            });
                        }
                    }
                    MetricData::Histogram(hist) => {
                        for dp in &hist.data_points {
                            let value = dp.sum.unwrap_or(dp.count as f64);
                            points.push(MetricPoint {
                                metric_name: metric.name.clone(),
                                metric_type: MetricType::Histogram,
                                labels_json: attrs_to_json(&dp.attributes),
                                value,
                                timestamp: unix_nano_to_rfc3339(dp.time_unix_nano),
                                aggregation_window_s: {
                                    if dp.start_time_unix_nano == 0 || dp.time_unix_nano <= dp.start_time_unix_nano {
                                        0
                                    } else {
                                        ((dp.time_unix_nano - dp.start_time_unix_nano) / 1_000_000_000) as i64
                                    }
                                },
                            });
                        }
                    }
                    _ => {
                        // ExponentialHistogram / Summary — not mapped by any UI feature.
                    }
                }
            }
        }
    }
    points
}

/// Numeric value of an OTLP number data point, if present.
fn point_value(dp: &otlp_metrics::NumberDataPoint) -> Option<f64> {
    use otlp_metrics::number_data_point::Value as PointValue;
    match dp.value.as_ref()? {
        PointValue::AsDouble(d) => Some(*d),
        PointValue::AsInt(i) => Some(*i as f64),
    }
}

/// Aggregation window seconds for a number data point (0 when start is unknown).
fn aggregation_window(dp: &otlp_metrics::NumberDataPoint) -> i64 {
    if dp.start_time_unix_nano == 0 || dp.time_unix_nano <= dp.start_time_unix_nano {
        0
    } else {
        ((dp.time_unix_nano - dp.start_time_unix_nano) / 1_000_000_000) as i64
    }
}

/// Convert all OTLP log records in an export to Fredo LogRecords.
fn otlp_logs_to_records(request: &ExportLogsServiceRequest) -> Vec<LogRecord> {
    let mut records: Vec<LogRecord> = Vec::new();
    for rl in &request.resource_logs {
        for sl in &rl.scope_logs {
            for lr in &sl.log_records {
                let message = match &lr.body {
                    Some(body) => match body.value.as_ref() {
                        Some(any_value::Value::StringValue(s)) => s.clone(),
                        Some(_) => any_value_to_json(&Some(body.clone())).to_string(),
                        None => String::new(),
                    },
                    None => String::new(),
                };
                let level = if lr.severity_text.is_empty() {
                    severity_number_to_level(lr.severity_number)
                } else {
                    lr.severity_text.to_uppercase()
                };
                // Extract session.id from attributes for session correlation.
                let session_id = lr.attributes.iter().find(|kv| kv.key == "session.id").and_then(|kv| {
                    match kv.value.as_ref().and_then(|v| v.value.as_ref()) {
                        Some(any_value::Value::StringValue(s)) => Some(s.clone()),
                        _ => None,
                    }
                });
                records.push(LogRecord {
                    timestamp: unix_nano_to_rfc3339(lr.time_unix_nano),
                    level,
                    target: "fredo::otlp".to_string(),
                    message,
                    attributes_json: attrs_to_json(&lr.attributes),
                    trace_id: if lr.trace_id.is_empty() {
                        None
                    } else {
                        Some(bytes_to_hex(&lr.trace_id))
                    },
                    span_id: if lr.span_id.is_empty() {
                        None
                    } else {
                        Some(bytes_to_hex(&lr.span_id))
                    },
                    session_id,
                });
            }
        }
    }
    records
}

// ── Server startup ────────────────────────────────────────────────────────────

pub async fn start(app: AppHandle) -> anyhow::Result<()> {
    let addr = "127.0.0.1:4317".parse()?;

    tracing::info!(target: "fredo::otlp", addr = %addr, "gRPC receiver listening");

    tonic::transport::Server::builder()
        .add_service(TraceServiceServer::new(OtlpTraceService(app.clone())))
        .add_service(MetricsServiceServer::new(OtlpMetricsService(app.clone())))
        .add_service(LogsServiceServer::new(OtlpLogsService(app)))
        .serve(addr)
        .await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use opentelemetry_proto::tonic::common::v1::any_value;
    use opentelemetry_proto::tonic::logs::v1::{LogRecord as OtlpLogRecord, ResourceLogs, ScopeLogs};
    use opentelemetry_proto::tonic::metrics::v1::{
        metric, number_data_point, Gauge, Histogram, Metric as OtlpMetric, NumberDataPoint,
        ResourceMetrics, ScopeMetrics,
    };

    fn kv(key: &str, value: any_value::Value) -> KeyValue {
        KeyValue {
            key: key.to_string(),
            value: Some(AnyValue {
                value: Some(value),
            }),
        }
    }

    fn metric_request(metrics: Vec<OtlpMetric>) -> ExportMetricsServiceRequest {
        ExportMetricsServiceRequest {
            resource_metrics: vec![ResourceMetrics {
                resource: None,
                scope_metrics: vec![ScopeMetrics {
                    scope: None,
                    metrics,
                    schema_url: String::new(),
                }],
                schema_url: String::new(),
            }],
        }
    }

    // ── Spec #1499 (GA-7): OTLP metrics → telemetry_metrics ────────────────

    #[test]
    fn otlp_sum_metric_maps_to_counter_point() {
        let dp = NumberDataPoint {
            attributes: vec![
                kv("gen_ai.operation.name", any_value::Value::StringValue("chat".to_string())),
                kv("gen_ai.provider.name", any_value::Value::StringValue("anthropic".to_string())),
                kv("gen_ai.token.type", any_value::Value::StringValue("input".to_string())),
            ],
            start_time_unix_nano: 1_000_000_000,
            time_unix_nano: 11_000_000_000,
            exemplars: Vec::new(),
            flags: 0,
            value: Some(number_data_point::Value::AsInt(1250)),
        };
        let metric = OtlpMetric {
            name: "gen_ai.client.token.usage".to_string(),
            data: Some(metric::Data::Sum(opentelemetry_proto::tonic::metrics::v1::Sum {
                data_points: vec![dp],
                aggregation_temporality: 0,
                is_monotonic: false,
            })),
            ..Default::default()
        };

        let points = otlp_metrics_to_points(&metric_request(vec![metric]));
        assert_eq!(points.len(), 1);
        let p = &points[0];
        assert_eq!(p.metric_name, "gen_ai.client.token.usage");
        assert_eq!(p.metric_type, MetricType::Counter);
        assert_eq!(p.value, 1250.0);
        assert_eq!(p.aggregation_window_s, 10);
        let labels: serde_json::Value = serde_json::from_str(&p.labels_json).unwrap();
        assert_eq!(labels["gen_ai.operation.name"], "chat");
        assert_eq!(labels["gen_ai.provider.name"], "anthropic");
        assert_eq!(labels["gen_ai.token.type"], "input");
    }

    #[test]
    fn otlp_histogram_metric_maps_to_histogram_point() {
        let dp = opentelemetry_proto::tonic::metrics::v1::HistogramDataPoint {
            attributes: vec![kv("gen_ai.operation.name", any_value::Value::StringValue("chat".to_string()))],
            start_time_unix_nano: 1_000_000_000,
            time_unix_nano: 3_000_000_000,
            count: 5,
            sum: Some(2450.0),
            bucket_counts: Vec::new(),
            explicit_bounds: Vec::new(),
            exemplars: Vec::new(),
            flags: 0,
            min: None,
            max: None,
        };
        let metric = OtlpMetric {
            name: "gen_ai.client.operation.duration".to_string(),
            data: Some(metric::Data::Histogram(Histogram {
                data_points: vec![dp],
                aggregation_temporality: 0,
            })),
            ..Default::default()
        };

        let points = otlp_metrics_to_points(&metric_request(vec![metric]));
        assert_eq!(points.len(), 1);
        let p = &points[0];
        assert_eq!(p.metric_name, "gen_ai.client.operation.duration");
        assert_eq!(p.metric_type, MetricType::Histogram);
        assert_eq!(p.value, 2450.0);
        assert_eq!(p.aggregation_window_s, 2);
    }

    #[test]
    fn otlp_gauge_metric_maps_to_gauge_point() {
        let dp = NumberDataPoint {
            attributes: vec![],
            start_time_unix_nano: 0,
            time_unix_nano: 5_000_000_000,
            exemplars: Vec::new(),
            flags: 0,
            value: Some(number_data_point::Value::AsDouble(3.5)),
        };
        let metric = OtlpMetric {
            name: "fredo.session.count".to_string(),
            data: Some(metric::Data::Gauge(Gauge {
                data_points: vec![dp],
            })),
            ..Default::default()
        };

        let points = otlp_metrics_to_points(&metric_request(vec![metric]));
        assert_eq!(points.len(), 1);
        let p = &points[0];
        assert_eq!(p.metric_name, "fredo.session.count");
        assert_eq!(p.metric_type, MetricType::Gauge);
        assert_eq!(p.value, 3.5);
    }

    #[test]
    fn otlp_metrics_empty_export_yields_no_points() {
        let points = otlp_metrics_to_points(&metric_request(Vec::new()));
        assert!(points.is_empty());
    }

    // ── Spec #1499 (GA-5/GA-6): OTLP logs → telemetry_logs ─────────────────

    #[test]
    fn otlp_log_record_maps_to_telemetry_log() {
        let request = ExportLogsServiceRequest {
            resource_logs: vec![ResourceLogs {
                resource: None,
                scope_logs: vec![ScopeLogs {
                    scope: None,
                    log_records: vec![OtlpLogRecord {
                        time_unix_nano: 1_000_000_000,
                        observed_time_unix_nano: 1_000_000_000,
                        severity_number: 17, // SEVERITY_NUMBER_ERROR
                        severity_text: "ERROR".to_string(),
                        body: Some(AnyValue {
                            value: Some(any_value::Value::StringValue(
                                "gen_ai.client.operation.exception".to_string(),
                            )),
                        }),
                        attributes: vec![
                            kv("exception.type", any_value::Value::StringValue("ApiError".to_string())),
                            kv("exception.message", any_value::Value::StringValue("rate limited".to_string())),
                            kv("session.id", any_value::Value::StringValue("sess-log-1".to_string())),
                        ],
                        dropped_attributes_count: 0,
                        flags: 0,
                        trace_id: vec![0xAB; 16],
                        span_id: vec![0xCD; 8],
                    }],
                    schema_url: String::new(),
                }],
                schema_url: String::new(),
            }],
        };

        let records = otlp_logs_to_records(&request);
        assert_eq!(records.len(), 1);
        let r = &records[0];
        assert_eq!(r.level, "ERROR");
        assert_eq!(r.message, "gen_ai.client.operation.exception");
        assert_eq!(r.session_id.as_deref(), Some("sess-log-1"));
        assert_eq!(r.trace_id.as_deref(), Some("abababababababababababababababab"));
        assert_eq!(r.span_id.as_deref(), Some("cdcdcdcdcdcdcdcd"));
        let attrs: serde_json::Value = serde_json::from_str(&r.attributes_json).unwrap();
        assert_eq!(attrs["exception.type"], "ApiError");
        assert_eq!(attrs["exception.message"], "rate limited");
    }

    #[test]
    fn otlp_log_record_severity_number_fallback() {
        let request = ExportLogsServiceRequest {
            resource_logs: vec![ResourceLogs {
                resource: None,
                scope_logs: vec![ScopeLogs {
                    scope: None,
                    log_records: vec![OtlpLogRecord {
                        time_unix_nano: 1_000_000_000,
                        observed_time_unix_nano: 0,
                        severity_number: 13, // WARN
                        severity_text: String::new(),
                        body: None,
                        attributes: vec![],
                        dropped_attributes_count: 0,
                        flags: 0,
                        trace_id: Vec::new(),
                        span_id: Vec::new(),
                    }],
                    schema_url: String::new(),
                }],
                schema_url: String::new(),
            }],
        };

        let records = otlp_logs_to_records(&request);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].level, "WARN");
    }

    #[test]
    fn otlp_logs_empty_export_yields_no_records() {
        let request = ExportLogsServiceRequest {
            resource_logs: Vec::new(),
        };
        let records = otlp_logs_to_records(&request);
        assert!(records.is_empty());
    }
}
