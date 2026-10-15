/**
 * useFredoHealth — aggregator unit pins (Spec #3052 ST-2).
 *
 * Proves, without a Tauri host:
 *   1. ONE bounded interval at `HEALTH_POLL_INTERVAL_MS`; ≤3 read-only IPCs per tick;
 *   2. NO IPC on a re-render (no per-render polling);
 *   3. the monotonic seq guard drops a stale/out-of-order probe response;
 *   4. telemetry is event-driven (StreamContext), never polled;
 *   5. the `llama-server-status` push event applies immediately (no IPC).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

import { adapterBridge } from '@/shared/utils/adapterBridge';
import { useFredoHealth, HEALTH_POLL_INTERVAL_MS } from '@/shared/hooks/useFredoHealth';
import type { FredoHealth, FredoSubsystemId, SubsystemHealth } from '@/shared/hooks/fredoHealth';
import type { StreamHealth } from '@/shared/hooks/streamHealth';

const stream = vi.hoisted(() => ({ health: 'healthy' as StreamHealth }));

vi.mock('@/shared/contexts/StreamContext', () => ({
  useStreamHealth: () => ({ health: stream.health, isConnected: stream.health === 'healthy' }),
}));

const COMPANION_READY = {
  ready: true,
  prerequisites: [
    { id: 'llamaServer', state: 'installed', detail: 'ok', resolvedPath: 'x' },
    { id: 'modelFiles', state: 'installed', detail: 'ok', resolvedPath: 'y' },
  ],
};

const COMPANION_STALE = {
  ready: false,
  prerequisites: [
    { id: 'llamaServer', state: 'missing', detail: 'no', resolvedPath: null },
    { id: 'modelFiles', state: 'missing', detail: 'no', resolvedPath: null },
  ],
};

const LLAMA_OK = { running: true, healthy: true, port: 8080, pid: 1, configPath: '', logPath: '', lastError: null };

function stateOf(health: FredoHealth, id: FredoSubsystemId): SubsystemHealth {
  const line = health.subsystems.find((l) => l.id === id);
  if (!line) throw new Error(`missing ${id}`);
  return line.state;
}

/** The test-injectable `window` keys the FS-1 / FS-4 seams read and write. */
type HealthTestWindow = Window & {
  __FREDO_HEALTH_FORCE_TELEMETRY_DOWN__?: unknown;
  __FREDO_HEALTH_INSTRUMENT_PROBES__?: unknown;
  __FREDO_HEALTH_PROBE_COUNT__?: number;
};

function testWindow(): HealthTestWindow {
  return window as HealthTestWindow;
}

function probeCount(): number | undefined {
  return testWindow().__FREDO_HEALTH_PROBE_COUNT__;
}

/** Remove every test-only seam signal so each test starts inert. */
function clearSeams(): void {
  const w = testWindow();
  delete w.__FREDO_HEALTH_FORCE_TELEMETRY_DOWN__;
  delete w.__FREDO_HEALTH_INSTRUMENT_PROBES__;
  delete w.__FREDO_HEALTH_PROBE_COUNT__;
  window.sessionStorage.clear();
  vi.unstubAllEnvs();
}

/** An invoke mock answering the three read-only health commands. */
function makeInvoke(
  overrides: Partial<Record<string, () => Promise<unknown> | unknown>> = {},
) {
  return vi.fn((command: string) => {
    const override = overrides[command];
    if (override) return Promise.resolve(override());
    if (command === 'check_companion_readiness') return Promise.resolve(COMPANION_READY);
    if (command === 'get_llama_server_status') return Promise.resolve(LLAMA_OK);
    if (command === 'pg_supervisor_status') return Promise.resolve({ state: 'ready' });
    return Promise.resolve(undefined);
  });
}

beforeEach(() => {
  stream.health = 'healthy';
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  clearSeams();
  adapterBridge.setInvoke(undefined as never);
  adapterBridge.setListen(undefined as never);
});

