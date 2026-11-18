# Companion Audio Skill Parity — Functional

> **#3152 SUPERSESSION (G-136 — history preserved, the requirement survives, the content assertion moved).**
> The per-application generated skill was deleted in #3152. **The offer is now exactly the three static
> skills** `open_app`, `close_app`, `doom_mode`, produced by the **ZERO-ARGUMENT**
> `companion_skill_registry()` (`applications/llm_server/status.rs:691`) and pinned by
> `the_turn_offer_is_exactly_the_three_static_skills` (`status.rs:1462`). The `#3099` four-skill
> additions, the `4-skill` constructors and the golden-fixture parity path are gone; their pins are
> replaced by the shipped `companion_offer_static_only.rs` (`:147`
> `static_skills_are_byte_identical_to_the_pre_change_baseline`).
>
> **The parity requirement itself is UNCHANGED and must not be weakened:** both the typed and the audio
> turn still obtain the SAME offer from the ONE zero-argument accessor, and their `tools` arrays must
> still be byte-equal. Only the asserted offer CONTENT moves from four names to three.
> F-1/F-2/F-3/F-6/F-7 carry the parity subject forward on the three-skill offer; F-8/F-9/F-12 are the
> CI-parity rows and are unchanged.

> Per-requirement test cases for **#3073 — the model-audio (spoken) turn offers exactly the same
> skills as a typed turn** (`open_app`, `close_app`, `doom_mode`, same order), so a spoken request is
> never silently unsupported when its typed twin works.
>
> **Feature tests:** companion-audio-skill-parity. Runs against the `spec/3153` tip (fill the SHA per round).
>
> **Verification policy: live.** F-1/F-2/F-6/F-7 are live rows — each names its live observable (a
> `telemetry_spans` query + result, or a live `tauri_webview_*` receipt). A static-only PASS on a live
> row is a FALSE PASS. The CLI emit path is never the receipt lever (G-256).
>
> **The defect under test (historical, then the shipped guarantee).** `run_audio_chat` once chose its
> own registry instead of the one shared accessor; the fix routed the audio path through
> `companion_skill_registry()`. That guarantee is what this suite still proves — now over the three
> static skills, because **nothing else is offered**.
>
> **Reachability (binding).** A real spoken turn on the shipped dictation path reaches the accessor;
> the legacy `llm_chat_with_audio` command carries the discriminating before/after (F-6), not the
> dictation gesture (F-7 carries liveness only).
>
> **Assets are in-repo only (G-172/G-009).** Nothing here sources audio from outside the repo — no `~`,
> `%USERPROFILE%`, `node_modules`, `~\.cargo`, `C:\Windows\Media`, or STT model directory.

