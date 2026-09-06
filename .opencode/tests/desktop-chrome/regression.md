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

- [ ] R-7: The FREDO notch, pixel-butler avatar, `>` command bar, side-tick rulers, dot-grid, rounded frame, and the keyboard-hints row geometry are UNCHANGED (only the top-right LED/`onlineLabel` cluster in `LauncherChrome.tsx`, and the `StreamStatus` component, change). No layout shift of the clock/notch/nav hints.

## R-8 — The clock HH:MM text is retained and still advances

- [ ] R-8: The top-right clock time (`HH:MM`) is retained and still updates on the 60s interval timer (`LauncherChrome.tsx`); only the `Online` text label row is removed. The clock does not break/disappear.

## R-9 — The #2825 desktop-chrome z-order model is preserved

- [ ] R-9: Band z = 1200 when the desktop is uncovered; the whole band (clock + LED + frame + side ticks) sinks to z = 0 below the z = 1 window stack `coveredByWindow`-driven. The LED never paints over the window titlebar min/max/close controls (`bugs/led-overlay.png` must NOT reproduce). Composed stacking: window frame z=1 > band z (0 when covered). Reference #2825 F-1/F-3.

## R-10 — Chrome band stays passive; only the LED trigger re-enables pointer events

- [ ] R-10: The chrome band wrapper stays `pointerEvents="none"` (NFR-5); only the LED trigger re-enables `pointerEvents="auto"` on its OWN element (mirroring the FREDO notch, `LauncherChrome.tsx:327`) so the enlarged LED is hoverable/focusable but the band never swallows a pointer. No new invisible overlay intercepts the window min/max/close (reference #2825 F-5).

## R-11 — Token-native; no hardcoded color; Chakra v3 only

- [ ] R-11: The changed files carry ZERO hardcoded hex/`rgba(`/`rgb(` and NO `var(--x)NN` alpha-append (#2770); colors flow theme token → CSS var → `tint()`/`color-mix`; Chakra v3 API only (no v2 `isDisabled`/`colorScheme`, no `NativeSelect`). Reference #2825 R-6 + launcher R-5/R-9/R-12/R-14.

## R-12 — #2823 Ctrl+Space launcher + #2821 fidelity fixes remain

- [ ] R-12: The #2823 Ctrl+Space toggle (opens + focuses the searchbox, ESC closes, focus restores) and the #2821 desktop-fidelity fixes (clean top-right clock; no clock/LED overlap of window controls) are intact. The LED change must not break the shortcut-open `coveredByWindow` sink or the resting/engaged launcher z-model.

## R-13 — The removed `StreamStatus` does not return, and the single LED does not pulse

- [ ] R-13: `StreamStatus` is NOT reintroduced (no dual-bottom-LED); the single top-right LED does NOT pulse (steady state) — the streaming/activity signal is out of scope and must not reappear as a second LED or a pulsing top-right dot.

## R-14 — No re-render loop from the hover/tooltip state

- [ ] R-14: Hovering/focusing the LED trigger (open/close tooltip) does not introduce a re-render loop — the console stays clean of `Maximum update depth exceeded`. No effect depends on array `.length` or newly-created object refs.
