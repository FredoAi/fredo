# background-capture — Functional Tests

> Durable functional suite for **capture at login without a window** (issue **#3193**): a
> `--background` launch that is resident with no window shown, the per-user login entry
> `"<exe>" --background` (enable/disable/legacy-migration/foreign-preservation), toggling without a
> second process or an ingestion gap, and the Settings → **Background capture** surface.
>
> **#3195 EXTENDED THIS SUITE — the pane's STATUS LINE is now about CAPTURE, not the login entry.**
> `settings-ingest-autostart-status` is **RETIRED** (`Background capture: On/Off/Unavailable on this
> platform` are deleted strings — they rendered the login-entry boolean in capture vocabulary, which
> is the defect #3195 removes). The section now carries ONE section-local `role="status"` region
> whose `settings-ingest-capture-status` line reads `Capture: Running` / `Capture: Not running` /
> `Capture: Status unavailable` from a `stream_health` read the webview performs itself, plus
> `settings-ingest-capture-detail` for the reason. The **switch** (`checked`) and
> `DETAIL_ON`/`DETAIL_OFF` remain the SOLE statement of the sign-in state. Rows below that used to
> wait on the retired id now read the switch's `checked` state; rows that assert the retired copy are
> **inverted in place** and say so. New rows: **F-0** (instrument preflight), **F-2c/F-2d** (AC2 —
> the mount reads the REAL registry), **F-9** (AC1 copy + vocabulary absence), **F-10** (AC3 status
> line, all states), **F-11** (AC4 window continuity), **F-12** (AC5 nav/test-id/token sweep).
>
> **TWO AC NUMBERINGS LIVE HERE.** Rows **F-1…F-8** carry **#3193's** AC numbering; rows
> **F-9…F-12** (and the additions to F-2/F-6/F-7) carry **#3195's** and are each tagged
> `(#3195 …)`. Both schemes have an AC4 — read the tag, not the number.
>
> Inherits `.opencode/tests/resident-shell/` (the resident process, tray `Open`/`Quit`, the
> single-instance probe, the exit gate), `.opencode/tests/resident-ingest/` (the ONE resident owner
> of the cluster and the OTLP receivers — its predecessor `headless-ingest/` was RETIRED by #3194;
> the row-by-row disposition is `resident-ingest/retirement-ledger.md`), and
> `.opencode/tests/settings/` (the settings shell).
>
> **Verification policy: LIVE.** F-1…F-4, F-6, F-9, F-10, F-11 and F-12's nav leg assert runtime
> observables of a running artifact (a launch, a registry write, a window, a persisted span, a
> rendered pane). A static-only receipt for those rows is a FALSE PASS. The `static` legs in this
> suite are F-5a/F-5c (source pins), F-7's unit pin, F-12's greps, and the `regression.md` RT rows.
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
value before a relaunch, and they say so in their own text. **F-0 runs FIRST** (instrument
preflight). Rows F-9…F-12 share the one env. The recommended order after F-8 is:
**F-9 → F-10a → F-10e → F-11 → F-12a/b/e/f → F-10b → F-10c → F-10d → F-10f → F-12c/d** —
i.e. every leg that needs a NORMAL launch first, then the three bounded `Down` + `Up -EnvVar`
restarts (F-10b `ingest-down`, F-10c `degraded`, F-10d `down`) one at a time (one env per issue,
G-316 — never two force values at once), then F-10f LAST among the live legs because its probe
refuses an incumbent app and launches the app itself with the port held. F-11 needs the pre-test
registry backup CLEARED first and restores it at the end — it says so in its own text. Never
reorder without re-reading the row.

- **Environment** (from `.opencode/state/env-leases/3195.json` — this issue's env, `EnvSlot 1`,
  ports `16000` vite / `16001` mcp / `16002` otlpGrpc / `16003` otlpHttp):
  `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 3195 -EnvSlot 1
  -RequireIsolation -TimeoutSecs 420` (the default 120 s expires mid-boot).
  `<manifest>` = `.opencode/tmp/envs/spec3195/manifest.json` (the `-EnvId` derives as `spec3195`);
  `<appPid>` = its `processes[] | role -eq 'app'`; ports from `ports.*`; driver `appIdentifier` =
  `ports.mcp` (decimal string). One command per shell call (no `;`, `|`, `&&`).
  **Boot caveat (disclose, do not FAIL):** a fresh isolated boot takes 3–5 minutes to first paint
  (`dev-environment` SKILL.md:238); until it paints every `tauri_webview_execute_js` returns
  `Request timeout after 2000ms`. Wait it out and say how long. A restart for a different
  `FREDO_STREAM_HEALTH_FORCE` value is the same boot cost.
- **Backend health lever (F-10).** The pane's line must come from a read of the backend, so the
  only lever that moves it is the BACKEND's: the app must be (re)launched with
  `-EnvVar "FREDO_STREAM_HEALTH_FORCE=<token>"` on `dev-env.ps1 -Action Up` — tokens `ingest-down`
  (immediate: heartbeats still emit, `ingestConnected:false`), `degraded` (heartbeats suppressed ⇒
  the stale window `15000 ms` must elapse, ~16 s, plus one 5 s pane tick), `down` (the probe itself
  returns `Err`). A FRONTEND force token (`window.__FREDO_STREAM_HEALTH_FORCE__` / sessionStorage /
  `VITE_FREDO_STREAM_HEALTH_FORCE`) moves only `useStreamHealth`'s consumers and is NOT a lever for
  this pane — do not use it here.
- **Instruments in this folder** (both run THROUGH the allowlisted wrapper, because the tester's
  grants name `.opencode/scripts/*` and `.opencode/tmp/*`, not `.opencode/tests/*`):

  ```
  powershell -File .opencode/scripts/run-exitcode.ps1 -Command "powershell -File .opencode/tests/background-capture/registry-entry.ps1 -Read -Exe <exe>"
  powershell -File .opencode/scripts/run-exitcode.ps1 -Command "powershell -File .opencode/tests/background-capture/launch-background.ps1 -Action Launch -ManifestPath <manifest> -Exe <exe>"
  ```

  `registry-entry.ps1` prints the RESOLVED value path, `ENTRY=Present|Absent`, `RAW=` verbatim,
  `RAW_LENGTH`, `RAW_SHA256`, a per-token breakdown, and the expected owned string with a byte
  equality verdict. **An ABSENT value is a normal reading**: `-Read` prints `ENTRY=Absent`,
  `RAW_SHA256=(absent)`, `VALUE_KIND=(none: the value does not exist)` and exits **0**; with
  `-Expect Absent` it also prints `EXPECTATION_MET=True`. It exits **2** (instrument failure) only
  on an absent/unreadable INPUT — a `-Exe` path not on disk, a dead `-AppPid`, a missing backup, a
  `reg.exe` exit outside {0,1}, a .NET-vs-`reg.exe` disagreement, or a post-write mismatch — and
  **1** only when the reading contradicts its `-Expect`. `-Clear` is **idempotent and says so**:
  clearing an already-absent value prints `CLEAR_WAS_ALREADY_ABSENT=True` +
  `DELETE_VERIFIED=Absent` and exits 0 (an absent TARGET is a reading, never an absent input).
  `launch-background.ps1` starts `<exe> --background` with the env's FULL Names-Block injected
  (`FREDO_ENV_ID`, `FREDO_ENV_ROOT`, `FREDO_ENV_MANIFEST`, `FREDO_DATA_DIR`, **`FREDO_PG_DATA_DIR`**,
  `FREDO_PG_LOCK_DIR`, `FREDO_DBCLIENT_STATE_DIR`, `FREDO_CLI_PIPE`, `FREDO_MCP_BASE_PORT`,
  `FREDO_VITE_PORT`, `FREDO_WEBVIEW_PROFILE_DIR`/`WEBVIEW2_USER_DATA_FOLDER`,
  `FREDO_LLAMA_SERVER_COMPANION_DIR`, `FREDO_INGEST_GRPC_PORT`/`FREDO_INGEST_HTTP_PORT`,
  `OPENCODE_ENABLE_TELEMETRY`/`OPENCODE_OTLP_ENDPOINT`/`OPENCODE_OTLP_PROTOCOL`), re-derived from the
  manifest plus the documented `<env-root>/postgres|lock|dbclient|companion` layout. It **fails
  closed (exit 2, nothing spawned)** when the manifest is missing/unreadable, `servingCheckout` is
  absent, or the derived cluster dir does not exist / is not inside the env root — so it cannot
  attach the child to the machine-global shared cluster. It prints `START_PID`, readiness/port-owner
  facts, the Names-Block receipt, and the NATIVE window enumeration.
  **`-DryRun`** (`-Action Launch -DryRun`) prints the resolved env block, exe and exact argv and
  exits 0 without spawning — run it FIRST and paste it as the isolation receipt.

- **`<exe>`** = the env's own binary as the product sees it, normally
  `apps/tauri/src-tauri/target/debug/fredo.exe` (the `pnpm tauri dev` build; `current_exe()` of the
  running app). Prefer `-AppPid <appPid>` when the app is already running (the instrument reads
  `Get-Process.Path`); pass `-Exe` when seeding before a launch.

- **Window visibility is read NATIVELY, never from the product's own window registry.** This
  feature declares `app.windows[0].visible = false`, so `main` EXISTS from launch while nothing is
  shown: `app_lifecycle_status.mainWindowOpen` is existence-only
  (`infrastructure/tray.rs:342-347`) and `tauri_manage_window action="list"` lists a hidden window
  (the resident-shell suite's N-1 says so). **The discriminating reading is the predicate
  "no VISIBLE top-level window owned by the app PID, excluding class `ConsoleWindowClass`"**, which
  `launch-background.ps1` evaluates from `EnumWindows` + `IsWindowVisible` + `GetClassName` and
  prints as `VISIBLE_PRODUCT_WINDOW=<True|False>` with the whole per-PID `WINDOW_LIST` (each entry
  carries `visible`, `class`, `title`), `CONSOLE_WINDOW_COUNT`, and
  `VISIBLE_NON_CONSOLE_WINDOW_TITLES`. `ConsoleWindowClass` is excluded BY CLASS because a debug
  build's console is a visible top-level window titled with the exe path — the QAs own build
  artifact, not a product surface. **`MAIN_WINDOW_HANDLE` is a DIAGNOSTIC, never the predicate**: it
  is `Get-Process.MainWindowHandle`, which reports the first visible titled window and can be the
  console (this is exactly why the round-1 `MAIN_WINDOW_HANDLE=0` literal was unattainable).
  A listed-but-hidden `main` entry is **NOT** a FAIL. Paste the raw
  `tauri_manage_window action="list"` output beside them; if that record carries a visibility field
  it must read `false`, and if it carries none, say so. `DESKTOP_WINDOW_COUNT=0` means the
  enumerator itself failed — an instrument failure (exit 2), never "no window".

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
  `start` re-pointed at it (target every later webview call with `windowId='app-settings'`) → click
  `[data-testid="settings-nav-ingest"]` → wait for
  `[data-testid="settings-ingest-autostart-section"]`. The toggle input is
  `[data-testid="settings-ingest-autostart-toggle"] input`; click it with `fireEvent`-style
  `element.click()` inside `execute_js` (or `tauri_webview_interact`).

- **THE PANE READING (one snippet, used by F-2, F-6, F-9, F-10, F-11, F-12)** — paste it into
  `tauri_webview_execute_js(windowId='app-settings', script=…)` verbatim:

  ```
  (() => { const s = document.querySelector('[data-testid="settings-ingest-autostart-section"]');
    if (!s) return 'NO_SECTION';
    const st = s.querySelector('[data-testid="settings-ingest-capture-status"]');
    const dt = s.querySelector('[data-testid="settings-ingest-capture-detail"]');
    const reg = s.querySelector('[role="status"]');
    const inp = s.querySelector('[data-testid="settings-ingest-autostart-toggle"] input');
    const flat = (n) => n ? n.textContent.replace(/\s+/g, ' ').trim() : null;
    const scopeWanted = 'Capture runs whenever Fredo is running \u2014 including when no Fredo window is open. It stops when you quit Fredo.';
    const scopeEl = [...s.querySelectorAll('*')].find((n) => n.children.length === 0 && n.textContent.trim() === scopeWanted);
    return JSON.stringify({
      status: flat(st), detail: flat(dt),
      regionCount: s.querySelectorAll('[role="status"]').length,
      regionAriaLive: reg ? reg.getAttribute('aria-live') : null,
      regionAriaAtomic: reg ? reg.getAttribute('aria-atomic') : null,
      regionAriaBusy: reg ? reg.getAttribute('aria-busy') : null,
      scopePresent: !!scopeEl,
      scopeOutsideRegion: scopeEl && reg ? !reg.contains(scopeEl) : null,
      switchChecked: inp ? inp.checked : null,
      switchDisabled: inp ? inp.disabled : null,
      retiredStatusPresent: s.querySelector('[data-testid="settings-ingest-autostart-status"]') !== null,
      daemonStatusPresent: s.querySelector('[data-testid="settings-ingest-daemon-status"]') !== null,
      timing: flat(s.querySelector('[data-testid="settings-ingest-autostart-timing"]')),
      sectionText: flat(s) }); })()
  ```

  `status` is the NEW capture word line, `timing` the login-entry line (unchanged id).
  `scopeOutsideRegion` is the AC1/Rule-2 predicate (the permanent scope sentence must sit OUTSIDE
  the live region so it is never announced and never replaced). **The `\u2014` in the snippet is the
  em dash of the copy table** — if you retype the string by hand, retype the em dash, not a hyphen.
  A row that names a value reads it from this object; a row that names an ABSENCE reads the
  corresponding boolean or searches `sectionText` case-insensitively.

- **CLOSING A WINDOW (F-11) — the committed close lever is the core window plugin, not a new
  instrument:** from any SURVIVING window,
  `tauri_webview_execute_js(script="(() => __TAURI__.core.invoke('plugin:window|close', { label: 'main' }))()")`
  (capability `core:window:allow-close` is granted to `main`/`app-*` in
  `apps/tauri/src-tauri/capabilities/default.json:14`; `Window::close()` emits
  `RunEvent::CloseRequested` then destroys — the same path the title-bar X takes;
  `resident-shell/functional.md:37-41` drives it and `F-5` proves a second window survives it).
  Verify the close from the OUTSIDE: `tauri_manage_window(action="list")` no longer lists that
  label, and `…invoke('app_lifecycle_status')` reads `mainWindowOpen:false` with `trayItems` still
  `[{id:"tray-open",label:"Open"},{id:"tray-quit",label:"Quit"}]` while the PID is alive.
  **With the LAST window closed there is no webview to invoke from** — reopen `main` with the
  webview-free seam (`resident-shell/second-launch.ps1`, F-1c) and continue from there; never
  conclude "capture stopped" from an empty window list.

- **Spans.** Inject with the committed lever:
  `bun .opencode/scripts/inject-otlp-fixture.ts --port <ports.otlpGrpc> --count 1 --prefix e2e-bg3195-<guid8>`.
  Read back by the printed `span_id`/`trace_id`:
  `SELECT span_id, trace_id, session_id, span_name, transport, end_time_ns, ingested_at FROM telemetry_spans WHERE attributes_json LIKE '%e2e-bg3195-<guid8>%' ORDER BY ingested_at DESC`
  via `powershell -File .opencode/skills/telemetry-query/telemetry-query.ps1 -Manifest <manifest> -Format md -Query "<SQL>"`.
  **G-375 fallback:** if the keychain auth fails, read the same SQL with the app's `db_query_execute`
  (`mode:'all'`) from a surviving window and state the substitution verbatim. The CLI `emit` path
  writes no spans (G-256) — it is not a span lever.
- **Registry hygiene:** every mutating `registry-entry.ps1` mode auto-backs-up the host's current
  value — **pass `-BackupPath .opencode/tmp/3195/registry-backup.json` on every call so this round's
  backup is its own** (the script's default is the #3193 path). **Finish each row that mutates with
  `-Restore -BackupPath .opencode/tmp/3195/registry-backup.json`** (and say so in the receipt) — the
  per-user Run key is real machine state. A row that must START from "nothing installed" takes its
  own backup first (`-Backup`) and clears (`-Clear`), then `-Restore` at the end.

## F-0 (PREFLIGHT, non-AC) — the registry instrument is first-green on THIS tip

- [ ] **F-0 — `registry-entry.ps1` reads both states without erroring, and fails closed on a bad
  INPUT.** The instrument was repaired in #3193 (an absent-value exit 2, a `$backup`/`[switch]$Backup`
  name collision, a missing Names-Block); it must be shown green on the tip the round serves before
  any row's verdict rests on it (G-406/G-460).
  With the env up, run three legs through the wrapper, each ONE shell call:
  (i) `run-exitcode.ps1 -Command "powershell -File .opencode/tests/background-capture/registry-entry.ps1
  -Read -AppPid <appPid> -BackupPath .opencode/tmp/3195/registry-backup.json"`;
  (ii) `run-exitcode.ps1 -Command "powershell -File .opencode/tests/background-capture/registry-entry.ps1
  -Read -Exe C:\\does\\not\\exist\\fredo.exe"`;
  (iii) `run-exitcode.ps1 -Command "powershell -File .opencode/tests/background-capture/registry-entry.ps1
  -Restore -BackupPath .opencode/tmp/3195/no-such-backup.json"`.
  **Expected:** (i) `EXITCODE=0`, `INSTRUMENT=registry-entry.ps1`, `MODE=Read`,
  `VALUE_PATH=HKCU\Software\Microsoft\Windows\CurrentVersion\Run\FredoIngest`,
  `ENTRY=Present|Absent` (either is a reading), `RESULT=OK`, and `BACKUP_PATH=` naming the
  `3195/` path it will use; (ii) `EXITCODE=2` with an `ERROR:` line naming the missing executable —
  a genuinely absent INPUT is the non-zero case, never a reading; (iii) `EXITCODE=2` with
  `ERROR: no backup to restore at …` — an absent backup is an absent input.
  **Any other exit code / a blank `ENTRY=` line means the INSTRUMENT is the defect:** report it and
  do not judge F-2/F-3/F-9…F-12 on it this round (G-469: two empty readings are equal).
  **Edge:** the (i) reading must be attributable to THIS host's HKCU — paste `USER_SID=` and
  `RESOLVED_FROM=`; a row that reports a value with no resolved path is not a reading.

## F-1 (R-1 / AC1) — `--background` is resident with no window shown, and capture is active

- [ ] **F-1a — the launch is resident, owns its ports, and shows NO visible product window.**
  Bring the env up once (`dev-env.ps1 -Action Up`, bounded) so the manifest exists and the build is
  current, then stop it CLEANLY with `dev-env.ps1 -Action Down` — the background instance needs the
  env's PG data-dir lock and its OTLP/MCP ports, which the foreground app holds. (Do NOT just kill
  the app: the `tauri dev` launcher owns it and would race you.) Run
  `launch-background.ps1 -Action Launch -DryRun -ManifestPath <manifest>` ONCE and paste it (the
  isolation receipt: the child's exact env), then
  `launch-background.ps1 -Action Launch -ManifestPath <manifest> -Exe <exe>`.
  **Expected:** `RESULT=PASS`, `ALIVE=True`, `NEW_FREDO_PIDS` contains `START_PID`,
  `OTLP_GRPC_READY=True`, `OTLP_HTTP_READY=True`, `MCP_READY=True` and
  `PORT_OWNERS_SAME_PID=True` (one process owns both OTLP binds and the bridge);
  **`VISIBLE_PRODUCT_WINDOW=False`** with `VISIBLE_NON_CONSOLE_WINDOW_COUNT=0` and
  `VISIBLE_NON_CONSOLE_WINDOW_TITLES=` empty, judged on the printed `WINDOW_LIST` (a visible
  `ConsoleWindowClass` entry is EXCLUDED by class and is NOT a failure; `MAIN_WINDOW_HANDLE` may be
  non-zero and is a diagnostic only);
  **isolation:** the pasted block's `FREDO_PG_DATA_DIR` is `<env-root>/postgres` with
  `FREDO_PG_DATA_DIR_UNDER_ENV_ROOT=True` and `FREDO_PG_DATA_DIR_EXISTS=True`, and
  `ENV_POSTMASTER_PIDS` is NON-EMPTY with `PG_POSTMASTER_PIDFILE_PID` matching one of them — i.e.
  the child started the ENV's cluster, not the machine-global shared one. A child that attached
  anywhere else is a FAIL of this row (it also makes F-1b unreadable).
  **Corroboration (record, not a gate):** `tauri_manage_window(action="list")` contains no *visible*
  main window (a hidden `main` entry is not a failure), and `tasklist /FI "IMAGENAME eq fredo.exe"
  /FO LIST` for `START_PID` may show either a console entry or none.
  **Environment caveat (disclosed, not a FAIL):** `dev-env Down` also stops the env's Vite
  dev-server, so this instance's webview has no `devUrl` to load. AC1's observables (resident
  process, owned ports, no shown window, a persisted span) do not depend on it; the pane legs
  (F-2 onward) bring the env back up with `dev-env.ps1 -Action Up`.
  **Edge:** a port already bound by a stray process (readiness never reached ⇒ the row FAILs on the
  port-owner clause, never as a silent skip); a leftover `fredo.exe` must not absorb `START_PID`'s
  ports (the census pins the owner PID); `DESKTOP_WINDOW_COUNT=0` or any `ERROR:` line with exit 2
  from the launcher is an INSTRUMENT failure to fix, never a product FAIL.

- [ ] **F-1b — ingestion is ACTIVE with no window (the decisive live leg).**
  With F-1a's process running (the one whose printed block carries this env's
  `FREDO_PG_DATA_DIR`), note the wall clock `T0` (`Get-Date -Format o`), inject ONE span
  (`--prefix e2e-bg3193-<guid8>`) into the env's `ports.otlpGrpc`, then read `telemetry_spans`
  by that prefix.
  **Expected:** exactly ONE row; `end_time_ns IS NOT NULL`; `ingested_at` LATER than `T0`; the
  injector's `CONFIRM` line (with `trace_id` and `span_id` hex) pasted verbatim. The read must be
  served by the ENV's cluster (`ENV_POSTMASTER_PIDS` from F-1a prints the cluster's PID;
  `telemetry-query.ps1 -Manifest <manifest>` targets the same env) — a receipt that cannot be read
  because the child wrote somewhere else is a FAIL of F-1a's isolation clause, not a skip.
  **Corroboration (record, do not gate):** try `tauri_webview_execute_js` against `main`. If it
  answers, paste `1+1` → 2 and `document.visibilityState`/`document.hidden`. If it cannot attach,
  record `NO_WEBVIEW_AT_BACKGROUND_LAUNCH` — the strongest available form of "no window shown" —
  and rely on F-1a's `VISIBLE_PRODUCT_WINDOW=False` as the binding proof. Never substitute a
  screenshot for the span.
  **Edge:** G-375 auth failure ⇒ `db_query_execute` fallback, disclosed; an injection into a
  second resident env must not qualify (prefix match is per run).

- [ ] **F-1c — the tray `Open` path shows the window in the SAME process (webview-free seam).**
  With the background instance still hidden, run the resident-shell lever
  `run-exitcode.ps1 -Command "powershell -File .opencode/tests/resident-shell/second-launch.ps1
  -ManifestPath <manifest> -Exe <exe>"` — its argv has NO `--background`, so the probe sends
  `CliCommand::OpenMainWindow`, the SAME `ensure_main_window` the tray item dispatches. Then re-read
  `launch-background.ps1 -Action Windows -ManifestPath <manifest>`, `tasklist`, and
  `tauri_manage_window(action="list")`.
  **Expected:** **`VISIBLE_PRODUCT_WINDOW=True`** with `VISIBLE_NON_CONSOLE_WINDOW_COUNT>=1` and
  `VISIBLE_NON_CONSOLE_WINDOW_TITLES` carrying the per-env title `Fredo [<envId>]` (legacy `Fredo`
  on slot 0), corroborated by `tasklist` `Window Title`; the background PID is UNCHANGED
  (`TARGET_PID == START_PID`); `SECOND_EXITED=True`, `NEW_FREDO_PIDS=` EMPTY and
  `POSTMASTER_BEFORE`/`AFTER` identical **and non-empty**; the window list now carries a VISIBLE
  `main`; and — only when the env's Vite is serving (see F-1a's caveat) — the console has no
  `Error:`/`Uncaught`/`Maximum update depth exceeded`. A failed page load in the no-Vite state is an
  ENVIRONMENT artifact: record it, do not FAIL AC1 on it.
  **Record which build route was taken (NOT a pass/fail literal):** a shown hidden window vs a
  window built on demand are both AC1-compliant (`triage.md` §8(a)/(b) are UNVERIFIED). A FAIL is a
  changed PID, a still-`False` `VISIBLE_PRODUCT_WINDOW`, or a SECOND `main`. (`MAIN_WINDOW_HANDLE`
  may already be non-zero before the `Open` because of the debug console — it is never the
  witness here.)
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

