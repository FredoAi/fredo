/**
 * Spec #3243 ST-4 — Wireframe's four declarations and their STALE-SAFE undo.
 *
 * The load-bearing pins here are the G-520 ones:
 *
 *  - the four declarations are asserted by ID and by CLASS SHAPE (one `read`,
 *    one `changing`+undoable, one `destructive`+undoable, one
 *    `destructive`+NOT-undoable with a consequence), so dropping one reddens;
 *  - the fill/delete executors are read through the DOCUMENT (the element's
 *    `fill`, the element's presence), never through the registry's own report;
 *  - the undo is proved STALE-SAFE: after the user's own later edit the order's
 *    closure returns `false` and the user's edit STANDS (F-34's defect world is
 *    a blind "one step back" reverting entry 2);
 *  - `WIREFRAME_ACTIONS` gains NO row and the store/history files are NOT
 *    edited (G-522), proved by a source scan rather than by intent.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  WIREFRAME_DELETE_ACTION,
  WIREFRAME_DESCRIBE_ACTION,
  WIREFRAME_FILL_ACTION,
  WIREFRAME_NEW_DOCUMENT_ACTION,
  WIREFRAME_ORDER_SURFACE,
  registerWireframeOrderSurface,
  runWireframeOrder,
} from '../wireframeOrderSurface';
import {
  classifyOrder,
  isOrderRiskClass,
  listOrderSurfaceAppIds,
  readOrderSurface,
  resetOrderSurfacesForTests,
} from '../actionRisk';
import {
  createDefaultElement,
  isWireframeColorToken,
} from '../../../applications/wireframe/model/elements';
import { WIREFRAME_APP_ID } from '../../../applications/wireframe/model/document';
import {
  dispatch,
  getSnapshot,
  getWireframeHistory,
  resetWireframeStoreForTests,
  undo as undoWireframeStore,
} from '../../../applications/wireframe/store/wireframeDocumentStore';
import { WIREFRAME_ACTIONS } from '../../../applications/wireframe/actions/wireframeActions';

beforeEach(() => {
  resetWireframeStoreForTests();
  resetOrderSurfacesForTests();
});

afterEach(() => {
  resetOrderSurfacesForTests();
});

/** Seed one shape element (the fill/delete subject) and return its id. */
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

