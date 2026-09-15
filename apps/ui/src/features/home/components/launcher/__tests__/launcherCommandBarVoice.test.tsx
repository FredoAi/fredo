/**
 * Spec #2878 ST-2 — launcher command bar: the continuous (WHILE) listening
 * contracts, the inactive-bar invariance, the a11y announcers, and the visible
 * cancel/discard affordance.
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
import { cleanup, fireEvent, screen } from '@testing-library/react';

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

  it('keeps the pre-ST-5 hint-chip gutter byte-identical', () => {
    expect(computeEndPaddingPx({ showHint: true, listening: false })).toBe(184 + 44);
  });

  it('reserves the listening chip + cancel + stop + minimize while listening', () => {
    // 72 (chip) + 30 (cancel) + 30 (stop) + 44 (minimize)
    expect(computeEndPaddingPx({ showHint: false, listening: true })).toBe(72 + 30 + 30 + 44);
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
