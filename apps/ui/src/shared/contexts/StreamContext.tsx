/**
 * Stream Context — connection status + the RTDB row store (Spec #2788 P4.1).
 *
 * The v1 delivery queue (`deliveries`/`ADD_DELIVERY`/`deliveryToFredoEvent`),
 * the legacy raw-event array, and the ECE selector hooks were deleted in
 * Spec #2788 P5.1 — RTDB row deliveries are the ONLY thing that crosses IPC,
 * routed by AppProvider straight into the module-scoped row store below.
 * The context itself now carries only the connection flag; the row store is
 * module-scoped and consumed via `useEventRows`.
 */

import React, { createContext, useContext, useState, useCallback, useMemo, useEffect, useSyncExternalStore } from 'react';
import type {
  RowDelivery,
  RowEventType,
  RowChangeKind,
  RtdbRow,
} from '../classes/EventSubscription';
import { rowKeyString } from '../classes/EventSubscription';

/**
 * Stream state interface
 */
interface StreamState {
  isConnected: boolean;
}

/**
 * Stream context value
 */
interface StreamContextValue extends StreamState {
  setConnectionStatus: (connected: boolean) => void;
}

/**
 * Create context
 */
const StreamContext = createContext<StreamContextValue | undefined>(undefined);

/**
 * Provider component
 */
export function StreamProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<StreamState>({ isConnected: false });

  const setConnectionStatus = useCallback((connected: boolean) => {
    setState({ isConnected: connected });
  }, []);

  // Memoize context value
  const value = useMemo<StreamContextValue>(
    () => ({
      ...state,
      setConnectionStatus,
    }),
    [state, setConnectionStatus]
  );

  return <StreamContext.Provider value={value}>{children}</StreamContext.Provider>;
}

/**
 * Hook to use stream context
 */
export function useStream() {
  const context = useContext(StreamContext);
  if (context === undefined) {
    throw new Error('useStream must be used within a StreamProvider');
  }
  return context;
}