describe('useFredoHealth — bounded polling', () => {
  it('issues exactly 3 read-only IPCs on the first tick and on each interval', async () => {
    const invoke = makeInvoke();
    adapterBridge.setInvoke(invoke);
    adapterBridge.setListen(async () => () => {});

    const { result } = renderHook(() => useFredoHealth());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // Tick 1: exactly the three read-only commands.
    expect(invoke.mock.calls.map((c) => c[0]).sort()).toEqual([
      'check_companion_readiness',
      'get_llama_server_status',
      'pg_supervisor_status',
    ]);
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(result.current.overall).toBe('healthy');
    expect(result.current.subsystems.map((l) => l.id)).toEqual([
      'telemetry',
      'llamaServer',
      'companionModel',
      'postgres',
    ]);

    // Just short of the interval → still no second tick.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HEALTH_POLL_INTERVAL_MS - 1);
    });
    expect(invoke).toHaveBeenCalledTimes(3);

    // Crossing the interval → exactly one more tick (3 more IPCs).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(invoke).toHaveBeenCalledTimes(6);
  });

  it('issues NO IPC on a re-render', async () => {
    const invoke = makeInvoke();
    adapterBridge.setInvoke(invoke);
    adapterBridge.setListen(async () => () => {});

    const { rerender } = renderHook(() => useFredoHealth());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(invoke).toHaveBeenCalledTimes(3);

    rerender();
    rerender();
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it('reads telemetry from StreamContext (event-driven) and never polls it', async () => {
    const invoke = makeInvoke();
    adapterBridge.setInvoke(invoke);
    adapterBridge.setListen(async () => () => {});

    stream.health = 'down';
    const { result, rerender } = renderHook(() => useFredoHealth());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(stateOf(result.current, 'telemetry')).toBe('down');
    expect(result.current.overall).toBe('down'); // telemetry is mandatory
    const callsBefore = invoke.mock.calls.length;

    // #3064: a `degraded` stream health maps 1:1 to the telemetry line.
    stream.health = 'degraded';
    rerender();
    expect(stateOf(result.current, 'telemetry')).toBe('degraded');
    expect(result.current.overall).toBe('degraded');
    expect(invoke.mock.calls.length).toBe(callsBefore); // no IPC for the flag flip

    stream.health = 'healthy';
    rerender();
    expect(stateOf(result.current, 'telemetry')).toBe('healthy');
    expect(result.current.overall).toBe('healthy');
    expect(invoke.mock.calls.length).toBe(callsBefore); // no IPC for the flag flip
  });
});

describe('useFredoHealth — seq guard', () => {
  it('drops a stale/out-of-order probe response', async () => {
    let companionCalls = 0;
    let resolveStale: ((value: unknown) => void) | null = null;
    const invoke = vi.fn((command: string) => {
      if (command === 'check_companion_readiness') {
        companionCalls += 1;
        if (companionCalls === 1) {
          // Hold tick 1's companion probe so it resolves AFTER tick 2.
          return new Promise((resolve) => {
            resolveStale = resolve;
          });
        }
        return Promise.resolve(COMPANION_READY);
      }
      if (command === 'get_llama_server_status') return Promise.resolve(LLAMA_OK);
      if (command === 'pg_supervisor_status') return Promise.resolve({ state: 'ready' });
      return Promise.resolve(undefined);
    });
    adapterBridge.setInvoke(invoke);
    adapterBridge.setListen(async () => () => {});

    const { result } = renderHook(() => useFredoHealth());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // Tick 2 (fresh companion) lands while tick 1 is still pending.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HEALTH_POLL_INTERVAL_MS);
    });
    expect(stateOf(result.current, 'companionModel')).toBe('healthy');
    expect(stateOf(result.current, 'llamaServer')).toBe('healthy');

    // Now the STALE tick-1 companion resolves — the seq guard must drop it.
    await act(async () => {
      resolveStale?.(COMPANION_STALE);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(stateOf(result.current, 'companionModel')).toBe('healthy');
    expect(stateOf(result.current, 'llamaServer')).toBe('healthy');
    expect(result.current.overall).toBe('healthy');
  });
});

describe('useFredoHealth — llama-server-status push event', () => {
  it('applies the pushed payload immediately with no IPC', async () => {
    let handler: ((payload: unknown) => void) | null = null;
    const invoke = makeInvoke();
    adapterBridge.setInvoke(invoke);
    adapterBridge.setListen(async (_event, h) => {
      handler = h as (payload: unknown) => void;
      return () => {
        handler = null;
      };
    });

    const { result } = renderHook(() => useFredoHealth());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(stateOf(result.current, 'llamaServer')).toBe('healthy');
    const callsBefore = invoke.mock.calls.length;

    act(() => {
      handler?.({ running: false, healthy: false, port: null, code: null });
    });

    expect(stateOf(result.current, 'llamaServer')).toBe('down');
    expect(result.current.overall).toBe('degraded'); // optional subsystem down
    expect(invoke.mock.calls.length).toBe(callsBefore); // no IPC per event
  });

  it('ignores a malformed event payload', async () => {
    let handler: ((payload: unknown) => void) | null = null;
    adapterBridge.setInvoke(makeInvoke());
    adapterBridge.setListen(async (_event, h) => {
      handler = h as (payload: unknown) => void;
      return () => {};
    });

    const { result } = renderHook(() => useFredoHealth());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(stateOf(result.current, 'llamaServer')).toBe('healthy');

    act(() => {
      handler?.({ running: 'yes', healthy: null });
    });
    expect(stateOf(result.current, 'llamaServer')).toBe('healthy');
  });
});

