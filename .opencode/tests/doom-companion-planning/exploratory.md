# doom-companion-planning — Exploratory Probes (Spec #3039)

> Unscripted edge/failure probes for the plan-ahead + doors-first-class + richer forward sensing
> slice. The Tester works these AFTER the scripted functional/regression legs. A confirmed
> finding **promotes** to `functional.md` as a new `F-` row (keep the origin note). Leave `- [ ]`
> + a `FAIL` note with expected-vs-actual + repro on a confirmed defect.

## Prompt lines (probe, do not script)

- [ ] E-1: A plan whose steps are individually too SHORT to make progress (e.g. many 1-tic
  `forward` steps) — does the tick-by-tick executor still advance the plan index correctly, or
  does it stall / drop steps?
- [ ] E-2: A plan that requires a TURN then a move — does the executor sequence them in
  order (never issue the move before the turn closes), and does `turn-to` (`actions.rs:58`)
  complete before the next step?
- [ ] E-3: A plan that diverges on TWO triggers at the same tick (blocked≥4 AND a new front
  enemy) — is the re-plan reason deterministic and precedence-stable across repeats?
- [ ] E-4: A re-plan that returns a byte-identical plan — is the re-plan bounded (no storm), and
  is `replans` still bumped once (not per tick)?
- [ ] E-5: Doors: an `OpenDoor` step at a door that is already `waiting` — does the loop proceed
  IMMEDIATELY (no wasted wait), and does it still count as the step? (Probe the `opening`→
  `waiting` transition edge.)
- [ ] E-6: Doors: an `OpenDoor` step at a door that re-closes before the player passes
  (`state=="closing"`) — does the loop re-press `use` or re-plan (per the pinned policy), and is
  the bound respected?
- [ ] E-7: Doors: the bounded wait elapsing exactly at the map's door-wait boundary — does the
  step abort + re-plan cleanly, or does it hang at the boundary?
- [ ] E-8: `FREDO_DOOM_FAIL_PERCEPTION=1` during a plan run — does the observation fall back to
  `[]` without panicking, and does the plan executor degrade gracefully (not re-plan-storm)?
- [ ] E-9: A plan exhausted exactly at a door (last step is `OpenDoor`) — is `planExhausted` the
  re-plan reason, and does the door wait still bound?
- [ ] E-10: Plan + death — the player dies mid-plan; does the reset clear the plan/step index and
  the divergence counters (no stale step re-issued on the fresh level)?
- [ ] E-11: Plan + terminal exit reached before the plan completes — does the terminal branch win
  with NO further plan step issued on the exited level, and is `completed:true` set at the final
  level?
- [ ] E-12: Determinism under load — run `run_bounded_driver` twice with an identical plan script
  and a busy scene; is the `DoomDriverReport` byte-identical including `replans`, or does an
  ordering artefact leak in?
- [ ] E-13: Rapid open/close of the `doom` window during a plan execution or a door wait — is
  teardown bounded with no orphan thread and no console error?
