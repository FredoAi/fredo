# Atlas_ui_collect_responses

Collects and flushes all pending UI responses (user interactions) for the current session. This provides an explicit way to retrieve responses from the browser extension without waiting for auto-attachment.

## Input Schema
```json
{}
```

No parameters required - uses session context automatically.

## Example
```json
{}
```

## Response
Returns all pending responses with metadata and atomically deletes them (read-once pattern).

### With Pending Responses
```json
{
  "success": true,
  "connectionId": "a3245ba6-3cfb-420d-bc74-9151603d2e7c",
  "responses": [
    {
      "featureId": "azdo-create-workitem",
      "payload": {
        "workItemId": 12345,
        "url": "https://dev.azure.com/..."
      },
      "metadata": {
        "timestamp": "2026-02-18T10:30:00.000Z"
      }
    }
  ],
  "count": 1,
  "collectedAt": "2026-02-18T10:30:05.000Z"
}
```

### No Pending Responses
```json
{
  "success": true,
  "connectionId": "a3245ba6-3cfb-420d-bc74-9151603d2e7c",
  "responses": [],
  "count": 0,
  "collectedAt": "2026-02-18T10:30:05.000Z"
}
```

## Notes
- Responses are atomically deleted after collection (read-once pattern)
- Same Redis keys as auto-retrieval mechanism in `checkUIResponses()`
- Calling this tool twice in a row will return zero responses on second call
