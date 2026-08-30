import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import type { ContractDelivery } from '../../../shared/classes/EventSubscription';
import type { MissionMonitorSession } from '../lib/graph';
import { isChatNodeDelivery, deliverySessionId, extractDeliveryPayload } from '../lib/graph';
import { loadPersistedSessions, deleteSessionFromStore, markSessionDeleted, isSessionDeleted, saveCustomName } from '../lib/persistence';
import { formatDerivedName, deriveDisplayName } from '../lib/sessionMeta';
import { hydrateContractEvents } from '../../../shared/lib/contractHydration';
import { useStream } from '../../../shared/contexts/StreamContext';

// ── Spec #2768 (ST-5): mount-time contract hydration ─────────────────────────
//
// Mission Monitor hydrates its three persistent contracts from the backend
// ContractEventStore on mount, so a panel opened after (or mid-) a session
// renders the complete graph with no gap (AC2/AC3 — the panel may have been
// closed while the events streamed). Rows replay via
// `StreamContext.addDelivery` in seq order under their ORIGINAL delivery ids,
// so they flow through the SAME paths as live deliveries (graph builder,
// session list, frontend persistence) and StreamContext id-dedupe makes
// re-adding a row the feature already holds a no-op (R9 — no duplicates).
//
// MUST mirror the `contractName` values declared in
// MissionMonitorFeature.eventContracts (kept as a literal list here — the
// hydration wiring's own config — so the hook stays decoupled from the
// feature-class module, which imports this hook transitively via the panel).
const MM_HYDRATION_CONTRACTS = [
  'chat-node',
  'tool-use-lifecycle',
  'subagent-tool-activity',
];

// Memoized-init guard (the `ensureMmTables` pattern, persistence.ts): the
// hydration promise is memoized module-scoped so concurrent callers (React
// StrictMode's double mount effect, a remount racing the first hydration)
// share ONE in-flight fetch. The memo is cleared when the run settles so a
// LATER mount re-hydrates — required for correctness: StreamContext TTL-shrinks
// deliveries after 300s, so a panel reopened after a longer closed window must
// re-fetch the closed-window rows from the backend store (AC3) or they would
// be missing from both StreamContext and the frontend FeatureStore (which only
// persists while mounted). The replay is a no-op for rows already held/stored:
// id-dedupe in StreamContext + the persistDelivery replay guard.
//
// `hydratedDeliveryIds` is module-scoped (survives unmount — never a ref) so
// the session list below can tell hydrated rows apart from live ones and skip
// them for sessions the persisted snapshot already counts (no double count).
// Bounded: cleared wholesale at 100k ids (the backend store's max_rows order).
const hydratedDeliveryIds = new Set<string>();

let hydrationInFlight: Promise<number> | null = null;

function ensureMmContractHydration(addDelivery: (delivery: ContractDelivery) => void): Promise<number> {
  if (!hydrationInFlight) {
    hydrationInFlight = hydrateContractEvents(MM_HYDRATION_CONTRACTS, (delivery) => {
      if (hydratedDeliveryIds.size > 100_000) hydratedDeliveryIds.clear();
      hydratedDeliveryIds.add(delivery.id);
      addDelivery(delivery);
    })
      .catch((err) => {
        // Hydration must never wedge the session list's `loaded` gate — a
        // cold/empty store or a backend hiccup resolves to 0 rows and the
        // panel renders exactly as before ST-5.
        console.warn('[MM] contract hydration failed:', err);
        return 0;
      })
      .finally(() => {
        hydrationInFlight = null;
      });
  }
  return hydrationInFlight;
}


/**
 * useDeliverySessions — derives sessions from SQLite (on mount) merged with
 * live StreamContext deliveries.
 *
 * No longer takes a `deliveries` parameter — loads persisted sessions from
 * SQLite on mount via FeatureStore IPC.
 *
 * @returns sessions, filteredSessions, selectedSessionId, selectSession,
 *          deleteSession, searchFilter, setSearchFilter
 */
