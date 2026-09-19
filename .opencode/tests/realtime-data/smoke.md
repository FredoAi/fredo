# Realtime Data Layer — Smoke (Spec #2896)

## Standard boilerplate

- [ ] S-1: App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`.
- [ ] S-2: No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`.
- [ ] S-3: Feature surface reachable — Mission Monitor (the first consumer) opens and its session list renders.
- [ ] S-4: Telemetry Settings accessible — gear/nav opens the settings dialog with sections visible.
- [ ] S-5: Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/<issue>/e2e/smoke.jpeg")` succeeds.

## Realtime-data quick path

- [ ] S-6: Read with no watch open — invoke `feature_data_read` for a declared scope on a persisted DB; the result is non-empty when rows exist and matches `telemetry_spans`/the row store at the same instant.
- [ ] S-7: Table watch live — with no session selected, emit an `agent_session` event via `fredo emit` (unique `e2e-<guid8>` session id); the new entry appears in the consuming list without reopening.
- [ ] S-8: Idempotent create — invoke `feature_data_declare` twice; no error and the feature-namespaced table exists exactly once (read-only `sqlite_master`/`pragma_table_info` query).
- [ ] S-9: Restart durability — fully stop/start the app, reopen the consumer; persisted entries are present with no duplicates.
- [ ] S-10: Isolation — query feature B's namespace after writing to feature A; zero cross-feature rows appear and a cross-namespace access is refused.
