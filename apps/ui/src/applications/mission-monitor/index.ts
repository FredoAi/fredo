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
import { registerApplication } from '../applicationRegistry';
import { registerApplicationData } from '../../shared/application-data/registry';
import { MISSION_MONITOR_DATA } from './lib/dataDeclaration';
registerApplication(missionMonitorFeature);

// Spec #2896 ST-6: Mission Monitor declares its application-owned `sessions` table.
// `Home.tsx` issues ONE idempotent `application_data_declare` at app start after the
// application modules have registered (A-17), so the declared table is materialized
// before the application can open. Idempotent under HMR (keyed by applicationId).
registerApplicationData(MISSION_MONITOR_DATA);

export { MISSION_MONITOR_DATA } from './lib/dataDeclaration';
