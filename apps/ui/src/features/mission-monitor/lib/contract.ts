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
 *
 * ── Backward Compat ─────────────────────────────────────────────────────────
 * Legacy types (TurnPayload, SubagentPayload, SubagentContract, SessionCounters,
 * computeSessionCounters, eventPayload, formatTokenCount, isFinalPart) are kept
 * for hooks/ and lib/ that have not yet migrated to the ECE pipeline.
 * These do NOT import from StreamContext — a minimal local FredoEvent interface
 * avoids the dependency.
 */

import type { ContractDelivery } from '../../../shared/classes/EventSubscription';

// ═══════════════════════════════════════════════════════════════════════════
// LOCAL FREDOEVENT — avoids StreamContext import for legacy helpers
// ═══════════════════════════════════════════════════════════════════════════

/** Minimal FredoEvent shape — kept for legacy helpers only. */
interface FredoEvent {
  id: string;
  eventType: string;
  state: string;
  provider: string;
  transport: string;
  sessionId: string;
  payload: Record<string, unknown> | null;
  correlationId?: string;
  toolName?: string;
  error?: unknown;
  metadata?: unknown;
  timestamp: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// LEGACY TYPES — kept for backward compat with hooks/ and lib/
// ═══════════════════════════════════════════════════════════════════════════

/** @deprecated Use AgentNodePayload instead. Turn data payload carried by ChatNode. */
export interface TurnPayload {
  userPrompt: string;
  userTimestamp: string;
  thinkingText: string;
  responseText: string;
  turnTools: number;
  turnFiles: number;
  model?: string;
  turnInputTokens: number;
  turnOutputTokens: number;
  agent?: string;
}

/** @deprecated Use SubagentNodePayload instead. */
export interface SubagentPayload {
  subagentName: string;
  instruction: string;
  output: string;
  parentCorrelationId: string;
}

/** @deprecated Use SubagentNodePayload instead. */
export interface SubagentContract {
  readonly name: 'subagent';
  subagentName: string;
  instruction: string;
  output: string;
  parentCorrelationId: string;
}

/** Session-level counters displayed in panel header badges. */
export interface SessionCounters {
  tools: number;
  files: number;
  subagents: number;
  tokens: number;
}

/**
 * Compute session counters from a list of persisted FredoEvents.
 * @deprecated Use ECE delivery-driven counters instead.
 */
export function computeSessionCounters(_events: FredoEvent[]): SessionCounters {
  // Stub — legacy path, not used by ECE pipeline
  return { tools: 0, files: 0, subagents: 0, tokens: 0 };
}

/**
 * Extract the usable payload from a FredoEvent regardless of transport.
 * @deprecated Use ContractDelivery.payload directly.
 */
export function eventPayload(ev: FredoEvent): Record<string, any> {
  const directPayload = (ev.payload ?? {}) as Record<string, any>;
  if (ev.transport === 'otlp_grpc' || ev.transport === 'otlp_http') {
    const meta = ev.metadata as Record<string, any> | null;
    const metaAttrs = (meta?.attributes ?? {}) as Record<string, any>;
    return { ...metaAttrs, ...directPayload };
  }
  return directPayload;
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

/**
 * Returns true if the part is a final (non-delta) part that contributes to a turn.
 * @deprecated Use ECE delivery lifecycle instead.
 */
export function isFinalPart(part: Record<string, any>): boolean {
  if (typeof part.text === 'string' && part.text.length > 0) return true;
  if (part.type === 'tool' && part.tool) return true;
  if (part.type === 'agent' || part.type === 'subtask') return true;
  return false;
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
