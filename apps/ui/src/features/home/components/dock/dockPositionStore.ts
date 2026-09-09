/**
 * DockPositionStore — the single module-scoped source of truth for the dock
 * position (Spec #2848 ST-1).
 *
 * The dock-position preference must be shared across separately-mounted
 * consumers: `AppDock` (rendered inside `WindowSystemProvider` at
 * `Home.tsx:192`, mounted only while ≥1 window is open) and the Settings →
 * Appearance control (`ProfileSettingsModal`, a sibling tree). A per-instance
 * `usePersistedSetting`/`useState` would diverge across those trees, so — per
 * the AGENTS module-scoped-state rule — the position lives at MODULE scope
 * (mirroring the `windowStore.ts:19-47` pattern) and both consumers reach it
 * through `useSyncExternalStore`.
 *
 * Persistence: the raw string `'sidebar'|'bottom'` under the `Fredo_dock_position`
 * key via `settingsService` (Tauri `save_setting`/`get_setting` → AppStore
 * SQLite KV, with a localStorage mirror for the Vite dev server). The value is
 * stored as the raw string (NOT JSON-quoted) — `settingsService.set` passes the
 * string through `serializeValue` unquoted (`features/settings/index.tsx:92-95`).
 *
 * Hydration is IDEMPOTENT (once): `settingsService.get(key, DEFAULT)` resolves
 * to a stored value only before the first user write; after the first
 * `setDockPosition` the store is dirty and hydration becomes a no-op, so an
 * in-flight async read can never overwrite an in-flight user selection.
 */

import { useSyncExternalStore } from 'react';
import { settingsService } from '../../../settings';

/** Dock position: left-edge vertical rail (sidebar) or bottom-center bar. */
export type DockPosition = 'sidebar' | 'bottom';
/** AppSettings key (backend AppStore SQLite KV + localStorage mirror). */
export const DOCK_POSITION_KEY = 'Fredo_dock_position';
/** Default position for existing installs / never-saved state. */
export const DEFAULT_DOCK_POSITION: DockPosition = 'sidebar';

let dockPosition: DockPosition = DEFAULT_DOCK_POSITION;
const listeners = new Set<() => void>();
/** True once the user (or hydration) has written the store — setDockPosition
 *  wins over a still-in-flight async hydration read. */
let dirty = false;

function notify(): void {
  for (const listener of listeners) listener();
}

/** Sync module read of the current position. */
export function getDockPosition(): DockPosition {
  return dockPosition;
}

/** Subscribe to position changes (useSyncExternalStore listener contract). */
export function subscribeDockPosition(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Update the position synchronously (notify subscribers immediately so a
 * mounted AppDock repositions on the same tick), then persist via
 * `settingsService`. The store write is synchronous + optimistic; the
 * persistence is awaited by the caller and failures are swallowed (dev server
 * has no Tauri host — the localStorage mirror is the fallback).
 */
export async function setDockPosition(position: DockPosition): Promise<void> {
  dirty = true;
  if (dockPosition !== position) {
    dockPosition = position;
    notify();
  }
  try {
    await settingsService.set(DOCK_POSITION_KEY, position);
  } catch {
    // Persistence is best-effort — the module store already moved (dev server
    // has no Tauri host; the localStorage mirror is the fallback).
  }
}

/**
 * Hydrate the store from the persisted setting. Idempotent + runs ONCE (module
 * scope, not per-consumer-mount): a second call is a no-op after the first
 * completion. It never overwrites an in-flight user selection — once the store
 * is dirty (a `setDockPosition` happened), hydration is skipped.
 */
let hydrationStarted = false;
export async function hydrateDockPosition(): Promise<void> {
  if (hydrationStarted) return;
  hydrationStarted = true;
  try {
    const stored = await settingsService.get<DockPosition>(
      DOCK_POSITION_KEY,
      DEFAULT_DOCK_POSITION,
    );
    if (dirty) return; // user already chose — never clobber
    const next = stored === 'bottom' ? ('bottom' as DockPosition) : DEFAULT_DOCK_POSITION;
    if (next !== dockPosition) {
      dockPosition = next;
      notify();
    }
  } catch {
    // Tauri absent / read failure → stay on the default (jsdom: localStorage
    // fallback yields nothing → 'sidebar').
  }
}

/** Test-only: wipe the module-scoped store. Never call from app code. */
export function resetDockPositionStoreForTests(): void {
  dockPosition = DEFAULT_DOCK_POSITION;
  dirty = false;
  hydrationStarted = false;
  listeners.clear();
}

/** React binding — re-renders the consumer when the position changes. */
export function useDockPosition(): DockPosition {
  return useSyncExternalStore(subscribeDockPosition, getDockPosition, getDockPosition);
}
