# kubectl_top_pods

Get pod resource usage metrics (CPU and memory). Requires metrics-server in cluster.

## Input Schema
```json
{
  "namespace": "string (optional) - Namespace",
  "allNamespaces": "boolean (optional) - All namespaces",
  "labelSelector": "string (optional) - Label selector"
}
```

## Example
```json
{"namespace": "production", "labelSelector": "app=api-gateway"}
```

## Response
Returns CPU and memory usage per pod and per container.
