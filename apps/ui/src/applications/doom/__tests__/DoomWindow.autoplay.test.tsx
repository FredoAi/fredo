/**
 * Spec #3007 ST-1 — the Doom window is the game and nothing else, and it plays
 * itself.
 *
 * Drives the REAL `DoomWindow` against a mocked Tauri command surface
 * (`adapterBridge`) and mocked `doom-status-changed` / `doom-autoplay-changed` /
 * `doom-mode-changed` channels.
 *
 * Covers: the game-only surface (DOM-absence of all 19 removed hooks, AC1/R-1.a),
 * the minimal transient states (R-1.b), the entry auto-play guarantee against the
 * SAME idempotent `start_doom_autoplay` with no `freshStart` (R-3.b/R-3.c), and
 * the minimal `doom-autoplay-note` (AC5/R-5).
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { adapterBridge } from '@/shared/utils/adapterBridge';
import type { DoomAutoplayStatus } from '../types';
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

let launchResult: unknown;
let modeSeed: unknown;
let autoplaySnapshot: DoomAutoplayStatus | undefined;
let startResult: unknown;
let startCalls = 0;
let frameCalls = 0;
let frameShouldFail = false;
let statusHydrations = 0;
let deferStatus = false;
let resolveStatus: ((value: unknown) => void) | null = null;

const invoke = vi.fn(async (command: string, _args?: Record<string, unknown>) => {
  switch (command) {
    case 'launch_doom_runtime':
      return launchResult;
    case 'doom_read_state':
      return { raw: { tic: 1, outcome: 'alive' } };
    case 'doom_frame':
      frameCalls += 1;
      return frameShouldFail ? undefined : { pngBase64: 'AAAA' };
    case 'get_doom_mode_status':
      return modeSeed;
    case 'get_doom_autoplay_status':
      statusHydrations += 1;
      if (deferStatus) {
        return new Promise((res) => {
          resolveStatus = res;
        });
      }
      return autoplaySnapshot;
    case 'start_doom_autoplay':
      startCalls += 1;
      return startResult;
    default:
      return undefined;
  }
});

function autoplayStatus(overrides: Partial<DoomAutoplayStatus>): DoomAutoplayStatus {
  return {
    phase: 'idle',
    running: false,
    steps: 0,
    decisions: 0,
    failures: 0,
    consecutiveFailures: 0,
    lastTic: null,
    outcome: null,
    startedAt: null,
    lastError: null,
    code: null,
    episode: null,
    map: null,
    completed: false,
    ...overrides,
  };
}

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

/** Render and wait until the runtime reached `ready` (the frame loop is live). */
async function renderReady(): Promise<void> {
  renderWithChakra(<DoomWindow />);
  await waitFor(() => expect(frameCalls).toBeGreaterThan(0));
  await waitFor(() => expect(listeners['doom-autoplay-changed']).toBeTypeOf('function'));
}

function emitAutoplay(next: DoomAutoplayStatus): void {
  act(() => {
    listeners['doom-autoplay-changed']?.(next);
  });
}

function emitStatus(next: Record<string, unknown>): void {
  act(() => {
    listeners['doom-status-changed']?.(next);
  });
}

