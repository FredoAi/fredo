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

---

# fredo-health-led — Regression Re-scope (Spec #3180 — honest engine states + cause/remedy)

> Two #3052 invariants interact with #3180. R-7 and R-10 above are retained byte-identical as
> history; the re-scopes below state what actually holds now. Everything else is unchanged.

- [ ] **R-11 (RE-SCOPED R-7, #3180).** The LED still does **not** mount `useCompanionReadiness` (no
      hook-level auto-launch, no `stt_list_devices` probe) — that half of R-7 holds. What changes is
      the OTHER half: the engine is now deliberately started at LAUNCH by Rust
      (`start_companion_engine_on_launch` from `lib.rs`), so "no auto-launch of the managed server"
      is superseded by design. Do not report the launch start as an R-7 regression.
- [ ] **R-12 (RE-SCOPED R-10, #3180).** `LauncherChrome.tsx`'s single-LED header comment must stay
      accurate for the widened row body: each subsystem row now renders `detail`, then `remedy`
      (secondary, wrapping) and `technicalDetail` (mono, muted, single line with a `title` for
      overflow). The comment is a contract: it must describe the remedy/technical-detail fields, not
      only `detail`.
- [ ] **R-13 (#3180 — aggregate + ids/order/labels unchanged).** `SubsystemHealth` gains NO new
      value; worst-wins is unchanged; the four ids, the frozen order
      `telemetry → llamaServer → companionModel → postgres` and the four labels are unchanged;
      `notSetUp` / `unknown` stay NEUTRAL. An engine `down` (a typed failure) is a NON-mandatory
      `down` ⇒ overall `degraded`, never `down`.
- [ ] **R-14 (#3180 — no new control, no colour-only state).** No fourth platform chord, no new
      interactive control in the tooltip (hover/focus only), no new colour literal — colour only via
      `healthToken` / `tint`; every state still conveyed in TEXT (state word + detail + remedy), so a
      status is never colour-only.
- [ ] **R-15 (#3180 — the five anchors survive).** `desktop-status-led`, `desktop-status-led-tooltip`,
      `desktop-status-led-overall`, `health-line-{telemetry|llamaServer|companionModel|postgres}` all
      still render with `data-health-state`; the trigger keeps
      `role="status"` / `aria-live="polite"` / `aria-atomic="true"` / `tabIndex={0}`.
