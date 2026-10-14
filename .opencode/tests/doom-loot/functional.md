# doom-loot — Functional Test Cases (Spec #3054)

> Durable functional suite (feature domain `doom-loot`). One `- [ ]` case per requirement;
> observable expected outcome per case. Formalizes the Implementation Plan #3054 `### QA Plan`.
> This domain covers the **opportunistic looting** slice: a pure `loot` policy
> (`applications/doom/loot.rs`) that selects an in-range pickup from the bounded `items[]` intel,
> steers to it (bounded `turn-to` + `forward`), self-bounds via a seek window, and yields to
> escape (#3031) and combat (#3053); plus the additive observables `level.itemsCollected`
> (adapter-side `MobjFlag::Special`-id diff) and `player.weapons` (projected from `weapon_owned`),
> the run-status counter `itemsCollected`, and the deterministic engine loop
> (`applications/doom/agent.rs` `run_continuous_loop_with_writer`, step 3c) / driver
> (`engine.rs:655 run_bounded_driver`) as the observables.
>
> **Verification policy: live** — an in-process engine loop plus a rendered status surface; NOT
> provable by pure unit logic alone. The tester's Evidence MUST reference `telemetry_spans`
> (NON-ZERO count + recent `max(ingested_at)`), **DISCLOSED: the Doom native loop emits no OTLP
> span — the query proves the live pipeline, not the feature** — and/or a live webview receipt
> (`upload-evidence` … a `https://github.com/user-attachments/...` URL embedded in the single
> `## Tests Runs` comment). A static-only PASS is a FALSE PASS (G-033).
>
> **DEAD observable.** `level.items` / `PlayerState.item_count` is a DEAD producer in pinned
> `neurodoom 0.6.7` (Architect Part A A1; PO amendment). **NO case below binds to it** — it may be
> read only to prove it stays `0` (edge of F-4). The AC2 primary observable is the additive
> `level.itemsCollected`.
>
> **AC2 is TIERED (G-275/G-300).** (a) The **loot decision/steer layer** is drivable by
> `FREDO_DOOM_INJECT_OBSERVATION` on the real engine — this validates the DECISION, not the
> counter. (b) The **adapter `Special`-id diff** needs a pickup ACTUALLY collected on a real level.
> **The AC2 LIVE proof is the real drive (F-3/F-4); the unit pin (F-5) is CORROBORATION ONLY.**
>
> **No wall-clock flakiness (G-316).** Determinism rows are STEP-DRIVEN through
> `run_bounded_driver` + `FixedTickClock`, never asserted on raw wall-clock timing.
>
> **Determinism (NFR-DET, hard).** `loot.rs` is a pure function of the observation + persisted
> policy: no RNG, no wall clock; every action is bounded per tick.
>
> **Scratch:** `.opencode/tmp/3054/`. Env overrides via the `dev-environment` skill.

## Named constants / literals (from the Architect's BINDING NAMES BLOCK, B.4; **B.7.2 supersedes B.4 on the ST-3/ST-4 surface** — do not rename)

`DOOM_LOOT_ACQUIRE_RANGE` (=512), `DOOM_LOOT_SEEK_WINDOW_TICKS` (=24), `DOOM_LOOT_FORWARD_AMOUNT`
(=10), `DOOM_LOOT_NUDGE_DEGREES` (=30). Types: `DoomLootPolicy{seek_ticks:u32,
blocked_signature:Option<u64>}`, `LootTarget{kind, direction,distance}`, `LootIntent{target,actions}`.
Functions: `loot_target`, `loot_intent`, `loot_signature` (FNV-1a over the sorted `items[].kind`
**multiset** — position/distance-invariant; B.7.3), `bucket_deflection(direction) -> Option<i64>`
(`0` front / `+DOOM_LOOT_NUDGE_DEGREES` left / `−DOOM_LOOT_NUDGE_DEGREES` right / `None` back ⇒ loot
suppressed — **supersedes `loot_heading`**, B.7.2). Observation:
`level.itemsCollected` (int, per-world cumulative), `player.weapons` (string[], slot order).
Status: wire `itemsCollected`; Rust `DoomAutoplayStatus.items_collected`; TS
`DoomAutoplayStatus.itemsCollected`. Weapon vocabulary (kebab): `fist`, `pistol`, `shotgun`,
`chaingun`, `rocket-launcher`, `plasma-rifle`, `bfg`, `chainsaw`, `super-shotgun`; baseline
`player.weapons == ["fist","pistol"]`. Reserved loot-HUD testid `doom-loot-hud`.

## R-1 / AC1 — reachable pickup ⇒ steer + collect + resume

- [ ] F-1 (R-1, AC1, REQUIRED, pure) **An in-range pickup yields a deterministic loot target and
  a bounded, route-aligned deflection (`turn-to` at `H_route + bucket_deflection` + `forward`).**
  - EXPECTED: `loot_target(<obs with items:[{direction:"front",distance:100}]>, policy) ==
    Some(LootTarget{kind, direction:"front", distance:100})`; `loot_intent(...)` returns `Some`
    with `actions` = one `turn-to` at `H_route + bucket_deflection(dir)` + one `forward` whose
    `amount == DOOM_LOOT_FORWARD_AMOUNT`. `bucket_deflection("front")==Some(0)`,
    `"left"→Some(+DOOM_LOOT_NUDGE_DEGREES)`(=+30), `"right"→Some(−DOOM_LOOT_NUDGE_DEGREES)`(=−30),
    `"back"→None` (loot suppressed). A `front` target ⇒ the composed `turn-to` angle is
    `H_route + 0` ⇒ the route's own turn is retained, never cancelled (B.8).
  - Edge: `distance == DOOM_LOOT_ACQUIRE_RANGE`=512 accepted vs `513` → `None`; absent/non-array
    `items` → `None`; malformed entry (missing `direction`/`distance`) skipped without panic; two
    in-range entries → first-listed wins; each of the four buckets; a bogus `direction` ⇒
    `bucket_deflection` `None`.

- [ ] F-2 (R-1, AC1, live, decision/steer leg) **An injected in-range `items[]` makes the real run
  carry a route-aligned loot `turn-to` (route steering retained as the effective bearing) every
  tick a target is in range.** Recipe **L1**.
  - EXPECTED: with `FREDO_DOOM_INJECT_OBSERVATION={"items":[{"kind":"health","direction":"front",
    "distance":100}]}` the step-3c composed action set is `loot_actions ++ base` (the loot actions
    are **PREPENDED before `base`**; B.8.1) and CARRIES a loot `turn-to` at
    `H_route + bucket_deflection(dir)` (`H_route` = the angle of the LAST base `turn-to`; fallback
    `/player/angle`) plus a bounded `forward` (`DOOM_LOOT_FORWARD_AMOUNT`); the base route's own
    `turn-to`/`forward` is RETAINED and — because `build_player_action` takes the LAST `turn-to` —
    the route's `turn-to` REMAINS THE EFFECTIVE BEARING (the deflection is ADVISORY on a steering
    route; a `front` target ⇒ angle `H_route + 0` ⇒ the route turn is applied unchanged, never
    cancelled), while the loot `turn-to` is EFFECTIVE only when `base` has no `turn-to`
    (legacy/local `Hold`). It fires EVERY tick a target is in range (NOT only when `base` has no
    `turn-to`). An unset-env control issues none.
  - Edge: the lever top-level-merges ⇒ **replaces the WHOLE `items` key** (no real Specials visible
    on this leg); `items:[]`; lever unset ⇒ byte-identical production; loot suppressed while
    escaping or a combat target is present (F-10); a `back` bucket ⇒ `bucket_deflection` `None` ⇒
    no loot `turn-to`. **This validates the DECISION, not the counter.**

