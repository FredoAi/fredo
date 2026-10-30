/**
 * Spec #3117 (P3) — ST-1 §4.1 key-resolution proofs.
 *
 * Covers REQ-02.1–02.14 / REQ-02.16 and the resolution side of AC10 (ambiguity is an
 * error). Every `it()` title the #3117 QA Plan cites for this module is verbatim.
 *
 * Dispatch-time facts (the transient pop, `overlayClose`, journal entries) belong to
 * ST-2 — the resolver-side assertion is made here and the end-to-end one lives in
 * `dispatch.test.ts` / `traces.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import {
  createPendingPrefix,
  resolveStroke,
  type KeyResolution,
  type ResolverInput,
} from '../keyResolver';
import { isBindableStroke, normalizeStroke } from '../resolver';
import {
  PENDING_TIMEOUT_MS,
  type KeyBinding,
  type KeyboardOwner,
  type Surface,
} from '../types';
import { makePlace, makeSurface, makeVerb, validWireframeSurface } from './fixtures';

const CANVAS = 'wireframe.canvas';
const CREATE = 'wireframe.create';
const EDIT = 'wireframe.edit';
const ARRANGE = 'wireframe.arrange';

const surface = validWireframeSurface();

function resolve(stroke: string, overrides: Partial<ResolverInput> = {}): KeyResolution {
  return resolveStroke({
    surface,
    placePath: [CANVAS],
    pending: null,
    stroke,
    nowMs: 1000,
    keyboardOwner: 'engine',
    ...overrides,
  });
}

function verbBinding(verbId: string): KeyBinding {
  return { kind: 'verb', verbId };
}

function surfaceWithKeys(
  keys: Readonly<Record<string, KeyBinding>>,
  directAliases: Readonly<Record<string, string>> = {},
  verbIds: readonly string[] = [],
): Surface {
  return makeSurface({
    root: 'p.root',
    places: [makePlace({ id: 'p.root', keys })],
    verbs: verbIds.map((id) => makeVerb({ id })),
    directAliases,
  });
}

function expectDispatch(result: KeyResolution, verbId: string, tier: 1 | 2 | 3): void {
  expect(result.status).toBe('dispatch');
  if (result.status !== 'dispatch') {
    throw new Error(`expected dispatch, got ${result.status}`);
  }
  expect(result.intent.verbId).toBe(verbId);
  expect(result.intent.args).toStrictEqual({});
  expect(result.tier).toBe(tier);
}

describe('tiers 1 and 2 (§4.1)', () => {
  it('tier 1 place key beats direct alias', () => {
    expectDispatch(resolve('c'), 'place.create', 1);
    // `r` is BOTH the create place's key and the application alias; tier 1 wins.
    expectDispatch(resolve('r', { placePath: [CANVAS, CREATE] }), 'place.rect', 1);
  });

  it('direct alias resolves only when tier 1 is empty', () => {
    expectDispatch(resolve('e'), 'place.ellipse', 2);
    expectDispatch(resolve('e', { placePath: [CANVAS, CREATE] }), 'place.ellipse', 1);
    expectDispatch(resolve('u'), 'journal.undo', 2);
    expectDispatch(resolve('y'), 'journal.redo', 2);
  });

  it('same verb place key and alias dispatch at tier 1', () => {
    const result = resolve('r', { placePath: [CANVAS, CREATE] });
    expectDispatch(result, 'place.rect', 1);
    expect(result).not.toStrictEqual({ status: 'rejected', code: 'ambiguous-key' });
  });

  it('unbound stroke returns a quiet hint', () => {
    const result = resolve('q');
    expect(result.status).toBe('hint');
    if (result.status === 'hint') {
      expect(result.hint.rows).toStrictEqual([]);
      expect(result.hint.readyAfterMs).toBe(0);
    }
    expect(result).not.toHaveProperty('intent');
  });
});

describe('tier 3 — the armed prefix (§4.1)', () => {
  it('first stroke with continuations arms and dispatches nothing', () => {
    const result = resolve('w');
    expect(result.status).toBe('armed');
    if (result.status !== 'armed') throw new Error(`expected armed, got ${result.status}`);
    expect(result.prefix.sequence).toBe('w');
    expect(result.prefix.armedAtMs).toBe(1000);
    expect(result).not.toHaveProperty('intent');
  });

  it('stroke without continuations falls through to tier 2', () => {
    expectDispatch(resolve('u'), 'journal.undo', 2);
    expectDispatch(resolve('y'), 'journal.redo', 2);
  });

  it('armed prefix consults tier 3 only', () => {
    const continued = resolve('n', { pending: createPendingPrefix('w', 1000), nowMs: 1100 });
    expectDispatch(continued, 'window.focusNext', 3);

    // The same stroke is a tier-1 key of the same place — tier 3 must still win.
    const collision = surfaceWithKeys(
      { x: verbBinding('verb.tier1'), 'w x': verbBinding('verb.tier3') },
      {},
      ['verb.tier1', 'verb.tier3'],
    );
    const armedResult = resolveStroke({
      surface: collision,
      placePath: ['p.root'],
      pending: createPendingPrefix('w', 1000),
      stroke: 'x',
      nowMs: 1100,
      keyboardOwner: 'engine',
    });
    expectDispatch(armedResult, 'verb.tier3', 3);
  });

  it('invalid continuation cancels and re-resolves at tier 1', () => {
    const tier1 = resolve('c', { pending: createPendingPrefix('w', 1000), nowMs: 1100 });
    expectDispatch(tier1, 'place.create', 1);

    // A tier-2-only stroke after an armed prefix also re-resolves in the same call.
    const tier2 = resolve('u', { pending: createPendingPrefix('w', 1000), nowMs: 1100 });
    expectDispatch(tier2, 'journal.undo', 2);
  });

  it('prefix times out at 250 ms with no fallback', () => {
    const deep = surfaceWithKeys({ 'w n x': verbBinding('verb.deep') }, {}, ['verb.deep']);
    const armedAtMs = 1000;

    const stillArmed = resolveStroke({
      surface: deep,
      placePath: ['p.root'],
      pending: createPendingPrefix('w', armedAtMs),
      stroke: 'n',
      nowMs: armedAtMs + PENDING_TIMEOUT_MS - 1,
      keyboardOwner: 'engine',
    });
    expect(stillArmed.status).toBe('armed');

    const timedOut = resolveStroke({
      surface: deep,
      placePath: ['p.root'],
      pending: createPendingPrefix('w', armedAtMs),
      stroke: 'n',
      nowMs: armedAtMs + PENDING_TIMEOUT_MS,
      keyboardOwner: 'engine',
    });
    expect(timedOut).toStrictEqual({ status: 'timeout' });

    // The prefix's own single-stroke binding is NEVER dispatched on timeout.
    const withSingleStroke = surfaceWithKeys(
      { w: verbBinding('verb.single'), 'w n': verbBinding('verb.long') },
      {},
      ['verb.single', 'verb.long'],
    );
    const noFallback = resolveStroke({
      surface: withSingleStroke,
      placePath: ['p.root'],
      pending: createPendingPrefix('w', armedAtMs),
      stroke: 'n',
      nowMs: armedAtMs + PENDING_TIMEOUT_MS,
      keyboardOwner: 'engine',
    });
    expect(noFallback).toStrictEqual({ status: 'timeout' });
  });
});

describe('passthrough (§4.1)', () => {
  it('text-entry terminal and modal owners pass every stroke through', () => {
    const owners: readonly KeyboardOwner[] = ['text-entry', 'terminal', 'modal'];
    for (const owner of owners) {
      expect(resolve('c', { keyboardOwner: owner })).toStrictEqual({ status: 'passthrough' });
      expect(resolve('r', { keyboardOwner: owner })).toStrictEqual({ status: 'passthrough' });
      expect(resolve('w', { keyboardOwner: owner })).toStrictEqual({ status: 'passthrough' });
      expect(resolve('Escape', { keyboardOwner: owner })).toStrictEqual({
        status: 'passthrough',
      });
    }

    // An ambiguous stroke under passthrough is still a passthrough — no rejection.
    const ambiguous = surfaceWithKeys(
      { c: verbBinding('verb.one'), 'c ': verbBinding('verb.two') },
      {},
      ['verb.one', 'verb.two'],
    );
    const passed = resolveStroke({
      surface: ambiguous,
      placePath: ['p.root'],
      pending: null,
      stroke: 'c',
      nowMs: 1000,
      keyboardOwner: 'terminal',
    });
    expect(passed).toStrictEqual({ status: 'passthrough' });

    // `engine` ownership is unaffected.
    expectDispatch(resolve('c', { keyboardOwner: 'engine' }), 'place.create', 1);
  });
});

describe('ambiguity (§4.1, AC10)', () => {
  it('two intents on one stroke reject ambiguous-key', () => {
    const twoIntents = surfaceWithKeys(
      { c: verbBinding('verb.one'), 'c ': verbBinding('verb.two') },
      {},
      ['verb.one', 'verb.two'],
    );
    const result = resolveStroke({
      surface: twoIntents,
      placePath: ['p.root'],
      pending: null,
      stroke: 'c',
      nowMs: 1000,
      keyboardOwner: 'engine',
    });
    expect(result).toStrictEqual({ status: 'rejected', code: 'ambiguous-key' });
    expect(result).not.toHaveProperty('intent');

    // Declaration order reversed yields the SAME outcome (no first/last-wins).
    const reversed = surfaceWithKeys(
      { 'c ': verbBinding('verb.two'), c: verbBinding('verb.one') },
      {},
      ['verb.one', 'verb.two'],
    );
    const reversedResult = resolveStroke({
      surface: reversed,
      placePath: ['p.root'],
      pending: null,
      stroke: 'c',
      nowMs: 1000,
      keyboardOwner: 'engine',
    });
    expect(reversedResult).toStrictEqual({ status: 'rejected', code: 'ambiguous-key' });

    // Three bindings on one stroke behave identically.
    const three = surfaceWithKeys(
      { c: verbBinding('verb.one'), C: verbBinding('verb.two'), 'c ': verbBinding('verb.three') },
      {},
      ['verb.one', 'verb.two', 'verb.three'],
    );
    const threeResult = resolveStroke({
      surface: three,
      placePath: ['p.root'],
      pending: null,
      stroke: 'c',
      nowMs: 1000,
      keyboardOwner: 'engine',
    });
    expect(threeResult).toStrictEqual({ status: 'rejected', code: 'ambiguous-key' });
  });
});

describe('place locality and no fifth tier (§4.1)', () => {
  it('place keys are place-local', () => {
    // `g` is declared only in wireframe.arrange.
    expect(resolve('g').status).toBe('hint');
    expectDispatch(resolve('g', { placePath: [CANVAS, ARRANGE] }), 'place.group', 1);

    // The same stroke in two sibling places resolves per place.
    expectDispatch(resolve('a'), 'place.arrange', 1);
    expectDispatch(resolve('a', { placePath: [CANVAS, EDIT] }), 'place.selectAll', 1);

    // A child key pressed at the parent does not dispatch.
    expectDispatch(resolve('z', { placePath: [CANVAS, ARRANGE] }), 'place.alignRight', 1);
    expect(resolve('z').status).toBe('hint');
  });

  it('no fifth tier is consulted', () => {
    // `z` is bound in a place that is not current — no global registry is consulted.
    expect(resolve('z').status).toBe('hint');
    expect(resolve('q').status).toBe('hint');
    // A browser/OS shortcut token is not bindable and cannot dispatch.
    expect(isBindableStroke('F1')).toBe(false);
    expect(resolve('F1').status).toBe('hint');
    expect(resolve('ctrl+c').status).toBe('hint');
  });
});

describe('Escape and transient exits (§2.2)', () => {
  it('Escape pops one level in a child place', () => {
    const result = resolve('Escape', { placePath: [CANVAS, CREATE] });
    expectDispatch(result, 'place.exit', 1);

    // Cancelling an armed prefix is part of the SAME press — one level, never zero.
    const fromArmed = resolve('Escape', {
      placePath: [CANVAS, CREATE],
      pending: createPendingPrefix('w', 1000),
    });
    expectDispatch(fromArmed, 'place.exit', 1);
  });

  it('Escape at root dispatches nothing and reports overlayClose', () => {
    // The resolver-side fact: at the root Escape produces NO intent and NO dispatch.
    // `overlayClose` is reported by ST-2's dispatch (`EngineDeps.overlayOpen`).
    const result = resolve('Escape');
    expect(result.status).not.toBe('dispatch');
    expect(result).not.toHaveProperty('intent');
    expect(result.status).toBe('hint');

    const emptyPath = resolve('Escape', { placePath: [] });
    expect(emptyPath.status).not.toBe('dispatch');
  });

  it('transient place pops exactly one level on verb completion', () => {
    // Resolution side: one intent only. The pop + `exitedBy:'verb'` are dispatch's job.
    const result = resolve('r', { placePath: [CANVAS, CREATE] });
    expectDispatch(result, 'place.rect', 1);
    expect(result).toHaveProperty('intent');
  });
});

describe('determinism (REQ-01.5)', () => {
  it('resolveStroke is deterministic for identical inputs', () => {
    const input: ResolverInput = {
      surface,
      placePath: [CANVAS, CREATE],
      pending: createPendingPrefix('w', 1000),
      stroke: 'n',
      nowMs: 1100,
      keyboardOwner: 'engine',
    };
    expect(resolveStroke(input)).toStrictEqual(resolveStroke(input));
    expect(resolveStroke(input)).toStrictEqual(resolveStroke({ ...input }));
  });
});

describe('P5 reserved-stroke grammar (§4.4)', () => {
  it('arrow strokes resolve as bindable reserved strokes', () => {
    for (const stroke of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
      expect(isBindableStroke(stroke), stroke).toBe(true);
    }
    // Case-insensitive canonicalisation mirrors registry/resolver normalization.
    expect(normalizeStroke('arrowleft')).toBe('ArrowLeft');
    expect(normalizeStroke('ARROWRIGHT')).toBe('ArrowRight');

    const arrows = surfaceWithKeys(
      {
        ArrowLeft: verbBinding('v.left'),
        ArrowRight: verbBinding('v.right'),
        ArrowUp: verbBinding('v.up'),
        ArrowDown: verbBinding('v.down'),
      },
      {},
      ['v.left', 'v.right', 'v.up', 'v.down'],
    );
    const atRoot = (stroke: string): KeyResolution =>
      resolveStroke({
        surface: arrows,
        placePath: ['p.root'],
        pending: null,
        stroke,
        nowMs: 1000,
        keyboardOwner: 'engine',
      });

    expectDispatch(atRoot('ArrowLeft'), 'v.left', 1);
    expectDispatch(atRoot('ArrowRight'), 'v.right', 1);
    expectDispatch(atRoot('ArrowUp'), 'v.up', 1);
    expectDispatch(atRoot('ArrowDown'), 'v.down', 1);
    // The raw keyboard casing is normalized before lookup.
    expectDispatch(atRoot('arrowleft'), 'v.left', 1);
  });

  it('plus and minus resolve as bindable reserved strokes', () => {
    expect(isBindableStroke('+')).toBe(true);
    expect(isBindableStroke('-')).toBe(true);

    const zoom = surfaceWithKeys(
      { '+': verbBinding('v.zoomIn'), '-': verbBinding('v.zoomOut') },
      {},
      ['v.zoomIn', 'v.zoomOut'],
    );
    const atRoot = (stroke: string): KeyResolution =>
      resolveStroke({
        surface: zoom,
        placePath: ['p.root'],
        pending: null,
        stroke,
        nowMs: 1000,
        keyboardOwner: 'engine',
      });

    expectDispatch(atRoot('+'), 'v.zoomIn', 1);
    expectDispatch(atRoot('-'), 'v.zoomOut', 1);
  });
});
