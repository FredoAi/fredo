# Startup / lifecycle — embedded-PostgreSQL supervision for Fredo

**Spike:** #2964 (ST-5) · **Satisfies:** R-1(d), R-3, R-3a, R-3b · **Method:** executable PoC + this
file-level design · **PoC artifact:** `spikes/2964-postgres-migration/src/supervisor.rs` ·
**Committed evidence:** `spikes/2964-postgres-migration/results/lifecycle.json`

This section owns the single strongest objection to the SQLite → embedded-PostgreSQL migration: the
`#2948` ~11 h `pg.stop()` hang. It takes a position — **a bounded supervisor with guaranteed
teardown and a PID-reuse-guarded orphan sweep makes a production sidecar a known quantity** — and
proves it with a run that completes in finite wall-clock and leaves no `postgres.exe` it started
behind.

---

## 1. Position and method

| | |
|---|---|
| **Chosen approach** | A dedicated lifecycle supervisor that REUSES the managed-child mechanism already shipped for `llama-server` (PID marker in the AppStore KV, startup orphan sweep, `taskkill /T /F` tree kill, `RunEvent::Exit` hook), plus a bounded embedded-PostgreSQL control wrapper (`pg.stop()` under a hard timeout → hard-kill fallback). |
| **PoC produced?** | YES. `src/supervisor.rs` runs the full lifecycle against a real embedded PostgreSQL and writes `results/lifecycle.json` (20/20 checks). |
| **Why a PoC here** | Lifecycle is the one area where prose cannot be trusted: `#2948` measured an ~11 h non-terminating `pg.stop()`. Only an executed, finite, reproducible run demonstrates boundedness and teardown. |
| **Production change** | NONE in this spike (permitted writes: `spikes/**`, `docs/research/**`). Every production wiring below is a *specification for the follow-up implementation spec*, citing the existing files it reuses. |

The PoC is deliberately **not** a re-implementation of the supervisor: it composes ST-1's bounded
harness (`spikes/2964-postgres-migration/src/harness.rs`, `src/lib.rs` declares it as a shared
module) and adds only the marker + sweep + exit-guard that the harness does not own.

---

## 2. Lifecycle contract (C4), with bounds

Every blocking wait has an explicit wall-clock cap. The bounds live in
`spikes/2964-postgres-migration/src/harness.rs:28-38`:

| Wait | Bound (constant) | Value | Enforced at |
|---|---|---|---|
| every `pg_ctl` control command (download / initdb / start / stop) | `PG_CONTROL_TIMEOUT` | **180 s** | `harness.rs:241` (`Settings::timeout = Some(...)`) |
| `pg.setup()` (first-run download/extract + initdb) | `PG_SETUP_BOUND` | **600 s** | `harness.rs:266` (`tokio::time::timeout`) |
| `pg.start()` | `PG_START_BOUND` | **180 s** | `harness.rs:274` |
| `pg.stop()` | `PG_STOP_BOUND` | **30 s** | `harness.rs:299` + watchdog `harness.rs:292-298` |
| PG client TCP connect | `PG_CONNECT_TIMEOUT` | **10 s** | `harness.rs:366` |
| readiness poll (server up → first connect) | `PG_READY_BOUND` | **60 s** | `harness.rs:381-392` |

Contract per the triage plan:

```text
start:      spawn postmaster -> persist PID marker (AppStore KV) -> poll readiness with a BOUNDED timeout
ready:      pg_isready-style probe with a hard deadline; failure => structured error, never a hang
stop:       bounded pg.stop() with a hard timeout -> on expiry taskkill /PID <pid> /T /F
teardown:   guaranteed on every path (normal exit, error, panic, timeout); no unbounded wait ANYWHERE
orphan:     startup sweep reads the persisted PID, verifies the live image is postgres.exe
            (PID-reuse guard), kills only on image match, then clears the marker
exit:       RunEvent::Exit hook (apps/tauri/src-tauri/src/lib.rs:664-671 pattern)
bind:       ephemeral loopback (see C3)
```

---

## 3. Start path

Production sequence (to be implemented in the follow-up spec):

