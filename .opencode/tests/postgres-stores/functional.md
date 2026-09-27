# postgres-stores — Functional

Durable functional suite for the **storage engine seam + shared async PostgreSQL pool** feature
domain (slice 2 of 6; builds on slice-1 `postgres-lifecycle` #2974 and spike #2964). One shared
`sqlx::PgPool` cloned into `AppStore` / `FeatureStore` / `FeatureDataStore` + the read-only paths,
1:1 SQLite→PostgreSQL statement translation, and a fail-closed SQLite fallback. Inherited and
extended by every following Postgres store slice.

> **Evidence policy: LIVE.** The cross-engine parity, app-boot, and Mission Monitor rows are only
> provable by observing a running artifact — their Evidence MUST reference `telemetry_spans` (or an
> RTDB-row / `pg_stat_activity` live read) on the built app. The committed spike receipt
> (`spikes/2964-postgres-migration/results/schema-translation.json`, 18/18) is corroboration ONLY,
> never the sole receipt. A static-only PASS is a FALSE PASS.

> **G-263 SAFETY (named failure mode): the #2948 ~11 h `pg.stop()` hang.** Never run an unbounded
> binary. Every live leg starts/stops through the sanctioned lever
> `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 2975` / `-Action Down`
> (kill-never-wait on expiry); never a bare `postgres`/`pg_ctl`. An observed unbounded/blocking wait
> is a FAIL, not a skip.

> **Induction levers (G-275 — shipped by ST-2):** (a) `FREDO_PG_POOL_FORCE_FAIL=1` forces the pool
> build to fail at a named stage; (b) `FREDO_PG_DATA_DIR`
> (`apps/tauri/src-tauri/src/features/pg_supervisor/mod.rs:65`) points the managed server at a writable
> dir under `.opencode/tmp/2975/pgdata-corrupt`; a corrupt/absent override induces the PG start failure
> F-9 needs. Both are the binding seams F-9 exercises.

> **Binding names (G-255):** engine selection = `FREDO_STORAGE_ENGINE` (`sqlite`|`postgres`), overriding
> the KV `postgres.enabled`; SQLite is the default. The pool is a single `sqlx::PgPool` built on the
> background task after the supervisor's `await_ready` and installed once into the shared
> `EngineHandle`; every migrated store holds an `Arc<EngineHandle>` clone. Live hook:
> `storage_engine_status` → `{ engine, fallbackReason }`.

## Cases

- [ ] **F-1 (AC1, QA-1.1) — one shared pool created once, cloned into the stores.**
  Boot with PG selected on a fresh data dir; read the startup wiring + the live client view.
  **Expected:** exactly ONE `PgPool`, built once on the background task after the supervisor's
  `await_ready` (not in the synchronous `lib.rs` setup closure) and installed once into the shared
  `EngineHandle`; `AppStore` / `FeatureStore` / `FeatureDataStore` / `ProjectionEngine` /
  declared-table backfill hold `Arc<EngineHandle>` clones; no `Mutex<Connection>` and no per-store
  `Connection::open`. Live: `storage_engine_status.engine == "postgres"`; a store read + a store write
  both succeed. **FAIL** = a second pool, or a per-store connection.

- [ ] **F-2 (AC1, QA-1.2) — no per-store connections at runtime.**
  With all stores active, read the live PG client list (`pg_stat_activity`, or the equivalent
  client-count view).
  **Expected:** the backend count is bounded by ONE pool's `max_connections` (5–10) — not one
  connection per store and not per-query churn. **FAIL** = connections scale with stores/queries.

- [ ] **F-3 (AC1, QA-1.3) — read-only canonical paths share the pool.**
  Exercise `ProjectionEngine` and the declared-table backfill canonical reads.
  **Expected:** both acquire a **read-only** handle/tx from the shared pool
  (`SET TRANSACTION READ ONLY` / least-privilege role); no separate connection; a write attempt
  through them is rejected (spike `query_only_to_read_only_tx`). **FAIL** = a new connection or an
  accepted write.

- [ ] **F-4 (AC2, QA-2.1) — `settings` KV round-trip on PG.**
  Set → get → re-set (upsert) a key; inspect `information_schema.columns`.
  **Expected:** `settings(key text PK, value text NOT NULL)`, PK on `key`; unknown key → `None`;
  re-set updates in place, no duplicate row. Cross-check `settings_kv_mapping` / `settings_pk` /
  `settings_upsert_translation`. **FAIL** = wrong type/PK, a duplicate, or a stale value.

- [ ] **F-5 (AC2, QA-2.2) — dynamic `feature_{featureId}_{tableName}` round-trip.**
  Create + round-trip a declared table with reserved `_row_version` / `_updated_at`.
  **Expected:** created with the C1 type map (`TEXT→TEXT`, `INTEGER→BIGINT`, `REAL→DOUBLE PRECISION`,
  `BLOB→BYTEA`); reserved columns present; PK 1:1; identifiers double-quoted + namespace-validated;
  re-`ensure_table` is a no-op. **FAIL** = a wrong type, a missing reserved column, or an
  unquoted/unvalidated identifier.

- [ ] **F-6 (AC2, QA-2.3) — `feature_data_tables` / `feature_data_tombstones` round-trip.**
  Put/list a table + tombstone; re-put each; read `backfill_done`.
  **Expected:** composite PKs 1:1 (`feature_id, table_name`; `feature_id, table_name, key_json`);
  all columns survive; `backfill_done` carried verbatim; upserts use `EXCLUDED.`. **FAIL** = a lost
  column, a wrong PK, or a re-put that inserts a duplicate.

- [ ] **F-7 (AC2, QA-2.4) — statement translation exercised live on the built app.**
  Drive each translated statement through the running stores.
  **Expected:** `INSERT OR IGNORE → ON CONFLICT DO NOTHING`; `excluded. → EXCLUDED.`; `?n → $n`;
  existence probe via `to_regclass`/`information_schema` (not `sqlite_master`); dynamic identifiers
  quoted. Live receipt: a successful round-trip per translation. **FAIL** = a `sqlite_master` probe,
  a raw `?n`, or a `sqlite`-only construct left in the path.

- [ ] **F-8 (AC3, QA-3.1) — SQLite selected: behaviour + tests unchanged.**
  Boot with SQLite selected (default); run the existing store test suite and a UI smoke.
  **Expected:** behaviour and tests are unchanged from pre-slice; the app boots, stores read/write,
  Mission Monitor renders; no new prompt/error/UI change; no `fredo.db` schema change. **FAIL** =
  any user-visible change or a red test.

- [ ] **F-9 (AC3, QA-3.2, G-275) — PG start/selection/pool failure → SQLite fallback, `fredo.db` untouched.**
  With `FREDO_STORAGE_ENGINE=postgres`, induce the failure via BOTH shipped seams: (i)
  `FREDO_PG_POOL_FORCE_FAIL=1`; (ii) `FREDO_PG_DATA_DIR` pointed at a corrupt/absent writable dir under
  `.opencode/tmp/2975/pgdata-corrupt`. Record `fredo.db` size + SHA-256 + mtime before/after.
  **Expected:** the failure falls back to SQLite; the app boots and operates on SQLite;
  `storage_engine_status` reports `engine == "sqlite"` + a non-null `fallbackReason`; `fredo.db` is
  byte-identical before/after — never mutated; a structured, non-fatal error is logged; the failure is
  bounded. **FAIL** = a crash, a mutated `fredo.db`, or an unbounded wait.

- [ ] **F-10 (AC4, QA-4.1) — duplicate-PK `INSERT OR IGNORE` silently idempotent on PG.**
  Insert the same PK twice through the ignore path.
  **Expected:** the second insert is silent — no error, no duplicate row, the original row unchanged;
  row count unchanged. **FAIL** = an error or a duplicate.

- [ ] **F-11 (AC4, QA-4.2) — BLOB (JSON-encoded) round-trips byte-identical.**
  Write a JSON-encoded BLOB; read it back on PG vs SQLite.
  **Expected:** the `BYTEA` value is byte-identical to the SQLite value; the `BLOB→BYTEA` encoder +
  the JSON bridge preserve bytes. **FAIL** = a lossy/encoded transformation.

- [ ] **F-12 (AC4, QA-4.3) — unknown `settings` key → `None` on both engines.**
  Read a key that was never written.
  **Expected:** both SQLite and PG return `None` (no error, no empty-string sentinel). **FAIL** = a
  `Some("")` or an error.

- [ ] **F-13 (AC4, QA-4.4) — hyphenated feature id maps to the same physical table name.**
  Declare a table under the feature id `mission-monitor`; round-trip on both engines.
  **Expected:** the physical name is the SAME on both engines (`feature_mission_monitor_items`) and
  data round-trips. **FAIL** = a name divergence between engines.

- [ ] **F-14 (AC5, QA-5.1) — peak RSS MITIGATE + RE-MEASURE.**
  With `max_connections` sized 5–10 and server memory knobs tuned (`shared_buffers` / `work_mem`),
  measure peak RSS before/after tuning.
  **Expected:** raw tuned before/after peak-RSS numbers recorded and compared to the #2948 baseline
  (**8.2× / +232.7 MiB**); the position is stated verbatim **MITIGATE + RE-MEASURE**; pool sizing is
  implemented, not just described. A restatement of #2948 with no re-measurement = FAIL.
  **Round 2 (spec/2975 @ 4c3741a6): PASS — the `FREDO_PG_SKIP_SERVER_KNOBS` lever (ST-7 rework) makes
  the before/after drivable.** "Before" (lever set, FRESH `pgdata-r2-untuned`, initdb defaults:
  `max_connections=100`, `shared_buffers=128MB`, `maintenance_work_mem=64MB`, `synchronous_commit=on`):
  PG 210,001,920 B (200.3 MiB) / fredo 56,061,952 B (53.5 MiB). "After" (FRESH `pgdata-r2-tuned`,
  tuned: `max_connections=8`, `shared_buffers=32MB`, `work_mem=4MB`, `maintenance_work_mem=32MB`,
  `synchronous_commit=off`): PG 168,808,448 B (161.0 MiB) / fredo 55,767,040 B (53.2 MiB).
  Delta ≈ −39.3 MiB PG RSS. Position: **MITIGATE + RE-MEASURE** (vs #2948 8.2× / +232.7 MiB).
  Caveat: steady-state WorkingSet sums (transient client backends included), not full-cycle peaks.

- [ ] **F-15 (AC5, QA-5.2) — carried regression positions (coverage, G-271).**
  Enumerate the §10 rows 2/4/5.
  **Expected:** peak RSS, batch upsert, and point read each carry their required position
  (MITIGATE + RE-MEASURE) — assert COVERAGE of the named set, never a literal count. A missing
  position = FAIL.

- [ ] **F-16 (Human MISSION-MONITOR TESTING DIRECTIVE, G-256) — boot + Mission Monitor E2E (LIVE).**
  After the seam/pool migration, boot the app and drive a **live agent action so OTLP spans ingest**
  (prefer this over `fredo emit`); open Mission Monitor; cross-check a `telemetry_spans` query at the
  same instant.
  **Expected:** the app boots; Mission Monitor lists the live session and renders its chat / tools /
  tokens from the store; `telemetry_spans` returns the landed rows for that session. Reproduce on
  BOTH the SQLite-selected and PG-selected boots. **This leg applies to this slice AND every following
  Postgres slice.** A static-only receipt = FALSE PASS.

- [ ] **F-17 (NFR, QA-N.1) — zero data loss + build/test gates.**
  Compute per-table row count + content checksum on the SQLite fixture and on PG; run
  `cargo check --locked`, `cargo clippy --locked -- -D warnings`, `cargo test --locked`.
  **Expected:** every named store (`settings`, `feature_*`, `feature_data_*`) round-trips byte-equal
  (counts + checksums) between engines; check 0 warnings, clippy clean, tests green with SQLite
  selected; the PG path is exercised by tests. **FAIL** = a checksum/count mismatch, or a red gate.

- [ ] **F-18 (promoted from E-1/E-7, FAIL #2975 round 1) — PG-selected boot must initialize the
  feature-data schema on the pool and render Mission Monitor.**
  Boot with `FREDO_STORAGE_ENGINE=postgres`; open Mission Monitor; read the PG catalogs.
  **Expected:** `feature_data_tables` / `feature_data_tombstones` (and the declared `feature_*` tables)
  exist on the PG pool after the swap; feature-data declare/read/watch succeed; Mission Monitor lists
  the live sessions. **Actual (round 1, `spec/2975 @ 9638a3d9`):** live PG boot `public` holds ONLY
  `settings`; `[feature-data] feature_data_declare failed … no existe la relación «feature_data_tables»`;
  `feature_data_read`/`feature_data_watch` fail identically; Mission Monitor `.mm-session-row` = 0.
  **Root cause:** `lib.rs:408-414` runs `FeatureDataStore::ensure_schema()` in the synchronous setup
  closure while the shared handle is still SQLite; the PG pool installs later
  (`pg_supervisor/state.rs:366-388`) and the schema is never ensured on the new engine.
  **FAIL** = any feature-data op error, or a blank Mission Monitor, on the PG-selected boot.
  **Round 2 (spec/2975 @ 4c3741a6): PARTIAL — the missing-relation error is FIXED, MM still blank.**
  The ST-2 schema-init registry now creates `settings` + `feature_data_tables` + `feature_data_tombstones`
  + `feature_terminal_sessions` on the candidate pool BEFORE install (PG `public` = 5 tables incl. the
  declared `feature_mission_monitor_sessions`; `feature_data_tables` row = `mission-monitor/sessions`);
  `feature_data_declare` no longer errors. **But** the declared-table projection FAILS on PG:
  `WARN fredo::feature_data: declared-table projection failed; canonical ingest unaffected
  feature_id=mission-monitor table=sessions error=error returned from database: no existe la columna «sessionId»`.
  PG `information_schema.columns` shows the physical `feature_mission_monitor_sessions` columns are all
  LOWERCASED (`sessionid`, `startedatns`, `latestat`, …) while `FeatureStore::upsert` writes QUOTED
  (`"sessionId"`). Root cause: `feature_data/registry.rs:693-714` `create_table_sql` builds the DDL with
  UNQUOTED identifiers (`column.name`, `full`, `table.primary_key`) — SQLite folds case-insensitively, PG
  folds to lowercase. MM renders "No sessions yet" on PG (`mm_sessions_rows = 0`). See F-20.

- [ ] **F-19 (promoted from E-1/E-4, FAIL #2975 round 1) — the gated cross-engine suite must be green
  and its content checksum must normalize hex case.**
  Run `FREDO_TEST_PG=1 cargo test --locked --test storage_engine_pg`.
  **Expected:** the SQLite↔PG row-count + content checksum is byte-equal for every named table.
  **Actual (round 1):** `FAILED` at `tests/storage_engine_pg.rs:201` — `feature_items:count=3`
  but `sum=26744f82…` (PG) ≠ `ae80b291…` (SQLite), because the observation SQL compares SQLite
  `hex(payload)` (UPPERCASE: `0001027F80FEFF`) with PG `encode(payload,'hex')` (lowercase
  `0001027f80feff`). The store-level `blob.a` observable matched on both engines — the defect is the
  test's SQL normalization, not data loss. **FAIL** = a red gated suite.
  **Round 2 (spec/2975 @ 4c3741a6): STILL RED — moved past the hex defect to a new assertion defect.**
  `FREDO_TEST_PG=1 cargo test --locked --test storage_engine_pg` → exit 101, `FAILED` at
  `tests/storage_engine_pg.rs:278`:
  `assertion left == right failed: the identifier must be stored double-quoted and case-preserving
  left: Some("\"feature_CaseTest_widgets\"")  right: Some("feature_CaseTest_widgets")`.
  The hex fix WORKED (Phase 1 — the cross-engine row-count + SHA-256 content checksum and all AC4
  edges — now passes); the suite now aborts in Phase 2 (`quoted_identifier_scenario`) because
  `to_regclass('"feature_CaseTest_widgets"')::text` returns the name WITH its quoting (`"feature_…"`,
  PG's regclass text for a mixed-case identifier) and the assertion expects it without quotes. Test
  defect; the case-preservation intent is proven by the preceding assertions (unquoted lookup folds to
  lowercase → `None`; quoted lookup resolves). Phase 3 (`schema_init_scenario`) therefore never ran.
  **FAIL** = a red gated suite.

- [ ] **F-20 (promoted from E-11 round 2, FAIL #2975 round 2) — a declared-table with a mixed-case PK
  must be created on PostgreSQL with QUOTED (case-preserving) identifiers.**
  Declare the MM `sessions` table (PK `sessionId`) on the PG engine and write a row.
  **Expected:** the physical `feature_mission_monitor_sessions` columns are `"sessionId"`, `"latestAt"`,
  … (case-preserved, i.e. `information_schema.columns` shows `sessionId`); the projection upsert
  succeeds and rows land. **Actual:** PG creates them lowercased; every projection write fails
  `no existe la columna «sessionId»`; the table stays empty and Mission Monitor renders nothing on PG.
  **Root cause:** `infrastructure/feature_data/registry.rs:693-714` (`create_table_sql`) interpolates
  raw identifiers instead of `quote_ident` (unlike `FeatureStore::ensure_table_on_pg`), so PostgreSQL
  folds the camelCase names. **FAIL** = any mixed-case declared column/PK on PG.

## Non-functional

- [ ] **N-1 (pool sizing / RSS):** `max_connections` 5–10 + tuned server memory knobs, measured
  before/after (F-14); the #2948 RSS regression stays MITIGATE + RE-MEASURE.
- [ ] **N-2 (fail-closed):** a PG failure never mutates `fredo.db` and never crashes the app (F-9);
  SQLite remains the backout.
- [ ] **N-3 (build hygiene):** F-17 green; `cargo check` alone does not clear the clippy gate.
- [ ] **N-4 (no row-pipeline regression):** Mission Monitor still renders from the store (F-16);
  emission remains ONLY via `EventBus.emit_row_delivery_batch`; row-merge semantics unchanged.

## Suite-level pass/fail

PASS = F-1..F-17 all green and N-1..N-4 hold. Any per-store connection, any user-visible change under
SQLite, a mutated `fredo.db` on PG failure, a count/checksum mismatch, an unbounded wait, or F-16
failing = **FAIL**.
