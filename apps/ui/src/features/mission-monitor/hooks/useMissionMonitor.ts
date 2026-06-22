import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useNodesState, useEdgesState } from 'reactflow';
import type { Node, Edge, NodeChange } from 'reactflow';
import { useStream } from '../../../shared/contexts/StreamContext';
import type { FredoEvent } from '../../../shared/contexts/StreamContext';
import type { MonitorNodeData, MonitorNodeStatus } from '../types';
import { eventPayload, isFinalPart } from '../lib/contract';
import type { TurnPayload } from '../lib/contract';
import type { ChatNodeContract, SubagentContract, SubscriptionDelivery } from '../../../shared/classes/EventSubscription';
import { globalSubscriptionState } from '../MissionMonitorFeature';
import { persistContracts } from '../lib/sessionStorage';
import type { StoredSessionContracts } from '../lib/sessionStorage';

// ── Subscription-Driven Processing (live and replay) ─────────────────────────

/**
 * Internal state for the subscription processor.
 * Manages the lifecycle of ChatNodeContract and SubagentContract assembly from raw events.
 */
interface SubscriptionProcessorState {
  /** Map of correlationId (user messageID) → partial ChatNodeContract */
  contracts: Map<string, ChatNodeContract>;
  /** Maps assistant messageID → parent user messageID (correlationId) */
  assistantParentMap: Map<string, string>;
  /** Buffered parts keyed by assistant messageID (arrived before assistant message.updated) */
  pendingParts: Map<string, Array<{ type: string; text: string; partId: string; tool?: string }>>;
  /** Counter for unique tool part IDs per turn */
  toolPartIds: Map<string, Set<string>>;
  /** Counter for unique file paths per turn */
  filePaths: Map<string, Set<string>>;
  /** Ordered list of correlationIds for edge linking */
  nodeOrder: string[];
  /** Subagent contracts keyed by a composite key (parentCorrId:subagentType:agentName) */
  subagentContracts: Map<string, SubagentContract>;
  /** Ordered list of subagent correlation IDs for edge linking */
  subagentOrder: string[];
}

export function createInitialProcessorState(): SubscriptionProcessorState {
  return {
    contracts: new Map(),
    assistantParentMap: new Map(),
    pendingParts: new Map(),
    toolPartIds: new Map(),
    filePaths: new Map(),
    nodeOrder: [],
    subagentContracts: new Map(),
    subagentOrder: [],
  };
}

// ── Payload extraction helpers ────────────────────────────────────────────────

/** Extract message info from a message.updated payload (handles both wrapped and unwrapped). */
function extractInfo(payload: Record<string, any>): Record<string, any> {
  const props = (payload.properties ?? {}) as Record<string, any>;
  return (props.info ?? payload.info ?? {}) as Record<string, any>;
}

/** Extract part from a message.part.updated payload (handles both wrapped and unwrapped). */
function extractPart(payload: Record<string, any>): Record<string, any> {
  const props = (payload.properties ?? {}) as Record<string, any>;
  return (props.part ?? payload.part ?? {}) as Record<string, any>;
}

/** Extract file path from a file.edited payload (handles both wrapped and unwrapped). */
function extractFilePath(payload: Record<string, any>): string {
  const props = (payload.properties ?? {}) as Record<string, any>;
  return String(props.file ?? payload.file_path ?? payload.file ?? '');
}

// ── Node / payload construction helpers ────────────────────────────────────────

/**
 * Compute the display label for a ChatNode title.
 */
function computeNodeLabel(agent: string | undefined, model: string | undefined): string {
  if (agent) {
    return model ? `${agent} · ${model}` : agent;
  }
  return model ?? 'Assistant';
}

function makeChatNode(
  nodeId: string,
  status: MonitorNodeStatus,
  payload: TurnPayload,
  timestamp: string,
  label: string,
): Node<MonitorNodeData> {
  return {
    id: nodeId,
    type: 'chatNode',
    position: { x: 0, y: 0 },
    data: {
      eventType: 'chat',
      status,
      payload: payload as unknown as Record<string, any>,
      timestamp,
      label,
      sublabel: (payload.responseText ?? '').slice(0, 200) || undefined,
      threadId: 'main',
      relatedEvents: [],
    },
  };
}

