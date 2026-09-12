/**
 * ModelFilesStepCard (#2856) — per-file rendering contract for the Companion
 * setup wizard's `modelFiles` step (AC1/AC3/AC5).
 *
 * Proves, without a Tauri host:
 *   1. all-missing → three named rows (Model / Vision / MTP), each `missing`,
 *      an incomplete summary naming the set, and an enabled Download control;
 *   2. mixed → each row carries its OWN `data-state` (present / downloading /
 *      missing), the in-flight file exposes a determinate progress testid, and
 *      the step stays incomplete;
 *   3. error → the failed row is `error`, exposes an actionable inline message +
 *      a per-file Retry, and the step never reads complete;
 *   4. all-present → the step reads `complete`, the Download control is gone,
 *      and Re-check remains available (manual-place adoption).
 *
 * The frozen QA hooks are asserted verbatim.
 */

import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { ModelFilesStepCard } from '@/shared/components/companion/ModelFilesStepCard';
import { COMPANION_SETUP_STEPS } from '@/shared/components/companion/companionSetupSteps';
import type {
  ModelFileStatus,
  ModelFilesStatus,
} from '@/shared/components/companion/companionReadiness';

const step = COMPANION_SETUP_STEPS.find((s) => s.id === 'modelFiles')!;

function file(
  id: 'model' | 'vision' | 'mtp',
  overrides: Partial<ModelFileStatus> = {},
): ModelFileStatus {
  const filename =
    id === 'model'
      ? 'gemma-4-E2B-it-qat-UD-Q4_K_XL.gguf'
      : id === 'vision'
        ? 'mmproj-BF16.gguf'
        : 'MTP/mtp-gemma-4-E2B-it-Q4_0.gguf';
  return {
    id,
    filename,
    relativePath: filename,
    state: 'missing',
    downloadedBytes: 0,
    expectedBytes: 1000,
    detail: null,
    path: null,
    ...overrides,
  };
}

function status(files: ModelFileStatus[], complete = false): ModelFilesStatus {
  return { complete, files };
}

function renderCard(modelFiles: ModelFilesStatus | null, uiState: 'missing' | 'running' | 'error' = 'missing') {
  const onRunAction = vi.fn();
  const onRecheck = vi.fn();
  const utils = renderWithChakra(
    <ModelFilesStepCard
      step={step}
      uiState={uiState}
      errorText="boom"
      modelFiles={modelFiles}
      onRunAction={onRunAction}
      onRecheck={onRecheck}
    />,
  );
  return { ...utils, onRunAction, onRecheck };
}

