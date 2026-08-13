# Run CLI — Smoke Test Suite

Feature domain: `run-cli`. Standard boilerplate adapted from `.opencode/tests/README.md` plus feature-specific quick paths for Spec #2728, extended for Spec #2731 (maomaolabs toolbar desktop-item launch).

Conventions: ID prefix `S-`. Observable expected outcomes.

## Feature usage: launching a live opencode session

After #2728 the flow is: click the Run CLI launch affordance → EXACTLY ONE Tauri window opens directly with the opencode CLI running inside it, rendered by ghostty-web. There is NO intermediate "Run CLI" panel window.
After #2731 the **only** launch affordance is the **Run CLI desktop item in the maomaolabs toolbar** — the #2728 floating "RUN CLI" button and its Launcher/Menu entry are removed. Drive it as:

1. Click the **Run CLI** desktop item in the maomaolabs toolbar (NOT any legacy Launcher/Menu entry or floating button — those are removed).
2. `tauri_manage_window(action="list")` → expect the main window + exactly ONE terminal window (no panel window at any point).
3. The terminal window hosts the live opencode TUI (ghostty-rendered): type a command, read the output, run `pwd` to confirm the working directory (`run_cli_work_dir` preference; fallback to home when unset).
4. End the session (`exit` or Ctrl-D) → the single window auto-closes (AC4).
5. The opencode session's telemetry lands in `telemetry_spans` (live evidence: query `.opencode/skills/telemetry-query/telemetry-query.ps1`).

**Never touch opencode's config/install outside the repo** (`~/.config/opencode/*`, `%APPDATA%\com.fredo.app\*`) — the sandbox denies it and you never need it: Run CLI launches opencode itself. For the AC5 failure fixture, temporarily rename/remove the resolved binary ONLY as documented in F-8/F-18, and restore it immediately.

## Cases

- [x] S-1: **App window renders** — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`. **PASS** — DOM has 61 elements. Evidence: Spec #2728 round 1.

- [x] S-2: **No console errors** — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`. **PASS** — Console clean. Evidence: Spec #2728 round 1.

- [x] S-3: **Run CLI surface reachable** — the "Run CLI" entry (Launcher/Menu) renders and is clickable. **PASS** — Button visible in accessibility tree. Evidence: Spec #2728 round 1. (Historical — that Launcher/Menu entry is REMOVED by #2731; the #2731 replacement is S-10.)

- [x] S-4: **Telemetry Settings accessible** — gear/nav opens the settings dialog with sections visible. **PASS** — Settings dialog opens with Run CLI section visible. Evidence: Spec #2728 round 1.

- [x] S-5: **Screenshot captured** — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/<issue>/e2e/smoke.jpeg")` succeeds. **PASS** — Baseline screenshot saved. Evidence: Spec #2728 round 1.

- [x] S-6: **Run CLI opens exactly ONE window (quick path).** Click "Run CLI"; `tauri_manage_window(action="list")` immediately shows main + 1 terminal window and stays at main + 1 through launch. Quick smoke — full assertions live in F-1/F-2 (and F-14 for the toolbar path). **PASS** — Exactly 2 windows (main + run-cli-terminal). Evidence: Spec #2728 round 1 `## Tests Runs`.

- [x] S-7: **ghostty surface present (quick path).** DOM snapshot of the terminal window shows the ghostty terminal surface and NO `.xterm` classes. Quick smoke — full assertions live in F-3 (and F-15 for the toolbar path). **PASS** — Canvas 882×555px, zero `.xterm*` classes, overlay opacity 0. Evidence: Spec #2728 round 2 `## Tests Runs`.

- [x] S-8: **Terminal window auto-closes on exit (quick path).** Type `exit` in the terminal; `tauri_manage_window(action="list")` shows zero terminal windows shortly after. Quick smoke — full assertions live in F-7 (and F-17 for the toolbar path). **PASS** — `close_run_cli` closes window automatically. Window list shows only main. Evidence: Spec #2728 round 2 `## Tests Runs`.

- [x] S-9: **Working directory honored (quick path).** Run `pwd` in the terminal; output matches the configured `run_cli_work_dir` (or the home fallback when unset). Quick smoke — full assertions live in F-6/R-7 (and F-16 for the toolbar path). **PASS** — `pwd` returns `C:\Code\fredo` (configured value). Evidence: Spec #2728 round 2 `## Tests Runs`.

## #2731 smoke cases

- [x] S-10: **Run CLI toolbar desktop item present and clickable (quick path).** DOM-snapshot the maomaolabs toolbar; a "Run CLI" desktop item renders alongside the other showable-feature items and is clickable. Supersedes the S-3 Launcher/Menu entry for this round (that entry is removed). Quick smoke — full assertions live in F-12/F-13. **PASS** — DOM shows `button Run CLI [ref=e50]` in `toolbar Desktop Toolbar` alongside Mission Monitor and Query Viewer. Evidence: DOM snapshot at 2026-08-13T21:01:04Z.

- [x] S-11: **Toolbar launch opens exactly ONE window (quick path).** Click the Run CLI toolbar desktop item; `tauri_manage_window(action="list")` immediately shows main + 1 terminal window and stays at main + 1 through launch. Quick smoke — full assertions live in F-14/F-19. **PASS** — Window list shows 2 windows (main + run-cli-terminal). Evidence: window list at 2026-08-13T21:02:04Z.

- [x] S-12: **#2728 floating "RUN CLI" button absent (quick path).** DOM-scan of the Fredo desktop shows no floating RUN CLI button element outside the maomaolabs toolbar. Quick smoke — full absence assertions live in F-12. **PASS** — JavaScript scan found 0 fixed-position buttons. Only toolbar button exists. Evidence: JS check at 2026-08-13T21:01:04Z.
