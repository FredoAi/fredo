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
