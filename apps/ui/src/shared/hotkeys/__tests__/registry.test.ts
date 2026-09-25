/**
 * Spec #2946 ST-2 — registry + contribution API tests (R-2.1/R-2.2/R-2.3).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { IconType } from 'react-icons';

import { FredoFeatureClass } from '../../classes/FredoFeatureClass';
import { registerFeature } from '../../../features/featureRegistry';
import {
  getHotkeyAction,
  listHotkeyActions,
  registerFeatureHotkeys,
  registerFredoAction,
  registerHotkeyHandler,
  resetRegistryForTests,
  runHotkeyAction,
} from '../registry';
import type { FeatureHotkeyAction } from '../types';

function action(actionId: string, overrides: Partial<FeatureHotkeyAction> = {}): FeatureHotkeyAction {
  return {
    actionId,
    title: `Action ${actionId}`,
    defaultSequence: null,
    run: () => {},
    ...overrides,
  };
}

beforeEach(() => {
  resetRegistryForTests();
});

describe('registry merge (R-2.1/R-2.2)', () => {
  it('includes Fredo and feature actions in one listing with the right tier', () => {
    registerFredoAction(action('fredo.test.open'));
    registerFeatureHotkeys('terminal', [action('terminal.newSession')]);

    const list = listHotkeyActions();
    const fredo = list.find((entry) => entry.actionId === 'fredo.test.open');
    const feature = list.find((entry) => entry.actionId === 'terminal.newSession');

    expect(fredo).toBeDefined();
    expect(fredo?.tier).toBe('fredo');
    expect(fredo?.featureId).toBeUndefined();
    expect(fredo?.invalid).toBeUndefined();

    expect(feature).toBeDefined();
    expect(feature?.tier).toBe('feature');
    expect(feature?.featureId).toBe('terminal');
    expect(feature?.invalid).toBeUndefined();
  });

  it('contributes zero rows for a feature that declares none', () => {
    registerFeatureHotkeys('empty-feature', []);
    const rows = listHotkeyActions().filter((entry) => entry.featureId === 'empty-feature');
    expect(rows).toHaveLength(0);
  });

  it('exposes multi-segment camelCase Fredo action ids (adjudicated grammar)', () => {
    registerFredoAction(action('fredo.window.cycleNth'));
    registerFredoAction(action('fredo.terminal.exitPassthrough'));
    expect(getHotkeyAction('fredo.window.cycleNth')).not.toBeNull();
    expect(getHotkeyAction('fredo.terminal.exitPassthrough')).not.toBeNull();
  });
});

describe('invalid registrations are listed but not dispatchable (R-2.3)', () => {
  it('flags a malformed action id', () => {
    const run = vi.fn();
    registerFeatureHotkeys('terminal', [action('Bad Id', { run })]);

    const entry = listHotkeyActions().find((row) => row.actionId === 'Bad Id');
    expect(entry?.invalid).toMatch(/Malformed/);
    expect(getHotkeyAction('Bad Id')).toBeNull();

    runHotkeyAction('Bad Id', 'binding');
    expect(run).not.toHaveBeenCalled();
  });

  it('flags a foreign-prefixed feature action', () => {
    registerFeatureHotkeys('terminal', [action('mission-monitor.focus')]);
    const entry = listHotkeyActions().find((row) => row.actionId === 'mission-monitor.focus');
    expect(entry?.invalid).toMatch(/outside feature/);
    expect(getHotkeyAction('mission-monitor.focus')).toBeNull();
  });

  it('flags a feature declaring a Fredo-tier action', () => {
    registerFeatureHotkeys('terminal', [action('fredo.terminal.exitPassthrough')]);
    const entry = listHotkeyActions().find((row) => row.actionId === 'fredo.terminal.exitPassthrough');
    expect(entry?.invalid).toMatch(/may not declare the Fredo-tier/);
  });

  it('flags a feature-tier action with no owning feature', () => {
    registerFredoAction(action('terminal.orphan'));
    const entry = listHotkeyActions().find((row) => row.actionId === 'terminal.orphan');
    expect(entry?.invalid).toMatch(/no owning feature/);
  });

  it('flags an unknown default sequence', () => {
    registerFeatureHotkeys('terminal', [
      action('terminal.badSequence', { defaultSequence: 'not a real key' }),
    ]);
    const entry = listHotkeyActions().find((row) => row.actionId === 'terminal.badSequence');
    expect(entry?.invalid).toMatch(/Unknown default sequence/);
  });

  it('marks the later duplicate invalid and dispatches only the first', () => {
    const first = vi.fn();
    const second = vi.fn();
    registerFredoAction(action('fredo.test.dup', { run: first }));
    registerFredoAction(action('fredo.test.dup', { run: second }));

    const rows = listHotkeyActions().filter((row) => row.actionId === 'fredo.test.dup');
    expect(rows).toHaveLength(2);
    expect(rows[0].invalid).toBeUndefined();
    expect(rows[1].invalid).toMatch(/Duplicate/);

    runHotkeyAction('fredo.test.dup', 'palette');
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });
});

describe('dispatch', () => {
  it('passes the invocation context to run and honours enabled()', () => {
    const run = vi.fn();
    registerFredoAction(action('fredo.test.ctx', { run }));
    runHotkeyAction('fredo.test.ctx', 'binding', [], 'terminal');
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: 'fredo.test.ctx',
        tier: 'fredo',
        source: 'binding',
        focusedFeatureId: 'terminal',
      }),
    );

    const disabledRun = vi.fn();
    registerFredoAction(action('fredo.test.disabled', { run: disabledRun, enabled: () => false }));
    runHotkeyAction('fredo.test.disabled', 'binding');
    expect(disabledRun).not.toHaveBeenCalled();
  });

  it('lets a React-bound handler override the declared run, and null restores it', () => {
    const declared = vi.fn();
    const bound = vi.fn();
    registerFredoAction(action('fredo.test.bound', { run: declared }));

    registerHotkeyHandler('fredo.test.bound', bound);
    runHotkeyAction('fredo.test.bound', 'palette');
    expect(bound).toHaveBeenCalledTimes(1);
    expect(declared).not.toHaveBeenCalled();

    registerHotkeyHandler('fredo.test.bound', null);
    runHotkeyAction('fredo.test.bound', 'palette');
    expect(declared).toHaveBeenCalledTimes(1);
  });
});

describe('feature-instance discovery (R-2.1)', () => {
  it('inherits an empty frozen default contribution', () => {
    class BareFeature extends FredoFeatureClass {
      readonly id = 'bare-widget';
      readonly name = 'Bare';
      readonly icon = (() => null) as unknown as IconType;
      render(): ReactElement {
        return null as unknown as ReactElement;
      }
    }
    const bare = new BareFeature();
    expect(bare.hotkeys).toHaveLength(0);
    expect(Object.isFrozen(bare.hotkeys)).toBe(true);
  });

  it('auto-discovers hotkeys declared on a registered feature instance', () => {
    class DemoFeature extends FredoFeatureClass {
      readonly id = 'demo-widget';
      readonly name = 'Demo';
      readonly icon = (() => null) as unknown as IconType;
      override readonly hotkeys: readonly FeatureHotkeyAction[] = [
        action('demo-widget.focus', { defaultSequence: 'g g' }),
      ];
      render(): ReactElement {
        return null as unknown as ReactElement;
      }
    }

    registerFeature(new DemoFeature());

    const entry = listHotkeyActions().find((row) => row.actionId === 'demo-widget.focus');
    expect(entry).toBeDefined();
    expect(entry?.featureId).toBe('demo-widget');
    expect(entry?.tier).toBe('feature');
    expect(entry?.defaultSequence).toBe('g g');
  });
});
