# kubectl_scale_deployment

Scale a deployment to the specified number of replicas.

## Input Schema
```json
{
  "namespace": "string (required) - Namespace",
  "name": "string (required) - Deployment name",
  "replicas": "number (required) - Desired replica count"
}
```

## Example
```json
{"namespace": "production", "name": "api-gateway", "replicas": 5}
```

## Response
Emits Update events during scaling: scaling → updating replicas → stable. Returns current and desired replica counts.
