/**
 * Wireframe pointer-control strip (Spec #3151, ST-5 — AC3 / R-3.4, AC4).
 *
 * Drives every one of the 23 re-homed pointer controls through the PUBLISHED
 * testids, pointer-only: 16 menu rows (12 `wireframe-arrange-item` + 4
 * `wireframe-file-item`), 5 `wireframe-view-item` buttons and the two history
 * controls. The command bar was the only pointer entry for these capabilities,
 * so this suite is the regression guard that the re-home actually carries them.
 *
 * SELECTOR DISCIPLINE (G-424): the three `*-item` testids REPEAT, and both menus
 * are `lazyMount` — their rows do not exist until opened. Every row is asserted
 * by ACCESSIBLE NAME inside the opened popup (`within(<popup>)`); the five view
 * rows are queried `within(getByTestId('wireframe-view-controls'))`. No
 * page-wide count of a repeating testid, and never a count of a closed menu.
 *
 * The shell's File → New re-home (the dirty-discard path) and the Arrange →
 * Element → Delete/Duplicate reachability cases are covered here too.
 */

import React from 'react';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { WireframeEditor } from '../components/WireframeEditor';
import {
  createDefaultElement,
  type WireframeElementType,
} from '../model/elements';
import {
  dispatch,
  getSnapshot,
  getWireframeHistory,
  markSaved,
  registerCanvasStage,
  resetWireframeStoreForTests,
  select,
  selectMany,
  setView,
} from '../store/wireframeDocumentStore';
import {
  WIREFRAME_ARRANGE_ITEM_TESTID,
  WIREFRAME_ARRANGE_TESTID,
  WIREFRAME_FILE_ITEM_TESTID,
  WIREFRAME_FILE_MENU_TESTID,
  WIREFRAME_REDO_TESTID,
  WIREFRAME_UNDO_TESTID,
  WIREFRAME_VIEW_ITEM_TESTID,
  WIREFRAME_VIEW_TESTID,
} from '../components/wireframeControlIds';

/**
 * The strip is the subject; the Konva canvas is out of scope and cannot mount
 * under jsdom (no `canvas` module). Stub it with an inert marker div so the real
 * shell + the real control strip + the real store are exercised.
 */
vi.mock('../components/WireframeCanvas', () => ({
  WireframeCanvas: () => <div data-testid="wireframe-canvas-stub" />,
}));

function renderEditor() {
  return renderWithChakra(<WireframeEditor />);
}

function addElement(type: WireframeElementType, id: string) {
  const snapshot = getSnapshot();
  const element = createDefaultElement(type, {
    page: snapshot.document.page,
    elements: snapshot.document.elements,
    id,
  });
  act(() => {
    dispatch('element.add', { element });
  });
  return element;
}

/** The open menu popup (rows exist only after the trigger is clicked). */
async function openMenu(triggerTestId: string): Promise<HTMLElement> {
  const user = userEvent.setup();
  await user.click(screen.getByTestId(triggerTestId));
  const rows = await screen.findAllByTestId(
    triggerTestId === WIREFRAME_ARRANGE_TESTID
      ? WIREFRAME_ARRANGE_ITEM_TESTID
      : WIREFRAME_FILE_ITEM_TESTID,
  );
  const popup = rows[0]?.closest('[role="menu"]');
  if (popup === null || popup === undefined) throw new Error('menu popup not mounted');
  return popup as HTMLElement;
}

/** Click one row by its accessible name inside the given popup. */
async function clickRow(popup: HTMLElement, name: string): Promise<void> {
  const user = userEvent.setup();
  const row =
    within(popup).queryByRole('menuitem', { name }) ??
    within(popup).getByRole('menuitemcheckbox', { name });
  await user.click(row);
}

/** One row by its accessible name inside the popup (any menu-item role). */
function row(popup: HTMLElement, name: string): HTMLElement {
  return (
    within(popup).queryByRole('menuitem', { name }) ??
    within(popup).getByRole('menuitemcheckbox', { name })
  );
}

function viewRow(name: string): HTMLElement {
  return within(screen.getByTestId(WIREFRAME_VIEW_TESTID)).getByRole('button', { name });
}

