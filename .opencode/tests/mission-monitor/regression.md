# Mission Monitor — Regression Tests

Baseline: the existing one-level Mission Monitor view must not change (Spec #2762 non-goals). Links: no prior feature suites overlap this surface yet (`mission-monitor` folder is new as of #2762).

- [ ] R-1: Flat-session node set unchanged — a no-nesting run renders exactly the pre-change graph: root chat + tool nodes, one level, no empty subagent containers. Capture a baseline screenshot from a current-`main` build BEFORE testing the spec branch (separate `dev-env.ps1 -Action Up` run without `-Spec`), and compare.
- [ ] R-2: Nodes are created ONLY on `init` lifecycle deliveries — update deliveries modify existing node metadata and never create nodes (Spec #523 cycle 3). Observe: replaying/duplicating an `update` delivery does not duplicate nodes.
- [ ] R-3: Click-to-select works without dragging (`selectNodesOnDrag={false}`, Bug #440) — a plain click on any node selects it; drag pans the canvas.
- [ ] R-4: No re-render loop — `tauri_read_logs(source="console")` shows no `Maximum update depth exceeded` during a full run streaming into the panel (Bug #523 cycle 1).
- [ ] R-5: Internal tool-execution sessions (`build`, `plan`) never render as SubagentNodes (Spec #509 cycle 2) — no spurious nodes per tool call.
- [ ] R-6: Late relationship metadata still re-keys — when a `task` event arrives AFTER the child `session.created`, the child sidebar entry is cleaned up AND the SubagentNode is created (end + `init` re-key deliveries, Bug #523 cycles 1/3).
- [ ] R-7: Subagent node metadata display unchanged — token counts and agent name still render from the `otlp_grpc` delivery payloads.
- [ ] R-8: Theme compliance — all node/edge colors come from theme vars; toggling light/dark restyles the graph with no hardcoded colors visible (screenshot both modes).
