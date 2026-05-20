# kubectl_rollout_status

Check deployment rollout status including replica counts and conditions.

## Input Schema
```json
{
  "namespace": "string (required) - Namespace",
  "name": "string (required) - Deployment name",
  "resourceType": "string (optional) - 'deployment', 'statefulset', or 'daemonset'"
}
```

## Example
```json
{"namespace": "production", "name": "api-gateway"}
```

## Response
Returns rollout status with desired, current, updated, available, and unavailable replica counts plus deployment conditions.
