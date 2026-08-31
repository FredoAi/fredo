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

## Cleaning the Fredo DB (fresh-slate reset for live e2e)

Single script: `.opencode/scripts/clean-fredo-db.ps1` (allowed for the tester + self-improver).

The tester **cannot** `Remove-Item` the live DB directly — the sandbox allowlist only permits `.opencode/*` paths, so a raw `Remove-Item "C:\Users\...\fredo.db"` is DENIED and the agent loops. Use the script instead; it is a single allowed `powershell -File` call.

| Command | Description |
|---------|-------------|
| `powershell -File .opencode/scripts/clean-fredo-db.ps1` | Stop dev instance (`dev-env.ps1 -Action Down`), delete `%APPDATA%\com.fredo.app\fredo.db` (+ `-wal`/`-shm`), verify deletion. |
| `powershell -File .opencode/scripts/clean-fredo-db.ps1 -Restart` | Clean, then restart the dev instance (`dev-env.ps1 -Action Up`). |

Notes:
- The app holds `fredo.db` open (WAL) while running, so it MUST be stopped first — the script does this. If you see "fredo.db still present", the app is still up.
- The schema is recreated on next launch (`CREATE TABLE IF NOT EXISTS` / `ensure_schema`), so a deleted DB is a fully clean slate.
- This wipes `feature_mission-monitor_*` tables AND `telemetry_spans`/`telemetry_metrics`/`telemetry_logs` — everything. Use it when a spec AC requires "fresh DBs" (e.g. Mission Monitor e2e) or when the DB has bloated (a stray DB has grown to ~1.9 GB from accumulated telemetry).
- The thousands of `.tmpXXXXXX\fredo.db` files under `%TEMP%` are Rust unit-test temp DBs — never clean those manually; they are test debris, ignore them.
- Run the clean BEFORE `dev-env.ps1 -Action Up` for the next test session.

## Bounded telemetry polling (CONFIRM gates)

Single script: `.opencode/scripts/wait-telemetry.ps1` (allowed for the tester).

Runs a readonly sqlite3 query against the live `fredo.db` in a bounded polling loop (Start-Sleep INSIDE the script — safe for sandboxes that ban direct sleep) until the query returns at least one row or the attempt budget is spent. Prints each attempt's row count. Use it for CONFIRM-COMPLETE telemetry gates (e.g. `telemetry_spans` fixture-session / task-edge queries) instead of many manual query roundtrips.

| Command | Description |
|---------|-------------|
| `powershell -File .opencode/scripts/wait-telemetry.ps1 -Query "SELECT ... " -Attempts 20 -IntervalSec 15` | Poll every 15 s, up to 20 attempts. Exit 0 as soon as ≥1 row (a bare `0` aggregate result counts as zero rows), 1 on timeout, 2 on query/DB-not-found errors, 3 on sqlite failure. |

Notes:
- Readonly guardrail: only SELECT / PRAGMA / WITH accepted (same DDL/DML rejection as `telemetry-query.ps1`); the `-readonly` connection never blocks the running app.
- On timeout the condition was NEVER met — treat the leg as not converged (BLOCKED-environment or genuine stall per the governing fix plan); never record a mid-flight partial result as evidence.

## Process hygiene (orphaned opencode/node cleanup)

Single script: `.opencode/scripts/process-hygiene.ps1` (allowed for the tester).

Prior rounds' kill paths (Run CLI close, `dev-env.ps1 -Action Down`) kill only the direct child; on Windows opencode resolves to a `.cmd`/`.bat` shim whose cmd.exe → node.exe descendants survive, hold locks in the fixture workdir, and block a fresh `opencode run` before its first byte (observed #2762 rounds 1-4: Run CLI stuck at "Starting OpenCode…" with zero PTY bytes). Run `-List` once after every `Up`, before launching Run CLI.

| Command | Description |
|---------|-------------|
| `powershell -File .opencode/scripts/process-hygiene.ps1 -List` | Read-only inventory: opencode/node/fredo processes (PID, PPID, creation time, CommandLine) + the PIDs owning 9223/4317/4318/5174, with orphan flags. |
| `powershell -File .opencode/scripts/process-hygiene.ps1 -KillOrphans` | OPT-IN single-pass cleanup of orphaned opencode/node processes. Prints every kill decision (PID + why) and a summary line (orphans found / killed / failures / skipped). |
| `powershell -File .opencode/scripts/dev-env.ps1 -Action Hygiene [-Kill] [-Spec <N>]` | Passthrough when direct execution of `process-hygiene.ps1` is denied by the shell: resolves the sibling copy next to `dev-env.ps1` first, then the served worktree copy `.serve/<N>/.opencode/scripts/process-hygiene.ps1` (with `-Spec`), and runs it as a child powershell (`-Kill` → `-KillOrphans`, default → `-List`). Prints which copy was invoked and its exit code; "not found" exits 1 — distinguishable from "no orphans" (exit 0). |

