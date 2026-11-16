# doom-companion-progress — Functional Test Cases (Spec #3031)

> Durable functional suite (feature domain `doom-companion-progress`). One `- [ ]` case per
> requirement; observable expected outcome per case. Formalizes the Implementation Plan #3031
> `### QA Plan`. This domain covers **S2 of 5** — the Doom Companion's **unstick/escape** reflex,
> the **bounded local locomotion** it keeps issuing while a model decision is in flight, the
> **degrade-and-continue** policy when the model is unavailable, the **terminal exit** reaction, and
> **end-to-end level completion**. Mechanics live in the continuous loop
> (`applications/doom/agent.rs:899 run_continuous_loop`; `safety_reflex` `agent.rs:788`), observed
> through `DoomAutoplayStatus` (`autoplay.rs:83`), the deterministic driver
> (`engine.rs:624 run_bounded_driver`), and the action-audit JSONL.
>
> **Verification policy: live** — a running engine plus a real/extended drive. The tester's Evidence
> MUST reference `telemetry_spans` (a live-query result: NON-ZERO count + recent `max(ingested_at)`;
> app-pool read preferred, G-307; managed `psql` on the PG default as a DISCLOSED fallback, G-284)
> at round start AND after the drive. **Doom emits NO OTLP span — the query proves the live
> pipeline, not the feature; DISCLOSE it.** A static-only PASS is a FALSE PASS (G-033). The
> authoritative live evidence for this feature is the app status surface
> (`get_doom_autoplay_status`, `commands.rs:707`), the `DoomDriverReport`, and the action-audit
> JSONL.
>
> **No wall-clock flakiness (G-316).** Every timing / continuity / escape row is STEP-DRIVEN through
> the injectable tick clock (`clock.rs:66 DoomTickClock`; `FixedTickClock`) and the deterministic
> engine driver (`engine.rs:624 run_bounded_driver`) — never asserted on raw wall-clock timing. The
> AC5 end-to-end completion is the ONE live wall-clock leg.
>
> **G-300/G-275 — every failure edge names an in-repo induction lever.** AC1/R1 no-move freeze via
> the scripted source (`{"tics":1,"actions":[{"type":"shoot"}]}`); AC2 via
> `{"delayMs":N}` / `{"stall":true}`; AC3 via `{"error":...}` / `{"stall":true}`; AC4 via the
> **ST-2-shipped** test-only `FREDO_DOOM_FORCE_EXIT=1` (`engine.rs::observation()`); AC5 via the
> deterministic driver leg + the live model/route leg.
>
> **Scratch:** `.opencode/tmp/3031/`. Env overrides via the `dev-environment` skill
> (`dev-env.ps1 -EnvVar`, single delimited / helper-script form).

## Named constants / literals (pin before convergence)

`DOOM_ESCAPE_STUCK_TICKS` (=12, K — the freeze threshold; QA's requested name, adopted by the
Architect), `DOOM_ESCAPE_REROUTE_AFTER` (=2), `DOOM_ESCAPE_WINDOW_TICKS` (=24),
`DOOM_ESCAPE_FORWARD_AMOUNT` (=16), `DOOM_LOCAL_FORWARD_AMOUNT` (=10), `DOOM_LOCAL_DOOR_USE_TICKS`
(=30); `DOOM_DEGRADED_AFTER_FAILURES` (=2), `DOOM_CONTINUOUS_TICK_PERIOD_MS` (=28),
`DOOM_DEGRADED_TICK_PERIOD_MS` (=50), `DOOM_CONTINUOUS_MAX_TICKS` (run budget; proposal ≥30000);
`DOOM_FORCE_EXIT_AFTER_TICS` (=1). Wire literals (camelCase): existing `phase`, `running`, `steps`,
`decisions`, `failures`, `consecutiveFailures`, `lastTic`, `outcome`, `episode`, `map`, `completed`,
`degraded`, `code`, plus NEW `escapes` / `stuckTicks`. Literals: `outcome == "exited"`;
`phase == "completed"`; error `code == "campaignComplete"` at the final level; driver `terminal ∈
{"dead","exited"}`.

## AC1 — freeze → escape changes heading AND position (REQ-1)

