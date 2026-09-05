# Launcher — Functional

> Live-plan suite for the OS-style launcher shell (issue #2808). Cases map 1:1 to the QA
> Plan in `.opencode/tmp/2808/triage.md` `## QA Expert`. Execute on a **running** Fredo
> desktop app with the spec branch. Mock `fredo emit` events are NOT required — this is a
> pure UI shell; the shell ACs are verified by DOM snapshot + screenshot + keyboard/interaction.
>
> Evidence per case: `tauri_webview_dom_snapshot`, `tauri_webview_screenshot`,
> `tauri_webview_interact`, `tauri_webview_keyboard`, `tauri_read_logs(source="console")`.
>
> **Serving checkout:** `spec/2808 @ bd30b07b` (origin tip). Run environment: dev-env UP,
> MCP driver session `com.fredo.app` (restarted to restore `resolveRef`, G-067).
> **Rounds:** round 1 (28ef8b1c) + round 2 (bd30b07b — ST-6/ST-7 z-order + notch focus fix).

## F-1 — Own shell, no @maomaolabs/core in the launcher chrome (AC1)
- [x] F-1: Grep the launcher chrome source under `apps/ui/src/features/home/components/` for `@maomaolabs/core` and for the `useWindows` import source. **Expected:** zero `@maomaolabs/core` imports in the chrome; the chrome lives under `apps/ui/src`; `useWindows` imports from `shared/window-system/useWindows` (own kernel).
  - **PASS.** Source grep: zero `@maomaolabs/core` in `launcher/` (all 5 files); `useWindows` imported from `shared/window-system/useWindows` (LauncherShell.tsx:5). `DesktopToolbar.tsx` is DELETED (glob returns none). Live: the shell renders our own chrome — `div[role="button"][aria-label="Fredo launcher"]` (notch, text "FREDO"), `<time aria-label="HH:MM, online">` clock, `<svg color="var(--accent-primary)">` avatar (206 `<rect>` pixels), `input[role="searchbox"]` (aria-label "Search or command"), `div#fredo-launcher-grid[role="grid"][aria-label="Apps"]`. Screenshot: `ac3-shell-light.jpeg`.
- [x] F-1 edge: The own-kernel `useWindows` import is ALLOWED (do not flag). `@maomaolabs/core` may remain in unrelated non-launcher files (Issue 4 scope) — do not fail the plan for them.
  - **PASS.** `@maomaolabs/core` still referenced only in non-launcher files (e.g. `main.tsx` style-sheet import, per plan Issue-4 scope); `launcher/` + `Home.tsx` grep clean.

## F-2 — Real SHOWABLE_FEATURES grid (AC2a)
- [x] F-2: Open the launcher; `tauri_webview_dom_snapshot(type="structure")` the grid. **Expected:** the rendered tile set equals `SHOWABLE_FEATURES.map(f => f.name)` (from `apps/ui/src/features/home/components/Home.tsx:22`); every showable feature appears as a tile; non-showable features are absent.
  - **PASS.** Live grid tile `aria-label`s = `["Mission Monitor","Query Viewer","Run CLI","Stepper Probe"]`. Source `SHOWABLE_FEATURES = ALL_FEATURES.filter(f => f.showable)` (Home.tsx:22); showable = mission-monitor, query-viewer, run-cli, stepper-probe (all `readonly showable = true`); non-showable (dev-mode, setup, github-viewer, theming, docs-viewer, browser-preview, model-storage, optimizely, my-workitems, create-workitem, diagram) correctly ABSENT. Grid DOM: `div#fredo-launcher-grid[role="grid"]` with 4 `[role="gridcell"]` tiles. Screenshot: `ac3-shell-light.jpeg`.

## F-3 — Tile select opens the feature through the own kernel (AC2b)
- [x] F-3: Focus the grid, arrow to a tile, press Enter. **Expected:** the feature window opens (WindowFrame + feature title + content appears in the DOM snapshot); it is focused; `useWindows()` gains the entry. The open routes through `onOpenFeature(id, feature)` → own-kernel `openWindow`.
  - **PASS (round 2 — ST-6 fix resolves the round-1 occlusion FAIL).** Keyboard `ArrowRight`→`Enter` opened Query Viewer; `document.elementFromPoint(960,500)` returned `{"desc":"fredo-window__surface","text":"Query Viewer..."}` (NOT the desktop `#lights` canvas). Screenshot `ac2b-query-viewer-visible.jpeg` shows the maximized Query Viewer window fully visible — chrome `header.fredo-window__header` (title "Query Viewer"), feature content (Query input, "Results (0 rows)", "No results"), launcher COLLAPSED. Also opened Mission Monitor (chrome title "Sessions") from the grid — `elementFromPoint` → `fredo-window__surface` (topWindow "Sessions"), fully visible with its persisted RTDB session list (`mm-session-row` + ReactFlow node). DOM (10:01:22): `div.fredo-window__surface` + `header.fredo-window__header` + content. **Round-1 history (resolved):** round 1 FAILed AC2b because the window painted BEHIND the desktop (`WindowManager.tsx:25` `z-index:auto` vs `DesktopBackground` `z-index:0` + later DOM). **Fix:** `WindowManager.tsx:25` now `zIndex={1}` + `bg="transparent"` (ST-6) — window stack paints ABOVE the desktop (0), BELOW the HUD (10). Console clean. Telemetry ref (`telemetry_spans`): `fredo.llm` CLIENT / `fredo.tool.*` INTERNAL rows live; Mission Monitor surfaced its persisted session rows.
- [x] F-3 edge: Opening an already-open tile re-focuses (no duplicate) per `windowStore.ts:68-91`; multi-window features get a suffixed id.
  - **PASS (round 2 — was UNVERIFIED round 1, now verified after ST-6).** Re-open de-dupe: with Query Viewer open, Arrow→ + Enter on the Query Viewer tile → `openWindows` stayed **1** (no duplicate), launcher COLLAPSED, window re-focused (title "Query Viewer"). Multi-window stack: opened Mission Monitor as a 2nd window → `openWindows: 2` (Query Viewer + Sessions/Mission Monitor), topmost at `elementFromPoint(960,500)` = `fredo-window__surface` (Sessions). Scoped DOM (10:07:17) shows both `.fredo-window__surface` surfaces with full content (Query Viewer content; Sessions `.mm-session-row` + ReactFlow `rf__node-agent-e2e-r3-render-b_1`). Launcher collapsed on ALL 3 open paths.

## F-4 — Structural match to desktop.png (AC3)
- [x] F-4: Open the launcher; capture a screenshot; compare to `.opencode/wireframes/desktop.png` in light and dark. **Expected:** FREDO header notch, pixel-butler avatar, `>` search-or-command bar, app grid, keyboard-nav hints, online clock, selected-tile cyan border, scrollbar — all present and positioned per the wireframe.
  - **PASS (dark state — the only shipped surface).** The shell renders every wireframe element: FREDO notch (top-center), pixel-butler avatar (below notch, accent token), `>` search-or-command bar, `| APPS` grid, keyboard hints (`↑↓ NAVIGATE`, `←→ SELECT` bottom-left, `ESC CLOSE` bottom-right), online clock (`HH:MM ONLINE •`, top-right), selected-tile accent border, scrollbar (`overflowY:auto`, var-based webkit-scrollbar). Verified in both shipped base themes (turbo `ac3-shell-light.jpeg`, classic `launcher-open-classic.jpeg`). **Documented-partial (PO-scope, G-050):** the product exposes NO light theme — `themes` (`apps/ui/src/app/types/theme.ts`) defines only `turbo` and `classic`, BOTH dark (`bodyBg: rgb(17,17,17)` / `rgb(17,24,39)`); the wireframe's "light" state is not reachable in the product, so the light leg is dropped/PO-amended. **Note on "cyan border":** the selected-tile border uses the theme accent token (`--accent-primary` = `#ae53ba` turbo / `rgb(147,51,234)` classic), NOT the wireframe's cyan `#00B1D1` — this is the correct token-first behavior (AC5 forbids hardcoding cyan); the wireframe's cyan is directional only.

## F-5 — Empty SHOWABLE_FEATURES (AC4)
- [x] F-5: Force `SHOWABLE_FEATURES` empty (dev stub / empty registry). Open the launcher. **Expected:** no crash; shell renders a graceful empty state (notch + avatar + command bar intact); grid shows an empty-state message or no tiles; console has no `Error:`/`Uncaught`/`Maximum update depth exceeded`.
  - **PASS (via faithful equivalent path).** The tester sandbox DENIES Edit/Write on source files (`apps/ui/src/**`), so the temporary `SHOWABLE_FEATURES = []` stub in `Home.tsx` could NOT be applied directly (tool-access gap). Instead the empty-grid code path was exercised by typing a non-matching query (`zzzz`) in the command bar, which drives `filteredEntries` to `[]` → the IDENTICAL code branch as an empty `SHOWABLE_FEATURES`: `entryCount = filteredEntries.length = 0`, `LauncherAppGrid entries=[]` renders `entries.length === 0` → `role="status"` empty state; `handleKeyDown` returns early (`if (entryCount === 0) return`). Live result: `role="status"` text "No apps available", 0 grid tiles, notch+avatar+command-bar intact, console shows NO `Error:`/`Uncaught`/`Maximum update depth exceeded` (only the pre-existing `motion() is deprecated` WARN). Screenshot: `ac4-empty-grid.jpeg`. **Recorded rationale (G-075/G-053):** the query-filter-to-zero path exercises the identical empty-grid render + keyboard-no-op code as the literal empty feature set; a literal empty-`SHOWABLE_FEATURES` stub requires a source edit that the tester sandbox forbids (needs the developer/SI to apply+revert, or a PO-authorized test toggle).
- [x] F-5 edge: Keyboard-nav (arrows) + Enter on the empty grid opens nothing; `useWindows()` gains no entry.
  - **PASS.** With the grid empty (entryCount=0), `ArrowDown`, `ArrowRight`, then `Enter` on the focused command bar: the launcher stayed open, ZERO `.fredo-window__surface` opened (`openWindows: 0`), and the nav hints (`NAVIGATE`/`SELECT`/`CLOSE`) were correctly HIDDEN (`showNavHints = entryCount > 0 && open !== false` = false). `useWindows()` gained no entry.

## F-6 — Theming token-native (AC5)
- [x] F-6: Grep the launcher chrome + styles for hardcoded hex/`rgba(`/`rgb(`. **Expected:** zero hardcoded color literals (documented exemptions allowed); colors via `var(--...)` theme tokens; hover via `tint('var(--accent-primary)', N)`; light + dark both render acceptably; no alpha-append onto `var()`.
  - **PASS (dark — both shipped themes).** Source grep over `launcher/` for `#[0-9a-fA-F]{3,8}\b` / `rgba?\(` → ZERO hardcoded color literals (the 3 regex matches were the issue-number refs `#2808`/`#2807` in comments, not colors). All colors are theme var refs (`var(--card-bg)`, `var(--border-color)`, `var(--accent-primary)`, `var(--header-bg)`, `var(--card-hover-bg)`, `var(--text-primary)`, `var(--text-secondary)`, `var(--body-bg)`) or Chakra semantic tokens (`accent.default`, `fg.default`, `fg.muted`). Hover uses `tint('var(--accent-primary)', 14)`, selected `tint('var(--accent-primary)', 22)`, overlay dim `tint('var(--body-bg)', 55)` (shared `tint()` helper). Pixel-butler avatar uses `fill="currentColor"` + `color="var(--accent-primary)"` (NO hex). No `var(--x)NN` alpha-append anywhere. Live re-theme verified: switching `turbo`→`classic` re-colored the avatar + selected-tile border from `#ae53ba` to `rgb(147,51,234)` (token-native). **Documented-partial (PO-scope, G-050):** the "light" state is not shipped (both base themes are dark), so the light/dark leg is dropped/PO-amended.

## #2819 extension — idle/engaged launcher match (desktop-light.png)

> Issue #2819: the launcher's idle surface becomes an always-visible desktop (notch +
> persistent avatar + `>` command bar + side ticks + dot-grid + rounded frame), and the
> app grid is revealed by focusing the command bar OR when a query is present (the
> ENGAGED state) rather than only by a notch-click. Map 1:1 to `.opencode/tmp/2819/triage.md`
> `## QA Expert` (REQ-1..REQ-5). **NOTE:** prior F-1..F-6 exercised the notch-click-open
> launchpad; the #2819 idle render is asserted by desktop-shell F-6/F-7, the engaged
> reveal by these launcher cases.

