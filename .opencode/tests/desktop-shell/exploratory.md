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

## #2819 extension — desktop-light launcher idle/engaged probes

> Add findings here for issue #2819; a confirmed finding PROMOTES to `functional.md` as a
> new `F-` row (keep the origin note).

## E-6 — Idle↔engaged round-trip stability

- [ ] E-6: Probe rapid idle→focus→type→blur→ESC→focus cycles. Check the grid toggles cleanly (no two grids, no duplicate hint rows, no leftover query in the bar after ESC), no console error, no re-render loop.

## E-7 — Re-theme while engaged

- [ ] E-7: Probe switching theme preset (e.g. `tokyo-night` ↔ `light-default`) while the launcher is ENGAGED (grid + hints visible). Do all surfaces (grid tiles, hints, avatar, ticks, dot-grid, rounded frame) re-tint token-native with no flicker and no hardcoded color? Any surface left on a stale color is a finding.

## E-8 — Tile-open with a window already open

- [ ] E-8: Probe opening a tile while another feature window is already open (and the launcher then collapsed to idle). Check z-order/focus: the newly opened window is on top and focused; the desktop did not flash to a blank state. Then reopen the launcher and open a 2nd window — stack both.

## E-9 — Query-to-zero engaged state + keyboard

- [ ] E-9: Probe typing a non-matching query (`zzzz`) while engaged — does the grid show the empty state (`role="status"`) with NO keyboard hints; are arrows/Enter no-ops; does clearing restore the grid + hints without a crash?

## E-10 — First-launch / Setup-wizard interplay

- [ ] E-10: Probe a first launch where the Setup wizard auto-opens (`Home.tsx:67-74`) while the idle chrome (notch + avatar + bar + ticks + dot-grid + rounded frame) is rendered beneath. Does the idle chrome render correctly under the wizard, and does dismissing it return to a correct idle (not a blank surface)?

## E-11 — `—` minimize control + bare-chrome state

- [ ] E-11: Probe the `—` minimize control in the idle command bar (triage Discussion QA-7 / UI/UX-1). Does clicking it collapse the surface to BARE CHROME (`open=false`: notch + clock + frame + ticks + dot-grid, no avatar/bar), and does re-engaging (notch toggle or focus) restore the idle surface correctly? Is there any stuck state, console error, or focus issue? Record the actual behavior against the resolved PO decision (collapse-to-bare-chrome vs ESC-alias vs decorative no-op).

## E-12 — ESC vs shell-close (redesigned semantics)

- [ ] E-12: Probe ESC throughout the #2819 redesign — the surface must STAY (idle), NOT close to bare chrome. Confirm ESC never sets `open=false` (bare chrome is reached only via tile-open / `—`-minimize), and that focus always lands on the command bar after ESC. Any ESC that collapses the whole surface is a regression against the Architect's binding contract (triage line 388).