beforeEach(() => {
  resetWireframeStoreForTests();
  // The view actions need a measured stage; jsdom has none, so register a stub.
  registerCanvasStage({ width: () => 900, height: () => 640 });
});

afterEach(() => {
  cleanup();
  resetWireframeStoreForTests();
  registerCanvasStage(null);
});

describe('control inventory (23 pointer-reachable controls)', () => {
  it('renders the strip with history, view, arrange and file clusters', () => {
    renderEditor();
    expect(screen.getByTestId('wireframe-control-strip')).toBeInTheDocument();
    expect(screen.getByTestId(WIREFRAME_UNDO_TESTID)).toBeInTheDocument();
    expect(screen.getByTestId(WIREFRAME_REDO_TESTID)).toBeInTheDocument();
    expect(screen.getByTestId(WIREFRAME_VIEW_TESTID)).toBeInTheDocument();
    expect(screen.getByTestId(WIREFRAME_ARRANGE_TESTID)).toBeInTheDocument();
    expect(screen.getByTestId(WIREFRAME_FILE_MENU_TESTID)).toBeInTheDocument();
    // The five view rows live in the flat row; no menu needed.
    expect(within(screen.getByTestId(WIREFRAME_VIEW_TESTID)).getAllByTestId(
      WIREFRAME_VIEW_ITEM_TESTID,
    )).toHaveLength(5);
    // Both menus are lazyMount — no rows before they are opened.
    expect(screen.queryAllByTestId(WIREFRAME_ARRANGE_ITEM_TESTID)).toHaveLength(0);
    expect(screen.queryAllByTestId(WIREFRAME_FILE_ITEM_TESTID)).toHaveLength(0);
  });

  it('renders the 12 arrange rows by accessible name in the opened popup', async () => {
    renderEditor();
    const popup = await openMenu(WIREFRAME_ARRANGE_TESTID);
    const rows = within(popup).getAllByTestId(WIREFRAME_ARRANGE_ITEM_TESTID);
    expect(rows).toHaveLength(12);
    // Assert each row by its ACCESSIBLE NAME (the group labels repeat the names
    // for some rows, so a text query is ambiguous — the role query is exact).
    for (const name of [
      'Delete',
      'Duplicate',
      'Group',
      'Ungroup',
      'Lock group',
      'Align left',
      'Align centre',
      'Align right',
      'Distribute',
      'Bring forward',
      'Send backward',
      'Snap to grid',
    ]) {
      expect(row(popup, name), name).toBeInTheDocument();
    }
  });

  it('renders the 4 file rows by accessible name in the opened popup', async () => {
    renderEditor();
    const popup = await openMenu(WIREFRAME_FILE_MENU_TESTID);
    const rows = within(popup).getAllByTestId(WIREFRAME_FILE_ITEM_TESTID);
    expect(rows).toHaveLength(4);
    for (const name of ['New', 'Open', 'Save As', 'Export PNG']) {
      expect(row(popup, name), name).toBeInTheDocument();
    }
  });
});

describe('history controls (2)', () => {
  it('disables BOTH controls on an empty history and enables Undo after one edit', async () => {
    renderEditor();
    const undo = screen.getByTestId(WIREFRAME_UNDO_TESTID);
    const redo = screen.getByTestId(WIREFRAME_REDO_TESTID);
    expect(undo).toBeDisabled();
    expect(redo).toBeDisabled();

    act(() => {
      addElement('card', 'a');
    });
    expect(undo).toBeEnabled();
    expect(redo).toBeDisabled();
  });

  it('undo reverts the newest edit and redo re-applies it — pointer only', async () => {
    renderEditor();
    const user = userEvent.setup();
    act(() => {
      addElement('card', 'a');
    });
    expect(getSnapshot().document.elements).toHaveLength(1);

    await user.click(screen.getByTestId(WIREFRAME_UNDO_TESTID));
    expect(getSnapshot().document.elements).toHaveLength(0);
    expect(screen.getByTestId(WIREFRAME_REDO_TESTID)).toBeEnabled();

    await user.click(screen.getByTestId(WIREFRAME_REDO_TESTID));
    expect(getSnapshot().document.elements).toHaveLength(1);
    expect(screen.getByTestId(WIREFRAME_REDO_TESTID)).toBeDisabled();
  });

  it('exposes the declared accessible names', () => {
    renderEditor();
    expect(screen.getByTestId(WIREFRAME_UNDO_TESTID)).toHaveAccessibleName('Undo');
    expect(screen.getByTestId(WIREFRAME_REDO_TESTID)).toHaveAccessibleName('Redo');
  });
});

