# desktop-shell — Smoke Tests

> Standardized app-boots + core-path sanity for the clean desktop shell.

- [x] S-1: App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`
- [x] S-2: No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`
- [x] S-3: Shell surface reachable — the launch surface renders the FREDO notch, pixel-butler avatar, `>` search-or-command bar, side ticks, and online clock (no full-screen animation, no centered "Fredo" title card)
- [x] S-4: Settings accessible — gear/nav opens the settings dialog with the theming appearance sections visible (no "Animation Style" or "Base Theme" control)
- [x] S-5: Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/2817/e2e/smoke.jpeg")` succeeds
  - S-1: structure snapshot returned non-empty body (`theme-classic`).
  - S-2: console `Error`/`Uncaught`/`Maximum update depth` filter → 0 matches; broad read → only non-error framer-motion `motion() is deprecated` WARN.
  - S-3: notch + ONLINE clock render; launcher-open reveals avatar + "Search or command" searchbox + grid; `canvasCount:0`, no title card. NOTE: the wireframe's decorative "side ticks" are NOT implemented in code (pre-existing divergence, not a #2817 change) — see F-1 finding.
  - S-4: settings dialog opens → Appearance section = Theme Presets + Accent/Backgrounds/Text/Status/Fonts + Reset, NO "Animation Style" / "Base Theme" control.
  - S-5: screenshots saved (req1-launch, req1-launcher-open, req1-light, req3-appearance, req5d-dev-mode).

## #2819 extension — desktop-light launcher idle smoke

> Issue #2819: the desktop-light idle/engaged launcher match. Re-run S-1..S-5 plus the
> new idle-chrome + engaged-grid quick paths.

- [ ] S-6: Idle chrome renders — on a fresh launch, the FREDO notch, PERSISTENT pixel-butler avatar, `>` search-or-command bar, LEFT side-tick ruler, RIGHT dot-grid, online clock, and thin rounded frame are present; `#fredo-launcher-grid` is ABSENT.
- [ ] S-7: Engage → idle quick path — focusing the command bar reveals the grid + keyboard hints; pressing ESC hides them and restores the idle chrome (no console error, focus back on the notch).
