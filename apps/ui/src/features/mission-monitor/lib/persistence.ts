/**
 * persistence.ts — Mission Monitor SQLite persistence layer.
 *
 * Uses the generic FeatureStore IPC client to persist sessions and deliveries
 * to the `feature_mission_monitor_sessions`, `feature_mission_monitor_events`,
 * and `feature_mission_monitor_session_names` tables. Replaces the old
 * localStorage-based sessionStorage.ts.
 *
 * ── Table naming (#2748 FIX-1) ───────────────────────────────────────────────
 * The backend namespaces FeatureStore tables as `feature_{featureId}_{tableName}`
 * with the featureId's hyphens sanitized to underscores (feature_store.rs
 * `full_table_name`) — so `featureId: 'mission-monitor'` + `tableName:
 * 'session_names'` physically materializes as `feature_mission_monitor_session_names`.
 * The round-1 console warning `no such table: feature_mission_monitor_session_names`
 * was the CORRECT name — the table simply had not been created yet when the
 * load query ran (see the init-order guard below).
 *
 * ── Caps ─────────────────────────────────────────────────────────────────────
 * - 50 sessions max (prunes oldest when exceeded)
 * - 500 events per session max (prunes oldest when exceeded)
 *
 * ── Edge Cases ───────────────────────────────────────────────────────────────
 * - Deleted session deliveries are silently ignored (no resurrection)
 * - Corrupted delivery payloads caught by try/catch
 * - Table creation is idempotent (CREATE TABLE IF NOT EXISTS)
 *
 * ── #2762 ST-5: child-delivery persistence (R-7 sidebar / R-9 restore) ──────
 * `subagent-tool-activity` deliveries are persisted as EVENT ROWS ONLY —
 * `persistDelivery` never creates a sessions-table row for a child key (the
 * generic upsert keyed by `deliverySessionId` would surface child sessions in
 * the sidebar after restart, violating R-7). #2770 round 6 (R-8): since the
 * ECE composites child events under the PARENT composite key (Spec #523), the
 * persisted row's `session_id` is whichever COMPOSITE PARENT the delivery was
 * re-keyed under at persist time — an ancestor in the delegation tree, not
 * the child's own id (verified on the real corpus: 58 root-keyed, 5 L1-keyed,
 * 3 L2-keyed rows; ZERO keyed by the depth-3 session id). The child→root link
 * is not stored separately: the root's own persisted task-span payloads carry
 * `childSessionId`, so the restore path (`loadPersistedChildDeliveries`)
 * discovers child keys by scanning the root's rows breadth-first (root →
 * child → grandchild …) and loads each child's `subagent-tool-activity` rows
 * regardless of which composite-parent `session_id` they were persisted under
 * (matched by the child's own session id, the row's
 * `compositedChildSessionId` stamp, or the row corrId's session prefix).
 * Deleting a root session deletes its discovered child rows and marks the
 * child keys deleted (the deleted-session non-resurrection guard extends to
 * child keys, R-9).
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
import { deliverySessionId, extractDeliveryPayload, isChatNodeDelivery } from './graph';

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
const MM_SESSION_NAMES_TABLE = 'session_names';
const MM_MAX_SESSIONS = 50;
const MM_MAX_DELIVERIES_PER_SESSION = 500;

// ── #2762 ST-5: child-delivery identification + child-key discovery ─────────

/** Contract name of the nested subagent-activity contract (#2762 plan API
 *  Contracts — binding). #2770 round 6 (R-8): deliveries under this contract
 *  are NOT reliably keyed by the child session's own id — the ECE composites
 *  child events under the parent composite key (Spec #523), so the persisted
 *  `session_id` is the composite parent. Restore matching therefore keys on
 *  the CHILD identity (own id / stamp / corrId prefix), not the row's
 *  `session_id` alone. */
export const SUBAGENT_TOOL_ACTIVITY_CONTRACT = 'subagent-tool-activity';

/** True when a delivery belongs to the nested subagent-activity contract —
 *  i.e. it carries CHILD-session tool activity and must never create a
 *  sessions table row (R-7 sidebar guard). */
export function isSubagentToolActivityDelivery(d: ContractDelivery): boolean {
  return d.contractName === SUBAGENT_TOOL_ACTIVITY_CONTRACT;
}

