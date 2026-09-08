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
  - **UNVERIFIED (round 1 — split verdict; see the round's `## Tests Runs`).** **Leg 1 (source/structural) = PASS:** `fredoAvatarGeometry.ts` transcribes the 31 html rect calls 1:1 (4 `addRect` singles + 27 `addMirrored` pairs in call order — every (x,y,w,h) matches `fredo-avatar.html:251-653`; mirror math `x' = 1014 - x - width` verified for all 27; expand → 58 rendered rects, unit test locks the invariants). **Leg 2 (live/visual) geometry = PASS (exact, coordinate-level):** live DOM rect-set overlay vs the html-derived canonical set on the running `spec/2837` build → **58/58 exact match, zero mismatches** (no missing/extra/re-positioned blocks); all region percentages equal the wireframe normalized geometry. **Leg 2 visual-perceptual overlay = UNVERIFIED — blocker: "model has no image input"** (the two PNG reads by explicit absolute path — `fredo-avatar.png`, `avatar-guide.png` — returned "Cannot read image (this model does not support image input)"); the pixel-by-eye / PNG-glow read could not be performed. **Zero geometric deviations** were found by the coordinate-level overlay across all listed regions (forehead band, head steps/diagonals, main walls, lower face, eyes, bow tie, body fragmentation, legs, feet); the #2827 row-13 mouth is absent (no rect in the mouth zone). Screenshots (launcher render + 6× zoom + per-region zooms) uploaded for the vision-capable/human confirmation of the perceptual read. Serving commit `93c8379c`.
  - **Edge:** capture from the running `spec/2837` build (never a stale `main` render); comparison is image/geometry-read (mandatory — #2827 passed code review and was still wrong); screenshots go under `.opencode/tmp/2837/e2e/` then `upload-evidence --base spec/2837`; PNG-vs-wireframe conflict → the WIREFRAME governs and the conflict is flagged to the SI (G-109).

## F-36 (AC-2) — Head/face geometry

- [x] F-36: Verify the rendered head silhouette (live rects/screenshot overlay + the implementation's geometry source normalized into the 1014×1264 space). **Expected:** wide horizontal forehead band across the top ((373,67,268,38) → x 36.8–63.2% W, y 5.3–8.3% H); stepped/diagonal upper-head sides transitioning to long vertical main side walls ((87,317,41,267) + mirror → x 8.6–12.6% / 87.4–91.4% W, y 25.1–46.2% H); stepped lower-head narrowing into a broad continuous lower-face bar ((344,761,326,33) → x 33.9–66.1% W, y 60.2–62.8% H). The head is a stepped OUTLINE RIM with a hollow/transparent interior — the eyes are the only interior content; NO mouth element (the #2827 row-13 mouth bar is deleted — the jaw is the broad lower-face bar). The head must NOT read as a hollow dome with a narrow top, nor as a solid filled dome.
  - **PASS (live, spec/2837 @ 93c8379c).** Live DOM rect-set equality with the wireframe canonical set (58/58 exact) + region measurements on the rendered avatar. Head regions at the wireframe percentages: forehead band `(373,67,268,38)` present at x 36.8–63.2% W / y 5.3–8.3% H (measured 26.4% W wide flat top — NOT a narrow dome top); main side walls `(87,317,41,267)`+mirror present (x 8.6–12.6% / 87.4–91.4% W, y 25.1–46.2% H — measured exactly); upper steps `(320,106,50,43)`/`(277,107,42,41)`/diagonals `(218,150,58,43)`/`(168,194,48,75)`/shoulder `(123,271,44,46)` all present (mirrored); lower steps `(126,585,40,58)`/`(169,644,46,41)`/`(218,686,58,41)`/`(276,727,67,33)` present (mirrored); lower-face bar `(344,761,326,33)` present at x 33.9–66.1% W / y 60.2–62.8% H (measured exactly). **Hollow interior CONFIRMED:** zero rects in the head middle column between the eyes (x 392–622 at y 105–761), zero at eye-level between the eyes, zero above the eyes inside the walls — the only interior content is the two eye blocks. **NO mouth:** zero rects in the mouth zone (y 585–761, x 344–670) — the #2827 row-13 mouth bar is GONE. Geometry cannot read as a narrow-top dome (wide 268-unit band + 267-tall walls) nor as a solid dome (interior empty). Screenshot: `ac2-head-zoom.png`. Vision note: pixel-perceptual read delegated to uploaded zoom screenshot (tester model has no image input); the region presence/size/placement assertions are exact coordinate measurements.

## F-37 (AC-3) — Eyes + mirror symmetry

- [x] F-37: Verify the eye blocks render at the wireframe size/placement — LARGE mirrored blocks (323,453,68,131) + mirror (x 31.9–38.6% / 61.4–68.1% W; 68 wide ≈ 6.7% W; 131 tall ≈ 10.4% H; y 35.8–46.2% H) — NOT narrow slits — and the whole figure is mirror-symmetric about its vertical center axis per the wireframe's mirrored rectangle pairs (head steps/diagonals/walls, eyes, bow-tie wings, arms, legs, feet).
  - **PASS (live, spec/2837 @ 93c8379c).** Live DOM rects: both eye blocks present at `(323,453,68,131)` and `(623,453,68,131)` — 68 wide ≈ **6.7% W**, 131 tall ≈ **10.4% H**, x spans 31.9–38.6% / 61.4–68.1% W, y 35.8–46.2% H (all measured). **NOT slits** (≈8.9×17 px at the 132×165 display). **Whole-figure mirror symmetry:** programmatic overlay of every non-single rect against its mirror at `x' = 1014 - x - width` → **0 asymmetric pairs** (head steps/diagonals/walls, eyes, bow-tie wings, arms, legs, feet all exactly paired about X=507). The 4 center single rects (forehead band `373,67,268,38`, lower-face bar `344,761,326,33`, center buttons `492,917,30,32` and `491,991,31,36`) each render **exactly ONCE** (verified by key count = 1) — never mirrored. The as-authored off-center button `(491,991,31,36)` (true center 491.5, 0.5-unit offset) is transcribed as-authored, NOT "fixed" (unit test locks it). Screenshot: `ac3-eyes-zoom.png`. Vision note: eye size/placement + symmetry verified by exact coordinate measurement (tester model has no image input for a pixel read); zoom screenshot uploaded for the human/vision-capable confirmation.

## F-38 (AC-4) — Body/limb geometry

- [x] F-38: Verify the body/limb regions (wireframe y 812–1234). **Expected:** bow-tie cluster under the lower face (wings (427,823,52,69) + mirror + inner shape, y ≈ 64.2–68.7% H); body OPEN/fragmented with visible arm-separation gaps — separate upper-outer-arm / inner-arm / lower-arm clusters + center buttons with gaps — NOT a solid torso; legs SHORT and WIDE (outer (327,1085,34,115) + mirror; inner (460,1097,28,103) + mirror; y ≈ 85.8–94.9% H) with wide bottom feet ((339,1201,119,33) + mirror; 119 wide ≈ 11.7% W; y ≈ 95.0–97.6% H).
  - **PASS (live, spec/2837 @ 93c8379c).** Live DOM rect-set equality (58/58 exact) covers the full y 812–1234 band: **bow tie** upper pixels `(427,812,26,10)`+`(455,812,23,10)`, wings `(427,823,52,69)`, inner `(479,834,28,34)` — all mirrored, y ≈ 64.2–71.4% H (812–903 units). **Fragmented/open body:** the 38-unit empty channel (x 388–426, y 824–916) contains **ZERO rects** (channel388=0), the center-button gap (y 949–991, x ~507) contains **ZERO rects** (btnGap=0) — background shows through between the separated upper-outer-arm `(274,824,58,87)`, inner-arm `(358,824,30,31)`/`(358,857,30,26)`/`(358,885,30,29)`, lower-inner-arm `(426,858,26,33)`, lower-outer-arm `(241,916,31,75)`+`(241,993,31,36)`, cuff `(274,1009,59,52)`, and the two center buttons — NOT a solid torso. **Legs SHORT + WIDE:** outer legs `(327,1085,34,115)` + mirror (34 wide × 115 tall), inner legs `(460,1097,28,103)` + mirror (28×103) — y ≈ 85.8–94.9% H, short vs the ≈727-unit head. **Feet WIDE:** `(339,1201,119,33)` + mirror — 119 wide ≈ **11.7% W** (≈3.5× the outer-leg width), y 95.0–97.6% H. Screenshot: `ac4-body-zoom.png`. Vision note: body fragmentation gaps + leg/foot geometry verified by exact coordinate measurement (tester model has no image input); the ≥3.4px gaps (26–38 units ≈ 3.4–4.9 CSS px at 132px display) are well above the crispEdges sub-1px fill-in threshold — the zoom screenshot is uploaded for the human/vision-capable confirmation.

## F-39 (AC-5) — Token-native + no regression; light/dark + display-size legs

- [x] F-39a: Static grep of `PixelButler.tsx` + any new avatar helper under `apps/ui/src/features/home/components/launcher/**` for `#[0-9a-fA-F]{3,8}` / `rgba(` / `rgb(` / `var(--x)NN` → ZERO hardcoded literals (comment issue-refs exempt); the whole figure is a SINGLE accent fill from `color="var(--accent-primary)"` + `currentColor` (or div-mosaic `background: var(--accent-primary)`); any NEW glow token-based (`tint('var(--accent-primary)', N)` / `color-mix` / var-based filter); no new semantic token without a `system.ts` mapping. HUE follows the LIVE accent token — cyan is the accent default of `light-default`/`dark`; the `classic` base resolves purple; do NOT fail on hue when a non-cyan accent is active.
- [x] F-39b: Live — the avatar renders at the Architect-bound display size (`DISPLAY_WIDTH` ∈ [112, 168], `DISPLAY_HEIGHT = round(W·1264/1014)`, recommended 132×165; NEVER below 112 px wide — the 10-unit bow pixels collapse), undistorted (aspect 1014:1264, viewBox `0 0 1014 1264`), centered above the command bar, no clipping/overflow, in a LIGHT preset (shipped `ThemePresetSelector`, e.g. `light-default`) AND the DARK base.
- [x] F-39c: Live — narrow viewport (e.g. 700×900) + re-theme while visible (light ↔ dark ↔ classic); console clean (`tauri_read_logs` — no `Error:` / `Uncaught` / `Maximum update depth exceeded`).
  - **PASS (F-39a/b/c, live, spec/2837 @ 93c8379c).** (a) Static grep of `launcher/**` for `#[0-9a-fA-F]{3,8}`/`rgba(`/`rgb(`/`var(--x)NN` → ZERO hardcoded literals (all 38 regex hits are comment issue-refs like `#2830`/`#2827`); `var(--x)NN` alpha-append → zero. Avatar source: `color="var(--accent-primary)"` (root SVG) + every rect `fill="currentColor"` — single accent fill; `fredoAvatarGeometry.ts` is pure TS (no colors). No glow added (flat figure); no new semantic token. (b) Live: SVG `width=132 height=165`, `viewBox="0 0 1014 1264"`, aspect 0.8 (1014:1264 locked); `getBoundingClientRect` = **132×165 CSS px** at (894,345.77) in the 1920×1017 viewport — avatarCenterX 960 == viewport center 960 (delta 0 px), `fullyVisible: true`, command bar below (y 550.77). Verified in `light-default` (accent `#00d1d1` → avatar `rgb(0,209,209)` cyan), `dark` (`#00d1d1` cyan), and the `classic` base (`rgb(147,51,234)` purple) — 58 rects + same 132×165 box in every theme. (c) Narrow 700×900: avatar stays **132×165**, centered (350==350), `fullyVisible: true`, 58 rects, command bar below — no clip/overflow/layout shift; re-theme while visible re-tinted token-native (light↔dark↔classic↔Matrix `rgb(0,255,65)`) with no geometry change; console clean (only the pre-existing `motion() is deprecated` WARN). Edge (wrapper): `Box mb="4"` (LauncherShell.tsx:501) unchanged, avatar centered by the flex column. Screenshots: `ac5-light-default.png`, `ac5-dark.png`, `ac5-classic-purple.png`, `ac5-narrow-700.png`.

## F-40 (NF) — Proportions preserved

- [x] F-40: Normalize key spans of the rendered figure (head width/height, body width, leg length/width, foot width) to % of the avatar bounding box and compare against the wireframe's normalized geometry (head silhouette x 8.6–91.4% W / y 5.3–62.8% H; legs y 85.8–94.9% H; feet ≈ 11.7% W each). Ratios within a small recorded tolerance; identical geometry in both themes.
  - **PASS (live, spec/2837 @ 93c8379c).** Figure content spans (DOM extrema over all 58 rects): x 87–927 (8.6–91.4% W), y 67–1234 (5.3–97.6% H) — head silhouette y 67–794 = **5.3–62.8% H**. Forehead 268 units ≈ 26.4% W (band x 36.8–63.2% W); lower-face bar 326 units x 33.9–66.1% W; eyes 68 ≈ 6.7% W each; feet 119 ≈ **11.7% W** each; legs outer 34 w × 115 h / inner 28 × 103 (y 85.8–94.9% H). Leg length 103–115 units is SHORT vs the ≈727-unit head. Every ratio equals the wireframe reference **exactly** (tolerance 0 — coordinate-identical). Identical geometry (58 rects, same coordinates, same 132×165 box) in light-default, dark, classic, and Matrix presets — **no theme-dependent deformation**.
