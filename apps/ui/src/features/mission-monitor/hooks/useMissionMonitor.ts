import { useState, useEffect, useRef, useMemo } from 'react';
import { useNodesState, useEdgesState } from 'reactflow';
import type { Node, Edge } from 'reactflow';
import { useStream } from '../../../shared/contexts/StreamContext';
import type { FredoEvent } from '../../../shared/contexts/StreamContext';
import type { MonitorNodeData, MonitorNodeStatus, NodeEventSnapshot } from '../types';
import { EVENT_TYPE_TO_NODE_TYPE, STATUS_COLORS, UPDATE_ONLY_EVENTS, FILE_TOOL_NAMES } from '../types';

const MAIN_THREAD = 'main';
const NODE_SPACING_X = 390;
const NODE_SPACING_Y = 160;

// ── Pure graph builder ────────────────────────────────────────────────────────

interface ThreadState {
  x: number;
  y: number;
  prevNodeId: string | null;
}

interface BuildState {
  nodeCounter: number;
  nodes: Node<MonitorNodeData>[];
  edges: Edge[];
  threadStates: Map<string, ThreadState>;
  activeThread: string;
  subagentThreadCount: number;
  /** Stack of [nodeId] for in-flight tool/file nodes per thread */
  toolNodeStacks: Map<string, string[]>;
  /** Most recent tool/file node id in main thread — used for permission correlation */
  lastToolNodeId: string | null;
  subagentNodeStack: Array<{ nodeId: string; parentThreadId: string }>;
  taskNodeStack: string[];
  nodeUpdates: Map<string, Partial<MonitorNodeData>>;
  /** Extra event snapshots to attach to a node (for Focus Window) */
  nodeRelatedEvents: Map<string, NodeEventSnapshot[]>;
  /** Whether a UserPromptNode has been emitted for each thread */
  promptEmitted: Set<string>;
  /**
   * Cache of message content extracted from `chat` child spans, keyed by session id.
   * `chat` spans end (and are exported) BEFORE their `invoke_agent` parent span,
   * so we stash their content here for `invoke_agent` to pick up.
   */
  chatContentCache: Map<string, { prompt?: string; response?: string; inputTokens?: number; outputTokens?: number }>;
}

function resolveNodeType(eventType: string, payload: Record<string, any>): string {
  if (eventType === 'PreToolUse') {
    const toolName: string = String(payload.tool_name ?? payload.tool ?? '');
    return FILE_TOOL_NAMES.has(toolName) ? 'fileChangedNode' : 'toolUseNode';
  }
  if (eventType === 'execute_tool') {
    const toolName: string = String(
      payload['gen_ai.tool.name'] ?? payload.tool_name ?? ''
    );
    return FILE_TOOL_NAMES.has(toolName) ? 'fileChangedNode' : 'toolUseNode';
  }
  if (eventType === 'chat' || eventType === 'invoke_agent') return 'chatNode';
  if (eventType === 'permission') return 'permissionNode';
  if (eventType === 'SessionStart') return 'sessionNode';
  return EVENT_TYPE_TO_NODE_TYPE[eventType] ?? 'toolUseNode';
}

