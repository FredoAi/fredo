/**
 * Application-data IPC client (Spec #2896, ST-5).
 *
 * Typed wrappers over the six backend commands registered by ST-4:
 *   application_data_read | watch | unwatch | write | delete | declare
 *
 * ── Transport shape ──────────────────────────────────────────────────────────
 * Tauri v2 derives the argument key from the Rust identifier, and every command
 * takes ONE `args` struct, so the frontend invokes
 *
 *   adapterBridge.invoke('application_data_read', { args: { ref, where, orderBy, limit } })
 *
 * (the Rust `ref` / `where` fields are `r#ref` / `r#where`, serde-renamed back
 * to `ref` / `where`; the struct wrapper keeps those reserved words out of the
 * command signature).
 *
 * ── Errors ───────────────────────────────────────────────────────────────────
 * Every command rejects with a hard named error (`string[]` / `Vec<String>`,
 * the `subscribe_events` precedent). These wrappers NEVER catch or swallow a
 * rejection — the raw backend value propagates to the caller, where the
 * consumer hooks normalize it to a verbatim `error: string | null`
 * (contract (f), R-3.5 / A-13). A `remove` is a notification, never an error.
 */

import { adapterBridge } from '../utils/adapterBridge';
import type { ApplicationDataDeclaration } from './declaration';

// The notification wire types live with the rest of the channel contract
// (`EventSubscription.ts`) and are re-exported here for client consumers.
export type {
  ApplicationChangeKind,
  ApplicationRowNotification,
  ApplicationDeliveryBatch,
} from '../classes/EventSubscription';
export type { ApplicationDataDeclaration } from './declaration';

/** Canonical RTDB table names accepted by a `{ source: 'canonical' }` ref. */
export type CanonicalTableName = 'chat' | 'toolUse' | 'agentSession';

/** The table a read/watch is addressed to — contract (b). */
export type DataTableRef =
  | { source: 'application'; applicationId: string; table: string }
  | { source: 'canonical'; table: CanonicalTableName };

/** A declared (application-owned) table ref — write/delete only. */
export interface ApplicationTableRef {
  applicationId: string;
  table: string;
}

/** One read/watch row: the declared/canonical columns + the per-record version. */
export interface ApplicationDataRow {
  [column: string]: unknown;
  _rowVersion: number;
}

/** Equality filter (`field = value`), mirroring the Rust `EqFilter`. */
export interface WhereFilter {
  field: string;
  eq: unknown;
}

/** The declared retention bound surfaced to a read (`null` = unbounded). */
export interface ApplicationRetention {
  maxRows: number | null;
  ttlDays: number | null;
}

export interface ApplicationDataReadArgs {
  ref: DataTableRef;
  where?: WhereFilter[];
  orderBy?: string;
  limit?: number;
}

export interface ApplicationDataReadResult {
  /** Scope version at which `rows` were taken (declared: `last_version`; canonical: `MAX(seq)`). */
  version: number;
  rows: ApplicationDataRow[];
  retention: ApplicationRetention;
}

/** One `application_data_watch` scope — contract (c). */
export type WatchScope =
  | { kind: 'table' }
  | { kind: 'record'; key: unknown[] }
  | { kind: 'query'; where: WhereFilter[] };

export interface ApplicationDataWatchArgs {
  ref: DataTableRef;
  scope: WatchScope;
  /** Field-granularity narrowing: notify only when one of these changes. */
  fields?: string[];
  /** `true` → return the current rows atomically with registration (R-3.2). */
  initial?: boolean;
  /** Backend coalescing window in ms; absent = the backend default (30 ms). */
  flushMs?: number;
}

export interface ApplicationDataWatchResult {
  watchId: string;
  /** Register point for this scope. */
  version: number;
  /** Present only when `initial: true`. */
  rows?: ApplicationDataRow[];
}

export interface ApplicationDataUnwatchArgs {
  watchIds: string[];
}

