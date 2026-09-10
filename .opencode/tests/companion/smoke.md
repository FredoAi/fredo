# Companion — Smoke

> Standardized boilerplate (from `.opencode/tests/README.md`) adapted to the companion surface.
> Runs on a running Fredo desktop app with the spec branch (`spec/2850`), MCP driver
> `com.fredo.app`. Live policy — capture + console-clean at each step.

- [x] S-1: App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`.
  - **PASS.** `body.theme-classic` → `div#root` with the WindowManager/DesktopBackground/LauncherChrome surfaces (125+ indexed elements).
- [x] S-2: No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`.
  - **PASS.** Console across the run: only INFO/DEBUG + the pre-existing `motion() is deprecated` WARN (exempt); zero error-level entries in main AND run-cli-terminal.
- [x] S-3: Companion surface reachable — with the companion toggled on (Settings → Companion), the companion avatar renders in the main window as the shared sm vector avatar (`<svg viewBox="0 0 1014 1264">`, crispEdges rects, accent fill), not a raster sprite; the avatar wrapper exposes an accessible name describing the click/teleport gestures.
  - **PASS.** Toggled the companion on via Settings → Companion; `.fredo-companion-avatar` rendered the shared `FredoAvatar size="sm"` `<svg viewBox="0 0 1014 1264">` with 58 crispEdges rects + accent fill, wrapper `aria-label="Fredo companion -- idle"` + `title="Click to chat | Double-click to play Tic-Tac-Toe | Ctrl+right-click to teleport"`. NO raster sprite.
- [x] S-4: Telemetry Settings accessible — the gear opens the settings dialog; the Companion nav section renders the visibility toggle + teleport tip (no bubble-color section).
  - **PASS.** The gear opened the settings dialog; the Companion nav section renders "Show Fredo Companion" toggle + the "Hold Ctrl and right-click anywhere to teleport Fredo there." tip — no bubble-color section, no autoWalk control.
- [x] S-5: Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/2850/e2e/smoke.jpeg")` succeeds.
  - **PASS.** `tauri_webview_screenshot` (png) captured continuously to `.opencode/tmp/2850/e2e/*.png`.
- [x] S-6: Companion quick path — single-click the avatar → a joke streams into the bubble with the cursor blinking; the avatar shows the talk state; on completion the bubble closes and the avatar returns to idle. Console clean.
  - **PASS.** Single-click → state `talk`, a joke streamed into the 240×120 bubble (cursor `Fredo-cursor-blink` 0.9s 2×14px observed during active streaming), on `llm-done` the talk held ~5s then returned to idle + the bubble closed. Console clean.

## Test-data prerequisites for the full suite

- LLM model (UQFF) + mmproj present and loaded (the companion settings model-gate requires them).
- Run CLI terminal window (`run-cli-terminal`) launchable for the cross-window teleport leg (F-10).
- Dev-mode Vite server (`pnpm dev:ui`, DevAdapter) for the M10 leg.

## #2852 extension — cross-surface sm parity smoke

> Issue #2852 makes the launcher mascot render at the companion's sm size + idle motion. This
> smoke row confirms both surfaces still render the shared canonical avatar.

- [ ] S-7: Launcher + companion both render the shared sm avatar — open the launcher and toggle the companion on; each renders the shared `FredoAvatar` SVG (`viewBox="0 0 1014 1264"`, crispEdges, 58 rects, accent fill, `aria-hidden`) at `offsetWidth`=80/`offsetHeight`=100, and `tauri_webview_screenshot` succeeds; console clean of `Error:`/`Uncaught`/`Maximum update depth exceeded`.
