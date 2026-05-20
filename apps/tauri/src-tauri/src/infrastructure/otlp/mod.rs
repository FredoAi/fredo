/// infrastructure/otlp — embedded OTLP receiver.
///
/// Starts two servers when the Tauri app launches:
///   • gRPC on 127.0.0.1:4317  — for OpenCode (OTLP/gRPC)
///   • HTTP on 127.0.0.1:4318  — for OpenCode (OTLP/HTTP, otlp-http exporter type)
///
/// Both servers receive OTLP signals (traces, metrics, logs), map them to
/// StreamEvents via `mapping.rs`, and emit them via `emit_stream_event()` —
/// the same Tauri IPC channel used by the legacy hook-based path.
pub mod grpc;
pub mod http;
pub mod mapping;

use tauri::AppHandle;

/// Spawn both OTLP receiver servers as background tasks.
/// Called once from `lib.rs` during app setup, alongside `ipc::start_ipc_server`.
pub fn start(app: AppHandle) {
    // gRPC receiver — OpenCode
    let app_grpc = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = grpc::start(app_grpc).await {
            eprintln!("[fredo-otlp] gRPC server error: {e}");
        }
    });

    // HTTP receiver — OpenCode
    let app_http = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = http::start(app_http).await {
            eprintln!("[fredo-otlp] HTTP server error: {e}");
        }
    });
}
