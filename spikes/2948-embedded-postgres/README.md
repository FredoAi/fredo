# Spike #2948 — embedded PostgreSQL vs embedded SQLite (Windows PoC + measurement harness)

A **disposable, standalone** proof-of-feasibility crate that asks one question with measured
numbers: is `theseus-rs/postgresql-embedded` a viable replacement for Fredo's embedded SQLite
(`rusqlite 0.32`, `bundled`)?

It is a **research artifact only**:

- It is **NOT** part of any Cargo workspace. The Fredo repo has no root `Cargo.toml`; production
  CI builds by explicit manifest path (`cargo check --manifest-path apps/tauri/src-tauri/Cargo.toml`),
  so nothing here is ever built by CI.
- It **never opens `fredo.db`** and never touches production persistence. All data directories are
  throwaway paths under this crate's own `target/spike-tmp/`.
- It is never wired into `AppRuntime`.

The measured results live in [`results/measurements.json`](results/measurements.json) (committed).
The go/no-go decision record is
[`docs/research/2948-embedded-postgres-spike.md`](../../../docs/research/2948-embedded-postgres-spike.md).

---

## Prerequisites

- **Windows 10/11 x86_64** (the only verified host; macOS/Linux are unverified caveats).
- Rust toolchain **1.94+** (the crate pins `rust-version = "1.94"`; measured with
  `rustc 1.94.1`).
- **PowerShell** for the commands below.
- **Network access on first run** — the PoC uses the `postgresql-embedded` default
  **runtime-download** acquisition mode, which downloads and extracts a PostgreSQL distribution
  (PostgreSQL **18.6.0**) into `target/spike-pg-install/`. The `bundled` (compile-time-embedded)
  mode was **not** exercised (see the ADR).
- ~700 MB of free disk for the extracted PostgreSQL distribution + benchmark data directories.

## Working directory

Run every command from this crate's root:

```
C:\Code\fredo\.worktrees\2948-a\spikes\2948-embedded-postgres
```

(For a fresh checkout, that is `<repo>/spikes/2948-embedded-postgres`.)

## 1. Build (exact command)

```powershell
cargo build --release --bins
```

Builds four binaries: `poc`, `bench-sqlite`, `bench-pg`, `measure`.
Expected: `Finished \`release\` profile [optimized] target(s)` and exit 0.

Static check (zero warnings bar):

```powershell
cargo clippy -- -D warnings
```

## 2. PoC smoke run (AC1 — exact command)

```powershell
cargo run --release --bin poc
```

Expected output (write-then-read on a fresh data dir, exit code 0):

```
embedded-postgres PoC (#2948)
acquisition mode : runtime-download
data dir         : ...\target\spike-tmp\poc-data
installation dir : ...\target\spike-pg-install
[1/5] setup() — download/extract + initdb ...
[2/5] start() ...
      server up on 127.0.0.1:<ephemeral>
[3/5] first successful query after <N> ms (cold start)
      schema created (chat_rows + settings, production parity)
[4/5] WROTE 9000 rows ...
[5/5] READ BACK raw_json match=true; unicode round-trip=true; settings KV=true
OK — embedded PostgreSQL ran on Windows, performed a representative write+read, and stopped cleanly (total <N> ms)
```

The PoC creates the representative `chat_rows` + `settings` schema (1:1 with production
`infrastructure/rtdb/store.rs`), upserts 1024 chat-row-shaped rows, and verifies `raw_json`,
a non-ASCII round-trip, and the settings KV.

### Bounded teardown (important)

The original PoC set `settings.timeout = None`, which let the crate's `pg_ctl -w stop` (inside
`pg.stop()`) wait **unbounded** — the observed failure mode was an ~11-hour hang on shutdown.
Every teardown is now bounded:

- `settings.timeout = Some(Duration::from_secs(180))` — caps every pg control command.
- `tokio::time::timeout(Duration::from_secs(60), pg.stop())` — caps the graceful stop; on expiry
  the PoC runs `taskkill /F /IM postgres.exe` and still prints the OK line / returns 0.
- `measure` gives each benchmark child a hard **300 s** wall-clock deadline (`try_wait()` poll
  loop); on expiry it kills the child and records the variant in `unknown[]`.

## 3. Full measurement (ST-2)

```powershell
cargo build --release --bins
cargo run --release --bin measure
```

`measure` runs the SQLite baseline and the embedded-PostgreSQL variant over the **identical fixed
workload** (10 000 operations; 90 % unique keys + 10 % re-upserts; one transaction per 512 rows)
in the **same session**, two runs each, and writes
[`results/measurements.json`](results/measurements.json). Exit code 0 whenever the file is
written; an unmeasured variant is recorded in `unknown[]` with its reason and failing command
(never an invented number).

Expected final line:

```
RESULT: OK — both variants measured; see results/measurements.json
```

Individual variants can also be run standalone (each prints one `RunReport` JSON line):

```powershell
cargo run --release --bin bench-sqlite -- --data-dir target\spike-tmp\manual-sqlite --run 1
cargo run --release --bin bench-pg     -- --data-dir target\spike-tmp\manual-pg --run 1
```

## Measured results (excerpt from `results/measurements.json`)

Environment: Windows / x86_64 / release / `rustc 1.94.1` / commit `283b4a3`; both variants
measured in the same session.

| Metric (reported) | SQLite baseline | embedded PostgreSQL | Δ (PG − SQLite) |
|---|---:|---:|---:|
| Binary size | 2,114,560 B | 5,567,488 B | +3,452,928 B |
| Installed distribution | 0 B (in-binary) | 164,026,008 B | +164,026,008 B |
| Cold start (to first query) | 36.2 ms (run1 38.4) | 9,760.9 ms (run1 9,482.9) | +9,724.8 ms |
| Peak process-tree RSS | 33,734,656 B | 277,700,608 B | +243,965,952 B |
| Data dir after workload | 7,225,344 B | 67,790,416 B | +60,565,072 B |
| Batch upsert (10 000 ops) | 197.6–208.2 ms | 1,073.2–1,139.3 ms | ~5.4× slower |
| Point read (1 000 by PK) | 5.1–5.6 ms | 68.4–77.3 ms | ~12–15× slower |
| Range read (by `started_at_ns`) | 5.0–6.7 ms | 4.2–4.3 ms | ~1.2–1.6× faster |
| Final rows | 9 000 | 9 000 | — |

This is a **no-go** for a drop-in migration; see the ADR for the decision and rationale.

## Files

- `src/main.rs` — `poc` binary (ST-1 smoke).
- `src/bin/bench-sqlite.rs`, `src/bin/bench-pg.rs` — per-variant benchmarks.
- `src/bin/measure.rs` — harness that produces `results/measurements.json`.
- `src/{lib,schema,workload,pgbench,sampler,metrics}.rs` — shared schema/workload/sampling.
- `results/measurements.json` — committed raw numbers (ST-2 evidence).
- `results/production-safety.txt` — AC5 negative-case evidence.
- `QUESTIONS.md` — the 9-question answer set (ST-3).
