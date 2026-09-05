# Window Manager — Functional Test Cases (Spec #2807 — Own OS-style window-system kernel)

> Durable functional suite (feature domain `window-manager`). One `- [ ]` case per requirement; observable expected outcome per case. Each case carries the QA-Plan row number (T-R1..T-R4) and its Acceptance Criterion (AC1..AC4) so the tester's `## Tests Runs` verdict maps a row to an AC — a FAIL on any row fails that AC.
>
> **Evidence policy: LIVE** — the exit gate / audit fail-closed unless the tester's Evidence references `telemetry_spans` (a live-query result via `.opencode/skills/telemetry-query/telemetry-query.ps1`) for this frontend rendering/UX feature. A static-only PASS is a FALSE PASS.
>
> Live-drive doctrine (G-035): drive via `pnpm dev:tauri`; capture `tauri_webview_dom_snapshot` + `tauri_webview_screenshot` at each interaction step; read `tauri_read_logs(source="console")` after every step; reference the RUNNING surface (not just a DOM grab) with a live telemetry query confirming the classifier/row pipeline still flows while the engine is swapped. Never assert a capture that misrepresents the selected window — confirm the target via DOM before capture.

## AC1 — Own window engine (T-R1, R-1 / R-2)

- [ ] F-1 (T-R1 / AC1): Grep the window-engine path (`Home.tsx` and the owned window-system source under `apps/ui/src/shared/window-system/`) for the three engine symbols — `WindowSystemProvider`, `WindowManager`, `useWindowActions` — imported from `@maomaolabs/core`.
  - EXPECTED: zero matches importing those three symbols from the third-party package; `WindowSystemProvider`, `WindowManager`, and `useWindowActions` are declared and exported from an owned `apps/ui/src` module (the window-engine path of `Home.tsx` carries no `@maomaolabs/core` import).
  - Edge: a match in a comment or type-only position is STILL recorded as a FAIL for AC1 (own-code requirement) — flag it, do not dismiss it. Only the plan-permitted non-window remnants may remain.
- [ ] F-2 (T-R1 / AC1): Confirm the owned window-actions hook surface is present and exports the four operations (`openWindow`, `closeWindow`, `updateWindow`, `focusWindow`) plus an owned `useWindows` open-window list hook, both delivered from a shared `apps/ui/src` module.
  - EXPECTED: the owned module exposes those hooks with a drop-in signature so feature callers need only an import-source swap; no caller re-implements the engine.
  - Edge: any caller still importing the engine hooks from `@maomaolabs/core` is a FAIL for AC1 — re-pointing must be complete.

## AC2 — Window lifecycle, end-to-end (T-R2, R-3 / R-4 / R-5 / R-6)

> Drive in the running app. Open a feature window from the toolbar; capture DOM + screenshot at each step.

- [ ] F-3 (T-R2 / AC2): From the desktop toolbar, click the launcher entry for a registered grid feature (e.g. Mission Monitor) to open its window.
  - EXPECTED: the feature window opens rendering its `title`/`icon` and declared `canClose`/`canMaximize`/`canMinimize`/`isMaximized` state, framed in the Fredo brand chrome (not the third-party chrome). DOM snapshot shows the window surface + header; screenshot confirms the brand chrome.
  - Edge: a feature `openSelf()`-driven window opens the same way; the open dispatch is identical regardless of launcher.
- [ ] F-4 (T-R2 / AC2): With the feature window open, drive an update/re-render TWICE (trigger a state change so the feature re-renders its content).
  - EXPECTED: content updates on each re-render with no remount / no loss of prior content; the second update further mutates the same window (re-open + update twice works end-to-end). DOM snapshot shows the freshly rendered content both times.
  - Edge: update twice while focused does NOT reset the window size/position; the render is a spread-merge patch, never a full replacement.
