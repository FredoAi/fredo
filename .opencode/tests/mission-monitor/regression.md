# Mission Monitor — Regression Test Suite

Feature domain: `mission-monitor`. Baseline invariants for Spec #2711 (per-message token counts).
These cases verify behavior that MUST NOT change while this spec lands.

**Round 2 (retry):** R-1 re-opened (round-1 node values were wrong even though the inequality held — the fix changes node totals, so the invariant must be re-verified with corrected values). R-8 added (round-1 MSG2 zero-value regression). R-2/R-3/R-4/R-6/R-7 stand on independent surfaces; re-confirm on the round-2 live runs. R-5 never ran (no subagent session in round 1).

Conventions: ID prefix `R-`; observable expected outcomes. On pass keep the checkbox and append evidence; on fail mark `FAIL`.

## No-change baseline (Spec #2711 non-goals)

The spec changes only node **token values** (per-message, from opencode-reported usage). Everything else must hold.

## Cases

- [ ] R-1: **Per-message values are NOT session-cumulative (RE-OPENED).** After each multi-message Run CLI session (both styles), no chat node's total equals the session-cumulative context total; the node's value is the per-message consumption only. With corrected values: Style B MSG2 total = 2,413 (round-1 showed 19 — the inequality held but the value was wrong). Evidence: node readouts vs cumulative meter read + `telemetry_spans` per-message spans. Expected: every node total strictly < session total for ≥2-message sessions, in both styles. Round-1 PASS (2026-08-12) INVALIDATED — re-verify with corrected values.

- [x] R-2: **OTLP gRPC only — no Hook transport.** Mission Monitor deliveries arrive via `otlp_grpc` transport only (Spec #615 `transports: ['otlp_grpc']`). `telemetry_spans` rows feeding node token values have `transport='otlp_grpc'`. Evidence: transport column query. Expected: zero Hook-transport rows in each session's span set; node counts unchanged by any Hook events. **PASS (2026-08-12, round 1):** round-1 session spans all `otlp_grpc`. Re-confirm on both round-2 sessions (cheap: same query).

- [x] R-3: **Node layout, geometry, edges, subagent rendering, selection unchanged.** Only token values change — no graph layout / node-behavior change. ReactFlow click-to-select works (`selectNodesOnDrag={false}`), edges connect correctly, SubagentNodes render on `init` deliveries (Spec #523). Evidence: DOM snapshot + screenshot of the graph. Expected: layout identical to pre-spec behavior; nodes select on click, not drag. **PASS (2026-08-12, round 1):** graph renders correctly. Re-confirm on round-2 runs.

- [x] R-4: **Comma formatting behavior intact (#2707).** `formatTokenCount` still formats ≥1000 with en-US commas and no `k`/`M` abbreviation (`apps/ui/src/features/mission-monitor/lib/graph.ts`); `counters.ts` still sums `promptTokens + completionTokens`. Evidence: unit tests + UI screenshot. Expected: same formatting as before this spec. **PASS (2026-08-12, round 1):** MSG1 "27,693" with comma.

- [ ] R-5: **ECE compositing of parent-child sessions intact (Spec #523).** Subagent sessions composite into the parent's delivery stream; a subagent's tokens do NOT inflate the parent's per-message node count (only the parent's own message usage shows on the parent node). Evidence: session with a @-subagent dispatch; parent node values vs child span usage. Expected: parent node count reflects only the parent's own message. (Not run in round 1 — no subagent session.)

- [x] R-6: **No re-render loop / console errors.** `tauri_read_logs(source="console")` shows no `Maximum update depth exceeded`, `Error:`, or `Uncaught` during and after the multi-message sessions. Evidence: console log excerpt. Expected: clean console. **PASS (2026-08-12, round 1).** Re-confirm on round-2 runs.

- [x] R-7: **ECE contract registration ordering (G-012).** Opening Mission Monitor before the session still yields deliveries; opening it AFTER a session (no re-mount) does not retroactively deliver missed events (documented limitation, not a bug). Evidence: delivery timestamps vs session start. Expected: no retroactive delivery for pre-registration events. **PASS (2026-08-12, round 1).** Re-confirm on round-2 runs.

- [ ] R-8: **No node shows 0 when the session reported real per-message usage (NEW — round-1 MSG2 bug).** For every chat node whose per-message span row carries a positive `gen_ai.usage.input_tokens`, the node's prompt must NOT be 0. Round-1 violation: MSG2 span input = 2,394, node showed 0 in. Documented exception: a genuine post-compaction zero on a cumulative-style session is allowed ONLY when the span data itself shows context dropped/absent — never when the provider reported real per-message usage (per-message style, where 0 would silently lose the message's real consumption). Evidence: span query vs node readout per message. Expected: prompt > 0 for every message with positive span input in both styles.
