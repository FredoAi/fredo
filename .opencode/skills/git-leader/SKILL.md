---
name: git-leader
description: Use ONLY when fredo (leader) needs to perform git operations like creating spec branches, viewing issues, closing issues, managing status, merging spec branches to main, and posting summaries. Covers issue management and branch management workflows using git and gh CLI.
---

# Git Operations — fredo (Leader)

## Spec Branch Management

### Create Spec Branch

After spec-arch creates the spec and sub-issues:

```bash
# Create spec branch from main
git checkout main
git pull origin main
git checkout -b spec/<issue-number>-<slug>
git push -u origin spec/<issue-number>-<slug>
```

### Squash-Merge Spec Branch to Main

After all tests pass and docs are updated:

```bash
# Squash-merge spec branch into main, delete branch
gh pr merge --squash --delete-branch --base main spec/<issue-number>-<slug>

# Remove all remaining worktrees
git worktree list | grep '.worktrees/' | awk '{print $1}' | xargs -I {} git worktree remove {}
```

## Issue Management

### View Spec Issues

```bash
# View a specific issue
gh issue view <issue-number>

# View issue with comments
gh issue view <issue-number> --comments

# List open spec issues
gh issue list --label spec
```

### Create Bug Issue

When tester reports bugs during integration testing:

```bash
# Step 1: Write bug body to file
cat > bug-body.md << 'EOF'
## Bug: <short description>

### Spec Issue
#<spec-issue-number>

### Bug Description
<What's broken>

### Steps to Reproduce
1. <step>
2. <step>

### Expected Behavior (from spec)
<What REQ-X says should happen>

### Actual Behavior
<What actually happens>

### Evidence
<screenshots, logs, test output>

---
*Authored by @fredo*
EOF

# Step 2: Create issue
gh issue create --title "Bug: <short description>" --body-file bug-body.md --label "bug"

# Step 3: Clean up
rm -f bug-body.md
```

### Close Issues

```bash
# Close sub-issue after its PR is merged
gh issue close <subtask-number> --comment "Completed as part of merged PR #<pr-number>

---
*Authored by @fredo*"

# Close bug issue after fix is merged
gh issue close <bug-number> --comment "Bug fixed in PR #<pr-number>

---
*Authored by @fredo*"

# Close spec issue after all work is done
gh issue close <spec-issue> --comment "All phases complete. Spec branch merged to main.

## Summary
<What was implemented>

## PRs Merged
- Tests: #<pr-number>
- Subtask #<num>: #<pr-number>
- Bug fix #<num>: #<pr-number>

---
*Authored by @fredo*"
```

### Add Comments to Issues

```bash
# Post status updates
gh issue comment <issue-number> --body "<message>

---
*Authored by @fredo*"

# Notify spec-arch for review
gh issue comment <issue-number> --body "@fredo-spec-arch PRs ready for review. Please review:
- #<pr-number> (feature)
- #<pr-number> (test)

---
*Authored by @fredo*"
```

## Status Management

### Update Status Field

After parsing a HANDOFF from a subagent, update the spec issue status:

```bash
ISSUE=<issue-number>
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
AGENT="@<agent-name>"
NEW_STATUS="<status-value>"
PHASE="<phase description>"
NOTES="<brief notes>"

CURRENT_BODY=$(gh issue view $ISSUE --json body -q '.body')

# Update status line
NEW_BODY=$(echo "$CURRENT_BODY" | sed "s/## Status: .*/## Status: $NEW_STATUS/")

# Update current phase line
NEW_BODY=$(echo "$NEW_BODY" | sed "s/\*\*Current phase:\*\* .*/\*\*Current phase:\*\* $PHASE/")

# Update last updated line
NEW_BODY=$(echo "$NEW_BODY" | sed "s/\*\*Last updated:\*\* .*/\*\*Last updated:\*\* $TIMESTAMP by $AGENT/")

# Append to status history
HISTORY_ENTRY="| $TIMESTAMP | $NEW_STATUS | $AGENT | $NOTES |"
NEW_BODY=$(echo "$NEW_BODY" | sed "/### Status History/a\\$HISTORY_ENTRY")

gh issue edit $ISSUE --body "$NEW_BODY"
```

### Add PR Reference to Spec Issue

When a subagent creates a PR:

```bash
ISSUE=<spec-issue-number>
PR_NUM=<pr-number>
PR_TYPE=<Coder|Tester|Bug-fix>
SUBTASK=<subtask-or-issue-number>

CURRENT_BODY=$(gh issue view $ISSUE --json body -q '.body')

# Add PR line
PR_LINE="- $PR_TYPE: #$PR_NUM (DRAFT) — #$SUBTASK"
NEW_BODY=$(echo "$CURRENT_BODY" | sed "/^\*\*PRs:\*\*$/a\\$PR_LINE")

gh issue edit $ISSUE --body "$NEW_BODY"
```

### Update PR Status in Spec Issue

When a PR is merged:

```bash
ISSUE=<spec-issue-number>
PR_NUM=<pr-number>

CURRENT_BODY=$(gh issue view $ISSUE --json body -q '.body')

# Update PR status from DRAFT to MERGED
NEW_BODY=$(echo "$CURRENT_BODY" | sed "s/#$PR_NUM (DRAFT)/#$PR_NUM (MERGED)/")

gh issue edit $ISSUE --body "$NEW_BODY"
```

