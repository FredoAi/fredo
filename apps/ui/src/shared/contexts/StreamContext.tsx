/**
 * Stream Event Context - React Context + useReducer
 *
 * Manages the contract delivery queue from the ECE (Rust backend) via
 * Tauri IPC. The ECE buffers raw FredoEvent objects, evaluates
 * completeWhen conditions, and delivers ContractDelivery objects.
 *
 * ── New Pipeline ──────────────────────────────────────────────────────────
 * The primary data is `deliveries: ContractDelivery[]`. Components that
 * extend FredoFeatureClass receive deliveries through `handleDelivery`.
 * Non-feature components use useDeliveryFilter or useStepperEvents.
 *
 * ── Backward Compatibility ────────────────────────────────────────────────
 * `events: FredoEvent[]` and all legacy selectors (getEventsByTool, etc.)
 * are kept for features not yet migrated. New components should use
 * deliveries.
 */

import React, { createContext, useContext, useReducer, useMemo, useCallback, useEffect, useSyncExternalStore } from 'react';
import { EVENT_TTL_MS, DELIVERY_TTL_MS, CLEANUP_INTERVALS } from '../constants';
import type {
  ContractDelivery,
  RowDelivery,
  RowEventType,
  RtdbRow,
} from '../classes/EventSubscription';
import { rowKeyString } from '../classes/EventSubscription';

/**
 * Stream event structure (from backend)
 */
// Note: Rust serializes EventSource enum with rename_all = "camelCase"
export type EventSource = 'hook' | 'otlpGrpc' | 'otlpHttp';
export type OtlpSignal  = 'Span' | 'Metric' | 'Log';

export interface OtlpPayload {
  signal: OtlpSignal;
  attributes: Record<string, any>;
}

/**
 * FredoEvent type exports — per REQ-1.13, REQ-1.14, REQ-1.16
 * Kept for backward compat with features not yet migrated to the ECE.
 */
export type EventType = 'tool_use' | 'agent_session' | 'chat' | 'infrastructure' | 'ui' | 'custom';
export type EventProvider = 'open_code' | 'claude_code' | 'internal';
export type Transport = 'hook' | 'otlp_grpc' | 'otlp_http' | 'web_socket' | 'http_post' | 'internal';

export interface FredoEventError {
  message: string;
  code?: string;
  details?: Record<string, unknown>;
}

export interface FredoEvent {
  id: string;
  eventType: EventType;
  state: 'Init' | 'Update' | 'Response' | 'Error';
  provider: EventProvider;
  transport: Transport;
  sessionId: string;
  correlationId?: string;
  toolName?: string;
  payload: Record<string, unknown> | null;
  error?: FredoEventError | null;
  metadata?: Record<string, unknown> | null;
  timestamp: string;
}

/**
 * @deprecated Use FredoEvent instead. StreamEvent is kept for backward compatibility
 * with legacy sessions in localStorage. New code should use FredoEvent.
 */
export interface StreamEvent {
  toolName: string;
  sessionId: string;
  state: 'Init' | 'Update' | 'Response' | 'Error';
  input?: any;
  response?: any;
  data?: any;
  timestamp: string;
  eventId?: string;
  correlationId?: string;
  error?: {
    message: string;
    code?: string;
    stack?: string;
    details?: any;
  };
  /** Discriminates where the event originated. Absent on legacy events = Hook. */
  source?: EventSource;
  /** Present only for OTLP-sourced events. */
  otlp?: OtlpPayload;
}

/**
 * Convert a ContractDelivery to a backward-compat FredoEvent.
 * Maps contractName → toolName, lifecycle → state, etc.
 */
function deliveryToFredoEvent(delivery: ContractDelivery): FredoEvent {
  const stateMap: Record<string, FredoEvent['state']> = {
    init: 'Init',
    update: 'Update',
    end: 'Response',
  };
  return {
    id: delivery.id,
    eventType: 'custom',
    state: stateMap[delivery.lifecycle] || 'Update',
    provider: (delivery.provider as EventProvider) || 'internal',
    transport: 'internal',
    sessionId: delivery.key?.sessionId || 'ece',
    correlationId: delivery.key?.correlationId,
    toolName: delivery.contractName,
    payload: delivery.payload as Record<string, unknown> | null,
    error: null,
    metadata: null,
    timestamp: delivery.timestamp,
  };
}

