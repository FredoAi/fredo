/**
 * Spec #369 Contract — Mission Monitor Data Pipeline Fix
 *
 * Type-level contract for frontend capsules. All capsules implement against these types.
 */

import type { ContractDelivery } from '../../../shared/classes/EventSubscription';

// ── Capsule 4: Frontend Graph Building + Layout ───────────────────────────

/** REQ-4: Extracted payload fields from any delivery (Hook or OTLP). */
export interface ExtractedAgentPayload {
  agent?: string;
  model?: string;
  userMessage: string;
  agentThinking: string;
  agentReply: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  correlationId: string;
  sessionId: string;
  endTime?: string;
}

/** REQ-4: Extract payload from a ContractDelivery, handling both Hook and OTLP shapes. */
export function req_4_extract_agent_payload(d: ContractDelivery): ExtractedAgentPayload {
  // Stub — filled by Capsule 4 implementation
  return {
    userMessage: '',
    agentThinking: '',
    agentReply: '',
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    correlationId: '',
    sessionId: '',
  };
}

/** REQ-6/7: Force simulation result. */
export interface ForceLayoutResult {
  positions: Map<string, { x: number; y: number }>;
  converged: boolean;
  iterations: number;
}

/** REQ-6/7: Run force-directed layout on nodes and edges. */
export function req_6_7_compute_force_layout(
  nodes: Array<{ id: string; status: string; x?: number; y?: number }>,
  edges: Array<{ source: string; target: string }>,
  options?: { maxIterations?: number; alphaMin?: number },
): ForceLayoutResult {
  // Stub — filled by Capsule 4 implementation
  return {
    positions: new Map(),
    converged: false,
    iterations: 0,
  };
}

/** REQ-8: Merge update payload with existing, preserving fields not in the update. */
export function req_8_merge_payload<T extends Record<string, unknown>>(
  existing: T,
  update: Partial<T>,
): T {
  // Stub — filled by Capsule 4 implementation
  return { ...existing, ...update };
}

/** REQ-9: Filter edges to only those with both source and target in the node set. */
export function req_9_filter_valid_edges(
  edges: Array<{ source: string; target: string }>,
  nodeIds: Set<string>,
): Array<{ source: string; target: string }> {
  // Stub — filled by Capsule 4 implementation
  return edges.filter(e => nodeIds.has(e.source) && nodeIds.has(e.target));
}
