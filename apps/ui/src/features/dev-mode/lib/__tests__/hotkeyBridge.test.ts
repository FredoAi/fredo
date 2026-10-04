/**
 * Spec #2961 ST-3 — Dev Mode feature hotkeys (AC1/AC2/AC5).
 *
 * Pins three things:
 *   1. the declarative contribution — the real feature instance declares its
 *      four local actions with the documented ids/sequences/titles, and each
 *      `run` dispatches the matching namespaced bridge event;
 *   2. the availability gate — the two gated actions read the MODULE-SCOPED
 *      bridge availability and carry their static `unavailableReason` copy;
 *   3. focus scoping + typing suppression — the engine only dispatches those
 *      actions while the `dev-mode` window is focused, and never while typing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getWindowSnapshot,
  openWindow,
  resetWindowStoreForTests,
} from '../../../../shared/window-system/windowStore';
import { resetKeymapStoreForTests } from '../../../../shared/hotkeys/store';
import {
  registerFeatureHotkeys,
  resetRegistryForTests,
} from '../../../../shared/hotkeys/registry';
import {
  installHotkeyEngine,
  resetHotkeyEngineForTests,
} from '../../../../shared/hotkeys/engine';
import { devModeFeature } from '../../DevModeFeature';
import {
  DEV_MODE_CLEAR_EVENTS_ACTION_ID,
  DEV_MODE_FOCUS_FILTER_ACTION_ID,
  DEV_MODE_HOTKEY_EVENT,
  DEV_MODE_SHOW_ALL_STATES_ACTION_ID,
  DEV_MODE_TOGGLE_VIEW_ACTION_ID,
  dispatchDevModeAction,
  isDevModeActionAvailable,
  setDevModeActionAvailable,
  subscribeDevModeActions,
} from '../hotkeyBridge';

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
  // Availability is module-scoped and survives mount/unmount — reset the two
  // gates to their default (available) before each test.
  setDevModeActionAvailable(DEV_MODE_CLEAR_EVENTS_ACTION_ID, true);
  setDevModeActionAvailable(DEV_MODE_SHOW_ALL_STATES_ACTION_ID, true);
  document.body.innerHTML = '';
});

afterEach(() => {
  resetHotkeyEngineForTests();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('Dev Mode — declarative contribution', () => {
  it('declares the four local actions with their documented id + default sequence', () => {
    const byId = new Map(devModeFeature.hotkeys.map((action) => [action.actionId, action]));

    expect(byId.get(DEV_MODE_FOCUS_FILTER_ACTION_ID)?.defaultSequence).toBe('s');
    expect(byId.get(DEV_MODE_CLEAR_EVENTS_ACTION_ID)?.defaultSequence).toBe('c');
    expect(byId.get(DEV_MODE_SHOW_ALL_STATES_ACTION_ID)?.defaultSequence).toBe('a');
    expect(byId.get(DEV_MODE_TOGGLE_VIEW_ACTION_ID)?.defaultSequence).toBe('v');
    expect(devModeFeature.hotkeys).toHaveLength(4);
  });

  it('declares the exact titles from the Names Block', () => {
    const byId = new Map(devModeFeature.hotkeys.map((action) => [action.actionId, action]));

    expect(byId.get(DEV_MODE_FOCUS_FILTER_ACTION_ID)?.title).toBe('Focus event filter');
    expect(byId.get(DEV_MODE_CLEAR_EVENTS_ACTION_ID)?.title).toBe('Clear captured events');
    expect(byId.get(DEV_MODE_SHOW_ALL_STATES_ACTION_ID)?.title).toBe('Show all event states');
    expect(byId.get(DEV_MODE_TOGGLE_VIEW_ACTION_ID)?.title).toBe('Switch rows / feature data');
  });

  it('dispatches the matching bridge event from each declared run', async () => {
    const seen: string[] = [];
    const unsubscribe = subscribeDevModeActions((actionId) => seen.push(actionId));

    for (const action of devModeFeature.hotkeys) {
      await action.run({} as never);
    }

    expect(seen).toEqual([
      DEV_MODE_FOCUS_FILTER_ACTION_ID,
      DEV_MODE_CLEAR_EVENTS_ACTION_ID,
      DEV_MODE_SHOW_ALL_STATES_ACTION_ID,
      DEV_MODE_TOGGLE_VIEW_ACTION_ID,
    ]);
    unsubscribe();
  });

  it('is a safe no-op when no subscriber is mounted (R-5.4)', () => {
    expect(() => dispatchDevModeAction(DEV_MODE_TOGGLE_VIEW_ACTION_ID)).not.toThrow();
  });

  it('unsubscribes without removing another subscriber', () => {
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = subscribeDevModeActions(a);
    const unsubB = subscribeDevModeActions(b);

    unsubA();
    window.dispatchEvent(
      new CustomEvent(DEV_MODE_HOTKEY_EVENT, { detail: { actionId: DEV_MODE_CLEAR_EVENTS_ACTION_ID } }),
    );

    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledWith(DEV_MODE_CLEAR_EVENTS_ACTION_ID);
    unsubB();
  });
});

describe('Dev Mode — availability gate (AC5)', () => {
  it('gates clearEvents / showAllStates on the module-scoped availability', () => {
    const byId = new Map(devModeFeature.hotkeys.map((action) => [action.actionId, action]));
    const clear = byId.get(DEV_MODE_CLEAR_EVENTS_ACTION_ID);
    const allStates = byId.get(DEV_MODE_SHOW_ALL_STATES_ACTION_ID);

    expect(clear?.unavailableReason).toBe('No events to clear');
    expect(allStates?.unavailableReason).toBe('All states are already shown');

    // Default availability is `true`.
    expect(clear?.enabled?.()).toBe(true);
    expect(allStates?.enabled?.()).toBe(true);

    setDevModeActionAvailable(DEV_MODE_CLEAR_EVENTS_ACTION_ID, false);
    setDevModeActionAvailable(DEV_MODE_SHOW_ALL_STATES_ACTION_ID, false);

    expect(clear?.enabled?.()).toBe(false);
    expect(allStates?.enabled?.()).toBe(false);
    expect(isDevModeActionAvailable(DEV_MODE_CLEAR_EVENTS_ACTION_ID)).toBe(false);
  });

  it('leaves the always-available actions ungated', () => {
    const byId = new Map(devModeFeature.hotkeys.map((action) => [action.actionId, action]));

    expect(byId.get(DEV_MODE_FOCUS_FILTER_ACTION_ID)?.enabled).toBeUndefined();
    expect(byId.get(DEV_MODE_TOGGLE_VIEW_ACTION_ID)?.enabled).toBeUndefined();
    expect(byId.get(DEV_MODE_FOCUS_FILTER_ACTION_ID)?.unavailableReason).toBeUndefined();
  });
});

describe('Dev Mode — focus-scoped dispatch (R-2.5)', () => {
  it('runs s / c / a / v only while the dev-mode window is focused', () => {
    registerFeatureHotkeys('dev-mode', devModeFeature.hotkeys);
    installHotkeyEngine();
    const el = mountNeutral();

    const seen: string[] = [];
    const unsubscribe = subscribeDevModeActions((actionId) => seen.push(actionId));

    // No dev-mode window focused → the feature actions are not resolved.
    keydown(el, { key: 's' });
    keydown(el, { key: 'c' });
    keydown(el, { key: 'a' });
    keydown(el, { key: 'v' });
    expect(seen).toEqual([]);

    openTestWindow('dev-mode');
    expect(getWindowSnapshot().find((w) => w.focused)?.id).toBe('dev-mode');

    keydown(el, { key: 's' });
    keydown(el, { key: 'c' });
    keydown(el, { key: 'a' });
    keydown(el, { key: 'v' });
    expect(seen).toEqual([
      DEV_MODE_FOCUS_FILTER_ACTION_ID,
      DEV_MODE_CLEAR_EVENTS_ACTION_ID,
      DEV_MODE_SHOW_ALL_STATES_ACTION_ID,
      DEV_MODE_TOGGLE_VIEW_ACTION_ID,
    ]);

    // Another window focused → inert again.
    openTestWindow('settings');
    keydown(el, { key: 's' });
    expect(seen).toHaveLength(4);

    unsubscribe();
  });

  it('does not fire a feature action while typing in a text field (R-5.2)', () => {
    registerFeatureHotkeys('dev-mode', devModeFeature.hotkeys);
    installHotkeyEngine();
    openTestWindow('dev-mode');

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    const seen: string[] = [];
    const unsubscribe = subscribeDevModeActions((actionId) => seen.push(actionId));

    keydown(input, { key: 's' });
    keydown(input, { key: 'c' });
    keydown(input, { key: 'a' });
    expect(seen).toEqual([]);

    unsubscribe();
  });
});