| Row | Case | Live observable | Evidence required | Pass/fail criterion | Binding name pinned |
|-----|------|-----------------|-------------------|---------------------|---------------------|
| **F-1** | **Audio offer-set identity at typed parity.** Drive a real model-audio turn on the legacy command (`tauri_ipc_execute_command llm_chat_with_audio`, `audioBase64` = L2 clip, L3 message shape) AND a typed turn (`llm_chat_with_status`, same text request) on the SAME tip. | A `telemetry_spans` query returning non-zero rows with a recent `max(ingested_at)`, plus a live `tauri_webview_dom_snapshot` of the companion reply bubble. | `telemetry-query` result + webview receipt; the two turns' event streams. | Both turns offer exactly `open_app`, `close_app`, `doom_mode` (same order) and NOTHING else — no application-named skill. Byte-level `tools` equality is asserted by F-4. Static-only evidence = FALSE PASS. | `companion_skill_registry` (`status.rs:691`) |
| **F-2** | **Audio turn settles on the same offer.** L3 drive on the legacy command; capture the event stream. | The reply bubble rendered in the webview (live `tauri_webview_screenshot`) + the `telemetry_spans` receipt. | Screenshot (descriptive link label) + `telemetry-query` result + the `llm-skill-call`/`llm-done` stream. | The audio turn is offered the same three skills, settles with exactly one `llm-done` and no `llm-error`, and an `open_app` selection from the audio path opens exactly one window (the shipped handler). A second `llm-done` or any `llm-error` = FAIL. | `companion_skill_registry` (`status.rs:691`); the three static skills' own handlers |
| **F-3** | **Structural "one definition" pin.** Run the production-source scan test. | `cargo nextest run`/`cargo test` exit 0. | The test output naming `the_model_audio_path_obtains_its_offer_from_the_one_shared_registry`. | The scan matches the audio path's registry source (`companion_skill_registry()`) and finds NO other `SkillRegistry::with_*` constructor building a companion offer in production code; the scan is POSITIVE-CONTROLLED (`voice_invariants.rs:653-680`) so a scan matching nothing cannot pass. A vacuous scan = FAIL. | `the_model_audio_path_obtains_its_offer_from_the_one_shared_registry` (`tests/voice_invariants.rs:653`) |
| **F-4** | **Regression pin: the audio offer is the three static skills and equals the typed offer.** Run the offer-content + equality pin. | `cargo nextest run`/`cargo test` exit 0. | The test output naming `the_turn_offer_is_exactly_the_three_static_skills` (`status.rs:1462`) and `the_rendered_offer_carries_only_the_three_static_skills` (`tests/companion_offer_static_only.rs:50`). | Asserts the offer is EXACTLY `open_app`, `close_app`, `doom_mode` in that order from the zero-argument accessor, and EQUALITY with the typed offer. A mutated offer (an extra name, a reorder, a dropped name) MUST fail. A `companion_skill_registry(app)` arity is a FAIL. Must not weaken/duplicate F-3. | `the_turn_offer_is_exactly_the_three_static_skills` (`status.rs:1462`); `the_rendered_offer_carries_only_the_three_static_skills` (`companion_offer_static_only.rs:50`) |
| **F-5** | **AC4 decision + honest record.** Read the recorded decision/observation; check the shipped ARCHITECTURE line for the companion offer. | n/a (durable record). | The issue plan/tests-runs narrative + the doc diff. | The record states the accessor is ZERO-argument and offers exactly three static skills, and names no per-application registry. A stale doc line asserting a four-skill offer = FAIL. | — (AC4 record) |
| **F-6** | **BEFORE/AFTER empirical leg.** Baseline `dev-env.ps1 -Action Up -Spec 3073 -At <pre-change-sha>` → L3 drive → record; then plain `-Action Up` (tip) → L3 drive → record. | BEFORE: prose only, the audio path bypassed the shared accessor. AFTER: the audio turn carries the same three-skill offer from `companion_skill_registry()`. Receipts: the `llm-skill-call`/`llm-done` stream + `telemetry_spans` + a webview receipt for the AFTER column. | Both columns recorded; the baseline SHA named; `telemetry-query` result + screenshot for AFTER. | AFTER the audio `tools` deep-equal the typed `tools` (three static skills); BEFORE they differed. If the `-At` baseline is genuinely unavailable, the pre-authorized fallback (removed-code diff + durable recorded values) is used and **explicitly labeled a documented fallback, not an observation** — presenting it as an observation = FAIL. | `companion_skill_registry` (`status.rs:691`) |
| **F-7** | **Shipped-dictation liveness.** Space on the focused EMPTY launcher input; L2 feed injected via `FREDO_STT_FEED_WAV`; ONE real model-audio turn. | `stt_start` → `{deviceName:"stt-feed", sampleRate:16000}` (no `cpal` device), `stt_stop` releases; live `tauri_webview_screenshot`; console clean. | IPC receipts + screenshot (descriptive link label) + console read. | The turn SETTLES: exactly one `llm-done`, no `llm-error`, no `llm-status`; app responsive; console clean of `Error:`/`Uncaught`/`Maximum update depth exceeded`. An UNSET-env control proves non-vacuousness. | `FREDO_STT_FEED_WAV`; `dictation-phrase-16k-mono.wav` |
| **F-8** | **CI-parity set (the exact `validate.yml` rust gate).** From `apps/tauri/src-tauri/`: `cargo check --manifest-path apps/tauri/src-tauri/Cargo.toml --locked`; `cargo nextest run --manifest-path apps/tauri/src-tauri/Cargo.toml --locked`; `cargo clippy --manifest-path apps/tauri/src-tauri/Cargo.toml --locked -- -D warnings`. | Command exit codes. | The three command lines + their output (reconciled verbatim against `validate.yml`). | All three exit 0; clippy carries NO `--all-targets` flag. `cargo check` alone does NOT clear the clippy gate. If `cargo-nextest` is absent locally, substitute `cargo test --locked` and DISCLOSE it. If the diff widens to `apps/ui/**` or `apps/tauri/src/**`, also run `pnpm --filter @fredo/ui typecheck`, `build`, `test:run`, `contrast:gate`, `pnpm --filter @fredo/tauri build:webview`. | — (CI parity) |
| **F-9** | **NFR-1 — no new network client / loopback unchanged.** Diff scan + `voice_invariants.rs` boundary assertions. | Static diff + test output. | The diff scan + the boundary-assertion test result. | Zero new client/host/port/URL literal; boundary assertions green. | `voice_invariants.rs` boundary assertions |
| **F-10** | **NFR-2 — typed path frozen.** Run the typed offer pin and diff its body. | Test output + diff. | The typed-offer pin result + a diff proving its body is unchanged. | The typed offer pin is GREEN and UNMODIFIED; typed offer content/order unchanged. A green-but-modified pin = FAIL. | `the_turn_offer_is_exactly_the_three_static_skills` (`status.rs:1462`) |
| **F-11** | **NFR-3 — no new skill / no catalog change.** Offer-set assertion + catalog diff. | Static diff + test output. | The offer-set assertion result + the catalog diff. | The offer set is exactly the THREE static skills; no per-application catalog exists; no TTS/audio-output surface. | — (NFR-3) |
| **F-12** | **NFR-4 — hygiene.** `cargo check`/`clippy -- -D warnings` zero warnings; scan for `#[allow(...)]`; confirm `with_app_control_and_doom()` + its pins intact. | Command output + diff. | The check/clippy output + the `#[allow]` scan + the constructor/pin diff. | Zero warnings; no `#[allow(...)]` added; the 3-skill constructor and its pins intact. | `with_app_control_and_doom` |
| **F-13** | **Regression guards stay green.** Run the named guard tests. | Test output. | The full guard-test result set. | ALL green: `the_turn_offer_is_exactly_the_three_static_skills` (`status.rs:1462`); `the_rendered_offer_carries_only_the_three_static_skills` (`companion_offer_static_only.rs:50`); `static_skills_are_byte_identical_to_the_pre_change_baseline` (`companion_offer_static_only.rs:147`); `the_model_audio_path_obtains_its_offer_from_the_one_shared_registry` (`voice_invariants.rs:653`). Routing must NOT break the audio path's reachability of `chat::`/`run_stream`. | guard set (see regression.md) |

