export type MonitorNodeStatus =
  | 'working'             // purple — in process / thinking
  | 'error'               // red — failed
  | 'permission_required' // yellow — waiting for user approval
  | 'permission_granted'  // green — just approved (transitions back to working)
  | 'permission_denied'   // orange — user denied
  | 'inactive';           // no color — completed / idle

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
};

/** Maps hook event_type / OTLP toolName → ReactFlow node type string */
export const EVENT_TYPE_TO_NODE_TYPE: Record<string, string> = {
  // OTLP operation names
  invoke_agent:        'chatNode',
  chat:                'chatNode',
  'chat.message':      'chatNode',
  // Message update/delta events
  'message.updated':       'chatNode',
  'message.part.updated':  'chatNode',
  'message.part.delta':    'chatNode',
  'message.removed':       'chatNode',
  'message.part.removed':  'chatNode',
  // Session next-turn text events
  'session.next.text.delta':   'chatNode',
  'session.next.text.started': 'chatNode',
  'session.next.text.ended':   'chatNode',
};

/**
 * Events that mutate an existing node rather than create a new one.
 */
export const UPDATE_ONLY_EVENTS = new Set([
  'message.part.updated',
  'message.part.delta',
  'message.removed',
  'message.part.removed',
]);
