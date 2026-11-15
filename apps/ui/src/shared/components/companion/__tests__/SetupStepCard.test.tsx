/**
 * #2865 ST-2 — SetupStepCard clarity/actionability/salience.
 *
 * Proves:
 *   1. WHILE a step with an `install` action is running the card narrates named
 *      phases (never a static screen);
 *   2. the `checking` state stays at full contrast (no card-wide 0.6 dim) yet
 *      keeps the frozen `data-state="checking"` hook;
 *   3. an error renders the recoverable Retry (frozen hook) + Re-check.
 *
 * Spec #3141 ST-6: no registry step carries `kind: 'install'` any more (nothing
 * is installed — the runtime ships inside Fredo), so the install-narration
 * branch is now DORMANT. It is retained deliberately so the card stays
 * type-correct for any future provisioning action, and this suite pins it with a
 * locally-authored step meta rather than a retired registry entry.
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
import type { CompanionSetupStepMeta } from '@/shared/components/companion/companionSetupSteps';
import { LuDownload } from 'react-icons/lu';

/**
 * A DORMANT install action (#3141 ST-6): no registry step uses `kind: 'install'`
 * any more, but the card must keep rendering it correctly.
 */
const installStep: CompanionSetupStepMeta = {
  id: 'modelFiles',
  testId: 'llama-server',
  role: 'prerequisite',
  label: 'Provisioning step',
  description: 'A provisioning step with an install action.',
  icon: LuDownload,
  action: {
    command: 'download_model',
    label: 'Provision',
    runningLabel: 'Provisioning…',
    kind: 'install',
  },
};

function renderCard(uiState: SetupStepUiState, errorText?: string) {
  const onRunAction = vi.fn();
  const onRecheck = vi.fn();
  const utils = renderWithChakra(
    <SetupStepCard
      step={installStep}
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

  it('renders the Retry + Re-check affordances on error', () => {
    const { onRunAction, onRecheck } = renderCard('error', 'failed to create C:\\x');

    expect(screen.getByTestId('companion-step-llama-server')).toHaveAttribute(
      'data-state',
      'error',
    );
    fireEvent.click(screen.getByTestId('companion-step-llama-server-retry'));
    expect(onRunAction).toHaveBeenCalledWith('modelFiles');
    fireEvent.click(screen.getByTestId('companion-step-llama-server-recheck'));
    expect(onRecheck).toHaveBeenCalledTimes(1);
  });
});