## F-2 (R-2 / AC2) — the login entry is exactly `"<exe>" --background`, and the pane shows the REGISTRY

> #3195 note: AC2 is a **regression invariant**, not new work — #3193 shipped the write path and the
> read-back (`ingestAutostartStore.ts:80-109`, `IngestAutostartSettings.tsx:105-119`). These rows
> prove it still holds after the status line moved off the login-entry boolean. **The retired
> `settings-ingest-autostart-status` line no longer states the sign-in state**: the switch's
> `checked` state and the `settings-ingest-autostart-timing` line are now its ONLY rendered
> statement, so every wait below reads `switchChecked` / `timing` from the PANE READING snippet.

- [ ] **F-2a — enabling writes the exact owned command.**
  From a cleared value (`registry-entry.ps1 -Clear -BackupPath .opencode/tmp/3195/registry-backup.json`,
  which prints `DELETE_VERIFIED=Absent`), open Settings → Background capture and click the toggle ON;
  wait for the PANE READING's `switchChecked:true` **and** `timing` =
  `Takes effect the next time you sign in. Nothing else changes now.`
  (the settled pair — `timing` must no longer read `Applying…`; UI/UX A-1 changed this sentence,
  and the pair is the only rendered statement of the sign-in state since
  `settings-ingest-autostart-status` is retired).
  Then read the registry with `-Read -AppPid <appPid> -BackupPath .opencode/tmp/3195/registry-backup.json`.
  **Expected:** `ENTRY=Present`, `VALUE_KIND=String`, `RAW_EQUALS_EXPECTED=True`,
  `EXPECTED_OWNED_RAW=` equals `"<exe>" --background` with the instrument's `EXE=` path, and the
  token breakdown shows `QUOTE_COUNT=2`, `QUOTE_OPEN=True`, `SEPARATOR_SPACES=1`,
  `TAIL_TRIMMED=--background`, `TAIL_IS_BACKGROUND=True`, `TAIL_IS_INGEST=False`,
  `TRAILING_WHITESPACE=False`, `RAW_LENGTH == EXPECTED_OWNED_LENGTH`; `EXE_MATCH_CURRENT=True`
  (record `EXE_MATCH_RULE`, `canonical` preferred). Paste `RAW=`, `RAW_LENGTH`, `RAW_SHA256` and the
  `reg.exe` corroboration line verbatim.
  The capture-status line is INDEPENDENT of this: whatever it reads, it must not be used to infer
  the sign-in state, and `sectionText` must not contain the retired form
  (`Background capture: On` / `Background capture: Off` /
  `Background capture: Unavailable on this platform`).
  **Edge:** an exe path containing spaces (the dev build path does not — record which was used);
  enabling twice in a row (idempotent, same `RAW_SHA256`); the value must hold ONE value name —
  `-Read` prints `VALUE_PATH=` so a second name is visible in the paste.

