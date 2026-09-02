/**
 * persistence.ts — Mission Monitor SQLite persistence layer (FeatureStore).
 *
 * Spec #2788 P5.1: the v1 ContractDelivery persistence path (persistDelivery,
 * hydration loads, the shrink-safe watermark) was deleted together with the
 * v1 pipeline — the sidebar derives from RTDB rows (useSessionHistory P4.3)
 * and the backend SQLite store is the row authority. What REMAINS here is the
 * name/label snapshot (sessions + session_names), the deletion tombstones
 * (P4.3 anti-resurrection against replay), and the child-row cleanup that
 * legacy persisted `subagent-tool-activity` event rows need.
 *
 * ── Table naming (#2748 FIX-1) ───────────────────────────────────────────────
 * The backend namespaces FeatureStore tables as `feature_{featureId}_{tableName}`
 * with the featureId's hyphens sanitized to underscores (feature_store.rs
 * `full_table_name`) — so `featureId: 'mission-monitor'` + `tableName: 'session_names'`
 * physically materializes as `feature_mission_monitor_session_names`.
 *
 * ── Caps ─────────────────────────────────────────────────────────────────────
 * - 50 sessions max (prunes oldest when exceeded)
 *
 * ── Edge Cases ───────────────────────────────────────────────────────────────
 * - Deleted session rows are silently ignored (no resurrection)
 * - Corrupted payloads caught by try/catch
 * - Table creation is idempotent (CREATE TABLE IF NOT EXISTS)
 */
import {
  featureStoreEnsureTable,
  featureStoreInsert,
  featureStoreQuery,
  featureStoreUpdate,
  featureStoreDelete,
  type FeatureStoreRow,
} from '../../../shared/lib/featureStore';
import type { MissionMonitorSession } from './graph';

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

/**
 * Spec #2788 P4.3: persist a deletion tombstone so the deleted-session guard
 * survives an app restart. RTDB replay re-inserts every row the backend
 * SQLite store holds — a session deleted in a previous app run would
 * otherwise resurrect in the sidebar (REQ-3 non-resurrection). Idempotent
 * (INSERT is a no-op on the PK).
 */
export async function recordSessionDeleted(sessionId: string): Promise<void> {
  try {
    await ensureMmTables();
    await featureStoreInsert({
      featureId: MM_FEATURE_ID,
      tableName: MM_DELETED_SESSIONS_TABLE,
      rows: [{ session_id: sessionId, deleted_at: new Date().toISOString() }],
    });
  } catch (err) {
    console.warn('[MM] recordSessionDeleted failed:', err);
  }
}

/**
 * Spec #2788 P4.3: seed the module-level deleted set from the durable
 * tombstones. Called once per mount by useDeliverySessions BEFORE the
 * `loaded` gate flips, so a deleted session's replayed rows are filtered out
 * from the first derived list (no deleted-session flash on mount).
 */
export async function seedDeletedSessionIdsIntoModule(): Promise<void> {
  try {
    await ensureMmTables();
    const rows = await featureStoreQuery({
      featureId: MM_FEATURE_ID,
      tableName: MM_DELETED_SESSIONS_TABLE,
    });
    for (const row of rows) {
      const sid = (row as Record<string, unknown>)['session_id'] as string | undefined;
      if (sid) deletedSessionIds.add(sid);
    }
  } catch (err) {
    console.warn('[MM] deleted-session tombstone seed failed:', err);
  }
}

// ── Constants ────────────────────────────────────────────────────────────────

const MM_FEATURE_ID = 'mission-monitor';
const MM_SESSIONS_TABLE = 'sessions';
const MM_EVENTS_TABLE = 'events';
const MM_SESSION_NAMES_TABLE = 'session_names';
// Spec #2788 P4.3: durable deletion tombstones. RTDB replay re-inserts every
// row the backend SQLite store holds — a deleted session would resurrect in
// the sidebar after an app restart. A tombstone row survives restart and
// re-seeds the module-level deleted set at every mount.
const MM_DELETED_SESSIONS_TABLE = 'deleted_sessions';
const MM_MAX_SESSIONS = 50;

// ── #2748 FIX-1: table-init order guard ──────────────────────────────────────
// Round-1 regression: on mount the hook's `loadPersistedSessions()` effect is
// registered BEFORE the panel's `initMmTables()` effect (the hook runs first
// inside `useDeliverySessions()`), so the `session_names` query dispatched to
// the backend before the CREATE TABLE landed →
// `[FeatureStore] query failed: no such table: feature_mission_monitor_session_names`
// → persisted sessions restored WITHOUT their derived_name (AC1 fail) + the
// console warning (NFR fail).
// Every FeatureStore entry point below awaits `ensureMmTables()` FIRST, so a
// load query can never precede table creation regardless of mount effect order.
// The init promise is memoized per module load — the idempotent
// (CREATE TABLE IF NOT EXISTS) ensure runs at most once, then all callers await
// the already-resolved promise. A rejected init resets the memo so the next
// access retries instead of poisoning the module.