### Status Values

| Status | Meaning | Who's Active |
|--------|---------|-------------|
| `spec-draft` | Spec-arch creating spec | @fredo-spec-arch |
| `spec-review` | Fredo reviewing spec | @fredo |
| `spec-confirmed` | Spec approved, ready for test writing | @fredo-tester |
| `test-written` | Tests written, PR in draft | @fredo-tester |
| `test-merged` | Tests merged into spec branch | @fredo-spec-arch |
| `implementing` | Coders working on subtasks | @fredo-coder (×N) |
| `pr-review` | Architect reviewing PRs | @fredo-spec-arch |
| `pr-merged` | All PRs merged into spec branch | @fredo |
| `integration-testing` | Tester running e2e on spec branch | @fredo-tester |
| `bugs-found` | Bugs found during integration testing | @fredo |
| `bug-fixing` | Coder fixing bugs | @fredo-coder |
| `bug-pr-review` | Architect reviewing bug fix PRs | @fredo-spec-arch |
| `all-tests-passed` | All e2e tests passing on spec branch | @fredo |
| `docs-updated` | Docs and CHANGELOG updated | @fredo |
| `closed` | Spec branch merged to main, all issues closed | — |

### Status Field Format

```markdown
## Status: implementing
**Current phase:** Coders implementing subtasks
**Last updated:** 2026-05-20T14:32:00Z by @fredo-coder
**Spec branch:** spec/17-dark-mode
**Sub-issues:** #18, #19, #20
**PRs:**
- Tests: #21 (MERGED)
- Subtask #18: #22 (DRAFT)
- Subtask #19: #23 (DRAFT)
- Subtask #20: pending

---
### Status History
| Timestamp | Status | Agent | Notes |
|-----------|--------|-------|-------|
| 2026-05-20T14:32:00Z | implementing | @fredo | Fanned out 3 coders for subtasks |
| 2026-05-20T13:00:00Z | test-merged | @fredo-spec-arch | Test PR merged into spec branch |
```

## CHANGELOG.md Workflow

### Update CHANGELOG Before Final Merge

```markdown
## [Unreleased]

### Features
- <feature description> (closes #<issue-number>)

### Fixes
- <fix description> (closes #<issue-number>)

### Breaking Changes
- <breaking change description>
```

### Commit CHANGELOG

```bash
git add CHANGELOG.md
git commit -m "docs: update CHANGELOG for <feature/fix>"
git push
```

## PR Management

### Review PR Status

```bash
# List all open PRs
gh pr list

# View specific PR
gh pr view <pr-number>

# Check if PR is approved
gh pr view <pr-number> --json reviews
```

### Merge PRs into Spec Branch (after architect approval)

```bash
# Squash-merge the PR into the spec branch, delete the branch
gh pr merge <pr-number> --squash --delete-branch

# Remove the worktree for this PR
git worktree remove .worktrees/<name>
```

## Validation Checklist

Before squash-merging spec branch to main, verify:

- [ ] Spec issue created with all sections filled
- [ ] All sub-issues (tasks) created and linked
- [ ] Test Plan section filled by tester
- [ ] Tests written and merged into spec branch BEFORE implementation
- [ ] All coder PRs reviewed and approved by spec-arch
- [ ] All coder PRs merged into spec branch
- [ ] Full e2e testing run against spec branch (Tauri MCP)
- [ ] All bugs found during integration testing are fixed
- [ ] All acceptance criteria met
- [ ] All test plan items passing
- [ ] CI checks pass (lint, typecheck, test)
- [ ] CHANGELOG.md updated
- [ ] README.md / docs updated if needed

## Worktree Management

### Create Worktree for a Branch

```bash
# Clean up stale worktree if it exists
if (Test-Path .worktrees/<name>) {
  git worktree remove .worktrees/<name>
}
git worktree add .worktrees/<name> -b <branch-name> spec/<issue-number>-<slug>
```

### Create Worktrees During Fan-Out

```bash
# For each coder subtask
git worktree add .worktrees/coder-<subtask-number> -b feat/<subtask-number>-<slug> spec/<issue-number>-<slug>

# For tester
git worktree add .worktrees/tester-<issue-number> -b test/<issue-number>-<slug> spec/<issue-number>-<slug>
```

### Remove Worktree After PR Merge

```bash
git worktree remove .worktrees/<name>
```

### List All Worktrees

```bash
git worktree list
```

### Cleanup All Remaining Worktrees

```bash
# Remove all worktrees under .worktrees/
git worktree list | grep '.worktrees/' | awk '{print $1}' | xargs -I {} git worktree remove {}
```

## Constraints

- **Never skip validation checklist** before merging spec branch to main
- **Always update CHANGELOG.md** before final merge
- **Always use `--body-file`** for all issue/PR creation — never inline `--body "..."`
- **Wait for architect approval** on PRs before merging into spec branch
- **Squash-merge all PRs** — `gh pr merge --squash --delete-branch`
- **Remove worktree immediately after PR merge** — no stale worktrees
- **Keep spec issue, sub-issues, and PRs linked and labeled**
- **All GitHub content must include author attribution**
- **Use `gh` CLI** for all GitHub operations