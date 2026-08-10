/// http.rs — OTLP/HTTP receiver on 127.0.0.1:4318 (OpenCode).
///
/// OpenCode can use `otlp-http`, so this axum server handles:
///   POST /v1/traces  — ExportTraceServiceRequest  (application/x-protobuf)
///   POST /v1/metrics — ExportMetricsServiceRequest (application/x-protobuf)
///   POST /v1/logs    — ExportLogsServiceRequest    (application/x-protobuf)
///
/// Both protobuf and JSON OTLP payloads are handled. Trace exports are
/// persisted raw on receipt (`raw.rs` → `telemetry_spans`, Spec #2449 R1) and
/// their OTLP projection is normalized into `EngineInput`s by the
/// provider-agnostic `GenericOtlpAdapter`, delivered via the ECE → EventBus
/// (R3). Metrics and logs are persisted to `telemetry_metrics` / `telemetry_logs`
/// (Spec #2449 R2), matching the gRPC receiver.
use axum::{
    body::Bytes,
    extract::State,
    http::{header, HeaderMap, StatusCode},
    response::Json,
    routing::{get, post},
    Router,
};
use prost::Message;
use tauri::{AppHandle, Manager};

use opentelemetry_proto::tonic::collector::{
    logs::v1::ExportLogsServiceRequest,
    metrics::v1::ExportMetricsServiceRequest,
    trace::v1::ExportTraceServiceRequest,
};

use crate::infrastructure::comm::adapters::otlp::GenericOtlpAdapter;
use crate::infrastructure::comm::bus::EventBus;
use crate::infrastructure::comm::contract::engine::ContractEngine;
use crate::infrastructure::comm::contract::EventContractEngine;
use crate::infrastructure::comm::event::Transport;
use crate::infrastructure::contract_407::SpanStoreMetricsExt;
use crate::infrastructure::otlp::grpc::{otlp_logs_to_records, otlp_metrics_to_points};
use crate::infrastructure::otlp::raw::raw_spans_from_export;
use crate::infrastructure::storage::span_store::SpanStore;

/// Shared state for the OTLP HTTP server.
#[derive(Clone)]
struct OtlpState {
    app: AppHandle,
}

// ── Handler helpers ───────────────────────────────────────────────────────────

fn is_protobuf(headers: &HeaderMap) -> bool {
    headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|ct| ct.contains("application/x-protobuf") || ct.contains("application/protobuf"))
        .unwrap_or(false)
}

/// R1/R5: persist every span in the export to `telemetry_spans` before and
/// independent of delivery processing. Insert failure logs-and-continues (R11).
fn persist_raw_spans(app: &AppHandle, request: &ExportTraceServiceRequest, transport: &str) {
    let store = app.state::<std::sync::Arc<SpanStore>>();
    let raw_spans = raw_spans_from_export(request, transport);
    match store.insert_raw_spans(&raw_spans) {
        Ok(n) => tracing::info!(target: "fredo::otlp", inserted = n, "raw OTLP spans persisted"),
        Err(e) => tracing::error!(target: "fredo::otlp", error = %e, "raw OTLP span insert failed"),
    }
}

/// R2: persist OTLP metric points to `telemetry_metrics` (log-and-continue).
fn persist_metrics(app: &AppHandle, request: &ExportMetricsServiceRequest) {
    let points = otlp_metrics_to_points(request);
    if !points.is_empty() {
        let store = app.state::<std::sync::Arc<SpanStore>>();
        match store.insert_metrics(&points) {
            Ok(n) => tracing::info!(target: "fredo::otlp", inserted = n, "OTLP HTTP metrics persisted"),
            Err(e) => tracing::error!(target: "fredo::otlp", error = %e, "OTLP HTTP metrics insert failed"),
        }
    }
}

