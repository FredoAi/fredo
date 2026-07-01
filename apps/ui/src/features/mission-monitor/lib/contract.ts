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

/** Verify a ContractDelivery matches the chat-node contract. */
export function isChatNodeDelivery(d: ContractDelivery): boolean {
  return d.contractName === 'chat-node';
}

/** Extract session ID from a ContractDelivery. */
export function deliverySessionId(d: ContractDelivery): string {
  return d.key?.sessionId ?? 'unknown';
}

/** Detect if a payload uses OTLP-style flat attribute keys (gen_ai. prefix). */
function isOtlpPayload(p: Record<string, unknown>): boolean {
  return 'gen_ai.usage.input_tokens' in p
    || 'gen_ai.response.body' in p
    || 'gen_ai.tool.name' in p
    || 'gen_ai.subagent.name' in p
    || 'gen_ai.operation.name' in p;
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
  const isOtlp = isOtlpPayload(p);

  let toolName: string;
  let input: string | undefined;
  let output: string | undefined;

  if (isOtlp) {
    toolName = (p['gen_ai.tool.name'] as string) ?? outerToolName ?? 'unknown-tool';
    input = typeof p['gen_ai.tool.input'] === 'string' ? (p['gen_ai.tool.input'] as string) : undefined;
    output = typeof p['gen_ai.tool.output'] === 'string' ? (p['gen_ai.tool.output'] as string) : undefined;
  } else {
    toolName = outerToolName ?? (p['toolName'] as string) ?? 'unknown-tool';
    input = typeof p?.input === 'string' ? (p.input as string) : undefined;
    output = typeof p?.output === 'string' ? (p.output as string) : undefined;
  }

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
  const isOtlp = isOtlpPayload(p);

  let name: string;
  let instruction: string;
  let output: string;

  if (isOtlp) {
    name = (p['gen_ai.subagent.name'] as string) ?? outerName ?? 'unknown-subagent';
    instruction = typeof p['gen_ai.subagent.instruction'] === 'string' ? (p['gen_ai.subagent.instruction'] as string) : '';
    output = typeof p['gen_ai.subagent.output'] === 'string' ? (p['gen_ai.subagent.output'] as string) : '';
  } else {
    // Hook payloads: raw event structure varies by event source
    // - session.next.tool.* events have nested properties (properties.tool_name,
    //   properties.tool_input, properties.tool_response)
    // - PreToolUse/PostToolUse events pass tool_input/tool_response directly
    // - session.next.tool.* may also have tool_input/tool_response at TOP level
    //   (not nested under properties) depending on SDK version
    const props = p['properties'] as Record<string, any> | undefined;
    name = outerName
      ?? (p['toolName'] as string)
      ?? (p['tool_name'] as string)
      ?? (props?.['tool_name'] as string)
      ?? 'unknown-subagent';
    const pAny = p as Record<string, any>;
    instruction = typeof pAny?.instruction === 'string' ? (pAny.instruction as string)
      : (typeof pAny?.tool_input?.prompt === 'string' ? (pAny.tool_input.prompt as string)
      : (typeof props?.tool_input?.prompt === 'string' ? (props.tool_input.prompt as string)
      : (typeof props?.tool_input === 'string' ? (props.tool_input as string)
      : (typeof pAny?.tool_input === 'string' ? (pAny.tool_input as string)
      : ''))));
    output = typeof pAny?.output === 'string' ? (pAny.output as string)
      : (typeof pAny?.tool_response?.output === 'string' ? (pAny.tool_response.output as string)
      : (typeof props?.tool_response?.output === 'string' ? (props.tool_response.output as string)
      : (typeof props?.tool_response === 'string' ? (props.tool_response as string)
      : (typeof pAny?.tool_response === 'string' ? (pAny.tool_response as string)
      : ''))));
  }

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
 * Normalizes across Hook nested (properties.text) and OTLP flat shapes.
 *
 * Priority:
 * 1. payload.properties?.text — UserPromptSubmit (user's full prompt text)
 * 2. payload.properties?.info?.text — Hook inner info.text
 * 3. payload.part?.text — message.part.updated (inner properties directly)
 * 4. payload.userMessage — legacy fallback
 */
export function extractUserMessage(payload: Record<string, any>): string {
  // Hook full event: properties.text (UserPromptSubmit)
  if (typeof payload.properties?.text === 'string') return payload.properties.text;
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
 * - OTLP flat: gen_ai.response.body (highest priority — complete response body)
 * - Hook full event: properties.text, properties.part.text
 * - Hook inner (message.* events): part.text
 * - Hook info: properties.info.text
 */
export function extractAgentReply(payload: Record<string, any>): string {
  // OTLP flat (highest priority — complete response body)
  if (typeof payload['gen_ai.response.body'] === 'string') return payload['gen_ai.response.body'];
  // Hook nested — properties.text (session.next.text.ended, chat.message)
  if (typeof payload.properties?.text === 'string') return payload.properties.text;
  // Hook nested — properties.part.text (message.part.updated, etc.)
  if (typeof payload.properties?.part?.text === 'string') return payload.properties.part.text;
  // Hook inner — part.text (when payload is properties directly)
  if (typeof payload.part?.text === 'string') return payload.part.text;
  // Hook info — properties.info.text
  if (typeof payload.properties?.info?.text === 'string') return payload.properties.info.text;
  // Fallback: top-level agentReply
  if (typeof payload.agentReply === 'string') return payload.agentReply;
  // OTLP fallback: gen_ai.response.completion
  if (typeof payload['gen_ai.response.completion'] === 'string') return payload['gen_ai.response.completion'];
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
 * - OTLP flat: gen_ai.usage.input_tokens, gen_ai.usage.output_tokens (highest priority)
 * - Hook nested: properties.info.turnInputTokens, properties.info.turnOutputTokens
 * - Hook fallback: top-level turnInputTokens, turnOutputTokens
 * - OTLP alternative: gen_ai.usage.prompt_tokens, gen_ai.usage.completion_tokens
 */
export function extractTokenCounts(payload: Record<string, any>): { promptTokens: number; completionTokens: number } {
  let promptTokens = 0;
  let completionTokens = 0;

  // OTLP flat (highest priority — actual token counts from LLM)
  const otlpInput = payload['gen_ai.usage.input_tokens'];
  const otlpOutput = payload['gen_ai.usage.output_tokens'];
  if (otlpInput !== undefined) promptTokens = Number(otlpInput) || 0;
  if (otlpOutput !== undefined) completionTokens = Number(otlpOutput) || 0;

  // If OTLP provided token data, use it exclusively (most accurate)
  if (promptTokens > 0 || completionTokens > 0) {
    return { promptTokens, completionTokens };
  }

  // Hook nested — properties.info.turnInputTokens / turnOutputTokens
  if (typeof payload.properties?.info?.turnInputTokens === 'number') promptTokens = payload.properties.info.turnInputTokens;
  if (typeof payload.properties?.info?.turnOutputTokens === 'number') completionTokens = payload.properties.info.turnOutputTokens;

  // Hook fallback: top-level turnInputTokens / turnOutputTokens
  if (typeof payload.turnInputTokens === 'number') promptTokens = payload.turnInputTokens;
  if (typeof payload.turnOutputTokens === 'number') completionTokens = payload.turnOutputTokens;

  // OTLP alternative key names
  if (typeof payload['gen_ai.usage.prompt_tokens'] === 'number') promptTokens = payload['gen_ai.usage.prompt_tokens'];
  if (typeof payload['gen_ai.usage.completion_tokens'] === 'number') completionTokens = payload['gen_ai.usage.completion_tokens'];

  return { promptTokens, completionTokens };
}

/**
 * Extract agent name and model from a ContractDelivery payload.
 */
export function extractAgentModel(payload: Record<string, any>): { agent?: string; model?: string } {
  const agent = payload.properties?.info?.agent as string
    ?? payload.properties?.agent as string
    ?? payload.agent as string
    ?? undefined;
  const model = payload.properties?.info?.modelID as string
    ?? payload.properties?.modelID as string
    ?? payload.model as string
    ?? payload['gen_ai.request.model'] as string
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
