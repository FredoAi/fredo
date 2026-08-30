/**
 * Tests for persistence.ts — Mission Monitor SQLite persistence layer.
 *
 * Mocks the FeatureStore IPC client to verify:
 * - initMmTables creates the sessions, events, and session_names tables
 * - loadPersistedSessions returns typed MissionMonitorSession[] (with names merged)
 * - #2748 FIX-1: loadPersistedSessions ensures the session_names table exists
 *   BEFORE querying it (mount-order regression — the load query used to fire
 *   before CREATE TABLE landed: `no such table: feature_mission_monitor_session_names`)
 * - deleteSessionFromStore removes session, events, and session_names
 * - markSessionDeleted / isSessionDeleted track deletion cross-mount
 * - persistDelivery skips deliveries for module-level deleted sessions (REQ-3)
 * - persistDelivery uses atomic UPDATE instead of delete+insert
 * - persistDelivery creates initial session row on first delivery
 * - persistDelivery skips delivery insert when UPDATE returns 0 (race condition)
 * - persistDelivery captures the derived name from chat-node deliveries (#2748 ST-2)
 * - saveCustomName sets/clears the custom name via atomic UPDATE (#2748 ST-2)
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
  saveCustomName,
  markSessionDeleted,
  isSessionDeleted,
  createDeliveryWatermark,
  nextUnseenDeliveries,
  loadPersistedChildDeliveries,
  isSubagentToolActivityDelivery,
  childSessionIdsFromDeliveries,
  SUBAGENT_TOOL_ACTIVITY_CONTRACT,
  type DeliveryWatermarkState,
} from '../persistence';

describe('persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── initMmTables ──────────────────────────────────────────────────────────

  it('initMmTables ensures sessions, events, and session_names tables', async () => {
    mockEnsureTable.mockResolvedValue(undefined);

    await initMmTables();

    // Should have been called for all three tables
    expect(mockEnsureTable).toHaveBeenCalledTimes(3);

    const sessionsCall = mockEnsureTable.mock.calls.find(
      (c: unknown[]) => (c[0] as Record<string, unknown>)?.tableName === 'sessions'
    );
    const eventsCall = mockEnsureTable.mock.calls.find(
      (c: unknown[]) => (c[0] as Record<string, unknown>)?.tableName === 'events'
    );
    const namesCall = mockEnsureTable.mock.calls.find(
      (c: unknown[]) => (c[0] as Record<string, unknown>)?.tableName === 'session_names'
    );

    expect(sessionsCall).toBeDefined();
    expect(eventsCall).toBeDefined();
    expect(namesCall).toBeDefined();

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

    // First call triggers the ensure (3 tables); the memoized guard means the
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
      .mockResolvedValueOnce([{ session_id: 'sess-race', label: 'Race', start_time: '2024-01-01T00:00:00.000Z', delivery_count: 3 }])
      .mockResolvedValueOnce([]); // ST-5 replay-dedupe query → not already stored

    // But UPDATE returns 0 — session was deleted between query and update
    mockUpdate.mockResolvedValue(0);

    const delivery = makeDelivery('del-race', 'init', 'sess-race', 'corr-1');

    await persistDelivery(delivery);

    // Should have called UPDATE but it returned 0
    expect(mockUpdate).toHaveBeenCalled();

    // Should NOT have inserted any delivery (race condition — session was deleted)
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('persistDelivery skips an already-stored delivery (Spec #2768 ST-5 hydration replay dedupe — no delivery_count inflation)', async () => {
    // Existing session whose events table ALREADY holds this delivery_id —
    // the shape of a hydration replay (ST-5 replays backend-store rows under
    // their ORIGINAL ids) or a remount re-scan of TTL-surviving deliveries.
    mockQuery
      .mockResolvedValueOnce([{ session_id: 'sess-1', label: 'Existing', start_time: '2024-01-01T00:00:00.000Z', delivery_count: 5 }])
      .mockResolvedValueOnce([{ delivery_id: 'del-replayed', session_id: 'sess-1' }]); // replay-dedupe → already stored

    const delivery = makeDelivery('del-replayed', 'init', 'sess-1', 'corr-1');

    await persistDelivery(delivery);

    // NOTHING written: no delivery_count increment, no event insert, no
    // derived-name capture — the row was already counted and stored.
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('persistDelivery ignores delivery without sessionId', async () => {
    const delivery = makeDelivery('del-no-sess', 'init', '', 'corr-1');

    await persistDelivery(delivery);

    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  // ── #2748 ST-2: derived-name capture ──────────────────────────────────────

  it('persistDelivery captures derived_name from a chat-node delivery (new session, no name row)', async () => {
    // New session: no existing session, no session_names row; cap queries empty.
    mockQuery
      .mockResolvedValueOnce([])                 // existing session check
      .mockResolvedValueOnce([])                 // session_names read-guard
      .mockResolvedValue([]);                    // cap queries

    mockInsert.mockResolvedValue(1);

    const delivery = makeDelivery('del-cap-1', 'init', 'new-sess', 'corr-1', {
      userMessage: '  first chat message  ',
    });

    await persistDelivery(delivery);

    // Should have INSERTed a session_names row with the trimmed userMessage
    const nameInsertCalls = mockInsert.mock.calls.filter(
      (c: unknown[]) => (c[0] as Record<string, unknown>)?.tableName === 'session_names'
    );
    expect(nameInsertCalls.length).toBeGreaterThanOrEqual(1);
    const nameArgs = nameInsertCalls[0][0] as { rows: Record<string, unknown>[] };
    expect(nameArgs.rows[0]).toEqual({
      session_id: 'new-sess',
      custom_name: null,
      derived_name: 'first chat message',
    });
  });

  it('persistDelivery updates derived_name when a session_names row exists with empty derived_name', async () => {
    // Existing session + existing session_names row with NULL derived_name.
    mockQuery
      .mockResolvedValueOnce([{ session_id: 'sess-1', label: 'Existing', start_time: '2024-01-01T00:00:00.000Z', delivery_count: 1 }])
      .mockResolvedValueOnce([]) // ST-5 replay-dedupe query → not already stored
      .mockResolvedValueOnce([{ session_id: 'sess-1', custom_name: null, derived_name: null }])
      .mockResolvedValue([]);

    mockUpdate.mockResolvedValue(1);
    mockInsert.mockResolvedValue(1);

    const delivery = makeDelivery('del-cap-2', 'init', 'sess-1', 'corr-1', {
      userMessage: 'first chat message',
    });

    await persistDelivery(delivery);

    // Atomic UPDATE on session_names — never delete+insert
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        featureId: 'mission-monitor',
        tableName: 'session_names',
        setCols: { derived_name: 'first chat message' },
        whereCols: { session_id: 'sess-1' },
      })
    );

    // No INSERT into session_names when a row already exists
    const nameInsertCalls = mockInsert.mock.calls.filter(
      (c: unknown[]) => (c[0] as Record<string, unknown>)?.tableName === 'session_names'
    );
    expect(nameInsertCalls.length).toBe(0);

    // No session_names DELETE (no delete+insert upsert)
    const nameDeleteCalls = mockDelete.mock.calls.filter(
      (c: unknown[]) => (c[0] as Record<string, unknown>)?.tableName === 'session_names'
    );
    expect(nameDeleteCalls.length).toBe(0);
  });

  it('persistDelivery never overwrites an existing non-empty derived_name (first-non-empty-wins)', async () => {
    // Existing session + session_names row that already has a derived_name.
    mockQuery
      .mockResolvedValueOnce([{ session_id: 'sess-1', label: 'Existing', start_time: '2024-01-01T00:00:00.000Z', delivery_count: 2 }])
      .mockResolvedValueOnce([]) // ST-5 replay-dedupe query → not already stored
      .mockResolvedValueOnce([{ session_id: 'sess-1', custom_name: null, derived_name: 'already-captured' }])
      .mockResolvedValue([]);

    mockUpdate.mockResolvedValue(1);
    mockInsert.mockResolvedValue(1);

    const delivery = makeDelivery('del-cap-3', 'init', 'sess-1', 'corr-1', {
      userMessage: 'a later message',
    });

    await persistDelivery(delivery);

    // No UPDATE touching session_names.derived_name
    const nameUpdateCalls = mockUpdate.mock.calls.filter(
      (c: unknown[]) => (c[0] as Record<string, unknown>)?.tableName === 'session_names'
    );
    expect(nameUpdateCalls.length).toBe(0);
  });

  it('persistDelivery does NOT capture derived_name when userMessage is empty/whitespace', async () => {
    // New session; no session_names row should be created.
    mockQuery
      .mockResolvedValueOnce([])                 // existing session check
      .mockResolvedValue([]);                    // cap queries (no name query)

    mockInsert.mockResolvedValue(1);

    const delivery = makeDelivery('del-cap-4', 'init', 'sess-empty', 'corr-1', {
      userMessage: '   ',
    });

    await persistDelivery(delivery);

    const nameInsertCalls = mockInsert.mock.calls.filter(
      (c: unknown[]) => (c[0] as Record<string, unknown>)?.tableName === 'session_names'
    );
    expect(nameInsertCalls.length).toBe(0);
    // No session_names query either (capture short-circuits before the read-guard)
    const nameQueryCalls = mockQuery.mock.calls.filter(
      (c: unknown[]) => (c[0] as Record<string, unknown>)?.tableName === 'session_names'
    );
    expect(nameQueryCalls.length).toBe(0);
  });

  it('persistDelivery does NOT capture derived_name for non-chat-node deliveries', async () => {
    mockQuery
      .mockResolvedValueOnce([])                 // existing session check
      .mockResolvedValue([]);

    mockInsert.mockResolvedValue(1);

    const delivery = makeDelivery('del-tool-1', 'init', 'sess-tool', 'corr-1', {
      userMessage: 'tool payload',
    });
    // Override to a non-chat contract
    delivery.contractName = 'tool-use-lifecycle';

    await persistDelivery(delivery);

    const nameQueryCalls = mockQuery.mock.calls.filter(
      (c: unknown[]) => (c[0] as Record<string, unknown>)?.tableName === 'session_names'
    );
    expect(nameQueryCalls.length).toBe(0);
  });

  it('persistDelivery prunes session_names rows for sessions evicted by the cap', async () => {
    // New session; cap query returns 51 rows so the oldest is pruned.
    const capRows = Array.from({ length: 51 }, (_, i) => ({
      session_id: `cap-sess-${i}`,
      start_time: `2024-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      delivery_count: 1,
    }));

    mockQuery
      .mockResolvedValueOnce([])                 // existing session check
      .mockResolvedValue(capRows);               // session cap query

    mockInsert.mockResolvedValue(1);

    const delivery = makeDelivery('del-cap-sess', 'init', 'new-sess', 'corr-1');

    await persistDelivery(delivery);

    // The oldest session (cap-sess-50, last of the DESC-ordered 51) is pruned:
    // its events, sessions row, AND session_names row are all deleted.
    expect(mockDelete).toHaveBeenCalledWith(
      expect.objectContaining({
        featureId: 'mission-monitor',
        tableName: 'session_names',
        whereCols: { session_id: 'cap-sess-50' },
      })
    );
    expect(mockDelete).toHaveBeenCalledWith(
      expect.objectContaining({
        featureId: 'mission-monitor',
        tableName: 'sessions',
        whereCols: { session_id: 'cap-sess-50' },
      })
    );
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

// ── #2762 ST-5: child-delivery persistence (R-7 sidebar / R-9 restore) ───────

describe('#2762 ST-5: child-delivery persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('identifies child deliveries and extracts childSessionId links', () => {
    const child = makeDelivery('d-c', 'end', 'child-1', 'c1', {}, SUBAGENT_TOOL_ACTIVITY_CONTRACT);
    const root = makeDelivery('d-r', 'end', 'root-1', 'r1', { childSessionId: 'child-1' });

    expect(isSubagentToolActivityDelivery(child)).toBe(true);
    expect(isSubagentToolActivityDelivery(root)).toBe(false);
    expect(childSessionIdsFromDeliveries([root, child])).toEqual(['child-1']);
    // Dedup + skip empty/absent links.
    expect(childSessionIdsFromDeliveries([
      makeDelivery('a', 'end', 'r', 'c', { childSessionId: 'x' }),
      makeDelivery('b', 'end', 'r', 'c', { childSessionId: 'x' }),
      makeDelivery('c', 'end', 'r', 'c', {}),
      makeDelivery('d', 'end', 'r', 'c', { childSessionId: '' }),
    ])).toEqual(['x']);
  });

  it('persistDelivery stores a child delivery as an event row WITHOUT a sessions-table row (R-7 sidebar guard)', async () => {
    mockEnsureTable.mockResolvedValue(undefined);
    mockQuery.mockResolvedValue([]); // event-cap queries → empty
    mockInsert.mockResolvedValue(1);

    await persistDelivery(
      makeDelivery('d-child-1', 'end', 'child-sess-1', 'corr-c1', { 'gen_ai.tool.name': 'read' }, SUBAGENT_TOOL_ACTIVITY_CONTRACT),
    );

    // NO sessions-table insert/update and no session_names write — the child
    // key must never surface in the sidebar (live or restored).
    const sessionInserts = mockInsert.mock.calls.filter(
      (c: unknown[]) => (c[0] as Record<string, unknown>)?.tableName === 'sessions'
    );
    expect(sessionInserts.length).toBe(0);
    const namesInserts = mockInsert.mock.calls.filter(
      (c: unknown[]) => (c[0] as Record<string, unknown>)?.tableName === 'session_names'
    );
    expect(namesInserts.length).toBe(0);
    expect(mockUpdate).not.toHaveBeenCalled();

    // Exactly one EVENT row, keyed by the child session id.
    const eventInserts = mockInsert.mock.calls.filter(
      (c: unknown[]) => (c[0] as Record<string, unknown>)?.tableName === 'events'
    );
    expect(eventInserts.length).toBe(1);
    const eventArgs = eventInserts[0][0] as { rows: Record<string, unknown>[] };
    expect(eventArgs.rows[0].delivery_id).toBe('d-child-1');
    expect(eventArgs.rows[0].session_id).toBe('child-sess-1');
    expect(eventArgs.rows[0].contract_name).toBe('subagent-tool-activity');
  });

  it('persistDelivery skips a child delivery for a deleted child key (non-resurrection extends to child keys)', async () => {
    markSessionDeleted('child-del-key-1');

    await persistDelivery(
      makeDelivery('d-child-del', 'end', 'child-del-key-1', 'corr', {}, SUBAGENT_TOOL_ACTIVITY_CONTRACT),
    );

    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('loadPersistedChildDeliveries loads child rows breadth-first from the root childSessionId links (R-9)', async () => {
    mockEnsureTable.mockResolvedValue(undefined);

    const childRow = {
      delivery_id: 'd-c1',
      session_id: 'child-1',
      contract_name: 'subagent-tool-activity',
      lifecycle: 'end',
      payload_json: JSON.stringify({ payload: { childSessionId: 'grand-1', 'gen_ai.tool.name': 'read' } }),
      timestamp: '2026-01-01T00:00:02.000Z',
      key_json: JSON.stringify({ sessionId: 'child-1', correlationId: 'c1' }),
    };
    const grandRow = {
      delivery_id: 'd-g1',
      session_id: 'grand-1',
      contract_name: 'subagent-tool-activity',
      lifecycle: 'end',
      payload_json: JSON.stringify({ payload: {} }),
      timestamp: '2026-01-01T00:00:03.000Z',
      key_json: JSON.stringify({ sessionId: 'grand-1', correlationId: 'g1' }),
    };
    mockQuery.mockImplementation(async (args: Record<string, unknown>) => {
      const where = (args?.whereCols ?? {}) as Record<string, unknown>;
      if (where['session_id'] === 'child-1') return [childRow];
      if (where['session_id'] === 'grand-1') return [grandRow];
      return [];
    });

    const rootDeliveries = [
      makeDelivery('r1', 'end', 'root-1', 'c-root', { childSessionId: 'child-1' }),
      makeDelivery('r2', 'end', 'root-1', 'c-root2', {}),
    ];
    const result = await loadPersistedChildDeliveries('root-1', rootDeliveries);

    // Grandchild discovered from the CHILD's own rows (breadth-first, any depth).
    expect(result.map((d) => d.id)).toEqual(['d-c1', 'd-g1']);
    // Child keys are queried with the contract filter (only nested rows load).
    const childQuery = mockQuery.mock.calls.find(
      (c: unknown[]) => ((c[0] as Record<string, unknown>)?.whereCols as Record<string, unknown>)?.['session_id'] === 'child-1'
    );
    expect(childQuery).toBeDefined();
    expect((childQuery![0] as Record<string, unknown>)['whereCols']).toMatchObject({
      session_id: 'child-1',
      contract_name: 'subagent-tool-activity',
    });
  });

  it('loadPersistedChildDeliveries skips deleted child keys and a deleted root (non-resurrection)', async () => {
    mockEnsureTable.mockResolvedValue(undefined);
    mockQuery.mockResolvedValue([]);

    markSessionDeleted('child-del-x');
    const empty = await loadPersistedChildDeliveries(
      'root-2',
      [makeDelivery('r1', 'end', 'root-2', 'c', { childSessionId: 'child-del-x' })],
    );
    expect(empty).toEqual([]);
    const queried = mockQuery.mock.calls.filter(
      (c: unknown[]) => ((c[0] as Record<string, unknown>)?.whereCols as Record<string, unknown>)?.['session_id'] === 'child-del-x'
    );
    expect(queried.length).toBe(0);

    markSessionDeleted('root-del-2');
    const none = await loadPersistedChildDeliveries(
      'root-del-2',
      [makeDelivery('r9', 'end', 'root-del-2', 'c', { childSessionId: 'child-anything' })],
    );
    expect(none).toEqual([]);
  });

  it('deleteSessionFromStore removes child event rows and marks child keys deleted (R-9)', async () => {
    mockEnsureTable.mockResolvedValue(undefined);
    const rootEventRow = {
      delivery_id: 'd-r',
      session_id: 'root-3',
      contract_name: 'chat-node',
      lifecycle: 'end',
      payload_json: JSON.stringify({ payload: { childSessionId: 'child-of-root-3' } }),
      timestamp: '2026-01-01T00:00:01.000Z',
      key_json: '{}',
    };
    mockQuery.mockResolvedValue([rootEventRow]);
    mockDelete.mockResolvedValue(1);

    await deleteSessionFromStore('root-3');

    // Child key marked deleted (guards concurrent child persistDelivery).
    expect(isSessionDeleted('child-of-root-3')).toBe(true);
    // Child event rows deleted.
    const childDelete = mockDelete.mock.calls.find(
      (c: unknown[]) => {
        const args = c[0] as Record<string, unknown>;
        const where = args?.whereCols as Record<string, unknown>;
        return args?.tableName === 'events' && where?.['session_id'] === 'child-of-root-3';
      }
    );
    expect(childDelete).toBeDefined();
    // Root rows deleted (events + sessions + session_names).
    const rootDeletes = mockDelete.mock.calls.filter(
      (c: unknown[]) => ((c[0] as Record<string, unknown>)?.whereCols as Record<string, unknown>)?.['session_id'] === 'root-3'
    );
    expect(rootDeletes.length).toBe(3);
  });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeDelivery(
  id: string,
  lifecycle: 'init' | 'update' | 'end',
  sessionId: string,
  correlationId: string,
  innerPayload?: Record<string, unknown>,
  contractName: string = 'chat-node',
): ContractDelivery {
  return {
    id,
    contractName,
    lifecycle,
    key: { sessionId, correlationId },
    payload: { payload: innerPayload ?? {} },
    timestamp: new Date().toISOString(),
  };
}
