use rmcp::ErrorData;
use serde_json::{json, Value};

fn ie(e: impl std::fmt::Display) -> ErrorData {
    ErrorData::internal_error(e.to_string(), None)
}

/// Static registry of all 27 fredo MCP tools with descriptions.
fn tool_registry() -> Vec<(&'static str, &'static str, &'static str)> {
    vec![
        // (name, group, description)
        ("kubectl_get_pods", "kubectl", "List Kubernetes pods with phase, readiness, and restart counts."),
        ("kubectl_describe_pod", "kubectl", "Get detailed pod info including conditions, events, resources, and probes."),
        ("kubectl_get_deployments", "kubectl", "List Kubernetes deployments with replica counts."),
        ("kubectl_get_services", "kubectl", "List Kubernetes services with types, IPs, and ports."),
        ("kubectl_get_events", "kubectl", "Query cluster events, filterable by object name."),
        ("kubectl_logs", "kubectl", "Fetch container logs from a pod."),
        ("kubectl_exec", "kubectl", "Execute a command inside a running container."),
        ("kubectl_delete_pod", "kubectl", "Delete a pod (will be recreated by its controller)."),
        ("kubectl_restart_deployment", "kubectl", "Trigger a rolling restart of a deployment."),
        ("kubectl_scale_deployment", "kubectl", "Scale a deployment to a desired replica count."),
        ("kubectl_rollout_status", "kubectl", "Check the rollout status of a deployment."),
        ("kubectl_top_pods", "kubectl", "Get CPU/memory resource usage for pods via metrics-server."),
        ("infrastructure_snapshot", "infrastructure", "Get a complete K8s infrastructure graph as a one-time snapshot."),
        ("infrastructure_stream", "infrastructure", "Get K8s infrastructure graph and stream it to the Fredo UI."),
        ("jira_get_issue_details", "jira", "Retrieve full details of a Jira issue by key."),
        ("jira_get_my_issues", "jira", "List Jira issues assigned to the configured user."),
        ("jira_create_issue", "jira", "Create a new Jira issue (Bug, Task, Story, etc.)."),
        ("azdo_create_workitem", "azdo", "Create a new Azure DevOps work item."),
        ("azdo_start_workitem", "azdo", "Move an Azure DevOps work item to In Progress."),
        ("optimizely_get_flags", "optimizely", "List Optimizely feature flags and their state per environment."),
        ("optimizely_update_flag", "optimizely", "Enable or disable an Optimizely feature flag."),
        ("logs_query", "observability", "SQL SELECT query against the application_logs table."),
        ("metrics_query", "observability", "Query OpenTelemetry metrics by name and time range."),
        ("traces_query", "observability", "Query OpenTelemetry trace spans by trace_id, operation, or status."),
        ("code_execute", "sandbox", "Execute code in a sandbox (python, js, ts, go, java, r)."),
        ("fredo_ui_alert", "fredo_ui", "Display an alert in the Fredo desktop UI."),
        ("fredo_ui_stepper", "fredo_ui", "Display a multi-step wizard in the Fredo UI."),
        ("fredo_ui_collect_responses", "fredo_ui", "Prompt the user for input via the Fredo UI."),
        ("tools_documentation", "meta", "Get documentation and examples for a specific tool."),
        ("tool_search", "meta", "Search tools by natural-language description."),
    ]
}

pub fn documentation(tool_name: &str) -> Result<String, ErrorData> {
    let registry = tool_registry();
    let entry = registry
        .iter()
        .find(|(name, _, _)| *name == tool_name)
        .ok_or_else(|| {
            ErrorData::invalid_params(
                format!("Tool '{tool_name}' not found. Use tool_search to discover available tools."),
                None,
            )
        })?;

    let (name, group, desc) = entry;
    let result = json!({
        "name": name,
        "group": group,
        "description": desc,
        "credentials": credential_hint(name),
        "example": example_for(name),
    });
    serde_json::to_string_pretty(&result).map_err(ie)
}

pub fn search(query: &str, limit: usize) -> Result<String, ErrorData> {
    let registry = tool_registry();
    let q = query.to_lowercase();

    let mut scored: Vec<(usize, (&str, &str, &str))> = registry
        .into_iter()
        .map(|entry| {
            let (name, group, desc) = entry;
            let combined = format!("{name} {group} {desc}").to_lowercase();
            let score: usize = q
                .split_whitespace()
                .map(|word| combined.matches(word).count())
                .sum();
            (score, entry)
        })
        .filter(|(score, _)| *score > 0)
        .collect();

    scored.sort_by(|a, b| b.0.cmp(&a.0));
    scored.truncate(limit);

    let results: Vec<Value> = scored
        .iter()
        .map(|(_, (name, group, desc))| {
            json!({ "name": name, "group": group, "description": desc })
        })
        .collect();

    serde_json::to_string_pretty(&results).map_err(ie)
}

