/**
 * Tests for persistence.ts — Mission Monitor SQLite persistence layer.
 *
 * Mocks the FeatureStore IPC client to verify:
 * - initMmTables creates both sessions and events tables
 * - loadPersistedSessions returns typed MissionMonitorSession[]
 * - deleteSessionFromStore removes session and events
 * - persistDelivery ignores deleted session deliveries (REQ-11)
 * - Session upsert increments delivery_count
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ContractDelivery } from '../../../../shared/classes/EventSubscription';

// Mock FeatureStore IPC functions
const mockEnsureTable = vi.fn();
const mockInsert = vi.fn();
const mockQuery = vi.fn();
const mockDelete = vi.fn();

vi.mock('../../../../shared/lib/featureStore', () => ({
  featureStoreEnsureTable: (...args: unknown[]) => mockEnsureTable(...args),
  featureStoreInsert: (...args: unknown[]) => mockInsert(...args),
  featureStoreQuery: (...args: unknown[]) => mockQuery(...args),
  featureStoreDelete: (...args: unknown[]) => mockDelete(...args),
}));

import {
  initMmTables,
  loadPersistedSessions,
  deleteSessionFromStore,
  persistDelivery,
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

  // ── persistDelivery ───────────────────────────────────────────────────────

  it('persistDelivery ignores deliveries for deleted sessions (REQ-11)', async () => {
    mockQuery.mockResolvedValue([]); // Session not found → deleted

    const delivery = makeDelivery('del-1', 'init', 'deleted-session', 'corr-1');

    await persistDelivery(delivery);

    // Should not have attempted to insert anything
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('persistDelivery upserts session and inserts delivery', async () => {
    // Session exists in SQLite
    mockQuery
      .mockResolvedValueOnce([{ session_id: 'sess-1', label: 'Existing', start_time: '2024-01-01T00:00:00.000Z', delivery_count: 5 }])
      .mockResolvedValue([]); // subsequent cap queries return empty

    mockDelete.mockResolvedValue(1);
    mockInsert.mockResolvedValue(1);

    const delivery = makeDelivery('del-new-1', 'init', 'sess-1', 'corr-1');

    await persistDelivery(delivery);

    // Should have deleted old session row (simple upsert)
    expect(mockDelete).toHaveBeenCalledWith(
      expect.objectContaining({
        tableName: 'sessions',
        whereCols: { session_id: 'sess-1' },
      })
    );

    // Should have inserted updated session with incremented count
    const insertCalls = mockInsert.mock.calls.filter(
      (c: unknown[]) => (c[0] as Record<string, unknown>)?.tableName === 'sessions'
    );
    expect(insertCalls.length).toBeGreaterThanOrEqual(1);
    const sessionArgs = insertCalls[0][0] as { rows: Record<string, unknown>[] };
    expect(sessionArgs.rows[0].delivery_count).toBe(6); // 5 + 1

    // Should have inserted the delivery
    const eventInsertCalls = mockInsert.mock.calls.filter(
      (c: unknown[]) => (c[0] as Record<string, unknown>)?.tableName === 'events'
    );
    expect(eventInsertCalls.length).toBeGreaterThanOrEqual(1);
    const eventArgs = eventInsertCalls[0][0] as { rows: Record<string, unknown>[] };
    expect(eventArgs.rows[0].delivery_id).toBe('del-new-1');
    expect(eventArgs.rows[0].session_id).toBe('sess-1');
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
