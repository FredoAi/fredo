# doom-autoplay-fluency — Functional Test Cases (Spec #3026)

> Durable functional suite (feature domain `doom-autoplay-fluency`). One `- [ ]` case per
> requirement; observable expected outcome per case. Formalizes the Implementation Plan #3026
> `### QA Plan`. This domain covers the **continuous-motion / frame-rate / pacing-fallback**
> capability introduced by #3026 (revises #2969): the engine clock decoupled from decisions
> (lever A), motion continuity + safety reflex (lever B), raw-framebuffer render transport
> (lever C), Doom-decision-path model latency (lever D), and the pacing fallback (lever E).
>
> **Verification policy: live** — the ≥30 fps observable, the continuity behaviour, and the
> model-unavailable fallback are running-system observables. The tester's Evidence MUST reference
> `telemetry_spans` (a live-query result: NON-ZERO count + recent `max(ingested_at)`; app-pool read
> preferred, G-307; managed `psql` on the PG default as a DISCLOSED fallback, G-284) at round start
> AND after the drive. **Doom emits NO OTLP span — the query proves the live pipeline, not the
> feature; DISCLOSE it.** A static-only PASS is a FALSE PASS (G-033).
>
> **No wall-clock flakiness (G-316 / AC5).** Every timing / frame-rate / continuity / fallback row
> is STEP-DRIVEN through the **injectable clock/tick seam** and replayed via the **#3023 ST-9
> deterministic engine driver** (`run_bounded_driver`, `applications/doom/engine.rs:583`) — never
> asserted on real wall-clock timing. `DoomDriverConfig`/`DoomDriverReport` are at
> `engine.rs:486`/`:526`.
>
> **G-216 — motion is rendered-over-time, not property existence.** REQ-2 is a dense full-frame
> 320×200 pixel delta over a bounded simulated window with named cadence/window/delta/coverage
> constants and a per-target floor, corroborated by a human/vision read of the recorded sequence.
> **Evidence renderability (G-104):** evidence frames are named WITHOUT image extensions in prose;
> `.png` tokens appear only on lines that also carry an `https://` URL; link labels are descriptive.
>
> **G-300 / G-275 — every error/failure edge names an in-repo induction lever.** The decision-source
> scripted lever (`FREDO_DOOM_AGENT_DECISION_SOURCE=scripted` + `FREDO_DOOM_AGENT_SCRIPT` →
> `.opencode/tmp/3026/agent-script.json`, `applications/doom/decision.rs:132`) drives the
> unavailable path (`{"error":"..."}`); the "slower than the tick loop" leg needs a delay/stall
> entry (see F-6). Lever E == `{"error":"model unavailable"}` repeating.
>
> **Scratch:** `.opencode/tmp/3026/`. Env overrides via the `dev-environment` skill
> (`dev-env.ps1 -EnvVar`, single delimited / helper-script form).

## Named constants (G-216 — Architect to fix the literals)

`DOOM_TICK_HZ` (continuous loop, ~35 tics/s — lever A) · `DOOM_FRAME_FPS_TARGET` (=30) ·
`DOOM_FLUENCY_WINDOW_S` (=5) · `DOOM_FRAME_DELTA_FLOOR` (min dense full-frame pixel diff) ·
`DOOM_FRAME_DIFF_COVERAGE` = full 320×200 framebuffer (G-213) · `DOOM_DEGRADED_FPS_FLOOR` (lever E) ·
`DOOM_MAX_FRAME_GAP` (the "never freezes" bound).

## Continuous advance independent of decisions (AC1 / lever A)

- [ ] F-1 (AC1, REQUIRED) **Motion does not stop for a decision round-trip.** Drive the ST-9
  deterministic driver over a bounded window while the injected decision source STALLS (never
  answers — F-6 delay/stall entry).
  - EXPECTED: while a decision is in flight the engine tic counter and framebuffer ADVANCE every
    tick: `DoomDriverReport.last_tic > start_tic`; the per-tick delta is ≥ 1 across the stalled
    window; consecutive frames are DISTINCT (pixel diff ≥ `DOOM_FRAME_DELTA_FLOOR`); the render
    never blocks on `source.decide`.
  - Edge: decision never returns; returns after N ticks; errors mid-window; empty action set
    (hold-last); first tick before any decision.

