# background-capture — Functional Tests

> Durable functional suite for **capture at login without a window** (issue **#3193**): a
> `--background` launch that is resident with no window shown, the per-user login entry
> `"<exe>" --background` (enable/disable/legacy-migration/foreign-preservation), toggling without a
> second process or an ingestion gap, and the Settings → **Background capture** surface.
>
> Inherits `.opencode/tests/resident-shell/` (the resident process, tray `Open`/`Quit`, the
> single-instance probe, the exit gate), `.opencode/tests/headless-ingest/` (the retained
> `fredo ingest` daemon, whose login-entry row is SUPERSEDED by this suite — see
> `headless-ingest/functional.md` F-8), and `.opencode/tests/settings/` (the settings shell).
>
> **Verification policy: LIVE.** F-1…F-4 and F-6 assert runtime observables of a running artifact
> (a launch, a registry write, a window, a persisted span, a rendered pane). A static-only receipt
> for those rows is a FALSE PASS. The `static` legs in this suite are F-5a/F-5c (source pins),
> F-7's unit pin and the `regression.md` RT rows.
>
> **Binding contract** (`triage.md` `## Software Architect`): `--background` is recognised only as
> the SOLE argument (exact, case-sensitive), handled before the `args.len() > 1` clap branch, and is
> NOT registered with clap; `run(launch: LaunchMode)`; the single-instance probe is mode-aware
> (`Background` → `CliCommand::Ping` `{"type":"ping"}`, `Foreground` → `OpenMainWindow`); the one
> declarative window ships `visible: false` and is shown at `RunEvent::Ready` for `Foreground` only;
> `ensure_main_window` gains a `show()` leg; ONE builder `background_launch_command` produces
> `"<current_exe>" --background`; ownership = quoted exe token + `ingest` tail + canonicalise-equal
> to `current_exe()`; `IngestAutostartView` gains `available` + `owned`.

## How these rows are driven (read once before executing)

**Order matters.** F-1a → F-1b → F-1c run against ONE `--background` instance (which has no Vite
dev-server, by construction — see F-1a). F-1d and F-2…F-8 then run after a fresh
`dev-env.ps1 -Action Up`, because the pane needs a loaded page. F-3a/F-3c stop the app to seed a
value before a relaunch, and they say so in their own text. Never reorder without re-reading the
row.

- **Environment** (from `.opencode/state/env-leases/3193.json`):
  `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 3193 -EnvId <id> -EnvSlot <n>`.
  `<manifest>` = `.opencode/tmp/envs/<id>/manifest.json`; `<appPid>` = its
  `processes[] | role -eq 'app'`; ports from `ports.*`; driver `appIdentifier` = `ports.mcp`
  (decimal string). One command per shell call (no `;`, `|`, `&&`).
- **Instruments in this folder** (both run THROUGH the allowlisted wrapper, because the tester's
  grants name `.opencode/scripts/*` and `.opencode/tmp/*`, not `.opencode/tests/*`):

  ```
  powershell -File .opencode/scripts/run-exitcode.ps1 -Command "powershell -File .opencode/tests/background-capture/registry-entry.ps1 -Read -Exe <exe>"
  powershell -File .opencode/scripts/run-exitcode.ps1 -Command "powershell -File .opencode/tests/background-capture/launch-background.ps1 -Action Launch -ManifestPath <manifest> -Exe <exe>"
  ```

  `registry-entry.ps1` prints the RESOLVED value path, `ENTRY=Present|Absent`, `RAW=` verbatim,
  `RAW_LENGTH`, `RAW_SHA256`, a per-token breakdown, and the expected owned string with a byte
  equality verdict. It exits **2** (instrument failure) on an absent/unreadable input — a missing
  exe, a dead `-AppPid`, a missing backup, a .NET-vs-`reg.exe` disagreement, or a post-write
  mismatch — and **1** only when the reading contradicts its `-Expect`.
  `launch-background.ps1` starts `<exe> --background` with the env's `FREDO_*` seams injected and
  prints `START_PID`, readiness/port-owner facts and the NATIVE window reading.

- **`<exe>`** = the env's own binary as the product sees it, normally
  `apps/tauri/src-tauri/target/debug/fredo.exe` (the `pnpm tauri dev` build; `current_exe()` of the
  running app). Prefer `-AppPid <appPid>` when the app is already running (the instrument reads
  `Get-Process.Path`); pass `-Exe` when seeding before a launch.

- **Window visibility is read NATIVELY, never from the product's own window registry.** This
  feature declares `app.windows[0].visible = false`, so `main` EXISTS from launch while nothing is
  shown: `app_lifecycle_status.mainWindowOpen` is existence-only
  (`infrastructure/tray.rs:342-347`) and `tauri_manage_window action="list"` lists a hidden window
  (the resident-shell suite's N-1 says so). The discriminating readings are
  `Get-Process.MainWindowHandle` (0 = no VISIBLE top-level window) +
  `tasklist /FI "IMAGENAME eq fredo.exe" /FO LIST` → `Window Title`. A listed-but-hidden `main`
  entry is **NOT** a FAIL. Paste the raw `tauri_manage_window action="list"` output beside them; if
  that record carries a visibility field it must read `false`, and if it carries none, say so.

- **Tray `Open`** has no drivable physical click (resident-shell QA-3 named blocker). Per #3192 AC2
  the tray item, the `open_main_window` command and a second launch all call the SAME
  `ensure_main_window`. **Drive the webview-free seam first**: a foreground second launch (argv
  without `--background`) sends `CliCommand::OpenMainWindow` over the env's own pipe and needs NO
  webview — which matters because a `--background` launch may have materialised no webview at all
  (`triage.md` §8(a) is an UNVERIFIED fact). Use `…invoke('open_main_window')` only AFTER a window
  exists, as the in-app corroboration. Record the substitution.

- **Settings → Background capture** (the pane under test):
  `tauri_webview_execute_js(script="(() => window.__TAURI_INTERNALS__.invoke('open_app_window', { appId: 'settings' }))()")`
  → `tauri_manage_window(action="list")` shows `app-settings` → `tauri_driver_session stop` then
  `start` re-pointed at it → click `[data-testid="settings-nav-ingest"]` → wait for
  `[data-testid="settings-ingest-autostart-section"]`. The toggle input is
  `[data-testid="settings-ingest-autostart-toggle"] input`; click it with `fireEvent`-style
  `element.click()` inside `execute_js` (or `tauri_webview_interact`).

- **Spans.** Inject with the committed lever:
  `bun .opencode/scripts/inject-otlp-fixture.ts --port <ports.otlpGrpc> --count 1 --prefix e2e-bg3193-<guid8>`.
  Read back by the printed `span_id`/`trace_id`:
  `SELECT span_id, trace_id, session_id, span_name, transport, end_time_ns, ingested_at FROM telemetry_spans WHERE attributes_json LIKE '%e2e-bg3193-<guid8>%' ORDER BY ingested_at DESC`
  via `powershell -File .opencode/skills/telemetry-query/telemetry-query.ps1 -Manifest <manifest> -Format md -Query "<SQL>"`.
  **G-375 fallback:** if the keychain auth fails, read the same SQL with the app's `db_query_execute`
  (`mode:'all'`) from a surviving window and state the substitution verbatim. The CLI `emit` path
  writes no spans (G-256) — it is not a span lever.
- **Registry hygiene:** every mutating `registry-entry.ps1` mode auto-backs-up the host's current
  value to `.opencode/tmp/3193/registry-backup.json`. **Finish each row that mutates with
  `-Restore`** (and say so in the receipt) — the per-user Run key is real machine state.

## F-1 (R-1 / AC1) — `--background` is resident with no window shown, and capture is active

- [ ] **F-1a — the launch is resident, owns its ports, and shows NO window.**
  Bring the env up once (`dev-env.ps1 -Action Up`, bounded) so the manifest exists and the build is
  current, then stop it CLEANLY with `dev-env.ps1 -Action Down` — the background instance needs the
  env's PG data-dir lock and its OTLP/MCP ports, which the foreground app holds. (Do NOT just kill
  the app: the `tauri dev` launcher owns it and would race you.) Then run
  `launch-background.ps1 -Action Launch -ManifestPath <manifest> -Exe <exe>`.
  **Expected:** `RESULT=PASS`, `ALIVE=True`, `NEW_FREDO_PIDS` contains `START_PID`,
  `OTLP_GRPC_READY=True`, `OTLP_HTTP_READY=True`, `MCP_READY=True` and
  `PORT_OWNERS_SAME_PID=True` (one process owns both OTLP binds and the bridge);
  **`MAIN_WINDOW_HANDLE=0`** and `MAIN_WINDOW_TITLE=` empty, corroborated by
  `tasklist /FI "IMAGENAME eq fredo.exe" /FO LIST` showing `Window Title: N/A` for `START_PID`;
  the pasted `tauri_manage_window(action="list")` contains no *visible* main window (see the
  instrument rule above — a hidden `main` entry is not a failure).
  **Environment caveat (disclosed, not a FAIL):** `dev-env Down` also stops the env's Vite
  dev-server, so this instance's webview has no `devUrl` to load. AC1's observables (resident
  process, owned ports, no shown window, a persisted span) do not depend on it; the pane legs
  (F-2 onward) bring the env back up with `dev-env.ps1 -Action Up`.
  **Edge:** a port already bound by a stray process (readiness never reached ⇒ the row FAILs on the
  port-owner clause, never as a silent skip); a leftover `fredo.exe` must not absorb `START_PID`'s
  ports (the census pins the owner PID).

- [ ] **F-1b — ingestion is ACTIVE with no window (the decisive live leg).**
  With F-1a's process running, note the wall clock `T0` (`Get-Date -Format o`), inject ONE span
  (`--prefix e2e-bg3193-<guid8>`), then read `telemetry_spans` by that prefix.
  **Expected:** exactly ONE row; `end_time_ns IS NOT NULL`; `ingested_at` LATER than `T0`; the
  injector's `CONFIRM` line (with `trace_id` and `span_id` hex) pasted verbatim.
  **Corroboration (record, do not gate):** try `tauri_webview_execute_js` against `main`. If it
  answers, paste `1+1` → 2 and `document.visibilityState`/`document.hidden`. If it cannot attach,
  record `NO_WEBVIEW_AT_BACKGROUND_LAUNCH` — the strongest available form of "no window shown" —
  and rely on F-1a's native handle as the binding proof. Never substitute a screenshot for the span.
  **Edge:** G-375 auth failure ⇒ `db_query_execute` fallback, disclosed; an injection into a
  second resident env must not qualify (prefix match is per run).

- [ ] **F-1c — the tray `Open` path shows the window in the SAME process (webview-free seam).**
  With the background instance still hidden, run the resident-shell lever
  `run-exitcode.ps1 -Command "powershell -File .opencode/tests/resident-shell/second-launch.ps1
  -ManifestPath <manifest> -Exe <exe>"` — its argv has NO `--background`, so the probe sends
  `CliCommand::OpenMainWindow`, the SAME `ensure_main_window` the tray item dispatches. Then re-read
  `launch-background.ps1 -Action Windows -ManifestPath <manifest>`, `tasklist`, and
  `tauri_manage_window(action="list")`.
  **Expected:** **`MAIN_WINDOW_HANDLE` is now NON-ZERO** and `MAIN_WINDOW_TITLE` is the per-env
  title `Fredo [<envId>]` (legacy `Fredo` on slot 0), corroborated by `tasklist` `Window Title`; the
  background PID is UNCHANGED (`TARGET_PID == START_PID`); `SECOND_EXITED=True`,
  `NEW_FREDO_PIDS=` EMPTY and `POSTMASTER_BEFORE`/`AFTER` identical **and non-empty**; the window
  list now carries a VISIBLE `main`; and — only when the env's Vite is serving (see F-1a's caveat) —
  the console has no `Error:`/`Uncaught`/`Maximum update depth exceeded`. A failed page load in the
  no-Vite state is an ENVIRONMENT artifact: record it, do not FAIL AC1 on it.
  **Record which build route was taken (NOT a pass/fail literal):** a shown hidden window vs a
  window built on demand are both AC1-compliant (`triage.md` §8(a)/(b) are UNVERIFIED). A FAIL is a
  changed PID, a still-zero handle, or a SECOND `main`.
  **Edge:** run the second launch twice (second is a no-op; still one `main`).

