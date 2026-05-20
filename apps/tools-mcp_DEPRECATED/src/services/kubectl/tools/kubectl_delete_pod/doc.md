# kubectl_delete_pod

Delete a pod. If managed by a Deployment/ReplicaSet, a new pod will be automatically created.

## Input Schema
```json
{
  "namespace": "string (required) - Namespace",
  "name": "string (required) - Pod name",
  "gracePeriodSeconds": "number (optional) - Grace period (default: 0)"
}
```

## Example
```json
{"namespace": "production", "name": "api-gateway-7d9f8b5c-xk4p2"}
```

## Response
Emits Update events during deletion process, then confirms deletion. New pod creation is automatic if managed by a controller.
