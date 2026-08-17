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

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeDelivery(
  id: string,
  lifecycle: 'init' | 'update' | 'end',
  sessionId: string,
  correlationId: string,
  innerPayload?: Record<string, unknown>,
): ContractDelivery {
  return {
    id,
    contractName: 'chat-node',
    lifecycle,
    key: { sessionId, correlationId },
    payload: { payload: innerPayload ?? {} },
    timestamp: new Date().toISOString(),
  };
}
