# kubectl_get_events

Get Kubernetes cluster events for debugging and monitoring.

## Input Schema
```json
{
  "namespace": "string (optional) - Namespace",
  "allNamespaces": "boolean (optional) - All namespaces",
  "involvedObjectName": "string (optional) - Filter by object name",
  "involvedObjectKind": "string (optional) - Filter by kind (Pod, Deployment)",
  "eventType": "string (optional) - 'Normal' or 'Warning'",
  "limit": "number (optional) - Max events"
}
```

## Example
```json
{"namespace": "production", "eventType": "Warning", "limit": 50}
```

## Response
Returns event objects with timestamps, reasons, messages, and involved objects.
