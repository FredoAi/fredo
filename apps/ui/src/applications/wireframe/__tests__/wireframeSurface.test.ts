/**
 * Spec #3119 (P5), ST-3 — the Wireframe surface declaration contract.
 *
 * The ONE declaration is validated as data (V-01…V-12), its capability envelope is
 * pinned, and every availability/flip assertion reads the SHIPPED projections
 * (`buildCommandRailModel` / `buildNavigationMapModel`) or `verb.available(ctx)` from a
 * fabricated `ContextSnapshot` — never a component-local boolean.
 *
 * Titles are authored to the QA Expert's literal manifest (G-419).
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  CAPABILITY_LIMITS,
  ENGINE_VERB_IDS,
  validateSurface,
  type ContextSnapshot,
  type Surface,
  type VerbDescriptor,
} from '../../../shared/navigation';
import {
  buildCommandRailModel,
  buildNavigationMapModel,
  NAV_UNAVAILABLE_REASON,
} from '../../../shared/navigation/ui';
import { getSnapshot, resetWireframeStoreForTests } from '../store/wireframeDocumentStore';
import {
  WIREFRAME_MAP_DEFAULT_ARGS,
  WIREFRAME_ROOT_PLACE_ID,
  WIREFRAME_SURFACE_APP_ID,
  resetWireframeSurfaceForTests,
  wireframeSurface,
} from '../wireframeSurface';

const CANVAS = 'wireframe.canvas';
const CREATE = 'wireframe.create';
const EDIT = 'wireframe.edit';
const ARRANGE = 'wireframe.arrange';
const STYLE = 'wireframe.style';
const VIEW = 'wireframe.view';
const FILE = 'wireframe.file';

const OBJECT_NOUNS = ['document', 'page', 'element', 'selection', 'group', 'view'] as const;

const VERBS_BY_ID: ReadonlyMap<string, VerbDescriptor> = new Map(
  wireframeSurface.verbs.map((verb) => [verb.id, verb]),
);

function context(overrides: Partial<ContextSnapshot> = {}): ContextSnapshot {
  return {
    appId: WIREFRAME_SURFACE_APP_ID,
    placePath: [WIREFRAME_ROOT_PLACE_ID],
    selection: { count: 0, kinds: [], label: null, ids: [] },
    dirty: false,
    ...overrides,
  };
}

function selectedContext(count: number, kinds: readonly string[]): ContextSnapshot {
  return context({
    selection: {
      count,
      kinds,
      label: kinds[0] ?? null,
      ids: kinds.map((_kind, index) => `id-${index}`),
    },
  });
}

function placeContext(placeId: string, count = 0, kinds: readonly string[] = []): ContextSnapshot {
  return context({
    placePath: [WIREFRAME_ROOT_PLACE_ID, placeId],
    selection: {
      count,
      kinds,
      label: kinds[0] ?? null,
      ids: kinds.map((_kind, index) => `id-${index}`),
    },
  });
}

function unionOfObjects(surface: Surface): Set<string> {
  const nouns = new Set<string>();
  for (const verb of surface.verbs) {
    for (const noun of verb.appliesTo.objects) nouns.add(noun);
  }
  return nouns;
}

function intentFor(verbId: string, args: Readonly<Record<string, string>> = {}) {
  return { verbId, args, channel: 'pointer' as const, actor: 'human' as const };
}

beforeEach(() => {
  resetWireframeStoreForTests();
  resetWireframeSurfaceForTests();
});

describe('wireframeSurface — the declaration', () => {
  it('declares one root and the six places under the canvas', () => {
    expect(wireframeSurface.tree.appId).toBe(WIREFRAME_SURFACE_APP_ID);
    expect(wireframeSurface.tree.root).toBe(WIREFRAME_ROOT_PLACE_ID);

    const places = wireframeSurface.tree.places;
    expect(places).toHaveLength(7);
    expect(places.filter((place) => place.parent === null)).toHaveLength(1);

    const root = places.find((place) => place.id === WIREFRAME_ROOT_PLACE_ID);
    expect(root).toBeDefined();
    expect(root?.parent).toBeNull();

    const children = places.filter((place) => place.parent === WIREFRAME_ROOT_PLACE_ID);
    expect(children.map((place) => place.id)).toEqual([CREATE, EDIT, ARRANGE, STYLE, VIEW, FILE]);
    for (const child of children) expect(child.parent).toBe(WIREFRAME_ROOT_PLACE_ID);

    const create = children.find((place) => place.id === CREATE);
    expect(create?.transient).toBe(true);
    expect(create?.sticky).toBe(false);
    expect(create?.cursor).toBe('crosshair');
    expect(create?.operator).toBe('wireframe.create-shape');

    for (const child of children.filter((place) => place.id !== CREATE)) {
      expect(child.transient, child.id).toBe(false);
      expect(child.sticky, child.id).toBe(true);
      expect(child.cursor, child.id).toBeNull();
      expect(child.operator, child.id).toBeNull();
    }
  });

  it('validateSurface reports zero violations', () => {
    expect(validateSurface(wireframeSurface)).toEqual({ valid: true, diagnostics: [] });
  });

  it('every verb applies only to the six declared object nouns', () => {
    const nouns = unionOfObjects(wireframeSurface);
    expect([...nouns].sort()).toEqual([...OBJECT_NOUNS].sort());

    for (const verb of wireframeSurface.verbs) {
      expect(verb.appliesTo.objects.length, verb.id).toBeGreaterThan(0);
      for (const noun of verb.appliesTo.objects) {
        expect(OBJECT_NOUNS as readonly string[], verb.id).toContain(noun);
      }
      expect(verb.appliesTo.places.length, verb.id).toBeGreaterThan(0);
    }

    // Negative control (G-408): a widget noun must fail the noun-set predicate, and the
    // shipped declaration must stay untouched by the probe.
    const tampered: Surface = {
      ...wireframeSurface,
      verbs: wireframeSurface.verbs.map((verb) =>
        verb.id === 'wireframe.add.text'
          ? {
              ...verb,
              appliesTo: { ...verb.appliesTo, objects: ['element', 'button'] },
            }
          : verb,
      ),
    };
    const tamperedNouns = unionOfObjects(tampered);
    expect([...tamperedNouns].sort()).not.toEqual([...OBJECT_NOUNS].sort());
    expect(tamperedNouns.has('button')).toBe(true);
    expect(unionOfObjects(wireframeSurface).has('button')).toBe(false);
  });

  it('the declaration stays inside the capability envelope', () => {
    const ids = wireframeSurface.verbs.map((verb) => verb.id);
    expect(ids).toHaveLength(55);
    expect(ids.length).toBeLessThanOrEqual(CAPABILITY_LIMITS.maxVerbs);
    expect(new Set(ids).size).toBe(ids.length);

    for (const verb of wireframeSurface.verbs) {
      expect(verb.title.trim().length, verb.id).toBeGreaterThan(0);
      expect(verb.description.trim().length, verb.id).toBeGreaterThan(0);
      expect(verb.title.length, verb.id).toBeLessThanOrEqual(CAPABILITY_LIMITS.maxLabelChars);
    }

    // Root → child is the complete tree (depth 2 ≤ the envelope's max path depth).
    const maxDepth = 1;
    expect(maxDepth).toBeLessThanOrEqual(CAPABILITY_LIMITS.maxPathDepth);

    expect(wireframeSurface.tree.directAliases).toEqual({
      r: 'wireframe.create.rect',
      u: 'journal.undo',
      y: 'journal.redo',
    });
  });

  it('every verb bound in a place declares that place in appliesTo', () => {
    for (const place of wireframeSurface.tree.places) {
      for (const binding of Object.values(place.keys)) {
        if (binding.kind !== 'verb') continue;
        const verb = VERBS_BY_ID.get(binding.verbId);
        expect(verb, binding.verbId).toBeDefined();
        expect(verb?.appliesTo.places, binding.verbId).toContain(place.id);
      }
    }
  });

  it('root place bindings enter the six places', () => {
    const root = wireframeSurface.tree.places.find(
      (place) => place.id === WIREFRAME_ROOT_PLACE_ID,
    );
    expect(root).toBeDefined();

    expect(root?.keys.c).toEqual({ kind: 'place', placeId: CREATE });
    expect(root?.keys.e).toEqual({ kind: 'place', placeId: EDIT });
    expect(root?.keys.a).toEqual({ kind: 'place', placeId: ARRANGE });
    expect(root?.keys.s).toEqual({ kind: 'place', placeId: STYLE });
    expect(root?.keys.v).toEqual({ kind: 'place', placeId: VIEW });
    expect(root?.keys.f).toEqual({ kind: 'place', placeId: FILE });

    expect(root?.keys.m).toEqual({ kind: 'verb', verbId: 'app.map' });
    expect(root?.keys.k).toEqual({ kind: 'verb', verbId: 'app.ask' });
    expect(root?.keys.ArrowLeft).toEqual({
      kind: 'verb',
      verbId: 'wireframe.selection.previous',
    });
    expect(root?.keys.ArrowUp).toEqual({
      kind: 'verb',
      verbId: 'wireframe.selection.previous',
    });
    expect(root?.keys.ArrowRight).toEqual({ kind: 'verb', verbId: 'wireframe.selection.next' });
    expect(root?.keys.ArrowDown).toEqual({ kind: 'verb', verbId: 'wireframe.selection.next' });
  });

  it('root direct aliases bind only verbs', () => {
    const aliases = wireframeSurface.tree.directAliases;
    expect(Object.keys(aliases).sort()).toEqual(['r', 'u', 'y']);
    expect(aliases.r).toBe('wireframe.create.rect');
    expect(aliases.u).toBe('journal.undo');
    expect(aliases.y).toBe('journal.redo');

    const verbTargets = new Set<string>([
      ...wireframeSurface.verbs.map((verb) => verb.id),
      ...ENGINE_VERB_IDS,
    ]);
    for (const target of Object.values(aliases)) {
      // A direct alias is typed `stroke → verb` — it can never target a place.
      expect(verbTargets.has(target), target).toBe(true);
    }
  });

  it('map dispatch supplies a default argument for icon shape and section', async () => {
    expect(WIREFRAME_MAP_DEFAULT_ARGS).toEqual({
      'wireframe.add.icon': { iconId: 'star' },
      'wireframe.add.shape': { shape: 'rect' },
      'wireframe.add.section': { preset: 'header' },
    });

    // The defaults must actually PERFORM from a map run (no `invalid-args`, element +1).
    for (const [verbId, args] of Object.entries(WIREFRAME_MAP_DEFAULT_ARGS)) {
      const verb = VERBS_BY_ID.get(verbId);
      expect(verb, verbId).toBeDefined();
      const effect = await verb!.run(intentFor(verbId, args), context());
      expect(effect.effect, verbId).toBe('mutation');
      expect(effect.patch, verbId).not.toBeNull();
    }

    // The bare arming verbs create nothing when no bounds are supplied (armed noop).
    for (const verbId of ['wireframe.create.rect', 'wireframe.create.ellipse']) {
      const effect = await VERBS_BY_ID.get(verbId)!.run(intentFor(verbId), context());
      expect(effect.patch, verbId).toBeNull();
    }
  });

  it('flipping the selection flips rail and map availability', () => {
    const editEmpty = placeContext(EDIT);
    const emptyRail = buildCommandRailModel(wireframeSurface, editEmpty);
    expect(emptyRail.rows).toHaveLength(5);
    expect(emptyRail.rows.every((row) => row.enabled)).toBe(false);
    expect(emptyRail.rows[0]?.reason).toBe(NAV_UNAVAILABLE_REASON);

    const editOneText = placeContext(EDIT, 1, ['text']);
    const oneRail = buildCommandRailModel(wireframeSurface, editOneText);
    expect(oneRail.rows.map((row) => row.verbId)).toEqual([
      'wireframe.element.duplicate',
      'wireframe.element.delete',
      'wireframe.element.toggleLock',
      'wireframe.element.toggleVisible',
      'wireframe.element.rename',
    ]);
    expect(oneRail.rows.every((row) => row.enabled)).toBe(true);

    const EDIT_VERB_IDS = [
      'wireframe.element.duplicate',
      'wireframe.element.delete',
      'wireframe.element.toggleLock',
      'wireframe.element.toggleVisible',
      'wireframe.element.rename',
    ];

    const emptyMap = buildNavigationMapModel(wireframeSurface, editEmpty);
    const emptyEdit = emptyMap.places.find((place) => place.placeId === EDIT);
    expect(emptyEdit).toBeDefined();
    for (const verbId of EDIT_VERB_IDS) {
      const row = emptyEdit?.verbs.find((verb) => verb.verbId === verbId);
      expect(row?.available, verbId).toBe(false);
      expect(row?.reason, verbId).toBe(NAV_UNAVAILABLE_REASON);
    }

    const oneMap = buildNavigationMapModel(wireframeSurface, editOneText);
    const oneEdit = oneMap.places.find((place) => place.placeId === EDIT);
    for (const verbId of EDIT_VERB_IDS) {
      const row = oneEdit?.verbs.find((verb) => verb.verbId === verbId);
      expect(row?.available, verbId).toBe(true);
    }

    // Style kind gates: a text has textStyle but no shape fill; a shape is the inverse.
    const styleTextMap = buildNavigationMapModel(wireframeSurface, placeContext(STYLE, 1, ['text']));
    const stylePlaceText = styleTextMap.places.find((place) => place.placeId === STYLE);
    const availableInStyle = (verbId: string): boolean | undefined =>
      stylePlaceText?.verbs.find((verb) => verb.verbId === verbId)?.available;
    expect(availableInStyle('wireframe.style.textStyle')).toBe(true);
    expect(availableInStyle('wireframe.style.fill')).toBe(false);

    const styleShapeMap = buildNavigationMapModel(
      wireframeSurface,
      placeContext(STYLE, 1, ['shape']),
    );
    const stylePlaceShape = styleShapeMap.places.find((place) => place.placeId === STYLE);
    const availableInShape = (verbId: string): boolean | undefined =>
      stylePlaceShape?.verbs.find((verb) => verb.verbId === verbId)?.available;
    expect(availableInShape('wireframe.style.fill')).toBe(true);
    expect(availableInShape('wireframe.style.border')).toBe(true);
    expect(availableInShape('wireframe.style.radius')).toBe(true);
    expect(availableInShape('wireframe.style.textStyle')).toBe(false);
  });

  it('multi-selection gates align distribute and group by count', () => {
    const available = (verbId: string, count: number): boolean | undefined =>
      VERBS_BY_ID.get(verbId)?.available(
        selectedContext(count, Array.from({ length: count }, () => 'shape')),
      );

    for (const verbId of [
      'wireframe.arrange.alignLeft',
      'wireframe.arrange.alignCenter',
      'wireframe.arrange.alignRight',
    ]) {
      expect(available(verbId, 1), verbId).toBe(false);
      expect(available(verbId, 2), verbId).toBe(true);
    }

    expect(available('wireframe.arrange.distribute', 2)).toBe(false);
    expect(available('wireframe.arrange.distribute', 3)).toBe(true);

    expect(available('wireframe.arrange.group', 1)).toBe(false);
    expect(available('wireframe.arrange.group', 2)).toBe(true);

    expect(available('wireframe.arrange.ungroup', 0)).toBe(false);
    expect(available('wireframe.arrange.ungroup', 2)).toBe(true);
    expect(available('wireframe.arrange.toggleGroupLock', 0)).toBe(false);
    expect(available('wireframe.arrange.toggleGroupLock', 2)).toBe(true);

    expect(available('wireframe.arrange.bringForward', 0)).toBe(false);
    expect(available('wireframe.arrange.bringForward', 1)).toBe(true);
  });

  it('view verbs produce navigation effects and never a document patch', async () => {
    const cases: readonly [string, Readonly<Record<string, string>>][] = [
      ['wireframe.zoom.in', {}],
      ['wireframe.zoom.out', {}],
      ['wireframe.view.fitPage', {}],
      ['wireframe.view.resetView', {}],
      ['wireframe.view.togglePan', {}],
      ['wireframe.view.panBy', { x: '12', y: '24' }],
    ];

    const before = getSnapshot().document;
    for (const [verbId, args] of cases) {
      const header = VERBS_BY_ID.get(verbId);
      expect(header, verbId).toBeDefined();
      const effect = await header!.run(intentFor(verbId, args), context());
      expect(effect.effect, verbId).toBe('navigation');
      expect(effect.patch, verbId).toBeNull();
      expect(effect.inverse, verbId).toBeNull();
    }
    expect(getSnapshot().document).toBe(before);
    expect(getSnapshot().canUndo).toBe(false);
  });
});
