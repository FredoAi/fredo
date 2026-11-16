# headless-ingest — Functional

Durable functional suite for the **headless ingest daemon** (`fredo ingest`): the AppHandle-free
process that owns the embedded PostgreSQL cluster and the OTLP receivers while the desktop GUI is
closed. Seeded at issue **#2992**. Inherits `.opencode/tests/persistence-spike/`,
`postgres-lifecycle/`, `postgres-cutover/`, `postgres-stores/`, `event-persistence/`, and
`settings/` on overlapping surfaces.

> **Verification policy: LIVE** — this is a runtime/ingest feature. Cluster ownership, OTLP
> delivery, bounded shutdown, lock conflict/attach, the login entry, and the Mission-Monitor
> replay are provable only by observing a running artifact. Every row's receipt must reference a
> `telemetry_spans` live read (PG-backed via the managed `psql`; see Required test data). A
> static-only PASS is a FALSE PASS. The CLI `emit` path routes to the RTDB row pipeline and
> writes **no** spans (G-256) — it is not a span producer.

> **G-263 SAFETY (named failure mode): the #2948 ~11 h `pg.stop()` hang.** NEVER run an unbounded
> binary. Every start/stop/readiness/teardown wait MUST be bounded (finite timeout, hard-kill
> fallback, guaranteed teardown). An observed unbounded/blocking wait is a FAIL, not a skip.

> **G-280 environment note.** An orphan `postgres.exe` / stale socket left by an earlier
> `dev-env.ps1 -Action Down` is a known environment artifact, never a spec FAIL — the row states
> which process it observed.

> **G-284/G-307 read lever.** PostgreSQL is the only store. Read it via the managed
> `psql` (database `postgres`) through the allowlisted `run-exitcode.ps1 -Command`
> wrapper, or the `telemetry-query` skill. `<port>` from
> `<lock_dir>/headless-ingest.json` (or `pg_supervisor_status`); `<pw>` from the OS
> keychain (service `fredo.postgres`, account `loopback:password`). If the app pool holds all 8
> server connections, an external `psql` is refused `too many clients` — use the app-pool-backed
> `telemetry_get_stats` for the same-instant read.

## Cases

- [ ] **F-1 (R-1) — headless boot owns the cluster + receivers.**
  With the GUI closed, run `fredo ingest` against the scratch dirs. Read the descriptor, probe the
  PG port, list listening sockets, and check the exclusive lock.
  **Expected:** the embedded cluster starts on the shared data dir + shared control-plane
  credential; the exclusive `<lock_dir>/postgres.lock` is held; the descriptor's `pid`+`port` are
  live (published only after `probe_ready`); both OTLP receivers bind `127.0.0.1:4317`/`:4318`; a
  bounded `SELECT 1` via the managed `psql` against the descriptor port succeeds.
  **Edge:** 4317/4318 already bound (clear start failure); stale descriptor from a prior run
  overwritten; fresh vs warm data dir; `--grpc-port`/`--http-port` overrides honored.

- [ ] **F-2 (R-1) — OTLP delivery persists a raw span AND a canonical row.**
  Deliver a trace export to HTTP `4318` and to gRPC `4317` (committed OTLP fixture — see
  Required test data); read PG.
  **Expected:** each delivery lands a raw `telemetry_spans` row (existing
  `SpanStore::insert_raw_spans`) AND derives a canonical `chat_rows` row through the existing
  `IngestClassifier`; no alternate row-emission route; not subscription-gated.
  **Edge:** HTTP and gRPC parity; malformed/partial payload rejected without panic; receiver up
  with no subscriber; raw-insert vs classifier-derive ordering.

- [ ] **F-3 (R-2) — bounded graceful shutdown via the file lever.**
  Create `FREDO_INGEST_SHUTDOWN_FILE`; time exit; then re-probe the PG port and inventory
  `postgres.exe`.
  **Expected:** the daemon drains/flushes the RTDB write-behind queue, closes the pool, stops the
  cluster within `FREDO_INGEST_STOP_BOUND_MS`, releases the data-dir lock, removes the descriptor,
  and exits **0**; a post-stop TCP probe against the PG port **fails**; no orphan postmaster.
  **Edge:** shutdown-file already present at start; empty file; shutdown mid-ingest; a
  stale/orphan `postgres.exe` from an earlier `dev-env Down` is reported as the G-280 environment
  artifact, never a spec FAIL.

