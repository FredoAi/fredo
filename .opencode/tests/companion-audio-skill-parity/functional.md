# Companion Audio Skill Parity — Functional

> Per-requirement test cases for **#3073 — the model-audio (spoken) turn offers exactly the same
> skills as a typed turn** (`open_app`, `close_app`, `doom_mode`, `wireframe`, same order), so a
> spoken request is never silently unsupported when its typed twin works.
>
> **Feature tests:** companion-audio-skill-parity. Runs against the `spec/3073` tip (fill the SHA per round).
>
> **Verification policy: live.** F-1/F-2/F-6/F-7 are live rows — each names its live observable (a
> `telemetry_spans` query + result, or a live `tauri_webview_*` receipt). A static-only PASS on a live
> row is a FALSE PASS. The CLI emit path is never the receipt lever (G-256).
>
> **The defect under test.** `run_audio_chat` (`chat.rs:462`) chose its own registry
> (`SkillRegistry::with_app_control_and_doom()` = 3 skills, no `wireframe`) instead of the one shared
> accessor `companion_skill_registry()` (`status.rs:708` → `with_app_control_doom_and_wireframe()`,
> `skills.rs:204`). The fix ROUTES the audio path through the shared accessor.
>
> **Reachability (binding, Architect).** The 3-skill path is reached only via `llm_chat_with_audio`
> (`commands.rs:816`), which has no production caller; the SHIPPED dictation path already offers four
> skills. The discriminating before/after is therefore driven on the legacy command (F-6), not on the
> dictation gesture (F-7 carries liveness only).
>
> **Assets are in-repo only (G-172/G-009).** Nothing here sources audio from outside the repo — no `~`,
> `%USERPROFILE%`, `node_modules`, `~\.cargo`, `C:\Windows\Media`, or STT model directory.

