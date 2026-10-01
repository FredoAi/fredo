# postgres-migration — Functional

Durable functional suite for the **one-shot `fredo.db` → PostgreSQL data migration** feature
domain (slice 4 of 6, issue **#2977**; builds on slices 1–3: `postgres-lifecycle` #2974,
`postgres-stores` #2975/#2976). This slice moves the existing DATA: every physical table in
`fredo.db` is copied into PostgreSQL under a per-table parity gate, with an executable SQLite
rollback. Inherited and extended by every following Postgres slice (slice 6 #2979 blocks on
this one).

> **Evidence policy: LIVE.** The store-migration, parity, rollback, and Mission Monitor rows are
> provable ONLY by observing a running artifact — their Evidence MUST reference a PostgreSQL
> store read (managed `psql`), a `telemetry_spans` read, or the restored snapshot. A static-only
> PASS is a FALSE PASS.

> **G-284 PG read lever (disclosed substitution).** The `telemetry-query` skill is SQLite-only
> and CANNOT read the migrated PostgreSQL store. For every live PG read, use the managed
> `psql` (`%APPDATA%\com.fredo.app\postgres-install\18.6.0\bin\psql.exe`) with the connection URI
> `postgres://postgres:<postgres.password>@127.0.0.1:<port>/fredo` built from
> `pg_supervisor_status` (`{state, port, pid, dataDir}`) + the `postgres.password` AppStore key
> (`PG_PASSWORD_KEY`). The SQLite-only `telemetry-query` skill is the correct lever ONLY for the
> **source** `fredo.db` read.

> **G-263 SAFETY (named failure mode: the #2948 ~11 h `pg.stop()` hang).** Every live leg
> starts/stops through the sanctioned lever
> `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 2977` / `-Action Down`
> (kill-never-wait on expiry; `-EnvVar NAME=value` for env seams); never a bare
> `postgres`/`pg_ctl`. An observed unbounded/blocking wait is a FAIL, not a skip.

> **Induction levers (G-275) — binding names (G-255).** (a) `FREDO_DATA_DIR` — the app-data-dir
> override that redirects the source `fredo.db` AND the AC3 backout target, so the full app-level
> leg runs against an in-repo fixture dir under `.opencode/tmp/2977/fixture/` without touching the
> live `%APPDATA%\com.fredo.app\fredo.db`; `FREDO_MIGRATION_DIR` overrides the scratch/snapshot dir.
> (b) `FREDO_MIGRATION_FORCE_MISMATCH` — the ONE fault seam (no `FREDO_MIGRATION_FAULT`): `<table>`
> drops one row from that table (parity mismatch); `1`/`true` drops one row from the first non-empty
> table; `<table>:export_error` aborts that table's copy before parity; `snapshot_fail` forces the
> snapshot step to fail; unset ⇒ inert. Shipped seams: `FREDO_STORAGE_ENGINE` (`sqlite|postgres`),
> `FREDO_PG_DATA_DIR`, `FREDO_PG_POOL_FORCE_FAIL=1`. Live status hook: `migration_status`.

> **G-271 coverage.** Where a row verifies a structured deliverable (the physical-table set, the
> per-table parity pairs, the carried markers), assert COVERAGE of the named elements — never a
> literal count the requirement does not state.

## Cases

- [ ] **F-1 (AC1) — one-shot carry without loss: every physical table copied, PK-keyed; `settings`
  + `feature_data_tables.backfill_done` verbatim.**
  Capture the source inventory (`sqlite_master`, excluding `sqlite_*`), then run the cutover.
  **Expected:** every source physical table exists in PG `public` with the SAME row set, keyed on
  its primary key; the FULL `settings` table is carried; each per-table
  `feature_data_tables.backfill_done` value is carried verbatim. **Live read:** source via the
  `telemetry-query` skill (SQLite); target via managed `psql` (G-284). **FAIL** = a missing table,
  a re-keyed/merged table, or a lost/blank `backfill_done`.

- [ ] **F-2 (AC1/NFR) — the source `fredo.db` is READ-ONLY for the whole export leg.**
  Record `fredo.db` size + mtime + SHA-256 immediately before the export and immediately after the
  export completes (before any explicit backout).
  **Expected:** byte-identical before/after; the export opens the source read-only; no journal/WAL
  side file is left mutated. **FAIL** = any byte change, a mtime bump, or a write to the source.

- [ ] **F-3 (AC2) — parity is TWO independent per-table comparisons: row COUNT AND SHA-256 content
  checksum over a PK-ordered canonical encoding.**
  For every migrated table compute, independently on source and target: (i) row count, (ii)
  SHA-256 over the canonical encoding of all rows ordered by PK.
  **Expected:** both comparisons are computed per table and BOTH equal; the checksum encoding is
  stable across engines (hex case, NULL ordering, BLOB bytes normalized). **Live read:** managed
  `psql` (target) + SQLite (source). **FAIL** = a single-comparison gate, or a checksum that is
  encoding-sensitive (e.g. hex case) rather than content-sensitive.

- [ ] **F-4 (AC2, G-275) — fail-closed: a mismatch does NOT set the marker, does NOT flip the
  engine, leaves `fredo.db` untouched; the next startup re-runs the idempotent export.**
  Induce a deliberate mismatch via `FREDO_MIGRATION_FORCE_MISMATCH=<table>` (or `=1`) with a
  fixture dir under `.opencode/tmp/2977/`; record `fredo.db` SHA-256 before.
  **Expected:** the parity gate fails closed — `migration.postgres.completed` is NOT set, the
  engine is NOT flipped (`storage_engine_status.engine == "sqlite"`), `fredo.db` is byte-untouched;
  the NEXT startup re-runs the read-only export (idempotent, no partial-state corruption).
  **FAIL** = a set marker, an engine flip, a mutated `fredo.db`, or a crash/unbounded wait.

- [ ] **F-5 (AC3) — a pre-cutover snapshot is taken while writers are quiesced.**
  Observe the cutover sequence; locate the snapshot artifact.
  **Expected:** a complete snapshot of `fredo.db` exists, is taken BEFORE the engine flip, and is
  taken while writers are quiesced (no in-flight write); the snapshot restores to a checksum-equal
  database. **FAIL** = a snapshot taken mid-write, after the flip, or an incomplete/truncated
  snapshot.

- [ ] **F-6 (AC3) — the backout is EXECUTED and VERIFIED by recomputing the same counts/checksums
  on the restored snapshot.**
  Execute the backout: stop app → restore the snapshot over `fredo.db` → start the SQLite build.
  **Expected:** the restored `fredo.db` recomputes the SAME per-table counts/checksums as the
  pre-cutover source (equal to the F-3 pre-cutover values); the SQLite build boots and operates on
  the restored data; the migration leg itself never mutated or deleted `fredo.db`. **FAIL** = a
  restored checksum that differs, a boot failure, or any migration-leg mutation of `fredo.db`.

- [ ] **F-7 (AC4, G-275) — a deliberately corrupted/mismatched table makes the export exit NON-ZERO
  and the app starts on SQLite.**
  Corrupt one table via the fault seam (`FREDO_MIGRATION_FORCE_MISMATCH=<table>`; alternative
  `<table>:export_error`) on a fixture under `.opencode/tmp/2977/`.
  **Expected:** the export exits non-zero; the app starts on SQLite and is fully operational;
  `fredo.db` is byte-unchanged; a structured (non-fatal) error is logged; the failure is bounded.
  **FAIL** = a silent success, a crash, an engine flip, or an unbounded wait.

- [ ] **F-8 (AC4) — a second startup after a successful cutover SKIPS the export (marker set).**
  Complete a successful cutover, then restart the app over the same PG data dir.
  **Expected:** the second startup detects `migration.postgres.completed` and does NOT re-run the
  export (no re-copy, no parity re-gate); the engine stays on PostgreSQL; startup is fast and
  idempotent. **FAIL** = a re-run of the export, or a flip back to SQLite.

- [ ] **F-9 (AC4) — a legacy/ignored `settings` key not otherwise consulted survives the copy.**
  Seed a `settings` key that the app never reads (an unusual charset, e.g. with a `:`/`.`/NUL-adjacent
  byte), run the cutover, read it back from PG.
  **Expected:** the key and its exact value survive byte-for-byte in the migrated `settings` table.
  **FAIL** = a dropped/normalized/re-encoded legacy key.

- [ ] **F-10 (AC4) — a marker value is present BYTE-FOR-BYTE after the copy.**
  Compare every carried marker between source and target: `rtdb.backfill.completed`, the provider
  `.v2` marker, each per-table `feature_data_tables.backfill_done`, and
  `migration.postgres.completed`.
  **Expected:** each marker's value is byte-identical after the copy (no re-derivation, no
  reformatting, no trimming). **FAIL** = a re-derived/reformatted marker, or a marker absent where
  the source had it.

- [ ] **F-11 (AC5) — a real full-size `fredo.db` copy batches (512-row chunks) with a bounded memory
  budget, and a full-size copy measurement is recorded.**
  Run the export against a full-size `fredo.db` (record its byte size + row counts); observe the
  batching and measure the run.
  **Expected:** the copy proceeds in 512-row chunks (mirroring `RTDB_MAX_EMISSION_BATCH`); memory
  stays bounded (no full-table materialization); a BEFORE/AFTER measurement (wall-clock + peak
  RSS/working set) is recorded with the fixture scale named. **FAIL** = an unbounded single-shot
  copy, unbounded memory, or no recorded measurement.

- [ ] **F-12 (HUMAN MISSION-MONITOR DIRECTIVE, G-256) — boot on the migrated data and render
  sessions / tools / tokens in Mission Monitor (parity vs pre-migration).**
  Capture a pre-migration Mission Monitor baseline (DOM + screenshot + the source rows). Run the
  data migration; boot the app PG-selected on the migrated data; drive a LIVE agent action so OTLP
  spans ingest (real OpenCode via Terminal — `fredo emit` writes NO spans); open Mission Monitor;
  cross-check the PG store (`psql`) at the SAME instant.
  **Expected:** the app boots on the migrated data; Mission Monitor lists the migrated sessions and
  renders chat / tools / tokens / graph with NO regression vs the pre-migration baseline; the
  rendered data equals the same-instant PG store columns (not SQLite). Modeled on `mission-monitor`
  F-54 / `postgres-stores` F-39. **FAIL** = a blank panel while migrated rows exist, a stale SQLite
  read, or a static-only receipt.
  **Round 1 (2026-10-01) FAIL:** the app booted on the migrated store and the session list rendered
  6 migrated sessions (matching the 6 `feature_mission_monitor_sessions` rows read via managed
  `psql` at the same instant), but the graph/tools/tokens did NOT render — the panel showed
  `unknown rtdb row state: streaming`. Root cause: the committed CU-D fixture writes
  non-production-shaped data (see F-15). The corrected-fixture capture was blocked by a WebView2
  `about:blank` environment wedge.
  **Round 2 (2026-10-01) PARTIAL/FAIL:** the corrected fixture migrated with full per-table parity
  (13 tables count+checksum, `migration_status=Completed`, `storage_engine_status.engine=postgres`)
  and Mission Monitor now renders the migrated session list + graph + tokens with NO
  `unknown rtdb row state` and NO `missing field 'name'` (the round-1 failure is FIXED). The
  same-instant managed-`psql` read matches the render (session `s000001`: INPUT 4 / CACHE 2 /
  OUTPUT 2 / COST $0.0010). **However the `── TOOLS (N) ──` element does NOT render for any migrated
  session.** Root cause (fixture-shape gap, not a product defect): the committed CU-D fixture writes
  each tool row's `started_at_ns` EQUAL to its chat row's (`migration_fixture.rs:378/439`), so the
  product's strict time-window parent rule (`resolveParentChatNode`, `useMissionMonitor.ts:349`
  requires `parentStart < callStart`) resolves no parent and the non-task call never embeds
  (`associateToolCalls`, `useMissionMonitor.ts:471-472`). PG-verified: `chat_rows.s000001_c0` and
  `tool_use_rows.s000001_t0` both have `started_at_ns = 1790000000001000000`. Production tool spans
  start strictly AFTER their chat turn, so real migrated data is unaffected. Fix = offset the
  fixture tool `started_at_ns` (e.g. chat_start + 1 ms) so the parent rule resolves.

