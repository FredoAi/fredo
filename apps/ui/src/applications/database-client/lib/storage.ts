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
  DbClientLayoutPrefs,
  DbClientPrefs,
  DbClientSplitId,
  DbConnectionView,
  QueryHistoryEntry,
  SavedQuery,
} from './types';

// ── Persistence key contract (frozen by the plan's Names Block) ──────────────

export const DBCLIENT_CONNECTIONS_KEY = 'Fredo_dbclient_connections';
export const DBCLIENT_HISTORY_KEY_PREFIX = 'Fredo_dbclient_history_';
export const DBCLIENT_SAVED_QUERIES_KEY_PREFIX = 'Fredo_dbclient_saved_queries_';
export const DBCLIENT_PREFS_KEY = 'Fredo_dbclient_prefs';
/**
 * Spec #3049: SQL-Studio split sizes live in their OWN document, deliberately
 * SEPARATE from `DBCLIENT_PREFS_KEY`, so the settings panel's whole-document
 * `savePrefs` can never wipe the layout (and vice-versa).
 */
export const DBCLIENT_LAYOUT_KEY = 'Fredo_dbclient_layout';

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

// ── SQL Studio layout (Spec #3049, ST-1) ──────────────────────────────────────

/**
 * Tier-1 (stored) clamp bounds, in integer CSS px. `DBCLIENT_LAYOUT_LIMITS`
 * bounds the PERSISTED value — never write outside it. The consuming component
 * (ST-3) additionally applies a container-aware tier-2 `effectiveMax` at drag /
 * restore time so a split can never hide the workspace; the storage layer only
 * enforces these static bounds.
 */
export const DBCLIENT_LAYOUT_LIMITS: Record<DbClientSplitId, { min: number; max: number }> = {
  leftSidebarWidth: { min: 220, max: 560 },
  rightSidebarWidth: { min: 200, max: 520 },
  editorResultsHeight: { min: 120, max: 720 },
  connectionsSchemaHeight: { min: 120, max: 560 },
};

/**
 * Defaults chosen to preserve the shipped look (left 300 / right 280), so a
 * first run with no stored layout is visually unchanged.
 */
export const DEFAULT_DB_CLIENT_LAYOUT: DbClientLayoutPrefs = {
  leftSidebarWidth: 300,
  rightSidebarWidth: 280,
  editorResultsHeight: 220,
  connectionsSchemaHeight: 220,
};

// ── Tier-2 (container-floor) constants (Spec #3049) ──────────────────────────
//
// These are the container-aware floors the consuming component uses to derive
// the live `effectiveMax` (the workspace/pane floor WINS when the container is
// too small to honour both static mins). They are NOT applied by the storage
// clamp — the stored value is only ever bounded by `DBCLIENT_LAYOUT_LIMITS`.

/** Minimum visible central-workspace width (px) — tier-2 floor for S1/S2. */
export const WORKSPACE_MIN = 320;
/** Minimum visible results-region height (px) — tier-2 floor for S3. */
export const RESULTS_MIN = 120;
/** Minimum visible schema/editor-region height (px) — tier-2 floor for S4. */
export const EDITOR_MIN = 120;

/**
 * Clamp one stored/committed split value into `[min, max]`, rounding to integer
 * px. Non-finite (NaN/Infinity/non-number/absent) input degrades to `fallback`.
 * Mirrors `clampPref` (`components/DatabaseClientSettings.tsx`) semantics.
 */
function clampLayoutValue(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const finite = numberOr(value, fallback);
  return Math.min(max, Math.max(min, Math.trunc(finite)));
}

/**
 * Tolerant deserializer for the persisted layout document (mirrors `parsePrefs`):
 * a corrupt/absent document, a non-object document, or any non-finite/absent
 * field degrades to that split's default; an out-of-range finite value is
 * clamped to `DBCLIENT_LAYOUT_LIMITS`. Always returns a fresh, fully-populated,
 * integer-px document.
 */
export function parseDbClientLayout(raw: string): DbClientLayoutPrefs {
  let parsed: Partial<DbClientLayoutPrefs> | null = null;
  try {
    const candidate: unknown = JSON.parse(raw);
    if (candidate != null && typeof candidate === 'object') {
      parsed = candidate as Partial<DbClientLayoutPrefs>;
    }
  } catch {
    /* corrupt — fall through to defaults */
  }

  return {
    leftSidebarWidth: clampLayoutValue(
      parsed?.leftSidebarWidth,
      DBCLIENT_LAYOUT_LIMITS.leftSidebarWidth.min,
      DBCLIENT_LAYOUT_LIMITS.leftSidebarWidth.max,
      DEFAULT_DB_CLIENT_LAYOUT.leftSidebarWidth,
    ),
    rightSidebarWidth: clampLayoutValue(
      parsed?.rightSidebarWidth,
      DBCLIENT_LAYOUT_LIMITS.rightSidebarWidth.min,
      DBCLIENT_LAYOUT_LIMITS.rightSidebarWidth.max,
      DEFAULT_DB_CLIENT_LAYOUT.rightSidebarWidth,
    ),
    editorResultsHeight: clampLayoutValue(
      parsed?.editorResultsHeight,
      DBCLIENT_LAYOUT_LIMITS.editorResultsHeight.min,
      DBCLIENT_LAYOUT_LIMITS.editorResultsHeight.max,
      DEFAULT_DB_CLIENT_LAYOUT.editorResultsHeight,
    ),
    connectionsSchemaHeight: clampLayoutValue(
      parsed?.connectionsSchemaHeight,
      DBCLIENT_LAYOUT_LIMITS.connectionsSchemaHeight.min,
      DBCLIENT_LAYOUT_LIMITS.connectionsSchemaHeight.max,
      DEFAULT_DB_CLIENT_LAYOUT.connectionsSchemaHeight,
    ),
  };
}

export async function loadLayout(): Promise<DbClientLayoutPrefs> {
  return settingsService.get<DbClientLayoutPrefs>(
    DBCLIENT_LAYOUT_KEY,
    { ...DEFAULT_DB_CLIENT_LAYOUT },
    parseDbClientLayout,
  );
}

export async function saveLayout(layout: DbClientLayoutPrefs): Promise<void> {
  await settingsService.set(DBCLIENT_LAYOUT_KEY, JSON.stringify(layout));
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
