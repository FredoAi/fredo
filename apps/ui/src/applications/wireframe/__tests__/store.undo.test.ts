/**
 * Wireframe store — undo/redo coverage (Spec #3070, ST-1, C3 / R-4.1).
 *
 * Every document mutation commits exactly ONE snapshot. The store must be
 * capable of add, move, resize, delete, duplicate and property changes even
 * though the UI arrives in later sub-tasks.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { createDefaultElement, type WireframeElement, type WireframeElementType } from '../model/elements';
import { createNewWireframeDocument } from '../model/document';
import {
  UNDO_DEPTH,
  beginCaptureView,
  dispatch,
  endCaptureView,
  getSnapshot,
  loadDocument,
  redo,
  resetWireframeStoreForTests,
  undo,
} from '../store/wireframeDocumentStore';

let counter = 0;

function add(type: WireframeElementType = 'text') {
  counter += 1;
  const snapshot = getSnapshot();
  const element = createDefaultElement(type, {
    page: snapshot.document.page,
    elements: snapshot.document.elements,
    id: `element-${counter}`,
  });
  dispatch('element.add', { element });
  return element;
}

/** A loaded (saved, history-free) document holding exactly one element. */
function loadOne(type: WireframeElementType = 'card'): WireframeElement {
  const base = createNewWireframeDocument('desktop');
  const element = createDefaultElement(type, {
    page: base.page,
    elements: [],
    id: 'loaded-1',
  });
  loadDocument({ ...base, elements: [element] }, 'C:/tmp/doc.wireframe.json');
  return element;
}

beforeEach(() => {
  counter = 0;
  resetWireframeStoreForTests();
});

describe('add / undo / redo', () => {
  it('commits exactly one snapshot per add and restores identity on redo', () => {
    const element = add('text');
    const state = getSnapshot();

    expect(state.document.elements).toHaveLength(1);
    expect(state.selectedId).toBe(element.id);
    expect(state.canUndo).toBe(true);
    expect(state.canRedo).toBe(false);
    expect(UNDO_DEPTH).toBe(100);

    undo();
    expect(getSnapshot().document.elements).toHaveLength(0);
    expect(getSnapshot().selectedId).toBeNull();
    expect(getSnapshot().canUndo).toBe(false);
    expect(getSnapshot().canRedo).toBe(true);

    redo();
    expect(getSnapshot().document.elements).toHaveLength(1);
    expect(getSnapshot().document.elements[0].id).toBe(element.id);
    expect(getSnapshot().canRedo).toBe(false);
  });

  it('undoes two adds one step at a time', () => {
    add('text');
    add('button');

    undo();
    expect(getSnapshot().document.elements).toHaveLength(1);
    expect(getSnapshot().document.elements[0].type).toBe('text');
    expect(getSnapshot().canUndo).toBe(true);

    undo();
    expect(getSnapshot().document.elements).toHaveLength(0);
    expect(getSnapshot().canUndo).toBe(false);
  });

  it('is a no-op at the empty history', () => {
    undo();
    redo();
    expect(getSnapshot().document.elements).toHaveLength(0);
  });
});

describe('move / resize / property change', () => {
  it('commits one move step and the undo restores the exact geometry', () => {
    const element = add('text');
    dispatch('element.update', { id: element.id, patch: { x: 10, y: 20 } });

    expect(getSnapshot().document.elements[0]).toMatchObject({ x: 10, y: 20 });
    undo();
    expect(getSnapshot().document.elements[0]).toMatchObject({
      x: element.x,
      y: element.y,
    });
    redo();
    expect(getSnapshot().document.elements[0]).toMatchObject({ x: 10, y: 20 });
  });

  it('commits one resize step', () => {
    const element = add('card');
    dispatch('element.update', {
      id: element.id,
      patch: { width: 500, height: 300 },
    });
    expect(getSnapshot().document.elements[0]).toMatchObject({ width: 500, height: 300 });

    undo();
    expect(getSnapshot().document.elements[0]).toMatchObject({
      width: element.width,
      height: element.height,
    });
  });

  it('commits one step for a type-specific property change', () => {
    const element = add('text');
    dispatch('element.update', {
      id: element.id,
      patch: { text: 'Headline', textStyle: 'heading', size: 'xl', align: 'center' },
    });
    expect(getSnapshot().document.elements[0]).toMatchObject({
      text: 'Headline',
      textStyle: 'heading',
      size: 'xl',
      align: 'center',
    });

    undo();
    expect(getSnapshot().document.elements[0]).toMatchObject({
      text: 'Text',
      textStyle: 'body',
      size: 'm',
      align: 'left',
    });
  });
});

