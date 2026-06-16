import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useNodesState, useEdgesState } from 'reactflow';
import type { Node, Edge, NodeChange } from 'reactflow';
import { useStream } from '../../../shared/contexts/StreamContext';
import type { FredoEvent } from '../../../shared/contexts/StreamContext';
import type { MonitorNodeData, MonitorNodeStatus } from '../types';
import { eventPayload, isFinalPart } from '../lib/contract';
import type { TurnPayload } from '../lib/contract';

// ── Stateless Turn Grouping (UNCHANGED — REQ-8: legacy replay mode) ────────────

/**
 * Pure function — groups FredoEvents into turns by messageID/parentID.
 * Returns ONLY ChatNode nodes (REQ-4). No mutable state, no deferred queues,
 * no cross-turn caches (REQ-3).
 *
 * UNCHANGED for replay mode (REQ-8). Live mode uses reduceGraph instead.
 */
export function buildGraphFromEvents(
  events: FredoEvent[]
): { nodes: Node<MonitorNodeData>[]; edges: Edge[] } {
  if (events.length === 0) {
    return { nodes: [], edges: [] };
  }

  // Step 1: Normalize — extract payload using contract.ts
  const normalized = events.map(ev => ({ ev, payload: eventPayload(ev) }));

  // Step 2: Partition events by toolName
  const messageUpdated: typeof normalized = [];
  const partUpdated: typeof normalized = [];
  const fileEdited: typeof normalized = [];
  const otherEvents: typeof normalized = [];

  for (const item of normalized) {
    const toolName = item.ev.toolName ?? '';
    if (toolName === 'message.updated') {
      messageUpdated.push(item);
    } else if (toolName === 'message.part.updated') {
      partUpdated.push(item);
    } else if (toolName === 'file.edited') {
      fileEdited.push(item);
    } else {
      otherEvents.push(item);
    }
  }

  // Step 3: Extract structured data

  // 3a. Build message map from message.updated events
  const messageMap = new Map<string, {
    id: string; role: string; sessionID: string; parentID?: string;
    tokens?: Record<string, any>; time?: { created: number; completed?: number };
    modelID?: string; providerID?: string; timestamp: string;
  }>();

  for (const item of messageUpdated) {
    const props = (item.payload.properties ?? {}) as Record<string, any>;
    const info = (props.info ?? item.payload.info ?? {}) as Record<string, any>;
    const id = info.id ?? '';
    if (!id) continue;
    messageMap.set(id, {
      id, role: info.role ?? '', sessionID: info.sessionID ?? '',
      parentID: info.parentID, tokens: info.tokens, time: info.time,
      modelID: info.modelID, providerID: info.providerID,
      timestamp: item.ev.timestamp,
    });
  }

  // 3b. Build parts list from message.part.updated events (REQ-6: filter deltas)
  const parts: Array<{
    partId: string; messageID: string; type: string; text: string; tool?: string;
  }> = [];
  for (const item of partUpdated) {
    const props = (item.payload.properties ?? {}) as Record<string, any>;
    const part = (props.part ?? item.payload.part ?? {}) as Record<string, any>;
    if (!isFinalPart(part)) continue;
    parts.push({
      partId: part.id ?? '',
      messageID: part.messageID ?? '',
      type: part.type ?? '',
      text: part.text ?? '',
      tool: part.tool,
    });
  }

  // 3c. Build file edit list
  const fileEdits: Array<{ file: string; timestamp: string }> = [];
  for (const item of fileEdited) {
    const props = (item.payload.properties ?? {}) as Record<string, any>;
    const filePath = props.file ?? item.payload.file_path ?? item.payload.file ?? '';
    if (!filePath) continue;
    fileEdits.push({ file: String(filePath), timestamp: item.ev.timestamp });
  }

  // Step 4-6: Check if we have message.updated events (new format)
  const hasMessageUpdatedEvents = messageUpdated.length > 0;

  if (!hasMessageUpdatedEvents) {
    // Step 6 (REQ-12): Legacy fallback — create ChatNodes from OTLP events
    return buildLegacyGraph(otherEvents);
  }

  // Normal path: group user→assistant turns by messageID/parentID

  // Build user messages from the DEDUPLICATED messageMap (not messageUpdated).
  // messageUpdated contains ALL message.updated events — including duplicates for the
  // same message ID (the SDK emits multiple updates per message). Using messageMap
  // ensures each message appears exactly once, preventing duplicate ChatNodes.
  const userMessages = [...messageMap.values()]
    .filter(m => m.role === 'user')
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  const nodes: Node<MonitorNodeData>[] = [];
  const edges: Edge[] = [];
  let nodeCounter = 0;
  let prevNodeId: string | null = null;

  // Step 4-5: Group into turns
  for (const userMsg of userMessages) {
    const userMsgId = userMsg.id;
    if (!userMsgId) continue;

    // Find assistant message linked via parentID (from messageMap, already deduplicated)
    const assistantMsg = [...messageMap.values()]
      .find(msg => msg.role === 'assistant' && msg.parentID === userMsgId);
    if (!assistantMsg) continue;

    // REQ-5: Skip incomplete turns (missing time.completed)
    if (!assistantMsg.time?.completed) continue;

    // Collect user prompt text
    const userParts = parts.filter(p => p.messageID === userMsgId && p.type === 'text');
    const userPromptText = userParts.map(p => p.text).join('\n');

    // Collect thinking text
    const thinkingParts = parts.filter(p => p.messageID === assistantMsg.id && p.type === 'reasoning');
    const thinkingText = thinkingParts.map(p => p.text).join('\n');

    // Collect response text
    const responseParts = parts.filter(p => p.messageID === assistantMsg.id && p.type === 'text');
    const responseText = responseParts.map(p => p.text).join('\n');

    // Count tools (unique part IDs)
    const toolParts = parts.filter(p => p.messageID === assistantMsg.id && p.type === 'tool');
    const toolCount = new Set(toolParts.map(p => p.partId)).size;

    // D: Ghost node guard — skip turns with no user text AND no response text
    if (!userPromptText.trim() && !responseText.trim()) continue;

    // Count files edited within this turn's time window
    const userTs = new Date(userMsg.timestamp).getTime();
    const assistantTs = assistantMsg.time.completed * 1000;
    const filePathsInTurn = new Set(
      fileEdits
        .filter(f => {
          const fTs = new Date(f.timestamp).getTime();
          return fTs >= userTs && fTs <= assistantTs;
        })
        .map(f => f.file)
    );
    const fileCount = filePathsInTurn.size;

    const model = assistantMsg.modelID ?? assistantMsg.providerID ?? undefined;

    const turnPayload: TurnPayload = {
      userPrompt: userPromptText,
      userTimestamp: userMsg.timestamp,
      thinkingText,
      responseText,
      turnTools: toolCount,
      turnFiles: fileCount,
      model,
    };

    const nodeId = `mm-${++nodeCounter}`;
    const nodeLabel = model ?? 'Assistant';

    nodes.push({
      id: nodeId,
      type: 'chatNode',
      position: { x: 0, y: 0 },
      data: {
        eventType: 'chat',
        status: 'inactive',
        payload: turnPayload as unknown as Record<string, any>,
        timestamp: userMsg.timestamp,
        label: nodeLabel,
        sublabel: responseText.slice(0, 200) || undefined,
        threadId: 'main',
        relatedEvents: [],
      },
    });

    if (prevNodeId) {
      edges.push({
        id: `e-${prevNodeId}-${nodeId}`,
        source: prevNodeId,
        target: nodeId,
        type: 'smoothstep',
        animated: false,
        style: { stroke: '#33415580', strokeWidth: 1.5 },
      });
    }

    prevNodeId = nodeId;
  }

  return { nodes, edges };
}

