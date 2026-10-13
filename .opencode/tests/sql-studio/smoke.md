# sql-studio — Smoke

Short standardized checks that the app boots and the SQL Studio app's core path works. Runs on
this feature's testing phase and as part of any regression-smoke touching the `database-client`
surface.

> **Verification policy: LIVE** — S-3..S-7 observe the running app.

## Cases

- [ ] **S-1: App window renders** — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`.
- [ ] **S-2: No console errors** — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`.
- [ ] **S-3: Feature surface reachable** — the app opens (identity "SQL Studio") and `db-connections-panel` renders with the seeded `db-connection-row-builtin-fredo`.
- [ ] **S-4: No header strip** — no in-app header strip (icon + title + badge) is present above the workspace; the workspace is flush to the app root top.
- [ ] **S-5: Badge gone** — `db-access-mode-badge` is absent from the DOM.
- [ ] **S-6: Connect + disconnect** — clicking the built-in "Fredo" row connects with NO credential prompt (`SELECT 1` → `1`, ≤10 s); the relocated Disconnect affordance is reachable and tears the session down.
- [ ] **S-7: Screenshot captured** — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/3048/e2e/smoke.jpeg")` succeeds (screenshot evidence to user-attachments).

## Run log

### Round 1 — 2026-10-13 (spec/3048 @ bc741d6) — Verdict: **PASS**

S-1..S-7 all PASS. Console clean after all interactions (no `Error:`/`Uncaught`/
`Maximum update depth exceeded`). Relocated Disconnect reachable; teardown returns the row to `idle`.
