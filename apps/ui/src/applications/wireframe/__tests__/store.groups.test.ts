/**
 * Wireframe store — groups, stacking, selection set (Spec #3071, ST-1).
 *
 * Pins the group spine: `selectedIds` (document order), `group.create` (incl.
 * the R-1.9 re-group and whole-group no-op), `group.ungroup`, `group.toggleLock`
 * (R-1.7), `elements.delete`, multi-lock (R-1.10), deterministic reorder
 * (R-2.6 / R-2.9) and bulk `elements.update` (one snapshot each).
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  createNewWireframeDocument,
  groupOfElement,
  isElementMovable,
  isWholeGroupSelection,
  WIREFRAME_GROUP_MIN_MEMBERS,
  type WireframeGroup,
} from '../model/document';
import { createDefaultElement } from '../model/elements';
import {
  clearSelection,
  dispatch,
  getSnapshot,
  loadDocument,
  primarySelectedId,
  redo,
  resetWireframeStoreForTests,
  select,
  selectedElements,
  selectMany,
  toggleSelect,
  undo,
} from '../store/wireframeDocumentStore';

/** Load a saved (history-free) document with elements `ids` and `groups`. */
function seed(ids: readonly string[], groups: WireframeGroup[] = []): void {
  const base = createNewWireframeDocument('desktop');
  const elements = ids.map((id) =>
    createDefaultElement('card', { page: base.page, elements: [], id }),
  );
  loadDocument({ ...base, elements, groups }, 'C:/tmp/doc.wireframe.json');
}

function geometryOf(id: string) {
  const element = getSnapshot().document.elements.find((candidate) => candidate.id === id);
  return element ? { x: element.x, y: element.y, width: element.width, height: element.height } : null;
}

beforeEach(() => {
  resetWireframeStoreForTests();
});

describe('selection set (Spec #3071)', () => {
  it('starts empty with the derived selectedId mirror null', () => {
    const state = getSnapshot();
    expect(state.selectedIds).toEqual([]);
    expect(state.selectedId).toBeNull();
    expect(primarySelectedId(state)).toBeNull();
  });

  it('select replaces the selection; selectMany keeps document order', () => {
    seed(['a', 'b', 'c']);

    select('b');
    expect(getSnapshot().selectedIds).toEqual(['b']);
    expect(getSnapshot().selectedId).toBe('b');

    // Out-of-order input still normalises to document order.
    selectMany(['c', 'a']);
    expect(getSnapshot().selectedIds).toEqual(['a', 'c']);
    expect(getSnapshot().selectedId).toBe('c');
    expect(primarySelectedId(getSnapshot())).toBe('c');
  });

  it('toggleSelect adds then removes, and clearSelection empties', () => {
    seed(['a', 'b', 'c']);

    toggleSelect('c');
    toggleSelect('a');
    expect(getSnapshot().selectedIds).toEqual(['a', 'c']);

    toggleSelect('a');
    expect(getSnapshot().selectedIds).toEqual(['c']);

    clearSelection();
    expect(getSnapshot().selectedIds).toEqual([]);
    expect(getSnapshot().selectedId).toBeNull();
  });

  it('ignores unresolvable ids and drops them on document change', () => {
    seed(['a', 'b']);
    selectMany(['a', 'ghost']);
    expect(getSnapshot().selectedIds).toEqual(['a']);

    toggleSelect('ghost');
    expect(getSnapshot().selectedIds).toEqual(['a']);
  });

  it('selectedElements returns the selected elements in document order', () => {
    seed(['a', 'b', 'c']);
    selectMany(['c', 'b']);
    expect(selectedElements(getSnapshot()).map((element) => element.id)).toEqual(['b', 'c']);
  });

  it('selection changes are editor state: no history, no dirty flip', () => {
    seed(['a', 'b']);
    expect(getSnapshot().dirty).toBe(false);
    selectMany(['a', 'b']);
    select(null);
    expect(getSnapshot().canUndo).toBe(false);
    expect(getSnapshot().dirty).toBe(false);
  });
});

