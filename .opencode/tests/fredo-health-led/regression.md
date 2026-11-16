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

---

# fredo-health-led — Regression Re-scope (Spec #3064 — real stream health)

> The telemetry subsystem line changes from a two-valued `healthy`/`down` mount constant to the
> three-valued `StreamHealth` (`healthy` | `degraded` | `down`). Two of the invariants above are
> affected and MUST be re-scoped for #3064. Everything else in this file still holds.

- [ ] **R-8 (RE-SCOPED #3064):** `useConnectionStatus()` keeps its `{ isConnected }` signature (still holds), BUT `isConnected` is now DERIVED (`health === 'healthy'`) rather than a mount constant, and `StreamContext` carries a three-valued `health`. The observable contract is preserved: `isConnected === true` ⟺ `health === 'healthy'`. The OLD assertion "`isConnected` remains the connection flag" is superseded — assert the DERIVED equivalence instead.
- [ ] **R-7 (RETAINED #3064):** `notSetUp`/`unknown` stay NEUTRAL and never degrade the aggregate — the new `degraded` member must NOT alter this. (Unchanged invariant; re-run against the widened `SubsystemHealth` union.)
- [ ] **R-1..R-6, R-9, R-10 (UNCHANGED #3064):** the LED trigger contract, tooltip open behaviour, z-sink, pointer-events, clock, hover/focus-only slice, `useCompanionReadiness` non-mount, token-only colours, and the single-LED header invariant all still hold — the #3064 change is ADDITIVE to the telemetry line only (no new DOM/testid).

## Overlapping suite for #3064

- `.opencode/tests/stream-health/` — the feature's own suite (functional F-1..F-9 + N-1..N-4, regression, exploratory, smoke). Run it alongside this file's re-scoped invariants.
