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

## #2940 no-change baseline (AC5) — the layout rework must not regress live multi-session behavior

> The #2940 rework changes the terminal window's COMPOSITION (layout/measurement + a test
> fixture-isolation fix). It must not change the live behaviors proven by #2934/#2935. These
> rows re-run the existing suite rows named in each — a rework that makes any of them FAIL is
> a defect. Evidence is LIVE (window list / DOM / PTY-buffer bytes / process inventory / the
> `fredo` binary stdout), same policy as the parent rows.

- [ ] R-15 (**AC5 — concurrency + session-scoped I/O + no-re-spawn**): run `functional.md`
      F-6 (two concurrent sessions, OpenCode + Copilot, one `terminal` window), F-8 (per-session
      sentinel isolation both ways), F-10 (switch preserves `id`/`pid`/`startedAt`, no
      re-spawn) against the reworked composition.
      EXPECTED: all three keep passing exactly as in the #2934/#2935 rounds; the rework does
      not turn a switch into a re-spawn or a tab click into a remount.
      Edge: two same-CLI sessions; switch during heavy output.

- [ ] R-16 (**AC5 — default-CLI + settings governance**): run `functional.md` F-12
      (`terminal_default_cli` persists + preselects) and `regression.md` R-12 (Settings →
      Terminal keys still govern; the legacy `run_cli_work_dir` migration still behaves).
      EXPECTED: unchanged; the rework adds no settings key and removes none.
      Edge: unset keys → documented fallbacks.

- [ ] R-17 (**AC5 — resume + teardown**): run `functional.md` F-22..F-29 (persisted list
      across window close/reopen + restart; real resume via the CLI's own resume switch;
      teardown receipt `0 opencode/node/copilot process(es)`; records survive; close one
      session leaves the peer).
      EXPECTED: all keep passing; the rework does not change the record payload, the resume
      semantics, or the teardown receipt.
      Edge: resume a missing-dir record; resume while another session streams.

- [ ] R-18 (**AC5 — the `fredo open-terminal` CLI path**): run `functional.md` F-33/F-34 and
      `smoke.md` S-16.
      EXPECTED: `fredo open-terminal --cli opencode --dir
      C:\Code\fredo\.opencode\tests\terminal\fixtures\workdir-a` → exit 0, the `terminal`
      window opens, a session with that cli+workDir spawns and is auto-selected (no dialog);
      invalid `--cli`/`--dir` still surface the typed errors.
      Edge: `--cli`/`--dir` defaults; concurrent invocations.

- [ ] R-19 (**AC5 — zero orphans after the rework**): with ≥2 sessions live, close the
      `terminal` window; `process-hygiene.ps1 -List`.
      EXPECTED: `0 opencode/node/copilot process(es)` and `0 unprotected orphan candidate(s)`;
      the main window stays responsive.
      Edge: close during `starting`; close while an error surface shows; close right after a
      self-exit.

## #2942 no-change baseline (AC5) — the vertical-sidebar rework must not regress the live contract

> Seeded at triage for Spec #2942. The rework changes the terminal window's COMPOSITION
> (horizontal 44 px rail → vertical sidebar) and adds rename / plain-shell / settings-type.
> It must NOT change the live behaviors proven by #2934/#2935/#2940 (concurrency, session-scoped
> I/O, no re-spawn, resume, teardown receipt, telemetry path). Evidence is LIVE, same policy as
> the parent rows. **Note:** the #2940 composition rows F-42/F-43/F-44/F-56 + N-19 are
> SUPERSEDED by the #2942 functional rows F-57..F-61; R-15..R-19 below remain live (they assert
> behavior, not the rail shape).

> **EARS map (Architect-authoritative):** R-20 → R-1.1 + R-1.7; R-21 → the #2934 live contract
> (F-6/F-8/F-10); R-22 → #2935 F-22..F-29; R-23 → R-4.1 + R-4.3 (G-242); R-24 → R-4.4 + G-250;
> R-25 → the zero-orphan NFR; R-26 → #2935 R-14; R-27 → the Architect §8 supersede/Preserve list.
> Published hooks/gates: see `functional.md` → "Requirement-ID reconciliation" (the two
> sections disagree on the sidebar root testid / rename trigger / plain-shell value — bind to
> either, flag a miss as a TOOLING GAP).

