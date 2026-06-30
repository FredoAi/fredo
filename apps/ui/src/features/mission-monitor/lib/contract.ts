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
    name = outerName ?? (p['toolName'] as string) ?? 'unknown-subagent';
    instruction = typeof p?.instruction === 'string' ? (p.instruction as string) : '';
    output = typeof p?.output === 'string' ? (p.output as string) : '';
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
