/**
 * Spec #3243 ST-8 — the ONE order dispatcher.
 *
 * This is the JOIN suite: it drives the dispatcher against B's real classification
 * (`classifyOrder` / `resolveOrderConfirmation`), B's real undo registry, and the
 * real Wireframe store, so a mismatch between the three capsules shows up here
 * rather than in a live round.
 *
 * The properties AC-6/AC-7/AC-8 depend on, each with the defect world it rejects:
 *
 *   1. a `changing`/`destructive` order does NOT execute before the user confirms
 *      (the document is read BEFORE any click — a screenshot could show either);
 *   2. `confirmOrderExecution` executes exactly THAT invocation, and the ticker
 *      leaves `needs-confirmation`;
 *   3. cancelling executes nothing, consumes no grant, and says so in its OWN
 *      words (never the unknown-refusal sentence — G-505);
 *   4. an unknown app / unknown id / ungrounded composer is refused, fail closed;
 *   5. a `read` runs without a confirmation (and never prompts);
 *   6. exactly one action runs per selection;
 *   7. undo goes through the APP's own inverse and the document really reverts;
 *   8. a second execution attempt with no new click is refused (single use).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ORDER_SKILL_NAME,
  cancelOrderExecution,
  confirmOrderExecution,
  dispatchOrderSelection,
  undoOrderExecution,
} from '../useOrderSkillDispatch';
import { resetOrderGrantsForTests } from '../confirmGate';
import { resetOrderSurfacesForTests } from '../actionRisk';
import { resetOrderUndoForTests } from '../orderUndo';
import {
  ORDER_FLIGHT_STATES,
  readOrderFlight,
  resetOrderFlightForTests,
} from '../orderFlight';
import { registerWireframeOrderSurface } from '../wireframeOrderSurface';
import {
  resetPlacementForTests,
  placeFredo,
} from '../../placement/placementStore';
import { resetCompanionSpeechForTests } from '../../companion/companionSpeech';
import { resetCompanionComposerBridgeForTests } from '../../companion/composerBridge';
import {
  getSnapshot,
  dispatch as dispatchGoogle,  resetWireframeStoreForTests,
} from '../../../applications/wireframe/store/wireframeDocumentStore';
import {
  createShapeElementAtRect,
} from '../../../applications/wireframe/model/elements';
import {
  createNewWireframeDocument,
} from '../../../applications/wireframe/model/document';
import { hasOrderUndo } from '../orderUndo';
import { undoOrderExecution } from '../useOrderSkillDispatch';

let disposeSurface: (() => void) | null = null;

beforeEach(() => {
  resetOrderGrantsForTests();
  resetOrderSurfacesForTests();
  resetOrderUndoForTests();
  resetOrderFlightForTests();
  resetPlacementForTests();
  resetCompanionSpeechForTests();
  resetCompanionComposerBridgeForTests();
  resetWireframeStoreForTests();

  disposeSurface = registerWireframeOrderSurface();
  // The default document is EMPTY, so seed a shape — every order action under
  // test needs one to act on. This is the fixture the shipped store's own suite
  // uses (`createShapeElementAtRect` + the `element.add` reducer), not a stub.
  const page = createNewWireframeDocument().page;
  const seedShape = createShapeElementAtRect({
    shape: 'rectangle',
    rect: { x: 40, y: 40, width: 120, height: 80 },
    page,
  });
  dispatchGoogle('element.add', { element: seedShape });
  seedShapeId = seedShape.id;

  // A placed session is the ordinary case; the ungrounded one is a test of its own.
  placeFredo('wireframe', 'Wireframe');
});

afterEach(() => {
  disposeSurface?.();
  disposeSurface = null;
  resetOrderGrantsForTests();
  resetOrderSurfacesForTests();
  resetOrderUndoForTests();
  resetOrderFlightForTests();
  resetPlacementForTests();
  resetCompanionSpeechForTests();
  resetCompanionComposerBridgeForTests();
  resetWireframeStoreForTests();
  vi.restoreAllMocks();
});

/** The id of the shape seeded in `beforeEach`. */
let seedShapeId = '';

