# Store / Module Migration Path — embedded SQLite (`fredo.db`) → embedded PostgreSQL

> **Task:** ST-2 (2 pts) — file-level design for `infrastructure/storage/*`,
> `infrastructure/rtdb/store.rs` (incl. the ~30 ms write-behind queue + LRU
> semantics), `infrastructure/feature_data/*`, and their SQL call sites.
>
> **Issue:** #2964 (spike, mandated migration — the question is HOW, not whether).
> **Satisfies:** R-1(b).
> **Method:** written file-level design. **No production file is edited by this
> deliverable** — every path below names what WOULD change. The optional PoC
> (ST-1/ST-3) lives under `spikes/2964-postgres-migration/` and is out of scope
> here.
>
> **Citation contract:** every `file:line` below resolves on `main`; ranges were
> read from the checked-out sources. Where a range is a struct/impl block rather
> than a single statement, the range is the enclosing definition.

---

## 0. Scope, non-goals, and the invariant this design must not break

**In scope:** replacing the five independent `Mutex<Connection>` SQLite handles
(plus the three auxiliary read-only connections) with **ONE shared PostgreSQL
connection pool**; re-expressing every SQLite-specific behavior the stores rely
on; listing every SQL call site that must change and exactly how.

**Non-goals (explicit):**
- **No production edits.** This is a design document.
- **Do not redesign the RTDB wire contract.** `RowDeliveryBatch` on the
  `"fredo-stream-event"` IPC channel and the `useEventRows(eventType, args,
  options)` consumer contract are untouched. The storage swap happens *below*
  `RtdbStore`; nothing above `RtdbCache` sees a different envelope.
- **Do not fork `rtdb/attrs.rs`.** The NFR-6 single extraction path is a hard
  invariant (see §7).

**The migration is internal to the storage layer.** The stores' public method
signatures change (sync `rusqlite` → async `sqlx`), but the domain types they
read/write (`ChatRow`, `ToolUseRow`, `AgentSessionRow`, `TelemetrySpan`,
`TableMeta`, `Tombstone`, `ColumnDef`) are unchanged.

---

## 1. Connection inventory — every store that opens `fredo.db` itself

All five primary stores open the *same* file `<app_data_dir>/fredo.db` and each
holds its own `Mutex<Connection>`. Three additional read-only connections open
the same file directly. This is a per-connection SQLite assumption that the
migration replaces with one shared pool.

| # | Owner (module) | Open site (`file:line`) | Tables owned | Current connection |
|---|---|---|---|---|
| 1 | `AppStore` | `infrastructure/storage/mod.rs:11-32` | `settings` KV (`key TEXT PK, value TEXT NOT NULL`) | `Mutex<Connection>` (`:12`) |
| 2 | `FeatureStore` | `infrastructure/storage/feature_store.rs:95-127` (struct `:95-97`, `open` `:119-127`), `ensure_table` `:240-271` | dynamic `feature_{featureId}_{tableName}` + reserved `_row_version` / `_updated_at` | `Mutex<Connection>` (`:96`) |
| 3 | `SpanStore` | `infrastructure/storage/span_store.rs:46-98` (struct `:46-48`, `open` `:52-60`, schema `:63-98`) | `telemetry_spans`, `telemetry_logs`, `telemetry_metrics` | `Mutex<Connection>` (`:47`) |
| 4 | `RtdbStore` | `infrastructure/rtdb/store.rs:283-407` (struct `:283-288`, `open` `:294-304`, schema `:307-407`) | `chat_rows`, `tool_use_rows`, `agent_session_rows` | `Mutex<Connection>` (`:284`) + in-memory `seq_counters` (`:287`) |
| 5 | `FeatureDataStore` | `infrastructure/feature_data/store.rs:46-85` (struct `:46-48`, `open` `:52-61`, schema `:64-85`) | `feature_data_tables`, `feature_data_tombstones` | `Mutex<Connection>` (`:47`) |

**Auxiliary read-only connections to the same file (must also move to the pool):**