- [ ] F-1 (REQ-1, AC1, REQUIRED, live) **A K-tick unchanged-position hold is broken by an escape that
  changes BOTH heading and position.** Recipe **R1**: scripted non-moving hold; drive the real engine;
  read the action-audit JSONL + `doom_read_state` (`commands.rs:283`).
  - EXPECTED: after K consecutive ticks with `player.x`/`player.y` unchanged (K =
    `DOOM_ESCAPE_STUCK_TICKS`=12), the next audit record is an escape/reflex override carrying BOTH a
    turn (`turn-to`/`turn-left`/`turn-right`) AND a movement (`forward`/`strafe-*`/`backward`) in the
    SAME issued action set; the observation after the override shows `player.angle` CHANGED **and**
    (`player.x`,`player.y`) CHANGED. `escapes` (NEW status) ≥ 1; `stuckTicks` resets on the move.
  - Edge: freeze in a corner (must re-route after `DOOM_ESCAPE_REROUTE_AFTER`=2 empty escapes, not
    merely reverse); obstacle front vs rear; front enemy present (escape must NOT be suppressed);
    already moving (no spurious escape); empty-`actions` freeze; escape then unstuck (escape stops).

## AC2 — decision in flight → ticks keep advancing under a guarded persisted intent (REQ-2)

- [ ] F-2 (REQ-2, AC2, REQUIRED, live) **Ticks keep advancing while a model decision is pending;
  the persisted intent is reflex-guarded and locomotion is never fully absent.** Recipes **R2**
  (`delayMs`) and **R2b** (`stall`).
  - EXPECTED: `get_doom_autoplay_status.lastTic` and `.steps` strictly increase while `decisions`
    lags (`steps` ≫ `decisions`, ≈ delayMs / tickPeriod); phase stays `running`; `doom_read_state.tic`
    advances every tick; the audit shows the last intent re-issued (reflex-guarded); **no tick gap
    > K while a decision is pending** (the composer injects a locomotion action whenever the effective
    intent has none → the issued-locomotion gap bound is **1 tick**).
  - Edge: decision answers after N ticks; never answers (stall → timeout at ⌈30s/28ms⌉≈1072 ticks);
    error mid-flight; stop requested mid-flight (bounded exit); degraded cadence.

## AC3 — model unavailable → degrade but continue; local policy still progresses (REQ-3)

- [ ] F-3 (REQ-3, AC3, REQUIRED, live) **Model unavailable/timeout → degrade, but the run continues
  and the local policy still makes forward progress.** Recipes **R3** (`error`) and **R3b**
  (stall-timeout).
  - EXPECTED: `status.failures` > 0 and `status.degraded` = true (after
    `DOOM_DEGRADED_AFTER_FAILURES`=2, `clock.rs:46`); the run reaches the tick budget as
    `completed`/`budgetExhausted` — **NOT** `failed`/`decisionFailed`; `steps` advances to budget;
    the local policy MOVES the player (`player.x`/`y` change across the degraded window).
  - Edge: model down the whole run; down-then-recovers (degrade → nominal); explicit error vs
    timeout; engine error (`FREDO_DOOM_FAIL_ENGINE_SPAWN=1`, `failure_seam.rs:24`) → `notReady`
    (non-AC engine-path row).

## AC4 — level exit reached → `outcome:"exited"` and stop (REQ-4)

- [ ] F-4 (REQ-4, AC4, REQUIRED, live) **A terminal level-exit observation is reported and the run
  stops.** Lever **shipped by ST-2**: launch with `FREDO_DOOM_FORCE_EXIT=1` (inert when unset;
  `engine.rs::observation()` reports `done:true`/`outcome:"exited"` once `world.tick >=
  DOOM_FORCE_EXIT_AFTER_TICS`=1) — Recipe **R4**.
  - EXPECTED: an observation with `done:true`/`outcome:"exited"`; the loop reacts terminally —
    `get_doom_autoplay_status.outcome` = `"exited"` and, at the final level, `phase` = `completed`
    + `completed:true` (STOPS); `run_bounded_driver` report `terminal == Some("exited")`; no further
    step issued on the exited level.
  - Edge: exit reached while a decision is in flight (terminal wins; no step); exit exactly at the
    budget edge; death-vs-exit precedence (`outcome:"dead"` wins, `agent.rs:284`); final-level
    completion (`campaignComplete`) vs mid-campaign advance (E1M1→E1M2 reset).