- [ ] F-3 (R-1, AC1, REQUIRED, live) **A real pickup is walked over and the route resumes.**
  Recipe **L2**.
  - EXPECTED: a deterministic scripted drive walks the player over a real E1M1 `MobjFlag::Special`
    (its bearing read live from `items[]` via `doom_read_state`) ⇒ that entity vanishes from
    `items[]` and the loot steer stops (the route resumes) within ≤ `DOOM_LOOT_SEEK_WINDOW_TICKS`.
  - Edge: pickup behind (`back`); pickup at the acquire-range boundary; two stacked pickups (both
    collected); an unreachable (blocked) pickup ⇒ the seek window expires, route resumes, no thrash.

## R-2 / AC2 — the run status `itemsCollected` counter climbs 0 → ≥1

- [ ] F-4 (R-2, AC2, REQUIRED, **live — AC2 LIVE PROOF**) **A real collection increments
  `itemsCollected`.** Recipe **L2**.
  - EXPECTED: on a real bounded run that collects a Special, `doom_read_state`
    `/level/itemsCollected` climbs `0 → ≥1` (per-world cumulative, monotonic) AND
    `get_doom_autoplay_status.itemsCollected` mirrors it `0 → ≥1`; the incrementing tick is the
    tick a Special id vanishes from the world. **Tier: the real engine drive (F-3/F-4) is the AC2
    live proof.**
  - Edge: the counter never decreases; it clears to `0` on `reset`/map-load (new world ⇒ fresh id
    namespace); ≥2 distinct pickups ⇒ cumulative (not reset); a run collecting nothing ⇒ stays `0`
    (never fabricated); `level.items` stays `0` across the run (**asserted only to prove it is
    non-binding**).
  - **Named-blocker rule:** if NO genuine collected-pickup drive is reachable in the tester's
    sandbox, mark F-4 as a named blocker (G-172/G-275) with F-5 as the only corroboration — do NOT
    pass it on injection alone.

