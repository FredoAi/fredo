# Mission Monitor — Regression Tests

> "Must not change" baseline for #2706. Every testing phase touching the mission-monitor surface runs
> these. Links: guardrails in `docs/agentic-pipeline/playbooks/references.md` (G-010/G-011/G-012),
> legacy specs #523/#586/#593/#2688/#2700. IDs: `R-<n>`.

## ECE lifecycle & graph-builder invariants

- [ ] R-1 Chat-chain edges survive same-batch init+end deliveries (G-011): feed the LIVE delivery shape — init+end pairs for the same key in one batch — and assert one `e-chat-*` edge per consecutive pair via `rf__edge-*` selectors. NEVER use init-only fixtures; NEVER use node-style `data-id` selectors on edges (G-010).
- [ ] R-2 Graph-builder state captured at init (prevCorrId/chain links) is preserved across update and end re-sets (#2688 round-9 fix) — a node whose update/end arrives in the same batch as its init still produces its chain edge.
- [ ] R-3 Update-lifecycle `agentReply` concatenation is idempotent — re-processing the same deliveries (effect re-run, TTL-shrink re-scan) never duplicates response text.
- [ ] R-4 Per-node per-turn token invariant (#2700 ST3): last-wins, never `Math.max` — a session-cumulative total never leaks into a node's count.
- [ ] R-5 `completeWhen` alignment (#586): a user-role event must NOT complete the chat buffer before streaming — assistant-role Response completes it; streaming deltas after completion are never silently discarded (engine.rs:446-448).

## Contract registration & filtering

- [ ] R-6 Contract-registration protocol (G-012): events generated while Mission Monitor is NOT mounted are not delivered (ECE buffers per registered contract) — open MM BEFORE generating test events; a missing-feature-at-send-time gap is a test-protocol failure, not a product bug.
- [ ] R-7 Contract filters (#382/#2688): with `transports:['otlp_grpc','hook']`, `eventTypes:['chat']` on chat-node and Hook-only `eventTypes:['tool_use']` on tool-use-lifecycle, no duplicate nodes appear from hook+otlp dual-transport, and `agent_session` init-only events never create phantom never-completing buffers.
- [ ] R-8 #593 deactivation baseline: the tool-use-lifecycle contract is re-enabled by #2706 ST-8 — verify the re-enablement carries the #586 (EventState↔completeWhen) and #382 (transport/eventType filters) guardrails; OTLP `execute_tool` spans must never create ToolNodes.

## Subagent identity (Spec #509/#523)

- [ ] R-9 Agent-name filter: internal OpenCode tool-execution agent sessions (`build`, `plan`) never emit relationship metadata / create SubagentNodes — only `task`-dispatched @-subagents do (adapter-level filter + frontend belt-and-suspenders).

## Auto-center & camera behavior (#2700)

- [ ] R-10 Auto-center coalesces bursts: a batch of rapid chat-node arrivals triggers at most one center (300ms debounce); manual pan/zoom is preserved for incremental updates after the first fitView.
- [ ] R-11 No re-render loop: console stays free of `Maximum update depth exceeded` (StreamStatus/useEffect length-dependency pattern — #523 cycle 1) across session switches and delivery bursts.

## Persistence (Spec #555 / FeatureStore)

- [ ] R-12 Delivery persistence is shrink-safe (ST11 watermark): a StreamContext TTL shrink mid-session strands no delivery; restore + live dedup by delivery id produces no duplicate nodes.
- [ ] R-13 Session delete is atomic: `markSessionDeleted` before SQLite delete; no resurrected sessions on concurrent delivery arrival.

---

# #2707 readability pass — regression invariants (must NOT change)

> #2707 changes only frontend rendering (token format, panel resize/persist, response scroll, chat title).
> These baseline checks guard against collateral damage. The #2706 R-1..R-13 baselines above remain in force.

- [x] R-14 Node graph still renders — with a finished-run fixture open, chat/session nodes AND edges still render (one `e-chat-*` edge per consecutive pair via `rf__edge-*` selectors, G-010); graph is NOT empty after the frontend-only changes. **PASS**: 57 nodes rendered. Graph NOT empty.
- [x] R-15 Node inspection still opens the panel — clicking a chat node still opens the details panel; DetailPanel still shows Token Usage rows, response text, and metadata; Escape/background-click still closes it. **PASS**: Clicking chat node opens DetailPanel with Token Usage, response text, metadata.
- [x] R-16 No live-updating behavior was added — the static finished-run graph stays static: no polling, no new event-contract subscriptions, no streaming deltas beyond the existing `otlp_grpc` contract (#615); two screenshots 30s apart are identical (no new node appears, no text grows). **PASS**: Static finished-run graph stays fixed.
- [x] R-17 Non-chat node types unaffected — tool-use nodes and subagent nodes (`Subagent · {name}`) keep their titles/labels/behavior; the agent-name filter (#509/#523) still prevents internal `build`/`plan` sessions from creating spurious nodes. **PASS**: Subagent nodes: `Subagent · tester` (unchanged).
- [x] R-18 Token display change does not break layout — with grouped counts (`1,234,567`) in the node bar and DetailPanel rows, no overflow, clipping, or horizontal scrollbar appears; node bar and panel keep their pre-change dimensions/spacing. **PASS**: Grouped counts `2,349`/`2,364` in node bar and DetailPanel rows. No overflow or clipping.
