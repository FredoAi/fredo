# optimizely_get_flags

Returns all Optimizely feature flags and their current status.

## Parameters

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `environment` | string | No | Filter by environment: `production`, `staging`, `development` |
| `statusFilter` | string | No | Filter by status: `enabled`, `disabled`, `all` (default: all) |

## Returns

```json
{
  "success": true,
  "flags": [
    {
      "id": "flag-001",
      "key": "new_dashboard_ui",
      "name": "New Dashboard UI",
      "description": "Enables the redesigned dashboard with improved metrics visualization.",
      "enabled": true,
      "environment": "production",
      "rolloutPercentage": 100,
      "tags": ["ui", "dashboard"],
      "createdAt": "2026-01-10T08:00:00.000Z",
      "updatedAt": "2026-03-01T12:00:00.000Z"
    }
  ],
  "total": 6,
  "isMockData": true
}
```

## Examples

```json
// All flags
{}

// Enabled flags in production
{ "environment": "production", "statusFilter": "enabled" }

// All flags in staging
{ "environment": "staging" }
```

## Notes

- Returns mock data when `OPTIMIZELY_SDK_KEY` / `OPTIMIZELY_PROJECT_ID` env vars are absent.
- Use `optimizely_update_flag` to toggle or change the rollout percentage of a flag.
