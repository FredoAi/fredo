# doom-companion-combat — Regression Test Cases (Spec #3053)

> Durable regression suite (feature domain `doom-companion-combat`). The "must-not-change"
> baseline for the **engagement + aim/fire + low-health disengage** slice (#3053) and links to the
> overlapping Doom suites. #3053 LAYERS a pure local `combat::combat_intent` policy on top of the
> retained `safety_reflex` (#3026) and the #3031 escape/unstick + #3039 plan-execution chains
> (retained, not replaced). The reflex semantics, the plan/re-plan path, the continuous pacing,
> engine determinism, and the game-only `doom` window MUST survive unchanged; combat adds only
> additive wire fields (`DoomAutoplayStatus.kills`/`.engagements`, `DoomDriverReport.kills`).
>
> **Verification policy: live** — each run needs a live receipt: the `telemetry_spans` reference
> (NON-ZERO count + recent `max(ingested_at)`; app-pool read preferred, G-307; managed `psql`
> fallback DISCLOSED, G-284) and/or an `upload-evidence` screenshot of the LIVE `doom` window
> status area. Doom emits no span. A static-only PASS is a FALSE PASS (G-033).

## Must-not-change baseline (from the plan's non-goals / regression invariants)

- [ ] R-1: **`safety_reflex` semantics unchanged** — `safety_reflex` (`agent.rs:881-907`) still
  drops `forward` + a bounded (`DOOM_REFLEX_STEP_BACK_TICKS`=2) `backward` at
  `blocked_forward_ticks >= DOOM_REFLEX_BLOCKED_TICKS`=4 and still drops `shoot` when no front
  enemy. The combat layer emits `shoot` ONLY when the SAME shared predicate
  `plan::observation_has_front_enemy` (`plan.rs:208-218`) is true — a legitimately-detected front
  enemy is never suppressed; a stray shot with no front enemy stays dropped. The reconciliation is
  structural (one predicate), not a second divergent predicate.
  (Links: `doom-autoplay-fluency/functional.md` F-4, `doom-autoplay-fluency/regression.md`
  R-5, `doom-companion-progress/regression.md` R-2.)
- [ ] R-2: **#3031 escape precedence while wedged** — the escape/unstick window
  (`agent.rs:1133-1148`) still takes precedence: a wedged companion (K-tick unchanged position,
  K = `DOOM_ESCAPE_STUCK_TICKS`=12) briefly STOPS firing to unstick, then resumes combat. The
  combat intent flows through the retained `effective_intent` chain and does not replace it.
  (Links: `doom-companion-progress/functional.md` F-1, `doom-companion-progress/regression.md`
  R-2/R-3.)
- [ ] R-3: **#3039 re-plan path + door/exit unchanged** — the five divergence triggers, the
  `OpenDoor` wait, and the door/exit-bearing contract (`plan.rs`) behave identically with combat
  present; the dataset `execution.replans[]` (`agent.rs:2193-2201`) and the re-plan audit record
  (`plan.rs:176`) are unchanged. (Links: `doom-companion-planning/functional.md` F-3/F-4,
  `doom-companion-planning/regression.md` R-2.)
- [ ] R-4: **#3026 continuous pacing unchanged** — hold-last + the continuous cadence + the
  raw-framebuffer frame transport are unchanged; the combat layer adds no thread and no unbounded
  wait. (Links: `doom-autoplay-fluency/functional.md` F-1/F-3/F-8,
  `doom-autoplay-fluency/regression.md` R-3/R-4.)
- [ ] R-5: **Combat inert ⇒ tick sequence byte-identical** — with no front enemy (`enemies:[]`),
  a bounded run's issued-tick sequence and `DoomDriverReport` counters are byte-identical to the
  pre-change baseline. (Links: `doom-companion-progress/functional.md` F-7.)
- [ ] R-6: **Engine determinism** — the combat policy, the reflex, the escape detector, and the
  plan executor are PURE functions of the observation + counters (no RNG, no clock).
  `run_bounded_driver` + `FixedTickClock` reproduces a run byte-for-byte; temporal assertions stay
  tick/step-driven, never wall-clock (G-316). Two identical runs yield a field-for-field identical
  `DoomDriverReport` (incl. `kills`/`engagements`). (Links: `doom-native/`,
  `doom-companion-progress/functional.md` F-7.)
- [ ] R-7: **Game-only `doom` window unchanged** — the `doom` window still renders ONLY
  `doom-root`/`doom-frame-canvas`/`doom-frame-desc` (+ the transient states, `doom-autoplay-note`,
  and the NEW persistent `doom-combat-kills` HUD pill); the #3007-removed hooks stay DOM-absent
  (`doom-autoplay-status` included). The `kills` counter is additive, theme-token-driven,
  event-sourced (no polling). (Links: `doom-companion-progress/regression.md` R-5,
  `doom-autoplay-fluency/regression.md` R-3.)
- [ ] R-8: **Doom mode / window / theme / save lifecycle unchanged** — `enter_doom_mode`/
  `exit_doom_mode`/`get_doom_mode_status`, `doom-mode-changed`, the native OS-close teardown
  (`teardown_doom_on_window_close`), the `DOOM_PALETTE` theme + armored avatar, and
  `get_doom_save`/`reset_doom_save` behave exactly as today.
  (Links: `doom-mode/regression.md`, `doom-native/regression.md`.)
- [ ] R-9: **No process leak / no orphan / no new listener / no second OS window** — across every
  leg zero engine image outlives its window/app (process inventory: only `fredo.exe`); no Doom API
  listener; no SDL second OS window; the combat layer adds no thread and no unbounded wait
  (G-263). (Links: `doom-native/regression.md` R-6.)
- [ ] R-10: **Mission Monitor / app unaffected** — Mission Monitor renders live sessions normally
  with combat present; console clean of `Error:`/`Uncaught`/`Maximum update depth exceeded`.
  (Links: `mission-monitor/functional.md`.)
- [ ] R-11: **PG-default boot + exit hooks co-exist** — `storage_engine_status` = PostgreSQL
  ready; the `RunEvent::Exit` hook still runs the Doom + `llama-server` + PG teardowns.
  (Links: `postgres-lifecycle/`, `llama-setup/functional.md`.)

## Links to overlapping suites

- `.opencode/tests/doom-autoplay-fluency/` — the #3026 continuous-motion / hold-last /
  **safety-reflex** / pacing slice; the closest baseline for the reflex this spec reconciles with.
- `.opencode/tests/doom-companion-progress/` — the #3031 escape/unstick + bounded
  local-locomotion slice; the closest baseline for the **escape precedence** while wedged.
- `.opencode/tests/doom-companion-planning/` — the #3039 plan-execution + re-plan + doors slice;
  the closest baseline for the **re-plan path / door / exit** behaviour.
- `.opencode/tests/doom-observation-geometry/` — the #3030 bounded `walls` geometry (S1); the
  observation contract the combat layer consumes read-only.
- `.opencode/tests/doom-native/` — the #3023 native-engine rewrite + the deterministic driver
  (`run_bounded_driver`); the engine/render/determinism baseline.
- `.opencode/tests/doom-mode/` — the full prior Doom suite (mode/window/autoplay/theme/save).
- `.opencode/tests/doom-companion-dataset/` — the dataset observables (`execution.replans[]`)
  the AC5 "observability unchanged" pin checks.
- `.opencode/tests/mission-monitor/` — the E2E live-session render gate.
- `.opencode/tests/llama-setup/`, `.opencode/tests/postgres-lifecycle/` — model-serving and
  exit-hook co-existence.