/**
 * Stream state interface
 */
interface StreamState {
  /** @deprecated Use deliveries instead. Kept for backward compat. */
  events: FredoEvent[];
  /** Primary delivery queue from the ECE */
  deliveries: ContractDelivery[];
  isConnected: boolean;
}

/**
 * Stream actions
 */
type StreamAction =
  | { type: 'ADD_EVENT'; payload: FredoEvent }
  | { type: 'ADD_DELIVERY'; payload: ContractDelivery }
  | { type: 'CLEAR_EVENTS' }
  | { type: 'CLEAR_PROCESSED_EVENTS'; payload: { eventKeys: string[] } }
  | { type: 'CLEANUP_EXPIRED_EVENTS'; payload: { ttlMs: number } }
  | { type: 'SET_CONNECTION_STATUS'; payload: boolean };

/**
 * Stream context value
 */
interface StreamContextValue extends StreamState {
  /** @deprecated Use addDelivery instead */
  addEvent: (event: FredoEvent) => void;
  /** Add a contract delivery from the ECE */
  addDelivery: (delivery: ContractDelivery) => void;
  clearEvents: () => void;
  clearProcessedEvents: (eventKeys: string[]) => void;
  cleanupExpiredEvents: () => void;
  setConnectionStatus: (connected: boolean) => void;
  /** @deprecated Use deliveries and filter by contractName instead */
  getEventsByTool: (toolName: string) => FredoEvent[];
  /** @deprecated Use deliveries and filter by contractName instead */
  getLatestEventByTool: (toolName: string) => FredoEvent | undefined;
  /** @deprecated Use deliveries and filter by lifecycle instead */
  getEventsByState: (state: FredoEvent['state']) => FredoEvent[];
  /** @deprecated Use deliveries and filter by key fields instead */
  getEventsByCorrelation: (correlationId: string) => FredoEvent[];
  /** Get deliveries for a specific contract name */
  getDeliveriesByContract: (contractName: string) => ContractDelivery[];
}

/**
 * Initial state
 */
const initialState: StreamState = {
  events: [],
  deliveries: [],
  isConnected: false,
};

/**
 * Reducer function
 */
function streamReducer(state: StreamState, action: StreamAction): StreamState {
  switch (action.type) {
    case 'ADD_EVENT': {
      // Deduplicate by id to guard against duplicate IPC events
      const incoming = action.payload;
      if (incoming.id && state.events.some((e) => e.id === incoming.id)) {
        return state;
      }

      const newEvents = [...state.events, incoming];
      
      // Remove events older than TTL (60 seconds)
      const now = Date.now();
      const filteredEvents = newEvents.filter((e) => {
        const eventTime = new Date(e.timestamp).getTime();
        const age = now - eventTime;
        return age < EVENT_TTL_MS;
      });
      
      return { ...state, events: filteredEvents };
    }

    case 'ADD_DELIVERY': {
      const delivery = action.payload;
      // Deduplicate by id
      if (delivery.id && state.deliveries.some((d) => d.id === delivery.id)) {
        return state;
      }

      let newDeliveries = [...state.deliveries, delivery];

      // Cap deliveries at 5000, evict oldest entries when exceeded (REQ-1)
      if (newDeliveries.length > 5000) {
        newDeliveries = newDeliveries.slice(newDeliveries.length - 5000);
      }

      // Also add a backward-compat FredoEvent derived from the delivery
      const fredoEvent = deliveryToFredoEvent(delivery);
      const newEvents = [...state.events, fredoEvent];

      return { ...state, deliveries: newDeliveries, events: newEvents };
    }

    case 'CLEAR_EVENTS':
      return { ...state, events: [], deliveries: [] };

    case 'CLEAR_PROCESSED_EVENTS': {
      const keysToRemove = new Set(action.payload.eventKeys);
      const filteredEvents = state.events.filter((event) => {
        return !keysToRemove.has(event.id!);
      });
      
      return { ...state, events: filteredEvents };
    }

    case 'CLEANUP_EXPIRED_EVENTS': {
      const now = Date.now();
      const ttlMs = action.payload.ttlMs;
      const filteredEvents = state.events.filter((e) => {
        const eventTime = new Date(e.timestamp).getTime();
        const age = now - eventTime;
        return age < ttlMs;
      });
      
      // Also remove deliveries older than DELIVERY_TTL_MS (REQ-2)
      const filteredDeliveries = state.deliveries.filter((d) => {
        const deliveryTime = new Date(d.timestamp).getTime();
        const age = now - deliveryTime;
        return age < DELIVERY_TTL_MS;
      });
      
      return { ...state, events: filteredEvents, deliveries: filteredDeliveries };
    }

    case 'SET_CONNECTION_STATUS':
      return { ...state, isConnected: action.payload };

    default:
      return state;
  }
}

