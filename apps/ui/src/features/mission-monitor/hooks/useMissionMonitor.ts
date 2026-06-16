import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useNodesState, useEdgesState } from 'reactflow';
import type { Node, Edge, NodeChange } from 'reactflow';
import { useStream } from '../../../shared/contexts/StreamContext';
import type { FredoEvent } from '../../../shared/contexts/StreamContext';
import type { MonitorNodeData } from '../types';
import { eventPayload, isFinalPart } from '../lib/contract';
import type { TurnPayload } from '../lib/contract';

// ── Stateless Turn Grouping ────────────────────────────────────────────────────

/**
 * Pure function — groups FredoEvents into turns by messageID/parentID.
 * Returns ONLY ChatNode nodes (REQ-4). No mutable state, no deferred queues,
 * no cross-turn caches (REQ-3).
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

// ── Hook ──────────────────────────────────────────────────────────────────────

interface LiveModeOptions {
  sessionId: string;
  startTime: number;
}

/**
 * useMissionMonitor
 *
 * - Live mode (replayEvents = undefined): subscribes to StreamContext, filters
 *   events by sessionId and startTime.
 * - Replay mode (replayEvents provided): builds graph from stored events.
 */
export function useMissionMonitor(
  options: LiveModeOptions,
  replayEvents?: FredoEvent[]
) {
  const { sessionId, startTime } = options;
  const isReplay = replayEvents !== undefined;

  const { events: streamEvents } = useStream();

  const [liveEvents, setLiveEvents] = useState<FredoEvent[]>([]);
  const seenKeysRef = useRef<Set<string>>(new Set());

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

  const eventsToProcess = isReplay ? replayEvents! : liveEvents;

  const { nodes: computedNodes, edges: computedEdges } = useMemo(
    () => buildGraphFromEvents(eventsToProcess),
    [eventsToProcess]
  );

  const [nodes, setNodes, rawOnNodesChange] = useNodesState<MonitorNodeData>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  // Set computed nodes with fallback vertical layout (B)
  useEffect(() => {
    if (computedNodes.length === 0) {
      setNodes([]);
      return;
    }
    const PADDING = 24;
    const FALLBACK_HEIGHT = 350;
    const laidOut = computedNodes.map((node, i) => ({
      ...node,
      position: { x: 0, y: i * (FALLBACK_HEIGHT + PADDING) },
    }));
    setNodes(laidOut);
  }, [computedNodes, setNodes]);

  useEffect(() => { setEdges(computedEdges); }, [computedEdges, setEdges]);

  // Apply precise vertical layout when ReactFlow provides measured dimensions (B)
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
  }, [rawOnNodesChange, setNodes]);

  return { nodes, edges, onNodesChange, onEdgesChange, eventCount: eventsToProcess.length };
}
