/**
 * Feature-data store (Spec #2896, ST-5).
 *
 * A module-scoped store keyed by TABLE REF (one partition per table, shared by
 * every consumer of that table — consumer-side filtering is the documented
 * pattern, mirroring the RTDB row store's per-eventType partitions). Module
 * scope is deliberate: feature mounts/unmounts must not wipe live rows
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
 * whether the store applied it, so the Dev Mode → Feature Data surface shows
 * per-watch deliveries AND non-deliveries/drops (sibling-field isolation,
 * stale drops) as screenshot-visible evidence.
 */

import type { DataTableRef, FeatureDataRow } from './client';
import type { FeatureChangeKind, FeatureRowNotification } from '../classes/EventSubscription';

// ── Partitions ───────────────────────────────────────────────────────────────

interface FeaturePartition {
  rows: Map<string, FeatureDataRow>;
  /** Last applied notification version per record key — the R-1.2 stale guard. */
  versions: Map<string, number>;
  epoch: number;
  listeners: Set<() => void>;
}

const partitions = new Map<string, FeaturePartition>();

/** Stable partition key for a table ref — `feature:<id>:<table>` / `canonical:<table>`. */
export function featureRefKey(ref: DataTableRef): string {
  return ref.source === 'canonical'
    ? `canonical:${ref.table}`
    : `feature:${ref.featureId}:${ref.table}`;
}

/** Partition key for a delivered notification (canonical watches carry `featureId: null`). */
function notificationRefKey(notification: FeatureRowNotification): string {
  return notification.featureId === null
    ? `canonical:${notification.table}`
    : `feature:${notification.featureId}:${notification.table}`;
}

function partitionFor(refKey: string): FeaturePartition {
  let partition = partitions.get(refKey);
  if (!partition) {
    partition = { rows: new Map(), versions: new Map(), epoch: 0, listeners: new Set() };
    partitions.set(refKey, partition);
  }
  return partition;
}

function bumpEpoch(partition: FeaturePartition): void {
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
  partition: FeaturePartition;
  mutated: boolean;
}

function applyNotificationInner(notification: FeatureRowNotification): ApplyOutcome {
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
    partition.rows.set(key, { ...incoming } as FeatureDataRow);
    partition.versions.set(key, notification.version);
    return { partition, mutated: true };
  }

  const merged = { ...prev, ...incoming } as FeatureDataRow;
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
export function applyFeatureNotification(notification: FeatureRowNotification): boolean {
  const outcome = applyNotificationInner(notification);
  recordFeatureNotification(notification, outcome.mutated);
  if (outcome.mutated) {
    bumpEpoch(outcome.partition);
  }
  return outcome.mutated;
}

/**
 * Apply a batch of notifications (the `{"featureBatch": [...]}` envelope).
 * Every element carries the exact single-notification semantics; each TOUCHED
 * partition advances its epoch exactly ONCE per batch, so a flush that coalesces
 * many records costs one render per partition.
 */