/// R2: persist OTLP log records to `telemetry_logs` (log-and-continue).
fn persist_logs(app: &AppHandle, request: &ExportLogsServiceRequest) {
    let records = otlp_logs_to_records(request);
    if !records.is_empty() {
        let store = app.state::<std::sync::Arc<SpanStore>>();
        match store.insert_logs(&records) {
            Ok(n) => tracing::info!(target: "fredo::otlp", inserted = n, "OTLP HTTP log records persisted"),
            Err(e) => tracing::error!(target: "fredo::otlp", error = %e, "OTLP HTTP log insert failed"),
        }
    }
}

// ── Route handlers ────────────────────────────────────────────────────────────

async fn handle_traces(
    State(state): State<OtlpState>,
    headers: HeaderMap,
    body: Bytes,
) -> StatusCode {
    let app = &state.app;
    if is_protobuf(&headers) {
        // Protobuf OTLP — decode, persist raw, then deliver via GenericOtlpAdapter.
        match ExportTraceServiceRequest::decode(body) {
            Ok(req) => {
                // R1: raw span ingestion on receipt, BEFORE delivery. Persisted
                // transport keeps today's name (`otlp_grpc` — HTTP-protobuf
                // traces are delivered tagged OtlpGrpc, the pre-existing quirk).
                persist_raw_spans(app, &req, "otlp_grpc");

                let json_value = serde_json::json!({
                    "resourceSpans": req.resource_spans
                });
                // R3/R12: provider-agnostic GenericOtlpAdapter emits EngineInput.
                // Preserve the pre-existing quirk: HTTP-protobuf traces are
                // tagged Transport::OtlpGrpc (Mission Monitor's `chat-node`
                // filter matches `'otlp_grpc'`).
                let adapter = app.state::<std::sync::Arc<GenericOtlpAdapter>>();
                match adapter.transform(Transport::OtlpGrpc, json_value) {
                    Ok(inputs) => {
                        let engine = app.state::<std::sync::Arc<ContractEngine>>();
                        let bus = app.state::<EventBus>();
                        for input in inputs {
                            let deliveries = engine.req_2_3_process(input);
                            for delivery in deliveries {
                                bus.emit_delivery(delivery);
                            }
                        }
                    }
                    Err(e) => {
                        tracing::error!(target: "fredo::otlp", error = %e, "adapter transform failed");
                    }
                }
                StatusCode::OK
            }
            Err(_e) => StatusCode::BAD_REQUEST,
        }
    } else {
        // JSON OTLP (standard OTLP/HTTP JSON or OpenCode's custom flat format)
        match serde_json::from_slice::<serde_json::Value>(&body) {
            Ok(val) => {
                // R1: persist raw spans from the standard resourceSpans envelope
                // (camelCase OTLP JSON) when present. The OpenCode flat format
                // (no envelope) skips raw persistence — delivery still runs.
                if let Ok(req) = serde_json::from_value::<ExportTraceServiceRequest>(val.clone()) {
                    persist_raw_spans(app, &req, "otlp_http");
                } else {
                    tracing::debug!(target: "fredo::otlp", "non-envelope JSON trace payload — raw persistence skipped");
                }

                // R3: HTTP-JSON traces are tagged Transport::OtlpHttp.
                let adapter = app.state::<std::sync::Arc<GenericOtlpAdapter>>();
                let transport = Transport::OtlpHttp;
                match adapter.transform(transport, val) {
                    Ok(inputs) => {
                        let engine = app.state::<std::sync::Arc<ContractEngine>>();
                        let bus = app.state::<EventBus>();
                        for input in inputs {
                            let deliveries = engine.req_2_3_process(input);
                            for delivery in deliveries {
                                bus.emit_delivery(delivery);
                            }
                        }
                    }
                    Err(e) => {
                        tracing::error!(target: "fredo::otlp", error = %e, "adapter transform failed");
                    }
                }
                StatusCode::OK
            }
            Err(_) => StatusCode::OK,
        }
    }
}