## F-7 (REQ-2/AC2) — Focus reveals grid + hints (no notch click)

- [ ] F-7: Focusing the `input[role="searchbox"]` (click or Tab) reveals `#fredo-launcher-grid` with the `SHOWABLE_FEATURES` tile set BELOW the bar + the keyboard-hints row (↑↓ NAVIGATE · ←→ SELECT · ESC CLOSE). `tauri_webview_dom_snapshot(type="structure")` shows the grid + hints while the bar is focused.
  - **Edge:** click-focus and Tab-focus both reveal; the prior notch-click open path (if retained) still yields the engaged grid.
  - **Edge (blur/no-query):** blur to a target OUTSIDE the launcher surface (a `:focus-within` guard on the launcher root) with an EMPTY query → return to idle (resolved **Discussion QA-1**); a focus hop INTO a grid tile stays engaged (no tile-click race — do NOT use a raw input `onBlur` that collapses before the tile `onSelect` runs).

## F-8 (REQ-2/AC2) — Query reveals grid + hints; empty-match empty state

- [ ] F-8: With a query present, the grid + hints are revealed; typing filters `filteredEntries`; a query matching no feature (`zzzz`) shows `role="status"` "No apps available" with NO keyboard hints. Clearing the query hides the grid back to idle.
  - **Edge:** type-ahead highlight on a matched tile; arrows move selection; empty-grid keyboard nav + Enter are no-ops.

