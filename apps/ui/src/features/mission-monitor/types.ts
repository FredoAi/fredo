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
  PostToolUseFailure:  'toolUseNode',
  // OTLP operation names
  invoke_agent:        'chatNode',
  execute_tool:        'toolUseNode',
  chat:                'chatNode',
  'chat.message':      'chatNode',
  // Permission
  permission:          'permissionNode',
  'permission.asked':  'permissionNode',
  'permission.replied':'permissionNode',
  // File changes
  'file.edited':       'fileChangedNode',
  // Command execution
  'command.executed':  'toolUseNode',
  // Session lifecycle
  SessionStart:        'sessionNode',
  SessionEnd:          'sessionNode',
  'session.created':   'sessionNode',
  'session.updated':   'sessionNode',
  'session.deleted':   'sessionNode',
  'session.status':    'sessionNode',
  'session.error':     'sessionNode',
  'session.idle':      'sessionNode',
  // Message update/delta events
  'message.updated':       'chatNode',
  'message.part.updated':  'chatNode',
  'message.part.delta':    'chatNode',
  'message.removed':       'chatNode',
  'message.part.removed':  'chatNode',
  // Session next-turn events
  'session.next.tool.called':  'toolUseNode',
  'session.next.tool.success': 'toolUseNode',
  'session.next.tool.failed':  'toolUseNode',
  'session.next.text.delta':   'chatNode',
  'session.next.text.started': 'chatNode',
  'session.next.text.ended':   'chatNode',
  'session.next.step.started':    'sessionNode',
  'session.next.step.ended':      'sessionNode',
  'session.next.agent.switched':  'sessionNode',
};

/**
 * Events that mutate an existing node rather than create a new one.
 */
export const UPDATE_ONLY_EVENTS = new Set([
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'SubagentStop',
  'TaskCompleted',
  // Session next-turn completion events update in-flight nodes
  'session.next.tool.success',
  'session.next.tool.failed',
  'session.next.text.ended',
  'session.next.step.ended',
  'message.part.updated',
  'message.part.delta',
  'message.removed',
  'message.part.removed',
]);