1. **Spawn the postmaster** through the crate's bounded control path. In the spike,
   `PgRuntime::start()` (`supervisor.rs:422-539`, `scenario_normal`) calls the harness's
   `PgRuntime::start()` (`harness.rs:273-278`), which runs `PostgreSQL::start()` under
   `tokio::time::timeout(PG_START_BOUND, …)`.
2. **Persist the PID marker into the AppStore KV.** The production marker store is the `settings`
   KV — `AppStore` (`apps/tauri/src-tauri/src/infrastructure/storage/mod.rs:11-32`,
   `settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)` at `:22-27`); the shipped precedent is
   `llm_server::process::persist_pid` (`features/llm_server/process.rs:92-95`) writing
   `LLAMA_SERVER_PID_KEY` (`features/llm_server/mod.rs:51`). The PoC replicates the KV shape in
   `SettingsKv` (`supervisor.rs:55-119`) and the marker key `PG_PID_KEY = "postgres_pid"`
   (`supervisor.rs:43`). The postmaster PID is read from `<data_dir>/postmaster.pid` first line
   (`harness::read_postmaster_pid`, `harness.rs:324-327`).
3. **Poll readiness with a bounded timeout** (section 4).

The marker is written *after* the spawn and *before* the readiness poll, so a crash between spawn
and marker-write is still covered by the data-dir `postmaster.pid` backstop
(`harness::sweep_orphans`, `harness.rs:351-359`) run before the next start.

Bind is ephemeral loopback (`settings.port = 0`, `harness.rs:228`); there is no fixed port to
collide with the OTLP receivers (4317/4318) or the MCP bridge (9223).

## 4. Ready probe

The readiness probe is a real PostgreSQL client connection (a `pg_isready`-equivalent that also
proves authentication), retried until the deadline:
`connect_until_ready` (`harness.rs:380-393`) loops `connect_bounded` (`harness.rs:364-377`) every
250 ms until `PG_READY_BOUND` (60 s) elapses, then returns the last error with context
(`"postgres not ready within bound"`). Connect itself carries `PG_CONNECT_TIMEOUT` (10 s) via
`postgres::Config::connect_timeout` (`harness.rs:365-366`) and sets server-side
`statement_timeout`/`idle_in_transaction_session_timeout` (`harness.rs:371-374`).

**Failure is a structured `anyhow` error, never a hang**: the deadline check
(`harness.rs:386-388`) is the only exit from the retry loop besides success. The supervisor
additionally wraps the whole poll in its own `run_bounded` (`supervisor.rs:171-179`), so even a
pathological connect can only consume `PG_READY_BOUND + 2 s`.

In the measured run the server was ready in **128 ms**.

## 5. Stop path

`PgRuntime::shutdown()` (`harness.rs:286-307`) is the bounded stop:

1. Read the postmaster PID (`read_postmaster_pid`).
2. Start a **watchdog thread** (`harness.rs:292-298`) that, if the graceful stop has not signalled
   completion within `PG_STOP_BOUND` (30 s), runs `kill_pid_tree(pid)` — this is the defence
   against a `pg.stop()` that blocks *synchronously* and would defeat `tokio::time::timeout`.
3. Await `tokio::time::timeout(PG_STOP_BOUND, self.pg.stop())` (`harness.rs:299`); ignore the
   result (best-effort graceful, always bounded).
4. Signal the watchdog and join it (`harness.rs:300-301`).
5. **Final backstop**: if `postmaster.pid` still exists, `kill_pid_tree(pid)` (`harness.rs:303-305`).

`kill_pid_tree` (`harness.rs:343-347`) is exactly `taskkill /PID <pid> /T /F`. The PoC exercises
that on-expiry command **directly** in the `hard_kill_fallback_on_stop_timeout` scenario
(`supervisor.rs:540-604`): a live postmaster is killed by `taskkill /PID <pid> /T /F` in **213 ms**
and confirmed gone.

Worst-case bound: the graceful attempt and the watchdog share the same 30 s window, so shutdown
completes in ≈ `PG_STOP_BOUND`, never in hours. Measured graceful stop: **398 ms**.

## 6. Guaranteed teardown — three layers

