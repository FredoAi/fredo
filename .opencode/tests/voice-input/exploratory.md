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
> None yet.
