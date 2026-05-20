# kubectl_describe_pod

Get detailed information about a specific pod including events, conditions, volumes, and container statuses.

## Input Schema
```json
{
  "namespace": "string (required) - Kubernetes namespace",
  "name": "string (required) - Pod name"
}
```

## Example
```json
{"namespace": "production", "name": "api-gateway-7d9f8b5c-xk4p2"}
```

## Response
Returns pod object with full metadata, spec, status, plus recent events related to the pod.
