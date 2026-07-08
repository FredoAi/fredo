---
name: tauri-e2e
description: Automated DOM-based end-to-end testing methodology for Tauri apps. Load when the Reviewer runs e2e verification of spec acceptance criteria using the Tauri MCP bridge, or when any agent needs to test a running Tauri app through DOM snapshots, element inspection, and interaction simulation.
---

# Tauri E2E — DOM-Based Testing

## Prerequisites

- `pnpm dev:tauri` instance running (verify with `dev-tauri-manager.ps1 -Action Status`)
- Tauri MCP driver session connected (`tauri_driver_session start`)
- Spec comment with EARS requirements and acceptance criteria

## Dev Instance Lifecycle

The Reviewer reuses the same `pnpm dev:tauri` instance across specs. Do NOT stop it after testing.

| Step | Command |
|------|---------|
| Check status | `powershell -File .opencode/scripts/dev-tauri-manager.ps1 -Action Status` |
| Start if stopped | `powershell -File .opencode/scripts/dev-tauri-manager.ps1 -Action Start` |
| Wait for ready | `powershell -File .opencode/scripts/dev-tauri-manager.ps1 -Action WaitForReady -TimeoutSecs 120` |
| Read logs | `powershell -File .opencode/scripts/dev-tauri-manager.ps1 -Action Logs` |

The state file at `.opencode/state/dev-tauri.json` tracks PID, ports, and status. This directory is gitignored.

## Webview Freeze Recovery

If the webview freezes or Tauri MCP tools hang during testing:

| Step | Command |
|------|---------|
| 1. Stop dev instance | `powershell -File .opencode/scripts/dev-tauri-manager.ps1 -Action Stop` |
| 2. Start dev instance | `powershell -File .opencode/scripts/dev-tauri-manager.ps1 -Action Start` |
| 3. Wait for ready | `powershell -File .opencode/scripts/dev-tauri-manager.ps1 -Action WaitForReady -TimeoutSecs 120` |
| 4. Reconnect MCP | `tauri_driver_session start` (MCP function call) |
| 5. Retry ACs | Re-run ONLY the ACs that failed due to freeze/hang |

**Constraints:**
- Retry up to 3 times. After 3 restart cycles, report "E2E BLOCKED: webview unresponsive after 3 restart attempts".
- **NEVER substitute telemetry DB evidence, code inspection, or mock event data for visual DOM verification.** The e2e test exists to validate user-observable behavior. If the webview cannot be reached, the test is incomplete — not passable by alternate means. Restart the runtime environment and retry.

## Connecting to the App

```
tauri_driver_session start
```

After connecting, the default window is "main". Use `tauri_manage_window(action="list")` to verify windows.

## Extracting Acceptance Criteria from Spec

Read the backlog issue: `gh issue view <backlog_N>`

Find the spec comment posted by the Architect. Extract the `## Acceptance Criteria` section. Each criterion is labeled (e.g., AC-R1, AC-R2). Only test ACs that are **user-observable** — UI visibility, interaction flows, error displays, state transitions. Skip ACs that are purely code-level (e.g., "the hook uses useMemo").

## DOM Test Patterns

### Pattern 1: Element Visibility (text, label, heading)

An AC says "X should be visible" or "the page shows Y".

```
tauri_webview_dom_snapshot(type="accessibility")
```

Scan the accessibility tree for the expected role + name combination. Use `tauri_webview_find_element(strategy="text", selector="<expected text>")` to confirm exact wording.

Pass: element found with correct accessible name.
Fail: element missing or name mismatches.

### Pattern 2: Interactive Flow (click → result)

An AC says "when the user clicks X, Y happens".

```
tauri_webview_interact(action="click", selector="<button text>", strategy="text")
tauri_webview_dom_snapshot(type="accessibility", selector="<result region>")
```

If the result opens a dialog or new page, use `tauri_manage_window(action="list")` to verify.

Pass: interaction produces expected DOM change within 3 seconds.
Fail: DOM unchanged or wrong element appears.

### Pattern 3: Form Input

An AC says "typing in field X shows validation Y".

```
tauri_webview_keyboard(action="type", selector="<input label>", strategy="text", text="<test value>")
tauri_webview_dom_snapshot(type="accessibility")
```

After typing, check the snapshot for the expected validation message or state change.

Pass: validation/feedback matches expectation.
Fail: no feedback or wrong message.

### Pattern 4: State Verification (JS)

An AC says "the setting persists across reload" or "the store contains X".

```
tauri_webview_execute_js(script="(() => { return localStorage.getItem('key'); })()")
tauri_webview_execute_js(script="(() => { return JSON.parse(document.getElementById('root').__reactFiber$...)... })()")
```

Use JS to read runtime state that isn't visible in DOM snapshots.

Pass: JS return value matches expected state.
Fail: value missing or incorrect.

