/**
 * Spec #3007 ST-1 — the Doom window has NO in-window exit control and NO mode
 * controls. Closing the native OS window is the only exit, and its teardown
 * (agent + runtime + mode broadcast) is Rust-owned.
 *
 * Inverts the former `doom-exit-button` suite: where it once asserted the
 * phase-gated exit affordance, this asserts the affordance and every other mode
 * control are ABSENT, and that the React layer never wires an exit/close path.
 *
 * Spec #3026 ST-6 additionally pins the raw-RGBA draw path (`doom_frame_raw` →
 * `putImageData`) and the retirement of the PNG-over-poll `doom_frame` path.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { adapterBridge } from '@/shared/utils/adapterBridge';
import * as doomTypes from '../types';
import { DoomWindow } from '../DoomWindow';

const { DOOM_FRAME_DRAW_MS, DOOM_FRAME_HEIGHT, DOOM_FRAME_WIDTH } = doomTypes;

/**
 * jsdom (24) has no `ImageData`; the WebView2 does. This minimal constructor
 * lets the raw-RGBA draw path execute in tests — the assertion is on the
 * component's use of the platform API, not on the platform class itself.
 */
class TestImageData {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  constructor(data: Uint8ClampedArray, width: number, height: number) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
}

let putImageData: ReturnType<typeof vi.fn>;

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
    case 'doom_frame_raw':
      frameCalls += 1;
      return new ArrayBuffer(DOOM_FRAME_WIDTH * DOOM_FRAME_HEIGHT * 4);
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
  // The raw-RGBA draw path: jsdom has no `ImageData` and no real 2D context, so
  // stub both to drive the component's putImageData call.
  putImageData = vi.fn();
  vi.stubGlobal('ImageData', TestImageData);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => ({ putImageData } as unknown as CanvasRenderingContext2D),
  );
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

describe('Spec #3026 ST-6 — raw-RGBA draw path retires PNG-over-poll', () => {
  it('draws the raw framebuffer via putImageData at the 320×200 backing store', async () => {
    await renderReady();
    emitMode(modeStatus({ phase: 'active', active: true, voiceSuppressed: true, origin: 'code' }));
    await waitFor(() => expect(putImageData).toHaveBeenCalled());

    // `putImageData` ignores CSS scaling/DPR — the backing store is the framebuffer.
    const canvas = screen.getByTestId('doom-frame-canvas') as HTMLCanvasElement;
    expect(canvas.width).toBe(DOOM_FRAME_WIDTH);
    expect(canvas.height).toBe(DOOM_FRAME_HEIGHT);

    const image = putImageData.mock.calls[0][0] as {
      width: number;
      height: number;
      data: Uint8ClampedArray;
    };
    expect(image.width).toBe(DOOM_FRAME_WIDTH);
    expect(image.height).toBe(DOOM_FRAME_HEIGHT);
    expect(image.data.length).toBe(DOOM_FRAME_WIDTH * DOOM_FRAME_HEIGHT * 4);
    expect(putImageData.mock.calls[0][1]).toBe(0);
    expect(putImageData.mock.calls[0][2]).toBe(0);
  });

  it('drives doom_frame_raw and never the retired PNG-over-poll doom_frame', async () => {
    await renderReady();
    await waitFor(() => expect(frameCalls).toBeGreaterThan(0));
    const commands = invoke.mock.calls.map(([command]) => command);
    expect(commands).toContain('doom_frame_raw');
    expect(commands).not.toContain('doom_frame');
  });

  it('retires DOOM_FRAME_POLL_MS and pins DOOM_FRAME_DRAW_MS (~30 fps)', () => {
    expect(DOOM_FRAME_DRAW_MS).toBe(33);
    expect('DOOM_FRAME_POLL_MS' in doomTypes).toBe(false);
  });

  it('the draw path is raw RGBA — no PNG, base64, or data-URI source remains', () => {
    const source = stripComments(
      readFileSync(resolve(process.cwd(), 'src/applications/doom/DoomWindow.tsx'), 'utf8'),
    );
    expect(source).toMatch(/putImageData/);
    expect(source).toMatch(/'doom_frame_raw'/);
    expect(source).not.toMatch(/data:image\/png/);
    expect(source).not.toMatch(/pngBase64/);
    expect(source).not.toMatch(/'doom_frame'/);
    expect(source).not.toMatch(/DOOM_FRAME_POLL_MS/);
  });
});
