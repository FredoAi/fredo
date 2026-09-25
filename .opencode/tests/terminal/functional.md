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
  > **SUPERSEDED by #2935** (do NOT run as written): persistence/resume is now REQUIRED. The #2934
  > non-goal assertion is retained only as the historical record; the live assertions are the
  > `#2935` rows F-22..F-36 + N-9..N-17 below (a restart MUST list the persisted records).
- [ ] N-6: **Console hygiene (both windows)** — no `Error:`/`Uncaught`/`Maximum update
  depth exceeded` in the main OR terminal window.
- [ ] N-7: **Zero orphans** — see F-19/F-20.
- [ ] N-8: **Accessibility** — sidebar items + add-session menu keyboard-reachable and
  ARIA-labelled; no focus trap.

## #2935 — Persistence, resume, and the `fredo` open-Terminal command (AC1/AC2/AC4)

> Seeded at triage for Spec #2935. Sessions persist as RECORDS across window close/reopen + app
> restart; reopening lists them and offers RESUME through the CLI's OWN resume mechanism
> (`--resume`/`--continue`), never keep-alive. Closing the window TERMINATES processes while
> keeping the records. Resume is refusable + removable; an unresumable record surfaces a clear
> message. Bind rows to the SA-published command/setting names (fallback: records on
> `list_terminal_sessions`, `resume_terminal_session{sessionId}`, `delete_terminal_session_record{sessionId}`).
> **Evidence policy: LIVE** (per the suite header + the plan's `> Verification policy: live`).

> **Fixture note (G-172, in-repo only):** `fixtures/workdir-a/` (committed `README.md`) and
> `…/workdir-b/` are the resume working directories; `no-such-binary.cmd` / `no-such-dir` under the
> same folder are DELIBERATELY MISSING negative data (never create them). The sentinel
> `TERMINAL_RESUME_2935_SENTINEL` is a literal in the plan.

### AC1 — persisted list + real resume

- [ ] F-22 (**R-1.1a, AC1**): Add A = OpenCode in `workdir-a` and B = GitHub Copilot in
      `workdir-b`; capture `list_terminal_sessions` (ids/cli/workDirs). Close the `terminal` window
      (OS close). Reopen Terminal.
      EXPECTED: main + one `terminal` window; A and B still listed with the SAME ids/cli/workDirs and
      a resumable marker; neither is running.
      Edge: reopen twice (no duplicate records); a record whose workDir no longer exists is still
      listed (resume refuses — F-31/F-32).
- [ ] F-23 (**R-1.1b, AC1**): After F-22, `dev-env.ps1 -Action Restart -Spec <N>`; reopen Terminal.
      EXPECTED: the SAME record ids/cli/workDirs as F-22 (persistence survives a full app restart);
      the reopen itself starts no process.
      Edge: zero records → empty state; two restarts; reopen before the list resolves (loading, not a
      false empty).
- [ ] F-24 (**R-1.1c, AC1 — load-bearing**): In live session A (OpenCode, workdir-a)
      `write_pty_input{sessionId:A, data:"TERMINAL_RESUME_2935_SENTINEL\r"}` (one bounded real turn);
      capture `get_pty_buffer{A}` (contains the sentinel). Close the window. Reopen and RESUME A.
      EXPECTED: a PTY starts for A's record with `cli=opencode` + `workDir=…\workdir-a`; the
      post-resume buffer contains `TERMINAL_RESUME_2935_SENTINEL`; the resume process CommandLine
      (`process-hygiene.ps1 -List`) carries the resume switch (`--continue`/`--resume <id>`) or the
      app logs the resume launch; A's record id is unchanged (last-active updated).
      Edge: CLI prints "no session"/"cannot resume" → F-30 (unresumable), never a silent fresh
      session; resume while another session streams; resume twice (no duplicate PTY).
- [ ] F-25 (**R-1.1d, AC1 — discrimination control, non-vacuous**): right after F-24, start a control
      session with the SAME cli + workdir WITHOUT resume; compare buffers.
      EXPECTED: the control buffer does NOT contain the sentinel and does not re-render the prior
      conversation; the resumed buffer does; the control spawns a NEW record id while the resume keeps
      A's id.
      Edge: a control that also shows the sentinel = the oracle is blind (FAIL + flag it); an empty
      resumed buffer = no history re-render.
- [ ] F-26 (**R-1.1e, AC1**): read the record payloads (`list_terminal_sessions`) and `rg` the record
      struct.
      EXPECTED: each record carries exactly `cli`, `workDir`, title/identity (+ stable id), and timing
      (`lastActive`/`createdAt`); the sidebar shows each record's CLI name + workDir basename.
      Edge: blank workDir → `~`; two same-CLI records get distinct titles.

### AC2 — teardown receipt + records survive

- [ ] F-27 (**R-2.1, AC2 — process receipt**): with A + B running capture the pids + the
      `process-hygiene.ps1 -List` inventory. Close the `terminal` window (OS close) and
      `close_terminal_window`.
      EXPECTED: `process-hygiene.ps1 -List` summary reads `0 opencode/node/copilot process(es)` and
      `0 unprotected orphan candidate(s)`; `Get-Process -Id <each captured pid>` reports "Cannot find a
      process" for EVERY captured pid; the named `cmd.exe` scan finds no CommandLine containing
      `opencode`/`copilot`/`workdir-a`/`workdir-b`.
      Edge: close during `starting`; close while the error surface shows; close right after a self-exit.
- [ ] F-28 (**R-2.2, AC2**): reopen Terminal immediately after F-27.
      EXPECTED: A and B still listed (same ids, resumable) AND `-List` still reads zero — reopen
      restores availability, not a process (no keep-alive/reattach).
      Edge: reopen after a restart between close and reopen; resume one record then re-run `-List`
      (exactly one process per resumed record).
- [ ] F-29 (**R-2.3, AC2**): with A + B running, `close_terminal_session{A}`.
      EXPECTED: A's process tree gone; B still `running` + streaming; the window stays open; A's row is
      removed (or marked non-resumable per the SA contract) — no ghost row.
      Edge: close the non-active session; two back-to-back; close a record-only entry.

### AC4 — negatives (first-class rows)

- [ ] F-30 (**R-4.3, AC4 — unresumable**): persist a Copilot record (spawn B, close the window);
      `save_setting{key:'terminal_copilot_path', value:'C:\Code\fredo\.opencode\tests\terminal\fixtures\no-such-binary.cmd'}`;
      restart; resume B.
      EXPECTED: a clear cause-naming message (`missing-binary` naming `copilot`) reaches a terminal
      state within the SA's bound (resume pre-flight 5 s); NO fresh/wrong session starts; B's record is
      retained + still removable; no orphan. **Control:** clear the override
      (`save_setting('terminal_copilot_path','')`), restart, resume the SAME record → it succeeds.
      Edge: override = a directory; override = a non-executable file; resume twice while missing.
- [ ] F-31 (**R-4.4, AC4**): from a persisted record, (a) choose "start fresh"; (b)
      `delete_terminal_session_record{record}`.
      EXPECTED: (a) a NEW record is appended, the persisted one untouched (id/fields unchanged);
      (b) the record is gone and stays gone after a restart; removing a live-owning record leaves no
      process; no window double-open.
      Edge: refuse then resume the same record (still resumable); remove the selected record
      (selection falls to a valid entry); remove all → empty state.
- [ ] F-32 (**R-4.5, AC4**): persist a record in `workdir-a`; rename that dir away (in-repo,
      reversible); resume.
      EXPECTED: typed `invalid-cwd` + a clear message; no partial session; the record is retained;
      after restoring the dir name the resume succeeds.
      Edge: dir removed between listing and clicking resume; resume with the CLI ALSO missing (record
      the cause priority).

### AC4 — CLI negatives (drive the real binary)

- [ ] F-33 (**R-4.1, AC4**): `fredo open-terminal --cli bogus` (and IPC
      `spawn_terminal_session{cli:'bogus', workDir:'…\workdir-a'}`).
      EXPECTED: a clear error naming the invalid CLI; session list count unchanged; no process started.
      Edge: `OpenCode` wrong case rejected; empty string; `claude`.
- [ ] F-34 (**R-4.2, AC4**): `fredo open-terminal --cli opencode --dir …\no-such-dir` (and the IPC
      spawn form).
      EXPECTED: typed `invalid-cwd` + "Working directory not found: …" within 10 s; NO PTY/process; the
      window renders the state (no hang); retry after a valid dir launches normally.
      Edge: a file path instead of a directory; whitespace-only `--cli`.

### AC1/AC4 — reopen gating + the blocked/resuming states (UI/UX §5b/§5c/§6, requested)

- [ ] F-35 (**R-1.1f, AC1 — gating**): (a) with persisted records present, reopen Terminal; (b) clear
      the records and reopen.
      EXPECTED: (a) the pane auto-selects the most-recent previous record and shows
      `terminal-resume-state` (zero clicks); `terminal-all-ended-state` ("All sessions ended") is NOT
      shown; the New Session dialog did NOT auto-open; the "Previous sessions" header + count render.
      (b) control: with zero live + zero persisted, `terminal-empty-state` renders and the add prompt
      auto-opens.
      Edge: live `exited` + persisted both present (per-session ended banner shows, Previous group stays
      actionable); only unresumable records → no silent dead-end.
- [ ] F-36 (**R-4.6, AC4 — bounded resuming → resume-failed + the four blocked causes**): drive a
      resume that is slow then fails; separately render each `terminal-resume-blocked-state` cause.
      EXPECTED: `terminal-resuming-state` renders ("Resuming `<title>`…") with the ≥3 s hint and a
      **Cancel** that aborts leaving the record `resumable`; the surface flips to
      `terminal-resume-blocked-state` with `data-reason='resume-failed'` + raw message + **Retry**
      within the watchdog bound (never a hang); the record is unchanged. The four causes render
      distinctly: `cli-missing` (F-30), `invalid-cwd` (F-32), `resume-failed` (this row), `invalid-cli`
      (F-33).
      Edge: `transcript-missing` is a **named blocker** — no in-repo lever deletes the CLI transcript
      (out-of-repo store, G-009); UNVERIFIED unless the SA exposes a reason path. Retry after the cause
      clears → `Resumed`.

## Non-functional (Spec #2935)

- [ ] N-9 (**N-1**): dump every persisted record payload (and the record table via
      `telemetry-query.ps1 -Query "PRAGMA table_info(<t>)"` if a table exists), then
      `Select-String -Pattern 'ghp_|github_pat_|sk-|token|password|secret|authorization|bearer|api[_-]?key|cookie' -AllMatches`.
      EXPECTED: ZERO credential-shaped matches; the field set is exactly `{cli, workDir, title/id,
      timing}` (no env/args/headers/tokens).
- [ ] N-10 (**N-2**): a resume that cannot complete reaches a terminal/`error` state (or the CLI's own
      exit) within ≤10 s with a message; record the measured success + failure times.
      EXPECTED: no indefinite spinner/hang.
- [ ] N-11 (**N-3**): after F-27 `-List` = 0; reopen starts 0 processes until an explicit resume;
      `rg -i 'attach|detach|keep-?alive|daemon'` over the terminal feature + diff finds no
      attach/detach/keep-alive surface.
- [ ] N-12 (**N-4**): `tauri_read_logs(source="console", lines=50)` clean in BOTH the main and
      `terminal` windows across close/reopen/restart/resume (no `Error:`/`Uncaught`/`Maximum update
      depth exceeded`).
- [ ] N-13 (**N-5**): the persisted record struct carries only CLI/directory/title/timing; pin (static)
      that no raw PTY buffer / launch args / environment is persisted.
- [ ] N-14 (**N-6**): new resume/refuse/remove chrome reads theme tokens; no hardcoded hex/rgba except
      the allowlisted renderer ANSI palette; no invalid `var(--token)NN` alpha-append.
- [ ] N-15 (**N-7**): resume/refuse/remove affordances keyboard-reachable + ARIA-labelled +
      DOM-observable; no focus trap; the active record carries `aria-current`.
- [ ] N-16 (**N-8**): static/diff pin — no cross-device sync path and no session-content mutation added.
- [ ] N-17 (**N-9**): reopen with N persisted records renders the list within the UI/UX budget; the
      main window stays responsive during reopen + resume.

## #2940 — full-height multi-session workspace (AC1/AC2/AC3), fixture isolation (AC4), regression (AC5)

> Seeded at triage for Spec #2940 (revises #2934). The terminal pane must fill its pane at
> default / minimum / resized sizes (AC1), the window must read as ONE coherent multi-session
> workspace with the terminal dominant (AC2), every session-state surface must stay
> reachable + legible (AC3), the terminal suites must leave the developer's "Previous
> sessions" list untouched (AC4), and the #2934/#2935 behavior must not regress (AC5).
>
> **Evidence policy: LIVE + MEASURED.** AC1/AC2 are cleared only by the measured rendered
> geometry (the recipe below) captured as NUMBERS, corroborated by a described frame. A
> screenshot alone is NOT proof. Window builder pin: `commands.rs:1027-1028`
> (`inner_size(900,600)`, `min_inner_size(560,360)`).
>
> **Frames (G-104 — no file extensions in these names):** `r2940-ac1-default`,
> `r2940-ac1-min`, `r2940-ac1-max`, `r2940-ac2-min`, `r2940-ac3-states`.

### Geometry recipe (run in the `terminal` window via `tauri_webview_execute_js`)

> Reconciled to the UI/UX `## UI/UX Expert` §4 published hooks: pane =
> `[data-testid="terminal-pane"]` (+ `data-surface`/`data-cols`/`data-rows`); rail =
> `[data-testid="terminal-session-bar"]`; active surface =
> `[data-testid^="terminal-surface-"][data-active="true"]`; canvas host =
> `[data-testid^="terminal-canvas-host-"]`. (The earlier `terminal-pane-region` proposal is
> withdrawn.)

```js
(() => {
  const px = (n) => Math.round(n * 100) / 100;
  const r = (el) => { const b = el.getBoundingClientRect();
    return { x: px(b.x), y: px(b.y), w: px(b.width), h: px(b.height),
             right: px(b.right), bottom: px(b.bottom) }; };
  const pane = document.querySelector('[data-testid="terminal-pane"]');
  const bar = document.querySelector('[data-testid="terminal-session-bar"]');
  const surface = document.querySelector('[data-testid^="terminal-surface-"][data-active="true"]');
  const canvasHost = document.querySelector('[data-testid^="terminal-canvas-host-"]');
  const canvas = surface?.querySelector('canvas');
  const root = document.getElementById('root');
  return {
    innerW: window.innerWidth, innerH: window.innerHeight,
    docScrollH: document.documentElement.scrollHeight,
    root: root && { ...r(root), offsetW: root.offsetWidth, offsetH: root.offsetHeight },
    pane: pane && { ...r(pane), offsetW: pane.offsetWidth, offsetH: pane.offsetHeight,
                    clientW: pane.clientWidth, clientH: pane.clientHeight,
                    dataSurface: pane.dataset.surface, dataCols: pane.dataset.cols,
                    dataRows: pane.dataset.rows },
    bar: bar && { ...r(bar), offsetW: bar.offsetWidth, h: bar.offsetHeight },
    surface: surface && r(surface),
    canvas: canvas && { ...r(canvas), pxW: canvas.width, pxH: canvas.height },
    canvasHost: canvasHost && r(canvasHost),
  };
})()
```

**Tolerances (PASS gates, UI/UX §4):** **T1** `pane.width == innerW ±2` &&
`pane.height == innerH − 44 ±2` && `pane.right == innerW ±2` && `pane.bottom == innerH ±2`;
**T2** dead band `pane.bottom − canvas.bottom ≤ 8` AND `pane.right − canvas.right ≤ 8`
(nothing ≥8 px below/beside) and `canvasHost` rect == `pane` rect ±2; **T3** active `surface`
rect == `pane` rect ±2; **T4** `docScrollH ≤ innerH + 1` && `#root.offsetH == innerH ±2`;
**T5** rail `bar.h == 44 ±1` && `bar.offsetW == innerW ±2` && `pane.offsetW >` the
`[role="tablist"]` width && `pane.offsetH ≥ innerH − 46`; **T6** grid: `pane[data-cols]`/
`pane[data-rows]` change with the pane (fallback: `resize_pty` IPC capture, or the active
session's `cols`/`rows` on `list_terminal_sessions`). Width is read via `offsetWidth`
(G-040); positions via `getBoundingClientRect`.

> **SUPERSEDED by #2942 — do NOT run the horizontal-rail rows as written.** Spec #2942
> replaces the 44 px horizontal rail (`terminal-session-bar`), the `[role="tablist"]` /
> `role="tab"` tab strip, and the `terminal-previous-toggle` + `terminal-previous-panel`
> History popover with a **vertical session sidebar**. Therefore:
> - tolerance **T5** (rail `h == 44`, full-width rail, tablist scroll) is **retired** — the
>   #2942 tolerances T7–T12 below replace it;
> - **F-42/F-43/F-44** (rail subordinate / tab legible / rail frames) are **superseded** by
>   **F-57/F-58/F-59** (vertical sidebar geometry + rows + selection);
> - **F-56** (`terminal-previous-toggle`/`-panel` reachable) is **superseded** by **F-60**
>   (previous sessions reachable from the sidebar, no popover);
> - **N-19** (tablist roving tabindex) is **superseded** by **N-26** (vertical list keyboard model).
> **PRESERVED and still asserted:** `terminal-pane` + `data-surface`/`data-cols`/`data-rows`,
> `terminal-previous-session-row-<id>` (+ `persistedAriaLabel`), the `SessionTerminal` Ghostty
> canvas + `terminal-canvas-host-<id>`, and tolerances **T1–T4** (re-measured by #2942 F-61).

### AC1 — the terminal fills its pane (no dead area)

- [ ] F-37 (**R-1.1, AC1 — default 900×600**): open the `terminal` window at the default size
      with ≥1 running session; run the geometry recipe.
      EXPECTED (numbers, not a screenshot): T1 holds (≤2 px/edge), T3 holds, T2 holds —
      `pane.bottom - canvas.bottom ≤ 8` and `pane.right - canvas.right ≤ 8` (no dead band
      ≥8 px below or beside); T4 holds (no scrollbar); `#root.offsetH == innerH ±2`.
      Edge: 0 sessions (empty state), 1 session, 2 sessions; re-measure with each state
      surface (empty/starting/error/resume) replacing the terminal.
- [ ] F-38 (**R-1.2, AC1 — minimum 560×360**): `tauri_manage_window resize terminal 560 360`;
      re-run the recipe.
      EXPECTED: T1–T4 hold at the minimum inner size; the pane is still full-height/full-width.
      Edge: min size with 2 sessions; min size with the tab rail scrolled.
- [ ] F-39 (**R-1.3, AC1 — resized 1400×900 + maximized**):
      `tauri_manage_window resize terminal 1400 900` then `action="maximize"`; re-run the
      recipe at each.
      EXPECTED: T1–T4 hold; the canvas grows with the pane; no dead band; the ACTIVE session
      receives a `resize_pty` (per-session; the inactive session's PTY dims do not change).
      Edge: resize during heavy output; resize while `starting`.
- [ ] F-40 (**R-1.4, AC1 — the grid follows the pane**): capture the active session's
      `cols`/`rows` and `pane[data-cols]`/`pane[data-rows]` before and after each resize; run
      the recipe after.
      EXPECTED: `pane[data-cols]`/`pane[data-rows]` change in the pane's direction (width↑ ⇒
      `data-cols`↑); the canvas pixel box (`pxW`/`pxH`) matches the pane; the non-active
      session's PTY dims are unchanged (no stale/zero push).
      Edge: resize with an inactive tab active (must not push); resize at the min bound.
- [ ] F-41 (**R-1.5, AC1 — pane invariant under every state surface**): for each AC3 state
      below, run the geometry recipe with that surface rendered.
      EXPECTED: `pane[data-surface]` == the forced state and the pane still fills the window
      (T1–T4 hold) — the surface is an absolute-inset child of the pane and never shrinks it.
      Edge: all-ended; resume-blocked.
- [ ] F-54 (**R-1.6, AC1 — continuous resize tracking; G-123; ST-2**): drive a resize SEQUENCE
      of ≥3 consecutive sizes (`tauri_manage_window resize terminal 900 600` → `1200 700` →
      `560 360` → `action="maximize"`), running the geometry recipe AND sampling
      `pane[data-cols]`/`pane[data-rows]` at EVERY step (not just a before/after pair).
      EXPECTED: the ACTIVE grid tracks the pane MONOTONICALLY in the pane's direction
      (`data-cols` ↑ as width ↑; `data-rows` ↑ as height ↑); the host stays flush at every
      sample (T1–T3); at most ONE fit per animation frame; and NO 0×0 latch — no fit/`resize_pty`
      ever pushed from a zero-size box (the `clientWidth/clientHeight <= 0` guard,
      `SessionTerminal.tsx:136-152`). A single before/after pair does NOT satisfy this row.
      Edge: sample mid-animation; a not-yet-laid-out mount; rapid churn through a size.
      Evidence: `SessionTerminal.resize.test.tsx` (unit, 0×0 pin) plus the live sequence numbers.

### AC2 — one coherent multi-session workspace (terminal dominant, nav subordinate)

- [ ] F-42 (**R-2.1, AC2 — rail subordinate + terminal dominant**): at 900×600, 560×360,
      1400×900, run the recipe + read every live tab.
      EXPECTED: T5 holds — the rail `[data-testid="terminal-session-bar"]` is `44 px ±1` tall
      and full-width (`offsetW == innerW ±2`), the pane dominates (`pane.offsetW >` the
      `[role="tablist"]` width and `pane.offsetH ≥ innerH − 46`); every visible tab's title +
      work-dir elements have a non-zero client box; the tab rail scrolls (`overflow-x:auto`)
      rather than clipping.
      Edge: 5 sessions; a long work-dir.
- [ ] F-43 (**R-2.2, AC2 — tab status/actions legible at min size**): at 560×360 with ≥2
      sessions, query the tabs.
      EXPECTED: each tab's status dot + work-dir basename render (non-zero boxes); the active
      tab carries `aria-current="true"` (and `aria-selected`); every interactive control
      (`+` add / tab / per-tab close / History toggle) has a box ≥24×24 px.
      Edge: long title; long work-dir (ellipsis, never 0 width).
- [ ] F-44 (**R-2.3, AC2 — coherent workspace, numbers + frames**): capture a described frame
      at each of the three sizes, on the SAME record as F-37/F-38/F-39.
      EXPECTED: each frame reads as one workspace — the terminal is the dominant surface and
      the session nav + per-session status are clearly subordinate and legible; the described
      read accompanies (never replaces) the F-37..F-39 numbers; re-check in light AND dark
      theme.
      Edge: maximized; a state surface visible at each size.

### AC3 — every session-state surface reachable + legible

> Forcing recipes are validated against the shipped mapping (`TerminalPane.tsx:190-279`,
> `ResumableSessions.tsx`, `TerminalWindow.tsx:118-128,405-462`). The state assertion is
> `pane[data-surface]` (UI/UX §4: `terminal | empty | all-ended | starting | error | ended |
> resume | resuming | resume-blocked`), corroborated by each state's preserved testid. Each
> state renders absolute-inset inside the pane → F-41 re-measures the pane with the state
> forced. Overlay surfaces get `overflowY="auto"` so a tall state scrolls at 360 px rather
> than clipping.

- [ ] F-45 (**R-3.1, AC3 — empty + all-ended**): (a) delete every persisted record
      (`delete_terminal_session_record` for each `list_persisted_terminal_sessions` id) and
      close every live session (`close_terminal_session`), then reload the window; (b) with
      ≥1 live session, self-exit all of them (`write_pty_input{sessionId,data:"exit\r"}`),
      zero persisted.
      EXPECTED: (a) `pane[data-surface]="empty"` and `terminal-empty-state` render inside the
      full pane (T1–T4 hold); (b) `pane[data-surface]="all-ended"` and
      `terminal-all-ended-state` render; the window stays open; both are legible.
      Edge: all-ended with a persisted record present → all-ended is suppressed and the
      per-session banner shows instead.
- [ ] F-46 (**R-3.2, AC3 — starting + slow-start hint**): force the slow start with the C-6
      recipe (no product seam): `save_setting('terminal_pwsh_path', <fixtures>/slow-pwsh.cmd)`
      then `spawn_terminal_session{cli:'copilot', testOverride:{binary:<fixtures>/fake-copilot.ps1}}`
      (window `terminal`). `prepare_session` holds inside the Copilot pwsh gate ~20 s (> the 10 s
      Doherty bound) while `status` is still `starting`. Restore the key afterwards.
      EXPECTED: `pane[data-surface]="starting"` and `terminal-starting-state` render inside the
      full pane on spawn; after ≥10 s the slow-start hint text renders ("Still starting… (check
      the CLI is installed)"); the session then errors `prereq`.
      Edge: `running`-before-first-byte overlay (non-blocking); hint only while `starting`.
      Fixtures are ST-5-owned (`slow-pwsh.cmd`, `fake-copilot.ps1`) and live under the fixtures
      root, so the AC4 teardown removes any record the recipe leaves.
- [ ] F-47 (**R-3.3, AC3 — running**): spawn and let the first PTY byte arrive.
      EXPECTED: the session reaches `status='running'` and its first byte clears the overlay;
      the terminal fills the pane (T1–T4).
      Edge: running before the first byte.
- [ ] F-48 (**R-3.4, AC3 — each typed error kind**): force each and read
      `terminal-error-state` + `data-error-kind`:
      (a) `invalid-cli` — `spawn_terminal_session{cli:'bogus'}`;
      (b) `invalid-cwd` — `spawn_terminal_session{cli:'opencode', workDir:'…\fixtures\no-such-dir'}`;
      (c) `missing-binary` — `spawn_terminal_session{cli:'copilot', testOverride:{binary:'…\fixtures\no-such-binary.cmd'}}` (or `terminal_copilot_path` = that path);
      (d) `prereq` — `spawn_terminal_session{cli:'copilot', testOverride:{pwshMajor:5}}` + a native control spawn;
      (e) `auth` — `terminal_copilot_path` = `fixtures/fake-copilot-auth.cmd` → spawn copilot.
      EXPECTED: each renders `data-error-kind` == the forced kind, inside the full pane;
      an untyped error → `generic`.
      Edge: override = a directory; a non-executable file; both missing-binary + invalid-cwd
      (record the cause priority). **NAMED BLOCKER:** the `prereq` control leg needs `pwsh`≥6.
- [ ] F-49 (**R-3.5, AC3 — ended (per-session)**): 2 live; self-exit one
      (`write_pty_input{id,data:"exit\r"}`).
      EXPECTED: `terminal-ended-banner` with Restart + Close for the ended session; the peer
      keeps streaming; the window stays open.
      Edge: exit while unselected; exit during a switch.
- [ ] F-50 (**R-3.6, AC3 — resume / resuming / resume-blocked**): (a) close the window with
      ≥1 persisted record and reopen; open the `terminal-previous-panel` (the History toggle)
      and select the record; (b) click Resume and sample; (c) force each blocked reason —
      `cli-missing` (Copilot record + `terminal_copilot_path` = `no-such-binary.cmd`),
      `invalid-cwd` (record in `workdir-a`, rename the dir away),
      `resume-failed` (**C-6 recipe**: persist a Copilot record via `terminal_copilot_path` =
      `fake-copilot-auth.cmd` spawn + close the window; then set `terminal_copilot_path` =
      `fake-copilot.ps1` and `terminal_pwsh_path` = `slow-pwsh.cmd`, Resume → the gate holds the
      IPC promise past the UI's 15 s watchdog → the blocked surface renders live).
      EXPECTED: `terminal-resume-state` auto-selects the newest record (zero clicks);
      `terminal-resuming-state` renders bounded with a Cancel at ≥10 s;
      `terminal-resume-blocked-state` renders with `data-reason` ∈
      {`cli-missing`, `invalid-cwd`, `resume-failed`} (the closed 3-member set) and a Retry;
      Cancel leaves the record resumable; Retry after the cause clears → resumed. All inside
      the full pane (T1–T4).
      Edge: sub-second `resuming` (observer recipe). `invalid-cli` is NOT a resume-blocked
      reason (Architect-ruled unreachable/vacuous, G-220/G-170) — asserted on the LAUNCH error
      surface in F-48. Restore the diagnostic keys after the `resume-failed` leg.
- [ ] F-55 (**R-3.7, AC3 — state surface scrolls, not clips, at 560×360**): at 560×360, render a
      state surface whose content is taller than the pane — a typed-error with a long raw
      message, and `terminal-resume-blocked-state` with its copy + 3 actions.
      EXPECTED: the surface scrolls INSIDE `terminal-pane` (`overflowY:auto`) and does not clip;
      its primary controls remain reachable with a hit box ≥24×24 px. Distinct from N-22 (which
      checks only the primary control's size).
      Edge: each state surface at the minimum size; a long error message.
- [ ] F-56 (**R-3.8, AC3 — Previous sessions surface reachable + rows preserved**): with ≥1
      persisted record, inspect the History surface.
      EXPECTED: `terminal-previous-toggle` (`[data-testid="terminal-previous-toggle"]`,
      `aria-haspopup="dialog"` / `aria-expanded` / `aria-controls="terminal-previous-panel"`) is
      reachable; `terminal-previous-panel` is in the DOM and queryable while COLLAPSED
      (`lazyMount={false}`/`unmountOnExit={false}`); every
      `terminal-previous-session-row-<id>` renders with `persistedAriaLabel`; selecting a row
      surfaces `terminal-resume-state` in the pane.
      Edge: 0 records (toggle absent); many records; panel collapsed vs open; long title/work-dir.

### AC4 — the suites leave the developer's "Previous sessions" list untouched

> **BINDING (Architect C-5):** the isolation fix is suite-side (no product change) — a
> mandatory one-shot IDEMPOTENT teardown recipe built ONLY on the shipped
> `list_persisted_terminal_sessions` + `delete_terminal_session_record`, plus a pre-run
> snapshot and a one-time purge of the #2935-era leaks. The recipe lives in all four
> `.opencode/tests/terminal/*.md` files AND the cross-linked
> `.opencode/tests/run-cli/regression.md`. ST-5 adds
> `fixtures/purge-fixture-records.js`; the QA Expert seeds these sections and the Tester
> persists them via `tests-commit`. **F-51/F-52 fail today** (no teardown exists) and pass
> once the teardown lands.

- [ ] F-51 (**R-4.1, AC4 — before/after negative; must FAIL today**):
      1. **BEFORE:** snapshot the "Previous sessions" set — main-window
         `__TAURI__.core.invoke('list_persisted_terminal_sessions')` (ids/cli/workDir/title)
         AND the `terminal`-window DOM rows
         `[data-testid^="terminal-previous-session-row-"]` (in `terminal-previous-panel`,
         mounted while collapsed — no panel interaction needed). ALSO capture the four settings
         keys (`terminal_work_dir`, `terminal_default_cli`, `terminal_copilot_path`,
         `terminal_pwsh_path`). Record the id set + count + the four values.
      2. **RUN** the terminal suites (F/R/S rows that spawn + persist sessions).
      3. **TEARDOWN:** run the C-5 teardown recipe (below), then restore the four settings keys
         to the captured values.
      4. **AFTER:** re-read the record set.
         EXPECTED: the SAME id set/count as the BEFORE snapshot — UNCHANGED — and ZERO record
         whose `workDir` is under `.opencode/tests/terminal/fixtures/` (no `gone--`/`workd--`
         #2935-era automation title).
      Edge: a dev with pre-existing real records; repeated suite runs; a run spawning many
      sessions; the 100-record cap must not mask a leak.
- [ ] F-52 (**R-4.2, AC4 — C-5 teardown receipt; idempotent**): run the C-5 teardown a SECOND
      time; then read the record store read-only: `list_persisted_terminal_sessions` (primary)
      and `SELECT id,cli,work_dir,title FROM feature_terminal_sessions` via the sanctioned
      `telemetry-query` skill (corroboration).
      EXPECTED: the first run removed every fixture-root record and restored the four settings
      keys; the second run is a NO-OP (idempotent, reports zero deletions); zero
      fixture/automation rows remain.
      Named store: `FeatureStore` table `feature_terminal_sessions` (feature id `terminal`,
      table `sessions`) in the dev `fredo.db` (`persistence.rs:1-27,120-137`).
      Edge: reused dev DB; the record cap eviction; a partial/crashed run.
- [ ] F-53 (**R-1.1, AC1 — static pin; supporting only; ST-6**):
      `pnpm --filter @fredo/ui test featureRoots.contentRegionSizing.test.ts` — the Known
      source pin at `apps/ui/src/features/__tests__/featureRoots.contentRegionSizing.test.ts`.
      EXPECTED (ST-6 required contents): (1) keep the `100vh`/`100vw` absence, BROADENED to
      every `.tsx` under `features/terminal/components/`; (2) replace `:75`'s exact-string
      `direction="row"` assertion with a direction-agnostic root assertion (a `Flex` root
      declaring `h="100%"`, no viewport unit); (3) ADD the host-document assertion reading
      `apps/tauri/index.html` and requiring the `html, body { height: 100% }` +
      `#root { height: 100% }` chain (so the pin now catches this defect class). This row is
      SUPPORTING evidence for R-1.1 (the C-1 host rule) and never clears AC1 alone.
      Edge: the rework renames/moves `TerminalWindow.tsx`'s root — the pin must be updated.

### C-5 teardown / snapshot / settings-restore (MANDATORY — run after every terminal suite run)

Teardown recipe — run in the `terminal` window via `tauri_webview_execute_js`; deletes every
record whose `workDir` is under the in-repo fixtures root and reports what remains:

```js
(async () => {
  const FIX = String.raw`.opencode\tests\terminal\fixtures`.toLowerCase();
  const recs = await window.__TAURI__.core.invoke('list_persisted_terminal_sessions');
  const doomed = recs.filter(r => String(r.workDir || '').toLowerCase().includes(FIX));
  for (const r of doomed) {
    await window.__TAURI__.core.invoke('delete_terminal_session_record', { sessionId: r.id });
  }
  const left = await window.__TAURI__.core.invoke('list_persisted_terminal_sessions');
  return { deleted: doomed.map(r => [r.id, r.title, r.workDir]), remaining: left.map(r => r.id) };
})()
```

- **Pre-run snapshot:** capture the record id set (via `list_persisted_terminal_sessions`) and
  the four settings keys (`terminal_work_dir`, `terminal_default_cli`, `terminal_copilot_path`,
  `terminal_pwsh_path` via `get_setting`) BEFORE any row runs; compare AFTER.
- **Settings restore (BINDING):** the teardown ALSO restores the four settings keys it (or the
  rows) overwrote to their captured pre-run values (`save_setting`) — a leftover
  `terminal_work_dir` pointing into the fixtures tree would make the developer's next session
  start in a fixture dir.
- **One-time purge:** ST-5's `fixtures/purge-fixture-records.js` purges the #2935-era leaked
  rows once during this spec's testing (the same fixture-root filter).
- **Cross-suite:** the same teardown + snapshot + settings-restore is repeated (or referenced)
  in `.opencode/tests/run-cli/regression.md`, which also spawns sessions.

### Non-functional (#2940)

- [ ] N-18 (**theme/token hygiene**): new composition chrome reads theme tokens; no hardcoded
      hex/rgba except the allowlisted `GHOSTTY_THEME` ANSI palette; no invalid
      `var(--token)NN` alpha-append (use `colorTint.ts` `tint()`).
- [ ] N-19 (**accessibility**): the tab-rail tabs (`role="tab"` inside the
      `[role="tablist"][aria-label="Terminal sessions"]`, roving tabindex `←`/`→`/`Home`/`End`),
      each per-tab close button, the `+` add button, the History toggle
      (`aria-haspopup="dialog"` / `aria-expanded` / `aria-controls="terminal-previous-panel"`)
      and the panel's previous rows (`role="listitem"`, `persistedAriaLabel`) are
      keyboard-reachable + ARIA-labelled; the active tab carries `aria-current="true"`; the
      History popover is NON-modal (no focus trap); interactive targets ≥24×24 px (also
      asserted numerically by F-43).
- [ ] N-20 (**console hygiene, both windows**): no `Error:` / `Uncaught` /
      `Maximum update depth exceeded` in the main OR `terminal` window across the rework.
- [ ] N-21 (**zero orphans**): after the window closes, `process-hygiene.ps1 -List` reports 0
      Fredo-spawned `opencode`/`copilot`/`node` processes.
- [ ] N-22 (**min-size legibility**): at 560×360 each state's primary control is inside the
      pane and ≥24 px.
- [ ] N-23 (**no re-spawn**): a session switch preserves `id`/`pid`/`startedAt` (F-10
      contract) — the rework must not turn a switch into a re-spawn.
- [ ] N-24 (**static pin coverage**): the source pin covers the reworked root and its files
      (see F-53).

## #2942 — vertical sidebar, rename, plain-shell default, Settings, persistence (AC1–AC5)

> Seeded at triage for Spec #2942. The 44 px horizontal rail is replaced by a **compact
> vertical session sidebar** (AC1); a session's **name is editable** (AC2); a newly added
> session defaults to a **plain shell** with no agent (AC3); **Settings → Terminal** chooses
> the default session type + working directory (AC4); records for all three types persist
> with their type + renamed name (AC5). The ticket's **named risk** — the OpenCode TUI not
> filling the pane until a forced `resize_pty` — is F-76.
>
> **Evidence policy: LIVE + MEASURED.** AC1 is cleared only by the geometry NUMBERS from the
> SERVED host document (recipe below) at DEFAULT / MIN 560×360 / RESIZED (G-251) — a screenshot
> never clears it. Cold rows require the window CLOSED (G-250). Rename/type upgrades prove
> record KEY IDENTITY (G-242). Every OpenCode leg needs a live `telemetry_spans` receipt.
>
> **Supersede/PRESERVE (see the note on the #2940 AC1/AC2 sections):** T5 + F-42/F-43/F-44/F-56/
> N-19 are retired; T1–T4, `terminal-pane`/`data-surface`, `terminal-previous-session-row-<id>`,
> and `terminal-canvas-host-<id>` are preserved.
>
> **Bind to the convergence-reconciled hooks (binding — no fallbacks).** Sidebar root
> `terminal-session-sidebar`; live row `terminal-session-row-<id>`; rename affordance
> `terminal-session-rename-<id>` + inline input `terminal-session-rename-input-<id>`; plain-shell
> type value `shell` (display label "Terminal"). A missing hook is a **TOOLING GAP** — record it, do not improvise.

### Requirement-ID reconciliation (Architect `### Requirements` EARS, authoritative)

> The #2942 rows below were drafted in parallel with the Architect's EARS; map them to the
> authoritative IDs before reporting. **Row → EARS:** F-57 → **R-1.1**; F-58 → **R-1.5**;
> F-59 → **R-1.2 + R-1.3**; F-60 → **R-1.4**; F-61 → **R-1.1 + R-1.7**; F-62 → **R-2.2 +
> R-2.5**; F-63 → **R-2.4**; F-64 → **R-2.4** (record key identity); F-65 → **R-2.3**;
> F-66 → **R-3.1 + R-3.4**; F-67 → **R-3.2**; F-68 → **R-3.3**; F-69 → **R-4.1**;
> F-70 → **R-4.2**; F-71 → **R-4.1 + R-4.3 + R-3.4**; F-72 → **R-4.3**; F-73 → **R-5.1**;
> F-74 → **R-5.2**; F-75 → **R-5.3**; F-76 → **R-1.6** (the named fit risk); F-77 → **R-4.4**
> (+ G-250); F-78 → **R-3.1** (cold); **F-79 → R-2.1** (added below).
>
> **Published hooks — RECONCILED at convergence (binding; no fallbacks).** The orchestrator
> adjudicated the inter-section conflicts (G-023): sidebar root `terminal-session-sidebar`;
> rename trigger `terminal-session-rename-<id>` + input `terminal-session-rename-input-<id>`;
> plain-shell wire value `shell` (frontend `TerminalSessionKind`; display label "Terminal");
> rename command `rename_terminal_session_record {sessionId, name}`; `TerminalSessionInfo` keeps
> NO `title` (the name resolves via the persisted record map). Read the served DOM / invoke the
> shipped command and record the ACTUAL name in the evidence.
>
> **Published gate values (G-235, controls in parentheses):** row height ≤ **32 px** (control:
> 36 px tab `SessionBar.tsx:67` / ~46 px previous row); sidebar width **200 px fixed** (control:
> retired 240 px); pane width ≥ **0.60 × innerW** (control: == innerW); pane height ==
> **innerH ±2** (control: innerH − 44); resized samples **700×500 / 1200×800** (fallback
> 1400×900). A rename/kind-widening rewrites NO record and adds NO settings key (Architect
> NFR: reuse `terminal_default_cli`, widened domain; absent/unknown → `shell`).

- [ ] F-79 (**AC2, R-2.1 — the rename affordance is an inline editable field and the ONLY
      editable field**): activate the per-row rename affordance (kebab / F2) on a LIVE row, and
      separately on a PREVIOUS row.
      EXPECTED: an inline editable field renders for that session's name, focused + labelled
      (`aria-label="Session name"` per UI/UX); Enter commits, Esc cancels with NO write; NO other
      session field is editable anywhere (a work-dir/type edit affordance is a FAIL).
      Edge: F2 on a focused row; Enter on a previous row; blur-commit vs Enter-commit.

### #2942 geometry recipe (served host document — G-251)

```js
(() => {
  const px = (n) => Math.round(n * 100) / 100;
  const r = (el) => { const b = el.getBoundingClientRect();
    return { x: px(b.x), y: px(b.y), w: px(b.width), h: px(b.height),
             right: px(b.right), bottom: px(b.bottom) }; };
  const root = document.getElementById('root');
  const sidebar = document.querySelector('[data-testid="terminal-session-sidebar"]');
  const pane = document.querySelector('[data-testid="terminal-pane"]');
  const rows = Array.from(document.querySelectorAll('[data-testid^="terminal-session-row-"]'));
  const surface = document.querySelector('[data-testid^="terminal-surface-"][data-active="true"]');
  const host = document.querySelector('[data-testid^="terminal-canvas-host-"]');
  const cs = sidebar && getComputedStyle(sidebar);
  return {
    innerW: window.innerWidth, innerH: window.innerHeight,
    docScrollW: document.documentElement.scrollWidth, docScrollH: document.documentElement.scrollHeight,
    root: root && { ...r(root), offsetW: root.offsetWidth, offsetH: root.offsetHeight },
    sidebar: sidebar && { ...r(sidebar), offsetW: sidebar.offsetWidth, offsetH: sidebar.offsetHeight,
      clientH: sidebar.clientHeight, scrollH: sidebar.scrollHeight, clientW: sidebar.clientWidth,
      scrollW: sidebar.scrollWidth, overflowY: cs.overflowY, flexDirection: cs.flexDirection },
    rows: rows.map((el) => ({ testid: el.dataset.testid, ...r(el) })),
    pane: pane && { ...r(pane), offsetW: pane.offsetWidth, offsetH: pane.offsetHeight,
      dataSurface: pane.dataset.surface, dataCols: pane.dataset.cols, dataRows: pane.dataset.rows },
    surface: surface && r(surface),
    host: host && r(host),
    paneWidthShare: pane ? px(pane.offsetWidth / window.innerWidth) : null,
  };
})()
```

**#2942 tolerances (PASS gates):** **T7** `sidebar.offsetH ≥ innerH − 2` && `offsetH > offsetW`;
**T8** every live row `h ≤ 32 ±1` && `row.w ≈ sidebar.offsetW ±2`; **T9**
`pane.offsetW ≈ innerW − sidebar.offsetW ±2` && `paneWidthShare ≥` the ABSOLUTE floor (fallback
0.60) && `pane.offsetH ≈ innerH ±2`; **T10** `docScrollW ≤ innerW + 1` && `#root.offsetW/offsetH
≈ innerW/innerH ±2`; **T11** at 560×360 with 10+ sessions `sidebar.scrollH > sidebar.clientH` &&
`overflowY ∈ {auto, scroll}`; **T12** `pane.right ≈ innerW ±2`, `pane.bottom ≈ innerH ±2`,
`surface` rect == pane rect ±2, `host` rect == pane rect ±2, `pane.bottom − canvas.bottom ≤ 8` (the
disclosed ghostty scrollbar-width reservation is a host-flush gutter — record the number).

> **G-235 governing tier:** T9's pane-width share and the sidebar-width / row-height gates are NEW
> **absolute floors** — the pre-change 44 px-rail control (pane share ~87.8% at 560) cannot satisfy
> a no-worse-than-control width gate for a vertical sidebar, so the floor governs. T12's pane
> invariants (height, dead band, host flush, docScroll) use the **no-worse-than-control** tier
> against the #2940 build. Measure BOTH builds per preset BEFORE adjudicating anything.

### AC1 — compact vertical sidebar

- [ ] F-57 (**AC1, R-1.1 — served-doc geometry: DEFAULT 900×600 / MIN 560×360 / RESIZED 1400×900**):
      open the `terminal` window with ≥1 live session; run the #2942 recipe at each size
      (`tauri_manage_window resize terminal 560 360`, then `1400 900`).
      EXPECTED (numbers): T7 + T8 + T9 + T10 hold at every size — the sidebar is a full-height
      COLUMN (`offsetH ≈ innerH`, `offsetH > offsetW`, width ≤ the published max / fallback 240),
      each live row is ONE tight full-width row (h ≤ 40 ±1), the pane is flush to its window edge
      and keeps dominance (`paneWidthShare ≥` floor), `#root`/`docScrollW` show no window-level
      scrollbar. Maximize is a NAMED limitation (MCP-bridge < 0.13) — never passed unmeasured.
      Edge: 1 / 2 sessions; long title + long work-dir; light + dark; sidebar on the left vs right.
- [ ] F-58 (**AC1, R-1.2 — sidebar scrolls, pane dominant, no clipped terminal at MIN**):
      at 560×360 create 10+ Terminal-type (plain-shell) sessions rooted in the fixture dirs; run the
      recipe.
      EXPECTED: T11 holds (`sidebar.scrollH > clientH`, `overflowY` auto/scroll); T10 holds
      (`documentElement.scrollWidth ≤ innerW + 1` — no whole-window horizontal scroll); T9 holds
      (`paneWidthShare ≥` the ABSOLUTE floor — the governing tier); T12 holds (pane flush, surface
      rect == pane rect, host == pane rect) → the terminal is NOT clipped. Record the measured
      sidebar width, row height, pane share, and scrollHeight at 560×360.
      Edge: exactly 560 wide; mixed types; resize while scrolled to the sidebar's extreme.
      Fixtures are in-repo only; the 10+ sessions are rooted in `fixtures/workdir-*` so C-5 removes
      their records.
- [ ] F-59 (**AC1, R-1.3 — select a row shows its live terminal; close a row ends that session**):
      with A and B live from the sidebar, select each row; then close A from its row.
      EXPECTED: the selected row carries `aria-current="true"` and the pane paints A's live canvas
      (`terminal-surface-<id>[data-active="true"]`; `get_pty_buffer{A}` matches); `close_terminal_session{A}`
      leaves exactly ONE `terminal` window, B still `running` + streaming, the sidebar shows only B,
      and A's process tree is gone (`process-hygiene.ps1 -List`).
      Edge: close the non-active row; two back-to-back closes; close while the peer is `starting`;
      close the last row → the window stays open (`all-ended`).
- [ ] F-60 (**AC1, R-1.4 — previous/persisted sessions reachable from the SIDEBAR; resume zero-click**):
      persist records (spawn → close the window), reopen; inspect the sidebar.
      EXPECTED: every `terminal-previous-session-row-<id>` renders INSIDE the sidebar (the
      sidebar-scoped query finds them) with `persistedAriaLabel`; NO `terminal-previous-toggle` and
      NO `terminal-previous-panel` exists anywhere; selecting a record surfaces `terminal-resume-state`
      in the pane; the newest record is auto-selected (zero clicks).
      Edge: 0 records (empty state); many records; long title/work-dir; a record whose dir was removed
      (typed blocked state, record retained).
- [ ] F-61 (**AC1, R-1.5 — pane invariants T1–T4 preserved under the new sidebar**): run the #2940
      recipe cells (pane box, active surface, canvas host, `#root`, docScroll) at all three sizes.
      EXPECTED: `pane.right ≈ innerW ±2`, `pane.bottom ≈ innerH ±2`, active `surface` rect == pane
      rect ±2, `canvasHost` rect == pane rect ±2, `pane.bottom − canvas.bottom ≤ 8` (record the
      ghostty gutter number), `docScrollH ≤ innerH + 1`.
      Edge: resize while a state surface shows; min size; dark + light.

### AC2 — rename

- [ ] F-62 (**AC2, R-2.1 — rename live row + previous row + survives close/reopen + FULL restart**):
      rename a live session to `TERMINAL_RENAME_2942_<guid8>`; close the window; reopen;
      `dev-env.ps1 -Action Restart`; reopen.
      EXPECTED: the new name renders on the LIVE row AND (after close/reopen) on its
      PREVIOUS-session row; the row's visible title + its `aria-label` carry the new name;
      `list_persisted_terminal_sessions` returns the SAME record `id` with the new `title` across
      reopen AND full restart; the old name appears nowhere in the sidebar.
      Edge: rename twice; rename to the same value; rename a session that self-exited; rename while
      another streams.
- [ ] F-63 (**AC2, R-2.2 — rename does not end the session or lose scrollback**): write
      `SENTINEL_RENAME_<guid8>` into a running session, read the buffer, rename, re-read.
      EXPECTED: `list_terminal_sessions{id}` stays `running`; `id`/`pid`/`startedAt` byte-identical;
      the PTY buffer still contains `SENTINEL_RENAME_<guid8>`; the process tree is alive.
      Edge: rename during heavy output; rename while `starting`; rename a resumed session.
- [ ] F-64 (**AC2, R-2.3 — G-242 record KEY IDENTITY on rename**): snapshot
      `{id,title,cli,workDir,createdAt}`; rename; re-read via `list_persisted_terminal_sessions` AND
      a read-only `SELECT id,cli,work_dir,title,created_at FROM feature_terminal_sessions`
      (telemetry-query skill).
      EXPECTED: exactly ONE row keeps the SAME `id`; `cli`/`work_dir`/`created_at` unchanged; only
      `title` differs; the record COUNT is unchanged (no new row, no orphan); the sidebar shows one
      row, never two.
      Edge: a PRE-CHANGE record upgraded by rename → same id, still listed; rename → restart →
      rename again; two records renamed back-to-back; rename to blank.
- [ ] F-65 (**AC2, R-2.4 — blank/whitespace rename never yields an empty row**): submit `""`,
      `"   "`, and a tab-only name.
      EXPECTED: the rename is refused (validation / input reverts) OR falls back to the prior name;
      the row NEVER renders blank; `feature_terminal_sessions.title` is never empty/whitespace; the
      record id is unchanged.
      Edge: very long name (truncation, not overflow); unicode/emoji; a name equal to another
      session's title.

### AC3 — plain-shell default

- [ ] F-66 (**AC3, R-3.1 — no stored default → Terminal preselected**): clear the default key + the
      terminal window's `localStorage`; cold restart; open add-session.
      EXPECTED: the plain-shell **Terminal** type is DOM-observable preselected (`aria-checked="true"`
      on the hidden radio / `data-state=checked`, per the published hook); OpenCode + GitHub Copilot
      are still selectable.
      Edge: corrupt stored value → safe fallback; legacy `terminal_default_cli='copilot'` still
      resolves to Copilot (F-71).
- [ ] F-67 (**AC3 + R-3.4 — a new session starts a PLAIN SHELL (no agent) in its directory**): set
      `terminal_work_dir` = `…\fixtures\workdir-a`; restart; accept the plain-shell default; drive
      `SENTINEL_SHELL_<guid8>` + `Get-Location\r` (PowerShell) via `write_pty_input`; read the buffer
      + process inventory + the record.
      EXPECTED: the record's type is the published plain-shell value; the buffer shows the OS default
      shell prompt and NONE of the OpenCode/Copilot banners; `process-hygiene.ps1 -List` shows a
      `pwsh`/`powershell` (or `$SHELL`) under the Fredo PID and NO `opencode`/`copilot`/`node` agent
      process; the `Get-Location` output contains `workdir-a`.
      Edge: a directory with spaces/unicode; blank dir → home fallback; shell self-exit → record
      retained.
- [ ] F-68 (**AC3, R-3.3 — OpenCode + GitHub Copilot still selectable and still launch (control)**):
      add one OpenCode and one GitHub Copilot session explicitly.
      EXPECTED: each launches its real CLI (`process-hygiene.ps1 -List` shows the CLI tree; the buffer
      shows its TUI); the plain-shell default does not pre-empt an explicit choice; the OpenCode leg
      emits `fredo.*` spans in `telemetry_spans` (live query).
      Edge: Copilot `prereq` (named blocker if `pwsh` < 6 on the host); choose a non-default type
      after the default was set.

### AC4 — Settings → Terminal

- [ ] F-69 (**AC4, R-4.1 — the panel exposes default session TYPE + default working directory**):
      open Settings → Terminal.
      EXPECTED: a type control renders the THREE choices (Terminal / OpenCode / GitHub Copilot) with
      the stored one preselected and DOM-observable; the working-directory input renders and is
      prefilled from `terminal_work_dir`; Save persists both; the other settings sections are
      untouched.
      Edge: first run (no default) → Terminal; invalid stored value → safe fallback.
- [ ] F-70 (**AC4, R-4.2 — save + restart preselects/prefills for EACH of the 3 types**): for each
      type: set it + a fixture dir, Save, `dev-env.ps1 -Action Restart`, add a session (no override).
      EXPECTED: the add-session chooser shows the chosen type selected (DOM-observable) and the
      directory field prefilled with the chosen directory (0 keystrokes); the spawned session matches
      type + dir.
      Edge: type = Terminal + dir set; two restarts; change type and dir together.
- [ ] F-71 (**AC4, R-4.3 — G-242: existing work-dir key governs; the legacy DEFAULT value migrates
      without orphan**): (a) pre-seed `terminal_default_cli='copilot'` + `terminal_work_dir`; restart;
      (b) run the legacy `run_cli_work_dir` migration leg (F-4/F-5 pattern).
      EXPECTED: (a) the stored/effective default resolves to GitHub Copilot (migrated or preserved) —
      the old key is read at most once and is never the live path; no pre-existing record changes;
      (b) `terminal_work_dir` still governs a new session; the legacy `run_cli_work_dir` still
      migrates.
      Edge: both legacy + new keys set (new wins); blank legacy value; a corrupt default value.
- [ ] F-72 (**AC4, R-4.4 — changing a default mutates nothing**): snapshot all live sessions +
      records; change default type + dir; Save; restart; re-read.
      EXPECTED: every pre-existing live session's `id`/`cli`/`workDir`/`status` and every record's
      `{id,title,cli,workDir,createdAt,cliSessionId}` are byte-identical; no re-spawn; no record
      added/removed/renamed.
      Edge: change defaults while a session is running; change to the same value.

### AC5 — persistence

- [ ] F-73 (**AC5, R-5.1 — all three types persist incl. type + renamed name across a full restart**):
      create a Terminal-type (plain shell), an OpenCode, and a GitHub Copilot record; rename the
      shell; close the window; `dev-env.ps1 -Action Restart`; reopen.
      EXPECTED: all three records list with their type + workDir; the shell's renamed title persists;
      ids/fields stable; the reopen starts ZERO processes until an explicit resume; the
      `feature_terminal_sessions` rows carry the plain-shell type value (read-only query).
      Edge: zero records → empty state; two restarts; reopen before the list resolves (loading, not a
      false empty); mixed with pre-change records.
- [ ] F-74 (**AC5, R-5.2 — a persisted TERMINAL-type record reopens a shell with NO false resume
      promise**): close a plain-shell record's window; reopen; resume/open it.
      EXPECTED: a shell (no agent process) starts in the record's directory; the buffer shows a fresh
      shell prompt; the visible resume/open copy contains NO claim that a conversation was restored,
      and no CLI `--continue`/`--resume` switch is used (process CommandLine); no agent banner.
      Edge: record dir removed → typed blocked state (record retained); resume twice; shell record
      rooted in home.
- [ ] F-75 (**AC5, R-5.3 — pre-change records remain listed + usable**): with the PRE-CHANGE build
      create `opencode`/`copilot` records; switch to the changed build; reopen.
      EXPECTED: the pre-existing rows still parse + list (no dropped row from the type/value-set
      extension); a read-only `SELECT … FROM feature_terminal_sessions` shows them intact; each
      remains resumable/usable per its type; no duplicate/orphan row created by the upgrade.
      Edge: a record with `cli_session_id` set; a record whose dir is gone; the 100-record retention
      boundary.

### RISK — the OpenCode TUI must fill the pane (the ticket's named residual fit/grid issue)

- [ ] F-76 (**RISK R-6.1 — reproduce or verify; ties to the `resize_pty` path**): spawn an OpenCode
      session in `workdir-a`; WITHOUT any manual `resize_pty`, read
      `list_terminal_sessions{cols,rows}`, `pane[data-cols/data-rows]`, `get_pty_buffer`, and the
      served-document host rect; then `tauri_manage_window resize terminal 1400 900` and re-read.
      EXPECTED: after mount the OpenCode TUI renders MORE than its status bar + input (the
      conversation/body region is present) WITHOUT a forced `resize_pty`; the grid is sized to the
      pane (`data-cols/rows` ≥ the published floor, fallback `rows ≥ 20` at 900×600) and tracks the
      resize monotonically; the host is flush (T12). A session that renders only the status bar +
      input until a manual `resize_pty` is a **FAIL** (this is the ticket's named risk).
      Edge: mount at 560×360; resize immediately after spawn (before the first byte); resize during
      heavy output; a RESUMED OpenCode session.
      Evidence: the `data-cols/rows` + buffer line count numbers at each step, plus the OpenCode leg's
      `telemetry_spans` receipt.

### COLD-START rows (G-250 — the window must be CLOSED for each run)

- [ ] F-77 (**G-250 — COLD `fredo open-terminal`**): close the `terminal` window (assert 0 `terminal`
      windows), then `fredo open-terminal --cli opencode --dir …\fixtures\workdir-a`; repeat for the
      plain-shell default with no `--cli`.
      EXPECTED: exit 0, ONE `terminal` window, a RUNNING session with the requested cli+workDir
      auto-selected — COLD, every run. With the window already open the same command spawns warm
      (record both legs, e.g. cold 3/3 + warm 3/3). A cold run that opens the window but spawns
      NOTHING is a FAIL (the #2940 round-1 R-18 defect).
      Edge: window closed with a state surface showing; rapid cold invocations; every shipped preset.
- [ ] F-78 (**G-250 — plain-shell default on a COLD app start**): `dev-env.ps1 -Action Restart`; open
      Terminal; add a session with no override.
      EXPECTED: a plain shell spawns (F-67) — the default does not depend on warm state; the shell
      record persists.
      Edge: first-ever run (no keys); after a fresh DB.

### Non-functional (#2942)

- [ ] N-25: **Theme/token hygiene.** The new sidebar/row/rename/settings chrome reads theme tokens;
      no hardcoded hex/rgba except the allowlisted `GHOSTTY_THEME` ANSI palette; NO invalid
      `var(--token)NN` alpha-append (use `tint()`); no `100vh`/`100vw` in the terminal tree.
- [ ] N-26: **Accessibility (supersedes N-19).** The sidebar rows are keyboard-reachable with the
      UI/UX-published collection role/keyboard model (Arrow Up/Down for a vertical list), each
      ARIA-labelled (`sessionAriaLabel`/`persistedAriaLabel`), the active row `aria-current="true"`;
      the rename affordance + type chooser are keyboard-operable; interactive targets ≥24×24 px; NO
      focus trap (the sidebar is in-flow, not a dialog).
- [ ] N-27: **Console hygiene (both windows).** No `Error:`/`Uncaught`/`Maximum update depth exceeded`
      in the main OR `terminal` window across rename / 10+ sessions / restart.
- [ ] N-28: **Zero orphans.** Close a session then the window (incl. a plain shell) →
      `process-hygiene.ps1 -List` = 0 Fredo-spawned `opencode`/`copilot`/`node`/`pwsh` processes.
- [ ] N-29: **No re-spawn on switch.** A switch preserves `id`/`pid`/`startedAt` (the F-10 contract);
      the rework must not turn a switch into a re-spawn or a row click into a remount.

### Teardown delta for #2942 (extends the C-5 recipe — MANDATORY)

> Before the run, snapshot `{id → title}` for EVERY persisted record (not only fixture-root) plus the
> settings keys — which now include the **default-TYPE key** (published; fallback
> `terminal_default_cli`) alongside `terminal_work_dir`, `terminal_copilot_path`, `terminal_pwsh_path`.
> After the run: assert every pre-existing title is unchanged (G-242), run the C-5 fixture-root delete
> (recipe below), and restore the keys. All 10+ shell/CLI sessions for the geometry legs must be
> rooted in `.opencode\tests\terminal\fixtures\*` so C-5 removes their records.

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

### Round 3 — 2026-09-24, spec/2934 @ 7ba5a99c (verdict PASS — both round-2 FAILs fixed)

Cold restart (`dev-env.ps1 -Action Up -Spec 2934`); driver session stop+start + namespace re-probe.

**F-17 (R-4.4, FX-3 + FX-4) — PASS (was round-2 FAIL).** Session
`390e2daa-2f9e-4277-b666-70769a7f89be`: `errorKind='auth'` immediately on
`list_terminal_sessions`, status `exited` at **544 ms** (≤10 s), `get_pty_buffer` = **139 B
retained** (`GitHub Copilot CLI` / `You are not logged in. Please sign in.`), **exactly one**
`terminal-exited` emit (listener log), no hang, window open, no orphan; override cleared.
Second confirmation (F-21 leg) with two OpenCode sessions live: fixture `e60af9da-…` exited
in ~800 ms with the peers still `running`. FX-4's Phase-0 `child exited` DEBUG line is not
observable because the app's `EnvFilter` defaults to INFO (`lib.rs:136-137`) — the watcher's
effect (exited + one emit + retained buffer) is the direct receipt.

**F-11 (R-2.4, FX-5) — PASS (was round-2 FAIL).** With A=`4fb23974` (71×4) and B=`19a2ad5a`
(80×24) and B active, `tauri_manage_window resize terminal 1150×780` → **B 99×8, A 71×4
unchanged**; a second resize (1000×700) moved only B (→82 cols). Both buffers render
(A 3567 B, B 13724 B; both TUIs + their own workdirs). The live **minimise** leg is blocked
(bridge plugin < 0.13); the 0×0 branch is covered by `SessionTerminal.resize.test.tsx` (3/3
PASS) + the `clientWidth/clientHeight <= 0` guard.

**Regression sweep PASS:** F-13 native Copilot (`running` ~1 s, `Copilot v1.0.88` TUI),
F-16 forced `pwshMajor:5` → `error`/`prereq` in 1.93 s with `pid:null` + the UI error surface
and the non-vacuous native control, AC1 rename receipt (exactly 1 hit `settings.ts:18`;
zero-match corroborating receipts; capabilities `["main","terminal"]`), F-2/F-3, F-6/F-8/F-9/F-10,
F-12 (`terminal_default_cli='copilot'` still preselected), F-19/F-20/F-21 (0 orphans; main-only
after window close), N-1..N-8.

**Observation (pre-existing, NOT asserted by R-2.4, NOT a round-3 regression):** the terminal
pane renders ~126 px tall in a 780 px window — the window root `h="100%"` resolves against a
content-sized `#root` (height driven by the sidebar). The same behaviour is in the round-2 frame
`r2-ac2-switch-opencode.jpeg`. Flagged for awareness only.

Round-3 evidence frame names: `r3-f17-auth-exited`, `r3-f11-after-resize`,
`r3-f11-session-a-renders`, `r3-f13-copilot-native`, `r3-f16-prereq-error`,
`r3-ac1-launcher-grid`, `r3-terminal-open`.

### Round 4 (Spec #2935) — 2026-09-24, spec/2935 @ 9ad0b360 (verdict PASS; live)

Live policy honoured: window list / DOM / PTY-buffer bytes / process inventory / `fredo` binary
stdout+exit code / `telemetry_spans`.

**AC1 — PASS.** F-22 (F-22 window-close→reopen lists A with the SAME id/cli/workDir/title/
`cliSessionId`, `lastActiveAt` bumped; "Previous sessions" group + auto-selected `terminal-resume-state`;
no dialog), F-23 (full app restart → the SAME 4 records, ids/cli/workDir/title/`cliSessionId` intact;
reopen spawns 0 processes), **F-24 (load-bearing)**: A=`f86be818-…` OpenCode in `workdir-a`; typed
`TERMINAL_RESUME_2935_SENTINEL` + `\r` (real turn — `telemetry_spans` shows the prompt on
`ses_f2ae1f08bffeKvHxKiOCxMnM4X`); close → reopen → Resume; post-resume PTY buffer contains the
sentinel AND the assistant replies ("I'm here and ready — no task was included with that sentinel");
resumed CommandLine `opencode.exe … --session ses_f2ae1f08bffeKvHxKiOCxMnM4X` (pid 10164, and again
on the 2nd cycle pid 17692); record id unchanged. F-25 control: a fresh same-cli/same-workDir session
(`594c4fab-…`) buffer has **0** sentinel occurrences and the "Ask anything…" empty-state — non-vacuous.
F-26 record fields exactly `{id,cli,workDir,title,createdAt,lastActiveAt,cliSessionId}`; stable titles
`OpenCode`/`OpenCode 2`/… never renumbered. F-35 gating: previous-records reopen auto-selects the
most-recent record + shows `terminal-resume-state`, NO `terminal-all-ended-state`, NO auto dialog;
zero-records control → `terminal-empty-state` + auto prompt.

**AC2 — PASS.** F-27: after close, `process-hygiene.ps1 -List` shows the terminal session tree gone
(pids 13728→948 and 10164→10644 absent; 0 unprotected orphans); F-28: reopen lists the records
(`state` resumable) and starts 0 processes; F-29: `close_terminal_session{594c4fab}` reaped only that
tree — the peer stayed `running`, the window stayed open, and the closed record appeared in
"Previous sessions" (no ghost/duplicate).

**AC4 — PASS (partial).** F-30/IPC `spawn_terminal_session{cli:'bogus'}` → `errorKind='invalid-cli'`
+ `pid:null`; F-31/IPC `{workDir:no-such-dir}` → `errorKind='invalid-cwd'` + `pid:null`; F-32: record
in `gone-dir`, dir deleted → still LISTED, Resume → `terminal-resume-blocked-state`
`data-reason='invalid-cwd'` ("Working directory not found … doesn't exist…"), no partial session,
record retained; dir restored → resume succeeds (control). F-31 (removable): `terminal-delete-session-dialog`
copy "The CLI's own conversation transcript is not deleted — Fredo only removes its record";
confirm → record gone from SQLite (`feature_terminal_sessions`). Start fresh → unchanged dialog
prefilled with the record's cli+workDir; confirm → new session + the source record removed.
**UNVERIFIED:** `cli-missing` (F-30 missing-binary lever) and `resume-failed`/Cancel (F-36) were not
driven (needs a persisted GitHub Copilot record / a slow-then-failing resume — time-boxed);
`transcript-missing` stays a named blocker (out-of-repo store, G-009).

**AC5 — PASS.** F-1..F-5, F-6..F-12 regression sweep still green (launcher re-invoke keeps exactly one
`terminal` window; multi-session concurrency + switch visibility; per-session sentinel isolation
(resumed buffer 1 sentinel / control buffer 0); no re-spawn; telemetry path untouched).

**Observation (pane height):** the terminal pane renders ~126 px tall in the 900×600 window while
`#root` is content-sized; at that size the OpenCode TUI renders only its status bar + input. After
the app restart the pane rendered full-height in the same window. Forcing `resize_pty{rows:30}` was
required in the first cycle to make the resumed conversation render in the buffer. Pre-existing
(reported round 3 of #2934), NOT asserted by #2935 — flagged for awareness.

Evidence frame names: `r1-launcher-grid`, `r1-opencode-a-starting`, `r1-opencode-a-turn`,
`r1-ac1-reopen-list`, `r1-ac1-resumed`, `r1-ac3-cli-opened`, `r1-ac4-invalid-cwd`.

### Round 5 (Spec #2940) — 2026-09-24, spec/2940 @ 6a8b2c6d (verdict FAIL — R-18/S-16 cold leg)

Served commit `spec/2940 @ 6a8b2c6d` (`dev-env.ps1 -Action Up -Spec 2940`, status line
`running (repo root on spec/2940 @ 6a8b2c6d)`). Live policy honoured: window list /
measured geometry (offsetWidth + getBoundingClientRect) / DOM / PTY-buffer bytes /
`list_terminal_sessions` / `process-hygiene.ps1 -List` / `fredo` stdout / read-only
`feature_terminal_sessions` + `telemetry_spans` queries.

**AC1 — PASS (measured).**
- **F-37 default 900×600** (dark, 2 running sessions): `pane` `{w:900,h:556,right:900,bottom:600,offsetW:900,offsetH:556}`,
  `#root.offsetH=600`, `docScrollH=600`; active surface rect == pane rect; `canvasHost` rect == pane rect
  (`hostEqualsPane:true`); `canvas {w:882,h:555,right:882,bottom:899,pxW:882,pxH:555}`. **T1 ✓ T3 ✓ T4 ✓**;
  **T2** `pane.bottom − canvas.bottom = 1` ✓ but `pane.right − canvas.right = 18` — disclosed: the 18–23 px
  remainder is ghostty-web's documented **scrollbar-width reservation** (`FitAddon.proposeDimensions()`
  "Scrollbar width reservation"; the canvas computed style is an explicit `882px`/`555px`), the HOST fills the
  pane exactly (0 px), and the same `GHOSTTY_THEME.background` paints the gutter — so the pane has NO dead band.
  See Round notes caveats.
- **F-38 minimum 560×360**: `pane {w:560,h:316,right:560,bottom:360,offsetW:560,offsetH:316}`,
  `bar {h:44,offsetW:560}`, `#root.offsetH=360`, `docScrollH=360`, `canvas {w:540,h:315,pxW:540,pxH:315}`,
  `canvasHost` == pane. T1/T3/T4 ✓, T2 bottom 1 px.
- **F-39 resized 1400×900**: `pane {w:1400,h:856,right:1400,bottom:900,offsetW:1400}`, `#root.offsetH=900`,
  `docScrollH=900`, `canvas {w:1377,h:855,pxW:1377,pxH:855}`, `canvasHost` == pane. T1/T3/T4 ✓.
  **Maximize is unavailable** — `tauri_manage_window action="maximize"` →
  `Failed to maximize window: manage_window action "maximize" needs tauri-plugin-mcp-bridge 0.13.0 or newer`
  (same <0.13 plugin cap as the #2934 minimize block). The measured 1400×900 resize is the size coverage;
  the maximize leg is a **named environment limitation**, never passed unmeasured.
- **F-40 grid-follows-pane**: active (`9a4a8c41` opencode) `cols/rows` tracked the pane
  (98×37 @900×600 → 153×57 @1400×900); the NON-active session (`1967d8ff` copilot) stayed **80×24**
  across the whole sequence — active-only `resize_pty` ✓.
- **F-41 pane invariant under state surfaces** (re-measured): `empty` 900×556, `all-ended` 900×556,
  `starting` 900×556, `error` 560×316 + 900×556, `ended` 900×556, `resume` 900×556,
  `resume-blocked` 560×316 + 900×556 — `pane[data-surface]` equalled the forced state and the pane filled
  the window in every case (the surfaces are absolute-inset children).
- **F-54 continuous tracking (G-123)**: sequence **900×600 → 1200×700 → 560×360 → 1400×900**
  sampled at EVERY step: `cols/rows` **98×37 → 131×43 → 60×21 → 153×57** (monotonic in the pane's
  direction), `canvasHost` flush at every sample, pane/`#root`/`docScrollH` exact at every step, and
  no 0×0 latch (all sampled boxes > 0; the 0×0 guard + its unit pin below).

**AC2 — PASS (measured + described frames).**
- **F-42** at 900×600 / 560×360 / 1400×900: `bar.h = 44` and `bar.offsetW == innerW` in all three;
  `pane.offsetW` (900/560/1400) > tablist (793/453/1293); `pane.offsetH` 556/316/856 ≥ `innerH−46`;
  pane area share **92.7% / 87.8% / 95.1%** (≥80% ✓), nav share **7.3% / 12.2% / 4.9%** (≤15% ✓);
  every visible tab's title + "running" + work-dir leaf boxes non-zero (title 113.64×21, status 42.83×18,
  work-dir 64.81×18).
- **F-43** at 560×360 with 2 sessions: status dot 8×8, title/status/work-dir non-zero,
  active tab `aria-selected="true"` + `aria-current="true"`, `+` 32×32, History toggle 51.2×32,
  per-tab close 32×32 — all ≥24×24.
- **F-44** described frames at all three sizes in BOTH themes. Light theme (`Light Default` preset)
  reproduced the identical geometry (pane 1400×856 / 560×316 / 900×556, cols 153/60/98) — the rail re-tints
  (light `--header-bg`) while the Ghostty canvas keeps its allowlisted data palette; the terminal stays
  dominant and the nav/status stay legible. See the Round notes caveat on how the light leg was driven.

**AC3 — PASS (all nine surfaces, live).** `pane[data-surface]` + the preserved testid per surface:
- **F-45** `empty` (0 live + 0 persisted → `terminal-empty-state`, pane 900×556) and `all-ended`
  (all sessions self-exited → `terminal-all-ended-state`; window stayed open).
- **F-46** `starting` + slow-start hint via the **C-6** lever
  (`terminal_pwsh_path = fixtures/slow-pwsh.cmd` + `spawn_terminal_session{cli:'copilot',
  testOverride:{binary:fixtures/fake-copilot.ps1}}`): `status='starting'` + `terminal-starting-state`
  ("Starting GitHub Copilot…"), then past the 10 s Doherty bound the hint rendered
  ("Still starting… (check the CLI is installed)"), then the session errored `prereq`. Key restored.
- **F-47** `running`: `status='running'`, first byte cleared the overlay, `data-surface="terminal"`,
  `terminal-canvas-host-<activeId>` + `canvas` present, pane filled.
- **F-48** every typed kind: `invalid-cli` (cli `bogus`), `invalid-cwd` (`…\fixtures\no-such-dir`),
  `missing-binary` (`testOverride.binary = …\no-such-binary.cmd`), `prereq` (`testOverride.pwshMajor:5`),
  `auth` (`terminal_copilot_path = fixtures/fake-copilot-auth.cmd`), `launch` (override = a directory),
  plus the file-as-workDir edge → `invalid-cwd`. Each rendered `pane[data-surface]="error"` +
  `terminal-error-state[data-error-kind]` with distinct readable copy. Native control (Copilot, NO
  override) reached `running` (pid) → the `prereq` leg is non-vacuous. `generic` is the frontend
  IPC-rejection fallback only (no shipped launch path yields it).
- **F-49** `ended`: 2 live, one self-exited (Ctrl-C) → `terminal-ended-banner`
  ("This session has ended / Restart session / Close session") over its retained scrollback, the peer
  still `running`, window open.
- **F-50** `resume` (auto-selected the newest record, zero clicks) / `resuming`
  ("Resuming GitHub Copilot…", and at ≥10 s "Still resuming… (this can take a moment)" + **Cancel**) /
  `resume-blocked` for all three producible reasons: `cli-missing`
  (`terminal_copilot_path = no-such-binary.cmd`), `invalid-cwd` (workdir-a removed + restored) and
  **`resume-failed` via the C-6 lever** (`terminal_copilot_path = fake-copilot.ps1` +
  `terminal_pwsh_path = slow-pwsh.cmd` → the gate held the IPC promise past the 15 s watchdog →
  "Couldn't resume this session / Resume timed out… Nothing was started.", record unchanged, no
  partial session, no orphan). A real record→Resume→`running` cycle also passed
  (`1b0bb092` reused its id). `resume-blocked / invalid-cli` = **n/a — PO/Architect-ruled unreachable**
  (closed 3-member reason set; asserted on the LAUNCH surface via F-48).
- **F-55** at 560×360: the state surface is `overflowY:auto` inside the pane, primary controls
  (Retry 87.7×36, Start fresh 119.6×36, Delete 95×36) all ≥24×24 and inside; no shipped surface's
  content exceeded the 316 px pane so the scroll never engaged (disclosed).
- **F-56** `terminal-previous-toggle` (`aria-label="Previous sessions (3)"`,
  `aria-haspopup="dialog"`, `aria-expanded`, `aria-controls="terminal-previous-panel"`, 51.2×32),
  `terminal-previous-panel` present + queryable while COLLAPSED (`role="dialog"`,
  `aria-label="Previous sessions"`), and 3 `terminal-previous-session-row-<id>` buttons each carrying
  `persistedAriaLabel`; selecting a row surfaced `terminal-resume-state` in the pane. (Observation: the
  rows render as `<button>` without `role="listitem"` — labelled + keyboard-reachable, a11y nicety only.)
- **F-41 corroboration** — the pane re-measured with each state (see AC1).

**AC4 — PASS (fixture isolation).** Accounting: the pre-run store held **4 records, ALL #2935-era
automation leaks** (3 under `.opencode\tests\terminal\fixtures\`, 1 under `.opencode\tmp\2935\gone-dir`).
The one-time purge (`purge-fixture-records.js` logic) removed the 3 fixture-root rows
(`1967d8ff`, `9a4a8c41`, `f86be818`); the F-45(a) recipe then removed the 4th (`7ce805d1`). The run then
created fixture-root records for every spawning row and the C-5 teardown removed them all
(`013649e1`, `2729527c`, `1b652d70`, `45e48ff9`, `b3c4fe65`, …), leaving the non-fixture control record
`1b0bb092` (`C:\Users\pktro`) **untouched** through two teardown runs. Final state: **0 records** (the
tester-created non-fixture record was also removed to leave the developer's list clean) → the developer's
"Previous sessions" list is empty, zero fixture/automation rows.
- **F-51 scoped before/after**: BEFORE (post-purge) `[1b0bb092]` + settings
  `{work_dir: …\workdir-b, default_cli: copilot, copilot_path: "", pwsh_path: ""}`; after the run +
  teardown AFTER = `[1b0bb092]` — **identical id set/count**, zero fixture-root records.
- **F-52 idempotent teardown**: run 1 deleted 2 (fixture-root) / run 2 deleted **0** → idempotent;
  read-only `SELECT id,cli,work_dir,title FROM feature_terminal_sessions` via the `telemetry-query`
  skill returned **zero rows** (final). Settings restored to the captured values.
- **F-53 static pin** (supporting): `pnpm --filter @fredo/ui test:run featureRoots.contentRegionSizing`
  → **7/7 pass**; the pin asserts the no-`100vh`/`100vw` scan BROADENED to every `.tsx` under
  `features/terminal/components/`, a direction-agnostic `<Flex … h="100%">` root assertion, AND the
  host-document assertion reading `../tauri/index.html` (which declares
  `html, body { margin: 0; height: 100% }` + `#root { height: 100% }`).
- **F-54 supporting**: `SessionTerminal.resize.test.tsx` → **6/6 pass** (0×0-fit pin).

**AC5 — PASS except R-18/S-16 (cold `fredo open-terminal`).**
- **F-6** main + exactly ONE `terminal` window during two concurrent sessions; **F-8** session-scoped
  PTY I/O (`ZZSENTINELZZ` present in A's buffer, absent from B's);
  **F-10** switching preserved `id`/`pid`/`startedAt` (byte-identical before/after) with both terminals
  mounted and `visibility` toggled (hidden/visible) — no re-spawn, no remount;
  **F-12** `terminal_default_cli='copilot'` preselects GitHub Copilot + `terminal_work_dir` prefills the
  Working-directory field; **F-13** native Copilot reached `running`;
  **F-22..F-29** close→reopen listed all records, reopened with **0 processes**, and a real resume
  (`1b0bb092`) reached `running`; **F-33/F-34** CLI negatives returned
  `{"outcome":"invalid-cli"}` / `{"outcome":"invalid-directory"}` with the session list unchanged;
  **R-19** after closing with 2 live sessions `process-hygiene.ps1 -List` = 0 session trees,
  **0 unprotected orphan candidate(s)**, records survived.
- **R-18/S-16 — FAIL (cold leg).** With NO `terminal` window open, `fredo open-terminal --cli opencode
  --dir …\workdir-a` reports `{"cli":"opencode","outcome":"started",…}` and the window IS created — but
  **no session is spawned** (`list_terminal_sessions` = `[]`, pane `data-surface="resume"`, 0 session
  rows, no persisted record). Reproduced **4/4** cold runs (two closed via
  `getCurrentWindow().close()`, one via the product's own `close_terminal_window`, one re-checked after
  12 s). With the window ALREADY open the same command spawns + auto-selects the session
  (3/3 warm runs, e.g. `b3c4fe65` running in `workdir-a`, `aria-current="true"`).
  Root cause (code, not speculation): backend `open_terminal_window_with_intent`
  (`commands.rs:1005-1052`) arms a ONE-SHOT `on_page_load` handler that does not filter
  `PageLoadEvent`, so the launch intent is emitted at `PageLoadEvent::Started` — before the webview's
  `adapterBridge.listen('terminal-open-request')` registers (it resolves through a dynamic import +
  IPC). `git diff --stat main HEAD -- apps/tauri/src-tauri` = **empty** and the
  `TerminalWindow` listener effect (`TerminalWindow.tsx:346-402`) is unchanged by #2940 → the defect is
  **pre-existing, not introduced by this spec**, but the AC5 R-18/S-16 row as written requires the cold
  spawn.

**Non-functional (#2940).** N-18: the ONLY hardcoded colours in `features/terminal/components/**` are the
allowlisted `GHOSTTY_THEME` ANSI data palette — no `rgba()` UI colour, no `var(--token)NN`
alpha-append. N-19: `role="tablist"` + `aria-label="Terminal sessions"`, roving tabindex `[0,-1,-1]`,
ArrowRight moved `aria-selected`/`aria-current`/`tabIndex=0` + focus to the next tab; History toggle
carries `aria-haspopup/expanded/controls`; the panel is non-modal (no focus trap). N-20: console clean in
BOTH windows (only DEBUG/INFO + the pre-existing `motion() is deprecated` WARN). N-21: 0 orphans
(R-19). N-22: primary controls ≥24×24 at 560×360. N-23: no re-spawn (F-10). N-24: pin covers the
reworked root + files (F-53).

Round-5 frame names: `r2940-ac1-default`, `r2940-ac1-min`, `r2940-ac1-resized`,
`r2940-ac2-900-light`, `r2940-ac2-560-light`, `r2940-ac2-1400-light`, `r2940-ac2-min-dark`,
`r2940-ac3-empty`, `r2940-ac3-starting`, `r2940-ac3-error-prereq`, `r2940-ac3-ended`,
`r2940-ac3-resume-panel`, `r2940-ac3-resume-failed`, `r2940-ac4-clean-records`,
`r2940-e27-12tabs-min`.

### Round 6 (Spec #2940 — round 2 retry) — 2026-09-24, spec/2940 @ a4b4dfa1 (verdict PASS; R-18/S-16 FIXED)

Cold-restarted the dev instance (`dev-env.ps1 -Action Restart -Spec 2940`) so the round-2 Rust
fix `b303ba9` (pull handshake replacing the unfiltered page-load push) was built and served;
status line `running (repo root on spec/2940 @ a4b4dfa1)`. Driver session stop+start +
`__MCP__` namespace re-probe (`{mcp:true, ref:true}`).

**PASS — AC1 (measured).** 900×600 / 560×360 / 1400×900: pane flush at every size
(`right`/`bottom` == innerW/innerH), `#root.offsetH == innerH`, `docScrollH == innerH`,
surface rect == pane rect, `canvasHost` rect == pane rect (0 px). `data-cols/rows`
`98×37 → 60×21 → 153×57` tracked the pane; the non-active peer stayed `80×24`/`98×37`
(active-only `resize_pty`). Disclosed: `pane.right − canvas.right` 18–23 px = ghostty-web's
scrollbar-width reservation (host flush, same background) — no dead band.

**PASS — AC2 (measured).** `bar.h=44`, `bar.offsetW==innerW`; `pane.offsetW >` tablist width;
`pane.offsetH ≥ innerH−46` at all three sizes; active tab `aria-current="true"`; `+` 32×32,
tabs 154×36, per-tab close 32×32, History toggle 51×32.

**PASS — AC3 (all nine surfaces).** `empty`, `all-ended`, `starting` + slow-start hint
(C-6 lever), `terminal` (running), `error` for `invalid-cli`/`invalid-cwd`/`missing-binary`/
`prereq`/`auth`, `ended`, `resume`, `resuming`, `resume-blocked` (`cli-missing` +
`resume-failed` via the C-6 lever). F-56: `terminal-previous-toggle` + 7 rows with
`persistedAriaLabel`. Diagnostic keys restored.

**PASS — AC4.** Pre-run 0 records; the run created only fixture-root records; C-5 teardown
run 1 deleted 3 / run 2 deleted 0 (idempotent) → 0; the four settings keys restored to the
captured pre-run values.

**Resume (F-24/F-25) re-confirmed** via the records list/auto-select (`resume` surface) and
a real record→Resume→`running` cycle in the earlier round; this round the primary re-drive
was R-18 (below).

Round-6 frame names: `r2940-r2-cold-open-terminal`, `r2940-r2-ac1-min`,
`r2940-r2-ac1-resized`, `r2940-r2-ac2-default`, `r2940-r2-ac3-error-prereq`,
`r2940-r2-ac4-clean-records`, `r2940-r2-ac4-final-clean`.