### Pattern 5: IPC / Backend Events

An AC involves backend behavior (IPC commands, events).

```
tauri_ipc_monitor(action="start")
tauri_webview_interact(action="click", ...)
tauri_ipc_get_captured()
```

Start monitoring, trigger the action, inspect captured IPC calls.

Pass: expected IPC command invoked with correct args / response matches.
Fail: missing IPC call or wrong response.

**⚠️ MCP Bridge IPC Limitation:** `tauri_ipc_execute_command` only supports a subset of Tauri commands known to the MCP bridge. Feature-specific backend commands (e.g., `feature_store_delete`, `feature_store_insert`, `feature_store_query`) may return "Unsupported Tauri command". Do NOT treat this as FAIL — instead, verify backend state through the webview:

- Use `tauri_webview_execute_js(script="(() => { return __TAURI__.core.invoke('feature_store_delete', { ... }); })()")` to call backend commands from the webview context
- Use `tauri_webview_execute_js` to read frontend state (React fiber hooks, component props, Context values) to infer backend state
- The absence of captured IPC via `tauri_ipc_execute_command` does NOT mean the feature isn't working — it means the MCP bridge doesn't support that command

### Pattern 6: Error Detection (logs)

```
tauri_read_logs(source="console", lines=20)
tauri_read_logs(source="system", lines=20)
```

After an interaction, check logs for errors or warnings.

Pass: no errors in relevant category.
Fail: error logged related to the AC.

### Pattern 7: Regression Smoke Test (No User-Observable ACs)

When a spec has zero user-observable ACs (performance audits, internal refactors, cleanup, infrastructure changes), run this smoke test to verify the app's core features still work. The Reviewer dispatches in "regression" mode.

**Checklist:**

| # | Check | Tool | PASS if |
|---|-------|------|---------|
| 1 | App window renders | `tauri_webview_dom_snapshot(type="structure")` | Non-empty DOM structure, `<body>` has children |
| 2 | No console errors | `tauri_read_logs(source="console", lines=50)` | No `Error:` or `Uncaught` entries related to core features |
| 3 | Mission Monitor accessible | Click "Mission Monitor" in toolbar, `tauri_webview_dom_snapshot(type="accessibility")` | Panel renders, sidebar/workspace elements present |
| 4 | Telemetry Settings accessible | Click gear icon or navigate to settings, `tauri_webview_dom_snapshot(type="accessibility")` | Settings dialog renders, sections visible |
| 5 | Screenshot captured | `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/e2e/spec-<N>/regression.jpeg")` | Screenshot saved successfully |

**Report format:**
```
## E2E Regression Test — Backlog #N

| # | Check | Result | Evidence |
|---|-------|--------|----------|
| 1 | App window renders | PASS | DOM snapshot has body with children |
| 2 | No console errors | PASS | 0 errors in 50 lines |
| 3 | Mission Monitor accessible | PASS | Panel "Mission Monitor" in accessibility tree |
| 4 | Telemetry Settings accessible | PASS | Dialog "Settings" in accessibility tree |
| 5 | Screenshot | PASS | ![regression](cdn-url) |

**Summary:** 5/5 passed — no regressions detected.
```

If any check fails, report it as a regression bug to the Reviewer. Do NOT retry or diagnose — the Reviewer dispatches a Coder for the fix.

## Pass/Fail Reporting Format

After testing each AC, report in this format:

```
### E2E Results — Backlog #N

| AC | Description | Result | Evidence |
|----|-------------|--------|----------|
| AC-R1 | Settings panel renders | PASS | Element "Settings" found in accessibility tree |
| AC-R2 | Dark mode toggle persists | FAIL | localStorage key "theme" missing after toggle + reload |

**Summary:** 4/5 passed, 1 failed (AC-R2)

### Failed AC Details

**AC-R2: Dark mode toggle persists**
- Expected: localStorage key "theme" = "dark" after clicking toggle
- Actual: localStorage key "theme" missing after click + reload
- Stack trace from console: (none)
- Likely cause: Capsule not reading from theme store before writing
```

## E2E Retry Policy

| Attempt | Action |
|---------|--------|
| First run | Run all ACs. Pass → set E2E, done. Fail → dispatch Coder fix. |
| Retry (1st) | Coder fixes, re-merge, re-run **only failed ACs**. Pass → set E2E. Still fail → bug. |
| Bug | Post bug comment with full DOM evidence. Add `bug` label. Set status Reviewing. Report in Final Report. |

Do NOT retry more than once for e2e. E2E failures mean the capsule passed code review but broke at runtime — the Coder already burned their trust. A second failure signals a capsule design flaw needing deeper analysis.

## Cleanup

```
tauri_driver_session stop
```

Do NOT stop the dev:tauri instance — leave it running for the next agent.
