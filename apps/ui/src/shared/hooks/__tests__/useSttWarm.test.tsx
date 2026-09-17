/**
 * useSttWarm — Spec #2887 ST-6 unit pins (R-1, R-4, R-6, R-7).
 *
 * Covers: the warm call runs while voice is ENABLED and the model probe is
 * ready (and only then), the auto re-attempt edges (enable 0→1, model probe
 * first-ready), the summon-path `warmNow()` retry, the fail-honest/never-
 * optimistic residency observable, the silent-failure contract (a rejection or a
 * non-warmed result never throws and never surfaces an error), the coalescing
 * cost bound (no call storm; an in-flight call absorbs a concurrent trigger),
 * the disabled/stale guards (a call settling after disable or unmount is a
 * no-op; disable drops the observable), and the sanctioned-transport invariant
 * (never a static `@tauri-apps/api` import).
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

import { useSttWarm } from '../useSttWarm';

/** Flush the pending warm microtasks under `act`. */
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

// ── 1. Warm while enabled + model-ready ─────────────────────────────────────

describe('useSttWarm — enabled + model-ready', () => {
  it('calls stt_warm once on the enabled+ready path and reports residency', async () => {
    invokeMock.mockResolvedValue({ warmed: true, warmMs: 1234 });

    const { result } = renderHook(() => useSttWarm(true, true));
    await flush();

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('stt_warm');
    expect(result.current.warm).toBe(true);
  });

  it('is never optimistic — warm is false before the call resolves', () => {
    invokeMock.mockImplementation(() => new Promise(() => {}));

    const { result } = renderHook(() => useSttWarm(true, true));

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(result.current.warm).toBe(false);
  });

  it('reports warm:false for a non-warmed (failed) result', async () => {
    invokeMock.mockResolvedValue({
      warmed: false,
      code: 'modelMissing',
      detail: 'tokens.txt is missing',
    });

    const { result } = renderHook(() => useSttWarm(true, true));
    await flush();

    expect(result.current.warm).toBe(false);
  });

  it('reports warm:false for a malformed result shape', async () => {
    invokeMock.mockResolvedValue({ warmed: 'yes' });

    const { result } = renderHook(() => useSttWarm(true, true));
    await flush();

    expect(result.current.warm).toBe(false);
  });

  it('reports warm:false when the command is unavailable (invoke resolves undefined)', async () => {
    invokeMock.mockResolvedValue(undefined);

    const { result } = renderHook(() => useSttWarm(true, true));
    await flush();

    expect(result.current.warm).toBe(false);
  });

  it('exposes a stable warmNow function', () => {
    invokeMock.mockResolvedValue({ warmed: true });

    const { result, rerender } = renderHook(
      ({ enabled, ready }) => useSttWarm(enabled, ready),
      { initialProps: { enabled: true, ready: true } },
    );

    const first = result.current.warmNow;
    rerender({ enabled: true, ready: true });
    expect(result.current.warmNow).toBe(first);
  });
});

// ── 2. Disabled / not-ready ⇒ no invoke ─────────────────────────────────────

describe('useSttWarm — no invoke while disabled or not ready', () => {
  it('never invokes while voice input is disabled', async () => {
    const { result } = renderHook(() => useSttWarm(false, true));
    await flush();

    expect(invokeMock).not.toHaveBeenCalled();
    expect(result.current.warm).toBe(false);
  });

  it('never invokes while the model probe is not ready', async () => {
    const { result } = renderHook(() => useSttWarm(true, false));
    await flush();

    expect(invokeMock).not.toHaveBeenCalled();
    expect(result.current.warm).toBe(false);
  });

  it('warmNow() is inert while disabled', async () => {
    const { result } = renderHook(() => useSttWarm(false, true));

    await act(async () => {
      result.current.warmNow();
    });

    expect(invokeMock).not.toHaveBeenCalled();
    expect(result.current.warm).toBe(false);
  });

  it('warmNow() is inert while the model probe is not ready', async () => {
    const { result } = renderHook(() => useSttWarm(true, false));

    await act(async () => {
      result.current.warmNow();
    });

    expect(invokeMock).not.toHaveBeenCalled();
    expect(result.current.warm).toBe(false);
  });
});

// ── 3. Re-attempt edges + the summon path ───────────────────────────────────

