/**
 * ApplicationDataContext — the React accessor for the module-scoped application-data
 * store (Spec #2896, ST-5).
 *
 * The store itself lives at module scope (`shared/application-data/store.ts`) so it
 * survives application mount/unmount cycles (the AGENTS.md persistence rule). This
 * context exposes exactly that singleton through React: the value is created
 * ONCE at module scope, so its identity is stable and `rows` maps are mutated
 * in place rather than replaced. `useApplicationDataStore()` is the accessor for
 * components; the `useApplicationRead`/`useApplicationWatch` hooks read the same store.
 */

import React, { createContext, useContext } from 'react';
import type {
  DataTableRef,
  ApplicationDataRow,
  ApplicationRowNotification,
} from '../application-data/client';
import {
  applyApplicationDeliveries,
  applicationRefKey,
  getApplicationEpoch,
  getApplicationRows,
  registerKnownApplicationWatch,
  seedApplicationRows,
  subscribeToApplicationEpoch,
  unregisterKnownApplicationWatch,
  type KnownApplicationWatch,
} from '../application-data/store';

/** The stable store facade exposed through the context. */
export interface ApplicationDataStoreApi {
  /** Stable partition key for a table ref. */
  refKey(ref: DataTableRef): string;
  /** Live rows map for a table ref (stable identity; mutate in place). */
  getRows(ref: DataTableRef): Map<string, ApplicationDataRow>;
  /** Monotonic epoch for a table ref (advances only on a real mutation). */
  getEpoch(ref: DataTableRef): number;
  /** Subscribe to epoch changes for a table ref. */
  subscribe(ref: DataTableRef, listener: () => void): () => void;
  /** Apply a `applicationBatch` payload to the store. */
  applyDeliveries(notifications: readonly ApplicationRowNotification[]): void;
  /** Seed a read/watch snapshot at `version` (R-1.2/R-1.3). */
  seedRows(
    ref: DataTableRef,
    version: number,
    rows: readonly Record<string, unknown>[],
    keyOf: (row: Record<string, unknown>) => unknown[] | null,
  ): number;
  /** Register/unregister a known watch (Dev Mode 0-delivery evidence). */
  registerWatch(watch: KnownApplicationWatch): void;
  unregisterWatch(watchId: string): void;
}

/** Module-scoped singleton — stable identity across every provider/consumer. */
const applicationDataStoreApi: ApplicationDataStoreApi = {
  refKey: applicationRefKey,
  getRows: getApplicationRows,
  getEpoch: getApplicationEpoch,
  subscribe: subscribeToApplicationEpoch,
  applyDeliveries: applyApplicationDeliveries,
  seedRows: seedApplicationRows,
  registerWatch: registerKnownApplicationWatch,
  unregisterWatch: unregisterKnownApplicationWatch,
};

const ApplicationDataContext = createContext<ApplicationDataStoreApi>(applicationDataStoreApi);

export function ApplicationDataProvider({ children }: { children: React.ReactNode }) {
  return (
    <ApplicationDataContext.Provider value={applicationDataStoreApi}>
      {children}
    </ApplicationDataContext.Provider>
  );
}

/** Accessor for the stable application-data store facade. */
export function useApplicationDataStore(): ApplicationDataStoreApi {
  return useContext(ApplicationDataContext);
}
