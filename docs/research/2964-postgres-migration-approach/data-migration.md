# `fredo.db` Data Migration / Backfill + Parity Check + Rollback — SQLite → embedded PostgreSQL

> **Task:** ST-4 (3 pts) — design how existing `fredo.db` rows reach PostgreSQL
> without loss or duplicated one-shot work, and name the parity check and the
> backout.
>
> **Issue:** #2964 (spike; the migration is mandated — the question is HOW).
> **Satisfies:** R-1(c), R-1(f), R-5, R-5a, R-5b, R-5c.
> **Deliverables:** this design + the executed parity harness
> [`spikes/2964-postgres-migration/src/parity.rs`](../../../spikes/2964-postgres-migration/src/parity.rs)
> and its committed result
> [`spikes/2964-postgres-migration/results/parity.json`](../../../spikes/2964-postgres-migration/results/parity.json).
>
> **Method:** a file-level written design **plus** a disposable PoC that executes
> the carry + parity + rollback path against a real embedded PostgreSQL on a
> synthetic fixture. **No production file is edited by this deliverable** — every
> `file:line` below names what WOULD change. Every citation resolves on `main`;
> the harness never opens the real `fredo.db`.
>
> **Related sections:** [store-migration.md](store-migration.md) (ST-2 — the
> storage-layer swap this data leg sits under), [packaging-install.md](packaging-install.md)
> (ST-6); the master assembly is ST-7.

---

## 0. Scope, non-goals, and the invariant this design must not break

**In scope:** the one-shot **data** leg of the cutover — how each existing
`fredo.db` store is copied into PostgreSQL with no loss, how the one-shot
markers are carried so no backfill work is repeated, the per-store parity proof,
and the backout to SQLite.

**Non-goals (explicit):**
- **No production migration is performed.** The PoC migrates a synthetic fixture
  under `spikes/2964-postgres-migration/target/spike-tmp/` only.
- **`telemetry_spans` stays strictly read-only** to the RTDB/backfill path
  (`infrastructure/rtdb/backfill.rs:218,367`,
  `infrastructure/feature_data/backfill.rs:288`) — the migration preserves that
  read-only contract; it never rewrites history in place.
- **The one-shot markers are CARRIED, never re-derived.** Re-deriving
  `rtdb.backfill.completed` / `rtdb.backfill.provider.completed.v2` /
  `feature_data_tables.backfill_done` would replay already-classified spans and
  is a duplicate/race risk (§3).
- **No `apps/**` edit.** The storage-layer swap and the pool wiring are ST-2's
  design (`store-migration.md`); this task adds only a doc + `src/parity.rs`.

**The invariant:** the row-pipeline wire contract (`RowDeliveryBatch` on
`"fredo-stream-event"` / `useEventRows`) is untouched — the data leg happens
strictly below it.

---

## 1. What "carried without loss" means — and the cutover decision (R-5c)

**Decision: a staged one-shot export/import.** Not dual-write, not a
long-lived side-by-side reconciliation.

### 1.1 Why one-shot, not dual-write

Every `fredo.db` writer is **in-process and serialized**. Each store owns its own
`Mutex<Connection>` over the same file — `AppStore`
(`infrastructure/storage/mod.rs:11-13`), `FeatureStore`
(`infrastructure/storage/feature_store.rs:95-97`), `SpanStore`
(`infrastructure/storage/span_store.rs:46-48`), `RtdbStore`
(`infrastructure/rtdb/store.rs:283-288`), `FeatureDataStore`
(`infrastructure/feature_data/store.rs:46-48`) — and there is no second writer
process. So there is no concurrent external producer that a dual-write would
have to keep in sync; the app can **quiesce its writers** for the duration of a
one-shot copy.

Dual-write would cost:
- a fan-out on **every** store write (including the ~30 ms write-behind
  coalescing + LRU path in `rtdb/cache.rs`, preserved by ST-2 §5), doubling the
  failure surface (one engine commits, the other times out);
