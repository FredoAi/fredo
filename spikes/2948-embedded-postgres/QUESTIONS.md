# Spike #2948 — the 9 question answer set

Companion to the decision record
[`docs/research/2948-embedded-postgres-spike.md`](../../../docs/research/2948-embedded-postgres-spike.md).

**Evidence base.** All numbers are the committed, measured data in
[`results/measurements.json`](results/measurements.json) — two runs per variant, same session,
Windows x86_64, release, `rustc 1.94.1`, commit `283b4a3`. Where a question cannot be answered
from that evidence it is marked `Unknown` with the named blocking factor (never an adjective).

Engine evaluated: `theseus-rs/postgresql-embedded` (`postgresql_embedded` crate **0.21**), default
**runtime-download** acquisition, bundling PostgreSQL **18.6.0** (observed under
`target/spike-pg-install/18.6.0/`).

---

## Q1 — Packaging & distribution

**Answer.** The exercised runtime-download mode installs a PostgreSQL **18.6.0** distribution of
**164,026,008 B (156.4 MiB)** into the installation dir, on top of a benchmark binary of
**5,567,488 B** (vs SQLite's **2,114,560 B**). The acquisition requires **network access on first
run**. The `bundled` (compile-time-embedded) mode — which would remove the network dependency —
was **not exercised**, so its size/build-time cost is `Unknown` (blocking factor: time-boxed spike
exercised one of two acquisition modes; `bundled` needs a long toolchain-heavy compile).

**Evidence.** `results/measurements.json` → `variants[embedded-postgres].distribution_bytes =
164026008`, `.binary_bytes = 5567488`; `deltas.binary_bytes = 3452928`. (The committed
`deltas.distribution_bytes` field is `null` because SQLite has no separate distribution; the
effective install delta is 164,026,008 − 0.)

## Q2 — Process lifecycle inside Tauri

**Answer.** An embedded-PostgreSQL PoC must **start and stop an out-of-process server itself** —
there is no in-process mode. This spike hit the lifecycle hazard head-on: with
`settings.timeout = None`, `pg.stop()` drives `pg_ctl -w stop` and **waited unbounded**, so the
benchmark child never exited and the harness blocked on `wait_with_output()` for roughly
**11 hours** before being killed by hand. The fix (now committed) bounds every stage:

- `settings.timeout = Some(Duration::from_secs(180))` in `src/main.rs` and `src/bin/bench-pg.rs`;
- `tokio::time::timeout(Duration::from_secs(60), pg.stop())`, falling back to
  `taskkill /F /IM postgres.exe` on expiry, in both binaries;
- a hard **300 s** wall-clock deadline around each benchmark child in `src/bin/measure.rs`
  (`child.try_wait()` poll loop + reader thread; kill + record in `unknown[]` on expiry).

Fredo already has the production precedent this would have to reuse: a managed-child teardown on
`RunEvent::Exit` (`apps/tauri/src-tauri/src/lib.rs:664-670` → `stop_llama_server_on_exit`) and a
PID-reuse-guarded orphan sweep at startup (`lib.rs:162-167`, `features/llm_server/process.rs`).
A production migration would require a full sidecar supervisor + orphan-recovery layer; the PoC
proves the hang is *observable and boundable*, not that it is eliminated on every host
(residual accepted risk). **This is the single strongest operational objection in the evidence.**

## Q3 — Startup latency

**Answer.** Measured `cold_start_ms` (process start → first successful query on a fresh data dir):
embedded PostgreSQL **9,482.9 ms (run 1)** / **9,760.9 ms (run 2)** vs SQLite
**38.4 ms (run 1)** / **36.2 ms (run 2)**. Delta **+9,724.8 ms** — roughly **260× slower**. For a
desktop app that opens its store at launch, ~9.7 s of added cold-start latency is a severe
regression (mitigable only by lazy/background start, which still blocks the first real query).

**Evidence.** `results/measurements.json` → `variants[*].cold_start_ms`,
`deltas.cold_start_ms = 9724.757`.

## Q4 — Port / socket

**Answer.** The PoC sets `settings.port = 0` (ephemeral) and the server comes up on
**`127.0.0.1:<ephemeral>`** over **TCP loopback** (no port scanning; the crate reports the chosen
port via `settings.port`). The spike observed no port collision because each run used a fresh
ephemeral port. Residual risk: an orphaned `postgres.exe` from a hard-killed app could keep its
port bound — which is why the orphan sweep in Q2 is a prerequisite, and why the no-production
attestation matters. Ephemeral binding means no fixed-port conflict with Fredo's other pinned
listeners (OTLP 4317/4318, MCP 9223).

## Q5 — Windows-first feasibility

**Answer.** Yes for the basic run: the PoC started embedded PostgreSQL on **win32/x86_64**, wrote
and read back **9,000 final rows**, and passed the `raw_json` round-trip, a **non-ASCII**
(`héllo ✅ 漢字`) round-trip, and the `settings` KV round-trip, exiting 0 — until the unbounded
teardown described in Q2. The measured run is therefore genuine Windows evidence.
**macOS/Linux are unverified** and must remain caveats in any decision.

**Evidence.** `results/measurements.json` environment + both variants' `rows_final = 9000`;
`src/main.rs` PoC; `src/pgbench.rs` round-trip checks; `src/sampler.rs` Windows process-tree
sampling.

## Q6 — Migration path & rollback

**Answer (partial).** A 1:1 migration of the representative RTDB table is mechanically
straightforward: `src/schema.rs` maps SQLite DDL → PostgreSQL DDL exactly
(`INTEGER→BIGINT`, `REAL→DOUBLE PRECISION`, same composite PK `(session_id, correlation_id)`,
same three indexes), and the batch-upsert / point-read / range-read SQL is translated
`?n`→`$n`. What is **not** answered, and is out of this spike's scope, is the *operational*
migration: how to export/import an existing `fredo.db` into a fresh PostgreSQL cluster, whether
to dual-write during a transition, and how to roll back to SQLite on failure.
**Unknown** for the operational path (blocking factor: no migration was designed or performed —
see the ADR's attestation; this is a decision spike, not a migration).

## Q7 — Which workloads benefit vs regress

**Answer.** Both sides are measured (10 000-op fixed workload; 90 % unique + 10 % re-upsert; one
transaction per 512 rows):

- **Benefit — range aggregation read** (by `started_at_ns`): PG **4.21–4.33 ms** vs SQLite
  **5.01–6.73 ms** (~1.2–1.6× faster). This is the only measured win.
- **Regress — batch upsert**: PG **1,073.2–1,139.3 ms** vs SQLite **197.6–208.2 ms** (~5.4×).
- **Regress — point read by PK** (1 000 reads): PG **68.4–77.3 ms** vs SQLite **5.1–5.6 ms**
  (~12–15×) — dominated by per-query TCP round-trips through the client/server boundary.
- **Regress — cold start** ~260× and **peak RSS** 8.2× (277.7 MB vs 33.7 MB), plus disk
  (+60.6 MB data dir, +164 MB distribution).

**Evidence.** `results/measurements.json` → per-run `upsert_ms`, `point_read_ms`, `range_read_ms`.

## Q8 — Operational: backup / retention / disk / security / licensing

**Answer (partial, with explicit unknowns).**

- **Disk.** Data dir after workload **67,790,416 B (64.7 MiB)** vs SQLite **7,225,344 B (6.9 MiB)**
  → **+60,565,072 B**; plus the **+164 MB** installed distribution. Measured.
- **Backup.** PostgreSQL offers mature `pg_dump`/physical-backup tooling — an operational
  *advantage* over a single SQLite file — but no backup/retention policy was designed or tested
  here: `Unknown` (blocking factor: out of scope for the spike).
- **Retention/background load.** A PostgreSQL server runs background processes
  (WAL writer, autovacuum, checkpointer) that SQLite does not; their steady-state cost was not
  measured: `Unknown` (blocking factor: spike measured only the fixed workload window).
- **Security.** The PoC uses `127.0.0.1` + a throwaway `spike`/`spike` credential and local
  authentication; production credential storage, TLS choice, and least-privilege roles are
  undesigned: `Unknown` (blocking factor: not in scope).
- **Licensing.** The PostgreSQL License is permissive (BSD/MIT-like) with no copyleft obligation —
  no licensing blocker identified. Evidence: PostgreSQL distribution license files ship in the
  extracted archive (`target/spike-pg-install/18.6.0/`, not committed).

## Q9 — Crate health / maintenance

**Answer (partial).** The evaluated crate is `postgresql_embedded` **0.21**, declared in
`Cargo.toml`, and it successfully downloaded/bootstrapped PostgreSQL **18.6.0** on Windows. Its
**maintenance/activity metrics (release cadence, open issues, bus factor, security-advisory
history) were not queried** → **Unknown** (blocking factor: crate registry/activity data was not
consulted within this spike's time-box; no network registry query was performed). This is a
material gap for a decision that would take a long-lived dependency on the crate — a future
evaluation must check registry activity and advisory history before any migration.
