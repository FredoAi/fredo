# doom-observation-geometry — Functional Test Cases (Spec #3030)

> Durable functional suite (feature domain `doom-observation-geometry`). One `- [ ]` case per
> requirement; observable expected outcome per case. Formalizes the Implementation Plan #3030
> `### QA Plan`. This domain covers the **additive, bounded wall/obstacle geometry** added to the
> Doom Companion's model observation (`applications/doom/engine.rs:999 observation()`), derived
> from neurodoom's `semantic_buffer()` / `depth_buffer()` / `perception::PerceptionFrame`.
> Existing observation keys (`tic/done/outcome/level/player/enemies/items/doors/exit`) MUST survive.
>
> **Verification policy: live** — the observation flows through a running engine and the model
> source. The tester's Evidence MUST reference `telemetry_spans` (a live-query result: NON-ZERO
> count + recent `max(ingested_at)`; app-pool read preferred, G-307; managed `psql` on the PG
> default as a DISCLOSED fallback, G-284) at round start AND after the drive. **Doom emits NO OTLP
> span — the query proves the live pipeline, not the feature; DISCLOSE it.** A static-only PASS is
> a FALSE PASS (G-033).
>
> **Feature receipt.** The observation-to-model receipt is the `FREDO_DOOM_AGENT_LOG_DIR`
> request-audit JSONL (`applications/llm_server/doom_agent.rs:60`): it shows the geometry inside
> `observation` in the user message sent to `llama-server`.
>
> **Read surface.** Live observation via the `doom_read_state` IPC (`raw`) and `doom_step` IPC
> (`state`) — the observation is returned verbatim (`commands.rs:283/298`).
>
> **Architect-owned literals (pin before convergence).** Geometry field name (working `walls`, alt
> `obstacles`) + entry shape (`direction`/`distance`/`blocked`), `DOOM_PERCEPTION_NEAR_RANGE`,
> `DOOM_PERCEPTION_SAMPLING_RANGE`, the count bound (default `OBSERVATION_MAX_ENTRIES` = 16), and
> `DOOM_OBSERVATION_BYTE_BUDGET` / `DOOM_REQUEST_BYTE_BUDGET`. Assert against these literals.
>
> **Step-driven (G-316).** The engine advances only on `step`/`reset` — never assert idle wall-clock
> motion. Force a position with `doom_step`.
>
> **Scratch:** `.opencode/tmp/3030/` (env overrides via `dev-env.ps1 -EnvVar`).

## AC1 — geometry added to the observation (ADDITIVE)

- [ ] F-1 (REQ-1, AC1, REQUIRED, live) **Live observation carries bounded wall/obstacle geometry
  alongside the existing fields.** Launch the native engine (`enter_doom_mode` or
  `launch_doom_runtime`); read `doom_read_state` (`raw`); read the audit JSONL under
  `FREDO_DOOM_AGENT_LOG_DIR`.
  - EXPECTED: (a) `raw` carries a NEW bounded geometry field (Architect-pinned key; working
    `walls`) IN ADDITION to the unchanged `tic/done/outcome/level/player/enemies/items/doors/exit`;
    (b) each entry carries scalar `direction`+`distance` (and/or a `blocked`/`near` flag); (c) the
    collection length ≤ the count bound (16); (d) the geometry values track the rendered scene
    (derived from the semantic/depth buffers, `engine.rs:999`); (e) the SAME geometry appears inside
    `observation` in the audit JSONL user message.
  - Edge: open space → the field is PRESENT (may be empty `[]`), never absent; >16 candidates are
    CAPPED; no per-pixel payload.

## AC2 — forward obstruction within range → near/blocked

- [ ] F-2 (REQ-2, AC2, REQUIRED, live) **Forward obstruction reports a near/blocked distance.**
  From the live E1M1 engine, drive `doom_step({tics:35, actions:[{type:"forward","amount":35}]})`
  (≤ 20×) until `state.player.x/y` stops changing (player pressed to the wall); optionally first
  `doom_step({tics:1, actions:[{type:"turn-to","angle":A}]})` to face the nearest wall.
  - EXPECTED: the returned observation reports a forward near/blocked signal — a forward entry /
    `blocked` flag with `distance ≤ DOOM_PERCEPTION_NEAR_RANGE` — while `player.x/y` is no longer
    advancing.
  - Edge: obstruction just BEYOND the sampling range → NOT near (F-5); a SIDE wall is not
    mislabelled forward; sliding along a wall keeps forward-near true while lateral motion
    continues.

## AC3 — enemy LOS-gated intel preserved

