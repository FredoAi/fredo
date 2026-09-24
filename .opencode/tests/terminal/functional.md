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
