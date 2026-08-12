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
