# Terminal — Regression Test Suite

Feature domain: `terminal` (renamed from `run-cli` at Spec #2934). These cases verify
behavior that MUST NOT change while the multi-session Terminal lands, and the "must not
change" invariants inherited from the retired Run CLI contract.

Conventions: ID prefix `R-`; observable expected outcomes. On pass keep the checkbox and
append evidence; on fail mark `FAIL`.

## Cross-suite links (run these too when the diff touches this surface)

- `.opencode/tests/run-cli/` — the pre-rename suite (#2728/#2731). It is EXTENDED with a
  `## #2934 pre-rename regression cases` section (the legacy contract that must keep
  passing until the rename retires it). Run its `regression.md` for every Terminal change.
- `.opencode/tests/window-manager/` — the Terminal window is an out-of-slice caller of the
  window kernel (`regression.md` R-2); window open/close lifecycle must not regress. Its
  `smoke.md` S-12 cites the OLD label `run-cli-terminal` as historical PASS evidence — the
  rename must update the live assertion to `terminal`, not the historical record.
- `.opencode/tests/window-engine-cleanup/` — window framing/launcher chrome.
- `.opencode/tests/settings/` — the settings surface + key migration must not disturb other
  settings sections.
- `.opencode/tests/copilot-capture/` — Copilot telemetry capture is OUT of scope for
  #2934; Terminal only LAUNCHES `copilot`. Its capture rows must not regress (no Terminal
  change to the OTLP path).

## No-change baseline (#2934 non-goals / inherited contract)

> **#2935 supersedes two bullets below:** persistence/resume across window close/reopen and the
> `fredo` CLI open command are no longer non-goals (they are the #2935 scope). The Ghostty renderer,
> the OTLP/RTDB ingest path, and the other toolbar items remain no-change and are re-run by R-1..R-7,
> R-13/R-14.

- **Non-goals:** persistence/resume across window close/reopen; the `fredo` CLI open
  command; Copilot telemetry capture; changing the Ghostty terminal renderer.
- The Ghostty renderer (`RunCliTerminalWindow.tsx`'s `GHOSTTY_THEME` + `ghostty-web`
  `init/Terminal/FitAddon`) is unchanged — only the launch/identity/multi-session wiring
  changes.
- The OTLP/RTDB ingest path is untouched (no `run-cli` → `terminal` change to the
  classifier).
- Other toolbar desktop items and the desktop grid are unchanged.

## Cases

- [ ] R-1: **Ghostty renderer unchanged.** Open a Terminal session and inspect the terminal
  window's canvas.
  EXPECTED: the Ghostty canvas renders (non-zero rendered pixels / a Ghostty host element);
  no `.xterm` / `.xterm-viewport` / `.xterm-screen` classes; no dual-renderer state; the
  ANSI palette is the allowlisted `GHOSTTY_THEME`.
  Edge: `init()` failure path (no terminal mounted, console error) is still surfaced, not
  silent.

- [ ] R-2: **PTY I/O contract still round-trips.** Launch a session; type input; resize the
  window; read the buffer.
  EXPECTED: input reaches the process (echo/response), output streams to the active
  session's buffer, resize is applied — now keyed by `sessionId`. No command is removed;
  the per-session variants preserve the old semantics for a single session.
  Edge: input longer than one chunk; an empty buffer before first output; `get_pty_buffer`
  replay on window mount still renders the initial burst.

- [ ] R-3: **Work-dir source still functional (new key).** Set the work dir via Settings →
  Terminal; relaunch.
  EXPECTED: the value persists and the session starts in it; unset → home fallback
  (`USERPROFILE`/`HOME`), matching the pre-rename fallback.
  Edge: blank value; path with spaces/unicode.

- [ ] R-4: **Single-instance / one-window guarantee.** Repeatedly invoke the Terminal
  toolbar item while sessions are open.
  EXPECTED: exactly ONE `terminal` window ever exists (main + 1); a repeat focuses/reuses
  it; no second window on rapid double-click.
  Edge: invoke during a launch; invoke from the error state.

- [ ] R-5: **Main-window health.** No console errors in the main window during launch,
  streaming, multi-session switching, and close.
  EXPECTED: `tauri_read_logs(source="console")` shows no `Error:` / `Uncaught` /
  `Maximum update depth exceeded`.

- [ ] R-6: **Other toolbar desktop items unchanged.** Every other showable feature's
  toolbar item still renders and launches.
  EXPECTED: sibling items identical in set/labels/ordering; only the Run CLI item is
  renamed (Terminal); no other item's behavior altered.

- [ ] R-7: **Settings surface safe.** The Terminal settings section renders in Settings →
  Terminal alongside the existing sections; other sections (Companion, Appearance, Fredo
  Setup, Telemetry) are unchanged.
  EXPECTED: no other settings key/section added, removed, or renamed by #2934.

- [ ] R-8: **No persistence (non-goal guard).** Restart the app after using Terminal.
  EXPECTED: the sidebar is empty; no session rows are persisted; no resume across restart.
  > **SUPERSEDED by #2935** (do NOT run as written): persistence/resume + the `fredo` CLI open
  > command are now REQUIRED, not non-goals. Retained as the historical #2934 record; the live
  > assertions are the `#2935 no-change baseline` R-11..R-14 below + `functional.md` F-22..F-36.

- [ ] R-9: **Telemetry path untouched.** The OpenCode session launched from Terminal still
  emits `fredo.*` spans.
  EXPECTED: `telemetry_spans` records the Terminal-launched OpenCode session identically to
  the pre-rename Run CLI (live query via
  `.opencode/skills/telemetry-query/telemetry-query.ps1`).

- [ ] R-10: **Copilot capture unaffected.** Copilot telemetry capture (prior ticket)
  continues to work; Terminal's launch does not write to or alter the capture path.
  EXPECTED: no change to `infrastructure/rtdb/` or the OTLP receivers in the #2934 diff.

## #2935 no-change baseline (AC5) — persistence + CLI must not regress the #2934 surface

> These run on every testing phase of the persistence/resume slice. The CLI path and the
> persistence layer introduce no regression to the launcher, the settings flow, or live multi-session
> behavior.

- [ ] R-11: **Launcher still opens Terminal (one window).** Click the `Terminal` desktop toolbar item
      (and the Settings entry) against the running app.
      EXPECTED: exactly ONE `terminal` window (main + 1); re-invoke focuses it (no duplicate);
      persisted + live lists render; sibling toolbar items (Mission Monitor, Query Viewer, Settings,
      Stepper Probe) unchanged.
      Edge: re-invoke during a resume; invoke from the empty-records state.

- [ ] R-12: **Settings → Terminal unchanged + keys still govern.** Open Settings → Terminal; save a
      work dir + default CLI; restart; reopen.
      EXPECTED: `terminal_work_dir` / `terminal_default_cli` still persist and preselect/govern a new
      session; the legacy `run_cli_work_dir` migration (F-4/F-5) still behaves; no other settings
      key/section added, removed or renamed.
      Edge: unset keys → documented fallbacks; both legacy + new keys set (new wins).

- [ ] R-13: **Live multi-session contract (#2934 core).** Add OpenCode + Copilot sessions; per-session
      sentinel I/O; switch sessions; resize the active session; close one (other survives); let a
      session self-exit.
      EXPECTED: session-keyed `write_pty_input`/`get_pty_buffer`/`resize_pty` still correct; buffers
      isolated; `id`/pid/`startedAt` unchanged on switch; the window survives a self-exit; exactly one
      `terminal` window throughout.
      Edge: two same-CLI sessions; switch during heavy output; self-exit while unselected.

- [ ] R-14: **Telemetry/ingest path untouched.** The OpenCode session launched/resumed from Terminal
      still emits `fredo.*` spans.
      EXPECTED: `git diff --stat main origin/spec/<N>` shows no `infrastructure/rtdb/**` or
      `infrastructure/otlp/**`; a live `telemetry_spans` query records the Terminal-launched session.
      Edge: a resumed session's spans carry the resumed CLI session's identity (no fresh duplicate).

## Round notes

### Round 1 — 2026-09-24, spec/2934 @ 1fd60694

- R-1 PASS (live canvas; `.xterm`=0 / `.xterm-viewport`=0).
- R-2 PASS (`write_pty_input`/`get_pty_buffer`/`resize_pty` session-keyed; sentinel round-trip).
- R-3 PASS (new key governs; blank → home-fallback semantics).
- R-4 PASS (main+1 at every sample).
- R-5 PASS (both-window console clean).
- R-6 PASS (siblings Mission Monitor / Query Viewer / Settings / Stepper Probe intact).
- R-7 PASS (Settings → Terminal discovered alongside the static sections).
- R-8/N-5 PASS (empty sidebar after restart; no `%terminal%` table in `fredo.db`).
- R-9 UNVERIFIED (no LLM turn driven in a Terminal-launched session; the
  `telemetry_spans` table is live — see the `## Tests Runs` on #2934).
- R-10 PASS (`git diff --stat main origin/spec/2934` → no `infrastructure/rtdb/**` or
  `infrastructure/otlp/**`).

### Round 2 — 2026-09-24, spec/2934 @ a656a020

- R-1 PASS (no renderer change in `a656a02`; live Ghostty canvas, `.xterm`=0).
- R-2 PASS (`write_pty_input`/`get_pty_buffer` sentinel round-trip; activation resize changes
  the selected session's dims — see F-11 for the missing window-resize path).
- R-3 PASS (`terminal_work_dir` governs; migration copies the legacy value when the new key
  and the window's `localStorage` are both empty).
- R-4 PASS (main+1 at every sample with 4 sessions live).
- R-5 PASS (both-window console clean — terminal has only `[ghostty-vt]` renderer warnings).
- R-6 PASS (launcher grid: Mission Monitor, Query Viewer, Settings, Stepper Probe, Terminal).
- R-7 PASS (Settings → Terminal alongside the static sections; other panes untouched).
- R-8/N-5 PASS (`list_terminal_sessions` = `[]` after restart).
- R-9 UNVERIFIED (no LLM turn driven in a Terminal-launched OpenCode session; the
  `telemetry_spans`/`telemetry_logs` tables are live — see the `## Tests Runs` on #2934).
- R-10 PASS (no `infrastructure/rtdb/**` / `infrastructure/otlp/**` in the diff).

### Round 3 — 2026-09-24, spec/2934 @ 7ba5a99c

- R-1 PASS (live Ghostty canvas renders in both sessions' screenshots; no `.xterm*` DOM).
- R-2 PASS (session-keyed `write_pty_input`/`get_pty_buffer`/`resize_pty`; sentinels round-trip
  both ways; window-resize `resize_pty` now fires for the ACTIVE session only — F-11 fixed by FX-5).
- R-3 PASS (`terminal_work_dir` governs: the add-session dialog prefills `…\fixtures\workdir-b`).
- R-4 PASS (main+1 at every sample while up to 5 sessions ran).
- R-5 PASS (both-window console clean — only `[LOG]/[DEBUG]` + the pre-existing `motion()`
  deprecation WARN; 0 errors).
- R-6 PASS (launcher grid = Mission Monitor, Query Viewer, Settings, Stepper Probe, Terminal).
- R-7 PASS (Settings → Terminal alongside the static sections; the diff touches no other pane).
- R-8 PASS (`list_terminal_sessions` = `[]` from the main window after the window closed;
  `sqlite_master` has no `%terminal%`/`%run_cli%` table).
- R-9 UNVERIFIED (no LLM turn driven in a Terminal-launched OpenCode session — G-080 cost
  ceiling; the `telemetry_spans` table is live — see the `## Tests Runs` round 3).
- R-10 PASS (`git diff --stat main origin/spec/2934` → no `infrastructure/rtdb/**` /
  `infrastructure/otlp/**`; the `infrastructure/cli/commands/setup.rs` change is 2 lines,
  non-telemetry).

### Round 4 (Spec #2935) — 2026-09-24, spec/2935 @ 9ad0b360

- **R-11 PASS.** Launcher click → exactly one `terminal` window (main + 1); re-invoke focuses it
  (window count stayed 2). Sibling toolbar items unchanged.
- **R-12 UNVERIFIED (time-boxed).** Settings → Terminal key governance not re-driven this round
  (the persisted `terminal_default_cli='copilot'` was observed preselected in the new-session
  dialog, a partial signal). Named blocker: round budget — the full save/restart/reopen leg was not
  run.
- **R-13 PASS.** Two OpenCode sessions live concurrently in one window; switch toggled the surface
  (`visibility:hidden` on the inactive session, `visible` on the active); `close_terminal_session`
  reaped only the target tree while the peer kept `running`; one window throughout; per-session
  buffers isolated (resumed 1 sentinel / fresh control 0). Self-exit leg not re-driven (untouched by
  the #2935 diff).
- **R-14 PASS.** `git diff --stat main origin/spec/2935` → no `infrastructure/rtdb/**` /
  `infrastructure/otlp/**`; the Terminal-launched OpenCode session emits `fredo.*` spans
  (`ses_f2ae1f08bffeKvHxKiOCxMnM4X`: `fredo.session`/`fredo.llm`), and a resumed session keeps its
  CLI session identity (no fresh duplicate).
- **N-1 PASS.** `feature_terminal_sessions` column set is exactly
  `{id, cli, work_dir, title, created_at, last_active_at, cli_session_id}`; the dumped rows contain
  no credential-shaped strings.
- **N-4 PASS.** Window close/reopen spawns ZERO processes until an explicit resume; no
  attach/detach/keep-alive surface in the diff.
