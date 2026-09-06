# desktop-chrome — Exploratory

Unscripted probes beyond the functional cases. A confirmed finding here PROMOTES to `functional.md` as a new `F-` row (keep the origin note).

- [ ] E-1: Drag a feature window slowly across the desktop so its titlebar crosses under the clock/notch region — does the FREDO band or clock flash over the titlebar at any intermediate position? (G-106 method b pixel-sample at several stops.)
- [ ] E-2: Rapidly open/close/maximize/restore several feature windows — does a desktop-chrome layer ever repaint over a newly-focused window's controls? Any console error on focus/re-z?
- [ ] E-3: Maximize a window then un-maximize — after the toggle, is the titlebar still above the desktop chrome (no transient z-order inversion)?
- [ ] E-4: With NO feature window open (desktop only), confirm the desktop chrome still renders correctly and the bottom LED pair works — the fix must not break the desktop-only state.
- [ ] E-5: Pointer near the titlebar corners (resize-grip corners) — are the resize grips still reachable, or does any desktop-chrome layer swallow the pointer there?
- [ ] E-6: Toggle light → dark theme with a window open under the clock — does the stacking hold in both themes with no flicker/inversion on theme switch?
- [ ] E-7: Inject a burst of `fredo emit` row mutations so LED-2 pulses — does the pulsing dot ever overlap the bottom edge of a window or the window chrome?
