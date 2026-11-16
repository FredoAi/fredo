/**
 * The installed-application registry — a store SEPARATE from the built-in
 * `applicationRegistry` (Spec #3147, ST-6).
 *
 * # Why it is separate, and why it lives under `shared/`
 *
 * Fredo's built-in applications live in a snapshot registry
 * (`applications/applicationRegistry.ts`) whose membership is pinned by
 * `retainedApplicationSet.test.ts` to exactly eight ids, and whose list
 * `Home.tsx` snapshots at module evaluation. An installed application is a
 * **second trust tier**: it must never join that set merely because it
 * installed successfully.
 *
 * The directory is `shared/installed-apps/` **deliberately**:
 * `applications/allApplications.ts:3` eagerly globs `./*&#47;index.ts`, so a
 * directory under `applications/` would be auto-imported into the host bundle
 * and become a built-in by accident. Nothing here calls `registerApplication()`,
 * and `getApplications()` cannot observe an installed app.
 *
 * # Persistence across mount/unmount
 *
 * The list lives at MODULE scope (never a `useRef`, which resets on every
 * component mount/unmount cycle). The settings pane and the launcher are
 * mounted in different trees at different times; both read the same snapshot,
 * so recording an install in the pane is immediately visible to the launcher.
 *
 * # Not a startup reader (R-5.5)
 *
 * Nothing refreshes at module load. `refreshInstalledApps()` is called by a
 * USER ACTION — the settings pane mounting, or the launcher being engaged — so
 * Fredo's startup cost never grows with the number of installed applications.
 *
 * This module is React-free on purpose: the React bindings live in
 * `useInstalledApps.ts`, so the state machine can be unit-tested without a
 * renderer.
 */

import { installedAppErrorFrom, listInstalledApps } from './client';
import type { InstalledAppEntry, InstalledAppError } from './types';

/**
 * The module-scoped snapshot. Frozen so a consumer cannot mutate the store by
 * mutating the array it was handed.
 */
let entries: readonly InstalledAppEntry[] = Object.freeze([]);

const listeners = new Set<() => void>();

/**
 * The last list-read failure, or `null`.
 *
 * `list-load-failed` is a state of its own: a failed fetch is a verdict on
 * screen, never a silently-empty registry (which would teach the user that
 * nothing is installed when the truth is that listing broke).
 */
let listError: InstalledAppError | null = null;

/** True while a list read is in flight (the pane's loading state). */
let loading = false;

/** True once at least one read has settled (success or failure). */
let settled = false;

/**
 * Monotonic mutation counter — the STABLE `useSyncExternalStore` snapshot for
 * the derived status (an object rebuilt per real change only, never per
 * unrelated re-render; the AGENTS.md #523 loop guard).
 */
let version = 0;

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/** Sort `installedAt` DESCENDING (newest first) — the pane's documented order. */
function newestFirst(list: readonly InstalledAppEntry[]): InstalledAppEntry[] {
  return [...list].sort((a, b) => {
    if (a.installedAt === b.installedAt) return a.id.localeCompare(b.id);
    return a.installedAt < b.installedAt ? 1 : -1;
  });
}

/** The current list snapshot (stable identity until a real mutation). */
export function getInstalledApps(): readonly InstalledAppEntry[] {
  return entries;
}

/** The last list-read failure, or `null`. */
export function getInstalledAppsListError(): InstalledAppError | null {
  return listError;
}

/** Is a list read in flight? */
export function isInstalledAppsLoading(): boolean {
  return loading;
}

/** Has a list read ever settled? Distinguishes "loading" from "genuinely empty". */
export function isInstalledAppsSettled(): boolean {
  return settled;
}

/** The mutation counter (a primitive `useSyncExternalStore` snapshot). */
export function getInstalledAppsVersion(): number {
  return version;
}

/** Subscribe to store changes (the `useSyncExternalStore` listener contract). */
export function subscribeInstalledApps(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Re-read the registry from the backend.
 *
 * Sets the loading flag synchronously, then replaces the snapshot on success
 * (newest first) or records the failure on rejection. Never throws: the caller
 * is a mount/engage effect, and a rejected promise there would surface as an
 * unhandled rejection rather than a verdict. A failure KEEPS the
 * previously-known entries — a transient read failure must not erase a list the
 * user can still open.
 */
export async function refreshInstalledApps(): Promise<void> {
  loading = true;
  notify();
  try {
    const next = await listInstalledApps();
    entries = Object.freeze(newestFirst(next));
    listError = null;
  } catch (rejection) {
    listError = installedAppErrorFrom(rejection);
  } finally {
    loading = false;
    settled = true;
    notify();
  }
}

/**
 * Record a freshly-installed application.
 *
 * Inserts at the top (newest first), replacing any entry with the same id (a
 * re-record of an id is an update, never a duplicate row). The list error is
 * cleared so a previously-failed listing no longer masks a known-good row.
 */
export function recordInstalledApp(entry: InstalledAppEntry): void {
  const withoutSameId = entries.filter((existing) => existing.id !== entry.id);
  entries = Object.freeze(newestFirst([entry, ...withoutSameId]));
  listError = null;
  notify();
}

/** Test-only: drop every listener and reset the module-scoped state. */
export function resetInstalledAppsStoreForTests(): void {
  entries = Object.freeze([]);
  listError = null;
  loading = false;
  settled = false;
  version = 0;
  listeners.clear();
}
