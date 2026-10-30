/**
 * Spec #3117 (P3) — ST-2 §6 journal, undo/redo, coalescing and the non-undoable copy.
 *
 * Covers REQ-05.1–05.12 and REQ-10.2. Every `it()` title the #3117 QA Plan cites for
 * `journal.test.ts` is verbatim, and every dispatch is awaited (Reading #12).
 */

import { describe, expect, it } from 'vitest';

import { dispatch, type EngineDeps } from '../dispatch';
import {
  NON_UNDOABLE_CONSEQUENCES,
  appendEntry,
  createJournalState,
  createJournalStore,
  isUndoable,
  normalizeQuery,
  queryEntries,
  renderUndoCopy,
  undoAffordance,
  type JournalEntryDraft,
  type JournalState,
  type JournalStore,
} from '../journal';
import {
  COALESCE_TS_GAP_MS,
  NOTHING_TO_UNDO,
  NOT_UNDOABLE_REASON,
  type Intent,
  type JsonPatch,
  type JournalEntry,
  type Surface,
  type VerbDescriptor,
  type VerbEffect,
} from '../types';
import {
  RecordingDocument,
  createSeededRandom,
  makeEffect,
  makePlace,
  makeSnapshot,
  makeSurface,
  makeVerb,
} from './fixtures';

const TS0 = '2026-01-01T00:00:00.000Z';
const TS400 = '2026-01-01T00:00:00.400Z';
const TS401 = '2026-01-01T00:00:00.401Z';

function iso(seconds: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
}

interface Harness {
  readonly deps: EngineDeps;
  readonly journal: JournalStore;
  readonly patches: JsonPatch[];
}

function makeHarness(
  surface: Surface,
  overrides: Partial<EngineDeps> = {},
): Harness {
  const journal = overrides.journal ?? createJournalStore();
  const patches: JsonPatch[] = [];
  const deps: EngineDeps = {
    surface,
    getContext: () => makeSnapshot({ placePath: [surface.tree.root] }),
    journal,
    now: () => TS0,
    applyPatch: (patch) => {
      patches.push(patch);
    },
    confirm: () => true,
    ...overrides,
  };
  return { deps, journal, patches };
}

function surfaceOf(verbs: readonly VerbDescriptor[]): Surface {
  return makeSurface({ root: 'p.root', places: [makePlace({ id: 'p.root' })], verbs });
}

function intent(verbId: string, overrides: Partial<Intent> = {}): Intent {
  return { verbId, args: {}, channel: 'keyboard', actor: 'human', ...overrides };
}

function draft(overrides: Partial<JournalEntryDraft> = {}): JournalEntryDraft {
  return {
    verbId: 'app.change',
    actor: 'human',
    channel: 'keyboard',
    label: 'Change',
    effect: 'mutation',
    placePath: ['p.root'],
    target: [],
    patch: { before: { n: 0 }, after: { n: 1 } },
    inverse: { n: 0 },
    external: false,
    consequence: null,
    exitedBy: 'none',
    coalesceKey: null,
    ...overrides,
  };
}

function mutationVerb(id: string, effect: VerbEffect): VerbDescriptor {
  return makeVerb({ id, run: () => effect });
}

