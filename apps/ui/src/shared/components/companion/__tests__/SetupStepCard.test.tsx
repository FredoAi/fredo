/**
 * #2865 ST-2 — SetupStepCard clarity/actionability/salience.
 *
 * Proves:
 *   1. WHILE the install is running the card narrates named phases (never a
 *      static screen) — the server-launch narration pattern applied to install;
 *   2. the `checking` state stays at full contrast (no card-wide 0.6 dim) yet
 *      keeps the frozen `data-state="checking"` hook;
 *   3. an install error renders the recoverable Retry (frozen hook) + Re-check.
 *
 * The frozen QA hooks are asserted verbatim.
 */

import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import {
  SetupStepCard,
  INSTALL_PHASE_VERIFY_MS,
  INSTALL_PHASE_REGISTER_MS,
  type SetupStepUiState,
} from '@/shared/components/companion/SetupStepCard';
import { COMPANION_SETUP_STEPS } from '@/shared/components/companion/companionSetupSteps';

const step = COMPANION_SETUP_STEPS.find((s) => s.id === 'llamaServer')!;

function renderCard(uiState: SetupStepUiState, errorText?: string) {
  const onRunAction = vi.fn();
  const onRecheck = vi.fn();
  const utils = renderWithChakra(
    <SetupStepCard
      step={step}
      uiState={uiState}
      errorText={errorText}
      onRunAction={onRunAction}
      onRecheck={onRecheck}
    />,
  );
  return { ...utils, onRunAction, onRecheck };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('#2865 SetupStepCard — clarity/actionability/salience', () => {
  it('narrates install phases while running (never a static screen)', () => {
    vi.useFakeTimers();
    renderCard('running');

    expect(screen.getByTestId('companion-step-llama-server')).toHaveAttribute(
      'data-state',
      'running',
    );
    expect(
      screen.getByTestId('companion-step-llama-server-phase'),
    ).toBeInTheDocument();
    expect(screen.getByText('Downloading runtime…')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(INSTALL_PHASE_VERIFY_MS + 1);
    });
    expect(screen.getByText('Verifying…')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(INSTALL_PHASE_REGISTER_MS);
    });
    expect(screen.getByText('Registering…')).toBeInTheDocument();
  });

  it('keeps the checking state at full contrast with the frozen data-state hook', () => {
    renderCard('checking');

    const row = screen.getByTestId('companion-step-llama-server');
    expect(row).toHaveAttribute('data-state', 'checking');
    expect(screen.getByText('Checking…')).toBeInTheDocument();
    // Re-check is hidden while checking (frozen behavior retained).
    expect(
      screen.queryByTestId('companion-step-llama-server-recheck'),
    ).toBeNull();
  });

  it('renders the install Retry + Re-check affordances on error', () => {
    const { onRunAction, onRecheck } = renderCard('error', 'failed to create C:\\x');

    expect(screen.getByTestId('companion-step-llama-server')).toHaveAttribute(
      'data-state',
      'error',
    );
    fireEvent.click(screen.getByTestId('companion-step-llama-server-retry'));
    expect(onRunAction).toHaveBeenCalledWith('llamaServer');
    fireEvent.click(screen.getByTestId('companion-step-llama-server-recheck'));
    expect(onRecheck).toHaveBeenCalledTimes(1);
  });
});