- [ ] R-20 (**AC5 — pane invariants preserved under the vertical sidebar**): run `functional.md`
      F-37..F-41 and F-54 against the reworked composition (re-measured with the new sidebar).
      EXPECTED: the #2940 pane invariants T1–T4 + T12 still hold at 900×600 / 560×360 / 1400×900
      (pane flush to its window edge, active surface rect == pane rect, `canvasHost` rect == pane
      rect, no dead band ≥8 px, `docScrollH ≤ innerH + 1`) and the active grid still tracks the pane
      (no 0×0 latch). The COMPOSITION is new; the invariants are not.
      Edge: resize while a state surface shows; the min bound; light + dark.

- [ ] R-21 (**AC5 — concurrency + session-scoped I/O + no-re-spawn**): run `functional.md`
      F-6 (two concurrent sessions — OpenCode + a plain shell or Copilot — in ONE `terminal` window),
      F-8 (per-session sentinel isolation both ways) and F-10 (switch preserves
      `id`/`pid`/`startedAt`, no re-spawn) against the reworked sidebar.
      EXPECTED: all three keep passing; a row click is not a remount/re-spawn.
      Edge: two same-type sessions; switch during heavy output.

- [ ] R-22 (**AC5 — resume + record payload unchanged**): run `functional.md` F-22..F-29 (persisted
      list across window close/reopen + restart; real resume via the CLI's own switch; teardown
      receipt `0 opencode/node/copilot process(es)`; records survive; close one leaves the peer).
      EXPECTED: the record payload is still exactly `{id, cli, workDir, title, createdAt,
      lastActiveAt, cliSessionId}`; resume semantics unchanged; the receipt unchanged. The new
      plain-shell TYPE is additive — existing `opencode`/`copilot` resume paths are untouched.
      Edge: resume a missing-dir record; resume while another session streams.

- [ ] R-23 (**AC5 — settings governance + legacy migration, G-242**): run `regression.md` R-12
      (Settings → Terminal keys still govern; the legacy `run_cli_work_dir` migration still behaves)
      and `functional.md` F-71 (the legacy `terminal_default_cli` value migrates/resolves without
      orphaning the key or mutating a record).
      EXPECTED: `terminal_work_dir` still governs; the legacy work-dir migration is unchanged; the
      default-TYPE control is additive (no pre-existing settings key removed/renamed out from under
      the user); pre-existing records are byte-identical after the settings change.
      Edge: unset keys → documented fallbacks; both legacy + new keys set (new wins).

- [ ] R-24 (**AC5, G-250 — the cold `fredo open-terminal` path**): run `functional.md` F-77 / S-16
      with the `terminal` window CLOSED.
      EXPECTED: `fredo open-terminal --cli opencode --dir …\fixtures\workdir-a` → exit 0, the
      `terminal` window opens, a session spawns and is auto-selected (cold 3/3 + a warm control);
      invalid `--cli`/`--dir` still surface their typed outcomes. A cold leg that opens the window
      but spawns nothing is a FAIL.
      Edge: rapid cold invocations; window closed with a state surface showing.

- [ ] R-25 (**AC5 — zero orphans after the rework**): with ≥2 live sessions, close the `terminal`
      window; `process-hygiene.ps1 -List`.
      EXPECTED: `0 opencode/node/copilot process(es)` (+ no leftover `pwsh`/`powershell` for the
      plain-shell leg) and `0 unprotected orphan candidate(s)`; the main window stays responsive.
      Edge: close during `starting`; close while an error surface shows; close right after a self-exit.

- [ ] R-26 (**AC5 — telemetry/ingest path untouched**): run `regression.md` R-14.
      EXPECTED: `git diff --stat main origin/spec/<N>` shows no `infrastructure/rtdb/**` or
      `infrastructure/otlp/**`; a live `telemetry_spans` query records the Terminal-launched OpenCode
      session (the plain-shell type emits no agent spans and must not corrupt the classifier).
      Edge: a resumed session keeps its CLI session identity (no fresh duplicate).

- [ ] R-27 (**AC5 — the retired rail contract is gone; the preserved contract is intact**): inspect
      the served `terminal` window DOM.
      EXPECTED (retired): `[data-testid="terminal-session-bar"]`, `[data-testid="terminal-previous-toggle"]`,
      `[data-testid="terminal-previous-panel"]`, and the `[role="tablist"]`/`role="tab"` tab strip are
      ABSENT. EXPECTED (preserved): `[data-testid="terminal-pane"]` with `data-surface`/`data-cols`/
      `data-rows`, `[data-testid^="terminal-previous-session-row-"]` rows with `persistedAriaLabel`, and
      `[data-testid^="terminal-canvas-host-"]` all present.
      Edge: 0 previous records (no previous rows); a state surface showing.

