# doom-companion-combat — Functional Test Cases (Spec #3053)

> Durable functional suite (feature domain `doom-companion-combat`). One `- [ ]` case per
> requirement; observable expected outcome per case. Formalizes the Implementation Plan #3053
> `### QA Plan`. This domain covers the **engagement + low-health disengage** slice: a pure
> `combat` policy (`applications/doom/combat.rs`) that selects a target from the LOS-gated
> `enemies[]` intel, aims (bucket-level `turn-*`) and fires (`shoot`) until the front target
> leaves, disengages (bounded `backward`, no `shoot`) while health is low, and stays inert when
> there is no front enemy. The engine-native continuous loop
> (`applications/doom/agent.rs:1788 run_continuous_loop_with_writer`, step 3c), the deterministic
> driver (`engine.rs:633 run_bounded_driver`), `DoomAutoplayStatus`
> (`applications/doom/autoplay.rs:83`) and `DoomDriverReport` (`engine.rs:558`) are the
> observables.
>
> **Verification policy: live** — a native in-process engine loop plus a rendered status surface;
> NOT provable by pure unit logic alone. The tester's Evidence MUST carry a **live webview
> receipt** — an `upload-evidence` screenshot of the LIVE `doom` window's status area (a
> `https://github.com/user-attachments/...` URL) EMBEDDED in the single `## Tests Runs` comment,
> which MUST reference that URL. ALSO run the `telemetry_spans` query (NON-ZERO count + recent
> `max(ingested_at)`) and reference it, **DISCLOSED: the Doom native loop emits no OTLP span — the
> query proves the live pipeline, not the feature.** The live-evidence gate accepts EITHER a
> genuine `telemetry_spans` result OR the webview receipt. A static-only PASS is a FALSE PASS
> (G-033).
>
> **No wall-clock flakiness (G-316).** Every determinism/engagement row that can be is STEP-DRIVEN
> through `run_bounded_driver` + `FixedTickClock` (`clock.rs`) — never asserted on raw wall-clock
> timing. The live app run (F-3/F-4/F-6) is the running-system leg.
>
> **G-275/G-300 — every state/edge names an in-repo induction lever.** Front arc / low health /
> no enemy are induced by (a) pure synthetic observation fixtures, (b)
> `FREDO_DOOM_INJECT_OBSERVATION` (`DOOM_INJECT_OBSERVATION_ENV`, `engine.rs:1046`) top-level-
> merging an `enemies[]` patch into the real observation, and (c) `FREDO_DOOM_COMBAT_LOW_HEALTH`
> (`DOOM_COMBAT_LOW_HEALTH_ENV`) overriding the AC3 threshold. No out-of-repo asset, recorded
> media, or model is required (G-172).
>
> **G-187 — the `kills` render hook is BOUND to `doom-combat-kills` (owner: UI/UX Expert, ST-5).**
> The game-only `doom` window renders NO autoplay status (`doom-autoplay-status` etc. are
> #3007-removed hooks, DOM-absent). ST-5 adds a NEW top-left persistent pill with testid
> **`doom-combat-kills`**, text exactly `Kills: {n}`, visible iff `autoplayStatus.phase !== 'idle'`.
> F-14 binds AC2's DOM evidence there; the LIVE screenshot must show the non-zero readout.
>
> **Aim is BUCKET-level.** `enemies[]` carries only `{kind,hp,direction,distance}` (no fine
> bearing); do NOT expect sub-bucket bearing evidence — a bounded `turn-*` until the bucket is
> `front`, then fire.
>
> **Scratch:** `.opencode/tmp/3053/`. Env overrides via the `dev-environment` skill
> (`dev-env.ps1 -EnvVar`, single delimited / helper-script form).

## Named constants / literals (from the Architect's BINDING NAMES BLOCK, G-255 — do not rename)

`DOOM_COMBAT_LOW_HEALTH` (=25), `DOOM_COMBAT_ACQUIRE_RANGE` (=512), `DOOM_COMBAT_FIRE_TICS` (=1),
`DOOM_COMBAT_TURN_AMOUNT` (=1), `DOOM_COMBAT_RETREAT_TICS` (=2),
`DOOM_COMBAT_LOW_HEALTH_ENV` (=`"FREDO_DOOM_COMBAT_LOW_HEALTH"`). Types: `CombatMode::{Engage,
Disengage}` (`wire()` → `"engage"`/`"disengage"`), `CombatTarget{direction,distance}` (direction ∈
`{front,left,right}`), `DoomCombatPolicy{engagements}` (`reset()`), `CombatIntent{mode,target,
actions}`. Functions: `combat_target`, `health_disengages`, `combat_low_health`, `combat_intent`
(`None` iff no target). Loop seam: `run_continuous_loop_with_writer` step 3c
(`agent.rs:2207-2241`). Additive wire fields: `DoomAutoplayStatus.kills` (i64/camelCase),
`DoomAutoplayStatus.engagements` (u32), `DoomDriverReport.kills` (i64).

## R-1a / AC1 (aim) — side target ⇒ aim, no fire

- [ ] F-1 (R-1a, AC1, REQUIRED, pure) **A `left`/`right` target within `DOOM_COMBAT_ACQUIRE_RANGE`
  yields exactly one bounded `turn-*` and NO `shoot`.**
  - EXPECTED: `combat_target(<obs with enemies:[{direction:"left",distance:100}]>) ==
    Some(CombatTarget{direction:"left",distance:100})`; `combat_intent(...)` returns `Some` with
    `mode == CombatMode::Engage` and `actions == [{type:"turn-left",amount:DOOM_COMBAT_TURN_AMOUNT}]`.
    The `"right"` leg mirrors to `turn-right`.
  - Edge: `distance == DOOM_COMBAT_ACQUIRE_RANGE`=512 (accepted) vs `513` (→ `None`, no chase
    beyond the acquire bound); both side buckets present (deterministic first-wins selection);
    `hp:0` / absent `hp`.

## R-1b / AC1 (fire, continuous) — front target ⇒ bounded fire every tick

- [ ] F-2 (R-1b, AC1, REQUIRED, pure) **A `front` target yields exactly one bounded `shoot` per
  tick, no turn.**
  - EXPECTED: `combat_intent(<obs with enemies:[{direction:"front",distance:100}]>)` →
    `mode == Engage`, `actions == [{type:"shoot",amount:DOOM_COMBAT_FIRE_TICS}]`. A second
    invocation on the SAME observation is byte-identical (re-evaluated per tick, R-1b continuous).
  - Edge: front + a second `left`/`right` entry (front wins); front at `distance` 0 / far;
    `CombatMode::Engage.wire() == "engage"`.

## R-1 / AC1 (live) — injected front enemy ⇒ real run fires, reflex does not suppress

- [ ] F-3 (R-1, AC1, REQUIRED, live) **A real run with an injected front `enemies[]` issues a
  `shoot` every tick while the target is present; with no injection it issues none.**
  Recipe **C1**.
  - EXPECTED: `FREDO_DOOM_INJECT_OBSERVATION={"enemies":[{"kind":"trooper","hp":20,
    "direction":"front","distance":100}]}` → the loop action set carries `shoot` each tick while
    the front target is present; `status.engagements` > 0; the injected front enemy is NOT
    suppressed by `safety_reflex` (the ONE shared `plan::observation_has_front_enemy`,
    `plan.rs:208-218`). A repeat run with NO injection issues NO `shoot`.
  - Edge: aim→front transition (`left` injected first, then `front`); `enemies:[]`; lever unset
    (production byte-identical); **top-level-merge caveat** — only `enemies` is injected (never
    `player`).

## R-2 / AC2 — the run status `kills` counter climbs 0 → >0

- [ ] F-4 (R-2, AC2, REQUIRED, live) **A bounded real E1M1 run reports `kills > 0`, and the run
  status exposes a climbing `kills` sourced from `/level/kills`.**
  Recipe **C2**.
  - EXPECTED: `run_bounded_driver` → `DoomDriverReport.kills > 0` over the bounded run; the
    observation's `level.kills` climbs 0 → >0; `get_doom_autoplay_status.kills` (camelCase IPC)
    climbs 0 → >0. The ST-5 render shows the counter under the BOUND testid **`doom-combat-kills`**
    (text exactly `Kills: {n}`; see F-14).
  - Edge: a no-kill run leaves `kills == 0` (never negative, never fabricated); `kills` present +
    camelCase; `DoomDriverReport` field-for-field deterministic including `kills`.

## R-3 / AC3 (low health) — disengage: no fire + bounded retreat

- [ ] F-5 (R-3, AC3, REQUIRED, pure) **At/below the threshold a front target still yields NO
  `shoot` and exactly one bounded `backward`.**
  - EXPECTED: `health_disengages(25) == true`, `health_disengages(26) == false` with the default
    `DOOM_COMBAT_LOW_HEALTH`=25 (`health <= threshold`); `combat_low_health()` returns the default
    when `FREDO_DOOM_COMBAT_LOW_HEALTH` is unset/blank/invalid; `combat_intent(<front enemy AND
    low health>)` → `mode == Disengage`, `actions == [{type:"backward",
    amount:DOOM_COMBAT_RETREAT_TICS}]`, no `shoot`.
  - Edge: health exactly 25 (disengage) vs 26 (engage); health 0;
    `CombatMode::Disengage.wire() == "disengage"`.

- [ ] F-6 (R-3, AC3, REQUIRED, live) **Forcing the threshold HIGH makes a real front-arc run
  disengage (no `shoot`, `backward`), without clobbering the `player` object.**
  Recipe **C3**.
  - EXPECTED: with `FREDO_DOOM_COMBAT_LOW_HEALTH=9999` and a front enemy injected, the loop
    issues NO `shoot` and a bounded `backward`; `safety_reflex` does not re-add fire.
  - Edge: override unset → default 25 (inert); blank / non-numeric → inert default; threshold
    exactly at current health; a `player`-health injection (alternative leg) MUST supply the FULL
    player object — the merge replaces the whole `player` key (`engine.rs:1179-1185`).

## R-4 / AC4 (negative) — no front enemy ⇒ no fire

- [ ] F-7 (R-4, AC4, REQUIRED, pure) **With no `front` enemy the engagement layer is inert and no
  `shoot` is issued.**
  - EXPECTED: `combat_target(<no front>) == None`; `combat_intent(<no front>) == None`;
    `plan::observation_has_front_enemy == false`; the retained `safety_reflex` drops any stray
    `shoot` (`agent.rs:887-896`).
  - Edge: `enemies` key absent entirely; non-`front`-only entries (`left`/`right`/`back`);
    `enemies` non-array / malformed → inert, no panic.

## R-5 / AC5 — determinism, purity, boundedness, observability unchanged

- [ ] F-8 (R-5, AC5, REQUIRED, determinism pin) **Two identical invocations/runs are
  byte-identical.**
  - EXPECTED: two identical `combat_intent` invocations on the same observation produce
    byte-identical action sequences; two identical `run_bounded_driver` + `FixedTickClock` runs
    produce field-for-field identical `DoomDriverReport`s (incl. `kills`, `engagements`); no
    wall-clock/RNG leak (G-316).
  - Edge: N repeated runs stable; a different injected enemy changes the sequence (sanity — not a
    constant); a different map changes the report.

- [ ] F-9 (R-5, AC5, REQUIRED, static/unit pin) **`combat.rs` is pure and every action bounded.**
  - EXPECTED: no `rand`, no `Instant`, no `SystemTime`, no I/O on the hot path; the ONLY env read
    is the single `combat_low_health()` override (`DOOM_COMBAT_LOW_HEALTH_ENV`), inert when unset
    (mirrors `plan.rs:40-45`); every emitted action carries a pinned bounded `amount`
    (`DOOM_COMBAT_FIRE_TICS` / `DOOM_COMBAT_TURN_AMOUNT` / `DOOM_COMBAT_RETREAT_TICS`), never an
    unbounded hold.
  - Edge: the enumerated purity grep is the pin; no `#[allow(...)]` suppression serves as the fix.

- [ ] F-10 (R-5, AC5, REQUIRED, static/live) **Existing observability unchanged; the retired JSONL
  is NOT reintroduced.**
  - EXPECTED: status counters (`plans`/`replans`/`escapes`/`stuckTicks`) + the re-plan audit record
    (`plan.rs:176`) + dataset `execution.replans[]` (`agent.rs:2193-2201`) unchanged; a no-target
    tick sequence is byte-identical to the pre-change run; `doom-agent-actions.jsonl` stays absent
    (`agent.rs:4216-4230`); `kills`/`engagements` are purely additive.
  - Edge: combat-inert run vs pre-change baseline.

## R-2 / AC2 (UI render, ST-5) — the combat HUD `Kills: {n}`

- [ ] F-14 (R-2, AC2, REQUIRED, live/unit) **The rendered combat HUD shows `Kills: {n}` under the
  bound testid `doom-combat-kills`, and the pure status line carries `Kills {n}`.**
  - EXPECTED: with a `running` status whose `kills` climbs 0 → >0, `doom-combat-kills` textContent
    changes to `Kills: {n}` (event-driven via `doom-autoplay-changed`, no new poll); `phase ===
    'idle'` → `queryByTestId('doom-combat-kills')` is null (no flash of `Kills: 0`);
    `doomAutoplayStatusLine` includes `Kills {n}` for `running`/`completed` and stays byte-identical
    for `idle` (`Autoplay off`)/`stopping`/`failed`.
  - Edge: `engagements` is carry-only (NOT rendered) — do NOT assert an `Engagements:` readout; NO
    distinct "disengaged-low-health" badge exists (no `mode`/`health` status field) — do NOT bind a
    low-health badge here (AC3 is asserted behaviourally F-5/F-6); no hex/rgba in the new markup
    (tokens `bg.surface`/`border.default`/`fg.muted`/`fg.default`); `doom-autoplay-status` and the
    other #3007-removed hooks stay DOM-absent.

## Non-functional

- [ ] F-11 (NFR, build) **CI-parity build hygiene.** EXPECTED: `cargo check` from
  `apps/tauri/src-tauri/` → ZERO warnings; `pnpm --filter @fredo/ui build` green after the ST-5
  mirror; no `#[allow(...)]` suppressions.
- [ ] F-12 (NFR, teardown/orphan, G-263) **Close the `doom` window mid-engagement.** EXPECTED:
  `get_doom_autoplay_status.phase != running`; teardown bounded; no orphan thread/process; no new
  listener. Edge: close mid-fire; mid-retreat; rapid open/close.
- [ ] F-13 (NFR, theme/DOM, ST-5) **The rendered `kills` counter is theme-token-driven and the
  game-only surface is unchanged.** EXPECTED: the counter reads a theme token (no hardcoded
  hex/rgba); the game-only `doom` window's #3007-removed hooks stay DOM-absent; console clean of
  `Error:`/`Uncaught`/`Maximum update depth exceeded`.
- [ ] F-LIVE (live-evidence receipt) `upload-evidence` a screenshot of the LIVE `doom` window's
  status area (→ `https://github.com/user-attachments/...` URL) showing the non-zero `Kills: N`
  readout under `doom-combat-kills`, AND query `telemetry_spans`.
  EXPECTED: the `## Tests Runs` comment references the `user-attachments` URL; the
  `telemetry_spans` query returns a NON-ZERO count + recent `max(ingested_at)`. **DISCLOSE that
  the Doom native loop emits no span.** Edge: managed-`psql` pool saturated → app-pool read
  substitution, DISCLOSED (G-307/G-284).

## Required test data (all in-repo or produced by an in-repo lever — G-172)

- **Synthetic observation fixtures** (unit): front / left / right / absent enemy; health above and
  below threshold. Drive F-1/F-2/F-5/F-7.
- **`FREDO_DOOM_INJECT_OBSERVATION`** (`DOOM_INJECT_OBSERVATION_ENV`, `engine.rs:1046`;
  top-level merge `engine.rs:1170-1185`) — inject a `front`/`left`/`right` `enemies[]` entry live.
  **CAVEAT:** the merge replaces the WHOLE top-level key; a `player` injection MUST supply the
  full player object (`x,y,angle,health,armor,ammo,weapon`).
- **`FREDO_DOOM_COMBAT_LOW_HEALTH`** (`DOOM_COMBAT_LOW_HEALTH_ENV`) — the AC3 threshold override;
  set HIGH (e.g. `9999`) to force disengage without touching `player`; inert when
  unset/blank/invalid.
- **`DoomDriverReport.kills`** on a bounded real E1M1 `run_bounded_driver` run (AC2).
- **IPC status surface:** `get_doom_autoplay_status` / the `doom-autoplay-changed` event →
  `DoomAutoplayStatus.kills` / `.engagements`.
- **Live-evidence lever:** `tauri_webview_screenshot` of the LIVE `doom` window status area saved
  to `.opencode/tmp/3053/e2e/`, uploaded via
  `rust-script .opencode/scripts/pipeline-state.rs --issue 3053 --agent tester --action
  upload-evidence --image <png>`; plus the `telemetry_spans` query.
- **Scratch root:** `.opencode/tmp/3053/` (gitignored).

## Exact live forcing recipes

- **C1 (AC1 live fire).** Launch the app with the injection env
  `FREDO_DOOM_INJECT_OBSERVATION={"enemies":[{"kind":"trooper","hp":20,"direction":"front",
  "distance":100}]}`. Flow: `enter_doom_mode` → `launch_doom_runtime` → `start_doom_autoplay` →
  poll `doom_read_state` / `get_doom_autoplay_status`; confirm a `shoot` per tick while the front
  target is present and `engagements` climbing. Repeat with the injection unset.
- **C2 (AC2 kills).** Deterministic leg: `run_bounded_driver` at map 1 (E1M1) with
  `FREDO_DOOM_AGENT_MAX_STEPS` set to a bounded budget → assert `report.kills > 0`. Live leg: the
  app run (`enter_doom_mode` → `start_doom_autoplay`); poll `get_doom_autoplay_status.kills` 0 →
  >0; capture the status-area screenshot.
- **C3 (AC3 live disengage).** Launch with `FREDO_DOOM_COMBAT_LOW_HEALTH=9999` +
  `FREDO_DOOM_INJECT_OBSERVATION={"enemies":[{"direction":"front","distance":100}]}`; drive; assert
  NO `shoot` and a bounded `backward`.

## Pass/fail criteria (per REQ — executable by a literal tester)

- **AC1 (R-1):** PASS iff (pure) a `left`/`right` target within `DOOM_COMBAT_ACQUIRE_RANGE` yields
  exactly one `turn-*` and NO `shoot`, AND a `front` target yields exactly one bounded `shoot` per
  tick AND (live) an injected front `enemies[]` makes the real run issue a `shoot` every tick
  while that target is present. A turn-only response to a `front` target, or a suppressed shot with
  a front target, → **FAIL**.
- **AC2 (R-2):** PASS iff a bounded real E1M1 run reports `kills > 0` (`DoomDriverReport.kills`)
  AND `DoomAutoplayStatus.kills` climbs 0 → >0 AND the ST-5 render shows the counter. `kills` never
  leaving 0, or a missing field, → **FAIL**.
- **AC3 (R-3):** PASS iff at/below the threshold (default 25 or the live override) a front target
  still yields NO `shoot` and exactly one bounded `backward`, AND
  `health_disengages(h) == (h <= combat_low_health())` for the sampled healths. Any `shoot` while
  low-health → **FAIL**.
- **AC4 (R-4):** PASS iff with no `front` enemy `combat_target`/`combat_intent` return `None` AND
  NO `shoot` is issued live. A stray shot with no front enemy → **FAIL**.
- **AC5 (R-5):** PASS iff the two identical invocations/runs are byte-identical, `combat.rs` is
  RNG/clock/IO-free, every action is bounded, and the retained observables are unchanged. Any
  nondeterminism, unbounded action, or changed existing observable → **FAIL**.

**Coverage:** R-1a→F-1 · R-1b→F-2 · R-1(live)→F-3 · R-2/AC2→F-4 · R-3(pure)→F-5 · R-3(live)→F-6 ·
R-4/AC4→F-7 · R-5(det)→F-8 · R-5(purity)→F-9 · R-5(obs)→F-10 · R-2(UI)→F-14 ·
NFR→F-11/F-12/F-13 · live→F-LIVE.
