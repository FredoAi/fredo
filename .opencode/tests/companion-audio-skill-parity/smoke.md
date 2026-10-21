# Companion Audio Skill Parity — Smoke

> Standardized boilerplate (from `.opencode/tests/README.md`) adapted to the companion audio skill-offer
> surface. **Verification policy: live.** **Serving checkout:** the `spec/3073` tip (fill the SHA per round).

- [ ] S-1: **App boots and the companion is reachable.** Launch the tip
      (`powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 3073`), open the launcher.
  **Expected:** the app renders, the launcher input is focusable and EMPTY; console clean of
      `Error:`/`Uncaught`/`Maximum update depth exceeded`; a `tauri_webview_screenshot` succeeds.

- [ ] S-2: **The dictation gesture is reachable (liveness only).** With the feed injected
      (`-EnvVar "FREDO_STT_FEED_WAV=C:\Code\fredo\.opencode\tests\voice-dictation\fixtures\dictation-phrase-16k-mono.wav"`,
      comma form, G-301), press space on the focused EMPTY launcher input; `stt_start` → `stt_stop`.
  **Expected:** the feed branch is taken (`{deviceName:"stt-feed", sampleRate:16000}`, no `cpal` device), the
      turn SETTLES (exactly one `llm-done`, no `llm-error`, no `llm-status`), the app stays responsive. **The
      fixture carries no intelligible speech — the acoustic wireframe-selection leg stays a NAMED BLOCKER
      (`voice-dictation/smoke.md:51`), not a PASS.** If the env passthrough is unavailable → named blocker
      (G-053), not a PASS.

- [ ] S-3: **The typed path still offers four skills.** Issue a typed request in the launcher input
      (`llm_chat_with_status` with the L3 text request, no audio).
  **Expected:** the companion reply arrives and the offered set is `open_app`, `close_app`, `doom_mode`,
      `wireframe` (live proxy: a wireframe request selects `wireframe`); the typed path is UNCHANGED.

- [ ] S-4: **Evidence + telemetry receipt.** A capture from S-1/S-2 is uploaded via `upload-evidence --issue
      3073`, the raw URL resolves, and it is embedded in `## Tests Runs` with a textual description; the body
      also references `telemetry_spans` (non-zero, recent `max(ingested_at)`).

### Run log

- (fill per round: serving SHA, date, per-row PASS/FAIL, the env form used, any named blocker.)
