# Atlas Tools-MCP: Services Overview

**Last Updated**: February 18, 2026
**Total Services**: 11
**Total Tools**: 25 (20 mcp-only, 4 both, 1 api-only)

---

## 📊 Quick Statistics

- **MCP-Only Tools**: 20 (80%) - Primary AI agent interface
- **Both MCP + HTTP**: 4 (16%) - Query tools with REST fallback
- **API-Only**: 1 (4%) - SSE streaming

**PostgreSQL Services**: 7 (logs-query, metrics-query, traces-query, infrastructure-diagram, kubectl, tools-documentation, log-ingestion)
**External APIs**: 2 (Azure DevOps REST, Kubernetes API Client)

---

## 1. alerts

**Purpose**: User alerts and confirmations in browser extension

| Tool | exposedAs | Description |
|------|-----------|-------------|
| `Atlas_ui_alert` | mcp | Send alerts/messages to browser extension with optional user confirmation |

**Dependencies**: Redis Streams (publishing)

---

## 2. azdo-workitems

**Purpose**: Azure DevOps work item viewing and creation with UI integration

| Tool | exposedAs | Description |
|------|-----------|-------------|
| `azdo_create_workitem` | mcp | Create Azure DevOps work items with AI-assisted form pre-population |
| `azdo_start_workitem` | mcp | View and open Azure DevOps work items in browser extension modal |

**Dependencies**: Azure DevOps REST API, Redis Streams

---

## 3. infrastructure-diagram

**Purpose**: Real-time Kubernetes infrastructure graph with resource watcher

| Tool | exposedAs | Description |
|------|-----------|-------------|
| `infrastructure_snapshot` | both | Get current K8s infrastructure graph snapshot |
| `infrastructure_stream` | api | Subscribe to real-time K8s resource updates via SSE |

**Dependencies**: Kubernetes API Client, PostgreSQL (graph storage), K8s Resource Watcher

**Routes**:
- `GET /api/v1/infrastructure-diagram/snapshot`
- `GET /api/v1/infrastructure-diagram/stream`

---

## 4. k8s-diagram

**Purpose**: Static Kubernetes visualization with mock data for demos

| Tool | exposedAs | Description |
|------|-----------|-------------|
| `k8s_diagram` | both | Generate K8s architecture diagram with mock services and relationships |

**Dependencies**: None (self-contained mock data)

**Routes**:
- `POST /api/v1/k8s-diagram/generate`

---

## 5. kubectl

**Purpose**: Full Kubernetes operations via K8s API client (12 tools)

### Pod Operations (5 tools)
| Tool | Description |
|------|-------------|
| `kubectl_get_pods` | List pods with status, resource usage, and filtering |
| `kubectl_describe_pod` | Get detailed pod information including events and conditions |
| `kubectl_logs` | Fetch container logs with follow and tail options |
| `kubectl_exec` | Execute commands inside running containers |
| `kubectl_delete_pod` | Delete pods (triggers recreation if part of deployment) |
| `kubectl_top_pods` | Get real-time CPU and memory usage for pods |

### Deployment Operations (3 tools)
| Tool | Description |
|------|-------------|
| `kubectl_get_deployments` | List deployments with replica counts and status |
| `kubectl_restart_deployment` | Trigger rolling restart of deployment pods |
| `kubectl_scale_deployment` | Scale deployment replicas up or down |
| `kubectl_rollout_status` | Check rollout/update progress for deployments |

### Cluster Resources (2 tools)
| Tool | Description |
|------|-------------|
| `kubectl_get_services` | List Kubernetes services with endpoints and ports |
| `kubectl_get_events` | Get cluster events for debugging and monitoring |

**All kubectl tools**: `exposedAs: 'mcp'`
**Dependencies**: Kubernetes API Client (@kubernetes/client-node), PostgreSQL (command history)

**Routes**:
- `GET /api/v1/kubectl/history` (command execution history)

---

## 6. log-ingestion

