# ADR #2948 — Migrate Fredo's local persistence from embedded SQLite to embedded PostgreSQL?

- **Issue:** #2948 (spike: SQLite → embedded-PostgreSQL evaluation)
- **Date:** 2026-09-26
- **PoC artifact:** [`spikes/2948-embedded-postgres/`](../../spikes/2948-embedded-postgres/) (standalone crate)
- **Raw numbers:** [`spikes/2948-embedded-postgres/results/measurements.json`](../../spikes/2948-embedded-postgres/results/measurements.json)
- **9-question set:** [`spikes/2948-embedded-postgres/QUESTIONS.md`](../../spikes/2948-embedded-postgres/QUESTIONS.md)

**Status: NO-GO** (for migrating Fredo's local persistence to embedded PostgreSQL as evaluated).

---

## Context

Fredo persists all local state in a single embedded SQLite database (`fredo.db`, `rusqlite 0.32`
with the `bundled` feature) opened by the AppStore, FeatureStore, SpanStore, RtdbStore, and the
feature-data stores (`apps/tauri/src-tauri/src/infrastructure/storage/*`,
`infrastructure/rtdb/store.rs:296`). The `sqlx`/Postgres dependency already declared at
`apps/tauri/src-tauri/Cargo.toml:51` has **zero in-tree symbol references** and is used only as
observability tooling — consolidating it is explicitly out of scope for this spike.

This spike asked whether replacing embedded SQLite with an embedded PostgreSQL server
(`theseus-rs/postgresql-embedded`) is worth pursuing. It is a **time-boxed (1–2 developer-day)
decision spike**: it ships a Windows PoC, a measured benchmark against a representative RTDB
`chat_rows` schema, answers to 9 questions, and this decision record. It changes **no production
code path**.

## Measured Evidence

Environment: Windows / x86_64 / release / `rustc 1.94.1` / commit `283b4a3`; both variants
measured in the **same session**, 2 runs each, identical fixed workload
(10 000 ops; 90 % unique keys + 10 % re-upserts; one transaction per 512 rows — mirrors RTDB
`RTDB_MAX_EMISSION_BATCH = 512`). Acquisition mode exercised: **runtime-download**
(PostgreSQL 18.6.0); `bundled` mode **not exercised**.

| Metric (reported) | SQLite baseline | embedded PostgreSQL | Δ (PG − SQLite) |
|---|---:|---:|---:|
| Binary size | 2,114,560 B | 5,567,488 B | **+3,452,928 B** |
| Installed distribution | 0 B (in-binary) | 164,026,008 B | **+164,026,008 B** |
| Cold start → first query | 36.2 ms (run 1: 38.4) | 9,760.9 ms (run 1: 9,482.9) | **+9,724.8 ms (~260×)** |
| Peak process-tree RSS | 33,734,656 B | 277,700,608 B | **+243,965,952 B (8.2×)** |
| Data dir after workload | 7,225,344 B | 67,790,416 B | **+60,565,072 B** |
| Batch upsert (10 000 ops) | 197.6–208.2 ms | 1,073.2–1,139.3 ms | **~5.4× slower** |
| Point read (1 000 by PK) | 5.1–5.6 ms | 68.4–77.3 ms | **~12–15× slower** |
| Range read (by `started_at_ns`) | 5.0–6.7 ms | 4.2–4.3 ms | **~1.2–1.6× faster** |
| Final rows | 9 000 | 9 000 | parity |

Method notes: `cold_start_ms` is process start → first successful query on a fresh data dir;
`peak_rss_bytes` is the sysinfo process-tree peak working set (Postgres children matched by name);
`data_dir_bytes` is the on-disk data dir after the workload with the server stopped. The committed
`deltas.distribution_bytes` is `null` (SQLite has no separate distribution); the install delta
above is computed from the two variant rows.

The PoC also verified `raw_json` byte-equality on read-back, a non-ASCII round-trip
(`héllo ✅ 漢字`), and the `settings` KV round-trip (`src/pgbench.rs`). The engine runs on Windows.

## The 9 Questions

Full answers (with evidence or `Unknown` + blocker) are in
[`QUESTIONS.md`](../../spikes/2948-embedded-postgres/QUESTIONS.md). Summary:

1. **Packaging/distribution** — runtime-download installs a 164,026,008 B PostgreSQL 18.6.0
   distribution and needs network on first run; `bundled` mode `Unknown` (not exercised).
2. **Process lifecycle** — out-of-process server; **observed unbounded `pg.stop()` hang (~11 h)**
   from `settings.timeout = None`; fixed with a 180 s command timeout, a 60 s bounded stop +
   `taskkill` fallback, and a 300 s harness child deadline. Production needs a sidecar supervisor
   + orphan sweep (`lib.rs:664-670`, `lib.rs:162-167`).
3. **Startup latency** — +9,724.8 ms (~260×) cold-start regression. Measured.
4. **Port/socket** — ephemeral loopback TCP (`127.0.0.1:<ephemeral>`); no fixed-port collision;
   orphaned postmaster is the residual risk.
5. **Windows-first feasibility** — verified for the basic run (9 000 rows, unicode + KV
   round-trip); macOS/Linux unverified.
6. **Migration path/rollback** — schema maps 1:1 (`src/schema.rs`); operational migration/rollback
   `Unknown` (not designed — out of scope).
7. **Benefit/regress** — only the range read benefits (~1.2–1.6×); writes, point reads, cold start,
   memory, and disk all regress materially.
8. **Operational** — measured disk costs; backup/retention/security undesigned (`Unknown`);
   PostgreSQL License is permissive (no blocker).
9. **Crate health** — `postgresql_embedded 0.21` works; maintenance/advisory data `Unknown`
   (registry not queried within the time-box).

## Decision & Rationale

**NO-GO.** For a process-local desktop app, replacing embedded SQLite with an embedded PostgreSQL
server is a strict regression on every dimension Fredo actually pays for at runtime, with a single
marginal win:

- **Startup ~260× slower** (+9.7 s) — the app opens its store at launch; a background-start
  mitigation still blocks the first real query.
- **Memory 8.2× larger** (+232.7 MiB peak RSS) and **+164 MB install footprint** + **+57.8 MiB**
  data dir — material for an offline-first desktop product.
- **Writes ~5.4× slower, point reads ~12–15× slower** — the RTDB pipeline is write-heavy and
  point-read-heavy; only range aggregation is faster (~1.2–1.6×).
- **A real lifecycle hazard** already manifested: an unbounded shutdown hang (~11 h) that required
  a bounded-teardown fix and, in production, would require a full sidecar supervisor +
  orphan-recovery layer — new complexity with no matching benefit.

This is **not** a `conditional-go`: the conditions under which PostgreSQL would be the right
answer (multi-process concurrent access to one database, server-grade SQL/`JSONB` querying at
scale, or per-user access control) are **different requirements than Fredo's current local
persistence**, and none was present in the representative workload. If such a concrete requirement
is ever identified, it warrants a **new, differently-scoped** spike that measures *that* workload —
not a condition on migrating the current persistence.

**Unconfirmed human assumptions this recommendation depends on** (surfaced from the backlog; each
is open and must be confirmed by the PO/human before acting on this ADR):

- **(a) Offline-first hardness** — is "no network ever, including first run" a hard constraint? If
  so, the runtime-download mode is disqualified outright and `bundled` would have to pass.
- **(b) Installer/binary-size ceiling** — is a ~+164 MB installer increase acceptable, and is there
  a ceiling? Unknown.
- **(c) `sqlx`/Postgres consolidation scope** — the plan declares consolidation **out of scope**;
  the human must confirm this is still the intent (it does not change the NO-GO).
- **(d) SQLite-only as a hard requirement** — if SQLite-only is a hard product constraint, a "go"
  would be unactionable regardless of the measurements.

## Migration Effort Estimate

**Size: L (Large) — ~34 story points.** If a future requirement justified migration, the work is
not a driver swap: rewrite every store open path (`infrastructure/storage/*`,
`infrastructure/rtdb/store.rs`, `infrastructure/feature_data/*`), reimplement the ~30 ms
write-behind queue and LRU cache semantics against a new client, port migrations/schema, build a
sidecar lifecycle supervisor + orphan sweep, design backup/retention/credentials, rework the
installer for the distribution, and re-test the RTDB row contract end-to-end. Scale used:
S = 1–4, M = 5–12, L = 13–40 story points; 34 places this at the upper end of L.

## Prioritized Risks

Ordered by impact × likelihood. Each item has its impact and a mitigation or accepted-risk note.

1. **Process-lifecycle hang (observed; high impact, high likelihood).** Unbounded `pg_ctl -w stop`
   hung the shutdown ~11 h. *Mitigation applied in the PoC:* 180 s command timeout, 60 s bounded
   stop + `taskkill` fallback, 300 s harness deadline. *Residual accepted risk:* a production
   migration needs a full supervisor + startup orphan sweep, or a hard-kill can orphan a server.
2. **Cold-start regression +9.7 s (measured; high impact, high likelihood).** *Mitigation:* lazy /
   background server start — but the first query still blocks. Likely unacceptable for launch UX.
3. **Memory regression 8.2× / +233 MiB (measured; high impact, high likelihood).** *Mitigation:*
   tune `shared_buffers`/`work_mem`; server baseline overhead remains.
4. **Install footprint +164 MB (measured; high impact, high likelihood).** *Mitigation:* bundle a
   compressed distribution (removes the network dependency but keeps the size); no ceiling is
   confirmed (assumption b).
5. **Write/point-read latency regressions (measured; medium impact, high likelihood).** Batch
   upsert ~5.4×, point read ~12–15×. *Mitigation:* persistent connections, pipelining, prepared
   statements — reduces but does not remove the client/server round-trip cost.
6. **Offline-first / runtime-download dependency (medium impact, medium likelihood).** The
   exercised mode needs network on first run; `bundled` is unverified. *Mitigation:* evaluate
   `bundled` only if assumption (a) is confirmed hard.
7. **Migration/rollback complexity from `fredo.db` (medium impact, medium likelihood).**
   *Mitigation:* design an export/dual-write/rollback tool before any cutover; not designed here.
8. **Windows AV/firewall false positives on a spawned `postgres.exe` (low-medium impact, medium
   likelihood).** *Accepted risk:* same class as the existing managed `llama-server`; supervised by
   the same patterns.
9. **Crate-health uncertainty (medium impact, medium likelihood).** Maintenance/advisory posture of
   `postgresql_embedded` is `Unknown` (Q9). *Mitigation:* registry/activity review before any
   dependency commitment.
10. **Licensing (low impact, low likelihood).** PostgreSQL License is permissive. *Accepted:* no
    licensing blocker identified.

## Attestation: No Production Migration

**No production migration occurred.** This spike changed **no file under `apps/tauri/**`** and did
not touch `fredo.db`, the RTDB row-pipeline contract, or the observability `sqlx` dependency.
`spikes/2948-embedded-postgres/` is a standalone package (not a workspace member; CI builds by
explicit `--manifest-path`, so the PoC is never built by CI). The changed-file set versus `main`
is exactly `spikes/2948-embedded-postgres/**` plus this `docs/research/` record. Both production
gates remain green — see
[`results/production-safety.txt`](../../spikes/2948-embedded-postgres/results/production-safety.txt).

## Reproduction Steps

From `<repo>/spikes/2948-embedded-postgres` on Windows (network available for the first run):

```powershell
cargo build --release --bins          # build PoC + benchmarks + harness
cargo clippy -- -D warnings           # zero-warning bar
cargo run --release --bin poc         # AC1 smoke: write-then-read, exits 0
cargo run --release --bin measure     # ST-2: writes results/measurements.json
```

Full prerequisites/expected output are in
[`README.md`](../../spikes/2948-embedded-postgres/README.md).

## PoC Artifact Path

`spikes/2948-embedded-postgres/` — source (`Cargo.toml`, `src/`), raw results
(`results/measurements.json`), AC5 evidence (`results/production-safety.txt`), and the 9-question
answer set (`QUESTIONS.md`).
