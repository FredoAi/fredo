# AI Agent Usage Guide for Fredo kubectl Tools

## Critical Rules for AI Agents

### 1. **NEVER mention "API issues" unless you receive an actual Kubernetes error**
- These are MCP tools, not REST API endpoints
- If a tool call succeeds (even with `success: false`), that's NOT an API issue
- Only report Kubernetes errors (e.g., "deployment not found", "permission denied")

### 2. **Always use EXACT deployment/pod names**
- Deployment names often have prefixes and suffixes (e.g., "ess-pagelayouts-9x" not "pagelayouts")
- Pod names have generated suffixes (e.g., "assure-xyz-abc123" not "assure")

### 3. **Check names first before operations**
When user says "restart pagelayouts":
```
❌ DON'T: Immediately call kubectl_restart_deployment with {"namespace": "default", "name": "pagelayouts"}
✅ DO: First call kubectl_get_deployments to find exact name, THEN restart
```

## Workflow for Deployment Operations

### Option A: List deployments first (RECOMMENDED)
```
1. User: "restart pagelayouts"
2. AI calls: kubectl_get_deployments({"namespace": "default"})
3. AI finds: "ess-pagelayouts-9x"
4. AI calls: kubectl_restart_deployment({"namespace": "default", "name": "ess-pagelayouts-9x"})
```

### Option B: Use diagram context (if available)
```
1. User views diagram, sees deployment "ess-pagelayouts-9x"
2. User right-clicks and selects "Restart deployment"
3. AI receives full context with exact name
4. AI calls: kubectl_restart_deployment with exact name
```

## Common Error Patterns

### "Deployment not found" Error
**Error message**: `deployments.apps "pagelayouts" not found`

**What happened**: 
- You used partial name "pagelayouts"
- Actual deployment is "ess-pagelayouts-9x"

**What to do**:
1. Call `kubectl_get_deployments` to find exact name
2. Retry with correct name
3. Tell user: "I found the deployment named 'ess-pagelayouts-9x'. Restarting now..."

### "Namespace not found" Error
**Error message**: `namespace "production" not found`

**What happened**: 
- Namespace doesn't exist or wrong name

**What to do**:
1. Ask user for correct namespace
2. Suggest: "default", "kube-system", or list namespaces

## Response Format Interpretation

### Success Response
```json
{
  "success": true,
  "message": "Deployment ess-pagelayouts-9x restart initiated",
  "restartedAt": "2025-01-15T10:30:00Z"
}
```
**AI should say**: "Deployment restarted successfully" (NOT "API issue")

### Kubernetes Error Response
```json
{
  "success": false,
  "error": {
    "message": "deployments.apps \"pagelayouts\" not found",
    "code": "404",
    "statusCode": 404
  }
}
```
**AI should say**: "The deployment 'pagelayouts' was not found. Let me check available deployments..." (NOT "API issue")

## Best Practices

### 1. Be proactive about name resolution
```
❌ "There's an API issue - the deployment wasn't found"
✅ "Let me find the exact deployment name first..."
```

### 2. Use streaming events for feedback
```
User sees in diagram:
- 🔵 Init - just now
- 🟡 Update - initiating restart
- 🟡 Update - rolling out
- 🟢 Response - complete

AI should: Wait for Response event before confirming success
```

### 3. Handle partial names intelligently
```
User: "restart pagelayouts"
AI: "Looking for deployments matching 'pagelayouts'..."
AI calls: kubectl_get_deployments({"namespace": "default"})
AI finds: "ess-pagelayouts-9x"
AI: "Found deployment 'ess-pagelayouts-9x'. Restarting now..."
AI calls: kubectl_restart_deployment({"namespace": "default", "name": "ess-pagelayouts-9x"})
```

## Tool-Specific Notes

### kubectl_restart_deployment
- **Input**: Exact deployment name (not pod name)
- **Common mistake**: Using pod name instead of deployment name
- **Check**: Run `kubectl_get_deployments` first if unsure

### kubectl_delete_pod
- **Input**: Exact pod name (full name with suffix)
- **Behavior**: Pod will be recreated if managed by deployment
- **Use case**: Force restart of specific pod

### kubectl_logs
- **Input**: Exact pod name
- **Common mistake**: Using deployment name instead of pod name
- **Check**: Run `kubectl_get_pods` to find pod name

### kubectl_exec
- **Input**: Exact pod name + command array
- **Commands**: Must be array format: `["sh", "-c", "ls -la"]`
- **Container**: Optional - defaults to first container

## Debugging Tips

### When user reports "it didn't work"
1. Check browser console logs for:
   - `[DiagramFeature] Received event: kubectl_restart_deployment Init`
   - `[DiagramFeature] ✅ Focus target set`
   - `[ArchitectureDiagram] Auto-focusing on default/ess-pagelayouts-9x`
   - `[ArchitectureDiagram] Searching for node`

2. If no focus event:
   - Event might not have reached browser
   - Check SSE connection
   - Check if diagram is in grid

3. If "Node not found":
   - Check available nodes in console
   - Deployment name mismatch (exact vs fuzzy)
   - Node might be hidden by filters

### When deployment restart succeeds but diagram doesn't focus
1. Check logs show exact name used in kubectl call
2. Check diagram node labels match that name
3. Fuzzy matching should help with variations
4. Console will show: `Available nodes: default/ess-pagelayouts-9x, default/assure-abc123, ...`

## Summary

**Golden Rule**: Always verify exact resource names before kubectl operations. When in doubt, list resources first.

**Error Messages**: Report actual Kubernetes errors, not "API issues". These tools work correctly - errors are usually name mismatches.

**User Experience**: Proactive name resolution + streaming events = smooth experience. User sees diagram auto-focus + timeline updates + success message.
