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
 * #2887 ST-5 (the honest hold cue): the armed/pending windows are re-pointed from
 * `Listening…` to the acknowledgement (`Hold to dictate…`), and the binding
 * `HoldCue` contract (`'listening'` ONLY while `captureLive`) is pinned — including
 * the clamp that makes a `cue="listening"` without a live capture a non-listener, so
 * the #2882 defect (armed → `Listening…`) can never recur.
 *
 * #2892 ST-5 (AC1/AC2/AC3/AC5/AC7): `busy` means a reply GENERATION is in flight
 * and NO reply state sets `readOnly`; the below-bar queued indicator + its hidden
 * transition-driven announcer and the composed `aria-describedby` are pinned.
 *
 * Pins:
 *   1. Live partial text renders in the input and the input stays editable while
 *      listening AND while busy (no reply state sets `readOnly` — AC1).
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
import {
  BAR_FIELD_MAX_H_PX,
  BAR_FIELD_MIN_H_PX,
  HEARING_NOTHING_COPY,
  HEARING_NOTHING_MS,
  LauncherCommandBar,
  QUEUED_DISPATCH_ANNOUNCEMENT,
  QUEUED_INDICATOR_ID,
  computeEndPaddingPx,
  measureFieldHeightPx,
} from '../LauncherCommandBar';

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

describe('computeEndPaddingPx — the reserved end gutter (#2883 ST-1 re-point: the `hasText` term)', () => {
  it('omits the padding entirely when nothing shows AND the bar holds no text (the truly empty bar)', () => {
    // #2883 ST-1 keeps the shipped #2878 pin verbatim for the truly empty bar:
    // no chip/listening AND no text ⇒ omit the padding (byte-identical idle bar).
    expect(computeEndPaddingPx({ showHint: false, listening: false })).toBeUndefined();
    expect(
      computeEndPaddingPx({ showHint: false, listening: false, hasText: false }),
    ).toBeUndefined();
  });

  it('#2883 ST-1 re-point — reserves the always-present divider + MINIMIZE (44) as soon as the bar holds text', () => {
    // The defect this closes: with no chip the shipped helper returned
    // `undefined`, so the query ran under the always-present MINIMIZE control
    // (the field had no reserved gutter at all). Text ⇒ the 44px footprint.
    expect(computeEndPaddingPx({ showHint: false, listening: false, hasText: true })).toBe(44);
  });

  it('#2883 ST-1 — a whitespace-only / newline-only query is still text (a caret can sit after it)', () => {
    // `hasText` is `query.length > 0`, not `query.trim() !== ''`: a bare space or
    // a `Shift+Enter` newline still puts a caret in the end-slot band.
    expect(computeEndPaddingPx({ showHint: false, listening: false, hasText: true })).toBe(44);
  });

  it('keeps the hint-chip gutter in step with HINT_CHIP_MAX_WIDTH_PX (220 + 44)', () => {
    // #2882 ST-4 re-point (was `184 + 44`): UI/UX §9 widened the chip so
    // `↵ send transcript to Fredo` cannot ellipsize — a truncated instruction
    // would be a lying instruction (R-6.3).
    expect(computeEndPaddingPx({ showHint: true, listening: false })).toBe(220 + 44);
  });

  it('#2883 ST-1 — text with the chip never double-counts the MINIMIZE footprint', () => {
    expect(computeEndPaddingPx({ showHint: true, listening: false, hasText: true })).toBe(220 + 44);
  });

  it('reserves the MODEL listening chip + cancel + stop + minimize while listening', () => {
    // 208 (model chip) + 30 (cancel) + 30 (stop) + 44 (minimize). Spec #2914 ST-8:
    // the removed `'local'` 72px chip reservation is gone.
    expect(
      computeEndPaddingPx({ showHint: false, listening: true, modelPhase: 'listening' }),
    ).toBe(208 + 30 + 30 + 44);
  });

  it('#2883 ST-1 — live listening with text stays at the same single reservation', () => {
    expect(
      computeEndPaddingPx({ showHint: false, listening: true, hasText: true, modelPhase: 'listening' }),
    ).toBe(208 + 30 + 30 + 44);
  });

  // Spec #2882 ST-5 (UI/UX §9) — the S2 pending chip occupies the SAME slot as
  // the capture chips, so typed text never runs under it.
  it('reserves the pending chip gutter while the hold is pending (S2)', () => {
    expect(computeEndPaddingPx({ showHint: false, listening: false, holdPending: true })).toBe(
      72 + 44,
    );
  });

  it('never double-counts the chip slot: pending is not reserved while live', () => {
    expect(
      computeEndPaddingPx({ showHint: false, listening: true, holdPending: true, modelPhase: 'listening' }),
    ).toBe(208 + 30 + 30 + 44);
  });
});

// ── #2883 ST-1 — the pure growth rule ─────────────────────────────────────────

describe('measureFieldHeightPx — the pure growth rule (#2883 ST-1, R-1.1/R-1.3)', () => {
  it('is 48px at one content line and adds exactly one 20px step per line', () => {
    // `scrollHeight` spans the PADDING box (20n + 2 × 13), so the 2 × 1px border
    // is added back to land on the bound border-box heights 48 / 68 / 88 / 108.
    expect(measureFieldHeightPx(46)).toBe(48); // n = 1
    expect(measureFieldHeightPx(66)).toBe(68); // n = 2
    expect(measureFieldHeightPx(86)).toBe(88); // n = 3
    expect(measureFieldHeightPx(106)).toBe(108); // n = 4 — exactly at the cap
  });

  it('freezes at the 108px cap for any taller content (R-1.3 → internal scroll)', () => {
    expect(measureFieldHeightPx(126)).toBe(BAR_FIELD_MAX_H_PX); // n = 5
    expect(measureFieldHeightPx(5000)).toBe(BAR_FIELD_MAX_H_PX);
  });

  it('never returns less than the 48px base (empty or unmeasurable content)', () => {
    expect(measureFieldHeightPx(0)).toBe(BAR_FIELD_MIN_H_PX);
    expect(measureFieldHeightPx(-10)).toBe(BAR_FIELD_MIN_H_PX);
    expect(measureFieldHeightPx(Number.NaN)).toBe(BAR_FIELD_MIN_H_PX);
  });
});

