# code_execute

Execute a code snippet in an isolated sandbox container and return the output.

## Key Rule: One Script for Everything

**Never call `code_execute` more than once in a row.** When you need data from multiple tools, call them all inside a single script. Tool stubs are already in scope — call them as plain functions, collect all results, and print the final output in one execution.

```python
# ✅ CORRECT — one script, multiple tools
pods   = kubectl_get_pods(allNamespaces=True)
logs   = logs_query(query="SELECT service_name, COUNT(*) as errors FROM application_logs WHERE timestamp >= (SELECT MAX(timestamp) FROM application_logs) - INTERVAL '1 hour' GROUP BY service_name LIMIT 20")
metrics = metrics_query(query="SELECT name, value FROM metrics WHERE timestamp >= (SELECT MAX(timestamp) FROM metrics) - INTERVAL '1 hour' ORDER BY timestamp DESC LIMIT 5")
# ... process and print combined results
```

```python
# ❌ WRONG — three separate code_execute calls
pods = kubectl_get_pods()        # call 1
logs = logs_query(...)           # call 2 — never do this
metrics = metrics_query(...)     # call 3 — never do this
```

## Use cases

- Compute derived metrics from raw Kubernetes/observability data (error rates, P95 latency, pod restart trends)
- Aggregate and cross-join data from multiple tool calls
- Run ad-hoc data transformations without pre-built tool support
- Prototype scripts and validate logic before committing to production

## Parameters

| Name | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `code` | string | ✅ | — | Source code to execute |
| `language` | `"python"` \| `"javascript"` | ✅ | — | Runtime to use |
| `libraries` | string[] | ❌ | `[]` | Packages to install before execution (pip / npm) |
| `timeout_ms` | number | ❌ | `30000` | Maximum execution time in milliseconds |

## Behaviour

- Code runs inside an **ephemeral Docker container** with **no network access** (air-gapped from the host).
- Each call is independent: no state or filesystem is shared between calls.
- The sandbox container is provisioned by the `code-sandbox` sidecar service (`http://code-sandbox:8080`) and torn down immediately after execution.
- `stdout` / `stderr` are captured and returned verbatim.

## Response

```json
{
  "success": true,
  "exit_code": 0,
  "stdout": "0.0234\n",
  "stderr": "",
  "execution_time_ms": 412,
  "language": "python"
}
```

## Example — error rate from log counts

```python
errors = 42
total  = 1800
rate   = errors / total
print(f"{rate:.4f}")
```

## Example — aggregate pod restarts

```javascript
const pods = [
  { name: "api-7d9f", restarts: 3 },
  { name: "worker-2c1a", restarts: 7 },
  { name: "scheduler-5e3b", restarts: 0 },
];
const total = pods.reduce((s, p) => s + p.restarts, 0);
console.log(`Total restarts: ${total}`);
```
