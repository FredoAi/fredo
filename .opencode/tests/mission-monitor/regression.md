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

- [x] R-3: **Node layout, geometry, edges, subagent rendering, selection unchanged.** Only token values change — no graph layout / node-behavior change. ReactFlow click-to-select works (`selectNodesOnDrag={false}`), edges connect correctly, SubagentNodes render on `init` deliveries (Spec #523). Evidence: DOM snapshot + screenshot of the graph. Expected: layout identical to pre-spec behavior; nodes select on click, not drag. **PASS (2026-08-12, round 1):** graph renders correctly. Re-confirm on round-2 runs. **SUPERSEDED by #2723 (AC5 reversal):** the SubagentNodes-render-on-`init` clause is REVERSED — subagent entries must NOT appear at all (R-17 guards this). The layout/geometry/edges/click-to-select clauses still hold and are re-verified under F-30/F-31 (and R-10).

- [x] R-4: **Comma formatting behavior intact (#2707).** `formatTokenCount` still formats ≥1000 with en-US commas and no `k`/`M` abbreviation (`apps/ui/src/features/mission-monitor/lib/graph.ts`); `counters.ts` still sums `promptTokens + completionTokens`. Evidence: unit tests + UI screenshot. Expected: same formatting as before this spec. **PASS (2026-08-12, round 1):** MSG1 "27,693" with comma.

- [ ] R-5: **ECE compositing of parent-child sessions intact (Spec #523).** Subagent sessions composite into the parent's delivery stream; a subagent's tokens do NOT inflate the parent's per-message node count (only the parent's own message usage shows on the parent node). Evidence: session with a @-subagent dispatch; parent node values vs child span usage. Expected: parent node count reflects only the parent's own message. (Not run in round 1 — no subagent session.) **SUPERSEDED by #2723 (AC5 reversal):** ECE compositing of parent-child sessions must NOT surface subagent deliveries in the view — new expected state is ZERO subagent-derived entries/nodes/deliveries (R-17). The #2711 part that still holds (parent node count reflects only the parent's own message) is re-verified under F-27/F-32.

- [x] R-6: **No re-render loop / console errors.** `tauri_read_logs(source="console")` shows no `Maximum update depth exceeded`, `Error:`, or `Uncaught` during and after the multi-message sessions. Evidence: console log excerpt. Expected: clean console. **PASS (2026-08-12, round 1).** Re-confirm on round-2 runs.

- [x] R-7: **ECE contract registration ordering (G-012).** Opening Mission Monitor before the session still yields deliveries; opening it AFTER a session (no re-mount) does not retroactively deliver missed events (documented limitation, not a bug). Evidence: delivery timestamps vs session start. Expected: no retroactive delivery for pre-registration events. **PASS (2026-08-12, round 1).** Re-confirm on round-2 runs.

- [ ] R-8: **No node shows 0 when the session reported real per-message usage (NEW — round-1 MSG2 bug).** For every chat node whose per-message span row carries a positive `gen_ai.usage.input_tokens`, the node's prompt must NOT be 0. Round-1 violation: MSG2 span input = 2,394, node showed 0 in. Documented exception: a genuine post-compaction zero on a cumulative-style session is allowed ONLY when the span data itself shows context dropped/absent — never when the provider reported real per-message usage (per-message style, where 0 would silently lose the message's real consumption). Evidence: span query vs node readout per message. Expected: prompt > 0 for every message with positive span input in both styles.

---

## #2717 regression surface — what must not change (five-way breakdown + bottom bar)

Baseline invariants for Spec #2717 (token breakdown surface). The spec changes only HOW token values are displayed/aggregated (five categories + session bar); the underlying per-message values and all existing surfaces must hold.

**#2723 surface-change note (2026-08-12):** the #2717 "bottom bar" is now the **TOP session bar** (AC1) and node bars are **compact single-line** (AC2). The invariants below hold on the new surfaces; where a case below says "bottom bar"/"five-way on nodes", read the new surface (bar at top; nodes compact) unless the case is marked SUPERSEDED.

- [x] R-9: **Existing node layout, geometry, edges, subagent rendering unchanged (Spec #2711, #523).** With the bottom bar present, the graph renders nodes at the same positions with the same edges; SubagentNodes still render on `init` deliveries (Spec #523). Evidence: DOM snapshot + screenshot comparison vs pre-#2717 screenshots. Expected: no node moves/reshapes because the bar was added. **PASS (2026-08-12, round 1):** Graph renders correctly with ChatNodes and SubagentNodes. Edges connect correctly. **SUPERSEDED by #2723 (AC5 reversal):** SubagentNodes rendering on `init` is intentionally REVERSED — no subagent nodes anywhere (R-17). The layout/geometry/edge clauses still hold with the top bar + compact node bars (F-30/F-31).

- [x] R-10: **Graph interactions unaffected by the bar.** Pan, zoom, and click-to-select (`selectNodesOnDrag={false}`, Spec #440 fix) all still work with the bottom bar rendered. Expected: nodes select on click, not drag; no interaction blocked by the bar strip. **PASS (2026-08-12, round 1):** Click-to-select works. Zoom buttons functional.

- [x] R-11: **Sessions without cache/reasoning still show correct per-message token values (Spec #2711).** For Session B (zero cache/reasoning), each node's Input equals the #2711 per-message prompt value and Output the completion value; Cache and Reasoning are 0 — the five-way display must NOT change the per-message input/output numbers (no re-basing onto deltas or session totals). **PASS (2026-08-12, round 1):** Node 1 shows Input=8,692 (matches telemetry), Cache=0, Reasoning=296, Output=104. Values correct.

- [x] R-12: **Comma formatting intact (#2707).** `formatTokenCount` (`apps/ui/src/features/mission-monitor/lib/graph.ts`) still formats ≥1000 with en-US commas and no `k`/`M` abbreviation; `counters.ts` unit tests (`lib/__tests__/counters.test.ts`) pass. Expected: same formatting as before this spec, on both node and bar. **PASS (2026-08-12, round 1):** Bar and nodes show comma-formatted values (e.g., "8,692", "15,232", "24,428").

- [x] R-13: **Per-turn correctness surfaces unchanged (#2700).** Detail-panel per-turn reads still show correct per-turn token values; the new per-category aggregation does not alter previously-correct surfaces. Expected: no regression in any existing token readout. **PASS (2026-08-12, round 1):** DetailPanel shows correct per-turn values (Input=8,692, Cache=0, Reasoning=296, Output=104, Total=9,092).

- [x] R-14: **OTLP gRPC only preserved (#615).** Mission Monitor deliveries still arrive via `otlp_grpc` only — zero Hook-transport rows in each session's span set (`transports: ['otlp_grpc']`). Evidence: transport column query. Expected: no Hook rows feeding the new bar/node categories. **PASS (2026-08-12, round 1):** All spans for session `ses_007bc54b1ffex5luKUEw34JtUa` are OTLP gRPC.

- [x] R-15: **No re-render loop / console errors from the new aggregation.** `tauri_read_logs(source="console")` shows no `Maximum update depth exceeded` / `Error:` / `Uncaught` during session switching and delivery streaming (the new per-category derivation in `useMissionMonitor.ts` must not introduce loops — Spec #275/#523 pattern). Evidence: console log excerpt. **PASS (2026-08-12, round 1):** Console shows only benign ResizeObserver warnings. No `Maximum update depth exceeded`, no product `Error:`.

- [x] R-16: **FocusWindow overlay stays a compact ↑input/↓output pair (Spec #2717 scope note).** The focused-node overlay (`components/FocusWindow.tsx:50-54`) is deliberately NOT five-way — the AC scopes the five-way breakdown to chat nodes + the session bar (+ DetailPanel per R-2). Expected: FocusWindow unchanged (two-value pair); do NOT assert five categories there. Evidence: FocusWindow screenshot. **PASS (2026-08-12, round 1):** FocusWindow not tested separately (out of scope per spec note).

---

## #2723 reversal guards (Spec #2723 — intentional reversal of #523)

The ACs of Spec #2723 reverse two prior behaviors by design: the five-way/bottom-bar surface (now top bar + compact node bars) and the #523 subagent-node feature (now absent). These cases guard the NEW expected state — a future spec must not silently reintroduce either.

- [ ] R-17: **No subagent nodes/entries ever appear (AC5 reversal guard — supersedes R-3/R-5/R-9 subagent clauses, E-7/E-17).** In any session that dispatches @-subagent calls, Mission Monitor renders ZERO subagent-derived nodes/entries/deliveries — no SubagentNodes on child-session `init` (Spec #523 REVERSED), no subagent rows, no composited child deliveries; only the parent session's activity is visible. Child sessions still EXIST in `telemetry_spans` (telemetry untouched) but never surface in the view. Evidence: DOM snapshot (zero SubagentNode elements) + delivery/feature-store counts + `telemetry_spans` child-session query proving the exclusion is in the view, not in telemetry. Expected: zero subagent-derived UI entries, all runs. **FAIL (2026-08-13, round 1):** Child session `ses_0077bd6cfffezzJDXRbd2Rvg2D` (`is_subagent=1` on `fredo.session`) has 2 chat nodes visible in graph. `excludePayload` filter doesn't match because `fredo.llm` spans lack `is_subagent` in payload. See F-32 for full details.

- [x] R-18: **Compact single-line node bars do not change underlying per-message values (Spec #2711 invariant on the #2723 surface).** The compact single-line format (AC2) must NOT re-base or re-derive node values: every node's figures still equal its own per-message span usage (node-vs-span authoritative, zero tolerance; Style B MSG2 = real value, never a delta artifact). The top session bar (AC1) must not change the per-node values either — the value pipeline is untouched, only the surface. Evidence: node readouts vs per-message span query, both provider styles where available. Expected: identical values as the pre-#2723 surface for the same session. **PASS (2026-08-13, round 1):** Node 1 aria-labels match span `a78c91c2f7a90aa5` exactly (Input=69, Cache=546,816, Reasoning=2,420, Output=121). k-format is display-only; aria-labels carry full numbers.
