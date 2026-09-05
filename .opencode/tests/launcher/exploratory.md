# Launcher — Exploratory

> Unscripted edge/failure probes for the launcher shell (issue #2808). The Tester adds
> findings here; a confirmed finding promotes to `functional.md` as a new `F-` row
> (keep the origin note).
> **Serving checkout:** `spec/2808 @ 28ef8b1c`. Round 1.

## Prompt lines
- [x] E-1: Probe the `>` command bar — type text, cancel, focus-out; does it lose focus or error?
  - **Observed (no error).** Typed `zzzz` into `input[role="searchbox"]` — the controlled value updated (`inputVal: "zzzz"`) and the grid filtered to zero without error. Clearing the input restored the grid. No console error. (Note: the command-bar query is a grid filter only — it stays in the input on the next open because the host keeps the `query` state; this persisted `zzzz` across an open/close cycle, exercising the empty-grid path.)
- [x] E-2: Probe keyboard nav at the grid edges (first/last tile wrap) and Escape-to-close behavior.
  - **Observed (clamp, no wrap).** `ArrowRight` moved selection Mission Monitor → Query Viewer; `ArrowLeft` moved back. `clampIndex` clamps at the edges rather than wrapping (plan says "clamp is safer"). `Escape` closed the launcher (`open=false`) — confirmed on the empty-grid and open-grid states.
- [x] E-3: Probe opening many features quickly (rapid Enter) — does the kernel store stay consistent, does focus/z-order behave?
  - **Observed (kernel store consistent, but z-order occluded).** Query Viewer then Mission Monitor each opened once from the grid; the window store held a single `fredo-window__surface` per open. Focus/z-order NOT visually verifiable because the window is occluded by the desktop (same AC2b z-order defect). Flagged — the "rapid Enter" focus-stacking behavior cannot be visually inspected until the occlusion is fixed.
- [x] E-4: Probe toggling light/dark while the launcher is open — do all surfaces re-theme without flicker or hardcoded color?
  - **Observed (re-theme works; no light mode).** Switching base theme turbo→classic while the launcher was open re-colored the avatar and the selected-tile border (accent token `#ae53ba` → `rgb(147,51,234)`) with no hardcoded color and no console error. **Finding:** the product ships NO light theme — `themes` defines only dark `turbo` and `classic`, so there is no light/dark toggle to probe (PO-scope, G-050).
- [x] E-5: Probe the empty `SHOWABLE_FEATURES` path with the command bar focused — any crash or console error?
  - **No crash, no console error.** With the grid empty (`zzzz` query) and the command bar focused, arrows + Enter were no-ops, the launcher stayed open, and the console stayed clean. (Exercised via the query-filter-to-zero path — see F-5.)
- [x] E-6: Probe window-manager focus after opening a feature from the grid then closing it — does the launcher regain focus, does the grid state persist?
  - **Partial finding.** After opening a feature then closing it, pressing Escape closed the launcher but focus did NOT restore to the FREDO notch trigger — focus fell to `BODY`. Root cause: the notch `div[role="button"][aria-label="Fredo launcher"]` has NO `tabindex`, so `closeLauncher(true)`'s `requestAnimationFrame(() => notch.focus())` is a no-op (a non-focusable `div`). This is a minor a11y/UX finding — the notch is not keyboard-focusable and Escape does not restore focus to it. (The launcher grid keyboard nav and the open/close lifecycle otherwise behave; this does not fail a named AC.)

## Promoted findings
- None promoted this round (the two notable findings — AC2b window-occlusion z-order defect and the notch-not-focusable/Escape-focus-restore gap — are captured in F-3 and E-6 respectively; the occlusion must be fixed before the re-focus / multi-window / E-3 legs can be visually verified).
