# Migrating Fredo's local persistence from embedded SQLite (`fredo.db`) to embedded PostgreSQL — the migration approach

- **Issue:** #2964 (spike; the migration is **mandated** — the question is HOW, not whether)
- **Revises:** #2948 (`fix`) — #2948 answered "should we?" and returned NO-GO; its measurements stand as **design inputs**, not a veto
- **Method:** **BOTH** an executed, isolated PoC against a real embedded PostgreSQL **AND** a file-level written design (see §3)
- **Time-box:** 3 working days, Windows-first — met (see §11)
- **Production change:** **NONE.** No file under `apps/**` is edited; this document + the section files + the isolated `spikes/2964-postgres-migration/` PoC are the deliverables
- **PoC artifact:** [`spikes/2964-postgres-migration/`](../../spikes/2964-postgres-migration/)
- **Section files:** [`store-migration.md`](2964-postgres-migration-approach/store-migration.md) (ST-2),
  [`data-migration.md`](2964-postgres-migration-approach/data-migration.md) (ST-4),
  [`startup-lifecycle.md`](2964-postgres-migration-approach/startup-lifecycle.md) (ST-5),
  [`packaging-install.md`](2964-postgres-migration-approach/packaging-install.md) (ST-6)
- **Inputs:** [`spikes/2948-embedded-postgres/results/measurements.json`](../../spikes/2948-embedded-postgres/results/measurements.json),
  [`spikes/2948-embedded-postgres/QUESTIONS.md`](../../spikes/2948-embedded-postgres/QUESTIONS.md),
  [`docs/research/2948-embedded-postgres-spike.md`](2948-embedded-postgres-spike.md)

> **How to read this document.** It is self-contained enough to satisfy AC1–AC5 on its own,
> while referring to the four section files for full depth. Every `file:line` citation below
> resolves on `main`; every measured number reconciles with a committed `results/*.json`.

---

## 1. Executive summary

Fredo persists **all** local state in one embedded SQLite file, `fredo.db` (`rusqlite 0.32`,
`bundled`), opened independently by five stores plus three auxiliary read-only connections. The
migration to **embedded PostgreSQL** (`theseus-rs/postgresql-embedded`) replaces **one file with
N `Mutex<Connection>` handles** by **one shared `sqlx::PgPool`**, re-expresses every
SQLite-specific behavior, carries the existing rows through a **fail-closed staged one-shot
export/import** with a row-count + SHA-256 **parity check**, supervises the PostgreSQL sidecar with
a **bounded start/stop + guaranteed teardown + PID-reuse-guarded orphan sweep**, and keeps
`fredo.db` as the **executable backout**. The RTDB row-pipeline contract
(`RowDeliveryBatch` on `"fredo-stream-event"` / `useEventRows`) is **untouched** — the swap happens
strictly below the store layer.

The six scope areas required by AC1 are §4–§9. Every #2948 regression is positioned in §10
(MITIGATE / ACCEPT / RE-MEASURE). Open questions for the follow-up implementation spec are §12.

**One-line status:** the approach is concrete, each #2948 regression is owned, data
preservation and rollback are specified, and no production path changed.

---

## 2. The invariants the migration must not break

These are hard, from the backlog constraints and the existing architecture; they are restated
because every scope area below is designed around them.

1. **RTDB wire contract unchanged.** `RowDeliveryBatch` on the `"fredo-stream-event"` IPC channel
   and the `useEventRows(eventType, args, options)` consumer contract are untouched. No envelope,
   field, or query-language change. The storage swap sits *below* `RtdbStore`.
2. **Row-merge semantics unchanged.** Insert spread-merge (init-time fields survive), seq-guarded
   `update` stale-patch drop, `remove` only ever from retention eviction. The store writes **full**
   rows and never merges — so the engine swap cannot alter merge behavior.
3. **`telemetry_spans` stays strictly READ-ONLY** to the RTDB/backfill path
   (`infrastructure/rtdb/store.rs:5-7`, `infrastructure/rtdb/backfill.rs:218,367`,
   `infrastructure/feature_data/backfill.rs:287-288`,
   `infrastructure/feature_data/projection.rs:198-202`).
4. **NFR-6 single extraction path.** `infrastructure/rtdb/attrs.rs` remains the ONE shared
   extract-rule implementation for the live classifier and the canonical backfill — no fork, no
   duplicate extraction path.
5. **One-shot markers are DATA, carried verbatim** — never re-derived (see §6).
6. **Windows-first.** The PoC ran on win32/x86_64; `postgres.exe` / `pg_ctl` / the data-dir path
   are Windows lifecycle specifics.

---

## 3. Method — why BOTH a PoC and a written design (AC3)

**Both were produced, deliberately:**

- **The isolated PoC** at [`spikes/2964-postgres-migration/`](../../spikes/2964-postgres-migration/)
  is a standalone crate (never a Cargo workspace member, never referenced by `lib.rs`/`AppRuntime`,
  no dependency added to `apps/tauri/src-tauri/Cargo.toml`). It executes the riskiest paths against
  a **real embedded PostgreSQL 18.6.0** on Windows x86_64 (`postgresql_embedded` 0.21,
  `runtime-download`): schema/statement translation, the RTDB write-behind + bounded-LRU queue, the
  parity carry + marker preservation + rollback demonstration, and the full supervisor lifecycle.
