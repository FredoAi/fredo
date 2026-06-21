import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useNodesState, useEdgesState } from 'reactflow';
import type { Node, Edge, NodeChange } from 'reactflow';
import { useStream } from '../../../shared/contexts/StreamContext';
import type { FredoEvent } from '../../../shared/contexts/StreamContext';
import type { MonitorNodeData, MonitorNodeStatus } from '../types';
import { eventPayload, isFinalPart } from '../lib/contract';
import type { TurnPayload } from '../lib/contract';
import type { ChatNodeContract, SubscriptionDelivery } from '../../../shared/classes/EventSubscription';
import { globalSubscriptionState } from '../MissionMonitorFeature';
import { getLayoutedElements } from '../lib/layout';

// ── Stateless Turn Grouping (UNCHANGED — REQ-8: legacy replay mode) ────────────

/**
 * Pure function — groups FredoEvents into turns by messageID/parentID.
 * Returns ONLY ChatNode nodes (REQ-4). No mutable state, no deferred queues,
 * no cross-turn caches (REQ-3).
 *
 * UNCHANGED for replay mode (REQ-8). Live mode uses subscription-driven processing.
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
    agent?: string;
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
      timestamp: item.ev.timestamp, agent: info.agent,
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
    const agent = userMsg.agent;

    const turnPayload: TurnPayload = {
      userPrompt: userPromptText,
      userTimestamp: userMsg.timestamp,
      thinkingText,
      responseText,
      turnTools: toolCount,
      turnFiles: fileCount,
      model,
      turnInputTokens: assistantMsg.tokens?.input ?? 0,
      turnOutputTokens: assistantMsg.tokens?.output ?? 0,
      agent,
    };

    const nodeId = `mm-${++nodeCounter}`;
    const nodeLabel = agent ? `${agent} · ${model ?? ''}` : (model ?? 'Assistant');

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
      turnInputTokens: 0,
      turnOutputTokens: 0,
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

// ── Subscription-Driven Live Mode (REQ-1 — replaces reduceGraph) ─────────────

/**
 * Internal state for the ChatNodeEvent subscription processor.
 * Manages the lifecycle of ChatNodeContract assembly from raw events.
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
}

export function createInitialProcessorState(): SubscriptionProcessorState {
  return {
    contracts: new Map(),
    assistantParentMap: new Map(),
    pendingParts: new Map(),
    toolPartIds: new Map(),
    filePaths: new Map(),
    nodeOrder: [],
  };
}

// ── Payload extraction helpers (same shape as reduceGraph) ────────────────────

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
 *
 * REQ-3: Shows "{agent} · {model}" when both present,
 * falls back to model only when agent is absent,
 * defaults to "Assistant" when neither is available.
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
 * This bridges the subscription contract format to the existing TurnPayload format
 * used by ChatNode for rendering.
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
 * Process a single FredoEvent through the ChatNodeEvent subscription lifecycle.
 *
 * This replaces the old `reduceGraph` function. Instead of maintaining an
 * IncrementalState with Map<string, Node>, it maintains a
 * SubscriptionProcessorState with Map<string, ChatNodeContract> and calls
 * onDelivery for each lifecycle transition.
 *
 * Callers receive deliveries and convert them to ReactFlow nodes/edges.
 *
 * The lifecycle (REQ-7 through REQ-11):
 *   message.updated (role=user, new messageID) → Init
 *   message.part.updated (type=text, user's messageID) → Update (userMessage)
 *   message.part.updated (type=reasoning) → Update (agentThinking)
 *   message.part.updated (type=text, assistant's messageID) → Update (agentReply)
 *   message.updated (role=assistant, time.completed) → End
 */