- a reconciliation/ordering story between two engines for the durable seq
  (`rtdb/store.rs:17-24`) and for retention prunes (`rtdb/store.rs:739-846`) —
  each prune would become a two-engine operation that can partially fail;
- a permanent "which engine is authoritative?" ambiguity on read.

The PoC's own shape confirms the one-shot plan is sufficient: a full fixture
copy + parity + rollback completes in **~0.5 s** for the fixture (see
`results/parity.json` → `duration_ms`), i.e. the copy is a bounded startup
operation, not an ongoing state machine.

### 1.2 The staged sequence

```text
startup (PG build)                         each step is a gate; failure => abort cutover, stay on SQLite
  1. PG up (ST-5 supervisor)               bounded start + readiness
  2. create PG schema (ST-1/ST-2 DDL)      idempotent; no writes to fredo.db
  3. pre-cutover snapshot of fredo.db      VACUUM INTO <data>/migration/fredo.pre-cutover.db   (§6)
  4. open fredo.db READ-ONLY for export    the whole export leg opens read-only                (§4)
  5. per-store one-shot export/import      every table in §2, in ONE transaction per store
  6. carry the one-shot markers verbatim   settings rows + feature_data_tables.backfill_done   (§3)
  7. parity check (counts + checksums)     fail-closed: mismatch => do NOT flip, keep SQLite   (§5)
  8. flip the pool to PG + latch a marker  `migration.postgres.completed` (new; not an existing marker)
  9. keep fredo.db untouched               it is the backout artifact for the life of the release (§6)
```

A failure in any of steps 1–7 leaves `fredo.db` exactly as it was and the app
starts on SQLite — the migration is **fail-closed toward the incumbent engine**.

### 1.3 Residual downside (named, not hidden)

The one and only asymmetries of one-shot vs dual-write:
- **Post-cutover writes live only in PG.** A downgrade to a SQLite build after
  step 8 started accepting writes loses those rows (SQLite never saw them).
  Mitigation: the release that first ships PG keeps the SQLite build's data
  readable (fredo.db is retained, never deleted), and the downgrade policy is a
  named open question (§8 Q-ST4-5). Dual-write would have avoided this at the
  cost of §1.1 — the design accepts the trade for a single-client desktop app.
- **The parity window is a snapshot.** Because writers are quiesced during
  steps 3–8, the comparison is stable; there is no post-snapshot drift to
  reconcile.

---

## 2. Per-store carry (R-5a)

Every store named by R-5 is carried by the same one-shot export/import, keyed on
each table's primary key. "Parity leg" is the column set included in the §5
count + checksum comparison.

| Store (owner) | Owning definition (`file:line`) | Table(s) | Carry | Parity leg |
|---|---|---|---|---|
| **AppStore KV** | `infrastructure/storage/mod.rs:11-13` (struct), `:17-32` (open + `settings` DDL), `:34-43` (get), `:45-53` (set) | `settings (key TEXT PK, value TEXT NOT NULL)` | row-by-row `key/value` copy; includes **all** marker rows (§3) | counts + checksum over `(key, value)` ordered by `key` |
| **FeatureStore** | `infrastructure/storage/feature_store.rs:95-97` (struct), `:119-127` (open), `:132-135` (`feature_{id}_{table}` naming), `:142-154` (namespace), `:240-271` (`ensure_table`), `:274-319` (`insert`), `:328-402` (`upsert`) | dynamic `feature_{featureId}_{tableName}` + reserved `_row_version` / `_updated_at` (`feature_data/declaration.rs:24`, `registry.rs:708-709`) | enumerate the declared tables from `feature_data_tables` and copy each physical table; DDL built from `pragma_table_info` with the C1 type map | aggregate counts + checksum over every enumerated table in `(feature_id, table_name)` order, plus a per-table breakdown |
| **SpanStore** | `infrastructure/storage/span_store.rs:46-48` (struct), `:52-60` (open), `:63-98` (`telemetry_spans` DDL) | `telemetry_spans (span_id TEXT PK)` | **READ-ONLY export** (§4); carries the raw span rows pre-cutover history depends on | counts + checksum over the 16 columns ordered by `span_id`; `read_only_source: true` |
| **RtdbStore (canonical)** | `infrastructure/rtdb/store.rs:283-288` (struct), `:294-304` (open), `:307-407` (`ensure_schema`), `:310-336` (`chat_rows` DDL), `:338-356` (`tool_use_rows` DDL), `:364-385` (`agent_session_rows` DDL) | `chat_rows` (18 cols), `tool_use_rows` (16), `agent_session_rows` (13) | one-shot full-row copy; PK `(session_id, correlation_id)` each | counts + checksum per table ordered by `(session_id, correlation_id)` |
| **FeatureDataStore** | `infrastructure/feature_data/store.rs:46-48` (struct), `:52-61` (open), `:64-85` (`ensure_schema`), `:67-75` (`feature_data_tables` DDL), `:76-82` (`feature_data_tombstones` DDL) | `feature_data_tables` (PK `feature_id, table_name`), `feature_data_tombstones` (PK `feature_id, table_name, key_json`) | one-shot full-row copy; `backfill_done` is part of the row (§3) | counts + checksum ordered by each table's PK |

