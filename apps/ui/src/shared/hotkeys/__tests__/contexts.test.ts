/**
 * Spec #2958 ST-1 — the interaction-context registry + cumulative layered
 * resolution (EARS R-1.1/R-1.2/R-1.3, R-2.2/R-2.3, R-5.1/R-5.2/R-5.3).
 *
 * The key regression is BASE-LIST BYTE-PARITY: at the base path,
 * `resolveContextBindings` must return exactly what #2946's
 * `resolveActiveBindings` returns (same order, same serialized sequences).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import type { IconType } from 'react-icons';

import { FredoFeatureClass } from '../../classes/FredoFeatureClass';
import { registerFeature } from '../../../features/featureRegistry';
import {
  ROOT_CONTEXT_ID,
  type FeatureHotkeyAction,
  type RegisteredHotkeyAction,
} from '../types';
import {
  getHotkeyContext,
  isPlatformContext,
  isValidHotkeyContextId,
  listHotkeyContexts,
  registerFeatureHotkeyContexts,
  registerHotkeyContext,
  resetContextRegistryForTests,
  resolveBaseContextId,
  resolveContextBindings,
} from '../contexts';
import {
  listHotkeyActions,
  registerFeatureHotkeys,
  registerFredoAction,
  resetRegistryForTests,
} from '../registry';
import { resetKeymapStoreForTests } from '../store';
import { resolveActiveBindings } from '../engine';
import { parseSequence } from '../keys';
import { decideDispatch } from '../sequence';

function featureAction(
  actionId: string,
  overrides: Partial<FeatureHotkeyAction> = {},
): FeatureHotkeyAction {
  return {
    actionId,
    title: `Action ${actionId}`,
    defaultSequence: null,
    run: () => {},
    ...overrides,
  };
}

function registered(
  actionId: string,
  overrides: Partial<RegisteredHotkeyAction> = {},
): RegisteredHotkeyAction {
  return {
    actionId,
    tier: actionId.startsWith('fredo.') ? 'fredo' : 'feature',
    title: `Action ${actionId}`,
    defaultSequence: null,
    run: () => {},
    ...overrides,
  };
}

beforeEach(() => {
  resetRegistryForTests();
  resetKeymapStoreForTests();
  resetContextRegistryForTests();
});

describe('context registry identity', () => {
  it('always registers the platform ROOT with a self-parent and title Fredo', () => {
    const root = getHotkeyContext(ROOT_CONTEXT_ID);
    expect(root).not.toBeNull();
    expect(root?.title).toBe('Fredo');
    expect(root?.parentId).toBe(ROOT_CONTEXT_ID);
    expect(root?.featureId).toBeUndefined();
    expect(root?.invalid).toBeUndefined();
  });

  it('validates context ids identically to action ids', () => {
    expect(isValidHotkeyContextId('fredo.root.reference')).toBe(true);
    expect(isValidHotkeyContextId('demo.canvas')).toBe(true);
    expect(isValidHotkeyContextId('demo.canvas.grid')).toBe(true);
    expect(isValidHotkeyContextId('Bad Id')).toBe(false);
    expect(isValidHotkeyContextId('nope')).toBe(false);
  });

  it('recognises the platform namespace', () => {
    expect(isPlatformContext(ROOT_CONTEXT_ID)).toBe(true);
    expect(isPlatformContext('fredo.root.reference')).toBe(true);
    expect(isPlatformContext('demo.canvas')).toBe(false);
  });

  it('resolves the base context to the feature id, else ROOT', () => {
    expect(resolveBaseContextId('demo')).toBe('demo');
    expect(resolveBaseContextId(null)).toBe(ROOT_CONTEXT_ID);
  });
});

describe('context registration + synthesized bases', () => {
  it('synthesizes a base context for each registered feature', () => {
    registerFeatureHotkeyContexts('demo', [
      { contextId: 'demo.canvas', parentId: 'demo', title: 'Canvas' },
    ]);

    const base = getHotkeyContext('demo');
    expect(base).not.toBeNull();
    expect(base?.featureId).toBe('demo');
    expect(base?.parentId).toBe(ROOT_CONTEXT_ID);
    expect(base?.title).toBe('demo');
    expect(base?.invalid).toBeUndefined();

    const canvas = getHotkeyContext('demo.canvas');
    expect(canvas?.parentId).toBe('demo');
    expect(canvas?.featureId).toBe('demo');
    expect(canvas?.title).toBe('Canvas');
    expect(canvas?.invalid).toBeUndefined();
  });

  it('registers a platform context from any parent', () => {
    registerHotkeyContext({ contextId: 'fredo.root.reference', parentId: ROOT_CONTEXT_ID, title: 'Reference' });
    const ref = getHotkeyContext('fredo.root.reference');
    expect(ref?.featureId).toBeUndefined();
    expect(ref?.invalid).toBeUndefined();
  });

  it('flags malformed, foreign-prefixed, and unknown-parent contexts', () => {
    registerFeatureHotkeyContexts('demo', [
      { contextId: 'other.canvas', parentId: 'demo', title: 'Foreign' },
      { contextId: 'Bad Id', parentId: 'demo', title: 'Malformed' },
      { contextId: 'demo.lonely', parentId: 'nope.missing', title: 'Orphan' },
      { contextId: 'demo.untitled', parentId: 'demo', title: '' },
    ]);

    expect(getHotkeyContext('other.canvas')?.invalid).toMatch(/outside feature/);
    expect(getHotkeyContext('Bad Id')?.invalid).toMatch(/Malformed/);
    expect(getHotkeyContext('demo.lonely')?.invalid).toMatch(/unknown parent/);
    expect(getHotkeyContext('demo.untitled')?.invalid).toMatch(/missing a title/);
  });

  it('flags a platform context declared outside the fredo namespace', () => {
    registerHotkeyContext({ contextId: 'demo.oops', parentId: ROOT_CONTEXT_ID, title: 'Oops' });
    expect(getHotkeyContext('demo.oops')?.invalid).toMatch(/fredo\./);
  });

  it('flags a feature declaring the platform namespace', () => {
    registerFeatureHotkeyContexts('demo', [
      { contextId: 'fredo.mine', parentId: ROOT_CONTEXT_ID, title: 'Mine' },
    ]);
    expect(getHotkeyContext('fredo.mine')?.invalid).toMatch(/may not declare the platform context/);
  });

  it('clears explicit registrations but keeps ROOT on reset', () => {
    registerFeatureHotkeyContexts('demo', [
      { contextId: 'demo.canvas', parentId: 'demo', title: 'Canvas' },
    ]);
    resetContextRegistryForTests();
    expect(getHotkeyContext('demo.canvas')).toBeNull();
    expect(getHotkeyContext(ROOT_CONTEXT_ID)).not.toBeNull();
  });

  it('discovers contexts declared on a registered feature instance', () => {
    class CtxFeature extends FredoFeatureClass {
      readonly id = 'ctx-demo';
      readonly name = 'Ctx Demo';
      readonly icon = (() => null) as unknown as IconType;
      override readonly hotkeysContexts = [
        { contextId: 'ctx-demo.canvas', parentId: 'ctx-demo', title: 'Canvas' } as const,
      ];
      render(): ReactElement {
        return null as unknown as ReactElement;
      }
    }
    registerFeature(new CtxFeature());

    expect(getHotkeyContext('ctx-demo')?.featureId).toBe('ctx-demo');
    expect(getHotkeyContext('ctx-demo.canvas')?.title).toBe('Canvas');
    expect(listHotkeyContexts().some((c) => c.contextId === 'ctx-demo.canvas')).toBe(true);
  });
});

describe('cumulative layered resolution', () => {
  it('is byte-identical to #2946 resolveActiveBindings at the base path', () => {
    registerFredoAction(featureAction('fredo.test.alpha', { defaultSequence: 'g g' }));
    registerFredoAction(featureAction('fredo.test.beta', { defaultSequence: null }));
    registerFeatureHotkeys('demo', [
      featureAction('demo.one', { defaultSequence: 'n' }),
      featureAction('demo.two', { defaultSequence: 'p' }),
      featureAction('demo.unbound', { defaultSequence: null }),
    ]);
    registerFeatureHotkeys('other', [featureAction('other.one', { defaultSequence: 'x' })]);

    const legacy = resolveActiveBindings('demo').map((b) => [b.actionId, b.serialized]);
    const next = resolveContextBindings('demo', undefined, listHotkeyActions()).map((b) => [
      b.actionId,
      b.serialized,
    ]);

    expect(next).toEqual(legacy);
    expect(next.map(([actionId]) => actionId)).toEqual(['fredo.test.alpha', 'demo.one', 'demo.two']);
  });

  it('orders feature bindings by context depth DESC (base last), Fredo first', () => {
    const actions = [
      registered('fredo.global', { defaultSequence: 'g' }),
      registered('demo.base', { featureId: 'demo', defaultSequence: 'a' }),
      registered('demo.mid', { featureId: 'demo', contextId: 'demo.canvas', defaultSequence: 'b' }),
      registered('demo.deep', {
        featureId: 'demo',
        contextId: 'demo.canvas.node',
        defaultSequence: 'c',
      }),
    ];

    const order = resolveContextBindings(
      'demo',
      ['demo', 'demo.canvas', 'demo.canvas.node'],
      actions,
    ).map((b) => b.actionId);

    expect(order).toEqual(['fredo.global', 'demo.deep', 'demo.mid', 'demo.base']);
  });

  it('resolves a key reused across levels to the deepest binding first (deepest wins, R-2.1)', () => {
    const actions = [
      registered('demo.base', { featureId: 'demo', defaultSequence: 'g' }),
      registered('demo.deep', {
        featureId: 'demo',
        contextId: 'demo.canvas',
        defaultSequence: 'g',
      }),
    ];
    const bindings = resolveContextBindings('demo', ['demo', 'demo.canvas'], actions);
    // The deepest level leads, so the engine's FIRST exact match is the current
    // level's action — the parent binding never runs while descended.
    expect(bindings.map((b) => b.actionId)).toEqual(['demo.deep', 'demo.base']);

    const stroke = parseSequence('g')[0];
    const decision = decideDispatch({
      stroke,
      context: 'default',
      pending: null,
      bindings,
      leader: null,
      macroRecording: false,
      nativeConsumes: false,
      platform: 'win32',
    });
    expect(decision.outcome).toBe('match');
    expect(decision.action?.actionId).toBe('demo.deep');
  });

  it('treats an omitted contextId as the feature base context (R-1.2)', () => {
    const bindings = resolveContextBindings('demo', ['demo'], [
      registered('demo.base', { featureId: 'demo', defaultSequence: 'a' }),
    ]);
    expect(bindings.map((b) => b.actionId)).toEqual(['demo.base']);
  });

  it('never includes a binding whose context is off the path (R-5.1/R-5.3)', () => {
    const actions = [
      registered('demo.base', { featureId: 'demo', defaultSequence: 'a' }),
      registered('demo.sibling', { featureId: 'demo', contextId: 'demo.other', defaultSequence: 's' }),
      registered('other.one', { featureId: 'other', defaultSequence: 'x' }),
      registered('demo.canvas', { featureId: 'demo', contextId: 'demo.canvas', defaultSequence: 'c' }),
    ];

    const bindings = resolveContextBindings('demo', ['demo'], actions);
    expect(bindings.map((b) => b.actionId)).toEqual(['demo.base']);
  });

  it('keeps ancestor bindings in force while descended (R-5.2)', () => {
    const actions = [registered('demo.base', { featureId: 'demo', defaultSequence: 'a' })];
    const bindings = resolveContextBindings('demo', ['demo', 'demo.canvas'], actions);
    expect(bindings.map((b) => b.actionId)).toEqual(['demo.base']);
  });

  it('includes a descended context binding while it is active (R-2.2)', () => {
    const actions = [
      registered('demo.canvasOnly', {
        featureId: 'demo',
        contextId: 'demo.canvas',
        defaultSequence: 'v',
      }),
    ];
    expect(resolveContextBindings('demo', ['demo'], actions)).toEqual([]);
    expect(
      resolveContextBindings('demo', ['demo', 'demo.canvas'], actions).map((b) => b.actionId),
    ).toEqual(['demo.canvasOnly']);
  });

  it('scopes a Fredo-tier action to a platform context only while it is active', () => {
    const actions = [
      registered('fredo.context.referenceAction', {
        contextId: 'fredo.root.reference',
        defaultSequence: 'y',
      }),
    ];
    expect(resolveContextBindings('demo', undefined, actions)).toEqual([]);
    expect(
      resolveContextBindings('demo', ['demo', 'fredo.root.reference'], actions).map(
        (b) => b.actionId,
      ),
    ).toEqual(['fredo.context.referenceAction']);
  });

  it('always keeps an unscoped Fredo action in force (R-1.3)', () => {
    const actions = [
      registered('fredo.context.descendReference', { defaultSequence: 'primary+k' }),
      registered('demo.base', { featureId: 'demo', defaultSequence: 'primary+k' }),
    ];
    const bindings = resolveContextBindings('demo', ['demo'], actions);
    expect(bindings.map((b) => b.actionId)).toEqual([
      'fredo.context.descendReference',
      'demo.base',
    ]);
  });
});