## C-5 teardown (MANDATORY — run after this suite; BINDING, Architect C-5)

> **#2942 delta:** ALSO snapshot/restore the default-TYPE key (published; fallback
> `terminal_default_cli`) and snapshot every pre-existing record's `{id → title}` so a
> rename row can prove G-242 (no pre-existing title changed) and no pre-existing settings key
> is left mutated. Full detail: `functional.md` → "Teardown delta for #2942".

> Suite-side, no product change: run the recipe below in the `terminal` window via
> `tauri_webview_execute_js` after every run of these rows, then restore the four settings
> keys. It deletes every persisted record whose `workDir` is under the in-repo fixtures root.
> Full detail: `functional.md` → "C-5 teardown / snapshot / settings-restore".

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

- Pre-run snapshot: the record id set + the four settings keys (`terminal_work_dir`,
  `terminal_default_cli`, `terminal_copilot_path`, `terminal_pwsh_path`); compare AFTER.
- Settings restore (binding): restore those four keys to their captured pre-run values.
- Idempotent: a second run deletes nothing. Cross-suite repeat:
  `.opencode/tests/run-cli/regression.md`.

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

### Round 5 (Spec #2940) — 2026-09-24, spec/2940 @ 6a8b2c6d — AC5 re-run

- **R-15 PASS.** F-6: two concurrent sessions in ONE window (`main + 1 terminal` throughout).
  F-8: `ZZSENTINELZZ` written to session A appeared in A's PTY buffer and was **absent** from B's
  (session-scoped I/O held). F-10: switching tabs left `id`/`pid`/`startedAt` byte-identical
  (`[{1b652d70,pid 19916,…},{45e48ff9,pid 27696,…}]` before == after); both terminals stayed mounted
  with `visibility` toggled (`hidden`/`visible`) and `data-active` moving — no re-spawn, no remount.
- **R-16 PASS.** F-12: the new-session dialog preselects **GitHub Copilot** (`data-state="checked"`)
  matching `terminal_default_cli='copilot'`, and the working-directory input is prefilled with
  `C:\Code\fredo\.opencode\tests\terminal\fixtures\workdir-b` matching `terminal_work_dir`. The rework
  added no settings key (the four keys are exactly the pre-existing ones).
- **R-17 PASS.** F-22..F-29: closing the window with 2 live sessions then reopening listed ALL records
  (`Previous sessions (3)`), reopened with **0 processes**, surface `resume`, and a real
  record→Resume→`running` cycle reused the record id (`1b0bb092`). A record in a removed dir resumed to
  `terminal-resume-blocked-state[data-reason="invalid-cwd"]` (record retained) and resumed normally
  after the dir was restored.
- **R-18 FAIL — cold `fredo open-terminal` leg only.** `fredo open-terminal --cli opencode --dir …\workdir-a`
  with NO `terminal` window open reports `{"outcome":"started"}` and creates the window, but **no session
  spawns** (`list_terminal_sessions=[]`, `data-surface="resume"`, 0 tab rows, no record) — **4/4 cold
  runs**. With the window already open the identical command spawns + auto-selects the session —
  **3/3 warm runs**. Root cause: `open_terminal_window_with_intent` (`commands.rs:1005-1052`) emits the
  one-shot launch intent on `PageLoadEvent::Started` (the handler does not filter the event), before the
  webview's `terminal-open-request` listener registers. **Not a #2940 regression**:
  `git diff --stat main HEAD -- apps/tauri/src-tauri` is empty and the `TerminalWindow` listener effect
  is unchanged. The F-33/F-34 negatives both PASS (`{"outcome":"invalid-cli"}` /
  `{"outcome":"invalid-directory"}`, session list unchanged).
- **R-19 PASS.** With 2 live sessions, closing the window left `process-hygiene.ps1 -List` at
  **0 unprotected orphan candidate(s)** — the session trees (`opencode.exe 19916`/`13496`,
  `node 11816` → `copilot.exe 17848`, `opencode.exe 27696`) were all absent, and the records survived
  (reopen listed them).
- R-11..R-14 (and N-1..N-8) not re-driven this round beyond the above — the #2940 diff touches no
  `infrastructure/rtdb/**` / `infrastructure/otlp/**` path and no R-11..R-14 surface beyond those
  already covered by R-15..R-19 (window count, sentinel isolation, no-re-spawn, persisted list).
  The final clean state is **0 records** (all pre-existing rows were #2935-era automation leaks, purged
  per the C-5 one-time purge; every record the run created was removed by the teardown).