- **The file-level written design** is this document plus the four section files. It names every
  changed file and its new contract (store signatures, DDL, lib.rs wiring, the supervisor) — a PoC
  alone could not specify the production wiring, and prose alone could not be trusted on the
  lifecycle (the #2948 ~11 h `pg.stop()` hang).

**Why both:** the PoC is the *proof of mechanism* where prose fails (schema equivalence by SHA-256
checksum, bounded teardown, no orphan) and the written design is the *specification* the follow-up
implementation spec consumes (file-by-file contracts, open questions). AC3 admits either; producing
both removes the residual risk each leaves.

**Committed PoC results (all on the spec branch):**

| Result | Binary | Command | Committed evidence |
|---|---|---|---|
| `results/schema-translation.json` | `schema` | `cargo run --release --bin schema` | 18/18 checks, identical SQLite↔PG SHA-256 content checksum |
| `results/bench.json` | `bench` | `cargo run --release --bin bench` | 10 000 ops · one tx / 512 rows · upsert ~833 ms · 0 point-read mismatches |
| `results/write-behind.json` | `write_behind` | `cargo run --release --bin write_behind` | 9/9 checks; 500-row burst → 1 batch; lone write 5.68 ms; overflow sheds storage, not memory |
| `results/parity.json` | `parity` | `cargo run --release --bin parity` | 8/8 tables count+checksum matched; markers carried unchanged; rollback demonstrated (508 ms) |
| `results/lifecycle.json` | `supervisor` | `cargo run --release --bin supervisor` | 20/20 checks; start 985 ms · ready 128 ms · stop 398 ms · hard-kill 213 ms; no orphan (76 s run) |

**No production code path changed.** The only added/changed files are under
`docs/research/2964-postgres-migration-approach*` and `spikes/2964-postgres-migration/**`. The
harness never opens the real `fredo.db`; every data directory is a throwaway path under
`spikes/2964-postgres-migration/target/spike-tmp/`.

### 3.1 The plan's contracts C1–C4

| Contract | What it binds | Where proven |
|---|---|---|
| **C1** — schema/collation translation | `TEXT→TEXT`, `INTEGER→BIGINT`, `REAL→DOUBLE PRECISION`, `BLOB→BYTEA`; `INTEGER PRIMARY KEY AUTOINCREMENT→BIGINT GENERATED ALWAYS AS IDENTITY`; `INSERT OR REPLACE→ON CONFLICT(<pk>) DO UPDATE … EXCLUDED`; `INSERT OR IGNORE→ON CONFLICT DO NOTHING`; `?n→$n`; composite PK 1:1 (`spikes/2964-postgres-migration/src/schema_defs.rs:12-22`) | `results/schema-translation.json` 18/18 |
| **C2** — parity result contract | per-table row count + SHA-256 content checksum, marker values, rollback record (`spikes/2964-postgres-migration/src/parity.rs`) | `results/parity.json` |
| **C3** — bind contract | ephemeral loopback (`settings.port = 0`) — no fixed-port collision with OTLP 4317/4318 or the MCP bridge 9223 (`spikes/2964-postgres-migration/src/harness.rs:228`) | `results/lifecycle.json`, `results/parity.json` |
| **C4** — lifecycle contract with bounds | every blocking wait capped (`spikes/2964-postgres-migration/src/harness.rs:28-38`): control 180 s, setup 600 s, start 180 s, stop 30 s + hard-kill watchdog, connect 10 s, readiness 60 s; three teardown layers + orphan sweep | `results/lifecycle.json` 20/20 |

---

## 4. Scope area (a) — Schema mapping: SQLite DDL → PostgreSQL DDL

Every `fredo.db` store, its owner, and its translation. Type mapping is the **C1** rule
(`spikes/2964-postgres-migration/src/schema_defs.rs:12-22`); it is verified against
`information_schema` for the representative `chat_rows`/`settings` pair (18/18 checks,
`results/schema-translation.json`).

### 4.1 Store inventory and DDL mapping

| # | Store (owner) | Open site (`file:line`) | Tables | SQLite → PG mapping |
|---|---|---|---|---|
| 1 | `AppStore` KV | `infrastructure/storage/mod.rs:11-32` (struct `:11-13`, `open`+DDL `:17-32`) | `settings (key TEXT PK, value TEXT NOT NULL)` | 1:1 (`TEXT`/`TEXT`); upsert `excluded.value` → `EXCLUDED.value` (`:48-50`); point read `?1`→`$1` (`:36`) |
| 2 | `FeatureStore` | `infrastructure/storage/feature_store.rs:95-127` (struct/open), `:240-271` (`ensure_table`) | dynamic `feature_{featureId}_{tableName}` + reserved `_row_version`/`_updated_at` | `ColumnType::as_sql_type` (`:31-38`) `TEXT→TEXT`, `INTEGER→BIGINT`, `REAL→DOUBLE PRECISION`, `BLOB→BYTEA`; generated `CREATE TABLE IF NOT EXISTS` (`:262-266`) 1:1 |
| 3 | `SpanStore` | `infrastructure/storage/span_store.rs:46-98` (struct `:46-48`, `open` `:52-60`, `telemetry_spans` DDL `:63-98`) | `telemetry_spans (span_id TEXT PK)`, `telemetry_logs`, `telemetry_metrics` | `TEXT→TEXT`, `INTEGER→BIGINT`; `INTEGER PRIMARY KEY AUTOINCREMENT` → `BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY` (`:104`, `:474`); partial index `WHERE status_code='ERROR'` (`:92-93`) 1:1 |
| 4 | `RtdbStore` | `infrastructure/rtdb/store.rs:283-407` (struct `:283-288`, `open` `:294-304`, `ensure_schema` `:307-407`) | `chat_rows` (18 cols, `:310-336`), `tool_use_rows` (16 cols, `:338-356`), `agent_session_rows` (13 cols, `:364-385`) | `TEXT→TEXT`, `INTEGER→BIGINT`, `REAL→DOUBLE PRECISION`; composite PK `(session_id, correlation_id)` 1:1; three indexes per table 1:1 |
| 5 | `FeatureDataStore` | `infrastructure/feature_data/store.rs:46-85` (struct `:46-48`, `open` `:52-61`, `ensure_schema` `:64-85`) | `feature_data_tables` (PK `feature_id, table_name`, `:67-75`), `feature_data_tombstones` (PK `feature_id, table_name, key_json`, `:76-82`) | PKs 1:1; upserts `excluded.` → `EXCLUDED.` (`:125-129`, `:171-173`) |

Types/PKs/indexes are validated concretely on the representative pair: `chat_rows`'s 18 columns
match `bigint`/`double precision`/`text`, the composite PK is `("session_id", "correlation_id")`,
and `idx_chat_started` / `idx_chat_session_time` / `idx_chat_updated` are present
(`results/schema-translation.json` → `chat_rows_type_mapping`, `chat_rows_composite_pk`,
`chat_rows_indexes`); `settings` maps to `key text PK, value text NOT NULL`
(`settings_kv_mapping`, `settings_pk`).

### 4.2 SQLite-specific behavior that must be re-expressed

| SQLite construct | Call sites (`file:line`) | PG re-expression | Invariant preserved |
|---|---|---|---|
| `PRAGMA journal_mode=WAL` | `rtdb/store.rs:298`, `feature_store.rs:123`, `span_store.rs:56`, `feature_data/store.rs:56`, `feature_data/projection.rs:199` | **drop** — PG WAL is always on | durability model unchanged at the contract level |
| `PRAGMA synchronous=NORMAL` | `rtdb/store.rs:299`, `feature_data/store.rs:57` | `synchronous_commit = off` (server setting; verified `synchronous_commit_off`) | the deliberate perf/durability trade documented at `rtdb/store.rs:291-293` |
| `INSERT OR REPLACE` (full-row upsert) | `rtdb/store.rs:424-429`, `:478-482`, `:529-533` | `INSERT … ON CONFLICT(<pk>) DO UPDATE SET <every non-PK> = EXCLUDED.<c>` | full-row write keyed on the composite PK (the PK **is** the identity) |
| `INSERT OR IGNORE` | `feature_store.rs:295`, `span_store.rs:141-146`, `:192-197` | `INSERT … ON CONFLICT DO NOTHING` (verified `insert_or_ignore_translation`) | idempotent duplicate-PK ignore |
| `ON CONFLICT(k) DO UPDATE SET c=excluded.c` | `storage/mod.rs:48-50`, `feature_store.rs:375-381`, `feature_data/store.rs:125-129`, `:171-173` | `… = EXCLUDED.c` (verified `settings_upsert_translation`) | upsert semantics |
| `INTEGER PRIMARY KEY AUTOINCREMENT` | `span_store.rs:104` (`telemetry_logs.id`), `:474` (`telemetry_metrics.id`) | `BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY` (verified `autoincrement_to_identity`) | monotonic id, never reused |
| `PRAGMA incremental_vacuum` after a delete batch | `rtdb/store.rs:765,842`; `span_store.rs:249,265,281,445,566` | **drop** — autovacuum (tuned) | one delete batch = one logical reclaim point |
| `PRAGMA query_only=ON` read-only guard | `feature_data/backfill.rs:288`, `feature_data/projection.rs:202` | `START TRANSACTION READ ONLY` / a read-only role (verified `query_only_to_read_only_tx`) | canonical reads never write |
| Partial index `WHERE status_code='ERROR'` | `span_store.rs:92-93` | partial index `WHERE status_code = 'ERROR'` (1:1) | same plan shape |
| `pragma_table_info(t)` | `feature_store.rs:176,432`; `rtdb/store.rs:123` | `information_schema.columns` (+ `pg_index`/`pg_attribute` for pk/notnull) | guarded-ALTER idempotency |
| `sqlite_master` existence probe | `feature_store.rs:419`; `rtdb/backfill.rs:222,371` | `to_regclass('t')` / `information_schema.tables` (verified `sqlite_master_to_regclass`) | table-present probes |
| `?n` positional placeholders | `storage/mod.rs:36,48`; `feature_store.rs:176,354,432,497,560,567,609`; `span_store.rs:146,197,238,255,271,436,557`; `rtdb/store.rs:123,429,482,533,722`; `feature_data/store.rs:94,124,147,157,170,194,208`; `rtdb/backfill.rs:185,396` | `$n` (verified `point_read_translation`, `range_read_translation`) | parameter binding order |
| `DELETE … RETURNING` | `rtdb/store.rs:752-755`, `:811-835` | natively supported | evicted-key routing (`kind: remove`, the only remove producer) |
| `COALESCE(MAX(seq),0)` durable-seq seed | `rtdb/store.rs:722` | same SQL | seq never resets across restart; gaps remain acceptable |

**Statement-batching note.** `feature_store.rs:408-412` and `feature_data/registry.rs` build
DDL/DML batches as strings; in PG a multi-statement string needs the simple-query protocol, so the
design routes those through `sqlx::raw_sql` rather than the extended protocol. One non-obvious
translation detail: PG `sum(bigint)` yields `numeric`, so the range read casts `::bigint` to keep
the read shape identical to SQLite (`spikes/2964-postgres-migration/src/schema_defs.rs:175-176`).

**Chosen approach:** direct 1:1 DDL translation with the C1 type map, placeholder conversion, and
the upsert re-expressions above; no schema tooling or extension is adopted. **No blocker.**

---

## 5. Scope area (b) — Store / module migration path

**Full design:** [`store-migration.md`](2964-postgres-migration-approach/store-migration.md) (ST-2).
Summary:

- **The shared pool.** One `sqlx::PgPool` is created once in `lib.rs`'s setup closure (before any
  store is constructed) and cloned into every store. The five `Mutex<Connection>` handles and the
  three auxiliary read-only connections (inventory in `store-migration.md` §1) become pool handles.
  `sqlx 0.8` is already declared at `apps/tauri/src-tauri/Cargo.toml:51` (observability-only today;
  client choice is open question Q-5, §12).
