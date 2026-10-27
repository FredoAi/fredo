/**
 * Wireframe command table (Spec #3070, ST-3, C4 / C9).
 *
 * ONE table is the single source of truth for the toolbar buttons, the
 * `data-hotkey` attributes (mounted through those buttons) and the Companion's
 * action invocation. "Pressing the shortcut performs the same action as the
 * visible control" is therefore structural, not a duplicated wiring: the
 * engine clicks the button, and the button calls `runWireframeAction(id)` for
 * the same id the table binds.
 *
 * The 35 ids are the C4 catalog verbatim. The first 22 carry the single
 * `[a-z0-9]` hotkey step; the 10 arrangement ids (Spec #3071, ST-4) carry a
 * two-step `g+<step>` binding, and the two Slice-1 view ids were RE-BOUND to
 * two-step `g`-namespace sequences so the saturated first-step budget
 * (`[a-z0-9]` = 36 slots) still fits every action. `g` is therefore a
 * PREFIX-ONLY namespace — there is no bare `g` binding anywhere.
 * `wireframe.document.new` is a toolbar-only button (no hotkey); the two
 * `wireframe.companion.*` ids are Companion-only (`toolbar: false`, no hotkey)
 * and are executed by ST-7's companion layer — their `run` is deliberately
 * absent here.
 *
 * The descriptions are user-facing (the Companion lists them per R-6.1) and
 * ST-7 mirrors them verbatim in the Rust catalog
 * (`infrastructure/companion/wireframe_catalog.rs`).
 *
 * Nothing in this module touches telemetry or the RTDB row pipeline: the
 * wireframe document is document state, and every mutation goes through the
 * module-scoped store.
 */

import {
  createDefaultElement,
  type WireframeElement,
  type WireframeElementPatch,
  type WireframeElementType,
  type WireframeSectionPreset,
  type WireframeShapeKind,
} from '../model/elements';
import {
  alignRects,
  canAlign,
  canDistribute,
  distributeRectsHorizontally,
  selectionBounds,
  type WireframeAlignEdge,
} from '../model/arrange';
import {
  dispatch,
  getSnapshot,
  groupOfElement,
  isElementMovable,
  redo,
  resetForNewDocument,
  toggleSnapToGrid,
  undo,
} from '../store/wireframeDocumentStore';
import { fitPage, resetView, togglePan, zoomIn, zoomOut } from './wireframeViewActions';

/** One row of the command table (binding shape for ST-7 / the Rust catalog). */
export interface WireframeActionDefinition {
  /** Stable action id, e.g. `wireframe.add.text` (C4 verbatim). */
  id: string;
  /** Human description; identical text to the Rust catalog entry. */
  description: string;
  /** `data-hotkey` binding: one `[a-z0-9]` step, or a two-step `a+b` sequence. */
  hotkey?: string;
  /** `true` when the action renders a toolbar control. */
  toolbar: boolean;
  /** Perform the action; `false` when nothing was performed. */
  run?: () => boolean;
}

/** Options accepted by the insert actions (insert menu presets/kinds). */
export interface AddWireframeElementOptions {
  preset?: WireframeSectionPreset;
  shape?: WireframeShapeKind;
  text?: string;
}

/* ------------------------------------------------------------------------- */
/* File-action seam (ST-6 owns `./wireframeFileActions.ts`)                    */
/* ------------------------------------------------------------------------- */

/**
 * The handlers ST-6's `actions/wireframeFileActions.ts` provides.
 *
 * ST-3 ships NO file I/O, so the module may not exist at this commit. The seam
 * is discovered through a Vite `import.meta.glob` (an empty match is legal and
 * makes every file action a `false` no-op), and ST-6's module is picked up
 * automatically the moment it is added — no edit to this file.
 *
 * CONTRACT for ST-6: `wireframeFileActions.ts` exports `saveAs`,
 * `openDocument` and `exportPng` (each `() => unknown`). Do NOT register from
 * that module's top level: the eager glob makes the import a cycle, so the
 * export path is the safe one. `registerWireframeFileActionHandlers` exists for
 * tests and for an explicit re-wiring; a registered handler wins over the
 * discovered export.
 *
 * A handler owns its own status/error transitions (`setStatus`, `setError`);
 * returning `true` here only means "the action was invoked".
 */
