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

- [x] S-11: The launcher still renders the md avatar — open the launcher; the avatar SVG
      (`viewBox="0 0 1014 1264"`, crispEdges, 58 rects, accent fill, `aria-hidden`) appears above
      the command bar at 132 × 165 layout px, and `tauri_webview_screenshot` succeeds; console
      clean of `Error:`/`Uncaught`/`Maximum update depth exceeded`.
  - **PASS (live, spec/2850).** The launcher rendered the shared `FredoAvatar size="md"` SVG (`viewBox="0 0 1014 1264"`, crispEdges, 58 rects, accent-token fill `var(--accent-primary)`/`currentColor`, `aria-hidden`) above the `>` command bar at `offsetWidth`=132/`offsetHeight`=165. `tauri_webview_screenshot` succeeded; console clean (no `Error:`/`Uncaught`/`Maximum update depth exceeded`).

## #2852 extension — desktop mascot 80×100 + idle animation smoke

> **Round 1 (spec/2852 @ 1677eca8) — S-12 PASS.** Mascot SVG `viewBox="0 0 1014 1264"`, crispEdges, 58 rects, accent fill, `aria-hidden`; wrapper 80×100 running `fredo-idle-bob`+`fredo-idle-glow` 2.4s; screenshot succeeded; console clean.

> Issue #2852 — the launcher mascot renders at the shared `sm` size (80×100) and plays the
> companion's idle bob+glow. **OVERRIDE:** S-11's 132×165 md-size expectation is SUPERSEDED —
> the required render is now 80×100.

- [ ] S-12: The launcher renders the sm mascot with its idle animation — open the launcher; the mascot SVG (`viewBox="0 0 1014 1264"`, crispEdges, 58 rects, accent fill, `aria-hidden`) appears above the command bar at `offsetWidth`=80/`offsetHeight`=100, its wrapper carries a running `fredo-idle-bob` + `fredo-idle-glow` 2.4 s animation, and `tauri_webview_screenshot` succeeds; console clean of `Error:`/`Uncaught`/`Maximum update depth exceeded`.

## #2868 extension — Settings tile in the grid smoke

> Issue #2868 adds the Settings app tile and retires the floating gear. **G-136:** S-4 ("gear/nav
> opens the settings dialog") is SUPERSEDED by S-13 below; the historical PASS is preserved.

- [ ] S-13: The engaged grid includes a `[role="button"][aria-label="Settings"]` tile; clicking it
      opens the Settings feature window (`div[role="group"][aria-label="Settings"]`, header title
      "Settings"); on a clean desktop NO floating gear (`IconButton[aria-label="Settings"]`) and no
      settings `chakra-dialog__content` render; `tauri_webview_screenshot` succeeds; console clean
      of `Error:`/`Uncaught`/`Maximum update depth exceeded`.

### #2868 testing round 1 (spec/2868 @ 90da8de) — result

  - **S-13 PASS (live).** Engaged grid: `[role="button"][aria-label="Settings"]` present; click opens `div[role="group"][aria-label="Settings"]` with header title "Settings". Clean desktop: floating gear count 0, `chakra-dialog__content` count 0; screenshot succeeded; console clean. Evidence: `.opencode/tmp/2868/tests-runs.md` / `## Tests Runs (round 1)`.

## #2870 extension — home-seat stability smoke (G-136)

> Issue #2870 keeps Fredo at the centre seat when the companion is enabled and reserves the seat slot so the
> command bar never shifts. S-12 still describes the role-OFF seat (decorative sm mascot + idle motion) and
> remains in force for that state. Live policy.

- [ ] S-14: Seat stability across ON/OFF — open the launcher; record the command bar `getBoundingClientRect().y` with the companion OFF, then ON, then OFF again (and after a 5 s idle auto-return). `y` stays within ±1 px in every state; the 80×100 seat slot is present in all states (never unmounts); `tauri_webview_screenshot` succeeds; console clean of `Error:`/`Uncaught`/`Maximum update depth exceeded`.

### Round 1 (spec/2870 @ dd0026e1) — results

> **S-14 FAIL / UNVERIFIED (blocking boot defect).** The tested tip does not boot — `EmptySeat.tsx:4-5`'s `@/` imports are unresolved under `apps/tauri/vite.config.ts` (`@` → `apps/tauri/src`, no `shared/`), so the launcher/command bar never mount and no `y` can be measured. Evidence + root cause: `.opencode/tmp/2870/tests-runs.md` (`## Tests Runs (round 1)`, Verdict **FAIL**). Re-run after the fix.

### Round 2 (spec/2870 @ 6474a5fe) — results

- **S-14 PASS for `y` invariance (live); FAIL for the 80×100 slot.** Command-bar `getBoundingClientRect().y` = **485.77** with the companion OFF, ON-home, ON-away, and after the 5 s idle auto-return (|Δ| = 0 px); at 700×900 = 446.0 across ON-home/away; the seat slot never unmounts; screenshots succeeded; consoles clean. **But the seat slot measures 320 px wide** (Chakra `sizes.80` token mis-resolution — `LauncherShell.tsx:568` `width={AVATAR_SM.width}`), not the required 80 px; the mascot/entity renders at the slot's left edge (centre ≈840 vs launcher axis 960). See `functional.md` F-62/F-66.

