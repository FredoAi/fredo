/**
 * Postgres client IPC wrappers (Spec #2950, ST-1).
 *
 * Typed thin wrappers over the nine registered `db_*` Tauri commands. Each
 * command takes a single `args` struct (the repo wire convention), routed
 * through `adapterBridge.invoke`. Errors are the backend's hard-named
 * `string[]` shape and are normalized to a single `Error` message — never
 * swallowed.
 */

import { adapterBridge } from '../../../shared/utils/adapterBridge';
import type {
  DbConnectArgs,
  DbConnectionDeleteArgs,
  DbConnectionSaveArgs,
  DbConnectionTestArgs,
  DbConnectionView,
  DbQueryArgs,
  DbQueryOutcome,
  DbResultPageArgs,
  DbResultSet,
  DbSchemaListArgs,
  DbSessionInfo,
  DbTestResult,
  SchemaNode,
} from './types';

/** Normalize a Tauri command rejection (`string[]` / `Error` / anything). */
export function normalizeDbError(error: unknown): string {
  if (Array.isArray(error)) return error.map((item) => String(item)).join('; ');
  if (error instanceof Error) return error.message;
  return String(error);
}

async function invokeDb<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return (await adapterBridge.invoke<T>(command, args)) as T;
  } catch (error) {
    throw new Error(normalizeDbError(error));
  }
}

/** List saved connections (R-1.5). */
export function dbConnectionList(): Promise<DbConnectionView[]> {
  return invokeDb<DbConnectionView[]>('db_connection_list');
}

/** Test connection parameters before saving (R-1.3). */
export function dbConnectionTest(args: DbConnectionTestArgs): Promise<DbTestResult> {
  return invokeDb<DbTestResult>('db_connection_test', { args });
}

/** Create or edit a saved connection (R-1.5/R-1.6). */
export function dbConnectionSave(args: DbConnectionSaveArgs): Promise<DbConnectionView> {
  return invokeDb<DbConnectionView>('db_connection_save', { args });
}

/** Delete a connection and its dependent stores (R-1.7). */
export function dbConnectionDelete(args: DbConnectionDeleteArgs): Promise<void> {
  return invokeDb<void>('db_connection_delete', { args });
}

/** Open a bounded external session (R-1.3). */
export function dbConnect(args: DbConnectArgs): Promise<DbSessionInfo> {
  return invokeDb<DbSessionInfo>('db_connect', { args });
}

/** Close a session (R-3.8). */
export function dbDisconnect(args: DbConnectArgs): Promise<void> {
  return invokeDb<void>('db_disconnect', { args });
}

/** Fetch one lazy schema-tree level (R-2.1/R-2.2). */
export function dbSchemaList(args: DbSchemaListArgs): Promise<SchemaNode[]> {
  return invokeDb<SchemaNode[]>('db_schema_list', { args });
}

/** Execute a query under the safety gates (R-3.6/R-5.2/R-5.3/R-5.4). */
export function dbQueryExecute(args: DbQueryArgs): Promise<DbQueryOutcome> {
  return invokeDb<DbQueryOutcome>('db_query_execute', { args });
}

/** Slice the next page from an executed result set (R-3.3). */
export function dbResultPage(args: DbResultPageArgs): Promise<DbResultSet> {
  return invokeDb<DbResultSet>('db_result_page', { args });
}
