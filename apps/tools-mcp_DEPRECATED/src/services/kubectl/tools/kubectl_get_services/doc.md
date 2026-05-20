# kubectl_get_services

List Kubernetes services with cluster IP, ports, and selectors.

## Input Schema
```json
{
  "namespace": "string (optional) - Namespace",
  "allNamespaces": "boolean (optional) - All namespaces",
  "labelSelector": "string (optional) - Label selector",
  "limit": "number (optional) - Max services"
}
```

## Example
```json
{"namespace": "production"}
```

## Response
Returns service objects with type, cluster IP, ports, and pod selectors.
