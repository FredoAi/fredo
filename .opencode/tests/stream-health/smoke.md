# Smoke — stream-health

Standardized boilerplate adapted to the stream/telemetry health surface.

- [ ] **S-1:** App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`.
- [ ] **S-2:** No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:` / `Uncaught` / `Maximum update depth exceeded`.
- [ ] **S-3:** Feature surface reachable — `[data-testid="desktop-status-led"]` renders in the launcher chrome; its tooltip exposes `[data-testid="health-line-telemetry"]` with a `data-health-state`.
- [ ] **S-4:** Telemetry Settings accessible — the gear/nav opens the settings dialog with sections visible.
- [ ] **S-5:** Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80)` into `.opencode/tmp/3064/e2e/`; reference the frame by name in prose (no bare image-extension token — G-104).
- [ ] **S-6:** `stream_health` command responds — `tauri_ipc_execute_command(command="stream_health")` returns a `StreamHealthSnapshot` (`seq`, `ingestConnected`, `ageMs`, `forced`) on a healthy boot.