- [ ] **F-1d — the in-app `open_main_window` command is idempotent once the window exists.**
  Precondition: an env with its Vite dev-server serving (run this after the F-2 block's
  `dev-env.ps1 -Action Up`, while the window is shown). Point the driver at `main` and
  `…invoke('open_main_window')` twice. Then read `app_lifecycle_status`.
  **Expected:** both calls report `focused: true` with `recreated: false` (the window exists and is
  reused), the window list still holds exactly ONE `main`, the PID is unchanged, and
  `app_lifecycle_status.trayItems` is exactly
  `[{"id":"tray-open","label":"Open"},{"id":"tray-quit","label":"Quit"}]` — i.e. the tray is still
  installed in background mode.
  If `window.__TAURI_INTERNALS__` is unavailable (no page loaded), record a FAILED DRIVE of this leg
  and say so — F-1c already proved the show path through the webview-free seam.
  **Edge:** invoke while the window is minimized (unminimize then focus, never a second window).

## F-2 (R-2 / AC2) — the login entry is exactly `"<exe>" --background`

- [ ] **F-2a — enabling writes the exact owned command.**
  From a cleared value (`registry-entry.ps1 -Clear`, which prints `DELETE_VERIFIED=Absent`), open
  Settings → Background capture and click the toggle ON; wait for `settings-ingest-autostart-status`
  to read `Background capture: On`. Then read the registry with `-Read -AppPid <appPid>`.
  **Expected:** `ENTRY=Present`, `VALUE_KIND=String`, `RAW_EQUALS_EXPECTED=True`,
  `EXPECTED_OWNED_RAW=` equals `"<exe>" --background` with the instrument's `EXE=` path, and the
  token breakdown shows `QUOTE_COUNT=2`, `QUOTE_OPEN=True`, `SEPARATOR_SPACES=1`,
  `TAIL_TRIMMED=--background`, `TAIL_IS_BACKGROUND=True`, `TAIL_IS_INGEST=False`,
  `TRAILING_WHITESPACE=False`, `RAW_LENGTH == EXPECTED_OWNED_LENGTH`; `EXE_MATCH_CURRENT=True`
  (record `EXE_MATCH_RULE`, `canonical` preferred). Paste `RAW=`, `RAW_LENGTH`, `RAW_SHA256` and the
  `reg.exe` corroboration line verbatim.
  **Edge:** an exe path containing spaces (the dev build path does not — record which was used);
  enabling twice in a row (idempotent, same `RAW_SHA256`); the value must hold ONE value name —
  `-Read` prints `VALUE_PATH=` so a second name is visible in the paste.

