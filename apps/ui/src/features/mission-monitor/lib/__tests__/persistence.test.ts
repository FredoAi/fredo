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