- [ ] **F-2b — disabling removes it, and a disable with nothing installed succeeds.**
  Click the toggle OFF; wait for PANE READING `switchChecked:false`; read with
  `-Expect Absent -BackupPath .opencode/tmp/3195/registry-backup.json`.
  **Expected:** `ENTRY=Absent`, `EXPECTATION_MET=True`, `ACTUAL_ENTRY=Absent`, exit code **0**;
  `RAW=` empty, `RAW_SHA256=(absent)`, `VALUE_KIND=(none: the value does not exist)`,
  `REG_EXE_QUERY_CODE=1`; the surface's `timing` = `The login item is removed. Nothing changes in
  this session until you quit Fredo.` (UI/UX A-1's claim-free replacement — the retired
  `This session keeps capturing until you quit Fredo.` asserted that capture was happening and is
  now a FAIL if rendered) and no error line. Then run `-Clear` again — it
  prints `CLEAR_WAS_ALREADY_ABSENT=True` + `DELETE_VERIFIED=Absent` and exits 0 (an already-absent
  target is a NO-OP, not an error) — and click OFF once more: the call succeeds (no error text,
  `switchChecked:false`, `EXPECTATION_MET=True`).
  **INVERTED by #3195:** this row previously waited for the status text `Background capture: Off`.
  That string is DELETED; the OFF statement is `switchChecked:false` + `DETAIL_OFF_JUST_SET` /
  `DETAIL_OFF` (`Fredo does not start when you sign in.`). A pane that still renders
  `Background capture: Off` FAILs F-9.
  **Edge:** disable twice; disable while the registry was removed out-of-band (the UI must settle
  on off from the read-back, not from its optimistic state — F-2c drives that out-of-band mutation
  deliberately).

- [ ] **F-2c (AC2, the discriminating leg) — the pane shows the REAL registry on MOUNT, never a
  cached value.** *This is the leg a cached/optimistic UI fails and a read-back UI passes; it is
  also #3195's guard that the status-line change did not smuggle a login-entry boolean into the
  pane.*
  Precondition: F-2a left the owned value PRESENT and the pane OPEN with `switchChecked:true`.
  1. CLOSE the `app-settings` window (`plugin:window|close`, label `settings`; see the close block)
     and confirm from `tauri_manage_window(action="list")` that it is gone. The pane is now
     UNMOUNTED, so nothing of it is on screen.
  2. **Mutate the registry OUT OF BAND** while no pane exists:
     `registry-entry.ps1 -Clear -BackupPath .opencode/tmp/3195/registry-backup.json` → paste
     `DELETE_VERIFIED=Absent`; then `-Read` → `ENTRY=Absent`.
  3. Reopen the window (`…invoke('open_app_window', { appId: 'settings' })` from `main`), navigate to
     Background capture, and read the PANE READING once the section exists.
  4. Then the reverse direction: toggle ON from the pane, close the window, `-Read` → `Present`;
     reopen and read.
  **Expected:** step 3's FIRST settled reading is `switchChecked:false` with
  `timing` = `Fredo does not start when you sign in.` — the pane reported the REGISTRY, not the
  `enabled:true` it had rendered before it unmounted; step 4's reading is `switchChecked:true`.
  Paste both readings and both `-Read` outputs as the pair (two non-empty readings of the same
  subject, G-469 — a `(absent)`-vs-`(absent)` pair proves nothing, so ONE leg must be Present).
  **A pane still showing `switchChecked:true` after step 3 is a FAIL of AC2.**
  **Edge:** change the registry to a FOREIGN value out of band instead
  (`-SeedForeign -BackupPath …`) → the pane must render the stale-entry Off state
  (`switchChecked:false`, `timing` = `Fredo does not start when you sign in.`) with no error line;
  do the out-of-band mutation while the settings window is open but on ANOTHER nav section (the pane
  must still read the registry when it mounts, not when the app started).

- [ ] **F-2d — the row leaves the host as it found it.** After F-2a…F-2c:
  `registry-entry.ps1 -Restore -BackupPath .opencode/tmp/3195/registry-backup.json` → **Expected:**
  `EXITCODE=0`, `RESTORED_MATCH=True`, `RESTORED=Present|Absent` matching the value F-0 recorded
  BEFORE any mutation (paste F-0's `ENTRY=` beside it), `RESULT=OK`. A mismatch is a FAIL of the
  row's hygiene, never a product defect — but it must be reported, because the per-user Run key is
  real machine state.
  **Edge:** the pre-test state was `Absent` → `RESTORED=Absent` and the host has no entry again.

  **Instrument note:** an `ERROR:` line with exit 2 here is the INSTRUMENT being wrong (it must
  never exit 2 on an absent value) — report it, do not FAIL AC2 on it.

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
  **Expected:** the pane's `switchChecked` is `false` and `timing` is `DETAIL_OFF`
  (`Fredo does not start when you sign in.`) — derived from
  `enabled: true, owned: false, available: true`, never as an error (`status.error` absent, no
  `Could not update background capture:` line, `timing` contains no `Could not update`). Toggle ON
  then OFF; after the OFF, `-Read` the registry: `ENTRY=Present` and `RAW_SHA256` STILL the foreign
  digest — disable did not delete a value this product does not own.
  **INVERTED by #3195:** this row previously asserted the rendered `Background capture: Off` line and
  the DETAIL_OFF sentence `… Capture runs only while Fredo is open.` Both are gone: the retired
  status id is absent (`retiredStatusPresent:false`) and the "only while Fredo is open" clause is a
  FALSE stopped-claim the spec removes. `sectionText` must NOT contain `only while Fredo is open`.
  The capture-status line is independent here — whatever it reads, it may not be read as the
  sign-in state.
  **Edge:** toggle ON with the foreign value present (F-3e) — the surface must not claim it was
  already correct; `ingest_autostart_get` alone (open the pane, change nothing) must leave the
  registry byte-identical (read-only contract).

- [ ] **F-3e — enabling RECOVERS a foreign value (the documented recovery path).**
  From F-3d's foreign state, click the toggle ON and wait for PANE READING `switchChecked:true`.
  **Expected:** `-Read` shows `RAW_EQUALS_EXPECTED=True`, `TAIL_IS_BACKGROUND=True`,
  `TAIL_IS_INGEST=False`, `RAW_SHA256` = the owned form's digest; the surface's `timing` is
  `DETAIL_ON_JUST_SET`. Because OFF intentionally left the foreign value in place, the switch shows
  unchecked before the click even though `enabled` was true — record the exact pre-click
  `switchChecked` + `timing` pair so the stale-entry honesty is visible.
  **INVERTED by #3195:** the pre-click observation was `Background capture: On`-shaped text; it is
  now `switchChecked:false` + `DETAIL_OFF`. Do not wait on any status text here.
  **Edge:** the foreign value names ANOTHER Fredo installation path (must be classified foreign by
  canonical-equality, then recovered by the same enable).

## F-4 (R-4 / AC4) — toggling spawns no second process and does not interrupt ingestion

- [ ] **F-4a — PID / postmaster / listener census is IDENTICAL across the toggle.**
  With the env up, the value cleared, and Settings → Background capture open, take the LEFT census:
  `run-exitcode.ps1 -Command "powershell -File .opencode/tests/resident-shell/lifecycle-probe.ps1
  -Action Inventory -ManifestPath <manifest>"` (paste `APP_PID`, `FREDO_PROCS`, `POSTMASTER_COUNT`,
  `POSTMASTER_PIDS`, `PG_DATA_DIR_EXISTS=True`, `PG_POSTMASTER_PIDFILE_MATCH=True`) plus
  `powershell -File .opencode/scripts/process-hygiene.ps1 -List`. Note the wall clock `T0`. Toggle
  ON, wait for the settled pair (PANE READING `switchChecked:true` **and** `timing` no longer
  `Applying…`) / `-Read -Expect Present`, toggle OFF, wait for `switchChecked:false` + settled
  timing / `-Expect Absent`. Re-run BOTH census commands (RIGHT).
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
  alone must NOT be a parse error (it starts the app — F-1a proves it). **Superseded by #3194:**
  this edge previously said "`fredo ingest --help` is unchanged (the retained subcommand is out of
  scope)". That subcommand was **REMOVED**; the assertion now lives in
  `.opencode/tests/resident-ingest/functional.md` **F-9** (`--help` lists no `ingest`;
  `fredo ingest --help` exits **1** as a clap unknown-subcommand error) and the seam absence in
  **F-12**. Do not assert an "unchanged ingest help" here.

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
  **INVERTED by #3194 (was "out of scope, recorded not failed"):** the retired subcommand is now a
  POSITIVE absence assertion, not a parked item. The sweep below extends to the product documents
  that used to offer it — `docs/CLI_GUIDE.md`, `docs/SETUP.md`, `docs/SECURITY.md`,
  `docs/ARCHITECTURE.md`, `docs/FAQ.md` — and any hit for the literal `fredo ingest` outside the
  legacy-VALUE allowlist (`applications/settings/autostart.rs` + its tests,
  `__tests__/IngestAutostartSettings.test.tsx` RETIRED_COPY, `.opencode/tests/**`) is a **FAIL** of
  `.opencode/tests/resident-ingest/functional.md` **F-9(4)**, reported there with its file:line.
  The two legacy-migration sentences (`docs/CLI_GUIDE.md:252`, `docs/SETUP.md:241`) stay
  **byte-identical** — they narrate a stored registry VALUE, not a mode (owned by **#3196 ST-5**);
  they are reported with their owner, never FAILed here.
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

## F-6 (ST-2 / R-5b) — the Settings → Background capture pane: the sign-in control renders every state, and none of the retired copy survives

> #3195 note: this group's subject is now **the LOGIN-ENTRY statement** (switch + timing line).
> The capture-status line has its own rows (F-9/F-10). The retired `settings-ingest-autostart-status`
> id and its `Background capture: On|Off|Unavailable on this platform` strings are ABSENT
> everywhere, in every state — F-9c is the cross-state absence row.

- [ ] **F-6a — steady ON and steady OFF.**
  With the value enabled (F-2a state) open the pane; then disable and re-read the pane.
  **Expected:** ON: PANE READING `switchChecked:true` and `timing` =
  `Fredo starts in the background the next time you sign in.`; OFF: `switchChecked:false` and
  `timing` = `Fredo does not start when you sign in.`; the toggle's accessible name is
  `Start background capture when I sign in`; `retiredStatusPresent:false` in BOTH states; and in
  BOTH states the capture-status line (`status`) is one of the three capture strings — it is
  NEVER `Background capture: On` / `Background capture: Off`.
  **INVERTED by #3195:** this row previously read the two truth values off
  `[data-testid="settings-ingest-autostart-status"]` (`Background capture: On` / `… Off` +
  `… Capture runs only while Fredo is open.`). That element and those strings are DELETED. The
  sign-in state is stated by the switch + `timing` only, and `sectionText` must NOT contain
  `only while Fredo is open` in any state.
  **Edge:** reopening the pane after a restart (the just-set sentence must be GONE — it is component
  state, not persisted).

- [ ] **F-6b — in-flight, just-set, and error states.** *(confirmed byte-identical by #3195 — this
  row states the timing line, never the retired status text, so the id change does not touch it)*
  Toggle and sample the pane immediately (0–1 s) and after it settles; then induce an error (a
  registry-write failure is not reachable without a seam — drive the store's rejection path only if
  ST-2 exposes one, otherwise record the error-state leg as a UNIT-PIN leg and say so).
  **Expected:** during the write the timing line is `Applying…` and the toggle is `disabled`;
  settling ON yields `Takes effect the next time you sign in. Nothing else changes now.`; settling
  OFF yields `The login item is removed. Nothing changes in this session until you quit Fredo.`;
  the error leg renders `Could not update background capture: <message>` with the switch REVERTED to
  the prior value and no color-only signal. **(#3195 copy note:** the two just-set sentences are
  UI/UX A-1's claim-free rewrites; the pre-#3195 strings claimed capture was happening —
  `This session is already capturing…` / `This session keeps capturing until you quit Fredo.` — and
  rendering either is now a FAIL.)**
  **Edge:** rapid toggle ON→OFF before the first write settles (final state matches the registry,
  not the last click); `aria-busy="true"` while applying (`regionAriaBusy:"true"` — the region also
  carries `aria-busy` while the CAPTURE read is unresolved, so read `switchChecked`/`timing` for the
  write state); exactly ONE polite live region in the section (`role="status"` + `aria-live="polite"`
  + `aria-atomic="true"` ⇒ `regionCount:1`, `regionAriaLive:"polite"`, `regionAriaAtomic:"true"`).

- [ ] **F-6c — hooks present, retired hooks ABSENT.**
  `tauri_webview_dom_snapshot(type="structure")` on `app-settings` with the pane open, plus the PANE
  READING.
  **Expected:** present — `settings-nav-ingest`, `settings-ingest-autostart-section`,
  `settings-ingest-autostart-toggle`, `settings-ingest-autostart-help`,
  `settings-ingest-autostart-timing`, **`settings-ingest-capture-status`**,
  **`settings-ingest-capture-detail`**; ABSENT — `settings-ingest-daemon-status` (stays absent) **and
  `settings-ingest-autostart-status`** (RETIRED by #3195; `retiredStatusPresent:false`), and no
  rendered `Daemon:` / `Entry:` / `Command:` / `Auto-start on login` text anywhere in the section.
  **Edge:** the loading skeleton `settings-ingest-autostart-toggle-skeleton` appears on a cold,
  slow registry read and is replaced by the toggle (never a guessed `false` before the read
  settles); while the CAPTURE read is still in flight the region is `aria-busy:"true"` and the
  status line renders a skeleton — a guessed `Capture: Not running` before the first probe settles
  is a FAIL (that is the AC4 stopped-claim).

## F-7 (non-Windows contract) — `available: false` replaces the current `Err`

- [ ] **F-7 (UNIT/STATIC pin + NAMED BLOCKER) —** read
  `applications/settings/autostart.rs` and the vitest file for the pane.
  **Expected (pin):** on non-Windows, `ingest_autostart_get` and `ingest_autostart_set` return
  `Ok(IngestAutostartView { enabled: false, command: None, entry: None, available: false, owned: false })`
  WITHOUT invoking `reg.exe` (the `#[cfg(not(target_os = "windows"))]` leg), and a committed test
  renders the pane's `available: false` state as a DISABLED switch + `timing` =
  `The login item is available on Windows only for now.` with no error styling. Paste the test name
  and its pass line (`pnpm --filter @fredo/ui build`/`vitest` run output).
  **INVERTED by #3195:** the retired `Background capture: Unavailable on this platform` line is
  DELETED, and the DETAIL_UNAVAILABLE sentence is **UI/UX A-1's** rewrite —
  `The login item is available on Windows only for now.` with the trailing capture claim
  (`Fredo still captures while it is running.`) REMOVED, because it contradicts a capture line
  reading `Capture: Not running` directly above it. The pin now asserts (i) the new sentence
  verbatim, (ii) the retired line ABSENT, (iii) `sectionText` contains no `while it is open`, no
  `while it is running` (the removed claim's surviving fragment) and no
  `Unavailable on this platform`, and (iv) the CAPTURE line is still rendered and INDEPENDENT of
  `available` — an unavailable login item does not mean capture is off, so the capture line must
  never read `Capture: Status unavailable` BECAUSE the login item is unavailable (it reads whatever
  `stream_health` reports).
  **Named blocker (live leg):** this host is Windows, so the live non-Windows rendering cannot be
  driven; record the pin as the receipt and say the live leg is unavailable (G-053), never a FAIL.
  *(The `available:false` DOM shape is also unit-pinned; the live leg for the CAPTURE line's
  independence is F-10a, which runs on Windows with `available:true`.)*

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

## F-9 (#3195 R-1 / AC1) — the section describes capture as PROCESS-scoped, and no daemon vocabulary survives

> The user-visible strings in this group are the **UI/UX Expert's** copy table (`## UI/UX Expert`,
> cross-checked against the Architect's `### Binding Names (contracts)`); where the two disagree the
> UI/UX text wins and the disagreement is a plan defect to report. Quote them character for
> character — the `CAPTURE_SCOPE` sentence contains an **em dash `—` (U+2014)**; a receipt that
> normalises it to `-` is not the copy.

- [ ] **F-9a — the permanent process-scoped sentence is rendered, in every state.**
  Open Settings → Background capture (env up, normal launch) and read the PANE READING's
  `sectionText`.
  **Expected:** `scopePresent:true` and **`scopeOutsideRegion:true`** (`!statusEl.contains(scopeEl)` —
  the sentence sits outside the live region, so it is never announced and never replaced by a state
  word), `sectionText` CONTAINS, verbatim,
  `Capture runs whenever Fredo is running — including when no Fredo window is open. It stops when you quit Fredo.`
  and still contains the section help `Capture agent activity even when no Fredo window is open.`
  The sentence is PERMANENT — sample it again after a toggle ON, after a toggle OFF, with the
  capture line in the `not running` state (F-10b) and in the `unavailable` state (F-7's pin): it must
  be present in all of them.
  **Paste:** the `sectionText` verbatim from the running state, plus the sentence's presence in the
  other samples.
  **FAIL:** the sentence absent in any state, or present only in the live region (a state word
  replacing it means AC1's description disappears exactly when the operator needs it).
  **Edge:** an em-dash rendered as `--`/`-`/`â€"` (encoding defect) — report it against the copy
  table, do not normalise.

- [ ] **F-9b — none of the retired vocabulary is rendered (case-insensitive, text AND attributes).**
  With the pane open, take `sectionText` and the section's `outerHTML`.
  **Expected:** lowercased `sectionText` contains NONE of `daemon`, `attach` (`attached`,
  `attachment`, `attach mode` all contain it), `headless`, `second process`, `background process`.
  The `outerHTML` adds no `title=` / `aria-label=` / `placeholder=` carrying any of them either
  (render the section's attribute values into the search — a tooltip is not `textContent`).
  **FAIL:** any of the five tokens anywhere in the section's rendered text or its attributes.
  **Edge:** the words in an ADJACENT nav item are not this section (scope the search to the
  section element); a match inside a `data-` attribute VALUE that is not user-visible is
  dispositioned, not failed (record it).

- [ ] **F-9c — the retired STATUS FORM is absent in EVERY pane state (the cross-state pin).**
  Sample the PANE READING once in each state the round reaches and tabulate them:
  (1) cold mount (before the registry read settles), (2) capture running (F-10a),
  (3) capture not running (F-10b), (4) probe unreadable (F-10d), (5) toggle in flight (F-6b's
  `Applying…` window), (6) toggle error (F-6b's error leg, if a seam exists).
  **Expected:** for EVERY row of that table: `retiredStatusPresent:false`, and `sectionText`
  contains NONE of `Background capture: On`, `Background capture: Off`,
  `Background capture: Unavailable on this platform`, `only while Fredo is open`,
  `still captures while it is open`. The section TITLE `Background capture` is of course still
  present (the token to search is the `: On`/`: Off`/`: Unavailable` FORM, not the words alone).
  **FAIL:** any state still rendering the retired form — a half-done swap (the old line kept beside
  the new one) is exactly what this row exists to catch.
  **Edge:** state (6) is only available if ST-2 exposes a write-failure seam; if it does not,
  record it as the UNIT-PIN leg of F-10e and say so — never fabricate it.

- [ ] **F-9d — the section offers no second-process affordance.**
  Enumerate the interactive elements inside the section: `s.querySelectorAll('button, a, input,
  select, [role="button"], [role="link"]')` — paste each one's tag, `type`/`role` and accessible
  name.
  **Expected:** the only interactive control is the toggle's `input` (accessible name
  `Start background capture when I sign in`); there is no link, no button and no sub-control that
  starts, attaches to, or installs a second process.
  **Non-gate observation (record, do not FAIL):** whether the section renders any URL or `:<port>`
  plumbing text — the retired surface did, and its return would be worth reporting even though AC1
  names only the daemon vocabulary.
  **Edge:** the `Switch.Control` (a non-interactive visual) must not be counted as a control; count
  the `input`, not the styled span.

## F-10 (#3195 R-3 / AC3) — ONE section-local `role="status"` line, and it reflects RUNNING / NOT RUNNING

> **The line is derived from a `stream_health` read the webview performs.** The backend lever is
> `FREDO_STREAM_HEALTH_FORCE` on the app's own launch (see "How these rows are driven"); the
> FRONTEND force token moves only `useStreamHealth`'s consumers and is not a lever here.
> **The binding state definitions are the UI/UX Expert's state matrix (`## UI/UX Expert` §3, rows
> 1-10)** — the legs below map onto it: F-10a = row 2, F-10b = row 3, F-10c = row 3 (stale route),
> F-10d = row 5, F-10e = rows 1/4/6/7/8 at component level, F-10f = row 4 live. The copy strings are
> §2's table (which amends three of the Architect's in A-1 — bind to §2).
> Every leg cross-checks the BACKEND value from the same webview
> (`tauri_webview_execute_js(script="(async () => JSON.stringify(await __TAURI__.core.invoke('stream_health')))()")`)
> so the line is anchored to a real reading, not to the copy alone.
> F-10b, F-10c and F-10d are each a bounded `Down` + `Up -EnvVar` restart: budget the 3–5 min boot
> (G-386) and say so. F-10f is the resident-ingest lever's own launch.

- [ ] **F-10a — `running`: the line reads exactly `Capture: Running`, inside the section's ONE live
  region.**
  Env up normally (no force token), pane open, wait for the first probe to settle (the region's
  `regionAriaBusy` goes `"false"`; allow one 5 s tick).
  **Expected:** `status` = `Capture: Running` (exactly — paste it); `detail` is `null`/empty or
  contains no `not receiving` sentence (both accepted: the AC fixes the WORD LINE, and UI/UX §3 row 2
  says the detail is absent while running); `regionCount:1` with `regionAriaLive:"polite"` and
  `regionAriaAtomic:"true"` and the region INSIDE
  `[data-testid="settings-ingest-autostart-section"]`; `regionAriaBusy:"false"` at settle;
  `retiredStatusPresent:false`; backend cross-check `ingestConnected:true` with `ageMs` ≤ `15000`
  (⇒ `healthy`); `sectionText` still carries F-9a's sentence (`scopeOutsideRegion:true`).
  **Word colour (UI/UX A-2, G-235):** the status word's computed colour EQUALS the section title's
  computed colour — both `fg.default` — in all three states; the state HUE rides the decorative icon
  only (`status.success`/`status.warning`/`status.info`), never the text. Paste
  `getComputedStyle(statusEl).color` beside `getComputedStyle(h3).color` and the icon's colour.
  **Record, not a gate:** `document.querySelectorAll('[role="status"]').length` for the whole page
  (the status bar is itself a live region — a document-wide count is NOT this row's predicate,
  G-424).
  **FAIL:** `Capture: Not running` while the backend reads `healthy`; more than one `role="status"`
  inside the section; the line rendered outside the section; the word coloured by a status hue.
  **Edge:** the first 200 ms after mount (`regionAriaBusy:"true"`, status a skeleton whose
  `textContent` is empty — never a word) is the legitimate unresolved state; a
  `Capture: Not running` there is the AC4 stopped-claim and FAILs (F-10e pins the same at component
  level).

- [ ] **F-10b — `notRunning` via `ingest-down`: the line and its reason.**
  `dev-env.ps1 -Action Down` (bounded), then
  `dev-env.ps1 -Action Up -Spec 3195 -EnvSlot 1 -RequireIsolation -TimeoutSecs 420 -EnvVar "FREDO_STREAM_HEALTH_FORCE=ingest-down"`;
  open the pane, wait one tick.
  **Expected:** `status` = `Capture: Not running` (exactly); `detail` = 
  `Capture is not receiving agent activity right now.` (exactly — the untyped route names no
  receiver); backend cross-check `ingestConnected:false` and `forced:true` with `ageMs` ≤ `15000`
  (the heartbeats still emit — this is the "ingest down, process alive" case, NOT staleness);
  `regionCount:1`; the sign-in control is unaffected — record `switchChecked` + `timing` and assert
  they still describe the LOGIN ENTRY (with the entry absent, `switchChecked:false` and `timing` =
  `Fredo does not start when you sign in.` — UI/UX U-7's "entry OFF + capture not running" leg).
  **FAIL:** the reason detail is a stopped/daemon sentence; the card claims
  `Fredo is not running` (UI/UX U-4's explicit negative — the PROCESS is running, capture is not);
  the line reads `Capture: Running` while the backend reports `ingestConnected:false`; the sign-in
  control's text changed with the capture state (the two must be independent); any login-entry
  sentence asserting capture is happening (`still captures`, `keeps capturing`).
  **Edge:** the `/health` line elsewhere in the app is `Telemetry stalled` in this state — that is a
  DIFFERENT surface's wording and is not evidence for this row (do not copy it); the UI/UX matrix's
  row 3 is the binding state definition for this leg.

- [ ] **F-10c — `notRunning` via `degraded` (the stale-heartbeat route).**
  Restart the env with `-EnvVar "FREDO_STREAM_HEALTH_FORCE=degraded"`, open the pane, and wait
  **> 16 s** from the app's first paint (the stale window is `15 000 ms`) plus one 5 s pane tick,
  then re-read.
  **Expected:** `status` = `Capture: Not running`; backend cross-check `ageMs` > `15000` and
  `forced:true` (the probe still SUCCEEDS — this is the "process alive, heartbeat stale" case);
  `detail` is `Capture is not receiving agent activity right now.` (no receiver is named — nothing
  failed to bind).
  **FAIL:** `Capture: Running` while `ageMs` > 15000 (a line that reads only `ingestConnected`
  and ignores freshness); a detail naming a receiver/port (wrong route).
  **Edge:** sampling at 10 s is EXPECTED to still read `Capture: Running` — the stale window has
  not elapsed; record it as the pre-threshold control that proves the row is measuring freshness.

- [ ] **F-10d — the probe cannot be read ⇒ `Capture: Status unavailable`, never `Not running`
  (AC4's escape clause).**
  Restart the env with `-EnvVar "FREDO_STREAM_HEALTH_FORCE=down"`, open the pane, wait one tick.
  **Expected:** the backend invoke REJECTS (paste the rejection text,
  `stream health probe unavailable`); `status` = `Capture: Status unavailable` (exactly);
  `detail` = `Fredo could not report whether capture is running.` (exactly); `regionCount:1`.
  **FAIL (hard):** `status` = `Capture: Not running` — a failed READ is not a stopped CAPTURE, and
  this is the exact false claim AC4 forbids. Equally a FAIL: any wording that names a cause the
  backend did not report (a daemon, a second process, an attach state).
  **Edge:** a probe that times out rather than rejecting is the same class — the row is about the
  LINE, so record which failure shape occurred; a UI that instead shows a spinner forever FAILs
  (the region must settle on a word).

- [ ] **F-10e — COMPONENT matrix: every pane state has a component test (ST-2 work item (d)).**
  Run `run-exitcode.ps1 -Command "pnpm --filter @fredo/ui exec vitest run
  src/applications/ingest"` and read `src/applications/ingest/__tests__/IngestAutostartSettings.test.tsx`
  (and `__tests__/captureStatus.test.ts`, ST-1).
  **Expected:** `EXITCODE=0`; paste the run's file/test summary AND the reported test names. The
  pane test file contains a case for EACH of: **loading** (per-block skeletons; the capture word's
  `textContent` is EMPTY — never a word — and the sign-in state is not guessed), **capture running**
  (`Capture: Running` rendered from a wired `stream_health` response, detail absent),
  **capture not running** (`Capture: Not running` + `Capture is not receiving agent activity right
  now.`), **ingest failure** (`ingestFailure` carried on the snapshot ⇒ `Capture: Not running` with
  `Capture is not receiving agent activity: the gRPC telemetry receiver on port <port> could not
  start.` / `HTTP` for the `http` leg, receiver/port taken from the wire value — G-413's present
  case — and a malformed failure dropped to the untyped sentence), **unavailable**
  (`available:false` ⇒ disabled switch + `The login item is available on Windows only for now.`
  **and** the capture line unchanged/independent), **toggle in flight** (`Applying…`, switch
  disabled, `aria-busy:"true"`, and the capture word holds the last SETTLED state — never a
  skeleton, never a guess), **toggle error** (persistent `Could not update background capture:
  <msg>`, switch reverted, `aria-busy:"false"`); plus an ABSENCE pin for
  `settings-ingest-autostart-status` and for the retired copy, `aria-atomic="true"` on the one
  region, the scope sentence asserted OUTSIDE the region (`!statusEl.contains(scopeEl)` — UI/UX
  U-2), and an assertion that the invoke set contains no `pg_supervisor_status`.
  **The no-poll-spam leg (UI/UX U-10) is part of this row:** under fake timers, six 5 s ticks
  produce ≤ 1 `stream_health` invoke per tick, the region's `textContent` is byte-identical across
  all six, and `aria-busy` never flips during them (N-7 is the live counterpart).
  **FAIL:** a state with no case; a case that asserts a paraphrase (two artifacts pinning the same
  string must not disagree, G-466); the invoke set still calling `pg_supervisor_status`.
  **Edge:** a green suite whose titles promise a state its assertions do not read (e.g. a
  "not running" title over a `Capture: Running` assertion) — read the assertion, not the title
  (G-418).

- [ ] **F-10f — `notRunning` with the TYPED cause, live (the port-squat route).**
  Reuse the resident-ingest port-squat recipe — do NOT hand-roll a holder
  (`resident-ingest/functional.md` F-6 owns it; read that row before this one).
  1. With the env up, quit the app through the PRODUCT's own path
     (`…invoke('quit_app')`, the same one the tray `Quit` item dispatches) so the ports are free but
     the Vite dev-server keeps serving (the probe REFUSES, exit 2, when the incumbent app still
     runs or the frontend is not serving).
  2. `run-exitcode.ps1 -Command "powershell -File .opencode/tests/resident-ingest/otlp-conflict-probe.ps1
     -Manifest <manifest> -Exe <exe> -DryRun"` — paste the resolved block (it spawns and binds
     NOTHING).
  3. `run-exitcode.ps1 -Command "powershell -File .opencode/tests/resident-ingest/otlp-conflict-probe.ps1
     -Manifest <manifest> -Exe <exe> -Mode conflict -Receiver grpc -TimeoutSecs 480"`.
     **Note the parameter is `-Manifest`, not `-ManifestPath`**, and the probe LAUNCHES the app with
     the gRPC port held and leaves it running: take `<appPid>` for the rest of this row from the
     probe's printed launch facts (the env manifest still names the QUIT pid).
  4. Point the driver at the relaunched app and open the pane; wait one tick.
  **Expected:** the probe exits **0** with `HOLD_PROVEN=true`, `APP_READY=true`,
  `TARGET_LISTENER_ROWS=1`, `SIBLING_LISTENER_ROWS=0`, `HOLDER_RELEASED=true`; the backend snapshot
  carries `ingestFailure` with `receiver:"grpc"`, `port:<ports.otlpGrpc>`, `code:"addrInUse"` and a
  non-empty `message`; `status` = `Capture: Not running`; `detail` = 
  `Capture is not receiving agent activity: the gRPC telemetry receiver on port <ports.otlpGrpc> could not start.`
  (the `code` is deliberately NOT in the copy — record it, do not require it in the sentence).
  Paste the `stream_health` JSON beside the rendered detail so the port/receiver are attributable.
  **The `http` leg:** repeat 2–4 with `-Receiver http` after quitting this instance through
  `quit_app` again — expect `HTTP` and `<ports.otlpHttp>` in the sentence and
  `ingestFailure.receiver:"http"`.
  **FAIL:** the typed cause is not reflected (the generic sentence is rendered while the snapshot
  carries a well-formed `ingestFailure`); the port/receiver in the sentence disagree with the
  snapshot; the detail is a stopped/daemon sentence.
  **Instrument note:** exit **1** = the LEVER ran but its preconditions failed (`HOLD_PROVEN`/
  `APP_READY` false) — a FAILED DRIVE; exit **2** = REFUSED before launching (manifest, incumbent
  still running, frontend not serving) — restart the sequence, never improvise. Neither is a product
  FAIL (G-406).
  **Edge:** the page may be `about:blank` for minutes after the probe's launch — the documented
  isolated-boot characteristic (3–5 min); wait it out and say how long before declaring a wedge.

## F-11 (#3195 R-4 / AC4) — main window closed, then the Settings window closed and reopened: the line never claims capture stopped

> **The discriminating condition is built into the row: the login entry is ABSENT for both legs**
> (a pane that derives the line from the login-entry boolean then reads `Capture: Not running`,
> which is exactly the defect). Take the backup first and restore at the end.
> **The physical tray click is NOT drivable** (resident-shell QA-3; pre-authorised disclosure,
> G-053) — the "no window at all, then tray `Open`" variant is recorded as unavailable, never a
> FAIL; F-11b is the discriminating control for the same mechanism.

- [ ] **F-11a — with `main` CLOSED and the Settings window open, the line still reads
  `Capture: Running`.**
  1. `registry-entry.ps1 -Backup -BackupPath .opencode/tmp/3195/registry-backup.json` then
     `-Clear -BackupPath …` → `ENTRY=Absent` (record it; this is the control). The `-Backup` mode is
     **idempotent and refuses to overwrite**: with a backup already recorded (F-2c/F-2d's), paste
     `REFUSING_TO_OVERWRITE_EXISTING_BACKUP=True` + `BACKUP_RAW_SHA256` — that recorded value IS the
     pre-test state F-11c restores; never delete the file to force a re-record.
  2. Env up normally (no force token — if the app was left by F-10f's probe or a force-token boot,
     quit it and `Down`/`Up` plainly first); from `main` open the Settings window and the pane;
     record the baseline PANE READING (`status` = `Capture: Running`, paste the whole object).
  3. From the Settings window close `main`:
     `tauri_webview_execute_js(windowId='app-settings', script="(() => __TAURI__.core.invoke('plugin:window|close', { label: 'main' }))()")`.
  4. Verify the close from OUTSIDE: `tauri_manage_window(action="list")` no longer lists `main`,
     `…invoke('app_lifecycle_status')` reads `mainWindowOpen:false`, `trayItems` still exactly
     `[{"id":"tray-open","label":"Open"},{"id":"tray-quit","label":"Quit"}]`, and `<appPid>` is
     still alive (`Get-Process`).
  5. Wait one 5 s tick (≥ 6 s) and re-read the PANE READING from the surviving Settings window.
  **Expected:** the post-close `status` is still `Capture: Running`; `retiredStatusPresent:false`;
  the backend cross-check from that same webview still reads `ingestConnected:true`. Paste the
  before/after PANE READING pair and the close receipt (`WINDOW_LIST`, `mainWindowOpen`,
  `trayItems`, PID).
  **FAIL:** the line flips to `Capture: Not running`/`Status unavailable` when the main window
  closes (a line tied to window presence rather than process state); the process dies on the close
  (`mainWindowOpen:false` + a dead PID is a FAIL of the residency precondition — record it as
  such, then continue at F-11b only if a webview still exists).
  **Edge:** the Settings window itself keeps rendering (it is `app-settings`, not `main`); if the
  close took the Settings window down as well, record `NO_SURVIVING_WEBVIEW` and drive F-11b from
  a fresh `main` instead — do not score this row from an empty read.

- [ ] **F-11b — close the Settings window and REOPEN it: the freshly created webview still reads
  `Capture: Running` (the AC4 discriminator).**
  Continue from F-11a's state (registry `Absent`, `main` destroyed, Settings window open, line
  `Capture: Running`).
  1. Close the Settings window:
     `tauri_webview_execute_js(windowId='app-settings', script="(() => __TAURI__.core.invoke('plugin:window|close', { label: 'settings' }))()")`
     (the product's own alternative is `…invoke('close_app_window', { appId: 'settings' })` from
     `main`; use whichever answers and record which). Confirm it is gone from
     `tauri_manage_window(action="list")`.
  2. Reopen WITHOUT an existing webview: with no product window left, reopen `main` through the
     webview-free seam
     (`run-exitcode.ps1 -Command "powershell -File .opencode/tests/resident-shell/second-launch.ps1
     -ManifestPath <manifest> -Exe <exe>"`), then from `main`
     `…invoke('open_app_window', { appId: 'settings' })`; re-point the driver
     (`tauri_driver_session stop` → `start`) at `app-settings`.
  3. Navigate to Background capture and SAMPLE the status line repeatedly: immediately once the
     section exists, then at ~1 s intervals for ~10 samples (paste the samples with timestamps).
  4. Cross-check the backend from the SAME (new) webview:
     `(async () => JSON.stringify(await __TAURI__.core.invoke('stream_health')))()`.
  **Expected:** every sample after the region settles reads `Capture: Running`; NO sample reads
  `Capture: Not running` (the one accepted transient is the unresolved skeleton with
  `regionAriaBusy:"true"` and no word rendered — that is not a claim); the backend cross-check
  reads `ingestConnected:true`; `registry-entry.ps1 -Read` still `ENTRY=Absent` (paste it BESIDE
  the reading — the pair is the proof that the value did not come from the login entry);
  `retiredStatusPresent:false`.
  **FAIL:** `Capture: Not running` in a settled sample (the login-entry/cached/context-cold-start
  defect); the reading being explained by the login entry (i.e. `ENTRY=Present` — then the row is
  not driving its own control: re-clear and repeat).
  **Disclosed method limit (not a FAIL):** a sub-250 ms flash of a wrong value between page load
  and the first sample is below the driver's sampling floor and cannot be observed with the
  provisioned tools; say so, and rest the mechanism claim on (i) the fresh-webview reading above,
  (ii) the `ENTRY=Absent` control, and (iii) F-12c's static pin that the pane's line comes from
  `captureStatus.ts` and never from `useStreamHealth`/`StreamContext`.
  **Edge:** `app_lifecycle_status` between steps — record `mainWindowOpen` and the tray items at
  each step (the resident gate is what keeps the process alive with zero windows).

- [ ] **F-11c — hygiene + the pre-authorised disclosure.**
  `registry-entry.ps1 -Restore -BackupPath .opencode/tmp/3195/registry-backup.json` →
  `RESTORED_MATCH=True`, `RESTORED=` matching F-0's recorded pre-test state, exit 0.
  **Record (NOT a row that can pass or fail):** the "quit both windows, then click the tray `Open`
  with a physical mouse" variant is undrivable by every provisioned tool (no physical pointer on
  the tray icon). F-11b is its discriminating control because it exercises the same
  `ensure_main_window` recreation with a webview that did not exist when the previous reading was
  taken. Never write it up as a PASS or a FAIL.

## F-12 (#3195 R-5 / AC5) — nav label/icon and test ids are consistent, and every affected test moved

- [ ] **F-12a — the nav item, live.**
  From `main`: `…invoke('open_app_window', { appId: 'settings' })`; read
  `(() => { const n = document.querySelector('[data-testid="settings-nav-ingest"]'); if (!n) return 'MISSING'; const svg = n.querySelector('svg'); return JSON.stringify({ text: n.textContent.replace(/\s+/g,' ').trim(), svgs: n.querySelectorAll('svg').length, paths: svg ? svg.querySelectorAll('path').length : 0, svgHtml: svg ? svg.outerHTML.slice(0, 400) : null }); })()`.
  **Expected:** the element exists with `text` = `Background capture` (exactly), `svgs:1` and
  `paths` ≥ 1 (an icon is rendered — an item with no glyph FAILs), it is clickable and opens the
  section (`settings-ingest-autostart-section` appears), and its DOM position is still AFTER the
  `Telemetry` nav item. Paste the JSON and the section's appearance.
  **Edge:** the label must not read `Ingest` — the testid `settings-nav-ingest` legitimately
  contains the substring `ingest` (lowercase); compare the visible TEXT, not the id.

- [ ] **F-12b — the icon IDENTITY is proven by an exact comparison (UI/UX U-12 / A-3), not by
  "an svg is present".**
  **(i) Static pin (the import moved):** `rg -n "LuMonitorDot"
  apps/ui/src/applications/settings-app/components/SettingsSurface.tsx` → TWO lines (the import and
  the nav item's `icon=`); `rg -n "LuDatabase"
  apps/ui/src/applications/settings-app/components/SettingsSurface.tsx` → ZERO lines. Paste both.
  **(ii) Identity comparison (the leg that can FAIL on the old icon):** in
  `__tests__/SettingsSurface.ingest.test.tsx` (or the sibling suite) the rendered nav item's
  `<svg>` content is compared for EQUALITY with a separately rendered `<LuMonitorDot />` and for
  INEQUALITY with `<LuDatabase />` — `react-icons/lu` emits static path data per icon, so the
  comparison is exact. Run
  `run-exitcode.ps1 -Command "pnpm --filter @fredo/ui exec vitest run src/applications/settings-app"`
  → `EXITCODE=0`; paste the summary and the test name, and read the assertion to confirm it is the
  comparison (not a `toBeInTheDocument()` on an `svg`).
  **(iii) Live structural corroboration:** F-12a's `svgs:1` / `paths` ≥ 1 (an ICON ELEMENT still
  renders on the item) — paste the nav `svg`'s `innerHTML` for the record.
  **Expected:** (i) two/zero as above; (ii) green with an equality+inequality assertion; (iii) one
  `svg` whose pinned glyph should match the unit-pinned `LuMonitorDot` path data — compare the two
  pasted strings and say whether they agree.
  **Disclosed method limit (not a FAIL):** the live webview cannot mount a reference component, so
  the IDENTITY proof is (ii); (iii) alone would pass with the OLD icon and is therefore never
  reported as the AC5 evidence. Say which artifact carries the identity.
  **FAIL:** no equality assertion anywhere (an `svg`-present assertion passes with `LuDatabase` and
  is vacuous); `LuDatabase` still imported in the file; the live nav item renders no icon element.
  **Edge:** an `<svg>` whose `aria-hidden` differs between the two renders is a comparison-harness
  detail — compare the `innerHTML` of the glyph (path data), not the whole element's attributes.

- [ ] **F-12c — the retired test id is gone from every RENDER site (and pinned absent in the test).**
  **Scope (G-430): the universe is `apps/ui/src` ONLY.** This suite file spells the retired token
  on purpose and is deliberately outside the universe; a search that includes
  `.opencode/tests/**` would match the row that asserts the absence.
  `rg -n "settings-ingest-autostart-status" apps/ui/src` → paste every hit and disposition each.
  **Expected:** ZERO hits in a rendering position — no `data-testid="settings-ingest-autostart-status"`
  and no `testId` assignment of it in `IngestAutostartSettings.tsx` (whose testid legend comment
  must name the NEW ids instead). The ONLY permitted hits are the ABSENCE pin in
  `applications/ingest/__tests__/IngestAutostartSettings.test.tsx` (a `queryByTestId`/`not.` form)
  — and that pin must EXIST (zero hits overall is also a FAIL: the pin is ST-2's deliverable, and
  an "absent" claim with no pin is unwitnessed).
  **Additionally (the agentic-derived pin, `apps/ui/src` only):** no source file imports
  `useStreamHealth`/`useStreamContext` into the pane — the line must come from
  `captureStatus.ts`: `rg -n "useStreamHealth|useStreamContext|useStream\(" apps/ui/src/applications/ingest`
  → zero hits, and `rg -n "getCaptureStatus" apps/ui/src/applications/ingest` → the pane + the
  module.
  **FAIL:** a live render site with the retired id; the absence pin missing; the pane wired to the
  stream context (a `degraded` cold start would then render the stopped claim, F-11b's defect).

- [ ] **F-12d — the retired COPY is gone from the app sources (string literals), and no stale claim
  survives in prose.**
  `rg -n "Background capture: (On|Off|Unavailable)" apps/ui/src` → ZERO hits (the pane source and
  its unit suite are both rewritten this round; a surviving hit in the TEST is a FAIL of ST-2's
  rewrite, not an allowlisted artifact).
  Then `rg -n "only while Fredo is open|still captures while it is|already capturing|keeps capturing until you quit" apps/ui/src`
  and **disposition every hit** (G-419's code-vs-comment rule, applied to a copy row):
  - a hit **inside a string literal or template** (a `'`, `"` or backtick immediately before the
    token — i.e. a rendered constant or an assertion pinning one) is a **FAIL**: the constant was
    re-introduced, or the suite still pins the retired text.
  - a hit inside a `//` / `/* */` **comment** is **recorded, not failed**, and reported as a stale
    comment for ST-2 to clean in the same landing — but it must not read as current copy (e.g. the
    pane header explaining that *“this session is already capturing” is false after a restart* is a
    stale quotation of a sentence A-1 deleted, and is exactly the kind of comment the plan's own
    G-416 rule says must be corrected).
  **Expected:** zero `Background capture: On|Off|Unavailable` hits; every A-1-sentence hit is a
  comment (report the file:line + the quoted text), or zero.
  **Scope:** `apps/ui/src` only — `.opencode/tests/**` records the retired strings as the absence
  contract and is outside the universe (G-430/G-431).
  **FAIL:** a rendered constant or test assertion carrying any retired string.
  **Edge:** the A-1 sentences in the pane's HEADER comment are expected to disappear with ST-2's
  comment pass; if one survives as a quoted explanation, say so rather than failing the row — a
  comment is not a copy surface.

- [ ] **F-12e — token-only styling (no hex/rgb/hsl literal, no alpha-append on `var()`), and the
  WORD is `fg.default` (UI/UX A-2 / U-11).**
  `rg -n "#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(" apps/ui/src/applications/ingest/IngestAutostartSettings.tsx apps/ui/src/applications/settings-app/components/SettingsSurface.tsx`
  → ZERO; `rg -n "var\(--[a-z0-9-]+\)[0-9a-fA-F]{2}"
  apps/ui/src/applications/ingest/IngestAutostartSettings.tsx` → ZERO.
  **Expected:** both empty (paste them). The state HUE rides the decorative icon only —
  `status.success` (`running`) / `status.warning` (`notRunning`) / `status.info` (`unknown`) — and
  the WORD TEXT is `fg.default` in all three states (A-2: the preset status hues do not clear AA
  small-text contrast on `bg.surface`, and `fg.default` is today's line — no-worse-than-control,
  G-235). F-10a's computed-colour comparison is the live leg of A-2; this row is the static one:
  read the status word's `color` prop and confirm it is a token, not a status hue.
  **FAIL:** any colour literal in the pane; an alpha-append like `var(--accent-primary)22` (invalid
  CSS — the declaration is dropped at computed-value time); the word text coloured with
  `status.warning`/`status.success`/`status.info`.
  **Edge:** a colour inside a `title`/`aria` string is not styling — record it, do not fail.

- [ ] **F-12f — every affected test moved with the surface (the whole-UI gate).**
  `run-exitcode.ps1 -Command "pnpm --filter @fredo/ui test:run"` → `EXITCODE=0` with **0 failed**
  (paste the file/test totals), and `run-exitcode.ps1 -Command "pnpm --filter @fredo/ui build"` →
  `EXITCODE=0` (the unused `LuDatabase` import is gone — a typecheck error there is exactly this
  clause).
  **Expected:** the suites that pinned the retired id — `IngestAutostartSettings.test.tsx` and
  `SettingsSurface.ingest.test.tsx` — pass with the NEW ids/copy; no other suite fails.
  **FAIL:** any failing test that still names `settings-ingest-autostart-status` or the retired
  copy (an affected test left behind), or a build error.
  **Edge:** a suite that fails for an unrelated pre-existing reason must be reported with its own
  file:line — never absorbed as "green enough".

## Non-functional

- [ ] **N-1 (build gates).** `run-exitcode.ps1 -Command "cargo check --manifest-path
  apps/tauri/src-tauri/Cargo.toml"` (zero warnings), `… "cargo test --manifest-path
  apps/tauri/src-tauri/Cargo.toml"`, `… "pnpm --filter @fredo/ui build"` — all `EXITCODE=0`.
- [ ] **N-2 (no new Tauri command / no ACL drift).** `git diff --stat origin/main...HEAD --
  apps/tauri/src-tauri/src/runtime/command_manifest.rs apps/tauri/src-tauri/gen/schemas`
  is EMPTY (paste it): the view gains fields, not a command.
- [ ] **N-3 (bounded).** every boot/launch/quit leg is wall-clock bounded (Env Up ≤ 420 s — the
  `-TimeoutSecs 420` bound, because a fresh isolated boot takes 3–5 min to first paint; launch
  readiness ≤180 s; quit probe ≤30 s) with a hard-kill fallback; an observed unbounded wait is a
  FAIL, not a skip (G-263). A `tauri_webview_execute_js` timeout DURING the boot window is the
  documented booting state, not a wedge — record the wait and retry.
- [ ] **N-4 (console hygiene).** `tauri_read_logs(source="console", lines=50)` on `main` (after
  F-1c) and on `app-settings` (after F-6/F-10): no `Error:` / `Uncaught` /
  `Maximum update depth exceeded` — the last one is the interval/re-render defect class this pane's
  new poll can create (#523), so a single occurrence is a FAIL of the poll design.
- [ ] **N-5 (theme).** the pane renders correctly in BOTH the light and dark presets (no hardcoded
  hex; the disabled switch's reduced opacity is legible in both; the three capture-state colours
  stay distinguishable in both). Screenshot bonus only.
- [ ] **N-6 (no window flash at login — disclosed method).** `launch-background.ps1` reads the window
  enumeration (`VISIBLE_PRODUCT_WINDOW`) after readiness; a sub-100 ms flash between process start
  and that read is not observable with the provisioned tools — DISCLOSE it, do not claim it proven.
- [ ] **N-7 (IPC budget + no state churn — measured, not asserted).** Install a counter in the pane's
  webview BEFORE sampling:
  `(() => { const i = window.__TAURI_INTERNALS__; if (i.__qaCount) return 'ALREADY'; const orig = i.invoke; i.__qaCount = { stream_health: 0, total: 0 }; i.invoke = function (cmd, args) { i.__qaCount.total++; if (cmd === 'stream_health') i.__qaCount.stream_health++; return orig.call(i, cmd, args); }; return 'WIRED'; })()`
  then wait 30 s without touching the pane and read `JSON.stringify(window.__TAURI_INTERNALS__.__qaCount)`.
  **Expected:** `stream_health` count ∈ **[6, 9]** over 30 s (one on mount + one per 5 s tick, with
  scheduling slack) — NOT dozens; and a second 10 s window during which the tester changes theme
  preset / resizes the window produces at most +3 (a re-render must not issue a probe; a burst is
  the #523 loop).
  **FAIL:** a count ≥ 15 in 30 s (a re-render loop or a per-render invoke), or zero (the line is not
  being driven by a read at all — then F-10a's reading is unexplained).
  **Edge:** `total` is recorded too — the pane must not invoke `pg_supervisor_status` at all (record
  the key set; a `pg_supervisor_status` key is a FAIL of the no-matrix constraint). The counter is
  installed from the driver, so it does not alter the shipped bundle — say so in the receipt.
  The count is invalidated by a reload: re-install after any navigation or remount and record the
  timestamp the counter started.

## Suite-level pass/fail

PASS = F-0 green **and** F-1a…F-8 green (F-7's live leg recorded as its named blocker and its pin
green) **and** F-9a…F-12f green **and** N-1…N-7 hold.
FAIL = a background launch that shows a visible product window
(`VISIBLE_PRODUCT_WINDOW=True` before `Open`, i.e. a visible top-level window of the app PID whose
class is NOT `ConsoleWindowClass`); a background launch whose child did not use the env's own
cluster (`FREDO_PG_DATA_DIR` outside `<env-root>/postgres`, or no env postmaster while the product
is capturing); a tray `Open` that changes the PID or starts a second postmaster; a login value that
is not byte-identical to `"<exe>" --background`; a migrated value that passes through Absent; a
foreign value that is rewritten or deleted by startup/disable; a second `fredo.exe`/postmaster
around a toggle; a span that cannot be shown to bracket the toggle; **a rendered retired string
(`Background capture: On|Off|Unavailable on this platform`, `only while Fredo is open`, `still
captures while it is open`) or a rendered `daemon`/`attach`/`headless`/`second process` token in the
section**; **a capture line that claims `Not running` while the backend reports healthy, or
`Not running`/anything-else where the probe could not be read (it must read `Status unavailable`)**;
**more than one `role="status"` inside the section, or the capture line outside it**; **the capture
line flipping to a stopped claim when `main` is closed or when the Settings webview is recreated**;
**a surviving `settings-ingest-autostart-status` render site**; or a static-only receipt for any
LIVE row.
UNVERIFIED requires a NAMED, actionable blocker (G-053) — never a silent drop.

## Required test data

- **Env (this issue's own):** `dev-env.ps1 -Action Up -Spec 3195 -EnvSlot 1 -RequireIsolation
  -TimeoutSecs 420` (bounded; the default 120 s expires mid-boot); manifest
  `.opencode/tmp/envs/spec3195/manifest.json`; `<exe>` =
  `apps/tauri/src-tauri/target/debug/fredo.exe` (in-repo build output of that env's checkout).
  The `FREDO_STREAM_HEALTH_FORCE` legs are the same command plus
  `-EnvVar "FREDO_STREAM_HEALTH_FORCE=<ingest-down|degraded|down>"`, each after a bounded
  `-Action Down`.
- **Committed instruments (QA-authored, this folder):** `registry-entry.ps1`
  (`-Read/-SeedLegacy/-SeedForeign/-Clear/-Backup/-Restore`, plus `-Exe/-AppPid/-Expect/-BackupPath`),
  `launch-background.ps1` (`-Action Launch/Windows/Kill`, plus `-DryRun`). Both hard-fail on an
  absent INPUT; an absent VALUE/TARGET is a reading (`ENTRY=Absent`,
  `CLEAR_WAS_ALREADY_ABSENT=True`). Both print `KEY=value` lines.
  **First-green status:** both were EXECUTED in #3193 round 1 and their failures were instrument
  defects (an absent-value exit 2 on `-Read`, a `$backup`/`[switch]$Backup` name collision on
  `-Restore`, a missing Names-Block that attached the child to the machine-global shared cluster).
  All three are repaired; **F-0 is the preflight that must be green on THIS tip before any verdict
  rests on them** (G-406). An `ERROR:` line with exit 2 from either is the INSTRUMENT being wrong —
  record it as such (never a product FAIL), stop, and report it.
- Reused committed levers: `.opencode/scripts/run-exitcode.ps1`, `.opencode/scripts/process-hygiene.ps1
  -List`, `.opencode/scripts/dev-env.ps1`, `.opencode/scripts/inject-otlp-fixture.ts`,
  `.opencode/skills/telemetry-query/telemetry-query.ps1`,
  `.opencode/tests/resident-shell/lifecycle-probe.ps1` (+ its `manifest-facts.ps1` and
  `second-launch.ps1`).
- **The close lever (F-11) is the SHIPPED window plugin**, not a new script:
  `plugin:window|close { label }` (capability `core:window:allow-close`,
  `apps/tauri/src-tauri/capabilities/default.json:14`) and the product command
  `close_app_window { appId }`. Both are already driven by `resident-shell/functional.md:37-41`/`F-5`.
- **Spans:** `.opencode/scripts/inject-otlp-fixture.ts` gRPC on `ports.otlpGrpc` (ONE route bound;
  read back by `span_id` from the injector's printed `CONFIRM` SQL).
- **Registry backup (this issue's own path):** `.opencode/tmp/3195/registry-backup.json` —
  pass `-BackupPath` on every mutating call (the script's default is the #3193 path), and
  `-Restore -BackupPath .opencode/tmp/3195/registry-backup.json` at the end of every mutating row.
- **No new fixture or asset is required by this spec.** Nothing in F-9…F-12 needs recorded media, a
  model, or a corpus: every reading is the running app's own DOM, the backend `stream_health`
  snapshot, the registry instrument, or a committed source grep.

## Evidence rules

- Every cited artifact must be a NON-DRAFT durable record — the posted `## Tests Runs` comment, a
  committed path (these suite files, the two instruments), or a `user-attachments` URL (G-415).
  Never a `.opencode/tmp/3195/` timeline draft. (`.opencode/tmp/3195/registry-backup.json` is a
  MACHINE state file read by an instrument, not a record to cite as evidence.)
- `upload-evidence` has failed on this host for seven consecutive rounds (SAML): the DEFAULT
  evidence is verbatim instrument output (`RAW=`, `RAW_SHA256=`, `VISIBLE_PRODUCT_WINDOW=`,
  `WINDOW_LIST`, `ENV_BLOCK`, `POSTMASTER_PIDS=`), the SQL result table, a DOM-snapshot excerpt, and
  the raw `tauri_manage_window(action="list")` paste. A screenshot is a bonus, never the only record
  (G-104).
- Verdict line: `Verdict: **PASS**` (bare token first). `Tested commit:` a bare SHA ALONE on its
  line; state the served branch/commit and the tree condition (served tree at that commit) on the
  NEXT line (G-052/G-443).

## Named blockers (pre-authorized, not silent drops)

- **A physical tray-icon click** is not drivable by any provisioned tool (resident-shell QA-3). Tray
  `Open` is driven through the WEBVIEW-FREE seam first (a foreground second launch →
  `CliCommand::OpenMainWindow`, F-1c) with `…invoke('open_main_window')` as the in-app
  corroboration once a page exists (F-1d); both call the same `ensure_main_window` the tray item
  dispatches. Record the substitution.
- **The "quit both windows, then a physical tray `Open`" variant of AC4** is undrivable for the same
  reason (no physical pointer on the tray icon). Pre-authorised disclosure, G-053: the
  discriminating control is **F-11b** (a Settings webview closed and recreated while the process
  stays resident). Record it as unavailable — never as a PASS or a FAIL.
- **A sub-250 ms flash of a wrong capture word** between page load and the driver's first sample in a
  recreated webview is below the sampling floor of the provisioned tools (F-11b). Disclose it and
  rest the mechanism claim on the fresh-webview reading + the `ENTRY=Absent` control + F-12c's
  static pin. This is a METHOD limit, not an AC gap — the AC's observable (no settled stopped
  claim) is drivable.
- **The live non-Windows `unavailable` rendering** cannot be driven on this host (F-7): the
  unit/static pin is the receipt.
- **The icon GLYPH identity** cannot be read from the rendered DOM (a `react-icons` glyph is a bare
  `<svg>`); F-12b's static pin is the receipt and F-12a only proves an icon renders.
- **A failed registry WRITE** has no product injection seam; if ST-2 exposes none, the error-state
  leg is a unit-pin leg (F-6b/F-10e) and is recorded as such.