- [ ] F-5 (R-2, AC2, unit pin — **CORROBORATION ONLY, never the AC2 live proof**) **The adapter
  diff state counts vanished `Special` ids.**
  - EXPECTED: `DoomSession.observe_collection` (or its pure helper) given a prior
    `last_special_ids = {A,B}` and a current live set `{A}` ⇒ `items_collected += 1` and the set
    becomes `{A}`; a second call with `{A}` ⇒ no change; `reset` clears the set and zeroes the
    count. Corroborates F-4 at unit level.
  - Edge: empty prior set (first observation ⇒ `0`); multiple vanished ids (Δ = count); ids never
    re-appear (`world.remove` is permanent); a new world after reset ⇒ fresh id namespace, no
    cross-map counting.

## R-3 / AC3 — the weapon set reflects acquisition

- [ ] F-6 (R-3, AC3, REQUIRED, live/unit) **`player.weapons` reflects a collected weapon pickup.**
  Recipe **L2**.
  - EXPECTED: baseline `player.weapons == ["fist","pistol"]` (slot order); after a real weapon
    pickup (e.g. the E1M1 `shotgun`) is collected, `doom_read_state` `player.weapons` contains
    `"shotgun"` in slot order, and `player.weapon` (ready weapon) is unchanged unless deliberately
    switched. LIVE producer `give_weapon`→`grant_weapon`.
  - Edge: each of the nine names uses the exact kebab vocabulary; a second pickup of an owned weapon
    ⇒ set unchanged (idempotent); `false` slots omitted; collecting a weapon also increments
    `itemsCollected` (F-4).

- [ ] F-7 (R-3, AC3, REQUIRED, unit pin) **The `player.weapons` projection is pure and
  slot-ordered.**
  - EXPECTED: the projection iterates `weapon_owned` in slot order via the existing `weapon_name`
    (`engine.rs:1576-1588`); baseline `[true,true,false×7]` ⇒ `["fist","pistol"]`; flipping one
    slot ⇒ that name appears at its slot index; additive (no existing observation key/order/serde
    name renamed).
  - Edge: all-false ⇒ `[]`; all-true ⇒ all nine in enum order; no source other than `weapon_owned`
    used.

## R-4 / AC4 — opportunistic: never abandon the route to the exit

