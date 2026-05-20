use anyhow::Result;
use chrono::Utc;
use futures_util::TryStreamExt;
use k8s_openapi::api::{
    apps::v1::Deployment,
    core::v1::{Event, Pod, Service},
};
use kube::{
    api::{Api, AttachParams, DeleteParams, ListParams, Patch, PatchParams},
    config::{KubeConfigOptions, Kubeconfig},
    Client, Config,
};
use rmcp::ErrorData;
use serde_json::{json, Value};

// ── Client factory ────────────────────────────────────────────────────────────

pub async fn build_client(kubeconfig_path: Option<&str>) -> Result<Client, ErrorData> {
    let path = kubeconfig_path.unwrap_or("");
    let config = if path.is_empty() {
        Config::infer().await.map_err(|e| ErrorData::internal_error(e.to_string(), None))?
    } else {
        let kc = Kubeconfig::read_from(path)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        Config::from_custom_kubeconfig(kc, &KubeConfigOptions::default())
            .await
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?
    };
    Client::try_from(config).map_err(|e| ErrorData::internal_error(e.to_string(), None))
}

fn ns_param(namespace: Option<&str>) -> &str {
    namespace.unwrap_or("default")
}

fn ie(e: impl std::fmt::Display) -> ErrorData {
    ErrorData::internal_error(e.to_string(), None)
}

// ── kubectl_get_pods ──────────────────────────────────────────────────────────

pub async fn get_pods(client: Client, namespace: Option<&str>) -> Result<String, ErrorData> {
    let pods: Api<Pod> = if namespace.is_none() {
        Api::all(client)
    } else {
        Api::namespaced(client, ns_param(namespace))
    };
    let list = pods.list(&ListParams::default()).await.map_err(ie)?;

    let mut items: Vec<Value> = Vec::new();
    for pod in list.items {
        let name = pod.metadata.name.unwrap_or_default();
        let ns = pod.metadata.namespace.unwrap_or_default();
        let phase = pod
            .status
            .as_ref()
            .and_then(|s| s.phase.as_deref())
            .unwrap_or("Unknown")
            .to_string();
        let restarts: i32 = pod
            .status
            .as_ref()
            .and_then(|s| s.container_statuses.as_ref())
            .map(|cs| cs.iter().map(|c| c.restart_count).sum())
            .unwrap_or(0);
        let ready_count = pod
            .status
            .as_ref()
            .and_then(|s| s.container_statuses.as_ref())
            .map(|cs| cs.iter().filter(|c| c.ready).count())
            .unwrap_or(0);
        let total_containers = pod
            .spec
            .as_ref()
            .map(|s| s.containers.len())
            .unwrap_or(0);

        items.push(json!({
            "name": name,
            "namespace": ns,
            "phase": phase,
            "ready": format!("{}/{}", ready_count, total_containers),
            "restarts": restarts,
        }));
    }

    Ok(serde_json::to_string_pretty(&items).unwrap_or_default())
}

// ── kubectl_describe_pod ──────────────────────────────────────────────────────