function makeSubagentNode(
  nodeId: string,
  contract: SubagentContract,
  timestamp: string,
): Node<MonitorNodeData> {
  const status: MonitorNodeStatus = contract.status === 'working' ? 'working' : 'inactive';
  const subagentType = contract.subagentType;
  return {
    id: nodeId,
    type: 'subagentNode',
    position: { x: 0, y: 0 },
    data: {
      eventType: subagentType,
      status,
      payload: {
        parentCorrelationId: contract.parentCorrelationId,
        agentName: contract.agentName,
        subagentType: contract.subagentType,
        status: contract.status,
        outputText: contract.outputText,
      } as unknown as Record<string, any>,
      timestamp,
      label: contract.agentName ?? (subagentType === 'subtask' ? 'Subtask' : 'Agent'),
      sublabel: contract.outputText ? contract.outputText.slice(0, 80) : undefined,
      threadId: 'main',
      relatedEvents: [],
    },
  };
}

function makeEdge(source: string, target: string): Edge {
  return {
    id: `e-${source}-${target}`,
    source,
    target,
    type: 'smoothstep',
    animated: false,
    style: { stroke: '#33415580', strokeWidth: 1.5 },
  };
}

/**
 * Convert a ChatNodeContract + lifecycle state into a TurnPayload.
 */
function contractToTurnPayload(
  contract: ChatNodeContract,
  userTimestamp: string,
): TurnPayload {
  return {
    userPrompt: contract.userMessage,
    userTimestamp,
    thinkingText: contract.agentThinking,
    responseText: contract.agentReply,
    turnTools: contract.turnTools ?? 0,
    turnFiles: contract.turnFiles ?? 0,
    model: contract.model,
    turnInputTokens: contract.turnInputTokens ?? 0,
    turnOutputTokens: contract.turnOutputTokens ?? 0,
    agent: contract.agent,
  };
}

/**
 * Process a single FredoEvent through the subscription lifecycle,
 * handling both ChatNode and Subagent contracts.
 *
 * ChatNode lifecycle:
 *   message.updated (role=user, new messageID) → Init
 *   message.part.updated (type=text, user's messageID) → Update (userMessage)
 *   message.part.updated (type=reasoning) → Update (agentThinking)
 *   message.part.updated (type=text, assistant's messageID) → Update (agentReply)
 *   message.updated (role=assistant, time.completed) → End
 *
 * Subagent lifecycle:
 *   message.part.updated (type='agent' or 'subtask') → Init with status='working'
 */
