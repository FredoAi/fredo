# desktop-shell — Functional Tests

> Per-requirement test cases formalizing the QA Plan table (REQ-1..REQ-5) for issue #2817
> (clean desktop shell — remove animated background + centered "Fredo" title, remove
> "Animation Style" + "Base Theme"/"Theme" settings controls, lock theme base to `classic`,
> re-home the konami→dev-mode easter egg, remove `ogl`/`postprocessing`/`gsap`).

## F-1 (REQ-1) — Fresh launch renders clean shell chrome only

- [ ] F-1: On a fresh launch of the desktop shell (`dev-env` Up -Spec 2817), `tauri_webview_dom_snapshot(type="structure")` shows the FREDO notch (top center), pixel-butler avatar, `>` search-or-command bar, left/right side ticks, and online clock — and shows the ABSENCE of a full-screen animated background layer and a centered "Fredo" title card. `tauri_webview_screenshot` visually matches `.opencode/wireframes/desktop.png` (top frame). No `<canvas>`/full-viewport animation layer and no title-card element.
  - Edge: if the app-launcher overlay is open, dismiss (ESC) and re-assert the same clean chrome beneath.
  - Edge: both light and dark themes render identical clean chrome.
  - Edge: idle (no agent activity) shows no residual animation (no rAF/WebGL context mounted).

## F-2 (REQ-2) — No "Animation Style" control in either render location

- [ ] F-2a: Grep gate — `rg -n "AnimationSelector|DesktopBackground|AnimationContext|useAnimation|AnimationProvider"` under `apps/ui/src` returns zero matches (boundary-safe, case-sensitive).
- [ ] F-2b: Live — the theming settings (ProfileSettingsModal → Appearance) exposes NO "Animation Style" control.
- [ ] F-2c: Live — the legacy SettingsPanel tab exposes NO "Animation Style" control.

## F-3 (REQ-3) — No "Base Theme"/"Theme" selector; base locked to `classic`; presets + overrides still apply

- [ ] F-3a: Grep gate — `rg -n "ThemeSelector"` under `apps/ui/src` returns zero matches.
- [ ] F-3b: Live — the theming settings exposes NO "Base Theme" control; the legacy SettingsPanel exposes NO "Theme"/base-theme selector control.
- [ ] F-3c: The theme base is always the single `classic` default (verify theme resolution source; default base = `classic`).
- [ ] F-3d: Applying a theme preset + a per-token override (e.g. accent) still re-tints surfaces while the base stays `classic` (no half-render, no crash, no theme-cycling).

## F-4 (REQ-4) — Zero remaining references to removed surfaces

- [ ] F-4a: `rg -n` across `apps/ui/src` (and repo where relevant, minus `node_modules`/`dist`) for each removed identifier — `DesktopBackground`, `AnimationSelector`, `AnimationContext`, `useAnimation`, `AnimationProvider`, `Hyperspeed`, `MagnetLines`, `Cubes`, `ThemeSelector` — returns zero matches.
- [ ] F-4b: `ogl` / `postprocessing` / `gsap` are removed from `apps/ui/package.json` deps and have zero remaining `import` sites (Architect-confirmed single-consumer verification). `framer-motion` / `three` / `reactflow` / `d3-force` MUST remain.

## F-5 (REQ-5) — Build green, no regression, stale persisted values tolerated

- [ ] F-5a: `pnpm --filter @fredo/ui build` → zero TypeScript errors.
- [ ] F-5b: `pnpm --filter @fredo/ui test:run` → green.
- [ ] F-5c: Seed stale persisted storage (`Fredo_theme` = a removed base like `turbo`, `animationType` = a removed animation like `hyperspeed`), relaunch — shell launches cleanly on `classic` with no animation and no crash (no `Error:`/`Uncaught`/`Maximum update depth exceeded`).
- [ ] F-5d: Enter the Konami code (Up, Up, Down, Down, Left, Right, Left, Right, `b`, `a`) — the dev-mode easter egg still opens from its re-homed entry point.
- [ ] F-5e: `fredo emit` a sample event → the RTDB row pipeline still classifies it (query `telemetry_spans` for the injected row) — the live-policy evidence channel, no row-pipeline regression.
