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

### #2897 run log — testing round 2 (`spec/2897 @ be4d3a73`, 2026-09-19, live; fix `f3394e5`)

- **F-1 PASS** — committed `dictation-phrase-16k-mono.wav`: 51,244 B, SHA-256
  `33c2f129d17a555b9faad66e21eab5c8069712c8836cc8d363e97c1555343428`, 16 kHz mono 16-bit, 44-byte
  header, 25,600 samples (1.6 s), first sample 15482 — byte-identical to the developer receipt.
- **F-2 PASS** — `--seconds 31` → `dictation-31s-16k-mono.wav`, 992,044 B, SHA-256
  `06a192e647f4c2b1a273c0e4cbf6445e88a8865d021630d89c6006cf51f1cfa1`, 496,000 samples; the 1.6 s
  fixture and its contract are unchanged.
- **F-3 PASS** — feed seam live: 1.6 s feed → `{deviceName:"stt-feed", sampleRate:16000}`; 31 s feed →
  same; virtual mic reports 48,000 Hz → the feed branch is proven (no `cpal` device).
- **F-4 PASS** — UNSET-env control: the pre-feed sessions used the virtual-mic path at 48,000 Hz with a
  hold-length clip and produced a reply → the fed observations are non-vacuous.
- **Env form used (tooling gap):** unchanged from round 1 — `-EnvVars @{ … }` via `powershell -File`
  stringifies the hashtable; the feed was driven from the parent env of the allowlisted `bun` launcher.

---

## #2903 extension — the feed lever's bound for model-audio app control

> Issue #2903 makes the model-audio path PERFORM app open/close requests. The app-action CONTENT lever
> is the synthetic `llm-skill-call` on the real channel (`voice-input/functional.md` F-111); the L4
> capture feed below carries **liveness only** and can never carry a spoken app request. **Verification
> policy: live.** No prior row is retired.