/**
 * Create context
 */
const StreamContext = createContext<StreamContextValue | undefined>(undefined);

/**
 * Provider component
 */
export function StreamProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(streamReducer, initialState);

  // Actions
  /** @deprecated Use addDelivery instead */
  const addEvent = useCallback((event: FredoEvent) => {
    dispatch({ type: 'ADD_EVENT', payload: event });
  }, []);

  const addDelivery = useCallback((delivery: ContractDelivery) => {
    dispatch({ type: 'ADD_DELIVERY', payload: delivery });
  }, []);

  const clearEvents = useCallback(() => {
    dispatch({ type: 'CLEAR_EVENTS' });
  }, []);

  const clearProcessedEvents = useCallback((eventKeys: string[]) => {
    dispatch({ type: 'CLEAR_PROCESSED_EVENTS', payload: { eventKeys } });
  }, []);

  const cleanupExpiredEvents = useCallback(() => {
    dispatch({ type: 'CLEANUP_EXPIRED_EVENTS', payload: { ttlMs: EVENT_TTL_MS } });
  }, []);

  const setConnectionStatus = useCallback((connected: boolean) => {
    dispatch({ type: 'SET_CONNECTION_STATUS', payload: connected });
  }, []);

  // Selectors (memoized to prevent re-renders)
  const getEventsByTool = useCallback((toolName: string) => {
    return state.events.filter((event) => event.toolName === toolName);
  }, [state.events]);

  const getLatestEventByTool = useCallback((toolName: string) => {
    const events = state.events.filter((event) => event.toolName === toolName);
    return events[events.length - 1];
  }, [state.events]);

  const getEventsByState = useCallback((stateFilter: StreamEvent['state']) => {
    return state.events.filter((event) => event.state === stateFilter);
  }, [state.events]);

  const getEventsByCorrelation = useCallback((correlationId: string) => {
    return state.events.filter((event) => event.correlationId === correlationId);
  }, [state.events]);

  const getDeliveriesByContract = useCallback((contractName: string) => {
    return state.deliveries.filter((d) => d.contractName === contractName);
  }, [state.deliveries]);

  // Auto-cleanup timer
  useEffect(() => {
    const interval = setInterval(() => {
      cleanupExpiredEvents();
    }, CLEANUP_INTERVALS.EVENTS);

    return () => clearInterval(interval);
  }, [cleanupExpiredEvents]);

  // Memoize context value
  const value = useMemo<StreamContextValue>(
    () => ({
      ...state,
      addEvent,
      addDelivery,
      clearEvents,
      clearProcessedEvents,
      cleanupExpiredEvents,
      setConnectionStatus,
      getEventsByTool,
      getLatestEventByTool,
      getEventsByState,
      getEventsByCorrelation,
      getDeliveriesByContract,
    }),
    [
      state,
      addEvent,
      addDelivery,
      clearEvents,
      clearProcessedEvents,
      cleanupExpiredEvents,
      setConnectionStatus,
      getEventsByTool,
      getLatestEventByTool,
      getEventsByState,
      getEventsByCorrelation,
      getDeliveriesByContract,
    ]
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

/**
 * Convenience hooks for specific use cases
 */

/**
 * Get all stepper deliveries from the ECE contract pipeline.
 * Uses the contract delivery queue instead of raw FredoEvent events.
 */
export function useStepperEvents() {
  const { deliveries } = useStream();
  return useMemo(
    () => deliveries.filter((d) => d.contractName === 'Fredo_ui_stepper'),
    [deliveries]
  );
}

/**
 * Get the latest stepper delivery from the ECE contract pipeline.
 */
export function useLatestStepperEvent() {
  const { deliveries } = useStream();
  return useMemo(() => {
    const stepperDeliveries = deliveries.filter((d) => d.contractName === 'Fredo_ui_stepper');
    return stepperDeliveries[stepperDeliveries.length - 1];
  }, [deliveries]);
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
// AppProvider (the v1 ContractDelivery pipeline above stays untouched —
// strangler coexistence). Semantics (pinned by P4.1):
//
// - `insert` = full-row set; spread-merge into an existing row so init-time
//   fields are never wiped; sets the per-key seq baseline.
// - `update` = `{ ...row, ...patch }` merge; patches with a seq LOWER than
//   the last applied seq for that key are dropped (out-of-order/replayed
//   burst robustness).
// - `remove` = delete key (only ever originates from backend retention
//   eviction); removing an absent key is a no-op.
// - NO cap/TTL eviction of live rows — the 5000-cap/TTL below governs the v1
//   delivery LIST only. Replay replaces hydration by re-inserting rows.
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
 * with oldest-first eviction (same pattern as the ECE relationship registry).
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
 * Apply one RowDelivery envelope WITHOUT touching the epoch. Returns true if
 * the store mutated. Shared by `applyRowDelivery` (single) and
 * `applyRowDeliveries` (bulk) so both paths carry IDENTICAL insert/seq/remove
 * semantics (F-33 fix, W-2 — the bulk path must never diverge from the
 * pinned single-delivery behavior). Malformed envelopes are ignored.
 */
function applyRowDeliveryInner(delivery: RowDelivery): boolean {
  const partition = rowPartitionFor(delivery.eventType);
  if (!partition) return false;
  const key = rowKeyString(delivery.key);
  const patch = (delivery.patch ?? {}) as Partial<RtdbRow>;

  if (delivery.kind === 'remove') {
    if (partition.rows.has(key)) {
      partition.rows.delete(key);
      partition.seqs.delete(key);
      return true;
    }
    return false;
  }

  if (delivery.kind === 'insert') {
    const prev = partition.rows.get(key);
    if (!prev) {
      // First sight of this key — the patch IS the row (full row on insert).
      partition.rows.set(key, { ...patch } as RtdbRow);
      partition.seqs.set(key, delivery.seq);
      return true;
    }
    // Key exists — spread-merge so init-time fields are never wiped.
    const merged = { ...prev, ...patch } as RtdbRow;
    // Inserts set the seq baseline (replay replaces hydration).
    partition.seqs.set(key, delivery.seq);
    if (!shallowRowEqual(prev, merged)) {
      partition.rows.set(key, merged);
      return true;
    }
    return false;
  }

  // update — drop patches stale relative to the last applied seq for this key.
  const lastSeq = partition.seqs.get(key);
  if (lastSeq !== undefined && delivery.seq < lastSeq) {
    return false;
  }
  const prev = partition.rows.get(key);
  if (!prev) {
    // Update-before-insert (burst reordering): adopt the patch as the row.
    partition.rows.set(key, { ...patch } as RtdbRow);
    partition.seqs.set(key, delivery.seq);
    return true;
  }
  const merged = { ...prev, ...patch } as RtdbRow;
  partition.seqs.set(key, delivery.seq);
  if (!shallowRowEqual(prev, merged)) {
    partition.rows.set(key, merged);
    return true;
  }
  return false;
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
  if (applyRowDeliveryInner(delivery)) {
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
    if (applyRowDeliveryInner(delivery)) {
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
}
