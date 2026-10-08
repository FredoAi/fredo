/**
 * applicationStore.ts — Generic ApplicationStore IPC client.
 *
 * Wraps adapterBridge.invoke() for each ApplicationStore command registered
 * in the Rust backend. All applications share this single client.
 *
 * ── Contract ─────────────────────────────────────────────────────────────────
 * See .opencode/tmp/contract-339.ts for full type definitions.
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 * ```ts
 * import { applicationStoreInsert } from '../../shared/lib/applicationStore';
 * await applicationStoreEnsureTable({ featureId: 'mission-monitor', tableName: 'sessions', columns: [...] });
 * ```
 */
import { adapterBridge } from '../utils/adapterBridge';

// ── Type-level contract (mirrors .opencode/tmp/contract-339.ts) ──────────────

export type ApplicationStoreColumnType = 'TEXT' | 'INTEGER' | 'REAL' | 'BLOB';

export interface ApplicationStoreColumnDef {
  name: string;
  colType: ApplicationStoreColumnType;
  nullable?: boolean;
  primaryKey?: boolean;
}

export interface ApplicationStoreEnsureTableArgs {
  featureId: string;
  tableName: string;
  columns: ApplicationStoreColumnDef[];
}

export interface ApplicationStoreInsertArgs {
  featureId: string;
  tableName: string;
  rows: Record<string, unknown>[];
}

export interface ApplicationStoreQueryArgs {
  featureId: string;
  tableName: string;
  whereCols?: Record<string, unknown>;
  orderBy?: string;
  limit?: number;
}

export interface ApplicationStoreUpdateArgs {
  featureId: string;
  tableName: string;
  setCols: Record<string, unknown>;
  whereCols: Record<string, unknown>;
}

export interface ApplicationStoreDeleteArgs {
  featureId: string;
  tableName: string;
  whereCols: Record<string, unknown>;
}

export interface ApplicationStoreRow {
  [column: string]: unknown;
}

// ── IPC wrappers ─────────────────────────────────────────────────────────────

/** REQ-1: Ensure a namespaced table exists. */
export async function applicationStoreEnsureTable(
  args: ApplicationStoreEnsureTableArgs,
): Promise<void> {
  try {
    await adapterBridge.invoke('application_store_ensure_table', args as unknown as Record<string, unknown>);
  } catch (err) {
    console.warn('[ApplicationStore] ensureTable failed:', err);
  }
}

/** REQ-2: Insert rows into a namespaced table. Returns count of inserted rows. */
export async function applicationStoreInsert(
  args: ApplicationStoreInsertArgs,
): Promise<number> {
  try {
    const result = await adapterBridge.invoke<number>('application_store_insert', args as unknown as Record<string, unknown>);
    return result ?? 0;
  } catch (err) {
    console.warn('[ApplicationStore] insert failed:', err);
    return 0;
  }
}

/** REQ-3: Query rows from a namespaced table. */
export async function applicationStoreQuery(
  args: ApplicationStoreQueryArgs,
): Promise<ApplicationStoreRow[]> {
  try {
    const result = await adapterBridge.invoke<ApplicationStoreRow[]>('application_store_query', args as unknown as Record<string, unknown>);
    return result ?? [];
  } catch (err) {
    console.warn('[ApplicationStore] query failed:', err);
    return [];
  }
}

/** REQ-4: Update rows in a namespaced table. Returns count of updated rows. */
export async function applicationStoreUpdate(
  args: ApplicationStoreUpdateArgs,
): Promise<number> {
  try {
    const result = await adapterBridge.invoke<number>('application_store_update', args as unknown as Record<string, unknown>);
    return result ?? 0;
  } catch (err) {
    console.warn('[ApplicationStore] update failed:', err);
    return 0;
  }
}

/** REQ-5: Delete rows from a namespaced table. Returns count of deleted rows. */
export async function applicationStoreDelete(
  args: ApplicationStoreDeleteArgs,
): Promise<number> {
  try {
    const result = await adapterBridge.invoke<number>('application_store_delete', args as unknown as Record<string, unknown>);
    return result ?? 0;
  } catch (err) {
    console.warn('[ApplicationStore] delete failed:', err);
    return 0;
  }
}
