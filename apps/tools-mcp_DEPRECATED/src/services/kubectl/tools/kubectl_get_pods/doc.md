# kubectl_get_pods

List Kubernetes pods with optional filtering by namespace, labels, and field selectors.

## Input Schema

```json
{
  "namespace": "string (optional) - Namespace to list pods from",
  "allNamespaces": "boolean (optional) - List pods from all namespaces",
  "labelSelector": "string (optional) - Label selector (e.g., 'app=frontend,tier=web')",
  "fieldSelector": "string (optional) - Field selector (e.g., 'status.phase=Running')",
  "limit": "number (optional) - Maximum number of pods to return"
}
```

## Examples

List all pods in production namespace:
```json
{"namespace": "production"}
```

List running pods across all namespaces:
```json
{"allNamespaces": true, "fieldSelector": "status.phase=Running"}
```

List pods with specific label:
```json
{"namespace": "production", "labelSelector": "app=api-gateway"}
```

## Response

Returns a lightweight list of pods — enough to get exact names and spot unhealthy pods at a glance:
- `name`, `namespace`, `phase` (Running / Pending / Failed)
- `ready` — true if all containers are ready
- `restarts` — highest restart count across containers
- `statusReason` — present only when unhealthy (e.g. `CrashLoopBackOff`, `ImagePullBackOff`, `OOMKilled`)

For full pod details (conditions, events, resource limits, probes, lastState) use `kubectl_describe_pod`.