export function processChatNodeSubscription(
  state: SubscriptionProcessorState,
  event: FredoEvent,
  onDelivery: (delivery: SubscriptionDelivery<ChatNodeContract>, userTimestamp: string) => void,
  onSubagentDelivery?: (delivery: SubscriptionDelivery<SubagentContract>) => void,
): SubscriptionProcessorState {
  const payload = eventPayload(event);
  const toolName = event.toolName ?? '';

  // ── message.updated: user or assistant ──────────────────────────
  if (toolName === 'message.updated') {
    const info = extractInfo(payload);
    const id = info.id ?? '';
    if (!id) return state;

    if (info.role === 'user') {
      if (state.contracts.has(id)) return state;

      const contract: ChatNodeContract = {
        name: 'chat-node',
        userMessage: '',
        agentThinking: '',
        agentReply: '',
        agent: info.agent as string | undefined,
      };

      const next = cloneProcessorState(state);
      next.contracts.set(id, contract);
      next.nodeOrder.push(id);

      onDelivery({
        contract: { ...contract },
        lifecycle: 'Init',
        correlationId: id,
        timestamp: event.timestamp,
      }, event.timestamp);

      return next;
    }

    if (info.role === 'assistant') {
      const parentID = info.parentID ?? '';
      if (!parentID || !state.contracts.has(parentID)) return state;

      const next = cloneProcessorState(state);
      next.assistantParentMap.set(id, parentID);

      const contract = next.contracts.get(parentID)!;

      if (next.pendingParts.has(id)) {
        const parts = next.pendingParts.get(id)!;
        for (const part of parts) {
          applyPartToContract(contract, part, 'agentReply');
        }
        next.pendingParts.delete(id);
      }

      if (info.modelID) {
        contract.model = info.modelID;
      } else if (info.providerID && !contract.model) {
        contract.model = info.providerID;
      }

      const tokens = info.tokens as Record<string, any> | undefined;
      if (tokens) {
        if (typeof tokens.input === 'number') {
          contract.turnInputTokens = (contract.turnInputTokens ?? 0) + tokens.input;
        }
        if (typeof tokens.output === 'number') {
          contract.turnOutputTokens = (contract.turnOutputTokens ?? 0) + tokens.output;
        }
      }

      if (info.time?.completed) {
        const corrId = parentID;
        const files = next.filePaths.get(corrId);
        if (files && files.size > 0) {
          contract.turnFiles = files.size;
        }

        onDelivery({
          contract: { ...contract },
          lifecycle: 'End',
          correlationId: corrId,
          timestamp: event.timestamp,
        }, event.timestamp);
      } else {
        onDelivery({
          contract: { ...contract },
          lifecycle: 'Update',
          correlationId: parentID,
          timestamp: event.timestamp,
        }, event.timestamp);
      }

      return next;
    }

    return state;
  }

  // ── message.part.updated: text/reasoning/tool/agent/subtask content ──
  if (toolName === 'message.part.updated') {
    const part = extractPart(payload);
    if (!isFinalPart(part)) return state;

    const partMessageID = part.messageID ?? '';
    if (!partMessageID) return state;

    // REQ-2: Handle agent/subtask parts → create SubagentContract
    const partType = part.type ?? '';
    if (partType === 'agent' || partType === 'subtask') {
      return processSubagentPart(state, part, partMessageID, event.timestamp, onSubagentDelivery);
    }

    const partRecord = {
      type: partType,
      text: part.text ?? '',
      partId: part.id ?? '',
      tool: part.tool,
    };

    // Case 1: Part belongs to a known user message → update userMessage
    if (state.contracts.has(partMessageID)) {
      const next = cloneProcessorState(state);
      const contract = next.contracts.get(partMessageID)!;
      applyPartToContract(contract, partRecord, 'userMessage');

      onDelivery({
        contract: { ...contract },
        lifecycle: 'Update',
        correlationId: partMessageID,
        timestamp: event.timestamp,
      }, event.timestamp);

      return next;
    }

    // Case 2: Part belongs to a known assistant message → update thinking/reply
    if (state.assistantParentMap.has(partMessageID)) {
      const parentID = state.assistantParentMap.get(partMessageID)!;
      if (!state.contracts.has(parentID)) return state;

      const next = cloneProcessorState(state);
      const contract = next.contracts.get(parentID)!;
      applyPartToContract(contract, partRecord, 'agentReply');

      onDelivery({
        contract: { ...contract },
        lifecycle: 'Update',
        correlationId: parentID,
        timestamp: event.timestamp,
      }, event.timestamp);

      return next;
    }

    // Case 3: Part for an unknown assistant message → buffer
    const next = cloneProcessorState(state);
    const existing = next.pendingParts.get(partMessageID) ?? [];
    existing.push(partRecord);
    next.pendingParts.set(partMessageID, existing);
    return next;
  }

  // ── file.edited: track unique file paths per correlationId ──────
  if (toolName === 'file.edited') {
    const filePath = extractFilePath(payload);
    if (!filePath) return state;

    const lastCorrId = state.nodeOrder.length > 0
      ? state.nodeOrder[state.nodeOrder.length - 1]
      : null;
    if (!lastCorrId) return state;

    const next = cloneProcessorState(state);
    const pathSet = next.filePaths.get(lastCorrId) ?? new Set<string>();
    pathSet.add(filePath);
    next.filePaths.set(lastCorrId, pathSet);
    return next;
  }

  // Unhandled event — return state unchanged
  return state;
}

/**
 * Process a message.part.updated event whose part type is 'agent' or 'subtask'.
 * Creates or updates a SubagentContract and emits a delivery.
 */
