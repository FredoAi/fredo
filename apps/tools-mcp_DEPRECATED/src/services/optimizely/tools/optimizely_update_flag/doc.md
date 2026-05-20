# optimizely_update_flag

Enables or disables an Optimizely feature flag. Optionally sets the rollout percentage.

**MCP-only** — not exposed via REST API.

## Parameters

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `flagKey` | string | **Yes** | The snake_case key of the flag (e.g. `new_dashboard_ui`) |
| `enabled` | boolean | **Yes** | `true` to enable, `false` to disable |
| `rolloutPercentage` | number | No | Percentage of users to expose the flag to (0–100) |

## Returns

```json
{
  "success": true,
  "flag": {
    "id": "flag-001",
    "key": "new_dashboard_ui",
    "name": "New Dashboard UI",
    "enabled": false,
    "environment": "production",
    "rolloutPercentage": 0,
    "updatedAt": "2026-03-18T10:00:00.000Z"
  },
  "isMockData": true
}
```

## Examples

```json
// Disable a flag
{ "flagKey": "new_dashboard_ui", "enabled": false }

// Enable with full rollout
{ "flagKey": "new_dashboard_ui", "enabled": true, "rolloutPercentage": 100 }

// Gradual rollout at 10%
{ "flagKey": "ai_copilot_suggestions", "enabled": true, "rolloutPercentage": 10 }
```

## Notes

- Use `optimizely_get_flags` first to retrieve valid flag keys.
- `flagKey` must match the existing key exactly (snake_case, no spaces).
- Returns an error if the flag key does not exist.
