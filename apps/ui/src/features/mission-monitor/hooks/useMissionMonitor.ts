import { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import { useNodesState, useEdgesState } from 'reactflow';
import type { Node, Edge, NodeChange } from 'reactflow';
import type { ContractDelivery } from '../../../shared/classes/EventSubscription';
import {
  extractDeliveryPayload,
  deliverySessionId,
  deliveryCorrelationId,
  normalizeTokenCount,
  normalizeCost,
  type GraphNodeStatus,
  type GraphNodeType,
  type GraphEdgeType,
  type AgentNodePayload,
  type SubagentNodePayload,
  type ToolCallSummary,
  type ToolsNodePayload,
} from '../lib/graph';
import { graphStatusToMonitorStatus, GRAPH_NODE_TYPE_MAP } from '../types';
import type { MonitorNodeData, MonitorNodeStatus } from '../types';
import {
  computeForceLayout,
  computeChatChainPositions,
  computeToolsChainPositions,
  computeSubagentChainPositions,
  resolveRectOverlaps,
  createLiveForceSimulation,
  VIEWPORT_BOUNDS,
  type LayoutMode,
  type LiveForceSimulation,
  type LayoutEdge,
  type ChainAgent,
  type ChainToolsNode,
  type ChainSubagentNode,
  type RectNode,
} from '../lib/layout';

// ── Edge style definitions ────────────────────────────────────────────────────
//
// #2754 ST-3 (AC5, token-first): the pre-#2754 hardcoded hex strokes
// (#6366f1/#a855f7/#334155/#f97316) are migrated to EXISTING theme tokens —
// accent/border families — so the theming feature can restyle every edge by
// changing only its token definitions (no theming-system change needed). The
// solid-vs-dashed + line-width grammar is preserved as the non-color identity
// cue (color-blind safe — plan UI-UX §1/§4):
//   parent  → accent-primary  (solid)   — parent/child causal edge
//   calls   → accent-subagent (solid)   — subagent dispatch (animated)
//   reads   → border-color    (dashed)  — legacy file reads
//   writes  → border-color    (dashed)  — legacy file writes
//   chat    → accent-primary  (dashed)  — chat chain (same hue as parent,
//                                          dashed per #2688)
//   tools   → accent-secondary (dashed) — ToolsNode summary link (#2739)
const EDGE_STYLES: Record<GraphEdgeType, React.CSSProperties> = {
  parent:  { stroke: 'var(--accent-primary)', strokeWidth: 1.5 },
  calls:   { stroke: 'var(--accent-subagent)', strokeWidth: 1.5 },
  reads:   { stroke: 'var(--border-color)', strokeDasharray: '2,4', strokeWidth: 1 },
  writes:  { stroke: 'var(--border-color)', strokeDasharray: '2,4', strokeWidth: 1 },
  // #2688: dashed accent — visually distinct from 'parent' (solid accent) and
  // 'calls' (solid subagent) so the per-session chat chain reads as one thread.
  chat:    { stroke: 'var(--accent-primary)', strokeDasharray: '4,4', strokeWidth: 1.5 },
  // #2739: dashed secondary accent — the ToolsNode summary link (chat node →
  // its tools). Dashed signals "summary/reference" vs. the solid causal edges
  // (API contract 4).
  tools:   { stroke: 'var(--accent-secondary)', strokeDasharray: '2,4', strokeWidth: 1.5 },
};

// ── #2745 ST-4: subagent dispatch data path ──────────────────────────────────
//
// A parent's `task` tool call represents a whole delegated session, not an
// ordinary tool invocation — the SubagentNode IS its representation (AC-3, never
// double-rendered as a tool accordion item). ST-1 (Phase-0 live diagnostic,
// .opencode/tmp/2745/e2e/payload-path.md) pinned the args shape:
// - Name key = `subagent_type` (e.g. "explore") — NOT `agent`.
// - Instruction key = `prompt` — NOT `description`/`task`/`instruction`.
// - Args ride in payload['input'] (the adapter-projected
//   gen_ai.tool.call.arguments JSON string); payload['output'] =
//   gen_ai.tool.call.result = the child's final output.

/** #2745 R-4 (AC-4): internal opencode tool-execution agents. Their `task`
 *  dispatches are spawned internally to execute tool calls in sub-sessions and
 *  are NOT user-requested @-subagent dispatches — they create NO SubagentNode
 *  AND no ToolsNode item. `build` is live-confirmed (ST-1 Phase-0); `plan` is
 *  plan-specified (unconfirmed until a run triggers it). Keyed on the SAME
 *  parsed name field the node displays (`subagent_type`). */
export const INTERNAL_TOOL_EXECUTION_AGENTS = ['build', 'plan'];

/** Parse the task tool's arguments JSON (payload['input'] = the adapter-
 *  projected gen_ai.tool.call.arguments string). A parse failure or absent
 *  input degrades to `{}` — the caller renders its documented absent-state
 *  (name falls back to 'Subagent', instruction to ''). */
function parseTaskArgs(input: string): Record<string, any> {
  if (!input) return {};
  try {
    const parsed = JSON.parse(input) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, any>) : {};
  } catch {
    return {};
  }
}

/**
 * #2754 ST-2: Accessibility — honor prefers-reduced-motion in the hybrid Force
 * branch: the live sim snaps to its settled positions synchronously
 * (`snapToSettled`, ST-1 — no rAF glide) when the user has requested reduced
 * motion (AC4 exception). Module-level helper mirroring the panel's camera
 * snap (MissionMonitorPanel.tsx:85-93) — the panel's own `prefersReducedMotion`
 * is private and a hook→panel import would cycle (the panel imports the hook).
 */
function prefersReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * #2750 AC4 (ST-5): a "transitional turn" — a chat-node entry that reached
 * completion (complete/compacted) with an EMPTY agentReply. These are the
 * parent session's own dispatch turns (the LLM turn ended on tool-calls): they
 * carry thinking text but no real response, so the graph must NOT emit a chat
 * node for them — the following reply turn (same user message) is the visible
 * node. In-progress/active text-less turns are NOT transitional: they render
 * with the loading indicator (AC4-3). NFR-5: suppression is EMISSION-only —
 * the entry stays in agentNodes/nodeOrder so a later reply can surface it.
 */
function isTransitionalTurn(entry: {
  status: GraphNodeStatus;
  payload: { agentReply?: string };
}): boolean {
  // AC4 ST-5: a "transitional turn" reached completion with an EMPTY agentReply
  // — the LLM turn ended on tool-calls, so the graph must NOT emit a chat node
  // for it. `agentReply` is treated as empty when it is absent OR whitespace-
  // only: opencode's dispatch turn emits a whitespace-only assistant message
  // (`"\n\n"`) before the tool call, which the OTLP adapter injects verbatim —
  // a real response is never pure whitespace, so trimming is safe (a text-less
  // turn is by definition not a visible reply).
  return (
    (entry.status === 'complete' || entry.status === 'compacted') &&
    !entry.payload.agentReply?.trim()
  );
}

/**
 * Order a session's chat-node correlationIds CHRONOLOGICALLY by span
 * `startTime` (missing → +Infinity, so unresolved nodes sort last). The chat
 * chain + anchors MUST be driven by this order, never by `agentOrder` (delivery
 * arrival order): the panel merges live deliveries (TTL-shrunk to the NEWEST
 * tail) with restored deliveries appended AFTER them, so arrival order can place
 * a newer chat node before an older one — the chain renders newest-at-top
 * (reported bug). `agentOrder` stays the canonical builder insertion order for
 * node-order bookkeeping; this sorted view is used only where chronology
 * matters (chain positions, chain predecessors, subagent/tools anchor chain).
 */
function chronologicalAgentOrder(
  agentOrder: string[],
  agentNodes: Map<string, { payload: AgentNodePayload; status: GraphNodeStatus }>,
): string[] {
  return [...agentOrder].sort((a, b) => {
    const sa = Date.parse(agentNodes.get(a)?.payload.startTime ?? '');
    const sb = Date.parse(agentNodes.get(b)?.payload.startTime ?? '');
    const ta = Number.isFinite(sa) ? sa : Number.POSITIVE_INFINITY;
    const tb = Number.isFinite(sb) ? sb : Number.POSITIVE_INFINITY;
    return ta - tb;
  });
}

/**
 * #2750 AC4 (ST-5): visible-anchor resolution — ONE O(N) pass over
 * `agentOrder` with Set/Map lookups (NFR-2). For every VISIBLE (selected-
 * session) chat node:
 * - `chainPredecessor[corrId]` = the nearest PRECEDING non-transitional
 *   visible agent ('' when none) — the chat-chain edge source for the node.
 * - `visibleNonTransitional` = the emitted (non-suppressed) agent corrIds.
 * Non-transitional entries are themselves the anchor their children
 * (SubagentNode/ToolsNode edges + companion-column layout) attach to;
 * transitional entries' children attach to the same chain predecessor.
 *
 * #2750 round-6 (AC4-2): a suppressed transitional turn that is the session's
 * FIRST chat node has NO PRECEDING visible agent (chainPredecessor is '') —
 * e.g. the very common "Use a subagent to …" first message (round-5 fail
 * session `ses_fed7699aaffejpWUiOZM4y2eai`: dispatch turn `_2` is first). Its
 * children must STILL render exactly one SubagentNode per dispatch (NFR-5:
 * suppression is chat-node emission only, never the SubagentNode). The second
 * backward pass re-anchors such anchorless transitional turns to the NEXT
 * visible non-transitional node of the session (the reply turn that completes
 * the exchange), so the SubagentNode/ToolsNode emission gate sees a rendered
 * anchor. Still ONE O(N) pass (backward) with Set lookups — NFR-2.
 */
function buildVisibleAnchors(
  agentOrder: string[],
  agentNodes: Map<string, { payload: AgentNodePayload; status: GraphNodeStatus }>,
  visibleAgentCorrs: Set<string>,
): { chainPredecessor: Map<string, string>; visibleNonTransitional: Set<string> } {
  const chainPredecessor = new Map<string, string>();
  const visibleNonTransitional = new Set<string>();
  let lastVisible: string | null = null;
  for (const corrId of agentOrder) {
    if (!visibleAgentCorrs.has(corrId)) continue;
    const entry = agentNodes.get(corrId);
    if (!entry) continue;
    chainPredecessor.set(corrId, lastVisible ?? '');
    if (isTransitionalTurn(entry)) continue;
    visibleNonTransitional.add(corrId);
    lastVisible = corrId;
  }

  // Backward pass: transitional (suppressed dispatch) turns re-anchor to the
  // NEXT visible non-transitional node of the session — the reply turn that
  // completes the exchange. `nextVisible` tracks the nearest FOLLOWING emitted
  // agent while walking backward; only non-transitional (visible) agents update
  // it. Non-selected-session corrIds are skipped (the visibleAgentCorrs guard)
  // — `nextVisible` always refers to the selected session.
  //
  // The SAME-EXCHANGE rule (the user-facing fix for the misplaced ToolsNode /
  // SubagentNode): the adapter copies the user message into BOTH the
  // dispatch-turn span and its reply-turn span, so a transitional turn whose
  // following visible node carries the SAME userMessage IS that dispatch's
  // reply — its children MUST anchor to it (the visible node of the exchange),
  // never to an unrelated preceding chat node. This generalizes the round-6
  // anchorless rule: an anchorless turn has no preceding visible node at all,
  // and a turn WITH a preceding visible node still re-anchors to its own reply
  // when the reply follows (the round-5 "nearest-preceding" behavior only
  // survives when no same-exchange reply exists ahead).
  let nextVisible: string | null = null;
  for (let i = agentOrder.length - 1; i >= 0; i--) {
    const corrId = agentOrder[i];
    if (!visibleAgentCorrs.has(corrId)) continue;
    const entry = agentNodes.get(corrId);
    if (!entry) continue;
    if (isTransitionalTurn(entry)) {
      // The following visible node is this dispatch's reply turn when it
      // shares the same (non-empty) userMessage — re-anchor to it.
      const nextEntry = nextVisible ? agentNodes.get(nextVisible) : undefined;
      const sameExchangeReply = !!(
        nextEntry &&
        nextEntry.payload.userMessage &&
        entry.payload.userMessage &&
        nextEntry.payload.userMessage === entry.payload.userMessage
      );
      if (sameExchangeReply) {
        chainPredecessor.set(corrId, nextVisible!);
      } else if (!chainPredecessor.get(corrId) && nextVisible) {
        // Round-6 anchorless case: no preceding visible node — re-anchor to
        // the next visible node regardless.
        chainPredecessor.set(corrId, nextVisible);
      }
      continue;
    }
    nextVisible = corrId;
  }

  return { chainPredecessor, visibleNonTransitional };
}

/**
 * #2750 AC4 (ST-5): the visible node a parent's children (SubagentNode /
 * ToolsNode / layout + companion columns) attach to — the parent itself when it
 * is a non-transitional visible chat node, else its chain predecessor. ''
 * means "no anchor" (the parent is a suppressed transitional turn with no
 * preceding visible node — the child is not emitted).
 */
function resolveChildAnchor(
  parentCorrId: string,
  chainPredecessor: Map<string, string>,
  visibleNonTransitional: Set<string>,
): string {
  if (visibleNonTransitional.has(parentCorrId)) return parentCorrId;
  return chainPredecessor.get(parentCorrId) ?? '';
}

/**
 * UX (flash fix): companion-node (SubagentNode/ToolsNode) emission + anchor
 * resolution. A live tool delivery often arrives BEFORE its dispatch turn
 * (the tool span ends before the dispatch chat span closes) and before the
 * dispatch's same-exchange reply — so on early batches the time-window parent
 * resolution and the anchor resolution are both PROVISIONAL, and the node would
 * appear attached to an EARLIER unrelated chat node (the "first Chatnode"), then
 * JUMP to the reply when it renders. The node is emitted only when its anchor is
 * FINAL:
 *  - the parent is a visible non-transitional chat node (anchor = the parent), OR
 *  - the anchor is the parent's SAME-EXCHANGE reply (both carry the same
 *    non-empty userMessage — the reply turn that completes the suppressed
 *    dispatch turn).
 * It is PROVISIONAL (node HELD) when the parent is a suppressed transitional
 * turn and the anchor is merely a preceding visible node (the reply has not
 * arrived yet) — the node would re-anchor when the reply renders.
 * `allowAnchorlessBelt` is true ONLY for the SubagentNode path: when there is NO
 * visible anchor at all (anchorless — every turn so far suppressed) but the
 * parent chat node exists in the selected session, the dispatch is still emitted
 * so a user-requested subagent is never dropped (round-6 NFR-5 belt-and-
 * suspenders); with no visible node there is nothing for it to flash against.
 */
