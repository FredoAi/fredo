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

### #2897 testing round 1 — result (`spec/2897 @ b2b2e4df`, 2026-09-19, live)

- **S-1 PASS** — generator exits 0; committed fixture present (51,244 B, SHA-256 `33c2f129…`).
- **S-2 PASS** — feed quick path: app booted, `stt_start` went live from the feed (`deviceName:"stt-feed"`, 16000 Hz, no `cpal`), `stt_stop` released cleanly; console clean.
- **S-3 PASS** — 8 captures uploaded via `upload-evidence --issue 2897` with textual descriptions.
- **Env form:** `-EnvVars @{ … }` via `powershell -File` is broken (hashtable→string); the feed was driven from the parent env of an allowlisted `bun` launcher (disclosed tooling gap).

### #2897 testing round 2 — result (`spec/2897 @ be4d3a73`, 2026-09-19, live)

- **S-1 PASS** — generator exits 0; committed fixture present (51,244 B, SHA-256 `33c2f129…`).
- **S-2 PASS** — feed quick path: app booted, `stt_start` went live from the feed
  (`deviceName:"stt-feed"`, 16,000 Hz, no `cpal`), `stt_stop` released cleanly; console clean.
- **S-3 PASS** — 5 captures uploaded via `upload-evidence --issue 2897` with textual descriptions.

---

## #2903 extension — feed quick path on the model-audio tip

> Issue #2903 reuses the L4 feed for the model-audio lifecycle. **Verification policy: live.**
> **Serving checkout:** the `spec/2903` tip (fill the SHA per round).

- [ ] S-4: **Feed quick path (string env form).** Launch with
      `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 2903 -EnvVar
      "FREDO_STT_FEED_WAV=C:\Code\fredo\.opencode\tests\voice-dictation\fixtures\dictation-phrase-16k-mono.wav"`;
      mode=`model` selected; `stt_start` → `stt_stop`.
      **Expected:** the app boots and renders, the feed branch is proven
      (`{deviceName:"stt-feed", sampleRate:16000}`, no `cpal` device), the turn settles with the curated
      model-audio state and NO transcript, `stt_stop` releases; console clean of
      `Error:`/`Uncaught`/`Maximum update depth exceeded`; screenshot succeeds. **The fixture carries no
      intelligible speech — the acoustic app-request leg stays a NAMED BLOCKER, not a PASS.**

### #2903 testing round 1 — result (`spec/2903 @ 813b0060`, 2026-09-20, live)

- **S-4 PASS.** Cold `dev-env.ps1 -Action Up -Spec 2903 -EnvVar "FREDO_STT_FEED_WAV=…"` (serving `spec/2903 @ 813b0060`) → app booted and rendered; `stt_start` → `{deviceName:"stt-feed", sampleRate:16000}` (feed branch proven, no `cpal`); `stt_stop` → `phase:"processing"` and the app stayed responsive; no transcript appeared; console clean of `Error:`/`Uncaught`/`Maximum update depth exceeded`. The fixture carries no intelligible speech — the acoustic app-request leg stays a NAMED BLOCKER (see #2903 R-1.4).

---

## #2914 extension — feed quick path on the single-model-audio tip

> Issue #2914 deletes the local STT engine/mode; the feed seam may or may not survive. Quick path
> only — the full matrix lives in `functional.md` F-7..F-9 / `regression.md` R-5/R-6.
> **Verification policy: live.** Serving checkout: the `spec/2914` tip (fill the SHA per round).

- [ ] S-5: **Feed quick path (or named blocker).** Launch with
      `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 2914 -EnvVar
      "FREDO_STT_FEED_WAV=C:\Code\fredo\.opencode\tests\voice-dictation\fixtures\dictation-phrase-16k-mono.wav"`;
      model mode; `stt_start` → `stt_stop`.
  **Expected (seam retained):** the feed branch is proven (`{deviceName:"stt-feed", sampleRate:16000}`, no
      `cpal` device); the app boots/renders; console clean of `Error:`/`Uncaught`/`Maximum update depth
      exceeded`; screenshot succeeds. **If the seam was deleted with the local reader → NAMED BLOCKER
      (record `deviceName`/`sampleRate` and the source state), not a PASS.**
- [ ] S-6: **Evidence + telemetry receipt.** A capture from S-5 is uploaded via `upload-evidence --issue
      2914`, the raw URL resolves, and it is embedded in `## Tests Runs` with a textual description; the
      body also references `telemetry_spans` (non-zero, recent `max(ingested_at)`).

### #2914 run log

- [ ] _(pending — the Tester appends the smoke results; do not pre-fill)_
