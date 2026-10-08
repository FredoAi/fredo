/**
 * Spec #2961 ST-1 (S4) — My Work Items feature hotkeys.
 *
 * Pins the declarative contribution (four base-context actions with the
 * documented ids/sequences), the bridge dispatch, module-scoped availability
 * (the `refresh` gate), focus scoping, typing suppression, and the
 * unmounted-safe no-op — mirroring the shipped Mission Monitor / Diagram
 * bridge tests.
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
import { myWorkItemsFeature } from '../../MyWorkItemsFeature';
import {
  dispatchMyWorkItemsAction,
  isMyWorkItemsActionAvailable,
  MY_WORKITEMS_HOTKEY_EVENT,
  MY_WORKITEMS_REFRESH_ACTION_ID,
  MY_WORKITEMS_SHOW_ALL_SOURCES_ACTION_ID,
  MY_WORKITEMS_SHOW_AZDO_ACTION_ID,
  MY_WORKITEMS_SHOW_JIRA_ACTION_ID,
  setMyWorkItemsActionAvailable,
  subscribeMyWorkItemsActions,
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
  document.body.innerHTML = '';
  // Module-scoped availability persists across tests — reset every action to
  // available so the file is deterministic in any suite order (G-222).
  setMyWorkItemsActionAvailable(MY_WORKITEMS_REFRESH_ACTION_ID, true);
  setMyWorkItemsActionAvailable(MY_WORKITEMS_SHOW_ALL_SOURCES_ACTION_ID, true);
  setMyWorkItemsActionAvailable(MY_WORKITEMS_SHOW_AZDO_ACTION_ID, true);
  setMyWorkItemsActionAvailable(MY_WORKITEMS_SHOW_JIRA_ACTION_ID, true);
});

afterEach(() => {
  resetHotkeyEngineForTests();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('My Work Items — declarative contribution', () => {
  it('declares the four base-context actions with their documented id + default sequence', () => {
    const byId = new Map(myWorkItemsFeature.hotkeys.map((action) => [action.actionId, action]));

    expect(myWorkItemsFeature.hotkeys).toHaveLength(4);
    expect(byId.get(MY_WORKITEMS_REFRESH_ACTION_ID)?.defaultSequence).toBe('r');
    expect(byId.get(MY_WORKITEMS_SHOW_ALL_SOURCES_ACTION_ID)?.defaultSequence).toBe('a');
    expect(byId.get(MY_WORKITEMS_SHOW_AZDO_ACTION_ID)?.defaultSequence).toBe('z');
    expect(byId.get(MY_WORKITEMS_SHOW_JIRA_ACTION_ID)?.defaultSequence).toBe('j');
  });

  it('titles the actions exactly as the binding Names Block specifies', () => {
    const byId = new Map(myWorkItemsFeature.hotkeys.map((action) => [action.actionId, action]));

    expect(byId.get(MY_WORKITEMS_REFRESH_ACTION_ID)?.title).toBe('Refresh work items');
    expect(byId.get(MY_WORKITEMS_SHOW_ALL_SOURCES_ACTION_ID)?.title).toBe('Show all sources');
    expect(byId.get(MY_WORKITEMS_SHOW_AZDO_ACTION_ID)?.title).toBe('Show Azure DevOps items');
    expect(byId.get(MY_WORKITEMS_SHOW_JIRA_ACTION_ID)?.title).toBe('Show Jira items');
  });

  it('dispatches the matching bridge event from each declared run', async () => {
    const seen: string[] = [];
    const unsubscribe = subscribeMyWorkItemsActions((actionId) => seen.push(actionId));

    for (const action of myWorkItemsFeature.hotkeys) {
      await action.run({} as never);
    }

    expect(seen).toEqual([
      MY_WORKITEMS_REFRESH_ACTION_ID,
      MY_WORKITEMS_SHOW_ALL_SOURCES_ACTION_ID,
      MY_WORKITEMS_SHOW_AZDO_ACTION_ID,
      MY_WORKITEMS_SHOW_JIRA_ACTION_ID,
    ]);
    unsubscribe();
  });

  it('unsubscribes without removing another subscriber', () => {
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = subscribeMyWorkItemsActions(a);
    const unsubB = subscribeMyWorkItemsActions(b);

    unsubA();
    window.dispatchEvent(
      new CustomEvent(MY_WORKITEMS_HOTKEY_EVENT, { detail: { actionId: MY_WORKITEMS_SHOW_AZDO_ACTION_ID } }),
    );

    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledWith(MY_WORKITEMS_SHOW_AZDO_ACTION_ID);
    unsubB();
  });

  it('ignores a malformed bridge event (no actionId)', () => {
    const handler = vi.fn();
    const unsubscribe = subscribeMyWorkItemsActions(handler);

    window.dispatchEvent(new CustomEvent(MY_WORKITEMS_HOTKEY_EVENT, { detail: {} }));
    window.dispatchEvent(new CustomEvent(MY_WORKITEMS_HOTKEY_EVENT));

    expect(handler).not.toHaveBeenCalled();
    unsubscribe();
  });
});

describe('My Work Items — availability (refresh gate)', () => {
  it('defaults to available and reflects the published module-scoped value', () => {
    expect(isMyWorkItemsActionAvailable(MY_WORKITEMS_REFRESH_ACTION_ID)).toBe(true);

    setMyWorkItemsActionAvailable(MY_WORKITEMS_REFRESH_ACTION_ID, false);
    expect(isMyWorkItemsActionAvailable(MY_WORKITEMS_REFRESH_ACTION_ID)).toBe(false);

    setMyWorkItemsActionAvailable(MY_WORKITEMS_REFRESH_ACTION_ID, true);
    expect(isMyWorkItemsActionAvailable(MY_WORKITEMS_REFRESH_ACTION_ID)).toBe(true);
  });

  it('gates refresh with enabled() and the declared reason while loading', () => {
    const refresh = myWorkItemsFeature.hotkeys.find(
      (action) => action.actionId === MY_WORKITEMS_REFRESH_ACTION_ID,
    );

    setMyWorkItemsActionAvailable(MY_WORKITEMS_REFRESH_ACTION_ID, false);
    expect(refresh?.enabled?.()).toBe(false);
    expect(refresh?.unavailableReason).toBe('Work items are still loading');

    setMyWorkItemsActionAvailable(MY_WORKITEMS_REFRESH_ACTION_ID, true);
    expect(refresh?.enabled?.()).toBe(true);
  });

  it('leaves the three source actions always available (no enabled gate)', () => {
    for (const id of [
      MY_WORKITEMS_SHOW_ALL_SOURCES_ACTION_ID,
      MY_WORKITEMS_SHOW_AZDO_ACTION_ID,
      MY_WORKITEMS_SHOW_JIRA_ACTION_ID,
    ]) {
      const action = myWorkItemsFeature.hotkeys.find((entry) => entry.actionId === id);
      expect(action?.enabled).toBeUndefined();
    }
  });
});

describe('My Work Items — focus-scoped dispatch (R-2.5)', () => {
  it('runs r / a / z / j only while the my-workitems window is focused', () => {
    registerFeatureHotkeys('my-workitems', myWorkItemsFeature.hotkeys);
    installHotkeyEngine();
    const el = mountNeutral();

    const seen: string[] = [];
    const unsubscribe = subscribeMyWorkItemsActions((actionId) => seen.push(actionId));

    // No my-workitems window focused → the feature actions are not resolved.
    keydown(el, { key: 'r' });
    keydown(el, { key: 'a' });
    keydown(el, { key: 'z' });
    keydown(el, { key: 'j' });
    expect(seen).toEqual([]);

    openTestWindow('my-workitems');
    expect(getWindowSnapshot().find((w) => w.focused)?.id).toBe('my-workitems');

    keydown(el, { key: 'r' });
    keydown(el, { key: 'a' });
    keydown(el, { key: 'z' });
    keydown(el, { key: 'j' });
    expect(seen).toEqual([
      MY_WORKITEMS_REFRESH_ACTION_ID,
      MY_WORKITEMS_SHOW_ALL_SOURCES_ACTION_ID,
      MY_WORKITEMS_SHOW_AZDO_ACTION_ID,
      MY_WORKITEMS_SHOW_JIRA_ACTION_ID,
    ]);

    // Another window focused → inert again.
    openTestWindow('settings');
    keydown(el, { key: 'r' });
    expect(seen).toHaveLength(4);

    unsubscribe();
  });

  it('does not fire a feature action while typing in a text field', () => {
    registerFeatureHotkeys('my-workitems', myWorkItemsFeature.hotkeys);
    installHotkeyEngine();
    openTestWindow('my-workitems');

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    const seen: string[] = [];
    const unsubscribe = subscribeMyWorkItemsActions((actionId) => seen.push(actionId));

    keydown(input, { key: 'r' });
    keydown(input, { key: 'a' });
    keydown(input, { key: 'z' });
    keydown(input, { key: 'j' });
    expect(seen).toEqual([]);

    unsubscribe();
  });
});

describe('My Work Items — unmounted-safe dispatch (R-5.4)', () => {
  it('is a safe no-op with no subscriber', () => {
    expect(() => dispatchMyWorkItemsAction(MY_WORKITEMS_REFRESH_ACTION_ID)).not.toThrow();
    expect(() => dispatchMyWorkItemsAction(MY_WORKITEMS_SHOW_JIRA_ACTION_ID)).not.toThrow();
  });
});
