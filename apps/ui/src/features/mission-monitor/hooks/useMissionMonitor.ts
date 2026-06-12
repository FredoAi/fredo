import { useState, useEffect, useRef, useMemo } from 'react';
import { useNodesState, useEdgesState } from 'reactflow';
import type { Node, Edge } from 'reactflow';
import { useStream } from '../../../shared/contexts/StreamContext';
import type { FredoEvent } from '../../../shared/contexts/StreamContext';
import type { MonitorNodeData, MonitorNodeStatus, NodeEventSnapshot, TurnData } from '../types';
import { STATUS_COLORS, FILE_TOOL_NAMES } from '../types';

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
  nodeUpdates: Map<string, Partial<MonitorNodeData>>;
  /** Extra event snapshots to attach to a node (for Focus Window) */
  nodeRelatedEvents: Map<string, NodeEventSnapshot[]>;
  /** Accumulated turn data per active thread */
  turnData: Map<string, TurnData>;
}

/** Create a fresh TurnData entry. */
function createTurnData(): TurnData {
  return {
    userPrompt: undefined,
    thinkingText: undefined,
    responseText: undefined,
    turnToolCount: 0,
    turnFileCount: 0,
    turnSubagentCount: 0,
    inputTokens: undefined,
    outputTokens: undefined,
    model: undefined,
    chatNodeId: undefined,
    emitted: false,
    responseComplete: false,
    relatedEvents: [],
  };
}

/** Finalize the current turn: if emitted, mark response complete. */
function finalizeCurrentTurn(s: BuildState) {
  const turn = s.turnData.get(s.activeThread);
  if (!turn?.emitted) return;
  if (!turn.chatNodeId) return;
  s.nodeUpdates.set(turn.chatNodeId, { status: 'inactive' as MonitorNodeStatus });
  turn.responseComplete = true;
}

/**
 * Emit a ChatNode for the current turn's accumulated data.
 * Sets turn.chatNodeId and turn.emitted after emission.
 */