| Row | Case | Live observable | Evidence required | Pass/fail criterion | Binding name pinned |
|-----|------|-----------------|-------------------|---------------------|---------------------|
| **F-1** | **Audio offer-set identity at typed parity.** Drive a real model-audio turn on the legacy command (`tauri_ipc_execute_command llm_chat_with_audio`, `audioBase64` = L2 clip, L3 message shape) AND a typed turn (`llm_chat_with_status`, same text request) on the SAME tip. | A `telemetry_spans` query returning non-zero rows with a recent `max(ingested_at)`, plus a live `tauri_webview_dom_snapshot` of the companion reply bubble. | `telemetry-query` result + webview receipt; the two turns' event streams. | Both turns offer `open_app`, `close_app`, `doom_mode`, `wireframe` (same order) — each emits exactly one `llm-skill-call {skill:"wireframe"}`. Byte-level `tools` equality is asserted by F-4. Static-only evidence = FALSE PASS. | `companion_skill_registry` (`status.rs:708`) |
| **F-2** | **End-to-end audio wireframe selection + execution.** L3 drive on the legacy command; capture the event stream. | The wireframe draft rendered in the webview (live `tauri_webview_screenshot`) + the `telemetry_spans` receipt. | Screenshot (descriptive link label) + `telemetry-query` result + the `llm-skill-call`/`llm-done` stream. | Exactly ONE `llm-skill-call {skill:"wireframe"}` + the draft executed through the shared dispatch (`skills.rs:369-393`), settling with exactly one `llm-done`, no `llm-error`. A second skill-call, zero `llm-done`, or any `llm-error` = FAIL. | `companion_skill_registry`; terminal plan `skills.rs:369-393` |
| **F-3** | **Structural "one definition" pin.** Run the production-source scan test. | `cargo nextest run`/`cargo test` exit 0. | The test output naming `the_model_audio_path_obtains_its_offer_from_the_one_shared_registry`. | The scan matches the audio path's registry source (`companion_skill_registry()`) and finds NO other `SkillRegistry::with_*` constructor building a companion offer in production code; the scan is POSITIVE-CONTROLLED (mirroring `voice_invariants.rs:631-636`) so a scan matching nothing cannot pass. A vacuous scan = FAIL. | `the_model_audio_path_obtains_its_offer_from_the_one_shared_registry` (`tests/voice_invariants.rs`) |
| **F-4** | **Regression pin, the audio analogue of F-47.** Run the audio-offer content + equality pin. | `cargo nextest run`/`cargo test` exit 0. | The test output naming `the_audio_path_offer_carries_the_wireframe_skill_at_typed_parity`. | Asserts the four tool names in offer order, the `wireframe` declaration (three C4 args + the directive description naming the request class and every catalog id), and EQUALITY with the typed offer. A mutated offer (drop `wireframe`, reorder, drop an arg) MUST fail. Must not weaken/duplicate F-47 (`status.rs:1346`). | `the_audio_path_offer_carries_the_wireframe_skill_at_typed_parity` (`chat.rs` test module) |
| **F-5** | **AC4 decision + honest record.** Read the recorded decision/observation; check `docs/ARCHITECTURE.md:642` and `:880`. | n/a (durable record). | The issue plan/tests-runs narrative + the doc diff. | Decision recorded as **ROUTE, not remove** with rationale; the before/after observation present WITH the explicit note that the symptom was **inferred by code reading, not observed**; the doc line no longer names `SkillRegistry::with_app_control_and_doom()` as the model-audio offer. Missing honest note or a stale doc line = FAIL. | — (AC4 record) |
| **F-6** | **BEFORE/AFTER empirical leg.** Baseline `dev-env.ps1 -Action Up -Spec 3073 -At <pre-change-sha>` → L3 drive → record; then plain `-Action Up` (tip) → L3 drive → record. | BEFORE: prose only, ZERO `llm-skill-call`. AFTER: `llm-skill-call {skill:"wireframe"}` + draft executed. Receipts: the `llm-skill-call`/`llm-done` stream + `telemetry_spans` + a webview receipt for the AFTER column. | Both columns recorded; the baseline SHA named; `telemetry-query` result + screenshot for AFTER. | AFTER shows the selection and draft; BEFORE shows none. If the `-At` baseline is genuinely unavailable, the pre-authorized fallback (removed-code diff + durable recorded values: `chat.rs:462` citation + the 3-skill pin `skills.rs:554`) is used and **explicitly labeled a documented fallback, not an observation** — presenting it as an observation = FAIL. | `companion_skill_registry`; `chat.rs:462` |
| **F-7** | **Shipped-dictation liveness.** Space on the focused EMPTY launcher input; L2 feed injected via `FREDO_STT_FEED_WAV`; ONE real model-audio turn. | `stt_start` → `{deviceName:"stt-feed", sampleRate:16000}` (no `cpal` device), `stt_stop` releases; live `tauri_webview_screenshot`; console clean. | IPC receipts + screenshot (descriptive link label) + console read. | The turn SETTLES: exactly one `llm-done`, no `llm-error`, no `llm-status`; app responsive; console clean of `Error:`/`Uncaught`/`Maximum update depth exceeded`. The ACOUSTIC spoken-wireframe selection stays a **NAMED BLOCKER** (`generate-dictation-phrase.mjs:14-23`, `voice-dictation/smoke.md:51`) — a blocker, not a FAIL. An UNSET-env control proves non-vacuousness. | `FREDO_STT_FEED_WAV`; `dictation-phrase-16k-mono.wav` |
| **F-8** | **CI-parity set (the exact `validate.yml` rust gate).** From `apps/tauri/src-tauri/`: `cargo check --manifest-path apps/tauri/src-tauri/Cargo.toml --locked`; `cargo nextest run --manifest-path apps/tauri/src-tauri/Cargo.toml --locked`; `cargo clippy --manifest-path apps/tauri/src-tauri/Cargo.toml --locked -- -D warnings`. | Command exit codes. | The three command lines + their output (reconciled verbatim against `validate.yml:104-106`). | All three exit 0; clippy carries NO `--all-targets` flag. `cargo check` alone does NOT clear the clippy gate. If `cargo-nextest` is absent locally, substitute `cargo test --locked` and DISCLOSE it. If the diff widens to `apps/ui/**` or `apps/tauri/src/**`, also run `pnpm --filter @fredo/ui typecheck`, `build`, `test:run`, `contrast:gate`, `pnpm --filter @fredo/tauri build:webview`. | — (CI parity) |
| **F-9** | **NFR-1 — no new network client / loopback unchanged.** Diff scan + `voice_invariants.rs:576-602` boundary assertions. | Static diff + test output. | The diff scan + the boundary-assertion test result. | Zero new client/host/port/URL literal; requests still flow through `chat::run_stream` → `ensure_healthy` + `server_host` (`chat.rs:570-575`, `:484-491`); boundary assertions green. | `voice_invariants.rs:576-602` |
| **F-10** | **NFR-2 — typed path frozen (F-47 unmodified).** Run F-47 and diff its body. | Test output + diff. | F-47 result + a diff proving its body is unchanged. | F-47 GREEN and UNMODIFIED; typed offer content/order unchanged. A green-but-modified F-47 = FAIL. | `the_live_offer_carries_the_wireframe_skill_with_its_directive_description` (`status.rs:1346`) |
| **F-11** | **NFR-3 — no new skill / no catalog change / no TTS.** Offer-set assertion + catalog diff + audio-output-surface scan. | Static diff + test output. | The offer-set assertion result + the catalog/surface diff. | Offer set is exactly the four skills; the wireframe catalog is untouched; no TTS/audio-output surface. | — (NFR-3) |
| **F-12** | **NFR-4 — hygiene.** `cargo check`/`clippy -- -D warnings` zero warnings; scan for `#[allow(...)]`; confirm `with_app_control_and_doom()` + its pins intact. | Command output + diff. | The check/clippy output + the `#[allow]` scan + the constructor/pin diff. | Zero warnings; no `#[allow(...)]` added; the 3-skill constructor and its pins (`skills.rs:462-489`, `:554-566`) intact. | `with_app_control_and_doom` (`skills.rs:187-195`) |
| **F-13** | **Regression guards stay green.** Run the named guard tests. | Test output. | The full guard-test result set. | ALL green: F-47 (`status.rs:1346`); 3-skill pin `len()==3` (`skills.rs:554`); 4-skill pins (`skills.rs:538`, `:568`); `voice_invariants.rs:593-602`; `voice_invariants.rs:612-644`. Routing must NOT break `voice_invariants.rs:593-602` — `chat::`/`run_stream`/`server_host` stay reachable from the command body. | guard set (see regression.md) |

