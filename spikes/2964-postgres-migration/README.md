# Spike #2964 ST-1 — SQLite → embedded-PostgreSQL schema/statement translation PoC

A **disposable, standalone** proof — not an assertion — that Fredo's SQLite DDL and its
upsert/point/range statements translate 1:1 to PostgreSQL for the two representative stores:

- RTDB `chat_rows` — production DDL `apps/tauri/src-tauri/src/infrastructure/rtdb/store.rs:310-336`
  (18 columns, composite PK `(session_id, correlation_id)`, three indexes);
- AppStore `settings` KV — `apps/tauri/src-tauri/src/infrastructure/storage/mod.rs:23-26`.

It is a **research artifact only**:

- **NOT** a member of any Cargo workspace. The Fredo repo has no root `Cargo.toml`; production CI
  builds by explicit `--manifest-path`, so nothing here is ever built by CI.
- It **never opens `fredo.db`** and never touches production persistence. Every data directory is a
  throwaway path under this crate's own `target/spike-tmp/`.
- It adds **no dependency** to `apps/tauri/src-tauri/Cargo.toml`, is never referenced by
  `lib.rs`/`AppRuntime`, and no file under `apps/**` is changed.
- Committed evidence lives in [`results/`](results/) (produced by the commands below).

---

## Crate layout (pre-declared, conflict-free)

`Cargo.toml` declares a `[[bin]]` for **every planned artifact** so later tasks add only their own
`src/<name>.rs` file — **no `Cargo.toml` or `lib.rs` edit is ever required**:

| Binary | Source | Owner |
|---|---|---|
| `schema` | `src/schema.rs` | **ST-1** — schema/DDL + statement translation (this task) |
| `bench` | `src/bench.rs` | **ST-1** — translated-statement execution + timings |
| `write_behind` | `src/write_behind.rs` | ST-3 (placeholder committed by ST-1) |
| `parity` | `src/parity.rs` | ST-4 (placeholder committed by ST-1) |
| `supervisor` | `src/supervisor.rs` | ST-5 (placeholder committed by ST-1) |

Shared code (bounded runtime, workload, checksums) is in `src/lib.rs` → `harness`, consumed with
`use postgres_migration_spike::harness;`. `src/schema_defs.rs` holds the SQLite/PostgreSQL DDL +
statement pairs (in lockstep).

## Prerequisites

- **Windows 10/11 x86_64** (the only verified host; macOS/Linux are unverified caveats).
- Rust toolchain **1.94+** (crate pins `rust-version = "1.94"`).
- **Network access on first run** — the default `runtime-download` acquisition downloads and
  extracts a PostgreSQL distribution (PostgreSQL **18.6.0**, ~164 MB) into
  `target/spike-pg-install/`. Subsequent runs reuse it.
- ~700 MB of free disk for the extracted distribution + benchmark data directories.

## 1. Build (exact command)

From this crate's directory (`<repo>/spikes/2964-postgres-migration`):

```powershell
cargo build --release --bins
```

Expected: `Finished \`release\` profile [optimized] target(s)` and exit 0.

Static check (zero-warning bar):

```powershell
cargo clippy --all-targets -- -D warnings
```

## 2. PoC run (AC3 — exact commands)

```powershell
cargo run --release --bin schema
cargo run --release --bin bench
```

Both write their committed results and exit 0:

- `schema` → [`results/schema-translation.json`](results/schema-translation.json)
  (18 checks, all `ok: true`),
- `bench`  → [`results/bench.json`](results/bench.json).

### Finite wall-clock bound

Each run is bounded end to end and is safe to run under a **10-minute outer shell timeout**.
Internally (`src/harness.rs`):

