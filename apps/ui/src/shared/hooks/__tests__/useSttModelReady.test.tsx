/**
 * useSttModelReady — Spec #2882 ST-3 unit pins (R-3.3, the arming gate for R-2.1).
 *
 * Covers: the probe runs while voice input is ENABLED (and only then), the
 * fail-closed contract (unknown / missing command / rejected invoke / malformed
 * result ⇒ `ready:false`), the re-probe on the enable 0→1 edge and via
 * `refresh()` (the summon path), the frozen readiness while disabled, the
 * single-flight/no-probe-storm cost bound, the unmount contract, and the
 * sanctioned-transport invariant (never a static `@tauri-apps/api` import).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock('../../utils/adapterBridge', () => ({
  adapterBridge: {
    invoke: invokeMock,
    listen: vi.fn(),
    llmChat: vi.fn(),
    llmChatWithImage: vi.fn(),
  },
}));

import { useSttModelReady } from '../useSttModelReady';

/** Flush the pending probe microtasks under `act`. */
const flush = async () => {
  await act(async () => {});
};

beforeEach(() => {
  invokeMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ── 1. Probe while enabled ──────────────────────────────────────────────────

describe('useSttModelReady — probe while enabled', () => {
  it('probes stt_check_model once and reports a ready model', async () => {
    invokeMock.mockResolvedValue({ ready: true, files: [{ id: 'sttTokens' }] });

    const { result } = renderHook(() => useSttModelReady(true));
    await flush();

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('stt_check_model');
    expect(result.current.ready).toBe(true);
  });

  it('reports ready:false for a probe that finds an incomplete model', async () => {
    invokeMock.mockResolvedValue({ ready: false, files: [] });

    const { result } = renderHook(() => useSttModelReady(true));
    await flush();

    expect(result.current.ready).toBe(false);
  });

  it('exposes a stable refresh function', () => {
    invokeMock.mockResolvedValue({ ready: true, files: [] });

    const { result, rerender } = renderHook(({ enabled }) => useSttModelReady(enabled), {
      initialProps: { enabled: true },
    });

    const first = result.current.refresh;
    rerender({ enabled: true });
    expect(result.current.refresh).toBe(first);
  });
});

// ── 2. Fail-closed ──────────────────────────────────────────────────────────

describe('useSttModelReady — fail-closed', () => {
  it('is not ready before the probe resolves', async () => {
    let resolveProbe: (value: unknown) => void = () => {};
    invokeMock.mockImplementation(
      () => new Promise((res) => (resolveProbe = res)),
    );

    const { result } = renderHook(() => useSttModelReady(true));
    expect(result.current.ready).toBe(false);

    await act(async () => {
      resolveProbe({ ready: true, files: [] });
    });
    expect(result.current.ready).toBe(true);
  });

  it('fails closed when the command is unavailable (invoke resolves undefined)', async () => {
    invokeMock.mockResolvedValue(undefined);

    const { result } = renderHook(() => useSttModelReady(true));
    await flush();

    expect(result.current.ready).toBe(false);
  });

  it('fails closed when the invoke rejects', async () => {
    invokeMock.mockRejectedValue(new Error('command stt_check_model not found'));

    const { result } = renderHook(() => useSttModelReady(true));
    await flush();

    expect(result.current.ready).toBe(false);
  });

  it('fails closed on a malformed result shape', async () => {
    invokeMock.mockResolvedValue({ ready: 'yes' });

    const { result } = renderHook(() => useSttModelReady(true));
    await flush();

    expect(result.current.ready).toBe(false);
  });

  it('recovers to ready:true on the next successful refresh', async () => {
    invokeMock.mockRejectedValueOnce(new Error('ipc unavailable'));
    const { result } = renderHook(() => useSttModelReady(true));
    await flush();
    expect(result.current.ready).toBe(false);

    invokeMock.mockResolvedValueOnce({ ready: true, files: [] });
    await act(async () => {
      result.current.refresh();
    });
    expect(result.current.ready).toBe(true);
  });
});

// ── 3. Disabled ⇒ no probe ──────────────────────────────────────────────────

describe('useSttModelReady — voice input disabled', () => {
  it('never probes while disabled', async () => {
    const { result } = renderHook(() => useSttModelReady(false));
    await flush();

    expect(invokeMock).not.toHaveBeenCalled();
    expect(result.current.ready).toBe(false);
  });

  it('refresh() is inert while disabled', async () => {
    const { result } = renderHook(() => useSttModelReady(false));

    await act(async () => {
      result.current.refresh();
    });

    expect(invokeMock).not.toHaveBeenCalled();
    expect(result.current.ready).toBe(false);
  });

  it('drops readiness and ignores refresh() once disabled', async () => {
    invokeMock.mockResolvedValue({ ready: true, files: [] });
    const { result, rerender } = renderHook(({ enabled }) => useSttModelReady(enabled), {
      initialProps: { enabled: true },
    });
    await flush();
    expect(result.current.ready).toBe(true);

    await act(async () => {
      rerender({ enabled: false });
    });
    expect(result.current.ready).toBe(false);

    await act(async () => {
      result.current.refresh();
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});

// ── 4. Re-probe on the enable edge + refresh() ──────────────────────────────

describe('useSttModelReady — re-probe', () => {
  it('re-probes on the enable 0 -> 1 edge', async () => {
    const { result, rerender } = renderHook(({ enabled }) => useSttModelReady(enabled), {
      initialProps: { enabled: false },
    });
    expect(invokeMock).not.toHaveBeenCalled();

    invokeMock.mockResolvedValue({ ready: true, files: [] });
    await act(async () => {
      rerender({ enabled: true });
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(result.current.ready).toBe(true);

    await act(async () => {
      rerender({ enabled: false });
    });
    expect(result.current.ready).toBe(false);

    await act(async () => {
      rerender({ enabled: true });
    });
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(result.current.ready).toBe(true);
  });

  it('refresh() re-probes — the summon path can flip readiness', async () => {
    invokeMock.mockResolvedValueOnce({ ready: false, files: [] });
    const { result } = renderHook(() => useSttModelReady(true));
    await flush();
    expect(result.current.ready).toBe(false);

    invokeMock.mockResolvedValueOnce({ ready: true, files: [] });
    await act(async () => {
      result.current.refresh();
    });

    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(result.current.ready).toBe(true);
  });
});

// ── 5. Cost bound — no probe storm ──────────────────────────────────────────

describe('useSttModelReady — cost bound', () => {
  it('does not probe per render cycle', async () => {
    invokeMock.mockResolvedValue({ ready: true, files: [] });

    const { result, rerender } = renderHook(({ enabled }) => useSttModelReady(enabled), {
      initialProps: { enabled: true },
    });
    await flush();
    expect(invokeMock).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        rerender({ enabled: true });
      });
    }

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(result.current.ready).toBe(true);
  });

  it('coalesces a refresh that lands while a probe is already in flight', async () => {
    let resolveProbe: (value: unknown) => void = () => {};
    invokeMock.mockImplementation(
      () => new Promise((res) => (resolveProbe = res)),
    );

    const { result } = renderHook(() => useSttModelReady(true));
    expect(invokeMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      result.current.refresh();
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveProbe({ ready: true, files: [] });
    });
    expect(result.current.ready).toBe(true);
  });
});

// ── 6. Unmount contract ─────────────────────────────────────────────────────

describe('useSttModelReady — unmount contract', () => {
  it('ignores a probe that settles after unmount', async () => {
    let resolveProbe: (value: unknown) => void = () => {};
    invokeMock.mockImplementation(
      () => new Promise((res) => (resolveProbe = res)),
    );

    const { result, unmount } = renderHook(() => useSttModelReady(true));
    const snapshot = result.current;
    unmount();

    await act(async () => {
      resolveProbe({ ready: true, files: [] });
    });

    expect(result.current).toBe(snapshot);
    expect(result.current.ready).toBe(false);
  });
});

// ── 7. Sanctioned transport ─────────────────────────────────────────────────

describe('useSttModelReady — transport invariant', () => {
  it('never statically imports @tauri-apps/api and never uses useEventRows', () => {
    // vitest runs with cwd = apps/ui; resolve the hook source relative to it.
    const rawSource = readFileSync(
      resolve(process.cwd(), 'src/shared/hooks/useSttModelReady.ts'),
      'utf8',
    );
    // Strip comments so doc prose about the sanctioned transport cannot
    // false-positive the literal grep.
    const source = rawSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    expect(source).not.toMatch(/@tauri-apps\/api/);
    expect(source).not.toMatch(/useEventRows/);
    expect(source).toMatch(/adapterBridge/);
  });
});