| Layer | Runs when | Mechanism | PoC evidence |
|---|---|---|---|
| 1. Exit hook | normal app quit | `RunEvent::Exit` closure calls the bounded stop (`lib.rs:664-671`) | PoC `PidReaper` drop (`supervisor.rs:149-165`) — the same shape at process exit |
| 2. RAII `Drop` | error / early return / **panic unwind** | `PgRuntime::drop` reads `postmaster.pid` and hard-kills the tree (`harness.rs:310-321`) | `panic_path_teardown` (`supervisor.rs:605-679`): induced panic caught, postmaster PID 16644 confirmed gone |
| 3. Startup sweep | after a hard-kill (no Rust code ran) | marker read → PID-reuse guard → `taskkill /T /F` → clear marker (`supervisor.rs:128-141`) | `startup_orphan_sweep` (`supervisor.rs:680-762`): a genuine leaked orphan (PID 21164) reclaimed by a fresh `--sweep-startup` process |

**No unbounded wait exists anywhere**: every await in the supervisor passes through `run_bounded`
(`supervisor.rs:171-179`), pinned by the unit test `run_bounded_errors_fast_on_an_unbounded_wait`
(`supervisor.rs:983-995`): a `pending()` future returns `Err` in < 5 s under a 50 ms bound.

> **Caveat — `Drop` requires unwinding.** If the production release profile sets `panic = "abort"`,
> layer 2 cannot run. Layer 3 (the startup sweep) is then the sole recovery path. The follow-up spec
> must confirm/choose the panic strategy and keep the sweep (open question §10.5).

## 7. Orphan sweep and the PID-reuse guard

On every app start, before the postmaster is spawned, the supervisor runs the marker-driven sweep
(`supervisor.rs:128-141`), mirroring `llm_server::process::sweep_orphan`
(`features/llm_server/process.rs:185-197`):

```rust
let Some(pid) = store.persisted_pid()? else { return Ok(None) };
let killed = if harness::is_postgres_image(pid) { harness::kill_pid_tree(pid); Some(pid) } else { None };
store.persist_pid(None)?;   // always clear — a stale marker is never re-inspected
Ok(killed)
```

The **PID-reuse guard** is `is_postgres_image` (`harness.rs:330-340`): it queries `tasklist` for the
PID and returns true only when the live image name is `postgres.exe`. A reused PID, a gone process,
or an unreadable image is a safe no-kill path. The PoC verifies both negative branches
(`pid_reuse_guard`, `supervisor.rs:366-420`):

* a non-running PID (4,000,000) → `swept=None`, marker cleared;
* **the supervisor's own live PID** → `is_postgres=false`, `swept=None`, process survived.

The positive branch is verified end-to-end: `mem::forget` on the runtime leaves a *real* orphan,
then a fresh `supervisor --sweep-startup` process (`supervisor.rs:763-776`) reads the marker
(`Some(21164)`), clears the image guard, kills the tree, and clears the marker
(`marker_after=None`) — exit code 0.

The **data-dir backstop** `harness::sweep_orphans` (`harness.rs:351-359`) additionally covers the
window between spawn and marker write.

## 8. Exit hook

Production wiring target is `applications/tauri/src-tauri/src/lib.rs:664-671`, the existing
`RunEvent::Exit` closure:

```rust
.run(|app, event| {
    if let tauri::RunEvent::Exit = event {
        features::llm_server::commands::stop_llama_server_on_exit(app);  // existing
        // FOLLOW-UP: postgres_supervisor::stop_on_exit(app);            // required by this design
    }
});
```

`stop_llama_server_on_exit` (`features/llm_server/commands.rs:846-848`) calls `stop_managed(app)`,
which tree-kills the managed child. The PostgreSQL supervisor's exit hook must do the bounded stop
(§5) plus clear the PID marker, and must be **bounded** so app quit cannot block on a hung
postmaster. The PoC models this with `PidReaper` (`supervisor.rs:149-165`), whose `Drop` hard-kills
every tracked, still-live postmaster at scope exit (normal return or panic).

## 9. Reuse-or-justify audit — `features/llm_server/process.rs`

