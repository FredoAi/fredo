/**
 * sessionStorage.ts — pure localStorage helpers for Mission Monitor.
 *
 * Sessions are keyed by event.sessionId (the field on every StreamEvent).
 * persistEvent() is called directly from MissionMonitorFeature.processEvent(),
 * which runs for EVERY event — even when the panel is closed — so sessions
 * accumulate in the background automatically.
 */
import type { StreamEvent } from '../../../shared/contexts/StreamContext';

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

function eventsKey(sessionId: string): string {
  return `mm:events:${sessionId}`;
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

export function getSessionEvents(sessionId: string): StreamEvent[] {
  try {
    return JSON.parse(localStorage.getItem(eventsKey(sessionId)) ?? '[]');
  } catch {
    return [];
  }
}

/**
 * Persist a single event.  Creates or upserts the session record automatically
 * using event.sessionId — no SessionStart event required.
 *
 * Safe to call outside React (no hooks). Called from MissionMonitorFeature.processEvent().
 */
export function persistEvent(event: StreamEvent): void {
  if (!event.sessionId) return;

  const sessionId = event.sessionId;

  // ── Append event (deduplicate by eventId / composite key) ──────────────────
  try {
    const existing = getSessionEvents(sessionId);
    const dedupeKey =
      event.eventId ?? `${event.toolName}:${event.state}:${event.timestamp}`;
    const alreadyStored = existing.some((e) => {
      const k = e.eventId ?? `${e.toolName}:${e.state}:${e.timestamp}`;
      return k === dedupeKey;
    });
    if (!alreadyStored) {
      localStorage.setItem(eventsKey(sessionId), JSON.stringify([...existing, event]));
    }
  } catch {
    console.warn('[MissionMonitor] Could not store event');
    return;
  }

  // ── Upsert session record ──────────────────────────────────────────────────
  try {
    const sessions = loadSessions();
    const idx = sessions.findIndex((s) => s.sessionId === sessionId);
    const eventTime = new Date(event.timestamp).getTime();

    if (idx !== -1) {
      sessions[idx] = {
        ...sessions[idx],
        eventCount: sessions[idx].eventCount + 1,
        startTime: Math.min(sessions[idx].startTime, eventTime),
      };
      saveSessions(sessions);
    } else {
      const newRecord: SessionRecord = {
        sessionId,
        label: new Date(eventTime).toLocaleString(),
        startTime: eventTime,
        eventCount: 1,
      };
      const next = [newRecord, ...sessions];
      // Prune oldest session when over cap
      if (next.length > MAX_SESSIONS) {
        const pruned = next.pop()!;
        try { localStorage.removeItem(eventsKey(pruned.sessionId)); } catch {}
      }
      saveSessions(next);
    }
  } catch {
    console.warn('[MissionMonitor] Could not upsert session record');
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
  try { localStorage.removeItem(eventsKey(sessionId)); } catch {}
  try {
    saveSessions(loadSessions().filter((s) => s.sessionId !== sessionId));
  } catch {}
}