- **Per-module changes** (`store-migration.md` §2): `AppStore` (`storage/mod.rs:11-32`),
  `FeatureStore` (`feature_store.rs:95-127,240-271`), `SpanStore` (`span_store.rs:46-98`),
  `RtdbStore` (`rtdb/store.rs:283-407`), `FeatureDataStore`
  (`feature_data/store.rs:46-85`), and the read-only `ProjectionEngine`
  (`feature_data/projection.rs:190-212`) / declared-table backfill
  (`feature_data/backfill.rs:286-298`) / canonical RTDB backfill (`rtdb/backfill.rs:213-292,357-374`).
  Store constructors lose their `data_dir: PathBuf` argument; `std::fs::create_dir_all(&data_dir)`
  calls are deleted (PG owns its data dir); per-store `lock_conn` helpers are deleted (the
  in-memory `seq_counters` lock at `rtdb/store.rs:873-878` is retained).
- **The real signature change: sync → async.** `rusqlite` is synchronous, `sqlx` is async, so every
  store method becomes `async`, propagating `.await` into `rtdb/cache.rs` (`flush_pending`
  `:376-398`, cache-miss reloads `:261-326`), `rtdb/ingest.rs`, `rtdb/commands.rs`, `rtdb/query/*`.
  **The in-memory cache update path and the enqueue stay synchronous and non-blocking** — only the
  enqueue (`try_send`) and the later async flush move. This is what keeps "storage sheds, delivery
  never does".
- **The perf-sensitive core is preserved exactly** (`store-migration.md` §5): bounded LRU
  `DEFAULT_CACHE_CAPACITY = 10_000` (`rtdb/cache.rs:47`), bounded queue `QUEUE_CAPACITY = 4096`
  (`:49`), `try_send` never blocks, overflow **sheds the storage write not in-memory state**
  (`:164,210`, `:400-403`), ~30 ms coalescing `WRITER_FLUSH_MS = 30` (`:51`), one transaction per
  kind per batch (`flush_pending` `:376-398`), 60-minute prune cadence (`:54`, `:490-539`). The
  PoC validates this against PG: a 500-row burst coalesces into **1 batch**, a lone write persists
  in **5.68 ms**, a cap-1 LRU evicts then **reloads from PG**, and an overflow sheds exactly the
  storage writes while all rows remain in memory (`results/write-behind.json`, 9/9).