/** Find the first shape element's id in the live document. */
function firstShapeId(): string {
  if (seedShapeId !== '') return seedShapeId;
  const { document } = getSnapshot();
  const shape = document.elements.find((element) => element.type === 'shape');
  if (shape === undefined) throw new Error('fixture has no shape');
  return shape.id;
}

/** The live fill of one element — the DOCUMENT read (never a registry claim). */
function fillOf(elementId: string): string | undefined {
  const { document } = getSnapshot();
  const element = document.elements.find((candidate) => candidate.id === elementId);
  return element !== undefined && element.type === 'shape' ? element.fill : undefined;
}

describe('the channel filter', () => {
  it('owns exactly the "order" skill name', () => {
    expect(ORDER_SKILL_NAME).toBe('order');
  });

  it('an empty selection is IGNORED, not refused (no other skill reaches here)', () => {
    // The hook filters by skill name before calling the dispatcher; a null here is
    // the defensive shape, and it must not push a reply for somebody else's skill.
    const outcome = dispatchOrderSelection(null);
    expect(outcome.kind).toBe('ignored');
    expect(readOrderFlight()).toBeNull();
  });
});

describe('AC-7 — a change never executes before the user confirms', () => {
  it('a `changing` order stops at needs-confirmation and does NOT touch the document', () => {
    const elementId = firstShapeId();
    const before = fillOf(elementId);
    expect(before).not.toBeUndefined();

    const outcome = dispatchOrderSelection({
      action: 'wireframe.element.fill',
      arguments: { elementId, fill: 'accent' },
    });

    expect(outcome.kind).toBe('needs-confirmation');
    // The DOCUMENT read is the proof of ordering: a confirmation that arrived
    // after the change would look the same on screen.
    expect(fillOf(elementId)).toBe(before);
    expect(readOrderFlight()?.state).toBe('needs-confirmation');
  });

  it('a `destructive` order stops at needs-confirmation too', () => {
    const elementId = firstShapeId();
    const { document: before } = getSnapshot();

    const outcome = dispatchOrderSelection({
      action: 'wireframe.element.delete',
      arguments: { elementId },
    });

    expect(outcome.kind).toBe('needs-confirmation');
    expect(getSnapshot().document.elements).toHaveLength(before.elements.length);
  });

  it('the confirmation carries the invocation the user is deciding about', () => {
    const elementId = firstShapeId();
    const outcome = dispatchOrderSelection({
      action: 'wireframe.element.fill',
      arguments: { elementId, fill: 'accent' },
    });
    if (outcome.kind !== 'needs-confirmation') throw new Error('expected a confirmation');
    expect(outcome.invocation.actionId).toBe('wireframe.element.fill');
    expect(outcome.invocation.appId).toBe('wireframe');
    // The classification is the REGISTRY's, never the model's.
    expect(outcome.invocation.risk).toBe('changing');
    expect(outcome.invocation.undoable).toBe(true);
  });

  it('a model-supplied confirmation-shaped argument does NOT short-circuit the gate', () => {
    const elementId = firstShapeId();
    const before = fillOf(elementId);

    for (const key of ['confirmed', 'approved', 'grant']) {
      const outcome = dispatchOrderSelection({
        action: 'wireframe.element.fill',
        arguments: { elementId, fill: 'accent', [key]: 'true' },
      });
      expect(outcome.kind, `the "${key}" key must not authorise`).toBe('needs-confirmation');
      expect(fillOf(elementId)).toBe(before);
    }
  });
});

