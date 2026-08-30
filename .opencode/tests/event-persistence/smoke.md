# Event persistence smoke tests

- [ ] S-1: App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`
- [ ] S-2: No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`
- [ ] S-3: Feature surface reachable — Mission Monitor opens; the stepper-probe consumer renders its hydrated-count readout (registers via `registerFeature()`, no Home.tsx edit)
- [ ] S-4: Telemetry Settings accessible — gear/nav opens the settings dialog with sections visible
- [ ] S-5: Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/<issue>/e2e/smoke.jpeg")` succeeds
- [ ] S-6: Contract store sanity — the `contract_events` table exists in `fredo.db` (sqlite query) and the `contract_events_hydrate` command returns an empty (non-error) result on a fresh store
- [ ] S-7: NFR-HOTP spot delta (round 2) — min(`feature_mission_monitor_events.timestamp`) of the child-correlation init delivery − `telemetry_spans.start_time_ns` of the parent `fredo.tool.task` span; budget ≤ 2 s. Last: R2B 1.839 s (single sample). No continuous DOM polling needed.
- [ ] S-8: Composited row receipt (round 2) — `contract_events` rows keyed under the parent session id carry `compositedChildSessionId` in payload (F5 seq 941-944; F4B 1447/1455/1463 pairs; live R2A 6491/6492 6509/6510).
- [ ] S-9: Retention knobs round-trip (round 2) — `get_setting` on `contracts.retention_days` (7) / `contracts.max_rows` (100000); any test write via `save_setting` MUST be restored to defaults (round-2 writes 6420/5620 were restored).
