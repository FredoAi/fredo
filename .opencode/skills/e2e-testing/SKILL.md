---
name: e2e-testing
description: Use ONLY when fredo-tester needs to write, run, or debug e2e tests for the Tauri desktop app. Covers Tauri MCP workflows including UI automation, IPC monitoring, console inspection, and requirement verification.
---

# E2E Testing — fredo-tester (Tauri Desktop App)

## Overview

This skill guides e2e testing of the **Tauri desktop app** using the **Tauri MCP** (`@hypothesi/tauri-mcp-server`). The MCP provides 21 tools for UI automation, IPC monitoring, console inspection, and device management — all designed for Tauri v2 apps.

**Do NOT use Playwright** — this is a native desktop app, not a web page. Use the Tauri MCP tools exclusively.

## Prerequisites — MANDATORY STARTUP SEQUENCE

**You MUST complete these steps before any testing:**

### Step 1: Start the Tauri Dev Server

```bash
# From repo root — this starts Vite + Tauri window
pnpm dev:tauri
```

Wait for the Tauri window to appear. The app must be running before you can test it.

### Step 2: Verify MCP Bridge is Connected

The Tauri MCP server (`@hypothesi/tauri-mcp-server`) must be running and connected to the app. Check that the MCP tools are available in your tool list.

If MCP tools are not available:
1. Verify `tauri-plugin-mcp-bridge` is in `Cargo.toml`
2. Verify the plugin is registered in `lib.rs` or `main.rs`
3. Ask the architect or coder to run the `/setup` slash command

### Step 3: Start Automation Session

Before any interaction, start a driver session:

```
tool: driver_session
action: "start"
port: 9223
```

**Do NOT proceed to testing until the session is started and the app is visible.**

## Tauri MCP Tools Available

### UI Automation
| Tool | Purpose |
|------|---------|
| `driver_session` | Start/stop/status automation session |
| `webview_screenshot` | Capture webview screenshots |
| `webview_find_element` | Find elements by selector |
| `webview_interact` | Click, scroll, swipe, focus, long-press |
| `webview_keyboard` | Type text or send key events |
| `webview_wait_for` | Wait for elements, text, or events |
| `webview_dom_snapshot` | Get structured accessibility tree |
| `webview_get_styles` | Get computed CSS styles |
| `webview_execute_js` | Execute JavaScript in webview |
| `webview_select_element` | Visual element picker |
| `webview_get_pointed_element` | Get element user Alt+Shift+Clicked |
| `manage_window` | List windows, get info, resize |

### IPC & Plugin
| Tool | Purpose |
|------|---------|
| `ipc_execute_command` | Execute Tauri IPC commands |
| `ipc_get_backend_state` | Get app metadata and state |
| `ipc_monitor` | Start/stop IPC monitoring |
| `ipc_get_captured` | Get captured IPC traffic |
| `ipc_emit_event` | Emit custom events |

### Logs & Devices
| Tool | Purpose |
|------|---------|
| `read_logs` | Read console, Android, iOS, or system logs |
| `list_devices` | List Android devices and iOS simulators |

## Spec-Driven Testing Workflow

### 1. Read the Spec Issue

```bash
gh issue view <issue-number> --comments
```

Extract:
- Requirements (REQ-1, REQ-2, etc.)
- Acceptance criteria (AC-1, AC-2, etc.)
- Test Plan section (if filled)
- Coder's PR diff: `gh pr diff <pr-number>`

### 2. START THE APP (MANDATORY)

**You cannot test without a running app.**

```bash
pnpm dev:tauri
```

Wait for the Tauri window to appear. Verify the app is loaded.

### 3. Start MCP Automation Session

```
tool: driver_session
action: "start"
port: 9223
```

Verify the session started successfully before proceeding.

### 4. Test Each Requirement

For each REQ-X:

#### Step A: Take Screenshot
```
tool: webview_screenshot
```
Verify the UI state matches expected behavior.

