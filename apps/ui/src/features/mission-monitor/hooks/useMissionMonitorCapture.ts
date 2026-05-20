/**
 * useMissionMonitorCapture
 *
 * Subscribes directly to StreamContext and persists EVERY event to localStorage
 * via persistEvent(). This runs unconditionally — regardless of whether the
 * Mission Monitor window is open — so no events are ever dropped.
 *
 * Mount once near the app root (e.g. in Home.tsx) via the companion component
 * MissionMonitorCaptureMount.
 */
import { useEffect, useRef } from 'react';
import { useStream } from '../../../shared/contexts/StreamContext';
import { persistEvent } from '../lib/sessionStorage';

export function useMissionMonitorCapture(): void {
  const { events } = useStream();
  const seenRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    for (const ev of events) {
      const key = ev.eventId ?? `${ev.toolName}:${ev.state}:${ev.sessionId}:${ev.timestamp}`;
      if (!seenRef.current.has(key)) {
        seenRef.current.add(key);
        persistEvent(ev);
      }
    }
  }, [events]);
}
