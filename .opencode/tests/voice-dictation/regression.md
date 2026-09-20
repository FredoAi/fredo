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

### #2897 run log — testing round 1 (`spec/2897 @ b2b2e4df`, 2026-09-19, live)

- **R-1 PASS** — committed fixture SHA-256 `33c2f129d17a555b9faad66e21eab5c8069712c8836cc8d363e97c1555343428`, 16 kHz mono 16-bit PCM, 25,600 samples / 1.6 s; regeneration byte-identical; the `#2887` format pin still accepts it.
- **R-2 PASS** — with `FREDO_STT_FEED_WAV` unset (the pre-feed session) the shipped `cpal` path was used (48000 Hz virtual mic), start/stop/cue/mic-release unchanged, console clean.
- **R-3 PASS** — no out-of-repo audio reference: every audio source named is the in-repo fixture / its deterministic generator; the plan + suites contain no `~`, `%USERPROFILE%`, `node_modules`, `~\.cargo`, or `C:\Windows\Media` asset. **Tooling gap:** the documented `-EnvVars @{ … }` form via `powershell -File` is broken; the feed was driven from the parent env of an allowlisted `bun` launcher.

---

## #2903 extension — the lever is unchanged and stays in-repo (G-172/G-009)

> Issue #2903 adds no audio asset; it uses the existing L4 feed for the model-audio lifecycle only.
> R-1..R-3 remain in force. **Verification policy: live.**

## R-4 — No out-of-repo audio asset is introduced by the #2903 legs

- [ ] R-4: Grep the #2903 plan + suites (`voice-input` F-111..F-126, this file's F-5/F-6/R-4) for any
      path under `~`, `%USERPROFILE%`, `node_modules`, `~\.cargo`, `C:\Windows\Media`, or an STT model
      directory; confirm the only app-action lever named is the in-repo synthetic `llm-skill-call`.
  **Expected:** ZERO out-of-repo audio/media references; the only audio source named is the committed
      fixture + its deterministic in-repo generator; the app-action content lever is a synthetic event
      on the product's REAL channel (no asset at all); the legs are reproducible on a clean checkout.
  - **Edge:** the fixture's declared non-intelligibility is NOT a defect — it is the documented bound
    (F-5); a leg that silently claims a spoken request from the feed is a FALSE PASS.

### #2903 testing round 1 — result (`spec/2903 @ 813b0060`, 2026-09-20, live)

- **R-4 PASS.** Grep of the #2903 plan + suites (`voice-input` F-111..F-126, this file's F-5/F-6/R-4) finds `%USERPROFILE%`/`node_modules`/`C:\Windows\Media`/`~\.cargo` ONLY inside the guardrail text that forbids them — no actual out-of-repo media path. Every audio source named is the committed in-repo fixture + its deterministic generator; the app-action content lever is the synthetic `llm-skill-call` event (no asset). The fixture's declared non-intelligibility is the documented bound (F-5), not a defect.
