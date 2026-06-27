---
name: git-operations
description: Unified GitHub operations for the Fredo pipeline. Load when any agent needs to post comments, upload screenshots, manage issues/PRs/labels, or set project status.
---

# Git Operations — Unified GitHub Pipeline

## Comments

### Post a comment (inline markdown)

```
powershell -File .opencode/scripts/git-ops-comment.ps1 -IssueNumber <N> -Body '<markdown>'
```

The script writes UTF-8 without BOM and posts via `--body-file`. Never use `gh issue comment` directly or `Set-Content` for comment bodies.

### Post a comment (from file)

```
powershell -File .opencode/scripts/git-ops-comment.ps1 -IssueNumber <N> -BodyFile <path>
```

## Screenshots

### Upload a screenshot to GitHub CDN

```
gh image <file> --repo FredoAi/fredo
# Returns: ![filename](https://github.com/user-attachments/assets/...)
```

Requires `GH_SESSION_TOKEN` env var (browser session cookie). If `gh image` fails, screenshots remain at local path.

### Post e2e results with screenshots

1. Upload each screenshot via `gh image`
2. Build PASS/FAIL markdown table with CDN URLs
3. Post via `git-ops-comment.ps1 -Body '<table>'

## Pull Requests

### Create a PR

```
powershell -File .opencode/scripts/pr-create.ps1 -BacklogIssue <N> -SpecBranch "<branch>" -CapsuleName "<name>" -Type feat
```

### Merge a PR (approve + merge + close sub-issue)

```
powershell -File .opencode/scripts/pr-review.ps1 -Action approve -PrNumber <N> -SpecBranch "<branch>" -ReviewFile <file> -SubIssueNumber <N>
```

## Issues

### Read an issue

```
gh issue view <N>
```

### Read issue comments

```
gh issue view <N> --comments
```

### Close an issue

```
gh issue close <N> --reason completed
```

### Create an issue

```
gh issue create --title "<title>" --body-file <file>
```

### List issues by label

```
gh issue list --label <label> --state open
```

### Create a label

```
gh label create "<name>" --color "<hex>" --description "<desc>"
```

### Add a label to an issue

```
gh issue edit <N> --add-label "<name>"
```

### Add a label to a PR

```
gh pr edit <N> --add-label "<name>"
```

## Project Status

### Set project status

```
powershell -File .opencode/scripts/project-status.ps1 -IssueNumber <N> -Status "<status>"
```

Valid statuses: Backlog, Planning, Coding, Reviewing, E2E, Done

## Sub-Issues (Capsules)

### Create a sub-issue

```
powershell -File .opencode/scripts/sub-issue-create.ps1 -ParentIssue <N> -Title "Capsule: <name>" -BodyFile <file> -Label capsule
```

### List sub-issues for a parent

```
powershell -File .opencode/scripts/capsule-get.ps1 -ParentIssue <N>
```

### Read a sub-issue body

```
powershell -File .opencode/scripts/capsule-get.ps1 -SubIssueNumber <N>
```

## Validation

### Validate capsules

```
powershell -File .opencode/scripts/validate-capsules.ps1 -CapsuleFiles <file1>,<file2>
```

### Verify EARS coverage

```
powershell -File .opencode/scripts/validate-capsules.ps1 -CoverageCheck -BacklogIssue <N>
```