describe('§6.1 append-only entries', () => {
  it('every state-changing dispatch appends exactly one entry', async () => {
    const mutation = mutationVerb(
      'app.m',
      makeEffect({ label: 'M', patch: { before: { n: 0 }, after: { n: 1 } }, inverse: { n: 0 } }),
    );
    const navigation = mutationVerb(
      'app.nav',
      makeEffect({ label: 'Nav', effect: 'navigation' }),
    );
    const noop = mutationVerb(
      'app.noop',
      makeEffect({ label: 'Noop', patch: null, inverse: null, target: [] }),
    );
    const harness = makeHarness(surfaceOf([mutation, navigation, noop]));

    await dispatch(harness.deps, intent('app.m'));
    expect(harness.journal.entries()).toHaveLength(1);

    await dispatch(harness.deps, intent('app.nav'));
    expect(harness.journal.entries()).toHaveLength(2);

    // Rejected and noop dispatches append nothing.
    await dispatch(harness.deps, intent('unknown.verb'));
    expect(harness.journal.entries()).toHaveLength(2);
    await dispatch(harness.deps, intent('app.noop'));
    expect(harness.journal.entries()).toHaveLength(2);
  });

  it('navigation entry has null patch and inverse', () => {
    const { entry } = appendEntry(
      createJournalState(),
      draft({
        effect: 'navigation',
        patch: { before: { n: 0 }, after: { n: 1 } },
        inverse: { n: 0 },
      }),
      TS0,
    );
    expect(entry.effect).toBe('navigation');
    expect(entry.patch).toBeNull();
    expect(entry.inverse).toBeNull();
    expect(entry.undoable).toBe(false);
  });

  it('undoable iff inverse is non-null', () => {
    const undoable = appendEntry(createJournalState(), draft({ inverse: { n: 0 } }), TS0).entry;
    expect(isUndoable(undoable)).toBe(true);
    expect(undoable.undoable).toBe(true);

    const notUndoable = appendEntry(
      createJournalState(),
      draft({ inverse: null, consequence: 'the previous state is gone.' }),
      TS0,
    ).entry;
    expect(isUndoable(notUndoable)).toBe(false);
    expect(notUndoable.undoable).toBe(false);

    // `external: true` implies undoable false and inverse null even when an inverse is declared.
    const external = appendEntry(
      createJournalState(),
      draft({ external: true, inverse: { n: 0 }, consequence: 'the file left Fredo.' }),
      TS0,
    ).entry;
    expect(external.external).toBe(true);
    expect(external.undoable).toBe(false);
    expect(external.inverse).toBeNull();
  });

  it('non-undoable entry carries a consequence sentence', () => {
    const entry = appendEntry(
      createJournalState(),
      draft({ inverse: null, consequence: 'the previous revision is not kept.' }),
      TS0,
    ).entry;
    expect(entry.consequence).toBe('the previous revision is not kept.');
    expect(entry.consequence?.trim().length).toBeGreaterThan(0);

    // An empty or missing consequence is refused for a non-undoable mutation.
    expect(() =>
      appendEntry(createJournalState(), draft({ inverse: null, consequence: '' }), TS0),
    ).toThrow();
    expect(() =>
      appendEntry(createJournalState(), draft({ inverse: null, consequence: null }), TS0),
    ).toThrow();

    // A navigation entry is not required to carry a consequence.
    expect(() =>
      appendEntry(createJournalState(), draft({ effect: 'navigation', consequence: null }), TS0),
    ).not.toThrow();
  });

  it('exitedBy records verb escape and none', async () => {
    const surface = makeSurface({
      root: 'p.root',
      places: [
        makePlace({ id: 'p.root' }),
        makePlace({ id: 'p.create', parent: 'p.root', transient: true }),
        makePlace({ id: 'p.edit', parent: 'p.root', sticky: true }),
      ],
      verbs: [
        mutationVerb(
          'place.rect',
          makeEffect({ label: 'Rect', patch: { before: { n: 0 }, after: { n: 1 } }, inverse: { n: 0 } }),
        ),
      ],
    });
    let placePath: readonly string[] = ['p.root', 'p.create'];
    const harness = makeHarness(surface, {
      getContext: () => makeSnapshot({ placePath }),
    });

    // Transient place: the completing verb records `'verb'` instead of a second navigation entry.
    placePath = ['p.root', 'p.create'];
    await dispatch(harness.deps, intent('place.rect'));
    expect(harness.journal.entries()[0].exitedBy).toBe('verb');
    expect(harness.journal.entries()[0].effect).toBe('mutation');

    // Sticky place: no pop, so `'none'`.
    placePath = ['p.root', 'p.edit'];
    await dispatch(harness.deps, intent('place.rect'));
    expect(harness.journal.entries()[1].exitedBy).toBe('none');

    // Escape in a child place: one navigation entry with `'escape'`.
    placePath = ['p.root', 'p.create'];
    const exit = await dispatch(harness.deps, intent('place.exit'));
    expect(exit.status).toBe('performed');
    const exitEntry = harness.journal.entries()[2];
    expect(exitEntry.verbId).toBe('place.exit');
    expect(exitEntry.effect).toBe('navigation');
    expect(exitEntry.exitedBy).toBe('escape');
  });
});

