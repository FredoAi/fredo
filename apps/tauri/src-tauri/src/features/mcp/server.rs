#![allow(dead_code)]

//! Fredo MCP server – all 27 tools in a single handler.
//!
//! Tools are organised into these groups:
//!   kubectl (12), infrastructure (2), jira (3), azdo (2), optimizely (2),
//!   observability (3), code_execute (1), fredo_ui (3), tools_doc (2).

use rmcp::{
    handler::server::wrapper::Parameters,
    schemars::JsonSchema,
    tool, tool_handler, tool_router, ErrorData, ServerHandler,
};
use serde::Deserialize;
use std::sync::Arc;

use crate::infrastructure::storage::AppStore;

// ── Helpers ───────────────────────────────────────────────────────────────────

fn internal(msg: impl std::fmt::Display) -> ErrorData {
    ErrorData::internal_error(msg.to_string(), None)
}

// ── Server state ──────────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct FredoMcpServer {
    #[allow(dead_code)] // consumed by the #[tool_router] macro at runtime
    tool_router: rmcp::handler::server::router::tool::ToolRouter<Self>,
    pub(crate) store: Arc<AppStore>,
    pub(crate) app: Option<tauri::AppHandle>,
    pub(crate) http: reqwest::Client,
    pub(crate) db: Option<Arc<sqlx::PgPool>>,
}

impl FredoMcpServer {
    /// Create a new server, trying to connect to PostgreSQL if configured.
    pub async fn new(store: Arc<AppStore>, app: Option<tauri::AppHandle>) -> Self {
        let db = match store.get("mcp.db.url") {
            Ok(Some(url)) => match sqlx::PgPool::connect(&url).await {
                Ok(pool) => {
                    eprintln!("[fredo/mcp] Connected to PostgreSQL");
                    Some(Arc::new(pool))
                }
                Err(e) => {
                    eprintln!("[fredo/mcp] PostgreSQL unavailable: {e}");
                    None
                }
            },
            _ => None,
        };
        Self::new_with_db(store, app, db)
    }

    /// Synchronous constructor used by the HTTP server factory (DB pool passed in).
    pub fn new_with_db(
        store: Arc<AppStore>,
        app: Option<tauri::AppHandle>,
        db: Option<Arc<sqlx::PgPool>>,
    ) -> Self {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .unwrap_or_default();
        Self {
            tool_router: Self::tool_router(),
            store,
            app,
            http,
            db,
        }
    }

    // ── Credential helpers ────────────────────────────────────────────────────

    fn setting(&self, key: &str) -> Option<String> {
        self.store.get(key).ok().flatten()
    }

