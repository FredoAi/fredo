/**
 * Spec #2946 ST-15 — Mission Monitor feature hotkeys (AC2 H-4/H-5/H-6).
 *
 * Pins two things:
 *   1. the declarative contribution — the real feature instance declares its
 *      local actions with the documented ids/sequences, and each `run` dispatches
 *      the matching namespaced bridge event (so the panel maps the right op);
 *   2. focus scoping — the engine only dispatches those actions while the
 *      `mission-monitor` window is the focused one, and they are inert otherwise.
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
import { missionMonitorFeature } from '../../MissionMonitorFeature';
import {
  MISSION_MONITOR_FOCUS_SESSION_SEARCH,
  MISSION_MONITOR_HOTKEY_EVENT,
  MISSION_MONITOR_NEXT_SESSION,
  MISSION_MONITOR_PREVIOUS_SESSION,
  subscribeMissionMonitorActions,
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
});

afterEach(() => {
  resetHotkeyEngineForTests();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('Mission Monitor — declarative contribution', () => {
  it('declares the three local actions with their documented id + default sequence', () => {
    const byId = new Map(missionMonitorFeature.hotkeys.map((action) => [action.actionId, action]));

    expect(byId.get(MISSION_MONITOR_FOCUS_SESSION_SEARCH)?.defaultSequence).toBe('s');
    expect(byId.get(MISSION_MONITOR_NEXT_SESSION)?.defaultSequence).toBe('n');
    expect(byId.get(MISSION_MONITOR_PREVIOUS_SESSION)?.defaultSequence).toBe('p');
    expect(missionMonitorFeature.hotkeys).toHaveLength(3);
  });

  it('dispatches the matching bridge event from each declared run', async () => {
    const seen: string[] = [];
    const unsubscribe = subscribeMissionMonitorActions((actionId) => seen.push(actionId));

    for (const action of missionMonitorFeature.hotkeys) {
      await action.run({} as never);
    }

    expect(seen).toEqual([
      MISSION_MONITOR_FOCUS_SESSION_SEARCH,
      MISSION_MONITOR_NEXT_SESSION,
      MISSION_MONITOR_PREVIOUS_SESSION,
    ]);
    unsubscribe();
  });

  it('unsubscribes without removing another subscriber', () => {
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = subscribeMissionMonitorActions(a);
    const unsubB = subscribeMissionMonitorActions(b);

    unsubA();
    window.dispatchEvent(new CustomEvent(MISSION_MONITOR_HOTKEY_EVENT, { detail: { actionId: MISSION_MONITOR_NEXT_SESSION } }));

    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledWith(MISSION_MONITOR_NEXT_SESSION);
    unsubB();
  });
});

describe('Mission Monitor — focus-scoped dispatch (R-2.5)', () => {
  it('runs s / n / p only while the mission-monitor window is focused', () => {
    registerFeatureHotkeys('mission-monitor', missionMonitorFeature.hotkeys);
    installHotkeyEngine();
    const el = mountNeutral();

    const seen: string[] = [];
    const unsubscribe = subscribeMissionMonitorActions((actionId) => seen.push(actionId));

    // No mission-monitor window focused → the feature actions are not resolved.
    keydown(el, { key: 's' });
    keydown(el, { key: 'n' });
    keydown(el, { key: 'p' });
    expect(seen).toEqual([]);

    openTestWindow('mission-monitor');
    expect(getWindowSnapshot().find((w) => w.focused)?.id).toBe('mission-monitor');

    keydown(el, { key: 's' });
    keydown(el, { key: 'n' });
    keydown(el, { key: 'p' });
    expect(seen).toEqual([
      MISSION_MONITOR_FOCUS_SESSION_SEARCH,
      MISSION_MONITOR_NEXT_SESSION,
      MISSION_MONITOR_PREVIOUS_SESSION,
    ]);

    // Another window focused → inert again.
    openTestWindow('settings');
    keydown(el, { key: 's' });
    expect(seen).toHaveLength(3);

    unsubscribe();
  });

  it('does not fire a feature action while typing in a text field', () => {
    registerFeatureHotkeys('mission-monitor', missionMonitorFeature.hotkeys);
    installHotkeyEngine();
    openTestWindow('mission-monitor');

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    const seen: string[] = [];
    const unsubscribe = subscribeMissionMonitorActions((actionId) => seen.push(actionId));

    keydown(input, { key: 's' });
    keydown(input, { key: 'n' });
    expect(seen).toEqual([]);

    unsubscribe();
  });
});
