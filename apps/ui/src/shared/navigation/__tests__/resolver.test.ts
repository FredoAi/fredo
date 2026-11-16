/**
 * Spec #3117 (P3) — ST-1 resolver + registry proofs.
 *
 * Covers REQ-02.15 (stroke grammar), REQ-02.14 (place locality, registry side),
 * REQ-03.1 (the published §4.2 key map) and the pure tree lookups the engine reads.
 * Every title the #3117 QA Plan cites for this module is verbatim.
 */

import { describe, expect, it } from 'vitest';

import { createRegistry } from '../registry';
import {
  childPlaceOf,
  continuationStrokes,
  getPlace,
  getVerb,
  isBindableStroke,
  isStrictStrokePrefix,
  normalizeStroke,
  resolvePlacePath,
  serializeStrokes,
  splitStrokes,
} from '../resolver';
import type { KeyBinding, PlaceNode, VerbDescriptor } from '../types';
import { makePlace, makeSurface, makeVerb, validWireframeSurface } from './fixtures';

function verbBinding(verbId: string): KeyBinding {
  return { kind: 'verb', verbId };
}

function targetAt(
  reg: ReturnType<typeof createRegistry>,
  placeId: string,
  stroke: string,
): readonly string[] {
  const bindings = reg.bindingsByPlace.get(placeId)?.get(stroke) ?? [];
  return bindings.map((binding) => (binding.kind === 'verb' ? binding.verbId : binding.placeId));
}

describe('stroke grammar (§4.4)', () => {
  it('normalizes a stroke to one lowercase token', () => {
    expect(normalizeStroke('W')).toBe('w');
    expect(normalizeStroke(' c ')).toBe('c');
    expect(normalizeStroke('C')).toBe('c');
    expect(normalizeStroke('7')).toBe('7');
    expect(normalizeStroke('Escape')).toBe('Escape');
    expect(normalizeStroke('escape')).toBe('Escape');
  });

  it('serializes strokes with a single space', () => {
    expect(serializeStrokes(['c', 'r'])).toBe('c r');
    expect(serializeStrokes(['c', '', 'r'])).toBe('c r');
    expect(serializeStrokes([' c ', '  r '])).toBe('c r');
    expect(serializeStrokes(['w', 'n'])).toBe('w n');
    expect(splitStrokes('c  r')).toStrictEqual(['c', 'r']);
  });

  it('rejects non-bindable tokens and ? and /', () => {
    expect(normalizeStroke('')).toBeNull();
    expect(normalizeStroke('   ')).toBeNull();
    expect(normalizeStroke('cr')).toBeNull();
    expect(normalizeStroke('?')).toBeNull();
    expect(normalizeStroke('/')).toBeNull();
    expect(normalizeStroke('ctrl+c')).toBeNull();
    expect(isBindableStroke('?')).toBe(false);
    expect(isBindableStroke('/')).toBe(false);
    expect(isBindableStroke('cr')).toBe(false);
    expect(isBindableStroke('Escape')).toBe(true);
    expect(isBindableStroke('Enter')).toBe(true);
    expect(isBindableStroke('Tab')).toBe(true);
    expect(isBindableStroke('w')).toBe(true);
    expect(isBindableStroke('9')).toBe(true);
  });

  it('recognizes token-boundary strict prefixes only', () => {
    expect(isStrictStrokePrefix('g', 'g i')).toBe(true);
    expect(isStrictStrokePrefix('w', 'w n')).toBe(true);
    expect(isStrictStrokePrefix('g i', 'g i x')).toBe(true);
    expect(isStrictStrokePrefix('g i', 'g')).toBe(false);
    expect(isStrictStrokePrefix('g', 'gi')).toBe(false);
    expect(isStrictStrokePrefix('g', 'g')).toBe(false);
  });
});

