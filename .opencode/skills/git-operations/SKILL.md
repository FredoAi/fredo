---
name: git-operations
description: Unified GitHub and pipeline operations for the Fredo agentic workflow. Load when any agent needs to post comments, manage issues/PRs/labels, handle branches/worktrees, set project status, or work with capsule comments.
---

# Git Operations — Unified Pipeline

## Comments

### Post a comment

Write your markdown body to `.opencode/tmp/comments/<slug>.md` via the `Write` tool, then post:

```
powershell -File .opencode/scripts/git-ops-comment.ps1 -IssueNumber <N> -BodyFile .opencode/tmp/comments/<slug>.md
```

Do NOT inline markdown in the PowerShell command — always use a file.

## Screenshots

### Upload a screenshot to GitHub CDN

```
gh image <file> --repo FredoAi/fredo
# Returns: ![filename](https://github.com/user-attachments/assets/...)
```

Requires `GH_SESSION_TOKEN` env var.

## Pull Requests

### Create a PR (Developer)

```
powershell -File .opencode/scripts/pr-create.ps1 -BacklogIssue <N> -SpecBranch "<branch>" -CapsuleName "<name>"
```

### Merge a PR (Engineering Lead — approve + merge)

```
powershell -File .opencode/scripts/pr-review.ps1 -Action approve -PrNumber <N> -SpecBranch "<branch>" -ReviewFile <file>
```

### Create a PR to main (from any branch)

```
gh pr create --draft --base main --head "<branch>" --title "<title>" --body-file <temp>
```

Used by the Self-Improver for improvement PRs. Write the body to a temp file first, then pass via `--body-file`.

## Issues

### Read an issue

```
gh issue view <N>
```

### Read issue comments

```
gh issue view <N> --comments
```

### ⛔ Close an issue — FORBIDDEN for spec/parent issues

```
gh issue close <N> --reason completed
```

**CRITICAL: No pipeline agent may close the main spec/parent issue.** The pipeline stops at the `ready-for-review` label. Only a human may close the main spec issue after reviewing screenshots, evidence, and the complete spec deliverable. **Closing capsule sub-issues is allowed** — those track per-capsule progress and may be auto-closed when the capsule PR merges. This guardrail is enforced by the Engineering Lead and Self-Improver prompts. Spec #609 was closed by an agent without human review; the bug (#612) went unreviewed.

### Create a backlog issue

```
powershell -File .opencode/scripts/backlog-create.ps1 -Title "<title>" -BodyFile <file>
```

### Create a spec + branch

Post a spec comment and create the branch. The spec-create.ps1 no longer creates a PR.

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

## Capsule Comments

### Post a capsule as a comment

Write the capsule YAML to a temp file, then post as a comment on the backlog issue via the git-operations skill (git-ops-comment recipe).

### Read a capsule from a comment

Use `gh issue view <N> --comments` and search for `## Capsule: {name}` heading.

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

### Clean up Developer worktrees

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

## References & Attachments

### Attach an image to a comment or issue

1. Upload the image to GitHub CDN:
   ```
   gh image <file> --repo FredoAi/fredo
   # Returns: ![filename](https://github.com/user-attachments/assets/...)
   ```
   Requires `GH_SESSION_TOKEN` env var.

2. Include the CDN URL in your comment body file as markdown:
   ```
   ![description](cdn-url)
   ```

### Attach a visual wireframe to a spec comment

Used by UI/UX Architect to share the canonical visual reference with QA:

1. Save or capture the wireframe image
2. Upload via `gh image` (see above)
3. Include the CDN URL in the UX Design section of the spec comment
4. Annotate the image with component zones, dimensions, and color tokens before uploading

### Include a URL/link reference in any artifact

To reference an external URL in a comment, backlog, spec, or PR body:

```
See [link text](https://example.com)
```

For snippets that need URL context, include the URL as a markdown reference alongside the snippet:

```
<!-- Reference: https://github.com/example/repo/blob/main/src/lib.rs -->
```

### Attach a screenshot to an e2e report

Used by QA to include visual evidence in test results:

1. Capture screenshot via tauri_webview_screenshot
2. Upload via `gh image` (see above)
3. Include CDN URL in the PASS/FAIL table's Screenshot column
