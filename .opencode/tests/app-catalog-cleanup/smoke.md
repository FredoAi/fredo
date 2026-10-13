# app-catalog-cleanup — Smoke

Verification policy **live** — a live run is required for REQ-1/REQ-5, so run these.

- [ ] S-1: App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`.
- [ ] S-2: No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:` / `Uncaught` / `Maximum update depth exceeded` / `Cannot find module`.
- [ ] S-3: Launcher reachable — `Ctrl+Space` opens the launcher with the APPS grid rendered (no error).
- [ ] S-4: Settings reachable — Settings → Apps renders the per-app list with at least one surviving app.
- [ ] S-5: Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/3055/e2e/smoke.jpeg")` succeeds.
- [ ] S-6 (live-receipt): A live `telemetry_spans` query via the `telemetry-query` skill returns rows for the running app — this is the `live`-policy evidence string the testing exit gate requires.
