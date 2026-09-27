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

---

# postgres-stores — Functional (Slice 3, issue #2976) — RtdbStore + SpanStore on the shared pool

> Slice 3 of 6: migrate the RTDB canonical store (`RtdbStore`) and `SpanStore` onto the shared
> PostgreSQL pool while preserving the write-behind / bounded-LRU pipeline contract EXACTLY. Slice 2
> (#2975) already migrated `AppStore`/`FeatureStore`/`FeatureDataStore`; the pool + seam exist.
> One `- [ ]` case per requirement (REQ-1..REQ-5 ↔ AC1..AC5); observable expected outcome per case.
>
> **Evidence policy: LIVE** — the store swap, the row-pipeline contract, and the Mission Monitor
> acceptance row are only provable by observing a running artifact; their Evidence MUST reference
> `telemetry_spans` (an OTLP-ingested live receipt — the CLI `fredo emit` path writes NO spans,
> G-256) and/or an RTDB-row / `pg_stat_activity` live read. A static-only PASS is a FALSE PASS.
>
> **CRITICAL PRESERVATION CONTRACT (slice's #1 invariant):** the RTDB row-pipeline semantics MUST NOT
> change — the ~30 ms write-behind queue + LRU cache, merge/seq semantics, the `telemetry_spans`
> read-only stance, and `EventBus.emit_row_delivery_batch` as the ONLY emission path. No second
> extraction path (NFR-6). Pinned as regression invariants R-19..R-27.
>
> **G-263 SAFETY:** every live leg is bounded and torn down via
> `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 2976` / `-Action Down`; never a
> bare `postgres`/`pg_ctl`; the named failure mode is the #2948 ~11 h `pg.stop()` hang. An observed
> unbounded wait is a FAIL, not a skip.

## Requirements → cases (Slice 3)

- [ ] **F-21 (REQ-1/AC1) — `RtdbStore` + `SpanStore` on the ONE shared pool; read-only handle for the backfill/RTDB canonical reads.**
  Boot PG-selected on a fresh data dir; read the startup wiring, the live client view
  (`pg_stat_activity`), and the store constructions.
  **Expected:** exactly ONE pool (built once on the background task after `await_ready`, installed
  once into the shared `EngineHandle`); `RtdbStore` and `SpanStore` each hold an `Arc<EngineHandle>`
  clone (no `Mutex<Connection>`, no per-store `Connection::open`); backend connections bounded by the
  pool's `max_connections` (5–10); the backfill/RTDB canonical read path acquires a read-only
  handle/tx (`SET TRANSACTION READ ONLY` / least-privilege role). **FAIL** = a second pool, a per-store
  connection, or a non-read-only canonical read.

- [ ] **F-22 (REQ-1/AC1) — 1:1 DDL: composite PKs, `ERROR` partial index, `GENERATED ALWAYS AS IDENTITY`, full-row `ON CONFLICT(<pk>) DO UPDATE … EXCLUDED`.**
  Read `information_schema.columns` + `pg_indexes` after a PG boot; round-trip a full row on each
  table and re-upsert the same key.
  **Expected:** `chat_rows`/`tool_use_rows`/`agent_session_rows` PK `(session_id, correlation_id)`;
  `telemetry_spans` PK `span_id`; `telemetry_logs`/`telemetry_metrics` id `GENERATED ALWAYS AS
  IDENTITY`; `idx_telemetry_spans_error` partial `WHERE status_code = 'ERROR'`; every column 1:1 with
  the SQLite schema; re-upsert updates in place (no duplicate); statements use `EXCLUDED.` and
  `ON CONFLICT`. **FAIL** = a wrong/missing column, a single-column PK on a `*_rows` table, a lowercased
  camelCase identifier, or an untranslated `INSERT OR REPLACE`.

- [ ] **F-23 (REQ-2/AC2) — write-behind + LRU constants preserved EXACTLY.**
  Inspect the shipped constants (`rtdb/cache.rs:47-54`) and drive a mixed-kind burst, reading the
  flush log.
  **Expected:** `DEFAULT_CACHE_CAPACITY == 10_000` (per row type), `QUEUE_CAPACITY == 4096`,
  `try_send` (never blocking `send().await`), `WRITER_FLUSH_MS == 30`, `WRITER_PRUNE_INTERVAL == 60
  min`; cache update + enqueue stay SYNCHRONOUS; one transaction per kind per batch. **FAIL** = any
  changed constant, a blocking enqueue, or a per-row transaction.

- [ ] **F-24 (REQ-2/AC2) — durable seq seeded `COALESCE(MAX(seq),0)`, never resets across restart; gaps acceptable.**
  Restart the app over the same PG data dir; request the next seq for a pre-existing key; force a shed
  write then restart.
  **Expected:** seq monotonic per `(kind, session_id, correlation_id)`; a restart continues from the
  persisted `MAX(seq)` (never 1); a shed write leaves a gap but storage stays monotonic. **FAIL** = a
  reset to 1 after restart, or a non-monotonic read.

- [ ] **F-25 (REQ-3/AC3) — `telemetry_spans` strictly READ-ONLY to the RTDB/backfill path; a write through it is REJECTED.**
  Exercise the RTDB/backfill canonical read; attempt a write through the read-only handle.
  **Expected:** the read-only handle/tx rejects a write; no separate connection; the RTDB/backfill
  path never writes `telemetry_spans`; the rejection does not poison the shared pool for writers.
  **FAIL** = an accepted write, or a write reaching `telemetry_spans`.

- [ ] **F-26 (REQ-3/AC3, NFR-6) — canonical backfill uses the shared `rtdb/attrs.rs` extract path; no duplicate extraction.**
  Run the canonical backfill; code-inspect the extract entry points.
  **Expected:** the live classifier AND the canonical backfill call the SAME `rtdb/attrs.rs` helpers;
  no fork / duplicated extraction; re-derivation is byte-comparable with live derivation. **FAIL** = a
  copied extract rule in backfill code.

- [ ] **F-27 (REQ-4/AC4) — RTDB wire contract unchanged: `RowDeliveryBatch` only on `"fredo-stream-event"`, consumed via `useEventRows(eventType, args, options)`.**
  Capture IPC (`tauri_ipc_monitor`) during live ingest; inspect the row wire types + emission sites.
  **Expected:** rows cross IPC ONLY as `RowDeliveryBatch` on `"fredo-stream-event"`; emission is ONLY
  via `EventBus.emit_row_delivery_batch` (no `app_handle.emit()` row delivery); `useEventRows` args +
  merge semantics unchanged. **FAIL** = a new event type/payload field, or a direct emit.

- [ ] **F-28 (REQ-4/AC4) — a 500-row burst coalesces into FEWER batches than rows.**
  `fredo emit` a bounded 500-row burst (row-path only); count envelopes via `tauri_ipc_monitor`; read
  the flush log.
  **Expected:** emitted envelopes < 500 (coalesced); one transaction per kind per batch on PG; no
  per-row flood; `RTDB_MAX_EMISSION_BATCH = 512` chunking respected. **FAIL** = per-row envelopes, or
  an unbounded flood.

- [ ] **F-29 (REQ-4/AC4) — cap-1 LRU evict-then-reload from PostgreSQL.**
  Use the existing cap-1 seam (`RtdbCache::with_capacity`); write two rows, flush, read the evicted
  key.
  **Expected:** the evicted row reloads from PG (authoritative) and re-populates the cache; the cap is
  enforced across the reload; a miss with no stored row returns `None`. **FAIL** = a reload that
  bypasses PG, or a cap not enforced on reload.

- [ ] **F-30 (REQ-4/AC4) — overflow sheds STORAGE writes while ALL rows stay in memory.**
  Use the queue-cap-1 seam (or a controlled overflow); read `dropped_count` + every row from the
  cache.
  **Expected:** queued/storage writes are shed and counted (`dropped_count > 0`); every in-memory row
  is still readable; `upsert_*` returns immediately (non-blocking); the writer task continues. **FAIL**
  = a lost in-memory row, or a blocking enqueue.

- [ ] **F-31 (REQ-4/AC4) — range read `sum(bigint)::bigint` shape-parity with SQLite, ZERO mismatches.**
  Run the range-read aggregate on PG vs the SQLite fixture over the same rows.
  **Expected:** the result TYPE and value match SQLite (`bigint`, not `numeric`/text); zero value
  mismatches. **FAIL** = a `sum() → numeric` type drift, or any mismatch.

- [ ] **F-32 (REQ-4/AC4) — prune remains the ONLY `kind: remove` producer.**
  Force a prune; observe the remove deliveries; exercise the merge/update/re-key path.
  **Expected:** prune evictions are the ONLY `kind: remove` producer; `insert` spread-merges,
  `update` is seq-guarded (stale patches dropped), a re-key NEVER removes rows. **FAIL** = a remove
  emitted by a re-key/update.

- [ ] **F-33 (REQ-5/AC5) — batch-upsert regression position: MITIGATE + RE-MEASURE (spike ~5.4×).**
  Measure batch upsert (e.g. 1,000 rows, median of 3) on the BEFORE leg (pre-change tip) and the
  AFTER leg (tested tip).
  **Expected:** a literal BEFORE|AFTER|Δ number table; the position stated verbatim **MITIGATE +
  RE-MEASURE**; a mitigation implemented (e.g. multi-row `INSERT … VALUES (…),(…)` / prepared
  statements), not merely described. A restatement of the spike with no re-measurement = FAIL.

- [ ] **F-34 (REQ-5/AC5) — point-read regression position: MITIGATE + RE-MEASURE (spike ~12–15×).**
  Measure the cache-miss point read (median of N) on the BEFORE and AFTER legs.
  **Expected:** a literal BEFORE|AFTER|Δ number table; position stated verbatim **MITIGATE +
  RE-MEASURE**; a mitigation implemented (indexed PK lookup / prepared statement; cache unchanged).
  A restatement with no re-measurement = FAIL.

- [ ] **F-35 (REQ-5/AC5) — range-read regression position: ACCEPT (spike ~1.2–1.6× faster).**
  Measure the snapshot/range select (median of 3) on the BEFORE and AFTER legs.
  **Expected:** a literal BEFORE|AFTER|Δ number table; position stated verbatim **ACCEPT**; no
  regression vs SQLite (faster or equal). A restatement with no re-measurement = FAIL.

- [ ] **F-36 (REQ-5/AC5) — data-dir growth position: MITIGATE + RE-MEASURE (spike +57.8 MiB).**
  Measure the data-dir footprint (SQLite `fredo.db` + PG data dir) on the BEFORE and AFTER legs.
  **Expected:** a literal BEFORE|AFTER|Δ byte table; position stated verbatim **MITIGATE +
  RE-MEASURE**; a mitigation implemented (memory/connection knobs, vacuum/WAL sizing). A restatement
  with no re-measurement = FAIL.

- [ ] **F-37 (REQ-5/AC5, coverage) — the four named regression positions are carried.**
  Enumerate the §positions (batch upsert, point read, range read, data-dir).
  **Expected:** each named position carries its required verdict (MITIGATE + RE-MEASURE ×3, ACCEPT
  ×1) — assert COVERAGE of the named set, never a literal count. A missing position = FAIL.

- [ ] **F-38 (NFR) — zero-warning build gates + one shared extract path + no new unbounded wait.**
  Run `cargo check --locked`, `cargo clippy --locked -- -D warnings`, `cargo test --locked`; inspect
  the extract path and await bounds.
  **Expected:** check 0 warnings, clippy clean, tests green; `rtdb/attrs.rs` is the sole extract
  implementation; every start/stop/live leg is bounded. **FAIL** = check green but clippy red (does
  NOT clear the gate), a second extract path, or an await without a finite bound.

- [ ] **F-39 (HUMAN DIRECTIVE, mission-monitor acceptance — duplicate of `mission-monitor` F-54).**
  Boot the app PG-selected on the migrated store; drive a live OpenCode session (Terminal feature) AND
  a Copilot session (in-repo split-turn producer) at ONE instant; open Mission Monitor; snapshot the
  DOM + screenshot; query `telemetry_spans` + `chat_rows`/`tool_use_rows`/`agent_session_rows` +
  `pg_stat_activity` at the SAME instant.
  **Expected:** both sessions listed as distinct entries; selecting each renders chat node +
  `── TOOLS (N) ──` + RESPONSE + tokens + graph; the rendered data equals the same-instant
  `telemetry_spans`/row columns; identical structural detail to the pre-migration OpenCode baseline;
  the migrated `*_rows` tables serve the rows (not SQLite). **FAIL** = a blank panel while rows exist,
  a stale SQLite fallback, or a single-provider receipt. A static-only receipt = FALSE PASS.

- [ ] **F-40 (REQ-3/AC1) — full-row `ON CONFLICT(<pk>) DO UPDATE … EXCLUDED` upsert parity with SQLite `INSERT OR REPLACE`.**
  Write a full row, mutate every non-PK column, re-upsert the same PK on PostgreSQL; repeat on the
  SQLite fixture.
  **Expected:** the re-upsert updates every non-PK column in place (`EXCLUDED.`, uppercase); no
  duplicate; the persisted row equals the SQLite full-row result; a re-upsert is a FULL-row write
  (never partial). **FAIL** = a partial-column update, a duplicate, or `excluded.` left untranslated.

- [ ] **F-41 (REQ-12/AC1) — duplicate `span_id` is ignored on PostgreSQL (`ON CONFLICT(span_id) DO NOTHING`).**
  Insert a span twice through `insert_spans` and `insert_raw_spans` on the PG store.
  **Expected:** the second insert affects 0 rows, no error, no duplicate; the original row is
  unchanged; `stats().span_count` stays 1. **FAIL** = an error, a duplicate, or an overwritten row.

## Non-functional (Slice 3)

- [ ] **N-5 (perf positions):** F-33..F-36 carry BEFORE/AFTER numbers + the verbatim position; a
  restatement with no re-measurement = FAIL.
- [ ] **N-6 (bounded / non-blocking):** no leg runs unbounded; the write-behind path never blocks on
  the pool; the cache update + enqueue stay synchronous (F-23/F-30); start/stop are finite (G-263).
- [ ] **N-7 (build hygiene):** F-38 green; Windows-first; no `#[allow(...)]`; `fredo.db` untouched
  when SQLite is selected.
- [ ] **N-8 (preservation contract):** R-19..R-27 (regression.md) pin every preserved constant + the
  sole emission path + merge/seq semantics — any FAIL is a slice-wide FAIL.

## Suite-level pass/fail

PASS = F-1..F-20 (slices 1–2) all green AND F-21..F-41 (slice 3) all green, with N-1..N-8 holding.
Any per-store connection, any user-visible change under SQLite, a mutated `fredo.db` on PG failure, a
count/checksum mismatch, a row-pipeline semantic change, a write reaching `telemetry_spans`, a blank
Mission Monitor while rows exist, or an unbounded wait = **FAIL**.