describe('pure tree lookups (§2, §4.1)', () => {
  const surface = validWireframeSurface();
  const reg = createRegistry(surface);

  it('resolves a place path root to current', () => {
    expect(resolvePlacePath(reg, 'wireframe.canvas')).toStrictEqual(['wireframe.canvas']);
    expect(resolvePlacePath(reg, 'wireframe.create')).toStrictEqual([
      'wireframe.canvas',
      'wireframe.create',
    ]);
    expect(resolvePlacePath(reg, 'wireframe.file')).toStrictEqual([
      'wireframe.canvas',
      'wireframe.file',
    ]);
    expect(resolvePlacePath(reg, 'wireframe.unknown')).toStrictEqual([]);
  });

  it('returns null for an unknown place or verb', () => {
    expect(getPlace(reg, 'wireframe.canvas')?.id).toBe('wireframe.canvas');
    expect(getPlace(reg, 'wireframe.unknown')).toBeNull();
    expect(getVerb(reg, 'place.rect')?.id).toBe('place.rect');
    expect(getVerb(reg, 'place.unknown')).toBeNull();
  });

  it('finds the child place bound by a place key', () => {
    const placeSurface = makeSurface({
      root: 'p.root',
      places: [
        makePlace({ id: 'p.root', keys: { e: { kind: 'place', placeId: 'p.child' } } }),
        makePlace({ id: 'p.child', parent: 'p.root' }),
      ],
      verbs: [],
    });
    const placeReg = createRegistry(placeSurface);
    expect(childPlaceOf(placeReg, 'p.root', 'e')).toBe('p.child');
    expect(childPlaceOf(placeReg, 'p.root', 'E')).toBe('p.child');
    expect(childPlaceOf(placeReg, 'p.root', 'x')).toBeNull();
    expect(childPlaceOf(placeReg, 'p.child', 'e')).toBeNull();
  });

  it('lists continuation strokes in declaration order', () => {
    expect(continuationStrokes(reg, 'wireframe.canvas', 'w')).toStrictEqual(['n', 'p']);
    expect(continuationStrokes(reg, 'wireframe.canvas', 'c')).toStrictEqual([]);
    expect(continuationStrokes(reg, 'wireframe.canvas', 'w n')).toStrictEqual([]);
    expect(continuationStrokes(reg, 'wireframe.unknown', 'w')).toStrictEqual([]);
  });
});

describe('registry indexes (§4.1)', () => {
  it('fixture declares the published key map', () => {
    const surface = validWireframeSurface();
    const reg = createRegistry(surface);

    expect(surface.tree.appId).toBe('wireframe');
    expect(surface.tree.root).toBe('wireframe.canvas');

    expect(targetAt(reg, 'wireframe.canvas', 'c')).toStrictEqual(['place.create']);
    expect(targetAt(reg, 'wireframe.canvas', 'i')).toStrictEqual(['place.edit']);
    expect(targetAt(reg, 'wireframe.canvas', 'a')).toStrictEqual(['place.arrange']);
    expect(targetAt(reg, 'wireframe.canvas', 's')).toStrictEqual(['place.style']);
    expect(targetAt(reg, 'wireframe.canvas', 'v')).toStrictEqual(['place.view']);
    expect(targetAt(reg, 'wireframe.canvas', 'f')).toStrictEqual(['place.file']);
    expect(targetAt(reg, 'wireframe.canvas', 'm')).toStrictEqual(['app.map']);
    expect(targetAt(reg, 'wireframe.canvas', 'k')).toStrictEqual(['app.ask']);
    expect(targetAt(reg, 'wireframe.canvas', 'p')).toStrictEqual(['app.palette']);
    expect(targetAt(reg, 'wireframe.canvas', 'w n')).toStrictEqual(['window.focusNext']);
    expect(targetAt(reg, 'wireframe.canvas', 'w p')).toStrictEqual(['window.focusPrevious']);

    expect(targetAt(reg, 'wireframe.create', 'r')).toStrictEqual(['place.rect']);
    expect(targetAt(reg, 'wireframe.create', 'e')).toStrictEqual(['place.ellipse']);
    expect(targetAt(reg, 'wireframe.create', 't')).toStrictEqual(['place.text']);
    expect(targetAt(reg, 'wireframe.create', 'b')).toStrictEqual(['place.button']);

    expect(targetAt(reg, 'wireframe.edit', 'a')).toStrictEqual(['place.selectAll']);
    expect(targetAt(reg, 'wireframe.edit', 'd')).toStrictEqual(['place.duplicate']);
    expect(targetAt(reg, 'wireframe.edit', 'x')).toStrictEqual(['place.delete']);
    expect(targetAt(reg, 'wireframe.edit', 'l')).toStrictEqual(['place.toggleLock']);

    expect(targetAt(reg, 'wireframe.arrange', 'l')).toStrictEqual(['place.alignLeft']);
    expect(targetAt(reg, 'wireframe.arrange', 'c')).toStrictEqual(['place.alignCenter']);
    expect(targetAt(reg, 'wireframe.arrange', 'z')).toStrictEqual(['place.alignRight']);
    expect(targetAt(reg, 'wireframe.arrange', 'd')).toStrictEqual(['place.distribute']);
    expect(targetAt(reg, 'wireframe.arrange', 'g')).toStrictEqual(['place.group']);
    expect(targetAt(reg, 'wireframe.arrange', 'n')).toStrictEqual(['place.ungroup']);
    expect(targetAt(reg, 'wireframe.arrange', 'f')).toStrictEqual(['place.bringForward']);
    expect(targetAt(reg, 'wireframe.arrange', 'b')).toStrictEqual(['place.sendBackward']);

    expect(targetAt(reg, 'wireframe.style', 'f')).toStrictEqual(['place.setFill']);
    expect(targetAt(reg, 'wireframe.style', 'c')).toStrictEqual(['place.copyStyle']);
    expect(targetAt(reg, 'wireframe.style', 'x')).toStrictEqual(['place.resetStyle']);

    expect(targetAt(reg, 'wireframe.view', 'i')).toStrictEqual(['place.zoomIn']);
    expect(targetAt(reg, 'wireframe.view', 'o')).toStrictEqual(['place.zoomOut']);
    expect(targetAt(reg, 'wireframe.view', 'n')).toStrictEqual(['place.fitPage']);
    expect(targetAt(reg, 'wireframe.view', 'h')).toStrictEqual(['place.togglePan']);

    expect(targetAt(reg, 'wireframe.file', 's')).toStrictEqual(['place.save']);
    expect(targetAt(reg, 'wireframe.file', 'a')).toStrictEqual(['place.saveAs']);
    expect(targetAt(reg, 'wireframe.file', 'o')).toStrictEqual(['place.open']);
    expect(targetAt(reg, 'wireframe.file', 'x')).toStrictEqual(['place.exportPng']);
    expect(targetAt(reg, 'wireframe.file', 'n')).toStrictEqual(['wireframe.document.new']);

    expect(surface.tree.directAliases).toStrictEqual({
      r: 'place.rect',
      e: 'place.ellipse',
      u: 'journal.undo',
      y: 'journal.redo',
    });

    // `w` is deliberately unbound, so the prefix is reachable and V-11 stays satisfiable.
    expect(targetAt(reg, 'wireframe.canvas', 'w')).toStrictEqual([]);
    expect(continuationStrokes(reg, 'wireframe.canvas', 'w')).toStrictEqual(['n', 'p']);

    const byId = new Map<string, PlaceNode>(surface.tree.places.map((place) => [place.id, place]));
    expect(byId.get('wireframe.canvas')?.parent).toBeNull();
    expect(byId.get('wireframe.create')?.transient).toBe(true);
    expect(byId.get('wireframe.create')?.sticky).toBe(false);
    for (const id of [
      'wireframe.edit',
      'wireframe.arrange',
      'wireframe.style',
      'wireframe.view',
      'wireframe.file',
    ]) {
      expect(byId.get(id)?.sticky).toBe(true);
      expect(byId.get(id)?.transient).toBe(false);
    }
  });

  it('indexes normalized bindings and keeps every ambiguous binding', () => {
    const ambiguous = makeSurface({
      root: 'p.root',
      places: [
        makePlace({
          id: 'p.root',
          keys: {
            c: verbBinding('verb.one'),
            'c ': verbBinding('verb.two'),
          },
        }),
      ],
      verbs: [makeVerb({ id: 'verb.one' }), makeVerb({ id: 'verb.two' })],
    });
    const reg = createRegistry(ambiguous);
    expect(targetAt(reg, 'p.root', 'c')).toStrictEqual(['verb.one', 'verb.two']);
    // keysByVerb is indexed by the SAME normalization.
    expect(reg.keysByVerb.get('verb.one')).toStrictEqual(['c']);
    expect(reg.keysByVerb.get('verb.two')).toStrictEqual(['c']);
  });

  it('createRegistry builds independent indexes', () => {
    const surface = validWireframeSurface();
    const first = createRegistry(surface);
    const second = createRegistry(surface);
    expect(first).not.toBe(second);
    expect(first.bindingsByPlace).not.toBe(second.bindingsByPlace);
    expect(first.placesById).not.toBe(second.placesById);
    expect([...first.bindingsByPlace.keys()]).toStrictEqual([...second.bindingsByPlace.keys()]);
    expect(first.rootId).toBe(second.rootId);
  });
});