## Required test data (all in-repo — G-172)

- **L2 clip:** `FREDO_STT_FEED_WAV` = `C:\Code\fredo\.opencode\tests\voice-dictation\fixtures\dictation-phrase-16k-mono.wav`
  (16 kHz mono 16-bit PCM, 1.6 s, SHA-256 `33c2f129d17a555b9faad66e21eab5c8069712c8836cc8d363e97c1555343428`,
  **explicitly non-intelligible**). Inject with the comma form
  `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 3153 -EnvVar "FREDO_STT_FEED_WAV=C:\Code\fredo\.opencode\tests\voice-dictation\fixtures\dictation-phrase-16k-mono.wav"`
  (repeated `-EnvVar` flags are unreliable under `powershell -File`, G-301) → `stt_start` / `stt_stop` →
  `stt_take_audio_clip` returns the WAV base64 (precedent `voice-dictation/functional.md:149`, `base64Len:68328`).
- **L3 message shape:** `messages = [{role:"system",content:<persona>}, {role:"user",content:"open Mission Monitor"}]`
  with `audioBase64 = <clip from L2>`. Valid because only the LAST user message is replaced by the `input_audio`
  part; earlier text turns survive verbatim.
- **Baseline:** `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 3073 -At <pre-change-sha>`
  materializes ONLY the pre-fix `apps/` code; a following plain `-Action Up` restores the tip.

## Evidence mechanics (G-104 / G-223)

Name evidence frames in prose WITHOUT image extensions; a `.png`/`.jpeg` token may appear ONLY on a line that
also carries an `https://` URL; use descriptive link labels. Upload captures with `upload-evidence` and embed
the returned `https://` URL in the single `## Tests Runs` comment.
