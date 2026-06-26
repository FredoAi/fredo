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
  return {
    agent: (p.info?.agent as string) ?? (p.agent as string) ?? undefined,
    model: (p.info?.modelID as string) ?? (p.model as string) ?? undefined,
    userMessage: (p.info?.text as string) ?? (p.userMessage as string) ?? '',
    agentThinking: (p.part?.reasoning as string) ?? (p.agentThinking as string) ?? '',
    agentReply: (p.part?.text as string) ?? (p.agentReply as string) ?? '',
    promptTokens: (p.info?.turnInputTokens as number) ?? (p.turnInputTokens as number) ?? 0,
    completionTokens: (p.info?.turnOutputTokens as number) ?? (p.turnOutputTokens as number) ?? 0,
    totalTokens: 0,
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
      payload.totalTokens = payload.promptTokens + payload.completionTokens;

      next.agentNodes.set(correlationId, {
        payload,
        status: 'in-progress',
        timestamp: delivery.timestamp,
      });

      if (!next.agentOrder.includes(correlationId)) {
        next.agentOrder.push(correlationId);
      }
      if (!next.nodeOrder.includes(correlationId)) {
        next.nodeOrder.push(correlationId);
      }

      // Extract subagents from chat-node payload
      for (const sa of extractSubagents(delivery, correlationId)) {
        if (!next.subagentNodes.has(sa.correlationId)) {
          next.subagentNodes.set(sa.correlationId, {
            payload: sa,
            status: 'in-progress',
            timestamp: delivery.timestamp,
          });
          if (!next.nodeOrder.includes(sa.correlationId)) {
            next.nodeOrder.push(sa.correlationId);
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
          if (!next.nodeOrder.includes(t.correlationId)) {
            next.nodeOrder.push(t.correlationId);
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
        const payload = makeAgentNodePayload(delivery);
        payload.totalTokens = payload.promptTokens + payload.completionTokens;
        next.agentNodes.set(correlationId, {
          payload,
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
        const payload = makeAgentNodePayload(delivery);
        payload.totalTokens = payload.promptTokens + payload.completionTokens;
        payload.endTime = delivery.timestamp;
        next.agentNodes.set(correlationId, {
          payload,
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
    // Determine parent correlation ID: try inner payload first, then last agent
    const innerPayload = delivery.payload?.['payload'] as Record<string, unknown> | undefined;
    const parentCorrelationId =
      (innerPayload?.parentCorrelationId as string) ??
      (state.agentOrder.length > 0 ? state.agentOrder[state.agentOrder.length - 1] : '');

    if (lifecycle === 'init') {
      if (next.toolNodes.has(correlationId)) return next;

      const payload = makeToolNodePayload(delivery, parentCorrelationId);
      next.toolNodes.set(correlationId, {
        payload,
        status: 'in-progress',
        timestamp: delivery.timestamp,
      });
      if (!next.nodeOrder.includes(correlationId)) {
        next.nodeOrder.push(correlationId);
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
        const payload = makeToolNodePayload(delivery, parentCorrelationId);
        next.toolNodes.set(correlationId, {
          payload,
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
    // Determine parent correlation ID: try inner payload first, then last agent
    const innerPayload = delivery.payload?.['payload'] as Record<string, unknown> | undefined;
    const parentCorrelationId =
      (innerPayload?.parentCorrelationId as string) ??
      (state.agentOrder.length > 0 ? state.agentOrder[state.agentOrder.length - 1] : '');

    if (lifecycle === 'init') {
      if (next.subagentNodes.has(correlationId)) return next;

      const payload = makeSubagentNodePayload(delivery, parentCorrelationId);
      next.subagentNodes.set(correlationId, {
        payload,
        status: 'in-progress',
        timestamp: delivery.timestamp,
      });
      if (!next.nodeOrder.includes(correlationId)) {
        next.nodeOrder.push(correlationId);
      }
    } else if (lifecycle === 'update') {
      const existing = next.subagentNodes.get(correlationId);
      if (existing) {
        const payload = makeSubagentNodePayload(delivery, parentCorrelationId);
        next.subagentNodes.set(correlationId, {
          payload,
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
        const payload = makeSubagentNodePayload(delivery, parentCorrelationId);
        next.subagentNodes.set(correlationId, {
          payload,
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

  // Reset graph state when session changes
  useEffect(() => {
    if (lastSessionRef.current !== sessionId) {
      builderStateRef.current = createInitialGraphBuilderState();
      lastSessionRef.current = sessionId;
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

    // Only update ReactFlow if something changed
    const newSize = state.agentNodes.size + state.subagentNodes.size +
      state.toolNodes.size + state.fileNodes.size;

    if (newSize === prevSize && sessionDeliveries.length > 0) {
      // Still update payloads even if no new nodes
    }

    // Build ReactFlow nodes and edges from accumulated state
    const nodeList: Node<MonitorNodeData>[] = [];
    const edgeList: Edge[] = [];

    for (const corrId of state.nodeOrder) {
      if (state.agentNodes.has(corrId)) {
        const entry = state.agentNodes.get(corrId)!;
        const label = makeAgentNodeLabel(entry.payload);
        nodeList.push(makeReactFlowNode(
          `agent-${corrId}`, 'agent', entry.status, entry.payload, entry.timestamp, label,
        ));
      } else if (state.subagentNodes.has(corrId)) {
        const entry = state.subagentNodes.get(corrId)!;
        nodeList.push(makeReactFlowNode(
          `subagent-${corrId}`, 'subagent', entry.status, entry.payload, entry.timestamp,
          `Subagent · ${entry.payload.name}`,
        ));
        // Parent edge
        const parentId = `agent-${entry.payload.parentCorrelationId}`;
        edgeList.push(makeReactFlowEdge(
          `e-parent-${parentId}-subagent-${corrId}`,
          parentId,
          `subagent-${corrId}`,
          'parent',
        ));
      } else if (state.toolNodes.has(corrId)) {
        const entry = state.toolNodes.get(corrId)!;
        nodeList.push(makeReactFlowNode(
          `tool-${corrId}`, 'tool', entry.status, entry.payload, entry.timestamp,
          `Tool · ${entry.payload.toolName}`,
        ));
        // Calls edge from parent
        const parentId = `agent-${entry.payload.parentCorrelationId}`;
        if (state.agentNodes.has(entry.payload.parentCorrelationId)) {
          edgeList.push(makeReactFlowEdge(
            `e-calls-${parentId}-tool-${corrId}`,
            parentId,
            `tool-${corrId}`,
            'calls',
          ));
        }
      } else if (state.fileNodes.has(corrId)) {
        const entry = state.fileNodes.get(corrId)!;
        nodeList.push(makeReactFlowNode(
          corrId, 'file', entry.status, entry.payload, entry.timestamp,
          `File: ${entry.payload.filePath.split('/').pop() ?? entry.payload.filePath}`,
        ));
        // Reads/writes edge from parent tool
        const edgeType: GraphEdgeType = entry.payload.operation === 'write' ? 'writes' : 'reads';
        const parentToolId = `tool-${entry.payload.parentToolId}`;
        if (state.toolNodes.has(entry.payload.parentToolId)) {
          edgeList.push(makeReactFlowEdge(
            `e-${edgeType}-${parentToolId}-${corrId}`,
            parentToolId,
            corrId,
            edgeType,
          ));
        }
      }
    }

    // Functional updater: only replace nodes that changed identity
    setNodes((currentNodes) => {
      const nodeIdSet = new Set(nodeList.map(n => n.id));
      const merged = currentNodes.filter(n => nodeIdSet.has(n.id));
      for (const node of nodeList) {
        const idx = merged.findIndex(n => n.id === node.id);
        if (idx >= 0) {
          if (merged[idx] !== node) {
            merged[idx] = node;
          }
        } else {
          merged.push(node);
        }
      }
      return merged;
    });
    setEdges(edgeList);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionDeliveries, sessionId]);

  const [nodes, setNodes, rawOnNodesChange] = useNodesState<MonitorNodeData>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  // Stable ref for edges — prevents onNodesChange from depending on edges
  const edgesRef = useRef(edges);
  edgesRef.current = edges;

  // ── Vertical layout on dimension measurement ───────────────────────────────
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    rawOnNodesChange(changes);

    const hasDimensionChange = changes.some((c) => (c as any).type === 'dimensions');
    if (!hasDimensionChange) return;

    const PADDING = 24;
    setNodes((current) => {
      let accY = 0;
      let changed = false;
      const updated = current.map((node) => {
        const height = node.height ?? 350;
        const targetY = accY;
        accY += height + PADDING;
        if (node.position.y !== targetY) {
          changed = true;
          return { ...node, position: { ...node.position, y: targetY } };
        }
        return node;
      });
      if (changed) {
        setLayoutVersion(v => v + 1);
      }
      return changed ? updated : current;
    });

    // edgesRef avoids adding edges to useCallback deps per Spec #275
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _currentEdges = edgesRef.current;
  }, [rawOnNodesChange, setNodes]);

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
