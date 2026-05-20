# Agent Playbooks — Runtime Reference

> **This document is Layer 3 of the agent prompt architecture.**
> It contains operational playbooks, SQL templates, workflow examples, and troubleshooting guides.
> This content is NOT in the system prompt — it exists as external documentation the agent can reference via `tools_documentation` or that operators can consult directly.

---

## Table of Contents

- [Workflow Patterns](#workflow-patterns)
  - [Stepper Pattern](#stepper-pattern)
  - [Query + Analysis Pattern](#query--analysis-pattern)
  - [Kubectl Operations Pattern](#kubectl-operations-pattern)
  - [Incident Response Pattern](#incident-response-pattern)
- [SQL Templates](#sql-templates)
  - [PostgreSQL Reference](#postgresql-reference)
  - [Common Queries](#common-queries)
- [Troubleshooting](#troubleshooting)
- [Examples](#examples)

---

## Workflow Patterns

### Stepper Pattern

Use `Atlas_ui_stepper` for structured workflows with 3+ steps (runbooks, SOPs, incident response).

**State machine:** Init → Update (step N) → ... → Complete

```
Atlas_ui_stepper({action: "init", steps: [
  {title: "Step 1", status: "running"},
  {title: "Step 2", status: "waiting"},
  {title: "Step 3", status: "waiting"}
]})

// Execute step 1...

Atlas_ui_stepper({action: "update", currentStep: 1, message: "Result summary", steps: [
  {title: "Step 1", status: "completed"},
  {title: "Step 2", status: "running"},
  {title: "Step 3", status: "waiting"}
]})

// Execute step 2...
// ...

Atlas_ui_stepper({action: "complete"})
```

**Step status values:** `"waiting"`, `"running"`, `"completed"`, `"failed"`

### Query + Analysis Pattern

For log/metric investigation:

1. Define time range and filters
2. Start broad (`LIMIT 20`), narrow incrementally
3. Correlate across logs → metrics → traces
4. Identify patterns before acting

### Kubectl Operations Pattern

**Abstract pattern:** List → Extract Exact Name → Operate → Verify

| Step    | Purpose                                 |
|---------|-----------------------------------------|
| List    | Get all resources, find exact names     |
| Extract | Use the exact name from list results    |
| Operate | Restart, delete, scale, describe, logs  |
| Verify  | Check the operation took effect         |

**Diagram auto-focus:** Kubectl mutation operations automatically trigger diagram node focus in the browser extension. No agent action needed.

### Incident Response Pattern

**Abstract sequence:**

1. Assess impact — `kubectl_get_pods` + `kubectl_get_events`
2. Identify root cause — `kubectl_logs` + `logs_query` + `metrics_query`
3. Apply fix — `kubectl_restart_deployment` / `kubectl_scale_deployment`
4. Verify resolution — `kubectl_get_pods` + `logs_query` (check errors stopped)
5. Document — `azdo_create_workitem`

Use stepper to track progress visually. Use parallel calls where steps are independent.

---

## SQL Templates

### PostgreSQL Reference

| SQLite (WRONG)                         | PostgreSQL (CORRECT)                        |
|----------------------------------------|---------------------------------------------|
| `datetime('now', '-1 hour')`           | `NOW() - INTERVAL '1 hour'`                |
| `LIKE '%x%' COLLATE NOCASE`           | `ILIKE '%x%'`                              |
| `strftime('%Y-%m', timestamp)`         | `DATE_TRUNC('month', timestamp)`           |

**Interval examples:** `'1 hour'`, `'30 minutes'`, `'24 hours'`, `'7 days'`

### Common Queries

**Recent errors:**
```sql
SELECT timestamp, level, logger, message
FROM application_logs
WHERE timestamp >= NOW() - INTERVAL '1 hour'
  AND level = 'ERROR'
ORDER BY timestamp DESC
LIMIT 20
```

**Error count by logger:**
```sql
SELECT logger, COUNT(*) as error_count
FROM application_logs
WHERE timestamp >= NOW() - INTERVAL '1 hour'
  AND level = 'ERROR'
GROUP BY logger
ORDER BY error_count DESC
LIMIT 20
```

**Metrics aggregation:**
```sql
SELECT name, AVG(value) as avg_val, MAX(value) as max_val
FROM metrics
WHERE timestamp >= NOW() - INTERVAL '1 hour'
  AND name ILIKE '%service_name%'
GROUP BY name
ORDER BY max_val DESC
LIMIT 20
```

**Slow traces (> 1 second):**
```sql
SELECT trace_id, operation_name, duration / 1000 as duration_ms, start_time
FROM traces
WHERE start_time >= NOW() - INTERVAL '1 hour'
  AND duration > 1000000
ORDER BY duration DESC
LIMIT 20
```

**Data existence check:**
```sql
SELECT COUNT(*) FROM application_logs
WHERE timestamp >= NOW() - INTERVAL '24 hours'
```

---

## Troubleshooting

### UI Not Showing Updates

| Check | Fix |
|-------|-----|
| Session active? | Session is auto-created on first MCP tool call |
| Wrong connectionId? | connectionId is auto-assigned per MCP session |

### Kubectl Command Fails

| Symptom | Cause | Fix |
|---------|-------|-----|
| `"deployment 'xyz' not found"` | Partial name used | Call list tool first, use exact name |
| `"pod 'abc' not found"` | Pod name guessed | `kubectl_get_pods` → extract exact name |
| No output | Wrong namespace | Verify namespace parameter |

### Query Returns No Results

1. Expand time range (1h → 24h)
2. Verify table name (`application_logs`, `metrics`, `traces`)
3. Remove restrictive filters, add back incrementally
4. Run `SELECT COUNT(*)` to confirm data exists

### PostgreSQL Syntax Error

| Error | Cause | Fix |
|-------|-------|-----|
| `function datetime() does not exist` | SQLite syntax | Use `NOW() - INTERVAL '1 hour'` |
| `syntax error near COLLATE` | SQLite syntax | Use `ILIKE` for case-insensitive |
| Query timeout | Missing LIMIT | Add `LIMIT 20` (max 1000) |

---

## Examples

### Kubectl Name Resolution

User says "restart pagelayouts":

1. `kubectl_get_deployments()` → finds `ess-pagelayouts-9x`
2. `kubectl_restart_deployment({name: "ess-pagelayouts-9x"})` → success

### Alert Fire-and-Forget

1. `Atlas_ui_alert({type: "warning", message: "Delete pod?", actions: [{label: "Confirm", value: "confirmed"}]})`
2. Continue other work (don't wait)
3. Response appears in `pendingUIResponses` of next tool result
4. If confirmed → proceed with `kubectl_delete_pod`

### Azure DevOps Priority

| User says | Priority value |
|-----------|---------------|
| "Production is down!" | 1 (Critical) |
| "Major feature broken" | 2 (High) |
| "Minor bug" | 3 (Medium) |
| "Nice to have" | 4 (Low) |

---

## Prompt Architecture — 3-Layer Model

| Layer | Location | Purpose |
|-------|----------|---------|
| **1 — System Prompt** | `Agent-prompt.md` | Identity, blocking constraints, tool philosophy, communication rules |
| **2 — Tool Descriptions** | `*Tool.ts` (25 files) | WHEN triggers, scope boundaries, required sequences, what tool does NOT do |
| **3 — Runtime Playbooks** | This document | Workflows, SQL templates, troubleshooting, examples |

System prompt is short and high-authority. Tool descriptions guide tool-calling behavior at decision time. Playbooks provide reference material for complex operations.
