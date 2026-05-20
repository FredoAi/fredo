# kubectl_exec

Execute a command in a pod container.

## Input Schema
```json
{
  "namespace": "string (required) - Namespace",
  "pod": "string (required) - Pod name",
  "container": "string (optional) - Container name",
  "command": "array (required) - Command as array of strings",
  "stdin": "string (optional) - Standard input",
  "tty": "boolean (optional) - Allocate TTY"
}
```

## Example
```json
{
  "namespace": "production",
  "pod": "api-gateway-7d9f8b5c-xk4p2",
  "command": ["sh", "-c", "ps aux | grep node"]
}
```

## Response
Emits Update events: connecting → executing → capturing output. Returns stdout, stderr, and exit code.