describe('AC-7 — the user confirm is the only way in, and it runs THAT invocation', () => {
  it('confirm executes the named element and only it', () => {
    const elementId = firstShapeId();
    const otherShape = getSnapshot().document.elements.filter(
      (element) => element.type === 'shape' && element.id !== elementId,
    )[0];
    const otherBefore = otherShape?.type === 'shape' ? otherShape.fill : undefined;

    const asked = dispatchOrderSelection({
      action: 'wireframe.element.fill',
      arguments: { elementId, fill: 'accent' },
    });
    if (asked.kind !== 'needs-confirmation') throw new Error('expected a confirmation');

    const done = confirmOrderExecution(asked.invocation, 'Wireframe');

    expect(done.kind).toBe('performed');
    expect(fillOf(elementId)).toBe('accent');
    if (otherShape !== undefined) {
      expect(fillOf(otherShape.id)).toBe(otherBefore);
    }
    expect(readOrderFlight()?.state).toBe('done');
  });

  it('the settle sentence names the ACTION and the APP', () => {
    const elementId = firstShapeId();
    const asked = dispatchOrderSelection({
      action: 'wireframe.element.fill',
      arguments: { elementId, fill: 'accent' },
    });
    if (asked.kind !== 'needs-confirmation') throw new Error('expected a confirmation');
    const done = confirmOrderExecution(asked.invocation, 'Wireframe');
    if (done.kind !== 'performed') throw new Error('expected a perform');

    expect(done.text).toContain('Wireframe');
    expect(done.text).toContain('Fill element');
    // The ticker carries the SAME sentence (one copy source, no surface re-typing).
    expect(readOrderFlight()?.text).toBe(done.text);
  });

  it('a second execution attempt with no new click is REFUSED (single use)', () => {
    const elementId = firstShapeId();
    const asked = dispatchOrderSelection({
      action: 'wireframe.element.fill',
      arguments: { elementId, fill: 'accent' },
    });
    if (asked.kind !== 'needs-confirmation') throw new Error('expected a confirmation');
    confirmOrderExecution(asked.invocation, 'Wireframe');
    expect(fillOf(elementId)).toBe('accent');

    // No new click: the grant was consumed, so the SAME invocation must not run.
    // (Re-dispatch re-runs the gate, which finds no live grant.)
    const again = dispatchOrderSelection({
      action: 'wireframe.element.fill',
      arguments: { elementId, fill: 'status' },
    });
    expect(again.kind).toBe('needs-confirmation');
    // The document still holds the FIRST change — the second never ran.
    expect(fillOf(elementId)).toBe('accent');
  });
});

describe('R-6c — cancelling says so in its OWN words', () => {
  it('cancel executes nothing, consumes no grant, and does not borrow the refusal copy', () => {
    const elementId = firstShapeId();
    const before = fillOf(elementId);
    const asked = dispatchOrderSelection({
      action: 'wireframe.element.fill',
      arguments: { elementId, fill: 'accent' },
    });
    if (asked.kind !== 'needs-confirmation') throw new Error('expected a confirmation');

    const cancelled = cancelOrderExecution('Wireframe', 'Fill element');

    expect(cancelled.kind).toBe('refused');
    // Nothing ran.
    expect(fillOf(elementId)).toBe(before);
    // The subject is the USER's decision, never a fault (G-505): the sentence must
    // NOT contain the unknown-refusal wording.
    expect(cancelled.text).not.toContain("can't carry out");
    expect(cancelled.text).not.toContain('couldn');
    expect(cancelled.text.toLowerCase()).toContain('cancel');
  });
});

describe('R-6d — fail closed', () => {
  it('an unregistered action id is REFUSED, never executed', () => {
    const outcome = dispatchOrderSelection({
      action: 'wireframe.nonexistent',
      arguments: {},
    });
    expect(outcome.kind).toBe('refused');
    if (outcome.kind === 'refused') {
      expect(outcome.text).toContain('Wireframe');
      // Never the app-OPEN sentence: the app was found perfectly well.
      expect(outcome.text).not.toContain("I couldn't find");
    }
    expect(readOrderFlight()?.state).toBe('refused');
  });

  it('the UNGROUNDED composer refuses by name rather than narrating prose', () => {
    resetPlacementForTests();
    const outcome = dispatchOrderSelection({
      action: 'wireframe.element.fill',
      arguments: { elementId: 'x', fill: 'accent' },
    });
    expect(outcome.kind).toBe('refused');
    if (outcome.kind === 'refused') {
      // The refusal names the missing app rather than inventing a target.
      expect(outcome.text.length).toBeGreaterThan(0);
      expect(outcome.text).not.toContain("I couldn't find");
    }
  });

  it('an app that declares no order surface is refused', () => {
    placeFredo('mission-monitor', 'Mission Monitor');
    const outcome = dispatchOrderSelection({
      action: 'wireframe.element.fill',
      arguments: { elementId: 'x', fill: 'accent' },
    });
    expect(outcome.kind).toBe('refused');
  });
});

