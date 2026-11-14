/**
 * ServerLaunchStepCard (#2857; engine-start card since #3141 ST-6) — lifecycle
 * contract for the Companion setup wizard's `serverLaunch` step.
 *
 * Proves, without a Tauri host:
 *   1. notRunning → `missing` + "Not running" + an enabled Start control;
 *   2. starting → `running`, an indeterminate phase region narrating named
 *      engine phases, a disabled + `aria-busy` Start button;
 *   3. THE WATCHDOG IS A WAIT AFFORDANCE ONLY — after `LAUNCH_WATCHDOG_MS` the
 *      card STAYS `starting` (never `failed`) and Retry becomes available;
 *   4. failed → `error` + "Failed to start" + the typed failure row
 *      (`companion-engine-error` + `data-engine-code`) + Retry + focus on the
 *      error group;
 *   5. every typed engine code gets its DISTINCT title (AC-25);
 *   6. exited → `error` + "Engine stopped" + the Start affordance;
 *   7. healthy → `installed` + "Running" + the `Engine ready · <modelId>` detail.
 *
 * The frozen QA hooks are asserted verbatim. Spec #3141 ST-6 (G-411): no
 * assertion was relaxed — every pinned sentence/attribute was re-pointed to the
 * in-process engine wording.
 */

import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import {
  ServerLaunchStepCard,
  LAUNCH_WATCHDOG_MS,
} from '@/shared/components/companion/ServerLaunchStepCard';
import { COMPANION_SETUP_STEPS } from '@/shared/components/companion/companionSetupSteps';
import {
  engineFailureCopy,
  SERVER_EXITED_COPY,
  SERVER_WATCHDOG_COPY,
  type CompanionEngineErrorCode,
  type ServerLaunchState,
} from '@/shared/components/companion/companionReadiness';

const step = COMPANION_SETUP_STEPS.find((s) => s.id === 'serverLaunch')!;

interface RenderOptions {
  serverState?: ServerLaunchState;
  uiState?: 'checking' | 'missing' | 'running' | 'installed' | 'error';
  serverCode?: CompanionEngineErrorCode | null;
  backend?: 'cpu' | 'gpu' | 'integratedGpu' | 'accel' | 'meta' | null;
  modelId?: string | null;
  errorText?: string;
  detail?: string;
}

function renderCard(options: RenderOptions = {}) {
  const onRunAction = vi.fn();
  const onRecheck = vi.fn();
  const utils = renderWithChakra(
    <ServerLaunchStepCard
      step={step}
      uiState={options.uiState ?? 'missing'}
      detail={options.detail}
      errorText={options.errorText}
      serverState={options.serverState ?? 'notRunning'}
      serverCode={options.serverCode ?? null}
      backend={options.backend ?? null}
      modelId={options.modelId ?? null}
      onRunAction={onRunAction}
      onRecheck={onRecheck}
    />,
  );
  return { ...utils, onRunAction, onRecheck };
}