describe('determinism (REQ-01.5)', () => {
  it('identical declarations produce deep-equal indexes', () => {
    const a = createRegistry(validWireframeSurface());
    const b = createRegistry(validWireframeSurface());
    const snapshot = (reg: ReturnType<typeof createRegistry>): unknown => ({
      rootId: reg.rootId,
      places: [...reg.placesById.keys()],
      children: [...reg.childrenByParent.entries()],
      verbs: [...reg.verbsById.keys()],
      bindings: [...reg.bindingsByPlace.entries()].map(([place, perPlace]) => [
        place,
        [...perPlace.entries()],
      ]),
      aliases: [...reg.aliasByStroke.entries()],
      keysByVerb: [...reg.keysByVerb.entries()],
    });
    expect(snapshot(a)).toStrictEqual(snapshot(b));
  });
});

describe('verb descriptors (§3)', () => {
  it('every published verb carries a risk and a non-empty description', () => {
    const verbs: readonly VerbDescriptor[] = validWireframeSurface().verbs;
    for (const verb of verbs) {
      expect(verb.risk).toMatch(/^(safe|mutating|destructive|external)$/);
      expect(verb.description.trim().length).toBeGreaterThan(0);
      expect(verb.title.length).toBeLessThanOrEqual(24);
      expect(verb.appliesTo.places.length + verb.appliesTo.objects.length).toBeGreaterThan(0);
    }
  });
});
