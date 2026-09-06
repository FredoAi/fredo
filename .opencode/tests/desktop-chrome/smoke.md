# desktop-chrome — Smoke

- [x] S-1: App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`
- [x] S-2: No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`
  - Note (spec/2825 run): the only console `Error:` lines were `Uncaught TypeError: target.hasAttribute is not a function at reactflow.js:3525` — AUTOMATION ARTIFACT, not a product defect. Both bursts (06:00:50, 06:01:33) occurred exactly when the tester dispatched a synthetic `document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'}))`; ReactFlow's keydown handler assumes `event.target.hasAttribute`, which `document` lacks. A real `webview_keyboard` Escape produced no new error. No `Maximum update depth exceeded`, no re-render loop. Benign WARNs: `motion() is deprecated`, `React Flow parent container needs width/height` (transient mount warning).
- [x] S-3: Feature surface reachable — a feature window (e.g. Mission Monitor) opens and renders its `WindowChrome` titlebar (min/max/close controls present)
- [x] S-4: Telemetry Settings accessible — gear/nav opens the settings dialog with sections visible
- [x] S-5: Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/<issue>/e2e/smoke.jpeg")` succeeds
- [x] S-6: Desktop chrome (FREDO logo band + clock) and the bottom LED pair render on the desktop surface
  - **SUPERSEDED by #2830.** This was the #2825 check for the bottom LED pair. #2830 REMOVES the bottom-center LED pair (`StreamStatus`) — the current desktop surface renders the FREDO band + clock + a SINGLE top-right status LED (no bottom LEDs). See S-7 for the current expectation; keep this row as the #2825 record.

## #2830 extension — single top-right status LED smoke

- [x] S-7: The desktop renders exactly ONE status LED top-right, below the clock — `tauri_webview_dom_snapshot(type="structure")` shows a single status-LED element in the top-right `<time>` cluster (below the HH:MM clock text), NO bottom-center status LEDs, and NO visible `ONLINE`/`OFFLINE` text label; `tauri_webview_screenshot` succeeds; console clean of `Error:`/`Uncaught`/`Maximum update depth exceeded`. **PASS (spec/2830 round 1):** `ledCount=1` in the top-right `<time>` cluster below the `02:49` clock; `statusRoles=["Online"]`; `bottomCenterRadiusDots=0`; no visible `ONLINE`/`OFFLINE` text; console clean (only the stale pre-test Vite HMR note for the deleted `StreamStatus.tsx`).
