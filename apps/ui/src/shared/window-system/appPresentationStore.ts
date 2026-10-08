/**
 * appPresentationStore — the single module-scoped source of truth for the
 * per-app presentation preference (Spec #2955 ST-2; generalizes #2947's
 * Terminal-only store into ONE platform capability).
 *
 * The preference is shared across separately-mounted consumers (the Settings →
 * Apps control, the launcher/Home open path, the Terminal entry). A per-instance
 * state hook would diverge across those trees, so — per the AGENTS
 * module-scoped-state rule — the map lives at MODULE scope (mirroring
 * `windowStore.ts` / `workspaceLayoutStore.ts`) and every consumer reaches it
 * through `useSyncExternalStore`. There is exactly ONE mechanism; the retired
 * `terminal/presentation.ts` is a thin delegating shim over this store.
 *
 * Persistence: a JSON object map `{ "<appId>": "same-window" | "new-window" }`
 * stored as a RAW string under the `app_window_presentation` CONTROL-plane
 * (`control.db`) KV key through `controlSettingAccessor`
 * (`get_control_setting` / `save_control_setting`) — the SAME plane the Rust
 * `app_window.rs::app_presentation` reads synchronously. It is deliberately NOT
 * the async, PostgreSQL-only data plane (`save_setting`), and it NEVER consults
 * `localStorage`: an authoritative absent read resolves to the default. The wire
 * vocabulary is REUSED unchanged from #2947 (`same-window` / `new-window`).
 *
 * Legacy migration: on the first hydrate, if the map lacks `terminal` and the
 * legacy `terminal_presentation_mode` key holds a RECOGNIZED value, it is copied
 * into `map.terminal` (one-way, idempotent). The legacy read also goes through
 * the control-plane accessor (the backend's own fallback reads it there), and the
 * legacy key is never rewritten.
 *
 * Optimistic write (binding adjudication): `setAppPresentation` moves the module
 * store synchronously and notifies subscribers BEFORE awaiting the KV write, and
 * restores the prior value on a rejected write — so the Settings radio repaints
 * instantly and never sticks on a failed save.
 */

import { useSyncExternalStore } from 'react';
import { getControlSetting, saveControlSetting } from './controlSettingAccessor';
import { getApplications } from '../../applications/applicationRegistry';

/** Where an app opens: inside the main Fredo window or in its own native window. */
export type AppPresentation = 'same-window' | 'new-window';
/** Canonical AppStore control-plane KV key for the per-app map (JSON, raw string). */
export const APP_PRESENTATION_KEY = 'app_window_presentation';
/** Legacy #2947 Terminal-only key — read once for migration, NEVER rewritten. */
export const LEGACY_TERMINAL_PRESENTATION_KEY = 'terminal_presentation_mode';
/** Default for every app: inside the main Fredo window (AC2). */
export const DEFAULT_APP_PRESENTATION: AppPresentation = 'same-window';