## ≥ ~30 fps of distinct advancing frames (AC2 / G-216)

- [ ] F-2 (AC2, REQUIRED, G-216) **Sustained ≥30 fps of frames reflecting the advancing world.**
  Measure rendered pixel delta over simulated TIME on `doom-frame-canvas` from the seam-driven run
  plus a recorded bounded frame sequence under `.opencode/tmp/3026/e2e/`.
  - EXPECTED: over `DOOM_FLUENCY_WINDOW_S` (=5) simulated seconds the count of consecutive DISTINCT
    frames (dense full-frame 320×200 pixel diff ≥ `DOOM_FRAME_DELTA_FLOOR`) ≥
    `DOOM_FRAME_FPS_TARGET`(=30) × window = **≥150**; NO static redelivery pair (each consecutive
    pair is distinct — NOT poll ticks redelivering a static image); corroborated by a human/vision
    read of the bounded sequence.
  - Edge: measurement window landing inside one animation cycle → add a full-cycle seek so a
    one-phase window cannot present as a settle; a render stall; canvas scale/aspect unchanged.

## Hold-last + safety reflex (AC3 / lever B)

- [ ] F-3 (AC3, REQUIRED, edge/graceful-degrade) **Continue the last action between decisions.**
  Scripted decisions repeat one action while `source.decide` is stalled; drive the bounded run.
  - EXPECTED: with no new decision the companion CONTINUES its last action — the world keeps
    advancing (`last_tic` strictly increases; frames distinct).
  - Edge: no decision ever arrives; the held action is empty (`actions:[]`).

- [ ] F-4 (AC3, REQUIRED, edge/graceful-degrade) **Safety reflex overrides obvious self-harm.**
  Two scripted legs: (a) repeated `forward` into a wall (no progress); (b) `fire` with NO target.
  - EXPECTED: (a) the reflex REPLACES the held action when it would run blindly into a wall —
    observable: the run does NOT stall (position/angle keeps changing over the window) AND the
    issued-action audit flags a reflex override; (b) fire is RELEASED when no target is present —
    observable: player ammo does NOT decrement while no target is present.
  - Lever (G-300): the issued-action/reflex audit (extend the `FREDO_DOOM_AGENT_LOG_DIR` JSONL at
    `applications/llm_server/doom_agent.rs:60`, or a tick-loop audit); the wall/no-target states
    via map reset/positioning (`engine.rs:436` `reset`) or a scripted action sequence.
  - Edge: wall AND no-target simultaneously; the reflex does not itself create self-harm (e.g.
    turn into a hazard); decision never arrives (pure hold) — the reflex still applies.

## Pacing fallback — never freeze, never crash, bounded teardown (AC4 / lever E)

- [ ] F-5 (AC4, REQUIRED, negative/edge, G-300/G-275) **Model decision stream unavailable → lower
  sim rate, smooth frames.** Repeat `{"error":"model unavailable"}` via
  `FREDO_DOOM_AGENT_SCRIPT`; drive the seam.
  - EXPECTED: the run NEVER freezes — consecutive DISTINCT frames continue at a degraded cadence
    ≥ `DOOM_DEGRADED_FPS_FLOOR` with NO inter-frame gap > `DOOM_MAX_FRAME_GAP`; the sim rate is
    < `DOOM_TICK_HZ`; the phase settles (degraded-Running or terminal Failed) within bound; no panic
    and no console `Error:`/`Uncaught`/`Maximum update depth exceeded`.
  - Edge: model never answers at all; model unavailable THEN recovers; deaths during degrade.

