use rmcp::ErrorData;

use crate::features::mcp::k8s::service::{K8sService, KubeRsK8sService};
use crate::infrastructure::events::{emit_stream_event, EventState, StreamEvent};

fn ie(e: impl std::fmt::Display) -> ErrorData {
    ErrorData::internal_error(e.to_string(), None)
}

pub async fn snapshot(kubeconfig_path: Option<&str>) -> Result<String, ErrorData> {
    let svc = KubeRsK8sService;
    let graph = svc
        .get_cluster_snapshot(kubeconfig_path.unwrap_or(""))
        .await
        .map_err(ie)?;
    serde_json::to_string_pretty(&graph).map_err(ie)
}

pub async fn stream(
    kubeconfig_path: Option<&str>,
    app: Option<&tauri::AppHandle>,
) -> Result<String, ErrorData> {
    let svc = KubeRsK8sService;
    let graph = svc
        .get_cluster_snapshot(kubeconfig_path.unwrap_or(""))
        .await
        .map_err(ie)?;

    if let Some(handle) = app {
        let correlation_id = uuid::Uuid::new_v4().to_string();
        emit_stream_event(
            handle,
            StreamEvent::new("infrastructure_stream", EventState::Response)
                .with_correlation(&correlation_id)
                .with_response(serde_json::to_value(&graph).unwrap_or_default()),
        );
        Ok(format!(
            "Infrastructure graph emitted to Fredo UI (correlation_id: {correlation_id})"
        ))
    } else {
        // Graceful fallback: return snapshot as JSON when no AppHandle
        serde_json::to_string_pretty(&graph).map_err(ie)
    }
}
