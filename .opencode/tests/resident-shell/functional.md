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
  alive 30 s after the close; the postmaster PID is unchanged.
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

- [ ] **F-3 — quit_app ends the process and leaves no postmaster.**
  Record `pg_supervisor_status.{pid,port,dataDir}`, the app PID, and
  `lifecycle-probe.ps1 -Action Descendants -TargetPid <appPid>`. `invoke('quit_app')`. Then:
  `tasklist /FI "IMAGENAME eq fredo.exe" /FO CSV`,
  `powershell -File .opencode/scripts/process-hygiene.ps1 -List`, and
  `run-exitcode.ps1 -Command "powershell -File .opencode/tests/resident-shell/lifecycle-probe.ps1 -Action Postmaster -ManifestPath <manifest>"`.
  **Expected:** the `fredo.exe` PID is GONE within the bounded teardown window (record the measured
  duration; >30 s with no completion is a FAIL); the pre-quit postmaster PID is ABSENT; no
  `postgres.exe` whose command line references this env's PostgreSQL data dir remains; the MCP
  bridge port is closed; no new orphaned child of the former app PID.
  **Edge:** quit while `main` is destroyed; quit while `main` is visible; quit while a terminal
  session is mid-command (E-3); quit twice (second is a no-op).

## F-4 (R-4 / AC4) — a second launch focuses, never a second owner

- [ ] **F-4** — run
  `powershell -File .opencode/scripts/run-exitcode.ps1 -Command "powershell -File .opencode/tests/resident-shell/second-launch.ps1 -ManifestPath <manifest> -Exe apps/tauri/src-tauri/target/debug/fredo.exe"`.
  The script reads the env manifest, injects that env's `FREDO_ENV_ID` / `FREDO_CLI_PIPE` /
  `FREDO_DATA_DIR` / `FREDO_INGEST_GRPC_PORT` / `FREDO_INGEST_HTTP_PORT` / `FREDO_MCP_BASE_PORT` /
  `FREDO_VITE_PORT` into the child, launches the debug binary once, and prints machine-readable
  receipts.
  **Expected:** `SECOND_EXITED=True` with `SECOND_EXITCODE=0`; the second PID is gone;
  `PRIMARY_ALIVE=True`; `NEW_FREDO_PIDS=` EMPTY and `FREDO_PIDS_AFTER` identical to
  `FREDO_PIDS_BEFORE` (no `fredo.exe` appeared after the second launch); `POSTMASTER_BEFORE ==
  POSTMASTER_AFTER` (one postmaster); exactly one listener per OTLP gRPC/HTTP port, owned by the
  primary PID; the second launch opened NO second window; the first instance's `main` is present and
  focused. Corroborate the count with `process-hygiene.ps1 -List`.
  **Edge (the discriminator):** run the same script with `main` DESTROYED — the first instance must
  recreate + focus it. Then boot a DIFFERENT env (`-Action Up -Spec 3192 -EnvId spec3192-b -EnvSlot <n>`)
  and show BOTH apps stay resident (the guard is per-pipe, not global).
  **Edge:** two second launches back-to-back.

## F-5 (R-5 / AC5) — a separate application window survives the main window's close

- [ ] **F-5** — open a second application window (`open_terminal_window` + `spawn_terminal_session`,
  or an `app-<id>` window from the launcher grid). Close `main`. Then
  `tauri_manage_window(action="list")`, re-point the driver at the surviving window, run a trivial
  `execute_js` in it, and (terminal leg) read `get_pty_buffer{sessionId}`.
  **Expected:** `main` is gone but the second window is still listed and its webview still answers
  `execute_js`; the terminal session still lists and its PTY buffer still returns content; the
  `fredo.exe` PID is unchanged; no dialog, no exit.
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
- [ ] **N-6 (console hygiene).** The recreated `main` and the surviving `terminal` show no
  `Error:`/`Uncaught`/`Maximum update depth exceeded`.

## Suite-level pass/fail

PASS = F-1a…F-6c all green **and** N-1…N-6 hold **and** the `regression.md` RT rows hold.
FAIL = any second `fredo.exe`/postmaster for one env; a duplicate `main` window; a span row that
cannot be shown to post-date the close; an orphan postmaster after quit; a `No sessions yet` sample
in F-6c; a static-only receipt for any of F-1…F-6.
UNVERIFIED requires a NAMED, actionable blocker (G-053) — never a silent drop.

## Required test data

- Env: `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 3192 -EnvId <id> -EnvSlot <n>`
  (`<id>` from `.opencode/state/env-leases/3192.json`); ports and the app PID from
  `.opencode/tmp/envs/<id>/manifest.json`; driver `appIdentifier` = `ports.mcp` as a decimal string.
- `inject-otlp-fixture.ts` (committed; random trace/span ids per run).
- `emit-row.ps1` + `fixtures/chat-payload.json` (a QUALIFYING chat row: non-empty `userMessage` AND
  `agentReply`; the classifier reads those exact keys — `rtdb/ingest.rs` chat patch).
- `lifecycle-probe.ps1`, `second-launch.ps1` (both in this folder, run through `run-exitcode.ps1`).
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

- A physical tray-icon click and a physical titlebar X are not drivable by any provisioned tool.
  Menu content is proven from the real `Menu` (F-2a), behaviour through the three converging seams
  (`open_main_window`, `quit_app`, second launch), and the `MenuEvent → handler` mapping by source
  pin (RT-6). A real click remains a human review-window item (QA-3).
- The R-2d "tray unavailable ⇒ X exits" leg has no induction seam in this slice: proven by the unit
  pin RT-5 + the exit-policy source, recorded as a named blocker for the live leg (QA-4).
