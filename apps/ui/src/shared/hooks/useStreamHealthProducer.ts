/**
 * useStreamHealthProducer — the stream-health liveness producer (Spec #3064 ST-3).
 *
 * Drives the shared three-valued stream health (`StreamContext.setStreamHealth`)
 * from the REAL backend signal: a bounded interval runs ONE read-only
 * `stream_health` IPC probe per tick (derived through the pure
 * `deriveStreamHealth`), and a pushed `{"streamHealth": …}` heartbeat applies its
 * state immediately (event-driven recovery, zero IPC).
 *
 * Design invariants (R-6 / the AGENTS.md #523 re-render-loop guardrails):
 *   - ONE bounded interval while mounted; at most ONE IPC probe per tick.
 *   - ZERO IPC on a re-render — `probe` and `onHeartbeat` are stable
 *     (`useCallback` over stable refs), so the interval effect runs once.
 *   - A monotonic sequence guard drops a stale probe response that a fresher
 *     heartbeat (or a newer tick) has superseded.
 *   - Unmount reports `down` (the producer is gone — no signal can arrive).
 *
 * Test-only induction seam (inert by default — G-376, mirroring the FS-1
 * `resolveForceTelemetryDown` precedent in `useFredoHealth`): the frontend
 * runtime mirror lets a tester drive the `degraded`/`down` state MAPPING/RENDER
 * when a genuine outage cannot be produced on demand. Read on the bounded tick,
 * so a mid-session toggle re-derives on the next tick; with it unset the
 * behaviour is byte-identical.
 */

import { useCallback, useEffect, useRef } from 'react';

import type { HostAdapter } from '../../app/adapters/HostAdapter';
import { useStream } from '../contexts/StreamContext';
import {
  deriveStreamHealth,
  STREAM_HEALTH_CHECK_INTERVAL_MS,
  type StreamHealth,
  type StreamHealthHeartbeat,
  type StreamHealthProbe,
} from './streamHealth';

// ── Test-only induction seam (Spec #3064 ST-3, G-376) ────────────────────────

/** Build-time Vite flag (`VITE_*`, following the FS-1 precedent). */
export const FORCE_STREAM_HEALTH_FLAG = 'VITE_FREDO_STREAM_HEALTH_FORCE';
/** Runtime `window` key: `window.__FREDO_STREAM_HEALTH_FORCE__ = 'degraded' | 'down'`. */
export const FORCE_STREAM_HEALTH_WINDOW_KEY = '__FREDO_STREAM_HEALTH_FORCE__';
/** Runtime `sessionStorage` key: set it to `'degraded' | 'down'`. */
export const FORCE_STREAM_HEALTH_STORAGE_KEY = 'fredoStreamHealthForce';

/** Narrow view of the test-injectable `window` key (no global augmentation). */
interface StreamHealthTestWindow {
  __FREDO_STREAM_HEALTH_FORCE__?: unknown;
}

function testWindow(): StreamHealthTestWindow | null {
  return typeof window === 'undefined' ? null : (window as StreamHealthTestWindow);
}

/** A runtime value is a force token only for `degraded`/`down`; anything else is inert. */
function forceToken(value: unknown): StreamHealth | null {
  return value === 'degraded' || value === 'down' ? value : null;
}

/**
 * Resolve the test-only frontend outage lever (ST-3). Returns `degraded`/`down`
 * when the Vite flag or a runtime key (window / sessionStorage) carries a valid
 * token; `null` (inert) for unset/blank/unknown. Read on the bounded tick so a
 * mid-session toggle re-derives on the next tick.
 */
export function resolveStreamHealthForce(): StreamHealth | null {
  const fromVite = forceToken(import.meta.env.VITE_FREDO_STREAM_HEALTH_FORCE);
  if (fromVite) return fromVite;
  const fromWindow = forceToken(testWindow()?.__FREDO_STREAM_HEALTH_FORCE__);
  if (fromWindow) return fromWindow;
  try {
    return forceToken(window.sessionStorage?.getItem(FORCE_STREAM_HEALTH_STORAGE_KEY));
  } catch {
    return null;
  }
}

/**
 * Normalize the backend `stream_health` snapshot
 * (`{ seq, ingestConnected, ageMs, forced }`) into the pure probe shape. A
 * missing/invalid `ageMs` fails closed to `+Infinity` (stale) so an unknown
 * snapshot can never read `healthy`.
 */
function normalizeSnapshot(raw: unknown): StreamHealthProbe | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const snapshot = raw as { ingestConnected?: unknown; ageMs?: unknown };
  const ageMs =
    typeof snapshot.ageMs === 'number' && Number.isFinite(snapshot.ageMs)
      ? snapshot.ageMs
      : Number.POSITIVE_INFINITY;
  return { ok: true, ageMs, ingestConnected: snapshot.ingestConnected === true };
}

/** Derive the health a freshly pushed heartbeat proves (event-driven recovery). */
function healthFromHeartbeat(heartbeat: StreamHealthHeartbeat): StreamHealth {
  return deriveStreamHealth({
    ok: true,
    ageMs: heartbeat.ageMs,
    ingestConnected: heartbeat.ingestConnected,
  });
}

/**
 * The stream-health liveness producer. Returns the stable `onHeartbeat` the
 * host-message router calls when a `{"streamHealth": …}` envelope arrives.
 */
export function useStreamHealthProducer(adapter: HostAdapter): {
  onHeartbeat: (heartbeat: StreamHealthHeartbeat) => void;
} {
  const { setStreamHealth } = useStream();
  // Monotonic guard: a heartbeat (or a newer tick) supersedes any probe already
  // in flight, so a stale probe response can never clobber a fresher signal.
  const seqRef = useRef(0);

  /** Apply a pushed heartbeat immediately — event-driven recovery, zero IPC. */
  const onHeartbeat = useCallback(
    (heartbeat: StreamHealthHeartbeat) => {
      seqRef.current += 1;
      setStreamHealth(healthFromHeartbeat(heartbeat));
    },
    [setStreamHealth],
  );

  /** ONE bounded probe per tick; zero IPC on a re-render (stable callback). */
  const probe = useCallback(async () => {
    const seq = ++seqRef.current;
    // The test-only runtime mirror short-circuits the probe (state mapping).
    const force = resolveStreamHealthForce();
    if (force) {
      setStreamHealth(force);
      return;
    }
    const invoke = adapter.invoke;
    if (typeof invoke !== 'function') {
      // No IPC transport (dev/browser) — the probe cannot prove liveness.
      if (seq === seqRef.current) setStreamHealth('down');
      return;
    }
    let result: StreamHealthProbe;
    try {
      result = normalizeSnapshot(await invoke('stream_health')) ?? {
        ok: false,
        ageMs: 0,
        ingestConnected: false,
      };
    } catch {
      result = { ok: false, ageMs: 0, ingestConnected: false };
    }
    if (seq !== seqRef.current) return; // superseded by a heartbeat/newer tick
    setStreamHealth(deriveStreamHealth(result));
  }, [adapter, setStreamHealth]);

  // ONE bounded interval while mounted. `probe`/`setStreamHealth` are stable, so
  // this effect never re-runs on a re-render — and therefore issues ZERO IPC per
  // render. The immediate `probe()` settles the cold-start state within one tick.
  useEffect(() => {
    void probe();
    const id = setInterval(() => {
      void probe();
    }, STREAM_HEALTH_CHECK_INTERVAL_MS);
    return () => {
      clearInterval(id);
      // The producer is unmounted — no signal can arrive; report `down`.
      setStreamHealth('down');
    };
  }, [probe, setStreamHealth]);

  return { onHeartbeat };
}