| Capability | Shipped (llama-server) | PostgreSQL supervisor | Verdict |
|---|---|---|---|
| PID marker write/clear | `persist_pid` `process.rs:92-95` (AppStore KV) | same KV shape, `SettingsKv::persist_pid` (`supervisor.rs:109-111`), key `postgres_pid` | **REUSE** the mechanism; key differs by design |
| read marker | `persisted_pid` `process.rs:98-104` | `SettingsKv::persisted_pid` (`supervisor.rs:114-118`) | REUSE |
| PID-reuse guard | `is_llama_server_image` `process.rs:109-117` (pure, case/whitespace-insensitive) + `process_image_name` `process.rs:122-141` | `harness::is_postgres_image` (`harness.rs:330-340`), expected image `postgres.exe` | REUSE pattern; the PG guard is substring-based on `tasklist` output |
| startup sweep | `sweep_orphan` `process.rs:185-197` | `supervisor::sweep_orphan` (`supervisor.rs:128-141`) | REUSE verbatim shape |
| tree kill | `kill_pid_tree` `process.rs:163-177`; `kill_process_tree` `process.rs:265-270` | `harness::kill_pid_tree` (`harness.rs:343-347`) | REUSE |
| spawn | `spawn_server` `process.rs:219-258` (`CREATE_NO_WINDOW` `:240-246`, stdout/stderr → log `:224-238`, stdin null) | delegated to `postgresql_embedded::PostgreSQL` (spawns `pg_ctl`/postmaster internally) | **JUSTIFIED DIVERGENCE** — see below |
| exit hook | `RunEvent::Exit` → `stop_llama_server_on_exit` (`lib.rs:664-671`, `commands.rs:846-848`) | same hook, second call | REUSE |

**Justified divergences (each must be closed by the follow-up spec):**

1. **Spawn is inside the crate, not our code.** Unlike `llama-server` (a plain executable we spawn),
   `postgresql_embedded` owns the `pg_ctl`/postmaster spawn, so we cannot apply
   `CREATE_NO_WINDOW` (`process.rs:240-246`) or redirect stdout/stderr to our log
   (`process.rs:224-238`). Whether the crate exposes creation flags / log paths must be confirmed;
   otherwise the desktop launch may flash a console. Open question §10.3.
2. **`pg.stop()` is async and crate-owned.** The llama-server stop is a synchronous
   `Child::kill`+`wait`; PostgreSQL needs the crate's async `stop()` wrapped by
   `tokio::time::timeout` plus the sync watchdog. The supervisor therefore reuses the *mechanism*
   (bounded stop → `taskkill /T /F`) but adds the watchdog thread the synchronous `Drop` path
   cannot await.
3. **No `std::process::Child` handle.** The crate does not hand back a child handle, so teardown
   works from `postmaster.pid` / the KV marker rather than an in-memory handle (this is why the
   startup sweep is load-bearing, not optional).

Nothing in `features/llm_server/process.rs` is modified by this spike.

## 10. Open questions (each blocks the follow-up implementation spec)

1. **Where does the supervisor live, and who calls it at startup?** — a new
   `infrastructure/pg_supervisor` module (or a feature) created in `lib.rs` setup, with the sweep
   run before the first store opens. Blocks: no store can open until the server is up; the ordering
   vs `AppStore::open` must be fixed. Resolving evidence: a file-level wiring list against
   `lib.rs` setup.
2. **Readiness probe choice** — the crate's `is_ready`/`pg_isready` vs the PoC's real-client
   `connect_until_ready`. Blocks: the probe defines the first-query latency and the failure code.
   Resolving evidence: crate API inspection + a measured cold-start number (the `#2948` +9.7 s
   regression is owned by the master doc).
3. **`CREATE_NO_WINDOW` / log redirection for the crate-spawned postmaster.** Blocks: a visible
   console window on GUI launch, and no server log for the R-4 actionable-tail UX. Resolving
   evidence: crate API (creation flags / `Settings` log options) or a wrapper.
4. **Exit-hook ordering** — PG stop must run in the same `RunEvent::Exit` closure
   (`lib.rs:664-671`) *after* dependent stores stop writing, and must be time-bounded so quit never
   blocks. Resolving evidence: the insert point + a bounded-stop test.
5. **Panic strategy** — confirm the release profile unwinds (layer 2 stays live); if
   `panic = "abort"`, the startup sweep (layer 3) is the only recovery. Resolving evidence:
   `Cargo.toml` profile check + the sweep already proven by the PoC.
