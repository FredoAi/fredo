/**
 * ingestAutostartStore — the single access point for the Settings → Ingest
 * auto-start control (Spec #2992 ST-7; EARS R-4).
 *
 * The EFFECTIVE state is the Windows registry entry owned by the backend
 * (`features/settings/autostart.rs`, ST-6), so every read reflects the live
 * registry (`ingest_autostart_get`) — never a cached UI value. Writes go through
 * `ingest_autostart_set`, and the `ingest.autostart` KV mirror is kept in sync
 * via `settingsService` (the `TelemetrySettings` pattern).
 *
 * The daemon status is read from the EXISTING `pg_supervisor_status` command —
 * no new IPC is introduced for daemon state (the plan's explicit non-goal).
 */

import { adapterBridge } from '../../shared/utils/adapterBridge';
import { settingsService } from '../settings';

/** KV mirror key for the effective auto-start boolean (`"true"`/`"false"`). */
export const INGEST_AUTOSTART_SETTING_KEY = 'ingest.autostart';

/** The backend view: `IngestAutostartView { enabled, command, entry }`. */
export interface IngestAutostartView {
  enabled: boolean;
  command: string | null;
  entry: string | null;
}

/** The daemon lifecycle states exposed by `pg_supervisor_status.state`. */
export type IngestDaemonState = 'disabled' | 'starting' | 'ready' | 'failed' | 'attached';

/** The subset of `PgStatusView` this surface consumes. */
export interface PgSupervisorStatusView {
  state: IngestDaemonState;
  port?: number | null;
  pid?: number | null;
  error?: string | null;
  dataDir?: string;
  logPath?: string | null;
  attached?: boolean;
}

/** Pre-feature / no-entry default: off, no command, no entry (G-265). */
export const DEFAULT_INGEST_AUTOSTART_VIEW: IngestAutostartView = {
  enabled: false,
  command: null,
  entry: null,
};

const DEFAULT_DAEMON_STATUS: PgSupervisorStatusView = { state: 'disabled' };

function normalizeView(
  raw: IngestAutostartView | null | undefined,
): IngestAutostartView | null {
  if (!raw || typeof raw.enabled !== 'boolean') return null;
  return {
    enabled: raw.enabled,
    command: raw.command ?? null,
    entry: raw.entry ?? null,
  };
}

function isDaemonState(value: unknown): value is IngestDaemonState {
  return (
    value === 'disabled' ||
    value === 'starting' ||
    value === 'ready' ||
    value === 'failed' ||
    value === 'attached'
  );
}

/** Read the effective auto-start state from the registry (backend). */
export async function getIngestAutostart(): Promise<IngestAutostartView> {
  const raw = await adapterBridge.invoke<IngestAutostartView>('ingest_autostart_get');
  const view = normalizeView(raw);
  if (view) {
    void settingsService.set(INGEST_AUTOSTART_SETTING_KEY, String(view.enabled));
    return view;
  }
  // Backend unavailable (Vite dev server / no Tauri host) — fall back to the
  // local KV mirror so the control still renders in the dev surface.
  const enabled = await settingsService.get<boolean>(
    INGEST_AUTOSTART_SETTING_KEY,
    false,
    (value) => value === 'true',
  );
  return { ...DEFAULT_INGEST_AUTOSTART_VIEW, enabled };
}

/** Install/remove the per-user login entry; returns the EFFECTIVE state. */
export async function setIngestAutostart(enabled: boolean): Promise<IngestAutostartView> {
  const raw = await adapterBridge.invoke<IngestAutostartView>('ingest_autostart_set', { enabled });
  const view = normalizeView(raw);
  if (!view) {
    throw new Error('The backend did not return the auto-start state.');
  }
  void settingsService.set(INGEST_AUTOSTART_SETTING_KEY, String(view.enabled));
  return view;
}

/** Read the daemon supervisor state (existing `pg_supervisor_status`). */
export async function getIngestDaemonStatus(): Promise<PgSupervisorStatusView> {
  const raw = await adapterBridge.invoke<PgSupervisorStatusView>('pg_supervisor_status');
  if (raw && isDaemonState(raw.state)) return raw;
  return DEFAULT_DAEMON_STATUS;
}