**Also in the SpanStore family (same one-shot leg; R-5 names `telemetry_spans`):**
`telemetry_logs` (`span_store.rs:101-120`, `id INTEGER PRIMARY KEY AUTOINCREMENT`
→ C1 `BIGINT GENERATED ALWAYS AS IDENTITY`) and `telemetry_metrics`
(`span_store.rs:470-486`) participate in the same count + checksum rule; the
harness fixture covers `telemetry_spans` (the named store) and two FeatureStore
tables. The follow-up implementation spec enumerates the full physical table set
and runs the identical parity rule over it — the rule is table-agnostic.

**Enumeration rule for `feature_*` (the C2 `enumerated_from`).** The declared
tables are discovered from `feature_data_tables` (`store.rs:103-115`), not by
scanning `sqlite_master`: the declaration metadata is authoritative, and the
physical name is the store's namespace rule
`feature_{feature_id.replace('-', '_')}_{table_name}`
(`feature_store.rs:132-135`). The PoC uses exactly this rule (fixture row
`mission-monitor / items` → `feature_mission_monitor_items`) and shows a
per-table breakdown in `results/parity.json`.

**What must NOT change:** the C1 type map (`TEXT→TEXT`, `INTEGER→BIGINT`,
`REAL→DOUBLE PRECISION`, `BLOB→BYTEA`, composite PK 1:1 — `schema_defs.rs:12-22`,
verified by ST-1's 18 `schema-translation.json` checks), the PK identity of each
table, and the full-row write semantics (no field is dropped or coalesced at the
store layer).

---

## 3. One-shot markers are DATA, carried verbatim (never re-derived)

The cutover must **copy the marker values as opaque data**. Re-deriving them
means re-running the backfills they gate, which is exactly the
duplicate/race risk R-5 forbids.

| Marker | Definition (`file:line`) | Where it lives | Carry rule |
|---|---|---|---|
| `rtdb.backfill.completed` | `infrastructure/rtdb/backfill.rs:101` | `settings` row (via `AppStore::set` at `backfill.rs:326`) | copied as a `settings` row, value unchanged |
| `rtdb.backfill.provider.completed.v2` | `infrastructure/rtdb/backfill.rs:113` | `settings` row (provider pass, `backfill.rs:357-368`) | copied as a `settings` row, value unchanged |
| per-table `feature_data_tables.backfill_done` | `infrastructure/feature_data/store.rs:64-85` (DDL `:73-74`), `set_backfill_done` `:143-151`, driver `feature_data/backfill.rs:56-101` | a column of each `feature_data_tables` row | copied with the row, value unchanged (per `(feature_id, table_name)`) |

**Why re-derivation duplicates/races:**
- `run_startup_backfill` **skips** the pass when `rtdb.backfill.completed` is
  set (`backfill.rs:300-306`) and only sets it after a pass that actually read
  spans (`:324-333`). If the marker were dropped, the next startup would replay
  the entire `telemetry_spans` corpus through the live classifier. The module
  documents idempotency via classifier content-no-op + shared replay ordering
  (`backfill.rs:22-33`), but relying on that after a *cutover* is a bet on
  process-global classifier state re-deriving identical per-turn ids — the
  recorded #2932 round-2 defect (`backfill.rs:43-60`) is precisely the case
  where a replay re-minted keys and INSERTed parallel rows. **Carry the marker;
  do not take that bet.**
- `provider_rebackfill_pass` gates on its own `.v2` marker
  (`backfill.rs:357-364`); dropping it re-runs the provider attribution — and
  the old `rtdb.backfill.provider.completed` (no `.v2`) is deliberately ignored,
  never consulted, never deleted (`backfill.rs:63-66,109-112`). The design
  carries the **whole `settings` table**, so legacy keys are preserved too.
- `backfill_pending` selects tables with `backfill_done = 0`
  (`feature_data/backfill.rs:62-66`) and re-pushes canonical rows through the
  projection engine. A dropped marker re-projects canonical history into the
  declared tables and bumps `_row_version`/`_updated_at`. Carrying the column
  verbatim means the declared tables are exactly as the user left them.

**The PoC asserts this.** `results/parity.json` →
`one_shot_markers.carried_unchanged: true`, with the two AppStore marker values
and the per-table `feature_data_tables.backfill_done` map read back from
PostgreSQL and compared byte-for-byte with the source fixture.

---

## 4. `telemetry_spans` stays strictly READ-ONLY (migration invariant)

The migration preserves the existing read-only contract, which has three
concrete anchors:

1. **RTDB canonical backfill** opens `fredo.db` with
   `OpenFlags::SQLITE_OPEN_READ_ONLY` — `backfill.rs:218` and the provider pass
   `backfill.rs:367`.
2. **Declared-table backfill** opens a plain connection and immediately issues
   `PRAGMA query_only=ON` — `feature_data/backfill.rs:287-288`.
3. **ProjectionEngine's** canonical read connection is likewise read-only —
   `feature_data/projection.rs:198-202` (WAL + `query_only=ON`).
4. `RtdbStore` documents the invariant directly: "`telemetry_spans` is NEVER
   touched — the RTDB is a read-only consumer of the telemetry pipeline, never a
   writer" (`infrastructure/rtdb/store.rs:5-7`).

**How the migration carries it:**
- the export leg opens the SQLite fixture/source **read-only** (the PoC never
  issues a write against the source connection);
- in the target, the PG analogue of `PRAGMA query_only=ON` is
  `START TRANSACTION READ ONLY` / a least-privilege read-only role
  (`schema_defs.rs:196-199`, exercised by ST-1's
  `query_only_to_read_only_tx` check);
- `telemetry_spans` is copied **out** of SQLite into PG; nothing writes back to
  the SQLite source, and the PG `telemetry_spans` rows are the same immutable
  pre-cutover history.

The PoC marks the entry `"read_only_source": true` in
`results/parity.json`, and its `tables` entry is the only one carrying that
flag.

---

## 5. Parity check — counts + content checksums (R-5a)

Parity is **two independent comparisons per table**, both must pass:

1. **Row count** — `sqlite_rows == pg_rows`.
2. **Content checksum** — SHA-256 over a canonical row encoding that both
   engines compute identically.

### 5.1 The checksum rule (exact ordering + encoding)

Per table:

- **Order** by the table's PRIMARY KEY (§2 table / the `primary_key` field in
  `results/parity.json`). For a dynamic `feature_*` table, the PK read from
  `pragma_table_info`; if a table declares no PK, fall back to all columns
  lexicographically (deterministic on both engines).
