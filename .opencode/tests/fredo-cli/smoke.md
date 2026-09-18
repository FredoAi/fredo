# Fredo CLI — Smoke

> Standardized boilerplate (from `.opencode/tests/README.md`) adapted to the `fredo` CLI surface.
> **Verification policy: live** — every step quotes the literal command output + exit code.
> **Prerequisites:** the `fredo` binary on PATH; the app running for S-4.

- [x] S-1: App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`.
- [x] S-2: No console errors — `tauri_read_logs(source="console", lines=50)` shows no
      `Error:`/`Uncaught`/`Maximum update depth exceeded`.
- [x] S-3: CLI reachable — `fredo --help` exits 0 and lists the commands (including the new open
      command); the binary resolves on PATH (`where.exe fredo`).
- [x] S-4: Open quick path — `fredo open-app mission-monitor` against the running app opens Mission
      Monitor with a success outcome; `tauri_webview_screenshot` succeeds.
- [x] S-5: Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80,
      filePath=".opencode/tmp/2893/e2e/smoke.jpeg")` succeeds.

### #2893 testing round 1 (spec/2893 @ 614f26d3) — results

- **S-1 PASS.** `bodyLen` non-zero; launcher/companion DOM rendered.
- **S-2 PASS (with product WARNs).** No `Error:`/`Uncaught`/`Maximum update depth exceeded`. The
  pre-existing `motion() is deprecated` WARN plus the product WARN
  `[adapterBridge] llmChatWithSkills called before adapter registered` (the round's root-cause
  defect) and `[useAppOpenRequests] confirm_app_open_request failed …` (bounded-confirm race) appear.
- **S-3 PASS.** `fredo --help` exit 0 lists `emit`/`setup`/`open-app`; binary resolves on PATH.
- **S-4 PASS.** `fredo open-app mission-monitor` → `{"outcome":"opened","displayName":"Mission
  Monitor"}` exit 0; the `Sessions` (Mission Monitor) window opened; screenshot
  `q5-cli-open-mission-monitor.png` captured.
- **S-5 PASS.** Screenshots captured under `.opencode/tmp/2893/e2e/` (uploaded as user-attachments).

### #2893 testing round 2 (spec/2893 @ 223279d3) — results

- **S-1 PASS.** `tauri_webview_dom_snapshot(type="structure")` returned a non-empty body
  (launcher/companion + window-manager DOM).
- **S-2 PASS.** Console clean in a no-instrumentation leg (a full companion generation produced zero
  `level=error` entries); the round's `reading 'slice'` bursts were tester-instrument artifacts.
- **S-3 PASS.** `fredo --help` exit 0 lists `emit`/`setup`/`open-app`; the binary resolves on PATH.
- **S-4 PASS.** `fredo open-app mission-monitor` against the running app → `{"outcome":"opened"}`
  exit 0; the `Sessions` (Mission Monitor) window opened; screenshot captured.
- **S-5 PASS.** `tauri_webview_screenshot` succeeded; the round's captures were uploaded as
  user-attachments and embedded in the `## Tests Runs (round 2)` verdict.
