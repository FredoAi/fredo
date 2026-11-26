# Companion Vision — Exploratory

> Unscripted edge/failure probes for the companion vision path (issue **#3234**). Confirm a finding,
> then promote it to `functional.md` as a new `F-` row (keep the origin note). A confirmed defect is
> a `## Tests Runs` FAIL; a non-drivable probe is a named blocker, never a PASS.

- Probe: capture a region of **very** small text (a system font at a small size) that the model
  cannot read at the default 512 batch, then at 1120 — does the reply's accuracy actually move, or is
  the projector's own supported-budget ceiling the limit? Record the projector's reported supported
  budgets (`MtmdContext`) alongside.
- Probe: the **same** image bytes through the screen path (1120) vs a pasted/attachment path
  (default) — does the engine's `companion multimodal prompt evaluated` log line show a differing
  `prompt_tokens`? If the two are identical, the screen/non-screen budget distinction is not plumbed.
- Probe: an image-first turn in a **multi-turn** conversation (image on turn 2, text-only turn 3) —
  does the last-user-message rule still place the image only on turn 2, and does turn 3 render text
  only?
- Probe: an image turn whose user text is empty (screen capture with no question) — does the rendered
  prompt become `<marker>` alone, and does the plan still tokenise?
- Probe: two consecutive vision turns in one session — does the engine survive (cross-ref
  `companion-embedded-engine` F-23; round 1 of #3141 found the vision path panicked on its FIRST turn)?
- Probe: a non-PNG image payload (a JPEG data URL) through the image path — typed refusal or a
  mislabelled-decode error? (The shipped contract is PNG; confirm it still refuses.)
- Probe: run `fredo companion score` twice back-to-back against the same store — are both runs'
  `companion.score` span sets present and distinguishable (`start_time_ns`/`span_id`), or does the
  second overwrite the first?
- Probe: `fredo companion score` with no `--pg-port`/`--manifest` — does the report name that
  persistence was skipped (never a silent no-persist), and is the exit code still a real score?
- Probe: the AC-4 discriminating fixture — does a screen-region fixture whose text is unreadable at
  512 actually FAIL at the default budget and PASS at 1120? If it passes at both, it cannot
  discriminate AC-4 (promote the finding).
- Probe: an over-context media turn — is there any lever to reach 131,072 tokens in-round (a huge
  image, a tiny `ctx_size` override)? If none exists, record the AC-5c live drive as a named blocker
  (the committed pin is the ground).
