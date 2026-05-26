/// http.rs — OTLP/HTTP receiver on 127.0.0.1:4318 (OpenCode).
///
/// OpenCode can use `otlp-http`, so this axum server handles:
///   POST /v1/traces  — ExportTraceServiceRequest  (application/x-protobuf)
///   POST /v1/metrics — ExportMetricsServiceRequest (application/x-protobuf)
///   POST /v1/logs    — ExportLogsServiceRequest    (application/x-protobuf)
///
/// The body is decoded as protobuf (prost). JSON bodies
/// (application/json or application/x-json) are not emitted by OpenCode
/// by default but are accepted here for curl-based debugging.
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

use std::sync::{Arc, Mutex};
use std::collections::HashMap;
use crate::infrastructure::comm::adapter::CommAdapter;
use crate::infrastructure::comm::bus::EventBus;
use crate::infrastructure::comm::event::Transport;
use crate::infrastructure::comm::OpenCodeAdapter;
use crate::infrastructure::events::{emit_stream_event, EventSource};
use super::mapping;

/// Shared state for the OTLP HTTP server.
/// Holds the AppHandle plus a persistent trace_id → conversation_id map so
/// that spans arriving in different HTTP batches (e.g. execute_tool arriving
/// separately from the invoke_agent) are still grouped into the same session.
#[derive(Clone)]
struct OtlpState {
    app: AppHandle,
    trace_to_conv: Arc<Mutex<HashMap<String, String>>>,
}

// ── Handler helpers ───────────────────────────────────────────────────────────

fn is_protobuf(headers: &HeaderMap) -> bool {
    headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|ct| ct.contains("application/x-protobuf") || ct.contains("application/protobuf"))
        .unwrap_or(false)
}

// ── Route handlers ────────────────────────────────────────────────────────────

async fn handle_traces(
    State(state): State<OtlpState>,
    headers: HeaderMap,
    body: Bytes,
) -> StatusCode {
    let app = &state.app;
    if is_protobuf(&headers) {
        match ExportTraceServiceRequest::decode(body) {
            Ok(req) => {
                let events = mapping::resource_spans_to_events(req.resource_spans, EventSource::OtlpHttp);
                for event in events { emit_stream_event(app, event); }
                StatusCode::OK
            }
            Err(_e) => { StatusCode::BAD_REQUEST }
        }
    } else {
        // JSON OTLP (standard OTLP/HTTP JSON or OpenCode's custom flat format)
        match serde_json::from_slice::<serde_json::Value>(&body) {
            Ok(val) => {
                // Use OpenCodeAdapter to transform JSON payload into FredoEvents
                let adapter = OpenCodeAdapter::new();
                let transport = Transport::OtlpHttp;
                match adapter.transform(transport, val).await {
                    Ok(events) => {
                        let bus = app.state::<EventBus>();
                        for event in events {
                            bus.emit(event);
                        }
                    }
                    Err(e) => {
                        eprintln!("[fredo-otlp] OpenCodeAdapter transform failed: {e}");
                    }
                }
                StatusCode::OK
            }
            Err(_) => { StatusCode::OK }
        }
    }
}