function getLabel(
  eventType: string,
  payload: Record<string, any>
): { label: string; sublabel?: string } {
  switch (eventType) {
    case 'UserPromptSubmit':
    case 'UserPromptSubmitted':
    case 'UserPromptExpansion': {
      const text = payload.prompt ?? payload.message ?? payload.content ?? '';
      return { label: 'User Prompt', sublabel: String(text).slice(0, 60) || undefined };
    }
    case 'PreToolUse': {
      const toolName: string = String(payload.tool_name ?? payload.tool ?? '');
      if (FILE_TOOL_NAMES.has(toolName)) {
        const filePath: string =
          String(payload.path ?? payload.file_path ?? payload.file ?? payload.command ?? '').split(/[\\/]/).pop() ?? '';
        return { label: toolName, sublabel: filePath || toolName };
      }
      return { label: 'Tool Use', sublabel: toolName || undefined };
    }
    case 'execute_tool': {
      const toolName: string = String(
        payload['gen_ai.tool.name'] ?? payload.tool_name ?? ''
      );
      if (FILE_TOOL_NAMES.has(toolName)) {
        const filePath: string = String(
          payload.path ?? payload.file_path ?? ''
        ).split(/[\\/]/).pop() ?? '';
        return { label: toolName, sublabel: filePath || toolName };
      }
      return { label: 'Tool Use', sublabel: toolName || undefined };
    }
    case 'invoke_agent':
    case 'chat': {
      // Model: try standard OTLP attributes first, then extract from span.name
      // (e.g. "chat sonnet-4" stored from legacy sessions before normalization)
      const spanName: string = String(payload['span.name'] ?? '');
      const modelFromSpanName = spanName.replace(/^(chat|invoke_agent)\s*/, '').trim();
      const model: string = String(
        payload['gen_ai.response.model'] ?? payload['gen_ai.request.model'] ?? payload.model ??
        (modelFromSpanName || undefined) ?? ''
      );
      const inputTokens = payload['gen_ai.usage.input_tokens'] ?? payload.input_tokens;
      const outputTokens = payload['gen_ai.usage.output_tokens'] ?? payload.output_tokens;
      // Response text from span events (requires content capture)
      const responseText = extractAgentResponse(payload);
      let sublabel = (responseText ?? model) || undefined;
      if (!responseText && inputTokens != null && outputTokens != null) {
        sublabel = `${model ? model + ' · ' : ''}↑${inputTokens} ↓${outputTokens}`;
      }
      return { label: 'Agent Response', sublabel };
    }
    case 'permission': {
      const tool = String(payload['gen_ai.tool.name'] ?? '');
      const result = String(payload['gen_ai.tool.result'] ?? '');
      const kind = String(payload['gen_ai.tool.kind'] ?? '');
      return { label: 'Permission', sublabel: `${tool || kind}${result ? ' → ' + result : ''}` || undefined };
    }
    case 'elicitation': {
      const msg = String(payload['gen_ai.elicitation.message'] ?? payload.message ?? '');
      return { label: 'User Input', sublabel: msg.slice(0, 80) || undefined };
    }
    case 'SubagentStart': {
      const name = payload.subagent_name ?? payload.name ?? payload.agent_id ?? '';
      return { label: 'Subagent', sublabel: String(name).slice(0, 50) || undefined };
    }
    case 'TaskCreated': {
      const text = payload.task ?? payload.description ?? payload.title ?? '';
      return { label: 'Task', sublabel: String(text).slice(0, 50) || undefined };
    }
    case 'SessionStart': {
      return { label: 'Session', sublabel: 'Started' };
    }
    default: {
      const formatted = eventType.replace(/([A-Z])/g, ' $1').trim();
      return { label: formatted };
    }
  }
}

function getInitialStatus(eventType: string, payload?: Record<string, any>): MonitorNodeStatus {
  if (['SubagentStart', 'TaskCreated', 'PreToolUse', 'execute_tool'].includes(eventType)) return 'working';
  if (['invoke_agent', 'chat'].includes(eventType)) return 'working';
  if (eventType === 'permission') {
    const result = String(payload?.['gen_ai.tool.result'] ?? '').toLowerCase();
    if (result === 'approved' || result === 'granted') return 'permission_granted';
    if (result === 'denied') return 'permission_denied';
    return 'permission_required';
  }
  if (eventType === 'elicitation') return 'working';
  if (eventType === 'SessionStart') return 'inactive';
  return 'inactive';
}

/** Try to extract the last user message text from gen_ai.input.messages JSON.
 *
 * Per the OpenCode OTel docs, message content is stored as SPAN ATTRIBUTES
 * (not span events) when OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true:
 *   gen_ai.input.messages  — full prompt messages (JSON)
 *   gen_ai.output.messages — full response messages (JSON)
 *
 * OpenCode uses { role, parts: [{ type, content }] } format.
 */
