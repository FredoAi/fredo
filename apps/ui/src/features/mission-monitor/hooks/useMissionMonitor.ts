import { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import { useNodesState, useEdgesState } from 'reactflow';
import type { Node, Edge, NodeChange } from 'reactflow';
import type { ContractDelivery } from '../../../shared/classes/EventSubscription';
import {
  extractDeliveryPayload,
  deliverySessionId,
  deliveryCorrelationId,
  type GraphNodeStatus,
  type GraphNodeType,
  type GraphEdgeType,
  type AgentNodePayload,
  type SubagentNodePayload,
  type ToolNodePayload,
  type FileNodePayload,
} from '../lib/contract';
import { graphStatusToMonitorStatus, GRAPH_NODE_TYPE_MAP } from '../types';
import type { MonitorNodeData, MonitorNodeStatus } from '../types';
import { computeForceLayout } from '../lib/layout';

// ── Edge style definitions ────────────────────────────────────────────────────

const EDGE_STYLES: Record<GraphEdgeType, React.CSSProperties> = {
  parent:  { stroke: '#6366f1', strokeWidth: 1.5 },
  calls:   { stroke: '#a855f7', strokeWidth: 1.5 },
  reads:   { stroke: '#334155', strokeDasharray: '2,4', strokeWidth: 1 },
  writes:  { stroke: '#334155', strokeDasharray: '2,4', strokeWidth: 1 },
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
  const promptTokens = typeof p.promptTokens === 'number' ? p.promptTokens : 0;
  const completionTokens = typeof p.completionTokens === 'number' ? p.completionTokens : 0;
  const agent = p.agent as string | undefined;
  const model = p.model as string | undefined;

  return {
    agent,
    model,
    userMessage,
    agentThinking,
    agentReply,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    correlationId: deliveryCorrelationId(d),
    sessionId: deliverySessionId(d),
  };
}

function makeAgentNodeLabel(_payload: AgentNodePayload): string {
  return 'Chat';
}

/**
 * Build a SubagentNodePayload from a composited subagent delivery.
 * Extracts adapter-injected fields (agent, model) with fallbacks,
 * preserving parentCorrelationId from the parent agent lookup.
 */
function makeSubagentNodePayload(
  delivery: ContractDelivery,
  parentCorrelationId: string,
): SubagentNodePayload {
  const raw = extractDeliveryPayload(delivery);
  const p = raw as Record<string, any>;

  const name = (p.agent as string) ?? (p.model as string) ?? (p.name as string) ?? 'Subagent';

  // Spec #627, #633: Extract instruction from delivery payload.
  //
  // The adapter injects instruction from OTLP span attributes (gen_ai.prompt >
  // prompt > instruction). However, QA confirmed across multiple E2E cycles
  // that p.instruction and all other normalized fallback fields are EMPTY in
  // the actual subagent delivery payload.
  //
  // REALITY (confirmed by QA E2E DB delivery payload): For INIT deliveries,
  // p.output contains the instruction text. The session span's output attribute
  // (set by handleSessionIdle, session.ts:252) carries the response text, but
  // the span may be exported BEFORE handleSessionIdle runs, leaving only the
  // instruction attribute (set by handleSessionCreated, session.ts:153) and
  // any other attributes. The "instruction" OTLP attribute maps to p.output
  // in the delivery payload (via adapter's otlp_attrs_to_payload which clones
  // all span attrs). The p.instruction field is never populated because the
  // otlp_attrs_to_payload is_subagent_span injection at lines 1398-1430
  // requires specific timing and attribute paths that don't always align.
  //
  // Field priority (lifecycle-aware):
  // 1. p.instruction — adapter-injected (may be empty due to timing/ordering)
  // 2. p.prompt — raw OTLP attribute from LLM span's startMessageSpan
  // 3. p.userMessage — adapter-injected canonical field
  // 4. p.text — legacy fallback
  // 5. p.info.text — normalized info object (same source as userMessage)
  // 6. p.output — ONLY for INIT deliveries: QA confirmed the INIT delivery
  //    payload carries the instruction text in the `output` field. For END/
  //    UPDATE deliveries, p.output contains the response text, NOT instruction.
  const instruction =
    (typeof p.instruction === 'string' && p.instruction) ||
    (typeof p.prompt === 'string' && p.prompt) ||
    (typeof p.userMessage === 'string' && p.userMessage) ||
    (typeof p.text === 'string' && p.text) ||
    (p.info && typeof (p.info as Record<string, any>).text === 'string'
      ? (p.info as Record<string, any>).text as string
      : '') ||
    (delivery.lifecycle === 'init' && typeof p.output === 'string' && p.output) ||
    '';

  // Spec #627: OTLP subagent spans carry output in p.output (from session span)
  // or p.response_text/p.agentReply (from LLM span attributes).
  // Match the fallback pattern from contract.ts for robustness.
  const output =
    (typeof p.output === 'string' && p.output) ||
    (typeof p.response_text === 'string' && p.response_text) ||
    (typeof p.agentReply === 'string' && p.agentReply) ||
    '';

  return {
    name,
    instruction,
    output,
    parentCorrelationId,
    correlationId: deliveryCorrelationId(delivery),
    sessionId: deliverySessionId(delivery),
  };
}

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
  agentNodes: Map<string, { payload: AgentNodePayload; status: GraphNodeStatus; timestamp: string }>;
  subagentNodes: Map<string, { payload: SubagentNodePayload; status: GraphNodeStatus; timestamp: string }>;
  toolNodes: Map<string, { payload: ToolNodePayload; status: GraphNodeStatus; timestamp: string }>;
  fileNodes: Map<string, { payload: FileNodePayload; status: GraphNodeStatus; timestamp: string }>;
  nodeOrder: string[];
  agentOrder: string[];
}