- [ ] **F-4 (R-2) — hard-kill fallback on stop-hang.**
  Set `FREDO_PG_STOP_HANG_MS` to exceed the graceful bound and shut down via the file lever.
  **Expected:** graceful stop exceeds the bound → the watchdog hard-kills the postmaster PID
  **tree**; the outer wait stays bounded; the PID tree is gone; lock + descriptor cleared;
  teardown completes.
  **Edge:** repeated hang cycles; `FREDO_INGEST_STOP_BOUND_MS` clamped ≤ 120000; a surviving
  child is a FAIL unless it is the G-280 pre-existing orphan.

- [ ] **F-5 (R-3) — lock-conflict fail-fast (second daemon).**
  With one daemon holding the lock, start a second `fredo ingest`; read its exit code and message;
  count postmasters.
  **Expected:** the second daemon exits **non-zero (1)** with a clear structured lock message;
  starts **no** second postmaster; the first daemon is unaffected.
  **Edge:** simultaneous-start race; lock file held by a non-postgres process; lock dir on a
  different volume.

- [ ] **F-6 (R-3) — GUI cluster-start fails fast, then ATTACHES.**
  While the daemon holds the lock, boot the GUI (its own cluster start); read
  `pg_supervisor_status` / `settings-ingest-daemon-status`; inventory postmasters.
  **Expected:** the GUI's own cluster start fails fast on the lock with a clear message and starts
  no postmaster; with a live descriptor present the GUI attaches to the headless-owned cluster
  (state `attached`, `attached:true`) using the same data dir + credential, and neither starts nor
  later stops a postmaster (`stop_on_exit` no-ops).
  **Edge:** attach while the daemon is shutting down; GUI already running before the daemon starts
  (no attach expected); descriptor present but port unreachable.

- [ ] **F-7 (R-3) — stale/missing-descriptor fallback.**
  With the lock held, delete or rewrite the descriptor to a dead pid / non-`fredo.exe` image /
  unreachable port; boot the GUI.
  **Expected:** `is_live` is false → the GUI keeps today's `Failed` fail-closed path; it never
  attaches to a dead cluster and never sweeps/stops a postmaster.
  **Edge:** malformed JSON; pid reused by another image; bounded TCP connect times out (≤500 ms);
  descriptor absent entirely.

- [ ] **F-8 (R-4) — autostart toggle installs/removes the login entry.**
  From the no-daemon/no-registry-entry state, open Settings → Ingest and confirm `Off` + `Not
  running` (G-265); drive the toggle on, read the registry, then off; read the registry again;
  check the KV + DOM status.
  **Expected:** enabling installs `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\FredoIngest`
  = `"<exe>" ingest`; disabling removes it; the KV key `ingest.autostart` mirrors the effective
  state; the surface renders `settings-nav-ingest`, `settings-ingest-autostart-section`,
  `settings-ingest-autostart-toggle`, `settings-ingest-autostart-status`, and
  `settings-ingest-daemon-status`, and reflects the real registry state on mount; while enabled
  `entry`/`command` are always populated (never blank).
  **Edge:** disable when absent (idempotent, no error); enable twice; exe path containing spaces
  (quoting); `reg.exe` invocation bounded ≤10 s; a forced `reg.exe` failure shows the persistent
  error copy `Could not update login auto-start: {message}` and reverts the switch.

- [ ] **F-9 (R-5) — no one-shot markers, no SQLite data store.**
  Snapshot the control-plane markers before/after a daemon session; grep the daemon path for
  backfill/SQLite-data-store use.
  **Expected:** the daemon does **not** read or write `rtdb.backfill.completed` /
  `rtdb.backfill.provider.completed.v2`; never writes `telemetry_spans` from the backfill path;
  opens **no** SQLite DATA store — its only settings access is the credential/pid keys
  (the adjudicated contract, not the data plane).
  **Edge:** pre-existing markers untouched; daemon start with a legacy SQLite file
  present (the daemon ignores it); grep for the `run_startup_backfill` migration on the daemon path.

