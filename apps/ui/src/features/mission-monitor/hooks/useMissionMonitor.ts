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
} from '../lib/graph';
import { graphStatusToMonitorStatus, GRAPH_NODE_TYPE_MAP } from '../types';
import type { MonitorNodeData, MonitorNodeStatus } from '../types';
import {
  computeForceLayout,
  computeChatChainPositions,
  computeSubagentChainPositions,
  computeCompanionExtents,
  resolveRectOverlaps,
  type ChainAgent,
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
const EDGE_STYLES: Record<GraphEdgeType, React.CSSProperties> = {
  parent:  { stroke: 'var(--accent-primary)', strokeWidth: 1.5 },
  calls:   { stroke: 'var(--accent-subagent)', strokeWidth: 1.5 },
  reads:   { stroke: 'var(--border-color)', strokeDasharray: '2,4', strokeWidth: 1 },
  writes:  { stroke: 'var(--border-color)', strokeDasharray: '2,4', strokeWidth: 1 },
  // #2688: dashed accent — visually distinct from 'parent' (solid accent) and
  // 'calls' (solid subagent) so the per-session chat chain reads as one thread.
  chat:    { stroke: 'var(--accent-primary)', strokeDasharray: '4,4', strokeWidth: 1.5 },
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
 *  AND no embedded tool item (#2764: the former ToolsNode item). `build` is
 *  live-confirmed (ST-1 Phase-0); `plan` is plan-specified (unconfirmed until
 *  a run triggers it). Keyed on the SAME parsed name field the node displays
 *  (`subagent_type`). */
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
 * (SubagentNode edges + companion-column layout) attach to;
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
 * the exchange), so the SubagentNode emission gate sees a rendered
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
  // The SAME-EXCHANGE rule (the user-facing fix for the misplaced SubagentNode):
  // the adapter copies the user message into BOTH the
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
 * layout + companion columns, #2764: also embedded tools) attach to — the
 * parent itself when it is a non-transitional visible chat node, else its
 * chain predecessor. ''
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
 * UX (flash fix): companion-node (SubagentNode) emission + anchor
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
 * #2745 ST-4 (R-1) / #2766 ST-2 (R6): the SubagentNode edge — from the
 * parent's RIGHT-side source handle (`source-right`: the chat node's for
 * root dispatches, the parent SubagentNode's own for nested ones) to the
 * SubagentNode's LEFT target handle (`target-left`): subagents render in
 * their own column RIGHT of the chat chain (#2766 mirror of the #2745
 * LEFT-side grammar), so the delegation edge exits the conversation on the
 * right and enters the subagent card from its left. Reuses the existing
 * `'calls'` edge type + EDGE_STYLES.calls (Architect API contract — no new
 * GraphEdgeType variant).
 */
function makeSubagentReactFlowEdge(id: string, source: string, target: string): Edge {
  return {
    id,
    source,
    target,
    type: 'smoothstep',
    animated: false,
    hidden: false,
    sourceHandle: 'source-right',
    targetHandle: 'target-left',
    style: EDGE_STYLES.calls,
  };
}

/**
 * #2745 ST-4 (A-5) / #2762 ST-3+ST-4: apply the deterministic SubagentNode
 * companion-column chain slots on top of a positions map. Subagent nodes are
 * chain-owned — their chain slots are authoritative and they are never touched
 * by the d3-force residue pass. Called from BOTH the structural recompute and
 * the height-only reflow so a chain
 * reflow re-aligns each subagent column with its parent's new y. A parent's
 * subagents are indexed by dispatch startTime (deterministic; the payload
 * startTime with the entry timestamp as fallback).
 *
 * #2762 ST-3: NESTED SubagentNodes (parent is itself a SubagentNode) are fed
 * into the SAME geometry with parentId = `subagent-<parentCorrId>` — Dev B's
 * ST-4 subtree-band `computeSubagentChainPositions` allocates their lanes
 * recursively (D-1a: one lane right per level, NESTED_TIER_INDENT_Y vertical
 * staircase, disjoint bands so sibling branches never share an x-lane). Root
 * association paths are untouched: a no-nesting session produces the exact
 * same `agent-`-anchored entries as before (R-7).
 */
/**
 * #2770 ST-3: the byParent grouping + dispatch-index ordering shared by
 * `applySubagentChainPositions` (placement) and the companion-extent builder
 * (chain pitch) — extracted verbatim from applySubagentChainPositions so both
 * consumers see the EXACT same parent relation (an extent must cover exactly
 * the cards placed under that anchor). Groups subagent entries by their
 * RESOLVED parent: a chat node's RESOLVED anchor (#2750 AC4: the anchor is
 * the parent itself when it renders, else the nearest preceding visible chat
 * node — a suppressed transitional dispatch turn renders no node but its
 * subagents still stack in the companion column under the anchor, never at
 * (0,0)) or, for nested dispatches, their parent SubagentNode (#2762 ST-3).
 *
 * Returns the ChainSubagentNode entries (id `subagent-<corrId>`, parent key
 * `agent-<corrId>` / `subagent-<corrId>`, dispatch-index-ordered) ready for
 * BOTH computeSubagentChainPositions and computeCompanionExtents.
 */
function buildSubagentChainEntries(
  state: GraphBuilderState,
  chainPredecessor: Map<string, string>,
  visibleNonTransitional: Set<string>,
): ChainSubagentNode[] {
  const byParent = new Map<string, string[]>();
  for (const [corrId, entry] of state.subagentNodes) {
    const parentCorrId = entry.payload.parentCorrelationId;
    let parentKey: string | null = null;
    if (state.subagentNodes.has(parentCorrId)) {
      parentKey = `subagent-${parentCorrId}`;
    } else {
      const anchorCorrId = resolveChildAnchor(
        parentCorrId,
        chainPredecessor,
        visibleNonTransitional,
      );
      if (anchorCorrId) parentKey = `agent-${anchorCorrId}`;
    }
    if (parentKey) {
      const list = byParent.get(parentKey) ?? [];
      list.push(corrId);
      byParent.set(parentKey, list);
    }
  }
  const subagentChain: ChainSubagentNode[] = [];
  for (const [parentKey, corrIds] of byParent) {
    // Dispatch-ordered (by startTime) so the k-th dispatch takes the k-th
    // slot — arrival-order-independent like the tools association.
    corrIds.sort((a, b) => {
      const ea = state.subagentNodes.get(a)!;
      const eb = state.subagentNodes.get(b)!;
      return (
        (Date.parse(ea.payload.startTime ?? ea.timestamp) || 0) -
        (Date.parse(eb.payload.startTime ?? eb.timestamp) || 0)
      );
    });
    corrIds.forEach((corrId, index) => {
      subagentChain.push({ id: `subagent-${corrId}`, parentId: parentKey, index });
    });
  }
  return subagentChain;
}

/**
 * #2770 ST-3 (R-7): companion extents per chat node — the shared grouping
 * helper + the pure layout.ts extent walk, fed into ChainAgent.companionExtent
 * at BOTH chainAgents build sites so the height signature gates reflows on
 * card heights too.
 */
function computeSessionCompanionExtents(
  state: GraphBuilderState,
  chainPredecessor: Map<string, string>,
  visibleNonTransitional: Set<string>,
  measuredHeights: Map<string, number>,
): Map<string, number> {
  return computeCompanionExtents(
    buildSubagentChainEntries(state, chainPredecessor, visibleNonTransitional),
    measuredHeights,
  );
}

function applySubagentChainPositions(
  positions: Map<string, { x: number; y: number }>,
  state: GraphBuilderState,
  chainPositions: Map<string, { x: number; y: number }>,
  visibleNonTransitional: Set<string>,
  chainPredecessor: Map<string, string>,
): void {
  const subagentChain = buildSubagentChainEntries(state, chainPredecessor, visibleNonTransitional);
  const subagentPositions = computeSubagentChainPositions(subagentChain, chainPositions);
  for (const [nodeId, pos] of subagentPositions) {
    positions.set(nodeId, pos);
  }
}

// ── Graph builder state (internal, per-session) ──────────────────────────────

/** The full agent entry shape stored in GraphBuilderState (the narrow
 *  `{ payload, status }` views elsewhere are structural projections of it). */
type AgentNodeEntry = {
  payload: AgentNodePayload;
  status: GraphNodeStatus;
  timestamp: string;
  prevCorrId?: string;
};

/** A SubagentNode entry in the graph-builder state — keyed by the task
 *  dispatch's correlationId (one SubagentNode per user-requested subagent
 *  dispatch — #2745 R-1). Built by associateToolCalls from the collected task
 *  call; gated by the AC-4 internal-agent exclusion. */
interface SubagentNodeEntry {
  payload: SubagentNodePayload;
  status: GraphNodeStatus;
  timestamp: string;
  /** Deterministic payload signature — the no-loop contract (an unchanged
   *  signature keeps the same payload reference, so the node is never
   *  re-emitted/re-rendered — Spec #275/#523 pattern). */
  signature: string;
}

interface GraphBuilderState {
  agentNodes: Map<string, AgentNodeEntry>;
  /** #2739 ST-1: per-session tool-call summaries (tool correlationId → summary),
   *  collected from tool-use-lifecycle deliveries. The association pass resolves
   *  parents from these collected maps in the effect's Phase 3 — never by
   *  delivery arrival order (order-independence — restored SQLite and live
   *  deliveries interleave). #2764 ST-1: resolved non-task calls EMBED into the
   *  anchor chat node's payload.tools (the standalone ToolsNode was removed). */
  toolCallsBySession: Map<string, Map<string, ToolCallSummary>>;
  /** #2745 ST-4: SubagentNode entries keyed by the task dispatch correlationId
   *  (one SubagentNode per user-requested subagent dispatch). */
  subagentNodes: Map<string, SubagentNodeEntry>;
  /** #2762 ST-1 (R-1): per-CHILD-session non-task tool calls collected from
   *  subagent-tool-activity deliveries (childSessionId → corrId → summary).
   *  The nested association pass joins these to the owning SubagentNode via
   *  its payload.childSessionId — order-independently (R-8 orphans stay
   *  collected until the owner appears). */
  subagentToolCalls: Map<string, Map<string, ToolCallSummary>>;
  /** #2762 ST-1 (R-3): per-CHILD-session `task` calls (the child's OWN
   *  dispatches → nested SubagentNodes whose parent is the dispatching
   *  SubagentNode). Same shape + eviction bound as subagentToolCalls. */
  subagentDispatches: Map<string, Map<string, ToolCallSummary>>;
  /** #2762 fix round (R-3/R-7/R-8): child session ids whose owning task
   *  dispatch named an INTERNAL tool-execution agent (build/plan). Those
   *  dispatches create NO SubagentNode (R-3 guard), so their children are
   *  knowingly ownerless — they stay collected (R-8) but are EXEMPT from the
   *  `⚠ N unattributed` chip count, which otherwise surfaces on ordinary
   *  sessions whose internal build sessions happened to call `task`. */
  internalOrphanExempt: Set<string>;
  /** #2762 fix round (D4b, R-7): child session id → parent session id, recorded
   *  from the `parentSessionId` payload attribute the adapter propagates onto
   *  every child-session delivery (D4a). Feeds the SCOPED orphan count: only
   *  orphans whose recorded parent lies inside the selected session's subtree
   *  are counted — orphans with no recorded parent (injected fixtures) or a
   *  parent outside the subtree (other sessions' children) stay retained in
   *  the collectors (R-8 attach semantics unchanged) but never surface the
   *  `⚠ N unattributed` chip on the selected session. Same bounded-oldest-first
   *  eviction as the other collectors. */
  collectorParentByChildSession: Map<string, string>;
  nodeOrder: string[];
  agentOrder: string[];
  /** #2688 ST4: per-session previous chat-node correlationId (vertical chain link). */
  lastAgentBySession: Map<string, string>;
}

function createInitialGraphBuilderState(): GraphBuilderState {
  return {
    agentNodes: new Map(),
    toolCallsBySession: new Map(),
    subagentNodes: new Map(),
    subagentToolCalls: new Map(),
    subagentDispatches: new Map(),
    internalOrphanExempt: new Set(),
    collectorParentByChildSession: new Map(),
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
// time-window rule (D-2) and embeds non-task calls into the FINAL anchor's
// payload.tools (#2764 ST-1) — never by arrival order.

/** Resolve the tool name from a delivery payload — `gen_ai.tool.name` is the
 *  primary path, `tool_name` the legacy fallback (#2739 plan API contract 2).
 *  Extracted so the subagent-activity collector (#2762 ST-1) can route `task`
 *  calls without duplicating the resolution. */
function resolveToolName(p: Record<string, any>): string | undefined {
  if (typeof p['gen_ai.tool.name'] === 'string' && p['gen_ai.tool.name']) {
    return p['gen_ai.tool.name'];
  }
  if (typeof p['tool_name'] === 'string' && p['tool_name']) {
    return p['tool_name'];
  }
  return undefined;
}

/**
 * Pure merge of one tool-use delivery into a ToolCallSummary (#2739 ST-1).
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
function mergeToolCallSummary(
  existing: ToolCallSummary | undefined,
  p: Record<string, any>,
  corrId: string,
  fallbackTimestamp: string,
): ToolCallSummary {
  const toolName = resolveToolName(p) ?? existing?.toolName ?? 'unknown';

  const startTime =
    typeof p['startTime'] === 'string' && p['startTime']
      ? p['startTime']
      : (existing?.startTime ?? fallbackTimestamp);
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

  return merged;
}

/**
 * Collect a tool-use-lifecycle delivery into the per-session tool-call map
 * (#2739 ST-1 — the ROOT-session tool data path; association happens in
 * the effect's Phase 3 over the collected maps, so this is
 * arrival-order-independent).
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
  sessionCalls.set(corrId, mergeToolCallSummary(existing, p, corrId, delivery.timestamp));
}

/** #2762 N-3: cap a collector at 10,000 session entries, evicting the OLDEST
 *  groups first (Map insertion order). The same bounded-memory pattern as the
 *  ECE relationship registry (AGENTS.md / plan N-3). Works for both the nested
 *  call-collector maps (Map<string, Map<…>>) and the flat child→parent map
 *  (Map<string, string>) — the eviction is outer-map-only either way. */
function evictOldestCollector(map: Map<string, unknown>, max = 10_000): void {
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

/**
 * #2762 ST-1: collect a `subagent-tool-activity` delivery into the per-child-
 * session collectors. The routing R-2 guard (payload.is_subagent !== true →
 * ignore) has already run — everything reaching here belongs to a subagent
 * session. Split by tool name at collection time (the tool name rides EVERY
 * lifecycle event of the span):
 * - `task` calls → `subagentDispatches` (the child session's OWN dispatches →
 *   nested SubagentNodes, R-3).
 * - every other call → `subagentToolCalls` (the child's own tools → the
 *   embedded TOOLS accordion, R-1/D-1b).
 * Keyed by the CHILD session id so the association pass joins these maps to
 * the owning SubagentNode via its payload.childSessionId (order-independent —
 * R-8 orphans stay collected until the owner appears). The child id is read
 * from the OUTER delivery payload's `compositedChildSessionId` — the ECE
 * composites child tool deliveries under the PARENT composite key (Spec #523)
 * and injects the original child id there — falling back to the delivery's
 * own key sessionId for legacy child-keyed (non-composited) deliveries
 * (#2768 round 3).
 */
function upsertSubagentActivity(state: GraphBuilderState, delivery: ContractDelivery): void {
  const keySessionId = deliverySessionId(delivery);
  const corrId = deliveryCorrelationId(delivery);
  const p = extractDeliveryPayload(delivery) as Record<string, any>;

  // #2768 round 3: `compositedChildSessionId` is injected by the ECE into the
  // OUTER delivery payload (top level of `delivery.payload` — NOT the inner
  // payload `extractDeliveryPayload` unwraps). Present ⟺ the child session's
  // events were re-keyed under the parent composite key; `key.sessionId` is
  // then the PARENT, so the collectors must use the injected child id instead
  // (single extraction path per the contract-trust rule — no fallback chains).
  const rawCompositedChildSessionId = delivery.payload?.['compositedChildSessionId'];
  const compositedChildSessionId =
    typeof rawCompositedChildSessionId === 'string' && rawCompositedChildSessionId
      ? rawCompositedChildSessionId
      : undefined;
  const childSessionId = compositedChildSessionId ?? keySessionId;

  // #2762 fix round (D4b): record the child's parent session id (the adapter
  // propagates it onto every child payload — D4a) for the SCOPED orphan count.
  // Last-wins is safe: the parent of a given child session never changes.
  // Keyed by the CHILD id: on composited deliveries the inner payload's
  // `parentSessionId` is still the parent, so this is a true child→parent
  // edge (not the parent→parent self-map the pre-#2768 keying produced).
  const parentSessionId =
    typeof p['parentSessionId'] === 'string' && p['parentSessionId']
      ? p['parentSessionId']
      : undefined;
  if (parentSessionId) {
    state.collectorParentByChildSession.set(childSessionId, parentSessionId);
  }

  const isTask = (resolveToolName(p) ?? '') === 'task';
  const target = isTask ? state.subagentDispatches : state.subagentToolCalls;

  let sessionCalls = target.get(childSessionId);
  if (!sessionCalls) {
    sessionCalls = new Map();
    target.set(childSessionId, sessionCalls);
  }
  const existing = sessionCalls.get(corrId);
  sessionCalls.set(corrId, mergeToolCallSummary(existing, p, corrId, delivery.timestamp));
  evictOldestCollector(state.subagentToolCalls);
  evictOldestCollector(state.subagentDispatches);
  evictOldestCollector(state.collectorParentByChildSession);
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
 * completed turn — the SubagentNode flashes attached to it, then jumps
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
 *  SubagentNode payload is primitive-only, so JSON.stringify is a stable hash
 *  (#2745 ST-4). */
function toolsPayloadSignature(payload: SubagentNodePayload): string {
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
 * #2739 ST-1 / #2745 ST-4 / #2764 ST-1: associate collected tool calls with
 * their chat nodes.
 *
 * Runs over the collected per-session tool-call maps AFTER every processing
 * batch (never during per-delivery processing), so association is
 * ORDER-INDEPENDENT — restored SQLite and live deliveries interleave, and a
 * tool call that arrives before its chat node's init is resolved the moment
 * both are present. Two outcomes per resolved call group:
 *
 * - `task` dispatches (user-requested) lazily create one `subagent:<corrId>`
 *   SubagentNode per dispatch (R-1); the dispatch is the SubagentNode's SOLE
 *   representation (AC-3) — never an embedded tool item.
 * - Every other (non-task) call EMBEDS into its FINAL anchor chat node's
 *   `payload.tools` (#2764 ST-1 — the standalone ToolsNode was removed). The
 *   anchor is resolved by the SAME final-anchor emission gate the removed
 *   node used (resolveCompanionEmission: the parent itself when it renders,
 *   else its same-exchange reply) — held while the anchor is provisional, so
 *   a live tool call never flash-attaches to an earlier unrelated chat node.
 *   A user exchange makes MULTIPLE tool-calling dispatch turns before its
 *   reply, so groups resolving to the same anchor are MERGED (one embedded
 *   list per visible chat node) — and a task-only exchange embeds nothing.
 * Internal-agent dispatches create NO entry on either path (AC-4).
 *
 * The embed replaces the anchor's payload object ONLY on a content change:
 * the same ToolCallSummary references in the same deterministic order keep
 * the previous payload reference, so the incremental builder's Pass-2 deep
 * compare (keyed on the payload reference) never re-renders an unchanged
 * node (the Spec #275/#523 no-loop pattern). Stale re-parenting (a call that
 * re-resolves to a different anchor when its true dispatch turn arrives) is
 * reconciled by recomputing EVERY session agent that currently carries
 * `tools`: an anchor no longer expected to carry calls loses its stale list.
 *
 * Chat update/end lifecycle re-sets spread `{...existing.payload,
 * ...newPayload}` where makeAgentNodePayload never sets `tools`, so the
 * embedded key survives lifecycle re-sets (regression invariant).
 *
 * @param chainPredecessor / visibleNonTransitional — the visible-anchor
 *   resolution (buildVisibleAnchors) the emission gate consumes.
 * @returns The set of entry ids created or changed this pass — `agent:<corrId>`
 *   for anchors whose embedded tools changed, `subagent:<corrId>` for
 *   SubagentNode entries (the incremental builder re-emits those).
 */
function associateToolCalls(
  state: GraphBuilderState,
  chainPredecessor: Map<string, string>,
  visibleNonTransitional: Set<string>,
): Set<string> {
  const touched = new Set<string>();

  for (const [sessionId, calls] of state.toolCallsBySession) {
    if (calls.size === 0) continue;

    // This session's chat nodes (corrId → entry) — the parent candidates.
    const sessionAgents = new Map<string, AgentNodeEntry>();
    for (const [corrId, entry] of state.agentNodes) {
      if (entry.payload.sessionId === sessionId) sessionAgents.set(corrId, entry);
    }
    if (sessionAgents.size === 0) continue;

    // Resolve each call to its parent chat node (time-window rule) and group.
    const callsByParent = new Map<string, ToolCallSummary[]>();
    for (const call of calls.values()) {
      const parentCorrId = resolveParentChatNode(call, sessionAgents);
      if (!parentCorrId) continue; // no eligible parent — no embedded tools (R-5)
      const list = callsByParent.get(parentCorrId);
      if (list) list.push(call);
      else callsByParent.set(parentCorrId, [call]);
    }

    // Non-task calls accumulated per RESOLVED FINAL anchor (multiple dispatch
    // turns of one exchange share the anchor — merged, never stacked).
    const nonTaskByAnchor = new Map<string, ToolCallSummary[]>();

    for (const [parentCorrId, callsOfParent] of callsByParent) {
      const parentEntry = sessionAgents.get(parentCorrId)!;
      // Arrival-ordered by startTime (one accordion item per call).
      callsOfParent.sort(
        (a, b) => (Date.parse(a.startTime ?? '') || 0) - (Date.parse(b.startTime ?? '') || 0),
      );

      // #2745 ST-4 (R-3 / A-4): split `task` dispatches out of the tool list.
      // A `task` call represents a whole delegated session — it is
      // represented SOLELY by its SubagentNode (AC-3), never as a tool
      // accordion item, and never double-rendered.
      const taskCalls = callsOfParent.filter((c) => c.toolName === 'task');
      const nonTaskCalls = callsOfParent.filter((c) => c.toolName !== 'task');

      // ── SubagentNode path (R-1 / AC-1, gated by R-4 / AC-4) ──
      for (const taskCall of taskCalls) {
        const parsed = parseTaskArgs(taskCall.input);
        const name = parsed.subagent_type ?? parsed.agent ?? 'Subagent';
        // AC-4: internal opencode tool-execution agents (build/plan) create NO
        // SubagentNode AND no embedded tool item — their dispatches are not
        // user-requested subagents. #2762 fix round (D4b-4): the skipped
        // dispatch's child session is EXEMPT from the orphan count — knowingly
        // ownerless, mirroring the nested path (R-7 flat parity).
        if (INTERNAL_TOOL_EXECUTION_AGENTS.includes(name)) {
          if (taskCall.childSessionId) state.internalOrphanExempt.add(taskCall.childSessionId);
          continue;
        }

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

      // ── Embedded-tools path (#2764 ST-1): fold the non-task calls into the
      // FINAL anchor's payload.tools. Held while the anchor is PROVISIONAL
      // (the dispatch turn's same-exchange reply has not rendered) — the SAME
      // emission gate the removed ToolsNode used (no flash-attach; a task-only
      // exchange embeds nothing — A-4).
      if (nonTaskCalls.length === 0) continue;
      const { emit, anchorCorrId } = resolveCompanionEmission(
        parentCorrId, false, chainPredecessor, visibleNonTransitional, state.agentNodes,
      );
      if (!emit || !anchorCorrId) continue;
      const anchorList = nonTaskByAnchor.get(anchorCorrId);
      if (anchorList) anchorList.push(...nonTaskCalls);
      else nonTaskByAnchor.set(anchorCorrId, [...nonTaskCalls]);
    }

    // ── Embed reconciliation (#2764 ST-1) ──
    // Every session agent that carries (or is expected to carry) embedded
    // tools is recomputed from the CURRENT grouping: an anchor gaining calls
    // gets them (merged, deterministically ordered); an anchor whose calls
    // re-parented elsewhere (or whose anchor is no longer final) loses its
    // stale list. The payload object is replaced ONLY on a content change —
    // the same ToolCallSummary references in the same deterministic order keep
    // the previous payload reference (Spec #275/#523 no-loop pattern).
    for (const [anchorCorrId, entry] of sessionAgents) {
      const expected = nonTaskByAnchor.get(anchorCorrId);
      const current = entry.payload.tools;
      if (!expected || expected.length === 0) {
        if (!current) continue; // nothing embedded, nothing expected — FR-3: no key, ever
        const rest: AgentNodePayload = { ...entry.payload };
        delete rest.tools;
        state.agentNodes.set(anchorCorrId, { ...entry, payload: rest });
        touched.add(`agent:${anchorCorrId}`);
        continue;
      }
      // Deterministic startTime order (ties by correlationId) — the same sort
      // the removed merged ToolsNode list used, so item order is stable.
      const sorted = [...expected].sort(byStartTimeThenCorrId);
      if (
        current &&
        current.length === sorted.length &&
        current.every((c, i) => c === sorted[i])
      ) continue; // same references, same order — keep the payload reference
      const updatedPayload: AgentNodePayload = { ...entry.payload, tools: sorted };
      state.agentNodes.set(anchorCorrId, { ...entry, payload: updatedPayload });
      touched.add(`agent:${anchorCorrId}`);
    }
  }

  return touched;
}

/** Deterministic startTime sort for aggregated tool-call arrays (ties broken by
 *  correlationId so the order — and therefore the JSON payload signature — is
 *  fully deterministic across passes; an unstable order would flip the payload
 *  signature every pass and re-render the node forever). */
function byStartTimeThenCorrId(a: ToolCallSummary, b: ToolCallSummary): number {
  const ta = Date.parse(a.startTime ?? '') || 0;
  const tb = Date.parse(b.startTime ?? '') || 0;
  if (ta !== tb) return ta - tb;
  return a.correlationId < b.correlationId ? -1 : a.correlationId > b.correlationId ? 1 : 0;
}

/**
 * Depth of a SubagentNode in the delegation tree (root dispatch = 1, nested =
 * parent + 1). Recursive with a memo + in-stack cycle guard (R-6): a link
 * cycle yields −1 (the chain is never depth-stamped and never emitted).
 */
function subagentTreeDepth(
  corrId: string,
  state: GraphBuilderState,
  memo: Map<string, number>,
  inStack: Set<string>,
): number {
  const memoed = memo.get(corrId);
  if (memoed !== undefined) return memoed;
  if (inStack.has(corrId)) return -1; // cycle — R-6 guard
  const entry = state.subagentNodes.get(corrId);
  if (!entry) return -1;
  inStack.add(corrId);
  let depth: number;
  if (!state.subagentNodes.has(entry.payload.parentCorrelationId)) {
    depth = 1; // parent is a chat node (or missing) → root dispatch
  } else {
    const parentDepth = subagentTreeDepth(entry.payload.parentCorrelationId, state, memo, inStack);
    depth = parentDepth < 0 ? -1 : parentDepth + 1;
  }
  inStack.delete(corrId);
  if (depth >= 0) memo.set(corrId, depth);
  return depth;
}

/**
 * #2762 ST-2: nested association + recursive builder over the
 * subagent-tool-activity collectors.
 *
 * For every SubagentNode whose payload.childSessionId has collected activity:
 * - (R-1) the child session's NON-task calls aggregate into the node payload's
 *   `tools` array (the embedded TOOLS accordion, D-1b) — never attached to a
 *   root chat node.
 * - (R-3) the child session's own `task` calls create ONE nested SubagentNode
 *   per user-requested dispatch (INTERNAL_TOOL_EXECUTION_AGENTS filtered at
 *   every depth), keyed by the child task corrId, whose parentCorrelationId is
 *   the DISPATCHING SubagentNode's corrId. The nested payload's `sessionId`
 *   stays the ROOT (selected) session so the session-scoped emission gates
 *   keep working — the dispatch physically happened in the child session, but
 *   visibility is root-scoped.
 * - (R-4) recursion is a fixpoint loop: entries created by one pass become
 *   owners on the next, so any depth attaches. Termination is idempotent — a
 *   pass with no signature change ends the loop; re-creating an existing
 *   nested entry with an identical payload signature touches nothing, so a
 *   link cycle (R-6) converges instead of looping.
 * - (R-8) orphans: collected childSessionIds matching no SubagentNode stay in
 *   the collectors untouched and attach the moment the owner appears
 *   (order-independent — the pass re-runs over the FULL maps every batch).
 * - (R-10) the aggregated summaries are the same ToolCallSummary objects the
  *   root chat node — outcome/duration rules are shared by construction.
 *
 * Depth stamping: when a session's max delegation depth ≥ 2, every SubagentNode
 * of that session is stamped with `depth` + `sessionMaxDepth` (the D-1c depth
 * chip inputs). Depth-1-only sessions are NEVER stamped — their payload
 * signatures stay byte-identical to today (R-7).
 *
 * @param selectedSessionId The selected root session id — scopes the orphan
 *   count (D4b, R-7): only orphans whose recorded parent lies inside the
 *   selected session's delegation subtree are counted (QA-5 flat parity —
 *   driver/other-session noise never surfaces the chip).
 * @returns The touched `subagent:<corrId>` entry ids plus the count of
 *   unattributed collected calls (childSessionId matching no SubagentNode —
 *   the D-6 `⚠ N unattributed` figure; suppressed from the canvas, R-8).
 */
function associateSubagentActivity(
  state: GraphBuilderState,
  selectedSessionId: string,
): { touched: Set<string>; unattributedCount: number } {
  const touched = new Set<string>();

  if (state.subagentToolCalls.size === 0 && state.subagentDispatches.size === 0) {
    return { touched, unattributedCount: 0 };
  }

  // ── Fixpoint association ──
  // Entries created during a pass are visited by the SAME for-loop (JS Map
  // iteration picks up additions) and by later passes; the loop ends on the
  // first pass with no change. Cycles converge: re-applying an owner's
  // activity to an already-correct nested entry is a signature no-op.
  let changed = true;
  let passGuard = 0; // belt-and-suspenders bound (idempotency already terminates)
  while (changed && passGuard < 64) {
    changed = false;
    passGuard++;
    for (const [corrId, entry] of [...state.subagentNodes]) {
      const childSessionId = entry.payload.childSessionId;
      // No childSessionId yet — the child's session id may arrive with the
      // end delivery; SKIP WITHOUT marking done so a later batch re-processes.
      if (!childSessionId) continue;

      // (a) R-1: the child's own non-task tool calls → embedded tools array.
      const ownCalls = state.subagentToolCalls.get(childSessionId);
      const tools =
        ownCalls && ownCalls.size > 0
          ? [...ownCalls.values()].sort(byStartTimeThenCorrId)
          : undefined;

      // (b) R-3: the child's own task dispatches → nested SubagentNodes.
      const ownDispatches = state.subagentDispatches.get(childSessionId);
      let nestedCount = 0;
      if (ownDispatches) {
        for (const taskCall of ownDispatches.values()) {
          const parsed = parseTaskArgs(taskCall.input);
          const name = parsed.subagent_type ?? parsed.agent ?? 'Subagent';
          // Internal opencode tool-execution agents (build/plan) create NO
          // nested SubagentNode at ANY depth (R-3 guard; AGENTS.md
          // subagent-agent-name filter — the OTLP path has no adapter-level
          // whitelist, this is the only guard). Fix round: the skipped
          // dispatch's child session is EXEMPT from the orphan count — it is
          // knowingly ownerless, and counting it surfaced the `⚠ N
          // unattributed` chip on ordinary sessions (R-7/D-7 invariant 5).
          if (INTERNAL_TOOL_EXECUTION_AGENTS.includes(name)) {
            if (taskCall.childSessionId) state.internalOrphanExempt.add(taskCall.childSessionId);
            continue;
          }
          nestedCount++;

          const payload = makeSubagentNodePayload(taskCall, corrId, entry.payload.sessionId);
          const signature = toolsPayloadSignature(payload);
          const existingNested = state.subagentNodes.get(taskCall.correlationId);
          if (!existingNested) {
            state.subagentNodes.set(taskCall.correlationId, {
              payload,
              status: entry.status,
              timestamp: taskCall.endTime ?? taskCall.startTime ?? '',
              signature,
            });
            const entryId = `subagent:${taskCall.correlationId}`;
            if (!state.nodeOrder.includes(entryId)) state.nodeOrder.push(entryId);
            touched.add(entryId);
            changed = true;
          } else if (signature !== existingNested.signature || existingNested.status !== entry.status) {
            existingNested.payload = payload;
            existingNested.status = entry.status;
            existingNested.signature = signature;
            touched.add(`subagent:${taskCall.correlationId}`);
            changed = true;
          }
        }
      }

      // (c) Stamp the owner's own payload with tools + nestedCount. Only a
      // signature CHANGE mutates (deterministic payload signatures — the same
      // reference is kept otherwise, so the incremental builder never
      // re-emits/re-renders an unchanged node, Spec #275/#523 pattern).
      if (!tools && nestedCount === 0) continue;
      const updated: SubagentNodePayload = { ...entry.payload };
      if (tools) updated.tools = tools;
      if (nestedCount > 0) updated.nestedCount = nestedCount;
      const signature = toolsPayloadSignature(updated);
      if (signature !== entry.signature) {
        entry.payload = updated;
        entry.signature = signature;
        touched.add(`subagent:${corrId}`);
        changed = true;
      }
    }
  }

  // ── Depth stamping (D-1c/D-3) ──
  // Compute every node's delegation depth + the per-session max; stamp ONLY
  // sessions whose max depth ≥ 2 (a depth-1-only session keeps today's exact
  // payload signature — R-7 flat parity).
  const memo = new Map<string, number>();
  const maxDepthBySession = new Map<string, number>();
  for (const [corrId, entry] of state.subagentNodes) {
    const depth = subagentTreeDepth(corrId, state, memo, new Set());
    if (depth < 0) continue; // cyclic chain — never stamped, never emitted
    const prevMax = maxDepthBySession.get(entry.payload.sessionId) ?? 0;
    if (depth > prevMax) maxDepthBySession.set(entry.payload.sessionId, depth);
  }
  for (const [corrId, entry] of state.subagentNodes) {
    const maxDepth = maxDepthBySession.get(entry.payload.sessionId);
    if (maxDepth === undefined || maxDepth < 2) continue;
    const depth = subagentTreeDepth(corrId, state, memo, new Set());
    if (depth < 0) continue;
    if (entry.payload.depth === depth && entry.payload.sessionMaxDepth === maxDepth) continue;
    const updated: SubagentNodePayload = { ...entry.payload, depth, sessionMaxDepth: maxDepth };
    entry.payload = updated;
    entry.signature = toolsPayloadSignature(updated);
    touched.add(`subagent:${corrId}`);
  }

  // ── R-8 orphan count (D-6), SCOPED to the selected session's subtree (D4b) ──
  // Rebuild the childSessionId → owner index over the CURRENT entry set (the
  // fixpoint may have added nested owners), then count every collected call
  // whose childSessionId still matches no SubagentNode. Orphans stay in the
  // collectors (they attach if the owner appears later) but are never rendered
  // as nodes — counted here for the `⚠ N unattributed` chip.
  //
  // Scope (D4b, R-7): compute the selected session's delegation subtree S and
  // count ONLY orphans whose RECORDED parent (collectorParentByChildSession —
  // the adapter-propagated `parentSessionId`, D4a) lies in S. Orphans with NO
  // recorded parent (injected fixtures) or a parent OUTSIDE S (other sessions'
  // children arriving via the all-deliveries feed) are retained exactly as
  // today but NOT counted — the unscoped global count surfaced `⚠ N
  // unattributed` on flat sessions (QA-5 noise class).
  const subtreeSessions = new Set<string>([selectedSessionId]);
  let subtreeGrew = true;
  let subtreePassGuard = 0; // converges — both expansion rules are monotone
  while (subtreeGrew && subtreePassGuard < 64) {
    subtreeGrew = false;
    subtreePassGuard++;
    // (i) a SubagentNode dispatched by a session in S contributes its child.
    for (const entry of state.subagentNodes.values()) {
      const cs = entry.payload.childSessionId;
      if (cs && subtreeSessions.has(entry.payload.sessionId) && !subtreeSessions.has(cs)) {
        subtreeSessions.add(cs);
        subtreeGrew = true;
      }
    }
    // (ii) a recorded child→parent edge with the parent in S contributes the child.
    for (const [child, parent] of state.collectorParentByChildSession) {
      if (subtreeSessions.has(parent) && !subtreeSessions.has(child)) {
        subtreeSessions.add(child);
        subtreeGrew = true;
      }
    }
  }
  const ownerByChildSession = new Map<string, string>();
  for (const [corrId, entry] of state.subagentNodes) {
    const cs = entry.payload.childSessionId;
    if (cs && !ownerByChildSession.has(cs)) ownerByChildSession.set(cs, corrId);
  }
  let unattributedCount = 0;
  for (const [childSessionId, calls] of state.subagentToolCalls) {
    // Internal-dispatch children (build/plan) are knowingly ownerless —
    // retained in the collector (R-8) but exempt from the chip figure.
    if (state.internalOrphanExempt.has(childSessionId)) continue;
    if (ownerByChildSession.has(childSessionId)) continue;
    const recordedParent = state.collectorParentByChildSession.get(childSessionId);
    if (recordedParent === undefined || !subtreeSessions.has(recordedParent)) continue;
    unattributedCount += calls.size;
  }
  for (const [childSessionId, dispatches] of state.subagentDispatches) {
    if (state.internalOrphanExempt.has(childSessionId)) continue;
    if (ownerByChildSession.has(childSessionId)) continue;
    const recordedParent = state.collectorParentByChildSession.get(childSessionId);
    if (recordedParent === undefined || !subtreeSessions.has(recordedParent)) continue;
    unattributedCount += dispatches.size;
  }

  return { touched, unattributedCount };
}

/**
 * #2762 ST-3: emission resolution for a SubagentNode whose parent is ITSELF a
 * SubagentNode (nested). The node emits only when the ROOT of its parent chain
 * passes the chat-node companion emission gate (the same final-anchor rule as
 * root subagents), walking up with a visited set — a link cycle (R-6) never
 * emits. Root subagents (parent is a chat node) never enter here.
 */
function resolveNestedSubagentRootEmit(
  corrId: string,
  state: GraphBuilderState,
  chainPredecessor: Map<string, string>,
  visibleNonTransitional: Set<string>,
  sessionId: string,
): boolean {
  const visited = new Set<string>([corrId]);
  let entry = state.subagentNodes.get(corrId);
  while (entry) {
    const parentCorrId = entry.payload.parentCorrelationId;
    if (visited.has(parentCorrId)) return false; // cycle — R-6 guard
    visited.add(parentCorrId);
    const parentEntry = state.subagentNodes.get(parentCorrId);
    if (parentEntry) {
      entry = parentEntry;
      continue;
    }
    // Root of the nested chain — the chat-node gate decides for the whole chain.
    const parentAgent = state.agentNodes.get(parentCorrId);
    const parentExists = parentAgent ? parentAgent.payload.sessionId === sessionId : false;
    return resolveCompanionEmission(
      parentCorrId, parentExists, chainPredecessor, visibleNonTransitional, state.agentNodes,
    ).emit;
  }
  return false;
}

/**
 * Process a single ContractDelivery through the graph builder.
 * Routes deliveries by contractName to the appropriate handler:
 * - chat-node → AgentNode lifecycle
 * - tool-use-lifecycle → tool-call summary collection (upsertToolCallSummary;
 *   the embed into the anchor chat node's payload.tools happens in the
 *   effect's Phase 3 association)
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
    // copy-on-write pattern as the agentNodes entry objects below).
    toolCallsBySession: new Map(state.toolCallsBySession),
    subagentNodes: new Map(state.subagentNodes),
    // #2762 ST-1: the child-activity collectors — same shallow-clone pattern.
    subagentToolCalls: new Map(state.subagentToolCalls),
    subagentDispatches: new Map(state.subagentDispatches),
    // #2762 fix round: the internal-orphan exemption set — same copy-on-write.
    internalOrphanExempt: new Set(state.internalOrphanExempt),
    // #2762 fix round (D4b): child→parent session map — same copy-on-write.
    collectorParentByChildSession: new Map(state.collectorParentByChildSession),
    nodeOrder: [...state.nodeOrder],
    agentOrder: [...state.agentOrder],
    lastAgentBySession: new Map(state.lastAgentBySession),
  };

  const contractName = delivery.contractName;

  // #2739 ST-1: tool-use-lifecycle — collect the per-session tool-call summary
  // (the tool data path; association/embedding happens in the effect's Phase 3
  // over the collected maps, so this is arrival-order-independent). The
  // chat-node branches below are FROZEN (#593/#586/#2700/#2717/#2723).
  if (contractName === 'tool-use-lifecycle') {
    upsertToolCallSummary(next, delivery);
    return next;
  }

  // #2762 ST-1 (R-2): subagent-tool-activity — collect CHILD-session tool
  // activity. R-2 GUARD: the engine cannot express "deliver ONLY subagent
  // events" (an absent payload path never matches equals:false), so
  // primary-session tool spans arrive under this contract too — they are
  // dropped here and root tool rendering stays byte-identical via
  // tool-use-lifecycle.
  if (contractName === 'subagent-tool-activity') {
    const p = extractDeliveryPayload(delivery) as Record<string, any>;
    if (p.is_subagent !== true) return next;
    upsertSubagentActivity(next, delivery);
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
}

/**
 * useDeliveryGraph — builds ReactFlow graph from ContractDelivery[].
 *
 * @param deliveries - All deliveries (filtered by sessionId internally)
 * @param sessionId - The selected session ID (null = no selection)
 * @returns nodes, edges, onNodesChange, onEdgesChange
 */
export function useDeliveryGraph({ deliveries, sessionId }: UseDeliveryGraphOptions) {
  const [layoutVersion, setLayoutVersion] = useState(0);
  const builderStateRef = useRef<GraphBuilderState>(createInitialGraphBuilderState());
  const lastSessionRef = useRef<string | null>(null);
  // AC-7: Cache layout positions to prevent jitter on re-render
  const layoutPositionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
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
  // #2723 ST4: monotonic epoch bumped when an agent node's measured height
  // actually changes — re-runs the processing effect so the chain re-stacks.
  // Never derived from array .length / newly-created object refs (the
  // Spec #275/#523 no-re-render-loop pattern).
  const [heightReflowEpoch, setHeightReflowEpoch] = useState(0);
  // #2762 ST-3 (D-6): count of collected child-session calls whose
  // childSessionId matches no SubagentNode — the `⚠ N unattributed`
  // SessionTokenBar chip figure (0/absent → chip hidden, flat parity). Updated
  // only inside the processing effect; a same-value setState bails out.
  const [unattributedCount, setUnattributedCount] = useState(0);
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
      // #2762 ST-3: a session reset drops the nested graph AND its orphan count.
      setUnattributedCount(0);
      setNodes([]);
      setEdges([]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);



  // Process ALL deliveries through the graph builder, not just the selected session.
  // Output filtering in Phase 3/4 then shows only the selected session's
  // AgentNodes.
  //
  // Spec #2768 (ST-5): this is also the HYDRATED-REPLAY entry — mount-time
  // contract hydration (useSessionHistory → hydrateContractEvents) injects
  // persisted backend-store rows into StreamContext via `addDelivery` in seq
  // order under their ORIGINAL delivery ids, so hydrated deliveries arrive
  // through this exact same path as live ones. No replay-specific handling is
  // needed or added: the id watermark below processes each delivery exactly
  // once (StreamContext id-dedupe already no-ops rows the feature holds), the
  // per-session collectors + Phase-3 association passes are arrival-order-
  // independent, and a session switch replays the current array into a fresh
  // builder state — the same replay semantics the frontend-restore path
  // already exercises (R9: no duplicate nodes; R2/R4: full-history + no-gap).
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
    // #2770 ST-3 (R-7/R-8): companion extents join the pending signature so a
    // MEASURED SUBAGENT height change (no new deliveries) is also detected
    // here. The pre-batch builder state + anchors mirror the post-batch site
    // below; when unprocessed is empty the two states are identical, so the
    // pending extents equal the last-applied ones except for the height change
    // that bumped the reflow epoch.
    const pendingVisibleCorrs = new Set<string>();
    for (const [corrId, entry] of builderStateRef.current.agentNodes) {
      if (entry.payload.sessionId === sessionId) pendingVisibleCorrs.add(corrId);
    }
    const pendingAnchors = buildVisibleAnchors(
      chronologicalAgentOrder(
        builderStateRef.current.agentOrder,
        builderStateRef.current.agentNodes,
      ),
      builderStateRef.current.agentNodes,
      pendingVisibleCorrs,
    );
    const pendingExtents = computeSessionCompanionExtents(
      builderStateRef.current,
      pendingAnchors.chainPredecessor,
      pendingAnchors.visibleNonTransitional,
      measuredHeightsRef.current,
    );
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
          companionExtent: pendingExtents.get(nodeId),
        });
      }
    }
    const pendingHeightSignature = pendingChainAgents
      .map(a => `${a.id}:${a.height ?? ''}:${a.companionExtent ?? ''}`)
      .sort()
      .join(',');

    if (unprocessed.length === 0 && pendingHeightSignature === lastHeightsRef.current) return;

    for (const d of unprocessed) {
      const corrId = deliveryCorrelationId(d);
      touchedCorrIds.add(corrId);
      state = processDelivery(state, d);
    }
    builderStateRef.current = state;

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
    // anchor (SubagentNode edges + layout/companion columns re-anchor to the
    // nearest preceding visible node). Chronological order — never the
    // merged-delivery arrival order — keeps the chain oldest→newest top→bottom
    // (arrival order can be reversed when live TTL-shrunk deliveries are merged
    // before restored ones).
    //
    // #2764 ST-1: computed BEFORE the association pass — associateToolCalls
    // embeds resolved non-task calls into the FINAL anchor's payload.tools via
    // the same visible-anchor resolution the emission gates use.
    const { chainPredecessor, visibleNonTransitional } = buildVisibleAnchors(
      chronologicalAgentOrder(state.agentOrder, state.agentNodes),
      state.agentNodes,
      visibleAgentCorrs,
    );

    // ── #2739 ST-1 / #2745 ST-4 / #2764 ST-1: associate collected tool calls
    // with their chat nodes ──
    // Order-independent Phase-3 pass over the collected maps: non-task calls
    // EMBED into the anchor chat node's payload.tools (agent nodes are
    // re-emitted via the returned `agent:<corrId>` ids) and `task` dispatches
    // create `subagent:<corrId>` SubagentNode entries, so the NEW-entry
    // computation below picks up any newly created companion nodes. The
    // returned ids are re-emitted as CHANGED when the association changed them.
    const touchedEntryIds = associateToolCalls(state, chainPredecessor, visibleNonTransitional);

    // ── #2762 ST-2: nested association over the child-activity collectors ──
    // Runs after the root pass (nested entries may hang off subagent nodes
    // created this batch). Its touched ids re-enter the affected set the same
    // way; the orphan count feeds the D-6 `⚠ N unattributed` chip and is
    // SCOPED to the selected session's subtree (D4b).
    const nested = associateSubagentActivity(state, sessionId);
    for (const entryId of nested.touched) touchedEntryIds.add(entryId);
    // setState with the same number bails out (Object.is) — no re-render loop;
    // a change re-renders once and the effect deps do not include it.
    setUnattributedCount(nested.unattributedCount);

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
      // #2739 ST-1 / #2745 ST-4 / #2764 ST-1: an entry rebuilt by the
      // association pass (an anchor whose embedded tools changed, a new
      // subagent dispatch, changed child figures) is re-emitted.
      if ((prefix === 'agent' || prefix === 'subagent') && touchedEntryIds.has(entryId)) {
        changedEntryIds.add(entryId);
        continue;
      }
    }

    const affectedEntryIds = new Set([...newEntryIds, ...changedEntryIds]);

    // UX (flash fix): a HELD companion node (a SubagentNode whose anchor is
    // still provisional — its dispatch turn's same-exchange reply has not
    // rendered yet) must be RE-EVALUATED every batch, not just when its own
    // correlationId is touched: its emission depends on the visible-anchor
    // resolution (buildVisibleAnchors), which changes when the REPLY chat node
    // (`_7`) arrives — a chat-node delivery touches the reply's corrId, never
    // the companion's. Always include every companion entry in the affected set
    // so Phase 3 re-runs the final-anchor gate each batch; Phase 5 Pass 2's
    // deep compare keeps already-emitted unchanged nodes from re-rendering.
    // (#2764 ST-1: embedded tools re-enter via the `agent:` touched ids — the
    // anchor IS the visible chat node, so no held-tools state exists.)
    for (const entryId of state.nodeOrder) {
      const colonIdx = entryId.indexOf(':');
      if (colonIdx < 0) continue;
      const prefix = entryId.slice(0, colonIdx);
      if (prefix === 'subagent') affectedEntryIds.add(entryId);
    }

    // ── Phase 3: Build ReactFlow nodes only for affected entries (REQ-5) ──
    const nodeList: Node<MonitorNodeData>[] = [];

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
      } else if (prefix === 'subagent') {
        // #2745 ST-4 (R-1): a SubagentNode is shown only when its PARENT chat
        // node is visible in the selected session (companion-column rule).
        // One SubagentNode per user-requested dispatch.
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
        // #2762 ST-3 (R-3/R-4): a NESTED SubagentNode (parent is itself a
        // SubagentNode) emits when the ROOT of its parent chain passes the
        // chat-node companion gate — visited-set guarded (R-6 cycles never
        // emit). Its edge (Phase 4) sources from its DIRECT parent SubagentNode.
        if (entry && state.subagentNodes.has(parentCorrId)) {
          if (resolveNestedSubagentRootEmit(
            corrId, state, chainPredecessor, visibleNonTransitional, sessionId,
          )) {
            nodeList.push(makeReactFlowNode(
              `subagent-${corrId}`, 'subagent', entry.status, entry.payload, entry.timestamp,
              `Subagent · ${entry.payload.name}`,
            ));
          }
          continue;
        }
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
          // #2762 ST-3: a NESTED subagent's layout edge sources from its DIRECT
          // parent SubagentNode (the BFS propagates depth ≥ 2 and the structure
          // signature includes the nested chain — a deeper dispatch recomputes
          // the layout).
          if (state.subagentNodes.has(entry.payload.parentCorrelationId)) {
            const parentId = `subagent-${entry.payload.parentCorrelationId}`;
            const subagentId = `subagent-${corrId}`;
            if (allNodeTypes.has(parentId) && allNodeTypes.has(subagentId)) {
              allLayoutEdges.push({ source: parentId, target: subagentId });
            }
            continue;
          }
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
      // #2745 ST-4: subagent-… maps to the subagent entry. (#2764 ST-1: the
      // standalone `tools-` node family no longer exists.)
      const entryId = nodeId.startsWith('subagent-') ? `subagent:${nodeId.slice(9)}`
        : nodeId.startsWith('agent-') ? `agent:${nodeId.slice(6)}`
        : nodeId;
      const eci = entryId.indexOf(':');
      let status: MonitorNodeStatus = 'inactive';
      if (eci >= 0) {
        const prefix = entryId.slice(0, eci);
        const corrId = entryId.slice(eci + 1);
        const entry = prefix === 'agent' ? state.agentNodes.get(corrId)
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
    // #2770 ST-3 (R-7): companion extents per chat node — the max vertical
    // span of each node's subagent-companion subtree (the SAME grouping the
    // placement pass uses, via buildSubagentChainEntries). Fed into
    // chainAgents so the pitch reserves tall companion cards, and into the
    // height signature so a measured card-height change reflows the chain.
    const subagentExtents = computeSessionCompanionExtents(
      state,
      chainPredecessor,
      visibleNonTransitional,
      measuredHeightsRef.current,
    );
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
          companionExtent: subagentExtents.get(nodeId),
        });
      }
    }
    const structureSignature = layoutNodes.map(n => n.id).sort().join(',') + '|' +
      allLayoutEdges.map(e => `${e.source}>${e.target}`).sort().join(',');
    const heightSignature = chainAgents
      .map(a => `${a.id}:${a.height ?? ''}:${a.companionExtent ?? ''}`)
      .sort()
      .join(',');
    const structureChanged = structureSignature !== lastGraphRef.current;
    const heightsChanged = heightSignature !== lastHeightsRef.current;

    // ── Chain layout — the ONLY mode (#2760 removed the Force engine) ──
    if (structureChanged || layoutPositionsRef.current.size === 0) {
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

      // #2745 ST-4 (A-5) / #2766 ST-2: place each SubagentNode in its own
      // companion column RIGHT of the chat chain (x = SUBAGENT_CHAIN_X, y =
      // parent y). Chain-owned — never touched by force/residue. (#2766 ST-2:
      // the column was mirrored from LEFT to RIGHT to fill the slot #2764
      // ST-1 freed when the standalone ToolsNode was removed.)
      applySubagentChainPositions(positions, state, chainPositions, visibleNonTransitional, chainPredecessor);

      // #2723 ST4 belt-and-suspenders: rectangular de-overlap for any
      // non-agent residue the d3 collision radii may still leave overlapping.
      // Widths mirror the forceCollide radii; heights default to 2× the radius
      // for legacy residue and use the measured height when ReactFlow has one.
      // #2745 ST-4: subagent nodes are chain-owned — excluded from this pass
      // (all live types are chain-owned, so the pass is inert; kept for the
      // frozen residue geometry).
      const residueRects: RectNode[] = [];
      for (const n of layoutNodes) {
        if (n.type === 'agent' || n.type === 'subagent') continue;
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
      // #2745 ST-4 (A-5): re-place the subagent slots on the same reflow so the
      // subagent stacks track their parents' y.
      applySubagentChainPositions(positions, state, chainPositions, visibleNonTransitional, chainPredecessor);
      layoutPositionsRef.current = positions;
      lastHeightsRef.current = heightSignature;
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
    // (`_6`) arrives, a subagent entry whose suppressed dispatch parent
    // (`_5`) re-anchors to the new reply moves (the layout re-anchors fresh),
    // but its existing edge would keep the OLD source forever (append-only
    // edges never re-source). Building the full set each batch lets Phase 6
    // REPLACE edges whose source/target changed.
    const edgeList: Edge[] = [];

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
      } else if (prefix === 'subagent') {
        // #2745 ST-4 (R-1) / #2766 ST-2 (R6): the subagent edge — parent
        // (source-right) → its SubagentNode (target-left): subagents sit
        // RIGHT of the chat chain (makeSubagentReactFlowEdge). One edge per
        // dispatched subagent. #2750 AC4: the source is the parent's
        // RESOLVED anchor.
        // UX: gate on the SAME final-anchor emission as the node — a held
        // SubagentNode (provisional anchor) gets no dangling edge.
        const entry = state.subagentNodes.get(corrId);
        if (entry) {
          const parentCorrId = entry.payload.parentCorrelationId;
          // #2762 ST-3 (R-3/R-4) / #2766 ST-2: the NESTED edge family —
          // parent SubagentNode (`source-right`, its own handle) → child
          // SubagentNode (`target-left`), reusing the `calls` edge style
          // (D-2: all subagent-dispatch edges stay solid accent-subagent).
          // Gated by the SAME root emission as the node (held nodes get no
          // dangling edge).
          if (state.subagentNodes.has(parentCorrId)) {
            if (resolveNestedSubagentRootEmit(
              corrId, state, chainPredecessor, visibleNonTransitional, sessionId,
            )) {
              edgeList.push(makeSubagentReactFlowEdge(
                `e-calls-${corrId}`,
                `subagent-${parentCorrId}`,
                `subagent-${corrId}`,
              ));
            }
            continue;
          }
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
            // #2745 ST-4: a SubagentNode survives while its builder entry does
            // (its parent-visibility gate runs in Phase-3 emission; the session
            // reset drops all entries on session change). Session-scoped: a
            // foreign session's subagent entry (parent chat node in a different
            // session) must never be preserved — mirrors the Phase-3 emission
            // gate so a leaked node can't linger across renders.
            // #2764 ST-1: the standalone `tools-` node family no longer exists
            // — a legacy `tools-` id is never preserved.
            isVisible = id.startsWith('subagent-')
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
                // #2762 ST-3: NESTED subagents resolve emission through their
                // parent chain (visited-guarded) instead of the chat-node gate
                // — a nested node survives exactly while its root chain emits.
                if (state.subagentNodes.has(saEntry.payload.parentCorrelationId)) {
                  isVisible = resolveNestedSubagentRootEmit(
                    id.slice(9), state, chainPredecessor, visibleNonTransitional, sessionId,
                  );
                } else {
                  const parentEntry = state.agentNodes.get(saEntry.payload.parentCorrelationId);
                  const parentExists = parentEntry
                    ? parentEntry.payload.sessionId === sessionId
                    : false;
                  isVisible = resolveCompanionEmission(
                    saEntry.payload.parentCorrelationId, parentExists,
                    chainPredecessor, visibleNonTransitional, state.agentNodes,
                  ).emit;
                }
              } else {
                isVisible = false;
              }
            }
          }
          if (isVisible) {
            // #2688 ST10: Re-position preserved nodes when the chain reflows.
            // computeChatChainPositions / applySubagentChainPositions recompute
            // positions for ALL nodes on graph-signature change (see the
            // recompute block above) and on height-only reflows, but only the
            // current batch's affected set lands in nodeList. An existing node
            // whose correlationId was not re-touched this batch is preserved
            // here with its OLD rendered position — so under incremental
            // arrivals (one message per export, the live Run CLI pattern) it
            // would stay put while the newest node is placed at the chain top,
            // overlapping it. Re-emit the cached position when it differs.
            // This applies to EVERY node type: agent nodes (original ST10) AND
            // the chain-owned subagent column — a measured-height reflow moves
            // a parent chat node's y, and its SubagentNode slots must track it
            // or they stay stranded at the unmeasured fallback position. The
            // equality check suppresses no-op re-emits (same pattern as the
            // Pass-2 deep compare); each preserved node is an O(1) map lookup,
            // keeping the incremental builder O(N) — NFR-1.
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
  }, [sessionDeliveries, sessionId, heightReflowEpoch]);

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
  // can stack by measured height. When an AGENT or SUBAGENT node's height
  // actually changes, bump heightReflowEpoch → the processing effect re-runs
  // and the chain re-stacks (height-aware layout signature — #2770 ST-3 R-8:
  // subagent card heights feed the companion extent, so they must reflow the
  // chain too). The prev-compare makes same-height re-measures no-ops, so
  // there is no re-render loop (Spec #275/#523 pattern — the Spec #275 guard,
  // setLayoutVersion only when layout actually changes, is handled by the
  // processing effect: it only runs when sessionDeliveries or
  // heightReflowEpoch changes, not on every dimension change).
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    rawOnNodesChange(changes);
    // #2723 ST4 (R-4): record last measured node heights. Only bump the
    // reflow epoch when a chain-geometry node's height ACTUALLY changed —
    // identical re-measures (the same node re-rendering at the same size)
    // must not trigger a chain reflow (Spec #275/#523 no-loop pattern).
    // #2770 ST-3 (R-8): `subagent-` cards join `agent-` nodes as chain-
    // geometry nodes.
    let chainHeightChanged = false;
    for (const change of changes) {
      if (change.type !== 'dimensions' || !change.dimensions) continue;
      const nodeId = change.id;
      const h = change.dimensions.height;
      if (typeof h !== 'number' || h <= 0) continue;
      const prev = measuredHeightsRef.current.get(nodeId);
      measuredHeightsRef.current.set(nodeId, h);
      if (
        (nodeId.startsWith('agent-') || nodeId.startsWith('subagent-')) &&
        prev !== h
      ) {
        chainHeightChanged = true;
      }
    }
    if (chainHeightChanged) {
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
    // #2762 ST-3 (D-6): collected child-session calls whose childSessionId
    // matched no SubagentNode — suppressed from the canvas, counted here for
    // the SessionTokenBar `⚠ N unattributed` chip (0 → chip hidden).
    unattributedCount,
  };
}
