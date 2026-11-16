# doom-observation-geometry — Regression Test Cases (Spec #3030)

> Durable regression suite (feature domain `doom-observation-geometry`). The "must-not-change"
> baseline for the **additive** wall/obstacle observation geometry (#3030) and links to the
> overlapping Doom suites. #3030 only ADDS a bounded geometry field to
> `applications/doom/engine.rs:999 observation()`; the policy, the model/persona, the
> `llama-server` serving config, the visible game surface, and the mode/window/theme/save
> lifecycle MUST survive unchanged.
>
> **Verification policy: live** — each run needs the live-pipeline `telemetry_spans` reference
> (NON-ZERO count + recent `max(ingested_at)`; app-pool read preferred, G-307; managed `psql`
> fallback DISCLOSED, G-284) plus DOM/screenshot/IPC receipts per leg. Doom emits no span. A
> static-only PASS is a FALSE PASS (G-033).

## Must-not-change baseline (from the plan's non-goals / regression invariants)

- [ ] R-1: **Existing observation keys unchanged** — `tic/done/outcome/level{episode,map,skill,
  kills,items,secrets}/player{x,y,angle,health,armor,ammo,weapon}/enemies/items/doors/exit` keep
  their names, types, and semantics. The geometry addition is purely additive.
  (Links: `doom-native/functional.md` AC3 parity surface.)
- [ ] R-2: **Enemy LOS-gating unchanged** — `enemies` is still `check_sight`-gated, still carries
  `kind`/`hp`/`direction`/`distance`, still capped at 16. The enemy behind a wall stays absent.
  (Links: `doom-mode/functional.md` autoplay intel slice.)
- [ ] R-3: **Doom mode / window / theme / save lifecycle unchanged** — `enter_doom_mode`/
  `exit_doom_mode`/`get_doom_mode_status`, `doom-mode-changed`, the native OS-close teardown
  (`teardown_doom_on_window_close`), the `DOOM_PALETTE` theme + armored avatar, and
  `get_doom_save`/`reset_doom_save` behave exactly as today.
  (Links: `doom-mode/regression.md`, `doom-native/regression.md` R-1..R-9.)
- [ ] R-4: **Policy + persona/model unchanged (#3030 non-goal)** — `DOOM_AGENT_SYSTEM_PROMPT`, the
  `doom_action` schema, `DOOM_AGENT_MAX_TOKENS`, `build_doom_agent_request_body`'s shape, and the
  decision policy are UNCHANGED. Only the observation payload gains a bounded field.
  (Links: `doom-autoplay-fluency/regression.md` R-5/R-6.)
- [ ] R-5: **Continuous-loop / pacing unchanged** — the tick clock, hold-last, safety reflex, and
  pacing fallback are untouched by the observation change.
  (Links: `doom-autoplay-fluency/functional.md` F-1/F-3/F-4/F-5.)
- [ ] R-6: **Visible game-only surface unchanged (#3007)** — the `doom` window renders ONLY
  `doom-root`, `doom-frame-canvas`, `doom-frame-desc` (+ minimal transient states); the 19
  #3007-removed hooks stay DOM-absent.
  (Links: `doom-mode/regression.md`, `doom-autoplay-fluency/regression.md` R-3.)
- [ ] R-7: **No process leak / no orphan / no new listener / no second OS window** — across every
  leg zero engine image outlives its window/app (process inventory: only `fredo.exe`); the port
  check shows no Doom API listener; no SDL second OS window. (Links: `doom-native/regression.md` R-6.)
- [ ] R-8: **Mission Monitor / app unaffected** — Mission Monitor renders live sessions normally
  with the geometry change present; console clean of `Error:`/`Uncaught`/`Maximum update depth
  exceeded`. (Links: `mission-monitor/functional.md`.)
- [ ] R-9: **PG-default boot + exit hooks co-exist** — `storage_engine_status` = PostgreSQL ready;
  the `RunEvent::Exit` hook still runs the Doom + `llama-server` + PG teardowns.
  (Links: `postgres-lifecycle/`, `llama-setup/functional.md`.)

## Links to overlapping suites

- `.opencode/tests/doom-native/` — the #3023 native-engine rewrite + the **ST-9 deterministic
  driver** (`run_bounded_driver`), the closest baseline for the observation/parity surface.
- `.opencode/tests/doom-autoplay-fluency/` — the #3026 continuous-motion / frame / pacing slice;
  the closest baseline for the loop that consumes the observation.
- `.opencode/tests/doom-mode/` — the full prior Doom suite (mode/window/autoplay/theme/save).
- `.opencode/tests/mission-monitor/` — the E2E live-session render gate.
- `.opencode/tests/llama-setup/`, `.opencode/tests/postgres-lifecycle/` — the model-serving the
  Doom decision leg depends on, and exit-hook co-existence.
