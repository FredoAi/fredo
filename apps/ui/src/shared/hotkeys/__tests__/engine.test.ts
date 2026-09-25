/**
 * Spec #2946 ST-4 — the ONE dispatch engine (contract block 4; EARS R-2.5,
 * R-2.6, R-3.1, R-3.3, R-3.4, R-3.5, R-3.6, R-3.10, R-5.5, R-5.6, R-5.7, R-5.9).
 *
 * The pure decision is pinned by `sequence.test.ts`; this suite pins the
 * imperative wiring: exactly ONE document keydown listener, context-aware
 * suppression (text-entry / modal / terminal / native-consumer), the pending
 * sequence state machine (arm → complete exactly once / invalid / timeout /
 * Escape-cancel-consumed), the Ctrl+Space re-home with NO double fire, binding
 * resolution + feature-tier scoping, and the `document.body` DOM hooks.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getWindowSnapshot, openWindow, resetWindowStoreForTests } from '@/shared/window-system/windowStore';
import { resetRegistryForTests, registerFeatureHotkeys, registerFredoAction } from '../registry';
import { createDefaultKeymap } from '../persistence';
import {
  getHotkeyCandidates,
  resetKeymapStoreForTests,
  setLeader,
  setMacroRecording,
} from '../store';
import {
  BODY_FOCUS_CONTEXT_ATTR,
  BODY_MACRO_RECORDING_ATTR,
  BODY_PASSTHROUGH_ATTR,
  BODY_PENDING_SEQUENCE_ATTR,
  LAUNCHER_TOGGLE_ACTION_ID,
  getPendingPrefix,
  installHotkeyEngine,
  resetHotkeyEngineForTests,
  isHotkeyEngineInstalled,
} from '../engine';
import type { FeatureHotkeyAction } from '../types';

// ── Harness helpers ──────────────────────────────────────────────────────────

function fredoRun(
  actionId: string,
  options: { defaultSequence?: string | null; run?: ReturnType<typeof vi.fn> } = {},
): ReturnType<typeof vi.fn> {
  const run = options.run ?? vi.fn();
  const action: FeatureHotkeyAction = {
    actionId,
    title: `Action ${actionId}`,
    defaultSequence: options.defaultSequence ?? null,
    run,
  };
  registerFredoAction(action);
  return run;
}

/** Dispatch a cancelable keydown and report whether the engine consumed it. */
function keydown(target: EventTarget, init: KeyboardEventInit): { prevented: boolean } {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  const notCancelled = target.dispatchEvent(event);
  return { prevented: !notCancelled };
}

/** A focused, non-text, non-native-consumer element (context `default`). */
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

function openTestWindow(id: string): void {
  openWindow({
    id,
    title: id,
    icon: (() => null) as never,
    component: (() => null) as never,
  });
}

beforeEach(() => {
  localStorage.clear();
  resetRegistryForTests();
  resetKeymapStoreForTests();
  resetWindowStoreForTests();
  resetHotkeyEngineForTests();
  document.body.innerHTML = '';
  document.body.removeAttribute(BODY_FOCUS_CONTEXT_ATTR);
  document.body.removeAttribute(BODY_PENDING_SEQUENCE_ATTR);
  document.body.removeAttribute(BODY_PASSTHROUGH_ATTR);
  document.body.removeAttribute(BODY_MACRO_RECORDING_ATTR);
});

afterEach(() => {
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

  it('Ctrl+Space runs the launcher toggle EXACTLY once per press (no double fire)', () => {
    const run = fredoRun(LAUNCHER_TOGGLE_ACTION_ID, { defaultSequence: 'primary+space' });
    installHotkeyEngine();

    const { prevented } = keydown(document, { key: ' ', ctrlKey: true });

    expect(run).toHaveBeenCalledTimes(1);
    expect(prevented).toBe(true);
  });

  it('uninstall stops dispatch', () => {
    const run = fredoRun('fredo.test.after', { defaultSequence: 'primary+space' });
    const uninstall = installHotkeyEngine();
    uninstall();

    keydown(document, { key: ' ', ctrlKey: true });
    expect(run).not.toHaveBeenCalled();
  });
});

