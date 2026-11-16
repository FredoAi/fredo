# doom-observation-geometry — Exploratory Probes (Spec #3030)

> Unscripted edge/failure probes for the additive wall/obstacle observation geometry. The Tester
> works these AFTER the scripted functional/regression legs. A confirmed finding **promotes** to
> `functional.md` as a new `F-` row (keep the origin note). Leave `- [ ]` + a `FAIL` note with
> expected-vs-actual + repro on a confirmed defect.

## Prompt lines (probe, do not script)

- [ ] E-1: What does the geometry field look like in a WIDE-OPEN room vs a corridor vs a
  dead-end? Does the count track walls, or does it saturate at the bound?
- [ ] E-2: Turn 90°/180° at a fixed position — does the forward near/blocked signal flip
  exactly with facing, or is there an off-by-one/stale-frame artifact?
- [ ] E-3: Approach a wall from an angle so the player SLIDES along it — does forward-near stay
  true while lateral motion continues, and does the geometry update every step?
- [ ] E-4: Stand in a doorway with the door CLOSING/OPENING — is the door counted as a wall, a
  door, or both, and does the geometry double-count?
- [ ] E-5: With `FREDO_DOOM_FAIL_PERCEPTION=1`, does anything else in the observation degrade
  (player/enemies/items/doors/exit), or only the geometry field?
- [ ] E-6: Toggle `FREDO_DOOM_FAIL_PERCEPTION` without restarting — does the fallback restore
  cleanly, or is the buffer accessor cached/stale?
- [ ] E-7: Fill the scene with many enemies+items+walls — does the observation payload stay bounded,
  and does the model request audit JSONL stay within the budget?
- [ ] E-8: A long autoplay run — does the observation payload grow monotonically (a leak), or stay
  constant per scene?
- [ ] E-9: Does the geometry consume a wall-clock/RNG input (non-deterministic across two identical
  resets)? Compare two `reset`→read sequences byte-for-byte.
- [ ] E-10: Any interaction with the safety reflex (`agent.rs`) — does the reflex read the new
  geometry, or only the existing fields? (Regression risk if the reflex's blocked-forward heuristic
  double-counts.)
