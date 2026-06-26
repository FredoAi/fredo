import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import type { ContractDelivery } from '../../../shared/classes/EventSubscription';
import type { MissionMonitorSession } from '../lib/contract';
import { isChatNodeDelivery, deliverySessionId } from '../lib/contract';

/**
 * useDeliverySessions — derives sessions from ContractDelivery[].
 *
 * Takes deliveries as input (NOT from localStorage).
 * Returns sessions grouped by sessionId, sorted newest-first.
 *
 * @param deliveries - ContractDelivery[] from StreamContext.deliveries
 * @returns sessions, selectedSessionId, selectSession, searchFilter, setSearchFilter, filteredSessions
 */
export function useDeliverySessions(deliveries: ContractDelivery[]) {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [searchFilter, setSearchFilter] = useState('');
  const userPickedRef = useRef(false);

  // Derive sessions from deliveries using useMemo with stable deps
  const sessions = useMemo<MissionMonitorSession[]>(() => {
    const chatDeliveries = deliveries.filter(isChatNodeDelivery);
    const sessionMap = new Map<string, {
      startTime: number;
      latestTimestamp: string;
      deliveryCount: number;
    }>();

    for (const d of chatDeliveries) {
      const sid = deliverySessionId(d);
      if (!sid) continue;

      const existing = sessionMap.get(sid);
      const ts = d.timestamp;
      const tsTime = new Date(ts).getTime();

      if (existing) {
        sessionMap.set(sid, {
          startTime: Math.min(existing.startTime, tsTime),
          latestTimestamp: ts > existing.latestTimestamp ? ts : existing.latestTimestamp,
          deliveryCount: existing.deliveryCount + 1,
        });
      } else {
        sessionMap.set(sid, {
          startTime: tsTime,
          latestTimestamp: ts,
          deliveryCount: 1,
        });
      }
    }

    return Array.from(sessionMap.entries())
      .map(([sessionId, info]) => ({
        sessionId,
        label: new Date(info.startTime).toLocaleString(),
        startTime: info.startTime,
        latestTimestamp: info.latestTimestamp,
        deliveryCount: info.deliveryCount,
      }))
      .sort((a, b) => new Date(b.latestTimestamp).getTime() - new Date(a.latestTimestamp).getTime());
  }, [deliveries]);

  // Reset selected session if it no longer exists (but don't auto-select)
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

  return {
    sessions,
    filteredSessions,
    selectedSessionId,
    selectSession,
    searchFilter,
    setSearchFilter,
    userPickedRef,
  };
}
