# kubectl_logs

Get logs from a pod container with options for tail, timestamps, and previous container logs.

## Input Schema
```json
{
  "namespace": "string (required) - Kubernetes namespace",
  "name": "string (required) - Pod name",
  "container": "string (optional) - Container name",
  "previous": "boolean (optional) - Get logs from crashed container",
  "tailLines": "number (optional) - Number of lines from end",
  "timestamps": "boolean (optional) - Include timestamps",
  "sinceSeconds": "number (optional) - Logs newer than N seconds"
}
```

## Examples
```json
{"namespace": "production", "name": "api-gateway-7d9f8b5c-xk4p2", "tailLines": 100}
```

```json
{"namespace": "production", "name": "crashed-pod", "previous": true}
```

## Response
Returns log output as string.