// ── 2. Text-entry suppression (R-5.5) ────────────────────────────────────────

describe('engine — text-entry suppression (R-5.5)', () => {
  it('suppresses bare keys and sequences without preventDefault (typed char survives)', () => {
    const bare = fredoRun('fredo.test.bare', { defaultSequence: 'g' });
    const sequence = fredoRun('fredo.test.seq', { defaultSequence: 'j j' });
    installHotkeyEngine();
    const input = mountInput();

    expect(keydown(input, { key: 'g' }).prevented).toBe(false);
    expect(bare).not.toHaveBeenCalled();

    expect(keydown(input, { key: 'j' }).prevented).toBe(false);
    expect(sequence).not.toHaveBeenCalled();
    expect(document.body.hasAttribute(BODY_PENDING_SEQUENCE_ATTR)).toBe(false);
  });

  it('keeps modifier chords global in a text field', () => {
    const run = fredoRun(LAUNCHER_TOGGLE_ACTION_ID, { defaultSequence: 'primary+space' });
    installHotkeyEngine();
    const input = mountInput();

    const { prevented } = keydown(input, { key: ' ', ctrlKey: true });

    expect(prevented).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(document.body.getAttribute(BODY_FOCUS_CONTEXT_ATTR)).toBe('text-entry');
  });
});

// ── 3. Modal suppression (R-5.6) ─────────────────────────────────────────────

describe('engine — modal owns the keyboard (R-5.6)', () => {
  it('suspends bare keys but keeps modifier chords global', () => {
    const bare = fredoRun('fredo.test.modalBare', { defaultSequence: 'g' });
    const chord = fredoRun(LAUNCHER_TOGGLE_ACTION_ID, { defaultSequence: 'primary+space' });
    installHotkeyEngine();

    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    const input = document.createElement('input');
    dialog.appendChild(input);
    document.body.appendChild(dialog);
    input.focus();

    expect(keydown(input, { key: 'g' }).prevented).toBe(false);
    expect(bare).not.toHaveBeenCalled();

    const { prevented } = keydown(input, { key: ' ', ctrlKey: true });
    expect(prevented).toBe(true);
    expect(chord).toHaveBeenCalledTimes(1);
    expect(document.body.getAttribute(BODY_FOCUS_CONTEXT_ATTR)).toBe('modal');
  });
});

// ── 4. IME / AltGraph (R-5.9) ────────────────────────────────────────────────

describe('engine — IME / AltGraph never match (R-5.9)', () => {
  it('isComposing and AltGraph produce no match and no preventDefault', () => {
    const run = fredoRun('fredo.test.ime', { defaultSequence: 'g' });
    installHotkeyEngine();
    const input = mountInput();

    const composing = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'g',
      isComposing: true,
    });
    input.dispatchEvent(composing);
    expect(run).not.toHaveBeenCalled();
    expect(composing.defaultPrevented).toBe(false);

    const altGraph = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'g' });
    Object.defineProperty(altGraph, 'getModifierState', {
      value: (key: string) => key === 'AltGraph',
    });
    input.dispatchEvent(altGraph);
    expect(run).not.toHaveBeenCalled();
    expect(altGraph.defaultPrevented).toBe(false);
  });
});

// ── 5. Pending-sequence state machine (R-3.1/R-3.3/R-3.4/R-3.5/R-3.6) ───────

