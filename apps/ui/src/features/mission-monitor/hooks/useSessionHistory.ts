import { useState, useCallback, useEffect } from 'react';
import {
  loadSessions,
  deleteSession as storageDelete,
  finalizeSession as storageFinalize,
} from '../lib/sessionStorage';

export type { SessionRecord } from '../lib/sessionStorage';

/**
 * Provides a reactive session list and session management callbacks.
 *
 * Persistence is handled by persistContracts() inside useMissionMonitor — this
 * hook only reads from / reacts to localStorage changes.
 */
export function useSessionHistory() {
  const [sessions, setSessions] = useState(loadSessions);

  // Re-read on mount in case events were stored while the panel was closed.
  useEffect(() => {
    setSessions(loadSessions());
  }, []);

  const refreshSessions = useCallback(() => {
    setSessions(loadSessions());
  }, []);

  const deleteSession = useCallback((sessionId: string) => {
    storageDelete(sessionId);
    setSessions((prev) => prev.filter((s) => s.sessionId !== sessionId));
  }, []);

  const finalizeSession = useCallback((sessionId: string) => {
    storageFinalize(sessionId);
    setSessions(loadSessions());
  }, []);

  return { sessions, refreshSessions, deleteSession, finalizeSession };
}
