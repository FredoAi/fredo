# Terminal — Exploratory Test Suite

Feature domain: `terminal` (renamed Run CLI surface, multi-session). Unscripted edge/failure
probes for Spec #2934. Run beyond the scripted functional cases. A confirmed finding
PROMOTES to `functional.md` as a new `F-` row (keep the origin note).

Conventions: ID prefix `E-`. Record expected vs actual; mark `FAIL` with repro if behavior
is wrong.

## Probe prompts

- [ ] E-1: **Add-session during startup.** Open a session, then immediately add another
  while the first is still `starting`. Does the sidebar show a stable `starting` state for
  each, or do states cross/duplicate? A state attached to the wrong session is a FAIL
  (promotes to F-6/F-7).

- [ ] E-2: **Rapid add/close churn.** Add → close → add → close quickly for both CLIs. Any
  leaked session record, PID, or window? Any stale sidebar item? Any orphan
  (`process-hygiene.ps1 -List`)? Orphans promote to F-19/F-20.

- [ ] E-3: **Switch during heavy output.** While session A streams a large burst, switch to
  B and back. Any dropped/lost output in A's buffer, any garbled canvas, any re-spawn?

- [ ] E-4: **Same-CLI concurrency.** Two OpenCode sessions and two Copilot sessions at
  once. Does each buffer stay isolated? Any cross-session sentinel bleed? Any shared-state
  corruption in the status/dir display?

- [ ] E-5: **Resize the active session only.** Resize the window with B active, then
  switch to A; confirm A's PTY dims did not change. Then resize with A active. Any
  rendering artifact at extreme sizes (min bounds)? CONFIRMED (round 3, `spec/2934 @ 7ba5a99c`,
  FX-5): a `tauri_manage_window resize` with B active pushed `resize_pty` for **B only**
  (B 80×24→99×8→82×8; A stayed 71×4 across both resizes); activation re-fit A on select with
  B untouched; both buffers still rendered. Live **minimise**/0×0 could not be driven (bridge
  plugin < 0.13) — covered by the `SessionTerminal.resize.test.tsx` 0×0 pin. Observation
  (pre-existing, not R-2.4): the pane is ~126 px tall in a 780 px window (content-sized
  `#root`, sidebar-driven) — same in round-2 `r2-ac2-switch-opencode.jpeg`.

- [ ] E-6: **Session self-exit while unselected.** While B is active, let A exit on its
  own. Does A's sidebar item disappear cleanly (no ghost), does B keep streaming, does the
  window stay open?

- [ ] E-7: **Close the window mid-switch.** Close the `terminal` window at the instant of a
  sidebar switch. Any orphan, stale window, or wedged state?

- [ ] E-8: **Copilot `.cmd` shim resolution.** If a GitHub session fails to spawn, capture
  whether the resolved launcher is the `.cmd` shim and whether it was run through the
  command interpreter (compare with `.opencode/scripts/copilot-otel-probe.ts:195-210`). A
  spawn failure masquerading as an auth error is a FAIL (promotes to F-13/F-17).

- [ ] E-9: **Prerequisite detection scope on a machine without `pwsh`.** The check's message
  must name PowerShell 6+ and the requirement; a generic "failed to launch" is a finding
  (promotes to F-16). CONFIRMED (round 2, `spec/2934 @ a656a020`): the gate is correctly
  SCOPED to the `.ps1` launch form — a native `.cmd`-resolved Copilot no longer triggers it
  (F-13 PASS), and the TEST-ONLY `testOverride:{pwshMajor:5}` still forces the message
  "GitHub Copilot requires PowerShell 6 or newer (pwsh). …" within 1.3 s (F-16 PASS). A
  blanket gate that rejected a `.cmd` launch (round-1 defect) is gone.

- [ ] E-10: **Legacy key left behind.** After migration, does the legacy key remain with its
  old value? Does changing it (only) affect Terminal (it must NOT — F-5)? Does the new key
  get written eagerly or lazily (record the behavior)?

- [ ] E-11: **`localStorage` shadowing.** Set `run_cli_work_dir` in `localStorage` only (no
  SQLite) and launch. Which value wins? Migration correctness under this shadow is a
  finding (promotes to F-4).

- [ ] E-12: **Default-CLI edge values.** Persist an invalid value for the default CLI; open
  the prompt. Does it fall back safely (no crash, no empty preselection)?

- [ ] E-13: **Theme legibility.** Check the new sidebar/menu/error chrome in BOTH light and
  dark themes. Any hardcoded color or unreadable text is a FAIL (promotes to N-4).