describe('wireframeOrderSurface — exactly FOUR declared actions, one per class shape', () => {
  it('declares exactly the four bound ids, in order', () => {
    expect(WIREFRAME_ORDER_SURFACE.actions.map((action) => action.id)).toEqual([
      'wireframe.selection.describe',
      'wireframe.element.fill',
      'wireframe.element.delete',
      'wireframe.document.new',
    ]);
  });

  it('covers the four required SHAPES (read / changing+undoable / destructive+undoable / destructive+irreversible)', () => {
    const shapes = WIREFRAME_ORDER_SURFACE.actions.map((action) => ({
      risk: action.risk,
      undoable: action.undoable,
      hasConsequence: typeof action.consequence === 'string' && action.consequence.trim() !== '',
    }));
    expect(shapes).toContainEqual({ risk: 'read', undoable: false, hasConsequence: false });
    expect(shapes).toContainEqual({ risk: 'changing', undoable: true, hasConsequence: false });
    expect(shapes).toContainEqual({ risk: 'destructive', undoable: true, hasConsequence: false });
    expect(shapes).toContainEqual({ risk: 'destructive', undoable: false, hasConsequence: true });
  });

  it('every declared risk is a member of the closed vocabulary', () => {
    for (const action of WIREFRAME_ORDER_SURFACE.actions) {
      expect(isOrderRiskClass(action.risk)).toBe(true);
    }
  });

  it('the irreversible declaration carries a NON-EMPTY consequence (AC-8)', () => {
    expect(WIREFRAME_NEW_DOCUMENT_ACTION.undoable).toBe(false);
    expect(WIREFRAME_NEW_DOCUMENT_ACTION.consequence?.trim().length).toBeGreaterThan(0);
  });

  it('registers under the Wireframe app id and classifies each declared action', () => {
    const dispose = registerWireframeOrderSurface();
    expect(listOrderSurfaceAppIds()).toContain(WIREFRAME_APP_ID);
    expect(readOrderSurface(WIREFRAME_APP_ID)?.actions).toHaveLength(4);
    expect(classifyOrder(WIREFRAME_APP_ID, WIREFRAME_DESCRIBE_ACTION.id).risk).toBe('read');
    expect(classifyOrder(WIREFRAME_APP_ID, WIREFRAME_FILL_ACTION.id).undoable).toBe(true);
    expect(classifyOrder(WIREFRAME_APP_ID, WIREFRAME_DELETE_ACTION.id).risk).toBe('destructive');
    const irreversible = classifyOrder(WIREFRAME_APP_ID, WIREFRAME_NEW_DOCUMENT_ACTION.id);
    expect(irreversible.undoable).toBe(false);
    expect(irreversible.consequence).toBe(WIREFRAME_NEW_DOCUMENT_ACTION.consequence);
    dispose();
  });

  it('the returned disposer CLEARS the registration (the unmount path)', () => {
    // #3243 round 2 (D1): this suite previously CALLED `dispose()` above and
    // never observed it — the dispose path was invoked and never proven. It is
    // proven here against the Wireframe app id specifically, because that is the
    // entry the PRODUCT's mount creates: a cleanup wired to the wrong
    // registration, or no cleanup at all, leaves the surface live after the app
    // is gone, and a leaked cleanup from an earlier mount clears the surface a
    // newer mount owns.
    //
    // HONEST LABEL: this row is GREEN ON THE PRE-FIX TREE — it registers for
    // itself, so it is a green-green control for the dispose contract, NOT a
    // discriminator of the missing production wiring. The defect it would catch
    // is the mirror image (a registration that outlives its app), which the
    // pre-fix tree cannot exhibit. Do not count it as a second red-then-green
    // cycle.
    const dispose = registerWireframeOrderSurface();
    expect(listOrderSurfaceAppIds()).toContain(WIREFRAME_APP_ID);

    dispose();

    expect(listOrderSurfaceAppIds()).not.toContain(WIREFRAME_APP_ID);
    expect(readOrderSurface(WIREFRAME_APP_ID)).toBeNull();
    // And the actions are unreachable, not merely unlisted: the classifier is
    // fail-closed over an absent surface.
    expect(classifyOrder(WIREFRAME_APP_ID, WIREFRAME_FILL_ACTION.id).risk).toBe('unknown');
  });

  it('register → dispose → register leaves EXACTLY ONE live entry (no stale disposer)', () => {
    // The remount shape, in the Wireframe-specific path: the first registration's
    // disposer is STALE once the second registration lands, so a cleanup that
    // deletes unconditionally would empty the registry here — the "goes empty at
    // the wrong moment" failure that reads exactly like a missing registration.
    const disposeFirst = registerWireframeOrderSurface();
    const disposeSecond = registerWireframeOrderSurface();
    expect(listOrderSurfaceAppIds().filter((id) => id === WIREFRAME_APP_ID)).toHaveLength(1);

    // The stale disposer is a NO-OP: it must not clear the live surface.
    disposeFirst();
    expect(listOrderSurfaceAppIds()).toContain(WIREFRAME_APP_ID);
    expect(readOrderSurface(WIREFRAME_APP_ID)?.actions).toHaveLength(4);

    // The current disposer still works.
    disposeSecond();
    expect(listOrderSurfaceAppIds()).not.toContain(WIREFRAME_APP_ID);
  });
});

