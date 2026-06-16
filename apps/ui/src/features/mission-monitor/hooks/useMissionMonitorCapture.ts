import { useEffect, useRef } from "react";
import { useStream } from "../../../shared/contexts/StreamContext";
import { persistEvent } from "../lib/sessionStorage";
import { captureFilter } from "../MissionMonitorFeature";

export function useMissionMonitorCapture(): void {
  const { events } = useStream();
  const seenRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    for (const ev of events) {
      if (!captureFilter(ev)) continue;
      const key = ev.id ?? `${ev.toolName}:${ev.state}:${ev.sessionId}:${ev.timestamp}`;
      if (!seenRef.current.has(key)) {
        seenRef.current.add(key);
        persistEvent(ev);
      }
    }
  }, [events]);
}
