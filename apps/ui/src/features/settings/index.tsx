/**
 * Settings — Infrastructure module (NOT an FredoFeatureClass / grid feature).
 *
 * This module is structural infrastructure shared across the app — it provides
 * persistence to all other features. It does not register in featureRegistry
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
 *   import { settingsService } from '@/features/settings';
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
    try {
      const raw = await adapterBridge.invoke<string | null>('get_setting', { key });
      if (raw != null && raw !== '') return parse(raw);
    } catch {
      // Tauri not available — fall through to localStorage
    }

    // 2. localStorage fallback (Vite dev server)
    const stored = localStorage.getItem(key);
    if (stored != null) {
      try { return parse(stored); } catch { /* corrupted — use default */ }
    }

    return defaultValue;
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

/** Null component kept for legacy route compatibility — settings live in the modal. */
export const Settings = () => null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function defaultDeserialize<T>(raw: string): T {
  try { return JSON.parse(raw) as T; } catch { return raw as unknown as T; }
}

/** Serialize any value to a string for storage. */
export function serializeValue<T>(value: T): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

