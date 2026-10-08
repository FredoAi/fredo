/**
 * useSessionActivityWatch pins — Spec #2896 ST-9 (R-5.1 / R-5.2 / R-5.3).
 *
 * The continuous per-session watch lifecycle, proved through the hook's real
 * output (not a spy on internals):
 *  - R-5.1: with `sessionId === null` NO per-session watch is registered at
 *    all and nothing per-session is delivered (the shared canonical partitions
 *    may still mutate — the hook's view stays empty and its epoch stays put).
 *  - R-5.2: A → B unsubscribes A, opens B, and a LATE A delivery never appears
 *    in the returned rows nor advances the session epoch.
 *  - R-5.3: only rows whose session key equals the selected session surface.
 *  - same id ⇒ no re-subscribe; unmount ⇒ unsubscribe.
 *
 * The feature-data IPC client is partially mocked; the REAL ST-5 store applies
 * delivered notifications, so the test exercises the production merge/version
 * path end to end.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type {
  FeatureDataWatchArgs,
  FeatureDataUnwatchArgs,
} from '@/shared/feature-data/client';
import type { FeatureRowNotification } from '@/shared/classes/EventSubscription';
import {
  applyFeatureDeliveries,
  resetFeatureDataStoreForTests,
} from '@/shared/feature-data/store';

const mocks = vi.hoisted(() => ({
  featureDataWatch: vi.fn(),
  featureDataUnwatch: vi.fn(),
}));

vi.mock('@/shared/feature-data/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/feature-data/client')>();
  return {
    ...actual,
    featureDataWatch: mocks.featureDataWatch,
    featureDataUnwatch: mocks.featureDataUnwatch,
  };
});

import {
  resetSessionActivityWatchForTests,
  useSessionActivityWatch,
} from '../useSessionActivityWatch';

let watchSeq = 0;

beforeEach(() => {
  resetFeatureDataStoreForTests();
  resetSessionActivityWatchForTests();
  mocks.featureDataWatch.mockReset();
  mocks.featureDataUnwatch.mockReset();
  watchSeq = 0;
  mocks.featureDataWatch.mockImplementation(async (args: FeatureDataWatchArgs) => {
    watchSeq += 1;
    return {
      watchId: `w-${args.ref.table}-${watchSeq}`,
      version: 1,
      rows: [],
    };
  });
  mocks.featureDataUnwatch.mockImplementation(async (args: FeatureDataUnwatchArgs) => ({
    watchIds: args.watchIds,
  }));
});

/** A canonical chat/toolUse notification — `featureId: null` routes to the canonical partition. */
function canonicalNotification(
  sessionId: string,
  correlationId: string,
  watchId: string,
  version: number,
  extra: Record<string, unknown> = {},
): FeatureRowNotification {
  return {
    watchId,
    featureId: null,
    table: 'chat',
    kind: 'insert',
    // Canonical record key is `[correlationId, sessionId]` (ST-4 `canonical_key_of`).
    key: [correlationId, sessionId],
    changedFields: ['agentReply'],
    values: {
      correlationId,
      sessionId,
      agentReply: `reply for ${sessionId}`,
      _rowVersion: 1,
      ...extra,
    },
    version,
    timestamp: '2026-09-18T00:00:00.000+00:00',
  };
}

function renderSessionWatch(initial: string | null) {
  return renderHook(
    ({ sid }: { sid: string | null }) => useSessionActivityWatch(sid),
    { initialProps: { sid: initial } },
  );
}