- [ ] F-5 (#2903 support): **The fixture's declared bound is liveness, never content.** Read the
      generator's provenance header (`generate-dictation-phrase.mjs:14-23`); assert the committed
      fixture is described as non-intelligible; grep the #2903 rows for any claim that the feed carries
      an app intent.
  **Expected:** the fixture is explicitly a deterministic synthetic waveform whose only job is to be a
      valid 16 kHz mono 16-bit PCM WAV with non-zero signal at sample 0; NO #2903 row reads it as
      speech; the app-action content lever named is the in-repo synthetic `llm-skill-call` event.
  - **Edge:** a row that scores an L4-fed turn as "opened an app" is a FALSE PASS; an in-repo
    intelligible-speech WAV does not exist — if the Architect requires the acoustic leg, the tester
    `block`s naming it (G-172/G-009); never hunt media outside the repo.

- [ ] F-6 (#2903 support): **The env lever form is drivable (`-EnvVar NAME=value`).** Launch with
      `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 2903 -EnvVar
      "FREDO_STT_FEED_WAV=C:\Code\fredo\.opencode\tests\voice-dictation\fixtures\dictation-phrase-16k-mono.wav"`;
      `stt_start`; watch `stt_status`/`stt:state`; `stt_stop`. Pair with an UNSET-env control (F-4).
  **Expected:** the feed branch is taken (`{deviceName:"stt-feed", sampleRate:16000}`, NO `cpal` device),
      the session goes live 1× real time, `stt_stop` releases cleanly, the app stays responsive; the
      UNSET control uses the shipped `cpal` path so the observation is non-vacuous.
  - **Edge:** a path containing spaces; `dev-env` refusing the env var → report as a tooling gap, not a
    product FAIL; a silent/empty WAV.

### #2903 testing round 1 — result (`spec/2903 @ 813b0060`, 2026-09-20, live)

- **F-5 PASS.** `generate-dictation-phrase.mjs:14-23` read verbatim: "This is NOT recorded speech and is not intelligible. It is a deterministic synthetic waveform whose ONLY job is to be a valid 16 kHz mono 16-bit PCM WAV with non-zero signal at sample 0 … exercises the paced-feed / liveness path. The transcript-CONTENT claim is carried by the sanctioned synthetic `stt:transcript` lever … never by this file." No #2903 row scores an L4-fed turn as "opened an app" — the app-action lever is the in-repo synthetic `llm-skill-call` event.
- **F-6 PASS (string env form).** `dev-env.ps1 -Action Down` then `-Action Up -Spec 2903 -EnvVar "FREDO_STT_FEED_WAV=C:\Code\fredo\.opencode\tests\voice-dictation\fixtures\dictation-phrase-16k-mono.wav"` → "Injected env var FREDO_STT_FEED_WAV"; `stt_start` → `{started:true, deviceName:"stt-feed", sampleRate:16000}` (no `cpal` device); `stt_stop` → `phase:"processing"`; app responsive. UNSET control = the pre-restart legs on the virtual mic (`deviceName:"Micrófono (Iriun Webcam)"`, `sampleRate:48000`) ⇒ the fed observation is non-vacuous. The `-EnvVars @{…}` hashtable form remains broken (tooling gap).

---

## #2914 extension — the feed lever against the single-model-audio tip (the local mode is gone)

> Issue #2914 deletes the on-device sherpa STT engine (and with it the local transcription branch of
> the voice-handling reader). The capture-feed seam (`FREDO_STT_FEED_WAV`, defined in
> `infrastructure/voice/capture.rs`) is a CAPTURE-source lever, not the recognizer, and fed
> model-audio turns in #2897/#2903 — but the spec's "local branch of the reader" deletion may remove
> it. Rows **F-7..F-9** decide that explicitly; a removed seam is a **NAMED BLOCKER** carried with the
> unit/CI + `stt:state` residual, never a fabricated PASS (QA Discussion #2914-1).
> **Verification policy: live.** The fixture/generator contract (F-1/F-2) and the UNSET-env control
> (F-4) are unchanged and in force.

- [ ] F-7 (#2914 support — the decider): **Does the feed seam survive and still feed model-audio?** Launch
      with the string env form
      `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 2914 -EnvVar
      "FREDO_STT_FEED_WAV=C:\Code\fredo\.opencode\tests\voice-dictation\fixtures\dictation-phrase-16k-mono.wav"`;
      `stt_start` (model mode); read `stt_status`/`stt:state`; `stt_stop`; `stt_take_audio_clip`.
  **Expected (seam retained):** the feed branch engages — `{deviceName:"stt-feed", sampleRate:16000}`, NO
      `cpal` device — and the bounded clip returned is the fed fixture (1.6 s); the app stays responsive.
      **Expected (seam removed):** the env var is ignored and the `cpal`/virtual path is used → record it
      as a **NAMED BLOCKER** naming the deletion, with the residual = the `build_audio_request_body`
      `input_audio` unit/CI pin + the live `stt:state` lifecycle; this row does NOT then PASS.
  - **Edge:** a path containing spaces; a relative path; `dev-env` refusing the env var (tooling gap, not
    a product FAIL); a stale fixture; the `-EnvVars @{…}` hashtable form (documented broken — use `-EnvVar`).

- [ ] F-8 (#2914 support — the fixture contract is unchanged): **The committed fixture + its deterministic
      generator still hold** (re-run F-1/F-2 on the #2914 tip).
  **Expected:** `dictation-phrase-16k-mono.wav` byte-identical (SHA-256 `33c2f129…`), 16 kHz mono 16-bit
      PCM, 25,600 samples / 1.6 s; the `>30 s` variant regenerates deterministically; the format pin in
      `capture.rs` (if `capture.rs` survives) still accepts the file. A removed/changed `capture.rs` that
      drops the fixture format pin is reported with expected-vs-actual (it breaks the over-limit lever).

- [ ] F-9 (#2914 support — non-vacuous control): **UNSET-env control on the model-audio tip.** Run F-7's
      `stt_start` WITHOUT `FREDO_STT_FEED_WAV` set.
  **Expected:** the shipped `cpal`/virtual path is used (non-1.6 s, hold-length clip) so the fed observation
      is non-vacuous; the control is NEVER scored as a product FAIL when the host has no physical mic.

### #2914 run log — round 1 (`spec/2914 @ a5a882b9`, live)

- **F-7 PASS — the seam SURVIVED.** `dev-env.ps1 -Action Up -Spec 2914 -EnvVar "FREDO_STT_FEED_WAV=C:\Code\fredo\.opencode\tests\voice-dictation\fixtures\dictation-phrase-16k-mono.wav"` → `stt_start` `{started:true, deviceName:"stt-feed", sampleRate:16000}` (no `cpal`); `stt_stop` → `{phase:"processing"}`; `stt_take_audio_clip` `{format:"wav", sampleRate:16000, durationMs:1600, truncated:false, base64Len:68328}` == the fed fixture; app responsive.
- **F-8 PASS.** Committed fixture SHA-256 `33c2f129d17a555b9faad66e21eab5c8069712c8836cc8d363e97c1555343428` (51,244 B, 16 kHz mono 16-bit, 25,600 samples) byte-identical after regeneration; `--seconds 31` → `dictation-31s-16k-mono.wav` 992,044 B / 496,000 samples / SHA-256 `06a192e647f4c2b1a273c0e4cbf6445e88a8865d021630d89c6006cf51f1cfa1`; `capture.rs` format pin still accepts the fixture.
- **F-9 PASS (non-vacuous control).** UNSET env → `stt_start` `{deviceName:"Micrófono (Iriun Webcam)", sampleRate:48000}` and an 800 ms hold-length clip (≠ 1.6 s).
