/**
 * Event-related constants
 */

/**
 * Query Tool Names
 */
export const QUERY_TOOL_NAMES = ['logs_query', 'metrics_query', 'traces_query'] as const;

/**
 * Event States
 */
export const EVENT_STATES = {
  INIT: 'Init',
  UPDATE: 'Update',
  RESPONSE: 'Response',
  ERROR: 'Error',
} as const;

/**
 * Step Statuses (for SideStepper)
 */
export const STEP_STATUSES = {
  WAITING: 'Waiting',
  RUNNING: 'Running',
  COMPLETED: 'Completed',
  ERROR: 'Error',
} as const;

/**
 * Tool Names
 */
export const TOOL_NAMES = {
  LOGS_QUERY: 'logs_query',
  METRICS_QUERY: 'metrics_query',
  TRACES_QUERY: 'traces_query',
  INFRASTRUCTURE_SNAPSHOT: 'infrastructure_snapshot',
  INFRASTRUCTURE_STREAM: 'infrastructure_stream',
  Fredo_UI_STEPPER: 'Fredo_UI_STEPPER',
} as const;