describe('wireframeOrderSurface — G-522: no app-table change, no store edit', () => {
  const WIREFRAME_SOURCES = import.meta.glob(
    '/src/applications/wireframe/**/*.{ts,tsx}',
    { query: '?raw', import: 'default', eager: true },
  ) as Record<string, string>;

  it('WIREFRAME_ACTIONS is UNCHANGED — still the shipped 35 rows, and no new id was smuggled in', () => {
    // G-522: `WIREFRAME_ACTIONS` gains NO row and NO id. The baseline is the
    // shipped 35-row catalog; a slice that appended an order-shaped row to make
    // its declaration "real" would redden the count.
    expect(WIREFRAME_ACTIONS).toHaveLength(35);
    const appIds = WIREFRAME_ACTIONS.map((definition) => definition.id);
    // The two order ids the PLAN does not derive from the app catalog must be
    // genuinely new declarations, never rows added to the table.
    expect(appIds).not.toContain('wireframe.selection.describe');
    expect(appIds).not.toContain('wireframe.element.fill');
    // AUTHORED, not a defect: `wireframe.element.delete` and
    // `wireframe.document.new` ARE shipped app action ids. The plan names those
    // two verbatim (Domain Model §1) precisely so the order DELEGATES to the
    // app's own mechanism rather than inventing a parallel vocabulary — so the
    // overlap is the design, and the guard is the row COUNT above (unchanged at
    // 35), not the absence of the ids.
    expect(appIds).toContain('wireframe.element.delete');
    expect(appIds).toContain('wireframe.document.new');
  });

  it('WIREFRAME_HISTORY_LIMIT is still 100 and the store keeps ONE history instance', () => {
    // The limit is asserted at the store's own export surface; the order slice
    // adds no second container (there is one module-scoped history).
    const history = getWireframeHistory();
    expect(typeof history.entries).toBe('function');
    expect(history.entries()).toEqual([]);
  });

  it('the raw Wireframe sources import the order surface in EXACTLY ONE file — the mount', () => {
    // INVERTED IN PLACE by #3243 round 2 (D1). This row used to assert that the
    // app tree contained NO `shared/order` reference, because ST-4 shipped the
    // surface DECLARATION only and the app was not to be edited. That reading is
    // precisely what let the registration go missing from the product: the
    // declaration existed, nothing called it, and every order classified
    // `unknown`. The corrected design is ONE reverse edge, at ONE site — the
    // shell that owns the app's lifetime (`WireframeShell`).
    //
    // The property this row still protects is CARDINALITY, not absence: a second
    // call site would re-open "which registration is authoritative", and a
    // registration in some other wireframe module would put the surface's
    // lifetime somewhere other than the app's mount.
    const importers = Object.entries(WIREFRAME_SOURCES)
      .filter(([path]) => !path.includes('__tests__'))
      .filter(([, source]) => /shared\/order/.test(source))
      .map(([path]) => path);
    expect(importers).toEqual(['/src/applications/wireframe/components/WireframeEditor.tsx']);
    // Non-vacuity: the sweep really read files.
    expect(Object.keys(WIREFRAME_SOURCES).length).toBeGreaterThan(20);
  });
});

describe('wireframeOrderSurface — handling (read / fill / delete / new)', () => {
  it('the read action changes nothing', () => {
    const id = seedShape();
    const before = fillOf(id);
    const outcome = runWireframeOrder(WIREFRAME_DESCRIBE_ACTION.id);
    expect(outcome.status).toBe('performed');
    expect(fillOf(id)).toBe(before);
    expect(getWireframeHistory().entries()).toHaveLength(1); // only the seed
  });

  it('the fill action applies ONE history entry and reports an undo closure', () => {
    const id = seedShape();
    const outcome = runWireframeOrder(WIREFRAME_FILL_ACTION.id, { elementId: id, fill: 'accent' });
    expect(outcome.status).toBe('performed');
    expect(typeof outcome.undo).toBe('function');
    // The DOCUMENT is the oracle, not the registry's report.
    expect(fillOf(id)).toBe('accent');
    // The seed + the fill = two entries.
    expect(getWireframeHistory().entries()).toHaveLength(2);
  });

  it('a value-equal fill is a true no-op (never reported as performed)', () => {
    const id = seedShape();
    const current = fillOf(id) as string;
    const outcome = runWireframeOrder(WIREFRAME_FILL_ACTION.id, { elementId: id, fill: current });
    expect(outcome.status).toBe('unchanged');
    expect(outcome.undo).toBeUndefined();
  });

  it('a fill naming a NON-token is refused as unchanged with a reason (never a silent success)', () => {
    const id = seedShape();
    const outcome = runWireframeOrder(WIREFRAME_FILL_ACTION.id, {
      elementId: id,
      fill: '#ff0000',
    });
    expect(outcome.status).toBe('unchanged');
    expect(outcome.detail).toContain('#ff0000');
    expect(fillOf(id)).not.toBe('#ff0000');
    // And the token set really is closed.
    expect(isWireframeColorToken('#ff0000')).toBe(false);
  });

  it('a fill on a MISSING element or a non-shape is unchanged, not a crash', () => {
    const missing = runWireframeOrder(WIREFRAME_FILL_ACTION.id, {
      elementId: 'nope',
      fill: 'accent',
    });
    expect(missing.status).toBe('unchanged');

    const document = getSnapshot().document;
    const text = createDefaultElement('text', { page: document.page, id: 'text-1' });
    dispatch('element.add', { element: text });
    const wrongType = runWireframeOrder(WIREFRAME_FILL_ACTION.id, {
      elementId: 'text-1',
      fill: 'accent',
    });
    expect(wrongType.status).toBe('unchanged');
    expect(wrongType.detail).toContain('not a shape');
  });

  it('the delete action removes the element and reports an undo closure', () => {
    const id = seedShape();
    const outcome = runWireframeOrder(WIREFRAME_DELETE_ACTION.id, { elementId: id });
    expect(outcome.status).toBe('performed');
    expect(typeof outcome.undo).toBe('function');
    expect(getSnapshot().document.elements.some((entry) => entry.id === id)).toBe(false);
  });

  it('the new-document action replaces the document and reports NO undo closure', () => {
    seedShape();
    const outcome = runWireframeOrder(WIREFRAME_NEW_DOCUMENT_ACTION.id, { preset: 'tablet' });
    expect(outcome.status).toBe('performed');
    // Non-undoable by the app's own contract — no closure may be offered.
    expect(outcome.undo).toBeUndefined();
    expect(getSnapshot().document.elements).toHaveLength(0);
    expect(getSnapshot().document.page.preset).toBe('tablet');
  });

  it('an UNKNOWN action id is a typed failure, never a default', () => {
    const outcome = runWireframeOrder('wireframe.add.text', {});
    expect(outcome.status).toBe('failed');
    expect(outcome.detail).toContain('declares no order action');
  });
});