/** Strip block + line comments so doc prose cannot satisfy a source pin. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function readUiSource(relative: string): string {
  return stripComments(readFileSync(resolve(process.cwd(), relative), 'utf8'));
}

beforeEach(() => {
  for (const key of Object.keys(listeners)) delete listeners[key];
  launchResult = { success: true, phase: 'ready', port: 6666, pid: 42, enginePath: 'engine' };
  modeSeed = modeStatus({});
  autoplaySnapshot = undefined;
  startResult = { success: true, phase: 'running', steps: 0, code: null, error: null };
  startCalls = 0;
  frameCalls = 0;
  frameShouldFail = false;
  statusHydrations = 0;
  deferStatus = false;
  resolveStatus = null;
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

describe('Spec #3007 ST-1 — Doom window: game-only surface', () => {
  it('AC1/R-1.a: renders the game view and NONE of the removed instrumentation hooks', async () => {
    await renderReady();

    for (const hook of REMOVED_HOOKS) {
      // DOM-absence, not display:none (G-170 reverse).
      expect(screen.queryByTestId(hook), `${hook} must not render`).toBeNull();
    }
    // No in-window controls at all in the ready state (zero buttons).
    expect(screen.queryAllByRole('button')).toHaveLength(0);

    // The kept game view.
    expect(screen.getByTestId('doom-root')).toBeInTheDocument();
    const canvas = screen.getByTestId('doom-frame-canvas');
    expect(canvas).toHaveAttribute('role', 'img');
    expect(canvas).toHaveAttribute('aria-label', 'Doom game view');
    expect(canvas).toHaveAttribute('aria-describedby', 'doom-frame-desc');
    expect(screen.getByTestId('doom-frame-desc')).toBeInTheDocument();
  });

  it('R-1.b: idle collapses into a polite Starting overlay — never a start control / black void', async () => {
    renderWithChakra(<DoomWindow />);
    // Before the async launch settles the honest visual is Starting, not a button.
    const starting = screen.getByText('Starting…').closest('[role="status"]');
    expect(starting).not.toBeNull();
    expect(starting).toHaveAttribute('aria-live', 'polite');
    expect(starting).toHaveAttribute('aria-atomic', 'true');
    expect(screen.queryByTestId('doom-start-button')).toBeNull();
    // Let the mount effects settle while the adapter is still registered.
    await waitFor(() => expect(listeners['doom-status-changed']).toBeTypeOf('function'));
  });

  it('R-1.b: the stopping overlay and the reconnecting note are polite live regions', async () => {
    await renderReady();
    emitStatus({ phase: 'stopping' });
    const stopping = screen.getByText('Stopping…').closest('[role="status"]');
    expect(stopping).not.toBeNull();
    expect(stopping).toHaveAttribute('aria-live', 'polite');
  });

  it('R-1.b: a dropped frame shows the reconnecting note and keeps the canvas', async () => {
    frameShouldFail = true;
    await renderReady();
    const note = await screen.findByTestId('doom-frame-reconnecting');
    expect(note).toHaveAttribute('role', 'status');
    expect(note).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByTestId('doom-frame-canvas')).toBeInTheDocument();
  });
});

describe('Spec #3007 ST-1 — entry auto-play guarantee', () => {
  beforeEach(() => {
    modeSeed = modeStatus({ phase: 'active', active: true, voiceSuppressed: true, origin: 'code' });
  });

  it('R-3.b/R-3.c: on ready while engaged, invokes the SAME start_doom_autoplay with NO freshStart', async () => {
    await renderReady();
    await waitFor(() => expect(startCalls).toBe(1));

    const call = invoke.mock.calls.find(([command]) => command === 'start_doom_autoplay');
    expect(call).toBeDefined();
    // Resume-by-default: no `freshStart` argument leaks into the invoke.
    expect(call?.[1]).toBeUndefined();
    expect(JSON.stringify(call?.[1] ?? null)).not.toContain('freshStart');
  });

  it('R-3.b: never invokes a parallel command and starts at most once per ready episode', async () => {
    await renderReady();
    await waitFor(() => expect(startCalls).toBe(1));

    // A later idle status must NOT re-trigger the repair (no loop).
    emitAutoplay(autoplayStatus({ phase: 'idle' }));
    emitAutoplay(autoplayStatus({ phase: 'idle' }));
    expect(startCalls).toBe(1);
    expect(
      invoke.mock.calls.filter(([command]) => command === 'start_doom_autoplay'),
    ).toHaveLength(1);
  });

  it('R-3.b: does not start when a run is already active/stopping', async () => {
    autoplaySnapshot = autoplayStatus({
      phase: 'running',
      running: true,
      startedAt: new Date().toISOString(),
    });
    await renderReady();
    await waitFor(() => expect(statusHydrations).toBeGreaterThan(0));
    await waitFor(() => expect(frameCalls).toBeGreaterThan(1));
    expect(startCalls).toBe(0);
  });

  it('R-3.b: does not start when the run has already completed', async () => {
    autoplaySnapshot = autoplayStatus({ phase: 'completed', steps: 9, outcome: 'exited' });
    await renderReady();
    await waitFor(() => expect(statusHydrations).toBeGreaterThan(0));
    await waitFor(() => expect(frameCalls).toBeGreaterThan(1));
    expect(startCalls).toBe(0);
  });

  it('R-3.b: a direct ?view=doom route (mode inactive) does not auto-start', async () => {
    modeSeed = modeStatus({ phase: 'inactive' });
    await renderReady();
    await waitFor(() => expect(statusHydrations).toBeGreaterThan(0));
    await waitFor(() => expect(frameCalls).toBeGreaterThan(1));
    expect(startCalls).toBe(0);
  });
});

describe('Spec #3007 ST-1 — minimal doom-autoplay-note (AC5/R-5)', () => {
  beforeEach(() => {
    modeSeed = modeStatus({ phase: 'active', active: true, voiceSuppressed: true, origin: 'code' });
  });

  it('maps the run failure to an unobtrusive role=status note (never role=alert / full panel)', async () => {
    await renderReady();
    await waitFor(() => expect(startCalls).toBe(1));

    emitAutoplay(
      autoplayStatus({
        phase: 'failed',
        steps: 3,
        code: 'decisionFailed',
        lastError: 'the companion could not decide',
      }),
    );

    const note = screen.getByTestId('doom-autoplay-note');
    expect(note).toHaveAttribute('role', 'status');
    expect(note).toHaveAttribute('aria-live', 'polite');
    expect(note).toHaveAttribute('aria-atomic', 'true');
    expect(within(note).getByText('Companion stalled')).toBeInTheDocument();
    expect(within(note).getByText('the companion could not decide')).toBeInTheDocument();
    // The removed full-width alert panel must not exist.
    expect(screen.queryByTestId('doom-autoplay-error')).toBeNull();
    // And the canvas keeps rendering behind the note.
    expect(screen.getByTestId('doom-frame-canvas')).toBeInTheDocument();
  });

  it('renders every DoomAutoplayErrorCode human copy, truncating the detail to <= 120 chars', async () => {
    await renderReady();
    await waitFor(() => expect(startCalls).toBe(1));

    const cases: Array<[DoomAutoplayStatus['code'], string]> = [
      ['notReady', 'Engine not ready'],
      ['decisionFailed', 'Companion stalled'],
      ['engineRequestFailed', 'Lost contact'],
      ['budgetExhausted', 'Run finished'],
      ['campaignComplete', 'Campaign complete'],
    ];
    for (const [code, title] of cases) {
      const long = 'E'.repeat(300);
      emitAutoplay(autoplayStatus({ phase: 'failed', steps: 1, code, lastError: long }));
      const note = screen.getByTestId('doom-autoplay-note');
      expect(within(note).getByText(title)).toBeInTheDocument();
      const detail = within(note).getByText(/^E+…$/);
      expect(detail.textContent?.length).toBeLessThanOrEqual(120);
      expect(detail).toHaveAttribute('title', long);
    }
  });
});

describe('Spec #3007 ST-1 — theme tokens', () => {
  it('the ST-1 UI code contains no hardcoded hex or rgba()', () => {
    const source = readUiSource('src/applications/doom/DoomWindow.tsx');
    expect(source, 'DoomWindow.tsx must not hardcode a hex color').not.toMatch(
      /#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/,
    );
    expect(source, 'DoomWindow.tsx must not hardcode rgba()').not.toMatch(/\brgba\(/);
  });
});
