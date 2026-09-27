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
