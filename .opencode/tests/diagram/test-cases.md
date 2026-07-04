---
feature: diagram
id: TC-DG-1
source:
type: event-driven
status: active
last_pass:
last_spec:
---

# Diagram renders infrastructure event as a node

**Prerequisites**: Dev instance running, Diagram feature open

**Steps**:
1. `$sid = "e2e-dg-" + (New-Guid).ToString().Substring(0, 8)`
2. Inject infrastructure init event via e2e-inject.ps1:
   `-EventType infrastructure -State init -ToolName kubernetes -Provider internal -SessionId $sid -CorrelationId "${sid}-1"`
3. Wait 2s
4. Take accessibility snapshot

**Expected**:
- Diagram canvas contains rendered nodes (not empty)
- Injected session ID visible in or near node
- No console errors matching "useDiagram" or "Diagram"

**Actual (last run)**: PENDING — N/A

---
---
feature: diagram
id: TC-DG-2
source:
type: interaction
status: active
last_pass:
last_spec:
---

# Diagram canvas supports zoom and pan interaction

**Prerequisites**: Dev instance running, Diagram feature open with at least one node visible

**Steps**:
1. Ensure a node is rendered (use TC-DG-1 if needed)
2. Scroll on the canvas: `tauri_webview_interact(action="scroll", selector="<diagram canvas>", strategy="css", scrollY=100)`
3. Wait 1s
4. Take accessibility snapshot

**Expected**:
- Diagram canvas scrollable (not frozen)
- No "Cannot read properties of undefined" errors in console during scroll
- Nodes remain visible (not all scrolled out of viewport)

**Actual (last run)**: PENDING — N/A

---
---
feature: diagram
id: TC-DG-3
source:
type: state
status: active
last_pass:
last_spec:
---

# Diagram settings persist across close/reopen

**Prerequisites**: Dev instance running, Diagram feature settings accessible

**Steps**:
1. Open Diagram settings (via settings dialog or feature settings)
2. Note current settings values
3. Close and reopen Diagram feature
4. Check settings via console/JS for persistence

**Expected**:
- Settings values survive feature close/reopen
- No "settings not found" or default reset warnings in console
- Settings are read from FeatureStore, not memory

**Actual (last run)**: PENDING — N/A

---
---
feature: diagram
id: TC-DG-4
source:
type: event-driven
status: active
last_pass:
last_spec:
---

# Multiple infrastructure events produce multiple diagram nodes

**Prerequisites**: Dev instance running, Diagram feature open

**Steps**:
1. `$sid = "e2e-dg-multi-" + (New-Guid).ToString().Substring(0, 8)`
2. Inject 3 infrastructure init events (different tool names: nginx, redis, postgres)
   Use unique correlation IDs: `${sid}-1`, `${sid}-2`, `${sid}-3`
3. Wait 3s
4. Take accessibility snapshot

**Expected**:
- Diagram contains at least 3 distinct nodes
- Nodes are not overlapping/collapsed into a single node
- No "duplicate key" or "node collision" warnings in console

**Actual (last run)**: PENDING — N/A
