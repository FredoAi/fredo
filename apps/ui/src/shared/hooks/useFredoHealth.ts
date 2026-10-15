/**
 * useFredoHealth — the whole-system health aggregator (Spec #3052 ST-2).
 *
 * Consumes the event-driven three-valued stream health (`useStreamHealth`,
 * never polled) and probes THREE read-only backend commands on ONE bounded
 * interval (`HEALTH_POLL_INTERVAL_MS`) — `check_companion_readiness`,
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
 * Test-only induction seams (inert by default — G-275, mirroring the sanctioned
 * `FREDO_PG_FORCE_START_FAIL` precedent) let a tester drive the two states the
 * product itself cannot produce on demand:
 *   - `resolveForceTelemetryDown()` forces the telemetry line `down` (the
 *     connection flag is a MOUNT flag today, so no real outage state exists);
 *   - `recordProbeSet()` exposes a `window`-visible probe-set counter so the
 *     bounded poll budget can be measured live (the `__TAURI_INTERNALS__.invoke`
 *     used for real IPC is non-writable and cannot be instrumented).
 * Both are read on the bounded tick, so a mid-session runtime toggle re-derives
 * on the next poll; with neither signal set the behaviour is byte-identical.
 *
 * Deliberately does NOT mount `useCompanionReadiness`: that hook's auto-launch
 * effect would start the managed server at app start and it probes STT devices
 * (G-023). It only reuses the same `adapterBridge` command surface.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { adapterBridge } from '../utils/adapterBridge';
import { useStreamHealth } from '../contexts/StreamContext';
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

// ── Test-only induction seams (Spec #3052 round 2 — FS-1 / FS-4) ─────────────
//
// INERT BY DEFAULT: with neither signal set the behaviour is byte-identical to
// the un-seamed hook. Each seam mirrors the sanctioned backend env-seam
// precedent (`FREDO_PG_FORCE_START_FAIL`). The runtime keys are read on the
// bounded tick so a mid-session toggle re-derives on the next poll.

/** Build-time Vite flag (`VITE_*`, following `shared/constants/api.ts`). */
export const FORCE_TELEMETRY_DOWN_FLAG = 'VITE_FREDO_HEALTH_FORCE_TELEMETRY_DOWN';
/** Runtime `window` key: `window.__FREDO_HEALTH_FORCE_TELEMETRY_DOWN__ = true`. */
export const FORCE_TELEMETRY_DOWN_WINDOW_KEY = '__FREDO_HEALTH_FORCE_TELEMETRY_DOWN__';
/** Runtime `sessionStorage` key: set it to `'1'`. */
export const FORCE_TELEMETRY_DOWN_STORAGE_KEY = 'fredoHealthForceTelemetryDown';
/** Runtime instrument flag (`window` key or `sessionStorage` key set to `'1'`). */
export const INSTRUMENT_PROBES_WINDOW_KEY = '__FREDO_HEALTH_INSTRUMENT_PROBES__';
export const INSTRUMENT_PROBES_STORAGE_KEY = 'fredoHealthInstrumentProbes';
/** The `window`-visible probe-set counter written by `recordProbeSet`. */
export const PROBE_COUNT_WINDOW_KEY = '__FREDO_HEALTH_PROBE_COUNT__';

/** Narrow view of the test-injectable `window` keys (no global augmentation). */
interface FredoHealthTestWindow {
  __FREDO_HEALTH_FORCE_TELEMETRY_DOWN__?: unknown;
  __FREDO_HEALTH_INSTRUMENT_PROBES__?: unknown;
  __FREDO_HEALTH_PROBE_COUNT__?: number;
}

function testWindow(): FredoHealthTestWindow | null {
  return typeof window === 'undefined' ? null : (window as FredoHealthTestWindow);
}

/** A runtime seam flag is truthy for `true`, `'1'`, or `1`; anything else is off. */
function truthyFlag(value: unknown): boolean {
  return value === true || value === '1' || value === 1;
}

