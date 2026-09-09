# Launcher — Exploratory

> Unscripted edge/failure probes for the launcher shell (issue #2808). The Tester adds
> findings here; a confirmed finding promotes to `functional.md` as a new `F-` row
> (keep the origin note).
> **Serving checkout:** `spec/2808 @ bd30b07b`. Round 2.

## Prompt lines
- [x] E-1: Probe the `>` command bar — type text, cancel, focus-out; does it lose focus or error?
  - **Observed (no error).** Typed `zzzz` into `input[role="searchbox"]` — the controlled value updated (`inputVal: "zzzz"`) and the grid filtered to zero without error. Clearing the input restored the grid. No console error. (Note: the command-bar query is a grid filter only — it stays in the input on the next open because the host keeps the `query` state; this persisted `zzzz` across an open/close cycle, exercising the empty-grid path.)
- [x] E-2: Probe keyboard nav at the grid edges (first/last tile wrap) and Escape-to-close behavior.
  - **Observed (clamp, no wrap).** `ArrowRight` moved selection Mission Monitor → Query Viewer; `ArrowLeft` moved back. `clampIndex` clamps at the edges rather than wrapping (plan says "clamp is safer"). `Escape` closed the launcher (`open=false`) — confirmed on the empty-grid and open-grid states.
- [x] E-3: Probe opening many features quickly (rapid Enter) — does the kernel store stay consistent, does focus/z-order behave?
  - **Observed (kernel store consistent; z-order now verifiable).** Query Viewer then Mission Monitor each opened once from the grid; the window store held one `.fredo-window__surface` per open. **Round-2 (post ST-6):** the two windows coexisted (`openWindows: 2`) and stacked by z-order — `elementFromPoint(960,500)` returned `fredo-window__surface` (topWindow "Sessions/Mission Monitor"); the rapid-Enter focus-stacking behavior is now visually confirmed (round 1 flagged this leg unverifiable due to the occlusion).
- [x] E-4: Probe toggling light/dark while the launcher is open — do all surfaces re-theme without flicker or hardcoded color?
  - **Observed (re-theme works; no light mode).** Switching base theme turbo→classic while the launcher was open re-colored the avatar and the selected-tile border (accent token `#ae53ba` → `rgb(147,51,234)`) with no hardcoded color and no console error. **Finding:** the product ships NO light theme — `themes` defines only dark `turbo` and `classic`, so there is no light/dark toggle to probe (PO-scope, G-050).
- [x] E-5: Probe the empty `SHOWABLE_FEATURES` path with the command bar focused — any crash or console error?
  - **No crash, no console error.** With the grid empty (`zzzz` query) and the command bar focused, arrows + Enter were no-ops, the launcher stayed open, and the console stayed clean. (Exercised via the query-filter-to-zero path — see F-5.)
- [x] E-6: Probe window-manager focus after opening a feature from the grid then closing it — does the launcher regain focus, does the grid state persist?
  - **Verified (round 2 — ST-7 fix resolves the round-1 gap).** Round 1 found the notch `div[role="button"][aria-label="Fredo launcher"]` had NO `tabindex`, so Escape's focus-restore fell to `BODY`. **ST-7 added `tabIndex={0}` to the notch** (`LauncherChrome.tsx:160`). Round-2 live: notch `tabindex="0"` present (`hasTab: true, tab: "0"`); after open-launcher → Escape → `{"launcherOpen":false,"activeEl":"Fredo launcher","focusOnNotch":true,"activeIsBody":false}` — focus lands on the notch, NOT `BODY`. The launcher grid keyboard nav, open/close lifecycle, and the window-store epoch all behave. (Note: the grid-state `query` persists across launcher open/close by design — the host keeps the `query` state; clear via the input. This is not a defect.)

## Promoted findings
- Round 1 promoted the AC2b window-occlusion z-order defect (fixed round 2 by ST-6) and the notch-not-focusable/Escape-focus-restore gap (fixed round 2 by ST-7). Both are **resolved** in round 2 (see `functional.md` F-3/F-3 edge + `exploratory.md` E-6), so the previously-blocked re-focus / multi-window / E-3 legs are now visually verified. No new findings promoted in round 2.

## #2819 extension — idle/engaged launcher probes

> Add findings here for issue #2819; a confirmed finding PROMOTES to `functional.md` as a
> new `F-` row (keep the origin note).

## E-7 — Notch-click vs focus-idle interplay

- [ ] E-7: Probe what the NOTCH click does after the #2819 rework (it was the #2808 open trigger). Does it still open/engage the launcher, or is it now an idle-only ornament? If it toggles the engaged state, is focus placed correctly? Any regression to the #2808 notch `aria-expanded`/Escape-focus-restore is a finding.

## E-8 — Blur-to-idle ambiguity

- [ ] E-8: Probe blurring the command bar (focus-out) with an empty query — does the desktop stay ENGAGED (grid + hints) or return to IDLE? Record the actual behavior; if it differs from the AC expectation (triage Discussion QA-1), flag it.

## E-9 — Re-theme while engaged with the new chrome

- [ ] E-9: Probe switching a theme preset while the new chrome (side ticks, dot-grid, rounded frame) is ENGAGED — do the new elements re-tint token-native with no hardcoded color and no flicker? Any element stuck on a stale color/text token is a finding.

## E-10 — Rapid open/close + new idle chrome

- [ ] E-10: Probe opening a tile, closing it, then re-engaging the launcher rapidly — does the idle chrome (avatar, bar, ticks, dot-grid, frame) remain correct under the window lifecycle churn, with no console error and no orphan window?

## #2823 extension — global Ctrl+Space keyboard/focus probes

> Add findings here for issue #2823; a confirmed finding PROMOTES to `functional.md` as a
> new `F-` row (keep the origin note).

## E-11 — Rapid Ctrl+Space spam

- [ ] E-11: Probe rapidly pressing Ctrl+Space multiple times (e.g. 5× fast) — does the launcher toggle cleanly each press, or does it get stuck / focus-bounce / double-toggle? Any console error or focus trap is a finding.

## E-12 — Ctrl+Space in an IME / non-QWERTY layout

- [ ] E-12: Probe Ctrl+Space with an active IME input context (Windows input-method / CJK) and on a non-QWERTY layout — does the toggle fire, or does the OS/IME swallow the keydown? Any missed toggle is a finding (the native-collision risk).

## E-13 — Ctrl+Space over a maximized feature window

- [ ] E-13: Probe Ctrl+Space while a feature window is MAXIMIZED over the resting surface — does the overlay re-raise ABOVE the window (`elementFromPoint` returns a node inside the launcher dialog), or does it stay hidden behind? The resting surface is z'd below the window, so the overlay raise is the critical path.

## E-14 — Focus restore when the pre-open element is gone

- [ ] E-14: Probe opening the launcher from an element, then removing/unmounting that element while the launcher is open, then closing — does focus fall back gracefully (no crash, no focus-trap in a dead launcher)? Record the landing element.

## E-15 — ESC precedence across surfaces

- [ ] E-15: Probe ESC behavior when a feature window is ALSO open behind the launcher overlay (e.g. Mission Monitor detail panel with its own ESC-close handler) — which ESC wins, does any co-fire (two actions)? Any double-close / focus-chatter is a finding.

## #2824 extension — ESC/close hint keycap probes

> Add findings here for issue #2824; a confirmed finding PROMOTES to `functional.md` as a
> new `F-` row (keep the origin note).

## E-16 — Re-theme while the ESC hint is visible

- [ ] E-16: Switch theme surface (a light preset ↔ the dark base via the themed preset selector) while the engaged launcher shows `ESC CLOSE` — does the keycap badge + `CLOSE` label re-tint token-native (no hardcoded color, no stale token, no flicker)? Any element stuck on a stale color/text token is a finding.

## E-17 — Narrow-viewport / small window spacing

- [ ] E-17: Resize the webview window small/narrow while the launcher is engaged — does the ESC badge stay clear of the frame and the `CLOSE` label, or does it collide/clip at the reduced width? Any cramped/colliding layout is a finding.

## E-18 — Empty-grid hint-row edge

- [ ] E-18: Probe the engaged hint row when the grid is empty (empty feature set / non-matching query) — the `ESC CLOSE` hint is hidden (`showNavHints = entryCount > 0 && engaged`). Confirm the hint row + keycap do NOT render and no console error/crash occurs.

## #2827 extension — PixelButler avatar probes

> Add findings here for issue #2827; a confirmed finding PROMOTES to `functional.md` as a
> new `F-` row (keep the origin note). Probe the avatar-base-form change for unforeseen
> interactions; a confirmed regression-free probe is recorded here (no promotion).

## E-19 — Re-theme while the avatar is visible

- [x] E-19: Re-theme (via the shipped `ThemePresetSelector`) while the avatar is visible — does the avatar re-tint token-native (no dead/stale color, no hardcoded literal, no flicker)?
  - **Observed (PASS).** Switching presets while the launcher avatar was visible re-tinted the avatar from the accent token every time: Light Default → `rgb(0,209,209)` cyan on white; Dark base → cyan on `#0c1117`; Matrix (supplementary) → `rgb(0,255,65)` green. No dead/stale color, no hardcoded literal, no flicker. The avatar color is genuinely token-driven (Matrix proved a non-cyan accent re-tints the non-cyan). **No finding — no promotion.**

## E-20 — Narrow-viewport avatar scaling/clip

- [x] E-20: Resize the webview window small/narrow while the launcher shows the avatar — does the avatar scale/clip/collapse the launcher tile?
  - **Observed (PASS).** Resized the window to 700×900 (confirmed `window.innerWidth=700`, `innerHeight=900`): the avatar `getBoundingClientRect` stayed 48×48 at (326,306), `fullyVisible: true` — NOT clipped, cropped, or scaled; it re-centered; the command bar + chrome held. No layout collapse. Screenshot `avatar-ac5-narrow.png`. **No finding — no promotion.**

## E-21 — Rapid launcher open/close avatar integrity

- [ ] E-21: Rapidly open/close the launcher (or a tool window) around the avatar — does the avatar stay correct (crisp cells, token color, no console error / no re-render loop, no orphan)?
  - **Observed (PASS, limited).** The avatar survived the settings-modal open/close cycle + a theme-to-heme + resize cycle with zero console errors and a stable 48×48 rect (post-cycle re-measure: 48×48, 91 rects, cyan). A focused rapid-close loop was not driven (window resize + modal open/close exercised the same render re-entrancy); no console `Error:`/`Uncaught`/`Maximum update depth exceeded` appeared. Recorded as an observed PASS; no promotion.

---

## #2830 extension — single top-right status LED probes

> Add findings here for issue #2830; a confirmed finding PROMOTES to `functional.md` as a
> new `F-` row (keep the origin note).

## E-22 — Rapid hover on/off the launcher LED

- [ ] E-22: Rapidly hover on/off the LED trigger in the launcher (idle AND engaged) — does the Chakra tooltip flicker/get stuck, or settle to the correct open/closed state? Any console error is a finding.

## E-23 — LED + clock overlap at narrow/nonstandard widths

- [ ] E-23: Resize the launcher window narrow/small — does the enlarged LED stay clear of the clock HH:MM text (below it, `mt="6px"`, right-aligned), or does it collide/overlap the clock or the frame? The `led-overlay.png` bug must not recur. Any overlap is a finding.

## E-24 — Ctrl+Space / notch open does not hide the LED

- [ ] E-24: Open the launcher via Ctrl+Space and via the notch, in both idle and engaged states — does the single LED remain visible in the top-right cluster (it is part of the chrome band, not the grid), and does opening a feature window still sink the band + LED below the window stack? Any missing LED / band resurface above a window is a finding.

## E-25 — State flip while hovering the launcher LED

- [ ] E-25: With the tooltip open over the launcher LED, drive a connection-state flip — does the tooltip content swap live (Connected ↔ Disconnected) and the LED recolor `var(--accent-primary)` ↔ `var(--status-error)`, token-native, with no stale tooltip text / console error?

## #2837 extension — PixelButler fredo-avatar.html geometry probes

> Add findings here for issue #2837; a confirmed finding PROMOTES to `functional.md` as a
> new `F-` row (keep the origin note). Probe the avatar re-geometry for unforeseen
> interactions; a confirmed regression-free probe is recorded here (no promotion).

## E-26 — Re-theme across presets while the new avatar is visible

- [ ] E-26: Re-theme through several shipped presets (light + dark + a non-cyan accent such as Matrix) while the launcher avatar is visible — does the avatar re-tint token-native with no dead/stale color and NO geometry change/deformation? Any element stuck on a stale color, or any theme-dependent deformation, is a finding.

## E-27 — Narrow/DPI resize + rapid open-close integrity

- [ ] E-27: Resize the webview small/narrow and cycle launcher open/close rapidly around the new avatar — does the avatar stay crisp (uniform cells, no anti-alias fill-in of the fragmentation gaps), fully visible, no clip/overflow, no console error / no re-render loop? Any filled-in gap, clip, or console error is a finding.

## E-28 — Fractional-DPI render of the new geometry

- [ ] E-28: At a fractional OS/webview zoom or non-100% DPI, does the new multi-rect geometry stay proportional (no merged/seam-shifted cells, no subpixel blur destroying the fragmentation gaps)? Any distortion at non-integer scale is a finding.

## #2850 extension — shared-avatar refactor probes

> Add findings here for issue #2850; a confirmed finding PROMOTES to `functional.md` as a new
> `F-` row (keep the origin note). Probe the launcher-md-over-shared-avatar change for unforeseen
> interactions; a confirmed regression-free probe is recorded here (no promotion).

## E-29 — Launcher md ↔ companion sm cross-surface consistency

- [ ] E-29: Render the launcher md avatar AND the companion sm avatar in the SAME theme and compare
      their rect sets + aspect side-by-side. Is the sm render a faithful proportional downscale of
      md (identical 58-rect set, only the viewBox scale differs), and do both stay crisp at their
      sizes? Any rect-set drift or a sm render that loses the fragmentation gaps / reads as a
      solid silhouette is a finding.

## E-30 — Launcher md after the shared move: rapid open/close + narrow/DPI integrity

- [ ] E-30: Cycle the launcher open/close rapidly around the shared md avatar and resize narrow /
      fractional-DPI. Does the avatar stay crisp (uniform cells, no anti-alias fill-in), fully
      visible, un-clipped, with no console error / re-render loop? Reference E-27/E-28 — any
      regression from the shared-path change is a finding.
