# headless-ingest — Smoke

Feature: the headless ingest daemon (`fredo ingest`). Seeded at issue **#2992**. Short
standardized sanity checks before deeper testing. This feature has a headless runtime surface
plus a small GUI settings surface (the autostart toggle + the daemon-status readout), so the
standard app-boot boilerplate applies to the GUI leg and a headless-boot check covers the daemon.

> **Verification policy: LIVE** — receipts reference a `telemetry_spans` live read (PG-backed via
> the managed `psql`) plus process/port observations. Static-only smoke cannot pass.

## Cases

- [ ] **S-1: App window renders (GUI leg).** Boot the GUI; `tauri_webview_dom_snapshot(type="structure")`
  returns a non-empty `<body>`.
  **Expected:** non-empty body; no blank shell.

- [ ] **S-2: No console errors.** `tauri_read_logs(source="console", lines=50)` after boot and
  after toggling autostart.
  **Expected:** no `Error:` / `Uncaught` / `Maximum update depth exceeded`.

- [ ] **S-3: Feature surface reachable.** Open Settings → **Ingest**; confirm the nav section
  (`id="ingest"`), the nav button `settings-nav-ingest`, the section root
  `settings-ingest-autostart-section`, the toggle `settings-ingest-autostart-toggle`, the status
  `settings-ingest-autostart-status`, and the daemon status `settings-ingest-daemon-status`
  render.
  **Expected:** all named elements present; daemon status shows a real state (incl. `attached`
  when attached).

- [ ] **S-4: Headless daemon boots.** Start `fredo ingest` against the scratch dirs; wait for the
  descriptor to publish a live pid+port.
  **Expected:** descriptor appears; PG answers a bounded `SELECT 1` via the managed `psql`; both
  OTLP receivers bound. FAIL = no descriptor / unbounded wait.

- [ ] **S-5: Screenshot captured.**
  `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/2992/e2e/smoke.jpeg")`
  succeeds.
  **Expected:** file written.

- [ ] **S-6: Daemon stops bounded.** Create `FREDO_INGEST_SHUTDOWN_FILE`; time the exit.
  **Expected:** exit 0 within the bound; descriptor/lock cleared; post-stop PG port probe fails.
  (G-280: a pre-existing orphan `postgres.exe` is reported as environment, not a FAIL.)

- [ ] **S-7: Live receipt.** Query `telemetry_spans` via the managed `psql` (PG, database
  `postgres`) after an OTLP delivery.
  **Expected:** non-zero rows with a recent `max(ingested_at)`/timestamp; the row is attributable
  to the delivered trace. A static-only receipt = FALSE PASS.

## Suite-level pass/fail

PASS = S-1…S-7 green. Any blank shell, console error, missing named element, unbounded daemon
wait, or static-only live receipt = FAIL.
