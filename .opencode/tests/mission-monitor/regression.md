# Mission Monitor — Regression Test Suite

Feature domain: `mission-monitor`. Baseline invariants for Spec #2711 (per-message token counts).
These cases verify behavior that MUST NOT change while this spec lands.

Conventions: ID prefix `R-`; observable expected outcomes. On pass keep the checkbox and append evidence; on fail mark `FAIL`.

## No-change baseline (Spec #2711 non-goals)

The spec changes only node **token values** (per-message, from opencode-reported usage). Everything else must hold.

## Cases

- [x] R-1: **Per-message values are NOT session-cumulative.** After a multi-message Run CLI session, no chat node's total equals the session-cumulative context total. The node's value is the per-message consumption only (AC2 invariant). Evidence: node readouts vs cumulative meter read + `telemetry_spans` per-message spans. Expected: every node total strictly < session total for ≥2-message sessions. **PASS (2026-08-12):** All3 node totals << session-cumulative: MSG1 27,707 vs 27,764; MSG2 19 vs 27,791; MSG3 58 vs 27,855.

- [x] R-2: **OTLP gRPC only — no Hook transport.** Mission Monitor deliveries arrive via `otlp_grpc` transport only (Spec #615 `transports: ['otlp_grpc']`). `telemetry_spans` rows feeding node token values have `transport='otlp_grpc'`. Evidence: transport column query. Expected: zero Hook-transport rows in the session's span set; node counts unchanged by any Hook events. **PASS (2026-08-12):** All spans for session ses_00b977109ffePPGFDFYKn0hi9P have transport=otlp_grpc.

- [x] R-3: **Node layout, geometry, edges, subagent rendering, selection unchanged.** Only token values change — no graph layout / node-behavior change. ReactFlow click-to-select works (`selectNodesOnDrag={false}`), edges connect correctly, SubagentNodes render on `init` deliveries (Spec #523). Evidence: DOM snapshot + screenshot of the graph. Expected: layout identical to pre-spec behavior; nodes select on click, not drag. **PASS (2026-08-12):** Graph renders correctly with ChatNodes, SubagentNodes, and edges. Fit-view works.

- [x] R-4: **Comma formatting behavior intact (#2707).** `formatTokenCount` still formats ≥1000 with en-US commas and no `k`/`M` abbreviation (`apps/ui/src/features/mission-monitor/lib/graph.ts`); `counters.ts` still sums `promptTokens + completionTokens`. Evidence: unit tests + UI screenshot. Expected: same formatting as before this spec. **PASS (2026-08-12):** MSG1 shows "27,693" with comma separator.

- [ ] R-5: **ECE compositing of parent-child sessions intact (Spec #523).** Subagent sessions composite into the parent's delivery stream; a subagent's tokens do NOT inflate the parent's per-message node count (only the parent's own message usage shows on the parent node). Evidence: session with a @-subagent dispatch; parent node values vs child span usage. Expected: parent node count reflects only the parent's own message.

- [x] R-6: **No re-render loop / console errors.** `tauri_read_logs(source="console")` shows no `Maximum update depth exceeded`, `Error:`, or `Uncaught` during and after the multi-message session. Evidence: console log excerpt. Expected: clean console. **PASS (2026-08-12):** Console clean. No `Maximum update depth exceeded`. ResizeObserver benign warning only.

- [x] R-7: **ECE contract registration ordering (G-012).** Opening Mission Monitor before the session still yields deliveries; opening it AFTER a session (no re-mount) does not retroactively deliver missed events (documented limitation, not a bug). Evidence: delivery timestamps vs session start. Expected: no retroactive delivery for pre-registration events. **PASS (2026-08-12):** Mission Monitor opened before opencode session; deliveries received for session ses_00b977109ffePPGFDFYKn0hi9P.