- [ ] F-8 (R-4, AC4, REQUIRED, pure) **The loot policy is opportunistic and bounded (no thrash).**
  - EXPECTED: `loot_target` returns `None` when no `items[]` entry is ≤ `DOOM_LOOT_ACQUIRE_RANGE`;
    `loot_intent` increments `seek_ticks` and at `DOOM_LOOT_SEEK_WINDOW_TICKS` records
    `blocked_signature = loot_signature(obs)` and returns `None` (route resumes); the SAME item
    signature is never re-chased while blocked; a changed signature releases the block.
  - Edge: a far item (> acquire range) → `None`; a target that becomes unreachable mid-seek;
    `loot_signature` stable across ticks with identical `items`; FNV-1a deterministic.

- [ ] F-9 (R-4, AC4, REQUIRED, live) **Loot never re-plans and never abandons the route.**
  Recipe **L2**.
  - EXPECTED: with loot active, `status.replans` and `dataset.execution.replans[]` are identical to
    a loot-blocked control run; the loot actions are **PREPENDED before** the route action
    (`effective = loot_actions ++ base`, B.8.1), so the route's `turn-to`/`use` is RETAINED and
    remains the **effective bearing** — the loot deflection is ADVISORY on a steering route and
    EFFECTIVE only when `base` has no `turn-to` — and the route bearing is never perturbed
    (`st8`/`#3039` unregressed); `plan_index` still advances; `outcome`/`level.map` progression
    unaffected.
  - Edge: a route with no pickups (loot inert ⇒ tick sequence byte-identical, F-13); a pickup
    directly on the route (collected with no detour); an off-route pickup within range (bounded
    detour then route resumes).

