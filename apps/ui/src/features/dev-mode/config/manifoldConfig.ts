/**
 * Manifold configuration
 *
 * Tool → category mapping and category → RGB for the 3D spatiotemporal manifold.
 * All RGB values are [0–1] normalized (Three.js convention).
 */

// ── Tool categories ───────────────────────────────────────────────────────────

export type ToolCategory =
  | 'kubectl-read'
  | 'kubectl-write'
  | 'observability'
  | 'ui-control'
  | 'azdo'
  | 'meta'
  | 'otlp'
  | 'unknown';

export const TOOL_CATEGORY: Record<string, ToolCategory> = {
  // K8s read
  kubectl_get_pods:           'kubectl-read',
  kubectl_describe_pod:       'kubectl-read',
  kubectl_get_deployments:    'kubectl-read',
  kubectl_get_services:       'kubectl-read',
  kubectl_get_events:         'kubectl-read',
  kubectl_top_pods:           'kubectl-read',
  kubectl_logs:               'kubectl-read',
  kubectl_rollout_status:     'kubectl-read',

  // K8s write / exec
  kubectl_exec:               'kubectl-write',
  kubectl_delete_pod:         'kubectl-write',
  kubectl_restart_deployment: 'kubectl-write',
  kubectl_scale_deployment:   'kubectl-write',

  // Observability
  logs_query:                 'observability',
  metrics_query:              'observability',
  traces_query:               'observability',
  infrastructure_snapshot:    'observability',
  infrastructure_stream:      'observability',

  // UI control
  Fredo_ui_stepper:          'ui-control',
  Fredo_ui_alert:            'ui-control',
  Fredo_ui_collect_responses:'ui-control',

  // Azure DevOps
  azdo_create_workitem:       'azdo',
  azdo_start_workitem:        'azdo',

  // Meta
  kb_sops:                    'meta',
  tools_documentation:        'meta',

  // Hook lifecycle events (OpenCode)
  SessionStart:               'meta',
  SessionEnd:                 'meta',
  Setup:                      'meta',
  Stop:                       'meta',
  StopFailure:                'kubectl-write',
  UserPromptSubmit:           'ui-control',
  UserPromptSubmitted:        'ui-control',
  UserPromptExpansion:        'ui-control',
  PreToolUse:                 'kubectl-read',
  PostToolUse:                'observability',
  PostToolUseFailure:         'kubectl-write',
  PostToolBatch:              'observability',
  PermissionRequest:          'azdo',
  PermissionDenied:           'kubectl-write',
  SubagentStart:              'meta',
  SubagentStop:               'meta',
  TaskCreated:                'azdo',
  TaskCompleted:              'observability',
  TeammateIdle:               'meta',
  Notification:               'ui-control',
  ConfigChange:               'meta',
  CwdChanged:                 'meta',
  FileChanged:                'kubectl-read',
  WorktreeCreate:             'kubectl-write',
  WorktreeRemove:             'kubectl-write',
  PreCompact:                 'meta',
  PostCompact:                'meta',
  InstructionsLoaded:         'meta',
  Elicitation:                'ui-control',
  ElicitationResult:          'ui-control',
  errorOccurred:              'kubectl-write',
};

/** RGB [0–1] per category */
export const CATEGORY_RGB: Record<ToolCategory, [number, number, number]> = {
  'kubectl-read':  [0.231, 0.510, 0.965],  // #3b82f6 blue
  'kubectl-write': [0.937, 0.267, 0.267],  // #ef4444 red
  'observability': [0.133, 0.773, 0.333],  // #22c55e green
  'ui-control':    [0.576, 0.322, 0.949],  // #9333f2 purple
  'azdo':          [0.016, 0.647, 0.925],  // #04a5ec cyan
  'meta':          [0.961, 0.620, 0.043],  // #f59e0b amber
  'otlp':          [1.000, 0.388, 0.278],  // #ff6347 tomato-orange
  'unknown':       [0.380, 0.380, 0.380],  // #616161 gray
};

/**
 * Resolve a `ToolCategory` for an event, accounting for OTLP source.
 * Pass the raw `source` string from `StreamEvent.source` (or undefined).
 */
export function getCategory(
  toolName: string,
  source?: string,
): ToolCategory {
  if (source === 'OtlpGrpc' || source === 'OtlpHttp') return 'otlp';
  return (TOOL_CATEGORY[toolName] ?? 'unknown') as ToolCategory;
}

/** RGB [0–1] per event state */
export const STATE_RGB: Record<string, [number, number, number]> = {
  Init:     [0.231, 0.510, 0.965],  // #3b82f6
  Update:   [0.961, 0.620, 0.043],  // #f59e0b
  Response: [0.133, 0.773, 0.333],  // #22c55e
  Error:    [0.937, 0.267, 0.267],  // #ef4444
};

// ── Stable spatial hash helpers ───────────────────────────────────────────────

/** Deterministic 32-bit hash of a string (djb2 variant). */
export function hash32(str: string): number {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(h, 33) ^ str.charCodeAt(i)) >>> 0;
  }
  return h;
}

/** Map a hash to a float in [min, max]. */
export function hashToRange(h: number, seed: number, min: number, max: number): number {
  const v = (Math.imul(h, seed + 2654435761) >>> 0) / 0xffffffff;
  return min + v * (max - min);
}

// ── Tool stable 3D positions (Mode A: co-occurrence) ─────────────────────────
// Each tool gets a unique position on a sphere of radius ~6, seeded by its name.

export function toolPosition(toolName: string): [number, number, number] {
  const h  = hash32(toolName);
  const h2 = hash32(toolName + '_lat');
  const phi   = Math.acos(2 * hashToRange(h,  1, 0, 1) - 1);   // polar [0, π]
  const theta = hashToRange(h2, 3, 0, Math.PI * 2);             // azimuth [0, 2π]
  const r = 5.5;
  return [
    r * Math.sin(phi) * Math.cos(theta),
    r * Math.cos(phi),
    r * Math.sin(phi) * Math.sin(theta),
  ];
}

// ── Visualization modes ───────────────────────────────────────────────────────

export type ManifoldMode = 'cooccurrence' | 'flow' | 'fingerprints';

export const MODES: { id: ManifoldMode; label: string; tooltip: string }[] = [
  {
    id: 'cooccurrence',
    label: 'CO-OCC',
    tooltip: 'Tool co-occurrence — tools used together in the same session cluster together',
  },
  {
    id: 'flow',
    label: 'FLOW',
    tooltip: 'Temporal flow — events ordered by time, grouped by session and tool',
  },
  {
    id: 'fingerprints',
    label: 'PRINTS',
    tooltip: 'Session fingerprints — each session as a vertical column of tool calls',
  },
];
