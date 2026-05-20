/// grpc.rs — OTLP/gRPC receiver on 127.0.0.1:4317 (OpenCode).
///
/// Implements the three standard OTLP collector services:
///   • TraceService   — receives spans
///   • MetricsService — receives metrics
///   • LogsService    — receives log records / events
///
/// Each exported batch is mapped to StreamEvents and emitted to the webview
/// via the standard `emit_stream_event()` channel.
use tauri::AppHandle;
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

use crate::infrastructure::events::{emit_stream_event, EventSource};
use super::mapping;

// ── TraceService ──────────────────────────────────────────────────────────────

pub struct OtlpTraceService(pub AppHandle);

#[tonic::async_trait]
impl TraceService for OtlpTraceService {
    async fn export(
        &self,
        request: Request<ExportTraceServiceRequest>,
    ) -> Result<Response<ExportTraceServiceResponse>, Status> {
        let events = mapping::resource_spans_to_events(
            request.into_inner().resource_spans,
            EventSource::OtlpGrpc,
        );
        for event in events {
            emit_stream_event(&self.0, event);
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
        let events = mapping::resource_metrics_to_events(
            request.into_inner().resource_metrics,
            EventSource::OtlpGrpc,
        );
        for event in events {
            emit_stream_event(&self.0, event);
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
        let events = mapping::resource_logs_to_events(
            request.into_inner().resource_logs,
            EventSource::OtlpGrpc,
        );
        for event in events {
            emit_stream_event(&self.0, event);
        }
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