describe('group.create (R-1.3 / R-1.9)', () => {
  it('creates exactly one group, selects it, and leaves geometry unchanged', () => {
    seed(['a', 'b', 'c']);
    const before = ['a', 'b', 'c'].map(geometryOf);

    const changed = dispatch('group.create', { ids: ['a', 'b'] });
    expect(changed).toBe(true);

    const state = getSnapshot();
    expect(state.document.groups).toHaveLength(1);
    expect(state.document.groups[0]).toMatchObject({
      memberIds: ['a', 'b'],
      locked: false,
    });
    expect(state.selectedIds).toEqual(['a', 'b']);
    expect(['a', 'b', 'c'].map(geometryOf)).toEqual(before);
  });

  it('memberIds follow document order, not the given order', () => {
    seed(['a', 'b', 'c']);
    dispatch('group.create', { ids: ['c', 'a'] });
    expect(getSnapshot().document.groups[0].memberIds).toEqual(['a', 'c']);
  });

  it('is a no-op for fewer than two elements (R-2.7)', () => {
    seed(['a', 'b']);
    select('a');
    expect(dispatch('group.create', { ids: ['a'] })).toBe(false);
    expect(dispatch('group.create', {})).toBe(false);
    expect(getSnapshot().document.groups).toEqual([]);
  });

  it('re-groups already-grouped elements and drops emptied groups (R-1.9)', () => {
    seed(['a', 'b', 'c', 'd'], [
      { id: 'g1', memberIds: ['a'], locked: false },
      { id: 'g2', memberIds: ['b'], locked: false },
    ]);

    const changed = dispatch('group.create', { ids: ['a', 'b'] });
    expect(changed).toBe(true);

    const groups = getSnapshot().document.groups;
    // Two singleton groups re-grouped: count moves 2 -> 1 (not 2 -> 3).
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ memberIds: ['a', 'b'], locked: false });
  });

  it('keeps a previous group that still has members (R-1.9)', () => {
    seed(['a', 'b', 'c'], [{ id: 'g1', memberIds: ['a', 'b', 'c'], locked: true }]);

    dispatch('group.create', { ids: ['a', 'c'] });

    const groups = getSnapshot().document.groups;
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ id: 'g1', memberIds: ['b'], locked: true });
    expect(groups[1]).toMatchObject({ memberIds: ['a', 'c'], locked: false });
    expect(WIREFRAME_GROUP_MIN_MEMBERS).toBe(1);
  });

  it('is a no-op when the selection is exactly one whole group (R-1.9)', () => {
    seed(['a', 'b', 'c'], [{ id: 'g1', memberIds: ['a', 'b'], locked: true }]);
    selectMany(['a', 'b']);

    expect(isWholeGroupSelection(getSnapshot().document, ['a', 'b'])).toBe(true);
    expect(dispatch('group.create', { ids: ['a', 'b'] })).toBe(false);

    // No new group id minted, the original group survives untouched.
    expect(getSnapshot().document.groups).toEqual([
      { id: 'g1', memberIds: ['a', 'b'], locked: true },
    ]);
  });
});

