---
name: dev-environment
description: Dev instance lifecycle management and E2E testing methodology. Loaded by the Self-Improver (orchestrator) and QA.
---

# Dev Environment — Lifecycle & E2E Testing

## Lifecycle

Single script: `.opencode/scripts/dev-env.ps1`

No state files. Ports (5174 Vite, 9223 MCP Bridge) are the source of truth. Dual-stack probing (IPv4 + IPv6).

| Action | Command | Description |
|--------|---------|-------------|
| Up | `powershell -File .opencode/scripts/dev-env.ps1 -Action Up` | Ensure dev instance is running AND ready. Auto-starts if not running. Polls ports until responsive. |
| Down | `powershell -File .opencode/scripts/dev-env.ps1 -Action Down` | Stop dev instance. Finds process by port, kills tree. |
| Status | `powershell -File .opencode/scripts/dev-env.ps1 -Action Status` | Read-only: `running` / `starting` / `stopped`. |
| Restart | `powershell -File .opencode/scripts/dev-env.ps1 -Action Restart` | Down then Up. |
| Logs | `powershell -File .opencode/scripts/dev-env.ps1 -Action Logs` | Tail process stdout/stderr. |

Optional parameters: `-VitePort 5174`, `-McpPort 9223`, `-TimeoutSecs 120`, `-Lines 50`

> **Which branch runs?** The dev instance builds whatever is checked out. Both the **Tester** and the **Developer** run against the **spec integration branch** — before `Up`, checkout `spec/<N>` (`git fetch origin spec/<N> && git checkout spec/<N>`) and pull the latest state. The Developer works in a worktree detached at `spec/<N>`'s tip; the Tester tests the accumulated feature on it. Never test against `main` mid-spec; the feature isn't there yet.

> **Worktree prerequisites (Tester + Developer).** A `git worktree` is a full checkout but has **no `node_modules`** — run `pnpm install` in it before `dev-env Up`, or `tauri dev` fails with "node_modules missing". Also ensure `spec/<N>` is synced with `main`'s pipeline config (`git fetch origin main && git merge origin/main` + push) before dispatching the tester — the tester's sandbox permissions come from the working tree's `opencode.json`, and a stale spec branch silently re-blocks it.

> **Fredo plugin prerequisite (live opencode runs).** The `opencode-cli-runner` skill checks `~\.config\opencode\plugins\fredo.js`. Ensure the plugin is installed: copy `apps/opencode-plugin/dist/index.js` → `~\.config\opencode\plugins\fredo.js` after building the plugin (`pnpm --filter @fredo/opencode-plugin build`). Without it, live `opencode run` emits no telemetry and the tester cannot verify Mission Monitor nodes.

### Typical agent workflow

```
# Start (or confirm running)
powershell -File .opencode/scripts/dev-env.ps1 -Action Up

# Connect MCP bridge
tauri_driver_session start

# ... run tests ...

# If webview freezes
powershell -File .opencode/scripts/dev-env.ps1 -Action Restart
tauri_driver_session start

# Check logs if something's wrong
powershell -File .opencode/scripts/dev-env.ps1 -Action Logs

# Leave running after testing — do NOT stop
```

## Connecting to the App

After `Up` reports ready:

```
tauri_driver_session start
```

Default window is "main". Use `tauri_manage_window(action="list")` to verify windows.

## Diagnostics

### Process logs (startup, Vite, Cargo build)

```
powershell -File .opencode/scripts/dev-env.ps1 -Action Logs
```

### Structured telemetry (error spans, traces, metrics)

For runtime errors, traces, and performance data from the Rust tracing subsystem, use the **telemetry-query** skill:

```
powershell -File .opencode/skills/telemetry-query/telemetry-query.ps1 -Query "SELECT ... FROM telemetry_logs WHERE level = 'ERROR'" -Format md
```

The telemetry-query skill has recipes for recent errors, latency percentiles, session traces, and more. Use it when process logs don't show enough detail.

## E2E Testing

### Prerequisites

- `dev-env.ps1 -Action Up` confirmed ready
- `tauri_driver_session start` connected
- Spec comment with EARS requirements and acceptance criteria

### Extracting Acceptance Criteria

Read the backlog issue: `gh issue view <backlog_N>`

Find the spec comment posted by the Architect. Extract the `## Acceptance Criteria` section. Each criterion is labeled (e.g., AC-R1, AC-R2). Only test ACs that are **user-observable** — UI visibility, interaction flows, error displays, state transitions. Skip ACs that are purely code-level.

### AC Testing Flow — DOM + Visual, Both Required

Every AC test must perform **both** DOM verification and visual (screenshot) verification. Either one can fail an AC.