describe('delete / duplicate / lock', () => {
  it('deletes, clears the selection, and undo restores the same element', () => {
    const element = add('icon');
    dispatch('element.delete', { id: element.id });

    expect(getSnapshot().document.elements).toHaveLength(0);
    expect(getSnapshot().selectedId).toBeNull();

    undo();
    expect(getSnapshot().document.elements[0]).toEqual(element);
  });

  it('duplicates with a new id, a fixed offset, and selects the copy', () => {
    const element = add('card');
    dispatch('element.duplicate', { id: element.id });

    const state = getSnapshot();
    expect(state.document.elements).toHaveLength(2);
    const copy = state.document.elements[1];
    expect(copy.id).not.toBe(element.id);
    expect(copy.x).toBe(element.x + 16);
    expect(copy.y).toBe(element.y + 16);
    expect(copy).toMatchObject({ type: 'card', label: 'Card' });
    expect(state.selectedId).toBe(copy.id);

    undo();
    expect(getSnapshot().document.elements).toHaveLength(1);
    // The selected copy disappeared -> selection reconciles to none (R-2.7).
    expect(getSnapshot().selectedId).toBeNull();
  });

  it('toggles lock as one undoable step', () => {
    const element = add('shape');
    dispatch('element.toggleLock', { id: element.id });
    expect(getSnapshot().document.elements[0].locked).toBe(true);
    expect(getSnapshot().selectedId).toBe(element.id);

    undo();
    expect(getSnapshot().document.elements[0].locked).toBe(false);
  });
});

describe('page changes', () => {
  it('a named preset sets its exact dimensions; undo restores the page', () => {
    dispatch('page.update', { page: { preset: 'tablet' } });
    expect(getSnapshot().document.page).toEqual({
      preset: 'tablet',
      width: 768,
      height: 1024,
    });

    undo();
    expect(getSnapshot().document.page).toEqual({
      preset: 'desktop',
      width: 1280,
      height: 800,
    });
  });

  it('direct dimensions clamp to 64..4096 and become Custom', () => {
    dispatch('page.update', { page: { width: 32, height: 99999 } });
    expect(getSnapshot().document.page).toEqual({
      preset: 'custom',
      width: 64,
      height: 4096,
    });

    dispatch('page.update', { page: { width: 640, height: 480 } });
    expect(getSnapshot().document.page).toEqual({
      preset: 'custom',
      width: 640,
      height: 480,
    });
  });
});

describe('safe no-ops', () => {
  it('ignores missing targets without creating history', () => {
    dispatch('element.delete', { id: 'missing' });
    dispatch('element.update', { id: 'missing', patch: { x: 1 } });
    dispatch('element.duplicate', { id: 'missing' });
    dispatch('element.toggleLock', { id: 'missing' });
    dispatch('element.add', {});

    expect(getSnapshot().document.elements).toHaveLength(0);
    expect(getSnapshot().canUndo).toBe(false);
  });
});

describe('value-equal commits are not mutations (E-15)', () => {
  it('skips an element.update that repeats the current values', () => {
    const element = loadOne('card');
    const before = getSnapshot();
    expect(before.canUndo).toBe(false);
    expect(before.dirty).toBe(false);

    dispatch('element.update', {
      id: element.id,
      patch: { x: element.x, y: element.y, width: element.width, height: element.height },
    });

    const after = getSnapshot();
    expect(after.document).toBe(before.document);
    expect(after.canUndo).toBe(false);
    expect(after.canRedo).toBe(false);
    expect(after.dirty).toBe(false);
  });

  it('a duplicate commit does not buy a history entry', () => {
    const element = loadOne('card');
    dispatch('element.update', { id: element.id, patch: { x: element.x + 24 } });
    const afterMove = getSnapshot();
    expect(afterMove.document.elements[0]).toMatchObject({ x: element.x + 24 });

    // The blur re-commit of the value the store already holds.
    dispatch('element.update', { id: element.id, patch: { x: element.x + 24 } });
    expect(getSnapshot().document).toBe(afterMove.document);

    undo();
    expect(getSnapshot().document.elements[0]).toMatchObject({ x: element.x });
    expect(getSnapshot().canUndo).toBe(false);
  });

  it('skips a page.update that repeats the current page and keeps one step per real change', () => {
    loadOne('card');
    const before = getSnapshot();
    const pageBefore = JSON.stringify(before.document.page);

    // Same named preset resolves to the dimensions the page already has.
    dispatch('page.update', { page: { preset: 'desktop' } });
    expect(getSnapshot().document).toBe(before.document);
    expect(getSnapshot().canUndo).toBe(false);
    expect(getSnapshot().dirty).toBe(false);
    expect(JSON.stringify(getSnapshot().document.page)).toBe(pageBefore);

    dispatch('page.update', { page: { width: 640 } });
    const afterResize = getSnapshot();
    expect(afterResize.document.page).toMatchObject({ preset: 'custom', width: 640 });

    // Blur re-commits the same width.
    dispatch('page.update', { page: { width: 640 } });
    expect(getSnapshot().document).toBe(afterResize.document);

    undo();
    expect(getSnapshot().document.page).toMatchObject({ preset: 'desktop', width: 1280 });
    expect(getSnapshot().canUndo).toBe(false);
  });

  it('the capture view is paint-only: no history, no dirty, no document change', () => {
    loadOne('card');
    const before = getSnapshot();

    beginCaptureView();
    expect(getSnapshot().captureView).toEqual({ scale: 1, x: 0, y: 0 });
    endCaptureView();

    const after = getSnapshot();
    expect(after.captureView).toBeNull();
    expect(after.document).toBe(before.document);
    expect(after.canUndo).toBe(false);
    expect(after.canRedo).toBe(false);
    expect(after.dirty).toBe(false);
    expect(after.view).toEqual(before.view);
    expect(after.selectedId).toBe(before.selectedId);
  });
});

