/**
 * Spec #555 TypeScript contract stub — compaction display + custom event storage.
 *
 * This file defines the type-level contract for Phase 2 Mission Monitor frontend changes.
 * Developers implement against this contract; only the Architect may modify it.
 *
 * # Capsule C (Mission Monitor Frontend) implements:
 *   - `compacted` status on agent/subagent nodes (ChatNode, SubagentNode)
 *   - `custom-event` ECE contract declaration in MissionMonitorFeature
 *   - Module-scoped custom event storage (no ReactFlow nodes)
 */

import type { EventContractDeclaration } from '../../../shared/classes/EventSubscription';

// ── REQ-8: Compaction ──────────────────────────────────────────────────────

/** Payload shape for a compaction delivery via the chat-node contract. */
export interface CompactedNodePayload {
  /** True when the session has been compacted by OpenCode. */
  compacted: boolean;
  sessionId?: string;
  correlationId?: string;
}

/** Compacted node styling constants (inline styles — nodes use CSS modules, not Chakra). */
export const COMPACTED_STYLES = {
  opacity: 0.45,
  grayscale: 'grayscale(0.7)',
  borderColor: '#475569',
  badgeBackground: '#47556933',
  badgeColor: '#94a3b8',
  selectionRing: '#47556966',
} as const;

/**
 * Contract: `types.ts` must add `'compacted'` to `MonitorNodeStatus` union
 * and `STATUS_COLORS.compacted = '#475569'`.
 *
 * `contract.ts` must add `'compacted'` to `GraphNodeStatus` union.
 *
 * `useMissionMonitor.ts` must detect `compacted: true` in `chat-node` delivery
 * payloads and set node status to `'compacted'`.
 *
 * `ChatNode.tsx` and `SubagentNode.tsx` must apply:
 *   - opacity: COMPACTED_STYLES.opacity on outer container
 *   - filter: COMPACTED_STYLES.grayscale on outer container
 *   - border: dashed + COMPACTED_STYLES.borderColor
 *   - "COMPACTED" badge in title bar row (8px, uppercase)
 *   - All glow animations suppressed
 *   - aria-label="Session compacted" on badge
 */

// ── REQ-10: Custom Event Contract ──────────────────────────────────────────

/** ECE contract declaration for capturing Phase 1 normalized custom events. */
export const CUSTOM_EVENT_CONTRACT: EventContractDeclaration = {
  contractName: 'custom-event',
  streamFields: ['payload', 'state', 'toolName'],
  deferredFields: [],
  key: ['sessionId', 'correlationId'],
  completeWhen: "state === 'Response'",
  timeout: 30000,
  eventTypes: ['custom'],
};

/**
 * Contract: `MissionMonitorFeature.tsx` must add `CUSTOM_EVENT_CONTRACT`
 * to the `eventContracts` array (alongside `chat-node` and `tool-use-lifecycle`).
 * No additional wiring needed — `Home.tsx` auto-collects all feature contracts.
 */

// ── REQ-11: Custom Event Storage ───────────────────────────────────────────

/** Normalized custom event data from a `custom-event` contract delivery. */
export interface CustomEventData {
  /** The contract delivery ID. */
  deliveryId: string;
  /** Event toolName: 'file.edited' | 'permission.asked' | 'permission.replied' | 'command.executed'. */
  toolName: string;
  /** The full delivery payload (second-level, unwrapped from ECE). */
  payload: Record<string, unknown>;
  /** ISO timestamp from the delivery. */
  timestamp: string;
  /** Session ID this event belongs to. */
  sessionId: string;
}

/**
 * Module-scoped storage for custom event deliveries.
 * Uses module-level Map (not React ref) to survive mount/unmount cycles.
 *
 * Key: sessionId
 * Value: array of CustomEventData in arrival order
 */
export const customEventStore: Map<string, CustomEventData[]> = new Map();

/**
 * Contract: `useMissionMonitor.ts` must:
 * 1. Handle `custom-event` deliveries in `processDelivery()` switch
 * 2. On any lifecycle (init/update/end): push `CustomEventData` to
 *    `customEventStore` keyed by `deliverySessionId(delivery)`
 * 3. NOT create ReactFlow nodes for custom events
 * 4. NOT modify the graph builder state (agentNodes, subagentNodes, etc.)
 */

// ── REQ-9: Graph Topology ──────────────────────────────────────────────────

/**
 * Contract: Compaction status changes MUST NOT:
 * - Change node dimensions (width, height)
 * - Change node position (x, y in ReactFlow)
 * - Remove or add edges
 * - Trigger a graph layout recomputation
 *
 * Only the node's `data.status` field changes to `'compacted'`.
 * The ReactFlow `nodeColor` callback in `MissionMonitorPanel.tsx` must
 * map `'compacted'` to `'#475569'` for MiniMap coloring.
 */
