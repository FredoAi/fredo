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
# Step 1: Read .opencode/templates/issues/spec.md, fill {{variables}} (use SP-pending-{{feature_name}} for title since issue number is unknown)
# Step 2: Create issue with placeholder title
gh issue create --title "SP-pending-{{feature_name}}" --body-file spec-body.md --label "spec"
# Step 3: Get issue number and update title
ISSUE=$(gh issue list --limit 1 --json number -q '.[0].number')
gh issue edit $ISSUE --title "SP#$ISSUE-{{feature_name}}"
# Step 4: Clean up
rm -f spec-body.md
```

### Create Sub-Issue (Task)

```bash
# Step 1: Read .opencode/templates/issues/task.md, fill {{variables}}, extract TITLE from comment
# Step 2: Create task
gh issue create --title "SP#{{spec_issue}}-Task-{{task_name}}" --body-file task-body.md --label "task"
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
# Approve PR — use .opencode/templates/reviews/approve.md, fill {{variables}}
gh pr review <pr-number> --approve --body-file review.md

# Request changes — use .opencode/templates/reviews/request-changes.md, fill {{variables}}
gh pr review <pr-number> --request-changes --body-file review.md

# Comment without approval/rejection — use .opencode/templates/reviews/comment.md, fill {{variables}}
gh pr review <pr-number> --comment --body-file review.md
```

### Template Usage

All GitHub messages use templates from `.opencode/templates/`.

1. Read the appropriate template file
2. Extract `<!-- TITLE: ... -->` comment for the title (if applicable)
3. Replace `{{variables}}` with actual values
4. Remove the `<!-- TITLE: ... -->` comment from the body
5. Write the filled content to a file
6. Use `gh` CLI with `--title` and `--body-file`:

```bash
gh pr create --draft --base {{spec_branch}} --title "{{title}}" --body-file pr-body.md
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