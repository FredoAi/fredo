/**
 * Spec #2961 ST-4 — continuous focus-scoping + cross-app key reuse contract pins
 * (EARS R-1.2 / R-3.1 / R-4.1 / R-5.3).
 *
 * Two synthetic apps declare the SAME key (`x`) for DIFFERENT actions. The
 * shipped resolver (`resolveActiveBindings`, `engine.ts`) must scope feature-tier
 * bindings to the focused feature only, the keyboard-bar model
 * (`buildKeyboardBarModel`, `keyboardBarModel.ts`) must project only the focused
 * app's feature-tier rows, a focus switch must change the resolved set
 * deterministically, and a feature that declares no hotkeys must contribute zero
 * feature-tier rows (graceful absence).
 *
 * TESTS ONLY — no production file (resolver / engine / bar / defaults) is touched.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import type { IconType } from 'react-icons';

import { FredoApplicationClass } from '../../classes/FredoApplicationClass';
import { registerApplication } from '../../../applications/applicationRegistry';
import {
  registerFeatureHotkeys,
  registerFredoAction,
  resetRegistryForTests,
} from '../registry';
import { resetContextRegistryForTests } from '../contexts';
import { resetHotkeyContextForTests } from '../contextStack';
import { resetKeymapStoreForTests } from '../store';
import { resolveActiveBindings, type FocusSnapshot } from '../engine';
import { buildKeyboardBarModel, type KeyboardBarModelInput } from '../keyboardBarModel';
import type { ApplicationHotkeyAction, ResolvedBinding } from '../types';

const NO_ICON = (() => null) as unknown as IconType;

/**
 * A synthetic app that declares NO hotkeys (R-4.1 graceful absence). The feature
 * registry has no test reset, so it is registered ONCE at module scope; an
 * action-less feature contributes nothing to any other assertion.
 */
class EmptyAppFeature extends FredoApplicationClass {
  readonly id = 'app-empty';
  readonly name = 'App Empty';
  readonly icon = NO_ICON;
  render(): ReactElement {
    return null as unknown as ReactElement;
  }
}

registerApplication(new EmptyAppFeature());

/** A feature-tier declaration bound to the shared key `x`. */
function sharedKeyAction(actionId: string): ApplicationHotkeyAction {
  return {
    actionId,
    title: `Action ${actionId}`,
    defaultSequence: 'x',
    run: () => {},
  };
}

function defaultFocus(): FocusSnapshot {
  return { context: 'default', nativeConsumes: false, textEntry: false };
}

function barInput(
  focusedFeatureId: string,
  bindings: readonly ResolvedBinding[],
): KeyboardBarModelInput {
  return {
    bindings,
    contextId: focusedFeatureId,
    contextTitle: focusedFeatureId,
    depth: 1,
    focus: defaultFocus(),
    macroRecording: false,
    platform: 'win32',
  };
}

function featureTierIds(bindings: readonly ResolvedBinding[]): string[] {
  return bindings.filter((binding) => binding.tier === 'feature').map((binding) => binding.actionId);
}

beforeEach(() => {
  resetRegistryForTests();
  resetKeymapStoreForTests();
  resetContextRegistryForTests();
  resetHotkeyContextForTests();
  // Two synthetic apps, the SAME key, DIFFERENT actions.
  registerFeatureHotkeys('app-a', [sharedKeyAction('app-a.activate')]);
  registerFeatureHotkeys('app-b', [sharedKeyAction('app-b.activate')]);
  // The always-on Fredo/global tier, in force regardless of focus.
  registerFredoAction({
    actionId: 'fredo.test.global',
    title: 'Global action',
    defaultSequence: 'ctrl+shift+g',
    run: () => {},
  });
});

describe('focus-scoped resolution across apps sharing one key (R-1.2/R-5.3)', () => {
  it('resolves ONLY the focused app feature-tier action for the shared key', () => {
    const bindingsA = resolveActiveBindings('app-a');
    expect(featureTierIds(bindingsA)).toEqual(['app-a.activate']);
    expect(featureTierIds(bindingsA)).not.toContain('app-b.activate');

    const bindingsB = resolveActiveBindings('app-b');
    expect(featureTierIds(bindingsB)).toEqual(['app-b.activate']);
    expect(featureTierIds(bindingsB)).not.toContain('app-a.activate');

    // Both declare the SAME serialized key — only focus decides which resolves.
    expect(bindingsA.find((b) => b.actionId === 'app-a.activate')?.serialized).toBe('x');
    expect(bindingsB.find((b) => b.actionId === 'app-b.activate')?.serialized).toBe('x');
  });

  it('always keeps the unscoped Fredo/global tier in force (R-1.3)', () => {
    const fredoTierIds = resolveActiveBindings('app-a')
      .filter((binding) => binding.tier === 'fredo')
      .map((binding) => binding.actionId);
    expect(fredoTierIds).toContain('fredo.test.global');
  });
});

describe('keyboard-bar model is focus-scoped (R-3.1/R-4.1)', () => {
  it('projects feature-tier rows only for the focused app', () => {
    const modelA = buildKeyboardBarModel(barInput('app-a', resolveActiveBindings('app-a')));
    const modelB = buildKeyboardBarModel(barInput('app-b', resolveActiveBindings('app-b')));

    const rowsA = modelA.rows.filter((row) => row.tier === 'feature').map((row) => row.actionId);
    const rowsB = modelB.rows.filter((row) => row.tier === 'feature').map((row) => row.actionId);

    expect(rowsA).toEqual(['app-a.activate']);
    expect(rowsB).toEqual(['app-b.activate']);
    expect(rowsA).not.toContain('app-b.activate');
    expect(rowsB).not.toContain('app-a.activate');
  });

  it('is deterministic: identical focus + keymap ⇒ identical rows', () => {
    const first = buildKeyboardBarModel(barInput('app-a', resolveActiveBindings('app-a')));
    const second = buildKeyboardBarModel(barInput('app-a', resolveActiveBindings('app-a')));
    expect(second.rows.map((row) => [row.actionId, row.sequence, row.availability])).toEqual(
      first.rows.map((row) => [row.actionId, row.sequence, row.availability]),
    );
  });

  it('switches the resolved set deterministically on an A→B focus move', () => {
    const modelA = buildKeyboardBarModel(barInput('app-a', resolveActiveBindings('app-a')));
    const modelB = buildKeyboardBarModel(barInput('app-b', resolveActiveBindings('app-b')));
    const featureRowsA = modelA.rows.filter((row) => row.tier === 'feature').map((row) => row.actionId);
    const featureRowsB = modelB.rows.filter((row) => row.tier === 'feature').map((row) => row.actionId);

    expect(featureRowsA).toEqual(['app-a.activate']);
    expect(featureRowsB).toEqual(['app-b.activate']);
    expect(featureRowsA).not.toEqual(featureRowsB);
  });

  it('contributes ZERO feature-tier rows for a feature that declares no hotkeys (R-4.1)', () => {
    const bindings = resolveActiveBindings('app-empty');
    expect(featureTierIds(bindings)).toEqual([]);

    const model = buildKeyboardBarModel(barInput('app-empty', bindings));
    expect(model.rows.filter((row) => row.tier === 'feature')).toHaveLength(0);
    // The always-on Fredo tier still resolves — only the feature tier is absent.
    expect(model.rows.filter((row) => row.tier === 'fredo').map((row) => row.actionId)).toContain(
      'fredo.test.global',
    );
  });
});
