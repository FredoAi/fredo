/**
 * Spec #3243 ST-6 × ST-4 — the undo registry driving the REAL Wireframe inverse.
 *
 * `orderUndo.test.ts` pins the registry's own contract with synthetic records.
 * This suite pins the JOIN: a record registered from a real
 * `runWireframeOrder` executor, undone through the registry, must reach the
 * WIREFRAME DOCUMENT. That is the assertion a store-only pin cannot make
 * (G-520: "the registry says undone" passes a product that changed nothing).
 *
 * It is also the STALE-SAFE chain end to end (F-34): confirm an order, let the
 * USER make their own edit, then press the order's undo — the user's edit must
 * stand and the outcome must be `failed` (never a silent no-op).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  registerOrderUndo,
  resetOrderUndoForTests,
  undoLastOrder,
} from '../orderUndo';
import {
  WIREFRAME_DELETE_ACTION,
  WIREFRAME_FILL_ACTION,
  runWireframeOrder,
} from '../wireframeOrderSurface';
import { resetOrderSurfacesForTests } from '../actionRisk';
import { createDefaultElement } from '../../../applications/wireframe/model/elements';
import {
  dispatch,
  getSnapshot,
  resetWireframeStoreForTests,
  undo as undoWireframeStore,
} from '../../../applications/wireframe/store/wireframeDocumentStore';

beforeEach(() => {
  resetWireframeStoreForTests();
  resetOrderSurfacesForTests();
  resetOrderUndoForTests();
});

afterEach(() => {
  resetOrderUndoForTests();
});

function seedShape(id = 'shape-1'): string {
  const document = getSnapshot().document;
  const element = createDefaultElement('shape', { page: document.page, id });
  dispatch('element.add', { element });
  return id;
}

function fillOf(id: string): string | null {
  const element = getSnapshot().document.elements.find((entry) => entry.id === id);
  if (element === undefined || element.type !== 'shape') return null;
  return element.fill;
}

/** Run an order and register its undo (what ST-8's dispatcher does on a settle). */
function runAndRegister(actionId: string, args: Record<string, string>, label: string): void {
  const outcome = runWireframeOrder(actionId, args);
  if (outcome.undo !== undefined) {
    registerOrderUndo({ fingerprint: 'fp-test', label, undo: outcome.undo });
  }
}

describe('orderUndo × wireframe — the registry reaches the DOCUMENT (F-33)', () => {
  it('a registered fill order is undone through the app history: the DOCUMENT fill returns', () => {
    const id = seedShape();
    const before = fillOf(id);
    runAndRegister(WIREFRAME_FILL_ACTION.id, { elementId: id, fill: 'error' }, 'Fill element');
    expect(fillOf(id)).toBe('error');

    const outcome = undoLastOrder();
    expect(outcome.status).toBe('undone');
    expect(outcome.label).toBe('Fill element');
    // THE ORACLE IS THE DOCUMENT — a registry-only assertion passes the defect
    // world where nothing actually reverted.
    expect(fillOf(id)).toBe(before);
  });

  it('a registered delete order restores the element with its geometry (F-33 edge)', () => {
    const id = seedShape();
    const before = getSnapshot().document.elements.find((entry) => entry.id === id);
    runAndRegister(WIREFRAME_DELETE_ACTION.id, { elementId: id }, 'Delete element');
    expect(getSnapshot().document.elements.some((entry) => entry.id === id)).toBe(false);

    expect(undoLastOrder().status).toBe('undone');
    const restored = getSnapshot().document.elements.find((entry) => entry.id === id);
    expect(restored).toBeDefined();
    expect(restored?.x).toBe(before?.x);
    expect(restored?.y).toBe(before?.y);
    expect(restored?.width).toBe(before?.width);
    expect(restored?.height).toBe(before?.height);
  });

  it('a NON-undoable action registers NO record (its warning already ran)', () => {
    // `wireframe.document.new` is undoable:false by declaration, so its outcome
    // carries no closure and nothing may be registered for it.
    const outcome = runWireframeOrder('wireframe.document.new', { preset: 'desktop' });
    expect(outcome.status).toBe('performed');
    expect(outcome.undo).toBeUndefined();
    // The dispatcher's contract: register only when a closure exists.
    if (outcome.undo !== undefined) {
      registerOrderUndo({ fingerprint: 'fp', label: 'Create a new document', undo: outcome.undo });
    }
    expect(undoLastOrder().status).toBe('nothing');
  });
});

describe('orderUndo × wireframe — STALE-SAFETY end to end (F-34)', () => {
  it("the user's OWN later edit makes the order's undo FAIL and the edit STANDS", () => {
    const id = seedShape();
    // (1) the order's change.
    runAndRegister(WIREFRAME_FILL_ACTION.id, { elementId: id, fill: 'error' }, 'Fill element');
    expect(fillOf(id)).toBe('error');
    // (2) the USER's own edit through the app's own funnel.
    dispatch('elements.update', { patches: { [id]: { fill: 'success' } } });
    const userFill = fillOf(id);
    expect(userFill).toBe('success');
    // (3) the order's undo: must NOT revert the user's edit.
    const outcome = undoLastOrder();
    expect(outcome.status).toBe('failed');
    expect(outcome.label).toBe('Fill element');
    // The user's work STANDS — the single worst outcome, prevented.
    expect(fillOf(id)).toBe(userFill);
  });

  it("the user pressing the APP's own Undo first makes the order report `failed`", () => {
    const id = seedShape();
    const preOrder = fillOf(id);
    runAndRegister(WIREFRAME_FILL_ACTION.id, { elementId: id, fill: 'error' }, 'Fill element');
    expect(fillOf(id)).toBe('error');
    // The user takes a step back with the app's OWN control (the shipped store
    // `undo()` the Wireframe Undo button runs) — their own action, done first.
    undoWireframeStore();
    // The app's undo reverted the change back to the pre-order value.
    expect(fillOf(id)).toBe(preOrder);
    const outcome = undoLastOrder();
    // Our entry now sits in the redo tail, so the order must NOT claim an undo:
    // it reports `failed`, and it certainly did not revert anything a second time.
    expect(outcome.status).toBe('failed');
    expect(fillOf(id)).toBe(preOrder);
  });

  it('two orders then a user edit: only the LAST order reports undone', () => {
    const id = seedShape();
    runAndRegister(WIREFRAME_FILL_ACTION.id, { elementId: id, fill: 'accent' }, 'Fill element');
    runAndRegister(WIREFRAME_FILL_ACTION.id, { elementId: id, fill: 'warning' }, 'Fill element');
    dispatch('elements.update', { patches: { [id]: { fill: 'info' } } });
    const userFill = fillOf(id);

    // The newest order record is superseded by the user's edit.
    expect(undoLastOrder().status).toBe('failed');
    // And the user's edit still stands.
    expect(fillOf(id)).toBe(userFill);
  });
});
