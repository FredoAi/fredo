# resident-shell — Functional Tests

> Durable functional suite for the **resident single-instance shell** (issue #3192): closing the
> main window destroys its webview while the process keeps capturing; a native tray offers exactly
> `Open` and `Quit`; `Quit` runs the bounded teardown; a second launch focuses the resident instance
> instead of starting a second stack; a separate application window survives; a reopen restores the
> persisted workspace with no restart.
>
> **Verification policy: LIVE.** Every row below (F-1…F-6) asserts a runtime observable of a running
> artifact — a close sequence, a resident process, a `Menu` read-back, a second launch, a
> `telemetry_spans` row written with no webview, a rehydrated workspace. A static-only PASS for
> F-1…F-6 is a FALSE PASS. The only `static` rows in this suite are regression negatives RT-1/RT-2
> (`regression.md`).
>
> **Names are BOUND** (`triage.md` `## Software Architect` / `## QA Expert`): tray ids `tray-open` /
> `tray-quit` (labels exactly `Open` / `Quit`); commands `open_main_window`, `app_lifecycle_status`,
> `quit_app`; state `ResidentShellState.tray_installed`; IPC wire `{"type":"open_main_window"}`;
> single-instance mechanism = the per-environment IPC pipe (NOT `tauri-plugin-single-instance`);
> exit policy at `RunEvent::ExitRequested`: prevent only when `code: None` **and** `tray_installed`.

## How these rows are driven (read once before executing)

All webview-side levers use the v2 invoke path from a live window:

```
tauri_webview_execute_js(script="(() => window.__TAURI_INTERNALS__.invoke('<command>'))()")
```

- `app_lifecycle_status` → `{ mainWindowOpen, trayItems }` (tray items read back from the REAL
  `Menu` via `Menu::items()` → `MenuItem::text()`, not a constant).
- `open_main_window` → `{ recreated, focused }` — the SAME `ensure_main_window` the `tray-open`
  item dispatches.
- `quit_app` → the SAME `quit()` (`AppHandle::exit(0)`) the `tray-quit` item dispatches.
- `pg_supervisor_status` → `{ state, port, pid, dataDir, attached, … }` (`pid` = postmaster PID
  while `Ready`).
- **Close the main window through the runtime close path:**
  `…invoke('plugin:window|close', { label: 'main' })` — `Window::close()` emits
  `RunEvent::CloseRequested` then destroys (capability `core:window:allow-close` is granted to
  `main`/`terminal`/`doom`/`app-*` in `capabilities/default.json`). The physical titlebar X is not
  synthesizable — disclosed, see the blocker list.
- Main-window presence/absence: `tauri_manage_window(action="list")`. A destroyed window leaves the
  list; a hidden window would still be listed.
- Process truth: `powershell -File .opencode/scripts/process-hygiene.ps1 -List` (global) and
  `powershell -File .opencode/scripts/run-exitcode.ps1 -Command "powershell -File .opencode/tests/resident-shell/lifecycle-probe.ps1 -Action Inventory -ManifestPath <manifest>"` (env-scoped).
- **The env-scoped postmaster rows are matched against the PostgreSQL CLUSTER dir, not the app-data
  dir.** The probe prints `PG_DATA_DIR=` (default `<env-root>/postgres`, `dev-env.ps1:733,1535,1553`)
  and `PG_DATA_DIR_SOURCE=manifest`, or the `-PgDataDir` you pass (`PG_DATA_DIR_SOURCE=product`,
  normally `pg_supervisor_status.dataDir`). Read a `POSTMASTER_COUNT=0` as evidence ONLY when the
  same output shows `PG_DATA_DIR_EXISTS=True` — `ERROR: probed PG data dir does not exist: <path>` is
  a FAILED DRIVE (fix the path, re-probe), never a "no postmaster" reading. While the cluster is up
  the non-vacuity control is `POSTMASTER_COUNT >= 1` **and** `PG_POSTMASTER_PIDFILE_MATCH=True` (the
  probe cross-checks `postmaster.pid` and hard-fails if it names a live postgres the predicate
  missed). `ports.pg` is a constant `0` in the manifest, so the probe prints `PG_PORT=unrecorded`;
  the live PG port is `pg_supervisor_status.port`.
- **Manifest keys are read only by `manifest-facts.ps1`** (dot-sourced by all three scripts; shipped
  names `pipe`, `webviewProfile`, `dataDir`, `envId`, `servedCommit`, `ports.*`, `processes[]`). There
  is no `cliPipe` / `webviewDir` key, and no alias is added: a second key for one value is a second
  artifact pinning the same text.
- `telemetry_spans` / `chat_rows` reads (primary):
  `powershell -File .opencode/skills/telemetry-query/telemetry-query.ps1 -Manifest <env-root>/manifest.json -Format md -Query "<SELECT>"`.
  **G-375 fallback** (keychain auth unreachable in an isolated env): the app's `db_query_execute`
  from a surviving window with the env's saved connection — disclose the substitution verbatim.

One command per shell call (no `;`, `|`, `&&`). Anything needing a sequence runs from a committed
script through `run-exitcode.ps1`.

## F-1 (R-1 / AC1) — X closes the window, the process stays, capture continues

- [ ] **F-1a — close destroys the window and the process stays resident.**
  Record beforehand: app PID (`manifest.processes[] | role -eq 'app'`), `pg_supervisor_status.pid`,
  `tauri_manage_window(action="list")`, and `SELECT COUNT(*), MAX(ingested_at) FROM telemetry_spans`.
  Open a `terminal` window (`open_terminal_window`). Close `main` with `plugin:window|close`.
  Then re-read the window list, `app_lifecycle_status` (from the surviving window), and the
  env-scoped inventory twice — immediately and 30 s later.
  **Expected:** `main` is ABSENT from `tauri_manage_window(action="list")`; `terminal` remains
  listed; `app_lifecycle_status.mainWindowOpen === false`; the `fredo.exe` PID is UNCHANGED and
  alive 30 s after the close; the postmaster reading is unchanged **and non-vacuous** — the
  `-Action Postmaster -ManifestPath <manifest>` probe (run before the close and 30 s after) reports
  `PG_DATA_DIR=` with `PG_DATA_DIR_EXISTS=True`, `POSTMASTER_COUNT >= 1` and
  `PG_POSTMASTER_PIDFILE_MATCH=True` on BOTH reads, with identical `POSTMASTER_PIDS`. An empty pair,
  a `POSTMASTER_COUNT=0`, or `ERROR: probed PG data dir does not exist` is a **FAILED DRIVE of this
  clause**, never a `0 == 0` pass.
  **Edge:** close while minimized; close while a capture is streaming.

- [ ] **F-1b — a `telemetry_spans` row persists AFTER the close (the decisive leg).**
  With `main` destroyed, run
  `bun .opencode/scripts/inject-otlp-fixture.ts --prefix e2e-resident3192-<guid8> --count 1 --port <manifest ports.otlpGrpc>`
  and then
  `powershell -File .opencode/scripts/run-exitcode.ps1 -Command "powershell -File .opencode/tests/resident-shell/emit-row.ps1 -ManifestPath <manifest> -SessionId e2e-resident-<guid8>"`.
  Read the store:
  `SELECT span_id, trace_id, session_id, span_name, transport, end_time_ns, ingested_at FROM telemetry_spans WHERE attributes_json LIKE '%e2e-resident3192-<guid8>%' ORDER BY ingested_at DESC`
  and `SELECT session_id, correlation_id, state, user_message, agent_reply FROM chat_rows WHERE session_id = 'e2e-resident-<guid8>'`.
  **Expected:** exactly ONE span row, `end_time_ns IS NOT NULL`, and **`ingested_at` LATER than the
  recorded close timestamp** (a pre-close row cannot pass — the trace/span ids are fresh per run);
  the `chat_rows` row exists with non-empty `user_message` AND `agent_reply`.
  The injector prints per-span `CONFIRM` SQL with both hex ids — paste it verbatim.
  **Edge:** G-375 auth failure ⇒ `db_query_execute` fallback, disclosed; injection while a second
  capture is streaming.

- [ ] **F-1c — reopening renders the rows persisted while closed.**
  `invoke('open_main_window')`, then open Mission Monitor in the recreated `main` and look at the
  session history + canvas.
  **Expected:** the `e2e-resident-<guid8>` session renders (history list entry, or — if the
  pre-existing rollup listability limitation applies — the canvas node carrying the fixture's
  `agentReply` sentinel; record which surface rendered it) and the reopened window's console has no
  `Error:`/`Uncaught`/`Maximum update depth exceeded`.
  **Edge:** reopen twice — the row is not lost on the second reopen.

## F-2 (R-2 / AC2) — the tray offers Open and Quit; Open recreates + focuses

- [ ] **F-2a — menu content read back from the real `Menu`.**
  With `main` open: `invoke('app_lifecycle_status')`.
  **Expected:** `trayItems` is EXACTLY `[{"id":"tray-open","label":"Open"},{"id":"tray-quit","label":"Quit"}]`
  in that order — two actionable items, no third entry, no status row, labels verbatim `Open`/`Quit`;
  `mainWindowOpen === true`. (The tooltip/accessible name is a Rust value — recorded from the
  `tray_tooltip` unit pin; not shell-readable.)
  **Edge:** none — the read is idempotent.

- [ ] **F-2b — Open recreates `main` with the same identity and focuses it.**
  After F-1a (main destroyed): `invoke('open_main_window')` from the surviving `terminal` window.
  **Expected:** `{ recreated: true, focused: true }`; `tauri_manage_window(action="list")` shows
  `main` again with the per-env title `Fredo [<envId>]` (legacy `Fredo` on slot 0), `index.html`,
  and the configured 1400×900 / min 900×600 / maximized geometry; the recreated webview answers
  `execute_js` immediately.
  **Edge:** rebuild while `main` is minimized (unminimize then focus — never a second window).

- [ ] **F-2c — Open on a live window is idempotent (no second `main`).**
  With `main` open, invoke `open_main_window` twice in a row.
  **Expected:** `{ recreated: false, focused: true }`; exactly ONE `main` in the window list after
  both calls; console clean.

## F-3 (R-3 / AC3) — Quit runs the bounded teardown, no orphan postmaster

- [ ] **F-3 — quit_app ends the process and leaves no postmaster (the <= 30 s clause is REQUIRED this
  round — it is drivable, not a blocker).**
  **Before quitting**, record: `pg_supervisor_status.{pid,port,dataDir}` (postmaster PID + the cluster
  dir the product actually uses), the app PID (manifest `processes[] | role -eq 'app'`),
  `lifecycle-probe.ps1 -Action Descendants -TargetPid <appPid>`, and the wall-clock
  `Get-Date -Format o` (call it T0, one shell call).
  `invoke('quit_app')`. Then poll `tasklist /FI "IMAGENAME eq fredo.exe" /FO CSV` every ~2 s (one
  shell call per sample) and STOP at the first sample that no longer lists the app PID — call that
  wall-clock T1. Then run:
  `powershell -File .opencode/scripts/process-hygiene.ps1 -List`, then
  `run-exitcode.ps1 -Command "powershell -File .opencode/tests/resident-shell/lifecycle-probe.ps1 -Action Postmaster -PgDataDir <recordedDataDir>"`
  (substitute the pre-quit `pg_supervisor_status.dataDir` for `<recordedDataDir>`; it carries no
  spaces, so the inner command needs no quotes), and then
  `run-exitcode.ps1 -Command "powershell -File .opencode/tests/resident-shell/lifecycle-probe.ps1 -Action Port -PortNumber <ports.mcp>"`
  for the bridge port.
  **Expected:** paste `QUIT_SECONDS=` (T1 minus T0) — it is **<= 30**, and the `fredo.exe` PID is
  GONE in that window (>30 s with no completion is a FAIL, not a skip); the postmaster probe reports
  `PG_DATA_DIR_SOURCE=product` with `PG_DATA_DIR_EXISTS=True`, `POSTMASTER_COUNT=0` and
  `POSTMASTER_PIDS=` EMPTY — specifically, the pre-quit postmaster PID is ABSENT; no `postgres.exe`
  whose command line references that cluster dir remains (`POSTGRES_TREE_COUNT=0`); the MCP bridge
  port has an empty `PORT_LISTENER_PIDS`; no new orphaned child of the former app PID.
  **Instrument rules:** a zero counts ONLY next to `PG_DATA_DIR_EXISTS=True` —
  `ERROR: probed PG data dir does not exist: <path>` is a FAILED DRIVE (re-probe with the recorded
  `-PgDataDir`), never a "no postmaster" reading. Never probe `ports.pg` (the manifest writes it as a
  constant `0`; the probe prints `PG_PORT=unrecorded`). A clean quit does not delete the cluster dir,
  so an absent dir means the PATH is wrong — not that PG stopped.
  **Edge:** quit while `main` is destroyed; quit while `main` is visible; quit while a terminal
  session is mid-command (E-3); quit twice (second is a no-op).

## F-4 (R-4 / AC4) — a second launch focuses, never a second owner

- [ ] **F-4** — run
  `powershell -File .opencode/scripts/run-exitcode.ps1 -Command "powershell -File .opencode/tests/resident-shell/second-launch.ps1 -ManifestPath <manifest> -Exe apps/tauri/src-tauri/target/debug/fredo.exe"`.
  The script reads the env manifest through `manifest-facts.ps1` (shipped keys `envId`, `dataDir`,
  `pipe`, `webviewProfile`, `ports.*`) and injects that env's `FREDO_ENV_ID` / `FREDO_CLI_PIPE` /
  `FREDO_DATA_DIR` / `FREDO_WEBVIEW_PROFILE_DIR` / `FREDO_INGEST_GRPC_PORT` / `FREDO_INGEST_HTTP_PORT`
  / `FREDO_MCP_BASE_PORT` / `FREDO_VITE_PORT` into the child, launches the debug binary once, and
  prints machine-readable receipts.
  **Expected:** `SECOND_EXITED=True` with `SECOND_EXITCODE=0`; the second PID is gone;
  `PRIMARY_ALIVE=True`; `NEW_FREDO_PIDS=` EMPTY and `FREDO_PIDS_AFTER` identical to
  `FREDO_PIDS_BEFORE` (no `fredo.exe` appeared after the second launch);
  **`POSTMASTER_BEFORE` and `POSTMASTER_AFTER` are BOTH NON-EMPTY and IDENTICAL** — the script prints
  `PG_DATA_DIR=` / `PG_DATA_DIR_SOURCE=` right beside them; **a blank pair is a FAIL of this row, not
  a pass**, and the env must be UP (the script exits 1 with `no postmaster found ... before the
  second launch` when it is not); `RESULT=PASS` and exit 0. Exit 2 means the INSTRUMENT failed
  (`ERROR: ...` line above it: manifest key missing, probed PG dir absent) — record it as a failed
  drive, never as a product FAIL. Also: exactly one listener per OTLP gRPC/HTTP port, owned by the
  primary PID; the second launch opened NO second window; the first instance's `main` is present and
  focused. Corroborate the count with `process-hygiene.ps1 -List`.
  **Edge (the discriminator):** run the same script with `main` DESTROYED — the first instance must
  recreate + focus it. Then boot a DIFFERENT env (`-Action Up -Spec 3192 -EnvId spec3192-b -EnvSlot <n>`)
  and show BOTH apps stay resident (the guard is per-pipe, not global). That second-env half needs a
  second environment and is the same probe as `exploratory.md` **E-2**, which is a legitimate
  non-binding NAMED BLOCKER this round — if no second env is up, record the blocker there, never a
  FAIL of this row.
  **Edge:** two second launches back-to-back.

## F-5 (R-5 / AC5) — a separate application window survives the main window's close

- [ ] **F-5 — a separate application window survives the main window's close (the Terminal PTY leg
  is REQUIRED this round — it is drivable, not a blocker).**
  1. `…invoke('open_terminal_window')` → note the new window label `terminal`
     (`tauri_manage_window(action="list")`).
  2. Re-point the driver at `terminal` (`tauri_driver_session stop`, then `start`;
     `open_terminal_window` opens the window only — a session must be spawned explicitly).
  3. In `terminal`: `…invoke('spawn_terminal_session', { cli: 'shell', cols: 120, rows: 30 })` →
     paste the returned session id. `cli` is the `SessionKind` wire value — `shell` / `opencode` /
     `copilot`; `shell` (a plain OS shell) needs no agent credentials, so use it.
  4. `…invoke('list_terminal_sessions')` → paste the array; that session id is listed with
     `status: "running"` and a non-null `pid`. Record the `pid` + `startedAt`.
  5. `…invoke('get_pty_buffer', { sessionId: '<id>' })` → this returns a BYTE ARRAY; paste its
     `bufferLength` plus the first ~40 decoded characters.
  6. Close `main` (`plugin:window|close`, label `main`) and re-point the driver at `terminal` again
     if the close detached it (`tauri_manage_window(action="list")` says which labels remain).
  7. `tauri_webview_execute_js(script="1+1")` in `terminal` (a trivial round-trip), then repeat
     steps 4 and 5.
  **Expected:** `main` is ABSENT from `tauri_manage_window(action="list")` while `terminal` is still
  listed and its webview still answers `tauri_webview_execute_js`; `list_terminal_sessions` still lists the SAME
  session id with the SAME `pid` and `startedAt` (a re-spawn/replacement is a FAIL — the process must
  survive, not restart) and `status` still `running`; `get_pty_buffer` returns a byte array with
  `bufferLength > 0` (an `"Unknown session: <id>"` error string is a FAIL); the `fredo.exe` PID is
  unchanged; no dialog, no exit.
  **Alternative window:** an `app-<id>` window from the launcher grid satisfies the "second window"
  half, but only the `terminal` window can close the PTY leg — drive the terminal leg.
  **Edge:** the terminal is running a command when `main` closes; two application windows open;
  a `doom` window open; then close the application window itself (it closes only itself, the process
  stays resident).

