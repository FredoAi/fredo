# Companion Vision — Exploratory

> Unscripted edge/failure probes for the companion vision path (issue **#3234**, re-scoped
> 2026-11-26). Confirm a finding, then promote it to `functional.md` as a new `F-` row (keep the
> origin note). A confirmed defect is a `## Tests Run` FAIL; a non-drivable probe is a named blocker,
> never a PASS.
>
> **Read first — the round-1 premise was FALSIFIED by ST-4's five live legs.** The vendor-guidance
> premise (image-before-text, higher budget) does **not** hold for this pinned projector on the
> dense case: **text→image PASSES, image→text FAILS**, and reverting ONLY the media order restores
> the PASS. ST-2's 1120 budget and ST-3's `n_ubatch` do **not** move it (772 prompt tokens < 1120 —
> no cap engages). **This is NOT a tuning problem; do not re-open it as one.** The probes below are
> re-cut accordingly.

- Probe: the **dense** screen-region fixture (1344×960, target name only in a small title bar)
  through the shipped **text-first** config vs the round-1 **image-first** config — does the pass set
  really flip on the ORDER alone (the sole moved variable), and does the `vision-dense-text` record
  reproduce (`seed 606`)? Record both runs' `promptTokens` (772 both ways).
- Probe: the **same** image bytes through the screen path vs a pasted/attachment path — both now
  declare the same-ceiling bounded budget (`NON_SCREEN_VISUAL_TOKEN_BUDGET == SCREEN_VISUAL_TOKEN_BUDGET`),
  so **identical `promptTokens` are EXPECTED** (one projector, one ceiling); a DIFFERING budget would
  mean a second projector or a divergent declaration. Confirm the declared budget is the constant,
  not a literal.
- Probe: run `fredo companion score` twice back-to-back against the same store — are both runs'
  `companion.score` span sets present and distinguishable (`start_time_ns`/`span_id`), or does the
  second overwrite the first?
- Probe: `fredo companion score` with no `--pg-port`/`--manifest` — does the report name that
  persistence was skipped (never a silent no-persist), and is the exit code still a real score?
- Probe: an image-first re-application (a scratch tree) — does `vision-dense-text` flip to
  `passed:false` with `detail:"expected a open_app call; observed calls: []"` and does the harness
  exit non-zero with `regressions:["vision-dense-text"]`? (This is the regression guard's reddening
  control — promote the finding if it does NOT redden.)
- Probe: the derived-budget pin — move `SCREEN_VISUAL_TOKEN_BUDGET` in a scratch copy. Does the pin
  stay GREEN and the projector load at the moved value (it DERIVES), or does it redden (it restates
  the literal)? A literal-restating pin is a finding (AC-4b).
- Probe: an image turn in a **multi-turn** conversation (image on turn 2, text-only turn 3) — does
  the last-user-message rule still place the image only on turn 2, and does turn 3 render text only?
- Probe: an image turn whose user text is empty (screen capture with no question) — does the rendered
  prompt become `<marker>` alone, and does the plan still tokenise?
- Probe: two consecutive vision turns in one session — does the engine survive (cross-ref
  `companion-embedded-engine` F-23; round 1 of #3141 found the vision path panicked on its FIRST turn)?
- Probe: a non-PNG image payload (a JPEG data URL) through the image path — typed refusal or a
  mislabelled-decode error? (The shipped contract is PNG; confirm it still refuses.)
- Probe: an over-context media turn — is there any lever to reach 131,072 tokens in-round (a huge
  image, a tiny `ctx_size` override)? If none exists, record the AC-5c live drive as a named blocker
  (the committed pin is the ground).
- Probe: the projector's own reported supported budgets — read `MtmdContext`'s answer beside the
  pinned constant; if `1120` is unsupported the highest supported value must be chosen AND recorded.