export function useConnectionStatus() {
  const { isConnected } = useStream();
  return useMemo(
    () => ({ isConnected }),
    [isConnected]
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// RTDB ROW STORE — Spec #2788 P4.1
// ═══════════════════════════════════════════════════════════════════════════
//
// Module-scoped row store fed by RowDelivery envelopes routed from
// AppProvider (the v1 ContractDelivery pipeline was deleted in P5.1 — this
// is the ONLY delivery path). Semantics (pinned by P4.1):
//
// - `insert` = full-row set; spread-merge into an existing row so init-time
//   fields are never wiped; sets the per-key seq baseline.
// - `update` = `{ ...row, ...patch }` merge; patches with a seq LOWER than
//   the last applied seq for that key are dropped (out-of-order/replayed
//   burst robustness).
// - `remove` = delete key (only ever originates from backend retention
//   eviction); removing an absent key is a no-op.
// - NO cap/TTL eviction of live rows. Replay replaces hydration by
//   re-inserting rows.
//
// The store is module-scoped (not React state) per the AGENTS.md persistence
// rule: feature mounts/unmounts must not wipe live rows. `epoch` is a
// monotonic per-eventType counter that advances ONLY on a real mutation, so
// consumers memo/effect off a stable primitive instead of fresh object
// identities (kills the #523-cycle-1 re-render-loop class at the API level).

interface RowPartition {
  rows: Map<string, RtdbRow>;
  /** Last applied seq per row key — stale-patch detection. */
  seqs: Map<string, number>;
  epoch: number;
  listeners: Set<() => void>;
}

const rowPartitions: Record<RowEventType, RowPartition> = {
  Chat: { rows: new Map(), seqs: new Map(), epoch: 0, listeners: new Set() },
  ToolUse: { rows: new Map(), seqs: new Map(), epoch: 0, listeners: new Set() },
  AgentSession: { rows: new Map(), seqs: new Map(), epoch: 0, listeners: new Set() },
};

function rowPartitionFor(eventType: RowEventType): RowPartition {
  return rowPartitions[eventType];
}

function bumpRowEpoch(partition: RowPartition): void {
  partition.epoch += 1;
  for (const listener of partition.listeners) {
    listener();
  }
}

// ── Row-mutation log (P5.1) ──────────────────────────────────────────────────
//
// A small bounded feed of applied row mutations for the debug surfaces that
// previously consumed the deleted v1 delivery queue (Dev Mode's live stream
// viewer, StreamStatus activity LED). Module-scoped per the AGENTS.md
// persistence rule; capped with oldest-first eviction (bounded state, NFR-2).

/** One applied row mutation, in arrival order. */
export interface RowMutation {
  /** Stable identity — `${eventType}:${sessionId}/${correlationId}#${seq}#${kind}`. */
  id: string;
  eventType: RowEventType;
  kind: RowChangeKind;
  sessionId: string;
  correlationId: string;
  seq: number;
  /** The merged row after this mutation; `null` on `remove`. */
  row: RtdbRow | null;
  /** RFC3339 emission timestamp of the delivery. */
  timestamp: string;
}

const rowMutationLog: RowMutation[] = [];
const ROW_MUTATION_LOG_CAP = 512;
let rowMutationLogVersion = 0;

function recordRowMutation(
  eventType: RowEventType,
  delivery: RowDelivery,
  row: RtdbRow | null,
): void {
  const mutation: RowMutation = {
    id: `${eventType}:${delivery.key.sessionId}/${delivery.key.correlationId}#${delivery.seq}#${delivery.kind}`,
    eventType,
    kind: delivery.kind,
    sessionId: delivery.key.sessionId,
    correlationId: delivery.key.correlationId,
    seq: delivery.seq,
    row,
    timestamp: delivery.timestamp,
  };
  rowMutationLog.push(mutation);
  if (rowMutationLog.length > ROW_MUTATION_LOG_CAP) {
    rowMutationLog.splice(0, rowMutationLog.length - ROW_MUTATION_LOG_CAP);
  }
  rowMutationLogVersion += 1;
}

/** Snapshot of the recent row mutations (oldest-first, capped at 512). */
export function getRowMutations(): readonly RowMutation[] {
  return rowMutationLog;
}

/** Clear the mutation log (the debug viewer's Clear action). */
export function clearRowMutations(): void {
  rowMutationLog.length = 0;
  rowMutationLogVersion += 1;
}

/**
 * Monotonic version of the mutation log — advances on every applied mutation
 * (and on clear). Subscribe via `subscribeToRowMutationLog` with
 * `useSyncExternalStore`; the version is the snapshot primitive.
 */
export function getRowMutationLogVersion(): number {
  return rowMutationLogVersion;
}

/** Subscribe to row-mutation log changes (any row type). */
export function subscribeToRowMutationLog(listener: () => void): () => void {
  const unsubs = (Object.keys(rowPartitions) as RowEventType[]).map((eventType) =>
    subscribeToRowEpoch(eventType, listener),
  );
  return () => {
    for (const unsub of unsubs) unsub();
  };
}

// ── Replay-drain registry (round-3 F-33 fix) ────────────────────────────────
//
// The backend replay leg is a spawned background drain: the snapshot arrives
// as many batch envelopes terminated by a per-query `replayCompleteQueryId`
// marker. While a drain is pending for a partition, epoch bumps from applied
// batches are DEFERRED (marked dirty) and fired as ONE settle bump when the
// drain completes — a full-table replay of ~58k rows (~113 envelopes) costs
// ONE render instead of ~113. With no pending drain the per-batch bump
// behavior is byte-identical to the round-2 semantics. Module-scoped per the
// AGENTS.md persistence rule (refs reset on mount; this state must survive
// remounts while subscriptions re-register).

/** eventType → queryId → settle callback (registered by useEventRows). */
const replayDrains = new Map<RowEventType, Map<string, () => void>>();
/** Partitions whose replay-window mutations are waiting on a settle bump. */
const replayDirtyPartitions = new Set<RowEventType>();
/**
 * Markers that arrived BEFORE their hook registered the drain (the async
 * command returns and the spawned replay leg race — real on small corpora
 * where the drain finishes before the IPC response lands). Buffered so the
 * settling `beginReplayDrain` still observes completion. The consuming hook
 * settles with its own eventType (queryIds are unique per registration, so
 * a buffered marker is only ever consumed by its own subscription). Capped
 * with oldest-first eviction.
 */
const settledUnclaimedMarkers = new Set<string>();
const MAX_SETTLED_UNCLAIMED = 256;

function hasPendingDrain(eventType: RowEventType): boolean {
  return (replayDrains.get(eventType)?.size ?? 0) > 0;
}

/** Fire the deferred settle bump for one partition — at most one, if dirty. */
function settleReplayDrain(eventType: RowEventType): void {
  const partition = rowPartitionFor(eventType);
  if (!partition) return;
  if (replayDirtyPartitions.has(eventType)) {
    replayDirtyPartitions.delete(eventType);
    bumpRowEpoch(partition);
  }
}

/**
 * Register one query's replay drain for `eventType` (round-3 F-33 fix).
 * Called by `useEventRows` at subscribe resolution — BEFORE the marker can
 * settle the drain — with `onSettle` invoked exactly once when the matching
 * `replayCompleteQueryId` marker arrives (or immediately if the marker
 * already landed — the command-return vs background-drain race).
 * While any drain is pending for the partition, applied batches defer their
 * epoch bump; `endReplayDrain`/`cancelReplayDrain` fire the settle bump.
 */
export function beginReplayDrain(
  eventType: RowEventType,
  queryId: string,
  onSettle: () => void,
): void {
  if (settledUnclaimedMarkers.has(queryId)) {
    // Marker-first race: consume the buffered completion and settle now.
    settledUnclaimedMarkers.delete(queryId);
    settleReplayDrain(eventType);
    onSettle();
    return;
  }
  let drains = replayDrains.get(eventType);
  if (!drains) {
    drains = new Map();
    replayDrains.set(eventType, drains);
  }
  drains.set(queryId, onSettle);
}

/**
 * Settle one query's replay drain — the `replayCompleteQueryId` marker
 * arrived (routed from AppProvider AFTER the batch's rows were applied, so
 * the settle bump reflects final rows). Unknown queryIds are buffered: a
 * marker can legitimately precede its hook's `beginReplayDrain` (async
 * command return vs background drain race). A foreign queryId settles
 * nothing.
 */
export function endReplayDrain(queryId: string): void {
  for (const [eventType, drains] of replayDrains) {
    const onSettle = drains.get(queryId);
    if (onSettle === undefined) continue;
    drains.delete(queryId);
    if (drains.size === 0) replayDrains.delete(eventType);
    settleReplayDrain(eventType);
    onSettle();
    return;
  }
  if (settledUnclaimedMarkers.size >= MAX_SETTLED_UNCLAIMED) {
    const oldest = settledUnclaimedMarkers.values().next();
    if (!oldest.done) settledUnclaimedMarkers.delete(oldest.value);
  }
  settledUnclaimedMarkers.add(queryId);
}

/**
 * Clean up one query's replay drain WITHOUT treating it as completed —
 * unmount/unsubscribe-before-marker (the hook's cancellation path). Fires
 * the settle bump if mutations are waiting (the rows ARE in the store —
 * consumers must see them), drops the settle callback, and removes any
 * buffered marker for the queryId. No-op when the drain already settled.
 */
export function cancelReplayDrain(queryId: string): void {
  settledUnclaimedMarkers.delete(queryId);
  for (const [eventType, drains] of replayDrains) {
    if (!drains.has(queryId)) continue;
    drains.delete(queryId);
    if (drains.size === 0) replayDrains.delete(eventType);
    settleReplayDrain(eventType);
    return;
  }
}

/** Flat rows only (the typed row structs have no nested objects) — shallow
 * equality over own enumerable keys decides whether a patch mutated. */
function shallowRowEqual(a: RtdbRow, b: RtdbRow): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (a[key as keyof RtdbRow] !== b[key as keyof RtdbRow]) return false;
  }
  return true;
}