- [ ] F-10 (R-4/R-5, AC4/AC5, REQUIRED, pure/live) **Precedence — loot yields to escape (#3031)
  and combat (#3053).**
  - EXPECTED: while escaping (escape window active OR `no_move_ticks >= DOOM_ESCAPE_STUCK_TICKS`=12)
    no loot action is composed; when `combat::combat_target(observation).is_some()` loot is not
    consulted; loot is composed AFTER combat so combat's action order is never changed.
  - Edge: escaping + in-range item ⇒ no loot; front enemy + in-range item ⇒ combat only;
    `loot_policy` is reset on every level transition (alongside `combat_policy.reset()`).

## R-5 / AC5 — determinism, purity, boundedness, observability unchanged

- [ ] F-11 (R-5, AC5, REQUIRED, determinism pin) **Two identical invocations/runs are
  byte-identical.**
  - EXPECTED: two identical `loot_intent` calls on the same observation produce byte-identical
    action sequences; two identical `run_bounded_driver` + `FixedTickClock` runs produce
    field-for-field identical `DoomDriverReport`s and an identical loot decision sequence;
    `loot_signature` is deterministic (no hash-seed variance). No wall-clock/RNG leak (G-316).
  - Edge: N repeated runs stable; a different item set changes the sequence (sanity — not a
    constant); a different map changes the report.

- [ ] F-12 (R-5, AC5, REQUIRED, static pin) **`loot.rs` is pure and every action is bounded.**
  - EXPECTED: no `rand`, no `Instant`, no `SystemTime`, no thread, no I/O on the hot path; the ONLY
    env read (if any) is inert when unset; every emitted action carries a pinned bounded `amount`
    (`DOOM_LOOT_FORWARD_AMOUNT` / the seek window); no `#[allow(...)]` suppression serves as a fix.
  - Edge: the enumerated purity grep is the pin.

- [ ] F-13 (R-5, AC5, REQUIRED, live/static) **Existing observability unchanged; the retired
  per-tick JSONL is NOT reintroduced.**
  - EXPECTED: status counters (`plans`/`replans`/`escapes`/`stuckTicks`/`engagements`/`kills`) carry
    their existing values; `dataset.execution.replans[]` unchanged; `doom-agent-actions.jsonl` stays
    ABSENT (retired in #3053 — NOT reintroduced); `level.items`/`item_count` untouched;
    `itemsCollected`/`player.weapons` are purely additive (existing keys keep order/serde names).
  - Edge: loot-inert run vs the pre-change baseline (`-At` recipe, below); the retired per-tick
    action-audit file asserted absent — the CURRENT equivalent is `dataset.execution.replans[]`.

## R-2 / AC2 (UI, ST-5) — run-status surfacing

- [ ] F-16 (R-2, AC2(UI), REQUIRED, live/unit) **The RENDERED loot HUD shows
  `Loot: {itemsCollected}` under the bound testid `doom-loot-hud` (the status-line append is a
  SECONDARY assertion, not the rendered proof).**
  - EXPECTED (UI/UX S1a/S5/S6/S7, binding): the top-left loot pill (absolute `Text` stacked below
    `doom-combat-kills`) with testid `doom-loot-hud`, `role="status"`, `aria-live="polite"`,
    `aria-atomic="true"` is PRESENT once `phase === 'running'`, with `textContent ===
    'Loot: {itemsCollected}'` (`Loot: 0` while running with zero collected); it updates IN PLACE
    on the existing `doom-autoplay-changed` emission (`itemsCollected` `0 → 5` ⇒ text `Loot: 0` →
    `Loot: 5`) with no new poll/invoke; theme tokens only (`bg.surface`/`border.default`/
    `fg.default` — no hex/rgba). **Secondary assertion (NOT the rendered proof):** the pure,
    unrendered helper `doomAutoplayStatusLine` (`types.ts:372-390`) gains `· Loot {n}` only for
    `running`/`completed`.
  - Edge: `phase === 'idle'` ⇒ `doom-loot-hud` DOM-absent (never a flash of `Loot: 0`);
    `idle`/`stopping`/`failed` status lines stay byte-identical; the `doom-combat-kills` pill text
    stays byte-identical (`Kills: {n}`); the loot pill persists across `stopping`/`failed`/
    `completed`; `doom-autoplay-status` and the other #3007-removed hooks stay DOM-absent.

## Non-functional

- [ ] F-14 (NFR, build) **CI-parity build hygiene.** EXPECTED: `cargo check` from
  `apps/tauri/src-tauri/` → ZERO warnings; `pnpm --filter @fredo/ui build` green after the ST-5
  mirror; no `#[allow(...)]` suppressions.
- [ ] F-15 (NFR, teardown/orphan, G-263) **Close the `doom` window mid-loot.** EXPECTED:
  `get_doom_autoplay_status.phase != running`; teardown bounded; no orphan thread/process; no new
  listener (single critical section, no new thread). Edge: close mid-seek; mid-collect; rapid
  open/close.
- [ ] F-LIVE (live-evidence receipt) `upload-evidence` a screenshot of the LIVE `doom` window
  showing the loot readout (→ `https://github.com/user-attachments/...` URL), AND query
  `telemetry_spans`. EXPECTED: the `## Tests Runs` comment references the `user-attachments` URL;
  the `telemetry_spans` query returns a NON-ZERO count + recent `max(ingested_at)`. **DISCLOSE that
  the Doom native loop emits no span.** Edge: managed-`psql` pool saturated → app-pool read
  substitution, DISCLOSED (G-307/G-284).

## Required test data (all in-repo or produced by an in-repo lever — G-172)

- **Synthetic observation fixtures** (unit): items in/out of range, all four buckets,
  empty/malformed `items`, multi-item — F-1/F-7/F-8/F-11/F-12.
- **`FREDO_DOOM_INJECT_OBSERVATION`** (`DOOM_INJECT_OBSERVATION_ENV`, `engine.rs:1115`; top-level
  merge `merge_observation`, `engine.rs:1239-1254`) — inject an `items[]` entry in range.
  **CAVEAT:** the merge replaces the WHOLE `items` key — this validates the DECISION, not the diff.
- **Scripted decision source** (`FREDO_DOOM_AGENT_DECISION_SOURCE=scripted` +
  `FREDO_DOOM_AGENT_SCRIPT`) with `FREDO_DOOM_AGENT_MAX_STEPS` bounded budget over
  `run_bounded_driver` (`engine.rs:655`) + `FixedTickClock` — the AC2/AC3 real-collection drive.
- **IPC/observation surface:** `doom_read_state` (`/level/itemsCollected`, `/player/weapons`,
  `/player/weapon`, `/items[]`) and `get_doom_autoplay_status` / `doom-autoplay-changed`
  (`itemsCollected`).
- **`dataset.execution.replans[]`** + the dataset record's tick actions — AC4/AC5
  observability/boundedness.
- **Live-evidence lever:** `tauri_webview_screenshot` of the LIVE `doom` window saved to
  `.opencode/tmp/3054/e2e/`, uploaded via
  `rust-script .opencode/scripts/pipeline-state.rs --issue 3054 --agent tester --action
  upload-evidence --image <png>`; plus the `telemetry_spans` query.
- **Scratch root:** `.opencode/tmp/3054/` (gitignored).

## Exact live forcing recipes

- **L1 (AC1 decision/steer).** Launch with
  `FREDO_DOOM_INJECT_OBSERVATION={"items":[{"kind":"health","direction":"front","distance":100}]}`.
  Flow: `enter_doom_mode` → `launch_doom_runtime` → `start_doom_autoplay` → poll
  `doom_read_state`/`get_doom_autoplay_status`; confirm the loot `turn-to`+`forward` per tick while
  in range; repeat with the injection unset.
- **L2 (AC2 counter / AC3 weapons — REAL collection).** Drive the player over a real E1M1
  `MobjFlag::Special` with a deterministic scripted `Move` script (bearing read live from
  `items[]`), over `run_bounded_driver` + `FixedTickClock` or the app autoplay → assert
  `/level/itemsCollected` climbs `0 → ≥1` and `get_doom_autoplay_status.itemsCollected` mirrors it;
  for AC3, walk over the E1M1 `shotgun` and assert `player.weapons` gains `"shotgun"`. The live leg
  captures the `doom` window status area.
- **L3 (AC4 precedence).** Wedge the player against a wall so `no_move_ticks >= 12` with an injected
  in-range item → assert NO loot action while escaping; then a front enemy (`{"enemies":[…]}`) +
  in-range item → assert combat only.
- **L-BASELINE (optional).** Pre-change control:
  `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 3054 -At <pre-change-tip>`
  (the `spec/3054` ancestor before the ST-1..ST-5 commits).

## Pass/fail criteria (per REQ — executable by a literal tester)

- **AC1 (R-1):** PASS iff an in-range pickup yields a bounded, deterministic steer (F-1), the real
  run steers to an injected in-range `items[]` (F-2), AND a real pickup is actually walked over and
  the route resumes (F-3). An unbounded steer, or a route that never resumes → **FAIL**.
- **AC2 (R-2):** PASS iff on a **real** run a Special is collected and `/level/itemsCollected`
  climbs `0 → ≥1` AND `DoomAutoplayStatus.itemsCollected` mirrors it (F-4). Injection-only (F-2) or
  the unit pin alone (F-5) is **never** a PASS for AC2. A counter stuck at `0`, non-monotonic, or
  fabricated client-side → **FAIL**; if no real-collection drive is reachable, F-4 is a named
  blocker, not a PASS.
- **AC3 (R-3):** PASS iff `player.weapons` starts at `["fist","pistol"]` AND reflects a collected
  weapon pickup (F-6), slot-ordered and additive (F-7). Substituting `player.weapon` for the set →
  **FAIL**.
- **AC4 (R-4):** PASS iff `loot_target` is `None` when no item is in range, every seek is
  window-bounded and non-thrashing (F-8), loot never changes `replans`/`plan_index` progression
  (F-9), and loot yields to escape + combat (F-10). A re-plan triggered by loot or an abandoned
  route → **FAIL**.
- **AC5 (R-5):** PASS iff the two identical runs are byte-identical, `loot.rs` is RNG/clock/IO-free,
  every action is bounded (F-11/F-12), and the retained observables are unchanged (F-13). Any
  nondeterminism, unbounded action, or changed existing observable → **FAIL**.

**Coverage:** R-1→F-1/F-2/F-3 · R-2(live)→F-4 · R-2(corroboration)→F-5 · R-3→F-6/F-7 ·
R-4(pure)→F-8 · R-4(live)→F-9 · R-4/R-5(precedence)→F-10 · R-5(det)→F-11 · R-5(purity)→F-12 ·
R-5(obs)→F-13 · R-2(UI)→F-16 · NFR→F-14/F-15 · live→F-LIVE.
