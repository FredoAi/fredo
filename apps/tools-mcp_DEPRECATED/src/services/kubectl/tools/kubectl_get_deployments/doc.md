# kubectl_get_deployments

List Kubernetes deployments with optional filtering.

## Input Schema
```json
{
  "namespace": "string (optional) - Namespace to list deployments from",
  "allNamespaces": "boolean (optional) - List deployments from all namespaces",
  "labelSelector": "string (optional) - Label selector",
  "fieldSelector": "string (optional) - Field selector",
  "limit": "number (optional) - Maximum number of deployments"
}
```

## Example
```json
{"namespace": "production", "labelSelector": "app=api-gateway"}
```

## Response
Returns deployment objects with replicas, update strategy, and status conditions.
