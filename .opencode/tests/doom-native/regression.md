# doom-native — Regression Test Cases (Spec #3023)

> Durable regression suite (feature domain `doom-native`). The "must-not-change" baseline for the
> native-Doom rewrite + links to related suites. The rewrite is a **full replacement** of the
> engine/transport/provisioning under `applications/doom`, so the baseline is the Doom lifecycle,
> window, mode, theme, and save/resume behavior that MUST survive it.
>
> **Verification policy: live** — each run needs the live-pipeline `telemetry_spans` reference
> (NON-ZERO count + recent `max(ingested_at)`; app-pool read preferred, G-307; managed `psql`
> fallback DISCLOSED, G-284) plus DOM/screenshot/process/port receipts per leg. Doom emits no span.
> A static-only PASS is a FALSE PASS (G-033).

## Must-not-change baseline (from the plan's non-goals / regression invariants)

- [ ] R-1: **Mode lifecycle unchanged** — `enter_doom_mode`/`exit_doom_mode`/`get_doom_mode_status`
  and `doom-mode-changed` behave as today: `iddqd` / companion `doom_mode {action:enter|exit}` enter
  and leave the mode; the mode is never persisted (fresh boot = `inactive`); voice/audio input
  suppression while active behaves identically. (Links: `doom-mode/functional.md` slices 3–4.)
- [ ] R-2: **`doom` window + route unchanged** — `open_doom_window` stays a per-label singleton
  (focus-if-exists); `?view=doom` still renders the game-only surface (`doom-root`,
  `doom-frame-canvas`, `doom-frame-desc`); the 19 Spec #3007-removed hooks stay DOM-absent.
  (Links: `doom-mode/functional.md` #3007 slice, `window-manager/functional.md`.)
- [ ] R-3: **Native OS close is the only exit** — closing the `doom` window tears down via
  `teardown_doom_on_window_close` (stop the agent first, then the bounded engine stop ≤ 5 s with a
  hard-kill fallback) and publishes `doom-mode-changed {active:false}`; there is NO in-window close
  control. (Links: `doom-mode/functional.md` F-108/F-110.)
- [ ] R-4: **Doom theme + armored avatar unchanged** — while engaged the `DOOM_PALETTE` token layer
  and the `data-doom-armor="true"` / `#fredo-armor` overlay apply exactly as today; both revert
  byte-exactly on exit; no Doom token leaks into Settings. (Links: `theming/functional.md`,
  `doom-mode/functional.md` #2971 slice.)
- [ ] R-5: **Save/resume command surface** — `get_doom_save`/`reset_doom_save` and the
  `DoomSaveStatus` wire shape are UNCHANGED; the resume point persists in the `feature_doom_save`
  singleton row (app-pool read; no control-plane `doom_save_v1` key). **Map set rescoped to E1**
  (single-episode WAD): persisted coords are `episode=1, map∈1..=9`. (Links:
  `doom-mode/functional.md` #2972/#3011 slices; AC5 rows F-9/F-10.)
- [ ] R-6: **No process leak / no network listener** — across every leg ZERO engine image outlives
  its window/app (process inventory: only `fredo.exe`); the port check shows no Doom API listener;
  no second OS window. (Links: `doom-mode/regression.md` R-18/R-25.)
- [ ] R-7: **Exit hooks co-exist** — the `RunEvent::Exit` hook still runs the Doom, `llama-server`,
  and PG (`pg_supervisor::stop_on_exit`) teardowns (no early-return starves one); `storage_engine_status`
  = PostgreSQL ready. (Links: `llama-setup/functional.md`, `postgres-lifecycle/`.)
- [ ] R-8: **Mission Monitor unaffected** — renders live sessions normally with the native-Doom
  feature present; the F-E2E smoke row is the gate. (Links: `mission-monitor/functional.md`.)
- [ ] R-9: **CSP unchanged** — `tauri.conf.json` `connect-src` is unchanged; the webview never
  reaches the game runtime directly (all control is Rust-side). (Links: `settings/functional.md`.)

## Removal-scoped baseline (the deleted surfaces must not linger as dead code)

- [ ] R-10: **No dead transport/provisioning dispatch** — no command registration or event for the
  removed engine bridge/provisioning (`launch`-over-HTTP, `doom-provision-progress`,
  `provision_doom_engine`, `get_doom_provision_status`) remains in `lib.rs`/`mod.rs`; the retired
  `notConfigured`/`acquireFailed` copy is removed, not left coexisting (Contract-Trust Cleanup).
  (Links: `docs/ENGINEERING_RULES.md` "Contract-Trust Cleanup".)
- [ ] R-11: **No committed engine binary or non-open WAD** — the repo/bundle contain no
  `restful-doom.exe`, no vendored GPL source, and no retail WAD; only the shareware
  `apps/tauri/src-tauri/doom/DOOM1.WAD` ships. (Static/packaging check.)

## Links to overlapping suites

- `.opencode/tests/doom-mode/` — the full prior Doom suite (mode/window/autoplay/secret/theme/save);
  its Spec #3007 game-only + #3011 save slices remain the closest baseline.
- `.opencode/tests/mission-monitor/` — the E2E live-session render gate.
- `.opencode/tests/theming/`, `.opencode/tests/settings/` — the token contract + settings surfaces.
- `.opencode/tests/llama-setup/`, `.opencode/tests/postgres-lifecycle/` — exit-hook co-existence.
- `.opencode/tests/window-manager/`, `.opencode/tests/app-dock/` — window lifecycle/dock unaffected.