/// Convert an OTLP JSON attribute array into a flat serde_json object.
///
/// OTLP JSON encodes attributes as:
///   [{"key": "foo", "value": {"stringValue": "bar"}}, ...]
/// This function flattens them into {"foo": "bar", ...}.
fn otlp_attrs_to_map(attrs_json: Option<&serde_json::Value>) -> serde_json::Map<String, serde_json::Value> {
    let mut map = serde_json::Map::new();
    let arr = match attrs_json.and_then(|v| v.as_array()) {
        Some(a) => a,
        None => return map,
    };
    for kv in arr {
        let key = match kv.get("key").and_then(|v| v.as_str()) {
            Some(k) => k.to_string(),
            None => continue,
        };
        let value = if let Some(v) = kv.get("value") {
            // Unwrap the typed wrapper: stringValue, intValue, doubleValue, boolValue, arrayValue, kvlistValue
            if let Some(s) = v.get("stringValue").and_then(|x| x.as_str()) {
                serde_json::Value::String(s.to_string())
            } else if let Some(i) = v.get("intValue") {
                // intValue may be a JSON number or a quoted string (int64 overflow safe)
                if let Some(n) = i.as_i64() { serde_json::json!(n) }
                else if let Some(s) = i.as_str() { serde_json::Value::String(s.to_string()) }
                else { i.clone() }
            } else if let Some(d) = v.get("doubleValue") {
                d.clone()
            } else if let Some(b) = v.get("boolValue") {
                b.clone()
            } else {
                v.clone()
            }
        } else {
            serde_json::Value::Null
        };
        map.insert(key, value);
    }
    map
}

/// Map standard OTLP JSON resourceSpans array into StreamEvents.
fn map_json_spans(resource_spans: &[serde_json::Value], source: EventSource, trace_to_conv_shared: &Arc<Mutex<HashMap<String, String>>>) -> Vec<crate::infrastructure::events::StreamEvent> {
    use crate::infrastructure::events::{EventState, OtlpPayload, OtlpSignal, StreamEvent};
    use super::mapping::normalize_op_name;
    let mut events = Vec::new();

    // Pass 1: build/update the persistent trace_id → conversation_id map.
    // Spans in the same trace but different HTTP batches (e.g. execute_tool
    // arriving separately from invoke_agent) share traceId, so we can still
    // resolve their session_id from the map populated by an earlier batch.
    {
        let mut trace_to_conv = trace_to_conv_shared.lock().unwrap();
        for rs in resource_spans {
            let scope_spans = rs.get("scopeSpans").and_then(|v| v.as_array()).cloned().unwrap_or_default();
            for scope in &scope_spans {
                let spans = scope.get("spans").and_then(|v| v.as_array()).cloned().unwrap_or_default();
                for span in &spans {
                    let attrs = otlp_attrs_to_map(span.get("attributes"));
                    if let Some(conv_id) = attrs.get("gen_ai.conversation.id").and_then(|v| v.as_str()) {
                        if let Some(trace_id) = span.get("traceId").and_then(|v| v.as_str()) {
                            trace_to_conv.entry(trace_id.to_string()).or_insert_with(|| conv_id.to_owned());
                        }
                    }
                }
            }
        }
    }
    let trace_to_conv = trace_to_conv_shared.lock().unwrap();

    // Pass 2: emit StreamEvents
    for rs in resource_spans {
        let res_attrs = otlp_attrs_to_map(
            rs.get("resource").and_then(|r| r.get("attributes"))
        );
        let scope_spans = rs.get("scopeSpans").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        for scope in &scope_spans {
            let spans = scope.get("spans").and_then(|v| v.as_array()).cloned().unwrap_or_default();
            for span in &spans {
                let span_name = span.get("name").and_then(|v| v.as_str()).unwrap_or("span");
                let span_attrs = otlp_attrs_to_map(span.get("attributes"));

                // Resolve canonical op name
                let op_name = span_attrs.get("gen_ai.operation.name")
                    .and_then(|v| v.as_str())
                    .and_then(normalize_op_name)
                    .or_else(|| normalize_op_name(span_name));

                let op_name = match op_name {
                    Some(op) => op,
                    None => {
                        continue;
                    }
                };

                // Resolve session id
                let trace_id = span.get("traceId").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let session_id = span_attrs.get("gen_ai.conversation.id")
                    .and_then(|v| v.as_str())
                    .map(str::to_owned)
                    .or_else(|| trace_to_conv.get(&trace_id).cloned())
                    .unwrap_or_else(|| {
                        if !trace_id.is_empty() { trace_id.clone() }
                        else { uuid::Uuid::new_v4().to_string() }
                    });

                // Merge span attrs + resource attrs into one flat map
                let mut merged = serde_json::Map::new();
                merged.extend(res_attrs.clone());
                merged.extend(span_attrs);
                merged.insert("span.name".into(), serde_json::Value::String(span_name.to_string()));

                events.push(StreamEvent {
                    tool_name: op_name.to_owned(),
                    session_id,
                    state: EventState::Response,
                    source: source.clone(),
                    input: None, response: None, data: None,
                    timestamp: chrono::Utc::now().to_rfc3339(),
                    event_id: Some(uuid::Uuid::new_v4().to_string()),
                    correlation_id: None, error: None,
                    otlp: Some(OtlpPayload {
                        signal: OtlpSignal::Span,
                        attributes: serde_json::Value::Object(merged),
                    }),
                });
            }
        }
    }
    events
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
                let events = mapping::resource_metrics_to_events(req.resource_metrics, EventSource::OtlpHttp);
                for event in events { emit_stream_event(app, event); }
                StatusCode::OK
            }
            Err(_e) => { StatusCode::BAD_REQUEST }
        }
    } else {
        // JSON metrics are not used by any UI feature — drop them.
        StatusCode::OK
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
                let events = mapping::resource_logs_to_events(req.resource_logs, EventSource::OtlpHttp);
                for event in events { emit_stream_event(app, event); }
                StatusCode::OK
            }
            Err(_e) => { StatusCode::BAD_REQUEST }
        }
    } else {
        // JSON logs are not used by any UI feature — drop them.
        StatusCode::OK
    }
}

