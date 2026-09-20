# Voice Dictation — Exploratory

> Unscripted edge/failure probes for the **capture-feed lever**. A confirmed finding PROMOTES to
> `functional.md` as a new `F-` row (keep the origin note). **Verification policy: live**; an
> undrivable lever is a **NAMED BLOCKER (G-053) + a static/unit pin** — never fabricated.
>
> **FORBIDDEN:** any recorded-speech WAV or out-of-repo asset (G-172/G-009).

## Prompt lines

- [ ] E-1: **Malformed / truncated feed.** Point `FREDO_STT_FEED_WAV` at a byte-truncated or header-corrupt copy of the
      fixture (generate it in-repo), then `stt_start`. Does the app reject it with a typed error and stay responsive,
      and is the mic never left hot? A silent hang, a crash, or a capture left running is a finding. Reference
      `voice-input` F-103/F-109.

- [ ] E-2: **Wrong-format feed.** Feed a stereo / 44.1 kHz / 8-bit WAV (produced in-repo) and a zero-byte file. Does the
      format guard reject it (or the contract resample it) with a clear state, or does it misbehave? Record the actual.
      A silent no-op reported as a PASS without the format noted is a finding. Reference F-3.

- [ ] E-3: **Over-limit feed at and beyond the ceiling.** Feed the ST-9 variant at exactly `MAX_AUDIO_CLIP_MS` and at 2×.
      Does capture auto-stop once, is the buffer reset for the next session, and is no stale second clip attached?
      Unbounded memory growth, a compounding bound, or a stale clip is a finding. Reference `voice-input` F-106.

### #2897 testing round 1 — result

- [ ] _(pending — the Tester appends probe findings here; do not pre-fill)_

---

## #2903 extension — feed + synthetic selection probes

> Issue #2903 runs the L4 feed (audio lifecycle) alongside the L3 synthetic selection (app action).
> A confirmed finding PROMOTES to `functional.md` as a new `F-` row (keep the origin note). Live
> policy; an undrivable lever is a NAMED BLOCKER (G-053) with a static/unit pin — never fabricated.
> **FORBIDDEN:** any recorded-speech WAV or out-of-repo asset (G-172/G-009).

- [ ] E-4: **Feed + selection in the same turn.** Run the L4 1.6 s feed into a mode=`model` session and
      emit the L3 `llm-skill-call` selection during the turn. Does the window open exactly once, does the
      turn settle without a transcript leak, and is there any false action/prose? A transcript appearing
      in model mode, a duplicate action, or a stuck chip is a finding (promotes to `voice-input` F-111).
- [ ] E-5: **Malformed feed on a model-audio turn.** Point `FREDO_STT_FEED_WAV` at a byte-truncated or
      wrong-format copy (generated in-repo), then start a mode=`model` session. Does the turn degrade
      with a typed/curated state, perform no action, and claim no success? A hang, a false success, or a
      capture left running is a finding (promotes to `voice-input` F-120).

### #2903 testing round 1 — result (`spec/2903 @ 813b0060`, 2026-09-20, live)

- **E-4 PASS.** With the L4 feed live, a model-audio turn + L3 `{open_app,{app:"Settings"}}` opened Settings exactly once (max Settings count 1 across 24 samples), the bar stayed `""` (no transcript leak), and the live region read `Opening Settings`.
- **E-5 UNVERIFIED (named).** Not driven: requires a further dev-env restart pointing `FREDO_STT_FEED_WAV` at a byte-truncated/wrong-format copy. Malformed-capture handling is already CI-pinned by #2877 `F-29`/`F-15` (`modelCorrupt`/`noDevice` typed codes). No product failure claimed.

---

## #2914 extension — feed-lever probes on the single-model-audio tip

> Issue #2914 deletes the local STT engine/mode. A confirmed finding PROMOTES to `functional.md` as a
> new `F-` row (keep the origin note). Live policy; an undrivable lever is a NAMED BLOCKER (G-053)
> with a static/unit pin — never fabricated. **FORBIDDEN:** any recorded-speech WAV or out-of-repo
> asset (G-172/G-009). **`stt:transcript` is RETIRED as a lever.**

- [ ] E-6: **Feed + malformed input after the local reader is gone.** Point `FREDO_STT_FEED_WAV` at a
      byte-truncated/wrong-format copy (generated in-repo) on the #2914 tip and start a model-audio
      session. Does the capture degrade with a typed state (no local engine involved), perform no turn
      with garbage, and release the mic? A silent hang, a crash, or a capture left running is a finding
      (promotes to `voice-input` F-131). If the feed seam is gone, record the named blocker instead.
- [ ] E-7: **Feed sample-0 liveness on the model-audio path.** Feed the committed 1.6 s fixture and
      confirm the clip returned by `stt_take_audio_clip` carries the fixture's data from sample 0 (not a
      hold-length virtual-mic clip). A non-1.6 s clip while the env is set is a finding (the lever is
      vacuous or the seam is dead) — promotes to `voice-input` F-133.

### #2914 run log

- [ ] _(pending — the Tester appends probe findings; do not pre-fill)_