describe('§6.2 undo and redo', () => {
  function twoVerbSurface(): Surface {
    return surfaceOf([
      mutationVerb(
        'app.a',
        makeEffect({ label: 'A', patch: { before: { a: 0 }, after: { a: 1 } }, inverse: { a: 0 } }),
      ),
      mutationVerb(
        'app.b',
        makeEffect({ label: 'B', patch: { before: { b: 0 }, after: { b: 1 } }, inverse: { b: 0 } }),
      ),
      mutationVerb('app.nav', makeEffect({ label: 'Nav', effect: 'navigation' })),
    ]);
  }

  it('undo applies inverses newest first', async () => {
    const calls: JsonPatch[] = [];
    const harness = makeHarness(twoVerbSurface(), {
      applyPatch: (patch) => {
        calls.push(patch);
      },
    });
    await dispatch(harness.deps, intent('app.a'));
    await dispatch(harness.deps, intent('app.b'));

    const result = await dispatch(harness.deps, intent('journal.undo', { args: { count: '2' } }));
    expect(result.status).toBe('performed');
    // The two dispatch writes then the two inverses, newest first (B then A).
    expect(calls).toStrictEqual([{ a: 1 }, { b: 1 }, { b: 0 }, { a: 0 }]);
  });

  it('redo re-applies after in ascending seq', async () => {
    const calls: JsonPatch[] = [];
    const harness = makeHarness(twoVerbSurface(), {
      applyPatch: (patch) => {
        calls.push(patch);
      },
    });
    await dispatch(harness.deps, intent('app.a'));
    await dispatch(harness.deps, intent('app.b'));
    await dispatch(harness.deps, intent('journal.undo', { args: { count: '2' } }));
    expect(harness.journal.redo()).toStrictEqual([1, 2]);

    const result = await dispatch(harness.deps, intent('journal.redo'));
    expect(result.status).toBe('performed');
    expect(calls).toStrictEqual([{ a: 1 }, { b: 1 }, { b: 0 }, { a: 0 }, { a: 1 }, { b: 1 }]);
    expect(harness.journal.redo()).toStrictEqual([]);
  });

  it('new mutation clears the redo stack', async () => {
    const harness = makeHarness(twoVerbSurface());
    await dispatch(harness.deps, intent('app.a'));
    await dispatch(harness.deps, intent('app.b'));
    await dispatch(harness.deps, intent('journal.undo', { args: { count: '2' } }));
    expect(harness.journal.redo()).toStrictEqual([1, 2]);

    await dispatch(harness.deps, intent('app.a'));
    expect(harness.journal.redo()).toStrictEqual([]);

    // A navigation entry does NOT clear redo (mutation only).
    const navigationHarness = makeHarness(twoVerbSurface());
    await dispatch(navigationHarness.deps, intent('app.a'));
    await dispatch(navigationHarness.deps, intent('app.b'));
    await dispatch(navigationHarness.deps, intent('journal.undo', { args: { count: '1' } }));
    expect(navigationHarness.journal.redo()).toStrictEqual([2]);
    await dispatch(navigationHarness.deps, intent('app.nav'));
    expect(navigationHarness.journal.redo()).toStrictEqual([2]);
  });

  it('applied inverse is journaled as a system mutation', async () => {
    const harness = makeHarness(twoVerbSurface());
    await dispatch(harness.deps, intent('app.a'));
    const original = harness.journal.entries()[0];
    expect(original.actor).toBe('human');

    await dispatch(harness.deps, intent('journal.undo'));
    const entries = harness.journal.entries();
    expect(entries).toHaveLength(2);
    const inverseEntry = entries[1];
    expect(inverseEntry.actor).toBe('system');
    expect(inverseEntry.effect).toBe('mutation');
    expect(inverseEntry.verbId).toBe('app.a');
    expect(inverseEntry.undoable).toBe(true);
    expect(inverseEntry.inverse).toStrictEqual(original.patch?.after);
  });
});