- **`lib.rs` wiring** (`store-migration.md` §6): `AppStore` `lib.rs:116-119`, `FeatureStore`
  `:122-125`, `SpanStore` `:184-192`, `RtdbStore` `:323-330`, `FeatureDataStore` `:365-370`,
  `ProjectionEngine` `:390-397`, writer spawn `:503-506`, backfill spawns `:430-438,527-533` — all
  move from file paths to the shared pool in the same order; the single new artifact is the pool
  creation (~`lib.rs:112-116`). `tauri::async_runtime::spawn` discipline is unchanged.

**Chosen approach:** one shared async pool, mechanical SQL conversion, invariants preserved rather
than redesigned. **No blocker.**

---

## 6. Scope area (c) — `fredo.db` data migration / backfill

**Full design:** [`data-migration.md`](2964-postgres-migration-approach/data-migration.md) (ST-4).
Summary:

### 6.1 Cutover decision (R-5c): staged one-shot export/import

**Decided — one-shot, not dual-write, not side-by-side reconciliation.** Justification: every
`fredo.db` writer is in-process and serialized (one `Mutex<Connection>` per store, no second writer
process), so there is no external producer a dual-write would have to keep in sync; the app
quiesces its writers for the duration. Dual-write would fan out on every store write (doubling the
~30 ms write-behind failure surface), require cross-engine reconciliation of the durable seq
(`rtdb/store.rs:17-24`) and retention prunes (`:739-846`), and leave "which engine is
authoritative?" ambiguous on read. Fail-closed sequence (`data-migration.md` §1.2): a failure at any
of steps 1–7 leaves `fredo.db` untouched and the app starts on SQLite. Residual named: post-cutover
rows live only in PG (downgrade policy = Q-14).

### 6.2 Per-store carry + parity contract (R-5a)

Every store is carried by the same one-shot export/import keyed on each table's primary key; parity
is **two independent comparisons per table, both must pass**: (1) row count `sqlite_rows ==
pg_rows`, and (2) a **SHA-256 content checksum** over a canonical row encoding both engines compute
identically (ordered by PK; columns concatenated in declared order; `N` NULL sentinel; unit/record
separators; integer→decimal, `REAL`/`double precision`→`{:.6}`, `BLOB`→lowercase hex). The rule is
the shared `harness::encode_row`/`checksum_rows` (`spikes/2964-postgres-migration/src/harness.rs:169-197`),
already validated by the `content_checksum_match` check, so the spikes cannot drift.

| Store / table | Owning definition (`file:line`) | Parity leg |
|---|---|---|
| AppStore KV `settings` | `storage/mod.rs:11-13,17-32,34-53` | counts + checksum over `(key, value)` ordered by `key` |
| FeatureStore `feature_*` | `feature_store.rs:95-97,119-127,132-135,240-271` | aggregate over every table enumerated from `feature_data_tables`, in `(feature_id, table_name)` order |
| SpanStore `telemetry_spans` | `span_store.rs:46-48,52-60,63-98` | counts + checksum over the 16 columns ordered by `span_id`; `read_only_source: true` |
| RtdbStore canonical | `rtdb/store.rs:283-288,294-304,307-407` | counts + checksum per table ordered by `(session_id, correlation_id)` |
| FeatureDataStore | `feature_data/store.rs:46-48,52-61,64-85` | counts + checksum ordered by each table's PK |

`telemetry_logs` (`span_store.rs:101-120`) and `telemetry_metrics` (`:470-486`) participate in the
same rule; the follow-up spec enumerates the full physical table set (Q-12).

### 6.3 One-shot markers are DATA, carried verbatim (R-5d)

The cutover **copies marker values as opaque data** — re-deriving them would re-run the backfills
they gate, which is exactly the duplicate/race risk R-5 forbids:

| Marker | Definition (`file:line`) | Carry rule |
|---|---|---|
| `rtdb.backfill.completed` | `infrastructure/rtdb/backfill.rs:101` (set `:326`, read `:300,362`) | copied as a `settings` row, value unchanged |
| `rtdb.backfill.provider.completed.v2` | `rtdb/backfill.rs:113` (provider pass `:357-368`) | copied as a `settings` row, value unchanged |
| per-table `feature_data_tables.backfill_done` | `feature_data/store.rs:64-85` (DDL `:73-74`), set `:143-151`, driver `feature_data/backfill.rs:56-101` | copied with the row, value unchanged |

Why re-derivation is unsafe: dropping `rtdb.backfill.completed` would replay the entire
`telemetry_spans` corpus through the live classifier on the next startup; the recorded #2932
round-2 defect (`backfill.rs:43-60`) is precisely the case where a replay re-minted keys and
INSERTed parallel rows. The design carries the **whole `settings` table**, so legacy/ignored keys
are preserved too. The PoC asserts `one_shot_markers.carried_unchanged: true` with the two AppStore
marker values and the per-table `backfill_done` map read back from PG and compared byte-for-byte.

### 6.4 `telemetry_spans` stays strictly READ-ONLY

The migration preserves the read-only contract: the export leg opens the SQLite source read-only
(PoC never writes the source); the PG analogue of `PRAGMA query_only=ON` is
`START TRANSACTION READ ONLY` / a least-privilege role; `telemetry_spans` is copied **out** of
SQLite into PG and nothing writes back. `results/parity.json` marks the entry
`"read_only_source": true` (the only table carrying the flag).

### 6.5 Committed parity evidence + fail-closed

`cargo run --release --bin parity` → **8/8 tables matched, markers carried unchanged = true,
rollback demo ok = true** in 508 ms (`results/parity.json`):

| Table | sqlite_rows | pg_rows | count | checksum |
|---|---:|---:|:--:|:--:|
| `chat_rows` | 17 | 17 | ✅ | ✅ |
| `tool_use_rows` | 3 | 3 | ✅ | ✅ |
| `agent_session_rows` | 2 | 2 | ✅ | ✅ |
| `telemetry_spans` | 3 | 3 | ✅ | ✅ |
| `settings` | 4 | 4 | ✅ | ✅ |
| `feature_data_tables` | 2 | 2 | ✅ | ✅ |
| `feature_data_tombstones` | 2 | 2 | ✅ | ✅ |
| `feature_*` (2 tables) | 5 | 5 | ✅ | ✅ |

