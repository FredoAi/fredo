/**
 * Mission Monitor Contract — Delivery-driven types for ECE pipeline.
 *
 * Capsule B (Delivery-Driven Refactor) implements these types.
 * All components consume ContractDelivery objects exclusively.
 */

import type { ContractDelivery } from '../../../shared/classes/EventSubscription';

// ── Delivery-driven types ─────────────────────────────────────────────────────

/** A session extracted from deliveries — no localStorage */
export interface MissionMonitorSession {
  sessionId: string;
  label: string;
  startTime: number;
  latestTimestamp: string;
  deliveryCount: number;
}

/** Node types for the ReactFlow graph */
export type GraphNodeType = 'agent' | 'subagent' | 'tool' | 'file';

/** Node status — derived from ContractDelivery lifecycle */
export type GraphNodeStatus = 'in-progress' | 'active' | 'complete' | 'error';

/** Payload carried by AgentNode — extracted from ContractDelivery payload */
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

/** Payload carried by SubagentNode */
export interface SubagentNodePayload {
  name: string;
  instruction: string;
  output: string;
  parentCorrelationId: string;
  correlationId: string;
  sessionId: string;
}

/** Payload carried by ToolNode */
export interface ToolNodePayload {
  toolName: string;
  input?: string;
  output?: string;
  parentCorrelationId: string;
  correlationId: string;
  sessionId: string;
}

/** Payload carried by FileNode */
export interface FileNodePayload {
  filePath: string;
  operation: 'read' | 'write';
  parentToolId: string;
  sessionId: string;
}

/** Union type for all node payloads */
export type GraphNodePayload = AgentNodePayload | SubagentNodePayload | ToolNodePayload | FileNodePayload;

/** Edge types */
export type GraphEdgeType = 'parent' | 'calls' | 'reads' | 'writes';

/** Internal graph node representation (before ReactFlow conversion) */
export interface GraphNode {
  id: string;
  type: GraphNodeType;
  status: GraphNodeStatus;
  payload: GraphNodePayload;
  label: string;
  timestamp: string;
}

/** Internal graph edge representation (before ReactFlow conversion) */
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: GraphEdgeType;
}

// ── Status colors ────────────────────────────────────────────────────────────

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

// ── Empty state jokes ────────────────────────────────────────────────────────

export const EMPTY_STATE_JOKES = [
  "I asked my AI to organize my desktop. It created 47 folders named 'Stuff' and called it a day.",
  "My agent said it had 'one small question' — 847 messages later, we're still debugging a semicolon.",
  "The AI promised to refactor my codebase. It replaced every function with a comment that says '// TODO: implement' — truly, an artist.",
] as const;

// ── Contract helpers ─────────────────────────────────────────────────────────

/** Verify a ContractDelivery matches the chat-node contract */
export function isChatNodeDelivery(d: ContractDelivery): boolean {
  return d.contractName === 'chat-node';
}

/** Extract session ID from a ContractDelivery */
export function deliverySessionId(d: ContractDelivery): string {
  return d.key?.sessionId ?? 'unknown';
}

/** Extract correlation ID from a ContractDelivery */
export function deliveryCorrelationId(d: ContractDelivery): string {
  return d.key?.correlationId ?? d.id;
}

/**
 * Extract the inner payload from a ContractDelivery.
 * The ECE payload has 2-level nesting — delivery.payload['payload'] gets the inner data.
 */
export function extractDeliveryPayload(d: ContractDelivery): Record<string, unknown> {
  const inner = d.payload?.['payload'] as Record<string, unknown> | undefined;
  return inner ?? d.payload ?? {};
}

/**
 * Format a token count for display in the ChatNode bottom bar.
 *
 * - < 1 000       → raw number (e.g., "420", "0")
 * - ≥ 1 000       → "X.Yk" with one decimal (e.g., 1840 → "1.8k", 1000 → "1k")
 * - ≥ 1 000 000   → "X.YM" with one decimal (e.g., 2500000 → "2.5M", 2000000 → "2M")
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

/** Session-level counters displayed in panel header badges */
export interface SessionCounters {
  tools: number;
  files: number;
  subagents: number;
  tokens: number;
}

// Retained legacy types for backward compat with non-ECE features
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

export interface SubagentPayload {
  subagentName: string;
  instruction: string;
  output: string;
  parentCorrelationId: string;
}
