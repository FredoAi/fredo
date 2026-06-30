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

// Track module-level markSessionDeleted calls
const mockMarkSessionDeleted = vi.fn<(id: string) => void>();
const mockIsSessionDeleted = vi.fn<(id: string) => boolean>();

// Mock persistence module before importing the hook
const mockLoadPersistedSessions = vi.fn<() => Promise<MissionMonitorSession[]>>();
const mockDeleteSessionFromStore = vi.fn<() => Promise<void>>();

vi.mock('../../lib/persistence', () => ({
  loadPersistedSessions: () => mockLoadPersistedSessions(),
  deleteSessionFromStore: (id: string) => mockDeleteSessionFromStore(id),
  markSessionDeleted: (id: string) => mockMarkSessionDeleted(id),
  isSessionDeleted: (id: string) => mockIsSessionDeleted(id),
  initMmTables: vi.fn(),
  persistDelivery: vi.fn(),
  loadPersistedDeliveries: vi.fn(),
}));

// Controllable mock for StreamContext — allows per-test delivery customization
const mockUseStream = vi.hoisted(() => vi.fn().mockReturnValue({
  deliveries: [],
  isConnected: false,
}));

vi.mock('../../../../shared/contexts/StreamContext', () => ({
  useStream: mockUseStream,
}));

import { useDeliverySessions } from '../useSessionHistory';

describe('useDeliverySessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore default StreamContext mock (empty deliveries)
    mockUseStream.mockReturnValue({
      deliveries: [],
      isConnected: false,
    });
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
    // Should call markSessionDeleted for cross-mount tracking
    expect(mockMarkSessionDeleted).toHaveBeenCalledWith('session-a');
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

  it('should prevent deleted session with live deliveries from reappearing (REQ-3)', async () => {
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

    // Simulate live deliveries still in StreamContext for session-a
    const liveDelivery: ContractDelivery = {
      id: 'delivery-1',
      contractName: 'chat-node',
      lifecycle: 'update',
      key: { sessionId: 'session-a' },
      payload: {},
      timestamp: new Date(2500).toISOString(),
    };

    mockUseStream.mockReturnValue({
      deliveries: [liveDelivery],
      isConnected: true,
    });

    const { result } = renderHook(() => useDeliverySessions());

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    // Delete the session
    await act(async () => {
      await result.current.deleteSession('session-a');
    });

    // Session must NOT reappear despite live deliveries still in StreamContext
    expect(result.current.sessions).toHaveLength(0);
  });

  it('should prevent resurrection even with new live deliveries arriving after delete (REQ-3)', async () => {
    const persisted: MissionMonitorSession[] = [
      {
        sessionId: 'session-b',
        label: 'Session B',
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

    // Delete the session
    await act(async () => {
      await result.current.deleteSession('session-b');
    });

    expect(result.current.sessions).toHaveLength(0);

    // Simulate new live deliveries arriving after deletion
    const newDelivery: ContractDelivery = {
      id: 'delivery-new',
      contractName: 'chat-node',
      lifecycle: 'init',
      key: { sessionId: 'session-b' },
      payload: {},
      timestamp: new Date(3000).toISOString(),
    };

    mockUseStream.mockReturnValue({
      deliveries: [newDelivery],
      isConnected: true,
    });

    // Re-render to pick up the new deliveries — session must stay gone
    await act(async () => {
      // Trigger a re-render by changing deliveries (useMemo dependency)
      // The deliveries array reference changes via the mock, so the useMemo
      // will recompute. We just need to wait for the next render.
    });

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(0);
    });
  });

  it('should filter deleted sessions using module-level isSessionDeleted (cross-mount persistence)', async () => {
    // Simulate a session that was deleted in a previous mount lifecycle
    // by making isSessionDeleted return true for session-a
    mockIsSessionDeleted.mockImplementation((id: string) => id === 'session-a');

    const persisted: MissionMonitorSession[] = [
      {
        sessionId: 'session-a',
        label: 'Session A',
        startTime: 1000,
        latestTimestamp: new Date(2000).toISOString(),
        deliveryCount: 2,
      },
      {
        sessionId: 'session-b',
        label: 'Session B',
        startTime: 2000,
        latestTimestamp: new Date(3000).toISOString(),
        deliveryCount: 1,
      },
    ];

    mockLoadPersistedSessions.mockResolvedValue(persisted);

    const { result } = renderHook(() => useDeliverySessions());

    // Session-a should be filtered out via module-level isSessionDeleted
    // even though it was loaded from SQLite (simulates cross-mount scenario)
    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    expect(result.current.sessions[0].sessionId).toBe('session-b');
    // Verify isSessionDeleted was called for session-a
    expect(mockIsSessionDeleted).toHaveBeenCalledWith('session-a');
  });
});