describe('§6.3 coalescing', () => {
  it('entries coalesce only within key actor seq and ts gaps', () => {
    expect(COALESCE_TS_GAP_MS).toBe(400);

    const first = draft({
      coalesceKey: 'drag',
      patch: { before: { n: 0 }, after: { n: 1 } },
      inverse: { n: 0 },
    });
    const second = draft({
      coalesceKey: 'drag',
      patch: { before: { n: 1 }, after: { n: 2 } },
      inverse: { n: 1 },
    });

    // ts gap exactly 400 ⇒ coalesce.
    const withinGap = appendEntry(appendEntry(createJournalState(), first, TS0).state, second, TS400);
    expect(withinGap.state.entries).toHaveLength(1);
    expect(withinGap.entry.seq).toBe(2);
    expect(withinGap.entry.groupId).toBe('1');
    expect(withinGap.entry.patch).toStrictEqual({ before: { n: 0 }, after: { n: 2 } });
    expect(withinGap.entry.inverse).toStrictEqual({ n: 0 });

    // ts gap 401 ⇒ no coalesce.
    const beyondGap = appendEntry(appendEntry(createJournalState(), first, TS0).state, second, TS401);
    expect(beyondGap.state.entries).toHaveLength(2);

    // Different coalesceKey ⇒ no coalesce.
    const differentKey = appendEntry(
      appendEntry(createJournalState(), first, TS0).state,
      { ...second, coalesceKey: 'resize' },
      TS400,
    );
    expect(differentKey.state.entries).toHaveLength(2);

    // Different actor ⇒ no coalesce.
    const differentActor = appendEntry(
      appendEntry(createJournalState(), first, TS0).state,
      { ...second, actor: 'companion' },
      TS400,
    );
    expect(differentActor.state.entries).toHaveLength(2);

    // Seq gap 2: an intervening navigation entry (seq 2) leaves the prior coalescable mutation
    // at seq 1, so the next same-key mutation is seq 3 — gap 2, and last is navigation ⇒ no merge.
    const withNavigation = appendEntry(
      appendEntry(createJournalState(), first, TS0).state,
      draft({ effect: 'navigation', coalesceKey: 'drag' }),
      TS400,
    ).state;
    const afterIntervening = appendEntry(withNavigation, second, TS400);
    expect(afterIntervening.state.entries).toHaveLength(3);
    expect(afterIntervening.entry.seq).toBe(3);
    expect(afterIntervening.entry.groupId).toBeNull();
  });

  it('coalesced undo reverts the whole group', async () => {
    const effects: readonly VerbEffect[] = [
      makeEffect({ label: 'Drag', patch: { before: { n: 0 }, after: { n: 1 } }, inverse: { n: 0 }, coalesceKey: 'drag' }),
      makeEffect({ label: 'Drag', patch: { before: { n: 1 }, after: { n: 2 } }, inverse: { n: 1 }, coalesceKey: 'drag' }),
    ];
    let step = 0;
    const verb = makeVerb({ id: 'app.drag', run: () => effects[step++] });
    const calls: JsonPatch[] = [];
    const harness = makeHarness(surfaceOf([verb]), {
      applyPatch: (patch) => {
        calls.push(patch);
      },
    });

    await dispatch(harness.deps, intent('app.drag'));
    await dispatch(harness.deps, intent('app.drag'));

    const entries = harness.journal.entries();
    expect(entries).toHaveLength(1);
    const group = entries[0];
    expect(group.groupId).toBe('1');
    expect(group.patch).toStrictEqual({ before: { n: 0 }, after: { n: 2 } });
    expect(group.inverse).toStrictEqual({ n: 0 });

    const result = await dispatch(harness.deps, intent('journal.undo'));
    expect(result.status).toBe('performed');
    // Undo applies the GROUP's before, not just the later patch's before.
    expect(calls[calls.length - 1]).toStrictEqual({ n: 0 });
    expect(harness.journal.entries()).toHaveLength(2);
  });

  it('navigation entries never coalesce', () => {
    const nav = draft({ effect: 'navigation', coalesceKey: 'nav' });
    const state = appendEntry(createJournalState(), nav, TS0).state;
    const outcome = appendEntry(state, nav, TS400);
    expect(outcome.state.entries).toHaveLength(2);
    expect(outcome.entry.groupId).toBeNull();
    expect(outcome.state.entries.every((entry) => entry.effect === 'navigation')).toBe(true);
  });
});

