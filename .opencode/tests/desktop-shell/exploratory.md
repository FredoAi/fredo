# desktop-shell — Exploratory Tests

> Unscripted edge/failure probes for the clean-shell removal. A confirmed finding here
> **promotes** to `functional.md` (with the origin note).

## E-1 — Stale / malformed persisted values

- [x] E-1: Probe a stale `Fredo_theme` value that names a now-removed base (e.g. `turbo`) → the shell lands on `classic` with no crash.
- [x] E-1: Probe an unknown/malformed `Fredo_theme` string matching no known base → still lands on `classic`, no error.
  - CONFIRMED (round 1): seeded `Fredo_theme='turbo'` + `animationType='hyperspeed'` → reload → `bodyClass:theme-classic`, `canvasCount:0`, accent `#9333ea`. Seeded malformed `Fredo_theme='zorp-blaster-no-such-base'` + `animationType='quantum-warp'` → same clean classic result. Stale keys remain in storage but are IGNORED (`ThemeProvider.tsx:48` — the `Fredo_theme` read is dropped). Promoted to F-5c evidence.

## E-2 — Launcher overlay interplay

- [x] E-2: Probe launching with the app-launcher overlay open, then dismissing (ESC) → the clean shell chrome is beneath, no full-screen animation and no centered title card in either state.
  - CONFIRMED (round 1): opened launcher via notch → clean chrome (avatar/search/grid, no canvas/title); ESC → closed clean chrome. Both states `canvasCount:0`. Promoted to F-1 edge.

## E-3 — Preset + override over the locked base

- [x] E-3: Probe applying a theme preset then a per-token override over the locked `classic` base → no theme-cycling, no blank/empty theme state, no half-rendered surface.
  - CONFIRMED (round 1): Tokyo Night preset + Fira Mono body-font override applied over locked classic → re-tint, base stayed `classic`, no cycling / blank / half-render; reset to defaults restored stock classic. Promoted to F-3d.

## E-4 — Konami re-homed entry point

- [x] E-4: Probe the konami→dev-mode easter egg at its re-homed entry path (shell mount / `Home`) → dev-mode feature still opens; confirm the path, not only the old `DesktopBackground` location.
  - CONFIRMED (round 1): entered the full Konami sequence (Up×2, Down×2, Left, Right, Left, Right, b, a) via real key events → Dev Mode window opened. Re-homed to `useKonamiCode(handleKonamiCode)` in `HomeDesktop` (Home.tsx:55), NOT the removed `DesktopBackground`. Promoted to F-5d.

## E-5 — Console health / empty state

- [x] E-5: Probe an idle launch (no agent activity, stale/empty persisted storage) → clean chrome, no residual animation, no `Error:`/`Uncaught`/`Maximum update depth exceeded`.
  - CONFIRMED (round 1): reload with stale + malformed storage → `bodyClass:theme-classic`, `canvasCount:0`; `tauri_read_logs(source=console)` → no `Error:`/`Uncaught`/`Maximum update depth exceeded` (only a non-error framer-motion `motion() is deprecated` WARN — pre-existing). Promoted to F-5c.
