/// infrastructure/otlp — embedded OTLP receiver.
///
/// Starts two servers when the Tauri app launches:
///   • gRPC on 127.0.0.1:4317  — for OpenCode (OTLP/gRPC)
///   • HTTP on 127.0.0.1:4318  — for OpenCode (OTLP/HTTP, otlp-http exporter type)
///
/// Both servers receive OTLP signals (traces, metrics, logs), persist them raw
/// on receipt, and feed the RTDB ingest classifier (row pipeline).
pub mod grpc;
pub mod http;
pub mod raw;

use tauri::AppHandle;

/// Spawn both OTLP receiver servers as background tasks.
/// Called once from `lib.rs` during app setup, alongside `ipc::start_ipc_server`.
pub fn start(app: AppHandle) {
    // gRPC receiver — OpenCode
    let app_grpc = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = grpc::start(app_grpc).await {
            tracing::error!(target: "fredo::otlp", error = %e, "gRPC server error");
        }
    });

    // HTTP receiver — OpenCode
    let app_http = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = http::start(app_http).await {
            tracing::error!(target: "fredo::otlp", error = %e, "HTTP server error");
        }
    });
}
