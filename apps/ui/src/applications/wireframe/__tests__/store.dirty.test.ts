/**
 * Wireframe store — dirty/session semantics (Spec #3070, ST-1, C3 / R-4.10 / R-4.12).
 *
 * The saved/unsaved text has exactly one input (`dirty`), so the store test
 * also renders the editor shell and asserts the C7 root hooks + `wireframe-status`
 * text agree.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { createNewWireframeDocument, serializeWireframeDocument } from '../model/document';
import { createDefaultElement } from '../model/elements';
import { WireframeEditor } from '../components/WireframeEditor';
import {
  dispatch,
  getSnapshot,
  loadDocument,
  markSaved,
  resetForNewDocument,
  resetWireframeStoreForTests,
  select,
  setError,
  setPanMode,
  setSnapToGrid,
  setStatus,
  setView,
  toggleSnapToGrid,
  undo,
} from '../store/wireframeDocumentStore';

beforeEach(() => {
  resetWireframeStoreForTests();
});

afterEach(() => {
  cleanup();
});

function addText() {
  const snapshot = getSnapshot();
  const element = createDefaultElement('text', {
    page: snapshot.document.page,
    elements: snapshot.document.elements,
    id: 'element-1',
  });
  dispatch('element.add', { element });
  return element;
}

describe('new / open / save', () => {
  it('a fresh document is dirty with no path', () => {
    const state = getSnapshot();
    expect(state.dirty).toBe(true);
    expect(state.filePath).toBeNull();
    expect(state.selectedId).toBeNull();
  });

  it('resetForNewDocument clears selection + history and keeps dirty=true', () => {
    addText();
    select('element-1');

    resetForNewDocument('phone');
    const state = getSnapshot();
    expect(state.document.page).toEqual({ preset: 'phone', width: 390, height: 844 });
    expect(state.document.elements).toEqual([]);
    expect(state.selectedId).toBeNull();
    expect(state.filePath).toBeNull();
    expect(state.dirty).toBe(true);
    expect(state.canUndo).toBe(false);
    expect(state.canRedo).toBe(false);
    expect(state.view).toEqual({ scale: 1, x: 0, y: 0 });
  });

  it('loadDocument clears selection + history and sets dirty=false + path', () => {
    addText();
    const opened = createNewWireframeDocument('tablet');

    loadDocument(opened, 'C:\\docs\\opened.wireframe.json');
    const state = getSnapshot();
    expect(state.document).toBe(opened);
    expect(state.selectedId).toBeNull();
    expect(state.filePath).toBe('C:\\docs\\opened.wireframe.json');
    expect(state.dirty).toBe(false);
    expect(state.canUndo).toBe(false);
    expect(state.canRedo).toBe(false);
  });

  it('markSaved clears dirty and records the path', () => {
    addText();
    markSaved('C:\\docs\\home.wireframe.json');

    const state = getSnapshot();
    expect(state.dirty).toBe(false);
    expect(state.filePath).toBe('C:\\docs\\home.wireframe.json');
    expect(state.status).toBe('idle');
  });

  it('a mutation after a load flips the document back to dirty', () => {
    loadDocument(createNewWireframeDocument(), 'C:\\docs\\a.wireframe.json');
    expect(getSnapshot().dirty).toBe(false);

    addText();
    expect(getSnapshot().dirty).toBe(true);
  });
});

describe('editor-only state never dirties or creates history', () => {
  it('selection, view, pan, status and error leave dirty/history untouched', () => {
    addText();
    markSaved('C:\\docs\\a.wireframe.json');
    const before = getSnapshot();

    select(null);
    setView({ scale: 2, x: 10, y: 20 });
    setPanMode(true);
    setStatus('saving');
    setError('boom');

    const after = getSnapshot();
    expect(after.dirty).toBe(false);
    expect(after.canUndo).toBe(before.canUndo);
    expect(after.canRedo).toBe(before.canRedo);
    expect(after.document).toBe(before.document);
    expect(after.view).toEqual({ scale: 2, x: 10, y: 20 });
    expect(after.panMode).toBe(true);
    expect(after.status).toBe('saving');
    expect(after.error).toBe('boom');
  });

  it('undo/redo mark the document dirty again', () => {
    addText();
    markSaved('C:\\docs\\a.wireframe.json');
    expect(getSnapshot().dirty).toBe(false);

    undo();
    expect(getSnapshot().dirty).toBe(true);
  });
});

describe('editor shell DOM hooks (C7)', () => {
  it('renders the root attributes and the exact Saved/Unsaved text', () => {
    const { getByTestId } = renderWithChakra(React.createElement(WireframeEditor));
    const root = getByTestId('wireframe-root');

    expect(root.getAttribute('data-wireframe-element-count')).toBe('0');
    expect(root.getAttribute('data-wireframe-selection-id')).toBe('');
    expect(root.getAttribute('data-wireframe-selection-type')).toBe('');
    expect(root.getAttribute('data-wireframe-selection-geometry')).toBe('');
    expect(root.getAttribute('data-wireframe-dirty')).toBe('true');
    expect(root.getAttribute('data-wireframe-document-path')).toBe('');
    expect(root.getAttribute('data-wireframe-page')).toBe('1280x800');
    expect(root.getAttribute('data-wireframe-zoom')).toBe('100');
    expect(root.getAttribute('data-wireframe-pan-mode')).toBe('false');
    expect(getByTestId('wireframe-status').textContent).toBe('Unsaved');

    act(() => {
      addText();
    });

    expect(root.getAttribute('data-wireframe-element-count')).toBe('1');
    expect(root.getAttribute('data-wireframe-selection-id')).toBe('element-1');
    expect(root.getAttribute('data-wireframe-selection-type')).toBe('text');
    expect(root.getAttribute('data-wireframe-selection-geometry')).toMatch(
      /^-?\d+(?:\.\d)?,-?\d+(?:\.\d)?,\d+(?:\.\d)?,\d+(?:\.\d)?$/,
    );
    expect(getByTestId('wireframe-status').textContent).toBe('Unsaved');

    act(() => {
      markSaved('C:\\docs\\home.wireframe.json');
    });
    expect(root.getAttribute('data-wireframe-dirty')).toBe('false');
    expect(root.getAttribute('data-wireframe-document-path')).toBe(
      'C:\\docs\\home.wireframe.json',
    );
    expect(getByTestId('wireframe-status').textContent).toBe('Saved');
  });

  it('renders the status live region as polite + atomic', () => {
    const { getByTestId } = renderWithChakra(React.createElement(WireframeEditor));
    const region = getByTestId('wireframe-status').closest('[role="status"]');
    expect(region).not.toBeNull();
    expect(region?.getAttribute('aria-live')).toBe('polite');
    expect(region?.getAttribute('aria-atomic')).toBe('true');
  });

  it('shows the pending operation verb while a file command runs', () => {
    const { getByTestId } = renderWithChakra(React.createElement(WireframeEditor));

    act(() => {
      setStatus('saving');
    });
    expect(getByTestId('wireframe-status').closest('[role="status"]')?.textContent).toContain(
      'Saving…',
    );

    act(() => {
      setStatus('idle');
    });
    expect(getByTestId('wireframe-status').closest('[role="status"]')?.textContent).not.toContain(
      'Saving…',
    );
  });
});

describe('serialized dirty state', () => {
  it('a fresh document serialises as schemaVersion 1 / the app tag', () => {
    const parsed = JSON.parse(serializeWireframeDocument(getSnapshot().document));
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.app).toBe('fredo.wireframe');
    expect(parsed.elements).toEqual([]);
  });
});

describe('groups + snap dirty semantics (Spec #3071, F-67)', () => {
  /** A saved document with two elements in one unlocked group. */
  function seedGroup(): void {
    const base = createNewWireframeDocument('desktop');
    const elements = ['a', 'b'].map((id) =>
      createDefaultElement('card', { page: base.page, elements: [], id }),
    );
    loadDocument(
      { ...base, elements, groups: [{ id: 'g1', memberIds: ['a', 'b'], locked: false }] },
      'C:\\docs\\a.wireframe.json',
    );
  }

  it('a groups-only mutation (group-lock) commits, flips dirty and is undoable', () => {
    seedGroup();
    expect(getSnapshot().dirty).toBe(false);

    // The documentsEqual trap: without `groups` in the comparison this would be
    // value-equal and silently no-op (no snapshot, no dirty flip, no repaint).
    expect(dispatch('group.toggleLock', { groupIds: ['g1'] })).toBe(true);
    expect(getSnapshot().document.groups[0].locked).toBe(true);
    expect(getSnapshot().dirty).toBe(true);
    expect(getSnapshot().canUndo).toBe(true);

    undo();
    expect(getSnapshot().document.groups[0].locked).toBe(false);
    expect(getSnapshot().canUndo).toBe(false);
  });

  it('group.create flips dirty', () => {
    seedGroup();
    dispatch('group.ungroup', { groupIds: ['g1'] });
    markSaved('C:\\docs\\a.wireframe.json');
    expect(getSnapshot().dirty).toBe(false);

    expect(dispatch('group.create', { ids: ['a', 'b'] })).toBe(true);
    expect(getSnapshot().dirty).toBe(true);
  });

  it('snap-to-grid is editor state: never dirty, never undoable', () => {
    seedGroup();
    const before = getSnapshot();

    toggleSnapToGrid();
    expect(getSnapshot().snapToGrid).toBe(true);
    expect(getSnapshot().dirty).toBe(false);
    expect(getSnapshot().canUndo).toBe(false);
    expect(getSnapshot().canRedo).toBe(false);
    expect(getSnapshot().document).toBe(before.document);

    setSnapToGrid(false);
    expect(getSnapshot().snapToGrid).toBe(false);
    expect(getSnapshot().dirty).toBe(false);
  });

  it('snap is not serialised into the document', () => {
    seedGroup();
    toggleSnapToGrid();
    const parsed = JSON.parse(serializeWireframeDocument(getSnapshot().document));
    expect(parsed.snapToGrid).toBeUndefined();
    expect(parsed.groups).toEqual([{ id: 'g1', memberIds: ['a', 'b'], locked: false }]);
  });
});
