# Atlas_ui_stepper

Display a multi-step workflow tracker in the browser extension sidebar.

**Call once** with all steps declared upfront. The extension auto-drives step statuses by listening to other tool events — no follow-up calls needed.

## How It Works

Each step can declare a `triggerEvent` (a tool name). When that tool fires:
- `Init` event → step becomes **Running**
- `Response` event → step becomes **Completed**
- `Error` event → step becomes **Error**

Steps without `triggerEvent` are static (stay at their initial status).

## Input Schema

```json
{
  "steps": [
    {
      "title": "string (required)",
      "description": "string (optional)",
      "status": "Waiting | Running | Completed | Error",
      "needsPermit": "boolean (optional)",
      "triggerEvent": "string — tool name that drives this step (optional)"
    }
  ]
}
```

## Examples

### Event-driven (recommended)
```json
{
  "steps": [
    { "title": "Query pod logs",       "status": "Waiting", "triggerEvent": "kubectl_logs" },
    { "title": "Analyze errors",       "status": "Waiting", "triggerEvent": "code_execute" },
    { "title": "Create incident",      "status": "Waiting", "triggerEvent": "jira_create_issue" }
  ]
}
```

### Static display
```json
{
  "steps": [
    { "title": "Analyze codebase",   "status": "Waiting" },
    { "title": "Generate report",    "status": "Waiting" },
    { "title": "Send notification",  "status": "Waiting" }
  ]
}
```

## Response

Publishes a single `Init` event to Redis Streams. Extension receives it via SSE and renders the stepper.