export function processChatNodeSubscription(
  state: SubscriptionProcessorState,
  event: FredoEvent,
  onDelivery: (delivery: SubscriptionDelivery<ChatNodeContract>, userTimestamp: string) => void,
): SubscriptionProcessorState {
  const payload = eventPayload(event);
  const toolName = event.toolName ?? '';

  // ── message.updated: user or assistant ──────────────────────────
  if (toolName === 'message.updated') {
    const info = extractInfo(payload);
    const id = info.id ?? '';
    if (!id) return state;

    if (info.role === 'user') {
      // REQ-7: Create a new ChatNodeContract if not already present
      if (state.contracts.has(id)) return state;

      // REQ-7: Capture agent name from user message info
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

      // Deliver Init lifecycle
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
      // Must have a parentID linking to a known user message
      if (!parentID || !state.contracts.has(parentID)) return state;

      const next = cloneProcessorState(state);
      next.assistantParentMap.set(id, parentID);

      const contract = next.contracts.get(parentID)!;

      // Apply any pending parts that arrived before this assistant message.updated
      if (next.pendingParts.has(id)) {
        const parts = next.pendingParts.get(id)!;
        for (const part of parts) {
          applyPartToContract(contract, part, 'agentReply');
        }
        next.pendingParts.delete(id);
      }

      // Set model from assistant message
      if (info.modelID) {
        contract.model = info.modelID;
      } else if (info.providerID && !contract.model) {
        contract.model = info.providerID;
      }

      // REQ-6: Capture tokens from assistant info.tokens
      const tokens = info.tokens as Record<string, any> | undefined;
      if (tokens) {
        if (typeof tokens.input === 'number') {
          contract.turnInputTokens = (contract.turnInputTokens ?? 0) + tokens.input;
        }
        if (typeof tokens.output === 'number') {
          contract.turnOutputTokens = (contract.turnOutputTokens ?? 0) + tokens.output;
        }
      }

      // REQ-11: Deliver End if time.completed is set, otherwise Update
      if (info.time?.completed) {
        // Count unique file paths for this turn from accumulated changes
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

    // Not a role we handle
    return state;
  }

  // ── message.part.updated: text/reasoning/tool content ───────────
  if (toolName === 'message.part.updated') {
    const part = extractPart(payload);
    if (!isFinalPart(part)) return state;

    const partMessageID = part.messageID ?? '';
    if (!partMessageID) return state;

    const partRecord = {
      type: part.type ?? '',
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

    // Case 3: Part for an unknown assistant message → buffer (REQ-4)
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

    // Find the most recent user correlationId
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
 * Apply a part record to a ChatNodeContract.
 *
 * @param contract - The contract to update
 * @param part - The part record with type, text, and partId
 * @param textTarget - 'userMessage' for user text parts, 'agentReply' for assistant text parts
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
    // Count unique tool parts per turn (by partId)
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
  };
}

// ── Subagent Processor (REQ-8, REQ-9) ────────────────────────────────────────

/**
 * Contract for subagent node data — mirrors the SubagentStart event payload
 * and part.updated(agent/subtask) fields.
 */
export interface SubagentContract {
  subagentName: string;
  instruction: string;
  output: string;
  model?: string;
  parentCorrelationId: string;
  tokensIn: number;
  tokensOut: number;
  toolsUsed: number;
}

/**
 * Internal state for the subagent subscription processor.
 * Manages the lifecycle of subagent node assembly from SubagentStart
 * and message.part.updated (agent/subtask) events.
 */
interface SubagentProcessorState {
  /** Map of subagent correlationId → SubagentContract */
  contracts: Map<string, SubagentContract>;
  /** Maps subagent correlationId → parent ChatNode correlationId */
  parentMap: Map<string, string>;
  /** Ordered list of subagent correlationIds */
  nodeOrder: string[];
}

export function createInitialSubagentProcessorState(): SubagentProcessorState {
  return {
    contracts: new Map(),
    parentMap: new Map(),
    nodeOrder: [],
  };
}

/** Generate a unique subagent node ID from a parent ChatNode correlationId. */
function makeSubagentNodeId(parentCorrId: string): string {
  return `sub-mm-${parentCorrId}`;
}

/** Create a ReactFlow Node for a subagent contract. */
function makeSubagentNode(
  nodeId: string,
  status: MonitorNodeStatus,
  payload: SubagentContract,
  timestamp: string,
  label: string,
): Node<MonitorNodeData> {
  return {
    id: nodeId,
    type: 'subagentNode',
    position: { x: 0, y: 0 },
    data: {
      eventType: 'subagentNode',
      status,
      payload: payload as unknown as Record<string, any>,
      timestamp,
      label,
      sublabel: payload.instruction.slice(0, 200) || undefined,
      threadId: 'main',
      relatedEvents: [],
    },
  };
}

/** Create a dashed smoothstep edge for ChatNode → subagentNode links. */
function makeSubagentEdge(source: string, target: string): Edge {
  return {
    id: `e-${source}-${target}`,
    source,
    target,
    type: 'smoothstep',
    animated: false,
    style: { stroke: '#6366f180', strokeWidth: 1.5, strokeDasharray: '5,5' },
  };
}

function cloneSubagentProcessorState(state: SubagentProcessorState): SubagentProcessorState {
  return {
    contracts: new Map(state.contracts),
    parentMap: new Map(state.parentMap),
    nodeOrder: [...state.nodeOrder],
  };
}

// ── Subagent Subscription Processor (REQ-8, REQ-9) ──────────────────────────

/**
 * Process a single FredoEvent through the subagent subscription lifecycle.
 *
 * REQ-8: SubagentStart (toolName="SubagentStart", state=Init) creates a new
 * subagent contract linked to the most recent parent ChatNode.
 *
 * REQ-9: message.part.updated with part.type='agent' or 'subtask' updates the
 * corresponding subagent contract with instruction/output text.
 *
 * @param state - Current subagent processor state
 * @param event - Raw FredoEvent to process
 * @param chatState - Current ChatNode processor state (for parent resolution)
 * @param onDelivery - Callback for each delivery produced
 * @returns Updated subagent processor state
 */
export function processSubagentSubscription(
  state: SubagentProcessorState,
  event: FredoEvent,
  chatState: SubscriptionProcessorState,
  onDelivery: (delivery: {
    contract: SubagentContract;
    lifecycle: 'Init' | 'Update' | 'End';
    correlationId: string;
    timestamp: string;
  }) => void,
): SubagentProcessorState {
  const payload = eventPayload(event);
  const toolName = event.toolName ?? '';
  const eventState = event.state ?? '';

  // ── SubagentStart: create new subagent contract (REQ-8) ─────────────
  if (toolName === 'SubagentStart' && eventState === 'Init') {
    const subagentName = String(payload.subagent_name ?? payload.name ?? '');
    const instruction = String(payload.task ?? payload.instruction ?? payload.text ?? '');
    if (!subagentName) return state;

    // Resolve parent: use the most recent ChatNode
    const parentCorrId = chatState.nodeOrder.length > 0
      ? chatState.nodeOrder[chatState.nodeOrder.length - 1]
      : '';
    if (!parentCorrId) return state;

    const corrId = makeSubagentNodeId(parentCorrId);
    // Skip if already created a subagent for this parent
    if (state.contracts.has(corrId)) return state;

    const model = String(payload.model ?? '');

    const contract: SubagentContract = {
      subagentName,
      instruction,
      output: '',
      model: model || undefined,
      parentCorrelationId: parentCorrId,
      tokensIn: typeof payload.tokensIn === 'number' ? payload.tokensIn : 0,
      tokensOut: typeof payload.tokensOut === 'number' ? payload.tokensOut : 0,
      toolsUsed: typeof payload.toolsUsed === 'number' ? payload.toolsUsed : 0,
    };

    const next = cloneSubagentProcessorState(state);
    next.contracts.set(corrId, contract);
    next.parentMap.set(corrId, parentCorrId);
    next.nodeOrder.push(corrId);

    onDelivery({
      contract: { ...contract },
      lifecycle: 'Init',
      correlationId: corrId,
      timestamp: event.timestamp,
    });

    return next;
  }

  // ── message.part.updated with agent/subtask part (REQ-9) ───────────
  if (toolName === 'message.part.updated') {
    const part = extractPart(payload);
    if (!isFinalPart(part)) return state;

    const partType = part.type ?? '';
    if (partType !== 'agent' && partType !== 'subtask') return state;

    const partText = part.text ?? '';

    // Resolve parent ChatNode correlationId from part.messageID
    const partMessageID = part.messageID ?? '';
    let parentCorrId = '';
    if (partMessageID && chatState.assistantParentMap.has(partMessageID)) {
      parentCorrId = chatState.assistantParentMap.get(partMessageID)!;
    } else {
      // Fallback: most recent ChatNode
      parentCorrId = chatState.nodeOrder.length > 0
        ? chatState.nodeOrder[chatState.nodeOrder.length - 1]
        : '';
    }
    if (!parentCorrId) return state;

    const corrId = makeSubagentNodeId(parentCorrId);

    const next = cloneSubagentProcessorState(state);

    // Create contract if SubagentStart was missed (part arrives first)
    if (!next.contracts.has(corrId)) {
      const partId = part.id ?? '';
      const subagentName = String(part.type ?? 'agent');
      const contract: SubagentContract = {
        subagentName,
        instruction: partText,
        output: '',
        parentCorrelationId: parentCorrId,
        tokensIn: 0,
        tokensOut: 0,
        toolsUsed: 0,
      };
      next.contracts.set(corrId, contract);
      next.parentMap.set(corrId, parentCorrId);
      next.nodeOrder.push(corrId);

      onDelivery({
        contract: { ...contract },
        lifecycle: 'Init',
        correlationId: corrId,
        timestamp: event.timestamp,
      });
    } else {
      // Update existing contract
      const contract = next.contracts.get(corrId)!;
      if (partText && !contract.instruction) {
        contract.instruction = partText;
      }
      if (partText) {
        contract.output = (contract.output ?? '') + partText;
      }

      onDelivery({
        contract: { ...contract },
        lifecycle: 'Update',
        correlationId: corrId,
        timestamp: event.timestamp,
      });
    }

    return next;
  }

  return state;
}

/**
 * Find subagent contracts whose parent ChatNode has reached End lifecycle,
 * and produce deliveries to transition them to 'inactive'.
 */
export function finalizeSubagentOnChatEnd(
  state: SubagentProcessorState,
  endedParentCorrId: string,
): { deliveries: Array<{
  contract: SubagentContract;
  lifecycle: 'End';
  correlationId: string;
  timestamp: string;
}>; updatedState: SubagentProcessorState } {
  const deliveries: Array<{
    contract: SubagentContract;
    lifecycle: 'End';
    correlationId: string;
    timestamp: string;
  }> = [];

  let next = state;
  for (const [corrId, contract] of state.contracts) {
    if (contract.parentCorrelationId === endedParentCorrId && contract.output) {
      const endedContract = { ...contract };
      deliveries.push({
        contract: endedContract,
        lifecycle: 'End',
        correlationId: corrId,
        timestamp: new Date().toISOString(),
      });
    }
  }

  return { deliveries, updatedState: next };
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
 *   events by sessionId and startTime, applies them through subscription-driven
 *   processing (processChatNodeSubscription → onDelivery → ReactFlow nodes).
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
  const seenKeysRef = useRef<Set<string>>(new Set());

  // ── Subscription processor state (live mode only, stored in ref) ───────────
  const subRef = useRef<SubscriptionProcessorState>(createInitialProcessorState());
  const processedEventCountRef = useRef(0);

  // Accumulated ReactFlow state (persists across batches so nodes don't disappear)
  const accumulatedNodesRef = useRef<Map<string, { node: Node<MonitorNodeData>; userTimestamp: string }>>(new Map());
  const accumulatedOrderRef = useRef<string[]>([]);

  // ── Subagent processor state (REQ-8, REQ-9) ──────────────────────────────
  const subagentRef = useRef<SubagentProcessorState>(createInitialSubagentProcessorState());
  const subagentProcessedCountRef = useRef(0);

  // Reset accumulated state when session changes
  useEffect(() => {
    accumulatedNodesRef.current = new Map();
    accumulatedOrderRef.current = [];
    subRef.current = createInitialProcessorState();
    subagentRef.current = createInitialSubagentProcessorState();
    processedEventCountRef.current = 0;
    subagentProcessedCountRef.current = 0;
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

  // ── Replay mode: use buildGraphFromEvents (unchanged — REQ-8) ─────────────
  const replayResult = useMemo(
    () => isReplay ? buildGraphFromEvents(replayEvents!) : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isReplay, ...(isReplay ? [replayEvents] : [])]
  );

  useEffect(() => {
    if (!isReplay || !replayResult) return;
    // If live mode has already produced nodes, skip replay to avoid overwriting
    if (accumulatedNodesRef.current.size > 0) return;

    const { nodes: replayNodes, edges: replayEdges } = replayResult;
    if (replayNodes.length === 0) {
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

  // ── Live mode: subscription-driven processing (replaces reduceGraph) ──────
  useEffect(() => {
    const prevCount = processedEventCountRef.current;
    const subagentPrevCount = subagentProcessedCountRef.current;
    const maxProcessed = Math.min(prevCount, subagentPrevCount);
    if (liveEvents.length <= maxProcessed) return;

    let state = subRef.current;
    let subState = subagentRef.current;
    let hasChanges = false;

    // Collect deliveries from this batch
    interface PendingDelivery {
      delivery: SubscriptionDelivery<ChatNodeContract>;
      userTimestamp: string;
    }
    const pendingDeliveries: PendingDelivery[] = [];

    // Subagent delivery type
    interface SubagentPendingDelivery {
      contract: SubagentContract;
      lifecycle: 'Init' | 'Update' | 'End';
      correlationId: string;
      timestamp: string;
    }
    const subagentPendingDeliveries: SubagentPendingDelivery[] = [];

    // Process events through both processors
    for (let i = maxProcessed; i < liveEvents.length; i++) {
      const ev = liveEvents[i];

      // Process ChatNode events
      const newState = processChatNodeSubscription(
        state,
        ev,
        (delivery, userTimestamp) => {
          pendingDeliveries.push({ delivery, userTimestamp });
        },
      );
      if (newState !== state) {
        hasChanges = true;
        state = newState;
      }

      // Process Subagent events (REQ-8, REQ-9)
      const newSubState = processSubagentSubscription(
        subState,
        ev,
        state,
        (delivery) => {
          subagentPendingDeliveries.push(delivery);
        },
      );
      if (newSubState !== subState) {
        hasChanges = true;
        subState = newSubState;
      }
    }

    if (!hasChanges) {
      processedEventCountRef.current = liveEvents.length;
      subagentProcessedCountRef.current = liveEvents.length;
      return;
    }

    subRef.current = state;
    subagentRef.current = subState;
    processedEventCountRef.current = liveEvents.length;
    subagentProcessedCountRef.current = liveEvents.length;

    // Process chat deliveries — update accumulated node/edge refs
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

          // REQ-9: When parent ChatNode reaches End, finalize subagent nodes
          const { deliveries: subEndDeliveries } = finalizeSubagentOnChatEnd(subState, correlationId);
          for (const subEnd of subEndDeliveries) {
            subagentPendingDeliveries.push(subEnd);
            hasChanges = true;
          }
        }
      }
    }

    // Process subagent deliveries
    for (const delivery of subagentPendingDeliveries) {
      const { contract, lifecycle, correlationId } = delivery;

      if (lifecycle === 'Init') {
        const label = `${contract.subagentName}${contract.model ? ` · ${contract.model}` : ''}`;
        const node = makeSubagentNode(correlationId, 'working', contract, delivery.timestamp, label);
        accumulatedNodesRef.current.set(correlationId, { node, userTimestamp: delivery.timestamp });

        if (!accumulatedOrderRef.current.includes(correlationId)) {
          // Insert subagent node right after its parent ChatNode in the order
          const parentIdx = accumulatedOrderRef.current.indexOf(contract.parentCorrelationId);
          if (parentIdx >= 0) {
            accumulatedOrderRef.current.splice(parentIdx + 1, 0, correlationId);
          } else {
            accumulatedOrderRef.current.push(correlationId);
          }
        }
        delivered = true;
      } else if (lifecycle === 'Update') {
        const existing = accumulatedNodesRef.current.get(correlationId);
        if (existing) {
          const label = `${contract.subagentName}${contract.model ? ` · ${contract.model}` : ''}`;
          existing.node = makeSubagentNode(
            existing.node.id,
            existing.node.data.status as MonitorNodeStatus,
            contract,
            existing.userTimestamp,
            label,
          );
          delivered = true;
        }
      } else if (lifecycle === 'End') {
        const existing = accumulatedNodesRef.current.get(correlationId);
        if (existing) {
          existing.node = makeSubagentNode(
            existing.node.id,
            'inactive',
            contract,
            existing.userTimestamp,
            existing.node.data.label,
          );
          delivered = true;
        }
      }
    }

    if (!delivered) return;

    // Convert accumulated refs to ReactFlow arrays
    const nodeList: Node<MonitorNodeData>[] = [];
    const edgeList: Edge[] = [];
    const subagentEdgeList: Edge[] = [];

    for (const corrId of accumulatedOrderRef.current) {
      const entry = accumulatedNodesRef.current.get(corrId);
      if (!entry) continue;
      nodeList.push(entry.node);

      // Build subagent edges: parent ChatNode → subagentNode
      if (entry.node.type === 'subagentNode') {
        const payload = entry.node.data.payload as unknown as SubagentContract;
        if (payload?.parentCorrelationId) {
          const parentNodeId = `mm-${payload.parentCorrelationId}`;
          subagentEdgeList.push(makeSubagentEdge(parentNodeId, entry.node.id));
        }
      }
    }

    // Build main chain edges between ChatNodes only
    let prevChatNodeId: string | null = null;
    for (const corrId of accumulatedOrderRef.current) {
      const entry = accumulatedNodesRef.current.get(corrId);
      if (!entry || entry.node.type === 'subagentNode') continue;
      if (prevChatNodeId) {
        edgeList.push(makeEdge(prevChatNodeId, entry.node.id));
      }
      prevChatNodeId = entry.node.id;
    }

    // Add subagent edges at the end
    edgeList.push(...subagentEdgeList);

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
  }, [liveEvents]);

  // ── Dagre auto-layout on dimension measurement (REQ-10) ────────────────────
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    rawOnNodesChange(changes);

    const hasDimensionChange = changes.some((c) => (c as any).type === 'dimensions');
    if (!hasDimensionChange) return;

    setNodes((current) => {
      if (current.length === 0) return current;

      // Use accumulated edges from edge state
      const { nodes: layoutedNodes } = getLayoutedElements(current, edges);
      let changed = false;
      const updated = current.map((node) => {
        const layouted = layoutedNodes.find(n => n.id === node.id);
        if (layouted && (
          layouted.position.x !== node.position.x ||
          layouted.position.y !== node.position.y
        )) {
          changed = true;
          return { ...node, position: { ...layouted.position } };
        }
        return node;
      });
      return changed ? updated : current;
    });
    setLayoutVersion(v => v + 1);
  }, [rawOnNodesChange, setNodes, edges]);

  // ── Replay mode: eventCount; Live mode: from liveEvents ───────────────────
  const eventCount = isReplay ? (replayEvents?.length ?? 0) : liveEvents.length;

  return {
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
    layoutVersion,
    eventCount,
  };
}
