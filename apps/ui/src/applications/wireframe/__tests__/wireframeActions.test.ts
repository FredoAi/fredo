/**
 * Wireframe command table (Spec #3070, ST-3, C4 / R-1.2 / R-1.3 / R-2.4 /
 * R-4.1; extended by Spec #3071, ST-4).
 *
 * Pins the table contract ST-7 depends on (35 ids, 32 hotkeys — 20 single-step
 * plus the 12 two-step `g`-namespace bindings — the two Companion-only rows with
 * no local `run`) and proves every action's side effect on the module-scoped
 * store — no UI involved.
 *
 * ST-4 adds the 10 arrange rows and RE-BINDS `wireframe.zoom.in` (`g` -> `g+i`)
 * and `wireframe.zoom.out` (`m` -> `g+o`), so `g` is a PREFIX-ONLY namespace.
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
import type { WireframeElementPatch, WireframeElementType } from '../model/elements';
import type { WireframeRect } from '../model/geometry';
import {
  dispatch,
  getSnapshot,
  registerCanvasStage,
  resetWireframeStoreForTests,
  select,
  selectMany,
  setStatus,
} from '../store/wireframeDocumentStore';

const SHIPPED_KEYS = ['s', 'd', 'r', 'a', 'z', 'j', 'f', 'q', 'e', 'c', 'i', 'x', 'b', 'v'];

const DATA_HOTKEY = /^[a-z0-9](?:\+[a-z0-9])?$/;

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
  'wireframe.arrange.group',
  'wireframe.arrange.ungroup',
  'wireframe.arrange.toggleGroupLock',
  'wireframe.arrange.toggleSnap',
  'wireframe.arrange.alignLeft',
  'wireframe.arrange.alignCenter',
  'wireframe.arrange.alignRight',
  'wireframe.arrange.distribute',
  'wireframe.arrange.bringForward',
  'wireframe.arrange.sendBackward',
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
  'wireframe.zoom.in': 'g+i',
  'wireframe.zoom.out': 'g+o',
  'wireframe.view.fitPage': 'n',
  'wireframe.view.resetView': '0',
  'wireframe.view.togglePan': 'h',
  'wireframe.file.saveAs': 'w',
  'wireframe.file.open': 'o',
  'wireframe.file.exportPng': 't',
  'wireframe.arrange.group': 'g+g',
  'wireframe.arrange.ungroup': 'g+u',
  'wireframe.arrange.toggleGroupLock': 'g+l',
  'wireframe.arrange.toggleSnap': 'g+s',
  'wireframe.arrange.alignLeft': 'g+a',
  'wireframe.arrange.alignCenter': 'g+c',
  'wireframe.arrange.alignRight': 'g+r',
  'wireframe.arrange.distribute': 'g+d',
  'wireframe.arrange.bringForward': 'g+f',
  'wireframe.arrange.sendBackward': 'g+b',
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

/**
 * Add one card per rect (document order = input order), force the geometry and
 * select the whole set. Returns the ids in document order.
 */
function seed(rects: readonly WireframeRect[]): string[] {
  const ids: string[] = [];
  for (let index = 0; index < rects.length; index += 1) {
    addWireframeElement('card');
    ids.push(lastElement().id);
  }
  const patches: Record<string, WireframeElementPatch> = {};
  ids.forEach((id, index) => {
    patches[id] = { ...rects[index] };
  });
  dispatch('elements.update', { patches });
  selectMany(ids);
  return ids;
}

/** Lock one element through the store (position/size lock only). */
function lock(id: string): void {
  dispatch('element.toggleLock', { id });
}

beforeEach(() => {
  resetWireframeStoreForTests();
  resetWireframeFileActionHandlersForTests();
});

afterEach(() => {
  resetWireframeFileActionHandlersForTests();
});

