/**
 * Spec #2897 ST-4 (REQ-3/REQ-4) — the model-audio listening indicator at the
 * launcher command bar.
 *
 * Pins:
 *   1. `deriveModelAudioPhase` — the ONE pure derivation (Spec #2914 ST-8: model
 *      audio is the only mode): a typed error outranks everything; `processing`
 *      outranks the capture; `listening` is the live capture; `starting` is the
 *      shipped bounded window; anything else is `idle` (the `stopped` render).
 *   2. The model listening chip — `launcher-command-model-listening-chip` reading
 *      `Fredo is listening`, the `release Space to finish` placeholder (#2904
 *      ST-2: while the model chip is up it is the ONLY listening claim, so the
 *      instruction relocates into the field and the hint chip is suppressed), the
 *      accent dot, and the shipped (mode-agnostic) cancel/stop controls.
 *   3. The model processing chip — `launcher-command-model-processing-chip`
 *      reading `Fredo is processing your speech…` with the decorative `Spinner`,
 *      the `Fredo is processing…` placeholder, the dot, and NO stop/cancel.
 *   4. `stopped`/`idle` removes the chip/indicator and returns the resting
 *      placeholder; `error` keeps the below-bar `role="alert"` surface.
 *   5. Spec #2914 ST-8 — voice input has ONE mode: the model-audio path renders
 *      for every session (the removed `voiceMode='local'` cue is gone; there is no
 *      `voiceMode` input on the derivation).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, screen } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import {
  BAR_FIELD_MIN_CONTENT_PX,
  BAR_LEADING_GUTTER_PX,
  BAR_MAX_WIDTH_PX,
  LauncherCommandBar,
  MODEL_AUDIO_LISTENING_ANNOUNCEMENT,
  MODEL_AUDIO_LISTENING_CHIP_COPY,
  MODEL_AUDIO_LISTENING_PLACEHOLDER,
  MODEL_AUDIO_PROCESSING_ANNOUNCEMENT,
  MODEL_AUDIO_PROCESSING_CHIP_COPY,
  MODEL_AUDIO_PROCESSING_PLACEHOLDER,
  computeEndPaddingPx,
  computeEndSlotBudgetPx,
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
    listening: false,
    modelAudioPhase: null,
    starting: false,
    error: false,
    ...over,
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
});

// ── The rendered indicator ────────────────────────────────────────────────────

describe('LauncherCommandBar — the model-audio chips (#2897 ST-4)', () => {
  it('listening: the model chip + dot + cancel/stop, and NO shipped `Listening` chip', () => {
    renderWithChakra(
      <LauncherCommandBar
        query="draft"
        onQueryChange={vi.fn()}
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
        modelAudioPhase="processing"
      />,
    );
    expect(screen.getByTestId('launcher-command-model-processing-chip')).toBeInTheDocument();

    rerender(
      <LauncherCommandBar
        query=""
        onQueryChange={vi.fn()}
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
      <LauncherCommandBar query="" onQueryChange={vi.fn()} />,
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
        voiceErrorMessage="Model audio is unavailable."
      />,
    );

    const status = screen.getByTestId('launcher-command-listening-status');
    expect(status).toHaveAttribute('role', 'alert');
    expect(status).toHaveTextContent('Model audio is unavailable.');
  });

  it('ONE mode: a bare `listening` render is the model-audio cue (no `voiceMode` prop needed)', () => {
    renderWithChakra(
      <LauncherCommandBar query="live" onQueryChange={vi.fn()} listening onStopListening={vi.fn()} />,
    );

    expect(screen.getByTestId('launcher-command-model-listening-chip')).toHaveTextContent(
      MODEL_AUDIO_LISTENING_CHIP_COPY,
    );
    expect(screen.getByRole('searchbox')).toHaveAttribute(
      'placeholder',
      MODEL_AUDIO_LISTENING_PLACEHOLDER,
    );
    // The removed `'local'` transcription cue never renders (Spec #2914 ST-8).
    expect(screen.queryByTestId('launcher-command-listening-chip')).toBeNull();
    expect(screen.queryByText('Listening')).toBeNull();
    expect(screen.queryByTestId('launcher-command-model-processing-chip')).toBeNull();
  });
});

// ── Spec #2904 ST-1 — the end-slot width budget (the root cause) ───────────────

describe('computeEndSlotBudgetPx / computeEndPaddingPx — the model-audio budget (#2904 ST-1)', () => {
  it('derives the 374px model budget from the 560px bar (max − leading gutter − borders − min content)', () => {
    expect(BAR_MAX_WIDTH_PX).toBe(560);
    expect(BAR_FIELD_MIN_CONTENT_PX).toBe(144);
    expect(computeEndSlotBudgetPx()).toBe(
      BAR_MAX_WIDTH_PX - BAR_LEADING_GUTTER_PX - 2 - BAR_FIELD_MIN_CONTENT_PX,
    );
    expect(computeEndSlotBudgetPx()).toBe(374);
    // The arithmetic is width-linear and unit-injectable — jsdom cannot measure
    // layout, so the budget is proved ALGEBRAICALLY, never by a rendered rect.
    expect(computeEndSlotBudgetPx(900)).toBe(
      900 - BAR_LEADING_GUTTER_PX - 2 - BAR_FIELD_MIN_CONTENT_PX,
    );
    expect(computeEndSlotBudgetPx(900)).toBe(714);
  });

  it('clamps the REAL colliding composition (model chip + hint chip) so the field can never collapse', () => {
    // The defect: 220 (hint) + 208 (chip) + 30 (×) + 30 (■) + 44 (—) = 532 against
    // a 560px bar → 0px content box → one-character-per-line placeholder.
    const peListening = computeEndPaddingPx({
      showHint: true,
      listening: true,
      modelPhase: 'listening',
    });
    expect(peListening).toBe(computeEndSlotBudgetPx());
    expect(peListening).toBe(374);
    expect(
      BAR_LEADING_GUTTER_PX + (peListening ?? 0) + 2 + BAR_FIELD_MIN_CONTENT_PX,
    ).toBeLessThanOrEqual(BAR_MAX_WIDTH_PX);

    // `processing` + hint is the same defect class (220 + 248 + 44 = 512).
    const peProcessing = computeEndPaddingPx({
      showHint: true,
      listening: false,
      modelPhase: 'processing',
    });
    expect(peProcessing).toBe(computeEndSlotBudgetPx());
    expect(
      BAR_LEADING_GUTTER_PX + (peProcessing ?? 0) + 2 + BAR_FIELD_MIN_CONTENT_PX,
    ).toBeLessThanOrEqual(BAR_MAX_WIDTH_PX);

    // The budget tracks an injected bar width (a narrower bar clamps harder).
    expect(
      computeEndPaddingPx({
        showHint: true,
        listening: true,
        modelPhase: 'listening',
        barMaxWidthPx: 500,
      }),
    ).toBe(500 - BAR_LEADING_GUTTER_PX - 2 - BAR_FIELD_MIN_CONTENT_PX);
  });

  it('leaves every currently-fitting composition byte-identical (REQ-5 / no regression)', () => {
    // Truly empty bar → omit the padding entirely.
    expect(computeEndPaddingPx({ showHint: false, listening: false })).toBeUndefined();
    // Hint chip + minimize.
    expect(computeEndPaddingPx({ showHint: true, listening: false })).toBe(220 + 44);
    // Model listening WITH the hint chip collides (220 + 208 + 60 + 44 = 532) and
    // is clamped to the model budget — the ONLY chip reservation left (Spec #2914
    // ST-8 removed the `'local'` reservation).
    expect(
      computeEndPaddingPx({ showHint: true, listening: true, modelPhase: 'listening' }),
    ).toBe(computeEndSlotBudgetPx());
    // Model listening WITHOUT the hint chip reserves 208 + 60 + 44 = 312.
    expect(
      computeEndPaddingPx({ showHint: false, listening: true, modelPhase: 'listening' }),
    ).toBe(208 + 60 + 44);
  });
});

// ── Spec #2904 ST-2 — one listening claim while a model chip renders ──────────

describe('LauncherCommandBar — the model-audio composition (#2904 ST-2, REQ-3/REQ-5)', () => {
  it('suppresses the hint chip while a model chip renders and relocates the instruction into the placeholder', () => {
    // The REAL colliding composition the shipped tests omitted (`hintLabel` was
    // never passed together with a model capture — the gap that let the defect
    // through CI). jsdom cannot measure the resulting geometry; the LIVE run
    // proves REQ-1/REQ-4, and these pins prove the COMPOSITION.
    renderWithChakra(
      <LauncherCommandBar
        query=""
        onQueryChange={vi.fn()}
        listening
        modelAudioPhase="capturing"
        hintLabel="release Space to finish"
        onStopListening={vi.fn()}
        onCancelListening={vi.fn()}
      />,
    );

    // The ONLY listening claim is the model chip.
    expect(screen.getByTestId('launcher-command-model-listening-chip')).toHaveTextContent(
      MODEL_AUDIO_LISTENING_CHIP_COPY,
    );
    // The `release Space to finish` instruction chip is suppressed...
    expect(screen.queryByTestId('launcher-command-hint')).toBeNull();
    // ...and the instruction relocates into the field placeholder.
    expect(screen.getByRole('searchbox')).toHaveAttribute(
      'placeholder',
      MODEL_AUDIO_LISTENING_PLACEHOLDER,
    );
    expect(MODEL_AUDIO_LISTENING_PLACEHOLDER).toBe('release Space to finish');
  });

  it('suppresses the hint chip while the model PROCESSING chip renders too', () => {
    renderWithChakra(
      <LauncherCommandBar
        query=""
        onQueryChange={vi.fn()}
        modelAudioPhase="processing"
        hintLabel="release Space to finish"
      />,
    );

    expect(screen.getByTestId('launcher-command-model-processing-chip')).toBeInTheDocument();
    expect(screen.queryByTestId('launcher-command-hint')).toBeNull();
    expect(screen.getByRole('searchbox')).toHaveAttribute(
      'placeholder',
      MODEL_AUDIO_PROCESSING_PLACEHOLDER,
    );
  });
});

// ── The live-region copy (transition-driven) ──────────────────────────────────

describe('LauncherCommandBar — the model-audio announcements (#2897 ST-4)', () => {
  it('announces `Fredo is listening` on the capture rise and `Fredo is processing your speech` on the processing rise', () => {
    const { rerender } = renderWithChakra(
      <LauncherCommandBar query="" onQueryChange={vi.fn()} />,
    );

    const announcer = screen.getByTestId('voice-listening-announcer');
    expect(announcer.textContent).toBe('');

    rerender(
      <LauncherCommandBar query="" onQueryChange={vi.fn()} listening />,
    );
    expect(announcer).toHaveTextContent(MODEL_AUDIO_LISTENING_ANNOUNCEMENT);

    // The stop hands over to `processing`: ONE line, never `Stopped listening`.
    rerender(
      <LauncherCommandBar
        query=""
        onQueryChange={vi.fn()}
        modelAudioPhase="processing"
      />,
    );
    expect(announcer).toHaveTextContent(MODEL_AUDIO_PROCESSING_ANNOUNCEMENT);
    expect(announcer).not.toHaveTextContent('Stopped listening');
  });

  it('the mount is silent and a bare `listening` render uses the model copy (one mode)', () => {
    const { rerender } = renderWithChakra(
      <LauncherCommandBar query="" onQueryChange={vi.fn()} />,
    );
    const announcer = screen.getByTestId('voice-listening-announcer');
    expect(announcer.textContent).toBe('');

    rerender(<LauncherCommandBar query="" onQueryChange={vi.fn()} listening />);
    expect(announcer).toHaveTextContent(MODEL_AUDIO_LISTENING_ANNOUNCEMENT);
  });
});
