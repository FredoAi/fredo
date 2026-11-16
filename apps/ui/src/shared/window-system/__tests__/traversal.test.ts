/**
 * Spec #3122 (P8), ST-1 — the relocated keyboard-only window traversal engine.
 *
 * Pins the traversal unit contract against a hand-built window DOM, now that the module lives
 * in the window system and carries NO legacy registry/engine edge:
 *  - next/previous/Nth raise the window AND place DOM focus on its first focusable control
 *    (content region when it has none) — never `body`;
 *  - no open window ⇒ every entry point is a silent no-op;
 *  - plain Tab/Shift+Tab cross a window boundary; a modified Tab is ignored so the
 *    navigation global chord dispatcher's `primary+tab` is untouched;
 *  - the target is scrolled into view BEFORE focus lands;
 *  - Escape return goes to the invoker, or the focused window's first focusable when the
 *    invoker is disconnected;
 *  - `installWindowTraversal` is idempotent (ONE plain-Tab listener) and reference counted.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getWindowSnapshot,
  openWindow,
  resetWindowStoreForTests,
} from '../windowStore';
import {
  focusFirstInWindow,
  focusLastInWindow,
  focusNextWindow,
  focusPreviousWindow,
  focusWindowByIndex,
  focusWindowWithKeyboard,
  getFocusableElements,
  getFocusedWindowId,
  getWindowContentElement,
  getWindowFrameElement,
  getWindowIds,
  handleWindowBoundaryTab,
  installWindowTraversal,
  isWindowTraversalInstalled,
  resetWindowTraversalForTests,
  restoreTransientFocus,
  scrollIntoViewIfNeeded,
  windowIdFromFrame,
} from '../traversal';

// ── Harness ──────────────────────────────────────────────────────────────────

function openTestWindow(id: string): void {
  openWindow({
    id,
    title: id,
    icon: null as never,
    component: null as never,
  });
}

interface BuiltFrame {
  readonly frame: HTMLElement;
  readonly content: HTMLElement;
  readonly controls: HTMLButtonElement[];
}

/** Build the real DOM hook shape the frame renders (`data-testid` + content). */
function buildFrame(windowId: string, controlCount: number): BuiltFrame {
  const frame = document.createElement('div');
  frame.setAttribute('data-testid', `window-frame-${windowId}`);
  const content = document.createElement('div');
  content.setAttribute('data-testid', `window-content-${windowId}`);
  content.tabIndex = -1;
  frame.appendChild(content);
  const controls: HTMLButtonElement[] = [];
  for (let i = 0; i < controlCount; i += 1) {
    const button = document.createElement('button');
    button.textContent = `${windowId}-${i}`;
    content.appendChild(button);
    controls.push(button);
  }
  document.body.appendChild(frame);
  return { frame, content, controls };
}

function keydownOn(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

let scrollSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetWindowStoreForTests();
  resetWindowTraversalForTests();
  document.body.innerHTML = '';
  scrollSpy = vi.fn();
  (HTMLElement.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView = scrollSpy;
});

