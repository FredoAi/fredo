/**
 * Application-data store (Spec #2896, ST-5).
 *
 * A module-scoped store keyed by TABLE REF (one partition per table, shared by
 * every consumer of that table — consumer-side filtering is the documented
 * pattern, mirroring the RTDB row store's per-eventType partitions). Module
 * scope is deliberate: application mounts/unmounts must not wipe live rows
 * (AGENTS.md persistence rule — React refs reset on every mount).
 *
 * ── Merge semantics (pinned by R-1.2 / R-2 / R-3) ─────────────────────────────
 * - `insert` = spread-merge `{ ...prev, ...values }` so init-time fields
 *   survive later notifications (a first sight adopts the values as the row).
 * - `update` = `{ ...row, ...values }` (the backend projects the FULL current
 *   row, so the merge is idempotent and never loses a field).
 * - `remove` = delete the record (no value is ever asserted — R-3.4).
 * - The per-record version guard drops any notification whose `version` is at
 *   or below the last applied version for that record (R-1.2 — a stale
 *   snapshot is never presented as current). The read/watch snapshot seeds the
 *   last applied version, so a late delivery older than the snapshot is
 *   dropped; a first sight always applies.
 * - `epoch` is a monotonic per-partition counter advancing ONLY on a real
 *   mutation (never map identity/size) — the `StreamContext.tsx:123-128`
 *   primitive that kills the #523 re-render-loop class at the API level.
 *
 * ── Notification log (A-12 probe feed) ───────────────────────────────────────
 * A capped (512) module-scoped feed records every received notification with
 * whether the store applied it, so the Dev Mode → Application Data surface shows
 * per-watch deliveries AND non-deliveries/drops (sibling-field isolation,
 * stale drops) as screenshot-visible evidence.
 */

import type { DataTableRef, ApplicationDataRow } from './client';
import type { ApplicationChangeKind, ApplicationRowNotification } from '../classes/EventSubscription';

// ── Partitions ───────────────────────────────────────────────────────────────

interface ApplicationPartition {
  rows: Map<string, ApplicationDataRow>;
  /** Last applied notification version per record key — the R-1.2 stale guard. */
  versions: Map<string, number>;
  epoch: number;
  listeners: Set<() => void>;
}

const partitions = new Map<string, ApplicationPartition>();

/** Stable partition key for a table ref — `application:<id>:<table>` / `canonical:<table>`. */
export function applicationRefKey(ref: DataTableRef): string {
  return ref.source === 'canonical'
    ? `canonical:${ref.table}`
    : `application:${ref.applicationId}:${ref.table}`;
}

/** Partition key for a delivered notification (canonical watches carry `applicationId: null`). */
function notificationRefKey(notification: ApplicationRowNotification): string {
  return notification.applicationId === null
    ? `canonical:${notification.table}`
    : `application:${notification.applicationId}:${notification.table}`;
}

function partitionFor(refKey: string): ApplicationPartition {
  let partition = partitions.get(refKey);
  if (!partition) {
    partition = { rows: new Map(), versions: new Map(), epoch: 0, listeners: new Set() };
    partitions.set(refKey, partition);
  }
  return partition;
}

function bumpEpoch(partition: ApplicationPartition): void {
  partition.epoch += 1;
  for (const listener of partition.listeners) {
    listener();
  }
}

/** Stable record key from the primary-key values (declaration order preserved). */
function recordKey(key: readonly unknown[]): string {
  return JSON.stringify(key);
}

/** Flat declared/canonical rows only — shallow equality decides a real mutation. */
function shallowRecordEqual(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (a[key] !== b[key]) return false;
  }
  return true;
}

// ── Apply ────────────────────────────────────────────────────────────────────

interface ApplyOutcome {
  partition: ApplicationPartition;
  mutated: boolean;
}