- [ ] F-6 (AC4, REQUIRED, negative/edge, G-300/G-275) **Model slower than the tick loop → smooth
  degraded frames.** Drive a delay/stall entry (the REQ-4 induction lever — see Required test data).
  - EXPECTED: identical to F-5 — motion continues smoothly at a lower rate; never freezes; never
    crashes; the degraded cadence floor and the max-frame-gap bound both hold.
  - Edge: partial/very-slow answers; long stall then a burst of answers; window close mid-degrade.
  - **G-300 note:** this leg REQUIRES the Developer to add a delay/stall entry (`{"delayMs":N}` /
    `{"stall":true}`) to `applications/doom/decision.rs:132`. If it is not shipped, this row is a
    static/unit pin MARKED non-AC — never left UNVERIFIED.

- [ ] F-7 (AC4, G-263) **Bounded teardown / no orphan on window close.** Close the `doom` window
  during an active/degrading run; poll.
  - EXPECTED: `get_doom_autoplay_status.phase` ≠ `Running`; the continuous tick loop/worker is
    HARD-stopped on every exit path; ZERO orphan thread/engine image; process inventory = only
    `fredo.exe` (native in-process engine); teardown ≤ `DOOM_STOP_TIMEOUT_S` (=5).
  - Edge: close while a decision is in flight; close while degrading; rapid open/close; app exit
    (`RunEvent::Exit`) — the Doom + `llama-server` + PG exit hooks all complete.

## Determinism via the injectable clock/tick seam (AC5)

- [ ] F-8 (AC5, REQUIRED) **ST-9 reproduces an identical bounded run.** Run `run_bounded_driver`
  TWICE with identical scripted decisions + the injected clock/ticker.
  - EXPECTED: the two `DoomDriverReport`s are IDENTICAL field-for-field — `steps`, `decisions`,
    `failures`, `start_tic`, `last_tic`, `start_x/start_y`, `last_x/last_y`, `terminal`.
  - Edge: wall-clock jitter must not leak into the report; a different seed/map changes the report
    (sanity that it is not a constant); N repeated runs stable.
  - Static pin (non-AC companion): the tick loop consumes the injected seam — no direct
    `Instant::now()`/`tokio::time::sleep` in the tick loop.

## Non-functional

- [ ] F-9 (NFR, build, Windows-only) **CI-parity build hygiene.** EXPECTED: `cargo check --locked`
  ZERO warnings; `cargo clippy --locked -- -D warnings` clean; `cargo test --locked` green;
  `pnpm --filter @fredo/ui build` green; no `#[allow(...)]` suppressions.
- [ ] F-10 (NFR, no-network) **No new listener; engine loopback-free.** EXPECTED: static grep of
  the tick/render path shows no new `TcpListener`/socket; the live port check shows no Doom-owned
  listener; the raw-framebuffer `putImageData` transport adds no HTTP.
- [ ] F-11 (REG, G-300, non-AC) **Visible surface unchanged (#3007) + PNG poll retired.** EXPECTED:
  `doom-root` + `doom-frame-canvas` + `doom-frame-desc` still render; the 19 #3007-removed hooks
  stay DOM-absent; `DoomWindow.tsx` no longer drives the canvas from `doom_frame`/`DOOM_FRAME_POLL_MS`
  (`state.rs:36`) — static pin: `grep doom_frame`/`DOOM_FRAME_POLL_MS` absent from the render loop.
- [ ] F-LIVE (live-pipeline receipt) Query `telemetry_spans` at round start AND after the drive.
  EXPECTED: NON-ZERO count + recent `max(ingested_at)` BOTH times. Doom emits no span — DISCLOSE.
  Edge: managed-`psql` pool-saturated → app-pool `feature_data_read` substitution, DISCLOSED (G-307).

**Coverage:** AC1→F-1 · AC2→F-2 · AC3→F-3/F-4 · AC4→F-5/F-6/F-7 · AC5→F-8 · NFR→F-9/F-10/F-11/F-LIVE.