- [ ] **F-2b — disabling removes it, and a disable with nothing installed succeeds.**
  Click the toggle OFF; wait for `Background capture: Off`; read with `-Expect Absent`.
  **Expected:** `ENTRY=Absent`, `EXPECTATION_MET=True`, exit code 0; the orphaned `RAW=` line is
  empty; the surface shows `DETAIL_OFF_JUST_SET` (`The login item is removed. This session keeps
  capturing until you quit Fredo.`) and no error line. Then run `-Clear` again and click OFF once
  more: the call succeeds (no error text, switch stays off, `EXPECTATION_MET=True`).
  **Edge:** disable twice; disable while the registry was removed out-of-band (the UI must settle
  on Off from the read-back, not from its optimistic state).

## F-3 (R-3 / AC3) — a legacy `"<exe>" ingest` value is migrated; a value we do not own is untouched

- [ ] **F-3a — STARTUP migration (legacy ⇒ current, presence preserved).**
  Down the env (`dev-env.ps1 -Action Down`) or stop only the app; seed with
  `registry-entry.ps1 -SeedLegacy -Exe <exe>` (prints `SEED_RAW=`, `WRITE_VERIFIED=True`); confirm
  `-Read` reports `ENTRY=Present`, `TAIL_IS_INGEST=True`, `RAW_EQUALS_EXPECTED=False`. Note the
  pre-launch `RAW_SHA256`. Launch the app (foreground `dev-env.ps1 -Action Up` for the same env,
  or `launch-background.ps1`) and wait until it is ready, then `-Read` again.
  **Expected:** `ENTRY=Present` BEFORE and AFTER (enabled state preserved — the migration never
  disables); the AFTER `RAW` equals `"<exe>" --background` byte-for-byte
  (`RAW_EQUALS_EXPECTED=True`, `TAIL_IS_BACKGROUND=True`, `TAIL_IS_INGEST=False`), with
  `EXE_MATCH_CURRENT=True`; `RAW_SHA256` changed from the legacy value to the expected one.
  **Edge:** app already running when seeded (startup migration does NOT run — this leg requires a
  real relaunch; record which you did); a second relaunch is idempotent (`RAW_SHA256` unchanged).

