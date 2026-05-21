---
name: git-tester
description: Use ONLY when fredo-tester needs to perform git operations like creating test branches from the spec branch, committing tests, creating draft PRs targeting the spec branch, and running the Tauri app for e2e testing. Covers test-focused git workflows.
---

# Git Operations — fredo-tester

## Branching Strategy

### Create Test Branch from Spec Branch

**CRITICAL: Always branch from the spec branch, NOT main.**

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
# Step 1: Write body to a file
cat > pr-body.md << 'EOF'
## Test Plan

- [ ] UT: <description> — verifies REQ-1
- [ ] UT: <description> — verifies REQ-2
- [ ] E2E: <description> — verifies REQ-1, REQ-2 (Phase 2 stub)
- [ ] E2E: <description> — verifies REQ-3 (Phase 2 stub)

## Requirements Coverage

| Requirement | Test File | Type | Status |
|-------------|-----------|------|--------|
| REQ-1 | `src/features/settings/__tests__/settings.test.ts` | Unit | Ready |
| REQ-2 | `src/features/settings/__tests__/theme.test.ts` | Unit | Ready |
| REQ-1 | `e2e/settings.e2e.ts` | E2E | Stub (Phase 2) |
| REQ-3 | `e2e/persistence.e2e.ts` | E2E | Stub (Phase 2) |

## Phase
Phase 1: Test writing (TDD). E2E stubs will be executed in Phase 2 after code is merged.

---
*Authored by @fredo-tester*
EOF

# Step 2: Create PR using body file, targeting the spec branch
gh pr create --draft --base spec/<issue-number>-<slug> --title "test: e2e and unit tests for <feature>" --body-file pr-body.md

# Step 3: Clean up
rm -f pr-body.md

# Step 4: Add labels
gh pr edit --add-label "test"

# Step 5: Verify attribution was included
CURRENT_BODY=$(gh pr view --json body -q .body)
if ! echo "$CURRENT_BODY" | grep -q "Authored by @fredo-tester"; then
  gh pr edit --body "$CURRENT_BODY

---
*Authored by @fredo-tester*"
fi
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