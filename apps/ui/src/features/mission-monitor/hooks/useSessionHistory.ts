import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import type { MissionMonitorSession } from '../lib/graph';
import { formatDerivedName, deriveDisplayName } from '../lib/sessionMeta';
import { useFeatureRead, useFeatureWatch } from '../../../shared/hooks/useFeatureData';
import type { FeatureDataRow } from '../../../shared/feature-data/client';
import { featureDataDelete, featureDataWrite } from '../../../shared/feature-data/client';
import { MISSION_MONITOR_FEATURE_ID } from '../lib/dataDeclaration';

// ── Spec #2896 (ST-6): the declared-table session list ───────────────────────
//
// Mission Monitor's list no longer rebuilds itself from a full Chat-row replay
// drain. It reads the backend-owned declared `sessions` rollup table
// (contract (a)):
//
//   1. `useFeatureRead` issues the initial `feature_data_read` — the list
//      renders on the FIRST round-trip (bounded SELECT over ≤ 500 rows), never
//      waiting on a `replayCompleteQueryId` marker or a full-history scan. On a
//      warm reopen the row store is module-scoped, so the first paint already
//      carries the stored rows (S0).
//   2. `useFeatureWatch` registers the table-level watch — inserts / updates /
//      removes keep the list live in place (S1).
//
// The declared row's PRESENCE already encodes the backend's qualification
// predicate (a group that ceases to qualify is deleted + emits `remove`, ST-3),
// but this hook re-applies the SAME documented predicate to the rollup facts
// (Architect A-11 — the rule lives in exactly ONE frontend place):
//
//   visibleTurnCount > 0 || (nonSubagentChatRowCount > 0 && userDispatchCount > 0)
//
// `deliveryCount = chatRowCount`; the list sorts `latestAt` DESC — byte-identical
// to the previous `latestTimestamp` DESC sort. Rename writes the feature-owned
// `customName` column; delete issues `feature_data_delete` (a durable tombstone
// behind it, so the projection never resurrects the row).

/** The declared `sessions` table ref (contract (a), ST-6). */
export const MISSION_MONITOR_SESSIONS_REF = {
  source: 'feature',
  featureId: MISSION_MONITOR_FEATURE_ID,
  table: 'sessions',
} as const;

/**
 * Qualified-session predicate over the rollup facts — the frontend half of the
 * single shared renderability rule (Architect A-11 / `deriveRenderableSessions`).
 */
