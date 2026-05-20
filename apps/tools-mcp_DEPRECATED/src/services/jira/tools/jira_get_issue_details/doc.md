# jira_get_issue_details

Get full details for a specific Jira issue using its key (e.g. `BUG-101`, `DEVOPS-205`).
Returns mock data when `JIRA_BASE_URL`, `JIRA_EMAIL`, and `JIRA_API_TOKEN` are not configured.

## Input Schema

```json
{
  "issueKey": "string (required) - Jira issue key, format: PROJECT-NUMBER (e.g. BUG-101)"
}
```

## Examples

Get details for a bug:
```json
{"issueKey": "BUG-101"}
```

Get details for a task:
```json
{"issueKey": "DEVOPS-205"}
```

## Response

Returns `{ success, issue, isMockData, error? }`.
Issue contains: `id`, `key`, `summary`, `description`, `issueType`, `status`, `priority`,
`labels`, `assignee`, `reporter`, `projectKey`, `projectName`, `created`, `updated`, `url`.

Returns `success: false` with an `error` message if the issue key is invalid or not found.
Available mock keys: `BUG-101`, `DEVOPS-205`, `PROJ-318`, `BUG-422`, `DEVOPS-511`.