/**
 * Apply one RowDelivery envelope WITHOUT touching the epoch or the mutation
 * log. Returns the merged row when the store mutated (null on remove/no-op).
 * Shared by `applyRowDelivery` (single) and `applyRowDeliveries` (bulk) so
 * both paths carry IDENTICAL insert/seq/remove semantics (F-33 fix, W-2 —
 * the bulk path must never diverge from the pinned single-delivery
 * behavior). Malformed envelopes are ignored.
 */
function applyRowDeliveryInner(delivery: RowDelivery): RtdbRow | 'removed' | null {
  const partition = rowPartitionFor(delivery.eventType);
  if (!partition) return null;
  const key = rowKeyString(delivery.key);
  const patch = (delivery.patch ?? {}) as Partial<RtdbRow>;

  if (delivery.kind === 'remove') {
    if (partition.rows.has(key)) {
      partition.rows.delete(key);
      partition.seqs.delete(key);
      return 'removed';
    }
    return null;
  }

  if (delivery.kind === 'insert') {
    const prev = partition.rows.get(key);
    if (!prev) {
      // First sight of this key — the patch IS the row (full row on insert).
      const row = { ...patch } as RtdbRow;
      partition.rows.set(key, row);
      partition.seqs.set(key, delivery.seq);
      return row;
    }
    // Key exists — spread-merge so init-time fields are never wiped.
    const merged = { ...prev, ...patch } as RtdbRow;
    // Inserts set the seq baseline (replay replaces hydration).
    partition.seqs.set(key, delivery.seq);
    if (!shallowRowEqual(prev, merged)) {
      partition.rows.set(key, merged);
      return merged;
    }
    return null;
  }

  // update — drop patches stale relative to the last applied seq for this key.
  const lastSeq = partition.seqs.get(key);
  if (lastSeq !== undefined && delivery.seq < lastSeq) {
    return null;
  }
  const prev = partition.rows.get(key);
  if (!prev) {
    // Update-before-insert (burst reordering): adopt the patch as the row.
    const row = { ...patch } as RtdbRow;
    partition.rows.set(key, row);
    partition.seqs.set(key, delivery.seq);
    return row;
  }
  const merged = { ...prev, ...patch } as RtdbRow;
  partition.seqs.set(key, delivery.seq);
  if (!shallowRowEqual(prev, merged)) {
    partition.rows.set(key, merged);
    return merged;
  }
  return null;
}

