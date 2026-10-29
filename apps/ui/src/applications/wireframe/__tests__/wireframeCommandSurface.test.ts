/**
 * Wireframe command surface (Spec #3098 ST-3).
 *
 * Pins the declarative surface on the REAL module:
 *   - it passes the engine's ONE validator;
 *   - the four modes' ids/parents/transient/sticky/operator/cursor;
 *   - the root keymap is DERIVED from `WIREFRAME_ACTIONS` singles + r/e/v/c;
 *   - the draw/pan keymaps + `keymapOrder` presentation order;
 *   - one command per `toolbar: true` table row, SAME id, SHORT title, and the
 *     run funnels through `runWireframeAction`;
 *   - the five new commands exist and the fill prompt's label/placeholder/guard;
 *   - the new command behaviors (mode entry, create with/without bounds, fill
 *     on the primary only, invalid no-op, pan/mode sync);
 *   - the editor's new root hooks (`selection-shape` / `selection-fill`) and the
 *     mode-mirrored `pan-mode`.
 */

import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { resetHotkeyAnnouncer } from '@/shared/hotkeys/announcer';
import {
  getApplicationCommandMode,
  getRootCommandMode,
  validateCommandSurface,
  type ApplicationCommandMode,
} from '@/shared/hotkeys/commandSurface';
import {
  commitCommandPrompt,
  cancelCommandPrompt,
  executeCommand,
  getModePath,
  getOpenCommandPrompt,
  pushMode,
  resetCommandSurfaceForTests,
  setCommandPromptValue,
} from '@/shared/hotkeys/commandSurfaceStore';
import {
  BODY_PENDING_SEQUENCE_ATTR,
  handleHotkeyKeydown,
  resetHotkeyEngineForTests,
} from '@/shared/hotkeys/engine';
import {
  flushElementHotkeys,
  resetHotkeyElementDiscoveryForTests,
} from '@/shared/hotkeys/hotkeyElements';
import { WIREFRAME_ACTIONS } from '../actions/wireframeActions';
import { WIREFRAME_DRAFT_APP_ID } from '../actions/wireframeDraft';
import { WIREFRAME_APP_ID } from '../model/document';
import { WIREFRAME_COLOR_TOKENS } from '../model/elements';
import {
  dispatch,
  getSnapshot,
  resetWireframeStoreForTests,
  select,
  selectMany,
} from '../store/wireframeDocumentStore';
import { WireframeEditor } from '../components/WireframeEditor';
import { WireframeHotkeyCarrier } from '../components/WireframeHotkeyCarrier';
import {
  WIREFRAME_CREATE_ELEMENT_COMMAND_ID,
  WIREFRAME_CREATE_OPERATOR,
  WIREFRAME_DRAW_CURSOR,
  WIREFRAME_DRAW_ELLIPSE_COMMAND_ID,
  WIREFRAME_DRAW_ELLIPSE_MODE_ID,
  WIREFRAME_DRAW_RECT_COMMAND_ID,
  WIREFRAME_DRAW_RECT_MODE_ID,
  WIREFRAME_EDIT_FILL_COMMAND_ID,
  WIREFRAME_PAN_CURSOR,
  WIREFRAME_PAN_MODE_ID,
  WIREFRAME_SELECT_MODE_COMMAND_ID,
  WIREFRAME_SELECT_MODE_ID,
  WIREFRAME_TOGGLE_PAN_COMMAND_ID,
  WIREFRAME_COMPANION_DESCRIPTION,
  applyWireframeFill,
  beginWireframeShapeCreate,
  createWireframeShapeAt,
  wireframeCommandSurface,
} from '../wireframeCommandSurface';
// Side effect: the application must be registered so the store resolves the
// surface (exactly as the eager `allApplications` barrel does in the app).
import '../index';

function modeById(id: string): ApplicationCommandMode {
  const mode = getApplicationCommandMode(wireframeCommandSurface, id);
  if (mode === null) throw new Error(`missing mode ${id}`);
  return mode;
}

function commandById(id: string) {
  const command = wireframeCommandSurface.commands.find((candidate) => candidate.id === id);
  if (command === undefined) throw new Error(`missing command ${id}`);
  return command;
}

function toolbarRows() {
  return WIREFRAME_ACTIONS.filter((action) => action.toolbar);
}

beforeEach(() => {
  document.body.innerHTML = '';
  resetWireframeStoreForTests();
  resetCommandSurfaceForTests();
  resetHotkeyEngineForTests();
  resetHotkeyElementDiscoveryForTests();
  resetHotkeyAnnouncer();
});

