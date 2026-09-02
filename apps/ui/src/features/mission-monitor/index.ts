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

import { missionMonitorFeature } from './MissionMonitorFeature';
import { registerFeature } from '../featureRegistry';
registerFeature(missionMonitorFeature);
