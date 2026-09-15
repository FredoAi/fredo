/**
 * useCompanionReadiness — #2876 ST-5 optional `sttModel` composition + #2877
 * ST-2 voice-preference/readiness contract.
 *
 * Proves, without a Tauri host:
 *   1. `stt_check_model` is probed and the OPTIONAL `sttModel` step is composed
 *      LAST, but NEVER contributes to `CompanionReadiness.ready` — the voice model
 *      can be missing while companion chat is ready;
 *   2. an unavailable probe leaves `sttModel` null and the prerequisite set
 *      unchanged (no fabricated model state);
 *   3. `download_stt_model` reuses the shared streamed-download path and flips
 *      `sttModel` ready from the authoritative result, still without gating chat;
 *   4. (#2877 ST-2) the resolved model `location` is derived from the per-file
 *      `path`s on ready AND on a partial/error set (AC2), and the device probe
 *      (`stt_list_devices`) derives checking/devices/no-device/vanished +
 *      permission-denied, failing closed when the backend is absent.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act, cleanup } from '@testing-library/react';

import { adapterBridge } from '@/shared/utils/adapterBridge';
import {
  useCompanionReadiness,
  resetCompanionAutoLaunchGuard,
} from '@/shared/components/companion/useCompanionReadiness';
import {
  deriveSttDeviceProbe,
  resolveSttModelDir,
} from '@/shared/components/companion/companionReadiness';
import type {
  CompanionReadiness,
  LlamaServerStatus,
  ModelFileId,
  ModelFileStatus,
  ModelFileState,
  SttDeviceInfo,
  SttDevicesResult,
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

// ── #2877 ST-2 — resolved model location (AC2) ───────────────────────────────

describe('useCompanionReadiness sttModel location (#2877 ST-2)', () => {
  const baseInvoke = (stt: SttModelStatus) => async (command: string) => {
    if (command === 'check_companion_readiness') return bothInstalled;
    if (command === 'get_llama_server_status') return healthyServer();
    if (command === 'stt_check_model') return stt;
    return undefined;
  };

  it('derives the resolved directory on a partial/error set and never gates chat', async () => {
    const partialWithError: SttModelStatus = {
      ready: false,
      files: [
        {
          ...sttFile('sttTokens', 'present'),
          path: 'C:\\fredo\\models\\sherpa\\tokens.txt',
        },
        {
          ...sttFile('sttEncoder', 'error'),
          detail: 'SHA-256 mismatch — choose Retry.',
          path: 'C:\\fredo\\models\\sherpa\\encoder.onnx',
        },
        sttFile('sttDecoder', 'missing'),
        sttFile('sttJoiner', 'missing'),
      ],
    };
    adapterBridge.setInvoke(baseInvoke(partialWithError));
    adapterBridge.setListen(async () => () => {});

    const { result } = renderHook(() => useCompanionReadiness());
    await waitFor(() => expect(result.current.sttModel).not.toBeNull());

    expect(result.current.sttModel?.ready).toBe(false);
    expect(result.current.sttModel?.location).toBe('C:\\fredo\\models\\sherpa');
    // AC2 — the location is on the readiness report too (error/missing branch).
    expect(
      result.current.readiness?.prerequisites.find((p) => p.id === 'sttModel')?.resolvedPath,
    ).toBe('C:\\fredo\\models\\sherpa');
    // The optional step still never gates companion chat.
    expect(result.current.readiness?.ready).toBe(true);
  });

  it('derives the resolved directory once every pinned file is ready', async () => {
    adapterBridge.setInvoke(
      baseInvoke({
        ready: true,
        files: STT_IDS.map((id) => ({
          ...sttFile(id, 'present'),
          path: `C:\\fredo\\models\\sherpa\\${id}.onnx`,
        })),
      }),
    );
    adapterBridge.setListen(async () => () => {});

    const { result } = renderHook(() => useCompanionReadiness());
    await waitFor(() => expect(result.current.sttModel?.ready).toBe(true));

    expect(result.current.sttModel?.location).toBe('C:\\fredo\\models\\sherpa');
  });

  it('leaves the location null while nothing is materialized (never fabricated)', async () => {
    adapterBridge.setInvoke(
      baseInvoke({ ready: false, files: STT_IDS.map((id) => sttFile(id, 'missing')) }),
    );
    adapterBridge.setListen(async () => () => {});

    const { result } = renderHook(() => useCompanionReadiness());
    await waitFor(() => expect(result.current.sttModel).not.toBeNull());

    expect(result.current.sttModel?.location).toBeNull();
    expect(
      result.current.readiness?.prerequisites.find((p) => p.id === 'sttModel')?.resolvedPath,
    ).toBeNull();
  });
});

// ── #2877 ST-2 — input-device probe (`stt_list_devices`) ─────────────────────

const DEVICES: SttDeviceInfo[] = [
  { id: 'Microphone (Realtek)', name: 'Microphone (Realtek)', isDefault: true },
  { id: 'Iriun Webcam', name: 'Iriun Webcam', isDefault: false },
];

describe('useCompanionReadiness sttDevices probe (#2877 ST-2)', () => {
  const withDevices = (
    list: SttDevicesResult | undefined,
    spy?: (command: string) => void,
  ) => async (command: string) => {
    spy?.(command);
    if (command === 'check_companion_readiness') return bothInstalled;
    if (command === 'get_llama_server_status') return healthyServer();
    if (command === 'stt_list_devices') return list;
    return undefined;
  };

  it('exposes the enumerated devices with the system default selected', async () => {
    adapterBridge.setInvoke(withDevices({ devices: DEVICES, selectedId: null, code: null }));
    adapterBridge.setListen(async () => () => {});

    const { result } = renderHook(() => useCompanionReadiness());
    await waitFor(() => expect(result.current.sttDevices.state).toBe('devices'));

    expect(result.current.sttDevices.devices).toHaveLength(2);
    expect(result.current.sttDevices.selectedId).toBeNull();
    // The device probe never gates companion chat.
    expect(result.current.readiness?.ready).toBe(true);
  });

  it('reports a persisted selection that is no longer enumerated as vanished', async () => {
    adapterBridge.setInvoke(
      withDevices({ devices: DEVICES, selectedId: 'Unplugged Yeti', code: null }),
    );
    adapterBridge.setListen(async () => () => {});

    const { result } = renderHook(() => useCompanionReadiness());
    await waitFor(() => expect(result.current.sttDevices.state).toBe('vanished'));

    expect(result.current.sttDevices.selectedId).toBe('Unplugged Yeti');
  });

  it('reports no-device for an empty enumeration', async () => {
    adapterBridge.setInvoke(withDevices({ devices: [], selectedId: null, code: null }));
    adapterBridge.setListen(async () => () => {});

    const { result } = renderHook(() => useCompanionReadiness());
    await waitFor(() => expect(result.current.sttDevices.state).toBe('no-device'));
  });

  it('reports permissionDenied when the backend denies microphone access', async () => {
    adapterBridge.setInvoke(
      withDevices({ devices: [], selectedId: null, code: 'permissionDenied' }),
    );
    adapterBridge.setListen(async () => () => {});

    const { result } = renderHook(() => useCompanionReadiness());
    await waitFor(() => expect(result.current.sttDevices.state).toBe('permissionDenied'));
  });

  it('fails closed (unavailable) when the command is absent — never no-device', async () => {
    adapterBridge.setInvoke(withDevices(undefined));
    adapterBridge.setListen(async () => () => {});

    const { result } = renderHook(() => useCompanionReadiness());
    await waitFor(() => expect(result.current.sttDevices.state).toBe('unavailable'));

    expect(result.current.sttDevices.devices).toEqual([]);
  });

  it('re-scans just the device probe via refreshSttDevices', async () => {
    let current: SttDevicesResult = { devices: [], selectedId: null, code: null };
    adapterBridge.setInvoke(async (command: string) => {
      if (command === 'check_companion_readiness') return bothInstalled;
      if (command === 'get_llama_server_status') return healthyServer();
      if (command === 'stt_list_devices') return current;
      return undefined;
    });
    adapterBridge.setListen(async () => () => {});

    const { result } = renderHook(() => useCompanionReadiness());
    await waitFor(() => expect(result.current.sttDevices.state).toBe('no-device'));

    current = { devices: DEVICES, selectedId: null, code: null };
    await act(async () => {
      await result.current.refreshSttDevices();
    });

    await waitFor(() => expect(result.current.sttDevices.state).toBe('devices'));
    expect(result.current.sttDevices.devices).toHaveLength(2);
  });
});

// ── #2877 ST-2 — pure derivation helpers ─────────────────────────────────────

describe('deriveSttDeviceProbe / resolveSttModelDir (#2877 ST-2)', () => {
  it('checks the in-flight state first', () => {
    expect(
      deriveSttDeviceProbe({ checking: true, result: { devices: DEVICES, selectedId: null, code: null } })
        .state,
    ).toBe('checking');
  });

  it('fails closed on a null result', () => {
    expect(deriveSttDeviceProbe({ checking: false, result: null }).state).toBe('unavailable');
  });

  it('normalizes a blank/whitespace selection to the system default', () => {
    expect(
      deriveSttDeviceProbe({
        checking: false,
        result: { devices: DEVICES, selectedId: '   ', code: null },
      }).selectedId,
    ).toBeNull();
  });

  it('derives the model dir from the first materialized file, else null', () => {
    expect(
      resolveSttModelDir([
        sttFile('sttTokens', 'missing'),
        { ...sttFile('sttEncoder', 'present'), path: 'C:\\models\\sherpa\\encoder.onnx' },
      ]),
    ).toBe('C:\\models\\sherpa');
    expect(resolveSttModelDir([sttFile('sttTokens', 'missing')])).toBeNull();
  });
});
