/**
 * featureStore.ts — Generic FeatureStore IPC client.
 *
 * Wraps adapterBridge.invoke() for each FeatureStore command registered
 * in the Rust backend. All features share this single client.
 *
 * ── Contract ─────────────────────────────────────────────────────────────────
 * See .opencode/tmp/contract-339.ts for full type definitions.
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 * ```ts
 * import { featureStoreInsert } from '../../shared/lib/featureStore';
 * await featureStoreEnsureTable({ featureId: 'mission-monitor', tableName: 'sessions', columns: [...] });
 * ```
 */
import { adapterBridge } from '../utils/adapterBridge';

// ── Type-level contract (mirrors .opencode/tmp/contract-339.ts) ──────────────

export type FeatureStoreColumnType = 'TEXT' | 'INTEGER' | 'REAL' | 'BLOB';

export interface FeatureStoreColumnDef {
  name: string;
  colType: FeatureStoreColumnType;
  nullable?: boolean;
  primaryKey?: boolean;
}

export interface FeatureStoreEnsureTableArgs {
  featureId: string;
  tableName: string;
  columns: FeatureStoreColumnDef[];
}

export interface FeatureStoreInsertArgs {
  featureId: string;
  tableName: string;
  rows: Record<string, unknown>[];
}

export interface FeatureStoreQueryArgs {
  featureId: string;
  tableName: string;
  whereCols?: Record<string, unknown>;
  orderBy?: string;
  limit?: number;
}

export interface FeatureStoreUpdateArgs {
  featureId: string;
  tableName: string;
  setCols: Record<string, unknown>;
  whereCols: Record<string, unknown>;
}

export interface FeatureStoreDeleteArgs {
  featureId: string;
  tableName: string;
  whereCols: Record<string, unknown>;
}

export interface FeatureStoreRow {
  [column: string]: unknown;
}

// ── IPC wrappers ─────────────────────────────────────────────────────────────

/** REQ-1: Ensure a namespaced table exists. */
export async function featureStoreEnsureTable(
  args: FeatureStoreEnsureTableArgs,
): Promise<void> {
  try {
    await adapterBridge.invoke('feature_store_ensure_table', args as unknown as Record<string, unknown>);
  } catch (err) {
    console.warn('[FeatureStore] ensureTable failed:', err);
  }
}

/** REQ-2: Insert rows into a namespaced table. Returns count of inserted rows. */
export async function featureStoreInsert(
  args: FeatureStoreInsertArgs,
): Promise<number> {
  try {
    const result = await adapterBridge.invoke<number>('feature_store_insert', args as unknown as Record<string, unknown>);
    return result ?? 0;
  } catch (err) {
    console.warn('[FeatureStore] insert failed:', err);
    return 0;
  }
}

/** REQ-3: Query rows from a namespaced table. */
export async function featureStoreQuery(
  args: FeatureStoreQueryArgs,
): Promise<FeatureStoreRow[]> {
  try {
    const result = await adapterBridge.invoke<FeatureStoreRow[]>('feature_store_query', args as unknown as Record<string, unknown>);
    return result ?? [];
  } catch (err) {
    console.warn('[FeatureStore] query failed:', err);
    return [];
  }
}

/** REQ-4: Update rows in a namespaced table. Returns count of updated rows. */
export async function featureStoreUpdate(
  args: FeatureStoreUpdateArgs,
): Promise<number> {
  try {
    const result = await adapterBridge.invoke<number>('feature_store_update', args as unknown as Record<string, unknown>);
    return result ?? 0;
  } catch (err) {
    console.warn('[FeatureStore] update failed:', err);
    return 0;
  }
}

/** REQ-5: Delete rows from a namespaced table. Returns count of deleted rows. */
export async function featureStoreDelete(
  args: FeatureStoreDeleteArgs,
): Promise<number> {
  try {
    const result = await adapterBridge.invoke<number>('feature_store_delete', args as unknown as Record<string, unknown>);
    return result ?? 0;
  } catch (err) {
    console.warn('[FeatureStore] delete failed:', err);
    return 0;
  }
}
