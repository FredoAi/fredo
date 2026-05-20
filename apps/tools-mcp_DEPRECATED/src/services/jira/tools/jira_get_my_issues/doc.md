# jira_get_my_issues

Get all Jira issues assigned to the current user, with optional status filtering.
Returns mock data when `JIRA_BASE_URL`, `JIRA_EMAIL`, and `JIRA_API_TOKEN` are not configured.

## Input Schema

```json
{
  "statusFilter": "string (optional) - One of: Open | In Progress | Done | To Do | Closed | All",
  "maxResults": "number (optional) - Max issues to return, 1-100 (default: 50)"
}
```

## Examples

Get all assigned issues:
```json
{}
```

Get only open issues:
```json
{"statusFilter": "Open"}
```

Get at most 10 in-progress issues:
```json
{"statusFilter": "In Progress", "maxResults": 10}
```

## Response

Returns `{ success, issues[], total, isMockData }`.
Each issue contains: `key`, `summary`, `issueType`, `status`, `priority`, `labels`, `assignee`, `reporter`, `created`, `updated`, `url`.
`isMockData: true` when returning sample data (credentials not configured).
