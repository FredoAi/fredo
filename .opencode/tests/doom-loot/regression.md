# doom-loot — Regression Test Cases (Spec #3054)

> Durable regression suite (feature domain `doom-loot`). The "must-not-change" baseline for the
> **opportunistic looting** slice (#3054) and links to the overlapping Doom suites. #3054 LAYERS a
> pure `loot` policy (`loot.rs`) at the continuous loop's step-3c seam, AFTER combat and only when
> not escaping — it COMPOSES WITH the route/executor action and never replaces it. The retained
> `safety_reflex` (#3026), the #3031 escape/unstick precedence, the #3039 plan/re-plan path, the
> #3053 combat policy, engine determinism, and the game-only `doom` window MUST survive unchanged.
> #3054 adds only additive observables (`level.itemsCollected`, `player.weapons`,
> `DoomAutoplayStatus.items_collected`).
>
> **Verification policy: live** — each run needs a live receipt: the `telemetry_spans` reference
> (NON-ZERO count + recent `max(ingested_at)`; app-pool read preferred, G-307; managed `psql`
> fallback DISCLOSED, G-284) and/or an `upload-evidence` screenshot of the LIVE `doom` window status
> area. **Doom emits no span.** A static-only PASS is a FALSE PASS (G-033).

## Must-not-change baseline (from the plan's non-goals / regression invariants)

- [x] R-1: **#3031 escape-window precedence** — while the escape window governs the tick
  (`escape_ticks_remaining > 0` OR `no_move_ticks >= DOOM_ESCAPE_STUCK_TICKS`=12), no loot action is
  composed; the escape/unstick window still takes precedence and the route resumes after it. The
  loot intent flows through the retained `effective_intent` chain and does not replace it.
  (Links: `doom-companion-progress/functional.md` F-1, `doom-companion-progress/regression.md`
  R-2/R-3.)
- [x] R-2: **#3026 continuous loop / clock seam** — hold-last + the continuous cadence + the
  raw-framebuffer frame transport are unchanged; the single clock seam is `DoomTickClock`
  (`agent.rs`), `DOOM_CONTINUOUS_TICS_PER_TICK` = 1 (`clock.rs:36`). Loot adds no thread and no
  unbounded wait. (Links: `doom-autoplay-fluency/functional.md` F-1/F-3/F-8,
  `doom-autoplay-fluency/regression.md` R-3/R-4.)
- [x] R-3: **#3039 plan/re-plan path + single front-enemy predicate** — the five divergence
  triggers, the `OpenDoor` wait, the door/exit-bearing contract, and the ONE shared
  `plan::observation_has_front_enemy` (`plan.rs:208-218`) are unchanged; loot NEVER mutates the plan
  or triggers a re-plan. The dataset `execution.replans[]` (`agent.rs`) and the retained
  `build_replan_audit_record` shape (`plan.rs:176`) are unchanged. (Links:
  `doom-companion-planning/functional.md` F-3/F-4, `doom-companion-planning/regression.md` R-2.)
- [x] R-4: **#3053 combat compose order** — the combat layer's composed action set
  (`agent.rs:2300-2331`) is unchanged; loot is subordinate (consulted only when
  `combat::combat_target(observation).is_none()`) and composed AFTER combat, so combat's action
  order is never reordered. `DoomAutoplayStatus.engagements`/`.kills` keep their values.
  (Links: `doom-companion-combat/functional.md` F-2/F-4/F-7,
  `doom-companion-combat/regression.md` R-1/R-2.)
- [x] R-5: **Loot inert ⇒ tick sequence byte-identical** — with no in-range pickup (`items:[]`), a
  bounded run's issued-tick sequence and `DoomDriverReport` counters are byte-identical to the
  pre-change baseline. (Links: `doom-companion-combat/regression.md` R-5.)
- [x] R-6: **Engine determinism** — the loot policy, the reflex, the escape detector, the combat
  policy, and the plan executor are PURE functions of the observation + counters (no RNG, no
  clock). `run_bounded_driver` + `FixedTickClock` reproduces a run byte-for-byte; temporal
  assertions stay tick/step-driven, never wall-clock (G-316). `loot_signature` is deterministic
  (FNV-1a over the sorted **multiset of `items[].kind`** — position/distance-invariant; B.7.3).
  (Links: `doom-native/`,
  `doom-companion-combat/regression.md` R-6.)
- [x] R-7: **Dead observables untouched** — `level.items` / `PlayerState.item_count` stays `0` and
  no code path binds to it; the pinned `neurodoom 0.6.7` dependency is not modified
  (`Cargo.toml:85`). (Links: `doom-companion-combat/functional.md` F-4 dead-`kills` note.)
- [x] R-8: **Status counters + action-audit observability unchanged** — `plans`/`replans`/`escapes`/
  `stuckTicks`/`engagements`/`kills` carry their existing values; `dataset.execution.replans[]` is
  unchanged; the retired `doom-agent-actions.jsonl` stays ABSENT (NOT reintroduced);
  `itemsCollected`/`player.weapons` are purely additive (existing keys keep order/serde names).
  (Links: `doom-companion-dataset/`.)
- [x] R-9: **Game-only `doom` window unchanged** — the `doom` window still renders ONLY
  `doom-root`/`doom-frame-canvas`/`doom-frame-desc` (+ the transient states, the #3053
  `doom-combat-kills` HUD, and any NEW `doom-loot-hud`); the #3007-removed hooks stay DOM-absent
  (`doom-autoplay-status` included). Any new HUD is additive, theme-token-driven, event-sourced
  (no polling). (Links: `doom-companion-combat/regression.md` R-7, `doom-mode/regression.md`.)
- [x] R-10: **Doom mode / window / theme / save lifecycle unchanged** — `enter_doom_mode`/
  `exit_doom_mode`/`get_doom_mode_status`, `doom-mode-changed`, the native OS-close teardown
  (`teardown_doom_on_window_close`), the `DOOM_PALETTE` theme + armored avatar, and
  `get_doom_save`/`reset_doom_save` behave exactly as today. (Links: `doom-mode/regression.md`,
  `doom-native/regression.md`.)
- [x] R-11: **No process leak / no orphan / no new listener / no second OS window** — across every
  leg zero engine image outlives its window/app; no Doom API listener; no SDL second OS window; the
  loot layer adds no thread and no unbounded wait (G-263). The `read_state` `guard.as_mut()` change
  never holds the session mutex across an `.await`. (Links: `doom-native/regression.md` R-6.)
- [x] R-12: **Mission Monitor / app unaffected** — Mission Monitor renders live sessions normally
  with loot active; console clean of `Error:`/`Uncaught`/`Maximum update depth exceeded`.
  (Links: `mission-monitor/functional.md`.)
- [x] R-13: **PG-default boot + exit hooks co-exist** — `storage_engine_status` = PostgreSQL ready;
  the `RunEvent::Exit` hook still runs the Doom + `llama-server` + PG teardowns.
  (Links: `postgres-lifecycle/`, `llama-setup/functional.md`.)

## Links to overlapping suites

- `.opencode/tests/doom-companion-combat/` — the #3053 combat policy this spec is subordinate to
  (compose order `agent.rs:2300-2331`); the closest baseline for looting's precedence.
- `.opencode/tests/doom-companion-progress/` — the #3031 escape/unstick + bounded local-locomotion
  slice; the closest baseline for the escape precedence loot yields to.
- `.opencode/tests/doom-companion-planning/` — the #3039 plan-execution + re-plan + doors slice; the
  closest baseline for the route/re-plan path loot must not perturb.
- `.opencode/tests/doom-companion-dataset/` — the dataset observables (`execution.replans[]`) the
  AC5 "observability unchanged" pin checks.
- `.opencode/tests/doom-observation-geometry/` — the #3030 bounded `walls` geometry; the observation
  contract the loot layer consumes read-only.
- `.opencode/tests/doom-autoplay-fluency/` — the #3026 continuous-motion / hold-last / safety-reflex
  / pacing slice.
- `.opencode/tests/doom-native/` — the #3023 native-engine rewrite + the deterministic driver
  (`run_bounded_driver`); the engine/render/determinism baseline.
- `.opencode/tests/doom-mode/` — the full prior Doom suite (mode/window/autoplay/theme/save).
- `.opencode/tests/mission-monitor/` — the E2E live-session render gate.
- `.opencode/tests/llama-setup/`, `.opencode/tests/postgres-lifecycle/` — model-serving and
  exit-hook co-existence.
