# Companion Audio Skill Parity — Regression

> The "must not change" baseline for the typed/audio offer parity. **Verification policy: live** for
> anything driven against the running app; the pins/guards below are static and run in the CI-parity set
> (F-8). Serving checkout: the `spec/3153` tip (fill the SHA per round).
> **The shipped offer is the three static skills** from the ZERO-ARGUMENT `companion_skill_registry()`
> (`status.rs:691`), pinned by `the_turn_offer_is_exactly_the_three_static_skills` (`status.rs:1462`).

## R-1 — The typed offer and its pin are frozen

- [ ] `the_turn_offer_is_exactly_the_three_static_skills` (`status.rs:1462`) is GREEN and its test body is
      UNMODIFIED. The typed offer content/order is exactly `open_app`, `close_app`, `doom_mode` — and the
      accessor takes NO argument.
  **FAIL if:** the pin is edited to pass, the typed offer changes, or a `companion_skill_registry(app)`
  arity appears.

## R-2 — The registry constructors and their pins survive

- [ ] The three-static-skill constructor `with_app_control_and_doom()` (`status.rs:692`) is intact and
      its pins are green; the rendered-offer pin `the_rendered_offer_carries_only_the_three_static_skills`
      (`tests/companion_offer_static_only.rs:50`) and
      `static_skills_are_byte_identical_to_the_pre_change_baseline` (`:147`) are green.
- [ ] `the_model_audio_path_obtains_its_offer_from_the_one_shared_registry` (`tests/voice_invariants.rs:653`)
      is green — the audio path still resolves the ONE shared accessor.
  **FAIL if:** the constructor is deleted, a pin is weakened or removed, or the audio path constructs its
  own registry again.

## R-3 — The audio delivery boundary is unchanged

- [ ] `tests/voice_invariants.rs` audio-path assertions stay green. Routing the registry MUST keep
      `chat::` / `run_stream` / `server_host` reachable from the command body.
- [ ] The audio delivery surface stays inside `applications/llm_server/`.
  **FAIL if:** the command body is deleted or the delivery surface moves.

## R-4 — No new network client / loopback contract unchanged

- [ ] The `voice_invariants.rs` boundary assertions are green; no new HTTP client, host, port, or URL
      literal; `resolve_host` / `server_host` unchanged.

## R-5 — The capture-feed lever still feeds model-audio

- [ ] `.opencode/tests/voice-dictation/` F-7..F-9 still hold: `FREDO_STT_FEED_WAV` engages the feed branch
      (`{deviceName:"stt-feed", sampleRate:16000}`, no `cpal` device) and `stt_take_audio_clip` returns the
      fed fixture (1.6 s). This suite's F-7 rides on that lever.

## Overlapping prior suites (re-run on the tip)

- `.opencode/tests/voice-dictation/` — the capture-feed lever (F-7..F-9).
- `.opencode/tests/voice-input/` — the audio delivery surface.
- `.opencode/tests/companion/` — the three-static-skill offer (F-145/F-159) this suite's parity is
  asserted against.
