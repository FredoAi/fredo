/**
 * useCompanionReadiness — #2876 ST-5 optional `sttModel` composition.
 *
 * Proves, without a Tauri host:
 *   1. `stt_check_model` is probed and the OPTIONAL `sttModel` step is composed
 *      LAST, but NEVER contributes to `CompanionReadiness.ready` — the voice model
 *      can be missing while companion chat is ready;
 *   2. an unavailable probe leaves `sttModel` null and the prerequisite set
 *      unchanged (no fabricated model state);
 *   3. `download_stt_model` reuses the shared streamed-download path and flips
 *      `sttModel` ready from the authoritative result, still without gating chat.
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
  LlamaServerStatus,
  ModelFileId,
  ModelFileStatus,
  ModelFileState,
  SttModelStatus,
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

function healthyServer(): LlamaServerStatus {
  return {
    running: true,
    healthy: true,
    port: 8080,
    pid: 1,
    configPath: 'C:\\data\\companion\\llama-server-launch.bat',
    logPath: 'C:\\data\\companion\\llama-server.log',
    lastError: null,
  };
}

const STT_IDS = ['sttTokens', 'sttEncoder', 'sttDecoder', 'sttJoiner'] as const;

function sttFile(id: ModelFileId, state: ModelFileState): ModelFileStatus {
  return {
    id,
    filename: `${id}.bin`,
    relativePath: `${id}.bin`,
    state,
    downloadedBytes: state === 'present' ? 10 : 0,
    expectedBytes: 10,
    detail: null,
    path: state === 'present' ? `C:\\models\\${id}` : null,
  };
}

const sttPartial: SttModelStatus = {
  ready: false,
  files: [
    sttFile('sttTokens', 'present'),
    sttFile('sttEncoder', 'missing'),
    sttFile('sttDecoder', 'missing'),
    sttFile('sttJoiner', 'missing'),
  ],
};

const sttReady: SttModelStatus = {
  ready: true,
  files: STT_IDS.map((id) => sttFile(id, 'present')),
};

beforeEach(() => {
  resetCompanionAutoLaunchGuard();
  localStorage.clear();
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

describe('useCompanionReadiness sttModel composition (#2876 ST-5)', () => {
  it('composes the optional step last without ever gating readiness', async () => {
    adapterBridge.setInvoke(async (command: string) => {
      if (command === 'check_companion_readiness') return bothInstalled;
      if (command === 'get_llama_server_status') return healthyServer();
      if (command === 'stt_check_model') return sttPartial;
      return undefined;
    });
    adapterBridge.setListen(async () => () => {});

    const { result } = renderHook(() => useCompanionReadiness());

    await waitFor(() => expect(result.current.sttModel).not.toBeNull());
    await waitFor(() => expect(result.current.readiness?.ready).toBe(true));

    expect(result.current.readiness?.prerequisites.map((p) => p.id)).toEqual([
      'llamaServer',
      'modelFiles',
      'serverLaunch',
      'sttModel',
    ]);
    // STT files are missing, yet companion chat is ready — STT is never a gate.
    expect(result.current.sttModel?.ready).toBe(false);
    expect(
      result.current.readiness?.prerequisites.find((p) => p.id === 'sttModel')?.state,
    ).toBe('missing');
  });

  it('leaves sttModel null and the prerequisite set unchanged when the probe is unavailable', async () => {
    adapterBridge.setInvoke(async (command: string) => {
      if (command === 'check_companion_readiness') return bothInstalled;
      if (command === 'get_llama_server_status') return healthyServer();
      return undefined; // stt_check_model unavailable
    });
    adapterBridge.setListen(async () => () => {});

    const { result } = renderHook(() => useCompanionReadiness());
    await waitFor(() => expect(result.current.readiness?.ready).toBe(true));

    expect(result.current.sttModel).toBeNull();
    expect(result.current.readiness?.prerequisites.map((p) => p.id)).toEqual([
      'llamaServer',
      'modelFiles',
      'serverLaunch',
    ]);
  });

  it('downloads the voice model on demand and flips sttModel ready without touching the gate', async () => {
    let current = sttPartial;
    const invoke = vi.fn(async (command: string) => {
      if (command === 'check_companion_readiness') return bothInstalled;
      if (command === 'get_llama_server_status') return healthyServer();
      if (command === 'stt_check_model') return current;
      if (command === 'download_stt_model') {
        current = sttReady;
        return { success: true, files: sttReady.files };
      }
      return undefined;
    });
    adapterBridge.setInvoke(invoke);
    adapterBridge.setListen(async () => () => {});

    const { result } = renderHook(() => useCompanionReadiness());
    await waitFor(() => expect(result.current.sttModel).not.toBeNull());

    await act(async () => {
      await result.current.runAction('sttModel');
    });

    await waitFor(() => expect(result.current.sttModel?.ready).toBe(true));
    expect(invoke).toHaveBeenCalledWith('download_stt_model', undefined);
    expect(result.current.readiness?.ready).toBe(true);
    expect(result.current.actionError.sttModel).toBeUndefined();
  });

  it('surfaces a curated (never raw) sentence when the voice-model download fails', async () => {
    adapterBridge.setInvoke(async (command: string) => {
      if (command === 'check_companion_readiness') return bothInstalled;
      if (command === 'get_llama_server_status') return healthyServer();
      if (command === 'stt_check_model') return sttPartial;
      if (command === 'download_stt_model') {
        return { success: false, error: 'network connection reset', files: [] };
      }
      return undefined;
    });
    adapterBridge.setListen(async () => () => {});

    const { result } = renderHook(() => useCompanionReadiness());
    await waitFor(() => expect(result.current.sttModel).not.toBeNull());

    await act(async () => {
      await result.current.runAction('sttModel');
    });

    expect(result.current.actionError.sttModel).toMatch(/download lost its connection/i);
    // The failure never drops the companion-chat gate.
    expect(result.current.readiness?.ready).toBe(true);
  });
});
