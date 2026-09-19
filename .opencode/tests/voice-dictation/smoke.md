# Voice Dictation — Smoke

> Standardized boilerplate (from `.opencode/tests/README.md`) adapted to the capture-feed lever.
> **Verification policy: live.** **Serving checkout:** the `spec/2897` tip (fill the SHA per round).

- [ ] S-1: Fixture + generator reachable — `node .opencode/tests/voice-dictation/fixtures/generate-dictation-phrase.mjs`
      exits 0 and the committed `dictation-phrase-16k-mono.wav` is present and non-empty.

- [ ] S-2: Feed quick path — launch with
      `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 2897 -EnvVars @{ FREDO_STT_FEED_WAV = "C:\Code\fredo\.opencode\tests\voice-dictation\fixtures\dictation-phrase-16k-mono.wav" }`;
      the app boots, `stt_start` goes live from the feed with no `cpal` device constructed, and `stt_stop` releases.
      **Expected:** app renders, console clean of `Error:`/`Uncaught`/`Maximum update depth exceeded`; screenshot
      succeeds. **If the env passthrough is unavailable → named blocker (G-053), not a PASS.**

- [ ] S-3: Evidence upload smoke — a capture from S-2 is uploaded via `upload-evidence --issue 2897`, the raw URL
      resolves, and it is embedded in `## Tests Runs` with a textual description.

### #2897 testing round 1 — result

- [ ] _(pending — the Tester appends the smoke results; do not pre-fill)_
