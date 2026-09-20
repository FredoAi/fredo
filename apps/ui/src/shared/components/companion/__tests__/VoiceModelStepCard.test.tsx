/**
 * VoiceModelStepCard (#2877 ST-7, DR-4) — per-file rendering contract for the
 * Companion setup wizard's OPTIONAL `sttModel` step (R-2.1…R-2.5, R-5.2).
 *
 * Proves, without a Tauri host:
 *   1. all-missing → four named rows (Tokens / Encoder / Decoder / Joiner), each
 *      `missing`, an incomplete summary, and an enabled Download control; the
 *      roster matches the pinned STT file-id order;
 *   2. mixed → each row carries its OWN `data-state` and the in-flight file
 *      exposes a determinate progress testid;
 *   3. error → the failed row exposes an actionable inline message + a per-file
 *      Retry that invokes the SAME `sttModel` action (no new verb);
 *   4. all-present → the card reads complete, hides Download, keeps Re-check and
 *      shows the resolved model location;
 *   5. no per-file status → degrades to the prerequisite vocabulary, never
 *      fabricates complete, and keeps offering acquisition;
 *   6. the frozen `companion-step-stt-model` hook keeps the prerequisite
 *      `data-state` vocabulary (`checking` / `missing` / `installed` / …);
 *   7. SOURCE PIN (DR-12): the new card uses no color literal and never
 *      alpha-appends onto a `var()`.
 */

import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { VoiceModelStepCard } from '@/shared/components/companion/VoiceModelStepCard';
import { COMPANION_SETUP_STEPS } from '@/shared/components/companion/companionSetupSteps';
import { STT_MODEL_FILE_IDS } from '@/shared/components/companion/companionReadiness';
import type {
  ModelFileId,
  ModelFileStatus,
  SttModelReadiness,
} from '@/shared/components/companion/companionReadiness';
import type { SetupStepUiState } from '@/shared/components/companion/SetupStepCard';

const CARD_PATH = 'src/shared/components/companion/VoiceModelStepCard.tsx';

const step = COMPANION_SETUP_STEPS.find((s) => s.id === 'sttModel')!;

const STT_IDS = ['sttTokens', 'sttEncoder', 'sttDecoder', 'sttJoiner'] as const;

function file(id: ModelFileId, overrides: Partial<ModelFileStatus> = {}): ModelFileStatus {
  return {
    id,
    filename: `${id}.bin`,
    relativePath: `${id}.bin`,
    state: 'missing',
    downloadedBytes: 0,
    expectedBytes: 1000,
    detail: null,
    path: null,
    ...overrides,
  };
}

function readiness(files: ModelFileStatus[]): SttModelReadiness {
  const ready = files.length > 0 && files.every((f) => f.state === 'present');
  return { ready, files, location: ready ? 'C:\\models\\sherpa-onnx-streaming-zipformer-en' : null };
}

function renderCard(
  sttModel: SttModelReadiness | null,
  uiState: SetupStepUiState = 'missing',
) {
  const onRunAction = vi.fn();
  const onRecheck = vi.fn();
  const utils = renderWithChakra(
    <VoiceModelStepCard
      step={step}
      uiState={uiState}
      errorText="boom"
      sttModel={sttModel}
      onRunAction={onRunAction}
      onRecheck={onRecheck}
    />,
  );
  return { ...utils, onRunAction, onRecheck };
}

