# Voice Input — Exploratory

> Unscripted edge/failure probes for the STT spike (#2876). The Tester adds findings here; a
> confirmed finding PROMOTES to `functional.md` as a new `F-` row (keep the origin note).
> **Verification policy: live.** Runs on the running Fredo POC on `spec/2876`.
>
> A probe whose lever cannot be driven on this host is a **named blocker (G-053)** with a
> unit/static pin — never fabricated.

## Prompt lines

- [ ] E-1: **Device loss mid-session.** Start listening on the real mic, then disable/unplug the
      capture device mid-utterance. Does listening end gracefully (named error or silent stop), does
      the app stay alive, and is the partial-so-far preserved in the bar input? Any crash, hang, or
      stale "listening" indicator after the device is gone is a finding.

- [ ] E-2: **Network blocked mid-session.** Start transcribing, then activate the network block
      mid-session (and/or toggle airplane mode). Does transcription continue uninterrupted with no
      crash and no retry storm? Any drop, stall, or error attributable to the network event is a
      finding. Reference F-6.

- [ ] E-3: **Model file changed under the running engine.** Start listening, then truncate or
      replace the loaded model file on disk. Does the running session continue (model is resident),
      and does a subsequent engine start fail cleanly with a named error? Any crash is a finding.

- [ ] E-4: **Permission revoked between sessions.** Grant mic permission, transcribe, then revoke
      the Windows/WebView2 permission and re-trigger listening. Does the POC show the denial state
      without crashing? Any silent failure with no user-visible state is a finding.

- [ ] E-5: **Stop mid-utterance.** Press the stop lever (Escape and/or second Ctrl+Space) while the
      speaker is mid-word. Is the transcript frozen and kept, dropped, or promoted to a final? Does
      any stale partial arrive AFTER the stop? Reference F-10.

- [ ] E-6: **Rapid start/stop churn.** Rapidly toggle the listening flow (≥5 cycles fast) — does the
      engine start/stop cleanly each time, or does it leak a stream / double-start / stick in
      listening? Any console error or orphan audio stream is a finding.

- [ ] E-7: **Ctrl+Space while already listening.** Press Ctrl+Space again while the listening flow is
      active — is it a clean stop, a no-op, or does it conflict with the #2823 toggle (double
      action)? Any competing handler (listen-stop vs launcher-toggle) is a finding.

- [ ] E-8: **Branch precedence collision.** Companion ACTIVE **and seated** while the bar input is
      focused, then Ctrl+Space. Does branch (2) (bar listening) win over branch (1) (companion
      listening), per the contract? Wrong-branch selection is a finding. Reference F-8.

- [ ] E-9: **Transcript vs pre-existing bar text.** Put text in the bar, then listen and speak —
      is the partial inserted or does it replace the existing text? Record the actual; a result
      that contradicts the specified behavior is a finding. Reference F-9.

- [ ] E-10: **Empty / silent input.** Start listening and stay silent (or feed a silent fixture)
      for several seconds — any phantom partial text, runaway buffer, or CPU spin? A hallucinated
      partial from silence is a finding.

- [ ] E-11: **Long utterance stability.** Speak continuously for ≥30 s — does the bar keep updating
      without lag growing unboundedly, memory creep, or a dropped tail? Record memory before/after.
      Reference F-2.

- [ ] E-12: **Non-ASCII / numbers / punctuation.** Speak a sentence containing numbers and a proper
      noun — is the partial text sane (the spike does not need perfect accuracy, but garbage
      output, mojibake, or a crash is a finding)?

- [ ] E-13: **Re-theme while listening.** Switch theme/accent while the listening cue is visible —
      does the cue re-tint token-native (`var(--accent-primary)` / `tint()`) with no hardcoded
      color and no interruption to the transcript? Any stale/off-token cue is a finding.

- [ ] E-14: **Window/lifecycle churn while capturing.** Open a feature window / minimize the
      launcher while listening — does capture continue, or does it stop cleanly? Any orphaned
      capture (listening continues invisibly) or crash is a finding.

## Promoted findings

> Confirmed probes promoted to `functional.md` are listed here with their `F-<n>` target.

- **E-15 → F-15 (round 1, 2026-09-14):** engine start with a **size-valid / content-invalid** model (byte-exact garbage encoder) produced an unrecoverable MCP-bridge hang + a native abort in the dev log (`Rust cannot catch foreign exceptions` / `STATUS_STACK_BUFFER_OVERRUN`) instead of a typed `engineStartFailed`. The size gate passes it (only SHA would catch it); the probe deliberately does not re-read SHA. Promoted to `F-15`.

## Run log — round 2 (2026-09-14, `spec/2876` @ `84ff1ac`, fix `d9a9f8d`)