/**
 * #2770 round 6 (R-8): does this persisted `subagent-tool-activity` row
 * belong to the given CHILD session, regardless of which composite-parent
 * `session_id` the row was persisted under? Three match rules (query-side —
 * no schema change):
 * 1. the row's own key sessionId IS the child (legacy child-keyed rows);
 * 2. the outer payload's `compositedChildSessionId` stamp names the child
 *    (the ECE's compositing marker — including historical mis-stamps, which
 *    the graph builder re-buckets by corrId prefix anyway);
 * 3. the row's key correlationId is the child's session prefix
 *    (`<childId>_<counter>` — the adapter's per-turn corrId shape).
 */
function childRowMatchesSession(d: ContractDelivery, childId: string): boolean {
  if (deliverySessionId(d) === childId) return true;
  if (d.payload?.['compositedChildSessionId'] === childId) return true;
  const corr = d.key?.['correlationId'];
  return typeof corr === 'string' && (corr === childId || corr.startsWith(`${childId}_`));
}

/**
 * Extract the distinct `childSessionId` links from a batch of deliveries.
 *
 * The root's persisted `task` tool-span payloads carry the flat
 * `childSessionId` projection (SubagentNodePayload join key, #2762 plan API
 * Contracts), and a child's own `task` spans carry the grandchild links — so
 * scanning any session's rows yields the NEXT delegation depth. Delivery
 * order is irrelevant (each distinct id appears once, first occurrence wins).
 */
export function childSessionIdsFromDeliveries(deliveries: ContractDelivery[]): string[] {
  const ids: string[] = [];
  for (const d of deliveries) {
    const payload = extractDeliveryPayload(d);
    const child = payload['childSessionId'];
    if (typeof child === 'string' && child.length > 0 && !ids.includes(child)) {
      ids.push(child);
    }
  }
  return ids;
}

// ── #2748 FIX-1: table-init order guard ──────────────────────────────────────
// Round-1 regression: on mount the hook's `loadPersistedSessions()` effect is
// registered BEFORE the panel's `initMmTables()` effect (the hook runs first
// inside `useDeliverySessions()`), so the `session_names` query dispatched to
// the backend before the CREATE TABLE landed →
// `[FeatureStore] query failed: no such table: feature_mission_monitor_session_names`
// → persisted sessions restored WITHOUT their derived_name (AC1 fail) + the
// console warning (NFR fail).
//
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

interface PersistedDelivery {
  delivery_id: string;
  session_id: string;
  contract_name: string;
  lifecycle: string;
  payload_json: string;
  timestamp: string;
  key_json: string;
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
  ]);
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
 * Load persisted deliveries for a specific session, ordered by timestamp ASC.
 */
export async function loadPersistedDeliveries(sessionId: string): Promise<ContractDelivery[]> {
  // #2748 FIX-1: the events table must exist before it is queried.
  await ensureMmTables();

  const rows = await featureStoreQuery({
    featureId: MM_FEATURE_ID,
    tableName: MM_EVENTS_TABLE,
    whereCols: { session_id: sessionId },
    orderBy: 'timestamp ASC',
  });

  return rows.map(rowToDelivery).filter(Boolean) as ContractDelivery[];
}