function resolveCompanionEmission(
  parentCorrId: string,
  allowAnchorlessBelt: boolean,
  chainPredecessor: Map<string, string>,
  visibleNonTransitional: Set<string>,
  agentNodes: Map<string, { payload: AgentNodePayload; status: GraphNodeStatus }>,
): { emit: boolean; anchorCorrId: string } {
  const anchorCorrId = resolveChildAnchor(parentCorrId, chainPredecessor, visibleNonTransitional);
  // Parent is a visible non-transitional chat node → anchor = the parent (final).
  if (visibleNonTransitional.has(parentCorrId)) return { emit: true, anchorCorrId };
  if (anchorCorrId) {
    // Parent is transitional/suppressed → the anchor is final ONLY when it is
    // the parent's own same-exchange reply (both share a non-empty userMessage).
    const parentEntry = agentNodes.get(parentCorrId);
    const anchorEntry = agentNodes.get(anchorCorrId);
    const isSameExchangeReply = !!(
      parentEntry && anchorEntry &&
      parentEntry.payload.userMessage &&
      anchorEntry.payload.userMessage &&
      anchorEntry.payload.userMessage === parentEntry.payload.userMessage
    );
    return { emit: isSameExchangeReply, anchorCorrId };
  }
  // Anchorless: no visible anchor at all → round-6 belt-and-suspenders (subagent
  // only). Tools never emit anchorless.
  return { emit: allowAnchorlessBelt, anchorCorrId };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeAgentNodePayload(d: ContractDelivery): AgentNodePayload {
  const raw = extractDeliveryPayload(d);
  const p = raw as Record<string, any>;

  // Read adapter-injected fields directly — no extraction helpers needed.
  // Adapter normalization (Phase 1 #551) injects these fields at the top
  // level of the delivery payload. ECE content merging (Phase 2 #555)
  // preserves them across init/update/end lifecycle phases.
  const userMessage = (p.userMessage as string) ?? '';
  const agentReply = (p.agentReply as string) ?? '';
  const agentThinking = (p.agentThinking as string) ?? '';
  // Spec #2717 (Sub-task 2): canonical token families. The OTLP adapter
  // injects reasoningTokens / cacheReadTokens / cacheWriteTokens alongside
  // promptTokens / completionTokens (mirroring otlp.rs:1028-1033). Each field
  // defaults to 0 when absent; normalizeTokenCount guards NaN/negative (R-3.3).
  const promptTokens = normalizeTokenCount(p.promptTokens);
  const completionTokens = normalizeTokenCount(p.completionTokens);
  const reasoningTokens = normalizeTokenCount(p.reasoningTokens);
  const cacheReadTokens = normalizeTokenCount(p.cacheReadTokens);
  const cacheWriteTokens = normalizeTokenCount(p.cacheWriteTokens);
  const agent = p.agent as string | undefined;
  const model = p.model as string | undefined;
  // Spec #2723 (R-6 / AC6): the OTLP adapter injects the span's real
  // start/end times as RFC3339 UTC strings (from startTimeUnixNano /
  // endTimeUnixNano). The node payload carries them so the DetailPanel
  // renders telemetry-derived times. The keys are added ONLY when present
  // so a spread of this payload never clobbers a node's existing times with
  // `undefined` (update deliveries without timing must keep the init value).
  const startTime = p.startTime as string | undefined;
  const endTime = p.endTime as string | undefined;

  // #2743 ST-1 (AC-12): the exchange's estimated cost from the LLM span's
  // `cost_usd` flat attr. Carried ONLY when the delivery actually carries a
  // valid non-negative figure (a spread of this payload must never clobber a
  // node's existing cost with `undefined`; absent stays absent so consumers can
  // distinguish "no cost" from a delivered "$0.00"). normalizeCost guards
  // NaN/negative.
  const costUsd = typeof p.cost_usd === 'number' ? normalizeCost(p.cost_usd) : undefined;

  const payload: AgentNodePayload = {
    agent,
    model,
    userMessage,
    agentThinking,
    agentReply,
    promptTokens,
    completionTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
    // R-3.1: Total = Input + Cache + Reasoning + Output exactly. cacheWrite
    // is carried in the payload but NEVER summed (Architect binding G-023).
    totalTokens: promptTokens + cacheReadTokens + reasoningTokens + completionTokens,
    correlationId: deliveryCorrelationId(d),
    sessionId: deliverySessionId(d),
  };
  if (startTime !== undefined) payload.startTime = startTime;
  if (endTime !== undefined) payload.endTime = endTime;
  if (costUsd !== undefined) payload.costUsd = costUsd;
  return payload;
}

/**
 * #2707 R-4: chat node title = `<agent> · <model>`.
 * agent-only → agent; model-only → model; neither → "Chat".
 */
function makeAgentNodeLabel(p: AgentNodePayload): string {
  const parts = [p.agent, p.model].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : 'Chat';
}

/**
 * Build a MonitorNodeData from a graph-builder payload.
 */
function makeMonitorNodeData(
  id: string,
  nodeType: GraphNodeType,
  status: GraphNodeStatus,
  payload: any,
  timestamp: string,
  label: string,
): MonitorNodeData {
  return {
    eventType: nodeType,
    status: graphStatusToMonitorStatus(status),
    payload: payload as Record<string, any>,
    timestamp,
    label,
    threadId: 'main',
    relatedEvents: [],
  };
}

function makeReactFlowNode(
  id: string,
  nodeType: GraphNodeType,
  status: GraphNodeStatus,
  payload: any,
  timestamp: string,
  label: string,
): Node<MonitorNodeData> {
  return {
    id,
    type: GRAPH_NODE_TYPE_MAP[nodeType],
    position: { x: 0, y: 0 },
    data: makeMonitorNodeData(id, nodeType, status, payload, timestamp, label),
  };
}

function makeReactFlowEdge(
  id: string,
  source: string,
  target: string,
  edgeType: GraphEdgeType,
): Edge {
  return {
    id,
    source,
    target,
    type: 'smoothstep',
    animated: edgeType === 'calls',
    hidden: false,
    style: EDGE_STYLES[edgeType],
  };
}

/**
 * #2739 R-6 / D-5: the ToolsNode summary edge — from the chat node's new
 * additive right-side source handle (`source-right`) to the ToolsNode's left
 * target handle (`target-left`). The handles are set EXPLICITLY so existing
 * chat-chain edges keep the bottom handle (ReactFlow default = first source
 * handle in DOM order — NFR-6).
 */
function makeToolsReactFlowEdge(id: string, source: string, target: string): Edge {
  return {
    id,
    source,
    target,
    type: 'smoothstep',
    animated: false,
    hidden: false,
    sourceHandle: 'source-right',
    targetHandle: 'target-left',
    style: EDGE_STYLES.tools,
  };
}

/**
 * #2745 ST-4 (R-1): the SubagentNode edge — from the parent chat node's
 * additive LEFT-side source handle (`source-left`) to the SubagentNode's
 * right target handle (`target-right`): subagents render in their own column
 * LEFT of the chat chain, so the edge enters from the node's right. Reuses
 * the existing `'calls'` edge type + EDGE_STYLES.calls (Architect API
 * contract — no new GraphEdgeType variant). The subagent node is a leaf
 * (terminal — no source handles).
 */
function makeSubagentReactFlowEdge(id: string, source: string, target: string): Edge {
  return {
    id,
    source,
    target,
    type: 'smoothstep',
    animated: false,
    hidden: false,
    sourceHandle: 'source-left',
    targetHandle: 'target-right',
    style: EDGE_STYLES.calls,
  };
}

/**
 * Build the MERGED ToolsNode set for the canvas — ONE ToolsNode per VISIBLE
 * chat node (the resolved anchor), aggregating the tool calls of every dispatch
 * turn that anchors to it. A user exchange makes MULTIPLE tool-calling LLM turns
 * before its reply (each is a separate suppressed/transitional chat node), so
 * `state.toolsNodes` holds one per-parent entry — without this merge the canvas
 * would render N stacked ToolsNodes beside the single visible reply (reported
 * bug: "the first chat node has 2 ToolsNodes instead of one").
 *
 * Each per-parent entry participates only when its emission gate passes (its
 * anchor is FINAL — the dispatch turn's same-exchange reply has rendered); the
 * parent's tool calls are folded into the anchor's merged list. Returns a Map
 * anchorCorrId → { toolCalls, status, timestamp, sessionId }.
 */
function buildMergedToolsNodes(
  state: GraphBuilderState,
  chainPredecessor: Map<string, string>,
  visibleNonTransitional: Set<string>,
): Map<string, { toolCalls: ToolCallSummary[]; status: GraphNodeStatus; timestamp: string; sessionId: string }> {
  const merged = new Map<string, { toolCalls: ToolCallSummary[]; status: GraphNodeStatus; timestamp: string; sessionId: string }>();
  for (const [parentCorrId, entry] of state.toolsNodes) {
    const { emit, anchorCorrId } = resolveCompanionEmission(
      parentCorrId, false, chainPredecessor, visibleNonTransitional, state.agentNodes,
    );
    if (!emit || !anchorCorrId) continue;
    const existing = merged.get(anchorCorrId);
    if (existing) {
      existing.toolCalls.push(...entry.payload.toolCalls);
      if (entry.timestamp > existing.timestamp) existing.timestamp = entry.timestamp;
    } else {
      merged.set(anchorCorrId, {
        toolCalls: [...entry.payload.toolCalls],
        status: entry.status,
        timestamp: entry.timestamp,
        sessionId: entry.payload.sessionId,
      });
    }
  }
  // Deterministic per-anchor call order: sort each merged list by startTime.
  for (const m of merged.values()) {
    m.toolCalls.sort((a, b) => (Date.parse(a.startTime ?? '') || 0) - (Date.parse(b.startTime ?? '') || 0));
  }
  return merged;
}

/**
 * Build a referentially-stable merged ToolsNodePayload for the given anchor.
 * The payload reference is reused until its content changes (the incremental
 * builder's Pass-2 deep compare keys on the payload reference — a fresh object
 * every batch would re-render the node every batch, Spec #275/#523).
 */
function mergedToolsPayload(
  anchorCorrId: string,
  toolCalls: ToolCallSummary[],
  sessionId: string,
  cache: Map<string, { signature: string; payload: ToolsNodePayload }>,
): ToolsNodePayload {
  const signature = `${anchorCorrId}|${toolCalls.map((c) => c.correlationId).join(',')}`;
  const cached = cache.get(anchorCorrId);
  if (cached && cached.signature === signature) return cached.payload;
  const payload: ToolsNodePayload = {
    toolCalls,
    parentCorrelationId: anchorCorrId,
    correlationId: `tools-${anchorCorrId}`,
    sessionId,
  };
  cache.set(anchorCorrId, { signature, payload });
  return payload;
}

/**
 * #2739 NFR-3: apply the deterministic right-side ToolsNode chain slots (ST-3
 * `computeToolsChainPositions` — x = TOOLS_CHAIN_X, y = parent chat node y) on
 * top of a positions map. Tools nodes are chain-owned — their chain slots are
 * authoritative and they are never touched by the d3-force residue pass.
 * Called from BOTH the structural recompute and the height-only reflow so a
 * chain reflow re-aligns each ToolsNode with its parent's new y.
 */
function applyToolsChainPositions(
  positions: Map<string, { x: number; y: number }>,
  state: GraphBuilderState,
  chainPositions: Map<string, { x: number; y: number }>,
  visibleNonTransitional: Set<string>,
  chainPredecessor: Map<string, string>,
): void {
  // ONE slot per RESOLVED ANCHOR (a suppressed transitional dispatch turn
  // renders no node, so the merged ToolsNode sits beside the anchor's chain
  // slot — multiple dispatch turns of one exchange share that anchor, so they
  // must NOT create stacked slots).
  const toolsChain: ChainToolsNode[] = [];
  const placedAnchors = new Set<string>();
  for (const [parentCorrId] of state.toolsNodes) {
    const anchorCorrId = resolveChildAnchor(parentCorrId, chainPredecessor, visibleNonTransitional);
    if (anchorCorrId && !placedAnchors.has(anchorCorrId)) {
      placedAnchors.add(anchorCorrId);
      toolsChain.push({ id: `tools-${anchorCorrId}`, parentId: `agent-${anchorCorrId}` });
    }
  }
  const toolsPositions = computeToolsChainPositions(toolsChain, chainPositions);
  for (const [nodeId, pos] of toolsPositions) {
    positions.set(nodeId, pos);
  }
}

/**
 * #2745 ST-4 (A-5): apply the deterministic SubagentNode companion-column chain
 * slots (ST-4 `computeSubagentChainPositions` — x = SUBAGENT_CHAIN_X − index ×
 * (SUBAGENT_NODE_MAX_WIDTH + SUBAGENT_GAP), y = parent chat node y) on top of
 * a positions map. Subagent nodes are chain-owned — their chain slots are
 * authoritative and they are never touched by the d3-force residue pass.
 * Called from BOTH the structural recompute and the height-only reflow (right
 * after applyToolsChainPositions) so a chain reflow re-aligns each subagent
 * column with its parent's new y. A parent's subagents are indexed by dispatch
 * startTime (deterministic; the payload startTime with the entry timestamp as
 * fallback).
 */
function applySubagentChainPositions(
  positions: Map<string, { x: number; y: number }>,
  state: GraphBuilderState,
  chainPositions: Map<string, { x: number; y: number }>,
  visibleNonTransitional: Set<string>,
  chainPredecessor: Map<string, string>,
): void {
  // Group subagent entries by their RESOLVED anchor chat node (#2750 AC4: the
  // anchor is the parent itself when it renders, else the nearest preceding
  // visible chat node — a suppressed transitional dispatch turn renders no
  // node but its subagents still stack in the companion column under the
  // anchor, never at (0,0)).
  const byParent = new Map<string, string[]>();
  for (const [corrId, entry] of state.subagentNodes) {
    const anchorCorrId = resolveChildAnchor(
      entry.payload.parentCorrelationId,
      chainPredecessor,
      visibleNonTransitional,
    );
    if (anchorCorrId) {
      const list = byParent.get(anchorCorrId) ?? [];
      list.push(corrId);
      byParent.set(anchorCorrId, list);
    }
  }
  const subagentChain: ChainSubagentNode[] = [];
  for (const [parentCorrId, corrIds] of byParent) {
    // Dispatch-ordered (by startTime) so the k-th dispatch stacks below the
    // previous one — arrival-order-independent like the tools association.
    corrIds.sort((a, b) => {
      const ea = state.subagentNodes.get(a)!;
      const eb = state.subagentNodes.get(b)!;
      return (
        (Date.parse(ea.payload.startTime ?? ea.timestamp) || 0) -
        (Date.parse(eb.payload.startTime ?? eb.timestamp) || 0)
      );
    });
    corrIds.forEach((corrId, index) => {
      subagentChain.push({ id: `subagent-${corrId}`, parentId: `agent-${parentCorrId}`, index });
    });
  }
  const subagentPositions = computeSubagentChainPositions(subagentChain, chainPositions);
  for (const [nodeId, pos] of subagentPositions) {
    positions.set(nodeId, pos);
  }
}

// ── Graph builder state (internal, per-session) ──────────────────────────────

/** A ToolsNode entry in the graph-builder state — keyed by the PARENT chat
 *  node's correlationId (one ToolsNode per chat node, lazily created on the
 *  first resolved NON-task tool call — #2739 R-5, #2745 A-4 gate). */
interface ToolsNodeEntry {
  payload: ToolsNodePayload;
  status: GraphNodeStatus;
  timestamp: string;
  /** Deterministic payload signature — changed-content detection for the
   *  incremental builder (an unchanged signature keeps the same payload
   *  reference, so the node is never re-emitted/re-rendered — Spec #275/#523
   *  no-loop pattern). */
  signature: string;
}

/** A SubagentNode entry in the graph-builder state — keyed by the task
 *  dispatch's correlationId (one SubagentNode per user-requested subagent
 *  dispatch — #2745 R-1). Built by associateToolCalls from the collected task
 *  call; gated by the AC-4 internal-agent exclusion. */
interface SubagentNodeEntry {
  payload: SubagentNodePayload;
  status: GraphNodeStatus;
  timestamp: string;
  /** Deterministic payload signature — same no-loop contract as ToolsNode. */
  signature: string;
}

interface GraphBuilderState {
  agentNodes: Map<string, { payload: AgentNodePayload; status: GraphNodeStatus; timestamp: string; prevCorrId?: string }>;
  /** #2739 ST-1: per-session tool-call summaries (tool correlationId → summary),
   *  collected from tool-use-lifecycle deliveries. The association pass resolves
   *  parents from these collected maps in the effect's Phase 3 — never by
   *  delivery arrival order (order-independence — restored SQLite and live
   *  deliveries interleave). */
  toolCallsBySession: Map<string, Map<string, ToolCallSummary>>;
  /** #2739 ST-1: ToolsNode entries keyed by the PARENT chat node correlationId
   *  (one ToolsNode per chat node, lazily created on the first resolved
   *  NON-task call — #2745 A-4). */
  toolsNodes: Map<string, ToolsNodeEntry>;
  /** #2745 ST-4: SubagentNode entries keyed by the task dispatch correlationId
   *  (one SubagentNode per user-requested subagent dispatch). */
  subagentNodes: Map<string, SubagentNodeEntry>;
  nodeOrder: string[];
  agentOrder: string[];
  /** #2688 ST4: per-session previous chat-node correlationId (vertical chain link). */
  lastAgentBySession: Map<string, string>;
}

function createInitialGraphBuilderState(): GraphBuilderState {
  return {
    agentNodes: new Map(),
    toolCallsBySession: new Map(),
    toolsNodes: new Map(),
    subagentNodes: new Map(),
    nodeOrder: [],
    agentOrder: [],
    lastAgentBySession: new Map(),
  };
}

// ── #2739 ST-1: tool-use-lifecycle data path ─────────────────────────────────
//
// Tool `tool_use` spans already flow end-to-end (plugin → OTLP adapter → ECE);
// the re-registered `tool-use-lifecycle` contract (MissionMonitorFeature) makes
// them visible to the graph builder. Deliveries are COLLECTED into per-session
// tool-call maps here (order-independent); the association pass
// (associateToolCalls) then resolves each call to its parent chat node by the
// time-window rule (D-2) in the processing effect — never by arrival order.

/**
 * Collect a tool-use-lifecycle delivery into the per-session tool-call map.
 *
 * Any lifecycle can create or finalize a summary (restored SQLite and live
 * deliveries interleave, so an init may be missing when an end arrives):
 * - toolName: `payload['gen_ai.tool.name'] ?? payload['tool_name'] ?? 'unknown'`
 *   (plan API contract 2).
 * - startTime/endTime: payload-injected span times; startTime falls back to the
 *   delivery timestamp when the span never carried one (the association pass
 *   uses these to pick the parent chat node).
 * - input/output: last non-empty value wins (the end delivery carries the
 *   completed output).
 * - per-call tokens: zero-guarded (NFR-1 / D-1); last-wins when a delivery
 *   carries a non-zero figure, absent (0) keeps the existing value — the same
 *   per-node per-turn invariant as chat nodes (#2700 ST3).
 */
function upsertToolCallSummary(state: GraphBuilderState, delivery: ContractDelivery): void {
  const sessionId = deliverySessionId(delivery);
  const corrId = deliveryCorrelationId(delivery);
  const p = extractDeliveryPayload(delivery) as Record<string, any>;

  let sessionCalls = state.toolCallsBySession.get(sessionId);
  if (!sessionCalls) {
    sessionCalls = new Map();
    state.toolCallsBySession.set(sessionId, sessionCalls);
  }
  const existing = sessionCalls.get(corrId);

  const rawToolName =
    typeof p['gen_ai.tool.name'] === 'string' && p['gen_ai.tool.name']
      ? p['gen_ai.tool.name']
      : typeof p['tool_name'] === 'string' && p['tool_name']
        ? p['tool_name']
        : undefined;
  const toolName = rawToolName ?? existing?.toolName ?? 'unknown';

  const startTime =
    typeof p['startTime'] === 'string' && p['startTime']
      ? p['startTime']
      : (existing?.startTime ?? delivery.timestamp);
  const endTime =
    typeof p['endTime'] === 'string' && p['endTime']
      ? p['endTime']
      : existing?.endTime;

  const input = typeof p['input'] === 'string' ? p['input'] : (existing?.input ?? '');
  const output = typeof p['output'] === 'string' ? p['output'] : (existing?.output ?? '');

  const inputTokens = normalizeTokenCount(p['promptTokens']);
  const reasoningTokens = normalizeTokenCount(p['reasoningTokens']);
  const outputTokens = normalizeTokenCount(p['completionTokens']);

  // #2743 ST-1 (AC-9/AC-10): per-tool outcome + duration from the tool span's
  // flat attrs. `tool.success` / `tool.error` are LITERAL-dot payload keys —
  // read from the whole `payload` (they can never be declared as ECE
  // streamFields: the dot would mis-split into a 3-level path and strip).
  // Last-wins: a later delivery carrying a value overrides; absent keeps the
  // existing value; restored/legacy deliveries with neither degrade to neutral.
  const success =
    typeof p['tool.success'] === 'boolean'
      ? p['tool.success']
      : existing?.success;
  const error =
    typeof p['tool.error'] === 'string'
      ? p['tool.error']
      : existing?.error;
  const durationMs =
    typeof p['duration_ms'] === 'number' && Number.isFinite(p['duration_ms']) && p['duration_ms'] >= 0
      ? p['duration_ms']
      : existing?.durationMs;

  // #2745 ST-4 (R-2): child-completion fields from the task delivery's
  // canonical payload keys (ST-3 adapter projection of the plugin's fredo-native
  // flat child_* attrs). Optional + last-wins like input/output — absent until
  // the child completes (and until ST-3 lands); a later delivery carrying them
  // overrides. Numbers are normalizeTokenCount/normalizeCost-guarded (absent
  // stays absent — a delivered 0 stays 0).
  const childSessionId =
    typeof p['childSessionId'] === 'string' && p['childSessionId']
      ? p['childSessionId']
      : (existing?.childSessionId);
  const childAgent =
    typeof p['childAgent'] === 'string' && p['childAgent']
      ? p['childAgent']
      : (existing?.childAgent);
  const childTokens =
    typeof p['childTokens'] === 'number'
      ? normalizeTokenCount(p['childTokens'])
      : (existing?.childTokens);
  const childCost =
    typeof p['childCost'] === 'number'
      ? normalizeCost(p['childCost'])
      : (existing?.childCost);
  const childMessages =
    typeof p['childMessages'] === 'number'
      ? normalizeTokenCount(p['childMessages'])
      : (existing?.childMessages);
  // Per-family token breakdown (child_input_/child_cache_read_/child_reasoning_/
  // child_output_tokens → childInputTokens/… camelCase projection). Absent-stays-
  // absent so the node can distinguish "not yet complete" from a delivered 0.
  const childInputTokens =
    typeof p['childInputTokens'] === 'number'
      ? normalizeTokenCount(p['childInputTokens'])
      : (existing?.childInputTokens);
  const childCacheReadTokens =
    typeof p['childCacheReadTokens'] === 'number'
      ? normalizeTokenCount(p['childCacheReadTokens'])
      : (existing?.childCacheReadTokens);
  const childReasoningTokens =
    typeof p['childReasoningTokens'] === 'number'
      ? normalizeTokenCount(p['childReasoningTokens'])
      : (existing?.childReasoningTokens);
  const childOutputTokens =
    typeof p['childOutputTokens'] === 'number'
      ? normalizeTokenCount(p['childOutputTokens'])
      : (existing?.childOutputTokens);

  const merged: ToolCallSummary = {
    toolName,
    input,
    output,
    inputTokens: inputTokens > 0 ? inputTokens : (existing?.inputTokens ?? 0),
    reasoningTokens: reasoningTokens > 0 ? reasoningTokens : (existing?.reasoningTokens ?? 0),
    outputTokens: outputTokens > 0 ? outputTokens : (existing?.outputTokens ?? 0),
    totalTokens: 0,
    correlationId: corrId,
    startTime,
    endTime,
  };
  // Total = Input + Reasoning + Output exactly (cache excluded — session-scoped).
  merged.totalTokens = merged.inputTokens + merged.reasoningTokens + merged.outputTokens;
  // Additive outcome fields — only set when present so restored/legacy
  // deliveries stay neutral (no phantom success/error/duration).
  if (success !== undefined) merged.success = success;
  if (error !== undefined) merged.error = error;
  if (durationMs !== undefined) merged.durationMs = durationMs;
  // Additive child-completion fields — only set when present (absent stays
  // absent so the SubagentNode can distinguish "not yet complete" from a
  // delivered figure).
  if (childSessionId !== undefined) merged.childSessionId = childSessionId;
  if (childAgent !== undefined) merged.childAgent = childAgent;
  if (childTokens !== undefined) merged.childTokens = childTokens;
  if (childCost !== undefined) merged.childCost = childCost;
  if (childMessages !== undefined) merged.childMessages = childMessages;
  if (childInputTokens !== undefined) merged.childInputTokens = childInputTokens;
  if (childCacheReadTokens !== undefined) merged.childCacheReadTokens = childCacheReadTokens;
  if (childReasoningTokens !== undefined) merged.childReasoningTokens = childReasoningTokens;
  if (childOutputTokens !== undefined) merged.childOutputTokens = childOutputTokens;

  sessionCalls.set(corrId, merged);
}

/**
 * #2739 D-2: time-window parent resolution — the chat node of the same session
 * with the GREATEST `startTime` strictly < the tool call's `startTime`.
 * Order-independent by construction: it scans the collected chat-node map, never
 * delivery arrival order. NEVER uses correlationId (the per-span counter
 * interleaves chat/tool ids) and NEVER span parentage (live-verified: all tool
 * spans' parent is the session span).
 *
 * UX (flash fix): span-containment guard — a candidate parent must be a
 * chat node that was still OPEN when the tool call began (endTime missing = turn
 * still open = still a valid candidate; a turn that COMPLETED before the tool
 * started cannot have made the call). A live tool delivery often arrives BEFORE
 * its dispatch turn (the tool span ends before the dispatch chat span closes),
 * so without this guard the call tentatively resolves to an EARLIER unrelated
 * completed turn — the SubagentNode/ToolsNode flashes attached to it, then jumps
 * when the true dispatch turn and its same-exchange reply render. The guard
 * checks the call's START (not end): a subagent `task` tool can legitimately run
 * past its dispatch turn's end, but the dispatch turn is always still open when
 * the tool fires.
 */
function resolveParentChatNode(
  call: ToolCallSummary,
  sessionAgents: Map<string, { payload: AgentNodePayload; status: GraphNodeStatus }>,
): string | null {
  const callStart = Date.parse(call.startTime ?? '');
  if (!Number.isFinite(callStart)) return null;
  let bestCorrId: string | null = null;
  let bestStart = -Infinity;
  for (const [corrId, entry] of sessionAgents) {
    const parentStart = entry.payload.startTime ? Date.parse(entry.payload.startTime) : NaN;
    if (!Number.isFinite(parentStart)) continue;
    if (parentStart >= callStart) continue; // must start strictly before the call
    const parentEnd = entry.payload.endTime ? Date.parse(entry.payload.endTime) : NaN;
    if (Number.isFinite(parentEnd) && parentEnd <= callStart) continue; // completed before the call began
    if (parentStart > bestStart) {
      bestStart = parentStart;
      bestCorrId = corrId;
    }
  }
  return bestCorrId;
}

/** Deterministic payload signature for changed-content detection. The
 *  ToolsNode/SubagentNode payloads are primitive-only, so JSON.stringify is a
 *  stable hash (used for both node families — #2745 ST-4). */
function toolsPayloadSignature(payload: ToolsNodePayload | SubagentNodePayload): string {
  return JSON.stringify(payload);
}

/**
 * #2745 ST-4 (R-1): build the rich SubagentNode payload from a resolved `task`
 * tool call. Name/instruction come from the task-args JSON (ST-1-pinned keys
 * `subagent_type` / `prompt`, with fallback chains per A-2); output is the
 * child's final output (payload['output'] = gen_ai.tool.call.result); the
 * AC-2 child-completion fields are copied through when present (absent stays
 * absent — the node renders its documented working state until they land).
 */
function makeSubagentNodePayload(
  taskCall: ToolCallSummary,
  parentCorrId: string,
  sessionId: string,
): SubagentNodePayload {
  const parsed = parseTaskArgs(taskCall.input);
  const payload: SubagentNodePayload = {
    name: parsed.subagent_type ?? parsed.agent ?? 'Subagent',
    instruction: parsed.prompt ?? parsed.description ?? parsed.task ?? parsed.instruction ?? '',
    output: taskCall.output,
    parentCorrelationId: parentCorrId,
    correlationId: taskCall.correlationId,
    sessionId,
  };
  if (taskCall.durationMs !== undefined) payload.durationMs = taskCall.durationMs;
  if (taskCall.startTime !== undefined) payload.startTime = taskCall.startTime;
  if (taskCall.endTime !== undefined) payload.endTime = taskCall.endTime;
  if (taskCall.childSessionId !== undefined) payload.childSessionId = taskCall.childSessionId;
  if (taskCall.childAgent !== undefined) payload.childAgent = taskCall.childAgent;
  if (taskCall.childTokens !== undefined) payload.childTokens = taskCall.childTokens;
  if (taskCall.childCost !== undefined) payload.childCost = taskCall.childCost;
  if (taskCall.childMessages !== undefined) payload.childMessages = taskCall.childMessages;
  if (taskCall.childInputTokens !== undefined) payload.childInputTokens = taskCall.childInputTokens;
  if (taskCall.childCacheReadTokens !== undefined) payload.childCacheReadTokens = taskCall.childCacheReadTokens;
  if (taskCall.childReasoningTokens !== undefined) payload.childReasoningTokens = taskCall.childReasoningTokens;
  if (taskCall.childOutputTokens !== undefined) payload.childOutputTokens = taskCall.childOutputTokens;
  return payload;
}

/**
 * #2739 ST-1 / #2745 ST-4: associate collected tool calls with their chat nodes.
 *
 * Runs over the collected per-session tool-call maps AFTER every processing
 * batch (never during per-delivery processing), so association is
 * ORDER-INDEPENDENT — restored SQLite and live deliveries interleave, and a tool
 * call that arrives before its chat node's init is resolved the moment both are
 * present. Splits `task` dispatches out of the ToolsNode list: a user-requested
 * subagent dispatch (parsed name NOT in INTERNAL_TOOL_EXECUTION_AGENTS) lazily
 * creates one `subagent:<corrId>` SubagentNode per dispatch (R-1); every other
 * call lazily creates one `tools-<parentCorrId>` ToolsNode per chat node on the
 * FIRST resolved NON-task call (R-5 + A-4 gate — no node for no-tool exchanges,
 * and a task-only exchange renders the SubagentNode with NO empty ToolsNode).
 * Internal-agent dispatches create NO entry on either path (AC-4). Idempotent:
 * unchanged entries are left untouched (same payload reference), so the
 * incremental builder never re-emits/re-renders them (Spec #275/#523 no-loop
 * pattern).
 *
 * @returns The set of `tools:<parentCorrId>` entry ids created or changed this
 *   pass (the incremental builder emits those into the affected set).
 */
function associateToolCalls(state: GraphBuilderState): Set<string> {
  const touched = new Set<string>();

  for (const [sessionId, calls] of state.toolCallsBySession) {
    if (calls.size === 0) continue;

    // This session's chat nodes (corrId → entry) — the parent candidates.
    const sessionAgents = new Map<string, { payload: AgentNodePayload; status: GraphNodeStatus }>();
    for (const [corrId, entry] of state.agentNodes) {
      if (entry.payload.sessionId === sessionId) sessionAgents.set(corrId, entry);
    }
    if (sessionAgents.size === 0) continue;

    // Resolve each call to its parent chat node (time-window rule) and group.
    const callsByParent = new Map<string, ToolCallSummary[]>();
    for (const call of calls.values()) {
      const parentCorrId = resolveParentChatNode(call, sessionAgents);
      if (!parentCorrId) continue; // no eligible parent — no ToolsNode (R-5)
      const list = callsByParent.get(parentCorrId);
      if (list) list.push(call);
      else callsByParent.set(parentCorrId, [call]);
    }
    if (callsByParent.size === 0) continue;

    // Reconcile stale ToolsNode entries (re-parenting). A tool delivery often
    // arrives BEFORE its parent chat node — the dispatch turn that made the
    // call — because the tool span ENDS before the dispatch chat span (the
    // LLM turn ends on tool-calls, then the tool executes, then the turn
    // closes). On the first association pass the call therefore resolves to an
    // EARLIER chat node (greatest startTime < call start); when the true
    // dispatch turn later arrives, the SAME call re-resolves to it and a
    // SECOND ToolsNode is created — the old parent's entry is never removed,
    // so the graph shows duplicate ToolsNodes for one call. Drop any ToolsNode
    // entry of this session whose parent no longer resolves any call in the
    // current pass.
    //
    // The stale nodeOrder entry is deliberately LEFT in place (never spliced):
    // `newEntryIds` in the processing effect is `nodeOrder.slice(
    // prevNodeOrderLength)` — an index-based slice of the entries appended
    // since this batch. Splicing the array here (removing an entry BELOW that
    // boundary) shifts every later index left by one, so the slice would start
    // one element too far and silently drop the newest node created this batch
    // (live updates stalled: new chat nodes persisted but never rendered). The
    // stale node is instead retired by the emission gates — Phase 3 requires
    // `state.toolsNodes.has(corrId)` (absent → not emitted) and Phase 5 Pass 1
    // drops preserved `tools-` nodes whose entry vanished from `toolsNodes`.
    // The orphan nodeOrder id is inert (it never emits and never renders).
    for (const [parentCorrId, entry] of state.toolsNodes) {
      if (entry.payload.sessionId !== sessionId) continue;
      if (callsByParent.has(parentCorrId)) continue;
      state.toolsNodes.delete(parentCorrId);
    }

    for (const [parentCorrId, callsOfParent] of callsByParent) {
      const parentEntry = sessionAgents.get(parentCorrId)!;
      // Arrival-ordered by startTime (one accordion item per call).
      callsOfParent.sort(
        (a, b) => (Date.parse(a.startTime ?? '') || 0) - (Date.parse(b.startTime ?? '') || 0),
      );

      // #2745 ST-4 (R-3 / A-4): split `task` dispatches out of the ToolsNode
      // list. A `task` call represents a whole delegated session — it is
      // represented SOLELY by its SubagentNode (AC-3), never as a tool
      // accordion item, and never double-rendered.
      const taskCalls = callsOfParent.filter((c) => c.toolName === 'task');
      const nonTaskCalls = callsOfParent.filter((c) => c.toolName !== 'task');

      // ── SubagentNode path (R-1 / AC-1, gated by R-4 / AC-4) ──
      for (const taskCall of taskCalls) {
        const parsed = parseTaskArgs(taskCall.input);
        const name = parsed.subagent_type ?? parsed.agent ?? 'Subagent';
        // AC-4: internal opencode tool-execution agents (build/plan) create NO
        // SubagentNode AND no ToolsNode item — their dispatches are not
        // user-requested subagents.
        if (INTERNAL_TOOL_EXECUTION_AGENTS.includes(name)) continue;

        const payload = makeSubagentNodePayload(taskCall, parentCorrId, sessionId);
        const entryId = `subagent:${taskCall.correlationId}`;
        const signature = toolsPayloadSignature(payload);
        const existing = state.subagentNodes.get(taskCall.correlationId);
        if (!existing) {
          state.subagentNodes.set(taskCall.correlationId, {
            payload,
            status: parentEntry.status,
            timestamp: taskCall.endTime ?? taskCall.startTime ?? '',
            signature,
          });
          if (!state.nodeOrder.includes(entryId)) state.nodeOrder.push(entryId);
          touched.add(entryId);
        } else if (signature !== existing.signature || existing.status !== parentEntry.status) {
          existing.payload = payload;
          existing.status = parentEntry.status;
          existing.signature = signature;
          touched.add(entryId);
        }
      }

      // ── ToolsNode path (A-4 gate): created only when ≥1 NON-task call
      // remains — a task-only exchange renders the SubagentNode and NO
      // "Tools · 0 calls" artifact.
      if (nonTaskCalls.length === 0) continue;

      const payload: ToolsNodePayload = {
        toolCalls: nonTaskCalls,
        parentCorrelationId: parentCorrId,
        correlationId: `tools-${parentCorrId}`,
        sessionId,
      };
      const entryId = `tools:${parentCorrId}`;
      const signature = toolsPayloadSignature(payload);
      const existing = state.toolsNodes.get(parentCorrId);
      if (!existing) {
        state.toolsNodes.set(parentCorrId, {
          payload,
          status: parentEntry.status,
          timestamp:
            nonTaskCalls[nonTaskCalls.length - 1].endTime ?? nonTaskCalls[0].startTime ?? '',
          signature,
        });
        if (!state.nodeOrder.includes(entryId)) state.nodeOrder.push(entryId);
        touched.add(entryId);
      } else if (signature !== existing.signature || existing.status !== parentEntry.status) {
        existing.payload = payload;
        existing.status = parentEntry.status;
        existing.signature = signature;
        touched.add(entryId);
      }
    }
  }

  return touched;
}

/**
 * Process a single ContractDelivery through the graph builder.
 * Routes deliveries by contractName to the appropriate handler:
 * - chat-node → AgentNode lifecycle
 * - tool-use-lifecycle → tool-call summary collection (upsertToolCallSummary;
 *   the ToolsNode node/edge build happens in the effect's Phase 3 association)
 */
function processDelivery(
  state: GraphBuilderState,
  delivery: ContractDelivery,
): GraphBuilderState {
  const correlationId = deliveryCorrelationId(delivery);
  const sessionId = deliverySessionId(delivery);
  const lifecycle = delivery.lifecycle;

  // Clone state
  const next: GraphBuilderState = {
    agentNodes: new Map(state.agentNodes),
    // Outer map is shallow-cloned (inner per-session maps are shared — same
    // copy-on-write pattern as the agentNodes/toolsNodes entry objects below).
    toolCallsBySession: new Map(state.toolCallsBySession),
    toolsNodes: new Map(state.toolsNodes),
    subagentNodes: new Map(state.subagentNodes),
    nodeOrder: [...state.nodeOrder],
    agentOrder: [...state.agentOrder],
    lastAgentBySession: new Map(state.lastAgentBySession),
  };

  const contractName = delivery.contractName;

  // #2739 ST-1: tool-use-lifecycle — collect the per-session tool-call summary
  // (the ToolsNode data path; association happens in the effect's Phase 3 over
  // the collected maps, so this is arrival-order-independent). The chat-node
  // branches below are FROZEN (#593/#586/#2700/#2717/#2723).
  if (contractName === 'tool-use-lifecycle') {
    upsertToolCallSummary(next, delivery);
    return next;
  }

  // #593: non-chat nodes deactivated. Scope: chat-node only.
  if (contractName !== 'chat-node') {
    return next;
  }

  if (contractName === 'chat-node') {
    if (lifecycle === 'init') {
      // #2723 AC5 (Spec #523 reversal): the chat-node contract declares
      // excludePayload rules (is_subagent / agent.type) so subagent events are
      // filtered at the engine level and NEVER reach this builder. No subagent
      // detection or SubagentNode path exists here (Contract-Trust Cleanup).

      // Don't recreate if already exists.
      if (next.agentNodes.has(correlationId)) return next;

      const payload = makeAgentNodePayload(delivery);

      // #2688 ST4: Track the previous chat node of this session so a
      // prev→next vertical chain edge can be built. AgentOrder records
      // arrival order; lastAgentBySession maps session → latest chat corrId.
      const prevCorrId = state.lastAgentBySession.get(sessionId) ?? '';
      next.lastAgentBySession.set(sessionId, correlationId);

      next.agentNodes.set(correlationId, {
        payload,
        status: 'in-progress',
        timestamp: delivery.timestamp,
        prevCorrId,
      });

      if (!next.agentOrder.includes(correlationId)) {
        next.agentOrder.push(correlationId);
      }
      if (!next.nodeOrder.includes(`agent:${correlationId}`)) {
        next.nodeOrder.push(`agent:${correlationId}`);
      }
    } else if (lifecycle === 'update') {
      const existing = next.agentNodes.get(correlationId);
      if (existing) {
        // If the node is already 'complete', only merge token/content
        // data — do NOT regress the status back to 'active' or overwrite
        // content fields with potentially incorrect values from
        // post-completion events.
        // AC-5 (Spec #478): When node is already 'complete', do NOT overwrite
        // the accumulated agentReply. Use concatenation logic to preserve text
        // from prior lifecycle updates. The status 'complete' may be hit when
        // the processing useEffect re-runs (due to mapping changes) and
        // re-processes deliveries that were already handled — overwriting would
        // lose the accumulated text.
        if (existing.status === 'complete') {
          const rawP = extractDeliveryPayload(delivery);
          const rawPAny = rawP as Record<string, any>;
          const promptTokens = normalizeTokenCount(rawPAny.promptTokens);
          const completionTokens = normalizeTokenCount(rawPAny.completionTokens);
          const reasoningTokens = normalizeTokenCount(rawPAny.reasoningTokens);
          const cacheReadTokens = normalizeTokenCount(rawPAny.cacheReadTokens);
          const cacheWriteTokens = normalizeTokenCount(rawPAny.cacheWriteTokens);
          // REQ-8 (#2700 ST3): per-node per-turn token invariant — the value
          // carried by THIS delivery wins (last-wins), never a Math.max merge
          // (a sticky max would propagate a session-cumulative total into the
          // node's count). totalTokens is recomputed as
          // prompt + cacheRead + reasoning + completion (Spec #2717 R-3.1);
          // cacheWrite is carried but never summed.
          if (promptTokens > 0 || completionTokens > 0 || reasoningTokens > 0 || cacheReadTokens > 0) {
            existing.payload.promptTokens = promptTokens;
            existing.payload.completionTokens = completionTokens;
            existing.payload.reasoningTokens = reasoningTokens;
            existing.payload.cacheReadTokens = cacheReadTokens;
            existing.payload.cacheWriteTokens = cacheWriteTokens;
            existing.payload.totalTokens = promptTokens + cacheReadTokens + reasoningTokens + completionTokens;
          }
          // AC-5: Append new agentReply to existing, never overwrite.
          // Use the same concatenation-with-dedup logic as the non-complete branch.
          const newPayload = makeAgentNodePayload(delivery);
          if (newPayload.agentReply && newPayload.agentReply !== existing.payload.userMessage) {
            if (existing.payload.agentReply) {
              if (!existing.payload.agentReply.includes(newPayload.agentReply)) {
                // Normalize whitespace for comparison before appending
                const normalizedExisting = existing.payload.agentReply.replace(/\s+/g, ' ');
                const normalizedNew = newPayload.agentReply.replace(/\s+/g, ' ');
                if (!normalizedExisting.includes(normalizedNew) && !normalizedNew.includes(normalizedExisting.slice(-normalizedNew.length))) {
                  existing.payload.agentReply += newPayload.agentReply;
                }
              }
            } else {
              existing.payload.agentReply = newPayload.agentReply;
            }
          }
          if (newPayload.agentThinking) {
            existing.payload.agentThinking = newPayload.agentThinking || existing.payload.agentThinking;
          }
          // Spec #382: If init had empty userMessage (from session.created),
          // allow update to populate it (from chat.message output.message.parts[0].text)
          if (!existing.payload.userMessage && newPayload.userMessage) {
            existing.payload.userMessage = newPayload.userMessage;
          }
          return next;
        }

        const newPayload = makeAgentNodePayload(delivery);
        // REQ-8: Merge update payload with existing — preserve fields not present in update
        // IMPORTANT: userMessage is set ONCE on init and must NEVER be overwritten.
        // Subsequent deliveries (session.next.text.*, message.*) carry agent response
        // text in payload.properties.text, which would be handled by the userMessage
        // preservation logic below. Always preserve the init value.
        //
        // Spec #382: Concatenate agentReply across multiple update deliveries.
        // Each message.part.updated event carries one text chunk in the ECE delivery's
        // payload. The ECE overwrites accumulated_payload per event, so each update
        // delivery only carries the latest chunk. Using || would replace the previous
        // chunk. Concatenation accumulates the full response text.
        const concatenatedAgentReply = newPayload.agentReply
          ? (existing.payload.agentReply
              ? existing.payload.agentReply + newPayload.agentReply
              : newPayload.agentReply)
          : existing.payload.agentReply;
        const mergedPayload: AgentNodePayload = {
          ...existing.payload,
          ...newPayload,
          // Preserve userMessage from init UNLESS init was empty and new is non-empty.
          // session.created (init) has no prompt text — the real prompt arrives in
          // chat.message (update/end). Always use the non-empty value.
          userMessage: newPayload.userMessage || existing.payload.userMessage,
          agentThinking: newPayload.agentThinking || existing.payload.agentThinking,
          agentReply: concatenatedAgentReply,
          // REQ-8 (#2700 ST3): per-node per-turn token invariant — last-wins,
          // never Math.max (a sticky max could propagate a session-cumulative
          // total into the node's count). A delivery that carries no token
          // figure (0/0) keeps the node's own per-turn value; totalTokens is
          // recomputed as prompt + cacheRead + reasoning + completion
          // (Spec #2717 R-3.1), never maxed. cacheWrite is carried but never
          // summed.
          promptTokens: newPayload.promptTokens || existing.payload.promptTokens,
          completionTokens: newPayload.completionTokens || existing.payload.completionTokens,
          reasoningTokens: newPayload.reasoningTokens || existing.payload.reasoningTokens,
          cacheReadTokens: newPayload.cacheReadTokens || existing.payload.cacheReadTokens,
          cacheWriteTokens: newPayload.cacheWriteTokens || existing.payload.cacheWriteTokens,
          totalTokens:
            (newPayload.promptTokens || existing.payload.promptTokens) +
            (newPayload.cacheReadTokens || existing.payload.cacheReadTokens) +
            (newPayload.reasoningTokens || existing.payload.reasoningTokens) +
            (newPayload.completionTokens || existing.payload.completionTokens),
        };
        // REQ-8: Detect compacted flag from delivery payload
        const updateInner = extractDeliveryPayload(delivery) as Record<string, any>;
        const isCompacted = updateInner?.compacted === true;
        // ST12 (#2688 round-9 AC2): same class of fix as the end re-set — the
        // update re-set REPLACES the agentNodes entry and must preserve
        // prevCorrId so a chain edge can still be built for a node whose update
        // arrives before the graph-builder phase (streaming/Hook paths).
        next.agentNodes.set(correlationId, {
          payload: mergedPayload,
          status: isCompacted ? 'compacted' as GraphNodeStatus : 'active' as GraphNodeStatus,
          timestamp: delivery.timestamp,
          prevCorrId: existing.prevCorrId,
        });
      }

      // #2739 ST-1: tool-use-lifecycle deliveries are handled earlier (summary
      // collection) — the chat-node branches above are untouched (frozen).
    } else if (lifecycle === 'end') {
      const existing = next.agentNodes.get(correlationId);
      if (existing) {
        // AC-5 (Spec #478): When node is already 'complete', do NOT overwrite
        // the accumulated agentReply. This branch is hit when the processing
        // useEffect re-runs (due to mapping changes) and re-processes deliveries
        // that were already handled — overwriting would lose accumulated text.
        if (existing.status === 'complete') {
          const rawP = extractDeliveryPayload(delivery);
          const rawPAny = rawP as Record<string, any>;
          const promptTokens = normalizeTokenCount(rawPAny.promptTokens);
          const completionTokens = normalizeTokenCount(rawPAny.completionTokens);
          const reasoningTokens = normalizeTokenCount(rawPAny.reasoningTokens);
          const cacheReadTokens = normalizeTokenCount(rawPAny.cacheReadTokens);
          const cacheWriteTokens = normalizeTokenCount(rawPAny.cacheWriteTokens);
          // REQ-8 (#2700 ST3): per-node per-turn token invariant — the value
          // carried by THIS delivery wins (last-wins), never a Math.max merge
          // (a sticky max would propagate a session-cumulative total into the
          // node's count). totalTokens is recomputed as
          // prompt + cacheRead + reasoning + completion (Spec #2717 R-3.1);
          // cacheWrite is carried but never summed.
          if (promptTokens > 0 || completionTokens > 0 || reasoningTokens > 0 || cacheReadTokens > 0) {
            existing.payload.promptTokens = promptTokens;
            existing.payload.completionTokens = completionTokens;
            existing.payload.reasoningTokens = reasoningTokens;
            existing.payload.cacheReadTokens = cacheReadTokens;
            existing.payload.cacheWriteTokens = cacheWriteTokens;
            existing.payload.totalTokens = promptTokens + cacheReadTokens + reasoningTokens + completionTokens;
          }
          // AC-5: Append new agentReply to existing, never overwrite.
          const newPayload = makeAgentNodePayload(delivery);
          if (newPayload.agentReply && newPayload.agentReply !== existing.payload.userMessage) {
            if (existing.payload.agentReply) {
              if (!existing.payload.agentReply.includes(newPayload.agentReply)) {
                const normalizedExisting = existing.payload.agentReply.replace(/\s+/g, ' ');
                const normalizedNew = newPayload.agentReply.replace(/\s+/g, ' ');
                if (!normalizedExisting.includes(normalizedNew) && !normalizedNew.includes(normalizedExisting.slice(-normalizedNew.length))) {
                  existing.payload.agentReply += newPayload.agentReply;
                }
              }
            } else {
              existing.payload.agentReply = newPayload.agentReply;
            }
          }
          // REQ-8: If the delivery marks this node as compacted, upgrade
          // the status even though the node is already 'complete'.
          const completeRawP = rawP as Record<string, any>;
          if (completeRawP?.compacted === true) {
            existing.status = 'compacted' as GraphNodeStatus;
          }
          return next;
        }

        const finalStatus: GraphNodeStatus = 'complete';
        const newPayload = makeAgentNodePayload(delivery);
        // Spec #2723 (R-6 / AC6): prefer the span-derived endTime injected by
        // the OTLP adapter (RFC3339 from endTimeUnixNano) so the DetailPanel
        // End row matches telemetry; fall back to the end-delivery timestamp
        // only when the span never carried an end (streaming span).
        newPayload.endTime = newPayload.endTime ?? delivery.timestamp;
        // REQ-8: Merge end delivery with existing — preserve fields not present
        // IMPORTANT: userMessage is set ONCE on init and must NEVER be overwritten.
        //
        // The adapter-injected agentReply from the end delivery always wins over
        // the existing value. The concatenation logic below ensures progressive
        // text is preserved while allowing the final delivery to set the complete
        // response.
        const mergedPayload: AgentNodePayload = {
          ...existing.payload,
          ...newPayload,
          // Preserve userMessage from init UNLESS init was empty.
          // session.created (init) has no prompt text — the real prompt arrives
          // in chat.message (end delivery). Use the non-empty value.
          userMessage: newPayload.userMessage || existing.payload.userMessage,
          agentThinking: newPayload.agentThinking || existing.payload.agentThinking,
          // REQ-4 (Spec #478): Concatenate end delivery's agentReply with existing,
          // preserving all text across the full lifecycle. Dedup: if existing already
          // contains the new text, skip concatenation to avoid duplicates.
          agentReply: newPayload.agentReply
            ? (existing.payload.agentReply
                ? (existing.payload.agentReply.includes(newPayload.agentReply)
                    ? existing.payload.agentReply
                    : existing.payload.agentReply + newPayload.agentReply)
                : newPayload.agentReply)
            : existing.payload.agentReply,
          promptTokens: newPayload.promptTokens || existing.payload.promptTokens,
          completionTokens: newPayload.completionTokens || existing.payload.completionTokens,
          reasoningTokens: newPayload.reasoningTokens || existing.payload.reasoningTokens,
          cacheReadTokens: newPayload.cacheReadTokens || existing.payload.cacheReadTokens,
          cacheWriteTokens: newPayload.cacheWriteTokens || existing.payload.cacheWriteTokens,
          // Spec #2717 R-3.1: recompute Total from the merged per-field values
          // (prompt + cacheRead + reasoning + completion) with the same last-wins
          // rule as the node's other recompute sites — cacheWrite never summed.
          totalTokens:
            (newPayload.promptTokens || existing.payload.promptTokens) +
            (newPayload.cacheReadTokens || existing.payload.cacheReadTokens) +
            (newPayload.reasoningTokens || existing.payload.reasoningTokens) +
            (newPayload.completionTokens || existing.payload.completionTokens),
        };
        // REQ-8: Detect compacted flag — override finalStatus with 'compacted'
        const endInner = extractDeliveryPayload(delivery) as Record<string, any>;
        const endCompacted = endInner?.compacted === true;
        // ST12 (#2688 round-9 AC2): preserve prevCorrId from the init-created
        // entry. The end re-set REPLACES the agentNodes entry, and dropping
        // prevCorrId here wiped the chain link before buildChatEdge ran (the
        // live Run CLI path delivers init+end in the same batch, so the end
        // re-set always precedes Phase 4) — zero e-chat edges.
        next.agentNodes.set(correlationId, {
          payload: mergedPayload,
          status: endCompacted ? 'compacted' as GraphNodeStatus : finalStatus,
          timestamp: delivery.timestamp,
          prevCorrId: existing.prevCorrId,
        });
      } else {
        // If no existing agent node, mark matching ones as complete
        for (const [key, val] of next.agentNodes) {
          if (key === correlationId) {
            next.agentNodes.set(key, { ...val, status: 'complete' });
          }
        }
      }
    }
  }
  // #2739 ST-1: tool-use-lifecycle deliveries are handled earlier (summary
  // collection) — the chat-node branches above are untouched (frozen).

  return next;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

interface UseDeliveryGraphOptions {
  deliveries: ContractDelivery[];
  sessionId: string | null;
  /** #2752 ST-2: layout mode — 'chain' (default, deterministic chat-chain
   *  geometry, byte-identical to today) or 'force' (live d3-force simulation).
   *  Backward-compatible: omitting it keeps every existing caller byte-identical. */
  layoutMode?: LayoutMode;
  /** #2756 round-3 (AC3): the REAL pane size (canvas px), measured from the
   *  ReactFlow container by the panel and threaded into the Force anchor
   *  layout. The fixed VIEWPORT_BOUNDS (2400×1600) is LARGER than the real
   *  pane, so anchors arranged inside it placed settled clusters outside the
   *  viewport (round-2 AC3 FAIL). When absent/zero the hook falls back to
   *  VIEWPORT_BOUNDS (a safe in-pane region while the pane is unmeasured). */
  viewportBounds?: { width: number; height: number };
}

/**
 * useDeliveryGraph — builds ReactFlow graph from ContractDelivery[].
 *
 * @param deliveries - All deliveries (filtered by sessionId internally)
 * @param sessionId - The selected session ID (null = no selection)
 * @param layoutMode - 'chain' (default) or 'force' (#2752 ST-2)
 * @param viewportBounds - Real pane size in canvas px (#2756 round-3: AC3)
 * @returns nodes, edges, onNodesChange, onEdgesChange
 */
export function useDeliveryGraph({ deliveries, sessionId, layoutMode = 'chain', viewportBounds }: UseDeliveryGraphOptions) {
  const [layoutVersion, setLayoutVersion] = useState(0);
  const builderStateRef = useRef<GraphBuilderState>(createInitialGraphBuilderState());
  const lastSessionRef = useRef<string | null>(null);
  // AC-7: Cache layout positions to prevent jitter on re-render
  const layoutPositionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  // #2752 ST-2: the applied layout mode — lets the layout block detect a pure
  // mode switch (chain↔force), which the incremental early-return gate would
  // otherwise skip (no new deliveries, no height change on a pure toggle).
  const layoutModeRef = useRef<LayoutMode>(layoutMode);
  // #2752 ST-2: the live d3-force simulation controller for Force mode. Owned
  // by the hook so the sim survives the processing effect's re-runs; stopped on
  // settle (builder), session change, force→chain switch, and unmount (no
  // orphan rAF loop — NFR-3/T19).
  const forceSimRef = useRef<LiveForceSimulation | null>(null);
  // #2758 ST-1: Bostock-faithful — no per-exchange anchors (forceCenter only)
  // Track the last computed graph signature to detect structural changes
  const lastGraphRef = useRef<string>('');
  // #2723 ST4 (R-4): last measured ReactFlow node heights (node id → px).
  // ReactFlow reports rendered node dimensions via 'dimensions' changes in
  // onNodesChange; the chat chain stacks by these heights so a node with a
  // full response box can never overlap the node below it (AC4). Unmeasured
  // fresh nodes fall back to DEFAULT_NODE_HEIGHT in layout.ts.
  const measuredHeightsRef = useRef<Map<string, number>>(new Map());
  // Track the last applied chain-height signature (agent id → measured px).
  // A measured-height change flips it, reflowing the chain without a
  // structural change (height-aware layout signature).
  const lastHeightsRef = useRef<string>('');
  // #2756 round-3 (AC3): the last-applied Force anchor bounds (the REAL pane
  // size measured in the canvas container, VIEWPORT_BOUNDS while unmeasured).
  // A pane resize flips it, re-laying-out the Force anchors so settled
  // clusters stay inside the pane. The ref carries a plain width/height pair
  // (never a newly-created object identity) so the change detection is a
  // stable numeric comparison — the Spec #275/#523 no-render-loop pattern.
  const lastPaneBoundsRef = useRef<{ width: number; height: number }>({ width: 0, height: 0 });
  // #2723 ST4: monotonic epoch bumped when an agent node's measured height
  // actually changes — re-runs the processing effect so the chain re-stacks.
  // Never derived from array .length / newly-created object refs (the
  // Spec #275/#523 no-re-render-loop pattern).
  const [heightReflowEpoch, setHeightReflowEpoch] = useState(0);
  // Merged ToolsNode payload cache keyed by anchor corrId. A user exchange can
  // make MULTIPLE tool-calling dispatch turns before its reply (each is a
  // separate suppressed chat node), each producing its own `tools-<parent>`
  // builder entry — but the canvas shows ONE ToolsNode per VISIBLE chat node
  // (the anchor), merging the tool calls of every dispatch turn that anchors to
  // it. The merged payload is rebuilt only when its content signature changes
  // (same reference otherwise) so the incremental builder never re-emits an
  // unchanged ToolsNode (Spec #275/#523 no-loop pattern).
  const mergedToolsPayloadCacheRef = useRef<Map<string, { signature: string; payload: ToolsNodePayload }>>(new Map());
  // ST11: delivery-id watermark of deliveries already fed through the graph
  // builder. A positional cursor (`lastSessionProcessedRef`) is unsafe here:
  // the sessionDeliveries cache can be recomposed (session change / first-run
  // wipe) from a differently-composed array, leaving unseen deliveries at
  // indices below the cursor. The id set makes consumption correct regardless
  // of array composition — each delivery is processed exactly once, so
  // update/end concatenation never duplicates text.
  const graphProcessedIdsRef = useRef<Set<string>>(new Set());
  // Incremental session delivery filtering cache (perf: avoid O(N) re-filter on every delivery)
  const sessionDeliveriesCacheRef = useRef<ContractDelivery[]>([]);
  const sessionDeliveriesFilteredRef = useRef(0);
  // ST11: delivery-id watermark — the StreamContext deliveries array is TTL-shrunk
  // from the front (DELIVERY_TTL_MS=300s, 60s sweep). A bare count cursor goes stale
  // below a shrink and silently strands deliveries appended afterwards. When the
  // shrink is detected the cursor resets and the delta is re-derived by scanning the
  // current array for ids NOT in this set, so the re-scan is idempotent — no delivery
  // is re-processed (update-lifecycle concatenation is NOT idempotent, so re-processing
  // would duplicate agentReply text).
  const sessionDeliveriesProcessedIdsRef = useRef<Set<string>>(new Set());
  // Reset graph state when session changes
  useEffect(() => {
    if (lastSessionRef.current !== sessionId) {
      builderStateRef.current = createInitialGraphBuilderState();
      lastSessionRef.current = sessionId;
      layoutPositionsRef.current = new Map();
      lastGraphRef.current = '';
      measuredHeightsRef.current = new Map();
      lastHeightsRef.current = '';
      graphProcessedIdsRef.current.clear();
      sessionDeliveriesCacheRef.current = [];
      sessionDeliveriesFilteredRef.current = 0;
      sessionDeliveriesProcessedIdsRef.current.clear();
      // #2752 ST-2: a session switch must never carry the previous session's
      // simulation (its nodes/positions belong to the old session) — stop it so
      // no orphan rAF loop outlives the switch (NFR-3/T19).
      forceSimRef.current?.stop();
      setNodes([]);
      setEdges([]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // #2752 ST-2: stop the live force simulation on unmount — the sim owns a
  // requestAnimationFrame loop (via the builder) that must never outlive the
  // panel (NFR-3/T19).
  useEffect(() => {
    return () => {
      forceSimRef.current?.stop();
      forceSimRef.current = null;
    };
  }, []);



  // Process ALL deliveries through the graph builder, not just the selected session.
  // Output filtering in Phase 3/4 then shows only the selected session's
  // AgentNodes.
  //
  // PERF: Incremental processing — only process NEW deliveries on each render
  // instead of re-processing the entire deliveries array (O(N) per render).
  // The deliveries array gets a new reference on every append (from StreamContext),
  // so depending on [deliveries, sessionId] re-runs this useMemo for every single
  // delivery. Using [deliveries.length, sessionId] only re-runs when new deliveries
  // arrive, with cached results in sessionDeliveriesCacheRef.
  const sessionDeliveries = useMemo(() => {
    if (!sessionId) {
      sessionDeliveriesCacheRef.current = [];
      sessionDeliveriesFilteredRef.current = 0;
      sessionDeliveriesProcessedIdsRef.current.clear();
      return [];
    }
    let startIdx = sessionDeliveriesFilteredRef.current;
    // ST11: TTL shrink below the cursor — reset and re-derive the delta by scanning
    // the current array for ids not yet processed. The delivery-id set makes the
    // re-scan idempotent (already-processed deliveries are never re-added to the
    // cache, so update/end concatenation never duplicates text).
    if (deliveries.length < startIdx) {
      startIdx = 0;
      sessionDeliveriesFilteredRef.current = 0;
    }
    if (startIdx >= deliveries.length) return sessionDeliveriesCacheRef.current;

    // Include ALL new deliveries — the selected-session filter happens in Phase 3.
    const newMatches: ContractDelivery[] = [];
    for (let i = startIdx; i < deliveries.length; i++) {
      const d = deliveries[i];
      // ST11: skip duplicate delivery ids (same id re-emitted by the bus or by a
      // post-shrink re-scan) so the graph builder processes each delivery once.
      if (sessionDeliveriesProcessedIdsRef.current.has(d.id)) continue;
      sessionDeliveriesProcessedIdsRef.current.add(d.id);
      newMatches.push(d);
    }
    sessionDeliveriesFilteredRef.current = deliveries.length;

    if (newMatches.length > 0) {
      sessionDeliveriesCacheRef.current = [...sessionDeliveriesCacheRef.current, ...newMatches];
    }
    return sessionDeliveriesCacheRef.current;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deliveries.length, sessionId]);

  // Process deliveries through the graph builder (INCREMENTAL).
  // PERF: Only process new deliveries since last render. Reprocessing all
  // deliveries from scratch on every effect run (O(N²) allocations via Map
  // clones) causes webview freezes with hundreds of deliveries.
  //
  // REQ-5: After processing, only build ReactFlow nodes for new and changed
  // entries rather than the full nodeOrder. REQ-6: Append edges incrementally
  // instead of replacing the full edge array.
  useEffect(() => {
    if (!sessionId || sessionDeliveries.length === 0) return;

    // #2752 ST-2: detect a pure layout-mode switch (chain↔force). A toggle
    // produces no new deliveries and no height change, so the incremental
    // early-return gate below would otherwise swallow it — track the applied
    // mode and force the layout block past the gate on a switch.
    const modeChanged = layoutModeRef.current !== layoutMode;
    layoutModeRef.current = layoutMode;

    // #2756 round-3 (AC3): the Force anchor region comes from the REAL pane
    // size measured in the canvas container (viewportBounds). While the pane
    // is unmeasured/zero it falls back to VIEWPORT_BOUNDS (a safe in-pane
    // region). A pane resize flips paneChanged, forcing the layout block past
    // the gate AND restarting the Force sim seeded from the current positions
    // so settled clusters re-fit the new pane.
    const paneBounds =
      viewportBounds && viewportBounds.width > 0 && viewportBounds.height > 0
        ? viewportBounds
        : VIEWPORT_BOUNDS;
    const paneChanged =
      paneBounds.width !== lastPaneBoundsRef.current.width ||
      paneBounds.height !== lastPaneBoundsRef.current.height;
    lastPaneBoundsRef.current = paneBounds;

    let state = builderStateRef.current;

    // ── Phase 1: Incremental processDelivery with change tracking ──
    // REQ-5: Track which nodeOrder indices were affected by this batch.
    const prevNodeOrderLength = state.nodeOrder.length;
    // Track delivery correlationIds that touch existing nodes
    const touchedCorrIds = new Set<string>();

    // ST11: select this batch by delivery-id watermark instead of a positional
    // cursor. The sessionDeliveries cache is append-only in the normal growing
    // path, but it is recomposed from a differently-composed array on session
    // change / first-run wipe — a stale positional cursor would strand unseen
    // deliveries below it. Scanning the cache for unseen ids is O(N) Set lookups
    // (the layout-signature block below is already O(N) per batch), while
    // processDelivery stays O(delta) — the expensive Map-clone work stays
    // strictly incremental (NFR-1).
    const processedIds = graphProcessedIdsRef.current;
    const unprocessed: ContractDelivery[] = [];
    for (const d of sessionDeliveries) {
      if (processedIds.has(d.id)) continue;
      processedIds.add(d.id);
      unprocessed.push(d);
    }

    // #2723 ST4 (R-4): a measured-height change must reflow the chain even
    // when there are no new deliveries. ReactFlow reports rendered node sizes
    // via 'dimensions' changes (handled in onNodesChange below), which bump
    // heightReflowEpoch and re-run this effect. Compute the chain-height
    // signature from the CURRENT builder state + last measured heights: if it
    // differs from the last-applied one, the early return must NOT skip the
    // layout block (the chain needs to re-stack by measured height).
    const pendingChainAgents: ChainAgent[] = [];
    for (const corrId of chronologicalAgentOrder(
      builderStateRef.current.agentOrder,
      builderStateRef.current.agentNodes,
    )) {
      const entry = builderStateRef.current.agentNodes.get(corrId);
      if (entry) {
        // #2750 AC4: suppressed transitional turns occupy NO chain slot (their
        // node is never emitted) — excluding them keeps the chain contiguous.
        if (isTransitionalTurn(entry)) continue;
        const nodeId = `agent-${corrId}`;
        pendingChainAgents.push({
          id: nodeId,
          sessionId: entry.payload.sessionId,
          height: measuredHeightsRef.current.get(nodeId),
        });
      }
    }
    const pendingHeightSignature = pendingChainAgents
      .map(a => `${a.id}:${a.height ?? ''}`)
      .sort()
      .join(',');

    if (!modeChanged && !paneChanged && unprocessed.length === 0 && pendingHeightSignature === lastHeightsRef.current) return;

    for (const d of unprocessed) {
      const corrId = deliveryCorrelationId(d);
      touchedCorrIds.add(corrId);
      state = processDelivery(state, d);
    }
    builderStateRef.current = state;

    // ── #2739 ST-1 / #2745 ST-4: associate collected tool calls with their
    // chat nodes ──
    // Order-independent Phase-3 pass over the collected maps: creates/updates
    // the `tools:<parentCorrId>` ToolsNode AND `subagent:<corrId>` SubagentNode
    // nodeOrder entries + builder state, so the NEW-entry computation below
    // picks up any newly created companion nodes. The returned ids are
    // re-emitted as CHANGED when the association rebuilt them (new tool call /
    // new subagent dispatch / changed exchange figures / parent status change).
    const touchedEntryIds = associateToolCalls(state);

    // ── Phase 2: Determine which entry IDs are affected ──
    // NEW entries: appended to nodeOrder since last batch
    const newEntryIds = new Set(state.nodeOrder.slice(prevNodeOrderLength));

    // CHANGED entries: existing entries whose correlationId was touched by
    // the current batch's deliveries (status/payload updates).
    const changedEntryIds = new Set<string>();
    for (const entryId of state.nodeOrder) {
      if (newEntryIds.has(entryId)) continue;
      const colonIdx = entryId.indexOf(':');
      if (colonIdx < 0) continue; // raw-id legacy entries — no status delivery targets them
      const prefix = entryId.slice(0, colonIdx);
      const corrId = entryId.slice(colonIdx + 1);
      if (touchedCorrIds.has(corrId)) {
        changedEntryIds.add(entryId);
        continue;
      }
      // #2739 ST-1 / #2745 ST-4: a tools/subagent entry rebuilt by the
      // association pass (new tool call, new subagent dispatch, changed
      // exchange figures) is re-emitted.
      if ((prefix === 'tools' || prefix === 'subagent') && touchedEntryIds.has(entryId)) {
        changedEntryIds.add(entryId);
        continue;
      }
    }

    const affectedEntryIds = new Set([...newEntryIds, ...changedEntryIds]);

    // UX (flash fix): a HELD companion node (SubagentNode/ToolsNode whose
    // anchor is still provisional — its dispatch turn's same-exchange reply has
    // not rendered yet) must be RE-EVALUATED every batch, not just when its own
    // correlationId is touched: its emission depends on the visible-anchor
    // resolution (buildVisibleAnchors), which changes when the REPLY chat node
    // (`_7`) arrives — a chat-node delivery touches the reply's corrId, never
    // the companion's. Always include every companion entry in the affected set
    // so Phase 3 re-runs the final-anchor gate each batch; Phase 5 Pass 2's
    // deep compare keeps already-emitted unchanged nodes from re-rendering.
    for (const entryId of state.nodeOrder) {
      const colonIdx = entryId.indexOf(':');
      if (colonIdx < 0) continue;
      const prefix = entryId.slice(0, colonIdx);
      if (prefix === 'subagent' || prefix === 'tools') affectedEntryIds.add(entryId);
    }

    // ── Session-scoped node filtering ──
    // When processing ALL deliveries, the graph builder creates nodes for
    // every session. The output must be scoped to the selected session: show
    // only the selected session's AgentNodes. Other sessions' AgentNodes are
    // hidden.
    //
    // Build a set of "visible agent correlationIds" — agent nodes whose sessionId
    // matches the selected session.
    const visibleAgentCorrs = new Set<string>();
    for (const [corrId, entry] of state.agentNodes) {
      if (entry.payload.sessionId === sessionId) {
        visibleAgentCorrs.add(corrId);
      }
    }

    // #2750 AC4 (ST-5): resolve the visible (non-suppressed) anchors — one O(N)
    // pass over the session's agents in CHRONOLOGICAL (startTime) order (NFR-2).
    // `visibleNonTransitional` is the emitted chat-node set; `chainPredecessor`
    // gives each node's chain-edge source and each transitional turn's child
    // anchor (SubagentNode/ToolsNode edges + layout/companion columns re-anchor
    // to the nearest preceding visible node). Chronological order — never the
    // merged-delivery arrival order — keeps the chain oldest→newest top→bottom
    // (arrival order can be reversed when live TTL-shrunk deliveries are merged
    // before restored ones).
    const { chainPredecessor, visibleNonTransitional } = buildVisibleAnchors(
      chronologicalAgentOrder(state.agentOrder, state.agentNodes),
      state.agentNodes,
      visibleAgentCorrs,
    );

    // ── Phase 3: Build ReactFlow nodes only for affected entries (REQ-5) ──
    const nodeList: Node<MonitorNodeData>[] = [];

    // One ToolsNode per VISIBLE chat node (anchor) — merge the per-parent
    // builder entries that anchor to the same visible node.
    const mergedToolsNodes = buildMergedToolsNodes(state, chainPredecessor, visibleNonTransitional);
    const emittedToolsAnchors = new Set<string>();

    for (const entryId of affectedEntryIds) {
      const colonIdx = entryId.indexOf(':');
      if (colonIdx < 0) continue;

      const prefix = entryId.slice(0, colonIdx);
      const corrId = entryId.slice(colonIdx + 1);

      if (prefix === 'agent') {
        // #2750 AC4 (ST-5): emit only VISIBLE non-transitional chat nodes —
        // completed text-less dispatch turns are suppressed from the canvas
        // (their builder state stays intact — NFR-5).
        if (visibleNonTransitional.has(corrId)) {
          const entry = state.agentNodes.get(corrId)!;
          const label = makeAgentNodeLabel(entry.payload);
          nodeList.push(makeReactFlowNode(
            `agent-${corrId}`, 'agent', entry.status, entry.payload, entry.timestamp, label,
          ));
        }
      } else if (prefix === 'tools') {
        // One ToolsNode per VISIBLE chat node (the RESOLVED anchor) — merge the
        // tool calls of every dispatch turn that anchors to the same visible
        // node (a user exchange makes multiple tool-calling turns before its
        // reply). Emit `tools-<anchorCorrId>` once per anchor per batch.
        const { anchorCorrId } = resolveCompanionEmission(
          corrId, false, chainPredecessor, visibleNonTransitional, state.agentNodes,
        );
        if (anchorCorrId && !emittedToolsAnchors.has(anchorCorrId)) {
          const mergedEntry = mergedToolsNodes.get(anchorCorrId);
          if (mergedEntry) {
            emittedToolsAnchors.add(anchorCorrId);
            const payload = mergedToolsPayload(
              anchorCorrId, mergedEntry.toolCalls, mergedEntry.sessionId,
              mergedToolsPayloadCacheRef.current,
            );
            nodeList.push(makeReactFlowNode(
              `tools-${anchorCorrId}`, 'tools', mergedEntry.status, payload, mergedEntry.timestamp,
              `Tools · ${payload.toolCalls.length} calls`,
            ));
          }
        }
      } else if (prefix === 'subagent') {
        // #2745 ST-4 (R-1): a SubagentNode is shown only when its PARENT chat
        // node is visible in the selected session (companion-column rule, same
        // as the ToolsNode). One SubagentNode per user-requested dispatch.
        // #2750 AC4: the parent's RESOLVED anchor must be a rendered node —
        // a subagent dispatched from a suppressed transitional turn anchors to
        // the nearest preceding (or, for a suppressed FIRST turn, following)
        // visible chat node (exactly ONE node per dispatch — AC4-2).
        // #2750 round-6: belt-and-suspenders — even when the session has NO
        // visible chat node at all (every turn text-less/suppressed), a
        // user-requested dispatch still emits its SubagentNode (NFR-5:
        // suppression is chat-node emission only, never the SubagentNode). The
        // anchor falls back to the parent's own corrId so edge/layout code
        // below still resolves a source; the parent node may not be rendered,
        // in which case the e-calls edge is naturally skipped.
        const entry = state.subagentNodes.get(corrId);
        const parentCorrId = entry?.payload.parentCorrelationId ?? '';
        // Cross-session contamination guard: `state.agentNodes` is the GLOBAL
        // builder map (all sessions' chat nodes — the builder processes every
        // session's deliveries), so a bare `.has(parentCorrelationId)` returned
        // TRUE for a subagent whose parent chat node lives in a DIFFERENT
        // session, leaking that session's SubagentNode into the selected
        // session's graph on every session switch. Scope the round-6
        // belt-and-suspenders fallback to THIS session: the parent chat node
        // must belong to the selected session (a suppressed/transitional parent
        // in THIS session still emits its subagent — the round-6 intent — but a
        // foreign session's parent never does).
        const parentEntry = entry
          ? state.agentNodes.get(parentCorrId)
          : undefined;
        const parentExists = parentEntry
          ? parentEntry.payload.sessionId === sessionId
          : false;
        // UX: emit only when the anchor is FINAL. A task dispatch often
        // arrives before its dispatch turn's same-exchange reply renders, so on
        // early batches the anchor is PROVISIONAL (an earlier unrelated chat
        // node) — emitting there makes the node flash-attach to the "first
        // Chatnode" and then jump to the reply. Hold the node until the anchor
        // settles (the reply arrives), or the round-6 anchorless belt fires.
        const { emit: subagentEmit } = resolveCompanionEmission(
          parentCorrId, parentExists, chainPredecessor, visibleNonTransitional, state.agentNodes,
        );
        if (entry && subagentEmit) {
          nodeList.push(makeReactFlowNode(
            `subagent-${corrId}`, 'subagent', entry.status, entry.payload, entry.timestamp,
            `Subagent · ${entry.payload.name}`,
          ));
        }
      }
    }

    // ── Build lightweight layout data from FULL state (for graph signature) ──
    // Compute node depths via BFS across the ENTIRE graph structure.
    // This is O(N_total) but cheap — no ReactFlow Node object creation.
    const allNodeDepths = new Map<string, number>();
    const allNodeTypes = new Map<string, string>();
    const allLayoutEdges: { source: string; target: string }[] = [];

    for (const entryId of state.nodeOrder) {
      const colonIdx = entryId.indexOf(':');
      if (colonIdx < 0) continue; // no raw-id entries (tool/file removed — #2745 ST-4)
      const prefix = entryId.slice(0, colonIdx);
      const corrId = entryId.slice(colonIdx + 1);
      let nodeId: string;
      let nodeType: string;
      if (prefix === 'agent') { nodeId = `agent-${corrId}`; nodeType = 'agent'; }
      else if (prefix === 'tools') {
        // Tools nodes are emitted MERGED per visible anchor (`tools-<anchor>`),
        // not per dispatch turn (`tools-<parent>`). The structure signature must
        // reflect the EMITTED node ids or the layout never recomputes / a stale
        // per-parent id is preserved.
        const anchorCorrId = resolveChildAnchor(corrId, chainPredecessor, visibleNonTransitional);
        if (!anchorCorrId) continue;
        nodeId = `tools-${anchorCorrId}`;
        nodeType = 'tools';
      }
      else { nodeId = `subagent-${corrId}`; nodeType = 'subagent'; }
      allNodeTypes.set(nodeId, nodeType);
      if (nodeType === 'agent') {
        allNodeDepths.set(nodeId, 0);
      }
    }

    // Build layout edges from ALL state
    for (const entryId of state.nodeOrder) {
      const colonIdx = entryId.indexOf(':');
      if (colonIdx < 0) continue;
      const prefix = entryId.slice(0, colonIdx);
      const corrId = entryId.slice(colonIdx + 1);
      if (prefix === 'subagent') {
        // #2745 ST-4: the subagent edge in the layout graph (parent chat node →
        // its SubagentNode) so the BFS depth + structure signature include it
        // (a new subagent recomputes). Subagent positions themselves are
        // chain-owned — applySubagentChainPositions overrides the force result.
        // #2750 AC4: the edge source is the parent's RESOLVED anchor (the
        // nearest preceding visible node when the dispatch turn is suppressed),
        // mirroring the rendered e-calls edge.
        const entry = state.subagentNodes.get(corrId);
        if (entry) {
          const anchorCorrId = resolveChildAnchor(
            entry.payload.parentCorrelationId,
            chainPredecessor,
            visibleNonTransitional,
          );
          if (anchorCorrId) {
            const parentId = `agent-${anchorCorrId}`;
            const subagentId = `subagent-${corrId}`;
            if (allNodeTypes.has(parentId) && allNodeTypes.has(subagentId)) {
              allLayoutEdges.push({ source: parentId, target: subagentId });
            }
          }
        }
      }
    }

    // BFS propagate depth from agent nodes (depth 0) along edges
    let bfsChanged = true;
    while (bfsChanged) {
      bfsChanged = false;
      for (const e of allLayoutEdges) {
        const sourceDepth = allNodeDepths.get(e.source);
        if (sourceDepth !== undefined && !allNodeDepths.has(e.target)) {
          allNodeDepths.set(e.target, sourceDepth + 1);
          bfsChanged = true;
        }
      }
    }
    for (const nodeId of allNodeTypes.keys()) {
      if (!allNodeDepths.has(nodeId)) {
        allNodeDepths.set(nodeId, 0);
      }
    }

    // Build lightweight layout nodes (id, status, depth, type) for graph signature
    const layoutNodes = Array.from(allNodeTypes.keys()).map((nodeId) => {
      // #2739 ST-1: match `tools-` BEFORE `tool-` (the legacy prefix is a
      // string-prefix of the tools id — 'tools-…'.startsWith('tool-') is true).
      // #2745 ST-4: subagent-… maps to the subagent entry.
      const entryId = nodeId.startsWith('tools-') ? `tools:${nodeId.slice(6)}`
        : nodeId.startsWith('subagent-') ? `subagent:${nodeId.slice(9)}`
        : nodeId.startsWith('agent-') ? `agent:${nodeId.slice(6)}`
        : nodeId;
      const eci = entryId.indexOf(':');
      let status: MonitorNodeStatus = 'inactive';
      if (eci >= 0) {
        const prefix = entryId.slice(0, eci);
        const corrId = entryId.slice(eci + 1);
        const entry = prefix === 'agent' ? state.agentNodes.get(corrId)
          : prefix === 'tools' ? state.toolsNodes.get(corrId)
          : prefix === 'subagent' ? state.subagentNodes.get(corrId)
          : undefined;
        if (entry) status = graphStatusToMonitorStatus(entry.status);
      }
      return {
        id: nodeId,
        status,
        depth: allNodeDepths.get(nodeId) ?? 0,
        type: allNodeTypes.get(nodeId) ?? 'agent',
      };
    });

    // AC-6: Only recompute layout when graph structure changes.
    // #2723 ST4 (R-4): the layout signature is SPLIT — a structural signature
    // (node ids + edges) gates the full d3-force recompute, and a chain-height
    // signature (agent id → measured px) gates a cheap chain-only reflow.
    // A measured-height change flips the height signature and reflows the
    // chain without touching the non-agent force positions (settled-node
    // freezing preserved, O(N) chain recompute only — no full-graph re-layout).
    const chainAgents: ChainAgent[] = [];
    for (const corrId of chronologicalAgentOrder(state.agentOrder, state.agentNodes)) {
      const entry = state.agentNodes.get(corrId);
      if (entry) {
        // #2750 AC4: suppressed transitional turns occupy NO chain slot (their
        // node is never emitted) — excluding them keeps the chain contiguous.
        if (isTransitionalTurn(entry)) continue;
        const nodeId = `agent-${corrId}`;
        chainAgents.push({
          id: nodeId,
          sessionId: entry.payload.sessionId,
          height: measuredHeightsRef.current.get(nodeId),
        });
      }
    }
    const structureSignature = layoutNodes.map(n => n.id).sort().join(',') + '|' +
      allLayoutEdges.map(e => `${e.source}>${e.target}`).sort().join(',');
    const heightSignature = chainAgents
      .map(a => `${a.id}:${a.height ?? ''}`)
      .sort()
      .join(',');
    const structureChanged = structureSignature !== lastGraphRef.current;
    const heightsChanged = heightSignature !== lastHeightsRef.current;

    if (layoutMode === 'force') {
      // #2758 ST-1: Bostock-faithful disjoint — every Force node fx==null && fy==null,
      // clusters arise from disconnected link components + many-body repulsion
      // + single forceCenter, no per-exchange forceX/forceY magnets.
      // The disjoint edge set is chat→tool and chat→subagent ONLY — chat→chat
      // chain edges are render-only and MUST NOT reach the Force simulation.
      const paneMeasured = viewportBounds !== undefined && viewportBounds.width > 0 && viewportBounds.height > 0;
      if (paneMeasured) {
        const rawExchangeEdges: LayoutEdge[] = [...allLayoutEdges];
        for (const anchorCorrId of mergedToolsNodes.keys()) {
          const parentId = `agent-${anchorCorrId}`;
          const toolsId = `tools-${anchorCorrId}`;
          if (allNodeTypes.has(parentId) && allNodeTypes.has(toolsId)) {
            rawExchangeEdges.push({ source: parentId, target: toolsId });
          }
        }
        // Force link set MUST exclude chat→chat; only chat→tool and chat→subagent.
        // Use filter(l => l.kind !== 'chat→chat') for Force path — Chain unchanged.
        // LayoutEdge has no kind field, so we attach it transiently for the filter.
        const withKind = rawExchangeEdges.map((e) => ({ ...e, kind: e.source.startsWith('agent-') && e.target.startsWith('agent-') ? 'chat→chat' : e.target.startsWith('tools-') ? 'chat→tool' : 'chat→subagent' }));
        const disjointEdges: LayoutEdge[] = withKind.filter(l => l.kind !== 'chat→chat').map(({ source, target }) => ({ source, target }));
        const exchangeEdges: LayoutEdge[] = disjointEdges;
        // Bostock: no per-exchange anchors, no forceX/forceY. Seed is cached positions.
        const seed = new Map(layoutPositionsRef.current);

        if (modeChanged || paneChanged || structureChanged || layoutPositionsRef.current.size === 0) {
          if (!forceSimRef.current) {
            forceSimRef.current = createLiveForceSimulation({
              viewportWidth: paneBounds.width,
              viewportHeight: paneBounds.height,
              containmentBounds: () => lastPaneBoundsRef.current,
              collideRadius: 12,
              snapToSettled: prefersReducedMotion(),
              onTick: (positions) => {
                // Position-only functional setNodes merge — node data
                // (payload/status) must survive every tick (EARS-8). The live
                // positions are also cached so the incremental merge below
                // re-positions preserved nodes to their current animated spot
                // instead of a stale snapshot.
                layoutPositionsRef.current = positions;
                setNodes((currentNodes) => {
                  let changed = false;
                  const merged = currentNodes.map((n) => {
                    const pos = positions.get(n.id);
                    if (pos && (n.position.x !== pos.x || n.position.y !== pos.y)) {
                      changed = true;
                      return { ...n, position: { x: pos.x, y: pos.y } };
                    }
                    return n;
                  });
                  return changed ? merged : currentNodes;
                });
              },
              onSettled: (positions) => {
                layoutPositionsRef.current = positions;
              },
            });
          }
          forceSimRef.current.restart(layoutNodes, exchangeEdges, seed);
          // Sync the position cache to the sim's seeded positions so the nodeList
          // application below renders fresh nodes at their sim seed (never (0,0))
          // and preserved nodes keep their current spot until the first tick.
          layoutPositionsRef.current = new Map(forceSimRef.current.positions());
          lastGraphRef.current = structureSignature;
          lastHeightsRef.current = heightSignature;
        } else if (heightsChanged) {
          // #2756 round-3 (AC4): a measured-height change is layout-IRRELEVANT in
          // Force mode — positions come from the sim, NOT the chain stack (no
          // measured-height stacking), so restarting the sim here would reset
          // alpha and re-glide for zero layout benefit. Worse, a live-but-idle
          // session that keeps reporting dimension changes (content reflow,
          // late measurements) would NEVER reach alphaMin — the round-2 AC4
          // defect (no byte-identical settle). Absorb the height signature so
          // the early-return gate stops re-running the block, and let the
          // running (or already frozen) sim settle. The #2754 "re-pin the chain"
          // concept is gone: there is no chain to re-pin in Force.
          lastHeightsRef.current = heightSignature;
        }
      } // else (pane unmeasured): defer — no Force sim until the pane lands.
    } else {
      // ── Chain mode: byte-identical to today (#2752 ST-2 non-goal) ──
      if (modeChanged) {
        // force→chain: stop the sim (no orphan rAF loop — NFR-3/T19) and
        // restore the deterministic chain geometry via the full recompute
        // below (force→chain restore is an instant snap).
        forceSimRef.current?.stop();
        forceSimRef.current = null;
      }
      if (structureChanged || layoutPositionsRef.current.size === 0 || modeChanged) {
        const layoutEdges = allLayoutEdges;
        const { positions, converged, iterations } = computeForceLayout(
          layoutNodes,
          layoutEdges,
          {
            maxIterations: 300,
            alphaMin: 0.01,
            alphaDecay: 0.02,
            existingPositions: layoutPositionsRef.current,
          },
        );

        // #2688 ST4: Replace the AGENT portion of the d3-force layout with
        // deterministic per-session vertical chain positions (oldest on top,
        // newest at the bottom, x centered — #2700 ST1 flipped the direction).
        // #2723 ST4 (R-4): the chain stacks by MEASURED height —
        // y = prev.y + (prev.height ?? DEFAULT_NODE_HEIGHT) + CHAIN_GAP — so a
        // content node with a full response box can never overlap or cover the
        // node beneath it. Unmeasured fresh nodes fall back to the conservative
        // DEFAULT_NODE_HEIGHT until ReactFlow reports their size.
        // Non-agent nodes keep their force layout result. The chain uses
        // agentOrder (global arrival order) grouped by session, so each session
        // is an independent chain.
        const chainPositions = computeChatChainPositions(chainAgents);
        for (const [nodeId, pos] of chainPositions) {
          positions.set(nodeId, pos);
        }

        // #2739 NFR-3: place each ToolsNode in its deterministic right-side
        // chain slot (ST-3 computeToolsChainPositions — x = TOOLS_CHAIN_X,
        // y = parent chat node y). Included in the structure signature above, so
        // a tool-arrival (new ToolsNode) recomputes and places it.
        applyToolsChainPositions(positions, state, chainPositions, visibleNonTransitional, chainPredecessor);
        // #2745 ST-4 (A-5): place each SubagentNode in its own companion column
        // LEFT of the chat chain (x = SUBAGENT_CHAIN_X, y = parent y +
        // dispatch index × (SUBAGENT_NODE_HEIGHT + CHAIN_GAP)). Same chain-owned
        // machinery as the ToolsNode column — never touched by force/residue.
        applySubagentChainPositions(positions, state, chainPositions, visibleNonTransitional, chainPredecessor);

        // #2723 ST4 belt-and-suspenders: rectangular de-overlap for any
        // non-agent residue the d3 collision radii may still leave overlapping.
        // Widths mirror the forceCollide radii; heights default to 2× the radius
        // for legacy residue and use the measured height when ReactFlow has one.
        // #2739 NFR-3 / #2745 ST-4: tools + subagent nodes are chain-owned —
        // excluded from this pass (all live types are chain-owned, so the pass
        // is inert; kept for the frozen residue geometry).
        const residueRects: RectNode[] = [];
        for (const n of layoutNodes) {
          if (n.type === 'agent' || n.type === 'tools' || n.type === 'subagent') continue;
          const pos = positions.get(n.id);
          if (!pos) continue;
          const width = n.type === 'tool' ? 480 : 420;
          residueRects.push({
            id: n.id,
            x: pos.x,
            y: pos.y,
            width,
            height: measuredHeightsRef.current.get(n.id) ?? width,
          });
        }
        if (residueRects.length > 1) {
          const resolved = resolveRectOverlaps(residueRects);
          for (const [id, pos] of resolved) {
            positions.set(id, pos);
          }
        }

        layoutPositionsRef.current = positions;
        lastGraphRef.current = structureSignature;
        lastHeightsRef.current = heightSignature;
      } else if (heightsChanged) {
        // #2723 ST4: height-only change — reflow the chain (measured-height
        // stacking) without re-running the d3 force simulation. Non-agent
        // force positions are preserved untouched (settled-node freezing).
        const positions = new Map(layoutPositionsRef.current);
        const chainPositions = computeChatChainPositions(chainAgents);
        for (const [nodeId, pos] of chainPositions) {
          positions.set(nodeId, pos);
        }
        // #2739 NFR-3: re-place the tools slots so they track their parents' y.
        applyToolsChainPositions(positions, state, chainPositions, visibleNonTransitional, chainPredecessor);
        // #2745 ST-4 (A-5): re-place the subagent slots on the same reflow so the
        // subagent stacks track their parents' y.
        applySubagentChainPositions(positions, state, chainPositions, visibleNonTransitional, chainPredecessor);
        layoutPositionsRef.current = positions;
        lastHeightsRef.current = heightSignature;
      }
    }

    // Apply cached positions to nodeList
    for (const node of nodeList) {
      const pos = layoutPositionsRef.current.get(node.id);
      if (pos) {
        node.position = { x: pos.x, y: pos.y };
      } else {
        node.position = { x: 0, y: 0 };
      }
    }

    // ── Phase 4: Build the FULL desired edge set (REQ-6 + re-anchor safety) ──
    // Existing edges are preserved by the functional setEdges updater. #2750
    // AC4: every edge source resolves to the visible anchor (never a suppressed
    // node). The desired set is built over ALL visible companion entries each
    // batch — NOT just the affected set — because an anchor can re-resolve
    // WITHOUT the entry being affected: when the same-exchange reply turn
    // (`_6`) arrives, a subagent/tools entry whose suppressed dispatch parent
    // (`_5`) re-anchors to the new reply moves (the layout re-anchors fresh),
    // but its existing edge would keep the OLD source forever (append-only
    // edges never re-source). Building the full set each batch lets Phase 6
    // REPLACE edges whose source/target changed.
    const edgeList: Edge[] = [];
    const emittedToolsEdgeAnchors = new Set<string>();

    // Helper: build a single chat-chain edge for an agent node, linking it to
    // its nearest preceding NON-transitional visible chat node of the session
    // (the resolved anchor — #2750 AC4).
    const buildChatEdge = (corrId: string) => {
      if (!visibleNonTransitional.has(corrId)) return;
      const prevCorrId = chainPredecessor.get(corrId) ?? '';
      if (!prevCorrId) return;
      const prevId = `agent-${prevCorrId}`;
      const curId = `agent-${corrId}`;
      if (state.agentNodes.has(prevCorrId) && visibleNonTransitional.has(prevCorrId)) {
        edgeList.push(makeReactFlowEdge(
          `e-chat-${prevCorrId}-${corrId}`,
          prevId,
          curId,
          'chat',
        ));
      }
    };

    for (const entryId of state.nodeOrder) {
      const colonIdx = entryId.indexOf(':');
      if (colonIdx < 0) continue;

      const prefix = entryId.slice(0, colonIdx);
      const corrId = entryId.slice(colonIdx + 1);

      if (prefix === 'agent') {
        buildChatEdge(corrId);
      } else if (prefix === 'tools') {
        // One summary edge per VISIBLE chat node (the anchor) — mirrors the
        // merged ToolsNode emission (never a dangling edge to a per-parent
        // node that is not rendered).
        const { anchorCorrId } = resolveCompanionEmission(
          corrId, false, chainPredecessor, visibleNonTransitional, state.agentNodes,
        );
        if (anchorCorrId && !emittedToolsEdgeAnchors.has(anchorCorrId) && mergedToolsNodes.has(anchorCorrId)) {
          emittedToolsEdgeAnchors.add(anchorCorrId);
          edgeList.push(makeToolsReactFlowEdge(
            `e-tools-${anchorCorrId}`,
            `agent-${anchorCorrId}`,
            `tools-${anchorCorrId}`,
          ));
        }
      } else if (prefix === 'subagent') {
        // #2745 ST-4 (R-1): the subagent edge — parent chat node (source-left)
        // → its SubagentNode (target-right): subagents sit LEFT of the chat
        // chain (makeSubagentReactFlowEdge). One edge per dispatched subagent;
        // the subagent node is a leaf (no source handles). #2750 AC4: the
        // source is the parent's RESOLVED anchor.
        // UX: gate on the SAME final-anchor emission as the node — a held
        // SubagentNode (provisional anchor) gets no dangling edge.
        const entry = state.subagentNodes.get(corrId);
        if (entry) {
          const parentCorrId = entry.payload.parentCorrelationId;
          const parentEntry = state.agentNodes.get(parentCorrId);
          const parentExists = parentEntry ? parentEntry.payload.sessionId === sessionId : false;
          const { emit: subagentEdgeEmit, anchorCorrId: subagentAnchorCorrId } = resolveCompanionEmission(
            parentCorrId, parentExists, chainPredecessor, visibleNonTransitional, state.agentNodes,
          );
          if (subagentEdgeEmit && subagentAnchorCorrId) {
            edgeList.push(makeSubagentReactFlowEdge(
              `e-calls-${corrId}`,
              `agent-${subagentAnchorCorrId}`,
              `subagent-${corrId}`,
            ));
          }
        }
      }
    }

    // ── Phase 5: Functional setNodes — merge new+changed into existing ──
    // REQ-5: Preserve unchanged nodes; add new; update changed; remove deleted.
    setNodes((currentNodes) => {
      const affectedIds = new Set(nodeList.map(n => n.id));
      const merged: Node<MonitorNodeData>[] = [];
      let changed = false;

      // Pass 1: Preserve existing nodes NOT in the affected set (unchanged)
      for (const existing of currentNodes) {
        if (!affectedIds.has(existing.id)) {
          // Verify the node still exists in state maps (defensive removal)
          const id = existing.id;
          let isVisible = true;
          if (id.startsWith('agent-')) {
            const corrId = id.slice(6);
            // #2750 AC4: cross-session visibility AND suppression — a
            // completed text-less turn that just became transitional is
            // dropped from the canvas (its builder state stays intact, NFR-5;
            // a later reply re-surfaces it through the affected set).
            isVisible = state.agentNodes.has(corrId) && visibleNonTransitional.has(corrId);
          } else {
            // #2739 ST-1: match `tools-` BEFORE `tool-` (the legacy prefix is a
            // string-prefix of the tools id — 'tools-…'.startsWith('tool-') is
            // true; without this order a preserved ToolsNode would be dropped).
            // #2745 ST-4: a SubagentNode survives while its builder entry does
            // (its parent-visibility gate runs in Phase-3 emission; the session
            // reset drops all entries on session change). Session-scoped: a
            // foreign session's subagent entry (parent chat node in a different
            // session) must never be preserved — mirrors the Phase-3 emission
            // gate so a leaked node can't linger across renders.
            isVisible = id.startsWith('tools-')
              ? mergedToolsNodes.has(id.slice(6))
              : id.startsWith('subagent-')
                ? state.subagentNodes.get(id.slice(9))?.payload.sessionId === sessionId
                : false;
            // UX (flash fix): the final-anchor emission gate ALSO gates
            // preservation — a companion node whose anchor became PROVISIONAL
            // (its dispatch turn completed empty but the same-exchange reply has
            // not rendered) must be dropped from the canvas (held), not left
            // stranded attached to an earlier unrelated chat node. Without this
            // the node would linger at its stale position until the reply
            // re-surfaces it (or forever if the session resets).
            if (isVisible && id.startsWith('subagent-')) {
              const saEntry = state.subagentNodes.get(id.slice(9));
              if (saEntry) {
                const parentEntry = state.agentNodes.get(saEntry.payload.parentCorrelationId);
                const parentExists = parentEntry
                  ? parentEntry.payload.sessionId === sessionId
                  : false;
                isVisible = resolveCompanionEmission(
                  saEntry.payload.parentCorrelationId, parentExists,
                  chainPredecessor, visibleNonTransitional, state.agentNodes,
                ).emit;
              } else {
                isVisible = false;
              }
            }
            // Tools nodes are merged by anchor — preservation is gated by the
            // merged set membership above (a `tools-<anchor>` id survives while
            // its anchor still has an emissible per-parent entry).
          }
          if (isVisible) {
            // #2688 ST10: Re-position preserved nodes when the chain reflows.
            // computeChatChainPositions / applyToolsChainPositions /
            // applySubagentChainPositions recompute positions for ALL nodes on
            // graph-signature change (see the recompute block above) and on
            // height-only reflows, but only the current batch's affected set
            // lands in nodeList. An existing node whose correlationId was not
            // re-touched this batch is preserved here with its OLD rendered
            // position — so under incremental arrivals (one message per export,
            // the live Run CLI pattern) it would stay put while the newest node
            // is placed at the chain top, overlapping it. Re-emit the cached
            // position when it differs. This applies to EVERY node type: agent
            // nodes (original ST10) AND the chain-owned tools/subagent columns
            // — a measured-height reflow moves a parent chat node's y, and its
            // ToolsNode/SubagentNode slots must track it or they stay stranded
            // at the unmeasured fallback position. The equality check suppresses
            // no-op re-emits (same pattern as the Pass-2 deep compare); each
            // preserved node is an O(1) map lookup, keeping the incremental
            // builder O(N) — NFR-1.
            const cached = layoutPositionsRef.current.get(id);
            if (cached &&
                (existing.position.x !== cached.x || existing.position.y !== cached.y)) {
              merged.push({
                ...existing,
                position: { x: cached.x, y: cached.y },
              });
              changed = true;
            } else {
              merged.push(existing);
            }
          } else {
            changed = true; // node no longer visible (session scope changed or removed)
          }
        }
      }

      // Pass 2: Add/update nodes from affected set with deep compare
      for (const node of nodeList) {
        const idx = currentNodes.findIndex(n => n.id === node.id);
        if (idx >= 0) {
          const existing = currentNodes[idx];
          const posChanged = existing.position.x !== node.position.x ||
            existing.position.y !== node.position.y;
          const statusChanged = existing.data.status !== node.data.status;
          const payloadChanged = existing.data.payload !== node.data.payload;
          if (posChanged || statusChanged || payloadChanged) {
            merged.push({
              ...node,
              width: node.width ?? existing.width,
              height: node.height ?? existing.height,
            });
            changed = true;
          } else {
            merged.push(existing);
          }
        } else {
          merged.push(node);
          changed = true;
        }
      }

      return changed ? merged : currentNodes;
    });

    // ── Phase 6: Edge reconciliation (REQ-6 + re-anchor safety) ──
    // The desired edge set is built in Phase 4 over EVERY nodeOrder entry each
    // batch (not just the affected set). Reconciliation below then: keeps
    // unchanged edges (same object reference — ReactFlow does not re-render
    // them), REPLACES re-anchored edges (same id, new source/target/handles —
    // a subagent/tools edge whose suppressed parent re-anchored to a new
    // same-exchange reply, or a chat edge whose predecessor changed), drops
    // stale edges (not in the desired set — endpoint suppressed/removed or
    // re-anchored away), and adds new edges. The desired set IS the truth, so
    // an edge absent from it is never preserved.
    setEdges((currentEdges) => {
      // The desired set is the FULL edge truth for the current builder state
      // (Phase 4 builds it over every nodeOrder entry each batch), so an
      // existing edge NOT in it is stale — either its anchor re-resolved (a
      // subagent/tools edge whose suppressed parent re-anchored to a new
      // same-exchange reply, or a chat edge whose predecessor changed) or its
      // endpoint was removed/suppressed. Replace geometry-changed edges, drop
      // the rest, add new ones.
      const desiredById = new Map(edgeList.map(e => [e.id, e]));
      const merged: Edge[] = [];
      let changed = false;

      // Pass 1: reconcile existing edges — keep unchanged, REPLACE re-anchored
      // (same id, new source/target/handles), drop stale (not in desired set).
      for (const e of currentEdges) {
        const desired = desiredById.get(e.id);
        if (desired) {
          desiredById.delete(e.id);
          const sameGeometry =
            desired.source === e.source &&
            desired.target === e.target &&
            desired.sourceHandle === e.sourceHandle &&
            desired.targetHandle === e.targetHandle;
          if (sameGeometry) {
            merged.push(e);
          } else {
            merged.push(desired);
            changed = true;
          }
        } else {
          changed = true; // stale — re-anchored away or endpoint removed
        }
      }
      // Pass 2: add desired edges not yet present.
      for (const desired of desiredById.values()) {
        merged.push(desired);
        changed = true;
      }
      return changed ? merged : currentEdges;
    });

  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionDeliveries, sessionId, heightReflowEpoch, layoutMode, viewportBounds]);

  const [nodes, setNodes, rawOnNodesChange] = useNodesState<MonitorNodeData>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  // Stable ref for edges — prevents onNodesChange from depending on edges
  const edgesRef = useRef(edges);
  edgesRef.current = edges;

  // ── Force-directed layout (REQ-6/7) ─────────────────────────────────────────
  // Layout is computed in the processing useEffect above. onNodesChange is
  // a pass-through for ReactFlow state plus a #2723 ST4 (R-4) dimension
  // interceptor: ReactFlow reports rendered node sizes via 'dimensions'
  // changes, which we record as the last measured heights so the chat chain
  // can stack by measured height. When an AGENT node's height actually
  // changes, bump heightReflowEpoch → the processing effect re-runs and the
  // chain re-stacks (height-aware layout signature). The prev-compare makes
  // same-height re-measures no-ops, so there is no re-render loop (Spec
  // #275/#523 pattern — the Spec #275 guard, setLayoutVersion only when
  // layout actually changes, is handled by the processing effect: it only
  // runs when sessionDeliveries or heightReflowEpoch changes, not on every
  // dimension change).
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    rawOnNodesChange(changes);
    // #2723 ST4 (R-4): record last measured node heights. Only bump the
    // reflow epoch when an agent node's height ACTUALLY changed — identical
    // re-measures (the same node re-rendering at the same size) must not
    // trigger a chain reflow (Spec #275/#523 no-loop pattern).
    let agentHeightChanged = false;
    for (const change of changes) {
      if (change.type !== 'dimensions' || !change.dimensions) continue;
      const nodeId = change.id;
      const h = change.dimensions.height;
      if (typeof h !== 'number' || h <= 0) continue;
      const prev = measuredHeightsRef.current.get(nodeId);
      measuredHeightsRef.current.set(nodeId, h);
      if (nodeId.startsWith('agent-') && prev !== h) {
        agentHeightChanged = true;
      }
    }
    if (agentHeightChanged) {
      setHeightReflowEpoch((e) => e + 1);
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _currentEdges = edgesRef.current;
  }, [rawOnNodesChange]);

  return {
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
    layoutVersion,
    // eventCount: Only count deliveries from the selected session (not all-processed).
    // The graph builder processes all deliveries for cross-session visibility,
    // but the event count should reflect only the selected session's activity.
    eventCount: sessionId ? deliveries.filter(d => deliverySessionId(d) === sessionId).length : 0,
  };
}