- [ ] F-3 (REQ-3, AC3, REQUIRED, live) **Enemies retain direction + distance (LOS unchanged).**
  Drive a live run until `enemies` is non-empty; read the observation.
  - EXPECTED: each `enemies` entry STILL carries `kind`+`hp`+`direction`+`distance`; no entry is
    dropped/replaced by the geometry addition; the list is still capped at 16.
  - Edge: an enemy behind a wall stays ABSENT (LOS unchanged); geometry AND an enemy co-present in
    one observation.

## AC4 — buffer-unavailable fallback, run not failed (NEGATIVE)

- [ ] F-4 (REQ-4, AC4, REQUIRED, live, negative, G-275/G-300) **Buffers unavailable → current field
  set; run not failed.** Relaunch with `FREDO_DOOM_FAIL_PERCEPTION=1`; read the observation and let
  an autoplay run proceed.
  - EXPECTED: the observation FALLS BACK to the current field set — it parses; all pre-existing
    fields are present and unchanged; the geometry field is absent / empty / `null`; never a panic
    or partial row. The run does NOT fail: `doom_read_state`/`doom_step` succeed,
    `get_doom_autoplay_status.phase` keeps advancing (never sticky `Failed`), and a model decision
    still settles (new audit JSONL record).
  - Edge: unsetting the lever restores geometry; fallback on the FIRST observation (before any
    render); console clean of `Error:`/`Uncaught`.
  - **Induction lever:** `FREDO_DOOM_FAIL_PERCEPTION=1` (MUST be shipped, inert when unset) + the
    pure unit injection of `None` for the `PerceptionFrame`. **No lever ⇒ this row is
    UNVERIFIED-with-named-blocker, never PASS.**

## QA-authored edge rows

- [ ] F-5 (EDGE-RANGE, non-AC, live) **Obstruction beyond sampling range → not near.** From a
  corridor/room where the nearest forward wall exceeds `DOOM_PERCEPTION_SAMPLING_RANGE`, read the
  observation.
  - EXPECTED: NO forward near/blocked report (or `distance > DOOM_PERCEPTION_NEAR_RANGE`); the
    observation is valid and bounded.
  - Edge: exactly at the range boundary; turning AWAY from a nearby wall (behind → not forward).

- [ ] F-6 (NFR-BOUND, non-AC, live) **Bounded payload — no per-pixel geometry.** Serialize the live
  observation and the Doom request body.
  - EXPECTED: (a) `JSON.stringify(observation)` ≤ `DOOM_OBSERVATION_BYTE_BUDGET`; (b) request
    `messages[1].content` ≤ `DOOM_REQUEST_BYTE_BUDGET`; (c) NO array whose length scales with the
    320×200 framebuffer (~64,000) is present; (d) geometry collection length ≤ 16.
  - Edge: worst-case busy scene holds the budget; payload does not grow between two steps at the
    same scene.

- [ ] F-7 (NFR-DET, non-AC; static/unit pin + live re-read, G-316) **Deterministic geometry.** Unit
  pin: `run_bounded_driver` twice with identical scripted decisions + `FixedTickClock`
  (`engine.rs:621`) → identical `DoomDriverReport`. Live: `reset` to E1M1 twice and read at the same
  position/angle.
  - EXPECTED: byte-identical driver reports (`steps`,`last_tic`,`start_x/y`,`last_x/y`,`terminal`);
    byte-identical live geometry across reads.
  - Edge: a different map/position changes the geometry (not a constant); the builder reads no
    clock/RNG.

## Non-functional

- [ ] F-8 (NFR, build) **CI-parity build hygiene.** EXPECTED: `cargo check --locked` ZERO warnings;
  `cargo clippy --locked -- -D warnings` clean; `cargo test --locked` green; `pnpm --filter @fredo/ui
  build` green if UI touched; no `#[allow(...)]` suppressions.
- [ ] F-9 (NFR, regression) **Additive only — no policy/model change.** EXPECTED: the Doom policy,
  persona/system prompt, `llama-server` serving config, existing observation keys, and the `doom`
  window surface are UNCHANGED; no new listener/orphan; console clean.
- [ ] F-LIVE (live-pipeline receipt) Query `telemetry_spans` at round start AND after the drive.
  EXPECTED: NON-ZERO count + recent `max(ingested_at)` BOTH times. **Doom emits no span — DISCLOSE.**
  Edge: managed-`psql` pool-saturated → app-pool read substitution, DISCLOSED (G-307/G-284).

**Coverage:** AC1→F-1 · AC2→F-2 · AC3→F-3 · AC4→F-4 · edges→F-5/F-6/F-7 · NFR→F-8/F-9/F-LIVE.
