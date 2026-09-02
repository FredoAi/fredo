/**
 * useDevModeStream
 *
 * Reads the RTDB row-mutation log from the module-scoped StreamContext row
 * store (Spec #2788 P5.1 — the v1 raw-event queue this hook previously
 * consumed was deleted with the rest of the v1 pipeline) and accumulates the
 * entries in local state without a TTL so nothing is pruned while debugging.
 *
 * Each row mutation is projected onto the debug-event display shape the Dev
 * Mode panel has always rendered (toolName / state / payload), so the panel's
 * viewer works unchanged — the "events" it shows are now row upserts/removals
 * (the live data flow of the RTDB pipeline).
 */

import { useState, useEffect, useRef, useCallback, useMemo, useSyncExternalStore } from 'react';
import {
  subscribeToRowMutationLog,
  getRowMutationLogVersion,
  getRowMutations,
  clearRowMutations,
  useConnectionStatus,
  type RowMutation,
} from '../../../shared/contexts/StreamContext';

export type DevModeEventState = 'Init' | 'Update' | 'Response' | 'Error' | 'Timeout';

/** Display projection of one row mutation for the Dev Mode event viewer. */
export interface DevModeStreamEvent {
  id: string;
  /** Row event type — the debug label's event-class half. */
  eventType: 'Chat' | 'ToolUse' | 'AgentSession';
  state: DevModeEventState;
  transport: 'hook';
  sessionId: string;
  correlationId: string;
  /** Display label — row type + composite key. */
  toolName: string;
  /** The merged row after the mutation; `{"__removed__": true}` on remove. */
  payload: Record<string, unknown> | null;
  timestamp: string;
}

export interface DevModeStreamState {
  events: DevModeStreamEvent[];
  /** Unique event types (row type · kind) seen, ordered by first occurrence. */
  eventTypes: string[];
  isConnected: boolean;
  clearEvents: () => void;
}

const ROW_STATE_LABEL: Record<string, DevModeEventState> = {
  Init: 'Init',
  Update: 'Update',
  Response: 'Response',
  Error: 'Error',
  Timeout: 'Timeout',
};

function toStreamEvent(m: RowMutation): DevModeStreamEvent {
  return {
    id: m.id,
    eventType: m.eventType,
    state: ROW_STATE_LABEL[m.row?.state ?? ''] ?? 'Update',
    transport: 'hook',
    sessionId: m.sessionId,
    correlationId: m.correlationId,
    toolName: `${m.eventType}:${m.kind}`,
    payload: m.row !== null
      ? (m.row as unknown as Record<string, unknown>)
      : { __removed__: true },
    timestamp: m.timestamp,
  };
}

export function useDevModeStream(): DevModeStreamState {
  const { isConnected } = useConnectionStatus();

  // Bounded feed — observe the module-scoped mutation log via its monotonic
  // version (advances on every applied mutation; no array-length churn).
  useSyncExternalStore(subscribeToRowMutationLog, getRowMutationLogVersion);
  const mutations = getRowMutations();

  // Unbounded local accumulator — not pruned by the log's 512 cap.
  const [accumulated, setAccumulated] = useState<DevModeStreamEvent[]>([]);

  // Tracks mutation ids already added so hot-reloads / double-fires don't
  // duplicate, and re- observation of a grown log stays incremental.
  const seenIdsRef = useRef<Set<string>>(new Set());
  const seenCountRef = useRef(0);

  useEffect(() => {
    // The log is append-only within a cap window; entries seen before are
    // skipped by id. When the cap evicts old entries the indexes shift —
    // the id set keeps the accumulator correct regardless.
    const fresh: DevModeStreamEvent[] = [];
    const start = Math.min(seenCountRef.current, mutations.length);
    for (let i = start; i < mutations.length; i++) {
      const m = mutations[i];
      if (!seenIdsRef.current.has(m.id)) {
        seenIdsRef.current.add(m.id);
        fresh.push(toStreamEvent(m));
      }
    }
    seenCountRef.current = mutations.length;
    if (fresh.length > 0) {
      // Prepend so newest mutations appear at the top (matches the panel's
      // original UI order).
      setAccumulated((prev) => [...fresh.reverse(), ...prev]);
    }
  }, [mutations]);

  // Derive unique event types from accumulated events.
  const eventTypes = useMemo(() => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const ev of accumulated) {
      if (!seen.has(ev.toolName)) {
        seen.add(ev.toolName);
        result.push(ev.toolName);
      }
    }
    return result;
  }, [accumulated]);

  const clearEvents = useCallback(() => {
    setAccumulated([]);
    seenIdsRef.current.clear();
    seenCountRef.current = 0;
    // Also flush the module-scoped log so no pre-clear mutations re-enter.
    clearRowMutations();
  }, []);

  return { events: accumulated, eventTypes, isConnected, clearEvents };
}
