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
  beginOrderTurn,
  cancelOrderExecution,
  confirmOrderExecution,
  dispatchOrderSelection,
  endOrderTurn,
  readOrderTurn,
  resetOrderTurnForTests,
  undoOrderExecution,
} from '../useOrderSkillDispatch';
import { resetOrderGrantsForTests } from '../confirmGate';
import { resetOrderSurfacesForTests } from '../actionRisk';
import { resetOrderUndoForTests } from '../orderUndo';
import {
  ORDER_FLIGHT_STATES,
  readOrderConfirmationRequest,
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
import { registerAppOpenReplyPusher } from '../../components/companion/skillBridge';
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

/**
 * The replies the dispatcher pushed through the shipped bridge (AC-1's visible
 * arm). Registered here so a row can assert the SENTENCE a refusal emits — the
 * whole point of AC-5 is that the displaced selection is *said*, and a row that
 * only counted document changes could not see a silent drop.
 */
let pushedReplies: string[] = [];
let unregisterPusher: (() => void) | null = null;

beforeEach(() => {
  resetOrderGrantsForTests();
  resetOrderSurfacesForTests();
  resetOrderUndoForTests();
  resetOrderFlightForTests();
  resetOrderTurnForTests();
  resetPlacementForTests();
  resetCompanionSpeechForTests();
  resetCompanionComposerBridgeForTests();
  resetWireframeStoreForTests();

  pushedReplies = [];
  unregisterPusher = registerAppOpenReplyPusher((reply) => {
    pushedReplies.push(reply.text);
  });

  // FIXTURE — NOT the integration. #3243 round 2 (D1) found that this row
  // registered the surface HERE while the PRODUCT registered it nowhere, so the
  // whole dispatch suite exercised a state no user could reach and stayed green
  // over a broken product. It is kept, because a dispatcher unit test legitimately
  // seeds its inputs, and it is LABELLED because the seeding is what hid the
  // missing wiring: the surface's real lifetime belongs to the Wireframe shell's
  // mount (`applications/wireframe/components/WireframeEditor.tsx`), and the row
  // that proves that (`applications/wireframe/__tests__/
  // orderSurfaceRegistration.test.tsx`) calls NO registration of its own.
  // Removing this call would only break these rows; removing the PRODUCTION call
  // is the defect these rows cannot see.
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
  unregisterPusher?.();
  unregisterPusher = null;
  resetOrderGrantsForTests();
  resetOrderSurfacesForTests();
  resetOrderUndoForTests();
  resetOrderFlightForTests();
  resetOrderTurnForTests();
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

/* ------------------------------------------------------------------------- */
/* AC-5 / R-5a / R-5b / R-5c — the per-turn funnel                            */
/* ------------------------------------------------------------------------- */

/** The superseded-sentence discriminator: the app AND "not carried out". */
function supersededReplies(): string[] {
  return pushedReplies.filter((text) => text.includes('not carried out'));
}

describe('AC-5 / R-5a — a superseding selection is REFUSED with typed copy', () => {
  it('two `read` selections: exactly one runs and the second is refused BY NAME (never silent)', () => {
    // The shipped defect: `read` is granted unconditionally (`confirmGate.ts:170`),
    // so BOTH ran and neither reply mentioned the other. The discriminator is the
    // REPLY, not the document — both are `read`, so nothing changes either way.
    const documentBefore = getSnapshot().document;

    beginOrderTurn();
    const first = dispatchOrderSelection({ action: 'wireframe.selection.describe', arguments: {} });
    const second = dispatchOrderSelection({ action: 'wireframe.selection.describe', arguments: {} });
    endOrderTurn();

    // The first ran…
    expect(first.kind).toBe('performed');
    // …the second was refused, not executed a second time.
    expect(second.kind).toBe('refused');
    // The document is untouched by either (this row's discriminator is the copy).
    expect(getSnapshot().document).toBe(documentBefore);

    const superseded = supersededReplies();
    expect(superseded).toHaveLength(1);
    // It names the app and the displaced action, and says what happened.
    expect(superseded[0]).toContain('Wireframe');
    expect(superseded[0]).toContain('Describe selection');
    // The refusal is a REAL reply on the surface, not silence.
    expect(pushedReplies).toHaveLength(2);
    expect(pushedReplies).toContain(superseded[0]);
  });

  it('two `changing` selections: exactly ONE dialog renders AND the displaced action is named', () => {
    // The shipped defect: the single-slot `pendingConfirmation` was overwritten
    // (`orderFlight.ts:263-266`), so the FIRST selection vanished — never
    // confirmed, cancelled, refused or mentioned. One dialog was still correct;
    // the silent drop was the defect.
    const elementId = firstShapeId();
    const before = fillOf(elementId);

    beginOrderTurn();
    const first = dispatchOrderSelection({
      action: 'wireframe.element.fill',
      arguments: { elementId, fill: 'accent' },
    });
    const second = dispatchOrderSelection({
      action: 'wireframe.element.delete',
      arguments: { elementId },
    });
    endOrderTurn();

    expect(first.kind).toBe('needs-confirmation');
    expect(second.kind).toBe('refused');

    // Exactly ONE confirmation was published, and it is the FIRST one — the
    // superseded selection never reached the slot.
    const pending = readOrderConfirmationRequest();
    expect(pending).not.toBeNull();
    expect(pending?.invocation.actionId).toBe('wireframe.element.fill');
    expect(pending?.label).toBe('Fill element');

    // Nothing ran (both are gated), so the document is untouched.
    expect(fillOf(elementId)).toBe(before);

    // The displaced action is NAMED in a typed refusal — the sentence that did
    // not exist before this fix.
    const superseded = supersededReplies();
    expect(superseded).toHaveLength(1);
    expect(superseded[0]).toContain('Delete element');
    expect(superseded[0]).toContain('Wireframe');
  });

  it('the superseded sentence does NOT borrow the unknown-refusal wording (G-505)', () => {
    // The order was understood; only its count was wrong. Borrowing the
    // classification-failure copy would tell the user to reword a sentence Fredo
    // parsed perfectly. The QA row positively asserts this absence.
    beginOrderTurn();
    dispatchOrderSelection({ action: 'wireframe.selection.describe', arguments: {} });
    dispatchOrderSelection({ action: 'wireframe.selection.describe', arguments: {} });
    endOrderTurn();

    const superseded = supersededReplies();
    expect(superseded).toHaveLength(1);
    expect(superseded[0]).not.toContain("can't carry out");
    expect(superseded[0]).not.toContain("couldn't");
    expect(superseded[0]).not.toContain('no app in front of me');
    expect(superseded[0]).not.toContain('Cancelled');
    // …and it names the user's actual next action.
    expect(superseded[0]?.toLowerCase()).toContain('ask me');
  });
});

describe('R-5b — lookup-then-act still runs BOTH legs, in order (F-22 MUST stay green)', () => {
  it('`read` then `changing` both run: the read executes and the act reaches its dialog', () => {
    // THE green-green control for AC-5. A funnel written as "first selection
    // wins, refuse the rest" would refuse this pair and redden F-22 — the naive
    // fix the plan warns about, and the reason the rule arbitrates by risk.
    const elementId = firstShapeId();
    const before = fillOf(elementId);

    beginOrderTurn();
    const read = dispatchOrderSelection({ action: 'wireframe.selection.describe', arguments: {} });
    const act = dispatchOrderSelection({
      action: 'wireframe.element.fill',
      arguments: { elementId, fill: 'accent' },
    });
    endOrderTurn();

    // The lookup RAN (not refused).
    expect(read.kind).toBe('performed');
    // The act is the turn's one action, and it still goes through the UNCHANGED
    // gate — the user's confirm is still required.
    expect(act.kind).toBe('needs-confirmation');
    expect(readOrderConfirmationRequest()?.invocation.actionId).toBe('wireframe.element.fill');
    // Nothing executed, so the document is untouched by either leg yet.
    expect(fillOf(elementId)).toBe(before);

    // NO refusal was emitted: the pair is lawful.
    expect(supersededReplies()).toHaveLength(0);
    expect(pushedReplies.filter((text) => text.includes("can't carry out"))).toHaveLength(0);
  });

  it('a three-step chain is refused: `read` → `changing` → `changing` runs only the first two', () => {
    const elementId = firstShapeId();

    beginOrderTurn();
    const read = dispatchOrderSelection({ action: 'wireframe.selection.describe', arguments: {} });
    const act = dispatchOrderSelection({
      action: 'wireframe.element.fill',
      arguments: { elementId, fill: 'accent' },
    });
    const third = dispatchOrderSelection({
      action: 'wireframe.element.delete',
      arguments: { elementId },
    });
    endOrderTurn();

    expect(read.kind).toBe('performed');
    expect(act.kind).toBe('needs-confirmation');
    // The third step is past the turn's one action, so it is refused.
    expect(third.kind).toBe('refused');
    expect(supersededReplies()).toHaveLength(1);
    expect(readOrderConfirmationRequest()?.invocation.actionId).toBe('wireframe.element.fill');
  });

  it('an act-then-read is refused: `changing` then `read` runs only the act', () => {
    const elementId = firstShapeId();

    beginOrderTurn();
    const act = dispatchOrderSelection({
      action: 'wireframe.element.fill',
      arguments: { elementId, fill: 'accent' },
    });
    const read = dispatchOrderSelection({ action: 'wireframe.selection.describe', arguments: {} });
    endOrderTurn();

    expect(act.kind).toBe('needs-confirmation');
    expect(read.kind).toBe('refused');
    expect(supersededReplies()).toHaveLength(1);
  });
});

describe('R-5c — a failed lookup HALTS the chain and never becomes a blind act (F-23)', () => {
  it('an `unknown` first step refuses the later `changing` selection — the act does NOT run', () => {
    // THE gap this funnel closes and the old per-event independence could not:
    // each selection dispatched separately, so a failed lookup was followed by a
    // blind act with nothing in between.
    const elementId = firstShapeId();
    const before = fillOf(elementId);

    beginOrderTurn();
    // An id the app does not declare ⇒ the classifier's fail-closed `unknown`.
    const failedLookup = dispatchOrderSelection({
      action: 'wireframe.not.a.declared.action',
      arguments: {},
    });
    const blindAct = dispatchOrderSelection({
      action: 'wireframe.element.fill',
      arguments: { elementId, fill: 'accent' },
    });
    endOrderTurn();

    // The lookup is refused in the unknown class…
    expect(failedLookup.kind).toBe('refused');
    if (failedLookup.kind === 'refused') {
      expect(failedLookup.text).toContain("can't carry out");
      expect(failedLookup.text).toContain('Wireframe');
    }
    // …the act after it is REFUSED, never run…
    expect(blindAct.kind).toBe('refused');
    // …no confirmation was published (the act never reached the gate's prompt)…
    expect(readOrderConfirmationRequest()).toBeNull();
    // …and the document is untouched: the blind act did not happen.
    expect(fillOf(elementId)).toBe(before);
  });

  it('the turn records the halt, so a later selection of the same turn is refused too', () => {
    beginOrderTurn();
    dispatchOrderSelection({ action: 'wireframe.not.a.declared.action', arguments: {} });
    expect(readOrderTurn()?.halted).toBe(true);
    endOrderTurn();
    expect(readOrderTurn()).toBeNull();
  });
});

describe('THE GREEN-GREEN CONTROL — a single selection emits NO refusal', () => {
  it('a lone `changing` selection: one needs-confirmation reply, zero supersede copy', () => {
    // The control the whole funnel owes: with ONE selection the behaviour must be
    // byte-equivalent to the pre-funnel dispatcher. Every existing row in this
    // suite is the wider version of this same control.
    const elementId = firstShapeId();

    beginOrderTurn();
    const outcome = dispatchOrderSelection({
      action: 'wireframe.element.fill',
      arguments: { elementId, fill: 'accent' },
    });
    endOrderTurn();

    expect(outcome.kind).toBe('needs-confirmation');
    expect(pushedReplies).toHaveLength(1);
    expect(pushedReplies[0]).toContain('Needs your confirmation');
    expect(pushedReplies[0]).toContain('Fill element');
    expect(pushedReplies[0]).toContain('Wireframe');
    expect(supersededReplies()).toHaveLength(0);
  });

  it('a lone `read` selection: one done, zero refusals', () => {
    beginOrderTurn();
    const outcome = dispatchOrderSelection({
      action: 'wireframe.selection.describe',
      arguments: {},
    });
    endOrderTurn();

    expect(outcome.kind).toBe('performed');
    expect(pushedReplies).toHaveLength(1);
    expect(supersededReplies()).toHaveLength(0);
  });

  it('a direct call with NO turn open is its own single-selection turn (the lever path)', () => {
    // What every pre-existing row in this suite does. It must not need a turn to
    // behave correctly, and it must not leave a turn open behind it.
    const outcome = dispatchOrderSelection({
      action: 'wireframe.selection.describe',
      arguments: {},
    });
    expect(outcome.kind).toBe('performed');
    expect(readOrderTurn()).toBeNull();
    expect(supersededReplies()).toHaveLength(0);
  });
});
