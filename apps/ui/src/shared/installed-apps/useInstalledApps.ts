/**
 * React bindings for the installed-application registry (Spec #3147, ST-6).
 *
 * The store itself (`store.ts`) is React-free module state; these hooks are the
 * thin `useSyncExternalStore` bindings the two surfaces use.
 *
 * # Snapshot stability (the AGENTS.md #523 loop guard)
 *
 * `useInstalledApps` returns the store's frozen array, whose identity changes
 * only on a real mutation — so it is safe as an effect dependency.
 *
 * `useInstalledAppsStatus` must return rows AND derived status together, and an
 * object literal is a fresh reference every render; the snapshot it subscribes
 * to is therefore the store's monotonic COUNTER (a primitive), and the object is
 * rebuilt only when that counter actually changes.
 */

import { useSyncExternalStore } from 'react';

import {
  getInstalledApps,
  getInstalledAppsListError,
  getInstalledAppsVersion,
  isInstalledAppsLoading,
  isInstalledAppsSettled,
  subscribeInstalledApps,
} from './store';
import type { InstalledAppEntry, InstalledAppError } from './types';

/**
 * The live installed-application list, newest install first.
 *
 * `ready` for the `useEventRows`-style contract does not apply here: the list is
 * a request/response read, not a row subscription, so the pane distinguishes
 * loading from empty with `useInstalledAppsStatus`.
 */
export function useInstalledApps(): readonly InstalledAppEntry[] {
  return useSyncExternalStore(subscribeInstalledApps, getInstalledApps, getInstalledApps);
}

/** The derived status the settings pane and the launcher read. */
export interface InstalledAppsStatus {
  /** Newest-first rows (stable identity between mutations). */
  readonly entries: readonly InstalledAppEntry[];
  /** A list read is in flight. */
  readonly loading: boolean;
  /** At least one list read has settled (success or failure). */
  readonly settled: boolean;
  /** The last list-read failure — the pane's `list-load-failed` verdict. */
  readonly error: InstalledAppError | null;
}

/** Rows plus derived status in ONE subscription (counter-snapshot stability). */
export function useInstalledAppsStatus(): InstalledAppsStatus {
  useSyncExternalStore(
    subscribeInstalledApps,
    getInstalledAppsVersion,
    getInstalledAppsVersion,
  );
  return {
    entries: getInstalledApps(),
    loading: isInstalledAppsLoading(),
    settled: isInstalledAppsSettled(),
    error: getInstalledAppsListError(),
  };
}
