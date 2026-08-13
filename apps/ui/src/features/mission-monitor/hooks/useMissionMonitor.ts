import { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import { useNodesState, useEdgesState } from 'reactflow';
import type { Node, Edge, NodeChange } from 'reactflow';
import type { ContractDelivery } from '../../../shared/classes/EventSubscription';
import {
  extractDeliveryPayload,
  deliverySessionId,
  deliveryCorrelationId,
  normalizeTokenCount,
  type GraphNodeStatus,
  type GraphNodeType,
  type GraphEdgeType,
  type AgentNodePayload,
  type ToolNodePayload,
  type FileNodePayload,
} from '../lib/graph';
import { graphStatusToMonitorStatus, GRAPH_NODE_TYPE_MAP } from '../types';
import type { MonitorNodeData, MonitorNodeStatus } from '../types';
import { computeForceLayout, computeChatChainPositions, type ChainAgent } from '../lib/layout';

// ── Edge style definitions ────────────────────────────────────────────────────

const EDGE_STYLES: Record<GraphEdgeType, React.CSSProperties> = {
  parent:  { stroke: '#6366f1', strokeWidth: 1.5 },
  calls:   { stroke: '#a855f7', strokeWidth: 1.5 },
  reads:   { stroke: '#334155', strokeDasharray: '2,4', strokeWidth: 1 },
  writes:  { stroke: '#334155', strokeDasharray: '2,4', strokeWidth: 1 },
  // #2688: dashed indigo — visually distinct from 'parent' (solid indigo) and
  // 'calls' (solid purple) so the per-session chat chain reads as one thread.
  chat:    { stroke: '#6366f1', strokeDasharray: '4,4', strokeWidth: 1.5 },
};

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

// ── Graph builder state (internal, per-session) ──────────────────────────────

interface GraphBuilderState {
  agentNodes: Map<string, { payload: AgentNodePayload; status: GraphNodeStatus; timestamp: string; prevCorrId?: string }>;
  toolNodes: Map<string, { payload: ToolNodePayload; status: GraphNodeStatus; timestamp: string }>;
  fileNodes: Map<string, { payload: FileNodePayload; status: GraphNodeStatus; timestamp: string }>;
  nodeOrder: string[];
  agentOrder: string[];
  /** #2688 ST4: per-session previous chat-node correlationId (vertical chain link). */
  lastAgentBySession: Map<string, string>;
}

function createInitialGraphBuilderState(): GraphBuilderState {
  return {
    agentNodes: new Map(),
    toolNodes: new Map(),
    fileNodes: new Map(),
    nodeOrder: [],
    agentOrder: [],
    lastAgentBySession: new Map(),
  };
}

/**
 * Process a single ContractDelivery through the graph builder.
 * Routes deliveries by contractName to the appropriate handler:
 * - chat-node → AgentNode lifecycle
 * - tool-use-lifecycle → ToolNode lifecycle + FileNode extraction
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
    toolNodes: new Map(state.toolNodes),
    fileNodes: new Map(state.fileNodes),
    nodeOrder: [...state.nodeOrder],
    agentOrder: [...state.agentOrder],
    lastAgentBySession: new Map(state.lastAgentBySession),
  };

  const contractName = delivery.contractName;

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

      // #593: tool-use-lifecycle contract still deactivated.
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
  // #593: tool-use-lifecycle contract still deactivated.

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
      graphProcessedIdsRef.current.clear();
      sessionDeliveriesCacheRef.current = [];
      sessionDeliveriesFilteredRef.current = 0;
      sessionDeliveriesProcessedIdsRef.current.clear();
      setNodes([]);
      setEdges([]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);



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

    let state = builderStateRef.current;

    // ── Phase 1: Incremental processDelivery with change tracking ──
    // REQ-5: Track which nodeOrder indices were affected by this batch.
    const prevNodeOrderLength = state.nodeOrder.length;
    // Track delivery correlationIds that touch existing nodes
    const touchedCorrIds = new Set<string>();
    // Track agent end lifecycles that also complete child tool nodes
    const agentEndCorrs = new Set<string>();

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
    if (unprocessed.length === 0) return;

    for (const d of unprocessed) {
      const corrId = deliveryCorrelationId(d);
      touchedCorrIds.add(corrId);
      if (d.contractName === 'chat-node' && d.lifecycle === 'end') {
        agentEndCorrs.add(corrId);
      }
      state = processDelivery(state, d);
    }
    builderStateRef.current = state;

    // ── Phase 2: Determine which entry IDs are affected ──
    // NEW entries: appended to nodeOrder since last batch
    const newEntryIds = new Set(state.nodeOrder.slice(prevNodeOrderLength));

    // CHANGED entries: existing entries whose correlationId was touched by
    // the current batch's deliveries (status/payload updates).
    // Also include child tool nodes completed by agent end lifecycle.
    const changedEntryIds = new Set<string>();
    for (const entryId of state.nodeOrder) {
      if (newEntryIds.has(entryId)) continue;
      const colonIdx = entryId.indexOf(':');
      if (colonIdx < 0) continue; // file/legacy entries — no status delivery targets them
      const prefix = entryId.slice(0, colonIdx);
      const corrId = entryId.slice(colonIdx + 1);
      if (touchedCorrIds.has(corrId)) {
        changedEntryIds.add(entryId);
        continue;
      }
      // Agent end lifecycle marks child tool nodes as complete
      if (agentEndCorrs.size > 0 && prefix === 'tool') {
        const entry = state.toolNodes.get(corrId);
        if (entry && agentEndCorrs.has(entry.payload.parentCorrelationId)) {
          changedEntryIds.add(entryId);
        }
      }
    }

    const affectedEntryIds = new Set([...newEntryIds, ...changedEntryIds]);

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

    // ── Phase 3: Build ReactFlow nodes only for affected entries (REQ-5) ──
    const nodeList: Node<MonitorNodeData>[] = [];

    for (const entryId of affectedEntryIds) {
      const colonIdx = entryId.indexOf(':');
      if (colonIdx < 0) {
        // Raw ID — file nodes or legacy entries (backward compat)
        if (state.fileNodes.has(entryId)) {
          const entry = state.fileNodes.get(entryId)!;
          nodeList.push(makeReactFlowNode(
            entryId, 'file', entry.status, entry.payload, entry.timestamp,
            `File: ${entry.payload.filePath.split('/').pop() ?? entry.payload.filePath}`,
          ));
        }
        continue;
      }

      const prefix = entryId.slice(0, colonIdx);
      const corrId = entryId.slice(colonIdx + 1);

      if (prefix === 'agent') {
        // Only show agent nodes from the selected session
        if (state.agentNodes.has(corrId) && visibleAgentCorrs.has(corrId)) {
          const entry = state.agentNodes.get(corrId)!;
          const label = makeAgentNodeLabel(entry.payload);
          nodeList.push(makeReactFlowNode(
            `agent-${corrId}`, 'agent', entry.status, entry.payload, entry.timestamp, label,
          ));
        }
      } else if (prefix === 'tool') {
        if (state.toolNodes.has(corrId)) {
          const entry = state.toolNodes.get(corrId)!;
          nodeList.push(makeReactFlowNode(
            `tool-${corrId}`, 'tool', entry.status, entry.payload, entry.timestamp,
            `Tool · ${entry.payload.toolName}`,
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
      let nodeId: string;
      let nodeType: string;
      if (colonIdx < 0) {
        nodeId = entryId;
        nodeType = 'file';
      } else {
        const prefix = entryId.slice(0, colonIdx);
        const corrId = entryId.slice(colonIdx + 1);
        if (prefix === 'agent') { nodeId = `agent-${corrId}`; nodeType = 'agent'; }
        else if (prefix === 'tool') { nodeId = `tool-${corrId}`; nodeType = 'tool'; }
        else { nodeId = entryId; nodeType = 'file'; }
      }
      allNodeTypes.set(nodeId, nodeType);
      if (nodeType === 'agent') {
        allNodeDepths.set(nodeId, 0);
      }
    }

    // Build layout edges from ALL state
    for (const entryId of state.nodeOrder) {
      const colonIdx = entryId.indexOf(':');
      if (colonIdx < 0) {
        if (state.fileNodes.has(entryId)) {
          const entry = state.fileNodes.get(entryId)!;
          const parentToolId = `tool-${entry.payload.parentToolId}`;
          if (allNodeTypes.has(parentToolId) && allNodeTypes.has(entryId)) {
            allLayoutEdges.push({ source: parentToolId, target: entryId });
          }
        }
        continue;
      }
      const prefix = entryId.slice(0, colonIdx);
      const corrId = entryId.slice(colonIdx + 1);
      if (prefix === 'tool') {
        const entry = state.toolNodes.get(corrId);
        if (entry) {
          const parentId = entry.payload.parentCorrelationId ? `agent-${entry.payload.parentCorrelationId}` : '';
          const toolId = `tool-${corrId}`;
          if (parentId && allNodeTypes.has(parentId) && allNodeTypes.has(toolId)) {
            allLayoutEdges.push({ source: parentId, target: toolId });
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
      const entryId = nodeId.startsWith('agent-') ? `agent:${nodeId.slice(6)}`
        : nodeId.startsWith('tool-') ? `tool:${nodeId.slice(5)}`
        : nodeId;
      const eci = entryId.indexOf(':');
      let status: MonitorNodeStatus = 'inactive';
      if (eci >= 0) {
        const prefix = entryId.slice(0, eci);
        const corrId = entryId.slice(eci + 1);
        const entry = prefix === 'agent' ? state.agentNodes.get(corrId)
          : prefix === 'tool' ? state.toolNodes.get(corrId)
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

    // AC-6: Only recompute layout when graph structure changes
    const graphSignature = layoutNodes.map(n => n.id).sort().join(',') + '|' +
      allLayoutEdges.map(e => `${e.source}>${e.target}`).sort().join(',');
    const needsRecompute = graphSignature !== lastGraphRef.current;

    if (needsRecompute || layoutPositionsRef.current.size === 0) {
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
      // Non-agent nodes keep their force layout result. The chain uses
      // agentOrder (global arrival order) grouped by session, so each session
      // is an independent chain.
      const chainAgents: ChainAgent[] = [];
      for (const corrId of state.agentOrder) {
        const entry = state.agentNodes.get(corrId);
        if (entry) {
          chainAgents.push({ id: `agent-${corrId}`, sessionId: entry.payload.sessionId });
        }
      }
      const chainPositions = computeChatChainPositions(chainAgents);
      for (const [nodeId, pos] of chainPositions) {
        positions.set(nodeId, pos);
      }

      layoutPositionsRef.current = positions;
      lastGraphRef.current = graphSignature;
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

    // ── Phase 4: Build edges only for NEW entries (REQ-6) ──
    // Existing edges are preserved by the functional setEdges updater.
    // Edges for existing changed nodes don't change (parent-child topology
    // is established at node creation and is immutable).
    const edgeList: Edge[] = [];

    // Helper: build a single chat-chain edge for a new agent node, linking
    // it to the previous chat node of its session (prev → next vertical chain).
    const buildChatEdge = (corrId: string) => {
      const entry = state.agentNodes.get(corrId);
      if (!entry || !entry.prevCorrId) return;
      const prevId = `agent-${entry.prevCorrId}`;
      const curId = `agent-${corrId}`;
      if (
        state.agentNodes.has(entry.prevCorrId) &&
        visibleAgentCorrs.has(entry.prevCorrId) &&
        visibleAgentCorrs.has(corrId)
      ) {
        edgeList.push(makeReactFlowEdge(
          `e-chat-${entry.prevCorrId}-${corrId}`,
          prevId,
          curId,
          'chat',
        ));
      }
    };

    for (const entryId of newEntryIds) {
      const colonIdx = entryId.indexOf(':');
      if (colonIdx < 0) {
        // File nodes — create edges to parent tool
        if (state.fileNodes.has(entryId)) {
          const entry = state.fileNodes.get(entryId)!;
          const edgeType: GraphEdgeType = entry.payload.operation === 'write' ? 'writes' : 'reads';
          const parentToolId = `tool-${entry.payload.parentToolId}`;
          if (state.toolNodes.has(entry.payload.parentToolId)) {
            edgeList.push(makeReactFlowEdge(
              `e-${edgeType}-${parentToolId}-${entryId}`,
              parentToolId,
              entryId,
              edgeType,
            ));
          }
        }
        continue;
      }

      const prefix = entryId.slice(0, colonIdx);
      const corrId = entryId.slice(colonIdx + 1);

      if (prefix === 'agent') {
        buildChatEdge(corrId);
      } else if (prefix === 'tool') {
        if (state.toolNodes.has(corrId)) {
          const entry = state.toolNodes.get(corrId)!;
          const toolNodeId = `tool-${corrId}`;
          const parentCorrId = entry.payload.parentCorrelationId;
          const parentId = parentCorrId ? `agent-${parentCorrId}` : '';
          if (parentId && state.agentNodes.has(parentCorrId)) {
            edgeList.push(makeReactFlowEdge(
              `e-calls-${parentId}-${toolNodeId}`,
              parentId,
              toolNodeId,
              'calls',
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
            // Cross-session visibility: only show agent nodes for the selected session
            isVisible = state.agentNodes.has(corrId) && visibleAgentCorrs.has(corrId);
          } else {
            isVisible = id.startsWith('tool-')
              ? state.toolNodes.has(id.slice(5))
              : state.fileNodes.has(id);
          }
          if (isVisible) {
            // #2688 ST10: Re-position preserved agent nodes when the per-session
            // chain grows. computeChatChainPositions recomputes positions for ALL
            // agent nodes on graph-signature change (see the recompute block
            // above), but only the current batch's affected set lands in nodeList.
            // An existing agent node whose correlationId was not re-touched this
            // batch is preserved here with its OLD rendered position — so under
            // incremental arrivals (one message per export, the live Run CLI
            // pattern) it would stay put while the newest node is placed at the
            // chain top, overlapping it. Re-emit the cached chain position when
            // it differs. The equality check suppresses no-op re-emits (same
            // pattern as the Pass-2 deep compare); each preserved node is an
            // O(1) map lookup, keeping the incremental builder O(N) — NFR-1.
            if (id.startsWith('agent-')) {
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

    // ── Phase 6: Incremental edge update (REQ-6) ──
    // Append only new edges; never replace the full edge array.
    setEdges((currentEdges) => {
      const existingIds = new Set(currentEdges.map(e => e.id));
      const trulyNew = edgeList.filter(e => !existingIds.has(e.id));
      return trulyNew.length > 0 ? [...currentEdges, ...trulyNew] : currentEdges;
    });

  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionDeliveries, sessionId]);

  const [nodes, setNodes, rawOnNodesChange] = useNodesState<MonitorNodeData>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  // Stable ref for edges — prevents onNodesChange from depending on edges
  const edgesRef = useRef(edges);
  edgesRef.current = edges;

  // ── Force-directed layout (REQ-6/7) ─────────────────────────────────────────
  // Layout is computed in the processing useEffect above. onNodesChange is
  // a simple pass-through — no more vertical stacking. The Spec #275 guard
  // (setLayoutVersion only when layout actually changes) is handled by the
  // processing effect: it only runs when sessionDeliveries changes, not on
  // every dimension change.
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    rawOnNodesChange(changes);
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