function applyNotificationInner(notification: ApplicationRowNotification): ApplyOutcome {
  const partition = partitionFor(notificationRefKey(notification));
  const key = recordKey(notification.key);

  if (notification.kind === 'remove') {
    const last = partition.versions.get(key);
    if (last !== undefined && notification.version <= last) {
      return { partition, mutated: false };
    }
    if (!partition.rows.has(key)) {
      return { partition, mutated: false };
    }
    partition.rows.delete(key);
    partition.versions.delete(key);
    return { partition, mutated: true };
  }

  const incoming = (notification.values ?? {}) as Record<string, unknown>;
  const last = partition.versions.get(key);
  if (last !== undefined && notification.version <= last) {
    // R-1.2 — a notification at/below the last applied version is stale.
    return { partition, mutated: false };
  }

  const prev = partition.rows.get(key);
  if (!prev) {
    // First sight of the key — the notification IS the row (full current values).
    partition.rows.set(key, { ...incoming } as ApplicationDataRow);
    partition.versions.set(key, notification.version);
    return { partition, mutated: true };
  }

  const merged = { ...prev, ...incoming } as ApplicationDataRow;
  partition.versions.set(key, notification.version);
  if (shallowRecordEqual(prev, merged)) {
    return { partition, mutated: false };
  }
  partition.rows.set(key, merged);
  return { partition, mutated: true };
}

/**
 * Apply one notification to the store. Returns `true` iff the store mutated
 * (an applied insert/update/remove). A stale-dropped or content-identical
 * notification returns `false` and never advances the epoch.
 */
export function applyApplicationNotification(notification: ApplicationRowNotification): boolean {
  const outcome = applyNotificationInner(notification);
  recordApplicationNotification(notification, outcome.mutated);
  if (outcome.mutated) {
    bumpEpoch(outcome.partition);
  }
  return outcome.mutated;
}

/**
 * Apply a batch of notifications (the `{"applicationBatch": [...]}` envelope).
 * Every element carries the exact single-notification semantics; each TOUCHED
 * partition advances its epoch exactly ONCE per batch, so a flush that coalesces
 * many records costs one render per partition.
 */
export function applyApplicationDeliveries(
  notifications: readonly ApplicationRowNotification[],
): void {
  const touched = new Set<ApplicationPartition>();
  for (const notification of notifications) {
    const outcome = applyNotificationInner(notification);
    recordApplicationNotification(notification, outcome.mutated);
    if (outcome.mutated) {
      touched.add(outcome.partition);
    }
  }
  for (const partition of touched) {
    bumpEpoch(partition);
  }
}

/**
 * Seed the store from a read/watch snapshot taken at `version` (R-1.2/R-1.3).
 * Rows whose record key cannot be derived (`keyOf` → `null`) are skipped.
 * A snapshot older than an already-applied notification never regresses the
 * store (the per-record guard); otherwise each seeded record's last applied
 * version becomes `max(version, previous)`, so an out-of-order delivery older
 * than the snapshot is dropped once the snapshot has landed.
 *
 * Returns the number of records that actually mutated the store.
 */
export function seedApplicationRows(
  ref: DataTableRef,
  version: number,
  rows: readonly Record<string, unknown>[],
  keyOf: (row: Record<string, unknown>) => unknown[] | null,
): number {
  const partition = partitionFor(applicationRefKey(ref));
  let mutated = 0;
  for (const row of rows) {
    const key = keyOf(row);
    if (key === null) continue;
    const record = recordKey(key);
    const last = partition.versions.get(record);
    if (last !== undefined && version < last) {
      // The store already holds a newer notification for this record.
      continue;
    }
    const next = { ...row } as ApplicationDataRow;
    const prev = partition.rows.get(record);
    partition.versions.set(record, Math.max(version, last ?? 0));
    if (!prev) {
      partition.rows.set(record, next);
      mutated += 1;
      continue;
    }
    const merged = { ...prev, ...next } as ApplicationDataRow;
    if (!shallowRecordEqual(prev, merged)) {
      partition.rows.set(record, merged);
      mutated += 1;
    }
  }
  if (mutated > 0) {
    bumpEpoch(partition);
  }
  return mutated;
}

// ── Read accessors ───────────────────────────────────────────────────────────

/** Live rows map for one table ref (stable identity; mutate in place). */
export function getApplicationRows(ref: DataTableRef): Map<string, ApplicationDataRow> {
  return partitionFor(applicationRefKey(ref)).rows;
}

/** Monotonic epoch for one table ref — advances only on a real mutation. */
export function getApplicationEpoch(ref: DataTableRef): number {
  return partitionFor(applicationRefKey(ref)).epoch;
}

/** Subscribe to epoch changes for one table ref (useSyncExternalStore). */
export function subscribeToApplicationEpoch(
  ref: DataTableRef,
  listener: () => void,
): () => void {
  const partition = partitionFor(applicationRefKey(ref));
  partition.listeners.add(listener);
  return () => {
    partition.listeners.delete(listener);
  };
}

// ── Notification log (A-12 Dev Mode probe feed) ──────────────────────────────