async fn handle_metrics(
    State(state): State<OtlpState>,
    headers: HeaderMap,
    body: Bytes,
) -> StatusCode {
    let app = &state.app;
    if is_protobuf(&headers) {
        match ExportMetricsServiceRequest::decode(body) {
            Ok(req) => {
                // R2: persist all metric points to telemetry_metrics.
                persist_metrics(app, &req);
                StatusCode::OK
            }
            Err(_) => StatusCode::BAD_REQUEST,
        }
    } else {
        // JSON OTLP metrics (standard OTLP/HTTP JSON envelope).
        match serde_json::from_slice::<ExportMetricsServiceRequest>(&body) {
            Ok(req) => {
                persist_metrics(app, &req);
                StatusCode::OK
            }
            Err(_) => StatusCode::OK,
        }
    }
}

async fn handle_logs(
    State(state): State<OtlpState>,
    headers: HeaderMap,
    body: Bytes,
) -> StatusCode {
    let app = &state.app;
    if is_protobuf(&headers) {
        match ExportLogsServiceRequest::decode(body) {
            Ok(req) => {
                // R2: persist all log records to telemetry_logs.
                persist_logs(app, &req);
                StatusCode::OK
            }
            Err(_) => StatusCode::BAD_REQUEST,
        }
    } else {
        // JSON OTLP logs (standard OTLP/HTTP JSON envelope).
        match serde_json::from_slice::<ExportLogsServiceRequest>(&body) {
            Ok(req) => {
                persist_logs(app, &req);
                StatusCode::OK
            }
            Err(_) => StatusCode::OK,
        }
    }
}

// ── Health + test endpoints ───────────────────────────────────────────────────

/// GET /health — confirms the HTTP receiver is up.
async fn handle_health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "ok", "receiver": "fredo-otlp-http", "port": 4318 }))
}

// ── Server startup ────────────────────────────────────────────────────────────