/**
 * #2762 ST-5 (R-9): load the CHILD-session deliveries for a root session's
 * nested graph, so a restored session replays its full delegation tree.
 *
 * The child→root relation is recovered from the already-loaded root
 * deliveries: every payload carrying `childSessionId` names a child session
 * whose `subagent-tool-activity` rows are then loaded. Child rows carry their
 * own nested `childSessionId` links (the grandchild's dispatch spans), so the
 * discovery is breadth-first — root → child → grandchild — until fixpoint,
 * covering delegation trees at ANY depth (R-4).
 *
 * #2770 round 6 (R-8): a child's rows are matched by CHILD IDENTITY
 * (`childRowMatchesSession`), not by the row's `session_id` — post-#523 the
 * rows are persisted under whichever composite-parent key the ECE had
 * re-keyed the delivery to at persist time (an ancestor in the delegation
 * tree; the real corpus has ZERO rows keyed by the depth-3 session id). The
 * candidate `session_id` keys queried are the child's own id plus every
 * composite-parent key discovered so far (the root + previously visited
 * children) — each key is queried at most once per restore (cached), so the
 * BFS stays O(distinct keys) queries.
 *
 * - Deleted-session non-resurrection extends to child keys: deleted child ids
 *   (and deleted roots) yield no rows.
 * - Rows already present in the root feed (same delivery id — a root-keyed
 *   composited copy) are skipped, never duplicated into the merged replay.
 * - A row is claimed by at most one child per restore (first match wins) so
 *   two children can never double-claim one row.
 * - Ordered async: each candidate key is queried with `await` inside the loop
 *   (AGENTS.md ordered-persistence rule) and the result is sorted by
 *   timestamp ASC so the incremental builder replays in dispatch order.
 *
 * @param rootSessionId  The selected root session's id (deleted-guard key).
 * @param rootDeliveries The root's already-loaded deliveries (from
 *   `loadPersistedDeliveries`) — scanned for `childSessionId` links, so the
 *   root rows are NOT queried twice.
 */
export async function loadPersistedChildDeliveries(
  rootSessionId: string,
  rootDeliveries: ContractDelivery[],
): Promise<ContractDelivery[]> {
  await ensureMmTables();
  if (isSessionDeleted(rootSessionId)) return [];

  const collected: ContractDelivery[] = [];
  const visited = new Set<string>();
  // Delivery ids already present in the root feed — never re-collected.
  const rootDeliveryIds = new Set(rootDeliveries.map((d) => d.id));
  // Composite-parent keys queried so far (rows for a given session_id are
  // fetched at most once per restore — the BFS claims rows from the cache).
  const rowsByKey = new Map<string, ContractDelivery[]>();
  // Delivery ids attributed to a child this restore (no double claims).
  const claimed = new Set<string>();

  const loadRowsByKey = async (key: string): Promise<ContractDelivery[]> => {
    let rows = rowsByKey.get(key);
    if (!rows) {
      const fetched = await featureStoreQuery({
        featureId: MM_FEATURE_ID,
        tableName: MM_EVENTS_TABLE,
        whereCols: {
          session_id: key,
          contract_name: SUBAGENT_TOOL_ACTIVITY_CONTRACT,
        },
        orderBy: 'timestamp ASC',
      });
      rows = fetched.map(rowToDelivery).filter(Boolean) as ContractDelivery[];
      rowsByKey.set(key, rows);
    }
    return rows;
  };

  let frontier = childSessionIdsFromDeliveries(rootDeliveries);
  while (frontier.length > 0) {
    const nextFrontier: string[] = [];
    for (const childId of frontier) {
      if (visited.has(childId) || isSessionDeleted(childId)) continue;
      visited.add(childId);

      // Candidate composite-parent keys: the child's own id (rule 1 above) +
      // the root + every previously visited child (the ancestors a composited
      // row can be keyed under). Cached — each key queried once per restore.
      const childRows: ContractDelivery[] = [];
      const candidateKeys = [childId, rootSessionId, ...visited];
      for (const key of candidateKeys) {
        const rows = await loadRowsByKey(key);
        for (const d of rows) {
          if (claimed.has(d.id) || rootDeliveryIds.has(d.id)) continue;
          if (childRowMatchesSession(d, childId)) {
            claimed.add(d.id);
            childRows.push(d);
          }
        }
      }
      collected.push(...childRows);

      for (const grandchildId of childSessionIdsFromDeliveries(childRows)) {
        if (!visited.has(grandchildId)) nextFrontier.push(grandchildId);
      }
    }
    frontier = nextFrontier;
  }

  collected.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return collected;
}

// ── ST11: shrink-safe incremental delivery watermark ─────────────────────────
//
// The StreamContext `deliveries` array is TTL-shrunk from the front
// (CLEANUP_EXPIRED_EVENTS, DELIVERY_TTL_MS=300s, 60s sweep). A naive count
// cursor (`slice(prevCount)`) goes stale the moment the array shrinks below it:
// deliveries appended afterwards land at indices below the old cursor and are
// silently skipped (round-6 signature: 5 spans → 2 rows → 1 node).
//
// This watermark pairs a count cursor with a Set of already-emitted delivery
// ids. On shrink detection (`deliveries.length < cursor`) the cursor resets to
// 0 and the delta is re-derived by scanning the current array for ids not yet
// in the seen set. The seen set makes the re-scan idempotent:
//   - already-persisted deliveries are never re-emitted (sessions.delivery_count
//     never inflates — `persistDelivery` increments it per call),
//   - duplicate delivery ids in the input are never double-emitted.
// The normal growing path stays O(delta) (a slice + Set lookups) — no full
// rebuild per delivery.

