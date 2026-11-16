# doom-mode — Regression Test Cases (Spec #2968)

> Durable regression suite (feature domain `doom-mode`). The "must not change" baseline for the Doom window/runtime slice + links to prior features' suites whose surface overlaps.
>
> **Verification policy: live** — each run needs the established live-pipeline reference (`telemetry_spans` non-zero + recent `max(ingested_at)` via the managed `psql` on the PG default, G-284; the `telemetry-query` skill is SQLite-only; a `telemetry_get_stats` substitution must be disclosed) plus DOM/screenshot/process receipts per leg. A static-only PASS is a FALSE PASS.

## Must-not-change baseline (from the plan's non-goals / regression invariants)

- [ ] R-1: **The `terminal` window is unchanged** — `open_terminal_window` still opens/focuses exactly one `terminal` window; `terminal` remains in `capabilities/default.json` `windows`; no shared singleton logic regressed. (Links: `terminal/functional.md`.)
- [ ] R-2: **Window manager unchanged** — `tauri_manage_window` list/resize/focus/min/max behave identically; the `doom` window is additive and does not perturb the window store/dock. (Links: `window-manager/functional.md`, `app-dock/functional.md`.)
- [ ] R-3: **`llama-server` supervision unchanged** — `launch_llama_server`/`stop_llama_server`/`stop_llama_server_on_exit` still work; the shared `RunEvent::Exit` hook still runs BOTH the llama-server and Doom teardown (no early-return starves one). (Links: `llama-setup/functional.md`.)
- [ ] R-4: **PG supervisor unchanged** — `pg_supervisor::stop_on_exit` still tears down within its bound; the startup sweep still runs; the **PG-default boot path** is intact (`pg_supervisor/state.rs` PG is unconditional). (Links: `postgres-lifecycle/`, `postgres-cutover/`.)
- [ ] R-5: **No installer growth / licensing** — the installer still ships no GPL engine binary and no non-open WAD; the WAD is never bundled or downloaded from a non-open source. The engine is built at dev/QA time, not bundled. (Static/packaging check.)
- [ ] R-6: **CSP unchanged** — `tauri.conf.json` `connect-src` is unchanged; the webview never fetches the engine directly; all engine HTTP remains Rust-side.
- [ ] R-7: **Mission Monitor unaffected** — renders live sessions normally with the Doom feature present (see `mission-monitor/functional.md`); the F-MM smoke row is the gate.
- [ ] R-8: **No process leak** — no `restful-doom.exe` (or stub) process outlives its window/app across the regression legs (N-1).
- [ ] R-9: **No second OS window** — the real engine initialises SDL video without presenting a second OS window (ST-5); `-noblit` still serves `/api/frame`.

## Links to overlapping suites

- `.opencode/tests/terminal/` — singleton window open/focus + close-handler teardown.
- `.opencode/tests/window-manager/` — window lifecycle, `RunEvent::Exit` teardown.
- `.opencode/tests/app-dock/` — window-store/dock unaffected by the additive `doom` window.
- `.opencode/tests/llama-setup/` — out-of-process child supervision + PID/image guard.
- `.opencode/tests/postgres-lifecycle/`, `.opencode/tests/postgres-cutover/` — PG-default boot + exit-hook co-existence.
- `.opencode/tests/mission-monitor/` — the live-session render smoke (F-MM).

---

## Autonomous-play slice (Spec #2969) — must-not-change baseline

> **Verification policy: live** — the live-pipeline `telemetry_spans` reference plus
> DOM/screenshot/process receipts per leg (managed `psql` on the PG default, G-284; a
> disclosed `telemetry_get_stats` substitution allowed). A static-only PASS is a FALSE PASS.

