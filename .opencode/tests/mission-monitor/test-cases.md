---
feature: mission-monitor
id: TC-MM-1
source: AC-R1, Backlog #311
type: event-driven
status: active
last_pass:
last_spec:
---

# Session node renders on chat event

**Prerequisites**: Dev instance running, Mission Monitor open, unique test session ID

**Steps**:
1. Generate unique session ID: `$sid = "e2e-mm-" + (New-Guid).ToString().Substring(0, 8)`
2. Inject chat init event:
   `powershell -File .opencode/scripts/e2e-inject.ps1 -EventType chat -State init -ToolName assistant -Provider open-code -SessionId $sid -CorrelationId $sid`
3. Wait 2s
4. Take accessibility snapshot: `tauri_webview_dom_snapshot(type="accessibility")`

**Expected**:
- Session node with `$sid` present in accessibility tree
- Node is NOT aria-hidden or display:none
- No console errors matching "MissionMonitor" or "buildGraph"

**Actual (last run)**: PENDING — N/A

---
---
feature: mission-monitor
id: TC-MM-2
source: AC-R2, Backlog #311
type: event-driven
status: active
last_pass:
last_spec:
---

# Tool use node appears in graph on init event

**Prerequisites**: Dev instance running, Mission Monitor open, unique test session ID

**Steps**:
1. `$sid = "e2e-mm-" + (New-Guid).ToString().Substring(0, 8)`
2. Inject tool_use init event:
   `e2e-inject.ps1 -EventType tool_use -State init -ToolName Bash -Provider open-code -SessionId $sid -CorrelationId "${sid}-1"`
3. Wait 2s
4. Take structure snapshot: `tauri_webview_dom_snapshot(type="structure")`

**Expected**:
- Graph container contains a node with tool name "Bash" or session ID `$sid` in its text content
- No empty container (node count > 0)

**Actual (last run)**: PENDING — N/A

---
---
feature: mission-monitor
id: TC-MM-3
source: AC-R3, Backlog #311
type: event-driven
status: active
last_pass:
last_spec:
---

# Tool use node increments counter on response event

**Prerequisites**: Dev instance running, Mission Monitor open, unique test session ID

**Steps**:
1. `$sid = "e2e-mm-counters-" + (New-Guid).ToString().Substring(0, 8)`
2. `$cid = [guid]::NewGuid().ToString()`
3. Inject init: `e2e-inject.ps1 -EventType tool_use -State init -ToolName Read -Provider open-code -SessionId $sid -CorrelationId $cid`
4. Wait 2s
5. Inject response: `e2e-inject.ps1 -EventType tool_use -State response -ToolName Read -Provider open-code -SessionId $sid -CorrelationId $cid`
6. Wait 2s
7. Verify via JS: `tauri_webview_execute_js(script="(() => { const nodes = document.querySelectorAll('[data-testid*=\"tool\"], [data-id*=\"tool\"]'); return nodes.length; })()")`

**Expected**:
- Init event creates a node
- Response event updates the node (no duplicate node with same correlation ID)
- No console errors matching "counters" or "increment"

**Actual (last run)**: PENDING — N/A

---
---
feature: mission-monitor
id: TC-MM-4
source: AC-R4, Backlog #311
type: event-driven
status: active
last_pass:
last_spec:
---

# Agent session lifecycle creates and completes a session

**Prerequisites**: Dev instance running, Mission Monitor open, unique test session ID

**Steps**:
1. `$sid = "e2e-mm-lifecycle-" + (New-Guid).ToString().Substring(0, 8)`
2. Inject agent_session init:
   `e2e-inject.ps1 -EventType agent_session -State init -ToolName opencode -Provider open-code -SessionId $sid`
3. Wait 2s
4. Inject agent_session response:
   `e2e-inject.ps1 -EventType agent_session -State response -ToolName opencode -Provider open-code -SessionId $sid`
5. Wait 2s
6. Find element: `tauri_webview_find_element(strategy="text", selector="$sid")`

**Expected**:
- Session element found in DOM with `$sid`
- Session lifecycle displays completed/completing state (not stuck in "init")
- Session appears in sidebar session list

**Actual (last run)**: PENDING — N/A

---
---
feature: mission-monitor
id: TC-MM-5
source: AC-R5, Backlog #440
type: event-driven
status: active
last_pass:
last_spec:
---

# Subagent events appear in parent session graph

**Prerequisites**: Dev instance running, Mission Monitor open, parent session visible