/** One received application-data notification, in arrival order. */
export interface ApplicationNotificationLogEntry {
  /** Stable identity — `${seq}:${watchId}:${table}:${version}:${kind}`. */
  id: string;
  watchId: string;
  applicationId: string | null;
  table: string;
  kind: ApplicationChangeKind;
  key: unknown[];
  changedFields: string[];
  version: number;
  timestamp: string;
  /** `true` when the store applied it; `false` = stale-dropped / no-op / absent remove. */
  applied: boolean;
}

/** A watch registered through `useApplicationWatch` — lets Dev Mode show 0-delivery watches. */
export interface KnownApplicationWatch {
  watchId: string;
  applicationId: string | null;
  table: string;
  /** Human-readable scope description (`table` | `record [..]` | `query {...}`). */
  scope: string;
  fields: string[] | null;
  registeredAt: string;
}

const applicationNotificationLog: ApplicationNotificationLogEntry[] = [];
const APPLICATION_NOTIFICATION_LOG_CAP = 512;
let applicationNotificationLogVersion = 0;
let applicationNotificationSeq = 0;

const applicationNotificationLogListeners = new Set<() => void>();

const knownApplicationWatches = new Map<string, KnownApplicationWatch>();

function recordApplicationNotification(
  notification: ApplicationRowNotification,
  applied: boolean,
): void {
  applicationNotificationSeq += 1;
  applicationNotificationLog.push({
    id: `${applicationNotificationSeq}:${notification.watchId}:${notification.table}:${notification.version}:${notification.kind}`,
    watchId: notification.watchId,
    applicationId: notification.applicationId,
    table: notification.table,
    kind: notification.kind,
    key: notification.key,
    changedFields: notification.changedFields,
    version: notification.version,
    timestamp: notification.timestamp,
    applied,
  });
  if (applicationNotificationLog.length > APPLICATION_NOTIFICATION_LOG_CAP) {
    applicationNotificationLog.splice(
      0,
      applicationNotificationLog.length - APPLICATION_NOTIFICATION_LOG_CAP,
    );
  }
  bumpApplicationNotificationLogVersion();
}

function bumpApplicationNotificationLogVersion(): void {
  applicationNotificationLogVersion += 1;
  for (const listener of applicationNotificationLogListeners) {
    listener();
  }
}

/** Snapshot of the recent application-data notifications (oldest-first, capped at 512). */
export function getApplicationNotifications(): readonly ApplicationNotificationLogEntry[] {
  return applicationNotificationLog;
}

/** Monotonic version of the notification log — advances on every record/clear. */
export function getApplicationNotificationLogVersion(): number {
  return applicationNotificationLogVersion;
}

/** Subscribe to application-data notification-log changes (Dev Mode feed). */
export function subscribeToApplicationNotificationLog(listener: () => void): () => void {
  applicationNotificationLogListeners.add(listener);
  return () => {
    applicationNotificationLogListeners.delete(listener);
  };
}

/** Clear the notification log (the Dev Mode feed's Clear action). */
export function clearApplicationNotifications(): void {
  applicationNotificationLog.length = 0;
  applicationNotificationSeq = 0;
  bumpApplicationNotificationLogVersion();
}

/**
 * Register a watch created by `useApplicationWatch` so the Dev Mode feed can show
 * it with its delivery count — including a 0-delivery watch (sibling-field
 * isolation evidence). IPC-driven watches are still visible via the log.
 */
export function registerKnownApplicationWatch(watch: KnownApplicationWatch): void {
  knownApplicationWatches.set(watch.watchId, watch);
  bumpApplicationNotificationLogVersion();
}

/** Remove a known watch (unregistered by `useApplicationWatch` on teardown). */
export function unregisterKnownApplicationWatch(watchId: string): void {
  if (knownApplicationWatches.delete(watchId)) {
    bumpApplicationNotificationLogVersion();
  }
}

/** Snapshot of the known (hook-registered) watches. */
export function getKnownApplicationWatches(): readonly KnownApplicationWatch[] {
  return [...knownApplicationWatches.values()];
}

/**
 * Test-only: wipe every partition (rows/versions/epochs) and the notification
 * log + known watches. Listeners survive (they belong to live subscriptions).
 */
export function resetApplicationDataStoreForTests(): void {
  partitions.clear();
  applicationNotificationLog.length = 0;
  applicationNotificationSeq = 0;
  knownApplicationWatches.clear();
  bumpApplicationNotificationLogVersion();
}