A parity mismatch is a **hard stop**: step 7 does not flip the pool, the
`migration.postgres.completed` marker stays unset, and the next startup re-runs the idempotent,
read-only export. `parity.rs` exits non-zero when any table or marker fails.

**Chosen approach:** staged one-shot export/import, fail-closed toward SQLite, markers carried as
data. **No blocker.**

---

## 7. Scope area (d) — Startup / lifecycle

**Full design:** [`startup-lifecycle.md`](2964-postgres-migration-approach/startup-lifecycle.md) (ST-5).
Summary:

**Chosen approach:** a dedicated lifecycle supervisor that **reuses the managed-child mechanism
already shipped for `llama-server`** — PID marker in the AppStore KV, startup orphan sweep,
`taskkill /T /F` tree kill, `RunEvent::Exit` hook — plus a bounded embedded-PostgreSQL control
wrapper (`pg.stop()` under a hard timeout → hard-kill fallback). This directly owns the single
strongest objection to the migration: the #2948 **~11 h `pg.stop()` hang**.

**Bounded lifecycle (C4; bounds at `spikes/2964-postgres-migration/src/harness.rs:28-38`):**

| Wait | Bound | Measured (PoC) |
|---|---:|---:|
| every `pg_ctl` control command | 180 s | — |
| `pg.setup()` (download/extract + initdb) | 600 s | 25,567 ms (first run) |
| `pg.start()` | 180 s | **985 ms** |
| readiness poll | 60 s | **128 ms** |
| `pg.stop()` graceful | 30 s | **398 ms** |
| `taskkill /PID <pid> /T /F` fallback | — | **213 ms** |
| TCP connect | 10 s | — |
| whole supervisor PoC run | finite | **76,078 ms** |

**Guaranteed teardown — three layers:**

1. **Exit hook** — `RunEvent::Exit` closure calls the bounded stop. The production target is
   `apps/tauri/src-tauri/src/lib.rs:664-671`, the existing `stop_llama_server_on_exit` hook
   (`features/llm_server/commands.rs:846-848`). The PoC models it with `PidReaper`.
2. **RAII `Drop`** — error / early return / **panic unwind** reads `postmaster.pid` and hard-kills
   the tree. PoC `panic_path_teardown`: induced panic caught, postmaster PID 16644 gone.
   *Caveat:* requires unwinding — if the release profile sets `panic = "abort"`, layer 3 is the sole
   recovery (Q-19).
3. **Startup orphan sweep** — marker read → **PID-reuse guard** (`is_postgres_image`: kill only when
   the live image is `postgres.exe`) → tree kill → clear marker. PoC `startup_orphan_sweep`: a
   genuine leaked orphan (PID 21164) reclaimed by a fresh `--sweep-startup` process. A data-dir
   `postmaster.pid` backstop covers the window between spawn and marker write.

**No unbounded wait exists anywhere**: every await passes through `run_bounded`, pinned by a unit
test that an unbounded future errors in < 5 s under a 50 ms bound. The PoC run left **no orphan
`postgres.exe`** from the PIDs it started (`started pids [9360, 15384, 16644, 21164]; still-live []`).

**Reuse-or-justify audit** (`startup-lifecycle.md` §9) covers marker/sweep/tree-kill reuse from
`features/llm_server/process.rs:92-197` and one justified divergence: `postgresql_embedded` owns the
`pg_ctl`/postmaster spawn, so `CREATE_NO_WINDOW` / stdout-stderr redirection
(`process.rs:240-246,224-238`) cannot be applied from our code — Q-17.

**Bind:** ephemeral loopback (`settings.port = 0`, `harness.rs:228`); no fixed-port collision with
the OTLP receivers (4317/4318) or the MCP bridge (9223).

**Chosen approach + named open items:** supervisor design is settled; the crate-spawn console/log
gap and the single-instance question are named open items (Q-16–Q-21). The ~11 h hang is positioned
**MITIGATE + ACCEPT (residual)** in §10.

---

## 8. Scope area (e) — Packaging / install

**Full design:** [`packaging-install.md`](2964-postgres-migration-approach/packaging-install.md) (ST-6).
Summary:

`postgresql_embedded` 0.21 acquires the PostgreSQL distribution in one of two ways, chosen at
**build** time:

| Mode | Activation | First-run network? | Installer cost |
|---|---|---|---|
| **`runtime-download`** (crate default) | `postgresql_embedded = "0.21"` | **Yes** — 164,026,008 B fetched on first run | ~0 B; payload extracted into `<app_data_dir>` |
| **`bundled`** (compile-time-embedded) | `features = ["bundled"]` | **No** | **+54,048,768 B (~51.5 MiB)** in the binary/installer |

