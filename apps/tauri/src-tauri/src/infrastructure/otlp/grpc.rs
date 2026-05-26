/// grpc.rs — OTLP/gRPC receiver on 127.0.0.1:4317 (OpenCode).
///
/// Implements the three standard OTLP collector services:
///   • TraceService   — receives spans
///   • MetricsService — receives metrics
///   • LogsService    — receives log records / events
///
/// Each exported batch is mapped to FredoEvents via OpenCodeAdapter and
/// emitted to the webview via EventBus.
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

use crate::infrastructure::comm::adapter::CommAdapter;
use crate::infrastructure::comm::bus::EventBus;
use crate::infrastructure::comm::event::Transport;
use crate::infrastructure::comm::OpenCodeAdapter;

// ── TraceService ──────────────────────────────────────────────────────────────

pub struct OtlpTraceService(pub AppHandle);

#[tonic::async_trait]
impl TraceService for OtlpTraceService {
    async fn export(
        &self,
        request: Request<ExportTraceServiceRequest>,
    ) -> Result<Response<ExportTraceServiceResponse>, Status> {
        let resource_spans = request.into_inner().resource_spans;
        let json_value = serde_json::json!({
            "resourceSpans": resource_spans
        });
        let adapter = OpenCodeAdapter::new();
        match adapter.transform(Transport::OtlpGrpc, json_value).await {
            Ok(events) => {
                let bus = self.0.state::<EventBus>();
                for event in events {
                    bus.emit(event);
                }
            }
            Err(e) => {
                eprintln!("[fredo-otlp] OpenCodeAdapter transform failed: {e}");
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
        _request: Request<ExportMetricsServiceRequest>,
    ) -> Result<Response<ExportMetricsServiceResponse>, Status> {
        // Metrics are not used by any UI feature — drop them.
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
        _request: Request<ExportLogsServiceRequest>,
    ) -> Result<Response<ExportLogsServiceResponse>, Status> {
        // Logs are not used by any UI feature — drop them.
        Ok(Response::new(ExportLogsServiceResponse {
            partial_success: None,
        }))
    }
}

// ── Server startup ────────────────────────────────────────────────────────────

pub async fn start(app: AppHandle) -> anyhow::Result<()> {
    let addr = "127.0.0.1:4317".parse()?;

    println!("[fredo-otlp] gRPC receiver listening on {addr}");

    tonic::transport::Server::builder()
        .add_service(TraceServiceServer::new(OtlpTraceService(app.clone())))
        .add_service(MetricsServiceServer::new(OtlpMetricsService(app.clone())))
        .add_service(LogsServiceServer::new(OtlpLogsService(app)))
        .serve(addr)
        .await?;

    Ok(())
}
