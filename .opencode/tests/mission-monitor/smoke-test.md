# Mission Monitor — Smoke Test

Runs in <30s. If this fails, do NOT proceed to AC testing — the feature is fundamentally broken.

---

## SM-MM-1: Panel renders without console errors

**Steps**:
1. Open Mission Monitor panel
2. `tauri_read_logs(source="console", lines=20)`

**Expected**:
- 0 errors matching "MissionMonitor", "useMissionMonitor", "buildGraph", or "ReactFlow"
- Panel is visible (not display:none, not zero dimensions)
- Graph container exists in DOM

**FAIL if**: Console error present OR panel missing from DOM

---

## SM-MM-2: Responds to mock chat event

**Steps**:
1. `$sid = "smoke-mm-" + (New-Guid).ToString().Substring(0, 8)`
2. `e2e-inject.ps1 -EventType chat -State init -ToolName assistant -Provider open-code -SessionId $sid -CorrelationId $sid`
3. Wait 2s
4. `tauri_webview_find_element(strategy="text", selector="$sid")`

**Expected**:
- Element with `$sid` found in DOM
- Element is NOT empty or containing "undefined"/"null" text

**FAIL if**: Element not found after 3 retries (1s each) OR element text is "undefined"/"null"

---

## SM-MM-3: Session sidebar is populated

**Steps**:
1. Open Mission Monitor
2. `tauri_webview_dom_snapshot(type="accessibility")`

**Expected**:
- Session selector or sidebar contains at least 1 session entry
- Empty state message is acceptable if no real events exist ("No sessions" is valid)

**FAIL if**: Sidebar renders with a JavaScript error OR sidebar is completely missing

---

## SM-MM-4: No leaked session IDs or unmapped nodes

**Steps**:
1. Open Mission Monitor
2. `tauri_read_logs(source="console", lines=50)`

**Expected**:
- No warnings/errors matching "parent not found", "orphaned node", "missing session", or "edge without parent"
- No warnings matching "childToParentSession"

**FAIL if**: Any of these patterns appear in console

---

## SM-MM-5: Graph renders without ReactFlow errors

**Steps**:
1. Inject a single tool_use event (any name, any session)
2. Wait 2s
3. `tauri_read_logs(source="console", lines=20)`

**Expected**:
- No ReactFlow errors (e.g., "Cannot get node", "edge has no source", "node not found")
- No "Invalid node" or "Invalid edge" warnings
- Graph container has children (not an empty `<div>`)

**FAIL if**: Any ReactFlow error OR graph container is empty after event injection

---

**Smoke test result**: PENDING — N/A
