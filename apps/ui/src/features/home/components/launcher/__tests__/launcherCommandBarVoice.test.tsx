/**
 * Spec #2878 ST-2 — launcher command bar: the continuous (WHILE) listening
 * contracts, the inactive-bar invariance, the a11y announcers, and the visible
 * cancel/discard affordance.
 *
 * #2882 ST-4 (G-125 re-points — the superseded #2871 assertions are UPDATED, not
 * deleted):
 *   • the hint-chip gutter is `220 + 44` (was `184 + 44`) — UI/UX §9 widened
 *     `HINT_CHIP_MAX_WIDTH_PX` so the longest truthful instruction
 *     (`↵ send transcript to Fredo`) can never ellipsize;
 *   • chip visibility is LABEL-DRIVEN: the #2871 `chatAvailable` gate (chip hidden
 *     whenever no companion was present) is RETIRED, so a chip shows with the
 *     companion OFF (the binding `↵ open <App>` / `no match` cases);
 *   • `aria-keyshortcuts` is an UNCONDITIONAL `Control+Space` (it advertises the
 *     bar-opening chord, not dictation) — the old `voiceEnabled`-gated pin is
 *     superseded.
 *
 * Pins:
 *   1. Live partial text renders in the input and the input stays editable while
 *      listening (only `busy` sets `readOnly`).
 *   2. `aria-busy` is OMITTED (not `"false"`) when idle.
 *   3. Zero reserved padding when no affordance shows (`computeEndPaddingPx`).
 *   4. The announcers fire once per transition (start/stop) and carry only the
 *      newest FINAL segment — never per partial.
 *   5. The Stop control stays the FINALIZE/commit control (`onStopListening`) and
 *      is NOT re-pointed at `onCancelListening` (AC3 resolution); the visible
 *      cancel affordance calls `onCancelListening` and never dispatches.
 *   6. UX-2 — `onUserEdit` fires on a manual keystroke during a live segment only.
 *   7. Inactive-bar invariance — no cue, no cancel/stop, no reserved padding.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { LauncherCommandBar, computeEndPaddingPx } from '../LauncherCommandBar';

beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ── Pure reserved-gutter contract ─────────────────────────────────────────────

describe('computeEndPaddingPx — the reserved end gutter (ST-2 invariance)', () => {
  it('omits the padding entirely when no affordance shows', () => {
    expect(computeEndPaddingPx({ showHint: false, listening: false })).toBeUndefined();
  });

  it('keeps the hint-chip gutter in step with HINT_CHIP_MAX_WIDTH_PX (220 + 44)', () => {
    // #2882 ST-4 re-point (was `184 + 44`): UI/UX §9 widened the chip so
    // `↵ send transcript to Fredo` cannot ellipsize — a truncated instruction
    // would be a lying instruction (R-6.3).
    expect(computeEndPaddingPx({ showHint: true, listening: false })).toBe(220 + 44);
  });

  it('reserves the listening chip + cancel + stop + minimize while listening', () => {
    // 72 (chip) + 30 (cancel) + 30 (stop) + 44 (minimize)
    expect(computeEndPaddingPx({ showHint: false, listening: true })).toBe(72 + 30 + 30 + 44);
  });

  // Spec #2882 ST-5 (UI/UX §9) — the S2 pending chip occupies the SAME slot and
  // the SAME width as the Listening chip, so typed text never runs under it.
  it('reserves the pending chip gutter while the hold is pending (S2)', () => {
    expect(computeEndPaddingPx({ showHint: false, listening: false, holdPending: true })).toBe(
      72 + 44,
    );
  });

  it('never double-counts the chip slot: pending is not reserved while live', () => {
    expect(computeEndPaddingPx({ showHint: false, listening: true, holdPending: true })).toBe(
      72 + 30 + 30 + 44,
    );
  });
});

// ── #2882 ST-5 — the hold-Space cue (R-2.4) ───────────────────────────────────

describe('LauncherCommandBar — the hold-Space cue (ST-5)', () => {
  it('shows the cue from the ARMED moment, with no live indicator yet', () => {
    renderWithChakra(<LauncherCommandBar query="" onQueryChange={vi.fn()} holdArmed />);

    expect(screen.getByRole('searchbox')).toHaveAttribute('placeholder', 'Listening…');
    // Armed is not live: the dot, the Listening chip and its controls stay absent
    // (nothing may be stopped before a session exists).
    expect(screen.queryByTestId('launcher-command-listening')).toBeNull();
    expect(screen.queryByTestId('launcher-command-listening-chip')).toBeNull();
    expect(screen.queryByTestId('launcher-command-listening-stop')).toBeNull();
    expect(screen.queryByTestId('launcher-command-listening-pending')).toBeNull();
  });

  it('renders the bounded `starting voice input…` chip while the hold is pending', () => {
    renderWithChakra(<LauncherCommandBar query="" onQueryChange={vi.fn()} holdPending />);

    expect(screen.getByTestId('launcher-command-listening-pending')).toHaveTextContent(
      'starting voice input…',
    );
    expect(screen.getByRole('searchbox')).toHaveAttribute('placeholder', 'Listening…');
    // Exactly ONE indicator: no Listening chip / dot / controls in this state.
    expect(screen.queryByTestId('launcher-command-listening-chip')).toBeNull();
    expect(screen.queryByTestId('launcher-command-listening')).toBeNull();
  });

  it('never renders the pending chip and the Listening chip together (one slot)', () => {
    renderWithChakra(
      <LauncherCommandBar
        query=""
        onQueryChange={vi.fn()}
        listening
        holdPending
        onStopListening={vi.fn()}
      />,
    );

    expect(screen.getByTestId('launcher-command-listening-chip')).toHaveTextContent('Listening');
    expect(screen.queryByTestId('launcher-command-listening-pending')).toBeNull();
  });

  it('offers the S1 promise placeholder only while focused, empty and available', () => {
    const { rerender } = renderWithChakra(
      <LauncherCommandBar query="" onQueryChange={vi.fn()} holdAvailable />,
    );
    const input = screen.getByRole('searchbox');
    // Unfocused (S0) — the legacy resting copy.
    expect(input).toHaveAttribute('placeholder', 'search or command');

    act(() => {
      input.focus();
      fireEvent.focus(input);
    });
    expect(input).toHaveAttribute('placeholder', 'search, or hold Space to dictate');

    // The cue outranks the promise: an armed hold shows the gesture, not the offer.
    rerender(<LauncherCommandBar query="" onQueryChange={vi.fn()} holdAvailable holdArmed />);
    expect(input).toHaveAttribute('placeholder', 'Listening…');

    // Once the bar holds text the promise is withdrawn (the gesture is unavailable).
    rerender(<LauncherCommandBar query="set" onQueryChange={vi.fn()} holdAvailable />);
    expect(input).toHaveAttribute('placeholder', 'search or command');
  });

  it('withdraws the promise when the hold is unavailable (readiness unknown — no promise made)', () => {
    renderWithChakra(<LauncherCommandBar query="" onQueryChange={vi.fn()} />);
    const input = screen.getByRole('searchbox');
    act(() => {
      input.focus();
      fireEvent.focus(input);
    });
    expect(input).toHaveAttribute('placeholder', 'search or command');
  });
});

// ── Inactive-bar invariance ───────────────────────────────────────────────────

describe('LauncherCommandBar — inactive-bar invariance (AC5)', () => {
  it('renders no listening cue, no cancel/stop control and no aria-busy when idle', () => {
    const { container } = renderWithChakra(<LauncherCommandBar query="" onQueryChange={vi.fn()} />);

    expect(screen.queryByTestId('launcher-command-listening')).toBeNull();
    expect(screen.queryByTestId('launcher-command-listening-chip')).toBeNull();
    expect(screen.queryByTestId('launcher-command-listening-cancel')).toBeNull();
    expect(screen.queryByTestId('launcher-command-listening-stop')).toBeNull();
    // `aria-busy` is OMITTED (never rendered as "false").
    expect(container.querySelector('[aria-busy]')).toBeNull();
    expect(screen.getByRole('searchbox')).toHaveAttribute('placeholder', 'search or command');
  });

  it('keeps the input editable while idle', () => {
    renderWithChakra(<LauncherCommandBar query="typed" onQueryChange={vi.fn()} />);
    const input = screen.getByRole('searchbox') as HTMLInputElement;
    expect(input).not.toHaveAttribute('readonly');
    expect(input.value).toBe('typed');
  });
});

// ── #2882 ST-4 — label-driven hint chip + the unconditional chord ─────────────

describe('LauncherCommandBar — label-driven hint chip (G-125 re-point of the #2871 chatAvailable gate)', () => {
  it('shows the chip with NO companion signal at all when the host supplies a label', () => {
    // The binding app-match case: `↵ open Settings` must reach the user (and AT)
    // even with the companion OFF. The retired `chatAvailable` prop is NOT passed
    // (it no longer exists), which is exactly the point.
    renderWithChakra(
      <LauncherCommandBar
        query="set"
        onQueryChange={vi.fn()}
        hintLabel="↵ open Settings"
        ariaDescribedBy="fredo-command-hint"
      />,
    );

    expect(screen.getByTestId('launcher-command-hint')).toHaveTextContent('↵ open Settings');
  });

  it('shows the `no match` chip with no companion — the truthful non-promise', () => {
    renderWithChakra(
      <LauncherCommandBar query="MM" onQueryChange={vi.fn()} hintLabel="no match" />,
    );
    expect(screen.getByTestId('launcher-command-hint')).toHaveTextContent('no match');
  });

  it('renders no chip when the host supplies no label', () => {
    renderWithChakra(<LauncherCommandBar query="set" onQueryChange={vi.fn()} />);
    expect(screen.queryByTestId('launcher-command-hint')).toBeNull();
    // No chip ⇒ no reserved gutter and no SR mirror.
    expect(screen.getByRole('searchbox')).not.toHaveAttribute('aria-describedby');
  });

  it('mirrors the chip text for AT while a label shows (and reserves the widened gutter)', () => {
    // The gutter number itself is pinned by `computeEndPaddingPx` above; here the
    // wiring is pinned: a visible label ⇒ an SR description pointing at the mirror.
    renderWithChakra(
      <LauncherCommandBar
        query="set"
        onQueryChange={vi.fn()}
        hintLabel="↵ open Settings"
        ariaDescribedBy="fredo-command-hint"
      />,
    );

    expect(screen.getByRole('searchbox')).toHaveAttribute('aria-describedby', 'fredo-command-hint');
    expect(screen.getByTestId('fredo-command-hint-sr')).toHaveTextContent('↵ open Settings');
  });

  it('advertises `Control+Space` UNCONDITIONALLY (G-125 re-point of the voiceEnabled-gated pin)', () => {
    // The chord always shows/focuses the bar, so it is advertised whether or not
    // voice input is available; it is no longer a voice affordance.
    const { rerender } = renderWithChakra(
      <LauncherCommandBar query="" onQueryChange={vi.fn()} />,
    );
    expect(screen.getByRole('searchbox')).toHaveAttribute('aria-keyshortcuts', 'Control+Space');

    rerender(<LauncherCommandBar query="" onQueryChange={vi.fn()} voiceEnabled />);
    expect(screen.getByRole('searchbox')).toHaveAttribute('aria-keyshortcuts', 'Control+Space');
  });
});

// ── WHILE listening contracts ─────────────────────────────────────────────────

describe('LauncherCommandBar — continuous listening state', () => {
  it('renders live partial text in the input and keeps it editable', () => {
    renderWithChakra(
      <LauncherCommandBar query="hello wor" onQueryChange={vi.fn()} listening onStopListening={vi.fn()} />,
    );
    const input = screen.getByRole('searchbox') as HTMLInputElement;
    expect(input.value).toBe('hello wor');
    expect(input).not.toHaveAttribute('readonly');
    expect(input).toHaveAttribute('placeholder', 'Listening…');
  });

  it('only `busy` sets readOnly + aria-busy', () => {
    const { container } = renderWithChakra(
      <LauncherCommandBar query="hello" onQueryChange={vi.fn()} busy />,
    );
    const input = screen.getByRole('searchbox') as HTMLInputElement;
    expect(input).toHaveAttribute('readonly');
    expect(container.querySelector('[aria-busy]')).not.toBeNull();
    expect(input).toHaveAttribute('placeholder', 'Fredo is replying…');
  });

  it('renders the frozen dot + Listening chip + the cancel and Stop controls while listening', () => {
    renderWithChakra(
      <LauncherCommandBar
        query="x"
        onQueryChange={vi.fn()}
        listening
        onStopListening={vi.fn()}
        onCancelListening={vi.fn()}
      />,
    );
    expect(screen.getByTestId('launcher-command-listening')).toBeInTheDocument();
    expect(screen.getByTestId('launcher-command-listening-chip')).toHaveTextContent('Listening');
    expect(screen.getByTestId('launcher-command-listening-stop')).toHaveAttribute(
      'aria-label',
      'Stop listening',
    );
    expect(screen.getByTestId('launcher-command-listening-cancel')).toHaveAttribute(
      'aria-label',
      'Cancel dictation',
    );
  });
});

// ── Cancel vs Stop (AC3 resolution) ───────────────────────────────────────────

describe('LauncherCommandBar — cancel/discard vs finalize/commit (AC3)', () => {
  it('the cancel affordance calls onCancelListening and the Stop calls onStopListening', () => {
    const onStop = vi.fn();
    const onCancel = vi.fn();
    renderWithChakra(
      <LauncherCommandBar
        query="x"
        onQueryChange={vi.fn()}
        listening
        onStopListening={onStop}
        onCancelListening={onCancel}
      />,
    );

    fireEvent.click(screen.getByTestId('launcher-command-listening-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('launcher-command-listening-stop'));
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('never renders the cancel affordance without an explicit handler', () => {
    renderWithChakra(
      <LauncherCommandBar query="x" onQueryChange={vi.fn()} listening onStopListening={vi.fn()} />,
    );
    expect(screen.queryByTestId('launcher-command-listening-cancel')).toBeNull();
  });
});

// ── UX-2 manual edit signal ───────────────────────────────────────────────────

describe('LauncherCommandBar — UX-2 manual-edit signal', () => {
  it('reports a manual keystroke while listening', () => {
    const onUserEdit = vi.fn();
    const onQueryChange = vi.fn();
    renderWithChakra(
      <LauncherCommandBar
        query="helo"
        onQueryChange={onQueryChange}
        listening
        onStopListening={vi.fn()}
        onUserEdit={onUserEdit}
      />,
    );

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'hello' } });
    expect(onQueryChange).toHaveBeenCalledWith('hello');
    expect(onUserEdit).toHaveBeenCalledTimes(1);
  });

  it('does NOT report edits while idle (normal typing)', () => {
    const onUserEdit = vi.fn();
    renderWithChakra(
      <LauncherCommandBar query="" onQueryChange={vi.fn()} onUserEdit={onUserEdit} />,
    );

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'abc' } });
    expect(onUserEdit).not.toHaveBeenCalled();
  });
});

// ── Announcers (DR-10 / R-5.3) ────────────────────────────────────────────────

describe('LauncherCommandBar — announcers', () => {
  it('the listening announcer fires on the start/stop transition only', () => {
    const { rerender } = renderWithChakra(
      <LauncherCommandBar query="" onQueryChange={vi.fn()} />,
    );
    const announcer = screen.getByTestId('voice-listening-announcer');
    expect(announcer).toHaveTextContent('');

    rerender(<LauncherCommandBar query="" onQueryChange={vi.fn()} listening />);
    expect(announcer).toHaveTextContent('Listening');

    // A partial-only re-render (same `listening`) must NOT re-announce.
    rerender(<LauncherCommandBar query="partial text" onQueryChange={vi.fn()} listening />);
    expect(announcer).toHaveTextContent('Listening');

    rerender(<LauncherCommandBar query="partial text" onQueryChange={vi.fn()} />);
    expect(announcer).toHaveTextContent('Stopped listening');
  });

  it('the transcript announcer carries only the newest FINAL prop', () => {
    const { rerender } = renderWithChakra(
      <LauncherCommandBar query="partial" onQueryChange={vi.fn()} listening />,
    );
    const announcer = screen.getByTestId('voice-transcript-announcer');
    // A live partial lives in `query`, never in the transcript region.
    expect(announcer).toHaveTextContent('');

    rerender(
      <LauncherCommandBar
        query="partial"
        onQueryChange={vi.fn()}
        listening
        finalTranscript="hello world"
      />,
    );
    expect(announcer).toHaveTextContent('hello world');
  });
});
