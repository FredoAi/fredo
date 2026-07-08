import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import type { ContractDelivery } from '../../../shared/classes/EventSubscription';
import type { MissionMonitorSession } from '../lib/contract';
import { isChatNodeDelivery, deliverySessionId } from '../lib/contract';
import { loadPersistedSessions, deleteSessionFromStore, markSessionDeleted, isSessionDeleted } from '../lib/persistence';
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

    // Build a map of sessionId → live delivery count from StreamContext
    const liveCounts = new Map<string, number>();
    const liveTimestamps = new Map<string, string>();
    const liveStartTimes = new Map<string, number>();

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
    }

    // Merge persisted sessions with live data
    const merged = persistedSessions.map((s) => {
      const liveCount = liveCounts.get(s.sessionId);
      const liveTs = liveTimestamps.get(s.sessionId);
      const liveStart = liveStartTimes.get(s.sessionId);
      return {
        ...s,
        deliveryCount: liveCount !== undefined ? s.deliveryCount + liveCount : s.deliveryCount,
        latestTimestamp: liveTs ?? s.latestTimestamp,
        startTime: liveStart ?? s.startTime,
      };
    });

    // Add sessions from live deliveries that aren't yet persisted
    const persistedIds = new Set(persistedSessions.map((s) => s.sessionId));

    for (const d of deliveries) {
      if (!isChatNodeDelivery(d)) continue;
      const sid = deliverySessionId(d);
      if (!sid || persistedIds.has(sid)) continue;

      persistedIds.add(sid);
      const tsTime = new Date(d.timestamp).getTime();
      merged.push({
        sessionId: sid,
        label: new Date(tsTime).toLocaleString(),
        startTime: tsTime,
        latestTimestamp: d.timestamp,
        deliveryCount: liveCounts.get(sid) ?? 1,
      });
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

  return {
    sessions,
    filteredSessions,
    selectedSessionId,
    selectSession,
    deleteSession,
    searchFilter,
    setSearchFilter,
    userPickedRef,
  };
}
