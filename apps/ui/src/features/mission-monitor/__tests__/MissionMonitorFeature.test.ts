/**
 * MissionMonitorFeature.test.ts — the P4.2 typed-rows migration contract.
 *
 * Spec #2788 P4.2/P5.1: Mission Monitor's v1 ECE contracts were removed and
 * the whole v1 contract surface was deleted — the feature derives its graph
 * from typed RTDB rows via `useEventRows('Chat' | 'ToolUse', { replay: true })`
 * (MissionMonitorPanel → useDeliveryGraph → lib/rowDerivation.ts).
 */
import { describe, it, expect } from 'vitest';
import { missionMonitorFeature } from '../MissionMonitorFeature';

describe('MissionMonitorFeature — P4.2/P5.1 row migration', () => {
  it('keeps the feature identity intact (id/name/showable)', () => {
    expect(missionMonitorFeature.id).toBe('mission-monitor');
    expect(missionMonitorFeature.name).toBe('Mission Monitor');
    expect(missionMonitorFeature.showable).toBe(true);
  });
});
