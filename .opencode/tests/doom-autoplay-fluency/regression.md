# doom-autoplay-fluency — Regression Test Cases (Spec #3026)

> Durable regression suite (feature domain `doom-autoplay-fluency`). The "must-not-change" baseline
> for the continuous-motion / frame-transport / pacing changes (#3026) and links to the overlapping
> suites. #3026 only changes the **frame byte transport** and the **tick/decision pacing** — the
> visible game-only surface (#3007) and the mode/window/theme/save lifecycle MUST survive byte-identically.
>
> **Verification policy: live** — each run needs the live-pipeline `telemetry_spans` reference
> (NON-ZERO count + recent `max(ingested_at)`; app-pool read preferred, G-307; managed `psql`
> fallback DISCLOSED, G-284) plus DOM/screenshot/process receipts per leg. Doom emits no span. A
> static-only PASS is a FALSE PASS (G-033). All timing rows are seam-driven (G-316).

## Must-not-change baseline (from the plan's non-goals / regression invariants)

- [ ] R-1: **Engine unchanged (`neurodoom`)** — the vendored native engine crate is untouched by
  #3026; the observation contract and the `step`/`reset`/`frame` surface behave identically.
  (Links: `doom-native/functional.md`.)
- [ ] R-2: **Doom mode / window / theme / save lifecycle unchanged** — `enter_doom_mode`/
  `exit_doom_mode`/`get_doom_mode_status`, `doom-mode-changed`, the native OS-close teardown
  (`teardown_doom_on_window_close`), the `DOOM_PALETTE` theme + armored avatar, and
  `get_doom_save`/`reset_doom_save` behave exactly as today. (Links: `doom-mode/regression.md`
  R-1..R-5/R-26..R-31.)
- [ ] R-3: **Visible game-only surface unchanged (#3007)** — the `doom` window renders ONLY
  `doom-root`, `doom-frame-canvas`, `doom-frame-desc` (+ the minimal transient states and
  `doom-autoplay-note`); the 19 #3007-removed hooks stay DOM-absent (`querySelectorAll` count 0
  each). Only the frame byte transport changes. (Links: `doom-mode/regression.md` R-45.)
- [ ] R-4: **PNG-over-base64 `doom_frame` poll retired — no dual system (Contract-Trust Cleanup).**
  The `doom_frame`/`DOOM_FRAME_POLL_MS` poll path (`applications/doom/state.rs:36` →
  `DoomWindow.tsx:141/148` → `engine.rs:458` `frame_png`) is REPLACED, not coexisting with the
  raw-framebuffer `putImageData` transport; the dead base64/PNG encode path is removed.
  (Links: `docs/ENGINEERING_RULES.md` "Contract-Trust Cleanup".)
- [ ] R-5: **Autoplay commands unchanged for prior callers** — `start_doom_autoplay`/
  `stop_doom_autoplay`/`get_doom_autoplay_status`, `doom-autoplay-changed`, `doom_read_state`/
  `doom_step`, `launch_doom_runtime`/`stop_doom_runtime`, and the window singleton signatures are
  UNCHANGED. (Links: `doom-mode/regression.md` R-27/R-33.)
- [ ] R-6: **No shared companion model / prompt / serving change (lever D scope)** — the Doom
  decision-path latency work touches the Doom request only; the shared companion model, prompt, and
  `llama-server` serving config are unchanged (no shared regression).
- [ ] R-7: **No process leak / no orphan / no second OS window** — across every leg zero
  `restful-doom.exe`/separate engine image outlives its window/app (process inventory: only
  `fredo.exe`); no SDL second OS window; no new listener. (Links: `doom-native/regression.md` R-6.)
- [ ] R-8: **Mission Monitor / app unaffected** — Mission Monitor renders live sessions normally
  with the fluency change present; the rest of Fredo is unaffected by an active/degraded Doom run;
  console clean of `Error:`/`Uncaught`/`Maximum update depth exceeded`. (Links:
  `mission-monitor/functional.md`.)
- [ ] R-9: **PG-default boot + exit hooks co-exist** — `storage_engine_status` = PostgreSQL / PG
  supervisor ready; the `RunEvent::Exit` hook still runs the Doom + `llama-server` + PG teardowns
  (no early-return starves one). (Links: `postgres-lifecycle/`, `llama-setup/functional.md`.)

## Links to overlapping suites

- `.opencode/tests/doom-native/` — the #3023 native-engine rewrite + the **ST-9 deterministic
  driver**; the closest baseline for the engine/render surface.
- `.opencode/tests/doom-mode/` — the full prior Doom suite (mode/window/autoplay/secret/theme/save);
  its #2969 autoplay + #3007 game-only + #3011 save slices are the closest autoplay baseline.
- `.opencode/tests/mission-monitor/` — the E2E live-session render gate.
- `.opencode/tests/llama-setup/`, `.opencode/tests/postgres-lifecycle/` — exit-hook co-existence
  and the model-serving the Doom decision leg depends on.
- `.opencode/tests/hotkeys/` — the `view=doom` hotkeys-cluster suppression the window keeps.
