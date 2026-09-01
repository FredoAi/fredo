export { MissionMonitorFeature, missionMonitorFeature } from './MissionMonitorFeature';

// ── Public types from the graph model ──
export type {
  MissionMonitorSession,
  GraphNodeType,
  GraphNodeStatus,
  AgentNodePayload,
  SubagentNodePayload,
  GraphNodePayload,
  GraphEdgeType,
  GraphNode,
  GraphEdge,
} from './lib/graph';
export {
  EMPTY_STATE_JOKES,
  formatTokenCount,
} from './lib/graph';
// v1 delivery helpers — SIDEBAR-ONLY until the P4.3 session-list migration
// deletes them (the graph derives from typed rows since P4.2).
export {
  isChatNodeDelivery,
  deliverySessionId,
  deliveryCorrelationId,
  extractDeliveryPayload,
} from './lib/deliveryCompat';

import { missionMonitorFeature } from './MissionMonitorFeature';
import { registerFeature } from '../featureRegistry';
registerFeature(missionMonitorFeature);
