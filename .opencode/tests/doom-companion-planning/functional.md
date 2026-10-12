# doom-companion-planning — Functional Test Cases (Spec #3039)

> Durable functional suite (feature domain `doom-companion-planning`). One `- [ ]` case per
> requirement; observable expected outcome per case. Formalizes the Implementation Plan #3039
> `### QA Plan`. This domain covers the **plan-ahead + doors-first-class + richer forward
> sensing → complete a level** slice: a short **plan** returned by the model and executed
> **tick-by-tick in real time**, **re-planned on divergence** (five triggers), **`OpenDoor`
> steps** that press `use` and WAIT for `state=="waiting"`, and **level completion** on a
> robustly-walkable NON-secret target. Mechanics live in the continuous loop
> (`applications/doom/agent.rs:1192 run_continuous_loop`) and the new sensing
> (`applications/doom/perception.rs`), observed through `DoomAutoplayStatus`
> (`autoplay.rs`), the deterministic driver (`engine.rs:627 run_bounded_driver`), and the
> action/request-audit JSONL.
>
> **Verification policy: live** — a running engine plus a real/extended drive. The tester's
> Evidence MUST reference `telemetry_spans` (a live-query result: NON-ZERO count + recent
> `max(ingested_at)`; app-pool read preferred, G-307; managed `psql` on the PG default as a
> DISCLOSED fallback, G-284) at round start AND after the drive. **The Doom engine emits NO
> OTLP span — the query proves the live pipeline, not the feature; DISCLOSE it.** A
> static-only PASS is a FALSE PASS (G-033). The authoritative live evidence is the app status
> surface (`get_doom_autoplay_status`, `commands.rs:707`), the `DoomDriverReport`
> (`engine.rs:552`), and the action-audit JSONL.
>
> **No wall-clock flakiness (G-316).** Every plan-execution / divergence / door-wait row is
> STEP-DRIVEN through the injectable tick clock (`clock.rs:66 DoomTickClock`; `FixedTickClock`)
> and the deterministic driver (`engine.rs:627 run_bounded_driver`) — never asserted on raw
> wall-clock timing. The AC5 end-to-end completion is the ONE live wall-clock leg.
>
> **G-300/G-275 — every failure edge names an in-repo induction lever. Rows flagged
> `⚠ ARCHITECT-LEVER` require a NEW lever the Architect must add.** The observation fallback
> uses the shipped `FREDO_DOOM_FAIL_PERCEPTION=1` (`perception.rs:70`); the plan/route legs use
> the scripted source (`FREDO_DOOM_AGENT_DECISION_SOURCE=scripted` + `FREDO_DOOM_AGENT_SCRIPT`,
> `decision.rs:32/34`).
>
> **Scratch:** `.opencode/tmp/3039/`. Env overrides via the `dev-environment` skill
> (`dev-env.ps1 -EnvVar`, single delimited / helper-script form).

## Named constants / literals (pin before convergence)

`DOOM_PERCEPTION_RAY_COUNT` (=9), `DOOM_PERCEPTION_NEAR_RANGE` (=64),
`DOOM_PERCEPTION_SAMPLING_RANGE` (=1024), `DOOM_OBSERVATION_MAX_WALLS` (=16),
`DOOM_OBSERVATION_BYTE_BUDGET` (=8192); `DOOM_CONTINUOUS_MAX_TICKS` (=30_000, run budget),
`DOOM_CONTINUOUS_TICK_PERIOD_MS` (=28), `DOOM_REFLEX_BLOCKED_TICKS` (=4, blocked≥4 trigger),
`DOOM_ESCAPE_STUCK_TICKS` (=12, no-progress K), `DOOM_LOCAL_DOOR_USE_TICKS` (=30),
`DOOM_LOCAL_DOOR_NEAR_RANGE` (=64); `DOOM_FORCE_EXIT_AFTER_TICS` (=1). Wire literals
(camelCase): existing `phase`, `running`, `steps`, `decisions`, `failures`, `lastTic`,
`outcome`, `level`, `completed`, `degraded`, `code`, `doors[]`, `walls[]`, `exit.distance`,
`enemies[]`; NEW `walls[].class` ∈ `{"wall","door","enemy","floor"}` (additive to the S1
`{direction,distance,blocked}` triple), bounded `openings`, door bearings, `exit.bearing`,
plan `steps`/`stepIndex`, and `replans` + `reason` ∈
`{"blocked","noProgress","newFrontEnemy","doorClosed","planExhausted"}`. Literals:
`outcome == "exited"`; `phase == "completed"`; door `state == "waiting"`.

