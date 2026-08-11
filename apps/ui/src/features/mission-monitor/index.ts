export { MissionMonitorFeature, missionMonitorFeature } from './MissionMonitorFeature';

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
} from './lib/graph';
export {
  EMPTY_STATE_JOKES,
  isChatNodeDelivery,
  deliverySessionId,
  deliveryCorrelationId,
  extractDeliveryPayload,
  formatTokenCount,
} from './lib/graph';

import { missionMonitorFeature } from './MissionMonitorFeature';
import { registerFeature } from '../featureRegistry';
registerFeature(missionMonitorFeature);