describe('useFredoHealth — FS-1 forced telemetry-down seam (test-only)', () => {
  async function mountAndSettle() {
    const { result, rerender } = renderHook(() => useFredoHealth());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    return { result, rerender };
  }

  it('is inert when no seam signal is set — telemetry stays healthy', async () => {
    stream.health = 'healthy';
    adapterBridge.setInvoke(makeInvoke());
    adapterBridge.setListen(async () => () => {});

    const { result } = await mountAndSettle();
    expect(stateOf(result.current, 'telemetry')).toBe('healthy');
    expect(result.current.overall).toBe('healthy');
  });

  it('forces telemetry down => overall down from the Vite flag (other lines unaffected)', async () => {
    vi.stubEnv('VITE_FREDO_HEALTH_FORCE_TELEMETRY_DOWN', '1');
    stream.health = 'healthy'; // the stream health itself is still healthy
    adapterBridge.setInvoke(makeInvoke());
    adapterBridge.setListen(async () => () => {});

    const { result } = await mountAndSettle();
    expect(stateOf(result.current, 'telemetry')).toBe('down');
    expect(result.current.overall).toBe('down'); // telemetry is mandatory
    expect(stateOf(result.current, 'llamaServer')).toBe('healthy');
    expect(stateOf(result.current, 'companionModel')).toBe('healthy');
    expect(stateOf(result.current, 'postgres')).toBe('healthy');
  });

  it('forces telemetry down from the runtime window key', async () => {
    testWindow().__FREDO_HEALTH_FORCE_TELEMETRY_DOWN__ = true;
    stream.health = 'healthy';
    adapterBridge.setInvoke(makeInvoke());
    adapterBridge.setListen(async () => () => {});

    const { result } = await mountAndSettle();
    expect(stateOf(result.current, 'telemetry')).toBe('down');
    expect(result.current.overall).toBe('down');
  });

  it('re-derives on a mid-session sessionStorage toggle at the next bounded tick', async () => {
    stream.health = 'healthy';
    adapterBridge.setInvoke(makeInvoke());
    adapterBridge.setListen(async () => () => {});

    const { result } = await mountAndSettle();
    expect(stateOf(result.current, 'telemetry')).toBe('healthy'); // inert so far

    act(() => {
      window.sessionStorage.setItem('fredoHealthForceTelemetryDown', '1');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HEALTH_POLL_INTERVAL_MS);
    });
    expect(stateOf(result.current, 'telemetry')).toBe('down');
    expect(result.current.overall).toBe('down');
  });
});

describe('useFredoHealth — FS-4 probe-set counter (test-only)', () => {
  it('leaves the window counter absent when instrumentation is unset', async () => {
    adapterBridge.setInvoke(makeInvoke());
    adapterBridge.setListen(async () => () => {});

    const { rerender } = renderHook(() => useFredoHealth());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    rerender();
    expect(probeCount()).toBeUndefined();
  });

  it('counts one probe-set per interval and zero on a re-render when instrumented', async () => {
    testWindow().__FREDO_HEALTH_INSTRUMENT_PROBES__ = true;
    const invoke = makeInvoke();
    adapterBridge.setInvoke(invoke);
    adapterBridge.setListen(async () => () => {});

    const { rerender } = renderHook(() => useFredoHealth());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(probeCount()).toBe(1); // exactly one probe-set on the first tick
    const callsAfterFirstTick = invoke.mock.calls.length;
    expect(callsAfterFirstTick).toBe(3);

    // A re-render issues NO probe-set and NO IPC.
    rerender();
    rerender();
    expect(probeCount()).toBe(1);
    expect(invoke.mock.calls.length).toBe(callsAfterFirstTick);

    // Crossing one interval => exactly one more probe-set.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HEALTH_POLL_INTERVAL_MS);
    });
    expect(probeCount()).toBe(2);

    // A second interval => one more (≤1 set per interval).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HEALTH_POLL_INTERVAL_MS);
    });
    expect(probeCount()).toBe(3);
  });
});
