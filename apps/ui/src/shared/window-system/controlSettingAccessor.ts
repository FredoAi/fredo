/**
 * controlSettingAccessor — the synchronous settings seam (a PG-hydrated cache)
 * for the window-system stores (Spec #2955 B-2/B-3; Spec #3005 ST-2).
 *
 * The per-app presentation map is read SYNCHRONOUSLY by the Rust backend
 * (`infrastructure/app_window.rs::app_presentation` → `AppStore::control_get`)
 * on the terminal per-emit hot path, so the frontend MUST persist and read it
 * through the SAME synchronous settings seam. The B-1 commands `get_control_setting` /
 * `save_control_setting` are that seam (registered in `lib.rs`).
 *
 * `adapterBridge` performs the Tauri invoke (with its own dynamic
 * `@tauri-apps/api` fallback) — never a static `@tauri-apps/api` import
 * (engineering rule: non-React Tauri calls go through `adapterBridge`).
 *
 * An ABSENT read (the backend `Option<String>` = `None`) is returned as `null`
 * and is AUTHORITATIVE: this accessor NEVER consults `localStorage`, so a stale
 * dev-server shadow cannot resurrect a cleared value (Spec #2955 root cause 3).
 * Callers resolve `null` to their own default.
 */

import { adapterBridge } from '../utils/adapterBridge';

/**
 * Read a RAW value from the synchronous settings store. Returns `null` when the key is absent
 * (or when no Tauri host is registered) — the caller decides the default.
 */
export async function getControlSetting(key: string): Promise<string | null> {
  const raw = await adapterBridge.invoke<string | null>('get_control_setting', { key });
  return raw ?? null;
}

/** Upsert a RAW value on the synchronous settings store (write-through to PostgreSQL). */
export async function saveControlSetting(key: string, value: string): Promise<void> {
  await adapterBridge.invoke('save_control_setting', { key, value });
}
