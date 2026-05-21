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
# Step 1: Read .opencode/templates/issues/spec.md, fill {{variables}}, write to spec-body.md
# Step 2: Create issue
gh issue create --title "Spec: {{feature_name}}" --body-file spec-body.md --label "spec"
# Step 3: Clean up
rm -f spec-body.md
# Step 4: Get issue number
ISSUE=$(gh issue list --limit 1 --json number -q '.[0].number')
```

### Create Sub-Issue (Task)

```bash
# Step 1: Read .opencode/templates/issues/task.md, fill {{variables}}, write to task-body.md
# Step 2: Create task
gh issue create --title "Task: {{task_name}}" --body-file task-body.md --label "task"
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
# Approve PR — use .opencode/templates/reviews/approve.md
gh pr review <pr-number> --approve --body-file review.md

# Request changes — use .opencode/templates/reviews/request-changes.md
gh pr review <pr-number> --request-changes --body-file review.md

# Comment without approval/rejection — use .opencode/templates/reviews/comment.md
gh pr review <pr-number> --comment --body-file review.md
```

## Merging PRs into Spec Branch

**CRITICAL: Merge into the spec branch, NOT main. Use squash merge and delete the branch.**

After approving a PR, merge it:

```bash
# Squash-merge the PR into the spec branch, delete the branch
gh pr merge <pr-number> --squash --delete-branch
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
- **Never create feature branches or commits** — only spec branches, issues, and PR reviews
- **Merge into spec branch only** — never merge directly into main
- **Squash-merge all PRs** — `gh pr merge --squash --delete-branch`
- **Always use EARS syntax** when creating specs
- **Use `gh` CLI** for all GitHub operations
- **Use `--body-file`** for all issue/PR creation (never inline `--body "..."`)
- **Leave Test Plan section empty** in specs for the tester to fill
- **Subtasks MUST be independent** — no cross-dependencies between subtask files
- **All GitHub content must include author attribution**
- **Always end output with a HANDOFF block**