function processSubagentPart(
  state: SubscriptionProcessorState,
  part: Record<string, any>,
  partMessageID: string,
  timestamp: string,
  onSubagentDelivery?: (delivery: SubscriptionDelivery<SubagentContract>) => void,
): SubscriptionProcessorState {
  // Determine the parent correlationId (user message ID)
  let parentCorrId: string | null = null;

  if (state.contracts.has(partMessageID)) {
    parentCorrId = partMessageID;
  } else if (state.assistantParentMap.has(partMessageID)) {
    parentCorrId = state.assistantParentMap.get(partMessageID) ?? null;
  }

  if (!parentCorrId || !state.contracts.has(parentCorrId)) {
    // No parent found — buffer this for later processing
    return state;
  }

  const subagentType = (part.type === 'subtask' ? 'subtask' : 'agent') as 'agent' | 'subtask';
  const agentName = (part.agent as string | undefined) ?? (part.name as string | undefined);
  const outputText = (part.text as string) ?? '';

  // Composite key to deduplicate subagent contracts
  const subagentKey = `${parentCorrId}:${subagentType}:${agentName ?? 'unnamed'}`;

  const next = cloneProcessorState(state);

  if (!next.subagentContracts.has(subagentKey)) {
    // Create new subagent contract
    const contract: SubagentContract = {
      name: 'subagent',
      parentCorrelationId: parentCorrId,
      agentName,
      subagentType,
      status: 'working',
      outputText,
    };

    next.subagentContracts.set(subagentKey, contract);
    if (!next.subagentOrder.includes(subagentKey)) {
      next.subagentOrder.push(subagentKey);
    }

    if (onSubagentDelivery) {
      onSubagentDelivery({
        contract: { ...contract },
        lifecycle: 'Init',
        correlationId: subagentKey,
        timestamp,
      });
    }
  } else {
    // Update existing subagent contract
    const existing = next.subagentContracts.get(subagentKey)!;
    existing.outputText = outputText;

    if (onSubagentDelivery) {
      onSubagentDelivery({
        contract: { ...existing },
        lifecycle: 'Update',
        correlationId: subagentKey,
        timestamp,
      });
    }
  }

  return next;
}

/**
 * Apply a part record to a ChatNodeContract.
 */
function applyPartToContract(
  contract: ChatNodeContract,
  part: { type: string; text: string; partId: string; tool?: string },
  textTarget: 'userMessage' | 'agentReply' = 'agentReply',
): void {
  if (part.type === 'text') {
    contract[textTarget] = (contract[textTarget] ?? '') + part.text;
  } else if (part.type === 'reasoning') {
    contract.agentThinking = (contract.agentThinking ?? '') + part.text;
  } else if (part.type === 'tool') {
    contract.turnTools = (contract.turnTools ?? 0) + 1;
  }
}

function cloneProcessorState(state: SubscriptionProcessorState): SubscriptionProcessorState {
  return {
    contracts: new Map(state.contracts),
    assistantParentMap: new Map(state.assistantParentMap),
    pendingParts: new Map(state.pendingParts),
    toolPartIds: new Map(state.toolPartIds),
    filePaths: new Map(state.filePaths),
    nodeOrder: [...state.nodeOrder],
    subagentContracts: new Map(state.subagentContracts),
    subagentOrder: [...state.subagentOrder],
  };
}

/**
 * Build ReactFlow nodes and edges from a set of stored contracts (replay mode).
 * Uses the same delivery-to-node pipeline that live mode uses.
 */
function buildGraphFromContracts(
  stored: StoredSessionContracts,
): { nodes: Node<MonitorNodeData>[]; edges: Edge[] } {
  const nodeMap = new Map<string, Node<MonitorNodeData>>();
  const chatNodeCorrIds: string[] = [];
  const edgeList: Edge[] = [];

  // Process ChatNode contracts in order
  for (const entry of stored.chatNodes) {
    const { correlationId, contract, timestamp } = entry;
    if (!chatNodeCorrIds.includes(correlationId)) {
      chatNodeCorrIds.push(correlationId);
    }

    const turnPayload = contractToTurnPayload(contract, timestamp);
    const label = computeNodeLabel(contract.agent, contract.model);
    const nodeId = `mm-${correlationId}`;

    // Determine status: if lifecycle is 'End', inactive; otherwise, working
    const status: MonitorNodeStatus = entry.lifecycle === 'End' ? 'inactive' : 'working';

    nodeMap.set(nodeId, makeChatNode(nodeId, status, turnPayload, timestamp, label));
  }

  // Create edges between chat nodes
  let prevNodeId: string | null = null;
  for (const corrId of chatNodeCorrIds) {
    const nodeId = `mm-${corrId}`;
    if (prevNodeId) {
      edgeList.push(makeEdge(prevNodeId, nodeId));
    }
    prevNodeId = nodeId;
  }

  // Process Subagent contracts in order
  for (const entry of stored.subagents) {
    const { correlationId, contract, timestamp } = entry;
    const nodeId = `sub-${correlationId}`;

    nodeMap.set(nodeId, makeSubagentNode(nodeId, contract, timestamp));

    // Connect subagent node to its parent chatNode
    const parentNodeId = `mm-${contract.parentCorrelationId}`;
    if (nodeMap.has(parentNodeId)) {
      edgeList.push(makeEdge(parentNodeId, nodeId));
    }
  }

  // Build ordered node list
  const nodeList: Node<MonitorNodeData>[] = [];
  for (const corrId of chatNodeCorrIds) {
    const nodeId = `mm-${corrId}`;
    if (nodeMap.has(nodeId)) {
      nodeList.push(nodeMap.get(nodeId)!);
    }
  }
  for (const entry of stored.subagents) {
    const nodeId = `sub-${entry.correlationId}`;
    if (nodeMap.has(nodeId)) {
      nodeList.push(nodeMap.get(nodeId)!);
    }
  }

  return { nodes: nodeList, edges: edgeList };
}

