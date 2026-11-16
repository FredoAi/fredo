# doom-companion-combat — Exploratory Probes (Spec #3053)

> Unscripted edge/failure probes for the engagement / aim-fire / low-health-disengage policy. The
> Tester works these AFTER the scripted functional/regression legs. A confirmed finding
> **promotes** to `functional.md` as a new `F-` row (keep the origin note). Leave `- [ ]` + a
> `FAIL` note with expected-vs-actual + repro on a confirmed defect.

## Prompt lines (probe, do not script)

- [ ] E-1: Aim direction sign — inject a `left` bucket enemy at a range where Doom's hitscan
  autoaim needs the residual; does `turn-left` actually rotate the facing TOWARD the enemy (not
  away), i.e. does the bucket flip `left`→`front` rather than `left`→`back` over successive ticks?
- [ ] E-2: Oscillation at the bucket edge — an enemy sitting near the ±45° `front` boundary while
  the player turns: does the policy settle into fire, or can it oscillate `turn-left`/`turn-right`
  without ever firing? Is there any hysteresis, or is the bucket flip-flop bounded per tick?
- [ ] E-3: Multiple enemies — a `front` target plus a nearer `left` target: which does
  `combat_target` select, and is the choice deterministic across identical observations? Does the
  selection prefer `front` (fire) over a nearer side target (aim)?
- [ ] E-4: Target leaves the arc mid-fire — inject a `front` enemy, then withdraw the injection on
  a later tick (the merge replaces the whole `enemies` key): does the `shoot` stop on the very next
  tick, or is a stale shot issued? Does `engagements` stop climbing?
- [ ] E-5: Low-health boundary — set `FREDO_DOOM_COMBAT_LOW_HEALTH` so the live `player.health`
  sits exactly ON the threshold: does it disengage or engage, and does that match
  `health <= threshold`? Then nudge +1 and confirm the flip, with no oscillation across ticks.
- [ ] E-6: Disengage retreat into a wall — force disengage against a rear wall: does the bounded
  `backward` get replaced by the reflex's blocked-forward handling, and does the companion still
  stop firing (AC3 must not be defeated by the blocked-forward override)?
- [ ] E-7: Escape vs combat while wedged — pin the player against a wall with a front enemy
  injected so `no_move_ticks` reaches `DOOM_ESCAPE_STUCK_TICKS`=12: does the companion briefly stop
  firing to unstick (#3031), and does it RESUME firing once free, or does it stay disengaged?
- [ ] E-8: Inject a malformed `enemies` patch (non-array, or entries missing `direction`): does the
  layer stay inert without a panic, and does `safety_reflex` remain conservative (no fire)?
- [ ] E-9: `FREDO_DOOM_COMBAT_LOW_HEALTH` with a blank / non-numeric / huge value — is the fallback
  the default 25 (inert), and does the shipped default path stay byte-identical when unset?
- [ ] E-10: Determinism under load — run `run_bounded_driver` twice with an identical script at a
  busy E1M1 scene (with an injected real `enemies` state if possible): is the `DoomDriverReport`
  byte-identical including `kills`/`engagements`, or does an iteration-order artefact leak in?
- [ ] E-11: AC2 `kills` sourcing — with a synthetic observation whose `level.kills` is non-zero but
  no engagement happened (e.g. an earlier kill), does `DoomAutoplayStatus.kills` faithfully mirror
  `/level/kills` rather than the engagement count (i.e. `kills` is engine-sourced, `engagements` is
  policy-sourced)?
- [ ] E-12: Rapid open/close of the `doom` window during an active engagement/fire — is teardown
  bounded with no orphan thread and no console error (G-263)?