export interface WireframeFileActionHandlers {
  saveAs?: () => unknown;
  openDocument?: () => unknown;
  exportPng?: () => unknown;
}

type WireframeFileActionName = keyof WireframeFileActionHandlers;

const discoveredFileActionModules = import.meta.glob('./wireframeFileActions.ts', {
  eager: true,
}) as unknown as Record<string, WireframeFileActionHandlers>;

let registeredFileHandlers: WireframeFileActionHandlers = {};

/** Register (or override) the ST-6 file-action handlers. */
export function registerWireframeFileActionHandlers(
  handlers: WireframeFileActionHandlers,
): void {
  registeredFileHandlers = { ...registeredFileHandlers, ...handlers };
}

/** Test-only: forget any registered file-action handlers. */
export function resetWireframeFileActionHandlersForTests(): void {
  registeredFileHandlers = {};
}

function resolveFileHandler(
  name: WireframeFileActionName,
): (() => unknown) | null {
  const registered = registeredFileHandlers[name];
  if (typeof registered === 'function') return registered;
  for (const module of Object.values(discoveredFileActionModules)) {
    const handler = module?.[name];
    if (typeof handler === 'function') return handler;
  }
  return null;
}

/** Invoke one file action; `false` when ST-6 has not supplied a handler. */
function runFileAction(name: WireframeFileActionName): boolean {
  const handler = resolveFileHandler(name);
  if (!handler) return false;
  try {
    const result = handler();
    // The handler owns its failure surface (the file-error banner). Swallow the
    // rejection boundary so an async failure can never become an unhandled
    // rejection; the store already carries the message.
    if (result && typeof (result as Promise<unknown>).catch === 'function') {
      void (result as Promise<unknown>).catch(() => {});
    }
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------------- */
/* Action implementations                                                      */
/* ------------------------------------------------------------------------- */

/** Add one element of `type` (centre-cascaded or page-anchored) and select it. */
export function addWireframeElement(
  type: WireframeElementType,
  options: AddWireframeElementOptions = {},
): boolean {
  const { document } = getSnapshot();
  const element = createDefaultElement(type, {
    page: document.page,
    elements: document.elements,
    preset: options.preset,
    shape: options.shape,
    text: options.text,
  });
  dispatch('element.add', { element });
  return true;
}

/** The current selection, or `null` when there is none (or it went stale). */
function selectedElementId(): string | null {
  const { selectedId, document } = getSnapshot();
  if (selectedId === null) return null;
  return document.elements.some((element) => element.id === selectedId)
    ? selectedId
    : null;
}

function duplicateSelection(): boolean {
  const id = selectedElementId();
  if (id === null) return false;
  dispatch('element.duplicate', { id });
  return true;
}

function deleteSelection(): boolean {
  const id = selectedElementId();
  if (id === null) return false;
  dispatch('element.delete', { id });
  return true;
}

function toggleSelectionLock(): boolean {
  const id = selectedElementId();
  if (id === null) return false;
  dispatch('element.toggleLock', { id });
  return true;
}

function runUndo(): boolean {
  if (!getSnapshot().canUndo) return false;
  undo();
  return true;
}

function runRedo(): boolean {
  if (!getSnapshot().canRedo) return false;
  redo();
  return true;
}

/** Run a view transform; `false` when the view did not move (unmeasured stage). */
function runViewChange(change: () => void): boolean {
  const before = getSnapshot().view;
  change();
  const after = getSnapshot().view;
  return (
    after.scale !== before.scale || after.x !== before.x || after.y !== before.y
  );
}

function togglePanMode(): boolean {
  const expected = !getSnapshot().panMode;
  togglePan();
  return getSnapshot().panMode === expected;
}

/* ------------------------------------------------------------------------- */
/* Arrange implementations (Spec #3071, ST-4)                                  */
/* ------------------------------------------------------------------------- */

/** The selected elements, in document order (the selection is already ordered). */
function selectedElementsInOrder(): WireframeElement[] {
  const { selectedIds, document } = getSnapshot();
  const selected = new Set(selectedIds);
  return document.elements.filter((element) => selected.has(element.id));
}

/** The distinct ids of every group the current selection touches. */
function selectedGroupIds(): string[] {
  const { document } = getSnapshot();
  const ids = new Set<string>();
  for (const element of selectedElementsInOrder()) {
    const group = groupOfElement(document, element.id);
    if (group) ids.add(group.id);
  }
  return [...ids];
}

/**
 * Group the selection (R-1.3 / R-1.9). The STORE owns the rule — a selection of
 * fewer than two elements, or one that is exactly a whole existing group, is a
 * `false` no-op with nothing committed, so this returns the dispatch result.
 */
function groupSelection(): boolean {
  return dispatch('group.create', { ids: getSnapshot().selectedIds });
}

/** Ungroup every group the selection touches (R-1.5); `false` when it touches none. */
function ungroupSelection(): boolean {
  return dispatch('group.ungroup', { groupIds: selectedGroupIds() });
}

/** Flip the lock of every group the selection touches (R-1.7); `false` when none. */
function toggleGroupLockSelection(): boolean {
  return dispatch('group.toggleLock', { groupIds: selectedGroupIds() });
}

/**
 * Toggle snap-to-grid (R-2.1). EDITOR state, never a document mutation — it
 * never commits a snapshot and never flips `dirty`, so it always returns `true`.
 */
function toggleSnapMode(): boolean {
  toggleSnapToGrid();
  return true;
}

/**
 * Align the MOVABLE selected elements to `edge` of the WHOLE selection's union
 * bounds (R-2.3 / R-2.8 — locked members stay put and still anchor the target).
 *
 * Returns `false` when fewer than two elements are movable, and when the
 * document is already aligned (R-2.9: the store's value-equal guard rejects the
 * candidate, so nothing commits and no undo step is bought).
 */
function alignSelection(edge: WireframeAlignEdge): boolean {
  const { document } = getSnapshot();
  const selected = selectedElementsInOrder();
  const movable = selected.filter((element) => isElementMovable(document, element));
  if (!canAlign(movable.length)) return false;
  const bounds = selectionBounds(selected);
  if (!bounds) return false;
  const aligned = alignRects(movable, edge, bounds);
  const patches: Record<string, WireframeElementPatch> = {};
  movable.forEach((element, index) => {
    patches[element.id] = { x: aligned[index].x };
  });
  return dispatch('elements.update', { patches });
}

/**
 * Distribute the MOVABLE selected elements with equal horizontal gaps (R-2.4 /
 * R-2.8). Returns `false` when fewer than three are movable, and when the
 * selection is already evenly distributed (R-2.9).
 */
function distributeSelection(): boolean {
  const { document } = getSnapshot();
  const movable = selectedElementsInOrder().filter((element) =>
    isElementMovable(document, element),
  );
  if (!canDistribute(movable.length)) return false;
  const distributed = distributeRectsHorizontally(movable);
  const patches: Record<string, WireframeElementPatch> = {};
  movable.forEach((element, index) => {
    patches[element.id] = { x: distributed[index].x };
  });
  return dispatch('elements.update', { patches });
}

/**
 * Move the selection one step in paint order (R-2.6). Returns `false` for an
 * empty selection and for a clamped end (R-2.9: nothing moved, nothing commits).
 */
function reorderSelection(direction: 'forward' | 'backward'): boolean {
  return dispatch('element.reorder', { ids: getSnapshot().selectedIds, direction });
}

/* ------------------------------------------------------------------------- */
/* The table                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * The 35-action command catalog (C4 order = the catalog order the Companion
 * lists). Descriptions match the Rust catalog text verbatim.
 */
export const WIREFRAME_ACTIONS: readonly WireframeActionDefinition[] = [
  {
    id: 'wireframe.add.text',
    description: 'Add a text element (body or heading style)',
    hotkey: '1',
    toolbar: true,
    run: () => addWireframeElement('text'),
  },
  {
    id: 'wireframe.add.button',
    description: 'Add a button element',
    hotkey: '2',
    toolbar: true,
    run: () => addWireframeElement('button'),
  },
  {
    id: 'wireframe.add.input',
    description: 'Add an input field element',
    hotkey: '3',
    toolbar: true,
    run: () => addWireframeElement('input'),
  },
  {
    id: 'wireframe.add.image',
    description: 'Add an image placeholder frame',
    hotkey: '4',
    toolbar: true,
    run: () => addWireframeElement('image'),
  },
  {
    id: 'wireframe.add.icon',
    description: 'Add an icon from the curated set',
    hotkey: '5',
    toolbar: true,
    run: () => addWireframeElement('icon'),
  },
  {
    id: 'wireframe.add.card',
    description: 'Add a card/container element',
    hotkey: '6',
    toolbar: true,
    run: () => addWireframeElement('card'),
  },
  {
    id: 'wireframe.add.section',
    description: 'Add a site frame section (header, nav bar, sidebar, footer)',
    hotkey: '7',
    toolbar: true,
    run: () => addWireframeElement('section'),
  },
  {
    id: 'wireframe.add.shape',
    description: 'Add a basic shape',
    hotkey: '8',
    toolbar: true,
    run: () => addWireframeElement('shape'),
  },
  {
    id: 'wireframe.add.line',
    description: 'Add a line',
    hotkey: '9',
    toolbar: true,
    run: () => addWireframeElement('line'),
  },
  {
    id: 'wireframe.element.duplicate',
    description: 'Duplicate the selected element',
    hotkey: 'p',
    toolbar: true,
    run: duplicateSelection,
  },
  {
    id: 'wireframe.element.delete',
    description: 'Delete the selected element',
    hotkey: 'k',
    toolbar: true,
    run: deleteSelection,
  },
  {
    id: 'wireframe.element.toggleLock',
    description: 'Lock or unlock the selected element',
    hotkey: 'l',
    toolbar: true,
    run: toggleSelectionLock,
  },
  {
    id: 'wireframe.edit.undo',
    description: 'Undo the last change',
    hotkey: 'u',
    toolbar: true,
    run: runUndo,
  },
  {
    id: 'wireframe.edit.redo',
    description: 'Redo the last undone change',
    hotkey: 'y',
    toolbar: true,
    run: runRedo,
  },
  {
    id: 'wireframe.zoom.in',
    description: 'Zoom in',
    // Re-bound by Spec #3071 ST-4: `g` is the prefix-only arrangement namespace.
    hotkey: 'g+i',
    toolbar: true,
    run: () => runViewChange(zoomIn),
  },
  {
    id: 'wireframe.zoom.out',
    description: 'Zoom out',
    // Re-bound by Spec #3071 ST-4 (`m` is now free).
    hotkey: 'g+o',
    toolbar: true,
    run: () => runViewChange(zoomOut),
  },
  {
    id: 'wireframe.view.fitPage',
    description: 'Fit the page to the screen',
    hotkey: 'n',
    toolbar: true,
    run: () => runViewChange(fitPage),
  },
  {
    id: 'wireframe.view.resetView',
    description: 'Reset to 100% and centre the page',
    hotkey: '0',
    toolbar: true,
    run: () => runViewChange(resetView),
  },
  {
    id: 'wireframe.view.togglePan',
    description: 'Toggle the pan tool',
    hotkey: 'h',
    toolbar: true,
    run: togglePanMode,
  },
  {
    id: 'wireframe.file.saveAs',
    description: 'Save the document to a new file',
    hotkey: 'w',
    toolbar: true,
    run: () => runFileAction('saveAs'),
  },
  {
    id: 'wireframe.file.open',
    description: 'Open a saved wireframe document',
    hotkey: 'o',
    toolbar: true,
    run: () => runFileAction('openDocument'),
  },
  {
    id: 'wireframe.file.exportPng',
    description: 'Export the page as a PNG',
    hotkey: 't',
    toolbar: true,
    run: () => runFileAction('exportPng'),
  },
  // ── Arrange (Spec #3071, ST-4) — the `g` namespace, all two-step ─────────
  {
    id: 'wireframe.arrange.group',
    description: 'Group the selected elements',
    hotkey: 'g+g',
    toolbar: true,
    run: groupSelection,
  },
  {
    id: 'wireframe.arrange.ungroup',
    description: 'Ungroup the selected group',
    hotkey: 'g+u',
    toolbar: true,
    run: ungroupSelection,
  },
  {
    id: 'wireframe.arrange.toggleGroupLock',
    description: 'Lock or unlock the selected group',
    hotkey: 'g+l',
    toolbar: true,
    run: toggleGroupLockSelection,
  },
  {
    id: 'wireframe.arrange.toggleSnap',
    description: 'Toggle snap to grid',
    hotkey: 'g+s',
    toolbar: true,
    run: toggleSnapMode,
  },
  {
    id: 'wireframe.arrange.alignLeft',
    description: 'Align the selected elements to the left',
    hotkey: 'g+a',
    toolbar: true,
    run: () => alignSelection('left'),
  },
  {
    id: 'wireframe.arrange.alignCenter',
    description: 'Align the selected elements to the centre',
    hotkey: 'g+c',
    toolbar: true,
    run: () => alignSelection('center'),
  },
  {
    id: 'wireframe.arrange.alignRight',
    description: 'Align the selected elements to the right',
    hotkey: 'g+r',
    toolbar: true,
    run: () => alignSelection('right'),
  },
  {
    id: 'wireframe.arrange.distribute',
    description: 'Distribute the selected elements with equal gaps',
    hotkey: 'g+d',
    toolbar: true,
    run: distributeSelection,
  },
  {
    id: 'wireframe.arrange.bringForward',
    description: 'Bring the selected elements forward',
    hotkey: 'g+f',
    toolbar: true,
    run: () => reorderSelection('forward'),
  },
  {
    id: 'wireframe.arrange.sendBackward',
    description: 'Send the selected elements backward',
    hotkey: 'g+b',
    toolbar: true,
    run: () => reorderSelection('backward'),
  },
  {
    id: 'wireframe.document.new',
    description: 'Start a new empty wireframe',
    toolbar: true,
    run: () => {
      resetForNewDocument();
      return true;
    },
  },
  {
    id: 'wireframe.companion.listActions',
    description: 'List the Wireframe actions with ids and descriptions',
    toolbar: false,
  },
  {
    id: 'wireframe.companion.draftApp',
    description: 'Draft a starter wireframe for a named app (app_name, optional summary)',
    toolbar: false,
  },
];

const ACTIONS_BY_ID: ReadonlyMap<string, WireframeActionDefinition> = new Map(
  WIREFRAME_ACTIONS.map((action) => [action.id, action]),
);

/** Resolve one action by id (`undefined` for an unknown id). */
export function findWireframeAction(
  id: string,
): WireframeActionDefinition | undefined {
  return ACTIONS_BY_ID.get(id);
}

/**
 * Perform the action for `id`. Returns `false` for an unknown id, for a
 * Companion-only id with no local `run`, and whenever the action performed
 * nothing (no selection, empty history, unmeasured viewport, unwired file I/O).
 */
export function runWireframeAction(id: string): boolean {
  const action = ACTIONS_BY_ID.get(id);
  if (!action?.run) return false;
  return action.run();
}

/**
 * The C7 `data-testid` for an action's toolbar control: the id after
 * `wireframe.` with `.` -> `-`, camelCase preserved
 * (`wireframe-action-element-toggleLock`).
 */
export function wireframeActionTestId(id: string): string {
  return `wireframe-action-${id.replace(/^wireframe\./, '').replace(/\./g, '-')}`;
}