- **Columns** are concatenated in a fixed declared order (for `feature_*`, the
  `pragma_table_info` `cid` order, which is also the DDL order).
- **Row encoding:** for each column, a value is `V` + its normalized text; NULL
  is the single sentinel `N`. Columns are joined with `U+001F` (unit separator);
  each row is terminated with `U+001E` (record separator).
- **Digest:** SHA-256 over the UTF-8 byte stream; lowercase hex.
- **Normalization (must match across engines):** integers → decimal; `REAL` /
  `DOUBLE PRECISION` → `{:.6}` (so SQLite `REAL` and PG `double precision`
  render the same); `TEXT` → as-is; `BLOB` → lowercase hex (SQLite blob bytes vs
  PG `bytea::text` `\x…`).

This is the **shared** `harness::encode_row` / `harness::checksum_rows` rule
(`spikes/2964-postgres-migration/src/harness.rs:169-197`) already validated by
ST-1's `content_checksum_match` check (18/18 in
`results/schema-translation.json`), reused here so the two spikes cannot drift.
The PoC reads PG as `"col"::text` for every column and normalizes in Rust, and
reads SQLite via `ValueRef`, so both legs feed the same encoder.

### 5.2 Per-store parity legs

| Table | Ordered by | Columns |
|---|---|---|
| `chat_rows` | `session_id, correlation_id` | all 18 |
| `tool_use_rows` | `session_id, correlation_id` | all 16 |
| `agent_session_rows` | `session_id, correlation_id` | all 13 |
| `telemetry_spans` | `span_id` | all 16 |
| `settings` | `key` | `key, value` |
| `feature_data_tables` | `feature_id, table_name` | all 6 |
| `feature_data_tombstones` | `feature_id, table_name, key_json` | all 4 |
| `feature_*` | each table's PK | aggregate: per-table counts+checksums, combined digest over `(name, digest)` sorted |

