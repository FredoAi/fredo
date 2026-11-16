/**
 * Wireframe document history — one entry per mutation, one undo authority
 * (Spec #3119 ST-2 / R-5; re-pointed by Spec #3151, ST-3 / AC4).
 *
 * The store used to commit every mutation to the shared navigation journal and
 * shim `undo`/`redo` off it. Spec #3151 deletes that journal, so the store now
 * owns a bounded app-local `WireframeHistory`: these cases pin the SAME
 * externally observable contract (one undo step per mutation, undo then redo,
 * field-scoped deltas) against the new home.
 *
 * The two trailing cases still exercise the ENGINE's trail projection over a
 * journal instance the test owns; they assert nothing about the store and die
 * with the engine in ST-6.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { appendEntry } from '../../../shared/navigation/journal';
import type { JournalEntry, Surface } from '../../../shared/navigation/types';
import { buildActivityTrailModel } from '../../../shared/navigation/ui/models';
import { createNewWireframeDocument } from '../model/document';
import {
  createDefaultElement,
  type WireframeElement,
  type WireframeElementType,
} from '../model/elements';
import {
  dispatch,
  getSnapshot,
  getWireframeContext,
  getWireframeHistory,
  loadDocument,
  redo,
  resetWireframeStoreForTests,
  select,
  setWireframeContextProvider,
  undo,
} from '../store/wireframeDocumentStore';

beforeEach(() => {
  resetWireframeStoreForTests();
});

/** Load a saved (history-free) document with the given element ids. */
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

/** The smallest declaration the trail projection needs (the real surface is ST-5). */
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

describe('the app-local history is the single mutation authority (AC4)', () => {
  it('every document mutation records exactly one entry with the action id', () => {
    seed(['a']);
    setWireframeContextProvider(() => ({
      appId: 'wireframe',
      placePath: ['wireframe.canvas', 'wireframe.create'],
      selection: { count: 0, ids: [], kinds: [], label: null },
      dirty: false,
    }));
    select('a');

    expect(dispatch('element.update', { id: 'a', patch: { x: 77 } })).toBe(true);

    const entries = getWireframeHistory().entries();
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    // The store funnel's verb id is the store action id.
    expect(entry.verbId).toBe('element.update');
    expect(entry.label).toBe('Update Card');
    // `before` reverts the edit; `after` re-applies it.
    expect(entry.before).toBeTruthy();
    expect(entry.after).toBeTruthy();
    expect(entry.seq).toBe(1);

    // `setWireframeContextProvider` publishes the primary element TYPE first.
    expect(getWireframeContext().selection).toEqual({
      count: 1,
      ids: ['a'],
      kinds: ['card'],
      label: 'Card',
    });
  });

  it('undo restores the previous document and records no extra entry', () => {
    seed(['a']);
    dispatch('element.update', { id: 'a', patch: { x: 12 } });
    const mutated = getSnapshot().document;

    undo();

    expect(getSnapshot().document).not.toBe(mutated);
    expect(getSnapshot().document.elements[0].x).not.toBe(12);
    // Undo steps the cursor; it never pushes a second entry.
    expect(getWireframeHistory().entries()).toHaveLength(1);
    expect(getWireframeHistory().canUndo()).toBe(false);
    expect(getWireframeHistory().canRedo()).toBe(true);
  });

  it('redo re-applies the entry and exhausts the redo tail', () => {
    seed(['a']);
    dispatch('element.update', { id: 'a', patch: { x: 12 } });
    undo();
    expect(getWireframeHistory().canRedo()).toBe(true);

    redo();

    expect(getSnapshot().document.elements[0].x).toBe(12);
    expect(getWireframeHistory().canRedo()).toBe(false);
    expect(getSnapshot().canRedo).toBe(false);
    expect(getSnapshot().canUndo).toBe(true);
  });

  it('the legacy funnel undo reverts only the newest entry\'s field (AC6 / R-6.1)', () => {
    seed(['a']);
    const originalY = getSnapshot().document.elements[0].y;

    // Two independent human edits on DIFFERENT fields of the same element.
    dispatch('element.update', { id: 'a', patch: { x: 12 } });
    dispatch('element.update', { id: 'a', patch: { y: 34 } });

    undo();

    const element = getSnapshot().document.elements[0];
    // Only the second entry's field (`y`) reverts; the earlier independent `x` survives.
    expect(element.x).toBe(12);
    expect(element.y).toBe(originalY);
  });

  it('undoing a selection-scoped entry after the selection changed leaves no stale id', () => {
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

  it('a new edit after an undo drops the redo tail (no orphaned entry)', () => {
    seed(['a']);
    dispatch('element.update', { id: 'a', patch: { x: 1 } });
    dispatch('element.update', { id: 'a', patch: { x: 2 } });
    undo();
    expect(getWireframeHistory().canRedo()).toBe(true);

    dispatch('element.update', { id: 'a', patch: { x: 3 } });

    expect(getWireframeHistory().canRedo()).toBe(false);
    expect(getWireframeHistory().entries()).toHaveLength(2);
    expect(getSnapshot().document.elements[0].x).toBe(3);

    undo();
    expect(getSnapshot().document.elements[0].x).toBe(1);
  });
});

/* ───────────── the engine's trail projection over a test-owned journal ───────────── */

describe('the engine trail projection (dies with the engine in ST-6)', () => {
  it('lists the journal entries newest first', () => {
    // A test-owned journal instance — the projection only reads `seq`/attribution.
    let journal = { entries: [] as readonly JournalEntry[], redo: [] as readonly number[] };
    for (let index = 0; index < 3; index += 1) {
      const outcome = appendEntry(
        journal,
        {
          verbId: 'wireframe.element.toggleLock',
          actor: 'human',
          channel: 'pointer',
          label: 'Toggle lock',
          effect: 'mutation',
          placePath: ['wireframe.canvas'],
          target: [],
          patch: null,
          inverse: { delta: {} },
          external: false,
          consequence: null,
          exitedBy: 'none',
          coalesceKey: null,
        },
        '2026-01-01T00:00:00.000Z',
      );
      journal = outcome.state;
    }

    const model = buildActivityTrailModel(minimalSurface(), journal.entries);

    expect(model.entries.map((entry) => entry.seq)).toEqual([3, 2, 1]);
    expect(model.entries).toHaveLength(3);
    expect(model.empty).toBe(false);
  });

  it('a navigation entry is attributed and not undoable', () => {
    const outcome = appendEntry(
      { entries: [], redo: [] },
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

    const navigation = outcome.entry;
    expect(navigation.effect).toBe('navigation');
    expect(navigation.patch).toBeNull();
    expect(navigation.inverse).toBeNull();
    expect(navigation.undoable).toBe(false);
    expect(navigation.actor).toBe('human');
    expect(navigation.placePath).toEqual(['wireframe.canvas', 'wireframe.view']);
    // A navigation entry never clears the redo stack (mutation-only rule).
    expect(outcome.state.redo).toEqual([]);
  });
});
