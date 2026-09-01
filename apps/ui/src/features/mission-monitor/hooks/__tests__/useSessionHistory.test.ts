/**
 * Tests for useDeliverySessions — replay-driven session derivation (P4.3).
 *
 * Mocks the useEventRows row subscription (Chat rows via rowsFromDeliveries —
 * the classifier semantics) and the FeatureStore IPC calls for
 * loadPersistedSessions / deleteSessionFromStore.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ChatRow, ContractDelivery } from '../../../../shared/classes/EventSubscription';
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
  // Spec #2788 P4.3: tombstone seeding is awaited inside the mount load
  seedDeletedSessionIdsIntoModule: vi.fn().mockResolvedValue(undefined),
}));

// Spec #2788 P4.3: the hook reads the replayed Chat rows via useEventRows —
// mock it per test with rows converted from the v1 chat-node delivery
// fixtures (rowsFromDeliveries applies the classifier semantics).
const mockUseEventRows = vi.hoisted(() => vi.fn());

vi.mock('../../../../shared/hooks/useEventRows', () => ({
  useEventRows: mockUseEventRows,
}));

import { useDeliverySessions } from '../useSessionHistory';
import { rowsFromDeliveries } from './fixtures/rowsFromDeliveries';

/**
 * Seed the useEventRows mock with Chat rows converted from v1 chat-node
 * delivery fixtures (the classifier semantics). Deliveries without a
 * correlationId get their id — one row per fixture delivery. `epoch` must
 * BUMP across rerenders that add rows (the hook's effects memoize on it).
 */