describe('§6.3 non-undoable copy', () => {
  it('non-undoable verbs carry distinct consequences and not-undoable reason', () => {
    const ids = [
      'place.save',
      'place.saveAs',
      'place.open',
      'place.exportPng',
      'wireframe.document.new',
    ] as const;

    expect(Object.keys(NON_UNDOABLE_CONSEQUENCES).sort()).toStrictEqual([...ids].sort());
    const consequences = ids.map((id) => NON_UNDOABLE_CONSEQUENCES[id]);
    expect(new Set(consequences).size).toBe(5);
    for (const consequence of consequences) {
      expect(consequence.trim().length).toBeGreaterThan(0);
    }

    expect(NOT_UNDOABLE_REASON).toBe('not-undoable');
    for (const id of ids) {
      const affordance = undoAffordance(id);
      expect(affordance.disabled).toBe(true);
      expect(affordance.reason).toBe(NOT_UNDOABLE_REASON);
      expect(affordance.copy).toBe(NON_UNDOABLE_CONSEQUENCES[id]);
    }

    // An undoable verb keeps an enabled affordance and no authored copy.
    expect(undoAffordance('place.rect')).toStrictEqual({
      disabled: false,
      reason: null,
      copy: '',
    });

    // §6.3's worked string is reproduced byte-for-byte.
    expect(renderUndoCopy('Exported the page as a PNG', NON_UNDOABLE_CONSEQUENCES['place.exportPng'])).toBe(
      "Exported the page as a PNG — the file is outside Fredo's document history. Re-export to change it.",
    );
  });
});

