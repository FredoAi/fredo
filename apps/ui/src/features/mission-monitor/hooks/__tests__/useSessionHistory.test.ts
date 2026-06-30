/**
 * Tests for useDeliverySessions — SQLite-driven session derivation.
 *
 * Mocks FeatureStore IPC calls for loadPersistedSessions and deleteSessionFromStore.
 * No deliveries param — hook loads sessions from SQLite on mount.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ContractDelivery } from '../../../../shared/classes/EventSubscription';
import type { MissionMonitorSession } from '../../lib/contract';

// Mock persistence module before importing the hook
const mockLoadPersistedSessions = vi.fn<() => Promise<MissionMonitorSession[]>>();
const mockDeleteSessionFromStore = vi.fn<() => Promise<void>>();

vi.mock('../../lib/persistence', () => ({
  loadPersistedSessions: () => mockLoadPersistedSessions(),
  deleteSessionFromStore: (id: string) => mockDeleteSessionFromStore(id),
  initMmTables: vi.fn(),
  persistDelivery: vi.fn(),
  loadPersistedDeliveries: vi.fn(),
}));

// Mock StreamContext — make useStream controllable per-test
const mockUseStreamRef: { current: { deliveries: unknown[]; isConnected: boolean } } = {
  current: { deliveries: [], isConnected: false },
};

vi.mock('../../../../shared/contexts/StreamContext', () => ({
  useStream: () => mockUseStreamRef.current,
}));

import { useDeliverySessions } from '../useSessionHistory';

describe('useDeliverySessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseStreamRef.current = {
      deliveries: [],
      isConnected: false,
    };
  });

  it('should return empty sessions when no persisted data exists', async () => {
    mockLoadPersistedSessions.mockResolvedValue([]);

    const { result } = renderHook(() => useDeliverySessions());

    // Wait for the async load to complete
    await waitFor(() => {
      expect(result.current.sessions).toEqual([]);
    });

    expect(result.current.filteredSessions).toEqual([]);
    expect(result.current.selectedSessionId).toBeNull();
  });

  it('should load persisted sessions on mount', async () => {
    const persisted: MissionMonitorSession[] = [
      {
        sessionId: 'session-a',
        label: 'Test Session A',
        startTime: 1000,
        latestTimestamp: new Date(2000).toISOString(),
        deliveryCount: 5,
      },
      {
        sessionId: 'session-b',
        label: 'Test Session B',
        startTime: 500,
        latestTimestamp: new Date(1500).toISOString(),
        deliveryCount: 3,
      },
    ];

    mockLoadPersistedSessions.mockResolvedValue(persisted);

    const { result } = renderHook(() => useDeliverySessions());

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(2);
    });

    const sessionA = result.current.sessions.find((s) => s.sessionId === 'session-a');
    const sessionB = result.current.sessions.find((s) => s.sessionId === 'session-b');

    expect(sessionA).toBeDefined();
    expect(sessionA!.deliveryCount).toBe(5);
    expect(sessionB).toBeDefined();
    expect(sessionB!.deliveryCount).toBe(3);
  });

  it('should filter sessions by search filter', async () => {
    const persisted: MissionMonitorSession[] = [
      {
        sessionId: 'my-session',
        label: 'My Session',
        startTime: 1000,
        latestTimestamp: new Date(2000).toISOString(),
        deliveryCount: 2,
      },
      {
        sessionId: 'other-session',
        label: 'Other Session',
        startTime: 500,
        latestTimestamp: new Date(1500).toISOString(),
        deliveryCount: 1,
      },
    ];

    mockLoadPersistedSessions.mockResolvedValue(persisted);

    const { result } = renderHook(() => useDeliverySessions());

    await waitFor(() => {
      expect(result.current.filteredSessions).toHaveLength(2);
    });

    act(() => {
      result.current.setSearchFilter('my-');
    });

    expect(result.current.filteredSessions).toHaveLength(1);
    expect(result.current.filteredSessions[0].sessionId).toBe('my-session');
  });

  it('should support session selection', async () => {
    const persisted: MissionMonitorSession[] = [
      {
        sessionId: 'session-a',
        label: 'Session A',
        startTime: 1000,
        latestTimestamp: new Date(2000).toISOString(),
        deliveryCount: 1,
      },
    ];

    mockLoadPersistedSessions.mockResolvedValue(persisted);

    const { result } = renderHook(() => useDeliverySessions());

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    expect(result.current.selectedSessionId).toBeNull();

    act(() => {
      result.current.selectSession('session-a');
    });

    expect(result.current.selectedSessionId).toBe('session-a');
  });

  it('should delete session from SQLite and local state', async () => {
    const persisted: MissionMonitorSession[] = [
      {
        sessionId: 'session-a',
        label: 'Session A',
        startTime: 1000,
        latestTimestamp: new Date(2000).toISOString(),
        deliveryCount: 2,
      },
    ];

    mockLoadPersistedSessions.mockResolvedValue(persisted);

    const { result } = renderHook(() => useDeliverySessions());

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    act(() => {
      result.current.selectSession('session-a');
    });

    expect(result.current.selectedSessionId).toBe('session-a');

    await act(async () => {
      await result.current.deleteSession('session-a');
    });

    // Should be removed from state
    expect(result.current.sessions).toHaveLength(0);
    // Should call SQLite delete
    expect(mockDeleteSessionFromStore).toHaveBeenCalledWith('session-a');
    // Should deselect
    expect(result.current.selectedSessionId).toBeNull();
  });

  it('should clear graph when deleting selected session', async () => {
    const persisted: MissionMonitorSession[] = [
      {
        sessionId: 'session-a',
        label: 'Session A',
        startTime: 1000,
        latestTimestamp: new Date(2000).toISOString(),
        deliveryCount: 1,
      },
    ];

    mockLoadPersistedSessions.mockResolvedValue(persisted);

    const { result } = renderHook(() => useDeliverySessions());

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    act(() => {
      result.current.selectSession('session-a');
    });

    expect(result.current.selectedSessionId).toBe('session-a');

    await act(async () => {
      await result.current.deleteSession('session-a');
    });

    // Graph cleared: selectedSessionId is null (REQ-8)
    expect(result.current.selectedSessionId).toBeNull();
  });

  it('should return empty filtered sessions when no match', async () => {
    const persisted: MissionMonitorSession[] = [
      {
        sessionId: 'abc',
        label: 'ABC',
        startTime: 1000,
        latestTimestamp: new Date(2000).toISOString(),
        deliveryCount: 1,
      },
    ];

    mockLoadPersistedSessions.mockResolvedValue(persisted);

    const { result } = renderHook(() => useDeliverySessions());

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    act(() => {
      result.current.setSearchFilter('xyz');
    });

    expect(result.current.filteredSessions).toHaveLength(0);
  });

  it('should sort sessions newest-first', async () => {
    const oldTs = new Date('2024-01-01').toISOString();
    const newTs = new Date('2024-06-01').toISOString();

    const persisted: MissionMonitorSession[] = [
      {
        sessionId: 'old-session',
        label: 'Old Session',
        startTime: 1000,
        latestTimestamp: oldTs,
        deliveryCount: 1,
      },
      {
        sessionId: 'new-session',
        label: 'New Session',
        startTime: 2000,
        latestTimestamp: newTs,
        deliveryCount: 2,
      },
    ];

    mockLoadPersistedSessions.mockResolvedValue(persisted);

    const { result } = renderHook(() => useDeliverySessions());

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(2);
    });

    expect(result.current.sessions[0].sessionId).toBe('new-session');
    expect(result.current.sessions[1].sessionId).toBe('old-session');
  });

  // ── Resurrection Prevention Tests (REQ-4) ─────────────────────────────────

  it('should NOT resurrect a deleted session via live deliveries', async () => {
    const persisted: MissionMonitorSession[] = [
      {
        sessionId: 'session-deleteme',
        label: 'Delete Me',
        startTime: 1000,
        latestTimestamp: new Date(2000).toISOString(),
        deliveryCount: 5,
      },
    ];

    mockLoadPersistedSessions.mockResolvedValue(persisted);

    const { result } = renderHook(() => useDeliverySessions());

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    // Delete the session
    await act(async () => {
      await result.current.deleteSession('session-deleteme');
    });

    expect(result.current.sessions).toHaveLength(0);

    // Now simulate live deliveries arriving for the deleted session
    const liveDelivery = {
      id: 'live-1',
      contractName: 'chat-node',
      lifecycle: 'update' as const,
      key: { sessionId: 'session-deleteme', correlationId: 'corr-1' },
      payload: { state: 'running' },
      timestamp: new Date(3000).toISOString(),
    };

    mockUseStreamRef.current = {
      deliveries: [liveDelivery],
      isConnected: true,
    };

    // Re-render to trigger useMemo with new deliveries
    result.current.setSearchFilter(''); // no-op change to trigger re-render
    await vi.waitFor(() => {
      // The deleted session should NOT reappear
      expect(result.current.sessions).toHaveLength(0);
    });
  });

  it('should keep deleted session excluded when new deliveries arrive post-delete', async () => {
    const persisted: MissionMonitorSession[] = [
      {
        sessionId: 'session-a',
        label: 'Session A',
        startTime: 1000,
        latestTimestamp: new Date(2000).toISOString(),
        deliveryCount: 3,
      },
      {
        sessionId: 'session-b',
        label: 'Session B',
        startTime: 500,
        latestTimestamp: new Date(1500).toISOString(),
        deliveryCount: 1,
      },
    ];

    mockLoadPersistedSessions.mockResolvedValue(persisted);

    const { result } = renderHook(() => useDeliverySessions());

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(2);
    });

    // Delete session-a
    await act(async () => {
      await result.current.deleteSession('session-a');
    });

    expect(result.current.sessions).toHaveLength(1);
    expect(result.current.sessions[0].sessionId).toBe('session-b');

    // New deliveries arrive for the deleted session AND the alive session
    const deliveriesForDeleted = {
      id: 'live-deleted',
      contractName: 'chat-node',
      lifecycle: 'update' as const,
      key: { sessionId: 'session-a', correlationId: 'corr-2' },
      payload: { state: 'running' },
      timestamp: new Date(3000).toISOString(),
    };

    const deliveriesForAlive = {
      id: 'live-alive',
      contractName: 'chat-node',
      lifecycle: 'update' as const,
      key: { sessionId: 'session-b', correlationId: 'corr-3' },
      payload: { state: 'running' },
      timestamp: new Date(3500).toISOString(),
    };

    mockUseStreamRef.current = {
      deliveries: [deliveriesForDeleted, deliveriesForAlive],
      isConnected: true,
    };

    // Trigger re-render
    result.current.setSearchFilter('');
    await vi.waitFor(() => {
      // session-b should still be there, session-a should NOT have reappeared
      const ids = result.current.sessions.map((s: { sessionId: string }) => s.sessionId);
      expect(ids).not.toContain('session-a');
      expect(ids).toContain('session-b');
    });
  });

  it('should preserve existing behavior: persisted sessions load on restart', async () => {
    // This test verifies that on a fresh mount (no deletedIds), persisted sessions
    // still load as expected (existing behavior preserved)
    const persisted: MissionMonitorSession[] = [
      {
        sessionId: 'session-x',
        label: 'Session X',
        startTime: 1000,
        latestTimestamp: new Date(2000).toISOString(),
        deliveryCount: 2,
      },
    ];

    mockLoadPersistedSessions.mockResolvedValue(persisted);

    const { result } = renderHook(() => useDeliverySessions());

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    expect(result.current.sessions[0].sessionId).toBe('session-x');
    expect(result.current.sessions[0].deliveryCount).toBe(2);
  });
});