export function sessionRollupQualifies(row: FeatureDataRow): boolean {
  const visibleTurnCount = Number(row.visibleTurnCount ?? 0);
  const nonSubagentChatRowCount = Number(row.nonSubagentChatRowCount ?? 0);
  const userDispatchCount = Number(row.userDispatchCount ?? 0);
  return (
    visibleTurnCount > 0 ||
    (nonSubagentChatRowCount > 0 && userDispatchCount > 0)
  );
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Map one declared `sessions` rollup row → `MissionMonitorSession`.
 * `deliveryCount = chatRowCount` (the rollup's authoritative count);
 * `latestTimestamp = latestAt`; `startTime` = `startedAtNs / 1e6`, falling back
 * to the parsed `latestAt`.
 */
function rollupRowToSession(row: FeatureDataRow): MissionMonitorSession | null {
  const sessionId = asString(row.sessionId);
  if (!sessionId) return null;

  const latestAt = asString(row.latestAt);
  const startedAtNs = asNumber(row.startedAtNs);
  const latestMs = latestAt !== undefined ? Date.parse(latestAt) : NaN;
  const startTime =
    startedAtNs !== undefined
      ? startedAtNs / 1e6
      : Number.isFinite(latestMs)
        ? latestMs
        : Date.now();

  const session: MissionMonitorSession = {
    sessionId,
    label: new Date(startTime).toLocaleString(),
    startTime,
    latestTimestamp: latestAt ?? new Date(startTime).toISOString(),
    deliveryCount: asNumber(row.chatRowCount) ?? 0,
    provider: asString(row.provider) ?? null,
  };

  const derivedRaw = asString(row.derivedName);
  if (derivedRaw !== undefined) {
    const derived = formatDerivedName(derivedRaw);
    if (derived !== undefined) session.derivedName = derived;
  }

  // An empty/whitespace custom name clears it (the drawer's clear path writes
  // `null`; the read surfaces `null` as absent).
  const customName = asString(row.customName);
  if (customName !== undefined) session.customName = customName;

  return session;
}

// ── Module-scoped optimistic deletion (survives mount/unmount) ───────────────
//
// `feature_data_delete` emits a `remove` within one coalescing window; until it
// lands, a just-deleted row must not flash back into the list on a re-render.
// Module scope (never a React ref) per the AGENTS.md persistence rule. The
// backend tombstone is the durable anti-resurrection guarantee; this set is
// display-only.
const optimisticallyDeletedSessionIds = new Set<string>();

/** Test-only: clear the module-scoped optimistic-deletion overlay. */
export function resetSessionHistoryForTests(): void {
  optimisticallyDeletedSessionIds.clear();
}

/**
 * useDeliverySessions — the Mission Monitor session list, sourced from the
 * declared `sessions` table (initial read → first round-trip; table watch →
 * live). Plus selection, rename, delete, and search.
 */
export function useDeliverySessions() {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [searchFilter, setSearchFilter] = useState('');
  // Bumped by an optimistic local mutation (delete) so the derived list
  // re-reads the module-scoped optimistic-deletion overlay without waiting for
  // the backend `remove` notification.
  const [localMutationTick, setLocalMutationTick] = useState(0);
  const userPickedRef = useRef(false);

  // S0: the initial read (list on the first round-trip) …
  const read = useFeatureRead(MISSION_MONITOR_SESSIONS_REF);
  // … and the table-level live watch (S1).
  const watch = useFeatureWatch(MISSION_MONITOR_SESSIONS_REF, {
    scope: { kind: 'table' },
    initial: true,
  });

  // Both hooks share the SAME module-scoped partition map; `watch.epoch`
  // advances only on a real mutation (the #523 no-loop primitive).
  const rows = read.rows;
  const epoch = watch.epoch;

  // S5: the empty state renders only after the durable read has SETTLED empty.
  const settled = !read.loading || watch.ready;

  // A13 / S6: the verbatim backend error, never swallowed.
  const error = read.error ?? watch.error;

  const sessions = useMemo<MissionMonitorSession[]>(() => {
    const list: MissionMonitorSession[] = [];
    for (const row of rows.values()) {
      const sessionId = asString(row.sessionId);
      if (!sessionId) continue;
      if (optimisticallyDeletedSessionIds.has(sessionId)) continue;
      if (!sessionRollupQualifies(row)) continue;
      const session = rollupRowToSession(row);
      if (session) list.push(session);
    }
    // Newest-first by latestAt — byte-identical to the previous
    // latestTimestamp DESC sort (Architect A-15).
    return list.sort(
      (a, b) => Date.parse(b.latestTimestamp) - Date.parse(a.latestTimestamp),
    );
    // `rows` is the stable module-scoped map (identity never changes); `epoch`
    // is the real recompute signal. Never depend on map size/identity (#523).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, epoch, localMutationTick]);

  // Reset the selected session if it no longer exists — the selected session
  // was deleted or evicted. Falls back to S4 `NoSessionSelected`
  // (MissionMonitorPanel), never a blank canvas.
  useEffect(() => {
    if (selectedSessionId && !sessions.some((s) => s.sessionId === selectedSessionId)) {
      setSelectedSessionId(null);
      userPickedRef.current = false;
    }
  }, [sessions, selectedSessionId]);

  // Auto-select the newest session (by START time, not latestAt — an old
  // session with fresh activity must not beat a newer idle one) when nothing is
  // selected and the user has not explicitly picked.
  useEffect(() => {
    if (userPickedRef.current === false && sessions.length > 0 && selectedSessionId === null) {
      const newest = sessions.reduce((a, b) => (a.startTime > b.startTime ? a : b));
      setSelectedSessionId(newest.sessionId);
    }
  }, [sessions, selectedSessionId]);

  // Follow a NEWLY-STARTED session (a new declared row) unless the user has
  // explicitly picked one this lifetime. Keyed on the table-watch epoch — never
  // on list length (the #523 no-loop rule).
  const seenSessionIdsRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (seenSessionIdsRef.current === null) {
      // First pass: seed only — never retarget on restored/parked traffic.
      seenSessionIdsRef.current = new Set(sessions.map((s) => s.sessionId));
      return;
    }
    const seen = seenSessionIdsRef.current;
    let newestNewSid: string | null = null;
    for (const session of sessions) {
      if (!seen.has(session.sessionId)) newestNewSid = session.sessionId;
    }
    if (newestNewSid === null) return;
    seen.add(newestNewSid);
    if (userPickedRef.current) return; // explicit pick wins — never steal focus
    setSelectedSessionId(newestNewSid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epoch, sessions]);

  const filteredSessions = useMemo(() => {
    if (!searchFilter) return sessions;
    const lower = searchFilter.toLowerCase();
    return sessions.filter(
      (s) =>
        s.sessionId.toLowerCase().includes(lower) ||
        deriveDisplayName(s).toLowerCase().includes(lower),
    );
  }, [sessions, searchFilter]);

  const selectSession = useCallback((id: string | null) => {
    userPickedRef.current = true;
    setSelectedSessionId(id);
  }, []);

  /** Programmatic retarget (follow) — never flips `userPickedRef`. */
  const followSession = useCallback((id: string | null) => {
    setSelectedSessionId(id);
  }, []);

  /**
   * Delete a session: `feature_data_delete` on the declared table (the backend
   * tombstones the key + emits `kind: "remove"`, so it can never be
   * re-projected). The optimistic module set suppresses the row until the
   * remove notification drops it from the shared partition.
   */
  const deleteSession = useCallback(
    async (id: string) => {
      optimisticallyDeletedSessionIds.add(id);
      setLocalMutationTick((t) => t + 1);
      if (selectedSessionId === id) {
        setSelectedSessionId(null);
        userPickedRef.current = false;
      }
      await featureDataDelete({
        ref: { featureId: MISSION_MONITOR_FEATURE_ID, table: 'sessions' },
        key: [id],
      });
    },
    [selectedSessionId],
  );

  /**
   * Rename a session by writing the feature-owned `customName` column. The
   * table watch delivers the `update` notification, which re-derives the list.
   * An empty/whitespace name clears the column (`null` → derived/label).
   */
  const renameSession = useCallback(async (id: string, name: string) => {
    const trimmed = name.trim();
    await featureDataWrite({
      ref: { featureId: MISSION_MONITOR_FEATURE_ID, table: 'sessions' },
      key: [id],
      set: { customName: trimmed.length > 0 ? trimmed : null },
    });
  }, []);

  return {
    sessions,
    filteredSessions,
    selectedSessionId,
    selectSession,
    followSession,
    deleteSession,
    renameSession,
    searchFilter,
    setSearchFilter,
    userPickedRef,
    /** True once the durable read (or watch snapshot) has settled. */
    settled,
    /** Verbatim backend error text from the read/watch, or `null`. */
    error,
  };
}
