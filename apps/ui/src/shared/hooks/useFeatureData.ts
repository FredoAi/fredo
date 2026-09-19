/**
 * useFeatureData — read/watch consumer hooks for the feature-owned data layer
 * (Spec #2896, ST-5).
 *
 * ── Return shapes (contract (f), binding) ────────────────────────────────────
 * `useFeatureRead(ref, args?)`
 *   → `{ rows, version, error, loading }`
 *   `rows`    — the LIVE module-scoped store map for that table ref (stable
 *               identity, mutate in place); `version` — the scope version at
 *               which the read snapshot was taken; `loading` — true until the
 *               read settles.
 * `useFeatureWatch(ref, args)`
 *   → `{ rows, epoch, error, ready }`
 *   `epoch`   — monotonic per-ref counter, advancing ONLY on a real mutation
 *               (derive display state off this primitive — never map
 *               identity/size; the #523 re-render-loop guard).
 *   `ready`   — true once registration (+ the `initial` snapshot) resolved.
 *
 * `error` carries the VERBATIM backend text (`string[]` joined with `; `) and
 * is NEVER swallowed (unlike `shared/lib/featureStore.ts`) — the S6 failure
 * signal / A-13. A `remove` notification is not an error.
 *
 * ── Lifecycle ────────────────────────────────────────────────────────────────
 * - A read re-runs when the stable ref/args key changes; its snapshot seeds the
 *   store at the returned scope version so older notifications are dropped
 *   (R-1.2).
 * - A watch re-registers when the ref/scope/fields key changes and unwatches on
 *   unmount/change; `initial` defaults to `true` so there is no gap at the
 *   registration/snapshot boundary (R-3.2, A-9).
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import {
  featureDataRead,
  featureDataUnwatch,
  featureDataWatch,
} from '../feature-data/client';
import type {
  DataTableRef,
  FeatureDataRow,
  WatchScope,
  WhereFilter,
} from '../feature-data/client';
import { featureRecordKey } from '../feature-data/registry';
import {
  getFeatureEpoch,
  getFeatureRows,
  featureRefKey,
  registerKnownFeatureWatch,
  seedFeatureRows,
  subscribeToFeatureEpoch,
  unregisterKnownFeatureWatch,
} from '../feature-data/store';

/** The read filter args — a subset of the `feature_data_read` args. */
export interface FeatureReadArgs {
  where?: WhereFilter[];
  orderBy?: string;
  limit?: number;
}

export interface FeatureReadResult {
  rows: Map<string, FeatureDataRow>;
  version: number;
  error: string | null;
  loading: boolean;
}

export interface FeatureWatchArgs {
  scope: WatchScope;
  /** Field-granularity narrowing: deliver only when one of these changes. */
  fields?: string[];
  /** Return the current snapshot atomically with registration (default `true`). */
  initial?: boolean;
  /** Backend coalescing window in ms; absent = the backend default (30 ms). */
  flushMs?: number;
}

export interface FeatureWatchResult {
  rows: Map<string, FeatureDataRow>;
  epoch: number;
  error: string | null;
  ready: boolean;
}

/** Normalize a hard named `string[]` rejection (or any error) to display text. */
function describeFeatureDataError(err: unknown): string {
  if (Array.isArray(err)) {
    return err.map((entry) => String(entry)).join('; ');
  }
  if (typeof err === 'string') {
    return err;
  }
  return String(err);
}

/** Stable dep key for read args (inline object literals are safe). */
function stableReadArgsKey(args: FeatureReadArgs): string {
  return JSON.stringify({ where: args.where ?? null, orderBy: args.orderBy ?? null, limit: args.limit ?? null });
}

/** Stable dep key for watch args (scope/fields/flushMs; `initial` defaults true). */
function stableWatchArgsKey(args: FeatureWatchArgs): string {
  return JSON.stringify({
    scope: args.scope,
    fields: args.fields ?? null,
    flushMs: args.flushMs ?? null,
  });
}

