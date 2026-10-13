# Contrast Gate — Exploratory

> Unscripted probes the Tester runs beyond the functional cases. A confirmed finding **PROMOTES** to
> `functional.md` as a new `F-` row (keep the origin note). The gate is static/pure — probes target
> the MATRIX, the SCANNER, and the BASELINE mechanics, not a running app.

## Probes to try

- [ ] **E-1 — Key-scheme collisions.** Construct two rows that differ only in a field NOT encoded in
      `MatrixRowKey` (e.g. different `kind`/`floor` for the same `preset|surface|state|pair`). Does
      `evaluateContrast` conflate them, or does the suite reject the collision? A key scheme that
      silently aliases distinct pairs is a finding (promotes to F-1/F-3).
- [ ] **E-2 — Derived-token arithmetic drift.** Recompute `--accent-strong` (55/45) and
      `--text-subtle` (65/35) independently and compare with `buildContrastMatrix`'s resolved values.
      Any divergence from the `ThemeProvider` derivation is a finding (promotes to F-1).
- [ ] **E-3 — Baseline key-format drift.** Inject a baseline entry whose `key` uses a different
      delimiter/case than `buildContrastMatrix` emits. Does it become a spurious stale entry (and
      FAIL) rather than a silent pass? A baseline that never matches a live row is a finding
      (promotes to F-9).
- [ ] **E-4 — Scanner false-negative hunt.** Feed `scanRawColors` tricky literals: a 4/8-digit hex,
      uppercase hex, `rgb(1 2 3 / 0.5)` modern syntax, `#fff` inside a template literal, and a
      `var(--x)` alpha-append with a non-numeric suffix. Which are missed? A missed UI-chrome literal
      is a finding (promotes to F-4/F-5).
- [ ] **E-5 — Allowlist over-broad match.** Add an allowlist entry for a file and check whether a NEW
      literal in that same file is still caught (allowlist is by `file`, not by literal). A file-level
      entry that blanket-excuses new literals is a finding — record the exact match semantics
      (promotes to F-5).
- [ ] **E-6 — Cap/stale interaction.** Construct the "delete a still-violating baseline entry and add
      a new one to stay under `BASELINE_MAX`" move. Does the stale rule + new-violation rule jointly
      FAIL it? A move that stays green is a finding (promotes to F-8/F-9/F-10).
- [ ] **E-7 — Determinism under reorder.** Shuffle the matrix row order and any `Object` key order in
      the token records; assert `buildContrastMatrix`/`evaluateContrast` output is byte-equal. Order-
      dependent output is a finding (promotes to F-1/F-11).
- [ ] **E-8 — CI step-name coupling.** Rename the CI step to `contrast gate` (lowercase) or move it
      before `test:run`; does the wiring assertion still hold? A step the failed-check output cannot
      distinguish is a finding (promotes to F-6).
