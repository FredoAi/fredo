/**
 * Mission Monitor Contract — ECE Delivery-Driven Types.
 *
 * All capsules in Spec #318 implement against these types.
 * Capsule A defines shared types + empty state.
 * Capsule B builds graph nodes/edges from deliveries.
 * Capsule C renders Agent + Subagent nodes.
 * Capsule D renders Tool + File nodes + edge styles.
 * Capsule E builds the session sidebar.
 * Capsule F builds the detail panel.
 */

import type { ContractDelivery } from '../../../shared/classes/EventSubscription';

/** Session-level counters displayed in panel header badges. */
export interface SessionCounters {
  tools: number;
  files: number;
  subagents: number;
  tokens: number;
}

/**
 * Format a token count for display.
 *
 * - < 1 000       → raw number (e.g., "420", "0")
 * - ≥ 1 000       → "X.Yk" with one decimal (e.g., 1840 → "1.8k")
 * - ≥ 1 000 000   → "X.YM" with one decimal (e.g., 2500000 → "2.5M")
 * - Trailing ".0" is stripped (e.g., "1.0k" → "1k")
 */
export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) {
    const val = n / 1_000_000;
    const formatted = val.toFixed(1);
    return `${parseFloat(formatted)}M`;
  }
  if (n >= 1_000) {
    const val = n / 1_000;
    const formatted = val.toFixed(1);
    return `${parseFloat(formatted)}k`;
  }
  return String(n);
}

// ═══════════════════════════════════════════════════════════════════════════
// ECE DELIVERY-DRIVEN TYPES — Canonical contract for Spec #318
// ═══════════════════════════════════════════════════════════════════════════

/** A session extracted from deliveries — no localStorage. */
export interface MissionMonitorSession {
  sessionId: string;
  label: string;
  startTime: number;
  latestTimestamp: string;
  deliveryCount: number;
}

/** Node types for the ReactFlow graph. */
export type GraphNodeType = 'agent' | 'subagent' | 'tool' | 'file';

/** Node status — derived from ContractDelivery lifecycle. */
export type GraphNodeStatus = 'in-progress' | 'active' | 'complete' | 'error';

/** Payload carried by AgentNode — extracted from ContractDelivery payload. */
export interface AgentNodePayload {
  agent?: string;
  model?: string;
  userMessage: string;
  agentThinking: string;
  agentReply: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  startTime?: string;
  endTime?: string;
  correlationId: string;
  sessionId: string;
}

/** Payload carried by SubagentNode. */
export interface SubagentNodePayload {
  name: string;
  instruction: string;
  output: string;
  parentCorrelationId: string;
  correlationId: string;
  sessionId: string;
}

/** Payload carried by ToolNode. */
export interface ToolNodePayload {
  toolName: string;
  input?: string;
  output?: string;
  parentCorrelationId: string;
  correlationId: string;
  sessionId: string;
}

/** Payload carried by FileNode. */
export interface FileNodePayload {
  filePath: string;
  operation: 'read' | 'write';
  parentToolId: string;
  sessionId: string;
}

/** Union type for all node payloads. */
export type GraphNodePayload = AgentNodePayload | SubagentNodePayload | ToolNodePayload | FileNodePayload;

/** Edge types for the ReactFlow graph. */
export type GraphEdgeType = 'parent' | 'calls' | 'reads' | 'writes';

/** ReactFlow-compatible graph node. */
export interface GraphNode {
  id: string;
  type: GraphNodeType;
  status: GraphNodeStatus;
  payload: GraphNodePayload;
  label: string;
  timestamp: string;
}

/** ReactFlow-compatible graph edge. */
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: GraphEdgeType;
}

// ═══════════════════════════════════════════════════════════════════════════
// EMPTY STATE JOKES
// ═══════════════════════════════════════════════════════════════════════════

export const EMPTY_STATE_JOKES = [
  "I asked my AI to organize my desktop. It created 47 folders named 'Stuff' and called it a day.",
  "My agent said it had 'one small question' — 847 messages later, we're still debugging a semicolon.",
  "The AI promised to refactor my codebase. It replaced every function with a comment that says '// TODO: implement' — truly, an artist.",
] as const;

// ═══════════════════════════════════════════════════════════════════════════
// CONTRACT VERIFICATION HELPERS
// ═══════════════════════════════════════════════════════════════════════════