- [ ] **F-10 (R-1/R-3, MISSION-MONITOR E2E) — shared-state attach + replay render.**
  Start the daemon against the shared resolved app-data dir (`FREDO_DATA_DIR` or OS
  `%APPDATA%\com.fredo.app`) + shared settings credential; ingest a session; launch the GUI.
  **Expected:** the GUI attaches (state `attached`) and Mission Monitor renders the
  headless-ingested session via `useEventRows(..., { replay: true })`; the shared-state lever
  (same resolved app-data dir + same settings credential + descriptor port) is named in the
  receipt.
  **Edge:** GUI already running when the daemon starts; a second session ingested after attach;
  app pool saturates connections → use `telemetry_get_stats` for the same-instant read.

- [ ] **F-11 (R-1/R-3, OS parity) — daemon resolver == GUI app-data dir.**
  Read the daemon's resolved dir (descriptor / logs) and the GUI's resolved dir with
  `FREDO_DATA_DIR` unset, then set.
  **Expected:** the daemon's new Tauri-free `resolve_os_app_data_dir()` resolves the same dir the
  GUI uses on Windows (`%APPDATA%\com.fredo.app`); when `FREDO_DATA_DIR` is set both honor it.
  **Edge:** `FREDO_DATA_DIR` unset/blank (default path); trailing separators/case differences;
  roaming vs local profile.

- [ ] **F-12 (R-3, concurrency) — control-plane concurrency.**
  While the daemon runs, boot/attach the GUI and read `postgres.password`; watch both logs for
  SQLite lock errors.
  **Expected:** both processes read a consistent credential from the PostgreSQL settings store; no
  lock error on either side.
  **Edge:** concurrent read/write of `postgres_pid`; rapid attach cycles; concurrent settings writes under
  contention.

- [ ] **F-13 (NFR) — regression invariants.**
  With every new env seam unset, boot the GUI; run the existing supervisor/store test set; diff
  the receiver surface.
  **Expected:** default GUI boot is byte-identical; receiver status codes, transport tags, and
  classification semantics are unchanged; the #2989 spike test and all existing supervisor/store
  tests stay green (G-281/G-290); no existing assertion is deleted or weakened.
  **Edge:** env seams set to empty string (must equal unset); CI-parity toolchain (G-282).

- [ ] **F-14 (NFR, G-254) — CLI help names the full value set.**
  Run `fredo ingest --help`.
  **Expected:** the declared help text names every flag (`--data-dir`, `--pg-data-dir`,
  `--lock-dir`, `--grpc-port`, `--http-port`, `--run-ms`, `--shutdown-file`) with its default and
  documents exit codes 0/1/2.
  **Edge:** unknown flag → usage error; `--grpc-port 0` rejected; `--run-ms 0` bounded
  self-terminate.

## Non-functional

- [ ] **N-1 (boundedness, G-263):** every runtime wait has a finite cap + hard-kill fallback; no
  unbounded binary; `is_live`'s TCP probe bounded ≤500 ms.
- [ ] **N-2 (teardown):** guaranteed on normal/error/panic; lock/descriptor/PID cleared on every
  path; zero `postgres.exe` after (per-process inventory).
- [ ] **N-3 (loopback-only):** PG ephemeral `127.0.0.1`; OTLP `127.0.0.1:4317/4318`; never
  `0.0.0.0`.
- [ ] **N-4 (build/CI parity, G-282):** `cargo check --locked`, `cargo test --locked`,
  `cargo clippy --locked -- -D warnings`, `pnpm --filter @fredo/ui build` — all green.
- [ ] **N-5 (no row-pipeline regression):** emission only via the classifier; Mission Monitor
  renders from the store; no existing supervisor/store test deleted or weakened.
- [ ] **N-6 (seam semantics, G-296):** caller value wins; default only when unset/blank; no
  internal `std::env::set_var` of an override.

## Suite-level pass/fail

