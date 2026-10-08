# Applications Rename — Smoke

> Standardized boilerplate (from `.opencode/tests/README.md`) adapted to the rename surface. Runs
> on a running Fredo desktop app with the `spec/2956` branch. **Verification policy: live.**

- [ ] **S-1: App window renders** — `tauri_webview_dom_snapshot(type="structure")` returns a
  non-empty `<body>` after the rename tree move (`features/` → `applications/`).
- [ ] **S-2: No console errors** — `tauri_read_logs(source="console", lines=50)` shows no `Error:` /
  `Uncaught` / `Maximum update depth exceeded` (the pre-existing `motion() is deprecated` WARN is
  exempt).
- [ ] **S-3: Launcher surface reachable with the new vocabulary** — the engaged launcher renders
  the grid with heading/`aria-label` reading "Applications" (short "Apps" allowed) and every tile
  accessible name equal to its display name; no user-facing "Feature" for the concept.
- [ ] **S-4: Data layer live** — invoke one `application_data_read` (or open Mission Monitor so it
  reads its declared table) and confirm rows return; `tauri_ipc_monitor` shows no `featureBatch`
  discriminator.
- [ ] **S-5: Screenshot captured** —
  `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/2956/e2e/smoke.jpeg")`
  succeeds.
- [ ] **S-6: `fredo open-app` still works** — `fredo open-app mission-monitor` exits 0 and opens
  the Mission Monitor window (no duplicate).
- [ ] **S-7: PostgreSQL-default boot** — the app boots on the default PG engine; Mission Monitor
  renders at least one live session row and a same-instant `telemetry_spans` query returns the
  landed spans.