| Bound | Value |
|---|---|
| every `pg_ctl` control command (`Settings::timeout`) | 180 s |
| `pg.setup()` (first-run download/extract + initdb) | 600 s |
| `pg.start()` | 180 s |
| `pg.stop()` (the #2948 ~11 h hang) | 30 s + hard-kill |
| PG client TCP connect | 10 s |
| readiness poll (server up → first connect) | 60 s |

### Guaranteed teardown (G-263/G-264)

- A **watchdog thread** hard-kills the postmaster PID tree if `pg.stop()` has not completed within
  the bound (defence against a synchronously-blocking `stop` that would defeat
  `tokio::time::timeout`).
- After a graceful/forced stop, a surviving `postmaster.pid` triggers a final `taskkill /PID <pid> /T /F`.
- `Drop` hard-kills the postmaster PID tree on **panic / early return** (verified: an induced panic
  in the first iteration printed the `taskkill` child-termination lines).
- A startup **PID-reuse-guarded orphan sweep** (`sweep_orphans`) runs before start and kills a
  leftover only when its live image is `postgres.exe`.

## 3. What `schema` proves (all 18 checks in `results/schema-translation.json`)

1. `pg_ddl_applies`, `pg_ddl_idempotent` — translated DDL applies and re-applies.
2. `chat_rows_type_mapping` — `information_schema.columns` matches the C1 mapping
   (`INTEGER → bigint`, `REAL → double precision`, `TEXT → text`) for all 18 columns.
3. `chat_rows_composite_pk` — `("session_id", "correlation_id")` (1:1).
4. `chat_rows_indexes` — `idx_chat_started`, `idx_chat_session_time`, `idx_chat_updated` (1:1).
5. `settings_kv_mapping`, `settings_pk` — `key` PK, both `TEXT NOT NULL` (1:1).
6. `sqlite_master_to_regclass` — `to_regclass()` presence/absence semantics.
7. `synchronous_commit_off` — `PRAGMA synchronous=NORMAL → synchronous_commit = off`.
8. `autoincrement_to_identity` — `GENERATED ALWAYS AS IDENTITY` auto-assigns `1,2` and rejects an
   explicit id.
9. `settings_upsert_translation` — `excluded.value → EXCLUDED.value` re-upsert wins.
10. `insert_or_ignore_translation` — `INSERT OR IGNORE → ON CONFLICT DO NOTHING` (both engines keep
    the original value).
11. `query_only_to_read_only_tx` — `PRAGMA query_only=ON → START TRANSACTION READ ONLY` rejects a
    write on both engines.
12. `row_count_match` + `content_checksum_match` — the **same** workload through
    `INSERT OR REPLACE` (SQLite) and `INSERT … ON CONFLICT DO UPDATE … EXCLUDED` (PG) reaches the
    same final row count and an **identical SHA-256 content checksum** (rows ordered by PK, stable
    column encoding).
13. `point_read_translation`, `range_read_translation` — translated `?n → $n` reads return identical
    results (`raw_json`, `count(*)`, `sum(prompt_tokens)`).
14. `settings_engine_equivalence` — settings upsert/re-upsert yields the same content checksum on
    both engines.

The one non-obvious translation detail: PostgreSQL `sum(bigint)` yields `numeric`, so the range read
casts back with `::bigint` to keep the read shape identical to SQLite
(`schema_defs::PG_RANGE_READ`).

## 4. Transaction/`bench` result (release, Windows x86_64)

From `results/bench.json` (10 000 ops, one transaction per 512 rows):

| Metric | Value |
|---|---|
| batch upsert (10 000 ops) | ~833 ms |
| point read (1 000 by PK) | ~179 ms |
| range read | ~2.8 ms |
| final rows | 5 975 (the deterministic RNG hits 5 975 distinct keys of the 9 000-key space) |
| point-read mismatches | 0 |

These are execution/timing data points for the translated statements; the full SQLite-vs-PG
comparison remains the #2948 baseline recorded in
`spikes/2948-embedded-postgres/results/measurements.json`.

## 5. Migration findings surfaced by this PoC

- **`settings.username` does not set the cluster superuser** in `postgresql_embedded` 0.21: it feeds
  the generated `url()` while `initdb` still creates the `postgres` superuser. Setting
  `username = "spike"` produces a URL whose user does not exist (`password authentication failed for
  user "spike"`). The password **does** come from `settings.password`. The harness therefore leaves
  the username at the crate default and connects via `pg.settings().url("postgres")`. Verified
  empirically on Windows; carried into the store/lifecycle design.
- **The sync `postgres` client owns its own runtime** and panics with
  `Cannot start a runtime from within a runtime` if driven from inside a Tokio async task. All client
  work runs on a `spawn_blocking` thread.
- `sum(bigint) → numeric` (see §3), and `INSERT OR REPLACE` is exactly
  `ON CONFLICT(<pk>) DO UPDATE … EXCLUDED` for full-row writes.

## Files

- `src/lib.rs` — library root; declares only the ST-1 shared modules.
- `src/harness.rs` — bounded embedded-PG lifecycle, deterministic workload, canonical checksums.
- `src/schema_defs.rs` — the SQLite DDL / PostgreSQL DDL / statement pairs (lockstep).
- `src/schema.rs`, `src/bench.rs` — ST-1 binaries.
- `src/{write_behind,parity,supervisor}.rs` — ST-3/4/5 placeholders.
- `results/schema-translation.json`, `results/bench.json` — committed evidence.
