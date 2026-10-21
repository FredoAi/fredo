/**
 * Wireframe Companion executor + reply copy (Spec #3070, ST-7, C4 / C9 /
 * R-6.1–R-6.5).
 *
 * Pins:
 *  - the deterministic `draftApp` script (navbar + heading + report card, no
 *    model-authored layout) and its selection clearing (UI/UX §4/§6);
 *  - `performed[]` honesty — including a mid-script failure reporting only the
 *    prior steps;
 *  - the unknown-id no-op (R-6.4) and the list reply (R-6.1);
 *  - the four C9 reply strings verbatim.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  WIREFRAME_DRAFT_APP_ID,
  WIREFRAME_DRAFT_STEPS,
  WIREFRAME_LIST_ACTIONS_ID,
  createWireframeCompanionOperations,
  executeWireframeIntent,
  type WireframeCompanionOperations,
  type WireframeIntentPayload,
} from '../actions/wireframeCompanion';
import {
  WIREFRAME_ACTIONS,
  registerWireframeFileActionHandlers,
  resetWireframeFileActionHandlersForTests,
  runWireframeAction,
} from '../actions/wireframeActions';
import {
  wireframeListReply,
  wireframeNothingChangedReply,
  wireframePerformedReply,
  wireframeUnknownActionReply,
} from '../actions/wireframeReply';
import type { WireframeElement } from '../model/elements';
import {
  getSnapshot,
  registerCanvasStage,
  resetWireframeStoreForTests,
} from '../store/wireframeDocumentStore';

function intent(action: string, args: Record<string, unknown> = {}): WireframeIntentPayload {
  return { requestId: 'request-1', action, arguments: { action, ...args } };
}

function elements(): WireframeElement[] {
  return getSnapshot().document.elements;
}

function immutableDocumentShape() {
  return {
    page: getSnapshot().document.page,
    elements: elements().map((element) => ({
      id: element.id,
      type: element.type,
      x: element.x,
      y: element.y,
      width: element.width,
      height: element.height,
    })),
    dirty: getSnapshot().dirty,
    canUndo: getSnapshot().canUndo,
    canRedo: getSnapshot().canRedo,
  };
}

/** Production operations with one step overridden (mid-script failure pin). */
function operationsWith(
  overrides: Partial<WireframeCompanionOperations>,
): WireframeCompanionOperations {
  return { ...createWireframeCompanionOperations(), ...overrides };
}

beforeEach(() => {
  resetWireframeStoreForTests();
  resetWireframeFileActionHandlersForTests();
});

afterEach(() => {
  resetWireframeFileActionHandlersForTests();
});

describe('the deterministic draftApp script (R-6.5 / C4)', () => {
  it('runs the four C4 steps and produces navbar + heading + report card', () => {
    const outcome = executeWireframeIntent(
      intent(WIREFRAME_DRAFT_APP_ID, { app_name: 'Reporter' }),
    );

    expect(outcome.performed).toEqual([...WIREFRAME_DRAFT_STEPS]);
    expect(WIREFRAME_DRAFT_STEPS).toEqual([
      'wireframe.document.new',
      'wireframe.add.section',
      'wireframe.add.text',
      'wireframe.add.card',
    ]);

    const snapshot = getSnapshot();
    expect(snapshot.document.page).toEqual({ preset: 'desktop', width: 1280, height: 800 });
    expect(snapshot.document.elements).toHaveLength(3);

    const [section, heading, card] = snapshot.document.elements;
    expect(section).toMatchObject({ type: 'section', preset: 'navbar', x: 0, y: 0 });
    expect(heading).toMatchObject({
      type: 'text',
      text: 'Reporter',
      textStyle: 'heading',
      size: 'xl',
      align: 'left',
    });
    expect(card).toMatchObject({ type: 'card', label: 'Reporter reports' });

    // UI/UX §4/§6 — the completed draft clears the selection.
    expect(snapshot.selectedId).toBeNull();
    expect(snapshot.dirty).toBe(true);
  });

  it('trims the app name and still produces the binding page', () => {
    executeWireframeIntent(intent(WIREFRAME_DRAFT_APP_ID, { app_name: '  Reporter  ' }));
    const heading = elements()[1];
    const card = elements()[2];
    expect(heading).toMatchObject({ type: 'text', text: 'Reporter' });
    expect(card).toMatchObject({ type: 'card', label: 'Reporter reports' });
  });

  it('performs nothing when app_name is missing or blank (nothing changed)', () => {
    runWireframeAction('wireframe.add.line');
    const before = immutableDocumentShape();

    for (const app_name of [undefined, '', '   ', 7]) {
      const outcome = executeWireframeIntent(intent(WIREFRAME_DRAFT_APP_ID, { app_name }));
      expect(outcome.performed).toEqual([]);
    }

    expect(immutableDocumentShape()).toEqual(before);
    expect(elements()).toHaveLength(1);
  });

  it('stops on a failing step and reports only the prior steps (R-6.3)', () => {
    const operations = operationsWith({
      addElement: (type, options) =>
        type === 'card' ? false : createWireframeCompanionOperations().addElement(type, options),
    });

    const outcome = executeWireframeIntent(
      intent(WIREFRAME_DRAFT_APP_ID, { app_name: 'Reporter' }),
      operations,
    );

    expect(outcome.performed).toEqual([
      'wireframe.document.new',
      'wireframe.add.section',
      'wireframe.add.text',
    ]);
    expect(elements()).toHaveLength(2);
    expect(elements().some((element) => element.type === 'card')).toBe(false);
    // A stopped script is NOT the complete binding draft -> selection remains.
    expect(getSnapshot().selectedId).not.toBeNull();
  });
});

