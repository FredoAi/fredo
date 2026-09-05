# desktop-shell — Exploratory Tests

> Unscripted edge/failure probes for the clean-shell removal. A confirmed finding here
> **promotes** to `functional.md` (with the origin note).

## E-1 — Stale / malformed persisted values

- [ ] E-1: Probe a stale `Fredo_theme` value that names a now-removed base (e.g. `turbo`) → the shell lands on `classic` with no crash.
- [ ] E-1: Probe an unknown/malformed `Fredo_theme` string matching no known base → still lands on `classic`, no error.

## E-2 — Launcher overlay interplay

- [ ] E-2: Probe launching with the app-launcher overlay open, then dismissing (ESC) → the clean shell chrome is beneath, no full-screen animation and no centered title card in either state.

## E-3 — Preset + override over the locked base

- [ ] E-3: Probe applying a theme preset then a per-token override over the locked `classic` base → no theme-cycling, no blank/empty theme state, no half-rendered surface.

## E-4 — Konami re-homed entry point

- [ ] E-4: Probe the konami→dev-mode easter egg at its re-homed entry path (shell mount / `Home`) → dev-mode feature still opens; confirm the path, not only the old `DesktopBackground` location.

## E-5 — Console health / empty state

- [ ] E-5: Probe an idle launch (no agent activity, stale/empty persisted storage) → clean chrome, no residual animation, no `Error:`/`Uncaught`/`Maximum update depth exceeded`.
