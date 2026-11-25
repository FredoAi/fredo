# resident-ingest — Functional

Durable functional suite for the **single resident owner** contract: the Fredo desktop process is
the ONE process that owns the embedded PostgreSQL cluster and the ONE binder set of the configured
OTLP receivers. Seeded at issue **#3194**, which DELETED the second boot path (the `fredo ingest`
daemon, the attach mode, the descriptor and the `--run-ms`/`--shutdown-file` seams) and made a
port conflict a **typed** ingest failure on the existing health path.

Supersedes `.opencode/tests/headless-ingest/` (retired — see `retirement-ledger.md` for the row-by-
row disposition). Inherits `.opencode/tests/stream-health/`, `postgres-lifecycle/`,
`postgres-naming/`, `postgres-connection-headroom/`, `resident-shell/`, `background-capture/` and
`fredo-health-led/` on the overlapping surfaces.

> **Verification policy: LIVE** — cluster ownership, the OTLP binder set, a live span and the
> bounded teardown are runtime properties of a running artifact. Every row's receipt references a
> live read (`pg_supervisor_status` / `stream_health` / `telemetry_spans` / the DOM). A static-only
> PASS for a live row is a FALSE PASS. The CLI `emit` path writes **no spans** (G-256) — it is not
> a span producer and is never the live lever here.

> **G-263 SAFETY.** Never run an unbounded binary and never leave an unrecorded child. Every
> launch here is bounded (`dev-env.ps1`, `launch-artifact-probe.ps1`, or
> `otlp-conflict-probe.ps1` with its `-TimeoutSecs`/`-HoldSecs` bounds), and every teardown goes
> through a product-owned or manifest-scoped path.

> **Isolation (G-449 / G-452 / G-470).** Everything runs inside THIS issue's isolated env. The
> env-count-affecting facts are derived from `<env-root>/manifest.json`; an instrument that derives
> a path outside the env root REFUSES (exit 2) rather than falling back to the shared cluster. A
> row whose instrument refuses is an INSTRUMENT failure to report, never a product verdict.

