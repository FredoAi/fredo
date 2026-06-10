/// http.rs — OTLP/HTTP receiver on 127.0.0.1:4318 (OpenCode).
///
/// OpenCode can use `otlp-http`, so this axum server handles:
///   POST /v1/traces  — ExportTraceServiceRequest  (application/x-protobuf)
///   POST /v1/metrics — ExportMetricsServiceRequest (application/x-protobuf)
///   POST /v1/logs    — ExportLogsServiceRequest    (application/x-protobuf)
///
/// Both protobuf and JSON OTLP payloads are transformed into FredoEvents
/// via OpenCodeAdapter and emitted via EventBus.
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

use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;

use crate::infrastructure::comm::adapter::CommAdapter;
use crate::infrastructure::comm::bus::EventBus;
use crate::infrastructure::comm::event::Transport;
use crate::infrastructure::comm::OpenCodeAdapter;

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

// ── Route handlers ────────────────────────────────────────────────────────────

async fn handle_traces(
    State(state): State<OtlpState>,
    headers: HeaderMap,
    body: Bytes,
) -> StatusCode {
    let app = &state.app;
    if is_protobuf(&headers) {
        // Protobuf OTLP — decode and use OpenCodeAdapter
        match ExportTraceServiceRequest::decode(body) {
            Ok(req) => {
                let json_value = serde_json::json!({
                    "resourceSpans": req.resource_spans
                });
                // Append raw event to debug dump file (~/.fredo/event-dump.jsonl)
                crate::utils::dump::append_event_dump(&json_value);
                let adapter = OpenCodeAdapter::new();
                match adapter.transform(Transport::OtlpGrpc, json_value).await {
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
            Err(_e) => StatusCode::BAD_REQUEST,
        }
    } else {
        // JSON OTLP (standard OTLP/HTTP JSON or OpenCode's custom flat format)
        match serde_json::from_slice::<serde_json::Value>(&body) {
            Ok(val) => {
                // Append raw event to debug dump file (~/.fredo/event-dump.jsonl)
                crate::utils::dump::append_event_dump(&val);
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
            Err(_) => StatusCode::OK,
        }
    }
}

async fn handle_metrics(
    State(_state): State<OtlpState>,
    _headers: HeaderMap,
    _body: Bytes,
) -> StatusCode {
    // Metrics are not used by any UI feature — drop them.
    StatusCode::OK
}

async fn handle_logs(
    State(_state): State<OtlpState>,
    _headers: HeaderMap,
    _body: Bytes,
) -> StatusCode {
    // Logs are not used by any UI feature — drop them.
    StatusCode::OK
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

    println!("[fredo-otlp] HTTP receiver listening on {addr}");

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, router).await?;

    Ok(())
}