describe('listActions (R-6.1)', () => {
  it('returns the full catalog text without mutating the document', () => {
    runWireframeAction('wireframe.add.text');
    const before = immutableDocumentShape();

    const outcome = executeWireframeIntent(intent(WIREFRAME_LIST_ACTIONS_ID));

    expect(outcome.performed).toEqual([]);
    expect(outcome.detail).toBe(wireframeListReply());
    for (const action of WIREFRAME_ACTIONS) {
      expect(outcome.detail).toContain(action.id);
      expect(outcome.detail).toContain(action.description);
    }
    expect(immutableDocumentShape()).toEqual(before);
  });
});

describe('executing a catalog action (R-6.2)', () => {
  it('runs a normal action through the ONE command table and reports its id', () => {
    const outcome = executeWireframeIntent(intent('wireframe.add.button'));

    expect(outcome.performed).toEqual(['wireframe.add.button']);
    expect(elements()).toHaveLength(1);
    expect(elements()[0].type).toBe('button');
    expect(getSnapshot().selectedId).toBe(elements()[0].id);
  });

  it('reports nothing for an action that performs nothing (no selection)', () => {
    const outcome = executeWireframeIntent(intent('wireframe.element.delete'));
    expect(outcome.performed).toEqual([]);
    expect(elements()).toHaveLength(0);
  });

  it('runs document.new and reports it', () => {
    runWireframeAction('wireframe.add.card');
    const outcome = executeWireframeIntent(intent('wireframe.document.new'));
    expect(outcome.performed).toEqual(['wireframe.document.new']);
    expect(elements()).toHaveLength(0);
  });

  it('routes a file action through the registered ST-6 handler', () => {
    const saveAs = vi.fn();
    registerWireframeFileActionHandlers({ saveAs });

    const outcome = executeWireframeIntent(intent('wireframe.file.saveAs'));
    expect(outcome.performed).toEqual(['wireframe.file.saveAs']);
    expect(saveAs).toHaveBeenCalledTimes(1);
  });

  it('runs a measured view action', () => {
    registerCanvasStage({ width: () => 800, height: () => 600 });
    const outcome = executeWireframeIntent(intent('wireframe.zoom.in'));
    expect(outcome.performed).toEqual(['wireframe.zoom.in']);
  });
});

describe('unknown ids never mutate the document (R-6.4)', () => {
  it('reports performed: [] and leaves count, ids and geometry identical', () => {
    runWireframeAction('wireframe.add.text');
    const before = immutableDocumentShape();

    for (const action of ['wireframe.add.teapot', 'wireframe.', '', 'nonsense']) {
      const outcome = executeWireframeIntent(intent(action));
      expect(outcome.performed, action).toEqual([]);
      expect(outcome.detail, action).toBeUndefined();
    }

    expect(immutableDocumentShape()).toEqual(before);
  });
});

describe('reply copy (C9 verbatim)', () => {
  it('draft/execute success names only the performed descriptions', () => {
    const reply = wireframePerformedReply('Reporter', [
      'wireframe.document.new',
      'wireframe.add.section',
    ]);
    expect(reply).toBe(
      'Started a new wireframe for Reporter: Start a new empty wireframe, Add a site frame section (header, nav bar, sidebar, footer).',
    );
    // Never the raw ids in the performed list.
    expect(reply).not.toContain('wireframe.add.section');
  });

  it('unknown action copy echoes the action verbatim', () => {
    expect(wireframeUnknownActionReply('wireframe.add.teapot')).toBe(
      'I don\'t know the Wireframe action "wireframe.add.teapot". Nothing changed.',
    );
  });

  it('known-but-nothing-performed copy', () => {
    expect(wireframeNothingChangedReply()).toBe(
      "I couldn't do that in Wireframe. Nothing changed.",
    );
  });

  it('list copy is `Wireframe actions: <id> — <description>; …`', () => {
    const list = wireframeListReply();
    expect(list.startsWith('Wireframe actions: wireframe.add.text — ')).toBe(true);
    expect(list).toContain('; wireframe.companion.draftApp — ');
    const last = WIREFRAME_ACTIONS[WIREFRAME_ACTIONS.length - 1];
    expect(list.endsWith(`${last.id} — ${last.description}`)).toBe(true);
    expect(list.split('; ')).toHaveLength(WIREFRAME_ACTIONS.length);
  });
});
