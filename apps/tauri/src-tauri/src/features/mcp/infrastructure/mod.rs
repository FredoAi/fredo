use rmcp::ErrorData;

use crate::features::mcp::k8s::service::{K8sService, KubeRsK8sService};
use crate::infrastructure::comm::{
    EventBus, EventProvider, EventState, EventType, FredoEvent, Transport,
};
use tauri::Manager;

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
        let bus = handle.state::<EventBus>();
        bus.emit(FredoEvent::builder()
            .event_type(EventType::Infrastructure)
            .state(EventState::Response)
            .provider(EventProvider::Internal)
            .transport(Transport::Hook)
            .tool_name("infrastructure_stream")
            .correlation_id(&correlation_id)
            .payload(serde_json::to_value(&graph).unwrap_or_default())
            .build());
        Ok(format!(
            "Infrastructure graph emitted to Fredo UI (correlation_id: {correlation_id})"
        ))
    } else {
        // Graceful fallback: return snapshot as JSON when no AppHandle
        serde_json::to_string_pretty(&graph).map_err(ie)
    }
}