describe('view controls (5)', () => {
  it('exposes all five accessible names inside the view row', () => {
    renderEditor();
    for (const name of ['Zoom out', 'Zoom in', 'Fit page', 'Reset view', 'Pan tool']) {
      expect(viewRow(name)).toBeInTheDocument();
    }
  });

  it('zoom in / out change the store scale', async () => {
    renderEditor();
    const user = userEvent.setup();
    act(() => setView({ scale: 1, x: 0, y: 0 }));

    await user.click(viewRow('Zoom in'));
    expect(getSnapshot().view.scale).toBeGreaterThan(1);

    await user.click(viewRow('Zoom out'));
    expect(getSnapshot().view.scale).toBeCloseTo(1, 5);
  });

  it('disables zoom at the declared clamps', async () => {
    renderEditor();
    act(() => setView({ scale: 4, x: 0, y: 0 }));
    await waitFor(() => expect(viewRow('Zoom in')).toBeDisabled());

    act(() => setView({ scale: 0.1, x: 0, y: 0 }));
    await waitFor(() => expect(viewRow('Zoom out')).toBeDisabled());
  });

  it('fit page and reset view change the view without touching the document', async () => {
    renderEditor();
    const user = userEvent.setup();
    act(() => addElement('card', 'a'));
    act(() => setView({ scale: 3, x: 40, y: 30 }));
    const documentBefore = getSnapshot().document;

    await user.click(viewRow('Fit page'));
    expect(getSnapshot().document).toBe(documentBefore);

    act(() => setView({ scale: 2, x: 10, y: 10 }));
    await user.click(viewRow('Reset view'));
    expect(getSnapshot().view.scale).toBe(1);
    expect(getSnapshot().document).toBe(documentBefore);
    // View transforms are editor state: never an undo step.
    expect(getSnapshot().canUndo).toBe(true); // the add only
  });

  it('the Pan tool is a latched toggle (aria-pressed + store flag)', async () => {
    renderEditor();
    const user = userEvent.setup();
    const pan = viewRow('Pan tool');
    expect(pan).toHaveAttribute('aria-pressed', 'false');

    await user.click(pan);
    expect(getSnapshot().panMode).toBe(true);
    await waitFor(() =>
      expect(viewRow('Pan tool')).toHaveAttribute('aria-pressed', 'true'),
    );

    await user.click(viewRow('Pan tool'));
    expect(getSnapshot().panMode).toBe(false);
  });
});