/**
 * Apply one RowDelivery envelope to the row store. Called from
 * AppProvider's onMessage routing (after `isRowDelivery` validation).
 * The epoch bumps AT MOST ONCE — exactly when the envelope mutated the store.
 * While a replay drain is pending for the partition (round-3 F-33 fix), the
 * bump is DEFERRED to the drain's settle instead.
 */
export function applyRowDelivery(delivery: RowDelivery): void {
  const partition = rowPartitionFor(delivery.eventType);
  if (!partition) return;
  const result = applyRowDeliveryInner(delivery);
  if (result !== null) {
    recordRowMutation(delivery.eventType, delivery, result === 'removed' ? null : result);
    if (hasPendingDrain(delivery.eventType)) {
      replayDirtyPartitions.add(delivery.eventType);
    } else {
      bumpRowEpoch(partition);
    }
  }
}

/**
 * Apply a BATCH of RowDelivery envelopes (the `{"rowBatch": [...]}` bulk
 * path, F-33 fix W-2): every envelope is applied with the EXACT
 * single-delivery insert/seq/remove semantics, then each TOUCHED partition
 * bumps its epoch exactly ONCE per batch — renders are bounded per applied
 * batch regardless of wire shape (protects flushMs:0 bursts and any future
 * per-row emission path, not just the replay leg).
 *
 * Round-3 F-33 fix: while a replay drain is pending for a partition, its
 * bumps are DEFERRED (marked dirty) and fire as ONE settle bump when the
 * drain completes (`endReplayDrain`/`cancelReplayDrain`) — a full-table
 * replay costs one render at settle, not one per envelope.
 */
export function applyRowDeliveries(deliveries: RowDelivery[]): void {
  const touched = new Set<RowEventType>();
  for (const delivery of deliveries) {
    const partition = rowPartitionFor(delivery.eventType);
    if (!partition) continue;
    const result = applyRowDeliveryInner(delivery);
    if (result !== null) {
      recordRowMutation(delivery.eventType, delivery, result === 'removed' ? null : result);
      touched.add(delivery.eventType);
    }
  }
  for (const eventType of touched) {
    if (hasPendingDrain(eventType)) {
      replayDirtyPartitions.add(eventType);
    } else {
      bumpRowEpoch(rowPartitionFor(eventType));
    }
  }
}

/** Subscribe to epoch changes for one row event type (useSyncExternalStore). */
export function subscribeToRowEpoch(eventType: RowEventType, listener: () => void): () => void {
  const partition = rowPartitionFor(eventType);
  partition.listeners.add(listener);
  return () => {
    partition.listeners.delete(listener);
  };
}

/** Current epoch for one row event type — stable primitive, advances only on real mutation. */
export function getRowEpoch(eventType: RowEventType): number {
  return rowPartitionFor(eventType).epoch;
}

/** Live rows map for one event type (read alongside `getRowEpoch`). */
export function getRowMap(eventType: RowEventType): Map<string, RtdbRow> {
  return rowPartitionFor(eventType).rows;
}

/**
 * Test-only: wipe the module-scoped row store AND the replay-drain registry
 * (pending drains, deferred-dirty flags, buffered markers). Never call from
 * app code.
 */
export function resetRowStoreForTests(): void {
  for (const partition of Object.values(rowPartitions)) {
    partition.rows.clear();
    partition.seqs.clear();
    partition.epoch = 0;
    // Listeners survive — they belong to live hook subscriptions.
  }
  // Drains belong to live subscriptions too, but a test reset must be a
  // total reset: a leaked pending drain would defer every later bump.
  replayDrains.clear();
  replayDirtyPartitions.clear();
  settledUnclaimedMarkers.clear();
  rowMutationLog.length = 0;
  rowMutationLogVersion += 1;
}

// Re-export for the debug consumers (a mutation log entry is a typed view of
// one delivery's effect on the store).
export type { RowDelivery };
