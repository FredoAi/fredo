# Window Manager — Regression Baseline (Spec #2807 — Own window-system kernel)

> The "must not change" baseline for this spec + links to overlapping prior suites. Run on every testing phase that touches the window-manager surface. The engine swap must be invisible to every existing consumer — only the import source changes.
>
> **Evidence policy: LIVE** — the exit gate / audit fail-closed unless the tester's Evidence references `telemetry_spans` (a live-query result) confirming the classifier/row pipeline still flows while the engine is swapped. A static-only PASS is a FALSE PASS.

## Must NOT change (regression invariants)

- [ ] R-1 (AC2 — feature windows still open from the toolbar): Click a feature launcher entry in the desktop toolbar — the feature window opens with the pre-change observable behavior (its title/icon/content and declared close/max/min state), framed by the OWN brand chrome rather than the third-party chrome.
  - EXPECTED: no regression opening a feature window from the toolbar; the toolbar's open path goes through the own kernel (not the third-party engine); the open window is reachable and interactive.
  - Edge: features opened via `openSelf()` behave the same; multi-window id suffixing in the toolbar still works (the toolbar counts open windows per feature id).
- [ ] R-2 (AC2 — three out-of-slice callers render + behave): The three feature callers — Mission Monitor panel, companion settings panel, and Run CLI launcher — render and behave correctly through the new kernel.
  - EXPECTED: each caller's window opens/re-renders/closes via the own hooks with no behavioral change beyond the hook-source re-point; Mission Monitor still surfaces its session list + graph; the mission-monitor window title neutralization to "Sessions" still applies; Run CLI still closes its window from the launcher.
  - Edge: a caller importing a hook that no longer exists is a FAIL; the final own-API migration (Issue 3) is out of scope — no deeper API change is implied by this slice.
- [ ] R-3 (AC2 — z-order/focus unchanged): Focus brings a window to the front; minimize/restore and maximize/restore preserve stacking order; floating windows keep their float across drag-grip.
  - EXPECTED: topmost window shows the focus treatment and the receding window drops to unfocused; after a minimized window is restored it returns to its prior stack position; a dragged window keeps its float geometry when released.
  - Edge: closing a window moves focus to the next topmost visible window (or the workspace); no window silently jumps in z-order without a focus/max/min interaction.
- [ ] R-4 (AC3/AC4 — no cross-feature import): The own window-manager kernel lives in a shared module; no feature imports from another feature; no `@maomaolabs/core` window-engine import is re-introduced in the window path.
  - EXPECTED: the kernel (provider, manager, hooks, window model, chrome) imports only shared/theme modules; the three callers + toolbar import the shared hooks.
  - Edge: a kernel importing a feature module is a FAIL; `@maomaolabs/core` is NOT removed from package.json (Issue 4) — its absence from the window path is the goal, not package removal.
- [ ] R-5 (Chakra v3 only): The chrome and any touched callers use Chakra v3 props only.
  - EXPECTED: `disabled`/`loading`/`colorPalette` (not v2 `is*`/`colorScheme`); compound components used where applicable; the global `button[data-variant="outline"]` border override does not swallow a status color requirement.
  - Edge: a v2 prop reintroduced by the re-point is a FAIL.
