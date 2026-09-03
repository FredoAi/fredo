# Mission Monitor — Regression Baseline (Spec #2791 — Ghost sessions)

> The "must not change" baseline for this spec + links to overlapping prior suites. Run on every testing phase that touches the mission-monitor surface.

## Must NOT change (regression invariants)

- [x] R-1 (G-074, PASS 2026-09-02 #2791): A session whose telemetry spans have NOT yet landed (zero nodes + zero landed spans) still renders the transient empty state — selecting it must NOT show the ghost explanatory state and must NOT be a silent blank.
- [x] R-2 (PASS 2026-09-02 #2791): A normal session (landed rows + rendered nodes) still renders its graph with the pre-fix node layout/colors/edges. No layout/color/edge change.
- [x] R-3 (PASS 2026-09-02 #2791): Telemetry ingestion, storage, and tool-outcome classification are unchanged. No v1 hydration / fallback extraction reintroduced; the RTDB row path (`useEventRows`) is the only row source.
- [x] R-4 (PASS 2026-09-02 #2791, #523 compositing semantics): row-level compositing (not event-level rewrite) is respected — the relationship registry's first-wins stamp persists, a re-key never removes rows (only retention eviction emits `kind: remove`), and child-session rows composite under the parent key carrying `parentSessionId` + `compositedChildSessionId`.
- [x] R-5 (PASS 2026-09-02 #2791): No new re-render loops — epoch-based recomputation; no `Maximum update depth exceeded` with `.length`/object-ref effect deps.
- [x] R-6 (PASS 2026-09-02 #2791): Subagent `build`/`plan` internal tool-execution sessions are still excluded from the graph; user-requested @-subagent dispatches still produce SubagentNodes when the parent anchor resolves; subagent chat rows excluded from the graph (isSubagentChatRow) while the parent session still lists.

## Overlapping prior-feature suites

- Priority prior mission-monitor regression legs (chat node rendering, embedded `── TOOLS (N) ──` section, subagent nodes, session list derivation) — inherited and extended by this spec.
- This spec's functional suite: `.opencode/tests/mission-monitor/functional.md` F-1..N and N-1..N-3.

---

# Mission Monitor — Regression Baseline (Spec #2792 — Tool-failure reason in detail view)

> The "must not change" baseline for this spec + links to overlapping prior suites. Run on every testing phase that touches the mission-monitor surface.

## Must NOT change (regression invariants) — Spec #2792

- [ ] R-7 (PASS gate): Tool-outcome classification (`getToolCallOutcome`, graph.ts:123-128) is unchanged — a failed call is still `error` when `call.error` is a non-empty string OR `success === false`; a success/`in-progress` call is never re-classified to `error` merely because a reason row now renders. No change to tool-outcome classification.
- [ ] R-8 (PASS gate): Graph-node colors/edges, chat-node/subagent-node layout, and session-list/graph derivation are unchanged — adding a reason row to the scoped tool-call detail view must NOT alter the graph canvas, node set, or edges.
- [ ] R-9 (PASS gate): Upstream error capture is unchanged — `tool.error` → `ToolUseRow.toolError` remains the single source (EventSubscription.ts:103, classifier); no change to ingest/classification/storage.
- [ ] R-10 (PASS gate): A succeeded tool call still shows NO error/reason row (no regression to the success case — REQ-4).
- [ ] R-11 (PASS gate): Contract-trust preserved — the detail view consumes the projected `ToolCallSummary.error` single path (rowDerivation.ts:276); NO `??` fallback chains / multi-path lookups / output-derived reason (REQ-5).
- [ ] R-12 (PASS gate): No new re-render loop — epoch-based recomputation; no `Maximum update depth exceeded` with `.length`/object-ref `useEffect` deps (NFR-2).
- [ ] R-13 (PASS gate): Subagent `build`/`plan` internal tool-execution sessions remain excluded from the graph; user-requested @-subagent dispatches still produce SubagentNodes when the parent anchor resolves (from Spec #509/#523 — unchanged by #2792).

## Overlapping prior-feature suites

- Priority prior mission-monitor regression legs (chat node rendering, embedded `── TOOLS (N) ──` section, subagent nodes, tool-call accordion/detail views from Spec #2739/#2743/#2764, session list derivation) — inherited and extended by this spec.
- This spec's functional suite: `.opencode/tests/mission-monitor/functional.md` F-7..F-11 and N-4..N-5.
