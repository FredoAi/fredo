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
  loop reuses the slice-1 supervised child and spawns NO new engine process; existing testids
  (`doom-root`, `doom-frame-canvas`, `doom-state-readout`, `doom-step-button`, …) still render.

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
- [x] R-16 (PASS 2026-10-05 #2970 r1 — `doom_read_state`/`doom_step`/`doom_frame`, `get_doom_status`, autoplay status/toggle, and the window singleton behaved identically; existing testids (`doom-root`, `doom-window-title`, `doom-frame-canvas`, `doom-state-readout`, `doom-step-button`, `doom-autoplay-toggle`, …) still rendered; the new `doom-exit-button` is additive): **Existing Doom runtime/autoplay surface unchanged** — `launch_doom_runtime`, `stop_doom_runtime`, `doom_read_state`, `doom_step`, `doom_frame`, `start/stop_doom_autoplay`, `doom-status-changed`, and the window singleton behave identically; the existing testids (`doom-root`, `doom-window-title`, `doom-frame-canvas`, `doom-state-readout`, `doom-step-button`, `doom-autoplay-toggle`, …) still render; the new `doom-exit-button` is additive. (Links: `doom-mode/functional.md` slice 1/2.)
- [x] R-17 (PASS 2026-10-05 #2970 r1 — `with_app_control()` pins unchanged (ST-4 unit tests); `with_app_control_and_doom()` additive offer order `open_app, close_app, doom_mode`; the frontend filter ignored a non-doom skill (`weather`) with zero spurious action): **Companion skill registry pins unchanged** — `with_app_control()` and its tests are untouched; `with_app_control_and_doom()` is additive with offer order `open_app, close_app, doom_mode`. The `useAppOpenRequests` filter (`useAppOpenRequests.ts:168-174`) still ignores non-open/close skills (zero spurious opens). (Links: `companion/functional.md`.)
- [x] R-18 (PASS 2026-10-05 #2970 r1 — after every activation/exit leg zero `restful-doom.exe` outlived its window/app; `tasklist` confirmed a single engine PID while active and none after exit; no SDL second OS window observed): **No process leak / no second OS window** — across every activation/exit leg zero `restful-doom.exe` outlives its window/app (N-8); no SDL second OS window; `-noblit` still serves `/api/frame`. (Links: `doom-mode/functional.md` F-39-42.)
- [x] R-19 (PASS 2026-10-05 #2970 r1 — Mission Monitor rendered the seeded `e2e-copilot2933` session while the secret-activation slice was present; the F-50 E2E row is the gate): **Mission Monitor unaffected** — renders live sessions normally with the secret-activation slice present; the F-50 E2E row is the gate. (Links: `mission-monitor/functional.md`.)

### Links added by this slice

- `.opencode/tests/mission-monitor/` — F-50 E2E regression gate (unchanged surface).
- `.opencode/tests/voice-dictation/` — the capture + model-audio pipeline the suppression gate reads (`session.rs`, `commands.rs`).
