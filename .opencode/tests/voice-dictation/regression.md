# Voice Dictation — Regression

> The "must not change" baseline for the **capture-feed lever** and the committed fixture. The
> lever is additive: when `FREDO_STT_FEED_WAV` is unset, the shipped `cpal` capture path must be
> byte-unchanged. **Verification policy: live.**
>
> **Overlapping suites to run alongside:** `voice-input` (the dictation/model-audio UX rows),
> `llama-setup` (the managed-server transport rows).

## R-1 — The committed short fixture + its format pin are unchanged

- [ ] R-1: Compare the committed `dictation-phrase-16k-mono.wav` byte-for-byte (SHA-256) and verify its header against
      the format pin in `apps/tauri/src-tauri/src/infrastructure/voice/capture.rs`. Re-run the generator and diff.
  **Expected:** identical bytes, 16 kHz mono 16-bit PCM, 25,600 samples / 1.6 s; re-running the generator leaves the
      committed file byte-identical (no churn); the `#2887` feed contract is untouched.

## R-2 — With the env UNSET, the shipped capture path is unchanged

- [ ] R-2: Launch the app with `FREDO_STT_FEED_WAV` unset; start/stop a dictation session through the real control plane
      and the real hold-Space gesture.
  **Expected:** the feed-mode branch is not taken; the normal `cpal` device path is used exactly as before #2897;
      start/stop semantics, cue routing and mic release are unchanged; console clean of
      `Error:`/`Uncaught`/`Maximum update depth exceeded`.

## R-3 — No out-of-repo audio asset is required anywhere

- [ ] R-3: Grep the #2897 test plan/suites for any path under `~`, `%USERPROFILE%`, `node_modules`, `~\.cargo`,
      `C:\Windows\Media`, or an STT model directory.
  **Expected:** ZERO out-of-repo audio references; the only audio source named is the committed fixture + its in-repo
      generator (ST-9's variant); the lever is reproducible on a clean checkout (G-172/G-009).

### #2897 run log — testing round 1

- [ ] _(pending — the Tester appends the fixture hash, the format-pin result, the unset-env behavior, and the grep
      result; do not pre-fill)_
