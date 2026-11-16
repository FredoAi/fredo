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
