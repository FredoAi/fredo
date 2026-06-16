import { useEffect, useRef } from "react";
import { useStream } from "../../../shared/contexts/StreamContext";
import { persistEvent } from "../lib/sessionStorage";
import { captureFilter } from "../MissionMonitorFeature";

export function useMissionMonitorCapture(): void {
  const { events } = useStream();
  const processedCountRef = useRef(0);
  const seenRef = useRef<Set<string>>(new Set());

  // Process new events after every render — no dependency array ensures
  // the effect always runs, immune to React batching/ref-identity edge cases.
  useEffect(() => {
    for (let i = processedCountRef.current; i < events.length; i++) {
      const ev = events[i];
      if (!captureFilter(ev)) continue;
      const key = ev.id ?? `${ev.toolName}:${ev.state}:${ev.sessionId}:${ev.timestamp}`;
      if (!seenRef.current.has(key)) {
        seenRef.current.add(key);
        persistEvent(ev);
      }
    }
    processedCountRef.current = events.length;
  });
}
