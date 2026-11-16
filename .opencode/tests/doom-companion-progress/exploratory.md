# doom-companion-progress — Exploratory Probes (Spec #3031)

> Unscripted edge/failure probes for the unstick/escape + bounded local-locomotion policy. The
> Tester works these AFTER the scripted functional/regression legs. A confirmed finding **promotes**
> to `functional.md` as a new `F-` row (keep the origin note). Leave `- [ ]` + a `FAIL` note with
> expected-vs-actual + repro on a confirmed defect.

## Prompt lines (probe, do not script)

- [ ] E-1: Freeze the player in a DEAD-END vs a CORNER vs a WIDE-OPEN room — does `escape_direction`
  pick a sane heading each time, and does a corner re-route after `DOOM_ESCAPE_REROUTE_AFTER`=2
  empty escapes rather than oscillating between the same two headings?
- [ ] E-2: Which sign convention does `escape_heading` actually use for `left`/`right`
  (`(angle+270)%360` vs `(angle+90)%360`)? Turn 90° both ways and confirm the escape moves TOWARD
  increased clearance, not into the wall it is fleeing.
- [ ] E-3: A locomotion-free intent of every shape — `shoot`-only, `turn-to`-only, empty `actions` —
  does the injected `DOOM_LOCAL_FORWARD_AMOUNT` burst fire in each, and does position change within
  `DOOM_ESCAPE_STUCK_TICKS`=12?
- [ ] E-4: A front enemy present during a freeze — is the escape maneuver ever SUPPRESSED (the old
  `safety_reflex` drops `forward` when blocked; does the new escape over-ride that correctly), or does
  the `shoot`-drop and the escape fight each other?
- [ ] E-5: Drive a decision `{"delayMs":N}` for increasing N (200 ms, 2 s, 10 s) — does the issued
  locomotion gap stay at the declared **1 tick** bound, and does `stuckTicks` stay 0 while the local
  burst keeps the player moving?
- [ ] E-6: `{"stall":true}` past `timeout_ticks` (≈1072) — does the degrade fire exactly once, is
  `consecutiveFailures`/`degraded` correct, and does the local policy keep moving during the degrade
  window, or does it stall at the abandon boundary?
- [ ] E-7: Error mid-flight then recovery — `{"error":...}` for N decisions, then good decisions; does
  `degraded` clear back to false and does the cadence return from degraded to nominal?
- [ ] E-8: Reach the terminal exit WHILE a decision is still pending (R4 lever + a `delayMs` in
  flight) — does the terminal branch win with NO further step issued on the exited level?
- [ ] E-9: `outcome:"dead"` vs `outcome:"exited"` at the same tick (death and exit precedence) — is
  the precedence deterministic and are the status fields consistent with the driver `terminal`?
- [ ] E-10: Budget edge — a run that reaches `DOOM_CONTINUOUS_MAX_TICKS` within a tick or two of an
  exit: does it settle as `budgetExhausted` cleanly, and is `escapes`/`decisions` still reported?
- [ ] E-11: Toggle the `FREDO_DOOM_FORCE_EXIT` lever OFF and re-run — is the terminal path completely
  absent (production path unchanged / inert when unset), i.e. no residual exit induction?
- [ ] E-12: Determinism under load — run `run_bounded_driver` twice with an identical script and a
  busy scene; is the `DoomDriverReport` byte-identical including `escapes`, or does an ordering/
  iteration artefact leak in?
- [ ] E-13: Rapid open/close of the `doom` window during an escape maneuver or a degraded run — is
  teardown bounded with no orphan thread and no console error?
