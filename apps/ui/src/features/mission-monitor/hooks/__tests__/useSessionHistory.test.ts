/**
 * Tests for useDeliverySessions — SQLite-driven session derivation.
 *
 * Mocks FeatureStore IPC calls for loadPersistedSessions and deleteSessionFromStore.
 * No deliveries param — hook loads sessions from SQLite on mount.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ContractDelivery } from '../../../../shared/classes/EventSubscription';
import type { MissionMonitorSession } from '../../lib/graph';
import { deriveDisplayName } from '../../lib/sessionMeta';

// Track module-level markSessionDeleted calls
const mockMarkSessionDeleted = vi.fn<(id: string) => void>();
const mockIsSessionDeleted = vi.fn<(id: string) => boolean>();

// Mock persistence module before importing the hook
const mockLoadPersistedSessions = vi.fn<() => Promise<MissionMonitorSession[]>>();
const mockDeleteSessionFromStore = vi.fn<() => Promise<void>>();
const mockSaveCustomName = vi.fn<(id: string, name: string) => Promise<void>>();

vi.mock('../../lib/persistence', () => ({
  loadPersistedSessions: () => mockLoadPersistedSessions(),
  deleteSessionFromStore: (id: string) => mockDeleteSessionFromStore(id),
  markSessionDeleted: (id: string) => mockMarkSessionDeleted(id),
  isSessionDeleted: (id: string) => mockIsSessionDeleted(id),
  saveCustomName: (id: string, name: string) => mockSaveCustomName(id, name),
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

/**
 * #2748 ST-3 — a chat-node delivery carrying the adapter-injected
 * `userMessage` (2-level ECE payload nesting, matching extractDeliveryPayload).
 */
function chatDelivery(
  id: string,
  sessionId: string,
  timestamp: string,
  userMessage?: string,
): ContractDelivery {
  return {
    id,
    contractName: 'chat-node',
    lifecycle: 'init',
    key: { sessionId },
    payload: {
      payload: {
        ...(userMessage !== undefined ? { userMessage } : {}),
        agentReply: 'reply',
      },
    },
    timestamp,
  };
}

function persistedSession(overrides: Partial<MissionMonitorSession> & { sessionId: string }): MissionMonitorSession {
  return {
    label: `Label ${overrides.sessionId}`,
    startTime: 1000,
    latestTimestamp: new Date(2000).toISOString(),
    deliveryCount: 1,
    ...overrides,
  };
}

