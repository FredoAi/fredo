---
name: git-arch
description: Use ONLY when fredo-spec-arch needs to perform git operations like creating GitHub issues, sub-issues, creating spec branches, reviewing PRs, and merging PRs into the spec branch. Does NOT include committing code.
---

# Git Operations — fredo-spec-arch

## Role Constraints

You are the architect. You **do not write code**, **do not create feature branches**, and **do not make commits**. Your git operations are limited to:
- Creating and managing GitHub Issues
- Creating the spec branch
- Reviewing PRs
- Merging approved PRs into the spec branch (NOT main)

## Spec Branch Creation

After creating the spec and sub-issues on GitHub, create the spec branch:

```bash
# Create spec branch from main
git checkout main
git pull origin main
git checkout -b spec/<issue-number>-<slug>
git push -u origin spec/<issue-number>-<slug>
```

## Issue Creation Workflow

### Create Spec Issue

```bash
# Step 1: Write spec body to file
cat > spec-body.md << 'EOF'
## Spec: <Feature Name>

### Overview
<What we're building and why>

### Architecture Decisions
- Decision 1 with rationale
- Decision 2 with rationale

### Requirements (EARS Syntax)
...

### Acceptance Criteria
...

### Tasks
- [ ] #<sub-issue-1> — <description> (REQ-1, REQ-2)
- [ ] #<sub-issue-2> — <description> (REQ-3)

### Test Plan
_To be filled by tester_

### Files to Modify
...

## Status: spec-draft
**Current phase:** Spec-arch creating spec
**Last updated:** <timestamp> by @fredo-spec-arch
**Spec branch:** spec/<issue-number>-<slug>
**Sub-issues:** <to be filled after creation>
**PRs:**

---
### Status History
| Timestamp | Status | Agent | Notes |
|-----------|--------|-------|-------|
| <timestamp> | spec-draft | @fredo-spec-arch | Spec created |

---
*Authored by @fredo-spec-arch*
EOF

# Step 2: Create issue
gh issue create --title "Spec: <Feature Name>" --body-file spec-body.md --label "spec"

# Step 3: Clean up
rm -f spec-body.md

# Step 4: Get issue number
ISSUE=$(gh issue list --limit 1 --json number -q '.[0].number')
```

### Create Sub-Issue (Task)

```bash
# Step 1: Write task body to file
cat > task-body.md << 'EOF'
## Task: <short description>

### What to Do
<Specific implementation details>

### Files
| File | Action | Notes |
|------|--------|-------|

### Patterns to Follow
- Reference existing codebase patterns

### Requirements Covered
- REQ-X: <requirement text>

### Independence
This task is independent of other subtasks. No cross-dependencies.

### Done When
- [ ] Specific completion criteria

---
*Authored by @fredo-spec-arch*
EOF

# Step 2: Create task
gh issue create --title "Task: <short description>" --body-file task-body.md --label "task"

# Step 3: Clean up
rm -f task-body.md
```

### Link Sub-Issues to Parent Spec

```bash
# After creating all sub-issues, update parent with task list
CURRENT_BODY=$(gh issue view <parent-issue-number> --json body -q '.body')

# Append sub-issue references
# (The sub-issues should already be referenced in the Tasks section)
```

### View Issues

```bash
# View a specific issue
gh issue view <issue-number>

# List open spec issues
gh issue list --label spec

# View issue comments
gh issue view <issue-number> --comments
```

## PR Review Workflow

### View PR

```bash
gh pr view <pr-number>
```

### View PR Diff

```bash
# Full diff
gh pr diff <pr-number>

# Diff for specific file
gh pr diff <pr-number> -- path/to/file.ts
```

### Review PR

```bash
# Approve PR
gh pr review <pr-number> --approve --body "Review summary

Approved. All requirements covered, code follows patterns, no issues found.

---
*Reviewed by @fredo-spec-arch*"

# Request changes
gh pr review <pr-number> --request-changes --body "Change requests:
1. <request with specific file/line reference>
2. <request>

Please address these and push updates to the same branch.

---
*Reviewed by @fredo-spec-arch*"

# Comment without approval/rejection
gh pr review <pr-number> --comment --body "Note: <comment>

---
*Reviewed by @fredo-spec-arch*"
```

## Merging PRs into Spec Branch

**CRITICAL: Merge into the spec branch, NOT main.**

After approving a PR, merge it into the spec branch:

```bash
# Switch to spec branch
git checkout spec/<issue-number>-<slug>
git pull origin spec/<issue-number>-<slug>

# Merge the PR branch using a regular merge (preserves history)
git merge --no-ff <pr-branch-name>

# Push
git push origin spec/<issue-number>-<slug>

# Delete the merged branch
git checkout spec/<issue-number>-<slug>
git branch -d <pr-branch-name>
git push origin --delete <pr-branch-name>
```

### Alternative: Merge via GitHub

```bash
# If you prefer to merge via GitHub web UI
# Navigate to the PR page and click "Merge pull request"
# Then delete the branch

# Or use gh CLI:
gh pr merge <pr-number> --merge --delete-branch
```

## PR Review Checklist

When reviewing a PR:

- **Correctness**: Does it implement the spec as written?
- **Requirements**: Are all EARS requirements addressed?
- **Architecture**: Does it follow the documented decisions?
- **Quality**: Clean code, follows patterns, no obvious bugs
- **Completeness**: All acceptance criteria addressed?
- **Scope**: No changes outside the spec without justification?
- **Independence**: Does this PR depend on another unmerged PR? (Should not)
- **Tests**: Does the PR make existing tests pass? (TDD)

## Constraints

- **Never write code** — that is the coder's job
- **Never create feature branches or commits** — only spec branches, issues, and PR
- **Merge into spec branch only** — never merge directly into main
- **Use regular merge** (not squash) for PRs into spec branch — preserves individual PR history
- **Always use EARS syntax** when creating specs
- **Use `gh` CLI** for all GitHub operations
- **Use `--body-file`** for all issue/PR creation (never inline `--body "..."`)
- **Leave Test Plan section empty** in specs for the tester to fill
- **Subtasks MUST be independent** — no cross-dependencies between subtask files
- **All GitHub content must include author attribution**
- **Always end output with a HANDOFF block**