### 5.3 The committed C2 result

`parity.rs` emits the C2 shape (exact keys as contracted; the PoC adds
`primary_key`/`ordered_by`/`per_table`/`environment`/`summary` as evidence):

```json
{
  "issue": 2964,
  "engine": { "source": "sqlite:fredo.db", "target": "postgresql:127.0.0.1:<port>", "mode": "one-shot" },
  "tables": [
    { "name": "chat_rows", "sqlite_rows": 17, "pg_rows": 17, "row_count_match": true,
      "content_checksum": { "sqlite": "<sha256>", "pg": "<sha256>", "match": true } },
    { "name": "telemetry_spans", "read_only_source": true, "sqlite_rows": 3, "pg_rows": 3,
      "row_count_match": true, "content_checksum": { "sqlite": "<sha256>", "pg": "<sha256>", "match": true } },
    { "name": "settings", "sqlite_rows": 4, "pg_rows": 4, "row_count_match": true,
      "content_checksum": { "sqlite": "<sha256>", "pg": "<sha256>", "match": true } },
    { "name": "feature_*", "enumerated_from": "feature_data_tables",
      "sqlite_rows": 5, "pg_rows": 5, "row_count_match": true, "match": true }
  ],
  "one_shot_markers": {
    "rtdb.backfill.completed": "<value carried unchanged>",
    "rtdb.backfill.provider.completed.v2": "<value carried unchanged>",
    "feature_data_tables.backfill_done": { "<feature>.<table>": true },
    "carried_unchanged": true
  },
  "rollback": { "backout": "restore fredo.db from pre-cutover copy", "verified": false }
}
```

### 5.4 What the PoC measured (executed, Windows x86_64, release)

`cargo run --release --bin parity` → **8/8 tables matched, markers carried
unchanged = true, rollback demo ok = true** in ~0.5 s. Committed at
`results/parity.json`:

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

### 5.5 Fail-closed

A parity mismatch is a **hard stop**: step 7 of §1.2 does not flip the pool, and
step 8's `migration.postgres.completed` marker stays unset, so the next startup
re-runs the (idempotent, read-only) export. The `parity.rs` binary exits
non-zero when any table or marker fails, so the run itself is the gate.

---

## 6. Rollback / backout to SQLite + the verification that proves it (R-5b)

### 6.1 The backout

**`fredo.db` is never mutated or deleted by the migration.** The pre-cutover
snapshot (step 3) is taken before any export, and the source file is retained
for the life of the release. Backout is therefore:

