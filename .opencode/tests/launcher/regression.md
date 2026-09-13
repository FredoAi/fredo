# Launcher — Regression

> "Must not change" baseline for the launcher shell (issue #2808). If any row FAILS, the
> change regressed existing behavior. Run on the spec branch.
> **Serving checkout:** `spec/2808 @ bd30b07b`. Round 2.

## Baseline invariants
- [x] R-1: The launcher chrome no longer imports `@maomaolabs/core` (grep returns zero in the shell source) — the third-party `Toolbar` launcher is replaced by our own component.
  - **PASS.** Zero `@maomaolabs/core` in `launcher/` + `Home.tsx`; `DesktopToolbar.tsx` deleted.
- [x] R-2: `SHOWABLE_FEATURES` is sourced from `apps/ui/src/features/home/components/Home.tsx:22` (`getFeatures().filter(f => f.showable)`) — the grid is never a hardcoded list; it reflects the live feature registry.
  - **PASS.** `Home.tsx:22` `const SHOWABLE_FEATURES = ALL_FEATURES.filter((feature) => feature.showable)`; passed to `<LauncherShell showableFeatures={SHOWABLE_FEATURES}>`. Live grid = the 4 showable features; non-showable absent.
- [x] R-3: The own window-manager kernel contract (#2807) is unchanged (used, not modified): `openWindow` params shape (`id/title/icon/component/canClose/canMaximize/canMinimize/isMaximized`), spawn semantics (`windowStore.ts:68-91`), spread-merge `updateWindow` (R-4), idempotent/re-entrancy-guarded `closeWindow`.
  - **PASS for the contract.** The launcher routes opens through `onOpenFeature(id, feature)` → Home `openFeatureWindow` → own-kernel `openWindow` (Home.tsx:77-129); the kernel store/actions files under `shared/window-system/` were untouched by #2808 (git `ST-1` diff shows only the `DesktopToolbar`→`LauncherShell` swap). **Round-1-flagged latent z-order defect (window-manager container `position:absolute; z-index:auto` occluding opened windows behind `DesktopBackground`) is RESOLVED in round 2 by the ST-6 fix** (`WindowManager.tsx:25` → `zIndex={1}` + `bg="transparent"`), verified live: `elementFromPoint(960,500)` returns the feature surface, and the HUD (`StreamStatus`/`FloatingSettingsButton`, z-index 10) still paints above the window stack.
- [x] R-4: Existing feature launches from other entry points (settings button, konami code, self-open) still open the feature via `apps/ui/src/features/home/components/Home.tsx:77-129 openFeatureWindow`.
  - **PASS.** `openFeatureWindow` (the single full-lifecycle opener) is unchanged; the launcher routes through it, and the konami/settings/self-open paths still call it. The only defect affecting all opens is the shared window-occlusion z-order (R-3 note) — it is a kernel-layout defect, not a launcher regression.
- [x] R-5: Theme token-first: no hardcoded hex/rgba; `tint()` helper for hover; no alpha-append onto `var()`; Chakra v3 only.
  - **PASS.** Launcher source grep: zero hardcoded hex/rgba; `tint('var(--accent-primary)', 14/22)` hover/selected; `tint('var(--body-bg)', 55)` overlay; Chakra v3 (`InputGroup`/`startElement`/`endElement`, not `NativeSelect`); the avatar is `currentColor` + accent var.
- [x] R-6: No re-render loop — the launcher consumes the window-store epoch / uses `useMemo`; no effect depends on array `.length` or newly-created object refs (AGENTS.md re-render-loop rule).
  - **PASS.** Launcher uses `useMemo` for `filteredEntries`, `useRef` for `prevWindowCountRef`, and a stored `setInterval` (60s) for the clock — no effect depends on array `.length` or new object refs. Console across the run had zero `Maximum update depth exceeded` / re-render-loop warnings.

## Overlapping prior suites
- (none yet — first suite for the launcher surface)

## #2819 extension — idle/engaged launcher baseline (must-not-change)

> Issue #2819 (desktop launcher matches `desktop-light.png`; engaged state revealed by
> focus/query). These invariants MUST hold after the idle/engaged rework — any FAIL is a
> regression. Run alongside R-1..R-6.

## R-7 — Command-bar grid filter + keyboard nav unchanged

- [ ] R-7: The engaged grid behavior (where the spec does not redesign it) is unchanged: query filter (`filteredEntries`), keyboard nav (↑↓/←→ clamp, no wrap), Enter/Space open, tile `aria-label`s = `SHOWABLE_FEATURES` names, empty-grid no-op (`entryCount === 0` hides nav hints), and the grid reflects the live feature registry (never a hardcoded list).

## R-8 — Own-kernel window contract + z-order unchanged

- [ ] R-8: Opening a tile still routes through the own-kernel full-lifecycle opener (not a raw `openWindow`); the z-order (window stack above the desktop, below the HUD) and the ST-6 `WindowManager` fix are intact; re-open de-dupes (`openWindows` stays 1). Reference #2808 regression R-3/R-4.

## R-9 — Theming token-native across the newly added chrome

- [ ] R-9: No hardcoded hex/`rgba(`/`rgb(` in any NEW side-tick / dot-grid / rounded-frame component + the existing launcher files; no `var(--x)NN` alpha-append; hover/tint via `tint('var(--accent-primary)', N)`; Chakra v3 API only (never `NativeSelect`). Reference F-6 (#2808) + desktop-shell R-8.

## #2823 extension — global Ctrl+Space keyboard/focus invariants (must-not-change)

> Issue #2823. These invariants MUST hold after the Ctrl+Space keyboard/focus slice — any
> FAIL is a regression. Run alongside R-1..R-9.

## R-10 — Resting search surface stays mounted (AC5)

- [ ] R-10: ESC / toggle-off must only re-z + idle the surface — it must NOT unmount the search/command bar (the resting search access never disappears; `launcher-disappears.png` is the fail state). Opening a feature window still re-z's the surface below the window stack (`surfaceZ` covered = 0, `LauncherShell.tsx:105-106`).

## R-11 — Existing global keyboard consumers unaffected

- [ ] R-11: The Konami-code listener (`useKonamiCode.ts:56`), the `DetailPanel` ESC listeners (`DetailPanel.tsx:202,223`), and the companion Ctrl-right-click teleport (`FredoCompanion.tsx:193`) are unchanged and still fire — Ctrl+Space never breaks them, and Ctrl+Space produces no second action.

## R-12 — Token-native focus ring + no hardcoded color added

- [ ] R-12: The searchbox focus ring remains `outline: 2px solid var(--accent-primary)` (`LauncherCommandBar.tsx:136-141`); any new overlay/scrim uses only existing semantic tokens (`var(--card-bg)`, `var(--bg-primary)`, `var(--border-color)`) — no hardcoded hex/rgba, no `var(--x)NN` alpha-append (use `tint()`/`color-mix`); Chakra v3 only (never `NativeSelect`).

## R-13 — No re-render loop in the new open/close state

- [ ] R-13: Toggling `open` does not introduce a re-render loop — no effect depends on array `.length` or newly-created object refs; console stays clean of `Maximum update depth exceeded`.

## #2824 extension — ESC/close hint keycap polish invariants (must-not-change)

> Issue #2824. These invariants MUST hold after the ESC keycap polish — any
> FAIL is a regression. Run alongside R-1..R-13.

## R-14 — Keycap/hint remain token-native

- [ ] R-14: The ESC keycap/hint styling is token-native: no hardcoded hex/`rgba(`/`rgb(` in the changed launcher files, no `var(--x)NN` alpha-append, colors via `var(--...)`/`currentColor`/`tint()`. Reference F-24 + R-5/R-9/R-12.

## R-15 — No layout change beyond the ESC keycap/hint styling

- [ ] R-15: Only the ESC keycap/hint styling changes. The `↑↓ NAVIGATE` / `←→ SELECT` hints, their glyphs, the frame geometry, and the hint-row layout (bottom padding, `justifyContent: space-between`, hint gap) are UNCHANGED; ESC functional behavior is out of scope and unchanged. Reference the F-10 hint-label checkpoint + R-7.

## #2827 extension — PixelButler avatar invariants (must-not-change)

> Issue #2827. These invariants MUST hold after the PixelButler base-form rework (BASE_FORM content
> + grid constants) — any FAIL is a regression. Run alongside R-1..R-15.

## R-16 — Token-native color baseline + no layout change beyond the avatar base form

- [x] R-16: Token-native color baseline: the launcher source retains ZERO hardcoded hex/`rgba(`/`rgb(`; `#00D1D1` stays a TOKEN value (never an inline literal); no cross-feature import; no re-render loop (console clean of `Maximum update depth exceeded`); no layout change beyond the avatar base form (48×48 preserved, other tiles/chrome unchanged, pixel guide NOT modified).
  - **PASS (live, spec/2827 @ 0620b736).** Grep of `launcher/**` returns zero true color literals; `#00D1D1` absent inline (token value only, theme.ts:209,228); `PixelButler.tsx` imports only React (no cross-feature import); console clean (no re-render loop); avatar 48×48 (`getBoundingClientRect` 48×48, aspect 1.0) — only `BASE_FORM` content + grid constants changed (git shows both #2827 commits touched only `PixelButler.tsx`); wireframe guide PNG unmodified; 91 rect cells render crisp.

---

## #2830 extension — single top-right status LED invariants (must-not-change)

> Issue #2830 — consolidate the desktop status LEDs to ONE top-right LED. The launcher's
> online clock cluster (`LauncherChrome.tsx`) drops the `Online` text label + enlarges the LED
> to a 12px dot (AC3/AC4); the bottom `StreamStatus` pair is REMOVED (AC2). Run alongside
> R-1..R-16 AND the desktop-chrome `#2830` regression R-7..R-14. **OVERRIDE:** the #2821
> dual-bottom-LED AC is SUPERSEDED — the launcher regression must not re-assert a bottom LED
> pair or a "no top-right LED" invariant.

## R-17 — Only the top-right LED/label cluster changes in the launcher chrome

- [x] R-17: **PASS (spec/2830 round 1)** — `git diff main spec/2830` touches only `LauncherChrome.tsx`/deleted `StreamStatus.tsx`/`Home.tsx`/`AppDrawer.tsx` comment; notch/avatar/command-bar/ticks/grid/hints render unchanged (desktop + light/dark screenshots). The FREDO notch, pixel-butler avatar, `>` command bar, side-tick rulers, dot-grid, rounded frame, and the keyboard-hints row are UNCHANGED. Only the top-right `onlineLabel`/dot cluster (`LauncherChrome.tsx`) + the `StreamStatus` component change. No layout shift of the notch/avatar/grid/hints. Reference #2808 F-4 + launcher R-7/R-15.

## R-18 — The online clock cluster retains the clock; the LED is the single status there

- [x] R-18: **PASS (spec/2830 round 1)** — clock `02:49`→`02:55` (60s timer), `Online` label removed (no `ONLINE` text node), single LED in the cluster (`ledCount=1`), no dual/multiple LEDs. The top-right cluster keeps the HH:MM `<time>` clock text (still advances on the 60s timer); the `Online` text label is removed; the LED is the single status indicator in the cluster — NO dual/multiple status LEDs reintroduced on the launcher surface. Reference desktop-chrome F-6/F-8.

## R-19 — Token-native restated for the changed launcher chrome

- [x] R-19: **PASS (spec/2830 round 1)** — grep of `LauncherChrome.tsx` for `#[0-9a-fA-F]{6,8}`/`rgba(`/`rgb(`/`var(--x)NN` → ZERO true literals; LED `rgb(0,209,209)` accent + `color-mix` halo (`tint('var(--accent-primary)',22)`); tooltip reads `--card-bg`/`--text-primary`/`--border-color`; Chakra v3 only (`Tooltip.Root/Trigger/Positioner/Content/Arrow`, no `NativeSelect`). `LauncherChrome.tsx` + any new LED/tooltip component carry ZERO hardcoded hex/`rgba(`/`rgb(` and NO `var(--x)NN` alpha-append (#2770); LED `var(--accent-primary)`/`var(--status-error)` + halo `tint()`; tooltip `bg.surface`/`fg.default`/`fg.muted`/`border.default`; Chakra v3 only (never `NativeSelect`). Reference R-5/R-9/R-12/R-14/R-16 + desktop-chrome R-11.

## R-20 — #2823 Ctrl+Space + launcher open/close + focus lifecycle unchanged

- [x] R-20: **PASS (spec/2830 round 1)** — resting/engaged launcher + ESC-close/searchbox-focus intact; the `coveredByWindow` sink holds (band z 1200↔0 with a maximized window). #2823 Ctrl+Space synthetic keypress note: did not land searchbox focus in this automation round (documented OS/WebView2 IME gate, launcher F-19 edge); #2830 did not touch the Ctrl+Space handler (git diff clean) — not a #2830 regression. The #2823 Ctrl+Space toggle (opens + focuses the searchbox, ESC closes, focus restores), the engaged grid reveal (focus/query), and the resting `surfaceZ` (SURFACE_Z_VISIBLE=1100 / COVERED=0 / OPENED=1300) are unchanged. The LED change must not interfere with the shortcut-open `coveredByWindow` sink or the keyboard nav. Reference R-10 (launcher) + desktop-chrome R-12.

## R-21 — No re-render loop from the LED/tooltip state

- [x] R-21: **PASS (spec/2830 round 1)** — `tauri_read_logs(source=console)` across the hover/focus/Escape tooltip cycles shows NO `Maximum update depth exceeded` / `Uncaught`. Hovering/focusing the LED trigger (tooltip open/close) and the `isOnline` flip do not introduce a re-render loop — console stays clean of `Maximum update depth exceeded`; no effect depends on array `.length` or newly-created object refs. Reference R-13 (launcher) + desktop-chrome R-14.

## #2837 extension — PixelButler fredo-avatar.html geometry invariants (must-not-change)

> Issue #2837 — the PixelButler avatar rework replaces the #2827 21×21 base-form geometry
> with the `fredo-avatar.html` (1014×1264) geometry. **OVERRIDE:** the #2827 21×21
> guide-match expectations (F-26..F-30 / R-16 form claims) are SUPERSEDED as the geometry
> source of truth — do NOT fail this spec for deviating from the 21×21 base form. The
> #2827/AC-5 token-native + layout-invariance invariants remain in force. Run alongside
> R-1..R-21.

## R-22 — Only the avatar geometry changes; launcher layout unchanged

- [ ] R-22: The rework touches only `PixelButler.tsx` + any new avatar helper (git diff scope). The avatar container (`Box mb="4"`, LauncherShell.tsx:501), the command bar, the app grid, the keyboard hints, the clock/LED chrome, and the open/close lifecycle are UNCHANGED — no layout shift of the avatar box or the surrounding chrome at the declared display size or at narrow widths. Reference #2808 F-4 + R-15.

## R-23 — Token-native color baseline retained

- [ ] R-23: Changed launcher files carry ZERO hardcoded `#[0-9a-fA-F]{3,8}` / `rgba(` / `rgb(` and NO `var(--x)NN` alpha-append; the figure is a SINGLE accent fill driven by `var(--accent-primary)` (hue follows the LIVE accent token — cyan under `light-default`/`dark`, purple under the `classic` base; do NOT fail on hue when a non-cyan accent is active) and any added glow is token-based (`tint()`/`color-mix`/var filter); no cross-feature import (imports only React); no re-render loop (console clean of `Maximum update depth exceeded`). Reference F-6/R-5/R-9/R-12/R-14/R-16 + F-24 + R-19.

## R-24 — Avatar still renders at the Architect-bound display size in the launcher

- [ ] R-24: The avatar renders at the Architect-bound display size (`DISPLAY_WIDTH` ∈ [112, 168] px, recommended 132×165, aspect 1014:1264), undistorted, centered above the command bar, fully visible (no clipping/overflow) in BOTH a light preset and the dark base via the shipped `ThemePresetSelector`. Reference #2827 F-30/E-20 + #2824 F-23 + #2837 F-39b.

## R-25 — Launcher interaction surface unchanged

- [ ] R-25: The #2823 Ctrl+Space toggle, the #2824 ESC keycap/hints, and the #2830 single-LED cluster are unchanged by the avatar rework (reference launcher R-10..R-21 + desktop-chrome R-7..R-14). The avatar remains decorative (`aria-hidden`).

---

## #2850 extension — shared-avatar refactor invariants (must-not-change)

> Issue #2850 — the avatar + geometry move from `features/home/components/launcher/` to the
> shared `apps/ui/src/shared/components/fredo-avatar/`; the launcher `PixelButler` becomes a thin
> `FredoAvatar size="md"` wrapper. Launcher layout is a NON-GOAL — the md render must be
> byte/visually unchanged. Run alongside R-1..R-25 AND the companion-suite regression R-1..R-10.

## R-26 — Shared-avatar move changes NO launcher layout/render

- [x] R-26: The launcher md avatar renders at 132×165 (aspect 1014:1264) exactly as before
      (reference #2837 F-39b + R-24), and the avatar container (`Box mb="4"`, LauncherShell.tsx),
      command bar, app grid, keyboard hints, clock/LED chrome, and open/close lifecycle are
      UNCHANGED by the shared move (git diff scope: the launcher change is the import/wrapper
      swap only). Reference #2837 R-22 + desktop-shell R-6/R-10.
  - **PASS (live, spec/2850).** Launcher md avatar SVG `offsetWidth`=132, `offsetHeight`=165 (aspect 1014:1264, undistorted), 58 rects, crispedges, accent-token fill, `aria-hidden` — unchanged from the pre-refactor render. `git diff --stat main spec/2850 -- launcher/` = `LauncherShell.tsx +2/-2` (import swap), `PixelButler.tsx` deleted, geometry/test deleted — the ONLY launcher change is the import/wrapper swap. The launcher layout (notch, command bar, app grid, keyboard hints, clock/LED) is unchanged (verified live DOM: the launcher renders its full chrome + the md avatar at the same position).

## R-27 — Geometry-suite move is byte-identical (the #2837 regression net holds)

- [x] R-27: `fredoAvatarGeometry.ts` + `fredoAvatarGeometry.test.ts` move VERBATIM to the shared
      path (content byte-equal, only the sibling import resolves); `test:run` stays green with the
      test at its new location. The #2837 geometry invariants (F-35..F-40) — 31→58 rects, mirror
      math, canvas bounds, as-authored center buttons — remain in force through the move.
      Reference companion R-10 + launcher F-41.
  - **PASS (static/build, spec/2850).** The moved geometry module + test are byte-identical to the pre-move `main` originals (Read-verified; only `../fredoAvatarGeometry` resolves to the sibling in the shared folder). `pnpm --filter @fredo/ui exec vitest run` on the moved test → 7 tests passed; `test:run` → 52 files/757 tests green. The #2837 invariants (31 source→58 expanded, mirror `x'=1014-x-width`, canvas bounds, as-authored center buttons `(492,917,30,32)`+`(491,991,31,36)`, out-of-canvas guard) hold — the geometry suite is the avatar's strongest regression net and it stays green.

## R-28 — Token-native + zero duplicate geometry in the launcher after the move

- [x] R-28: The launcher's changed files carry ZERO hardcoded `#[0-9a-fA-F]{3,8}` / `rgba(` / `rgb(` /
      `var(--x)NN` alpha-append; the wrapper adds NO new color and NO local geometry table; no
      cross-feature import is introduced (the wrapper imports the shared module); no re-render loop
      (console clean of `Maximum update depth exceeded`). Reference #2837 R-23 + companion R-7.
  - **PASS (static/live, spec/2850).** Grep `shared/components/fredo-avatar/**` for `#[0-9a-fA-F]{6,8}`/`rgba(`/`rgb(` → ZERO true literals (only comment issue-refs `#2837`/`#2850`); the entire figure is `color="var(--accent-primary)"` + `fill="currentColor"`, no `var(--x)NN` alpha-append. The wrapper (`FredoAvatar`) adds NO new color and NO local geometry table (it delegates to the shared `expandFredoRects`). No cross-feature import. Console clean of `Maximum update depth exceeded` across the whole run (`tauri_read_logs` error-level → none).

---

## #2852 extension — desktop mascot size + idle animation invariants (must-not-change)

> **Round 1 (spec/2852 @ 1677eca8) — R-29..R-32 ALL PASS.** R-29 ✓ diff scope = exactly the 4 planned files; command-bar top invariant (499.03 resting == engaged); no clip/scrollbar at default or 700×900. R-30 ✓ geometry module + test byte-unmodified (empty diff); `test:run` 53 files/762 tests green incl. the 7 geometry tests; 58 expanded rects; no rect animates. R-31 ✓ zero hardcoded color literals; glow `color-mix` on `var(--accent-primary)`; CSS-only; console clean. R-32 ✓ companion `offsetWidth=80`/`offsetHeight=100`, 58-rect set byte-identical to launcher, `fredo-idle-bob`+`fredo-idle-glow` 2.4s unchanged; `companion.css` diff = planned keyframe relocation only.

> Issue #2852 — the launcher mascot drops `md` → `sm` (80×100) and plays the companion's exact
> idle bob+glow on the wrapper. Run alongside R-1..R-28 AND the companion-suite regression
> R-11. **OVERRIDE:** the #2850/S-11 md-at-132×165 launcher expectation is SUPERSEDED — the
> 80×100 `sm` render is the new REQUIRED size; do NOT fail this spec for the size change.
> The #2837/#2850 frozen-geometry + token-native + layout invariants remain in force.

## R-29 — Launcher layout unchanged apart from the mascot size + motion

- [ ] R-29: The rework touches only the launcher mascot size prop + the wrapper motion (git diff scope). The command bar, app grid + keyboard nav, keyboard-hints row, ESC keycap, clock/LED chrome, side ticks, dot-grid, rounded frame and the open/close lifecycle are UNCHANGED. The avatar container (`Box mb="4"`, LauncherShell.tsx:501) keeps the mascot centered above the command bar with no layout shift/clip and no new scrollbar — at default AND narrow (700×900) widths. Reference #2808 F-4 + #2850 R-26.
  - **Edge:** the −2px idle bob must not shift the command bar/grid (it is a compositor transform on the avatar only); engaged (grid open) vs resting both hold their layout.

## R-30 — Frozen 58-rect geometry + the geometry regression net still hold

- [ ] R-30: The shared `fredoAvatarGeometry.ts` + `__tests__/fredoAvatarGeometry.test.ts` are UNMODIFIED (byte-identical) and the suite passes in `pnpm --filter @fredo/ui test:run`. The launcher renders exactly the 58 expanded rects (31 source = 27 mirrored pairs + 4 singles), mirror math `x' = 1014 − x − width`, canvas bounds, as-authored center buttons — unchanged by #2852. The idle animation never mutates a rect. Reference #2837 F-35..F-40 + #2850 R-27/F-41.
  - **Edge:** grep confirms the md→sm change is a `size` prop swap only (no geometry table touched); a rect-set drift = FAIL.

## R-31 — Token-native + no re-render loop / console clean

- [ ] R-31: The changed launcher files carry ZERO hardcoded `#[0-9a-fA-F]{3,8}` / `rgba(` / `rgb(` / `var(--x)NN` alpha-append; the glow is `color-mix`/`tint()` on `var(--accent-primary)` (no new hardcoded color / no new semantic token without a `system.ts` mapping); the animation is CSS-only (no JS state per frame, no effect on array `.length` / fresh object refs) → console clean of `Maximum update depth exceeded`. Reference R-5/R-9/R-23 + companion R-7/R-8 + #2770 (no alpha-append on `var()`).
  - **Edge:** re-theme while animating re-tints the glow token-native with no stale color; the SVG stays `aria-hidden` decorative (no new focusable element).

## R-32 — Companion surface unchanged at 80×100

- [ ] R-32: The companion is OUT of scope and UNCHANGED: `.fredo-companion-avatar` stays `offsetWidth = 80`/`offsetHeight = 100`; the 58-rect set, the `fredo-idle-bob`/`fredo-idle-glow` 2.4 s idle, the talk/teleport states, the click/teleport gestures and the clamp/bubble-anchor math (AVATAR_SM) are byte/behaviour-identical to the pre-#2852 render. git diff shows NO companion file change. Reference companion R-11 + `.opencode/tests/companion/`.
  - **Edge:** a shared-size refactor must not alter `AVATAR_SM` (80×100); the launcher adopting sm must not introduce a second/duplicated size literal.

---

## #2868 extension — the Settings tile changes the grid set only (G-136)

> Issue #2868 adds the Settings app to `SHOWABLE_FEATURES` and retires the floating gear.
> **G-136:** R-2's frozen live grid set (`4 showable features`) is SUPERSEDED — the grid now has
> 5 (Settings added); the shell/search/keyboard/window-kernel invariants remain in force.
> Historical records above preserved. Live policy.

## R-33 — Grid set grows by exactly the Settings tile; shell invariants unchanged

- [ ] R-33: The engaged grid tile set = `SHOWABLE_FEATURES.map(f => f.name)` (now includes
      "Settings"); the query filter, keyboard nav (↑↓/←→, Enter/Space), empty-grid no-op, and
      `dedupeByFeatureId` behavior are unchanged; the command bar/avatar/hints/clock-LED chrome is
      unchanged. Reference #2868 functional F-48/F-49 + launcher R-2/R-7.
  - **Edge:** typing "set" filters to the Settings tile; no index gaps from the added tile.

## R-34 — Window-kernel contract + no gear regression

- [ ] R-34: The Settings tile routes through `onOpenFeature → Home.openFeatureWindow → openWindow`
      (not raw `openWindow`); re-invoke de-dupes (one window id); the own-kernel store/actions are
      unchanged. NO floating gear (`IconButton[aria-label="Settings"]`) renders in any state — the
      retired entry leaves no residual layer, and the launcher chrome (clock + single top-right LED)
      is unchanged. Reference #2868 functional F-50 + launcher R-3/R-8 + desktop-chrome R-21.
  - **Edge:** Ctrl+Space over the maximized Settings window still re-raises the grid; no re-render
    loop (console clean of `Maximum update depth exceeded`).

### #2868 testing round 1 (spec/2868 @ 90da8de) — results

- **R-33 PASS (live).** Grid set = `["Mission Monitor","Query Viewer","Run CLI","Settings","Stepper Probe"]` (Settings added, prior 4 intact); keyboard ↑↓/←→ + Enter navigation worked; window-kernel/launcher chrome unchanged.
- **R-34 PASS (live).** Settings routed through `onOpenFeature → openFeatureWindow → openWindow`; re-invoke de-duped to one window id; no floating gear in any state; Ctrl+Space over the open (maximized) Settings window re-raised the launcher; console clean. Evidence: `.opencode/tmp/2868/tests-runs.md` / `## Tests Runs (round 1)`.

---

## #2870 extension — home-seat + no-shift invariants (G-136)

> Issue #2870 reserves the launcher centre seat slot (80×100 + `mb="4"`) unconditionally and renders Fredo or
> an empty seat in it. **G-136 supersedes/extends:** R-29's launcher-layout baseline is EXTENDED (the seat
> slot no longer unmounts on the companion flip); R-32's "companion surface unchanged / git diff shows NO
> companion file change" is SUPERSEDED — #2870 deliberately changes companion files (entity extraction).
> Historical PASS records above are preserved. R-22..R-28 remain in force. Live policy.

- [x] R-35: The launcher centre seat slot renders UNCONDITIONALLY — measure the centred-column height + the command-bar `getBoundingClientRect().y` with the companion OFF, ON-at-home, and ON-away, plus after a 5 s idle auto-return. Height and `y` are constant within ±1 px in every state; no new scrollbar/overflow/clip at default AND 700×900. The mascot/slot size (80×100, `AVATAR_SM`) is unchanged, and the `mb="4"` spacing is preserved. Reference launcher S-14 + #2852 R-29.
  - **Round-3 strengthening — Chakra numeric-token pin (the `sizes.80` class; #2870 R-3 defect).** Measure the reserved seat-slot **WRAPPER** itself (the `position:relative` Box that owns the 80×100 footprint + the `mb="4"` band in `LauncherShell`'s centred column — `LauncherShell.tsx` seat wrapper, `position="relative"` `width`/`height` + `mb="4"`; locate it as the direct parent of the rendered seat content) via `offsetWidth`/`offsetHeight` (G-040 — never a transform/`getBoundingClientRect` size measurement). The wrapper MUST read EXACTLY `offsetWidth`=80 / `offsetHeight`=100 in **all three** states — OFF (decorative `.fredo-avatar-idle`), ON-at-home (the interactive `.fredo-companion-avatar` seat entity), and ON-away (`EmptySeat`, `[data-state="away"]`) — i.e. the `AVATAR_SM` dimensions are emitted as CSS px (string form). A bare numeric `width={80}` is resolved by Chakra v3 as the `sizes.80` theme token = **320 px** → the wrapper measures 320×100 = FAIL (the round-2 observed defect). ALSO measure horizontal centring: `seatCentreX = wrapper.getBoundingClientRect().left + wrapper.offsetWidth/2` must equal the centred column's centre-x within **±1 px** in every state; the centred column is the flex column that contains the seat + `LauncherCommandBar` (equivalently, the `LauncherCommandBar` centre-x — same column). The same numeric-token defect widened the seat and pushed Fredo ~120 px off the launcher centre axis. **Pin:** this row is the durable regression net for the Chakra numeric-token class — a wrapper `offsetWidth` ≠ 80 (e.g. 320) OR `|seatCentreX − columnCentreX| > 1 px` is a FAIL even when the placeholder/avatar content itself still measures 80×100. Do NOT accept a content-only size check; the **WRAPPER** owns the reserved-slot geometry.
  - **#2870 round 3 (spec/2870 @ e27ff0a9) — R-35 PASS (live).** Seat-slot WRAPPER `offsetWidth`=80 / `offsetHeight`=100 (`margin-bottom:16px`) in **all three** states: OFF (content `.fredo-avatar-idle`), ON-home (content `.fredo-companion-avatar`), ON-away (content `[data-state="away"]`). Wrapper `centreX` == centred-column `centreX` in every state (Δ0 at default 960/960 and at 700×900 350/350). Command-bar `getBoundingClientRect().y` = 485.77 (OFF / ON-home / ON-away / through the bubble / post-auto-return) at default, and 446 at 700×900 in ON-home AND ON-away — |Δ| = 0 ≤ 1 px. `mb="4"` preserved (16px). At 700×900 `scrollHeight == clientHeight` (no scrollbar), no H-scroll, seat + bar fully visible. The round-2 defect (wrapper 320×100 from the `sizes.80` token; Fredo ~120 px off-axis) is FIXED — `AVATAR_SM_CSS`/`toCssPx` (`fredoAvatarSizes.ts`) now emit `"80px"`/`"100px"` to both seat consumers. Evidence: `.opencode/tmp/2870/tests-runs.md` / `## Tests Runs (round 3)`; screenshots `after-r3-01-*`, `after-r3-02-*`, `after-r3-06-*`, `after-r3-09-*`, `after-r3-10-*`.
  - **#2870 round 4 (spec/2870 @ 7fddf3ab) — R-35 PASS (live, regression).** Re-verified after the SpeechBubble reduced-motion change (which does not touch the seat geometry): WRAPPER `offsetWidth`=80 / `offsetHeight`=100 + `margin-bottom:16px` in OFF (`.fredo-avatar-idle`), ON-home (`.fredo-companion-avatar` relative), and ON-away (`[data-state="away"]`); wrapper centre-x 960 == column centre-x 960 (Δ0) at default and 350/350 at 700×900. Command-bar `y` = 485.77 in OFF / ON-home / ON-away and 485.77 after the host idle auto-return (Δ0); 446 at 700×900 in ON-home and ON-away. No scrollbar/overflow at 700×900. Evidence: `.opencode/tmp/2870/tests-runs.md` / `## Tests Runs (round 4)`; screenshots `after-r4-01-*`, `after-r4-04-*`, `after-r4-06-*`, `after-r4-07-*`, `after-r4-08-*`.
- [ ] R-36: The launcher chrome beyond the seat is unchanged — FREDO notch, command bar, app grid + keyboard nav, keyboard-hints row, ESC keycap, clock/LED chrome, side ticks, dot-grid, rounded frame, and the open/close lifecycle behave as before with the companion ON and OFF; the Settings tile/`SHOWABLE_FEATURES` grid set and `dedupeByFeatureId` are unchanged. Reference R-26..R-34 + #2868 R-33/R-34.
   - **#2870 round 3 (spec/2870 @ e27ff0a9) — R-36 PASS (live).** Launcher chrome unchanged with the companion ON/OFF: notch, command bar, app grid + keyboard nav, hints row, ESC keycap, clock/single-LED chrome all render as before; the Settings tile still opens the Settings app via `onOpenFeature → openFeatureWindow → openWindow`; no floating gear; console clean of `Maximum update depth exceeded`. Reference R-26..R-34 + #2868 R-33/R-34.

---

## #2871 extension — smart-Enter / companion-chat invariants (G-136)

> Issue #2871 adds a companion-chat path to the command bar while the companion is ACTIVE.
> **G-136:** R-7's frozen "Enter/Space open" (the query is a grid filter only) is EXTENDED —
> Enter is now smart (exact tile name ⇒ launch; otherwise ⇒ chat) but ONLY while the companion
> is active; the inactive behavior is unchanged. R-7/R-35/R-36 remain in force. Historical
> records preserved. Live policy.

## R-37 — Inactive command-bar behavior unchanged; active smart-Enter never mis-launches

- [ ] R-37: With the companion OFF and away, type a non-tile phrase + Enter → no `llmChat`, no
      launch, the grid filters as before. With it ACTIVE (incl. home after an idle auto-return),
      Enter on a non-exact query chats and NEVER launches a tile; Enter on an exact tile name
      launches it.
  **Expected:** the filter (`filteredEntries`), the keyboard nav (↑↓/←→ clamp, no wrap), the
      empty-grid no-op, and the tile `aria-label`s = `SHOWABLE_FEATURES` names are unchanged;
      Enter never opens a tile the text did not exactly name. Reference R-7 + F-51/F-54.

## R-38 — Launcher layout / seat geometry unchanged by the chat path

- [ ] R-38: Measure the command-bar `getBoundingClientRect().y` with the companion OFF,
      ON-home, ON-away, and while a reply streams; `scrollHeight`/overflow at 700×900.
  **Expected:** `y` constant within ±1 px in every state; no new scrollbar/overflow/clip; the
      seat slot (80×100 + `mb="4"`) never unmounts. Reference R-35/R-36 + #2870 R-35.

## R-39 — Console clean, listeners once, no re-render loop from the chat state

- [ ] R-39: Read the console after every leg incl. repeated sends + an error; inspect the new
      chat-state code for effect/memo deps on array `.length`/fresh refs; count listener
      registrations across cycles.
  **Expected:** no `Error:`/`Uncaught`/`Maximum update depth exceeded`; no re-render loop
      (AGENTS.md #523); the `llm-token`/`llm-done`/`llm-error` listeners register per generation
      and unlisten on settle — no accumulation. Reference R-13/R-21.
