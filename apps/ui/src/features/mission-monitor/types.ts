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

/**
 * The enriched payload stored in a ChatNode's data.payload.
 * All turns emit a single ChatNode with turn-accumulated data.
 */
export interface ChatNodePayload {
  /** The user's prompt text for this turn */
  userPrompt?: string;
  /** Accumulated thinking/reasoning text from streaming deltas */
  thinkingText?: string;
  /** Accumulated response text from streaming deltas */
  responseText?: string;
  /** Number of tool calls in this turn (non-file tools) */
  turnToolCount: number;
  /** Number of file-change tool calls in this turn */
  turnFileCount: number;
  /** Number of subagent invocations in this turn */
  turnSubagentCount: number;
  /** Input tokens consumed */
  inputTokens?: number;
  /** Output tokens generated */
  outputTokens?: number;
  /** Model identifier */
  model?: string;
  [key: string]: any;
}

/**
 * In-progress turn state per active thread.
 * Turns accumulate events until a response finalizes them into a ChatNode.
 */
export interface TurnData {
  /** User prompt text extracted from user-message events */
  userPrompt?: string;
  /** Accumulated thinking/reasoning text */
  thinkingText?: string;
  /** Accumulated response text */
  responseText?: string;
  /** Tool call count (non-file tools) */
  turnToolCount: number;
  /** File-change tool count */
  turnFileCount: number;
  /** Subagent invocation count */
  turnSubagentCount: number;
  /** Input tokens */
  inputTokens?: number;
  /** Output tokens */
  outputTokens?: number;
  /** Model identifier */
  model?: string;
  /** The ChatNode id once emitted for this turn */
  chatNodeId?: string;
  /** Whether a ChatNode has been emitted for this turn */
  emitted: boolean;
  /** Whether the response for this turn is complete */
  responseComplete: boolean;
  /** All events that contributed to this turn */
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
