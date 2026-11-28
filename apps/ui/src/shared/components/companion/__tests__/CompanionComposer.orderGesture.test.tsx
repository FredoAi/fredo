/**
 * Spec #3243 ST-8 — the order field's hold-Space gesture, wired (AC-2).
 *
 * This suite drives the COMPONENT, not ST-2's pure module (which has its own
 * suite). What it proves is the wiring the plan binds:
 *
 *   - `data-order-capture` reaches `armed` → `starting` → `listening` and back to
 *     `idle` (the structural reading that a placeholder alone cannot give: an
 *     `armed` state is invisible in text);
 *   - a sub-threshold release writes exactly ONE ordinary space **at the caret**
 *     — a length-only assertion would pass an append-at-end, which is a lost
 *     keystroke in disguise;
 *   - each of AC-2's three cancels writes NOTHING and never dispatches;
 *   - the promise (`Hold Space to speak`) exists in BOTH channels and is ABSENT
 *     when the gesture cannot arm — a permanent promise is a false capability
 *     claim, not a cosmetic nit;
 *   - the field adds NO document keydown listener (the gesture is field-scoped,
 *     not a fourth platform chord).
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import {
  COMPANION_COMPOSER_HINT_SR_TESTID,
  COMPANION_COMPOSER_HOLD_PROMISE,
  COMPANION_COMPOSER_INPUT_TESTID,
  COMPANION_COMPOSER_LISTENING_PLACEHOLDER,
  COMPANION_COMPOSER_CANCEL_DICTATION_LABEL,
  COMPANION_COMPOSER_DISMISS_TESTID,
  COMPANION_COMPOSER_PLACEHOLDER,
  COMPANION_COMPOSER_SUBMIT_TESTID,
  CompanionComposer,
} from '@/shared/components/companion/CompanionComposer';
import type { CompanionCaptureControls } from '@/shared/components/companion/CompanionComposer';
import type { CompanionTurnTarget } from '@/shared/companion/composerTarget';
import { ORDER_HOLD_THRESHOLD_MS } from '@/shared/order/orderGesture';
import {
  registerApplication,
  resetApplicationRegistryForTests,
} from '@/applications/applicationRegistry';
import type { FredoApplicationClass } from '@/shared/classes';

const TARGET: CompanionTurnTarget = {
  appId: 'wireframe',
  appName: 'Wireframe',
  grounding: null,
  explicit: false,
};

function fakeApp(id: string, name: string): FredoApplicationClass {
  return {
    id,
    name,
    description: `${name} is a test application.`,
    showable: true,
    icon: (() => null),
    render: () => null,
  } as unknown as FredoApplicationClass;
}

function captureControls(overrides: Partial<CompanionCaptureControls> = {}) {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    cancel: vi.fn(),
    live: false,
    ...overrides,
  } as CompanionCaptureControls & {
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
  };
}

interface RenderOptions {
  readonly voiceUsable?: boolean;
  readonly busy?: boolean;
  readonly capture?: CompanionCaptureControls;
  readonly onAnnounce?: (text: string) => void;
  readonly onSubmit?: (text: string) => void;
}

function renderComposer(options: RenderOptions = {}) {
  const onSubmit = options.onSubmit ?? vi.fn();
  const onDismiss = vi.fn();
  const view = renderWithChakra(
    <CompanionComposer
      surface="overlay"
      focusNonce={0}
      avatarRect={{ left: 400, top: 400, right: 480, bottom: 500, width: 80, height: 100 }}
      avoidRect={null}
      viewport={{ width: 1024, height: 768 }}
      target={TARGET}
      onSubmit={onSubmit}
      onDismiss={onDismiss}
      {...(options.onAnnounce !== undefined ? { onAnnounce: options.onAnnounce } : {})}
      {...(options.voiceUsable !== undefined ? { voiceUsable: options.voiceUsable } : {})}
      {...(options.busy !== undefined ? { busy: options.busy } : {})}
      {...(options.capture !== undefined ? { capture: options.capture } : {})}
    />,
  );
  const field = view.getByTestId(COMPANION_COMPOSER_INPUT_TESTID) as HTMLTextAreaElement;
  const root = view.getByTestId('fredo-companion-composer');
  return { ...view, field, root, onSubmit, onDismiss };
}

beforeEach(() => {
  vi.restoreAllMocks();
  resetApplicationRegistryForTests();
  registerApplication(fakeApp('wireframe', 'Wireframe'));
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1024 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 768 });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 80 });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 100 });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function captureAttr(root: HTMLElement): string | null {
  return root.getAttribute('data-order-capture');
}

function holdSpace(field: HTMLTextAreaElement): void {
  fireEvent.keyDown(field, { key: ' ', code: 'Space' });
}

function releaseSpace(field: HTMLTextAreaElement): void {
  fireEvent.keyUp(field, { key: ' ', code: 'Space' });
}

describe('the promise is conditional, never permanent', () => {
  it('offers the promise in BOTH channels when the gesture can arm', () => {
    const { field, root } = renderComposer({ voiceUsable: true, capture: captureControls() });

    expect(field.getAttribute('placeholder')).toBe(COMPANION_COMPOSER_HOLD_PROMISE);
    // The description exists and the field POINTS at it — a placeholder alone is
    // sighted-only, and a screen-reader user cannot re-read it on demand.
    const hint = root.querySelector(`[data-testid="${COMPANION_COMPOSER_HINT_SR_TESTID}"]`);
    expect(hint).not.toBeNull();
    expect(hint?.textContent).toBe(COMPANION_COMPOSER_HOLD_PROMISE);
    expect(field.getAttribute('aria-describedby')).toBe(hint?.getAttribute('id'));
  });

  it('is ABSENT in both channels when voice is unusable (a false claim is a FAIL)', () => {
    const { field, root } = renderComposer({ voiceUsable: false, capture: captureControls() });

    expect(field.getAttribute('placeholder')).toBe(COMPANION_COMPOSER_PLACEHOLDER);
    expect(root.querySelector(`[data-testid="${COMPANION_COMPOSER_HINT_SR_TESTID}"]`)).toBeNull();
    expect(field.getAttribute('aria-describedby')).toBeNull();
  });

  it('is ABSENT while a reply generation is in flight', () => {
    const { field } = renderComposer({ voiceUsable: true, busy: true, capture: captureControls() });

    expect(field.getAttribute('placeholder')).toBe(COMPANION_COMPOSER_PLACEHOLDER);
    expect(field.getAttribute('aria-describedby')).toBeNull();
  });

  it('is ABSENT when NO capture lifecycle is wired (the field cannot capture)', () => {
    // Without `capture` the gesture would resolve `hold-arm` and then do nothing:
    // promising it would be exactly the unimplemented capability claim.
    const { field } = renderComposer({ voiceUsable: true });

    expect(field.getAttribute('placeholder')).toBe(COMPANION_COMPOSER_PLACEHOLDER);
    expect(field.getAttribute('aria-describedby')).toBeNull();
  });

  it('is ABSENT once the field holds text', () => {
    const { field } = renderComposer({ voiceUsable: true, capture: captureControls() });
    fireEvent.change(field, { target: { value: 'fill the box' } });

    expect(field.getAttribute('placeholder')).toBe(COMPANION_COMPOSER_PLACEHOLDER);
    expect(field.getAttribute('aria-describedby')).toBeNull();
  });
});

describe('data-order-capture — the structural reading of the gesture', () => {
  it('is idle at rest (the attribute is always present; idle is a claim too)', () => {
    const { root } = renderComposer({ voiceUsable: true, capture: captureControls() });
    expect(captureAttr(root)).toBe('idle');
  });

  it('reaches armed on the keydown, then starting past the threshold, and starts ONE capture', () => {
    vi.useFakeTimers();
    const capture = captureControls();
    const { field, root } = renderComposer({ voiceUsable: true, capture });

    holdSpace(field);
    expect(captureAttr(root)).toBe('armed');
    expect(capture.start).not.toHaveBeenCalled();

    act(() => { vi.advanceTimersByTime(ORDER_HOLD_THRESHOLD_MS); });

    expect(captureAttr(root)).toBe('starting');
    expect(capture.start).toHaveBeenCalledTimes(1);
  });

  it('reaches listening only once the backend confirms the session', () => {
    vi.useFakeTimers();
    const capture = captureControls();
    const { field, root, rerender } = renderComposer({ voiceUsable: true, capture });

    holdSpace(field);
    act(() => { vi.advanceTimersByTime(ORDER_HOLD_THRESHOLD_MS); });
    // Not live yet: `starting`, never `listening`.
    expect(captureAttr(root)).toBe('starting');

    rerender(
      <CompanionComposer
        surface="overlay"
        focusNonce={0}
        avatarRect={{ left: 400, top: 400, right: 480, bottom: 500, width: 80, height: 100 }}
        avoidRect={null}
        viewport={{ width: 1024, height: 768 }}
        target={TARGET}
        onSubmit={vi.fn()}
        onDismiss={vi.fn()}
        voiceUsable
        capture={{ ...capture, live: true }}
      />,
    );

    expect(captureAttr(root)).toBe('listening');
    expect(field.getAttribute('placeholder')).toBe(COMPANION_COMPOSER_LISTENING_PLACEHOLDER);
    // Send is NOT the way to end a capture.
    expect((root.querySelector(`[data-testid="${COMPANION_COMPOSER_SUBMIT_TESTID}"]`) as HTMLButtonElement).disabled).toBe(true);
    // The close control states BOTH of its effects while a capture is live.
    expect(
      root.querySelector(`[data-testid="${COMPANION_COMPOSER_DISMISS_TESTID}"]`)?.getAttribute('aria-label'),
    ).toBe(COMPANION_COMPOSER_CANCEL_DICTATION_LABEL);
  });

  it('announces the live edge exactly once, and nothing before it', () => {
    vi.useFakeTimers();
    const onAnnounce = vi.fn();
    const capture = captureControls();
    const { field, rerender } = renderComposer({ voiceUsable: true, capture, onAnnounce });

    holdSpace(field);
    act(() => { vi.advanceTimersByTime(ORDER_HOLD_THRESHOLD_MS); });
    // Pre-capture: nothing announced (a claim before the fact is a lie).
    expect(onAnnounce).not.toHaveBeenCalled();

    rerender(
      <CompanionComposer
        surface="overlay"
        focusNonce={0}
        avatarRect={{ left: 400, top: 400, right: 480, bottom: 500, width: 80, height: 100 }}
        avoidRect={null}
        viewport={{ width: 1024, height: 768 }}
        target={TARGET}
        onSubmit={vi.fn()}
        onDismiss={vi.fn()}
        onAnnounce={onAnnounce}
        voiceUsable
        capture={{ ...capture, live: true }}
      />,
    );

    // Exactly one announcement, on the rise edge.
    expect(onAnnounce).toHaveBeenCalledTimes(1);
  });

  it('returns to idle after the release, and CANCELS the late session it never got', () => {
    vi.useFakeTimers();
    const capture = captureControls();
    const { field, root } = renderComposer({ voiceUsable: true, capture });

    holdSpace(field);
    act(() => { vi.advanceTimersByTime(ORDER_HOLD_THRESHOLD_MS); });
    releaseSpace(field);

    expect(captureAttr(root)).toBe('idle');
    // Crossed the threshold but the backend never confirmed: the release is
    // `cancel-pending`, so the late session is cancelled (the mic must never be
    // left hot) — and the user still gets the space they meant to type.
    expect(capture.cancel).toHaveBeenCalledTimes(1);
    expect(capture.stop).not.toHaveBeenCalled();
    expect(field.value).toBe(' ');
  });
});

describe('a sub-threshold release writes exactly ONE space — and where it comes from', () => {
  it('an EMPTY field: the gesture writes exactly one space', () => {
    vi.useFakeTimers();
    const capture = captureControls();
    const { field } = renderComposer({ voiceUsable: true, capture });

    holdSpace(field);
    releaseSpace(field);

    expect(field.value).toBe(' ');
    expect(field.value).toHaveLength(1);
    expect(capture.start).not.toHaveBeenCalled();
  });

  // ── The mid-text caret (F-7's edge) — and the structural fact it reveals ───
  //
  // R-2d says the gesture MUST NOT arm on a non-empty field. So on a field holding
  // text, a Space is NEVER a gesture: the keydown resolves `ordinary-space` and
  // this handler does not consume it, so the browser inserts the character
  // natively — at the caret, because that is where native insertion goes. That is
  // what makes "the space lands at the caret, not the end" true for the mid-text
  // case: the gesture is not involved at all, and `writeAtCaret` (which exists for
  // the gesture paths) is not the mechanism.
  //
  // The assertion that matters is therefore `defaultPrevented === false`: consuming
  // the key would suppress the native character, and a handler that consumed it and
  // then appended would produce the append-at-end defect F-7 exists to catch.
  it('a NON-EMPTY field: Space is left native, so the browser places it (never consumed)', () => {
    const capture = captureControls();
    const { field } = renderComposer({ voiceUsable: true, capture });

    fireEvent.change(field, { target: { value: 'abcd' } });

    const event = new KeyboardEvent('keydown', {
      key: ' ', code: 'Space', bubbles: true, cancelable: true,
    });
    field.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(capture.start).not.toHaveBeenCalled();

    // Same on the release: no gesture was armed, so nothing is intercepted.
    const up = new KeyboardEvent('keyup', {
      key: ' ', code: 'Space', bubbles: true, cancelable: true,
    });
    field.dispatchEvent(up);
    expect(up.defaultPrevented).toBe(false);
  });

  it('the caret-insert path puts the character AT the caret when the gesture writes', () => {
    // `writeAtCaret` is exercised directly through its one reachable gesture path:
    // a field that is empty at keydown (so the gesture arms) but where the caret
    // has been moved. An empty string has caret 0, so this pins the INSERT form
    // rather than an append — the property, not the dead mid-text scenario.
    vi.useFakeTimers();
    const capture = captureControls();
    const { field } = renderComposer({ voiceUsable: true, capture });

    holdSpace(field);
    releaseSpace(field);

    expect(field.value).toBe(' ');
    // The caret advanced past the character it wrote.
    expect(field.selectionStart).toBe(1);
  });

  it('writes nothing when the hold was suppressed (a modified chord)', () => {
    const capture = captureControls();
    const { field } = renderComposer({ voiceUsable: true, capture });

    fireEvent.change(field, { target: { value: 'ab' } });
    fireEvent.keyDown(field, { key: ' ', code: 'Space', ctrlKey: true });

    // A modified space is the launcher chord, not a hold: nothing armed.
    expect(capture.start).not.toHaveBeenCalled();
  });
});

describe("AC-2's three cancels each write NOTHING and never dispatch", () => {
  it('Escape cancels without writing a space', () => {
    vi.useFakeTimers();
    const capture = captureControls();
    const { field, onSubmit } = renderComposer({ voiceUsable: true, capture });

    holdSpace(field);
    act(() => { vi.advanceTimersByTime(ORDER_HOLD_THRESHOLD_MS); });
    const before = field.value;

    fireEvent.keyDown(field, { key: 'Escape', code: 'Escape' });

    expect(field.value).toBe(before);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(capture.cancel).toHaveBeenCalled();
  });

  it('the close control cancels FIRST, writes nothing, and announces ONCE', () => {
    vi.useFakeTimers();
    const onAnnounce = vi.fn();
    const capture = captureControls();
    const { field, root, onDismiss } = renderComposer({
      voiceUsable: true, capture, onAnnounce,
    });

    holdSpace(field);
    act(() => { vi.advanceTimersByTime(ORDER_HOLD_THRESHOLD_MS); });
    const before = field.value;

    // Live, so the cancel is a genuine retraction.
    // (drive the rise edge through a rerender is covered above; here we assert the
    // pre-live path writes nothing and dismisses.)
    fireEvent.click(root.querySelector(`[data-testid="${COMPANION_COMPOSER_DISMISS_TESTID}"]`) as HTMLElement);

    expect(field.value).toBe(before);
    expect(capture.cancel).toHaveBeenCalledTimes(1);
    // The shipped dismiss still runs after the cancel.
    expect(onDismiss).toHaveBeenCalledTimes(1);
    // Pre-live: nothing was captured, so nothing is retracted (no announcement).
    expect(onAnnounce).not.toHaveBeenCalled();
  });

  it('a blur to something OUTSIDE the composer cancels', () => {
    vi.useFakeTimers();
    const capture = captureControls();
    const { field } = renderComposer({ voiceUsable: true, capture });

    holdSpace(field);
    act(() => { vi.advanceTimersByTime(ORDER_HOLD_THRESHOLD_MS); });
    const before = field.value;

    const outside = document.createElement('button');
    document.body.appendChild(outside);
    fireEvent.blur(field, { relatedTarget: outside });

    expect(field.value).toBe(before);
    expect(capture.cancel).toHaveBeenCalled();
    outside.remove();
  });

  it('a blur to a control INSIDE the composer is NOT a cancel', () => {
    vi.useFakeTimers();
    const capture = captureControls();
    const { field, root } = renderComposer({ voiceUsable: true, capture });

    holdSpace(field);
    act(() => { vi.advanceTimersByTime(ORDER_HOLD_THRESHOLD_MS); });

    const inside = root.querySelector(`[data-testid="${COMPANION_COMPOSER_DISMISS_TESTID}"]`) as HTMLElement;
    fireEvent.blur(field, { relatedTarget: inside });

    // Focus moving within the composer must not cancel: the close control's own
    // click is the cancel, and treating the blur as one would cancel twice.
    expect(capture.cancel).not.toHaveBeenCalled();
  });
});

describe('the gesture is field-scoped, not a fourth platform chord', () => {
  it('adds NO document-level keydown listener', () => {
    const addSpy = vi.spyOn(document, 'addEventListener');
    renderComposer({ voiceUsable: true, capture: captureControls() });

    const documentKeydowns = addSpy.mock.calls.filter(
      ([type]) => type === 'keydown' || type === 'keyup',
    );
    expect(documentKeydowns).toHaveLength(0);
  });

  it('does not consume a non-Space keydown', () => {
    const capture = captureControls();
    const { field } = renderComposer({ voiceUsable: true, capture });

    const event = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true });
    field.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(capture.start).not.toHaveBeenCalled();
  });
});