describe('useSessionActivityWatch', () => {
  it('registers no per-session watch while sessionId is null (R-5.1)', async () => {
    const { result, rerender } = renderSessionWatch(null);

    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.featureDataWatch).not.toHaveBeenCalled();
    expect(result.current.chatRows.size).toBe(0);
    expect(result.current.toolUseRows.size).toBe(0);
    expect(result.current.ready).toBe(false);

    // A canonical delivery while nothing is selected must not surface (R-5.1):
    // the view stays empty and the session epoch does not move.
    act(() => {
      applyFeatureDeliveries([canonicalNotification('A', 'corr-a', 'backend-watch-a', 10)]);
    });
    expect(result.current.chatRows.size).toBe(0);
    expect(result.current.epoch).toBe(0);

    // Selecting a session opens exactly the chat + toolUse watches.
    rerender({ sid: 'A' });
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(mocks.featureDataWatch).toHaveBeenCalledTimes(2);

    // Deselecting closes both and opens nothing new.
    rerender({ sid: null });
    expect(mocks.featureDataUnwatch).toHaveBeenCalledWith({ watchIds: ['w-chat-1'] });
    expect(mocks.featureDataUnwatch).toHaveBeenCalledWith({ watchIds: ['w-toolUse-2'] });
    expect(mocks.featureDataWatch).toHaveBeenCalledTimes(2);
    expect(result.current.chatRows.size).toBe(0);
    expect(result.current.ready).toBe(false);
  });

  it('closes A before opening B and never surfaces a late A delivery (R-5.2)', async () => {
    const { result, rerender } = renderSessionWatch('A');
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(mocks.featureDataWatch).toHaveBeenCalledTimes(2);

    rerender({ sid: 'B' });
    await waitFor(() => expect(result.current.ready).toBe(true));

    // A's watches were unsubscribed and B's were opened.
    expect(mocks.featureDataUnwatch).toHaveBeenCalledWith({ watchIds: ['w-chat-1'] });
    expect(mocks.featureDataUnwatch).toHaveBeenCalledWith({ watchIds: ['w-toolUse-2'] });
    expect(mocks.featureDataWatch).toHaveBeenCalledTimes(4);

    // A late A delivery (an in-flight backend flush after the switch) must not
    // appear in B's view nor advance the session epoch.
    const epochAfterSwitch = result.current.epoch;
    act(() => {
      applyFeatureDeliveries([canonicalNotification('A', 'corr-a', 'w-chat-1', 20)]);
    });
    expect([...result.current.chatRows.values()].some((r) => r.sessionId === 'A')).toBe(false);
    expect(result.current.epoch).toBe(epochAfterSwitch);

    // B's deliveries flow.
    act(() => {
      applyFeatureDeliveries([canonicalNotification('B', 'corr-b', 'w-chat-3', 21)]);
    });
    expect([...result.current.chatRows.values()].some((r) => r.sessionId === 'B')).toBe(true);
    expect(result.current.epoch).toBeGreaterThan(epochAfterSwitch);
  });

  it('exposes only rows whose composited session key is the selected session (R-5.3)', async () => {
    const { result, rerender } = renderSessionWatch('A');
    await waitFor(() => expect(result.current.ready).toBe(true));

    act(() => {
      applyFeatureDeliveries([
        canonicalNotification('A', 'corr-a', 'w-chat-1', 30),
        canonicalNotification('B', 'corr-b', 'w-chat-3', 31),
      ]);
    });
    const selected = [...result.current.chatRows.values()];
    expect(selected).toHaveLength(1);
    expect(selected[0].sessionId).toBe('A');

    // The swap shows exactly B and nothing of A.
    rerender({ sid: 'B' });
    await waitFor(() => expect(result.current.ready).toBe(true));
    const afterSwap = [...result.current.chatRows.values()];
    expect(afterSwap).toHaveLength(1);
    expect(afterSwap[0].sessionId).toBe('B');
  });

  it('does not re-subscribe when the same session id is re-rendered (no watch churn)', async () => {
    const { result, rerender } = renderSessionWatch('A');
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(mocks.featureDataWatch).toHaveBeenCalledTimes(2);

    rerender({ sid: 'A' });
    rerender({ sid: 'A' });
    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.featureDataWatch).toHaveBeenCalledTimes(2);
    expect(mocks.featureDataUnwatch).not.toHaveBeenCalled();
  });

  it('unsubscribes the session watches on unmount', async () => {
    const { result, unmount } = renderSessionWatch('A');
    await waitFor(() => expect(result.current.ready).toBe(true));

    unmount();

    expect(mocks.featureDataUnwatch).toHaveBeenCalledWith({ watchIds: ['w-chat-1'] });
    expect(mocks.featureDataUnwatch).toHaveBeenCalledWith({ watchIds: ['w-toolUse-2'] });
  });
});
