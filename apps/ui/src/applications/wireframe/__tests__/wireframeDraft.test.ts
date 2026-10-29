/**
 * Deterministic Wireframe starter draft (Spec #3070 C4; Spec #3099 ST-3).
 *
 * The draft script moved to `actions/wireframeDraft.ts` when
 * `wireframe.companion.draftApp` became a real published surface command. This
 * suite pins the script itself (page preset, step order, the produced
 * navbar/heading/report-card document, and the stop-on-failure honesty rule)
 * plus the published command that now owns it.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  WIREFRAME_DRAFT_APP_ID,
  WIREFRAME_DRAFT_PAGE_PRESET,
  WIREFRAME_DRAFT_STEPS,
  createWireframeDraftOperations,
  runWireframeDraft,
  type WireframeDraftOperations,
} from '../actions/wireframeDraft';
import { runWireframeAction } from '../actions/wireframeActions';
import type { WireframeElement } from '../model/elements';
import {
  getSnapshot,
  resetWireframeStoreForTests,
} from '../store/wireframeDocumentStore';
import {
  executeCommand,
  resetCommandSurfaceForTests,
} from '@/shared/hotkeys/commandSurfaceStore';
import { WIREFRAME_APP_ID } from '../model/document';
import { wireframeCommandSurface } from '../wireframeCommandSurface';
// Side effect: the application must be registered so the executor resolves the
// surface (exactly as the eager `allApplications` barrel does in the app).
import '../index';

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
  overrides: Partial<WireframeDraftOperations>,
): WireframeDraftOperations {
  return { ...createWireframeDraftOperations(), ...overrides };
}

function draftCommand() {
  const command = wireframeCommandSurface.commands.find(
    (candidate) => candidate.id === WIREFRAME_DRAFT_APP_ID,
  );
  if (command === undefined) throw new Error('draftApp command is not published');
  return command;
}

beforeEach(() => {
  resetWireframeStoreForTests();
  resetCommandSurfaceForTests();
});

describe('the deterministic draft script (C4 / R-6.5)', () => {
  it('pins the page preset and the four-step order', () => {
    expect(WIREFRAME_DRAFT_PAGE_PRESET).toBe('desktop');
    expect(WIREFRAME_DRAFT_STEPS).toEqual([
      'wireframe.document.new',
      'wireframe.add.section',
      'wireframe.add.text',
      'wireframe.add.card',
    ]);
  });

  it('runs the four steps and produces navbar + heading + report card', () => {
    const performed = runWireframeDraft({ app_name: 'Reporter' });

    expect(performed).toEqual([...WIREFRAME_DRAFT_STEPS]);

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
    runWireframeDraft({ app_name: '  Reporter  ' });
    expect(elements()[1]).toMatchObject({ type: 'text', text: 'Reporter' });
    expect(elements()[2]).toMatchObject({ type: 'card', label: 'Reporter reports' });
  });

  it('performs nothing when app_name is missing, blank or not a string', () => {
    runWireframeAction('wireframe.add.line');
    const before = immutableDocumentShape();

    for (const app_name of [undefined, '', '   ', 7]) {
      expect(runWireframeDraft({ app_name })).toEqual([]);
    }
    expect(runWireframeDraft(undefined)).toEqual([]);

    expect(immutableDocumentShape()).toEqual(before);
    expect(elements()).toHaveLength(1);
  });

  it('stops on a failing step and reports only the prior steps (R-6.3)', () => {
    const base = createWireframeDraftOperations();
    const operations = operationsWith({
      addElement: (type, options) =>
        type === 'card' ? false : base.addElement(type, options),
    });

    const performed = runWireframeDraft({ app_name: 'Reporter' }, operations);

    expect(performed).toEqual([
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

describe('the published draftApp command (Spec #3099 ST-3)', () => {
  it('declares app_name required and summary optional, and runs the same script', () => {
    const command = draftCommand();
    expect(command.args?.map((arg) => [arg.name, arg.required ?? false])).toEqual([
      ['app_name', true],
      ['summary', false],
    ]);

    const outcome = executeCommand(WIREFRAME_APP_ID, WIREFRAME_DRAFT_APP_ID, {
      app_name: 'Reporter',
    });

    expect(outcome).toEqual({ status: 'performed' });
    expect(elements()).toHaveLength(3);
    expect(elements()[1]).toMatchObject({ type: 'text', text: 'Reporter' });
  });

  it('rejects a missing required app_name before run (nothing performed)', () => {
    const outcome = executeCommand(WIREFRAME_APP_ID, WIREFRAME_DRAFT_APP_ID);
    expect(outcome).toEqual({ status: 'rejected', reason: 'invalid-arguments' });
    expect(elements()).toHaveLength(0);
  });

  it('the command run reports false when nothing was performed', () => {
    expect(draftCommand().run(undefined)).toBe(false);
    expect(draftCommand().run({ app_name: '   ' })).toBe(false);
    expect(draftCommand().run({ app_name: 'Reporter' })).toBe(true);
  });
});