**Measured (`bundled`, Windows x86_64, release — the #2948 gap closed):** same binary, feature
flipped: `5,396,992 B → 59,445,760 B` → **Δ +54,048,768 B**; the embedded archive is
`OUT_DIR/postgresql.tar.gz` = 54,068,902 B and `out/postgresql.version` = `18.6.0` (the same
PostgreSQL 18.6.0 #2948 measured). The build script fetched the archive from
`theseus-rs/postgresql-binaries` at **build time** (cargo `--offline` does not govern this
`build.rs` fetch); incremental feature-flip rebuild 7.35 s, cold release build 1 m 23 s. `bundled`
**moves** the payload's acquisition point; it does not eliminate the 164,026,008 B extracted on
disk.

- **Current bundle config** declares no sidecar/resources: `apps/tauri/src-tauri/tauri.conf.json:53-54`
  (`"externalBin": []`, `"resources": {}`). Neither mode needs a `tauri.conf.json` change; `bundled`
  needs a `Cargo.toml` feature (production change, follow-up spec).
- **Integrity:** the shipped Companion acquisition is the precedent — `download_model`
  (`features/setup/commands.rs:1024-1041`) → streamed engine with streaming SHA-256 + `Range` resume
  + digest pins (`features/setup/model_download.rs:6-17,281-388`,
  `infrastructure/companion/models.rs:59-74,122-162`). The `bundled` crate feature's build-time
  fetch is **outside Fredo's SHA-pinned integrity surface** (supply-chain concern), documented as
  such.

**Position (R-4b):** **if offline-first is a hard product constraint, `bundled` is correct;
otherwise `runtime-download` is cheaper and already de-risked by #2948.** The cost side is measured
(above); the final policy choice is a **named open question** — the inherited backlog question
**(a) "is offline-first a hard constraint?"**, a human product input this spike cannot decide
(§12 Q-1). The requirement is satisfied with both a stated position (per branch) and the named open
input + resolving evidence.

---

## 9. Scope area (f) — Rollback / reversibility

**Full design:** [`data-migration.md`](2964-postgres-migration-approach/data-migration.md) §6.
Summary:

**`fredo.db` is never mutated or deleted by the migration.** A pre-cutover `VACUUM INTO` snapshot is
taken before any export (`<app_data_dir>/migration/fredo.pre-cutover.db`); the source file is
retained for the life of the release. **Backout**:

```text
1. stop the app (bounded PG stop — §7)
2. leave the PostgreSQL data dir in place (a later cutover may want it)
3. ensure <app_data_dir>/fredo.db is the pre-cutover copy:
     - a failed cutover never touched it  -> nothing to do
     - a flipped cutover that must revert -> copy fredo.pre-cutover.db over fredo.db
4. start the SQLite build; it opens fredo.db exactly as before
```

This makes the backout **executable** (fredo.db exists and is byte-identical to the pre-cutover
source), not "restore a backup we never took". Snapshot consistency under WAL: the copy is taken
while the app is quiesced, after a `PRAGMA wal_checkpoint(TRUNCATE)`; the PoC uses `VACUUM INTO` to
produce an unambiguous self-contained snapshot.

**Parity verification that proves a cutover preserved data:** compute the per-table counts +
SHA-256 checksums on the snapshot (pre), on PostgreSQL (post), require a match (fail-closed), then
**re-open the snapshot and recompute** the same counts/checksums and require equality with the
pre-cutover values — proving the snapshot is a faithful, restorable SQLite state. The PoC records
`rollback.fixture_demonstration: { backout_executed: true, restored_checksums_match: true }`;
`rollback.verified` is **`false`** because no *production* cutover has happened, and becomes `true`
only after a real cutover is parity-checked and a real backout is exercised (follow-up spec).

**Chosen approach:** SQLite backout via a never-mutated `fredo.db` + a pre-cutover snapshot, proven
by the parity check. **No blocker.**

---

## 10. Regression → position table (AC2)

Every #2948 measured regression carries an explicit position with a one-line rationale; numbers
reconcile with
[`spikes/2948-embedded-postgres/results/measurements.json`](../../spikes/2948-embedded-postgres/results/measurements.json)
(reference: `docs/research/2948-embedded-postgres-spike.md`). Extra granularity is included
(ST-1/ST-3/ST-6 measured findings) where it sharpens a position.

| # | #2948 regression (measured) | Position | Rationale |
|---|---|---|---|
| 1 | **Cold start +9,724.8 ms (~260×)** — 36.2/38.4 ms → 9,760.9/9,482.9 ms | **MITIGATE + RE-MEASURE** | Lazy/background postmaster start: the UI shell renders while PG boots; only store-dependent reads block. Residual first-real-query block remains — re-measure under lazy start. |
| 2 | **Peak RSS 8.2× (+243,965,952 B = +232.7 MiB)** — 33,734,656 B → 277,700,608 B | **MITIGATE + RE-MEASURE** | Tune `shared_buffers`/`work_mem`/`max_connections` for a single-client desktop profile (#2948 used untuned defaults); re-measure tuned. |
| 3a | **Install +164,026,008 B (~156.4 MiB)** — 0 B (in-binary SQLite) → 164,026,008 B distribution | **RE-MEASURE (measured, still open on mode)** | #2948 measured `runtime-download` only; ST-6 now **measured** `bundled` at **+54,048,768 B (~51.5 MiB)** installer growth (the extracted 164,026,008 B payload is the same either way). Final mode gated on offline-first hardness (Q-1). |
| 3b | **Data dir +60,565,072 B (+57.8 MiB)** — 7,225,344 B → 67,790,416 B | **MITIGATE + RE-MEASURE** | Autovacuum/WAL sizing + the existing retention prunes (`rtdb/store.rs:739-846`, `span_store.rs:228-285`) re-expressed on PG; re-measure at steady state. |
| 4 | **Batch upsert ~5.4× slower** — SQLite 197.6–208.2 ms → PG 1,073.2–1,139.3 ms (10 000 ops) | **MITIGATE + RE-MEASURE** | ST-1's translated statements with one transaction per 512 rows measured **~833 ms** for 10 000 ops (`results/bench.json`) vs #2948's 1,073.2–1,139.3 ms; persistent connection + prepared statements + COPY/multi-row batching remain. #2948's per-statement number is a floor, not a verdict. |
| 5 | **Point read ~12–15× slower** — SQLite 5.1–5.6 ms → PG 68.4–77.3 ms (1 000 by PK) | **MITIGATE + RE-MEASURE** | Gap is dominated by per-query TCP round-trips through the client/server boundary; a shared pool + prepared statements amortize it. ST-1's translated read preserved the result shape exactly (0 mismatches) but measured ~179 ms/1 000 (`results/bench.json`) — the residual is accepted per the re-measure; no false win claimed. |
| 6 | **Range read ~1.2–1.6× faster** — SQLite 5.0–6.7 ms → PG 4.2–4.3 ms (by `started_at_ns`) | **ACCEPT** | The only measured win; no mitigation required. ST-1's translated range read measured ~2.8 ms (`results/bench.json`). |
| 7 | **`pg.stop()` ~11 h teardown hang** (observed with `settings.timeout = None`) | **MITIGATE + ACCEPT (residual)** | Bounded stop (`Settings::timeout` + `tokio::time::timeout(30 s)` + a synchronous watchdog) → `taskkill /PID <pid> /T /F` fallback → three teardown layers + PID-reuse-guarded startup orphan sweep. ST-5's PoC shows stop 398 ms / hard-kill 213 ms / no orphan. Residual accepted: a hard-kill (Task Manager / power loss) can still orphan a postmaster — the sweep reclaims it, it does not eliminate it. |

**Coverage:** all six named #2948 categories (cold start, peak RSS, install **and** data dir, batch
upsert, point read, range read) + the `pg.stop()` teardown hang are positioned. **No category is
left unaddressed.** Owner of every MITIGATE/RE-MEASURE: the follow-up implementation spec.

---

## 11. Time-box and Windows-first constraints

- **Time-box: 3 working days.** The approach was produced within the box; unresolved items are
  recorded as named open questions (§12), not as more time. No overrun is claimed or needed.
- **Windows-first.** Every PoC leg ran on **win32/x86_64**, release, with `postgresql_embedded`
  0.21 / PostgreSQL 18.6.0. The lifecycle design names the Windows specifics explicitly:
  `postgres.exe` as the managed image, `pg_ctl` control, `postmaster.pid` in the data dir,
  `taskkill /PID <pid> /T /F` tree kill, and `tasklist`-based image inspection.
  **macOS/Linux are unverified caveats** inherited from #2948 (Q5) and carried forward.
- **PG build EOL/security posture (F-11):** the PostgreSQL License is permissive (no blocker), but
  the vendored 18.6.0 build's patch/EOL posture and the `postgresql_embedded` crate's
  maintenance/advisory history are **`Unknown`** (#2948 Q9). A version bump means a **rebuild** for
  `bundled` or a **first-run re-download** for `runtime-download`. Recorded as open question Q-3.

---

## 12. Open questions for the follow-up implementation spec (AC4)

Each entry states **why it blocks implementation** and **what evidence resolves it**. The
acquisition-mode question is called out first.

### Q-1 — `runtime-download` vs `bundled` (acquisition mode) — **position taken, final choice a named open question**

- **Question:** is **offline-first a hard product constraint** ("no network ever, including first
  run")?
- **Why it blocks:** it decides the shipped installer size (+54,048,768 B / ~51.5 MiB for `bundled`)
  and whether a one-time **build-time** network fetch is introduced; the follow-up spec cannot add
  the `bundled` feature to `apps/tauri/src-tauri/Cargo.toml` without this answer.
- **Position:** `bundled` if offline-first is hard; otherwise `runtime-download` (already de-risked
  by #2948, no installer growth, one documented first-run download of 164,026,008 B).
- **Is this input resolvable?** **It is a named open question, not resolvable within this spike** —
  it is inherited backlog question **(a)**, a **human product decision** (`docs/research/2948-embedded-postgres-spike.md:105-108`).
- **Resolving evidence:** a PO/human answer to question (a). If "hard" → adopt `bundled`; if
  "soft"/not a constraint → keep `runtime-download`.

### Q-2 — Production secret storage for the PG role

- **Why it blocks:** the crate needs a password (`settings.password`), and production credential
  storage (OS keyring / DPAPI vs the AppStore KV), plus a least-privilege role, is undesigned;
  storing it in plaintext `settings` is a security regression.
- **Resolving evidence:** a credential-storage decision + a role-creation/least-privilege design
  (the #2948 PoC used a throwaway `spike`/`spike` credential; `QUESTIONS.md:124-126`).

### Q-3 — PG build EOL/security posture + crate health

- **Why it blocks:** a long-lived dependency on a vendored PostgreSQL 18.6.0 build and
  `postgresql_embedded 0.21` whose patch/advisory history is `Unknown` (#2948 Q9,
  `QUESTIONS.md:131-139`); a version bump is a rebuild (`bundled`) or re-download
  (`runtime-download`).
- **Resolving evidence:** a registry/advisory review of the crate + a patch/vendoring policy before
  taking the dependency.

### Q-4 — `postgresql_embedded` username/superuser finding (ST-1)

- **Finding:** `settings.username` feeds the generated `url()` while `initdb` still creates the
  `postgres` superuser, so setting `username = "spike"` yields an authentication failure
  (`spikes/2964-postgres-migration/README.md:150-157`,
  `src/harness.rs:231-237`). The password does come from `settings.password`.
- **Why it blocks:** auth/role wiring blocks the pool and any least-privilege role (Q-2); the
  follow-up spec must configure the role explicitly, not via `settings.username`.
- **Resolving evidence:** crate API inspection + an explicit role-creation step.

### Q-5 — Client choice

- Reuse the existing `sqlx 0.8` (`apps/tauri/src-tauri/Cargo.toml:51`, currently observability-only)
  or pin a dedicated client (`tokio-postgres`/`deadpool`)? The signature change is the same either
  way; `sqlx` gives compile-time-checked queries. The scope guard forbids *reworking* the
  observability usage, not reusing the dependency. **Resolving evidence:** a recorded decision.

### Q-6 — Pool sizing / statement cache

- `max_connections` and statement-cache tuning for a single-client desktop profile — this is the
  knob the RSS + latency mitigations (§10 rows 2, 4, 5) depend on. **Resolving evidence:** a
  pool-tuned re-measurement of batch upsert / point read / RSS.

### Q-7 — Async propagation blast radius

- The exact non-store callers that must `.await` (`rtdb/ingest.rs`, `rtdb/commands.rs`,
  `rtdb/query/*`, `features/telemetry/*`); signatures only, no behavior change. **Resolving
  evidence:** a compiler-driven sweep in the implementation spec.

### Q-8 — Test strategy (no in-memory PG analogue)

- `Connection::open_in_memory` (`storage/mod.rs:61`, `feature_store.rs:714`, `span_store.rs:593`)
  has no direct PG analogue. Options: a per-test schema on a shared test server, testcontainers, or
  the embedded runtime. **Resolving evidence:** a decision + one green unit test.

### Q-9 — Dynamic identifier quoting

- `FeatureStore`/declared-table DDL builds identifiers from validated, sanitized names
  (`feature_store.rs:132-154`); confirm double-quoting is applied for PG (names are lower
  snake_case, so no case-folding surprise today). **Resolving evidence:** the identifier-quoting
  rule stated and tested.

### Q-10 — Migration trigger point

- Where the one-shot leg runs in startup relative to the existing backfill spawns
  (`lib.rs:430-438` feature-data, `lib.rs:527-533` rtdb): after the PG schema exists and **before**
  the first store write is served. **Resolving evidence:** the final startup ordering + a
  second-startup skip test.

### Q-11 — Flip marker

- Name/semantics of `migration.postgres.completed` (a NEW key, deliberately distinct from the three
  existing one-shot markers). **Resolving evidence:** the marker naming + a test that a second
  startup skips the leg.

### Q-12 — Full physical table set

- Enumerate every physical table (including `telemetry_logs`/`telemetry_metrics` and terminal
  persistence tables) and run the identical parity rule over it. **Resolving evidence:** a
  generated table list + a parity run over it.

### Q-13 — Snapshot retention

- How many pre-cutover snapshots are kept, for how long, and when a failed cutover's snapshot is
  pruned. **Resolving evidence:** a retention decision (existing knobs: `rtdb.retention_days`,
  `contracts.retention_days`, `tracing.retention_days`).

### Q-14 — Downgrade policy

- What happens to post-cutover PG rows on a downgrade to a SQLite build (accepted loss vs a reverse
  incremental export). **Resolving evidence:** a product/release-policy decision (same class as Q-1).

### Q-15 — Large-DB batching

- The PoC copies a fixture in one transaction per table; a large real `fredo.db` should batch
  (e.g. 512-row COPY/`INSERT` chunks, mirroring `RTDB_MAX_EMISSION_BATCH`) with a bounded memory
  budget. **Resolving evidence:** an ST-3-style full-size copy measurement.

### Q-16 — Supervisor home and startup wiring

- Where the supervisor lives (a new `infrastructure/pg_supervisor` module or a feature) and who calls
  it at startup, with the sweep before the first store opens. **Resolving evidence:** a file-level
  wiring list against `lib.rs` setup.

### Q-17 — `CREATE_NO_WINDOW` / log redirection for the crate-spawned postmaster

- `postgresql_embedded` owns the spawn, so `CREATE_NO_WINDOW`
  (`features/llm_server/process.rs:240-246`) and stdout/stderr redirection (`:224-238`) cannot be
  applied from our code — risking a console flash and no server log for the R-4 actionable-tail UX.
  **Resolving evidence:** crate API (creation flags / `Settings` log options) or a wrapper.

### Q-18 — Exit-hook ordering

- PG stop must run in the same `RunEvent::Exit` closure (`lib.rs:664-671`) *after* dependent stores
  stop writing, and must be time-bounded so quit never blocks. **Resolving evidence:** the insert
  point + a bounded-stop test.

### Q-19 — Panic strategy

- Confirm the release profile unwinds (teardown layer 2 stays live); if `panic = "abort"`, the
  startup sweep (layer 3) is the only recovery. **Resolving evidence:** `Cargo.toml` profile check.

### Q-20 — Single-instance / concurrent launches

- Two Fredo instances must not manage the same data dir (a second postmaster on one data dir is
  corruption); a second launch must attach or refuse. **Resolving evidence:** existing
  single-instance behavior + a data-dir advisory lock.

### Q-21 — Data-dir wipe vs marker

- A wipe removes `postmaster.pid` but not the KV marker; the sweep must tolerate a marker whose PID
  is gone (the safe no-kill path already demonstrated). **Resolving evidence:** the no-kill path
  (already exercised by the PoC).

### Q-22 — Packaging integrity

- Route the PostgreSQL archive through (or verify it against) Fredo's SHA-256-pinned engine
  (`features/setup/model_download.rs`) rather than trusting the crate's unverified fetch; for
  `bundled`, the build-time fetch is outside Fredo's integrity surface. **Resolving evidence:** an
  integrity decision + implementation.
- **Inherited open inputs:** (b) is there an **installer-size ceiling** for the footprint?
  (c) is `sqlx`/Postgres **consolidation** in or out of the migration's scope? (d) SQLite-only as a
  hard requirement is **resolved: not a hard requirement**. (b) and (c) need PO answers.

---

## 13. Explicit non-goal

**Re-litigating whether to migrate is out of scope.** The migration is **mandated**; #2948's NO-GO
framing is superseded (`docs/research/2948-embedded-postgres-spike.md`). A finding that a chosen
*approach or acquisition mode* is unviable must come with an alternative **embedded-PostgreSQL**
approach, never a return to the migrate-or-not question. (This non-goal is a section of its own and
is **not** one of the six AC1 scope areas.)

---

## 14. AC / requirement mapping

| Requirement | Where satisfied |
|---|---|
| **AC1 / R-1(a)** schema mapping | §4 (all stores, types/PKs/indexes, behavior re-expression) + `results/schema-translation.json` |
| **AC1 / R-1(b)** store/module migration path | §5 + [`store-migration.md`](2964-postgres-migration-approach/store-migration.md) + `results/write-behind.json` |
| **AC1 / R-1(c)** `fredo.db` data migration/backfill | §6 + [`data-migration.md`](2964-postgres-migration-approach/data-migration.md) + `results/parity.json` |
| **AC1 / R-1(d)** startup/lifecycle | §7 + [`startup-lifecycle.md`](2964-postgres-migration-approach/startup-lifecycle.md) + `results/lifecycle.json` |
| **AC1 / R-1(e)** packaging/install | §8 + [`packaging-install.md`](2964-postgres-migration-approach/packaging-install.md) |
| **AC1 / R-1(f)** rollback/reversibility | §9 + `results/parity.json` (`rollback.*`) |
| **AC2 / R-2** regression → position table | §10 (all six categories + the `pg.stop()` hang) |
| **AC3 / R-4, R-4a** PoC or written design + why | §3 (both produced, with why) + `results/*.json` |
| **AC4 / R-4b** open questions + acquisition position | §12 (Q-1 … Q-22) |
| **AC5 / R-5, R-5a, R-5b, R-5c, R-5d** data preserved + parity + rollback + markers | §6, §9 + `results/parity.json` |

---

## 15. Scope / verification

- **No production file changed.** The changed set on `spec/2964` is exactly
  `docs/research/2964-postgres-migration-approach*` + `spikes/2964-postgres-migration/**`; nothing
  under `apps/**`. The PoC is a standalone package (not a workspace member), never referenced by
  `lib.rs`/`AppRuntime`, with no dependency added to `apps/tauri/src-tauri/Cargo.toml`. `Cargo.toml`
  was pre-declared by ST-1 with a `[[bin]]` per artifact.
- **PoC reproducibility / boundedness.** Every binary is runnable with a finite outer timeout;
  every internal wait is bounded (C4), teardown is guaranteed on normal/timeout/panic paths, and the
  supervisor PoC left no orphan `postgres.exe` from the PIDs it started.
- **Evidence hygiene.** Every quoted prior-spike number resolves to
  `spikes/2948-embedded-postgres/results/measurements.json` or a committed
  `spikes/2964-postgres-migration/results/*.json`; no evidence lives only in `.opencode/tmp/`.
- **Citations.** Every `file:line` in this document and the section files resolves on `main`.

*Authored by Developer (ST-7 assembly), issue #2964 — assembly + consolidation of the master
migration-approach document; no production file changed by this deliverable.*
