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
pub(crate) struct KubectlNamespaceOpt {
    kubeconfig_path: Option<String>,
    /// Kubernetes namespace. Leave empty for all namespaces.
    namespace: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(crate) struct KubectlDescribePodParams {
    kubeconfig_path: Option<String>,
    namespace: Option<String>,
    /// Name of the pod to describe.
    pod_name: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(crate) struct KubectlLogsParams {
    kubeconfig_path: Option<String>,
    namespace: Option<String>,
    pod_name: String,
    /// Container name within the pod (optional if pod has one container).
    container: Option<String>,
    /// Maximum number of lines to return (default 100).
    tail_lines: Option<i64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(crate) struct KubectlExecParams {
    kubeconfig_path: Option<String>,
    namespace: Option<String>,
    pod_name: String,
    container: Option<String>,
    /// Shell command to execute, e.g. "ls /tmp".
    command: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(crate) struct KubectlDeletePodParams {
    kubeconfig_path: Option<String>,
    namespace: Option<String>,
    pod_name: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(crate) struct KubectlDeploymentParams {
    kubeconfig_path: Option<String>,
    namespace: Option<String>,
    /// Deployment name.
    deployment_name: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(crate) struct KubectlScaleParams {
    kubeconfig_path: Option<String>,
    namespace: Option<String>,
    deployment_name: String,
    /// Desired replica count.
    replicas: i32,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(crate) struct KubectlEventsParams {
    kubeconfig_path: Option<String>,
    namespace: Option<String>,
    /// Filter events by involved object name (pod / deployment name).
    object_name: Option<String>,
}

// ── Infrastructure diagram ────────────────────────────────────────────────────

#[derive(Debug, Deserialize, JsonSchema)]
pub(crate) struct InfrastructureParams {
    kubeconfig_path: Option<String>,
}

// ── Jira ──────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize, JsonSchema)]
pub(crate) struct JiraGetIssueParams {
    /// Jira issue key, e.g. "PROJ-123".
    issue_key: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(crate) struct JiraGetMyIssuesParams {
    /// Maximum number of issues to return (default 20).
    max_results: Option<u32>,
    /// JQL status filter, e.g. "To Do,In Progress".
    status: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(crate) struct JiraCreateIssueParams {
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
pub(crate) struct AzdoCreateWorkitemParams {
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
pub(crate) struct AzdoStartWorkitemParams {
    /// Numeric work item ID to move to "In Progress".
    work_item_id: u64,
}

// ── Optimizely ────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize, JsonSchema)]
pub(crate) struct OptimizelyGetFlagsParams {
    /// Optional environment name to filter by (e.g. "production").
    environment: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(crate) struct OptimizelyUpdateFlagParams {
    /// Feature flag key.
    flag_key: String,
    /// Environment name, e.g. "production".
    environment: String,
    /// Desired state: true = on, false = off.
    enabled: bool,
}

// ── Observability ─────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize, JsonSchema)]
pub(crate) struct LogsQueryParams {
    /// SQL SELECT query against the `application_logs` table.
    query: String,
    /// Statement timeout in milliseconds (default 10000).
    timeout_ms: Option<u32>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(crate) struct MetricsQueryParams {
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
pub(crate) struct TracesQueryParams {
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
pub(crate) struct CodeExecuteParams {
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
pub(crate) struct FredoUiAlertParams {
    /// Message to display.
    message: String,
    /// Severity: "info", "warning", "error", "success".
    level: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(crate) struct FredoUiStepperParams {
    /// Title of the multi-step wizard.
    title: String,
    /// Ordered list of step titles.
    steps: Vec<String>,
    /// Step index to highlight as current (0-based).
    current_step: Option<u32>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(crate) struct FredoUiCollectResponsesParams {
    /// Question or prompt to show the user.
    prompt: String,
    /// Placeholder text for the input field.
    placeholder: Option<String>,
}

// ── Tools documentation ───────────────────────────────────────────────────────

#[derive(Debug, Deserialize, JsonSchema)]
pub(crate) struct ToolsDocumentationParams {
    /// Exact tool name to retrieve documentation for.
    tool_name: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(crate) struct ToolSearchParams {
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ── internal() helper ──────────────────────────────────────────────────────

    #[test]
    fn internal_returns_internal_error() {
        let err = internal("test message");
        assert!(
            err.to_string().contains("test message"),
            "internal() should include the message in the error"
        );
    }

    #[test]
    fn internal_works_with_format_args() {
        let err = internal(format!("error code: {}", 42));
        assert!(
            err.to_string().contains("error code: 42"),
            "internal() should work with formatted strings"
        );
    }

    // ── KubectlNamespaceOpt (all optional) ────────────────────────────────────

    #[test]
    fn kubectl_namespace_opt_valid_full() {
        let p: KubectlNamespaceOpt = serde_json::from_value(json!({
            "kubeconfig_path": "/home/user/kube.yaml",
            "namespace": "prod"
        }))
        .unwrap();
        assert_eq!(p.kubeconfig_path.as_deref(), Some("/home/user/kube.yaml"));
        assert_eq!(p.namespace.as_deref(), Some("prod"));
    }

    #[test]
    fn kubectl_namespace_opt_empty_object() {
        let p: KubectlNamespaceOpt = serde_json::from_value(json!({})).unwrap();
        assert!(p.kubeconfig_path.is_none());
        assert!(p.namespace.is_none());
    }

    #[test]
    fn kubectl_namespace_opt_rejects_wrong_type() {
        let result: Result<KubectlNamespaceOpt, _> =
            serde_json::from_value(json!({ "kubeconfig_path": 123 }));
        assert!(result.is_err(), "string field should reject integer value");
    }

    // ── KubectlDescribePodParams (required: pod_name) ─────────────────────────

    #[test]
    fn kubectl_describe_pod_valid() {
        let p: KubectlDescribePodParams = serde_json::from_value(json!({
            "pod_name": "my-pod-xyz"
        }))
        .unwrap();
        assert_eq!(p.pod_name, "my-pod-xyz");
    }

    #[test]
    fn kubectl_describe_pod_missing_required() {
        let result: Result<KubectlDescribePodParams, _> =
            serde_json::from_value(json!({ "namespace": "default" }));
        assert!(result.is_err(), "missing required field 'pod_name' should fail");
    }

    #[test]
    fn kubectl_describe_pod_wrong_type() {
        let result: Result<KubectlDescribePodParams, _> =
            serde_json::from_value(json!({ "pod_name": 42 }));
        assert!(result.is_err(), "pod_name as integer should fail");
    }

    // ── KubectlLogsParams (required: pod_name) ────────────────────────────────

    #[test]
    fn kubectl_logs_valid() {
        let p: KubectlLogsParams = serde_json::from_value(json!({
            "pod_name": "my-pod",
            "tail_lines": 50
        }))
        .unwrap();
        assert_eq!(p.pod_name, "my-pod");
        assert_eq!(p.tail_lines, Some(50));
    }

    #[test]
    fn kubectl_logs_missing_required() {
        let result: Result<KubectlLogsParams, _> =
            serde_json::from_value(json!({ "tail_lines": 100 }));
        assert!(result.is_err(), "missing required field 'pod_name' should fail");
    }

    // ── KubectlExecParams (required: pod_name, command) ───────────────────────

    #[test]
    fn kubectl_exec_valid() {
        let p: KubectlExecParams = serde_json::from_value(json!({
            "pod_name": "my-pod",
            "command": "ls /tmp"
        }))
        .unwrap();
        assert_eq!(p.pod_name, "my-pod");
        assert_eq!(p.command, "ls /tmp");
    }

    #[test]
    fn kubectl_exec_missing_command() {
        let result: Result<KubectlExecParams, _> =
            serde_json::from_value(json!({ "pod_name": "my-pod" }));
        assert!(result.is_err(), "missing required field 'command' should fail");
    }

    // ── KubectlDeletePodParams (required: pod_name) ───────────────────────────

    #[test]
    fn kubectl_delete_pod_valid() {
        let p: KubectlDeletePodParams = serde_json::from_value(json!({
            "pod_name": "bad-pod"
        }))
        .unwrap();
        assert_eq!(p.pod_name, "bad-pod");
    }

    // ── KubectlDeploymentParams (required: deployment_name) ───────────────────

    #[test]
    fn kubectl_deployment_valid() {
        let p: KubectlDeploymentParams = serde_json::from_value(json!({
            "deployment_name": "my-app"
        }))
        .unwrap();
        assert_eq!(p.deployment_name, "my-app");
    }

    #[test]
    fn kubectl_deployment_missing_required() {
        let result: Result<KubectlDeploymentParams, _> =
            serde_json::from_value(json!({}));
        assert!(result.is_err(), "missing 'deployment_name' should fail");
    }

    // ── KubectlScaleParams (required: deployment_name, replicas) ──────────────

    #[test]
    fn kubectl_scale_valid() {
        let p: KubectlScaleParams = serde_json::from_value(json!({
            "deployment_name": "my-app",
            "replicas": 5
        }))
        .unwrap();
        assert_eq!(p.deployment_name, "my-app");
        assert_eq!(p.replicas, 5);
    }

    #[test]
    fn kubectl_scale_replicas_wrong_type() {
        let result: Result<KubectlScaleParams, _> =
            serde_json::from_value(json!({
                "deployment_name": "my-app",
                "replicas": "five"
            }));
        assert!(result.is_err(), "replicas as string should fail");
    }

    // ── KubectlEventsParams (all optional) ────────────────────────────────────

    #[test]
    fn kubectl_events_valid() {
        let p: KubectlEventsParams = serde_json::from_value(json!({
            "object_name": "my-pod"
        }))
        .unwrap();
        assert_eq!(p.object_name.as_deref(), Some("my-pod"));
    }

    #[test]
    fn kubectl_events_empty() {
        let p: KubectlEventsParams = serde_json::from_value(json!({})).unwrap();
        assert!(p.object_name.is_none());
    }

    // ── InfrastructureParams (all optional) ───────────────────────────────────

    #[test]
    fn infrastructure_params_empty() {
        let p: InfrastructureParams = serde_json::from_value(json!({})).unwrap();
        assert!(p.kubeconfig_path.is_none());
    }

    // ── JiraGetIssueParams (required: issue_key) ──────────────────────────────

    #[test]
    fn jira_get_issue_valid() {
        let p: JiraGetIssueParams = serde_json::from_value(json!({
            "issue_key": "PROJ-123"
        }))
        .unwrap();
        assert_eq!(p.issue_key, "PROJ-123");
    }

    #[test]
    fn jira_get_issue_missing_key() {
        let result: Result<JiraGetIssueParams, _> =
            serde_json::from_value(json!({}));
        assert!(result.is_err(), "missing 'issue_key' should fail");
    }

    // ── JiraGetMyIssuesParams (all optional) ──────────────────────────────────

    #[test]
    fn jira_get_my_issues_valid() {
        let p: JiraGetMyIssuesParams = serde_json::from_value(json!({
            "max_results": 10,
            "status": "In Progress"
        }))
        .unwrap();
        assert_eq!(p.max_results, Some(10));
        assert_eq!(p.status.as_deref(), Some("In Progress"));
    }

    #[test]
    fn jira_get_my_issues_empty() {
        let p: JiraGetMyIssuesParams = serde_json::from_value(json!({})).unwrap();
        assert!(p.max_results.is_none());
        assert!(p.status.is_none());
    }

    // ── JiraCreateIssueParams (required: project_key, summary) ────────────────

    #[test]
    fn jira_create_issue_valid() {
        let p: JiraCreateIssueParams = serde_json::from_value(json!({
            "project_key": "PROJ",
            "summary": "Fix login bug",
            "issue_type": "Bug",
            "priority": "High"
        }))
        .unwrap();
        assert_eq!(p.project_key, "PROJ");
        assert_eq!(p.summary, "Fix login bug");
        assert_eq!(p.issue_type.as_deref(), Some("Bug"));
    }

    #[test]
    fn jira_create_issue_missing_required() {
        let result: Result<JiraCreateIssueParams, _> =
            serde_json::from_value(json!({ "project_key": "PROJ" }));
        assert!(result.is_err(), "missing 'summary' should fail");
    }

    // ── AzdoCreateWorkitemParams (required: work_item_type, title) ────────────

    #[test]
    fn azdo_create_workitem_valid() {
        let p: AzdoCreateWorkitemParams = serde_json::from_value(json!({
            "work_item_type": "User Story",
            "title": "Add dark mode",
            "priority": 2
        }))
        .unwrap();
        assert_eq!(p.work_item_type, "User Story");
        assert_eq!(p.title, "Add dark mode");
        assert_eq!(p.priority, Some(2));
    }

    #[test]
    fn azdo_create_workitem_missing_title() {
        let result: Result<AzdoCreateWorkitemParams, _> =
            serde_json::from_value(json!({ "work_item_type": "Bug" }));
        assert!(result.is_err(), "missing 'title' should fail");
    }

    // ── AzdoStartWorkitemParams (required: work_item_id) ──────────────────────

    #[test]
    fn azdo_start_workitem_valid() {
        let p: AzdoStartWorkitemParams = serde_json::from_value(json!({
            "work_item_id": 12345
        }))
        .unwrap();
        assert_eq!(p.work_item_id, 12345);
    }

    #[test]
    fn azdo_start_workitem_wrong_type() {
        let result: Result<AzdoStartWorkitemParams, _> =
            serde_json::from_value(json!({ "work_item_id": "abc" }));
        assert!(result.is_err(), "work_item_id as string should fail");
    }

    // ── OptimizelyGetFlagsParams (all optional) ───────────────────────────────

    #[test]
    fn optimizely_get_flags_valid() {
        let p: OptimizelyGetFlagsParams = serde_json::from_value(json!({
            "environment": "production"
        }))
        .unwrap();
        assert_eq!(p.environment.as_deref(), Some("production"));
    }

    // ── OptimizelyUpdateFlagParams (required: flag_key, environment, enabled) ─

    #[test]
    fn optimizely_update_flag_valid() {
        let p: OptimizelyUpdateFlagParams = serde_json::from_value(json!({
            "flag_key": "new_checkout",
            "environment": "production",
            "enabled": true
        }))
        .unwrap();
        assert_eq!(p.flag_key, "new_checkout");
        assert_eq!(p.enabled, true);
    }

    #[test]
    fn optimizely_update_flag_missing_field() {
        let result: Result<OptimizelyUpdateFlagParams, _> =
            serde_json::from_value(json!({ "flag_key": "test", "enabled": true }));
        assert!(result.is_err(), "missing 'environment' should fail");
    }

    // ── LogsQueryParams (required: query) ─────────────────────────────────────

    #[test]
    fn logs_query_valid() {
        let p: LogsQueryParams = serde_json::from_value(json!({
            "query": "SELECT * FROM logs",
            "timeout_ms": 5000
        }))
        .unwrap();
        assert_eq!(p.query, "SELECT * FROM logs");
        assert_eq!(p.timeout_ms, Some(5000));
    }

    #[test]
    fn logs_query_missing_query() {
        let result: Result<LogsQueryParams, _> =
            serde_json::from_value(json!({ "timeout_ms": 5000 }));
        assert!(result.is_err(), "missing 'query' should fail");
    }

    // ── MetricsQueryParams (all optional) ─────────────────────────────────────

    #[test]
    fn metrics_query_valid() {
        let p: MetricsQueryParams = serde_json::from_value(json!({
            "metric_name": "http_requests",
            "limit": 100
        }))
        .unwrap();
        assert_eq!(p.metric_name.as_deref(), Some("http_requests"));
        assert_eq!(p.limit, Some(100));
    }

    // ── TracesQueryParams (all optional) ──────────────────────────────────────

    #[test]
    fn traces_query_valid() {
        let p: TracesQueryParams = serde_json::from_value(json!({
            "trace_id": "abc123",
            "status": "error",
            "min_duration_ms": 1000
        }))
        .unwrap();
        assert_eq!(p.trace_id.as_deref(), Some("abc123"));
        assert_eq!(p.status.as_deref(), Some("error"));
        assert_eq!(p.min_duration_ms, Some(1000));
    }

    // ── FredoUiAlertParams (required: message) ────────────────────────────────

    #[test]
    fn fredo_ui_alert_valid() {
        let p: FredoUiAlertParams = serde_json::from_value(json!({
            "message": "Deployment complete",
            "level": "success"
        }))
        .unwrap();
        assert_eq!(p.message, "Deployment complete");
        assert_eq!(p.level.as_deref(), Some("success"));
    }

    #[test]
    fn fredo_ui_alert_missing_message() {
        let result: Result<FredoUiAlertParams, _> =
            serde_json::from_value(json!({ "level": "info" }));
        assert!(result.is_err(), "missing 'message' should fail");
    }

    // ── FredoUiStepperParams (required: title, steps) ─────────────────────────

    #[test]
    fn fredo_ui_stepper_valid() {
        let p: FredoUiStepperParams = serde_json::from_value(json!({
            "title": "Setup Wizard",
            "steps": ["Step 1", "Step 2"],
            "current_step": 0
        }))
        .unwrap();
        assert_eq!(p.title, "Setup Wizard");
        assert_eq!(p.steps, vec!["Step 1", "Step 2"]);
        assert_eq!(p.current_step, Some(0));
    }

    #[test]
    fn fredo_ui_stepper_missing_steps() {
        let result: Result<FredoUiStepperParams, _> =
            serde_json::from_value(json!({ "title": "Wizard" }));
        assert!(result.is_err(), "missing 'steps' should fail");
    }

    #[test]
    fn fredo_ui_stepper_steps_wrong_type() {
        let result: Result<FredoUiStepperParams, _> =
            serde_json::from_value(json!({
                "title": "Wizard",
                "steps": "not an array"
            }));
        assert!(result.is_err(), "steps as string should fail");
    }

    // ── FredoUiCollectResponsesParams (required: prompt) ──────────────────────

    #[test]
    fn fredo_ui_collect_valid() {
        let p: FredoUiCollectResponsesParams = serde_json::from_value(json!({
            "prompt": "What is your name?",
            "placeholder": "Type here"
        }))
        .unwrap();
        assert_eq!(p.prompt, "What is your name?");
        assert_eq!(p.placeholder.as_deref(), Some("Type here"));
    }

    #[test]
    fn fredo_ui_collect_missing_prompt() {
        let result: Result<FredoUiCollectResponsesParams, _> =
            serde_json::from_value(json!({ "placeholder": "test" }));
        assert!(result.is_err(), "missing 'prompt' should fail");
    }

    // ── ToolsDocumentationParams (required: tool_name) ────────────────────────

    #[test]
    fn tools_documentation_valid() {
        let p: ToolsDocumentationParams = serde_json::from_value(json!({
            "tool_name": "kubectl_get_pods"
        }))
        .unwrap();
        assert_eq!(p.tool_name, "kubectl_get_pods");
    }

    #[test]
    fn tools_documentation_missing_tool_name() {
        let result: Result<ToolsDocumentationParams, _> =
            serde_json::from_value(json!({}));
        assert!(result.is_err(), "missing 'tool_name' should fail");
    }

    // ── ToolSearchParams (required: query) ────────────────────────────────────

    #[test]
    fn tool_search_valid() {
        let p: ToolSearchParams = serde_json::from_value(json!({
            "query": "list pods",
            "limit": 10
        }))
        .unwrap();
        assert_eq!(p.query, "list pods");
        assert_eq!(p.limit, Some(10));
    }

    #[test]
    fn tool_search_missing_query() {
        let result: Result<ToolSearchParams, _> =
            serde_json::from_value(json!({ "limit": 5 }));
        assert!(result.is_err(), "missing 'query' should fail");
    }

    // ── CodeExecuteParams (required: code, language) ─────────────────────────

    #[test]
    fn code_execute_params_valid() {
        let p: CodeExecuteParams = serde_json::from_value(json!({
            "code": "print('hello')",
            "language": "python",
            "libraries": ["numpy"],
            "timeout_ms": 30000,
            "session_id": "sess-1"
        }))
        .unwrap();
        assert_eq!(p.code, "print('hello')");
        assert_eq!(p.language, "python");
        assert_eq!(p.libraries, Some(vec!["numpy".to_string()]));
        assert_eq!(p.timeout_ms, Some(30000));
        assert_eq!(p.session_id, Some("sess-1".to_string()));
    }

    #[test]
    fn code_execute_params_minimal() {
        let p: CodeExecuteParams = serde_json::from_value(json!({
            "code": "print(1)",
            "language": "python"
        }))
        .unwrap();
        assert_eq!(p.code, "print(1)");
        assert_eq!(p.language, "python");
    }

    #[test]
    fn code_execute_params_missing_code() {
        let result: Result<CodeExecuteParams, _> =
            serde_json::from_value(json!({ "language": "python" }));
        assert!(result.is_err(), "missing 'code' should fail");
    }

    #[test]
    fn code_execute_params_missing_language() {
        let result: Result<CodeExecuteParams, _> =
            serde_json::from_value(json!({ "code": "print(1)" }));
        assert!(result.is_err(), "missing 'language' should fail");
    }

    // ── Extra fields are ignored (serde default: deny_unknown_fields is NOT set) ─

    #[test]
    fn extra_fields_are_ignored() {
        let p: KubectlNamespaceOpt = serde_json::from_value(json!({
            "namespace": "test",
            "unknown_field": "should be ignored"
        }))
        .unwrap();
        assert_eq!(p.namespace.as_deref(), Some("test"));
    }

    // ── Edge: integer in place of string for string fields ─────────────────────

    #[test]
    fn numeric_value_rejected_for_string_field() {
        let result: Result<ToolsDocumentationParams, _> =
            serde_json::from_value(json!({ "tool_name": 999 }));
        assert!(result.is_err(), "integer for string field should fail");
    }

    // ── Edge: null for required field ──────────────────────────────────────────

    #[test]
    fn null_for_required_field_fails() {
        let result: Result<JiraGetIssueParams, _> =
            serde_json::from_value(json!({ "issue_key": null }));
        assert!(result.is_err(), "null for required string field should fail");
    }

    // ── Edge: boolean for integer field ────────────────────────────────────────

    #[test]
    fn boolean_rejected_for_integer_field() {
        let result: Result<KubectlScaleParams, _> =
            serde_json::from_value(json!({
                "deployment_name": "my-app",
                "replicas": true
            }));
        assert!(result.is_err(), "boolean for i32 should fail");
    }
}
