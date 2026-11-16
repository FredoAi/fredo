# Smoke — fredo-health-led

Standardized boilerplate adapted to the launcher LED surface.

- [x] **S-1:** App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`.
- [x] **S-2:** No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:` / `Uncaught` / `Maximum update depth exceeded`.
- [x] **S-3:** Feature surface reachable — `[data-testid="desktop-status-led"]` renders in the launcher chrome.
- [x] **S-4:** Telemetry Settings accessible — the gear/nav opens the settings dialog with sections visible.
- [x] **S-5:** Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80)` into `.opencode/tmp/3052/e2e/`; reference the frame by name in prose (no bare image-extension token — G-104).