function storedFlag(key: string): boolean {
  try {
    return window.sessionStorage?.getItem(key) === '1';
  } catch {
    return false;
  }
}

/**
 * Resolve the test-only forced-telemetry-down signal (FS-1). Either the Vite
 * flag or a runtime key (window / sessionStorage) forces the telemetry line
 * `down`. Inert when unset. Read on the bounded tick so a mid-session toggle
 * re-derives on the next poll.
 */
export function resolveForceTelemetryDown(): boolean {
  if (import.meta.env.VITE_FREDO_HEALTH_FORCE_TELEMETRY_DOWN === '1') return true;
  const w = testWindow();
  if (w && truthyFlag(w.__FREDO_HEALTH_FORCE_TELEMETRY_DOWN__)) return true;
  return storedFlag(FORCE_TELEMETRY_DOWN_STORAGE_KEY);
}

/** Whether the opt-in probe instrumentation flag is set (inert when unset). */
export function probesInstrumented(): boolean {
  const w = testWindow();
  if (w && truthyFlag(w.__FREDO_HEALTH_INSTRUMENT_PROBES__)) return true;
  return storedFlag(INSTRUMENT_PROBES_STORAGE_KEY);
}

/**
 * Increment the `window`-visible probe-set counter when instrumentation is on
 * (FS-4). A tester reads `window.__FREDO_HEALTH_PROBE_COUNT__` over a
 * ≥2-interval window to assert ≤1 probe-set per interval and 0 on a re-render.
 * Writes nothing and leaves the counter absent when the flag is unset.
 */
export function recordProbeSet(): void {
  if (!probesInstrumented()) return;
  const w = testWindow();
  if (!w) return;
  w.__FREDO_HEALTH_PROBE_COUNT__ = (w.__FREDO_HEALTH_PROBE_COUNT__ ?? 0) + 1;
}

/** The resolved raw probes (a `null` field = unresolved/unavailable → neutral `unknown`). */
interface HealthProbeState {
  companion: FredoCompanionSnapshot | null;
  llamaServer: FredoLlamaServerSnapshot | null;
  postgres: { state: FredoPgState } | null;
  /** FS-1 test-only seam: when true the telemetry line is forced `down`. */
  forceTelemetryDown: boolean;
}

const EMPTY_PROBE_STATE: HealthProbeState = {
  companion: null,
  llamaServer: null,
  postgres: null,
  forceTelemetryDown: false,
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
  const { health } = useStreamHealth();
  const [probeState, setProbeState] = useState<HealthProbeState>(EMPTY_PROBE_STATE);
  // Monotonic request sequence — a response whose seq is no longer current is
  // a stale/out-of-order probe and is dropped.
  const seqRef = useRef(0);

  /** One probe tick: at most three read-only IPCs, applied only if still current. */
  const runProbes = useCallback(async () => {
    const seq = ++seqRef.current;
    // FS-1 / FS-4 test-only seams, read on each bounded tick (both inert when
    // unset): force telemetry `down` and count the probe-set for live measurement.
    const forceTelemetryDown = resolveForceTelemetryDown();
    recordProbeSet();
    const [companionRaw, llamaRaw, pgRaw] = await Promise.all([
      adapterBridge.invoke<unknown>('check_companion_readiness'),
      adapterBridge.invoke<unknown>('get_llama_server_status'),
      adapterBridge.invoke<unknown>('pg_supervisor_status'),
    ]);
    if (seq !== seqRef.current) return; // superseded by a newer probe/event
    setProbeState({
      forceTelemetryDown,
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
      // FS-1: the seam forces the telemetry line `down`; otherwise the
      // event-driven three-valued stream health is used unchanged.
      telemetry: probeState.forceTelemetryDown ? 'down' : health,
      companion: probeState.companion,
      llamaServer: probeState.llamaServer,
      postgres: probeState.postgres,
    }),
    [health, probeState],
  );

  return useMemo<FredoHealth>(() => {
    const subsystems = deriveSubsystemLines(snapshots);
    return { overall: aggregateFredoHealth(subsystems), subsystems };
  }, [snapshots]);
}