**Purpose**: OTLP log batch ingestion endpoint

**Tools**: None (routes only)

**Dependencies**: PostgreSQL

**Routes**:
- `POST /v1/logs` (OTLP compatible batch ingestion)

---

## 7. logs-query

**Purpose**: Query application logs with filtering, time ranges, and pagination

| Tool | exposedAs | Description |
|------|-----------|-------------|
| `logs_query` | both | Query logs with text search, time ranges, severity filtering, pagination |

**Dependencies**: PostgreSQL

**Routes**:
- `POST /api/v1/logs-query`

---

## 8. metrics-query

**Purpose**: Query Prometheus-style metrics (counters, gauges, histograms)

| Tool | exposedAs | Description |
|------|-----------|-------------|
| `metrics_query` | both | Query metrics with name filtering, aggregation, time ranges |

**Dependencies**: PostgreSQL

**Routes**:
- `POST /api/v1/metrics-query`

---

## 9. Atlas-ui

**Purpose**: Frontend UI integration with SSE streaming and session management

| Tool | exposedAs | Description |
|------|-----------|-------------|
| `Atlas_ui_stepper` | mcp | Display step-by-step workflow with real-time updates |
| `Atlas_ui_collect_responses` | mcp | Collect and flush all pending UI responses (user interactions) |

**Dependencies**: Redis Streams (pub/sub), SessionManager (SSE)

**Routes**:
- `GET /api/v1/Atlas-ui/stream/:connectionId` (SSE streaming)
- `POST /api/v1/Atlas-ui/response` (browser extension → backend)
- `POST /api/v1/Atlas-ui/internal/broadcast` (cross-process events)

**Key Features**:
- Session lifecycle management
- SSE connection with 30s heartbeat
- Redis Streams for real-time events
- Response queue with 5min TTL

---

## 10. tools-documentation

**Purpose**: Self-documenting tool metadata access

| Tool | exposedAs | Description |
|------|-----------|-------------|
| `tools_documentation` | mcp | Get comprehensive tool documentation from doc.md files |

**Dependencies**: PostgreSQL (tool metadata cache)

**Routes**:
- `GET /api/v1/tools-documentation`

---

## 11. traces-query

**Purpose**: Query distributed traces with span filtering and trace ID lookup

| Tool | exposedAs | Description |
|------|-----------|-------------|
| `traces_query` | both | Query traces with ID lookup, span filtering, time ranges |

**Dependencies**: PostgreSQL

**Routes**:
- `POST /api/v1/traces-query`

---

## Tool Naming Conventions

- **Tool name** (`tool.name`): `snake_case` (e.g., `logs_query`, `kubectl_get_pods`)
- **Folder name**: Matches `tool.name` exactly (e.g., `tools/logs_query/`)
- **File name**: PascalCase + `Tool.ts` suffix (e.g., `LogsQueryTool.ts`)
- **Documentation**: `doc.md` in tool folder (REQUIRED, validates at startup)

---

## Service Structure Pattern

```
services/{service-name}/
├── model.ts          # TypeScript interfaces
├── repository.ts     # Data access layer
├── service.ts        # Business logic (extends BaseService)
├── controller.ts     # Request handling
├── routes.ts         # Route definitions (extends BaseRoutes)
└── tools/            # Nested tool folders
    └──{tool_name}/
        ├── {Tool}Tool.ts
        └── doc.md    # REQUIRED
```

---

## Documentation References

- **Tool Structure Guide**: [TOOL_STRUCTURE_GUIDE.md](./TOOL_STRUCTURE_GUIDE.md) - Nested folder requirements and validation
- **AI Usage Guide**: [AI_USAGE_GUIDE.md](./AI_USAGE_GUIDE.md) - Best practices for kubectl tools
- **Architecture Overview**: [../ARCHITECTURE.md](../ARCHITECTURE.md) - System design and patterns
- **API Specification**: [API_SPEC.md](./API_SPEC.md) - REST and MCP endpoints
