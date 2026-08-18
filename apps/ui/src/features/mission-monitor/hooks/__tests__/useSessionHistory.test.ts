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

  it('#2750 NFR-1: persisted sessions sharing a sessionId collapse to ONE row — the drawer list React key (session.sessionId) stays unique', async () => {
    // The drawer maps rows with `key={session.sessionId}`; the hook must
    // dedupe by sessionId (REQ-1 — dual-transport persisted rows) so no two
    // rows share a React key. Duplicate sessionId → exactly one session.
    mockLoadPersistedSessions.mockResolvedValue([
      persistedSession({ sessionId: 'same-id', label: 'First copy', deliveryCount: 1 }),
      persistedSession({ sessionId: 'same-id', label: 'Second copy', deliveryCount: 2 }),
      persistedSession({ sessionId: 'other-id', label: 'Other', deliveryCount: 3 }),
    ]);

    const { result } = renderHook(() => useDeliverySessions());

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(2);
    });

    const ids = result.current.sessions.map((s) => s.sessionId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('same-id');
    expect(ids).toContain('other-id');
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

  // ── #2750 ST-3 (AC3): the filter matches the display Name (custom > derived
  //    > label) in addition to the sessionId; a single .filter pass keeps the
  //    exactly-once edge (AC3-2) automatic ───────────────────────────────────

  it('matches a session by its DERIVED display name (#2750 ST-3 / AC3)', async () => {
    mockLoadPersistedSessions.mockResolvedValue([
      persistedSession({
        sessionId: 'session-a',
        derivedName: 'Fix the auth bug',
      }),
    ]);

    const { result } = renderHook(() => useDeliverySessions());

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    act(() => {
      result.current.setSearchFilter('auth bug');
    });

    // sessionId 'session-a' does NOT contain 'auth bug' — the derived-name
    // match finds it.
    expect(result.current.filteredSessions).toHaveLength(1);
    expect(result.current.filteredSessions[0].sessionId).toBe('session-a');
  });

  it('matches a session by its CUSTOM display name (AC3)', async () => {
    mockLoadPersistedSessions.mockResolvedValue([
      persistedSession({
        sessionId: 'session-b',
        customName: 'My Renamed Session',
        derivedName: 'old derived name',
      }),
    ]);

    const { result } = renderHook(() => useDeliverySessions());

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    act(() => {
      result.current.setSearchFilter('renamed');
    });

    expect(result.current.filteredSessions).toHaveLength(1);
    expect(result.current.filteredSessions[0].sessionId).toBe('session-b');
  });

  it('matches a session by its fallback label when no name exists (AC3)', async () => {
    mockLoadPersistedSessions.mockResolvedValue([
      persistedSession({ sessionId: 'session-c', label: 'No Chat Label' }),
    ]);

    const { result } = renderHook(() => useDeliverySessions());

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    act(() => {
      result.current.setSearchFilter('chat label');
    });

    expect(result.current.filteredSessions).toHaveLength(1);
    expect(result.current.filteredSessions[0].sessionId).toBe('session-c');
  });

  it('returns each matching session EXACTLY once when a query matches one session\'s Name and another\'s sessionId (AC3-2)', async () => {
    mockLoadPersistedSessions.mockResolvedValue([
      // Session 'sess-1' matches by NAME ('shared-topic').
      persistedSession({ sessionId: 'sess-1', derivedName: 'shared-topic discussion' }),
      // Session 'shared-topic-2' matches by SESSIONID.
      persistedSession({ sessionId: 'shared-topic-2', derivedName: 'other thing' }),
      // Session 'unrelated' matches neither.
      persistedSession({ sessionId: 'unrelated', derivedName: 'something else' }),
    ]);

    const { result } = renderHook(() => useDeliverySessions());

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(3);
    });

    act(() => {
      result.current.setSearchFilter('shared-topic');
    });

    // Exactly two sessions — each matched once, no duplicates.
    expect(result.current.filteredSessions).toHaveLength(2);
    const ids = result.current.filteredSessions.map((s) => s.sessionId).sort();
    expect(ids).toEqual(['sess-1', 'shared-topic-2']);
  });

  // ── #2750 AC3 round-2: filter-vs-render string identity + real-world edges ──
  // The filter predicate must match EXACTLY the string the session row renders
  // (drawer renders `deriveDisplayName(session)` = customName ?? derivedName ??
  // label; the hook stores derivedName in its DISPLAY form — formatDerivedName
  // truncates to 40 chars incl. `…` — so BOTH the row and the filter see the
  // same truncated string; there is no full-name-vs-truncated-name mismatch).

  it('matches a session whose DERIVED name comes from a live first user message containing the query (real-world AC3 case)', async () => {
    // Live-derived name path (#2748 ST-3): the session's name is captured from
    // the EARLIEST non-empty userMessage delivery — here a first message that
    // contains the model name the user would search for.
    mockLoadPersistedSessions.mockResolvedValue([
      persistedSession({ sessionId: 'ses-deepseek-run' }),
    ]);
    mockUseStream.mockReturnValue({
      deliveries: [
        chatDelivery('d1', 'ses-deepseek-run', '2026-08-17T10:00:00.000Z',
          'investigate the deepseek-v4-flash latency regression'),
      ],
      isConnected: true,
    });

    const { result } = renderHook(() => useDeliverySessions());

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    // The row would render this display name (derivedName, display form).
    const session = result.current.sessions[0];
    expect(session.derivedName).toBe('investigate the deepseek-v4-flash laten…');
    expect(deriveDisplayName(session)).toBe('investigate the deepseek-v4-flash laten…');

    // Typing the model name finds the session by its NAME (sessionId does not
    // contain 'deepseek').
    act(() => {
      result.current.setSearchFilter('deepseek');
    });
    expect(result.current.filteredSessions).toHaveLength(1);
    expect(result.current.filteredSessions[0].sessionId).toBe('ses-deepseek-run');
  });

  it('>40-char derived name: the filter queries the TRUNCATED display form — text within the visible cut matches, text only beyond it does not (documented)', async () => {
    mockLoadPersistedSessions.mockResolvedValue([
      persistedSession({ sessionId: 's-long', label: 'Fallback' }),
    ]);
    // 60-char first user message — the display name is truncated at 40 incl. `…`.
    const longMessage = 'first message that is intentionally very long so the derived name gets truncated beyond the 40 character display budget';
    mockUseStream.mockReturnValue({
      deliveries: [
        chatDelivery('d1', 's-long', '2026-08-17T10:00:00.000Z', longMessage),
      ],
      isConnected: true,
    });

    const { result } = renderHook(() => useDeliverySessions());

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    const session = result.current.sessions[0];
    // Display form is the 40-char truncated name (incl. `…`) — what the row
    // renders.
    expect(session.derivedName).toHaveLength(40);
    expect(session.derivedName!.endsWith('…')).toBe(true);
    expect(deriveDisplayName(session)).toBe(session.derivedName);

    // (1) A query matching the VISIBLE truncated text finds the session —
    // typing what the user sees on the row works.
    act(() => {
      result.current.setSearchFilter('first message that is inten');
    });
    expect(result.current.filteredSessions).toHaveLength(1);

    // (2) A query whose text exists only BEYOND the 40-char cut (visible as
    // `…` on the row) matches nothing — the row cannot display it either, so
    // search cannot find it (documented truncation behavior; not a defect).
    act(() => {
      result.current.setSearchFilter('display budget');
    });
    expect(result.current.filteredSessions).toHaveLength(0);
  });

  it('custom names are NOT truncated — the filter matches the full custom name the row renders (AC3 round-2)', async () => {
    // #2748 rename: custom names are authoritative and stored untruncated
    // (rename input maxLength 120) — the row renders the full string (CSS
    // ellipsis clips only visually) and the filter must query the same full
    // string.
    mockLoadPersistedSessions.mockResolvedValue([
      persistedSession({
        sessionId: 's-custom',
        customName: 'a deliberately very long custom session name over forty characters for the deepseek project',
        derivedName: 'short derived',
      }),
    ]);

    const { result } = renderHook(() => useDeliverySessions());

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    const session = result.current.sessions[0];
    expect(deriveDisplayName(session)).toBe(session.customName);

    // Query a fragment deep in the long custom name — matches (full string is
    // queried, byte-identical to the rendered row text).
    act(() => {
      result.current.setSearchFilter('forty characters');
    });
    expect(result.current.filteredSessions).toHaveLength(1);
    expect(result.current.filteredSessions[0].sessionId).toBe('s-custom');
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
