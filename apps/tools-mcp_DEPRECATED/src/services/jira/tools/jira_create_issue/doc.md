# jira_create_issue

Create a new Jira issue (Bug, Task, or Story) in any project.
Simulates creation with a random key when `JIRA_BASE_URL`, `JIRA_EMAIL`, and `JIRA_API_TOKEN` are not configured.

## Input Schema

```json
{
  "projectKey": "string (required) - Project key, e.g. BUG, DEVOPS, PROJ",
  "summary":    "string (required) - Issue title / one-line summary",
  "issueType":  "string (required) - Bug | Task | Story",
  "description":"string (optional) - Detailed description",
  "priority":   "string (optional) - Critical | High | Medium | Low (default: Medium)",
  "labels":     "string[] (optional) - Array of label strings"
}
```

## Examples

Create a bug report:
```json
{
  "projectKey": "BUG",
  "summary": "Login page crashes on Safari 17",
  "issueType": "Bug",
  "priority": "High",
  "labels": ["safari", "login"]
}
```

Create a task:
```json
{
  "projectKey": "DEVOPS",
  "summary": "Rotate database credentials for staging",
  "issueType": "Task",
  "description": "Rotate all PostgreSQL credentials and update secrets in Vault.",
  "priority": "Medium"
}
```

## Response

Returns `{ success, issue, isMockData, error? }`.
On success, `issue` contains the newly created issue with a generated `key`.
On failure, returns `success: false` with a descriptive `error` message.
`isMockData: true` when credentials are not configured (key is randomly generated).
