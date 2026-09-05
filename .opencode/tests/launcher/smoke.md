# Launcher — Smoke

> Standardized boilerplate (from `.opencode/tests/README.md`) adapted to the launcher
> surface. Runs on a running Fredo desktop app with the spec branch.

- [ ] S-1: App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`
- [ ] S-2: No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`
- [ ] S-3: Launcher shell reachable — the launcher's entry point renders the FREDO notch + avatar + `>` command bar + grid
- [ ] S-4: Telemetry Settings accessible — gear/nav opens the settings dialog with sections visible
- [ ] S-5: Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/2808/e2e/smoke.jpeg")` succeeds