describe('group.ungroup (R-1.5)', () => {
  it('removes the group and keeps members geometry + stacking order', () => {
    seed(['a', 'b', 'c'], [{ id: 'g1', memberIds: ['a', 'b'], locked: false }]);
    selectMany(['a', 'b']);
    const before = ['a', 'b'].map(geometryOf);

    const changed = dispatch('group.ungroup', { groupIds: ['g1'] });
    expect(changed).toBe(true);

    const state = getSnapshot();
    expect(state.document.groups).toEqual([]);
    expect(state.document.elements.map((element) => element.id)).toEqual(['a', 'b', 'c']);
    expect(['a', 'b'].map(geometryOf)).toEqual(before);
    // Members stay selected.
    expect(state.selectedIds).toEqual(['a', 'b']);
  });

  it('ungroups a locked group (lock covers position + size only — R-1.10)', () => {
    seed(['a', 'b'], [{ id: 'g1', memberIds: ['a', 'b'], locked: true }]);
    expect(dispatch('group.ungroup', { groupIds: ['g1'] })).toBe(true);
    expect(getSnapshot().document.groups).toEqual([]);
  });

  it('is a no-op for an unknown group', () => {
    seed(['a', 'b']);
    expect(dispatch('group.ungroup', { groupIds: ['missing'] })).toBe(false);
  });
});

describe('group.toggleLock (R-1.7 / R-1.10)', () => {
  it('flips the group lock and immovability, and still reorders + deletes', () => {
    seed(['a', 'b', 'c'], [{ id: 'g1', memberIds: ['a', 'b'], locked: false }]);

    expect(dispatch('group.toggleLock', { groupIds: ['g1'] })).toBe(true);
    expect(getSnapshot().document.groups[0].locked).toBe(true);
    expect(isElementMovable(getSnapshot().document, getSnapshot().document.elements[0])).toBe(false);

    // Lock covers position + size only: reorder still moves the locked member.
    const before = getSnapshot().document.elements.map((element) => element.id);
    expect(dispatch('element.reorder', { ids: ['a'], direction: 'forward' })).toBe(true);
    expect(getSnapshot().document.elements.map((element) => element.id)).not.toEqual(before);

    // ...and the delete action still removes a locked member.
    expect(dispatch('elements.delete', { ids: ['a'] })).toBe(true);
    expect(getSnapshot().document.elements.some((element) => element.id === 'a')).toBe(false);
    // The group is reconciled: `b` survives.
    expect(groupOfElement(getSnapshot().document, 'b')?.id).toBe('g1');
  });

  it('toggles back to unlocked', () => {
    seed(['a', 'b'], [{ id: 'g1', memberIds: ['a', 'b'], locked: true }]);
    dispatch('group.toggleLock', { groupIds: ['g1'] });
    expect(getSnapshot().document.groups[0].locked).toBe(false);
  });
});

describe('elements.delete (R-1.6)', () => {
  it('removes the group and every member in ONE snapshot', () => {
    seed(['a', 'b', 'c'], [{ id: 'g1', memberIds: ['a', 'b'], locked: false }]);
    selectMany(['a', 'b']);

    const changed = dispatch('elements.delete', { ids: ['a', 'b'] });
    expect(changed).toBe(true);

    const state = getSnapshot();
    expect(state.document.elements.map((element) => element.id)).toEqual(['c']);
    expect(state.document.groups).toEqual([]);
    expect(state.selectedIds).toEqual([]);

    undo();
    expect(getSnapshot().document.elements.map((element) => element.id)).toEqual(['a', 'b', 'c']);
    expect(getSnapshot().document.groups).toEqual([
      { id: 'g1', memberIds: ['a', 'b'], locked: false },
    ]);
  });
});

describe('element.toggleLock with N selected (R-1.10)', () => {
  it('flips every selected element in ONE commit', () => {
    seed(['a', 'b', 'c']);
    selectMany(['a', 'c']);

    expect(dispatch('element.toggleLock', { ids: ['a', 'c'] })).toBe(true);
    expect(getSnapshot().document.elements.map((element) => element.locked)).toEqual([
      true,
      false,
      true,
    ]);

    undo();
    expect(getSnapshot().document.elements.map((element) => element.locked)).toEqual([
      false,
      false,
      false,
    ]);
  });

  it('keeps the single-id form working', () => {
    seed(['a', 'b']);
    expect(dispatch('element.toggleLock', { id: 'b' })).toBe(true);
    expect(getSnapshot().document.elements[1].locked).toBe(true);
  });
});

