/**
 * useCompanionReadiness — the input-device probe (#2877 ST-2) plus the #2914
 * ST-4 pin that the wizard's OPTIONAL `sttModel` prerequisite/step is GONE.
 *
 * Spec #2914 removed the on-device STT model, so this hook:
 *   1. composes ONLY the GGUF + server prerequisites — there is no `sttModel`
 *      entry, and `CompanionReadiness.ready` is unchanged (the ST-4 absence pin);
 *   2. never invokes `stt_check_model` / `download_stt_model`;
 *   3. still exposes the fail-closed input-device probe (`stt_list_devices`) —
 *      `checking` / `devices` / `vanished` / `no-device` / `permissionDenied` /
 *      `unavailable` — plus its pure derivation helper.
 *
 * (Renamed scope note: this file was the #2876 ST-5 `sttModel` composition suite;
 * #2914 ST-4 replaced that composition with the absence pin below and kept the
 * device-probe coverage verbatim.)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act, cleanup } from '@testing-library/react';

import { adapterBridge } from '@/shared/utils/adapterBridge';
import {
  useCompanionReadiness,
  resetCompanionAutoLaunchGuard,
} from '@/shared/components/companion/useCompanionReadiness';
import { deriveSttDeviceProbe } from '@/shared/components/companion/companionReadiness';
import type {
  CompanionReadiness,
  LlamaServerStatus,
  SttDeviceInfo,
  SttDevicesResult,
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

// ── #2914 ST-4 — the `sttModel` prerequisite/step is ABSENT ──────────────────

describe('useCompanionReadiness — no sttModel prerequisite (#2914 ST-4)', () => {
  it('composes only the GGUF + server prerequisites and never probes the removed STT model', async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === 'check_companion_readiness') return bothInstalled;
      if (command === 'get_llama_server_status') return healthyServer();
      return undefined;
    });
    adapterBridge.setInvoke(invoke);
    adapterBridge.setListen(async () => () => {});

    const { result } = renderHook(() => useCompanionReadiness());
    await waitFor(() => expect(result.current.readiness?.ready).toBe(true));

    // The gate is unchanged: the GGUF + server inputs only.
    expect(result.current.readiness?.ready).toBe(true);
    expect(result.current.readiness?.prerequisites.map((p) => p.id)).toEqual([
      'llamaServer',
      'modelFiles',
      'serverLaunch',
    ]);
    // There is NO `sttModel` prerequisite in the composed set.
    expect(result.current.readiness?.prerequisites.some((p) => p.id === 'sttModel')).toBe(false);
    // ...and the removed STT-model commands are never invoked.
    const commands = invoke.mock.calls.map((call) => call[0]);
    expect(commands).not.toContain('stt_check_model');
    expect(commands).not.toContain('download_stt_model');
  });

  it('does not expose an sttModel report on the hook result', async () => {
    adapterBridge.setInvoke(async (command: string) => {
      if (command === 'check_companion_readiness') return bothInstalled;
      if (command === 'get_llama_server_status') return healthyServer();
      return undefined;
    });
    adapterBridge.setListen(async () => () => {});

    const { result } = renderHook(() => useCompanionReadiness());
    await waitFor(() => expect(result.current.readiness?.ready).toBe(true));

    expect(Object.prototype.hasOwnProperty.call(result.current, 'sttModel')).toBe(false);
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

// ── #2877 ST-2 — pure derivation helper ──────────────────────────────────────

describe('deriveSttDeviceProbe (#2877 ST-2)', () => {
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
});
