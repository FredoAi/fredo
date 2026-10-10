/**
 * Spec #3009 ST-3 — the ONE dispatch engine on the element model.
 *
 * Pins: exactly ONE document keydown listener, the kept platform globals
 * (`primary+space`, `primary+tab`, `primary+shift+tab`), element-hotkey dispatch,
 * focus-aware suppression (text-entry / modal / terminal / native-consumer), the
 * pending-sequence state machine, and the `document.body` DOM hooks.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  closeWindow,
  getWindowSnapshot,
  openWindow,
  resetWindowStoreForTests,
} from '@/shared/window-system/windowStore';
import { getAnnouncement, resetHotkeyAnnouncer } from '../announcer';
import {
  BODY_FOCUS_CONTEXT_ATTR,
  BODY_PASSTHROUGH_ATTR,
  BODY_PENDING_SEQUENCE_ATTR,
  LAUNCHER_TOGGLE_ACTION_ID,
  getFocusSnapshot,
  getPendingPrefix,
  handleHotkeyKeydown,
  installHotkeyEngine,
  isHotkeyEngineInstalled,
  resetHotkeyEngineForTests,
  subscribeFocusSnapshot,
} from '../engine';
import {
  flushElementHotkeys,
  installHotkeyElementDiscovery,
  resetHotkeyElementDiscoveryForTests,
} from '../hotkeyElements';
import { resetRegistryForTests } from '../registry';
import type { DispatchDecision } from '../types';

// ── Harness helpers ──────────────────────────────────────────────────────────

function keydown(target: EventTarget, init: KeyboardEventInit): { prevented: boolean } {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  const notCancelled = target.dispatchEvent(event);
  return { prevented: !notCancelled };
}

function dispatch(init: KeyboardEventInit): { decision: DispatchDecision; prevented: boolean } {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  const decision = handleHotkeyKeydown(event);
  return { decision, prevented: event.defaultPrevented };
}

function mountNeutral(): HTMLElement {
  const el = document.createElement('div');
  el.tabIndex = -1;
  document.body.appendChild(el);
  el.focus();
  return el;
}

function mountInput(): HTMLInputElement {
  const input = document.createElement('input');
  document.body.appendChild(input);
  input.focus();
  return input;
}

function mountButton(): HTMLButtonElement {
  const button = document.createElement('button');
  document.body.appendChild(button);
  button.focus();
  return button;
}

function mountTerminal(): HTMLElement {
  const root = document.createElement('div');
  root.setAttribute('data-fredo-terminal-root', 'true');
  const inner = document.createElement('div');
  inner.tabIndex = -1;
  root.appendChild(inner);
  document.body.appendChild(root);
  inner.focus();
  return inner;
}

/** Mount a `<button data-hotkey="k">` and return the element + a mutable click count. */
function mountHotkeyButton(hotkey: string): { button: HTMLButtonElement; clicks: number } {
  const state = { button: document.createElement('button'), clicks: 0 };
  state.button.setAttribute('data-hotkey', hotkey);
  document.body.appendChild(state.button);
  state.button.addEventListener('click', () => {
    state.clicks += 1;
  });
  return state as { button: HTMLButtonElement; clicks: number };
}

function openTestWindow(id: string): void {
  openWindow({
    id,
    title: id,
    icon: (() => null) as never,
    component: (() => null) as never,
  });
}

function installAll(): void {
  installHotkeyEngine();
  installHotkeyElementDiscovery();
}

let uninstallDiscovery: (() => void) | null = null;

beforeEach(() => {
  localStorage.clear();
  resetRegistryForTests();
  resetWindowStoreForTests();
  resetHotkeyAnnouncer();
  resetHotkeyEngineForTests();
  resetHotkeyElementDiscoveryForTests();
  document.body.innerHTML = '';
});

