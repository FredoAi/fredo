/**
 * Wireframe journal — the single mutation + undo authority (Spec #3119, ST-2 / R-5).
 *
 * The store's compatibility funnel (`dispatch`) commits exactly ONE human entry
 * per document mutation to the module-scoped journal; `undo`/`redo` are
 * journal-backed shims. The last two cases exercise the journal/trail model the
 * P5 host consumes (the host itself lands in ST-4).
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { appendEntry } from '../../../shared/navigation/journal';
import type { Surface } from '../../../shared/navigation/types';
import { createNavigationHost } from '../../../shared/navigation/ui/host';
import { buildActivityTrailModel } from '../../../shared/navigation/ui/models';
import { createNewWireframeDocument } from '../model/document';
import {
  createDefaultElement,
  type WireframeElement,
  type WireframeElementType,
} from '../model/elements';
import {
  applyDocumentPatch,
  dispatch,
  getNavigationJournal,
  getSnapshot,
  getWireframeContext,
  loadDocument,
  redo,
  resetWireframeStoreForTests,
  select,
  setWireframeContextProvider,
  undo,
  type WireframeDocumentPatch,
} from '../store/wireframeDocumentStore';

beforeEach(() => {
  resetWireframeStoreForTests();
});

/** Load a saved (journal-free) document with the given element ids. */
function seed(ids: readonly string[]): void {
  const base = createNewWireframeDocument('desktop');
  const elements = ids.map((id) =>
    createDefaultElement('card', { page: base.page, elements: [], id }),
  );
  loadDocument({ ...base, elements }, 'C:/tmp/doc.wireframe.json');
}

function makeElement(type: WireframeElementType, id: string): WireframeElement {
  const { page } = getSnapshot().document;
  return createDefaultElement(type, { page, elements: [], id });
}

/** The smallest declaration the host/trail projections need (the real surface is ST-3). */
function minimalSurface(): Surface {
  const place = (id: string, label: string, parent: string | null) => ({
    id,
    label,
    parent,
    transient: false,
    sticky: false,
    cursor: null,
    operator: null,
    keys: {},
    entryHooks: [] as string[],
    exitHooks: [] as string[],
  });
  return {
    tree: {
      appId: 'wireframe',
      root: 'wireframe.canvas',
      places: [
        place('wireframe.canvas', 'Canvas', null),
        place('wireframe.create', 'Create', 'wireframe.canvas'),
        place('wireframe.view', 'View', 'wireframe.canvas'),
      ],
      directAliases: {},
    },
    verbs: [],
    companion: null,
  };
}

