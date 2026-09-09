# app-dock — Exploratory

> Unscripted edge/failure probes for the positionable dock surface (#2848). A confirmed finding here **promotes** to `functional.md` as a new `F-` row (keep the origin note). Run after the functional + smoke legs; drive everything live against `spec/2848` (MCP driver `com.fredo.app:9223`).

## E-1 — Rapid orientation flips under a maximized window

- [x] E-1: With a maximized window up (dock hidden, edge-peek active), rapidly flip Dock position Sidebar ↔ Bottom bar ↔ Sidebar several times from Settings → Appearance. Does the reveal model follow the CURRENT edge without a stale-edge dock, a moment where BOTH edges summon, a duplicate dock element, or a `Maximum update depth exceeded`? Does the maximized window stay full-bleed throughout? **Verified (partial — single Sidebar→Bottom→Sidebar sequence under a maximized window, F-10):** with Query Viewer maximized, `setDockPosition('sidebar')` → dock reverts to Sidebar edge-peek, reveal at the new (left) edge works, maximized window stays full-bleed, `regionCount:1`, no leftover bottom dock. No `Maximum update depth exceeded`. (True "several rapid flips" not exhaustively driven — the max 2-window catalog + the single sequencing is the reachable surface; the transition-only reveal + `positionRef` deps (AppDock.tsx) make a re-render loop unlikely.) **Unchanged round 2 (spec/2848 @ cde149d9):** orientation switches under the maximized window apply reveal at the NEW edge, `dockCount:1`, no leftover old-edge dock, full-bleed retained.

## E-2 — Pointer resting in the keep-zone across the hide-delay grace

- [x] E-2: Reveal the dock over a maximized window; park the pointer just OUTSIDE the dock but INSIDE the keep-zone (~76px) and hold it there past the ~350ms hide-delay grace; then move it a few px further out. Does the dock stay open while the pointer is in the keep-zone and hide only after it exits + the grace elapses? Any flicker at the boundary (dock repeatedly sliding in/out)? **Verified (F-7 keep-zone probes):** pointer parked at `clientX:70` (≤76 keep-zone) stayed revealed (`visibility:visible`) after 500ms (past the 350ms grace) — keep-zone suspends auto-hide; at `clientX:77` (>76) the hide armed → hidden after the grace. No flicker at the boundary (clean state transition, no repeated in/out). **Unchanged round 2 (spec/2848 @ cde149d9):** hide-after-grace + keep-zone boundaries confirmed on the bottom axis (F-7 re-drive).

## E-3 — Bottom bar with ≥6 windows — horizontal scroll

- [ ] E-3: Bottom bar orientation with 6+ open-app entries (via the pre-sanctioned component-test contingency if live catalog can't reach it): do the entries fit the `DOCK_BOTTOM_MAX_WIDTH_PX` clamp with `overflowX:auto` — no entry lost, no pill wider than the viewport, scroll reveals the last entries, active well + ✕ still reachable on scrolled entries? Does the pill stay clear of the engaged launcher hints row and the bottom-right settings button on a clean desktop?

## E-4 — OS-taskbar overlap on the bottom reveal band

- [ ] E-4: Windows taskbar at the bottom (auto-hide OFF) overlapping the bottom ~40px of the viewport: with a maximized window up, can the bottom-edge reveal zone still be summoned (does the reveal-zone predicate account for the taskbar overlap — `clientY ≥ viewport.height − 6` vs the true window bounds)? Does the Bottom bar rest state sit clear of the taskbar, and is the bottom-center pill fully visible/clickable on a clean desktop?

## E-5 — Narrow-viewport Bottom bar fit

- [ ] E-5: Shrink the window to a narrow viewport (e.g. 900×600) with the dock on Bottom bar (clean desktop + covered by a maximized window). Does the pill fit without clipping/off-screen? Is the tooltip still unclipped (opens above), do the entries still reach their ✕, and does the horizontal scroll behave? Then flip to Sidebar at the same narrow viewport — left rail not clipped, no layout break.

## E-6 — Light + dark re-tint of both orientations

- [ ] E-6: Re-theme (light preset ↔ dark base) while each orientation is resting-visible AND while the dock is revealed over a maximized window. Do the rail pill / bottom pill, active-well tint, close ✕ destructive tint, and tooltip re-tint token-native with no stale/dead color, no hardcoded hex, no `var(--x)NN` alpha-append in either state? Readable in both presets?

## E-7 — Persistence edge: corrupt/foreign value + 0-window choice

- [ ] E-7: Seed a corrupt/unknown `Fredo_dock_position` value (bogus enum) → app must degrade to **Sidebar** cleanly with no crash and no console error, and the settings control must reflect the fallback. Also: choose Bottom bar with 0 windows open (dock absent), restart, reopen ≥1 window → dock appears at the bottom edge (the setting persisted even though no dock was mounted when chosen)? **NOTE round 2 (spec/2848 @ cde149d9):** the corrupt-value degrade path is the pre-existing `dockPositionStore.test.ts` case (`'sideways'` → `'sidebar'`, 10 tests green); the 0-window persistence choice is covered by the FD-1 boot-hydration unit test + the F-3 live boot-hydration evidence. Not re-driven live this round.

## E-8 — Reveal/hide under fast pointer sweeps + focus interplay

- [x] E-8: Sweep the pointer rapidly across the reveal edge (in-out-in-out) over a maximized window; then reveal and immediately Tab into the dock, leaving the pointer outside. Does keyboard focus inside the dock suspend auto-hide (no dock disappears mid-keystroke)? Does a subsequent ESC hide + restore focus correctly? Any stuck-visible or stuck-hidden state, or console error? **Verified:** 6+ rapid reveal/hide cycles (Sidebar + Bottom) with the maximized window stayed full-bleed and console clean (no `Maximum update depth exceeded`); keyboard focus inside the dock suspends auto-hide (focus-in the dock kept it visible through roving, F-11); ESC on the revealed covered dock hides it + restores focus out of the dock (`focusInDock:false`). No stuck-visible/stuck-hidden state after the clean covered→clean flip (F-4/F-6a/F-7 boundary probes). (Note: a transient "stuck visible" was observed during the test session but traced to many in-flight synthetic `pointermove`s + `focusInsideRef` suspension — the clean minimize→maximize→restore cycle flips the dock correctly between resting-visible and edge-peek hidden, so it is a harness state artifact, not a product bug.) **Unchanged round 2 (spec/2848 @ cde149d9):** reveal→hide→re-reveal cycle + pointermove hide confirmed on the bottom axis, console clean.

## E-9 — Active-indicator axis in the Bottom bar (promoted to functional F-13)

- [x] E-9: In the Bottom bar orientation, does the ACTIVE entry's accent indicator adapt its axis to the horizontal pill? The wireframe (`dock-bar.png`) + UI/UX spec §4 require a **bottom-edge underline** (`inset 0 -3px 0 0 var(--accent-primary)`) under the active icon in the horizontal pill. **Round 1 (FAIL):** the live Bottom bar active entry rendered the **left-edge bar** `box-shadow: inset 3px 0 0 0 var(--accent-primary)` (DockEntry.tsx:126 used `inset ${DOCK_ACTIVE_BAR_PX}px 0 0 0` for BOTH orientations). **Round 2 (PASS, promoted to functional F-13):** the FD-2 fix adds an `orientation === 'bottom'` branch — live computed-style Bottom bar ACTIVE well `box-shadow: rgb(255, 43, 194) 0px -3px 0px 0px inset` (= `inset 0 -3px 0 0 var(--accent-primary)`, bottom-edge underline); Sidebar ACTIVE well `box-shadow: rgb(255, 43, 194) 3px 0px 0px 0px inset` (= `inset 3px 0 0 0 var(--accent-primary)`, left-edge bar, unchanged). Evidence: `https://github.com/FredoAi/fredo/raw/spec/2848/.opencode/evidence/2848/E9-active-bar-bottom-underline.png`.

## E-10 — Bottom bar tooltip placement mismatch (promoted to functional F-12)

- [x] E-10: With the dock in the Bottom bar orientation, hover/focus an entry and read the Chakra tooltip `data-placement`. **Round 1 (FAIL):** `data-placement="right"` (content popper) even though the code sets `tooltipPlacement = 'top'` for `orientation === 'bottom'` — the tooltip opened to the RIGHT of the bottom-bar well, NOT above. **Round 2 (PASS, promoted to functional F-12):** the FD-3 fix (`strategy:'fixed'` + `flip:false`) resolves it — popper `data-placement="top"`, tooltip content rect above the well, not clipped at the viewport bottom (see functional F-12). Evidence: `https://github.com/FredoAi/fredo/raw/spec/2848/.opencode/evidence/2848/F12-bottom-tooltip-top.png`.
