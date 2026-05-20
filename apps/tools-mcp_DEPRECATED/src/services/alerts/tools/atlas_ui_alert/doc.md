# Atlas_ui_alert

Send alerts or messages to the Atlas browser extension UI. Displays as toast notifications with optional user confirmation.

## Purpose
- Display informational messages (blue toast)
- Display warning alerts (orange toast)  
- Request user confirmation for critical actions
- Fire-and-forget pattern - returns immediately
- User responses arrive asynchronously in `pendingUIResponses` array

## Input Schema
```json
{
  "text": "string (REQUIRED) - Alert or message text",
  "isAlert": "boolean (optional) - true=warning/orange, false=info/blue (default: false)",
  "needsConfirmation": "boolean (optional) - Show Confirm button (default: false)"
}
```

## Examples

### Simple Info Message
```json
{
  "text": "Pod restarted successfully",
  "isAlert": false,
  "needsConfirmation": false
}
```

**Response:**
```json
{
  "alertId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "sent": true,
  "message": "Message sent to UI",
  "timestamp": "2026-02-14T10:30:00.000Z"
}
```

### Alert with Confirmation
```json
{
  "text": "About to delete pod api-gateway-7d9f8b. Confirm?",
  "isAlert": true,
  "needsConfirmation": true
}
```

**Response (immediate):**
```json
{
  "alertId": "b2c3d4e5-f6a7-8901-bcde-f12345678901",
  "sent": true,
  "message": "Alert sent to UI - confirmation pending",
  "timestamp": "2026-02-14T10:31:00.000Z"
}
```

**User Confirmation (arrives in next tool call):**
```json
{
  "content": [/* normal tool response */],
  "pendingUIResponses": [
    {
      "alertId": "b2c3d4e5-f6a7-8901-bcde-f12345678901",
      "alertText": "About to delete pod api-gateway-7d9f8b. Confirm?",
      "action": "confirmed",
      "timestamp": "2026-02-14T10:31:15.000Z"
    }
  ]
}
```

## Behavior
1. **Tool returns immediately** - does not block waiting for user
2. **Event-based flow**: Alert → Redis Stream → SSE → Browser UI
3. **User interaction**: User clicks Confirm/Dismiss in toast
4. **Response flow**: UI → API → Redis → Auto-attached to next MCP tool response
5. **TTL**: Responses stored in Redis for 5 minutes

## Use Cases
- **Info messages**: "Query completed", "Pod restarted", "Logs retrieved"
- **Warnings**: "High CPU usage detected", "Pod is CrashLooping"
- **Confirmations**: "Delete this pod?", "Restart deployment?", "Apply changes?"

## Important Notes
- **Check pendingUIResponses** in subsequent tool responses
- **Event-based**: Confirmations arrive asynchronously
- **Theme-aware**: Uses CSS variables for colors