afterEach(() => {
  uninstallDiscovery?.();
  uninstallDiscovery = null;
  resetHotkeyElementDiscoveryForTests();
  resetHotkeyEngineForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

// ── 1. Exactly ONE listener ──────────────────────────────────────────────────

describe('engine — exactly ONE document keydown listener', () => {
  it('adds one keydown listener and is idempotent on re-install', () => {
    const addSpy = vi.spyOn(document, 'addEventListener');
    const uninstall = installHotkeyEngine();
    const keydownAdds = () => addSpy.mock.calls.filter(([type]) => type === 'keydown').length;

    expect(keydownAdds()).toBe(1);
    installHotkeyEngine();
    expect(keydownAdds()).toBe(1);

    uninstall();
    expect(isHotkeyEngineInstalled()).toBe(false);
    addSpy.mockRestore();
  });
});

// ── 2. Kept globals ──────────────────────────────────────────────────────────

describe('engine — kept platform globals', () => {
  it('Ctrl+Space resolves the kept launcher-toggle binding and consumes the chord', () => {
    installAll();
    const el = mountNeutral();
    const { prevented } = keydown(el, { key: ' ', ctrlKey: true });
    expect(prevented).toBe(true);
    expect(document.body.getAttribute(BODY_FOCUS_CONTEXT_ATTR)).toBe('default');
  });

  it('Ctrl+Tab / Ctrl+Shift+Tab move the focused window', () => {
    installAll();
    const el = mountNeutral();
    openTestWindow('a');
    openTestWindow('b'); // 'b' focused

    keydown(el, { key: 'Tab', ctrlKey: true });
    expect(getWindowSnapshot().find((w) => w.focused)?.id).toBe('a');

    keydown(el, { key: 'Tab', ctrlKey: true, shiftKey: true });
    expect(getWindowSnapshot().find((w) => w.focused)?.id).toBe('b');
  });

  it('Ctrl+1..9 does NOT switch windows (digits are free)', () => {
    installAll();
    const el = mountNeutral();
    openTestWindow('a');
    openTestWindow('b'); // 'b' focused

    keydown(el, { key: '1', ctrlKey: true });
    expect(getWindowSnapshot().find((w) => w.focused)?.id).toBe('b');
  });
});

// ── 3. Element hotkeys ───────────────────────────────────────────────────────

describe('engine — element hotkeys (the ONE path)', () => {
  it('a bare key activates the mounted data-hotkey control', () => {
    installAll();
    const el = mountNeutral();
    const hotkeyButton = mountHotkeyButton('a');
    flushElementHotkeys();

    const { prevented } = keydown(el, { key: 'a' });

    expect(prevented).toBe(true);
    expect(hotkeyButton.clicks).toBe(1);
    expect(hotkeyButton.button).toBeDefined();
  });

  it('suppresses a bare key in a text-entry control (typed char survives)', () => {
    installAll();
    const hotkeyButton = mountHotkeyButton('a');
    flushElementHotkeys();
    const input = mountInput();

    expect(keydown(input, { key: 'a' }).prevented).toBe(false);
    expect(hotkeyButton.clicks).toBe(0);
    expect(document.body.getAttribute(BODY_FOCUS_CONTEXT_ATTR)).toBe('text-entry');
  });

  it('keeps a modifier chord global in a text field', () => {
    installAll();
    const input = mountInput();

    expect(keydown(input, { key: ' ', ctrlKey: true }).prevented).toBe(true);
    expect(document.body.getAttribute(BODY_FOCUS_CONTEXT_ATTR)).toBe('text-entry');
  });

  it('passes every key to the terminal (no exit chord)', () => {
    installAll();
    const inner = mountTerminal();

    expect(keydown(inner, { key: 'a' }).prevented).toBe(false);
    expect(document.body.getAttribute(BODY_PASSTHROUGH_ATTR)).toBe('true');
    expect(keydown(inner, { key: 'F10', ctrlKey: true, shiftKey: true }).prevented).toBe(false);
  });

  it('a focused native consumer wins on a bare key (no element fire)', () => {
    installAll();
    const hotkeyButton = mountHotkeyButton('a');
    flushElementHotkeys();
    const button = mountButton();

    expect(keydown(button, { key: 'a' }).prevented).toBe(false);
    expect(hotkeyButton.clicks).toBe(0);
  });
});

// ── 4. Pending two-step element sequence (a+b) ───────────────────────────────

describe('engine — pending two-step element sequence', () => {
  it('arms on the first step and fires EXACTLY ONCE on the second', () => {
    installAll();
    const el = mountNeutral();
    const hotkeyButton = mountHotkeyButton('a+b');
    flushElementHotkeys();

    const first = keydown(el, { key: 'a' });
    expect(first.prevented).toBe(true);
    expect(hotkeyButton.clicks).toBe(0);
    expect(getPendingPrefix()).toBe('a');
    expect(document.body.getAttribute(BODY_PENDING_SEQUENCE_ATTR)).toBe('a');

    const second = keydown(el, { key: 'b' });
    expect(second.prevented).toBe(true);
    expect(hotkeyButton.clicks).toBe(1);
    expect(getPendingPrefix()).toBeNull();
    expect(document.body.hasAttribute(BODY_PENDING_SEQUENCE_ATTR)).toBe(false);
  });

  it('an invalid continuation performs no action and visibly resets', () => {
    installAll();
    const el = mountNeutral();
    const hotkeyButton = mountHotkeyButton('a+b');
    flushElementHotkeys();

    keydown(el, { key: 'a' });
    const { prevented } = keydown(el, { key: 'x' });

    expect(hotkeyButton.clicks).toBe(0);
    expect(prevented).toBe(true);
    expect(getPendingPrefix()).toBeNull();
  });

  it('a timeout resets the pending sequence', () => {
    vi.useFakeTimers();
    installAll();
    const el = mountNeutral();
    const hotkeyButton = mountHotkeyButton('a+b');
    flushElementHotkeys();

    keydown(el, { key: 'a' });
    vi.advanceTimersByTime(1500);

    expect(hotkeyButton.clicks).toBe(0);
    expect(getPendingPrefix()).toBeNull();
  });
});

// ── 5. Focus snapshot + DOM hooks ────────────────────────────────────────────

describe('engine — live focus snapshot + DOM hooks', () => {
  it('publishes the ONE focus classification with a stable identity', () => {
    installAll();
    const initial = getFocusSnapshot();
    expect(initial.context).toBe('default');
    expect(initial.textEntry).toBe(false);

    mountInput();
    const textEntry = getFocusSnapshot();
    expect(textEntry.context).toBe('text-entry');
    expect(textEntry.textEntry).toBe(true);
    expect(textEntry).not.toBe(initial);

    const button = mountButton();
    const interactive = getFocusSnapshot();
    expect(interactive.context).toBe('interactive');
    expect(interactive.nativeConsumes).toBe(true);

    keydown(button, { key: 'g' });
    expect(getFocusSnapshot()).toBe(interactive);
  });

  it('mirrors the live focus context + passthrough on document.body', () => {
    installAll();
    expect(document.body.getAttribute(BODY_FOCUS_CONTEXT_ATTR)).toBe('default');

    mountInput();
    expect(document.body.getAttribute(BODY_FOCUS_CONTEXT_ATTR)).toBe('text-entry');
    expect(document.body.hasAttribute(BODY_PASSTHROUGH_ATTR)).toBe(false);

    mountTerminal();
    expect(document.body.getAttribute(BODY_FOCUS_CONTEXT_ATTR)).toBe('terminal');
    expect(document.body.getAttribute(BODY_PASSTHROUGH_ATTR)).toBe('true');

    mountNeutral();
    expect(document.body.getAttribute(BODY_FOCUS_CONTEXT_ATTR)).toBe('default');
    expect(document.body.hasAttribute(BODY_PASSTHROUGH_ATTR)).toBe(false);
  });

  it('notifies focus-snapshot subscribers on a real change', () => {
    installAll();
    mountInput();

    const listener = vi.fn();
    const unsubscribe = subscribeFocusSnapshot(listener);

    dispatch({ key: 'g' });
    expect(listener).not.toHaveBeenCalled();

    mountButton();
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });
});

// ── 6. Window close resets focus ─────────────────────────────────────────────

describe('engine — window lifecycle', () => {
  it('closing the focused window leaves focus resolution stable', () => {
    installAll();
    const el = mountNeutral();
    openTestWindow('a');
    closeWindow('a');
    const { decision } = dispatch({ key: 'z' });
    expect(decision.outcome).toBe('passthrough');
    expect(getAnnouncement()).toBe('');
    expect(el.isConnected).toBe(true);
  });
});