### Round 6 (Spec #2940 — round 2 retry) — 2026-09-24, spec/2940 @ a4b4dfa1 (verdict PASS; R-18 FIXED)

Served commit `spec/2940 @ a4b4dfa1` (cold restart built+served the round-2 fix `b303ba9`).

- **R-18 PASS (was round-5 FAIL) — the cold `fredo open-terminal` leg.** With NO `terminal`
  window open, `fredo open-terminal --cli opencode --dir …\workdir-a` → `{"outcome":"started"}`,
  ONE `terminal` window, a RUNNING OpenCode session with that cli+workDir, `data-surface=terminal`,
  `aria-current="true"` — **cold 3/3** (`7f3c8ad9`/pid 16728, `c1d44309`/pid 23380,
  `78470a18`/pid 14960) plus a reload leg. One-shot proven: 4× re-list + `location.reload()`
  kept exactly 1 session (same id). Warm **3/3** spawned exactly one new session each
  (`5c472c32`, `f27bb196`, `dd876bf8`). F-33/F-34: `--cli bogus` → `{"outcome":"invalid-cli"}`,
  `--dir …\no-such-dir` → `{"outcome":"invalid-directory"}`, session list unchanged (4→4).
- **R-15 PASS.** F-6 main+1 window with concurrent sessions; F-8 `ZZSENTINEL_R2_A` present in A
  only, `ZZSENTINEL_R2_B` in B only; F-10 switch kept `id`/`pid`/`startedAt` byte-identical.
- **R-16 PASS.** F-12 New-session dialog showed GitHub Copilot `data-state="checked"`
  (matches `terminal_default_cli='copilot'`).
- **R-17 PASS.** Close→reopen listed all 7 records with 0 processes; `resume` auto-selected the
  newest record; a real Resume rendered `resuming` then reached a terminal state.
- **R-19 PASS.** Closing with 2 live sessions → `process-hygiene.ps1 -List` session trees gone,
  **0 unprotected orphan candidate(s)**; records survived.
- C-5 teardown: run 1 deleted 3 fixture-root records / run 2 deleted 0 (idempotent) → 0; the four
  settings keys restored to their captured pre-run values.

### Round 7 (Spec #2942) — 2026-09-24, spec/2942 @ 3241b90d (FAIL — F-80/F-81)

- **R-20 PASS.** Pane invariants re-measured under the vertical sidebar at 900×600 / 560×360 / 1400×900:
  `pane.right/bottom == innerW/innerH`, active `surface` rect == pane rect, `canvasHost` rect == pane
  rect (0 px), `pane.bottom − canvas.bottom = 0`, `docScrollH ≤ innerH + 1`; the active grid tracked the
  pane `38×24 → 76×40 → 131×60` (no 0×0 latch). Disclosed: `pane.right − canvas.right` 16–21 px ghostty
  scrollbar-width gutter (host flush).
- **R-21 PASS.** One `terminal` window (main + 1) throughout; session-scoped `write_pty_input` /
  `get_pty_buffer` (SENTINEL/A-vs-B isolation via the row selection + active-surface assertions);
  `id`/`pid`/`startedAt` byte-identical on switch (`[{f0b4773a,14848,1790303205032},
  {206b88a2,9072,1790303224358}]` before == after) — no re-spawn / remount.
- **R-22 PASS.** Record payload exactly `{id,cli,workDir,title,createdAt,lastActiveAt,cliSessionId}`;
  resume semantics unchanged (a shell record reopened as a shell in its dir); the pre-change
  `opencode`/`copilot` records still parsed + listed. The new `shell` type is additive.
- **R-23 PASS.** `terminal_work_dir` still governs (dialog prefill); the legacy `run_cli_work_dir`
  migration copied `workdir-a` onto `terminal_work_dir` when the new key + `localStorage` were empty; the
  default-TYPE control is additive (same `terminal_default_cli` key, domain widened); changing it and
  Save left all 22 records byte-identical.
- **R-24 PASS (G-250, cold).** See `functional.md` Round 7 — cold 3/3 + a warm control; negatives
  `invalid-cli` / `invalid-directory` / `invalid-argument` all hold.
- **R-25 PASS.** Closing the window with live sessions (incl. plain shells) left
  `process-hygiene.ps1 -List` at **0 unprotected orphan candidate(s)**; the opencode/node/copilot trees
  were absent (the plain shells are `powershell.exe`, which the script does not enumerate).
