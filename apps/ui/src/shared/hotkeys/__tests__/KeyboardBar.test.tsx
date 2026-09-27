/**
 * Spec #2959 ST-3 — the persistent keyboard key bar (EARS R-2.1, R-2.2, R-3.1,
 * R-4.1…R-4.5, R-5.3, R-5.4; supports R-5.5).
 *
 * Pins: the exact binding constants/testids, the OFF gate (no DOM), the mounted
 * bar (header + context + depth pips + rows + pinned non-interactive exit), the
 * defined empty state, unavailable-with-reason rows on a text-entry focus, the
 * terminal-passthrough suppression (mode persists), the live context follow on
 * descend/return without re-entering mode, the body count hook, the ONE-announcer
 * discipline (aria-hidden root, no focusables, pointer-events none, no live
 * region), the announcement copy on entry/context/exit, the reduced-motion fade
 * gate, and the #523 no-render-loop rule.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { getAnnouncement, resetHotkeyAnnouncer } from '@/shared/hotkeys/announcer';
import {
  registerHotkeyContext,
  resetContextRegistryForTests,
} from '@/shared/hotkeys/contexts';
import {
  enterHotkeyContext,
  exitHotkeyContext,
  resetHotkeyContextForTests,
} from '@/shared/hotkeys/contextStack';
import {
  REFERENCE_CONTEXT_ID,
  REFERENCE_DESCEND_ACTION_ID,
  REFERENCE_ONLY_ACTION_ID,
} from '@/shared/hotkeys/defaults';
import {
  installHotkeyEngine,
  resetHotkeyEngineForTests,
  resolveActiveBindings,
} from '@/shared/hotkeys/engine';
import {
  resetRegistryForTests,
} from '@/shared/hotkeys/registry';
import { resetKeymapStoreForTests, setPassthrough } from '@/shared/hotkeys/store';
import { resetWindowStoreForTests } from '@/shared/window-system/windowStore';
import { ROOT_CONTEXT_ID } from '@/shared/hotkeys/types';
import {
  BODY_KEYBOARD_MODE_ATTR,
  enterKeyboardMode,
  exitKeyboardMode,
  isKeyboardModeOn,
  resetKeyboardModeForTests,
} from '../keyboardMode';
import {
  BODY_KEYBOARD_MODE_COUNT_ATTR,
  KEYBOARD_BAR_CONTEXT_TESTID,
  KEYBOARD_BAR_EMPTY_TESTID,
  KEYBOARD_BAR_EMPTY_TEXT,
  KEYBOARD_BAR_EXIT_ANNOUNCEMENT,
  KEYBOARD_BAR_EXIT_TESTID,
  KEYBOARD_BAR_HEADER_TESTID,
  KEYBOARD_BAR_LIST_TESTID,
  KEYBOARD_BAR_MORE_TESTID,
  KEYBOARD_BAR_PIP_TESTID,
  KEYBOARD_BAR_ROW_REASON_TESTID,
  KEYBOARD_BAR_ROW_TESTID,
  KEYBOARD_BAR_TESTID,
  KEYBOARD_BAR_Z_INDEX,
  KeyboardBar,
} from '../KeyboardBar';
import {
  KEYBOARD_BAR_FADE_MS,
  KEYBOARD_BAR_ROW_TITLE_MIN_WIDTH_PX,
  KEYBOARD_BAR_UNAVAILABLE_ROW_MAX_WIDTH_PX,
} from '../keyboardBarGeometry';

// ── Helpers ──────────────────────────────────────────────────────────────────

function bar(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="${KEYBOARD_BAR_TESTID}"]`);
}

function rows(container: HTMLElement): NodeListOf<Element> {
  return container.querySelectorAll(`[data-testid="${KEYBOARD_BAR_ROW_TESTID}"]`);
}

function mountInput(): HTMLInputElement {
  const input = document.createElement('input');
  document.body.appendChild(input);
  input.focus();
  return input;
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
  resetRegistryForTests();
  resetKeymapStoreForTests();
  resetWindowStoreForTests();
  resetHotkeyEngineForTests();
  resetContextRegistryForTests();
  resetHotkeyContextForTests();
  resetKeyboardModeForTests();
  resetHotkeyAnnouncer();
  installHotkeyEngine();
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true, writable: true });
});

afterEach(() => {
  cleanup();
  resetHotkeyEngineForTests();
  resetContextRegistryForTests();
  resetHotkeyContextForTests();
  resetKeyboardModeForTests();
  resetHotkeyAnnouncer();
  vi.restoreAllMocks();
});

// ── Binding constants ────────────────────────────────────────────────────────

describe('KeyboardBar — binding constants', () => {
  it('declares the exact contract testids + stacking + exit copy', () => {
    expect(KEYBOARD_BAR_Z_INDEX).toBe(1250);
    expect(KEYBOARD_BAR_TESTID).toBe('hotkeys-keyboard-bar');
    expect(KEYBOARD_BAR_HEADER_TESTID).toBe('hotkeys-keyboard-bar-header');
    expect(KEYBOARD_BAR_CONTEXT_TESTID).toBe('hotkeys-keyboard-bar-context');
    expect(KEYBOARD_BAR_EXIT_TESTID).toBe('hotkeys-keyboard-bar-exit');
    expect(KEYBOARD_BAR_LIST_TESTID).toBe('hotkeys-keyboard-bar-list');
    expect(KEYBOARD_BAR_ROW_TESTID).toBe('hotkeys-keyboard-bar-row');
    expect(KEYBOARD_BAR_ROW_REASON_TESTID).toBe('hotkeys-keyboard-bar-row-unavailable');
    expect(KEYBOARD_BAR_EMPTY_TESTID).toBe('hotkeys-keyboard-bar-empty');
    expect(BODY_KEYBOARD_MODE_COUNT_ATTR).toBe('data-fredo-keyboard-mode-count');
    expect(KEYBOARD_BAR_EXIT_ANNOUNCEMENT).toBe('Keyboard mode off.');
  });

  it('stacks above the dock and below the context indicator / which-key surfaces', () => {
    expect(KEYBOARD_BAR_Z_INDEX).toBeGreaterThan(1200);
    expect(KEYBOARD_BAR_Z_INDEX).toBeLessThan(1350);
  });
});

// ── OFF gate ─────────────────────────────────────────────────────────────────

describe('KeyboardBar — OFF gate (R-2.1)', () => {
  it('renders null and publishes no body count while mode is OFF', () => {
    const { container } = renderWithChakra(<KeyboardBar reducedMotion />);

    expect(bar(container)).toBeNull();
    expect(rows(container)).toHaveLength(0);
    expect(document.body.hasAttribute(BODY_KEYBOARD_MODE_COUNT_ATTR)).toBe(false);
    expect(document.body.hasAttribute(BODY_KEYBOARD_MODE_ATTR)).toBe(false);
    // Exactly ONE live region exists only if the announcer is mounted; the bar
    // itself must never add one.
    expect(container.querySelectorAll('[aria-live]')).toHaveLength(0);
  });
});

// ── ON render (R-2.1 / R-4.1 / R-4.4) ────────────────────────────────────────

describe('KeyboardBar — ON render', () => {
  it('renders header + context + rows + the pinned exit chip and the count hook', () => {
    const { container } = renderWithChakra(<KeyboardBar reducedMotion />);
    act(() => {
      enterKeyboardMode();
    });

    const root = bar(container);
    expect(root).not.toBeNull();
    expect(container.querySelector(`[data-testid="${KEYBOARD_BAR_HEADER_TESTID}"]`)).not.toBeNull();
    expect(container.querySelector(`[data-testid="${KEYBOARD_BAR_CONTEXT_TESTID}"]`)).toHaveTextContent(
      'Fredo',
    );
    expect(rows(container).length).toBeGreaterThan(0);
    expect(container.querySelector(`[data-testid="${KEYBOARD_BAR_EXIT_TESTID}"]`)).not.toBeNull();

    // F-3: the body hook keeps TOTAL-count semantics (the full resolved count),
    // even though the bounded render shows at most the capacity.
    const totalRows = resolveActiveBindings().filter(
      (binding) => binding.sequence.length > 0,
    ).length;
    expect(totalRows).toBeGreaterThan(0);
    expect(document.body.getAttribute(BODY_KEYBOARD_MODE_COUNT_ATTR)).toBe(String(totalRows));
    expect(rows(container).length).toBeLessThanOrEqual(totalRows);
    // ST-1's mode hook stays 'true'.
    expect(document.body.getAttribute(BODY_KEYBOARD_MODE_ATTR)).toBe('true');
  });

  it('is visual-only: aria-hidden, click-through, no focusable descendant, no live region', () => {
    const { container } = renderWithChakra(<KeyboardBar reducedMotion />);
    act(() => {
      enterKeyboardMode();
    });

    const root = bar(container)!;
    expect(root).toHaveAttribute('aria-hidden', 'true');
    expect(root.style.pointerEvents).toBe('none');
    expect(root.style.position).toBe('fixed');
    expect(root.style.left).toBe('0px');
    expect(root.style.right).toBe('0px');

    // R-4.1 — nothing focusable inside the bar (no button, no tabindex).
    expect(root.querySelectorAll('button, [tabindex], [href]')).toHaveLength(0);
    // R-4.4 — no second live region on the bar.
    expect(root.querySelectorAll('[aria-live], [role="status"]')).toHaveLength(0);
  });

  it('renders the depth pips (non-colour channel) matching the context depth', () => {
    const { container } = renderWithChakra(<KeyboardBar reducedMotion />);
    act(() => {
      enterKeyboardMode();
    });
    const context = container.querySelector(`[data-testid="${KEYBOARD_BAR_CONTEXT_TESTID}"]`)!;
    expect(context).toHaveAttribute('data-depth', '1');
    expect(
      container.querySelectorAll(`[data-testid="${KEYBOARD_BAR_PIP_TESTID}"]`),
    ).toHaveLength(1);

    act(() => {
      enterHotkeyContext(REFERENCE_CONTEXT_ID);
    });
    const descended = container.querySelector(`[data-testid="${KEYBOARD_BAR_CONTEXT_TESTID}"]`)!;
    expect(descended).toHaveAttribute('data-depth', '2');
    expect(
      container.querySelectorAll(`[data-testid="${KEYBOARD_BAR_PIP_TESTID}"]`),
    ).toHaveLength(2);
  });
});

// ── Many-action overflow (F-3) ───────────────────────────────────────────────

describe('KeyboardBar — many-action overflow (F-3)', () => {
  it('bounds the rendered rows and pins a +N more affordance carrying the total count', () => {
    const { container } = renderWithChakra(<KeyboardBar reducedMotion maxVisibleRows={3} />);
    act(() => {
      enterKeyboardMode();
    });

    const total = resolveActiveBindings().filter((binding) => binding.sequence.length > 0).length;
    expect(total).toBeGreaterThan(3);

    // Exactly three action chips are rendered — one per capacity slot.
    expect(rows(container)).toHaveLength(3);

    // The hidden remainder is surfaced by the pinned `+N more` chip.
    const more = container.querySelector(`[data-testid="${KEYBOARD_BAR_MORE_TESTID}"]`);
    expect(more).not.toBeNull();
    expect(more).toHaveTextContent(`+${total - 3} more`);

    // The count hook keeps TOTAL semantics, not the bounded visible count.
    expect(document.body.getAttribute(BODY_KEYBOARD_MODE_COUNT_ATTR)).toBe(String(total));

    // The overflow affordance is static: still no focusable descendant / live region.
    const root = bar(container)!;
    expect(root.querySelectorAll('button, [tabindex], [href]')).toHaveLength(0);
    expect(root.querySelectorAll('[aria-live], [role="status"]')).toHaveLength(0);
    expect(root.style.pointerEvents).toBe('none');
  });

  it('keeps the context-scoped action inside the visible set (F-1 ordering)', () => {
    const { container } = renderWithChakra(<KeyboardBar reducedMotion maxVisibleRows={3} />);
    act(() => {
      enterKeyboardMode();
    });
    act(() => {
      enterHotkeyContext(REFERENCE_CONTEXT_ID);
    });

    const visible = rows(container);
    const scoped = container.querySelector(
      `[data-testid="${KEYBOARD_BAR_ROW_TESTID}"][data-hotkey-action="${REFERENCE_ONLY_ACTION_ID}"]`,
    );
    expect(scoped).not.toBeNull();
    // Context-scoped rows lead, so the deeper action is inside the visible set.
    expect(Array.from(visible)).toContain(scoped);
  });

  it('keeps the descent action inside the visible set at the reference context', () => {
    // Static counterpart of the F-5 live assertion: the action the tester found
    // off-screen (fredo.context.descendReference) now renders inside the bounded,
    // context-scoped-first visible set at a many-action context.
    const { container } = renderWithChakra(<KeyboardBar reducedMotion maxVisibleRows={3} />);
    act(() => {
      enterKeyboardMode();
    });
    act(() => {
      enterHotkeyContext(REFERENCE_CONTEXT_ID);
    });

    const descend = container.querySelector(
      `[data-testid="${KEYBOARD_BAR_ROW_TESTID}"][data-hotkey-action="${REFERENCE_DESCEND_ACTION_ID}"]`,
    );
    expect(descend).not.toBeNull();
    expect(rows(container)).toContain(descend);
  });
});

// ── Empty state (R-5.4) ──────────────────────────────────────────────────────

describe('KeyboardBar — defined empty state (R-5.4)', () => {
  it('renders the defined empty element (never a blank bar) when no action resolves', () => {
    resetRegistryForTests();
    const { container } = renderWithChakra(<KeyboardBar reducedMotion />);
    act(() => {
      enterKeyboardMode();
    });

    const empty = container.querySelector(`[data-testid="${KEYBOARD_BAR_EMPTY_TESTID}"]`);
    expect(empty).not.toBeNull();
    expect(empty).toHaveTextContent(KEYBOARD_BAR_EMPTY_TEXT);
    expect(rows(container)).toHaveLength(0);
    // The exit chip is always pinned, even in the empty context.
    expect(container.querySelector(`[data-testid="${KEYBOARD_BAR_EXIT_TESTID}"]`)).not.toBeNull();
    expect(document.body.getAttribute(BODY_KEYBOARD_MODE_COUNT_ATTR)).toBe('0');
  });
});

// ── Unavailable rows (R-5.1/R-5.2) ───────────────────────────────────────────

describe('KeyboardBar — unavailable rows with reasons (R-5.1/R-5.2)', () => {
  it('marks bare keys unavailable while typing, with a visible reason and state icon', () => {
    mountInput();
    const { container } = renderWithChakra(<KeyboardBar reducedMotion />);
    act(() => {
      enterKeyboardMode();
    });

    const unavailable = container.querySelectorAll<HTMLElement>(
      `[data-testid="${KEYBOARD_BAR_ROW_TESTID}"][data-availability="unavailable"]`,
    );
    expect(unavailable.length).toBeGreaterThan(0);

    const first = unavailable[0];
    expect(first.querySelector('svg')).not.toBeNull();
    expect(first).toHaveTextContent('unavailable');
    const reason = first.querySelector(`[data-testid="${KEYBOARD_BAR_ROW_REASON_TESTID}"]`);
    expect(reason).not.toBeNull();
    expect(reason).toHaveTextContent('Unavailable while typing');

    // A modifier chord stays available (R-5.5 honesty — the engine's own decision).
    const available = container.querySelectorAll<HTMLElement>(
      `[data-testid="${KEYBOARD_BAR_ROW_TESTID}"][data-availability="available"]`,
    );
    expect(available.length).toBeGreaterThan(0);
  });

  it('gives the unavailable chip its own budget, floors the title, and protects the full reason (F-2 round 3)', () => {
    mountInput();
    const { container } = renderWithChakra(<KeyboardBar reducedMotion />);
    act(() => {
      enterKeyboardMode();
    });

    const unavailable = container.querySelectorAll<HTMLElement>(
      `[data-testid="${KEYBOARD_BAR_ROW_TESTID}"][data-availability="unavailable"]`,
    );
    expect(unavailable.length).toBeGreaterThan(0);
    const first = unavailable[0];

    // The unavailable chip uses the dedicated 480 px budget (pinned exactly); an
    // available chip keeps the round-2 240 px clamp.
    expect(KEYBOARD_BAR_UNAVAILABLE_ROW_MAX_WIDTH_PX).toBe(480);
    expect(getComputedStyle(first).maxWidth).toBe('480px');
    const available = container.querySelector<HTMLElement>(
      `[data-testid="${KEYBOARD_BAR_ROW_TESTID}"][data-availability="available"]`,
    );
    expect(available).not.toBeNull();
    expect(getComputedStyle(available as HTMLElement).maxWidth).toBe('240px');

    // The title is the ONLY ellipsis target and carries a 48 px floor so it can
    // never collapse to a 0 px box.
    const title = Array.from(first.querySelectorAll('p')).find(
      (node) =>
        node.getAttribute('data-testid') !== KEYBOARD_BAR_ROW_REASON_TESTID &&
        node.textContent !== 'unavailable',
    );
    expect(title).not.toBeUndefined();
    expect(KEYBOARD_BAR_ROW_TITLE_MIN_WIDTH_PX).toBe(48);
    expect(getComputedStyle(title as HTMLElement).minWidth).toBe('48px');
    expect(getComputedStyle(title as HTMLElement).textOverflow).toBe('ellipsis');

    // The reason is EXEMPT from the clamp: full declared text, no own
    // overflow-hidden / ellipsis / max-width (so `while typing` stays readable).
    const reason = first.querySelector<HTMLElement>(
      `[data-testid="${KEYBOARD_BAR_ROW_REASON_TESTID}"]`,
    );
    expect(reason).not.toBeNull();
    expect(reason as HTMLElement).toHaveTextContent('Unavailable while typing');
    const reasonStyle = getComputedStyle(reason as HTMLElement);
    expect(reasonStyle.overflow).not.toBe('hidden');
    expect(reasonStyle.textOverflow).not.toBe('ellipsis');
    expect(reasonStyle.maxWidth).not.toBe('480px');

    // No interaction is introduced: the bar stays non-focusable, with ONE announcer
    // (the bar carries none) and the TOTAL-count body hook.
    const root = bar(container)!;
    expect(root.querySelectorAll('button, [tabindex], [href]')).toHaveLength(0);
    expect(root.querySelectorAll('[aria-live], [role="status"]')).toHaveLength(0);
    const totalRows = resolveActiveBindings().filter((binding) => binding.sequence.length > 0).length;
    expect(document.body.getAttribute(BODY_KEYBOARD_MODE_COUNT_ATTR)).toBe(String(totalRows));
  });
});

// ── Terminal passthrough suppression (R-5.3) ─────────────────────────────────

describe('KeyboardBar — terminal passthrough suppression (R-5.3)', () => {
  it('hides the bar while passthrough is active and restores it without re-entering', () => {
    const { container } = renderWithChakra(<KeyboardBar reducedMotion />);
    act(() => {
      enterKeyboardMode();
    });
    expect(bar(container)).not.toBeNull();

    act(() => {
      setPassthrough(true);
    });
    expect(bar(container)).toBeNull();
    expect(isKeyboardModeOn()).toBe(true);
    expect(document.body.hasAttribute(BODY_KEYBOARD_MODE_COUNT_ATTR)).toBe(false);

    act(() => {
      setPassthrough(false);
    });
    expect(bar(container)).not.toBeNull();
    expect(isKeyboardModeOn()).toBe(true);
  });
});

// ── Live context follow (R-3.1) ──────────────────────────────────────────────

describe('KeyboardBar — live context follow (R-3.1)', () => {
  it('descends into the deeper context and returns without re-entering the mode', () => {
    const { container } = renderWithChakra(<KeyboardBar reducedMotion />);
    act(() => {
      enterKeyboardMode();
    });
    expect(
      container.querySelector(`[data-hotkey-action="${REFERENCE_ONLY_ACTION_ID}"]`),
    ).toBeNull();

    act(() => {
      enterHotkeyContext(REFERENCE_CONTEXT_ID);
    });
    expect(isKeyboardModeOn()).toBe(true);
    expect(
      container.querySelector(`[data-hotkey-action="${REFERENCE_ONLY_ACTION_ID}"]`),
    ).not.toBeNull();

    act(() => {
      exitHotkeyContext();
    });
    expect(isKeyboardModeOn()).toBe(true);
    expect(
      container.querySelector(`[data-hotkey-action="${REFERENCE_ONLY_ACTION_ID}"]`),
    ).toBeNull();
  });
});

// ── Announcements (R-4.2/R-4.3/R-4.4) ────────────────────────────────────────

describe('KeyboardBar — the ONE announcement channel (R-4.2/R-4.3)', () => {
  it('announces entry, then the context change, then the distinct exit copy', () => {
    renderWithChakra(<KeyboardBar reducedMotion />);

    act(() => {
      enterKeyboardMode();
    });
    expect(getAnnouncement().startsWith('Keyboard mode on. Fredo.')).toBe(true);
    expect(getAnnouncement()).toContain('actions');

    act(() => {
      enterHotkeyContext(REFERENCE_CONTEXT_ID);
    });
    // The bar is the ONE write per change (contextStack suppresses its own copy).
    expect(getAnnouncement().startsWith('Reference. Level 2.')).toBe(true);
    expect(getAnnouncement()).not.toContain('Entered Reference');

    act(() => {
      exitKeyboardMode();
    });
    expect(getAnnouncement()).toBe('Keyboard mode off.');
  });

  it('announces the empty context through the same channel', () => {
    resetRegistryForTests();
    renderWithChakra(<KeyboardBar reducedMotion />);
    act(() => {
      enterKeyboardMode();
    });
    expect(getAnnouncement()).toBe('Keyboard mode on. Fredo. No actions in this context.');
  });

  it('does not duplicate the context announcement while mode is ON (single write)', () => {
    registerHotkeyContext({ contextId: ROOT_CONTEXT_ID, parentId: ROOT_CONTEXT_ID, title: 'Fredo' });
    renderWithChakra(<KeyboardBar reducedMotion />);
    act(() => {
      enterKeyboardMode();
    });
    resetHotkeyAnnouncer();

    act(() => {
      enterHotkeyContext(REFERENCE_CONTEXT_ID);
    });
    // Exactly the mode-aware digest — never the stack's `Entered …` copy.
    expect(getAnnouncement()).not.toContain('Entered');
    expect(getAnnouncement().startsWith('Reference. Level 2.')).toBe(true);
  });
});

// ── Reduced motion (R-4.5) ───────────────────────────────────────────────────

describe('KeyboardBar — reduced motion + fade budget (R-4.5)', () => {
  it('fades in over ≤150 ms when motion is allowed', () => {
    const { container } = renderWithChakra(<KeyboardBar reducedMotion={false} />);
    act(() => {
      enterKeyboardMode();
    });
    const root = bar(container)!;
    expect(root.style.animation).toContain(`${KEYBOARD_BAR_FADE_MS}ms`);
    expect(root.style.transition).toContain(`${KEYBOARD_BAR_FADE_MS}ms`);
  });

  it('disables all motion under prefers-reduced-motion', () => {
    const { container } = renderWithChakra(<KeyboardBar reducedMotion />);
    act(() => {
      enterKeyboardMode();
    });
    const root = bar(container)!;
    expect(root.style.animation).toBe('none');
    expect(root.style.transition).toBe('none');
  });
});

// ── #523 no render loop ──────────────────────────────────────────────────────

describe('KeyboardBar — settles without a re-render loop (#523)', () => {
  it('mounts, follows a context change and exits with no depth error', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container } = renderWithChakra(<KeyboardBar reducedMotion />);

    act(() => {
      enterKeyboardMode();
    });
    act(() => {
      enterHotkeyContext(REFERENCE_CONTEXT_ID);
    });
    act(() => {
      exitHotkeyContext();
    });
    expect(bar(container)).not.toBeNull();
    act(() => {
      exitKeyboardMode();
    });
    expect(bar(container)).toBeNull();

    const messages = errorSpy.mock.calls.map((call) => String(call[0] ?? ''));
    expect(messages.some((message) => message.includes('Maximum update depth'))).toBe(false);
  });
});