function extractTextFromMessage(m: { role?: string; content?: any; parts?: Array<{type?: string; content?: string}> }): string | undefined {
  // OpenCode format: parts array
  if (Array.isArray(m.parts)) {
    const textPart = m.parts.find(p => p.type === 'text');
    if (textPart?.content) return textPart.content.slice(0, 200);
  }
  // Standard format: content field
  const content = m.content;
  if (typeof content === 'string' && content.length > 0) return content.slice(0, 200);
  if (Array.isArray(content)) {
    const text = content.find((c: any) => c.type === 'text')?.text;
    if (text) return String(text).slice(0, 200);
  }
  return undefined;
}

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

/** Extract last assistant message text from gen_ai.output.messages JSON. */
function extractAgentResponse(payload: Record<string, any>): string | undefined {
  try {
    const raw = payload['gen_ai.output.messages'];
    if (!raw) return undefined;
    const msgs: Array<any> = typeof raw === 'string' ? JSON.parse(raw) : raw;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'assistant') {
        // Skip pure reasoning parts; prefer 'text' type
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

/** Inject a synthetic UserPromptNode into the build state. */
function injectUserPromptNode(
  s: BuildState,
  ev: FredoEvent,
  promptText: string | undefined,
  threadId: string,
  inputTokens?: number,
) {
  const nodeId = `mm-${++s.nodeCounter}`;
  const threadState = s.threadStates.get(threadId) ?? { x: 0, y: 0, prevNodeId: null };
  const sublabel = promptText ?? '(prompt)';
  const nodeData: MonitorNodeData = {
    eventType: 'UserPromptSubmit',
    status: 'inactive',
    payload: { prompt: sublabel, ...(inputTokens != null && { 'gen_ai.usage.input_tokens': inputTokens }) },

    timestamp: ev.timestamp,
    label: 'User Prompt',
    sublabel,
    threadId,
    relatedEvents: [{ eventType: 'UserPromptSubmit', payload: { prompt: sublabel }, timestamp: ev.timestamp }],
  };
  s.nodes.push({ id: nodeId, type: 'userPromptNode', position: { x: threadState.x, y: threadState.y }, data: nodeData });
  if (threadState.prevNodeId) {
    s.edges.push({
      id: `e-${threadState.prevNodeId}-${nodeId}`,
      source: threadState.prevNodeId, target: nodeId,
      type: 'smoothstep', animated: false,
      style: { stroke: STATUS_COLORS.inactive + '80', strokeWidth: 1.5 },
    });
  }
  s.threadStates.set(threadId, { ...threadState, x: threadState.x + NODE_SPACING_X, prevNodeId: nodeId });
  s.nodeRelatedEvents.set(nodeId, nodeData.relatedEvents);
  s.promptEmitted.add(threadId);
}

/** Extract the usable payload from a FredoEvent regardless of transport. */
function eventPayload(ev: FredoEvent): Record<string, any> {
  // Prefer ev.payload — the OpenCodeAdapter stores merged attributes there.
  const directPayload = (ev.payload ?? {}) as Record<string, any>;
  if (ev.transport === 'otlp_grpc' || ev.transport === 'otlp_http') {
    // OTLP events: also check metadata.attributes (legacy path from StreamEvent.otlp)
    const meta = ev.metadata as Record<string, any> | null;
    const metaAttrs = (meta?.attributes ?? {}) as Record<string, any>;
    // Merge — direct payload wins for overlapping keys
    return { ...metaAttrs, ...directPayload };
  }
  return directPayload;
}

function addRelatedEvent(s: BuildState, nodeId: string, ev: FredoEvent, eventType: string) {
  const snap: NodeEventSnapshot = {
    eventType,
    payload: eventPayload(ev),
    timestamp: ev.timestamp,
  };
  const existing = s.nodeRelatedEvents.get(nodeId) ?? [];
  s.nodeRelatedEvents.set(nodeId, [...existing, snap]);
}

function processOneEvent(ev: FredoEvent, s: BuildState) {
  // Determine event type — hook events embed it in the payload; OTLP uses toolName.
  const payload = eventPayload(ev);
  const hookEventType: string | undefined =
    typeof payload.event_type === 'string' ? payload.event_type : undefined;
  // Normalize OTLP span names (handles old stored sessions with "invoke_agent <model>" etc.)
  const rawType: string = hookEventType ?? ev.toolName ?? 'unknown';
  const eventType: string =
    rawType === 'invoke_agent' || rawType.startsWith('invoke_agent ') ? 'invoke_agent' :
    rawType === 'execute_tool' || rawType.startsWith('execute_tool ') ? 'execute_tool' :
    rawType === 'permission' || rawType.startsWith('permission ') ? 'permission' :
    rawType === 'PermissionRequest' || rawType === 'PermissionDenied' ? 'permission' :
    rawType.startsWith('permission.') ? 'permission' :
    rawType === 'elicitation' || rawType.startsWith('elicitation ') ? 'elicitation' :
    // Chat spans now create their own ChatNode (no longer dropped)
    rawType === 'chat' || rawType.startsWith('chat ') ? 'chat' :
    rawType;

  // ── Ignore SessionEnd lifecycle events ──────────────────────────────────
  // SessionStart now creates a SessionNode (handled in create-node section).
  if (eventType === 'SessionEnd') return;

  // ── `chat` spans: cache their message content, then create a ChatNode.
  //    They arrive BEFORE invoke_agent (child ends first), so we stash content
  //    here for invoke_agent to pick up.  ──────────────────────────────────────
  if (eventType === 'chat') {
    const sessionKey = s.activeThread;
    const cached = s.chatContentCache.get(sessionKey) ?? {};
    const prompt = extractUserPrompt(payload);
    const response = extractAgentResponse(payload);
    const rawIn = payload['gen_ai.usage.input_tokens'];
    const rawOut = payload['gen_ai.usage.output_tokens'];
    const inputTokens = typeof rawIn === 'number' ? rawIn : (typeof rawIn === 'string' ? parseInt(rawIn, 10) || undefined : undefined);
    const outputTokens = typeof rawOut === 'number' ? rawOut : (typeof rawOut === 'string' ? parseInt(rawOut, 10) || undefined : undefined);
    s.chatContentCache.set(sessionKey, {
      prompt: prompt ?? cached.prompt,
      response: response ?? cached.response,
      inputTokens: inputTokens ?? cached.inputTokens,
      outputTokens: outputTokens ?? cached.outputTokens,
    });
    console.log('[MM] chat span cached', { sessionKey, prompt: prompt?.slice(0, 60), response: response?.slice(0, 60), inputTokens, outputTokens });
    // Fall through to create a ChatNode for this chat span.
  }

  // ── For OTLP invoke_agent: inject a UserPromptNode if we haven't yet ─────
  if (eventType === 'invoke_agent' && !s.promptEmitted.has(s.activeThread)) {
    // Prefer content cached from the child `chat` span; fall back to this span's attrs
    const cached = s.chatContentCache.get(s.activeThread);
    const promptText = cached?.prompt ?? extractUserPrompt(payload);
    console.log('[MM] invoke_agent prompt', { promptText, hasCached: !!cached, attribKeys: Object.keys(payload) });
    injectUserPromptNode(s, ev, promptText, s.activeThread, cached?.inputTokens);
  }

  // ── Update-only events ────────────────────────────────────────────────────
  if (UPDATE_ONLY_EVENTS.has(eventType)) {
    if (eventType === 'PostToolUse' || eventType === 'PostToolBatch') {
      const stack = s.toolNodeStacks.get(s.activeThread) ?? [];
      const targetId = stack.pop();
      if (targetId) {
        const newStatus: MonitorNodeStatus = 'inactive';
        s.nodeUpdates.set(targetId, { status: newStatus });
        addRelatedEvent(s, targetId, ev, eventType);
      }
    } else if (eventType === 'PostToolUseFailure') {
      const stack = s.toolNodeStacks.get(s.activeThread) ?? [];
      const targetId = stack.pop();
      if (targetId) {
        s.nodeUpdates.set(targetId, { status: 'error' });
        addRelatedEvent(s, targetId, ev, eventType);
      }
    } else if (eventType === 'SubagentStop') {
      const entry = s.subagentNodeStack.pop();
      if (entry) {
        s.nodeUpdates.set(entry.nodeId, { status: 'inactive' });
        addRelatedEvent(s, entry.nodeId, ev, eventType);
        s.activeThread = entry.parentThreadId;
      }
    } else if (eventType === 'TaskCompleted') {
      const targetId = s.taskNodeStack.pop();
      if (targetId) {
        s.nodeUpdates.set(targetId, { status: 'inactive' });
        addRelatedEvent(s, targetId, ev, eventType);
      }
    }
    return;
  }

  // ── Create-node events ────────────────────────────────────────────────────
  const nodeId = `mm-${++s.nodeCounter}`;
  const nodeType = resolveNodeType(eventType, payload);
  let { label, sublabel } = getLabel(eventType, payload);
  // For invoke_agent, enrich sublabel with response text cached from the
  // child `chat` span (which carries gen_ai.output.messages).
  if (eventType === 'invoke_agent') {
    const cached = s.chatContentCache.get(s.activeThread);
    if (cached?.response && !sublabel?.trim()) {
      sublabel = cached.response;
    } else if (cached?.response) {
      // sublabel may already have model name — append response
      sublabel = cached.response;
    }
    console.log('[MM] invoke_agent node', { sublabel: sublabel?.slice(0, 60), cached: !!cached, payloadKeys: Object.keys(payload) });
  }

  // Enrich invoke_agent payload with token counts cached from child chat span
  const nodePayload: Record<string, any> = (() => {
    if (eventType !== 'invoke_agent') return payload;
    const c = s.chatContentCache.get(s.activeThread);
    if (!c) return payload;
    return {
      ...payload,
      ...(c.inputTokens != null && { 'gen_ai.usage.input_tokens': c.inputTokens }),
      ...(c.outputTokens != null && { 'gen_ai.usage.output_tokens': c.outputTokens }),
    };
  })();

  // If invoke_agent already has a cached response (chat span arrived first),
  // the node is complete — start as inactive instead of working.
  const hasCachedResponse = eventType === 'invoke_agent' && !!s.chatContentCache.get(s.activeThread)?.response;
  const status: MonitorNodeStatus = hasCachedResponse ? 'inactive' : getInitialStatus(eventType, nodePayload);
  const threadId = s.activeThread;
  const threadState = s.threadStates.get(threadId) ?? { x: 0, y: 0, prevNodeId: null };

  const initialRelated: NodeEventSnapshot[] = [{
    eventType,
    payload: nodePayload,
    timestamp: ev.timestamp,
  }];
  s.nodeRelatedEvents.set(nodeId, initialRelated);

  const nodeData: MonitorNodeData = {
    eventType,
    status,
    payload: nodePayload,
    timestamp: ev.timestamp,
    label,
    sublabel,
    threadId,
    relatedEvents: initialRelated,
  };

  s.nodes.push({
    id: nodeId,
    type: nodeType,
    position: { x: threadState.x, y: threadState.y },
    data: nodeData,
  });

  if (threadState.prevNodeId) {
    const color = STATUS_COLORS[status];
    s.edges.push({
      id: `e-${threadState.prevNodeId}-${nodeId}`,
      source: threadState.prevNodeId,
      target: nodeId,
      type: 'smoothstep',
      animated: status === 'working',
      style: { stroke: color + '80', strokeWidth: 1.5 },
    });
  }

  s.threadStates.set(threadId, {
    ...threadState,
    x: threadState.x + NODE_SPACING_X,
    prevNodeId: nodeId,
  });

  // Track tool/file nodes for state updates
  if (nodeType === 'toolUseNode' || nodeType === 'fileChangedNode') {
    const stack = s.toolNodeStacks.get(threadId) ?? [];
    stack.push(nodeId);
    s.toolNodeStacks.set(threadId, stack);
    s.lastToolNodeId = nodeId;
  }

  // Mark prompt emitted for hook-based user prompt events
  if (nodeType === 'userPromptNode') {
    s.promptEmitted.add(threadId);
  }

  // After invoke_agent is placed, reset turn state so the next round of
  // conversation can inject a fresh UserPromptNode.
  if (eventType === 'invoke_agent') {
    s.promptEmitted.delete(threadId);
    s.chatContentCache.delete(threadId);
  }

  if (eventType === 'TaskCreated') s.taskNodeStack.push(nodeId);

  if (eventType === 'SubagentStart') {
    const newThreadId = `subagent-${++s.subagentThreadCount}`;
    const newY = s.subagentThreadCount * NODE_SPACING_Y;
    s.threadStates.set(newThreadId, {
      x: threadState.x + NODE_SPACING_X,
      y: newY,
      prevNodeId: nodeId,
    });
    s.toolNodeStacks.set(newThreadId, []);
    s.subagentNodeStack.push({ nodeId, parentThreadId: threadId });
    s.activeThread = newThreadId;
  }
}

/**
 * Pure function — builds a complete ReactFlow graph from a list of events.
 * Works with both hook-style (agent_session) events and OTLP span events.
 */
export function buildGraphFromEvents(
  events: FredoEvent[]
): { nodes: Node<MonitorNodeData>[]; edges: Edge[] } {
  if (events.length === 0) {
    return { nodes: [], edges: [] };
  }

  const state: BuildState = {
    nodeCounter: 0,
    nodes: [],
    edges: [],
    threadStates: new Map([[MAIN_THREAD, { x: 0, y: 0, prevNodeId: null }]]),
    activeThread: MAIN_THREAD,
    subagentThreadCount: 0,
    toolNodeStacks: new Map([[MAIN_THREAD, []]]),
    lastToolNodeId: null,
    subagentNodeStack: [],
    taskNodeStack: [],
    nodeUpdates: new Map(),
    nodeRelatedEvents: new Map(),
    promptEmitted: new Set(),
    chatContentCache: new Map(),
  };

  // Sort events: chat child spans FIRST (so they populate the content cache),
  // then invoke_agent (so it can read the cache and inject UserPromptNode),
  // then execute_tool, then everything else — within each bucket by timestamp.
  const OP_ORDER: Record<string, number> = { chat: 0, invoke_agent: 1, execute_tool: 2, permission: 3, elicitation: 3 };
  const opOrder = (ev: FredoEvent) => {
    const t = ev.toolName ?? '';
    // Also handle "chat <model>" prefix
    const base = t.startsWith('chat ') ? 'chat' : t;
    return OP_ORDER[base] ?? 4;
  };
  const sorted = [...events].sort((a, b) => {
    const oa = opOrder(a), ob = opOrder(b);
    if (oa !== ob) return oa - ob;
    return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
  });

  for (const ev of sorted) {
    try {
      processOneEvent(ev, state);
    } catch (err) {
      console.error('[MM] processOneEvent failed for event:', ev, err);
    }
  }

  // Apply pending node data patches and merge related events
  const nodes = state.nodes.map((n) => {
    const patch = state.nodeUpdates.get(n.id);
    const relatedEvents = state.nodeRelatedEvents.get(n.id) ?? n.data.relatedEvents;

    // Update edge animation to match final node status
    if (patch?.status) {
      const edgeIdx = state.edges.findIndex((e) => e.target === n.id);
      if (edgeIdx !== -1) {
        const color = STATUS_COLORS[patch.status as MonitorNodeStatus];
        state.edges[edgeIdx] = {
          ...state.edges[edgeIdx],
          animated: patch.status === 'working',
          style: { stroke: color + '80', strokeWidth: 1.5 },
        };
      }
    }

    return patch || relatedEvents !== n.data.relatedEvents
      ? { ...n, data: { ...n.data, ...patch, relatedEvents } }
      : n;
  });

  const result = { nodes, edges: state.edges };
  return result;
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

  const [nodes, setNodes, onNodesChange] = useNodesState<MonitorNodeData>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  useEffect(() => { setNodes(computedNodes); }, [computedNodes, setNodes]);
  useEffect(() => { setEdges(computedEdges); }, [computedEdges, setEdges]);

  return { nodes, edges, onNodesChange, onEdgesChange, eventCount: eventsToProcess.length };
}