## AC5 — complete a level end-to-end (REQ-5)

- [ ] F-5 (REQ-5, AC5, REQUIRED, live) **The Companion completes a level within the run budget.**
  Recipe **R5** (deterministic sim-time leg + live wall-clock leg).
  - EXPECTED: within the RUN BUDGET the policy reaches an exit — `outcome:"exited"` / level complete
    (`completed:true` at the final level); `exit.distance` sampled over the run is non-increasing
    overall AND never frozen > K ticks; decisions-to-exit = `status.decisions` at the terminal
    observation, reported (`escapes` reported too). ANY level (policy's choice; no WAD/map pinned;
    default E1M1).
  - Edge: level choice; slow/intermittent model; degraded throughout; death(s) then recovery; budget
    exhausted before exit (FAIL).

## Non-functional

- [ ] F-6 (NFR-1, scope iii, live/static pin) **Doom-request-path model config (`--reasoning` /
  `max_tokens` / model).** EXPECTED: Doom decision median latency reduced AND reported; the
  `max_tokens` override is set on the DOOM request body only (`doom_agent.rs:81`/`:139`) — the shared
  `chat::build_response_format_request_body` default is byte-unchanged (static pin). Edge: `--reasoning`
  off vs on (a shared-server LAUNCH flag — out of scope per the Architect); model swap; tuning must
  not starve the reply (empty reply → `modelUnavailable`, `doom_agent.rs:236`).
- [ ] F-7 (NFR-2, determinism/no-hang, G-316) **Deterministic driver + finite budget.** Run
  `run_bounded_driver` TWICE (identical script + `FixedTickClock`). EXPECTED: field-for-field
  identical `DoomDriverReport` (`steps`/`decisions`/`failures`/`start_tic`/`last_tic`/`start_x,y`/
  `last_x,y`/`terminal`); every budget finite (`DOOM_CONTINUOUS_MAX_TICKS`, `clock.rs:50`); the new
  helpers read no RNG/clock. Edge: a different map/seed changes the report (sanity); N repeats stable.
- [ ] F-8 (NFR-3, build) **CI-parity build hygiene.** EXPECTED: `cargo check --locked` ZERO warnings;
  `cargo clippy --locked -- -D warnings` clean; `cargo test --locked` green; `pnpm --filter @fredo/ui
  build` green; no `#[allow(...)]` suppressions.
- [ ] F-9 (NFR-4, teardown/orphan) **Close the `doom` window mid-run.** EXPECTED:
  `get_doom_autoplay_status.phase` ≠ `running`; teardown bounded; no orphan (native in-process
  engine; G-263). Edge: close while a decision is in flight; while degraded; rapid open/close; app
  exit (`RunEvent::Exit`).
- [ ] F-10 (NFR-5, S1 regression) **`walls` contract intact on `main`.** EXPECTED: observations still
  carry a bounded `walls` array (`front`/`left`/`right`, ≤ `DOOM_PERCEPTION_RAY_COUNT`=9,
  `blocked == distance<=DOOM_PERCEPTION_NEAR_RANGE`=64, ≤ `DOOM_PERCEPTION_SAMPLING_RANGE`=1024) —
  `perception.rs:47/51`. Edge: the escape policy may CONSUME `walls` but must not alter the field
  contract; `perception.rs` unmodified.
- [ ] F-11 (REG) **Prior Doom suites still pass.** EXPECTED: `doom-autoplay-fluency`,
  `doom-observation-geometry`, `doom-native`, `doom-mode` regression rows pass (run-links in
  `.opencode/tests/`).
- [ ] F-LIVE (live-pipeline receipt) Query `telemetry_spans` at round start AND after the drive.
  EXPECTED: NON-ZERO count + recent `max(ingested_at)` BOTH times. **Doom emits no span — DISCLOSE.**
  Edge: managed-`psql` pool-saturated → app-pool read substitution, DISCLOSED (G-307/G-284).

## Required test data (all in-repo or produced by an in-repo lever — G-172)

- **Bundled WAD:** `apps/tauri/src-tauri/doom/DOOM1.WAD` (embedded at compile time via
  `include_bytes!`, `engine.rs:94`). The tester NEVER mutates it; the `FREDO_DOOM_WAD_PATH` override
  (`engine.rs:88`) stays unset.