afterEach(() => {
  resetWindowTraversalForTests();
  resetWindowStoreForTests();
  document.body.innerHTML = '';
  delete (HTMLElement.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView;
  vi.restoreAllMocks();
});

// ── no open window is a no-op ────────────────────────────────────────────────

describe('traversal — no open window is a silent no-op', () => {
  it('next/previous/Nth leave focus unchanged and never throw', () => {
    const neutral = document.createElement('div');
    neutral.tabIndex = 0;
    document.body.appendChild(neutral);
    neutral.focus();

    expect(() => focusNextWindow()).not.toThrow();
    expect(focusNextWindow()).toBe(false);
    expect(focusPreviousWindow()).toBe(false);
    expect(focusWindowByIndex(1)).toBe(false);
    expect(focusWindowWithKeyboard('missing')).toBe(false);
    expect(getFocusedWindowId()).toBeNull();
    expect(document.activeElement).toBe(neutral);
  });
});

// ── raise + place focus ──────────────────────────────────────────────────────

describe('traversal — raise + place focus', () => {
  it('moves focus to the next/previous/Nth window and raises it in the store', () => {
    openTestWindow('a');
    openTestWindow('b'); // 'b' focused (last opened)
    const a = buildFrame('a', 2);
    buildFrame('b', 2);
    expect(getFocusedWindowId()).toBe('b');

    expect(focusNextWindow()).toBe(true);
    expect(getFocusedWindowId()).toBe('a');
    expect(document.activeElement).toBe(a.controls[0]);

    expect(focusPreviousWindow()).toBe(true);
    expect(getFocusedWindowId()).toBe('b');

    expect(focusWindowByIndex(1)).toBe(true);
    expect(getFocusedWindowId()).toBe('a');
    expect(document.activeElement).toBe(a.controls[0]);

    expect(focusWindowByIndex(3)).toBe(false);
    expect(getFocusedWindowId()).toBe('a');
  });

  it('falls back to the content region when the window has no focusable control', () => {
    openTestWindow('empty');
    const { content } = buildFrame('empty', 0);

    expect(focusWindowWithKeyboard('empty')).toBe(true);
    expect(document.activeElement).toBe(content);
    expect(document.activeElement).not.toBe(document.body);
  });

  it('never leaves focus on body for a rendered window', () => {
    openTestWindow('a');
    const a = buildFrame('a', 1);
    document.body.focus();

    focusWindowWithKeyboard('a');
    expect(document.activeElement).toBe(a.controls[0]);
    expect(document.activeElement).not.toBe(document.body);
  });

  it('scrolls the target into view BEFORE focus lands', () => {
    openTestWindow('a');
    const a = buildFrame('a', 1);
    const order: string[] = [];
    scrollSpy.mockImplementation(() => order.push('scroll'));
    vi.spyOn(a.controls[0], 'focus').mockImplementation(() => {
      order.push('focus');
    });

    focusWindowWithKeyboard('a');

    expect(order).toEqual(['scroll', 'focus']);
  });
});

// ── Focusable discovery ──────────────────────────────────────────────────────

describe('traversal — focusable discovery', () => {
  it('excludes disabled, aria-disabled, hidden and negative-tabindex elements', () => {
    const frame = document.createElement('div');
    frame.innerHTML = `
      <button id="ok">ok</button>
      <button id="disabled" disabled>no</button>
      <button id="aria-disabled" aria-disabled="true">no</button>
      <button id="hidden" hidden>no</button>
      <input id="text" />
      <a id="link" href="#">link</a>
      <div id="zero" tabindex="0"></div>
      <div id="negative" tabindex="-1"></div>
      <div id="aria-hidden" aria-hidden="true" tabindex="0"></div>
    `;
    const ids = getFocusableElements(frame).map((el) => el.id);

    expect(ids).toEqual(['ok', 'text', 'link', 'zero']);
    expect(ids).not.toContain('negative');
  });

  it('resolves the frame/content hooks and the window id from the frame', () => {
    openTestWindow('a');
    const { frame, content } = buildFrame('a', 1);

    expect(getWindowFrameElement('a')).toBe(frame);
    expect(getWindowContentElement('a')).toBe(content);
    expect(windowIdFromFrame(frame)).toBe('a');
    expect(windowIdFromFrame(content)).toBeNull();
    expect(getWindowIds()).toEqual(['a']);
  });
});

// ── Tab boundary hand-off ────────────────────────────────────────────────────

describe('traversal — Tab boundary crosses windows', () => {
  it('Tab at the last control moves to the next window first; Shift+Tab returns', () => {
    openTestWindow('a');
    openTestWindow('b');
    const a = buildFrame('a', 2);
    const b = buildFrame('b', 2);
    installWindowTraversal();

    a.controls[1].focus();
    const forward = keydownOn(a.controls[1], { key: 'Tab' });
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(b.controls[0]);

    const backward = keydownOn(b.controls[0], { key: 'Tab', shiftKey: true });
    expect(backward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(a.controls[1]);
  });

  it('does NOT intercept a mid-window Tab (native DOM order stays in charge)', () => {
    openTestWindow('a');
    openTestWindow('b');
    const a = buildFrame('a', 3);
    buildFrame('b', 2);
    installWindowTraversal();

    a.controls[0].focus();
    const event = keydownOn(a.controls[0], { key: 'Tab' });
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(a.controls[0]);
  });

  it('ignores a modified Tab so the navigation global chord owns primary+tab', () => {
    openTestWindow('a');
    openTestWindow('b');
    const a = buildFrame('a', 2);
    buildFrame('b', 2);
    installWindowTraversal();

    a.controls[1].focus();
    const event = keydownOn(a.controls[1], { key: 'Tab', ctrlKey: true });
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(a.controls[1]);
  });

  it('handleWindowBoundaryTab is a no-op outside a window frame', () => {
    const standalone = document.createElement('button');
    document.body.appendChild(standalone);
    standalone.focus();

    const event = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
    standalone.dispatchEvent(event);
    expect(handleWindowBoundaryTab(event)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });
});

// ── predictable focus return ─────────────────────────────────────────────────

describe('traversal — transient-surface focus return', () => {
  it('returns focus to a connected invoker', () => {
    const invoker = document.createElement('button');
    document.body.appendChild(invoker);
    invoker.focus();

    expect(restoreTransientFocus(invoker)).toBe(invoker);
    expect(document.activeElement).toBe(invoker);
  });

  it('falls back to the focused window first focusable when the invoker is disconnected', () => {
    openTestWindow('a');
    const a = buildFrame('a', 2);
    const invoker = document.createElement('button');
    document.body.appendChild(invoker);
    invoker.remove(); // disconnected

    const restored = restoreTransientFocus(invoker);
    expect(restored).toBe(a.controls[0]);
    expect(document.activeElement).toBe(a.controls[0]);
    expect(document.activeElement).not.toBe(document.body);
  });
});

// ── install lifecycle (no registry edge) ─────────────────────────────────────

describe('traversal — install lifecycle', () => {
  it('is idempotent: exactly ONE Tab listener across re-installs, released by the last', () => {
    const addSpy = vi.spyOn(document, 'addEventListener');
    const releaseFirst = installWindowTraversal();
    const releaseSecond = installWindowTraversal();
    const keydownAdds = () => addSpy.mock.calls.filter(([type]) => type === 'keydown').length;

    expect(keydownAdds()).toBe(1);
    expect(isWindowTraversalInstalled()).toBe(true);

    releaseFirst();
    expect(isWindowTraversalInstalled()).toBe(true);
    releaseSecond();
    expect(isWindowTraversalInstalled()).toBe(false);
    expect(keydownAdds()).toBe(1);
  });

  it('exposes no legacy registry import (relocation keeps behaviour only)', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/shared/window-system/traversal.ts'),
      'utf8',
    );
    expect(source).not.toContain("from './registry'");
    expect(source).not.toContain('registerHotkeyHandler');
  });

  it('focusFirstInWindow / focusLastInWindow reach the boundary controls', () => {
    openTestWindow('a');
    const a = buildFrame('a', 3);

    expect(focusFirstInWindow('a')).toBe(true);
    expect(document.activeElement).toBe(a.controls[0]);
    expect(focusLastInWindow('a')).toBe(true);
    expect(document.activeElement).toBe(a.controls[2]);
  });

  it('scrollIntoViewIfNeeded tolerates a missing implementation', () => {
    const el = document.createElement('div');
    delete (HTMLElement.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView;
    expect(() => scrollIntoViewIfNeeded(el)).not.toThrow();
  });

  it('reads the focused window from the store snapshot', () => {
    expect(getFocusedWindowId()).toBeNull();
    openTestWindow('a');
    expect(getFocusedWindowId()).toBe('a');
    expect(getWindowSnapshot()[0].focused).toBe(true);
  });
});
