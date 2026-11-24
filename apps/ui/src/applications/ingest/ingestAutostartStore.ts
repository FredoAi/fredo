/**
 * ingestAutostartStore — the single access point for the Settings → Background
 * capture control (Spec #3193 ST-2; originally #2992 ST-7 / EARS R-4).
 *
 * The EFFECTIVE state is the Windows per-user login entry owned by the backend
 * (`applications/settings/autostart.rs`), so every read reflects the live
 * registry (`ingest_autostart_get`) — never a cached UI value. Writes go through
 * `ingest_autostart_set`, and the `ingest.autostart` KV mirror is kept in sync
 * via `settingsService` (the `TelemetrySettings` pattern).
 *
 * The backend view also carries the two discriminators the surface needs and
 * the renderer must NEVER infer (no platform sniffing):
 *   available — this platform has a per-user login item at all (Windows only).
 *   owned     — the entry currently present belongs to THIS Fredo binary; a
 *               present-but-foreign value is not a working "on" state.
 * Both are PROJECTED through `normalizeView` (G-418): a whitelist that drops
 * them would leave the unavailable and stale-entry states unrenderable even
 * after the backend sends them.
 *
 * The daemon-status read (`pg_supervisor_status`) was retired with the headless
 * status row — the resident instance IS this application now, so a liveness row
 * on this surface is redundant (`PostgresSettings` owns supervisor status).
 */

import { adapterBridge } from '../../shared/utils/adapterBridge';
import { settingsService } from '../settings';

/** KV mirror key for the effective login-entry boolean (`"true"`/`"false"`). */
export const INGEST_AUTOSTART_SETTING_KEY = 'ingest.autostart';

/**
 * The backend view:
 * `IngestAutostartView { enabled, command, entry, available, owned }`
 * (camelCase; `available`/`owned` are Spec #3193 additions).
 */
export interface IngestAutostartView {
  /** A value with this name is present in the per-user Run key (read-back). */
  enabled: boolean;
  /** The raw command the entry launches (present only when `enabled`). */
  command: string | null;
  /** The full registry value path (present only when `enabled`). */
  entry: string | null;
  /** True on a platform that has a per-user login item (`false` ⇒ unavailable). */
  available: boolean;
  /** True iff the present entry belongs to THIS Fredo binary (`false` ⇒ stale/foreign). */
  owned: boolean;
}

/**
 * Pre-feature / no-entry default (G-265): off, nothing owned, and available —
 * the legacy behaviour, used only when no backend answers at all (Vite dev
 * surface). It must never fabricate an "Unavailable" state the backend did not
 * report.
 */
export const DEFAULT_INGEST_AUTOSTART_VIEW: IngestAutostartView = {
  enabled: false,
  command: null,
  entry: null,
  available: true,
  owned: true,
};

function normalizeView(
  raw: Partial<IngestAutostartView> | null | undefined,
): IngestAutostartView | null {
  if (!raw || typeof raw.enabled !== 'boolean') return null;
  return {
    enabled: raw.enabled,
    command: raw.command ?? null,
    entry: raw.entry ?? null,
    // Boundary guard (G-413): both booleans cross IPC. A field that is absent
    // or non-boolean falls back to the LEGACY behaviour — never to a fabricated
    // unavailable/stale state that the backend did not report.
    available: typeof raw.available === 'boolean' ? raw.available : true,
    owned: typeof raw.owned === 'boolean' ? raw.owned : true,
  };
}

/** Read the effective login-entry state from the registry (backend). */
export async function getIngestAutostart(): Promise<IngestAutostartView> {
  const raw = await adapterBridge.invoke<Partial<IngestAutostartView>>('ingest_autostart_get');
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
  const raw = await adapterBridge.invoke<Partial<IngestAutostartView>>(
    'ingest_autostart_set',
    { enabled },
  );
  const view = normalizeView(raw);
  if (!view) {
    throw new Error('The backend did not return the background capture state.');
  }
  void settingsService.set(INGEST_AUTOSTART_SETTING_KEY, String(view.enabled));
  return view;
}
