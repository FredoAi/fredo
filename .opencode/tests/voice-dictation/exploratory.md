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
