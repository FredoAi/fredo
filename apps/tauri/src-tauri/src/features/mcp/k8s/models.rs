use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InfrastructureGraph {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphNode {
    pub id: String,
    #[serde(rename = "type")]
    pub node_type: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
    pub status: String,
    pub metadata: serde_json::Value,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphEdge {
    pub id: String,
    #[serde(rename = "sourceId")]
    pub source_id: String,
    #[serde(rename = "targetId")]
    pub target_id: String,
    #[serde(rename = "type")]
    pub edge_type: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── REQ-8: InfrastructureGraph/GraphNode/GraphEdge round-trip ─────────

    #[test]
    fn graph_node_round_trip() {
        let node = GraphNode {
            id: "pod/default/nginx-abc123".into(),
            node_type: "pod".into(),
            name: "nginx-abc123".into(),
            namespace: Some("default".into()),
            status: "healthy".into(),
            metadata: serde_json::json!({"phase": "Running", "podIP": "10.0.0.1"}),
            created_at: "2026-06-04T12:00:00Z".into(),
        };

        let json = serde_json::to_string(&node).expect("serialize");
        let deserialized: GraphNode = serde_json::from_str(&json).expect("deserialize");

        assert_eq!(deserialized.id, node.id);
        assert_eq!(deserialized.node_type, node.node_type);
        assert_eq!(deserialized.name, node.name);
        assert_eq!(deserialized.namespace, node.namespace);
        assert_eq!(deserialized.status, node.status);
        assert_eq!(deserialized.created_at, node.created_at);
        assert_eq!(deserialized.metadata, node.metadata);
    }

    #[test]
    fn graph_node_without_namespace() {
        let node = GraphNode {
            id: "namespace/default".into(),
            node_type: "namespace".into(),
            name: "default".into(),
            namespace: None,
            status: "healthy".into(),
            metadata: serde_json::json!({}),
            created_at: "2026-06-04T12:00:00Z".into(),
        };

        let json = serde_json::to_string(&node).expect("serialize");
        // namespace should be absent from JSON (skip_serializing_if)
        assert!(!json.contains("namespace"), "namespace should be absent when None");
        let deserialized: GraphNode = serde_json::from_str(&json).expect("deserialize");
        assert!(deserialized.namespace.is_none());
    }

    #[test]
    fn graph_edge_round_trip() {
        let edge = GraphEdge {
            id: "edge-namespace-default-pod-default-nginx".into(),
            source_id: "namespace/default".into(),
            target_id: "pod/default/nginx".into(),
            edge_type: "owns".into(),
        };

        let json = serde_json::to_string(&edge).expect("serialize");
        let deserialized: GraphEdge = serde_json::from_str(&json).expect("deserialize");

        assert_eq!(deserialized.id, edge.id);
        assert_eq!(deserialized.source_id, edge.source_id);
        assert_eq!(deserialized.target_id, edge.target_id);
        assert_eq!(deserialized.edge_type, edge.edge_type);
    }

    #[test]
    fn graph_edge_serde_renames() {
        // Verify JSON field names match the #[serde(rename = "...")] attributes
        let json = r#"{
            "id": "edge-1",
            "sourceId": "ns-a",
            "targetId": "pod-b",
            "type": "owns"
        }"#;
        let edge: GraphEdge = serde_json::from_str(json).expect("deserialize with camelCase fields");
        assert_eq!(edge.source_id, "ns-a");
        assert_eq!(edge.target_id, "pod-b");
        assert_eq!(edge.edge_type, "owns");
    }

    #[test]
    fn infrastructure_graph_round_trip() {
        let graph = InfrastructureGraph {
            nodes: vec![
                GraphNode {
                    id: "namespace/default".into(),
                    node_type: "namespace".into(),
                    name: "default".into(),
                    namespace: None,
                    status: "healthy".into(),
                    metadata: serde_json::json!({}),
                    created_at: "2026-06-04T12:00:00Z".into(),
                },
                GraphNode {
                    id: "pod/default/nginx".into(),
                    node_type: "pod".into(),
                    name: "nginx".into(),
                    namespace: Some("default".into()),
                    status: "healthy".into(),
                    metadata: serde_json::json!({"phase": "Running"}),
                    created_at: "2026-06-04T12:01:00Z".into(),
                },
            ],
            edges: vec![GraphEdge {
                id: "edge-namespace-default-pod-default-nginx".into(),
                source_id: "namespace/default".into(),
                target_id: "pod/default/nginx".into(),
                edge_type: "owns".into(),
            }],
            timestamp: "2026-06-04T12:00:00Z".into(),
        };

        let json = serde_json::to_string_pretty(&graph).expect("serialize");
        let deserialized: InfrastructureGraph = serde_json::from_str(&json).expect("deserialize");

        assert_eq!(deserialized.nodes.len(), 2);
        assert_eq!(deserialized.edges.len(), 1);
        assert_eq!(deserialized.timestamp, graph.timestamp);
        assert_eq!(deserialized.nodes[0].name, "default");
        assert_eq!(deserialized.nodes[1].name, "nginx");
        assert_eq!(deserialized.edges[0].edge_type, "owns");
    }
}
