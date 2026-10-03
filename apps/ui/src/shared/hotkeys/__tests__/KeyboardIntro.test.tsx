/**
 * Spec #2960 ST-4 — the non-modal first-run introduction (`KeyboardIntro.tsx`).
 *
 * Pins the exact contract testids, the at-most-once visibility gate (R-5.4
 * unresolved ⇒ nothing; seen ⇒ nothing; unseen ⇒ card + ONE announcement),
 * the persisted dismissal (R-5.2), the non-modal a11y discipline (R-5.3 —
 * `aria-hidden` body with the dismiss control a SIBLING outside it, no
 * dialog/aria-modal/live region), reduced motion, the derived top inset (G-253)
 * and the G-273/G-274 render behaviour (body wraps within a bounded width; the
 * `Got it` control is shrink-EXEMPT).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { getAnnouncement, resetHotkeyAnnouncer } from '@/shared/hotkeys/announcer';
import {
  KEYBOARD_INTRO_ANNOUNCEMENT,
  KEYBOARD_INTRO_BODY_TESTID,
  KEYBOARD_INTRO_DISMISS_TESTID,
  KEYBOARD_INTRO_FADE_MS,
  KEYBOARD_INTRO_MAX_WIDTH_PX,
  KEYBOARD_INTRO_TESTID,
  KeyboardIntro,
} from '../KeyboardIntro';
import { persistIntroSeen, readIntroSeen } from '../introDismissal';

vi.mock('../introDismissal', () => ({
  INTRO_SEEN_STORAGE_KEY: 'fredo.hotkeys.introSeen',
  readIntroSeen: vi.fn(),
  persistIntroSeen: vi.fn(),
}));

const readMock = vi.mocked(readIntroSeen);
const persistMock = vi.mocked(persistIntroSeen);

// ── Helpers ──────────────────────────────────────────────────────────────────

function card(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="${KEYBOARD_INTRO_TESTID}"]`);
}
function body(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>(`[data-testid="${KEYBOARD_INTRO_BODY_TESTID}"]`)!;
}
function dismiss(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>(
    `[data-testid="${KEYBOARD_INTRO_DISMISS_TESTID}"]`,
  )!;
}

/** Flush the settled read promise + the resulting React commit. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function mountHeader(bottom: number): void {
  const header = document.createElement('header');
  header.className = 'fredo-window__header';
  header.getBoundingClientRect = () =>
    ({
      top: 0,
      bottom,
      left: 0,
      right: 1280,
      width: 1280,
      height: bottom,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  document.body.appendChild(header);
}

beforeEach(() => {
  resetHotkeyAnnouncer();
  readMock.mockReset();
  persistMock.mockReset();
  readMock.mockResolvedValue(false);
  persistMock.mockResolvedValue(undefined);
  document.body.innerHTML = '';
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

// ── Binding constants ────────────────────────────────────────────────────────

describe('KeyboardIntro — binding constants', () => {
  it('declares the exact contract testids', () => {
    expect(KEYBOARD_INTRO_TESTID).toBe('hotkeys-intro');
    expect(KEYBOARD_INTRO_BODY_TESTID).toBe('hotkeys-intro-body');
    expect(KEYBOARD_INTRO_DISMISS_TESTID).toBe('hotkeys-intro-dismiss');
  });
});

// ── Visibility gate (R-5.1/R-5.4) ────────────────────────────────────────────

describe('KeyboardIntro — visibility gate', () => {
  it('renders nothing while the persisted read is unresolved (R-5.4)', () => {
    readMock.mockReturnValue(new Promise<boolean>(() => {}));
    const { container } = renderWithChakra(<KeyboardIntro reducedMotion />);

    expect(card(container)).toBeNull();
    expect(getAnnouncement()).toBe('');
  });

  it('renders the card + announces only after the read resolves unseen (R-5.1)', async () => {
    let resolveRead!: (value: boolean) => void;
    readMock.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveRead = resolve;
      }),
    );

    const { container } = renderWithChakra(<KeyboardIntro reducedMotion />);
    expect(card(container)).toBeNull();
    expect(getAnnouncement()).toBe('');

    await act(async () => {
      resolveRead(false);
      await Promise.resolve();
    });

    expect(card(container)).not.toBeNull();
    expect(getAnnouncement()).toBe(KEYBOARD_INTRO_ANNOUNCEMENT);
  });

  it('renders nothing and does not announce when already seen (R-5.2)', async () => {
    readMock.mockResolvedValue(true);
    const { container } = renderWithChakra(<KeyboardIntro reducedMotion />);
    await settle();

    expect(card(container)).toBeNull();
    expect(getAnnouncement()).toBe('');
  });

  it('announces exactly once, never on a re-render', async () => {
    const { container, rerender } = renderWithChakra(<KeyboardIntro reducedMotion />);
    await settle();
    expect(card(container)).not.toBeNull();
    expect(getAnnouncement()).toBe(KEYBOARD_INTRO_ANNOUNCEMENT);

    // A re-render must not re-announce (the channel is cleared, then re-checked).
    resetHotkeyAnnouncer();
    rerender(<KeyboardIntro reducedMotion />);
    await settle();
    expect(getAnnouncement()).toBe('');
  });
});

// ── Dismissal (R-5.2) ────────────────────────────────────────────────────────

describe('KeyboardIntro — persisted dismissal', () => {
  it('hides on the focusable Got it control and persists the dismissal', async () => {
    const { container } = renderWithChakra(<KeyboardIntro reducedMotion />);
    await settle();

    const button = dismiss(container);
    expect(button.tagName).toBe('BUTTON');
    expect(button).toHaveTextContent('Got it');

    fireEvent.click(button);

    expect(card(container)).toBeNull();
    expect(persistMock).toHaveBeenCalledTimes(1);
  });

  it('never reappears on a later mount once persisted (R-5.2)', async () => {
    // First mount: fresh store, dismiss.
    const first = renderWithChakra(<KeyboardIntro reducedMotion />);
    await settle();
    fireEvent.click(dismiss(first.container));
    first.unmount();

    // Remount: the store now reports the flag seen ⇒ nothing renders.
    readMock.mockResolvedValue(true);
    const second = renderWithChakra(<KeyboardIntro reducedMotion />);
    await settle();
    expect(card(second.container)).toBeNull();
  });
});

// ── Non-modal a11y discipline (R-5.3) ────────────────────────────────────────

describe('KeyboardIntro — non-modal + AT-reachable dismiss', () => {
  it('declares no dialog/aria-modal/live region and keeps dismiss outside the aria-hidden body', async () => {
    const { container } = renderWithChakra(<KeyboardIntro reducedMotion />);
    await settle();

    const root = card(container)!;
    const bodyEl = body(container);
    const button = dismiss(container);

    // Non-modal (R-5.3): no dialog semantics, no scrim-like full-viewport box.
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector('[aria-modal]')).toBeNull();
    expect(root.style.right).toBe('');
    expect(root.style.bottom).toBe('');

    // The visual body is aria-hidden; the dismiss control is a SIBLING outside it.
    expect(bodyEl).toHaveAttribute('aria-hidden', 'true');
    expect(bodyEl.contains(button)).toBe(false);
    expect(root.contains(button)).toBe(true);

    // No second live region — the shared announcer is the only channel.
    expect(container.querySelectorAll('[aria-live]')).toHaveLength(0);
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(0);
  });
});

// ── Reduced motion ───────────────────────────────────────────────────────────

describe('KeyboardIntro — prefers-reduced-motion', () => {
  it('is instant (no entrance animation) under reduced motion', async () => {
    const { container } = renderWithChakra(<KeyboardIntro reducedMotion />);
    await settle();

    const root = card(container)!;
    expect(root.style.animation).toBe('none');
    expect(root.style.transition).toBe('none');
  });

  it('applies an opacity entrance when motion is allowed', async () => {
    const { container } = renderWithChakra(<KeyboardIntro />);
    await settle();

    const root = card(container)!;
    expect(root.style.animation).toContain(`${KEYBOARD_INTRO_FADE_MS}ms`);
    expect(root.style.transition).toContain('opacity');
  });
});

// ── Derived top inset (G-253) ────────────────────────────────────────────────

describe('KeyboardIntro — derived top inset', () => {
  it('uses the base inset when no window header covers the anchor', async () => {
    const { container } = renderWithChakra(<KeyboardIntro reducedMotion />);
    await settle();

    const root = card(container)!;
    expect(root.style.position).toBe('fixed');
    expect(root.style.left).toBe('12px');
    expect(root.style.top).toBe('12px');
  });

  it('derives its top from the ACTUAL rendered header bottom (never a nominal sum)', async () => {
    mountHeader(48);
    const { container } = renderWithChakra(<KeyboardIntro reducedMotion />);
    await settle();

    expect(card(container)!.style.top).toBe('48px');
  });
});

// ── Render behaviour (G-273/G-274) ───────────────────────────────────────────

describe('KeyboardIntro — bounded wrap + shrink-exempt dismiss', () => {
  it('wraps the body within its bounded width and exempts Got it from shrink', async () => {
    const { container } = renderWithChakra(<KeyboardIntro reducedMotion />);
    await settle();

    const root = card(container)!;
    const bodyEl = body(container);
    const button = dismiss(container);

    expect(KEYBOARD_INTRO_MAX_WIDTH_PX).toBe(320);
    expect(getComputedStyle(root).maxWidth).toBe('320px');

    // The body is the wrap target — no horizontal clip.
    expect(getComputedStyle(bodyEl).whiteSpace).toBe('normal');
    expect(getComputedStyle(bodyEl).overflowWrap).toBe('break-word');

    // The dismiss control is EXEMPT from any shrink.
    expect(getComputedStyle(button).flexShrink).toBe('0');
    expect(getComputedStyle(button).whiteSpace).toBe('nowrap');
  });
});