afterEach(() => {
  cleanup();
  resetCommandSurfaceForTests();
  resetHotkeyEngineForTests();
  resetHotkeyElementDiscoveryForTests();
  resetWireframeStoreForTests();
  resetHotkeyAnnouncer();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

// ── Validation ───────────────────────────────────────────────────────────────

describe('surface declaration', () => {
  it('passes the engine validator with zero errors', () => {
    const result = validateCommandSurface(wireframeCommandSurface);
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it('declares exactly one root mode', () => {
    const roots = wireframeCommandSurface.modes.filter((mode) => mode.parent === null);
    expect(roots).toHaveLength(1);
    expect(roots[0].id).toBe(WIREFRAME_SELECT_MODE_ID);
    expect(getRootCommandMode(wireframeCommandSurface)?.id).toBe(WIREFRAME_SELECT_MODE_ID);
  });
});

// ── Modes ────────────────────────────────────────────────────────────────────

describe('modes', () => {
  it('declares the four mode ids/labels/parents', () => {
    expect(wireframeCommandSurface.modes.map((mode) => mode.id)).toEqual([
      WIREFRAME_SELECT_MODE_ID,
      WIREFRAME_DRAW_RECT_MODE_ID,
      WIREFRAME_DRAW_ELLIPSE_MODE_ID,
      WIREFRAME_PAN_MODE_ID,
    ]);

    const select = modeById(WIREFRAME_SELECT_MODE_ID);
    expect(select).toMatchObject({ label: 'Select', parent: null });

    for (const [id, label] of [
      [WIREFRAME_DRAW_RECT_MODE_ID, 'Rectangle'],
      [WIREFRAME_DRAW_ELLIPSE_MODE_ID, 'Ellipse'],
    ] as const) {
      const draw = modeById(id);
      expect(draw).toMatchObject({
        label,
        parent: WIREFRAME_SELECT_MODE_ID,
        transient: true,
        operator: WIREFRAME_CREATE_OPERATOR,
        cursor: WIREFRAME_DRAW_CURSOR,
      });
    }

    const pan = modeById(WIREFRAME_PAN_MODE_ID);
    expect(pan).toMatchObject({
      label: 'Pan',
      parent: WIREFRAME_SELECT_MODE_ID,
      sticky: true,
      cursor: WIREFRAME_PAN_CURSOR,
    });
    expect(pan.operator).toBeUndefined();
  });

  it('derives the root keymap from every single-step table hotkey plus r/e/v/c', () => {
    const select = modeById(WIREFRAME_SELECT_MODE_ID);

    for (const action of WIREFRAME_ACTIONS) {
      if (!action.toolbar || action.hotkey === undefined) continue;
      if (action.hotkey.includes('+')) continue; // two-step → carrier
      expect(select.keymap[action.hotkey], action.id).toBe(action.id);
    }

    expect(select.keymap.r).toBe(WIREFRAME_DRAW_RECT_COMMAND_ID);
    expect(select.keymap.e).toBe(WIREFRAME_DRAW_ELLIPSE_COMMAND_ID);
    expect(select.keymap.v).toBe(WIREFRAME_SELECT_MODE_COMMAND_ID);
    expect(select.keymap.c).toBe(WIREFRAME_EDIT_FILL_COMMAND_ID);
    // 20 inherited singles + the four new keys.
    expect(Object.keys(select.keymap)).toHaveLength(24);
    // The `g` namespace is NOT expressible as a mode stroke.
    expect(select.keymap.g).toBeUndefined();
  });

  it('declares the draw and pan keymaps', () => {
    const expectedDraw = {
      r: WIREFRAME_DRAW_RECT_COMMAND_ID,
      e: WIREFRAME_DRAW_ELLIPSE_COMMAND_ID,
      c: WIREFRAME_EDIT_FILL_COMMAND_ID,
      v: WIREFRAME_SELECT_MODE_COMMAND_ID,
    };
    expect(modeById(WIREFRAME_DRAW_RECT_MODE_ID).keymap).toEqual(expectedDraw);
    expect(modeById(WIREFRAME_DRAW_ELLIPSE_MODE_ID).keymap).toEqual(expectedDraw);
    expect(modeById(WIREFRAME_PAN_MODE_ID).keymap).toEqual({
      h: WIREFRAME_TOGGLE_PAN_COMMAND_ID,
      v: WIREFRAME_SELECT_MODE_COMMAND_ID,
    });
  });

  it('declares the A2 keymapOrder presentation order', () => {
    expect(modeById(WIREFRAME_SELECT_MODE_ID).keymapOrder).toEqual([
      'r',
      'e',
      'c',
      'v',
      'h',
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
      'p',
      'k',
      'l',
      'u',
      'y',
      'n',
      '0',
      'w',
      'o',
      't',
    ]);
    expect(modeById(WIREFRAME_DRAW_RECT_MODE_ID).keymapOrder).toEqual(['r', 'e', 'c', 'v']);
    expect(modeById(WIREFRAME_DRAW_ELLIPSE_MODE_ID).keymapOrder).toEqual([
      'r',
      'e',
      'c',
      'v',
    ]);
    expect(modeById(WIREFRAME_PAN_MODE_ID).keymapOrder).toEqual(['h', 'v']);
  });
});

// ── Commands ─────────────────────────────────────────────────────────────────

describe('table commands', () => {
  it('maps every toolbar row to ONE command with the SAME id + SHORT title', () => {
    const rows = toolbarRows();
    expect(rows).toHaveLength(33);

    for (const row of rows) {
      const command = commandById(row.id);
      expect(command.title, row.id).toBe(row.title);
      expect(command.prompt).toBeUndefined();
    }
  });

  it('runs the table row handler (runWireframeAction) for every command', () => {
    for (const row of toolbarRows()) {
      const original = row.run;
      const spy = vi.fn(() => true);
      row.run = spy;
      try {
        commandById(row.id).run();
        expect(spy, row.id).toHaveBeenCalledTimes(1);
      } finally {
        row.run = original;
      }
    }
  });

  it('declares the five new commands', () => {
    expect(commandById(WIREFRAME_SELECT_MODE_COMMAND_ID).title).toBe('Select');
    expect(commandById(WIREFRAME_DRAW_RECT_COMMAND_ID).title).toBe('Rectangle');
    expect(commandById(WIREFRAME_DRAW_ELLIPSE_COMMAND_ID).title).toBe('Ellipse');
    expect(commandById(WIREFRAME_EDIT_FILL_COMMAND_ID).title).toBe('Fill');
    expect(commandById(WIREFRAME_CREATE_ELEMENT_COMMAND_ID).title).toBe('Create shape');
  });
});

// ── Published companion contract (Spec #3099 ST-3) ───────────────────────────

/**
 * The 33 toolbar commands' model-facing contract, moved from the retired
 * `companionCatalog.parity.test.ts` (the Rust catalog it mirrored is deleted in
 * ST-4; the shared golden fixture asserts the same values cross-language).
 * `[id, title, description]`.
 */
const EXPECTED_TABLE_COMMANDS: ReadonlyArray<readonly [string, string, string]> = [
  ['wireframe.add.text', 'Text', 'Add a text element (body or heading style)'],
  ['wireframe.add.button', 'Button', 'Add a button element'],
  ['wireframe.add.input', 'Input', 'Add an input field element'],
  ['wireframe.add.image', 'Image', 'Add an image placeholder frame'],
  ['wireframe.add.icon', 'Icon', 'Add an icon from the curated set'],
  ['wireframe.add.card', 'Card', 'Add a card/container element'],
  [
    'wireframe.add.section',
    'Section',
    'Add a site frame section (header, nav bar, sidebar, footer)',
  ],
  ['wireframe.add.shape', 'Shape', 'Add a basic shape'],
  ['wireframe.add.line', 'Line', 'Add a line'],
  ['wireframe.element.duplicate', 'Duplicate', 'Duplicate the selected element'],
  ['wireframe.element.delete', 'Delete', 'Delete the selected element'],
  ['wireframe.element.toggleLock', 'Lock', 'Lock or unlock the selected element'],
  ['wireframe.edit.undo', 'Undo', 'Undo the last change'],
  ['wireframe.edit.redo', 'Redo', 'Redo the last undone change'],
  ['wireframe.zoom.in', 'Zoom in', 'Zoom in'],
  ['wireframe.zoom.out', 'Zoom out', 'Zoom out'],
  ['wireframe.view.fitPage', 'Fit page', 'Fit the page to the screen'],
  ['wireframe.view.resetView', 'Reset view', 'Reset to 100% and centre the page'],
  ['wireframe.view.togglePan', 'Pan tool', 'Toggle the pan tool'],
  ['wireframe.file.saveAs', 'Save As', 'Save the document to a new file'],
  ['wireframe.file.open', 'Open', 'Open a saved wireframe document'],
  ['wireframe.file.exportPng', 'Export PNG', 'Export the page as a PNG'],
  ['wireframe.arrange.group', 'Group', 'Group the selected elements'],
  ['wireframe.arrange.ungroup', 'Ungroup', 'Ungroup the selected group'],
  ['wireframe.arrange.toggleGroupLock', 'Lock group', 'Lock or unlock the selected group'],
  ['wireframe.arrange.toggleSnap', 'Snap to grid', 'Toggle snap to grid'],
  ['wireframe.arrange.alignLeft', 'Align left', 'Align the selected elements to the left'],
  [
    'wireframe.arrange.alignCenter',
    'Align centre',
    'Align the selected elements to the centre',
  ],
  [
    'wireframe.arrange.alignRight',
    'Align right',
    'Align the selected elements to the right',
  ],
  [
    'wireframe.arrange.distribute',
    'Distribute',
    'Distribute the selected elements with equal gaps',
  ],
  [
    'wireframe.arrange.bringForward',
    'Bring forward',
    'Bring the selected elements forward',
  ],
  [
    'wireframe.arrange.sendBackward',
    'Send backward',
    'Send the selected elements backward',
  ],
  ['wireframe.document.new', 'New', 'Start a new empty wireframe'],
];

describe('published companion contract', () => {
  it('publishes the exact 33 toolbar commands: id, title and description', () => {
    // Table commands are declared first, in WIREFRAME_ACTIONS order.
    const actual = wireframeCommandSurface.commands
      .slice(0, EXPECTED_TABLE_COMMANDS.length)
      .map((command) => [command.id, command.title, command.description]);
    expect(actual).toEqual(EXPECTED_TABLE_COMMANDS.map((row) => [...row]));
  });

  it('publishes 39 commands: the 33 table rows, 5 surface commands and draftApp', () => {
    const rows = toolbarRows();
    expect(rows).toHaveLength(33);
    expect(wireframeCommandSurface.commands).toHaveLength(39);
    expect(wireframeCommandSurface.commands.map((command) => command.id)).toEqual([
      ...rows.map((row) => row.id),
      WIREFRAME_SELECT_MODE_COMMAND_ID,
      WIREFRAME_DRAW_RECT_COMMAND_ID,
      WIREFRAME_DRAW_ELLIPSE_COMMAND_ID,
      WIREFRAME_CREATE_ELEMENT_COMMAND_ID,
      WIREFRAME_EDIT_FILL_COMMAND_ID,
      WIREFRAME_DRAFT_APP_ID,
    ]);
  });

  it('gives every command a non-blank description and a declared args array', () => {
    for (const command of wireframeCommandSurface.commands) {
      expect(command.description?.trim(), command.id).toBeTruthy();
      expect(Array.isArray(command.args), command.id).toBe(true);
    }
  });

  it('uses the SAME sentences as the table for the 33 toolbar commands', () => {
    for (const row of toolbarRows()) {
      expect(commandById(row.id).description, row.id).toBe(row.description);
      expect(commandById(row.id).args, row.id).toEqual([]);
    }
  });

  it('declares each surface command argument contract', () => {
    for (const id of [
      WIREFRAME_SELECT_MODE_COMMAND_ID,
      WIREFRAME_DRAW_RECT_COMMAND_ID,
      WIREFRAME_DRAW_ELLIPSE_COMMAND_ID,
    ]) {
      expect(commandById(id).args, id).toEqual([]);
    }

    expect(
      commandById(WIREFRAME_CREATE_ELEMENT_COMMAND_ID).args?.map((arg) => [
        arg.name,
        arg.required ?? false,
      ]),
    ).toEqual([
      ['shape', true],
      ['x', false],
      ['y', false],
      ['width', false],
      ['height', false],
    ]);

    expect(
      commandById(WIREFRAME_EDIT_FILL_COMMAND_ID).args?.map((arg) => [
        arg.name,
        arg.required ?? false,
      ]),
    ).toEqual([['fill', true]]);

    expect(
      commandById(WIREFRAME_DRAFT_APP_ID).args?.map((arg) => [
        arg.name,
        arg.required ?? false,
      ]),
    ).toEqual([
      ['app_name', true],
      ['summary', false],
    ]);
  });

  it('declares the companion DIRECTIVE that names the request class', () => {
    expect(wireframeCommandSurface.companion?.description).toBe(
      WIREFRAME_COMPANION_DESCRIPTION,
    );
    for (const word of [
      'create',
      'draft',
      'sketch',
      'mock up',
      'visualize',
      'app/screen/page/dashboard',
    ]) {
      expect(WIREFRAME_COMPANION_DESCRIPTION).toContain(word);
    }
    expect(WIREFRAME_COMPANION_DESCRIPTION).toContain('Use ONLY for Wireframe requests.');
    // Default listing wording (`${appName} actions`) — no override declared.
    expect(wireframeCommandSurface.companion?.listLabel).toBeUndefined();
  });

  it('never declares the retired wireframe.companion.listActions command', () => {
    expect(
      wireframeCommandSurface.commands.some(
        (command) => command.id === 'wireframe.companion.listActions',
      ),
    ).toBe(false);
  });
});

describe('honest boolean returns', () => {
  it('mode commands report performed', () => {
    expect(executeCommand(WIREFRAME_APP_ID, WIREFRAME_SELECT_MODE_COMMAND_ID)).toEqual({
      status: 'performed',
    });
    expect(executeCommand(WIREFRAME_APP_ID, WIREFRAME_DRAW_RECT_COMMAND_ID)).toEqual({
      status: 'performed',
    });
    expect(executeCommand(WIREFRAME_APP_ID, WIREFRAME_DRAW_ELLIPSE_COMMAND_ID)).toEqual({
      status: 'performed',
    });
  });

  it('create rejects a guarded shape before run (invalid-arguments)', () => {
    const outcome = executeCommand(WIREFRAME_APP_ID, WIREFRAME_CREATE_ELEMENT_COMMAND_ID, {
      shape: 'triangle',
      x: '10',
      y: '10',
      width: '100',
      height: '100',
    });
    expect(outcome).toEqual({ status: 'rejected', reason: 'invalid-arguments' });
    expect(getSnapshot().document.elements).toHaveLength(0);
  });

  it('create reports noop below the minimum size', () => {
    const outcome = executeCommand(WIREFRAME_APP_ID, WIREFRAME_CREATE_ELEMENT_COMMAND_ID, {
      shape: 'rect',
      x: '10',
      y: '10',
      width: '3',
      height: '10',
    });
    expect(outcome).toEqual({ status: 'noop' });
  });

  it('editFill reports noop when there is no shape to fill', () => {
    const outcome = executeCommand(WIREFRAME_APP_ID, WIREFRAME_EDIT_FILL_COMMAND_ID, {
      fill: 'accent',
    });
    expect(outcome).toEqual({ status: 'noop' });
    expect(getModePath(WIREFRAME_APP_ID)).toEqual([WIREFRAME_SELECT_MODE_ID]);
  });

  it('a table command that performs nothing reports noop', () => {
    expect(executeCommand(WIREFRAME_APP_ID, 'wireframe.element.delete')).toEqual({
      status: 'noop',
    });
  });
});

describe('editFill prompt', () => {
  it('declares the exact label / placeholder / guard', () => {
    const prompt = commandById(WIREFRAME_EDIT_FILL_COMMAND_ID).prompt;
    expect(prompt).toBeDefined();
    expect(prompt?.label).toBe('Fill token');
    expect(prompt?.placeholder).toBe(
      'surface | muted | border | text | textMuted | accent | success | warning | error | info',
    );
    expect(prompt?.validate).toBeTypeOf('function');
  });

  it('accepts all ten tokens (trimmed) and rejects anything else', () => {
    const validate = commandById(WIREFRAME_EDIT_FILL_COMMAND_ID).prompt?.validate;
    expect(validate).toBeDefined();
    for (const token of WIREFRAME_COLOR_TOKENS) {
      expect(validate?.(token), token).toBe(true);
      expect(validate?.(`  ${token}  `), token).toBe(true);
    }
    for (const value of ['', 'chartreuse', 'ACCENT', 'accent, muted', 'surface | muted']) {
      expect(validate?.(value), value).toBe(false);
    }
  });
});

// ── Mode behaviors ───────────────────────────────────────────────────────────

describe('mode commands', () => {
  it('select resets the stack to the root', () => {
    pushMode(WIREFRAME_APP_ID, WIREFRAME_DRAW_RECT_MODE_ID);
    expect(getModePath(WIREFRAME_APP_ID)).toEqual([
      WIREFRAME_SELECT_MODE_ID,
      WIREFRAME_DRAW_RECT_MODE_ID,
    ]);

    executeCommand(WIREFRAME_APP_ID, WIREFRAME_SELECT_MODE_COMMAND_ID);

    expect(getModePath(WIREFRAME_APP_ID)).toEqual([WIREFRAME_SELECT_MODE_ID]);
  });

  it('draw commands reset to Select and then push the draw mode (never a stale Pan)', () => {
    executeCommand(WIREFRAME_APP_ID, WIREFRAME_TOGGLE_PAN_COMMAND_ID);
    expect(getModePath(WIREFRAME_APP_ID)).toEqual([
      WIREFRAME_SELECT_MODE_ID,
      WIREFRAME_PAN_MODE_ID,
    ]);

    executeCommand(WIREFRAME_APP_ID, WIREFRAME_DRAW_RECT_COMMAND_ID);
    expect(getModePath(WIREFRAME_APP_ID)).toEqual([
      WIREFRAME_SELECT_MODE_ID,
      WIREFRAME_DRAW_RECT_MODE_ID,
    ]);

    executeCommand(WIREFRAME_APP_ID, WIREFRAME_DRAW_ELLIPSE_COMMAND_ID);
    expect(getModePath(WIREFRAME_APP_ID)).toEqual([
      WIREFRAME_SELECT_MODE_ID,
      WIREFRAME_DRAW_ELLIPSE_MODE_ID,
    ]);
  });

  it('beginWireframeShapeCreate resets then pushes the requested kind', () => {
    beginWireframeShapeCreate('ellipse');
    expect(getModePath(WIREFRAME_APP_ID)).toEqual([
      WIREFRAME_SELECT_MODE_ID,
      WIREFRAME_DRAW_ELLIPSE_MODE_ID,
    ]);
    beginWireframeShapeCreate('rect');
    expect(getModePath(WIREFRAME_APP_ID)).toEqual([
      WIREFRAME_SELECT_MODE_ID,
      WIREFRAME_DRAW_RECT_MODE_ID,
    ]);
  });
});

// ── Keyboard integration (sanity) ────────────────────────────────────────────

describe('keyboard integration', () => {
  it('r/e/v/c enter the declared modes and g+c never opens the fill prompt', () => {
    const root = document.createElement('div');
    root.setAttribute('data-fredo-app-id', WIREFRAME_APP_ID);
    document.body.appendChild(root);
    const { unmount } = render(React.createElement(WireframeHotkeyCarrier), {
      container: root,
    });
    const focus = document.createElement('div');
    focus.tabIndex = -1;
    root.appendChild(focus);
    flushElementHotkeys();
    focus.focus();

    const press = (key: string): void => {
      handleHotkeyKeydown(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
      );
    };

    press('r');
    expect(getModePath(WIREFRAME_APP_ID)).toEqual([
      WIREFRAME_SELECT_MODE_ID,
      WIREFRAME_DRAW_RECT_MODE_ID,
    ]);

    press('e');
    expect(getModePath(WIREFRAME_APP_ID)).toEqual([
      WIREFRAME_SELECT_MODE_ID,
      WIREFRAME_DRAW_ELLIPSE_MODE_ID,
    ]);

    press('v');
    expect(getModePath(WIREFRAME_APP_ID)).toEqual([WIREFRAME_SELECT_MODE_ID]);

    press('c');
    expect(getOpenCommandPrompt(WIREFRAME_APP_ID)?.commandId).toBe(
      WIREFRAME_EDIT_FILL_COMMAND_ID,
    );
    cancelCommandPrompt(WIREFRAME_APP_ID);

    press('g');
    expect(document.body.getAttribute(BODY_PENDING_SEQUENCE_ATTR)).toBe('g');
    press('c');

    // The armed `g` prefix completes the carrier's align-centre binding; it
    // must NOT be hijacked by the `c` mode key (fill prompt).
    expect(getOpenCommandPrompt(WIREFRAME_APP_ID)).toBeNull();
    expect(document.body.hasAttribute('data-fredo-command-prompt')).toBe(false);

    unmount();
  });
});

// ── Create ───────────────────────────────────────────────────────────────────

describe('wireframe.element.create', () => {
  it('arms the draw mode when only a shape is given', () => {
    executeCommand(WIREFRAME_APP_ID, WIREFRAME_CREATE_ELEMENT_COMMAND_ID, {
      shape: 'ellipse',
    });
    expect(getModePath(WIREFRAME_APP_ID)).toEqual([
      WIREFRAME_SELECT_MODE_ID,
      WIREFRAME_DRAW_ELLIPSE_MODE_ID,
    ]);
    expect(getSnapshot().document.elements).toHaveLength(0);
  });

  it('creates + auto-selects at explicit bounds and returns to Select', () => {
    executeCommand(WIREFRAME_APP_ID, WIREFRAME_CREATE_ELEMENT_COMMAND_ID, {
      shape: 'rect',
      x: '100',
      y: '80',
      width: '240',
      height: '160',
    });

    const state = getSnapshot();
    expect(state.document.elements).toHaveLength(1);
    const created = state.document.elements[0];
    expect(created).toMatchObject({
      type: 'shape',
      shape: 'rect',
      x: 100,
      y: 80,
      width: 240,
      height: 160,
      fill: 'muted',
    });
    expect(state.selectedId).toBe(created.id);
    expect(getModePath(WIREFRAME_APP_ID)).toEqual([WIREFRAME_SELECT_MODE_ID]);
  });

  it('is a no-op (no mutation, mode unchanged) below the minimum size', () => {
    const before = getSnapshot();
    executeCommand(WIREFRAME_APP_ID, WIREFRAME_CREATE_ELEMENT_COMMAND_ID, {
      shape: 'rect',
      x: '10',
      y: '10',
      width: '3',
      height: '10',
    });
    const after = getSnapshot();
    expect(after.document).toBe(before.document);
    expect(after.document.elements).toHaveLength(0);
    expect(getModePath(WIREFRAME_APP_ID)).toEqual([WIREFRAME_SELECT_MODE_ID]);
  });

  it('rejects an unknown shape kind', () => {
    executeCommand(WIREFRAME_APP_ID, WIREFRAME_CREATE_ELEMENT_COMMAND_ID, {
      shape: 'triangle',
      x: '10',
      y: '10',
      width: '100',
      height: '100',
    });
    expect(getSnapshot().document.elements).toHaveLength(0);
    expect(getModePath(WIREFRAME_APP_ID)).toEqual([WIREFRAME_SELECT_MODE_ID]);
  });

  it('createWireframeShapeAt returns null below minimum and does not dispatch', () => {
    const before = getSnapshot().document;
    expect(
      createWireframeShapeAt({
        shape: 'rect',
        rect: { x: 0, y: 0, width: 3, height: 100 },
      }),
    ).toBeNull();
    expect(getSnapshot().document).toBe(before);
    expect(getSnapshot().document.elements).toHaveLength(0);
  });
});

// ── Fill ─────────────────────────────────────────────────────────────────────

describe('wireframe.element.editFill', () => {
  function createShape(kind: 'rect' | 'ellipse' = 'rect', x = 10): string {
    const id = createWireframeShapeAt({
      shape: kind,
      rect: { x, y: 20, width: 120, height: 80 },
    });
    if (id === null) throw new Error('shape not created');
    return id;
  }

  it('applies the token to the primary shape and returns to Select', () => {
    const id = createShape();
    expect(getSnapshot().document.elements[0]).toMatchObject({ fill: 'muted' });

    executeCommand(WIREFRAME_APP_ID, WIREFRAME_EDIT_FILL_COMMAND_ID, { fill: 'accent' });

    const state = getSnapshot();
    expect(state.document.elements.find((element) => element.id === id)).toMatchObject({
      fill: 'accent',
    });
    expect(getModePath(WIREFRAME_APP_ID)).toEqual([WIREFRAME_SELECT_MODE_ID]);
    expect(state.dirty).toBe(true);
  });

  it('reads the prompt commit encoding (`value`) and trims the draft', () => {
    const id = createShape();
    // The prompt commit path bypasses the declared-argument contract and
    // supplies `{ value }`; `runEditFill` still trims it.
    executeCommand(WIREFRAME_APP_ID, WIREFRAME_EDIT_FILL_COMMAND_ID);
    setCommandPromptValue(WIREFRAME_APP_ID, '  success  ');
    commitCommandPrompt(WIREFRAME_APP_ID);
    expect(getSnapshot().document.elements.find((element) => element.id === id)).toMatchObject({
      fill: 'success',
    });
  });

  it('applies to the PRIMARY (last-selected) shape only', () => {
    const first = createShape('rect', 10);
    const second = createShape('ellipse', 220);
    selectMany([first, second]);

    applyWireframeFill('accent');

    const state = getSnapshot();
    expect(state.document.elements.find((element) => element.id === first)).toMatchObject({
      fill: 'muted',
    });
    expect(state.document.elements.find((element) => element.id === second)).toMatchObject({
      fill: 'accent',
    });
  });

  it('invalid token is a no-op: no mutation, no mode change', () => {
    createShape();
    const before = getSnapshot();

    executeCommand(WIREFRAME_APP_ID, WIREFRAME_EDIT_FILL_COMMAND_ID, {
      fill: 'chartreuse',
    });

    const after = getSnapshot();
    expect(after.document).toBe(before.document);
    expect(after.dirty).toBe(before.dirty);
    expect(getModePath(WIREFRAME_APP_ID)).toEqual([WIREFRAME_SELECT_MODE_ID]);
  });

  it('an invalid prompt commit keeps the prompt open and the draw mode active', () => {
    createShape();
    pushMode(WIREFRAME_APP_ID, WIREFRAME_DRAW_RECT_MODE_ID);
    executeCommand(WIREFRAME_APP_ID, WIREFRAME_EDIT_FILL_COMMAND_ID);
    setCommandPromptValue(WIREFRAME_APP_ID, 'chartreuse');

    commitCommandPrompt(WIREFRAME_APP_ID);

    expect(getOpenCommandPrompt(WIREFRAME_APP_ID)).not.toBeNull();
    expect(getSnapshot().document.elements[0]).toMatchObject({ fill: 'muted' });
    expect(getModePath(WIREFRAME_APP_ID)).toEqual([
      WIREFRAME_SELECT_MODE_ID,
      WIREFRAME_DRAW_RECT_MODE_ID,
    ]);
  });

  it('valid token with no selection still closes the prompt and returns to Select', () => {
    expect(applyWireframeFill('accent')).toBe(false);
    select(null);
    pushMode(WIREFRAME_APP_ID, WIREFRAME_DRAW_RECT_MODE_ID);

    executeCommand(WIREFRAME_APP_ID, WIREFRAME_EDIT_FILL_COMMAND_ID, { fill: 'info' });

    expect(getSnapshot().document.elements).toHaveLength(0);
    expect(getModePath(WIREFRAME_APP_ID)).toEqual([WIREFRAME_SELECT_MODE_ID]);
  });

  it('a non-shape primary is a no-op', () => {
    dispatch('element.add', {
      element: {
        id: 'text-1',
        type: 'text',
        x: 0,
        y: 0,
        width: 100,
        height: 40,
        visible: true,
        locked: false,
        text: 'Text',
        textStyle: 'body',
        size: 'm',
        align: 'left',
      },
    });
    select('text-1');

    expect(applyWireframeFill('accent')).toBe(false);
    expect(getSnapshot().document.elements[0]).toMatchObject({ type: 'text' });
  });

  it('the prompt path commits through the declared guard', () => {
    createShape();
    executeCommand(WIREFRAME_APP_ID, WIREFRAME_EDIT_FILL_COMMAND_ID);
    expect(getOpenCommandPrompt(WIREFRAME_APP_ID)).not.toBeNull();

    setCommandPromptValue(WIREFRAME_APP_ID, 'chartreuse');
    commitCommandPrompt(WIREFRAME_APP_ID);
    expect(getOpenCommandPrompt(WIREFRAME_APP_ID)).not.toBeNull();
    expect(getSnapshot().document.elements[0]).toMatchObject({ fill: 'muted' });

    setCommandPromptValue(WIREFRAME_APP_ID, 'accent');
    commitCommandPrompt(WIREFRAME_APP_ID);
    expect(getOpenCommandPrompt(WIREFRAME_APP_ID)).toBeNull();
    expect(getSnapshot().document.elements[0]).toMatchObject({ fill: 'accent' });
  });
});

// ── Pan / mode sync ──────────────────────────────────────────────────────────

describe('wireframe.view.togglePan keeps the mode stack in sync', () => {
  it('enabling pushes Pan; disabling returns to Select', () => {
    executeCommand(WIREFRAME_APP_ID, WIREFRAME_TOGGLE_PAN_COMMAND_ID);
    expect(getSnapshot().panMode).toBe(true);
    expect(getModePath(WIREFRAME_APP_ID)).toEqual([
      WIREFRAME_SELECT_MODE_ID,
      WIREFRAME_PAN_MODE_ID,
    ]);

    executeCommand(WIREFRAME_APP_ID, WIREFRAME_TOGGLE_PAN_COMMAND_ID);
    expect(getSnapshot().panMode).toBe(false);
    expect(getModePath(WIREFRAME_APP_ID)).toEqual([WIREFRAME_SELECT_MODE_ID]);
  });
});

// ── Editor root hooks ────────────────────────────────────────────────────────

describe('editor sync (root hooks)', () => {
  it('mirrors the primary shape/fill and the active pan mode', () => {
    const { getByTestId } = renderWithChakra(React.createElement(WireframeEditor));
    const root = getByTestId('wireframe-root');

    expect(root.getAttribute('data-wireframe-selection-shape')).toBe('');
    expect(root.getAttribute('data-wireframe-selection-fill')).toBe('');
    expect(root.getAttribute('data-wireframe-pan-mode')).toBe('false');

    act(() => {
      createWireframeShapeAt({
        shape: 'ellipse',
        rect: { x: 10, y: 20, width: 100, height: 80 },
      });
    });
    expect(root.getAttribute('data-wireframe-selection-shape')).toBe('ellipse');
    expect(root.getAttribute('data-wireframe-selection-fill')).toBe('muted');

    act(() => {
      executeCommand(WIREFRAME_APP_ID, WIREFRAME_TOGGLE_PAN_COMMAND_ID);
    });
    expect(root.getAttribute('data-wireframe-pan-mode')).toBe('true');

    act(() => {
      executeCommand(WIREFRAME_APP_ID, WIREFRAME_SELECT_MODE_COMMAND_ID);
    });
    expect(root.getAttribute('data-wireframe-pan-mode')).toBe('false');
  });
});
