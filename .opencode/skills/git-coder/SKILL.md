---
name: git-coder
description: Use ONLY when fredo-coder needs to perform git operations like creating branches from the spec branch, making commits, pushing code, and creating draft PRs targeting the spec branch. Covers branching, commit conventions, and PR workflows.
---

# Git Operations — fredo-coder

## Branching Strategy

### Create Feature Branch from Spec Branch

**CRITICAL: Always branch from the spec branch, NOT main.**

```bash
# Fetch and checkout the spec branch
git fetch origin
git checkout spec/<issue-number>-<slug>

# Create your feature branch FROM the spec branch
git checkout -b feat/<subtask-number>-<slug>
```

### Create Bug Fix Branch from Spec Branch

```bash
# Fetch and checkout the spec branch
git fetch origin
git checkout spec/<issue-number>-<slug>

# Create bug branch FROM the spec branch
git checkout -b bug/<bug-number>-<slug>
```

### Branch Naming Conventions

| Type | Format | Example |
|------|--------|---------|
| Feature | `feat/<subtask-number>-<slug>` | `feat/18-dark-mode-toggle` |
| Bug fix | `bug/<bug-number>-<slug>` | `bug/25-panel-not-opening` |

Keep descriptions lowercase, hyphen-separated, and concise.

## Commit Workflow

### Stage Changes

```bash
# Stage specific files
git add path/to/file.ts

# Stage all changes (be careful)
git add .

# Verify what's staged
git diff --cached --name-only
```

### Conventional Commit Messages

Format: `type(scope): description`

| Type | When to Use |
|------|-------------|
| `feat` | New feature (maps to a subtask requirement) |
| `fix` | Bug fix |
| `refactor` | Code restructuring, no behavior change |
| `chore` | Maintenance, config, deps |
| `docs` | Documentation only |
| `test` | Test additions or changes |
| `style` | Formatting, whitespace |

Examples:
```
feat(ui): add dark mode toggle component
fix(settings): fix settings persistence after reload
```

### Amend Last Commit

```bash
# Add forgotten files to last commit
git add forgotten-file.ts
git commit --amend --no-edit
```

## Push and PR Workflow

### Push Feature Branch

```bash
git push -u origin feat/<subtask-number>-<slug>
```

### Create DRAFT PR Targeting Spec Branch

**CRITICAL: Always use `--body-file`, NEVER inline `--body "..."` — inline strings cause escape character corruption.**

**CRITICAL: Always target the spec branch, NOT main.**

```bash
# Step 1: Write body to a file
cat > pr-body.md << 'EOF'
## Summary
<What this PR does>

## Changes
- <bullet point with `code` formatting using backticks>
- <another change>

## Requirements Covered
| Req | Status |
|-----|--------|
| REQ-1: <requirement text> | ✅ |
| REQ-2: <requirement text> | ✅ |

## Files Modified
| File | Change |
|------|--------|
| `path/to/file.ts` | Created/Modified |

## Build
- `pnpm build` completes with 0 new warnings
- `pnpm test` — <N> passing, <N> failing

## Notes
<Any decisions, tradeoffs, or things to watch during review>

Closes #<subtask-number>

---
*Authored by @fredo-coder*
EOF

# Step 2: Create PR using body file, targeting the spec branch
gh pr create --draft --base spec/<issue-number>-<slug> --title "feat: <short description>" --body-file pr-body.md

# Step 3: Clean up
rm -f pr-body.md

# Step 4: Add labels
gh pr edit --add-label "feat"

# Step 5: Verify attribution was included
CURRENT_BODY=$(gh pr view --json body -q .body)
if ! echo "$CURRENT_BODY" | grep -q "Authored by @fredo-coder"; then
  gh pr edit --body "$CURRENT_BODY

---
*Authored by @fredo-coder*"
fi
```

### Create Bug Fix PR Targeting Spec Branch

```bash
# Same workflow as above but with:
# - Branch: bug/<bug-number>-<slug>
# - Title: fix: <short description>
# - Label: bug
# - Closes: #<bug-number>

gh pr create --draft --base spec/<issue-number>-<slug> --title "fix: <short description>" --body-file pr-body.md
gh pr edit --add-label "bug"
```

## Sync with Spec Branch

### Pull Latest Spec Branch Changes

```bash
# While on your feature branch
git fetch origin
git rebase origin/spec/<issue-number>-<slug>

# If conflicts arise, resolve them then:
git add <resolved-files>
git rebase --continue
```

### After Test PR is Merged into Spec Branch

When the tester's PR is merged into the spec branch, you can pull the test stubs:

```bash
git fetch origin
git rebase origin/spec/<issue-number>-<slug>
```

This gives you access to the test contracts so you can run `pnpm test` locally.

## Common Operations

### Check Status

```bash
git status
git diff
git log --oneline -5
```

### Stash Changes

```bash
# Stash current changes
git stash push -m "WIP: <description>"

# Apply stash
git stash pop

# List stashes
git stash list
```

## Constraints

- **Always open DRAFT PRs** — never ready for review
- **Always target the spec branch** — `--base spec/<issue-number>-<slug>`, never main
- **Always branch FROM the spec branch** — never from main
- **Never commit directly to main or spec branch** — always use feature/bug branches
- **Run lint/typecheck/build** before committing
- **Run `pnpm test`** — the test branch is already merged into spec, so you can see what passes/fails (TDD)
- **No dead code** or commented-out blocks in commits
- **Implement only what the spec says** — no extra features
- **Implement only your assigned REQ-X** — don't touch other requirements
- **Follow existing codebase patterns** and conventions
- **Always use `--body-file`** — never inline `--body "..."`
- **All GitHub content must include author attribution**