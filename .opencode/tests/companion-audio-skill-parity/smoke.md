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

- **Round 1 — 2026-10-21 — serving `spec/3073` @ `24e8bbcd780b8848a754ea3d6346b98b8e62620f`.** Env form: legacy shared path (`dev-env.ps1 -Action Up -Spec 3073 -EnvVar "FREDO_STT_FEED_WAV=<in-repo dictation-phrase-16k-mono.wav>"`, comma form); BEFORE column via `-At 69a0e69`. **PASS 13/13 QA rows (F-1..F-13), 4/4 ACs.** S-1 PASS (launcher renders, console clean); S-2 PASS (feed branch `{deviceName:"stt-feed", sampleRate:16000}`, ONE settled model-audio turn — `llm-done` ×1, no `llm-error`; one `llm-status` on the prose turn, disclosed); S-3 PASS (typed turn selects `wireframe`); S-4 PASS (3 `user-attachments` URLs embedded, `telemetry_spans` receipt via app-pool `telemetry_get_stats`). **Named blocker:** no intelligible audio in-repo ⇒ the acoustic spoken-wireframe selection is undrivable live; the selection leg is evidenced by the L3 lever (F-1/F-2/F-6). psql `telemetry_spans` read refused (keychain-only password, G-375/#3055) ⇒ app-pool fallback used (disclosed).