export interface ApplicationDataUnwatchResult {
  /** The ids actually removed (idempotent — unknown ids are omitted). */
  watchIds: string[];
}

export interface ApplicationDataWriteArgs {
  ref: ApplicationTableRef;
  key: unknown[];
  /** Rejected by the backend when it names a backend-owned/reserved column. */
  set: Record<string, unknown>;
}

export interface ApplicationDataWriteResult {
  updated: number;
}

export interface ApplicationDataDeleteArgs {
  ref: ApplicationTableRef;
  key: unknown[];
}

export interface ApplicationDataDeleteResult {
  deleted: boolean;
}

export interface ApplicationDataDeclareArgs {
  declarations: ApplicationDataDeclaration[];
}

export interface MaterializedApplicationTable {
  applicationId: string;
  table: string;
  revision: string;
  created: boolean;
}

export interface ApplicationDataDeclareResult {
  materialized: MaterializedApplicationTable[];
}

/**
 * Invoke one application-data command with the single `args` struct wrapper.
 * A rejection (the backend's hard named `string[]`) propagates verbatim — this
 * function never catches. An `undefined` result means `adapterBridge` had no
 * `invoke` registered (a non-Tauri/test wiring bug): that is surfaced as a
 * loud error rather than silently becoming `undefined` at the call site.
 */
async function invokeApplicationData<T>(
  command: string,
  args: Record<string, unknown>,
): Promise<T> {
  const result = await adapterBridge.invoke<T>(command, { args });
  if (result === undefined) {
    throw new Error(
      `[application-data] ${command} returned no result (adapterBridge.invoke is not registered)`,
    );
  }
  return result;
}

/** `application_data_read` — current rows + the scope version at which they were taken (R-1.1/R-1.3). */
export function applicationDataRead(args: ApplicationDataReadArgs): Promise<ApplicationDataReadResult> {
  return invokeApplicationData<ApplicationDataReadResult>(
    'application_data_read',
    args as unknown as Record<string, unknown>,
  );
}

/**
 * `application_data_watch` — register a table/record/query watch (plus optional
 * `fields` narrowing) and, with `initial: true`, atomically return the current
 * snapshot (R-3.2: the backend registers BEFORE taking the snapshot).
 */
export function applicationDataWatch(args: ApplicationDataWatchArgs): Promise<ApplicationDataWatchResult> {
  return invokeApplicationData<ApplicationDataWatchResult>(
    'application_data_watch',
    args as unknown as Record<string, unknown>,
  );
}

/** `application_data_unwatch` — remove exactly these watches (R-2.5, idempotent). */
export function applicationDataUnwatch(
  args: ApplicationDataUnwatchArgs,
): Promise<ApplicationDataUnwatchResult> {
  return invokeApplicationData<ApplicationDataUnwatchResult>(
    'application_data_unwatch',
    args as unknown as Record<string, unknown>,
  );
}

/** `application_data_write` — write application-owned columns only (backend-guarded). */
export function applicationDataWrite(args: ApplicationDataWriteArgs): Promise<ApplicationDataWriteResult> {
  return invokeApplicationData<ApplicationDataWriteResult>(
    'application_data_write',
    args as unknown as Record<string, unknown>,
  );
}

/** `application_data_delete` — tombstoned record removal (emits a `remove` notification). */
export function applicationDataDelete(
  args: ApplicationDataDeleteArgs,
): Promise<ApplicationDataDeleteResult> {
  return invokeApplicationData<ApplicationDataDeleteResult>(
    'application_data_delete',
    args as unknown as Record<string, unknown>,
  );
}

/** `application_data_declare` — idempotent declaration materialization. */
export function applicationDataDeclare(
  args: ApplicationDataDeclareArgs,
): Promise<ApplicationDataDeclareResult> {
  return invokeApplicationData<ApplicationDataDeclareResult>(
    'application_data_declare',
    args as unknown as Record<string, unknown>,
  );
}