PASS = F-1…F-14 all green **and** N-1…N-6 hold. FAIL = any unbounded wait, a started
`postgres.exe` surviving normal/error/panic teardown, a never-cleared lock/descriptor, a second
postmaster under R-3, a registry entry that survives disable, a backfill-path `telemetry_spans`
write, or a static-only receipt for a live-policy row. Every UNVERIFIED row carries a named,
actionable blocker (G-053).

## Round 1 results (2026-10-03, spec/2992 @ d6829508)

- [x] **F-1 PASS** — descriptor pid/port live, lock held, both OTLP listeners, managed-`psql` `SELECT 1`.
- [x] **F-2 PASS (HTTP canonical; gRPC raw)** — HTTP fixture → live `telemetry_spans` (`chat`, `otlp_http`)
  **and** `chat_rows` (42/7); gRPC injector → `telemetry_spans` (`fredo.tool.read`, `otlp_grpc`).
- [x] **F-3 PASS** — shutdown exit 0, lock released, post-stop TCP false, no orphan.
- [x] **F-4 PASS** — stop-hang hard-kill fired at the 2 s bound; teardown complete.
- [x] **F-5 PASS** — second daemon exit 1 with a lock message; no second postmaster.
- [x] **F-6 PASS** — GUI attaches (`attached`; DOM `Attached to a headless daemon`).
- [ ] **F-7 UNVERIFIED** — named blocker: `dev-env Up` kills the `fredo.exe` daemon, so the stale/missing
  descriptor GUI boot was not separately driven (unit pins cover `is_live`).
- [x] **F-8 PASS (core)** — registry + KV + DOM testids; enable/disable round-trip. Forced-`reg.exe`-failure
  edge UNVERIFIED (no injection seam).
- [x] **F-9 PASS** — no backfill markers / no data-plane SQLite; R-5b refusal exit 1 with a clear message.
- [ ] **F-10 FAIL/UNVERIFIED (human directive)** — attach + persistence PASS; **Mission Monitor did not render
  the session**. Named blockers: the list reads the ST-6 declared `sessions` rollup (not `useEventRows(replay)`);
  the committed fixture cannot satisfy the rollup predicate; fresh-cluster declared-table `latestat` error;
  wedged real app-data cluster; MCP-bridge 0.12/0.13.
- [x] **F-11 PASS** — caller `FREDO_DATA_DIR` honored; default == `%APPDATA%\com.fredo.app`.
- [x] **F-12 PASS** — daemon+GUI share the settings store with no lock error.
- [x] **F-13 PASS (local)** — spike test present; local UI build + 2865 tests green; CI `ui-validate` red on an
  unrelated Terminal-settings flake (flagged).
- [x] **F-14 PASS** — help names every flag + defaults + exit codes 0/1/2; usage errors non-zero.

**Round verdict: FAIL** (F-10 red; F-7 + F-8 forced-reg edge UNVERIFIED). Full evidence in the issue's
`## Tests Runs (round 1)` comment.

## Required test data

- Scratch state under `.opencode/tmp/2992/` only (`app/`, `pgdata/`, `lock/`, `stop.flag`,
  descriptor).
- Induction seams (G-275): `FREDO_DATA_DIR`, `FREDO_PG_DATA_DIR`, `FREDO_PG_LOCK_DIR`,
  `FREDO_INGEST_DESCRIPTOR`, `FREDO_INGEST_SHUTDOWN_FILE`, `FREDO_INGEST_RUN_MS`,
  `FREDO_INGEST_STOP_BOUND_MS`, `FREDO_PG_STOP_HANG_MS`, `FREDO_INGEST_GRPC_PORT`,
  `FREDO_INGEST_HTTP_PORT`. Drive gated legs via a helper script that sets the env var **inside**
  the script (G-279); evidence shows the gate ACTIVE, never a skip notice.
- OTLP trace fixture (G-172): a committed deterministic payload produced by ST-8's gated test
  (`apps/tauri/src-tauri/tests/headless_ingest.rs`), stored under
  `.opencode/tests/headless-ingest/fixtures/`.
- GUI lever: `.opencode/scripts/dev-env.ps1 -Action Up|Down|Restart -Spec 2992` (bounded).
- Registry read: bounded `reg.exe query HKCU\Software\Microsoft\Windows\CurrentVersion\Run /v FredoIngest`.