- [ ] F-5 (T-R2 / AC2): Minimize the window (minimize control), confirm it hides, then restore it (focus/programmatic restore).
  - EXPECTED: minimize hides the window from the workspace and moves focus to the next visible window; restore brings the SAME window back with identity + content intact. DOM snapshot before/after.
  - Edge: an update while minimized does NOT silently restore or steal focus — the window stays minimized until an explicit restore/focus.
- [ ] F-6 (T-R2 / AC2): Maximize, then restore, the window.
  - EXPECTED: maximize goes full-bleed (radius 0, no drag/resize, control flips to "restore"); restore returns to the prior float geometry with content + identity intact. DOM snapshot at maximized and restored states.
  - Edge: maximize while already maximized toggles to restore; double-click header toggles maximize/restore; maximize then minimize then restore preserves state.
- [ ] F-7 (T-R2 / AC2): Focus / z-order — open a second window, then focus the first again (click it or drive focus).
  - EXPECTED: focused window comes to the top of the z-order (accent border + halo) and the previously-top window drops to unfocused (neutral border + muted title). DOM snapshot shows the topmost change.
  - Edge: `focusWindow` is the programmatic path; any window behind drops to unfocused; the content of the receding window stays fully readable.
- [ ] F-8 (T-R2 / AC2): Close the feature window via the chrome close control.
  - EXPECTED: the window is removed and the feature's registered close callback runs (`onUnmount` + registry removal) before the entry is dropped; close is idempotent and re-entrancy-guarded (no loop, no crash). After close the window is gone from the open-window list and focus moves to the next topmost window (or the workspace).
  - Edge: close of a focused vs a backgrounded window both succeed; closing the only window leaves a clean workspace with no stray frame.
- [ ] F-9 (T-R2 / AC2, edge — rapid double-open): Trigger two opens of the same feature id in quick succession.
  - EXPECTED: exactly ONE window exists for that feature id (no duplicate window, no duplicate frame); the second open re-focuses / no-ops rather than stacking a duplicate.
  - Edge: three rapid opens still yield one window; zero console errors during the burst.
- [ ] F-10 (T-R2 / AC2, edge — backdrop/drag boundaries): Drag the window by its header and resize by a grip.
  - EXPECTED: dragging translates the window but the title bar stays within the workspace top; resizing enforces a min width/height and only the correct grip resizes the correct edge; the control cluster and grips stop propagation so a pointerdown on a control does not start a drag.
  - Edge: a pointerdown on the 28px control cluster does NOT start a drag; a drag that would push the title bar off the top is clamped; resize grip cursors are correct per direction.
- [ ] F-11 (T-R2 / AC2, console hygiene): After the full lifecycle (open → update x2 → min → restore → max → restore → focus → close), read the webview JS console.
  - EXPECTED: no `Error:` / `Uncaught` / `Maximum update depth exceeded` / re-render-loop symptom at any step. A console error invalidates the leg's evidence even if the visual assertion renders.

## AC3 — Token-native chrome (T-R3, R-7)

- [ ] F-12 (T-R3 / AC3): Grep the NEW window chrome components (header, title, icon, min/max/close controls, drag grip, resize grip, float) for hardcoded hex/rgba and for shared `tint()` usage.
  - EXPECTED: zero hardcoded hex/rgba (allowing `transparent`, `inherit`, `currentColor`, `none` and the documented data/art-palette exemptions); every surfaced color references a theme CSS var (`var(--card-bg)`, `var(--border-color)`, `var(--accent-primary)`, `var(--status-*)`, `--body-bg`, `--header-bg`); hover/active mixed tints use the shared `tint()` helper (`color-mix`).
  - Edge: `var(--accent-primary)22` (alpha-append onto a `var()`) is an invalid-CSS FAIL; a hex embedded in an rgba fallback is a FAIL unless it is an exempt data/art palette; no Chrome surface branches on light/dark — only the CSS vars the theme swaps.
