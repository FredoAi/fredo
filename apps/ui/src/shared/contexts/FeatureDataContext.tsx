/**
 * FeatureDataContext — the React accessor for the module-scoped feature-data
 * store (Spec #2896, ST-5).
 *
 * The store itself lives at module scope (`shared/feature-data/store.ts`) so it
 * survives feature mount/unmount cycles (the AGENTS.md persistence rule). This
 * context exposes exactly that singleton through React: the value is created
 * ONCE at module scope, so its identity is stable and `rows` maps are mutated
 * in place rather than replaced. `useFeatureDataStore()` is the accessor for
 * components; the `useFeatureRead`/`useFeatureWatch` hooks read the same store.
 */

import React, { createContext, useContext } from 'react';
import type {
  DataTableRef,
  FeatureDataRow,
  FeatureRowNotification,
} from '../feature-data/client';
import {
  applyFeatureDeliveries,
  featureRefKey,
  getFeatureEpoch,
  getFeatureRows,
  registerKnownFeatureWatch,
  seedFeatureRows,
  subscribeToFeatureEpoch,
  unregisterKnownFeatureWatch,
  type KnownFeatureWatch,
} from '../feature-data/store';

/** The stable store facade exposed through the context. */
export interface FeatureDataStoreApi {
  /** Stable partition key for a table ref. */
  refKey(ref: DataTableRef): string;
  /** Live rows map for a table ref (stable identity; mutate in place). */
  getRows(ref: DataTableRef): Map<string, FeatureDataRow>;
  /** Monotonic epoch for a table ref (advances only on a real mutation). */
  getEpoch(ref: DataTableRef): number;
  /** Subscribe to epoch changes for a table ref. */
  subscribe(ref: DataTableRef, listener: () => void): () => void;
  /** Apply a `featureBatch` payload to the store. */
  applyDeliveries(notifications: readonly FeatureRowNotification[]): void;
  /** Seed a read/watch snapshot at `version` (R-1.2/R-1.3). */
  seedRows(
    ref: DataTableRef,
    version: number,
    rows: readonly Record<string, unknown>[],
    keyOf: (row: Record<string, unknown>) => unknown[] | null,
  ): number;
  /** Register/unregister a known watch (Dev Mode 0-delivery evidence). */
  registerWatch(watch: KnownFeatureWatch): void;
  unregisterWatch(watchId: string): void;
}

/** Module-scoped singleton — stable identity across every provider/consumer. */
const featureDataStoreApi: FeatureDataStoreApi = {
  refKey: featureRefKey,
  getRows: getFeatureRows,
  getEpoch: getFeatureEpoch,
  subscribe: subscribeToFeatureEpoch,
  applyDeliveries: applyFeatureDeliveries,
  seedRows: seedFeatureRows,
  registerWatch: registerKnownFeatureWatch,
  unregisterWatch: unregisterKnownFeatureWatch,
};

const FeatureDataContext = createContext<FeatureDataStoreApi>(featureDataStoreApi);

export function FeatureDataProvider({ children }: { children: React.ReactNode }) {
  return (
    <FeatureDataContext.Provider value={featureDataStoreApi}>
      {children}
    </FeatureDataContext.Provider>
  );
}

/** Accessor for the stable feature-data store facade. */
export function useFeatureDataStore(): FeatureDataStoreApi {
  return useContext(FeatureDataContext);
}
