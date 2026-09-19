# Realtime Data Layer — Smoke (Spec #2896)

> Round 1 (2026-09-19, `spec/2896 @ c23087fd`): FAIL — see the `## Tests Runs` verdict on #2896 and `functional.md` F-19 for the root cause (declared `feature_mission_monitor_sessions` collides with the legacy table).

## Standard boilerplate

- [x] S-1 (PASS 2026-09-19 #2896): App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`.
- [x] S-2 (PASS 2026-09-19 #2896): No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded` (only Vite/React boot + one `motion() is deprecated` WARN).
- [x] S-3 (PARTIAL 2026-09-19 #2896): Feature surface reachable — Mission Monitor opens (launcher → "mission" → Enter) and renders its session-list drawer; the list is EMPTY (`No sessions yet`) despite stored history.
- [ ] S-4: Telemetry Settings accessible — gear/nav opens the settings dialog with sections visible. (not exercised this round)
- [x] S-5 (PASS 2026-09-19 #2896): Screenshot captured — `.opencode/tmp/2896/e2e/*.jpeg`.

## Realtime-data quick path

- [ ] S-6 (FAIL 2026-09-19 #2896): Read with no watch open — `feature_data_read` for the declared `mission-monitor.sessions` scope returned `{"retention":{"maxRows":500,"ttlDays":null},"rows":[],"version":0}` while `telemetry_spans`=12,440 / `chat_rows`=29,503/176 sessions. The declared table never materializes (legacy-schema collision).
- [ ] S-7 (FAIL 2026-09-19 #2896): Table watch live — a `chat` `fredo emit` for `e2e-2896p0a1` landed the canonical row, but the declared table stayed 0 rows and **0** `featureBatch` deliveries were captured (`tauri_ipc_get_captured` → `[]`).
- [x] S-8 (PASS 2026-09-19 #2896): Idempotent create — re-invoking `feature_data_declare` returned `{"materialized":[{"created":false,...}]}` with no error; the physical table exists exactly once. (Caveat: `created:false` is a false positive — the pre-existing table is the legacy schema, see F-19.)
- [ ] S-9 (FAIL 2026-09-19 #2896): Restart durability — after a full cold restart, `feature_mission_monitor_sessions` count is still 0 and MM shows `No sessions yet`.
- [x] S-10 (PASS 2026-09-19 #2896): Isolation — reading `{featureId:'qa2896probe', table:'sessions'}` was refused with the hard named error `feature 'qa2896probe' has not declared table 'sessions' (call feature_data_declare first)`.

## Round-3 re-run (#2896, 2026-09-19, `spec/2896 @ 74449897`)

- [x] S-1/S-2/S-5 (PASS round 3): app renders; console clean (only `motion()` WARN + auto-fit DEBUG); screenshots captured under `.opencode/tmp/2896/e2e/`.
- [x] S-3 (PASS round 3): MM opens with the stored list populated (31 rows) and a Chat node — no empty state.
- [x] S-6 (PASS round 3): `feature_data_read` on the declared `mission-monitor.sessions` scope returns rows + `version` (declared table 31 rows; `backfill_done=1`).
- [x] S-7 (PASS round 3): a canonical `fredo emit` projects into the declared table and emits `featureBatch` (captured in-page via `window.__TAURI__.event.listen('fredo-stream-event', …)`; `tauri_ipc_monitor` does not capture emitted events).
- [x] S-8/S-9 (PASS round 3): idempotent create + restart durability — the restored real corpus serves 31 stored sessions on open; a cold restart leaves the marker set and does not re-drain.
- [x] S-10 (PASS round 3): isolation via a FRESH `qa2896r3probe` scope on the disposable DB — both cross-namespace reads refused with hard named errors; the real corpus stays clean (probe discarded with the disposable DB).
- [ ] S-11 (UNVERIFIED round 3 — named blocker): the S6 live failure/disconnect state cannot be driven (write `sqlite3` DDL sandbox-denied; no stream-health signal). See `functional.md` F-17.
