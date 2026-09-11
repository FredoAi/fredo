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

> **Round 1 (spec/2852 @ 1677eca8) — S-7 PASS.** Launcher + companion both render the shared `FredoAvatar` SVG (`viewBox="0 0 1014 1264"`, crispEdges, 58 rects, accent fill, `aria-hidden`) at `offsetWidth=80`/`offsetHeight=100`; screenshot succeeded; console clean of `Error:`/`Uncaught`/`Maximum update depth exceeded`.

> Issue #2852 makes the launcher mascot render at the companion's sm size + idle motion. This
> smoke row confirms both surfaces still render the shared canonical avatar.

- [ ] S-7: Launcher + companion both render the shared sm avatar — open the launcher and toggle the companion on; each renders the shared `FredoAvatar` SVG (`viewBox="0 0 1014 1264"`, crispEdges, 58 rects, accent fill, `aria-hidden`) at `offsetWidth`=80/`offsetHeight`=100, and `tauri_webview_screenshot` succeeds; console clean of `Error:`/`Uncaught`/`Maximum update depth exceeded`.

## #2853 extension — presence lifecycle smoke

> Issue #2853 adds single-Fredo presence + idle auto-return. Quick paths below; the full
> lifecycle lives in `functional.md` F-21..F-29. Live policy — screenshot + console-clean per step.

- [x] S-8: Companion ON ⇒ exactly one Fredo — toggle the companion on (Settings → Companion); a DOM snapshot/count probe shows `.fredo-companion-avatar` present and the desktop/launcher mascot **not rendered** (absent from the DOM); `tauri_webview_screenshot` succeeds; console clean.
- [x] S-9: Companion OFF ⇒ desktop mascot returns — toggle the companion off; the desktop/launcher mascot is present at its usual place and the companion is absent; screenshot succeeds; console clean.
- [x] S-10: Short idle ⇒ auto-return — with a short configured idle value (e.g. 5 s) and no interaction, the companion hides and the desktop mascot returns with no user action; screenshot before/after succeeds; console clean of `Error:`/`Uncaught`/`Maximum update depth exceeded`.

### #2853 round 1 results (spec/2853 @ 1c9696aa, live)

- **S-8 PASS.** Companion ON → `.fredo-companion-avatar`=1, `.fredo-avatar-idle`=0 (mascot absent from DOM); screenshot + console clean.
- **S-9 PASS.** Companion OFF → mascot present at its usual slot (920,345), companion absent; screenshot + console clean.
- **S-10 PASS.** Timeout 5 s, no interaction: at t+5.2 s `teleport-out` (no premature return), after settle companion hidden + mascot back; screenshots + console clean.
