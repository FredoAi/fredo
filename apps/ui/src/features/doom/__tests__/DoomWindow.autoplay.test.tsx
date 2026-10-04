/**
 * Spec #2969 ST-7 — the Doom-window autoplay control + live status ("watch").
 *
 * Drives the REAL `DoomWindow` against a mocked Tauri command surface
 * (`adapterBridge`) and a mocked `doom-status-changed` / `doom-autoplay-changed`
 * event channel, so the DOM contract is provable without a Tauri host.
 *
 * Covers the four owned hooks (`doom-autoplay-toggle`, `doom-autoplay-status`,
 * `doom-autoplay-stop`, the additive `doom-autoplay-error`), all five
 * `DoomAutoplayPhase` renderings, the `code -> human copy` mapping, and the
 * binding AC-UI-1..11 clauses.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { adapterBridge } from '@/shared/utils/adapterBridge';
import type { DoomAutoplayStatus } from '../types';
import { DoomWindow } from '../DoomWindow';

const listeners: Record<string, (payload: unknown) => void> = {};

let launchResult: unknown;
let autoplaySnapshot: DoomAutoplayStatus | undefined;
let startResult: unknown;
let startCalls = 0;
let stopCalls = 0;
let frameCalls = 0;
let deferStart = false;
let resolveStart: ((value: unknown) => void) | null = null;
let deferStop = false;
let resolveStop: (() => void) | null = null;
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
      return undefined;
    case 'get_doom_autoplay_status':
      if (deferStatus) {
        return new Promise((res) => {
          resolveStatus = res;
        });
      }
      return autoplaySnapshot;
    case 'start_doom_autoplay':
      startCalls += 1;
      if (deferStart) {
        return new Promise((res) => {
          resolveStart = res;
        });
      }
      return startResult;
    case 'stop_doom_autoplay':
      stopCalls += 1;
      if (deferStop) {
        return new Promise<void>((res) => {
          resolveStop = () => res();
        });
      }
      return undefined;
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
    ...overrides,
  };
}

async function renderReady() {
  renderWithChakra(<DoomWindow />);
  await waitFor(() => expect(screen.getByTestId('doom-status')).toHaveTextContent('Ready'));
  await waitFor(() =>
    expect(listeners['doom-autoplay-changed']).toBeTypeOf('function'),
  );
}

function emitAutoplay(next: DoomAutoplayStatus) {
  act(() => {
    listeners['doom-autoplay-changed']?.(next);
  });
}

/** Strip block + line comments so doc prose cannot satisfy the AC-UI-11 pin. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function readUiSource(relative: string): string {
  return stripComments(readFileSync(resolve(process.cwd(), relative), 'utf8'));
}

beforeEach(() => {
  for (const key of Object.keys(listeners)) delete listeners[key];
  launchResult = { success: true, phase: 'ready', port: 6666, pid: 42, enginePath: 'engine' };
  autoplaySnapshot = undefined;
  startResult = { success: true, phase: 'running', steps: 0, code: null, error: null };
  startCalls = 0;
  stopCalls = 0;
  frameCalls = 0;
  deferStart = false;
  resolveStart = null;
  deferStop = false;
  resolveStop = null;
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

describe('Spec #2969 ST-7 — Doom window autoplay control + status', () => {
  it('renders the four owned hooks in the idle state', async () => {
    await renderReady();

    expect(screen.getByTestId('doom-autoplay-toggle')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('doom-autoplay-status')).toHaveTextContent('Autoplay off');
    expect(screen.queryByTestId('doom-autoplay-stop')).toBeNull();
    expect(screen.queryByTestId('doom-autoplay-error')).toBeNull();
  });

  it('renders every DoomAutoplayPhase per the state table', async () => {
    await renderReady();
    const startedAt = new Date().toISOString();

    // idle
    expect(screen.getByTestId('doom-autoplay-status')).toHaveTextContent('Autoplay off');
    expect(screen.getByTestId('doom-autoplay-toggle')).toHaveAttribute('aria-pressed', 'false');

    // running
    emitAutoplay(
      autoplayStatus({
        phase: 'running',
        running: true,
        steps: 42,
        decisions: 42,
        lastTic: 42,
        outcome: 'alive',
        startedAt,
      }),
    );
    expect(screen.getByTestId('doom-autoplay-toggle')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('doom-autoplay-status')).toHaveTextContent(
      'Autoplay · step 42 · tic 42 · alive',
    );
    expect(screen.getByTestId('doom-autoplay-stop')).toBeInTheDocument();
    expect(screen.getByTestId('doom-step-button')).toBeDisabled();

    // stopping
    emitAutoplay(
      autoplayStatus({
        phase: 'stopping',
        running: true,
        steps: 42,
        lastTic: 42,
        outcome: 'alive',
        startedAt,
      }),
    );
    expect(screen.getByTestId('doom-autoplay-status')).toHaveTextContent('Stopping autoplay…');
    expect(screen.getByTestId('doom-autoplay-stop')).toBeInTheDocument();
    expect(screen.getByTestId('doom-autoplay-toggle')).toBeDisabled();

    // completed
    emitAutoplay(autoplayStatus({ phase: 'completed', steps: 42, outcome: 'exited' }));
    expect(screen.getByTestId('doom-autoplay-status')).toHaveTextContent(
      'Autoplay complete · 42 steps · exited',
    );
    expect(screen.queryByTestId('doom-autoplay-stop')).toBeNull();
    expect(screen.getByTestId('doom-autoplay-toggle')).toHaveAttribute('aria-pressed', 'false');

    // failed
    emitAutoplay(
      autoplayStatus({
        phase: 'failed',
        steps: 42,
        code: 'decisionFailed',
        lastError: 'boom',
      }),
    );
    expect(screen.getByTestId('doom-autoplay-status')).toHaveTextContent(
      'Autoplay failed · 42 steps',
    );
    expect(screen.getByTestId('doom-autoplay-error')).toBeInTheDocument();
  });

  it('maps every DoomAutoplayErrorCode to its human copy', async () => {
    await renderReady();
    const cases: Array<[DoomAutoplayStatus['code'], string]> = [
      ['notReady', 'Engine not ready'],
      ['decisionFailed', 'Companion stalled'],
      ['engineRequestFailed', 'Lost contact'],
      ['budgetExhausted', 'Run finished'],
    ];
    for (const [code, title] of cases) {
      emitAutoplay(
        autoplayStatus({ phase: 'failed', steps: 1, code, lastError: 'detail' }),
      );
      const box = screen.getByTestId('doom-autoplay-error');
      expect(within(box).getByText(title)).toBeInTheDocument();
    }
  });

  it('AC-UI-1: the status line is single-line, ellipsised, and carries the full title', async () => {
    await renderReady();
    emitAutoplay(
      autoplayStatus({
        phase: 'running',
        running: true,
        steps: 1,
        lastTic: 1,
        outcome: 'a-very-long-outcome-value-that-must-not-wrap-the-toolbar',
        startedAt: new Date().toISOString(),
      }),
    );
    const line = screen.getByTestId('doom-autoplay-status');
    const style = getComputedStyle(line);
    expect(style.whiteSpace).toBe('nowrap');
    expect(style.overflow).toBe('hidden');
    expect(style.textOverflow).toBe('ellipsis');
    expect(line.getAttribute('title')).toContain('Autoplay · step 1');
  });

  it('AC-UI-2: truncates lastError to <= 120 chars, title keeps the full text', async () => {
    await renderReady();
    const long = 'E'.repeat(300);
    emitAutoplay(
      autoplayStatus({
        phase: 'failed',
        steps: 3,
        code: 'engineRequestFailed',
        lastError: long,
      }),
    );
    const box = screen.getByTestId('doom-autoplay-error');
    const detail = within(box).getByText(/^E+…$/);
    expect(detail.textContent?.length).toBeLessThanOrEqual(120);
    expect(detail).toHaveAttribute('title', long);
  });

  it('AC-UI-3: status is a polite live region; failure is a separate assertive alert', async () => {
    await renderReady();
    const line = screen.getByTestId('doom-autoplay-status');
    expect(line).toHaveAttribute('role', 'status');
    expect(line).toHaveAttribute('aria-live', 'polite');
    expect(line).toHaveAttribute('aria-atomic', 'true');
    expect(screen.queryByTestId('doom-autoplay-error')).toBeNull();

    emitAutoplay(
      autoplayStatus({ phase: 'failed', steps: 1, code: 'decisionFailed', lastError: 'x' }),
    );
    const error = screen.getByTestId('doom-autoplay-error');
    expect(error).toHaveAttribute('role', 'alert');
    expect(error).not.toHaveAttribute('aria-live');
  });

  it('AC-UI-4: renders base-10 integers and an em dash for a null lastTic', async () => {
    await renderReady();
    emitAutoplay(
      autoplayStatus({
        phase: 'running',
        running: true,
        steps: 1000,
        lastTic: null,
        outcome: 'alive',
        startedAt: new Date().toISOString(),
      }),
    );
    const line = screen.getByTestId('doom-autoplay-status');
    expect(line).toHaveTextContent('step 1000');
    expect(line).toHaveTextContent('tic —');
    expect(line.textContent ?? '').not.toMatch(/1,000|1 000|1000\.0/);
  });

  it('AC-UI-5: status is event-driven — one hydration invoke, never a poll', async () => {
    await renderReady();
    const hydrationCalls = () =>
      invoke.mock.calls.filter(([command]) => command === 'get_doom_autoplay_status').length;
    expect(hydrationCalls()).toBe(1);

    emitAutoplay(
      autoplayStatus({
        phase: 'running',
        running: true,
        steps: 7,
        lastTic: 7,
        outcome: 'alive',
        startedAt: new Date().toISOString(),
      }),
    );
    emitAutoplay(autoplayStatus({ phase: 'completed', steps: 9, outcome: 'exited' }));

    expect(screen.getByTestId('doom-autoplay-status')).toHaveTextContent(
      'Autoplay complete · 9 steps · exited',
    );
    expect(hydrationCalls()).toBe(1);
  });

  it('AC-UI-6: the frame loop keeps polling while autoplay runs', async () => {
    await renderReady();
    expect(screen.getByTestId('doom-frame-canvas')).toHaveAttribute('role', 'img');

    frameCalls = 0;
    emitAutoplay(
      autoplayStatus({
        phase: 'running',
        running: true,
        steps: 1,
        lastTic: 1,
        outcome: 'alive',
        startedAt: new Date().toISOString(),
      }),
    );
    await waitFor(() => expect(frameCalls).toBeGreaterThan(0));
  });

  it('AC-UI-7: the elapsed m:ss ticker refreshes while running and clears otherwise', async () => {
    await renderReady();
    emitAutoplay(
      autoplayStatus({
        phase: 'running',
        running: true,
        steps: 1,
        lastTic: 1,
        outcome: 'alive',
        startedAt: new Date(Date.now() - 5000).toISOString(),
      }),
    );
    const elapsed = await screen.findByTestId('doom-autoplay-elapsed');
    const initial = elapsed.textContent ?? '';
    expect(initial).toMatch(/^\d+:\d{2}$/);
    await waitFor(() => expect(elapsed.textContent).not.toBe(initial), { timeout: 4000 });

    // Cleared on any non-running phase.
    emitAutoplay(autoplayStatus({ phase: 'completed', steps: 1 }));
    expect(screen.queryByTestId('doom-autoplay-elapsed')).toBeNull();

    // An unparseable startedAt renders no ticker (never throws).
    emitAutoplay(
      autoplayStatus({ phase: 'running', running: true, startedAt: 'not-a-date' }),
    );
    expect(screen.queryByTestId('doom-autoplay-elapsed')).toBeNull();
  });

  it('AC-UI-8: the manual Step is disabled while autoplay runs or stops', async () => {
    await renderReady();
    expect(screen.getByTestId('doom-step-button')).toBeEnabled();

    emitAutoplay(
      autoplayStatus({ phase: 'running', running: true, startedAt: new Date().toISOString() }),
    );
    expect(screen.getByTestId('doom-step-button')).toBeDisabled();

    emitAutoplay(
      autoplayStatus({ phase: 'stopping', running: true, startedAt: new Date().toISOString() }),
    );
    expect(screen.getByTestId('doom-step-button')).toBeDisabled();

    emitAutoplay(autoplayStatus({ phase: 'completed', steps: 1 }));
    expect(screen.getByTestId('doom-step-button')).toBeEnabled();
  });

  it('AC-UI-9: a window opened mid-run hydrates from get_doom_autoplay_status', async () => {
    autoplaySnapshot = autoplayStatus({
      phase: 'running',
      running: true,
      steps: 42,
      lastTic: 42,
      outcome: 'alive',
      startedAt: new Date().toISOString(),
    });
    await renderReady();

    await waitFor(() =>
      expect(screen.getByTestId('doom-autoplay-status')).toHaveTextContent('step 42'),
    );
    expect(screen.getByTestId('doom-autoplay-toggle')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('doom-autoplay-stop')).toBeInTheDocument();
  });

  it('AC-UI-9: a concurrent event is not clobbered by the mount seed (first-wins)', async () => {
    deferStatus = true;
    await renderReady();

    emitAutoplay(
      autoplayStatus({
        phase: 'running',
        running: true,
        steps: 7,
        lastTic: 7,
        outcome: 'alive',
        startedAt: new Date().toISOString(),
      }),
    );
    act(() => {
      resolveStatus?.(
        autoplayStatus({
          phase: 'running',
          running: true,
          steps: 99,
          lastTic: 99,
          outcome: 'alive',
          startedAt: new Date().toISOString(),
        }),
      );
    });

    await waitFor(() =>
      expect(screen.getByTestId('doom-autoplay-status')).toHaveTextContent('step 7'),
    );
    expect(screen.getByTestId('doom-autoplay-status')).not.toHaveTextContent('step 99');
  });

  it('AC-UI-10: re-entry guards ignore a double start and a double stop', async () => {
    await renderReady();

    deferStart = true;
    const toggle = screen.getByTestId('doom-autoplay-toggle');
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(startCalls).toBe(1);
    act(() => {
      resolveStart?.({ success: true, phase: 'running', steps: 0, code: null, error: null });
    });
    await waitFor(() => expect(screen.getByTestId('doom-autoplay-toggle')).toBeEnabled());

    emitAutoplay(
      autoplayStatus({ phase: 'running', running: true, startedAt: new Date().toISOString() }),
    );
    deferStop = true;
    fireEvent.click(screen.getByTestId('doom-autoplay-toggle'));
    fireEvent.click(screen.getByTestId('doom-autoplay-toggle'));
    expect(stopCalls).toBe(1);
    act(() => resolveStop?.());
  });

  it('AC-UI-11: the ST-7 UI code contains no hardcoded hex or rgba()', () => {
    for (const relative of [
      'src/features/doom/DoomWindow.tsx',
      'src/features/doom/types.ts',
    ]) {
      const source = readUiSource(relative);
      expect(source, `${relative} must not hardcode a hex color`).not.toMatch(
        /#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/,
      );
      expect(source, `${relative} must not hardcode rgba()`).not.toMatch(/\brgba\(/);
    }
  });
});
