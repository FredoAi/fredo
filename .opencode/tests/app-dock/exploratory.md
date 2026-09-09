# app-dock — Exploratory

> Unscripted edge/failure probes for the positionable dock surface (#2848). A confirmed finding here **promotes** to `functional.md` as a new `F-` row (keep the origin note). Run after the functional + smoke legs; drive everything live against `spec/2848` (MCP driver `com.fredo.app:9223`).

## E-1 — Rapid orientation flips under a maximized window

- [ ] E-1: With a maximized window up (dock hidden, edge-peek active), rapidly flip Dock position Sidebar ↔ Bottom bar ↔ Sidebar several times from Settings → Appearance. Does the reveal model follow the CURRENT edge without a stale-edge dock, a moment where BOTH edges summon, a duplicate dock element, or a `Maximum update depth exceeded`? Does the maximized window stay full-bleed throughout?

## E-2 — Pointer resting in the keep-zone across the hide-delay grace

- [ ] E-2: Reveal the dock over a maximized window; park the pointer just OUTSIDE the dock but INSIDE the keep-zone (~76px) and hold it there past the ~350ms hide-delay grace; then move it a few px further out. Does the dock stay open while the pointer is in the keep-zone and hide only after it exits + the grace elapses? Any flicker at the boundary (dock repeatedly sliding in/out)?

## E-3 — Bottom bar with ≥6 windows — horizontal scroll

- [ ] E-3: Bottom bar orientation with 6+ open-app entries (via the pre-sanctioned component-test contingency if live catalog can't reach it): do the entries fit the `DOCK_BOTTOM_MAX_WIDTH_PX` clamp with `overflowX:auto` — no entry lost, no pill wider than the viewport, scroll reveals the last entries, active well + ✕ still reachable on scrolled entries? Does the pill stay clear of the engaged launcher hints row and the bottom-right settings button on a clean desktop?

## E-4 — OS-taskbar overlap on the bottom reveal band

- [ ] E-4: Windows taskbar at the bottom (auto-hide OFF) overlapping the bottom ~40px of the viewport: with a maximized window up, can the bottom-edge reveal zone still be summoned (does the reveal-zone predicate account for the taskbar overlap — `clientY ≥ viewport.height − 6` vs the true window bounds)? Does the Bottom bar rest state sit clear of the taskbar, and is the bottom-center pill fully visible/clickable on a clean desktop?

## E-5 — Narrow-viewport Bottom bar fit

- [ ] E-5: Shrink the window to a narrow viewport (e.g. 900×600) with the dock on Bottom bar (clean desktop + covered by a maximized window). Does the pill fit without clipping/off-screen? Is the tooltip still unclipped (opens above), do the entries still reach their ✕, and does the horizontal scroll behave? Then flip to Sidebar at the same narrow viewport — left rail not clipped, no layout break.

## E-6 — Light + dark re-tint of both orientations

- [ ] E-6: Re-theme (light preset ↔ dark base) while each orientation is resting-visible AND while the dock is revealed over a maximized window. Do the rail pill / bottom pill, active-well tint, close ✕ destructive tint, and tooltip re-tint token-native with no stale/dead color, no hardcoded hex, no `var(--x)NN` alpha-append in either state? Readable in both presets?

## E-7 — Persistence edge: corrupt/foreign value + 0-window choice

- [ ] E-7: Seed a corrupt/unknown `Fredo_dock_position` value (bogus enum) → app must degrade to **Sidebar** cleanly with no crash and no console error, and the settings control must reflect the fallback. Also: choose Bottom bar with 0 windows open (dock absent), restart, reopen ≥1 window → dock appears at the bottom edge (the setting persisted even though no dock was mounted when chosen)?

## E-8 — Reveal/hide under fast pointer sweeps + focus interplay

- [ ] E-8: Sweep the pointer rapidly across the reveal edge (in-out-in-out) over a maximized window; then reveal and immediately Tab into the dock, leaving the pointer outside. Does keyboard focus inside the dock suspend auto-hide (no dock disappears mid-keystroke)? Does a subsequent ESC hide + restore focus correctly? Any stuck-visible or stuck-hidden state, or console error?