```text
backout (a SQLite build, or the same build with migration disabled):
  1. stop the app (bounded PG stop — ST-5)
  2. leave the PostgreSQL data dir in place (never deleted by backout; a later
     cutover may want it)
  3. ensure <app_data_dir>/fredo.db is the pre-cutover copy:
        - a failed cutover never touched it -> nothing to do;
        - a cutover that flipped and must be reverted -> copy
          <app_data_dir>/migration/fredo.pre-cutover.db over fredo.db
  4. start the SQLite build; it opens fredo.db exactly as before
```

This satisfies the QA criterion that the backout be **executable** (fredo.db
still exists and is byte-identical to the pre-cutover source), not "restore a
backup we never took".

**Snapshot consistency (WAL).** Production uses `PRAGMA journal_mode=WAL`
(`rtdb/store.rs:298`, `feature_store.rs:123`, `span_store.rs:56`,
`feature_data/store.rs:56`). The copy is taken while the app is quiesced, after
a `PRAGMA wal_checkpoint(TRUNCATE)`, so the copied file contains all committed
data. The PoC uses SQLite `VACUUM INTO` (`parity.rs`) to produce an
unambiguous, self-contained snapshot without WAL sidecars — the same guarantee,
demonstrated deterministically.

### 6.2 The data-parity verification that proves a cutover preserved data

Rollback **verification** is the migration's own parity check plus a
snapshot re-verification:

1. **Pre-cutover:** snapshot `fredo.db` and compute the per-table row counts +
   content checksums (§5) on the snapshot.
2. **Post-cutover:** compute the same counts + checksums on PostgreSQL.
3. **Parity:** every table's count and digest must match (fail-closed).
4. **Backout proof:** re-open the pre-cutover snapshot and recompute the same
   counts + checksums; they must equal the step-1 values. This proves the
   snapshot is a faithful, restorable SQLite state — i.e. the backout path
   actually restores the data.

`results/parity.json` records this as
`rollback.fixture_demonstration: { "backout_executed": true,
"restored_checksums_match": true }`.

`rollback.verified` is **`false`** in the committed result — the *production*
cutover has not happened, so nothing production-level has been reverted. The
fixture demonstration is the mechanism proof; the production value becomes
`true` only after a real cutover is parity-checked and a real backout is
exercised (follow-up implementation spec).

### 6.3 Downgrade caveat (named)

A downgrade **after** the PG build started accepting writes loses the
post-cutover rows (they never reached SQLite). This is the one accepted cost of
one-shot (§1.3); the mitigation and the release policy are open question
Q-ST4-5 (§8). A parallel-format escape hatch (a reverse incremental export
PG → SQLite) is possible but explicitly out of scope for this spike.

---

## 7. The harness (`src/parity.rs`) — what it is, how to run it

`spikes/2964-postgres-migration/src/parity.rs` is the C2 emitter. It:

1. builds a deterministic synthetic fixture `fredo.db` under
   `target/spike-tmp/parity/source/fredo.fixture.db` containing every store in
   §2 (chat/tool/agent rows via ST-1's production-shaped upsert path; spans;
   settings incl. all three markers; `feature_data_tables` /
   `feature_data_tombstones`; two dynamic `feature_*` tables including a
   `mission-monitor` hyphenated feature id);
2. takes a pre-cutover `VACUUM INTO` snapshot;
3. starts embedded PostgreSQL through the shared bounded harness
   (`harness::PgRuntime`), creates the PG schema, and performs the one-shot
   export/import;
4. emits the C2 JSON with counts + checksums, marker values, and the rollback
   demonstration.

**Exact command** (from `spikes/2964-postgres-migration`):

```powershell
cargo run --release --bin parity
```

Output: `results/parity.json`; exit 0 iff `all_parity_ok && markers_carried &&
rollback_demo_ok`.