6. **Single-instance / concurrent launches** — two Fredo instances must not manage the same data
   dir; a second launch must either attach or refuse. Blocks: a second postmaster on one data dir is
   corruption. Resolving evidence: existing single-instance behavior + a data-dir advisory lock.
7. **Data-dir wipe vs marker** — a wipe removes `postmaster.pid` but not the KV marker; the sweep
   must tolerate a marker whose PID is gone (§7 safe path). Resolving evidence: the no-kill path
   already demonstrated.

## 11. PoC evidence

**Run (Windows x86_64, release, `postgresql_embedded` 0.21, PostgreSQL 18.6.0):**

```powershell
cargo run --manifest-path spikes/2964-postgres-migration/Cargo.toml --release --bin supervisor
```

Exact committed command, bounded end to end; the measured run wrote
`spikes/2964-postgres-migration/results/lifecycle.json` and exited 0 in **76 s**.

| Scenario | Key measurement | Result |
|---|---|---|
| `normal_start_ready_stop` | setup 25,567 ms · **start 985 ms** · ready 128 ms · **stop 398 ms** | marker set + cleared, postmaster gone |
| `hard_kill_fallback_on_stop_timeout` | live postmaster killed by `taskkill /PID <pid> /T /F` in **213 ms** | gone, marker cleared |
| `panic_path_teardown` | induced panic → RAII `Drop` | postmaster PID 16644 gone |
| `startup_orphan_sweep` | leaked orphan PID 21164 alive → fresh `--sweep-startup` child | swept, marker `None`, child exit 0 |
| `pid_reuse_guard` | non-PID + the supervisor's own live PID | never killed, marker cleared |

**20/20 checks passed**; `bounds` recorded in the JSON match §2; `orphan_pids: []`.

**Teardown / no-orphan proof.** The report records `started pids [9360, 15384, 16644, 21164]` and
`still-live []`. The final `postgres.exe` snapshot is `[8036]` — a **pre-existing, unrelated**
instance (baseline before the run was `[15952]`); the PoC asserts only on the PIDs it started, which
is the honest, per-process claim. Process observation was functional (`tasklist available = true`),
so the absence is directly observed, not inferred.

**Reproduce the static checks:**

```powershell
cargo clippy --manifest-path spikes/2964-postgres-migration/Cargo.toml --all-targets -- -D warnings   # zero warnings
cargo test   --manifest-path spikes/2964-postgres-migration/Cargo.toml --bin supervisor               # 4/4 unit tests
```

The unit tests pin the pure guarantees: marker round-trip, sweep no-kill + clear, and
`run_bounded` erroring fast on an unbounded wait.

## 12. Position on the `#2948` `pg.stop()` ~11 h hang

**MITIGATE + ACCEPT (residual).** Mechanism: `Settings::timeout` (finite control-command timeout) +
`tokio::time::timeout(PG_STOP_BOUND)` + a synchronous watchdog + `taskkill /PID <pid> /T /F`
fallback + the three-layer teardown + the startup orphan sweep. The PoC demonstrates each element.
**Residual accepted:** a hard-kill (Task Manager / power loss) can still orphan a postmaster — the
startup sweep *mitigates* it, it does not *eliminate* it. That residual is exactly the case the
`startup_orphan_sweep` scenario exercises and reclaims.

## 13. Files

| File | Role |
|---|---|
| `spikes/2964-postgres-migration/src/supervisor.rs` | the PoC supervisor (bounded lifecycle, marker, sweep, exit guard) |
| `spikes/2964-postgres-migration/results/lifecycle.json` | committed measured evidence (20/20) |
| `spikes/2964-postgres-migration/src/harness.rs` | reused bounded PG lifecycle (`PgRuntime`, image guard, tree kill, readiness) |
| `apps/tauri/src-tauri/src/features/llm_server/process.rs` | reused supervision precedent (marker, sweep, tree kill, spawn) |
| `apps/tauri/src-tauri/src/lib.rs:664-671` | the `RunEvent::Exit` hook to extend |
| `apps/tauri/src-tauri/src/infrastructure/storage/mod.rs:22-27` | the AppStore `settings` KV that holds the marker |

*No file under `apps/**` is changed by this deliverable; the production wiring above is a
specification for the follow-up implementation spec.*
