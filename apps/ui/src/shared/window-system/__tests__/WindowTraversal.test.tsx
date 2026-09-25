/**
 * Spec #2946 ST-10 — keyboard-only traversal on the REAL window frame (AC1).
 *
 * These DOM tests render the production `WindowFrame`/`WindowChrome` over the
 * real module-scoped `windowStore` and assert:
 *  - the frame/content DOM hooks (`data-testid`, `data-focused`,
 *    `data-focused-window`) the contract block 7 + UI/UX §5 require,
 *  - a keyboard raise (engine `Ctrl+Tab`) puts DOM focus on the window's first
 *    CONTENT control — not a chrome button, never `body` (R-1.1/R-1.2),
 *  - the focused-window cue is not colour-only (title weight + `data-focused-title`),
 *  - plain Tab/Shift+Tab cross the window boundary; the target is scrolled into
 *    view before focus lands (R-1.5/R-1.6),
 *  - `windowStore`'s open/close/focus contract is consumed unchanged.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useSyncExternalStore } from 'react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { WindowFrame } from '../WindowFrame';
import { WindowManager } from '../WindowManager';
import {
  getWindowSnapshot,
  openWindow,
  resetWindowStoreForTests,
  subscribeWindows,
} from '../windowStore';
import { installHotkeyEngine, resetHotkeyEngineForTests } from '@/shared/hotkeys/engine';
import { resetRegistryForTests } from '@/shared/hotkeys/registry';
import { resetKeymapStoreForTests } from '@/shared/hotkeys/store';
import { focusPreviousWindow, resetWindowTraversalForTests } from '@/shared/hotkeys/traversal';

function WindowHarness() {
  const windows = useSyncExternalStore(subscribeWindows, getWindowSnapshot, getWindowSnapshot);
  const ordered = [...windows].sort((a, b) => a.zIndex - b.zIndex);
  return (
    <>
      {ordered.map((win) => (
        <WindowFrame key={win.id} window={win} />
      ))}
    </>
  );
}

function openFeature(id: string): void {
  openWindow({
    id,
    title: id,
    icon: <span aria-hidden="true" />,
    component: <button data-testid={`content-${id}`}>{`content-${id}`}</button>,
    isMaximized: false,
  });
}

function titleOf(id: string): HTMLElement {
  const frame = screen.getByTestId(`window-frame-${id}`);
  const title = frame.querySelector<HTMLElement>('[data-focused-title]');
  if (!title) throw new Error(`title for ${id} not found`);
  return title;
}

let scrollSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetWindowStoreForTests();
  resetRegistryForTests();
  resetKeymapStoreForTests();
  resetWindowTraversalForTests();
  resetHotkeyEngineForTests();
  document.body.innerHTML = '';
  scrollSpy = vi.fn();
  (HTMLElement.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView = scrollSpy;
});

afterEach(() => {
  cleanup();
  resetWindowTraversalForTests();
  resetHotkeyEngineForTests();
  resetRegistryForTests();
  resetWindowStoreForTests();
  document.body.innerHTML = '';
  delete (HTMLElement.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView;
  vi.restoreAllMocks();
});

// ── DOM hooks ────────────────────────────────────────────────────────────────

describe('WindowFrame — traversal DOM hooks (contract block 7)', () => {
  it('exposes the frame + content testids and the focus mirrors', () => {
    openFeature('a');
    openFeature('b'); // 'b' focused
    renderWithChakra(<WindowHarness />);

    const frameA = screen.getByTestId('window-frame-a');
    const frameB = screen.getByTestId('window-frame-b');

    expect(frameA).toHaveAttribute('data-focused', 'false');
    expect(frameA).not.toHaveAttribute('data-focused-window');
    expect(frameB).toHaveAttribute('data-focused', 'true');
    expect(frameB).toHaveAttribute('data-focused-window', 'true');

    expect(screen.getByTestId('window-content-a')).toBeInTheDocument();
    expect(screen.getByTestId('window-content-b')).toBeInTheDocument();
  });
});

// ── R-1.1/R-1.2 — engine chord raises + places content focus ─────────────────

describe('traversal — keyboard raise via the engine chord (R-1.1/R-1.2)', () => {
  it('Ctrl+Tab raises the next window and focuses its first CONTENT control', () => {
    installHotkeyEngine();
    openFeature('a');
    openFeature('b'); // 'b' focused
    renderWithChakra(<WindowHarness />);

    fireEvent.keyDown(document, { key: 'Tab', ctrlKey: true });

    expect(screen.getByTestId('window-frame-a')).toHaveAttribute('data-focused', 'true');
    expect(screen.getByTestId('window-frame-b')).toHaveAttribute('data-focused', 'false');

    const target = screen.getByTestId('content-a');
    expect(document.activeElement).toBe(target);
    // The chrome controls must NOT capture the keyboard raise.
    expect(document.activeElement).not.toBe(screen.getByRole('button', { name: 'Minimize a' }));
    expect(document.activeElement).not.toBe(document.body);
  });

  it('ctrl+1..9 focuses the Nth window through the real binding', () => {
    installHotkeyEngine();
    openFeature('a');
    openFeature('b');
    renderWithChakra(<WindowHarness />);

    fireEvent.keyDown(document, { key: '1', ctrlKey: true });

    expect(screen.getByTestId('window-frame-a')).toHaveAttribute('data-focused', 'true');
    expect(document.activeElement).toBe(screen.getByTestId('content-a'));
  });
});

// ── R-1.3 — focused-window cue is not colour-only ────────────────────────────

describe('WindowChrome — focused-window cue is not colour-only (R-1.3)', () => {
  it('adds a weight/shape cue to the title and mirrors it in the DOM', () => {
    openFeature('a');
    renderWithChakra(<WindowHarness />);

    const focused = titleOf('a');
    expect(focused).toHaveAttribute('data-focused-title', 'true');
    const focusedWeight = getComputedStyle(focused).fontWeight;

    act(() => {
      openFeature('b'); // 'a' loses focus
    });

    const unfocused = titleOf('a');
    expect(unfocused).toHaveAttribute('data-focused-title', 'false');
    const unfocusedWeight = getComputedStyle(unfocused).fontWeight;

    expect(focusedWeight).not.toBe(unfocusedWeight);
    expect(focusedWeight).toBeTruthy();
    expect(unfocusedWeight).toBeTruthy();
  });

  it('keeps the frame accent border/shadow emphasis alongside the weight cue', () => {
    openFeature('a');
    renderWithChakra(<WindowHarness />);
    const frame = screen.getByTestId('window-frame-a');
    // The focused frame keeps its box-shadow emphasis (token-derived, non-none).
    expect(getComputedStyle(frame).boxShadow).not.toBe('');
    expect(frame.getAttribute('data-focused-window')).toBe('true');
  });
});

// ── R-1.5/R-1.6 — cross-window Tab + scroll-into-view ────────────────────────

describe('traversal — cross-window Tab boundary (R-1.5/R-1.6)', () => {
  it('Tab from the last content control moves to the next window; Shift+Tab returns', () => {
    openFeature('a');
    openFeature('b');
    renderWithChakra(<WindowHarness />);

    const contentA = screen.getByTestId('content-a');
    const contentB = screen.getByTestId('content-b');

    contentA.focus();
    const forward = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    contentA.dispatchEvent(forward);

    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(contentB);

    const backward = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    contentB.dispatchEvent(backward);

    expect(backward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(contentA);
  });

  it('scrolls the target into view before focus lands on a boundary hop (R-1.6)', () => {
    openFeature('a');
    openFeature('b');
    renderWithChakra(<WindowHarness />);

    const contentA = screen.getByTestId('content-a');
    const contentB = screen.getByTestId('content-b');
    const order: string[] = [];
    scrollSpy.mockImplementation(() => order.push('scroll'));
    vi.spyOn(contentB, 'focus').mockImplementation(() => {
      order.push('focus');
    });

    contentA.focus();
    contentA.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
    );

    expect(order).toEqual(['scroll', 'focus']);
  });
});

// ── windowStore contract untouched ───────────────────────────────────────────

describe('traversal — windowStore open/close/focus contract untouched', () => {
  it('WindowManager still renders one frame per open window', () => {
    openFeature('a');
    renderWithChakra(<WindowManager />);
    expect(screen.getAllByTestId(/^window-frame-/)).toHaveLength(1);
  });

  it('raising through traversal only calls the store focusWindow semantics', () => {
    openFeature('a');
    openFeature('b');
    renderWithChakra(<WindowHarness />);
    expect(getWindowSnapshot().find((w) => w.focused)?.id).toBe('b');

    act(() => {
      focusPreviousWindow();
    });

    // previous from 'b' → 'a' focused, and only one window focused (store rule).
    const focused = getWindowSnapshot().filter((w) => w.focused);
    expect(focused).toHaveLength(1);
    expect(focused[0].id).toBe('a');
  });
});
