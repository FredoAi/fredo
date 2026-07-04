# Run CLI — Smoke Test

Runs in <30s. If this fails, do NOT proceed to AC testing.

---

## SM-RC-1: Feature opens from toolbar without errors

**Steps**:
1. Click Run CLI toolbar button
2. Wait 3s
3. `tauri_read_logs(source="console", lines=20)` + `tauri_webview_dom_snapshot(type="accessibility")`

**Expected**:
- Terminal panel visible in accessibility tree
- No console errors matching "RunCli", "pty", "terminal", or "spawn"
- Panel is NOT zero dimensions or display:none

**FAIL if**: Panel missing OR console error present

---

## SM-RC-2: PTY process spawns successfully

**Steps**:
1. After SM-RC-1 passes, check terminal content via JS:
   `tauri_webview_execute_js(script="(() => { const term = document.querySelector('[class*=\"terminal\"], [class*=\"xterm\"]'); return term ? term.textContent.substring(0, 100) : 'NOT_FOUND'; })()")`

**Expected**:
- Terminal element found in DOM
- Text content is NOT empty and NOT "NOT_FOUND"
- Terminal shows shell prompt (indicates PTY spawned)

**FAIL if**: Terminal element NOT_FOUND OR text content is empty

---

## SM-RC-3: IPC commands for PTY management are registered

**Steps**:
1. Start IPC monitoring: `tauri_ipc_monitor(action="start")`
2. Close Run CLI panel
3. `tauri_ipc_get_captured()`

**Expected**:
- `close_run_cli` command was invoked (PTY was cleaned up)
- No "command not found" errors in captured IPC

**FAIL if**: No PTY close command captured (polling may miss it — flag as "inconclusive" not FAIL)

---

**Smoke test result**: PENDING — N/A