describe('ModelFilesStepCard (#2856)', () => {
  afterEach(() => {
    cleanup();
  });
  it('renders the three named rows missing with an incomplete summary and a download control', () => {
    renderCard(status([file('model'), file('vision'), file('mtp')]));

    const stepRow = screen.getByTestId('companion-step-model-files');
    expect(stepRow).toHaveAttribute('data-state', 'incomplete');
    expect(screen.getByTestId('companion-step-model-files-status')).toHaveTextContent(
      '0 of 3 present',
    );
    expect(screen.getByTestId('companion-step-model-files-download')).toBeInTheDocument();
    expect(screen.getByTestId('companion-step-model-files-recheck')).toBeInTheDocument();

    const summary = screen.getByTestId('companion-step-model-files-summary');
    expect(summary).toHaveTextContent('Incomplete — no model files downloaded yet (0 of 3).');

    for (const id of ['model', 'vision', 'mtp'] as const) {
      const row = screen.getByTestId(`companion-model-file-${id}`);
      expect(row).toHaveAttribute('data-state', 'missing');
      expect(screen.getByTestId(`companion-model-file-${id}-status`)).toHaveTextContent(
        'Missing',
      );
    }
    expect(screen.getByText('gemma-4-E2B-it-qat-UD-Q4_K_XL.gguf')).toBeInTheDocument();
    expect(screen.getByText('mmproj-BF16.gguf')).toBeInTheDocument();
    expect(screen.getByText('MTP/mtp-gemma-4-E2B-it-Q4_0.gguf')).toBeInTheDocument();
  });

  it('reports each file independently while one is downloading (never complete)', () => {
    renderCard(
      status([
        file('model', { state: 'present', downloadedBytes: 1000, path: 'C:\\models\\model.gguf' }),
        file('vision', { state: 'downloading', downloadedBytes: 500, expectedBytes: 1000 }),
        file('mtp'),
      ]),
      'running',
    );

    expect(screen.getByTestId('companion-step-model-files')).toHaveAttribute(
      'data-state',
      'downloading',
    );
    expect(screen.getByTestId('companion-model-file-model')).toHaveAttribute(
      'data-state',
      'present',
    );
    expect(screen.getByTestId('companion-model-file-vision')).toHaveAttribute(
      'data-state',
      'downloading',
    );
    expect(screen.getByTestId('companion-model-file-mtp')).toHaveAttribute(
      'data-state',
      'missing',
    );
    expect(screen.getByTestId('companion-model-file-vision-progress')).toBeInTheDocument();
    expect(screen.getByTestId('companion-step-model-files-summary')).not.toHaveTextContent(
      'Complete',
    );
    expect(screen.getByTestId('companion-step-model-files-summary')).toHaveTextContent(
      'MTP/mtp-gemma-4-E2B-it-Q4_0.gguf',
    );
  });

  it('surfaces a persistent per-file error with a retry and never reads complete', () => {
    const { onRunAction } = renderCard(
      status([
        file('model', { state: 'present', downloadedBytes: 1000 }),
        file('vision', { state: 'error', detail: 'connection reset — choose Retry.' }),
        file('mtp'),
      ]),
      'error',
    );

    expect(screen.getByTestId('companion-step-model-files')).toHaveAttribute(
      'data-state',
      'error',
    );
    expect(screen.getByTestId('companion-model-file-vision')).toHaveAttribute(
      'data-state',
      'error',
    );
    expect(screen.getByTestId('companion-model-file-vision-status')).toHaveTextContent(
      'Error',
    );
    expect(screen.getByText('connection reset — choose Retry.')).toBeInTheDocument();

    const retry = screen.getByTestId('companion-model-file-vision-retry');
    expect(retry).toHaveAttribute('aria-label', 'Retry Vision projector download');
    fireEvent.click(retry);
    expect(onRunAction).toHaveBeenCalledWith('modelFiles');

    expect(screen.getByTestId('companion-step-model-files-summary')).not.toHaveTextContent(
      'Complete',
    );
  });

  it('reads complete only when all three files are present, hiding download and keeping re-check', () => {
    const { onRecheck } = renderCard(
      status(
        [
          file('model', { state: 'present', downloadedBytes: 1000 }),
          file('vision', { state: 'present', downloadedBytes: 1000 }),
          file('mtp', { state: 'present', downloadedBytes: 1000 }),
        ],
        true,
      ),
    );

    expect(screen.getByTestId('companion-step-model-files')).toHaveAttribute(
      'data-state',
      'complete',
    );
    expect(screen.getByTestId('companion-step-model-files-status')).toHaveTextContent(
      '3 of 3 present',
    );
    expect(screen.queryByTestId('companion-step-model-files-download')).toBeNull();

    const recheck = screen.getByTestId('companion-step-model-files-recheck');
    fireEvent.click(recheck);
    expect(onRecheck).toHaveBeenCalledTimes(1);
  });

  it('degrades to the prerequisite vocabulary without per-file status (no fabricated complete)', () => {
    renderCard(null, 'missing');
    expect(screen.getByTestId('companion-step-model-files')).toHaveAttribute(
      'data-state',
      'missing',
    );
    expect(screen.getByTestId('companion-step-model-files-summary')).not.toHaveTextContent(
      'Complete',
    );
    // Acquisition is still offered — the backend remains the source of truth.
    expect(screen.getByTestId('companion-step-model-files-download')).toBeInTheDocument();
  });
});
