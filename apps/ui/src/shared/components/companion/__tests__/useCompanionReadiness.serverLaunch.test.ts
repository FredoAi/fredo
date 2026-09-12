/**
 * useCompanionReadiness — #2857 `serverLaunch` composition.
 *
 * Proves, without a Tauri host:
 *   1. `serverLaunch` is composed from `get_llama_server_status` (the backend
 *      readiness command stays 2-prereq) and auto-launches exactly ONCE when the
 *      two provisioning steps are installed, flipping to `healthy` with NO reload;
 *   2. after a launch FAILURE the card stays `failed` and a Re-check never
 *      re-triggers the auto-launch (no restart loop — manual Retry only);
 *   3. no auto-launch while the provisioning steps are not installed;
 *   4. a status command that is unavailable degrades to the backend's own
 *      prerequisite set (no fabricated health);
 *   5. the backend `llama-server-status` exit event re-probes and flips the step
 *      to `exited`, dropping the overall gate.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act, cleanup } from '@testing-library/react';

import { adapterBridge } from '@/shared/utils/adapterBridge';
import {
  useCompanionReadiness,
  resetCompanionAutoLaunchGuard,
} from '@/shared/components/companion/useCompanionReadiness';
import type {
  CompanionReadiness,
  LlamaServerLaunchResult,
  LlamaServerStatus,
} from '@/shared/components/companion/companionReadiness';

const bothInstalled: CompanionReadiness = {
  ready: true,
  prerequisites: [
    {
      id: 'llamaServer',
      state: 'installed',
      detail: 'llama-server found.',
      resolvedPath: 'C:\\llama\\llama-server.exe',
    },
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
    { id: 'llamaServer', state: 'missing', detail: 'not found', resolvedPath: null },
    { id: 'modelFiles', state: 'missing', detail: '0 of 3 present', resolvedPath: null },
  ],
};

function status(overrides: Partial<LlamaServerStatus> = {}): LlamaServerStatus {
  return {
    running: false,
    healthy: false,
    port: null,
    pid: null,
    configPath: 'C:\\data\\companion\\llama-server-launch.bat',
    logPath: 'C:\\data\\companion\\llama-server.log',
    lastError: null,
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

describe('useCompanionReadiness serverLaunch composition (#2857)', () => {
  it('composes the third prerequisite and auto-launches once to healthy with no reload', async () => {
    let currentStatus = status();
    let launchCalls = 0;
    adapterBridge.setInvoke(async (command: string) => {
      if (command === 'check_companion_readiness') return bothInstalled;
      if (command === 'get_llama_server_status') return currentStatus;
      if (command === 'launch_llama_server') {
        launchCalls += 1;
        currentStatus = status({ running: true, healthy: true, port: 8080, pid: 4242 });
        const result: LlamaServerLaunchResult = {
          success: true,
          state: 'installed',
          detail: 'llama-server running on http://127.0.0.1:8080 (pid 4242).',
          port: 8080,
          configPath: currentStatus.configPath,
          error: null,
          code: null,
        };
        return result;
      }
      return undefined;
    });
    adapterBridge.setListen(async () => () => {});

    const { result } = renderHook(() => useCompanionReadiness());

    // The backend readiness command stays 2-prereq; the wizard's third row is
    // composed in the frontend.
    await waitFor(() => expect(result.current.serverLaunch).not.toBeNull());
    expect(result.current.readiness?.prerequisites.map((p) => p.id)).toEqual([
      'llamaServer',
      'modelFiles',
      'serverLaunch',
    ]);

    await waitFor(() => expect(result.current.serverLaunch?.state).toBe('healthy'));
    expect(launchCalls).toBe(1);
    expect(result.current.readiness?.ready).toBe(true);
    expect(result.current.serverLaunch?.port).toBe(8080);
    const prereqs = result.current.readiness?.prerequisites ?? [];
    expect(prereqs[prereqs.length - 1]?.id).toBe('serverLaunch');
    expect(prereqs[prereqs.length - 1]?.state).toBe('installed');
  });

  it('auto-launches exactly once; a failure stays failed and Re-check never restarts it', async () => {
    let currentStatus = status();
    let launchCalls = 0;
    adapterBridge.setInvoke(async (command: string) => {
      if (command === 'check_companion_readiness') return bothInstalled;
      if (command === 'get_llama_server_status') return currentStatus;
      if (command === 'launch_llama_server') {
        launchCalls += 1;
        currentStatus = status({ lastError: 'failed to start llama-server' });
        const result: LlamaServerLaunchResult = {
          success: false,
          state: 'error',
          detail: 'failed to start llama-server',
          port: 8080,
          configPath: currentStatus.configPath,
          error: 'failed to start llama-server',
          code: 'spawnFailed',
        };
        return result;
      }
      return undefined;
    });
    adapterBridge.setListen(async () => () => {});

    const { result } = renderHook(() => useCompanionReadiness());

    await waitFor(() => expect(result.current.serverLaunch?.state).toBe('failed'));
    expect(launchCalls).toBe(1);
    expect(result.current.readiness?.ready).toBe(false);
    expect(result.current.actionError.serverLaunch).toMatch(
      /Couldn't start the companion server/,
    );

    // Manual Re-check must NOT re-trigger the auto-launch (module-scoped one-shot).
    await act(async () => {
      await result.current.refresh();
    });
    await waitFor(() => expect(result.current.checking).toBe(false));
    expect(launchCalls).toBe(1);
    expect(result.current.serverLaunch?.state).toBe('failed');
  });

  it('does not auto-launch while the provisioning steps are not installed', async () => {
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
      if (command === 'check_companion_readiness') return bothInstalled;
      return undefined;
    });
    adapterBridge.setListen(async () => () => {});

    const { result } = renderHook(() => useCompanionReadiness());
    await waitFor(() => expect(result.current.checking).toBe(false));

    expect(result.current.serverLaunch).toBeNull();
    expect(result.current.readiness?.ready).toBe(true);
    expect(result.current.readiness?.prerequisites).toHaveLength(2);
  });

  it('flips to exited when the llama-server-status exit event fires', async () => {
    let currentStatus = status({ running: true, healthy: true, port: 8080, pid: 1 });
    let handler: ((payload: unknown) => void) | null = null;
    adapterBridge.setInvoke(async (command: string) => {
      if (command === 'check_companion_readiness') return bothInstalled;
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
      handler?.({ running: false, healthy: false, port: null, code: null });
    });

    await waitFor(() => expect(result.current.serverLaunch?.state).toBe('exited'));
    expect(result.current.readiness?.ready).toBe(false);
  });

  // ── ST-8: never ready while a launch/health attempt is in flight ───────────

  it('reports `starting` and keeps the ready gate false while a launch is in flight', async () => {
    let currentStatus = status();
    let resolveLaunch: ((value: LlamaServerLaunchResult) => void) | null = null;
    adapterBridge.setInvoke(async (command: string) => {
      if (command === 'check_companion_readiness') return bothInstalled;
      if (command === 'get_llama_server_status') return currentStatus;
      if (command === 'launch_llama_server') {
        return new Promise<LlamaServerLaunchResult>((resolve) => {
          resolveLaunch = resolve;
        });
      }
      return undefined;
    });
    adapterBridge.setListen(async () => () => {});

    const { result } = renderHook(() => useCompanionReadiness());

    // The auto-launch invoke is held open — the step MUST read `starting`, never
    // `installed`, and the overall gate MUST be false for the whole attempt.
    await waitFor(() => expect(result.current.serverLaunch?.state).toBe('starting'));
    expect(result.current.readiness?.ready).toBe(false);
    expect(
      result.current.readiness?.prerequisites.find((p) => p.id === 'serverLaunch')
        ?.state,
    ).not.toBe('installed');

    // A still-loading health check never becomes prematurely healthy.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    expect(result.current.serverLaunch?.state).toBe('starting');
    expect(result.current.readiness?.ready).toBe(false);
    expect(
      result.current.readiness?.prerequisites.find((p) => p.id === 'serverLaunch')
        ?.state,
    ).not.toBe('installed');

    // The backend verdict flips it healthy → gate true with no reload.
    currentStatus = status({ running: true, healthy: true, port: 8080, pid: 1 });
    await act(async () => {
      resolveLaunch?.({
        success: true,
        state: 'installed',
        detail: 'llama-server running on http://127.0.0.1:8080 (pid 1).',
        port: 8080,
        configPath: currentStatus.configPath,
        error: null,
        code: null,
      });
    });
    await waitFor(() => expect(result.current.serverLaunch?.state).toBe('healthy'));
    expect(result.current.readiness?.ready).toBe(true);
  });

  it('drops the ready gate while a readiness re-check is in flight', async () => {
    let currentStatus = status({ running: true, healthy: true, port: 8080, pid: 1 });
    let holdReadiness = false;
    let pendingReadiness: ((value: CompanionReadiness) => void) | null = null;
    adapterBridge.setInvoke(async (command: string) => {
      if (command === 'check_companion_readiness') {
        if (holdReadiness) {
          return new Promise<CompanionReadiness>((resolve) => {
            pendingReadiness = resolve;
          });
        }
        return bothInstalled;
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
      pendingReadiness?.(bothInstalled);
      await recheck;
    });
    await waitFor(() => expect(result.current.checking).toBe(false));
    expect(result.current.readiness?.ready).toBe(true);
  });
});
