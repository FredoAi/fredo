/**
 * Spec #2897 ST-5 (REQ-6) — the over-limit, NON-LOSSY bounded-audio surface at the
 * launcher command bar.
 *
 * Pins:
 *   1. The pure bound arithmetic — the limit display derives from the BACKEND
 *      value (`stt:state.limitMs`), never a second hardcoded duration, and the
 *      countdown never goes negative.
 *   2. The last-`MODEL_AUDIO_WARN_S`-seconds countdown on the listening chip —
 *      absent outside the window, exact at the window edge, ticking down.
 *   3. The auto-stop LIMIT NOTICE — `launcher-command-model-limit-status`, the
 *      real bound in its copy, warning treatment (NOT `role="alert"`), announced
 *      exactly once on the rise.
 *   4. Below-bar precedence — alert (voice error) > model-audio limit > queued,
 *      measured with a present counter-element (never by hiding the loser).
 *   5. Invariance — no auto-stop / no bound render no notice; a bound-less
 *      auto-stop stays truthful (Spec #2914 ST-8: there is no `'local'` mode).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, cleanup, screen } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { QUEUED_WAITING_TESTID } from '@/shared/components/companion/companionDispatch';
import {
  LauncherCommandBar,
  MODEL_AUDIO_LIMIT_ANNOUNCEMENT,
  MODEL_AUDIO_LISTENING_CHIP_COPY,
  MODEL_AUDIO_WARN_S,
  modelAudioLimitNoticeCopy,
  modelAudioLimitSeconds,
  modelAudioListeningChipCopy,
  modelAudioSecondsLeft,
} from '../LauncherCommandBar';

const LIMIT_MS = 30_000;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

// ── The pure bound arithmetic ─────────────────────────────────────────────────

describe('model-audio bound helpers — the ONE backend-derived bound (#2897 ST-5)', () => {
  it('derives the display seconds from the backend ceiling, never a hardcoded 30', () => {
    expect(modelAudioLimitSeconds(LIMIT_MS)).toBe(30);
    expect(modelAudioLimitSeconds(45_000)).toBe(45);
    // No bound on the wire (legacy/local) ⇒ no number to invent.
    expect(modelAudioLimitSeconds(null)).toBeNull();
    expect(modelAudioLimitSeconds(undefined)).toBeNull();
    expect(modelAudioLimitSeconds(0)).toBeNull();
    expect(modelAudioLimitSeconds(-1)).toBeNull();
    expect(modelAudioLimitSeconds(Number.NaN)).toBeNull();
  });

  it('counts whole seconds left and never goes negative', () => {
    expect(modelAudioSecondsLeft(20_000, LIMIT_MS)).toBe(10);
    expect(modelAudioSecondsLeft(25_500, LIMIT_MS)).toBe(5);
    expect(modelAudioSecondsLeft(29_001, LIMIT_MS)).toBe(1);
    expect(modelAudioSecondsLeft(LIMIT_MS, LIMIT_MS)).toBe(0);
    expect(modelAudioSecondsLeft(45_000, LIMIT_MS)).toBe(0);
  });

  it('appends the countdown only when one exists, and states the real bound in the notice', () => {
    expect(modelAudioListeningChipCopy(null)).toBe(MODEL_AUDIO_LISTENING_CHIP_COPY);
    expect(modelAudioListeningChipCopy(null)).toBe('Fredo is listening');
    expect(modelAudioListeningChipCopy(MODEL_AUDIO_WARN_S)).toBe(
      'Fredo is listening · 10s left',
    );
    expect(modelAudioListeningChipCopy(3)).toBe('Fredo is listening · 3s left');

    expect(modelAudioLimitNoticeCopy(30)).toBe(
      "That's the 30-second limit — Fredo has your recording and is responding.",
    );
    expect(modelAudioLimitNoticeCopy(45)).toBe(
      "That's the 45-second limit — Fredo has your recording and is responding.",
    );
    // A wire without a bound still reads truthfully — no fabricated number.
    expect(modelAudioLimitNoticeCopy(null)).toBe(
      "That's the limit — Fredo has your recording and is responding.",
    );
  });
});

// ── The countdown ─────────────────────────────────────────────────────────────

describe('LauncherCommandBar — the last-N-seconds countdown (#2897 ST-5)', () => {
  it('shows no countdown outside the warning window and ticks down inside it', () => {
    vi.useFakeTimers();
    renderWithChakra(
      <LauncherCommandBar
        query=""
        onQueryChange={vi.fn()}
        voiceMode="model"
        listening
        modelAudioPhase="capturing"
        modelAudioLimitMs={LIMIT_MS}
      />,
    );

    const chip = screen.getByTestId('launcher-command-model-listening-chip');
    expect(chip).toHaveTextContent('Fredo is listening');
    expect(chip).not.toHaveTextContent('s left');

    // 19 s in — 11 s left: still outside the 10 s warning window.
    act(() => {
      vi.advanceTimersByTime(19_000);
    });
    expect(chip).not.toHaveTextContent('s left');

    // 20 s in — exactly 10 s left: the bound is disclosed.
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(chip).toHaveTextContent('Fredo is listening · 10s left');
    expect(MODEL_AUDIO_WARN_S).toBe(10);

    // 29 s in — 1 s left.
    act(() => {
      vi.advanceTimersByTime(9_000);
    });
    expect(chip).toHaveTextContent('Fredo is listening · 1s left');
  });

  it('renders no countdown when no bound reached the bar', () => {
    renderWithChakra(
      <LauncherCommandBar
        query=""
        onQueryChange={vi.fn()}
        voiceMode="model"
        listening
        modelAudioPhase="capturing"
      />,
    );
    const chip = screen.getByTestId('launcher-command-model-listening-chip');
    expect(chip).toHaveTextContent('Fredo is listening');
    expect(chip).not.toHaveTextContent('s left');
  });
});

// ── The auto-stop notice ──────────────────────────────────────────────────────

describe('LauncherCommandBar — the auto-stop limit notice (#2897 ST-5)', () => {
  it('renders the warning line with the REAL bound, without role="alert", and announces once', () => {
    const { rerender } = renderWithChakra(
      <LauncherCommandBar
        query=""
        onQueryChange={vi.fn()}
        voiceMode="model"
        modelAudioLimitMs={LIMIT_MS}
      />,
    );
    const announcer = screen.getByTestId('voice-listening-announcer');
    expect(announcer.textContent).toBe('');
    expect(screen.queryByTestId('launcher-command-model-limit-status')).toBeNull();

    // The auto-stop: capture ended, the whole clip is processing, the bound was hit.
    rerender(
      <LauncherCommandBar
        query=""
        onQueryChange={vi.fn()}
        voiceMode="model"
        modelAudioPhase="processing"
        modelAudioLimitMs={LIMIT_MS}
        limitReached
      />,
    );

    const notice = screen.getByTestId('launcher-command-model-limit-status');
    expect(notice).toHaveTextContent(
      "That's the 30-second limit — Fredo has your recording and is responding.",
    );
    // A NORMAL terminal capture state — never an error/alert.
    expect(notice).not.toHaveAttribute('role', 'alert');
    expect(notice).not.toHaveAttribute('role');
    // The processing chip is present: the whole clip is being interpreted.
    expect(screen.getByTestId('launcher-command-model-processing-chip')).toBeInTheDocument();
    // Announced exactly once, on the rise — never `Stopped listening`.
    expect(announcer).toHaveTextContent(MODEL_AUDIO_LIMIT_ANNOUNCEMENT);
    expect(announcer).not.toHaveTextContent('Stopped listening');

    // A plain re-render after the auto-stop does not re-announce or double-render.
    rerender(
      <LauncherCommandBar
        query=""
        onQueryChange={vi.fn()}
        voiceMode="model"
        modelAudioPhase="processing"
        modelAudioLimitMs={LIMIT_MS}
        limitReached
      />,
    );
    expect(screen.getAllByTestId('launcher-command-model-limit-status')).toHaveLength(1);
  });

  it('uses the backend bound in the copy — a different ceiling reads differently', () => {
    renderWithChakra(
      <LauncherCommandBar
        query=""
        onQueryChange={vi.fn()}
        voiceMode="model"
        modelAudioPhase="processing"
        modelAudioLimitMs={45_000}
        limitReached
      />,
    );
    expect(screen.getByTestId('launcher-command-model-limit-status')).toHaveTextContent(
      "That's the 45-second limit — Fredo has your recording and is responding.",
    );
  });

  it('no auto-stop / no bound render no notice; a bound-less auto-stop stays truthful (one mode)', () => {
    // Spec #2914 ST-8 — there is no `'local'` mode, so `limitReached` alone is a
    // model-audio terminal state: it renders the notice WITHOUT a fabricated
    // number (the wire carried no bound).
    renderWithChakra(
      <LauncherCommandBar query="" onQueryChange={vi.fn()} limitReached />,
    );
    expect(screen.getByTestId('launcher-command-model-limit-status')).toHaveTextContent(
      "That's the limit — Fredo has your recording and is responding.",
    );

    // No auto-stop ⇒ no notice, even with the bound on the wire.
    cleanup();
    renderWithChakra(
      <LauncherCommandBar
        query=""
        onQueryChange={vi.fn()}
        voiceMode="model"
        modelAudioLimitMs={LIMIT_MS}
      />,
    );
    expect(screen.queryByTestId('launcher-command-model-limit-status')).toBeNull();
  });
});

// ── Below-bar precedence ──────────────────────────────────────────────────────

describe('LauncherCommandBar — below-bar slot precedence (#2897 ST-5)', () => {
  it('the voice error alert outranks the limit notice', () => {
    renderWithChakra(
      <LauncherCommandBar
        query=""
        onQueryChange={vi.fn()}
        voiceMode="model"
        modelAudioLimitMs={LIMIT_MS}
        limitReached
        voiceErrorMessage="Model audio is unavailable."
      />,
    );

    const alert = screen.getByTestId('launcher-command-listening-status');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveTextContent('Model audio is unavailable.');
    expect(screen.queryByTestId('launcher-command-model-limit-status')).toBeNull();
  });

  it('the limit notice outranks the queued indicator', () => {
    renderWithChakra(
      <LauncherCommandBar
        query=""
        onQueryChange={vi.fn()}
        voiceMode="model"
        modelAudioLimitMs={LIMIT_MS}
        limitReached
        queuedCount={1}
      />,
    );

    expect(screen.getByTestId('launcher-command-model-limit-status')).toBeInTheDocument();
    expect(screen.queryByTestId(QUEUED_WAITING_TESTID)).toBeNull();
  });

  it('without an auto-stop the queued indicator still renders (the precedence is not a blanket hide)', () => {
    renderWithChakra(
      <LauncherCommandBar
        query=""
        onQueryChange={vi.fn()}
        voiceMode="model"
        modelAudioLimitMs={LIMIT_MS}
        queuedCount={1}
      />,
    );

    expect(screen.getByTestId(QUEUED_WAITING_TESTID)).toBeInTheDocument();
    expect(screen.queryByTestId('launcher-command-model-limit-status')).toBeNull();
  });
});
