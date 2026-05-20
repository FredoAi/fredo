# tool_search

## Description

Use `tool_search` to discover available tools when a capability is not visible in your current tool list. Most tools are **deferred** — they are not shown in the initial tool list to reduce context overhead. `tool_search` is the entry point to unlock them.

## When to Use

- You need a capability (e.g. "look at Kubernetes pods") but the tool isn't in your current list
- You want to browse what the platform can do across a domain (kubectl, jira, logs, etc.)
- You're about to write code in `code_execute` and need to know which tools are callable as functions

## Best Practice: One Call, All Domains

The query is scored **per-token** — a multi-word query returns tools from all matching domains at once. Always use a single broad query with `top_k: 20` rather than multiple calls:

```json
{
  "query": "kubectl logs metrics traces jira azdo code diagram",
  "top_k": 20
}
```

**Never call `tool_search` more than once per session.** All tools unlocked in the first call remain available for the rest of the session.

## Input Schema

```json
{
  "query": "kubectl pods",
  "top_k": 5
}
```

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | string | ✅ | Keyword(s) or short intent description |
| `top_k` | number | ❌ | Max results (default: 5, max: 20) |

## Scoring Algorithm

Results are ranked by weighted substring match:

| Field matched | Weight |
| --- | --- |
| `name` — contains token | ×3 |
| `name` — exact match | ×5 (bonus) |
| `description` — contains token | ×1 |
| `relatedTools` — contains token | ×0.5 |

Multi-word queries are split on whitespace; each token is scored independently.

## Response Shape

```json
{
  "results": [
    {
      "name": "kubectl_get_pods",
      "description": "Lists all pods...",
      "inputSchema": { "type": "object", "properties": { ... } },
      "inputExamples": [ ... ],
      "httpEndpoint": { "method": "GET", "path": "/api/kubectl/get-pods", ... },
      "relatedTools": ["kubectl_describe_pod", "kubectl_logs"],
      "deferLoading": true,
      "allowProgrammaticCalling": true,
      "_score": 8
    }
  ],
  "total": 1,
  "query": "kubectl pods"
}
```

Each result includes the **full tool schema** — you can call a returned tool immediately without fetching additional documentation.

## Side Effects

Every tool returned is **automatically unlocked** in the current MCP session. The tool will appear in subsequent `tools/list` responses, and can be called directly.

## Examples

### Find Kubernetes tools

```json
{ "query": "kubectl pods" }
```

### Find all observability tools

```json
{ "query": "logs metrics traces", "top_k": 10 }
```

### Find project management tools

```json
{ "query": "jira issue create" }
```

## Related Tools

- `tools_documentation` — get full verbose reference documentation (table schemas, extended examples) for a specific tool
