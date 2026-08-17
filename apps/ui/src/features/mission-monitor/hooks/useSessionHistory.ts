import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import type { ContractDelivery } from '../../../shared/classes/EventSubscription';
import type { MissionMonitorSession } from '../lib/graph';
import { isChatNodeDelivery, deliverySessionId, extractDeliveryPayload } from '../lib/graph';
import { loadPersistedSessions, deleteSessionFromStore, markSessionDeleted, isSessionDeleted, saveCustomName } from '../lib/persistence';
import { formatDerivedName } from '../lib/sessionMeta';
import { useStream } from '../../../shared/contexts/StreamContext';

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

  // Load persisted sessions from SQLite on mount
  useEffect(() => {
    let cancelled = false;
    loadPersistedSessions().then((sessions) => {
      if (!cancelled) {
        setPersistedSessions(sessions);
        setLoaded(true);
      }
    });
    return () => { cancelled = true; };
  }, []);

  // Access live deliveries from StreamContext to merge delivery counts
  const { deliveries } = useStream();

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

  // Filtered sessions by search
  const filteredSessions = useMemo(() => {
    if (!searchFilter) return sessions;
    const lower = searchFilter.toLowerCase();
    return sessions.filter((s) => s.sessionId.toLowerCase().includes(lower));
  }, [sessions, searchFilter]);

  const selectSession = useCallback((id: string | null) => {
    userPickedRef.current = true;
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
    deleteSession,
    renameSession,
    searchFilter,
    setSearchFilter,
    userPickedRef,
  };
}
