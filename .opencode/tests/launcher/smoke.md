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

## #2819 extension — idle launcher surface smoke
- [ ] S-6: Idle launcher surface renders — on a fresh launch the avatar + `>` command bar are visible in the IDLE state (`surfaceOpen:true, engaged:false` — no notch click), plus the LEFT side-tick ruler, RIGHT dot-grid, and thin rounded frame; `#fredo-launcher-grid` is ABSENT. Focusing the command bar reveals the grid + hints (engaged); ESC returns to idle focusing the command bar.

## #2823 extension — Ctrl+Space keyboard smoke

- [ ] S-7: Ctrl+Space opens the launcher from anywhere — from the app's home/desktop, press Ctrl+Space; assert the launcher `role="dialog"` overlay appears (`div[role="dialog"][aria-label="Fredo launcher"]`) and `document.activeElement` is the `input[role="searchbox"]`; no console `Error:`/`Uncaught`/`Maximum update depth exceeded`.

## #2824 extension — ESC keycap engaged-hint smoke

- [ ] S-8: Engaged launcher shows the close-hint row — focus the command bar / enter a query (non-empty feature set) so the hint row renders; `tauri_webview_dom_snapshot(type="structure")` shows the `ESC` badge + `CLOSE` hint text; `tauri_webview_screenshot` succeeds; console clean of `Error:`/`Uncaught`.

## #2827 extension — PixelButler avatar smoke

- [x] S-9: The launcher renders the avatar — the pixel-butler SVG (`svg[aria-hidden="true"][viewBox="0 0 21 21"]`, 91 `<rect>` cells) appears in the running app sourced from the accent token (`color="var(--accent-primary)"` + `fill="currentColor"` → resolved `rgb(0,209,209)`), and `tauri_webview_screenshot` succeeds.
  - **PASS (live, spec/2827 @ 0620b736).** The avatar SVG renders in the launcher with 91 rect cells; `getComputedStyle` `color: rgb(0, 209, 209)`; screenshot `avatar-ac1-render.png` captured; DOM snapshot structure; console clean.

## #2830 extension — single top-right status LED smoke

- [ ] S-10: The launcher's top-right cluster shows a SINGLE status LED (no `ONLINE`/`OFFLINE` text label, no bottom-center LEDs) — `tauri_webview_dom_snapshot(type="structure")` shows one status-LED element below the HH:MM clock text in the `<time>` cluster; `tauri_webview_screenshot` succeeds; console clean of `Error:`/`Uncaught`/`Maximum update depth exceeded`.

## #2850 extension — shared-avatar refactor smoke

> Issue #2850 — the launcher's PixelButler avatar becomes a thin wrapper over the shared
> `FredoAvatar size="md"` component (`apps/ui/src/shared/components/fredo-avatar/`); the
> geometry module + test move to the shared path. The launcher md render must be VISUALLY
> UNCHANGED.

- [ ] S-11: The launcher still renders the md avatar — open the launcher; the avatar SVG
      (`viewBox="0 0 1014 1264"`, crispEdges, 58 rects, accent fill, `aria-hidden`) appears above
      the command bar at 132 × 165 layout px, and `tauri_webview_screenshot` succeeds; console
      clean of `Error:`/`Uncaught`/`Maximum update depth exceeded`.