/** Human-readable scope description for the Dev Mode probe feed. */
function describeScope(scope: WatchScope): string {
  switch (scope.kind) {
    case 'table':
      return 'table';
    case 'record':
      return `record ${JSON.stringify(scope.key)}`;
    case 'query':
      return `query ${scope.where.map((w) => `${w.field}=${JSON.stringify(w.eq)}`).join(', ')}`;
  }
}

/**
 * Read the current rows for a scope on demand (R-1.1/R-1.3) and seed the store
 * so subsequent notifications are version-guarded against the snapshot.
 */
export function useFeatureRead(ref: DataTableRef, args: FeatureReadArgs = {}): FeatureReadResult {
  const refKey = featureRefKey(ref);
  const argsKey = stableReadArgsKey(args);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Subscribe to real mutations so consumers re-render (stable primitive; the
  // snapshot is the epoch — never the map identity).
  const subscribe = useCallback(
    (listener: () => void) => subscribeToFeatureEpoch(ref, listener),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [refKey],
  );
  useSyncExternalStore(subscribe, () => getFeatureEpoch(ref));

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    featureDataRead({ ref, where: args.where, orderBy: args.orderBy, limit: args.limit })
      .then((result) => {
        if (cancelled) return;
        seedFeatureRows(ref, result.version, result.rows, (row) => featureRecordKey(ref, row));
        setVersion(result.version);
        setError(null);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        const message = describeFeatureDataError(err);
        console.error('[useFeatureRead] feature_data_read failed:', message);
        setError(message);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refKey, argsKey]);

  return { rows: getFeatureRows(ref), version, error, loading };
}

/**
 * Register a table/record/query watch (with optional `fields` narrowing) and
 * return the live rows + the mutation epoch. `initial` defaults to `true` so
 * the snapshot is atomic with registration (no gap — R-3.2).
 */
export function useFeatureWatch(ref: DataTableRef, args: FeatureWatchArgs): FeatureWatchResult {
  const refKey = featureRefKey(ref);
  const argsKey = stableWatchArgsKey(args);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const subscribe = useCallback(
    (listener: () => void) => subscribeToFeatureEpoch(ref, listener),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [refKey],
  );
  const epoch = useSyncExternalStore(subscribe, () => getFeatureEpoch(ref));

  useEffect(() => {
    let cancelled = false;
    let watchId: string | undefined;
    setReady(false);
    const initial = args.initial ?? true;

    featureDataWatch({
      ref,
      scope: args.scope,
      fields: args.fields,
      initial,
      flushMs: args.flushMs,
    })
      .then((result) => {
        if (cancelled) {
          // Unmounted before registration resolved — tear the watch down.
          void featureDataUnwatch({ watchIds: [result.watchId] }).catch((unwatchErr) => {
            console.error('[useFeatureWatch] feature_data_unwatch failed:', unwatchErr);
          });
          return;
        }
        watchId = result.watchId;
        registerKnownFeatureWatch({
          watchId: result.watchId,
          featureId: ref.source === 'canonical' ? null : ref.featureId,
          table: ref.table,
          scope: describeScope(args.scope),
          fields: args.fields ?? null,
          registeredAt: new Date().toISOString(),
        });
        if (result.rows) {
          seedFeatureRows(ref, result.version, result.rows, (row) => featureRecordKey(ref, row));
        }
        setError(null);
        setReady(true);
      })
      .catch((err) => {
        if (cancelled) return;
        const message = describeFeatureDataError(err);
        console.error('[useFeatureWatch] feature_data_watch failed:', message);
        setError(message);
        setReady(false);
      });

    return () => {
      cancelled = true;
      if (watchId !== undefined) {
        unregisterKnownFeatureWatch(watchId);
        void featureDataUnwatch({ watchIds: [watchId] }).catch((unwatchErr) => {
          console.error('[useFeatureWatch] feature_data_unwatch failed:', unwatchErr);
        });
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refKey, argsKey]);

  return { rows: getFeatureRows(ref), epoch, error, ready };
}
