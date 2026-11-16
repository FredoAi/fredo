/**
 * Spec #2970 ST-5 — pins the companion `doom_mode` dispatcher: `action`
 * validation, enter/exit invocation, and the ONE deterministic reply per call
 * (the exact UI/UX §4 copy). The dispatcher must ALWAYS push a reply so the 15 s
 * companion watchdog can never fire.
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

import { registerAppOpenReplyPusher } from '../../components/companion/skillBridge';
import { DOOM_MODE_INACTIVE_STATUS, type DoomModeStatus } from '../types';
import {
  DOOM_MODE_DISENGAGED_REPLY,
  DOOM_MODE_ENGAGED_REPLY,
  DOOM_MODE_ENTER_FAILED_REPLY,
  DOOM_MODE_MALFORMED_REPLY,
  DOOM_MODE_NOT_ACTIVE_REPLY,
  useDoomModeSkill,
} from '../useDoomModeSkill';

type Handler = (payload: unknown) => void;

let handlers: Record<string, Handler[]>;
let pusher: ReturnType<typeof vi.fn>;
let unregister: (() => void) | null = null;

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

async function mountWith(
  status: DoomModeStatus,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  invokeMock.mockImplementation(async (command: string) => {
    if (command in overrides) {
      const value = overrides[command];
      if (value instanceof Error) throw value;
      return value;
    }
    if (command === 'get_doom_mode_status') return status;
    return undefined;
  });
  renderHook(() => useDoomModeSkill());
  await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('get_doom_mode_status'));
}

beforeEach(() => {
  handlers = {};
  pusher = vi.fn();
  unregister = registerAppOpenReplyPusher(pusher);
  invokeMock.mockReset();
  listenMock.mockReset();
  listenMock.mockImplementation(async (event: string, handler: Handler) => {
    (handlers[event] ??= []).push(handler);
    return vi.fn();
  });
});

afterEach(() => {
  unregister?.();
  unregister = null;
  cleanup();
});

describe('useDoomModeSkill', () => {
  it('enter accepted & mode active → success `Doom Mode engaged.`', async () => {
    await mountWith(DOOM_MODE_INACTIVE_STATUS, {
      enter_doom_mode: {
        success: true,
        phase: 'active',
        active: true,
        voiceSuppressed: true,
        origin: 'voice',
        error: null,
        code: null,
      },
    });

    await act(async () => {
      emit('llm-skill-call', { skill: 'doom_mode', arguments: { action: 'enter' } });
    });

    await waitFor(() => expect(pusher).toHaveBeenCalledTimes(1));
    expect(invokeMock).toHaveBeenCalledWith('enter_doom_mode', { origin: 'voice' });
    expect(pusher).toHaveBeenCalledWith({ kind: 'success', text: DOOM_MODE_ENGAGED_REPLY });
    expect(DOOM_MODE_ENGAGED_REPLY).toBe('Doom Mode engaged.');
  });

  it('enter failed → failed `I couldn\'t start Doom Mode. Nothing changed.`', async () => {
    await mountWith(DOOM_MODE_INACTIVE_STATUS, {
      enter_doom_mode: {
        success: false,
        phase: 'inactive',
        active: false,
        voiceSuppressed: false,
        origin: null,
        error: 'boom',
        code: 'spawnFailed',
      },
    });

    await act(async () => {
      emit('llm-skill-call', { skill: 'doom_mode', arguments: { action: 'enter' } });
    });

    await waitFor(() => expect(pusher).toHaveBeenCalledTimes(1));
    expect(pusher).toHaveBeenCalledWith({ kind: 'failed', text: DOOM_MODE_ENTER_FAILED_REPLY });
    expect(DOOM_MODE_ENTER_FAILED_REPLY).toBe("I couldn't start Doom Mode. Nothing changed.");
  });

  it('exit accepted & mode inactive → success `Doom Mode disengaged.`', async () => {
    await mountWith(activeStatus, {
      exit_doom_mode: {
        success: true,
        phase: 'inactive',
        active: false,
        voiceSuppressed: false,
        origin: null,
        error: null,
        code: null,
      },
    });

    await act(async () => {
      emit('llm-skill-call', { skill: 'doom_mode', arguments: { action: 'exit' } });
    });

    await waitFor(() => expect(pusher).toHaveBeenCalledTimes(1));
    expect(invokeMock).toHaveBeenCalledWith('exit_doom_mode', { reason: 'voice' });
    expect(pusher).toHaveBeenCalledWith({ kind: 'success', text: DOOM_MODE_DISENGAGED_REPLY });
    expect(DOOM_MODE_DISENGAGED_REPLY).toBe('Doom Mode disengaged.');
  });

  it('exit while already inactive → unknown `Doom Mode isn\'t active.`', async () => {
    await mountWith(DOOM_MODE_INACTIVE_STATUS);

    await act(async () => {
      emit('llm-skill-call', { skill: 'doom_mode', arguments: { action: 'exit' } });
    });

    await waitFor(() => expect(pusher).toHaveBeenCalledTimes(1));
    expect(pusher).toHaveBeenCalledWith({ kind: 'unknown', text: DOOM_MODE_NOT_ACTIVE_REPLY });
    expect(DOOM_MODE_NOT_ACTIVE_REPLY).toBe("Doom Mode isn't active.");
  });

  it('malformed/unknown action → failed `I didn\'t catch that Doom Mode command.`', async () => {
    await mountWith(DOOM_MODE_INACTIVE_STATUS);

    for (const argumentsValue of [{ action: 'nope' }, {}, { action: 7 }, null, undefined]) {
      await act(async () => {
        emit('llm-skill-call', { skill: 'doom_mode', arguments: argumentsValue });
      });
    }

    await waitFor(() => expect(pusher).toHaveBeenCalledTimes(5));
    for (const call of pusher.mock.calls) {
      expect(call[0]).toEqual({ kind: 'failed', text: DOOM_MODE_MALFORMED_REPLY });
    }
    expect(DOOM_MODE_MALFORMED_REPLY).toBe("I didn't catch that Doom Mode command.");
    // A malformed action executes nothing.
    expect(invokeMock).not.toHaveBeenCalledWith('enter_doom_mode', expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith('exit_doom_mode', expect.anything());
  });

  it('ignores every other skill (no reply, no invocation)', async () => {
    await mountWith(DOOM_MODE_INACTIVE_STATUS);

    await act(async () => {
      emit('llm-skill-call', { skill: 'open_app', arguments: { app: 'Settings' } });
    });

    expect(pusher).not.toHaveBeenCalled();
  });

  it('always pushes a reply when the invoke throws (watchdog safety)', async () => {
    await mountWith(DOOM_MODE_INACTIVE_STATUS, {
      enter_doom_mode: new Error('ipc down'),
    });

    await act(async () => {
      emit('llm-skill-call', { skill: 'doom_mode', arguments: { action: 'enter' } });
    });

    await waitFor(() => expect(pusher).toHaveBeenCalledTimes(1));
    expect(pusher).toHaveBeenCalledWith({ kind: 'failed', text: DOOM_MODE_ENTER_FAILED_REPLY });
  });
});