describe('one snapshot per mutation (Spec #3071, NFR-4)', () => {
  /** A loaded (history-free) document with the given element ids. */
  function seedMulti(ids: readonly string[]): void {
    const base = createNewWireframeDocument('desktop');
    const elements = ids.map((id) =>
      createDefaultElement('card', { page: base.page, elements: [], id }),
    );
    loadDocument({ ...base, elements }, 'C:/tmp/doc.wireframe.json');
  }

  it('group.create commits exactly one snapshot', () => {
    seedMulti(['a', 'b']);
    expect(dispatch('group.create', { ids: ['a', 'b'] })).toBe(true);
    expect(getSnapshot().canUndo).toBe(true);

    undo();
    expect(getSnapshot().document.groups).toEqual([]);
    expect(getSnapshot().canUndo).toBe(false);
  });

  it('group.ungroup commits exactly one snapshot', () => {
    seedMulti(['a', 'b']);
    dispatch('group.create', { ids: ['a', 'b'] });
    const groupId = getSnapshot().document.groups[0].id;

    expect(dispatch('group.ungroup', { groupIds: [groupId] })).toBe(true);
    undo();
    expect(getSnapshot().document.groups).toHaveLength(1);
    expect(getSnapshot().canUndo).toBe(true);

    undo();
    expect(getSnapshot().document.groups).toEqual([]);
    expect(getSnapshot().canUndo).toBe(false);
  });

  it('group.toggleLock commits exactly one snapshot', () => {
    seedMulti(['a', 'b']);
    dispatch('group.create', { ids: ['a', 'b'] });
    const groupId = getSnapshot().document.groups[0].id;

    expect(dispatch('group.toggleLock', { groupIds: [groupId] })).toBe(true);
    expect(getSnapshot().document.groups[0].locked).toBe(true);

    undo();
    expect(getSnapshot().document.groups[0].locked).toBe(false);
  });

  it('elements.update commits exactly one snapshot', () => {
    seedMulti(['a', 'b']);
    expect(dispatch('elements.update', { patches: { a: { x: 5 }, b: { y: 7 } } })).toBe(true);
    expect(getSnapshot().document.elements).toMatchObject([{ x: 5 }, { y: 7 }]);

    undo();
    expect(getSnapshot().document.elements[0].x).not.toBe(5);
    expect(getSnapshot().document.elements[1].y).not.toBe(7);
    expect(getSnapshot().canUndo).toBe(false);
  });

  it('elements.delete commits exactly one snapshot', () => {
    seedMulti(['a', 'b', 'c']);
    expect(dispatch('elements.delete', { ids: ['a', 'b'] })).toBe(true);
    expect(getSnapshot().document.elements).toHaveLength(1);

    undo();
    expect(getSnapshot().document.elements).toHaveLength(3);
    expect(getSnapshot().canUndo).toBe(false);
  });

  it('element.reorder commits exactly one snapshot', () => {
    seedMulti(['a', 'b', 'c']);
    expect(dispatch('element.reorder', { ids: ['a', 'b'], direction: 'forward' })).toBe(true);
    expect(getSnapshot().document.elements.map((element) => element.id)).toEqual(['c', 'a', 'b']);

    undo();
    expect(getSnapshot().document.elements.map((element) => element.id)).toEqual(['a', 'b', 'c']);
    expect(getSnapshot().canUndo).toBe(false);
  });

  it('a value-equal groups commit buys no history entry', () => {
    seedMulti(['a', 'b']);
    dispatch('group.create', { ids: ['a', 'b'] });
    const before = getSnapshot();

    // group.ungroup for an unknown group is a no-op with no snapshot.
    expect(dispatch('group.ungroup', { groupIds: ['missing'] })).toBe(false);
    expect(getSnapshot().document).toBe(before.document);
    expect(getSnapshot().canUndo).toBe(true);
  });
});
