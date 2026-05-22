/**
 * useDevModeStream
 *
 * Reads events from the shared StreamContext (populated via inject.ts → Fredo_STREAM_EVENT)
 * and accumulates them in local state without a TTL so nothing is pruned while debugging.
 *
 * Previously connected to /api/v1/dev-mode/stream (a separate backend SSE endpoint that
 * shared no Redis instance with the local MCP server). That path is no longer used.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useStream } from '../../../shared/contexts/StreamContext';
import type { FredoEvent, Transport } from '../../../shared/contexts/StreamContext';

export interface DevModeStreamState {
  events: FredoEvent[];
  /** Unique event types (toolName or hook event_type) seen, ordered by first occurrence */
  eventTypes: string[];
  /** Unique event transports seen */
  transports: Transport[];
  isConnected: boolean;
  clearEvents: () => void;
}

export function useDevModeStream(): DevModeStreamState {
  const { events: streamEvents, isConnected, clearEvents: clearStreamEvents } = useStream();

  // Unbounded local accumulator — not pruned by StreamContext's 60 s TTL
  const [accumulated, setAccumulated] = useState<FredoEvent[]>([]);

  // Tracks event keys already added so hot-reloads / double-fires don't duplicate
  const seenKeysRef = useRef<Set<string>>(new Set());

  // Only show events that arrived AFTER Dev Mode was opened this session.
  // Prevents stale StreamContext events (< 60 s TTL) from re-populating the
  // list every time the user closes and reopens the panel.
  const mountTimeRef = useRef<number>(Date.now());

  useEffect(() => {
    const newEvents: FredoEvent[] = [];
    for (const ev of streamEvents) {
      const key = ev.id || `${ev.toolName ?? ''}:${ev.state}:${ev.timestamp}`;
      if (!seenKeysRef.current.has(key)) {
        seenKeysRef.current.add(key);
        // Only accumulate events that arrived after this Dev Mode session opened
        const evTime = new Date(ev.timestamp).getTime();
        if (evTime >= mountTimeRef.current) {
          newEvents.push(ev);
        }
      }
    }
    if (newEvents.length > 0) {
      // Prepend so newest events appear at the top (matches original UI order)
      setAccumulated((prev) => [...newEvents.reverse(), ...prev]);
    }
  }, [streamEvents]);

  // Derive unique event types from accumulated events
  // For OTLP events: use toolName directly (set by mapping.rs to span/metric/log name)
  // For hook events: extract event_type from payload if available
  const eventTypes = useMemo(() => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const ev of accumulated) {
      let label: string;
      if (ev.transport === 'otlp_grpc' || ev.transport === 'otlp_http') {
        const meta = ev.metadata as { signal?: string } | null;
        label = meta?.signal ? `${meta.signal.toLowerCase()}:${ev.toolName}` : (ev.toolName ?? 'unknown');
      } else {
        const pay = ev.payload as any;
        label = pay?.event_type ?? ev.toolName ?? 'unknown';
      }
      if (!seen.has(label)) {
        seen.add(label);
        result.push(label);
      }
    }
    return result;
  }, [accumulated]);

  // Derive unique transports seen
  const transports = useMemo(() => {
    const seen = new Set<Transport>();
    const result: Transport[] = [];
    for (const ev of accumulated) {
      const t: Transport = ev.transport ?? 'hook';
      if (!seen.has(t)) { seen.add(t); result.push(t); }
    }
    return result;
  }, [accumulated]);

  const clearEvents = useCallback(() => {
    setAccumulated([]);
    seenKeysRef.current.clear();
    // Also flush the raw StreamContext queue so no stale events
    // re-enter on the next render cycle
    clearStreamEvents();
  }, [clearStreamEvents]);

  return { events: accumulated, eventTypes, transports, isConnected, clearEvents };
}
