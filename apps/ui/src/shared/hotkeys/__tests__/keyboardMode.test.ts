/**
 * Spec #2959 ST-1 — keyboard-mode state + its ONE body hook (EARS R-1.1…R-1.4).
 *
 * Pins: the transient module-scoped flag, its observable
 * `data-fredo-keyboard-mode` hook (present `"true"` while ON, ABSENT while OFF),
 * the toggle semantics, idempotent enter/exit, the `useSyncExternalStore`
 * binding, the canonical action id/chord, and the R-1.4 invariant that entry and
 * exit never move `document.activeElement`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

import {
  BODY_KEYBOARD_MODE_ATTR,
  KEYBOARD_MODE_ACTION_ID,
  KEYBOARD_MODE_CHORD,
  enterKeyboardMode,
  exitKeyboardMode,
  isKeyboardModeOn,
  resetKeyboardModeForTests,
  subscribeKeyboardMode,
  toggleKeyboardMode,
  useKeyboardMode,
} from '../keyboardMode';

beforeEach(() => {
  document.body.innerHTML = '';
  document.body.removeAttribute(BODY_KEYBOARD_MODE_ATTR);
  resetKeyboardModeForTests();
});

afterEach(() => {
  cleanup();
  resetKeyboardModeForTests();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('keyboard mode state (R-1.1/R-1.2)', () => {
  it('starts OFF with no body hook', () => {
    expect(isKeyboardModeOn()).toBe(false);
    expect(document.body.hasAttribute(BODY_KEYBOARD_MODE_ATTR)).toBe(false);
  });

  it('enter turns it ON and publishes the body hook', () => {
    enterKeyboardMode();

    expect(isKeyboardModeOn()).toBe(true);
    expect(document.body.getAttribute(BODY_KEYBOARD_MODE_ATTR)).toBe('true');
  });

  it('exit turns it OFF and removes the body hook', () => {
    enterKeyboardMode();
    exitKeyboardMode();

    expect(isKeyboardModeOn()).toBe(false);
    // The attribute is ABSENT when OFF (not "false") — R-1.3.
    expect(document.body.hasAttribute(BODY_KEYBOARD_MODE_ATTR)).toBe(false);
  });

  it('toggle flips the mode on each call (the engine action run)', () => {
    toggleKeyboardMode();
    expect(isKeyboardModeOn()).toBe(true);
    expect(document.body.getAttribute(BODY_KEYBOARD_MODE_ATTR)).toBe('true');

    toggleKeyboardMode();
    expect(isKeyboardModeOn()).toBe(false);
    expect(document.body.hasAttribute(BODY_KEYBOARD_MODE_ATTR)).toBe(false);
  });

  it('enter/exit are idempotent — a repeated call is a no-op', () => {
    const enterListener = vi.fn();
    const unsubscribe = subscribeKeyboardMode(enterListener);

    enterKeyboardMode();
    enterKeyboardMode();
    expect(enterListener).toHaveBeenCalledTimes(1);

    exitKeyboardMode();
    exitKeyboardMode();
    expect(enterListener).toHaveBeenCalledTimes(2);

    unsubscribe();
    expect(enterListener).toHaveBeenCalledTimes(2);
  });
});

describe('keyboard mode names (ONE authoritative block)', () => {
  it('exposes the canonical action id, chord and body hook', () => {
    expect(KEYBOARD_MODE_ACTION_ID).toBe('fredo.keyboardMode.toggle');
    expect(KEYBOARD_MODE_CHORD).toBe('ctrl+shift+f8');
    expect(BODY_KEYBOARD_MODE_ATTR).toBe('data-fredo-keyboard-mode');
  });
});

describe('entry/exit never move focus (R-1.4)', () => {
  it('document.activeElement is unchanged across enter and exit', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    expect(document.activeElement).toBe(input);

    enterKeyboardMode();
    expect(document.activeElement).toBe(input);

    exitKeyboardMode();
    expect(document.activeElement).toBe(input);
  });
});

describe('React binding', () => {
  it('useKeyboardMode re-renders on a real change and reads the live flag', () => {
    const { result } = renderHook(() => useKeyboardMode());
    expect(result.current).toBe(false);

    act(() => {
      enterKeyboardMode();
    });
    expect(result.current).toBe(true);

    act(() => {
      toggleKeyboardMode();
    });
    expect(result.current).toBe(false);
  });

  it('resetKeyboardModeForTests restores the OFF state + clears the hook', () => {
    enterKeyboardMode();
    resetKeyboardModeForTests();

    expect(isKeyboardModeOn()).toBe(false);
    expect(document.body.hasAttribute(BODY_KEYBOARD_MODE_ATTR)).toBe(false);
  });
});