- **E-15 RESOLVED (round 2).** The ST-7.1 content-integrity gate makes the same size-exact garbage encoder return typed `modelCorrupt` in ~2 s with the app responsive; the ST-7.2 no-join removes the wedge path. The round-1 native-abort symptom did not reproduce. (Confirmed; F-15 now PASS.)
- **E-10 observed (silent input).** The only capture device is the silent virtual `Micrófono (Iriun Webcam)`; across several listening sessions the bar stayed `""` and **no phantom/partial text** was produced from silence — no hallucinated partial, no runaway bar mutation. (Environment-limited: this is a no-audio observation, not a real-speech probe.)
- **E-3 observed (model file changed under the running engine).** The content gate runs before `OnlineRecognizer::create`, so a model replaced between gate and load would still reach native code — the **TOCTOU residual** is documented by the developer as out of spike scope (#2877). Not re-probed live this round.
- **E-4 / E-2 / E-1 / E-5 / E-6 / E-7 / E-9 / E-11 / E-12 / E-13 / E-14** — not driven this round (environment levers: real mic / network block / OS permission; or no UI re-drive required for the fix delta). Same named blockers as round 1 (G-053).

---

## #2877 extension — local STT foundation probes

> Issue #2877 production-hardens the spike into the foundation. Promote any confirmed invariant to
> `functional.md` as a new `F-` row (keep the origin note). Live policy; an undrivable lever is a
> named blocker (G-053) with a unit/static pin — never fabricated. **MOVED to #2878:** the
> context-dependent Ctrl+Space branch probes (old E-7/E-8) belong to the surface wiring and are not
> re-run as FAIL here.

- [ ] E-16: **Claim / focus or automation limitation.** Try to drive the Ctrl+Space disabled-chord gate (functional F-18) and the enabled start path via real key events. Does focus land? If not, is the fallback (direct `stt_start` invoke + unit-pinned chord selection) recorded as the lever used? Any silent no-op reported as a PASS without naming the lever is a finding.
  - Prompt: real `keydown` Ctrl+Space with the launcher focused vs the direct invoke; `tauri_ipc_monitor` for `stt_start`.

- [ ] E-17: **Network blocked mid-transcription.** Start a real transcription, then activate the network block mid-session (and/or toggle airplane mode). Does transcription continue with no crash and no retry storm? Any drop, stall, or error attributable to the network event is a finding. Reference functional F-25.
  - Prompt: block after the first partial; watch `stt:transcript` continuity + console.

- [ ] E-18: **Model file changed under the running engine (TOCTOU residual).** Start listening, then truncate/replace the loaded model file on disk. Does the running session continue (model resident), and does a subsequent engine start fail cleanly with a typed code? Any crash/abort is a finding. (Spike E-3 documented this as a #2877 residual — re-probe.)
  - Prompt: truncate the encoder after a successful start; then `stt_stop` → `stt_start`.

- [ ] E-19: **Device switch / vanished device mid-session.** Start on one input device, then switch the OS default (or unplug/disable the device) mid-utterance. Does listening end gracefully with a typed code, does the app stay alive, and is the partial preserved? Any stale "listening" indicator or silent hang is a finding. Reference functional F-26/F-29.
  - Prompt: change the default input while listening; read `stt_status` + console.

- [ ] E-20: **Download interrupted at a realistic offset + resume.** Kill the app (or close the settings window) mid-encoder download after ~35 MB has landed; reopen and re-trigger. Does the step read `incomplete` with the partial offset, and does the resume start from the persisted offset and verify in place? Any append-onto-garbage or restart-from-zero is a finding. Reference functional F-22 and `llama-setup` E-16/E-17.
  - Prompt: compare the on-disk partial bytes before/after; read the first resume progress event.

- [ ] E-21: **Enabling voice never silently captures.** Toggle voice ON but do NOT start listening; watch for any capture start, mic-in-use indicator, or CPU activity. Then start listening and confirm the visible indicator appears BEFORE or WITH the first capture.
  - Prompt: OS mic-in-use indicator + `stt_status` while merely enabled; sample the indicator at <= 50 ms around the start boundary (G-140).

- [ ] E-22: **Autosend OFF/ON boundary (setting only, #2878 boundary).** Toggle the autosend setting and, while nothing consumes the transcript yet, confirm no unintended send/submit path fires from this spec's surface.
  - Prompt: toggle autosend with a live transcript present; assert no Enter/submit side-effect attributable to the setting (the send behavior is #2878).

- [ ] E-23: **Long silence / endpoint timing.** Stay silent for > 10 s after speaking; does an endpoint fire at the configured trailing-silence window without a runaway buffer or a phantom segment? Record the observed endpoint delay. Reference functional F-24.
  - Prompt: timestamp the last partial → `is_final: true` transition.

- [ ] E-24: **Repeated enable/disable + start/stop churn (leak).** Cycle enable→start→stop→disable 10 times; watch for leaked capture handles, accumulated threads, memory creep, or a stuck indicator.
  - Prompt: memory snapshots across cycles; OS mic indicator; console.

## Run log — #2877 round 1 (2026-09-15, `spec/2877` @ `dbb3843`)

- **E-16 observed (lever recorded).** The real Ctrl+Space chord DID land in the WebView (disabled gate → case 3 `open`, bar focused) — no focus fallback needed for the disabled case; the direct `stt_start` invoke was used for the typed-code probes.
- **E-17 / E-18 / E-19 / E-23 UNVERIFIED (named blockers).** Mid-transcription network block (no elevation/adapter lever), TOCTOU model swap (the size-exact garbage encoder was rejected cleanly by the SHA gate — no crash, but a true mid-session swap was not driven), and mid-session device loss/endpoint timing (silent virtual device only).
- **E-20 PASS (observed).** Interrupted-resume: a genuine 35,000,000 B partial encoder + ≥ 25.9 s idle, then a real `download_stt_model` whose first progress event carried the on-disk offset (35,000,000) and completed in place to 71,083,163 with the SHA verified. (Related functional F-22.)
- **E-21 PASS (observed).** Enabling voice alone never started capture (`stt_status` idle; the engine is constructed only on first `stt_start`); the visible cue appeared with the session (the 6 s hearing-nothing hint fired on silence); no capture ran without a visible indicator on a clean single start.
- **E-22 observed.** Toggling autosend produced no send/submit side-effect (setting-only); the toggle's behaviour caption flipped. (Dispatch is #2878.)
- **E-24 observed (3 cycles, measured).** 3 start/stop cycles re-opened cleanly; WS returned from 182.6 MB (engine loaded) to 79.5 MB after stop; no stuck indicator, console clean.

### Promoted findings

- **E-25 → F-38 (CONFIRMED DEFECT, promoted):** a duplicate `stt_start` while a session is live returns the correct typed `alreadyListening` but the backend emits `stt:state {listening:false}` for that path, so the frontend clears the live indicator (launcher cue disappears; the companion bubble flips to its error variant with no Stop control) while `stt_status` still reports `listening:true` and the mic keeps capturing. Violates R-5.3/AC5 ("never capture audio without a visible active indicator"). Reachable through the binding cascade: `selectCtrlSpaceAction` returns `companion-listen` for a companion-away context regardless of `listening`, so a second Ctrl+Space re-invokes `stt_start`. Repro + suggested fix in `functional.md` F-38. Supersedes the spike-era "clean stop / no-op" question (old E-7).

---

## #2878 extension — launcher autosend commit probes

> Issue #2878 promotes F-53 (batch commit-order + stale-mirror probes) and opens the commit-path
> edge probes below. Live policy; an undrivable lever is a named blocker (G-053) with a static pin.

- [x] **E-26 → F-53 (CONFIRMED DEFECT, promoted):** clearing the bar via the `—` MINIMIZE control does NOT clear the host's synchronous mirror `barTextRef` (`LauncherShell.tsx:514`). A subsequent dictation session that recognizes nothing finalizes against the STALE mirror and **dispatches the pre-Minimize text to Fredo** (a phantom send from an empty bar). Deterministic repro: type `STALE MIRROR PROBE 4477` → click Minimize (bar `value=""`) → `stt_start` → `stt_stop` (no `stt:transcript`) → the reply quotes the stale phrase. Promoted to `functional.md` F-53 (FAIL). **Round 2 (`99144a1`) — RESOLVED:** the finalize evidence is session-scoped (`voice.committed` grew past the session baseline) and `handleMinimize` syncs the mirror; the repro + the prior-session discriminator yield ZERO dispatch (`functional.md` F-53/F-62).
- [x] **E-27 (observed, not promoted): a backend-direct `stt_cancel` (no UI gesture) also commits the bar text.** Invoking the `stt_cancel` command directly ends the session without setting the UI's cancel flag, so the finalize effect treated the leftover bar text (`e`) as an utterance and dispatched it. All three product cancel gestures (Escape, `launcher-cancel` chord, voice-disabled teardown) set the suppression flag first, so it is not directly user-reachable — but **any backend-initiated `launcher` session end** (a typed error / device-loss `stt:state {listening:false, code:…}`) with non-empty bar text would auto-send. Recommend the finalize commit treat a non-null `stt:state.code` end as a cancel. **Round 2 (`99144a1`) — RESOLVED + PROMOTED:** the committed-FINAL evidence rule closes the partial-cancel gap and `voice.errorCode !== null` at finalize takes the cancel branch (typed-error end); both legs live-verified (`functional.md` F-63/F-64).
- [x] **E-28 (observed, not promoted): Minimize leaves `preSessionTextRef` un-mirrored.** Same stale-mirror class as E-26 — the minimize path is the only `setQuery` writer that skips the mirror; fix together. **Round 2 (`99144a1`) — RESOLVED:** `handleMinimize` syncs `barTextRef.current = ''`, so the pre-session capture reads DOM truth and a silent finalize restores an empty bar.
- [ ] **E-29 (probe): mid-session voice disable during a launcher dictation.** Toggle voice OFF while a launcher session runs with bar text: the teardown must stop the session, suppress autosend, and restore the pre-session text. Unit-pinned; live re-probe blocked by the Settings-provider split (the launcher window's `voiceEnabled` does not observe a settings-window toggle without a reload).
- [ ] **E-30 (probe): Ctrl+Space churn while listening.** Press Ctrl+Space twice rapidly in the bar-focused context: exactly one session (no double-toggle/stuck state) and the second chord is `launcher-cancel` (discard), never a send. Partially observed (a first chord press was swallowed in one run, the second landed) — needs a dedicated repeat.

## Run log — #2878 round 1 (2026-09-15, `spec/2878` @ `33cf86d5`)

- **E-26 CONFIRMED + promoted to F-53 (the round's FAIL).** Phantom dispatch via the stale `barTextRef` after the Minimize control; two independent live repros, the second with the model reply echoing the marker ("…find the proof.").
- **E-27 / E-28 observed, not promoted.** The backend-direct cancel commit and the un-mirrored Minimize capture are recorded as fix inputs for the F-53 defect.
- **E-29 / E-30 not driven this round** (Settings-provider split / chord-driver flakiness) — named residual probes, not PASSes.

## Run log — #2878 round 2 (2026-09-15, `spec/2878 @ 99144a19`, fix `99144a1`)

- **E-26/E-27/E-28 RESOLVED** by the ST-1r session-scoped finalize evidence + the `handleMinimize` mirror sync; promoted to `functional.md` F-62 (prior-session discriminator), F-63 (partial-cancel), F-64 (typed-error end), and F-53 now passes.
- **New exploratory probe E-31 (observed, not promoted):** a real-generation busy window is shorter than one `stt_start` round-trip (~4–5 s engine start on the virtual mic), so a "finalize a 2nd dictation while the 1st reply streams" race cannot be driven deterministically through the real backend; the `companionBusy` hard-drop is instead held by the TicTacToe `isInUse` primitive (`functional.md` F-46), and the first finalize's own dispatch is exactly-once (F-51). Not a defect.
- **E-32 (environment, observed):** the app process exited once mid-round immediately after a `stt_start {origin:"companion"}` attempt. `dev-env -Action Logs` showed no panic/abort — only the expected `[stt] audio stream error: A buffer underrun or overrun occurred.` spam (the silent virtual mic). `dev-env -Action Up -Spec 2878` recovered; the leg then passed. Not reproducible; recorded as an environment event, not a product defect.

---

## #2882 extension — hold-Space trigger probes

> Issue #2882 makes Space a gesture on an EMPTY focused bar and retires the Ctrl+Space cascade.
> A confirmed finding PROMOTES to `functional.md` as a new `F-` row (keep the origin note). Live
> policy; an undrivable lever is a named blocker (G-053) with a static/unit pin — never fabricated.
> The pre-#2882 Ctrl+Space cascade probes (E-7/E-8, E-30) are RETIRED with the cascade — do not
> re-run them as PASS or FAIL.

- [ ] E-33: **Hold duration extremes.** Hold Space for ~50 ms (a tap), ~1 s, and ≥6 s (long enough
      for many auto-repeat `keydown`s). For each: exactly one session, a cue present for the whole
      hold with no gap, `listening === false` promptly after the `up`, and no leaked capture handle.
      A tap that leaves a stuck session, a duplicate session under auto-repeat, or a cue gap while
      capturing is a finding (promotes to F-66/F-71).
- [ ] E-34: **Hold while the bar already holds a dictated transcript.** Hold Space with a
      dictation-origin transcript in the bar (non-empty ⇒ REQ-4 says Space is a space). Does a
      literal space land (correct), or does capture start and clobber the transcript? Record the
      observed branch — a started session or a lost/overwritten transcript is a finding (promotes to
      F-67/F-70).
- [ ] E-35: **Disable voice MID-hold.** Start a hold, then toggle `Fredo_companion_voice_enabled`
      to false while Space is still down; release. Does the session stop, the mic release, the cue
      clear, and NO phantom dispatch occur (autosend ON)? Any continued capture (a capture without a
      visible indicator), any dispatch, or a stuck cue is a finding (promotes to F-68/F-71).
- [ ] E-36: **Esc-close vs hold collision.** Press Escape in the same tick as — or immediately after
      — the Space `up`. Exactly one action is expected (finalize OR discard, never both, never a
      z-ordered second action). Any double action, lost utterance, or console error is a finding
      (promotes to F-66/the launcher REQ-11 row).

---

## #2887 extension — resident-ready recognizer probes

> Issue #2887 keeps the recognizer ready while Fredo is idle so the hold-Space dictation starts
> instantly; the indicator must stay honest and no word may be lost. A confirmed finding PROMOTES to
> `functional.md` as a new `F-` row (keep the origin note). Live policy; an undrivable lever is a
> named blocker (G-053) with a static/unit pin — never fabricated.

- [ ] E-37: **Resident dies mid-idle / mid-hold.** Kill the resident recognizer process while the bar
      is armed (nothing dictating), then hold Space; separately kill it during a live hold. Does the
      next hold RECOVER with a bounded start and a typed state, does the mic release, and is there any
      stuck "listening" cue or error dialog? A silent hang, a stuck cue, or a crash is a finding
      (promotes to F-80/REQ-8).
- [ ] E-38: **Resource creep over many dictations.** Run ≥20 hold→release cycles with the resident
      armed; sample the working set and thread/handle counts every 5 cycles. Does the working set
      return to the resident baseline each time, or does it creep? Any monotonic growth or leaked
      capture handle is a finding (promotes to F-82/REQ-10).
- [ ] E-39: **Input device changes while resident-ready.** Warm the resident on device A, switch the
      OS default input to device B (or unplug A), then hold. Does the hold start on the new device
      with a bounded time, does `noDevice` come back typed, and is the mic released? A stale device
      handle, a silent capture, or a hang is a finding (promotes to F-80/REQ-8).
- [ ] E-40: **Latency under contention / after sleep-resume.** Hold Space while the machine is under
      heavy CPU load and after a sleep→resume with the resident armed. Record the press→capture-active
      numbers, the indicator honesty samples, and any lost opening word. A cold-equivalent regression
      after resume, or a dishonest indicator under load, is a finding (promotes to F-77/F-76).
- [ ] E-41: **Readiness/indicator boundary race.** Press Space in the same tick as the resident's
      ready transition, and release before capture goes live. Does the press land exactly one ordinary
      space (never-live) with no cue ever claiming listening, or is a session started with a
      dishonest/absent indicator? Any listening claim before capture is active is a finding (promotes
      to F-76/REQ-3).
- [ ] E-42: **Second app instance with a resident.** Launch a second Fredo instance (or restart the app
      mid-warm) and hold Space. Does the hold still work on the focused instance, is there resource
      contention (port/audio device), and does either instance show a dishonest indicator? Any
      cross-instance mic conflict or stuck state is a finding (promotes to F-80/R-24).

### #2887 testing round 1 — result

- [ ] _(pending — the Tester appends probe findings here; do not pre-fill)_

---

## #2888 extension — casing / name / normalization probes

> Issue #2888 normalizes the dictated transcript (sentence case, intentional capitals, the name
> `Fredo`). A confirmed finding PROMOTES to `functional.md` as a new `F-` row (keep the origin note).
> Live policy; an undrivable lever is a named blocker (G-053) with a static/unit pin — never
> fabricated. Content probing uses the L3 synthetic `stt:transcript` lever on the REAL
> `adapterBridge.listen` channel (functional.md `#2888` testability contract).

- [ ] E-43: **Name at the boundaries.** Inject finals where `FREDO` is the FIRST token, the LAST token,
      possessive (`FREDO'S`), quoted (`"FREDO"`), hyphenated (`FREDO-LIKE`), and immediately followed by
      , `.` `!` `?`. Does every occurrence survive with the right case and the punctuation intact? A
      lowercased/dropped/duplicated occurrence is a finding (promotes to F-86..F-88).
- [ ] E-44: **Capitals the rule does NOT know.** Inject a mixed raw segment containing `NASA`,
      `iPhone`, `McDonald`, `OK`, `I`, `I'M`, `USB-C`, `10GB`, `2FA`. Compare against the Architect's
      TWO declared tables (`transcriptCase.ts` `PRESERVED_TOKENS` + `FREDO_CONFUSABLES`). Record exactly
      which tokens survive and which are flattened. Distinguish a *declared* boundary (a token absent
      from `PRESERVED_TOKENS` — expected to flatten, e.g. `NASA`) from an *undeclared* over-reach (a
      token that IS in the table but still flattens, or a table member rewritten) — the latter is a
      finding (promotes to F-84). Never widen the table yourself to make a probe pass.
- [ ] E-45: **Idempotence / mixed-case raw.** Inject an ALREADY sentence-cased final, then an ALL-CAPS
      one, then a mixed `dEpLoY tHe bUiLd`. Is the transform idempotent (a second pass changes nothing)
      and does the mixed case land in the ONE declared output? A transform that oscillates between
      partials (each partial re-casing differently) is a finding (promotes to F-83/F-85).
- [ ] E-46: **Streaming partials under the transform.** Drive a partial sequence (`HELLO` → `HELLO
      WORLD` → `HELLO WORLD AGAIN`) and watch the bar at each revision. Does the field grow
      monotonically and stably (no flicker between `Hello world` and `Hello World`), and does the final
      match the last partial plus the declared rule? Any re-casing churn per partial is a finding.
- [ ] E-47: **User edits are never re-cased.** During/after a dictation, type real keystrokes into the
      bar (including lowercase and all-caps text) and let a further final arrive. Is the user's own
      typing left BYTE-EXACT (no normalization applied to their keystrokes), and does the app's own
      rule apply only to the dictated content? Any re-casing of typed text is a finding.
- [ ] E-48: **Non-letter content survives.** Inject finals with digits/decimals, `+`/`%`/`$`,
      emoji, non-ASCII accents, and a URL-ish token. Is everything except letter case byte-preserved
      (no mojibake, no lossy encoding, no crash)? Any dropped/modified non-letter content is a finding
      (promotes to F-85).
- [ ] E-49: **Multi-segment turn (segment vs turn casing).** Inject two finals of one turn —
      `HELLO` then `WORLD` — and read the joined bar. The Architect's declared rule (`atUtteranceStart`)
      says the opening capital is derived ONCE per session, so the expected result is **`Hello world`**
      (a mid-utterance endpoint must not manufacture a new sentence). Any other result — or a
      `Hello World` — is a finding against the declaration (promotes to F-85/F-100); if the shipped
      behaviour differs from the declaration, report expected-vs-actual and escalate rather than
      choosing a winner.
- [ ] E-50: **Long / repeated-token transcript.** Inject a ~120-word final and one with a word repeated
      200×. Does the interval stay bounded (cross-ref F-95), does memory return, and does the bar value
      remain complete (no truncation at the field's 108 px cap — the value, not the rendered height)?
      Unbounded growth, a truncated value, or a dropped tail is a finding.
- [ ] E-51: **Session churn under the transform.** Run ≥ 10 hold→inject→release cycles with varied
      casing; confirm each fresh session starts from a clean normalization state (no carry-over of the
      previous session's casing decision, e.g. a leading capital leaking into a mid-turn injection).
      Any cross-session carry-over is a finding (promotes to F-83).

### #2888 testing round 1 — result

- [ ] _(pending — the Tester appends probe findings here; do not pre-fill)_

---

## #2897 extension — speech-handling mode probes (local ↔ model audio)

> Issue #2897 adds the mode choice. A confirmed finding PROMOTES to `functional.md` as a new `F-` row
> (keep the origin note). Live policy; an undrivable lever is a named blocker (G-053) with a static
> pin — never fabricated. Content/audio via L3/L4; lifecycle via L1/L2 (see `functional.md` `#2897`).

- [ ] E-52: **Switch mode MID-listen.** Start a local capture, then select `model audio` while
      listening (and the reverse). Does the session end cleanly with no orphan capture, no stuck/
      dishonest indicator, and no half-committed transcript? A continued capture in the old mode, a
      stuck cue, or a silent discard is a finding (promotes to F-102/F-104).
- [ ] E-53: **Server dies during processing.** Submit a model-audio turn, then stop/kill the managed
      `llama-server` while the UI is in `processing`. Does it transition to the `error` state with an
      actionable message and no crash/hang, and is the captured audio accounted for (retry/fallback)? A
      freeze, an unhandled console error, or a silent loss is a finding (promotes to F-104/F-107).
- [ ] E-54: **Cancel during processing.** Cancel/stop while the model-audio turn is `processing`. Is the
      turn cancelled exactly once, the indicator cleared, and no late model reply dispatched after a
      cancel? A post-cancel reply, a duplicate dispatch, or a stuck `processing` state is a finding
      (promotes to F-104).
- [ ] E-55: **Over-limit then immediate re-listen.** After a `>30 s` clipped/rejected turn, immediately
      start a fresh model-audio turn. Does the surface clear, the buffer reset, and the next turn
      behave normally (no stale clip, no compounding bound)? A stale/second clip silently attached, or
      a persistent error state, is a finding (promotes to F-106).
- [ ] E-56: **Rapid mode toggling + persistence churn.** Toggle the mode ≥10× rapidly (idle, and around
      a hold), then restart and read the persisted value. Is the final value coherent and persisted, with
      no leaked listener/effect loop and no console `Maximum update depth exceeded`? Any duplicate
      listener, run-away re-render, or incoherent persisted value is a finding (promotes to R-31).

- [ ] E-57: **Capability-probe honesty.** Force each `stt_audio_capability` state (`ready` / `unsupported` /
      `serverUnavailable` / `unknown`) and cross-check the readiness row's copy + action against what the
      pinned model/server can ACTUALLY do (ST-0's receipts). Does the UI ever claim `ready` for a model that
      cannot take audio, or infer capability from the model name? A false `ready`, a missing `Use local
      transcription` action, or an action that does nothing is a finding (promotes to F-107/F-110).
      Reference `functional.md` F-110.
  - Prompt: stop the server → read the row; start it on the non-audio model → read the row; compare to the
    `/props` + `input_audio` receipts.

- [ ] E-58: **Mode-audio failure copy + surface.** Kill the managed server AT SUBMIT (after a clip is captured)
      and separately revoke/close the active companion mid-turn. Is the failure surfaced as the typed code with
      CURATED copy (never the raw IPC string), is the fallback offered inline and functional, and does NO
      transcript text appear while the mode is still `model`? A raw error dump, a vanished toast, a stuck
      `processing` state, or a transcript leak is a finding (promotes to F-107/F-109).
  -      Prompt: read the `role="alert"` node's exact text; click `Use local transcription`; re-read the persisted key.

### #2897 testing round 1 — result (`spec/2897 @ b2b2e4df`, 2026-09-19, live)

- **E-52 UNVERIFIED (named blocker).** When the managed server is down the Settings Companion section renders the **wizard**, so `companion-voice-handling-select` is unmounted and a mid-listen mode switch cannot be driven via UI; the per-`stt_start` reader contract is pinned by ST-7 CI.
- **E-53 Observed.** Server down at submit → typed `modelAudioFailed`/`modelAudioUnavailable` `role="alert"`, no hang/crash; a true mid-`processing` kill was not isolated from the app's managed-server auto-relaunch.
- **E-54 Not driven (named).** `processing` renders no Stop/Cancel by design (clip already delivered), so no user cancel exists in that state.
- **E-55 Observed.** After the 30 s auto-stop a fresh `stt_start` opened cleanly (`phase:"capturing"`) with a reset buffer; no stale clip attached.
- **E-56 UNVERIFIED (named).** Same wizard/unmounted-selector blocker as E-52; the persisted value stayed coherent across reads.
- **E-57 PASS.** `ready` when the server is up, `serverUnavailable` when down, never inferred from the model name; consistent with the ST-0 receipts.
- **E-58 PASS.** Curated `role="alert"` copy + a working inline `Use local transcription`; no transcript while mode=`model`.
- **Promoted finding → `functional.md` F-104 (FAIL):** the model-audio `processing` indicator never clears after the turn completes (no turn-completion signal; `stopped` unreachable).

### #2897 testing round 2 — result (`spec/2897 @ be4d3a73`, 2026-09-19, live; fix `f3394e5`)

- **E-52 UNVERIFIED (named, carry-forward).** Same wizard/unmounted-selector blocker as round 1 (with
  the managed server down the Settings Companion section renders the wizard); the per-`stt_start`
  mode-reader contract stays ST-7 CI-pinned. Accepted as a PO-visible limitation in the round-2 Fix Plan.
- **E-53 Observed (re-confirmed).** `stop_llama_server` → typed `modelAudioUnavailable` alert at submit,
  no hang/crash; a true mid-`processing` kill still not isolated from the managed-server auto-relaunch.
- **E-54 Not driven (named).** `processing` deliberately renders no Stop/Cancel (the clip is already
  delivered), so no user cancel exists in that state.
- **E-55 Observed (re-confirmed).** After the 30 s auto-stop a fresh `stt_start` opened cleanly
  (`phase:"capturing"`, reset buffer); no stale clip attached.
- **E-56 UNVERIFIED (named).** Same wizard/unmounted-selector blocker as E-52.
- **E-57 PASS (re-confirmed).** `ready` when the server is up, `serverUnavailable` when down; never
  inferred from the model name.
- **E-58 PASS (re-confirmed).** Curated `role="alert"` copy + a working inline `Use local
  transcription`; no transcript while mode=`model`. Also observed on the null-clip path.
- **Round-2 resolution of the round-1 promoted F-104 finding:** the model-audio `stopped` state is now
  reachable — the chip clears on `llm-done` within the same session (`F-104 PASS`).

---

## #2903 extension — model-audio app-action probes (open/close parity)

> Issue #2903 makes the model-audio path perform open/close app requests. A confirmed finding PROMOTES
> to `functional.md` as a new `F-` row (keep the origin note). Live policy; an undrivable lever is a
> NAMED BLOCKER (G-053) with a static/unit pin — never fabricated. App-action content uses L3 (the
> synthetic `llm-skill-call` on the REAL channel); the audio lifecycle uses L4 (see
> `functional.md` `#2903`).

- [ ] E-59: **Duplicate / out-of-order selections.** Emit two identical `llm-skill-call` payloads in
      quick succession, then two different apps. Does each resolve exactly once, does the second
      raise (not duplicate) an already-open window, and does no reply land for a dropped stale push? A
      duplicate window, a doubled reply, or a reply applied after its generation settled is a finding
      (promotes to F-111/F-118).
- [ ] E-60: **Selection during a terminal turn.** Emit the selection (a) after a limit-reached stop,
      (b) after a cancel, (c) after an `llm-error`. Does the action still perform honestly, or does a
      reply land with no generation to own it / a generation settle without a reply? A stuck pending
      generation, a phantom window, or a vanished toast is a finding (promotes to F-121).
- [ ] E-61: **Mode switch between selection and action.** Emit the selection in mode=`model`, then
      switch to `local` before release (and the reverse). Does the action still perform exactly once
      with no orphan capture and no stuck/dishonest indicator? A dual-path action or a lost action is a
      finding (promotes to F-118).
- [ ] E-62: **Prose flash vs the deterministic reply.** Watch the bubble at ≤50 ms from selection to
      settle with the model streaming prose first. Is any transient "I can certainly open …" visible,
      and is the SETTLED text the deterministic reply? A settled prose claim with no action (or with an
      action) is a finding (promotes to F-121). Record whether a transient flash occurs — the QA plan
      scores only the settled state, so a flash is a UI/UX note unless declared otherwise.
- [ ] E-63: **Window churn under repeated requests.** Request the same app ≥5× and alternate
      two apps; count windows and reply dispatches per request. Is there exactly one window per feature
      id, no leaked frame, no reply storm, and no console `Maximum update depth exceeded`? Any
      duplicate window or unbounded reply is a finding (promotes to F-111/R-37).
- [ ] E-64: **Server dies at/after dispatch.** Kill the managed server while the model-audio turn that
      would carry the selection is in flight. Does the turn settle with a typed/curated error, perform
      no action, and claim no success? A hang, an unhandled console error, or a false success is a
      finding (promotes to F-120/NFR-2).

### #2903 testing round 1 — result (`spec/2903 @ 813b0060`, 2026-09-20, live)

- **E-59 PASS (observed).** Rapid close→open→open→close on the model-audio channel: never more than ONE Settings window (singleton raise); no duplicate window, no doubled reply. The shipped reply-before-open 800 ms beat makes rapid interleaved requests converge asynchronously — expected shipped behavior.
- **E-60 OBSERVED (not a defect).** An `llm-skill-call` arriving after the generation settled still executes the window action but the deterministic reply is (correctly) not re-applied to the settled generation (`applyAppOpenReply` guards on `isGenerating`/`generationSettled`); no phantom window from a stale push.
- **E-61 NOT DRIVEN (named).** A mode switch between selection and action needs the Settings Companion selector while the managed server is healthy; the mode is read per `stt_start` (CI-pinned). Not exercised this round; no failure claimed.
- **E-62 OBSERVED (synthetic-lever artifact disclosed).** The deterministic reply replaces the streamed prose at settle (bubble sample 0 = pure deterministic string; live region retained it). Because the L3 injection does not terminate the backend generation, the model's later tokens are appended by `onToken` (no post-settle guard) — the bubble can end `Opening SettingsHello! …`. The REAL path emits `llm-skill-call` on `finish_reason:"tool_calls"` and stops (llm-done last), so this is not real-path-reachable. Recorded as a robustness observation, not promoted to a FAIL.
- **E-63 PASS (observed).** 7-injection churn: close→closed, 2×open→singleton, `tell_joke`→zero actions, `open_app Narnia`→zero actions, close→closed. No reply storm, no duplicate window, no `Maximum update depth exceeded`.
- **E-64 NOT DRIVEN (named).** Killing the managed server mid-turn needs in-round isolation from the managed-server auto-relaunch; #2897 E-53 already established the typed curated `modelAudioUnavailable` path. No failure claimed.

---

## #2904 extension — mode-parity render edge probes

> Unscripted probes for issue #2904. A confirmed finding PROMOTES to `functional.md` as a new `F-`
> row (keep the origin note). Live policy; an undrivable lever is a named blocker (G-053) with a
> static/unit pin — never fabricated.

- [ ] E-65: **Mode copy at the narrowest indicator slot.** With the bar narrow and dictating in
      mode=`model`, hold the countdown copy (`Fredo is listening · 10s left`) and the `processing`
      copy (`Fredo is processing your speech…`) — the two widest reservations. Does each stay on ONE
      line (ellipsis acceptable) or stack/push the field? Any letter-per-line string, hidden
      countdown, or field displacement is a finding (promotes to F-127 / `launcher` F-101/F-105).
- [ ] E-66: **Indicator vs a typed query during a model capture.** Type into the field while the
      `Fredo is listening` chip is live (model mode). Does the typed text stay clear of the chip
      (reserved 312px gutter) with no vertical relayout, and does the chip stay one line? Any
      overlap, stacking, or console error is a finding (promotes to `launcher` F-103/F-106).

### #2904 testing round 1 (spec/2904 @ 027bbf1f) — results

- **E-65 PASS (live).** Countdown copy `Fredo is listening · 7s left` (146.8×24) and processing copy `Fredo is processing your speech…` (212.2×24) each on ONE line (whole countdown visible — no ellipsis of the bound); at the narrowest supported window (900×600, bar constant 560) still one line, `fieldContentW ≥ 140`. No promotion.
- **E-66 PASS (live).** Typed `Settings` while the model chip was live (light preset): `fieldContentW 206`, chip one line (`nowrap`/`horizontal-tb`), the typed text clear of the chip (content-box right 928 vs chip left 1029.2), no vertical relayout, console clean. Screenshot `fb6bfb67`. No promotion.
