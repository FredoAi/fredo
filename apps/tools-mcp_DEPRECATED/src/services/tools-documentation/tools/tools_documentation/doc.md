# tools_documentation

Get documentation for one or more tools.

## Parameters
- `tool_name` (string | string[], required): Tool name(s) as JSON array

## Example
```
tool_name=["logs_query","metrics_query"]
```

## Output
```json
{
  "success": true,
  "results": [
    {
      "tool_name": "logs_query",
      "documentation": "..."
    }
  ]
}
```