| # | Owner (module) | Open site (`file:line`) | Purpose |
|---|---|---|---|
| 6 | `ProjectionEngine` | `infrastructure/feature_data/projection.rs:178-212` (own conn `:198`, `PRAGMA journal_mode=WAL` `:199`, `PRAGMA query_only=ON` `:202`) | canonical reads for declared-table projection; writes go through `FeatureStore` (`tables` field `:181`) |
| 7 | declared-table backfill | `infrastructure/feature_data/backfill.rs:286-298` (`Connection::open` `:287`, `PRAGMA query_only=ON` `:288`) | distinct-session enumeration |
| 8 | canonical RTDB backfill | `infrastructure/rtdb/backfill.rs:213-292` (`SQLITE_OPEN_READ_ONLY` `:218`, `sqlite_master` probe `:221-225`); provider pass `:357-374` (`SQLITE_OPEN_READ_ONLY` `:367`, `sqlite_master` probe `:370-374`) | replay pre-cutover `telemetry_spans` (strictly read-only) |

**Design — the shared pool.** A single `sqlx::PgPool` is created once in
`lib.rs`'s `setup` closure (before any store is constructed) and cloned into
each store. `sqlx 0.8` is already a dependency at
`apps/tauri/src-tauri/Cargo.toml:51` (currently observability-only; the migration
spec decides whether to reuse it or pin a dedicated client — see §8 Q-ST2-1).

```text
// target shape (illustrative, not production code):
pub struct AppStore { pool: PgPool }          // no Mutex<Connection>
pub struct RtdbStore { pool: PgPool, seq_counters: Mutex<HashMap<...>> } // seq map stays in-memory
```

- `max_connections`: a small desktop profile (default 5–10) because the app is
  single-client; this is also the `shared_buffers`/`max_connections` tuning point
  the regression table flags under "peak RSS" (ST-7).
- `synchronous_commit = off` replaces `PRAGMA synchronous=NORMAL` (§3).
- The store constructors lose their `data_dir: PathBuf` argument (the pool is
  passed in); `std::fs::create_dir_all(&data_dir)` (`mod.rs:18`,
  `feature_store.rs:120`, `span_store.rs:53`, `feature_data/store.rs:53`,
  `projection.rs:197`) is deleted — PG owns its data dir (ST-5).
- Per-store **lock helpers** (`feature_store.rs:470-475`, `store.rs:866-878`) are
  deleted for the connection; `rtdb/store.rs`'s `seq_counters` lock
  (`store.rs:873-878`) is retained (in-memory map, not a DB connection).

**What must NOT change here:** the fact that exactly ONE connection pool
serializes writes is replaced by PG's own MVCC; no store gains a second pool. The
`telemetry_spans` table remains owned by `SpanStore` and is a read-only consumer
for the RTDB path (`rtdb/store.rs:6-7`).

---

## 2. Per-module design

### 2.1 `AppStore` — `infrastructure/storage/mod.rs`

**Changes:**
- `AppStore { conn: Mutex<Connection> }` (`:11-13`) → `AppStore { pool: PgPool }`.
- `open(data_dir)` (`:17-32`) → `open(pool)`; the `CREATE TABLE IF NOT EXISTS
  settings` DDL (`:22-27`) is byte-compatible in PG (`key TEXT PRIMARY KEY,
  value TEXT NOT NULL`).
- `get` (`:34-43`): `SELECT value FROM settings WHERE key = ?1` (`:36`) → `$1`;
  `stmt.query(params![key])` → `sqlx::query_scalar::<_, String>(...)`.
