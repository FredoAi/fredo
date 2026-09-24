# Terminal — Smoke Test Suite

Feature domain: `terminal` (renamed Run CLI surface). Standard boilerplate adapted from
`.opencode/tests/README.md` plus feature-specific quick paths for Spec #2934.

Conventions: ID prefix `S-`. Observable expected outcomes.

## Feature usage: launching sessions in the Terminal window

After #2934 the flow is: click the **Terminal** desktop item in the maomaolabs toolbar →
ONE `terminal` Tauri window opens hosting a session sidebar → add sessions (OpenCode or
GitHub Copilot) → select one to view its live terminal. There is NO per-session window.

1. Click the **Terminal** desktop item in the maomaolabs toolbar.
2. `tauri_manage_window(action="list")` → expect the main window + exactly ONE `terminal`
   window (label `terminal`, title `Terminal`).
3. Add a session: choose `OpenCode` and/or `GitHub`. The sidebar lists each session.
4. Drive the active session's PTY over IPC:
   `tauri_webview_execute_js` (windowId `terminal`) → `__TAURI__.core.invoke('write_pty_input', { sessionId: '<id>', data: "<cmd>\r" })`
   (trailing `\r` mandatory, G-037); read output via
   `__TAURI__.core.invoke('get_pty_buffer', { sessionId: '<id>' })`.
   The `Starting OpenCode…` overlay is a LOADING state — wait through it (first launch can
   take up to ~60 s) before concluding a launch failed.
5. Close a session from the sidebar → only that session's processes stop; the window stays
   open if a session remains. Close the window → all sessions reaped.

**Never invoke `opencode`/`copilot` from a shell.** The app resolves and launches them. Never
touch `~/.config/opencode/*` or `%APPDATA%\com.fredo.app\*` directly. For the AC4 negatives,
use the documented levers (the binary-path override / `dev-env.ps1 -EnvVar` seams) — never
uninstall a binary or edit the OS PATH.

## Cases

- [ ] S-1: **App window renders** — `tauri_webview_dom_snapshot(type="structure")` returns a
  non-empty `<body>`.
- [ ] S-2: **No console errors** — `tauri_read_logs(source="console", lines=50)` shows no
  `Error:`/`Uncaught`/`Maximum update depth exceeded`.
- [ ] S-3: **Terminal surface reachable** — the `Terminal` desktop item renders in the
  maomaolabs toolbar and is clickable.
- [ ] S-4: **Settings accessible** — Settings → Terminal section renders (Telemetry +
  Companion + Appearance sections still present).
- [ ] S-5: **Screenshot captured** —
  `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/2934/e2e/smoke.jpeg")`
  succeeds.
- [ ] S-6: **One window (quick path)** — click the Terminal toolbar item;
  `tauri_manage_window(action="list")` shows main + exactly ONE `terminal` window and stays
  there through launch. Full assertions in `functional.md` F-2/F-6.
- [ ] S-7: **Sidebar renders (quick path)** — the `terminal` window DOM shows the session
  sidebar + add-session control. Full assertions in F-6/F-7.
- [ ] S-8: **OpenCode session launches (quick path)** — add an OpenCode session; the session
  reaches `running` and its PTY buffer becomes non-empty. Full assertions in F-6/F-8.
- [ ] S-9: **GitHub Copilot session launches (quick path, live)** — add a GitHub session; a
  Copilot TUI renders (or the AC4 error surface shows, never a hang). Full assertions in
  F-13.
- [ ] S-10: **Switch sessions (quick path)** — click each sidebar item; the active session
  changes and the window count stays main + 1. Full assertions in F-9/F-10.
- [ ] S-11: **Close session + window reaps processes (quick path)** — close one session
  (the other survives), then close the window; `process-hygiene.ps1 -List` shows no orphaned
  opencode/copilot/node process. Full assertions in F-19/F-20.
- [ ] S-12: **Rename quick check** — window label `terminal`, title `Terminal`, toolbar item
  reads `Terminal`; the zero-match receipts in `regression.md`/F-1 pass. Full assertions in
  F-1..F-3.
- [ ] S-13: **Persist + list (quick path)** — add a session, close the `terminal` window, reopen;
  the session is still listed with its CLI + workDir. Full assertions in F-22/F-23.
- [ ] S-14: **Resume (quick path)** — resume a persisted record; a PTY starts and its buffer is
  non-empty. Full assertions in F-24/F-25 (the sentinel + the fresh-session control).
- [ ] S-15: **Teardown receipt (quick path)** — close the window with sessions live;
  `process-hygiene.ps1 -List` reports `0 opencode/node/copilot process(es)` and the records are still
  listed on reopen. Full assertions in F-27/F-28.
- [ ] S-16: **CLI open (quick path)** — `fredo open-terminal --cli opencode --dir
  C:\Code\fredo\.opencode\tests\terminal\fixtures\workdir-a` → exit 0 and the `terminal` window opens
  with an OpenCode session in that dir. Full assertions in F-33/F-34.

### #2935 testing round 1 (spec/2935 @ 9ad0b360) — results

- **S-1 PASS.** `tauri_webview_dom_snapshot`/DOM non-empty (launcher + window manager render).
- **S-2 PASS.** No `Error:`/`Uncaught`/`Maximum update depth exceeded` in the main OR `terminal`
  window console (only the pre-existing `motion() is deprecated` WARN + `[ghostty-vt]` renderer WARNs).
- **S-3 PASS.** The `Terminal` desktop item renders on the revealed launcher grid
  (`div[aria-label="Terminal"]`) and is clickable.
- **S-4/S-5 PASS (from #2934 rounds).**
- **S-6 PASS.** Launcher click → `main + 1 terminal` window; re-invoke focuses (no duplicate).
- **S-13 PASS.** Add session → close window → reopen lists it ("Previous sessions").
- **S-14 PASS.** Resume a persisted record → a PTY starts (`status=running`) and its buffer is
  non-empty and contains the prior conversation (`TERMINAL_RESUME_2935_SENTINEL`).
- **S-15 PASS.** Close the window with sessions live → `process-hygiene.ps1 -List` shows the terminal
  session trees gone, 0 unprotected orphans; the records are still listed on reopen.
- **S-16 PASS.** `fredo open-terminal --cli opencode --dir …\workdir-b` → exit **0**
  `{"cli":"opencode","outcome":"started","workDir":"…\\workdir-b"}`, the `terminal` window opens,
  a session with that cli+workDir spawns and is auto-selected (no dialog).
