# Regression — stream-health

The "must not change" baseline for feature #3064. Run on every testing phase that touches the
stream/telemetry status surface (`StreamContext`, the LED telemetry line, the Mission Monitor
banner, the Dev Mode badge, the row pipeline). Every invariant below is a FAIL if the spec
branch changes it.

## Must NOT change (regression invariants)

- [ ] **R-1 (row pipeline untouched):** the heartbeat rides the EXISTING `fredo-stream-event` channel as a `{"streamHealth": …}` envelope; the RTDB row path (`emit_row_delivery_batch` → `RowDeliveryBatch` → `useEventRows`) and the application-data path (`applicationBatch`) are UNCHANGED. The `streamHealth` envelope is discriminated BEFORE the application/row validators so it can never be mis-routed into the row store. Cross-check `telemetry_spans`/row counts + shape at the same instant.
- [ ] **R-2 (row-store merge semantics preserved):** `insert` spread-merges (init-time fields survive), `update` is seq-guarded with stale-patch drops, `remove` only ever from retention eviction (`StreamContext.tsx`). The health work must not bypass or replace these semantics.
- [ ] **R-3 (`useConnectionStatus()` signature stable):** `useConnectionStatus()` still returns `{ isConnected }`; every existing consumer (`useFredoHealth.ts:204`, `MissionMonitorPanel.tsx:1023/1047`, `useDevModeStream.ts:84/147`) still compiles + reads connected when `health === 'healthy'`. `isConnected` becomes DERIVED (`health === 'healthy'`), NOT a mount constant — but the observable contract (true ⇒ connected) is preserved.
- [ ] **R-4 (`notSetUp`/`unknown` stay NEUTRAL):** the new `degraded` member added to `SubsystemHealth` must NOT alter the neutral handling — `notSetUp`/`unknown` never degrade the aggregate (`aggregateFredoHealth`, `fredoHealth.ts:81-90`; `fredo-health-led` R-7 / AC4).
- [ ] **R-5 (no new colours / no new DOM):** the telemetry line uses `healthToken` → existing `var(--status-warning)`/`var(--status-error)`/`var(--accent-primary)`; tints/halos via `tint()` (`color-mix`); NO hardcoded hex/rgba; NO invalid `var(--x)NN` alpha-append (#2770). REUSE `desktop-status-led`, `desktop-status-led-overall`, `health-line-telemetry` — NO new testid/DOM.
- [ ] **R-6 (no re-render loops, #523):** no `.length`/newly-created object-ref `useEffect`/`useMemo` deps; display state derived via `useMemo`/`useSyncExternalStore`; no `Maximum update depth exceeded` after any state transition.
- [ ] **R-7 (no cross-application imports):** all new shared code lives under `apps/ui/src/shared/`; no feature imports another feature; the Mission Monitor / Dev Mode consumers are UNCHANGED.
- [ ] **R-8 (no auto-launch / no STT probe):** the new producer does NOT mount `useCompanionReadiness` — no auto-launch of the managed server, no `stt_list_devices` probe (G-023). Only the read-only `stream_health` command is invoked.
- [ ] **R-9 (bounded state):** the producer holds ONE interval + a module-scoped freshness marker — no unbounded structure, no per-render allocation growth.

## Overlapping prior-feature suites

- `.opencode/tests/fredo-health-led/` — the #3052 composite LED suite; this spec extends its telemetry line with the `degraded` member (its R-7/R-8 must be re-scoped per the #3064 section appended there).
- `.opencode/tests/mission-monitor/regression.md` — the banner consumer (R-33..R-44 etc.); the banner must not regress.
- `.opencode/tests/realtime-data/regression.md` — the row pipeline / row-store semantics the heartbeat must not disturb (R-1/R-2 above).
- `.opencode/tests/otlp-genai/` — the OTLP emission/classification channel the ingest liveness observes; run the unaffected legs.

## Verification policy

LIVE — the exit gate / audit fail-closed unless the tester's Evidence references a
`telemetry_spans` live-query result. A static-only PASS is a FALSE PASS.