- [ ] **F-13 (NFR) — zero-warning build gates + Windows-first.**
  Run `cargo check --locked`, `cargo clippy --locked -- -D warnings`, `cargo test --locked`.
  **Expected:** check 0 warnings, clippy clean, tests green (incl. the migration path exercised);
  Windows-first; no `#[allow(...)]`. **FAIL** = check green but clippy red (does NOT clear the
  gate), or a red test.

- [ ] **F-14 (NFR) — source read-only + `telemetry_spans` strictly read-only + writers quiesced +
  bounded runs.**
  Inspect the export/parity path; attempt a write to `telemetry_spans` through the migration path;
  hold a writer active during the parity window; tear down via the dev-env lever.
  **Expected:** the source `fredo.db` is read-only for the export leg; `telemetry_spans` is never
  written; writers are quiesced across the parity window (a mid-parity write is refused/blocked);
  every live leg is finite; no orphan `postgres.exe` after `-Action Down`. **FAIL** = a write
  reaching `telemetry_spans`, a live writer during parity, an await without a finite bound, or an
  orphan postmaster.

- [ ] **F-15 (promoted from E-fixture, round 1) — the committed fixture generator produces
  PRODUCTION-SHAPED rows so the migrated data drives Mission Monitor.**
  The CU-D fixture (`apps/tauri/src-tauri/tests/support/migration_fixture.rs`) must write
  (a) a valid `feature_data_tables.declaration_json` (production shape: `name`/`primaryKey`/
  `columns`/`source`/`retention`) and (b) canonical **persisted** `RowState` values in the
  LOWERCASE storage vocabulary `init|update|response|timeout|error` (`RowState::as_str()`,
  `infrastructure/rtdb/rows.rs:44-55`) for `chat_rows`/`tool_use_rows`/`agent_session_rows`.
  NOT the PascalCase wire enum (`Init|Update|Response|Timeout|Error` is the serde wire shape,
  `EventSubscription.ts:43`) and NOT the round-1 `streaming|complete|error` — the store's
  `parse_row_state` (`rtdb/store.rs:356-370`) accepts ONLY the lowercase form.
  **Expected:** the backend's persisted-declaration reader accepts the row (no `missing field
  'name'`), and the frontend row store derives the Mission Monitor graph/tokens with no
  `unknown rtdb row state` error. **Round 1:** FAIL — the fixture wrote
  `{"featureId":"mission-monitor","table":"sessions"}` (missing `name`) and non-canonical
  `streaming|complete|error` states, so MM's declared session list errored and the graph aborted.
  **Round 2:** PASS — the committed generator now emits valid `FeatureDataTableDeclaration` JSON
  (`sessions` sessionRollup shape + `tools`) and lowercase canonical states; the ungated guard
  `fixture_rows_are_production_shaped` is green, and the live SQLite boot projected the declared
  tables with zero `missing field 'name'` / `unknown rtdb row state` warnings.

## Non-functional

- [ ] **N-1 (zero data loss):** per-table counts + SHA-256 checksums equal across the cutover
  (F-1/F-3).
- [ ] **N-2 (fail-closed):** a parity failure never flips the engine, never sets the marker, never
  mutates `fredo.db`; SQLite stays fully operational (F-4/F-7).
- [ ] **N-3 (read-only):** `fredo.db` byte-unchanged across the export leg; `telemetry_spans`
  strictly read-only (F-2/F-14).
- [ ] **N-4 (batching/memory):** the full-size copy batches (512-row chunks) within a bounded memory
  budget; the measurement is recorded (F-11).
- [ ] **N-5 (build hygiene):** F-13 green; bounded runs, no orphan postmaster (F-14).

## Suite-level pass/fail

PASS = F-1..F-14 green with live evidence from the running artifact (PG store read via managed
`psql`; `telemetry_spans`; the restored snapshot) and N-1..N-5 holding. Any of: a count/checksum
mismatch; a marker set on a mismatch; an engine flip despite a parity failure; `fredo.db`
mutated/deleted by the migration leg; a static-only receipt on any live row; a blank Mission Monitor
while migrated rows exist; a write reaching `telemetry_spans`; or an unbounded/blocking wait (the
#2948 `pg.stop()` hang class) = **FAIL**.
