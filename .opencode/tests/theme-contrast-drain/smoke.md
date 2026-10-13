# theme-contrast-drain — smoke

> App-boots + core-path sanity for Spec #3035. Standard boilerplate, adapted.

- [ ] S-1: App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`.
- [ ] S-2: No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`.
- [ ] S-3: Feature surfaces reachable — Settings → **Database** (`settings-postgres-section`), Settings → **Layout** (`layout-new-button`), and the **PostgreSQL app** (`db-connection-form` / `db-query-run`) all render their expected elements.
- [ ] S-4: Theme presets switchable — Appearance selects `classic` (dark default) and `Light Default` without error.
- [ ] S-5: Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/3035/e2e/smoke.jpeg")` succeeds.