const stepRow = () => screen.getByTestId('companion-step-server-launch');

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ServerLaunchStepCard (#2857 / #3141)', () => {
  it('renders notRunning with "Not running" and an enabled Start control', () => {
    const { onRunAction } = renderCard({ serverState: 'notRunning' });

    expect(stepRow()).toHaveAttribute('data-state', 'missing');
    expect(stepRow()).toHaveAttribute('data-server-state', 'notRunning');
    expect(screen.getByTestId('companion-step-server-launch-status')).toHaveTextContent(
      'Not running',
    );

    const start = screen.getByTestId('companion-step-server-launch-start');
    expect(start).toHaveTextContent('Start companion engine');
    expect(start).not.toBeDisabled();
    expect(screen.getByTestId('companion-step-server-launch-recheck')).toBeInTheDocument();

    fireEvent.click(start);
    expect(onRunAction).toHaveBeenCalledWith('serverLaunch');
  });

  it('narrates named phases while starting with an indeterminate indicator and no failure state', () => {
    vi.useFakeTimers();
    renderCard({ serverState: 'starting', uiState: 'running' });

    expect(stepRow()).toHaveAttribute('data-state', 'running');
    expect(stepRow()).toHaveAttribute('data-server-state', 'starting');
    expect(screen.getByTestId('companion-step-server-launch-status')).toHaveTextContent(
      'Starting…',
    );
    expect(screen.getByTestId('companion-step-server-launch-phase')).toBeInTheDocument();
    expect(screen.getByLabelText('Companion engine startup progress')).toBeInTheDocument();

    const start = screen.getByTestId('companion-step-server-launch-start');
    expect(start).toBeDisabled();
    expect(start).toHaveAttribute('aria-busy', 'true');

    expect(screen.getByText('Preparing the engine…')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(900);
    });
    expect(screen.getByText('Loading the model into memory…')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(900);
    });
    expect(screen.getByText('Warming up the engine…')).toBeInTheDocument();

    // Never failure copy while starting.
    expect(screen.queryByTestId('companion-engine-error')).toBeNull();
  });

  it('watchdog is a wait affordance only: stays starting, never failure copy, Retry enabled', () => {
    vi.useFakeTimers();
    const { onRunAction } = renderCard({ serverState: 'starting', uiState: 'running' });

    // Pre-watchdog: no Retry.
    expect(screen.queryByTestId('companion-step-server-launch-retry')).toBeNull();

    act(() => {
      vi.advanceTimersByTime(LAUNCH_WATCHDOG_MS + 1);
    });

    // Still starting — the watchdog NEVER transitions to failed.
    expect(stepRow()).toHaveAttribute('data-server-state', 'starting');
    expect(stepRow()).toHaveAttribute('data-state', 'running');
    expect(screen.getByTestId('companion-step-server-launch-status')).toHaveTextContent(
      'Starting…',
    );
    expect(screen.queryByTestId('companion-engine-error')).toBeNull();
    expect(screen.getByText(SERVER_WATCHDOG_COPY)).toBeInTheDocument();

    const retry = screen.getByTestId('companion-step-server-launch-retry');
    expect(retry).not.toBeDisabled();
    fireEvent.click(retry);
    expect(onRunAction).toHaveBeenCalledWith('serverLaunch');
  });

  it('surfaces the typed engine failure row with Retry + focus on the error group', () => {
    const { onRunAction } = renderCard({
      serverState: 'failed',
      uiState: 'error',
      serverCode: 'gpuUnavailable',
      errorText: 'raw backend detail',
    });

    expect(stepRow()).toHaveAttribute('data-state', 'error');
    expect(stepRow()).toHaveAttribute('data-server-state', 'failed');
    expect(screen.getByTestId('companion-step-server-launch-status')).toHaveTextContent(
      'Failed to start',
    );

    // AC-25 — the typed failure row + its additive attribute.
    const failure = screen.getByTestId('companion-engine-error');
    expect(failure).toHaveAttribute('data-engine-code', 'gpuUnavailable');
    expect(failure).toHaveTextContent('No usable GPU');
    expect(failure).toHaveTextContent(engineFailureCopy('gpuUnavailable').sentence);

    // The raw backend detail is demoted to the labelled mono line.
    expect(screen.getByTestId('companion-step-server-launch-detail')).toHaveTextContent(
      'raw backend detail',
    );

    const errorGroup = screen.getByRole('group', { name: 'Companion engine error' });
    expect(document.activeElement).toBe(errorGroup);

    const retry = screen.getByTestId('companion-step-server-launch-retry');
    expect(retry).toHaveTextContent('Retry');
    fireEvent.click(retry);
    expect(onRunAction).toHaveBeenCalledWith('serverLaunch');
    expect(screen.getByTestId('companion-step-server-launch-recheck')).toBeInTheDocument();
  });

  it('gives every typed engine code its own distinct title (AC-25)', () => {
    const codes: CompanionEngineErrorCode[] = [
      'gpuUnavailable',
      'backendInitFailed',
      'modelMissing',
      'modelLoadFailed',
      'mtpInitFailed',
      'mmprojInitFailed',
      'contextCreateFailed',
      'busy',
      'startTimeout',
    ];
    const titles = new Set<string>();
    for (const code of codes) {
      cleanup();
      renderCard({ serverState: 'failed', uiState: 'error', serverCode: code });
      const failure = screen.getByTestId('companion-engine-error');
      expect(failure).toHaveAttribute('data-engine-code', code);
      expect(failure).toHaveTextContent(engineFailureCopy(code).title);
      titles.add(engineFailureCopy(code).title);
    }
    expect(titles.size).toBe(codes.length);
  });

  it('omits data-engine-code (never the string "null") when the failure carries no code', () => {
    renderCard({ serverState: 'failed', uiState: 'error', serverCode: null });
    const failure = screen.getByTestId('companion-engine-error');
    expect(failure).not.toHaveAttribute('data-engine-code');
    expect(failure).toHaveTextContent("Couldn't start the engine");
  });

  it('renders the exited lifecycle with the Start affordance', () => {
    renderCard({ serverState: 'exited', uiState: 'error' });

    expect(stepRow()).toHaveAttribute('data-state', 'error');
    expect(stepRow()).toHaveAttribute('data-server-state', 'exited');
    expect(screen.getByTestId('companion-step-server-launch-status')).toHaveTextContent(
      'Engine stopped',
    );
    expect(screen.getByTestId('companion-step-server-launch-detail')).toHaveTextContent(
      SERVER_EXITED_COPY,
    );
    expect(screen.getByTestId('companion-step-server-launch-start')).toHaveTextContent(
      'Start companion engine',
    );
  });

  it('reads healthy as installed with the engine-ready detail and no Start control', () => {
    const { onRecheck } = renderCard({
      serverState: 'healthy',
      uiState: 'installed',
      modelId: 'gemma-4-E2B-it-qat-UD-Q4_K_XL',
      backend: 'cpu',
    });

    expect(stepRow()).toHaveAttribute('data-state', 'installed');
    expect(stepRow()).toHaveAttribute('data-server-state', 'healthy');
    expect(screen.getByTestId('companion-step-server-launch-status')).toHaveTextContent(
      'Running',
    );
    expect(screen.queryByTestId('companion-step-server-launch-start')).toBeNull();
    expect(screen.queryByTestId('companion-step-server-launch-retry')).toBeNull();
    expect(screen.getByTestId('companion-step-server-launch-detail')).toHaveTextContent(
      'Engine ready · gemma-4-E2B-it-qat-UD-Q4_K_XL · CPU',
    );

    fireEvent.click(screen.getByTestId('companion-step-server-launch-recheck'));
    expect(onRecheck).toHaveBeenCalledTimes(1);
  });
});