## F-9 (REQ-2/AC2) — ESC idles; tile opens the window

- [ ] F-9a: Pressing `ESC` hides the grid + hints (`engaged=false`) while the surface STAYS (`open` stays `true`) — returning the desktop to the IDLE chrome (notch + avatar + bar + ticks + dot-grid + clock + rounded frame only), restoring focus to the COMMAND-BAR searchbox, NOT the notch (the idle affordance — DIFFERS from the #2808 ST-7 pattern which restored focus to the notch on a shell close).
- [ ] F-9b: Selecting a tile (click or Enter) opens the feature window via the own-kernel opener (`Home.tsx:82 openFeatureWindow`); the window surface + header appear, it is focused/maximized, and the launcher COLLAPSES to BARE CHROME (`open=false`: avatar + bar + grid hidden; notch + clock + frame + ticks + dot-grid remain) so the window is not occluded (Architect frozen contract, triage line 388). After window-close, the notch toggle re-shows the idle surface.
  - **Edge:** re-open same tile (no duplicate); open a 2nd window (z-order, topmost surface); empty-grid Enter is a no-op.

## F-10 (REQ-3/AC3) — Visual fidelity gate (side-by-side vs desktop-light.png)

- [x] F-10: Side-by-side screenshot comparison of the idle light render against `desktop-light.png`, attached to evidence, with every deviation called out (element present/absent, position, size, color, accent, font). **Asset path (Read, never glob):** `.opencode/` is a dot-prefixed dir — `glob`/ripgrep silently skip it; the Tester MUST `Read .opencode/wireframes/desktop-light.png` by EXPLICIT absolute path (resolved Discussion QA-2). The engaged-dark compare is `.opencode/wireframes/desktop-light-dark-theme-compare.png`. Hint labels must match the wireframe char-for-char (`↑↓ NAVIGATE` / `←→ SELECT` / `ESC CLOSE` — retain the LeftRight glyph, do NOT use the brief's `↵ SELECT`). If a tester checkout/CI lacks the assets (git-tracking unverified), mark FAIL (PO-amended deferral) — do NOT silently drop the gate.
  - **FAIL (#2819 round 1 — mirrors desktop-shell F-12).** Unmapped idle-light deviations: vertical placement (avatar/bar at ~8%/12% H vs wireframe ~37%/50% H), avatar size (32×32 vs wireframe ~119px / spec ~48px), avatar→bar gap (24px vs ~40px). Glyph checkpoint PASSES (LeftRight arrows). Engaged composition matches (authorized Fredo tile set).