describe('useDeliverySessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks resets call history only — implementations survive. Reset
    // the isSessionDeleted implementation so the "module-level isSessionDeleted"
    // test's implementation does not leak into subsequent tests (it would
    // silently filter out any session named 'session-a').
    mockIsSessionDeleted.mockImplementation(() => false);
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

    // Auto-select picks the newest session when none is selected
    expect(result.current.selectedSessionId).toBe('session-a');

    // Deselect (simulates pane click) — userPickedRef=true prevents re-auto-select
    act(() => {
      result.current.selectSession(null);
    });

    expect(result.current.selectedSessionId).toBeNull();

    // Re-select (user manually selects again)
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

  // ── #2748 ST-3 — derived names, custom names, rename ────────────────────────

  it('derives the session name from the EARLIEST live userMessage (AC1 R-1.1)', async () => {
    mockLoadPersistedSessions.mockResolvedValue([
      persistedSession({ sessionId: 'session-a' }),
    ]);

    // Array order is append order — the earlier-timestamp message arrives
    // second, so selection must compare timestamps, not array position.
    mockUseStream.mockReturnValue({
      deliveries: [
        chatDelivery('d1', 'session-a', '2026-01-01T10:02:00.000Z', 'second message, later'),
        chatDelivery('d2', 'session-a', '2026-01-01T10:00:00.000Z', 'first message, earliest'),
      ],
      isConnected: true,
    });

    const { result } = renderHook(() => useDeliverySessions());

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    const session = result.current.sessions[0];
    expect(session.derivedName).toBe('first message, earliest');
    // Display precedence falls through to the derived name (no custom name).
    expect(deriveDisplayName(session)).toBe('first message, earliest');
  });

  it('derives the name of a live-only (not-yet-persisted) session (AC1)', async () => {
    mockLoadPersistedSessions.mockResolvedValue([]);

    mockUseStream.mockReturnValue({
      deliveries: [
        chatDelivery('d1', 'session-live', '2026-01-01T10:00:00.000Z', 'hello from a live session'),
      ],
      isConnected: true,
    });

    const { result } = renderHook(() => useDeliverySessions());

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    const session = result.current.sessions[0];
    expect(session.sessionId).toBe('session-live');
    expect(session.derivedName).toBe('hello from a live session');
  });

  it('normalizes the persisted derived name and lets the custom name override it (AC2 R-2.3)', async () => {
    mockLoadPersistedSessions.mockResolvedValue([
      persistedSession({
        sessionId: 'session-a',
        derivedName: '  raw   first\nmessage  ',
        customName: 'My Custom Name',
      }),
    ]);

    const { result } = renderHook(() => useDeliverySessions());

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    const session = result.current.sessions[0];
    // Persisted ST-2 value is the raw first message — the hook normalizes it
    // to the display form (display-side truncation is the hook's job).
    expect(session.derivedName).toBe('raw first message');
    expect(session.customName).toBe('My Custom Name');
    // Custom name is authoritative over the derived name (deriveDisplayName).
    expect(deriveDisplayName(session)).toBe('My Custom Name');
  });

  it('derives from live deliveries when the persisted derived name is absent (gap fill)', async () => {
    mockLoadPersistedSessions.mockResolvedValue([
      persistedSession({ sessionId: 'session-a' }),
    ]);

    mockUseStream.mockReturnValue({
      deliveries: [
        chatDelivery('d1', 'session-a', '2026-01-01T10:00:00.000Z', 'first live message'),
      ],
      isConnected: true,
    });

    const { result } = renderHook(() => useDeliverySessions());

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    const session = result.current.sessions[0];
    expect(session.derivedName).toBe('first live message');
    expect(deriveDisplayName(session)).toBe('first live message');
  });

  it('falls back to the label when the session has no chat message (AC1 R-1.2)', async () => {
    mockLoadPersistedSessions.mockResolvedValue([
      persistedSession({ sessionId: 'session-a', label: 'No Chat Label' }),
    ]);
    // No live deliveries at all — no chat-node delivery to derive from.
    mockUseStream.mockReturnValue({ deliveries: [], isConnected: false });

    const { result } = renderHook(() => useDeliverySessions());

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    const session = result.current.sessions[0];
    expect(session.derivedName).toBeUndefined();
    expect(session.customName).toBeUndefined();
    expect(deriveDisplayName(session)).toBe('No Chat Label');
  });

  it('falls back to the label when every chat delivery has an empty userMessage (AC1 R-1.2)', async () => {
    mockLoadPersistedSessions.mockResolvedValue([
      persistedSession({ sessionId: 'session-a', label: 'Empty Msg Label' }),
    ]);

    mockUseStream.mockReturnValue({
      deliveries: [
        chatDelivery('d1', 'session-a', '2026-01-01T10:00:00.000Z', '   '),
        chatDelivery('d2', 'session-a', '2026-01-01T10:01:00.000Z', ''),
        chatDelivery('d3', 'session-a', '2026-01-01T10:02:00.000Z'), // userMessage absent
      ],
      isConnected: true,
    });

    const { result } = renderHook(() => useDeliverySessions());

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    const session = result.current.sessions[0];
    expect(session.derivedName).toBeUndefined();
    expect(deriveDisplayName(session)).toBe('Empty Msg Label');
  });

  it('renameSession persists via saveCustomName and updates the list immediately (AC2 R-2.4)', async () => {
    mockSaveCustomName.mockResolvedValue(undefined);
    mockLoadPersistedSessions.mockResolvedValue([
      persistedSession({ sessionId: 'session-a', label: 'Old Label' }),
    ]);

    const { result } = renderHook(() => useDeliverySessions());

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    await act(async () => {
      await result.current.renameSession('session-a', 'Renamed!');
    });

    expect(mockSaveCustomName).toHaveBeenCalledWith('session-a', 'Renamed!');
    const session = result.current.sessions.find((s) => s.sessionId === 'session-a');
    expect(session!.customName).toBe('Renamed!');
    // Drawer re-renders immediately — display name is the new custom name,
    // not the derived name or the label.
    expect(deriveDisplayName(session!)).toBe('Renamed!');
  });

  it('renameSession clears the custom name on an empty/whitespace save (AC2)', async () => {
    mockSaveCustomName.mockResolvedValue(undefined);
    mockLoadPersistedSessions.mockResolvedValue([
      persistedSession({
        sessionId: 'session-a',
        label: 'Fallback Label',
        derivedName: 'Derived Name',
        customName: 'Old Custom',
      }),
    ]);

    const { result } = renderHook(() => useDeliverySessions());

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    await act(async () => {
      await result.current.renameSession('session-a', '   ');
    });

    const session = result.current.sessions.find((s) => s.sessionId === 'session-a');
    expect(mockSaveCustomName).toHaveBeenCalledWith('session-a', '   ');
    expect(session!.customName).toBeUndefined();
    // Falls back to the derived name (still present), not the label.
    expect(deriveDisplayName(session!)).toBe('Derived Name');
  });

  it('renameSession updates a live-only session immediately (upserts into the snapshot)', async () => {
    mockSaveCustomName.mockResolvedValue(undefined);
    mockLoadPersistedSessions.mockResolvedValue([]);

    mockUseStream.mockReturnValue({
      deliveries: [
        chatDelivery('d1', 'session-live', '2026-01-01T10:00:00.000Z', 'derived from live'),
      ],
      isConnected: true,
    });

    const { result } = renderHook(() => useDeliverySessions());

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    await act(async () => {
      await result.current.renameSession('session-live', 'Renamed Live');
    });

    expect(mockSaveCustomName).toHaveBeenCalledWith('session-live', 'Renamed Live');
    const session = result.current.sessions.find((s) => s.sessionId === 'session-live');
    expect(session).toBeDefined();
    expect(session!.customName).toBe('Renamed Live');
    expect(deriveDisplayName(session!)).toBe('Renamed Live');
  });
});