describe('the journal is the single mutation authority (R-5)', () => {
  it('every document mutation appends exactly one human entry with the verb id and place path', () => {
    seed(['a']);
    setWireframeContextProvider(() => ({
      appId: 'wireframe',
      placePath: ['wireframe.canvas', 'wireframe.create'],
      selection: { count: 0, ids: [], kinds: [], label: null },
      dirty: false,
    }));
    select('a');

    expect(dispatch('element.update', { id: 'a', patch: { x: 77 } })).toBe(true);

    const entries = getNavigationJournal().entries();
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry.actor).toBe('human');
    // The store funnel's verb id is the store action id; the P5 surface verbs
    // (ST-3) pass their declared verb id through the engine's own append.
    expect(entry.verbId).toBe('element.update');
    expect(entry.placePath).toEqual(['wireframe.canvas', 'wireframe.create']);
    expect(entry.effect).toBe('mutation');
    expect(entry.undoable).toBe(true);

    // `setWireframeContextProvider` publishes the primary element TYPE first.
    expect(getWireframeContext().selection).toEqual({
      count: 1,
      ids: ['a'],
      kinds: ['card'],
      label: 'Card',
    });
  });

  it('undo restores the previous document and journals one system entry', () => {
    seed(['a']);
    dispatch('element.update', { id: 'a', patch: { x: 12 } });
    const mutated = getSnapshot().document;

    undo();

    expect(getSnapshot().document).not.toBe(mutated);
    expect(getSnapshot().document.elements[0].x).not.toBe(12);
    const entries = getNavigationJournal().entries();
    expect(entries).toHaveLength(2);
    const system = entries[1];
    expect(system.actor).toBe('system');
    expect(system.effect).toBe('mutation');
    expect(system.label).toBe('Undo Update Card');
    expect(getNavigationJournal().redo()).toEqual([1]);
  });

  it('redo re-applies the entry and drops it from the redo stack', () => {
    seed(['a']);
    dispatch('element.update', { id: 'a', patch: { x: 12 } });
    undo();
    expect(getNavigationJournal().redo()).toEqual([1]);

    redo();

    expect(getSnapshot().document.elements[0].x).toBe(12);
    expect(getNavigationJournal().redo()).toEqual([]);
    expect(getSnapshot().canRedo).toBe(false);
    expect(getSnapshot().canUndo).toBe(true);
  });

  it('undoing a selection-scoped verb after the selection changed leaves no stale id', () => {
    seed(['a']);
    dispatch('element.add', { element: makeElement('text', 'b') });
    expect(getSnapshot().selectedIds).toEqual(['b']);

    // The selection changes AFTER the mutation the undo will revert.
    select('a');
    undo();

    const state = getSnapshot();
    expect(state.document.elements.map((element) => element.id)).toEqual(['a']);
    expect(state.selectedIds).not.toContain('b');
    expect(
      state.selectedIds.every((id) =>
        state.document.elements.some((element) => element.id === id),
      ),
    ).toBe(true);
  });

  it('store undo and host undoLast advance the same journal', async () => {
    seed(['a', 'b']);
    dispatch('element.update', { id: 'a', patch: { x: 1 } });
    dispatch('element.update', { id: 'b', patch: { y: 2 } });
    const journal = getNavigationJournal();
    expect(journal.entries()).toHaveLength(2);

    // The P5 host (ST-4) is constructed with THIS journal + applyDocumentPatch.
    const host = createNavigationHost({
      surface: minimalSurface(),
      getContext: getWireframeContext,
      journal,
      now: () => '2026-01-01T00:00:00.000Z',
      applyPatch: (patch) =>
        applyDocumentPatch(patch as unknown as WireframeDocumentPatch),
    });

    undo();
    expect(journal.entries()).toHaveLength(3);
    expect(journal.entries()[2].actor).toBe('system');

    await host.undoLast();

    // One counter: consecutive seqs, no gap, and the host reads the SAME array.
    expect(journal.entries().map((entry) => entry.seq)).toEqual([1, 2, 3, 4]);
    expect(journal.entries().filter((entry) => entry.actor === 'system')).toHaveLength(2);
    expect(host.getSnapshot().entries.map((entry) => entry.seq)).toEqual([1, 2, 3, 4]);
  });

  it('the activity trail lists the journal entries newest first', () => {
    seed(['a']);
    dispatch('element.update', { id: 'a', patch: { x: 1 } });
    dispatch('element.update', { id: 'a', patch: { x: 2 } });
    dispatch('element.update', { id: 'a', patch: { x: 3 } });

    const model = buildActivityTrailModel(minimalSurface(), getNavigationJournal().entries());

    expect(model.entries.map((entry) => entry.seq)).toEqual([3, 2, 1]);
    expect(model.entries).toHaveLength(3);
    expect(model.empty).toBe(false);
  });

  it('a view verb journals one attributed navigation entry and is not undoable', () => {
    seed(['a']);
    dispatch('element.update', { id: 'a', patch: { x: 1 } });
    undo();
    const redoBefore = getNavigationJournal().redo();
    expect(redoBefore).toEqual([1]);

    // ST-3/ST-4 append this from the view verb's `effect:'navigation'` result;
    // ST-2 owns the journal model that makes it non-undoable (R-5/Q-8).
    const outcome = appendEntry(
      { entries: getNavigationJournal().entries(), redo: getNavigationJournal().redo() },
      {
        verbId: 'wireframe.view.fitPage',
        actor: 'human',
        channel: 'keyboard',
        label: 'Fit page',
        effect: 'navigation',
        placePath: ['wireframe.canvas', 'wireframe.view'],
        target: [],
        patch: null,
        inverse: null,
        external: false,
        consequence: null,
        exitedBy: 'none',
        coalesceKey: null,
      },
      '2026-01-01T00:00:00.000Z',
    );
    getNavigationJournal().commit(outcome.state.entries, outcome.state.redo);

    const entries = getNavigationJournal().entries();
    const navigation = entries[entries.length - 1];
    expect(navigation.effect).toBe('navigation');
    expect(navigation.patch).toBeNull();
    expect(navigation.inverse).toBeNull();
    expect(navigation.undoable).toBe(false);
    expect(navigation.actor).toBe('human');
    expect(navigation.placePath).toEqual(['wireframe.canvas', 'wireframe.view']);
    // A navigation entry never clears the redo stack (mutation-only rule).
    expect(getNavigationJournal().redo()).toEqual(redoBefore);
  });
});
