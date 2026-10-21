/**
 * Wireframe store — undo/redo coverage (Spec #3070, ST-1, C3 / R-4.1).
 *
 * Every document mutation commits exactly ONE snapshot. The store must be
 * capable of add, move, resize, delete, duplicate and property changes even
 * though the UI arrives in later sub-tasks.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { createDefaultElement, type WireframeElementType } from '../model/elements';
import {
  UNDO_DEPTH,
  dispatch,
  getSnapshot,
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