## REQ-0S — feasibility spike: pin a robustly-walkable NON-secret target (Architect's FIRST sub-task)

- [ ] F-0 (REQ-0S, REQUIRED, live/deterministic) **A deterministic sim-time spike measures
  door-modelled walkability of each NON-secret level and pins ONE target.** Recipe **R0**.
  - EXPECTED: `.opencode/tmp/3039/st-0-feasibility-spike.md` records a per-map walkability
    number (each non-secret `map` in `1..=9` of `DOOM1.WAD`) and pins exactly ONE target (QA
    proposal: **E1M1**); AC5 (F-5) binds to that map.
  - Edge: every non-secret level un-walkable → **FAIL escalates a PO decision**; the spike MUST
    NOT pin a SECRET level or a level it did not measure.

## REQ-1 / AC1 — richer forward sensing (per-ray distance + class, openings, door/exit bearings), additive/bounded/fallback

- [ ] F-1 (REQ-1, AC1, REQUIRED, live) **The forward observation carries per-ray distance +
  class, bounded `openings`, door bearings, and an exit bearing — additive, typed, bounded, with
  a graceful fallback.** Recipe **R1** (+ static corroboration of the pure projection).
  - EXPECTED: `doom_read_state` (or the driver's start/end observation) serializes the new
    fields PRESENT, TYPED (`walls[].class` a string in the fixed vocabulary; distances integer),
    and BOUNDED (rays ≤ `DOOM_PERCEPTION_RAY_COUNT`=9; `openings` ≤ the pinned cap; no array
    scaling with the framebuffer); with `FREDO_DOOM_FAIL_PERCEPTION=1` (`perception.rs:70`) the
    observation STILL serializes with the `[]` fallback and NO panic; the S1 triple
    `{direction,distance,blocked}` is byte-unchanged.
  - Edge: open space (empty arrays); buffers unpopulated (first read before `render_for`); a
    single obstructed ray; door-class vs wall-class ray; width < 3 degenerate frame; serialized
    observation ≤ `DOOM_OBSERVATION_BYTE_BUDGET`=8192.

## REQ-2 / AC2 — plan executed tick-by-tick in real time

- [ ] F-2 (REQ-2, AC2, REQUIRED, live) **Ticks keep advancing while the plan is executed and a
  decision lags; steps advance one route-step per executed tick.** Recipes **R2**.
  - EXPECTED: with `{"delayMs":500,"plan":[{"type":"forward","amount":10}]}` the run's
    `get_doom_autoplay_status.steps`/`lastTic` strictly increase while `decisions` lags
    (`steps` ≫ `decisions`); phase stays `running`; the audit shows the plan step index
    advancing ONE step per executed tick (never several steps in one tick); a plan in flight is
    NOT abandoned when a new decision arrives mid-step.
  - Edge: plan steps outlast one decision; decision answers mid-plan; a step whose `amount`-hold
    spans multiple ticks; plan exhausted mid-run (→ REQ-3).

## REQ-3 / AC3 — re-plan on divergence (the FIVE triggers)

- [ ] F-3 (REQ-3, AC3, REQUIRED, live) **Each of the five divergence triggers fires a re-plan
  (fresh decision + new plan) recorded with its reason.** Recipes **R3a–R3e**.
  - EXPECTED: `replans` increments and the audit records a `reason` for EACH of: (a)
    `"blocked"` when `blocked_forward_ticks >= DOOM_REFLEX_BLOCKED_TICKS`=4; (b) `"noProgress"`
    when `no_move_ticks >= K` (K ≥ `DOOM_ESCAPE_STUCK_TICKS`=12); (c) `"newFrontEnemy"` when a
    new `enemies[]` entry with `direction=="front"` appears; (d) `"doorClosed"` when the plan's
    target door reports `state=="closing"`; (e) `"planExhausted"` when the finite plan is fully
    consumed. A re-plan that returns an identical plan does NOT loop unboundedly.
  - Edge: each trigger in isolation; two triggers at once (deterministic precedence); a re-plan
    that re-yields the same plan (no storm). **(c) and (d) live legs ⚠ ARCHITECT-LEVER — no
    observation-injection seam; the pure divergence predicate is unit-pinned meanwhile.**

## REQ-4 / AC4 — doors first-class (`use` → wait for `state=="waiting"` → proceed; bounded wait + re-plan)

- [ ] F-4 (REQ-4, AC4, REQUIRED, live) **An `OpenDoor` step presses `use` and WAITS until the
  door reports `state=="waiting"`, then proceeds; the wait is bounded and re-plans on timeout.**
  Recipe **R4**.
  - EXPECTED: the audit shows `{"type":"use"}` issued at the door (vocabulary confirmed,
    `actions.rs:59`); the loop withholds the next step until the step's target `doors[]` entry
    reports `state=="waiting"` (`engine.rs:1187-1191`); on the bound elapsing without `waiting`
    the step aborts and a re-plan fires (`reason` recorded).
  - Edge: door already `waiting` (proceed immediately); `opening`→`waiting`; `closing`
    (re-press or re-plan); bound reached (abort + re-plan); an `OpenDoor` step with no door in
    front (re-plan). **(bound-timeout live leg ⚠ ARCHITECT-LEVER — no door-wait seam).**

## REQ-5 / AC5 — complete a level on the pinned robustly-walkable NON-secret target

- [ ] F-5 (REQ-5, AC5, REQUIRED, live) **Within the run budget the policy completes the
  REQ-0S-pinned level.** Recipe **R5**.
  - EXPECTED: within the RUN BUDGET the policy reaches an exit on the pinned map —
    `outcome=="exited"` / level complete (`completed:true` at the final level); `DoomDriverReport
    .terminal == Some("exited")`; `exit.distance` sampled over the run is non-increasing overall
    AND never frozen > K ticks; `decisions`-to-exit reported.
  - Edge: slow/intermittent model; degraded throughout; death(s) then recovery; budget exhausted
    before exit (**FAIL**); the deterministic sim-time leg agrees with the live leg.

## Non-functional

- [ ] F-6 (NFR-1, bounded observation, live/static pin) **New sensing is additive/bounded — no
  per-pixel payload.** EXPECTED: a capped representative observation serializes ≤
  `DOOM_OBSERVATION_BYTE_BUDGET`=8192; the longest nested array ≤ the pinned cap (NEVER
  O(width×height) ≈ 64,000). Edge: full-`walls` + full-`openings` + full-`doors`; `class` on
  every ray.
- [ ] F-7 (NFR-2, determinism, G-316) **Deterministic driver + pure predicates.** Run
  `run_bounded_driver` TWICE (identical script + `FixedTickClock`). EXPECTED: field-for-field
  identical `DoomDriverReport`; every budget finite; the divergence detector + door-wait bounder
  read no RNG/clock. Edge: N repeats stable; a different map changes the report (sanity).
- [ ] F-8 (NFR-3, never-hang) **Every wait is finite.** EXPECTED: the door wait and every plan
  wait resolve within their bound; teardown observes the stop flag within one tick; no leaked
  thread. Edge: close the `doom` window mid-plan; mid-door-wait; mid-degraded run.
- [ ] F-9 (NFR-4, S1 `walls` additive) **S1 `walls` contract intact.** EXPECTED: `walls[]` still
  carries `direction`/`distance`/`blocked` (`blocked == distance<=64`), ≤ 9 rays, ≤ sampling
  range 1024; S1 fields byte-unchanged; `class` is a NEW key only — `doom-observation-geometry`
  R-1/R-2 still pass. Edge: a consumer reading only the S1 triple is unaffected.
- [ ] F-10 (NFR-5, build) **CI-parity build hygiene.** EXPECTED: `cargo check --locked` ZERO
  warnings; `cargo clippy --locked -- -D warnings` clean; `cargo test --locked` green;
  `pnpm --filter @fredo/ui build` green; no `#[allow(...)]` suppressions.
- [ ] F-11 (REG) **Prior Doom suites still pass.** EXPECTED: `doom-companion-progress`,
  `doom-observation-geometry`, `doom-autoplay-fluency`, `doom-native`, `doom-mode` regression
  rows pass (run-links in `regression.md`).
- [ ] F-LIVE (live-pipeline receipt) Query `telemetry_spans` at round start AND after the drive.
  EXPECTED: NON-ZERO count + recent `max(ingested_at)` BOTH times. **Doom emits no span —
  DISCLOSE.** Edge: managed-`psql` pool-saturated → app-pool read substitution, DISCLOSED
  (G-307/G-284).

## Required test data (all in-repo or produced by an in-repo lever — G-172)

- **Bundled WAD:** `apps/tauri/src-tauri/doom/DOOM1.WAD` (embedded at compile time via
  `include_bytes!`, `engine.rs:94`). The tester NEVER mutates it; the `FREDO_DOOM_WAD_PATH`
  override stays unset.
- **IPC / read paths (via `tauri_ipc_execute_command`):** `launch_doom_runtime`,
  `start_doom_autoplay`, `stop_doom_autoplay`, `get_doom_autoplay_status` (`commands.rs:707`),
  `doom_read_state` (`commands.rs:283`), `doom_step` (`commands.rs:298`).
- **Scripted decision source:** env `FREDO_DOOM_AGENT_DECISION_SOURCE=scripted` +
  `FREDO_DOOM_AGENT_SCRIPT` (`decision.rs:32/34`); scripts under `.opencode/tmp/3039/` (named per
  recipe). Env is read at app start — launch via the `dev-environment` skill.
- **Action/request audit JSONL:** env `FREDO_DOOM_AGENT_LOG_DIR=.opencode/tmp/3039/log` →
  `doom-agent-actions.jsonl` (`agent.rs:119`) and `doom-agent-requests.jsonl` (`doom_agent.rs:84`).
- **Budget env:** `FREDO_DOOM_AGENT_MAX_STEPS` (`decision.rs:38`; maps onto the tick budget,
  `commands.rs:512`).
- **AC1 fallback lever:** env `FREDO_DOOM_FAIL_PERCEPTION=1` (`perception.rs:70`; inert when
  unset).
- **Deterministic driver:** `run_bounded_driver` (`engine.rs:627`) + `FixedTickClock`
  (`clock.rs:106`).
- **Telemetry receipt:** `telemetry_spans` via the `telemetry-query` skill — DISCLOSED that the
  Doom engine emits no OTLP span.
- **Scratch root:** `.opencode/tmp/3039/` (gitignored). **The spec-brief-cited feasibility
  evidence `.opencode/tmp/3031/st-1-feasibility-spike-r{5,6}.md` and `reframe-study.md` are
  ABSENT in this working tree** — REQ-0S re-measures in-repo.

## Exact live forcing recipes

- **R0 (REQ-0S spike).** `run_bounded_driver` (`engine.rs:627`) + `FixedTickClock`
  (`clock.rs:106`) over each non-secret `map` in `1..=9`, scripted source; record per-map
  `terminal`/`steps`/doors-blocked count into `.opencode/tmp/3039/st-0-feasibility-spike.md`.
  **No wall clock.**
- **R1 (AC1 sensing + fallback).** Live: `launch_doom_runtime` → `start_doom_autoplay` → poll
  `doom_read_state`; inspect `walls[].class`, `openings`, door bearings, `exit.bearing`.
  Fallback: relaunch with `FREDO_DOOM_FAIL_PERCEPTION=1` (`perception.rs:70`; inert when unset)
  and assert the observation still serializes.
- **R2 (AC2 tick-by-tick).** `.opencode/tmp/3039/agent-script-plan.json` =
  `{"decisions":[{"delayMs":500,"plan":[{"type":"forward","amount":10}]}],"repeat":true}`,
  `FREDO_DOOM_AGENT_MAX_STEPS=400`. Each decision takes ≈500 ms (≈18 ticks at 28 ms), during
  which ticks must advance. Assert `steps`/`lastTic` climb while `decisions` lags.
- **R3a (AC3 blocked≥4).** `.opencode/tmp/3039/agent-script-blocked.json` =
  `{"decisions":[{"tics":1,"actions":[{"type":"forward","amount":10}],"plan":[{"type":"forward","amount":10}]}],"repeat":true}`
  — forward into a wall so `blocked_forward_ticks` reaches `DOOM_REFLEX_BLOCKED_TICKS`=4; assert
  a re-plan with `reason=="blocked"`.
- **R3b (AC3 no-progress≥K).** `.opencode/tmp/3039/agent-script-nomove.json` =
  `{"decisions":[{"tics":1,"actions":[{"type":"shoot"}],"plan":[{"type":"shoot"}]}],"repeat":true}`
  — a non-moving hold so `no_move_ticks` reaches K (≥ `DOOM_ESCAPE_STUCK_TICKS`=12); assert
  `reason=="noProgress"`.
- **R3c (AC3 new front enemy). ⚠ ARCHITECT-LEVER.** No engine-observation injection seam exists
  today; unit-pin the PURE divergence predicate against a synthetic observation carrying an
  `enemies[]` entry with `direction=="front"` (mirrors `safety_reflex`/`effective_intent` purity,
  `agent.rs:821/1066`). The live leg needs the Architect to add an injectable-observation seam or
  a scripted route that provably places a front enemy in LOS. Otherwise UNVERIFIED-with-named-blocker.
- **R3d (AC3 door-closed). ⚠ ARCHITECT-LEVER.** Induce by a scripted stationary hold at a mapped
  door until it re-closes (`state=="closing"`); assert `reason=="doorClosed"`. The deterministic
  pin asserts the pure predicate against a synthetic `doors[]` with `state=="closing"`. A live
  door-state seam (mirroring `FREDO_DOOM_FAIL_PERCEPTION`) is requested.
- **R3e (AC3 plan exhausted).** `.opencode/tmp/3039/agent-script-shortplan.json` =
  `{"decisions":[{"plan":[{"type":"forward","amount":10}]}],"repeat":false}` — a finite one-step
  plan; once consumed, assert `reason=="planExhausted"`.
- **R4 (AC4 doors).** `.opencode/tmp/3039/agent-script-door.json` =
  `{"decisions":[{"plan":[{"type":"OpenDoor"}]}],"repeat":true}` targeting a mapped E1M1 door;
  drive; assert the audit shows `use` issued at the door and the loop proceeds only after
  `doors[].state=="waiting"`. **Bound-timeout live leg ⚠ ARCHITECT-LEVER** (no door-wait seam).
- **R5 (AC5 end-to-end).** Deterministic leg: `run_bounded_driver` + `FixedTickClock` at the
  REQ-0S map → assert `report.terminal == Some("exited")`. Live leg: real model (leave
  `FREDO_DOOM_AGENT_DECISION_SOURCE` unset) or the shipped local policy,
  `FREDO_DOOM_AGENT_MAX_STEPS=30000`; poll `doom_read_state` (`exit.distance`) +
  `get_doom_autoplay_status` (`decisions`/`steps`/`replans`/`completed`/`outcome`) across the
  run; `telemetry_spans` query at start AND end.

## Pass/fail criteria (per row — executable by a literal tester)

- **REQ-0S:** PASS iff `.opencode/tmp/3039/st-0-feasibility-spike.md` records a measured
  walkability number for each NON-secret level AND pins exactly ONE target; AC5 uses that map. No
  pin, a pinned SECRET level, or an unmeasured target → **FAIL (escalate a PO decision)**.
- **REQ-1:** PASS iff every new field is present, typed (`class` ∈ the vocabulary, distances
  integer), and bounded (rays ≤ 9, `openings` ≤ cap, no framebuffer-scaling array) AND the
  `FREDO_DOOM_FAIL_PERCEPTION=1` run still serializes (fallback `[]`, no panic). A missing/
  untyped/unbounded field or a fallback panic → FAIL/UNVERIFIED.
- **REQ-2:** PASS iff `steps`/`lastTic` strictly increase while a decision is pending
  (`steps` ≫ `decisions`) AND the audit shows the plan index advancing ONE step per executed
  tick. A frozen `steps`, an all-at-once plan, or a plan abandoned on decision arrival → FAIL.
- **REQ-3:** PASS iff EACH of the five triggers, induced in isolation, fires a re-plan with its
  `reason`. Any trigger that does NOT fire, or an unbounded re-plan storm on an identical state →
  FAIL. (c)/(d) live legs need the ⚠ Architect lever, else UNVERIFIED.
- **REQ-4:** PASS iff `use` is issued at the door AND the loop withholds the next step until
  `doors[].state=="waiting"`, AND on bound elapse without `waiting` it aborts + re-plans.
  Proceeding before `waiting`, or an unbounded wait → FAIL. Bound-timeout needs the ⚠ lever.
- **REQ-5:** PASS iff within the budget the policy reaches an exit on the REQ-0S-pinned map
  (`outcome=="exited"`; driver `terminal == Some("exited")`) AND `exit.distance` declines overall
  without a freeze > K. Budget exhausted before an exit, or a freeze → FAIL.
- **NFR-1..5/REG/F-LIVE:** PASS only on the named bound/determinism/bounded-wait/contract/build/
  regression/live-receipt evidence; any missing evidence → UNVERIFIED.

**Run-budget proposal (AC5):** **30,000 engine ticks** (env `FREDO_DOOM_AGENT_MAX_STEPS=30000`;
the shipped `DOOM_CONTINUOUS_MAX_TICKS` default, `clock.rs:54`; ≈ 14 min at the nominal 35 Hz
cadence) — the Architect may raise it if REQ-0S measures a longer robust route. **≤ 3
policy-iteration runs** on the live leg before FAIL (the deterministic sim-time leg must pass
first). Report `decisions`-to-exit at the terminal observation.

**Coverage:** REQ-0S→F-0 · AC1/REQ-1→F-1 · AC2/REQ-2→F-2 · AC3/REQ-3→F-3 · AC4/REQ-4→F-4 ·
AC5/REQ-5→F-5 · NFR-1→F-6 · NFR-2→F-7 · NFR-3→F-8 · NFR-4→F-9 · NFR-5→F-10 · REG→F-11 ·
live-pipeline→F-LIVE.

## Architect-lever gaps (must be resolved at convergence)

- REQ-3 (c) new-front-enemy + (d) door-closed: no live observation-injection seam.
- REQ-4 door-wait-timeout: no induction seam for the abort+re-plan path.
- REQ-1 field names: Architect pins the exact wire keys (`class`/`openings`/bearings).
- REQ-0S pinned map: Architect's spike owns the pin (QA proposal E1M1).