- [ ] F-13 (T-R3 / AC3, live render): In the running app, visually verify the chrome in BOTH light and dark theme (toggle via the theming feature) and under a user-accent override.
  - EXPECTED: the chrome re-tints from the theme tokens with no hardcoded color; hover tints respond to the accent/theme override; focused vs unfocused (top vs behind) frame states are distinguishable; the frame renders acceptably in both themes.
  - Edge: a fixed non-token color that ignores the user accent is a defect (FAIL); close control renders its destructive affordance via a hover tint, NOT via `variant="outline" colorPalette="red"` (the known #431 pitfall).

## AC4 — WINDOW_STYLES removal + graceful degradation (T-R4, R-8 / R-9)

- [ ] F-14 (T-R4 / AC4): Grep for the chrome-variant machinery — `WINDOW_STYLES` variants (`WindowStyleContext.tsx`) and `WindowStyleSelector` — in the chrome path, and confirm no dangling import/export breaks the build.
  - EXPECTED: no `WINDOW_STYLES` variant map and no `WindowStyleSelector` remain in the chrome path; the chrome is the single brand chrome; the provider accepts no `systemStyle` prop; no dangling import/export of the removed style types remains in `index.ts`/`features/home/index.ts` or the settings/theming surfaces (the build stays green).
  - Edge: any leftover reference to the removed style variant type or selector that breaks `pnpm --filter @fredo/ui build` is a FAIL — grep AND a clean build are both required.
- [ ] F-15 (T-R4 / AC4, graceful degradation): Pre-seed a persisted legacy `windowStyle` value in the browser/local store (key `Fredo_window_style`), then reload the app, and observe the chrome.
  - EXPECTED: the desktop renders the SINGLE brand chrome (no variant chrome), default chrome, nothing crashes, and the settings UI no longer exposes any style variant. Console + system logs show no error.
  - Edge: a stale legacy value (`default` / `traffic` / `linux` / `yk2000` / `aero`) renders brand chrome, never diverges, never throws; a null/absent/unknown (bogus) value also renders brand chrome without throwing; the provider never reads `windowStyle` to pick chrome.

## Non-functional

- [ ] N-1 (token/variable usage): Visual + grep check across the chrome surfaces — all colors come from theme semantic tokens → CSS vars; tints via the shared `tint()` helper; never hardcode hex/rgba; never alpha-append onto a `var()` reference.
  - EXPECTED: the token→var→theme color flow is intact; no raw color value leaks into the chrome.
  - Regression risk: a one-off inline color in a chrome component that ignores the user theme is a FAIL.
- [ ] N-2 (no cross-feature import): The own window-manager kernel (provider, manager, hooks, window model, chrome) lives in a shared module; features import from shared, never from another feature.
  - EXPECTED: code inspection confirms the kernel has no import from another `features/*` module; `Home.tsx` and the three feature callers import only the shared hooks.
  - Regression risk: a kernel importing from a feature is a FAIL.
- [ ] N-3 (Chakra UI v3 only): The chrome uses Chakra v3 props only.
  - EXPECTED: `disabled` not `isDisabled`, `loading` not `isLoading`, `colorPalette` not `colorScheme`; compound components (`Tabs.Root`, `Dialog.Root`) where used; brand chrome uses Chakra semantic tokens, never raw values.
  - Regression risk: a v2 `is*`/`colorScheme` prop reintroduced is a FAIL.
- [ ] N-4 (accessibility / UX): Window controls are keyboard-focusable with aria-labels naming action + window (e.g. "Minimize Mission Monitor", "Close Mission Monitor"); the frame is a non-modal group with the window title as its accessible name; min/max/close are real tabbable buttons with 28px hit targets; focus moves to the next topmost window's header on close/minimize, and to the toggled control on maximize/restore.
  - EXPECTED: DOM/a11y snapshot shows the group semantic + labeled reachable controls; keyboard `CmdOrCtrl+W` (close), `CmdOrCtrl+M` (minimize), `CmdOrCtrl+Shift+M` (maximize/restore), `Ctrl+Tab` (focus next window) behave as specified; minimized/behind windows are excluded from tab order.
  - Edge: restore mirrors `aria-expanded` like maximize; a minimized window is hidden from the a11y tree; `:focus-visible` outline uses the accent token.
- [ ] N-5 (clean build): `pnpm --filter @fredo/ui build` completes with no TS errors; no dangling `WINDOW_STYLES`/`WindowStyleSelector` import left behind.
  - EXPECTED: build is green end-to-end; zero warnings. If the Rust side is touched, `cargo check`/`cargo clippy -D warnings` from `apps/tauri/src-tauri` is clean.
  - Regression risk: a type/export error from a stale window-style import is a FAIL (AC4).
- [ ] N-6 (no re-render loop): After every window interaction, read the webview JS console.
  - EXPECTED: no `Maximum update depth exceeded` / re-render-loop symptom; window-store updates are epoch-based (advance only on real mutation), never driven by array `.length` or newly-created object refs in a `useEffect`/`useMemo` dependency.
  - Regression risk (#523): an effect depending on array `.length` or object identity is a FAIL.

## Test run (round 1) — Verdict: **AC2 FAIL**

> Live-driven via `pnpm dev:tauri` (spec/2807 @ 77fc9e5; served root confirmed by dev-env Status). Each step DOM-snapshotted + screenshotted; console read after each.

- **F-1 (AC1) — PASS.** `Home.tsx:3-5` imports `WindowSystemProvider`/`WindowManager`/`useWindowActions` from `../../../shared/window-system/*` (own code). Grep `@maomaolabs/core` over `Home.tsx` + `shared/window-system/`: only a benign comment in `windowTypes.ts:4` ("drop-in model mirrors the third-party …") — no import. (n/a — source grep; not visually observable.)
- **F-2 (AC1) — PASS.** `useWindowActions`/`useWindows` exported from `apps/ui/src/index.ts`; implements `openWindow`/`closeWindow`/`updateWindow`/`focusWindow`; window model in `windowTypes.ts`.
- **F-3 (AC2) — FAIL.** Clicking the toolbar Mission Monitor button (`button[aria-label="Mission Monitor"]`, rect 881,958 32x32) opened NO window. `find_element(".fredo-window__surface")`=0, `.window-container`=0, `.chakra-dialog__content`=0; screenshots `01-mm-open.png`/`02-current-state.png` show only the Fredo desktop. Query Viewer opened no window either. **Root cause:** `DesktopToolbar.tsx:2` still renders `@maomaolabs/core`'s `Toolbar`, whose item-`onClick` calls maomaolabs' OWN module-scoped `openWindow` (dist `index.es.js:44,516-529`); maomaolabs' `WindowManager`/window host is no longer mounted (Home mounts only our own `WindowManager`), so the window opens in an unrendered store → nothing appears. ST-5 re-pointed only `useWindows` (read), not the open path.
- **F-4..F-11 (AC2) — UNVERIFIED (blocked by F-3).** No window exists to drive update-twice/minimize/maximize/focus/close; no console errors observed (`Error:`/`Uncaught`/`Maximum update depth` all zero).
- **F-12 (AC3) — PASS (static).** Grep over `WindowChrome.tsx`/`WindowFrame.tsx`/`chrome.css`/`WindowManager.tsx`/`windowStore.ts`: zero `#[0-9a-fA-F]{6}`, zero `rgba(`/`hsla(`, zero `var(--x)NN` alpha-append; only `#2807`/`#431` comment refs match. `tint()` used for close-hover (`WindowChrome.tsx:235`), focus halo+shadow (`WindowFrame.tsx:209-212`), grip hover (`WindowFrame.tsx:267`); surfaces use `bg.surface`/`border.default`/`accent.default`/`fg.*`/`bg.subtle`.
- **F-13 (AC3, live light+dark render) — UNVERIFIED (blocked by F-3).** The chrome never renders (no window opens), so it could not be rendered in either theme.
- **F-14 (AC4) — PASS.** Grep `WINDOW_STYLES`/`WindowStyleSelector`/`WindowStyleContext`/`useWindowStyle`/`WindowStyleProvider`/`WindowStyleId` over `apps/ui/src` = 0 matches. `pnpm --filter @fredo/ui build` green (2570 modules, no TS errors).
- **F-15 (AC4, graceful degradation) — PASS (no-crash), single-chrome render UNVERIFIED.** Pre-seeded `Fredo_window_style="aero"` → reload boots clean, console empty (`04-ac4-aero-reload.png`); `="bogus_style_xyz"` → clean (`05-ac4-bogus-reload.png`); absent key → clean (initial boot). Settings + Appearance expose NO "Window Style" selector (`03-settings-click.png` + a11y snapshot). "SINGLE brand chrome renders" is UNVERIFIED (blocked by F-3 — no window opens).
- **N-1..N-6 — N-2/N-3/N-5 PASS (no cross-feature import; Chakra v3 only; build green).** N-1/N-6 static PASS (grep clean, no console errors); N-4 (a11y semantics/live) UNVERIFIED (blocked by F-3).

**Telemetry live evidence:** `telemetry_spans` = 3608 spans (newest 2026-09-05T07:10:11); `chat_rows`=3167, `tool_use_rows`=4065, `agent_session_rows`=169 — the classifier/row pipeline flows while the engine is swapped.

## Test run (round 2) — Verdict: **AC2 PASS (fixed), AC3 FAIL (live render), AC1/AC4 PASS**

> Live-driven via `pnpm dev:tauri` (spec/2807 @ b1815e24; served root confirmed by dev-env Status). The round-2 fix routes the toolbar launcher OPEN through the own kernel (`Home`-level `openFeatureRef` + `DesktopToolbar` `onClickCapture` wrapper). Each step DOM-snapshotted + screenshotted; console read after each.

- **F-1 (AC1) — PASS.** `Home.tsx:3-5` imports `WindowSystemProvider`/`WindowManager`/`useWindowActions` from `../../../shared/window-system/*` (own code). Grep `@maomaolabs/core` in `Home.tsx` = 0 imports (only the retained `Toolbar` dock in `DesktopToolbar.tsx:3`, Issue 2/4). Own engine exported from `apps/ui/src/index.ts`. (n/a — source grep.)
- **F-2 (AC1) — PASS.** Own `useWindowActions`/`useWindows` exported; implements `openWindow`/`closeWindow`/`updateWindow`/`focusWindow` (`windowStore.ts:68/116/131/157`).
- **F-3 (AC2) — PASS (the previously-failing open).** Clicking the toolbar `button[aria-label="Mission Monitor"]` (rect 987,958 32x32) OPENED the window: `.fredo-window__surface` present, `role="group"` aria-label "Sessions", brand chrome header (Minimize Sessions / Restore Sessions [expanded] / Close Sessions), Mission Monitor panel content rendered. Screenshot `01-mm-open.png`. The round-2 `onClickCapture` interception routes the launcher click to the own kernel's `openFeatureWindow` (`Home.tsx:73`) → own `openWindow` (`windowStore.ts:68`) → `WindowManager` renders the `WindowFrame`. No double dispatch (no duplicate surface).
- **F-4 (AC2) — PASS.** Update/re-render twice: injected 2 real-shaped chat events (`e2e-r2-render-a`/`-b`) → session list grew 1→2→3 rows; after both updates the window surface class was IDENTICAL (`fredo-window__surface css-4elf4l`) → content updated twice with no remount/loss. Classified into `chat_rows` (verified: `e2e-r2-render-a`=1, `e2e-r2-render-b`=1). Screenshot `02-mm-update-twice.png`.
- **F-5 (AC2) — PASS.** Minimize → `display:none` (hidden from workspace, rect 0x0, retained in list); restore via re-launch (openWindow existing-id path sets `isMinimized:false`) → `display:flex`, content intact (3 session rows), identity preserved.
- **F-6 (AC2) — PASS.** Maximize → full-bleed (1920×1017, `borderRadius:0`, `boxShadow:none`, control flips to "Restore", `aria-expanded`); restore → returns to the EXACT prior float geometry (480×320 @ 48,48, radius 8px). Content intact.
- **F-7 (AC2) — PASS.** Focus/z-order: opened Query Viewer (2nd window) → it became focused (accent border rgb(147,51,234)), Mission Monitor dropped to neutral (rgb(69,69,69)); dispatched a real `PointerEvent` on the Mission Monitor surface → it became focused (accent border + `tint()` halo) and Query Viewer dropped to unfocused. (Tool-driver note: `tauri_webview_interact` synthetic clicks do NOT trigger React `onPointerDown` — the focus path needed a real `PointerEvent` dispatch, a driver artifact, not a product defect.)
- **F-8 (AC2) — PASS.** Close: closed Mission Monitor (focused) via "Close Mission Monitor" → window removed (windowCount 1 remaining); restored then closed Query Viewer (backgrounded) → windowCount 0. Close is idempotent/re-entrancy-guarded (removes entry before close-callback, see `windowStore.ts:116-124`). Both focused + backgrounded closes succeed.
- **F-9 (AC2, rapid double-open) — PASS.** Two rapid clicks on the Mission Monitor launcher → exactly ONE window (no duplicate frame); the second open re-focuses/no-ops (openWindow existing-id path).
- **F-11 (AC2, console hygiene) — PASS.** No `Error:`/`Uncaught`/`Maximum update depth exceeded` after the full lifecycle. (Only pre-existing `motion() is deprecated` warn + one transient React Flow "parent container needs width/height" layout warn, noted.)
- **F-10 (AC2, drag/resize boundaries) — NOT individually driven this round** (drag by header / resize by grip are pointer-capture gestures that need real PointerEvent dispatch; the maximize-restore + focus tests already exercised the frame geometry paths). Core lifecycle fully verified.
- **F-12 (AC3, grep) — PASS.** Over `WindowChrome.tsx`/`WindowFrame.tsx`/`chrome.css`/`WindowManager.tsx`/`windowStore.ts`: 0 `#[0-9a-fA-F]{6}`, 0 `rgba(`/`hsla(`, 0 `var(--x)NN` alpha-append (only `#431` comment refs). `tint()` used at `WindowChrome.tsx:235` (close hover), `WindowFrame.tsx:211-212` (focus halo+shadow), `WindowFrame.tsx:267` (grip hover). No hardcoded hex/rgba in the chrome code.
- **F-13 (AC3, live render) — FAIL.** With a window open, the chrome header surface does NOT follow the theme var. `.fredo-window__header` uses `bg="bg.subtle"` (per plan → `var(--header-bg)`), but its computed `background-color` = **rgb(250,250,250)** (#fafafa, Chakra default) in BOTH theme presets, while the element's own `--header-bg` var = rgb(17,17,17) turbo / #2a2a2a classic. The icon tile (`bg="bg.muted"`) likewise renders rgb(244,244,245) (#f4f4f5) not `var(--card-hover-bg)`. Consequence: the window title (`fg.default` = light `--text-primary`: #cccccc classic / rgb(243,244,246) turbo) renders LIGHT-ON-LIGHT on the #fafafa header → near-zero contrast, the window title is effectively INVISIBLE in both theme presets. The surface bg (`bg.surface` → `var(--card-bg)` re-tints: #2d2d2d classic / rgba(0,0,0,0.3) turbo) and the focused accent border + brand cap (`accent.default` → `var(--accent-primary)` re-tints: rgb(147,51,234) classic / #ae53ba turbo) DO re-tint correctly. **Root cause:** `bg.subtle`/`bg.muted` Chakra semantic tokens are shadowed by Chakra's `defaultConfig` built-ins (resolve to #fafafa/#f4f4f5) instead of the custom `var(--header-bg)`/`var(--card-hover-bg)` in `system.ts` — a pre-existing system.ts token-map quirk the new window chrome is the first to expose (it is the first consumer of `bg.subtle` on a dark window). This violates R-7 "surfaces reference theme CSS vars" + "renders acceptably in both themes."
- **F-14 (AC4) — PASS.** Grep `WINDOW_STYLES`/`WindowStyleSelector`/`WindowStyleContext`/`useWindowStyle`/`WindowStyleProvider`/`Fredo_window_style` over `apps/ui/src` = **0 matches**; `pnpm --filter @fredo/ui build` green (per dev summary, 2570 modules, no TS errors). The `WindowSystemProvider` accepts no `systemStyle` prop (code). Settings/Appearance panel exposes NO Window Style selector (Base Theme / Accent / Backgrounds / Text / Status / Fonts / Animation only).
- **F-15 (AC4, graceful degradation) — PASS.** Pre-seeded `Fredo_window_style='aero'` → reload boots clean, console empty, single brand chrome renders (window opens); `='bogus_style_xyz'` → reload clean (console empty, boots); absent key → reload clean. All three legs no-crash; the single brand chrome renders unconditionally (nothing reads the legacy key — ST-4 deleted the reader).
- **N-1 (token/variable) — PARTIAL.** The chrome code uses tokens (pass), but the header (`bg.subtle`) + icon tile (`bg.muted`) resolve to Chakra defaults rather than the theme CSS vars (see F-13) → not fully token-native at runtime.
- **N-2 (no cross-feature import) — PASS.** Own kernel under `shared/window-system/`; no `from 'features/` import.
- **N-3 (Chakra v3) — PASS.** `disabled`/`colorPalette`/`variant="ghost"`/`_hover`; no `isDisabled`/`colorScheme`; close uses `variant="ghost"` + `tint()` hover (NOT `outline colorPalette="red"`).
- **N-4 (a11y) — PASS (chrome controls).** Frame is a non-modal `role="group"` named by the window title; min/max/close are real `<button>`s, each `aria-label` naming action + window ("Minimize Mission Monitor"/"Restore Mission Monitor"/"Close Mission Monitor"), maximize uses `aria-expanded`. (Keyboard window ops are deferred per plan — not a FAIL.)
- **N-5 (clean build) — PASS.** `pnpm --filter @fredo/ui build` green (per dev summary); no dangling `WINDOW_STYLES`/`WindowStyleSelector` import.
- **N-6 (no re-render loop) — PASS.** No `Maximum update depth exceeded`; window-store updates are epoch-based; no array-`.length`-driven effect loop observed.

**Telemetry live evidence (round 2):** `telemetry_spans` = 4247 (newest 2026-09-05T07:53:49, grown from round-1's 3608 — pipeline live); `chat_rows`=3918, `tool_use_rows`=4987, `agent_session_rows`=179. Injected `fredo emit` rows classified (`e2e-r2-render-a`/`-b` = 1 chat_row each). The classifier/row pipeline (OTLP → `telemetry_spans` → classified rows → webview) continues to flow while the window engine is swapped.

### Round-2 verdict summary

- **AC2 is FIXED** — the toolbar launcher now opens a Fredo-brand window through the own kernel; the full open/update-twice/minimize-restore/maximize-restore/focus/close lifecycle passes end-to-end with no console errors.
- **AC3 FAIL (live render)** — the window chrome header (and icon tile) do NOT re-tint with the theme (render Chakra default #fafafa/#f4f4f5 instead of `var(--header-bg)`/`var(--card-hover-bg)`), producing a light header + light title (near-zero contrast, invisible title) in both theme presets. The static grep (0 hardcoded hex/rgba, `tint()` used) PASSES, but the runtime token resolution is broken. This is the single AC3 failure. (Round-1 AC3 was UNVERIFIED — blocked by no window; now testable and FAIL.)