Notes:
- Kill scope is deliberately narrow: only opencode/node processes in a DEAD tree (an ancestral parent PID is no longer alive) or whose CommandLine references `.serve\2762`. The script NEVER kills its own shell ancestry or any descendant of it, anything with a live `fredo.exe` ancestor (the current run's children, e.g. the active Run CLI PTY), or `fredo.exe` itself.
- Orphan flags in `-List` are advisory; nothing is killed without the explicit `-KillOrphans` pass.
- A CONFIRM-STARTED gate usage: after `open_run_cli`, `-List` must show a NEW opencode/node process carrying the fixture workdir in its CommandLine, parented under the CURRENT fredo PID, AND the PTY buffer non-empty — only then submit the fixture prompt.
- A mismatch between the PID owning :9223 and the current run's `fredo.exe` (process start time after `Up`) means an orphaned instance owns the port — full `Down`, verify :9223 is free via `-List`, then `Up` again.

> **Which branch runs?** The dev instance builds whatever is checked out. Both the **Tester** and the **Developer** run against the **spec integration branch** — before `Up`, checkout `spec/<N>` (`git fetch origin spec/<N> && git checkout spec/<N>`) and pull the latest state. The Developer works in a worktree detached at `spec/<N>`'s tip; the Tester tests the accumulated feature on it. Never test against `main` mid-spec; the feature isn't there yet.

> **Worktree prerequisites (Tester + Developer).** A `git worktree` is a full checkout but has **no `node_modules`** — run `pnpm install` in it before `dev-env Up`, or `tauri dev` fails with "node_modules missing". Also ensure `spec/<N>` is synced with `main`'s pipeline config (`git fetch origin main && git merge origin/main` + push) before dispatching the tester — the tester's sandbox permissions come from the working tree's `opencode.json`, and a stale spec branch silently re-blocks it.

> **Fredo plugin prerequisite (live opencode runs).** Live opencode sessions are launched through Fredo's Run CLI feature, which requires the Fredo OpenCode plugin at `~\.config\opencode\plugins\fredo.js`. **The tester must NOT install it by copying files outside the repo** (the tester sandbox only allows `Copy-Item * .opencode/*`). Install the plugin through the app's native path: the **Fredo Setup → SetupWizard** UI, or the `install_plugin` Tauri command via the MCP bridge (`features/setup/commands.rs` writes `~/.config/opencode/plugins/fredo.js`). Build it first with `bun build src/index.ts --outdir dist --target bun` in `apps/opencode-plugin`. Verify with `Test-Path ~\.config\opencode\plugins\fredo.js` (allowed). Without the plugin, live opencode sessions emit no telemetry and the tester cannot verify spans/events. The tester never invokes the `opencode` binary from a shell — Run CLI launches opencode itself. **`Test-Path` proves presence, NOT currency** (G-047): a plugin fix merged to the spec branch is invisible to live runs until the plugin is REBUILT from the spec branch tip and re-installed through the native path — the installed file can silently lag the branch (observed #2745 rounds 2-6: installed file lacked the R-3 fix symbol, so live runs produced NULL child attrs / zero telemetry despite a clean environment). After a plugin-source change, rebuild from the branch tip, re-install via SetupWizard/`install_plugin`, and verify the installed file carries the fix's defining symbol before the live run.

> **G-084 — NEVER Grep the installed plugin path.** Do NOT use the Grep tool (or any interactive search tool) against `~\.config\opencode\plugins\fredo.js` — the `~` home-dir path is not usable by the Grep tool in this sandbox on Windows; the call stalls and the agent waits indefinitely (observed #2770 rounds 3-4: two tester rounds lost). Verify currency with these sandbox-safe PowerShell methods instead:
> 1. **Hash comparison (proves byte-equality → currency):** `Get-FileHash ~\.config\opencode\plugins\fredo.js` vs `Get-FileHash apps\opencode-plugin\dist\index.js`. Equal SHA256 hashes prove the installed plugin is byte-identical to the built bundle — no further symbol check is needed.
> 2. **`Select-String -LiteralPath` with BUNDLE-FORM anchors:** if hashes differ, check the fix's symbol via `Select-String -LiteralPath "$env:USERPROFILE\.config\opencode\plugins\fredo.js" -Pattern '<anchor>'`. Anchors MUST be in **bundle form** — bundling may flatten source expressions (e.g. source `pending.startMs <= time.created` → bundle `startMs <= createdAt`), so derive the anchor from the built `apps/opencode-plugin/dist/index.js` (grep THAT file, not the source), never from `src/*.ts`.

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

### MCP bridge wedge — the "everything live is dead" signature (G-046)

When ALL live-AC evidence fails at once (Mission Monitor won't mount, Run CLI stalls at "Starting OpenCode…", `install_plugin` times out) while static checks pass and the frontend console is clean, check the logs for the wedged MCP bridge:

```
[ MCP ][ WS_SERVER ][ERROR] WebSocket connection error: Handshake not finished
```

A wedged WS server blocks every MCP-command path (including `install_plugin` and Run CLI) and survives `clean-fredo-db.ps1 -Restart`. Recovery is a **full Down → Up** (`dev-env.ps1 -Action Down` kills the process tree holding :9223/:5174, then `-Action Up`); verify the clean handshake log line (`[MCP][WS_SERVER][INFO] WebSocket server listening on: 127.0.0.1:9223`) before re-dispatching the tester. Never loop a round back to implementation on this signature alone — it is an environment wedge, not a spec defect (observed #2745 rounds 2-4).

### MCP driver-session staleness — the `resolveRef is not a function` signature (G-067)

Distinct from the G-046 wedge: the app is HEALTHY, but every **ref-based** tool (`webview_find_element`, `webview_interact`, `webview_get_pointed_element`) fails with `window.__MCP__.resolveRef is not a function` or `Cannot read properties of undefined (reading 'resolveRef')`, while `webview_execute_js` and `webview_screenshot` still work.

Root cause: the MCP server injects the `window.__MCP__` helper namespace into the webview **once per driver session, at session init**. A Vite HMR reload or app restart wipes the namespace and it is **never re-injected** on the surviving/reconnecting session. Observed #2758 rounds 6-16.

**Preflight before ANY ref-based driving** (cheap one-liner):

```
tauri_webview_execute_js: (() => JSON.stringify({ mcp: !!window.__MCP__, ref: !!(window.__MCP__ && typeof window.__MCP__.resolveRef === 'function') }))
```

Remediation ladder when `ref` is false:
1. **Stop + start the driver session** (`driver_session` stop → start) — a fresh session re-injects the namespace. This fixes it in seconds if the app itself is settled (verified 2026-08-26).
2. If the app was JUST started, wait for it to finish loading first (a blank/white webview means Vite is still bootstrapping — injecting into it gets wiped by the pending reload), then do step 1.
3. Still failing after a fresh session → escalate to the full Down → Up (G-046 path above), wait for full render, then a fresh driver session again.

Never loop implementation rounds on this signature — it is tooling state, not a product defect.

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

**The element under test MUST be completely shown.** Before capturing an AC screenshot, ensure the element/region the AC describes is **fully in view and uncut**: scroll/zoom/pan (or `tauri_webview_interact`/resize the window) so the whole element — e.g. the entire session token bar, the full node card, the complete panel — fits inside the viewport with no clipping. A screenshot that cuts off the element (partial bar, half a node, a panel edge) does not prove the AC — capture the whole thing. Verify via the DOM (`getBoundingClientRect` within viewport bounds, or a structure snapshot) that the element is fully visible before shooting, and prefer a `maxWidth` on the screenshot call that keeps the whole viewport rather than a crop.

**Measure layout width, not zoom-scaled rects (G-040).** When a test asserts rendered WIDTH/GEOMETRY, measure the LAYOUT width (element `offsetWidth`, or the component/library store width), never `getBoundingClientRect().width` — the rect is transform-scaled whenever the viewport is zoomed (ReactFlow graph canvases are almost always non-identity). A measured width near `expected × zoom` (e.g. 320.7 ≈ 480 × 0.668) is the signature of a zoom-scaled rect, not a width defect.

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

**Pattern 9: React pointer-handler interactions (drag/resize with pointer capture)**

`tauri_webview_interact(action="swipe"/"drag")` dispatches browser-level events that React's `onPointerDown`/`onPointerMove` handlers (especially with `setPointerCapture`) do NOT receive — the interaction silently no-ops. To drive such UI (e.g. a drag-to-resize panel handle), dispatch programmatic PointerEvents via `tauri_webview_execute_js`:

```
tauri_webview_execute_js(script="(() => { const h = document.querySelector('[aria-label=\"Resize detail panel\"]'); const r = h.getBoundingClientRect(); const p = (x, y) => new PointerEvent('pointerdown', {bubbles: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true}); h.dispatchEvent(p(r.x + 1, r.y + 10)); /* then pointermove(s), then pointerup */ })()")
```

Note: the component under test may call `setPointerCapture`, which jsdom and some webview drivers drop — guard the handler accordingly. Verify state via `tauri_webview_dom_snapshot` (e.g. `aria-valuenow` on the handle) rather than assuming the drag took effect (G-021).

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
