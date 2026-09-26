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
import { resetHotkeyAnnouncer } from '../announcer';
import {
  getHotkeyContext,
  registerFeatureHotkeyContexts,
  registerHotkeyContext,
  resetContextRegistryForTests,
} from '../contexts';
import {
  BODY_HOTKEY_CONTEXT_ATTR,
  enterHotkeyContext,
  getActiveHotkeyContext,
  resetHotkeyContextForTests,
} from '../contextStack';
import {
  REFERENCE_CONTEXT_ID,
  REFERENCE_ONLY_ACTION_ID,
} from '../defaults';
import {
  resetRegistryForTests,
  registerFeatureHotkeys,
  registerFredoAction,
  registerHotkeyHandler,
} from '../registry';
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
  handleHotkeyKeydown,
  installHotkeyEngine,
  resetHotkeyEngineForTests,
  isHotkeyEngineInstalled,
} from '../engine';
import { ROOT_CONTEXT_ID, type DispatchDecision, type FeatureHotkeyAction } from '../types';

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

/** Run the ONE decision directly and expose both the outcome and the event. */
function dispatch(init: KeyboardEventInit): { decision: DispatchDecision; prevented: boolean } {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  const decision = handleHotkeyKeydown(event);
  return { decision, prevented: event.defaultPrevented };
}

/** Register a Fredo-tier action that can carry a context scope / descent target. */
function fredoContextAction(
  actionId: string,
  options: {
    readonly defaultSequence?: string | null;
    readonly contextId?: string;
    readonly opensContextId?: string;
    readonly run?: ReturnType<typeof vi.fn>;
  } = {},
): ReturnType<typeof vi.fn> {
  const run = options.run ?? vi.fn();
  const action: FeatureHotkeyAction = {
    actionId,
    title: `Action ${actionId}`,
    defaultSequence: options.defaultSequence ?? null,
    contextId: options.contextId,
    opensContextId: options.opensContextId,
    run,
  };
  registerFredoAction(action);
  return run;
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
  resetContextRegistryForTests();
  resetKeymapStoreForTests();
  resetWindowStoreForTests();
  resetHotkeyAnnouncer();
  resetHotkeyContextForTests();
  resetHotkeyEngineForTests();
  document.body.innerHTML = '';
  document.body.removeAttribute(BODY_FOCUS_CONTEXT_ATTR);
  document.body.removeAttribute(BODY_PENDING_SEQUENCE_ATTR);
  document.body.removeAttribute(BODY_PASSTHROUGH_ATTR);
  document.body.removeAttribute(BODY_MACRO_RECORDING_ATTR);
  document.body.removeAttribute(BODY_HOTKEY_CONTEXT_ATTR);
});

