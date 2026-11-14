/**
 * useCompanionReadiness — the `serverLaunch` lifecycle composition (#2857;
 * in-process engine since #3141 ST-6).
 *
 * Proves, without a Tauri host:
 *   1. `serverLaunch` is composed from `get_llama_server_status` while the backend
 *      readiness command reports the model files as its ONLY prerequisite, and it
 *      auto-starts exactly ONCE, flipping to `healthy` with NO reload;
 *   2. after a start FAILURE the card stays `failed` and a Re-check never
 *      re-triggers the auto-start (the module-scoped one-shot guard — no restart
 *      loop, which with `gpu` on a GPU-less machine would spin);
 *   3. no auto-start while the model files are not installed;
 *   4. a status command that is unavailable degrades to the backend's own
 *      prerequisite set (no fabricated health);
 *   5. the engine status push event re-probes and drops the overall gate.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act, cleanup } from '@testing-library/react';

import { adapterBridge } from '@/shared/utils/adapterBridge';
import {
  useCompanionReadiness,
  resetCompanionAutoLaunchGuard,
} from '@/shared/components/companion/useCompanionReadiness';
import type {
  CompanionEngineStartResult,
  CompanionReadiness,
  LlamaServerStatus,
} from '@/shared/components/companion/companionReadiness';

const modelFilesInstalled: CompanionReadiness = {
  ready: true,
  prerequisites: [
    {
      id: 'modelFiles',
      state: 'installed',
      detail: 'All required model files present.',
      resolvedPath: 'C:\\models',
    },
  ],
};

const notReady: CompanionReadiness = {
  ready: false,
  prerequisites: [
    { id: 'modelFiles', state: 'missing', detail: '0 of 3 present', resolvedPath: null },
  ],
};

function status(overrides: Partial<LlamaServerStatus> = {}): LlamaServerStatus {
  return {
    running: false,
    healthy: false,
    port: null,
    pid: null,
    configPath: '',
    logPath: '',
    lastError: null,
    backendMode: 'auto',
    devices: [],
    ...overrides,
  };
}

function started(overrides: Partial<CompanionEngineStartResult> = {}): CompanionEngineStartResult {
  return {
    success: true,
    code: null,
    detail: 'engine ready',
    backend: 'cpu',
    devices: [],
    ...overrides,
  };
}

beforeEach(() => {
  resetCompanionAutoLaunchGuard();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  adapterBridge.setInvoke(undefined as never);
  adapterBridge.setListen(undefined as never);
});

describe('useCompanionReadiness serverLaunch composition (#2857 / #3141)', () => {
  it('composes the lifecycle row and auto-starts once to healthy with no reload', async () => {
    let currentStatus = status();
    let launchCalls = 0;
    adapterBridge.setInvoke(async (command: string) => {
      if (command === 'check_companion_readiness') return modelFilesInstalled;
      if (command === 'get_llama_server_status') return currentStatus;
      if (command === 'launch_llama_server') {
        launchCalls += 1;
        currentStatus = status({ running: true, healthy: true, backend: 'cpu', modelId: 'gemma-4' });
        return started();
      }
      return undefined;
    });
    adapterBridge.setListen(async () => () => {});

    const { result } = renderHook(() => useCompanionReadiness());

    // The backend readiness command reports the model files ONLY; the lifecycle
    // row is composed in the frontend.
    await waitFor(() => expect(result.current.serverLaunch).not.toBeNull());
    expect(result.current.readiness?.prerequisites.map((p) => p.id)).toEqual([
      'modelFiles',
      'serverLaunch',
    ]);

    await waitFor(() => expect(result.current.serverLaunch?.state).toBe('healthy'));
    expect(launchCalls).toBe(1);
    expect(result.current.readiness?.ready).toBe(true);
    expect(result.current.serverLaunch?.backend).toBe('cpu');
    expect(result.current.serverLaunch?.modelId).toBe('gemma-4');
    const prereqs = result.current.readiness?.prerequisites ?? [];
    expect(prereqs[prereqs.length - 1]?.id).toBe('serverLaunch');
    expect(prereqs[prereqs.length - 1]?.state).toBe('installed');
  });

  it('auto-starts exactly once; a failure stays failed and Re-check never restarts it', async () => {
    let currentStatus = status();
    let launchCalls = 0;
    adapterBridge.setInvoke(async (command: string) => {
      if (command === 'check_companion_readiness') return modelFilesInstalled;
      if (command === 'get_llama_server_status') return currentStatus;
      if (command === 'launch_llama_server') {
        launchCalls += 1;
        currentStatus = status({
          lastError: 'no usable GPU',
          lastErrorCode: 'gpuUnavailable',
        });
        return started({
          success: false,
          code: 'gpuUnavailable',
          detail: 'no usable GPU',
          backend: null,
        });
      }
      return undefined;
    });
    adapterBridge.setListen(async () => () => {});

    const { result } = renderHook(() => useCompanionReadiness());

    await waitFor(() => expect(result.current.serverLaunch?.state).toBe('failed'));
    expect(launchCalls).toBe(1);
    expect(result.current.readiness?.ready).toBe(false);
    // The typed code drives the curated copy — never a raw string.
    expect(result.current.serverLaunch?.code).toBe('gpuUnavailable');
    expect(result.current.actionError.serverLaunch).toContain('no usable GPU');

    // Manual Re-check must NOT re-trigger the auto-start (module-scoped one-shot).
    await act(async () => {
      await result.current.refresh();
    });
    await waitFor(() => expect(result.current.checking).toBe(false));
    expect(launchCalls).toBe(1);
    expect(result.current.serverLaunch?.state).toBe('failed');
  });

  it('does not auto-start while the model files are not installed', async () => {
    let launchCalls = 0;
    adapterBridge.setInvoke(async (command: string) => {
      if (command === 'check_companion_readiness') return notReady;
      if (command === 'get_llama_server_status') return status();
      if (command === 'launch_llama_server') {
        launchCalls += 1;
        return undefined;
      }
      return undefined;
    });
    adapterBridge.setListen(async () => () => {});

    const { result } = renderHook(() => useCompanionReadiness());
    await waitFor(() => expect(result.current.checking).toBe(false));
    await waitFor(() => expect(result.current.serverLaunch).not.toBeNull());

    expect(launchCalls).toBe(0);
    expect(result.current.readiness?.ready).toBe(false);
    expect(result.current.serverLaunch?.state).toBe('notRunning');
  });

  it('degrades to the backend prerequisite set when the status command is unavailable', async () => {
    adapterBridge.setInvoke(async (command: string) => {
      if (command === 'check_companion_readiness') return modelFilesInstalled;
      return undefined;
    });
    adapterBridge.setListen(async () => () => {});

    const { result } = renderHook(() => useCompanionReadiness());
    await waitFor(() => expect(result.current.checking).toBe(false));

    expect(result.current.serverLaunch).toBeNull();
    expect(result.current.readiness?.ready).toBe(true);
    expect(result.current.readiness?.prerequisites).toHaveLength(1);
  });

  it('flips to exited when the engine status push reports the engine stopped', async () => {
    let currentStatus = status({ running: true, healthy: true, backend: 'cpu' });
    let handler: ((payload: unknown) => void) | null = null;
    adapterBridge.setInvoke(async (command: string) => {
      if (command === 'check_companion_readiness') return modelFilesInstalled;
      if (command === 'get_llama_server_status') return currentStatus;
      return undefined;
    });
    adapterBridge.setListen(async (_event, h) => {
      handler = h as (payload: unknown) => void;
      return () => {
        handler = null;
      };
    });

    const { result } = renderHook(() => useCompanionReadiness());
    await waitFor(() => expect(result.current.serverLaunch?.state).toBe('healthy'));
    expect(result.current.readiness?.ready).toBe(true);

    currentStatus = status();
    act(() => {
      handler?.({ running: false, healthy: false, code: null });
    });

    await waitFor(() => expect(result.current.serverLaunch?.state).toBe('exited'));
    expect(result.current.readiness?.ready).toBe(false);
  });

  // ── ST-8: never ready while a start attempt is in flight ──────────────────

  it('reports `starting` and keeps the ready gate false while a start is in flight', async () => {
    let currentStatus = status();
    let resolveLaunch: ((value: CompanionEngineStartResult) => void) | null = null;
    adapterBridge.setInvoke(async (command: string) => {
      if (command === 'check_companion_readiness') return modelFilesInstalled;
      if (command === 'get_llama_server_status') return currentStatus;
      if (command === 'launch_llama_server') {
        return new Promise<CompanionEngineStartResult>((resolve) => {
          resolveLaunch = resolve;
        });
      }
      return undefined;
    });
    adapterBridge.setListen(async () => () => {});

    const { result } = renderHook(() => useCompanionReadiness());

    // The auto-start invoke is held open — the step MUST read `starting`, never
    // `installed`, and the overall gate MUST be false for the whole attempt.
    await waitFor(() => expect(result.current.serverLaunch?.state).toBe('starting'));
    expect(result.current.readiness?.ready).toBe(false);
    expect(
      result.current.readiness?.prerequisites.find((p) => p.id === 'serverLaunch')
        ?.state,
    ).not.toBe('installed');

    // A still-loading engine never becomes prematurely healthy.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    expect(result.current.serverLaunch?.state).toBe('starting');
    expect(result.current.readiness?.ready).toBe(false);

    // The backend verdict flips it healthy → gate true with no reload.
    currentStatus = status({ running: true, healthy: true, backend: 'cpu' });
    await act(async () => {
      resolveLaunch?.(started());
    });
    await waitFor(() => expect(result.current.serverLaunch?.state).toBe('healthy'));
    expect(result.current.readiness?.ready).toBe(true);
  });

  it('drops the ready gate while a readiness re-check is in flight', async () => {
    let currentStatus = status({ running: true, healthy: true, backend: 'cpu' });
    let holdReadiness = false;
    let pendingReadiness: ((value: CompanionReadiness) => void) | null = null;
    adapterBridge.setInvoke(async (command: string) => {
      if (command === 'check_companion_readiness') {
        if (holdReadiness) {
          return new Promise<CompanionReadiness>((resolve) => {
            pendingReadiness = resolve;
          });
        }
        return modelFilesInstalled;
      }
      if (command === 'get_llama_server_status') return currentStatus;
      return undefined;
    });
    adapterBridge.setListen(async () => () => {});

    const { result } = renderHook(() => useCompanionReadiness());
    await waitFor(() => expect(result.current.readiness?.ready).toBe(true));

    // Re-check with the backend probe held open: `checking` is true and the gate
    // MUST drop rather than serving stale readiness.
    holdReadiness = true;
    let recheck: Promise<void> = Promise.resolve();
    await act(async () => {
      recheck = result.current.refresh();
    });
    expect(result.current.checking).toBe(true);
    expect(result.current.readiness?.ready).toBe(false);

    // Settle the in-flight probe → the gate recovers with no reload.
    await act(async () => {
      pendingReadiness?.(modelFilesInstalled);
      await recheck;
    });
    await waitFor(() => expect(result.current.checking).toBe(false));
    expect(result.current.readiness?.ready).toBe(true);
  });

  // ── The MODULE-SCOPED one-shot guard must survive a remount (AGENTS.md) ───

  it('preserves the module-scoped auto-start guard across a wizard remount', async () => {
    let launchCalls = 0;
    let currentStatus = status();
    adapterBridge.setInvoke(async (command: string) => {
      if (command === 'check_companion_readiness') return modelFilesInstalled;
      if (command === 'get_llama_server_status') return currentStatus;
      if (command === 'launch_llama_server') {
        launchCalls += 1;
        currentStatus = status({
          lastError: 'no usable GPU',
          lastErrorCode: 'gpuUnavailable',
        });
        return started({ success: false, code: 'gpuUnavailable', detail: 'no usable GPU' });
      }
      return undefined;
    });
    adapterBridge.setListen(async () => () => {});

    const first = renderHook(() => useCompanionReadiness());
    await waitFor(() => expect(first.result.current.serverLaunch?.state).toBe('failed'));
    expect(launchCalls).toBe(1);

    // Close and reopen the settings pane: a fresh hook mount MUST NOT re-attempt
    // the failed start (a `useRef` replacement would, and would spin with `gpu`
    // on a GPU-less machine).
    first.unmount();
    const second = renderHook(() => useCompanionReadiness());
    await waitFor(() => expect(second.result.current.checking).toBe(false));
    await waitFor(() => expect(second.result.current.serverLaunch).not.toBeNull());
    expect(launchCalls).toBe(1);
  });
});
