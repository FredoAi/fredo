/**
 * Tests for persistence.ts — Mission Monitor SQLite persistence layer.
 *
 * Mocks the FeatureStore IPC client to verify:
 * - initMmTables creates both sessions and events tables
 * - loadPersistedSessions returns typed MissionMonitorSession[]
 * - deleteSessionFromStore removes session and events
 * - markSessionDeleted / isSessionDeleted track deletion cross-mount
 * - persistDelivery skips deliveries for module-level deleted sessions (REQ-3)
 * - persistDelivery uses atomic UPDATE instead of delete+insert
 * - persistDelivery creates initial session row on first delivery
 * - persistDelivery skips delivery insert when UPDATE returns 0 (race condition)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ContractDelivery } from '../../../../shared/classes/EventSubscription';

// Mock FeatureStore IPC functions
const mockEnsureTable = vi.fn();
const mockInsert = vi.fn();
const mockQuery = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();

vi.mock('../../../../shared/lib/featureStore', () => ({
  featureStoreEnsureTable: (...args: unknown[]) => mockEnsureTable(...args),
  featureStoreInsert: (...args: unknown[]) => mockInsert(...args),
  featureStoreQuery: (...args: unknown[]) => mockQuery(...args),
  featureStoreUpdate: (...args: unknown[]) => mockUpdate(...args),
  featureStoreDelete: (...args: unknown[]) => mockDelete(...args),
}));

import {
  initMmTables,
  loadPersistedSessions,
  deleteSessionFromStore,
  persistDelivery,
  markSessionDeleted,
  isSessionDeleted,
  createDeliveryWatermark,
  nextUnseenDeliveries,
  type DeliveryWatermarkState,
} from '../persistence';

describe('persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── initMmTables ──────────────────────────────────────────────────────────

  it('initMmTables ensures both sessions and events tables', async () => {
    mockEnsureTable.mockResolvedValue(undefined);

    await initMmTables();

    // Should have been called for sessions and events tables
    expect(mockEnsureTable).toHaveBeenCalledTimes(2);

    const sessionsCall = mockEnsureTable.mock.calls.find(
      (c: unknown[]) => (c[0] as Record<string, unknown>)?.tableName === 'sessions'
    );
    const eventsCall = mockEnsureTable.mock.calls.find(
      (c: unknown[]) => (c[0] as Record<string, unknown>)?.tableName === 'events'
    );

    expect(sessionsCall).toBeDefined();
    expect(eventsCall).toBeDefined();

    // Verify sessions columns
    const sessionsArgs = sessionsCall[0] as Record<string, unknown>;
    expect(sessionsArgs.featureId).toBe('mission-monitor');
    expect(sessionsArgs.columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'session_id', colType: 'TEXT', primaryKey: true }),
        expect.objectContaining({ name: 'label', colType: 'TEXT' }),
        expect.objectContaining({ name: 'delivery_count', colType: 'INTEGER' }),
      ])
    );
  });

  // ── loadPersistedSessions ─────────────────────────────────────────────────

  it('loadPersistedSessions returns typed sessions', async () => {
    mockQuery.mockResolvedValue([
      {
        session_id: 'sess-1',
        label: 'Test Session',
        start_time: '2024-01-01T00:00:00.000Z',
        end_time: null,
        delivery_count: 42,
      },
    ]);

    const sessions = await loadPersistedSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe('sess-1');
    expect(sessions[0].label).toBe('Test Session');
    expect(sessions[0].deliveryCount).toBe(42);
    expect(sessions[0].startTime).toBeGreaterThan(0);
  });

  it('loadPersistedSessions returns empty array when no sessions', async () => {
    mockQuery.mockResolvedValue([]);

    const sessions = await loadPersistedSessions();
    expect(sessions).toEqual([]);
  });

  it('loadPersistedSessions queries with correct orderBy', async () => {
    mockQuery.mockResolvedValue([]);

    await loadPersistedSessions();

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        featureId: 'mission-monitor',
        tableName: 'sessions',
        orderBy: 'start_time DESC',
      })
    );
  });

  // ── deleteSessionFromStore ────────────────────────────────────────────────

  it('deleteSessionFromStore removes events and session', async () => {
    mockDelete.mockResolvedValue(1);

    await deleteSessionFromStore('sess-to-delete');

    // Events deleted first, then session
    expect(mockDelete).toHaveBeenCalledWith(
      expect.objectContaining({
        featureId: 'mission-monitor',
        tableName: 'events',
        whereCols: { session_id: 'sess-to-delete' },
      })
    );
    expect(mockDelete).toHaveBeenCalledWith(
      expect.objectContaining({
        featureId: 'mission-monitor',
        tableName: 'sessions',
        whereCols: { session_id: 'sess-to-delete' },
      })
    );
  });

  it('deleteSessionFromStore marks session as deleted (module-level tracking)', async () => {
    mockDelete.mockResolvedValue(1);

    await deleteSessionFromStore('mark-sess-test');

    // After delete, session should be marked in module-level set
    expect(isSessionDeleted('mark-sess-test')).toBe(true);
  });

  // ── markSessionDeleted / isSessionDeleted ─────────────────────────────────

  it('markSessionDeleted marks a session as deleted', () => {
    // Fresh module-level state (Set is scoped to module, carry-over across tests)
    // We just verify the function works correctly
    markSessionDeleted('test-sess-1');
    expect(isSessionDeleted('test-sess-1')).toBe(true);
  });

  it('isSessionDeleted returns false for unmarked sessions', () => {
    expect(isSessionDeleted('unknown-session')).toBe(false);
  });

  // ── persistDelivery ───────────────────────────────────────────────────────

  it('persistDelivery skips deliveries for module-level deleted sessions (REQ-3)', async () => {
    // Mark session as deleted via module-level set
    markSessionDeleted('del-session-mod');

    const delivery = makeDelivery('del-1', 'init', 'del-session-mod', 'corr-1');

    await persistDelivery(delivery);

    // Should not query or insert anything since isSessionDeleted returns true
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('persistDelivery uses atomic UPDATE for existing sessions (no delete+insert)', async () => {
    // Session exists in SQLite
    mockQuery
      .mockResolvedValueOnce([{ session_id: 'sess-1', label: 'Existing', start_time: '2024-01-01T00:00:00.000Z', delivery_count: 5 }])
      .mockResolvedValue([]); // subsequent cap queries return empty

    mockUpdate.mockResolvedValue(1); // UPDATE succeeded
    mockInsert.mockResolvedValue(1);

    const delivery = makeDelivery('del-new-1', 'init', 'sess-1', 'corr-1');

    await persistDelivery(delivery);

    // Should NOT have deleted the old session row (no delete+insert)
    const sessionDeleteCalls = mockDelete.mock.calls.filter(
      (c: unknown[]) => (c[0] as Record<string, unknown>)?.tableName === 'sessions'
    );
    expect(sessionDeleteCalls.length).toBe(0);

    // Should have used atomic UPDATE to increment delivery_count
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        featureId: 'mission-monitor',
        tableName: 'sessions',
        setCols: expect.objectContaining({
          delivery_count: 6, // 5 + 1
        }),
        whereCols: { session_id: 'sess-1' },
      })
    );

    // Should have inserted the delivery
    const eventInsertCalls = mockInsert.mock.calls.filter(
      (c: unknown[]) => (c[0] as Record<string, unknown>)?.tableName === 'events'
    );
    expect(eventInsertCalls.length).toBeGreaterThanOrEqual(1);
    const eventArgs = eventInsertCalls[0][0] as { rows: Record<string, unknown>[] };
    expect(eventArgs.rows[0].delivery_id).toBe('del-new-1');
    expect(eventArgs.rows[0].session_id).toBe('sess-1');
  });

  it('persistDelivery creates initial session row on first delivery', async () => {
    // Session does NOT exist in SQLite (first delivery)
    mockQuery
      .mockResolvedValueOnce([]) // no existing session
      .mockResolvedValue([]); // subsequent cap queries return empty

    mockInsert.mockResolvedValue(1);

    const delivery = makeDelivery('del-first', 'init', 'new-session', 'corr-1');

    await persistDelivery(delivery);

    // Should have inserted a new session row
    const sessionInsertCalls = mockInsert.mock.calls.filter(
      (c: unknown[]) => (c[0] as Record<string, unknown>)?.tableName === 'sessions'
    );
    expect(sessionInsertCalls.length).toBeGreaterThanOrEqual(1);
    const sessionArgs = sessionInsertCalls[0][0] as { rows: Record<string, unknown>[] };
    expect(sessionArgs.rows[0].session_id).toBe('new-session');
    expect(sessionArgs.rows[0].delivery_count).toBe(1); // initial count
    expect(sessionArgs.rows[0].start_time).toBeDefined();
    expect(sessionArgs.rows[0].end_time).toBeNull();

    // Should have inserted the delivery
    const eventInsertCalls = mockInsert.mock.calls.filter(
      (c: unknown[]) => (c[0] as Record<string, unknown>)?.tableName === 'events'
    );
    expect(eventInsertCalls.length).toBeGreaterThanOrEqual(1);
    const eventArgs = eventInsertCalls[0][0] as { rows: Record<string, unknown>[] };
    expect(eventArgs.rows[0].delivery_id).toBe('del-first');

    // Should NOT have called delete on sessions table (no delete+insert)
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('persistDelivery skips delivery insert when UPDATE returns 0 (race condition)', async () => {
    // Session existed at query time
    mockQuery
      .mockResolvedValueOnce([{ session_id: 'sess-race', label: 'Race', start_time: '2024-01-01T00:00:00.000Z', delivery_count: 3 }]);

    // But UPDATE returns 0 — session was deleted between query and update
    mockUpdate.mockResolvedValue(0);

    const delivery = makeDelivery('del-race', 'init', 'sess-race', 'corr-1');

    await persistDelivery(delivery);

    // Should have called UPDATE but it returned 0
    expect(mockUpdate).toHaveBeenCalled();

    // Should NOT have inserted any delivery (race condition — session was deleted)
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('persistDelivery ignores delivery without sessionId', async () => {
    const delivery = makeDelivery('del-no-sess', 'init', '', 'corr-1');

    await persistDelivery(delivery);

    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });
});

// ── ST11: shrink-safe incremental delivery watermark ────────────────────────

describe('nextUnseenDeliveries (ST11 shrink-safe watermark)', () => {
  let state: DeliveryWatermarkState;

  beforeEach(() => {
    state = createDeliveryWatermark();
  });

  it('no silent gap: shrink below the cursor then re-grow emits every unseen delivery', () => {
    // (a) feed N deliveries.
    const first = nextUnseenDeliveries([makeDelivery('d1', 'init', 's1', 'c1'), makeDelivery('d2', 'init', 's1', 'c2'), makeDelivery('d3', 'init', 's1', 'c3')], state);
    expect(first.map((d) => d.id)).toEqual(['d1', 'd2', 'd3']);

    // (b) TTL shrink — oldest M=2 evicted from the front. All survivors were
    // already emitted, so nothing is re-emitted (idempotent re-scan).
    const afterShrink = nextUnseenDeliveries([makeDelivery('d3', 'init', 's1', 'c3')], state);
    expect(afterShrink).toEqual([]);

    // (c) feed N+M=5 more (array re-grows past the old cursor of 3).
    const regrown = nextUnseenDeliveries([
      makeDelivery('d3', 'init', 's1', 'c3'),
      makeDelivery('d4', 'init', 's1', 'c4'),
      makeDelivery('d5', 'init', 's1', 'c5'),
      makeDelivery('d6', 'init', 's1', 'c6'),
      makeDelivery('d7', 'init', 's1', 'c7'),
      makeDelivery('d8', 'init', 's1', 'c8'),
    ], state);
    // (d) all 5 newly-fed deliveries (d4..d8) reached the consumer exactly once —
    // no silent gap, no double-emit.
    expect(regrown.map((d) => d.id)).toEqual(['d4', 'd5', 'd6', 'd7', 'd8']);

    // The full set d1..d8 was emitted exactly once across all calls.
    const allEmitted = [...first, ...afterShrink, ...regrown];
    expect(allEmitted).toHaveLength(8);
    expect(new Set(allEmitted.map((d) => d.id)).size).toBe(8);
  });

  it('shrink-reset re-scan never re-emits already-emitted deliveries (no delivery_count inflation)', () => {
    // After a shrink below the cursor, the whole remaining array is re-scanned
    // from the front. Survivors must NOT be re-emitted — persistDelivery
    // increments sessions.delivery_count per call, so re-emitting would inflate it.
    nextUnseenDeliveries([makeDelivery('d1', 'init', 's1', 'c1'), makeDelivery('d2', 'init', 's1', 'c2')], state);

    // Shrink: both survive but were already emitted.
    const rescan = nextUnseenDeliveries([makeDelivery('d1', 'init', 's1', 'c1'), makeDelivery('d2', 'init', 's1', 'c2')], state);
    expect(rescan).toEqual([]);

    // A genuinely new arrival after the shrink is still picked up.
    const next = nextUnseenDeliveries([makeDelivery('d1', 'init', 's1', 'c1'), makeDelivery('d2', 'init', 's1', 'c2'), makeDelivery('d3', 'init', 's1', 'c3')], state);
    expect(next.map((d) => d.id)).toEqual(['d3']);
  });

  it('array re-grows past the old cursor after a shrink without stale-index skip', () => {
    // N=4 initial; shrink removes the 3 oldest; growth happens in two batches
    // whose intermediate length is still BELOW the old cursor (4).
    nextUnseenDeliveries([makeDelivery('d1', 'init', 's1', 'c1'), makeDelivery('d2', 'init', 's1', 'c2'), makeDelivery('d3', 'init', 's1', 'c3'), makeDelivery('d4', 'init', 's1', 'c4')], state);

    // Shrink to [d4] (old cursor 4 > 1 → reset).
    expect(nextUnseenDeliveries([makeDelivery('d4', 'init', 's1', 'c4')], state)).toEqual([]);

    // Growth batch 1: len 3 still below the OLD cursor of 4 — d5, d6 must not be skipped.
    const batch1 = nextUnseenDeliveries([makeDelivery('d4', 'init', 's1', 'c4'), makeDelivery('d5', 'init', 's1', 'c5'), makeDelivery('d6', 'init', 's1', 'c6')], state);
    expect(batch1.map((d) => d.id)).toEqual(['d5', 'd6']);

    // Growth batch 2: len 5 now exceeds the old cursor — d7, d8 emitted too.
    const batch2 = nextUnseenDeliveries([makeDelivery('d4', 'init', 's1', 'c4'), makeDelivery('d5', 'init', 's1', 'c5'), makeDelivery('d6', 'init', 's1', 'c6'), makeDelivery('d7', 'init', 's1', 'c7'), makeDelivery('d8', 'init', 's1', 'c8')], state);
    expect(batch2.map((d) => d.id)).toEqual(['d7', 'd8']);

    expect(new Set(['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8'])).toEqual(
      new Set(['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8']),
    );
  });

  it('duplicate delivery ids are not double-emitted', () => {
    const first = nextUnseenDeliveries([makeDelivery('dup-1', 'init', 's1', 'c1')], state);
    expect(first).toHaveLength(1);

    // Same id appears again (re-emitted by the bus / post-shrink re-scan).
    const again = nextUnseenDeliveries([makeDelivery('dup-1', 'update', 's1', 'c1')], state);
    expect(again).toEqual([]);
  });

  it('empty or unchanged arrays produce no emissions', () => {
    expect(nextUnseenDeliveries([], state)).toEqual([]);
    nextUnseenDeliveries([makeDelivery('d1', 'init', 's1', 'c1')], state);
    expect(nextUnseenDeliveries([makeDelivery('d1', 'init', 's1', 'c1')], state)).toEqual([]);
  });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeDelivery(
  id: string,
  lifecycle: 'init' | 'update' | 'end',
  sessionId: string,
  correlationId: string,
): ContractDelivery {
  return {
    id,
    contractName: 'chat-node',
    lifecycle,
    key: { sessionId, correlationId },
    payload: { payload: {} },
    timestamp: new Date().toISOString(),
  };
}
