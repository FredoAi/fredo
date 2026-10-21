# Companion Audio Skill Parity — Regression

> The "must not change" baseline for #3073. **Verification policy: live** for anything driven against the
> running app; the pins/guards below are static and run in the CI-parity set (F-8). Serving checkout: the
> `spec/3073` tip (fill the SHA per round).

## R-1 — The typed offer and its pin are frozen

- [ ] F-47 `the_live_offer_carries_the_wireframe_skill_with_its_directive_description` (`status.rs:1346`) is
      GREEN and its test body is UNMODIFIED. The typed offer content/order (`open_app`, `close_app`,
      `doom_mode`, `wireframe`) is unchanged.
  **FAIL if:** F-47 is edited to pass, or the typed offer changes.

## R-2 — The registry constructors and their pins survive

- [ ] 3-skill constructor pin `len() == 3` (`skills.rs:554`) is green; `with_app_control_and_doom()`
      (`skills.rs:187-195`) and its pins (`skills.rs:462-489`, `:554-566`) remain intact.
- [ ] 4-skill pins (`skills.rs:538`, `:568`) are green; `with_app_control_doom_and_wireframe()`
      (`skills.rs:204-212`) is unchanged.
  **FAIL if:** a constructor is deleted or a pin is weakened/removed.

## R-3 — The audio delivery boundary is unchanged

- [ ] `tests/voice_invariants.rs:593-602` — the audio command delivers through the managed chat module only if
      the command still exists — stays green. Routing the registry MUST keep `chat::` / `run_stream` /
      `server_host` reachable from the command body.
- [ ] `tests/voice_invariants.rs:612-644` — the audio delivery surface stays inside `applications/llm_server/` —
      stays green.
  **FAIL if:** the command body is deleted or the delivery surface moves.

## R-4 — No new network client / loopback contract unchanged

- [ ] `tests/voice_invariants.rs:576-602` boundary assertions green; no new HTTP client, host, port, or URL
      literal; `resolve_host` / `server_host` (`chat.rs:484-491`) unchanged.

## R-5 — The capture-feed lever still feeds model-audio

- [ ] `.opencode/tests/voice-dictation/` F-7..F-9 still hold: `FREDO_STT_FEED_WAV` engages the feed branch
      (`{deviceName:"stt-feed", sampleRate:16000}`, no `cpal` device) and `stt_take_audio_clip` returns the
      fed fixture (1.6 s). This suite's F-7 rides on that lever.

## Overlapping prior suites (re-run on the tip)

- `.opencode/tests/voice-dictation/` — the capture-feed lever (F-7..F-9).
- `.opencode/tests/voice-input/` — the audio delivery surface (F-105 / F-108 / F-110 name `llm_chat_with_audio`).
- `.opencode/tests/wireframe/` — the typed wireframe selection precedent (E-19).
