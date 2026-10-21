/**
 * Wireframe command table (Spec #3070, ST-3, C4 / R-1.2 / R-1.3 / R-2.4 /
 * R-4.1).
 *
 * Pins the table contract ST-7 depends on (25 ids, 22 single-step hotkeys, the
 * two Companion-only rows with no local `run`) and proves every action's side
 * effect on the module-scoped store — no UI involved.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  WIREFRAME_ACTIONS,
  addWireframeElement,
  findWireframeAction,
  registerWireframeFileActionHandlers,
  resetWireframeFileActionHandlersForTests,
  runWireframeAction,
  wireframeActionTestId,
} from '../actions/wireframeActions';
import type { WireframeElementType } from '../model/elements';
import {
  getSnapshot,
  registerCanvasStage,
  resetWireframeStoreForTests,
  setStatus,
} from '../store/wireframeDocumentStore';

const SHIPPED_KEYS = ['s', 'd', 'r', 'a', 'z', 'j', 'f', 'q', 'e', 'c', 'i', 'x', 'b', 'v'];

const EXPECTED_IDS = [
  'wireframe.add.text',
  'wireframe.add.button',
  'wireframe.add.input',
  'wireframe.add.image',
  'wireframe.add.icon',
  'wireframe.add.card',
  'wireframe.add.section',
  'wireframe.add.shape',
  'wireframe.add.line',
  'wireframe.element.duplicate',
  'wireframe.element.delete',
  'wireframe.element.toggleLock',
  'wireframe.edit.undo',
  'wireframe.edit.redo',
  'wireframe.zoom.in',
  'wireframe.zoom.out',
  'wireframe.view.fitPage',
  'wireframe.view.resetView',
  'wireframe.view.togglePan',
  'wireframe.file.saveAs',
  'wireframe.file.open',
  'wireframe.file.exportPng',
  'wireframe.document.new',
  'wireframe.companion.listActions',
  'wireframe.companion.draftApp',
];

const EXPECTED_KEYS: Readonly<Record<string, string>> = {
  'wireframe.add.text': '1',
  'wireframe.add.button': '2',
  'wireframe.add.input': '3',
  'wireframe.add.image': '4',
  'wireframe.add.icon': '5',
  'wireframe.add.card': '6',
  'wireframe.add.section': '7',
  'wireframe.add.shape': '8',
  'wireframe.add.line': '9',
  'wireframe.element.duplicate': 'p',
  'wireframe.element.delete': 'k',
  'wireframe.element.toggleLock': 'l',
  'wireframe.edit.undo': 'u',
  'wireframe.edit.redo': 'y',
  'wireframe.zoom.in': 'g',
  'wireframe.zoom.out': 'm',
  'wireframe.view.fitPage': 'n',
  'wireframe.view.resetView': '0',
  'wireframe.view.togglePan': 'h',
  'wireframe.file.saveAs': 'w',
  'wireframe.file.open': 'o',
  'wireframe.file.exportPng': 't',
};

function elements() {
  return getSnapshot().document.elements;
}

function lastElement() {
  const all = elements();
  return all[all.length - 1];
}

function measureStage(width = 800, height = 600): void {
  registerCanvasStage({ width: () => width, height: () => height });
}

beforeEach(() => {
  resetWireframeStoreForTests();
  resetWireframeFileActionHandlersForTests();
});

afterEach(() => {
  resetWireframeFileActionHandlersForTests();
});

describe('WIREFRAME_ACTIONS — the one command table', () => {
  it('declares the 25 C4 ids in catalog order', () => {
    expect(WIREFRAME_ACTIONS.map((action) => action.id)).toEqual(EXPECTED_IDS);
  });

  it('binds exactly the 22 declared single-step keys', () => {
    const bound = WIREFRAME_ACTIONS.filter((action) => action.hotkey !== undefined);
    expect(bound).toHaveLength(22);

    for (const action of bound) {
      expect(action.hotkey, action.id).toBe(EXPECTED_KEYS[action.id]);
      expect(action.hotkey).toMatch(/^[a-z0-9]$/);
    }

    // No duplicate key inside the table.
    const keys = bound.map((action) => action.hotkey as string);
    expect(new Set(keys).size).toBe(keys.length);

    // Disjoint from the 14 shipped keys (the 36-key budget is exactly full).
    for (const key of keys) expect(SHIPPED_KEYS).not.toContain(key);
  });

  it('marks only the two companion ids as non-toolbar, with no hotkey and no local run', () => {
    const companion = WIREFRAME_ACTIONS.filter((action) => !action.toolbar);
    expect(companion.map((action) => action.id)).toEqual([
      'wireframe.companion.listActions',
      'wireframe.companion.draftApp',
    ]);
    for (const action of companion) {
      expect(action.hotkey).toBeUndefined();
      expect(action.run).toBeUndefined();
    }
  });

  it('keeps document.new toolbar-visible without a hotkey', () => {
    const newDocument = findWireframeAction('wireframe.document.new');
    expect(newDocument?.toolbar).toBe(true);
    expect(newDocument?.hotkey).toBeUndefined();
    expect(newDocument?.run).toBeTypeOf('function');
  });

  it('resolves ids and refuses unknown/companion ids', () => {
    expect(findWireframeAction('wireframe.add.text')?.hotkey).toBe('1');
    expect(findWireframeAction('wireframe.nope')).toBeUndefined();
    expect(runWireframeAction('wireframe.nope')).toBe(false);
    expect(runWireframeAction('wireframe.companion.listActions')).toBe(false);
    expect(runWireframeAction('wireframe.companion.draftApp')).toBe(false);
  });

  it('derives the C7 testid suffix from the action id', () => {
    expect(wireframeActionTestId('wireframe.add.text')).toBe('wireframe-action-add-text');
    expect(wireframeActionTestId('wireframe.element.toggleLock')).toBe(
      'wireframe-action-element-toggleLock',
    );
    expect(wireframeActionTestId('wireframe.view.fitPage')).toBe(
      'wireframe-action-view-fitPage',
    );
    expect(wireframeActionTestId('wireframe.file.saveAs')).toBe(
      'wireframe-action-file-saveAs',
    );
  });
});

describe('insert actions (R-1.2 / R-1.3)', () => {
  const CASES: readonly [string, WireframeElementType][] = [
    ['wireframe.add.text', 'text'],
    ['wireframe.add.button', 'button'],
    ['wireframe.add.input', 'input'],
    ['wireframe.add.image', 'image'],
    ['wireframe.add.icon', 'icon'],
    ['wireframe.add.card', 'card'],
    ['wireframe.add.section', 'section'],
    ['wireframe.add.shape', 'shape'],
    ['wireframe.add.line', 'line'],
  ];

  it('adds the right element type, selects it and marks the document dirty', () => {
    for (const [id, type] of CASES) {
      expect(runWireframeAction(id), id).toBe(true);
      const added = lastElement();
      expect(added.type, id).toBe(type);
      expect(getSnapshot().selectedId, id).toBe(added.id);
      expect(getSnapshot().dirty, id).toBe(true);
    }
    expect(elements()).toHaveLength(CASES.length);
  });

  it('uses the default section preset and shape kind, and selects the new element', () => {
    runWireframeAction('wireframe.add.section');
    const section = lastElement();
    expect(section).toMatchObject({ type: 'section', preset: 'header' });
    expect(getSnapshot().selectedId).toBe(section.id);

    runWireframeAction('wireframe.add.shape');
    const shape = lastElement();
    expect(shape).toMatchObject({ type: 'shape', shape: 'rect' });
    expect(getSnapshot().selectedId).toBe(shape.id);
  });

  it('adds an explicit preset/kind through the insert-menu helper', () => {
    addWireframeElement('section', { preset: 'navbar' });
    expect(lastElement()).toMatchObject({ type: 'section', preset: 'navbar' });

    addWireframeElement('shape', { shape: 'ellipse' });
    expect(lastElement()).toMatchObject({ type: 'shape', shape: 'ellipse' });
  });
});

describe('selection actions (R-2.4)', () => {
  it('is a false no-op with no selection and changes nothing', () => {
    for (const id of [
      'wireframe.element.duplicate',
      'wireframe.element.delete',
      'wireframe.element.toggleLock',
    ]) {
      expect(runWireframeAction(id), id).toBe(false);
    }
    expect(elements()).toHaveLength(0);
    expect(getSnapshot().canUndo).toBe(false);
    expect(getSnapshot().dirty).toBe(true);
  });

  it('duplicates the selection, offset, and selects the copy', () => {
    runWireframeAction('wireframe.add.text');
    const original = lastElement();

    expect(runWireframeAction('wireframe.element.duplicate')).toBe(true);
    expect(elements()).toHaveLength(2);
    const copy = lastElement();
    expect(copy.id).not.toBe(original.id);
    expect(copy.x).toBe(original.x + 16);
    expect(copy.y).toBe(original.y + 16);
    expect(getSnapshot().selectedId).toBe(copy.id);
  });

  it('deletes the selection and clears it', () => {
    runWireframeAction('wireframe.add.button');
    expect(runWireframeAction('wireframe.element.delete')).toBe(true);
    expect(elements()).toHaveLength(0);
    expect(getSnapshot().selectedId).toBeNull();
  });

  it('toggles lock without dropping the selection', () => {
    runWireframeAction('wireframe.add.card');
    const id = getSnapshot().selectedId;

    expect(runWireframeAction('wireframe.element.toggleLock')).toBe(true);
    expect(getSnapshot().selectedId).toBe(id);
    expect(elements()[0]).toMatchObject({ id, locked: true });

    expect(runWireframeAction('wireframe.element.toggleLock')).toBe(true);
    expect(elements()[0]).toMatchObject({ id, locked: false });
  });
});

describe('history actions (R-4.1)', () => {
  it('is a false no-op on empty history', () => {
    expect(runWireframeAction('wireframe.edit.undo')).toBe(false);
    expect(runWireframeAction('wireframe.edit.redo')).toBe(false);
  });

  it('undoes and redoes one committed step', () => {
    runWireframeAction('wireframe.add.text');
    expect(elements()).toHaveLength(1);

    expect(runWireframeAction('wireframe.edit.undo')).toBe(true);
    expect(elements()).toHaveLength(0);
    expect(getSnapshot().canRedo).toBe(true);

    expect(runWireframeAction('wireframe.edit.redo')).toBe(true);
    expect(elements()).toHaveLength(1);
  });
});

describe('view actions (R-4.2 - R-4.5, store-only)', () => {
  it('zooms in/out one fixed step about the measured viewport', () => {
    measureStage();
    expect(runWireframeAction('wireframe.zoom.in')).toBe(true);
    expect(getSnapshot().view.scale).toBeCloseTo(1.1, 6);

    expect(runWireframeAction('wireframe.zoom.out')).toBe(true);
    expect(getSnapshot().view.scale).toBeCloseTo(1, 6);
  });

  it('fits and resets the view without touching the document', () => {
    measureStage();
    const documentBefore = getSnapshot().document;

    expect(runWireframeAction('wireframe.view.fitPage')).toBe(true);
    expect(getSnapshot().view.scale).toBeLessThan(1);
    // Fit is a no-op once already fitted -> false.
    expect(runWireframeAction('wireframe.view.fitPage')).toBe(false);

    expect(runWireframeAction('wireframe.view.resetView')).toBe(true);
    expect(getSnapshot().view.scale).toBe(1);

    expect(getSnapshot().document).toBe(documentBefore);
    expect(getSnapshot().canUndo).toBe(false);
  });

  it('is a false no-op before the canvas stage is measured', () => {
    expect(runWireframeAction('wireframe.zoom.in')).toBe(false);
    expect(runWireframeAction('wireframe.zoom.out')).toBe(false);
    expect(runWireframeAction('wireframe.view.fitPage')).toBe(false);
    expect(runWireframeAction('wireframe.view.resetView')).toBe(false);
    expect(getSnapshot().view).toEqual({ scale: 1, x: 0, y: 0 });
  });

  it('toggles pan mode without mutating the document', () => {
    expect(runWireframeAction('wireframe.view.togglePan')).toBe(true);
    expect(getSnapshot().panMode).toBe(true);
    expect(runWireframeAction('wireframe.view.togglePan')).toBe(true);
    expect(getSnapshot().panMode).toBe(false);
    expect(getSnapshot().canUndo).toBe(false);
  });
});

describe('file actions (ST-6 seam)', () => {
  it('routes each file action through the registered handlers', () => {
    const saveAs = vi.fn();
    const openDocument = vi.fn();
    const exportPng = vi.fn();
    registerWireframeFileActionHandlers({ saveAs, openDocument, exportPng });

    expect(runWireframeAction('wireframe.file.saveAs')).toBe(true);
    expect(runWireframeAction('wireframe.file.open')).toBe(true);
    expect(runWireframeAction('wireframe.file.exportPng')).toBe(true);

    expect(saveAs).toHaveBeenCalledTimes(1);
    expect(openDocument).toHaveBeenCalledTimes(1);
    expect(exportPng).toHaveBeenCalledTimes(1);
  });

  it('reports false when a registered handler throws (nothing performed)', () => {
    registerWireframeFileActionHandlers({
      saveAs: () => {
        throw new Error('boom');
      },
    });
    expect(runWireframeAction('wireframe.file.saveAs')).toBe(false);
  });

  it('leaves the document untouched (the handler owns status/error)', () => {
    setStatus('saving');
    registerWireframeFileActionHandlers({ saveAs: vi.fn() });
    runWireframeAction('wireframe.file.saveAs');
    expect(elements()).toHaveLength(0);
    expect(getSnapshot().status).toBe('saving');
  });
});

describe('document.new', () => {
  it('resets the document, selection, history and path', () => {
    runWireframeAction('wireframe.add.text');
    expect(elements()).toHaveLength(1);

    expect(runWireframeAction('wireframe.document.new')).toBe(true);
    expect(elements()).toHaveLength(0);
    expect(getSnapshot().selectedId).toBeNull();
    expect(getSnapshot().filePath).toBeNull();
    expect(getSnapshot().dirty).toBe(true);
    expect(getSnapshot().canUndo).toBe(false);
    expect(getSnapshot().canRedo).toBe(false);
  });
});
