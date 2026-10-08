/**
 * Settings — Infrastructure module (NOT an FredoApplicationClass / grid feature).
 *
 * This module is structural infrastructure shared across the app — it provides
 * persistence to all other features. It does not register in applicationRegistry
 * and does not render in the Home grid.
 *
 * SAD equivalent: `infrastructure/storage/` in the Rust backend.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * Settings Service — the single place where all settings persistence lives.
 *
 * Every read and write goes through here. The service:
 *   1. Tries the Tauri `save_setting` / `get_setting` SQLite commands first.
 *   2. Falls back to localStorage for the Vite dev server (no Tauri host).
 *
 * Usage (non-React):
 *   import { settingsService } from '@/applications/settings';
 *   await settingsService.set('my_key', 'value');
 *   const v = await settingsService.get('my_key', 'default');
 *
 * Usage (React):
 *   const [theme, setTheme] = usePersistedSetting('Fredo_theme', 'classic');
 *   // or call settingsService directly inside async handlers
 */

import { adapterBridge } from '../../shared/utils/adapterBridge';

// ── Core service ──────────────────────────────────────────────────────────────

export const settingsService = {
  /**
   * Read a setting.
   * Returns `defaultValue` if the key has never been saved.
   */
  async get<T>(
    key: string,
    defaultValue: T,
    deserialize?: (raw: string) => T,
  ): Promise<T> {
    const parse = deserialize ?? defaultDeserialize<T>;

    // 1. Try SQLite via Tauri
    let raw: string | null | undefined;
    try {
      raw = await adapterBridge.invoke<string | null>('get_setting', { key });
    } catch {
      // A thrown transport error means no Tauri host (Vite dev server) — consult
      // the localStorage shadow store.
      return readShadow(key, defaultValue, parse);
    }

    // No adapter registered (jsdom / plain Vite dev server): the bridge resolves
    // `undefined` instead of a real DB answer. That is the no-host signal, NOT an
    // authoritative "absent", so the shadow fallback still applies here.
    if (raw === undefined) return readShadow(key, defaultValue, parse);

    // The DB read succeeded, so it is authoritative: an absent value (`null`/`""`)
    // resolves to `defaultValue` and must NEVER be overridden by a stale
    // localStorage shadow (AC4: absent → default). A corrupt value is likewise
    // authoritative-absent — the shadow is not consulted.
    if (raw === null || raw === '') return defaultValue;
    try {
      return parse(raw);
    } catch {
      return defaultValue;
    }
  },

  /**
   * Persist a setting.
   * Writes to localStorage first (synchronous, instant), then to SQLite via Tauri.
   */
  async set(key: string, value: string): Promise<void> {
    // Keep localStorage in sync so dev server and same-session reads work
    try { localStorage.setItem(key, value); } catch { /* quota exceeded */ }

    // Persist to SQLite when running inside Tauri
    try {
      await adapterBridge.invoke('save_setting', { key, value });
    } catch { /* not available in dev — localStorage write is sufficient */ }
  },

  /**
   * Remove a setting from both stores.
   */
  async remove(key: string): Promise<void> {
    localStorage.removeItem(key);
    try { await adapterBridge.invoke('save_setting', { key, value: '' }); } catch { /* dev */ }
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Read a value from the localStorage shadow store. Used ONLY when no Tauri host
 * answered the DB read (a thrown transport error, or an unregistered bridge in
 * the Vite dev server / jsdom). A successful DB read is authoritative and never
 * reaches here — see `settingsService.get`.
 */
function readShadow<T>(key: string, defaultValue: T, parse: (raw: string) => T): T {
  const stored = localStorage.getItem(key);
  if (stored != null) {
    try { return parse(stored); } catch { /* corrupted — use default */ }
  }
  return defaultValue;
}

function defaultDeserialize<T>(raw: string): T {
  try { return JSON.parse(raw) as T; } catch { return raw as unknown as T; }
}

/** Serialize any value to a string for storage. */
export function serializeValue<T>(value: T): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