- [ ] **F-3b — TOGGLE migration, rewritten IN PLACE (no delete window).**
  With the app running and the legacy value seeded (`-SeedLegacy`), invoke the SAME command the
  switch calls, with the legacy value present:
  `tauri_webview_execute_js(script="(() => window.__TAURI_INTERNALS__.invoke('ingest_autostart_set', { enabled: true }))()")`
  — then `-Read`.
  **Expected:** the returned view has `enabled: true`; the registry reads the current form
  (`RAW_EQUALS_EXPECTED=True`); the value is `ENTRY=Present` throughout (paste the pre-read and the
  post-read so "in place" is visible: it never became Absent). `RAW_SHA256` post == the expected
  form's digest.
  **Edge:** legacy value whose exe path differs only in case (`-SeedLegacy` writes the resolved
  path; to drive a case variant, pass `-ForeignCommand` with a differently-cased same-file path and
  record `EXE_MATCH_RULE=string-fallback`).

- [ ] **F-3c — a FOREIGN value is byte-identical after startup.**
  Stop the app; seed `registry-entry.ps1 -SeedForeign` (default data:
  `"C:\Program Files\Contoso\contoso.exe" ingest` — legacy-SHAPED, different executable, so a
  predicate matching only the `ingest` tail is caught). Record `RAW=` and `RAW_SHA256=`. Relaunch
  the app; wait ready; `-Read` again.
  **Expected:** `ENTRY=Present`, `RAW` byte-identical to the seed and to the pre-launch read
  (`RAW_SHA256` equal), `EXE_MATCH_CURRENT=False`, `TAIL_IS_INGEST=True`. Nothing in the app logs
  claims a migration; the value is NOT replaced by the current form.
  **Edge:** a foreign value with extra arguments (`-ForeignCommand '"C:\Program Files\Contoso\contoso.exe" --serve'`);
  a foreign value with unbalanced quoting (`-ForeignCommand 'notepad.exe "C:\a b.txt'` — must not
  be "fixed" or deleted).

- [ ] **F-3d — a FOREIGN value is untouched by DISABLE, and the surface says so truthfully.**
  With the app running and F-3c's foreign value present, open Settings → Background capture.
  **Expected:** the pane renders `Background capture: Off` + `DETAIL_OFF`
  (`Fredo does not start when you sign in. Capture runs only while Fredo is open.`) — derived from
  `enabled: true, owned: false, available: true`, never as an error (`status.error` absent, no
  `Could not update background capture:` line). Toggle ON then OFF; after the OFF, `-Read` the
  registry: `ENTRY=Present` and `RAW_SHA256` STILL the foreign digest — disable did not delete a
  value this product does not own.
  **Edge:** toggle ON with the foreign value present (F-3e) — the surface must not claim it was
  already correct; `ingest_autostart_get` alone (open the pane, change nothing) must leave the
  registry byte-identical (read-only contract).

