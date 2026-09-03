# Mission Monitor — Regression Baseline (Spec #2791 — Ghost sessions)

> The "must not change" baseline for this spec + links to overlapping prior suites. Run on every testing phase that touches the mission-monitor surface.

## Must NOT change (regression invariants)

- [ ] R-1 (G-074): A session whose telemetry spans have NOT yet landed (zero nodes + zero landed spans) still renders the transient empty state — selecting it must NOT show the ghost explanatory state and must NOT be a silent blank.
- [ ] R-2: A normal session (landed rows + rendered nodes) still renders its graph with the pre-fix node layout/colors/edges. No layout/color/edge change.
- [ ] R-3: Telemetry ingestion, storage, and tool-outcome classification are unchanged. No v1 hydration / fallback extraction reintroduced; the RTDB row path (`useEventRows`) is the only row source.
- [ ] R-4 (#523 compositing semantics): row-level compositing (not event-level rewrite) is respected — the relationship registry's first-wins stamp persists, a re-key never removes rows (only retention eviction emits `kind: remove`), and child-session rows composite under the parent key carrying `parentSessionId` + `compositedChildSessionId`.
- [ ] R-5: No new re-render loops — epoch-based recomputation; no `Maximum update depth exceeded` with `.length`/object-ref effect deps.
- [ ] R-6: Subagent `build`/`plan` internal tool-execution sessions are still excluded from the graph; user-requested @-subagent dispatches still produce SubagentNodes when the parent anchor resolves; subagent chat rows excluded from the graph (isSubagentChatRow) while the parent session still lists.

## Overlapping prior-feature suites

- Priority prior mission-monitor regression legs (chat node rendering, embedded `── TOOLS (N) ──` section, subagent nodes, session list derivation) — inherited and extended by this spec.
- This spec's functional suite: `.opencode/tests/mission-monitor/functional.md` F-1..N and N-1..N-3.