- **IPC / read paths (via the Tauri driver `tauri_ipc_execute_command`):** `launch_doom_runtime`,
  `start_doom_autoplay {maxSteps, freshStart?}`, `stop_doom_autoplay`, `get_doom_autoplay_status`
  (`commands.rs:707`), `doom_read_state` (`commands.rs:283`), `doom_step` (`commands.rs:298`); the
  `doom-autoplay-changed` event (`commands.rs:341`).
- **Scripted decision source:** env `FREDO_DOOM_AGENT_DECISION_SOURCE=scripted` +
  `FREDO_DOOM_AGENT_SCRIPT` (`decision.rs:32/34`); scripts under `.opencode/tmp/3031/` (named per
  recipe). Env is read at app start — launch via the `dev-environment` skill (`dev-env.ps1 -EnvVar`,
  single delimited / helper-script form).
- **Action/reflex audit JSONL (the REQ-1/REQ-2 observable):** env
  `FREDO_DOOM_AGENT_LOG_DIR=.opencode/tmp/3031/log` → `doom-agent-actions.jsonl` (`agent.rs:119`;
  records `{at,tic,actions,reflex,degraded}`) and, for the model path, `doom-agent-requests.jsonl`
  (`doom_agent.rs:84`).
- **Budget env:** `FREDO_DOOM_AGENT_MAX_STEPS` (`decision.rs:38`; maps onto the continuous tick
  budget, `commands.rs:512`).
- **AC4 exit lever (ST-2):** env `FREDO_DOOM_FORCE_EXIT=1` (+ `DOOM_FORCE_EXIT_AFTER_TICS`=1),
  inert when unset.
- **Autoplay status reader:** `get_doom_autoplay_status` (`commands.rs:707`) / the
  `doom-autoplay-changed` event.
- **Telemetry receipt:** `telemetry_spans` via the `telemetry-query` skill — DISCLOSED that the Doom
  engine emits no OTLP span (see the live-pipeline receipt note above).
- **Scratch root:** `.opencode/tmp/3031/` (gitignored).

## Exact live forcing recipes

- **R1 (AC1 freeze → escape).** `.opencode/tmp/3031/agent-script-freeze.json` =
  `{"decisions":[{"tics":1,"actions":[{"type":"shoot"}]}],"repeat":true}` — a shoot-only hold
  commands NO movement, so the player's position does not change and the K-tick freeze is induced
  deterministically. Env: `FREDO_DOOM_AGENT_DECISION_SOURCE=scripted`,
  `FREDO_DOOM_AGENT_SCRIPT=<that path>`, `FREDO_DOOM_AGENT_LOG_DIR=.opencode/tmp/3031/log`,
  `FREDO_DOOM_AGENT_MAX_STEPS=200`. Flow: `launch_doom_runtime` → `start_doom_autoplay` → poll
  `doom_read_state` every ~250 ms for ≤ 10 s → read the JSONL. (The empty-`actions` variant
  `{"tics":1,"actions":[]}` is an equivalent freeze induction.)
- **R2 (AC2 decision in flight).** `.opencode/tmp/3031/agent-script-delay.json` =
  `{"decisions":[{"delayMs":500,"tics":1,"actions":[{"type":"forward"}]}],"repeat":true}`,
  `FREDO_DOOM_AGENT_MAX_STEPS=200`. Each decision takes ≈500 ms (≈18 ticks at 28 ms), during which
  ticks must advance. Assert `steps`/`lastTic` climb while `decisions` lags.
- **R2b (AC2 stall / REQ-3 timeout leg).** `.opencode/tmp/3031/agent-script-stall.json` =
  `{"decisions":[{"stall":true}],"repeat":true}`, `FREDO_DOOM_AGENT_MAX_STEPS=1200`
  (> `timeout_ticks` = ⌈30 s / 28 ms⌉ ≈ 1072). The `decide` future never answers; the loop keeps
  polling it non-blockingly and advancing ticks; at ≈1072 ticks it abandons the decision and degrades
  (`agent.rs:1128-1140`). Live wall-clock ≈ 34 s.