function emitChatNode(
  s: BuildState,
  turn: TurnData,
  responseEventType: string,
  responsePayload: Record<string, any>,
  timestamp: string,
) {
  if (turn.emitted) return; // already emitted

  const nodeId = `mm-${++s.nodeCounter}`;
  const threadState = s.threadStates.get(s.activeThread) ?? { x: 0, y: 0, prevNodeId: null };

  // Build the enriched payload — merge turn data + event payload
  const nodePayload: Record<string, any> = {
    ...responsePayload,
    userPrompt: turn.userPrompt,
    thinkingText: turn.thinkingText ?? '',
    responseText: turn.responseText ?? responsePayload.response ?? '',
    turnToolCount: turn.turnToolCount,
    turnFileCount: turn.turnFileCount,
    turnSubagentCount: turn.turnSubagentCount,
    ...(turn.inputTokens != null && { 'gen_ai.usage.input_tokens': turn.inputTokens }),
    ...(turn.outputTokens != null && { 'gen_ai.usage.output_tokens': turn.outputTokens }),
    ...(turn.model != null && { model: turn.model }),
    ...(turn.userPrompt !== undefined && { hasUserPrompt: true }),
  };

  const status: MonitorNodeStatus = turn.responseComplete ? 'inactive' : 'working';

  // Get label/sublabel from the response event type
  const { label, sublabel } = getChatLabel(responsePayload, turn);
  const sublabelText = (turn.thinkingText ?? turn.responseText ?? sublabel ?? '').slice(0, 200);

  const initialRelated: NodeEventSnapshot[] = [...turn.relatedEvents];
  s.nodeRelatedEvents.set(nodeId, initialRelated);

  const nodeData: MonitorNodeData = {
    eventType: 'chat',
    status,
    payload: nodePayload,
    timestamp,
    label: label || 'Assistant',
    sublabel: sublabelText || undefined,
    threadId: s.activeThread,
    relatedEvents: initialRelated,
  };

  s.nodes.push({
    id: nodeId,
    type: 'chatNode',
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

  s.threadStates.set(s.activeThread, {
    ...threadState,
    x: threadState.x + NODE_SPACING_X,
    prevNodeId: nodeId,
  });

  turn.chatNodeId = nodeId;
  turn.emitted = true;
}

/** Get a ChatNode label from response payload and turn data. */
function getChatLabel(
  payload: Record<string, any>,
  turn: TurnData,
): { label: string; sublabel?: string } {
  // Prefer model from turn data, then from payload
  const model = turn.model
    ?? payload['gen_ai.response.model']
    ?? payload['gen_ai.request.model']
    ?? payload.model
    ?? '';

  const inputTokens = turn.inputTokens ?? payload['gen_ai.usage.input_tokens'];
  const outputTokens = turn.outputTokens ?? payload['gen_ai.usage.output_tokens'];
  const responseText = turn.responseText ?? '';

  if (responseText) {
    return { label: model || 'Assistant', sublabel: responseText };
  }
  if (inputTokens != null && outputTokens != null) {
    return { label: model || 'Assistant', sublabel: `${model ? model + ' · ' : ''}↑${inputTokens} ↓${outputTokens}` };
  }
  return { label: model || 'Assistant' };
}

/** Add a NodeEventSnapshot to a turn's related events. */
function addRelatedEventToTurn(turn: TurnData, ev: FredoEvent, eventType: string) {
  const snap: NodeEventSnapshot = {
    eventType,
    payload: eventPayload(ev),
    timestamp: ev.timestamp,
  };
  turn.relatedEvents = [...turn.relatedEvents, snap];
}

/** Update an emitted ChatNode's payload with latest turn counters. */
function updateChatNodeFromTurn(s: BuildState, turn: TurnData) {
  if (!turn.chatNodeId) return;
  s.nodeUpdates.set(turn.chatNodeId, {
    payload: {
      turnToolCount: turn.turnToolCount,
      turnFileCount: turn.turnFileCount,
      turnSubagentCount: turn.turnSubagentCount,
      thinkingText: turn.thinkingText ?? '',
      responseText: turn.responseText ?? '',
    } as any,
    status: turn.responseComplete ? 'inactive' : 'working',
  });
}

/** Extract the usable payload from a FredoEvent regardless of transport. */
function eventPayload(ev: FredoEvent): Record<string, any> {
  const directPayload = (ev.payload ?? {}) as Record<string, any>;
  if (ev.transport === 'otlp_grpc' || ev.transport === 'otlp_http') {
    const meta = ev.metadata as Record<string, any> | null;
    const metaAttrs = (meta?.attributes ?? {}) as Record<string, any>;
    return { ...metaAttrs, ...directPayload };
  }
  return directPayload;
}

/** Try to extract the last user message text from gen_ai.input.messages JSON. */
function extractTextFromMessage(m: { role?: string; content?: any; parts?: Array<{type?: string; content?: string}> }): string | undefined {
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
 * Normalize FredoEvent to an event type string.
 * Handles hook events (event_type inside payload), OTLP span names with model suffixes,
 * and permission aliases.
 */
function normalizeEventType(ev: FredoEvent): string {
  const payload = eventPayload(ev);
  const hookEventType: string | undefined =
    typeof payload.event_type === 'string' ? payload.event_type : undefined;
  const rawType: string = hookEventType ?? ev.toolName ?? 'unknown';
  return (
    rawType === 'invoke_agent' || rawType.startsWith('invoke_agent ') ? 'invoke_agent' :
    rawType === 'execute_tool' || rawType.startsWith('execute_tool ') ? 'execute_tool' :
    rawType === 'permission' || rawType.startsWith('permission ') ? 'permission' :
    rawType === 'PermissionRequest' || rawType === 'PermissionDenied' ? 'permission' :
    rawType.startsWith('permission.') ? 'permission' :
    rawType === 'elicitation' || rawType.startsWith('elicitation ') ? 'elicitation' :
    rawType === 'chat' || rawType.startsWith('chat ') ? 'chat' :
    rawType
  );
}

/** Check if an event type is a session lifecycle event (consumed for counters, no node). */
const SESSION_LIFECYCLE_EVENTS = new Set([
  'SessionStart', 'SessionEnd', 'session.created', 'session.updated',
  'session.deleted', 'session.status', 'session.error', 'session.idle',
  'session.next.agent.switched', 'session.next.step.started', 'session.next.step.ended',
]);

/** Normalize tool name from payload — handles 'chat <model>' prefix etc. */
function getNormalizedToolName(payload: Record<string, any>): string {
  const toolNameRaw: string = String(
    payload.tool_name ?? payload.tool ?? payload['gen_ai.tool.name'] ?? ''
  );
  // Handle 'chat <model>' prefix
  if (toolNameRaw.startsWith('chat ')) return 'chat';
  return toolNameRaw;
}

/**
 * Turn-oriented event processor.
 * Accumulates events into TurnData per thread. A user message starts a turn,
 * a response event finalizes it into a ChatNode. Only 'chatNode' nodes are emitted.
 */
function processOneEvent(ev: FredoEvent, s: BuildState) {
  const payload = eventPayload(ev);
  const eventType = normalizeEventType(ev);

  // ── Ignore SessionEnd ──────────────────────────────────────────────────
  if (eventType === 'SessionEnd') return;

  // ── Session lifecycle events: counters only, no nodes (AC3) ──────────
  if (SESSION_LIFECYCLE_EVENTS.has(eventType)) {
    // No nodes created for session events
    return;
  }

  // Get or create current turn
  let turn = s.turnData.get(s.activeThread);

  // ── User message events: start a new turn ─────────────────────────────
  const isUserMessage =
    eventType === 'UserPromptSubmit' ||
    eventType === 'UserPromptSubmitted' ||
    eventType === 'UserPromptExpansion' ||
    (eventType === 'message.updated' && (() => {
      const props = payload.properties as Record<string, any> | undefined;
      const info = props?.info ?? payload.info ?? {};
      // Broaden role detection: try payload.info.role, props?.info?.role, payload.role
      return (info.role ?? props?.info?.role ?? payload.info?.role ?? payload.role ?? '') === 'user';
    })());

  if (isUserMessage) {
    // Finalize previous turn's ChatNode if it was still working
    finalizeCurrentTurn(s);

    // Extract user prompt text
    let promptText: string | undefined;
    if (eventType === 'message.updated') {
      const props = payload.properties as Record<string, any> | undefined;
      const info = props?.info ?? payload.info ?? {};
      promptText = String(
        info.content ??
        props?.content ??
        props?.info?.content ??
        info.text ??
        payload.text ??
        payload.content ??
        ''
      ).slice(0, 200) || undefined;
      // Fallback for delta-based user messages where payload.delta.text contains the prompt
      if (!promptText) {
        const deltaObj = payload.delta;
        const deltaText = typeof deltaObj === 'string' ? deltaObj : (typeof deltaObj?.text === 'string' ? deltaObj.text : undefined);
        if (deltaText) {
          promptText = deltaText.slice(0, 200);
        }
      }
      // Last resort: raw payload.content
      if (!promptText && payload.content && typeof payload.content === 'string') {
        promptText = String(payload.content).slice(0, 200) || undefined;
      }
    } else {
      promptText = String(
        payload.prompt ??
        payload.message ??
        payload.content ??
        payload.text ??
        payload.user_prompt ??
        payload.input ??
        ''
      ).slice(0, 200) || undefined;
    }

    // Start new turn
    const newTurn = createTurnData();
    newTurn.userPrompt = promptText;
    addRelatedEventToTurn(newTurn, ev, eventType);
    s.turnData.set(s.activeThread, newTurn);
    turn = newTurn;
    return;
  }

  // If no turn exists yet and this is a response-bearing event, start a turn automatically
  if (!turn && (eventType === 'chat' || eventType === 'invoke_agent')) {
    turn = createTurnData();
    // Extract user prompt from the payload if possible
    const promptFromPayload = extractUserPrompt(payload);
    if (promptFromPayload) {
      turn.userPrompt = promptFromPayload;
    }
    s.turnData.set(s.activeThread, turn);
  }

  // If still no turn, ignore (orphan event not part of any conversation turn)
  if (!turn) return;

  // ── Thinking / reasoning events ──────────────────────────────────────
  if (eventType === 'message.part.updated') {
    const props = payload.properties as Record<string, any> | undefined;
    const part = props?.part ?? payload.part ?? {};
    const text = String(
      part.text ??
      part.delta?.text ??
      part.content ??
      payload.text ??
      payload.delta?.text ??
      ''
    );
    const partType = String(part.type ?? payload.type ?? '');
    if (text) {
      if (partType === 'reasoning') {
        turn.thinkingText = (turn.thinkingText ?? '') + text;
      } else {
        turn.responseText = (turn.responseText ?? '') + text;
      }
      // Update emitted ChatNode if exists
      if (turn.chatNodeId) {
        const isReasoning = partType === 'reasoning';
        s.nodeUpdates.set(turn.chatNodeId, {
          sublabel: ((isReasoning ? turn.thinkingText : turn.responseText) ?? '').slice(0, 500),
          status: 'working' as MonitorNodeStatus,
        });
      }
    }
    addRelatedEventToTurn(turn, ev, eventType);
    return;
  }

  // ── message.part.delta — accumulate into response text (or thinking if reasoning) ──
  if (eventType === 'message.part.delta') {
    const props = payload.properties as Record<string, any> | undefined;
    const deltaObj = props?.delta ?? payload.delta;
    const delta = typeof deltaObj === 'string' ? deltaObj : (typeof deltaObj?.text === 'string' ? deltaObj.text : '');
    if (delta) {
      // If we already have thinkingText and no responseText, this delta might be reasoning continuation
      // For simplicity, buffer into responseText
      turn.responseText = (turn.responseText ?? '') + delta;
      if (turn.chatNodeId) {
        const existing = s.nodeUpdates.get(turn.chatNodeId);
        const prevSublabel = String((existing as any)?.sublabel ?? '');
        s.nodeUpdates.set(turn.chatNodeId, {
          sublabel: (prevSublabel + delta).slice(0, 500),
          status: 'working' as MonitorNodeStatus,
        });
      }
    }
    addRelatedEventToTurn(turn, ev, eventType);
    return;
  }

  // ── session.next.text.delta — buffer into thinkingText (generic text stream) ──
  if (eventType === 'session.next.text.delta') {
    const props = payload.properties as Record<string, any> | undefined;
    const deltaObj = props?.delta ?? payload.delta;
    const delta = typeof deltaObj === 'string' ? deltaObj : (typeof deltaObj?.text === 'string' ? deltaObj.text : '');
    if (delta) {
      turn.thinkingText = (turn.thinkingText ?? '') + delta;
      if (turn.chatNodeId) {
        const node = s.nodes.find(n => n.id === turn.chatNodeId);
        const existingSublabel = node?.data?.sublabel ?? '';
        const newSublabel = String(existingSublabel) + delta;
        s.nodeUpdates.set(turn.chatNodeId, {
          sublabel: newSublabel.slice(0, 200),
          status: 'working' as MonitorNodeStatus,
        });
      }
    }
    addRelatedEventToTurn(turn, ev, eventType);
    return;
  }

  // ── Counting events: tools, files, subagents ──────────────────────────

  // PreToolUse / execute_tool — count as tool or file
  if (eventType === 'PreToolUse' || eventType === 'execute_tool') {
    const toolName: string = String(payload.tool_name ?? payload.tool ?? payload['gen_ai.tool.name'] ?? '');
    if (FILE_TOOL_NAMES.has(toolName)) {
      turn.turnFileCount++;
    } else {
      turn.turnToolCount++;
    }
    addRelatedEventToTurn(turn, ev, eventType);
    if (turn.chatNodeId) updateChatNodeFromTurn(s, turn);
    return;
  }

  // file.edited — count as file
  if (eventType === 'file.edited') {
    turn.turnFileCount++;
    addRelatedEventToTurn(turn, ev, eventType);
    if (turn.chatNodeId) updateChatNodeFromTurn(s, turn);
    return;
  }

  // SubagentStart — count as subagent
  if (eventType === 'SubagentStart') {
    turn.turnSubagentCount++;
    addRelatedEventToTurn(turn, ev, eventType);
    if (turn.chatNodeId) updateChatNodeFromTurn(s, turn);
    return;
  }

  // session.next.tool.called — count as tool or file
  if (eventType === 'session.next.tool.called') {
    const props = payload.properties as Record<string, any> | undefined;
    const toolName = String(props?.tool ?? props?.name ?? payload.tool_name ?? payload.tool ?? '');
    if (FILE_TOOL_NAMES.has(toolName)) {
      turn.turnFileCount++;
    } else {
      turn.turnToolCount++;
    }
    addRelatedEventToTurn(turn, ev, eventType);
    if (turn.chatNodeId) updateChatNodeFromTurn(s, turn);
    return;
  }

  // ── Response events: finalize turn, emit ChatNode ──────────────────────

  // chat OTLP spans — carry model, tokens, prompt, response
  if (eventType === 'chat') {
    // Extract chat span data and enrich turn
    const prompt = extractUserPrompt(payload);
    const response = extractAgentResponse(payload);
    const rawIn = payload['gen_ai.usage.input_tokens'];
    const rawOut = payload['gen_ai.usage.output_tokens'];
    const inputTokens = typeof rawIn === 'number' ? rawIn : (typeof rawIn === 'string' ? parseInt(rawIn, 10) || undefined : undefined);
    const outputTokens = typeof rawOut === 'number' ? rawOut : (typeof rawOut === 'string' ? parseInt(rawOut, 10) || undefined : undefined);
    const spanNameModel = String(payload['span.name'] ?? '').replace(/^(chat|invoke_agent)\s*/, '').trim();
    const model: string | undefined = (payload['gen_ai.response.model'] || payload['gen_ai.request.model'] || payload.model || spanNameModel) || undefined;

    if (prompt && !turn.userPrompt) turn.userPrompt = prompt;
    if (response) turn.responseText = (turn.responseText ?? '') + response;
    if (inputTokens != null) turn.inputTokens = inputTokens;
    if (outputTokens != null) turn.outputTokens = outputTokens;
    if (model) turn.model = model;

    addRelatedEventToTurn(turn, ev, eventType);

    // Emit ChatNode if not already emitted
    if (!turn.emitted) {
      turn.responseComplete = true; // OTLP chat spans are complete exports
      emitChatNode(s, turn, 'chat', payload, ev.timestamp);
    } else {
      // Update existing node
      updateChatNodeFromTurn(s, turn);
    }
    return;
  }

  // invoke_agent — parent of chat span, also signals completion
  if (eventType === 'invoke_agent') {
    // Enrich from payload if chat span didn't provide everything
    const modelFromPayload = payload['gen_ai.response.model'] ?? payload['gen_ai.request.model'] ?? payload.model;
    if (modelFromPayload && !turn.model) turn.model = String(modelFromPayload);

    addRelatedEventToTurn(turn, ev, eventType);

    if (!turn.emitted) {
      // Chat span may have provided the data; if not, extract from invoke_agent payload
      const response = extractAgentResponse(payload);
      if (response && !turn.responseText) turn.responseText = response;
      turn.responseComplete = true;
      emitChatNode(s, turn, 'invoke_agent', payload, ev.timestamp);
    } else {
      turn.responseComplete = true;
      updateChatNodeFromTurn(s, turn);
    }
    return;
  }

  // message.updated with role=assistant — finalize response
  if (eventType === 'message.updated') {
    const props = payload.properties as Record<string, any> | undefined;
    const info = props?.info ?? payload.info ?? {};
    const role = info.role ?? payload.role ?? '';
    if (role === 'assistant') {
      const modelFromPayload = info.modelID ?? payload.modelID ?? '';
      if (modelFromPayload && !turn.model) turn.model = String(modelFromPayload);
      const tokensFromPayload = info.tokens ?? payload.tokens;

      addRelatedEventToTurn(turn, ev, eventType);

      if (!turn.emitted) {
        turn.responseComplete = true;
        emitChatNode(s, turn, 'message.updated', payload, ev.timestamp);
      } else {
        turn.responseComplete = true;
        if (turn.chatNodeId) {
          s.nodeUpdates.set(turn.chatNodeId, { status: 'inactive' as MonitorNodeStatus });
        }
      }
    }
    return;
  }

  // session.next.text.started — mark text generation has begun
  if (eventType === 'session.next.text.started') {
    addRelatedEventToTurn(turn, ev, eventType);
    return;
  }

  // ── Update-only events: no stack management, lifecycle tracking ─────────

  // session.next.text.ended — mark response complete for streaming
  if (eventType === 'session.next.text.ended') {
    addRelatedEventToTurn(turn, ev, eventType);
    turn.responseComplete = true;
    if (turn.chatNodeId) {
      s.nodeUpdates.set(turn.chatNodeId, { status: 'inactive' as MonitorNodeStatus });
    }
    return;
  }

  // Permission events — add as related events (no separate node)
  if (eventType === 'permission') {
    addRelatedEventToTurn(turn, ev, eventType);
    return;
  }

  // PostToolUse / PostToolUseFailure / PostToolBatch — add as related events
  if (eventType === 'PostToolUse' || eventType === 'PostToolBatch') {
    addRelatedEventToTurn(turn, ev, eventType);
    return;
  }
  if (eventType === 'PostToolUseFailure') {
    addRelatedEventToTurn(turn, ev, eventType);
    return;
  }

  // SubagentStop — add as related event (already counted by SubagentStart)
  if (eventType === 'SubagentStop') {
    addRelatedEventToTurn(turn, ev, eventType);
    return;
  }

  // TaskCreated / TaskCompleted — add as related events
  if (eventType === 'TaskCreated' || eventType === 'TaskCompleted') {
    addRelatedEventToTurn(turn, ev, eventType);
    return;
  }

  // session.next.tool.success / session.next.tool.failed — add as related events
  if (eventType === 'session.next.tool.success' || eventType === 'session.next.tool.failed') {
    addRelatedEventToTurn(turn, ev, eventType);
    return;
  }

  // session.next.agent.switched — add as related event
  if (eventType === 'session.next.agent.switched') {
    addRelatedEventToTurn(turn, ev, eventType);
    return;
  }

  // message.removed / message.part.removed — add as related events
  if (eventType === 'message.removed' || eventType === 'message.part.removed') {
    addRelatedEventToTurn(turn, ev, eventType);
    return;
  }

  // elicitation — add as related event
  if (eventType === 'elicitation') {
    addRelatedEventToTurn(turn, ev, eventType);
    return;
  }

  // todo.updated — add as related event
  if (eventType === 'todo.updated') {
    addRelatedEventToTurn(turn, ev, eventType);
    return;
  }

  // Fallback: add any unhandled event as a related event
  addRelatedEventToTurn(turn, ev, eventType);
}

/**
 * Pure function — builds a complete ReactFlow graph from a list of events.
 * Only emits 'chatNode' nodes via turn-oriented accumulation.
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
    nodeUpdates: new Map(),
    nodeRelatedEvents: new Map(),
    turnData: new Map(),
  };

  // Sort events by timestamp (primary), then operation order as tiebreaker
  // for same-millisecond events. This ensures user messages sort before chat
  // responses when their timestamps differ, even though chat has lower OP_ORDER.
  const OP_ORDER: Record<string, number> = { chat: 0, invoke_agent: 1, execute_tool: 2, permission: 3, elicitation: 3 };
  const opOrder = (ev: FredoEvent) => {
    const t = ev.toolName ?? '';
    const base = t.startsWith('chat ') ? 'chat' : t;
    return OP_ORDER[base] ?? 4;
  };
  const sorted = [...events].sort((a, b) => {
    const tsA = new Date(a.timestamp).getTime();
    const tsB = new Date(b.timestamp).getTime();
    if (tsA !== tsB) return tsA - tsB;
    const oa = opOrder(a), ob = opOrder(b);
    return oa - ob;
  });

  for (const ev of sorted) {
    try {
      processOneEvent(ev, state);
    } catch (err) {
      console.error('[MM] processOneEvent failed for event:', ev, err);
    }
  }

  // Finalize any remaining emitted ChatNode that's still 'working'
  for (const [, turn] of state.turnData) {
    if (turn.emitted && turn.chatNodeId && !turn.responseComplete) {
      state.nodeUpdates.set(turn.chatNodeId, { status: 'inactive' as MonitorNodeStatus });
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