export interface DeliveryWatermarkState {
  cursor: number;
  seenIds: Set<string>;
}

export function createDeliveryWatermark(): DeliveryWatermarkState {
  return { cursor: 0, seenIds: new Set() };
}

/**
 * Return the deliveries that have not yet been handed out to the consumer,
 * advancing the watermark. Idempotent under TTL shrink and duplicate ids.
 */
export function nextUnseenDeliveries(
  deliveries: ContractDelivery[],
  state: DeliveryWatermarkState,
): ContractDelivery[] {
  if (deliveries.length < state.cursor) {
    state.cursor = 0; // TTL shrink below the cursor — reset, re-scan from the front
  }
  if (deliveries.length <= state.cursor) return [];
  const slice = deliveries.slice(state.cursor);
  state.cursor = deliveries.length;
  const unseen = slice.filter((d) => !state.seenIds.has(d.id));
  for (const d of unseen) state.seenIds.add(d.id);
  return unseen;
}

/**
 * Persist a single delivery to SQLite.
 *
 * - If the session was deleted (checked via module-level set), the delivery is
 *   silently ignored (REQ-3: prevent resurrection).
 * - Session record uses atomic UPDATE instead of delete+insert to prevent
 *   race-condition re-insertion of deleted sessions.
 * - First-time deliveries create an initial session row.
 * - #2762 ST-5: `subagent-tool-activity` (child-session) deliveries bypass the
 *   sessions-table upsert entirely — event row only (R-7 sidebar guard).
 * - Delivery is deduplicated by delivery_id.
 * - Caps are enforced after each insertion.
 */
