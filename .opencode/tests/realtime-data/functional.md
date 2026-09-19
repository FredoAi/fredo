# Realtime Data Layer — Functional Test Cases (Spec #2896)

> Durable functional suite (feature domain `realtime-data`) — the feature-owned read/watch layer behind Mission Monitor. One `- [ ]` case per requirement; observable expected outcome per case. Requirements are keyed `REQ-1..REQ-5` ↔ `AC1..AC5` from backlog #2896.
>
> **Evidence policy: LIVE** — the exit gate / audit fail-closed unless the tester's Evidence references `telemetry_spans` (a live-query result) and/or rendered-webview live receipts (DOM snapshots, screenshots, console logs, IPC captures). A static-only PASS is a FALSE PASS.
>
> **Bound-literal confirmation (G-184/A-18):** every literal below is bound by the Architect's contract (A-1..A-18). Commands `feature_data_declare|read|watch|unwatch|write|delete`; channel `"fredo-stream-event"` carrying `{"featureBatch": FeatureRowNotification[]}` (fields `watchId, featureId, table, kind, key, changedFields, values, version, timestamp`); watch scope `{kind:'table'}|{kind:'record', key}|{kind:'query', where}` + `fields` narrowing + `initial:true`; read returns `{ version, rows, retention: { maxRows, ttlDays } }`; probe surface A-12 (`tauri_ipc_execute_command` + `tauri_ipc_monitor`/`tauri_ipc_get_captured` + Dev Mode → Feature Data feed); eviction lever A-6 (`feature_data_delete` or cap + restart; knobs `feature_data.default_max_rows`/`feature_data.default_retention_days`); latency bound A-14 (≤ 250 ms absolute AND ≤ 2.0× small-corpus Δ, 100 ms floor); failure signal `error: string | null` (A-13). No placeholder remains — a genuinely missing literal at execution time is a named blocker.
>
> **Fixture doctrine (G-088/G-130):** multi-hop compositing, contested ownership, mid-switch no-gap timing, and continuous-stream completeness MUST be verified on the REAL path (live opencode drive via Run CLI, or real-corpus replay of persisted deliveries). Fixture-only evidence for those classes is an explicit FAIL. `fredo emit` is admissible for row-shape/read legs only, with unique `e2e-<guid8>` session ids.

## REQ-1 — read current data with no watch open (AC1)

