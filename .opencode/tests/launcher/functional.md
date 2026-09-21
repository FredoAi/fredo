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

## #2821 extension — launcher-surface defect correction (Main fidelity, avatar, dual LEDs, persistent search)

> Issue #2821 — six human-review defects against the design captures on the shipped launcher.
> These cases cover the launcher-surface defects (bugs 1, 2, 4, 5). The app-drawer defect
> (bug 6) + window-lifecycle regression live in the `window-manager` suite. Map 1:1 to
> `.opencode/tmp/2821/triage.md` `## QA Expert` (REQ-1..REQ-5 / R1..R5).

## F-11 (REQ-1/AC1) — Main visual fidelity gate (side-by-side, fail-closed)

- [ ] F-11: Capture the served Main (light theme) at 100% OS scale; side-by-side + blended overlay / pixel-diff against `.opencode/wireframes/desktop-light.png` and the target `.opencode/wireframes/desktop-light-dark-theme-compare.png`. **Expected:** ZERO unresolved deviations across geometry, spacing, alignment, typography, color, and every control. The two bottom status LEDs are the AC4-mandated REQUIRED additive deviation (list, don't fail); every OTHER deviation must resolve or be dismissed with evidence. A single unresolved deviation ⇒ FAIL.
  - **Edge:** capture BOTH light and dark separately; a provably environment-caused deviation (OS scale, font raster) is recorded as RESOLVED with evidence. Evidence must be from the running `spec/2821` build, never a stale main capture (verification policy is `live`).

## F-12 (REQ-2/AC2) — Avatar matches the 21×21 guide

- [ ] F-12: Grid-overlay the rendered avatar against `.opencode/wireframes/avatar-guide.png` (21×21 base form, 8px pixel). **Expected:** circular brimmed head (rows ~2–14), two vertical rectangular eyes (rows ~8–13, cols ~9–10 & ~13–14), bowtie/body + arm nubs + two-notch vest + two legs (rows ~14–21). The `avatar-current.png` blob (filled solid head, hollow eye-slots, no separate bowtie/legs) must NO LONGER reproduce.
  - **Edge:** verify in both light and dark themes; the form must not scale/clip at other avatar display sizes; no hardcoded color — avatar stays `fill="currentColor"` + `var(--accent-primary)`.

## F-13 (REQ-3/AC3) — Mission Monitor + feature windows follow the active theme/preset

- [ ] F-13: Open Mission Monitor under an active theme/preset; verify no unstyled dark chrome and no hardcoded hex/rgba — colors flow tokens→CSS-var→`tint()`. Cycle the theme/preset live; all open windows re-theme. Compare against `.opencode/wireframes/bugs/mission-monitor-style.png` (the fail state) — must NOT match.
  - **Edge:** run with Mission Monitor + at least one other window open simultaneously; apply a custom accent (if offered) and confirm `tint()` re-colors. Token-hygiene scan rejects `#[0-9a-fA-F]{3,6}`, `rgba(`, `rgb(`, and invalid `var(--x)NN` alpha-appends in changed files.

## F-14 (REQ-4a/REQ-4b/AC4) — Exactly TWO status LEDs at the BOTTOM, none overlapping the clock

- [ ] F-14a: Verify exactly TWO distinct status LED nodes at the BOTTOM of the launcher surface (online + activity), visible, separated, un-clipped.
- [ ] F-14b: Verify NO status LED overlaps the clock / ONLINE readout at top-right. Compare against `.opencode/wireframes/bugs/led-overlay.png` (the single overlapping LED) — must NOT match. Check at reduced/narrow window sizes and against the app drawer open (z-index draw-order).
  - **Edge:** the `LauncherChrome` ONLINE dot at top-right is the labeled readout cluster and STAYS; the two bottom LEDs are the unlabeled live status indicators. Resize concurrently with the drawer open; LEDs stay at bottom, clear of the clock.

## F-15 (REQ-5/AC5) — Persistent search/command access across window open/close

- [ ] F-15: Open a feature window, then close it; verify the search/command bar REMAINS visible. Run ≥3 consecutive open→close cycles; also across minimize/restore. Compare against `.opencode/wireframes/bugs/launcher-disappears.png` (search gone) — must NOT match.
  - **Edge:** "always visible" means present in the resting Main surface and re-revealed on close/minimize — NOT rendered above a maximized feature window (windows open maximized, `Home.tsx:92`). Test with multiple windows open/closed at once; verify the launcher never unmounts.

## #2823 extension — global Ctrl+Space keyboard focus slice

> Issue #2823 — Ctrl+Space opens + focuses the launcher from anywhere. **Keyboard/focus slice
> only** (styling out of scope; verify via `.opencode/tmp/2823/triage.md` `## QA Expert`,
> AC-1..AC-5, mapping to REQ-1..REQ-5 once the Software Architect assigns them).
> **Verification policy: live** — pure frontend keyboard/focus, NO telemetry fixture. Evidence
> via `tauri_webview_keyboard` (Ctrl+Space = press key=" " modifiers=["Control"]),
> `tauri_webview_execute_js` (`document.activeElement`), `tauri_webview_dom_snapshot`, `tauri_webview_screenshot`.

## F-16 (AC-1) — Ctrl+Space opens + focuses the searchbox from any non-text focus

- [ ] F-16a: With the launcher CLOSED (no searchbox focused, no overlay covering; optionally a feature window open), record the pre-open `document.activeElement`, press Ctrl+Space. **Expected:** overlay appears ON TOP and `document.activeElement` is the searchbox `input[role="searchbox"]`.
- [ ] F-16b: Overlay-on-top assertion even when a maximized feature window covers the resting surface — `document.elementFromPoint(windowCenter)` returns a node inside `div[role="dialog"][aria-label="Fredo launcher"]`, NOT the feature-window surface (the resting surface is z'd BELOW the window stack, `LauncherShell.tsx:105-106`; the open must re-raise above it).
- [ ] F-16c: Type a query immediately after open — the grid filters with no extra click/Tab.
- [ ] F-16 edge: Open from any route/screen — body/desktop, from a feature window (Mission Monitor), from the notch button; every path opens + focuses.
- [ ] F-16 edge (toggle): Press Ctrl+Space twice — first opens, second closes (exactly one action per press, no double-open / duplicate overlay); while open with focus in the searchbox, Ctrl+Space still toggle-closes (searchbox excluded from the AC-3 guard).

## F-17 (AC-2) — ESC closes the launcher

- [ ] F-17a: With the launcher open, press ESC; assert the overlay no longer covers content, `document.activeElement` is NO LONGER the searchbox, and the surface returns to its resting state (re-z'd under the window stack — it must NOT unmount; #2821 AC5).
- [ ] F-17 edge: ESC while the launcher is already closed → pure no-op (no crash, `document.activeElement` unchanged).
- [ ] F-17 edge: ESC must close the overlay and NOT co-fire the shell's old idle-collapse branch (`LauncherShell.tsx:224-239`) as a second action (AC4).

## F-18 (AC-3) — Ctrl+Space does NOT fire while typing in a text control

- [ ] F-18a: With the launcher CLOSED, focus a real textarea (a feature window's textarea), type a character, press Ctrl+Space; assert no overlay appears (`document.activeElement` stays the textarea), the pre-typed text is uninterrupted, no launcher `role="dialog"` node is created.
- [ ] F-18 edge: Repeat for `input` (text), `textarea`, and `contenteditable` — Ctrl+Space must NOT fire in any (focus untouched, launcher stays closed).
- [ ] F-18 edge: The keystroke is NOT `preventDefault`ed when suppressed (nothing swallowed for an unintended shortcut).

## F-19 (AC-4) — Only the launcher toggle; no second action / no default

- [ ] F-19a: Press Ctrl+Space and observe EVERY effect — the only action is the launcher toggle; `e.preventDefault()` suppresses the bare-Space page scroll and any IME/autocomplete popup; no console `Error:`/`Uncaught`/`Maximum update depth exceeded`.
- [ ] F-19 edge: Existing global shortcuts unaffected — the Konami-code listener (`useKonamiCode.ts:56`) reacts only to its sequence (Ctrl+Space merely resets it), the `DetailPanel` ESC listeners (`DetailPanel.tsx:202,223`) are ESC-only, and the companion Ctrl-right-click (`FredoCompanion.tsx:193`) is mouse-based (not keydown) — all still work.
- [ ] F-19 edge: Confirm the Ctrl+Space keydown reaches the webview (not swallowed by the OS IME toggle on Windows) — real Windows/WebView2 manual gate; matching uses `e.code === 'Space'` + exact modifiers.

## F-20 (AC-5) — Focus restores to the pre-launch element on close

- [ ] F-20a: Focus a known element (e.g. the notch `div[role="button"][aria-label="Fredo launcher"]` or a feature tile); press Ctrl+Space (opens, focuses searchbox); press ESC; assert `document.activeElement` is the SAME element as before.
- [ ] F-20 edge: Toggle-off close (Ctrl+Space when open) restores to the same pre-open element.
- [ ] F-20 edge (conditional restore): If the user tabbed/clicked OUT before close (focus already left the launcher), focus is NOT yanked back (UI/UX §3) — record this as the AC-5 verdict per the resolved discussion.
- [ ] F-20 edge (degradation): If the pre-open element was unmounted while the launcher was open, focus falls back gracefully (to `body`/a sensible ref) with no crash and no focus-trap in a dead launcher.

## #2824 extension — ESC/close hint keycap padded badge (visual polish)

> Issue #2824 — the launcher's `ESC CLOSE` hint keycap becomes a small, padded, rounded
> badge (not border-touching). Map 1:1 to `.opencode/tmp/2824/triage.md` `## QA Expert`
> (AC1–AC5). **Verification policy: live** — pure chrome/rendering; evidence via
> `tauri_webview_dom_snapshot` + `tauri_webview_screenshot` + `tauri_webview_interact`/
> `tauri_webview_keyboard` + `tauri_read_logs(source="console")`. NO telemetry fixture —
> the ACs are provable only on the running rendered webview. Read the reference image by
> explicit path `C:\Code\fredo\.opencode\wireframes\bugs\esc-close.png` (never glob).

## F-21 (AC1) — Visual fidelity gate: keycap is a small padded rounded badge

- [ ] F-21: Read `C:\Code\fredo\.opencode\wireframes\bugs\esc-close.png` (explicit path), render the launcher ENGAGED (focus the command bar OR enter a query so the bottom `ESC CLOSE` hint is visible) on the `spec/2824` build at 100% OS scale, capture a screenshot, and compare side-by-side. **Expected:** the ESC keycap is a small, padded, rounded badge — `ESC` text inside a rounded-rect with a visible text→border padding gap, NOT touching/overlapping the launcher frame or any border. Any deviation (border-touching glyph, missing padding, missing rounded corners, wrong size) ⇒ FAIL. A `main`/old-build capture is rejected (`live`).
  - **PASS (round 2 — `spec/2824 @ 6dd074b` live).** Live `getBoundingClientRect` on the ESC keycap badge: **33.31 × 17px** (round-1 FAIL measured 75 × 35px). Padding `3px 7px` (the round-2 fix replaced the bare-numeric `px={7}`/`py={3}`, which Chakra v3 resolves as SPACE TOKENS — `space.7`=28px/`space.3`=12px — with the unit string `p="3px 7px"`); `borderRadius 5px`; `border 1px solid var(--text-primary)`; ESC sub-text 17.3×9px inset 7px horizontal / 3px vertical clear of the border. Aspect ratio 1.96 vs reference 2.0. Side-by-side vs the reference wireframe matches (small padded rounded badge, no frame/touch contact, `ESC` text inside a rounded-rect with a clear inset). Edge cases: 100% OS scale, non-empty query drive, `live`-only. **AC1 = PASS.**
  - **Edge:** captured at standard 1920×1080 viewport, 100% OS scale, no webview zoom; driven with a non-empty query (`m`) so the hint row is visible; `live`-only (no main/old-build capture).

## F-22 (AC2) — Close-hint row spacing not cramped/colliding

- [ ] F-22: With the engaged launcher showing `ESC CLOSE`, inspect + screenshot the hint row. **Expected:** an adequate (non-touching) gap between the ESC badge and the `CLOSE` label (~6px+ or per the reference), and the hint row bottom padding keeps the badge clear of the frame — no touching/overlap. The `↑↓ NAVIGATE` / `←→ SELECT` hints do not collide with the ESC badge.
  - **PASS (round 1 — live, spec/2824).** Live measurement (dark base): badge→CLOSE gap = **8px** (≥6px, matches reference gap 8px), badge bottom→frame bottom gap = **8px**, badge right→frame right gap = **55px** — the hint row's 20px bottom padding keeps the badge clear of the 12px-inset frame, nothing touches/overlaps. NAVIGATE (`↑↓`, bottom-left) and SELECT (`←→`) sit in their own left cluster at 20px gaps, far from the pin-right ESC badge — no collision. Narrow-viewport edge (resized to 900×700, confirmed `window.innerWidth=900`): badge right=833 vs frame right=888 (55px clear), badge bottom=680 vs frame bottom=688 (8px clear), gap-to-CLOSE still 8px, no bottom/right clipping, NAVIGATE/SELECT still present bottom-left. Screenshot: `ac2-narrow-900.png`. **AC2 = PASS.**
  - **Edge:** narrow (900×700) viewport confirmed the hint row stays clear of the frame; no adjacent-hint overlap; no bottom/right ESC-badge clipping; NAVIGATE/SELECT unaffected.

## F-23 (AC3) — Theme legibility/contrast under every shipped theme

- [ ] F-23: Render the engaged launcher in BOTH a light surface and the dark base and inspect the ESC badge + `CLOSE` label. **Expected:** keycap + hint legible with sufficient contrast in both. **How to reach each surface (the `ThemePresetSelector` in theming settings):** select a LIGHT preset from the 18 curated `themePresets` (e.g. `light-default` — `--body-bg #ffffff`, `--card-bg #f7f8fa`, `--text-primary #0c1117`, `--border-color #d5dadd`; also `solarized`, `arctic`, `sunset`, `paper`) for the light leg; select `Default / None` (or a dark preset) for the DARK base leg (the stock locked base is `classic` — `--card-bg #2d2d2d`, `--text-primary #cccccc`). Do NOT invent a toggle — use the shipped preset selector (G-050). Low-contrast / washed-out / color-inverted glyph in EITHER leg ⇒ FAIL.
  - **PASS (round 1 — live, spec/2824, both legs via the shipped `ThemePresetSelector`).** **Light leg** (`light-default` preset, selected via `select[aria-label="Theme presets"]` — body vars `--card-bg #f7f8fa`, `--text-primary #0c1117`, `--border-color #d5dadd`): ESC badge border `rgb(12,17,23)` (crisp dark `--text-primary` outline) on `rgb(247,248,250)` card-bg ≈ **13:1**; ESC text `--text-primary`; CLOSE `--text-secondary #5f6b7a` ≈ **5.4:1** — both legible. **Dark leg** (`dark` preset, and the classic base engaged earlier): badge border `rgb(229,231,235)` (bright `--text-primary`) on `rgb(21,26,33)` card-bg ≈ **8.3:1**; CLOSE `rgb(156,163,175)` — legible. No washed-out / color-inverted glyph in either leg. Live re-theme (light preset ↔ dark) confirmed the badge/label re-tint token-native with no flicker/dead color. Screenshots: `ac3-light-engaged.png`, `ac3-dark-engaged.png`. **AC3 = PASS.**
  - **Edge:** both legs verified (light `light-default` AND the dark `dark`/`classic` base) via the shipped preset selector (no invented toggle); live re-theme light↔dark while the hint was visible re-tinted cleanly. `turbo` not attempted (unreachable legacy base, locked to `classic` since #2817 — no entry in `themePresets`). Console clean (no `Error:`/`Uncaught`/`Maximum update depth exceeded`).

## F-24 (AC4) — Token-native colors (static + live)

- [ ] F-24: Grep `apps/ui/src/features/home/components/launcher/**` (and any new keycap component) for `#[0-9a-fA-F]{3,8}`, `rgba(`, `rgb(`. **Expected:** ZERO hardcoded color literals; keycap/hint colors flow theme token → CSS var (`var(--...)`) / `currentColor` / `tint()`; NO `var(--x)NN` alpha-append. Re-theme live (a light preset ↔ the dark base via the themed preset selector) and confirm the keycap re-tints. Any hardcoded literal ⇒ FAIL.
  - **PASS (round 1 — static grep + live re-theme).** Grep of `apps/ui/src/features/home/components/launcher/**` for `#[0-9a-fA-F]{3,8}`/`rgba(`/`rgb(`/`var(--x)NN` returns ZERO hardcoded color literals — all 31 regex hits are comment issue-refs (`#2807`/`#2819`/`#2823`), not colors; `var(--x)NN` alpha-append returns zero matches. The `EscKeycap` badge + `CLOSE` hint read only tokens: border `var(--text-primary)` (fg.default), fill `var(--card-bg)` (bg.surface), ESC text `var(--text-primary)`, CLOSE `var(--text-secondary)` (fg.muted), fonts `var(--font-primary)`; the `↑↓`/`←→` arrow glyphs stay `currentColor` SVGs. Live re-theme (light `light-default` ↔ dark `dark`) re-tinted the badge border from `#0c1117` ↔ `#e5e7eb` and fill from `#f7f8fa` ↔ `#151a21` — token-native (no hardcoded literal, no dead color). **AC4 = PASS.**
  - **Edge:** changed file (`LauncherChrome.tsx`) scanned specifically — the only matches are comment issue-refs; no new semantic token used without a `system.ts` mapping; no `NativeSelect`-style unstyled element (uses `chakra.select`); no Chakra v2 API (`isDisabled`/`colorScheme` — uses v3 `border`/`bg`/`color`).

## F-25 (AC5) — Clean keycap affordance, no regression

- [ ] F-25: With the launcher open showing the close hint, confirm the keycap still reads as a clean keycap affordance — the reference-image check reconfirmed on the fix build. **Expected:** the keycap is a clean, padded, rounded badge (no regression to the old border-touching/cramped look); `↑↓ NAVIGATE` / `←→ SELECT` and ESC functional behavior (out of scope) unchanged.
  - **PASS (round 2 — live, spec/2824 @ 6dd074b).** The keycap renders as a clean, padded, rounded badge (33.31×17px, borderRadius 5px, token colors) — the old border-touching/cramped SVG look is gone. The `↑↓ NAVIGATE` / `←→ SELECT` hints and their arrow glyphs (still `currentColor` SVGs) are unchanged; the frame geometry (12px inset, 12px radius) and the hint-row layout (space-between, pin-right CLOSE) are unchanged. Both edges verified: (1) **fresh launcher reopen** — ESC → idle (grid collapses, only the searchbox remains) → re-focus/query re-engages → badge re-measured 33.31×17, still padded/rounded, border crisp; (2) **theme switch** — light↔dark while engaged re-tints the badge token-native with no re-regression. ESC functional behavior (Escape dismisses to idle) unchanged. **AC5 = PASS.**
  - **Edge:** fresh reopen + theme-switch both re-verified; only ESC keycap/hint styling changed (nav hints, frame geometry, hint-row layout all unchanged).

## #2827 extension — PixelButler avatar matches the 21×21 guide base form (vision-comparison gate)

> Issue #2827 — the PixelButler avatar (`apps/ui/src/features/home/components/launcher/PixelButler.tsx`)
> must match `avatar-guide.png` (21×21 base form, 8px pixel, cyan `#00D1D1`, hollow round-dome head,
> two vertical-bar eyes, small horizontal mouth, compact chunky body) with ZERO remaining deviation.
> **Verification policy: live** — pure-rendering spec, NO telemetry surface, so the live evidence is a
> rendered-webview receipt (`tauri_webview_screenshot` + `upload-evidence` raw URL +
> `tauri_webview_dom_snapshot` structure + `getBoundingClientRect`/computed-style measurement).
> Map 1:1 to `.opencode/tmp/2827/triage.md` `## QA Expert` (F-26..F-30 / AC-1..AC-5).
> **Reference assets (Read by EXPLICIT absolute path, NEVER glob — `.opencode` is dot-prefixed, G-105):**
> - Guide (expected): `C:\Code\fredo\.opencode\wireframes\avatar-guide.png`
> - Prior-bug baseline: `C:\Code\fredo\.opencode\wireframes\bugs\avatar-current.png`
> **Serving checkout:** `spec/2827 @ 0620b736` (origin tip; HEAD = the `add the mouth bar` commit).

## F-26 (AC-1) — Vision comparison performed; every deviation listed

- [x] F-26: Read `C:\Code\fredo\.opencode\wireframes\avatar-guide.png` (the 21×21 base form, 8px pixel, cyan `#00D1D1`) AND `C:\Code\fredo\.opencode\wireframes\bugs\avatar-current.png` (the known-wrong baseline) by explicit absolute path. Then render the avatar in the running `spec/2827` launcher, capture via `tauri_webview_screenshot`, upload via `upload-evidence --base spec/2827 --body-file <draft>`, and Read that rendered screenshot. In the AC-1 evidence text list EVERY deviation (grid geometry, eye/mouth/body pixel pattern, proportions) between the RENDERED avatar and the guide base form.
  - **PASS (live, spec/2827 @ 0620b736).** Both reference PNGs **Read** by explicit absolute path (never glob). The rendered avatar was captured on the running `spec/2827` build: `.opencode/tmp/2827/e2e/avatar-ac1-render.png` + `avatar-ac1-zoom.png` (6×-scaled for a faithful cell comparison) + `avatar-ac1-canonical.png`. The avatar SVG was located in the live DOM (`svg[aria-hidden="true"][viewBox="0 0 21 21"]`) and Read. **Deviations: ZERO** — the rendered avatar matches the guide base form on every observable point: large HOLLOW round-dome head outline (transparent interior, grid shows through), TWO centered vertical-bar eyes (array rows 9-11, cols 7-8 & 12-13 — symmetric about col 10), a small horizontal MOUTH bar centered below the eyes (array row 13, cols 9-11), and a compact chunky body (arm nubs + torso + two short legs, rows 16-19) — "big head, small body", single accent-cyan `#00D1D1` fill throughout. The `avatar-current.png` wrong-state artifacts (smaller/angular head, missing mouth, slender wide-legged body) are NOT reproduced. Evidence text carries an explicit zero-deviation list; the comparison is image-read, not code-inspection-only. `tauri_webview_dom_snapshot` structure of the avatar: 91 `<rect>` cells.
  - **Edge:** capture from the running `spec/2827` build (never a stale main render); both reference PNGs Read by absolute path; Vision gate is image-based (code inspection alone would be a VOID/FAIL per AC-1).

## F-27 (AC-2) — Rendered matches the guide; no remaining deviation

- [x] F-27: Re-read the guide PNG and the F-26 rendered screenshot; confirm the rendered avatar matches the guide's 21×21 base form with ZERO remaining deviations across grid geometry, pixel pattern, and proportions. The F-26 deviation list is the checklist — AC-2 requires it empty.
  - **PASS (live).** Re-read `avatar-guide.png` + the F-26 rendered screenshots; the F-26 deviation list is EMPTY (zero unresolved deviations). The rendered avatar's head outline shape, eye position/size, mouth bar, body/bowtie/legs pattern, and overall "big head, small body" proportions all match the guide base form. The guide cyan `#00D1D1` is illustrative — the shipped accent token renders cyan here too (`rgb(0,209,209)`), so no form/color deviation. The `avatar-current.png` wrong-state artifacts (flat/stepped top, corner "ears", hollow eye-slots, no separate bow-tie/legs) do NOT reproduce. **AC-2 = PASS.**

## F-28 (AC-3) — Base form matches the guide pixel-for-pixel at the 8px scale

- [x] F-28: Cell-for-cell compare the avatar's `BASE_FORM` 21×21 matrix (`PixelButler.tsx`) against the guide base form, then confirm the rendered pixels. The eye/mouth/body pattern must transcribe the guide cell-for-cell (symmetric about the center column; hollow round-dome head; two vertical-bar eyes; small horizontal mouth; bowtie torso + arm nubs + two legs), each cell a uniform crisp square (`shapeRendering="crispEdges"`).
  - **PASS (live + source).** `BASE_FORM` (21 rows × 21 chars) transcribes the guide base form cell-for-cell: hollow round-dome head OUTLINE (row 1 `......#########......` cols 6-14; walls at cols 1 & 19 rows 6-13; bottom arc row 14 cols 6-14) with a TRANSPARENT interior (never a solid fill); TWO vertical-bar eyes at array rows 9-11, cols 7-8 & 12-13 (`.#.....##...##.....#.`) — symmetric about the center column (col 10); a small horizontal MOUTH bar at array row 13, cols 9-11 (`.#.......###.......#.`), centered below the eyes; a compact chunky body (array rows 16-19: arm nubs cols 4 & 16, torso `###`, two short legs cols 7-8 & 12-13). Symmetric about col 10. The live render confirms 91 `<rect>` cells (one per '#' cell), `shapeRendering="crispedges"`, uniform crisp cells (no subpixel blur at the 48px/21-cell render — cells quantize to uniform squares). The `avatar-current.png` wrong artifacts (stepped head + corner "ears" + hollow eye-slots + missing separate bow-tie/legs) do NOT reproduce. **AC-3 = PASS.**

## F-29 (AC-4) — All colors from theme tokens; cyan `#00D1D1` via a token, not a literal

- [x] F-29: Static grep of `apps/ui/src/features/home/components/launcher/PixelButler.tsx` (and `launcher/**`) for `#[0-9a-fA-F]{3,8}`, `rgba(`, `rgb(`, and invalid `var(--x)NN` alpha-appends. Then live re-theme via the shipped `ThemePresetSelector`.
  - **PASS (static grep + live re-theme via the shipped preset selector).** Grep of `apps/ui/src/features/home/components/launcher/**` for 6/8-digit hex `#[0-9a-fA-F]{6}\b` | `#[0-9a-fA-F]{8}\b` | `rgba(` | `rgb(` | `var(--x)NN` alpha-append returns **ZERO** hardcoded color literals (the only loose-hex matches are comment issue-refs like `#2823`). `#00D1D1`/`#00d1d1` is ABSENT as an inline literal anywhere in the launcher source. The component sources color only from `color="var(--accent-primary)"` + `fill="currentColor"` (`PixelButler.tsx:91,98`); the color path is `accent.default` → `var(--accent-primary)` (`apps/ui/src/app/theme/system.ts:47`), defaulted to brand cyan `#00d1d1` in theme data. Live re-theme via the shipped `ThemePresetSelector` (`select[aria-label="Theme presets"]` in the settings modal — Appearance section): (1) **Light Default** preset → avatar `rgb(0,209,209)` cyan on `rgb(255,255,255)` body; (2) **Dark** base → avatar `rgb(0,209,209)` cyan on `rgb(12,17,23)`; (3) **Matrix** preset (supplementary color-changing proof) → avatar re-tinted to `rgb(0,255,65)` green — the avatar color is genuinely driven by the accent token, not a hardcoded cyan. No `var(--x)NN` alpha-append; no new token; token-native in every shipped preset. **AC-4 = PASS.**
  - **Edge:** `#00D1D1` never appears as an inline literal (token value only); re-theming exercised the SHIPPED preset selector (G-050, no invented toggle); Chakra v3 only.

## F-30 (AC-5) — Renders at intended size/proportions; no layout regression

- [x] F-30: Measure the rendered avatar via `getBoundingClientRect`/computed-style in the launcher; confirm size/aspect, the avatar change did not affect other launcher tiles, and check the console.
  - **PASS (live, default + narrow + light + dark).** Avatar `getBoundingClientRect` = **48 × 48 CSS px** at (936, 346) — 1:1 aspect (`aspect 1.000`), `offsetWidth/offsetHeight` = 48, SVG attribute `width="48" height="48"`, `viewBox="0 0 21 21"` (21:21 grid preserved), `shape-rendering=crispedges`, `aria-hidden="true"` (decorative, unchanged). Every `<rect>` is a crisp uniform cell (crispEdges), no subpixel blur/no blended distortion. **Narrow viewport** (resized to 700×900): avatar still 48×48 fully visible (`fullyVisible: true`), NOT clipped/cropped/scaled; the other launcher tiles/chrome (FREDO notch, command bar, dot-grid LED, clock) are unchanged — no layout shift (the avatar is a fixed 48×48 SVG in `Box mb="4"`; only its pixel content changed). **Light + dark (shipped presets):** 48×48 in both (`rgb(0,209,209)` cyan on `#ffffff` light / `#0c1117` dark). Console clean — `tauri_read_logs(source="console")` shows only INFO/DEBUG + the pre-existing `motion() is deprecated` WARN; NO `Error:` / `Uncaught` / `Maximum update depth exceeded`. No animation added, no other avatar variant toggled (base NEUTRAL is the only render), pixel guide PNG NOT modified, no cross-feature import (imports only React). **AC-5 = PASS.**
  - **Edge:** default (1936×1056) + narrow (700×900) widths; light `light-default` + dark `dark` base; grid cells crisp; console clean of the three error signatures.

---

## #2830 extension — single top-right status LED (LauncherChrome online cluster)

> Issue #2830 — consolidate the desktop status LEDs to a SINGLE top-right LED. The top-right
> `ONLINE •` readout cluster in `LauncherChrome.tsx` (the launcher's online clock cluster,
> lines 350-383) is the home of the single LED: the `onlineLabel` Text (line 371) is DROPPED,
> the 6px dot (lines 373-379) is ENLARGED to a 12px dot in a 16px hit target, and a Chakra v3
> `Tooltip` (`placement="bottom"`, `hasArrow`) is added on hover (AC5). The bottom-center
> `StreamStatus` pair is REMOVED (AC2). Map 1:1 to `.opencode/tmp/2830/triage.md` `## QA Expert`
> (REQ-1..REQ-5, AC1..AC8). The canonical per-AC evidence lives in the `desktop-chrome` suite
> **F-6..F-13** — run those here too; these launcher rows add the LauncherChrome-surface-specific
> checks (the LED inside the launcher's online clock cluster, engaged/notch/Ctrl+Space interplay).
>
> **Verification policy: live** — pure-rendering, NO telemetry surface. Evidence via
> `tauri_webview_dom_snapshot` + `tauri_webview_screenshot` + `upload-evidence --base spec/2830`
> raw URL + `getBoundingClientRect`/computed-style. **OVERRIDE:** the #2821 dual-bottom-LED AC is
> SUPERSEDED (bottom LEDs removed). Reference wireframes (`desktop-light.png`,
> `desktop-light-dark-theme-compare.png`) are the PRE-fix baseline — the removed `ONLINE` label +
> enlarged LED are the REQUIRED AC, NOT a fidelity deviation. Read them by EXPLICIT path (never glob).
>
> **Serving checkout:** `spec/2830` on a running Fredo desktop app (MCP driver `com.fredo.app`).

## F-31 (AC1/AC3 launcher-surface) — Launcher's online cluster shows ONE (unlabeled) status LED

- [x] F-31: **PASS (spec/2830 round 1)** — ONE LED trigger in the top-right `<time>` cluster (below `02:49`), `ledCount=1`, no visible `ONLINE`/`OFFLINE` text, clock advances `02:49`→`02:55`. Open the launcher surface (idle OR engaged) so the top-right clock cluster is visible; `tauri_webview_dom_snapshot` the `<time aria-label*="online\|offline">` cluster. **Expected:** EXACTLY ONE status-LED element inside it, below the HH:MM clock text (`mt="6px"`); NO `ONLINE`/`OFFLINE` visible text node; no additional status LEDs elsewhere on the launcher surface. Cross-reference desktop-chrome F-6/F-8 for the canonical AC1/AC3 evidence.
  - **Edge:** (a) idle vs engaged launcher (grid open) — LED present in both; (b) no `ONLINE` text in either state; (c) the clock HH:MM time still renders + advances.

## F-32 (AC5 launcher-surface) — Hover tooltip on the launcher surface; no clip/overlap with the notch or frame

- [x] F-32: **PASS (spec/2830 round 1, online)** — tooltip opened below the LED (`tooltipTop 66 ≥ ledBottom 54`), `hasArrow` (`chakra-tooltip__arrow`), content "Connected / Agent telemetry streaming", `noClip=true` (no top/right clip), does NOT overlap the notch/frame/clock; closes on focus/blur/Escape (no sticky). With the launcher surface shown (idle and engaged), `tauri_webview_interact(action="hover")` the LED trigger; `tauri_webview_dom_snapshot` locates the Chakra tooltip. **Expected:** a Chakra `Tooltip` (`placement="bottom"`, `hasArrow`) opens below the LED with state-driven content; it does NOT overlap the FREDO notch, the frame, or the clock; pointer-leave hides it. Cross-reference desktop-chrome F-10.
  - **Edge:** (a) idle + engaged launcher; (b) open below, never above (no top clip); (c) narrow viewport — no clip.

## F-33 (AC6 launcher-surface) — LED + tooltip re-tint token-native on the launcher surface

- [x] F-33: **PASS (spec/2830 round 1)** — grep of `LauncherChrome.tsx` for `#[0-9a-fA-F]{6,8}`/`rgba(`/`rgb(`/`var(--x)NN` → ZERO true literals; LED `rgb(0,209,209)` accent + `color-mix` halo (`tint('var(--accent-primary)',22)`); re-themed light-default ↔ dark via the shipped `select[aria-label="Theme presets"]` — LED re-tinted token-native, no stale colour; Chakra v3 only. Grep the launcher chrome source (`apps/ui/src/features/home/components/launcher/LauncherChrome.tsx` + any new LED/tooltip component) for `#[0-9a-fA-F]{3,8}`, `rgba(`, `rgb(`, and invalid `var(--x)NN` alpha-append (#2770). **Expected:** ZERO hardcoded color literals (comment issue-refs like `#2821` exempt); LED `var(--accent-primary)`/`var(--status-error)` + halo `tint('var(--accent-primary)', 22)`; tooltip surface `bg.surface`/`fg.default`/`fg.muted`/`border.default` tokens; Chakra v3 only. Re-theme via the shipped `ThemePresetSelector` (light preset ↔ dark base) — the LED + tooltip re-tint cleanly in both. Cross-reference desktop-chrome F-11.
  - **Edge:** re-theme while the tooltip is open does not leave a stale color; no `var(--x)NN` alpha-append.

## F-34 (AC7 launcher-surface) — Notch / Ctrl+Space / grid interaction with the new LED

- [x] F-34: **PASS (spec/2830 round 1)** — launcher notch/engage/ESC-close intact (searchbox focus → grid engaged → ESC collapses → focus returns); opening a feature window still sinks the band below the window stack (chrome z 1200↔0); LED does NOT intercept the notch/grid pointer (band stays `pointer-events:none`, only the LED re-enables auto on its own trigger). After the LED change, confirm the launcher's notch toggle, the #2823 Ctrl+Space open (focuses searchbox, ESC closes, focus restores), the engaged grid reveal, and the keyboard-hints row are unchanged. Opening a feature window still sinks the whole band (clock + LED + frame) below the window stack. Cross-reference the launcher regression R-7+ / desktop-chrome F-12. **#2823 note:** Ctrl+Space synthetic keypress did not land searchbox focus in this round (documented OS/WebView2 IME gate, launcher F-19 edge); #2830 did not touch the Ctrl+Space handler (git diff clean).
  - **Edge:** (a) Ctrl+Space over a maximized window re-raises the launcher; (b) the LED does not intercept the notch or a grid-tile pointer (the LED re-enables `pointerEvents="auto"` on its own trigger only).

## #2837 extension — avatar geometry matches fredo-avatar.html (1014×1264 wireframe; live comparison gate)

> Issue #2837 — the PixelButler avatar renders the #2827 21×21 base form, which is
> geometry-WRONG against the authoritative `.opencode/wireframes/fredo-avatar.html`
> (the avatar-guide.png match is NOT the brand geometry). The avatar must reproduce the
> 1014×1264 pure-HTML rectangle decomposition (center X=507, mirror `newX = 1014 - x - width`).
> **Verification policy: live** — pure-rendering, NO telemetry surface; live evidence =
> rendered-webview receipts (`tauri_webview_screenshot` + `upload-evidence --base spec/2837`
> raw URL + `tauri_webview_dom_snapshot` + `getBoundingClientRect`/computed style).
> **SUPERSEDES the #2827 guide-match expectations (F-26..F-30):** the 21×21 base-form
> geometry is the KNOWN-WRONG baseline; the fredo-avatar.html geometry is the new source of
> truth. F-26..F-30 stay as history — F-35..F-40 below are current. Map 1:1 to
> `.opencode/tmp/2837/triage.md` `## QA Expert` (AC-1..AC-5 + edges).
> **Reference assets (Read by EXPLICIT absolute path, NEVER glob — `.opencode` is dot-prefixed, G-105):**
> - `C:\Code\fredo\.opencode\wireframes\fredo-avatar.html` (authoritative geometry)
> - `C:\Code\fredo\.opencode\wireframes\fredo-avatar.png` (rendered canonical context)
> - `C:\Code\fredo\.opencode\wireframes\avatar-guide.png` (prior guide context)

## F-35 (AC-1) — Comparison gate PERFORMED; every deviation listed

- [ ] F-35: TWO legs. (1) Source/structural: compare the implementation's geometry table (`fredoAvatarGeometry.ts` or equivalent) against the `fredo-avatar.html` rect calls — each wireframe rect transcribed 1:1 into the 1014×1264 viewBox space, mirrored pairs intact, no "fixes". (2) Live/visual: render the avatar on the running `spec/2837` launcher; capture a screenshot + a zoomed capture; Read the three reference assets by EXPLICIT absolute path; compare the rendered avatar against the `fredo-avatar.html` geometry (PNGs as visual context). In the AC-1 evidence list EVERY remaining geometry/proportion deviation (forehead band; head side steps/diagonals; main head walls; lower face; eye size/placement; bow-tie cluster; body fragmentation/arm separation; leg length/width; feet; proportions) AND any extra/absent feature — the #2827 row-13 mouth bar must be GONE (the wireframe has no mouth). The deviation list is about GEOMETRY/PROPORTION, NOT texture (html `.pixel` gradient/`::after` seam/`::before` halo + PNG glow are visual context). A code-inspection-only comparison or a skipped gate ⇒ FAIL.
  - **Edge:** capture from the running `spec/2837` build (never a stale `main` render); comparison is image/geometry-read (mandatory — #2827 passed code review and was still wrong); screenshots go under `.opencode/tmp/2837/e2e/` then `upload-evidence --base spec/2837`; PNG-vs-wireframe conflict → the WIREFRAME governs and the conflict is flagged to the SI (G-109).

## F-36 (AC-2) — Head/face geometry

- [ ] F-36: Verify the rendered head silhouette (live rects/screenshot overlay + the implementation's geometry source normalized into the 1014×1264 space). **Expected:** wide horizontal forehead band across the top ((373,67,268,38) → x 36.8–63.2% W, y 5.3–8.3% H); stepped/diagonal upper-head sides transitioning to long vertical main side walls ((87,317,41,267) + mirror → x 8.6–12.6% / 87.4–91.4% W, y 25.1–46.2% H); stepped lower-head narrowing into a broad continuous lower-face bar ((344,761,326,33) → x 33.9–66.1% W, y 60.2–62.8% H). The head is a stepped OUTLINE RIM with a hollow/transparent interior — the eyes are the only interior content; NO mouth element (the #2827 row-13 mouth bar is deleted — the jaw is the broad lower-face bar). The head must NOT read as a hollow dome with a narrow top, nor as a solid filled dome.
  - **Edge:** verify at the displayed size AND zoomed; every region present with the correct relative size/placement (low-level rect coordinates need not be exact).

## F-37 (AC-3) — Eyes + mirror symmetry

- [ ] F-37: Verify the eye blocks render at the wireframe size/placement — LARGE mirrored blocks (323,453,68,131) + mirror (x 31.9–38.6% / 61.4–68.1% W; 68 wide ≈ 6.7% W; 131 tall ≈ 10.4% H; y 35.8–46.2% H) — NOT narrow slits — and the whole figure is mirror-symmetric about its vertical center axis per the wireframe's mirrored rectangle pairs (head steps/diagonals/walls, eyes, bow-tie wings, arms, legs, feet).
  - **Edge:** measure left/right span equality about the center axis for each MIRRORED pair. Center single rects (forehead band, lower-face bar, center button (492,917,30,32)) are rendered ONCE — not mirrored. The as-authored center-button rect (491,991,31,36) is 0.5 unit OFF-center (true center 491.5) — transcribe as-authored, do NOT "fix" it; symmetry tolerance EXEMPTS it (Architect binding).

## F-38 (AC-4) — Body/limb geometry

- [ ] F-38: Verify the body/limb regions (wireframe y 812–1234). **Expected:** bow-tie cluster under the lower face (wings (427,823,52,69) + mirror + inner shape, y ≈ 64.2–68.7% H); body OPEN/fragmented with visible arm-separation gaps — separate upper-outer-arm / inner-arm / lower-arm clusters + center buttons with gaps — NOT a solid torso; legs SHORT and WIDE (outer (327,1085,34,115) + mirror; inner (460,1097,28,103) + mirror; y ≈ 85.8–94.9% H) with wide bottom feet ((339,1201,119,33) + mirror; 119 wide ≈ 11.7% W; y ≈ 95.0–97.6% H).
  - **Edge:** gaps remain visible at the rendered display size (crispEdges — no anti-alias fill-in); legs short vs head height (wireframe legs 103–115 tall vs head ≈ 727).

## F-39 (AC-5) — Token-native + no regression; light/dark + display-size legs

- [ ] F-39a: Static grep of `PixelButler.tsx` + any new avatar helper under `apps/ui/src/features/home/components/launcher/**` for `#[0-9a-fA-F]{3,8}` / `rgba(` / `rgb(` / `var(--x)NN` → ZERO hardcoded literals (comment issue-refs exempt); the whole figure is a SINGLE accent fill from `color="var(--accent-primary)"` + `currentColor` (or div-mosaic `background: var(--accent-primary)`); any NEW glow token-based (`tint('var(--accent-primary)', N)` / `color-mix` / var-based filter); no new semantic token without a `system.ts` mapping. HUE follows the LIVE accent token — cyan is the accent default of `light-default`/`dark`; the `classic` base resolves purple; do NOT fail on hue when a non-cyan accent is active.
- [ ] F-39b: Live — the avatar renders at the Architect-bound display size (`DISPLAY_WIDTH` ∈ [112, 168], `DISPLAY_HEIGHT = round(W·1264/1014)`, recommended 132×165; NEVER below 112 px wide — the 10-unit bow pixels collapse), undistorted (aspect 1014:1264, viewBox `0 0 1014 1264`), centered above the command bar, no clipping/overflow, in a LIGHT preset (shipped `ThemePresetSelector`, e.g. `light-default`) AND the DARK base.
- [ ] F-39c: Live — narrow viewport (e.g. 700×900) + re-theme while visible (light ↔ dark ↔ classic); console clean (`tauri_read_logs` — no `Error:` / `Uncaught` / `Maximum update depth exceeded`).
  - **Edge:** container `Box mb="4"` (LauncherShell.tsx:501) must not shift/clip; flex-column centering (LauncherShell.tsx:481-503) keeps the avatar centered above the command bar.

## F-40 (NF) — Proportions preserved

- [ ] F-40: Normalize key spans of the rendered figure (head width/height, body width, leg length/width, foot width) to % of the avatar bounding box and compare against the wireframe's normalized geometry (head silhouette x 8.6–91.4% W / y 5.3–62.8% H; legs y 85.8–94.9% H; feet ≈ 11.7% W each). Ratios within a small recorded tolerance; identical geometry in both themes.

---

## #2850 extension — shared-avatar refactor: launcher md surface

> Issue #2850 — the launcher's `PixelButler` becomes a thin `FredoAvatar size="md"` wrapper over
> the canonical avatar moved to `apps/ui/src/shared/components/fredo-avatar/` (geometry module +
> test move VERBATIM; launcher layout is a NON-GOAL — the 132×165 md render must be unchanged).
> **Verification policy: live** for the render rows (the AC-1 geometry suite row F-41 is
> static/unit and runs in `test:run` regardless). Reference assets (Read by EXPLICIT absolute
> path, never glob): `.opencode/wireframes/fredo-avatar.html` + `.opencode/wireframes/fredo-avatar.png`.
> Map 1:1 to `.opencode/tmp/2850/triage.md` `## QA Expert` (Q-1/Q-2/Q-21 + the companion-suite
> F-2 cross-surface pixel-consistency). The companion-suite rows F-2..F-19 carry the AC-2..AC-6
> verdicts; these launcher rows add the md-surface-specific checks.

## F-41 (Q-1 / AC-1) — Geometry suite passes UNMODIFIED at the shared path

- [x] F-41: Byte-compare `fredoAvatarGeometry.ts` + `fredoAvatarGeometry.test.ts` at their new
      shared location (`apps/ui/src/shared/components/fredo-avatar/`) against the pre-move
      launcher files (only the relative import path must still resolve to the sibling). Run
      `pnpm --filter @fredo/ui exec vitest run` on the moved test AND the full `test:run`.
      **Expected:** all 8 assertions pass unchanged (FREDO_AVATAR_SPACE 1014×1264 centerX 507;
      viewBox `0 0 1014 1264`; 31 source rects — 27 mirrored pairs + 4 center singles → 58
      expanded; mirror math `x' = 1014 − x − width`; canvas bounds; as-authored center buttons;
      guard rejects out-of-canvas). A content re-authoring in the move = FAIL.
  - **PASS (static/build, spec/2850).** The moved `fredoAvatarGeometry.ts` is byte-identical to the pre-move launcher source (Read-verified: the shared copy matches the `git show main:` original byte-for-byte; only the sibling `../fredoAvatarGeometry` import resolves). The moved `fredoAvatarGeometry.test.ts` is byte-identical to the pre-move `features/home/components/launcher/__tests__/fredoAvatarGeometry.test.ts` (verbatim, 8 assertions incl. `expandFredoRects`/`FREDO_AVATAR_SPACE`/58-count/mirror math/canvas/center buttons/guard). `pnpm --filter @fredo/ui exec vitest run` on the moved test → **7 tests passed**. `pnpm --filter @fredo/ui test:run` → **52 files / 757 tests passed** (incl. the moved geometry suite at its new shared path). Grep `features/home/components/launcher/` for `expandFredoRects`/`FREDO_AVATAR_SOURCE_RECTS` → **ZERO** (no duplicate geometry; the launcher imports the shared module). `git diff --stat main spec/2850 -- launcher/` = `LauncherShell.tsx +2/-2`, `PixelButler.tsx` deleted, `fredoAvatarGeometry.ts`/`.test.ts` deleted (moved).
  - **Edge:** grep confirms ZERO duplicate geometry table / `expandFredoRects` remains under
    `features/home/components/launcher/` (the launcher imports the shared module).

## F-42 (Q-21 / AC-1, M1) — Launcher md avatar 132 px wide UNCHANGED (no visual regression)

- [x] F-42: Open the launcher; measure the avatar SVG layout size (`offsetWidth`/`offsetHeight`
      per G-040 — never a transform-scaled `getBoundingClientRect`) and screenshot it.
      **Expected:** `offsetWidth` = 132, `offsetHeight` = 165 (aspect 1014:1264, undistorted),
      crispEdges, single accent-token fill (`color="var(--accent-primary)"` +
      `fill="currentColor"`), `aria-hidden`, centered above the command bar — visually unchanged
      from the pre-refactor #2837/#2839 launcher render (screenshot side-by-side compare).
  - **PASS (live, spec/2850, theme-classic).** Launcher md avatar SVG `offsetWidth`=132, `offsetHeight`=165 (aspect 1014:1264, undistorted — matches `AVATAR_MD` from `fredoAvatarSizes.ts:18`), 58 rects, `shapeRendering="crispEdges"`, `color="var(--accent-primary)"` (resolved `rgb(255,43,194)` classic base magenta) + `fill="currentColor"`, `aria-hidden="true"`, `fill="none"`, `viewBox="0 0 1014 1264"` — centered above the command bar (`LauncherShell.tsx:502` `<FredoAvatar size="md" />`). Visually unchanged from the #2837/#2839 render (SAME 58 rects, mirror math `886=1014-87-41` etc.). Re-themed light-default ↔ dark base + Matrix → the avatar re-tinted token-native (`rgb(0,209,209)` cyan / `rgb(0,255,65)` green) with no stale color; the shell layout (notch, grid, command bar, hints, clock/LED) is unchanged (the launcher layout is a non-goal — only the import swapped).
  - **Edge:** repeat in a light preset AND the dark base; narrow viewport (700×900) — no clip/overflow;
    re-theme while visible re-tints with no stale color; the shell layout (notch, grid, command bar,
    hints, clock/LED) is unchanged.

## F-43 (Q-2 / AC-1) — Launcher imports the shared canonical avatar only

- [x] F-43: Grep `apps/ui/src/features/home/components/launcher/**` for a local base-rect geometry
      implementation (`FREDO_AVATAR_SOURCE_RECTS` / `expandFredoRects` declarations) and for the
      avatar import source. **Expected:** zero local geometry declarations — the launcher's avatar
      wrapper (`PixelButler` or equivalent) imports `FredoAvatar` from
      `shared/components/fredo-avatar/`; no cross-feature import (`features/*`); the shared module
      is exported from `apps/ui/src/index.ts`.
  - **PASS (static/live, spec/2850).** Grep `features/home/components/launcher/` for `expandFredoRects`/`FREDO_AVATAR_SOURCE_RECTS` → **ZERO** local geometry declarations. `LauncherShell.tsx:14` imports `FredoAvatar` from `../../../../shared/components/fredo-avatar` (the shared module) and renders `<FredoAvatar size="md" />` (`:502`) — a thin wrapper with NO local geometry. No `PixelButler.tsx` remains (deleted). No cross-feature import (`features/*`) — the launcher imports `shared/components/fredo-avatar`. `apps/ui/src/index.ts:32-47` exports `FredoAvatar` + geometry + sizes so both `tauri` and feature surfaces consume the ONE canonical geometry. Live: the launcher renders the shared sm/md avatar from the same component instance path as the companion.
  - **Edge:** a thin wrapper that adds NO geometry is acceptable; a launcher-local duplicated
    rect table is a FAIL (the #2837 regression net F-35..F-40 stays green through the move).

---

## #2852 extension — desktop mascot 80×100 + idle animation (live render gate)

> **Round 1 (spec/2852 @ 1677eca8) — ALL PASS (F-46 live leg UNVERIFIED-with-named-blocker).** F-44 ✓ wrapper `offsetWidth=80`/`offsetHeight=100`, SVG `80×100 viewBox=0 0 1014 1264`, 58 rects, aspect ≈1014:1264. F-45 ✓ wrapper `animationName="fredo-idle-bob, fredo-idle-glow"` 2.4s ease-in-out infinite running; SVG own `animationName=none`; bob sampled 0→−2px, glow 0→6px accent `color-mix` 22%; command-bar layout invariant. F-46 ⚠ live reduced-motion emulation UNVERIFIED (named blocker: no media-feature emulation in the MCP driver) — `@media (prefers-reduced-motion: reduce){ .fredo-avatar-idle{animation:none} }` verified in the loaded CSSOM + live size 80×100 re-measured. F-47 ✓ 58 rects byte-identical to companion + shared source, stable across frames/themes; no per-rect animation; `#fredo-expression` absent. Full live receipts + screenshots in the issue's `## Tests Runs` (round 1).

> Issue #2852 — the desktop/launcher mascot drops from `md` (132×165) to `sm` (80×100,
> aspect 1014:1264 — the SAME shared size the companion uses) and plays the companion's
> EXACT idle bob + soft accent glow on the consumer wrapper while resting. Reduced motion
> suppresses the animation without changing the size. The frozen 58-rect base geometry and
> the companion are NOT touched.
> **Verification policy: live** — pure-rendering, NO telemetry fixture. Live evidence =
> rendered-webview receipts: `tauri_webview_dom_snapshot` + `tauri_webview_screenshot` +
> `getComputedStyle`/`offsetWidth`/`offsetHeight` + rAF transform/filter sampling +
> `upload-evidence --base spec/<N>` raw URL.
> **Reference assets (Read by EXPLICIT absolute path, NEVER glob — `.opencode` is dot-prefixed, G-105):**
> `.opencode/wireframes/fredo-avatar.html` (authoritative 1014×1264 geometry),
> `.opencode/wireframes/fredo-avatar.png`.
> Map 1:1 to `.opencode/tmp/2852/triage.md` `## QA Expert` (REQ-1..REQ-4 / F-44..F-47).

## F-44 (REQ-1/AC1) — Desktop mascot renders 80 × 100 (same sm as the companion)

- [ ] F-44: Open the launcher's resting desktop surface on the running `spec/<N>` build (no window covering). Locate the mascot SVG above `input[role="searchbox"]` (LauncherShell.tsx:501-503). Read `offsetWidth`/`offsetHeight` (G-040 — NOT the transform-scaled `getBoundingClientRect`, which the idle bob would perturb), the SVG `width`/`height`/`viewBox` attributes, and the source constant `AVATAR_SM`.
  **Expected:** `offsetWidth = 80`, `offsetHeight = 100` (`Math.round(80 × 1264/1014) = 100`); SVG `width="80" height="100" viewBox="0 0 1014 1264"`; rendered aspect 1014:1264 (0.8022) — undistorted, no letterbox/stretch; the value equals the companion's `AVATAR_SM`; NO `size="md"` / 132×165 remains anywhere in the launcher.
  - **Edge:** narrow viewport (700×900) — still 80×100, fully visible, not clipped/cropped/scaled; fractional OS scale/zoom; light preset AND the dark base; height derives from the ONE shared `FREDO_AVATAR_SPACE` aspect (never a separate height literal); the SVG still renders exactly 58 crisp `crispEdges` rects. Reference #2850 F-4 / companion F-4.

## F-45 (REQ-2/AC2) — Resting mascot plays the companion's EXACT idle bob + glow, on the wrapper

- [ ] F-45: On the resting desktop (no window covering), read `getComputedStyle` of the mascot's CONSUMER wrapper AND of the SVG element; rAF-sample the wrapper `transform` and `filter` through ≥1 full 2.4 s cycle (set `.fredo-companion-avatar`/launcher equivalent `animationPlayState` unchanged; read the raw animated values).
  **Expected:** wrapper `animation-name` includes BOTH `fredo-idle-bob` AND `fredo-idle-glow` (identical names to `companion.css:14-29` — PO 2026-09-10: no distinct/calmer variant), `animation-duration: 2.4s`, `animation-timing-function: ease-in-out`, `animation-iteration-count: infinite`; sampled `matrix().f`/`translateY` varies 0 → −2px → 0 and `filter` varies `drop-shadow(0 0 0 …)` → `drop-shadow(0 0 6px …)` tinted from `var(--accent-primary)` (22% `color-mix`). The SVG element's OWN `animation-name = none` (whole-element motion is on the wrapper, NEVER the frozen geometry). The command bar, grid, hints row and clock rects are unchanged; no layout shift; no clip/overflow/scrollbar.
  - **Edge:** resting vs engaged (grid open) — the loop must not break either way; rapid launcher open/close restarts the loop cleanly (no stuck/ghost frame/flicker); CSS-only (no JS state per frame → no re-render loop / no `Maximum update depth exceeded`); re-theme mid-animation keeps the glow on the live `var(--accent-primary)` (no stale color). Reference companion F-3 idle + #2850 R-1.

## F-46 (REQ-3/AC3) — prefers-reduced-motion: reduce suppresses the idle animation; size persists

- [ ] F-46: Force `prefers-reduced-motion: reduce` (OS "Show animations in Windows" off / driver media emulation) and re-inspect the resting mascot (computed style + `offsetWidth`/`offsetHeight` + rect count). If the driver cannot emulate reduced motion, record the tooling limitation and verify the `@media (prefers-reduced-motion: reduce)` suppression rule in the stylesheet PLUS re-measure the live size.
  **Expected:** under reduce, the wrapper `animation-name = none` (bob + glow suppressed → static mascot) while `offsetWidth/offsetHeight` STILL = 80×100 and all 58 rects render; the figure is still VISIBLE (not hidden/faded by the suppression); no layout shift; console clean.
  - **Edge:** toggling reduce while the mascot is mounted produces no geometry jump (size invariant across motion modes); reduced-motion OFF → animation returns; no `Error:`/`Uncaught`/`Maximum update depth exceeded`; reduced-motion live emulation is a documented tooling limitation today (mirrors companion F-19) — do NOT convert a static CSS check into a live PASS without recording the limitation.

## F-47 (REQ-4/AC4) — Frozen 58-rect geometry byte-identical; companion unchanged at 80×100

- [ ] F-47: Read the launcher SVG's full `<rect>` set (x/y/width/height, in document order) at several animation frames, in a light preset and the dark base, and under reduced motion; diff it against `expandFredoRects(FREDO_AVATAR_SOURCE_RECTS)` AND against the companion sm avatar's rect set. Then measure `.fredo-companion-avatar` (`offsetWidth`/`offsetHeight`) and read its idle `animation-name`.
  **Expected:** the launcher SVG carries exactly the 58 base rects, byte-identical to the shared source and to the companion `sm` set, invariant across frames/themes/reduced-motion; `#fredo-expression` is ABSENT (idle); no `<rect>` carries an animation/transform (the frozen geometry is never animated). The companion `.fredo-companion-avatar` remains `offsetWidth = 80` / `offsetHeight = 100`, its 58-rect set and its `fredo-idle-bob`/`fredo-idle-glow` 2.4 s idle UNCHANGED by this spec.
  - **Edge:** compare both surfaces in the SAME theme (rect sets identical); the geometry suite `fredoAvatarGeometry.test.ts` passes UNMODIFIED in `test:run`; launcher open/close cycles do not mutate the rect set; the companion is byte/visually identical to its pre-#2852 render. Reference #2850 R-26/R-28 + companion R-10.

---

## #2868 extension — the app grid gains the Settings tile (G-136 reconciliation)

> Issue #2868 registers Settings as a first-class `FredoFeatureClass` app (showable, no install
> step) so the launcher grid gains a "Settings" tile and the floating gear is retired.
> **G-136:** F-2's frozen tile set (`["Mission Monitor","Query Viewer","Run CLI","Stepper Probe"]`)
> and S-4 ("gear opens the settings dialog") are SUPERSEDED — the launcher grid now includes
> Settings and the gear is gone. Historical PASS records above are preserved. Live policy.
> **Feature tests:** settings (this extension's cross-suite rows F-21/F-39 own the details).

## F-48 (AC-1 / #2868) — The grid tile set includes Settings; no install/onboarding step

- [ ] F-48: Reveal the engaged grid (`input[role="searchbox"]` focus / Ctrl+Space) and
      `tauri_webview_dom_snapshot(type="structure")` it. Compare the tile `aria-label` set against
      `SHOWABLE_FEATURES.map(f => f.name)` for the `spec/2868` tip.
  **Expected:** the rendered tiles include `"Settings"` in addition to the prior showable features
      (`["Mission Monitor","Query Viewer","Run CLI","Stepper Probe","Settings"]` on the tested tip);
      the Settings tile is present with NO install/uninstall or onboarding step; non-showable
      features remain absent; no duplicate tile (`dedupeByFeatureId`).
  - **Edge:** present after app reload and with an empty/fresh store; the query filter matches
    "settings"; deleted/closed Settings re-opens from the tile.

## F-49 (AC-2 / #2868) — Settings tile opens the feature window through the own-kernel opener

- [ ] F-49: Click the Settings tile; DOM-snapshot the resulting surface.
  **Expected:** the tile routes through `onOpenFeature("settings", feature)` → `Home.openFeatureWindow`
      → own-kernel `openWindow`, producing `div[role="group"][aria-label="Settings"]` with
      `header.fredo-window__header` title "Settings" (not the retired modal). The launcher sinks
      below it (`coveredByWindow`) and re-reveals on close. Re-invoke focuses/restores the SAME
      window (no duplicate). Cross-ref `.opencode/tests/settings/` F-21/F-27.
  - **Edge:** keyboard nav (arrows + Enter) opens it; Ctrl+Space raises the grid over the maximized
    Settings window for the re-invoke.

## F-50 (AC-1 / #2868) — No floating gear on the launcher surface

- [ ] F-50: On a clean desktop (resting and engaged) and with a maximized window open, scan for the
      retired floating settings button (`IconButton[aria-label="Settings"]`, bottom-right, z≈1250).
  **Expected:** NO floating gear renders in any state — the launcher grid is the sole Settings
      entry; the clock/LED cluster + app dock are unchanged. Cross-ref
      `.opencode/tests/settings/` F-37/F-39 + `.opencode/tests/desktop-chrome/` R-21.
  - **Edge:** no gear over a maximized window; no residual gear z-layer; console clean.

### #2868 testing round 1 (spec/2868 @ 90da8de) — results

- **F-48 PASS (live).** Engaged grid rendered 5 tiles — Mission Monitor, Query Viewer, Run CLI, **Settings**, Stepper Probe — with no install/onboarding step and no duplicate.
- **F-49 PASS (live).** Settings tile → `div[role="group"][aria-label="Settings"]` (title "Settings", not the retired modal); the launcher sank below and re-revealed on close; re-invoke focused/restored the SAME window (count stayed 1). Keyboard: ArrowLeft moved the active tile to `tile-3` (Settings) and Enter opened it.
- **F-50 PASS (live).** No floating gear in the resting or engaged desktop, or with a maximized window (`button[aria-label="Settings"]` count 0). Evidence: `.opencode/tmp/2868/tests-runs.md` / `## Tests Runs (round 1)`.

---

## #2871 extension — command-bar companion chat (smart-Enter); G-136 reconciliation

> Issue #2871 — while the companion is ACTIVE, the launcher command bar also accepts a message
> for Fredo: the typed text (trimmed, case-insensitive) EXACTLY matching a `SHOWABLE_FEATURES`
> name launches/filters as today, otherwise Enter sends it to the companion LLM; the reply streams
> into the companion's existing `SpeechBubble` (`showMessage()`); single-shot; active-only.
> **G-136 reconciliation:** the prior resolution pinned in F-25's note / exploratory E-1 /
> regression R-7 ("the command-bar query is a grid filter only") is **SUPERSEDED for the
> ACTIVE-companion state** — Enter is now smart. Historical records above are preserved, not
> rewritten; R-7 is extended (not deleted) by R-37. The command-bar READ path (a non-exact query
> with the companion inactive) is unchanged.
> **Verification policy: live** — `tauri_webview_keyboard` type+Enter, `tauri_webview_execute_js`
> sync streaming samples, `tauri_webview_dom_snapshot`/`screenshot` → `upload-evidence --base
> spec/2871`, `tauri_read_logs(source="console")`, and the mandatory `telemetry_spans` receipt
> (F-57). Map 1:1 to `.opencode/tmp/2871/triage.md` `## QA Expert` REQ-1..REQ-13.

## F-51 (REQ-1/REQ-2) — Smart-Enter: exact tile name launches, otherwise it chats

- [ ] F-51: Companion ACTIVE at the home seat. With `input[role="searchbox"]` focused, type the
      exact tile name `Mission Monitor`, press Enter; then repeat with a non-tile phrase
      (`tell me a joke about regex`). `tauri_webview_dom_snapshot` after each Enter.
  **Expected:** exact (trimmed, case-insensitive) full-name match → the existing launch path
      (`onOpenFeature` → `Home.openFeatureWindow`) and NO `llmChat`; the non-tile phrase → a
      single-shot `adapterBridge.llmChat` → `llm_chat` (no window opens). The match is the WHOLE
      string, never a substring.
  - **Edge:** trailing whitespace; lowercase `mission monitor`; `Settings`; a substring matching
    ≥2 tiles (`run`) that equals none → chat; empty query Enter → filter-only no-op. Reference
    REQ-2 + companion F-69.

## F-52 (REQ-3/REQ-4) — A sent message streams a reply into the companion bubble (G-130)

- [ ] F-52: Companion ACTIVE; send `Tell me a short programming joke about regex` via the bar.
      Sync-sample the `SpeechBubble` text node + the wrapper `data-state`/`data-streaming` at t0
      and ~every 250 ms until end; screenshot mid-stream; upload the screenshot.
  **Expected:** the reply renders in the companion's existing seat-anchored 240×120 bubble and
      grows token-by-token — **≥3 DISTINCT partial contents** across the samples (G-130, never a
      single final block); `data-streaming="true"` + the 2×14 px `Fredo-cursor-blink` cursor
      during the stream; expression `thinking` on the wait → `joking` on the first token; the
      final text matches the completed generation (control tokens stripped).
  - **Edge:** TTFT >1 s (thinking observable); long reply wraps in the fixed-height bubble (no
    resize); bubble re-anchors above the seat (tail down). Reference companion F-69/F-70 +
    llama-setup F-64.
  - **#2886 SUPERSESSION (extend in place — history preserved).** The "seat-anchored **240×120**
    bubble" + "long reply wraps in the fixed-height bubble (no resize); bubble re-anchors above the
    seat (tail down)" half of this row is **SUPERSEDED for the TEXT reply surface** by #2883
    (companion F-79/F-83) and re-aimed by **#2886**: the seat anchor is now CONSTRAINED to clear
    Fredo, the app tiles and the search bar/field — it is NOT unconditionally "above the seat". The
    streaming / single-shot / no-second-surface half remains in force. See the
    `## #2886 extension` (F-79..F-81) below.

## F-53 (REQ-5/REQ-6) — Completion clears; error/not-ready is readable and the bar recovers

- [ ] F-53: (a) Wait for `llm-done` after F-52; sample `data-streaming`/cursor/bubble, then send
      a 2nd message. (b) `stop_llama_server` (or a bad `llama_server_path`) while ACTIVE, send a
      message; separately kill the server mid-stream. Read the bubble + console after each.
  **Expected:** (a) `llm-done` clears the busy state (cursor hidden, `data-streaming` gone), the
      bubble holds ~5 s then hides, the bar is usable, and a 2nd message re-enters the busy path —
      no stuck indicator. (b) a READABLE line surfaces via the existing `llm-error` /
      `⏳ Loading model...` path; the busy state clears and the bar returns usable within a bounded
      window; NEVER a hang / stuck spinner; no raw stack/IPC dump.
  - **Edge:** server stopped before send; killed after partial tokens; repeated send after error;
    `llm-error`+`llm-done` completes ONCE. Reference REQ-6 + companion F-71 + llama-setup R-29.

## F-54 (REQ-7/REQ-8) — Inactive ⇒ filter/launch unchanged; active ⇒ launch still reachable

- [ ] F-54: (a) With the companion OFF (`Fredo_companion_visible=false`) and away
      (Ctrl+right-click), type a non-tile phrase + Enter each time. Separately, after an idle
      auto-return (5 s timeout) Fredo is home — send there. (b) With it ACTIVE, type `set`
      and observe the grid; click the Settings tile; then Enter with a non-exact query.
  **Expected:** (a) OFF/away → NO `llmChat`, no bubble — the bar behaves exactly as today
      (filters tiles; Enter launches only an exact/selected tile). Home-after-auto-return → the
      chat path REMAINS ACTIVE (resolved predicate `isVisible && !isAway`). (b) the grid still
      filters; CLICKING a tile launches its window; exact-name Enter launches; non-exact Enter chats.
  - **Edge:** away while hosted in `run-cli-terminal`; toggle OFF then Enter immediately;
    auto-return then immediate send; click while a generation streams; empty-match query Enter → chat.

## F-55 (REQ-9/REQ-10) — One in-flight generation; no listener leak across repeated sends

- [ ] F-55: Send a long message; press Enter 2-3× while it streams. Then run ≥5 send→receive
      cycles incl. one error cycle; watch the bubble/tokens.
  **Expected:** at most ONE generation in flight; extra submits ignored (default) — never 2
      interleaved streams or duplicate `llm_chat`; a late token from generation A never appends to
      a later bubble; every generation completes exactly ONCE (`TauriAdapter.ts:60-71`); no
      accumulated/duplicated listeners, no duplicate tokens, no double busy-clear.
  - **Edge:** rapid double-Enter; Enter during error; Enter right after done; retry-on-`still
    loading` re-entry; unmount mid-stream. Reference companion F-72.

## F-56 (REQ-11/REQ-12) — Console clean, token-native, reduced motion

- [ ] F-56: After every leg read `tauri_read_logs(source="console")`. Static-grep the changed
      files for `#[0-9a-fA-F]{3,8}`/`rgba(`/`rgb(`/`var(--x)NN`. Re-theme light↔dark + a
      non-default accent while the bubble/busy affordance is visible. Drive a reduced-motion pass
      if the driver can flip `matchMedia`.
  **Expected:** NO `Error:`/`Uncaught`/`Maximum update depth exceeded`; no re-render loop (#523);
      token-native only, NO `var(--x)NN` alpha-append; the bubble chrome + busy affordance re-tint
      live with no stale color; reduced motion keeps the entry fade-only.
  - **Edge:** reduced-motion emulation is a named blocker today (driver cannot flip `matchMedia`)
    → static CSS + a product-unit pin (the #2870 F-66 precedent); comment issue-refs are not
    literals.

## F-57 (REQ-LIVE) — Mandatory `telemetry_spans` + rendered-webview receipt

- [ ] F-57: Same run as F-51..F-56: `fredo emit --event-type chat --session-id e2e-2871-chat` +
      `--event-type tool_use --session-id e2e-2871-tool`; query `telemetry_spans` +
      `chat_rows`/`tool_use_rows` (telemetry-query skill); keep the per-AC `upload-evidence` raw
      URLs + DOM snapshots + streaming samples.
  **Expected:** `telemetry_spans` returns a NON-ZERO count with a recent `max(ingested_at)`; the
      injected events classify into `chat_rows`/`tool_use_rows` under their session ids; a
      rendered-webview receipt exists for the chat + busy + error states. **A static-only PASS is
      a FALSE PASS** (G-108/G-102). Do not depend on `tauri_ipc_monitor` capturing `llm_chat`
      (G-058).
  - **Edge:** re-run the receipt on the tested tip; keep the emit + query output verbatim.

## F-58 (REQ-14/REQ-15/REQ-16) — Bar mode affordances, a11y, reduced-motion static cursor

- [ ] F-58: With the companion ACTIVE, compare the bar across: empty query; exact tile name;
      non-tile text; busy. Read the prefix glyph, the right-side hint chip text, the placeholder,
      `aria-label`/`aria-describedby`/`aria-busy`, and the single live region. Static-grep the
      changed files + read the cursor computed `animationName` under reduced motion.
  **Expected:** exact → `↵ open <Tile>` chip + `>` chevron; non-match → `↵ send to Fredo` + a
      speech glyph; empty/inactive → chip hidden; busy → placeholder/chip `Fredo is replying…`,
      `aria-busy="true"`, input READ-ONLY (Enter no-op), `—` still operable. role stays
      `searchbox`; `aria-describedby` → `#fredo-command-hint`; ONE `role="status" aria-live="polite"`
      region announces once per event (never per token); the bubble stays `aria-hidden`. ZERO
      hardcoded color / `var(--x)NN`; busy geometry uses CSS unit strings; under reduced motion the
      streaming cursor is a static 2px bar (no blink).
  - **Edge:** substring-only hit with the companion active → send; game bubble open → `Finish the
    game to chat`; error copy + 8 s hold; reduced-motion flip is a named blocker if the driver
    cannot flip `matchMedia` (static CSS + product-unit pin). Reference UI/UX §1/§2/§4/§5 + REQ-14..16.

### #2871 testing round 1 (spec/2871 @ e5fa7612) — results

Live (real managed `llama-server`, `/health` 200 :8080). Verdict **FAIL** (12/16 REQs pass).
Evidence: `.opencode/tmp/2871/tests-runs.md` / `## Tests Runs (round 1)`.

- **F-51 PASS (live).** `Mission Monitor` + Enter → Mission Monitor window opened, no `llmChat`;
  non-tile phrase → single-shot chat. Substring `set` stays a SEND.
- **F-52 PASS (live).** 70 ms recorder: **4 distinct partial contents** (thinking + 3 incremental);
  seat bubble `position:absolute` 240×120 above the slot; `thinking`→`joking`→`happy`.
- **F-53 FAIL (live).** (a) On `llm-done` `data-streaming` + cursor clear, BUT the bar `aria-busy`
  + dot linger through the ~5 s `happy` hold (streaming cleared t=7907, aria-busy t=14578) — the bar
  is not "usable again" until the hold ends. (b) The error surfaced as the RAW backend string
  `failed to start C:\…\bad-llama-server.exe: spawn …` (not the curated copy), and the flow rendered
  `happy` (no false-happy rule). Repro: `stop_llama_server` + `llama_server_path` → a real
  non-executable file → Enter. A nonexistent path does NOT error (PATH fallback).
- **F-54 PASS (live).** OFF + away → no chat, filter/launch unchanged; after >60 s idle the
  companion was home and a bar send streamed a reply (resolved predicate holds live).
- **F-55 PASS (live).** 8 generations, each exactly one `llm-done`; Enter-spam never started a
  2nd stream. (The extra Enter fell through to `openSelected()` — see F-58 FAIL.)
- **F-56 PASS (live+static).** Console error-level empty; zero color literals in the changed files.
- **F-57 PASS (live).** `telemetry_spans` 23,165, newest `2026-09-13T21:02:29.608Z`;
  `chat_rows(e2e-2871-chat)=1`; `tool_use_rows(e2e-2871-tool/read_file)=1`.
- **F-58 FAIL (live+static).** **REQ-14:** during busy the bar shows NO `Fredo is replying…`
  placeholder/chip, the input is NOT `readOnly`, and Enter during busy LAUNCHES the selected tile
  (window opened mid-stream). **REQ-16:** `Fredo-cursor-blink` is not motion-gated
  (`companion.css:142-145` has no reduced-motion rule) → under reduced motion the cursor still
  blinks. **REQ-15:** the single reply live region did not announce the error event. REQ-12 + the
  REQ-14 exact/non-match chip + `aria-describedby` mirror PASS.

### #2871 testing round 2 (spec/2871 @ bd168ee) — results

Verdict: round-1 REQ-6/REQ-14/REQ-15/REQ-16 **all FIXED**. Live (real managed `llama-server`,
`/health` 200 :8080). One screenshot per AC + the full receipt in the issue's `## Tests Runs (round 2)`.

- **F-51 PASS (live, regression).** White-box runtime still one dispatch path: a bar send added
  exactly ONE `[companion] runGeneration called` + one `llm-done`; `Settings` (exact) opened the
  Settings window (`div[role="group"][aria-label="Settings"]`, surfaces 1→2) with NO generation
  added. Substring `set` → chip `↵ send to Fredo` + speech glyph, never a launch.
- **F-52 PASS (live, G-130).** Long prompt → reply in the SAME seat bubble; recorder captured
  **11 distinct partial contents**; `thinking`(wait) → `joking`(first token); control tokens
  stripped. Screen `req3-bubble-streaming.png`.
- **F-53 PASS (live — was FAIL).** (a) On `llm-done` `data-streaming` clears AND the bar
  `aria-busy`/`readOnly`/chip clear at completion (ST-1r `setState('idle')` up-front); a 2nd send
  re-enters busy. (b) The error leg showed the curated `Fredo couldn't reply just now. Try again in
  a moment.` — no raw `failed to start … spawn …`, no `happy`, bar usable. Screen `req6-error-bubble2.png`.
- **F-54 PASS (live).** OFF (`Fredo_companion_visible=false`) + away (MCP recipe c) → non-tile
  Enter takes no chat (no generation, no bubble); active → `set` filters + tile click launches +
  non-exact Enter chats. Screen `req8-filter-active.png`.
- **F-55 PASS (live).** 12+ sends, each exactly one `runGeneration`/`llm-done`; a REAL Enter during
  an in-flight stream (`streamingAtKeydown="true"`, `busyAtKeydown="true"`, `ro=true`) did NOT
  start a second generation and did NOT open a window. No listener accumulation.
- **F-56 PASS (live+static).** Console error-level across the whole run = ONE `[MCP][BRIDGE]`
  instrumentation artifact from a tester-dispatched synthetic `document` event (`e.target.getAttribute`
  on a non-Element target); normal interaction legs are clean, no `Maximum update depth exceeded`.
  Changed launcher files carry ZERO color literals; busy dot computed `rgb(147,51,234)` =
  `--accent-primary` (token-native); no `var(--x)NN`. Reduced-motion CSS + pin (F-58).
- **F-57 PASS (live).** `telemetry_spans` 23,735, max(ingested_at) `2026-09-13T21:46:52.331Z`;
  `chat_rows(e2e-2871-r2-chat)=1`; `tool_use_rows(e2e-2871-r2-tool)=1`.
- **F-58 PASS (live+static — was FAIL).** **REQ-14:** atomic busy-frame DOM (`data-streaming="true"`,
  `state=thinking`) showed placeholder `Fredo is replying…`, `readonly=""`, `aria-busy="true"`,
  chip `Fredo is replying…` (`data-testid="launcher-command-hint"`), SR mirror
  (`fredo-command-hint-sr`) identical, 6×6 px accent busy dot, `—` minimize present as the last
  end child; a REAL Enter with `streamingAtKeydown="true"` was a global no-op (maxWins unchanged);
  minimize clicked mid-stream did NOT abort the generation. **REQ-15:** exactly 2 live-region
  changes per generation (send → complete); the error leg announced the readable sentence once;
  no per-token spam. **REQ-16:** `companion.css` `.fredo-cursor { animation: none !important; }`
  sits INSIDE `@media (prefers-reduced-motion: reduce)`; the non-reduced cursor computed
  `animationName="Fredo-cursor-blink"` during streaming; product pins
  `companion.cursorReducedMotion.test.ts` 2/2 + `companionReplyErrorCopy.test.ts` 4/4 green.
  Screens `req14-busy-atomic.png`, `req4-busy-streaming.png`.

---

## #2878 extension — launcher-bar dictation commit (autosend) + visible cancel affordance

> Issue #2878 completes the **commit behavior** on the #2877 ST-5 bar surface: `voiceAutosend` ON →
> the #2871 smart-Enter path (`commitBarQuery`), OFF → input only; Stop = finalize/commit, the new
> visible `×` control + Escape = cancel/discard. **Verification policy: live.** Serving
> `spec/2878 @ 33cf86d5`. Rows F-59..F-63 map to the QA-Plan REQ-2.x/3.x/5.2 + the binding Ctrl+Space/Escape
> decisions. (Full matrix in `.opencode/tests/voice-input/functional.md` F-39..F-61.)

- [x] **F-59 (REQ-2.1/2.3) — autosend ON + exact tile name launches through the smart-Enter path (live).** PASS. Companion ACTIVE; a launcher-origin finalize of `Settings` → `div[role="group"][aria-label="Settings"]` opened with NO manual Enter and NO `runGeneration` (launch WINS). Autosend OFF repeats it only on a manual Enter.
- [x] **F-60 (REQ-2.2/2.6) — autosend ON non-match sends / OFF keeps the text (live).** PASS. ON: final `what is your name` → bar cleared + one `runGeneration` + streamed reply. OFF: a non-tile final leaves `value` in the bar with zero `runGeneration`.
- [x] **F-61 (REQ-3.1/3.2/ESC) — Escape discards the partial, restores the pre-session draft, one action per press (live).** PASS. Draft typed → partial in the bar → Escape → partial gone, `value` restored to the draft, `listening:false`, no dispatch; a 2nd Escape follows today's idle-collapse (`aria-expanded=false`; launcher stays open on the 1st).
- [x] **F-62 (REQ-CTRL.1/CTRL.2) — binding Ctrl+Space cascade + no bar focus steal (live).** PASS. companion away + chord → companion-origin session + bar cue absent + `activeElement` stays BODY; bar focused + chord → `launcher-listen`; default + chord → show/focus with `listening:false`.
- [x] **F-63 (REQ-5.1 via the launcher surface) — the MINIMIZE control's stale host mirror.** **Round 1: FAIL (defect routed to `voice-input` F-53); round 2 (fix `99144a1`): PASS.** Repro on the launcher: type text → click `button[aria-label="Minimize launcher"]` (bar `value=""`) → `stt_start` → `stt_stop` with no transcript → the pre-Minimize text is sent to Fredo. Root cause `LauncherShell.tsx:514` (`setQuery('')` without `barTextRef.current = ''`). **Round 2 — PASS (live, `spec/2878 @ 99144a19`):** the same sequence yielded ZERO `runGeneration`, ZERO windows, bar `value=""`; the fix syncs `barTextRef.current = ''` in `handleMinimize` AND scopes the finalize evidence to the session's committed delta. Screenshot `r2-ac5-phantom-probe-final.jpeg`.

### #2878 testing round 1 (spec/2878 @ 33cf86d5) — results

Verdict **FAIL** (the F-63 phantom dispatch). Full per-AC matrix + live receipts in the issue's
`## Tests Runs`. F-59..F-62 PASS; F-63 FAIL (reproducible). `pnpm --filter @fredo/ui test:run`
80 files / 1079 tests green; console clean across every leg.

### #2878 testing round 2 (spec/2878 @ 99144a19, fix 99144a1) — results

Verdict **PASS**. F-63 re-verified PASS (exact repro → no dispatch); the F-59..F-62 rows spot
re-confirmed live (exact-name launch zero-generation, non-match send one-generation, Escape
cancel+restore, cascade away-no-focus-steal + bar-focused listen + toggle-cancel). Build
`test:run` 80 files / 1083 tests green. Full per-AC matrix + live receipts in the issue's
`## Tests Runs`.

---

## #2882 extension — Enter opens the app a typed query names; hold-Space dictates (G-136 reconciliation)

> Issue #2882 changes **how the bar is triggered and what Enter does** — not how the bar filters or
> renders apps (out of scope). Rows F-64..F-69 map 1:1 to the QA Plan `REQ-7..REQ-10` + `REQ-1/REQ-2`
> of `.opencode/tmp/2882/triage.md` `## QA Expert`. **Verification policy: live** — evidence via
> `tauri_webview_keyboard` (REAL keydown/keyup, a HELD Space with a recorded duration),
> `tauri_webview_execute_js` (`document.activeElement`, `input[role="searchbox"]`.value,
> `role="group"][aria-label=...]` window counts), `tauri_webview_dom_snapshot`,
> `tauri_webview_screenshot`, `tauri_read_logs(source="console")`, plus the mandatory
> `telemetry_spans` receipt (REQ-17). **Serving checkout:** the `spec/2882` tip.
>
> **G-136 SUPERSESSION (recorded here; historical PASS records above are PRESERVED, never rewritten):**
> - **F-51** pinned "the match is the WHOLE string, never a substring" (exact full-name equality,
>   `LauncherShell.tsx:430`). **SUPERSEDED for TYPED queries** by the PO amendment: a typed query
>   matches when, taken AS A WHOLE and case-insensitively, it is a **prefix** of an app's name or a
>   **whole word / contiguous run of whole words inside** it. The "never a fragment of a sentence"
>   half of F-51 stands (it is the `Missing all the time` rule).
> - **R-37** pinned "Enter never opens a tile the text did not exactly name". **SUPERSEDED** by the
>   broadened typed-query rule + "Enter's app-open rule is independent of the companion" (R-37's
>   inactive-companion half — filter-only, no dispatch — stays in force).
> - **F-16 edge (toggle)** pinned "press Ctrl+Space twice — first opens, second closes", and
>   **F-62 / R-20** pinned the cascade (`companion-listen` away, `launcher-listen` when the bar is
>   focused). **SUPERSEDED**: Ctrl+Space now ALWAYS shows/focuses the bar, NEVER starts or stops
>   listening and NEVER closes the bar. F-62's PASS record stands as history; do NOT re-run it.
> - **F-59** pinned "autosend ON + exact tile name launches through the smart-Enter path" for a
>   DICTATED final. **SUPERSEDED** — a dictated transcript is a message to Fredo and never opens an
>   app (`voice-input` F-66..F-69 owns the detail).
> - **F-18 (the #2823 AC-3 carve-out)** is **NOT superseded** — see QA Discussion point QA-1; the
>   carve-out's disposition is an Architect binding, so the tester records the OBSERVED behaviour at
>   that boundary rather than a silent pick.

## F-64 (REQ-7 / AC5) — A typed query opens the app it names: prefix OR whole-word run

- [ ] F-64: Type each of `set`, `Miss`, `miss`, `monitor`, `mission monitor` into
      `input[role="searchbox"]` with REAL keystrokes; record the rendered results order; press Enter.
      Repeat every query with the companion **present / away / off / mid-reply**.
  **Expected:** `set` → the Settings window (`div[role="group"][aria-label="Settings"]`); `Miss` and
      `miss` → Mission Monitor; `monitor` → Mission Monitor; `mission monitor` → Mission Monitor.
      The SAME window opens in ALL four companion states, with ZERO dispatch to Fredo (no
      `runGeneration`) — Enter's app-open rule is independent of the companion. `set` must NOT be
      sent to Fredo (this is the headline defect being fixed).
  - **Edge:** surrounding whitespace (`  set  `); an exact full name; a prefix of a NON-showable
    feature opens nothing; a query that is a whole word inside two names; no aliases (`MM` → F-65).
  - **Receipt:** the quoted results order + the quoted opened-window title + the window count + the
    `runGeneration` count, per query, per companion state.

## F-65 (REQ-8 / AC6) — Matching evaluates the WHOLE query, never a fragment; no aliases

- [ ] F-65: Type `Missing all the time` + Enter, then `MM` + Enter, then the CONTROL `Miss` + Enter,
      then `missing` + Enter. With the companion OFF and AWAY, repeat `Missing all the time`.
  **Expected:** `Missing all the time` is SENT to Fredo (a chat receipt) with ZERO windows **although
      it contains `Miss`**; `MM` is sent to Fredo with ZERO windows (**no aliases** — `MM` does not
      open Mission Monitor); `Miss` OPENS Mission Monitor (the control proving the matcher is not a
      `contains`); `missing` is sent to Fredo; with no active companion and no match the bar stays
      FILTER-ONLY (no dispatch, no launch, the text retained).
  - **Edge:** `Miss all the time` — the first token IS a whole word `Miss`, but the query taken as a
    whole is neither a prefix nor a whole-word run ⇒ Fredo; `mission` (prefix) vs `missing` (neither
    prefix nor whole word); mixed case.
  - **Receipt:** per query — the quoted hint, the observed action, the window count, the chat count.

## F-66 (REQ-7 / clarification #1) — Several matches ⇒ the TOP-RANKED match shown in the results opens

- [ ] F-66: Type `s` (prefix-matches both `Settings` and `Stepper Probe`); DOM-snapshot the rendered
      results list and record its ORDER; press Enter.
  **Expected:** the opened window equals the **FIRST entry of the rendered results order** — quote
      both and show they agree; ZERO dispatch to Fredo. (Ranking source per QA Discussion QA-5 — if
      the Architect binds a different ranking, this row is re-pointed at that source, not deleted.)
  - **Edge:** a second ambiguous query (`r` → `Run CLI`); arrow-selecting a different tile then Enter
    opens the SELECTED tile (the existing keyboard-nav contract), not necessarily the top-ranked one.

## F-67 (REQ-9 / AC6 hint) — The hint always states the action Enter will take, right now

- [ ] F-67: For each state — empty / `set` / `miss` / `monitor` / `Missing all the time` / `MM`
      (active AND inactive companion) / a dictated transcript sitting uncommitted (`Settings`) / a
      DICTATED-THEN-EDITED transcript (`Settings`) / busy / **a live launcher-origin capture** — read
      the hint chip text, the `aria-describedby` mirror `#fredo-command-hint`, and the
      `aria-keyshortcuts` attribute, then press Enter and record the action.
  **Expected:** the hint NAMES the app that will open when the query matches (`↵ open Settings`,
      `↵ open Mission Monitor`) and reads as sending to Fredo when nothing matches OR when the bar
      holds a dictated transcript (chip `↵ send transcript to Fredo`); it never promises a launch for
      content that goes to Fredo and never promises Fredo for content that opens an app; the chip is
      VISIBLE for an app match **even with the companion OFF** (the `chatAvailable` gate is retired —
      QA-8 CLOSED); while a launcher-origin capture is live the chip reads `release Space to finish`
      and **Enter is a no-op** (binding QA-10 — the guard lives in the ST-5 wiring);
      **`aria-keyshortcuts="Control+Space"` is PRESENT and UNCONDITIONAL** (assert it with voice ON
      AND OFF — it must NOT be removed). **Assert the (hint, action) PAIR per state**, not the string
      alone — a hint that disagrees with Enter is the FAIL.
  - **Edge:** busy → `Fredo is replying…`; cleared to empty → no chip; a theme/accent switch re-tints
    the chip without changing its text; the SR mirror equals the chip char-for-char; the hint for the
    edited transcript must tell the truth (REQ-10 / F-68); the `Mission Mon` prefix; `no match` with
    no companion.

## F-68 (REQ-10 / clarification #2) — A dictated transcript is Fredo's, even after the user edits it

- [ ] F-68: Autosend OFF. Hold Space on the focused empty bar; while held inject a synthetic
      `stt:transcript` final `set`; release (the text waits in the bar). EDIT the bar to `Settings`
      with REAL keystrokes; press Enter. CONTROL: fully clear the bar, type `Settings` from scratch,
      press Enter.
  **Expected:** Leg 1 — exactly ONE dispatch to Fredo carrying `Settings`, ZERO windows, and the hint
      reads as sending to Fredo. CONTROL — the Settings window OPENS. **The two legs MUST differ**:
      only text typed from scratch is typed query text; dictation-origin text never runs the
      app-open rule.
  - **Edge:** dictation-origin text edited only by appending a space (`Settings `) ⇒ still Fredo;
    dictated then fully cleared and retyped (`Ctrl+A` + type) ⇒ record the observed classification
    and report expected-vs-actual (QA Discussion QA-4); dictated text that is unmatched after
    editing ⇒ Fredo.

## F-69 (REQ-1 / REQ-2) — Ctrl+Space has ONE meaning; the away-dictate path is retired (launcher surface)

- [ ] F-69: From each of 5 contexts — desktop at rest; a maximized feature window; Mission Monitor
      open; companion AWAY; companion mid-reply — record `document.activeElement`,
      `elementFromPoint(viewCentre)` and `stt_status`, press a REAL Ctrl+Space, and record again.
      Then press Ctrl+Space a 2nd time while the bar is open. Subscribe to `stt:state`.
  **Expected:** the overlay is ON TOP (`elementFromPoint` returns a node inside
      `div[role="dialog"][aria-label="Fredo launcher"]`) and `document.activeElement` is
      `input[role="searchbox"]` in EVERY context; `stt_status.listening === false` and ZERO
      `stt_start` invocations in EVERY context (including companion-away — the retired
      dictate-to-Fredo-when-he-is-away path); the 2nd press leaves the bar OPEN with the caret still
      in it (Ctrl+Space never closes the bar).
  - **Edge:** companion OFF; an already-focused bar; a settings field focused — per the Architect's
    binding (`selectCtrlSpaceAction` = `open|pass`, `'pass'` preserving the shipped #2823 AC-3
    carve-out) the chord is a `pass`-through there; **NOTE: the UI/UX Expert's D1 argument (collapse
    to `open` ALWAYS, PO-amending AC1 if `pass` is kept) is NOT part of the four bound conflicts and
    remains a convergence item — record the observed behaviour alongside the binding and flag any
    divergence rather than failing it**; synthetic-chord focus flakiness (fallback = the notch/focus
    path + record the lever used).
  - **Receipt:** a `stt:state`/`stt_start` subscription across the whole leg showing ZERO listening
    emissions — a single "no cue seen" observation is not sufficient.

### #2882 binding addendum (read before executing F-64..F-69)

- **Exact chip copy** (from the UI/UX truth table — assert these strings char-for-char):
  `↵ open <App name>` on a typed match (visible **even when no companion is present** — the
  `chatAvailable` gate is retired); `↵ send to Fredo` on unmatched typed text with an active
  companion; `↵ send transcript to Fredo` for a **dictated** transcript (including after an edit);
  `no match` for unmatched typed text with no companion; `Fredo is replying…` while busy;
  `release Space to finish` while a launcher-origin capture is live; NO chip on an empty query.
- **`Mission Mon`** is a required match (a longer prefix → Mission Monitor), alongside `set` /
  `Miss` / `monitor` / `mission monitor`.
- **While `companionBusy`, a typed app MATCH still LAUNCHES** (the old `companionBusy` global Enter
  no-op becomes SEND-path-only). A typed NON-match while busy must NOT launch.
- **Enter during a live launcher-origin capture** acts as **nothing** and the chip reads
  `release Space to finish` — the guard is owned by the ST-5 WIRING (the pure `resolveEnterAction`
  does not model `listening`). Assert the (hint, action) pair in that state (QA-10 CLOSED).
- **`aria-keyshortcuts="Control+Space"` is present and UNCONDITIONAL** on the bar (voice ON and OFF)
  — it advertises the bar-opening chord, which still exists; it is NOT removed. The hint mirror
  (`aria-describedby`) carries the CURRENT instruction whenever one exists.
- **All four Architect/UI-UX conflicts are CLOSED against the binding** (see
  `.opencode/tmp/2882/triage.md` `## QA Expert`): (QA-7) the armed empty bar consumes the keydown and
  starts a **bounded 200 ms hold** — a release BELOW the threshold is a **TAP that lands exactly one
  ordinary space** (no capture, no `stt_start`, mic never opened), and a release at/above the
  threshold with the engine **never live** also lands **exactly one ordinary space** on the rise-edge
  cancel; only a **LOST or CONVERTED** space is a FAIL (G-158). (QA-8) the chip is label-driven and
  the #2871 inactive-companion pin (`launcherCommandBarVoice.test.tsx:70-76`) is re-pinned by ST-4.
  (QA-9) blur mid-hold is a STOP that KEEPS the words with autosend suppressed. (QA-10) the
  Enter-during-capture guard lives in the wiring. Assert the bound outcomes — do not reconcile
  against an open question.

### #2882 round 1 — tester run record (`spec/2882 @ f076fa08`, live)

**All rows above PASS.** Verdict + per-REQ values: the `## Tests Runs (round 1)` comment on #2882.
Key receipts: `set`/`Miss`/`monitor`/`Settings` each open the named window with `llmChat:0`;
`Missing all the time`/`MM`/`ission`/`zzqq` never open a window (0 dispatch, text retained);
`ission` still RENDERS `Mission Monitor` (substring filter) yet the chip reads `no match` — the
rule-matched-vs-rendered distinction (`s` → chip `↵ open Settings`, tile index 1, Settings opens)
is verified live. Chip visible with the companion OFF. BEFORE frames (pre-change tip `9e67a88`):
`set` and `monitor` both → `↵ send to Fredo` + 0 windows.

**Lever notes for the next round (do not re-derive):**
- The MCP `keyboard(press, key=" ", Control)` emits `code:" "`, NOT `code:"Space"` — the shell
  correctly matches the physical code, so a **dispatched correctly-shaped `KeyboardEvent`**
  (`key:' ', code:'Space', ctrlKey:true`) is the chord lever; read `document.dispatchEvent()`'s
  boolean return as the `preventDefault` oracle.
- Holding that dispatched chord while a ReactFlow surface is mounted logs one
  `target.hasAttribute is not a function` error from `reactflow.js:3702` (target === document) —
  a **lever artifact**, not a product defect.
- `keyboard(press)` performs NO native text insertion → a non-empty-bar Space cannot be observed
  landing; assert the app's `defaultPrevented` decision (window-level, post-React) + the
  `type`-inserted burst instead. Taps DO land (the app writes the space itself).
- E-43/E-45/E-46 were not driven this round (time-box).

---

## #2883 extension — the bar shows everything typed (wrap, cap, Shift+Enter)

> Issue #2883 makes the launcher bar's input handle text longer than its width: the query WRAPS onto
> visible lines, the Enter hint + collapse/cancel control are never covered, a bounded input height
> then scrolls internally, and `Shift+Enter` inserts a newline (PO clarification #1) without altering
> #2882's Enter contract. **Verification policy: live.** Map 1:1 to `.opencode/tmp/2883/triage.md`
> `## QA Expert` REQ-1/REQ-2/REQ-3 (AC1 + section A), REQ-13/REQ-14 (PO #1), REQ-12/REQ-19
> (the "short content unchanged" restraint legs), REQ-20 (docs), REQ-22 (console/token/theme).
> The reply-side rows (AC2/AC3/AC4/AC5 stable-reading) live in `.opencode/tests/companion/`
> functional F-79..F-90.
>
> **G-136 reconciliation (historical PASS records above are PRESERVED, never rewritten):**
> - **F-52's edge** pinned "long reply wraps in the fixed-height bubble (**no resize**)".
>   **SUPERSEDED** for the reply surface — the reply now grows and scrolls (companion F-79/F-81).
> - **R-38 / R-40's** "command-bar `getBoundingClientRect().y` constant within ±1 px across every
>   state" and **companion F-64** pin the RESTING/short state. **EXTENDED** — for the EMPTY/short/
>   companion-off states the ±1 px invariant still HOLDS (REQ-19 / R-45); it is SUPERSEDED
>   **only for the long-input state**, where the bar is EXPECTED to grow (a long query must not
>   leave the bar a single line). Do NOT fail this spec for bar growth on a long query.
> - **#2882 F-64..F-69 / R-40..R-43** (typed prefix/whole-word Enter rule, hint truth, hold-Space,
>   Ctrl+Space = show+focus) remain IN FORCE and must not change (REQ-14 / R-44).

## F-70 (REQ-1 / AC1) — A query longer than the bar's width wraps onto visible lines

- [ ] F-70: Companion ACTIVE at home. Focus `input[role="searchbox"]` (the field
      `[data-testid="launcher-command-input"]`, now a textarea keeping `role="searchbox"` +
      `aria-multiline="true"`); insert a ~240-char prose query with the insert-text lever;
      `tauri_webview_execute_js` measure the text content box (all rendered line rects of the text
      node) and the field's content box; capture the same frame.
  **Expected:** the query renders on **≥2 visible lines INSIDE the bar box**; every line's right edge
      ≤ the bar's inner right edge; no line extends past the bar's content box (no clipped tail).
  - **Edge:** exactly-full-width text (wraps exactly at the edge, no overflow); a 120-char single
    word with NO spaces (must wrap/chop inside the box, not overflow under a control); an explicit
    newline query; a dictated multi-line transcript; a query pasted (not typed) in one insert.
  - **Receipt:** the quoted line count + each line's rect + the bar rect + the screenshot name.

## F-71 (REQ-2 / AC1) — The Enter hint and the collapse/cancel control are NEVER covered

- [ ] F-71: With F-70's long wrapped query still in the bar, capture **ONE frame containing BOTH the
      wrapped text AND the bar's controls** — the bar `[data-testid="launcher-command-bar"]`, the
      field `[data-testid="launcher-command-input"]`, the Enter hint (`#fredo-command-hint` /
      `[data-testid="launcher-command-hint"]`) and the collapse/cancel control
      (`button[aria-label="Minimize launcher"]` or its successor). In the same task measure
      `getBoundingClientRect` of the text box, the hint, the collapse control, the bar box, and the
      window edges; compute the intersection areas.
  **Expected:** intersection area of the text box with the hint rect = **0** AND with the collapse
      rect = **0**; the text is NOT rendered beneath/crossing either control at ANY input length;
      both controls are fully visible (not clipped, `opacity` 1, inside the bar/window). **Any
      intersection ⇒ FAIL** (G-153 named frame + measured geometry; G-158 — a confirmed overlap is
      a FAIL even if every other row passes).
  - **Edge:** empty input; exactly-full-width; 3× width; after internal scroll; at the height cap
    (F-72, 108 px); the shipped minimum window **900×600** (a 700-wide viewport is a dev-viewport
    advisory only, never a scoring bound); both themes; the collapse control's hover/active state.
  - **Receipt:** the named combined frame + the five rect objects + the intersection areas, per
    input length.

## F-72 (REQ-3 / section A) — Bounded input height, then internal scroll; controls stay put

- [ ] F-72: Grow the bar from one visual line (48 px) past the cap via repeated `Shift+Enter`
      (REQ-13); step-sample the field's (`[data-testid="launcher-command-input"]`)
      `getBoundingClientRect().height`, its `scrollHeight`/`clientHeight`, the hint + collapse rects,
      and the launcher column geometry (notch/grid/hints/clock).
  **Expected:** the field is exactly **48 px** at one visual line (today's height, no scrollbar) and
      STOPS at the bound cap **`BAR_FIELD_MAX_H_PX = 108 px`** (base 48 + 5 lines × 20 + 2 × 14
      padding — the Architect-bound value, not an observed one); beyond the cap
      `scrollHeight > clientHeight` with `overflow-y: auto` (the field scrolls INTERNALLY); the
      hint + collapse rects are unchanged (≤1 px) from just-below-cap; the rest of the launcher
      (notch, grid, hint row, clock/LED) does not move. The cap is a real bound, not an unbounded
      grow.
  - **Edge:** `Shift+Enter` at the cap (still inserts a newline, then scrolls); window resize while
    at the cap (down to 900×600); clearing back to empty (field returns to exactly 48 px, NO
    residual scrollbar / leftover height).
  - **Receipt:** the cap height + the `scrollHeight`/`clientHeight` pair above/below the cap + the
    control rects + the before/after screenshot names.

## F-73 (REQ-13 / PO clarification #1) — Shift+Enter inserts a newline; it never sends or launches

- [ ] F-73: Focused bar; type `line one` (REAL keystrokes); press a REAL `Shift+Enter`; type
      `line two`. Read the input value + the rendered line count + the hint pair; then press Enter
      and record the action.
  **Expected:** the input value (`[data-testid="launcher-command-input"]`) contains an explicit
      newline (`\n`) between the two lines and renders as ≥2 lines; the bound route is **native
      insertion** — the handler returns BEFORE the Enter branch WITHOUT `preventDefault`, so the
      browser inserts the newline and the textarea's `onChange` → `handleQueryChange` carries it
      through the ONE text route (provenance, the hint memo and `onUserEdit` keep working; the caret
      is never disturbed); the `Shift+Enter` press starts **ZERO generations and opens ZERO windows**
      — it NEVER sends or launches; the later Enter acts on the whole (trimmed) query per the #2882
      rule (REQ-14).
  - **Lever fallback (G-161):** the MCP keyboard tool can emit a chord whose `code` does not match
    the handler and performs **no native text insertion**. If a real chord cannot be delivered, drive
    CONTENT with the insert-text lever and judge INTERCEPTION from a correctly-shaped dispatched
    `KeyboardEvent` (`key:'Enter', code:'Enter', shiftKey:true`) — the `dispatchEvent()` return value
    is the `preventDefault` oracle — corroborated by the product unit pin. Record the lever-fidelity
    gap as a **NAMED BLOCKER**; never a product FAIL and never a fabricated PASS.
  - **Edge:** `Shift+Enter` at the height cap; on an EMPTY bar (newline only, still no dispatch);
    with the companion away / off / mid-reply; after a dictated transcript; a newline as the FIRST
    character; `Shift+Enter` immediately before Enter.
  - **Receipt:** the input value verbatim (with the escaped newline) + the line count + the
    `runGeneration` count + the window count.

## F-74 (REQ-14 / PO clarification #1) — Enter's contract is UNCHANGED by this spec

- [ ] F-74: (a) type `set` + Enter; (b) type `Missing all the time` + Enter (companion ACTIVE);
      (c) place a DICTATED transcript in the bar and EDIT it to `Settings`, then Enter; (d) type a
      multi-line query containing newlines, then Enter. Record the window count, the `runGeneration`
      count, and the (hint, action) pair per leg.
  **Expected:** EXACTLY the #2882 shipped contract — (a) the Settings window opens with **0**
      generations; (b) one generation to Fredo with **0** windows; (c) one generation carrying
      `Settings` with **0** windows (a dictated transcript, even edited, is always Fredo's);
      (d) acts on the whole trimmed query per the same rules and **Enter NEVER inserts a newline**.
      Any deviation is a FAIL — this spec must not alter #2882's contract.
  - **Edge:** surrounding whitespace; a prefix that matches one app; `MM` (no alias);
    companion away/off; Enter while busy (the busy rules from F-58 stand).
  - **Receipt:** per leg — the quoted hint, the observed action, the window count, the generation
    count.

## F-75 (REQ-12 / AC5 second half) — Short/empty input renders EXACTLY as today (restraint)

- [ ] F-75: On the AFTER tip and the BEFORE tip (pre-fix, distinct `before-*`/`after-*` dirs per
      G-135): empty query, then `hi`. Measure the field height
      (`[data-testid="launcher-command-input"]`), its `scrollHeight`/`clientHeight`, presence
      of a scrollbar, and the hint/collapse rects.
  **Expected:** within **±2 px** of the BEFORE values; the field is exactly **48 px** at one visual
      line; **no** scrollbar appears (`scrollHeight == clientHeight` for the field); no needless
      resize. A regression here is a FAIL (the restraint leg is explicitly required).
  - **Edge:** one-char input; a short query then cleared; both themes; **900×600** (a 700-wide
    viewport is advisory only).
  - **Receipt:** the BEFORE vs AFTER numbers side by side + both frame names.

## F-76 (REQ-19 / NFR restraint) — No permanent grow/shift of the launcher for short content

- [ ] F-76: On the AFTER and BEFORE tips, measure the launcher geometry in the SHORT/empty state at
      the default size AND the shipped minimum **900×600**: command-bar top, grid/hints position,
      notch/clock rects, seat-slot wrapper (`offsetWidth`/`offsetHeight` + `margin-bottom`), field
      height.
  **Expected:** equal within **±1 px** — the earlier launcher constant-`y` invariant (R-38/R-40) and
      the seat-slot 80×100 + `mb="4"` footprint (R-35) HOLD for the short/empty/companion-off
      states; the field is exactly **48 px** with no new scrollbar; the bar grows ONLY while the
      input is actually long (F-72, up to the 108 px cap) and returns to 48 px when cleared. (A
      700-wide viewport is a dev-viewport advisory only, never a scoring bound.)
  - **Edge:** companion OFF/away; a short query then cleared; a theme switch; a query cleared right
    after being at the cap (no residual height).
  - **Receipt:** the BEFORE/AFTER geometry pairs + the cleared-state re-measure.

## F-77 (REQ-20) — The named stale docs statements are updated in-spec

- [ ] F-77: `Read docs/ARCHITECTURE.md` (~612-613, ~622) and `docs/FAQ.md` (~220, ~224); grep them
      for the stale claims (a fixed-size / does-not-grow reply; a single-line / non-wrapping input).
  **Expected:** all four named stale statements are UPDATED to describe the growing/scrollable text
      reply and the wrapping/multiline input; NO stale statement remains in the named ranges. A
      surviving stale statement ⇒ FAIL. Do NOT change a statement that is still TRUE — the
      **208×268 GAME bubble** (unchanged — R-42) and the **~4 s welcome-bubble auto-hide** (R-44)
      stay as shipped.
  - **Edge:** a statement duplicated elsewhere; a stale claim in a code comment (advisory, not the
    named doc gate).

## F-78 (REQ-22) — Console clean, token-native, both themes while the input is long

- [ ] F-78: After every leg read `tauri_read_logs(source="console")`; static-grep the changed bar
      files for `#[0-9a-fA-F]{3,8}` / `rgba(` / `rgb(` / `hsla(` / `var(--x)NN`; re-theme
      light ↔ dark + a non-default accent while the long wrapped query is visible.
  **Expected:** no `Error:`/`Uncaught`/`Maximum update depth exceeded` (the pre-existing
      `motion() is deprecated` WARN exempt); ZERO hardcoded colour literals (comment issue-refs
      exempt); NO `var(--x)NN` alpha-append (#2770); the bar chrome + text re-tint token-native in
      both themes/accent and stay legible; no effect/memo depending on an array `.length` or a
      freshly created object (AGENTS.md #523). Reference R-43 + F-24.

### #2883 testing round 1 — result (tip `326822ff`)

- [x] Verdict **FAIL** — the bar field never shrank (D-1): an EMPTY field rendered 108 px against
      the 48 px bound; intrinsic content 46 px. Broke F-72's clear edge, F-75, F-76/R-45, E-50.
      All other rows (F-70, F-71, F-73 fallback, F-74, F-77, F-78) passed live.

### #2883 testing round 2 — result (tip `9108bfe4`) — D-1 re-test + regression sweep

- [x] **F-70** PASS — 151-char query wraps in the field content box; `scrollWidth == clientWidth`;
      field grows 48→68→88→108 in 20 px line steps.
- [x] **F-71** PASS — one frame: content box `{460…716}` vs hint `822.3` / collapse `945`;
      intersections 0; both controls visible at every input length (gutter reserved whenever text
      is present, `padding-right 264px`).
- [x] **F-72** PASS — cap 108 (`scrollHeight 166 > clientHeight 106`, `overflow-y auto`); **clear
      to `""` → 48 px, `scrollHeight == clientHeight == 46`, `overflow-y hidden`**; churn
      108→48→108→48 lands on the bounds every leg. (Round 1: stuck at 108.)
- [ ] **F-73** UNVERIFIED — G-161 (MCP keyboard delivers no native chord/insertion). Fallback:
      content `line one\nline two` → 2 lines / 66 px intrinsic; dispatched
      `KeyboardEvent{key:'Enter',code:'Enter',shiftKey:true}` returns `notPrevented: true`;
      0 generations, 0 windows. Pin: `launcherCommandBarVoice.test.tsx`.
- [x] **F-74** PASS — (a) `set` → `↵ open Settings` → Settings panel, **0** `runGeneration`,
      0 new windows; (b) `Missing all the time` → **1** `runGeneration`, 0 windows;
      (d) `line one\nline two\nline three` → 1 generation, 0 windows, no newline inserted.
      (c) UNVERIFIED — no microphone on this host (pin `launcherVoiceDictation.test.tsx`).
- [x] **F-75** PASS — empty/1-char field exactly 48 px, `scrollHeight == clientHeight`, no
      scrollbar (round 1: 108 px).
- [x] **F-76** PASS — empty state: field 48, bar top 446 (1400×900) and **344 (900×600)**, seat
      slot 80×100 — identical to the round-1 fresh-state values.
- [x] **F-77** PASS — the four named doc statements still describe the shipped behaviour
      (`ARCHITECTURE.md:612/616/622`, `FAQ.md:220/224`); 208×268 game card and ~4 s welcome
      bubble unchanged.
- [x] **F-78** PASS — console clean (no `Error:`/`Uncaught`/`Maximum update depth exceeded`);
      static grep of the changed bar/companion files: 0 colour literals, 0 `var(--x)NN`.
      Theme-switch leg UNVERIFIED (not re-driven; token-native static evidence).

---

## #2886 extension — a bar-sent reply never covers Fredo, the tiles or the search bar

> Issue #2886 re-anchors the companion message surface so Fredo stays fully visible: it sits above
> him or to his SIDES, never over him, never over the app tiles / search bar / its field; in a
> genuinely too-small window it SHRINKS and SCROLLS. This file owns the LAUNCHER-SURFACE legs (the
> bar/field/tiles are launcher chrome); the companion-side rows F-91..F-98 own the avatar-footprint
> guarantee. Map 1:1 to `.opencode/tmp/2886/triage.md` `## QA Expert` E3/E4/E7.
> **Verification policy: live** — DOM geometry (`getBoundingClientRect`, both rects in the SAME
> `execute_js` task), retained frames, `tauri_read_logs(source="console")`, and the mandatory
> `telemetry_spans` receipt in `companion` F-98. A static-only PASS is a FALSE PASS.

## F-79 (E4 / AC-4 + amendment (b)) — the reply never covers the search bar, its field or the tiles

- [ ] F-79: Companion ON at the home seat, launcher ENGAGED (tiles + bar + field visible); send a
      long reply. Capture ONE frame containing the reply (`[data-testid="fredo-reply-surface"]`) AND
      the bar chrome; measure the reply vs `[data-testid="launcher-command-bar"]`, the field
      `[data-testid="launcher-command-input"]`, `[data-testid="launcher-command-hint"]`,
      `button[aria-label="Minimize launcher"]` and the tile union box
      (`#fredo-launcher-grid [role="gridcell"]`); compute the intersection areas.
  **Expected:** intersection area = **0** with the bar, the field, the hint, the collapse control AND
      the tiles — at every anchor, every reply length and every window size. **Covering the tiles is
      NOT acceptable** (PO amendment 3). Any collision ⇒ FAIL (G-158).
  - **Edge:** reply anchored above AND to a side; the bar grown by a long multi-line query
    (launcher F-72 cap 108 px); the shipped minimum 900×600; the game bubble open; a resize
    mid-reply; companion away/off (assert no residual surface).
  - **Receipt:** the named combined frame + the five rects + the intersection areas.

## F-80 (E3/E4 / AC-3 + AC-4) — the reply stays entirely on-screen at every edge and size

- [ ] F-80: Teleport Fredo to each screen edge; at the default size, the shipped minimum **900×600**
      and a narrow/tall leg (**900×1000**; a 700-wide viewport is a dev ADVISORY only), send a long
      reply; measure the surface rect + `window.innerWidth`/`innerHeight` (and the avatar rect in
      the SAME task).
  **Expected:** `left ≥ 0 && top ≥ 0 && right ≤ innerWidth && bottom ≤ innerHeight` in EVERY case,
      with `intersectionArea(avatar, surface) === 0` and the separation `dx ≥ S || dy ≥ S` (`S` =
      the Architect-bound minimum separation).
  - **Edge:** near each corner; the grown tier; a resize while displayed; the game card (208×268)
    stays fixed and on-screen too (R-42).

## F-81 (E7 / NF launcher leg) — no CLS / no re-render loop / token-native with a reply shown

- [ ] F-81: Measure the command-bar `getBoundingClientRect().y` + the field height with a reply
      shown vs. cleared (companion ON, at the default size AND 900×600); read the console after
      every leg; static-grep the changed launcher/bar files for `#[0-9a-fA-F]{3,8}` / `rgba(` /
      `rgb(` / `hsla(` / `var(--x)NN`; re-theme light ↔ dark while the reply is visible.
  **Expected:** `|Δy| ≤ 1 px` and the field at the same height as the no-reply baseline (a reply
      must not move or resize the bar); no `Error:`/`Uncaught`/`Maximum update depth exceeded`; no
      effect/memo on array `.length`/freshly-created objects (#523); ZERO colour literals / no
      `var(--x)NN`; the surfaces re-tint token-native. Reference R-45/R-46.

### #2886 testing round 1 — result

> Served checkout: repo root `spec/2886 @ 0ac6b38a` (G-052). `S = REPLY_AVATAR_CLEARANCE = 14 px`.

- [ ] **F-79 (E4) — FAIL (tiles).** Zero bar/field/hint/collapse intersection and full containment in
      every sampled placement, but the **tile union box cannot be measured while a reply is shown**:
      `#fredo-launcher-grid` is removed from the DOM for the entire reply display (436 consecutive
      30 ms samples: 0 gridcells, grid element absent). Per QA Risk 5 the row cannot pass by hiding the
      tiles. Evidence: `F79-tiles-collapsed-with-reply.png`.
- [ ] **F-80 (E3/E4) — PARTIAL.** `onScreen === true` in every leg (1400×900, 900×600, 900×1000, 560×1000,
      700×600, ADVISORY 700×260); `intersectionArea(avatar, surface) === 0` in every sample. The
      separation clause `dx ≥ S || dy ≥ S` FAILS at 1400×900 (min `dy` 8.00), 900×600 (12.80),
      900×1000 (8.04) and the side placement (13.08). Evidence: `F80-900x1000-grown.png`,
      `F80-narrow-700.png`.
- [x] **F-81 (E7) — PASS.** Bar `getBoundingClientRect().y = 446` with a reply shown vs. cleared at
      1400×900 (Δ = 0 ≤ 1 px); console clean after every leg; no colour literals or `var(--x)NN`
      alpha-append in the changed placement/launcher files.

### #2886 testing round 2 — result (all PASS)

> Served checkout: repo root `spec/2886 @ 9fb2d3a8` (G-052). Round-2 fix `d9b227d` (F3 keeps the grid
> mounted while `displayMessage != null`).

- [x] **F-79 (E4) — PASS.** `#fredo-launcher-grid` present with **5 `[role="gridcell"]`** in every
      displayed sample — 77 streaming + 50 post-`llm-done` hold samples @1400×900, 110 @900×600,
      105 @900×1000, 40 in the welcome hold. Tile union box `276,546.5 → 980,658.5` @1400×900;
      `intersectionArea(surface, tileUnion) = 0`; live hit-test on all 5 tile centres returned a
      tile descendant with `pointerEvents: auto`. The grid unmounts only on the dismissal frames after
      the message is gone (expected).
- [x] **F-80 (E3/E4) — PASS.** `onScreen === true` in every leg. Separation now holds: grown `dy`
      16.15–22.05 @1400×900, `dx` 17.78–22.08 @900×600 (deliberate `right` flip), `dy` 16.04–27.48
      @900×1000, base one-liner `dy` 19.99–21.48 / `dx` 19.37–22.07, ADVISORY 700×260 `dx`
      20.83–23.46 (was 13.08).
- [x] **F-81 (E7) — PASS.** Bar `y = 446` in both states (121 with / 180 without → Δ = 0); seat wrapper
      80×100 + 16 px; console clean; token-native.

---

## #2887 extension — the hold starts dictating instantly on the bar (latency + indicator honesty)

> Issue #2887 removes the ~3–5 s "not yet listening" wait on the hold-Space dictation (the recognizer
> is kept ready/resident while Fredo is idle — PO amendment 1) and makes the bar's listening indicator
> honest. This file owns the **bar-surface** legs (the press→capture-active bound measured from the
> command bar, the bar-level cue timeline, the bar text after the opening words); the dictation-domain
> rows live in `.opencode/tests/voice-input/functional.md` F-74..F-82. Map 1:1 to
> `.opencode/tmp/2887/triage.md` `## QA Expert` REQ-1..REQ-4.
> **Verification policy: live** — `tauri_webview_keyboard` with a recorded hold duration +
> `tauri_webview_execute_js` timestamped press marker, DOM/geometry sampling, `tauri_read_logs`,
> `tauri_webview_screenshot`, plus the mandatory `telemetry_spans` receipt (voice-input F-81).
> A static-only PASS is a FALSE PASS.
>
> **Do NOT assume the answers to the open items** — whether the short-hold threshold changes, or how
> the bar acknowledges the hold while readying. Assert only the observable guarantees: no listening
> affordance before capture is genuinely active; no start/prepare state longer than the bound; no
> space lost or converted.
>
> **Test data:** voice enabled + model ready; a reproducible cold fixture (fresh launch;
> the declared idle window; a resident-kill lever); the #2882 space/tap/cancel levers.

## F-82 (REQ-1 / AC1) — press→capture-active measured from the command bar (warm)

- [ ] F-82: With voice enabled + model ready and the bar focused + EMPTY, record the press marker
      (`performance.now()`/`Date.now()`) in the SAME `execute_js` task that dispatches the Space
      `keydown` (correctly-shaped `KeyboardEvent{key:' ',code:'Space'}` or
      `tauri_webview_keyboard(action="down", key=" ")` where it delivers); hold 1500 ms; release.
      Repeat ≥10×. Record the capture-active marker (the FIRST of `stt:state{listening:true}`, the
      audio-stream-open log line, the first cue frame) with its timestamp and WHICH one was used.
  **Expected:** warm `T = t_active − t_press` p50 ≤ 250 ms / p95 ≤ 500 ms / max ≤ 750 ms (the
      architect's `T_FIRST_CAPTURE_BUDGET_MS` governs); raw per-hold numbers quoted; exactly ONE
      `stt_start` per hold; no "not yet listening" interval beyond the bound; the lever + clock domain
      named.
  - **Edge:** auto-repeat keydowns; a hold right after a release; a hold begun while the resident is
    warming; a pre-measurement/fallback frame → disclose raw numbers (G-171); synthetic keydown
    failing to focus → record the lever used.
  - **Receipt:** the raw `T` series + p50/p95/max + the two marker timestamps per hold + the lever.

## F-83 (REQ-3 / AC3) — the bar's cue never claims listening before capture is active

- [ ] F-83: Across ≥10 holds, subscribe to every `stt:state`/`stt:started` emission with timestamps
      and sample the bar cue (`[data-testid="launcher-command-listening"]` dot + chip + placeholder
      `Listening…` + `voice-listening-announcer`) at ≤50 ms cadence from press through release
      + 500 ms.
  **Expected:** the cue is present in ZERO samples BEFORE the capture-active marker; no interval
      > 300 ms (`T_MAX_STARTING_STATE_MS`) shows a start/prepare state while capture is NOT active;
      the state is conveyed as TEXT (chip/placeholder/announcer), never by colour/animation alone;
      once active the cue is continuous (no gap) until release.
  - **Edge:** a never-live hold → NO cue at all + exactly one ordinary space; a typed error is a text
    state, not a stall; rapid re-arm; reduced motion (static CSS pin + NAMED BLOCKER for the live
    `matchMedia` flip); a cue that disappears while the mic is still hot is a FAIL.
  - **Receipt:** the frame-by-frame timeline (time, cue present?, cue text, `stt:state`) for each hold.

## F-84 (REQ-2 / AC2 + REQ-1) — the bar carries the words spoken from the first moment of the hold

- [ ] F-84: With the empty focused bar, dispatch the Space `down` and IMMEDIATELY (same tick / next
      frame) inject the opening marker word through the capture path in use — the deterministic
      16 kHz mono WAV whose first word starts at sample 0, or a real mic (`alpha bravo charlie`
      starting on the press); hold ≥4 s, inject/continue the rest, release. Read
      `[data-testid="launcher-command-input"]`. Repeat 10×.
  **Expected:** the opening word is present in the bar/transcript 10/10; nothing uttered during the
      hold is dropped while the system readies; exactly one commit; the bar stays editable.
  - **Edge:** the word straddling the readiness boundary; a hold whose only word is the opening one;
    pre-existing bar text; dictated-then-edited (still Fredo's — F-68/F-74). **If the only lever is
    the synthetic `stt:transcript` injection, this row is a NAMED BLOCKER for the real capture read
    (never a PASS).**
  - **Receipt:** the bar/transcript verbatim + the hold duration + the fixture hash + the lever.

### Run log — #2887 round 1 (`spec/2887 @ 706fcd9d`, 2026-09-17, live)

**Verdict FAIL** — see `## Tests Runs (round 1)` on #2887 for the full per-AC table, raw URLs and the
`telemetry_spans` receipt. The bar rows were driven on the live command bar
(`textarea[data-testid="launcher-command-input"] role="searchbox" aria-label="Search, launch, or message Fredo"`
— note the durable selector `input[role="searchbox"]` is stale) in the same holds as the
`voice-input` F-74/F-76/F-77 measurement.

- **F-82 (warm press→capture-active from the bar) PASS.** 10 holds, `engineResident:true` 10/10;
  `T` (capture-phase `keydown` `performance.now()` → the `stt:state{listening:true}` receipt, one
  webview clock domain) = **275.3 / 226.4 / 230.5 / 231.5 / 231.4 / 230.4 / 225.4 / 225.5 / 233.7 /
  223.0 ms** ⇒ p50 **230.5** / p95 **275.3** / max **275.3**. Scored against the ARCHITECT's
  `T_FIRST_CAPTURE_BUDGET_MS` (250/300/320) — **this file's `p95 ≤ 500 / max ≤ 750` is a triage-era
  placeholder and was NOT used; the file was not edited.** Exactly one `stt_start` per hold; single
  clock domain; the outlier hold is included (G-171).
- **F-83 (honest bar cue) PASS.** 25 ms in-page sampler over 13 holds: the listening cue
  (`launcher-command-listening` dot + `Listening` chip + `Listening…` placeholder + the announcer)
  appears in **ZERO** samples before capture is active; the first cue frame lands **+15.0 / +17.6 /
  +23.5 ms AFTER** the live `stt:state` receipt; the pre-capture acknowledgement is the TEXT
  `Hold to dictate…`; the `starting voice input…` chip rendered **0/12** times on resident holds and
  only on the not-resident hold (text, 4626.1 ms, honestly bounded by the cold load). Scored against
  `T_MAX_STARTING_STATE_MS` (1000 ms, resident-scoped) — **this file's `> 300 ms` placeholder was NOT
  used.** The cue never disappeared while the mic was hot (0.991–1.0 dot fraction while live).
- **F-84 (bar carries the words) UNVERIFIED (named blocker, G-053).** The deterministic 16 kHz WAV
  (`FREDO_STT_FEED_WAV`) was NOT exercised — the tester cannot set the app's process env var (no
  `dev-env.ps1` passthrough; fresh shell per invocation) and the real mic is the silent virtual
  `Iriun Webcam`. The synthetic `stt:transcript` lever on the real channel carried `alpha bravo
  charlie` into the bar verbatim with exactly one commit; per this row's own rule that is NOT a PASS
  for the capture read. Bar stayed editable (`readOnly:false`) with the hint `↵ send transcript to
  Fredo` under autosend OFF.
- **REQ-8/REQ-9 legs crossing this file:** idle CPU **1.166 % / 1.27 %** of one core over two 60 s
  windows (engine resident) vs the plan's 1 % bound — FAIL (the no-engine baseline is 1.218 %, so the
  resident engine is not the cause); resident delta **112.2 MB** ≤ 350; 10 back-to-back cycles with no
  degradation; 3 cancels clean.

---

## #2893 extension — the Companion opens an app named in a message (bar intake)

> Issue #2893 adds a Companion open-app capability: a message naming a Fredo app (typed via the bar,
> e.g. `open Mission Monitor`, or dictated) is recognized by the Companion, resolved to the feature,
> and its window opens with no further action; the Companion replies that it opened it. This file owns
> the **bar-intake** legs (how the phrase is classified and routed) + the #2882/#2883 direct-matcher
> regression; the skill contract, the reply copy and the stability rows live in `companion`
> F-99..F-105; the CLI legs live in the new `fredo-cli` suite. Map 1:1 to the QA Plan `R-1..R-5`
> (the Architect's EARS ids for AC-1..AC-5). **Verification policy: live** — the insert-text
> lever, DOM/screenshot, the live managed `llama-server`, and the `telemetry_spans` receipt
> (companion F-104). A static-only PASS is a FALSE PASS. **Serving checkout:** the `spec/2893` tip.
> **G-136 reconciliation:** nothing is retired — the #2882 typed whole-query matcher and the
> #2871/#2883 bar contracts remain IN FORCE and are re-asserted by R-54..R-56.

## F-85 (R-1) — A typed `open Mission Monitor` reaches the Companion and the app opens

- [ ] F-85: Companion ACTIVE at home + ready. Insert `open Mission Monitor` into
      `[data-testid="launcher-command-input"]` with the INSERT-TEXT lever; read the hint chip; press
      Enter. Snapshot the DOM + window list after.
  **Expected:** `open Mission Monitor` is NOT the direct #2882 match (the whole query is neither a
      prefix nor a whole-word run of the app name) → the hint reads `↵ send to Fredo`, exactly ONE
      Companion generation starts, and the Companion's open execution opens exactly ONE Mission
      Monitor window whose identity fingerprint (aria-label + header title) is byte-equal to the
      surface the Mission Monitor TILE opens in the same session; the reply text in
      `[data-testid="fredo-reply-surface"]` is EXACTLY `Opening Mission Monitor`; **no further user
      action**; the reply is PERCEIVABLE (not fully occluded by the new window, or displayed before
      the open — record which; bound ordering: the reply is committed first and the open is dispatched
      after `APP_OPEN_REPLY_BEAT_MS = 800` (Architect QA-6)); the bar busy state clears; success uses
      the `happy` beat.
  - **Edge:** `OPEN mission monitor` / `mission-monitor` (id form) / leading+trailing whitespace;
    target already open → re-invoke focuses the SAME window (no duplicate); a second app request with
    the first window open; a reply rendered entirely behind the maximized window = FAIL/UNVERIFIED.
  - **Lever note (G-161):** the MCP `keyboard` tool performs no native text insertion — use the
    insert-text lever; a synthetic-keystroke-only failure is a lever limitation, not a product FAIL.

## F-86 (R-1) — A dictated `open Mission Monitor` opens the app through the Companion

- [ ] F-86: Autosend ON; hold Space on the focused EMPTY bar with the synthetic `stt:transcript`
      final `open Mission Monitor` injected on the real channel; release. Snapshot after.
  **Expected:** the transcript is Fredo's message (the #2882/#2883 dictated rule — it never runs the
      direct app-open matcher), the Companion recognizes the open intent, exactly ONE Mission Monitor
      window opens with no further action, and the reply is EXACTLY `Opening Mission Monitor` with the
      same perceivability check as F-85; 1 generation.
  - **Edge:** autosend OFF + manual Enter; transcript case variants; a dictated transcript naming TWO
    apps (record the observed classification).
  - **Named blocker:** no physical mic on this host → the REAL-capture read is a NAMED BLOCKER
    (G-053); the synthetic-transcript lever carries CONTENT, per the `voice-input` convention.

## F-87 (R-1/R-4 regression) — #2882's direct matcher is UNCHANGED

- [x] F-87: Type each of `set`, `Miss`, `monitor`, `Mission Mon`, `mission monitor` + Enter; then
      `open Mission Monitor` + Enter; then `Missing all the time`, `MM` + Enter; companion ACTIVE and
      OFF. Record per leg: hint chip, generations, windows opened.
  **Expected:** the #2882 contract byte-for-byte — `set`/`Miss`/`monitor`/`Mission Mon`/
      `mission monitor` open the named app with **0 generations** (chip `↵ open <App>`);
      `open Mission Monitor` is a MESSAGE (≥1 generation) and opens the app only through the
      Companion; `Missing all the time` / `MM` → 1 generation, 0 windows; the matcher/evaluation is
      unchanged by this spec.
  - **Edge:** companion OFF/away for every typed query; surrounding whitespace; exact full name; the
    `s` prefix (direct-matcher path → #2882 top-ranked; the Companion path's ambiguity rule is disjoint
    by construction; cross-ref F-88 + Architect QA-3).

## F-88 (R-4) — Unknown / ambiguous requests open NOTHING via the bar

- [ ] F-88: Companion ACTIVE; send `open NotARealApp` + Enter; then an ambiguous request (the
      bound form, or the mocked-registry component pin — Architect QA-8); record window count
      before/after, the reply text, and the console.
  **Expected:** ZERO windows open in BOTH legs; the unknown reply is EXACTLY
      `I couldn't find "NotARealApp"` (unresolved name verbatim, ASCII quotes); the ambiguous reply
      asks which (UI/UX copy); the direct matcher is untouched (the text still filters the grid
      normally); avatar `idle` with no `happy`; desktop stable.
  - **Edge:** gibberish; a typo of a real name; a real non-showable feature id; repeated unknown
    requests; ambiguity = `appNameMatches` candidates > 1 after the R-2.7 normalization (Architect
    QA-3); the live ambiguity leg is a NAMED BLOCKER with a mocked-registry pin.

## F-89 (R-1 NF) — Repeatability + latency + no stuck bar after an open request

- [ ] F-89: Run F-85 five times from a clean state; record opened/not per attempt, the
      request-commit→window-present and request-commit→first-reply-token wall-clock numbers; after
      each, sample `data-streaming`, the cursor, the bar `aria-busy`/`readOnly`.
  **Expected:** the window opens ≥4/5 (Architect-bound, QA-5); raw N/M quoted;
      the target window is present ≤2 s after skill selection (Architect-bound, QA-5; <400 ms perceived
      for a local resolve); after every outcome `data-streaming`
      is absent, the cursor hidden, the bar `aria-busy` false / `readOnly` cleared, and the Companion
      back at rest; no wrong window ever opens.
  - **Edge:** a retry immediately after a missed selection; a request while a generation is in
      flight; a cold managed `llama-server`.

### #2893 testing round 1 (spec/2893 @ 614f26d3) — results

> **Verdict: FAIL.** The typed `open Mission Monitor` reaches the Companion (`runGeneration …
> withSkills: true`) but `adapterBridge.llmChatWithSkills` is unregistered in the Tauri runtime
> entry (`apps/tauri/src/main.tsx`), so the generation ends immediately with no model request, no
> skill selection, no reply, and no window. Console:
> `[adapterBridge] llmChatWithSkills called before adapter registered` →
> `[companion] llm-done received`. Input lever: insert-text (`launcher-command-input` TEXTAREA).

- **F-85 FAIL.** Inserted `open Mission Monitor`; hint chip `↵ send to Fredo` (correct: not a tile
  match); Enter committed (`Message sent to Fredo`), ONE generation started, but NO window opened and
  `[data-testid="fredo-reply-surface"]` stayed null — no `Opening Mission Monitor` reply, no
  perceivability ordering to measure. Screenshot: the resting desktop after the send
  (https://github.com/user-attachments/assets/4197d11f-b72d-4220-a0d7-c488aae8f5f7).
- **F-86 FAIL (same root cause).** The dictated path funnels into the same dead `ask` → no reply/no
  window; the synthetic `stt:transcript` lever was not separately driven because the shared defect
  already makes the assertion impossible (no physical mic = residual named blocker).
- **F-87 PASS (direct-matcher regression).** `set` → hint `↵ open Settings` and the Settings window
  opened; `Missing all the time` → hint `↵ send to Fredo` and ZERO windows. #2882's whole-query
  matcher is unchanged. (`monitor`/`Miss`/`Mission Mon` verified at the resolver level by
  `appIdentity`/`launcherEnterAction` unit pins.)
- **F-88 FAIL (reply half).** `open NotARealApp` opened zero windows, but no
  `I couldn't find "NotARealApp"` reply rendered (the skill path never runs). No guessed/arbitrary open.
- **F-89 FAIL.** Repeatability 0/3 (typed open requests produced 0 opens / 0 replies) — the ≤2 s
  window-present bound is unmet; `data-streaming` absent / bar usable (stability held, but the
  feature did not execute). Raw N/M: **0/3**.

### #2893 testing round 2 (spec/2893 @ 223279d3) — results

> **Verdict: FAIL — non-functional latency only (F-89).** The round-1 wiring defect is fixed: every
> typed/dictated open request now reaches the model and the `open_app` skill executes. All functional
> rows PASS; F-89's latency clause fails. Input lever: insert-text (`launcher-command-input` TEXTAREA).

- **F-85 PASS** (was FAIL). Typed `open Mission Monitor` → hint chip `↵ send to Fredo`; Enter
  committed; ONE Mission Monitor window opened (DOM `.fredo-window__surface` count 0→1; the app's
  feature windows are in-webview DOM windows, not OS windows — `tauri_manage_window list` shows only
  the native `main` window, so the DOM count + dock entry are the correct observable); reply in
  `[data-testid="fredo-reply-surface"]` EXACTLY `Opening Mission Monitor`; success beat `happy`;
  window closed by its own `Close` control between legs. Identity fingerprint aria-label+header =
  `Sessions`/`FSessions` — byte-equal to the CLI-opened surface (F-89/Q-5 image).
- **F-86 PASS** (was FAIL). Autosend ON: `stt_start{origin:"launcher"}` → synthetic
  `stt:transcript` final (`{sessionId:"tester-2893-q2",revision:1,text:"open Mission Monitor",isFinal:true}`,
  the L3 lever) → `stt_stop` auto-committed exactly ONE generation → reply EXACTLY
  `Opening Mission Monitor` + one window, identical to F-85. (#2888 normalization rendered the bar
  text `Open mission monitor` and the resolver still resolved it.) **Physical-mic real capture
  remains a NAMED BLOCKER.**
- **F-87 PASS.** `set` → hint `↵ open Settings`, Settings window opened, **0** generations;
  `Miss` → hint `↵ open Mission Monitor`, 0 generations, no duplicate window;
  `monitor` → hint `↵ open Mission Monitor`, 0 generations, no duplicate;
  `Missing all the time` → hint `↵ send to Fredo`, 1 generation, 0 windows;
  `MM` → hint `↵ send to Fredo`, 1 generation, 0 windows. #2882's whole-query matcher is unchanged.
- **F-88 PASS** (was FAIL). `open NotARealApp` → ZERO new windows; reply EXACTLY
  `I couldn't find "NotARealApp"`; avatar `idle` (no `happy`); exactly ONE generation. The live
  ambiguous leg stays a NAMED BLOCKER (one addressable app).
- **F-89 FAIL (latency clause only; all other clauses PASS).** The window opens — repeatability
  **5/5** typed runs (raw 5/5) and 2/2 dictated; but **window-present = 3003 ms after skill
  selection** (also 2601/2995/3008/3003 ms across four clean runs) vs the Architect bound
  **≤2000 ms**, and the main thread is **unresponsive for 2180 ms** during the open (`setInterval`
  10 ms sampler gap). Ordering clauses hold: reply committed **9 ms** after `llm-skill-call`,
  open dispatched (`app-open-request`) **823 ms** after skill selection (the intentional
  `APP_OPEN_REPLY_BEAT_MS = 800`), `aria-busy` clears, companion back at rest. Root cause = the
  Mission Monitor window mount long task (~2.18 s) in the served dev artifact (Vite + StrictMode);
  the open dispatch itself is inside the bound. **This is the round's only failing row.**

### #2893 testing round 3 (spec/2893 @ cf25127c) — results

> **Verdict: PASS.** The RD-1..RD-4 cost-only fix (`rowDerivation.ts` WeakMap `rawJson` parse memo +
> source guard, duplicate tool-summary removed, plain comparator) landed the Q-15 row. Served tip
> `spec/2893 @ cf25127c` (full stop/start after the tip change). Input lever: insert-text
> (`launcher-command-input` TEXTAREA) + dispatched Enter (`prevented=true`).

- **F-85 PASS (re-confirmed).** Typed `open Mission Monitor` → hint `↵ send to Fredo`; ONE window
  (`Sessions` / `FSessions`, byte-equal fingerprint); reply EXACTLY `Opening Mission Monitor`;
  success beat `happy`; ordering: reply committed +10…+24 ms after `llm-skill-call`, open dispatched
  +819…+827 ms (the 800 ms beat), window present +870…+1132 ms.
- **F-86 PASS (re-confirmed).** `stt_start{origin:"launcher"}` → synthetic final `stt:transcript`
  (`text:"open Mission Monitor", isFinal:true`) on the real channel → `stt_stop`; bar normalised to
  `Open mission monitor`; exactly ONE generation; reply EXACTLY `Opening Mission Monitor`; one window.
  **Physical-mic real capture remains a NAMED BLOCKER.**
- **F-87 PASS (re-confirmed).** `set` → hint `↵ open Settings`, Settings window, 0 generations;
  `Miss` → `↵ open Mission Monitor`, 0 generations, no duplicate; `monitor` → `↵ open Mission Monitor`,
  0 generations, window count stayed 1; `Missing all the time` / `MM` → `↵ send to Fredo`, 1 generation,
  0 windows. #2882's whole-query matcher unchanged.
- **F-88 PASS (re-confirmed).** `open NotARealApp` → ZERO new windows; reply EXACTLY
  `I couldn't find "NotARealApp"`; avatar `idle` (no `happy`); exactly ONE generation. Live ambiguity
  leg stays a NAMED BLOCKER (one addressable app).
- **F-89 PASS** (was FAIL — latency clause only). Repeatability **5/5** typed (raw 5/5) + no duplicate
  on re-open. **window-present ≤2000 ms after skill selection: MET** — raw series
  **888 / 1132 / 1128 / 1103 / 1099 / 1097 / 1105 ms** (7 pre-restart clean runs) + **870 ms**
  (fresh restart). Open-phase max main-thread gap (10 ms sampler, skill→window):
  **313.6 / 314.6 / 282.8 / 284.6 / 285.4 / 287.4 / 57.0 ms** — **no ≥500 ms gap during the open**
  (bound clause met). Reply +10…+24 ms; open dispatch +819…+827 ms (the intentional
  `APP_OPEN_REPLY_BEAT_MS = 800`); `aria-busy` clears on `llm-done`; companion back at rest.
  **Disclosed raw (G-171):** post-open gaps ~600–642 ms at ~+1.8 / +3.1 / +6.6 s (outside the open
  window); an idle-with-Mission-Monitor-open control measured a max gap of **11.5 ms** over 4.0 s.
  Derive output parity: same 2 sessions / 4 react-flow nodes / 3 edges and the same window
  fingerprint as round 2 — no session/node lost or reordered.

---

## #2892 extension — the bar stays editable and a send during a reply is never lost (G-136)

> Issue #2892 decouples the "Fredo is replying…" status from the read-hold (`replyInFlight` vs
> `isInUse`), removes the reply-state `readOnly` block, and turns a send during a reply into an
> accepted queue (default) or an interrupt. Domain rows: `companion` F-106..F-115 /
> `settings` F-41..F-47. **Verification policy: live** — mandatory receipt F-99; a static-only PASS is
> a FALSE PASS.
> **G-136 supersession (history preserved):** **F-55**'s "extra submits ignored (default)" clause and
> **F-58**'s "busy → input READ-ONLY, Enter no-op" clause are SUPERSEDED (the input is never read-only
> from reply state; a 2nd send is accepted + queued). **F-52/F-53** (reply stream completion/error)
> and the #2882 matcher/hint contract remain IN FORCE.
> **Test data:** companion ON at the home seat, model present, deterministic
> `Reply with exactly: Hi there!`, and `Write 400 words about the history of the bicycle.` as the
> streaming reply.

## F-90 (REQ-1 / AC1) — the bar is editable with a reply on screen (streaming AND completed-held)

- [ ] F-90: L1 + L2: with a completed reply displayed, hover it, click the bar, type `abc`; then with
      a streaming reply, click the bar and type during the stream. Read `readOnly`, `disabled`,
      `document.activeElement`, and `.value` after each.
  **Expected:** `document.activeElement` is the bar field on click; `.value === "abc"` in BOTH states;
      `readOnly === false` and `disabled === false` — no reply state ever writes `readOnly`.
  - **Edge:** caret placed mid-text; game bubble open; typing while scrolled back in a long reply.

## F-91 (REQ-2 / AC2) — hover/focus changes ONLY the hold window

- [ ] F-91: with no generation in flight, hover then keyboard-focus the reply; sample the placeholder,
      `aria-busy`, `data-streaming`, and the Enter outcome for a non-tile query — before, during, after.
  **Expected:** only the hold-open duration changes; the placeholder is the resting copy (NEVER
      `Fredo is replying…`); `aria-busy` is absent/false; a non-tile Enter still dispatches.
  - **Edge:** hover churn; hover during streaming; focus then pointer on the same bubble.

## F-92 (REQ-3 / AC3) — the replying status is true iff in flight; it clears at settle with the pointer resting

- [ ] F-92: while `data-streaming` read the placeholder + `aria-busy`; at `llm-done`, with the pointer
      still resting on `[data-testid="fredo-reply-surface"]`, re-read both while the reply stays visible.
  **Expected:** streaming -> placeholder EXACTLY `Fredo is replying…`, `aria-busy="true"`; at settle ->
      resting placeholder, `aria-busy` false/null, reply still displayed.
  - **Edge:** error settle; watchdog settle; TicTacToe streaming; settle during the happy hold.

## F-93 (REQ-5 / AC5) — default `queue`: accepted, visibly waiting, FIFO auto-dispatch exactly-once

- [ ] F-93: L3: default disposition; start the long stream; while streaming send
      `Reply with exactly: alpha`, then `beta`, then `gamma`.
  **Expected:** each accepted (bar clears); `[data-testid="launcher-command-queued"]` present with text
      EXACTLY `Queued — waiting for Fredo…`; on each settle the next prompt dispatches; the replies
      arrive in order `alpha`, `beta`, `gamma`, each exactly once; the indicator clears when empty.
  - **Edge:** 3 rapid sends; send at the settle race; send during the happy hold.

## F-94 (REQ-7 / AC6) — `interrupt`: supersede the in-flight reply and dispatch the new message

- [ ] F-94: L4: set `interrupt`; start the long stream; send `Reply with exactly: INTERRUPTED`; wait
      at least 6 s.
  **Expected:** the settled reply is EXACTLY `INTERRUPTED`; the superseded stream stops appending; the
      new reply is NOT cleared by the superseded generation's 5 s hold timer; no queued indicator.
  - **Edge:** interrupt near settle; interrupt during the error hold; repeated interrupts.

## F-95 (REQ-8 / AC7) — clear only on acceptance; no phantom clear

- [ ] F-95: L5: companion OFF (and again away) -> type a non-tile phrase -> Enter; plus the component
      pin of `commitBarQuery` with `askActiveCompanion` returning `{ outcome: 'rejected' }`.
  **Expected:** OFF/away/rejected leave the bar text UNCHANGED (no clear, no generation); ONLY
      `dispatched` or `queued` clears the bar.
  - **Edge:** no entity; rejected; empty query; game bubble open.

## F-96 (REQ-1 / AC1 + #2882) — Enter's rule is unchanged: no "busy" gate, typed non-match still sends

- [ ] F-96: with the companion ACTIVE and a reply streaming, type `set` + Enter (exact tile) and then a
      typed non-match phrase + Enter; sample the window count and the generation count.
  **Expected:** `set` OPENS Settings with 0 generations; the typed non-match is SENT with 1 generation
      and 0 windows (the #2882 rule survives); no tile is launched mid-stream (the old busy
      fall-through must not return).
  - **Edge:** exact name while streaming; substring match while streaming; Enter during the happy hold.

## F-97 (REQ-3 / AC3) — the hint stays truthful while a reply is in flight

- [ ] F-97: while streaming, read the hint chip for an empty query, an exact tile name, and a non-tile
      phrase; separately hold Space on the empty bar while streaming.
  **Expected:** the hint always states the action Enter would take right now; the live-capture
      precedence row may read `Fredo is replying…` but the `busy` source is `replyInFlight`, so a
      completed held reply never shows it.
  - **Edge:** companion away/OFF mid-hint; theme switch while the hint is visible.

## F-98 (NF) — exactly-once under rapid sends; no silent drop

- [ ] F-98: L6: under `queue`, fire 5 rapid sends during one stream; count the replies and the indicator
      samples; repeat at six-fold speed.
  **Expected:** exactly 5 distinct replies, in order, each once — none dropped, none duplicated, no
      double generation; the indicator count tracks the queue size.
  - **Edge:** Enter spam; send at the settle boundary; unmount/teleport mid-queue.

## F-99 (REQ-LIVE / NF) — Mandatory `telemetry_spans` + rendered-webview receipt

- [ ] F-99: same run as F-90..F-98: `fredo emit --event-type chat --session-id e2e-2892-chat` +
      `--event-type tool_use --session-id e2e-2892-tool --tool-name read_file`; query
      `telemetry_spans` + `chat_rows`/`tool_use_rows` (telemetry-query skill).
  **Expected:** `telemetry_spans` NON-ZERO with a recent `max(ingested_at)`; both markers classify;
      every live row carries a rendered receipt. **A static-only PASS is a FALSE PASS.**
  - **Edge:** re-run on the tested tip; keep the emit + query output verbatim.

## F-100 (NF) — token-native, console clean, no re-render loop, build gates

- [ ] F-100: static-grep the changed launcher files for `#[0-9a-fA-F]{3,8}` / `rgba(` / `rgb(` /
      `hsla(` / `var(--x)NN`; read the console after every leg; inspect the new clear/queue/hint code
      for effect/memo deps; run `pnpm --filter @fredo/ui build` + `test:run`.
  **Expected:** ZERO colour literals / no alpha-append; no `Error:`/`Uncaught`/`Maximum update depth
      exceeded`; no re-render loop (#523); build exit 0; suite green with no weakened assertion
      (refreshed ones owned per G-125).
  - **Edge:** theme switch mid-stream; reduced motion (static pin + named blocker).

### #2892 testing round 1 — result

> Round 1 @ `spec/2892 bf3b3e80`: **FAIL** (driver-cadence gaps + the AC9 settings clamp; the
> core bar behavior passes). Detail in `.opencode/tmp/2892/tests-runs.md`.

- **F-90 PASS (live).** Streaming + completed-held: `readOnly=false`, `disabled=false`; typed mid-stream and with a reply on screen; focus stayed in the TEXTAREA.
- **F-91 PASS (live).** Hovering a completed reply changed only the hold window — resting placeholder, no `aria-busy`, no send gate.
- **F-92 PASS (live).** Streaming placeholder EXACTLY `Fredo is replying…` + `aria-busy="true"`; cleared at settle with the pointer resting while the reply stayed displayed.
- **F-93 PARTIAL (live).** Accepted sends cleared the bar; `[data-testid="launcher-command-queued"]` was found live; drain announcer fired; a queued `alpha` auto-dispatched to reply `alpha`. The exact on-screen literal was not captured (sub-second queue window vs driver cadence) — pinned by `companionDispatch.test.ts` + `launcherCommandBarVoice.test.tsx`.
- **F-94 UNVERIFIED (live).** 3 attempts; each console read `runGeneration called — … isGenerating: false` (send landed 0.2–0.3 s after `llm-done`). Pinned by `companionDispatch.test.ts` + `CompanionEntity.dispatch.test.tsx`.
- **F-95 PASS (live).** Companion OFF: `hello there friend` + Enter preserved the text, no generation.
- **F-96 PASS (live).** No "busy" send gate: typed sends dispatched while a reply was on screen.
- **F-100 PASS (static/build).** Zero colour literals / no `var(--x)NN` in the changed launcher files; build + full suite green; console clean.

### #2892 testing round 2 — result

> Round 2 @ `spec/2892 7e93892f` (cold-started dev app). **PASS.** The round-1 harness gaps
> (sub-second queue window vs driver cadence) were closed by driving the two sends **in one in-page
> async script** (`execute_js`) / a real-keyboard second send against a deliberately long first
> generation, rather than two serial driver round-trips (~6 s each).

- **F-90 PASS (live).** Streaming: `readOnly=false`, `disabled=false`, placeholder `Fredo is replying…`, a DIV carries `aria-busy="true"`; typed `abc`/`next message` into the bar with a reply on screen — value accepted, focus stayed in the field. Screenshot `r2-ac1-editable.png`.
- **F-91 PASS (live).** Pointer resting on a completed reply: placeholder `search, or hold Space to dictate`, no `[aria-busy]` element, `readOnly=false`; only the hold window changed (bubble persisted). Screenshot `r2-ac2-ac3-hover-resting.png`.
- **F-92 PASS (live).** Streaming `aria-busy="true"` + replying placeholder; at settle with the pointer resting on `[data-testid="fredo-reply-surface"]` the placeholder/`aria-busy` cleared while the reply stayed displayed. Same screenshot as F-91.
- **F-93 PASS (live, decisive).** Long first generation (`count from 1 to 500, one number per line`); while streaming, the second prompt was sent in-page. `[data-testid="launcher-command-queued"]` read **EXACTLY** `Queued — waiting for Fredo…` (the hidden `launcher-queued-announcer` carried the same literal), the bar cleared, and on the first generation's settle the queued item auto-dispatched to reply `alpha` (exactly once) with the indicator clearing. Screenshot `r2-ac5-queued-literal.png`.
- **F-94 PASS (live, decisive).** Disposition `interrupt`; long first generation (>1 s in flight); second prompt `Reply with exactly: INTERRUPTED` sent via real keyboard while the count still streamed. The bubble content was REPLACED by the new generation and settled **EXACTLY** `INTERRUPTED`; `queuedSeen=false` (no queued indicator at any sample); superseded count tokens never appended. Screenshot `r2-ac6-interrupted.png`.
- **F-95 PASS (live).** Companion OFF: `hello there friend` + Enter left the bar value UNCHANGED, no generation, `no match` hint, avatar unmounted. Screenshot `r2-ac7-preserved.png`.
- **F-96 PASS (live).** No busy send gate: typed sends dispatch while a reply is on screen.
- **F-99 PASS (live).** `telemetry_spans` = 11336, `max(ingested_at)=2026-09-18T20:59:30.4Z`; `chat_rows`/`tool_use_rows` markers (`e2e-2892-r2-chat`/`-tool`) each = 1.
- **F-100 PASS (static/build/console).** Zero colour literals in the changed launcher/companion TSX; console clean (only the pre-existing `motion() is deprecated` WARN); round-1 `pnpm` build/test gates unchanged (the fix touched only `CompanionSettingsPanel.tsx` + its test).
- **Harness note (promoted technique):** the AC5/AC6 in-flight legs are ONLY reachable by issuing both sends in a single in-page script (or a real-keyboard second send against a long generation) — two serial driver round-trips are ~6 s each and always land after `llm-done`. Recorded in `exploratory.md` round 2.

---

## #2904 extension — launcher search-bar / listening-indicator clean-render (live)

> Issue #2904 (revises #2897, `intent: fix`) — while dictating, a stray `Fredo…` string rendered
> VERTICALLY (one letter per line) in/near the app search bar, overlapping the input. The slice
> removes the visual glitch and guarantees clean rendering in BOTH speech-handling modes with NO
> redesign of the search bar or the listening indicator. Surfaces in `LauncherCommandBar.tsx`:
> model mode → `launcher-command-model-listening-chip` (`Fredo is listening`) is the SOLE listening
> claim; the `release Space to finish` hint chip is suppressed while a model chip is up and the
> instruction relocates into the field placeholder (`release Space to finish`) [AC2 resolution =
> Architect contract, see `.opencode/tmp/2904/triage.md`]; local mode →
> `launcher-command-listening-chip` (`Listening`) + the
> `Listening…` placeholder + the `release Space to finish` hint chip (unchanged); the field is a `<textarea role="searchbox"
> data-testid="launcher-command-input">`; the dot is `launcher-command-listening`.
> **Verification policy: live** — pure rendering. Live evidence = `tauri_webview_dom_snapshot` +
> `tauri_webview_screenshot` + `getBoundingClientRect`/`getComputedStyle`/`execute_js` scans +
> `upload-evidence` raw URL, PLUS the mandatory `telemetry_spans` liveness receipt (F-107). A
> static-only PASS is a FALSE PASS. Map 1:1 to `.opencode/tmp/2904/triage.md` `## QA Expert`
> (REQ-1..REQ-5 + NFR-1 + REQ-LIVE).
> **Dictation lever:** the sanctioned in-repo capture feed `FREDO_STT_FEED_WAV`
> (`.opencode/tests/voice-dictation/fixtures/dictation-phrase-16k-mono.wav`; content = liveness
> only, never speech). Inject with the WORKING string form
> `dev-env.ps1 -Action Up -Spec 2904 -EnvVar "FREDO_STT_FEED_WAV=<abs path>"`; ALWAYS pair with an
> UNSET-env control. The `-EnvVars @{}` hashtable form is BROKEN (tooling gap; `voice-dictation` F-6).
> **Reference images (Read by EXPLICIT absolute path, NEVER glob):**
> `C:\Code\fredo\.opencode\wireframes\desktop-light.png`,
> `C:\Code\fredo\.opencode\wireframes\desktop-light-dark-theme-compare.png`. There is NO #2904 bug
> screenshot — capture a fresh one under `.opencode/tmp/2904/e2e/`.

### Shared probe (used by F-101/F-103/F-105) — vertical-wrap + overlap signature

Run in ONE `execute_js` task while dictating; return JSON:

```js
(() => {
  const bar = document.querySelector('[data-testid="launcher-command-bar"]');
  const field = document.querySelector('[data-testid="launcher-command-input"]');
  const rect = (el) => { const r = el.getBoundingClientRect();
    return { x:r.x, y:r.y, w:r.width, h:r.height, right:r.right, bottom:r.bottom }; };
  const inter = (a,b) => Math.max(0, Math.min(a.right,b.right)-Math.max(a.x,b.x)) *
                          Math.max(0, Math.min(a.bottom,b.bottom)-Math.max(a.y,b.y));
  const visible = (el) => { const s = getComputedStyle(el); const r = el.getBoundingClientRect();
    return s.display!=='none' && s.visibility!=='hidden' && +s.opacity>0 &&
           r.width>1 && r.height>1 && s.clipPath==='none'; };
  const nodes = [...bar.querySelectorAll('*')].filter(visible).map((el) => {
    const t = (el.childElementCount===0 ? (el.textContent||'') : '').trim();
    if (!t) return null;
    const s = getComputedStyle(el); const r = el.getBoundingClientRect();
    return { testid: el.getAttribute('data-testid'), text: t.slice(0,60),
      w:+r.width.toFixed(1), h:+r.height.toFixed(1), whiteSpace: s.whiteSpace,
      wordBreak: s.wordBreak, writingMode: s.writingMode,
      verticalWrap: r.height > r.width && t.length > 3,
      narrow: r.width < 20 && t.length > 3, rect: rect(el) };
  }).filter(Boolean);
  const fs = getComputedStyle(field);
  const contentW = field.getBoundingClientRect().width
    - parseFloat(fs.paddingLeft) - parseFloat(fs.paddingRight)
    - parseFloat(fs.borderLeftWidth) - parseFloat(fs.borderRightWidth);
  return JSON.stringify({ innerWidth: window.innerWidth,
    fieldClientW: field.clientWidth, fieldScrollW: field.scrollWidth,
    fieldContentW: +contentW.toFixed(1), fieldPaddingEnd: fs.paddingRight,
    placeholder: field.getAttribute('placeholder'), bar: rect(bar), field: rect(field),
    chips: [...bar.querySelectorAll('[data-testid^="launcher-command-"]')].map((e)=>({
      testid:e.getAttribute('data-testid'), text:(e.textContent||'').slice(0,60), ...rect(e) })),
    overlapField: nodes.filter(n => inter(n.rect, rect(field)) > 0).map(n => n.testid || n.text),
    nodes });
})()
```

**FAIL signature (the bug):** any visible node with `verticalWrap:true` or `narrow:true`, OR a
non-empty `overlapField`, OR `field.scrollWidth > field.clientWidth + 2`, OR a `writingMode`
starting `vertical`, OR — the **decisive model-audio collapse signal** — `fieldContentW < 140` while
the model capture chip is live. **The placeholder is NOT in `textContent`, so the node scan alone
cannot see a stacked placeholder; `fieldContentW` is what catches it.** The PRE-FIX composition
(collapse) was a `560px` bar minus the `40px` leading gutter minus the reserved end padding
`220 (hint) + 208 (model chip) + 30 + 30 (cancel/stop) + 44 (minimize) = 532px` → ~0px content box.
The FIXED composition suppresses the hint chip in model mode (REQ-3), so the model reservation is
`208 (model chip) + 30 + 30 + 44 = 312px` and the field content box is ~206px (floor
`MIN_FIELD_CONTENT_PX = 140`, which fits the `release Space to finish` placeholder on one line).

## F-101 (REQ-1 / AC1) — model-audio dictation: no stray/vertical text in or near the bar

- [ ] F-101: Mode=`model` (`companion-voice-handling-select` → `Model audio`), managed server
      healthy; focus the empty `[data-testid="launcher-command-input"]`; drive a LIVE capture with
      the in-repo `FREDO_STT_FEED_WAV` feed (or, only if the server is unavailable, the synthetic
      `stt:state {listening:true, phase:"capturing", origin:"launcher"}` fallback). While the
      `Fredo is listening` chip is visible run the **Shared probe** + `tauri_webview_screenshot`.
  **Expected:** the probe returns ZERO visible node with `verticalWrap:true` / `narrow:true` /
      `writingMode` starting `vertical`; the ONLY element stating a listening claim is
      `launcher-command-model-listening-chip` = `Fredo is listening` on ONE line; the
      `release Space to finish` hint chip is NOT rendered while a model chip is up (REQ-3) — the field
      placeholder carries the instruction (`release Space to finish`);
      `fieldScrollW ≤ fieldClientW + 2` AND **`fieldContentW ≥ 140`** (the placeholder fits on ONE line —
      the decisive model-leg collapse signal, since the placeholder is NOT in `textContent`); the
      search input renders cleanly (value/placeholder fully inside its content box); the screenshot
      shows no letter-per-line string.
  - **Edge:** 560px bar AND a narrow (<600px) bar; the countdown copy
    `Fredo is listening · 10s left`; a NON-EMPTY query in the field; the bounded
    `starting voice input…` chip must not stack either.
  - **Receipt:** the raw probe JSON (nodes + overlapField) + the screenshot + the feed receipt
    (`{deviceName:"stt-feed", sampleRate:16000}`) / the UNSET-env control.

## F-102 (REQ-2 / AC2) — the listening indicator is the ONLY listening-related text, on one line

- [ ] F-102: While dictating (F-101 leg), enumerate every VISIBLE text node in the launcher subtree
      matching `/listening|release Space|Fredo/i`; record element/testid, text, line count
      `= round(rect.height / lineHeight)`, `whiteSpace`, `writingMode`.
  **Expected:** EXACTLY ONE visible listening indicator per session (model:
      `launcher-command-model-listening-chip`; local: `launcher-command-listening-chip`); it is
      `whiteSpace:nowrap` and line count = 1; NO second visible `Fredo…` / straggler; the SR-only
      announcers (`voice-listening-announcer`, `voice-transcript-announcer`) are clipped (≤1px,
      `clip-path: inset(50%)`) and NOT visible.
  - **Edge:** start→capturing→processing; the below-bar hearing-nothing / limit notice present; in
    LOCAL mode a hint chip (`launcher-command-hint`) is present alongside the capture chip — still
    exactly ONE listening indicator (never two); in MODEL mode the hint chip is suppressed and the
    instruction relocates to the placeholder (REQ-3).

## F-103 (REQ-3 / AC3) — indicator and search input do not overlap or clip at the default size

- [ ] F-103: At the default window size, while dictating, compute `intersectionArea(field, chip /
      dot / controls)` and the containment of every visible bar child inside the bar rect.
  **Expected:** `intersectionArea(field, listeningIndicator) === 0` and
      `intersectionArea(field, any visible text node) === 0`; the reserved end gutter
      (`computeEndPaddingPx` model-listening = 208+30+30+44 = **312px** once the hint chip is
      suppressed in model mode, REQ-3) keeps **`fieldContentW ≥ 140`** (the Architect/UI-UX
      `MIN_FIELD_CONTENT_PX` floor — `field.clientWidth > 0` alone is insufficient because the end
      padding collapses the CONTENT box) and the chip fully inside the bar (no frame clip); chip right
      edge ≤ bar right edge; the typed text never runs under the chip.
  - **Edge:** a query present; the countdown chip; Cancel + Stop present; the `processing` chip
    (`Fredo is processing your speech…`).

## F-104 (REQ-4 / AC4) — both speech-handling modes + both themes render cleanly

- [ ] F-104: Repeat F-101..F-103 with mode=`local` (shipped `Listening` chip + `Listening…`
      placeholder + `release Space to finish` hint chip) AND mode=`model` (`Fredo is listening` chip +
      `release Space to finish` placeholder, hint chip suppressed);
      run each in a LIGHT preset (`light-default` via the shipped `select[aria-label="Theme presets"]`)
      AND the DARK base (`dark`/`classic`). Do NOT invent a toggle (G-050).
  **Expected:** BOTH modes — exactly ONE horizontal indicator, ZERO vertical/stray text, no
      overlap/clip. BOTH themes — identical geometry with token-native colors and legible contrast;
      the selector copy (`Local transcription`/`Model audio`) unchanged.
  - **Edge:** the mode selected between sessions (a mid-capture switch is out of scope); the model
    `processing` chip; light `light-default` + dark `dark` + `classic`; a non-cyan accent preset.

## F-105 (REQ-5 / AC5) — resizing never reintroduces vertical/overlapping text

- [ ] F-105: While dictating, run the **Shared probe** at 1920×1080 → 1440×900 → 900×600 (shipped
      minimum) + a 700×900 dev viewport; record `window.innerWidth` per sample.
  **Expected:** at EVERY sampled width ZERO vertical/stacked text, `overlapField` empty, no
      clipping; the indicator stays on ONE line or truncates with an ellipsis (NEVER one char per
      line); the bar re-centers; re-widening restores the clean render.
  - **Edge:** the narrowest supported width; fractional OS scale/zoom (125%); resize DURING the
    countdown; resize during `processing`.

## F-106 (NFR-1) — token hygiene / console clean / no re-render loop

- [ ] F-106: Static-grep the changed launcher files for `#[0-9a-fA-F]{3,8}`, `rgba(`, `rgb(`,
      `hsla(`, `var(--x)NN`; re-theme live while dictating; read
      `tauri_read_logs(source="console")` after every leg.
  **Expected:** ZERO hardcoded color literals (comment issue-refs exempt) and NO `var(--x)NN`
      alpha-append; colors flow `var(--...)`/`tint()`/semantic tokens; no `Error:`/`Uncaught`/
      `Maximum update depth exceeded`; no effect/memo on an array `.length` or a fresh object
      (#523); the indicator re-tints with the live accent.
  - **Edge:** re-theme mid-capture; rapid resize churn; the pre-existing `motion() is deprecated`
    WARN is exempt.

## F-107 (REQ-LIVE) — live liveness receipt (policy gate)

- [ ] F-107: After a real dictation session, query `telemetry_spans` (telemetry-query skill) and
      capture a rendered-webview screenshot; upload via `upload-evidence --issue 2904`; embed BOTH
      in `## Tests Runs`.
  **Expected:** `telemetry_spans` returns a NON-ZERO count with a recent `max(ingested_at)`; a
      rendered-webview receipt exists for the dictating state (the `Fredo is listening` chip +
      clean field); the fresh capture shows the stray vertical text GONE. **A static-only PASS is a
      FALSE PASS.**
  - **Edge:** re-run on the tested tip; keep the emit + query output verbatim; a pre-fix capture is
    evidence, never a substitute for the live receipt.

### #2904 testing round 1 (spec/2904 @ 027bbf1f) — results

- **F-101 PASS (live).** Model capture @1936×1056 dark: `fieldContentW 206 ≥ 140`, `fieldPaddingEnd 312px`, `fieldScrollW 558 == fieldClientW 558`, `placeholder "release Space to finish"`, `verticalOrNarrow []`; the only listening text is `launcher-command-model-listening-chip` (`Fredo is listening`, `nowrap`/`horizontal-tb`, lineCount 1); the hint chip is ABSENT. Screenshot `aef1bfe1`.
- **F-102 PASS (live).** Exactly ONE visible `/listening|Fredo/i` indication per capture (model chip; local chip in local mode). Processing window sampled live: `launcher-command-model-processing-chip` = `Fredo is processing your speech…`, 212.2×24, one line (`fieldContentW 226`, `pe 292px`).
- **F-103 PASS (live).** Binding content-box intersection 0 (`chip.left 1029.2` vs text-area right 928 ⇒ `+101.2px`); `fieldContentW 206`; no clip; `fieldScrollW == fieldClientW`. NOTE: the Shared probe's literal `overlapField` is non-empty because it intersects the field's border-box (it also flags the textarea's own rect + the idle hint chip at rest) — probe imprecision, not a defect signature.
- **F-104 PASS (live, 4 legs).** model-light, model-dark, local-light, local-dark: every chip `nowrap`/`horizontal-tb`/lineCount 1, `verticalOrNarrow []`; local `fieldContentW 122` + `Listening…` + hint chip (byte-identical shipped copy); model `fieldContentW 206` + `release Space to finish` placeholder, hint suppressed; token-native colors re-tint (`light-default` ↔ `dark`).
- **F-105 PASS (live).** Mid-capture sweep 1936×1056 → 900×600 → 1400×900 → 700×900: one line + empty content-box overlap at every width; `fieldContentW 206` constant (bar is a constant 560px). Screenshot `ff84fe06`.
- **F-106 PASS (live + static).** Changed file `LauncherCommandBar.tsx`: 0 true color literals (`#[0-9a-fA-F]{6,8}`/`rgba(`/`rgb(`/`hsla(`) and 0 `var(--x)NN` alpha-appends; console error-level EMPTY across all legs; re-theme live while capturing re-tinted token-native with a byte-identical chip rect (`left 1037.2 / right 1143 / 105.8×24`); no re-render loop; seat wrapper 80×100 + 16px, no new scrollbar.
- **F-107 PASS (live).** `telemetry_spans` = **17154 rows**, `max(ingested_at) 2026-09-20T02:37:09.279…Z`; recent `fredo.llm` 115 / `fredo.tool.*` all `status_code=OK`. Dictating-state screenshot `aef1bfe1` uploaded. Evidence: `.opencode/tmp/2904/tests-runs.md` / `## Tests Runs (round 1)`.
- **Not injected:** `FREDO_STT_FEED_WAV` (the legs used the real device capture — the UNSET-env control, `deviceName:"Micrófono (Iriun Webcam)"`).

---

## #2917 extension — solid Fredo on the launcher seat

> Issue #2917 fills the avatar's hollow interior additively and audits/extends the status vocabulary. The
> launcher hosts only the RESTING figure (decorative `.fredo-avatar-idle` at the centre seat, or the
> interactive companion seat when ON) — the expression rows are proxied on the companion surface
> (`companion` F-116..F-125). Rows map 1:1 to `.opencode/tmp/2917/triage.md` `## QA Expert` (Q-1/Q-6/Q-8).
> **Verification policy: live** — a PASS built only from source inspection or computed styles is a FALSE
> PASS. **Serving checkout:** `spec/2917`, screenshots → `.opencode/tmp/2917/e2e/`.

## F-108 (Q-1 / REQ-1 / AC1) — Launcher seat shows a solid, theme-native interior

- [ ] F-108: On the launcher surface, capture the centre seat with the companion OFF (decorative
      `.fredo-avatar-idle`) and ON, in dark base, the `light-default` preset, and a changed accent
      (Matrix); sample the head-interior + mouth-void pixels INSIDE the figure plus a same-frame
      empty-surface control.
  **Expected:** the interior no longer shows the surface behind Fredo in ALL THREE conditions (interior
      pixels resolve to the live accent; contrast vs the same-frame background ≥ 3:1 in both themes); the
      fill is ADDITIVE (the 58 base rects stay byte-identical); only
      `var(--accent-primary)`/`currentColor`/`tint()`; no overlay in the resting render.
  - **Edge:** the md render leg (if the launcher still renders md anywhere) and the sm seat leg; the fill
    must not extend outside the silhouette; the figure stays fully on-screen/un-clipped.

## F-109 (Q-1 / REQ-7 / NF) — Launcher fill re-tints live, no restart

- [ ] F-109: With the launcher open, switch dark → `light-default` and change the accent via
      `select[aria-label="Theme presets"]` with NO reload; read the seat fill's computed `color`/`fill`
      before/after.
  **Expected:** the filled interior re-tints to the live `--accent-primary` with no restart and no stale
      colour; zero `var(--x)NN` alpha-append (#2770); the figure stays legible in both themes.
  - **Edge:** re-theme mid-open/close and mid-animation; the fill must not flash the old token.

## F-110 (Q-6 / REQ-6 / AC5) — Launcher resting DOM identity + frozen geometry

- [ ] F-110: Diff the launcher's resting avatar DOM before/after the change; read the 58 base rects and
      diff against `expandFredoRects(FREDO_AVATAR_SOURCE_RECTS)`; confirm the resting render carries NO
      `#fredo-expression` overlay.
  **Expected:** the 58 base rects are byte-identical; the resting render has no expression overlay; the
      launcher's resting DOM is unchanged apart from the additive fill (documented; a PO-sanctioned
      additive change is acceptable, a silent structural change is a FAIL); whole-element motion stays on
      the consumer wrapper.
  - **Edge:** idle DOM identity is asserted with the transform:0 frame, never a mid-animation frame
    (the idle bob is whole-element transform only).

## F-111 (Q-8 / NF) — No CLS, console clean, no re-render loop from the fill

- [ ] F-111: Measure the command-bar `getBoundingClientRect().y`, the seat-slot WRAPPER
      `offsetWidth`/`offsetHeight`/`margin-bottom`, and `scrollHeight` vs `clientHeight` at the default
      size and the shipped minimum 900×600; read the console after every leg; run
      `pnpm --filter @fredo/ui build` + `pnpm --filter @fredo/ui test:run`.
  **Expected:** `|Δy| ≤ 1 px` vs the pre-change baseline; the wrapper exactly 80×100 + 16 px; no new
      scrollbar/overflow/clip; no `Error:`/`Uncaught`/`Maximum update depth exceeded`; no re-render loop
      (#523); build exit 0 with zero TS errors; suite green.
  - **Edge:** the fill layer must not add a per-frame computation or a mount-time state write; the
    pre-existing `motion() is deprecated` WARN is exempt.

## F-112 (Q-9 / REQ-9 / LIVE) — Live receipt from the launcher run

- [ ] F-112: Same run as F-108..F-111: `fredo emit --event-type chat --session-id e2e-2917-launcher-chat`
      + `--event-type tool_use --session-id e2e-2917-launcher-tool`; query `telemetry_spans` +
      `chat_rows`/`tool_use_rows` (telemetry-query skill); upload the launcher screenshots via
      `upload-evidence --issue 2917`.
  **Expected:** `telemetry_spans` returns a NON-ZERO count with a recent `max(ingested_at)`; both
      injected markers classify under their session ids; every row carries a rendered receipt.
      **A static-only PASS is a FALSE PASS.**
  - **Edge:** re-run on the tested tip; keep the emit + query output verbatim; never fabricate.