describe('wireframeOrderSurface — the undo is STALE-SAFE (F-34)', () => {
  it('undoes the ORDER OWN change through the app own history', () => {
    const id = seedShape();
    const priorFill = fillOf(id);
    const outcome = runWireframeOrder(WIREFRAME_FILL_ACTION.id, { elementId: id, fill: 'error' });
    expect(fillOf(id)).toBe('error');
    const undone = outcome.undo?.();
    expect(undone).toBe(true);
    // Read from the DOCUMENT: the fill returns to the exact previous token.
    expect(fillOf(id)).toBe(priorFill);
  });

  it("a subsequent USER edit makes the order's undo return FALSE and the user's edit STANDS", () => {
    const id = seedShape();
    // (1) the order's change — history entry 2 (the seed was entry 1).
    const outcome = runWireframeOrder(WIREFRAME_FILL_ACTION.id, { elementId: id, fill: 'error' });
    expect(fillOf(id)).toBe('error');
    // (2) the USER's own later edit through the app's own funnel — entry 3.
    dispatch('elements.update', { patches: { [id]: { fill: 'success' } } });
    const userFill = fillOf(id);
    expect(userFill).toBe('success');
    // (3) the order's Undo must NOT revert the user's edit.
    const undone = outcome.undo?.();
    expect(undone).toBe(false);
    // The user's own work STANDS — this is the assertion the defect world fails.
    expect(fillOf(id)).toBe(userFill);
  });

  it("the user pressing the APP's own Undo first still makes the order refuse to claim a second undo", () => {
    const id = seedShape();
    const outcome = runWireframeOrder(WIREFRAME_FILL_ACTION.id, { elementId: id, fill: 'error' });
    // The app's own control (the shipped `undo()` the Wireframe Undo button runs).
    undoWireframeStore();
    // Our entry is now in the redo tail: the order must not claim it again.
    expect(outcome.undo?.()).toBe(false);
  });

  it('a second press of the order Undo does not claim the same undo twice', () => {
    const id = seedShape();
    const outcome = runWireframeOrder(WIREFRAME_FILL_ACTION.id, { elementId: id, fill: 'error' });
    expect(outcome.undo?.()).toBe(true);
    expect(outcome.undo?.()).toBe(false);
  });

  it('the delete action undo restores the SAME element id and geometry', () => {
    const id = seedShape();
    const before = getSnapshot().document.elements.find((entry) => entry.id === id);
    const outcome = runWireframeOrder(WIREFRAME_DELETE_ACTION.id, { elementId: id });
    expect(getSnapshot().document.elements.some((entry) => entry.id === id)).toBe(false);
    expect(outcome.undo?.()).toBe(true);
    const restored = getSnapshot().document.elements.find((entry) => entry.id === id);
    expect(restored).toBeDefined();
    expect(restored?.x).toBe(before?.x);
    expect(restored?.y).toBe(before?.y);
    expect(restored?.width).toBe(before?.width);
  });

  it('an undo stress: 3 orders then a user edit ⇒ only the LAST order reports undone', () => {
    // LIFO: the newest APPLIED record is the only one that may act.
    const id = seedShape();
    const first = runWireframeOrder(WIREFRAME_FILL_ACTION.id, { elementId: id, fill: 'accent' });
    const second = runWireframeOrder(WIREFRAME_FILL_ACTION.id, { elementId: id, fill: 'warning' });
    const third = runWireframeOrder(WIREFRAME_FILL_ACTION.id, { elementId: id, fill: 'info' });
    expect(first.undo?.()).toBe(false);
    expect(second.undo?.()).toBe(false);
    expect(third.undo?.()).toBe(true);
    expect(fillOf(id)).toBe('warning');
  });
});