// ── Hook ──────────────────────────────────────────────────────────────────────

interface LiveModeOptions {
  sessionId: string;
  startTime: number;
}

interface MissionMonitorResult {
  nodes: Node<MonitorNodeData>[];
  edges: Edge[];
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: any[]) => void;
  layoutVersion: number;
  eventCount: number;
}

/**
 * useMissionMonitor
 *
 * - Live mode (replayContracts = undefined): subscribes to StreamContext, filters
 *   events by sessionId and startTime, applies them through subscription-driven
 *   processing (processChatNodeSubscription → onDelivery → ReactFlow nodes).
 *   Persists contracts on every lifecycle transition.
 * - Replay mode (replayContracts provided): reads stored contracts and renders
 *   identical nodes/edges via the same delivery-to-node pipeline.
 */
export function useMissionMonitor(
  options: LiveModeOptions,
  replayContracts?: StoredSessionContracts | null,
): MissionMonitorResult {
  const { sessionId, startTime } = options;
  const isReplay = replayContracts !== undefined && replayContracts !== null;

  const { events: streamEvents } = useStream();

  const [liveEvents, setLiveEvents] = useState<FredoEvent[]>([]);
  const [layoutVersion, setLayoutVersion] = useState(0);
  const seenKeysRef = useRef<Set<string>>(new Set());

  // ── Subscription processor state (live mode only, stored in ref) ───────────
  const subRef = useRef<SubscriptionProcessorState>(createInitialProcessorState());
  const processedEventCountRef = useRef(0);

  // Accumulated ReactFlow state (persists across batches so nodes don't disappear)
  const accumulatedNodesRef = useRef<Map<string, { node: Node<MonitorNodeData>; userTimestamp: string }>>(new Map());
  const accumulatedOrderRef = useRef<string[]>([]);
  const accumulatedSubagentNodesRef = useRef<Map<string, { node: Node<MonitorNodeData>; contract: SubagentContract }>>(new Map());
  const accumulatedSubagentOrderRef = useRef<string[]>([]);

  // Reset accumulated state when session changes
  useEffect(() => {
    accumulatedNodesRef.current = new Map();
    accumulatedOrderRef.current = [];
    accumulatedSubagentNodesRef.current = new Map();
    accumulatedSubagentOrderRef.current = [];
    subRef.current = createInitialProcessorState();
    processedEventCountRef.current = 0;
    seenKeysRef.current = new Set();
    setLiveEvents([]);
    setNodes([]);
    setEdges([]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Live mode: pick up new events from the stream for this session
  useEffect(() => {
    const sessionEvents = streamEvents.filter(
      (ev) =>
        ev.sessionId === sessionId &&
        new Date(ev.timestamp).getTime() >= startTime
    );

    const newEvents: FredoEvent[] = [];
    for (const ev of sessionEvents) {
      const key = ev.id ?? `${ev.toolName ?? ''}:${ev.state}:${ev.timestamp}`;
      if (!seenKeysRef.current.has(key)) {
        seenKeysRef.current.add(key);
        newEvents.push(ev);
      }
    }

    if (newEvents.length > 0) {
      setLiveEvents((prev) => [...prev, ...newEvents]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamEvents, sessionId, startTime]);

  const [nodes, setNodes, rawOnNodesChange] = useNodesState<MonitorNodeData>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  // ── Replay mode: rebuild graph from stored contracts ────────────────────
  const replayGraph = useMemo(
    () => isReplay ? buildGraphFromContracts(replayContracts!) : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isReplay, ...(isReplay ? [replayContracts] : [])]
  );

  useEffect(() => {
    if (!isReplay || !replayGraph) return;
    if (accumulatedNodesRef.current.size > 0) return;

    const { nodes: replayNodes, edges: replayEdges } = replayGraph;
    if (replayNodes.length === 0) return;

    const PADDING = 24;
    const FALLBACK_HEIGHT = 350;
    const laidOut = replayNodes.map((node, i) => ({
      ...node,
      position: { x: 0, y: i * (FALLBACK_HEIGHT + PADDING) },
    }));
    setNodes(laidOut);
    setEdges(replayEdges);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replayGraph, isReplay]);

  // ── Live mode: subscription-driven processing ───────────────────────────
  useEffect(() => {
    const prevCount = processedEventCountRef.current;
    if (liveEvents.length <= prevCount) return;

    let state = subRef.current;
    let hasChanges = false;

    // Collect deliveries from this batch
    interface PendingDelivery {
      delivery: SubscriptionDelivery<ChatNodeContract>;
      userTimestamp: string;
    }
    const pendingDeliveries: PendingDelivery[] = [];
    const pendingSubagentDeliveries: SubscriptionDelivery<SubagentContract>[] = [];

    for (let i = prevCount; i < liveEvents.length; i++) {
      const newState = processChatNodeSubscription(
        state,
        liveEvents[i],
        (delivery, userTimestamp) => {
          pendingDeliveries.push({ delivery, userTimestamp });
        },
        (delivery) => {
          pendingSubagentDeliveries.push(delivery);
        },
      );
      if (newState !== state) {
        hasChanges = true;
        state = newState;
      }
    }

    if (!hasChanges) {
      processedEventCountRef.current = liveEvents.length;
      return;
    }

    subRef.current = state;
    processedEventCountRef.current = liveEvents.length;

    // Process chat node deliveries — update accumulated node/edge refs
    let delivered = false;

    for (const { delivery, userTimestamp } of pendingDeliveries) {
      const { contract, lifecycle, correlationId } = delivery;

      globalSubscriptionState.deliveries.push(delivery);

      if (lifecycle === 'Init') {
        const nodeId = `mm-${correlationId}`;
        const turnPayload = contractToTurnPayload(contract, userTimestamp);
        const label = computeNodeLabel(contract.agent, contract.model);
        const node = makeChatNode(nodeId, 'working', turnPayload, userTimestamp, label);
        accumulatedNodesRef.current.set(correlationId, { node, userTimestamp });
        if (!accumulatedOrderRef.current.includes(correlationId)) {
          accumulatedOrderRef.current.push(correlationId);
        }
        delivered = true;
      } else if (lifecycle === 'Update') {
        const existing = accumulatedNodesRef.current.get(correlationId);
        if (existing) {
          const turnPayload = contractToTurnPayload(contract, existing.userTimestamp);
          const model = contract.model ?? (existing.node.data.payload as TurnPayload).model;
          const label = computeNodeLabel(contract.agent, model);
          existing.node = makeChatNode(
            existing.node.id,
            existing.node.data.status as MonitorNodeStatus,
            turnPayload,
            existing.userTimestamp,
            label,
          );
          delivered = true;
        }
      } else if (lifecycle === 'End') {
        const existing = accumulatedNodesRef.current.get(correlationId);
        if (existing) {
          const turnPayload = contractToTurnPayload(contract, existing.userTimestamp);
          const model = contract.model ?? (existing.node.data.payload as TurnPayload).model;
          const label = computeNodeLabel(contract.agent, model);
          existing.node = makeChatNode(
            existing.node.id,
            'inactive',
            turnPayload,
            existing.userTimestamp,
            label,
          );
          delivered = true;
        }
      }
    }

    // Process subagent deliveries — update accumulated subagent node/edge refs
    for (const delivery of pendingSubagentDeliveries) {
      const { contract, lifecycle, correlationId } = delivery;

      if (lifecycle === 'Init') {
        const nodeId = `sub-${correlationId}`;
        const node = makeSubagentNode(nodeId, contract, delivery.timestamp);
        accumulatedSubagentNodesRef.current.set(correlationId, { node, contract });
        if (!accumulatedSubagentOrderRef.current.includes(correlationId)) {
          accumulatedSubagentOrderRef.current.push(correlationId);
        }
        delivered = true;
      } else if (lifecycle === 'Update') {
        const existing = accumulatedSubagentNodesRef.current.get(correlationId);
        if (existing) {
          existing.contract = contract;
          existing.node = makeSubagentNode(existing.node.id, contract, delivery.timestamp);
          delivered = true;
        }
      }
    }

    if (!delivered) return;

    // Convert accumulated refs to ReactFlow arrays
    const nodeList: Node<MonitorNodeData>[] = [];
    const edgeList: Edge[] = [];
    let prevNodeId: string | null = null;

    // Build chat nodes in order
    for (const corrId of accumulatedOrderRef.current) {
      const entry = accumulatedNodesRef.current.get(corrId);
      if (!entry) continue;
      nodeList.push(entry.node);
      if (prevNodeId) {
        edgeList.push(makeEdge(prevNodeId, entry.node.id));
      }
      prevNodeId = entry.node.id;
    }

    // Build subagent nodes connected to parent chat nodes
    for (const subCorrId of accumulatedSubagentOrderRef.current) {
      const subEntry = accumulatedSubagentNodesRef.current.get(subCorrId);
      if (!subEntry) continue;
      nodeList.push(subEntry.node);
      // Connect to parent chat node
      const parentNodeId = `mm-${subEntry.contract.parentCorrelationId}`;
      if (nodeList.some(n => n.id === parentNodeId)) {
        edgeList.push(makeEdge(parentNodeId, subEntry.node.id));
      }
    }

    // REQ-4: Persist contracts to localStorage on every lifecycle transition
    const contractsSnapshot: StoredSessionContracts = {
      sessionId,
      chatNodes: [],
      subagents: [],
    };

    for (const [corrId, entry] of accumulatedNodesRef.current) {
      const node = entry.node;
      const dataContract = node.data.payload as unknown as TurnPayload;
      const chatContract: ChatNodeContract = {
        name: 'chat-node',
        userMessage: dataContract.userPrompt ?? '',
        agentThinking: dataContract.thinkingText ?? '',
        agentReply: dataContract.responseText ?? '',
        model: dataContract.model,
        turnTools: dataContract.turnTools,
        turnFiles: dataContract.turnFiles,
        turnInputTokens: dataContract.turnInputTokens,
        turnOutputTokens: dataContract.turnOutputTokens,
        agent: dataContract.agent,
      };
      const lifecycle = node.data.status === 'inactive' ? 'End' : (node.data.status === 'working' ? 'Init' : 'Update');
      contractsSnapshot.chatNodes.push({
        correlationId: corrId,
        lifecycle: lifecycle as any,
        contract: chatContract,
        timestamp: entry.userTimestamp,
      });
    }

    for (const [subCorrId, subEntry] of accumulatedSubagentNodesRef.current) {
      contractsSnapshot.subagents.push({
        correlationId: subCorrId,
        lifecycle: subEntry.contract.status === 'inactive' ? 'End' : 'Init',
        contract: { ...subEntry.contract },
        timestamp: subEntry.node.data.timestamp,
      });
    }

    persistContracts(sessionId, contractsSnapshot);

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
  }, [liveEvents, sessionId]);

  // ── Vertical layout on dimension measurement ───────────────────────────────
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    rawOnNodesChange(changes);

    const hasDimensionChange = changes.some((c) => (c as any).type === 'dimensions');
    if (!hasDimensionChange) return;

    const PADDING = 24;
    let anyPositionChanged = false;

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
      anyPositionChanged = changed;
      return changed ? updated : current;
    });

    // REQ-7: Only increment layoutVersion when positions actually change
    if (anyPositionChanged) {
      setLayoutVersion(v => v + 1);
    }
  }, [rawOnNodesChange, setNodes]);

  // ── Event count ───────────────────────────────────────────────────────────
  const eventCount = isReplay
    ? (replayContracts!.chatNodes.length + replayContracts!.subagents.length)
    : liveEvents.length;

  return {
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
    layoutVersion,
    eventCount,
  };
}