describe('engine — pending-sequence state machine', () => {
  it('arms on the first stroke and executes EXACTLY ONCE on completion', () => {
    const run = fredoRun('fredo.test.gg', { defaultSequence: 'g g' });
    installHotkeyEngine();
    const el = mountNeutral();

    const first = keydown(el, { key: 'g' });
    expect(first.prevented).toBe(true); // consumed as a prefix
    expect(run).not.toHaveBeenCalled();
    expect(getPendingPrefix()).toBe('g');
    expect(document.body.getAttribute(BODY_PENDING_SEQUENCE_ATTR)).toBe('g');

    const second = keydown(el, { key: 'g' });
    expect(second.prevented).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(getPendingPrefix()).toBeNull();
    expect(document.body.hasAttribute(BODY_PENDING_SEQUENCE_ATTR)).toBe(false);
  });

  it('an invalid continuation performs no action and visibly resets', () => {
    const run = fredoRun('fredo.test.gg', { defaultSequence: 'g g' });
    installHotkeyEngine();
    const el = mountNeutral();

    keydown(el, { key: 'g' });
    const { prevented } = keydown(el, { key: 'x' });

    expect(run).not.toHaveBeenCalled();
    expect(prevented).toBe(true);
    expect(getPendingPrefix()).toBeNull();
    expect(document.body.hasAttribute(BODY_PENDING_SEQUENCE_ATTR)).toBe(false);
  });

  it('a timeout performs no action and resets after sequenceTimeoutMs', () => {
    vi.useFakeTimers();
    const run = fredoRun('fredo.test.gg', { defaultSequence: 'g g' });
    installHotkeyEngine();
    const el = mountNeutral();

    keydown(el, { key: 'g' });
    expect(document.body.getAttribute(BODY_PENDING_SEQUENCE_ATTR)).toBe('g');

    vi.advanceTimersByTime(createDefaultKeymap().sequenceTimeoutMs);

    expect(run).not.toHaveBeenCalled();
    expect(getPendingPrefix()).toBeNull();
    expect(document.body.hasAttribute(BODY_PENDING_SEQUENCE_ATTR)).toBe(false);
  });

  it('Escape cancels the pending sequence and is CONSUMED (not re-dispatched)', () => {
    const run = fredoRun('fredo.test.gg', { defaultSequence: 'g g' });
    const escapeRun = fredoRun('fredo.test.escape', { defaultSequence: 'escape' });
    installHotkeyEngine();
    const el = mountNeutral();

    keydown(el, { key: 'g' });
    const { prevented } = keydown(el, { key: 'Escape' });

    expect(prevented).toBe(true);
    expect(run).not.toHaveBeenCalled();
    expect(escapeRun).not.toHaveBeenCalled();
    expect(getPendingPrefix()).toBeNull();
  });

  it('publishes the next-key candidates while a sequence is pending (which-key data)', () => {
    fredoRun('fredo.test.gg', { defaultSequence: 'g g' });
    fredoRun('fredo.test.gh', { defaultSequence: 'g h' });
    installHotkeyEngine();
    const el = mountNeutral();

    keydown(el, { key: 'g' });

    // The store carries the prefix + candidates the overlay (ST-5) consumes.
    const candidates = getHotkeyCandidates();
    expect(candidates.map((c) => c.strokeToken).sort()).toEqual(['g', 'h']);
  });
});

// ── 6. Leader arming honours the native consumer (R-3.10) ────────────────────

describe('engine — leader arming + native consumers (R-3.10/R-5.5)', () => {
  it('does not arm a leader when the focused control natively consumes the key', async () => {
    const run = fredoRun('fredo.test.leader', { defaultSequence: '@leader g' });
    installHotkeyEngine();
    await setLeader('space');
    const button = mountButton();

    const { prevented } = keydown(button, { key: ' ' });

    expect(prevented).toBe(false); // native consumer wins → passthrough
    expect(run).not.toHaveBeenCalled();
    expect(document.body.hasAttribute(BODY_PENDING_SEQUENCE_ATTR)).toBe(false);
    expect(getPendingPrefix()).toBeNull();
  });

  it('arms the leader on a non-consumer surface and completes', async () => {
    const run = fredoRun('fredo.test.leader', { defaultSequence: '@leader g' });
    installHotkeyEngine();
    await setLeader('space');
    const el = mountNeutral();

    keydown(el, { key: ' ' });
    expect(getPendingPrefix()).toBe('@leader');

    keydown(el, { key: 'g' });
    expect(run).toHaveBeenCalledTimes(1);
  });
});

