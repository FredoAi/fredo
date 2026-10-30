/**
 * Spec #3117 (P3) — ST-3 §8 discovery-derivation proofs (AC7).
 *
 * Every `it()` title the #3117 QA Plan cites for REQ-07.* is verbatim. The UI/UX
 * semantic contract is asserted literally: rail = bound verbs only (never padded),
 * palette = recents then tree order with no duplicate verb id, hint = prefix 250 ms /
 * next three, tooltip = title + keys + risk and never `?` or `/`.
 */

import { describe, expect, it } from 'vitest';

import {
  HINT_NEXT_COUNT,
  PALETTE_MAX_RECENTS,
  RAIL_MAX_ROWS,
  RAIL_MIN_ROWS,
  deriveHint,
  deriveMap,
  derivePalette,
  deriveRail,
  formatTooltip,
  type RailModel,
} from '../discover';
import {
  PENDING_TIMEOUT_MS,
  type KeyBinding,
  type Surface,
} from '../types';
import {
  makePlace,
  makeSelection,
  makeSnapshot,
  makeSurface,
  makeVerb,
  validWireframeSurface,
} from './fixtures';

const CANVAS = 'wireframe.canvas';
const CREATE = 'wireframe.create';

function verbBinding(verbId: string): KeyBinding {
  return { kind: 'verb', verbId };
}