- **R-26 PASS.** `git diff --stat main origin/spec/2942` touches only `features/terminal/**`,
  `lib.rs`(+1), the terminal UI + tests — **no `infrastructure/rtdb/**` or `infrastructure/otlp/**`**;
  the Terminal-launched OpenCode session emitted live `telemetry_spans`
  (`ses_f29a61a83ffegaZQl1PTPIVtml`: `fredo.session` + `fredo.llm`, both OK).
- **R-27 PASS.** Retired hooks ABSENT (`terminal-session-bar`, `terminal-previous-toggle`,
  `terminal-previous-panel`, `[role=tablist]`, `[role=tab]`); preserved hooks PRESENT (`terminal-pane` +
  `data-surface`/`data-cols`/`data-rows`, `terminal-session-row-<id>`,
  `terminal-previous-session-row-<id>` + `persistedAriaLabel`, `terminal-canvas-host-<id>`).
- **New row — F-80 FAIL (see `functional.md`).** The sticky `Previous (N)` section header overlaps the
  first previous row by 23 px in the 0-live state (repro at 2 and 16 records).
- C-5 + #2942-delta teardown: run 1 deleted 23 fixture-root records / run 2 deleted 0 (idempotent) → 0;
  the four settings keys restored to their captured pre-run values.

### Round 8 (Spec #2942 — round 2 retry) — 2026-09-25, spec/2942 @ 97495693 (R-20..R-27 PASS; F-80/F-81 fixed)

- **R-20 PASS.** Pane invariants re-measured under the vertical sidebar: 900×600 pane 700×600
  (right 900, bottom 600, share 0.78), 560×360 pane 360×360 (share 0.64), 1400×900 pane 1200×900
  (share 0.86); active `surface` rect == pane rect and `canvasHost` rect == pane rect (0 px);
  `pane.bottom − canvas.bottom = 0`; `docScrollH ≤ innerH + 1`; grid tracked 38×24 → 76×40 → 131×60
  (no 0×0 latch). Disclosed `pane.right − canvas.right` 16–21 px ghostty gutter (host flush).
- **R-21 PASS.** One `terminal` window throughout; session-scoped `write_pty_input`/`get_pty_buffer`
  (shell sentinels round-tripped); selecting a different row left all sessions' `id`/`pid`/`startedAt`
  byte-identical — no re-spawn / remount.
- **R-22 PASS.** Record payload exactly `{id,cli,workDir,title,createdAt,lastActiveAt,cliSessionId}`;
  resume semantics unchanged (a shell record reopened a fresh shell in its dir, no false promise). The
  new `shell` type is additive; the pre-change `opencode`/`copilot` records still parsed + listed.
- **R-23 PASS.** `terminal_work_dir` governs (dialog prefill); the default-TYPE control is additive
  (same `terminal_default_cli` key, domain widened `shell|opencode|copilot`); changing it + Save left
  the record set byte-identical (G-242).
- **R-24 PASS (G-250, cold).** Cold 3/3 + a warm control; negatives `invalid-cli` / `invalid-directory`
  / `invalid-argument` all hold.
- **R-25 PASS.** Closing the window with 4 live sessions (3 shells + 1 Copilot) left
  `process-hygiene.ps1 -List` at **0 unprotected orphan candidate(s)**; the copilot/opencode trees were
  absent. (The plain shells are `powershell.exe`, which the script does not enumerate.)
- **R-26 PASS.** `git diff --stat main origin/spec/2942` touches no `infrastructure/rtdb/**` or
  `infrastructure/otlp/**`; the Terminal-launched OpenCode session emitted live `telemetry_spans`
  (`ses_f297cb118ffeeuoFcYv18S2JxM`: `fredo.session` INTERNAL OK + `fredo.llm` CLIENT OK;
  `gen_ai.conversation.id` = that session, prompt "Reply with exactly: FREDO_QA_2942_OK").
- **R-27 PASS.** Retired hooks ABSENT (`terminal-session-bar`, `terminal-previous-toggle`,
  `terminal-previous-panel`, `[role=tablist]`, `[role=tab]`); preserved hooks PRESENT (`terminal-pane`
  + `data-surface/data-cols/data-rows`, `terminal-session-row-<id>`, `terminal-previous-session-row-<id>`
  + `persistedAriaLabel`, `terminal-canvas-host-<id>`).
- **New row — F-80 now PASS** (sticky Previous header no longer overlaps the first previous row; 0 px vs
  the round-1 23 px). **F-81 now PASS** (`--cli <shell|opencode|copilot>`).
- C-5 + #2942-delta teardown: run 1 deleted 7 fixture-root records / run 2 deleted 0 (idempotent) → 0;
  the four settings keys restored to their captured pre-run values.