pub async fn describe_pod(
    client: Client,
    namespace: Option<&str>,
    pod_name: &str,
) -> Result<String, ErrorData> {
    let ns = ns_param(namespace);
    let pods: Api<Pod> = Api::namespaced(client, ns);
    let pod = pods.get(pod_name).await.map_err(ie)?;

    let conditions = pod
        .status
        .as_ref()
        .and_then(|s| s.conditions.as_ref())
        .map(|cs| {
            cs.iter()
                .map(|c| {
                    json!({
                        "type": c.type_,
                        "status": c.status,
                        "reason": c.reason,
                        "message": c.message,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let containers = pod
        .spec
        .as_ref()
        .map(|s| {
            s.containers
                .iter()
                .map(|c| {
                    json!({
                        "name": c.name,
                        "image": c.image,
                        "resources": c.resources,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let info = json!({
        "name": pod.metadata.name,
        "namespace": pod.metadata.namespace,
        "labels": pod.metadata.labels,
        "phase": pod.status.as_ref().and_then(|s| s.phase.as_ref()),
        "hostIp": pod.status.as_ref().and_then(|s| s.host_ip.as_ref()),
        "podIp": pod.status.as_ref().and_then(|s| s.pod_ip.as_ref()),
        "startTime": pod.status.as_ref().and_then(|s| s.start_time.as_ref()).map(|t| t.0.to_rfc3339()),
        "conditions": conditions,
        "containers": containers,
    });

    Ok(serde_json::to_string_pretty(&info).unwrap_or_default())
}

// ── kubectl_get_deployments ───────────────────────────────────────────────────

pub async fn get_deployments(
    client: Client,
    namespace: Option<&str>,
) -> Result<String, ErrorData> {
    let deps: Api<Deployment> = if namespace.is_none() {
        Api::all(client)
    } else {
        Api::namespaced(client, ns_param(namespace))
    };
    let list = deps.list(&ListParams::default()).await.map_err(ie)?;

    let items: Vec<Value> = list
        .items
        .iter()
        .map(|d| {
            let status = d.status.as_ref();
            json!({
                "name": d.metadata.name,
                "namespace": d.metadata.namespace,
                "desired": d.spec.as_ref().and_then(|s| s.replicas),
                "ready": status.and_then(|s| s.ready_replicas),
                "available": status.and_then(|s| s.available_replicas),
                "unavailable": status.and_then(|s| s.unavailable_replicas),
            })
        })
        .collect();

    Ok(serde_json::to_string_pretty(&items).unwrap_or_default())
}

// ── kubectl_get_services ──────────────────────────────────────────────────────

pub async fn get_services(
    client: Client,
    namespace: Option<&str>,
) -> Result<String, ErrorData> {
    let svcs: Api<Service> = if namespace.is_none() {
        Api::all(client)
    } else {
        Api::namespaced(client, ns_param(namespace))
    };
    let list = svcs.list(&ListParams::default()).await.map_err(ie)?;

    let items: Vec<Value> = list
        .items
        .iter()
        .map(|s| {
            let ports = s
                .spec
                .as_ref()
                .and_then(|sp| sp.ports.as_ref())
                .map(|ps| {
                    ps.iter()
                        .map(|p| {
                            json!({
                                "port": p.port,
                                "protocol": p.protocol,
                                "targetPort": p.target_port,
                            })
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            json!({
                "name": s.metadata.name,
                "namespace": s.metadata.namespace,
                "type": s.spec.as_ref().and_then(|sp| sp.type_.as_ref()),
                "clusterIp": s.spec.as_ref().and_then(|sp| sp.cluster_ip.as_ref()),
                "ports": ports,
            })
        })
        .collect();

    Ok(serde_json::to_string_pretty(&items).unwrap_or_default())
}

// ── kubectl_get_events ────────────────────────────────────────────────────────

pub async fn get_events(
    client: Client,
    namespace: Option<&str>,
    object_name: Option<&str>,
) -> Result<String, ErrorData> {
    let ns = ns_param(namespace);
    let events: Api<Event> = Api::namespaced(client, ns);

    let lp = if let Some(name) = object_name {
        ListParams::default().fields(&format!("involvedObject.name={name}"))
    } else {
        ListParams::default()
    };

    let list = events.list(&lp).await.map_err(ie)?;

    let items: Vec<Value> = list
        .items
        .iter()
        .map(|e| {
            json!({
                "type": e.type_,
                "reason": e.reason,
                "message": e.message,
                "object": e.involved_object.name,
                "objectKind": e.involved_object.kind,
                "count": e.count,
                "firstTime": e.first_timestamp.as_ref().map(|t| t.0.to_rfc3339()),
                "lastTime": e.last_timestamp.as_ref().map(|t| t.0.to_rfc3339()),
            })
        })
        .collect();

    Ok(serde_json::to_string_pretty(&items).unwrap_or_default())
}

// ── kubectl_logs ──────────────────────────────────────────────────────────────

pub async fn get_logs(
    client: Client,
    namespace: Option<&str>,
    pod_name: &str,
    container: Option<&str>,
    tail_lines: Option<i64>,
) -> Result<String, ErrorData> {
    let ns = ns_param(namespace);
    let pods: Api<Pod> = Api::namespaced(client, ns);

    let mut lp = kube::api::LogParams {
        tail_lines: Some(tail_lines.unwrap_or(100)),
        ..Default::default()
    };
    if let Some(c) = container {
        lp.container = Some(c.to_string());
    }

    let logs = pods.logs(pod_name, &lp).await.map_err(ie)?;
    Ok(logs)
}

// ── kubectl_exec ──────────────────────────────────────────────────────────────

pub async fn exec_command(
    client: Client,
    namespace: Option<&str>,
    pod_name: &str,
    container: Option<&str>,
    command: &str,
) -> Result<String, ErrorData> {
    let ns = ns_param(namespace);
    let pods: Api<Pod> = Api::namespaced(client, ns);

    let cmd: Vec<&str> = command.split_whitespace().collect();
    let mut attach_params = AttachParams::default().stdout(true).stderr(true);
    if let Some(c) = container {
        attach_params = attach_params.container(c);
    }

    let mut attached = pods.exec(pod_name, cmd, &attach_params).await.map_err(ie)?;

    let stdout = tokio_util::io::ReaderStream::new(
        attached.stdout().ok_or_else(|| ie("no stdout"))?,
    );
    let stderr = tokio_util::io::ReaderStream::new(
        attached.stderr().ok_or_else(|| ie("no stderr"))?,
    );

    let stdout_bytes: Vec<bytes::Bytes> =
        stdout.try_collect().await.map_err(ie)?;
    let stderr_bytes: Vec<bytes::Bytes> =
        stderr.try_collect().await.map_err(ie)?;

    let stdout_str = stdout_bytes
        .into_iter()
        .map(|b| String::from_utf8_lossy(&b).into_owned())
        .collect::<String>();
    let stderr_str = stderr_bytes
        .into_iter()
        .map(|b| String::from_utf8_lossy(&b).into_owned())
        .collect::<String>();

    let result = json!({
        "stdout": stdout_str,
        "stderr": stderr_str,
    });
    Ok(serde_json::to_string_pretty(&result).unwrap_or_default())
}

// ── kubectl_delete_pod ────────────────────────────────────────────────────────

pub async fn delete_pod(
    client: Client,
    namespace: Option<&str>,
    pod_name: &str,
) -> Result<String, ErrorData> {
    let ns = ns_param(namespace);
    let pods: Api<Pod> = Api::namespaced(client, ns);
    pods.delete(pod_name, &DeleteParams::default())
        .await
        .map_err(ie)?;
    Ok(format!("Pod '{pod_name}' deleted from namespace '{ns}'."))
}

// ── kubectl_restart_deployment ────────────────────────────────────────────────

pub async fn restart_deployment(
    client: Client,
    namespace: Option<&str>,
    deployment_name: &str,
) -> Result<String, ErrorData> {
    let ns = ns_param(namespace);
    let deps: Api<Deployment> = Api::namespaced(client, ns);

    let now = Utc::now().to_rfc3339();
    let patch = json!({
        "spec": {
            "template": {
                "metadata": {
                    "annotations": {
                        "kubectl.kubernetes.io/restartedAt": now
                    }
                }
            }
        }
    });

    deps.patch(
        deployment_name,
        &PatchParams::apply("fredo-mcp"),
        &Patch::Merge(patch),
    )
    .await
    .map_err(ie)?;

    Ok(format!(
        "Deployment '{deployment_name}' restart triggered in namespace '{ns}'."
    ))
}

// ── kubectl_scale_deployment ──────────────────────────────────────────────────

pub async fn scale_deployment(
    client: Client,
    namespace: Option<&str>,
    deployment_name: &str,
    replicas: i32,
) -> Result<String, ErrorData> {
    let ns = ns_param(namespace);
    let deps: Api<Deployment> = Api::namespaced(client, ns);

    let patch = json!({ "spec": { "replicas": replicas } });
    deps.patch(
        deployment_name,
        &PatchParams::apply("fredo-mcp"),
        &Patch::Merge(patch),
    )
    .await
    .map_err(ie)?;

    Ok(format!(
        "Deployment '{deployment_name}' scaled to {replicas} replicas in namespace '{ns}'."
    ))
}

// ── kubectl_rollout_status ────────────────────────────────────────────────────

pub async fn rollout_status(
    client: Client,
    namespace: Option<&str>,
    deployment_name: &str,
) -> Result<String, ErrorData> {
    let ns = ns_param(namespace);
    let deps: Api<Deployment> = Api::namespaced(client, ns);
    let dep = deps.get(deployment_name).await.map_err(ie)?;

    let status = dep.status.as_ref();
    let desired = dep.spec.as_ref().and_then(|s| s.replicas).unwrap_or(0);
    let ready = status.and_then(|s| s.ready_replicas).unwrap_or(0);
    let available = status.and_then(|s| s.available_replicas).unwrap_or(0);
    let unavailable = status.and_then(|s| s.unavailable_replicas).unwrap_or(0);

    let info = json!({
        "name": deployment_name,
        "namespace": ns,
        "desired": desired,
        "ready": ready,
        "available": available,
        "unavailable": unavailable,
        "complete": unavailable == 0 && ready == desired,
    });
    Ok(serde_json::to_string_pretty(&info).unwrap_or_default())
}

// ── kubectl_top_pods ──────────────────────────────────────────────────────────

pub async fn top_pods(client: Client, namespace: Option<&str>) -> Result<String, ErrorData> {
    use kube::api::DynamicObject;
    use kube::discovery::ApiResource;

    let ar = ApiResource {
        group: "metrics.k8s.io".to_string(),
        version: "v1beta1".to_string(),
        api_version: "metrics.k8s.io/v1beta1".to_string(),
        kind: "PodMetrics".to_string(),
        plural: "pods".to_string(),
    };

    let metrics: Api<DynamicObject> = if let Some(ns) = namespace {
        Api::namespaced_with(client, ns, &ar)
    } else {
        Api::all_with(client, &ar)
    };

    let list = metrics
        .list(&ListParams::default())
        .await
        .map_err(|e| ie(format!("metrics-server not available: {e}")))?;

    let items: Vec<Value> = list
        .items
        .iter()
        .map(|m| {
            let containers = m.data.get("containers").cloned().unwrap_or_default();
            json!({
                "name": m.metadata.name,
                "namespace": m.metadata.namespace,
                "containers": containers,
            })
        })
        .collect();

    Ok(serde_json::to_string_pretty(&items).unwrap_or_default())
}
