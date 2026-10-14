# Regression — fredo-health-led

The "must not change" baseline. Run on every testing phase that touches the launcher LED / stream-context surface. A spec that widens the LED must not alter any of these.

- [x] **R-1:** the `[data-testid="desktop-status-led"]` trigger still exists as the SINGLE consolidated LED (the former `StreamStatus` pair is not reintroduced — #2830), keeping `role="status"`, `aria-live="polite"`, `aria-atomic="true"`, `tabIndex={0}`.
- [x] **R-2:** the tooltip still opens on BOTH hover and focus (Chakra v3 `Tooltip.Root`, `openDelay` respected).
- [x] **R-3:** #2825 z-sink — when `coveredByWindow` is true the whole chrome band rests at `zIndex 0` (vs 1200 uncovered).
- [x] **R-4:** the band root stays `pointerEvents="none"`; `pointerEvents="auto"` is re-enabled ONLY on the notch and the LED trigger.
- [x] **R-5:** the 60 s clock is untouched (same cadence + formatting).
- [x] **R-6:** the slice is hover/focus-only — no click-through surface/route is introduced.
- [x] **R-7:** the LED does NOT mount `useCompanionReadiness` — no auto-launch of the managed server, no `stt_list_devices` probe (G-023).
- [x] **R-8:** the `StreamContext` contract is unchanged (`isConnected` remains the connection flag; `useConnectionStatus()` shape stable).
- [x] **R-9:** tokens only — no new colours/tokens; tints via `tint()` (`color-mix`); no alpha-append onto a `var()` (#2770).
- [x] **R-10:** the header comment + the single-LED invariant (`LauncherChrome.tsx:34-39`) stay accurate.

## Overlapping suites

- `apps/ui/src/applications/home/components/launcher/__tests__/` — launcher surfaces (palette, open-apps, resting, command bar).
- `apps/ui/src/shared/components/companion/__tests__/` — companion readiness + `deriveServerLaunchState`.
- `apps/ui/src/shared/hooks/__tests__/` — shared hooks.