export function applyFeatureDeliveries(
  notifications: readonly FeatureRowNotification[],
): void {
  const touched = new Set<FeaturePartition>();
  for (const notification of notifications) {
    const outcome = applyNotificationInner(notification);
    recordFeatureNotification(notification, outcome.mutated);
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
export function seedFeatureRows(
  ref: DataTableRef,
  version: number,
  rows: readonly Record<string, unknown>[],
  keyOf: (row: Record<string, unknown>) => unknown[] | null,
): number {
  const partition = partitionFor(featureRefKey(ref));
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
    const next = { ...row } as FeatureDataRow;
    const prev = partition.rows.get(record);
    partition.versions.set(record, Math.max(version, last ?? 0));
    if (!prev) {
      partition.rows.set(record, next);
      mutated += 1;
      continue;
    }
    const merged = { ...prev, ...next } as FeatureDataRow;
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
export function getFeatureRows(ref: DataTableRef): Map<string, FeatureDataRow> {
  return partitionFor(featureRefKey(ref)).rows;
}

/** Monotonic epoch for one table ref — advances only on a real mutation. */
export function getFeatureEpoch(ref: DataTableRef): number {
  return partitionFor(featureRefKey(ref)).epoch;
}

/** Subscribe to epoch changes for one table ref (useSyncExternalStore). */
export function subscribeToFeatureEpoch(
  ref: DataTableRef,
  listener: () => void,
): () => void {
  const partition = partitionFor(featureRefKey(ref));
  partition.listeners.add(listener);
  return () => {
    partition.listeners.delete(listener);
  };
}

// ── Notification log (A-12 Dev Mode probe feed) ──────────────────────────────

/** One received feature-data notification, in arrival order. */
export interface FeatureNotificationLogEntry {
  /** Stable identity — `${seq}:${watchId}:${table}:${version}:${kind}`. */
  id: string;
  watchId: string;
  featureId: string | null;
  table: string;
  kind: FeatureChangeKind;
  key: unknown[];
  changedFields: string[];
  version: number;
  timestamp: string;
  /** `true` when the store applied it; `false` = stale-dropped / no-op / absent remove. */
  applied: boolean;
}

/** A watch registered through `useFeatureWatch` — lets Dev Mode show 0-delivery watches. */
export interface KnownFeatureWatch {
  watchId: string;
  featureId: string | null;
  table: string;
  /** Human-readable scope description (`table` | `record [..]` | `query {...}`). */
  scope: string;
  fields: string[] | null;
  registeredAt: string;
}

const featureNotificationLog: FeatureNotificationLogEntry[] = [];
const FEATURE_NOTIFICATION_LOG_CAP = 512;
let featureNotificationLogVersion = 0;
let featureNotificationSeq = 0;

const featureNotificationLogListeners = new Set<() => void>();

const knownFeatureWatches = new Map<string, KnownFeatureWatch>();

function recordFeatureNotification(
  notification: FeatureRowNotification,
  applied: boolean,
): void {
  featureNotificationSeq += 1;
  featureNotificationLog.push({
    id: `${featureNotificationSeq}:${notification.watchId}:${notification.table}:${notification.version}:${notification.kind}`,
    watchId: notification.watchId,
    featureId: notification.featureId,
    table: notification.table,
    kind: notification.kind,
    key: notification.key,
    changedFields: notification.changedFields,
    version: notification.version,
    timestamp: notification.timestamp,
    applied,
  });
  if (featureNotificationLog.length > FEATURE_NOTIFICATION_LOG_CAP) {
    featureNotificationLog.splice(
      0,
      featureNotificationLog.length - FEATURE_NOTIFICATION_LOG_CAP,
    );
  }
  bumpFeatureNotificationLogVersion();
}

function bumpFeatureNotificationLogVersion(): void {
  featureNotificationLogVersion += 1;
  for (const listener of featureNotificationLogListeners) {
    listener();
  }
}

/** Snapshot of the recent feature-data notifications (oldest-first, capped at 512). */
export function getFeatureNotifications(): readonly FeatureNotificationLogEntry[] {
  return featureNotificationLog;
}

/** Monotonic version of the notification log — advances on every record/clear. */
export function getFeatureNotificationLogVersion(): number {
  return featureNotificationLogVersion;
}

/** Subscribe to feature-data notification-log changes (Dev Mode feed). */
export function subscribeToFeatureNotificationLog(listener: () => void): () => void {
  featureNotificationLogListeners.add(listener);
  return () => {
    featureNotificationLogListeners.delete(listener);
  };
}

/** Clear the notification log (the Dev Mode feed's Clear action). */
export function clearFeatureNotifications(): void {
  featureNotificationLog.length = 0;
  featureNotificationSeq = 0;
  bumpFeatureNotificationLogVersion();
}

/**
 * Register a watch created by `useFeatureWatch` so the Dev Mode feed can show
 * it with its delivery count — including a 0-delivery watch (sibling-field
 * isolation evidence). IPC-driven watches are still visible via the log.
 */
export function registerKnownFeatureWatch(watch: KnownFeatureWatch): void {
  knownFeatureWatches.set(watch.watchId, watch);
  bumpFeatureNotificationLogVersion();
}

/** Remove a known watch (unregistered by `useFeatureWatch` on teardown). */
export function unregisterKnownFeatureWatch(watchId: string): void {
  if (knownFeatureWatches.delete(watchId)) {
    bumpFeatureNotificationLogVersion();
  }
}

/** Snapshot of the known (hook-registered) watches. */
export function getKnownFeatureWatches(): readonly KnownFeatureWatch[] {
  return [...knownFeatureWatches.values()];
}

/**
 * Test-only: wipe every partition (rows/versions/epochs) and the notification
 * log + known watches. Listeners survive (they belong to live subscriptions).
 */
export function resetFeatureDataStoreForTests(): void {
  partitions.clear();
  featureNotificationLog.length = 0;
  featureNotificationSeq = 0;
  knownFeatureWatches.clear();
  bumpFeatureNotificationLogVersion();
}
