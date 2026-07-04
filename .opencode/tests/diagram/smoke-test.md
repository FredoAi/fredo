# Diagram — Smoke Test

Runs in <30s. If this fails, do NOT proceed to AC testing.

---

## SM-DG-1: Feature panel renders without console errors

**Steps**:
1. Open Diagram feature from toolbar
2. Wait 2s
3. `tauri_read_logs(source="console", lines=20)` + `tauri_webview_dom_snapshot(type="accessibility")`

**Expected**:
- Diagram panel visible in accessibility tree
- No console errors matching "Diagram", "useDiagram", or "render"
- Panel is NOT zero dimensions or display:none

**FAIL if**: Panel missing OR console error present

---

## SM-DG-2: Responds to mock infrastructure event

**Steps**:
1. `$sid = "smoke-dg-" + (New-Guid).ToString().Substring(0, 8)`
2. `e2e-inject.ps1 -EventType infrastructure -State init -ToolName smoke-test -Provider internal -SessionId $sid -CorrelationId "${sid}-smoke"`
3. Wait 2s
4. `tauri_webview_find_element(strategy="text", selector="$sid")`

**Expected**:
- Element with `$sid` found in DOM
- Element is NOT empty or containing "undefined"/"null" text

**FAIL if**: Element not found after 3 retries (1s each)

---

## SM-DG-3: Diagram canvas exists with appropriate dimensions

**Steps**:
1. With Diagram open, execute JS:
   `tauri_webview_execute_js(script="(() => { const canvas = document.querySelector('[class*=\"diagram\"], [class*=\"canvas\"], svg, canvas'); if (!canvas) return 'NO_CANVAS'; const rect = canvas.getBoundingClientRect(); return { w: rect.width, h: rect.height }; })()")`

**Expected**:
- Canvas element found (not NO_CANVAS)
- Canvas has non-zero width and height (> 10px each)
- Canvas fills at least 50% of the panel

**FAIL if**: NO_CANVAS OR zero dimensions

---

**Smoke test result**: PENDING — N/A
