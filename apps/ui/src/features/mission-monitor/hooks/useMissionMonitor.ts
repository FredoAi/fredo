import { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import { useNodesState, useEdgesState } from 'reactflow';
import type { Node, Edge, NodeChange } from 'reactflow';
import type { ChatRow, ToolUseRow } from '../../../shared/classes/EventSubscription';
import type { UseEventRowsResult } from '../../../shared/hooks/useEventRows';
import {
  type GraphNodeStatus,
  type GraphNodeType,
  type GraphEdgeType,
  type AgentNodePayload,
  type SubagentNodePayload,
  type ToolCallSummary,
} from '../lib/graph';
import {
  deriveRowGraphState,
  type AgentNodeEntry,
  type GraphBuilderState,
  type SubagentNodeEntry,
} from '../lib/rowDerivation';
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
// - Args ride in the row's `toolInputJson` (the ingest-projected
//   gen_ai.tool.call.arguments JSON string); `toolOutputJson` =
//   gen_ai.tool.call.result = the child's final output.

/** #2745 R-4 (AC-4): internal opencode tool-execution agents. Their `task`
 *  dispatches are spawned internally to execute tool calls in sub-sessions and
 *  are NOT user-requested @-subagent dispatches — they create NO SubagentNode
 *  AND no embedded tool item (#2764: the former ToolsNode item). `build` is
 *  live-confirmed (ST-1 Phase-0); `plan` is plan-specified (unconfirmed until
 *  a run triggers it). Keyed on the SAME parsed name field the node displays
 *  (`subagent_type`). */
export const INTERNAL_TOOL_EXECUTION_AGENTS = ['build', 'plan'];

/** Parse the task tool's arguments JSON (`toolInputJson` = the ingest-
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
  // (`"\n\n"`) before the tool call, which the ingest pipeline injects verbatim —
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
 * chain + anchors MUST be driven by this order, never by `agentOrder`:
 * `agentOrder` stays the canonical builder insertion order (chronological —
 * the row derivation inserts in span-start order) for node-order bookkeeping;
 * this sorted view is used only where chronology matters (chain positions,
 * chain predecessors, subagent/tools anchor chain).
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
  // the ingest pipeline copies the user message into BOTH the
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
 * resolution. A live tool row often lands BEFORE its dispatch turn
 * (the tool span ends before the dispatch chat span closes) and before the
 * dispatch's same-exchange reply — so on early row batches the time-window
 * parent resolution and the anchor resolution are both PROVISIONAL, and the
 * node would appear attached to an EARLIER unrelated chat node (the "first
 * Chatnode"), then JUMP to the reply when it renders. The node is emitted only
 * when its anchor is FINAL:
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

// ── Node/edge factories ──────────────────────────────────────────────────────

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

// ── Association passes ───────────────────────────────────────────────────────

/**
 * #2739 D-2: time-window parent resolution — the chat node of the same session
 * with the GREATEST `startTime` strictly < the tool call's `startTime`.
 * Order-independent by construction: it scans the derived chat-node map, never
 * row arrival order. NEVER uses correlationId (the per-span counter
 * interleaves chat/tool ids) and NEVER span parentage (live-verified: all tool
 * spans' parent is the session span).
 *
 * UX (flash fix): span-containment guard — a candidate parent must be a
 * chat node that was still OPEN when the tool call began (endTime missing = turn
 * still open = still a valid candidate; a turn that COMPLETED before the tool
 * started cannot have made the call). A live tool row often lands BEFORE
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
  sessionAgents: Map<string, AgentNodeEntry>,
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
 * child's final output (toolOutputJson = gen_ai.tool.call.result); the
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
 * Runs over the derived per-session tool-call maps in the effect (after the
 * visible-anchor resolution), so association is ORDER-INDEPENDENT — rows are
 * a keyed store, and a tool row that lands before its chat row's insert is
 * resolved the moment both are present. Two outcomes per resolved call group:
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
 * the previous payload reference, so the builder's deep compare (keyed on
 * the payload reference) never re-renders an unchanged node (the
 * Spec #275/#523 no-loop pattern). Stale re-parenting (a call that
 * re-resolves to a different anchor when its true dispatch turn arrives) is
 * reconciled by recomputing EVERY session agent that currently carries
 * `tools`: an anchor no longer expected to carry calls loses its stale list.
 *
 * @returns The set of entry ids created or changed this pass — `agent:<corrId>`
 *   for anchors whose embedded tools changed, `subagent:<corrId>` for
 *   SubagentNode entries.
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
 * child-activity collectors.
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
 *   (order-independent — the pass re-runs over the FULL maps every pass).
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
      // No childSessionId yet — the child's completion fields may arrive in a
      // later patch; SKIP WITHOUT marking done so the next recompute
      // re-processes.
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
          // subagent-agent-name filter — the ingest classifier enforces the
          // same exclusion on relationship registration; this is the render-
          // side guard). Fix round: the skipped dispatch's child session is
          // EXEMPT from the orphan count — it is knowingly ownerless, and
          // counting it surfaced the `⚠ N unattributed` chip on ordinary
          // sessions (R-7/D-7 invariant 5).
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
      // reference is kept otherwise, so the builder never re-emits/re-renders
      // an unchanged node, Spec #275/#523 pattern).
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
  // the typed attribution map) lies in S. Orphans with NO recorded parent
  // (injected fixtures) or a parent OUTSIDE S (other sessions' children)
  // are retained exactly as today but NOT counted — the unscoped global count
  // surfaced `⚠ N unattributed` on flat sessions (QA-5 noise class).
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

// ── Hook ─────────────────────────────────────────────────────────────────────

/** The typed-row sources the graph derives from (P4.2). Production wires the
 *  panel-level `useEventRows('Chat' | 'ToolUse', { replay: true })` results;
 *  tests inject fixture row stores through the same seam. */
export interface RowGraphSources {
  chat: UseEventRowsResult<ChatRow>;
  toolUse: UseEventRowsResult<ToolUseRow>;
}

interface UseDeliveryGraphOptions {
  sessionId: string | null;
  rows: RowGraphSources;
}

/**
 * useDeliveryGraph — builds the ReactFlow graph from typed RTDB rows.
 *
 * Spec #2788 P4.2: the v1 ContractDelivery collectors / lifecycle handling /
 * id watermarks are GONE — the row derivation (`lib/rowDerivation.ts`)
 * produces the full builder state in one deterministic pass, memoized on the
 * row store's monotonic `epoch` primitives (never on map identity or size —
 * the #523-cycle-1 no-loop rule). The association + emission + layout passes
 * below are unchanged graph logic, now re-sourced from rows.
 *
 * @param sessionId - The selected session ID (null = no selection).
 * @param rows      - The chat + toolUse row sources (see RowGraphSources).
 * @returns nodes, edges, onNodesChange, onEdgesChange, unattributedCount
 */
export function useDeliveryGraph({ sessionId, rows }: UseDeliveryGraphOptions) {
  const [nodes, setNodes, rawOnNodesChange] = useNodesState<MonitorNodeData>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

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
  // The builder state last processed by the effect — distinguishes a
  // height-only reflow run (same rows) from a real data change.
  const lastProcessedStateRef = useRef<GraphBuilderState | null>(null);

  // ── Row-derived builder state (the P4.2 data path) ──
  // Full deterministic recompute per row-store mutation. The row maps are the
  // LIVE module-scoped store (stable identity, mutated in place), so the memo
  // keys on the monotonic per-eventType epochs — primitives that advance ONLY
  // on real mutation (useEventRows contract). `[...map.values()]` snapshots
  // the current rows for the pure derivation.
  const chatEpoch = rows.chat.epoch;
  const toolEpoch = rows.toolUse.epoch;
  const builderState = useMemo(
    () =>
      deriveRowGraphState(
        [...rows.chat.rows.values()] as ChatRow[],
        [...rows.toolUse.rows.values()] as ToolUseRow[],
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chatEpoch, toolEpoch],
  );

  // Reset per-session graph state when the session changes.
  useEffect(() => {
    if (lastSessionRef.current !== sessionId) {
      lastSessionRef.current = sessionId;
      layoutPositionsRef.current = new Map();
      lastGraphRef.current = '';
      lastHeightsRef.current = '';
      lastProcessedStateRef.current = null;
      // #2762 ST-3: a session reset drops the nested graph AND its orphan count.
      setUnattributedCount(0);
      setNodes([]);
      setEdges([]);
    }
  }, [sessionId]);

  // ── Derive the ReactFlow graph (FULL recompute per state change) ──
  useEffect(() => {
    if (!sessionId) return;

    const state = builderState;

    // #2723 ST4 (R-4): a measured-height change must reflow the chain even
    // when no rows changed. ReactFlow reports rendered node sizes via
    // 'dimensions' changes (handled in onNodesChange below), which bump
    // heightReflowEpoch and re-run this effect. When the builder state is
    // UNCHANGED and the chain-height signature is unchanged, the run is a
    // no-op.
    const pendingChainAgents: ChainAgent[] = [];
    // #2770 ST-3 (R-7/R-8): companion extents join the pending signature so a
    // MEASURED SUBAGENT height change (no new rows) is also detected here.
    const pendingVisibleCorrs = new Set<string>();
    for (const [corrId, entry] of state.agentNodes) {
      if (entry.payload.sessionId === sessionId) pendingVisibleCorrs.add(corrId);
    }
    const pendingAnchors = buildVisibleAnchors(
      chronologicalAgentOrder(state.agentOrder, state.agentNodes),
      state.agentNodes,
      pendingVisibleCorrs,
    );
    const pendingExtents = computeSessionCompanionExtents(
      state,
      pendingAnchors.chainPredecessor,
      pendingAnchors.visibleNonTransitional,
      measuredHeightsRef.current,
    );
    for (const corrId of chronologicalAgentOrder(state.agentOrder, state.agentNodes)) {
      const entry = state.agentNodes.get(corrId);
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

    const stateUnchanged = lastProcessedStateRef.current === state;
    if (stateUnchanged && pendingHeightSignature === lastHeightsRef.current) return;
    lastProcessedStateRef.current = state;

    // ── Session-scoped node filtering ──
    // The row derivation includes EVERY session's chat nodes (nested
    // association needs them); the output is scoped to the selected session.
    const visibleAgentCorrs = new Set<string>();
    for (const [corrId, entry] of state.agentNodes) {
      if (entry.payload.sessionId === sessionId) {
        visibleAgentCorrs.add(corrId);
      }
    }

    // #2750 AC4 (ST-5): resolve the visible (non-suppressed) anchors — one O(N)
    // pass over the session's agents in CHRONOLOGICAL (startTime) order (NFR-2).
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
    const associateTouched = associateToolCalls(state, chainPredecessor, visibleNonTransitional);

    // ── #2762 ST-2: nested association over the child-activity collectors ──
    // The orphan count feeds the D-6 `⚠ N unattributed` chip and is SCOPED to
    // the selected session's subtree (D4b).
    const nested = associateSubagentActivity(state, sessionId);
    for (const entryId of nested.touched) associateTouched.add(entryId);
    // setState with the same number bails out (Object.is) — no re-render loop;
    // a change re-renders once and the effect deps do not include it.
    setUnattributedCount(nested.unattributedCount);

    // ── Phase 3: Build ReactFlow nodes for ALL visible entries (full
    // recompute — the desired node set IS the truth) ──
    const nodeList: Node<MonitorNodeData>[] = [];

    for (const entryId of state.nodeOrder) {
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
        // user-requested dispatch still emits its SubagentNode (NFR-5). The
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
        // builder map (all sessions' chat nodes), so a bare
        // `.has(parentCorrelationId)` would return TRUE for a subagent whose
        // parent chat node lives in a DIFFERENT session. Scope the round-6
        // belt-and-suspenders fallback to THIS session.
        const parentEntry = entry
          ? state.agentNodes.get(parentCorrId)
          : undefined;
        const parentExists = parentEntry
          ? parentEntry.payload.sessionId === sessionId
          : false;
        // UX: emit only when the anchor is FINAL. A task dispatch often
        // lands before its dispatch turn's same-exchange reply renders, so on
        // early row batches the anchor is PROVISIONAL (an earlier unrelated
        // chat node) — emitting there makes the node flash-attach to the
        // "first Chatnode" and then jump to the reply. Hold the node until
        // the anchor settles (the reply arrives), or the round-6 anchorless
        // belt fires.
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
    const allNodeDepths = new Map<string, number>();
    const allNodeTypes = new Map<string, string>();
    const allLayoutEdges: { source: string; target: string }[] = [];

    for (const entryId of state.nodeOrder) {
      const colonIdx = entryId.indexOf(':');
      if (colonIdx < 0) continue;
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

    // Build layout edges from ALL state (ReactFlow edges second-pass rule —
    // nodes first, edges after, referencing the complete node set).
    for (const entryId of state.nodeOrder) {
      const colonIdx = entryId.indexOf(':');
      if (colonIdx < 0) continue;
      const prefix = entryId.slice(0, colonIdx);
      const corrId = entryId.slice(colonIdx + 1);
      if (prefix === 'subagent') {
        // #2745 ST-4: the subagent edge in the layout graph (parent chat node →
        // its SubagentNode) so the BFS depth + structure signature include it.
        // #2750 AC4: the edge source is the parent's RESOLVED anchor (the
        // nearest preceding visible node when the dispatch turn is suppressed),
        // mirroring the rendered e-calls edge.
        const entry = state.subagentNodes.get(corrId);
        if (entry) {
          // #2762 ST-3: a NESTED subagent's layout edge sources from its DIRECT
          // parent SubagentNode.
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
    const chainAgents: ChainAgent[] = [];
    // #2770 ST-3 (R-7): companion extents per chat node — the max vertical
    // span of each node's subagent-companion subtree (the SAME grouping the
    // placement pass uses, via buildSubagentChainEntries).
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
      const { positions } = computeForceLayout(
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
      // #2723 ST4 (R-4): the chain stacks by MEASURED height. Unmeasured
      // fresh nodes fall back to the conservative DEFAULT_NODE_HEIGHT until
      // ReactFlow reports their size.
      const chainPositions = computeChatChainPositions(chainAgents);
      for (const [nodeId, pos] of chainPositions) {
        positions.set(nodeId, pos);
      }

      // #2745 ST-4 (A-5) / #2766 ST-2: place each SubagentNode in its own
      // companion column RIGHT of the chat chain. Chain-owned — never touched
      // by force/residue.
      applySubagentChainPositions(positions, state, chainPositions, visibleNonTransitional, chainPredecessor);

      // #2723 ST4 belt-and-suspenders: rectangular de-overlap for any
      // non-agent residue the d3 collision radii may still leave overlapping.
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
    // The desired set is built over ALL visible companion entries each pass —
    // an anchor can re-resolve WITHOUT the entry's own rows changing (the
    // same-exchange reply arriving re-anchors a held subagent), so Phase 6
    // REPLACEs edges whose source/target changed. Edges SECOND (nodes first —
    // AGENTS.md ReactFlow rule).
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
        // (source-right) → its SubagentNode (target-left). One edge per
        // dispatched subagent. #2750 AC4: the source is the parent's
        // RESOLVED anchor. UX: gate on the SAME final-anchor emission as the
        // node — a held SubagentNode (provisional anchor) gets no dangling edge.
        const entry = state.subagentNodes.get(corrId);
        if (entry) {
          const parentCorrId = entry.payload.parentCorrelationId;
          // #2762 ST-3 (R-3/R-4) / #2766 ST-2: the NESTED edge family —
          // parent SubagentNode (`source-right`, its own handle) → child
          // SubagentNode (`target-left`), reusing the `calls` edge style.
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

    // ── Phase 5: Functional setNodes — the desired node set IS the truth ──
    // Keep unchanged node OBJECTS (same payload/status/position reference —
    // ReactFlow does not re-render them), replace changed ones (preserving
    // ReactFlow's measured width/height), append new ones, drop nodes absent
    // from the desired set (suppressed/re-anchored/removed rows).
    setNodes((currentNodes) => {
      const desiredById = new Map(nodeList.map(n => [n.id, n]));
      const merged: Node<MonitorNodeData>[] = [];
      let changed = false;

      // Pass 1: reconcile existing nodes (preserve order).
      for (const existing of currentNodes) {
        const desired = desiredById.get(existing.id);
        if (!desired) {
          changed = true; // no longer visible (suppressed/re-anchored/removed)
          continue;
        }
        const posChanged = existing.position.x !== desired.position.x ||
          existing.position.y !== desired.position.y;
        const statusChanged = existing.data.status !== desired.data.status;
        const payloadChanged = existing.data.payload !== desired.data.payload;
        const labelChanged = existing.data.label !== desired.data.label;
        const timestampChanged = existing.data.timestamp !== desired.data.timestamp;
        if (posChanged || statusChanged || payloadChanged || labelChanged || timestampChanged) {
          merged.push({
            ...desired,
            width: desired.width ?? existing.width,
            height: desired.height ?? existing.height,
          });
          changed = true;
        } else {
          merged.push(existing);
        }
      }
      // Pass 2: append desired nodes not yet present (in derivation order).
      const existingIds = new Set(currentNodes.map(n => n.id));
      for (const node of nodeList) {
        if (!existingIds.has(node.id)) {
          merged.push(node);
          changed = true;
        }
      }

      return changed ? merged : currentNodes;
    });

    // ── Phase 6: Edge reconciliation (REQ-6 + re-anchor safety) ──
    // The desired edge set is built in Phase 4 over every nodeOrder entry each
    // pass. Reconciliation: keeps unchanged edges (same object reference),
    // REPLACES re-anchored edges (same id, new source/target/handles), drops
    // stale edges, adds new edges. The desired set IS the truth.
    setEdges((currentEdges) => {
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
  }, [builderState, sessionId, heightReflowEpoch]);

  // Stable ref for edges — prevents onNodesChange from depending on edges
  const edgesRef = useRef(edges);
  edgesRef.current = edges;

  // ── Layout (REQ-6/7) ────────────────────────────────────────────────────────
  // Layout is computed in the processing useEffect above. onNodesChange is
  // a pass-through for ReactFlow state plus a #2723 ST4 (R-4) dimension
  // interceptor: ReactFlow reports rendered node sizes via 'dimensions'
  // changes, which we record as the last measured heights so the chat chain
  // can stack by measured height. When an AGENT or SUBAGENT node's height
  // actually changes, bump heightReflowEpoch → the processing effect re-runs
  // and the chain re-stacks (height-aware layout signature — #2770 ST-3 R-8:
  // subagent card heights feed the companion extent, so they must reflow the
  // chain too). The prev-compare makes same-height re-measures no-ops, so
  // there is no re-render loop (Spec #275/#523 pattern).
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
    layoutVersion: 0,
    // Selected-session row count — the chat rows keyed under the session
    // (the graph's primary data). The v1 figure counted raw deliveries
    // (duplicated across contracts); the row store's PK guarantees one row
    // per (session, correlationId).
    eventCount: sessionId
      ? [...rows.chat.rows.values()].filter((r) => r.sessionId === sessionId).length
      : 0,
    // #2762 ST-3 (D-6): collected child-session calls whose childSessionId
    // matched no SubagentNode — suppressed from the canvas, counted here for
    // the SessionTokenBar `⚠ N unattributed` chip (0 → chip hidden).
    unattributedCount,
  };
}

// Re-export for consumers still referencing the narrow entry views (the hook's
// association helpers operate on the structural projections).
export type { AgentNodeEntry, SubagentNodeEntry, GraphBuilderState };