function setChatRows(deliveries: ContractDelivery[], epoch = 1): void {
  const normalized = deliveries.map((d) => ({
    ...d,
    key: { sessionId: d.key.sessionId, correlationId: d.key.correlationId ?? d.id },
  }));
  const { chatRows } = rowsFromDeliveries(normalized);
  mockUseEventRows.mockReturnValue({
    rows: new Map(chatRows.map((r) => [`${r.sessionId}\u0000${r.correlationId}`, r] as const)),
    epoch,
    error: null,
    ready: true,
  });
}

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
    // Restore default row-store mock (empty Chat partition, ready)
    setChatRows([], 1);
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
    setChatRows([
      chatDelivery('d1', 'ses-deepseek-run', '2026-08-17T10:00:00.000Z',
        'investigate the deepseek-v4-flash latency regression'),
    ]);

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
    setChatRows([
      chatDelivery('d1', 's-long', '2026-08-17T10:00:00.000Z', longMessage),
    ]);

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

    // Simulate replayed/live rows still in the row store for session-a
    const liveDelivery: ContractDelivery = {
      id: 'delivery-1',
      contractName: 'chat-node',
      lifecycle: 'update',
      key: { sessionId: 'session-a' },
      payload: {},
      timestamp: new Date(2500).toISOString(),
    };

    setChatRows([liveDelivery]);

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

    // Simulate new rows arriving after deletion
    const newDelivery: ContractDelivery = {
      id: 'delivery-new',
      contractName: 'chat-node',
      lifecycle: 'init',
      key: { sessionId: 'session-b' },
      payload: {},
      timestamp: new Date(3000).toISOString(),
    };

    setChatRows([newDelivery], 2);

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

    // Row order is row-key insertion order (replay seq order) — the
    // earlier-timestamp message arrives as a LATER row, so selection must
    // compare timestamps, not insertion order.
    setChatRows([
      chatDelivery('d1', 'session-a', '2026-01-01T10:02:00.000Z', 'second message, later'),
      chatDelivery('d2', 'session-a', '2026-01-01T10:00:00.000Z', 'first message, earliest'),
    ]);

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

    setChatRows([
      chatDelivery('d1', 'session-live', '2026-01-01T10:00:00.000Z', 'hello from a live session'),
    ]);

    const { result } = renderHook(() => useDeliverySessions());

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    const session = result.current.sessions[0];
    expect(session.sessionId).toBe('session-live');
    expect(session.derivedName).toBe('hello from a live session');
  });

  // ── Spec #2788 P4.3 — replay replaces the v1 TTL-shrink vanish class ────────
  // Root cause of the v1 bug ("some sessions stop showing, and if I reopen
  // mission monitor they show again"): a live-only session was visible only
  // through StreamContext `deliveries`, which TTL-shrink after 300s. The row
  // store has NO TTL eviction and NO cap — replay restores the full row
  // history on remount — so the vanish class is structurally gone. This test
  // pins: a row-only session survives a snapshot refresh, and the row count
  // is authoritative over a concurrently-refreshed persisted snapshot.
  it('a row-only session survives refreshSessions — the row store never TTL-evicts (replay replaces hydration)', async () => {
    // The FeatureStore snapshot is empty at mount; the session is row-only.
    mockLoadPersistedSessions.mockResolvedValue([]);

    setChatRows([
      chatDelivery('d1', 'session-live', '2026-01-01T10:00:00.000Z', 'first live message'),
    ]);

    const { result } = renderHook(() => useDeliverySessions());

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    // The snapshot refresh lands a persisted row for the session (name prefs /
    // retention fallback) — it must not change the row-authoritative count.
    mockLoadPersistedSessions.mockResolvedValue([
      persistedSession({
        sessionId: 'session-live',
        label: 'Label session-live',
        deliveryCount: 3,
        startTime: 1000,
        latestTimestamp: new Date(2000).toISOString(),
      }),
    ]);

    await act(async () => {
      await result.current.refreshSessions();
    });

    // Still exactly one session — row count authoritative (1 row, not
    // 3-persisted + 1-row), name still row-derived (snapshot has none).
    expect(result.current.sessions).toHaveLength(1);
    expect(result.current.sessions[0].sessionId).toBe('session-live');
    expect(result.current.sessions[0].deliveryCount).toBe(1);
    expect(result.current.sessions[0].derivedName).toBe('first live message');
  });

  it('a persisted session with NO rows (RTDB retention evicted) keeps its persisted snapshot values', async () => {
    // The session's rows are gone from the row store (retention eviction,
    // R-2d) — the persisted snapshot is the only source and its values pass
    // through unchanged (the v1 fallback path).
    mockLoadPersistedSessions.mockResolvedValue([
      persistedSession({
        sessionId: 'session-evicted',
        label: 'Old Session',
        deliveryCount: 7,
        startTime: 1000,
        latestTimestamp: new Date(2000).toISOString(),
      }),
    ]);
    setChatRows([], 1);

    const { result } = renderHook(() => useDeliverySessions());

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });
    expect(result.current.sessions[0].deliveryCount).toBe(7);
    expect(result.current.sessions[0].startTime).toBe(1000);
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

    setChatRows([
      chatDelivery('d1', 'session-a', '2026-01-01T10:00:00.000Z', 'first live message'),
    ]);

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
    // No rows at all — no chat row to derive from.
    setChatRows([], 1);

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

    setChatRows([
      chatDelivery('d1', 'session-a', '2026-01-01T10:00:00.000Z', '   '),
      chatDelivery('d2', 'session-a', '2026-01-01T10:01:00.000Z', ''),
      chatDelivery('d3', 'session-a', '2026-01-01T10:02:00.000Z'), // userMessage absent
    ]);

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

    setChatRows([
      chatDelivery('d1', 'session-live', '2026-01-01T10:00:00.000Z', 'derived from live'),
    ]);

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

  // ── #2758 round-22 C1 — selection FOLLOWS the newly started live session ────
  // Previously selection was claimed exactly once ("only-if-null"): a panel
  // mounted alongside an older session never retargeted a NEWLY STARTED live
  // session, whose graph nodes were then suppressed by the Phase-3 emission
  // filter (useMissionMonitor.ts visibleAgentCorrs) — empty canvas despite
  // provable deliveries.

  it('(a) follows a NEWLY STARTED live session while an older one is auto-selected (#2758 C1)', async () => {
    mockLoadPersistedSessions.mockResolvedValue([
      persistedSession({ sessionId: 'session-old', startTime: 1000 }),
    ]);

    // Mount with an EMPTY stream: the persisted session is auto-selected.
    const { result, rerender } = renderHook(() => useDeliverySessions());

    await waitFor(() => {
      expect(result.current.selectedSessionId).toBe('session-old');
    });
    // Selection was programmatic (auto-select), NOT a user pick — following
    // must stay armed.
    expect(result.current.userPickedRef.current).toBe(false);

    // A NEW live session starts delivering mid-lifetime (epoch bump — the
    // hook's follow effect keys on the row-store epoch).
    setChatRows([
      chatDelivery('d1', 'ses-live-new', '2026-01-02T10:00:00.000Z', 'hello from the child run'),
    ], 2);
    rerender();

    // Selection RETARGETS to the newly started session.
    await waitFor(() => {
      expect(result.current.selectedSessionId).toBe('ses-live-new');
    });
    // And following remains armed (no userPicked flip).
    expect(result.current.userPickedRef.current).toBe(false);
  });

  it('(b) does NOT steal focus after an explicit user pick (#2758 C1)', async () => {
    mockLoadPersistedSessions.mockResolvedValue([
      persistedSession({ sessionId: 'session-a', startTime: 1000 }),
      persistedSession({ sessionId: 'session-b', startTime: 2000 }),
    ]);

    const { result, rerender } = renderHook(() => useDeliverySessions());

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(2);
    });
    // Auto-select picks the newest.
    expect(result.current.selectedSessionId).toBe('session-b');

    // EXPLICIT pick of another row.
    act(() => {
      result.current.selectSession('session-a');
    });
    expect(result.current.selectedSessionId).toBe('session-a');
    expect(result.current.userPickedRef.current).toBe(true);

    // A new live session starts delivering — focus must NOT be stolen
    // (epoch bump).
    setChatRows([
      chatDelivery('d1', 'ses-live-new', '2026-01-02T10:00:00.000Z', 'should not steal focus'),
    ], 2);
    rerender();

    await waitFor(() => {
      expect(result.current.sessions.some((s) => s.sessionId === 'ses-live-new')).toBe(true);
    });
    expect(result.current.selectedSessionId).toBe('session-a');
  });

  it('(c) deleted-selected-session reset semantics are unchanged — selection clears and following re-arms (#2758 C1)', async () => {
    mockLoadPersistedSessions.mockResolvedValue([
      persistedSession({ sessionId: 'session-old', startTime: 1000 }),
    ]);

    const { result } = renderHook(() => useDeliverySessions());

    await waitFor(() => {
      expect(result.current.selectedSessionId).toBe('session-old');
    });

    await act(async () => {
      await result.current.deleteSession('session-old');
    });

    // REQ-7 / REQ-8 unchanged: selection cleared…
    expect(result.current.sessions).toHaveLength(0);
    expect(result.current.selectedSessionId).toBeNull();
    // …and userPickedRef reset to false so auto-select/following re-arm
    // (the useSessionHistory.ts:186-191 vanish-reset contract).
    expect(result.current.userPickedRef.current).toBe(false);
  });
});