- [ ] F-1 (REQ-1, **FAIL 2026-09-19 #2896** — declared table empty; root cause F-19): Cold read with no watch open — restart the app, do NOT open any watch, invoke `feature_data_read` for a declared scope (`ref: {source:'feature', featureId:'mission-monitor', table:'sessions'}`); cross-check `telemetry_spans`/the RTDB row store at the same instant.
  - ACTUAL: read → `{"retention":{"maxRows":500,"ttlDays":null},"rows":[],"version":0}` while `telemetry_spans`=12,440 and `chat_rows`=29,503/176 sessions. Projection fails every ingest (`no such column: sessionId`). Repro in the #2896 Tests Runs comment.
  - EXPECTED: the read returns the persisted CURRENT rows for the scope and agrees with the most recent change notification for that scope (same current values). No stale snapshot is presented as current. A scope with stored rows never reads as empty.
  - Edge: empty scope → empty result (not an error); a value changed twice → read returns the final value; rapid consecutive mutations → read is never older than the last notification.
- [ ] F-2 (REQ-1): Read-only consumer (no watch), drive a mutation on the real channel (`fredo emit` unique session or a live drive), then `feature_data_read` the scope.
  - EXPECTED: the read reflects the mutation — the changed field equals the last-notified current value.
  - Edge: a mutation during an in-flight read; a no-op write produces no phantom change; two mutations inside one coalescing window.
- [ ] F-3 (REQ-1, **FAIL 2026-09-19 #2896**): Restart the app, then first-`feature_data_read` a scope persisted pre-restart with no post-restart mutation (watches do not auto-resume — A-9).
  - EXPECTED: read returns the persisted post-restart current values, matching the row store / `telemetry_spans` count + max seq at the same instant.
  - Edge: row only in SQLite; row only in the write-behind cache at shutdown; row updated in the final pre-restart second.

## REQ-2 — watch granularity: table / record / field (AC2)

- [ ] F-4 (REQ-2): `feature_data_watch` `scope:{kind:'table'}` + `scope:{kind:'record', key:[...]}` on X; mutate sibling record Y.
  - EXPECTED: the table watch is notified of Y's change (what changed + current value); the record-X watch receives ZERO notifications for Y.
  - Edge: insert of a new record; update of an existing record; Y plus a table-only change in one window.
- [ ] F-5 (REQ-2): `feature_data_watch` `scope:{kind:'record', key:[...]}` on X; mutate a field of X.
  - EXPECTED: the record-X watch is notified with what changed + current value; the table watch is also notified.
  - Edge: two fields of X in one mutation; a field cleared to null; X mutated twice before delivery.
- [ ] F-6 (REQ-2): `feature_data_watch` on sibling fields F1/F2 of X via `fields` narrowing; mutate F1 only.
  - EXPECTED: F1's watch fires; F2's watch receives ZERO notifications — a sibling-field watch must never fire.
  - Edge: then mutate F2 → only F2 fires; both fields mutated in one write → both fire with their own current values; a no-op write fires neither.
- [ ] F-7 (REQ-2): Table + record + field watches open; `feature_data_unwatch` only the record watch (`watchIds`); mutate the record and the table.
  - EXPECTED: the stopped watch delivers nothing further; the table and field watches keep delivering every later change; stopping twice is idempotent (no duplicate, no error).
  - Edge: unsubscribe a never-started watch (no-op); two watches with the same query shape (stopping one leaves the other live); a delivery pending at stop time is discarded — no post-stop delivery.

## REQ-3 — notification content + delivery guarantee (AC3)

- [ ] F-8 (REQ-3): Inspect every delivered `featureBatch` notification of a table/record/field mutation.
  - EXPECTED: each notification identifies the changed `key`/`changedFields` AND carries the CURRENT `values` at its `version` — never delta-only, never a pre-change value as current. Cross-check `telemetry_spans`/row store at the same instant.
  - Edge: a value changed twice before delivery → the CURRENT (second) value; a `kind:"remove"` notification (`values:null`, `changedFields` = the removed record's known fields) must not assert a current value it no longer has.
- [ ] F-9 (REQ-3): Start the watch FIRST, then drive a CONTINUOUS live opencode session (Run CLI) that mutates rows while the watch is open. **REAL PATH (G-130).**
  - EXPECTED: every mutation after watch start is delivered — no gap, no dropped change (delivered-notification count matches the mutations visible in `telemetry_spans`/row store at the same instant).
  - Edge: mutation in the same millisecond as watch start; a burst coalesced into ≤1 notification still carrying the current value; watch started mid-replay/drain. A non-streaming fixture cannot verify this leg.
- [ ] F-10 (REQ-3): Mutate a field to V1 then V2 before the notification is observed; then read.
  - EXPECTED: the notification reports V2 as current; the post-settle read returns V2.
  - Edge: V2 === V1 (no-op → no phantom change); the two writes land in two windows → two notifications, both ending at V2.
- [ ] F-11 (REQ-3 — Scenario A): Live-drive session A streaming and selected; switch to a live session B; confirm no further A delivery; fully restart the app and reopen. **REAL PATH (G-088/G-130).**
  - EXPECTED: after the switch, zero A-activity notifications reach the layer while B's watch is open and delivering; after restart, every pre-restart entry and latest value is present — no missing rows, no duplicates.
  - Edge: switch while A is mid-stream; switch back to A; rapid A↔B toggling; restart with a write in flight.

## REQ-4 — declared data: idempotent create, backend-owned, durable, isolated (AC4)

- [ ] F-12 (REQ-4, **PARTIAL 2026-09-19 #2896** — declare IS idempotent (`created:false`, no error) but the LEGACY physical table is silently accepted in place of the declared schema): Launch the app twice (and invoke `feature_data_declare` twice in one session) with the same feature declaration.
  - EXPECTED: created when missing and a no-op when present — no error, no duplicate table/row, no data loss. Inspect the feature-namespaced SQLite table(s) read-only.
  - Edge: declaration changed (added column) after creation; creation raced by a read; creation while a watch is open.
- [ ] F-13 (REQ-4, **FAIL 2026-09-19 #2896**): Write rows through the layer (projection + `feature_data_write`; removal via `feature_data_delete` tombstone), fully stop/start the app, `feature_data_read` without a full history scan.
  - ACTUAL: declared `sessions` count is 0 before and after a cold restart; `feature_data_tables.last_version=0` with `backfill_done=1`; `feature_data_write` refuses a non-existent key (`record [...] does not exist`).
  - EXPECTED: rows persist and are returned by the first read; updates/deletes survive; no duplicates materialize.
  - Edge: a deletion survives restart (no resurrection); same-session update reflected after restart; torn last write.
- [ ] F-14 (REQ-4 — Scenario B, **FAIL 2026-09-19 #2896**): Large stored corpus vs small corpus; open the feature; measure Δ mount→first rendered row.
  - ACTUAL: MM renders `No sessions yet` + spinner `Waiting for agent activity…` despite 29,503 canonical chat rows / 176 sessions; no first row ever renders, so no Δ is measurable (the AC's "visible 0 sessions/blank phase when stored sessions exist" FAIL condition).
  - EXPECTED: stored entries appear immediately (no blank/"0" phase when data exists); open time does not grow with total stored history: large corpus (≥ 3× rows / ≥ 30 sessions) Δ ≤ **250 ms** absolute AND ≤ **2.0×** the small-corpus Δ, with a 100 ms small-corpus floor (A-14). Record raw ms.
  - Edge: cold vs warm webview; empty store; multi-batch replay drain.
- [x] F-15 (REQ-4, **PASS 2026-09-19 #2896**): Two declared feature scopes (`feature_data_declare` with a second `featureId`); write to A, read/watch B.
  - EVIDENCE: declared `qa2896probe.chats` (physical `feature_qa2896probe_chats`, correct declared schema incl. `_row_version`/`_updated_at`); read of `qa2896probe.sessions` → hard named error `feature 'qa2896probe' has not declared table 'sessions' (call feature_data_declare first)`. Zero cross-feature bleed; named refusal confirmed. (Note: this scope's own backfill never completed — the MM collision poisons the shared projection engine.)
  - EXPECTED: B never receives A's data (zero cross-feature bleed); a cross-namespace access is refused with a named error; B's table holds only B's rows.
  - Edge: same table name in both; same record key in both; one feature absent/deleted; a hyphenated feature id.

## REQ-5 — no session selected → no per-session watch (AC5, negative)

- [x] F-16 (REQ-5, **PASS 2026-09-19 #2896** — negative only): Open the consuming feature with NO session selected (fresh launch).
  - EVIDENCE: Dev Mode → Feature Data shows exactly 1 watch (`mission-monitor · sessions · scope: table`) and no per-session `query` watch with nothing selected. The companion positive (table watch delivers new sessions) is FAIL because the declared table never mutates.
  - EXPECTED: zero per-session activity watches are open (per-session `feature_data_watch` `scope:{kind:'query', where:[{field:'sessionId', eq:S}]}`; zero `featureBatch` deliveries for any per-session `watchId` via `tauri_ipc_monitor`/`tauri_ipc_get_captured`) and no per-session activity is delivered — while the table-level watch stays live and delivers new sessions.
  - Edge: select then deselect; a new session starts while nothing is selected → it appears via the table watch; its activity rows must NOT be delivered as if a session were selected.

## Non-functional

- [ ] N-1 (NFR-1, startup latency / history-size independence): compare first-paint Δ + switch latency small vs large corpus.
  - EXPECTED: both within the bound — large corpus (≥ 3× rows / ≥ 30 sessions) Δ ≤ **250 ms** absolute AND ≤ **2.0×** the small-corpus Δ, 100 ms small-corpus floor (A-14); no growth proportional to total stored history; raw numbers recorded ("feels faster" with no numbers = FAIL).
- [ ] N-2 (NFR-2, delivery completeness): across a session switch AND an app restart, zero missed changes; no duplicate/missing entries after restart (real path).
- [ ] N-3 (NFR-3, closed-UI correctness): with the feature UI closed, drive live activity; reopen and read.
  - EXPECTED: no change missed while the UI was closed (the projection runs unconditionally in the canonical ingest path — universal for declared tables, A-8, verified by ST-8); reopened state matches `telemetry_spans` with no gap.
- [ ] N-4 (NFR-4, isolation + idempotent create): zero cross-feature bleed (second `featureId` via `feature_data_declare`; physical `feature_<sanitized featureId>_<table>`); double `feature_data_declare` on every launch is a no-op with no data loss.
- [ ] N-5 (no re-render loop / console): `tauri_read_logs(source="console")` clean after every watch start/stop, switch, and feature open/close — no `Error:`/`Uncaught`/`Maximum update depth exceeded` (epoch-based derivation, #523).
- [ ] N-6 (theme): colors via theme tokens only — no hardcoded hex/rgba, no invalid `var(--token)NN` (use `tint()`/`color-mix()`); any new dev-mode probe surface follows the same rule.

## UI/UX-contract legs (first consumer) — #2896

- [ ] F-17 (REQ-3 / S6): Force a watch/read failure and a stream disconnect in the consuming feature.
  - EXPECTED: the failure is surfaced via the bound hook contract (A-13 — `feature_data_read|watch|write|delete` reject with hard named errors; `useFeatureRead`/`useFeatureWatch` expose `error: string | null` verbatim, never swallowed) AND previously stored data remains visible (fail-open) — never an empty result, never console-only. A removed record is `kind:"remove"`, not an error.
  - Edge: failure at mount; failure mid-stream; recovery on re-subscribe.
- [ ] F-18 (NFR-1 / first meaningful paint, **FAIL 2026-09-19 #2896**): with stored data, the consuming feature's first painted frame contains the stored entries — no backend round-trip/full history scan dependency; record the measured Δ against the A-14 bound (large corpus Δ ≤ 250 ms absolute AND ≤ 2.0× the small-corpus Δ, 100 ms floor).
  - Edge: cold vs warm; multi-batch drain; genuinely empty store.
  - ACTUAL: first painted frame shows `No sessions yet` + the inline spinner `Waiting for agent activity…`; no Δ measurable (no first row).

## Promoted exploratory finding — #2896 round 1 (2026-09-19)

- [ ] F-19 (REQ-4, **CONFIRMED FAIL**; promoted from E-2869/upgrade-path probe): **The declared physical table name `feature_mission_monitor_sessions` collides with the pre-existing LEGACY Mission Monitor table created by the deleted `lib/persistence.ts`.**
  - EXPECTED: over an existing `fredo.db`, materialization applies the DECLARED schema (contract A-17: "re-start over an existing fredo.db … re-materialize the persisted declaration and preserve the declared rows").
  - ACTUAL: `pragma_table_info('feature_mission_monitor_sessions')` → `session_id, label, start_time, end_time, delivery_count` (legacy), NOT the declared `sessionId, startedAtNs, latestAt, chatRowCount, …, _row_version, _updated_at`. `CREATE TABLE IF NOT EXISTS` (`registry.rs:440`) silently no-ops; `compute_plan` compares only the persisted metadata, never the physical schema. Every projection/backfill/prune then fails: `WARN fredo::feature_data declared-table projection failed; canonical ingest unaffected error=no such column: sessionId in SELECT * FROM feature_mission_monitor_sessions WHERE sessionId = ?1 LIMIT 2` (+ `ERROR declared retention prune failed`). `feature_data_read` returns `rows:[]`; `last_version` stays 0.
  - SCOPE: the collision poisons the shared projection engine for ALL declared tables (the clean `qa2896probe` scope's 29,503-row backfill logged 7,118+ failures and never completed) — not only Mission Monitor.
  - REPRO: `dev-env.ps1 -Action Up -Spec 2896`; open MM → empty state; `feature_data_read` declared scope → `rows:[]`; check `pragma_table_info` + `dev-env.ps1 -Action Logs` for the `no such column: sessionId` warning. Full evidence: the #2896 `## Tests Runs` comment.
  - FIX DIRECTION: the registry must validate the ACTUAL physical schema (not just persisted metadata) and either migrate/drop the legacy table or refuse with a hard named error; alternatively rename MM's declared table so it cannot collide. ST-6 removed `persistence.ts` without a migration for the table it had created.
- [ ] N-7 (NFR-5, interaction budgets): selection feedback <100 ms (no round-trip); scope switch clear ≤100 ms with no stale previous-scope flash beyond one frame; no main-thread sync work >50 ms. Raw ms recorded.
  - Edge: rapid switching; large corpus.
- [ ] N-8 (NFR-5, reduced motion): any new-entry animation/skeleton shimmer is disabled/reduced under `prefers-reduced-motion`.

## Round-2 re-test results (#2896, 2026-09-19, served `spec/2896 @ 8b9c8f3a`)

> Full evidence: the #2896 `## Tests Runs` (round 2, Verdict FAIL). The declared-schema collision that round 1 proved is FIXED; the FAIL is the incomplete one-time backfill + a phantom no-op write.

- [x] F-1 (REQ-1, PASS 2026-09-19 #2896 round 2): cold declared read returns projected rows + `version>0` (`{"retention":{"maxRows":500,"ttlDays":null},"rows":[…1 row…],"version":1}`; later `version:3`).
- [x] F-2 (REQ-1, PASS 2026-09-19 #2896 round 2): a canonical `fredo emit` is reflected — declared read shows the new session (`canonical=1 / declared=1`, version advanced).
- [x] F-3 (REQ-1, PASS 2026-09-19 #2896 round 2): rows + feature-owned `customName` persist across a full stop/start (6→6 rows).
- [x] F-4/F-5 (REQ-2, PASS 2026-09-19 #2896 round 2): table watch fires for a record mutation; record watch fires with correct `changedFields`/`values`.
- [x] F-6 (REQ-2, PASS 2026-09-19 #2896 round 2): sibling-field isolation verified BOTH directions — `fields:['customName']` vs `fields:['latestAt']`; each stayed silent for the other's change.
- [x] F-7 (REQ-2, PASS 2026-09-19 #2896 round 2): after `feature_data_unwatch` of one watch, the stopped watch is silent while the table/other watches keep delivering.
- [x] F-8 (REQ-3, PASS 2026-09-19 #2896 round 2): notification shape verified — `kind`, `key`, `changedFields`, current `values`, `version`, `timestamp`; `remove` = `values:null` with the record's known fields.
- [ ] F-10 (REQ-3, **FAIL 2026-09-19 #2896 round 2**): an identical-value `feature_data_write` emitted a phantom `update` (`changedFields:["customName"]`, version 10→11) — the no-op edge is not honored.
- [x] F-11 (REQ-3 Scenario A, PARTIAL 2026-09-19 #2896 round 2): declared insert/update/remove flows verified live; the live continuous-stream + switch + restart leg was not re-driven (time-box).
- [x] F-12 (REQ-4, PASS 2026-09-19 #2896 round 2): the declared physical table now has the DECLARED schema; the legacy same-named table is preserved under `__legacy_*` (never dropped).
- [x] F-13 (REQ-4, PASS 2026-09-19 #2896 round 2): projection + `feature_data_write` + `feature_data_delete` (tombstone) work; the delete survives restart (13 tombstones persisted).
- [ ] F-14 (REQ-4 Scenario B, **FAIL 2026-09-19 #2896 round 2**): the one-time backfill does not complete on the real corpus (`backfill_done=0` after >12 min; 7 of ~34 qualifying sessions; no completion log) — the stored history is not served on open; NFR-1 unmeasurable.
- [x] F-15 (REQ-4, PASS 2026-09-19 #2896 round 2): cross-namespace read refused with `feature 'qa2896probe' has not declared table 'sessions' (call feature_data_declare first)`.
- [x] F-16 (REQ-5 negative, PASS round-1 retained): no per-session watch with nothing selected.
- [ ] F-17 (REQ-3/S6, **UNVERIFIED 2026-09-19 #2896 round 2** — named blocker): no in-app lever forces a live watch/read failure/disconnect; `mm-watch-error`/`mm-watch-disconnected` not rendered. The hook-level hard rejection IS verbatim.
- [ ] F-18 (NFR-1 first meaningful paint, PARTIAL 2026-09-19 #2896 round 2): with stored rows the first painted frame contains them (no empty state) — but only 7 of ~34 stored sessions exist; the A-14 Δ pair is unmeasurable.
- [x] N-3 (NFR-3, PASS 2026-09-19 #2896 round 2): projection runs unconditionally while no read/watch is open (observer installed at `lib.rs:395-398`; b02 projected).
- [x] N-4 (NFR-4, PASS 2026-09-19 #2896 round 2): isolation + idempotent create across restart.
- [x] N-5 (NFR-5, PASS 2026-09-19 #2896 round 2): console clean.
- [ ] N-1 (NFR-1, **UNVERIFIED 2026-09-19 #2896 round 2** — named blocker): declared store does not reach the ≥30-session large corpus; no small-corpus DB available.
