/**
 * useFredoHealth — the whole-system health aggregator (Spec #3052 ST-2).
 *
 * Consumes the event-driven telemetry flag (`useConnectionStatus`, never
 * polled) and probes THREE read-only backend commands on ONE bounded interval
 * (`HEALTH_POLL_INTERVAL_MS`) — `check_companion_readiness`,
 * `get_llama_server_status`, `pg_supervisor_status` — then derives `FredoHealth`
 * via the pure ST-1 helpers.
 *
 * Design invariants (R-6 / the AGENTS.md #523 re-render-loop guardrails):
 *   - ONE bounded interval while mounted; at most THREE read-only IPCs per tick.
 *   - NO IPC on a re-render — the probe callbacks are stable and the interval
 *     effect depends only on them, never on a value that changes each render.
 *   - Display state is derived in `useMemo`; the returned object is memoized.
 *   - A monotonic sequence guard drops stale/out-of-order probe responses.
 *   - The `llama-server-status` push event applies its payload immediately
 *     (no IPC) so an exit flips the line without waiting a tick.
 *
 * Deliberately does NOT mount `useCompanionReadiness`: that hook's auto-launch
 * effect would start the managed server at app start and it probes STT devices
 * (G-023). It only reuses the same `adapterBridge` command surface.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { adapterBridge } from '../utils/adapterBridge';
import { useConnectionStatus } from '../contexts/StreamContext';
import {
  aggregateFredoHealth,
  deriveSubsystemLines,
  type FredoCompanionSnapshot,
  type FredoHealth,
  type FredoHealthSnapshots,
  type FredoLlamaServerSnapshot,
  type FredoPgState,
} from './fredoHealth';

/**
 * The single bounded poll cadence for the health probes. Telemetry is
 * event-driven and is NEVER polled; each tick issues at most three read-only
 * IPCs (companion readiness + llama server + Postgres).
 */
export const HEALTH_POLL_INTERVAL_MS = 15_000;

/** The resolved raw probes (a `null` field = unresolved/unavailable → neutral `unknown`). */
interface HealthProbeState {
  companion: FredoCompanionSnapshot | null;
  llamaServer: FredoLlamaServerSnapshot | null;
  postgres: { state: FredoPgState } | null;
}

const EMPTY_PROBE_STATE: HealthProbeState = {
  companion: null,
  llamaServer: null,
  postgres: null,
};

const PG_STATES: readonly FredoPgState[] = [
  'disabled',
  'starting',
  'ready',
  'attached',
  'failed',
];

/**
 * Normalize `check_companion_readiness` into the minimal companion snapshot.
 * The backend owns the prerequisite set; a missing/unknown shape fails closed
 * (returns `null` → the companion lines stay neutral `unknown`).
 */
function normalizeCompanion(raw: unknown): FredoCompanionSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const prerequisites = (raw as { prerequisites?: unknown }).prerequisites;
  if (!Array.isArray(prerequisites)) return null;

  let sawLlama = false;
  let sawModels = false;
  let llamaServerInstalled = false;
  let modelFilesComplete = false;
  for (const entry of prerequisites) {
    if (!entry || typeof entry !== 'object') continue;
    const { id, state } = entry as { id?: unknown; state?: unknown };
    if (id === 'llamaServer') {
      sawLlama = true;
      llamaServerInstalled = state === 'installed';
    } else if (id === 'modelFiles') {
      sawModels = true;
      modelFilesComplete = state === 'installed';
    }
  }
  if (!sawLlama || !sawModels) return null;
  return { llamaServerInstalled, modelFilesComplete };
}

/** Normalize `get_llama_server_status` (also the `llama-server-status` event payload). */
function normalizeLlamaServer(raw: unknown): FredoLlamaServerSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const { running, healthy } = raw as { running?: unknown; healthy?: unknown };
  if (typeof running !== 'boolean' || typeof healthy !== 'boolean') return null;
  return { running, healthy };
}

/** Normalize `pg_supervisor_status` — only the lifecycle state is consumed. */
function normalizePostgres(raw: unknown): { state: FredoPgState } | null {
  if (!raw || typeof raw !== 'object') return null;
  const { state } = raw as { state?: unknown };
  if (typeof state !== 'string' || !(PG_STATES as readonly string[]).includes(state)) {
    return null;
  }
  return { state: state as FredoPgState };
}

export function useFredoHealth(): FredoHealth {
  const { isConnected } = useConnectionStatus();
  const [probeState, setProbeState] = useState<HealthProbeState>(EMPTY_PROBE_STATE);
  // Monotonic request sequence — a response whose seq is no longer current is
  // a stale/out-of-order probe and is dropped.
  const seqRef = useRef(0);

  /** One probe tick: at most three read-only IPCs, applied only if still current. */
  const runProbes = useCallback(async () => {
    const seq = ++seqRef.current;
    const [companionRaw, llamaRaw, pgRaw] = await Promise.all([
      adapterBridge.invoke<unknown>('check_companion_readiness'),
      adapterBridge.invoke<unknown>('get_llama_server_status'),
      adapterBridge.invoke<unknown>('pg_supervisor_status'),
    ]);
    if (seq !== seqRef.current) return; // superseded by a newer probe/event
    setProbeState({
      companion: normalizeCompanion(companionRaw),
      llamaServer: normalizeLlamaServer(llamaRaw),
      postgres: normalizePostgres(pgRaw),
    });
  }, []);

  /**
   * Apply a pushed `llama-server-status` payload immediately (no IPC) so an exit
   * flips the line at once. Bumps the seq so any probe already in flight cannot
   * clobber the fresher push with an older snapshot.
   */
  const applyLlamaServerEvent = useCallback((payload: unknown) => {
    const llamaServer = normalizeLlamaServer(payload);
    if (!llamaServer) return;
    seqRef.current += 1;
    setProbeState((prev) => ({ ...prev, llamaServer }));
  }, []);

  // ONE bounded interval while mounted. `runProbes` is stable, so this effect
  // never re-runs on a re-render — and therefore never issues IPC per render.
  useEffect(() => {
    void runProbes();
    const id = setInterval(() => {
      void runProbes();
    }, HEALTH_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [runProbes]);

  // Immediate llama refresh on the existing push channel.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const un = await adapterBridge.listen<unknown>('llama-server-status', (payload) => {
        applyLlamaServerEvent(payload);
      });
      if (cancelled) un();
      else unlisten = un;
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [applyLlamaServerEvent]);

  const snapshots = useMemo<FredoHealthSnapshots>(
    () => ({
      telemetryConnected: isConnected,
      companion: probeState.companion,
      llamaServer: probeState.llamaServer,
      postgres: probeState.postgres,
    }),
    [isConnected, probeState],
  );

  return useMemo<FredoHealth>(() => {
    const subsystems = deriveSubsystemLines(snapshots);
    return { overall: aggregateFredoHealth(subsystems), subsystems };
  }, [snapshots]);
}
