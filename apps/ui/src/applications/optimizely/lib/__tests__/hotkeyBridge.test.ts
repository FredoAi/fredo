/**
 * Spec #2961 ST-2 — Feature Flags (Optimizely) feature hotkeys (AC1/AC2/AC5).
 *
 * Pins three things:
 *   1. the declarative contribution — the real feature instance declares its
 *      four local actions with the documented ids/sequences/titles, and each
 *      `run` dispatches the matching namespaced bridge event (so the panel maps
 *      the right op);
 *   2. the `collapseAll` availability gate is MODULE-scoped in the bridge
 *      (survives mount/unmount — never a React ref) and defaults to available;
 *   3. focus scoping + typing suppression for the new bare keys.
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
import { optimizelyFeature } from '../../OptimizelyFeature';
import {
  isOptimizelyActionAvailable,
  OPTIMIZELY_COLLAPSE_ALL_ACTION_ID,
  OPTIMIZELY_EXPAND_ALL_ACTION_ID,
  OPTIMIZELY_FOCUS_SEARCH_ACTION_ID,
  OPTIMIZELY_HOTKEY_EVENT,
  OPTIMIZELY_REFRESH_ACTION_ID,
  resetOptimizelyActionAvailabilityForTests,
  setOptimizelyActionAvailable,
  subscribeOptimizelyActions,
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

function collapseAllDeclaration() {
  return optimizelyFeature.hotkeys.find(
    (action) => action.actionId === OPTIMIZELY_COLLAPSE_ALL_ACTION_ID,
  );
}

beforeEach(() => {
  localStorage.clear();
  resetRegistryForTests();
  resetKeymapStoreForTests();
  resetWindowStoreForTests();
  resetHotkeyEngineForTests();
  resetOptimizelyActionAvailabilityForTests();
  document.body.innerHTML = '';
});

afterEach(() => {
  resetHotkeyEngineForTests();
  resetOptimizelyActionAvailabilityForTests();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('Feature Flags — declarative contribution', () => {
  it('declares the four local actions with their documented id + default sequence', () => {
    const byId = new Map(optimizelyFeature.hotkeys.map((action) => [action.actionId, action]));

    expect(byId.get(OPTIMIZELY_REFRESH_ACTION_ID)?.defaultSequence).toBe('r');
    expect(byId.get(OPTIMIZELY_FOCUS_SEARCH_ACTION_ID)?.defaultSequence).toBe('s');
    expect(byId.get(OPTIMIZELY_EXPAND_ALL_ACTION_ID)?.defaultSequence).toBe('e');
    expect(byId.get(OPTIMIZELY_COLLAPSE_ALL_ACTION_ID)?.defaultSequence).toBe('c');
    expect(optimizelyFeature.hotkeys).toHaveLength(4);
  });

  it('declares the documented titles', () => {
    const byId = new Map(optimizelyFeature.hotkeys.map((action) => [action.actionId, action]));

    expect(byId.get(OPTIMIZELY_REFRESH_ACTION_ID)?.title).toBe('Refresh flags');
    expect(byId.get(OPTIMIZELY_FOCUS_SEARCH_ACTION_ID)?.title).toBe('Focus flag search');
    expect(byId.get(OPTIMIZELY_EXPAND_ALL_ACTION_ID)?.title).toBe('Expand all flags');
    expect(byId.get(OPTIMIZELY_COLLAPSE_ALL_ACTION_ID)?.title).toBe('Collapse all flags');
  });

  it('gates only collapseAll with the declared reason (AC5)', () => {
    expect(collapseAllDeclaration()?.enabled).toBeTypeOf('function');
    expect(collapseAllDeclaration()?.unavailableReason).toBe('Nothing is expanded');

    // The always-on actions carry no gate.
    for (const actionId of [
      OPTIMIZELY_REFRESH_ACTION_ID,
      OPTIMIZELY_FOCUS_SEARCH_ACTION_ID,
      OPTIMIZELY_EXPAND_ALL_ACTION_ID,
    ]) {
      const action = optimizelyFeature.hotkeys.find((a) => a.actionId === actionId);
      expect(action?.enabled, `${actionId} must be always available`).toBeUndefined();
    }
  });

  it('dispatches the matching bridge event from each declared run', async () => {
    const seen: string[] = [];
    const unsubscribe = subscribeOptimizelyActions((actionId) => seen.push(actionId));

    for (const action of optimizelyFeature.hotkeys) {
      await action.run({} as never);
    }

    expect(seen).toEqual([
      OPTIMIZELY_REFRESH_ACTION_ID,
      OPTIMIZELY_FOCUS_SEARCH_ACTION_ID,
      OPTIMIZELY_EXPAND_ALL_ACTION_ID,
      OPTIMIZELY_COLLAPSE_ALL_ACTION_ID,
    ]);
    unsubscribe();
  });

  it('unsubscribes without removing another subscriber', () => {
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = subscribeOptimizelyActions(a);
    const unsubB = subscribeOptimizelyActions(b);

    unsubA();
    window.dispatchEvent(
      new CustomEvent(OPTIMIZELY_HOTKEY_EVENT, { detail: { actionId: OPTIMIZELY_EXPAND_ALL_ACTION_ID } }),
    );

    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledWith(OPTIMIZELY_EXPAND_ALL_ACTION_ID);
    unsubB();
  });
});

describe('Feature Flags — collapseAll availability (AC5, module-scoped)', () => {
  it('defaults to available', () => {
    expect(isOptimizelyActionAvailable(OPTIMIZELY_COLLAPSE_ALL_ACTION_ID)).toBe(true);
    expect(collapseAllDeclaration()?.enabled?.()).toBe(true);
  });

  it('reflects the published gate in the class enabled() probe', () => {
    setOptimizelyActionAvailable(OPTIMIZELY_COLLAPSE_ALL_ACTION_ID, false);
    expect(isOptimizelyActionAvailable(OPTIMIZELY_COLLAPSE_ALL_ACTION_ID)).toBe(false);
    expect(collapseAllDeclaration()?.enabled?.()).toBe(false);

    setOptimizelyActionAvailable(OPTIMIZELY_COLLAPSE_ALL_ACTION_ID, true);
    expect(collapseAllDeclaration()?.enabled?.()).toBe(true);
  });

  it('is module-scoped — state survives with no component mounted', () => {
    // No React lifecycle in this test: the gate is published and read purely
    // through module state (never a component ref), so it persists.
    setOptimizelyActionAvailable(OPTIMIZELY_COLLAPSE_ALL_ACTION_ID, false);
    const firstRead = isOptimizelyActionAvailable(OPTIMIZELY_COLLAPSE_ALL_ACTION_ID);
    const secondRead = isOptimizelyActionAvailable(OPTIMIZELY_COLLAPSE_ALL_ACTION_ID);
    expect(firstRead).toBe(false);
    expect(secondRead).toBe(false);
  });
});

describe('Feature Flags — focus-scoped dispatch (R-1.2/R-2.1)', () => {
  it('runs r / s / e / c only while the optimizely window is focused', () => {
    registerFeatureHotkeys('optimizely', optimizelyFeature.hotkeys);
    installHotkeyEngine();
    const el = mountNeutral();

    const seen: string[] = [];
    const unsubscribe = subscribeOptimizelyActions((actionId) => seen.push(actionId));

    // No optimizely window focused → the feature actions are not resolved.
    keydown(el, { key: 'r' });
    keydown(el, { key: 's' });
    keydown(el, { key: 'e' });
    keydown(el, { key: 'c' });
    expect(seen).toEqual([]);

    openTestWindow('optimizely');
    expect(getWindowSnapshot().find((w) => w.focused)?.id).toBe('optimizely');

    keydown(el, { key: 'r' });
    keydown(el, { key: 's' });
    keydown(el, { key: 'e' });
    // `c` is gated off until the panel publishes an expanded row (module default
    // here is true, so the engine still resolves it).
    keydown(el, { key: 'c' });
    expect(seen).toEqual([
      OPTIMIZELY_REFRESH_ACTION_ID,
      OPTIMIZELY_FOCUS_SEARCH_ACTION_ID,
      OPTIMIZELY_EXPAND_ALL_ACTION_ID,
      OPTIMIZELY_COLLAPSE_ALL_ACTION_ID,
    ]);

    // Another window focused → inert again.
    openTestWindow('settings');
    keydown(el, { key: 'r' });
    expect(seen).toHaveLength(4);

    unsubscribe();
  });

  it('does not fire a feature action while typing in a text field', () => {
    registerFeatureHotkeys('optimizely', optimizelyFeature.hotkeys);
    installHotkeyEngine();
    openTestWindow('optimizely');

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    const seen: string[] = [];
    const unsubscribe = subscribeOptimizelyActions((actionId) => seen.push(actionId));

    keydown(input, { key: 'r' });
    keydown(input, { key: 's' });
    keydown(input, { key: 'e' });
    keydown(input, { key: 'c' });
    expect(seen).toEqual([]);

    unsubscribe();
  });
});
