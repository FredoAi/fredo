/**
 * Spec #2970 ST-5 — pins the shared `useDoomMode` client: the mount seed, the
 * live `doom-mode-changed` subscription, the `performanceGate` driver, and the
 * `enter`/`exit` invokers.
 */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
}));

vi.mock('../../utils/adapterBridge', () => ({
  adapterBridge: {
    invoke: invokeMock,
    listen: listenMock,
  },
}));

import { isPerformanceGateActive, setPerformanceGateActive } from '../performanceGate';
import { DOOM_MODE_EVENT, DOOM_MODE_INACTIVE_STATUS, type DoomModeStatus } from '../types';
import { useDoomMode } from '../useDoomMode';

type Handler = (payload: unknown) => void;

let handlers: Record<string, Handler[]>;
let unlisteners: Array<ReturnType<typeof vi.fn>>;

const activeStatus: DoomModeStatus = {
  phase: 'active',
  active: true,
  voiceSuppressed: true,
  origin: 'code',
  enteredAt: '2026-10-04T00:00:00+00:00',
  lastError: null,
  code: null,
};

const emit = (event: string, payload: unknown) => {
  act(() => {
    (handlers[event] ?? []).forEach((handler) => handler(payload));
  });
};

beforeEach(() => {
  handlers = {};
  unlisteners = [];
  setPerformanceGateActive(false);
  invokeMock.mockReset();
  listenMock.mockReset();
  listenMock.mockImplementation(async (event: string, handler: Handler) => {
    (handlers[event] ??= []).push(handler);
    const unlisten = vi.fn();
    unlisteners.push(unlisten);
    return unlisten;
  });
});

afterEach(() => {
  cleanup();
});

describe('useDoomMode', () => {
  it('seeds from get_doom_mode_status and drives the performance gate', async () => {
    invokeMock.mockResolvedValue(activeStatus);
    const { result } = renderHook(() => useDoomMode());

    await waitFor(() => expect(result.current.active).toBe(true));
    expect(invokeMock).toHaveBeenCalledWith('get_doom_mode_status');
    expect(result.current.status).toEqual(activeStatus);
    expect(result.current.voiceSuppressed).toBe(true);
    expect(isPerformanceGateActive()).toBe(true);
  });

  it('updates on every doom-mode-changed broadcast', async () => {
    invokeMock.mockResolvedValue(DOOM_MODE_INACTIVE_STATUS);
    const { result } = renderHook(() => useDoomMode());
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('get_doom_mode_status'));

    emit(DOOM_MODE_EVENT, activeStatus);
    expect(result.current.active).toBe(true);
    expect(isPerformanceGateActive()).toBe(true);

    emit(DOOM_MODE_EVENT, DOOM_MODE_INACTIVE_STATUS);
    expect(result.current.active).toBe(false);
    expect(isPerformanceGateActive()).toBe(false);
  });

  it('invokes enter/exit with the bound arguments and returns the typed result', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'get_doom_mode_status') return DOOM_MODE_INACTIVE_STATUS;
      if (command === 'enter_doom_mode') {
        return {
          success: true,
          phase: 'active',
          active: true,
          voiceSuppressed: true,
          origin: 'voice',
          error: null,
          code: null,
        };
      }
      if (command === 'exit_doom_mode') {
        return {
          success: true,
          phase: 'inactive',
          active: false,
          voiceSuppressed: false,
          origin: null,
          error: null,
          code: null,
        };
      }
      return undefined;
    });

    const { result } = renderHook(() => useDoomMode());
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('get_doom_mode_status'));

    let entered: Awaited<ReturnType<typeof result.current.enter>>;
    await act(async () => {
      entered = await result.current.enter('voice');
    });
    expect(invokeMock).toHaveBeenCalledWith('enter_doom_mode', { origin: 'voice' });
    expect(entered?.active).toBe(true);

    await act(async () => {
      await result.current.exit('window');
    });
    expect(invokeMock).toHaveBeenCalledWith('exit_doom_mode', { reason: 'window' });
  });

  it('removes the event listener on unmount', async () => {
    invokeMock.mockResolvedValue(DOOM_MODE_INACTIVE_STATUS);
    const { unmount } = renderHook(() => useDoomMode());
    await waitFor(() => expect(listenMock).toHaveBeenCalled());
    unmount();
    expect(unlisteners.every((off) => off.mock.calls.length === 1)).toBe(true);
  });
});
