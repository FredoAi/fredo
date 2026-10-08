/**
 * Spec #2946 ST-15 — Infrastructure Diagram feature hotkeys (AC2 H-4/H-5/H-6).
 *
 * Pins the declarative contribution, the bridge dispatch, and focus scoping for
 * the diagram's declared `s` (search) / `f` (fit view) local actions.
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
import { diagramFeature } from '../../DiagramFeature';
import {
  DIAGRAM_FIT_VIEW_ACTION_ID,
  DIAGRAM_HOTKEY_EVENT,
  DIAGRAM_SEARCH_ACTION_ID,
  subscribeDiagramActions,
} from '../hotkeyBridge';

function keydown(target: EventTarget, init: KeyboardEventInit): { prevented: boolean } {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  const notCancelled = target.dispatchEvent(event);
  return { prevented: !notCancelled };
}

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

describe('Diagram — declarative contribution', () => {
  it('declares search (s) and fit view (f) on the real feature instance', () => {
    const byId = new Map(diagramFeature.hotkeys.map((action) => [action.actionId, action]));

    expect(byId.get(DIAGRAM_SEARCH_ACTION_ID)?.defaultSequence).toBe('s');
    expect(byId.get(DIAGRAM_FIT_VIEW_ACTION_ID)?.defaultSequence).toBe('f');
    expect(diagramFeature.hotkeys).toHaveLength(2);
  });

  it('dispatches the matching bridge event from each declared run', async () => {
    const seen: string[] = [];
    const unsubscribe = subscribeDiagramActions((actionId) => seen.push(actionId));

    for (const action of diagramFeature.hotkeys) {
      await action.run({} as never);
    }

    expect(seen).toEqual([DIAGRAM_SEARCH_ACTION_ID, DIAGRAM_FIT_VIEW_ACTION_ID]);
    expect(window).toBeDefined();
    unsubscribe();
  });
});

describe('Diagram — focus-scoped dispatch (R-2.5)', () => {
  it('runs s / f only while the diagram window is focused', () => {
    registerFeatureHotkeys('diagram', diagramFeature.hotkeys);
    installHotkeyEngine();
    const el = mountNeutral();

    const seen: string[] = [];
    const unsubscribe = subscribeDiagramActions((actionId) => seen.push(actionId));

    keydown(el, { key: 's' });
    keydown(el, { key: 'f' });
    expect(seen).toEqual([]);

    openTestWindow('diagram');
    expect(getWindowSnapshot().find((w) => w.focused)?.id).toBe('diagram');

    keydown(el, { key: 's' });
    keydown(el, { key: 'f' });
    expect(seen).toEqual([DIAGRAM_SEARCH_ACTION_ID, DIAGRAM_FIT_VIEW_ACTION_ID]);

    openTestWindow('mission-monitor');
    keydown(el, { key: 's' });
    expect(seen).toHaveLength(2);

    unsubscribe();
  });
});
