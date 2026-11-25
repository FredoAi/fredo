# background-capture — Smoke

Feature: capture at login without a window (`--background` + the per-user `FredoIngest` login
entry). Seeded at issue **#3193**; extended by **#3195** (the pane's status line is about CAPTURE —
`settings-ingest-capture-status` replaced the retired `settings-ingest-autostart-status`). Short
sanity checks before the deeper rows in `functional.md`.

> **Verification policy: LIVE** — receipts are a live `telemetry_spans` read, the registry
> instrument's raw output, a native window reading, and a DOM snapshot. Static-only smoke cannot
> pass this suite.

## Cases

- [ ] **S-1: The app boots and the main window renders (foreground leg).**
  `dev-env.ps1 -Action Up` (bounded); then `tauri_webview_dom_snapshot(type="structure")` on `main`.
  **Expected:** non-empty `<body>`; the window is VISIBLE per the native predicate —
  `launch-background.ps1 -Action Windows -ManifestPath <manifest>` →
  `VISIBLE_PRODUCT_WINDOW=True` with a `VISIBLE_NON_CONSOLE_WINDOW_TITLE` naming the env — the config
  now declares `visible: false` and `RunEvent::Ready` must show it for a foreground launch.
  (`MAIN_WINDOW_HANDLE` is a diagnostic here: a debug build's console can make it non-zero even when
  the product window never showed.)

- [ ] **S-2: No console errors.**
  `tauri_read_logs(source="console", lines=50)` on `main` after boot and on `app-settings` after
  opening the pane.
  **Expected:** no `Error:` / `Uncaught` / `Maximum update depth exceeded`.

- [ ] **S-3: The Background capture pane is reachable and carries the CURRENT hooks.**
  Open Settings (`…invoke('open_app_window', { appId: 'settings' })`), click
  `[data-testid="settings-nav-ingest"]`, then snapshot the structure and read the pane with the
  `functional.md` PANE READING snippet.
  **Expected:** the nav label reads `Background capture`; the pane renders
  `settings-ingest-autostart-section`, `settings-ingest-autostart-toggle`,
  `settings-ingest-autostart-timing`, **`settings-ingest-capture-status`** and
  **`settings-ingest-capture-detail`**; the capture `status` word is one of `Capture: Running` /
  `Capture: Not running` / `Capture: Status unavailable` (never `Background capture: On|Off`);
  `retiredStatusPresent:false` and `daemonStatusPresent:false`; exactly one `role="status"` INSIDE
  the section, `aria-live="polite"`.
  **INVERTED by #3195:** this case previously expected `settings-ingest-autostart-status` and the
  `Background capture: On/Off/Unavailable on this platform` text. That id and those strings are
  RETIRED — expecting them is now a FAIL of the smoke.

- [ ] **S-4: The registry instrument reads this host truthfully — including "not installed".**
  `run-exitcode.ps1 -Command "powershell -File .opencode/tests/background-capture/registry-entry.ps1
  -Read -AppPid <appPid>"` (or without `-AppPid` when the app is not running).
  **Expected:** exit code **0 in BOTH states**;
  `VALUE_PATH=HKCU\Software\Microsoft\Windows\CurrentVersion\Run\FredoIngest`;
  `ENTRY=Present` with a `RAW=` line that agrees with `RAW_SHA256` and `REG_EXE_QUERY_CODE=0`, **or**
  `ENTRY=Absent` with `RAW=` empty, `RAW_SHA256=(absent)`, `REG_EXE_QUERY_CODE=1`.
  An absent value is the most common state and is a normal reading. An `ERROR:` line (exit 2) is an
  INSTRUMENT failure to fix, never a product FAIL.

- [ ] **S-5: `--background` launches resident with no visible product window, inside the env.**
  `run-exitcode.ps1 -Command "powershell -File .opencode/tests/background-capture/launch-background.ps1
  -Action Launch -DryRun -ManifestPath <manifest>"` first (paste the block: `FREDO_PG_DATA_DIR` must
  be `<env-root>/postgres`, `FREDO_PG_DATA_DIR_UNDER_ENV_ROOT=True`,
  `FREDO_PG_DATA_DIR_EXISTS=True`), then the same command WITHOUT `-DryRun` plus `-Exe <exe>`
  (bind it to a free environment).
  **Expected:** `RESULT=PASS`, `ALIVE=True`, both OTLP ports + the MCP port owned by `START_PID`,
  **`VISIBLE_PRODUCT_WINDOW=False`** with `VISIBLE_NON_CONSOLE_WINDOW_COUNT=0`, and an env postmaster
  (`ENV_POSTMASTER_PIDS` non-empty). Stop it with
  `launch-background.ps1 -Action Kill -TargetPid <pid>`.
  FAIL = the process exits, or a VISIBLE top-level window of the app PID exists before any `Open`
  whose class is not `ConsoleWindowClass`.
  A dry run against a bogus manifest path must print `ERROR: manifest not found: ...` and exit 2
  without spawning — record that negative control.

- [ ] **S-6: Live receipt.** Inject one span into the running instance's OTLP gRPC port and read it
  back by `span_id` (`telemetry_spans`, `end_time_ns IS NOT NULL`, fresh `ingested_at`).
  **Expected:** the row exists and is attributable to this run's prefix. A static-only receipt is a
  FALSE PASS.

- [ ] **S-7: Registry restored after smoke.** `registry-entry.ps1 -Restore -BackupPath
  .opencode/tmp/3195/registry-backup.json`.
  **Expected:** `RESTORED_MATCH=True` and exit 0 (the local that shadowed the `[switch]$Backup`
  parameter is gone; `-Restore` is callable). With NO backup file present it must print
  `ERROR: no backup to restore at <path> ...` and exit 2 — record that negative control too. The
  host's per-user Run entry must not be left mutated by a smoke run.
  **Note (#3195):** pass `-BackupPath` on EVERY call in this smoke so the round's backup is its own
  (`functional.md` F-0 records the pre-test state; the script's default path is the #3193 file).

## Suite-level pass/fail

PASS = S-1…S-7 green. Any blank shell, console error, missing named hook, a VISIBLE non-console
window of the app PID before `Open` on a `--background` launch (`VISIBLE_PRODUCT_WINDOW=True`), a
child that did not start the env's own cluster, a non-restored registry, or a static-only live
receipt = FAIL.
