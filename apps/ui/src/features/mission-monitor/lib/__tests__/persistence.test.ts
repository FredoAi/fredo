/**
 * Tests for persistence.ts — Mission Monitor SQLite persistence layer.
 *
 * Spec #2788 P5.1: the v1 ContractDelivery persistence API (persistDelivery,
 * hydration loads, watermark, child-delivery loads) was deleted together with
 * the v1 pipeline — the sidebar derives from RTDB rows. What remains (and
 * what these tests verify) is the name/label snapshot, the deletion
 * tombstones, and the child-row cleanup:
 * - initMmTables creates the sessions, events, session_names, and
 *   deleted_sessions tables
 * - loadPersistedSessions returns typed MissionMonitorSession[] (names merged)
 * - #2748 FIX-1: loadPersistedSessions ensures the session_names table exists
 *   BEFORE querying it (mount-order regression)
 * - deleteSessionFromStore removes session, events, and session_names, marks
 *   the session deleted, records the restart-durable tombstone, and cleans up
 *   child event rows discovered from the persisted `childSessionId` links
 * - markSessionDeleted / isSessionDeleted track deletion cross-mount
 * - saveCustomName sets/clears the custom name via atomic UPDATE (#2748 ST-2)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  saveCustomName,
  markSessionDeleted,
  isSessionDeleted,
  recordSessionDeleted,
} from '../persistence';

describe('persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── initMmTables ──────────────────────────────────────────────────────────

  it('initMmTables ensures sessions, events, session_names, and deleted_sessions tables', async () => {
    mockEnsureTable.mockResolvedValue(undefined);

    await initMmTables();

    // Should have been called for all four tables
    expect(mockEnsureTable).toHaveBeenCalledTimes(4);

    const sessionsCall = mockEnsureTable.mock.calls.find(
      (c: unknown[]) => (c[0] as Record<string, unknown>)?.tableName === 'sessions'
    );
    const eventsCall = mockEnsureTable.mock.calls.find(
      (c: unknown[]) => (c[0] as Record<string, unknown>)?.tableName === 'events'
    );
    const namesCall = mockEnsureTable.mock.calls.find(
      (c: unknown[]) => (c[0] as Record<string, unknown>)?.tableName === 'session_names'
    );
    // Spec #2788 P4.3: durable deletion tombstones (RTDB replay must never
    // resurrect a deleted session after an app restart — REQ-3).
    const deletedCall = mockEnsureTable.mock.calls.find(
      (c: unknown[]) => (c[0] as Record<string, unknown>)?.tableName === 'deleted_sessions'
    );

    expect(sessionsCall).toBeDefined();
    expect(eventsCall).toBeDefined();
    expect(namesCall).toBeDefined();
    expect(deletedCall).toBeDefined();

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

    // #2748 ST-2: session_names table — session_id PK, nullable name columns
    const namesArgs = namesCall[0] as Record<string, unknown>;
    expect(namesArgs.featureId).toBe('mission-monitor');
    expect(namesArgs.columns).toEqual([
      expect.objectContaining({ name: 'session_id', colType: 'TEXT', primaryKey: true }),
      expect.objectContaining({ name: 'custom_name', colType: 'TEXT', nullable: true }),
      expect.objectContaining({ name: 'derived_name', colType: 'TEXT', nullable: true }),
    ]);
  });

  // ── #2748 FIX-1: init order (table exists before load query) ──────────────

  it('loadPersistedSessions ensures the session_names table exists BEFORE querying it (#2748 FIX-1)', async () => {
    // Fresh module instance so the memoized table-init guard is UNSET —
    // reproduces the round-1 cold-mount regression where the load query fired
    // before the CREATE TABLE landed (`no such table: feature_mission_monitor_session_names`).
    vi.resetModules();
    const fresh = await import('../persistence');

    mockEnsureTable.mockResolvedValue(undefined);
    mockQuery.mockResolvedValue([]);

    await fresh.loadPersistedSessions();

    // The session_names CREATE TABLE must precede the session_names SELECT.
    const ensureCallIdx = mockEnsureTable.mock.calls.findIndex(
      (c: unknown[]) => (c[0] as Record<string, unknown>)?.tableName === 'session_names'
    );
    const queryCallIdx = mockQuery.mock.calls.findIndex(
      (c: unknown[]) => (c[0] as Record<string, unknown>)?.tableName === 'session_names'
    );
    expect(ensureCallIdx).toBeGreaterThanOrEqual(0);
    expect(queryCallIdx).toBeGreaterThanOrEqual(0);

    const ensureOrder = mockEnsureTable.mock.invocationCallOrder[ensureCallIdx];
    const queryOrder = mockQuery.mock.invocationCallOrder[queryCallIdx];
    expect(ensureOrder).toBeLessThan(queryOrder);
  });

  it('loadPersistedSessions does not re-ensure tables on subsequent calls (memoized init)', async () => {
    mockEnsureTable.mockResolvedValue(undefined);
    mockQuery.mockResolvedValue([]);

    await loadPersistedSessions();
    await loadPersistedSessions();

    // First call triggers the ensure (4 tables); the memoized guard means the
    // second call must NOT re-run CREATE TABLE (idempotent, no redundant IPC).
    const ensureCount = mockEnsureTable.mock.calls.filter(
      (c: unknown[]) => (c[0] as Record<string, unknown>)?.tableName === 'session_names'
    ).length;
    expect(ensureCount).toBe(1);
  });

  // ── loadPersistedSessions ─────────────────────────────────────────────────

  it('loadPersistedSessions returns typed sessions', async () => {
    // Both the sessions and session_names queries resolve from the mock.
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

  it('loadPersistedSessions merges derivedName/customName from session_names rows (#2748 ST-2)', async () => {
    // Query 1: sessions rows; Query 2: session_names rows.
    mockQuery
      .mockResolvedValueOnce([
        {
          session_id: 'sess-1',
          label: '2024-01-01, 12:00:00 AM',
          start_time: '2024-01-01T00:00:00.000Z',
          end_time: null,
          delivery_count: 7,
        },
      ])
      .mockResolvedValueOnce([
        {
          session_id: 'sess-1',
          custom_name: 'My custom label',
          derived_name: 'first chat message',
        },
      ]);

    const sessions = await loadPersistedSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].derivedName).toBe('first chat message');
    expect(sessions[0].customName).toBe('My custom label');
  });

  it('loadPersistedSessions leaves name fields undefined when no session_names row exists', async () => {
    mockQuery
      .mockResolvedValueOnce([
        {
          session_id: 'sess-1',
          label: '2024-01-01, 12:00:00 AM',
          start_time: '2024-01-01T00:00:00.000Z',
          end_time: null,
          delivery_count: 7,
        },
      ])
      .mockResolvedValueOnce([]); // no session_names rows

    const sessions = await loadPersistedSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].derivedName).toBeUndefined();
    expect(sessions[0].customName).toBeUndefined();
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

  it('deleteSessionFromStore removes events, session, and session_names', async () => {
    mockDelete.mockResolvedValue(1);
    mockQuery.mockResolvedValue([]); // no child rows

    await deleteSessionFromStore('sess-to-delete');

    // Events deleted first, then session, then session_names (#2748 ST-2)
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
    expect(mockDelete).toHaveBeenCalledWith(
      expect.objectContaining({
        featureId: 'mission-monitor',
        tableName: 'session_names',
        whereCols: { session_id: 'sess-to-delete' },
      })
    );
  });

  it('deleteSessionFromStore marks session as deleted and records the restart-durable tombstone (P4.3)', async () => {
    mockDelete.mockResolvedValue(1);
    mockQuery.mockResolvedValue([]);
    mockInsert.mockResolvedValue(1);

    await deleteSessionFromStore('mark-sess-test');

    // After delete, session should be marked in module-level set
    expect(isSessionDeleted('mark-sess-test')).toBe(true);
    // Tombstone row recorded
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        featureId: 'mission-monitor',
        tableName: 'deleted_sessions',
        rows: [expect.objectContaining({ session_id: 'mark-sess-test' })],
      })
    );
  });

  it('deleteSessionFromStore removes CHILD event rows discovered from the persisted childSessionId links (#2762 R-9)', async () => {
    mockQuery
      // The root's persisted event rows — one carries a childSessionId link.
      .mockResolvedValueOnce([
        {
          delivery_id: 'd1',
          session_id: 'root-1',
          contract_name: 'subagent-tool-activity',
          payload_json: JSON.stringify({ childSessionId: 'child-1' }),
          timestamp: '2024-01-01T00:00:00.000Z',
          key_json: '{}',
        },
        {
          delivery_id: 'd2',
          session_id: 'root-1',
          contract_name: 'chat-node',
          payload_json: JSON.stringify({ userMessage: 'hi' }),
          timestamp: '2024-01-01T00:00:01.000Z',
          key_json: '{}',
        },
      ])
      // The child key's event rows query — none left.
      .mockResolvedValue([]);
    mockDelete.mockResolvedValue(1);
    mockInsert.mockResolvedValue(1);

    await deleteSessionFromStore('root-1');

    expect(isSessionDeleted('child-1')).toBe(true);
    expect(mockDelete).toHaveBeenCalledWith(
      expect.objectContaining({
        featureId: 'mission-monitor',
        tableName: 'events',
        whereCols: { session_id: 'child-1' },
      })
    );
  });

  // ── recordSessionDeleted ──────────────────────────────────────────────────

  it('recordSessionDeleted persists a tombstone row (idempotent PK insert)', async () => {
    mockInsert.mockResolvedValue(1);

    await recordSessionDeleted('tomb-sess');

    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        featureId: 'mission-monitor',
        tableName: 'deleted_sessions',
        rows: [expect.objectContaining({ session_id: 'tomb-sess' })],
      })
    );
  });

  // ── markSessionDeleted / isSessionDeleted ─────────────────────────────────

  it('markSessionDeleted marks a session as deleted', () => {
    markSessionDeleted('test-sess-1');
    expect(isSessionDeleted('test-sess-1')).toBe(true);
  });

  it('isSessionDeleted returns false for unmarked sessions', () => {
    expect(isSessionDeleted('unknown-session')).toBe(false);
  });

  // ── #2748 ST-2: saveCustomName ────────────────────────────────────────────

  it('saveCustomName updates an existing row via atomic featureStoreUpdate', async () => {
    mockQuery.mockResolvedValueOnce([{ session_id: 'sess-1', custom_name: null, derived_name: 'derived' }]);
    mockUpdate.mockResolvedValue(1);

    await saveCustomName('sess-1', '  My custom name  ');

    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        featureId: 'mission-monitor',
        tableName: 'session_names',
        setCols: { custom_name: 'My custom name' },
        whereCols: { session_id: 'sess-1' },
      })
    );
    // No delete+insert upsert
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('saveCustomName clears the custom name to NULL when given empty/whitespace', async () => {
    mockQuery.mockResolvedValueOnce([{ session_id: 'sess-1', custom_name: 'old', derived_name: 'derived' }]);
    mockUpdate.mockResolvedValue(1);

    await saveCustomName('sess-1', '   ');

    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        featureId: 'mission-monitor',
        tableName: 'session_names',
        setCols: { custom_name: null },
        whereCols: { session_id: 'sess-1' },
      })
    );
  });

  it('saveCustomName inserts a fresh row when none exists (non-empty name)', async () => {
    mockQuery.mockResolvedValueOnce([]);
    mockInsert.mockResolvedValue(1);

    await saveCustomName('sess-new', 'My custom name');

    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        featureId: 'mission-monitor',
        tableName: 'session_names',
        rows: [{
          session_id: 'sess-new',
          custom_name: 'My custom name',
          derived_name: null,
        }],
      })
    );
  });

  it('saveCustomName is a no-op when no row exists and the name is empty', async () => {
    mockQuery.mockResolvedValueOnce([]);

    await saveCustomName('sess-ghost', '  ');

    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });
});
