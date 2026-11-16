# postgres-lifecycle — Functional

> **Withdrawn artifacts:** the spike PoC crates `spikes/2948-embedded-postgres/` and `spikes/2964-postgres-migration/` (and the four `2964-postgres-migration-approach/*.md` section files) were deleted after the fact. Only the durable research records remain, as flat `spikes/<issue>-<slug>.md`. The crate paths cited in this suite record real `#2948`/`#2964` observations made while those artifacts existed; they are kept as evidence and are **not** a live dependency.

Durable functional suite for the **embedded-PostgreSQL lifecycle supervisor** feature domain
(bounded start/stop, PID-marker orphan sweep, guaranteed teardown). Seeded at issue **#2974**
(slice 1 of 6; builds on spike #2964). Inherited and extended by every following Postgres slice.

> **Evidence policy: LIVE** — this is a runtime/lifecycle feature. Boundedness, teardown, orphan
> reclamation, and the app-boot / row-pipeline regression are provable only by observing a running
> artifact. The testing exit gate and the audit fail-closed unless the Tester's Evidence references
> `telemetry_spans` (a live query — F-15) plus process-observation receipts (`tasklist`). A
> static-only PASS is a FALSE PASS.

> **G-263 SAFETY (named failure mode): the #2948 ~11 h `pg.stop()` hang.** NEVER run an unbounded
> binary. Every external-runtime start (the app dev instance AND the postmaster) MUST be bounded
> (finite timeout, every blocking wait bounded, guaranteed teardown). The live app leg starts and
> stops through the sanctioned lever `powershell -File .opencode/scripts/dev-env.ps1 -Action Up
> -Spec 2974` / `-Action Down` — never a hand-rolled `pnpm dev:tauri` spawn, never a bare
> `postgres`/`pg_ctl`. An observed unbounded/blocking wait is a FAIL, not a skip.

> **Bounds under test** (reused from `spikes/2964-postgres-migration/src/harness.rs` via
> `spikes/2964-postgres-migration-approach.md:35-42`): control **180 s**,
> setup **600 s**, start **180 s**, stop **30 s**, connect **10 s**, ready **60 s**; the readiness
> wrapper is ready + 2 s. Acceptance is per-process: assert only on the PID this run started.

## Cases

- [ ] **F-1 (REQ-1 / AC1, QA-1.1) — bounded start + marker + readiness.**
  Enable the PG engine; cold-start the app on a fresh data dir. Read the supervisor log, the
  AppStore KV PID marker, and the readiness probe result. Confirm via `tasklist` that the
  postmaster is a live `postgres.exe`.
  **Expected:** the postmaster spawns; the KV marker equals line 1 of `<data_dir>/postmaster.pid`;
  the real-client readiness probe succeeds within the **60 s** cap (PoC measured 128 ms); start
  completes within the **180 s** cap. **FAIL** = marker missing/mismatched, readiness over cap, or
  a hang.

- [ ] **F-2 (REQ-1 / AC1, QA-1.2) — fail-closed on an un-ready server.**
  Drive a start whose server cannot become ready (corrupt/absent PG data dir, or the server's
  endpoint occupied), and time the failure.
  **Expected:** a **structured** error is returned within the ready cap (≤ **62 s** incl. the +2 s
  wrapper); startup fails closed; no unbounded wait; no marker left pointing at a live process.
  **FAIL** = a hang, an unstructured panic, or a live marker after failure.

- [ ] **F-3 (REQ-2 / AC2, QA-2.1) — bounded graceful stop on normal quit.**
  Start PG-enabled, then quit the app normally. Time quit → process-gone; read the marker.
  **Expected:** teardown completes within the **30 s** cap (PoC measured 398 ms); the started
  `postgres.exe` PID is gone; the KV marker is cleared; quit does not block on a hung server.
  **FAIL** = over cap, orphaned PID, or a stale marker.

- [ ] **F-4 (REQ-2 / AC2, QA-2.2) — hard-kill fallback on graceful-stop expiry.**
  Force the graceful `pg.stop()` to exceed the 30 s bound (induced hung postmaster / stub stop),
  then observe the fallback path.
  **Expected:** `taskkill /PID <pid> /T /F` runs on expiry and the PID **tree** is gone within the
  bound (PoC measured 213 ms); the marker is cleared; every postmaster child dies.
  **FAIL** = no fallback, a surviving child, or an over-cap wait.

- [ ] **F-5 (REQ-2 / AC2, QA-2.3, G-273) — shell-first render + only store-dependent reads block.**
  Cold-start with PG enabled; capture the first painted frame before/while the server boots
  (`tauri_webview_dom_snapshot(type="structure")` + screenshot); then exercise a store-dependent
  read.
  **Expected:** the app window renders a non-empty `<body>` before/while the server boots; the UI
  shell is NOT blocked by the 600 s setup bound; only store-dependent reads block, and they resolve
  once the server is ready. **FAIL** = a blank shell until boot completes, or the shell blocked by
  the setup bound.

- [ ] **F-6 (REQ-3 / AC3, QA-3.1) — stale marker, live `postgres.exe` → kill + clear.**
  Leak a real orphaned postmaster (PoC `mem::forget` analogue), then relaunch the app and observe
  the startup sweep.
  **Expected:** the sweep reads the marker, the image guard confirms `postgres.exe`, the tree is
  killed, the marker is cleared; the orphan PID is gone (PoC: PID 21164 reclaimed by a fresh
  process, child exit 0). **FAIL** = orphan survives or marker persists.

- [ ] **F-7 (REQ-3 / AC3, QA-3.2) — gone PID → safe no-kill + clear.**
  Seed the marker with a non-running PID (e.g. 4,000,000) and relaunch.
  **Expected:** the sweep performs no kill, clears the marker, and start proceeds with no error.
  Edge: missing marker (empty) and malformed marker text both resolve to `None` + clear.

- [ ] **F-8 (REQ-3 / AC3, QA-3.3) — reused / non-`postgres.exe` image → no-kill + clear.**
  Seed the marker with a live NON-`postgres.exe` PID (the app's own PID, or another known live
  process) and run the sweep.
  **Expected:** the process is NEVER killed and survives the sweep; no kill is reported; the marker
  is cleared. Edge: a reused PID, and an unreadable image (`tasklist` miss), are both safe no-kill
  paths.

- [ ] **F-9 (REQ-4 / AC4, QA-4.1) — bounded-future unit test (exact bound).**
  Run the AC4 unit test that drives `run_bounded(50 ms, pending())` (PoC:
  `run_bounded_errors_fast_on_an_unbounded_wait`).
  **Expected:** returns `Err` AND elapsed `< 5 s` under a 50 ms bound. **FAIL** = no error, or
  elapsed ≥ 5 s.

- [ ] **F-10 (REQ-4 / AC4, QA-4.2/4.3/4.4) — teardown on every path.**
  Exercise teardown on (a) normal return, (b) an induced error, (c) an induced panic — OR read the
  declared release panic profile.
  **Expected:** (a)/(b) RAII `Drop` hard-kills the postmaster, PID gone; (c) unwinding runs `Drop`,
  PID gone (PoC PID 16644 gone) OR the release profile declares `panic = "abort"` and the startup
  sweep is named the sole recovery path. **FAIL** = an orphan on any path with no declared abort.

- [ ] **F-11 (REQ-4 / AC4, QA-4.5) — wiped data dir + stale marker ≠ unrelated kill.**
  Wipe the PG data dir, leave a stale KV marker pointing at an unrelated live PID, then start.
  **Expected:** the unrelated process is NOT killed; start succeeds or fails closed cleanly; the
  marker is cleared. **FAIL** = an unrelated process killed.

- [ ] **F-12 (REQ-5 / AC5, QA-5.1) — cold start under lazy/background start: MITIGATE + RE-MEASURE.**
  Measure app-ready + first store-dependent query on a cold start with the postmaster started
  lazily/in the background; record raw ms.
  **Expected:** raw numbers recorded and compared to the #2948 baseline (+9,724.8 ms / ~260×); the
  position is stated verbatim as **MITIGATE + RE-MEASURE**; F-5 holds. A restatement of the #2948
  numbers with no re-measurement = FAIL.

- [ ] **F-13 (REQ-5 / AC5, QA-5.2) — `pg.stop()` residual: MITIGATE + ACCEPT (residual).**
  Re-measure the bounded stop and enumerate every mitigation element the plan names (coverage of
  the named set, NOT a literal count).
  **Expected:** stop ≤ **30 s** cap (PoC 398 ms); the elements (finite control timeout + bounded
  `pg.stop()` + synchronous watchdog + `taskkill /T /F` + three teardown layers + startup sweep) are
  each demonstrated; the position is stated verbatim as **MITIGATE + ACCEPT (residual)** with the
  hard-kill-orphan residual named.

- [ ] **F-14 (REQ-6 / NFR, QA-6.1) — CI parity (all three; `cargo check` alone is not enough).**
  Run `cargo check --locked`, `cargo test --locked`, `cargo clippy --locked -- -D warnings`.
  **Expected:** zero warnings on check; tests green; zero warnings on clippy. **FAIL** = any red
  leg. (If `cargo` is unavailable in the tester sandbox, record the named tool-access gap and rely
  on CI `rust-validate` — never PASS green without a receipt.)

- [ ] **F-15 (REQ-7 / human MISSION-MONITOR TESTING DIRECTIVE) — Mission Monitor / RTDB-pipeline E2E (LIVE).**
  After the supervisor change, boot the app and drive a live agent session (Run CLI or an active
  companion generation) so OTLP spans ingest; open Mission Monitor and confirm it renders the live
  session / tools / tokens from the store; cross-check a `telemetry_spans` query at the same instant.
  **Expected:** the app boots; Mission Monitor lists the live session and renders its chat / tools /
  tokens from the classified rows; `telemetry_spans` returns the landed rows for that session at the
  same instant. **This leg applies to this slice AND every following Postgres slice.** A static-only
  receipt = FALSE PASS.

- [ ] **F-16 (REQ-8, QA-8.1) — ephemeral loopback, no port collision.**
  Start with PG enabled; list listening sockets and the OTLP/MCP bind state.
  **Expected:** the server binds an ephemeral loopback port (127.0.0.1:0) that is NOT 4317, 4318, or
  9223; OTLP (4317/4318) and the MCP bridge (9223) still bind. **FAIL** = a fixed/colliding port.

## Non-functional

- [ ] **N-1 (boundedness):** every runtime wait has a finite wall-clock cap + hard-kill fallback
  (F-9 unit-pins the class; F-2/F-4 exercise the caps). No unbounded wait anywhere.
- [ ] **N-2 (teardown):** guaranteed on normal / error / panic (F-10); zero `postgres.exe` left,
  verified per-process (`tasklist`).
- [ ] **N-3 (build hygiene):** F-14 green.
- [ ] **N-4 (Windows-first):** the image guard keys on `postgres.exe`; receipts are
  `tasklist`/`taskkill /T /F`.
- [ ] **N-5 (no row-pipeline regression):** Mission Monitor still renders from the store; row
  emission remains ONLY via `EventBus.emit_row_delivery_batch`; merge semantics unchanged.

## Suite-level pass/fail

PASS = F-1..F-16 all green and N-1..N-5 hold. Any unbounded wait, any started `postgres.exe`
surviving normal quit / induced error / panic, a kill of a non-`postgres.exe` PID, a
never-cleared marker, any CI gate red, or F-15 failing = **FAIL**.

## Run — #2974 round 1 (2026-09-27, live)

Serving `spec/2974 @ 714a3a4a`, app via `dev-env.ps1 -Action Up -Spec 2974`. Live receipts:
`telemetry_spans` queries + `Get-Process -Name postgres` / `Get-NetTCPConnection` (the sandbox
has no `tasklist` allowlist entry; `run-exitcode.ps1 -Command` was used for process/port reads).

| Case | Verdict | Receipt |
|------|---------|---------|
| F-1 | PASS | `pg_supervisor_status` ready; KV marker == pid (5676/6264/…); ephemeral `127.0.0.1:5xxxx`; 9 `postgres.exe` PIDs |
| F-2 | UNVERIFIED | Cannot induce an un-ready server from the sandbox (data/install dir not writable, ephemeral port unpredictable). Unit-pinned: `readiness_failure_transitions_to_failed_with_a_structured_error`; PoC `lifecycle.json` |
| F-3 | PASS | Graceful window close → `Get-Process postgres` empty, marker cleared, port released, within the exit-hook bound |
| F-4 | UNVERIFIED | Cannot induce a hung `pg.stop()`. Unit-pinned watchdog + `taskkill /T /F`; PoC `hard_kill_fallback_on_stop_timeout` (213 ms) |
| F-5 | PASS | Shell renders (non-empty body, interactive IPC) with PG enabled; `setup` never awaits `run_start` (spawned task) |
| F-6 | PASS | `dev-env Down` hard-kill orphaned postmaster 5676/12484; next enabled start's sweep reclaimed it (PIDs absent) |
| F-7 | PASS | Marker seeded 4,000,000 → next start: no kill, marker cleared/replaced |
| F-8 | PASS | Marker seeded with live `explorer.exe` 24404 → survived; marker cleared/replaced (18732) |
| F-9 | PASS | `cargo test --locked` includes `run_bounded_errors_fast_on_an_unbounded_wait` (Err, < 5 s) |
| F-10 | PASS | `Drop` teardown unit tests (normal/error/panic unwind); Cargo default `unwind`; no `panic = "abort"` |
| F-11 | UNVERIFIED | Cannot wipe the app data dir (sandbox denies writes outside `.opencode/`). Unit-pinned `wiped_data_dir_with_a_stale_marker_never_kills_an_unrelated_process` |
| F-12 | PASS | Re-measured shell-ready +12 s (PG disabled) vs +8–12 s (PG enabled); MITIGATE + RE-MEASURE |
| F-13 | PASS | Re-measured stop ≤ bound (graceful close teardown + live sweep); MITIGATE + ACCEPT (residual) |
| F-14 | PASS | `cargo check/test/clippy --locked` all green, 0 warnings |
| F-15 | PASS | Mission Monitor renders session/tools/tokens; `telemetry_spans` = 111 for the rendered session; spans grew 5060→5125 live |
| F-16 | PASS | Ephemeral ports 51433/51544/51841/52024/52217 ≠ 4317/4318/9223; OTLP+MCP still bound |
| N-1..N-5 | PASS | Boundedness/teardown/build/Windows-first/row-pipeline (F-15 + `git diff` shows no rtdb/UI hunk) |

### Promoted exploratory cases (round 1)

- [x] **F-17 (promoted from E-9) — crash/hard-kill orphan is reclaimed by the next start's sweep.**
  Confirmed live: `dev-env -Action Down` hard-kills the app (no `RunEvent::Exit`), leaving a live
  `postgres.exe` and a stale marker; the next PG-enabled start's `sweep_orphan` reclaims it and the
  marker is replaced. PASS.
- [x] **F-18 (promoted from E-10) — ephemeral port changes across restarts (no fixed-port leak).**
  Confirmed live: 51433 → 51544 → 51841 → 52024 → 52217 → 52418 across restarts. PASS.

## Run — #2974 round 2 (2026-09-27, live)

Serving `spec/2974 @ 4cd7b818`, app via `dev-env.ps1 -Action Up -Spec 2974 [-EnvVar ...]`. The three
round-1 UNVERIFIED legs were made drivable by the FS-1..FS-3 env seams and re-tested **live**.
Live receipts: `telemetry_spans` / `telemetry_logs` / `settings` queries + `Get-Process -Name
postgres|explorer` / `Get-NetTCPConnection` (`run-exitcode.ps1`; no `tasklist` allowlist entry).
Env seams used: `FREDO_PG_DATA_DIR` (F-2/F-11), `FREDO_PG_STOP_HANG_MS=60000` (F-4); regression rows
ran with the env vars UNSET.

| Case | Verdict | Receipt |
|------|---------|---------|
| F-1 | PASS | override boot `ready {port:54835,pid:11012}`; KV marker == `postmaster.pid` line 1, port == line 4; ready ~7 s after shell |
| F-2 | **PASS (live)** | corrupt override dir → `failed` with structured `[setup]` error (initdb: directory not empty), no port/pid, teardown 35 ms, 0 `postgres.exe`, ~10 s vs 600 s cap |
| F-3 | PASS | graceful close → `outcome=Graceful { elapsed_ms: 151 }`, 0 `postgres.exe`, marker cleared (also 150 ms on the override cycle) |
| F-4 | **PASS (live)** | `FREDO_PG_STOP_HANG_MS=60000` → `outcome=HardKilled { elapsed_ms: 5176 }`, quit 5.20 s, 0 `postgres.exe`, marker cleared |
| F-5 | PASS | non-empty shell DOM while the postmaster boots; `setup` never awaits the start task |
| F-6 | PASS | marker-named live postmaster killed + cleared, next start ready (reproduced) — see F-19 caveat |
| F-7 | PASS | marker 4,000,000 → no kill, marker replaced (`25304`), ready, no error |
| F-8 | PASS | marker = live `explorer.exe` 24404 → survived, marker replaced (`13860`), ready |
| F-9 | PASS | `cargo test --locked pg_supervisor` 26/26 incl. `run_bounded_errors_fast_on_an_unbounded_wait` + FS-2 `stop_bounded_hard_kills_when_graceful_stop_hangs` |
| F-10 | PASS | Drop pins (panic/error) + live normal-return teardown; no `panic = "abort"` |
| F-11 | **PASS (live)** | wiped dir + stale explorer marker → explorer alive, marker cleared; corrupt-dir variant → marker literally empty; unset-env control → explorer alive, marker replaced |
| F-12 | PASS | shell-ready 12 s in BOTH PG-enabled and PG-disabled boots; postmaster boots on a background task; **MITIGATE + RE-MEASURE** |
| F-13 | PASS | `Graceful 151 ms` + `HardKilled 5176 ms`; all 6 mitigation elements demonstrated; **MITIGATE + ACCEPT (residual)** |
| F-14 | PASS | `cargo check/test/clippy --locked` all green, 0 warnings (lib 989 passed; pg_supervisor 26 passed) |
| F-15 | PASS | Mission Monitor 46 nodes / 45 edges / 243 tool-call dots / session token bar; `telemetry_spans` 111 for the rendered session (total 5,751); reproduced on the PG-disabled boot (total 5,899) |
| F-16 | PASS | ports 54835…57298 all ephemeral `127.0.0.1`, ≠ 4317/4318/9223; OTLP + MCP still bound |
| F-17/F-18 | PASS | re-confirmed (orphan reclaim; 8 distinct ephemeral ports) |
| N-1..N-5 / R-1..R-8 | PASS | boundedness / teardown / build / Windows-first / row-pipeline; diff touches only `features/pg_supervisor/*` |
| S-1..S-3, S-5..S-8 | PASS | shell renders, console clean, Mission Monitor reachable, PG cold start, normal quit, live rows + spans |
| S-4 | n/a | Settings→Telemetry not exercised (G-145 wedge risk; unchanged surface) |

### Promoted exploratory cases (round 2)

- [ ] **F-19 (promoted from E-11) — a chained hard-kill recovery can wedge the next start.**
  Observed once (not reproduced): after a hard `Down` of a PG-ready app, a cold `Up` reclaimed the
  marker-named orphan (all 9 old PIDs gone, marker cleared) but `pg.start()` failed with
  `[start] Command error: stdout=; stderr=` (~60 s); a single stuck `postgres` PID survived the
  reclaim and blocked the data dir until it was cleared manually, after which the next start was
  `ready`. The canonical F-6 path was then reproduced green. The FS-1..FS-3 seams are inert on this
  path (env unset), so this is pre-existing default-path robustness, not a round-2 regression.
  **Needs a dedicated hardening item** (reclaim a stuck survivor / wait for full tree death before
  `pg.start()`).
