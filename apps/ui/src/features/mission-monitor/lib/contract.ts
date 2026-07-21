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
export type GraphNodeStatus = 'in-progress' | 'active' | 'complete' | 'error' | 'compacted';

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

/** Extract correlation ID from a ContractDelivery. */
export function deliveryCorrelationId(d: ContractDelivery): string {

  return d.key?.correlationId ?? d.id;
}

/**
 * Extract the inner payload from a ContractDelivery.
 * The ECE payload has 2-level nesting — delivery.payload['payload'] gets the inner data.
 *
 * Spec #555 (Compaction AC-7): Diagnostic logging to surface when the 'payload'
 * stream field is missing from the ECE delivery's outer payload. The inner
 * payload (delivery.payload['payload']) should contain the event's raw payload
 * object (e.g. `{compacted: true}`). When it's absent, log the available keys
 * and fall back to the full outer payload.
 */
export function extractDeliveryPayload(d: ContractDelivery): Record<string, unknown> {
  const inner = d.payload?.['payload'] as Record<string, unknown> | undefined;

  // Spec #555: Diagnostic — log when the inner payload is missing or empty
  // to help debug AC-7 compaction delivery issues.
  if (d.contractName === 'chat-node' && d.lifecycle === 'end') {
    const outerKeys = d.payload ? Object.keys(d.payload) : [];
    const hasInner = inner !== undefined && inner !== null && typeof inner === 'object' && Object.keys(inner).length > 0;
    if (!hasInner) {
      console.debug(
        '[extractDeliveryPayload] ECE delivery missing inner payload',
        `contractName=${d.contractName}`,
        `lifecycle=${d.lifecycle}`,
        `outerKeys=[${outerKeys.join(',')}]`,
        `inner=${inner === undefined ? 'undefined' : inner === null ? 'null' : JSON.stringify(inner)}`,
        `correlationId=${d.key?.correlationId ?? 'N/A'}`,
        `sessionId=${d.key?.sessionId ?? 'N/A'}`,
      );
    }
  }

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
 * Verify a ContractDelivery matches the custom-event contract.
 */
export function isCustomEventDelivery(d: ContractDelivery): boolean {
  return d.contractName === 'custom-event';
}

/**
 * Extract ToolNodePayload from a tool-use-lifecycle delivery.
 * Uses single canonical paths from the inner delivery payload.
 */
export function makeToolNodePayload(
  d: ContractDelivery,
  parentCorrelationId: string,
): ToolNodePayload {
  const p = extractDeliveryPayload(d);
  return {
    toolName: (p.toolName as string) ?? 'unknown-tool',
    input: typeof p.input === 'string' ? (p.input as string) : undefined,
    output: typeof p.output === 'string' ? (p.output as string) : undefined,
    parentCorrelationId,
    correlationId: deliveryCorrelationId(d),
    sessionId: deliverySessionId(d),
  };
}

/**
 * Extract SubagentNodePayload from a subagent-lifecycle delivery.
 * Uses single canonical paths from the inner delivery payload.
 */
export function makeSubagentNodePayload(
  d: ContractDelivery,
  parentCorrelationId: string,
): SubagentNodePayload {
  const p = extractDeliveryPayload(d);
  // Spec #627: OTLP subagent session spans carry agent (not name) and
  // response_text/agentReply (not output). Add fallbacks so the SubagentNode
  // displays correctly when created from OTLP-derived deliveries.
  const name = (p.name as string) || (p.agent as string) || 'unknown-subagent';
  const output = (typeof p.output === 'string' && p.output)
    || (typeof p.response_text === 'string' && p.response_text as string)
    || (typeof p.agentReply === 'string' && p.agentReply as string)
    || '';
  return {
    name,
    instruction: typeof p.instruction === 'string' ? (p.instruction as string) : '',
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
  'compacted':    '#475569', // slate
};

export const GRAPH_NODE_BORDER_COLORS: Record<GraphNodeType, string> = {
  agent:    '#a855f7', // purple
  subagent: '#6366f1', // indigo
  tool:     '#f97316', // orange
  file:     '#22c55e', // green
};