#### Step B: Interact with the App
```
tool: webview_interact
action: "click"
selector: "[data-testid='feature-button']"
```

#### Step C: Verify Result
```
tool: webview_screenshot
```
Or check DOM state:
```
tool: webview_dom_snapshot
```

#### Step D: Check for Errors
```
tool: read_logs
source: "console"
```

#### Step E: Monitor IPC (if testing Tauri commands)
```
tool: ipc_monitor
action: "start"
```
Then after interaction:
```
tool: ipc_get_captured
```

### 4. Example: Testing a Feature Panel Opens

```
# 1. Screenshot home grid
webview_screenshot → verify features are visible

# 2. Click the feature
webview_interact
  action: "click"
  selector: "[data-testid='my-feature']"

# 3. Wait for panel to appear
webview_wait_for
  type: "element"
  selector: "[data-testid='my-feature-panel']"

# 4. Screenshot to verify
webview_screenshot → verify panel is open

# 5. Check console for errors
read_logs
  source: "console"
```

### 5. Testing IPC Commands

When testing features that invoke Tauri commands:

```
# 1. Start IPC monitoring
ipc_monitor
  action: "start"

# 2. Trigger the action in the app
webview_interact
  action: "click"
  selector: "[data-testid='trigger-button']"

# 3. Check IPC traffic
ipc_get_captured

# 4. Verify the command was called with correct args
# Look for the expected IPC call in the captured traffic
```

### 6. Testing Stream Events

When testing features that emit stream events (Rust → UI):

```
# 1. Start IPC monitoring
ipc_monitor
  action: "start"

# 2. Trigger the action
webview_interact
  action: "click"
  selector: "[data-testid='action-button']"

# 3. Wait for stream event response
webview_wait_for
  type: "text"
  text: "Expected response text"

# 4. Verify IPC traffic shows the event
ipc_get_captured

# 5. Screenshot final state
webview_screenshot
```

## Test Plan Format (fill into spec issue)

```markdown
### Test Plan
- [ ] E2E: <test description> — verifies REQ-1, REQ-2 (Tauri MCP: screenshot + interact)
- [ ] E2E: <test description> — verifies REQ-3 (Tauri MCP: IPC monitoring)
- [ ] E2E: <test description> — verifies REQ-4 (Tauri MCP: console logs)
```

## Report Test Results

Comment on the spec issue:

```markdown
## Test Results

| Requirement | Status | Evidence |
|-------------|--------|----------|
| REQ-1 | PASS | screenshot-home.png |
| REQ-2 | PASS | screenshot-panel.png |
| REQ-3 | FAIL | screenshot-error.png — see console logs |

## IPC Traffic
<List any IPC calls verified or missing>

## Console Errors
<List any errors found, or "None">

## Bugs Found
<List any bugs discovered, or "None">

## Bugs Fixed
<List any bugs fixed by coder, or "None">

## Confidence Level
<High/Medium/Low — with reasoning>

---
*Generated by @fredo-tester*
```

## Collaboration with Coder

When you find bugs:
1. Comment on the issue: "@fredo-coder Found bugs: <list>. Please fix."
2. Wait for coder to push fixes
3. Re-run tests using Tauri MCP tools
4. If more bugs found, repeat step 1
5. When all tests pass, proceed to create your test PR

## Constraints

- **ALWAYS start the Tauri app first** — `pnpm dev:tauri` before any testing
- **ALWAYS start a driver session** — `driver_session` tool before any interaction
- **Always test against the spec** — verify every REQ-X
- **Screenshot every pass** — visual evidence for validation
- **Monitor IPC** when testing Tauri command integrations
- **Check console logs** after every interaction
- **Document failures** — comment on issue with screenshots and logs
- **Do not modify production code** — only test files
- **Map every test to REQ-X** — traceability is mandatory
- **Stop if tests reveal bugs** — comment on the issue and wait for fixes
- **Do NOT use Playwright** — this is a Tauri desktop app, use Tauri MCP tools only