- `set` (`:45-53`): `ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  (`:48-50`) → `... SET value = EXCLUDED.value`.
- Tests (`:56-98`, `Connection::open_in_memory` `:61`) need a PG-test strategy
  (see §8 Q-ST2-4).

**What must NOT change:** the KV semantics (upsert-on-conflict, `None` on
unknown key). `AppStore` is the config-first home of the one-shot markers and the
RTDB retention knobs, so its read path must remain a low-latency point lookup.

### 2.2 `FeatureStore` — `infrastructure/storage/feature_store.rs`

**Changes:**
- Struct/open (`:95-127`): drop `Mutex<Connection>`, drop `PRAGMA journal_mode=WAL`
  (`:123`).
- `ensure_table` (`:240-271`): the generated `CREATE TABLE IF NOT EXISTS {full}
  ({col_defs})` (`:262-266`) maps 1:1; `ColumnType::as_sql_type` (`:31-38`,
  `INTEGER`/`REAL`/`BLOB` → `BIGINT`/`DOUBLE PRECISION`/`BYTEA`) changes. The
  `validate_namespace` guard (`:142-154`) stays the **only** source of a dynamic
  identifier; PG identifiers are additionally double-quoted (the names are
  already snake_case lower, so this is belt-and-suspenders).
- `insert` (`:274-319`): `INSERT OR IGNORE INTO ... VALUES (?)` (`:294-299`) →
  `INSERT ... ON CONFLICT DO NOTHING`; anonymous `?` placeholders (`:292`) →
  `$1..$n`.
- `upsert` (`:328-402`): `?{i}` placeholders (`:354`) → `${i}`; the
  `ON CONFLICT({pk}) DO UPDATE SET c = excluded.c` builder (`:364-381`) →
  `EXCLUDED.c` (PG folds unquoted `excluded` to lower-case, but the design uses
  the canonical `EXCLUDED` spelling).
- `execute_batch` (`:408-412`): PG accepts multi-statement simple-query batches,
  but DDL from `feature_data` may need `sqlx::raw_sql` (see §4).
- `table_exists` (`:415-425`): `sqlite_master` (`:419`) →
  `to_regclass($1) IS NOT NULL` / `information_schema.tables`.
- `table_schema` (`:430-447`): `pragma_table_info(?1)` (`:432`) →
  `information_schema.columns` joined to `pg_index`/`pg_attribute` for
  `notnull`/`pk`. `PhysicalColumn` (`:108-115`) and `normalize_column_type`
  (`:162-169`) are unchanged — the normalization rule is the single shared rule.
- `query`/`update`/`delete` (`:478-627`): `?{i}` → `${i}`; the JSON→SQL value
  bridge `json_to_sql` / `sql_to_json` (`:192-237`) switches its middle type from
  `rusqlite::types::Value` to a PG-native enum (`Text`/`Int8`/`Float8`/`Bytea`).
- `lock_conn` (`:470-475`) deleted.

**What must NOT change:** the namespace isolation rule (`:132-154`), the
idempotent `INSERT OR IGNORE` trade (duplicate PK silently ignored), the
`ON CONFLICT DO UPDATE` upsert for the projection path, and the BLOB round-trip
(`TEXT`-encoded JSON arrays → `BYTEA`). The `_row_version`/`_updated_at` reserved
columns are owned by `feature_data/registry.rs` and are untouched here.

### 2.3 `SpanStore` — `infrastructure/storage/span_store.rs`

**Changes:**
- Struct/open (`:46-60`): drop `Mutex<Connection>`, drop WAL (`:56`).
- `ensure_schema` (`:63-98`): DDL translation; the partial index
  `idx_telemetry_spans_error ... WHERE status_code = 'ERROR'` (`:92-93`) maps 1:1
  to a PG partial index.
- `ensure_logs_schema_with_conn` (`:101-120`): `id INTEGER PRIMARY KEY
  AUTOINCREMENT` (`:104`) → `id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY`.
- `ensure_metrics_schema` (`:470-486`): same AUTOINCREMENT mapping (`:474`).
- `insert_spans` (`:130-171`): `INSERT OR IGNORE` (`:141-146`) →
  `ON CONFLICT(span_id) DO NOTHING`; `?n` (`:146`) → `$n`.
- `insert_raw_spans` (`:181-222`): `INSERT OR IGNORE` (`:192-197`) → same;
  `?n` (`:197`) → `$n`.
- `delete_expired` (`:228-285`): the batched `DELETE ... WHERE ... IN (SELECT ...
  LIMIT 1000)` (`:237-240`, `:254-257`, `:270-273`) translates, but
  `PRAGMA incremental_vacuum` (`:249`, `:265`, `:281`) is **dropped** — PG
  autovacuum replaces per-batch vacuum.
- `delete_logs_expired` (`:427-449`, vacuum `:445`), `delete_metrics_expired`
  (`:548-570`, vacuum `:566`): same.
- The explicit `BEGIN TRANSACTION`/`COMMIT` string batching
  (`:138`/`:168`, `:189`/`:219`, `:497`/`:519`) becomes a `sqlx::Transaction`
  obtained from the pool.

**What must NOT change:** OTLP raw-span idempotency (duplicate `span_id` ignored),
retention batching, and `telemetry_spans`'s status as the canonical pre-cutover
history source for the RTDB backfill.

### 2.4 `RtdbStore` — `infrastructure/rtdb/store.rs`

**Changes (storage leg only):**
- Struct/open (`:283-304`): `conn: Mutex<Connection>` (`:284`) → `pool: PgPool`;
  drop WAL (`:298`) and `synchronous=NORMAL` (`:299`).
- `ensure_schema` (`:307-407`): DDL for the three `*_rows` tables (`:310-385`);
  indexes map 1:1. The guarded-ALTER provider migration (`:395-405`) uses
  `column_exists` (`:121-128`, `pragma_table_info` `:123`) →
  `information_schema.columns`.
- Upserts (`upsert_chat_rows` `:414-465`, `upsert_tool_use_rows` `:468-516`,
  `upsert_agent_session_rows` `:519-560`): `INSERT OR REPLACE` (`:424-429`,
  `:478-482`, `:529-533`) → `INSERT ... ON CONFLICT(session_id, correlation_id)
  DO UPDATE SET <every non-PK col> = EXCLUDED.<col>` (full-row semantics — the PK
  IS the entire identity, so a full `DO UPDATE` reproduces `OR REPLACE`); `?n` →
  `$n`; `BEGIN`/`COMMIT`/`ROLLBACK` (`:419`/`:457`/`:461`) → `sqlx::Transaction`.
- `max_seq` (`:718-729`): `?1`/`?2` → `$1`/`$2`; `COALESCE(MAX(seq), 0)`
  unchanged — the durable-seq seed semantics (no reset across restart, gaps OK)
  are preserved by the same query shape.
- `prune` (`:739-846`): `DELETE ... RETURNING session_id, correlation_id`
  (`:749-756`, `:809-835`) is natively supported by PG; the temp-table
  `prune_batch` batching (`:790-836`) translates (`CREATE TEMP TABLE ... ON
  COMMIT DROP`, `UNION ALL ... ORDER BY updated_at ASC, seq ASC LIMIT $1`); the
  row-value predicate `(session_id, correlation_id) IN (SELECT ...)` is valid PG.
  `PRAGMA incremental_vacuum` (`:765`, `:842`) is **dropped**.
- `delete_returning` (`:182-201`): already a manual row-stepping loop; it maps
  onto `sqlx::query(...).fetch(...)` — no behavioral change.

**What must NOT change:** the full-row write (no partial patch at this layer —
patching happens above), the composite `(session_id, correlation_id)` identity,
the 1000-row `PRUNE_BATCH` (`:63`), and the `PruneOutcome.evicted` contract that
feeds `kind: remove` deliveries (the ONLY remove producer).

### 2.5 `FeatureDataStore` — `infrastructure/feature_data/store.rs`

**Changes:**
- Struct/open (`:46-61`): drop `Mutex<Connection>`, drop WAL (`:56`) and
  `synchronous=NORMAL` (`:57`).
- `ensure_schema` (`:64-85`): both tables + composite PKs map 1:1.
- `put_table` (`:118-140`): `ON CONFLICT(feature_id, table_name) DO UPDATE SET
  ... = excluded.` (`:125-129`) → `EXCLUDED.`; `?n` → `$n`.
- `put_tombstone` (`:165-181`): `ON CONFLICT(feature_id, table_name, key_json)
  DO UPDATE SET deleted_at = excluded.deleted_at` (`:171-173`) → `EXCLUDED.`.
- `get_table`/`list_tables`/`set_backfill_done`/`set_last_version`/
  `is_tombstoned` (`:88-115`, `:143-162`, `:184-200`): placeholder conversion
  only.
- `lock_conn` (`:226-230`) deleted.

**What must NOT change:** the `backfill_done` marker semantics (per-table,
carried verbatim by the data-migration leg — ST-4), and the composite-key upserts.

### 2.6 `ProjectionEngine` + declared-table backfill (read-only canonical reads)

- `ProjectionEngine::new` (`infrastructure/feature_data/projection.rs:190-212`)
  opens its OWN connection (`:198`) with WAL (`:199`) + `query_only=ON`
  (`:202`). In the target: a **read-only handle on the shared pool** (acquire a
  connection and `SET TRANSACTION READ ONLY`, or use a least-privilege read-only
  role — see §3). Its declared-table WRITES already go through `FeatureStore`
  (`tables` field `:181`), so the read-only canonical / write declared split is
  preserved exactly.
- `distinct_session_ids` (`feature_data/backfill.rs:286-298`): drop the
  `Connection::open` (`:287`) + `PRAGMA query_only=ON` (`:288`); use the read-only
  pool handle and `$`-less query (no params).

### 2.7 Canonical RTDB backfill (strictly read-only) — `infrastructure/rtdb/backfill.rs`

- `backfill_from_telemetry` (`:213-292`): the `SQLITE_OPEN_READ_ONLY` connection
  (`:217-219`) → a read-only pool handle/transaction; the `telemetry_spans`
  existence probe via `sqlite_master` (`:221-225`) → `to_regclass('telemetry_spans')`.
- `provider_rebackfill_pass` (`:357-…`): same read-only connection (`:366-368`)
  and probe (`:370-374`).
- The one-shot markers `BACKFILL_COMPLETED_KEY = "rtdb.backfill.completed"`
  (`:101`) and `BACKFILL_PROVIDER_COMPLETED_KEY =
  "rtdb.backfill.provider.completed.v2"` (`:113`) are stored in the `settings`
  table via `AppStore.set` (`:326`) and read via `AppStore.get` (`:300`, `:362`).
  **They are DATA** — the data-migration leg (ST-4) carries them verbatim so a
  cutover never re-derives/replays history.

**What must NOT change:** the strictly READ-ONLY `telemetry_spans` contract, the
NFR-6 shared resolver (`resolve_op_name`, `:167-176`; `attrs.rs`), and the
marker gating (a pass that read zero spans never latches).

---

## 3. SQLite-specific behaviors — every one, and its PG re-expression

| SQLite construct | Call sites (`file:line`) | PG re-expression | Preserve |
|---|---|---|---|
| `PRAGMA journal_mode=WAL` | `rtdb/store.rs:298`, `feature_store.rs:123`, `span_store.rs:56`, `feature_data/store.rs:56`, `projection.rs:199` | **drop** — PG WAL is always on | durability model unchanged at the contract level |
| `PRAGMA synchronous=NORMAL` | `rtdb/store.rs:299`, `feature_data/store.rs:57` | `synchronous_commit = off` (explicit server setting) | the deliberate perf/durability trade documented at `store.rs:291-293` |
| `INSERT OR REPLACE` (full-row upsert) | `rtdb/store.rs:424-429`, `:478-482`, `:529-533` | `INSERT ... ON CONFLICT(<pk>) DO UPDATE SET <all non-PK> = EXCLUDED.<c>` | full-row write keyed on composite PK |
| `INSERT OR IGNORE` | `feature_store.rs:295`, `span_store.rs:141-146`, `:192-197` | `INSERT ... ON CONFLICT DO NOTHING` | idempotent duplicate-PK ignore |
| `ON CONFLICT(k) DO UPDATE SET c=excluded.c` | `mod.rs:48-50`, `feature_store.rs:375-381`, `feature_data/store.rs:125-129`, `:171-173` | `... = EXCLUDED.c` | upsert semantics |
| `INTEGER PRIMARY KEY AUTOINCREMENT` | `span_store.rs:104` (`telemetry_logs.id`), `:474` (`telemetry_metrics.id`) | `BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY` | monotonic id, never reused |
| `PRAGMA incremental_vacuum` after delete batch | `store.rs:765`, `:842`; `span_store.rs:249`, `:265`, `:281`, `:445`, `:566` | **drop** — autovacuum (tuned) | one delete batch = one logical reclaim point |
| `PRAGMA query_only=ON` read-only guard | `feature_data/backfill.rs:288`, `projection.rs:202` | `SET TRANSACTION READ ONLY` / read-only role | canonical reads never write |
| Partial index `WHERE status_code='ERROR'` | `span_store.rs:92-93` | partial index `WHERE status_code = 'ERROR'` (1:1) | same plan shape |
| `pragma_table_info(t)` | `feature_store.rs:176`, `:432`; `rtdb/store.rs:123` | `information_schema.columns` (+ `pg_index`/`pg_attribute` for pk/notnull) | guarded-ALTER idempotency |
| `sqlite_master` existence check | `feature_store.rs:419`; `rtdb/backfill.rs:222`, `:371` | `to_regclass('t')` / `information_schema.tables` | table-present probes |
| `?n` positional placeholders | all of `mod.rs:36,48`; `feature_store.rs:176,354,432,497,560,567,609`; `span_store.rs:146,197,238,255,271,436,557`; `rtdb/store.rs:123,429,482,533,722`; `feature_data/store.rs:94,124,147,157,170,194,208`; `rtdb/backfill.rs:185,396` | `$n` | parameter binding order |
| `DELETE ... RETURNING` | `rtdb/store.rs:752-755`, `:811-835` | natively supported | evicted-key routing |
| `COALESCE(MAX(seq),0)` durable-seq seed | `rtdb/store.rs:722` | same SQL | seq never resets across restart |

**Statement-batching note.** `feature_store.rs:408-412` and
`feature_data/registry.rs` build DDL/DML batches as strings. In PG a multi-
statement string requires the simple-query protocol (`sqlx::raw_sql`); the design
routes those through `raw_sql` rather than the extended protocol.

---

## 4. SQL call-site migration — the mechanical conversion

1. **Placeholders:** every `?n` → `$n`; anonymous `?`
   (`feature_store.rs:292`) → `$1..$n`. A build-time helper is not required — the
   call sites are enumerated in §3 so the mechanical pass is complete.
2. **Binding:** `rusqlite::params![...]` → `sqlx::query(...).bind(...)` (typed).
   `rusqlite::types::Value` (used at `rtdb/cache.rs:344`) → a PG-native value
   enum; `BLOB` → `BYTEA`.
3. **Execution:** `conn.execute` / `conn.query_row` / `prepare`+`query_map` →
   `sqlx::query` / `query_scalar` / `query_as` with `.fetch_one`/`.fetch_optional`
   /`.fetch_all`.
4. **Transactions:** the `execute_batch("BEGIN TRANSACTION;")` / `COMMIT` /
   `ROLLBACK` idiom (`span_store.rs:138,168`; `rtdb/store.rs:419,457,461,473,508,512,524,556,560`)
   → `pool.begin()` → `tx.commit()` / drop-on-error.
5. **Sync → async fan-out (the real signature change).** `rusqlite` is
   synchronous; `sqlx` is async. Every `RtdbStore`/`AppStore`/`FeatureStore`/
   `SpanStore`/`FeatureDataStore` method that touches the pool becomes `async`.
   This propagates into:
   - `rtdb/cache.rs` `flush_pending` (`:376-398`) and the cache-miss `get_chat`/
     `get_tool_use`/`get_agent_session` (`:261-326`) → `.await`;
   - the writer task `run_writer_task` (`:449-485`) — already async, so it simply
     awaits `flush_pending`;
   - `read_knobs` (`:521-539`) which calls `AppStore::get` → async;
   - call sites in `rtdb/ingest.rs`, `rtdb/commands.rs`, `rtdb/query/*` that read
     canonical rows.
   **The in-memory cache update path (`upsert_chat`/`upsert_tool_use`/
   `upsert_agent_session`, `:204-255`) stays synchronous and non-blocking** — only
   the enqueue (`try_send`) and the later async flush move. This is what keeps
   "storage sheds, delivery never does" (R-2d).

---

## 5. RTDB write-behind + LRU semantics — MUST be preserved exactly

The perf-sensitive core. **No LRU/queue constant or code path changes**; only the
storage target behind `RtdbCache.store` changes.

- **Bounded LRU caches:** `DEFAULT_CACHE_CAPACITY = 10_000`
  (`rtdb/cache.rs:47`); three independent caches (`chats`/`tools`/`sessions`,
  `:159-161`), constructed at `:184-186`; overflow evicts the oldest ~10% in one
  pass (`evict_if_needed`, `:123-137`). **Unchanged.**
- **Bounded queue:** `QUEUE_CAPACITY = 4096` (`:49`); `tokio::sync::mpsc::channel`
  (`:180`); `try_send` never blocks (`:209`, `:227`, `:245`). **Unchanged.**
- **Overflow SHEDS the storage write, never in-memory state:** `dropped` counter
  (`:164`, `:210`), `dropped_count()` (`:400-403`). **Unchanged.**
- **Cache-miss reload from storage:** `get_chat`/`get_tool_use`/
  `get_agent_session` (`:261-326`) — the only changed part is that the reload call
  (`self.store.get_*_row(...)`) is now `.await`ed.
- **~30 ms coalescing:** `WRITER_FLUSH_MS = 30` (`:51`); `run_writer_task`
  (`:449-485`) waits up to the window then drains everything queued
  (`:456-463`). **Unchanged.**
- **One transaction per kind per batch:** `flush_pending` (`:376-398`) partitions
  and calls `upsert_chat_rows`/`upsert_tool_use_rows`/`upsert_agent_session_rows`
  (`:389,392,395`) — the store methods become async; the partition is unchanged.
- **Retention prune cadence:** `WRITER_PRUNE_INTERVAL = 60 min` (`:54`),
  `prune_with_knobs` (`:490-517`), knobs re-read fresh (`:521-539`). **Unchanged**
  apart from async `read_knobs`.
- **Per-session key union** (`keys_for_session_union` `:334-352`, used by the
  P3.1 re-key path): cached ∪ persisted; the persisted leg becomes async.
  **Semantics unchanged.**
- **Durable seq** (`store.rs:17-24`, `next_seq`/`max_seq` `:700-729`): the
  in-memory `seq_counters` map stays; only its seed read is async. Gaps remain
  acceptable; monotonicity is preserved.

**Not owned by `RtdbCache` and NOT changed:** the row-merge semantics (insert
spread-merge, seq-guarded stale-patch drop, remove-only-eviction) live in
`rtdb/project.rs` / `commands.rs` / the frontend `StreamContext.tsx`. The store
writes FULL rows and never merges — so the storage swap cannot alter merge
behavior.

---

## 6. `lib.rs` wiring changes (file-level)

All construction moves from file paths to the shared pool, in the same order:

| Store | Current construction | Target |
|---|---|---|
| `AppStore` | `lib.rs:116-119` | `AppStore::open(pool.clone())` |
| `FeatureStore` | `lib.rs:122-125` | `FeatureStore::open(pool.clone())` |
| `terminal` record table | `lib.rs:130-131` → `features::terminal::persistence::ensure_table` | unchanged (async `ensure_table`) |
| `SpanStore` + schemas | `lib.rs:184-192` | `SpanStore::open(pool.clone())`, async schema init |
| `RtdbStore` + schema | `lib.rs:323-330` | `RtdbStore::open(pool.clone())`, async schema init |
| `FeatureDataStore` + schema | `lib.rs:365-370` | `FeatureDataStore::open(pool.clone())` |
| `ProjectionEngine` | `lib.rs:390-397` | `ProjectionEngine::new(pool.clone(), meta, tables)` |
| writer spawn | `lib.rs:503-506` (`run_rtdb_writer_task`) | unchanged spawn; `run_writer_task` awaits flush |
| backfill spawns | `lib.rs:430-438` (feature_data), `lib.rs:527-533` (rtdb) | unchanged spans; read-only pool handle |

The single new artifact is the **pool creation** inserted before `AppStore`
(around `lib.rs:112-116`). The `tauri::async_runtime::spawn` discipline is
unchanged (`lib.rs:504`, `:527`). The app-exit supervision precedent remains
`lib.rs:664-671` (`RunEvent::Exit` → `stop_llama_server_on_exit`) — the PG
sidecar supervisor is ST-5's design, cross-referenced not duplicated here.

---

## 7. Regression invariants — what must NOT change

1. **Row-merge semantics.** Insert spread-merge (init-time fields survive),
   seq-guarded `update` stale-patch drop, `remove` only from retention eviction.
   These live above the store; the store must keep writing FULL rows and must
   never introduce a partial-update path — `INSERT ... ON CONFLICT DO UPDATE`
   covers all non-PK columns (§2.4).
2. **NFR-6 single extraction path.** `rtdb/attrs.rs` stays the ONE shared
   extract-rule implementation for the live classifier AND the canonical backfill.
   This design does not touch extraction; `rtdb/backfill.rs` continues to call
   the shared `resolve_op_name` (`rtdb/backfill.rs:167-176`) and never a fork.
3. **`telemetry_spans` strictly READ-ONLY for backfill.** The RTDB canonical
   backfill and provider re-derivation open read-only connections
   (`rtdb/backfill.rs:218`, `:367`); `telemetry_spans` is never written by the
   RTDB path (`rtdb/store.rs:6-7`). The migration preserves this with a read-only
   PG handle/role.
4. **RTDB row-pipeline wire contract.** `RowDeliveryBatch` on
   `"fredo-stream-event"` and `useEventRows(eventType, args, options)` are
   untouched. No envelope, field, or query-language change.
5. **One-shot markers are DATA, carried verbatim.** `rtdb.backfill.completed`
   (`rtdb/backfill.rs:101`), `rtdb.backfill.provider.completed.v2` (`:113`), and
   per-table `feature_data_tables.backfill_done` (`feature_data/store.rs:73`)
   must migrate unchanged so a cutover never re-derives/replays history.
6. **Durable seq / retention / `kind: remove` invariant.** `prune` stays the ONLY
   remove producer (`rtdb/store.rs:163-177`, `cache.rs:490-517`).

---

## 8. Open questions (hand-off to the follow-up implementation spec / ST-7)

- **Q-ST2-1 (client choice).** Reuse the existing `sqlx 0.8`
  (`Cargo.toml:51`, currently observability-only, explicitly out of scope to
  rework) or pin a dedicated client (e.g. `tokio-postgres`/`deadpool`)? The
  signature change (sync → async) is the same either way; `sqlx` gives
  compile-time-checked queries. *Resolving evidence:* a decision recorded in the
  master doc; the scope guard forbids "reworking" the observability usage, not
  reusing the dependency.
- **Q-ST2-2 (pool sizing).** `max_connections` / statement-cache tuning for a
  single-client desktop profile. *Resolving evidence:* ST-1/ST-3 measurements of
  batch-upsert and point-read latency against a tuned pool (the #2948 numbers are
  per-statement floors — `docs/research/2948-embedded-postgres-spike.md`).
- **Q-ST2-3 (async propagation blast radius).** The exact list of non-store
  callers that must `.await` (`rtdb/ingest.rs`, `rtdb/commands.rs`,
  `rtdb/query/*`, `features/telemetry/*`). *Resolving evidence:* a compiler-driven
  sweep in the implementation spec; no behavior change, only signatures.
- **Q-ST2-4 (test strategy).** `Connection::open_in_memory`
  (`mod.rs:61`, `feature_store.rs:714`, `span_store.rs:593`) has no direct PG
  analogue. Options: a per-test schema on a shared test server, testcontainers, or
  the embedded runtime. *Resolving evidence:* a decision + one green unit test in
  the implementation spec; flagged here because every store's test module uses the
  in-memory idiom.
- **Q-ST2-5 (dynamic identifier quoting).** `FeatureStore`/declared-table DDL
  builds identifiers from validated, sanitized names
  (`feature_store.rs:132-154`); confirm double-quoting is applied for PG (names
  are lower snake_case, so no case-folding surprise today). *Resolving evidence:*
  the identifier-quoting rule stated in the schema-mapping section (ST-1).

---

*Authored by Developer (ST-2), issue #2964 — file-level design only; no
production file changed by this deliverable.*
