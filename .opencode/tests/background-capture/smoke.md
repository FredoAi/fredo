# background-capture — Smoke

Feature: capture at login without a window (`--background` + the per-user `FredoIngest` login
entry). Seeded at issue **#3193**. Short sanity checks before the deeper rows in `functional.md`.

> **Verification policy: LIVE** — receipts are a live `telemetry_spans` read, the registry
> instrument's raw output, a native window reading, and a DOM snapshot. Static-only smoke cannot
> pass this suite.

## Cases

- [ ] **S-1: The app boots and the main window renders (foreground leg).**
  `dev-env.ps1 -Action Up` (bounded); then `tauri_webview_dom_snapshot(type="structure")` on `main`.
  **Expected:** non-empty `<body>`; the window is VISIBLE
  (`Get-Process -Id <appPid>` → `MainWindowHandle != 0`) — the config now declares
  `visible: false` and `RunEvent::Ready` must show it for a foreground launch.

- [ ] **S-2: No console errors.**
  `tauri_read_logs(source="console", lines=50)` on `main` after boot and on `app-settings` after
  opening the pane.
  **Expected:** no `Error:` / `Uncaught` / `Maximum update depth exceeded`.

- [ ] **S-3: The Background capture pane is reachable and carries the new hooks.**
  Open Settings (`…invoke('open_app_window', { appId: 'settings' })`), click
  `[data-testid="settings-nav-ingest"]`, then snapshot the structure.
  **Expected:** the nav label reads `Background capture`; the pane renders
  `settings-ingest-autostart-section`, `settings-ingest-autostart-toggle`,
  `settings-ingest-autostart-status`, `settings-ingest-autostart-timing`; the status text is one of
  `Background capture: On` / `Background capture: Off` / `Background capture: Unavailable on this
  platform`; `settings-ingest-daemon-status` is ABSENT.

- [ ] **S-4: The registry instrument reads this host truthfully.**
  `run-exitcode.ps1 -Command "powershell -File .opencode/tests/background-capture/registry-entry.ps1
  -Read -AppPid <appPid>"`.
  **Expected:** exit code 0; `VALUE_PATH=HKCU\Software\Microsoft\Windows\CurrentVersion\Run\FredoIngest`;
  `ENTRY=Present|Absent` with a `RAW=` line that agrees with the `REG_EXE_QUERY=` corroboration.
  An `ERROR:` line (exit 2) is an INSTRUMENT failure to fix, never a product FAIL.

- [ ] **S-5: `--background` launches resident with no window.**
  `run-exitcode.ps1 -Command "powershell -File .opencode/tests/background-capture/launch-background.ps1
  -Action Launch -ManifestPath <manifest> -Exe <exe>"` (bind it to a free environment).
  **Expected:** `RESULT=PASS`, `ALIVE=True`, both OTLP ports + the MCP port owned by `START_PID`,
  **`MAIN_WINDOW_HANDLE=0`**. Stop it with `launch-background.ps1 -Action Kill -TargetPid <pid>`.
  FAIL = the process exits, or a visible window exists before any `Open`.

- [ ] **S-6: Live receipt.** Inject one span into the running instance's OTLP gRPC port and read it
  back by `span_id` (`telemetry_spans`, `end_time_ns IS NOT NULL`, fresh `ingested_at`).
  **Expected:** the row exists and is attributable to this run's prefix. A static-only receipt is a
  FALSE PASS.

- [ ] **S-7: Registry restored after smoke.** `registry-entry.ps1 -Restore`.
  **Expected:** `RESTORED_MATCH=True`. The host's per-user Run entry must not be left mutated by a
  smoke run.

## Suite-level pass/fail

PASS = S-1…S-7 green. Any blank shell, console error, missing named hook, a visible window before
`Open` on a `--background` launch, a non-restored registry, or a static-only live receipt = FAIL.