## Required test data (all in-repo — G-172)

- **L2 clip:** `FREDO_STT_FEED_WAV` = `C:\Code\fredo\.opencode\tests\voice-dictation\fixtures\dictation-phrase-16k-mono.wav`
  (16 kHz mono 16-bit PCM, 1.6 s, SHA-256 `33c2f129d17a555b9faad66e21eab5c8069712c8836cc8d363e97c1555343428`,
  **explicitly non-intelligible**). Inject with the comma form
  `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 3073 -EnvVar "FREDO_STT_FEED_WAV=C:\Code\fredo\.opencode\tests\voice-dictation\fixtures\dictation-phrase-16k-mono.wav"`
  (repeated `-EnvVar` flags are unreliable under `powershell -File`, G-301) → `stt_start` / `stt_stop` →
  `stt_take_audio_clip` returns the WAV base64 (precedent `voice-dictation/functional.md:149`, `base64Len:68328`).
- **L3 message shape:** `messages = [{role:"system",content:<persona>}, {role:"user",content:"let's create a new wireframe for our new Reporter app, I would like a way to visualize reports"}, {role:"user",content:""}]`
  with `audioBase64 = <clip from L2>`. Valid because only the LAST user message is replaced by the `input_audio`
  part; earlier text turns survive verbatim (`chat.rs:293-307`).
- **Baseline:** `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 3073 -At <pre-change-sha>`
  materializes ONLY the pre-fix `apps/` code; a following plain `-Action Up` restores the tip.
- **Precedent** for an observable real-model wireframe selection: `.opencode/tests/wireframe/exploratory.md:130-134` (E-19).

## Evidence mechanics (G-104 / G-223)

Name evidence frames in prose WITHOUT image extensions; a `.png`/`.jpeg` token may appear ONLY on a line that
also carries an `https://` URL; use descriptive link labels. Upload captures with `upload-evidence --issue 3073`
and embed the returned `https://` URL in the single `## Tests Runs` comment.