// ── Legacy fallback helpers (REQ-12) ──────────────────────────────────────────

/**
 * Try to extract the last user message text from gen_ai.input.messages JSON.
 * Used by legacy fallback for OTLP events.
 */
function extractTextFromMessage(m: {
  role?: string; content?: any; parts?: Array<{ type?: string; content?: string }>;
}): string | undefined {
  if (Array.isArray(m.parts)) {
    const textPart = m.parts.find(p => p.type === 'text');
    if (textPart?.content) return textPart.content.slice(0, 200);
  }
  const content = m.content;
  if (typeof content === 'string' && content.length > 0) return content.slice(0, 200);
  if (Array.isArray(content)) {
    const text = content.find((c: any) => c.type === 'text')?.text;
    if (text) return String(text).slice(0, 200);
  }
  return undefined;
}

/** Extract user prompt from OTLP payload (legacy fallback). */
function extractUserPrompt(payload: Record<string, any>): string | undefined {
  try {
    const raw = payload['gen_ai.input.messages'];
    if (!raw) return undefined;
    const msgs: Array<any> = typeof raw === 'string' ? JSON.parse(raw) : raw;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') {
        const text = extractTextFromMessage(msgs[i]);
        if (text) return text;
      }
    }
  } catch { /* ignore parse errors */ }
  return undefined;
}