export async function persistDelivery(delivery: ContractDelivery): Promise<void> {
  try {
    const sessionId = deliverySessionId(delivery);
    if (!sessionId) return;

    // #2762 ST-5 (R-7 sidebar guard): `subagent-tool-activity` deliveries are
    // keyed by the CHILD session's own id. They are persisted as EVENT ROWS
    // ONLY — the generic sessions-table upsert below (keyed by
    // `deliverySessionId`) would otherwise create sidebar session rows for
    // child keys that surface after restart, violating R-7.
    const isChildActivity = isSubagentToolActivityDelivery(delivery);

    // REQ-3: Skip if session was explicitly deleted (module-level tracking).
    // For child deliveries the tracked key is the CHILD session id — the
    // non-resurrection guard extends to child keys (R-9).
    if (isSessionDeleted(sessionId)) return;

    // #2748 FIX-1: tables must exist before the sessions query / inserts below.
    await ensureMmTables();

    const sessionTs = new Date(delivery.timestamp).getTime();

    if (isChildActivity) {
      // Child path: insert the event row keyed by the child session id, cap
      // the child key's rows, and return — NO sessions-table row, NO
      // session_names/derived-name capture, NO session cap (child keys never
      // appear in the sidebar, live or restored).
      await featureStoreInsert({
        featureId: MM_FEATURE_ID,
        tableName: MM_EVENTS_TABLE,
        rows: [{
          delivery_id: delivery.id,
          session_id: sessionId,
          contract_name: delivery.contractName,
          lifecycle: delivery.lifecycle,
          payload_json: safeStringify(delivery.payload),
          timestamp: delivery.timestamp,
          key_json: safeStringify(delivery.key),
        }],
      });
      await enforceEventCap(sessionId);
      return;
    }

    // Check if session exists in SQLite
    const existingSessions = await featureStoreQuery({
      featureId: MM_FEATURE_ID,
      tableName: MM_SESSIONS_TABLE,
      whereCols: { session_id: sessionId },
    });

    if (existingSessions.length > 0) {
      // ── Spec #2768 (ST-5): replay dedupe — an already-stored delivery is a
      // full no-op ──────────────────────────────────────────────────────────
      // Two producers can hand this function a delivery id it has already
      // stored for an existing session:
      // 1. mount-time contract hydration (ST-5) replays backend-store rows
      //    under their ORIGINAL delivery ids into StreamContext, and the
      //    panel's persist effect forwards every StreamContext delivery not
      //    yet seen this mount;
      // 2. a panel remount re-scans StreamContext deliveries still within TTL
      //    that were persisted during the previous mount (fresh watermark).
      // The events table itself dedupes by delivery_id (PK), but the atomic
      // UPDATE below would still increment `delivery_count` per call —
      // inflating the sidebar count. Skip everything when the row exists: the
      // count was already counted, the payload already stored, the derived
      // name already captured. (The same guarantee the shrink-safe watermark
      // documents within one mount lifetime — extended across mounts and
      // hydration replay.)
      const alreadyStored = await featureStoreQuery({
        featureId: MM_FEATURE_ID,
        tableName: MM_EVENTS_TABLE,
        whereCols: { delivery_id: delivery.id },
      });
      if (alreadyStored.length > 0) return;

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

    // #2748 ST-2 (R-1): write-time derived-name capture. The first non-empty
    // user chat message becomes the session's derived_name so it survives
    // panel close/reopen AND app restart. Read-guard race class below — the
    // benign first-non-empty-wins race is documented: `custom_name` is
    // authoritative over `derived_name`.
    await captureDerivedName(sessionId, delivery);

    // Enforce caps
    await enforceSessionCap();
    await enforceEventCap(sessionId);
  } catch (err) {
    console.warn('[MM] persistDelivery failed:', err);
  }
}

/**
 * #2748 ST-2 (R-1): persist the first non-empty user chat message as the
 * session's derived_name.
 *
 * Runs on every persisted chat-node delivery. Uses the same read-guard race
 * class as the `delivery_count` update above (query → UPDATE; INSERT when the
 * session_names row does not exist yet, e.g. sessions persisted before #2748).
 * First-non-empty-wins is a benign race — any captured value is a valid
 * fallback label, and `custom_name` (set by the user) is authoritative.
 */
async function captureDerivedName(sessionId: string, delivery: ContractDelivery): Promise<void> {
  if (!isChatNodeDelivery(delivery)) return;

  const payload = extractDeliveryPayload(delivery);
  const userMessage = typeof payload['userMessage'] === 'string' ? (payload['userMessage'] as string).trim() : '';
  if (!userMessage) return;

  // Read-guard: only capture when derived_name is currently empty (NULL or '').
  const existing = await featureStoreQuery({
    featureId: MM_FEATURE_ID,
    tableName: MM_SESSION_NAMES_TABLE,
    whereCols: { session_id: sessionId },
  });

  if (existing.length > 0) {
    const row = existing[0] as Record<string, unknown>;
    const existingDerived = typeof row['derived_name'] === 'string' ? (row['derived_name'] as string) : '';
    if (existingDerived) return; // first-non-empty-wins — never overwrite

    await featureStoreUpdate({
      featureId: MM_FEATURE_ID,
      tableName: MM_SESSION_NAMES_TABLE,
      setCols: { derived_name: userMessage },
      whereCols: { session_id: sessionId },
    });
  } else {
    // No session_names row yet (legacy session or first chat delivery) — INSERT.
    await featureStoreInsert({
      featureId: MM_FEATURE_ID,
      tableName: MM_SESSION_NAMES_TABLE,
      rows: [{
        session_id: sessionId,
        custom_name: null,
        derived_name: userMessage,
      }],
    });
  }
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
    const childIds = childSessionIdsFromDeliveries(
      rootRows.map(rowToDelivery).filter(Boolean) as ContractDelivery[],
    );

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
    // root deletes above.
    for (const childId of childIds) {
      markSessionDeleted(childId);
      await featureStoreDelete({
        featureId: MM_FEATURE_ID,
        tableName: MM_EVENTS_TABLE,
        whereCols: { session_id: childId },
      });
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
      const childIds = childSessionIdsFromDeliveries(
        prunedRows.map(rowToDelivery).filter(Boolean) as ContractDelivery[],
      );
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