describe('element.reorder (R-2.6 / R-2.9)', () => {
  const order = () => getSnapshot().document.elements.map((element) => element.id);

  it('bringForward moves one position later; sendBackward one earlier', () => {
    seed(['a', 'b', 'c']);
    select('a');
    expect(dispatch('element.reorder', { ids: ['a'], direction: 'forward' })).toBe(true);
    expect(order()).toEqual(['b', 'a', 'c']);
    // Selection survives the reorder.
    expect(getSnapshot().selectedIds).toEqual(['a']);

    expect(dispatch('element.reorder', { ids: ['a'], direction: 'backward' })).toBe(true);
    expect(order()).toEqual(['a', 'b', 'c']);
  });

  it('clamps at the ends and returns false when nothing moved', () => {
    seed(['a', 'b', 'c']);
    expect(dispatch('element.reorder', { ids: ['c'], direction: 'forward' })).toBe(false);
    expect(order()).toEqual(['a', 'b', 'c']);
    expect(getSnapshot().canUndo).toBe(false);

    expect(dispatch('element.reorder', { ids: ['a'], direction: 'backward' })).toBe(false);
    expect(order()).toEqual(['a', 'b', 'c']);
  });

  it('walks forward DESCENDING and backward ASCENDING (multi-select determinism)', () => {
    seed(['a', 'b', 'c', 'd']);
    expect(dispatch('element.reorder', { ids: ['a', 'c'], direction: 'forward' })).toBe(true);
    // c swaps first (descending), then a — one commit.
    expect(order()).toEqual(['b', 'a', 'd', 'c']);

    seed(['a', 'b', 'c', 'd']);
    expect(dispatch('element.reorder', { ids: ['a', 'c'], direction: 'backward' })).toBe(true);
    expect(order()).toEqual(['a', 'c', 'b', 'd']);
  });

  it('skips a swap that would cross the array end', () => {
    seed(['a', 'b', 'c']);
    // `c` is topmost and cannot move; `b` still advances.
    expect(dispatch('element.reorder', { ids: ['b', 'c'], direction: 'forward' })).toBe(true);
    expect(order()).toEqual(['a', 'c', 'b']);
  });

  it('reorders a locked element (lock is position + size only — R-1.10)', () => {
    seed(['a', 'b']);
    dispatch('element.toggleLock', { id: 'a' });
    expect(getSnapshot().document.elements[0].locked).toBe(true);
    expect(dispatch('element.reorder', { ids: ['a'], direction: 'forward' })).toBe(true);
    expect(order()).toEqual(['b', 'a']);
  });
});

describe('elements.update (bulk geometry, one snapshot)', () => {
  it('applies every patch in ONE commit and undo restores all of them', () => {
    seed(['a', 'b', 'c']);
    const before = ['a', 'b', 'c'].map(geometryOf);

    const changed = dispatch('elements.update', {
      patches: { a: { x: 10, y: 20 }, c: { width: 500 } },
    });
    expect(changed).toBe(true);
    expect(geometryOf('a')).toMatchObject({ x: 10, y: 20 });
    expect(geometryOf('c')).toMatchObject({ width: 500 });

    undo();
    expect(['a', 'b', 'c'].map(geometryOf)).toEqual(before);
  });

  it('is a no-op for an empty or non-matching patch set', () => {
    seed(['a', 'b']);
    expect(dispatch('elements.update', { patches: {} })).toBe(false);
    expect(dispatch('elements.update', { patches: { ghost: { x: 1 } } })).toBe(false);
    expect(getSnapshot().canUndo).toBe(false);
  });

  it('re-enters redo cleanly after an undo', () => {
    seed(['a', 'b']);
    dispatch('elements.update', { patches: { a: { x: 42 } } });
    undo();
    expect(geometryOf('a')?.x).not.toBe(42);
    redo();
    expect(geometryOf('a')).toMatchObject({ x: 42 });
  });
});
