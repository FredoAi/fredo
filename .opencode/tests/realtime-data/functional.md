# Realtime Data Layer — Functional Test Cases (Spec #2896)

> Durable functional suite (feature domain `realtime-data`) — the feature-owned read/watch layer behind Mission Monitor. One `- [ ]` case per requirement; observable expected outcome per case. Requirements are keyed `REQ-1..REQ-5` ↔ `AC1..AC5` from backlog #2896.
>
> **Evidence policy: LIVE** — the exit gate / audit fail-closed unless the tester's Evidence references `telemetry_spans` (a live-query result) and/or rendered-webview live receipts (DOM snapshots, screenshots, console logs, IPC captures). A static-only PASS is a FALSE PASS.
>
> **Bound-literal confirmation (G-184/A-18):** every literal below is bound by the Architect's contract (A-1..A-18). Commands `feature_data_declare|read|watch|unwatch|write|delete`; channel `"fredo-stream-event"` carrying `{"featureBatch": FeatureRowNotification[]}` (fields `watchId, featureId, table, kind, key, changedFields, values, version, timestamp`); watch scope `{kind:'table'}|{kind:'record', key}|{kind:'query', where}` + `fields` narrowing + `initial:true`; read returns `{ version, rows, retention: { maxRows, ttlDays } }`; probe surface A-12 (`tauri_ipc_execute_command` + `tauri_ipc_monitor`/`tauri_ipc_get_captured` + Dev Mode → Feature Data feed); eviction lever A-6 (`feature_data_delete` or cap + restart; knobs `feature_data.default_max_rows`/`feature_data.default_retention_days`); latency bound A-14 (≤ 250 ms absolute AND ≤ 2.0× small-corpus Δ, 100 ms floor); failure signal `error: string | null` (A-13). No placeholder remains — a genuinely missing literal at execution time is a named blocker.
>
> **Fixture doctrine (G-088/G-130):** multi-hop compositing, contested ownership, mid-switch no-gap timing, and continuous-stream completeness MUST be verified on the REAL path (live opencode drive via Run CLI, or real-corpus replay of persisted deliveries). Fixture-only evidence for those classes is an explicit FAIL. `fredo emit` is admissible for row-shape/read legs only, with unique `e2e-<guid8>` session ids.

## REQ-1 — read current data with no watch open (AC1)

- [ ] F-1 (REQ-1): Cold read with no watch open — restart the app, do NOT open any watch, invoke `feature_data_read` for a declared scope (`ref: {source:'feature', featureId:'mission-monitor', table:'sessions'}`); cross-check `telemetry_spans`/the RTDB row store at the same instant.
  - EXPECTED: the read returns the persisted CURRENT rows for the scope and agrees with the most recent change notification for that scope (same current values). No stale snapshot is presented as current. A scope with stored rows never reads as empty.
  - Edge: empty scope → empty result (not an error); a value changed twice → read returns the final value; rapid consecutive mutations → read is never older than the last notification.
- [ ] F-2 (REQ-1): Read-only consumer (no watch), drive a mutation on the real channel (`fredo emit` unique session or a live drive), then `feature_data_read` the scope.
  - EXPECTED: the read reflects the mutation — the changed field equals the last-notified current value.
  - Edge: a mutation during an in-flight read; a no-op write produces no phantom change; two mutations inside one coalescing window.
- [ ] F-3 (REQ-1): Restart the app, then first-`feature_data_read` a scope persisted pre-restart with no post-restart mutation (watches do not auto-resume — A-9).
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

- [ ] F-12 (REQ-4): Launch the app twice (and invoke `feature_data_declare` twice in one session) with the same feature declaration.
  - EXPECTED: created when missing and a no-op when present — no error, no duplicate table/row, no data loss. Inspect the feature-namespaced SQLite table(s) read-only.
  - Edge: declaration changed (added column) after creation; creation raced by a read; creation while a watch is open.
- [ ] F-13 (REQ-4): Write rows through the layer (projection + `feature_data_write`; removal via `feature_data_delete` tombstone), fully stop/start the app, `feature_data_read` without a full history scan.
  - EXPECTED: rows persist and are returned by the first read; updates/deletes survive; no duplicates materialize.
  - Edge: a deletion survives restart (no resurrection); same-session update reflected after restart; torn last write.
- [ ] F-14 (REQ-4 — Scenario B): Large stored corpus vs small corpus; open the feature; measure Δ mount→first rendered row.
  - EXPECTED: stored entries appear immediately (no blank/"0" phase when data exists); open time does not grow with total stored history: large corpus (≥ 3× rows / ≥ 30 sessions) Δ ≤ **250 ms** absolute AND ≤ **2.0×** the small-corpus Δ, with a 100 ms small-corpus floor (A-14). Record raw ms.
  - Edge: cold vs warm webview; empty store; multi-batch replay drain.
- [ ] F-15 (REQ-4): Two declared feature scopes (`feature_data_declare` with a second `featureId`); write to A, read/watch B.
  - EXPECTED: B never receives A's data (zero cross-feature bleed); a cross-namespace access is refused with a named error; B's table holds only B's rows.
  - Edge: same table name in both; same record key in both; one feature absent/deleted; a hyphenated feature id.

## REQ-5 — no session selected → no per-session watch (AC5, negative)

- [ ] F-16 (REQ-5): Open the consuming feature with NO session selected (fresh launch).
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
- [ ] F-18 (NFR-1 / first meaningful paint): with stored data, the consuming feature's first painted frame contains the stored entries — no backend round-trip/full history scan dependency; record the measured Δ against the A-14 bound (large corpus Δ ≤ 250 ms absolute AND ≤ 2.0× the small-corpus Δ, 100 ms floor).
  - Edge: cold vs warm; multi-batch drain; genuinely empty store.
- [ ] N-7 (NFR-5, interaction budgets): selection feedback <100 ms (no round-trip); scope switch clear ≤100 ms with no stale previous-scope flash beyond one frame; no main-thread sync work >50 ms. Raw ms recorded.
  - Edge: rapid switching; large corpus.
- [ ] N-8 (NFR-5, reduced motion): any new-entry animation/skeleton shimmer is disabled/reduced under `prefers-reduced-motion`.
