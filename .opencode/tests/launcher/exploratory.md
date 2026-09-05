# Launcher — Exploratory

> Unscripted edge/failure probes for the launcher shell (issue #2808). The Tester adds
> findings here; a confirmed finding promotes to `functional.md` as a new `F-` row
> (keep the origin note).

## Prompt lines
- [ ] E-1: Probe the `>` command bar — type text, cancel, focus-out; does it lose focus or error?
- [ ] E-2: Probe keyboard nav at the grid edges (first/last tile wrap) and Escape-to-close behavior.
- [ ] E-3: Probe opening many features quickly (rapid Enter) — does the kernel store stay consistent, does focus/z-order behave?
- [ ] E-4: Probe toggling light/dark while the launcher is open — do all surfaces re-theme without flicker or hardcoded color?
- [ ] E-5: Probe the empty `SHOWABLE_FEATURES` path with the command bar focused — any crash or console error?
- [ ] E-6: Probe window-manager focus after opening a feature from the grid then closing it — does the launcher regain focus, does the grid state persist?