> **Copy contract:** the user-visible strings bound by these rows are the **UI/UX Expert's**
> (`## UI/UX Expert`, Asset 1 + U-1…U-12), not the Architect's draft table: `Port <port> is in
> use` / `Could not start`; `Streaming` / `Telemetry stalled` / `Stream stopped` byte-identical.

---

## Required test data

- **Artifact under test.** `apps/tauri/src-tauri/target/debug/fredo.exe` (the build the env serves;
  `EXE_KIND=debug` disclosed in every receipt). The **release** artifact is named only where an AC
  says "shipped" (F-9's CLI help is checked on the same binary that ships the parser; a release
  build is an acceptable and disclosed substitute — state which was run).
- **Environment.** `.opencode/tmp/envs/spec3194/manifest.json`, brought up with
  `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 3194 -EnvId spec3194 -EnvSlot 1 -RequireIsolation`.
  Ports come from the manifest (`ports.otlpGrpc` / `ports.otlpHttp` / `ports.mcp`); the PG port is
  never guessed (G-307) — it is read from `pg_supervisor_status` and cross-checked against the
  postmaster pid file by `owner-census.ps1`.
- **Instruments (committed, in this folder).**
  - `owner-census.ps1` — read-only owner census (status view + postmaster pid file as the pair;
    the APP pid as a third reading, from the manifest's `processes[] role="app"` or `-AppPid`) +
    teardown census. Exit 0 pass / 1 violation / 2 REFUSED (instrument failure).
  - `otlp-conflict-probe.ps1` — non-destructive OTLP port holder + the repo's one handle-whitelist
    launch; `-DryRun` first (prints the env block, spawns nothing); exit 0 pass / 1 failed drive /
    2 refused.
- **Live span producer (AC2).** `bun .opencode/scripts/inject-otlp-fixture.ts --port <ports.otlpGrpc> --count 1 --prefix e2e-3194-<guid8>`.
  It prints one `EXPORT n/n … -> OK (grpc-status 0)` line, the injected `trace_id`/`span_id`, its own
  **CONFIRM SQL**, and exits non-zero when any export fails. `status_code='UNSET'` in
  `telemetry_spans` is EXPECTED (gate on `end_time_ns IS NOT NULL`).
- **Read lever.** `powershell -File .opencode/skills/telemetry-query/telemetry-query.ps1 -Format md -Manifest .opencode/tmp/envs/spec3194/manifest.json -Query "<SELECT …>"`.
  If the keychain credential is unreachable in the sandbox (G-375), fall back to the app-pool read
  `db_query_execute mode:'all'` and **disclose** the substitution in the receipt.
- **Committed fixture.** `fixtures/otlp-trace-chat.json` (moved here from the retired
  `headless-ingest/fixtures/`; vocabulary retargeted to `fredo-resident-ingest-e2e` /
  `resident-ingest-e2e-session`). Deterministic OTLP/JSON producer —
  `bun .opencode/scripts/inject-otlp-fixture.ts --copilot --fixture .opencode/tests/resident-ingest/fixtures/otlp-trace-chat.json --port <ports.otlpHttp>`.
- **Harness wrappers.** `run-exitcode.ps1` for every exit-code assertion; `verify-env-isolation.ps1
  -ManifestPath <manifest>` for the independent binder reading; `dev-env.ps1` for bring-up/teardown.
- **Webview reads** (`tauri_webview_execute_js`), used verbatim by the rows:
  - status: `(async () => JSON.stringify(await __TAURI__.core.invoke('pg_supervisor_status')))()`
  - probe: `(async () => JSON.stringify(await __TAURI__.core.invoke('stream_health')))()`
  - heartbeat: `new Promise(res => { let done=false; __TAURI__.event.listen('fredo-stream-event', e => { const p=(e&&e.payload)||{}; if(!done && p.streamHealth){ done=true; res(JSON.stringify(p.streamHealth)); } }); setTimeout(() => { if(!done){ done=true; res('TIMEOUT'); } }, 20000); })()`
  - LED row (open the tooltip first — focus/hover `desktop-status-led`):
    `(() => { const el=document.querySelector('[data-testid="health-line-telemetry"]'); if(!el) return 'MISSING'; const ev=[...el.querySelectorAll('[title]')]; return JSON.stringify({ state: el.getAttribute('data-health-state'), text: el.textContent.replace(/\s+/g,' ').trim(), titleCount: ev.length, titles: ev.map(n=>n.getAttribute('title')), whiteSpace: ev.map(n=>getComputedStyle(n).whiteSpace) }); })()`
  - composed label: `document.querySelector('[data-testid="desktop-status-led"]').getAttribute('aria-label')`

> **Row order is a sequence, not a menu (one env per issue — G-316).** F-0, F-1, F-2, F-4 and F-5
> run with the env's own app up. F-3 launches a second copy and quits it (the incumbent must stay
> `ready`). F-11 then quits the env's app (census stopped) and its second leg repeats the census on
> the conflicted instance. F-6…F-8 relaunch ONE conflicted instance with the Vite server still up
> (quit it afterwards). F-9/F-10/F-12 are static/CLI legs and run AFTER `dev-env.ps1 -Action Down`
> (the live env holds `target\debug\fredo.exe`, so a cargo test-target build fails with
> access-denied — G-471).

---

## Cases

- [ ] **F-0 (PREFLIGHT, non-AC) — the two instruments are first-green on this tip (G-406).**
  With the env up:
  (i) `otlp-conflict-probe.ps1 … -DryRun` (F-1's block);
  (ii) `owner-census.ps1 -Manifest <m> -ExpectStopped` **without** `-PgPort`;
  (iii) `owner-census.ps1 -Manifest <m>` (running) **without** `-StatusJson`.
  **Expected:** (i) exits **0** printing every `ENV <NAME>=<value>` line, `CHECK=*_inside_env_root
  =true exists=true` and `RESULT=PASS`; (ii) exits **2** with
  `ERROR=PG_PORT_REQUIRED …`; (iii) exits **2** with `ERROR=STATUS_JSON_REQUIRED …`, and
  (ii)/(iii) each print `CENSUS=REFUSED`. Any other exit code = the instrument is the defect —
  report it as an instrument failure (never as a product FAIL) and do not judge AC1/AC3/AC5 this
  round.
  **Evidence:** the three command lines + their exit codes + the printed lines.
  **Why:** both scripts were authored without an executable shell in the planning phase (G-460);
  this row is the pre-condition that makes their later verdicts attributable.

- [ ] **F-1 (AC1 / R-1a, R-1b) — the GUI start owns the cluster and publishes it.**
  The env's own app (started by `dev-env.ps1 -Action Up`) is running. Read the status, then the
  census running mode.
  Steps: (1) status JS → save the object verbatim to `.opencode/tmp/3194/pg_supervisor_status.json`;
  (2) `powershell -File .opencode/tests/resident-ingest/owner-census.ps1 -Manifest <m> -StatusJson .opencode/tmp/3194/pg_supervisor_status.json`;
  (3) `SELECT 1` through the read lever against `STATUS_PORT`.
  **Expected:** status `state:"ready"`, non-null `pid`, non-null `port`, `error:null`; census exit
  **0** with `CENSUS=PASS`, `CENSUS_PID_STATUS=<n>` and `CENSUS_PID_POSTMASTER=<n>` **both non-empty
  and equal**, `CENSUS_PG_PORT` non-empty; `CLAUSE=status_has_no_attached_key OK`; the `SELECT 1`
  succeeds on that port. `CENSUS=REFUSED` or an empty pid/port pair = INSTRUMENT FAILURE, never a
  PASS (G-469).
  **Edge:** a warm vs a freshly-initialised cluster (first boot after `Clean` may take minutes —
  poll, never re-launch); `port` reading `0`/absent is a re-resolve (G-307), not a FAIL; two
  `postmaster.pid` files under the env root is a FAIL of the one-owner clause.

- [ ] **F-2 (AC1 / R-1b) — exactly ONE owner: one cluster, one binder per port (G-469 pair).**
  Same launch as F-1. Assert the census's cardinality clauses individually and read the clauses,
  not the aggregate.
  **Expected:** `CLAUSE=exactly_one_live_postmaster OK` (`LIVE_POSTMASTER_PID_FILES=1`);
  `POSTMASTER_PROCESS_COUNT_UNDER_ENV_ROOT>=1` and every listed pid belongs to that cluster;
  `CLAUSE=one_pg_listener OK` — `PG_LISTENER_ROWS=1` or `2` (the postmaster legitimately binds
  `127.0.0.1` **and** `[::1]`) with `PG_LISTENER_DISTINCT_OWNERS=1` — and
  `CLAUSE=pg_listener_owned_by_postmaster OK` (owner == the pid BOTH readings named);
  `CENSUS_APP_PID=<n>` non-zero with `CENSUS_APP_PID_SOURCE=manifest processes[] role="app"`
  (or `parameter -AppPid`); `CLAUSE=one_bind_otlp_grpc OK` +
  `CLAUSE=binder_is_app_pid_otlp_grpc OK` (owner == `CENSUS_APP_PID` — the APP, never
  `STATUS_PID`, which is the postmaster); the same two clauses for `otlp_http`;
  `CLAUSE=mcp_listener_owned_by_app_pid OK` (the cross-check that the resolved app pid is the
  process serving THIS env, not a neighbouring one).
  **Independently:** `powershell -File .opencode/scripts/verify-env-isolation.ps1 -ManifestPath <m>`
  exits **0** and prints `OK: <n> env(s) isolated (…)` plus an `ENV spec3194 [live] … ports=
  vite:…,mcp:…,otlpGrpc:<p>,otlpHttp:<p> pids=…` line. That `pids=` line is the source of a
  `-AppPid` if the census ever refuses one.
  **FAIL:** any `CLAUSE=… VIOLATION`, or `verify-env-isolation` exit 1 naming an endpoint bound by
  an unrecorded/foreign PID.
  **Edge:** an empty pair (both readings 0/blank) is an instrument failure; `CENSUS=REFUSED` with
  `ERROR=APP_PID_REQUIRED` (no LIVE `role:"app"` pid in the manifest) or `ERROR=APP_PID_AMBIGUOUS`
  is an INSTRUMENT failure — re-run with `-AppPid <the app pid from verify-env-isolation's
  pids=…>`, never a product FAIL; a *second* env live on the same issue is impossible by lease —
  if one exists, stop and report the environment defect.

- [ ] **F-3 (AC1 / R-1c) — a second instance FAILS on the lock and never adopts the published one.**
  With the env's app healthy (F-1/F-2 green),
  `powershell -File .opencode/tests/resident-ingest/otlp-conflict-probe.ps1 -Manifest <m> -Exe <exe> -Mode second-instance -TimeoutSecs 480`
  (a boot can take minutes — the bound is the readiness budget, not a hang).
  Then attach the MCP driver to the SECOND instance's scanned bridge (`SCANNED_MCP_PORT=` line, or
  `tauri_manage_window action="list"`), read its status, and quit THAT instance through the
  product's own quit path (`quit_app` / tray Quit).
  **Expected:** the probe exits **0** with `INCUMBENT_APP_PID=<n>`, `APP_ALIVE=true`,
  `INCUMBENT_STILL_ALIVE=true`; the second instance's status is `state:"failed"` with a non-empty
  `error` naming the lock (case-insensitive match on `lock`), and `pid`/`port` **null — never the
  incumbent's pid/port**; after quitting the second instance the incumbent is still `ready`, still
  owns the SAME postmaster pid, and the census pair still agrees (`CENSUS=PASS`).
  **FAIL:** a second postmaster appears; the second instance publishes the incumbent's pid/port or
  `state:"ready"`; quitting the second instance disturbs the incumbent's cluster.
  **Edge:** quit the second instance BEFORE reading its status (state is not re-derived) — that is
  a FAILED DRIVE; a `-Mode second-instance` refusal `NO_INCUMBENT` means F-1 was not green.

- [ ] **F-4 (AC2 / R-2a, R-2b) — ONE OTLP receiver entry point, and the app is its only binder.**
  (i) the F-2 census clauses (BINDINGS);
  (ii) static: exactly ONE `otlp::start_with_ports(` call site in `apps/tauri/src-tauri/src/lib.rs`
  and zero `otlp::start(` / `otlp::start_with(` occurrences in the crate;
  (iii) static: no `headless` / `descriptor` module, no `PgState::Attached`, no `run_attach`, no
  `.attached` in product scope (`apps/`), re-run as literal searches over `apps/`.
  (ii)/(iii) are the **ST-2 / ST-1 deliverable pins** (G-409 — the owning sub-tasks author them);
  a pin's title that does not exist yet is NOT cited here.
  **Expected:** (i) all four binding clauses OK; (ii) the search finds exactly 1 `start_with_ports(`
  and 0 of the retired entry points; (iii) 0 hits for every token outside the legacy-VALUE
  allowlist (`autostart.rs` + its tests — F-10).
  **FAIL:** two call sites, a surviving `otlp::start*` wrapper, or any `attached`/`run_attach` hit
  in product code.
  **Edge:** a hit inside a test/comment still counts for `start_with_ports(` (the pin asserts
  cardinality, refusing 0 and ≥2); an English "attached" in unrelated prose is dispositioned, not
  failed.

- [ ] **F-5 (AC2 / R-2c) — a LIVE span lands while the owner runs: replayed history cannot pass.**
  (1) **pre-snapshot:**
  `SELECT count(*) AS n, max(ingested_at) AS newest FROM telemetry_spans` → record `N0`/`NEWEST0`;
  (2) inject:
  `bun .opencode/scripts/inject-otlp-fixture.ts --port <ports.otlpGrpc> --count 1 --prefix e2e-3194-<guid8>`;
  (3) read back the injector's **CONFIRM SQL** (or its `IDENTITY PROBE`) with the read lever;
  (4) post-snapshot: the same count/max query.
  **Expected:** the injector prints `EXPORT 1/1 … -> OK (grpc-status 0)` and exits **0**; the
  CONFIRM query returns exactly 1 row whose `trace_id`/`span_id` are the printed hexes and whose
  `end_time_ns IS NOT NULL`; `ingested_at` is strictly NEWER than `NEWEST0` (when `NEWEST0` is
  NULL, record `NEWEST0=NULL` and accept any non-empty `ingested_at`); `N1 >= N0 + 1`; the status
  is still `ready` and `stream_health` still reports `ingestConnected:true`.
  **FAIL:** zero rows, a row whose `ingested_at` is NOT newer than the pre-snapshot (that is
  replayed history, and it is exactly the defect AC2 names), or any export failure (the script
  exits 1 — do not run the CONFIRM gate).
  **Edge:** G-375 keychain fallback (disclose); a `span_id` primary-key collision (re-inject with a
  fresh `--prefix`); an empty `telemetry_spans` on a fresh cluster (`N0=0`, valid).

- [ ] **F-6 (AC3 / R-3a) — a bound OTLP port is a TYPED failure on BOTH carriers.**
  Sequence (F-11 has already quit the env's app; Vite is still serving):
  (1) `otlp-conflict-probe.ps1 -Manifest <m> -Exe <exe> -Mode conflict -Receiver grpc -TimeoutSecs 480`
  (run `-DryRun` first and paste its block);
  (2) read the probe JS **twice** (immediately, then again after ≥5 s);
  (3) capture the next `fredo-stream-event` heartbeat via the heartbeat JS.
  **Expected:** the probe exits **0** with `HOLD_PROVEN=true`, `APP_READY=true`,
  `TARGET_LISTENER_ROWS=1`, `SIBLING_LISTENER_ROWS=0`, `HOLDER_RELEASED=true`; the probe response
  carries `ok:true`, `ingestConnected:false` and
  `ingestFailure.receiver="grpc"`, `ingestFailure.port=<ports.otlpGrpc>`,
  `ingestFailure.code="addrInUse"`, `ingestFailure.message` non-empty; the heartbeat envelope
  carries the SAME four fields with `ingestConnected:false`; both reads agree (the state is latched
  — a read that clears it is a FAIL against R-6/R-3a).
  **FAIL:** `ingestConnected:true`; `ingestFailure` absent; `code` other than `addrInUse`; the
  heartbeat omits the field while the probe carries it (or vice versa); the probe's
  `SIBLING_LISTENER_ROWS` ≠ 0.
  **Edge:** the second read must still carry the failure (no silent recovery); `SIBLING`/`TARGET`
  owner pids: `TARGET` is the probe's holder (`HOLDER_PID`), never the app's; if the probe refuses
  `APP_STILL_RUNNING`, F-11 was not run first — restart the sequence, do not improvise. **If the
  relaunched window is `about:blank` past the environment's boot budget (3–5 min, a known
  isolated-boot characteristic) or the MCP driver cannot attach to `DERIVED_MCP`, the LAUNCHER could
  not serve the frontend: record a FAILED DRIVE naming `EXE_KIND`/`LOG_DIR`, do not mark AC3 FAIL,
  and route it to the QA Expert to re-cut the lever (the product was never observed).**

- [ ] **F-7 (AC3 / R-3b) — the LED row names the port, and the pinned copy is intact (U-1…U-3, U-10, U-11).**
  Same conflicted launch as F-6. Open the LED tooltip (focus/hover `desktop-status-led`), read the
  LED-row JS and the composed label.
  **Expected:** `data-health-state="degraded"`; `text` contains `Agent telemetry`, `Degraded` and
  `Port <ports.otlpGrpc> is in use` (UI/UX Asset 1 — **not** "Ingest port …"); `titleCount=1` and
  `titles[0]` is exactly `otlp:grpc:<ports.otlpGrpc>:addrInUse · <message>` with
  `whiteSpace="nowrap"`; the overall `desktop-status-led-overall` is `degraded`; the trigger's
  `aria-label` is byte-identical to the no-failure degraded label
  (`Fredo health: Degraded — Agent telemetry: Degraded; …` — the cause is NOT in the live label);
  `role/aria-live/aria-atomic/tabindex` unchanged.
  **FAIL:** any other detail copy, a second `[title]` node (a remedy line), the port missing, the
  receiver (`grpc`/`http`) appearing anywhere except `technicalDetail`, or a changed `aria-label`.
  **Edge:** a >120-char failure message must stay ONE ellipsised line with the full text in
  `title` (U-11); a stale failure decorating a `healthy` line is U-6's unit leg, not this row.

- [ ] **F-8 (AC3 / R-3c) — the sibling receiver can never survive: both legs.**
  Quit the F-6 instance through the product's own quit path, then repeat F-6 with
  `-Receiver http` against the SAME env (Vite still serving).
  **Expected:** leg 2 leaves `SIBLING_LISTENER_ROWS=0` (the gRPC port unbound) and the typed
  failure reads `receiver="http"`, `port=<ports.otlpHttp>`, `code="addrInUse"`, with the LED detail
  `Port <ports.otlpHttp> is in use` and `technicalDetail` `otlp:http:<port>:addrInUse · <message>`.
  **FAIL:** either leg leaves the sibling bound (a half pipeline is the defect being removed); the
  two legs report the same `receiver`; the port in `detail` does not match the failing receiver.
  **Edge:** the holder must be released between legs (`HOLDER_RELEASED=true` in both runs) —
  a leftover listener makes leg 2 refuse `TARGET_PORT_ALREADY_BOUND`.

- [ ] **F-9 (AC4 / R-4a, R-4b) — the CLI no longer has `ingest`, and no product surface offers it.**
  (1) `run-exitcode.ps1 -Command "\"<exe>\" --help"`;
  (2) `run-exitcode.ps1 -Command "\"<exe>\" ingest --help"`;
  (3) `run-exitcode.ps1 -Command "\"<exe>\" ingest"`;
  (4) a literal sweep for `fredo ingest` over the product surface named below.
  **Expected:** (1) exit **0**, the `Commands:` block lists exactly `emit`, `setup`, `open-app`,
  `open-terminal`, `doom`, `companion` and contains **no** `ingest` token, and no
  `--run-ms`/`--shutdown-file`/`--grpc-port`/`--http-port` appears anywhere in it; (2) exit **1**
  with a clap unknown-subcommand error (`unrecognized subcommand` / `unexpected argument`) — NOT a
  help page, NOT exit 0; (3) exit **1** with the same class of parse error; (4) zero hits for the
  literal `fredo ingest` in `docs/CLI_GUIDE.md`, `docs/SETUP.md`, `docs/SECURITY.md`,
  `docs/ARCHITECTURE.md`, `docs/FAQ.md`, `apps/ui/src/**`, `apps/tauri/src-tauri/src/**`, outside
  the named allowlist: the two legacy-VALUE migration sentences (the `CLI_GUIDE.md` "Login
  auto-start" note and the `SETUP.md` "Auto-start at login" paragraph — both narrate the stored
  registry VALUE an older install left behind, kept byte-identical and owned by #3196 ST-5),
  `applications/settings/autostart.rs` (+ its tests),
  `applications/ingest/__tests__/IngestAutostartSettings.test.tsx` (its RETIRED_COPY list),
  `.opencode/tests/**` (this suite spells the retired token deliberately — G-431), and historical
  `docs/agentic-pipeline/**`.
  **FAIL:** `ingest` in `--help`; exit 0 for `ingest --help`; any product doc/source hit outside
  the allowlist.
  **Edge:** a hit in a comment/narration that describes the legacy registry VALUE is dispositioned
  (F-10), not failed — but it must not present the command as a way to capture.

- [ ] **F-10 (AC4 / R-4c) — the legacy registry VALUE is still recognised, and the login entry is
  still `--background`.**
  (1) `run-exitcode.ps1 -Command "cargo nextest run --manifest-path apps/tauri/src-tauri/Cargo.toml autostart"`
  (env Down first);
  (2) read `applications/settings/autostart.rs` for `matches_legacy_ingest`,
  `RunEntryClass::OwnedLegacy` and `background_launch_command`.
  **Expected:** (1) exit **0**, and the summary names the green
  `no_production_code_path_builds_the_ingest_command` pin (verbatim title — `autostart.rs:620`);
  (2) both symbols still exist unchanged and the builder still emits `"<exe>" --background`; the
  stored value `<exe> ingest` is still CLASSIFIED (migrated in place) — removing the command must
  not remove the value classifier.
  **FAIL:** the pin deleted/weakened; the classifier removed; the entry emitting the `ingest` form.
  **Edge:** the seeded legacy value round-trip belongs to `background-capture/` F-2/F-3 — this row
  only asserts retention + the pin.

- [ ] **F-11 (AC5 / R-5a) — bounded quit, and the cluster's port really closes.**
  Leg A (env's app, F-1/F-2 already recorded): quit through the PRODUCT's own path
  (`quit_app` invoke — the same one the tray `Quit` item dispatches; the physical tray click is
  disclosed as unavailable), time it, then
  `owner-census.ps1 -Manifest <m> -ExpectStopped -PgPort <CENSUS_PG_PORT from F-1>`.
  Leg B: after F-6/F-7/F-8 reads, quit the conflicted instance the same way and re-run the same
  stopped census.
  **Expected:** the app process exits within the documented exit bound (`RunEvent::Exit` →
  `stop_on_exit`, `PG_EXIT_HOOK_BOUND` + hard-kill fallback) — record the measured seconds; the
  stopped census exits **0** with `CENSUS=PASS`, `PRIOR_PG_PORT=<n>` non-zero,
  `PG_LISTENER_ROWS=0`, `OTLP_GRPC_LISTENER_ROWS=0`, `OTLP_HTTP_LISTENER_ROWS=0`,
  `LIVE_POSTMASTER_PID_FILES=0`, `POSTGRES_PROCESS_COUNT_UNDER_ENV_ROOT=0`.
  **FAIL:** the quit exceeds the bound; ANY `CLAUSE=… VIOLATION`; the port that F-1 named is still
  listening; a `postgres.exe` under the env root survives.
  **Edge:** an orphan `postgres.exe` left by an EARLIER `dev-env Down` is a G-280 environment
  artifact — it is reported with its pid and start time, and only a process whose command line
  names THIS env root counts; `-PgPort` absent is `CENSUS=REFUSED` (never a pass on "port 0 is
  closed").

- [ ] **F-12 (AC5 / R-5b) — the hand-off seams are absent from the product path AND its CLI help.**
  (1) literal searches over `apps/tauri/src-tauri/src` for each token: `FREDO_INGEST_RUN_MS`,
  `FREDO_INGEST_SHUTDOWN_FILE`, `FREDO_INGEST_STOP_BOUND_MS`, `FREDO_INGEST_DESCRIPTOR`,
  `HEADLESS_DESCRIPTOR_FILENAME`, `FREDO_IMAGE`, `headless-ingest.json`, `run_ingest_daemon`,
  `IngestDaemonArgs`, `ShutdownCause`, `DaemonCleanup`, `--run-ms`, `--shutdown-file`;
  (2) the module files `applications/pg_supervisor/headless.rs`, `…/descriptor.rs`,
  `infrastructure/cli/commands/ingest.rs` and the integration test
  `apps/tauri/src-tauri/tests/headless_ingest.rs` do not exist;
  (3) F-9(1): `--help` names none of the seams.
  **Expected:** zero hits for every token; all four files absent; `--help` clean.
  **KEPT — must still be present (assert positively, so an over-delete fails):**
  `FREDO_INGEST_GRPC_PORT` / `FREDO_INGEST_HTTP_PORT` in `infrastructure/env.rs`,
  `matches_legacy_ingest`, and `tests/spike_2989_headless_ingest.rs` (the in-process PoC;
  G-281/G-290 forbid deleting it).
  **Edge:** a dead doc comment in `lib.rs` that still SAYS "headless" is a disposition item (the
  comment sweep is ST-1(ii)), not a token hit — report it rather than silently passing.

---

## Non-functional

- [ ] **N-1 (boundedness, G-263):** every wait in the exercised paths has a finite cap plus a
  hard-kill fallback; the conflict probe's `-TimeoutSecs`/`-HoldSecs` bounds are honoured; the
  census's one native read is bounded. An observed unbounded wait is a FAIL, not a skip.
- [ ] **N-2 (teardown):** after the final `dev-env.ps1 -Action Down -EnvId spec3194` (then
  `-Action Clean`), no `fredo`/`postgres` process and no listener under the env root remains; the
  census stopped mode is the receipt.
- [ ] **N-3 (loopback-only):** PG ephemeral `127.0.0.1`; OTLP `127.0.0.1:<grpc>/<http>`; never
  `0.0.0.0` (netstat rows for the four endpoints all show a `127.0.0.1:` local address).
- [ ] **N-4 (build/CI parity, G-282 + #3151):** `cargo check --locked`,
  `cargo clippy --locked -- -D warnings` (CI form, NO `--all-targets`),
  `cargo nextest run --locked --no-run` (the test-target COMPILE — check/clippy do not compile
  test targets), `cargo nextest run --locked` (primary runner; `cargo test --lib` reports the
  known false `BackendAlreadyInitialized` module failures), `pnpm --filter @fredo/ui build`. All
  zero-warning/green. Env Down for the Rust legs (shared `target\debug\fredo.exe`).
- [ ] **N-5 (no row-pipeline change):** `git diff origin/main <spec-branch> -- apps/tauri/src-tauri/src/infrastructure/rtdb`
  touches ONLY `health.rs` (the additive `ingestFailure` slot/fields); classifier, merge, flush and
  retention are untouched; `stream-health/` F-1/F-2/F-3 pins stay green.

## Suite-level pass/fail

PASS = F-0…F-12 green **and** N-1…N-5 hold, with a `telemetry_spans` live read in the receipt
(F-5) and the LED `data-health-state` captures for F-7/F-8. FAIL = a second owner/binder, a
surviving sibling receiver, a `healthy`/`ingestConnected:true` read under a bound port, a surviving
orphan postmaster, `ingest` reachable from the CLI, or a static-only receipt for a live row.
Every UNVERIFIED row carries a named, actionable blocker (G-053).

## Rows UNVERIFIED by design (state these in the verdict)

- **`bindFailed`** (the residual code) has **no live inducer** this spec — a fault-injection seam
  would be new product surface. Bound at unit level by U-4/U-6/U-7 (`fredoHealth.test.ts`, ST-3's
  deliverable). The live instrument discriminates `addrInUse` only.
- **A foreign/out-of-date `attached` payload** (U-8) is **unproducible from the shipped backend**
  after ST-1 deletes the state; bound at unit level (the normalizer + `postgresLine`), plus the
  live DOM absence assertion (`attached` appears in no rendered line).
- **The physical tray click** is not synthesizable; F-11/quit drives `quit_app` (the same
  `ensure_main_window`/`quit()` the tray items dispatch) and discloses the substitution.