/** Extract assistant response from OTLP payload (legacy fallback). */
function extractAgentResponse(payload: Record<string, any>): string | undefined {
  try {
    const raw = payload['gen_ai.output.messages'];
    if (!raw) return undefined;
    const msgs: Array<any> = typeof raw === 'string' ? JSON.parse(raw) : raw;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'assistant') {
        if (Array.isArray(msgs[i].parts)) {
          const textPart = msgs[i].parts.find((p: any) => p.type === 'text');
          if (textPart?.content) return String(textPart.content).slice(0, 200);
        }
        const text = extractTextFromMessage(msgs[i]);
        if (text) return text;
      }
    }
  } catch { /* ignore */ }
  return undefined;
}

/**
 * Legacy fallback (REQ-12): create ChatNodes from OTLP chat/invoke_agent events
 * when no message.updated events exist (old localStorage sessions).
 */
function buildLegacyGraph(
  otherEvents: Array<{ ev: FredoEvent; payload: Record<string, any> }>
): { nodes: Node<MonitorNodeData>[]; edges: Edge[] } {
  const nodes: Node<MonitorNodeData>[] = [];
  const edges: Edge[] = [];
  let nodeCounter = 0;
  let prevNodeId: string | null = null;

  // Sort by timestamp
  const sorted = [...otherEvents].sort(
    (a, b) => new Date(a.ev.timestamp).getTime() - new Date(b.ev.timestamp).getTime()
  );

  for (const item of sorted) {
    const rawType = item.ev.toolName ?? '';
    const isChat = rawType === 'chat' || rawType.startsWith('chat ');
    const isInvokeAgent = rawType === 'invoke_agent' || rawType.startsWith('invoke_agent ');
    if (!isChat && !isInvokeAgent) continue;

    const userPrompt = extractUserPrompt(item.payload);
    const responseText = extractAgentResponse(item.payload);
    const spanName = String(item.payload['span.name'] ?? '');
    const modelFromSpan = spanName.replace(/^(chat|invoke_agent)\s*/, '').trim();
    const model = String(
      item.payload['gen_ai.response.model'] ?? item.payload['gen_ai.request.model'] ??
      item.payload.model ?? (modelFromSpan || '')
    );

    const turnPayload: TurnPayload = {
      userPrompt: userPrompt ?? '',
      userTimestamp: item.ev.timestamp,
      thinkingText: '',
      responseText: responseText ?? '',
      turnTools: 0,
      turnFiles: 0,
      model: model || undefined,
    };

    const nodeId = `mm-${++nodeCounter}`;

    nodes.push({
      id: nodeId,
      type: 'chatNode',
      position: { x: 0, y: 0 },
      data: {
        eventType: 'chat',
        status: 'inactive',
        payload: turnPayload as unknown as Record<string, any>,
        timestamp: item.ev.timestamp,
        label: model || 'Assistant',
        sublabel: (responseText ?? '').slice(0, 200) || undefined,
        threadId: 'main',
        relatedEvents: [],
      },
    });

    if (prevNodeId) {
      edges.push({
        id: `e-${prevNodeId}-${nodeId}`,
        source: prevNodeId,
        target: nodeId,
        type: 'smoothstep',
        animated: false,
        style: { stroke: '#33415580', strokeWidth: 1.5 },
      });
    }

    prevNodeId = nodeId;
  }

  return { nodes, edges };
}

// ── Incremental Graph Reducer (REQ-1: live mode) ──────────────────────────────

/**
 * Accumulated state for the incremental graph reducer.
 * Stored in useRef — not React state — to avoid render storms.
 * Only converted to React nodes/edges arrays when the ref advances.
 */
export interface IncrementalState {
  /** Map of nodeId → Node (stable identity across updates) */
  nodes: Map<string, Node<MonitorNodeData>>;
  /** Ordered edge list (links consecutive ChatNodes) */
  edges: Edge[];
  /** nodeId of the most recently created node (for edge linking) */
  prevNodeId: string | null;
  /** Maps user messageID → nodeId (REQ-2: stable lookup) */
  userNodeMap: Map<string, string>;
  /** Maps assistant messageID → parent user messageID */
  assistantParentMap: Map<string, string>;
  /** Buffered parts keyed by assistant messageID (arrived before assistant message.updated) */
  pendingParts: Map<string, Array<PartRecord>>;
  /** Maps assistant messageID → metadata (used when pending parts resolve) */
  assistantMeta: Map<string, AssistantMeta>;
  /** Incremental session counters (REQ-9) */
  counters: LiveCounters;
  /** Number of nodes that have transitioned to inactive (for REQ-7 layout trigger) */
  completedNodeCount: number;
}