- [ ] **F-3e — enabling RECOVERS a foreign value (the documented recovery path).**
  From F-3d's foreign state, click the toggle ON and wait for `Background capture: On`.
  **Expected:** `-Read` shows `RAW_EQUALS_EXPECTED=True`, `TAIL_IS_BACKGROUND=True`,
  `TAIL_IS_INGEST=False`, `RAW_SHA256` = the owned form's digest; the surface's timing line is
  `DETAIL_ON_JUST_SET`. Because OFF intentionally left the foreign value in place, the switch shows
  OFF before the click even though `enabled` was true — record the exact pre-click status text so
  the stale-entry honesty is visible.
  **Edge:** the foreign value names ANOTHER Fredo installation path (must be classified foreign by
  canonical-equality, then recovered by the same enable).

## F-4 (R-4 / AC4) — toggling spawns no second process and does not interrupt ingestion

- [ ] **F-4a — PID / postmaster / listener census is IDENTICAL across the toggle.**
  With the env up, the value cleared, and Settings → Background capture open, take the LEFT census:
  `run-exitcode.ps1 -Command "powershell -File .opencode/tests/resident-shell/lifecycle-probe.ps1
  -Action Inventory -ManifestPath <manifest>"` (paste `APP_PID`, `FREDO_PROCS`, `POSTMASTER_COUNT`,
  `POSTMASTER_PIDS`, `PG_DATA_DIR_EXISTS=True`, `PG_POSTMASTER_PIDFILE_MATCH=True`) plus
  `powershell -File .opencode/scripts/process-hygiene.ps1 -List`. Note the wall clock `T0`. Toggle
  ON, wait for `Background capture: On` / `-Read -Expect Present`, toggle OFF, wait for Off /
  `-Expect Absent`. Re-run BOTH census commands (RIGHT).
  **Expected:** `APP_PID` identical and alive; `FREDO_PROCS` count unchanged and `FREDO_PIDS` sets
  equal (no new `fredo.exe`); `POSTMASTER_PIDS` IDENTICAL and NON-EMPTY on both reads (a blank pair
  or `POSTMASTER_COUNT=0` without `PG_DATA_DIR_EXISTS=True` is a FAILED DRIVE, never a pass);
  `PG_POSTMASTER_PIDFILE_MATCH=True` on both; the OTLP gRPC/HTTP listeners still belong to the same
  app PID (`lifecycle-probe.ps1 -Action Port -PortNumber <ports.otlpGrpc>` /
  `<ports.otlpHttp>`, `PORT_LISTENER_PIDS` = `<appPid>`); no new listener on any port.
  **Edge:** toggle twice rapidly (no interleaved second process); toggle while a span is streaming
  (F-4b); toggling from the backend command instead of the UI — record which was driven.

- [ ] **F-4b — ingestion CONTINUES across the toggle (span receipt bracketing T0).**
  Inject span #1 (`--prefix e2e-bg3193-a-<guid8>`) immediately BEFORE the toggle and span #2
  (`--prefix e2e-bg3193-b-<guid8>`) immediately AFTER it, recording `T_before`, `T_toggle`,
  `T_after` wall clocks. Read both rows by prefix.
  **Expected:** BOTH rows exist; each has `end_time_ns IS NOT NULL`; span #1's `ingested_at` is
  before `T_toggle` and span #2's is AFTER `T_toggle` and before the read; the receiver never
  refused an export (the injector prints per-export `CONFIRM`; a transport failure is a FAIL, not
  a note); the app PID is unchanged across the whole sequence.
  **Edge:** a burst of 3 spans around the toggle (all persisted); G-375 fallback read disclosed.

## F-5 (R-5 / AC5) — dispatch order is unchanged for every other argv, and no surface installs/recommends `fredo ingest`

