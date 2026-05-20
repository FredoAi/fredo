# infrastructure_stream

Stream real-time infrastructure architecture updates via Server-Sent Events.

## Input Schema
```json
{
  "connectionId": "string (optional, for reconnection)"
}
```

## Example
```json
{
  "connectionId": "conn-123"
}
```

## Response
Returns SSE stream with incremental architecture updates, health changes, and topology modifications.
