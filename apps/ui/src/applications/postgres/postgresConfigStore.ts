/**
 * postgresConfigStore — the typed access point for the Settings → Database pane
 * (Spec #3022 ST-7; EARS R-5.1).
 *
 * ONE thin wrapper over `adapterBridge.invoke` for the three Architect-owned
 * commands — `pg_config_get`, `pg_config_apply`, `pg_database_reset` — plus a
 * reader of the EXISTING `pg_supervisor_status` command (the additive
 * `failureKind`). No new IPC beyond those three; no status event.
 *
 * Write-only invariant (AC5 / R-5): `PgConfigView` — the effective-config wire
 * view — carries NO password/secret field. The password travels ONE way
 * (`pg_config_apply`'s optional `newPassword`) and is never returned by any
 * command, so no cleartext can reach a visible surface. This is the structural
 * guard: a secret cannot be rendered because it is never sent to the client.
 *
 * Units (adopted from the plan's names block):
 *   - port: display integer TCP 1–65535; persisted integer + `portMode`
 *     discriminator (`'auto'` = OS-assigned / no integer persisted, `'fixed'` =
 *     pinned). The backend file stores `port: null` for ephemeral, so `portMode`
 *     is derived (an explicit `portMode` on the wire wins when present).
 *   - log verbosity: display = friendly label; persisted = the PostgreSQL
 *     `log_min_messages` enum string (default `info`).
 */

import { adapterBridge } from '../../shared/utils/adapterBridge';

/** The persisted PostgreSQL `log_min_messages` values (the wire/persisted unit). */
export const PG_LOG_VERBOSITY_VALUES = ['error', 'warning', 'info', 'debug1', 'debug5'] as const;
export type PgLogVerbosity = (typeof PG_LOG_VERBOSITY_VALUES)[number];

/** Default verbosity (`info`) — matches the backend `PgLogVerbosity::default`. */
export const DEFAULT_PG_LOG_VERBOSITY: PgLogVerbosity = 'info';

/** Port discriminator: `auto` = OS-assigned (no integer persisted); `fixed` = pinned. */
export type PgPortMode = 'auto' | 'fixed';

/** Additive failure classification on the existing `pg_supervisor_status`. */
export type PgFailureKind = 'authMismatch' | 'portInUse' | 'unknown';

/** Friendly display labels for the persisted `log_min_messages` strings. */
export const PG_LOG_VERBOSITY_LABELS: Record<PgLogVerbosity, string> = {
  error: 'Errors only',
  warning: 'Warnings',
  info: 'Info (default)',
  debug1: 'Debug (verbose)',
  debug5: 'Trace (very verbose)',
};

/** Valid TCP port range (display + persisted integer). */
export const PG_PORT_MIN = 1;
export const PG_PORT_MAX = 65535;

/** The effective config MINUS any secret — wire: `PgConfigView`. */
export interface PgConfigView {
  /** `null` = OS-assigned (auto). Present only when `portMode === 'fixed'`. */
  port: number | null;
  portMode: PgPortMode;
  logVerbosity: PgLogVerbosity;
  dataDir: string;
  configPath: string;
}

/** Wire: `PgConfigApplyResult`. */
export interface PgConfigApplyResult {
  ok: boolean;
  error: string | null;
  config: PgConfigView;
}

/** Wire: `PgDatabaseResetResult`. */
export interface PgDatabaseResetResult {
  ok: boolean;
  error: string | null;
  port: number | null;
}

/** The supervisor lifecycle states exposed by `pg_supervisor_status.state`. */
export type PgSupervisorState = 'disabled' | 'starting' | 'ready' | 'failed' | 'attached';

/** The subset of `PgStatusView` this pane consumes (additive `failureKind`). */
export interface PgSupervisorStatusView {
  state: PgSupervisorState;
  port?: number | null;
  pid?: number | null;
  error?: string | null;
  dataDir?: string;
  logPath?: string | null;
  attached?: boolean;
  failureKind?: PgFailureKind | null;
}

/** The one-way apply input: persisted units + an OPTIONAL new password. */
export interface PgApplyInput {
  /** `null` = OS-assigned (auto); an integer 1–65535 = pinned. */
  port: number | null;
  logVerbosity: PgLogVerbosity;
  /** Write-only. Absent / empty leaves the stored credential untouched. */
  newPassword?: string;
}

