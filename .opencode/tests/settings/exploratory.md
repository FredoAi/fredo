# Settings — Exploratory

> Unscripted edge/failure probes for the shared Settings dialog shell (`ProfileSettingsModal`).
> Seeded at Issue #2864. The Tester adds findings here; a confirmed finding PROMOTES to
> `functional.md` as a new `F-` row (keep the origin note).

## Prompt lines

- [ ] E-1: **Theme switch with the modal open + a section mid-edit.** Switch dark↔light and change
      the accent while a setting is focused/half-edited. Does the chrome re-tint with no stale
      color, and is the in-progress edit preserved? Any stale color, lost edit, or console error
      is a finding (promotes to F-6/F-9).
- [ ] E-2: **Sidebar overflow/nav-count extremes.** With the fewest and the most nav items
      (feature settings registered), is the scrollbar thumb visible and legible on both themes,
      and does the nav group label render? Any invisible thumb / clipped nav / layout collapse is
      a finding (promotes to F-6/F-9).
- [ ] E-3: **Rapid section churn.** Click through every nav section rapidly (Companion →
      Appearance → Fredo Setup → Telemetry → feature). Any flash of stale chrome, crash, orphan
      content, or `Maximum update depth exceeded` is a finding (promotes to R-3/R-6).
- [ ] E-4: **Narrow window / small viewport.** Shrink the window while the dialog is open (fixed
      960px width). Does the dialog clip or overflow, and does the sidebar/content stay usable in
      both themes? Any clipped control or unreadable chrome is a finding (promotes to F-9).
- [ ] E-5: **Dock position + theme interplay (Appearance).** Change the Dock position and switch
      theme/accent; does the Appearance content remain token-native and unshifted? Any regression
      is a finding (promotes to F-10; cross-ref app-dock).

### #2864 testing round 1 (spec/2864 @ f2c8923) — findings

- **E-1 FINDING — regression-free.** Theme/accent switch with Settings open re-tints the chrome with no stale color; an out-of-range draft (`9999`, `aria-invalid=true`, red border/help) preserved its text across a theme change and healed to `3600` on commit (live region `Auto-return set to 3600 s`).
- **E-2 FINDING — regression-free.** Sidebar nav + `FEATURES` group render; the `--scrollbar-thumb` derived thumb is visible in both themes (after set + `scrollbar-{dark,light}.png`).
- **E-3 FINDING — regression-free.** Rapid section churn (Companion → Appearance → Fredo Setup → Telemetry → Run CLI) rendered each section with no stale chrome, crash, or `Maximum update depth exceeded`. NOTE: the Telemetry section wedges the MCP bridge for `html2canvas` full-viewport screenshots (tooling; a `maxWidth 900` capture succeeds) — environment, not product.
- **E-4 NOT DRIVEN.** Narrow-window clipping sub-case not exercised (dialog geometry is fixed 960×620; no window resize driven).
- **E-5 FINDING — regression-free.** Dock position + theme/accent interplay leaves the Appearance content token-native and unshifted.

## #2865 extension — wizard-in-dialog probes

> Unscripted visual/a11y probes for the #2865 wizard audit inside the shared dialog. A confirmed
> finding PROMOTES to `functional.md` as a new `F-` row (keep the origin note).

- [ ] **E-6 — Wizard content width with long paths.** With the wizard open and a long resolved
      path/filename, does the content stay within the dialog content pane (no horizontal scroll /
      clipping / Retry pushed off-card) at 960×620 and narrower? Any overflow is a finding
      (promotes to F-16).

- [ ] **E-7 — Wizard-vs-sibling drift.** Flip between the Companion wizard and Fredo Setup several
      times; do heading scale, card padding/radii, control heights, and body text match (no
      visible jump/drift)? Any divergence is a finding (promotes to F-16; H4/H5).

- [ ] **E-8 — Semantic-token resolution inside the dialog.** Read `getComputedStyle` for
      `--chakra-colors-fg-muted`/`-fg-subtle`/`-fg-default`/`-bg-hover`/`-fg-onAccent`/
      `-accent-solid` vs `--text-secondary`/`--text-subtle`/`--hover-bg`/`--accent-contrast`. Any
      token still stock/empty is a finding (promotes to F-16; the R3 root cause).

- [ ] **E-9 — Theme/accent switch mid-wizard-work.** Switch dark↔light and change the accent while a
      step is running/downloading and while an error is shown; does the wizard re-tint with no
      stale color and stay legible? Any stale color is a finding (promotes to F-16/F-18).
