/**
 * MissionMonitorFeature.test.ts — the P4.2 typed-rows migration contract.
 *
 * Spec #2788 P4.2: Mission Monitor's three persistent v1 ECE contracts
 * (chat-node, tool-use-lifecycle, subagent-tool-activity) are REMOVED — the
 * feature derives its graph from typed RTDB rows via
 * `useEventRows('Chat' | 'ToolUse', { replay: true })` (MissionMonitorPanel →
 * useDeliveryGraph → lib/rowDerivation.ts). These tests lock the removal —
 * no dead contracts means no v1 deliveries are double-delivered into the
 * row-driven graph.
 *
 * (The pre-P4.2 shape tests — eventTypes/transports/streamFields/
 * completeWhen/excludePayload declarations — were deleted with the
 * declarations themselves.)
 */
import { describe, it, expect, vi } from 'vitest';
import { missionMonitorFeature } from '../MissionMonitorFeature';

describe('MissionMonitorFeature — P4.2 contract removal', () => {
  it('declares NO v1 ECE contracts (the feature is fully on typed rows)', () => {
    expect(missionMonitorFeature.eventContracts).toEqual([]);
  });

  it('no longer carries the removed persistent contract names', () => {
    const names = missionMonitorFeature.eventContracts.map((c) => c.contractName);
    expect(names).not.toContain('chat-node');
    expect(names).not.toContain('tool-use-lifecycle');
    expect(names).not.toContain('subagent-tool-activity');
  });

  it('does not override handleDelivery (no v1 deliveries can reach the feature)', () => {
    // The base-class handleDelivery is a no-op — with no contracts registered,
    // nothing routes to the feature class anyway. Lock that the override is
    // gone by verifying a delivery through it never opens the feature.
    const openSpy = vi.spyOn(
      missionMonitorFeature as unknown as { openSelf: () => void },
      'openSelf',
    );
    missionMonitorFeature.handleDelivery({
      id: 'd1',
      contractName: 'chat-node',
      lifecycle: 'init',
      key: { sessionId: 's1', correlationId: 'c1' },
      payload: {},
      timestamp: new Date().toISOString(),
    } as Parameters<typeof missionMonitorFeature.handleDelivery>[0]);
    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it('keeps the feature identity intact (id/name/showable)', () => {
    expect(missionMonitorFeature.id).toBe('mission-monitor');
    expect(missionMonitorFeature.name).toBe('Mission Monitor');
    expect(missionMonitorFeature.showable).toBe(true);
  });
});