/** The in-memory map. A fresh object per mutation keeps the snapshot identity stable. */
let map: Record<string, AppPresentation> = {};
/** True once hydration has settled (success or failure) — the bounded hold flag. */
let hydrated = false;
/** Guards against a second concurrent hydration read (module-scope once-only). */
let hydrationStarted = false;
/** The single in-flight hydration promise (idempotent `hydrateAppPresentation`). */
let hydrationPromise: Promise<void> | null = null;
/** App ids the user has written — a late hydration must never clobber them. */
const dirtyAppIds = new Set<string>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * Recognize a persisted value EXACTLY, or return `null` when it is not a known
 * mode. Used by the legacy migration so an absent/unrecognized legacy value does
 * not create a `terminal` entry. Strings are trimmed first (mirrors
 * `AppPresentation::parse` in the Rust backend and the shipped #2947 behaviour).
 */
function recognizePresentation(raw: unknown): AppPresentation | null {
  const value = typeof raw === 'string' ? raw.trim() : raw;
  return value === 'same-window' ? 'same-window' : value === 'new-window' ? 'new-window' : null;
}

/**
 * Normalize any persisted value to a valid mode. Absent / unrecognized values
 * (including whitespace, arrays, malformed JSON strings) fall back to
 * `same-window` (R-4) — never throws, never fails.
 */
export function normalizeAppPresentation(raw: unknown): AppPresentation {
  return recognizePresentation(raw) ?? DEFAULT_APP_PRESENTATION;
}

/** Coerce a raw persisted value into a clean `appId → mode` map (never throws). */
function toPresentationMap(raw: unknown): Record<string, AppPresentation> {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, AppPresentation> = {};
  for (const [appId, value] of Object.entries(raw as Record<string, unknown>)) {
    out[appId] = normalizeAppPresentation(value);
  }
  return out;
}

/**
 * Parse the RAW canonical map value read from the control plane. An
 * authoritative ABSENT (`null`) / empty / malformed value resolves to an empty
 * map, so every app falls back to `DEFAULT_APP_PRESENTATION` (`same-window`).
 */
function parseCanonicalMap(raw: string | null): unknown {
  if (raw == null || raw === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * True when the registered feature for `appId` intentionally supports multiple
 * simultaneous instances. A factory app can never own a single separate window,
 * so its effective mode is forced to the default (Architect decision 6).
 */
function isMultiWindowApp(appId: string): boolean {
  return getApplications().some((feature) => feature.id === appId && feature.isMultiWindow);
}

/**
 * The effective mode for `appId`: `map[appId] ?? DEFAULT`. Defensively returns
 * `same-window` for any app whose registered feature has `isMultiWindow` true,
 * regardless of a stored value.
 */
export function getAppPresentation(appId: string): AppPresentation {
  if (isMultiWindowApp(appId)) return DEFAULT_APP_PRESENTATION;
  return map[appId] ?? DEFAULT_APP_PRESENTATION;
}

/**
 * Snapshot of the persisted per-app map (stable ref until the next mutation) —
 * the `useSyncExternalStore` read. Consumers that need the EFFECTIVE mode for an
 * app (factory normalization) must use `getAppPresentation`/`useAppPresentation`.
 */
export function getAppPresentationSnapshot(): Readonly<Record<string, AppPresentation>> {
  return map;
}

/** Subscribe to map changes (useSyncExternalStore listener contract). */
export function subscribeAppPresentation(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** True once the persisted map has been read (the hydration gate). */
export function isAppPresentationHydrated(): boolean {
  return hydrated;
}

/**
 * Hydrate the store from the persisted map. Idempotent + runs ONCE (module
 * scope, not per-consumer-mount): a second call returns the same in-flight
 * promise. It never overwrites an app the user has already written (per-app
 * dirty guard), and always settles the `hydrated` flag in `finally` so the gate
 * is bounded even when the read fails. It NEVER writes back (the legacy key and
 * the canonical key are left untouched).
 */
export function hydrateAppPresentation(): Promise<void> {
  if (hydrationStarted) return hydrationPromise ?? Promise.resolve();
  hydrationStarted = true;
  hydrationPromise = (async () => {
    try {
      const rawMap = await getControlSetting(APP_PRESENTATION_KEY);
      const stored = toPresentationMap(parseCanonicalMap(rawMap));
      // One-way legacy migration: only when the map has no `terminal` entry.
      if (!Object.prototype.hasOwnProperty.call(stored, 'terminal')) {
        const rawLegacy = await getControlSetting(LEGACY_TERMINAL_PRESENTATION_KEY);
        const legacyMode = recognizePresentation(rawLegacy);
        if (legacyMode) stored.terminal = legacyMode;
      }
      let changed = false;
      const next: Record<string, AppPresentation> = { ...map };
      for (const [appId, mode] of Object.entries(stored)) {
        if (dirtyAppIds.has(appId)) continue;
        if (next[appId] !== mode) {
          next[appId] = mode;
          changed = true;
        }
      }
      if (changed) map = next;
    } catch {
      // Tauri absent / read failure → stay on the defaults.
    } finally {
      hydrated = true;
      notify();
    }
  })();
  return hydrationPromise;
}

/**
 * Set an app's mode. The module store moves SYNCHRONOUSLY and subscribers are
 * notified BEFORE the KV write is awaited (optimistic UI). On a rejected write
 * the prior value is restored and the rejection is re-thrown so the caller can
 * surface the failure. Hydration is awaited before persisting so a write made
 * before the first hydrate cannot drop other apps' stored entries.
 */
export async function setAppPresentation(appId: string, mode: AppPresentation): Promise<void> {
  const hadPrior = Object.prototype.hasOwnProperty.call(map, appId);
  const prior = map[appId];
  dirtyAppIds.add(appId);
  if (map[appId] !== mode) {
    map = { ...map, [appId]: mode };
    notify();
  }
  try {
    // Never persist a partial map before hydration has merged the stored entries.
    await hydrateAppPresentation();
    await saveControlSetting(APP_PRESENTATION_KEY, JSON.stringify(map));
  } catch (err) {
    // Restore the prior value only if this write still owns the current value
    // (a newer write supersedes a slow rejected one — do not clobber it).
    if (map[appId] === mode) {
      if (hadPrior) {
        map = { ...map, [appId]: prior };
      } else {
        const next: Record<string, AppPresentation> = {};
        for (const [key, value] of Object.entries(map)) {
          if (key !== appId) next[key] = value;
        }
        map = next;
      }
      notify();
    }
    throw err;
  }
}

/** React binding — the effective mode for one app (re-renders on any change). */
export function useAppPresentation(appId: string): AppPresentation {
  return useSyncExternalStore(
    subscribeAppPresentation,
    () => getAppPresentation(appId),
    () => getAppPresentation(appId),
  );
}

/** React binding — the persisted per-app map (stable snapshot until a mutation). */
export function useAppPresentationMap(): Readonly<Record<string, AppPresentation>> {
  return useSyncExternalStore(
    subscribeAppPresentation,
    getAppPresentationSnapshot,
    getAppPresentationSnapshot,
  );
}

/** Test-only: wipe the module-scoped store. Never call from app code. */
export function resetAppPresentationStoreForTests(): void {
  map = {};
  hydrated = false;
  hydrationStarted = false;
  hydrationPromise = null;
  dirtyAppIds.clear();
  listeners.clear();
}
