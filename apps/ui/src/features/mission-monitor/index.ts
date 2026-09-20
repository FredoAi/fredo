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
import { registerFeatureData } from '../../shared/feature-data/registry';
import { MISSION_MONITOR_DATA } from './lib/dataDeclaration';
registerFeature(missionMonitorFeature);

// Spec #2896 ST-6: Mission Monitor declares its feature-owned `sessions` table.
// `Home.tsx` issues ONE idempotent `feature_data_declare` at app start after the
// feature modules have registered (A-17), so the declared table is materialized
// before the feature can open. Idempotent under HMR (keyed by featureId).
registerFeatureData(MISSION_MONITOR_DATA);

export { MISSION_MONITOR_DATA } from './lib/dataDeclaration';
