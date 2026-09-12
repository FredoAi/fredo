/**
 * ServerLaunchStepCard (#2857) — lifecycle contract for the Companion setup
 * wizard's `serverLaunch` step (AC2 / AC4).
 *
 * Proves, without a Tauri host:
 *   1. notRunning → `missing` + "Not running" + an enabled Start control;
 *   2. starting → `running`, an indeterminate phase region narrating named
 *      phases, a disabled + `aria-busy` Start button;
 *   3. THE WATCHDOG IS A WAIT AFFORDANCE ONLY — after `LAUNCH_WATCHDOG_MS` the
 *      card STAYS `starting` (never `failed`, never AC4 failure copy) and Retry
 *      becomes available;
 *   4. failed (spawnFailed) → `error` + "Failed to start" + the actionable AC4
 *      copy + Retry + focus on the error group;
 *   5. failed (healthTimeout) → the distinct health-check-timeout copy;
 *   6. exited → `error` + "Server stopped" + the Restart affordance;
 *   7. healthy → `installed` + "Running" + endpoint/config detail, no Start.
 *
 * The frozen QA hooks are asserted verbatim.
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
  SERVER_EXITED_COPY,
  SERVER_WATCHDOG_COPY,
  type LlamaServerLaunchCode,
  type ServerLaunchState,
} from '@/shared/components/companion/companionReadiness';

const step = COMPANION_SETUP_STEPS.find((s) => s.id === 'serverLaunch')!;

interface RenderOptions {
  serverState?: ServerLaunchState;
  uiState?: 'checking' | 'missing' | 'running' | 'installed' | 'error';
  serverPort?: number | null;
  serverCode?: LlamaServerLaunchCode | null;
  errorText?: string;
  resolvedPath?: string | null;
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
      resolvedPath={options.resolvedPath}
      errorText={options.errorText}
      serverState={options.serverState ?? 'notRunning'}
      serverPort={options.serverPort ?? 8080}
      serverCode={options.serverCode ?? null}
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

describe('ServerLaunchStepCard (#2857)', () => {
  it('renders notRunning with "Not running" and an enabled Start control', () => {
    const { onRunAction } = renderCard({ serverState: 'notRunning' });

    expect(stepRow()).toHaveAttribute('data-state', 'missing');
    expect(stepRow()).toHaveAttribute('data-server-state', 'notRunning');
    expect(screen.getByTestId('companion-step-server-launch-status')).toHaveTextContent(
      'Not running',
    );

    const start = screen.getByTestId('companion-step-server-launch-start');
    expect(start).toHaveTextContent('Start companion server');
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
    expect(screen.getByLabelText('Companion server startup progress')).toBeInTheDocument();

    const start = screen.getByTestId('companion-step-server-launch-start');
    expect(start).toBeDisabled();
    expect(start).toHaveAttribute('aria-busy', 'true');

    expect(screen.getByText('Generating launch config…')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(900);
    });
    expect(screen.getByText('Starting llama-server…')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(900);
    });
    expect(
      screen.getByText('Waiting for health check on http://127.0.0.1:8080…'),
    ).toBeInTheDocument();

    // Never AC4 failure copy while starting.
    expect(screen.queryByText(/Couldn't start the companion server/)).toBeNull();
  });

  it('watchdog is a wait affordance only: stays starting, never failure copy, Retry enabled', () => {
    vi.useFakeTimers();
    const { onRunAction } = renderCard({ serverState: 'starting', uiState: 'running' });

    // Pre-watchdog: no Retry.
    expect(screen.queryByTestId('companion-step-server-launch-retry')).toBeNull();

    act(() => {
      vi.advanceTimersByTime(LAUNCH_WATCHDOG_MS + 1);
    });

    // Still starting — the watchdog NEVER transitions to failed/AC4 copy.
    expect(stepRow()).toHaveAttribute('data-server-state', 'starting');
    expect(stepRow()).toHaveAttribute('data-state', 'running');
    expect(screen.getByTestId('companion-step-server-launch-status')).toHaveTextContent(
      'Starting…',
    );
    expect(screen.queryByText(/Couldn't start the companion server/)).toBeNull();
    expect(screen.getByText(SERVER_WATCHDOG_COPY)).toBeInTheDocument();

    const retry = screen.getByTestId('companion-step-server-launch-retry');
    expect(retry).not.toBeDisabled();
    fireEvent.click(retry);
    expect(onRunAction).toHaveBeenCalledWith('serverLaunch');
  });

  it('surfaces the actionable start-failure copy with Retry + focus on the error group', () => {
    const { onRunAction } = renderCard({
      serverState: 'failed',
      uiState: 'error',
      serverCode: 'spawnFailed',
      errorText: 'raw backend detail',
    });

    expect(stepRow()).toHaveAttribute('data-state', 'error');
    expect(stepRow()).toHaveAttribute('data-server-state', 'failed');
    expect(screen.getByTestId('companion-step-server-launch-status')).toHaveTextContent(
      'Failed to start',
    );
    expect(screen.getByTestId('companion-step-server-launch-detail')).toHaveTextContent(
      "Couldn't start the companion server. Check that http://127.0.0.1:8080 is free and llama-server is installed, then choose Retry.",
    );

    const errorGroup = screen.getByRole('group', { name: 'Companion server error' });
    expect(document.activeElement).toBe(errorGroup);

    const retry = screen.getByTestId('companion-step-server-launch-retry');
    expect(retry).toHaveTextContent('Retry');
    fireEvent.click(retry);
    expect(onRunAction).toHaveBeenCalledWith('serverLaunch');
    expect(screen.getByTestId('companion-step-server-launch-recheck')).toBeInTheDocument();
  });

  it('distinguishes a health-check timeout from a spawn failure', () => {
    renderCard({ serverState: 'failed', uiState: 'error', serverCode: 'healthTimeout' });

    expect(screen.getByTestId('companion-step-server-launch-detail')).toHaveTextContent(
      "The companion server started but didn't answer its health check in time. It may still be loading the model — choose Retry to try again.",
    );
  });

  it('renders the exited lifecycle with the Restart affordance', () => {
    renderCard({ serverState: 'exited', uiState: 'error' });

    expect(stepRow()).toHaveAttribute('data-state', 'error');
    expect(stepRow()).toHaveAttribute('data-server-state', 'exited');
    expect(screen.getByTestId('companion-step-server-launch-status')).toHaveTextContent(
      'Server stopped',
    );
    expect(screen.getByTestId('companion-step-server-launch-detail')).toHaveTextContent(
      SERVER_EXITED_COPY,
    );
    expect(screen.getByTestId('companion-step-server-launch-start')).toHaveTextContent(
      'Restart companion server',
    );
  });

  it('reads healthy as installed with endpoint/config detail and no Start control', () => {
    const { onRecheck } = renderCard({
      serverState: 'healthy',
      uiState: 'installed',
      resolvedPath: 'C:\\data\\companion\\llama-server-launch.bat',
    });

    expect(stepRow()).toHaveAttribute('data-state', 'installed');
    expect(stepRow()).toHaveAttribute('data-server-state', 'healthy');
    expect(screen.getByTestId('companion-step-server-launch-status')).toHaveTextContent(
      'Running',
    );
    expect(screen.queryByTestId('companion-step-server-launch-start')).toBeNull();
    expect(screen.queryByTestId('companion-step-server-launch-retry')).toBeNull();
    expect(screen.getByTestId('companion-step-server-launch-detail')).toHaveTextContent(
      'http://127.0.0.1:8080 · C:\\data\\companion\\llama-server-launch.bat',
    );

    fireEvent.click(screen.getByTestId('companion-step-server-launch-recheck'));
    expect(onRecheck).toHaveBeenCalledTimes(1);
  });
});
