/**
 * Spec #3007 ST-1 — the Doom window has NO in-window exit control and NO mode
 * controls. Closing the native OS window is the only exit, and its teardown
 * (agent + runtime + mode broadcast) is Rust-owned.
 *
 * Inverts the former `doom-exit-button` suite: where it once asserted the
 * phase-gated exit affordance, this asserts the affordance and every other mode
 * control are ABSENT, and that the React layer never wires an exit/close path.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { adapterBridge } from '@/shared/utils/adapterBridge';
import { DoomWindow } from '../DoomWindow';

const listeners: Record<string, (payload: unknown) => void> = {};

/** Every hook the game-only surface MUST NOT render (AC1 / R-1.a). */
const REMOVED_HOOKS = [
  'doom-window-title',
  'doom-status',
  'doom-exit-button',
  'doom-engine-location',
  'doom-engine-location-saved',
  'doom-state-readout',
  'doom-campaign-controls',
  'doom-save-status',
  'doom-progress-complete',
  'doom-fresh-start-button',
  'doom-fresh-start-confirm',
  'doom-fresh-start-cancel',
  'doom-autoplay-toggle',
  'doom-autoplay-stop',
  'doom-autoplay-status',
  'doom-autoplay-elapsed',
  'doom-autoplay-error',
  'doom-step-button',
  'doom-start-button',
] as const;

let modeSeed: unknown;
let frameCalls = 0;

const invoke = vi.fn(async (command: string, _args?: Record<string, unknown>) => {
  switch (command) {
    case 'launch_doom_runtime':
      return { success: true, phase: 'ready', port: 6666, pid: 42, enginePath: 'engine' };
    case 'doom_read_state':
      return { raw: { tic: 1, outcome: 'alive' } };
    case 'doom_frame':
      frameCalls += 1;
      return { pngBase64: 'AAAA' };
    case 'get_doom_mode_status':
      return modeSeed;
    case 'get_doom_autoplay_status':
      // A run already in flight: the R-3 repair must not fire (no in-window path).
      return {
        phase: 'running',
        running: true,
        steps: 5,
        decisions: 5,
        failures: 0,
        consecutiveFailures: 0,
        lastTic: 5,
        outcome: 'alive',
        startedAt: new Date().toISOString(),
        lastError: null,
        code: null,
        episode: null,
        map: null,
        completed: false,
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

async function renderReady(): Promise<void> {
  renderWithChakra(<DoomWindow />);
  await waitFor(() => expect(frameCalls).toBeGreaterThan(0));
}

function emitMode(status: Record<string, unknown>): void {
  act(() => {
    listeners['doom-mode-changed']?.(status);
  });
}

/** Strip block + line comments so doc prose cannot satisfy a source pin. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

beforeEach(() => {
  for (const key of Object.keys(listeners)) delete listeners[key];
  modeSeed = modeStatus({});
  frameCalls = 0;
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
  adapterBridge.setInvoke(undefined as never);
  adapterBridge.setListen(undefined as never);
  vi.clearAllMocks();
});

describe('Spec #3007 ST-1 — no in-window exit control', () => {
  it('AC4/R-4.b: doom-exit-button never renders in any Doom Mode phase', async () => {
    await renderReady();
    for (const phase of ['inactive', 'entering', 'provisioning', 'active', 'exiting']) {
      emitMode(
        modeStatus({
          phase,
          active: phase === 'active' || phase === 'exiting',
          voiceSuppressed: phase !== 'inactive',
          origin: 'code',
        }),
      );
      expect(screen.queryByTestId('doom-exit-button'), `phase=${phase}`).toBeNull();
      expect(screen.queryByText('Exit Doom Mode')).toBeNull();
    }
  });

  it('AC1: no mode controls or instrumentation hooks render while the mode is active', async () => {
    await renderReady();
    emitMode(modeStatus({ phase: 'active', active: true, voiceSuppressed: true, origin: 'code' }));
    for (const hook of REMOVED_HOOKS) {
      expect(screen.queryByTestId(hook), `${hook} must not render`).toBeNull();
    }
    // No controls exist at all in the ready/engaged state.
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('AC4: the window never invokes exit_doom_mode or stop_doom_runtime', async () => {
    await renderReady();
    emitMode(modeStatus({ phase: 'active', active: true, voiceSuppressed: true, origin: 'code' }));
    await waitFor(() => expect(frameCalls).toBeGreaterThan(0));
    const commands = invoke.mock.calls.map(([command]) => command);
    expect(commands).not.toContain('exit_doom_mode');
    expect(commands).not.toContain('stop_doom_runtime');
  });

  it('AC4: close teardown is Rust-owned — the window registers no JS close interception', () => {
    const source = stripComments(
      readFileSync(resolve(process.cwd(), 'src/applications/doom/DoomWindow.tsx'), 'utf8'),
    );
    expect(source).not.toMatch(/onCloseRequested/);
    expect(source).not.toMatch(/getCurrentWindow/);
    expect(source).not.toMatch(/stop_doom_runtime/);
    expect(source).not.toMatch(/exit_doom_mode/);
  });
});