- **R3 (AC3 model unavailable).** `.opencode/tmp/3031/agent-script-unavailable.json` =
  `{"decisions":[{"error":"model unavailable"}],"repeat":true}`, `FREDO_DOOM_AGENT_MAX_STEPS=200`.
  Each decision resolves immediately as `ModelUnavailable` (non-fatal) → after 2 consecutive,
  `degraded=true`; the run continues to the tick budget. (R3b == R2b, the timeout variant.)
- **R4 (AC4 exit).** Launch the app with the **ST-2-shipped** test-only seam
  `FREDO_DOOM_FORCE_EXIT=1` (+ `DOOM_FORCE_EXIT_AFTER_TICS=1`): `engine.rs::observation()` then
  reports the terminal level exit (`done:true`/`outcome:"exited"`) once
  `world.tick >= DOOM_FORCE_EXIT_AFTER_TICS`, mirroring the `FREDO_DOOM_FAIL_PERCEPTION` lever
  (`perception.rs:70`). Inert when unset. This drives the REAL engine's terminal path (loop terminal
  branch `agent.rs:1021-1032`) deterministically — no fake engine needed.
- **R5 (AC5 end-to-end).** Deterministic leg: `run_bounded_driver` with `FixedTickClock` (sim-time,
  fast) using the policy/route → assert `report.terminal == Some("exited")`. Live leg: real model
  path (leave `FREDO_DOOM_AGENT_DECISION_SOURCE` unset) or the shipped local policy,
  `FREDO_DOOM_AGENT_MAX_STEPS=30000`; `enter_doom_mode`/`start_doom_autoplay`; poll `doom_read_state`
  (`exit.distance`) + `get_doom_autoplay_status` (`decisions`/`steps`/`escapes`/`degraded`/
  `completed`/`outcome`) across the run; `telemetry_spans` query at start AND end.

## Pass/fail criteria (per row — executable by a literal tester)

- **REQ-1:** PASS iff the JSONL shows ≥1 escape record (a turn AND a movement in the same issued
  action set) after a K-tick unchanged-position run AND a later observation shows both `player.angle`
  and (`player.x`/`player.y`) changed. No such record, or heading-only, or a static-only artefact →
  FAIL/UNVERIFIED.
- **REQ-2:** PASS iff `steps` (and `lastTic`) strictly increase while a decision is pending (`steps`
  ≫ `decisions`) with no tick gap > K and phase = `running`. A frozen `steps`/`lastTic` → FAIL.
- **REQ-3:** PASS iff `failures` > 0, `degraded` = true, phase = `completed`/`budgetExhausted` (not
  `failed`), and the player's position changes across the degraded window. Early
  `failed`/`decisionFailed`, or a frozen position → FAIL.
- **REQ-4:** PASS iff a real-engine observation reports `outcome:"exited"` (driver `terminal ==
  Some("exited")`) AND the run stops/advances terminally. Drivable via the ST-2-shipped
  `FREDO_DOOM_FORCE_EXIT=1` lever (R4) — no longer a plan defect.
- **REQ-5:** PASS iff within the budget the policy reaches an exit AND `exit.distance` declines
  overall without a freeze. Budget exhausted before an exit, or a freeze → FAIL.
- **NFR-1:** PASS iff the measured Doom-decision median latency improved vs the pre-change control
  AND the `max_tokens` override stays Doom-path-only (static pin).
- **NFR-2/NFR-3/NFR-4/NFR-5/REG:** PASS only on the named build/run/render/contract evidence; any
  missing evidence → UNVERIFIED.

**Run-budget proposal (AC5):** **30,000 engine ticks** (env `FREDO_DOOM_AGENT_MAX_STEPS=30000`;
≈ 14 min at the nominal 35 Hz cadence) — the Architect may raise the shipped
`DOOM_CONTINUOUS_MAX_TICKS` default (`clock.rs:50`, currently 10,500) to ≥ 30,000. Report
`decisions`-to-exit at the terminal observation. The deterministic `run_bounded_driver` leg
validates the same report shape in sim-time; the live leg is the authoritative completion.

**Coverage:** AC1/REQ-1→F-1 · AC2/REQ-2→F-2 · AC3/REQ-3→F-3 · AC4/REQ-4→F-4 · AC5/REQ-5→F-5 ·
NFR-1→F-6 · NFR-2→F-7 · NFR-3→F-8 · NFR-4→F-9 · NFR-5→F-10 · REG→F-11 · live-pipeline→F-LIVE.