describe('VoiceModelStepCard (#2877 ST-7)', () => {
  afterEach(() => {
    cleanup();
  });

  it('uses the pinned STT file-id roster order', () => {
    const rosterSource = readFileSync(resolve(process.cwd(), CARD_PATH), 'utf8');
    for (const id of STT_MODEL_FILE_IDS) {
      expect(rosterSource).toContain(`id: '${id}'`);
    }
    // The roster ids are exactly the four pinned STT ids (no companion id leaks in).
    expect(rosterSource).not.toContain("id: 'model'");
    expect(rosterSource).not.toContain("id: 'vision'");
    expect(rosterSource).not.toContain("id: 'mtp'");
  });

  it('renders the four named rows missing with an incomplete summary and a download control', () => {
    renderCard(readiness(STT_IDS.map((id) => file(id))));

    const stepRow = screen.getByTestId('companion-step-stt-model');
    // Frozen hook: `data-state` speaks the prerequisite vocabulary.
    expect(stepRow).toHaveAttribute('data-state', 'missing');
    expect(screen.getByTestId('companion-step-stt-model-status')).toHaveTextContent(
      '0 of 4 present',
    );
    expect(screen.getByTestId('companion-step-stt-model-download')).toBeInTheDocument();
    expect(screen.getByTestId('companion-step-stt-model-recheck')).toBeInTheDocument();
    expect(screen.getByTestId('companion-step-stt-model-summary')).toHaveTextContent(
      'Incomplete — no voice input model files downloaded yet (0 of 4).',
    );

    for (const id of STT_IDS) {
      const row = screen.getByTestId(`companion-stt-file-${id}`);
      expect(row).toHaveAttribute('data-state', 'missing');
      expect(screen.getByTestId(`companion-stt-file-${id}-status`)).toHaveTextContent(
        'Missing',
      );
    }
    expect(screen.getByText('Tokens')).toBeInTheDocument();
    expect(screen.getByText('Encoder')).toBeInTheDocument();
    expect(screen.getByText('Decoder')).toBeInTheDocument();
    expect(screen.getByText('Joiner')).toBeInTheDocument();
  });

  it('reports each file independently while one is downloading (never complete)', () => {
    renderCard(
      readiness([
        file('sttTokens', { state: 'present', downloadedBytes: 1000 }),
        file('sttEncoder', {
          state: 'downloading',
          downloadedBytes: 500,
          expectedBytes: 1000,
        }),
        file('sttDecoder'),
        file('sttJoiner'),
      ]),
      'running',
    );

    expect(screen.getByTestId('companion-step-stt-model')).toHaveAttribute(
      'data-state',
      'running',
    );
    expect(screen.getByTestId('companion-stt-file-sttTokens')).toHaveAttribute(
      'data-state',
      'present',
    );
    expect(screen.getByTestId('companion-stt-file-sttEncoder')).toHaveAttribute(
      'data-state',
      'downloading',
    );
    expect(screen.getByTestId('companion-stt-file-sttDecoder')).toHaveAttribute(
      'data-state',
      'missing',
    );
    expect(screen.getByTestId('companion-stt-file-sttEncoder-progress')).toBeInTheDocument();
    expect(screen.getByTestId('companion-step-stt-model-summary')).not.toHaveTextContent(
      'Complete',
    );
    expect(screen.getByTestId('companion-step-stt-model-summary')).toHaveTextContent(
      'sttEncoder.bin',
    );
  });

  it('surfaces a per-file error with a retry that reuses the sttModel action', () => {
    const { onRunAction } = renderCard(
      readiness([
        file('sttTokens', { state: 'present', downloadedBytes: 1000 }),
        file('sttEncoder', { state: 'error', detail: 'connection reset — choose Retry.' }),
        file('sttDecoder'),
        file('sttJoiner'),
      ]),
      'error',
    );

    expect(screen.getByTestId('companion-step-stt-model')).toHaveAttribute(
      'data-state',
      'error',
    );
    expect(screen.getByTestId('companion-stt-file-sttEncoder')).toHaveAttribute(
      'data-state',
      'error',
    );
    expect(screen.getByTestId('companion-stt-file-sttEncoder-status')).toHaveTextContent(
      'Error',
    );

    const retry = screen.getByTestId('companion-stt-file-sttEncoder-retry');
    expect(retry).toHaveAttribute('aria-label', 'Retry Encoder download');
    fireEvent.click(retry);
    expect(onRunAction).toHaveBeenCalledWith('sttModel');

    expect(screen.getByTestId('companion-step-stt-model-summary')).not.toHaveTextContent(
      'Complete',
    );
    expect(screen.getByTestId('companion-step-stt-model-summary')).toHaveTextContent(
      'failed',
    );
  });

  it('reads complete and shows the resolved location only when all four files are present', () => {
    const { onRecheck } = renderCard(
      readiness(STT_IDS.map((id) => file(id, { state: 'present', downloadedBytes: 1000 }))),
      'installed',
    );

    expect(screen.getByTestId('companion-step-stt-model')).toHaveAttribute(
      'data-state',
      'installed',
    );
    expect(screen.getByTestId('companion-step-stt-model-status')).toHaveTextContent(
      '4 of 4 present',
    );
    expect(screen.getByTestId('companion-step-stt-model-location')).toHaveTextContent(
      'C:\\models\\sherpa-onnx-streaming-zipformer-en',
    );
    expect(screen.queryByTestId('companion-step-stt-model-download')).toBeNull();

    const recheck = screen.getByTestId('companion-step-stt-model-recheck');
    fireEvent.click(recheck);
    expect(onRecheck).toHaveBeenCalledTimes(1);
  });

  it('shows the resolved location on a partial/error state too (R-2.4)', () => {
    renderCard(
      {
        ready: false,
        files: [
          file('sttTokens', { state: 'present', downloadedBytes: 1000, path: 'C:\\models\\tokens.txt' }),
          file('sttEncoder'),
          file('sttDecoder'),
          file('sttJoiner'),
        ],
        location: 'C:\\models\\sherpa-onnx-streaming-zipformer-en',
      },
      'missing',
    );

    expect(screen.getByTestId('companion-step-stt-model-location')).toHaveTextContent(
      'C:\\models\\sherpa-onnx-streaming-zipformer-en',
    );
  });

  it('degrades to the prerequisite vocabulary without per-file status (no fabricated complete)', () => {
    renderCard(null, 'missing');

    expect(screen.getByTestId('companion-step-stt-model')).toHaveAttribute(
      'data-state',
      'missing',
    );
    expect(screen.getByTestId('companion-step-stt-model-summary')).not.toHaveTextContent(
      'Complete',
    );
    expect(screen.getByTestId('companion-step-stt-model-download')).toBeInTheDocument();
    expect(screen.queryByTestId('companion-step-stt-model-location')).toBeNull();
  });

  it('keeps the frozen checking hook while the probe is in flight', () => {
    renderCard(null, 'checking');

    expect(screen.getByTestId('companion-step-stt-model')).toHaveAttribute(
      'data-state',
      'checking',
    );
    expect(screen.getByTestId('companion-step-stt-model-status')).toHaveTextContent(
      'Checking…',
    );
  });

  it('SOURCE PIN (DR-12): no color literal and never a var() alpha-append', () => {
    const source = readFileSync(resolve(process.cwd(), CARD_PATH), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(source).not.toMatch(/var\(--[a-z0-9-]+\)[0-9a-fA-F]{2}/);
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toMatch(/\brgba?\(/);
    expect(source).not.toMatch(/\bhsla?\(/);
    // Alpha always routes through the shared tint() helper.
    expect(source).toContain("tint('var(--accent-primary)'");
    expect(source).toContain('var(--accent-contrast)');
  });
});