- [ ] **F-5a (STATIC pin + LIVE discriminators) — the flag is pre-clap, sole-argument-only.**
  Read `apps/tauri/src-tauri/src/main.rs` and `src/infrastructure/launch.rs`, then run the live
  discriminators against `<exe>`:
  `run-exitcode.ps1 -Command "\"<exe>\" --background emit"` (via a temp `.ps1` under
  `.opencode/tmp/3193/` if quoting fights the wrapper, and record that),
  `run-exitcode.ps1 -Command "\"<exe>\" --help"`, `run-exitcode.ps1 -Command "\"<exe>\" --version"`.
  **Expected:** the source evaluation order is EXACTLY: sole-argument `--background` check →
  else `args.len() > 1` clap branch → else `run(Foreground)`; `--background` appears in NO clap
  `Commands`/`Args` item (`infrastructure/cli/mod.rs`); the resolver's contract maps
  `["<exe>","--background"]` → `Background` and `["<exe>","--background","emit"]`, `["<exe>","--help"]`,
  `["<exe>",""]` (empty argv beyond the exe) → `Foreground`. LIVE: `--background emit` exits **1**
  with a clap parse error (it is NOT a background launch and NOT an ingest launch), `--help` exits
  **0** and prints the same subcommand set as before (list them), `--version` exits 0. `--background`
  is absent from `--help`'s output.
  **Edge:** `--Background` / `-background` (wrong case ⇒ clap parse error, exit 1); `["--background"]`
  alone must NOT be a parse error (it starts the app — F-1a proves it); `fredo ingest --help` is
  unchanged (the retained subcommand is out of scope — #3194 decides its fate).

- [ ] **F-5b (LIVE DOM + STATIC sweep) — no install/recommend surface offers `fredo ingest`.**
  (i) Read the rendered text of `[data-testid="settings-ingest-autostart-section"]` (`textContent`)
  and the nav label text of `[data-testid="settings-nav-ingest"]`. (ii) Sweep the install/recommend
  surfaces: `apps/ui/src/applications/ingest/**`, `apps/ui/src/applications/settings-app/**`,
  `apps/tauri/src-tauri/src/applications/settings/autostart.rs`, and the login-entry builder's call
  sites — searching for the literal `fredo ingest` and for the `ingest` tail in a command string.
  Report every hit with a disposition.
  **Expected:** the nav label reads `Background capture`; the section text contains
  `Background capture` and `Capture agent activity even when no Fredo window is open.` and contains
  **NONE** of: `fredo ingest`, `Headless ingest daemon`, `Start daemon at login`,
  `Installs a per-user Windows login entry.`, `No admin rights required.`, `--background`,
  `registry`, `HKCU`, `admin`, `elevation`, `service`, `Daemon:`, `Entry:`, `Command:` (compare
  case-insensitively; `textContent` only — never `title` attributes). Source sweep: the login-entry
  builder and its only call site emit the `--background` form; no USER-VISIBLE string in those
  files contains `fredo ingest`. **Sweep universe:** the DOM text of the section (F-5b(i)), the four
  source paths named above, and the login-entry builder's call site. This suite file and the
  retired-string lists in it are NOT in that universe — they spell the tokens deliberately as the
  absence contract, and a repo-wide scan is not the instrument this row binds (G-431).
  **Out of scope, recorded not failed:** the retained
  `fredo ingest` SUBCOMMAND and its reference docs (`docs/CLI_GUIDE.md:216-246`,
  `docs/SETUP.md:234-237,247,276`, `docs/ARCHITECTURE.md:210,321`) — #3194 decides its fate; the
  login/auto-start doc sentences (`docs/SETUP.md:241`, `docs/CLI_GUIDE.md:7,9,252`,
  `docs/FAQ.md:159`, `docs/ARCHITECTURE.md:399,401,407`) are owned by **#3196 ST-5** and are
  reported with their owner, not FAILed here.
  **Edge:** a `title=` tooltip carrying the retired copy (DOM `textContent` misses it — read the
  section's `outerHTML` for `title=` and report); the `Daemon:` row removed but ``Daemon:` surviving
  in a test/comment (comments are not product surfaces — disposition them, do not fail).

- [ ] **F-5c (STATIC pin) — ONE builder owns the command, and it cannot produce the `ingest` form.**
  Read `applications/settings/autostart.rs`. 
  **Expected:** `pub fn background_launch_command(exe: &Path) -> String` exists and produces
  `"<exe display>" --background`; NO builder emitting the `ingest` form remains (no
  `autostart_command`, no `format!("\"{}\" ingest"` anywhere in the file); `VALUE_NAME` is
  `FredoIngest`, `RUN_KEY` is the HKCU Run path, `REG_TIMEOUT` is still a finite bound; the unit
  tests pin the current form, the classifier (current/legacy/foreign/absent), quoting, and
  idempotency. Run
  `run-exitcode.ps1 -Command "cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml autostart"`
  and paste the summary line.
  **Edge:** a second copy of the command literal in the frontend or docs (search for
  `--background` in `apps/ui/src` — a UI string is a FAIL of F-5b, a test fixture is a disposition).

## F-6 (ST-2 / R-5b) — the Settings → Background capture pane renders the state matrix and none of the retired copy

- [ ] **F-6a — steady ON and steady OFF.**
  With the value enabled (F-2a state) open the pane; then disable and re-read the pane.
  **Expected:** ON: `[data-testid="settings-ingest-autostart-status"]` text is
  `Background capture: On` and `[data-testid="settings-ingest-autostart-timing"]` is
  `Fredo starts in the background the next time you sign in.`; toggle checked. OFF:
  `Background capture: Off` + `Fredo does not start when you sign in. Capture runs only while Fredo
  is open.`; toggle unchecked. The toggle's accessible name is
  `Start background capture when I sign in`.
  **Edge:** reopening the pane after a restart (the just-set sentence must be GONE — it is component
  state, not persisted).

- [ ] **F-6b — in-flight, just-set, and error states.**
  Toggle and sample the pane immediately (0–1 s) and after it settles; then induce an error (a
  registry-write failure is not reachable without a seam — drive the store's rejection path only if
  ST-2 exposes one, otherwise record the error-state leg as a UNIT-PIN leg and say so).
  **Expected:** during the write the timing line is `Applying…` and the toggle is `disabled`;
  settling ON yields `Takes effect the next time you sign in. This session is already capturing, so
  nothing changes right now.`; settling OFF yields `The login item is removed. This session keeps
  capturing until you quit Fredo.`; the error leg renders `Could not update background capture:
  <message>` with the switch REVERTED to the prior value and no color-only signal.
  **Edge:** rapid toggle ON→OFF before the first write settles (final state matches the registry,
  not the last click); `aria-busy="true"` while applying; exactly ONE polite live region in the
  section (`role="status" aria-live="polite"`).

- [ ] **F-6c — hooks present, retired hook ABSENT.**
  `tauri_webview_dom_snapshot(type="structure")` on `app-settings` with the pane open.
  **Expected:** present — `settings-nav-ingest`, `settings-ingest-autostart-section`,
  `settings-ingest-autostart-toggle`, `settings-ingest-autostart-status`,
  `settings-ingest-autostart-timing`; ABSENT — `settings-ingest-daemon-status`, and no rendered
  `Daemon:` / `Entry:` / `Command:` / `Auto-start on login` text anywhere in the section.
  **Edge:** the loading skeleton `settings-ingest-autostart-toggle-skeleton` appears on a cold,
  slow registry read and is replaced by the toggle (never a guessed `Off` before the read settles).

## F-7 (non-Windows contract) — `available: false` replaces the current `Err`

- [ ] **F-7 (UNIT/STATIC pin + NAMED BLOCKER) —** read
  `applications/settings/autostart.rs` and the vitest file for the pane.
  **Expected (pin):** on non-Windows, `ingest_autostart_get` and `ingest_autostart_set` return
  `Ok(IngestAutostartView { enabled: false, command: None, entry: None, available: false, owned: false })`
  WITHOUT invoking `reg.exe` (the `#[cfg(not(target_os = "windows"))]` leg), and a committed test
  renders the pane's `available: false` state as `Background capture: Unavailable on this platform`
  + `The login item is available on Windows only for now. Fredo still captures while it is open.`
  with a DISABLED switch and no error styling. Paste the test name and its pass line
  (`pnpm --filter @fredo/ui build`/`vitest` run output).
  **Named blocker (live leg):** this host is Windows, so the live non-Windows rendering cannot be
  driven; record the pin as the receipt and say the live leg is unavailable (G-053), never a FAIL.

## F-8 (wire contract, G-413) — `available` / `owned` cross the IPC boundary and are consumed

- [ ] **F-8 — the serialized view carries both new fields and the renderer reads the PROJECTION.**
  From `app-settings`: `tauri_webview_execute_js(script="(() => window.__TAURI_INTERNALS__.invoke('ingest_autostart_get'))()")`
  → paste the raw JSON. Then inspect the DOM for the two states those fields drive (F-3d's
  `enabled && !owned && available` Off state; F-7's `available:false` pin).
  **Expected:** the JSON carries `enabled`, `command`, `entry`, **`available`** and **`owned`** with
  boolean values in camelCase; on this host `available: true`; with the foreign value seeded,
  `enabled: true, owned: false`; with the owned value, `enabled: true, owned: true`; with nothing,
  `enabled: false, owned: false`. A renderer that reads `owned`/`available` renders the
  corresponding state (F-3d/F-7) — a view that OMITS the field is a FAIL (the projection is the
  contract, not the source struct).
  **Edge:** the absent-value case must serialize `command: null`/`entry: null` (not `""`); a
  non-boolean `available`/`owned` is a FAIL.

## Non-functional

- [ ] **N-1 (build gates).** `run-exitcode.ps1 -Command "cargo check --manifest-path
  apps/tauri/src-tauri/Cargo.toml"` (zero warnings), `… "cargo test --manifest-path
  apps/tauri/src-tauri/Cargo.toml"`, `… "pnpm --filter @fredo/ui build"` — all `EXITCODE=0`.
- [ ] **N-2 (no new Tauri command / no ACL drift).** `git diff --stat origin/main...HEAD --
  apps/tauri/src-tauri/src/runtime/command_manifest.rs apps/tauri/src-tauri/gen/schemas`
  is EMPTY (paste it): the view gains fields, not a command.
- [ ] **N-3 (bounded).** every boot/launch/quit leg is wall-clock bounded (Env Up ≤180 s, launch
  readiness ≤180 s, quit probe ≤30 s) with a hard-kill fallback; an observed unbounded wait is a
  FAIL, not a skip (G-263).
- [ ] **N-4 (console hygiene).** `tauri_read_logs(source="console", lines=50)` on `main` (after
  F-1c) and on `app-settings` (after F-6): no `Error:` / `Uncaught` / `Maximum update depth exceeded`.
- [ ] **N-5 (theme).** the pane renders correctly in BOTH the light and dark presets (no hardcoded
  hex; the disabled switch's reduced opacity is legible in both). Screenshot bonus only.
- [ ] **N-6 (no window flash at login — disclosed method).** `launch-background.ps1`'s
  `MAIN_WINDOW_HANDLE` is read after readiness; a sub-100 ms flash between process start and that
  read is not observable with the provisioned tools — DISCLOSE it, do not claim it proven.

## Suite-level pass/fail

PASS = F-1a…F-8 green (F-7's live leg recorded as its named blocker and its pin green) **and**
N-1…N-6 hold. FAIL = a background launch that shows a window (`MAIN_WINDOW_HANDLE != 0` before
`Open`); a tray `Open` that changes the PID or starts a second postmaster; a login value that is not
byte-identical to `"<exe>" --background`; a migrated value that passes through Absent; a foreign
value that is rewritten or deleted by startup/disable; a second `fredo.exe`/postmaster around a
toggle; a span that cannot be shown to bracket the toggle; a rendered retired string; a
`settings-ingest-daemon-status` assertion; or a static-only receipt for any LIVE row.
UNVERIFIED requires a NAMED, actionable blocker (G-053) — never a silent drop.

## Required test data

- Env: `dev-env.ps1 -Action Up -Spec 3193 -EnvId <id> -EnvSlot <n>` (bounded, ≤180 s); manifest
  facts from `.opencode/tmp/envs/<id>/manifest.json`; `<exe>` =
  `apps/tauri/src-tauri/target/debug/fredo.exe` (in-repo build output of that env's checkout).
- **New committed instruments (QA-authored, this folder):** `registry-entry.ps1`
  (`-Read/-SeedLegacy/-SeedForeign/-Clear/-Backup/-Restore`), `launch-background.ps1`
  (`-Action Launch/Windows/Kill`). Both hard-fail on an absent input; both print `KEY=value` lines.
  **First-green precondition (G-406):** neither instrument has been executed at authoring time (the
  QA role has no PowerShell execution grant), so smoke `S-4`/`S-5` ARE the instruments' first-green
  check. An `ERROR:` line with exit 2 from either means the INSTRUMENT is wrong — the round's rows
  are UNVERIFIED pending an instrument fix by the QA Expert, never product FAILs.
- Reused committed levers: `.opencode/scripts/run-exitcode.ps1`, `.opencode/scripts/process-hygiene.ps1
  -List`, `.opencode/scripts/dev-env.ps1`, `.opencode/scripts/inject-otlp-fixture.ts`,
  `.opencode/skills/telemetry-query/telemetry-query.ps1`,
  `.opencode/tests/resident-shell/lifecycle-probe.ps1` (+ its `manifest-facts.ps1` and
  `second-launch.ps1`).
- **Spans:** `.opencode/scripts/inject-otlp-fixture.ts` gRPC on `ports.otlpGrpc` (ONE route bound;
  read back by `span_id` from the injector's printed `CONFIRM` SQL).
- **Registry backup:** `.opencode/tmp/3193/registry-backup.json` (auto-created before any mutation;
  `-Restore` at the end of every mutating row).

## Evidence rules

- Every cited artifact must be a NON-DRAFT durable record — the posted `## Tests Runs` comment, a
  committed path (these suite files, the two instruments), or a `user-attachments` URL (G-415).
  Never a `.opencode/tmp/3193/` timeline draft.
- `upload-evidence` has failed on this host for seven consecutive rounds (SAML): the DEFAULT
  evidence is verbatim instrument output (`RAW=`, `RAW_SHA256=`, `MAIN_WINDOW_HANDLE=`,
  `POSTMASTER_PIDS=`), the SQL result table, a DOM-snapshot excerpt, and the raw
  `tauri_manage_window(action="list")` paste. A screenshot is a bonus, never the only record (G-104).
- Verdict line: `Verdict: **PASS**` (bare token first). `Tested commit:` a bare SHA ALONE on its
  line; state the served branch/commit and the tree condition (served tree at that commit) on the
  NEXT line (G-052/G-443).

## Named blockers (pre-authorized, not silent drops)

- **A physical tray-icon click** is not drivable by any provisioned tool (resident-shell QA-3). Tray
  `Open` is driven through the WEBVIEW-FREE seam first (a foreground second launch →
  `CliCommand::OpenMainWindow`, F-1c) with `…invoke('open_main_window')` as the in-app
  corroboration once a page exists (F-1d); both call the same `ensure_main_window` the tray item
  dispatches. Record the substitution.
- **A sub-100 ms window flash** at login is not observable with the provisioned tools (N-6).
- **The live non-Windows `unavailable` rendering** cannot be driven on this host (F-7): the
  unit/static pin is the receipt.
- **A failed registry WRITE** has no product injection seam; if ST-2 exposes none, the error-state
  leg is a unit-pin leg (F-6b) and is recorded as such.
