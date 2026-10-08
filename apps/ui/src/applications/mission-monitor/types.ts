import type { GraphNodeStatus, GraphNodeType } from './lib/graph';
import { tint } from '../../shared/utils/colorTint';

/**
 * MonitorNodeStatus — kept for backward compat with FocusWindow
 * and non-migrated consumers. New code uses GraphNodeStatus.
 */
export type MonitorNodeStatus =
  | 'working'             // purple — in process / thinking
  | 'error'               // red — failed
  | 'permission_required' // yellow — waiting for user approval
  | 'permission_granted'  // green — just approved (transitions back to working)
  | 'permission_denied'   // orange — user denied
  | 'inactive'            // no color — completed / idle
  | 'compacted';          // #475569 — session compacted

export interface NodeEventSnapshot {
  eventType: string;
  payload: Record<string, any>;
  timestamp: string;
}

export interface MonitorNodeData {
  eventType: string;
  status: MonitorNodeStatus;
  payload: Record<string, any>;
  timestamp: string;
  label: string;
  sublabel?: string;
  threadId: string;
  /** All events that contributed to this node (used by Focus Window) */
  relatedEvents: NodeEventSnapshot[];
}

export const STATUS_COLORS: Record<MonitorNodeStatus, string> = {
  working:             '#a855f7', // purple
  error:               '#ef4444', // red
  permission_required: '#eab308', // yellow
  permission_granted:  '#22c55e', // green
  permission_denied:   '#f97316', // orange
  inactive:            '#334155', // muted — no glow
  compacted:           '#475569', // slate — compacted
};

/**
 * Compacted node styling constants (inline styles — nodes use CSS modules, not
 * Chakra). #2748 ST-7 (AC-5): theme tokens only — borderColor resolves to
 * `var(--border-color)`, selectionRing to the accent ring (never a status
 * color); the badge fields were deleted with the COMPACTED badge (R-5.1).
 */
export const COMPACTED_STYLES = {
  opacity: 0.45,
  grayscale: 'grayscale(0.7)',
  borderColor: 'var(--border-color)',
  // color-mix tint (NOT `var(--accent-primary)66` — var() alpha-append is
  // invalid CSS and the browser drops the whole declaration, #2770 round 5).
  selectionRing: tint('var(--accent-primary)', 40),
} as const;

/** Maps hook event_type → ReactFlow node type string */
export const EVENT_TYPE_TO_NODE_TYPE: Record<string, string> = {
  invoke_agent:        'chatNode',
  chat:                'chatNode',
  'chat.message':      'chatNode',
  'message.updated':       'chatNode',
  'message.part.updated':  'chatNode',
  'message.part.delta':    'chatNode',
  'message.removed':       'chatNode',
  'message.part.removed':  'chatNode',
  'session.next.text.delta':   'chatNode',
  'session.next.text.started': 'chatNode',
  'session.next.text.ended':   'chatNode',
};

export const UPDATE_ONLY_EVENTS = new Set([
  'message.part.updated',
  'message.part.delta',
  'message.removed',
  'message.part.removed',
]);

/** Map GraphNodeType → ReactFlow node type string. #2764 ST-1: the standalone
 *  `tools` type was removed with the ToolsNode — tool calls embed inside the
 *  chat node (AgentNodePayload.tools). */
export const GRAPH_NODE_TYPE_MAP: Record<GraphNodeType, string> = {
  agent:    'agentNode',
  subagent: 'subagentNode',
};

/** Map GraphNodeStatus → MonitorNodeStatus (for backward compat) */
export function graphStatusToMonitorStatus(s: GraphNodeStatus): MonitorNodeStatus {
  switch (s) {
    case 'in-progress': return 'working';
    case 'active':      return 'working';
    case 'complete':    return 'inactive';
    case 'error':       return 'error';
    case 'compacted':   return 'compacted';
  }
}