- [ ] R-6 (theming contract — no hardcoded hex/rgba): All colors come from theme semantic tokens → CSS vars → user theme; tint/hover via the shared `tint()` helper (`color-mix`); never hardcode hex/rgba; never alpha-append onto a `var()` reference.
  - EXPECTED: the token→var→theme color flow is intact; light + dark both render the brand chrome correctly; hover tints respond to accent/theme override; no one-off inline color leaks in.
  - Edge: a `var(--x)22` alpha-append or a hardcoded purple in the chrome is a FAIL (regression risk from #2770 round 5).
- [ ] R-7 (lifecycle — no double-instance / no focus steal): Rapid open of the same feature id yields one window; an update while a window is minimized does not steal focus or automatically restore it; a close succeeds from any z-order position.
  - EXPECTED: one window per feature id; backgrounded updates do not raise the window; close works for both focused and backgrounded windows.
  - Edge: a re-entrant close (the feature's close callback invoking close again) does not loop or crash (idempotent, re-entrancy-guarded).
- [ ] R-8 (graceful degradation — persisted state never crashes): Any stale persisted window state (a legacy `windowStyle` value, or a stale window entry) degrades to the single brand chrome; the app never crashes on mount.
  - EXPECTED: brand chrome renders, no throw, console clean; the provider never reads `windowStyle` to pick chrome.
  - Edge: legacy values `default`/`traffic`/`linux`/`yk2000`/`aero` and unknown/bogus/null values all render brand chrome.
- [ ] R-9 (test suite mock stays green): Mission Monitor's existing component suite still passes — its engine mock is re-pointed to the own kernel's `useWindowActions`.
  - EXPECTED: the suite runs green; no mock still references the third-party hook surface.
  - Edge: a stale mock referencing a removed hook name is a FAIL.
- [ ] R-10 (no re-render loop / no console errors): After every interaction, the webview JS console is clean.
  - EXPECTED: no `Error:` / `Uncaught` / `Maximum update depth exceeded`; window-store recomputation is epoch-based.
  - Edge (#523): a `useEffect`/`useMemo` depending on array `.length` or newly-created object refs in the engine/Home path is a FAIL.

## Overlapping prior-feature suites

- `.opencode/tests/mission-monitor/` — Mission Monitor is an out-of-slice caller (R-2) and its widget/tool-detail surfaces must not regress; its engine mock is re-pointed in this slice (R-9).
- `.opencode/tests/run-cli/` — Run CLI launcher is an out-of-slice caller (R-2); its window-open/close behavior must not regress.
- Settings / theming surfaces — the legacy `WindowStyleSelector` is removed from the settings dialog and the theming settings (R-8/AC4); the theming feature (theme/animation presets) keeps working — only the window-style sub-setting is removed.

## Test run (round 1)

- **R-1 (AC2 — feature windows still open from the toolbar) — FAIL.** Clicking a toolbar launcher opens no window (see functional F-3). The toolbar `@maomaolabs/core` `Toolbar` routes the click to maomaolabs' own store, whose host is unmounted.
- **R-2 (AC2 — three out-of-slice callers) — UNVERIFIED (blocked by R-1).** No caller window can be opened to verify render/behavior. (Static: callers re-pointed to the own `useWindowActions`.
- **R-3 (AC2 — z-order/focus unchanged) — UNVERIFIED (blocked by R-1).** No window to drive focus/z-order.
- **R-4 (AC3/AC4 — no cross-feature import) — PASS.** Own kernel under `shared/window-system/`; grep `from '.*features/` over the kernel = 0 matches; only the dock `Toolbar` (Issue 2/4) + `main.tsx` CSS import remain from `@maomaolabs/core`.
- **R-5 (Chakra v3 only) — PASS.** `WindowChrome.tsx`/`WindowFrame.tsx` use `disabled`/`variant="ghost"`/`bg`/`borderColor`/`_hover`; no `isDisabled`/`colorScheme`. Close uses `variant="ghost"` + `tint()` hover, not `outline colorPalette="red"`.
- **R-6 (theming contract — no hardcoded hex/rgba) — PASS (static).** Grep clean (see functional F-12); live light+dark render UNVERIFIED (blocked by R-1).
- **R-7 (lifecycle — no double-instance / no focus steal) — UNVERIFIED (blocked by R-1).** No window to open/duplicate; no console error observed.
- **R-8 (graceful degradation) — PASS (no-crash) / chrome render UNVERIFIED.** `aero`/`bogus_style_xyz`/absent all reload clean with no console error; Settings exposes no window-style variant.
- **R-9 (test suite mock stays green) — PASS.** `pnpm --filter @fredo/ui test:run` reported 693/693 passing (per dev summaries); mocks re-pointed to own `useWindowActions`.
- **R-10 (no re-render loop / no console errors) — PASS (observed).** No `Maximum update depth`/`Uncaught` in console.

## Test run (round 2)

- **R-1 (AC2 — feature windows still open from the toolbar) — PASS.** Clicking the Mission Monitor launcher opens the window through the own kernel (round-2 `onClickCapture` → `openFeatureWindow` → own `openWindow`); the window renders with the own brand chrome and is reachable/interactive. The toolbar open path no longer dispatches to the unmounted `@maomaolabs/core` store.
- **R-2 (AC2 — three out-of-slice callers) — PARTIAL.** Callers remain re-pointed to the own `useWindowActions` (static). Mission Monitor panel renders through the own kernel (title neutralization to "Sessions" applies on fresh mount); Run CLI launcher window-close path not individually driven this round (the caller window only mounts inside a feature window).
- **R-3 (AC2 — z-order/focus unchanged) — PASS.** Focus brings a window to top (accent border + `tint()` halo), receding window drops to unfocused (neutral border); minimize/restore and maximize/restore preserve state; a maximized→restored window returns to its prior float geometry (480×320 @ 48,48).
- **R-4 (AC3/AC4 — no cross-feature import) — PASS.** Own kernel under `shared/window-system/`; no `from 'features/` import; `@maomaolabs/core` only as the retained `Toolbar` dock (Issue 2/4).
- **R-5 (Chakra v3) — PASS.** `disabled`/`variant="ghost"`/`bg`/`borderColor`/`_hover`; no `isDisabled`/`colorScheme`; close uses `variant="ghost"` + `tint()` hover.
- **R-6 (theming contract — no hardcoded hex/rgba) — PARTIAL.** Static grep clean (0 hardcoded hex/rgba in chrome code). **BUT live render reveals the header/icon-tile do NOT re-tint** — `bg.subtle`/`bg.muted` resolve to Chakra defaults (#fafafa/#f4f4f5), not `var(--header-bg)`/`var(--card-hover-bg)`, so the title is light-on-light (invisible) in both theme presets. This is the AC3 failure (see functional F-13).
- **R-7 (lifecycle — no double-instance / no focus steal) — PASS.** Rapid double-open yields one window; update-while-minimized does NOT steal focus or restore (window stayed `display:none`, content updated 3→4 rows); close succeeds from any z-order.
- **R-8 (graceful degradation) — PASS.** `aero`/`bogus_style_xyz`/absent all reload clean with no console error; single brand chrome renders; Settings exposes no window-style variant.
- **R-9 (test suite mock stays green) — PASS.** `pnpm --filter @fredo/ui test:run` 693/693 passing (per dev summaries); mocks re-pointed to own `useWindowActions`.
- **R-10 (no re-render loop / no console errors) — PASS.** No `Maximum update depth`/`Uncaught` observed during the round-2 lifecycle drive.

## Test run (round 3) — chrome/tile resolved to theme CSS vars (AC3 fix)

> Live-driven via `pnpm dev:tauri` (spec/2807 @ d74a0563; served root confirmed by dev-env Status). Round-3 fix (commit `d74a056`): `WindowChrome.tsx` header/tile reference the theme CSS vars directly. Regression-swept after the AC3 live-render re-test.

- **R-1 (AC2 — feature windows still open from the toolbar) — PASS.** Clicking the Mission Monitor launcher opens the window through the own kernel (brand chrome renders); the toolbar open path is unaffected by the chrome edit.
- **R-2 (AC2 — three out-of-slice callers) — PARTIAL.** Callers remain re-pointed to the own `useWindowActions` (static); Mission Monitor panel renders through the own kernel (title neutralization to "Sessions" on fresh mount). Run CLI / companion caller windows not individually driven this round (they only mount inside a feature window — out of the chrome-edit surface).
- **R-3 (AC2 — z-order/focus unchanged) — PASS.** Opening a 2nd window (Query Viewer) brings it to top (accent border), the 1st window drops to unfocused (neutral tint); minimize/restore and maximize/restore preserve state (maximized→restored returns to the exact prior float 480×320 @ 48,48).
- **R-4 (AC3/AC4 — no cross-feature import) — PASS.** Own kernel under `shared/window-system/`; `@maomaolabs/core` only as the retained `Toolbar` dock (DesktopToolbar.tsx:3, Issue 2/4).
- **R-5 (Chakra v3) — PASS.** `disabled`/`variant="ghost"`/`bg`/`borderColor`/`_hover`; no `isDisabled`/`colorScheme`; close uses `variant="ghost"` + `tint()` hover.
- **R-6 (theming contract — no hardcoded hex/rgba) — PASS (the round-2 PARTIAL is now FULL).** Static grep clean (0 hardcoded hex/rgba, 0 alpha-append, 0 `bg.subtle`/`bg.muted`/`border.subtle` code-prop usages). **Live render now re-tints correctly in BOTH presets:** header `bg="var(--header-bg)"` computes rgb(42,42,42) classic / rgb(17,17,17) turbo; icon tile `bg="var(--card-hover-bg)"` computes rgb(58,58,58) classic / rgba(168,85,186,0.2) turbo; title `fg.default` readable (classic ≈8.9:1, turbo ≈17:1) on the dark header — no light-on-light.
- **R-7 (lifecycle — no double-instance / no focus steal) — PASS (re-confirm).** One window per feature id; the open-path re-focuses/no-ops; close succeeds from any z-order; no focus steal.
- **R-8 (graceful degradation) — PASS (re-confirm).** `Fredo_window_style` grep = 0 matches → nothing reads the key (reader deleted ST-4); a legacy value degrades to the single brand chrome with no crash (round-2 evidence: aero/bogus/absent all clean).
- **R-9 (test suite mock stays green) — PASS.** Per dev summary: `pnpm --filter @fredo/ui test:run` 693/693; mocks re-pointed to own `useWindowActions` (unchanged this round).
- **R-10 (no re-render loop / no console errors) — PASS.** No `Maximum update depth`/`Uncaught` during the round-3 lifecycle drive; console clean (only pre-existing `motion() is deprecated` warn + one transient React Flow "parent container width/height" warn, benign).

---

## #2838 extension — left-edge auto-hide dock: new no-change invariants

> Issue #2838 REPLACES the #2821 minimize-triggered bottom-docked tray (functional.md F-16..F-19
> are SUPERSEDED) with a left-edge auto-hide icon dock. The #2807 baseline R-1..R-10 above is
> UNCHANGED and must still pass. Map 1:1 to `.opencode/tmp/2838/triage.md` `## QA Expert`
> (EARS D-1..D-10, NFR-7; QA-Plan rows R-13/R-14/R-15 for AC6).

- [x] R-11 (#2838): minimize opens NO bottom tray; the left-edge dock is a passive read-only consumer of the shared window-system read surface. EXPECTED: the #2821 `AppDrawer` bottom-docked component is DELETED (`AppDrawer.tsx` gone; no mount/import in Home.tsx — grep zero references, build green); the dock never writes lifecycle state (kernel READ-ONLY — no edits to `windowStore.ts`/`windowTypes.ts`/`useWindows.ts`/`useWindowActions.ts`/`WindowManager.tsx`/`WindowFrame.tsx`/`WindowChrome.tsx`, NFR-1); the dock consumes `useWindows()` store-order entries keyed `win.id` (NFR-3). Edge: zero dangling `AppDrawer` import; the dock reveals only while >=1 window is open (empty gate, D-1).
  - **PASS (spec/2838 @ 6ccf4820, round 1):** `git diff main spec/2838` under `shared/window-system/` = only `AppDrawer.tsx` DELETED (270 lines); `git grep AppDrawer apps/ui/src` = 0 matches; `Home.tsx` mounts `<AppDock/>`. Zero diff to the six kernel files listed in the row (verified `git diff --stat`). `AppDock.tsx` imports only `useWindows()` + `useWindowActions()` (shared), never an engine setter. Empty gate verified: 0 windows → dock unmounted entirely (`dockPresent:false`); ≥1 window → dock mounted (hidden at rest). Build green (F-34).
- [x] R-12 (#2838): the dock at rest changes NOTHING about desktop/window stacking, pointer reach, or desktop chrome. EXPECTED: at rest the dock is off-canvas + `pointer-events:none` + `visibility:hidden` (out of tab order + a11y tree) — a maximized window stays full-bleed edge-to-edge, left-edge content stays pointer-reachable, the window min/max/close controls stay clickable; the chrome band z model (uncovered 1200 / covered 0, #2830 R-9) is untouched; `DOCK_Z_INDEX = 1200` (Architect binding, left-edge rail with ~88px top/bottom insets) never occludes the top-right clock/LED cluster. Edge: rapid reveal/hide does not re-indent content or re-render-loop (#523); desktop-chrome regression R-7..R-14 (single top-right LED, band passive) still hold alongside.
  - **PASS (spec/2838 @ 6ccf4820, round 1):** at rest the dock is `visibility:hidden`, `pointer-events:none`, x=-60 (off-canvas), entries not focusable and absent from the a11y tree (F-22/F-35 evidence); a maximized window measures full-bleed `x:0 w:1920` with NO indent; `elementFromPoint(6/10/30, y)` at rest returns the WINDOW/desktop surface never the dock (F-31); min/max/close hit-test SELF (F-33); band z model verified (surface z 1100 rest / 0 covered / 1300 Ctrl+Space; dock z=1200 sits between resting launcher and Ctrl+Space overlay — `launcherZ:1300 > dockZ:1200` while overlay open); revealed rail `{x:0,y:482,w:52,h:54}` disjoint from clock `{x:1863}` and LED `{x:1884}` (F-33). 5+ reveal/hide cycles with no re-indent and no `Maximum update depth exceeded` (F-23). Desktop-chrome R-7..R-14 hold: exactly ONE top-right LED (`statusRoles:["Online"]`), band wrapper `pointer-events:none`, zero bottom dots.

---

## #2848 extension — positionable dock: window-engine no-regression

> Issue #2848 — the #2838/#2841 dock becomes positionable (Sidebar / Bottom bar). **NFR-1: the window kernel stays READ-ONLY** — no change to `windowStore.ts`/`windowTypes.ts`/`WindowManager`/`WindowFrame`/`WindowChrome`/`useWindows`/`useWindowActions` (verified: `git diff --name-only main spec/2848 -- apps/ui/src/shared/window-system` = empty, `-- apps/tauri` = empty). The dock remains a pure `useWindows()` consumer dispatching only `focusWindow`/`closeWindow`.
>
> **Round-1 regression sweep (spec/2848 @ 12afa697, LIVE):** window lifecycle fully exercised — open (Mission Monitor ≡ Sessions / Query Viewer / Stepper Probe from the launcher grid), minimize → restore at saved float, maximize → full-bleed (`x:0,w:1920`,`borderRadius:0`) → restore, focus/z-order (open-2nd brings to top + `aria-current=step`), close (focused + backgrounded), one-window-per-feature-id (no duplicate frame), update-while-minimized does NOT auto-restore. The dock (Sidebar + Bottom bar) as a pure consumer changed none of these; each window operation behaved exactly as the #2807 baseline. R-1..R-10 hold unchanged.

---

## #2850 extension — cross-window companion teleport: window-engine no-regression

> Issue #2850 — the companion teleport choreography runs over the Tauri multi-window model
> (main + `run-cli-terminal`) and moves to the shared vector avatar, but the window kernel is a
> NON-GOAL (READ-ONLY, NFR-1 — `git diff --name-only main spec/2850 -- apps/ui/src/shared/window-system`
> must be empty, and `-- apps/tauri/src-tauri/src/features/llm`/`.../terminal` must carry no
> window-model change). The `companion-teleport` event contract (`{ toWindow, x, y }`) and the
> source/destination window lifecycle are UNCHANGED. Run alongside R-1..R-12 + the companion-suite
> regression R-1..R-10.

## R-13 (#2850) — Window kernel + `companion-teleport` contract unchanged

- [ ] R-13: The window-system kernel files are byte-identical to main (R-1..R-10 baseline holds);
      the `companion-teleport` event shape `{ toWindow, x, y }` is unchanged; the source-window
      out-then-hide and destination-window visible-then-in choreography behaves exactly as before
      (reference companion functional F-9/F-10 + window-manager functional F-36/F-37). The
      Run CLI terminal window (`run-cli-terminal`, `index.html?view=terminal`) lifecycle is
      unaffected by the avatar change.

## R-14 (#2850) — Cross-window teleport leaves no ghost/double-mount; console clean in both windows

- [ ] R-14: After the F-37 main↔terminal round-trips, the companion exists in EXACTLY ONE window
      at every settle (never a ghost/double-mount); closing the terminal window mid-transit leaves
      the main companion recoverable; `tauri_read_logs(source="console")` on BOTH windows shows no
      `Error:`/`Uncaught`/`Maximum update depth exceeded`. Reference companion R-4/R-8.
