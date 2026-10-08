/**
 * Postgres client persistence (Spec #2950, ST-1).
 *
 * The single persistence seam for connection metadata, per-connection history,
 * saved queries and client preferences. Every read/write goes through
 * `settingsService` → AppStore KV. **No secret ever enters this store** — the
 * password lives only in the OS keychain (ST-2).
 *
 * Tolerant by contract (R-4.5): absent or corrupt documents degrade to an empty
 * list / the default prefs rather than failing the connection view.
 */

import { settingsService } from '../../settings';
import type {
  DbClientPrefs,
  DbConnectionView,
  QueryHistoryEntry,
  SavedQuery,
} from './types';

// ── Persistence key contract (frozen by the plan's Names Block) ──────────────

export const DBCLIENT_CONNECTIONS_KEY = 'Fredo_dbclient_connections';
export const DBCLIENT_HISTORY_KEY_PREFIX = 'Fredo_dbclient_history_';
export const DBCLIENT_SAVED_QUERIES_KEY_PREFIX = 'Fredo_dbclient_saved_queries_';
export const DBCLIENT_PREFS_KEY = 'Fredo_dbclient_prefs';

/** History is bounded to the 200 newest entries (R-4.1). */
export const DBCLIENT_HISTORY_MAX_ENTRIES = 200;

/** Defaults (PO decisions: default row limit 100, page size 100). */
export const DEFAULT_DB_CLIENT_PREFS: DbClientPrefs = {
  defaultRowLimit: 100,
  pageSize: 100,
  confirmDestructive: true,
};

/** History document key for one connection. */
export function historyKey(connectionId: string): string {
  return `${DBCLIENT_HISTORY_KEY_PREFIX}${connectionId}`;
}

/** Saved-queries document key for one connection. */
export function savedQueriesKey(connectionId: string): string {
  return `${DBCLIENT_SAVED_QUERIES_KEY_PREFIX}${connectionId}`;
}

// ── Tolerant deserializers ────────────────────────────────────────────────────

function parseArray<T>(raw: string): T[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function parsePrefs(raw: string): DbClientPrefs {
  try {
    const parsed = JSON.parse(raw) as Partial<DbClientPrefs> | null;
    if (parsed != null && typeof parsed === 'object') {
      return {
        defaultRowLimit: numberOr(
          parsed.defaultRowLimit,
          DEFAULT_DB_CLIENT_PREFS.defaultRowLimit,
        ),
        pageSize: numberOr(parsed.pageSize, DEFAULT_DB_CLIENT_PREFS.pageSize),
        confirmDestructive:
          typeof parsed.confirmDestructive === 'boolean'
            ? parsed.confirmDestructive
            : DEFAULT_DB_CLIENT_PREFS.confirmDestructive,
      };
    }
  } catch {
    /* corrupt — fall through to defaults */
  }
  return { ...DEFAULT_DB_CLIENT_PREFS };
}

// ── Connections ───────────────────────────────────────────────────────────────

export async function loadConnections(): Promise<DbConnectionView[]> {
  return settingsService.get<DbConnectionView[]>(
    DBCLIENT_CONNECTIONS_KEY,
    [],
    (raw) => parseArray<DbConnectionView>(raw),
  );
}

export async function saveConnections(connections: DbConnectionView[]): Promise<void> {
  await settingsService.set(DBCLIENT_CONNECTIONS_KEY, JSON.stringify(connections));
}

// ── Preferences ───────────────────────────────────────────────────────────────

export async function loadPrefs(): Promise<DbClientPrefs> {
  return settingsService.get<DbClientPrefs>(
    DBCLIENT_PREFS_KEY,
    { ...DEFAULT_DB_CLIENT_PREFS },
    parsePrefs,
  );
}

export async function savePrefs(prefs: DbClientPrefs): Promise<void> {
  await settingsService.set(DBCLIENT_PREFS_KEY, JSON.stringify(prefs));
}

// ── History (bounded, newest first) ───────────────────────────────────────────

export async function loadHistory(connectionId: string): Promise<QueryHistoryEntry[]> {
  const entries = await settingsService.get<QueryHistoryEntry[]>(
    historyKey(connectionId),
    [],
    (raw) => parseArray<QueryHistoryEntry>(raw),
  );
  return entries.slice(0, DBCLIENT_HISTORY_MAX_ENTRIES);
}

export async function saveHistory(
  connectionId: string,
  entries: QueryHistoryEntry[],
): Promise<void> {
  await settingsService.set(
    historyKey(connectionId),
    JSON.stringify(entries.slice(0, DBCLIENT_HISTORY_MAX_ENTRIES)),
  );
}

/** Prepend an entry (newest first) and clamp to the 200-entry bound (R-4.1). */
export async function appendHistory(
  connectionId: string,
  entry: QueryHistoryEntry,
): Promise<QueryHistoryEntry[]> {
  const current = await loadHistory(connectionId);
  const next = [entry, ...current].slice(0, DBCLIENT_HISTORY_MAX_ENTRIES);
  await saveHistory(connectionId, next);
  return next;
}

// ── Saved queries ─────────────────────────────────────────────────────────────

export async function loadSavedQueries(connectionId: string): Promise<SavedQuery[]> {
  return settingsService.get<SavedQuery[]>(
    savedQueriesKey(connectionId),
    [],
    (raw) => parseArray<SavedQuery>(raw),
  );
}

export async function saveSavedQueries(
  connectionId: string,
  queries: SavedQuery[],
): Promise<void> {
  await settingsService.set(savedQueriesKey(connectionId), JSON.stringify(queries));
}

// ── Connection teardown (R-1.7) ───────────────────────────────────────────────

/** Remove the per-connection history and saved-query documents. */
export async function clearConnectionData(connectionId: string): Promise<void> {
  await Promise.all([
    settingsService.remove(historyKey(connectionId)),
    settingsService.remove(savedQueriesKey(connectionId)),
  ]);
}
