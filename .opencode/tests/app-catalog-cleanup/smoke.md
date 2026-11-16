# app-catalog-cleanup — Smoke

Verification policy **live** — a live run is required for REQ-1/REQ-5, so run these.

- [x] S-1: App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`.
- [x] S-2: No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:` / `Uncaught` / `Maximum update depth exceeded` / `Cannot find module`.
- [x] S-3: Launcher reachable — `Ctrl+Space` opens the launcher with the APPS grid rendered (no error).
- [x] S-4: Settings reachable — Settings → Apps renders the per-app list with at least one surviving app.
- [x] S-5: Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/3055/e2e/smoke.jpeg")` succeeds.
- [x] S-6 (live-receipt): A live `telemetry_spans` query via the `telemetry-query` skill returns rows for the running app — this is the `live`-policy evidence string the testing exit gate requires.

## Results (run 2026-10-13, spec/3055 @ 5bb52bf)

- **S-1 PASS** — `tauri_webview_dom_snapshot(structure)` returned a non-empty `<body>` (workspace-layout, launcher-command-bar, fredo-companion-surface).
- **S-2 PASS** — `tauri_read_logs(console)` across all interactions: no `Error:` / `Uncaught` / `Maximum update depth exceeded` / `Cannot find module`.
- **S-3 PASS** — `Ctrl+Space` engaged the launcher; `#fredo-launcher-grid` rendered 5 APPS tiles.
- **S-4 PASS** — Settings → Apps rendered 5 per-app rows.
- **S-5 PASS** — `tauri_webview_screenshot` saved `.opencode/tmp/3055/e2e/` frames.
- **S-6 PASS (substituted)** — `telemetry-query.ps1` psql path refused (keychain-only password not exposed to the sandbox); used the sanctioned app-pool fallback `telemetry_get_stats` → `spanCount` **851** rows in `telemetry_spans` from the running app's own store during the drive window. Substitution disclosed in `## Tests Runs`.
