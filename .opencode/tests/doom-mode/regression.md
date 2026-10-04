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

- [ ] R-10: **Mission Monitor unaffected by autoplay** — with the Doom autoplay surface
  present (and after a run), Mission Monitor still renders live sessions; the F-31 E2E row
  is the gate. (Links: `mission-monitor/functional.md`.)
- [ ] R-11: **Frame-poll path unchanged** — `DoomWindow.tsx:228-239` still polls
  `doom_frame` at `DOOM_FRAME_POLL_MS=66`; autoplay DRIVES steps and the display loop is
  not modified or blocked (no idle-frame motion introduced — G-316).
- [ ] R-12: **Existing Doom surface unchanged** — `doom_read_state`/`doom_step`/`doom_frame`,
  `doom-status-changed`, launch/teardown, and the window singleton behave identically; the
  loop reuses the slice-1 supervised child and spawns NO new engine process; existing testids
  (`doom-root`, `doom-frame-canvas`, `doom-state-readout`, `doom-step-button`, …) still render.

### Links added by this slice

- `.opencode/tests/mission-monitor/` — F-31 E2E regression gate (unchanged surface).
- `.opencode/tests/llama-setup/` — the managed `llama-server` + Gemma model files the model
  decision leg depends on (named TOOLING GAP if absent).
