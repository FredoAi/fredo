/**
 * useApplicationData — read/watch consumer hooks for the application-owned data layer
 * (Spec #2896, ST-5).
 *
 * ── Return shapes (contract (f), binding) ────────────────────────────────────
 * `useApplicationRead(ref, args?)`
 *   → `{ rows, version, error, loading }`
 *   `rows`    — the LIVE module-scoped store map for that table ref (stable
 *               identity, mutate in place); `version` — the scope version at
 *               which the read snapshot was taken; `loading` — true until the
 *               read settles.
 * `useApplicationWatch(ref, args)`
 *   → `{ rows, epoch, error, ready }`
 *   `epoch`   — monotonic per-ref counter, advancing ONLY on a real mutation
 *               (derive display state off this primitive — never map
 *               identity/size; the #523 re-render-loop guard).
 *   `ready`   — true once registration (+ the `initial` snapshot) resolved.
 *
 * `error` carries the VERBATIM backend text (`string[]` joined with `; `) and
 * is NEVER swallowed (unlike `shared/lib/applicationStore.ts`) — the S6 failure
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
  applicationDataRead,
  applicationDataUnwatch,
  applicationDataWatch,
} from '../application-data/client';
import type {
  DataTableRef,
  ApplicationDataRow,
  WatchScope,
  WhereFilter,
} from '../application-data/client';
import { applicationRecordKey } from '../application-data/registry';
import {
  getApplicationEpoch,
  getApplicationRows,
  applicationRefKey,
  registerKnownApplicationWatch,
  seedApplicationRows,
  subscribeToApplicationEpoch,
  unregisterKnownApplicationWatch,
} from '../application-data/store';

/** The read filter args — a subset of the `application_data_read` args. */
export interface ApplicationReadArgs {
  where?: WhereFilter[];
  orderBy?: string;
  limit?: number;
}

export interface ApplicationReadResult {
  rows: Map<string, ApplicationDataRow>;
  version: number;
  error: string | null;
  loading: boolean;
}

export interface ApplicationWatchArgs {
  scope: WatchScope;
  /** Field-granularity narrowing: deliver only when one of these changes. */
  fields?: string[];
  /** Return the current snapshot atomically with registration (default `true`). */
  initial?: boolean;
  /** Backend coalescing window in ms; absent = the backend default (30 ms). */
  flushMs?: number;
}

export interface ApplicationWatchResult {
  rows: Map<string, ApplicationDataRow>;
  epoch: number;
  error: string | null;
  ready: boolean;
}

/** Normalize a hard named `string[]` rejection (or any error) to display text. */
function describeApplicationDataError(err: unknown): string {
  if (Array.isArray(err)) {
    return err.map((entry) => String(entry)).join('; ');
  }
  if (typeof err === 'string') {
    return err;
  }
  return String(err);
}

/** Stable dep key for read args (inline object literals are safe). */
function stableReadArgsKey(args: ApplicationReadArgs): string {
  return JSON.stringify({ where: args.where ?? null, orderBy: args.orderBy ?? null, limit: args.limit ?? null });
}

/** Stable dep key for watch args (scope/fields/flushMs; `initial` defaults true). */
function stableWatchArgsKey(args: ApplicationWatchArgs): string {
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
export function useApplicationRead(ref: DataTableRef, args: ApplicationReadArgs = {}): ApplicationReadResult {
  const refKey = applicationRefKey(ref);
  const argsKey = stableReadArgsKey(args);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Subscribe to real mutations so consumers re-render (stable primitive; the
  // snapshot is the epoch — never the map identity).
  const subscribe = useCallback(
    (listener: () => void) => subscribeToApplicationEpoch(ref, listener),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [refKey],
  );
  useSyncExternalStore(subscribe, () => getApplicationEpoch(ref));

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    applicationDataRead({ ref, where: args.where, orderBy: args.orderBy, limit: args.limit })
      .then((result) => {
        if (cancelled) return;
        seedApplicationRows(ref, result.version, result.rows, (row) => applicationRecordKey(ref, row));
        setVersion(result.version);
        setError(null);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        const message = describeApplicationDataError(err);
        console.error('[useApplicationRead] application_data_read failed:', message);
        setError(message);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refKey, argsKey]);

  return { rows: getApplicationRows(ref), version, error, loading };
}

/**
 * Register a table/record/query watch (with optional `fields` narrowing) and
 * return the live rows + the mutation epoch. `initial` defaults to `true` so
 * the snapshot is atomic with registration (no gap — R-3.2).
 */
export function useApplicationWatch(ref: DataTableRef, args: ApplicationWatchArgs): ApplicationWatchResult {
  const refKey = applicationRefKey(ref);
  const argsKey = stableWatchArgsKey(args);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const subscribe = useCallback(
    (listener: () => void) => subscribeToApplicationEpoch(ref, listener),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [refKey],
  );
  const epoch = useSyncExternalStore(subscribe, () => getApplicationEpoch(ref));

  useEffect(() => {
    let cancelled = false;
    let watchId: string | undefined;
    setReady(false);
    const initial = args.initial ?? true;

    applicationDataWatch({
      ref,
      scope: args.scope,
      fields: args.fields,
      initial,
      flushMs: args.flushMs,
    })
      .then((result) => {
        if (cancelled) {
          // Unmounted before registration resolved — tear the watch down.
          void applicationDataUnwatch({ watchIds: [result.watchId] }).catch((unwatchErr) => {
            console.error('[useApplicationWatch] application_data_unwatch failed:', unwatchErr);
          });
          return;
        }
        watchId = result.watchId;
        registerKnownApplicationWatch({
          watchId: result.watchId,
          applicationId: ref.source === 'canonical' ? null : ref.applicationId,
          table: ref.table,
          scope: describeScope(args.scope),
          fields: args.fields ?? null,
          registeredAt: new Date().toISOString(),
        });
        if (result.rows) {
          seedApplicationRows(ref, result.version, result.rows, (row) => applicationRecordKey(ref, row));
        }
        setError(null);
        setReady(true);
      })
      .catch((err) => {
        if (cancelled) return;
        const message = describeApplicationDataError(err);
        console.error('[useApplicationWatch] application_data_watch failed:', message);
        setError(message);
        setReady(false);
      });

    return () => {
      cancelled = true;
      if (watchId !== undefined) {
        unregisterKnownApplicationWatch(watchId);
        void applicationDataUnwatch({ watchIds: [watchId] }).catch((unwatchErr) => {
          console.error('[useApplicationWatch] application_data_unwatch failed:', unwatchErr);
        });
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refKey, argsKey]);

  return { rows: getApplicationRows(ref), epoch, error, ready };
}
