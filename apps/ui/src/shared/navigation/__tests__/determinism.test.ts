/**
 * Spec #3117 (P3) — ST-5 determinism pairs (REQ-01.5, REQ-01.7).
 *
 * Every exported function returns a deep-equal result for identical inputs:
 * `resolveStroke`, `dispatch` (against a fresh store), the four §8 derivations and
 * `buildContextEnvelope`. A second case proves two journal stores never share state, and a
 * third proves the outputs are ordered by tree/declaration order only — reordering a place
 * declaration in the flat array (root last vs root first, siblings unchanged) does not move
 * the output order.
 */

import { describe, expect, it } from 'vitest';

import { buildContextEnvelope } from '../context';
import { deriveHint, deriveMap, derivePalette, deriveRail } from '../discover';
import { dispatch, type EngineDeps } from '../dispatch';
import { createJournalStore, type JournalStore } from '../journal';
import { createRegistry } from '../registry';
import { resolveStroke, type ResolverInput } from '../keyResolver';
import type {
  ContextSnapshot,
  Intent,
  JsonPatch,
  PlaceNode,
  Surface,
} from '../types';
import {
  makeEffect,
  makePlace,
  makeSelection,
  makeSnapshot,
  makeSurface,
  makeVerb,
  validWireframeSurface,
} from './fixtures';

const TS = '2026-01-01T00:00:00.000Z';
const CANVAS = 'wireframe.canvas';

interface Harness {
  readonly deps: EngineDeps;
  readonly journal: JournalStore;
}

/** One dependency set rooted at the surface's root (or an explicit snapshot). */
function makeHarness(surface: Surface, journal: JournalStore = createJournalStore()): Harness {
  const patches: JsonPatch[] = [];
  const deps: EngineDeps = {
    surface,
    getContext: () => makeSnapshot({ placePath: [surface.tree.root] }),
    journal,
    now: () => TS,
    applyPatch: (patch) => {
      patches.push(patch);
    },
    confirm: () => true,
  };
  return { deps, journal };
}

/** A surface with real mutation verbs (the shared fixture's default verbs do not mutate). */
function mutatingSurface(): Surface {
  return makeSurface({
    root: 'p.root',
    places: [makePlace({ id: 'p.root' })],
    verbs: [
      makeVerb({
        id: 'verb.write',
        title: 'Write',
        run: () =>
          makeEffect({
            label: 'Write',
            patch: { before: { n: 0 }, after: { n: 1 } },
            inverse: { n: 0 },
            target: [],
          }),
      }),
    ],
  });
}

function intent(verbId: string): Intent {
  return { verbId, args: {}, channel: 'keyboard', actor: 'human' };
}

/** A four-place tree used by the reordering proof. */
function surfaceWithPlaceOrder(rootFirst: boolean): Surface {
  const root = makePlace({
    id: 'p.root',
    parent: null,
    keys: { a: { kind: 'verb', verbId: 'verb.a' } },
  });
  const childA = makePlace({
    id: 'p.a',
    parent: 'p.root',
    keys: { b: { kind: 'verb', verbId: 'verb.b' } },
  });
  const childB = makePlace({
    id: 'p.b',
    parent: 'p.root',
    keys: { c: { kind: 'verb', verbId: 'verb.c' } },
  });
  const places: readonly PlaceNode[] = rootFirst
    ? [root, childA, childB]
    : [childA, childB, root];

  return makeSurface({
    root: 'p.root',
    places,
    verbs: [
      makeVerb({ id: 'verb.a', title: 'A' }),
      makeVerb({ id: 'verb.b', title: 'B' }),
      makeVerb({ id: 'verb.c', title: 'C' }),
    ],
  });
}

