# Event persistence smoke tests

- [ ] S-1: App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`
- [ ] S-2: No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`
- [ ] S-3: Feature surface reachable — Mission Monitor opens; the stepper-probe consumer renders its hydrated-count readout (registers via `registerFeature()`, no Home.tsx edit)
- [ ] S-4: Telemetry Settings accessible — gear/nav opens the settings dialog with sections visible
- [ ] S-5: Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/<issue>/e2e/smoke.jpeg")` succeeds
- [ ] S-6: Contract store sanity — the `contract_events` table exists in `fredo.db` (sqlite query) and the `contract_events_hydrate` command returns an empty (non-error) result on a fresh store
