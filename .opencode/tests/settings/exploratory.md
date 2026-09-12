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