describe('determinism (REQ-01.5)', () => {
  it('identical inputs produce deep-equal results', async () => {
    const surface = validWireframeSurface();
    const snapshot = makeSnapshot({
      appId: 'wireframe',
      placePath: [CANVAS, 'wireframe.create'],
      selection: makeSelection({ count: 1, kinds: ['element'], ids: ['element-1'] }),
    });

    // 1. resolveStroke — same input object, then a structural clone.
    const resolverInput: ResolverInput = {
      surface,
      placePath: [CANVAS, 'wireframe.create'],
      pending: null,
      stroke: 'r',
      nowMs: 1000,
      keyboardOwner: 'engine',
    };
    const firstResolution = resolveStroke(resolverInput);
    expect(resolveStroke(resolverInput)).toStrictEqual(firstResolution);
    expect(resolveStroke({ ...resolverInput })).toStrictEqual(firstResolution);

    // 2. dispatch against a FRESH store each time — entries carry the same seq/ts.
    const firstHarness = makeHarness(mutatingSurface());
    const secondHarness = makeHarness(mutatingSurface());
    const firstResult = await dispatch(firstHarness.deps, intent('verb.write'));
    const secondResult = await dispatch(secondHarness.deps, intent('verb.write'));
    expect(firstResult).toStrictEqual(secondResult);
    expect(firstHarness.journal.entries()).toStrictEqual(secondHarness.journal.entries());

    // 3. The four §8 derivations.
    const recents = ['app.palette', 'app.map', 'place.rect'];
    expect(deriveRail(surface, snapshot)).toStrictEqual(deriveRail(surface, snapshot));
    expect(deriveMap(surface)).toStrictEqual(deriveMap(surface));
    expect(derivePalette(surface, snapshot, recents)).toStrictEqual(
      derivePalette(surface, snapshot, recents),
    );
    expect(deriveHint(surface, snapshot, null)).toStrictEqual(
      deriveHint(surface, snapshot, null),
    );
    expect(
      deriveHint(surface, snapshot, { sequence: 'w', armedAtMs: 1000 }),
    ).toStrictEqual(deriveHint(surface, snapshot, { sequence: 'w', armedAtMs: 1000 }));

    // 4. buildContextEnvelope — same arguments, deep-equal (and byte-identical) envelope.
    const entries = firstHarness.journal.entries();
    const firstEnvelope = buildContextEnvelope(surface, snapshot, entries);
    const secondEnvelope = buildContextEnvelope(surface, snapshot, entries);
    expect(secondEnvelope).toStrictEqual(firstEnvelope);
    expect(JSON.stringify(secondEnvelope)).toBe(JSON.stringify(firstEnvelope));

    // 5. Two registries built from ONE surface are independent but deep-equal.
    const registryA = createRegistry(surface);
    const registryB = createRegistry(surface);
    expect(registryA).not.toBe(registryB);
    expect([...registryA.keysByVerb.keys()]).toStrictEqual([...registryB.keysByVerb.keys()]);
    expect([...registryA.bindingsByPlace.keys()]).toStrictEqual([
      ...registryB.bindingsByPlace.keys(),
    ]);
  });

  it('two journals are independent', async () => {
    const surface = mutatingSurface();
    const journalA = createJournalStore();
    const journalB = createJournalStore();

    const harnessA = makeHarness(surface, journalA);
    await dispatch(harnessA.deps, intent('verb.write'));

    // Writing store A leaves store B completely empty.
    expect(journalA.entries()).toHaveLength(1);
    expect(journalB.entries()).toStrictEqual([]);
    expect(journalB.redo()).toStrictEqual([]);

    // The reverse direction holds too: B's own write does not appear in A.
    const harnessB = makeHarness(surface, journalB);
    await dispatch(harnessB.deps, intent('verb.write'));
    expect(journalB.entries()).toHaveLength(1);
    expect(journalA.entries()).toHaveLength(1);
    expect(journalA.entries()).not.toBe(journalB.entries());
    expect(journalA.entries()[0]?.seq).toBe(1);
    expect(journalB.entries()[0]?.seq).toBe(1);
  });

  it('reordering irrelevant declaration input does not change output order', () => {
    const rootFirst = surfaceWithPlaceOrder(true);
    const rootLast = surfaceWithPlaceOrder(false);
    const snapshot: ContextSnapshot = makeSnapshot({ placePath: ['p.root', 'p.a'] });
    const recents = ['verb.c', 'verb.b'];

    // Output order is tree order (root first, declaration order within a place) — the
    // flat array position of the root declaration is irrelevant.
    const map = deriveMap(rootFirst);
    expect(map.map((row) => row.placePath)).toStrictEqual([
      ['p.root'],
      ['p.root', 'p.a'],
      ['p.root', 'p.b'],
    ]);
    expect(deriveMap(rootLast)).toStrictEqual(map);

    expect(deriveRail(rootLast, snapshot)).toStrictEqual(deriveRail(rootFirst, snapshot));
    expect(derivePalette(rootLast, snapshot, recents)).toStrictEqual(
      derivePalette(rootFirst, snapshot, recents),
    );
    expect(deriveHint(rootLast, snapshot, null)).toStrictEqual(
      deriveHint(rootFirst, snapshot, null),
    );
    expect(buildContextEnvelope(rootLast, snapshot, [])).toStrictEqual(
      buildContextEnvelope(rootFirst, snapshot, []),
    );
  });
});