/** Pre-load / no-config default (ephemeral port, `info` verbosity) (G-265). */
export const DEFAULT_PG_CONFIG: PgConfigView = {
  port: null,
  portMode: 'auto',
  logVerbosity: DEFAULT_PG_LOG_VERBOSITY,
  dataDir: '',
  configPath: '',
};

const DEFAULT_STATUS: PgSupervisorStatusView = { state: 'disabled' };

// ── Normalizers (untrusted IPC payloads → typed views) ────────────────────────

function isVerbosity(value: unknown): value is PgLogVerbosity {
  return (
    typeof value === 'string' &&
    (PG_LOG_VERBOSITY_VALUES as readonly string[]).includes(value)
  );
}

function isPortMode(value: unknown): value is PgPortMode {
  return value === 'auto' || value === 'fixed';
}

function isFailureKind(value: unknown): value is PgFailureKind {
  return value === 'authMismatch' || value === 'portInUse' || value === 'unknown';
}

function isSupervisorState(value: unknown): value is PgSupervisorState {
  return (
    value === 'disabled' ||
    value === 'starting' ||
    value === 'ready' ||
    value === 'failed' ||
    value === 'attached'
  );
}

function normalizePort(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * Read a config view from an untrusted payload. Returns `null` when the payload
 * is absent/malformed. The view has NO password field by construction.
 */
export function normalizePgConfig(raw: unknown): PgConfigView | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<PgConfigView>;
  const port = normalizePort(value.port);
  const portMode: PgPortMode = isPortMode(value.portMode)
    ? value.portMode
    : port === null
      ? 'auto'
      : 'fixed';
  return {
    port,
    portMode,
    logVerbosity: isVerbosity(value.logVerbosity) ? value.logVerbosity : DEFAULT_PG_LOG_VERBOSITY,
    dataDir: typeof value.dataDir === 'string' ? value.dataDir : '',
    configPath: typeof value.configPath === 'string' ? value.configPath : '',
  };
}

function normalizeApplyResult(raw: unknown): PgConfigApplyResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<PgConfigApplyResult>;
  const config = normalizePgConfig(value.config);
  if (typeof value.ok !== 'boolean' || !config) return null;
  return { ok: value.ok, error: typeof value.error === 'string' ? value.error : null, config };
}

function normalizeResetResult(raw: unknown): PgDatabaseResetResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<PgDatabaseResetResult>;
  if (typeof value.ok !== 'boolean') return null;
  return {
    ok: value.ok,
    error: typeof value.error === 'string' ? value.error : null,
    port: normalizePort(value.port),
  };
}

// ── Commands ──────────────────────────────────────────────────────────────────

/** Read the effective PostgreSQL config (no secret field — structural guard). */
export async function getPostgresConfig(): Promise<PgConfigView> {
  const raw = await adapterBridge.invoke<unknown>('pg_config_get');
  const view = normalizePgConfig(raw);
  if (!view) throw new Error('The PostgreSQL configuration is unavailable.');
  return view;
}

/**
 * Persist the config and restart the cluster. `newPassword` is OPTIONAL and
 * one-way — omit it (or send `''`) to leave the stored credential untouched.
 * Returns the backend apply result; the caller re-reads the effective config.
 */
export async function applyPostgresConfig(input: PgApplyInput): Promise<PgConfigApplyResult> {
  const args: Record<string, unknown> = {
    port: input.port,
    logVerbosity: input.logVerbosity,
  };
  if (input.newPassword) args.newPassword = input.newPassword;
  const raw = await adapterBridge.invoke<unknown>('pg_config_apply', args);
  const result = normalizeApplyResult(raw);
  if (!result) throw new Error('The database did not return an apply result.');
  return result;
}

/** Re-initialise the cluster with the currently stored password (destructive). */
export async function resetPostgresDatabase(): Promise<PgDatabaseResetResult> {
  const raw = await adapterBridge.invoke<unknown>('pg_database_reset');
  const result = normalizeResetResult(raw);
  if (!result) throw new Error('The database did not return a reset result.');
  return result;
}

/** Read the supervisor state via the EXISTING command (additive `failureKind`). */
export async function getPgSupervisorStatus(): Promise<PgSupervisorStatusView> {
  const raw = await adapterBridge.invoke<unknown>('pg_supervisor_status');
  if (raw && typeof raw === 'object' && isSupervisorState((raw as PgSupervisorStatusView).state)) {
    const view = raw as PgSupervisorStatusView;
    return {
      ...view,
      failureKind: isFailureKind(view.failureKind) ? view.failureKind : null,
    };
  }
  return DEFAULT_STATUS;
}
