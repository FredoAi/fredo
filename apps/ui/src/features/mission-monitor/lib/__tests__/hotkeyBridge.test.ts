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
import { registerFeature } from '../../../../features/featureRegistry';
import {
  getHotkeyContext,
  resetContextRegistryForTests,
  resolveContextBindings,
} from '../../../../shared/hotkeys/contexts';
import { listHotkeyActions } from '../../../../shared/hotkeys/registry';
import { missionMonitorFeature } from '../../MissionMonitorFeature';
import {
  MISSION_MONITOR_DETAIL_CONTEXT_ID,
  MISSION_MONITOR_FOCUS_SESSION_SEARCH,
  MISSION_MONITOR_GRAPH_CONTEXT_ID,
  MISSION_MONITOR_HOTKEY_EVENT,
  MISSION_MONITOR_NEXT_NODE,
  MISSION_MONITOR_NEXT_SECTION,
  MISSION_MONITOR_NEXT_SESSION,
  MISSION_MONITOR_OPEN_DETAIL,
  MISSION_MONITOR_OPEN_GRAPH,
  MISSION_MONITOR_PREVIOUS_NODE,
  MISSION_MONITOR_PREVIOUS_SECTION,
  MISSION_MONITOR_PREVIOUS_SESSION,
  MISSION_MONITOR_TOGGLE_SECTION,
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
  resetContextRegistryForTests();
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
  it('declares the three L1 actions with their documented id + default sequence', () => {
    const byId = new Map(missionMonitorFeature.hotkeys.map((action) => [action.actionId, action]));

    // Existing L1 contract (Spec #2946) — ids, titles and keys unchanged.
    expect(byId.get(MISSION_MONITOR_FOCUS_SESSION_SEARCH)?.defaultSequence).toBe('s');
    expect(byId.get(MISSION_MONITOR_FOCUS_SESSION_SEARCH)?.title).toBe('Focus session search');
    expect(byId.get(MISSION_MONITOR_NEXT_SESSION)?.defaultSequence).toBe('n');
    expect(byId.get(MISSION_MONITOR_NEXT_SESSION)?.title).toBe('Next session');
    expect(byId.get(MISSION_MONITOR_PREVIOUS_SESSION)?.defaultSequence).toBe('p');
    expect(byId.get(MISSION_MONITOR_PREVIOUS_SESSION)?.title).toBe('Previous session');
    // L1 actions carry no explicit contextId (base context `mission-monitor`).
    expect(byId.get(MISSION_MONITOR_FOCUS_SESSION_SEARCH)?.contextId).toBeUndefined();
    expect(byId.get(MISSION_MONITOR_NEXT_SESSION)?.contextId).toBeUndefined();
    expect(byId.get(MISSION_MONITOR_PREVIOUS_SESSION)?.contextId).toBeUndefined();
  });

  it('declares the L1→L2→L3 nested actions with intentional key reuse (Spec #2962)', () => {
    const byId = new Map(missionMonitorFeature.hotkeys.map((action) => [action.actionId, action]));

    // L1 descent: `o` at the base opens the graph context.
    expect(byId.get(MISSION_MONITOR_OPEN_GRAPH)?.defaultSequence).toBe('o');
    expect(byId.get(MISSION_MONITOR_OPEN_GRAPH)?.contextId).toBeUndefined();
    expect(byId.get(MISSION_MONITOR_OPEN_GRAPH)?.opensContextId).toBe(
      MISSION_MONITOR_GRAPH_CONTEXT_ID,
    );

    // L2: n / p / o reused inside the graph context.
    expect(byId.get(MISSION_MONITOR_NEXT_NODE)?.defaultSequence).toBe('n');
    expect(byId.get(MISSION_MONITOR_NEXT_NODE)?.contextId).toBe(MISSION_MONITOR_GRAPH_CONTEXT_ID);
    expect(byId.get(MISSION_MONITOR_PREVIOUS_NODE)?.defaultSequence).toBe('p');
    expect(byId.get(MISSION_MONITOR_PREVIOUS_NODE)?.contextId).toBe(
      MISSION_MONITOR_GRAPH_CONTEXT_ID,
    );
    expect(byId.get(MISSION_MONITOR_OPEN_DETAIL)?.defaultSequence).toBe('o');
    expect(byId.get(MISSION_MONITOR_OPEN_DETAIL)?.contextId).toBe(
      MISSION_MONITOR_GRAPH_CONTEXT_ID,
    );
    expect(byId.get(MISSION_MONITOR_OPEN_DETAIL)?.opensContextId).toBe(
      MISSION_MONITOR_DETAIL_CONTEXT_ID,
    );

    // L3: n / p / o reused inside the node-detail context.
    expect(byId.get(MISSION_MONITOR_NEXT_SECTION)?.defaultSequence).toBe('n');
    expect(byId.get(MISSION_MONITOR_NEXT_SECTION)?.contextId).toBe(
      MISSION_MONITOR_DETAIL_CONTEXT_ID,
    );
    expect(byId.get(MISSION_MONITOR_PREVIOUS_SECTION)?.defaultSequence).toBe('p');
    expect(byId.get(MISSION_MONITOR_PREVIOUS_SECTION)?.contextId).toBe(
      MISSION_MONITOR_DETAIL_CONTEXT_ID,
    );
    expect(byId.get(MISSION_MONITOR_TOGGLE_SECTION)?.defaultSequence).toBe('o');
    expect(byId.get(MISSION_MONITOR_TOGGLE_SECTION)?.contextId).toBe(
      MISSION_MONITOR_DETAIL_CONTEXT_ID,
    );

    expect(missionMonitorFeature.hotkeys).toHaveLength(10);
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
      MISSION_MONITOR_OPEN_GRAPH,
      MISSION_MONITOR_NEXT_NODE,
      MISSION_MONITOR_PREVIOUS_NODE,
      MISSION_MONITOR_OPEN_DETAIL,
      MISSION_MONITOR_NEXT_SECTION,
      MISSION_MONITOR_PREVIOUS_SECTION,
      MISSION_MONITOR_TOGGLE_SECTION,
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

describe('Mission Monitor — nested contexts + per-level resolution (Spec #2962)', () => {
  beforeEach(() => {
    // Register the REAL feature so its synthesized base context (`mission-monitor`)
    // resolves and the declared descents validate against it.
    registerFeature(missionMonitorFeature);
    resetContextRegistryForTests();
  });

  it('declares exactly the two descents below the top-level base context (R-1.1)', () => {
    expect(missionMonitorFeature.hotkeysContexts).toEqual([
      {
        contextId: MISSION_MONITOR_GRAPH_CONTEXT_ID,
        parentId: 'mission-monitor',
        title: 'Graph',
      },
      {
        contextId: MISSION_MONITOR_DETAIL_CONTEXT_ID,
        parentId: MISSION_MONITOR_GRAPH_CONTEXT_ID,
        title: 'Node detail',
      },
    ]);

    const graph = getHotkeyContext(MISSION_MONITOR_GRAPH_CONTEXT_ID);
    expect(graph?.invalid).toBeUndefined();
    expect(graph?.parentId).toBe('mission-monitor');
    expect(graph?.title).toBe('Graph');

    const detail = getHotkeyContext(MISSION_MONITOR_DETAIL_CONTEXT_ID);
    expect(detail?.invalid).toBeUndefined();
    expect(detail?.parentId).toBe(MISSION_MONITOR_GRAPH_CONTEXT_ID);
    expect(detail?.title).toBe('Node detail');
  });

  it('changes the resolved action set on each descent (R-1.2/R-1.3)', () => {
    const actions = listHotkeyActions();
    const base = resolveContextBindings('mission-monitor', ['mission-monitor'], actions).map(
      (binding) => binding.actionId,
    );
    const graph = resolveContextBindings(
      'mission-monitor',
      ['mission-monitor', MISSION_MONITOR_GRAPH_CONTEXT_ID],
      actions,
    ).map((binding) => binding.actionId);
    const detail = resolveContextBindings(
      'mission-monitor',
      ['mission-monitor', MISSION_MONITOR_GRAPH_CONTEXT_ID, MISSION_MONITOR_DETAIL_CONTEXT_ID],
      actions,
    ).map((binding) => binding.actionId);

    // L1 exposes the base actions + the graph descent, but no deeper action.
    expect(base).toContain(MISSION_MONITOR_OPEN_GRAPH);
    expect(base).not.toContain(MISSION_MONITOR_NEXT_NODE);
    expect(base).not.toContain(MISSION_MONITOR_NEXT_SECTION);

    // L2 adds the graph actions, still no L3 action.
    expect(graph).toContain(MISSION_MONITOR_NEXT_NODE);
    expect(graph).toContain(MISSION_MONITOR_OPEN_DETAIL);
    expect(graph).not.toContain(MISSION_MONITOR_NEXT_SECTION);

    // L3 adds the detail actions.
    expect(detail).toContain(MISSION_MONITOR_NEXT_SECTION);
    expect(detail).toContain(MISSION_MONITOR_TOGGLE_SECTION);

    // Each descent changes the resolved set (R-1.3).
    expect(new Set(graph)).not.toEqual(new Set(base));
    expect(new Set(detail)).not.toEqual(new Set(graph));

    // The deepest level wins for a reused key: bindings are ordered depth DESC,
    // so the L3 `n` binding precedes the L2 and L1 `n` bindings.
    const firstNextSection = detail.indexOf(MISSION_MONITOR_NEXT_SECTION);
    expect(firstNextSection).toBeGreaterThanOrEqual(0);
    expect(detail.indexOf(MISSION_MONITOR_NEXT_NODE)).toBeGreaterThan(firstNextSection);
    expect(detail.indexOf(MISSION_MONITOR_NEXT_SESSION)).toBeGreaterThan(firstNextSection);
  });
});