pub async fn start(app: AppHandle) -> anyhow::Result<()> {
    let addr: std::net::SocketAddr = "127.0.0.1:4318".parse()?;

    let state = OtlpState { app };

    let router = Router::new()
        .route("/health",     get(handle_health))
        .route("/v1/traces",  post(handle_traces))
        .route("/v1/metrics", post(handle_metrics))
        .route("/v1/logs",    post(handle_logs))
        .with_state(state);

    tracing::info!(target: "fredo::otlp", addr = %addr, "HTTP receiver listening");

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, router).await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::contract_407::MetricType;
    use opentelemetry_proto::tonic::common::v1::any_value;
    use opentelemetry_proto::tonic::trace::v1::{
        ResourceSpans, ScopeSpans, Span as OtlpSpan,
    };

    fn kv(key: &str, value: any_value::Value) -> opentelemetry_proto::tonic::common::v1::KeyValue {
        opentelemetry_proto::tonic::common::v1::KeyValue {
            key: key.to_string(),
            value: Some(opentelemetry_proto::tonic::common::v1::AnyValue {
                value: Some(value),
            }),
        }
    }

    fn span_with(
        name: &str,
        span_id: [u8; 8],
        trace_id: [u8; 16],
        attrs: Vec<opentelemetry_proto::tonic::common::v1::KeyValue>,
    ) -> OtlpSpan {
        OtlpSpan {
            name: name.to_string(),
            span_id: span_id.to_vec(),
            trace_id: trace_id.to_vec(),
            attributes: attrs,
            ..Default::default()
        }
    }

    fn trace_export(spans: Vec<OtlpSpan>) -> ExportTraceServiceRequest {
        ExportTraceServiceRequest {
            resource_spans: vec![ResourceSpans {
                resource: None,
                scope_spans: vec![ScopeSpans {
                    scope: None,
                    spans,
                    schema_url: String::new(),
                }],
                schema_url: String::new(),
            }],
        }
    }

    // ── R1/R5: raw span ingestion maps the OTLP envelope → RawSpans ─────────

    #[test]
    fn raw_spans_from_export_http_ingests_before_delivery() {
        // Same conversion the HTTP receiver runs on receipt (persist_raw_spans).
        let request = trace_export(vec![
            span_with(
                "my.llm",
                [0x11; 8],
                [0x22; 16],
                vec![
                    kv(
                        "gen_ai.operation.name",
                        any_value::Value::StringValue("chat".to_string()),
                    ),
                    kv("session.id", any_value::Value::StringValue("sess-http-1".to_string())),
                ],
            ),
            span_with(
                "my.tool.bash",
                [0x33; 8],
                [0x44; 16],
                vec![kv(
                    "gen_ai.operation.name",
                    any_value::Value::StringValue("execute_tool".to_string()),
                )],
            ),
        ]);

        let spans = raw_spans_from_export(&request, "otlp_http");
        assert_eq!(spans.len(), 2, "every span in the export must map (R1)");
        assert_eq!(spans[0].span_id, "1111111111111111");
        assert_eq!(spans[0].span_name, "my.llm");
        assert_eq!(spans[0].session_id, "sess-http-1");
        assert_eq!(spans[0].event_type.as_deref(), Some("chat"));
        assert_eq!(spans[0].transport.as_deref(), Some("otlp_http"));
        assert_eq!(spans[1].event_type.as_deref(), Some("tool_use"));
    }

    #[test]
    fn camelcase_otlp_json_deserializes_to_export_request_for_raw_ingestion() {
        // The HTTP-JSON trace branch persists raw spans from the standard
        // camelCase OTLP JSON envelope: serde must round-trip it into
        // `ExportTraceServiceRequest` (R1 for the JSON leg).
        let json = serde_json::json!({
            "resourceSpans": [{
                "resource": { "attributes": [] },
                "scopeSpans": [{
                    "spans": [{
                        "name": "my.llm",
                        "traceId": "0102030405060708090a0b0c0d0e0f10",
                        "spanId": "aabbccddeeff0011",
                        "startTimeUnixNano": "1000",
                        "endTimeUnixNano": "2000",
                        "attributes": [
                            { "key": "gen_ai.operation.name", "value": { "stringValue": "chat" } },
                            { "key": "session.id", "value": { "stringValue": "sess-json-1" } }
                        ]
                    }]
                }]
            }]
        });

        let request: ExportTraceServiceRequest =
            serde_json::from_value(json).expect("camelCase OTLP JSON must deserialize");
        let spans = raw_spans_from_export(&request, "otlp_http");
        assert_eq!(spans.len(), 1, "raw ingestion must see the JSON-envelope span (R1)");
        assert_eq!(spans[0].span_name, "my.llm");
        assert_eq!(spans[0].span_id, "aabbccddeeff0011");
        assert_eq!(spans[0].session_id, "sess-json-1");
        assert_eq!(spans[0].transport.as_deref(), Some("otlp_http"));
    }

    // ── R3: EngineInput flows through the ECE into SubscriptionDelivery ──────

    #[test]
    fn http_json_projection_flows_through_ece_as_subscription_delivery() {
        // Mirrors the AC3 static leg (otlp.rs): a GenericOtlpAdapter projection
        // for an HTTP-JSON trace must flow through the ECE as SubscriptionDelivery.
        use crate::infrastructure::comm::adapters::otlp::GenericOtlpAdapter;
        use crate::infrastructure::comm::contract::engine::ContractEngine;
        use crate::infrastructure::comm::contract::types::ContractDeclaration;
        use crate::infrastructure::comm::contract::EventContractEngine;

        let adapter = GenericOtlpAdapter::new();
        let raw = serde_json::json!({
            "resourceSpans": [{
                "resource": { "attributes": [] },
                "scopeSpans": [{
                    "spans": [{
                        "name": "my.llm",
                        "traceId": "trace-http-ece",
                        "endTimeUnixNano": "1000000",
                        "attributes": [
                            { "key": "gen_ai.operation.name", "value": { "stringValue": "chat" } },
                            { "key": "gen_ai.conversation.id", "value": { "stringValue": "sess-http-ece" } },
                            { "key": "gen_ai.output.messages", "value": { "stringValue": "[{\"role\":\"assistant\",\"parts\":[{\"type\":\"text\",\"content\":\"HTTP reply\"}]}]" } }
                        ]
                    }]
                }]
            }]
        });

        let inputs = adapter.transform(Transport::OtlpHttp, raw).expect("transform should not error");
        assert_eq!(inputs.len(), 2, "completed chat span dual-emits Init + Response");

        let engine = ContractEngine::new();
        let contract = ContractDeclaration {
            contract_name: "chat-node".to_string(),
            stream_fields: vec!["payload".to_string(), "state".to_string()],
            deferred_fields: vec![],
            key: vec!["sessionId".to_string(), "correlationId".to_string()],
            complete_when: "state === 'Response'".to_string(),
            timeout: 300000,
            providers: None,
            transports: Some(vec!["otlp_http".to_string()]),
            event_types: Some(vec!["chat".to_string()]),
        };
        engine.req_1_register(vec![contract]).expect("contract should register");

        let mut deliveries = Vec::new();
        for input in inputs {
            deliveries.extend(engine.req_2_3_process(input));
        }
        assert!(!deliveries.is_empty(), "ECE must emit deliveries for the chat-node contract");
        assert!(deliveries.iter().any(|d| d.contract_name == "chat-node"));
        // The end delivery carries the agent reply.
        assert!(deliveries.iter().any(|d| {
            d.payload
                .get("payload")
                .and_then(|p| p.get("agentReply"))
                .and_then(|v| v.as_str())
                == Some("HTTP reply")
        }));
    }

    // ── R2: HTTP metrics/logs decode + persist (conversion helpers) ──────────

    #[test]
    fn http_metrics_decode_maps_points_for_persistence() {
        use opentelemetry_proto::tonic::metrics::v1::{
            metric, number_data_point, NumberDataPoint, ResourceMetrics, ScopeMetrics,
        };
        use opentelemetry_proto::tonic::metrics::v1::Metric as OtlpMetric;

        let dp = NumberDataPoint {
            attributes: vec![kv(
                "gen_ai.operation.name",
                any_value::Value::StringValue("chat".to_string()),
            )],
            start_time_unix_nano: 1_000_000_000,
            time_unix_nano: 11_000_000_000,
            exemplars: Vec::new(),
            flags: 0,
            value: Some(number_data_point::Value::AsInt(250)),
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
        let request = ExportMetricsServiceRequest {
            resource_metrics: vec![ResourceMetrics {
                resource: None,
                scope_metrics: vec![ScopeMetrics {
                    scope: None,
                    metrics: vec![metric],
                    schema_url: String::new(),
                }],
                schema_url: String::new(),
            }],
        };

        let points = otlp_metrics_to_points(&request);
        assert_eq!(points.len(), 1);
        assert_eq!(points[0].metric_name, "gen_ai.client.token.usage");
        assert_eq!(points[0].metric_type, MetricType::Counter);
        assert_eq!(points[0].value, 250.0);
    }

    #[test]
    fn http_logs_decode_maps_records_for_persistence() {
        use opentelemetry_proto::tonic::logs::v1::{LogRecord as OtlpLogRecord, ResourceLogs, ScopeLogs};

        let request = ExportLogsServiceRequest {
            resource_logs: vec![ResourceLogs {
                resource: None,
                scope_logs: vec![ScopeLogs {
                    scope: None,
                    log_records: vec![OtlpLogRecord {
                        time_unix_nano: 1_000_000_000,
                        observed_time_unix_nano: 1_000_000_000,
                        severity_number: 17,
                        severity_text: "ERROR".to_string(),
                        body: Some(opentelemetry_proto::tonic::common::v1::AnyValue {
                            value: Some(any_value::Value::StringValue(
                                "tool result failed".to_string(),
                            )),
                        }),
                        attributes: vec![kv("session.id", any_value::Value::StringValue("sess-log-http".to_string()))],
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
        assert_eq!(records[0].level, "ERROR");
        assert_eq!(records[0].message, "tool result failed");
        assert_eq!(records[0].session_id.as_deref(), Some("sess-log-http"));
        assert_eq!(records[0].trace_id.as_deref(), Some("abababababababababababababababab"));
    }
}