// ── Spec #2788 (P4.3): replay replaces the mount-time hydration ──────────────
describe('Spec #2788 (P4.3): replay replaces mount-time hydration', () => {
  /** Seed the row-store mock with a custom result (rows, readiness, error). */
  function mockRowStore(chatRows: ChatRow[], opts?: { ready?: boolean; error?: string | null; epoch?: number }) {
    mockUseEventRows.mockReturnValue({
      rows: new Map(chatRows.map((r) => [`${r.sessionId}\u0000${r.correlationId}`, r] as const)),
      epoch: opts?.epoch ?? 1,
      error: opts?.error ?? null,
      ready: opts?.ready ?? true,
    });
  }

  function chatRow(sessionId: string, correlationId: string, updatedAt: string, userMessage: string | null): ChatRow {
    return {
      sessionId,
      correlationId,
      seq: 1,
      startedAtNs: null,
      endedAtNs: null,
      updatedAt,
      state: 'Response',
      userMessage,
      agentReply: null,
      promptTokens: null,
      completionTokens: null,
      cacheReadTokens: null,
      costUsd: null,
      model: null,
      parentSessionId: null,
      compositedChildSessionId: null,
      rawJson: '{}',
    };
  }

  it('replayed snapshot rows are visible the moment `loaded` flips — no separate hydration fetch, no false-empty flash', async () => {
    // The replay subscription delivered its snapshot (ready) — the backend-only
    // session is already visible the moment the list unlocks.
    mockRowStore([chatRow('ses-replayed', 'r1', '2026-01-01T09:00:00.000Z', 'replayed prompt')]);
    mockLoadPersistedSessions.mockResolvedValue([]);

    const { result } = renderHook(() => useDeliverySessions());

    // `loaded` flips only AFTER both async sources settle — the replayed
    // session is already in the first unlocked list (no blank flash).
    await waitFor(() => {
      expect(result.current.sessions.some((s) => s.sessionId === 'ses-replayed')).toBe(true);
    });
  });

  it('replayed rows do NOT double-count a persisted session — the row count REPLACES the snapshot count', async () => {
    // The session sits in the persisted snapshot with deliveryCount 3 — a
    // stale v1 figure. The replayed row store holds the session's TWO rows
    // (full history, no TTL, no cap): the row count is authoritative and the
    // snapshot count is never added on top (no 5, no 3 — exactly 2).
    mockLoadPersistedSessions.mockResolvedValue([
      persistedSession({ sessionId: 'ses-persisted', deliveryCount: 3 }),
    ]);
    mockRowStore([
      chatRow('ses-persisted', 'p1', '2026-01-01T09:00:00.000Z', 'first'),
      chatRow('ses-persisted', 'p2', '2026-01-01T09:01:00.000Z', 'second'),
    ]);

    const { result } = renderHook(() => useDeliverySessions());

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });
    expect(result.current.sessions[0].deliveryCount).toBe(2);
  });

  it('replayed rows surface a backend-only session through the row-only path', async () => {
    // No persisted snapshot at all — the session streamed entirely while the
    // panel was closed; its replayed rows are the only source.
    mockLoadPersistedSessions.mockResolvedValue([]);
    mockRowStore([
      chatRow('ses-backend-only', 'b1', '2026-01-01T09:00:00.000Z', 'late prompt'),
      chatRow('ses-backend-only', 'b2', '2026-01-01T09:01:00.000Z', 'second turn'),
    ]);

    const { result } = renderHook(() => useDeliverySessions());

    await waitFor(() => {
      expect(result.current.sessions.some((s) => s.sessionId === 'ses-backend-only')).toBe(true);
    });
    const session = result.current.sessions.find((s) => s.sessionId === 'ses-backend-only');
    expect(session?.deliveryCount).toBe(2);
    // Derived name from the replayed row's userMessage (earliest non-empty).
    expect(session?.derivedName).toBe('late prompt');
  });

  it('subscribe failure degrades gracefully — loaded still flips, persisted data only, no crash', async () => {
    mockRowStore([], { ready: false, error: 'subscribe_events failed for query "chat { ... }"' });
    mockLoadPersistedSessions.mockResolvedValue([
      persistedSession({ sessionId: 'session-a' }),
    ]);

    const { result } = renderHook(() => useDeliverySessions());

    // The persisted snapshot still loads; the loud error (R-3a, surfaced by
    // useEventRows) must never wedge the `loaded` gate.
    await waitFor(() => {
      expect(result.current.sessions.some((s) => s.sessionId === 'session-a')).toBe(true);
    });
    expect(result.current.sessions).toHaveLength(1);
  });

  it('a cold/empty row store is a no-op — zero rows, normal empty state', async () => {
    mockRowStore([]);
    mockLoadPersistedSessions.mockResolvedValue([]);

    const { result } = renderHook(() => useDeliverySessions());

    await waitFor(() => {
      expect(result.current.sessions).toEqual([]);
    });
    expect(result.current.selectedSessionId).toBeNull();
  });
});
