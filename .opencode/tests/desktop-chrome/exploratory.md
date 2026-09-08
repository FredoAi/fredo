# desktop-chrome — Exploratory

Unscripted probes beyond the functional cases. A confirmed finding here PROMOTES to `functional.md` as a new `F-` row (keep the origin note).

- [x] E-1: Drag a feature window slowly across the desktop so its titlebar crosses under the clock/notch region — does the FREDO band or clock flash over the titlebar at any intermediate position? (G-106 method b pixel-sample at several stops.) **PASS:** un-maximize produced a floating window (chrome z=0, controls at x≈427-519 unoccluded); the FREDO notch (x≈872-1048,y=0-58) never painted over the floating titlebar (screenshot 02 float). Chrome stays sunk (z=0) whenever a non-minimized window is shown.
- [x] E-2: Rapidly open/close/maximize/restore several feature windows — does a desktop-chrome layer ever repaint over a newly-focused window's controls? Any console error on focus/re-z? **PASS:** opened Mission Monitor + Query Viewer (2 windows), probed Query Viewer controls with overlay hit-testable — elementFromPoint returned the window control (isControl:true). Maximized/float/restore transitions did not re-surface desktop chrome over controls. No re-z console error.
- [x] E-3: Maximize a window then un-maximize — after the toggle, is the titlebar still above the desktop chrome (no transient z-order inversion)? **PASS:** Maximize→Restore (float)→Maximize cycles kept chrome z=0 throughout; after every toggle the titlebar controls remained the top hit target (elementFromPoint returns the control).
- [x] E-4: With NO feature window open (desktop only), confirm the desktop chrome still renders correctly and the bottom LED pair works — the fix must not break the desktop-only state. **PASS:** after closing all windows, desktop chrome restored to full z (chrome 1200, stream 1210); FREDO band, clock, ONLINE, LED pair all rendered (screenshot 10).
- [ ] E-5: Pointer near the titlebar corners (resize-grip corners) — are the resize grips still reachable, or does any desktop-chrome layer swallow the pointer there?
- [x] E-6: Toggle light → dark theme with a window open under the clock — does the stacking hold in both themes with no flicker/inversion on theme switch? **PASS:** switched to Light Default (bodyBg #ffffff, textPrimary #0c1117) and Dark — in both, window open → chrome z=0, stream z=0, frame z=1 (identical stacking). No inversion/flicker. Light evidence screenshot 08.
- [x] E-7: Inject a burst of `fredo emit` row mutations so LED-2 pulses — does the pulsing dot ever overlap the bottom edge of a window or the window chrome? **PASS:** with a window open the LED pair is at z=0 (below the z=1 window stack), so it can never overlap the window chrome; `fredo emit` advanced the row-mutation epoch → LED-2 "Streaming" (active pulse). No overlap.

---

## #2830 extension — single top-right status LED probes

> Add findings here for issue #2830; a confirmed finding PROMOTES to `functional.md` as a
> new `F-` row (keep the origin note).

## E-8 — Rapid hover on/off the LED trigger

- [ ] E-8: Rapidly hover on/off the LED trigger (many quick transitions) — does the Chakra tooltip flicker/get stuck (no `closeDelay` leak), or does it settle to the correct open/closed state? Any console error is a finding.

## E-9 — LED unreachable when a window covers the desktop

- [ ] E-9: With a feature window OPEN (band sunk to z=0), attempt to hover where the LED normally sits — confirm the LED is unreachable/hidden below the window stack and the tooltip does NOT appear over the feature window (the `led-overlay.png` class bug must not recur). Record the element at that point (`elementFromPoint`).

## E-10 — Re-theme while the tooltip is open

- [ ] E-10: Open the tooltip (hover/focus the LED), then switch a theme preset (via the shipped `ThemePresetSelector`) with it open — does the tooltip + LED re-tint token-native (no stale/dead color, no hardcoded literal), or does it flash/die on a stale token? Any finding.

## E-11 — Keyboard focus announce / double-announce

- [ ] E-11: Tab to the LED trigger → tooltip opens on focus; Tab away → closes. Observe the DOM/accessibility: does the trigger announce its state (role="status"/aria-label) and does the `aria-describedby` tooltip cause a double-announce (UI/UX flagged the SR risk)? Record the ARIA attributes present (`role`, `aria-live`, `aria-atomic`, `aria-label`, `aria-describedby`) and whether any duplicate/conflicting announcement is detectable.

## E-12 — Narrow-viewport tooltip/LED clipping

- [ ] E-12: Resize the window narrow/small while the LED is visible; hover the LED — does the tooltip clip at the viewport right/top edge or reposition below without clipping? Does the LED itself clip/scale? Any finding.

## E-13 — Live state flip while hovering

- [ ] E-13: With the tooltip open (hovering the LED), drive a connection-state flip (toggle `isConnected` via the stream/backend) — does the tooltip content swap live (Online ↔ Offline) and the LED recolor token-native, without a stale tooltip text or a console error?

---

## #2841 extension — desktop chrome polish probes

> Add findings here for issue #2841; a confirmed finding PROMOTES to `functional.md` as a new `F-` row (keep the origin note).

## E-14 — Clean → covered → clean transition of the rail

- [ ] E-14: On a clean desktop, note the rail is resting-visible. Open a feature window (maximized) → the rail should revert to the #2838 peek-only model (off-canvas at rest, no resting-visible). Close/minimize the window → the rail should flip back to resting-visible cleanly. Does the transition ever leave the rail in a stale/wrong state (e.g. stays hidden on a clean desktop, or stays visible over a full-bleed window)? Any re-render loop or console error on the flip?

## E-15 — Pointer near the left edge while the rail is resting-visible

- [ ] E-15: With the rail resting-visible on a clean desktop, does moving the pointer toward the left edge cause any reveal/hide churn (a flicker or re-hide) given the resting-visible model coexists with (or displaces) the edge-peek machine? Or does the rail stay put until a window covers the desktop? Record any visual jitter.

## E-16 — Settings button vs the engaged launcher CLOSE hint group

- [ ] E-16: With the launcher grid engaged (keyboard hint `ESC CLOSE` group at bottom-right), does the always-visible settings button at bottom-right collide with or overlap the engaged hint group? UI/UX reserved ~56px at bottom-right for the engaged state — verify the settings button clears it (or repositions) without occluding either.

## E-17 — Theme switch with the settings modal open

- [ ] E-17: Open the settings modal (from the always-visible button on a clean desktop), then switch a theme preset while it is open — does the button + modal re-tint token-native, and does the button stay visible after the modal closes? Any stale/dead color on the button's newly-converted box-shadow?

## E-18 — Narrow viewport — rail + cluster + settings button together

- [ ] E-18: Resize the window narrow/small on a clean desktop — do the resting-visible rail (left), the centered clock/LED cluster (top-right), and the settings button (bottom-right) all remain visible and non-overlapping? Does any surface clip/scale off-screen at the smallest supported viewport?
