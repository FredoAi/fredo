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