function createInitialGraphBuilderState(): GraphBuilderState {
  return {
    agentNodes: new Map(),
    subagentNodes: new Map(),
    toolNodes: new Map(),
    fileNodes: new Map(),
    nodeOrder: [],
    agentOrder: [],
  };
}

/**
 * Process a single ContractDelivery through the graph builder.
 * Routes deliveries by contractName to the appropriate handler:
 * - chat-node → AgentNode lifecycle
 * - tool-use-lifecycle → ToolNode lifecycle + FileNode extraction
 * - subagent-lifecycle → SubagentNode lifecycle
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
    subagentNodes: new Map(state.subagentNodes),
    toolNodes: new Map(state.toolNodes),
    fileNodes: new Map(state.fileNodes),
    nodeOrder: [...state.nodeOrder],
    agentOrder: [...state.agentOrder],
  };

  const contractName = delivery.contractName;

  // #593: non-chat nodes deactivated. Scope: chat-node only.
  if (contractName !== 'chat-node') {
    return next;
  }

  if (contractName === 'chat-node') {
    if (lifecycle === 'init') {
      const rawP = extractDeliveryPayload(delivery) as Record<string, any>;

      // REQ-12: Detect subagent chat-node deliveries. Two detection paths:
      //
      // Path 1 — ECE composited: delivery.payload contains compositedChildSessionId.
      //   The ECE engine injects this field when it composites child session events
      //   into the parent's delivery stream. This is the reliable detection signal.
      //
      // Path 2 — OTLP non-composited: payload fields from OTLP session spans.
      //   For OTLP-only flows (Mission Monitor contract = otlp_grpc only), the
      //   ECE does NOT composite subagent deliveries (the OTLP adapter never
      //   emits relationship metadata). Subagent deliveries arrive with
      //   sessionId = child_sid, correlationId = child_sid. Detect via the
      //   OTLP span attributes: is_subagent = true OR agent.type = "subagent".
      const isEceComposited = (delivery.payload as any)?.compositedChildSessionId !== undefined;
      const isOtlpSubagent = rawP?.is_subagent === true || rawP?.['agent.type'] === 'subagent';
      const isSubagentSession = isEceComposited || isOtlpSubagent;

      // Spec #555 (Compaction AC-7): When testing compaction via mock events
      // (fredo emit), ensure sessionId === correlationId for parent agent nodes.
      // Using different values triggers the isSubagentSession branch, creating
      // a SubagentNode instead of an AgentNode. While the compaction status
      // should still be applied to the SubagentNode, verifying the correct
      // extraction requires the 'payload' stream field to survive ECE delivery.

      // REQ-3: Create SubagentNode for composited/OTLP-derived subagent deliveries
      if (isSubagentSession) {
        // Don't recreate if already exists
        if (next.subagentNodes.has(correlationId)) return next;

        // Find parent correlationId. Two strategies:
        // Path 1 (ECE composited): parent shares the same sessionId.
        // Path 2 (OTLP non-composited): subagent has its own sessionId;
        //   find parent by iterating existing agent nodes from other sessions.
        let parentCorrelationId = '';
        if (isEceComposited) {
          for (const [corrId, entry] of next.agentNodes) {
            if (corrId !== correlationId && entry.payload.sessionId === sessionId) {
              parentCorrelationId = corrId;
              break;
            }
          }
        } else {
          // OTLP-derived: find the first agent node from a different session.
          // The parent session started before the child (subagent) session,
          // so the parent's AgentNode already exists in the graph builder state.
          for (const [corrId, entry] of next.agentNodes) {
            if (entry.payload.sessionId !== sessionId) {
              parentCorrelationId = corrId;
              break;
            }
          }
        }
        // Fallback to first agent in order if no direct match found
        if (!parentCorrelationId && next.agentOrder.length > 0) {
          parentCorrelationId = next.agentOrder[0];
        }

        // Spec #627: Payload fallback for OTLP subagent sessions when the
        // parent agent node hasn't been populated yet (race condition).
        // The OTLP session span payload includes session.parent_id —
        // for pure-OTLP flows, the parent session ID equals the parent
        // correlation ID (session_to_correlation maps session_id → session_id).
        if (!parentCorrelationId) {
          parentCorrelationId = (rawP?.['session.parent_id'] as string) ?? '';
        }

        const subagentPayload = makeSubagentNodePayload(delivery, parentCorrelationId);

        next.subagentNodes.set(correlationId, {
          payload: subagentPayload,
          status: 'in-progress',
          timestamp: delivery.timestamp,
        });

        if (!next.nodeOrder.includes(`subagent:${correlationId}`)) {
          next.nodeOrder.push(`subagent:${correlationId}`);
        }

        return next;
      }

      // Don't recreate if already exists (agent or subagent — cross-session detection
      // may have already created a SubagentNode for this correlationId).
      if (next.agentNodes.has(correlationId)) return next;
      if (next.subagentNodes.has(correlationId)) return next;

      const payload = makeAgentNodePayload(delivery);

      next.agentNodes.set(correlationId, {
        payload,
        status: 'in-progress',
        timestamp: delivery.timestamp,
      });

      if (!next.agentOrder.includes(correlationId)) {
        next.agentOrder.push(correlationId);
      }
      if (!next.nodeOrder.includes(`agent:${correlationId}`)) {
        next.nodeOrder.push(`agent:${correlationId}`);
      }
    } else if (lifecycle === 'update') {
      // REQ-4: Handle subagent update lifecycle — status to 'active', merge payload
      // Detection: ECE-composited (compositedChildSessionId in payload) OR
      // OTLP-derived (subagent node already exists from init detection).
      const isComposited = (delivery.payload as any)?.compositedChildSessionId !== undefined;
      if (isComposited || next.subagentNodes.has(correlationId)) {
        const existingSubagent = next.subagentNodes.get(correlationId);
        if (existingSubagent) {
          // Don't regress from complete
          if (existingSubagent.status === 'complete') return next;

          const newPayload = makeSubagentNodePayload(delivery, existingSubagent.payload.parentCorrelationId);
          // Merge payload: preserve parentCorrelationId from init, concatenate output,
          // preserve instruction from init (END/UPDATE deliveries carry response text
          // in p.output, not the instruction text).
          const mergedPayload: SubagentNodePayload = {
            ...existingSubagent.payload,
            ...newPayload,
            parentCorrelationId: existingSubagent.payload.parentCorrelationId,
            instruction: newPayload.instruction || existingSubagent.payload.instruction,
            output: newPayload.output
              ? (existingSubagent.payload.output
                  ? existingSubagent.payload.output + newPayload.output
                  : newPayload.output)
              : existingSubagent.payload.output,
          };
          next.subagentNodes.set(correlationId, {
            payload: mergedPayload,
            status: 'active',
            timestamp: delivery.timestamp,
          });
        }
        return next;
      }

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
          const promptTokens = typeof rawPAny.promptTokens === 'number' ? rawPAny.promptTokens : 0;
          const completionTokens = typeof rawPAny.completionTokens === 'number' ? rawPAny.completionTokens : 0;
          if (promptTokens > 0 || completionTokens > 0) {
            existing.payload.promptTokens = Math.max(existing.payload.promptTokens, promptTokens);
            existing.payload.completionTokens = Math.max(existing.payload.completionTokens, completionTokens);
            existing.payload.totalTokens = existing.payload.promptTokens + existing.payload.completionTokens;
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
          // Preserve token counts if the update didn't provide them, using Math.max
          promptTokens: Math.max(existing.payload.promptTokens, newPayload.promptTokens),
          completionTokens: Math.max(existing.payload.completionTokens, newPayload.completionTokens),
          totalTokens: Math.max(existing.payload.totalTokens, newPayload.totalTokens),
        };
        // REQ-8: Detect compacted flag from delivery payload
        const updateInner = extractDeliveryPayload(delivery) as Record<string, any>;
        const isCompacted = updateInner?.compacted === true;
        next.agentNodes.set(correlationId, {
          payload: mergedPayload,
          status: isCompacted ? 'compacted' as GraphNodeStatus : 'active' as GraphNodeStatus,
          timestamp: delivery.timestamp,
        });
      }

      // #593: tool-use-lifecycle and subagent-lifecycle contracts still deactivated.
      // Subagent chat-node deliveries handled above (REQ-4).
    } else if (lifecycle === 'end') {
      // REQ-4: Handle subagent end lifecycle — status to 'complete', finalize payload
      // Detection: ECE-composited (compositedChildSessionId in payload) OR
      // OTLP-derived (subagent node already exists from init detection).
      const isCompositedEnd = (delivery.payload as any)?.compositedChildSessionId !== undefined;
      if (isCompositedEnd || next.subagentNodes.has(correlationId)) {
        const existingSubagent = next.subagentNodes.get(correlationId);
        if (existingSubagent) {
          // Don't regress from complete (re-processing guard)
          if (existingSubagent.status === 'complete') return next;

          const newPayload = makeSubagentNodePayload(delivery, existingSubagent.payload.parentCorrelationId);
          // Finalize payload: preserve name/instruction from init, use end delivery's output
          const mergedPayload: SubagentNodePayload = {
            ...existingSubagent.payload,
            ...newPayload,
            parentCorrelationId: existingSubagent.payload.parentCorrelationId,
            instruction: newPayload.instruction || existingSubagent.payload.instruction,
            output: newPayload.output || existingSubagent.payload.output,
          };
          next.subagentNodes.set(correlationId, {
            payload: mergedPayload,
            status: 'complete',
            timestamp: delivery.timestamp,
          });
        }
        return next;
      }

      const existing = next.agentNodes.get(correlationId);
      if (existing) {
        // AC-5 (Spec #478): When node is already 'complete', do NOT overwrite
        // the accumulated agentReply. This branch is hit when the processing
        // useEffect re-runs (due to mapping changes) and re-processes deliveries
        // that were already handled — overwriting would lose accumulated text.
        if (existing.status === 'complete') {
          const rawP = extractDeliveryPayload(delivery);
          const rawPAny = rawP as Record<string, any>;
          const promptTokens = typeof rawPAny.promptTokens === 'number' ? rawPAny.promptTokens : 0;
          const completionTokens = typeof rawPAny.completionTokens === 'number' ? rawPAny.completionTokens : 0;
          if (promptTokens > 0 || completionTokens > 0) {
            existing.payload.promptTokens = Math.max(existing.payload.promptTokens, promptTokens);
            existing.payload.completionTokens = Math.max(existing.payload.completionTokens, completionTokens);
            existing.payload.totalTokens = existing.payload.promptTokens + existing.payload.completionTokens;
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
        newPayload.endTime = delivery.timestamp;
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
          totalTokens: newPayload.totalTokens || existing.payload.totalTokens,
        };
        // REQ-8: Detect compacted flag — override finalStatus with 'compacted'
        const endInner = extractDeliveryPayload(delivery) as Record<string, any>;
        const endCompacted = endInner?.compacted === true;
        next.agentNodes.set(correlationId, {
          payload: mergedPayload,
          status: endCompacted ? 'compacted' as GraphNodeStatus : finalStatus,
          timestamp: delivery.timestamp,
        });

        // Subagent chat-node end handled above (REQ-4).
        // #593: tool-use-lifecycle and subagent-lifecycle contracts still deactivated.
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
  // #593: tool-use-lifecycle and subagent-lifecycle contracts still deactivated.
  // chat-node subagent deliveries now handled (REQ-3, REQ-4).

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
  // Track last processed counts for incremental processing (perf: avoid O(N²) scans)
  const lastSessionProcessedRef = useRef(0);
  // Incremental session delivery filtering cache (perf: avoid O(N) re-filter on every delivery)
  const sessionDeliveriesCacheRef = useRef<ContractDelivery[]>([]);
  const sessionDeliveriesFilteredRef = useRef(0);
  // Reset graph state when session changes
  useEffect(() => {
    if (lastSessionRef.current !== sessionId) {
      builderStateRef.current = createInitialGraphBuilderState();
      lastSessionRef.current = sessionId;
      layoutPositionsRef.current = new Map();
      lastGraphRef.current = '';
      lastSessionProcessedRef.current = 0;
      sessionDeliveriesCacheRef.current = [];
      sessionDeliveriesFilteredRef.current = 0;
      setNodes([]);
      setEdges([]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);



  // Process ALL deliveries through the graph builder, not just the selected session.
  // This is required for cross-session subagent detection: OTLP-derived subagent
  // deliveries have their own sessionId (not the parent's), so they would be
  // excluded by a sessionId filter. By processing all deliveries, the graph
  // builder detects subagents via payload fields (is_subagent, agent.type) and
  // links them to the parent AgentNode. Output filtering in Phase 3/4 then
  // shows only the selected session's AgentNode + linked SubagentNodes.
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
      return [];
    }
    const startIdx = sessionDeliveriesFilteredRef.current;
    if (startIdx >= deliveries.length) return sessionDeliveriesCacheRef.current;

    // Include ALL new deliveries (no sessionId filter — cross-session subagent detection
    // needs deliveries from subagent sessions that have different sessionIds).
    const newMatches: ContractDelivery[] = [];
    for (let i = startIdx; i < deliveries.length; i++) {
      newMatches.push(deliveries[i]);
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

    const startIdx = lastSessionProcessedRef.current;
    if (startIdx >= sessionDeliveries.length) return;

    let state = builderStateRef.current;

    // ── Phase 1: Incremental processDelivery with change tracking ──
    // REQ-5: Track which nodeOrder indices were affected by this batch.
    const prevNodeOrderLength = state.nodeOrder.length;
    // Track delivery correlationIds that touch existing nodes
    const touchedCorrIds = new Set<string>();
    // Track agent end lifecycles that also complete child subagent/tool nodes
    const agentEndCorrs = new Set<string>();

    // Only process new deliveries since last run
    for (let i = startIdx; i < sessionDeliveries.length; i++) {
      const d = sessionDeliveries[i];
      const corrId = deliveryCorrelationId(d);
      touchedCorrIds.add(corrId);
      if (d.contractName === 'chat-node' && d.lifecycle === 'end') {
        agentEndCorrs.add(corrId);
      }
      state = processDelivery(state, d);
    }
    lastSessionProcessedRef.current = sessionDeliveries.length;
    builderStateRef.current = state;

    // ── Phase 2: Determine which entry IDs are affected ──
    // NEW entries: appended to nodeOrder since last batch
    const newEntryIds = new Set(state.nodeOrder.slice(prevNodeOrderLength));

    // CHANGED entries: existing entries whose correlationId was touched by
    // the current batch's deliveries (status/payload updates).
    // Also include child subagent/tool nodes completed by agent end lifecycle.
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
      // Agent end lifecycle marks child subagent/tool nodes as complete
      if (agentEndCorrs.size > 0) {
        if (prefix === 'subagent') {
          const entry = state.subagentNodes.get(corrId);
          if (entry && agentEndCorrs.has(entry.payload.parentCorrelationId)) {
            changedEntryIds.add(entryId);
          }
        } else if (prefix === 'tool') {
          const entry = state.toolNodes.get(corrId);
          if (entry && agentEndCorrs.has(entry.payload.parentCorrelationId)) {
            changedEntryIds.add(entryId);
          }
        }
      }
    }

    // ── Retroactive edge building (Bug 3) ──
    // When new agent nodes are added, scan pre-existing subagent nodes.
    // If any subagent's parentCorrelationId matches a newly-added agent
    // node's correlationId (or sessionId-based fallback), add the subagent's
    // entryId to changedEntryIds so its edge is built in Phase 4.
    for (const entryId of newEntryIds) {
      const colonIdx = entryId.indexOf(':');
      if (colonIdx < 0) continue;
      const prefix = entryId.slice(0, colonIdx);
      const corrId = entryId.slice(colonIdx + 1);
      if (prefix !== 'agent') continue;

      // Get the new agent node's correlationId
      const agentEntry = state.agentNodes.get(corrId);
      if (!agentEntry) continue;
      const agentCorrId = agentEntry.payload.correlationId;
      const agentSessionId = agentEntry.payload.sessionId;

      // Scan all pre-existing subagent nodes (those not in newEntryIds)
      for (const saEntryId of state.nodeOrder) {
        if (newEntryIds.has(saEntryId) || changedEntryIds.has(saEntryId)) continue;
        const saColonIdx = saEntryId.indexOf(':');
        if (saColonIdx < 0) continue;
        const saPrefix = saEntryId.slice(0, saColonIdx);
        if (saPrefix !== 'subagent') continue;
        const saCorrId = saEntryId.slice(saColonIdx + 1);
        const saEntry = state.subagentNodes.get(saCorrId);
        if (!saEntry) continue;

        // Check if this subagent's parentCorrelationId matches the new agent:
        // - Direct match: parentCorrelationId equals agent's correlationId
        // - Session-based fallback: parentCorrelationId equals agent's sessionId
        const parentCorrId = saEntry.payload.parentCorrelationId;
        if (parentCorrId === agentCorrId || parentCorrId === agentSessionId) {
          changedEntryIds.add(saEntryId);
        }
      }
    }

    const affectedEntryIds = new Set([...newEntryIds, ...changedEntryIds]);

    // ── Session-scoped node filtering ──
    // When processing ALL deliveries (cross-session subagent detection), the graph
    // builder creates nodes for every session. The output must be scoped to the
    // selected session: show only the selected session's AgentNode + linked
    // SubagentNodes. Other sessions' AgentNodes (including the subagent's own
    // instrumented session via OTLP) are hidden.
    //
    // Build a set of "visible agent correlationIds" — agent nodes whose sessionId
    // matches the selected session. Also find all subagent parentCorrelationIds
    // that belong to the selected session (for edge linking below).
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
      } else if (prefix === 'subagent') {
        if (state.subagentNodes.has(corrId)) {
          const entry = state.subagentNodes.get(corrId)!;
          // Show subagent nodes if:
          // 1. Linked to a visible agent (parentCorrelationId matches), OR
          // 2. Belongs to the selected session (ECE-composited: sessionId = parent's sessionId)
          //    This handles the case where the parent agent node doesn't exist yet
          //    but the subagent delivery is being processed for the first time.
          const isLinkedToVisibleAgent = visibleAgentCorrs.has(entry.payload.parentCorrelationId);
          const isSameSession = entry.payload.sessionId === sessionId;
          if (isLinkedToVisibleAgent || isSameSession) {
            nodeList.push(makeReactFlowNode(
              `subagent-${corrId}`, 'subagent', entry.status, entry.payload, entry.timestamp,
              `Subagent · ${entry.payload.name}`,
            ));
          }
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
        else if (prefix === 'subagent') { nodeId = `subagent-${corrId}`; nodeType = 'subagent'; }
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
      if (prefix === 'subagent') {
        const entry = state.subagentNodes.get(corrId);
        if (entry) {
          const parentId = entry.payload.parentCorrelationId ? `agent-${entry.payload.parentCorrelationId}` : '';
          const subagentId = `subagent-${corrId}`;
          if (parentId && allNodeTypes.has(parentId) && allNodeTypes.has(subagentId)) {
            allLayoutEdges.push({ source: parentId, target: subagentId });
          }
        }
      } else if (prefix === 'tool') {
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
        : nodeId.startsWith('subagent-') ? `subagent:${nodeId.slice(9)}`
        : nodeId.startsWith('tool-') ? `tool:${nodeId.slice(5)}`
        : nodeId;
      const eci = entryId.indexOf(':');
      let status: MonitorNodeStatus = 'inactive';
      if (eci >= 0) {
        const prefix = entryId.slice(0, eci);
        const corrId = entryId.slice(eci + 1);
        const entry = prefix === 'agent' ? state.agentNodes.get(corrId)
          : prefix === 'subagent' ? state.subagentNodes.get(corrId)
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

    // Helper: build a single subagent edge if parent agent is visible
    const buildSubagentEdge = (corrId: string) => {
      if (!state.subagentNodes.has(corrId)) return;
      const entry = state.subagentNodes.get(corrId)!;
      const subagentNodeId = `subagent-${corrId}`;
      const parentCorrId = entry.payload.parentCorrelationId;
      const parentId = parentCorrId ? `agent-${parentCorrId}` : '';
      if (parentId && state.agentNodes.has(parentCorrId) && visibleAgentCorrs.has(parentCorrId)) {
        edgeList.push(makeReactFlowEdge(
          `e-parent-${parentId}-${subagentNodeId}`,
          parentId,
          subagentNodeId,
          'parent',
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

      if (prefix === 'subagent') {
        buildSubagentEdge(corrId);
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

    // ── Phase 4b: Retroactive edge building (Bug 3) ──
    // Build edges for subagent entries added to changedEntryIds due to a new
    // parent agent node appearing after the subagent node was created.
    for (const entryId of changedEntryIds) {
      if (newEntryIds.has(entryId)) continue;
      const colonIdx = entryId.indexOf(':');
      if (colonIdx < 0) continue;
      const prefix = entryId.slice(0, colonIdx);
      if (prefix !== 'subagent') continue;
      const corrId = entryId.slice(colonIdx + 1);
      buildSubagentEdge(corrId);
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
          } else if (id.startsWith('subagent-')) {
            const corrId = id.slice(9);
            const entry = state.subagentNodes.get(corrId);
            // Cross-session visibility: show subagent nodes linked to a visible agent
            // OR belonging to the selected session (handles orphan subagent nodes
            // where the parent AgentNode hasn't been created yet).
            isVisible = !!entry && (
              visibleAgentCorrs.has(entry.payload.parentCorrelationId) ||
              entry.payload.sessionId === sessionId
            );
          } else {
            isVisible = id.startsWith('tool-')
              ? state.toolNodes.has(id.slice(5))
              : state.fileNodes.has(id);
          }
          if (isVisible) {
            merged.push(existing);
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
    // The graph builder processes ALL deliveries for cross-session subagent detection,
    // but the event count should reflect only the selected session's activity.
    eventCount: sessionId ? deliveries.filter(d => deliverySessionId(d) === sessionId).length : 0,
  };
}

// Re-export for backward compat (these are no-ops now)
export function buildGraphFromEvents(): { nodes: never[]; edges: never[] } {
  return { nodes: [], edges: [] };
}

export function processChatNodeSubscription(): any {
  return createInitialProcessorState();
}

export function createInitialProcessorState() {
  return {
    contracts: new Map(),
    assistantParentMap: new Map(),
    pendingParts: new Map(),
    toolPartIds: new Map(),
    filePaths: new Map(),
    nodeOrder: [],
    subagentContracts: new Map(),
  };
}
