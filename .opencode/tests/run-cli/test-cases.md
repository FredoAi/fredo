---
feature: run-cli
id: TC-RC-1
source:
type: interaction
status: active
last_pass:
last_spec:
---

# Terminal window opens and displays a PTY prompt

**Prerequisites**: Dev instance running, Run CLI feature visible in toolbar

**Steps**:
1. Click Run CLI toolbar button: `tauri_webview_interact(action="click", selector="Run CLI", strategy="text")`
2. Wait 3s for PTY initialization
3. Take accessibility snapshot: `tauri_webview_dom_snapshot(type="accessibility")`

**Expected**:
- Terminal panel is visible (not display:none, has children)
- PTY prompt or shell indicator visible in terminal (e.g., `$`, `>`, `PS`)
- No console errors matching "RunCli" or "pty"

**Actual (last run)**: PENDING — N/A

---
---
feature: run-cli
id: TC-RC-2
source:
type: interaction
status: active
last_pass:
last_spec:
---

# Terminal accepts keyboard input and echoes text

**Prerequisites**: Dev instance running, Run CLI terminal open (from TC-RC-1)

**Steps**:
1. Click into terminal area: `tauri_webview_interact(action="click", selector="terminal", strategy="css")`
2. Type a test command: `tauri_webview_keyboard(action="type", selector="terminal", strategy="css", text="echo e2e-test-echo")`
3. Press Enter: `tauri_webview_keyboard(action="press", key="Enter")`
4. Wait 2s
5. Take structure snapshot or check terminal text via JS

**Expected**:
- Typed text "echo e2e-test-echo" is visible in terminal
- After Enter, output contains "e2e-test-echo" (the echo'd text)
- No PTY crash or disconnection

**Actual (last run)**: PENDING — N/A

---
---
feature: run-cli
id: TC-RC-3
source:
type: interaction
status: active
last_pass:
last_spec:
---

# Terminal can be closed and reopened without errors

**Prerequisites**: Dev instance running, Run CLI terminal open

**Steps**:
1. Close the Run CLI panel
2. Wait 1s
3. Reopen Run CLI: click toolbar button
4. Wait 3s
5. `tauri_read_logs(source="console", lines=20)`

**Expected**:
- Terminal reopens with a fresh PTY prompt
- No "PTY already in use" or "port already bound" errors in console
- No memory leak warnings (e.g., "listener not cleaned up")

**Actual (last run)**: PENDING — N/A

---
---
feature: run-cli
id: TC-RC-4
source:
type: state
status: active
last_pass:
last_spec:
---

# Settings persist across terminal restart

**Prerequisites**: Dev instance running, Run CLI settings accessible

**Steps**:
1. Open Run CLI settings
2. Note current settings values
3. Verify settings persist via JS (check FeatureStore or localStorage):
   `tauri_webview_execute_js(script="(() => { return localStorage.getItem('run-cli-settings'); })()")`

**Expected**:
- Settings values are stored (not null/undefined)
- Settings survive terminal close/reopen cycle
- No "settings not found" warnings in console

**Actual (last run)**: PENDING — N/A
