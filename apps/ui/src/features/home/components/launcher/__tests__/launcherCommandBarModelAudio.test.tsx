/**
 * Spec #2897 ST-4 (REQ-3/REQ-4) — the model-audio listening indicator at the
 * launcher command bar.
 *
 * Pins:
 *   1. `deriveModelAudioPhase` — the ONE pure derivation: local mode is always
 *      `idle`; a typed error outranks everything; `processing` outranks the
 *      capture; `listening` is the live capture; `starting` is the shipped
 *      bounded window; anything else is `idle` (the `stopped` resting render).
 *   2. The model listening chip — `launcher-command-model-listening-chip` reading
 *      `Fredo is listening`, the `Fredo is listening…` placeholder, the accent
 *      dot, and the shipped (mode-agnostic) cancel/stop controls.
 *   3. The model processing chip — `launcher-command-model-processing-chip`
 *      reading `Fredo is processing your speech…` with the decorative `Spinner`,
 *      the `Fredo is processing…` placeholder, the dot, and NO stop/cancel.
 *   4. `stopped`/`idle` removes the chip/indicator and returns the resting
 *      placeholder; `error` keeps the below-bar `role="alert"` surface.
 *   5. LOCAL mode (omitted `voiceMode`) is byte-identical to the shipped bar: the
 *      `Listening` chip + `Listening…` placeholder, and no model chip.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, screen } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import {
  LauncherCommandBar,
  MODEL_AUDIO_LISTENING_ANNOUNCEMENT,
  MODEL_AUDIO_LISTENING_CHIP_COPY,
  MODEL_AUDIO_LISTENING_PLACEHOLDER,
  MODEL_AUDIO_PROCESSING_ANNOUNCEMENT,
  MODEL_AUDIO_PROCESSING_CHIP_COPY,
  MODEL_AUDIO_PROCESSING_PLACEHOLDER,
  deriveModelAudioPhase,
} from '../LauncherCommandBar';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ── The pure derivation ───────────────────────────────────────────────────────

describe('deriveModelAudioPhase — the ONE model-audio state derivation (#2897 ST-4)', () => {
  const input = (
    over: Partial<Parameters<typeof deriveModelAudioPhase>[0]> = {},
  ): Parameters<typeof deriveModelAudioPhase>[0] => ({
    voiceMode: 'model',
    listening: false,
    modelAudioPhase: null,
    starting: false,
    error: false,
    ...over,
  });

  it('local mode is ALWAYS idle — the shipped transcription cue is untouched', () => {
    expect(
      deriveModelAudioPhase(input({ voiceMode: 'local', listening: true })),
    ).toBe('idle');
    expect(
      deriveModelAudioPhase(input({ voiceMode: 'local', modelAudioPhase: 'processing' })),
    ).toBe('idle');
  });

  it('a typed error outranks every other model-audio signal', () => {
    expect(
      deriveModelAudioPhase(input({ listening: true, error: true })),
    ).toBe('error');
    expect(
      deriveModelAudioPhase(input({ modelAudioPhase: 'processing', error: true })),
    ).toBe('error');
  });

  it('processing outranks the (already-ended) capture; listening is the live capture', () => {
    expect(deriveModelAudioPhase(input({ modelAudioPhase: 'processing' }))).toBe('processing');
    expect(
      deriveModelAudioPhase(input({ listening: true, modelAudioPhase: 'capturing' })),
    ).toBe('listening');
  });

  it('the bounded starting window is `starting`; nothing set is `idle` (the stopped render)', () => {
    expect(deriveModelAudioPhase(input({ starting: true }))).toBe('starting');
    expect(deriveModelAudioPhase(input())).toBe('idle');
  });

  // #2897 round 2 (R2-1, F-104) — the turn-completion overlay. The STT plane is
  // silent after the stop, so the shell supplies `turnSettled` once the audio
  // generation completes: `processing` holds until then, and only THEN does the
  // derivation return to `idle` (the `stopped` resting render).
  it('holds `processing` while the turn is in flight and returns to `idle` once it settles', () => {
    expect(
      deriveModelAudioPhase(input({ modelAudioPhase: 'processing', turnSettled: false })),
    ).toBe('processing');
    expect(
      deriveModelAudioPhase(input({ modelAudioPhase: 'processing', turnSettled: true })),
    ).toBe('idle');
    // The overlay is inert for every non-processing phase (never settles a live
    // capture or a bounded start).
    expect(
      deriveModelAudioPhase(input({ listening: true, modelAudioPhase: 'capturing', turnSettled: true })),
    ).toBe('listening');
    expect(deriveModelAudioPhase(input({ starting: true, turnSettled: true }))).toBe('starting');
  });

  it('local mode is `idle` for BOTH settled states — the overlay never fires off-model', () => {
    expect(
      deriveModelAudioPhase(
        input({ voiceMode: 'local', modelAudioPhase: 'processing', turnSettled: false }),
      ),
    ).toBe('idle');
    expect(
      deriveModelAudioPhase(
        input({ voiceMode: 'local', modelAudioPhase: 'processing', turnSettled: true }),
      ),
    ).toBe('idle');
  });
});

// ── The rendered indicator ────────────────────────────────────────────────────

describe('LauncherCommandBar — the model-audio chips (#2897 ST-4)', () => {
  it('listening: the model chip + dot + cancel/stop, and NO shipped `Listening` chip', () => {
    renderWithChakra(
      <LauncherCommandBar
        query="draft"
        onQueryChange={vi.fn()}
        voiceMode="model"
        listening
        modelAudioPhase="capturing"
        onStopListening={vi.fn()}
        onCancelListening={vi.fn()}
      />,
    );

    const chip = screen.getByTestId('launcher-command-model-listening-chip');
    expect(chip).toHaveTextContent(MODEL_AUDIO_LISTENING_CHIP_COPY);
    expect(MODEL_AUDIO_LISTENING_CHIP_COPY).toBe('Fredo is listening');
    expect(screen.getByTestId('launcher-command-listening')).toBeInTheDocument();
    expect(screen.getByRole('searchbox')).toHaveAttribute(
      'placeholder',
      MODEL_AUDIO_LISTENING_PLACEHOLDER,
    );
    // The transcription wording never renders in model mode.
    expect(screen.queryByTestId('launcher-command-listening-chip')).toBeNull();
    expect(screen.queryByText('Listening')).toBeNull();
    // The mode-agnostic controls keep their ids while a capture is live.
    expect(screen.getByTestId('launcher-command-listening-stop')).toBeInTheDocument();
    expect(screen.getByTestId('launcher-command-listening-cancel')).toBeInTheDocument();
  });

  it('processing: the processing chip + decorative spinner + dot, and NO stop/cancel', () => {
    const { container } = renderWithChakra(
      <LauncherCommandBar
        query=""
        onQueryChange={vi.fn()}
        voiceMode="model"
        modelAudioPhase="processing"
        onStopListening={vi.fn()}
        onCancelListening={vi.fn()}
      />,
    );

    const chip = screen.getByTestId('launcher-command-model-processing-chip');
    expect(chip).toHaveTextContent(MODEL_AUDIO_PROCESSING_CHIP_COPY);
    expect(MODEL_AUDIO_PROCESSING_CHIP_COPY).toBe('Fredo is processing your speech…');
    expect(screen.getByRole('searchbox')).toHaveAttribute(
      'placeholder',
      MODEL_AUDIO_PROCESSING_PLACEHOLDER,
    );
    // The dot is continuous from capture through interpretation.
    expect(screen.getByTestId('launcher-command-listening')).toBeInTheDocument();
    // The spinner is DECORATION only (aria-hidden); text carries the state.
    expect(chip.querySelector('[aria-hidden="true"]')).not.toBeNull();
    // Nothing is left to cancel while the clip is being interpreted.
    expect(screen.queryByTestId('launcher-command-listening-stop')).toBeNull();
    expect(screen.queryByTestId('launcher-command-listening-cancel')).toBeNull();
    // No transcript region is ever touched; it stays mounted.
    expect(container.querySelector('[data-testid="voice-transcript-announcer"]')).not.toBeNull();
  });

  // #2897 round 2 (R2-1, F-104) — the round's oracle at the bar level: a settled
  // audio turn renders `stopped` (chip + indicator removed, resting placeholder).
  it('settled turn: the processing chip is removed and the resting placeholder returns', () => {
    const { rerender } = renderWithChakra(
      <LauncherCommandBar
        query=""
        onQueryChange={vi.fn()}
        voiceMode="model"
        modelAudioPhase="processing"
      />,
    );
    expect(screen.getByTestId('launcher-command-model-processing-chip')).toBeInTheDocument();

    rerender(
      <LauncherCommandBar
        query=""
        onQueryChange={vi.fn()}
        voiceMode="model"
        modelAudioPhase="processing"
        modelAudioTurnSettled
      />,
    );
    expect(screen.queryByTestId('launcher-command-model-processing-chip')).toBeNull();
    expect(screen.queryByTestId('launcher-command-model-listening-chip')).toBeNull();
    expect(screen.queryByTestId('launcher-command-listening')).toBeNull();
    expect(screen.getByRole('searchbox')).toHaveAttribute('placeholder', 'search or command');
  });

  it('stopped/idle: the chip and indicator are removed and the resting placeholder returns', () => {
    renderWithChakra(
      <LauncherCommandBar query="" onQueryChange={vi.fn()} voiceMode="model" />,
    );

    expect(screen.queryByTestId('launcher-command-model-listening-chip')).toBeNull();
    expect(screen.queryByTestId('launcher-command-model-processing-chip')).toBeNull();
    expect(screen.queryByTestId('launcher-command-listening')).toBeNull();
    expect(screen.getByRole('searchbox')).toHaveAttribute('placeholder', 'search or command');
  });

  it('error: the below-bar role="alert" surface is preserved', () => {
    renderWithChakra(
      <LauncherCommandBar
        query=""
        onQueryChange={vi.fn()}
        voiceMode="model"
        voiceErrorMessage="Model audio is unavailable."
      />,
    );

    const status = screen.getByTestId('launcher-command-listening-status');
    expect(status).toHaveAttribute('role', 'alert');
    expect(status).toHaveTextContent('Model audio is unavailable.');
  });

  it('LOCAL mode (omitted `voiceMode`) renders the shipped `Listening` chip unchanged', () => {
    renderWithChakra(
      <LauncherCommandBar query="live" onQueryChange={vi.fn()} listening onStopListening={vi.fn()} />,
    );

    expect(screen.getByTestId('launcher-command-listening-chip')).toHaveTextContent('Listening');
    expect(screen.getByRole('searchbox')).toHaveAttribute('placeholder', 'Listening…');
    expect(screen.queryByTestId('launcher-command-model-listening-chip')).toBeNull();
    expect(screen.queryByTestId('launcher-command-model-processing-chip')).toBeNull();
  });
});

// ── The live-region copy (transition-driven) ──────────────────────────────────

describe('LauncherCommandBar — the model-audio announcements (#2897 ST-4)', () => {
  it('announces `Fredo is listening` on the capture rise and `Fredo is processing your speech` on the processing rise', () => {
    const { rerender } = renderWithChakra(
      <LauncherCommandBar query="" onQueryChange={vi.fn()} voiceMode="model" />,
    );

    const announcer = screen.getByTestId('voice-listening-announcer');
    expect(announcer.textContent).toBe('');

    rerender(
      <LauncherCommandBar query="" onQueryChange={vi.fn()} voiceMode="model" listening />,
    );
    expect(announcer).toHaveTextContent(MODEL_AUDIO_LISTENING_ANNOUNCEMENT);

    // The stop hands over to `processing`: ONE line, never `Stopped listening`.
    rerender(
      <LauncherCommandBar
        query=""
        onQueryChange={vi.fn()}
        voiceMode="model"
        modelAudioPhase="processing"
      />,
    );
    expect(announcer).toHaveTextContent(MODEL_AUDIO_PROCESSING_ANNOUNCEMENT);
    expect(announcer).not.toHaveTextContent('Stopped listening');
  });

  it('the mount is silent and a non-model render never uses the model copy', () => {
    const { rerender } = renderWithChakra(
      <LauncherCommandBar query="" onQueryChange={vi.fn()} />,
    );
    const announcer = screen.getByTestId('voice-listening-announcer');
    expect(announcer.textContent).toBe('');

    rerender(<LauncherCommandBar query="" onQueryChange={vi.fn()} listening />);
    expect(announcer).toHaveTextContent('Listening');
    expect(announcer).not.toHaveTextContent(MODEL_AUDIO_LISTENING_ANNOUNCEMENT);
  });
});