```
1. tauri_webview_screenshot(filePath=".opencode/tmp/<issue>/e2e/baseline.jpeg")
   → Capture baseline before any interaction

2. tauri_webview_interact(action="click", selector="...", strategy="text")
   → Perform the AC's interaction

3. tauri_webview_screenshot(filePath=".opencode/tmp/<issue>/e2e/after-<action-slug>.jpeg")
   → Capture visual result

4. tauri_webview_dom_snapshot(type="accessibility")
   → Verify DOM semantics (text, roles, state)

5. **VISUAL VERIFICATION (MANDATORY):** Inspect the screenshot to confirm the expected visual element is actually rendered.
   - Does the screenshot show the expected node, text, toggle state, error message, or UI element?
   - If the AC says "graph renders nodes" but the screenshot shows an empty canvas → FAIL
   - If the AC says "toggle shows ON" but the screenshot shows OFF → FAIL
   - NEVER mark visual ACs as PARTIAL — either the expected visual state is visible (PASS) or it isn't (FAIL)

6. PASS only if ALL three gateways pass: DOM correct, no console errors, AND screenshot shows expected visual state
```

### Screenshot Conventions

**Directory:** `.opencode/tmp/<issue>/e2e/` (all scratch for an issue nests in its `.opencode/tmp/<issue>/` folder)

**Naming:**
```
baseline.jpeg                       # Before any interactions
after-<action-slug>.jpeg            # After each AC test action
final.jpeg                          # Final state after all ACs tested
```

Create the directory before testing:
```powershell
$dir = ".opencode/tmp/<issue>/e2e"
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force }
```

### What DOM catches vs what screenshots catch

| DOM snapshot | Screenshot |
|-------------|-----------|
| Text content correctness | Visual layout (positioning, spacing, overflow) |
| Element existence/absence | Theme/styling (colors, dark mode) |
| Accessibility labels | Error rendering (toast messages, red borders) |
| Interactive state (enabled/disabled) | Loading/skeleton states |
| Element hierarchy | Responsive behavior |

### DOM Test Patterns

**Pattern 1: Element Visibility (text, label, heading)**

```
tauri_webview_dom_snapshot(type="accessibility")
→ Scan for role + name combination
tauri_webview_screenshot(filePath="...<issue>/e2e/after-<element>.jpeg")
→ Confirm visual presence
```

**Pattern 2: Interactive Flow (click → result)**

```
tauri_webview_screenshot(filePath="...<issue>/e2e/before-<action>.jpeg")
tauri_webview_interact(action="click", selector="<button text>", strategy="text")
tauri_webview_screenshot(filePath="...<issue>/e2e/after-<action>.jpeg")
tauri_webview_dom_snapshot(type="accessibility")
→ Verify both DOM change and visual change
```

**Pattern 3: Form Input**

```
tauri_webview_keyboard(action="type", selector="<input label>", strategy="text", text="<value>")
tauri_webview_screenshot(filePath="...<issue>/e2e/after-<input>.jpeg")
tauri_webview_dom_snapshot(type="accessibility")
→ Check validation message visible in both DOM and screenshot
```

**Pattern 4: State Verification (JS)**

```
tauri_webview_execute_js(script="(() => { return localStorage.getItem('key'); })()")
tauri_webview_screenshot(filePath="...<issue>/e2e/after-<state-change>.jpeg")
→ JS confirms data persistence, screenshot confirms visual state
```

**Pattern 5: IPC / Backend Events**

```
tauri_ipc_monitor(action="start")
tauri_webview_interact(action="click", ...)
tauri_ipc_get_captured()
tauri_webview_screenshot(filePath="...<issue>/e2e/after-<ipc-action>.jpeg")
→ Verify IPC call was made and visual result is correct
```

**Pattern 6: Error Detection (logs + visual)**

```
tauri_read_logs(source="console", lines=20)
tauri_webview_screenshot(filePath="...<issue>/e2e/after-<error-trigger>.jpeg")
→ Logs show error, screenshot shows error UI (toast, inline error, red state)
```

**Pattern 7: Visual Regression**

When an AC involves visual correctness (layout, theme, responsive behavior):

```
tauri_webview_screenshot(filePath="...<issue>/e2e/after-<visual-check>.jpeg")
→ Inspect screenshot for: correct colors, proper spacing, no overflow, no clipping
→ DOM may show correct structure while rendering is broken — screenshot catches this
```

**Pattern 8: Regression Smoke Test (No User-Observable ACs)**

When a spec has zero user-observable ACs (performance audits, internal refactors, cleanup, infrastructure changes), run this smoke test to verify the app's core features still work. The Self-Improver (orchestrator) dispatches in "regression" mode.

**Checklist:**