// ── Eager child→parent mapping population (AC-1: Spec #478) ────────────────
// REQ-1: Populate childToParentSession mapping eagerly whenever ANY code
// iterates through deliveries. This ensures the mapping exists BEFORE the
// session sidebar filtering consults getParentSession().
//
// Both isChatNodeDelivery() and deliverySessionId() trigger this processing,
// ensuring ALL delivery types (chat-node AND tool-use-lifecycle) are scanned
// regardless of which code path processes them first.
const processedMappingIds = new Set<string>();

function maybeProcessMappingForDelivery(d: ContractDelivery): void {
  if (!d.id || processedMappingIds.has(d.id)) return;

  // Cap processedMappingIds at 10000 entries, evict oldest when exceeded (REQ-4)
  if (processedMappingIds.size >= 10000) {
    const oldestValue = processedMappingIds.values().next().value;
    if (oldestValue !== undefined) {
      processedMappingIds.delete(oldestValue);
    }
  }

  processedMappingIds.add(d.id);

  // Source 1: PostToolUse 'task' end deliveries (real opencode subagent dispatch)
  if (d.contractName === 'tool-use-lifecycle' && d.lifecycle === 'end') {
    const deliveryToolName = d.payload?.['toolName'] as string | undefined;
    if (deliveryToolName === 'task') {
      const dPayload = d.payload as Record<string, any> | undefined;
      const innerP = dPayload?.['payload'] as Record<string, any> | undefined;
      const metadata = innerP?.['metadata'] as Record<string, any> | undefined;
      const parentSessionId = metadata?.parentSessionId as string | undefined;
      const childSessionId = metadata?.sessionId as string | undefined;
      if (parentSessionId && childSessionId && !getParentSession(childSessionId)) {
        setChildParentMapping(childSessionId, parentSessionId);
      }
    }
  }

  // Source 2: session.created events (chat-node init) with parentID
  if (d.contractName === 'chat-node' && d.lifecycle === 'init') {
    const rawP = d.payload?.['payload'] as Record<string, any> | undefined;
    if (rawP) {
      const sessionCreatedParentId = rawP?.properties?.info?.parentID as string | undefined;
      const childSid = d.key?.sessionId ?? 'unknown';
      if (sessionCreatedParentId && !getParentSession(childSid)) {
        setChildParentMapping(childSid, sessionCreatedParentId);
      }
    }
  }
}

/** Verify a ContractDelivery matches the chat-node contract. */
export function isChatNodeDelivery(d: ContractDelivery): boolean {
  // Side-effect (AC-1): eagerly populate child→parent session mapping from ALL
  // deliveries, ensuring it exists before session sidebar filtering.
  maybeProcessMappingForDelivery(d);
  return d.contractName === 'chat-node';
}

/** Extract session ID from a ContractDelivery. */
export function deliverySessionId(d: ContractDelivery): string {
  // Side-effect (AC-1): eagerly populate child→parent session mapping from ALL
  // deliveries (belt-and-suspenders with isChatNodeDelivery for code paths
  // that don't call isChatNodeDelivery).
  maybeProcessMappingForDelivery(d);
  return d.key?.sessionId ?? 'unknown';
}

/** Extract correlation ID from a ContractDelivery. */
export function deliveryCorrelationId(d: ContractDelivery): string {

  return d.key?.correlationId ?? d.id;
}

/**
 * Extract the inner payload from a ContractDelivery.
 * The ECE payload has 2-level nesting � delivery.payload['payload'] gets the inner data.
 */
export function extractDeliveryPayload(d: ContractDelivery): Record<string, unknown> {
  const inner = d.payload?.['payload'] as Record<string, unknown> | undefined;
  return inner ?? d.payload ?? {};
}

/**
 * Verify a ContractDelivery matches the tool-use-lifecycle contract.
 */
export function isToolUseDelivery(d: ContractDelivery): boolean {
  return d.contractName === 'tool-use-lifecycle';
}

/**
 * Verify a ContractDelivery matches the subagent-lifecycle contract.
 */
export function isSubagentDelivery(d: ContractDelivery): boolean {
  return d.contractName === 'subagent-lifecycle';
}

/**
 * Extract ToolNodePayload from a tool-use-lifecycle delivery.
 * Reads toolName from the delivery payload's top-level 'toolName' field
 * and input/output from the inner 'payload' object.
 */
