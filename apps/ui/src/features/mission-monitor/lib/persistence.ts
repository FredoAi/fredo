/**
 * persistence.ts — Mission Monitor SQLite persistence layer.
 *
 * Uses the generic FeatureStore IPC client to persist sessions and deliveries
 * to the `feature_mission-monitor_sessions` and `feature_mission-monitor_events`
 * tables. Replaces the old localStorage-based sessionStorage.ts.
 *
 * ── Caps ─────────────────────────────────────────────────────────────────────
 * - 50 sessions max (prunes oldest when exceeded)
 * - 500 events per session max (prunes oldest when exceeded)
 *
 * ── Edge Cases ───────────────────────────────────────────────────────────────
 * - Deleted session deliveries are silently ignored (no resurrection)
 * - Corrupted delivery payloads caught by try/catch
 * - Table creation is idempotent (CREATE TABLE IF NOT EXISTS)
 */
import type { ContractDelivery } from '../../../shared/classes/EventSubscription';
import {
  featureStoreEnsureTable,
  featureStoreInsert,
  featureStoreQuery,
  featureStoreUpdate,
  featureStoreDelete,
  type FeatureStoreRow,
} from '../../../shared/lib/featureStore';
import type { MissionMonitorSession } from './graph';
import { deliverySessionId } from './graph';

// ── Module-Level Deletion Tracking ──────────────────────────────────────────
// Survives component unmount — not tied to React lifecycle.
// Cleared on page reload, but on reload deleted sessions are naturally absent
// from SQLite (the delete IPC call removes them).

const deletedSessionIds = new Set<string>();

/**
 * Mark a session as deleted. Survives component unmount.
 * Call BEFORE the SQLite delete to prevent concurrent persistDelivery
 * from re-inserting the session during the delete race window.
 */
export function markSessionDeleted(sessionId: string): void {
  deletedSessionIds.add(sessionId);
}

/**
 * Check if a session has been marked as deleted.
 * Survives component unmount (module-scoped Set, not React-scoped).
 */
export function isSessionDeleted(sessionId: string): boolean {
  return deletedSessionIds.has(sessionId);
}

// ── Constants ────────────────────────────────────────────────────────────────

const MM_FEATURE_ID = 'mission-monitor';
const MM_SESSIONS_TABLE = 'sessions';
const MM_EVENTS_TABLE = 'events';
const MM_MAX_SESSIONS = 50;
const MM_MAX_DELIVERIES_PER_SESSION = 500;

// ── Persisted row shapes (mirrors .opencode/tmp/contract-339.ts) ─────────────

interface PersistedSession {
  session_id: string;
  label: string;
  start_time: string;
  end_time: string | null;
  delivery_count: number;
}

