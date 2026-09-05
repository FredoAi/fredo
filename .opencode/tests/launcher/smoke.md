# Launcher — Smoke

> Standardized boilerplate (from `.opencode/tests/README.md`) adapted to the launcher
> surface. Runs on a running Fredo desktop app with the spec branch.
> **Serving checkout:** `spec/2808 @ bd30b07b`. Round 2.

- [x] S-1: App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`
  - **PASS.** `body.theme-turbo` → `div#root` non-empty (WindowManager, DesktopBackground, LauncherChrome, etc.).
- [x] S-2: No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`
  - **PASS.** Console across the run had zero `Error:`/`Uncaught`/`Maximum update depth exceeded`; the only recurring line is the pre-existing `motion() is deprecated. Use motion.create() instead.` WARN (from the desktop animation, framer-motion) — not an error and not #2808 scope.
- [x] S-3: Launcher shell reachable — the launcher's entry point renders the FREDO notch + avatar + `>` command bar + grid
  - **PASS.** Clicking `div[role="button"][aria-label="Fredo launcher"]` (the notch trigger) opened the full-screen launchpad overlay (`role="dialog" aria-label="Fredo launcher"`) with the pixel-butler avatar (`<svg color="var(--accent-primary)">`, 206 rects), `input[role="searchbox"]` ("search or command"), and `div#fredo-launcher-grid[role="grid"]` with 4 tiles. Screenshot: `ac3-shell-light.jpeg`.
- [x] S-4: Telemetry Settings accessible — gear/nav opens the settings dialog with sections visible
  - **PASS.** `button[aria-label="Settings"]` opened the settings dialog (`chakra-dialog__content`) with nav sections: Companion, Appearance, Fredo Setup, Telemetry + FEATURES (My Work Items, Infrastructure Diagram, Model Storage, Run CLI). The Appearance section (BASE THEME Turbo/Classic, ACCENT COLORS, BACKGROUNDS, TEXT, STATUS, FONTS, ANIMATION STYLE) is visible — theme switching works.
- [x] S-5: Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/2808/e2e/smoke.jpeg")` succeeds
  - **PASS.** Screenshots captured continuously (`.opencode/tmp/2808/e2e/*.jpeg`) — `tauri_webview_screenshot` succeeds.