## F-6 (R-6 / AC6) — reopen restores persisted workspace/window state, no restart

- [ ] **F-6a — geometry parity with a cold launch, same PID.**
  Record the pre-close `tauri_manage_window(action="list")` entry for `main`; close; reopen.
  **Expected:** the recreated `main` entry matches (label `main`, `index.html`, 1400×900, min
  900×600, maximized); the PID is the SAME process as before the close.

- [ ] **F-6b — persisted workspace restored (zone assignment + zoned window + preferences).**
  Before the close, from `main`, seed the product's own control plane:
  `…invoke('save_setting', { key: 'Fredo_layout_zones', value: '<versioned JSON string>' })` with

  ```json
  {"version":1,"enabled":true,"activeLayoutId":"l1","layouts":[{"id":"l1","name":"QA","template":"columns","zones":[{"id":"z0","rect":{"x":0,"y":0,"width":0.5,"height":1}},{"id":"z1","rect":{"x":0.5,"y":0,"width":0.5,"height":1}}]}],"gap":8,"chord":"alt","assignments":[{"windowId":"mission-monitor","layoutId":"l1","zoneId":"z0"}]}
  ```

  Also apply a non-default theme preset (Settings → Appearance). Close `main`, reopen it.
  **Expected:** after the reopen `mission-monitor` is OPEN, un-maximized into the LEFT half
  (`x ≈ 0`, `width ≈ 50 %` of the workspace) through the boot hydration path
  (`Home.tsx` `reopenZonedWindows`), the zone overlay renders layout `l1`, and the theme preset
  re-applies from the store (`body` token / `--accent-primary` equals the pre-close value).
  **Edge:** a stored assignment naming an unregistered window id (degraded placeholder, no crash);
  `enabled:false` (nothing reopens, main still restores); a `version:2` or zero-zone document
  (store stays on its clean default, no crash). If `save_setting` rejects the document
  (`validate_setting_value`), seed through the shipped Layout settings UI instead and record the
  substitution — never edit a database row by hand.