describe('WIREFRAME_ACTIONS — the one command table', () => {
  it('declares the 35 C4 ids in catalog order', () => {
    expect(WIREFRAME_ACTIONS.map((action) => action.id)).toEqual(EXPECTED_IDS);
  });

  it('binds exactly the 32 declared hotkeys (single- and two-step)', () => {
    const bound = WIREFRAME_ACTIONS.filter((action) => action.hotkey !== undefined);
    expect(bound).toHaveLength(32);

    for (const action of bound) {
      expect(action.hotkey, action.id).toBe(EXPECTED_KEYS[action.id]);
      expect(action.hotkey, action.id).toMatch(DATA_HOTKEY);
    }

    // No duplicate full serialization inside the table (the relaxed rule).
    const keys = bound.map((action) => action.hotkey as string);
    expect(new Set(keys).size).toBe(keys.length);

    // No strict-prefix shadowing: no binding's value is a strict prefix of
    // another's, so a bare key can never shadow a sequence on its key.
    for (const key of keys) {
      expect(keys.some((other) => other.startsWith(`${key}+`)), key).toBe(false);
    }

    // First steps disjoint from the 14 shipped keys.
    for (const key of keys) expect(SHIPPED_KEYS).not.toContain(key.split('+')[0]);
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

describe('arrange actions (Spec #3071, ST-4 — R-1.3/1.5/1.7/1.9/2.1/2.3/2.4/2.6/2.7/2.8/2.9)', () => {
  it('declares the 10 arrange rows as toolbar controls bound in the `g` namespace', () => {
    const arrange = WIREFRAME_ACTIONS.filter((action) =>
      action.id.startsWith('wireframe.arrange.'),
    );
    expect(arrange.map((action) => action.id)).toEqual([
      'wireframe.arrange.group',
      'wireframe.arrange.ungroup',
      'wireframe.arrange.toggleGroupLock',
      'wireframe.arrange.toggleSnap',
      'wireframe.arrange.alignLeft',
      'wireframe.arrange.alignCenter',
      'wireframe.arrange.alignRight',
      'wireframe.arrange.distribute',
      'wireframe.arrange.bringForward',
      'wireframe.arrange.sendBackward',
    ]);
    for (const action of arrange) {
      expect(action.toolbar, action.id).toBe(true);
      expect(action.hotkey, action.id).toMatch(/^g\+[a-z0-9]$/);
      expect(action.run, action.id).toBeTypeOf('function');
    }
  });

  it('re-binds the two Slice-1 view rows and leaves `g` prefix-only (`m` free)', () => {
    expect(findWireframeAction('wireframe.zoom.in')?.hotkey).toBe('g+i');
    expect(findWireframeAction('wireframe.zoom.out')?.hotkey).toBe('g+o');
    expect(WIREFRAME_ACTIONS.some((action) => action.hotkey === 'g')).toBe(false);
    expect(WIREFRAME_ACTIONS.some((action) => action.hotkey === 'm')).toBe(false);
  });

  it('group is a false no-op with fewer than two selected (R-2.7)', () => {
    expect(runWireframeAction('wireframe.arrange.group')).toBe(false);
    expect(getSnapshot().canUndo).toBe(false);

    seed([{ x: 10, y: 10, width: 40, height: 40 }]);
    expect(runWireframeAction('wireframe.arrange.group')).toBe(false);
    expect(getSnapshot().document.groups).toHaveLength(0);
  });

  it('group creates ONE group for >=2 selected and selects its members (R-1.3)', () => {
    const [a, b] = seed([
      { x: 10, y: 10, width: 40, height: 40 },
      { x: 90, y: 60, width: 20, height: 20 },
    ]);

    expect(runWireframeAction('wireframe.arrange.group')).toBe(true);
    const groups = getSnapshot().document.groups;
    expect(groups).toHaveLength(1);
    expect(groups[0].memberIds).toEqual([a, b]);
    expect(groups[0].locked).toBe(false);
    expect(getSnapshot().selectedIds).toEqual([a, b]);
    // Geometry is unchanged by grouping.
    expect(elements().map((element) => element.x)).toEqual([10, 90]);
  });

  it('group on a whole-group selection is a false no-op (R-1.9)', () => {
    seed([
      { x: 10, y: 10, width: 40, height: 40 },
      { x: 90, y: 60, width: 20, height: 20 },
    ]);
    expect(runWireframeAction('wireframe.arrange.group')).toBe(true);

    expect(runWireframeAction('wireframe.arrange.group')).toBe(false);
    expect(getSnapshot().document.groups).toHaveLength(1);
  });

  it('ungroup removes the group; an ungrouped selection is a false no-op (R-1.5)', () => {
    seed([
      { x: 10, y: 10, width: 40, height: 40 },
      { x: 90, y: 60, width: 20, height: 20 },
    ]);
    expect(runWireframeAction('wireframe.arrange.ungroup')).toBe(false);

    runWireframeAction('wireframe.arrange.group');
    expect(runWireframeAction('wireframe.arrange.ungroup')).toBe(true);
    expect(getSnapshot().document.groups).toHaveLength(0);
    // Members stay selected and keep their geometry.
    expect(getSnapshot().selectedIds).toHaveLength(2);
    expect(elements().map((element) => element.x)).toEqual([10, 90]);
  });

  it('toggleGroupLock flips the group lock; a non-group selection is false (R-1.7)', () => {
    seed([
      { x: 10, y: 10, width: 40, height: 40 },
      { x: 90, y: 60, width: 20, height: 20 },
    ]);
    expect(runWireframeAction('wireframe.arrange.toggleGroupLock')).toBe(false);

    runWireframeAction('wireframe.arrange.group');
    expect(runWireframeAction('wireframe.arrange.toggleGroupLock')).toBe(true);
    expect(getSnapshot().document.groups[0].locked).toBe(true);
    expect(getSnapshot().dirty).toBe(true);
  });

  it('toggleSnap flips the editor flag without a document mutation (R-2.1)', () => {
    expect(getSnapshot().snapToGrid).toBe(false);
    const documentBefore = getSnapshot().document;

    expect(runWireframeAction('wireframe.arrange.toggleSnap')).toBe(true);
    expect(getSnapshot().snapToGrid).toBe(true);
    expect(getSnapshot().document).toBe(documentBefore);
    expect(getSnapshot().canUndo).toBe(false);

    expect(runWireframeAction('wireframe.arrange.toggleSnap')).toBe(true);
    expect(getSnapshot().snapToGrid).toBe(false);
  });

  it('alignLeft moves the selection to the union left edge (R-2.3)', () => {
    seed([
      { x: 10, y: 10, width: 40, height: 40 },
      { x: 90, y: 60, width: 20, height: 20 },
    ]);

    expect(runWireframeAction('wireframe.arrange.alignLeft')).toBe(true);
    expect(elements().map((element) => element.x)).toEqual([10, 10]);
    // Sizes are preserved.
    expect(elements().map((element) => element.width)).toEqual([40, 20]);

    // Already aligned => a true no-op returning false (R-2.9).
    expect(runWireframeAction('wireframe.arrange.alignLeft')).toBe(false);
  });

  it('alignCenter centres every element on the union box (R-2.3)', () => {
    seed([
      { x: 10, y: 10, width: 40, height: 40 },
      { x: 90, y: 60, width: 20, height: 20 },
    ]);

    expect(runWireframeAction('wireframe.arrange.alignCenter')).toBe(true);
    expect(elements().map((element) => element.x)).toEqual([40, 50]);
  });

  it('alignRight aligns the selection to the union right edge (R-2.3)', () => {
    seed([
      { x: 10, y: 10, width: 40, height: 40 },
      { x: 90, y: 60, width: 20, height: 20 },
    ]);

    expect(runWireframeAction('wireframe.arrange.alignRight')).toBe(true);
    expect(elements().map((element) => element.x)).toEqual([70, 90]);
  });

  it('align is a false no-op with fewer than two selected (R-2.7)', () => {
    const [a] = seed([{ x: 10, y: 10, width: 40, height: 40 }]);
    select(a);
    expect(runWireframeAction('wireframe.arrange.alignLeft')).toBe(false);
    expect(runWireframeAction('wireframe.arrange.alignCenter')).toBe(false);
    expect(runWireframeAction('wireframe.arrange.alignRight')).toBe(false);
  });

  it('align/distribute operate on the MOVABLE members only (R-2.8)', () => {
    const [a, b] = seed([
      { x: 10, y: 10, width: 40, height: 40 },
      { x: 90, y: 60, width: 20, height: 20 },
    ]);
    lock(b);
    selectMany([a, b]);

    // One movable member is below the minimum => nothing changes, false.
    expect(runWireframeAction('wireframe.arrange.alignLeft')).toBe(false);
    expect(elements().map((element) => element.x)).toEqual([10, 90]);
  });

  it('align uses the WHOLE selection union bounds with a locked anchor (R-2.8)', () => {
    const [a, b, c] = seed([
      { x: 0, y: 0, width: 40, height: 40 },
      { x: 120, y: 0, width: 40, height: 40 },
      { x: 300, y: 0, width: 40, height: 40 },
    ]);
    // `b` is locked and stays exactly where it is; the union's right edge (340)
    // is still the align target.
    lock(b);
    selectMany([a, b, c]);

    expect(runWireframeAction('wireframe.arrange.alignRight')).toBe(true);
    const byId = new Map(elements().map((element) => [element.id, element]));
    expect(byId.get(a)?.x).toBe(300);
    expect(byId.get(c)?.x).toBe(300);
    // The locked member never moves.
    expect(byId.get(b)?.x).toBe(120);
  });

  it('distribute equalises the horizontal gaps; <3 movable is false (R-2.4/R-2.7)', () => {
    seed([
      { x: 0, y: 0, width: 40, height: 40 },
      { x: 100, y: 0, width: 20, height: 40 },
      { x: 200, y: 0, width: 40, height: 40 },
    ]);

    expect(runWireframeAction('wireframe.arrange.distribute')).toBe(true);
    const xs = elements().map((element) => element.x);
    expect(xs[0]).toBe(0);
    expect(xs[2]).toBe(200);
    // Equal edge-to-edge gaps.
    const gap1 = xs[1] - (xs[0] + elements()[0].width);
    const gap2 = xs[2] - (xs[1] + elements()[1].width);
    expect(gap1).toBeCloseTo(gap2, 6);

    // Already distributed => true no-op (R-2.9).
    expect(runWireframeAction('wireframe.arrange.distribute')).toBe(false);
  });

  it('distribute is a false no-op with fewer than three selected (R-2.7)', () => {
    seed([
      { x: 0, y: 0, width: 40, height: 40 },
      { x: 100, y: 0, width: 20, height: 40 },
    ]);
    expect(runWireframeAction('wireframe.arrange.distribute')).toBe(false);
  });

  it('distribute with three selected but only two movable is a false no-op (R-2.8)', () => {
    const [a, b, c] = seed([
      { x: 0, y: 0, width: 40, height: 40 },
      { x: 100, y: 0, width: 20, height: 40 },
      { x: 200, y: 0, width: 40, height: 40 },
    ]);
    lock(c);
    selectMany([a, b, c]);
    expect(runWireframeAction('wireframe.arrange.distribute')).toBe(false);
    expect(elements().map((element) => element.x)).toEqual([0, 100, 200]);
  });

  it('bringForward / sendBackward move the selection in paint order (R-2.6)', () => {
    const [a, b] = seed([
      { x: 0, y: 0, width: 40, height: 40 },
      { x: 100, y: 0, width: 40, height: 40 },
    ]);

    select(a);
    expect(runWireframeAction('wireframe.arrange.bringForward')).toBe(true);
    expect(elements().map((element) => element.id)).toEqual([b, a]);

    select(a);
    expect(runWireframeAction('wireframe.arrange.sendBackward')).toBe(true);
    expect(elements().map((element) => element.id)).toEqual([a, b]);
  });

  it('bringForward / sendBackward are false no-ops when empty or clamped (R-2.7/R-2.9)', () => {
    expect(runWireframeAction('wireframe.arrange.bringForward')).toBe(false);
    expect(runWireframeAction('wireframe.arrange.sendBackward')).toBe(false);

    const [a, b] = seed([
      { x: 0, y: 0, width: 40, height: 40 },
      { x: 100, y: 0, width: 40, height: 40 },
    ]);
    // Top element cannot move forward; bottom cannot move backward.
    select(b);
    expect(runWireframeAction('wireframe.arrange.bringForward')).toBe(false);
    select(a);
    expect(runWireframeAction('wireframe.arrange.sendBackward')).toBe(false);
    expect(elements().map((element) => element.id)).toEqual([a, b]);
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