let tablesInitPromise: Promise<void> | null = null;

function ensureMmTables(): Promise<void> {
  if (!tablesInitPromise) {
    tablesInitPromise = initMmTables().catch((err) => {
      console.warn('[MM] table init failed; will retry on next access:', err);
      tablesInitPromise = null;
    });
  }
  return tablesInitPromise;
}

// ── Persisted row shapes (mirrors .opencode/tmp/contract-339.ts) ─────────────

interface PersistedSession {
  session_id: string;
  label: string;
  start_time: string;
  end_time: string | null;
  delivery_count: number;
}

/** #2748 ST-2 — row shape of the `session_names` table (R-1/R-2 persistence). */
interface SessionNameRow {
  session_id: string;
  custom_name: string | null;
  derived_name: string | null;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialize the sessions, events, and session_names tables.
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
    featureStoreEnsureTable({
      featureId: MM_FEATURE_ID,
      tableName: MM_SESSION_NAMES_TABLE,
      columns: [
        { name: 'session_id', colType: 'TEXT', primaryKey: true },
        { name: 'custom_name', colType: 'TEXT', nullable: true },
        { name: 'derived_name', colType: 'TEXT', nullable: true },
      ],
    }),
    // Spec #2788 P4.3: durable deletion tombstones (see the constant comment).
    featureStoreEnsureTable({
      featureId: MM_FEATURE_ID,
      tableName: MM_DELETED_SESSIONS_TABLE,
      columns: [
        { name: 'session_id', colType: 'TEXT', primaryKey: true },
        { name: 'deleted_at', colType: 'TEXT' },
      ],
    }),
  ]);
}

/**
 * Extract the distinct `childSessionId` links from persisted event rows.
 *
 * The persisted `task` tool-span payloads carry the flat `childSessionId`
 * projection (SubagentNodePayload join key), and a child's own `task` spans
 * carry the grandchild links — so scanning any session's rows yields the NEXT
 * delegation depth. Row order is irrelevant (each distinct id appears once,
 * first occurrence wins).
 */
function childSessionIdsFromRows(rows: FeatureStoreRow[]): string[] {
  const ids: string[] = [];
  for (const row of rows) {
    const r = row as Record<string, unknown>;
    let payload: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse((r['payload_json'] as string) ?? '{}');
      if (typeof parsed === 'object' && parsed !== null) payload = parsed as Record<string, unknown>;
    } catch { /* use default empty */ }
    const child = payload['childSessionId'];
    if (typeof child === 'string' && child.length > 0 && !ids.includes(child)) {
      ids.push(child);
    }
  }
  return ids;
}

/**
 * Load all persisted sessions from SQLite, ordered by start_time DESC.
 * #2748 ST-2: merges `session_names` rows so each session carries its
 * derivedName/customName (R-1 restart survival, R-2).
 */
export async function loadPersistedSessions(): Promise<MissionMonitorSession[]> {
  // #2748 FIX-1: the session_names table must exist before it is queried.
  await ensureMmTables();

  const [rows, nameRows] = await Promise.all([
    featureStoreQuery({
      featureId: MM_FEATURE_ID,
      tableName: MM_SESSIONS_TABLE,
      orderBy: 'start_time DESC',
    }),
    loadSessionNames(),
  ]);

  const namesById = new Map(nameRows.map((r) => [r.session_id, r]));

  return rows.map((row) => rowToSession(row, namesById)).filter(Boolean) as MissionMonitorSession[];
}

/**
 * Load the `session_names` rows (sessionId → custom/derived name).
 * #2748 ST-2 (R-1/R-2): no separate public API — merged into loadPersistedSessions.
 */
async function loadSessionNames(): Promise<SessionNameRow[]> {
  const rows = await featureStoreQuery({
    featureId: MM_FEATURE_ID,
    tableName: MM_SESSION_NAMES_TABLE,
  });
  return rows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      session_id: (r['session_id'] as string) ?? '',
      custom_name: (r['custom_name'] as string | null) ?? null,
      derived_name: (r['derived_name'] as string | null) ?? null,
    };
  });
}

/**
 * #2748 ST-2 (R-2): save (or clear) a user-provided custom session name.
 *
 * Atomic `featureStoreUpdate` — NEVER delete+insert (AGENTS.md SQLite upsert
 * rule). An empty/whitespace name clears the custom name to NULL (the display
 * falls back to derived_name / the timestamp label). When the session_names row
 * does not exist yet (legacy session), a fresh row is INSERTed with the custom
 * name (and no derived name).
 */
