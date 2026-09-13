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

### Round 2 (spec/2853 @ 4c9ba542) — smoke results

- **S-8 PASS (live).** Companion ON ⇒ `.fredo-companion-avatar`=1 (80×100), `.fredo-avatar-idle`=0 (mascot absent from the DOM); screenshot succeeded; console clean.
- **S-9 PASS (live).** Companion OFF ⇒ companion=0, `.fredo-avatar-idle`=1 (58 rects) at its usual place; persisted `Fredo_companion_visible`="false"; screenshot succeeded; console clean.
- **S-10 PASS (live).** 5 s timeout, no interaction: companion returned, mascot home; also verified at 20 s (present at t+14.8 s, returned by t+32.1 s); console clean.

## #2854 extension — status-vocabulary smoke

> Issue #2854 adds thinking/happy/playful/joking to the shared avatar on both surfaces.
> Quick paths; the full status matrix lives in `functional.md` F-30..F-41. Live policy —
> screenshot + console-clean per step.

- [ ] S-11: Companion boots + statuses render — with the companion ON, the resting avatar renders; single-click → the avatar shows `thinking` during the wait then `joking` while the joke streams, and returns to rest; `tauri_webview_screenshot` succeeds; console clean of `Error:`/`Uncaught`/`Maximum update depth exceeded`.
- [ ] S-12: Both surfaces render the shared avatar under the new vocabulary — with the companion ON exactly one Fredo renders (`.fredo-companion-avatar`, 80×100, shared SVG); toggle it OFF and the desktop mascot (`.fredo-avatar-idle`) renders the shared SVG; screenshot succeeds; console clean.
- [ ] S-13: No stuck state after a joke/TicTacToe moment — after a joke completes and after a TicTacToe turn, the avatar returns to its resting state (no lingering `thinking`/`joking`/`happy`); screenshot succeeds; console clean.

### Round 1 (spec/2854 @ 0e52c599) — results

- **S-11 PASS (live).** Companion ON, single-click → `thinking` during the wait then `joking` while the joke streamed, returning to rest; screenshots captured; console clean.
- **S-12 PASS (live).** Companion ON ⇒ exactly one Fredo (`.fredo-companion-avatar` 80×100, shared SVG); OFF ⇒ desktop mascot `.fredo-avatar-idle` (shared SVG, 80×100) renders; screenshots captured; console clean.
- **S-13 PASS (live).** Joke `happy→idle` after 4998 ms and TicTacToe `happy→idle` after 3993 ms — no lingering status; screenshots captured; console clean.

## #2864 extension — Settings chrome/theming smoke

> Issue #2864 audits Settings → Companion + the shared dialog chrome. Quick paths; the full
> matrix lives in `functional.md` F-42..F-48 and `.opencode/tests/settings/functional.md`.
> Live policy — screenshot + console-clean per step.

- [ ] S-14: Settings → Companion renders in dark AND light — the gear opens the dialog; the
      Companion section shows the toggle/help/auto-return/Teleport-tip (or the not-ready
      wizard); a screenshot succeeds; console clean of `Error:`/`Uncaught`/`Maximum update
      depth exceeded`.
- [ ] S-15: Theme/accent switch with Settings open — switch dark↔light and change the accent;
      the dialog chrome + Companion panel re-tint with no stale color; screenshot succeeds;
      console clean.

### #2864 testing round 1 (spec/2864 @ f2c8923, product 5c0fb5b) — results

- **S-14 PASS (live).** Companion renders in dark + light (ready controls) and the wizard gate (managed `llama-server` stopped via `stop_llama_server`). Screenshots `tester-dark-ready.png`, `tester-companion-accent.png`, `tester-not-ready-gate-accent.png`.
- **S-15 PASS (live).** dark↔light + `accentPrimary` override with Settings open re-tints the chrome + panel (nav fill, Switch, buttons) with no stale color; console clean.

## #2865 extension — wizard UX visual smoke

> Quick paths for the not-ready wizard visual audit. Live policy — screenshot + console-clean.

- [ ] S-16: Gate renders in both themes — `stop_llama_server` → Settings → Companion shows the
      wizard ONLY (no toggle/tip/auto-return) in dark `classic` AND light `light-default`;
      `tauri_webview_screenshot` succeeds; console clean of
      `Error:`/`Uncaught`/`Maximum update depth exceeded`.

- [ ] S-17: Error quick path — force a step failure; the card shows `error` with actionable copy +
      a Retry control, never a raw stack/IPC string; screenshot succeeds; console clean.

- [ ] S-18: Progress quick path — start a download/install; a moving affordance + status text is
      visible (determinate per-file, indeterminate+narration otherwise); screenshot succeeds.

- [ ] S-19: Visual artifacts + gates — BEFORE/AFTER frames exist under DISTINCT `before-*`/`after-*`
      names; `.opencode/tmp/2865/visual-eval-before.md` + `before-after-verdict.md` exist;
      `pnpm --filter @fredo/ui build` exit 0; frozen hooks present.

## #2870 extension — one-Fredo-at-home smoke (supersedes the !companionPresent gate)

> Issue #2870 keeps Fredo AT the centre seat when the companion is enabled (no corner move), renders an
> empty seat when he is away, and greets on every turn-on. **G-136 supersede:** S-8/S-9/S-12 asserted the
> removed "companion ON ⇒ launcher mascot not rendered" gate (and S-10's "return" wording) — now SUPERSEDED
> by S-20..S-23 below; the historical PASS records above are preserved. Live policy — screenshot +
> console-clean per step.

- [ ] S-20: Companion ON ⇒ Fredo at the centre seat — toggle ON (Settings → Companion); `execute_js` shows the interactive seat entity in the centre slot (role active in place), NO corner `position:fixed` wrapper, and the command-bar `getBoundingClientRect().y` unchanged (≤1 px) vs OFF; `tauri_webview_screenshot` succeeds; console clean of `Error:`/`Uncaught`/`Maximum update depth exceeded`.
- [ ] S-21: Companion OFF ⇒ decorative mascot at the seat — toggle OFF; `.fredo-avatar-idle` (58 rects) renders at the SAME centre seat and the interactive seat entity is gone (NOT the placeholder); persisted `Fredo_companion_visible="false"`; screenshot succeeds; console clean.
- [ ] S-22: Turn-on welcome bubble — toggle ON; the welcome bubble appears at the seat and auto-hides at ~4 s (same-task capture per G-140); screenshot succeeds; console clean.
- [ ] S-23: Away ⇒ empty seat — Ctrl+right-click in main (recipe a); the centre slot shows the 80×100 placeholder (not Fredo, not a corner Fredo); screenshot succeeds; console clean.
