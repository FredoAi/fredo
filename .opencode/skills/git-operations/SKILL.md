---
name: git-operations
description: Unified GitHub and pipeline operations for the Fredo agentic workflow. Load when any agent needs to post comments, manage issues/PRs/labels, handle branches/worktrees, set project status, or work with capsule sub-issues.
---

# Git Operations — Unified Pipeline

## Comments

### Post a comment (inline markdown)

```
powershell -File .opencode/scripts/git-ops-comment.ps1 -IssueNumber <N> -Body '<markdown>'
```

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

Requires `GH_SESSION_TOKEN` env var.

## Pull Requests

### Create a PR (Coder)

```
powershell -File .opencode/scripts/pr-create.ps1 -BacklogIssue <N> -SpecBranch "<branch>" -CapsuleName "<name>"
```

### Merge a PR (Reviewer — approve + merge + close sub-issue)

```
powershell -File .opencode/scripts/pr-review.ps1 -Action approve -PrNumber <N> -SpecBranch "<branch>" -ReviewFile <file> -SubIssueNumber <N>
```

### Create a PR to main (from any branch)

```
gh pr create --draft --base main --head "<branch>" --title "<title>" --body-file <temp>
```

Used by the retro-analyst for improvement PRs. Write the body to a temp file first, then pass via `--body-file`.

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

### Create a backlog issue

```
powershell -File .opencode/scripts/backlog-create.ps1 -Title "<title>" -BodyFile <file>
```

### Create a spec + branch + main PR

```
powershell -File .opencode/scripts/spec-create.ps1 -Title "<title>" -Branch "<slug>" -BodyFile "<file>" -BacklogIssue <N>
```

## Labels

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

## Project Status

### Set project status

```
powershell -File .opencode/scripts/project-status.ps1 -IssueNumber <N> -Status "<status>"
```

Valid statuses: Backlog, Planning, Coding, Reviewing, E2E, Done

## Metrics & Retro

### Read metrics summary

```
powershell -File .opencode/scripts/metrics-summary.ps1 -Json
```

### Append metrics entry

```
powershell -File .opencode/scripts/retro-append.ps1 -Mode metrics -BacklogIssue <N> -BodyFile <temp>
```

## Branch & Worktree Management

### Create a git worktree for a capsule

```
powershell -File .opencode/scripts/workspace-create.ps1 -BacklogIssue <N> -SpecBranch "<branch>" -CapsuleName "<name>"
```

### Clean up Coder worktrees

```
powershell -File .opencode/scripts/workspace-cleanup.ps1 -SpecBranch "<branch>"
```

### Scan for stale branches

```
powershell -File .opencode/scripts/clean-stale-branches.ps1 -DryRun
```

### Delete stale branches for a spec

```
powershell -File .opencode/scripts/clean-stale-branches.ps1 -IssueNumber <N>
```
