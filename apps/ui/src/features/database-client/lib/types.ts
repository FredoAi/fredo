/**
 * Postgres client wire contract (Spec #2950, ST-1).
 *
 * TS mirror of `apps/tauri/src-tauri/src/features/db_client/types.rs`. Every
 * name here is frozen by the plan's Authoritative Names Block (G-255/G-023) —
 * do not rename. Serde serializes `camelCase`, so field names match the Rust
 * structs 1:1.
 *
 * The connection view NEVER carries the password — `hasPassword` is the only
 * credential signal. The password lives only in the OS keychain.
 */

export type DbEngineKind = 'postgres';
export type SslMode = 'disable' | 'prefer' | 'require' | 'verifyCa' | 'verifyFull';
export type AccessMode = 'readOnly' | 'readWrite';
export type StatementClass = 'read' | 'write' | 'ddl' | 'destructive' | 'unknown';
export type DbObjectKind =
  | 'database'
  | 'schema'
  | 'table'
  | 'view'
  | 'column'
  | 'index'
  | 'key'
  | 'function';
export type DbErrorKind =
  | 'auth'
  | 'unreachable'
  | 'timeout'
  | 'tls'
  | 'config'
  | 'readOnlyBlocked'
  | 'confirmationRequired'
  | 'connectionLost'
  | 'query'
  | 'other';

export interface DbConnectionView {
  id: string;
  name: string;
  engine: DbEngineKind;
  host: string;
  port: number;
  user: string;
  database: string;
  sslMode: SslMode;
  accessMode: AccessMode;
  hasPassword: boolean;
}

export interface DbConnectionTestArgs {
  engine: DbEngineKind;
  host: string;
  port: number;
  user: string;
  database: string;
  sslMode: SslMode;
  password?: string | null;
}

export interface DbConnectionSaveArgs {
  /** `null`/omitted => create. */
  id?: string | null;
  name: string;
  engine: DbEngineKind;
  host: string;
  port: number;
  user: string;
  database: string;
  sslMode: SslMode;
  accessMode: AccessMode;
  /** Omitted/null on edit => keep the existing keychain secret (R-1.6). */
  password?: string | null;
}

/** Delete-by-id arguments (R-1.7). */
export interface DbConnectionDeleteArgs {
  connectionId: string;
}

/** Connect / disconnect arguments. */
export interface DbConnectArgs {
  connectionId: string;
}

/** Lazy per-level schema browse arguments (R-2.1/R-2.2). */
export interface DbSchemaListArgs {
  connectionId: string;
  /** `null` fetches the root (databases); otherwise a parent node id. */
  parentId: string | null;
}

export interface DbQueryError {
  kind: DbErrorKind;
  message: string;
  line?: number | null;
  column?: number | null;
  position?: number | null;
}

export interface DbTestResult {
  ok: boolean;
  serverVersion: string | null;
  error: DbQueryError | null;
}

export interface DbSessionInfo {
  connectionId: string;
  serverVersion: string;
  accessMode: AccessMode;
}

export interface SchemaNode {
  kind: DbObjectKind;
  id: string;
  name: string;
  detail: string | null;
  hasChildren: boolean;
}

export type QueryMode = 'single' | 'all';

/** UTF-8 byte offsets into the editor buffer. */
export interface TextRange {
  start: number;
  end: number;
}

export interface DbQueryArgs {
  connectionId: string;
  sql: string;
  mode: QueryMode;
  selection?: TextRange | null;
  confirmedStatementHashes: string[];
  /**
   * First-page row limit from the "Default row limit" preference (R-3.3, PO
   * decision 7). Omitted/0 falls back to the backend's 100-row default.
   */
  limit?: number;
}

export interface DbColumn {
  name: string;
  typeName: string;
}

export interface DbResultSet {
  resultSetId: string;
  columns: DbColumn[];
  rows: unknown[][];
  rowCountLoaded: number;
  hasMore: boolean;
  truncated: boolean;
  durationMs: number;
}

export interface DbConfirmationRequired {
  statementClass: StatementClass;
  statementHash: string;
  preview: string;
}

export interface DbQueryOutcome {
  resultSets: DbResultSet[];
  confirmationRequired: DbConfirmationRequired | null;
  error: DbQueryError | null;
}

export interface DbResultPageArgs {
  connectionId: string;
  resultSetId: string;
  offset: number;
  limit: number;
}

// ── Persisted documents (settingsService → AppStore KV; NO secret) ───────────

export interface DbClientPrefs {
  /** Default 100 (PO decision 7). */
  defaultRowLimit: number;
  /** Default 100. */
  pageSize: number;
  /** Default true. */
  confirmDestructive: boolean;
}

export interface QueryHistoryEntry {
  sql: string;
  at: string;
  durationMs: number;
  rowCount: number;
  status: 'ok' | 'error';
}

export interface SavedQuery {
  id: string;
  name: string;
  sql: string;
  createdAt: string;
}
