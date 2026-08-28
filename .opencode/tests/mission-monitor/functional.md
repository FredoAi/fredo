# Mission Monitor — Functional Tests

Feature domain: `mission-monitor` (recursive subagent delegation tree — Spec #2762).
Verification policy: **live** — every case below is executed against a running system; UI observations MUST be corroborated by `telemetry_spans` receipts (`.opencode/skills/telemetry-query/telemetry-query.ps1`).

## Environment (every case)

- Env up: `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 2762` (serving worktree + serving.json). If the serving-entry guard blocks with STALE, re-run `Up -Spec` — never test against a stale serving.
- MCP driver preflight (G-067): probe `window.__MCP__.resolveRef` before ref-based tools; if absent → `driver_session stop/start` once. Tooling failures are never product FAILs.
- Fixtures generated per G-060; agent sessions driven via Run CLI (PTY).
- Mission Monitor subscribes to `otlp_grpc` only.
- Fixture rule: relationship emission happens ONLY for real `task`-tool dispatches — internal tool-execution sessions (`build`, `plan`) are NOT user subagents (Spec #509 cycle 2).

## Cases

- [ ] QA-1 (AC1 — tool attribution, subagent): Run FIX-L3. Open Mission Monitor. The tools invoked by the level-1 subagent appear attached to the subagent's node (edge/containment to that node), NOT to the root chat node. Edge: when parent and subagent invoke the SAME tool name (e.g. both `read`), each occurrence renders under its own invoker — no cross-attribution, no merged node.
- [ ] QA-2 (AC1 — tool attribution, parent): In FIX-L3, the parent chat's own tool calls still attach to the root chat node — not swallowed into the subagent subtree. Edge: tool invoked before vs after the `task` dispatch both stay on the correct owner chronologically.
- [ ] QA-3 (AC2 — nested delegation): In FIX-L3, the graph renders chat → subagent → sub-subagent as a readable 3-level hierarchy (DOM snapshot shows all 3 node levels; screenshot legible). Edge: two sub-subagents under the same parent render as distinct, labeled, non-overlapping siblings.
- [ ] QA-4 (AC3 — deep recursion): Run FIX-L4 (4–5 levels). The full chain renders without crash or freeze: console clean (`tauri_read_logs` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`), UI stays interactive (pan/zoom/select a leaf node). Edge: zoom-out must show the whole chain without the layout collapsing levels onto one another.
- [ ] QA-5 (AC4 — flat parity): Run FIX-FLAT. Rendering is identical to the pre-change baseline: root chat node + its tool nodes, one level, zero subagent containers, zero extra nodes. Compare against the baseline capture (see regression.md R-1).
- [ ] QA-6 (AC5 — orphaned events): Run FIX-ORPHAN. Events arrive whose parent relationship points to a node that never materializes. The app does not crash, does not freeze, and the rest of the graph is uncorrupted: existing node set and parent-child structure exactly match the non-orphan expectation. Edge: orphan events arriving mid-stream while the user is interacting with the graph.
- [ ] QA-7 (AC5 — internal sessions): Run FIX-INTERNAL (tool executions that spawn internal `build`/`plan` sub-sessions, no user `task` dispatch). Zero SubagentNodes are created. Edge: a run mixing internal sessions AND a real `task` dispatch — only the `task` child renders as a subagent.
- [ ] QA-8 (NFR — responsiveness): On FIX-L4 and FIX-WIDE (6–8 sibling subagents), the graph is fully rendered and interactive within 5s of the run completing; no frozen frame > 2s during streaming. One-level rendering performance shows no regression vs baseline.

## Receipts (per case)

After each scenario, query `telemetry_spans` via `telemetry-query.ps1` and confirm: the span set per level (one agent span per nesting level, tool spans per invocation) exists and its parent-child attributes match the UI graph 1:1. The span-derived ground truth is the authority for node count and ownership.

### Round 1 rerun note (2026-08-27)

The environment rerun reached `.serve/2762 @ 2b67b24b` and passed G-067 (`mcp:true,ref:true`), but the required D2 injector was absent and the L3 Run CLI fixture did not complete. QA-1–QA-8 are therefore not promoted to functional passes; see the Tester verdict draft for the exact `telemetry_spans` receipts and blocker command.