export async function saveCustomName(sessionId: string, name: string): Promise<void> {
  try {
    // #2748 FIX-1: the session_names table must exist before it is queried.
    await ensureMmTables();

    const trimmed = name.trim();
    const customName = trimmed.length > 0 ? trimmed : null;

    const existing = await featureStoreQuery({
      featureId: MM_FEATURE_ID,
      tableName: MM_SESSION_NAMES_TABLE,
      whereCols: { session_id: sessionId },
    });

    if (existing.length > 0) {
      await featureStoreUpdate({
        featureId: MM_FEATURE_ID,
        tableName: MM_SESSION_NAMES_TABLE,
        setCols: { custom_name: customName },
        whereCols: { session_id: sessionId },
      });
    } else if (customName !== null) {
      // No row yet — create it with the custom name (INSERT is idempotent on PK).
      await featureStoreInsert({
        featureId: MM_FEATURE_ID,
        tableName: MM_SESSION_NAMES_TABLE,
        rows: [{
          session_id: sessionId,
          custom_name: customName,
          derived_name: null,
        }],
      });
    }
    // else: no row + empty name → nothing to clear, no-op.
  } catch (err) {
    console.warn('[MM] saveCustomName failed:', err);
  }
}

/**
 * Delete a session and all its events from SQLite (REQ-7).
 * #2748 ST-2: also deletes the session's `session_names` row (no orphans).
 * #2762 ST-5 (R-9): also deletes the CHILD sessions' event rows discovered
 * from the root's persisted `childSessionId` links, and marks each child key
 * deleted — the deleted-session non-resurrection guard extends to child keys.
 *
 * Calls markSessionDeleted BEFORE any SQLite operations so that concurrent
 * persistDelivery calls see the deletion immediately via the module-level set.
 */
export async function deleteSessionFromStore(sessionId: string): Promise<void> {
  try {
    // Mark deleted FIRST — before SQLite ops — to close the race window
    markSessionDeleted(sessionId);

    // #2748 FIX-1: tables must exist before deletes below.
    await ensureMmTables();

    // #2762 ST-5: discover the child session ids from the root's persisted
    // events BEFORE deleting them — the childSessionId join lives in the
    // root's task-span payloads, so this is the last chance to resolve it.
    const rootRows = await featureStoreQuery({
      featureId: MM_FEATURE_ID,
      tableName: MM_EVENTS_TABLE,
      whereCols: { session_id: sessionId },
    });
    const childIds = childSessionIdsFromRows(rootRows);

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
    await featureStoreDelete({
      featureId: MM_FEATURE_ID,
      tableName: MM_SESSION_NAMES_TABLE,
      whereCols: { session_id: sessionId },
    });

    // Ordered async: delete each child key's rows and mark it deleted so
    // concurrent child persistDelivery calls cannot resurrect it (REQ-3 for
    // child keys). Child rows are keyed by the CHILD id — invisible to the
    // root deletes above. Tombstones are recorded for the root AND every
    // discovered child (RTDB replay must never resurrect either after a
    // restart — P4.3).
    await recordSessionDeleted(sessionId);
    for (const childId of childIds) {
      markSessionDeleted(childId);
      await featureStoreDelete({
        featureId: MM_FEATURE_ID,
        tableName: MM_EVENTS_TABLE,
        whereCols: { session_id: childId },
      });
      await recordSessionDeleted(childId);
    }
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
      // #2762 ST-5: discover + remove the pruned session's CHILD event rows
      // too — they are keyed by the child's own id, invisible to the
      // session-keyed deletes below (no orphaned child rows).
      const prunedRows = await featureStoreQuery({
        featureId: MM_FEATURE_ID,
        tableName: MM_EVENTS_TABLE,
        whereCols: { session_id: sid },
      });
      const childIds = childSessionIdsFromRows(prunedRows);
      for (const childId of childIds) {
        await featureStoreDelete({
          featureId: MM_FEATURE_ID,
          tableName: MM_EVENTS_TABLE,
          whereCols: { session_id: childId },
        });
      }
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
      // #2748 ST-2: prune the session_names row too (no orphans).
      await featureStoreDelete({
        featureId: MM_FEATURE_ID,
        tableName: MM_SESSION_NAMES_TABLE,
        whereCols: { session_id: sid },
      });
    }
  }
}

/** Convert a FeatureStore row to MissionMonitorSession. */
function rowToSession(
  row: FeatureStoreRow,
  namesById: Map<string, SessionNameRow> = new Map(),
): MissionMonitorSession | null {
  const r = row as Record<string, unknown>;
  const sessionId = r['session_id'] as string | undefined;
  if (!sessionId) return null;

  const startTimeStr = r['start_time'] as string | undefined;
  const startTime = startTimeStr ? new Date(startTimeStr).getTime() : Date.now();

  const nameRow = namesById.get(sessionId);
  const session: MissionMonitorSession = {
    sessionId,
    label: (r['label'] as string) ?? new Date(startTime).toLocaleString(),
    startTime,
    latestTimestamp: (r['start_time'] as string) ?? new Date().toISOString(),
    deliveryCount: (typeof r['delivery_count'] === 'number' ? r['delivery_count'] : 0),
  };
  if (nameRow?.derived_name) session.derivedName = nameRow.derived_name;
  if (nameRow?.custom_name) session.customName = nameRow.custom_name;
  return session;
}
