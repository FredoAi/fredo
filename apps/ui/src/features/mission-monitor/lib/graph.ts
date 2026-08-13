/**
 * Mission Monitor Graph — ECE Delivery-Driven Types.
 *
 * Shared types, empty-state jokes, delivery-verification helpers, and node
 * color palettes for the Mission Monitor graph. All capsules in Spec #318
 * implement against these types.
 *
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
 * - < 1 000  → raw number (e.g., "420", "0")
 * - ≥ 1 000  → comma thousands separators, locale pinned to en-US
 *   (e.g., 1840 → "1,840", 2500000 → "2,500,000")
 *
 * 0 → "0"; 999 → "999"; 1_000 → "1,000"; 1_234 → "1,234"; 1_234_567 → "1,234,567"
 */
export function formatTokenCount(n: number): string {
  return n < 1_000 ? String(n) : n.toLocaleString('en-US');
}

/**
 * Zero/absent token guard (Spec #2717 R-3.3).
 *
 * A token category that is absent from a payload, or carries a non-finite or
 * negative figure, renders as `0` — never NaN, never negative, never a
 * mislabeled figure. The plugin skips usage attrs ≤ 0 on the wire, so "absent"
 * and "reported zero" are wire-indistinguishable; this guard converges both to 0.
 * `v + 0` also normalizes `-0` to `+0` (Object.is(-0, 0) is false — a `-0`
 * figure would otherwise render as "0" but compare unequal in tests).
 */
export function normalizeTokenCount(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v + 0 : 0;
}

/**
 * Compact token count for single-line node display (Spec #2723 R-2 / AC2).
 *
 * Display-only abbreviation used by the ChatNode compact token row so the five
 * categories fit on one line at 280px node widths:
 * - < 1,000     → raw ("0", "340")
 * - 1,000–9,999 → "1.2k" (one decimal; a trailing ".0" drops → "1k")
 * - ≥ 10,000    → "85k" (no decimal, rounded)
 *
 * This is NEVER used in an aria-label — every figure's aria-label must carry
 * the full comma-formatted number from `formatTokenCount()` (QA Q-2.1).
 */
export function formatCompactTokenCount(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 10_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
  return Math.round(n / 1_000) + 'k';
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
  promptTokens: number;      // per-turn Δinput (delta of cumulative input_tokens)
  completionTokens: number;  // per-turn output
  reasoningTokens: number;   // per-turn gen_ai.usage.reasoning.output_tokens (default 0)
  cacheReadTokens: number;   // per-turn gen_ai.usage.cache_read.input_tokens — "Cache" category (default 0)
  cacheWriteTokens: number;  // per-turn gen_ai.usage.cache_creation.input_tokens — carried, NEVER summed (default 0)
  totalTokens: number;       // promptTokens + cacheReadTokens + reasoningTokens + completionTokens
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
export type GraphEdgeType = 'parent' | 'calls' | 'reads' | 'writes' | 'chat';

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
// DELIVERY VERIFICATION HELPERS
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
