/**
 * Spec #2893 ST-6 — pins Home's app-open request/confirm loop.
 *
 * Covers the CLI round trip (`app-open-request` -> resolve -> one opener ->
 * structured confirm) and the companion skill path (`llm-skill-call` -> resolve
 * -> push reply FIRST -> deferred `run_open_app_cli` for resolved identities
 * only). The `openFeatureWindow` opener is injected so the suite proves the
 * hook never reaches for a raw window opener.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

import { adapterBridge } from '../../../../shared/utils/adapterBridge';
import { registerAppOpenReplyPusher } from '../../../../shared/components/companion/skillBridge';
import type { AppOpenReply } from '../../../../shared/components/companion/appOpenReply';
import type { FredoFeatureClass } from '../../../../shared/classes/FredoFeatureClass';
import { APP_OPEN_REPLY_BEAT_MS, useAppOpenRequests } from '../useAppOpenRequests';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const entry = (id: string, name: string): FredoFeatureClass =>
  ({ id, name, showable: true }) as unknown as FredoFeatureClass;

const MISSION_MONITOR = entry('mission-monitor', 'Mission Monitor');
const MONITOR_TWO = entry('monitor-two', 'Monitor Two');
const FEATURES: readonly FredoFeatureClass[] = [MISSION_MONITOR];
const TWO_FEATURES: readonly FredoFeatureClass[] = [MISSION_MONITOR, MONITOR_TWO];

type Handler = (payload: any) => void;

let handlers: Record<string, Handler>;
let invokeMock: ReturnType<typeof vi.fn>;
let unlistenSpy: ReturnType<typeof vi.fn>;
let unregisterPusher: (() => void) | null;
let pushed: AppOpenReply[];

beforeEach(() => {
  handlers = {};
  unlistenSpy = vi.fn();
  invokeMock = vi.fn().mockResolvedValue({ exitCode: 0, outcome: 'opened', message: null });
  const listenMock = vi.fn(async (event: string, handler: Handler) => {
    handlers[event] = handler;
    return unlistenSpy;
  });
  adapterBridge.setListen(listenMock as any);
  adapterBridge.setInvoke(invokeMock as any);

  pushed = [];
  unregisterPusher = registerAppOpenReplyPusher((reply) => pushed.push(reply));
});

afterEach(() => {
  unregisterPusher?.();
  unregisterPusher = null;
  adapterBridge.setListen(undefined as any);
  adapterBridge.setInvoke(undefined as any);
  vi.useRealTimers();
});

async function renderAppOpenHook(features: readonly FredoFeatureClass[] = FEATURES) {
  const openFeatureWindow = vi.fn();
  const view = renderHook(() => useAppOpenRequests({ openFeatureWindow, features }));
  await waitFor(() => {
    expect(handlers['app-open-request']).toBeTypeOf('function');
    expect(handlers['llm-skill-call']).toBeTypeOf('function');
  });
  return { openFeatureWindow, ...view };
}

// ── (a) app-open-request — the CLI round trip ────────────────────────────────

describe('useAppOpenRequests — app-open-request (CLI path)', () => {
  it('opens through the injected opener and confirms `opened` for a resolved identity', async () => {
    const { openFeatureWindow } = await renderAppOpenHook();

    await act(async () => {
      handlers['app-open-request']({ requestId: 'r1', identity: 'open Mission Monitor' });
    });

    expect(openFeatureWindow).toHaveBeenCalledTimes(1);
    expect(openFeatureWindow).toHaveBeenCalledWith('mission-monitor', MISSION_MONITOR);
    expect(invokeMock).toHaveBeenCalledWith('confirm_app_open_request', {
      requestId: 'r1',
      outcome: 'opened',
      message: 'Opening Mission Monitor',
      displayName: 'Mission Monitor',
    });
  });

  it('opens ZERO windows and confirms `unknown` for an unresolved identity', async () => {
    const { openFeatureWindow } = await renderAppOpenHook();

    await act(async () => {
      handlers['app-open-request']({ requestId: 'r2', identity: 'open Narnia' });
    });

    expect(openFeatureWindow).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith('confirm_app_open_request', {
      requestId: 'r2',
      outcome: 'unknown',
      message: 'I couldn\'t find "Narnia"',
      spokenName: 'Narnia',
    });
  });

  it('opens ZERO windows and confirms `ambiguous` with the candidate names', async () => {
    const { openFeatureWindow } = await renderAppOpenHook(TWO_FEATURES);

    await act(async () => {
      handlers['app-open-request']({ requestId: 'r3', identity: 'monitor' });
    });

    expect(openFeatureWindow).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith('confirm_app_open_request', {
      requestId: 'r3',
      outcome: 'ambiguous',
      message:
        'I found more than one app matching "monitor". Which one did you mean: Mission Monitor or Monitor Two?',
      spokenName: 'monitor',
      candidates: ['Mission Monitor', 'Monitor Two'],
    });
  });

  it('swallows a confirmation failure (expired request id) without throwing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    invokeMock.mockRejectedValue(new Error('unknown or expired request id'));
    await renderAppOpenHook();

    await act(async () => {
      handlers['app-open-request']({ requestId: 'gone', identity: 'mission-monitor' });
    });

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ── (b) llm-skill-call — the companion skill path ────────────────────────────

describe('useAppOpenRequests — llm-skill-call (companion path)', () => {
  it('pushes the success reply FIRST, then runs the CLI after the beat', async () => {
    const { openFeatureWindow } = await renderAppOpenHook();
    vi.useFakeTimers();

    act(() => {
      handlers['llm-skill-call']({ skill: 'open_app', arguments: { app: 'open Mission Monitor' } });
    });

    expect(pushed).toEqual([{ kind: 'success', text: 'Opening Mission Monitor' }]);
    expect(invokeMock).not.toHaveBeenCalledWith('run_open_app_cli', expect.anything());
    // The skill path never opens directly — the CLI round trip owns the open.
    expect(openFeatureWindow).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(APP_OPEN_REPLY_BEAT_MS);
    });

    expect(invokeMock).toHaveBeenCalledWith('run_open_app_cli', { identity: 'mission-monitor' });
    expect(pushed).toHaveLength(1);
  });

  it('pushes the failed reply when the CLI outcome is non-zero', async () => {
    invokeMock.mockResolvedValue({ exitCode: 1, outcome: 'unavailable', message: 'boom' });
    await renderAppOpenHook();
    vi.useFakeTimers();

    act(() => {
      handlers['llm-skill-call']({ skill: 'open_app', arguments: { app: 'Mission Monitor' } });
    });
    await act(async () => {
      vi.advanceTimersByTime(APP_OPEN_REPLY_BEAT_MS);
    });

    expect(pushed).toEqual([
      { kind: 'success', text: 'Opening Mission Monitor' },
      {
        kind: 'failed',
        text: 'I couldn\'t open Mission Monitor. Try again from the launcher grid.',
      },
    ]);
  });

  it('pushes `unknown` and NEVER invokes the CLI for an unresolved identity', async () => {
    await renderAppOpenHook();

    act(() => {
      handlers['llm-skill-call']({ skill: 'open_app', arguments: { app: 'Narnia' } });
    });

    expect(pushed).toEqual([{ kind: 'unknown', text: 'I couldn\'t find "Narnia"' }]);
    expect(invokeMock).not.toHaveBeenCalledWith('run_open_app_cli', expect.anything());
  });

  it('pushes `ambiguous` and NEVER invokes the CLI when >1 candidate matches', async () => {
    await renderAppOpenHook(TWO_FEATURES);

    act(() => {
      handlers['llm-skill-call']({ skill: 'open_app', arguments: { app: 'monitor' } });
    });

    expect(pushed).toEqual([
      {
        kind: 'ambiguous',
        text: 'I found more than one app matching "monitor". Which one did you mean: Mission Monitor or Monitor Two?',
      },
    ]);
    expect(invokeMock).not.toHaveBeenCalledWith('run_open_app_cli', expect.anything());
  });

  it('ignores non-`open_app` skills (zero spurious opens)', async () => {
    await renderAppOpenHook();

    act(() => {
      handlers['llm-skill-call']({
        skill: 'tell_joke',
        arguments: { app: 'Mission Monitor' },
      });
    });

    expect(pushed).toEqual([]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('fails closed for a missing/malformed app argument (no CLI, no window)', async () => {
    await renderAppOpenHook();

    act(() => {
      handlers['llm-skill-call']({ skill: 'open_app', arguments: {} });
    });

    expect(pushed).toEqual([{ kind: 'unknown', text: 'I couldn\'t find ""' }]);
    expect(invokeMock).not.toHaveBeenCalledWith('run_open_app_cli', expect.anything());
  });
});

// ── lifecycle ────────────────────────────────────────────────────────────────

describe('useAppOpenRequests — lifecycle', () => {
  it('unsubscribes both listeners on unmount', async () => {
    const { unmount } = await renderAppOpenHook();
    expect(unlistenSpy).not.toHaveBeenCalled();

    unmount();

    expect(unlistenSpy).toHaveBeenCalledTimes(2);
  });
});