export function makeToolNodePayload(
  d: ContractDelivery,
  parentCorrelationId: string,
): ToolNodePayload {
  const inner = d.payload?.['payload'] as Record<string, unknown> | undefined;
  const p = inner ?? d.payload ?? {};
  // toolName lives on d.payload (outer) for Hook deliveries — preserve that
  const outerToolName = d.payload?.['toolName'] as string | undefined;

  let toolName: string;
  let input: string | undefined;
  let output: string | undefined;

  toolName = outerToolName ?? (p['toolName'] as string) ?? 'unknown-tool';
  input = typeof p?.input === 'string' ? (p.input as string) : undefined;
  output = typeof p?.output === 'string' ? (p.output as string) : undefined;

  return {
    toolName,
    input,
    output,
    parentCorrelationId,
    correlationId: deliveryCorrelationId(d),
    sessionId: deliverySessionId(d),
  };
}

/**
 * Extract SubagentNodePayload from a subagent-lifecycle delivery.
 * Reads the subagent name from the delivery payload's top-level 'toolName' field
 * and instruction/output from the inner 'payload' object.
 */
export function makeSubagentNodePayload(
  d: ContractDelivery,
  parentCorrelationId: string,
): SubagentNodePayload {
  const inner = d.payload?.['payload'] as Record<string, unknown> | undefined;
  const p = inner ?? d.payload ?? {};
  // toolName lives on d.payload (outer) for Hook deliveries — preserve that
  const outerName = d.payload?.['toolName'] as string | undefined;

  let name: string;
  let instruction: string;
  let output: string;

  // Hook payloads: raw event structure varies by event source
  // - session.next.tool.* events have nested properties (properties.tool_name,
  //   properties.tool_input, properties.tool_response)
  // - PreToolUse/PostToolUse events pass tool_input/tool_response directly
  // - session.next.tool.* may also have tool_input/tool_response at TOP level
  //   (not nested under properties) depending on SDK version
  // - Real opencode PostToolUse for task tool: tool_response.output (XML),
  //   tool_response.metadata.sessionId, tool_response.title
  // - Instruction comes from prior message.part.updated at
  //   properties.part.state.input.prompt
  const props = p['properties'] as Record<string, any> | undefined;
  name = outerName
    ?? (p['toolName'] as string)
    ?? (p['tool_name'] as string)
    ?? (props?.['tool_name'] as string)
    ?? (props?.['tool_response']?.title as string)
    ?? (d.payload?.['payload'] as Record<string, any>)?.tool_response?.title as string
    ?? 'unknown-subagent';
  const pAny = p as Record<string, any>;
  instruction = typeof pAny?.instruction === 'string' ? (pAny.instruction as string)
    : (typeof pAny?.tool_input?.prompt === 'string' ? (pAny.tool_input.prompt as string)
    : (typeof props?.tool_input?.prompt === 'string' ? (props.tool_input.prompt as string)
    // Real opencode: instruction in message.part.updated state.input.prompt
    : (typeof props?.part?.state?.input?.prompt === 'string' ? (props.part.state.input.prompt as string)
    : (typeof props?.tool_input === 'string' ? (props.tool_input as string)
    : (typeof pAny?.tool_input === 'string' ? (pAny.tool_input as string)
    : '')))));
  output = typeof pAny?.output === 'string' ? (pAny.output as string)
    : (typeof pAny?.tool_response?.output === 'string' ? (pAny.tool_response.output as string)
    : (typeof props?.tool_response?.output === 'string' ? (props.tool_response.output as string)
    : (typeof props?.tool_response === 'string' ? (props.tool_response as string)
    : (typeof pAny?.tool_response === 'string' ? (pAny.tool_response as string)
    : ''))));

  return {
    name,
    instruction,
    output,
    parentCorrelationId,
    correlationId: deliveryCorrelationId(d),
    sessionId: deliverySessionId(d),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// REQ-4: Payload Normalization Helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Extract the user message from a ContractDelivery payload.
 * Normalizes across Hook nested shapes (properties.text, chat.message, etc.).
 *
 * CRITICAL: `properties.text` is AMBIGUOUS — it contains the user's prompt
 * for UserPromptSubmit events, but the agent's response for
 * session.next.text.ended, chat.message, etc. Only use it when
 * event_type is explicitly 'UserPromptSubmit'.
 *
 * Priority:
 * 1. chat.message format — output.message.parts[0].text (real opencode user prompt)
 * 2. payload.properties?.text — only if event_type === 'UserPromptSubmit'
 * 3. payload.properties?.info?.text — Hook inner info.text
 * 4. payload.part?.text — message.part.updated (inner properties directly)
 * 5. payload.userMessage — legacy fallback
 */
export function extractUserMessage(payload: Record<string, any>): string {
  const eventType = payload.event_type as string | undefined;

  // chat.message format (real opencode): user prompt in output.message.parts[0].text
  if (eventType === 'chat.message') {
    const parts = payload.output?.message?.parts as any[] | undefined;
    if (parts && parts.length > 0 && typeof parts[0].text === 'string') {
      return parts[0].text;
    }
    // Alternative path: output.parts[0].text
    const altParts = payload.output?.parts as any[] | undefined;
    if (altParts && altParts.length > 0 && typeof altParts[0].text === 'string') {
      return altParts[0].text;
    }
  }

  // Hook full event: properties.text — ONLY for UserPromptSubmit.
  // For session.next.text.ended / chat.message, this field contains
  // the agent response, NOT the user prompt.
  if (eventType === 'UserPromptSubmit' && typeof payload.properties?.text === 'string') {
    return payload.properties.text;
  }

  // Hook info: properties.info.text
  if (typeof payload.properties?.info?.text === 'string') return payload.properties.info.text;
  // Hook inner part: part.text (message.part.updated inner properties)
  if (typeof payload.part?.text === 'string') return payload.part.text;
  // Fallback: top-level userMessage
  if (typeof payload.userMessage === 'string') return payload.userMessage;
  return '';
}

/**
 * Extract the agent reply/response from a ContractDelivery payload.
 * Normalizes across:
 * - Hook nested: properties.text, properties.part.text
 * - Hook inner (message.* events): part.text
 * - Hook info: properties.info.text
 */
export function extractAgentReply(payload: Record<string, any>): string {
  // Real opencode: message.part.updated text response (inner = properties)
  if (typeof payload.text === 'string' && payload.type === 'text') return payload.text;
  // Hook nested — properties.part.text (message.part.updated, etc.)
  if (typeof payload.properties?.part?.text === 'string') return payload.properties.part.text;
  // Hook nested — properties.text (session.next.text.ended, chat.message)
  if (typeof payload.properties?.text === 'string') return payload.properties.text;
  // Hook inner — part.text (when payload is properties directly)
  if (typeof payload.part?.text === 'string') return payload.part.text;
  // Subagent PostToolUse output via tool state (real opencode subagent response)
  if (typeof payload.state?.output === 'string' && (payload.state.output as string).length > 0) return payload.state.output;
  // Subagent message.part.updated with text inside part.state.output
  if (typeof payload.part?.state?.output === 'string' && (payload.part.state.output as string).length > 0) return payload.part.state.output;
  // Bare top-level text (fallback for edge cases)
  if (typeof payload.text === 'string' && (payload.text as string).length > 0) return payload.text;
  // Hook info — properties.info.text
  if (typeof payload.properties?.info?.text === 'string') return payload.properties.info.text;
  // Fallback: top-level agentReply
  if (typeof payload.agentReply === 'string') return payload.agentReply;
  // Additional: state.output (subagent PostToolUse tool state carrying output text)
  if (payload.state && typeof payload.state === 'object') {
    const st = payload.state as Record<string, any>;
    if (typeof st.output === 'string' && st.output.length > 0) return st.output;
    if (typeof st.text === 'string' && st.text.length > 0) return st.text;
  }
  // Additional: bare text field (edge case where adapter passes text at top level)
  if (typeof payload.text === 'string' && payload.text.length > 0 && !payload.type) return payload.text;
  // REQ-1: Diagnostic logging when extraction fails but payload has content-bearing keys
  const contentKeys = ['part', 'state', 'properties', 'text', 'output', 'message', 'response'];
  const hasContentKeys = contentKeys.some(k => k in payload);
  if (hasContentKeys) {
    console.debug('[extractAgentReply] No text extracted. Payload keys:', Object.keys(payload), 'Payload preview:', JSON.stringify(payload).slice(0, 500));
  }
  return '';
}

/**
 * Extract the agent thinking/reasoning from a ContractDelivery payload.
 */
export function extractAgentThinking(payload: Record<string, any>): string {
  if (typeof payload.properties?.part?.reasoning === 'string') return payload.properties.part.reasoning;
  if (typeof payload.properties?.info?.reasoning === 'string') return payload.properties.info.reasoning;
  if (typeof payload.part?.reasoning === 'string') return payload.part.reasoning;
  if (typeof payload.agentThinking === 'string') return payload.agentThinking;
  return '';
}

/**
 * Extract token counts from a ContractDelivery payload.
 * Normalizes across:
 * - Real opencode message.updated: properties.info.tokens.input, properties.info.tokens.output
 * - Real opencode session.updated: properties.info.tokens.input, properties.info.tokens.output
 * - Hook nested: properties.info.turnInputTokens, properties.info.turnOutputTokens
 * - Hook fallback: top-level turnInputTokens, turnOutputTokens
 */
export function extractTokenCounts(payload: Record<string, any>): { promptTokens: number; completionTokens: number } {
  let promptTokens = 0;
  let completionTokens = 0;

  // Real opencode message.updated: info.tokens.input/output
  // The adapter extracts inner = properties for message.* events,
  // so info.tokens is at payload.info.tokens (direct) or payload.properties.info.tokens
  const info = payload.info as Record<string, any> | undefined;
  const propsInfo = payload.properties?.info as Record<string, any> | undefined;
  const tokens = info?.tokens ?? propsInfo?.tokens;
  if (tokens && typeof tokens === 'object') {
    if (typeof tokens.input === 'number') promptTokens = tokens.input;
    if (typeof tokens.output === 'number') completionTokens = tokens.output;
    // Only use session-level tokens if no per-message tokens available
    if (promptTokens > 0 || completionTokens > 0) {
      return { promptTokens, completionTokens };
    }
  }

  // Hook nested — properties.info.turnInputTokens / turnOutputTokens
  if (typeof payload.properties?.info?.turnInputTokens === 'number') promptTokens = payload.properties.info.turnInputTokens;
  if (typeof payload.properties?.info?.turnOutputTokens === 'number') completionTokens = payload.properties.info.turnOutputTokens;

  // Hook fallback: top-level turnInputTokens / turnOutputTokens
  if (typeof payload.turnInputTokens === 'number') promptTokens = payload.turnInputTokens;
  if (typeof payload.turnOutputTokens === 'number') completionTokens = payload.turnOutputTokens;

  return { promptTokens, completionTokens };
}

/**
 * Extract agent name and model from a ContractDelivery payload.
 */
export function extractAgentModel(payload: Record<string, any>): { agent?: string; model?: string } {
  // Real opencode chat.message: input.agent, input.model.modelID
  const chatInput = payload.input as Record<string, any> | undefined;
  if (chatInput?.agent) {
    const result: { agent?: string; model?: string } = {};
    if (typeof chatInput.agent === 'string') result.agent = chatInput.agent;
    if (chatInput.model && typeof chatInput.model.modelID === 'string') {
      result.model = chatInput.model.modelID;
    }
    if (result.agent || result.model) return result;
  }

  const agent = payload.properties?.info?.agent as string
    ?? payload.properties?.agent as string
    ?? payload.agent as string
    ?? undefined;
  const model = payload.properties?.info?.modelID as string
    ?? payload.properties?.modelID as string
    ?? payload.model as string
    ?? undefined;
  return { agent, model };
}

// -- Status colors ------------------------------------------------------------

export const GRAPH_STATUS_COLORS: Record<GraphNodeStatus, string> = {
  'in-progress': '#a855f7', // purple
  'active':       '#6366f1', // indigo
  'complete':     '#334155', // muted
  'error':        '#ef4444', // red
};

export const GRAPH_NODE_BORDER_COLORS: Record<GraphNodeType, string> = {
  agent:    '#a855f7', // purple
  subagent: '#6366f1', // indigo
  tool:     '#f97316', // orange
  file:     '#22c55e', // green
};

// ── AC-6: Subagent instruction text filtering ───────────────────────────────

/**
 * Filter out system prompt / instruction text and assistant reasoning from
 * subagent output.
 *
 * Real opencode subagent output has three concatenated sections:
 *   1. System prompt (instruction) — e.g., "Tell a programming-related joke..."
 *   2. Assistant reasoning    — e.g., "The user wants a programming-related joke..."
 *   3. Actual response        — e.g., "Why do programmers prefer dark mode?..."
 *
 * Strategy: (1) Strip exact instruction prefix if it matches.
 * (2) Sentence-level filtering — find the LAST sentence matching
 *     instruction/reasoning patterns; everything after is the response.
 * (3) Line-by-line reasoning + instruction verb prefix filtering (fallback).
 * (4) Relaxed sentence boundary filter (last-resort fallback).
 */
export function filterSubagentOutput(
  rawText: string,
  instruction?: string,
): string {
  if (!rawText) return '';

  let text = rawText.trimStart();

  // Step 1: Strip instruction prefix (if it matches)
  if (instruction && text) {
    const normalizedInstruction = instruction.trim();
    if (normalizedInstruction && text.startsWith(normalizedInstruction)) {
      text = text.slice(normalizedInstruction.length).trimStart();
    }
  }

  // ── Combined filter patterns ────────────────────────────────────────────
  // These are checked case-insensitively at the start of each sentence/line.

  /** Assistant reasoning / internal monologue patterns. */
  const reasoningPrefixes = [
    'the user wants', 'the user asks', 'the user is asking',
    'the user said', 'the user requested', 'the user needs',
    'the user just', 'the user is',
    "i'll just", "i'll provide", "i'll return", "i'll give",
    'let me', 'i need to', 'i will', 'i should', 'i can',
    'i think', "i'll write", "i'll make", "i'll create",
    "i'm going to", "i'm asked to", "i'm told to",
    'the instruction', 'the prompt', 'the task',
    'my task', 'my goal', 'my purpose',
  ];

  /** Instruction-like command verbs that introduce system prompts. */
  const instructionVerbs = [
    'tell', 'return', 'give', 'create', 'write', 'implement',
    'explain', 'list', 'find', 'provide', 'generate', 'make',
    'build', 'design', 'describe', 'summarize', 'answer',
    'respond', 'solve', 'fix', 'debug', 'say', 'share',
    'pick', 'choose', 'select', 'come up with', 'think of',
  ];

  const allPrefixes = [
    ...reasoningPrefixes,
    ...instructionVerbs.map(v => v.toLowerCase()),
  ];

  // Step 2: Sentence-level filtering with "last match" strategy.
  // Split text into sentences, scan ALL sentences, find the LAST sentence
  // matching instruction/reasoning patterns. Everything after it is response.
  // This replaces the "first non-match = response" heuristic which failed when
  // non-matching text (parent joke context, reference markers) appeared BEFORE
  // instruction/reasoning sentences.
  //
  // Works for both single-paragraph text (no newlines) and multi-paragraph text
  // because the boundary regex consumes \s* which matches any whitespace
  // including newlines.
  //
  // Example: "Because they don't C#. Return only the joke...The user wants...
  //           Let me give them...A SQL query walks into a bar..."
  //           Sentences 1-4 analyzed: matche are at indices 1 (return), 2 (the user),
  //           3 (let me). Last match = index 3. Response = everything after.
  const boundaryRegex = /(?<=[.!?])\s*(?:["')\]\u201D\u2019]*\s*)(?=[A-Z"'\/])/g;

  // Collect sentences with end positions using exec
  interface SentenceInfo {
    text: string;
    endPos: number;
  }

  const sentenceList: SentenceInfo[] = [];
  let currentStart = 0;
  let execMatch: RegExpExecArray | null;

  while ((execMatch = boundaryRegex.exec(text)) !== null) {
    const sentenceText = text.slice(currentStart, execMatch.index).trim();
    if (sentenceText) {
      sentenceList.push({
        text: sentenceText,
        endPos: execMatch.index + execMatch[0].length,
      });
    }
    currentStart = execMatch.index + execMatch[0].length;
  }

  // Last sentence (or the whole text if no boundaries found)
  const lastSentenceText = text.slice(currentStart).trim();
  if (lastSentenceText) {
    sentenceList.push({
      text: lastSentenceText,
      endPos: text.length,
    });
  }

  if (sentenceList.length >= 1) {
    // Scan ALL sentences, tracking the LAST match
    let lastMatchIndex = -1;

    for (let i = 0; i < sentenceList.length; i++) {
      const trimmed = sentenceList[i].text;
      if (!trimmed) continue;
      const lower = trimmed.toLowerCase();
      const isInstruction = instructionVerbs.some(v => lower.startsWith(v));
      const isReasoning = reasoningPrefixes.some(p => lower.startsWith(p));
      if (isInstruction || isReasoning) {
        lastMatchIndex = i;
      }
    }

    // If last match exists and it's not the last sentence, return everything
    // after the last matching sentence, preserving original formatting
    if (lastMatchIndex >= 0 && lastMatchIndex < sentenceList.length - 1) {
      const responseStart = sentenceList[lastMatchIndex].endPos;
      const result = text.slice(responseStart).trim();
      if (result) return result;
    }
  }

  // Step 3: Line-by-line filtering (fallback for text where sentence-level
  // analysis didn't find a response boundary). Matches each line against the
  // combined set of reasoning and instruction verb patterns.
  const lines = text.split('\n');
  const responseLines: string[] = [];
  let foundResponse = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (!foundResponse) {
      const lower = trimmed.toLowerCase();
      const isFiltered = allPrefixes.some(p => lower.startsWith(p));
      if (isFiltered) continue;
      foundResponse = true;
      responseLines.push(trimmed);
    } else {
      responseLines.push(trimmed);
    }
  }

  if (responseLines.length > 0) return responseLines.join('\n');

  // Step 4: Relaxed sentence boundary fallback (last-resort).
  // When the primary sentence-level analysis and line-by-line filtering both
  // failed to find a response boundary, try a relaxed sentence split that
  // also handles edge cases like quoted sentence boundaries where the regex
  // doesn't split (e.g., `..." Just return, nothing else.The user wants...`).
  if (text.length > 0) {
    // Try a relaxed sentence split: insert a sentinel before every potential
    // sentence boundary, then re-split by the sentinel. This finds boundaries
    // even when quotes/close-parens sit between the period and the next letter.
    const relaxedSentences = text
      .replace(
        /(?<=[.!?])\s*(?:["')\]\u201D\u2019]*\s*)(?=[A-Z"'(\[{])/g,
        '\x00',
      )
      .split('\x00')
      .map(s => s.trim())
      .filter(Boolean);

    if (relaxedSentences.length >= 1) {
      const filtered: string[] = [];
      let foundResponse = false;

      for (const s of relaxedSentences) {
        const lower = s.toLowerCase();
        if (!foundResponse) {
          const isInstruction = instructionVerbs.some(v => lower.startsWith(v));
          const isReasoning = reasoningPrefixes.some(p => lower.startsWith(p));
          if (isInstruction || isReasoning) continue;
          foundResponse = true;
          filtered.push(s);
        } else {
          filtered.push(s);
        }
      }

      if (filtered.length > 0) return filtered.join(' ');
    }

    // Last resort: if text doesn't start with a letter, or starts with a
    // known instruction verb, return the original text as-is (the filtering
    // couldn't improve it).
  }

  return text;
}

// ═══════════════════════════════════════════════════════════════════════════
// CHILD-TO-PARENT SESSION MAPPING (Spec #382)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Module-scoped map: child sessionId → parent sessionId.
 * Survives React mount/unmount — not tied to React lifecycle.
 * Populated from PostToolUse task deliveries (tool_response.metadata).
 * Follows the same cross-mount persistence pattern as `deletedSessionIds`
 * in persistence.ts.
 */
const childToParentSession = new Map<string, string>();

/**
 * Record a parent-child session relationship.
 * Called when a tool-use-lifecycle delivery for toolName 'task' with
 * lifecycle 'end' carries valid tool_response.metadata.parentSessionId
 * and tool_response.metadata.sessionId.
 */
export function setChildParentMapping(childId: string, parentId: string): void {
  // Cap childToParentSession at 1000 entries, evict oldest when exceeded (REQ-3)
  if (childToParentSession.size >= 1000) {
    const oldestKey = childToParentSession.keys().next().value;
    if (oldestKey !== undefined) {
      childToParentSession.delete(oldestKey);
    }
  }
  childToParentSession.set(childId, parentId);
}

/**
 * Look up the parent session for a child session, if any.
 * Returns undefined if the sessionId is not a known child session.
 */
export function getParentSession(childId: string): string | undefined {
  return childToParentSession.get(childId);
}

/**
 * Reset all child→parent mappings (test cleanup).
 * Only used in test files to isolate mapping state between tests.
 */
export function resetChildParentMappings(): void {
  childToParentSession.clear();
  processedMappingIds.clear();
}