    fn require(&self, key: &str) -> Result<String, ErrorData> {
        self.setting(key)
            .ok_or_else(|| internal(format!("credential not configured: {key}")))
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Parameter structs
// ═══════════════════════════════════════════════════════════════════════════════

// ── Kubectl ───────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize, JsonSchema)]
struct KubectlNamespaceOpt {
    kubeconfig_path: Option<String>,
    /// Kubernetes namespace. Leave empty for all namespaces.
    namespace: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct KubectlDescribePodParams {
    kubeconfig_path: Option<String>,
    namespace: Option<String>,
    /// Name of the pod to describe.
    pod_name: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct KubectlLogsParams {
    kubeconfig_path: Option<String>,
    namespace: Option<String>,
    pod_name: String,
    /// Container name within the pod (optional if pod has one container).
    container: Option<String>,
    /// Maximum number of lines to return (default 100).
    tail_lines: Option<i64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct KubectlExecParams {
    kubeconfig_path: Option<String>,
    namespace: Option<String>,
    pod_name: String,
    container: Option<String>,
    /// Shell command to execute, e.g. "ls /tmp".
    command: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct KubectlDeletePodParams {
    kubeconfig_path: Option<String>,
    namespace: Option<String>,
    pod_name: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct KubectlDeploymentParams {
    kubeconfig_path: Option<String>,
    namespace: Option<String>,
    /// Deployment name.
    deployment_name: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct KubectlScaleParams {
    kubeconfig_path: Option<String>,
    namespace: Option<String>,
    deployment_name: String,
    /// Desired replica count.
    replicas: i32,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct KubectlEventsParams {
    kubeconfig_path: Option<String>,
    namespace: Option<String>,
    /// Filter events by involved object name (pod / deployment name).
    object_name: Option<String>,
}

// ── Infrastructure diagram ────────────────────────────────────────────────────

#[derive(Debug, Deserialize, JsonSchema)]
struct InfrastructureParams {
    kubeconfig_path: Option<String>,
}

// ── Jira ──────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize, JsonSchema)]
struct JiraGetIssueParams {
    /// Jira issue key, e.g. "PROJ-123".
    issue_key: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct JiraGetMyIssuesParams {
    /// Maximum number of issues to return (default 20).
    max_results: Option<u32>,
    /// JQL status filter, e.g. "To Do,In Progress".
    status: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct JiraCreateIssueParams {
    /// Jira project key, e.g. "PROJ".
    project_key: String,
    /// Issue summary / title.
    summary: String,
    /// Issue type: "Bug", "Task", "Story", etc.
    issue_type: Option<String>,
    /// Issue description in plain text.
    description: Option<String>,
    /// Priority: "Highest", "High", "Medium", "Low", "Lowest".
    priority: Option<String>,
    /// Comma-separated labels.
    labels: Option<String>,
}

// ── Azure DevOps ──────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize, JsonSchema)]
struct AzdoCreateWorkitemParams {
    /// Work item type: "Epic", "Feature", "User Story", "Bug", "Task".
    work_item_type: String,
    /// Title of the work item.
    title: String,
    /// Description (HTML or plain text).
    description: Option<String>,
    /// Priority (1–4).
    priority: Option<u32>,
    /// Assigned-to display name or email.
    assigned_to: Option<String>,
    /// Iteration path (sprint).
    iteration_path: Option<String>,
    /// Area path.
    area_path: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct AzdoStartWorkitemParams {
    /// Numeric work item ID to move to "In Progress".
    work_item_id: u64,
}

// ── Optimizely ────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize, JsonSchema)]
struct OptimizelyGetFlagsParams {
    /// Optional environment name to filter by (e.g. "production").
    environment: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct OptimizelyUpdateFlagParams {
    /// Feature flag key.
    flag_key: String,
    /// Environment name, e.g. "production".
    environment: String,
    /// Desired state: true = on, false = off.
    enabled: bool,
}

// ── Observability ─────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize, JsonSchema)]
struct LogsQueryParams {
    /// SQL SELECT query against the `application_logs` table.
    query: String,
    /// Statement timeout in milliseconds (default 10000).
    timeout_ms: Option<u32>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct MetricsQueryParams {
    /// Metric name to filter by (partial match allowed).
    metric_name: Option<String>,
    /// ISO-8601 start timestamp, e.g. "2025-01-01T00:00:00Z".
    start_time: Option<String>,
    /// ISO-8601 end timestamp.
    end_time: Option<String>,
    /// Maximum rows to return (default 100).
    limit: Option<u32>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct TracesQueryParams {
    /// Filter by trace ID.
    trace_id: Option<String>,
    /// Filter by operation name (partial match).
    operation_name: Option<String>,
    /// Filter by status: "ok", "error", "unset".
    status: Option<String>,
    /// Minimum duration in milliseconds.
    min_duration_ms: Option<u64>,
    /// Maximum rows to return (default 50).
    limit: Option<u32>,
}

// ── Code execution ────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize, JsonSchema)]
struct CodeExecuteParams {
    /// Source code to execute.
    code: String,
    /// Language: "python", "javascript", "typescript", "go", "java", "r".
    language: String,
    /// Extra libraries to install before execution.
    libraries: Option<Vec<String>>,
    /// Execution timeout in milliseconds (default 30000).
    timeout_ms: Option<u32>,
    /// Session ID for tool call correlation.
    session_id: Option<String>,
}

// ── Fredo UI ──────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize, JsonSchema)]
struct FredoUiAlertParams {
    /// Message to display.
    message: String,
    /// Severity: "info", "warning", "error", "success".
    level: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct FredoUiStepperParams {
    /// Title of the multi-step wizard.
    title: String,
    /// Ordered list of step titles.
    steps: Vec<String>,
    /// Step index to highlight as current (0-based).
    current_step: Option<u32>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct FredoUiCollectResponsesParams {
    /// Question or prompt to show the user.
    prompt: String,
    /// Placeholder text for the input field.
    placeholder: Option<String>,
}

// ── Tools documentation ───────────────────────────────────────────────────────

#[derive(Debug, Deserialize, JsonSchema)]
struct ToolsDocumentationParams {
    /// Exact tool name to retrieve documentation for.
    tool_name: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct ToolSearchParams {
    /// Natural-language description of what you need.
    query: String,
    /// Maximum number of tools to return (default 5).
    limit: Option<u32>,
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tool router – all 27 tools
// ═══════════════════════════════════════════════════════════════════════════════

#[tool_router]
impl FredoMcpServer {
    // ── kubectl_get_pods ──────────────────────────────────────────────────────

    #[tool(description = "List Kubernetes pods with phase, readiness status, and restart counts.")]
    async fn kubectl_get_pods(
        &self,
        Parameters(p): Parameters<KubectlNamespaceOpt>,
    ) -> Result<String, ErrorData> {
        use super::kubectl as k;
        let client = k::build_client(p.kubeconfig_path.as_deref()).await?;
        k::get_pods(client, p.namespace.as_deref()).await
    }

    // ── kubectl_describe_pod ──────────────────────────────────────────────────

    #[tool(description = "Get detailed information about a specific pod including conditions, events, resources, and probes.")]
    async fn kubectl_describe_pod(
        &self,
        Parameters(p): Parameters<KubectlDescribePodParams>,
    ) -> Result<String, ErrorData> {
        use super::kubectl as k;
        let client = k::build_client(p.kubeconfig_path.as_deref()).await?;
        k::describe_pod(client, p.namespace.as_deref(), &p.pod_name).await
    }

    // ── kubectl_get_deployments ───────────────────────────────────────────────

    #[tool(description = "List Kubernetes deployments with replica counts and conditions.")]
    async fn kubectl_get_deployments(
        &self,
        Parameters(p): Parameters<KubectlNamespaceOpt>,
    ) -> Result<String, ErrorData> {
        use super::kubectl as k;
        let client = k::build_client(p.kubeconfig_path.as_deref()).await?;
        k::get_deployments(client, p.namespace.as_deref()).await
    }

    // ── kubectl_get_services ──────────────────────────────────────────────────

    #[tool(description = "List Kubernetes services with their types, cluster IPs, and ports.")]
    async fn kubectl_get_services(
        &self,
        Parameters(p): Parameters<KubectlNamespaceOpt>,
    ) -> Result<String, ErrorData> {
        use super::kubectl as k;
        let client = k::build_client(p.kubeconfig_path.as_deref()).await?;
        k::get_services(client, p.namespace.as_deref()).await
    }

    // ── kubectl_get_events ────────────────────────────────────────────────────

    #[tool(description = "Query Kubernetes cluster events. Filter by object name to see pod or deployment errors and warnings.")]
    async fn kubectl_get_events(
        &self,
        Parameters(p): Parameters<KubectlEventsParams>,
    ) -> Result<String, ErrorData> {
        use super::kubectl as k;
        let client = k::build_client(p.kubeconfig_path.as_deref()).await?;
        k::get_events(client, p.namespace.as_deref(), p.object_name.as_deref()).await
    }

    // ── kubectl_logs ──────────────────────────────────────────────────────────

    #[tool(description = "Fetch container logs from a running pod.")]
    async fn kubectl_logs(
        &self,
        Parameters(p): Parameters<KubectlLogsParams>,
    ) -> Result<String, ErrorData> {
        use super::kubectl as k;
        let client = k::build_client(p.kubeconfig_path.as_deref()).await?;
        k::get_logs(
            client,
            p.namespace.as_deref(),
            &p.pod_name,
            p.container.as_deref(),
            p.tail_lines,
        )
        .await
    }

    // ── kubectl_exec ──────────────────────────────────────────────────────────

    #[tool(description = "Execute a shell command inside a running container and return the output.")]
    async fn kubectl_exec(
        &self,
        Parameters(p): Parameters<KubectlExecParams>,
    ) -> Result<String, ErrorData> {
        use super::kubectl as k;
        let client = k::build_client(p.kubeconfig_path.as_deref()).await?;
        k::exec_command(
            client,
            p.namespace.as_deref(),
            &p.pod_name,
            p.container.as_deref(),
            &p.command,
        )
        .await
    }

    // ── kubectl_delete_pod ────────────────────────────────────────────────────

    #[tool(description = "Delete a Kubernetes pod (it will be recreated by its controller).")]
    async fn kubectl_delete_pod(
        &self,
        Parameters(p): Parameters<KubectlDeletePodParams>,
    ) -> Result<String, ErrorData> {
        use super::kubectl as k;
        let client = k::build_client(p.kubeconfig_path.as_deref()).await?;
        k::delete_pod(client, p.namespace.as_deref(), &p.pod_name).await
    }

    // ── kubectl_restart_deployment ────────────────────────────────────────────

    #[tool(description = "Trigger a rolling restart of a Kubernetes deployment by patching its rollout annotation.")]
    async fn kubectl_restart_deployment(
        &self,
        Parameters(p): Parameters<KubectlDeploymentParams>,
    ) -> Result<String, ErrorData> {
        use super::kubectl as k;
        let client = k::build_client(p.kubeconfig_path.as_deref()).await?;
        k::restart_deployment(client, p.namespace.as_deref(), &p.deployment_name).await
    }

    // ── kubectl_scale_deployment ──────────────────────────────────────────────

    #[tool(description = "Scale a Kubernetes deployment to the specified number of replicas.")]
    async fn kubectl_scale_deployment(
        &self,
        Parameters(p): Parameters<KubectlScaleParams>,
    ) -> Result<String, ErrorData> {
        use super::kubectl as k;
        let client = k::build_client(p.kubeconfig_path.as_deref()).await?;
        k::scale_deployment(client, p.namespace.as_deref(), &p.deployment_name, p.replicas).await
    }

    // ── kubectl_rollout_status ────────────────────────────────────────────────

    #[tool(description = "Check the rollout status of a Kubernetes deployment (available / unavailable replicas).")]
    async fn kubectl_rollout_status(
        &self,
        Parameters(p): Parameters<KubectlDeploymentParams>,
    ) -> Result<String, ErrorData> {
        use super::kubectl as k;
        let client = k::build_client(p.kubeconfig_path.as_deref()).await?;
        k::rollout_status(client, p.namespace.as_deref(), &p.deployment_name).await
    }

    // ── kubectl_top_pods ──────────────────────────────────────────────────────

    #[tool(description = "Get CPU and memory usage for pods via the metrics-server API.")]
    async fn kubectl_top_pods(
        &self,
        Parameters(p): Parameters<KubectlNamespaceOpt>,
    ) -> Result<String, ErrorData> {
        use super::kubectl as k;
        let client = k::build_client(p.kubeconfig_path.as_deref()).await?;
        k::top_pods(client, p.namespace.as_deref()).await
    }

    // ── infrastructure_snapshot ───────────────────────────────────────────────

    #[tool(description = "Get a complete Kubernetes infrastructure graph (nodes, edges, relationships, health) as a one-time snapshot.")]
    async fn infrastructure_snapshot(
        &self,
        Parameters(p): Parameters<InfrastructureParams>,
    ) -> Result<String, ErrorData> {
        use super::infrastructure as infra;
        infra::snapshot(p.kubeconfig_path.as_deref()).await
    }

    // ── infrastructure_stream ─────────────────────────────────────────────────

    #[tool(description = "Get a Kubernetes infrastructure snapshot and emit it as a stream event to the Fredo UI (if the desktop app is running).")]
    async fn infrastructure_stream(
        &self,
        Parameters(p): Parameters<InfrastructureParams>,
    ) -> Result<String, ErrorData> {
        use super::infrastructure as infra;
        infra::stream(p.kubeconfig_path.as_deref(), self.app.as_ref()).await
    }

    // ── jira_get_issue_details ────────────────────────────────────────────────

    #[tool(description = "Retrieve full details of a Jira issue by its key (e.g. PROJ-123).")]
    async fn jira_get_issue_details(
        &self,
        Parameters(p): Parameters<JiraGetIssueParams>,
    ) -> Result<String, ErrorData> {
        use super::jira;
        let base_url = self.require("mcp.jira.base_url")?;
        let email = self.require("mcp.jira.email")?;
        let token = self.require("mcp.jira.api_token")?;
        jira::get_issue(&self.http, &base_url, &email, &token, &p.issue_key).await
    }

    // ── jira_get_my_issues ────────────────────────────────────────────────────

    #[tool(description = "List Jira issues assigned to the configured user, optionally filtered by status.")]
    async fn jira_get_my_issues(
        &self,
        Parameters(p): Parameters<JiraGetMyIssuesParams>,
    ) -> Result<String, ErrorData> {
        use super::jira;
        let base_url = self.require("mcp.jira.base_url")?;
        let email = self.require("mcp.jira.email")?;
        let token = self.require("mcp.jira.api_token")?;
        jira::get_my_issues(
            &self.http,
            &base_url,
            &email,
            &token,
            p.max_results,
            p.status.as_deref(),
        )
        .await
    }

    // ── jira_create_issue ─────────────────────────────────────────────────────

    #[tool(description = "Create a new Jira issue (Bug, Task, Story, etc.) in the specified project.")]
    async fn jira_create_issue(
        &self,
        Parameters(p): Parameters<JiraCreateIssueParams>,
    ) -> Result<String, ErrorData> {
        use super::jira;
        let base_url = self.require("mcp.jira.base_url")?;
        let email = self.require("mcp.jira.email")?;
        let token = self.require("mcp.jira.api_token")?;
        jira::create_issue(
            &self.http,
            &base_url,
            &email,
            &token,
            &p.project_key,
            &p.summary,
            p.issue_type.as_deref(),
            p.description.as_deref(),
            p.priority.as_deref(),
            p.labels.as_deref(),
        )
        .await
    }

    // ── azdo_create_workitem ──────────────────────────────────────────────────

    #[tool(description = "Create a new Azure DevOps work item (Epic, Feature, User Story, Bug, Task).")]
    async fn azdo_create_workitem(
        &self,
        Parameters(p): Parameters<AzdoCreateWorkitemParams>,
    ) -> Result<String, ErrorData> {
        use super::azdo;
        let org_url = self.require("mcp.azdo.org_url")?;
        let project = self.require("mcp.azdo.project")?;
        let pat = self.require("mcp.azdo.pat")?;
        azdo::create_workitem(
            &self.http,
            &org_url,
            &project,
            &pat,
            &p.work_item_type,
            &p.title,
            p.description.as_deref(),
            p.priority,
            p.assigned_to.as_deref(),
            p.iteration_path.as_deref(),
            p.area_path.as_deref(),
        )
        .await
    }

    // ── azdo_start_workitem ───────────────────────────────────────────────────

    #[tool(description = "Move an Azure DevOps work item to 'In Progress' state.")]
    async fn azdo_start_workitem(
        &self,
        Parameters(p): Parameters<AzdoStartWorkitemParams>,
    ) -> Result<String, ErrorData> {
        use super::azdo;
        let org_url = self.require("mcp.azdo.org_url")?;
        let project = self.require("mcp.azdo.project")?;
        let pat = self.require("mcp.azdo.pat")?;
        azdo::start_workitem(&self.http, &org_url, &project, &pat, p.work_item_id).await
    }

    // ── optimizely_get_flags ──────────────────────────────────────────────────

    #[tool(description = "List Optimizely feature flags and their enabled/disabled state per environment.")]
    async fn optimizely_get_flags(
        &self,
        Parameters(p): Parameters<OptimizelyGetFlagsParams>,
    ) -> Result<String, ErrorData> {
        use super::optimizely;
        let project_id = self.require("mcp.optimizely.project_id")?;
        let sdk_key = self.require("mcp.optimizely.sdk_key")?;
        optimizely::get_flags(
            &self.http,
            &project_id,
            &sdk_key,
            p.environment.as_deref(),
        )
        .await
    }

    // ── optimizely_update_flag ────────────────────────────────────────────────

    #[tool(description = "Enable or disable an Optimizely feature flag in a specific environment.")]
    async fn optimizely_update_flag(
        &self,
        Parameters(p): Parameters<OptimizelyUpdateFlagParams>,
    ) -> Result<String, ErrorData> {
        use super::optimizely;
        let project_id = self.require("mcp.optimizely.project_id")?;
        let sdk_key = self.require("mcp.optimizely.sdk_key")?;
        optimizely::update_flag(
            &self.http,
            &project_id,
            &sdk_key,
            &p.flag_key,
            &p.environment,
            p.enabled,
        )
        .await
    }

    // ── logs_query ────────────────────────────────────────────────────────────

    #[tool(description = "Execute a SQL SELECT query against the application_logs table. Supports full-text search, timestamp filters, and pagination.")]
    async fn logs_query(
        &self,
        Parameters(p): Parameters<LogsQueryParams>,
    ) -> Result<String, ErrorData> {
        use super::observability;
        let pool = self
            .db
            .as_ref()
            .ok_or_else(|| internal("PostgreSQL not configured (set mcp.db.url)"))?;
        observability::logs_query(pool, &p.query, p.timeout_ms).await
    }

    // ── metrics_query ─────────────────────────────────────────────────────────

    #[tool(description = "Query OpenTelemetry metrics stored in PostgreSQL by name, timestamp range, and labels.")]
    async fn metrics_query(
        &self,
        Parameters(p): Parameters<MetricsQueryParams>,
    ) -> Result<String, ErrorData> {
        use super::observability;
        let pool = self
            .db
            .as_ref()
            .ok_or_else(|| internal("PostgreSQL not configured (set mcp.db.url)"))?;
        observability::metrics_query(
            pool,
            p.metric_name.as_deref(),
            p.start_time.as_deref(),
            p.end_time.as_deref(),
            p.limit,
        )
        .await
    }

    // ── traces_query ──────────────────────────────────────────────────────────

    #[tool(description = "Query OpenTelemetry trace spans by trace_id, operation_name, status, or duration.")]
    async fn traces_query(
        &self,
        Parameters(p): Parameters<TracesQueryParams>,
    ) -> Result<String, ErrorData> {
        use super::observability;
        let pool = self
            .db
            .as_ref()
            .ok_or_else(|| internal("PostgreSQL not configured (set mcp.db.url)"))?;
        observability::traces_query(
            pool,
            p.trace_id.as_deref(),
            p.operation_name.as_deref(),
            p.status.as_deref(),
            p.min_duration_ms,
            p.limit,
        )
        .await
    }

    // ── code_execute ──────────────────────────────────────────────────────────

    #[tool(description = "Execute code in a sandboxed environment. Supports python, javascript, typescript, go, java, r. Batch all tool calls in a single script.")]
    async fn code_execute(
        &self,
        Parameters(p): Parameters<CodeExecuteParams>,
    ) -> Result<String, ErrorData> {
        use super::code_execute;
        let sandbox_url = self
            .setting("mcp.code_sandbox_url")
            .unwrap_or_else(|| "http://localhost:8000".into());
        code_execute::execute(
            &self.http,
            &sandbox_url,
            &p.code,
            &p.language,
            p.libraries.as_deref(),
            p.timeout_ms,
            p.session_id.as_deref(),
        )
        .await
    }

    // ── fredo_ui_alert ────────────────────────────────────────────────────────

    #[tool(description = "Display an alert message in the Fredo desktop UI. Only works when the Fredo app is running.")]
    async fn fredo_ui_alert(
        &self,
        Parameters(p): Parameters<FredoUiAlertParams>,
    ) -> Result<String, ErrorData> {
        use super::fredo_ui;
        fredo_ui::alert(self.app.as_ref(), &p.message, p.level.as_deref())
    }

    // ── fredo_ui_stepper ──────────────────────────────────────────────────────

    #[tool(description = "Display a multi-step wizard in the Fredo UI with progress tracking. Only works when the Fredo app is running.")]
    async fn fredo_ui_stepper(
        &self,
        Parameters(p): Parameters<FredoUiStepperParams>,
    ) -> Result<String, ErrorData> {
        use super::fredo_ui;
        fredo_ui::stepper(self.app.as_ref(), &p.title, &p.steps, p.current_step)
    }

    // ── fredo_ui_collect_responses ────────────────────────────────────────────

    #[tool(description = "Prompt the user for text input via the Fredo UI and return their response. Only works when the Fredo app is running.")]
    async fn fredo_ui_collect_responses(
        &self,
        Parameters(p): Parameters<FredoUiCollectResponsesParams>,
    ) -> Result<String, ErrorData> {
        use super::fredo_ui;
        fredo_ui::collect_responses(self.app.as_ref(), &p.prompt, p.placeholder.as_deref())
    }

    // ── tools_documentation ───────────────────────────────────────────────────

    #[tool(description = "Get detailed documentation and usage examples for a specific fredo MCP tool.")]
    async fn tools_documentation(
        &self,
        Parameters(p): Parameters<ToolsDocumentationParams>,
    ) -> Result<String, ErrorData> {
        use super::tools_doc;
        tools_doc::documentation(&p.tool_name)
    }

    // ── tool_search ───────────────────────────────────────────────────────────

    #[tool(description = "Search fredo MCP tools by natural-language description and discover relevant tools for a task.")]
    async fn tool_search(
        &self,
        Parameters(p): Parameters<ToolSearchParams>,
    ) -> Result<String, ErrorData> {
        use super::tools_doc;
        tools_doc::search(&p.query, p.limit.unwrap_or(5) as usize)
    }
}

// ── ServerHandler ─────────────────────────────────────────────────────────────

#[tool_handler(
    name = "fredo",
    version = "1.0.0",
    instructions = "Fredo MCP server — Kubernetes operations, Jira, Azure DevOps, Optimizely, \
                    observability queries, sandboxed code execution, and Fredo UI interactions."
)]
impl ServerHandler for FredoMcpServer {}
