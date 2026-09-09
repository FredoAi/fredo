# app-dock — Smoke

- [ ] S-1: App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`
- [ ] S-2: No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`
- [ ] S-3: Dock surface reachable — open ≥1 window (launcher grid / desktop toolbar); the dock renders its open-app entries (Sidebar default: left-edge rail `[data-testid="app-dock"]` / `role="region" aria-label="Open applications"` → `list` → `listitem` per open app)
- [ ] S-4: Telemetry Settings accessible — gear/nav opens the settings dialog with sections visible
- [ ] S-5: Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/<issue>/e2e/smoke.jpeg")` succeeds
- [ ] S-6: Settings → Appearance shows the Dock position field — open Settings (`[aria-label="Settings"]`) → Appearance section; a **Dock position** control renders with **Sidebar** and **Bottom bar** options, default **Sidebar** on an existing install
