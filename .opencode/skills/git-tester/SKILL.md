---
name: git-tester
description: Use ONLY when fredo-tester needs to perform git operations like creating test branches from the spec branch, committing tests, creating draft PRs targeting the spec branch, and running the Tauri app for e2e testing. Covers test-focused git workflows.
---

# Git Operations — fredo-tester

## Worktree Context

**You are working inside a worktree at `.worktrees/tester-<issue-number>/`.** The branch is already checked out for you. Just write tests, commit, and push normally.

```bash
# You are already in your worktree
# Your branch is already checked out
# No need to create branches — just work
```

## Branching Strategy

### Create Test Branch from Spec Branch

**Your worktree already has this branch checked out.** If you need to create it manually:

```bash
# Fetch and checkout the spec branch
git fetch origin
git checkout spec/<issue-number>-<slug>

# Create test branch FROM the spec branch
git checkout -b test/<issue-number>-<slug>
```

### Branch Naming

| Type | Format | Example |
|------|--------|---------|
| Test branch | `test/<issue-number>-<slug>` | `test/17-dark-mode` |

## Commit Workflow

### Stage Test Files Only

You should **only modify test files** in Phase 1. In Phase 2 you only run tests, no commits.

```bash
# Stage test files only
git add **/*.test.ts
git add **/*.spec.ts
git add tests/

# Verify what's staged — should only be test files
git diff --cached --name-only
```

### Commit Messages for Tests

```
test(ui): add e2e tests for dark mode toggle
test(llm): add unit tests for connection retry logic
fix(test): fix flaky e2e test
```

## Push and PR Workflow (Phase 1 Only)

### Push Test Branch

```bash
git push -u origin test/<issue-number>-<slug>
```

### Create DRAFT PR Targeting Spec Branch

**CRITICAL: Always use `--body-file`, NEVER inline `--body "..."`.**

**CRITICAL: Always target the spec branch, NOT main.**

```bash
# Step 1: Read .opencode/templates/prs/test.md, fill {{variables}}, write to pr-body.md
# Step 2: Create PR using body file, targeting the spec branch
gh pr create --draft --base spec/<issue-number>-<slug> --title "test: e2e and unit tests for <feature>" --body-file pr-body.md
# Step 3: Clean up
rm -f pr-body.md
# Step 4: Add labels
gh pr edit --add-label "test"
```

## Phase 2: Integration Testing (No Commits Needed)

In Phase 2, you check out the spec branch (which now contains both tests and all implementations) and run e2e tests. No new PR is needed.

### Checkout Spec Branch for Testing

```bash
# Switch to the spec branch
git fetch origin
git checkout spec/<issue-number>-<slug>
git pull origin spec/<issue-number>-<slug>

# Verify all code is present
git log --oneline -10
```

### Start Tauri App

**You MUST start the app before any e2e testing:**

```bash
# From repo root — this starts Vite + Tauri window
pnpm dev:tauri
```

Wait for the Tauri window to appear before proceeding.

### Start MCP Automation Session

```
tool: driver_session
action: "start"
port: 9343
```

## Running Tests

### Run Unit Tests

```bash
# Run all unit tests
pnpm test

# Run specific test file
pnpm test -- path/to/test.test.ts

# Run tests matching pattern
pnpm test -- --grep "dark mode"
```

### Verify No Regressions

```bash
# Full test suite
pnpm test

# Lint check
pnpm lint

# Type check
pnpm typecheck
```

## Common Operations

### Pull Latest Spec Branch Changes

```bash
# If you need to update your test branch with latest spec changes
git fetch origin
git rebase origin/spec/<issue-number>-<slug>
```

### Check Test-Only Changes (Phase 1)

```bash
# Verify only test files are modified
git status
git diff --name-only
```

## Constraints

- **Always open DRAFT PRs** — never ready for review
- **Always target the spec branch** — `--base spec/<issue-number>-<slug>`, never main
- **Always branch FROM the spec branch** — never from main
- **Phase 1: Do not modify production code** — only add/modify test files
- **Phase 2: Only run tests** — no new commits or PRs
- **Map every test to at least one EARS requirement** (REQ-X)
- **Fill the Test Plan section** into the spec issue before writing tests
- **Always use `--body-file`** — never inline `--body "..."`
- **All GitHub content must include author attribution**
- **Do NOT use Playwright** — this is a Tauri desktop app, use Tauri MCP tools only