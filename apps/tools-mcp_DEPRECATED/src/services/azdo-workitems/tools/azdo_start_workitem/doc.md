# azdo_start_workitem

Opens Azure DevOps work items in the Fredo browser extension UI.

## Modes

### List Mode (No Input)

Shows all work items assigned to the user in a card grid view.

### Detail Mode (With workItemId)

Shows detailed information about a specific work item in a modal.

## Input Schema

```json
{
  "workItemId": "number (optional)"
}
```

## Examples

### Show All Work Items

```json
{}
```

### Show Specific Work Item

```json
{
  "workItemId": 12345
}
```

## Response

Returns confirmation that the UI has been triggered:

- `message`: Human-readable confirmation
- `mode`: "list" or "detail"
- `workItemId`: Work item ID (if in detail mode)
- `timestamp`: ISO timestamp

## Prerequisites

- Browser extension must be installed and connected
- User must have Azure DevOps credentials configured in Profile Settings