| # | Check | Tool | PASS if |
|---|-------|------|---------|
| 1 | App window renders | `tauri_webview_dom_snapshot(type="structure")` | Non-empty DOM structure, `<body>` has children |
| 2 | No console errors | `tauri_read_logs(source="console", lines=50)` BEFORE and AFTER interactions | No `Error:` or `Uncaught` or `Maximum update depth exceeded` entries at any point. Check console TWICE: once on initial render, then again after all AC tests or event injection. Bug #523: "Maximum update depth exceeded" appeared only after ECE event injection, not on initial render — console check at Step 2 alone would miss it. |
| 3 | Mission Monitor accessible | Click "Mission Monitor" in toolbar, `tauri_webview_dom_snapshot(type="accessibility")` | Panel renders, sidebar/workspace elements present |
| 4 | Telemetry Settings accessible | Click gear icon or navigate to settings, `tauri_webview_dom_snapshot(type="accessibility")` | Settings dialog renders, sections visible |
| 5 | Screenshot captured | `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/<issue>/e2e/regression.jpeg")` | Screenshot saved successfully |
| 6* | Agent/Session nodes render (MANDATORY for ECE/mission-monitor specs) | Inject mock events via `fredo emit`, then `tauri_webview_dom_snapshot(type="structure")` inside Mission Monitor panel | Agent node visible in graph. If spec involves subagents, Subagent node visible and composited under parent. Graph is NOT empty. |
| 7* | Console errors after event injection (for ECE/mission-monitor specs) | `tauri_read_logs(source="console", lines=100)` AFTER completing all event injection + UI interactions | No `Error:`, `Uncaught`, or `Maximum update depth exceeded` entries. Bug #523: 11+ re-render errors appeared only after ECE delivery processing — invisible at initial app shell render. |

\* Steps 6-7 apply when the spec touches ECE, Mission Monitor graph rendering, session compositing, or event delivery infrastructure. The Self-Improver (orchestrator) should include these in the dispatch instructions for such specs.

**Report format:**
```
## E2E Regression Test — Backlog #N

| # | Check | Result | Evidence |
|---|-------|--------|----------|
| 1 | App window renders | PASS | DOM snapshot has body with children |
| 2 | No console errors | PASS | 0 errors in 50 console lines |
| 3 | Mission Monitor accessible | PASS | Panel in accessibility tree |
| 4 | Telemetry Settings accessible | PASS | Settings dialog in accessibility tree |
| 5 | Screenshot | PASS | ![regression](cdn-url) |

**Summary:** 5/5 passed — no regressions detected.
```

If any check fails, report it as a regression bug to the Self-Improver (orchestrator). Do NOT retry or diagnose — the Self-Improver dispatches a Developer for the fix.

**MCP Bridge IPC Limitation:** `tauri_ipc_execute_command` only supports a subset of Tauri commands. Feature-specific backend commands may return "Unsupported Tauri command". Do NOT treat this as FAIL — instead, verify backend state through the webview using `tauri_webview_execute_js(script="(() => { return __TAURI__.core.invoke('command_name', { ... }); })()")`.

### Pass/Fail Reporting Format

```
### E2E Results — Backlog #N

| AC | Description | Result | Evidence |
|----|-------------|--------|----------|
| AC-R1 | Settings panel renders | PASS | DOM: "Settings" heading found. Screenshot: `.opencode/tmp/<issue>/e2e/after-settings.jpeg` |
| AC-R2 | Dark mode toggle persists | FAIL | DOM: toggle state correct. Screenshot: colors unchanged (`.opencode/tmp/<issue>/e2e/after-toggle.jpeg`) |

**Summary:** 4/5 passed, 1 failed (AC-R2)

### Failed AC Details

**AC-R2: Dark mode toggle persists**
- Expected: Dark theme colors visible after toggle
- Actual: Screenshot shows light theme despite DOM toggle state = checked
- Screenshot: `.opencode/tmp/<issue>/e2e/after-toggle.jpeg`
- Likely cause: CSS variables not updating on toggle
```

### E2E Retry Policy

| Attempt | Action |
|---------|--------|
| First run | Run all ACs. Pass → set E2E, done. Fail → dispatch Developer fix. |
| Retry (1st) | Developer fixes, re-merge, re-run **only failed ACs**. Pass → set E2E. Still fail → bug. |
| Bug | Post bug comment with full DOM + screenshot evidence. Add `bug` label. Set status Reviewing. |

Do NOT retry more than once for e2e. A second failure signals a capsule design flaw.

### Webview Freeze Recovery

If the webview freezes or Tauri MCP tools hang during testing:

```
1. powershell -File .opencode/scripts/dev-env.ps1 -Action Restart
2. tauri_driver_session start
3. Re-run ONLY the ACs that failed due to freeze/hang
```

Retry up to 3 times. After 3 restart cycles, report "E2E BLOCKED: webview unresponsive after 3 restart attempts".

**NEVER substitute telemetry DB evidence, code inspection, or mock event data for visual DOM verification.** The e2e test exists to validate user-observable behavior. If the webview cannot be reached, the test is incomplete.

### Cleanup

```
tauri_driver_session stop
```

Do NOT stop the dev:tauri instance — leave it running for the next agent.
