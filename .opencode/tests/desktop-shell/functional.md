# desktop-shell — Functional Tests

> Per-requirement test cases formalizing the QA Plan table (REQ-1..REQ-5) for issue #2817
> (clean desktop shell — remove animated background + centered "Fredo" title, remove
> "Animation Style" + "Base Theme"/"Theme" settings controls, lock theme base to `classic`,
> re-home the konami→dev-mode easter egg, remove `ogl`/`postprocessing`/`gsap`).

## F-1 (REQ-1) — Fresh launch renders clean shell chrome only

- [x] F-1: On a fresh launch of the desktop shell (`dev-env` Up -Spec 2817), `tauri_webview_dom_snapshot(type="structure")` shows the FREDO notch (top center), pixel-butler avatar, `>` search-or-command bar, left/right side ticks, and online clock — and shows the ABSENCE of a full-screen animated background layer and a centered "Fredo" title card. `tauri_webview_screenshot` visually matches `.opencode/wireframes/desktop.png` (top frame). No `<canvas>`/full-viewport animation layer and no title-card element.
  - PASS (#2817 round 1). Closed shell: FREDO notch + ONLINE clock + Settings button; JS probe `canvasCount:0, webglCount:0, hasAnimationLayer:false, bodyClass:theme-classic` (no animation layer, no WebGL/rAF context, no centered title card — the lone "fredo" text is the notch label). Launcher-open state (notch click): pixel-butler avatar + `>` "Search or command" searchbox + `| APPS` grid (Mission Monitor/Query Viewer/Run CLI/Stepper Probe) + NAVIGATE/SELECT/CLOSE hints. Screenshots match `.opencode/wireframes/desktop.png` (closed→top frame, open→bottom frame). Light edge: applied "Light Default" preset → `bodyBg:rgb(255,255,255)`, `bodyClass:theme-classic`, `canvasCount:0` — clean chrome in light too. FINDING (pre-existing, NOT a #2817 regression): the wireframe's decorative "side ticks" (edge dot columns) are NOT implemented as a component — `LauncherChrome.tsx` renders notch+clock+hints only and grep for `tick` in `apps/ui/src/features/home` returns only a comment in Home.tsx:147. `LauncherChrome`/`LauncherShell` were not modified by the removal commit (git show cd38c25 — no launcher files), so side-ticks absence predates #2817 (NFR-A "no chrome changed").
  - Edge (launcher overlay open then ESC): verified — launcher opened → clean chrome, ESC → clean closed chrome, no animation/title in either state.
  - Edge (light + dark): dark = stock `classic` base (bodyBg `#111827`); light = "Light Default" preset (bodyBg `#ffffff`); both render identical clean chrome (no canvas / no title).
  - Edge (idle): no residual animation (`canvasCount:0`, `webglCount:0`) — the shell clock uses `setInterval`, no WebGL context mounted.

## F-2 (REQ-2) — No "Animation Style" control in either render location

- [x] F-2a: Grep gate — `rg -n "AnimationSelector|DesktopBackground|AnimationContext|useAnimation|AnimationProvider"` under `apps/ui/src` returns zero matches (boundary-safe, case-sensitive).
- [x] F-2b: Live — the theming settings (ProfileSettingsModal → Appearance) exposes NO "Animation Style" control.
- [x] F-2c: Live — the legacy SettingsPanel tab exposes NO "Animation Style" control.
  - Evidence: Appearance section (screenshot req3-appearance) shows Theme Presets + Accent/Backgrounds/Text/Status/Fonts + Reset — NO "Animation Style". The legacy SettingsPanel.tsx now renders ONLY "AI Model" + "Telemetry" tabs (Theming tab dropped); `SettingsPanel.test.tsx` asserts "renders no base-theme or animation controls (#2817 removal)" and passed green in test:run. Legacy panel is exported but NOT mounted in the live app tree (verified via grep — only its own test imports it), so the live UI check is covered by the source + green unit test; the "Animation Style" control cannot render because `AnimationSelector` does not exist (grep zero).

## F-3 (REQ-3) — No "Base Theme"/"Theme" selector; base locked to `classic`; presets + overrides still apply

- [x] F-3a: Grep gate — `rg -n "ThemeSelector"` under `apps/ui/src` returns zero matches.
- [x] F-3b: Live — the theming settings exposes NO "Base Theme" control; the legacy SettingsPanel exposes NO "Theme"/base-theme selector control.
- [x] F-3c: The theme base is always the single `classic` default (verify theme resolution source; default base = `classic`).
- [x] F-3d: Applying a theme preset + a per-token override (e.g. accent) still re-tints surfaces while the base stays `classic` (no half-render, no crash, no theme-cycling).
  - F-3a evidence: grep for `ThemeSelector` in `apps/ui/src` → No files found.
  - F-3b evidence: Appearance section screenshot req3-appearance — NO "Base Theme" control, only ThemePresetSelector + overrides + Reset; legacy SettingsPanel no longer has a "Theme" select (source).
  - F-3c evidence: `ThemeProvider.tsx:48` `const activeTheme: ThemeMode = 'classic';` (the `Fredo_theme` read is dropped); `document.body.className = theme-classic` (line 104). Live JS probes throughout showed `bodyClass:theme-classic`.
  - F-3d evidence: set "Tokyo Night" preset via JS → `--accent-primary` changed `#9333ea`→`#7aa2f7`, body bg `#1a1b26`, `bodyClass:theme-classic` (re-tint, base stays classic). Then set per-token Body-font override → `--font-base`→`'Fira Mono','Courier New',monospace`, body `fontFamily` `"Fira Mono","Courier New",monospace`, `bodyClass:theme-classic`. Then "Reset to theme defaults" → preset `""`, accent back to `#9333ea`, font back to Inter, bodyClass classic. No crash, no half-render, no theme-cycling.

## F-4 (REQ-4) — Zero remaining references to removed surfaces

- [x] F-4a: `rg -n` across `apps/ui/src` (and repo where relevant, minus `node_modules`/`dist`) for each removed identifier — `DesktopBackground`, `AnimationSelector`, `AnimationContext`, `useAnimation`, `AnimationProvider`, `Hyperspeed`, `MagnetLines`, `Cubes`, `ThemeSelector` — returns zero matches.
- [x] F-4b: `ogl` / `postprocessing` / `gsap` are removed from `apps/ui/package.json` deps and have zero remaining `import` sites (Architect-confirmed single-consumer verification). `framer-motion` / `three` / `reactflow` / `d3-force` MUST remain.
  - F-4a evidence: grep across `apps/ui` for `DesktopBackground|AnimationSelector|AnimationContext|useAnimation|AnimationProvider|ThemeSelector` → No files found; grep `apps/ui/src` for `Hyperspeed|MagnetLines|Cubes` → No files found; glob `apps/ui/src/shared/components/animations/**` and `DesktopBackground|AnimationSelector|AnimationContext|ThemeSelector`.tsx → No files found.
  - F-4b evidence: `apps/ui/package.json` deps contain NO `ogl`/`postprocessing`/`gsap` (only `framer-motion`, `three`, `reactflow`, `d3-force` retained among the protected set + `@types/d3-force`, `@types/three`). Repo-wide grep for `from 'ogl'|'postprocessing'|'gsap'`/`require(...)` → 0 product matches (only `.opencode/skills/threejs/SKILL.md:534` `import gsap from "gsap";` — a skill documentation example, not product source or a dependency). The 4 `ogl` substring hits in `apps/ui` are Google Fonts/Gemma comment/URL substrings (index.html `fonts.googleapis`, ThemingSettings "Google Fonts", ModelSelector "Google Gemma" — explicitly NOT imports).
  - Removal commit `git show --stat cd38c25` (-2335 lines) deleted `DesktopBackground`/`AnimationSelector`/`ThemeSelector`/`AnimationContext`/`shared/components/animations/*` and removed `ogl`/`postprocessing`/`gsap` from package.json; `framer-motion`/`three`/`reactflow`/`d3-force` remain.

## F-5 (REQ-5) — Build green, no regression, stale persisted values tolerated

- [x] F-5a: `pnpm --filter @fredo/ui build` → zero TypeScript errors.
- [x] F-5b: `pnpm --filter @fredo/ui test:run` → green.
- [x] F-5c: Seed stale persisted storage (`Fredo_theme` = a removed base like `turbo`, `animationType` = a removed animation like `hyperspeed`), relaunch — shell launches cleanly on `classic` with no animation and no crash (no `Error:`/`Uncaught`/`Maximum update depth exceeded`).
- [x] F-5d: Enter the Konami code (Up, Up, Down, Down, Left, Right, Left, Right, `b`, `a`) — the dev-mode easter egg still opens from its re-homed entry point.
- [x] F-5e: `fredo emit` a sample event → the RTDB row pipeline still classifies it (query `telemetry_spans` for the injected row) — the live-policy evidence channel, no row-pipeline regression.
  - F-5a evidence: `pnpm --filter @fredo/ui build` → `tsc && vite build` completed, `✓ 2559 modules transformed`, `✓ built in 8.36s`, 0 TS errors (only a >500 kB chunk-size advisory, not an error).
  - F-5b evidence: `pnpm --filter @fredo/ui test:run` → `Test Files 47 passed (47)` / `Tests 699 passed (699)` (includes `SettingsPanel.test.tsx` #2817 removal assertions + `ThemeProvider.test.tsx` stale-value edge, both green).
  - F-5c evidence: seeded `Fredo_theme='turbo'` + `animationType='hyperspeed'` in localStorage, reloaded → `bodyClass:theme-classic`, `canvasCount:0`, accent `#9333ea`; stale keys still present but IGNORED. Also seeded malformed `Fredo_theme='zorp-blaster-no-such-base'` + `animationType='quantum-warp'` → same clean result (malformed tolerated). `tauri_read_logs(source=console)` shows NO `Error:`/`Uncaught`/`Maximum update depth exceeded` (only a non-error framer-motion `motion() is deprecated` WARN — pre-existing, unrelated).
  - F-5d evidence: entered Konami (Up×2, Down×2, Left, Right, Left, Right, b, a) via real key events (the re-homed `useKonamiCode(handleKonamiCode)` in HomeDesktop.tsx:55) → Dev Mode feature window opened (banner "Dev Mode", `live` badge, filter, INIT/UPDATE/RESPONSE/ERROR/TIMEOUT), screenshot req5d-dev-mode. Opens from the re-homed path, not the removed DesktopBackground.
  - F-5e evidence: `fredo emit --event-type tool_use ... --session-id e2e-2817-rowtest` + `--event-type chat ... --file .opencode/tmp/2817/payload-chat.json` → both `{"queued":true}`. `tool_use_rows` row classified (session `e2e-2817-rowtest`, tool `read_file`, state `init`); `chat_rows` row classified (`user_message:"e2e-2817: hello from row-pipeline test"`). Live-gate `telemetry_spans` reference: `SELECT COUNT(*) ... FROM telemetry_spans` → 7670 spans, newest `2026-09-05 15:59:31` (span store live). NOTE: `fredo emit` writes to the RTDB row tables (bypasses the OTLP receiver), so the injected session does NOT appear in `telemetry_spans` — the row tables are the classification proof; telemetry_spans is the live span-store reference.

## #2819 extension — desktop-light idle/engaged launcher match

> New cases for issue #2819 (desktop launcher matches the approved `desktop-light.png`
> wireframe). Supersedes the #2817 F-1 "side ticks NOT implemented" finding: this spec
> ADDS the side-tick ruler, right dot-grid, rounded frame, persistent avatar, and the
> idle `>` command bar. REQ ids mirror AC1..AC5. Run on a running Fredo desktop app
> (dev-env up), MCP driver session `com.fredo.app`. Map 1:1 to the QA Plan in
> `.opencode/tmp/2819/triage.md` `## QA Expert`. Live policy — Evidence must reference
> `telemetry_spans` (F-14).

## F-6 (REQ-1/AC1) — Idle desktop renders the full light chrome

- [ ] F-6: On a fresh launch, `tauri_webview_dom_snapshot(type="structure")` shows the IDLE state: the FREDO header notch (`[role="button"][aria-label="Fredo launcher"]`), the pixel-butler avatar (visible while idle — NOT gated inside the launcher-open overlay), the `>` search-or-command bar (`input[role="searchbox"]`, aria-label "Search or command"), the LEFT side-tick ruler, the RIGHT dot-grid with `+`, the online clock (`<time>` HH:MM + ONLINE), and the thin rounded frame. `tauri_webview_screenshot` matches `desktop-light.png`'s idle frame (best-effort against the asset — see F-12).
  - **Idle-render proof (no notch click):** the avatar + command bar render in the IDLE state (`surfaceOpen:true, engaged:false` — the Architect's frozen 3-state model). JS probe: `surfaceOpen:true, engaged:false`, avatar SVG present (`<svg color="var(--accent-primary)">` with 206 `<rect>` pixels), `input[role="searchbox"]` present, `#fredo-launcher-grid` ABSENT. (`open=false` = the collapsed/bare-chrome state where the avatar + bar are hidden — that is NOT idle.)
  - **Edge:** idle must NOT depend on a notch click to show the avatar + bar (the surface is `open=true` at launch). The avatar+bar are persistent IN the idle surface, but HIDE when the surface collapses to bare chrome (`open=false` on window-open / `—`-minimize) — AC1's "persistent" means present at idle, not overlaid over an opened window.
  - **Edge (light + dark):** light = `light-default` preset (bodyBg `#ffffff`); dark = stock `classic` base (bodyBg `rgb(17,24,39)`); both render the idle chrome with no hardcoded color.

## F-7 (REQ-1/AC1) — No app grid while idle

- [ ] F-7: While the bar is NOT focused and NO query is present, the app grid is ABSENT — `#fredo-launcher-grid` / `[role="grid"][aria-label="Apps"]` is NOT in the DOM snapshot.
  - **Edge:** grid stays absent across an idle reconfigure (e.g. SHOWABLE_FEATURES non-empty but idle). Progress the launcher to engaged then ESC back — grid leaves the DOM.

## F-8 (REQ-2/AC2) — Focus reveals grid + keyboard hints

- [ ] F-8: Focusing the search-or-command bar (click or Tab) reveals the feature grid BELOW the bar (`#fredo-launcher-grid` with the `SHOWABLE_FEATURES` tile set = Mission Monitor / Query Viewer / Run CLI / Stepper Probe) plus the keyboard-hints row (↑↓ NAVIGATE · ←→ SELECT · ESC CLOSE).
  - **Edge (click vs Tab):** focus-in via mouse click and via keyboard Tab both reveal the grid + hints.
  - **Edge (blur/no-query):** blur to a target OUTSIDE the launcher surface (a `:focus-within` guard on the launcher root) with an EMPTY query → return to idle (resolved **Discussion QA-1**); a focus hop INTO a grid tile stays engaged (no tile-click race — do NOT use a raw input `onBlur` that would collapse before the tile `onSelect` runs).
  - **Edge (notch toggle):** opening via the notch (if retained as a secondary open path) also yields the engaged grid + hints.

## F-9 (REQ-2/AC2) — Query present reveals grid + hints; empty-match shows empty state

- [ ] F-9: When a query is present in the bar, the feature grid + keyboard hints are revealed below the bar; typing filters the grid (`filteredEntries` = names containing the query); a query matching no feature (`zzzz`) shows the graceful `role="status"` "No apps available" empty state with NO keyboard hints.
  - **Edge (clear):** clearing the query (backspace to empty) hides the grid back to idle.
  - **Edge (type-ahead):** a matched tile shows the selected/accent highlight; arrows move the selection.

## F-10 (REQ-2/AC2) — ESC returns to idle

- [ ] F-10: Pressing `ESC` hides the grid + hints (`engaged=false`) while the surface STAYS (`open` stays `true`), returning the desktop to the IDLE state (notch + avatar + bar + ticks + dot-grid + clock + rounded frame only — NOT a shell close).
  - **Edge (ESC states):** ESC while the bar is focused; ESC with a query present; ESC from a selected-tile state. ESC restores focus to the COMMAND-BAR searchbox (`input[role="searchbox"]` is focused, not `BODY` and not the notch) — the idle affordance per the UI/UX interaction flow (this DIFFERS from the #2808 ST-7 pattern, which restored focus to the notch on a shell close).
  - **Edge (console):** no `Error:`/`Uncaught`/`Maximum update depth exceeded` across the ESC round-trips.

## F-11 (REQ-2/AC2) — Tile select opens the feature window

- [ ] F-11: Selecting a tile (mouse click, or keyboard Enter on a focused tile) opens the corresponding feature window through the own-kernel full-lifecycle opener (`Home.tsx:82 openFeatureWindow`) — `div.fredo-window__surface` + `header.fredo-window__header` (title = feature.name) appear, the window is focused/maximized, and the launcher COLLAPSES to BARE CHROME (`open=false`: avatar + bar + grid hidden; notch + clock + frame + ticks + dot-grid remain) so the window is NOT occluded (Architect frozen contract, triage line 388).
  - **Edge (re-open):** re-opening an already-open tile re-focuses without a duplicate (`openWindows` stays 1).
  - **Edge (multi-window):** opening a 2nd feature adds a window; `elementFromPoint(center)` returns the topmost `fredo-window__surface` (z-order).
  - **Edge (empty-grid Enter):** with the grid empty (`entryCount === 0`), arrows + Enter are no-ops and NO window opens.
  - **Edge (re-show after close):** after a tile-open (`open=false`), closing the window and clicking the NOTCH re-shows the surface (`open=true`) at the IDLE state (avatar + bar, no grid).

## F-12 (REQ-3/AC3) — Visual fidelity gate (side-by-side vs desktop-light.png)

- [ ] F-12: The tester performs a SIDE-BY-SIDE screenshot comparison against `desktop-light.png`, attaches the comparison image to the evidence, and calls out EVERY deviation (element present/absent, position, size, color, accent, font, spacing).
  - **Gate:** a side-by-side composite or paired screenshots (idle light render vs `desktop-light.png`) + a written deviation list. ANY unmapped deviation is a FAIL.
  - **Asset path (Read, never glob):** `.opencode/` is a dot-prefixed dir — `glob`/ripgrep silently skip it. The tester MUST `Read .opencode/wireframes/desktop-light.png` by EXPLICIT absolute path (it IS on disk; QA-2 resolved). The engaged-dark compare is `.opencode/wireframes/desktop-light-dark-theme-compare.png`. If a tester checkout/CI lacks them (git-tracking unverified), mark FAIL (documented PO-amended deferral) — do NOT silently drop the gate.
  - **Glyph checkpoint:** the hint labels must match the wireframe char-for-char — `↑↓ NAVIGATE` / `←→ SELECT` / `ESC CLOSE`. RETAIN the existing LeftRight glyph; do NOT treat the brief prose's `↵ SELECT` as the label (Architect reconciliation, triage line 389). The wireframe's teal is the live accent token, not a hardcoded literal.

## F-13 (REQ-4/AC4) — Zero regression (lifecycle, presets, token contract, build)

- [ ] F-13a: **Window lifecycle** — open a feature from the grid, close it (window `X`), relaunch from the grid — the own-kernel lifecycle (`openWindow`/`closeWindow`/launch) behaves; no orphan window, no crash.
- [ ] F-13b: **Appearance presets (#2811) keep working** — apply a preset (e.g. `tokyo-night`) → re-tint; apply a per-token override → re-tint; "Reset to theme defaults" → back to the base; the `override ?? preset ?? base` layer is intact; no theme-cycling / half-render.
- [ ] F-13c: **Token contract intact** — grep the changed launcher files (`LauncherShell/LauncherChrome/LauncherCommandBar/LauncherAppGrid/PixelButler` + any new tick/dot/frame component) for hardcoded hex/`rgba(`/`rgb(` → zero; no `var(--x)NN` alpha-append; hover/tint via `tint('var(--accent-primary)', N)`; Chakra v3 API only.
- [ ] F-13d: **Build + test green** — `pnpm --filter @fredo/ui build` → zero TS errors; `pnpm --filter @fredo/ui test:run` → green (no regressions in existing theming/launcher/`SettingsPanel` tests).

## F-14 (REQ-4/AC4) — LIVE EVIDENCE LEG (required for live policy)

- [ ] F-14: `fredo emit --event-type tool_use ... --session-id e2e-2819-rowtest` + `--event-type chat ... --payload ...` → both `{"queued":true}`; the RTDB ingest classifier maps each to a row (`tool_use_rows` / `chat_rows`); reference `telemetry_spans` as the live span-store proof: `SELECT COUNT(*) ... FROM telemetry_spans` → returns a non-zero count with a recent `max(timestamp)`.
  - **NOTE:** `fredo emit` writes to the RTDB row tables (bypasses the OTLP receiver) — the injected session does NOT appear in `telemetry_spans`; `telemetry_spans` is the live store reference, not a row-equality check (mirrors F-5e/#2817).

## F-15 (REQ-5/AC5) — Light idle reads correctly under the default theme preset

- [ ] F-15: Apply the `light-default` preset (if the product default is not light — see **Discussion QA-4**), then verify the idle desktop renders correctly in LIGHT: the light chrome (notch, avatar, `>` bar, side ticks, dot-grid, clock, rounded frame) reads with adequate contrast, no hardcoded color, no console errors.
  - **Edge:** preset switch dark↔light while idle AND while engaged — all surfaces re-tint token-native, no flicker, no hardcoded color, no console error.
  - **Edge (contrast):** the side-ticks/dot-grid/rounded frame remain visible (contrast ≥ minimum) on the light body (`#ffffff`).

## F-16 (REQ-1/AC1 + REQ-4/AC4) — `—` minimize control in the idle command bar

- [ ] F-16: The idle command bar shows the wireframe's `—` MINIMIZE control at its right edge (a vertical divider `var(--border-color)` + a `—` dash `var(--text-secondary)`/`fg.muted`, token-native `currentColor`, hover → `accent.default`). Clicking `—` collapses the launcher surface to BARE CHROME (`open=false`: avatar + bar + grid hidden; notch + clock + frame + ticks + dot-grid remain).
  - **Edge (PO decision, triage Discussion QA-7 / UI/UX-1):** the `—` behavior is (a) collapse-to-bare-chrome (Architect binding), (b) ESC-alias → idle, or (c) decorative/no-op-safe. If the PO decides a behavior diverging from the binding, record it and adjust the assertion. No console error; no stuck state; focus lands on the notch after minimize.
  - **Edge (token):** the `—` control's divider + dash use token vars / `currentColor` only — NO hardcoded hex (F-13c grep gate includes the command bar).
