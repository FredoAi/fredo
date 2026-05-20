---
name: git-arch
description: Use ONLY when fredo-spec-arch needs to perform git operations like creating GitHub issues, sub-issues, and reviewing PRs. Covers issue creation workflows and PR review workflows using git and gh CLI. Does NOT include committing or branching.
---

# Git Operations — fredo-spec-arch

## Role Constraints

You are the architect. You **do not write code**, **do not create branches**, and **do not make commits**. Your git operations are limited to:
- Creating and managing GitHub Issues
- Reviewing PRs
- Reading diffs

## Issue Creation Workflow

### Create Spec Issue

```bash
gh issue create \
  --title "Spec: <Feature Name>" \
  --body-file spec-body.md \
  --label "spec"

# Add reviewers
gh issue edit <issue-number> --add-assignee pktron
```

### Create Sub-Issue (Task)

```bash
gh issue create \
  --title "Task: <short description>" \
  --body-file task-body.md \
  --label "task"
```

### Link Sub-Issue to Parent Spec

```bash
# After creating all sub-issues, update parent with task list
gh issue edit <parent-issue-number> --body "<existing body>

### Tasks
- [ ] #<sub-issue-1> — <description>
- [ ] #<sub-issue-2> — <description>
"
```

### View Issues

```bash
# View a specific issue
gh issue view <issue-number>

# List open issues
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

---
*Reviewed by @fredo-spec-arch*"

# Request changes
gh pr review <pr-number> --request-changes --body "Change requests:
1. <request>

---
*Reviewed by @fredo-spec-arch*"

# Comment without approval/rejection
gh pr review <pr-number> --comment --body "Note: <comment>

---
*Reviewed by @fredo-spec-arch*"
```

### Add Inline Comments

```bash
# Comment on specific line in a file
gh pr review <pr-number> --comment \
  --body "Comment text" \
  --commit <commit-sha> \
  --path path/to/file.ts \
  --position <line-number>
```

### PR Review Checklist

When reviewing a PR:

- **Correctness**: Does it implement the spec as written?
- **Requirements**: Are all EARS requirements addressed?
- **Architecture**: Does it follow the documented decisions?
- **Quality**: Clean code, follows patterns, no obvious bugs
- **Completeness**: All acceptance criteria addressed?
- **Scope**: No changes outside the spec without justification?

## Common Operations

### Check PR Status

```bash
gh pr list
gh pr list --state open
gh pr list --author <username>
```

### View PR Files Changed

```bash
gh pr view <pr-number> --json files
```

### Merge PR (after both coder and tester PRs are approved)

```bash
# Only after validation checklist passes
gh pr merge <pr-number> --squash
```

## Constraints

- **Never write code** — that is the coder's job
- **Never create branches or commits** — you only create issues and review PRs
- **Always use EARS syntax** when creating specs
- **Use `gh` CLI** for all GitHub operations
- **Leave Test Plan section empty** in specs for the tester to fill
