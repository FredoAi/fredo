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
  rendering artifact at extreme sizes (min bounds)?

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
