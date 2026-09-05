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