describe('§6.4 queries', () => {
  it('empty query returns noop no-matches with Nothing to undo. once', async () => {
    expect(NOTHING_TO_UNDO).toBe('Nothing to undo.');
    const harness = makeHarness(surfaceOf([]));

    const result = await dispatch(harness.deps, intent('journal.undo'));
    expect(result).toStrictEqual({
      status: 'noop',
      code: 'no-matches',
      message: 'Nothing to undo.',
    });
    expect(harness.journal.entries()).toHaveLength(0);
    expect(harness.patches).toHaveLength(0);
    expect(JSON.stringify(result).split('Nothing to undo.').length - 1).toBe(1);

    // An actor with no entries and a future `since` also match nothing.
    expect(
      await dispatch(harness.deps, intent('journal.undo', { args: { actor: 'companion' } })),
    ).toStrictEqual({ status: 'noop', code: 'no-matches', message: 'Nothing to undo.' });
    expect(
      await dispatch(
        harness.deps,
        intent('journal.undo', { args: { since: '2999-01-01T00:00:00.000Z' } }),
      ),
    ).toStrictEqual({ status: 'noop', code: 'no-matches', message: 'Nothing to undo.' });
  });

  it('query defaults clamp and AND semantics', () => {
    // Defaults and clamping.
    expect(normalizeQuery({})).toStrictEqual({ count: 1, effect: 'mutation' });
    expect(normalizeQuery({ count: 0 })).toStrictEqual({ count: 1, effect: 'mutation' });
    expect(normalizeQuery({ count: 101 })).toStrictEqual({ count: 100, effect: 'mutation' });
    expect(normalizeQuery({ count: 42 })).toStrictEqual({ count: 42, effect: 'mutation' });
    expect(normalizeQuery({ count: Number.NaN })).toStrictEqual({ count: 1, effect: 'mutation' });
    expect(normalizeQuery({ effect: 'navigation' })).toStrictEqual({
      count: 1,
      effect: 'navigation',
    });

    let state: JournalState = createJournalState();
    const entries: JournalEntry[] = [];
    const push = (overrides: Partial<JournalEntryDraft>, ts: string): void => {
      const outcome = appendEntry(state, draft(overrides), ts);
      state = outcome.state;
      entries.push(outcome.entry);
    };

    // 120 human `app.x` mutations (seq 1..120).
    for (let i = 0; i < 120; i += 1) push({ verbId: 'app.x' }, iso(i));
    // 3 companion `app.y` mutations.
    for (let i = 0; i < 3; i += 1) push({ verbId: 'app.y', actor: 'companion' }, iso(200 + i));
    // 2 navigation entries.
    push({ verbId: 'app.x', effect: 'navigation' }, iso(300));
    push({ verbId: 'app.x', effect: 'navigation' }, iso(301));

    // Default effect `mutation`, default count 1, newest first.
    expect(queryEntries(entries, {})).toHaveLength(1);
    expect(queryEntries(entries, {})[0].seq).toBe(123);
    expect(queryEntries(entries, { effect: 'mutation', count: 1 })).toHaveLength(1);
    // Clamp: 101 (and 120) clamp to 100 even though 123 mutations exist.
    expect(queryEntries(entries, { count: 101 })).toHaveLength(100);
    expect(queryEntries(entries, { count: 120 })).toHaveLength(100);
    // AND semantics.
    expect(queryEntries(entries, { actor: 'companion', count: 100 })).toHaveLength(3);
    expect(queryEntries(entries, { verbId: 'app.y', count: 100 })).toHaveLength(3);
    expect(queryEntries(entries, { actor: 'human', verbId: 'app.y', count: 100 })).toHaveLength(0);
    // Explicit navigation effect.
    expect(queryEntries(entries, { effect: 'navigation', count: 100 })).toHaveLength(2);
    // `since` is INCLUSIVE; one millisecond later excludes the entry.
    const newestHuman = entries[119];
    expect(queryEntries(entries, { verbId: 'app.x', since: newestHuman.ts })[0].seq).toBe(
      newestHuman.seq,
    );
    const afterNewest = new Date(Date.parse(newestHuman.ts) + 1).toISOString();
    expect(queryEntries(entries, { verbId: 'app.x', since: afterNewest })).toHaveLength(0);
  });

  it("canonical companion query undoes the companion's last change", async () => {
    const calls: JsonPatch[] = [];
    const journal = createJournalStore();
    let state = createJournalState();
    state = appendEntry(
      state,
      draft({ verbId: 'app.x', actor: 'human', patch: { before: { h: 0 }, after: { h: 1 } }, inverse: { h: 0 } }),
      iso(0),
    ).state;
    state = appendEntry(
      state,
      draft({ verbId: 'app.y', actor: 'companion', patch: { before: { h: 1 }, after: { h: 2 } }, inverse: { h: 1 } }),
      iso(1),
    ).state;
    state = appendEntry(
      state,
      draft({ verbId: 'app.x', actor: 'human', patch: { before: { h: 2 }, after: { h: 3 } }, inverse: { h: 2 } }),
      iso(2),
    ).state;
    journal.commit(state.entries, state.redo);

    const harness = makeHarness(surfaceOf([]), {
      journal,
      applyPatch: (patch) => {
        calls.push(patch);
      },
    });
    const result = await dispatch(
      harness.deps,
      intent('journal.undo', { args: { actor: 'companion', count: '1' }, channel: 'system' }),
    );

    expect(result.status).toBe('performed');
    // ONLY the companion entry's inverse was applied; human entries are untouched.
    expect(calls).toStrictEqual([{ h: 1 }]);
    expect(journal.entries()).toHaveLength(4);
    expect(journal.entries()[3].actor).toBe('system');
  });

  it('canonical count and actor query undoes newest N', async () => {
    const calls: JsonPatch[] = [];
    const journal = createJournalStore();
    let state = createJournalState();
    const humanInverses = [{ h: 1 }, { h: 2 }, { h: 3 }, { h: 4 }];
    for (let i = 0; i < 4; i += 1) {
      state = appendEntry(
        state,
        draft({
          verbId: `app.h${i + 1}`,
          actor: 'human',
          patch: { before: { h: i }, after: { h: i + 1 } },
          inverse: humanInverses[i],
        }),
        iso(i),
      ).state;
    }
    for (let i = 0; i < 2; i += 1) {
      state = appendEntry(
        state,
        draft({
          verbId: `app.c${i + 1}`,
          actor: 'companion',
          patch: { before: { c: i }, after: { c: i + 1 } },
          inverse: { c: i },
        }),
        iso(10 + i),
      ).state;
    }
    journal.commit(state.entries, state.redo);

    const harness = makeHarness(surfaceOf([]), {
      journal,
      applyPatch: (patch) => {
        calls.push(patch);
      },
    });
    const result = await dispatch(
      harness.deps,
      intent('journal.undo', { args: { count: '4', actor: 'human' }, channel: 'system' }),
    );

    expect(result.status).toBe('performed');
    // Newest human first (h4 → h1); companion inverses are never applied.
    expect(calls).toStrictEqual([{ h: 4 }, { h: 3 }, { h: 2 }, { h: 1 }]);
  });
});