describe('useSttWarm — re-attempt edges', () => {
  it('re-attempts on the voice-enabled 0 -> 1 edge', async () => {
    invokeMock.mockResolvedValue({ warmed: true });

    const { result, rerender } = renderHook(
      ({ enabled, ready }) => useSttWarm(enabled, ready),
      { initialProps: { enabled: false, ready: true } },
    );
    expect(invokeMock).not.toHaveBeenCalled();

    await act(async () => {
      rerender({ enabled: true, ready: true });
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(result.current.warm).toBe(true);

    await act(async () => {
      rerender({ enabled: false, ready: true });
    });
    expect(result.current.warm).toBe(false);

    await act(async () => {
      rerender({ enabled: true, ready: true });
    });
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(result.current.warm).toBe(true);
  });

  it('re-attempts when the model probe first reports ready', async () => {
    invokeMock.mockResolvedValue({ warmed: true });

    const { result, rerender } = renderHook(
      ({ enabled, ready }) => useSttWarm(enabled, ready),
      { initialProps: { enabled: true, ready: false } },
    );
    expect(invokeMock).not.toHaveBeenCalled();

    await act(async () => {
      rerender({ enabled: true, ready: true });
    });

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(result.current.warm).toBe(true);
  });

  it('does not invoke on the ready 1 -> 0 edge (readiness loss alone is not a warm)', async () => {
    invokeMock.mockResolvedValue({ warmed: true });

    const { rerender } = renderHook(
      ({ enabled, ready }) => useSttWarm(enabled, ready),
      { initialProps: { enabled: true, ready: true } },
    );
    await flush();
    expect(invokeMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      rerender({ enabled: true, ready: false });
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('warmNow() re-attempts on the summon path after a failed warm', async () => {
    invokeMock.mockResolvedValueOnce({ warmed: false, code: 'engineStartFailed' });
    const { result } = renderHook(() => useSttWarm(true, true));
    await flush();
    expect(result.current.warm).toBe(false);
    expect(invokeMock).toHaveBeenCalledTimes(1);

    invokeMock.mockResolvedValueOnce({ warmed: true, warmMs: 900 });
    await act(async () => {
      result.current.warmNow();
    });

    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(result.current.warm).toBe(true);
  });

  it('warmNow() repeats the idempotent command while already warm (the backend short-circuits)', async () => {
    invokeMock.mockResolvedValue({ warmed: true });
    const { result } = renderHook(() => useSttWarm(true, true));
    await flush();
    expect(result.current.warm).toBe(true);

    await act(async () => {
      result.current.warmNow();
    });

    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(result.current.warm).toBe(true);
  });

  it('warmNow() is inert again once disabled', async () => {
    invokeMock.mockResolvedValue({ warmed: true });
    const { result, rerender } = renderHook(
      ({ enabled, ready }) => useSttWarm(enabled, ready),
      { initialProps: { enabled: true, ready: true } },
    );
    await flush();
    expect(invokeMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      rerender({ enabled: false, ready: true });
    });
    expect(result.current.warm).toBe(false);

    await act(async () => {
      result.current.warmNow();
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});

// ── 4. Cost bound — bounded + coalesced ─────────────────────────────────────

describe('useSttWarm — cost bound', () => {
  it('does not invoke per render cycle', async () => {
    invokeMock.mockResolvedValue({ warmed: true });

    const { result, rerender } = renderHook(
      ({ enabled, ready }) => useSttWarm(enabled, ready),
      { initialProps: { enabled: true, ready: true } },
    );
    await flush();
    expect(invokeMock).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        rerender({ enabled: true, ready: true });
      });
    }

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(result.current.warm).toBe(true);
  });

  it('coalesces a summon that lands while a warm is already in flight', async () => {
    let resolveCall: (value: unknown) => void = () => {};
    invokeMock.mockImplementation(
      () => new Promise((res) => (resolveCall = res)),
    );

    const { result } = renderHook(() => useSttWarm(true, true));
    // The auto call is issued synchronously by the effect and is still pending.
    expect(invokeMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      result.current.warmNow();
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveCall({ warmed: true });
    });
    expect(result.current.warm).toBe(true);
  });

  it('releases the single-flight slot so a later retry can run', async () => {
    invokeMock.mockResolvedValueOnce({ warmed: false });
    const { result } = renderHook(() => useSttWarm(true, true));
    await flush();

    invokeMock.mockResolvedValueOnce({ warmed: true });
    await act(async () => {
      result.current.warmNow();
    });

    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(result.current.warm).toBe(true);
  });
});

// ── 5. Disabled / stale guards ──────────────────────────────────────────────

describe('useSttWarm — disabled and stale guards', () => {
  it('ignores a warm that settles after voice input was disabled', async () => {
    let resolveCall: (value: unknown) => void = () => {};
    invokeMock.mockImplementation(
      () => new Promise((res) => (resolveCall = res)),
    );

    const { result, rerender } = renderHook(
      ({ enabled, ready }) => useSttWarm(enabled, ready),
      { initialProps: { enabled: true, ready: true } },
    );
    expect(invokeMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      rerender({ enabled: false, ready: true });
    });
    await act(async () => {
      resolveCall({ warmed: true });
    });

    expect(result.current.warm).toBe(false);
  });

  it('ignores a warm that settles after unmount', async () => {
    let resolveCall: (value: unknown) => void = () => {};
    invokeMock.mockImplementation(
      () => new Promise((res) => (resolveCall = res)),
    );

    const { result, unmount } = renderHook(() => useSttWarm(true, true));
    const snapshot = result.current;
    unmount();

    await act(async () => {
      resolveCall({ warmed: true });
    });

    expect(result.current).toBe(snapshot);
    expect(result.current.warm).toBe(false);
  });
});

// ── 6. Silent failure ───────────────────────────────────────────────────────

describe('useSttWarm — silent failure', () => {
  it('never throws and reports warm:false when the invoke rejects', async () => {
    invokeMock.mockRejectedValue(new Error('command stt_warm not found'));

    const { result } = renderHook(() => useSttWarm(true, true));
    await flush();

    expect(result.current.warm).toBe(false);
  });

  it('leaves the last reported residency standing on a rejected retry (no false disarm)', async () => {
    invokeMock.mockResolvedValueOnce({ warmed: true });
    const { result } = renderHook(() => useSttWarm(true, true));
    await flush();
    expect(result.current.warm).toBe(true);

    invokeMock.mockRejectedValueOnce(new Error('ipc unavailable'));
    await act(async () => {
      result.current.warmNow();
    });

    // A rejection carries no residency information — the affirmatively reported
    // state stands and nothing is thrown.
    expect(result.current.warm).toBe(true);
  });
});

// ── 7. Sanctioned transport ─────────────────────────────────────────────────

describe('useSttWarm — transport invariant', () => {
  it('never statically imports @tauri-apps/api and never uses useEventRows', () => {
    // vitest runs with cwd = apps/ui; resolve the hook source relative to it.
    const rawSource = readFileSync(
      resolve(process.cwd(), 'src/shared/hooks/useSttWarm.ts'),
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
