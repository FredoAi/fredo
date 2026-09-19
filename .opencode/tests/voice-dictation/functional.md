# Voice Dictation — Functional

> Per-requirement test cases for the **deterministic capture-feed lever** the dictation and
> model-audio legs ride on. The lever shipped with #2887; **#2897 (local vs model audio) extends
> it** with an over-limit variant (ST-9). One `F-<n>` per lever requirement.
>
> **Verification policy: live** — the feed legs run on the running app (`FREDO_STT_FEED_WAV`);
> a non-drivable lever is a **NAMED BLOCKER (G-053) + a unit/static pin**, never a fabricated PASS.
>
> **Feature tests:** voice-dictation. Runs against the `spec/2897` tip.
>
> **The lever contract:** `FREDO_STT_FEED_WAV=<abs in-repo WAV>` replaces the capture source with
> a paced 1× reader and constructs **NO** `cpal` device. Producer:
> `.opencode/tests/voice-dictation/fixtures/generate-dictation-phrase.mjs`. **Nothing here sources
> audio from outside the repo (G-172/G-009)** — no `~`, `%USERPROFILE%`, `node_modules`, `~\.cargo`,
> `C:\Windows\Media`, or STT model directory.

- [ ] F-1 (ST-9 / supports REQ-5 + REQ-6): **Committed short fixture byte-contract + generator determinism.** Run
      `node .opencode/tests/voice-dictation/fixtures/generate-dictation-phrase.mjs` twice into distinct temp copies;
      hash both plus the committed `dictation-phrase-16k-mono.wav`; parse the WAV header and count samples.
  - **Expected:** both runs are byte-identical to each other AND to the committed file (SHA-256 equal); a canonical
    44-byte header (PCM, mono, 16000 Hz, 16-bit), data length 51,200 B, **25,600 samples (1.6 s → eight 3200-sample
    chunks)**, first sample non-zero; no randomness/clock in the generator.
  - **Edge:** re-running in a different cwd/timezone stays byte-identical; a missing/renamed fixture is a FAIL (every
    #2897 L4 leg depends on it); the existing format pin in `capture.rs` must still accept the file.

- [ ] F-2 (ST-9 / supports REQ-6): **Parameterised over-limit variant (the F-106 gate).** Invoke the duration variant the
      developer shipped (contract: a `--seconds <N>` argument; e.g. `node .opencode/tests/voice-dictation/fixtures/generate-dictation-phrase.mjs --seconds 31`
      → `dictation-31s-16k-mono.wav`); run it twice; hash; parse the header.
  - **Expected:** a **≥ 31 s** WAV, 16 kHz mono 16-bit PCM, deterministic (two runs byte-identical), sample count
    `== 31,000 × 16000`, data length `== samples × 2`; the existing 1.6 s fixture and its byte-contract pin are unchanged.
  - **Edge:** exactly at the pinned ceiling (`MAX_AUDIO_CLIP_MS`), 2× the ceiling, a non-integer seconds arg; **if the
    parameterised generator is NOT shipped → NAMED BLOCKER + the CI/unit non-lossy pin (`at_limit:true`, `truncated:false`,
    `durationMs == captured duration`) — never a hunt for a long WAV outside the repo.**

- [ ] F-3 (REQ-5 / REQ-8 support): **The feed seam is the sanctioned audio source for L4.** Set `FREDO_STT_FEED_WAV` to the
      in-repo fixture via
      `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 2897 -EnvVars @{ FREDO_STT_FEED_WAV = "C:\Code\fredo\.opencode\tests\voice-dictation\fixtures\dictation-phrase-16k-mono.wav" }`;
      start the app; `stt_start`; watch `stt_status` / `stt:state`; stop.
  - **Expected:** feed mode constructs **NO** `cpal` device (record the device list — it is irrelevant), the session goes
    live from the file paced 1× real time, and `stt_stop` releases cleanly; the app boots and stays responsive.
  - **Edge:** env path containing spaces; a relative path (record whether it resolves); a mode switch inside the same
    session; a silent/empty WAV; `dev-env` refuses the env var → report as a named tooling gap.

- [ ] F-4 (non-vacuous control / G-172): **UNSET-env control.** Run the same `stt_start` WITHOUT `FREDO_STT_FEED_WAV` set.
  - **Expected:** no fed samples — the live leg legitimately produces liveness only when the env is set; the tester
    records the unset-run outcome beside the set-run outcome for **every** L4 leg.
  - **Edge:** the control run must not be scored as a product FAIL when the host has no physical mic; it only proves the
    lever is not vacuous.

### #2897 run log — testing round 1 (`spec/2897 @ b2b2e4df`, 2026-09-19, live)

- **F-1 PASS** — committed `dictation-phrase-16k-mono.wav`: 51,244 B, SHA-256 `33c2f129d17a555b9faad66e21eab5c8069712c8836cc8d363e97c1555343428`, 16 kHz mono 16-bit, 44-byte header, 51,200 data bytes, **25,600 samples (1.6 s)**, first sample 15482. Regeneration via `bun generate-dictation-phrase.mjs` produced the byte-identical file (same hash as the developer's determinism receipt).
- **F-2 PASS** — `--seconds 31` → `dictation-31s-16k-mono.wav`, 992,044 B, 496,000 samples, SHA-256 `06a192e647f4c2b1a273c0e4cbf6445e88a8865d021630d89c6006cf51f1cfa1` (matches the developer receipt); 60 s (960,000 samples) and 120 s (1,920,000 samples) variants also generated.
- **F-3 PASS** — feed seam live via `stt_start` → `{started:true, deviceName:"stt-feed", sampleRate:16000}` (the virtual mic reports 48000 Hz → the feed branch is proven; no `cpal` device).
- **F-4 PASS** — UNSET-env control: the pre-feed session used the virtual-mic path at 48000 Hz with a hold-length (non-1.6 s) clip → the fed observation is non-vacuous.
- **Env form used (tooling gap):** the documented `powershell -File dev-env.ps1 -EnvVars @{ … }` form fails (`Cannot convert the "System.Collections.Hashtable" value of type "System.String"`); `FREDO_STT_FEED_WAV` was set in the parent environment of an allowlisted `bun` launcher invoking `dev-env.ps1 -Action Up`. No product change; recommend documenting a string form.