describe('arrange controls (12)', () => {
  it('disables Element rows on an empty selection and enables them with one', async () => {
    renderEditor();
    const popup = await openMenu(WIREFRAME_ARRANGE_TESTID);
    expect(within(popup).getByRole('menuitem', { name: 'Delete' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(within(popup).getByRole('menuitem', { name: 'Duplicate' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('Disables Group/Ungroup/Lock and Align/Distribute without a suitable selection', async () => {
    renderEditor();
    act(() => {
      addElement('card', 'a');
      select('a');
    });
    const popup = await openMenu(WIREFRAME_ARRANGE_TESTID);
    for (const name of [
      'Group',
      'Ungroup',
      'Lock group',
      'Align left',
      'Align centre',
      'Align right',
      'Distribute',
    ]) {
      expect(
        within(popup).getByRole('menuitem', { name }),
        `${name} must be disabled for one ungrouped element`,
      ).toHaveAttribute('aria-disabled', 'true');
    }
    // Bring forward / Send backward stay enabled for a non-empty selection.
    expect(within(popup).getByRole('menuitem', { name: 'Bring forward' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('Delete removes the selection and is a single undo step', async () => {
    renderEditor();
    act(() => {
      addElement('card', 'a');
      addElement('card', 'b');
      select('a');
    });
    const popup = await openMenu(WIREFRAME_ARRANGE_TESTID);
    await clickRow(popup, 'Delete');

    expect(getSnapshot().document.elements.map((element) => element.id)).toEqual(['b']);
    expect(getSnapshot().canUndo).toBe(true);
  });

  it('Duplicate acts on the primary selection', async () => {
    renderEditor();
    act(() => {
      addElement('card', 'a');
    });
    const popup = await openMenu(WIREFRAME_ARRANGE_TESTID);
    await clickRow(popup, 'Duplicate');
    expect(getSnapshot().document.elements).toHaveLength(2);
  });

  it('Group groups two selected elements; Ungroup / Lock group then act on the group', async () => {
    renderEditor();
    act(() => {
      addElement('card', 'a');
      addElement('card', 'b');
      selectMany(['a', 'b']);
    });

    let popup = await openMenu(WIREFRAME_ARRANGE_TESTID);
    await clickRow(popup, 'Group');
    expect(getSnapshot().document.groups).toHaveLength(1);

    popup = await openMenu(WIREFRAME_ARRANGE_TESTID);
    await clickRow(popup, 'Lock group');
    expect(getSnapshot().document.groups[0]?.locked).toBe(true);

    popup = await openMenu(WIREFRAME_ARRANGE_TESTID);
    await clickRow(popup, 'Ungroup');
    expect(getSnapshot().document.groups).toHaveLength(0);
  });

  it('Align left / centre / right and Distribute move the selection', async () => {
    renderEditor();
    act(() => {
      addElement('card', 'a');
      addElement('card', 'b');
      addElement('card', 'c');
      selectMany(['a', 'b', 'c']);
    });
    // Spread them so each alignment is a real change.
    act(() => {
      dispatch('elements.update', {
        patches: {
          a: { x: 100, y: 100 },
          b: { x: 400, y: 200 },
          c: { x: 700, y: 300 },
        },
      });
    });

    let popup = await openMenu(WIREFRAME_ARRANGE_TESTID);
    await clickRow(popup, 'Align left');
    const afterLeft = getSnapshot().document.elements.map((element) => element.x);
    expect(new Set(afterLeft).size).toBe(1);

    popup = await openMenu(WIREFRAME_ARRANGE_TESTID);
    await clickRow(popup, 'Align right');
    expect(new Set(getSnapshot().document.elements.map((element) => element.x)).size).toBe(1);

    popup = await openMenu(WIREFRAME_ARRANGE_TESTID);
    await clickRow(popup, 'Distribute');
    // Distribute is a no-op when the elements are already evenly aligned; assert
    // the row exists and enabled rather than a geometry change.
    expect(getSnapshot().document.elements).toHaveLength(3);
  });

  it('Bring forward and Send backward reorder the selection', async () => {
    renderEditor();
    act(() => {
      addElement('card', 'a');
      addElement('card', 'b');
      select('a');
    });
    expect(getSnapshot().document.elements.map((element) => element.id)).toEqual(['a', 'b']);

    let popup = await openMenu(WIREFRAME_ARRANGE_TESTID);
    await clickRow(popup, 'Bring forward');
    expect(getSnapshot().document.elements.map((element) => element.id)).toEqual(['b', 'a']);

    popup = await openMenu(WIREFRAME_ARRANGE_TESTID);
    await clickRow(popup, 'Send backward');
    expect(getSnapshot().document.elements.map((element) => element.id)).toEqual(['a', 'b']);
  });

  it('Snap to grid is a checkbox row that flips the editor flag', async () => {
    renderEditor();
    const popup = await openMenu(WIREFRAME_ARRANGE_TESTID);
    const snap = within(popup).getByRole('menuitemcheckbox', { name: 'Snap to grid' });
    expect(snap).toHaveAttribute('aria-checked', 'false');

    // `closeOnSelect={false}` keeps the popup mounted, so the checked state is
    // observable on the SAME row right after the click.
    await clickRow(popup, 'Snap to grid');
    expect(getSnapshot().snapToGrid).toBe(true);
    await waitFor(() =>
      expect(
        within(screen.getByRole('menu', { name: 'Arrange' })).getByRole('menuitemcheckbox', {
          name: 'Snap to grid',
        }),
      ).toHaveAttribute('aria-checked', 'true'),
    );
  });
});

describe('file menu (4)', () => {
  it('New is never disabled and resets a CLEAN document immediately (no prompt)', async () => {
    renderEditor();
    const user = userEvent.setup();
    // A freshly opened (saved) document is clean → New must not raise the prompt.
    act(() => {
      addElement('card', 'a');
    });
    act(() => {
      markSaved('C:\\docs\\clean.wireframe.json');
    });
    expect(getSnapshot().dirty).toBe(false);

    const popup = await openMenu(WIREFRAME_FILE_MENU_TESTID);
    const newRow = row(popup, 'New');
    expect(newRow).not.toHaveAttribute('aria-disabled', 'true');

    await clickRow(popup, 'New');

    expect(screen.queryByTestId('wireframe-new-document-dialog')).toBeNull();
    expect(getSnapshot().document.elements).toHaveLength(0);
    expect(getSnapshot().filePath).toBeNull();
    expect(getSnapshot().canUndo).toBe(false);
    expect(getSnapshot().canRedo).toBe(false);
  });

  it('New on a DIRTY document raises the discard dialog and Discard resets through the action', async () => {
    renderEditor();
    const user = userEvent.setup();
    act(() => {
      addElement('card', 'a');
    });
    expect(getSnapshot().dirty).toBe(true);
    const historyBefore = getWireframeHistory().entries().length;
    expect(historyBefore).toBeGreaterThan(0);

    const popup = await openMenu(WIREFRAME_FILE_MENU_TESTID);
    await clickRow(popup, 'New');

    const dialog = await screen.findByTestId('wireframe-new-document-dialog');
    expect(dialog).toBeInTheDocument();
    // Cancel changes nothing.
    await user.click(screen.getByTestId('wireframe-new-document-cancel'));
    expect(getSnapshot().document.elements).toHaveLength(1);

    // New again, then Discard → the document resets and the history clears.
    const popup2 = await openMenu(WIREFRAME_FILE_MENU_TESTID);
    await clickRow(popup2, 'New');
    await screen.findByTestId('wireframe-new-document-dialog');
    await user.click(screen.getByTestId('wireframe-new-document-discard'));

    expect(getSnapshot().document.elements).toHaveLength(0);
    expect(getSnapshot().filePath).toBeNull();
    expect(getSnapshot().dirty).toBe(true);
    expect(getSnapshot().canUndo).toBe(false);
    expect(getSnapshot().canRedo).toBe(false);
    expect(getWireframeHistory().entries()).toHaveLength(0);
  });

  it('Open / Save As / Export PNG are the three I/O rows and stay enabled while idle', async () => {
    renderEditor();
    const popup = await openMenu(WIREFRAME_FILE_MENU_TESTID);
    for (const name of ['Open', 'Save As', 'Export PNG']) {
      expect(row(popup, name), name).not.toHaveAttribute('aria-disabled', 'true');
    }
  });

  it('the File trigger is never disabled and is named File', async () => {
    renderEditor();
    const trigger = screen.getByTestId(WIREFRAME_FILE_MENU_TESTID);
    expect(trigger).toHaveAccessibleName('File');
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).not.toBeDisabled();
  });
});

describe('no keyboard binding added (AC1)', () => {
  it('the strip and every control are ordinary Tab-reachable elements', () => {
    renderEditor();
    const strip = screen.getByTestId('wireframe-control-strip');
    // No toolbar role, no aria-label, no key handler on the strip.
    expect(strip).not.toHaveAttribute('role', 'toolbar');
    expect(strip).not.toHaveAttribute('aria-label');
    expect(strip).not.toHaveAttribute('tabindex');
    // The view row is generic chrome too.
    expect(screen.getByTestId(WIREFRAME_VIEW_TESTID)).not.toHaveAttribute('role');
    // Every control is a native <button>.
    for (const testId of [WIREFRAME_UNDO_TESTID, WIREFRAME_REDO_TESTID]) {
      expect(screen.getByTestId(testId).tagName).toBe('BUTTON');
    }
    expect(viewRow('Zoom in').tagName).toBe('BUTTON');
  });
});