**Bounds / teardown (G-263/G-264).** Every embedded-PG control command is bounded
(`harness.rs:28-38`: control 180 s, setup 600 s, start 180 s, stop 30 s +
hard-kill watchdog, connect 10 s, readiness 60 s), teardown is guaranteed on
every path (`harness.rs:286-321`), and a PID-reuse-guarded orphan sweep runs
before start (`harness.rs:351-359`). The fixture is tiny, so the whole run is
sub-second after the first-run distribution provisioning.

**Isolation.** The crate is a standalone package (not a workspace member), never
referenced by `lib.rs`/`AppRuntime`, adds no dependency to
`apps/tauri/src-tauri/Cargo.toml`, and **never opens the real `fredo.db`**. This
task did not touch `Cargo.toml` — ST-1 pre-declared the `[[bin]] parity`
target (`Cargo.toml:34-36`).

---

## 8. Open questions (hand-off to the follow-up implementation spec)

- **Q-ST4-1 (migration trigger point).** Where exactly in startup does the
  one-shot leg run relative to the existing backfill spawns
  (`lib.rs:430-438` feature-data, `lib.rs:527-533` rtdb, per ST-2 §6)? It must
  run **after** the PG schema is created and **before** the first store write is
  served. *Resolving evidence:* the final startup ordering in the implementation
  spec + ST-5's bounded-start design.
- **Q-ST4-2 (what the flip marker is).** This design introduces
  `migration.postgres.completed` (a NEW key) to gate "already cut over". It is
  deliberately distinct from the three existing one-shot markers so the two
  concerns cannot collide. *Resolving evidence:* the implementation spec's
  marker naming + a test that a second startup skips the leg.
- **Q-ST4-3 (full physical table set).** The implementation spec must enumerate
  every physical table (including `telemetry_logs` / `telemetry_metrics` and any
  terminal persistence tables) and run the identical parity rule over it. *Resolving
  evidence:* a generated table list in the spec + a parity run over it.
- **Q-ST4-4 (snapshot retention).** How many pre-cutover snapshots / how long
  are they kept, and when a failed cutover's snapshot is pruned? *Resolving
  evidence:* a retention decision in the spec (the existing retention knobs are
  `rtdb.retention_days`, `contracts.retention_days`, `tracing.retention_days`).
- **Q-ST4-5 (downgrade policy).** What happens to post-cutover PG rows on a
  downgrade to a SQLite build (accepted loss vs a reverse incremental export)?
  *Resolving evidence:* a product/release-policy decision (the same class of
  human input as ST-6's offline-first question).
- **Q-ST4-6 (large-DB batching).** The PoC copies a fixture in one transaction
  per table. For a large real `fredo.db`, the export should batch (e.g. 512-row
  COPY/`INSERT` chunks, mirroring `RTDB_MAX_EMISSION_BATCH`) with a bounded
  memory budget. *Resolving evidence:* an ST-3/style measurement of a full-size
  copy in the implementation spec.

---

## 9. Verification / scope

- **AC mapping:** R-1(c) `fredo.db` data migration/backfill area; R-1(f)
  rollback/reversibility area; R-5 data preserved + reversible with the
  R-5a per-store carry + parity, R-5b rollback/backout, R-5c cutover
  decision+justification.
- **Executed evidence:** `spikes/2964-postgres-migration/results/parity.json`
  (8/8 tables count+checksum matched, markers carried unchanged, rollback
  demonstrated) produced by `cargo run --release --bin parity` on Windows
  x86_64, release profile, bounded teardown.
- **Build/lint:** `cargo build --release --bin parity` clean;
  `cargo clippy --all-targets -- -D warnings` clean.
- **No production change:** no file under `apps/**` was edited; the harness is a
  standalone spike binary. `Cargo.toml` was NOT edited (ST-1 pre-declared the
  bin); the only added files are this doc and `src/parity.rs` (+ the committed
  `results/parity.json`).
- **Citations:** every `file:line` above resolves on `main`; the harness never
  opens the real `fredo.db`.

*Authored by Developer (ST-4), issue #2964 — design + disposable PoC; no
production file changed by this deliverable.*
