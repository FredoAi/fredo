use anyhow::Result;
use async_trait::async_trait;
use chrono::Utc;
use k8s_openapi::api::{
    apps::v1::{DaemonSet, Deployment, StatefulSet},
    core::v1::{Namespace, Node, Pod, Service},
};
use kube::{api::Api, config::{KubeConfigOptions, Kubeconfig}, Client, Config};
use kube::api::ListParams;
use serde_json::json;

use super::models::{GraphEdge, GraphNode, InfrastructureGraph};

/// Service contract for fetching Kubernetes cluster state.
#[async_trait]
pub trait K8sService: Send + Sync {
    /// Fetch a full cluster snapshot from the given kubeconfig path.
    /// Pass an empty string to auto-detect via KUBECONFIG / ~/.kube/config.
    async fn get_cluster_snapshot(&self, kubeconfig_path: &str) -> Result<InfrastructureGraph>;
}

pub struct KubeRsK8sService;

#[async_trait]
impl K8sService for KubeRsK8sService {
    async fn get_cluster_snapshot(&self, kubeconfig_path: &str) -> Result<InfrastructureGraph> {
        let config = if kubeconfig_path.is_empty() {
            Config::infer().await?
        } else {
            let kubeconfig = Kubeconfig::read_from(kubeconfig_path)?;
            Config::from_custom_kubeconfig(kubeconfig, &KubeConfigOptions::default()).await?
        };
        let client = Client::try_from(config)?;

        let mut nodes: Vec<GraphNode> = Vec::new();
        let mut edges: Vec<GraphEdge> = Vec::new();

        // ── Namespaces ────────────────────────────────────────────────────────
        let ns_api: Api<Namespace> = Api::all(client.clone());
        if let Ok(list) = ns_api.list(&ListParams::default()).await {
            for ns in list.items {
                let name = ns.metadata.name.clone().unwrap_or_default();
                let created_at = ns
                    .metadata
                    .creation_timestamp
                    .as_ref()
                    .map(|t| t.0.to_rfc3339())
                    .unwrap_or_else(|| Utc::now().to_rfc3339());

                nodes.push(GraphNode {
                    id: format!("namespace/{name}"),
                    node_type: "namespace".into(),
                    name,
                    namespace: None,
                    status: "healthy".into(),
                    metadata: json!({}),
                    created_at,
                });
            }
        }

        // ── Cluster nodes ─────────────────────────────────────────────────────
        let node_api: Api<Node> = Api::all(client.clone());
        if let Ok(list) = node_api.list(&ListParams::default()).await {
            for node in list.items {
                let name = node.metadata.name.clone().unwrap_or_default();
                let created_at = node
                    .metadata
                    .creation_timestamp
                    .as_ref()
                    .map(|t| t.0.to_rfc3339())
                    .unwrap_or_else(|| Utc::now().to_rfc3339());

                let status = node
                    .status
                    .as_ref()
                    .and_then(|s| s.conditions.as_ref())
                    .and_then(|cs| cs.iter().find(|c| c.type_ == "Ready"))
                    .map(|c| if c.status == "True" { "healthy" } else { "error" })
                    .unwrap_or("unknown");

                let capacity = node
                    .status
                    .as_ref()
                    .and_then(|s| s.capacity.as_ref())
                    .map(|cap| {
                        json!({
                            "cpu": cap.get("cpu").map(|q| &q.0),
                            "memory": cap.get("memory").map(|q| &q.0),
                        })
                    })
                    .unwrap_or_default();

                nodes.push(GraphNode {
                    id: format!("node/{name}"),
                    node_type: "node".into(),
                    name,
                    namespace: None,
                    status: status.into(),
                    metadata: json!({ "capacity": capacity }),
                    created_at,
                });
            }
        }

        // ── Pods ──────────────────────────────────────────────────────────────
        let pod_api: Api<Pod> = Api::all(client.clone());
        if let Ok(list) = pod_api.list(&ListParams::default()).await {
            for pod in list.items {
                let name = pod.metadata.name.clone().unwrap_or_default();
                let ns = pod
                    .metadata
                    .namespace
                    .clone()
                    .unwrap_or_else(|| "default".into());
                let id = format!("pod/{ns}/{name}");
                let ns_id = format!("namespace/{ns}");
                let created_at = pod
                    .metadata
                    .creation_timestamp
                    .as_ref()
                    .map(|t| t.0.to_rfc3339())
                    .unwrap_or_else(|| Utc::now().to_rfc3339());

                let phase = pod
                    .status
                    .as_ref()
                    .and_then(|s| s.phase.as_deref())
                    .unwrap_or("Unknown");
                let status = match phase {
                    "Running" | "Succeeded" => "healthy",
                    "Pending" => "warning",
                    "Failed" => "error",
                    _ => "unknown",
                };
                let pod_ip = pod.status.as_ref().and_then(|s| s.pod_ip.clone());
                let restart_count = pod
                    .status
                    .as_ref()
                    .and_then(|s| s.container_statuses.as_ref())
                    .and_then(|cs| cs.first())
                    .map(|c| c.restart_count)
                    .unwrap_or(0);

                nodes.push(GraphNode {
                    id: id.clone(),
                    node_type: "pod".into(),
                    name,
                    namespace: Some(ns),
                    status: status.into(),
                    metadata: json!({ "phase": phase, "podIP": pod_ip, "restartCount": restart_count }),
                    created_at,
                });
                push_owns_edge(&mut edges, &ns_id, &id);
            }
        }

        // ── Deployments ───────────────────────────────────────────────────────
        let deploy_api: Api<Deployment> = Api::all(client.clone());
        if let Ok(list) = deploy_api.list(&ListParams::default()).await {
            for d in list.items {
                let name = d.metadata.name.clone().unwrap_or_default();
                let ns = d
                    .metadata
                    .namespace
                    .clone()
                    .unwrap_or_else(|| "default".into());
                let id = format!("deployment/{ns}/{name}");
                let ns_id = format!("namespace/{ns}");
                let created_at = d
                    .metadata
                    .creation_timestamp
                    .as_ref()
                    .map(|t| t.0.to_rfc3339())
                    .unwrap_or_else(|| Utc::now().to_rfc3339());

                let desired = d.spec.as_ref().and_then(|s| s.replicas).unwrap_or(1);
                let available = d
                    .status
                    .as_ref()
                    .and_then(|s| s.available_replicas)
                    .unwrap_or(0);
                let ready = d
                    .status
                    .as_ref()
                    .and_then(|s| s.ready_replicas)
                    .unwrap_or(0);
                let status = if available == 0 {
                    "error"
                } else if available < desired {
                    "warning"
                } else {
                    "healthy"
                };

                nodes.push(GraphNode {
                    id: id.clone(),
                    node_type: "deployment".into(),
                    name,
                    namespace: Some(ns),
                    status: status.into(),
                    metadata: json!({ "replicas": desired, "readyReplicas": ready, "availableReplicas": available }),
                    created_at,
                });
                push_owns_edge(&mut edges, &ns_id, &id);
            }
        }

        // ── Services ──────────────────────────────────────────────────────────
        let svc_api: Api<Service> = Api::all(client.clone());
        if let Ok(list) = svc_api.list(&ListParams::default()).await {
            for svc in list.items {
                let name = svc.metadata.name.clone().unwrap_or_default();
                let ns = svc
                    .metadata
                    .namespace
                    .clone()
                    .unwrap_or_else(|| "default".into());
                let id = format!("service/{ns}/{name}");
                let ns_id = format!("namespace/{ns}");
                let created_at = svc
                    .metadata
                    .creation_timestamp
                    .as_ref()
                    .map(|t| t.0.to_rfc3339())
                    .unwrap_or_else(|| Utc::now().to_rfc3339());

                let svc_type = svc
                    .spec
                    .as_ref()
                    .and_then(|s| s.type_.clone())
                    .unwrap_or_default();
                let cluster_ip = svc
                    .spec
                    .as_ref()
                    .and_then(|s| s.cluster_ip.clone())
                    .unwrap_or_default();

                nodes.push(GraphNode {
                    id: id.clone(),
                    node_type: "service".into(),
                    name,
                    namespace: Some(ns),
                    status: "healthy".into(),
                    metadata: json!({ "serviceType": svc_type, "clusterIP": cluster_ip }),
                    created_at,
                });
                push_owns_edge(&mut edges, &ns_id, &id);
            }
        }

        // ── StatefulSets ──────────────────────────────────────────────────────
        let sts_api: Api<StatefulSet> = Api::all(client.clone());
        if let Ok(list) = sts_api.list(&ListParams::default()).await {
            for sts in list.items {
                let name = sts.metadata.name.clone().unwrap_or_default();
                let ns = sts
                    .metadata
                    .namespace
                    .clone()
                    .unwrap_or_else(|| "default".into());
                let id = format!("statefulset/{ns}/{name}");
                let ns_id = format!("namespace/{ns}");
                let created_at = sts
                    .metadata
                    .creation_timestamp
                    .as_ref()
                    .map(|t| t.0.to_rfc3339())
                    .unwrap_or_else(|| Utc::now().to_rfc3339());

                let desired = sts.spec.as_ref().and_then(|s| s.replicas).unwrap_or(1);
                let ready = sts
                    .status
                    .as_ref()
                    .and_then(|s| s.ready_replicas)
                    .unwrap_or(0);
                let status = if ready == 0 {
                    "error"
                } else if ready < desired {
                    "warning"
                } else {
                    "healthy"
                };

                nodes.push(GraphNode {
                    id: id.clone(),
                    node_type: "statefulset".into(),
                    name,
                    namespace: Some(ns),
                    status: status.into(),
                    metadata: json!({ "replicas": desired, "readyReplicas": ready }),
                    created_at,
                });
                push_owns_edge(&mut edges, &ns_id, &id);
            }
        }

        // ── DaemonSets ────────────────────────────────────────────────────────
        let ds_api: Api<DaemonSet> = Api::all(client.clone());
        if let Ok(list) = ds_api.list(&ListParams::default()).await {
            for ds in list.items {
                let name = ds.metadata.name.clone().unwrap_or_default();
                let ns = ds
                    .metadata
                    .namespace
                    .clone()
                    .unwrap_or_else(|| "default".into());
                let id = format!("daemonset/{ns}/{name}");
                let ns_id = format!("namespace/{ns}");
                let created_at = ds
                    .metadata
                    .creation_timestamp
                    .as_ref()
                    .map(|t| t.0.to_rfc3339())
                    .unwrap_or_else(|| Utc::now().to_rfc3339());

                nodes.push(GraphNode {
                    id: id.clone(),
                    node_type: "daemonset".into(),
                    name,
                    namespace: Some(ns),
                    status: "healthy".into(),
                    metadata: json!({}),
                    created_at,
                });
                push_owns_edge(&mut edges, &ns_id, &id);
            }
        }

        Ok(InfrastructureGraph {
            nodes,
            edges,
            timestamp: Utc::now().to_rfc3339(),
        })
    }
}

fn push_owns_edge(edges: &mut Vec<GraphEdge>, source_id: &str, target_id: &str) {
    edges.push(GraphEdge {
        id: format!(
            "edge-{}-{}",
            source_id.replace('/', "-"),
            target_id.replace('/', "-")
        ),
        source_id: source_id.into(),
        target_id: target_id.into(),
        edge_type: "owns".into(),
    });
}
