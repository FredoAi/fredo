export { MissionMonitorFeature, missionMonitorFeature } from './MissionMonitorFeature';
export type { SessionRecord } from './lib/sessionStorage';
export { loadSessions, getSessionEvents } from './lib/sessionStorage';

// ── Public types from ECE contract ──
export type {
  MissionMonitorSession,
  GraphNodeType,
  GraphNodeStatus,
  AgentNodePayload,
  SubagentNodePayload,
  ToolNodePayload,
  FileNodePayload,
  GraphNodePayload,
  GraphEdgeType,
  GraphNode,
  GraphEdge,
} from './lib/contract';
export {
  EMPTY_STATE_JOKES,
  isChatNodeDelivery,
  deliverySessionId,
  deliveryCorrelationId,
} from './lib/contract';

import { missionMonitorFeature } from './MissionMonitorFeature';
import { registerFeature } from '../featureRegistry';
registerFeature(missionMonitorFeature);
