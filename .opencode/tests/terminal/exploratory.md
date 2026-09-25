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

### #2940 testing round 1 (spec/2940 @ 6a8b2c6d) — probe results

- **E-25 PASS (no promotion).** Rapid churn 560×360 → 600×400 → 1000×700 with the error surface
  rendered: pane flush at every step (`rightGap 0`, `bottomGap 0`), `pane.height == innerH−44`,
  `docScrollH == innerH`. Combined with F-54's 4-size sequence (cols/rows `98×37 → 131×43 → 60×21 →
  153×57`) the rail/pane never detached mid-resize and no 0×0 box ever latched.
- **E-26 PASS (no promotion).** Resizes while an `error` surface showed kept the pane filling the
  window at each size (560×316 / 600×356 / 1000×656) — a state surface never pinned a stale height.
- **E-27 PASS (no promotion).** 12 tabs at 560×360: `[role="tablist"]` `overflowX:auto`,
  `scrollWidth 1487` vs `clientWidth 453` (rail scrolls, never crushes the terminal); rail stayed
  `44 px`/`560 px`; pane stayed `560×316`; `+` and History pinned at the ends.
- **E-28 observation (no promotion).** With a real (non-fixture) record present plus fixture records,
  the newest fixture record was auto-selected and ordered first (`last_active_at DESC`) — the expected
  ordering, not a fault; the teardown removed only the fixture-root rows and left the real one.
- **E-29 partial (named reason).** Not driven by killing the dev instance mid-run (destructive +
  expensive). Crash-tolerance is instead evidenced by F-52's idempotence (2nd teardown deleted 0) and
  by the post-run residue read (0 fixture rows) after a run with ~40 spawns.
- **E-30 PASS (covered by F-44).** Light (`Light Default`) vs dark at 560×360: identical geometry, the
  rail re-tints, the canvas keeps its data palette, all chrome legible. (See the F-44 caveat on the
  light-leg method.)

## #2942 probes — vertical sidebar, rename, plain shell

> Seeded at triage for Spec #2942. Unscripted probes beyond the F-57..F-78 rows. A confirmed
> finding PROMOTES to `functional.md` (keep the origin note). Evidence is LIVE + MEASURED.

> **EARS map (Architect-authoritative):** E-31 → R-2.1/R-2.4; E-32 → R-2.2/R-2.5; E-33 →
> R-1.5; E-34 → R-5.1; E-35 → R-4.3; E-36 → R-3.2/R-5.2; E-37 → R-1.1/R-1.5; E-38 → R-2.4;
> E-39 → the theme-token NFR; E-40 → R-1.6 (the named fit risk). Published hooks/gates: see
> `functional.md` → "Requirement-ID reconciliation" (bind to either published form).

- [ ] E-31: **Rename while the session streams a large burst.** Rename mid-output. Does the
      rename dialog/field steal PTY focus, drop output, or end the session? A dropped buffer or a
      killed session promotes to F-63.
- [ ] E-32: **Rename → cross-surface consistency.** Rename a live session, then close/reopen, then
      `-Action Restart`. Do the live row, the previous row, and the record title stay consistent
      (never a stale/duplicated name)? An inconsistency promotes to F-62/F-64.
- [ ] E-33: **10+ sessions rapid churn at MIN.** At 560×360, add/close 10+ plain-shell sessions
      quickly. Does the sidebar keep scrolling (not the window), does the pane stay flush, and does
      the record list stay bounded (no orphan/twin)? Promotes to F-58.
- [ ] E-34: **Same-type identity for plain shells.** Create 2+ Terminal-type sessions in the same
      dir. Are their titles distinct (ordinal) and their records stable across reopen? A collision
      or renumber promotes to F-73.
- [ ] E-35: **Change the default type while a session runs.** With a session live, change the
      Settings default type + dir and Save; restart. Is the running session unaffected, and does
      only the NEXT new session adopt the default? A mutation of the live session promotes to F-72.
- [ ] E-36: **Plain-shell self-exit / close lifecycle.** Self-exit a shell (Ctrl-D / `exit`) and
      close another. Is the record retained + listed, is the window kept open while a peer lives,
      and are there zero orphans? Promotes to F-74/R-25.
- [ ] E-37: **Mixed-type sidebar at MIN.** With a shell + OpenCode + Copilot live at 560×360, do all
      rows stay compact (≤ published row height) and legible, and does the pane keep dominance?
      Promotes to F-57/F-58.
- [ ] E-38: **Rename a record that is resuming.** Trigger a resume, then rename the same record.
      Does the row keep `aria-current`, does the title update without aborting the resume, and is
      the id unchanged? Promotes to F-62/F-64.
- [ ] E-39: **Theme switch at MIN with the vertical sidebar.** Toggle light↔dark at 560×360 with
      sessions running. Any sidebar chrome that fails to re-tint or loses contrast promotes to
      N-25.
- [ ] E-40: **OpenCode TUI fit under stress (the ticket risk).** Spawn an OpenCode session, resize
      immediately (before the first byte), then resize during heavy output. Does the TUI fill the
      pane every time, or is a forced `resize_pty` ever required? A required manual `resize_pty`
      promotes to F-76 (the named risk).

## C-5 teardown (MANDATORY — run after this suite; BINDING, Architect C-5)

> **#2942 delta:** also snapshot/restore the default-TYPE key (published; fallback
> `terminal_default_cli`) and snapshot every pre-existing record's `{id → title}` (G-242). Full
> detail: `functional.md` → "Teardown delta for #2942".

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

### #2940 testing round 2 (spec/2940 @ a4b4dfa1) — probe results

- **E-21/E-22 (CLI path) CONFIRMED in round 2.** Cold `fredo open-terminal` now spawns
  (3/3 cold + warm 3/3) — the round-1 defect was a page-load-push race, fixed by the
  `b303ba9` pull handshake; one-shot semantics held across re-list + reload. No promotion.
- **E-5 (resize) / E-25 (resize churn) re-confirmed.** `98×37 → 60×21 → 153×57` across
  900×600/560×360/1400×900 with the host flush at every sample, active-only `resize_pty`.
  No promotion.
- **Transient-state sampling note (no promotion).** Capturing the slow-start hint and the
  `resuming` overlay requires bounded `tauri_webview_wait_for`/separate reads — an in-page
  `setTimeout` await wedges the webview (G-055, reconfirmed). Environment technique, not a
  product defect.