// ── #2882 ST-5 / #2887 ST-5 — the hold-Space cue (R-2.4 → R-3) ────────────────
//
// #2887 ST-5 re-points the copy: the ARMED window and the bounded start window
// are NON-listeners. `Listening…` is reserved for a genuinely live capture (S2),
// so the two stale `Listening…`-for-armed expectations are updated (G-125 — the
// #2882 gesture contract they sat next to is untouched).

describe('LauncherCommandBar — the honest hold-Space cue (#2887 ST-5)', () => {
  it('R-3: the ARMED window shows the acknowledgement, never `Listening…` and no live indicator', () => {
    renderWithChakra(<LauncherCommandBar query="" onQueryChange={vi.fn()} holdArmed />);

    // #2887 ST-5 (was `Listening…` — the honesty defect): the armed window is a
    // non-listening acknowledgement of the user's own gesture.
    expect(screen.getByRole('searchbox')).toHaveAttribute('placeholder', 'Hold to dictate…');
    // Armed is not live: the dot, the Listening chip and its controls stay absent
    // (nothing may be stopped before a session exists), and no chip shows.
    expect(screen.queryByTestId('launcher-command-listening')).toBeNull();
    expect(screen.queryByTestId('launcher-command-listening-chip')).toBeNull();
    expect(screen.queryByTestId('launcher-command-listening-stop')).toBeNull();
    expect(screen.queryByTestId('launcher-command-listening-cancel')).toBeNull();
    expect(screen.queryByTestId('launcher-command-listening-pending')).toBeNull();
  });

  it('R-3: the bounded `starting voice input…` chip renders while pending — with the acknowledgement, never `Listening…`', () => {
    renderWithChakra(<LauncherCommandBar query="" onQueryChange={vi.fn()} holdPending />);

    expect(screen.getByTestId('launcher-command-listening-pending')).toHaveTextContent(
      'starting voice input…',
    );
    // #2887 ST-5 (was `Listening…`): the field still acknowledges the gesture; the
    // chip says what is actually happening. Neither claims capture.
    expect(screen.getByRole('searchbox')).toHaveAttribute('placeholder', 'Hold to dictate…');
    // Exactly ONE indicator: no Listening chip / dot / controls in this state.
    expect(screen.queryByTestId('launcher-command-listening-chip')).toBeNull();
    expect(screen.queryByTestId('launcher-command-listening')).toBeNull();
  });

  it('R-3: never renders the pending chip and a capture chip together (one slot)', () => {
    renderWithChakra(
      <LauncherCommandBar
        query=""
        onQueryChange={vi.fn()}
        listening
        holdPending
        onStopListening={vi.fn()}
      />,
    );

    expect(screen.getByTestId('launcher-command-model-listening-chip')).toHaveTextContent(
      'Fredo is listening',
    );
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

    // The cue outranks the promise: an armed hold shows the gesture acknowledgement,
    // not the offer — and not a listening claim (#2887 ST-5, was `Listening…`).
    rerender(<LauncherCommandBar query="" onQueryChange={vi.fn()} holdAvailable holdArmed />);
    expect(input).toHaveAttribute('placeholder', 'Hold to dictate…');

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

// ── #2887 ST-5 — the binding `HoldCue` contract (R-3/AC3) ─────────────────────

describe('LauncherCommandBar — the `cue` contract may never claim listening early (#2887 ST-5)', () => {
  it('`acknowledge` is a pure acknowledgement: no dot, no chip, no controls, no accent tint', () => {
    renderWithChakra(<LauncherCommandBar query="" onQueryChange={vi.fn()} cue="acknowledge" />);

    const input = screen.getByTestId('launcher-command-input');
    expect(input).toHaveAttribute('placeholder', 'Hold to dictate…');
    expect(screen.queryByTestId('launcher-command-listening')).toBeNull();
    expect(screen.queryByTestId('launcher-command-listening-chip')).toBeNull();
    expect(screen.queryByTestId('launcher-command-listening-stop')).toBeNull();
    expect(screen.queryByTestId('launcher-command-listening-cancel')).toBeNull();
    expect(screen.queryByTestId('launcher-command-listening-pending')).toBeNull();
    // The accent border tint is a capture-only mark (`tint` colour-mix) — the
    // acknowledgement keeps the shipped neutral border token.
    expect(fieldDeclarations(input)['border-color']).toBe('var(--border-color)');
  });

  it('`starting` (the ONE bounded start window — no residency tier) shows the bounded chip + the acknowledgement, never `Listening`', () => {
    renderWithChakra(<LauncherCommandBar query="" onQueryChange={vi.fn()} cue="starting" />);

    expect(screen.getByTestId('launcher-command-listening-pending')).toHaveTextContent(
      'starting voice input…',
    );
    expect(screen.getByRole('searchbox')).toHaveAttribute('placeholder', 'Hold to dictate…');
    expect(screen.queryByTestId('launcher-command-listening-chip')).toBeNull();
    expect(screen.queryByTestId('launcher-command-listening')).toBeNull();
    expect(screen.queryByTestId('launcher-command-listening-stop')).toBeNull();
    // Spec #2914 ST-9 (G-125 re-point) — the deleted residency-derived `warming`
    // tier shared this exact non-listening state, so its "no listening wording at
    // all" assertions fold into THIS pin (no assertion dropped).
    expect(screen.queryByText('Listening')).toBeNull();
    expect(screen.queryByText('Listening…')).toBeNull();
  });

  it('`listening` renders the capture cue ONLY with a live capture', () => {
    renderWithChakra(
      <LauncherCommandBar
        query="live"
        onQueryChange={vi.fn()}
        cue="listening"
        listening
        onStopListening={vi.fn()}
      />,
    );
    // Spec #2914 ST-8 — one mode: the model-audio cue is the only capture cue.
    expect(screen.getByRole('searchbox')).toHaveAttribute('placeholder', 'release Space to finish');
    expect(screen.getByTestId('launcher-command-model-listening-chip')).toHaveTextContent(
      'Fredo is listening',
    );
    expect(screen.getByTestId('launcher-command-listening')).toBeInTheDocument();
  });

  it('CLAMP: a `listening` cue WITHOUT a live capture never claims listening (the shipped defect)', () => {
    // The honesty invariant (R-3) is enforced by the bar itself: capture is not
    // live, so the cue is clamped to the acknowledgement — the pre-#2887 defect
    // (`holdArmed` → `Listening…`) cannot recur through the new prop either.
    renderWithChakra(<LauncherCommandBar query="" onQueryChange={vi.fn()} cue="listening" />);

    expect(screen.getByRole('searchbox')).toHaveAttribute('placeholder', 'Hold to dictate…');
    expect(screen.queryByTestId('launcher-command-listening-chip')).toBeNull();
    expect(screen.queryByTestId('launcher-command-listening')).toBeNull();
    expect(screen.queryByTestId('launcher-command-listening-stop')).toBeNull();
    expect(screen.queryByTestId('launcher-command-listening-pending')).toBeNull();
    expect(screen.queryByText('Listening')).toBeNull();
  });

  it('`cue` is authoritative over the legacy `holdArmed`/`holdPending` booleans', () => {
    renderWithChakra(
      <LauncherCommandBar query="" onQueryChange={vi.fn()} cue="acknowledge" holdPending />,
    );
    expect(screen.getByRole('searchbox')).toHaveAttribute('placeholder', 'Hold to dictate…');
    expect(screen.queryByTestId('launcher-command-listening-pending')).toBeNull();
  });

  it('reserves the chip gutter for the `starting` cue (typed text never runs under the chip)', () => {
    renderWithChakra(<LauncherCommandBar query="" onQueryChange={vi.fn()} cue="starting" />);
    const decl = fieldDeclarations(screen.getByTestId('launcher-command-input'));
    expect(decl['padding-inline-end']).toBe('116px'); // 72 chip + 44 minimize
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
    // #2883 ST-1 re-point: the field is a `<textarea>` now — the role query is
    // the tag-agnostic anchor (every #2882 selector/predicate keeps working).
    const input = screen.getByRole('searchbox') as HTMLTextAreaElement;
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
    // #2883 ST-1 (a11y): the STATIC newline sentence is appended INSIDE this same
    // mirror, so the searchbox keeps its shipped `aria-describedby` value.
    expect(screen.getByTestId('fredo-command-hint-sr')).toHaveTextContent(
      'Shift+Enter starts a new line.',
    );
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
  it('renders the host text in the input and keeps it editable while capture is live', () => {
    renderWithChakra(
      <LauncherCommandBar query="hello wor" onQueryChange={vi.fn()} listening onStopListening={vi.fn()} />,
    );
    // #2883 ST-1 re-point: `as HTMLTextAreaElement` (the element is a textarea).
    const input = screen.getByRole('searchbox') as HTMLTextAreaElement;
    expect(input.value).toBe('hello wor');
    expect(input).not.toHaveAttribute('readonly');
    // Spec #2914 ST-8 — one mode: the model-audio capture placeholder.
    expect(input).toHaveAttribute('placeholder', 'release Space to finish');
  });

  it('ST-5 REFRESHED PIN: `busy` sets aria-busy + the replying placeholder but NEVER readOnly', () => {
    // Supersedes "only `busy` sets readOnly + aria-busy": #2892 ST-5 (AC1) deletes
    // `readOnly={busy}` — the field stays focusable and typeable in every reply
    // state. Only the placeholder/aria-busy/dot key on `busy`.
    const onQueryChange = vi.fn();
    const { container } = renderWithChakra(
      <LauncherCommandBar query="hello" onQueryChange={onQueryChange} busy />,
    );
    // #2883 ST-1 re-point: `as HTMLTextAreaElement` (the element is a textarea).
    const input = screen.getByRole('searchbox') as HTMLTextAreaElement;
    expect(input).not.toHaveAttribute('readonly');
    expect(container.querySelector('[aria-busy]')).not.toBeNull();
    expect(input).toHaveAttribute('placeholder', 'Fredo is replying…');
    // The field is still editable: a change is reported to the host.
    fireEvent.change(input, { target: { value: 'hello again' } });
    expect(onQueryChange).toHaveBeenCalledWith('hello again');
  });

  it('renders the frozen dot + model chip + the cancel and Stop controls while listening', () => {
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
    expect(screen.getByTestId('launcher-command-model-listening-chip')).toHaveTextContent(
      'Fredo is listening',
    );
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

// ── #2892 ST-5 — the queued-message affordance (AC5/AC7, REQ-5/REQ-12) ────────

describe('LauncherCommandBar — the queued waiting indicator + announcer (#2892 ST-5)', () => {
  const queued = () => screen.queryByTestId('launcher-command-queued');
  const announcer = () => screen.getByTestId('launcher-queued-announcer');

  afterEach(() => {
    // Restore the inherited getter so the measurement stub never leaks, and drop
    // the fake timers the hearing-nothing precedence case arms.
    delete (HTMLTextAreaElement.prototype as unknown as { scrollHeight?: unknown }).scrollHeight;
    vi.useRealTimers();
  });

  it('renders the bound copy + testid + id for a single queued send', () => {
    renderWithChakra(<LauncherCommandBar query="" onQueryChange={vi.fn()} queuedCount={1} />);

    const el = queued();
    expect(el).not.toBeNull();
    expect(el).toHaveTextContent('Queued — waiting for Fredo…');
    expect(el).toHaveAttribute('id', QUEUED_INDICATOR_ID);
  });

  it('renders the counted form for two or more queued sends', () => {
    const { rerender } = renderWithChakra(
      <LauncherCommandBar query="" onQueryChange={vi.fn()} queuedCount={2} />,
    );
    expect(queued()).toHaveTextContent('2 queued — waiting for Fredo…');

    rerender(<LauncherCommandBar query="" onQueryChange={vi.fn()} queuedCount={5} />);
    expect(queued()).toHaveTextContent('5 queued — waiting for Fredo…');
  });

  it('decrements on rerender and unmounts at zero (AC5)', () => {
    const { rerender } = renderWithChakra(
      <LauncherCommandBar query="" onQueryChange={vi.fn()} queuedCount={2} />,
    );
    expect(queued()).toHaveTextContent('2 queued — waiting for Fredo…');

    rerender(<LauncherCommandBar query="" onQueryChange={vi.fn()} queuedCount={1} />);
    expect(queued()).toHaveTextContent('Queued — waiting for Fredo…');

    rerender(<LauncherCommandBar query="" onQueryChange={vi.fn()} queuedCount={0} />);
    expect(queued()).toBeNull();
  });

  it('does not render when queuedCount is omitted or zero (inactive-bar invariance, AC4)', () => {
    renderWithChakra(<LauncherCommandBar query="" onQueryChange={vi.fn()} />);
    expect(queued()).toBeNull();
  });

  it('PRECEDENCE: an alert (voice error) suppresses the queued indicator', () => {
    renderWithChakra(
      <LauncherCommandBar
        query=""
        onQueryChange={vi.fn()}
        queuedCount={3}
        voiceErrorMessage="Could not start voice input."
      />,
    );

    expect(screen.getByTestId('launcher-command-listening-status')).toHaveTextContent(
      'Could not start voice input.',
    );
    expect(queued()).toBeNull();
  });

  it('PRECEDENCE: the hearing-nothing hint suppresses the queued indicator', () => {
    vi.useFakeTimers();
    renderWithChakra(
      <LauncherCommandBar
        query=""
        onQueryChange={vi.fn()}
        listening
        queuedCount={2}
        onStopListening={vi.fn()}
      />,
    );

    act(() => {
      vi.advanceTimersByTime(HEARING_NOTHING_MS);
    });

    expect(screen.getByTestId('launcher-command-listening-status')).toHaveTextContent(
      HEARING_NOTHING_COPY,
    );
    expect(queued()).toBeNull();
  });

  it('PRECEDENCE: the queued indicator outranks the newline caption (one line at a time)', async () => {
    stubScrollHeight(66); // wrapped to 2 visual lines — the caption's precondition
    const { rerender } = renderWithChakra(
      <LauncherCommandBar query="a wrapped query" onQueryChange={vi.fn()} newlineHint queuedCount={1} />,
    );
    await flushFieldMeasure();
    expect(queued()).not.toBeNull();
    expect(screen.queryByTestId('launcher-command-newline-caption')).toBeNull();

    // Draining the queue returns the slot to the caption.
    rerender(
      <LauncherCommandBar query="a wrapped query" onQueryChange={vi.fn()} newlineHint queuedCount={0} />,
    );
    await flushFieldMeasure();
    expect(screen.getByTestId('launcher-command-newline-caption')).toHaveTextContent(
      'Shift+Enter adds a new line',
    );
  });

  it('composes aria-describedby from the queued indicator only', () => {
    renderWithChakra(<LauncherCommandBar query="" onQueryChange={vi.fn()} queuedCount={1} />);
    expect(screen.getByRole('searchbox')).toHaveAttribute(
      'aria-describedby',
      QUEUED_INDICATOR_ID,
    );
  });

  it('composes aria-describedby from the hint mirror AND the queued indicator', () => {
    renderWithChakra(
      <LauncherCommandBar
        query="set"
        onQueryChange={vi.fn()}
        hintLabel="↵ open Settings"
        ariaDescribedBy="fredo-command-hint"
        queuedCount={1}
      />,
    );
    expect(screen.getByRole('searchbox')).toHaveAttribute(
      'aria-describedby',
      'fredo-command-hint fredo-command-queued',
    );
  });

  it('omits aria-describedby entirely when neither target is rendered (no dangling ids)', () => {
    renderWithChakra(
      <LauncherCommandBar query="set" onQueryChange={vi.fn()} hintLabel="↵ open Settings" />,
    );
    expect(screen.getByRole('searchbox')).not.toHaveAttribute('aria-describedby');
  });

  it('the queued announcer is ALWAYS mounted as a polite atomic status region and starts silent', () => {
    renderWithChakra(<LauncherCommandBar query="" onQueryChange={vi.fn()} />);
    const el = announcer();
    expect(el).toHaveAttribute('role', 'status');
    expect(el).toHaveAttribute('aria-live', 'polite');
    expect(el).toHaveAttribute('aria-atomic', 'true');
    expect(el.textContent).toBe('');
  });

  it('announces the waiting copy on the 0→n rise and the counted form on n→m (transition-driven)', () => {
    const { rerender } = renderWithChakra(
      <LauncherCommandBar query="" onQueryChange={vi.fn()} />,
    );
    expect(announcer().textContent).toBe('');

    rerender(<LauncherCommandBar query="" onQueryChange={vi.fn()} queuedCount={1} />);
    expect(announcer()).toHaveTextContent('Queued — waiting for Fredo…');

    rerender(<LauncherCommandBar query="" onQueryChange={vi.fn()} queuedCount={3} />);
    expect(announcer()).toHaveTextContent('3 queued — waiting for Fredo…');

    // A no-change re-render is silent (never per event).
    rerender(<LauncherCommandBar query="x" onQueryChange={vi.fn()} queuedCount={3} />);
    expect(announcer()).toHaveTextContent('3 queued — waiting for Fredo…');
  });

  it('announces the decrement, then the drain-edge dispatch sentence at zero', () => {
    const { rerender } = renderWithChakra(
      <LauncherCommandBar query="" onQueryChange={vi.fn()} />,
    );

    rerender(<LauncherCommandBar query="" onQueryChange={vi.fn()} queuedCount={2} />);
    expect(announcer()).toHaveTextContent('2 queued — waiting for Fredo…');

    rerender(<LauncherCommandBar query="" onQueryChange={vi.fn()} queuedCount={1} />);
    expect(announcer()).toHaveTextContent('Queued — waiting for Fredo…');

    rerender(<LauncherCommandBar query="" onQueryChange={vi.fn()} queuedCount={0} />);
    expect(announcer()).toHaveTextContent(QUEUED_DISPATCH_ANNOUNCEMENT);
    expect(QUEUED_DISPATCH_ANNOUNCEMENT).toBe('Sending your queued message to Fredo');
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

// ── #2883 ST-1 — the wrapping / growing / capped field (AC1 input side) ───────

/**
 * jsdom has no layout engine, so the field's EMITTED declarations are the only
 * observable for the `InputGroup` `--input-height` trap: `InputGroup` injects
 * `ps`/`pe` as `calc(var(--input-height) - 0px)`, and `--input-height` exists only
 * in the INPUT recipe — on a `<textarea>` that declaration is
 * invalid-at-computed-value-time (→ 0). Reading the emotion rule proves which
 * declaration the browser will apply (the injected one, or ours).
 */
function fieldDeclarations(el: HTMLElement): Record<string, string> {
  const token = el.className.split(' ').find((c) => c.startsWith('css-')) ?? '';
  const css = Array.from(document.querySelectorAll('style'))
    .map((s) => s.textContent ?? '')
    .join('\n');
  const rule = css.split('\n').find((l) => l.indexOf(`.${token}{`) === 0) ?? '';
  const body = rule.slice(rule.indexOf('{') + 1, rule.lastIndexOf('}'));
  const out: Record<string, string> = {};
  for (const decl of body.split(';')) {
    const i = decl.indexOf(':');
    if (i > 0) out[decl.slice(0, i).trim()] = decl.slice(i + 1).trim();
  }
  return out;
}

/**
 * The browser-equivalent client height of the field's APPLIED border-box: the
 * rendered `height` declaration (the emotion rule the browser applies) minus the
 * 2 × 1px border. jsdom has no layout engine, so this is the model the scroll
 * floor below is built on.
 */
function appliedClientHeightPx(el: HTMLElement): number {
  const declared = fieldDeclarations(el)['height'];
  const borderBox = declared ? Number.parseFloat(declared) : BAR_FIELD_MIN_H_PX;
  return borderBox - 2 * 1; // 2 × 1px border
}

/**
 * Flip the measured content height and model the browser's scroll floor
 * (jsdom reports `scrollHeight` as 0).
 *
 * #2883 round 2 (D-1) — the round-1 stub returned a FIXED number regardless of
 * the element's applied height, so it could not model the CSSOM rule
 * `scrollHeight = max(clientHeight, contentExtent)`. That blind spot is exactly
 * why the round-1 units passed against a grow-only one-way ladder: while the
 * growth clamp is applied, a cleared field reports the BOX (106), never the 46px
 * content it holds. This oracle models the floor from the element's RENDERED
 * height, and reports the intrinsic extent only when the component has released
 * the clamp for its read (`el.style.height === 'auto'`). The clear-back pin then
 * fails against an implementation that measures the constrained box and passes
 * against the intrinsic measurement.
 */
function stubScrollHeight(intrinsicPx: number) {
  Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLTextAreaElement) {
      // The clamp is released for this read ⇒ intrinsic content, no floor.
      if (this.style.height === 'auto') return intrinsicPx;
      return Math.max(appliedClientHeightPx(this), intrinsicPx);
    },
  });
}

/** Let the field's rAF-coalesced measurement land and the re-render flush. */
async function flushFieldMeasure() {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
  });
}

describe('LauncherCommandBar — #2883 ST-1 the wrapping field (AC1 input side)', () => {
  afterEach(() => {
    // Restore the inherited getter so the stub never leaks across tests.
    delete (HTMLTextAreaElement.prototype as unknown as { scrollHeight?: unknown }).scrollHeight;
  });

  it('is a native textarea that KEEPS role="searchbox" and adds aria-multiline (every #2882 selector stays tag-agnostic)', () => {
    renderWithChakra(<LauncherCommandBar query="" onQueryChange={vi.fn()} />);
    const field = screen.getByTestId('launcher-command-input');
    expect(field.tagName).toBe('TEXTAREA');
    // The tag-agnostic anchors `LauncherShell` relies on (SEARCHBOX_SELECTOR, the
    // hold-Space target predicate, `isFromInput`) all match on the ROLE.
    expect(field).toHaveAttribute('role', 'searchbox');
    expect(screen.getByRole('searchbox')).toBe(field);
    expect(field).toHaveAttribute('aria-multiline', 'true');
    // #2882's shipped aria contract is byte-identical on the new element.
    expect(field).toHaveAttribute('aria-expanded', 'false');
    expect(field).toHaveAttribute('aria-controls', 'fredo-launcher-grid');
    expect(field).toHaveAttribute('aria-keyshortcuts', 'Control+Space');
  });

  it('pins the base geometry: 48px border-box, a 20px line, 13px vertical padding, no scrollbar, 108px cap', () => {
    renderWithChakra(<LauncherCommandBar query="" onQueryChange={vi.fn()} />);
    const decl = fieldDeclarations(screen.getByTestId('launcher-command-input'));
    // 20n + 28 ⇒ 48 at one visual line: 20 content + 2 × 13 padding + 2 × 1 border
    // under the preflight's `box-sizing: border-box` (the bound 48/68/88/108 set).
    expect(decl['height']).toBe('48px');
    expect(decl['line-height']).toBe('20px');
    expect(decl['padding-top']).toBe('13px');
    expect(decl['padding-bottom']).toBe('13px');
    expect(decl['min-height']).toBe('48px');
    expect(decl['max-height']).toBe('108px');
    // R-5.3 — no scrollbar and no sideways scroll at the base.
    expect(decl['overflow-y']).toBe('hidden');
    expect(decl['overflow-x']).toBe('hidden');
    expect(decl['overflow-wrap']).toBe('break-word');
    // No CSS height transition: growth is immediate (the performance NFR).
    expect(decl['transition']).toBeUndefined();
    expect(decl['scrollbar-gutter']).toBeUndefined();
  });

  it('passes BOTH paddings explicitly, overriding the InputGroup `--input-height` injection (R-1.2 mechanism)', () => {
    renderWithChakra(
      <LauncherCommandBar
        query="set"
        onQueryChange={vi.fn()}
        hintLabel="↵ open Settings"
        ariaDescribedBy="fredo-command-hint"
      />,
    );
    const decl = fieldDeclarations(screen.getByTestId('launcher-command-input'));
    expect(decl['padding-inline-start']).toBe('40px');
    expect(decl['padding-inline-end']).toBe('264px'); // 220 chip + 44 minimize
    // The injected `calc(var(--input-height) …)` must NOT survive on the textarea:
    // it is invalid-at-computed-value-time there and would zero the gutter.
    expect(decl['padding-inline-start']).not.toContain('var(--input-height)');
    expect(decl['padding-inline-end']).not.toContain('var(--input-height)');
  });

  it('reserves only the always-present MINIMIZE footprint when the bar holds text and no chip shows', () => {
    renderWithChakra(<LauncherCommandBar query="x" onQueryChange={vi.fn()} />);
    const decl = fieldDeclarations(screen.getByTestId('launcher-command-input'));
    expect(decl['padding-inline-end']).toBe('44px');
  });

  it('reserves NO gutter for the truly empty bar (shipped zero-padding pin preserved)', () => {
    renderWithChakra(<LauncherCommandBar query="" onQueryChange={vi.fn()} />);
    const decl = fieldDeclarations(screen.getByTestId('launcher-command-input'));
    expect(decl['padding-inline-end']).toBeUndefined();
    expect(decl['padding-inline-start']).toBe('40px');
  });

  it('grows one 20px line step per measured line and shrinks back to 48px when cleared — intrinsic measurement never floors at the applied height (D-1, R-1.1/R-1.3)', async () => {
    stubScrollHeight(66); // 2 visual lines: 40 + 2 × 13
    const { rerender } = renderWithChakra(
      <LauncherCommandBar query="a query that wraps onto two lines" onQueryChange={vi.fn()} />,
    );
    await flushFieldMeasure();
    const field = screen.getByTestId('launcher-command-input');
    let decl = fieldDeclarations(field);
    expect(decl['height']).toBe('68px');
    expect(decl['overflow-y']).toBe('hidden');

    stubScrollHeight(86); // 3 visual lines
    rerender(
      <LauncherCommandBar query="a query that wraps onto three lines" onQueryChange={vi.fn()} />,
    );
    await flushFieldMeasure();
    decl = fieldDeclarations(field);
    expect(decl['height']).toBe('88px');

    stubScrollHeight(106); // 4 visual lines — exactly the 108px cap
    rerender(
      <LauncherCommandBar query="a query that wraps onto four lines" onQueryChange={vi.fn()} />,
    );
    await flushFieldMeasure();
    decl = fieldDeclarations(field);
    expect(decl['height']).toBe('108px');
    // At the cap the field is scroll-ENABLED; at exactly 4 lines there is nothing
    // to scroll (`scrollHeight === clientHeight`), so no scrollbar appears — the
    // S1 "no scrollbar" observable holds at the boundary.
    expect(decl['overflow-y']).toBe('auto');

    stubScrollHeight(126); // 5+ visual lines — frozen, internal scroll only here
    rerender(
      <LauncherCommandBar query="a query that wraps onto five or more lines" onQueryChange={vi.fn()} />,
    );
    await flushFieldMeasure();
    decl = fieldDeclarations(field);
    expect(decl['height']).toBe('108px');
    expect(decl['overflow-y']).toBe('auto');

    // D-1 — clearing back to empty returns to exactly 48px with no residual scroll
    // (R-1.3 edge). Against the round-1 implementation this leg reads 108px: the
    // measurement consumed the CONSTRAINED box (106) and mapped back to the cap.
    stubScrollHeight(46);
    rerender(<LauncherCommandBar query="" onQueryChange={vi.fn()} />);
    await flushFieldMeasure();
    decl = fieldDeclarations(field);
    expect(decl['height']).toBe('48px');
    expect(decl['overflow-y']).toBe('hidden');
    // R-5.3 — no scrollbar at the base: the one-line content fits the applied box
    // exactly (the jsdom-modelled equivalent of `scrollHeight === clientHeight`).
    expect(field.scrollHeight).toBe(appliedClientHeightPx(field));
  });

  // ── D-1 (round 2) — the shrink-back regression pins ─────────────────────────

  it('D-1 pin — clears from the CAP straight back to 48px with no residual height (REQ-3 edge)', async () => {
    stubScrollHeight(126); // 5+ visual lines ⇒ clamped at the 108px cap
    const { rerender } = renderWithChakra(
      <LauncherCommandBar
        query="a query long enough to wrap onto five or more visual lines inside the bar"
        onQueryChange={vi.fn()}
      />,
    );
    await flushFieldMeasure();
    const field = screen.getByTestId('launcher-command-input');
    expect(fieldDeclarations(field)['height']).toBe('108px');

    // Clear to empty: intrinsic content is a single line (46px padding-box).
    stubScrollHeight(46);
    rerender(<LauncherCommandBar query="" onQueryChange={vi.fn()} />);
    await flushFieldMeasure();
    const cleared = fieldDeclarations(field);
    expect(cleared['height']).toBe('48px');
    expect(cleared['overflow-y']).toBe('hidden');
    // No scrollbar: the intrinsic one-line content exactly fills the applied box.
    expect(field.scrollHeight).toBe(appliedClientHeightPx(field));
    expect(appliedClientHeightPx(field)).toBe(46);
  });

  it('E-50 churn — 108 → 48 → 108 → 48 lands on the exact bound heights every leg', async () => {
    const longQuery = 'a query long enough to wrap onto five or more visual lines inside the bar';
    stubScrollHeight(126);
    const { rerender } = renderWithChakra(
      <LauncherCommandBar query={longQuery} onQueryChange={vi.fn()} />,
    );
    await flushFieldMeasure();
    const field = screen.getByTestId('launcher-command-input');
    expect(fieldDeclarations(field)['height']).toBe('108px');

    // A rapid grow → clear → grow → clear churn must land on the exact bounds
    // every leg — a one-way (grow-only) ladder leaves the cleared legs at 108.
    const legs: Array<{ query: string; intrinsic: number; bound: string }> = [
      { query: '', intrinsic: 46, bound: '48px' },
      { query: longQuery, intrinsic: 126, bound: '108px' },
      { query: '', intrinsic: 46, bound: '48px' },
    ];
    for (const leg of legs) {
      stubScrollHeight(leg.intrinsic);
      rerender(<LauncherCommandBar query={leg.query} onQueryChange={vi.fn()} />);
      await flushFieldMeasure();
      expect(fieldDeclarations(field)['height']).toBe(leg.bound);
    }

    // The final cleared leg also leaves no scrollbar behind.
    expect(fieldDeclarations(field)['overflow-y']).toBe('hidden');
    expect(field.scrollHeight).toBe(appliedClientHeightPx(field));
  });

  it('shows the `Shift+Enter adds a new line` caption ONLY when wrapped AND the companion is active', async () => {
    stubScrollHeight(66); // wrapped to 2 visual lines
    const { rerender } = renderWithChakra(
      <LauncherCommandBar query="a wrapped query" onQueryChange={vi.fn()} newlineHint />,
    );
    await flushFieldMeasure();
    expect(screen.getByTestId('launcher-command-newline-caption')).toHaveTextContent(
      'Shift+Enter adds a new line',
    );

    // The companion going away withdraws the caption...
    rerender(<LauncherCommandBar query="a wrapped query" onQueryChange={vi.fn()} />);
    expect(screen.queryByTestId('launcher-command-newline-caption')).toBeNull();

    // ...and short content never grows a status row (AC5's second half).
    stubScrollHeight(46); // 1 visual line
    rerender(<LauncherCommandBar query="hi" onQueryChange={vi.fn()} newlineHint />);
    await flushFieldMeasure();
    expect(screen.queryByTestId('launcher-command-newline-caption')).toBeNull();
  });

  it('keeps the newline caption BELOW a live voice message in the status slot', () => {
    stubScrollHeight(66);
    renderWithChakra(
      <LauncherCommandBar
        query="x"
        onQueryChange={vi.fn()}
        newlineHint
        voiceErrorMessage="Could not start voice input."
      />,
    );
    expect(screen.getByTestId('launcher-command-listening-status')).toHaveTextContent(
      'Could not start voice input.',
    );
    expect(screen.queryByTestId('launcher-command-newline-caption')).toBeNull();
  });

  it('exposes the bar root so the launcher can measure the reply band', () => {
    const ref = { current: null as HTMLDivElement | null };
    renderWithChakra(<LauncherCommandBar query="" onQueryChange={vi.fn()} containerRef={ref} />);
    expect(ref.current).not.toBeNull();
    expect(ref.current?.getAttribute('data-testid')).toBe('launcher-command-bar');
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
    expect(announcer).toHaveTextContent('Fredo is listening');

    // A same-`listening` re-render must NOT re-announce.
    rerender(<LauncherCommandBar query="partial text" onQueryChange={vi.fn()} listening />);
    expect(announcer).toHaveTextContent('Fredo is listening');

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

// ── #2887 follow-up — the cold/cancel live-region contract (UI/UX §4) ────────
//
// The shipped announcer only flipped `'' -> Listening -> Stopped listening`. The
// UI/UX §4 contract adds the two missing transitions: the COLD path announces
// `Starting voice input` when the bounded chip renders, and S4 CANCEL announces
// `Dictation cancelled` while SUPPRESSING the S3 stop line. Everything stays
// transition-driven; the WARM path announces exactly one `Listening`.

describe('LauncherCommandBar — the cold/cancel announcer transitions (#2887, UI/UX §4)', () => {
  it('COLD path: announces `Starting voice input` when the bounded chip renders, then `Fredo is listening`', () => {
    const { rerender } = renderWithChakra(<LauncherCommandBar query="" onQueryChange={vi.fn()} />);
    const announcer = screen.getByTestId('voice-listening-announcer');
    expect(announcer).toHaveTextContent('');

    // The readying window outlived HOLD_PENDING_CUE_MS: the bounded chip renders.
    rerender(<LauncherCommandBar query="" onQueryChange={vi.fn()} cue="starting" />);
    expect(screen.getByTestId('launcher-command-listening-pending')).toBeInTheDocument();
    expect(announcer).toHaveTextContent('Starting voice input');

    // A chip-only re-render (same cue) must NOT re-announce (transition-driven).
    rerender(<LauncherCommandBar query="" onQueryChange={vi.fn()} cue="starting" holdAvailable />);
    expect(announcer).toHaveTextContent('Starting voice input');

    // Capture is genuinely live: the S2 announcement replaces the cold one.
    rerender(
      <LauncherCommandBar
        query="live"
        onQueryChange={vi.fn()}
        cue="listening"
        listening
        onStopListening={vi.fn()}
      />,
    );
    expect(announcer).toHaveTextContent('Fredo is listening');
  });

  it('WARM path: exactly ONE announcement (`Fredo is listening`) — the armed window / S1 acknowledgement are NOT announced', () => {
    const { rerender } = renderWithChakra(<LauncherCommandBar query="" onQueryChange={vi.fn()} />);
    const announcer = screen.getByTestId('voice-listening-announcer');
    expect(announcer).toHaveTextContent('');

    // The keydown edge: `Hold to dictate…` is field TEXT, never a live region.
    rerender(<LauncherCommandBar query="" onQueryChange={vi.fn()} cue="acknowledge" />);
    expect(screen.getByRole('searchbox')).toHaveAttribute('placeholder', 'Hold to dictate…');
    expect(announcer).toHaveTextContent('');
    // No chip ⇒ no cold announcement either (the warm chip gate is never reached).
    expect(screen.queryByTestId('launcher-command-listening-pending')).toBeNull();

    // Capture is live — the one and only announcement.
    rerender(<LauncherCommandBar query="" onQueryChange={vi.fn()} cue="listening" listening />);
    expect(announcer).toHaveTextContent('Fredo is listening');

    // An ordinary release (a stop) reads the S3 line.
    rerender(<LauncherCommandBar query="" onQueryChange={vi.fn()} cue="none" />);
    expect(announcer).toHaveTextContent('Stopped listening');
  });

  it('CANCEL (S4): a live cancel announces `Dictation cancelled` and SUPPRESSES `Stopped listening` (batched commit)', () => {
    const { rerender } = renderWithChakra(
      <LauncherCommandBar query="" onQueryChange={vi.fn()} cue="none" />,
    );
    rerender(
      <LauncherCommandBar query="x" onQueryChange={vi.fn()} cue="listening" listening />,
    );
    const announcer = screen.getByTestId('voice-listening-announcer');
    expect(announcer).toHaveTextContent('Fredo is listening');

    // The host bumps `cancelSignal` on the live discard; `listening` may drop in
    // the SAME commit (the backend confirm) — the cancel still wins.
    rerender(
      <LauncherCommandBar query="" onQueryChange={vi.fn()} cue="none" cancelSignal={1} />,
    );
    expect(announcer).toHaveTextContent('Dictation cancelled');
    expect(announcer).not.toHaveTextContent('Stopped listening');
  });

  it('CANCEL (S4): the cancel wins when `cancelSignal` lands a commit BEFORE `listening:false`', () => {
    const { rerender } = renderWithChakra(
      <LauncherCommandBar query="" onQueryChange={vi.fn()} cue="none" />,
    );
    rerender(
      <LauncherCommandBar query="x" onQueryChange={vi.fn()} cue="listening" listening />,
    );
    const announcer = screen.getByTestId('voice-listening-announcer');

    // The handler runs synchronously; the capture confirm lands later.
    rerender(
      <LauncherCommandBar query="x" onQueryChange={vi.fn()} cue="listening" listening cancelSignal={1} />,
    );
    expect(announcer).toHaveTextContent('Dictation cancelled');

    rerender(<LauncherCommandBar query="" onQueryChange={vi.fn()} cue="none" cancelSignal={1} />);
    expect(announcer).toHaveTextContent('Dictation cancelled');
    expect(announcer).not.toHaveTextContent('Stopped listening');
  });

  it('a cancel never poisons the NEXT session: a fresh capture re-announces `Listening` and its stop reads `Stopped listening`', () => {
    const { rerender } = renderWithChakra(
      <LauncherCommandBar query="" onQueryChange={vi.fn()} cue="none" />,
    );
    rerender(
      <LauncherCommandBar query="x" onQueryChange={vi.fn()} cue="listening" listening />,
    );
    const announcer = screen.getByTestId('voice-listening-announcer');
    rerender(<LauncherCommandBar query="" onQueryChange={vi.fn()} cue="none" cancelSignal={1} />);
    expect(announcer).toHaveTextContent('Dictation cancelled');

    // A NEW hold goes live: `Fredo is listening` again…
    rerender(
      <LauncherCommandBar query="" onQueryChange={vi.fn()} cue="listening" listening cancelSignal={1} />,
    );
    expect(announcer).toHaveTextContent('Fredo is listening');
    // …and its release is an ordinary stop (the stale cancel flag was cleared).
    rerender(<LauncherCommandBar query="hello" onQueryChange={vi.fn()} cue="none" cancelSignal={1} />);
    expect(announcer).toHaveTextContent('Stopped listening');
  });
});
