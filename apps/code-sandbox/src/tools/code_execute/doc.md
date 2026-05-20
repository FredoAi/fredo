# code_execute

Execute code in an isolated sandbox container. Tool stubs for Atlas MCP tools are automatically injected so code running in the sandbox can call logs_query, kubectl_*, jira_*, etc. via a Unix socket bridge — with no network access to the outside world.

## Input Schema

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `code` | string | ✅ | — | Code to execute. Tool preamble is prepended automatically. |
| `language` | string | ✅ | — | One of: `python`, `javascript`, `typescript`, `go`, `java`, `r` |
| `libraries` | string[] | — | `[]` | Packages to install before execution (pip for Python, npm for JS) |
| `timeout_ms` | number | — | `30000` | Execution timeout in ms (min 1000, max 120000) |
| `enable_tools` | boolean | — | `true` | Whether to inject tool stubs into the preamble |

## Tool Bridge

When `enable_tools: true` (the default), tool stubs are injected before your code runs. The stubs connect to a Unix socket (`/var/run/Atlas/tools.sock`) mounted into the execution container.

### Python

```python
# These are auto-injected — just call them directly:
result = logs_query(query="SELECT ...", service_name="backend")
pods  = kubectl_get_pods(namespace="production")

# Or use the generic call_tool helper:
result = call_tool("logs_query", {"query": "SELECT ..."})
```

### JavaScript / TypeScript

```js
// Auto-injected camelCase wrappers:
const result = await logsQuery({ query: "SELECT ..." });
const pods   = await kubectlGetPods({ namespace: "production" });

// Or the generic helper:
const result = await callTool("logs_query", { query: "SELECT ..." });
```

### Go

```go
// Auto-injected generic helper:
result, err := callTool("logs_query", map[string]interface{}{"query": "SELECT ..."})
```

## Available Programmatic Tools

Tools with `allowProgrammaticCalling = true` get stubs injected:

- `kubectl_get_pods`, `kubectl_describe_pod`, `kubectl_logs`, `kubectl_get_events`
- `kubectl_get_deployments`, `kubectl_get_services`, `kubectl_scale_deployment`
- `kubectl_restart_deployment`, `kubectl_rollout_status`, `kubectl_top_pods`
- `kubectl_exec`, `kubectl_delete_pod`
- `logs_query`, `metrics_query`, `traces_query`
- `infrastructure_snapshot`, `infrastructure_stream`
- `jira_get_my_issues`, `jira_get_issue_details`, `jira_create_issue`
- `azdo_create_workitem`, `azdo_start_workitem`

Override the list via the `PROGRAMMATIC_TOOLS` environment variable (comma-separated tool names).

## Response

```json
{
  "success": true,
  "exit_code": 0,
  "stdout": "...",
  "stderr": "",
  "execution_time_ms": 342,
  "language": "python"
}
```

| Field | Type | Description |
|---|---|---|
| `success` | boolean | `true` when `exit_code === 0` |
| `exit_code` | number | Process exit code |
| `stdout` | string | Standard output |
| `stderr` | string | Standard error (warnings, tracebacks) |
| `execution_time_ms` | number | Wall-clock time inside the container |
| `language` | string | Language that was executed |

## Examples

### Compute error rate from logs

```json
{
  "language": "python",
  "code": "import json\nresult = logs_query(query=\"SELECT service_name, COUNT(*) as errors FROM application_logs WHERE level='ERROR' AND timestamp > NOW() - INTERVAL '1 hour' GROUP BY service_name ORDER BY errors DESC\")\nfor row in (result.get('rows') or []):\n    print(f\"{row['service_name']}: {row['errors']}\")"
}
```

### Aggregate metrics with pandas

```json
{
  "language": "python",
  "libraries": ["pandas"],
  "code": "import pandas as pd, json\nresult = metrics_query(query=\"rate(http_requests_total[5m])\", time_range=\"1h\")\ndf = pd.DataFrame(result.get('data', []))\nprint(df.describe())"
}
```

### Quick JS one-liner

```json
{
  "language": "javascript",
  "code": "console.log('hello from sandbox');"
}
```

## Security Notes

- Execution containers run with `network: none` — no internet access
- The Unix socket is the only outbound channel (tool bridge)
- Docker-in-Docker: the container that runs your code is spawned by `llm-sandbox` using the host Docker socket
- `timeout_ms` enforces a hard wall-clock limit; the container is force-killed after expiry

## Related Tools

- `tool_search` — discover available tools before writing code that calls them
- `tools_documentation` — get detailed docs for a specific tool before calling it from code
- `logs_query` — available directly from tools-mcp; use `code_execute` only when you need computation