export function useDeliverySessions() {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [searchFilter, setSearchFilter] = useState('');
  const [persistedSessions, setPersistedSessions] = useState<MissionMonitorSession[]>([]);
  const [loaded, setLoaded] = useState(false);
  const userPickedRef = useRef(false);

  // Track deleted session IDs to prevent resurrection via live StreamContext deliveries
  const deletedSessionIdsRef = useRef<Set<string>>(new Set());

  // Access StreamContext — live deliveries drive the session merge; `addDelivery`
  // is the injector the mount-time hydration replays persisted rows through
  // (Spec #2768 ST-5). Stable `useCallback` — the effect below runs once.
  const { deliveries, addDelivery } = useStream();

  // Load persisted sessions from SQLite AND hydrate the backend contract store
  // on mount. The session list's `loaded` gate (the UX ladder's spinner state —
  // MissionMonitorPanel renders its spinner empty-state while `sessions` is
  // empty) covers BOTH async loads: `loaded` flips only after hydration has
  // settled, so persisted-history sessions can never flash a false "no data"
  // state while their rows are still in flight (Spec #2768 ui-ux requirement).
  // Hydration failure resolves to 0 rows (never rejects) — a cold/empty store
  // is a graceful no-op.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [loadedSessions] = await Promise.all([
          loadPersistedSessions(),
          ensureMmContractHydration(addDelivery),
        ]);
        if (!cancelled) {
          setPersistedSessions(loadedSessions);
          setLoaded(true);
        }
      } catch (err) {
        console.warn('[MM] mount load failed:', err);
        if (!cancelled) {
          setLoaded(true);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [addDelivery]);

  // Refresh the persisted-session snapshot from SQLite. `persistedSessions` is
  // loaded ONCE on mount; a session that starts LIVE during the panel's lifetime
  // is persisted to SQLite by the panel's persistDelivery effect but never enters
  // this state (the mount-time snapshot is stale). Such a session is only visible
  // through the live-only path below — which reads StreamContext `deliveries`
  // (TTL-shrunk after DELIVERY_TTL_MS=300s). Once its deliveries age out, the
  // session vanishes from the list until a remount re-reads SQLite. The panel
  // calls this after every persist batch so a freshly-persisted session lands in
  // the snapshot and survives TTL eviction.
  const refreshSessions = useCallback(async () => {
    try {
      const sessions = await loadPersistedSessions();
      setPersistedSessions(sessions);
      setLoaded(true);
    } catch (err) {
      console.warn('[MM] refreshSessions failed:', err);
    }
  }, []);

  // Merge persisted sessions with live delivery metadata
  const sessions = useMemo<MissionMonitorSession[]>(() => {
    if (!loaded) return [];

    // REQ-1: Deduplicate persisted sessions by sessionId.
    // Prevents duplicate sidebar entries when the same logical session was
    // persisted via dual transports. Last entry wins for metadata.
    const dedupedPersisted = new Map<string, MissionMonitorSession>();
    for (const s of persistedSessions) {
      dedupedPersisted.set(s.sessionId, s);
    }
    const uniquePersisted = Array.from(dedupedPersisted.values());

    // Build a map of sessionId → live delivery count from StreamContext
    const liveCounts = new Map<string, number>();
    const liveTimestamps = new Map<string, string>();
    const liveStartTimes = new Map<string, number>();
    // #2748 ST-3 (AC1 R-1.1): earliest-timestamp non-empty `userMessage` per
    // session, collected in this SAME single O(N) pass (NFR-1 — never a
    // per-session rescan). Selection mirrors deriveSessionName; formatting is
    // delegated to formatDerivedName (single definition of normalize+truncate).
    const liveUserMessages = new Map<string, { ts: number; message: string }>();

    for (const d of deliveries) {
      if (!isChatNodeDelivery(d)) continue;
      const sid = deliverySessionId(d);
      if (!sid) continue;

      // Spec #2768 (ST-5): hydrated rows replay under their ORIGINAL ids and
      // stay in StreamContext until TTL eviction. For a session the persisted
      // snapshot already carries, the snapshot's deliveryCount already counts
      // those rows (persistDelivery stored them — live, at a previous mount,
      // or from the hydration replay itself) — counting them again as "live"
      // would double the sidebar figure. Hydrated rows for sessions NOT in
      // the snapshot still count: that is how a backend-only session (streamed
      // entirely while the panel was closed) surfaces until its rows land in
      // the frontend store via the persist path.
      if (hydratedDeliveryIds.has(d.id) && dedupedPersisted.has(sid)) continue;

      liveCounts.set(sid, (liveCounts.get(sid) ?? 0) + 1);

      const existingTs = liveTimestamps.get(sid);
      if (!existingTs || d.timestamp > existingTs) {
        liveTimestamps.set(sid, d.timestamp);
      }

      const tsTime = new Date(d.timestamp).getTime();
      const existingStart = liveStartTimes.get(sid);
      if (!existingStart || tsTime < existingStart) {
        liveStartTimes.set(sid, tsTime);
      }

      // #2748 ST-3 (AC1): earliest-timestamp non-empty userMessage. Array order
      // is append order — compare timestamps, never array position.
      const payload = extractDeliveryPayload(d);
      const userMessage = typeof payload['userMessage'] === 'string' ? payload['userMessage'] : '';
      if (userMessage.trim() === '' || Number.isNaN(tsTime)) continue;
      const existingMsg = liveUserMessages.get(sid);
      if (!existingMsg || tsTime < existingMsg.ts) {
        liveUserMessages.set(sid, { ts: tsTime, message: userMessage });
      }
    }

    // Merge persisted sessions with live data
    const merged = uniquePersisted
      .map((s) => {
        const liveCount = liveCounts.get(s.sessionId);
        const liveTs = liveTimestamps.get(s.sessionId);
        const liveStart = liveStartTimes.get(s.sessionId);
        const liveMsg = liveUserMessages.get(s.sessionId);

        const mergedSession: MissionMonitorSession = {
          ...s,
          deliveryCount: liveCount !== undefined ? s.deliveryCount + liveCount : s.deliveryCount,
          latestTimestamp: liveTs ?? s.latestTimestamp,
          startTime: liveStart ?? s.startTime,
        };

        // #2748 ST-3 (AC1/AC2): resolve the session's derived name. The
        // persisted value (ST-2's capture — the session's TRUE first message,
        // TTL-proof) is authoritative; live derivation fills the gap for
        // sessions whose name has not been captured yet (live-only sessions,
        // or a session persisted before its first chat delivery). Both run
        // through formatDerivedName so the drawer always receives the display
        // form (ST-2 stores the raw first message — display-side truncation is
        // the hook's job). Display precedence (customName ?? derivedName ??
        // label) is resolved by deriveDisplayName at render time.
        const derived =
          (s.derivedName ? formatDerivedName(s.derivedName) : undefined) ??
          (liveMsg ? formatDerivedName(liveMsg.message) : undefined);
        if (derived !== undefined) mergedSession.derivedName = derived;

        return mergedSession;
      });

    // Add sessions from live deliveries that aren't yet persisted
    const persistedIds = new Set(uniquePersisted.map((s) => s.sessionId));

    for (const d of deliveries) {
      if (!isChatNodeDelivery(d)) continue;
      const sid = deliverySessionId(d);
      if (!sid || persistedIds.has(sid)) continue;

      persistedIds.add(sid);
      const tsTime = new Date(d.timestamp).getTime();
      const liveMsg = liveUserMessages.get(sid);
      const liveOnlySession: MissionMonitorSession = {
        sessionId: sid,
        label: new Date(tsTime).toLocaleString(),
        startTime: tsTime,
        latestTimestamp: d.timestamp,
        deliveryCount: liveCounts.get(sid) ?? 1,
      };
      // #2748 ST-3 (AC1): live-only sessions carry their derived name from the
      // single-pass collection — no per-row scan.
      if (liveMsg) {
        const derived = formatDerivedName(liveMsg.message);
        if (derived !== undefined) liveOnlySession.derivedName = derived;
      }
      merged.push(liveOnlySession);
    }

    // Exclude deleted sessions from all merge paths (REQ-3: prevent resurrection)
    // Check BOTH local ref (immediate UI feedback) and module-level set (cross-mount persistence)
    const deleted = deletedSessionIdsRef.current;
    let filtered = merged.filter((s) => !deleted.has(s.sessionId) && !isSessionDeleted(s.sessionId));

    // Sort newest-first by latestTimestamp
    return filtered.sort((a, b) => {
      return new Date(b.latestTimestamp).getTime() - new Date(a.latestTimestamp).getTime();
    });
  }, [persistedSessions, deliveries, loaded]);

  // Reset selected session if it no longer exists
  useEffect(() => {
    if (selectedSessionId && !sessions.some((s) => s.sessionId === selectedSessionId)) {
      setSelectedSessionId(null);
      userPickedRef.current = false;
    }
  }, [sessions, selectedSessionId]);

  // Auto-select the newest session when no session is selected and user hasn't manually picked one.
  //
  // Uses startTime (session creation time) instead of sessions[0] from the sorted list,
  // because sessions is sorted by latestTimestamp which gets overwritten by live delivery
  // timestamps from StreamContext. An old session with recent live deliveries in StreamContext
  // would sort before a newer-but-idle session, causing the wrong session to be auto-selected.
  useEffect(() => {
    if (userPickedRef.current === false && sessions.length > 0 && selectedSessionId === null) {
      const newest = sessions.reduce((a, b) => a.startTime > b.startTime ? a : b);
      setSelectedSessionId(newest.sessionId);
    }
  }, [sessions, selectedSessionId]);

  // ── Selection FOLLOWS the newly started live session (#2758 round-22 C1) ───
  // Previously selection was claimed exactly once ("only-if-null" above plus
  // the panel's equally one-shot follow guard): a panel mounted alongside any
  // existing (older) session locked onto it, and a NEWLY STARTED live session
  // never became selected. The builder intentionally processes ALL sessions,
  // but the Phase-3 emission filter (useMissionMonitor.ts visibleAgentCorrs)
  // admits only the SELECTED session — so every node for the live session was
  // silently suppressed and the canvas stayed empty despite provable
  // deliveries. Now a NEWLY SEEN chat-node sessionId arriving in live
  // deliveries retargets the selection whenever the user has NOT explicitly
  // picked one this lifetime (an explicit row click flips userPickedRef and
  // permanently disables following — never steal focus).
  //
  // Known sessionIds live in a ref SEEDED ON THE FIRST PASS (the first render's
  // deliveries snapshot): everything observable at mount predates this hook
  // instance and must not steal the pre-existing auto-select. Within the
  // lifetime the set only grows, so repeat deliveries for an already-seen
  // session never re-trigger.
  const seenLiveSessionIdsRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (seenLiveSessionIdsRef.current === null) {
      // First pass (mount): SEED ONLY — never retarget on restored/parked traffic.
      const seed = new Set<string>();
      for (const d of deliveries) {
        if (!isChatNodeDelivery(d)) continue;
        const sid = deliverySessionId(d);
        if (sid) seed.add(sid);
      }
      seenLiveSessionIdsRef.current = seed;
      return;
    }

    const seen = seenLiveSessionIdsRef.current;
    let newestNewSid: string | null = null;
    for (const d of deliveries) {
      if (!isChatNodeDelivery(d)) continue;
      const sid = deliverySessionId(d);
      if (sid && !seen.has(sid)) {
        // Append order == chronological arrival order — the LAST newly seen
        // sessionId wins when several appear in one batch.
        newestNewSid = sid;
      }
    }

    if (newestNewSid === null) return;

    if (userPickedRef.current) {
      // Explicit user pick is active — burn the pending new sessionId so it
      // cannot resurface as a steal after a later deselect/reset.
      seen.add(newestNewSid);
      return;
    }

    // Only follow sessions that exist in the derived list — excludes deleted
    // (REQ-3 anti-resurrection) and any filtered-out session. If the derived
    // list has not caught up yet (SQLite load still in flight), the sessionId
    // stays unseen and retries on the next deliveries batch (self-healing).
    if (sessions.some((s) => s.sessionId === newestNewSid)) {
      seen.add(newestNewSid);
      // Programmatic follow must NOT flip userPickedRef (unlike selectSession)
      // — following stays armed across multiple newly started sessions until
      // the user explicitly clicks a row.
      setSelectedSessionId(newestNewSid);
    }
  }, [deliveries, sessions]);

  // Filtered sessions by search — #2750 ST-3 (AC3): the filter matches the
  // session's display Name (`deriveDisplayName` = customName ?? derivedName ??
  // label, lib/sessionMeta.ts:153-155) IN ADDITION to the sessionId. A single
  // `.filter` pass keeps the exactly-once edge (AC3-2) automatic — a query
  // matching one session's Name and another's sessionId returns each matching
  // session exactly once. Empty query → all sessions (unchanged).
  //
  // #2750 AC3 round-2: the predicate queries EXACTLY the string the drawer row
  // renders — the drawer derives the same `deriveDisplayName(session)`
  // (SessionHistoryDrawer.tsx:289) from the same session object. Truncation
  // reconciliation: `derivedName` is stored in its DISPLAY form (truncated to
  // 40 chars incl. `…` by formatDerivedName at capture, lines 120-123 / 149-
  // 150), so BOTH the row text and this filter see the truncated string — a
  // user typing the visible truncated text matches, and text that only exists
  // beyond the 40-char cut is not visible on the row either (documented
  // behavior; pinned by useSessionHistory.test.ts truncation case).
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

  /**
   * #2758 round-22 C1: programmatically retarget selection WITHOUT flipping
   * userPickedRef (unlike selectSession). Used by the panel's follow guard so
   * following remains armed across multiple newly started sessions until the
   * user explicitly picks a row.
   */
  const followSession = useCallback((id: string | null) => {
    setSelectedSessionId(id);
  }, []);

  const deleteSession = useCallback(async (id: string) => {
    // Track deleted ID in BOTH local ref AND module-level set (REQ-3)
    // Local ref provides immediate UI feedback via re-render → useMemo re-run.
    // Module-level set provides cross-mount persistence (survives dialog close/reopen).
    deletedSessionIdsRef.current.add(id);
    markSessionDeleted(id);
    // Remove from SQLite
    await deleteSessionFromStore(id);
    // Remove from local state immediately (REQ-7)
    setPersistedSessions((prev) => prev.filter((s) => s.sessionId !== id));
    // Clear selection if the deleted session was selected (REQ-8)
    if (selectedSessionId === id) {
      setSelectedSessionId(null);
      userPickedRef.current = false;
    }
  }, [selectedSessionId]);

  /**
   * #2748 ST-3 (AC2 R-2.4): rename a session.
   *
   * Persists via ST-2's `saveCustomName` (atomic featureStoreUpdate;
   * empty/whitespace clears the custom name), then updates local state so the
   * drawer re-renders immediately with the new custom name. A live-only
   * session (persisted mid-stream after the mount snapshot) is upserted into
   * `persistedSessions` from the current merged view — otherwise the rename
   * would not surface until a remount.
   *
   * The session carries `customName` (authoritative) + `derivedName`; display
   * precedence (`customName ?? derivedName ?? label`) is resolved by
   * `deriveDisplayName` at render time.
   */
  const renameSession = useCallback(async (id: string, name: string) => {
    await saveCustomName(id, name);
    const trimmed = name.trim();
    const customName = trimmed.length > 0 ? trimmed : undefined;

    setPersistedSessions((prev) => {
      const existing = prev.some((s) => s.sessionId === id);
      if (existing) {
        return prev.map((s) => (s.sessionId === id ? { ...s, customName } : s));
      }
      // Live-only session — carry its merged view into the snapshot so the
      // memo re-renders the renamed row immediately (no-op if it vanished).
      const live = sessions.find((s) => s.sessionId === id);
      if (!live) return prev;
      return [...prev, { ...live, customName }];
    });
  }, [sessions]);

  return {
    sessions,
    filteredSessions,
    selectedSessionId,
    selectSession,
    followSession,
    deleteSession,
    renameSession,
    refreshSessions,
    searchFilter,
    setSearchFilter,
    userPickedRef,
  };
}