describe('§10.2 undo(run(x)) ≡ before', () => {
  it('undo run x equals before', async () => {
    const before: JsonPatch = { value: 0, label: 'page' };
    const after: JsonPatch = { value: 1, label: 'page' };
    const doc = new RecordingDocument(before);
    const journal = createJournalStore();
    const verb = makeVerb({ id: 'app.write', run: () => doc.run(after) });
    const deps: EngineDeps = {
      surface: surfaceOf([verb]),
      getContext: () => makeSnapshot({ placePath: ['p.root'] }),
      journal,
      now: () => TS0,
      applyPatch: doc.applyPatch,
      confirm: () => true,
    };

    const performed = await dispatch(deps, intent('app.write'));
    expect(performed.status).toBe('performed');
    expect(doc.doc).toStrictEqual(after);

    const undo = await dispatch(deps, intent('journal.undo'));
    expect(undo.status).toBe('performed');
    expect(doc.doc).toStrictEqual(before);
    const undoEntry = journal.entries()[journal.entries().length - 1];
    expect(undoEntry.actor).toBe('system');
    expect(undoEntry.effect).toBe('mutation');

    const redo = await dispatch(deps, intent('journal.redo'));
    expect(redo.status).toBe('performed');
    expect(doc.doc).toStrictEqual(after);

    // 1,000 generated patch pairs — each must round-trip exactly.
    const rng = createSeededRandom(1);
    for (let i = 0; i < 1000; i += 1) {
      const pairBefore: JsonPatch = { value: Math.floor(rng() * 1000), step: i };
      const pairAfter: JsonPatch = { value: Math.floor(rng() * 1000), step: i };
      const pairDoc = new RecordingDocument(pairBefore);
      const pairJournal = createJournalStore();
      const pairVerb = makeVerb({ id: 'app.pair', run: () => pairDoc.run(pairAfter) });
      const pairDeps: EngineDeps = {
        surface: surfaceOf([pairVerb]),
        getContext: () => makeSnapshot({ placePath: ['p.root'] }),
        journal: pairJournal,
        now: () => TS0,
        applyPatch: pairDoc.applyPatch,
        confirm: () => true,
      };

      expect((await dispatch(pairDeps, intent('app.pair'))).status).toBe('performed');
      expect((await dispatch(pairDeps, intent('journal.undo'))).status).toBe('performed');
      expect(pairDoc.doc).toStrictEqual(pairBefore);
      const lastEntry = pairJournal.entries()[pairJournal.entries().length - 1];
      expect(lastEntry.actor).toBe('system');
      expect((await dispatch(pairDeps, intent('journal.redo'))).status).toBe('performed');
      expect(pairDoc.doc).toStrictEqual(pairAfter);
    }

    // A verb with `inverse: null` must refuse undo, not corrupt the document.
    const fixedJournal = createJournalStore();
    const fixedDoc = new RecordingDocument({ n: 0 });
    const fixedVerb = makeVerb({
      id: 'app.fixed',
      run: () =>
        makeEffect({
          label: 'Fixed',
          patch: { before: { n: 0 }, after: { n: 1 } },
          inverse: null,
          consequence: 'the previous state is not kept.',
        }),
    });
    const fixedDeps: EngineDeps = {
      surface: surfaceOf([fixedVerb]),
      getContext: () => makeSnapshot({ placePath: ['p.root'] }),
      journal: fixedJournal,
      now: () => TS0,
      applyPatch: fixedDoc.applyPatch,
      confirm: () => true,
    };
    expect((await dispatch(fixedDeps, intent('app.fixed'))).status).toBe('performed');
    const refused = await dispatch(fixedDeps, intent('journal.undo'));
    expect(refused).toStrictEqual({
      status: 'noop',
      code: 'no-matches',
      message: 'Nothing to undo.',
    });
    expect(fixedDoc.doc).toStrictEqual({ n: 1 });
  });
});
