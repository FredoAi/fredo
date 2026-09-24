# Terminal — Functional Test Suite

Feature domain: `terminal` (the renamed Run CLI surface: one Terminal window, a session
sidebar, concurrent OpenCode + GitHub Copilot sessions, per-session PTY I/O, default-CLI
preselection, Copilot launch/prerequisite/error surfacing, zero-orphan lifecycle).
Seeded at triage for Spec #2934.

**Evidence policy: LIVE.** Every PASS requires a live observable — the MCP-bridge window
list / DOM snapshot / screenshot of the `terminal` window, per-session **PTY buffer bytes**
(`get_pty_buffer{sessionId}`), the **process inventory**
(`process-hygiene.ps1 -List`), and `telemetry_spans` for the OpenCode session. A
grep-only / `cargo test`-only result is a **FALSE PASS** for every row below (it clears
only F-1's static half).

> **G-058:** the terminal is a SEPARATE native Tauri window rendering a Ghostty CANVAS —
> terminal text is invisible to DOM snapshots. Confirm windows with
> `tauri_manage_window(action="list")`, drive the PTY over IPC via
> `tauri_webview_execute_js` → `__TAURI__.core.invoke('<per-session command>', {…})`
> (trailing `\r` mandatory when submitting, G-037), and read output via the PTY buffer —
> never by searching the main DOM for terminal text.

> **Fixtures (G-172, in-repo only):** `.opencode/tests/terminal/fixtures/workdir-a/`,
> `…/workdir-b/`, `…/fixtures/empty-copilot-home/` (committed empty dir).

## Prerequisites (all cases)

- Spec branch built and running (`dev-env.ps1 -Action Up -Spec <N>`); MCP bridge connected
  (`tauri_driver_session start`).
- Copilot availability: `bun .opencode/scripts/copilot-otel-probe.ts --leg resolve` →
  `PROBE_RESOLVE_VERSION … 1.0.88`. If absent/unauthenticated, the GitHub legs are NAMED
  BLOCKERS (record `UNVERIFIED`, never PASS).
- No pre-existing orphans: `powershell -File .opencode/scripts/process-hygiene.ps1 -List`
  before the first launch.

## R-1 (AC1) — Named Terminal everywhere + work-dir migration

- [ ] F-1: **Rename completeness (static half).** Run the three receipts in
  `regression.md` / the plan's `### R-1 rename receipt`:
  `rg -i -n -g '!node_modules' -g '!target' -g '!dist' -g '!.serve' -e 'run[-_]?cli|runcli' apps/ apps/tauri/src-tauri/capabilities/ opencode.json`.
  EXPECTED: the only matches are the single migration read of the legacy key literal
  `run_cli_work_dir`; the corroborating zero-match receipts
  (`run-cli-terminal|open_run_cli|close_run_cli|get_run_cli_status|run-cli-output|run-cli-exited`,
  `Run CLI|run-cli` in `apps/ui/src`) print nothing.
  Edge: a generated `apps/tauri/src-tauri/gen/schemas/capabilities.json` still carrying an
  old label (regenerate — a stale generated file is a FAIL); `windowStore.test.ts` example
  ids; the `closeWindow('run-cli')` launcher call.
- [ ] F-2: **Renamed window label + title (live).** Launch Terminal from the desktop
  toolbar item; `tauri_manage_window(action="list")`.
  EXPECTED: the terminal window label = `terminal`, its title = `Terminal`; the capability
  window list includes `terminal`; no window labelled `run-cli-terminal`.
  Edge: window title after a session's work dir is set; relaunch after full restart.
- [ ] F-3: **Renamed display name + route (live).** Launch from the toolbar item.
  EXPECTED: the toolbar desktop item and the Settings → Terminal pane read `Terminal`;
  the terminal window URL is `index.html?view=terminal`; no `?view=run-cli` route exists.
- [ ] F-4: **Work-dir migration (no re-entry) — the required, tested case.** Pre-seed the
  LEGACY key, restart, launch:
  1. `tauri_webview_execute_js` (main): `__TAURI__.core.invoke('save_setting',{key:'run_cli_work_dir',value:'C:\\Code\\fredo\\.opencode\\tests\\terminal\\fixtures\\workdir-a'})`; then clear `localStorage.removeItem('run_cli_work_dir')` and `removeItem('terminal_work_dir')`.
  2. `dev-env.ps1 -Action Restart -Spec <N>`.
  3. Open the Terminal toolbar item; open Settings → Terminal; open a session.
  EXPECTED: `get_setting('terminal_work_dir')` = `…\fixtures\workdir-a`; the first
  session's `workDir` = `…\fixtures\workdir-a`; the Settings Terminal work-dir input is
  PRE-FILLED with that path (zero user keystrokes — no re-entry); the legacy key is no
  longer the live read path (see F-5).
  Edge: legacy key absent → home fallback; legacy key + new key both set (new wins);
  `localStorage` shadowing; second restart (migration idempotent); blank legacy value.
- [ ] F-5: **Legacy key is read only by the migration (discriminator).** After F-4, change
  ONLY the legacy key (`save_setting('run_cli_work_dir', <workdir-b>)`), restart, launch.
  EXPECTED: Terminal's session `workDir` stays `workdir-a` (the new key governs) — proves
  the legacy key is consumed once by the migration read, never as the live path.

## R-2 (AC2) — One window, sidebar, concurrent sessions, per-session I/O, instant switch

- [ ] F-6: **One window + sidebar with concurrent sessions.** Add session A = OpenCode
  (workdir-a); add session B = GitHub Copilot (workdir-b).
  EXPECTED: `tauri_manage_window(action="list")` = main + exactly ONE `terminal` window at
  every sample; `list_terminal_sessions` returns 2 entries with distinct `id` + `cli`
  (`opencode`/`copilot`) and their own `workDir` (workdir-a / workdir-b); the sidebar lists
  2 sessions with distinct labels; both CLI processes are alive concurrently
  (`process-hygiene.ps1 -List` shows each under the current Fredo PID with its own work-dir
  CommandLine).
  Edge: add a session while the first is still `starting`; two sessions of the SAME CLI.
- [ ] F-7: **Add-session prompts OpenCode vs GitHub.** From the sidebar's add control.
  EXPECTED: a prompt/menu renders with BOTH choices (`OpenCode`, `GitHub`); choosing one
  creates a session of that CLI; the window does not change count.
  Edge: rapid double-click on add (no duplicate); Esc dismiss (no session created);
  keyboard activation (Enter/Space).
- [ ] F-8: **Per-session I/O isolation (deterministic, no network).**
  `write_pty_input{sessionId: A, data: 'SENTINEL_A_<guid8>'}` (no `\r`) and
  `{sessionId: B, data: 'SENTINEL_B_<guid8>'}`; read both with
  `get_pty_buffer{sessionId}`.
  EXPECTED: A's buffer contains `SENTINEL_A_<guid8>` and NOT `SENTINEL_B_<guid8>`; B's the
  reverse. Corroboration: A's startup buffer matches `(?i)opencode`, B's `(?i)copilot`;
  each session record carries its own `cli` + `workDir` (workdir-a vs workdir-b).
  Edge: if a TUI withholds echo until submit, record the path used and fall back to the
  two distinct startup buffers + per-session records; a sentinel never triggers an LLM
  turn (no `\r`).
- [ ] F-9: **Selecting a session shows its live terminal.** Type into A, switch to B, back
  to A.
  EXPECTED: the active session (DOM-observable selected sidebar item) is the session whose
  buffer is rendered; the visible screenshot matches the active session's buffer content;
  the non-active session's buffer is unchanged.
- [ ] F-10: **Switch is immediate, no re-spawn / no remount.** Record A's and B's session
  `id` (+ PID from `process-hygiene.ps1 -List`, or `pid` on `list_terminal_sessions` if the
  SA exposes it); click B, then A.
  EXPECTED: the target terminal becomes visible + focused within the UI/UX Doherty budget
  (<100 ms; INP ≤200 ms); no new session record; A's and B's `id` (and PID) are unchanged
  (a re-spawn would change the PID / clear the buffer — a fast switch by re-spawn is a
  FAIL); A's pre-switch buffer contents are preserved after switching back.
  Edge: switch during heavy output; switch immediately after launching a session.
- [ ] F-11: **Per-session resize.** Resize the `terminal` window while B is the active
  session; then switch to A.
  EXPECTED: the PTY resize is applied to the ACTIVE session only (`resize_pty{sessionId}`);
  A's PTY dimensions are unchanged by B's resize; both buffers still render.

## R-3 (AC3) — Default CLI setting preselects a new session

- [ ] F-12: **Default CLI persisted + preselected.** Settings → Terminal → "Default CLI":
  select `GitHub`, Save, restart; open the add-session prompt. Then select `OpenCode`,
  Save, restart, re-open the prompt.
  EXPECTED: `get_setting('terminal_default_cli')` persists across restart; the add-session
  prompt shows the configured CLI in a DOM-observable selected state (Chakra `RadioCard` →
  `aria-checked="true"` on the radio, or `SegmentGroup` → `data-state=on`, per the UI/UX
  prompt spec); choosing the other option still creates the other CLI; the selected
  sidebar row carries `aria-current="true"`.
  Edge: first run with no default stored → the plan's documented initial default is
  preselected (unstated ⇒ flag, do not guess); invalid persisted value → safe fallback;
  changing the default does not mutate existing sessions.

## R-4 (AC4) — Copilot launch: resolve, PS6+ prerequisite, in-window errors

- [ ] F-13: **Copilot positive launch.** Add a GitHub session.
  EXPECTED: the session reaches `running`; a GitHub TUI renders in the active canvas; the
  resolved `copilot` path is observable in the app logs (`dev-env.ps1 -Action Logs`, the
  `fredo::terminal` tracing line mirroring `commands.rs:200`); the PowerShell 6+
  prerequisite passes; no `error` state; the OpenCode leg's `telemetry_spans` unaffected.
- [ ] F-14: **4a — missing Copilot binary (SA `testOverride` seam).**
  `tauri_webview_execute_js` (window `terminal`) →
  `__TAURI__.core.invoke('spawn_terminal_session', { cli:'copilot', workDir:'C:\\Code\\fredo', testOverride:{ binary:'C:\\Nonexistent\\copilot.exe' } })`;
  then read `list_terminal_sessions` and select the created session in the sidebar.
  EXPECTED: the session `status='error'` with a `cause-naming` `error` containing `copilot`
  + "not found"; the pane renders the UI/UX §6 "GitHub Copilot not found" state with
  Retry + Close session; terminal state within 10 s; no forever-spinner; main window
  responsive; NOTHING spawned.
  Edge: override set to a directory; override set to a non-executable file.
- [ ] F-15: **4b — invalid work directory.** `save_setting('terminal_work_dir','C:\\NonexistentDir12345')` (or a per-session workdir) → add a session.
  EXPECTED: clear "Working directory not found: …" error within 10 s; after restoring the
  dir, Retry launches normally; no hang.
- [ ] F-16: **4c — unmet PowerShell 6+ prerequisite (SA `testOverride` seam).**
  `__TAURI__.core.invoke('spawn_terminal_session', { cli:'copilot', workDir:'C:\\Code\\fredo', testOverride:{ pwshMajor: 5 } })`,
  paired with a CONTROL spawn WITHOUT the override on this host (where `pwsh` ≥ 6 resolves).
  EXPECTED: the `pwshMajor:5` session is `status='error'` with an `error` naming PowerShell
  6+ (SA text "GitHub Copilot requires PowerShell 6 or newer (pwsh). …" / UI/UX §6
  "PowerShell 6 or newer required"); no PTY opened; within 10 s; the control spawn launches
  normally (the observation is non-vacuous from the override, not the host).
- [ ] F-17: **4d — auth / launch failure surfaced, not silent (FX-2 lever).** Drive the
  in-repo fixture through the EXISTING diagnostic override (no product seam):
  1. `tauri_webview_execute_js` (window `terminal`) →
     `__TAURI__.core.invoke('save_setting', { key:'terminal_copilot_path', value:'C:\\Code\\fredo\\.opencode\\tests\\terminal\\fixtures\\fake-copilot-auth.cmd' })`.
  2. `__TAURI__.core.invoke('spawn_terminal_session', { cli:'copilot', workDir:'C:\\Code\\fredo\\.opencode\\tests\\terminal\\fixtures\\workdir-a' })`.
  3. Read `list_terminal_sessions` + `get_pty_buffer{sessionId}`.
  4. Clear the override (`save_setting('terminal_copilot_path','')`).
  EXPECTED (per SA FX-2 — Fredo does not intercept Copilot auth; the covering
  `SessionErrorState('auth')` render branch is a documented residual, NOT asserted):
  that session's `errorKind === 'auth'` on `list_terminal_sessions`; the fixture's OWN auth
  copy (`GitHub Copilot CLI` / `You are not logged in. Please sign in.`) appears in the PTY
  buffer (`get_pty_buffer` — not swallowed, not a silent blank); a terminal state is reached
  within 10 s; no hang; no orphan after close. The control run launches normally (F-13).
  NOTE (round 2): the retired `COPILOT_HOME` env lever is removed — it could not clear
  Copilot's stored auth.
  Edge: quota/rate-limit message (degradation surfaced, not silent).
- [ ] F-18: **Negative cleanup.** After each of F-14..F-17, close the error window.
  EXPECTED: `process-hygiene.ps1 -List` shows no new `copilot`/`node` child from the failed
  launch; the window closes cleanly; the main window stays healthy.

## R-5 (AC5) — Close a session / the window, no orphan

- [ ] F-19: **Close one session, the other survives.** With A and B running, close A from
  the sidebar.
  EXPECTED: A's session record is gone; A's entire process subtree is gone
  (`process-hygiene.ps1 -List`); B is still `running` and still streams output; the window
  stays open; the sidebar shows only B.
  Edge: close during B's startup; close two sessions back-to-back; close a non-active
  session.
- [ ] F-20: **Close the Terminal window → all sessions reaped.** With A and B running,
  close the `terminal` window (OS X / Alt+F4 — also test the in-app close if present).
  EXPECTED: `tauri_manage_window(action="list")` = main only; `process-hygiene.ps1 -List`
  shows ZERO Fredo-spawned `opencode`/`copilot`/`node` processes; zero session records; no
  stale window; the main window stays responsive.
  Edge: close while a session is starting; close while the error surface is shown; close
  immediately after a session self-exits.
- [ ] F-21: **Session self-exit → that session marked `exited`; window STAYS OPEN.** End a
  session from inside its CLI (exit / Ctrl-D).
  EXPECTED: only that session becomes `status='exited'`, its sidebar row + buffered output
  are RETAINED, its process is gone (`process-hygiene.ps1 -List`); the OTHER session keeps
  streaming; the window STAYS OPEN (the pre-rename auto-close at `commands.rs:362-364` is
  removed — SA R-5.3 / UI/UX §3); the all-exited state shows only when every session has
  ended.
  Edge: session exits while NOT selected; session exits during a switch; session exits
  during startup.

## Non-functional

- [ ] N-1: **Main window unblocked** — navigate features + Mission Monitor while A and B
  both stream. EXPECTED: no freeze/jank; console clean (`tauri_read_logs(source="console")`).
- [ ] N-2: **Immediate switch / no re-spawn** — see F-10 (binding gate = unchanged
  pid/`startedAt`, not the timing number alone).
- [ ] N-3: **Rename completeness** — see F-1.
- [ ] N-4: **Theme/tokens** — new sidebar/menu/settings chrome reads tokens; no hardcoded
  hex/rgba except the allowlisted `GHOSTTY_THEME` ANSI palette; no invalid
  `var(--token)NN` alpha-append.
- [ ] N-5: **No persistence (non-goal)** — after `-Action Restart`, the sidebar is empty;
  no `terminal` session rows in `fredo.db`; no resume.
- [ ] N-6: **Console hygiene (both windows)** — no `Error:`/`Uncaught`/`Maximum update
  depth exceeded` in the main OR terminal window.
- [ ] N-7: **Zero orphans** — see F-19/F-20.
- [ ] N-8: **Accessibility** — sidebar items + add-session menu keyboard-reachable and
  ARIA-labelled; no focus trap.

## Round notes

> (Tester appends per-round results here — keep `- [ ]` on FAIL/UNVERIFIED, mark PASS with
> live evidence, promote confirmed exploratory probes to a new `F-` row keeping the origin
> note.)

### Round 1 — 2026-09-24, spec/2934 @ 1fd60694 (verdict FAIL; no product defect)

**PASS:** F-1 (rename receipt: exactly 1 hit `settings.ts:18`), F-2 (window `terminal` /
title `Terminal` / route `?view=terminal` / capabilities `["main","terminal"]`), F-3
(display name + Settings nav `Terminal`), F-4 (legacy→new copy + 0-keystroke prefill), F-5
(legacy rewrite does NOT move the dir), F-6 (main+1; OpenCode+OpenCode and OpenCode+Copilot
concurrent), F-7, F-8 (sentinels: own present, foreign absent both ways), F-9, F-10
(`aria-current` follows, `id`/`pid`/`startedAt` unchanged, buffers preserved, non-active
terminals mounted with `visibility:hidden`), F-12, F-14 (`missing-binary`, 276 ms), F-15
(`invalid-cwd`), F-16 FORCED (`pwshMajor:5` → `prereq`, 1.56 s), F-18, F-19, F-20, F-21.

**UNVERIFIED (environment — host has no PowerShell 6+; `Bun.which('pwsh')===null`):**
F-13 native positive (`errorKind=prereq` for every native Copilot launch; the launch path
itself PASSED gate-bypassed via the TEST-ONLY `testOverride:{pwshMajor:7}` →
`cmd.exe`→`node npm-loader`→`copilot.exe` + live TUI), F-16 control (host default < 6 →
non-vacuity impossible), F-17 4d (empty `COPILOT_HOME` did NOT clear Copilot auth; CLI
showed its own trust prompt + authenticated TUI, not swallowed, no hang).

**UNVERIFIED (time-boxed, not attempted):** F-11 (per-session resize).

Open item: fixture dirs are empty and untracked (git can't track empty dirs); add
`.gitkeep` + `tests-commit --feature terminal` if the cluster wants them committed.

### Round 2 — 2026-09-24, spec/2934 @ a656a020 (verdict FAIL — 2 rows)

Cold-restarted dev instance (the FX-1 fix is Rust; warm fast-path serves the old binary).

**FX-1 verified — the headline defect is FIXED.** Native GitHub Copilot (resolved
`copilot.cmd`, NO override) now reaches `status='running'` (pid 20408) with a live Copilot
TUI in the buffer (`Copilot v1.0.88`, folder-trust prompt) and the real process tree
`cmd.exe 20408 → node npm-loader 948 → copilot.exe 17980`. F-13 PASS; F-16 control now
non-vacuous.

**PASS:** F-1 (1 hit `settings.ts:18`), F-2/F-3, F-4 (legacy→new copy; 0-keystroke prefill —
NOTE: must clear the `terminal` window's `localStorage` too, not only SQLite, or the stale
`localStorage` value short-circuits the migration), F-5, F-6, F-8 (A echoed its own sentinel;
B's Copilot TUI withholds echo until submit — documented path), F-9, F-10 (`id`/`pid`/
`startedAt` unchanged), F-12, F-13 (native), F-14/F-15 (unchanged), **F-16 (forced + control
non-vacuous)**, F-18, F-19, F-20, F-21, N-1..N-8.

**FAIL — F-17 (FX-2 auth lever).** `terminal_copilot_path` = `fake-copilot-auth.cmd` →
the auth copy IS in the buffer (130 B, `GitHub Copilot CLI` / `You are not logged in. Please
sign in.`), no hang, no orphan — BUT `list_terminal_sessions` returns `errorKind=null`
(expected `'auth'`) and the session never reaches a terminal state (stays `running`; no
`terminal-exited`). Root cause: `commands.rs:665-674` checks `detect_auth_marker` ONLY on the
first reader chunk; an instrumented `terminal-output` listener shows the reader got chunk 1 =
16 B of ConPTY mode escapes and chunk 2 = 114 B with the marker → never detected. Reproduced
twice. **New defect.**

**FAIL — F-11 (per-session resize).** Window resize while B is active changed NEITHER A nor
B (`resize_pty` fired for neither); only an activation switch re-fits and pushes a per-session
`resize_pty` (A selected → A 99×15, B untouched — isolation half holds). Root cause:
`SessionTerminal.tsx` has NO `ResizeObserver`/window-resize listener — `fit()` runs only on
mount and on activation. **New defect** (the plan/UI-UX §2 specifies the ResizeObserver path).

Round-2 evidence frame names: `r2-f13-copilot-native`, `r2-f16-prereq-selected`,
`r2-f17-auth-buffer`, `r2-ac1-migration-prefill`, `r2-ac2-switch-opencode`,
`r2-ac3-settings-defaultcli`, `r2-ac5-selfexit`.
