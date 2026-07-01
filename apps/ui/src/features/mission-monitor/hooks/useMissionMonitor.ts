import { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import { useNodesState, useEdgesState } from 'reactflow';
import type { Node, Edge, NodeChange } from 'reactflow';
import type { ContractDelivery } from '../../../shared/classes/EventSubscription';
import {
  isChatNodeDelivery,
  isToolUseDelivery,
  isSubagentDelivery,
  makeToolNodePayload,
  makeSubagentNodePayload,
  extractDeliveryPayload,
  deliverySessionId,
  deliveryCorrelationId,
  extractUserMessage,
  extractAgentReply,
  extractAgentThinking,
  extractTokenCounts,
  extractAgentModel,
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
  parent:  { stroke: '#6366f1', strokeDasharray: '5,5', strokeWidth: 1.5 },
  calls:   { stroke: '#a855f7', strokeWidth: 1.5 },
  reads:   { stroke: '#334155', strokeDasharray: '2,4', strokeWidth: 1 },
  writes:  { stroke: '#334155', strokeDasharray: '2,4', strokeWidth: 1 },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeAgentNodePayload(d: ContractDelivery): AgentNodePayload {
  const raw = extractDeliveryPayload(d);
  const p = raw as Record<string, any>;

  // REQ-4: Extract all fields using normalization helpers that check BOTH
  // Hook nested paths (properties.text, properties.info.text, etc.) AND
  // OTLP flat paths (gen_ai.response.body, gen_ai.usage.input_tokens, etc.)
  const userMessage = extractUserMessage(p);
  const agentReply = extractAgentReply(p);
  const agentThinking = extractAgentThinking(p);
  const { promptTokens, completionTokens } = extractTokenCounts(p);
  const { agent, model } = extractAgentModel(p);

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

function makeAgentNodeLabel(payload: AgentNodePayload): string {
  if (payload.agent && payload.model) return `${payload.agent} · ${payload.model}`;
  if (payload.agent) return payload.agent;
  if (payload.model) return payload.model;
  return 'Agent';
}

function extractSubagents(
  d: ContractDelivery,
  parentCorrelationId: string,
): SubagentNodePayload[] {
  const p = extractDeliveryPayload(d);
  const subagents = (p.subagents as any[]) ?? [];
  return subagents.map((sa: any, i: number) => ({
    name: sa.name ?? sa.subagentName ?? `subagent-${i}`,
    instruction: sa.instruction ?? sa.prompt ?? '',
    output: sa.output ?? '',
    parentCorrelationId,
    correlationId: `${parentCorrelationId}-sa-${i}`,
    sessionId: deliverySessionId(d),
  }));
}

function extractTools(
  d: ContractDelivery,
  parentCorrelationId: string,
): ToolNodePayload[] {
  const p = extractDeliveryPayload(d);
  const tools = (p.tools as any[]) ?? [];
  return tools.map((t: any, i: number) => ({
    toolName: t.name ?? t.toolName ?? `tool-${i}`,
    input: t.input ?? t.input ?? '',
    output: t.output ?? t.output ?? '',
    parentCorrelationId,
    correlationId: `${parentCorrelationId}-tool-${i}`,
    sessionId: deliverySessionId(d),
  }));
}

function extractFiles(
  d: ContractDelivery,
  parentToolId: string,
): FileNodePayload[] {
  const p = extractDeliveryPayload(d);
  const files = (p.files as any[]) ?? [];
  return files.map((f: any, i: number) => ({
    filePath: f.path ?? f.filePath ?? f.file ?? `file-${i}`,
    operation: (f.operation === 'write' || f.operation === 'read') ? f.operation : 'read',
    parentToolId,
    sessionId: deliverySessionId(d),
  }));
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

  if (contractName === 'chat-node') {
    if (lifecycle === 'init') {
      // Don't recreate if already exists
      if (next.agentNodes.has(correlationId)) return next;

      const payload = makeAgentNodePayload(delivery);

      // REQ-4: On init, if this is a UserPromptSubmit event, the
      // extractAgentReply() function will incorrectly find the user's
      // prompt text at payload.properties?.text and set it as agentReply.
      // Clear it — the actual agent response will arrive on subsequent
      // update/end deliveries. The user message is preserved via the
      // merge logic that never overwrites userMessage from init.
      const rawP = extractDeliveryPayload(delivery);
      if (rawP['event_type'] === 'UserPromptSubmit') {
        payload.agentReply = '';
        payload.agentThinking = '';
      }

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

      // Extract subagents from chat-node payload
      for (const sa of extractSubagents(delivery, correlationId)) {
        if (!next.subagentNodes.has(sa.correlationId)) {
          next.subagentNodes.set(sa.correlationId, {
            payload: sa,
            status: 'in-progress',
            timestamp: delivery.timestamp,
          });
          if (!next.nodeOrder.includes(`subagent:${sa.correlationId}`)) {
            next.nodeOrder.push(`subagent:${sa.correlationId}`);
          }
        }
      }

      // Extract tools from chat-node payload
      for (const t of extractTools(delivery, correlationId)) {
        if (!next.toolNodes.has(t.correlationId)) {
          next.toolNodes.set(t.correlationId, {
            payload: t,
            status: 'in-progress',
            timestamp: delivery.timestamp,
          });
          if (!next.nodeOrder.includes(`tool:${t.correlationId}`)) {
            next.nodeOrder.push(`tool:${t.correlationId}`);
          }
        }
      }

      // Extract files from chat-node payload
      for (const t of extractTools(delivery, correlationId)) {
        const toolId = t.correlationId;
        for (const f of extractFiles(delivery, toolId)) {
          const fileId = `${toolId}-file-${f.filePath.replace(/[^a-zA-Z0-9]/g, '-')}`;
          if (!next.fileNodes.has(fileId)) {
            next.fileNodes.set(fileId, {
              payload: { ...f },
              status: 'active',
              timestamp: delivery.timestamp,
            });
            if (!next.nodeOrder.includes(fileId)) {
              next.nodeOrder.push(fileId);
            }
          }
        }
      }
    } else if (lifecycle === 'update') {
      const existing = next.agentNodes.get(correlationId);
      if (existing) {
        const newPayload = makeAgentNodePayload(delivery);
        // REQ-8: Merge update payload with existing — preserve fields not present in update
        // IMPORTANT: userMessage is set ONCE on init and must NEVER be overwritten.
        // Subsequent deliveries (session.next.text.*, message.*) carry agent response
        // text in payload.properties.text, which extractUserMessage would incorrectly
        // return as the user message. Always preserve the init value.
        const mergedPayload: AgentNodePayload = {
          ...existing.payload,
          ...newPayload,
          userMessage: existing.payload.userMessage, // always preserve from init
          agentThinking: newPayload.agentThinking || existing.payload.agentThinking,
          agentReply: newPayload.agentReply || existing.payload.agentReply,
          // Preserve token counts if the update didn't provide them
          promptTokens: newPayload.promptTokens || existing.payload.promptTokens,
          completionTokens: newPayload.completionTokens || existing.payload.completionTokens,
          totalTokens: newPayload.totalTokens || existing.payload.totalTokens,
        };
        next.agentNodes.set(correlationId, {
          payload: mergedPayload,
          status: 'active' as GraphNodeStatus,
          timestamp: delivery.timestamp,
        });
      }

      // Update status for existing subagents/tools/files to active
      for (const [key, val] of next.subagentNodes) {
        next.subagentNodes.set(key, { ...val, status: 'active' });
      }
      for (const [key, val] of next.toolNodes) {
        next.toolNodes.set(key, { ...val, status: 'active' });
      }
    } else if (lifecycle === 'end') {
      const existing = next.agentNodes.get(correlationId);
      if (existing) {
        const finalStatus: GraphNodeStatus = 'complete';
        const newPayload = makeAgentNodePayload(delivery);
        newPayload.endTime = delivery.timestamp;
        // REQ-8: Merge end delivery with existing — preserve fields not present
        // IMPORTANT: userMessage is set ONCE on init and must NEVER be overwritten.
        const mergedPayload: AgentNodePayload = {
          ...existing.payload,
          ...newPayload,
          userMessage: existing.payload.userMessage, // always preserve from init
          agentThinking: newPayload.agentThinking || existing.payload.agentThinking,
          agentReply: newPayload.agentReply || existing.payload.agentReply,
          promptTokens: newPayload.promptTokens || existing.payload.promptTokens,
          completionTokens: newPayload.completionTokens || existing.payload.completionTokens,
          totalTokens: newPayload.totalTokens || existing.payload.totalTokens,
        };
        next.agentNodes.set(correlationId, {
          payload: mergedPayload,
          status: finalStatus,
          timestamp: delivery.timestamp,
        });

        // Mark subagents and tools under this agent as complete
        for (const [key, val] of next.subagentNodes) {
          if (val.payload.parentCorrelationId === correlationId) {
            next.subagentNodes.set(key, { ...val, status: 'complete' });
          }
        }
        for (const [key, val] of next.toolNodes) {
          if (val.payload.parentCorrelationId === correlationId) {
            next.toolNodes.set(key, { ...val, status: 'complete' });
          }
        }
      } else {
        // If no existing agent node, mark matching ones as complete
        for (const [key, val] of next.agentNodes) {
          if (key === correlationId) {
            next.agentNodes.set(key, { ...val, status: 'complete' });
          }
        }
      }
    }
  } else if (contractName === 'tool-use-lifecycle') {
    // REQ-5: Skip message.* streaming events — they carry EventType::Chat and
    // should not create tool nodes. These reach the handler via contracts that
    // don't yet have eventType filters (waiting for backend REQ-2).
    const deliveryToolName = delivery.payload?.['toolName'] as string | undefined;
    if (deliveryToolName && deliveryToolName.startsWith('message.')) {
      return next;
    }

    // Determine parent correlation ID: try inner payload first, then last agent
    const innerPayload = delivery.payload?.['payload'] as Record<string, unknown> | undefined;
    const parentCorrelationId =
      (innerPayload?.parentCorrelationId as string) ??
      (state.agentOrder.length > 0 ? state.agentOrder[state.agentOrder.length - 1] : '');

    // If a subagent node with the same correlationId exists, skip creating
    // a tool node — the subagent takes priority for this tool invocation.
    if (next.subagentNodes.has(correlationId)) return next;

    if (lifecycle === 'init') {
      if (next.toolNodes.has(correlationId)) return next;

      const payload = makeToolNodePayload(delivery, parentCorrelationId);
      next.toolNodes.set(correlationId, {
        payload,
        status: 'in-progress',
        timestamp: delivery.timestamp,
      });
      if (!next.nodeOrder.includes(`tool:${correlationId}`)) {
        next.nodeOrder.push(`tool:${correlationId}`);
      }

      // Extract files from tool payload
      for (const f of extractFiles(delivery, correlationId)) {
        const fileId = `${correlationId}-file-${f.filePath.replace(/[^a-zA-Z0-9]/g, '-')}`;
        if (!next.fileNodes.has(fileId)) {
          next.fileNodes.set(fileId, {
            payload: { ...f },
            status: 'active',
            timestamp: delivery.timestamp,
          });
          if (!next.nodeOrder.includes(fileId)) {
            next.nodeOrder.push(fileId);
          }
        }
      }
    } else if (lifecycle === 'update') {
      const existing = next.toolNodes.get(correlationId);
      if (existing) {
        const newPayload = makeToolNodePayload(delivery, parentCorrelationId);
        // REQ-8: Merge update payload with existing
        const mergedPayload: ToolNodePayload = {
          ...existing.payload,
          ...newPayload,
          input: newPayload.input || existing.payload.input,
          output: newPayload.output || existing.payload.output,
        };
        next.toolNodes.set(correlationId, {
          payload: mergedPayload,
          status: 'active',
          timestamp: delivery.timestamp,
        });

        // Extract files from tool payload on update too
        for (const f of extractFiles(delivery, correlationId)) {
          const fileId = `${correlationId}-file-${f.filePath.replace(/[^a-zA-Z0-9]/g, '-')}`;
          if (!next.fileNodes.has(fileId)) {
            next.fileNodes.set(fileId, {
              payload: { ...f },
              status: 'active',
              timestamp: delivery.timestamp,
            });
            if (!next.nodeOrder.includes(fileId)) {
              next.nodeOrder.push(fileId);
            }
          }
        }
      }
    } else if (lifecycle === 'end') {
      const existing = next.toolNodes.get(correlationId);
      if (existing) {
        const hasOutput = !!(existing.payload.output || delivery.payload?.['payload']);
        const timedOut = delivery.timedOut;
        const finalStatus: GraphNodeStatus =
          timedOut ? 'error' :
          hasOutput ? 'complete' :
          'error';
        const payload = makeToolNodePayload(delivery, parentCorrelationId);
        next.toolNodes.set(correlationId, {
          payload,
          status: finalStatus,
          timestamp: delivery.timestamp,
        });
      }
    }
  } else if (contractName === 'subagent-lifecycle') {
    // REQ-5: Skip message.* streaming events — they carry EventType::Chat and
    // should not create subagent nodes.
    const deliveryToolName = delivery.payload?.['toolName'] as string | undefined;
    if (deliveryToolName && deliveryToolName.startsWith('message.')) {
      return next;
    }

    // Determine parent correlation ID: try inner payload first, then last agent
    const innerPayload = delivery.payload?.['payload'] as Record<string, unknown> | undefined;
    const parentCorrelationId =
      (innerPayload?.parentCorrelationId as string) ??
      (state.agentOrder.length > 0 ? state.agentOrder[state.agentOrder.length - 1] : '');

    // If a tool node was already created for this same correlationId,
    // remove it — the subagent takes priority.
    if (next.toolNodes.has(correlationId)) {
      next.toolNodes.delete(correlationId);
      next.nodeOrder = next.nodeOrder.filter(id => id !== `tool:${correlationId}`);
    }

    if (lifecycle === 'init') {
      if (next.subagentNodes.has(correlationId)) return next;

      const payload = makeSubagentNodePayload(delivery, parentCorrelationId);
      next.subagentNodes.set(correlationId, {
        payload,
        status: 'in-progress',
        timestamp: delivery.timestamp,
      });
      if (!next.nodeOrder.includes(`subagent:${correlationId}`)) {
        next.nodeOrder.push(`subagent:${correlationId}`);
      }
    } else if (lifecycle === 'update') {
      const existing = next.subagentNodes.get(correlationId);
      if (existing) {
        const newPayload = makeSubagentNodePayload(delivery, parentCorrelationId);
        // REQ-8: Merge update payload with existing
        const mergedPayload: SubagentNodePayload = {
          ...existing.payload,
          ...newPayload,
          instruction: newPayload.instruction || existing.payload.instruction,
          output: newPayload.output || existing.payload.output,
        };
        next.subagentNodes.set(correlationId, {
          payload: mergedPayload,
          status: 'active',
          timestamp: delivery.timestamp,
        });
      }
    } else if (lifecycle === 'end') {
      const existing = next.subagentNodes.get(correlationId);
      if (existing) {
        const hasOutput = existing.payload.output.length > 0 ||
          !!delivery.payload?.['payload'];
        const finalStatus: GraphNodeStatus = hasOutput ? 'complete' : 'error';
        const newPayload = makeSubagentNodePayload(delivery, parentCorrelationId);
        // REQ-8: Merge end delivery with existing — preserve fields from
        // init (name, instruction) that are not present in the end event.
        // The ECE overwrites the accumulated payload with the end event's
        // fields, so name/instruction from init would be lost without merge.
        const mergedPayload: SubagentNodePayload = {
          ...existing.payload,
          ...newPayload,
          name: newPayload.name || existing.payload.name,
          instruction: newPayload.instruction || existing.payload.instruction,
          output: newPayload.output || existing.payload.output,
        };
        next.subagentNodes.set(correlationId, {
          payload: mergedPayload,
          status: finalStatus,
          timestamp: delivery.timestamp,
        });
      }
    }
  }

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

  // Reset graph state when session changes
  useEffect(() => {
    if (lastSessionRef.current !== sessionId) {
      builderStateRef.current = createInitialGraphBuilderState();
      lastSessionRef.current = sessionId;
      layoutPositionsRef.current = new Map();
      lastGraphRef.current = '';
      setNodes([]);
      setEdges([]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Filter deliveries by selected session (all contract types pass through)
  const sessionDeliveries = useMemo(() => {
    if (!sessionId) return [];
    return deliveries.filter((d) => deliverySessionId(d) === sessionId);
  }, [deliveries, sessionId]);

  // Process all deliveries through the graph builder
  useEffect(() => {
    if (!sessionId || sessionDeliveries.length === 0) return;

    let state = builderStateRef.current;
    const prevSize = state.agentNodes.size + state.subagentNodes.size +
      state.toolNodes.size + state.fileNodes.size;

    for (const d of sessionDeliveries) {
      state = processDelivery(state, d);
    }

    builderStateRef.current = state;

    // REQ-3/4: Post-process: merge OTLP token data from any non-chat-node
    // deliveries (e.g. OTLP Chat/Response events) into matching agent nodes.
    // OTLP events may arrive with a different lifecycle timing, creating
    // separate ECE buffers. We scan all deliveries and merge token data
    // into agent nodes that share the same sessionId.
    for (const d of sessionDeliveries) {
      // Skip deliveries already handled by chat-node contract
      if (d.contractName === 'chat-node') continue;
      if (d.lifecycle !== 'end' && d.lifecycle !== 'init') continue;
      const rawP = extractDeliveryPayload(d);
      const { promptTokens, completionTokens } = extractTokenCounts(rawP);
      if (promptTokens > 0 || completionTokens > 0) {
        // Merge into agent nodes sharing the same sessionId
        for (const [key, val] of state.agentNodes) {
          if (val.payload.sessionId === deliverySessionId(d)) {
            const existing = state.agentNodes.get(key)!;
            if (existing.payload.promptTokens < promptTokens || existing.payload.completionTokens < completionTokens) {
              state.agentNodes.set(key, {
                ...existing,
                payload: {
                  ...existing.payload,
                  promptTokens: Math.max(existing.payload.promptTokens, promptTokens),
                  completionTokens: Math.max(existing.payload.completionTokens, completionTokens),
                  totalTokens: Math.max(existing.payload.promptTokens, promptTokens) + Math.max(existing.payload.completionTokens, completionTokens),
                },
              });
            }
          }
        }
      }
    }

    // Only update ReactFlow if something changed
    const newSize = state.agentNodes.size + state.subagentNodes.size +
      state.toolNodes.size + state.fileNodes.size;

    if (newSize === prevSize && sessionDeliveries.length > 0) {
      // Still update payloads even if no new nodes
    }

    // REQ-6: Two-pass node/edge building — build all nodes first (pass 1),
    // then build all edges (pass 2) referencing the complete node set.
    // This prevents orphan edges when nodeOrder places children before parents.
    const nodeList: Node<MonitorNodeData>[] = [];

    // Pass 1: Build all nodes from accumulated state
    for (const entryId of state.nodeOrder) {
      // nodeOrder entries are type-prefixed: "agent:<corrId>", "tool:<corrId>",
      // "subagent:<corrId>", or raw fileId (backward compat).
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
        if (state.agentNodes.has(corrId)) {
          const entry = state.agentNodes.get(corrId)!;
          const label = makeAgentNodeLabel(entry.payload);
          nodeList.push(makeReactFlowNode(
            `agent-${corrId}`, 'agent', entry.status, entry.payload, entry.timestamp, label,
          ));
        }
      } else if (prefix === 'subagent') {
        if (state.subagentNodes.has(corrId)) {
          const entry = state.subagentNodes.get(corrId)!;
          nodeList.push(makeReactFlowNode(
            `subagent-${corrId}`, 'subagent', entry.status, entry.payload, entry.timestamp,
            `Subagent · ${entry.payload.name}`,
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

    // Build set of all node IDs from pass 1 for edge existence checks
    const allNodeIds = new Set(nodeList.map(n => n.id));

    // Pass 2: Build all edges using the complete node set
    const edgeList: Edge[] = [];

    for (const entryId of state.nodeOrder) {
      const colonIdx = entryId.indexOf(':');
      if (colonIdx < 0) {
        // File nodes — create edges to parent tool
        if (state.fileNodes.has(entryId)) {
          const entry = state.fileNodes.get(entryId)!;
          const edgeType: GraphEdgeType = entry.payload.operation === 'write' ? 'writes' : 'reads';
          const parentToolId = `tool-${entry.payload.parentToolId}`;
          if (allNodeIds.has(parentToolId) && allNodeIds.has(entryId)) {
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
        if (state.subagentNodes.has(corrId)) {
          const entry = state.subagentNodes.get(corrId)!;
          const subagentNodeId = `subagent-${corrId}`;
          // REQ-6: Only create subagent edge when parent agent node exists
          const parentCorrId = entry.payload.parentCorrelationId;
          const parentId = parentCorrId ? `agent-${parentCorrId}` : '';
          if (parentId && allNodeIds.has(parentId) && allNodeIds.has(subagentNodeId)) {
            edgeList.push(makeReactFlowEdge(
              `e-parent-${parentId}-${subagentNodeId}`,
              parentId,
              subagentNodeId,
              'parent',
            ));
          }
        }
      } else if (prefix === 'tool') {
        if (state.toolNodes.has(corrId)) {
          const entry = state.toolNodes.get(corrId)!;
          const toolNodeId = `tool-${corrId}`;
          // Only create tool edge when parent agent node exists
          const parentCorrId = entry.payload.parentCorrelationId;
          const parentId = parentCorrId ? `agent-${parentCorrId}` : '';
          if (parentId && allNodeIds.has(parentId) && allNodeIds.has(toolNodeId)) {
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

    // REQ-6/7: Apply force-directed layout to node positions
    if (nodeList.length > 0) {
      const layoutNodes = nodeList.map((n) => ({
        id: n.id,
        status: n.data.status,
      }));
      const layoutEdges = edgeList.map((e) => ({
        source: typeof e.source === 'string' ? e.source : '',
        target: typeof e.target === 'string' ? e.target : '',
      }));

      // AC-7: Only recompute layout when graph structure changes (nodes/edges added/removed)
      const graphSignature = layoutNodes.map(n => n.id).sort().join(',') + '|' +
        layoutEdges.map(e => `${e.source}>${e.target}`).sort().join(',');
      const needsRecompute = graphSignature !== lastGraphRef.current;

      if (needsRecompute || layoutPositionsRef.current.size === 0) {
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
          // Default position if not in cache
          node.position = { x: 0, y: 0 };
        }
      }
    }

    // Functional updater: only replace nodes that actually changed
    setNodes((currentNodes) => {
      const nodeIdSet = new Set(nodeList.map(n => n.id));
      const merged: Node<MonitorNodeData>[] = [];
      let changed = false;
      for (const node of nodeList) {
        const idx = currentNodes.findIndex(n => n.id === node.id);
        if (idx >= 0) {
          const existing = currentNodes[idx];
          // Deep compare by position and status
          const posChanged = existing.position.x !== node.position.x ||
            existing.position.y !== node.position.y;
          const statusChanged = existing.data.status !== node.data.status;
          const payloadChanged = existing.data.payload !== node.data.payload;
          if (posChanged || statusChanged || payloadChanged) {
            merged.push(node);
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
    setEdges(edgeList);

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
    eventCount: sessionDeliveries.length,
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
