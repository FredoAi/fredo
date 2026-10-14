# doom-loot — Exploratory Probes (Spec #3054)

> Unscripted edge/failure probes for the opportunistic loot policy + the adapter collection diff.
> The Tester works these AFTER the scripted functional/regression legs. A confirmed finding
> **promotes** to `functional.md` as a new `F-` row (keep the origin note). Leave `- [ ]` + a `FAIL`
> note with expected-vs-actual + repro on a confirmed defect.

## Prompt lines (probe, do not script)

- [ ] E-1: Steer direction sign — inject an in-range item in the `left`/`right` bucket; does
  `bucket_deflection` (`+DOOM_LOOT_NUDGE_DEGREES` left / `−DOOM_LOOT_NUDGE_DEGREES` right, relative
  to `H_route`) actually curve the path TOWARD the item over successive ticks (the off-route
  deflection shrinking), rather than away?
- [ ] E-2: Bucket-boundary oscillation — an item sitting near the ±45° `front` boundary while the
  player turns: does the policy settle onto a heading, or does it oscillate without ever reaching
  the item? Is any thrash possible, or is it bounded per tick by the seek window?
- [ ] E-3: Two in-range items — a nearer `left` item plus a `front` item: which does `loot_target`
  select, is the choice deterministic across identical observations, and does the choice change when
  the nearer one is collected (route/seek resume)?
- [ ] E-4: Item leaves the observation mid-seek — inject an in-range item, then withdraw the
  injection on a later tick (the merge replaces the whole `items` key): does the steer stop on the
  next tick, or is a stale seek action issued?
- [ ] E-5: Seek window expiry / re-release — let a seek run past `DOOM_LOOT_SEEK_WINDOW_TICKS`:
  does the route resume with NO re-chase of the SAME item signature, and does a CHANGED signature
  (item collected/added) release the block?
- [ ] E-6: Unreachable pickup (blocked geometry) — place the player so the in-range item is behind a
  wall: does the seek window expire cleanly with the route resuming (no wedge, no infinite forward),
  and does the blocked signature prevent an immediate re-chase?
- [ ] E-7: Loot vs escape while wedged — pin the player against a wall so `no_move_ticks` reaches
  `DOOM_ESCAPE_STUCK_TICKS`=12 with an in-range item injected: does loot yield entirely (no loot
  action) during the escape window, and resume after?
- [ ] E-8: Loot vs combat — inject both an in-range item and a `front` `enemies[]` entry: is loot
  skipped (combat only), and is combat's composed action order unchanged?
- [ ] E-9: Counter fidelity — with ≥2 real pickups collected, is `/level/itemsCollected` cumulative
  and monotonic, and on `reset`/map-load does it clear to `0` with no cross-map carry-over?
- [ ] E-10: Dead-counter non-vacuity — assert `level.items`/`item_count` stays `0` across a run in
  which `itemsCollected` climbs: confirm no AC/counter is bound to the dead field.
- [ ] E-11: Weapon set idempotence — collect an already-owned weapon: does `player.weapons` stay
  unchanged (idempotent), and does `player.weapon` (ready weapon) stay put unless switched?
- [ ] E-12: Determinism under load — run `run_bounded_driver` twice with an identical script at a
  busy E1M1 scene: is the `DoomDriverReport` + the loot decision sequence byte-identical, or does an
  iteration-order (HashSet) artefact leak into `observe_collection`/`loot_signature`?
- [ ] E-13: Malformed `items` injection — inject a non-array `items` or entries missing
  `direction`/`distance`: does the loot layer stay inert without a panic and without disturbing the
  retained reflex/combat/plan chain?
- [ ] E-14: Rapid open/close of the `doom` window during an active seek — is teardown bounded with
  no orphan thread and no console error (G-263)?
