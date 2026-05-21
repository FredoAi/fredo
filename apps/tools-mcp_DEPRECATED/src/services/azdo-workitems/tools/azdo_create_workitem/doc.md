# azdo_create_workitem

Sends work item draft data to Fredo browser extension for user review, refinement, and creation. Enables iterative collaboration where AI and user refine the work item together before finalizing.

## Workflow

1. User clicks "Create Work Item" button OR asks AI for help
2. AI calls this tool with populated/improved fields
3. Browser extension form updates with provided data (merges with existing)
4. User reviews and can:
   - Edit fields manually
   - Click "Ask for Help" to request more refinements (repeat from step 2)
   - Click "Create Work Item" to finalize creation
5. Extension creates work item via Azure DevOps API
6. AI receives creation confirmation with work item ID

## Purpose

This tool does NOT create work items directly. It sends draft data to the UI form where users review and confirm before creation happens.

## Input Schema

All fields are optional (supports partial updates):

```json
{
  "title": "string - Clear, specific title",
  "type": "Bug|Task|User Story|Feature|Epic",
  "description": "string - Detailed description (HTML supported)",
  "priority": "number - 1=Critical, 2=High, 3=Medium, 4=Low (IMPORTANT: 4 is Low priority, not 1)",
  "assignedTo": "string - Email or display name",
  "tags": "string - Comma-separated tags",
  "acceptanceCriteria": "string - Completion criteria (HTML supported)",
  "areaPath": "string - Team/area path (optional)",
  "iterationPath": "string - Sprint/iteration (optional)"
}
```

## Examples

### Priority Scale Reference
**CRITICAL**: Use the correct priority number:
- **1 = Critical** (Production outage, security vulnerability)
- **2 = High** (Major feature broken, affects many users)
- **3 = Medium** (Important but not urgent)
- **4 = Low** (Nice to have, maintenance tasks)

### Initial Draft
```json
{
  "title": "Fix login timeout on mobile devices",
  "type": "Bug",
  "description": "Users experiencing authentication timeout on iOS devices",
  "priority": 1
}
```

### Refined Draft (After User Requested Review)
```json
{
  "title": "Fix authentication timeout on iOS 16+ during network transitions",
  "description": "<p>Users on iOS 16+ experience 30-second timeout during OAuth flow when switching between WiFi and cellular.</p><p><strong>Impact:</strong> 15% of mobile users affected.</p>",
  "priority": 1,
  "tags": "mobile, authentication, ios, network-transition",
  "acceptanceCriteria": "<ul><li>Login <5 seconds on all iOS versions</li><li>No timeout errors for 48 hours post-deployment</li></ul>"
}
```

### Low Priority Task Example
```json
{
  "title": "Refactor legacy logging utility functions",
  "type": "Task",
  "description": "Clean up old logging code to use new centralized logger",
  "priority": 4,
  "tags": "refactoring, tech-debt, maintenance"
}
```

## Response

Returns confirmation that draft was sent:

```json
{
  "message": "Work item draft sent to Fredo UI for user review",
  "fieldsProvided": ["title", "type", "description", "priority"],
  "timestamp": "2026-02-18T10:00:00.000Z"
}
```

## Prerequisites

- Browser extension installed and connected
- User has Azure DevOps credentials configured in Profile Settings

## Behavior Notes

- Tool can be called multiple times for iterative refinement
- Form intelligently merges incoming data with user's current edits
- Updated fields briefly highlight to show what changed
- User maintains full control - must click "Create Work Item" to finalize
- After creation, AI receives notification via response API with work item ID
