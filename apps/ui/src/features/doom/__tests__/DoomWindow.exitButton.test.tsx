/**
 * Spec #2970 ST-6 — the `doom-exit-button` in the Doom window header.
 *
 * Pins the phase-gated exit affordance against the mocked `get_doom_mode_status`
 * seed + `doom-mode-changed` broadcast:
 *   inactive  -> NOT rendered (the direct `?view=doom` route has no mode)
 *   entering  -> rendered, disabled
 *   active    -> enabled, invokes `exit_doom_mode {reason:"window"}` on click
 *   exiting   -> disabled (loading), name preserved
 *
 * The runtime phase is independent: the button is gated on the Doom Mode phase,
 * never the `launch_doom_runtime` phase.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { adapterBridge } from '@/shared/utils/adapterBridge';
import { setPerformanceGateActive } from '@/shared/doom-mode';
import { DoomWindow } from '../DoomWindow';

const listeners: Record<string, (payload: unknown) => void> = {};

let modeSeed: unknown;
let exitCalls: Array<Record<string, unknown> | undefined> = [];

const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
  switch (command) {
    case 'launch_doom_runtime':
      return { success: true, phase: 'ready', port: 6666, pid: 42, enginePath: 'engine' };
    case 'doom_read_state':
      return { raw: { tic: 1, outcome: 'alive' } };
    case 'get_doom_mode_status':
      return modeSeed;
    case 'exit_doom_mode':
      exitCalls.push(args);
      return {
        success: true,
        phase: 'inactive',
        active: false,
        voiceSuppressed: false,
        origin: 'window',
        error: null,
        code: null,
      };
    default:
      return undefined;
  }
});

function modeStatus(overrides: Record<string, unknown>) {
  return {
    phase: 'inactive',
    active: false,
    voiceSuppressed: false,
    origin: null,
    enteredAt: null,
    lastError: null,
    code: null,
    ...overrides,
  };
}

async function renderReady() {
  renderWithChakra(<DoomWindow />);
  await waitFor(() => expect(screen.getByTestId('doom-status')).toHaveTextContent('Ready'));
}

function emitMode(status: Record<string, unknown>) {
  act(() => {
    listeners['doom-mode-changed']?.(status);
  });
}

beforeEach(() => {
  for (const key of Object.keys(listeners)) delete listeners[key];
  modeSeed = modeStatus({});
  exitCalls = [];
  invoke.mockClear();
  adapterBridge.setInvoke(invoke as never);
  adapterBridge.setListen((async (event: string, handler: (payload: unknown) => void) => {
    listeners[event] = handler;
    return () => {
      delete listeners[event];
    };
  }) as never);
});

afterEach(() => {
  cleanup();
  setPerformanceGateActive(false);
  adapterBridge.setInvoke(undefined as never);
  adapterBridge.setListen(undefined as never);
  vi.clearAllMocks();
});

describe('Spec #2970 ST-6 — doom-exit-button', () => {
  it('is NOT rendered while Doom Mode is inactive (direct ?view=doom route)', async () => {
    await renderReady();
    expect(screen.queryByTestId('doom-exit-button')).toBeNull();
  });

  it('is disabled while entering, enabled when active, and exits with reason "window" on click', async () => {
    await renderReady();

    emitMode(
      modeStatus({ phase: 'entering', active: false, voiceSuppressed: true, origin: 'code' }),
    );
    const button = screen.getByTestId('doom-exit-button');
    expect(button).toHaveTextContent('Exit Doom Mode');
    expect(button).toBeDisabled();

    emitMode(modeStatus({ phase: 'active', active: true, voiceSuppressed: true, origin: 'code' }));
    expect(screen.getByTestId('doom-exit-button')).toBeEnabled();

    fireEvent.click(screen.getByTestId('doom-exit-button'));
    await waitFor(() => expect(exitCalls.length).toBe(1));
    expect(exitCalls[0]).toEqual({ reason: 'window' });
  });

  it('is disabled (loading) while exiting and keeps its name', async () => {
    await renderReady();
    emitMode(modeStatus({ phase: 'active', active: true, voiceSuppressed: true, origin: 'code' }));
    expect(screen.getByTestId('doom-exit-button')).toBeEnabled();

    emitMode(modeStatus({ phase: 'exiting', active: true, voiceSuppressed: true, origin: 'code' }));
    const button = screen.getByTestId('doom-exit-button');
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent('Exit Doom Mode');
  });

  it('hydrates from the get_doom_mode_status seed (active on open)', async () => {
    modeSeed = modeStatus({
      phase: 'active',
      active: true,
      voiceSuppressed: true,
      origin: 'voice',
    });
    await renderReady();
    await waitFor(() => expect(screen.getByTestId('doom-exit-button')).toBeEnabled());
  });
});