interface PersistedDelivery {
  delivery_id: string;
  session_id: string;
  contract_name: string;
  lifecycle: string;
  payload_json: string;
  timestamp: string;
  key_json: string;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialize the sessions and events tables.
 * Safe to call on every mount — uses CREATE TABLE IF NOT EXISTS.
 */
export async function initMmTables(): Promise<void> {
  await Promise.all([
    featureStoreEnsureTable({
      featureId: MM_FEATURE_ID,
      tableName: MM_SESSIONS_TABLE,
      columns: [
        { name: 'session_id', colType: 'TEXT', primaryKey: true },
        { name: 'label', colType: 'TEXT' },
        { name: 'start_time', colType: 'TEXT' },
        { name: 'end_time', colType: 'TEXT', nullable: true },
        { name: 'delivery_count', colType: 'INTEGER' },
      ],
    }),
    featureStoreEnsureTable({
      featureId: MM_FEATURE_ID,
      tableName: MM_EVENTS_TABLE,
      columns: [
        { name: 'delivery_id', colType: 'TEXT', primaryKey: true },
        { name: 'session_id', colType: 'TEXT' },
        { name: 'contract_name', colType: 'TEXT' },
        { name: 'lifecycle', colType: 'TEXT' },
        { name: 'payload_json', colType: 'TEXT' },
        { name: 'timestamp', colType: 'TEXT' },
        { name: 'key_json', colType: 'TEXT' },
      ],
    }),
  ]);
}

/**
 * Load all persisted sessions from SQLite, ordered by start_time DESC.
 */
export async function loadPersistedSessions(): Promise<MissionMonitorSession[]> {
  const rows = await featureStoreQuery({
    featureId: MM_FEATURE_ID,
    tableName: MM_SESSIONS_TABLE,
    orderBy: 'start_time DESC',
  });

  return rows.map(rowToSession).filter(Boolean) as MissionMonitorSession[];
}

/**
 * Load persisted deliveries for a specific session, ordered by timestamp ASC.
 */
export async function loadPersistedDeliveries(sessionId: string): Promise<ContractDelivery[]> {
  const rows = await featureStoreQuery({
    featureId: MM_FEATURE_ID,
    tableName: MM_EVENTS_TABLE,
    whereCols: { session_id: sessionId },
    orderBy: 'timestamp ASC',
  });

  return rows.map(rowToDelivery).filter(Boolean) as ContractDelivery[];
}

/**
 * Persist a single delivery to SQLite.
 *
 * - If the session was deleted (checked via module-level set), the delivery is
 *   silently ignored (REQ-3: prevent resurrection).
 * - Session record uses atomic UPDATE instead of delete+insert to prevent
 *   race-condition re-insertion of deleted sessions.
 * - First-time deliveries create an initial session row.
 * - Delivery is deduplicated by delivery_id.
 * - Caps are enforced after each insertion.
 */
export async function persistDelivery(delivery: ContractDelivery): Promise<void> {
  try {
    const sessionId = deliverySessionId(delivery);
    if (!sessionId) return;

    // REQ-3: Skip if session was explicitly deleted (module-level tracking)
    if (isSessionDeleted(sessionId)) return;

    const sessionTs = new Date(delivery.timestamp).getTime();

    // Check if session exists in SQLite
    const existingSessions = await featureStoreQuery({
      featureId: MM_FEATURE_ID,
      tableName: MM_SESSIONS_TABLE,
      whereCols: { session_id: sessionId },
    });

    if (existingSessions.length > 0) {
      // Existing session — atomic UPDATE to increment delivery_count
      const existingRow = existingSessions[0] as Record<string, unknown>;
      const currentCount = typeof existingRow.delivery_count === 'number' ? existingRow.delivery_count : 0;

      const updated = await featureStoreUpdate({
        featureId: MM_FEATURE_ID,
        tableName: MM_SESSIONS_TABLE,
        setCols: {
          delivery_count: currentCount + 1,
          end_time: null,
        },
        whereCols: { session_id: sessionId },
      });

      // If UPDATE returned 0, session was deleted between query and update
      if (updated === 0) {
        return;
      }
    } else {
      // New session (never persisted) — create initial row
      const label = new Date(sessionTs).toLocaleString();
      const startTime = new Date(sessionTs).toISOString();
      await featureStoreInsert({
        featureId: MM_FEATURE_ID,
        tableName: MM_SESSIONS_TABLE,
        rows: [{
          session_id: sessionId,
          label,
          start_time: startTime,
          end_time: null,
          delivery_count: 1,
        }],
      });
    }

    // Insert delivery (deduplicate by delivery_id — FeatureStore insert is idempotent)
    const payloadJson = safeStringify(delivery.payload);
    const keyJson = safeStringify(delivery.key);

    await featureStoreInsert({
      featureId: MM_FEATURE_ID,
      tableName: MM_EVENTS_TABLE,
      rows: [{
        delivery_id: delivery.id,
        session_id: sessionId,
        contract_name: delivery.contractName,
        lifecycle: delivery.lifecycle,
        payload_json: payloadJson,
        timestamp: delivery.timestamp,
        key_json: keyJson,
      }],
    });

    // Enforce caps
    await enforceSessionCap();
    await enforceEventCap(sessionId);
  } catch (err) {
    console.warn('[MM] persistDelivery failed:', err);
  }
}

/**
 * Delete a session and all its events from SQLite (REQ-7).
 *
 * Calls markSessionDeleted BEFORE any SQLite operations so that concurrent
 * persistDelivery calls see the deletion immediately via the module-level set.
 */
export async function deleteSessionFromStore(sessionId: string): Promise<void> {
  try {
    // Mark deleted FIRST — before SQLite ops — to close the race window
    markSessionDeleted(sessionId);

    // Delete events first (foreign key order doesn't matter but logical)
    await featureStoreDelete({
      featureId: MM_FEATURE_ID,
      tableName: MM_EVENTS_TABLE,
      whereCols: { session_id: sessionId },
    });
    await featureStoreDelete({
      featureId: MM_FEATURE_ID,
      tableName: MM_SESSIONS_TABLE,
      whereCols: { session_id: sessionId },
    });
  } catch (err) {
    console.warn('[MM] deleteSessionFromStore failed:', err);
  }
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/** Cap sessions at MM_MAX_SESSIONS — prune oldest. */
async function enforceSessionCap(): Promise<void> {
  const rows = await featureStoreQuery({
    featureId: MM_FEATURE_ID,
    tableName: MM_SESSIONS_TABLE,
    orderBy: 'start_time DESC',
  });

  if (rows.length <= MM_MAX_SESSIONS) return;

  // Prune from the end (oldest)
  const toPrune = rows.slice(MM_MAX_SESSIONS);
  for (const row of toPrune) {
    const sid = (row as Record<string, unknown>)['session_id'] as string;
    if (sid) {
      await featureStoreDelete({
        featureId: MM_FEATURE_ID,
        tableName: MM_EVENTS_TABLE,
        whereCols: { session_id: sid },
      });
      await featureStoreDelete({
        featureId: MM_FEATURE_ID,
        tableName: MM_SESSIONS_TABLE,
        whereCols: { session_id: sid },
      });
    }
  }
}

/** Cap events per session at MM_MAX_DELIVERIES_PER_SESSION — prune oldest. */
async function enforceEventCap(sessionId: string): Promise<void> {
  const rows = await featureStoreQuery({
    featureId: MM_FEATURE_ID,
    tableName: MM_EVENTS_TABLE,
    whereCols: { session_id: sessionId },
    orderBy: 'timestamp ASC',
  });

  if (rows.length <= MM_MAX_DELIVERIES_PER_SESSION) return;

  const toPrune = rows.slice(0, rows.length - MM_MAX_DELIVERIES_PER_SESSION);
  for (const row of toPrune) {
    const deliveryId = (row as Record<string, unknown>)['delivery_id'] as string;
    if (deliveryId) {
      await featureStoreDelete({
        featureId: MM_FEATURE_ID,
        tableName: MM_EVENTS_TABLE,
        whereCols: { delivery_id: deliveryId },
      });
    }
  }
}

/** Convert a FeatureStore row to MissionMonitorSession. */
function rowToSession(row: FeatureStoreRow): MissionMonitorSession | null {
  const r = row as Record<string, unknown>;
  const sessionId = r['session_id'] as string | undefined;
  if (!sessionId) return null;

  const startTimeStr = r['start_time'] as string | undefined;
  const startTime = startTimeStr ? new Date(startTimeStr).getTime() : Date.now();

  return {
    sessionId,
    label: (r['label'] as string) ?? new Date(startTime).toLocaleString(),
    startTime,
    latestTimestamp: (r['start_time'] as string) ?? new Date().toISOString(),
    deliveryCount: (typeof r['delivery_count'] === 'number' ? r['delivery_count'] : 0),
  };
}

/** Convert a FeatureStore row to ContractDelivery. */
function rowToDelivery(row: FeatureStoreRow): ContractDelivery | null {
  const r = row as Record<string, unknown>;
  const deliveryId = r['delivery_id'] as string | undefined;
  if (!deliveryId) return null;

  let payload: Record<string, unknown> = {};
  let key: Record<string, string> = {};

  try {
    const parsed = JSON.parse((r['payload_json'] as string) ?? '{}');
    if (typeof parsed === 'object' && parsed !== null) payload = parsed as Record<string, unknown>;
  } catch { /* use default empty */ }

  try {
    const parsed = JSON.parse((r['key_json'] as string) ?? '{}');
    if (typeof parsed === 'object' && parsed !== null) {
      key = parsed as Record<string, string>;
    }
  } catch { /* use default empty */ }

  return {
    id: deliveryId,
    contractName: (r['contract_name'] as string) ?? 'unknown',
    lifecycle: (r['lifecycle'] as 'init' | 'update' | 'end') ?? 'init',
    key,
    payload,
    timestamp: (r['timestamp'] as string) ?? new Date().toISOString(),
  };
}

/** JSON.stringify with try/catch for circular refs. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '{}';
  }
}
