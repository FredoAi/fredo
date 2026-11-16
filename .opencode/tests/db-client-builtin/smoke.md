# db-client-builtin — Smoke

Short standardized checks that the app boots and the built-in-connection core path works. Runs on
this feature's testing phase and as part of any regression-smoke touching the `database-client`
surface.

> **Verification policy: LIVE** — S-3..S-6 observe the running app + embedded cluster.

## Cases

- [ ] **S-1: App window renders** — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`.
- [ ] **S-2: No console errors** — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`.
- [ ] **S-3: Feature surface reachable** — the PostgreSQL app opens and `db-connections-panel` renders with the seeded `db-connection-row-builtin-fredo`.
- [ ] **S-4: Built-in badge visible** — `db-connection-builtin-badge` is present in the built-in row.
- [ ] **S-5: One-click connect** — clicking the built-in row connects with NO credential prompt and a `SELECT 1` returns `1` (≤10 s).
- [ ] **S-6: Screenshot captured** — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/3029/e2e/smoke.jpeg")` succeeds.
