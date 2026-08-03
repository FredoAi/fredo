---
name: spec-test-gen
description: Generates visual acceptance criteria from EARS requirements when a spec comment lacks an ## Acceptance Criteria section. Load when the QA finds a spec with no ACs — generates testable ACs from the requirements before proceeding with e2e verification.
---

# Spec Test Gen — AC Generation for E2E

## When to Use

Load this skill when `gh issue view <backlog_N>` reveals that the spec comment has **no `## Acceptance Criteria` section**, or the section is empty/placeholder. Do NOT load if ACs already exist — test those directly.

## Process

### 1. Extract Requirements

Read the spec comment. Find the `## Requirements` or `## EARS Requirements` section. Parse each requirement:

```
REQ-1: WHEN <trigger> THE <system> SHALL <behavior>
REQ-2: WHILE <state> THE <system> SHALL <behavior>
REQ-3: WHERE <condition> THE <system> SHALL <behavior>
```

### 2. Classify by Test Type

For each requirement, determine if it's user-observable:

| Requirement type | User-observable? | Test approach |
|-----------------|------------------|---------------|
| "X shall render/show/display" | Yes | Element visibility |
| "X shall persist/survive" | Yes | State verification |
| "X shall update/change when Y" | Yes | Interactive flow |
| "X shall validate/accept input" | Yes | Form input |
| "X shall emit/send/publish" | Maybe | IPC/backend (verify via webview) |
| "X shall store/write/compute" | Maybe | State verification (via JS) |
| "internal data structure" | No | Skip — code-only |
| "API response shape" | No | Skip — code-only |

### 3. Generate Visual ACs

For each user-observable requirement, generate one or more visual ACs using this template:

```
AC-<auto-N>: <requirement-summary> — <VERIFIABLE_outcome>
```

Make every AC **concrete and verifiable** from the running app. Use specific text, roles, counts, or CSS selectors that the tester can check with DOM tools:

| Requirement | Good AC | Bad AC |
|-------------|---------|--------|
| "Settings panel shall render" | "Settings panel contains heading 'Settings' and has at least 3 labeled sections" | "Settings panel works correctly" |
| "Toggle shall persist state" | "Toggle state survives page reload — localStorage key 'feature-toggle' retains value after reload" | "Toggle persists" |
| "List shall show items" | "List displays at least 1 item with role 'listitem'" | "List works" |
| "Button shall trigger X" | "Clicking button labeled 'Create' opens a dialog with heading 'New Item'" | "Button works" |

### 4. Map to Capsules

Read the issue's comments directly to resolve each REQ-ID to a capsule: `gh issue view <N> --comments`, search for `## Capsule: {name}`. If a capsule can't be resolved, mark it as `Capsule: Unknown (REQ-X)`.

### 5. Output

Write the generated ACs to `.opencode/tmp/e2e-reports/generated-acs-<N>.md`:

```
## Generated Acceptance Criteria — Backlog #N

*Auto-generated: spec had no AC section. Derived from EARS requirements.*

| AC | REQ | Capsule | Type | Description |
|----|-----|---------|------|-------------|
| AC-A1 | REQ-1 | Capsule: Settings UI (#X) | Element visibility | Settings panel contains heading "Settings" and 3+ labeled sections |
| AC-A2 | REQ-2 | Capsule: Toggle Logic (#Y) | State verification | Toggle state survives page reload — localStorage key "theme" retains value |
| AC-A3 | REQ-3 | Capsule: Settings UI (#X) | Interactive flow | Clicking "Dark Mode" toggle changes theme within 2s |
```

Then proceed with e2e testing using these generated ACs as if they came from the spec.

## Constraints

- **Never modify the spec or backlog** — these are generated for testing only
- **Never skip requirements** — if it's user-observable, it gets an AC
- **Never guess about layout/behavior** — derive ACs only from the EARS requirement text
- **Prefix generated ACs with `AC-A`** (auto-generated) to distinguish from spec-authored ACs
- **Report in the test results** that ACs were auto-generated due to missing AC section