// ── 7. Feature-tier scoping (R-2.5/R-2.6) ────────────────────────────────────

describe('engine — feature-tier scoping (R-2.5/R-2.6)', () => {
  it('runs a feature action only while its owning feature is focused', () => {
    const run = vi.fn();
    registerFeatureHotkeys('demo', [
      { actionId: 'demo.focus', title: 'Demo focus', defaultSequence: 'x', run },
    ]);
    installHotkeyEngine();
    const el = mountNeutral();

    keydown(el, { key: 'x' });
    expect(run).not.toHaveBeenCalled();

    openTestWindow('demo');
    keydown(el, { key: 'x' });
    expect(run).toHaveBeenCalledTimes(1);

    openTestWindow('other');
    keydown(el, { key: 'x' });
    expect(run).toHaveBeenCalledTimes(1);
  });
});

// ── 8. Terminal passthrough + DOM hooks (R-5.7) ──────────────────────────────

describe('engine — terminal passthrough (R-5.7) + DOM hooks', () => {
  it('passes every key to the terminal except the exit chord', () => {
    const exitRun = fredoRun('fredo.terminal.exitPassthrough', {
      defaultSequence: 'ctrl+shift+f10',
    });
    installHotkeyEngine();
    const inner = mountTerminal();

    expect(keydown(inner, { key: 'a' }).prevented).toBe(false);
    expect(document.body.getAttribute(BODY_PASSTHROUGH_ATTR)).toBe('true');

    const { prevented } = keydown(inner, { key: 'F10', ctrlKey: true, shiftKey: true });
    expect(prevented).toBe(true);
    expect(exitRun).toHaveBeenCalledTimes(1);
  });

  it('mirrors the live focus context on document.body', () => {
    installHotkeyEngine();
    expect(document.body.getAttribute(BODY_FOCUS_CONTEXT_ATTR)).toBe('default');

    mountInput();
    expect(document.body.getAttribute(BODY_FOCUS_CONTEXT_ATTR)).toBe('text-entry');
    expect(document.body.hasAttribute(BODY_PASSTHROUGH_ATTR)).toBe(false);

    mountTerminal();
    expect(document.body.getAttribute(BODY_FOCUS_CONTEXT_ATTR)).toBe('terminal');
    expect(document.body.getAttribute(BODY_PASSTHROUGH_ATTR)).toBe('true');

    // Returning focus to a neutral surface lifts passthrough.
    mountNeutral();
    expect(document.body.getAttribute(BODY_FOCUS_CONTEXT_ATTR)).toBe('default');
    expect(document.body.hasAttribute(BODY_PASSTHROUGH_ATTR)).toBe(false);
  });

  it('exposes the macro-recording hook (recording itself is ST-8)', () => {
    installHotkeyEngine();
    expect(document.body.hasAttribute(BODY_MACRO_RECORDING_ATTR)).toBe(false);

    setMacroRecording(true, 'macro-1', 1);
    expect(document.body.getAttribute(BODY_MACRO_RECORDING_ATTR)).toBe('true');

    setMacroRecording(false);
    expect(document.body.hasAttribute(BODY_MACRO_RECORDING_ATTR)).toBe(false);
  });
});

// ── 9. Minimal window traversal (ST-10 completes it) ─────────────────────────

describe('engine — minimal window traversal registration', () => {
  it('Ctrl+Tab / Ctrl+Shift+Tab / Ctrl+2 move the focused window', () => {
    installHotkeyEngine();
    const el = mountNeutral();
    openTestWindow('a');
    openTestWindow('b'); // 'b' focused

    keydown(el, { key: 'Tab', ctrlKey: true });
    expect(getWindowSnapshot().find((w) => w.focused)?.id).toBe('a');

    keydown(el, { key: 'Tab', ctrlKey: true, shiftKey: true });
    expect(getWindowSnapshot().find((w) => w.focused)?.id).toBe('b');

    keydown(el, { key: '2', ctrlKey: true });
    expect(getWindowSnapshot().find((w) => w.focused)?.id).toBe('b');
  });
});