- [ ] E-14: **Accessibility pass.** Tab through the sidebar + add-session menu; activate by
  keyboard. Any unreachable control, missing label, or focus trap is a FAIL (promotes to
  N-8).

- [ ] E-15: **Error surface recoverability.** From each R-4 error state, Retry after
  restoring the condition, and Close. No window double-open, no stuck spinner, no orphan.

- [ ] E-16: **Memory/stability over a long multi-session run.** Keep 2+ sessions alive with
  steady output for an extended period; watch for unbounded growth, console errors, or a
  wedged bridge.

## #2935 probes — persistence, resume, CLI

- [ ] E-17: **Close the window at the instant of a resume.** Does the record survive (resumable), is
      the fresh PTY reaped, and is the list consistent on reopen? A ghost PTY or a lost record is a
      finding (promotes to F-24/F-27).
- [ ] E-18: **Resume a record while the CLI is mid-upgrade / slow to first byte.** Does the resume
      bound hold (≤10 s to a message or output) or hang? A hang promotes to F-24/N-10.
- [ ] E-19: **Record growth over repeated close/reopen/resume cycles.** Cycle A through
      close→reopen→resume 5×: does the record count grow unboundedly (a twin per cycle) or stay at 1?
      Growth = an identity defect (G-242 taste) → F-24/F-25.
- [ ] E-20: **Two records with the same CLI + workDir.** Do they remain distinguishable (title
      ordinal, stable ids) on reopen, and does resume pick the RIGHT one (per-record sentinel)?
- [ ] E-21: **`fredo open-terminal` while the window is showing an error state.** Does it focus the
      window, start a session, or wedge? Record the defined behavior (feeds R-3.1's edge).
- [ ] E-22: **Concurrent/rapid `fredo open-terminal` invocations with different `--cli`/`--dir`.**
      Duplicate windows? Lost responses? Two sessions in one window? Record.
- [ ] E-23: **Delete a record whose workDir was deleted, then resume it.** Does the remove succeed
      cleanly and the resume land on F-32's `invalid-cwd` path (not a wrong dir)?
- [ ] E-24: **Restart mid-resume.** Kill the app during a resume; on restart, is the record still
      listed and resumable (no half-record, no orphan)?

## #2940 probes — full-height composition + fixture isolation

- [ ] E-25: **Rapid resize churn.** Drag/resize the `terminal` window through many intermediate
      sizes (including past the min bound) while a session streams. Does the pane stay flush
      (no dead band) at every size, does the canvas thrash/reflow, and does the ACTIVE PTY
      receive exactly one `resize_pty` per settled size (no per-event churn)? A pane that
      detaches from the window edge mid-drag promotes to F-38/F-39.
- [ ] E-26: **State crossings during a resize.** Resize while `starting`, while an error
      surface shows, and while `resume-blocked` shows. Does the pane keep filling the window
      (F-41) or does a state surface pin a stale height? A surface that shrinks the pane
      promotes to F-41.
- [ ] E-27: **Tab-rail stress at min size.** At 560×360, populate many sessions (10+) and long
      work dirs/titles. Does the `SessionBar` tab rail stay subordinate and scroll
      (`overflow-x:auto` — never push the pane to 0 width, never clip the terminal to a dead
      band)? Promotes to F-42/F-43.
- [ ] E-28: **Real vs fixture record coexist.** With a real pre-existing record present, run a
      terminal suite and check whether the suite's fixtures interleave with the real record
      (ordering, auto-selected newest, delete focus-fall). A fixture record outranking the
      developer's real record promotes to F-51.
- [ ] E-29: **Teardown ordering / crash mid-suite.** Abort the terminal suite mid-run (kill the
      dev instance) and re-check the record list. Does a partial run leave fixture records
      that a clean run would have torn down? Promotes to F-52 (teardown must be
      crash-tolerant or the run must record the residual).
- [ ] E-30: **Theme switch at min size.** Toggle light↔dark while at 560×360 with sessions
      running. Any canvas/ghostty surface or sidebar chrome that fails to re-tint, or any
      text that loses contrast against the new background, promotes to N-18/F-43.

## C-5 teardown (MANDATORY — run after this suite; BINDING, Architect C-5)

> Suite-side, no product change. Run in the `terminal` window via `tauri_webview_execute_js`
> after every run; then restore the four settings keys. Deletes every persisted record whose
> `workDir` is under the in-repo fixtures root. Full detail: `functional.md` →
> "C-5 teardown / snapshot / settings-restore".

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
- Cross-suite repeat: `.opencode/tests/run-cli/regression.md`.
