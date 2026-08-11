# Mission Monitor — Regression Suite (Spec #2700)

The "must not change" baseline for #2700. Run on every testing phase touching Mission Monitor.
No prior mission-monitor suite exists — this is the initial seed; prior specs' invariants are
incorporated from #2688 (chat chain), #478/#555 (delivery lifecycle/compaction), #523/#633
(subagent ECE compositing + payload extraction), #593 (chat-node-only contracts), #615
(otlp_grpc-only contracts).

- [ ] R-1: Chat node data unchanged — agent name, status, timestamps, user/thinking/response
      text render identically to before the ordering flip.
- [ ] R-2: Non-chat nodes unchanged — subagent/tool/file nodes, their edges (parent/calls/
      reads/writes), and force-layout positions are unaffected by chain re-ordering.
- [ ] R-3: Sidebar unchanged — session list, search filter, delete, and auto-select behave as
      before.
- [ ] R-4: Detail panel — clicking a node still opens the detail panel with the same content.
- [ ] R-5: Node selection — click-to-select (not drag) still works; `selectNodesOnDrag={false}`
      preserved (Spec #440 fix).
- [ ] R-6: Subagent rendering — SubagentNodes still created from ECE-composited and OTLP
      `is_subagent`/`agent.type=subagent` deliveries; chat-chain edges remain dashed indigo.
- [ ] R-7: Compaction — compacted status styling and per-node token behavior on compacted
      sessions are unchanged.
- [ ] R-8: Persistence — persist/restore watermark logic (TTL-shrink-safe) still restores the
      graph without duplicates.
- [ ] R-9: Performance — large-run incremental builder stays O(N): no per-node full-graph
      recompute caused by the chain flip.
- [ ] R-10: Zero console errors (`tauri_read_logs`) across a full live session.