export interface LiveCounters {
  tools: number;
  files: number;
  subagents: number;
  tokens: number;
}

interface PartRecord {
  type: string;
  text: string;
  partId: string;
  tool?: string;
}

interface AssistantMeta {
  completed?: number;
  modelID?: string;
  providerID?: string;
  timestamp: string;
}

/** Create a fresh empty incremental state */
export function createInitialIncrementalState(): IncrementalState {
  return {
    nodes: new Map(),
    edges: [],
    prevNodeId: null,
    userNodeMap: new Map(),
    assistantParentMap: new Map(),
    pendingParts: new Map(),
    assistantMeta: new Map(),
    counters: { tools: 0, files: 0, subagents: 0, tokens: 0 },
    completedNodeCount: 0,
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

function cloneState(state: IncrementalState): IncrementalState {
  return {
    ...state,
    nodes: new Map(state.nodes),
    edges: [...state.edges],
    userNodeMap: new Map(state.userNodeMap),
    assistantParentMap: new Map(state.assistantParentMap),
    pendingParts: new Map(state.pendingParts),
    assistantMeta: new Map(state.assistantMeta),
    counters: { ...state.counters },
  };
}

/**
 * Incremental graph reducer (REQ-1).
 *
 * Pure function: existing state + one new event → updated state.
 * Creates ChatNodes for user messages, updates existing nodes for parts,
 * marks nodes inactive on assistant completion, buffers parts that arrive
 * before their parent message link is known.
 */
export function reduceGraph(
  state: IncrementalState,
  event: FredoEvent
): IncrementalState {
  const payload = eventPayload(event);
  const toolName = event.toolName ?? '';

  // ── message.updated: user or assistant ──────────────────────────
  if (toolName === 'message.updated') {
    const info = extractInfo(payload);
    const id = info.id ?? '';
    if (!id) return state;

    if (info.role === 'user') {
      // REQ-3: Create ChatNode if not already present (ghost prevention — REQ-6)
      if (state.userNodeMap.has(id)) return state;

      const nodeId = `mm-${id}`; // REQ-2: stable ID from messageID
      const turnPayload: TurnPayload = {
        userPrompt: '',
        userTimestamp: event.timestamp,
        thinkingText: '',
        responseText: '',
        turnTools: 0,
        turnFiles: 0,
        model: info.modelID ?? info.providerID ?? undefined,
      };

      const label = info.modelID ?? info.providerID ?? 'Assistant';
      const node = makeChatNode(nodeId, 'working', turnPayload, event.timestamp, label);

      const next = cloneState(state);
      next.nodes.set(nodeId, node);
      next.userNodeMap.set(id, nodeId);

      // Link from previous node
      if (next.prevNodeId) {
        next.edges.push(makeEdge(next.prevNodeId, nodeId));
      }
      next.prevNodeId = nodeId;

      return next;
    }

    if (info.role === 'assistant') {
      const parentID = info.parentID ?? '';
      // REQ-5: Must have a parentID linking to a known user message
      if (!parentID || !state.userNodeMap.has(parentID)) return state;

      const nodeId = state.userNodeMap.get(parentID)!;
      const existingNode = state.nodes.get(nodeId);
      if (!existingNode) return state;

      const next = cloneState(state);
      next.assistantParentMap.set(id, parentID);
      next.assistantMeta.set(id, {
        completed: info.time?.completed,
        modelID: info.modelID,
        providerID: info.providerID,
        timestamp: event.timestamp,
      });

      // Update node
      const turnPayload = { ...(existingNode.data.payload ?? {}) } as Record<string, any>;

      // Set model from assistant message
      if (info.modelID) {
        turnPayload.model = info.modelID;
      } else if (info.providerID && !turnPayload.model) {
        turnPayload.model = info.providerID;
      }

      // REQ-5: Mark inactive if time.completed is set
      const newStatus: MonitorNodeStatus =
        info.time?.completed ? 'inactive' : 'working';
      const wasCompleted = newStatus === 'inactive' &&
        existingNode.data.status !== 'inactive';

      const newNode = makeChatNode(
        nodeId,
        newStatus,
        turnPayload as TurnPayload,
        event.timestamp,
        info.modelID ?? info.providerID ?? 'Assistant',
      );

      // Apply any pending parts that arrived before this assistant message.updated
      if (next.pendingParts.has(id)) {
        const parts = next.pendingParts.get(id)!;
        for (const part of parts) {
          // Pending parts for assistant messages: text → responseText
          applyPartToPayload(turnPayload, part, 'responseText');
        }
        // Fix sublabel after applying pending parts
        newNode.data.sublabel = (turnPayload.responseText ?? '').slice(0, 200) || undefined;
        next.pendingParts.delete(id);
      }

      next.nodes.set(nodeId, newNode);
      if (wasCompleted) {
        next.completedNodeCount += 1;
      }

      return next;
    }

    // Not a role we handle
    return state;
  }

  // ── message.part.updated: text/reasoning/tool content ───────────
  if (toolName === 'message.part.updated') {
    const part = extractPart(payload);
    if (!isFinalPart(part)) return state;

    const partMessageID = part.messageID ?? '';
    if (!partMessageID) return state;

    const partRecord: PartRecord = {
      type: part.type ?? '',
      text: part.text ?? '',
      partId: part.id ?? '',
      tool: part.tool,
    };

    // Case 1: Part belongs to a known user message → update userPrompt
    if (state.userNodeMap.has(partMessageID)) {
      const nodeId = state.userNodeMap.get(partMessageID)!;
      const existingNode = state.nodes.get(nodeId);
      if (!existingNode) return state;

      const turnPayload = { ...(existingNode.data.payload ?? {}) } as Record<string, any>;
      applyPartToPayload(turnPayload, partRecord, 'userPrompt');

      const updatedNode = makeChatNode(
        nodeId,
        existingNode.data.status as MonitorNodeStatus,
        turnPayload as TurnPayload,
        existingNode.data.timestamp,
        existingNode.data.label,
      );

      const next = cloneState(state);
      next.nodes.set(nodeId, updatedNode);
      return next;
    }

    // Case 2: Part belongs to a known assistant message → update thinking/response
    if (state.assistantParentMap.has(partMessageID)) {
      const parentID = state.assistantParentMap.get(partMessageID)!;
      if (!state.userNodeMap.has(parentID)) return state;

      const nodeId = state.userNodeMap.get(parentID)!;
      const existingNode = state.nodes.get(nodeId);
      if (!existingNode) return state;

      const turnPayload = { ...(existingNode.data.payload ?? {}) } as Record<string, any>;
      applyPartToPayload(turnPayload, partRecord, 'responseText');

      const updatedNode = makeChatNode(
        nodeId,
        existingNode.data.status as MonitorNodeStatus,
        turnPayload as TurnPayload,
        existingNode.data.timestamp,
        existingNode.data.label,
      );

      const next = cloneState(state);
      next.nodes.set(nodeId, updatedNode);
      return next;
    }

    // Case 3: Part for an unknown assistant message → buffer (REQ-4)
    const next = cloneState(state);
    const existing = next.pendingParts.get(partMessageID) ?? [];
    existing.push(partRecord);
    next.pendingParts.set(partMessageID, existing);
    return next;
  }

  // ── file.edited: increment file counter (REQ-9) ─────────────────
  if (toolName === 'file.edited') {
    const filePath = extractFilePath(payload);
    if (!filePath) return state;
    const next = cloneState(state);
    next.counters.files += 1;
    return next;
  }

  // Unhandled event — return state unchanged
  return state;
}

/**
 * Apply a part record to a TurnPayload-like object.
 *
 * @param payload - The mutable payload object to update
 * @param part - The part record with type and text
 * @param targetField - 'userPrompt' for user text parts, 'responseText' for assistant text parts
 */
function applyPartToPayload(
  payload: Record<string, any>,
  part: PartRecord,
  targetField: 'userPrompt' | 'responseText' = 'userPrompt',
): void {
  const pType = part.type;
  const pText = part.text;

  if (pType === 'text') {
    // Route to the correct text field based on targetField
    payload[targetField] = (payload[targetField] ?? '') + pText;
  } else if (pType === 'reasoning') {
    payload.thinkingText = (payload.thinkingText ?? '') + pText;
  } else if (pType === 'tool') {
    // Count unique tool parts per turn
    const partIds = payload._toolPartIds as string[] | undefined;
    if (!partIds || !partIds.includes(part.partId)) {
      payload._toolPartIds = [...(partIds ?? []), part.partId];
      payload.turnTools = (payload.turnTools ?? 0) + 1;
    }
  }
}

// ── Hook ──────────────────────────────────────────────────────────────────────

interface LiveModeOptions {
  sessionId: string;
  startTime: number;
}

/**
 * useMissionMonitor
 *
 * - Live mode (replayEvents = undefined): subscribes to StreamContext, filters
 *   events by sessionId and startTime, applies them incrementally via reduceGraph.
 * - Replay mode (replayEvents provided): builds graph from stored events via
 *   buildGraphFromEvents (unchanged — REQ-8).
 */
export function useMissionMonitor(
  options: LiveModeOptions,
  replayEvents?: FredoEvent[]
) {
  const { sessionId, startTime } = options;
  const isReplay = replayEvents !== undefined;

  const { events: streamEvents } = useStream();

  const [liveEvents, setLiveEvents] = useState<FredoEvent[]>([]);
  const [layoutVersion, setLayoutVersion] = useState(0);
  const [liveCounters, setLiveCounters] = useState<LiveCounters | null>(null);
  const seenKeysRef = useRef<Set<string>>(new Set());

  // ── Incremental reducer state (live mode only, stored in ref) ──────────────
  const incRef = useRef<IncrementalState>(createInitialIncrementalState());
  const processedEventCountRef = useRef(0);

  // Live mode: pick up new events from the stream for this session
  useEffect(() => {
    if (isReplay) return;

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
  }, [streamEvents, sessionId, startTime, isReplay]);

  const [nodes, setNodes, rawOnNodesChange] = useNodesState<MonitorNodeData>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  // ── Replay mode: use buildGraphFromEvents (unchanged — REQ-8) ─────────────
  const replayResult = useMemo(
    () => isReplay ? buildGraphFromEvents(replayEvents!) : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isReplay, ...(isReplay ? [replayEvents] : [])]
  );

  useEffect(() => {
    if (!isReplay || !replayResult) return;

    const { nodes: replayNodes, edges: replayEdges } = replayResult;
    if (replayNodes.length === 0) {
      setNodes([]);
      setEdges([]);
      return;
    }
    const PADDING = 24;
    const FALLBACK_HEIGHT = 350;
    const laidOut = replayNodes.map((node, i) => ({
      ...node,
      position: { x: 0, y: i * (FALLBACK_HEIGHT + PADDING) },
    }));
    setNodes(laidOut);
    setEdges(replayEdges);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replayResult, isReplay]);

  // ── Live mode: incremental reducer (REQ-1) ─────────────────────────────────
  useEffect(() => {
    if (isReplay) return;

    const prevCount = processedEventCountRef.current;
    if (liveEvents.length <= prevCount) return;

    // Apply each new event through the reducer
    const prevCompletedCount = incRef.current.completedNodeCount;
    let state = incRef.current;
    let hasChanges = false;

    for (let i = prevCount; i < liveEvents.length; i++) {
      const newState = reduceGraph(state, liveEvents[i]);
      if (newState !== state) {
        hasChanges = true;
        state = newState;
      }
    }

    if (!hasChanges) {
      processedEventCountRef.current = liveEvents.length;
      return;
    }

    incRef.current = state;
    processedEventCountRef.current = liveEvents.length;

    // Update nodes array for ReactFlow
    const allNodes = [...state.nodes.values()];

    // REQ-7: Vertical layout only on node completion (not on intermediate text deltas)
    if (state.completedNodeCount > prevCompletedCount) {
      const PADDING = 24;
      const FALLBACK_HEIGHT = 350;
      const laidOut = allNodes.map((node, i) => ({
        ...node,
        position: { x: 0, y: i * (FALLBACK_HEIGHT + PADDING) },
      }));
      setNodes(laidOut);
    } else {
      setNodes(allNodes);
    }

    setEdges(state.edges);
    setLiveCounters({ ...state.counters });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveEvents, isReplay]);

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
      return changed ? updated : current;
    });
    setLayoutVersion(v => v + 1);
  }, [rawOnNodesChange, setNodes]);

  // ── Replay mode: liveCounters = null; Live mode: from incremental state ────
  const eventCount = isReplay ? (replayEvents?.length ?? 0) : liveEvents.length;

  return {
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
    layoutVersion,
    eventCount,
    /** Incremental counters for live mode, null in replay mode (Capsule C wires this) */
    liveCounters,
  };
}
