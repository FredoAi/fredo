---
name: dev-environment
description: Fredo dev instance lifecycle management and E2E testing methodology. Load when any agent needs to start, stop, check status, diagnose the local development instance, or run E2E tests against the running app.
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
1. tauri_webview_screenshot(filePath=".opencode/tmp/e2e/spec-NNN/baseline.jpeg")
   → Capture baseline before any interaction

2. tauri_webview_interact(action="click", selector="...", strategy="text")
   → Perform the AC's interaction

3. tauri_webview_screenshot(filePath=".opencode/tmp/e2e/spec-NNN/after-<action-slug>.jpeg")
   → Capture visual result

4. tauri_webview_dom_snapshot(type="accessibility")
   → Verify DOM semantics (text, roles, state)

5. PASS only if BOTH DOM and screenshot confirm expected behavior
```

### Screenshot Conventions

**Directory:** `.opencode/tmp/e2e/spec-NNN/`

**Naming:**
```
spec-NNN-baseline.jpeg              # Before any interactions
spec-NNN-after-<action-slug>.jpeg   # After each AC test action
spec-NNN-final.jpeg                 # Final state after all ACs tested
```

Create the directory before testing:
```powershell
$dir = ".opencode/tmp/e2e/spec-NNN"
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
tauri_webview_screenshot(filePath="...spec-NNN/after-<element>.jpeg")
→ Confirm visual presence
```

**Pattern 2: Interactive Flow (click → result)**

```
tauri_webview_screenshot(filePath="...spec-NNN/before-<action>.jpeg")
tauri_webview_interact(action="click", selector="<button text>", strategy="text")
tauri_webview_screenshot(filePath="...spec-NNN/after-<action>.jpeg")
tauri_webview_dom_snapshot(type="accessibility")
→ Verify both DOM change and visual change
```

**Pattern 3: Form Input**

```
tauri_webview_keyboard(action="type", selector="<input label>", strategy="text", text="<value>")
tauri_webview_screenshot(filePath="...spec-NNN/after-<input>.jpeg")
tauri_webview_dom_snapshot(type="accessibility")
→ Check validation message visible in both DOM and screenshot
```

**Pattern 4: State Verification (JS)**

```
tauri_webview_execute_js(script="(() => { return localStorage.getItem('key'); })()")
tauri_webview_screenshot(filePath="...spec-NNN/after-<state-change>.jpeg")
→ JS confirms data persistence, screenshot confirms visual state
```

**Pattern 5: IPC / Backend Events**

```
tauri_ipc_monitor(action="start")
tauri_webview_interact(action="click", ...)
tauri_ipc_get_captured()
tauri_webview_screenshot(filePath="...spec-NNN/after-<ipc-action>.jpeg")
→ Verify IPC call was made and visual result is correct
```

**Pattern 6: Error Detection (logs + visual)**

```
tauri_read_logs(source="console", lines=20)
tauri_webview_screenshot(filePath="...spec-NNN/after-<error-trigger>.jpeg")
→ Logs show error, screenshot shows error UI (toast, inline error, red state)
```

**Pattern 7: Visual Regression**

When an AC involves visual correctness (layout, theme, responsive behavior):

```
tauri_webview_screenshot(filePath="...spec-NNN/after-<visual-check>.jpeg")
→ Inspect screenshot for: correct colors, proper spacing, no overflow, no clipping
→ DOM may show correct structure while rendering is broken — screenshot catches this
```

**MCP Bridge IPC Limitation:** `tauri_ipc_execute_command` only supports a subset of Tauri commands. Feature-specific backend commands may return "Unsupported Tauri command". Do NOT treat this as FAIL — instead, verify backend state through the webview using `tauri_webview_execute_js(script="(() => { return __TAURI__.core.invoke('command_name', { ... }); })()")`.

### Pass/Fail Reporting Format

```
### E2E Results — Backlog #N

| AC | Description | Result | Evidence |
|----|-------------|--------|----------|
| AC-R1 | Settings panel renders | PASS | DOM: "Settings" heading found. Screenshot: spec-461/after-settings.jpeg |
| AC-R2 | Dark mode toggle persists | FAIL | DOM: toggle state correct. Screenshot: colors unchanged (spec-461/after-toggle.jpeg) |

**Summary:** 4/5 passed, 1 failed (AC-R2)

### Failed AC Details

**AC-R2: Dark mode toggle persists**
- Expected: Dark theme colors visible after toggle
- Actual: Screenshot shows light theme despite DOM toggle state = checked
- Screenshot: spec-461/after-toggle.jpeg
- Likely cause: CSS variables not updating on toggle
```

### E2E Retry Policy

| Attempt | Action |
|---------|--------|
| First run | Run all ACs. Pass → set E2E, done. Fail → dispatch Coder fix. |
| Retry (1st) | Coder fixes, re-merge, re-run **only failed ACs**. Pass → set E2E. Still fail → bug. |
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