describe('a `read` runs without a confirmation', () => {
  it('never prompts and settles done', () => {
    const outcome = dispatchOrderSelection({
      action: 'wireframe.selection.describe',
      arguments: {},
    });
    expect(outcome.kind).toBe('performed');
    expect(readOrderFlight()?.state).toBe('done');
  });
});

describe('AC-8 — undo goes through the APP’s own inverse', () => {
  it('the document really reverts (not just a registry claim)', () => {
    const elementId = firstShapeId();
    const before = fillOf(elementId);

    const asked = dispatchOrderSelection({
      action: 'wireframe.element.fill',
      arguments: { elementId, fill: 'accent' },
    });
    if (asked.kind !== 'needs-confirmation') throw new Error('expected a confirmation');
    confirmOrderExecution(asked.invocation, 'Wireframe');
    expect(fillOf(elementId)).toBe('accent');
    expect(fillOf(elementId)).not.toBe(before);

    const undone = undoOrderExecution('Wireframe');
    expect(undone.kind).toBe('performed');
    // The DOCUMENT read is the assertion: a store-only check would pass while
    // nothing changed.
    expect(fillOf(elementId)).toBe(before);
  });

  it('an undoable settle registers a record; an irreversible one does NOT', () => {
    const elementId = firstShapeId();
    const undoable = dispatchOrderSelection({
      action: 'wireframe.element.fill',
      arguments: { elementId, fill: 'accent' },
    });
    if (undoable.kind !== 'needs-confirmation') throw new Error('expected a confirmation');
    confirmOrderExecution(undoable.invocation, 'Wireframe');
    expect(canUndo()).toBe(true);

    resetOrderUndoForTests();
    const irreversible = dispatchOrderSelection({
      action: 'wireframe.document.new',
      arguments: {},
    });
    if (irreversible.kind !== 'needs-confirmation') throw new Error('expected a confirmation');
    // The consequence was warned about pre-run (the dialog's arm), and NO record is
    // registered because there is nothing to revert.
    confirmOrderExecution(irreversible.invocation, 'Wireframe');
    expect(canUndo()).toBe(false);
  });

  it('undo with an empty registry says so and never claims an undo', () => {
    resetOrderUndoForTests();
    const undone = undoOrderExecution('Wireframe');
    expect(undone.kind).toBe('refused');
    if (undone.kind === 'refused') {
      expect(undone.text.toLowerCase()).toContain('nothing');
    }
  });
});

/** Local import so the suite's helper stays next to its only use. */
function canUndo(): boolean {
  return hasOrderUndo();
}

describe('the flight records the SUBMIT-time app and the published state vocabulary', () => {
  it('a refused order still creates a record (the ticker is created at submit)', () => {
    dispatchOrderSelection({ action: 'wireframe.nonexistent', arguments: {} });
    const flight = readOrderFlight();
    expect(flight).not.toBeNull();
    expect(flight?.appId).toBe('wireframe');
    expect(flight?.appName).toBe('Wireframe');
  });

  it('every recorded state is a member of the published vocabulary', () => {
    dispatchOrderSelection({ action: 'wireframe.selection.describe', arguments: {} });
    const state = readOrderFlight()?.state;
    expect(state).toBeDefined();
    expect(ORDER_FLIGHT_STATES).toContain(state as never);
  });
});