- [x] R-10 (PASS 2026-10-04 #2969 r1 — F-31 E2E gate passed: MM listed the seeded session with a rendered node while the Doom autoplay surface was present): **Mission Monitor unaffected by autoplay** — with the Doom autoplay surface
  present (and after a run), Mission Monitor still renders live sessions; the F-31 E2E row
  is the gate. (Links: `mission-monitor/functional.md`.)
- [x] R-11 (PASS 2026-10-04 #2969 r1 — `DoomWindow.tsx:339-341` still `setInterval(..., DOOM_FRAME_POLL_MS=66)`; autoplay added only a separate 1000 ms elapsed ticker; canvas rendered while autoplay ran): **Frame-poll path unchanged** — `DoomWindow.tsx:228-239` still polls
  `doom_frame` at `DOOM_FRAME_POLL_MS=66`; autoplay DRIVES steps and the display loop is
  not modified or blocked (no idle-frame motion introduced — G-316).
- [x] R-12 (PASS 2026-10-04 #2969 r1 — `doom_read_state` tic30 → `doom_step` tic31; `doom_frame` PNG (`iVBORw0K`); status ready; same managed pid across the loop; window singleton + launch/teardown unchanged): **Existing Doom surface unchanged** — `doom_read_state`/`doom_step`/`doom_frame`,
  `doom-status-changed`, launch/teardown, and the window singleton behave identically; the
  loop reuses the slice-1 supervised child and spawns NO new engine process; the KEPT testids
  (`doom-root`, `doom-frame-canvas`, `doom-frame-desc`, `doom-error`, `doom-retry-button`,
  `doom-frame-reconnecting`, `doom-autoplay-note`) render — the #3007-removed hooks
  (`doom-state-readout`, `doom-step-button`, …) are DOM-absent (see R-45).

### Links added by this slice

- `.opencode/tests/mission-monitor/` — F-31 E2E regression gate (unchanged surface).
- `.opencode/tests/llama-setup/` — the managed `llama-server` + Gemma model files the model
  decision leg depends on (named TOOLING GAP if absent).

---

## Secret-activation slice (Spec #2970) — must-not-change baseline

> **Verification policy: live** — the live-pipeline `telemetry_spans` reference plus
> DOM/screenshot/process receipts per leg (managed `psql` at the manifest `ports.pg`,
> G-284; a disclosed `telemetry-query.ps1 -PgPort`/`-Manifest` or app-pool
> `feature_data_read` substitution allowed). A static-only PASS is a FALSE PASS.

- [x] R-13 (PASS 2026-10-05 #2970 r1 — the `doom` window opened at `index.html?view=doom` and rendered `DoomWindow` (`doom-root`, `doom-window-title`="Doom"); the route is independent of the removed feature-registry entry): **`?view=doom` route unchanged** — `Router.tsx:16-18` still renders `DoomWindow` for `?view=doom`; the route is opened by the Rust `open_doom_window` singleton and is independent of the (removed) feature-registry entry. Doom Mode activation must not perturb it. (Links: `doom-mode/functional.md` F-33/F-38.)
- [x] R-14 (PASS 2026-10-05 #2970 r1 — with the mode inactive (voice enabled) `stt_start` → `started:true`; `get_doom_mode_status.voiceSuppressed===false`; no residual gate): **Mode-off companion behaviour unchanged** — with the mode inactive, `stt_start` and the model-audio turn behave exactly as today; the existing disabled gate (`session.rs:316-321`) and the model-audio path (`commands.rs:814-821`) are unmodified on the mode-off path. `get_doom_mode_status.voiceSuppressed === false`. (Links: `voice-dictation/functional.md`.)
- [x] R-15 (PASS 2026-10-05 #2970 r1 — app exit with the mode active left zero `restful-doom.exe`, zero `fredo.exe`, and zero embedded `postgres.exe` (the PG exit hook ran; `stop_doom_on_exit` is wired last in the `RunEvent::Exit` hook, lib.rs:1121-1132, so it never starves the llama/PG hooks)): **Exit hooks co-exist** — `stop_doom_on_exit` clears the mode AND stops the runtime; the llama-server (`stop_llama_server_on_exit`) and PG (`pg_supervisor::stop_on_exit`) exit hooks still run (no early-return starves one). (Links: `llama-setup/functional.md`, `postgres-lifecycle/`.)
- [x] R-16 (PASS 2026-10-05 #2970 r1 — `doom_read_state`/`doom_step`/`doom_frame`, `get_doom_status`, autoplay status/toggle, and the window singleton behaved identically; existing testids (`doom-root`, `doom-window-title`, `doom-frame-canvas`, `doom-state-readout`, `doom-step-button`, `doom-autoplay-toggle`, …) still rendered; the new `doom-exit-button` is additive): **Existing Doom runtime/autoplay surface unchanged** — INVERTED by #3007: the runtime, autoplay COMMANDS, and the window singleton behave identically, but the window surface is now game-only. The KEPT testids (`doom-root`, `doom-frame-canvas`, `doom-frame-desc`, `doom-error`, `doom-retry-button`, `doom-frame-reconnecting`, `doom-autoplay-note`) render; the 19 removed hooks (`doom-window-title`, `doom-status`, `doom-exit-button`, `doom-engine-location`, `doom-engine-location-saved`, `doom-state-readout`, `doom-campaign-controls`, `doom-save-status`, `doom-progress-complete`, `doom-fresh-start-button`, `doom-fresh-start-confirm`, `doom-fresh-start-cancel`, `doom-autoplay-toggle`, `doom-autoplay-stop`, `doom-autoplay-status`, `doom-autoplay-elapsed`, `doom-autoplay-error`, `doom-step-button`, `doom-start-button`) are DOM-absent (R-45). (Links: `doom-mode/functional.md` slice 1/2 + #3007 slice.)
- [x] R-17 (PASS 2026-10-05 #2970 r1 — `with_app_control()` pins unchanged (ST-4 unit tests); `with_app_control_and_doom()` additive offer order `open_app, close_app, doom_mode`; the frontend filter ignored a non-doom skill (`weather`) with zero spurious action): **Companion skill registry pins unchanged** — `with_app_control()` and its tests are untouched; `with_app_control_and_doom()` is additive with offer order `open_app, close_app, doom_mode`. The `useAppOpenRequests` filter (`useAppOpenRequests.ts:168-174`) still ignores non-open/close skills (zero spurious opens). (Links: `companion/functional.md`.)
- [x] R-18 (PASS 2026-10-05 #2970 r1 — after every activation/exit leg zero `restful-doom.exe` outlived its window/app; `tasklist` confirmed a single engine PID while active and none after exit; no SDL second OS window observed): **No process leak / no second OS window** — across every activation/exit leg zero `restful-doom.exe` outlives its window/app (N-8); no SDL second OS window; `-noblit` still serves `/api/frame`. (Links: `doom-mode/functional.md` F-39-42.)
- [x] R-19 (PASS 2026-10-05 #2970 r1 — Mission Monitor rendered the seeded `e2e-copilot2933` session while the secret-activation slice was present; the F-50 E2E row is the gate): **Mission Monitor unaffected** — renders live sessions normally with the secret-activation slice present; the F-50 E2E row is the gate. (Links: `mission-monitor/functional.md`.)

### Links added by this slice

- `.opencode/tests/mission-monitor/` — F-50 E2E regression gate (unchanged surface).
- `.opencode/tests/voice-dictation/` — the capture + model-audio pipeline the suppression gate reads (`session.rs`, `commands.rs`).

---

## Whole-app theme + armored avatar slice (Spec #2971) — must-not-change baseline

> **Verification policy: live** — the live-pipeline `telemetry_spans` reference plus
> DOM/screenshot/localStorage receipts per leg (managed `psql` on the PG default, G-284, or a
> disclosed app-pool fallback, G-307). Doom emits no span. A static-only PASS is a FALSE PASS.

- [x] R-20 (PASS 2026-10-05 #2971 r1 — mode-off base/preset/override passes unchanged; no Doom var applied; `DOOM_PALETTE` not applied): **Mode-off theme unchanged** — with the mode inactive, the base/preset/override passes behave exactly as today; the Doom layer is skipped and every `--*` var equals the pre-feature value. `DOOM_PALETTE` is not applied. (Links: `theming/functional.md`, `settings/functional.md`.)
- [x] R-21 (PASS 2026-10-05 #2971 r1 — 12-state vocabulary unchanged; base rect count 58 unchanged; armor is an additive `<g id="fredo-armor">` (0 rects, 13 paths); absent with mode off): **Frozen avatar vocabulary + geometry** — `FREDO_AVATAR_STATES.length` is unchanged (12, `fredoAvatarStates.ts:18-31`); the base `<rect>` count is unchanged; armor is an additive overlay `<g id="fredo-armor">`, never a 13th state; with the mode off, `data-doom-armor`/`#fredo-armor` are absent. (Links: `fredo-avatar/functional.md`, `launcher/functional.md`.)
- [x] R-22 (PASS 2026-10-05 #2971 r1 — `Fredo_theme_overrides`/`_preset`/`_user_presets` unchanged across enter/exit; `setOverride`/`setPreset`/`resetTheme` never called): **Persisted theme keys + setter API unchanged** — `Fredo_theme_overrides`/`Fredo_theme_preset`/`Fredo_user_presets` (`ThemeProvider.tsx:166,173,179`) are never written by this feature; `setOverride`/`setPreset`/`resetTheme` (`:388-420`) are never called. (Links: `settings/functional.md`, `theming/functional.md`.)
- [x] R-23 (PASS 2026-10-05 #2971 r1 — `enter_doom_mode`/`exit_doom_mode`/`get_doom_mode_status`, `doom-mode-changed`, the real runtime, and suppression behaved identically): **Existing Doom surface unchanged** — `enter_doom_mode`/`exit_doom_mode`/`get_doom_mode_status`, `doom-mode-changed`, the `doom` window + real runtime, and `performanceGate` suppression behave identically; `useDoomMode.test.tsx` stays green. (Links: `doom-mode/functional.md` slices 1–3.)
- [x] R-24 (PASS 2026-10-05 #2971 r1 — Mission Monitor rendered the seeded session through the enter/exit legs; F-59 gate passed): **Mission Monitor unaffected** — renders live sessions normally with the theme/armor slice present; the F-59 E2E row is the gate. (Links: `mission-monitor/functional.md`.)
- [x] R-25 (PASS 2026-10-05 #2971 r1 — across every enter/exit leg zero `restful-doom.exe` outlived its window/app; no second OS window observed): **No process leak / no second OS window** — across every enter/exit leg zero `restful-doom.exe` outlives its window/app; no SDL second OS window; `-noblit` still serves `/api/frame`. (Links: `doom-mode/functional.md` slices 1–3.)

### Links added by this slice

- `.opencode/tests/theming/`, `.opencode/tests/settings/` — the token contract + theme-settings surfaces the Doom layer must not perturb.
- `.opencode/tests/fredo-avatar/`, `.opencode/tests/launcher/` — the frozen 12-state vocabulary + 58-rect geometry.
- `.opencode/tests/mission-monitor/` — F-59 E2E regression gate (unchanged surface).

---

## Resume-across-sessions slice (Spec #2972) — must-not-change baseline

> **Verification policy: live** — the live-pipeline `telemetry_spans` reference plus
> DOM/process/control-plane receipts per leg (managed `psql` on the PG default, G-284, or a
> disclosed app-pool fallback, G-307). Doom emits no span. A static-only PASS is a FALSE PASS.

- [ ] R-26: **Autoplay resume-by-default unchanged for prior callers** — `enter_doom_mode` and the `doom` window autoplay toggle still pass no `freshStart`, so entering/toggling resumes by default (never silently fresh); the existing `start_doom_autoplay` idempotency (`commands.rs:754`) and readiness guard (`:766`) are unmodified. (Links: `doom-mode/functional.md` slices 2–3.)
- [ ] R-27: **Existing Doom runtime/autoplay surface unchanged (COMMANDS), window surface inverted** — `launch_doom_runtime`, `stop_doom_runtime`, `doom_read_state`, `doom_step`, `doom_frame`, `start/stop_doom_autoplay`, `get_doom_autoplay_status`, `doom-status-changed`, `doom-autoplay-changed`, and the window singleton behave identically. INVERTED by #3007: the KEPT testids (`doom-root`, `doom-frame-canvas`, `doom-frame-desc`, `doom-error`, `doom-retry-button`, `doom-frame-reconnecting`, `doom-autoplay-note`) render, and the 19 removed hooks (`doom-window-title`, `doom-status`, `doom-exit-button`, `doom-engine-location`, `doom-engine-location-saved`, `doom-state-readout`, `doom-campaign-controls`, `doom-save-status`, `doom-progress-complete`, `doom-fresh-start-button`, `doom-fresh-start-confirm`, `doom-fresh-start-cancel`, `doom-autoplay-toggle`, `doom-autoplay-stop`, `doom-autoplay-status`, `doom-autoplay-elapsed`, `doom-autoplay-error`, `doom-step-button`, `doom-start-button`) are DOM-absent (R-45). (Links: `doom-mode/functional.md` slices 1–4 + #3007 slice.)
- [ ] R-28: **Mode-off theme/armor unchanged + no new settings entry** — the resume slice adds no settings surface and does not perturb the theme/armor layer; with the mode inactive the base/preset/override passes behave exactly as today. (Links: `theming/functional.md`, `settings/functional.md`.)
- [ ] R-29: **Control plane carries NO Doom SAVE key** — the Doom save no longer writes `doom_save_v1` to the control plane (Spec #3011); `get_control_setting('doom_save_v1')` → null while the save lives in the `feature_doom_save` singleton row. The remaining control-plane keys (`doom_pid`, `doom_port`, `doom_last_error`, `doom_last_error_code`, theme keys) are unmodified; `control_set` remains one atomic upsert (`storage/mod.rs:113-121`). (Links: `doom-mode/functional.md` F-72 / Spec #3011 slice.)
- [ ] R-30: **Mission Monitor unaffected + no process leak** — Mission Monitor renders live sessions normally with the resume slice present (the F-69 E2E row is the gate); across every resume/restart leg zero `restful-doom.exe` outlives its window/app; no second OS window. (Links: `mission-monitor/functional.md`, `doom-mode/functional.md` F-63.)

### Links added by this slice

- `.opencode/tests/mission-monitor/` — F-69 E2E regression gate (unchanged surface).
- `.opencode/tests/theming/`, `.opencode/tests/settings/` — the token contract + settings surfaces the save/fresh-start UI must not perturb.

---

## Dedicated PostgreSQL feature-store slice (Spec #3011) — must-not-change baseline

> **Verification policy: live** — the live-pipeline `telemetry_spans` reference (non-zero count +
> recent `max(ingested_at)`) plus the app-pool read (`application_store_query`; G-284/G-307; `psql`
> NOT named — pool-saturated/unreachable) per leg. Doom emits no span. A static-only PASS is a FALSE PASS.

- [ ] R-31: **Existing Doom runtime/autoplay surface unchanged** — `get_doom_save`/`reset_doom_save`/`start_doom_autoplay`, `doom-status-changed`, `doom-autoplay-changed`, the `doom` window + real runtime, and the autoplay loop behave identically; command signatures + the `DoomSaveStatus` wire shape are UNCHANGED (`DoomWindow.tsx:424`, `types.ts:374`); existing testids still render. (Links: `doom-mode/functional.md` slices 1–4.)
- [ ] R-32: **Non-save Doom settings + app surfaces unchanged** — `doom_port`/`doom_last_error*`/`doom_pid` still use the `AppStore` control plane (ST-2 non-goals); Mission Monitor renders normally (F-MM3011 gate); zero `restful-doom.exe` after any leg; the terminal/PG supervisor exit hooks behave identically. (Links: `postgres-only-persistence/functional.md`, `mission-monitor/functional.md`).

---

## Engine-provisioning slice (Spec #3012) — must-not-change baseline

> **Verification policy: live** — the live-pipeline `telemetry_spans` reference (app-pool read,
> G-307; fallback managed `psql` at the manifest `ports.pg`, G-284, DISCLOSED) plus
> DOM/screenshot/process receipts per leg. Doom emits no span. A static-only PASS is a FALSE PASS.

- [ ] R-33: **Existing Doom runtime/autoplay/secret/theme/save surfaces unchanged** — `enter_doom_mode`/`exit_doom_mode`/`get_doom_mode_status`, `launch_doom_runtime`/`stop_doom_runtime`, `doom_read_state`/`doom_step`/`doom_frame`, `start/stop_doom_autoplay`, `get_doom_save`/`reset_doom_save`, `doom-status-changed`/`doom-autoplay-changed`/`doom-mode-changed`, and the `doom` window singleton behave identically; existing testids still render; the new provisioning testids are additive. (Links: `doom-mode/functional.md` slices 1–6.)
- [ ] R-34 (SUPERSEDED by #3013 — resolution is deliberately managed-only; the *configured → PATH → staged* order no longer exists. Kept for history; see R-40.): **Engine resolver order unchanged** — `resolver::resolve_engine` still resolves *configured → PATH → staged* (`resolver.rs:10-19,137-144`) and still performs NO out-of-repo filesystem search; provisioning changes only whether the staged candidate exists. (Links: `doom-mode/functional.md` F-11/F-48.)
- [ ] R-35: **Process supervision unchanged** — the provisioning child reuses `kill_pid_tree` and the startup orphan sweep (`process.rs:199-215,255-272,359-389`); the existing engine child, `llama-server` teardown, and the PG `stop_on_exit` hook still run (no early-return starves one). (Links: `llama-setup/functional.md`, `postgres-lifecycle/`.)
- [ ] R-36: **`doom_install_dir` plane unchanged** — the setting is still read via `resolve_install_dir`/`cached_get` (`process.rs:53-71`) and written via `cached_set` (atomic; no SQLite delete+insert); no new key is introduced; existing non-Doom settings behave identically. (Links: `settings/functional.md`.)
- [ ] R-37: **PG-default boot + Mission Monitor unaffected** — `storage_engine_status` = PostgreSQL ready; Mission Monitor renders live sessions via the CURRENT declared `sessions` rollup (F-89 is the gate). (Links: `mission-monitor/functional.md`.)
- [ ] R-38: **No process leak / no committed binary** — across every provisioning leg ZERO orphan processes; the repo/bundle still contain no committed `.exe`/`.wad` (F-76). (Links: `doom-mode/functional.md` F-76/F-82.)

### Links added by this slice

- `.opencode/tests/mission-monitor/` — F-89 E2E regression gate (unchanged surface).
- `.opencode/tests/settings/` — the `doom_install_dir` read/write plane the provisioning result persists through.
- `.opencode/tests/postgres-lifecycle/`, `.opencode/tests/llama-setup/` — exit-hook co-existence with the new provisioning child.

---

## Managed-only engine resolution slice (Spec #3013) — must-not-change baseline

> **Verification policy: live** — the live-pipeline `telemetry_spans` reference (app-pool read, G-307;
> fallback managed `psql` at the manifest `ports.pg`, G-284, DISCLOSED) plus DOM/process receipts per
> leg. Doom emits no span. A static-only PASS is a FALSE PASS. **A build/acquire exit 0 is NOT the
> acceptance gate — the runtime's OWN `GET /api/state` 200 is (G-314/G-323).**

- [ ] R-39: **Existing Doom runtime/autoplay/secret/theme/save/provisioning surfaces unchanged** — `enter_doom_mode`/`exit_doom_mode`/`get_doom_mode_status`, `launch_doom_runtime`/`stop_doom_runtime`, `doom_read_state`/`doom_step`/`doom_frame`, `start/stop_doom_autoplay`, `get_doom_save`/`reset_doom_save`/`start_doom_autoplay`, `provision_doom_engine`/`get_doom_provision_status`, the `doom-status-changed`/`doom-autoplay-changed`/`doom-mode-changed`/`doom-provision-progress` events, and the `doom` window singleton behave identically; existing testids still render. (Links: `doom-mode/functional.md` slices 1–7.)
- [ ] R-40 (mandatory, SUPERSEDES R-34): **#3012 first-use provisioning/build path NOT regressed** — `resolve_toolchain_root` (managed `<install>/toolchain/msys2` only), `resolve_source_dir`/`resolve_build_script`, `run_provision`, `is_engine_staged`, and the `build-restful-doom.ps1` invocation are behaviourally identical; a CLEAN install dir + managed toolchain still builds and stages the engine; the REAL build is executed in the target toolchain and ends in `get_doom_status.phase="ready"` + `GET /api/state` 200 (a build/acquire exit 0 alone is NOT sufficient). (Links: `doom-mode/functional.md` F-97, F-81.)
- [ ] R-41: **IWAD resolution unchanged** — `resolve_iwad`/`configured_iwad` and the `FREDO_DOOM_IWAD_PATH` seam are OUT of scope and behave identically; the launch argv still passes the Freedoom IWAD. (Links: `doom-mode/functional.md` F-48 leg (b).)
- [ ] R-42: **Install-dir plane unchanged** — `resolve_install_dir` (`FREDO_DOOM_INSTALL_DIR` → `doom_install_dir` setting → `{app_data_dir}/doom`) still reads/writes as before; only the engine-path seam is removed; NO Settings-UI change. (Links: `settings/functional.md`.)
- [ ] R-43: **No process leak / no committed binary** — across every leg (absent, fail-engine, lever, success, restart) ZERO orphan `restful-doom.exe`; the repo/bundle still contain no committed `.exe`/`.wad`. (Links: `doom-mode/functional.md` F-76.)
- [ ] R-44: **PG-default boot + Mission Monitor unaffected** — `storage_engine_status` = PostgreSQL ready; Mission Monitor renders live sessions via the CURRENT declared `sessions` rollup (F-99 is the gate). (Links: `mission-monitor/functional.md`.)

### Links added by this slice

- `.opencode/tests/mission-monitor/` — F-99 E2E regression gate (unchanged surface).
- `.opencode/tests/settings/` — the `doom_install_dir` plane (unchanged).
- `.opencode/tests/postgres-lifecycle/`, `.opencode/tests/llama-setup/` — exit-hook co-existence.

---

## Game-only window + auto-play slice (Spec #3007) — must-not-change baseline

> **Verification policy: live** — the live-pipeline `telemetry_spans` reference (NON-ZERO count +
> recent `max(ingested_at)`) is required; Doom emits no span — DISCLOSE. Every wait bounded (G-263);
> a console `Error:`/`Uncaught`/`Maximum update depth exceeded` on any leg fails that leg.

- [ ] R-45: **Game-only surface — KEPT set renders, 19 removed hooks DOM-absent** — the `doom` window
  renders ONLY `doom-root`, `doom-frame-canvas`, `doom-frame-desc` (+ the minimal transient states and
  `doom-autoplay-note`); `querySelectorAll` count is 0 for each of the 19 removed hooks
  (`doom-window-title`, `doom-status`, `doom-exit-button`, `doom-engine-location`,
  `doom-engine-location-saved`, `doom-state-readout`, `doom-campaign-controls`, `doom-save-status`,
  `doom-progress-complete`, `doom-fresh-start-button`, `doom-fresh-start-confirm`,
  `doom-fresh-start-cancel`, `doom-autoplay-toggle`, `doom-autoplay-stop`, `doom-autoplay-status`,
  `doom-autoplay-elapsed`, `doom-autoplay-error`, `doom-step-button`, `doom-start-button`) — DOM-absence,
  not `display:none` (G-170 reverse). (Links: `doom-mode/functional.md` F-101/F-110.)
- [ ] R-46: **Auto-play on open, resume-by-default** — the `doom` window auto-starts the companion
  through the SAME idempotent `start_doom_autoplay` (no toggle/step control exists); resume-by-default
  (never a silent fresh run over a valid save); exactly ONE loop (`try_begin`). (Links:
  `doom-mode/functional.md` F-105/F-106/F-107.)
- [ ] R-47: **Close path stops the agent FIRST (bounded) + mode revert; no in-window exit control** —
  `teardown_doom_on_window_close` reuses `DoomAutoplayState::request_stop`/`stop_doom_autoplay` BEFORE
  the bounded engine stop; `doom-mode-changed {active:false}` is published; zero `restful-doom.exe`
  within `DOOM_STOP_TIMEOUT_S`; `doom-exit-button` never renders. The exit-button/voice paths that
  remain (`exit_doom_mode`) behave identically. (Links: `doom-mode/functional.md` F-108/F-109/F-110.)
- [ ] R-48: **Hotkeys cluster suppression is exactly `view=doom`** — the shared resting cluster
  (`hotkeys-input-regime` + `hotkeys-keys-discovery`) is absent ONLY in the doom webview; every other
  window renders it byte-identically. (Links: `doom-mode/functional.md` F-104.)
- [ ] R-49: **Auto-play/runtime commands unchanged for prior callers** — `enter_doom_mode`,
  `exit_doom_mode`, `get_doom_mode_status`, `start/stop_doom_autoplay`, `get_doom_autoplay_status`,
  `get/reset_doom_save`, `launch_doom_runtime`, `stop_doom_runtime`, `doom_read_state`/`doom_step`/
  `doom_frame`, and the `doom-status-changed`/`doom-autoplay-changed`/`doom-mode-changed` events are
  UNCHANGED; no new command/wire type/event is introduced. (Links: `doom-mode/functional.md` slices 1–7.)
- [ ] R-50: **PG-default boot + Mission Monitor unaffected + no process leak** — `storage_engine_status`
  = PostgreSQL / PG supervisor ready; Mission Monitor renders live sessions via the CURRENT declared
  `sessions` rollup (the F-114 E2E row is the gate); across every leg zero `restful-doom.exe` outlives
  its window/app; no second OS window. (Links: `mission-monitor/functional.md`, `doom-mode/functional.md` F-114.)

### Links added by this slice

- `.opencode/tests/mission-monitor/` — F-114 E2E regression gate (unchanged surface).
- `.opencode/tests/hotkeys/` — the shared resting cluster the `view=doom` gate suppresses.
