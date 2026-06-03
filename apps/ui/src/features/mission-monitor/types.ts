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

/** Tool names (from hook payload.tool_name) that produce a FileChangedNode */
export const FILE_TOOL_NAMES = new Set([
  'edit',
  'create',
  'apply_patch',
  'write',
  'write_file',
  'str_replace_editor',
  'str_replace_based_edit_tool',
]);

/** Maps hook event_type / OTLP toolName → ReactFlow node type string */
export const EVENT_TYPE_TO_NODE_TYPE: Record<string, string> = {
  // User prompts
  UserPromptSubmit:    'userPromptNode',
  UserPromptSubmitted: 'userPromptNode',
  UserPromptExpansion: 'userPromptNode',
  // Subagent
  SubagentStart:       'subagentNode',
  SubagentStop:        'subagentNode',
  // Tasks
  TaskCreated:         'taskNode',
  TaskCompleted:       'taskNode',
  // Tool use — resolved to fileChangedNode or toolUseNode by the builder
  PreToolUse:          'toolUseNode',
  PostToolBatch:       'toolUseNode',
  // OTLP operation names
  invoke_agent:        'agentResponseNode',
  execute_tool:        'toolUseNode',
  chat:                'agentResponseNode',
};

/**
 * Events that mutate an existing node rather than create a new one.
 * Also includes permission events which update the parent tool node.
 */
export const UPDATE_ONLY_EVENTS = new Set([
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'SubagentStop',
  'TaskCompleted',
  'SessionEnd',
]);
