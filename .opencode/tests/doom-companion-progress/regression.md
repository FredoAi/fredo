# doom-companion-progress — Regression Test Cases (Spec #3031)

> Durable regression suite (feature domain `doom-companion-progress`). The "must-not-change"
> baseline for the **unstick/escape + bounded local-locomotion** policy (#3031, S2 of 5) and links
> to the overlapping Doom suites. #3031 LAYERS an escape/unstick + local-locomotion policy on top of
> the existing `safety_reflex` (retained, not replaced) and adds additive status/driver fields; the
> S1 `walls` contract, the reflex semantics, engine determinism, every OTHER `llm_server` consumer,
> and the game-only `doom` window MUST survive unchanged.
>
> **Verification policy: live** — each run needs the live-pipeline `telemetry_spans` reference
> (NON-ZERO count + recent `max(ingested_at)`; app-pool read preferred, G-307; managed `psql`
> fallback DISCLOSED, G-284) plus DOM/screenshot/IPC receipts per leg. Doom emits no span. A
> static-only PASS is a FALSE PASS (G-033).

## Must-not-change baseline (from the plan's non-goals / regression invariants)

- [ ] R-1: **S1 `walls` contract intact** — the observation still carries a bounded `walls` array
  (`front`/`left`/`right`, ≤ `DOOM_PERCEPTION_RAY_COUNT`=9, `blocked == distance<=`
  `DOOM_PERCEPTION_NEAR_RANGE`=64, ≤ `DOOM_PERCEPTION_SAMPLING_RANGE`=1024). `perception.rs` is NOT
  modified; the escape policy CONSUMES `walls` but never alters the field contract.
  (Links: `doom-observation-geometry/functional.md` F-1, `doom-observation-geometry/regression.md`
  R-1/R-2.)
- [ ] R-2: **`safety_reflex` semantics unchanged** — `safety_reflex` (`agent.rs:788`) still drops
  `forward` + a bounded (2-tic) `backward` step-back at `blocked_forward_ticks >=
  DOOM_REFLEX_BLOCKED_TICKS`=4 and still drops `shoot` when no front enemy. The new escape/local
  policy is COMPOSED on top (retained, not replaced); the reflex's own triggers fire identically.
  (Links: `doom-autoplay-fluency/functional.md` F-4, `doom-autoplay-fluency/regression.md` R-5.)
- [ ] R-3: **Engine determinism** — the unstick detector, escape-direction selector, and local
  policy are PURE functions of the observation + counters (no RNG, no clock). `run_bounded_driver`
  + `FixedTickClock` reproduces a run byte-for-byte; temporal assertions stay tick/step-driven, never
  wall-clock (G-316). Two identical runs yield a field-for-field identical `DoomDriverReport`.
  (Links: `doom-native/`, `doom-observation-geometry/functional.md` F-7.)
- [ ] R-4: **Other `llm_server` consumers byte-unchanged** — if the optional Doom-path request lever
  (ST-4) ships, its override is set ONLY in `build_doom_agent_request_body`; 
  `chat::build_response_format_request_body` and every other caller/feature stay byte-identical
  (pinned in the `doom_agent.rs:480-497` style). `--reasoning` at launch stays out of scope (shared
  server). The shared companion model/prompt/`llama-server` serving config are unchanged.
  (Links: `doom-autoplay-fluency/regression.md` R-6, `llama-setup/functional.md`.)
- [ ] R-5: **Game-only `doom` window unchanged** — the `doom` window renders ONLY `doom-root`,
  `doom-frame-canvas`, `doom-frame-desc` (+ the minimal transient states and `doom-autoplay-note`);
  the #3007-removed hooks stay DOM-absent. The new `escapes`/`stuckTicks` status fields are additive
  wire data — NOT surfaced as chrome; `get_doom_autoplay_status` still hydrates and reads only
  `phase === 'failed'` for rendering.
  (Links: `doom-observation-geometry/regression.md` R-6, `doom-autoplay-fluency/regression.md` R-3.)
- [ ] R-6: **Doom mode / window / theme / save lifecycle unchanged** — `enter_doom_mode`/
  `exit_doom_mode`/`get_doom_mode_status`, `doom-mode-changed`, the native OS-close teardown
  (`teardown_doom_on_window_close`), the `DOOM_PALETTE` theme + armored avatar, and
  `get_doom_save`/`reset_doom_save` behave exactly as today.
  (Links: `doom-mode/regression.md` R-1..R-5/R-26..R-31, `doom-native/regression.md`.)
- [ ] R-7: **No process leak / no orphan / no new listener / no second OS window** — across every
  leg zero engine image outlives its window/app (process inventory: only `fredo.exe`); the port check
  shows no Doom API listener; no SDL second OS window; the add-in loop adds no thread and no
  unbounded wait.
  (Links: `doom-native/regression.md` R-6.)
- [ ] R-8: **Mission Monitor / app unaffected** — Mission Monitor renders live sessions normally
  with the escape/policy change present; console clean of `Error:`/`Uncaught`/`Maximum update depth
  exceeded`. (Links: `mission-monitor/functional.md`.)
- [ ] R-9: **PG-default boot + exit hooks co-exist** — `storage_engine_status` = PostgreSQL ready;
  the `RunEvent::Exit` hook still runs the Doom + `llama-server` + PG teardowns.
  (Links: `postgres-lifecycle/`, `llama-setup/functional.md`.)

## Links to overlapping suites

- `.opencode/tests/doom-autoplay-fluency/` — the #3026 continuous-motion / hold-last / safety-reflex
  / pacing slice; the closest baseline for the loop this policy is layered onto.
- `.opencode/tests/doom-observation-geometry/` — the #3030 bounded `walls` geometry the escape policy
  consumes; the closest baseline for the observation contract (S1).
- `.opencode/tests/doom-native/` — the #3023 native-engine rewrite + the ST-9 deterministic driver
  (`run_bounded_driver`), the closest baseline for engine/render/determinism.
- `.opencode/tests/doom-mode/` — the full prior Doom suite (mode/window/autoplay/theme/save).
- `.opencode/tests/mission-monitor/` — the E2E live-session render gate.
- `.opencode/tests/llama-setup/`, `.opencode/tests/postgres-lifecycle/` — the model-serving the Doom
  decision leg depends on, and exit-hook co-existence.
