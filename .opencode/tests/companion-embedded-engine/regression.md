# Companion Embedded Engine — Regression

> "Must not change" baseline for the in-process companion engine migration (Spec #3141). Every
> row is a live consumer of the old out-of-process surface that ST-1…ST-6 must keep working
> after the re-point. Any FAIL is a regression.
> **Verification policy: live** (except the explicitly static pins), with the LIVE WEBVIEW
> receipt — **no `telemetry_spans` receipt is expected for this feature** (it emits no OTLP
> producer of its own).

## Must NOT change

- [ ] **R-1 (event contract, cross-ref functional F-16/F-17/F-18).** `llm-token` (string),
      `llm-done` (empty), `llm-error` (string), `llm-status` (string), `llm-skill-call`
      (`{skill, arguments}`) keep their names and payload shapes; `llm-status` stays **before**
      `llm-done` and **never** appears on a skill/error turn; every path ends with exactly one
      `llm-done`.
  - **Divisors:** `apps/ui/src/app/adapters/TauriAdapter.ts` (`:79`/`:87`/`:93`/`:166`/`:375`);
    `apps/ui/src/app/adapters/adapterBridge.ts:193-194` (the Doom second consumer).
  - **Edge:** the audio-suppression refusal keeps its shipped `disabled` code (no new enum).
- [ ] **R-2 (Doom autoplay — the live consumer re-pointed in ST-3).** Drive the companion's Doom
      autonomous play once on the embedded engine.
  - **Expected:** the Doom decision still **parses** (a legal plan/decision is produced and the
      engine advances), the decision trace still reports a `model_id` and `reasoning=…` value,
      and there is no crash or hang. **The Doom path is a live consumer of `chat::run_stream`
      (`doom_agent.rs:396`) — deleting it without the re-point would silently break autoplay.**
  - **Divisor:** `applications/llm_server/doom_agent.rs` (`:157` request body, `:192`
    `model_id_from`, `:214` `server_flags_from`, `:396` the stream drive).
  - **Edge:** the request body still uses `response_format: json_schema` (Doom plan schema) and
    still bounds `max_tokens` on the Doom path only; a malformed model reply still falls back to
    a legal move (never a crash).
  - **Cross-ref** `.opencode/tests/doom-companion-planning/`
    (`FREDO_DOOM_AGENT_DECISION_SOURCE=scripted` + `FREDO_DOOM_AGENT_SCRIPT` — a scripted source
    does NOT exercise the embedded engine; this row needs a real model decision).
- [ ] **R-3 (Launcher health LED — the `normalizeCompanion` regression).** On the engine migration
      tip, read the launcher LED tooltip in the **model-files-present, engine-idle** state
      (model files present; the engine not started).
  - **Expected (UI/UX §5.2 truth-table row, verbatim):** the companion lines are **populated from
    the engine's own state**, not stuck at `unknown` forever. With `modelFilesComplete: true` and
    `llamaServer: {running: false, healthy: false}`, `health-line-companionModel` reads `healthy`
    ("Model files present") and `health-line-llamaServer` reads **`down` / "Not running"** (the
    line *label* is `Companion engine`; the subsystem **id stays `llamaServer`**); the overall is
    exactly **`Degraded`** — never `unknown`, never neutral-forever, never `Down`. **The current
    `normalizeCompanion` (`apps/ui/src/shared/hooks/useFredoHealth.ts:161-183`) returns `null`
    unless BOTH `llamaServer` AND `modelFiles` prerequisites exist — ST-6 removes the `llamaServer`
    prerequisite, so this row FAILs unless the normalizer is rewritten in the same change.**
  - **Edge (RE-KEYED `notSetUp` boundary):** `FREDO_COMPANION_FORCE_NOT_INSTALLED=1` (post-#3141:
    forces `modelFiles` `Missing` only) ⇒ an **empty model set reads `notSetUp` / "Not set up" on
    BOTH lines**, overall **healthy** — post-#3141 "set up" means "model files present", so a fresh
    offline machine never boots to a spurious `Degraded`; the `down` line is reserved for the
    configured-but-not-running state above. The neutral state must still exist; the LED never
    goes permanently neutral on a healthy machine.
  - **Cross-ref** `.opencode/tests/fredo-health-led/` F-5/F-6 and the new F-15 there.
- [ ] **R-4 (readiness + wizard gate, cross-ref `llama-setup`).** Settings → Companion on a
      not-ready machine still renders the wizard (never the ready-branch body), and the wizard
      summary counts only the remaining GGUF prerequisites.
  - **Expected:** the `llamaServer` step/card and the `Install llama.cpp` action are **gone**;
    `check_companion_readiness` reports the model-files prerequisite only; readiness flips
    `false → true` in place after a successful download (no reload — `performance.timeOrigin`
    unchanged). The ready-branch body is NOT rendered while not ready — **except** the engine
    group, which renders below the wizard when model files are `installed` (AC-25 recovery
    reachability, F-13b); that is the one intended render in the not-ready branch, not a gate leak.
  - **Edge:** `.opencode/tests/llama-setup/` F-01…F-17 assumed a two-prerequisite gate; those
    rows that assert the `llamaServer` row/`Install llama.cpp` are **superseded** by #3141 and
    must not be read as regressions (see the supersession note added there). The
    model-files/download rows stay in force.
- [ ] **R-5 (voice capture path untouched).** `infrastructure/voice/**` stays free of
      network/process symbols; the model-audio turn still flows through the ONE production
      renderer (no second request-shaping rule).
  - **Divisor:** `.opencode/tests/companion-audio-skill-parity/` (F-1/F-2 offer parity, F-9
    `voice_invariants` boundary assertions, F-13 guard set) and `.opencode/tests/voice-input/`.
  - **Edge:** the audio turn still shapes exactly ONE `input_audio` part and no text part; the
    skill offer is byte-equal between the typed and audio turns.
- [ ] **R-6 (settings path-key validation).** `SENSITIVE_PATH_SETTING_KEYS` still validates the
      remaining sensitive path keys; dropping `llama_server_path` must not drop
      `llama_server_companion_dir` / `terminal_copilot_path` / `terminal_pwsh_path`.
  - **Divisor:** `applications/settings/commands.rs:13-18` (4 → 3 keys) and
    `.opencode/tests/webview-security-boundary/` functional `:173`.
  - **Edge:** a control character / relative / `..` value on each remaining key is still
    rejected; the removed key no longer needs validation (it is never read).
- [ ] **R-7 (per-environment isolation, cross-ref `multi-env-isolation`).** Two isolated envs
      each run their own engine with their own companion directory and their own backend
      selection; neither observes the other's engine state.
  - **Expected:** the per-env companion directory override
    (`FREDO_LLAMA_SERVER_COMPANION_DIR`, kept byte-identical, relocated to `paths.rs`) still
    isolates the companion dir; the removed `FREDO_LLAMA_SERVER_PORT` leaves no dangling
    consumer (env parse, `companion_env_overrides`, the startup log line, the tests);
    `verify-env-isolation.ps1` still exits 0 with two live envs and no `ports.llama` entry.
  - **Edge:** `dev-env.ps1` must no longer emit a `llama` port slot; a stale manifest field ⇒
    FAIL. Cross-ref `.opencode/tests/multi-env-isolation/` F-1/F-2 and `env-isolation/`.
- [ ] **R-8 (acquisition engine untouched).** `infrastructure/companion/download.rs` and the
      manifest's URLs/SHAs are byte-identical; `check_model_files` still reports the three files
      in fixed order `model → vision → mtp`.
  - **Edge:** the Download action still skips present files and resumes a partial (cross-ref
    `.opencode/tests/llama-setup/` F-18…F-31); this migration must not change acquisition.
- [ ] **R-9 (console hygiene / no re-render loop).** After every live leg, `tauri_read_logs
      (source="console")` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`; no new
      effect depends on array `.length` or freshly-created refs (AGENTS.md #523); the status
      probe is still bounded (≤1 probe-set per `HEALTH_POLL_INTERVAL_MS`).
  - **Edge:** read the console AFTER the interaction, not only at boot; check every window.
- [ ] **R-10 (shipped vision/audio consumers, cross-ref functional F-8/F-9).** The TicTacToe
      image move still captures the board region (`capture_screen_region` → `llm_chat_with_image`)
      and places a legal O; the companion audio turn still delivers exactly one `input_audio`
      part and no transcript text (`Regression R-5` binds the voice-module boundary; this row
      binds the ENGINE turn shape).
  - **Divisors:** `apps/ui/src/shared/components/companion/features/tictactoe/TicTacToe.tsx`
    (`capture_screen_region` → `llmChatWithImage`, the legal-move fallback); `llm_chat_with_audio`'s
    shipped Doom-Mode refusal (`applications/llm_server/commands.rs:816-847`).
  - **Edge:** a capture/engine error still falls back to a legal random move (never a crash);
    the audio refusal still emits one `llm-done`.

## Cross-suite links

- `.opencode/tests/llama-setup/` — wizard, model acquisition, launch step (rows asserting the
  removed `llamaServer` prerequisite are superseded by #3141).
- `.opencode/tests/companion/` — companion overlay, bubble, TicTacToe vision move.
- `.opencode/tests/fredo-health-led/` — LED normalization (R-3 here).
- `.opencode/tests/companion-audio-skill-parity/` — skill offer parity + audio turn.
- `.opencode/tests/multi-env-isolation/`, `.opencode/tests/env-isolation/` — isolation.
- `.opencode/tests/doom-companion-planning/`, `.opencode/tests/doom-autoplay-fluency/` — Doom.

---

# Spec #3180 — re-scope of R-3 (engine-idle no longer `down`), plus the launch-start invariants

> Feature issue **#3180**. R-3 above is retained byte-identical as history and **its idle clause is
> SUPERSEDED**: with the launch auto-start + the honest in-flight state, an idle (non-failed) engine
> reads NEUTRAL `unknown` / `Idle` and the overall is NOT degraded by it. `down` / `Could not start`
> is reserved for a TYPED failure and then always carries a remedy + technical detail.
> Every other R-3 clause (both lines populated, the `notSetUp` boundary, never stuck `unknown`
> forever) still holds.

- [ ] **R-11 (SUPERSEDES R-3's idle clause, #3180 AC-4.2).** Model files present + engine idle
      (`running:false, healthy:false, starting:false, lastErrorCode` absent) ⇒
      `health-line-llamaServer` `data-health-state="unknown"` text `Idle`; overall NOT `degraded`
      from this line. Driven live by `stop_llama_server` after a healthy launch start (functional
      FR-29 leg b). The old expectation (`down` / `Not running` + `Degraded`) must NOT be restored.
- [ ] **R-12 (#3180 AC-1.2 — the launch start is not a second spawn site).** Still exactly ONE
      engine thread and no child process: `Get-Process -Name llama-server` finds nothing on every
      sample, one stable `modelId` across the launch start and a later lazy turn, and
      `DEFAULT_START_BUDGET` remains 120 s. Tying the start to launch must not widen the engine's
      ownership model (ENGINEERING_RULES: one thread, channel-only access).
- [ ] **R-13 (#3180 AC-4.3 — the lazy `Chat` path stays the fallback).** After a manual
      `stop_llama_server`, a user turn still starts the engine through the shipped lazy path
      (`ensure_started`) and settles with exactly one `llm-done`; the launch trigger is
      process-once and never restarts a deliberately stopped engine.
- [ ] **R-14 (#3180 — settings ordering).** The launch start resolves the backend mode AFTER
      hydration: a persisted `cpu` / `gpu` selection is honoured on the launch start (the
      `gpuUnavailable` leg in FR-32 depends on it). A launch start that used the pre-hydration
      default (`auto`) would silently ignore the user's choice — FAIL.
- [ ] **R-15 (#3180 — the push channel has a real emitter and costs no IPC).** `llama-server-status`
      is emitted from Rust (`EventBus::emit_global`) on start completion/failure and the existing
      listener applies it with ZERO extra IPC; no new poll is introduced (cross-ref
      `fredo-health-led` F-19).

---

# Spec #3233 — per-turn thinking policy + the empty-turn guarantee

> "Must not change" baseline for **#3233** (per-turn thinking policy + the empty-turn guarantee).
> **Verification policy: live** (except the static pins), same receipt channels as the functional
> section. Rows merged from the QA draft fragment (`.opencode/tmp/3233/suite/`).

- [ ] **R-16 (#3233 AC-3 / R-3 — Doom keeps thinking ON, parses, and stamps the SERVED mode).**
      Drive a **real** Doom decision on the embedded engine (a scripted Doom source does NOT exercise
      the engine — see R-2's edge) and read the decision record.
  - **Expected:** `classify_doom_reply` parses to a **valid `DoomPlan`** (a legal plan/decision), no
    crash/hang; the Doom dataset decision record's **`server_flags == "reasoning=on"`**
    (`applications/doom/dataset.rs:228` ← `applications/doom/agent.rs:1282` ←
    `DoomDecisionTrace.server_flags` `infrastructure/companion/doom_decision.rs:179`) — the stamp
    describes what was **served**. `doom_turn` (`doom_agent.rs:214-218`) opts in
    `.with_reasoning(ReasoningMode::Enabled)` and `server_flags_from` (`:248-256`) renders the
    TURN's mode.
  - **Failability (G-476):** revert ST-4 → the Doom turn inherits `ChatTurn::text`'s new `Disabled`
    default → it stamps **`reasoning=off`** and the constrained parse degrades ⇒ this row reddens. A
    `server_flags` reading `reasoning=on` from the *retired persisted arg* while the turn ran OFF is
    the exact FAIL (the stamp must describe the served mode).
  - **Edge:** Doom schema / `max_tokens` / persona unchanged; a malformed reply still falls back to
    a legal move (never a crash). Cross-ref `R-2` (retained byte-identical) and
    `.opencode/tests/doom-companion-planning/`.

- [ ] **R-17 (#3233 — the wire vocabulary is byte-compatible).** Retained as `R-1`; re-asserted here
      because #3233 touches the terminal-emit path (`plan_terminal_events`).
  - **Expected:** `llm-token` (string), `llm-done` (empty), `llm-error` (string), `llm-status`
    (string), `llm-skill-call` (`{skill, arguments}`) keep their names and payload shapes; every
    path ends with exactly **one** `llm-done` and it is **last**; `llm-status` stays **before**
    `llm-done` and **never** appears on a skill/error turn; **no new `llm-*` channel** appears.
  - **Divisor:** `apps/ui/src/app/adapters/TauriAdapter.ts`; `adapterBridge.ts:193-194`.
  - **Edge:** a new sixth channel ⇒ FAIL (byte-compatibility).

- [ ] **R-18 (#3233 — the hidden-reasoning containment stays; the gate's reasoning classification
      is NOT removed).** The issue's non-goal: no removal of reasoning support.
  - **Expected:** `F-26` stays green — a reasoning-first generation never leaks `<|channel>thought
    …` into `llm-token`; the gate still classifies the template's declared reasoning opener
    (`stream.rs:856-912`) and `skipped_reasoning()` still exists. #3233 adds **no second shaping
    rule**: the thinking lever enters ONLY via `params_for` (`chat_format.rs`), shared by render,
    reverse-parse and `stream_markers`.
  - **Edge:** removing the gate's `Skipping`/reasoning classification ⇒ FAIL (that would be the
    reasoning-support removal the issue forbids).

- [ ] **R-19 (#3233 — no orphan reader of the retired reasoning default; sampling values unchanged).**
  - **Expected:** `DEFAULT_REASONING_MODE` (`sampling.rs:102`) is retired by ST-2; **no surviving
    reader** (`server_flags_from`, or any match arm) dereferences it, and its pin
    `the_reasoning_default_matches_the_retired_launch_config` (`:322-324`) is re-pointed — a stale
    pin asserting the removed string, or an orphan reader, ⇒ **FAIL**. The five sampling values
    (1.0 / 0.95 / 64 / 131 072 / 1024) stay byte-pinned (cross-ref functional `FR-39`).
  - **Edge:** a compile error from a surviving reference is the loudest form of this defect (G-444).