// ── Health + test endpoints ───────────────────────────────────────────────────

/// GET /health — confirms the HTTP receiver is up.
async fn handle_health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "ok", "receiver": "fredo-otlp-http", "port": 4318 }))
}

/// POST /v1/test — emits a synthetic StreamEvent so you can verify the full
/// pipeline (HTTP → Tauri IPC → StreamContext → Dev Mode) without needing a
/// real CLI session.
/// Body (optional JSON): { "message": "hello" }
async fn handle_test(
    State(state): State<OtlpState>,
    body: Bytes,
) -> Json<serde_json::Value> {
    let app = &state.app;
    let payload: serde_json::Value = serde_json::from_slice(&body)
        .unwrap_or_else(|_| serde_json::json!({ "message": "test event" }));

    emit_stream_event(
        app,
        crate::infrastructure::events::StreamEvent {
            tool_name: "otlp.test".into(),
            session_id: "fredo-test".into(),
            state: crate::infrastructure::events::EventState::Response,
            source: EventSource::OtlpHttp,
            input: None,
            response: Some(payload),
            data: None,
            timestamp: chrono::Utc::now().to_rfc3339(),
            event_id: Some(uuid::Uuid::new_v4().to_string()),
            correlation_id: None,
            error: None,
            otlp: Some(crate::infrastructure::events::OtlpPayload {
                signal: crate::infrastructure::events::OtlpSignal::Log,
                attributes: serde_json::json!({ "test": true }),
            }),
        },
    );

    Json(serde_json::json!({ "status": "ok", "emitted": true }))
}

// ── Server startup ────────────────────────────────────────────────────────────

pub async fn start(app: AppHandle) -> anyhow::Result<()> {
    let addr: std::net::SocketAddr = "127.0.0.1:4318".parse()?;

    let state = OtlpState {
        app,
        trace_to_conv: Arc::new(Mutex::new(HashMap::new())),
    };

    let router = Router::new()
        .route("/health",     get(handle_health))
        .route("/v1/test",    post(handle_test))
        .route("/v1/traces",  post(handle_traces))
        .route("/v1/metrics", post(handle_metrics))
        .route("/v1/logs",    post(handle_logs))
        .with_state(state);

    println!("[fredo-otlp] HTTP receiver listening on {addr}");

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, router).await?;

    Ok(())
}