**Steps**:
1. `$parentSid = "e2e-mm-parent-" + (New-Guid).ToString().Substring(0, 8)`
2. `$childSid = "e2e-mm-child-" + (New-Guid).ToString().Substring(0, 8)`
3. Inject parent tool_use (task tool) init + response:
   `e2e-inject.ps1 -EventType tool_use -State init -ToolName task -Provider open-code -SessionId $parentSid -CorrelationId "${parentSid}-1"`
   `e2e-inject.ps1 -EventType tool_use -State response -ToolName task -Provider open-code -SessionId $parentSid -CorrelationId "${parentSid}-1" -Payload "{`"tool_response`":{`"metadata`":{`"parentSessionId`":`"$parentSid`",`"sessionId`":`"$childSid`"}}}"`
4. Inject child chat event:
   `e2e-inject.ps1 -EventType chat -State init -ToolName assistant -Provider open-code -SessionId $childSid -CorrelationId "${childSid}-1"`
5. Wait 2s
6. Find parent element: `tauri_webview_find_element(strategy="text", selector="$parentSid")`

**Expected**:
- Parent session node visible in graph
- Child session ID does NOT appear in sidebar session list (suppressed)
- Child events visible within parent session's graph nodes

**Actual (last run)**: PENDING — N/A

---
---
feature: mission-monitor
id: TC-MM-6
source: AC-R6, Backlog #440
type: state
status: active
last_pass:
last_spec:
---

# Graph rebuilds correctly when nodes change status (order-independent)

**Prerequisites**: Dev instance running, Mission Monitor open, unique test session ID

**Steps**:
1. `$sid = "e2e-mm-rebuild-" + (New-Guid).ToString().Substring(0, 8)`
2. Inject init event for Tool A: `e2e-inject.ps1 -EventType tool_use -State init -ToolName ToolA -Provider open-code -SessionId $sid -CorrelationId "${sid}-a"`
3. Inject init event for Tool B: `e2e-inject.ps1 -EventType tool_use -State init -ToolName ToolB -Provider open-code -SessionId $sid -CorrelationId "${sid}-b"`
4. Wait 2s
5. Inject response for Tool A: `e2e-inject.ps1 -EventType tool_use -State response -ToolName ToolA -Provider open-code -SessionId $sid -CorrelationId "${sid}-a"`
6. Wait 2s

**Expected**:
- Graph contains nodes for both ToolA and ToolB
- ToolA node transitions to response/complete state without removing ToolB node
- No ReactFlow warning about missing parent nodes in console

**Actual (last run)**: PENDING — N/A

---
---
feature: mission-monitor
id: TC-MM-7
source:
type: state
status: active
last_pass:
last_spec:
---

# Session history persists across Mission Monitor close/reopen

**Prerequisites**: Dev instance running, at least one session in Mission Monitor from real events or prior test

**Steps**:
1. Open Mission Monitor, note visible sessions in accessibility tree
2. Close Mission Monitor panel
3. Wait 2s
4. Reopen Mission Monitor
5. Take accessibility snapshot

**Expected**:
- Previously visible sessions are still present (not cleared on close)
- Session selector shows same sessions as before close
- No console errors matching "persistence" or "FeatureStore"

**Actual (last run)**: PENDING — N/A

---
---
feature: mission-monitor
id: TC-MM-8
source:
type: event-driven
status: active
last_pass:
last_spec:
---

# Error event displays error state in graph node

**Prerequisites**: Dev instance running, Mission Monitor open, unique test session ID

**Steps**:
1. `$sid = "e2e-mm-err-" + (New-Guid).ToString().Substring(0, 8)`
2. Inject tool_use init: `e2e-inject.ps1 -EventType tool_use -State init -ToolName Bash -Provider open-code -SessionId $sid -CorrelationId "${sid}-err"`
3. Wait 1s
4. Inject tool_use error: `e2e-inject.ps1 -EventType tool_use -State error -ToolName Bash -Provider open-code -SessionId $sid -CorrelationId "${sid}-err" -Payload "{`"error`":{`"message`":`"e2e-test: intentional failure`"}}"`
5. Wait 2s
6. Find error element: search accessibility tree for role "alert" or text containing "error" near session ID

**Expected**:
- Error indicator visible in or near the node (not a blank/empty node)
- Error text or icon present (not silently swallowed)
- No additional console errors (expected error is UI state, not runtime crash)

**Actual (last run)**: PENDING — N/A

---
---
feature: mission-monitor
id: TC-MM-9
source: AC-R7, Backlog #440
type: interaction
status: active
last_pass:
last_spec:
---

# Clicking a node selects it (not just on drag)

**Prerequisites**: Dev instance running, Mission Monitor open with at least one visible graph node (from real events or test injection)

**Steps**:
1. Inject a session if none visible: use TC-MM-1 steps to create a node
2. Click the node: `tauri_webview_interact(action="click", selector="<node element>", strategy="css")`
3. Take accessibility snapshot of the node

**Expected**:
- Node enters `.selected` state after click (not only after drag)
- Node has visual indicator of selection (border, highlight, etc.)
- `selectNodesOnDrag` is not preventing click-to-select

**Actual (last run)**: PENDING — N/A