/** A root place binding `count` distinct verbs to `a`, `b`, … in declaration order. */
function railSurface(count: number): Surface {
  const verbs = Array.from({ length: count }, (_, index) =>
    makeVerb({ id: `v.${index}`, title: `Verb ${index}` }),
  );
  const keys: Record<string, KeyBinding> = {};
  verbs.forEach((verb, index) => {
    keys[String.fromCharCode(97 + index)] = verbBinding(verb.id);
  });
  return makeSurface({ root: 'p.root', places: [makePlace({ id: 'p.root', keys })], verbs });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/** One declaration used to prove a mutation moves every projection. */
function mutationSurface(
  keys: Readonly<Record<string, KeyBinding>>,
  alphaTitle: string,
  betaTitle: string,
): Surface {
  return makeSurface({
    root: 'p.root',
    places: [makePlace({ id: 'p.root', keys })],
    verbs: [
      makeVerb({
        id: 'v.alpha',
        title: alphaTitle,
        appliesTo: { objects: ['page'], places: ['p.root'] },
      }),
      makeVerb({
        id: 'v.beta',
        title: betaTitle,
        appliesTo: { objects: ['page'], places: ['p.root'] },
      }),
      makeVerb({
        id: 'v.gamma',
        title: 'Gamma',
        appliesTo: { objects: ['page'], places: ['p.root'] },
      }),
    ],
  });
}

describe('deriveRail', () => {
  it('rail is current-place rows capped at eight with overflow', () => {
    const surface = validWireframeSurface();
    const model = deriveRail(surface, makeSnapshot({ placePath: [CANVAS] }));

    expect(RAIL_MAX_ROWS).toBe(8);
    expect(RAIL_MIN_ROWS).toBe(4);
    expect(model.rows).toHaveLength(8);
    expect(model.rows.map((row) => row.verbId)).toStrictEqual([
      'place.create',
      'place.edit',
      'place.arrange',
      'place.style',
      'place.view',
      'place.file',
      'app.map',
      'app.ask',
    ]);
    expect(model.overflow).toBe(3);
    expect(model.rows[0]).toStrictEqual({
      verbId: 'place.create',
      title: 'Create',
      risk: 'safe',
      keys: ['c'],
      enabled: true,
      reason: null,
    });

    // A place with 0 bound rows gets 0 rows — never padded to RAIL_MIN_ROWS.
    const unbound = makeSurface({
      root: 'p.root',
      places: [makePlace({ id: 'p.root' })],
      verbs: [
        makeVerb({
          id: 'v.x',
          title: 'Unbound',
          appliesTo: { objects: ['page'], places: ['p.root'] },
        }),
      ],
    });
    expect(deriveRail(unbound, makeSnapshot({ placePath: ['p.root'] }))).toStrictEqual({
      rows: [],
      overflow: 0,
    });

    // Nine bound verbs → the first eight plus `overflow: 1`.
    const nine = deriveRail(railSurface(9), makeSnapshot({ placePath: ['p.root'] }));
    expect(nine.rows).toHaveLength(8);
    expect(nine.rows.map((row) => row.title)).toStrictEqual([
      'Verb 0',
      'Verb 1',
      'Verb 2',
      'Verb 3',
      'Verb 4',
      'Verb 5',
      'Verb 6',
      'Verb 7',
    ]);
    expect(nine.overflow).toBe(1);

    // An unavailable verb keeps its row (no shrink, no reorder).
    const disabled = makeSurface({
      root: 'p.root',
      places: [makePlace({ id: 'p.root', keys: { x: verbBinding('v.off') } })],
      verbs: [
        makeVerb({
          id: 'v.off',
          title: 'Off',
          available: () => false,
          appliesTo: { objects: ['page'], places: ['p.root'] },
        }),
      ],
    });
    const disabledRow: RailModel = deriveRail(disabled, makeSnapshot({ placePath: ['p.root'] }));
    expect(disabledRow.rows[0].enabled).toBe(false);
    expect(disabledRow.rows[0].reason).toBeNull();
  });
});

describe('deriveMap', () => {
  it('map returns the whole tree in tree order', () => {
    const surface = validWireframeSurface();
    const rows = deriveMap(surface);

    expect(rows.map((row) => row.placePath[row.placePath.length - 1])).toStrictEqual([
      CANVAS,
      CREATE,
      'wireframe.edit',
      'wireframe.arrange',
      'wireframe.style',
      'wireframe.view',
      'wireframe.file',
    ]);
    expect(rows[0].placePath).toStrictEqual([CANVAS]);
    expect(rows[1].placePath).toStrictEqual([CANVAS, CREATE]);
    expect(rows[0].keys).toStrictEqual([
      'c',
      'i',
      'a',
      's',
      'v',
      'f',
      'm',
      'k',
      'p',
      'w n',
      'w p',
    ]);
    expect(rows[0].verbs).toStrictEqual(
      surface.verbs
        .filter((verb) => verb.appliesTo.places.includes(CANVAS))
        .map((verb) => verb.id),
    );
    expect(Object.keys(rows[0]).sort()).toStrictEqual(['keys', 'placePath', 'verbs']);

    // Children declared before the root in input order still render root-first.
    const reordered = makeSurface({
      root: 'p.root',
      places: [makePlace({ id: 'p.child', parent: 'p.root' }), makePlace({ id: 'p.root' })],
      verbs: [],
    });
    expect(
      deriveMap(reordered).map((row) => row.placePath[row.placePath.length - 1]),
    ).toStrictEqual(['p.root', 'p.child']);
  });
});

describe('derivePalette', () => {
  it('palette puts recents first then place groups', () => {
    const surface = validWireframeSurface();
    const rows = derivePalette(surface, makeSnapshot(), [
      'place.rect',
      'stale.id',
      'place.rect',
      'place.create',
    ]);
    const recent = rows.filter((row) => row.section === 'recent');
    const place = rows.filter((row) => row.section === 'place');

    expect(PALETTE_MAX_RECENTS).toBe(5);
    expect(recent.map((row) => row.verbId)).toStrictEqual(['place.rect', 'place.create']);
    expect(recent[0]).toStrictEqual({
      verbId: 'place.rect',
      title: 'Rectangle',
      placePath: [CANVAS, CREATE],
      key: 'r',
      risk: 'safe',
      section: 'recent',
    });
    expect(recent[1].key).toBe('c');

    // No `verbId` appears twice in the flat list.
    const ids = rows.map((row) => row.verbId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(place[0].verbId).toBe('place.edit');
    expect(place[0].placePath).toStrictEqual([CANVAS]);
    expect(Object.keys(rows[0]).sort()).toStrictEqual([
      'key',
      'placePath',
      'risk',
      'section',
      'title',
      'verbId',
    ]);

    // Dedupe + stale drop happen BEFORE the cap of five.
    const many = derivePalette(surface, makeSnapshot(), [
      'place.rect',
      'stale.id',
      'place.rect',
      'place.ellipse',
      'place.text',
      'place.button',
      'place.selectAll',
      'place.duplicate',
    ]);
    expect(
      many.filter((row) => row.section === 'recent').map((row) => row.verbId),
    ).toStrictEqual([
      'place.rect',
      'place.ellipse',
      'place.text',
      'place.button',
      'place.selectAll',
    ]);

    // Zero recents renders no `recent` rows at all.
    expect(
      derivePalette(surface, makeSnapshot(), []).some((row) => row.section === 'recent'),
    ).toBe(false);
  });
});

describe('deriveHint', () => {
  it('hint returns prefix rows with 250 ms and next three verbs', () => {
    const surface = validWireframeSurface();
    const prefix = deriveHint(surface, makeSnapshot({ placePath: [CANVAS] }), {
      sequence: 'w',
      armedAtMs: 1000,
    });

    expect(PENDING_TIMEOUT_MS).toBe(250);
    expect(prefix.kind).toBe('prefix');
    expect(prefix.readyAfterMs).toBe(250);
    expect(prefix.rows).toStrictEqual([
      { key: 'n', label: 'Focus next', verbId: 'window.focusNext' },
      { key: 'p', label: 'Focus previous', verbId: 'window.focusPrevious' },
    ]);

    // A prefix with one continuation still carries ≥ 1 row.
    const single = makeSurface({
      root: 'p.root',
      places: [
        makePlace({ id: 'p.root', keys: { 'g i': verbBinding('v.go') } }),
      ],
      verbs: [makeVerb({ id: 'v.go', title: 'Go' })],
    });
    expect(
      deriveHint(single, makeSnapshot({ placePath: ['p.root'] }), {
        sequence: 'g',
        armedAtMs: 0,
      }).rows,
    ).toStrictEqual([{ key: 'i', label: 'Go', verbId: 'v.go' }]);

    // After a verb: at most three available, non-rail verbs.
    const nextSurface = makeSurface({
      root: 'p.root',
      places: [makePlace({ id: 'p.root', keys: { a: verbBinding('v.rail') } })],
      verbs: [
        makeVerb({
          id: 'v.rail',
          title: 'Rail',
          appliesTo: { objects: ['page'], places: ['p.root'] },
        }),
        makeVerb({
          id: 'v.one',
          title: 'One',
          appliesTo: { objects: ['page'], places: ['p.root'] },
        }),
        makeVerb({
          id: 'v.two',
          title: 'Two',
          appliesTo: { objects: ['page'], places: ['p.root'] },
        }),
        makeVerb({
          id: 'v.three',
          title: 'Three',
          appliesTo: { objects: ['page'], places: ['p.root'] },
        }),
        makeVerb({
          id: 'v.four',
          title: 'Four',
          appliesTo: { objects: ['page'], places: ['p.root'] },
        }),
        makeVerb({
          id: 'v.off',
          title: 'Off',
          available: () => false,
          appliesTo: { objects: ['page'], places: ['p.root'] },
        }),
      ],
    });
    const next = deriveHint(nextSurface, makeSnapshot({ placePath: ['p.root'] }), null);
    expect(HINT_NEXT_COUNT).toBe(3);
    expect(next.kind).toBe('next');
    expect(next.readyAfterMs).toBe(0);
    expect(next.rows.map((row) => row.verbId)).toStrictEqual(['v.one', 'v.two', 'v.three']);

    // Every candidate duplicates a rail row → `rows: []` (never an empty "no suggestions").
    expect(
      deriveHint(surface, makeSnapshot({ placePath: [CANVAS, CREATE] }), null),
    ).toStrictEqual({ kind: 'next', rows: [], readyAfterMs: 0 });
  });
});

describe('formatTooltip', () => {
  it('tooltip renders title keys and risk and never ? or /', () => {
    const map = makeVerb({ id: 'app.map', title: 'Map' });
    const destructive = makeVerb({ id: 'v.delete', title: 'Delete', risk: 'destructive' });
    const external = makeVerb({ id: 'v.export', title: 'Export', risk: 'external' });

    expect(formatTooltip(map, ['m'])).toBe('Map (m)');
    expect(formatTooltip(map, ['m', 'n'])).toBe('Map (m, n)');
    expect(formatTooltip(map, [])).toBe('Map');
    expect(formatTooltip(destructive, [])).toBe('Delete — destructive');
    expect(formatTooltip(destructive, ['x'])).toBe('Delete (x) — destructive');
    expect(formatTooltip(external, ['e'])).toBe('Export (e) — external');
    expect(formatTooltip(map, ['m'])).not.toContain('safe');

    const rendered = [
      formatTooltip(map, ['m']),
      formatTooltip(map, ['m', 'n']),
      formatTooltip(map, []),
      formatTooltip(destructive, []),
      formatTooltip(destructive, ['x']),
      formatTooltip(external, ['e']),
    ];
    for (const text of rendered) {
      expect(text).not.toContain('?');
      expect(text).not.toContain('/');
    }
  });
});

describe('derivation reproducibility', () => {
  it('derivations do not mutate a deep-frozen surface', () => {
    const surface = deepFreeze(validWireframeSurface());
    const snapshot = deepFreeze(
      makeSnapshot({
        placePath: [CANVAS],
        selection: makeSelection({ count: 1, kinds: ['element'], ids: ['a'] }),
      }),
    );
    const recents: readonly string[] = deepFreeze(['place.rect', 'place.create']);
    const pending = deepFreeze({ sequence: 'w', armedAtMs: 0 });

    const treeBefore = structuredClone(surface.tree);
    const snapshotBefore = structuredClone(snapshot);

    const first = {
      rail: deriveRail(surface, snapshot),
      map: deriveMap(surface),
      palette: derivePalette(surface, snapshot, recents),
      hint: deriveHint(surface, snapshot, pending),
    };
    const second = {
      rail: deriveRail(surface, snapshot),
      map: deriveMap(surface),
      palette: derivePalette(surface, snapshot, recents),
      hint: deriveHint(surface, snapshot, pending),
    };

    expect(first).toStrictEqual(second);
    // Frozen inputs are untouched (a mutation in strict module code would have thrown).
    expect(surface.tree).toStrictEqual(treeBefore);
    expect(snapshot).toStrictEqual(snapshotBefore);
  });

  it('declaration mutation changes all four projections', () => {
    const base = mutationSurface(
      { a: verbBinding('v.alpha'), 'w n': verbBinding('v.beta') },
      'Alpha',
      'Beta',
    );
    const mutated = mutationSurface(
      { z: verbBinding('v.alpha'), 'w q': verbBinding('v.beta') },
      'Alpha renamed',
      'Beta renamed',
    );
    const snapshot = makeSnapshot({ placePath: ['p.root'] });
    const pending = { sequence: 'w', armedAtMs: 0 };

    const baseRail = deriveRail(base, snapshot);
    const mutatedRail = deriveRail(mutated, snapshot);
    expect(mutatedRail).not.toStrictEqual(baseRail);
    expect(mutatedRail.rows.map((row) => row.keys)).toStrictEqual([['z'], ['w q']]);
    expect(mutatedRail.rows.map((row) => row.title)).toStrictEqual([
      'Alpha renamed',
      'Beta renamed',
    ]);

    const baseMap = deriveMap(base);
    const mutatedMap = deriveMap(mutated);
    expect(mutatedMap).not.toStrictEqual(baseMap);
    expect(mutatedMap[0].keys).toStrictEqual(['z', 'w q']);

    const basePalette = derivePalette(base, snapshot, []);
    const mutatedPalette = derivePalette(mutated, snapshot, []);
    expect(mutatedPalette).not.toStrictEqual(basePalette);
    expect(mutatedPalette[0]).toStrictEqual({
      verbId: 'v.alpha',
      title: 'Alpha renamed',
      placePath: ['p.root'],
      key: 'z',
      risk: 'safe',
      section: 'place',
    });

    const baseHint = deriveHint(base, snapshot, pending);
    const mutatedHint = deriveHint(mutated, snapshot, pending);
    expect(mutatedHint).not.toStrictEqual(baseHint);
    expect(mutatedHint.rows).toStrictEqual([
      { key: 'q', label: 'Beta renamed', verbId: 'v.beta' },
    ]);
  });
});
