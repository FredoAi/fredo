/**
 * CompanionSetupWizard — the #3141 ST-6 one-prerequisite banner.
 *
 * The wizard retired the `installed/total` fraction (meaningless at 1) and its
 * three count sentences. The banner now names the one thing left to do:
 *
 *   - any probe in flight        → `Checking prerequisites…`
 *   - model files installed      → `Model files ready — nothing else to install`
 *   - model files missing        → `Model files needed before the companion can run`
 *   - probe failed / unreported  → `Couldn't check the model files` (fail closed)
 *
 * `deriveSetupSummary` is exported and pure so the whole mapping is pinned
 * without a Tauri host; the render-level assertions prove the element that
 * carries the copy is the frozen `companion-setup-summary` hook.
 */

import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, screen } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import {
  CompanionSetupWizard,
  deriveSetupSummary,
} from '@/shared/components/companion/CompanionSetupWizard';
import type { CompanionSetupWizardPrerequisite } from '@/shared/components/companion/CompanionSetupWizard';

afterEach(() => {
  cleanup();
});

describe('#3141 ST-6 — deriveSetupSummary (the one-prerequisite banner)', () => {
  it('names the in-flight probe first', () => {
    expect(
      deriveSetupSummary({ checking: true, modelFilesState: 'installed' }).text,
    ).toBe('Checking prerequisites…');
  });

  it('names the ONE remaining prerequisite in each settled state', () => {
    expect(
      deriveSetupSummary({ checking: false, modelFilesState: 'installed' }).text,
    ).toBe('Model files ready — nothing else to install');
    expect(
      deriveSetupSummary({ checking: false, modelFilesState: 'missing' }).text,
    ).toBe('Model files needed before the companion can run');
  });

  it('fails closed to "couldn\'t check" for an error or unreported prerequisite', () => {
    expect(deriveSetupSummary({ checking: false, modelFilesState: 'error' }).text).toBe(
      "Couldn't check the model files",
    );
    expect(deriveSetupSummary({ checking: false, modelFilesState: undefined }).text).toBe(
      "Couldn't check the model files",
    );
  });

  it('never emits a count sentence (the retired `n of m` vocabulary)', () => {
    const states = ['installed', 'missing', 'error', undefined] as const;
    for (const modelFilesState of states) {
      for (const checking of [true, false]) {
        const { text } = deriveSetupSummary({ checking, modelFilesState });
        expect(text).not.toMatch(/\d+ of \d+/);
        expect(text).not.toContain('prerequisites ready');
        expect(text).not.toContain('All prerequisites installed');
        expect(text).not.toContain('prerequisites need attention');
      }
    }
  });
});

describe('#3141 ST-6 — the wizard renders the banner under the frozen hook', () => {
  function renderWizard(prerequisites: CompanionSetupWizardPrerequisite[]) {
    return renderWithChakra(
      <CompanionSetupWizard
        prerequisites={prerequisites}
        runningActionId={null}
        actionError={{}}
        modelFiles={null}
        serverLaunch={null}
        onRunAction={() => {}}
        onRecheck={() => {}}
      />,
    );
  }

  it('renders the model-files-needed banner and NO fraction', () => {
    renderWizard([{ id: 'modelFiles', uiState: 'missing' }]);
    const summary = screen.getByTestId('companion-setup-summary');
    expect(summary).toHaveTextContent('Model files needed before the companion can run');
    // The old counter element and its copy are gone.
    expect(summary).not.toHaveTextContent('1/1');
    expect(summary).not.toHaveTextContent('0 of');
  });

  it('renders the nothing-else-to-install banner once the model files are present', () => {
    renderWizard([{ id: 'modelFiles', uiState: 'installed' }]);
    expect(screen.getByTestId('companion-setup-summary')).toHaveTextContent(
      'Model files ready — nothing else to install',
    );
  });

  it('never tells the user to install anything (AC-17)', () => {
    renderWizard([{ id: 'modelFiles', uiState: 'missing' }]);
    const wizard = screen.getByTestId('companion-setup-wizard');
    expect(wizard).not.toHaveTextContent('Install llama.cpp');
    expect(wizard).not.toHaveTextContent('winget');
    expect(wizard).not.toHaveTextContent('llama.cpp');
    // The handoff copy names the engine's lifecycle state, not "Installed".
    expect(screen.getByTestId('companion-setup-handoff')).toHaveTextContent(
      'When the model files are ready and the engine is running',
    );
  });
});
