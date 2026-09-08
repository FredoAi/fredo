# desktop-chrome — Regression

The "must not change" baseline for the desktop-chrome / window-chrome z-order surface.
No-change invariants from #2825's non-goals; the fix must alter ONLY the desktop-chrome →
window-chrome stacking relationship.

- [x] R-1 (no restyle): the window titlebar is NOT restyled — `WindowChrome` header layout (brand cap, icon tile, title, control cluster) and its colors stay token-native (no hardcoded hex/rgba, no `var(--x)NN` alpha-append). No regression to Spec #2807 ST-3.
- [x] R-2 (no data-flow change): the LED/clock data flow is UNCHANGED — LED-1 still derives from `useConnectionStatus()`, LED-2 still derives from a monotonic row-mutation activity epoch (#2821 / #2788 P5.1); no re-introduction of the deleted v1 delivery-queue path.
- [x] R-3 (no top-right LED reintroduction): the #2821 bottom LED pair stays at bottom-center; the pre-#2821 single top-right LED that overlapped the clock/ONLINE readout is NOT reintroduced.
- [x] R-4 (passive chrome): the decorative desktop-chrome overlays (`LauncherChrome`, `StreamStatus`) stay `pointer-events:none` — the fix must not make them `pointer-events:auto` (NFR-5).
- [x] R-5 (launcher surface): the launcher shell's resting/covered/opened surface z-values (SURFACE_Z_VISIBLE=1100 / SURFACE_Z_COVERED=0 / SURFACE_Z_OPENED=1300, LauncherShell.tsx:70-77) are not unintentionally disturbed beyond the window-chrome relationship (AC1 of #2823 — shortcut-open launcher still rises above the window stack and chrome; the sink when covered still holds).
- [x] R-6 (accent/theme): the fix uses theme tokens only; no hardcoded colors are introduced; both light and dark themes stack identically (NFR-1).

Overlapping suites to run alongside: `mission-monitor` (opens feature windows via WindowManager and reads the window stack), and any suite that touches `WindowFrame`/`WindowManager`/`WindowSystemProvider` (own-kernel windowing, Spec #2807/#2809/#2821/#2823).

---

## #2830 extension — SUPERSEDED prior invariants (read before running)

> Issue #2830 — the single top-right status LED consolidation. **OVERRIDE:** the #2821
> dual-bottom-LED AC is SUPERSEDED. Two prior desktop-chrome invariants are now REVERSED by
> the scope — the tester MUST NOT re-assert them as passing requirements:
>
> - **R-2 / R-3 (of this file's #2825 baseline) are SUPERSEDED.** The "bottom LED pair stays
>   at bottom-center; the pre-#2821 single top-right LED is NOT reintroduced" invariant
>   (R-3) is REVERSED — #2830 REMOVES the bottom pair and PLACES a single top-right LED.
>   The "LED-2 derives from a row-mutation activity epoch" invariant (R-2) is also dropped —
>   the streaming/activity LED is removed by design (one status source). Keep the historical
>   `[x]` PASS rows as the #2825 record, but do NOT re-expect them to hold — they describe
>   the PRE-#2830 state. The new baseline is R-7..R-14 below.

## R-7 — Only the status-LED consolidation changes; the rest of the chrome is untouched

- [x] R-7: The FREDO notch, pixel-butler avatar, `>` command bar, side-tick rulers, dot-grid, rounded frame, and the keyboard-hints row geometry are UNCHANGED (only the top-right LED/`onlineLabel` cluster in `LauncherChrome.tsx`, and the `StreamStatus` component, change). No layout shift of the clock/notch/nav hints. **PASS (spec/2830 round 1):** `git diff main spec/2830` touches only `LauncherChrome.tsx`, deleted `StreamStatus.tsx`, `Home.tsx`, and the `AppDrawer.tsx` comment; notch/avatar/command-bar/ticks/grid/hints render unchanged (desktop + light/dark screenshots).

## R-8 — The clock HH:MM text is retained and still advances

- [x] R-8: The top-right clock time (`HH:MM`) is retained and still updates on the 60s interval timer (`LauncherChrome.tsx`); only the `Online` text label row is removed. The clock does not break/disappear. **PASS (spec/2830 round 1):** live `timeText` `02:49` → `02:55` across the round; `<time aria-label="02:49, online">` retained (accessible name); `ONLINE` text node absent.

## R-9 — The #2825 desktop-chrome z-order model is preserved

- [x] R-9: Band z = 1200 when the desktop is uncovered; the whole band (clock + LED + frame + side ticks) sinks to z = 0 below the z = 1 window stack `coveredByWindow`-driven. The LED never paints over the window titlebar min/max/close controls (`bugs/led-overlay.png` must NOT reproduce). Composed stacking: window frame z=1 > band z (0 when covered). Reference #2825 F-1/F-3. **PASS (spec/2830 round 1):** chrome band root `zIndex` 1200 (uncovered) → 0 (Mission Monitor open) → 1200 (close/minimize); `elementFromPoint(1913,21)` at "Close Sessions" returns the window control (`isWindowControl:true`); `led-overlay.png` does NOT reproduce.

## R-10 — Chrome band stays passive; only the LED trigger re-enables pointer events

- [x] R-10: The chrome band wrapper stays `pointerEvents="none"` (NFR-5); only the LED trigger re-enables `pointerEvents="auto"` on its OWN element (mirroring the FREDO notch, `LauncherChrome.tsx:327`) so the enlarged LED is hoverable/focusable but the band never swallows a pointer. No new invisible overlay intercepts the window min/max/close (reference #2825 F-5). **PASS (spec/2830 round 1):** chrome band root `pointerEvents="none"`, LED trigger `pointerEvents="auto"` (`triggerPointerEvents=auto`); real clicks on Min/Restore/Close dispatched successfully.

## R-11 — Token-native; no hardcoded color; Chakra v3 only

- [x] R-11: The changed files carry ZERO hardcoded hex/`rgba(`/`rgb(` and NO `var(--x)NN` alpha-append (#2770); colors flow theme token → CSS var → `tint()`/`color-mix`; Chakra v3 API only (no v2 `isDisabled`/`colorScheme`, no `NativeSelect`). Reference #2825 R-6 + launcher R-5/R-9/R-12/R-14. **PASS (spec/2830 round 1):** grep of `LauncherChrome.tsx` for `#[0-9a-fA-F]{6,8}`/`rgba(`/`rgb(`/`var(--x)NN` → ZERO true literals; halo uses `tint('var(--accent-primary)', 22)` (→ `color-mix`); Chakra v3 `Tooltip.Root/Trigger/Positioner/Content/Arrow`. **NOTE:** #2821 R-3 (no top-right LED) and R-4 (chrome stays fully pointer-events:none) are SUPERSEDED by #2830 — see the #2830 extension note above.

## R-12 — #2823 Ctrl+Space launcher + #2821 fidelity fixes remain

- [x] R-12: The #2823 Ctrl+Space toggle (opens + focuses the searchbox, ESC closes, focus restores) and the #2821 desktop-fidelity fixes (clean top-right clock; no clock/LED overlap of window controls) are intact. The LED change must not break the shortcut-open `coveredByWindow` sink or the resting/engaged launcher z-model. **PASS (spec/2830 round 1):** #2821 fidelity holds (clock clean, no clock/LED overlap of controls — `elementFromPoint` at "Close Sessions" = window control); `coveredByWindow` sink verified (band z 1200↔0); launcher ESC-close + searchbox focus intact. #2823 Ctrl+Space synthetic-keypress note: the `press " " +Control` keypress did not land searchbox focus in this automation round (documented OS/WebView2 IME gate, launcher F-19 edge); #2830 did not touch the Ctrl+Space handler (git diff clean) — not a #2830 regression.

## R-13 — The removed `StreamStatus` does not return, and the single LED does not pulse

- [x] R-13: `StreamStatus` is NOT reintroduced (no dual-bottom-LED); the single top-right LED does NOT pulse (steady state) — the streaming/activity signal is out of scope and must not reappear as a second LED or a pulsing top-right dot. **PASS (spec/2830 round 1):** `StreamStatus.tsx` deleted; grep of `apps/ui/src` for `StreamStatus` → 5 comment-only hits (no import/render); DOM `statusRoles=["Online"]` only, `bottomCenterRadiusDots=0`; `ledCount=1` after window open/close; LED driven solely by `isOnline` (not row mutations) so it does not pulse.

## R-14 — No re-render loop from the hover/tooltip state

- [x] R-14: Hovering/focusing the LED trigger (open/close tooltip) does not introduce a re-render loop — the console stays clean of `Maximum update depth exceeded`. No effect depends on array `.length` or newly-created object refs. **PASS (spec/2830 round 1):** `tauri_read_logs(source=console)` across the hover/focus/Escape tooltip cycles shows NO `Maximum update depth exceeded` / `Uncaught` (only the stale pre-test Vite HMR note for the deleted `StreamStatus.tsx`).

---

## #2838 extension — left-edge auto-hide dock: no desktop-chrome regression

> Issue #2838 — the #2821 bottom-docked tray is REPLACED by a left-edge auto-hide app dock
> (pure consumer; window kernel READ-ONLY). #2830 R-7..R-14 above remain the baseline and must
> hold. Map 1:1 to `.opencode/tmp/2838/triage.md` `## QA Expert` (EARS D-10 / AC6; NFR-7).

- [x] R-15 (#2838): the #2830 desktop-chrome invariants hold unchanged with the dock present. EXPECTED: notch/avatar/command-bar/side-tick rulers/dot-grid/rounded frame/hints geometry unchanged (R-7); clock advances + exactly one top-right LED + no bottom LEDs (R-8/R-13); band z 1200↔0 sink/cover intact (R-9); band wrapper stays `pointer-events:none` (R-10); changed dock/chrome files token-native — zero hardcoded hex/`rgba(`/`rgb(` and zero `var(--x)NN` alpha-append (R-11); Ctrl+Space launcher + #2821 fidelity hold (R-12); no re-render loop from the dock reveal/hide + hover state (R-14 pattern). The dock adds NO desktop-chrome overlay above the window stack at rest and no second LED/status surface returns; `DOCK_Z_INDEX = 1200` (left-edge rail, ~88px top/bottom insets) never occludes the top-right clock/LED cluster or the window min/max/close controls.
  - **PASS (spec/2838 @ 6ccf4820, round 1).** R-7: dock diff touches only `Home.tsx` mount + new `dock/` files + deleted `AppDrawer.tsx` — no LauncherChrome/desktop-chrome geometry change (R-7 holds). R-8/R-13: clock advanced 03:51→04:41 live; `ledTriggers:1`, `statusRoles:["Online"]`, `bottomDotCount:0` — exactly one top-right LED, no bottom LEDs/no second status surface. R-9: band/surface z 1100 rest → 0 with a visible window → 1300 under Ctrl+Space, verified live. R-10: band wrapper `pointerEvents:"none"`. R-11: `dock/AppDock.tsx`+`DockEntry.tsx` grep = zero hex/rgba/rgb/hsla/`var(--x)NN` literals (only `#2838`/`#2821` comment refs); colors token→var→`tint()` only (window-manager F-30). R-12: Ctrl+Space round-trip verified (z1300 + searchbox focus → ESC → z0/1100); #2821 clock-clean fidelity holds. R-14 pattern: reveal/hide + hover/tooltip cycles produced no `Maximum update depth exceeded` (console read per leg; attribution notes in window-manager F-34). Dock at rest adds no overlay above the window stack (F-14 evidence); revealed rail disjoint from clock/LED and never above the Ctrl+Space overlay (`launcherZ:1300 > dockZ:1200`).

---

## #2841 extension — desktop chrome polish: non-goals / must-not-change invariants

> Issue #2841 — desktop chrome polish. NO-CHANGE invariants that must hold while the
> rail becomes resting-visible, the clock/LED cluster is centered, and the settings
> button hoists to the chrome tier. Map 1:1 to `.opencode/tmp/2841/triage.md` `## QA Expert` (non-goals / R-7). Run the #2838/#2830 regression baseline (R-7..R-15) alongside — the delayed by deliberate redesign deviations (rail rest state, cluster geometry, settings z-order) are the AC, NOT fidelity failures.

## R-16 — Window lifecycle, z-order, and Ctrl+Space launcher are untouched

- [ ] R-16: Window lifecycle (open/close/minimize/restore/focus/maximize), the z-order model (#2825 window frame z=1 > band z 0 covered / 1200 uncovered), and the #2823 Ctrl+Space launcher toggle (opens + focuses searchbox, ESC closes, focus restores) behave EXACTLY as before. The rail stays a PURE READ-ONLY consumer of `useWindows()`/`useWindowActions()` — it never edits `windowStore.ts`/`windowTypes.ts`/the window components; no Rust diff (NFR-1).
  - **Edge:** Ctrl+Space over a maximized window (launcher z1300 > rail z1200 > band z0 covered); window min/max/close clickable with the rail resting-visible AND covered; minimize does NOT auto-focus the rail.

## R-17 — The single top-right LED + advancing clock contract is preserved (no LED regression)

- [ ] R-17: Exactly ONE top-right status LED (no bottom LEDs / no second status surface), the clock HH:MM still advances on the 60s interval, and the band still sinks to z0 under a window so the `led-overlay.png` class bug does NOT recur. The ONLY intended change is the cluster's position (centered) — the LED count/size/state-machine and the clock timer must be untouched.
  - **Edge:** exactly one LED trigger in the `<time>` cluster; no `StreamStatus` reintroduced; LED driven by `isOnline` (no pulse).

## R-18 — Changed files token-native; no `var(--x)NN`; Chakra v3 only

- [ ] R-18: The changed files (dock/AppDock.tsx, dock/DockEntry.tsx, launcher/LauncherChrome.tsx, settings/FloatingSettingsButton.tsx, Home.tsx) carry ZERO hardcoded hex/`rgba(`/`rgb(`/`hsla(` and NO `var(--x)NN` alpha-append (#2770); colors flow token → CSS var → `tint()`/`color-mix`; Chakra v3 API only (no v2 `isDisabled`/`colorScheme`/`NativeSelect`). The `FloatingSettingsButton.tsx:31` `rgba(0,0,0,0.2)` box-shadow is a KNOWN in-scope literal that MUST be converted (this is the intended fix, not a regression).
  - **Edge:** destructive close affordance uses `tint('var(--status-error)',N)`, NOT `variant="outline" colorPalette="red"` (#431 pitfall); no hardcoded accent hex.

## R-19 — The resting-visible rail does not break the covered/peek coexistence

- [ ] R-19: When `coveredByWindow === true` (a maximized window covers the desktop), the rail reverts to the exact #2838 peek-only model (off-canvas at rest, slides in on ≤6px left-edge cross) so the window stays full-bleed — honoring the #2825 chrome-vs-window painting rule. When `coveredByWindow === false` (clean desktop), the rail rests visible. The transition between the two must not leave a stale state or a re-render loop.
  - **Edge:** open a window (covered) → close it (clean) → the rail flips resting-visible cleanly; maximize→restore; console clean of `Maximum update depth exceeded` (NFR-2 transition-only reveal preserved).

## R-20 — Corner cluster cleanup: no clock/LED overlap regressions remain

- [ ] R-20: The clock/LED cluster centering change does NOT reintroduce any overlap of the cluster or the rail with the window titlebar min/max/close controls (`windows-buttons-time-overlap.png` class bug must NOT recur), and the cluster stays DISJOINT from the left-edge rail (`getBoundingClientRect` disjointness holds).
  - **Edge:** maximized full-bleed; window dragged under the cluster; rail revealed vs hidden; light + dark; narrow viewport.

Overlapping suites to run alongside: `window-manager` (window lifecycle + rail F-25..F-35 from #2838), `launcher` (Ctrl+Space + grid + clock), `theming` (preset re-tint).