- [ ] **F-6c — no false "No sessions" on a recreated webview.**
  Immediately after the reopen, open Mission Monitor and poll its DOM every 250 ms for 2 s.
  **Expected:** `No sessions yet` is ABSENT in EVERY sample, and the `e2e-resident-<guid8>`
  session appears in at least one sample. The gate that makes this true is the shipped one:
  `settled = !read.loading || watch.ready` (`useSessionHistory.ts`), the placeholder at
  `SessionHistoryDrawer.tsx:517`, and the `useEventRows` `ready` replay marker
  (`useEventRows.ts:91-102,222`). No `Maximum update depth exceeded` in the reopened window.
  **Edge:** a genuinely empty store (no session for the env) ⇒ `No sessions yet` is then CORRECT
  and must appear once `settled` (this is the control that proves the string is not simply
  suppressed everywhere).
  **Note:** a sub-frame flash is not observable at 250 ms — disclosed, not asserted.

## Non-functional

- [ ] **N-1 (destroyed, not hidden).** After the close: `main` absent from
  `tauri_manage_window(action="list")` (a hidden window is still listed — the structural proof);
  `lifecycle-probe.ps1 -Action WebviewCount -ManifestPath <manifest>` before/after (the
  `msedgewebview2.exe` count descended from this env's `fredo.exe` DROPS);
  `tasklist /FI "IMAGENAME eq fredo.exe" /FO LIST` (Mem Usage) does not grow.
  **Both process figures are PROXIES for "the JS heap was released" — no memory profiler exists in
  the tester toolset and none is claimed.** A hidden-window baseline is NOT available in this slice
  (no hide path ships) — stated as a limitation, never a FAIL.
- [ ] **N-2 (live receipt).** Verbatim `telemetry_spans` output from F-1b with `ingested_at` after the
  recorded close timestamp, plus one live `tauri_webview_*` / `tauri_manage_window` result, pasted
  into `## Tests Runs`. A static-only PASS is a FALSE PASS.
- [ ] **N-3 (no new OS surface).** No service, no elevation, no login item, no new listener; the ONE
  tray icon is the only new OS resource (RT-7).
- [ ] **N-4 (build gates, env DOWN).**
  `powershell -File .opencode/scripts/run-exitcode.ps1 -Command "cargo check --manifest-path apps/tauri/src-tauri/Cargo.toml"`,
  `… -Command "cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml"`,
  `… -Command "pnpm --filter @fredo/ui build"` — all `EXITCODE=0`, zero warnings, no new `#[allow(...)]`.
- [ ] **N-5 (boundedness, G-263).** Every start/stop/close/quit/second-launch leg is wall-clock
  bounded (Env Up ≤180 s, quit probe ≤30 s, second launch ≤20 s) with a hard-kill fallback; an
  observed unbounded wait is a FAIL, not a skip.
- [ ] **N-6 (console hygiene — REQUIRED this round, drivable, not a blocker).** Read the console
  TWICE, after the F-1c reopen and after the F-5 terminal leg, re-pointing the driver each time
  (`tauri_driver_session stop` → `start`; `tauri_read_logs` reads the CURRENTLY TARGETED webview):
  (a) on the RECREATED `main`: `tauri_read_logs(source="console", lines=50)` — this is also smoke
  `S-2`;
  (b) on the SURVIVING `terminal`: `tauri_read_logs(source="console", lines=50)`.
  **Expected:** neither read contains `Error:` / `Uncaught` / `Maximum update depth exceeded`. Paste
  both reads (or the last 5 lines of each when clean) with the window label beside each. A
  `tauri_read_logs` failure against a non-`main` window is a TOOLING finding to disclose — it does
  not convert the row into a silent pass.

## Suite-level pass/fail

PASS = F-1a…F-6c all green **and** N-1…N-6 hold **and** the `regression.md` RT rows hold.
FAIL = any second `fredo.exe`/postmaster for one env; a duplicate `main` window; a span row that
cannot be shown to post-date the close; an orphan postmaster after quit; a `No sessions yet` sample
in F-6c; a static-only receipt for any of F-1…F-6; a blank `POSTMASTER_BEFORE`/`POSTMASTER_AFTER`
pair (or a `POSTMASTER_COUNT=0` without `PG_DATA_DIR_EXISTS=True`) read as "unchanged".
UNVERIFIED requires a NAMED, actionable blocker (G-053) — never a silent drop.

## Required test data

- Env: `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 3192 -EnvId <id> -EnvSlot <n>`
  (`<id>` from `.opencode/state/env-leases/3192.json`); ports and the app PID from
  `.opencode/tmp/envs/<id>/manifest.json`; driver `appIdentifier` = `ports.mcp` as a decimal string.
- `inject-otlp-fixture.ts` (committed; random trace/span ids per run).
- `emit-row.ps1` + `fixtures/chat-payload.json` (a QUALIFYING chat row: non-empty `userMessage` AND
  `agentReply`; the classifier reads those exact keys — `rtdb/ingest.rs` chat patch).
- `lifecycle-probe.ps1`, `second-launch.ps1`, `emit-row.ps1` (all in this folder, run through
  `run-exitcode.ps1`) and the shared `manifest-facts.ps1` they dot-source (the ONE manifest-key
  vocabulary — `pipe`, `webviewProfile`, `dataDir`, `envId`, `servedCommit`, `ports.*`,
  `processes[]` — plus the cluster-dir derivation `<env-root>/postgres` and the postmaster
  predicate). The probe's `-PgDataDir` accepts `pg_supervisor_status.dataDir` when the manifest is
  not under `<env-root>`.
- `Fredo_layout_zones` document (F-6b) via `save_setting` — the product control plane, not a new store.
- Screenshots under `.opencode/tmp/3192/e2e/` (bonus only; upload via
  `rust-script .opencode/scripts/pipeline-state.rs --issue 3192 --agent tester --action upload-evidence --image <path>`).

## Evidence rules

- Every cited artifact must be a NON-DRAFT durable record — the posted `## Tests Runs` comment, a
  committed path, or a `user-attachments` URL (G-415).
- `upload-evidence` has failed on this host for six consecutive rounds (SAML): the DEFAULT evidence
  is verbatim SQL output + a DOM-snapshot excerpt + an `execute_js` JSON result + a
  `tauri_manage_window(action="list")` paste. A screenshot is a bonus, never the only record (G-104).
- Verdict line: `Verdict: **PASS**` (bare token first); `Tested commit:` a bare SHA on its own line;
  state the served branch/commit (G-052/G-443).

## Named blockers (pre-authorized, not silent drops)

- **NOT blockers this round — required.** N-6 (the console re-read on `main` **and** `terminal`), AC3's
  `<= 30 s` quit stopwatch (F-3) and AC5's Terminal PTY leg (F-5, `list_terminal_sessions` +
  `get_pty_buffer`) are drivable with the committed scripts and the provisioned `tauri_*` tools, so
  they are REQUIRED and must not be recorded as named blockers. In `exploratory.md`, **E-2 / E-8 / E-9
  stay legitimate non-binding named blockers** and **E-3 folds opportunistically** into F-5/F-3.
- A physical tray-icon click and a physical titlebar X are not drivable by any provisioned tool.
  Menu content is proven from the real `Menu` (F-2a), behaviour through the three converging seams
  (`open_main_window`, `quit_app`, second launch), and the `MenuEvent → handler` mapping by source
  pin (RT-6). A real click remains a human review-window item (QA-3).
- The R-2d "tray unavailable ⇒ X exits" leg has no induction seam in this slice: proven by the unit
  pin RT-5 + the exit-policy source, recorded as a named blocker for the live leg (QA-4).
