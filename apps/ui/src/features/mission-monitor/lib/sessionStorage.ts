/**
 * sessionStorage.ts — pure localStorage helpers for Mission Monitor.
 *
 * Sessions are keyed by event.sessionId (the field on every StreamEvent).
 * Contracts are persisted on every lifecycle transition in live mode.
 * Replay mode reads stored contracts through the same delivery-to-node pipeline.
 */
import type { ChatNodeContract, SubagentContract, LifecycleState } from '../../../shared/classes/EventSubscription';

const SESSIONS_KEY = 'mm:sessions';
const MAX_SESSIONS = 50;

export interface SessionRecord {
  sessionId: string;
  /** Human-readable locale date/time of the first event seen */
  label: string;
  startTime: number;
  endTime?: number;
  eventCount: number;
}

export interface StoredSessionContracts {
  sessionId: string;
  chatNodes: Array<{
    correlationId: string;
    lifecycle: LifecycleState;
    contract: ChatNodeContract;
    timestamp: string;
  }>;
  subagents: Array<{
    correlationId: string;
    lifecycle: LifecycleState;
    contract: SubagentContract;
    timestamp: string;
  }>;
}

function contractsKey(sessionId: string): string {
  return `mm:contracts:${sessionId}`;
}

export function loadContracts(sessionId: string): StoredSessionContracts | null {
  try {
    const raw = localStorage.getItem(contractsKey(sessionId));
    if (!raw) return null;
    return JSON.parse(raw) as StoredSessionContracts;
  } catch {
    return null;
  }
}

export function persistContracts(
  sessionId: string,
  contracts: StoredSessionContracts,
): void {
  try {
    localStorage.setItem(contractsKey(sessionId), JSON.stringify(contracts));
  } catch {
    console.warn('[MissionMonitor] Could not persist contracts');
  }

  // ── Upsert session record ──────────────────────────────────────────────────
  try {
    const sessions = loadSessions();
    const idx = sessions.findIndex((s) => s.sessionId === sessionId);
    const eventTime = contracts.chatNodes.length > 0
      ? new Date(contracts.chatNodes[0].timestamp).getTime()
      : Date.now();

    if (idx !== -1) {
      sessions[idx] = {
        ...sessions[idx],
        eventCount: contracts.chatNodes.length + contracts.subagents.length,
        startTime: Math.min(sessions[idx].startTime, eventTime),
      };
      saveSessions(sessions);
    } else {
      const newRecord: SessionRecord = {
        sessionId,
        label: new Date(eventTime).toLocaleString(),
        startTime: eventTime,
        eventCount: contracts.chatNodes.length + contracts.subagents.length,
      };
      const next = [newRecord, ...sessions];
      // Prune oldest session when over cap
      if (next.length > MAX_SESSIONS) {
        const pruned = next.pop()!;
        try { localStorage.removeItem(contractsKey(pruned.sessionId)); } catch {}
      }
      saveSessions(next);
    }
  } catch {
    console.warn('[MissionMonitor] Could not upsert session record');
  }
}

export function loadSessions(): SessionRecord[] {
  try {
    return JSON.parse(localStorage.getItem(SESSIONS_KEY) ?? '[]');
  } catch {
    return [];
  }
}

function saveSessions(sessions: SessionRecord[]): void {
  try {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
  } catch {
    console.warn('[MissionMonitor] Could not persist sessions');
  }
}

export function finalizeSession(sessionId: string): void {
  try {
    const sessions = loadSessions().map((s) =>
      s.sessionId === sessionId && !s.endTime ? { ...s, endTime: Date.now() } : s
    );
    saveSessions(sessions);
  } catch {}
}

export function deleteSession(sessionId: string): void {
  try { localStorage.removeItem(contractsKey(sessionId)); } catch {}
  try {
    saveSessions(loadSessions().filter((s) => s.sessionId !== sessionId));
  } catch {}
}