afterEach(() => {
  resetHotkeyEngineForTests();
  resetHotkeyContextForTests();
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

// ── 10. Shipped non-leader g g sequence (ST-16) ──────────────────────────────

describe('engine — shipped g g non-leader sequence (ST-16)', () => {
  it('g then g focuses the FIRST open window exactly once (real shipped action)', () => {
    installHotkeyEngine();
    const el = mountNeutral();
    openTestWindow('a');
    openTestWindow('b'); // 'b' focused
    expect(getWindowSnapshot().find((w) => w.focused)?.id).toBe('b');

    const first = keydown(el, { key: 'g' });
    expect(first.prevented).toBe(true); // consumed as a prefix
    expect(getPendingPrefix()).toBe('g');
    expect(document.body.getAttribute(BODY_PENDING_SEQUENCE_ATTR)).toBe('g');

    const second = keydown(el, { key: 'g' });
    expect(second.prevented).toBe(true);
    expect(getWindowSnapshot().find((w) => w.focused)?.id).toBe('a');
    expect(getPendingPrefix()).toBeNull();
    expect(document.body.hasAttribute(BODY_PENDING_SEQUENCE_ATTR)).toBe(false);
  });

  it('g then g runs the fredo.window.first binding EXACTLY once', () => {
    const run = vi.fn();
    installHotkeyEngine();
    registerHotkeyHandler('fredo.window.first', run);
    const el = mountNeutral();

    keydown(el, { key: 'g' });
    expect(run).not.toHaveBeenCalled();
    keydown(el, { key: 'g' });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('g then an invalid continuation resets with no action', () => {
    const run = vi.fn();
    installHotkeyEngine();
    registerHotkeyHandler('fredo.window.first', run);
    const el = mountNeutral();

    keydown(el, { key: 'g' });
    const { prevented } = keydown(el, { key: 'x' });

    expect(prevented).toBe(true);
    expect(run).not.toHaveBeenCalled();
    expect(getPendingPrefix()).toBeNull();
    expect(document.body.hasAttribute(BODY_PENDING_SEQUENCE_ATTR)).toBe(false);
  });

  it('g stays suppressed in text-entry (never arms a sequence)', () => {
    const run = vi.fn();
    installHotkeyEngine();
    registerHotkeyHandler('fredo.window.first', run);
    const input = mountInput();

    expect(keydown(input, { key: 'g' }).prevented).toBe(false);
    expect(getPendingPrefix()).toBeNull();
    expect(document.body.hasAttribute(BODY_PENDING_SEQUENCE_ATTR)).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('g does not arm on a native consumer (focused button)', () => {
    const run = vi.fn();
    installHotkeyEngine();
    registerHotkeyHandler('fredo.window.first', run);
    const button = mountButton();

    expect(keydown(button, { key: 'g' }).prevented).toBe(false);
    expect(getPendingPrefix()).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });
});

// ── 11. Interaction-context wiring (Spec #2958) ──────────────────────────────

describe('engine — interaction-context wiring (Spec #2958)', () => {
  it('R-2.1: a matched action with opensContextId enters the context AND runs its own behaviour', () => {
    registerHotkeyContext({
      contextId: 'fredo.test.deep',
      parentId: ROOT_CONTEXT_ID,
      title: 'Deep',
    });
    const run = fredoContextAction('fredo.test.descend', {
      defaultSequence: 'primary+J',
      opensContextId: 'fredo.test.deep',
    });
    installHotkeyEngine();
    const el = mountNeutral();

    const { prevented } = keydown(el, { key: 'J', ctrlKey: true, shiftKey: true });

    expect(prevented).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(getActiveHotkeyContext()).toBe('fredo.test.deep');
    expect(document.body.getAttribute(BODY_HOTKEY_CONTEXT_ATTR)).toBe('fredo.test.deep');
  });

  it('R-2.3: an undeclared descent target changes nothing and no named-context action runs', () => {
    const run = fredoContextAction('fredo.test.descendMiss', {
      defaultSequence: 'primary+U',
      opensContextId: 'nope.missing',
    });
    installHotkeyEngine();
    const el = mountNeutral();

    const { prevented } = keydown(el, { key: 'U', ctrlKey: true, shiftKey: true });

    // The action's OWN behaviour runs; the named context never becomes active.
    expect(prevented).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(getActiveHotkeyContext()).toBe(ROOT_CONTEXT_ID);
    expect(document.body.hasAttribute(BODY_HOTKEY_CONTEXT_ATTR)).toBe(false);
  });

  it('R-1.1: the DEEPEST binding on the path wins for a reused key', () => {
    registerFeatureHotkeyContexts('demo', [
      { contextId: 'demo.canvas', parentId: 'demo', title: 'Canvas' },
    ]);
    const baseRun = vi.fn();
    const deepRun = vi.fn();
    registerFeatureHotkeys('demo', [
      { actionId: 'demo.base', title: 'Base z', defaultSequence: 'z', run: baseRun },
      {
        actionId: 'demo.deep',
        title: 'Deep z',
        defaultSequence: 'z',
        contextId: 'demo.canvas',
        run: deepRun,
      },
    ]);
    installHotkeyEngine();
    const el = mountNeutral();
    openTestWindow('demo');

    keydown(el, { key: 'z' });
    expect(baseRun).toHaveBeenCalledTimes(1);
    expect(deepRun).not.toHaveBeenCalled();

    expect(enterHotkeyContext('demo.canvas')).toBe(true);
    keydown(el, { key: 'z' });
    expect(deepRun).toHaveBeenCalledTimes(1);
    expect(baseRun).toHaveBeenCalledTimes(1);
  });

  it('R-1.3: a Fredo-tier binding wins over a feature-tier binding for the same key', () => {
    const fredoRun = vi.fn();
    const featureRun = vi.fn();
    fredoContextAction('fredo.test.z', { defaultSequence: 'z', run: fredoRun });
    registerFeatureHotkeys('demo', [
      { actionId: 'demo.z', title: 'Demo z', defaultSequence: 'z', run: featureRun },
    ]);
    installHotkeyEngine();
    const el = mountNeutral();
    openTestWindow('demo');

    keydown(el, { key: 'z' });

    expect(fredoRun).toHaveBeenCalledTimes(1);
    expect(featureRun).not.toHaveBeenCalled();
  });

  it('R-3.1/R-6.1: each Escape pops ONE explicit descent; at the base it is left native', () => {
    registerHotkeyContext({ contextId: 'fredo.test.a', parentId: ROOT_CONTEXT_ID, title: 'A' });
    registerHotkeyContext({ contextId: 'fredo.test.b', parentId: 'fredo.test.a', title: 'B' });
    installHotkeyEngine();
    mountNeutral();

    expect(enterHotkeyContext('fredo.test.a')).toBe(true);
    expect(enterHotkeyContext('fredo.test.b')).toBe(true);
    expect(getActiveHotkeyContext()).toBe('fredo.test.b');

    const first = dispatch({ key: 'Escape' });
    expect(first.decision.outcome).toBe('context-back');
    expect(first.prevented).toBe(true);
    expect(getActiveHotkeyContext()).toBe('fredo.test.a');

    const second = dispatch({ key: 'Escape' });
    expect(second.decision.outcome).toBe('context-back');
    expect(second.prevented).toBe(true);
    expect(getActiveHotkeyContext()).toBe(ROOT_CONTEXT_ID);

    // At the base the context model must not consume Escape (R-3.2).
    const third = dispatch({ key: 'Escape' });
    expect(third.decision.outcome).toBe('passthrough');
    expect(third.decision.reason).toBe('unbound');
    expect(third.decision.consumed).toBe(false);
    expect(third.prevented).toBe(false);
    expect(getActiveHotkeyContext()).toBe(ROOT_CONTEXT_ID);
  });

  it('ships a reachable LIVE reference host: primary+K descends, y resolves only there', () => {
    installHotkeyEngine(); // registers the reference context + its two actions
    expect(getHotkeyContext(REFERENCE_CONTEXT_ID)?.title).toBe('Reference');

    const yRun = vi.fn();
    registerHotkeyHandler(REFERENCE_ONLY_ACTION_ID, yRun);
    const el = mountNeutral();

    // At the base context the deeper-only `y` is NOT in force.
    const atBase = dispatch({ key: 'y' });
    expect(atBase.decision.outcome).toBe('passthrough');
    expect(yRun).not.toHaveBeenCalled();

    // Ctrl+Shift+K folds Shift into 'K' → the shipped `primary+K` descend chord.
    const descend = keydown(el, { key: 'K', ctrlKey: true, shiftKey: true });
    expect(descend.prevented).toBe(true);
    expect(getActiveHotkeyContext()).toBe(REFERENCE_CONTEXT_ID);

    const inReference = dispatch({ key: 'y' });
    expect(inReference.decision.outcome).toBe('match');
    expect(inReference.decision.action?.actionId).toBe(REFERENCE_ONLY_ACTION_ID);
    expect(yRun).toHaveBeenCalledTimes(1);
  });
});

// ── 12. Pre-existing Escape owners remain live (G-220) ───────────────────────

describe('engine — pre-existing Escape owners remain live (G-220)', () => {
  function descendInto(id: string): void {
    registerHotkeyContext({ contextId: id, parentId: ROOT_CONTEXT_ID, title: id });
    installHotkeyEngine();
    mountNeutral();
    expect(enterHotkeyContext(id)).toBe(true);
  }

  it('F-A: pending Escape cancel clears the sequence and does NOT unwind a descent', () => {
    descendInto('fredo.test.deep');
    const el = mountNeutral();

    keydown(el, { key: 'g' });
    expect(getPendingPrefix()).toBe('g');

    const { prevented } = keydown(el, { key: 'Escape' });
    expect(prevented).toBe(true);
    expect(getPendingPrefix()).toBeNull();
    expect(document.body.hasAttribute(BODY_PENDING_SEQUENCE_ATTR)).toBe(false);
    expect(getActiveHotkeyContext()).toBe('fredo.test.deep');
  });

  it('F-B: at the base context Escape is not consumed by the context model', () => {
    installHotkeyEngine();
    mountNeutral();

    const { decision, prevented } = dispatch({ key: 'Escape' });
    expect(decision.outcome).toBe('passthrough');
    expect(decision.reason).toBe('unbound');
    expect(decision.consumed).toBe(false);
    expect(prevented).toBe(false);
    expect(document.body.hasAttribute(BODY_HOTKEY_CONTEXT_ATTR)).toBe(false);
  });

  it('F-C: a focused <button> natively consumes a bare key (Space)', () => {
    const spaceRun = fredoContextAction('fredo.test.space', { defaultSequence: 'space' });
    installHotkeyEngine();
    mountButton();

    const { decision, prevented } = dispatch({ key: ' ' });
    expect(decision.outcome).toBe('passthrough');
    expect(decision.reason).toBe('native-consumes');
    expect(decision.consumed).toBe(false);
    expect(prevented).toBe(false);
    expect(spaceRun).not.toHaveBeenCalled();
  });

  it('F-D: an open modal owns Escape (no context unwind)', () => {
    descendInto('fredo.test.deep');

    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    const input = document.createElement('input');
    dialog.appendChild(input);
    document.body.appendChild(dialog);
    input.focus();

    const { decision, prevented } = dispatch({ key: 'Escape' });
    expect(decision.outcome).toBe('passthrough');
    expect(decision.reason).toBe('modal-escape');
    expect(prevented).toBe(false);
    expect(getActiveHotkeyContext()).toBe('fredo.test.deep');
  });

  it('F-E: terminal passthrough owns Escape (no context unwind)', () => {
    descendInto('fredo.test.deep');
    mountTerminal();

    const { decision, prevented } = dispatch({ key: 'Escape' });
    expect(decision.outcome).toBe('passthrough');
    expect(decision.reason).toBe('terminal-passthrough');
    expect(prevented).toBe(false);
    expect(getActiveHotkeyContext()).toBe('fredo.test.deep');
  });
});