fn credential_hint(tool_name: &str) -> &'static str {
    if tool_name.starts_with("kubectl") || tool_name.starts_with("infrastructure") {
        "Kubeconfig path via 'kubeconfig_path' parameter or auto-detect from KUBECONFIG env."
    } else if tool_name.starts_with("jira") {
        "Set mcp.jira.base_url, mcp.jira.email, mcp.jira.api_token via 'fredo setting set'."
    } else if tool_name.starts_with("azdo") {
        "Set mcp.azdo.org_url, mcp.azdo.project, mcp.azdo.pat via 'fredo setting set'."
    } else if tool_name.starts_with("optimizely") {
        "Set mcp.optimizely.project_id, mcp.optimizely.sdk_key via 'fredo setting set'."
    } else if tool_name.starts_with("logs") || tool_name.starts_with("metrics") || tool_name.starts_with("traces") {
        "Set mcp.db.url (PostgreSQL connection string) via 'fredo setting set'."
    } else if tool_name == "code_execute" {
        "Set mcp.code_sandbox_url (default: http://localhost:8000) via 'fredo setting set'."
    } else {
        "No credentials required."
    }
}

#[cfg(test)]
mod tests {
    use crate::features::mcp::server::{ToolSearchParams, ToolsDocumentationParams};
    use serde_json::json;

    // ── ToolsDocumentationParams ───────────────────────────────────────────────

    #[test]
    fn tools_documentation_full_json_deserializes() {
        let p: ToolsDocumentationParams = serde_json::from_value(json!({
            "tool_name": "kubectl_get_pods"
        }))
        .unwrap();
        let debug = format!("{:?}", p);
        assert!(debug.contains("kubectl_get_pods"), "tool_name should be present");
    }

    #[test]
    fn tools_documentation_missing_tool_name_fails() {
        let result: Result<ToolsDocumentationParams, _> =
            serde_json::from_value(json!({}));
        assert!(result.is_err(), "missing 'tool_name' must fail");
    }

    #[test]
    fn tools_documentation_invalid_type_fails() {
        let result: Result<ToolsDocumentationParams, _> =
            serde_json::from_value(json!({ "tool_name": false }));
        assert!(result.is_err(), "tool_name as boolean must fail");
    }

    // ── ToolSearchParams ───────────────────────────────────────────────────────

    #[test]
    fn tool_search_full_json_deserializes() {
        let p: ToolSearchParams = serde_json::from_value(json!({
            "query": "find pods",
            "limit": 10
        }))
        .unwrap();
        let debug = format!("{:?}", p);
        assert!(debug.contains("find pods"), "query should be present");
        assert!(debug.contains("10"), "limit should be present");
    }

    #[test]
    fn tool_search_minimal_json_deserializes() {
        let p: ToolSearchParams = serde_json::from_value(json!({
            "query": "list"
        }))
        .unwrap();
        let debug = format!("{:?}", p);
        assert!(debug.contains("list"));
    }

    #[test]
    fn tool_search_missing_query_fails() {
        let result: Result<ToolSearchParams, _> =
            serde_json::from_value(json!({ "limit": 5 }));
        assert!(result.is_err(), "missing 'query' must fail");
    }
}

fn example_for(tool_name: &str) -> Value {
    match tool_name {
        "kubectl_get_pods" => json!({ "namespace": "default" }),
        "kubectl_describe_pod" => json!({ "namespace": "default", "pod_name": "my-app-abc123" }),
        "kubectl_logs" => json!({ "namespace": "default", "pod_name": "my-app-abc123", "tail_lines": 50 }),
        "kubectl_exec" => json!({ "namespace": "default", "pod_name": "my-app-abc123", "command": "ls /tmp" }),
        "kubectl_scale_deployment" => json!({ "namespace": "default", "deployment_name": "my-app", "replicas": 3 }),
        "jira_get_issue_details" => json!({ "issue_key": "PROJ-123" }),
        "jira_get_my_issues" => json!({ "max_results": 10, "status": "In Progress" }),
        "jira_create_issue" => json!({ "project_key": "PROJ", "summary": "Fix login bug", "issue_type": "Bug", "priority": "High" }),
        "azdo_create_workitem" => json!({ "work_item_type": "User Story", "title": "Add dark mode", "priority": 2 }),
        "azdo_start_workitem" => json!({ "work_item_id": 12345 }),
        "optimizely_get_flags" => json!({ "environment": "production" }),
        "optimizely_update_flag" => json!({ "flag_key": "new_checkout", "environment": "production", "enabled": true }),
        "logs_query" => json!({ "query": "SELECT * FROM application_logs WHERE level = 'error' LIMIT 50", "timeout_ms": 5000 }),
        "metrics_query" => json!({ "metric_name": "http_requests_total", "start_time": "2025-01-01T00:00:00Z", "limit": 100 }),
        "traces_query" => json!({ "status": "error", "min_duration_ms": 1000, "limit": 20 }),
        "code_execute" => json!({ "language": "python", "code": "print('hello world')" }),
        "fredo_ui_alert" => json!({ "message": "Deployment complete", "level": "success" }),
        _ => json!({}),
    }
}
