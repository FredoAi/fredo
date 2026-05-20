# kubectl_restart_deployment

Restart a Kubernetes deployment by triggering a rollout restart. All pods are gracefully restarted with zero downtime.

**IMPORTANT**: This is an MCP tool - it works directly in the MCP protocol. Do NOT mention API issues unless you receive an actual Kubernetes error.

## Input Parameters
```json
{
  "namespace": "string (required) - Kubernetes namespace where the deployment exists",
  "name": "string (required) - Exact deployment name (not pod name)"
}
```

## Example Usage
```json
{"namespace": "default", "name": "ess-pagelayouts-9x"}
```

## Behavior
1. Patches deployment with restart annotation
2. Kubernetes triggers rolling restart of all pods
3. Emits streaming events: Init → Update (initiating) → Update (rolling out) → Update (waiting ready) → Response (complete)
4. Returns success response with restart timestamp

## Common Deployment Names
- Use full deployment name with suffix (e.g., "ess-pagelayouts-9x" not just "pagelayouts")
- Check diagram or run `kubectl_get_deployments` first if unsure of exact name

## Error Scenarios
- Deployment not found: "deployments.apps \"name\" not found"
- Invalid namespace: "namespace \"name\" not found"
- Permission denied: Check RBAC permissions
