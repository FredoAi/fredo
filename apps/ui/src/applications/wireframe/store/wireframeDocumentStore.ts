/**
 * Wireframe document store (Spec #3070, ST-1, C3).
 *
 * MODULE-SCOPED — never React refs. Open -> close -> open keeps the document,
 * the undo history and the saved path because they live at module scope (the
 * AGENTS.md persistence rule; shipped precedent: `windowStore.ts`).
 *
 * Every document mutation commits exactly ONE undo snapshot. Selection, view,
 * pan mode, file status and errors are editor state, NOT document history:
 * they never push a snapshot and never flip `dirty`.
 *
 * The store is the single source of document truth for every sub-task. It has
 * no Konva dependency: the canvas registers its stage through
 * `registerCanvasStage` and the store duck-types `width()`/`height()` for
 * fit-to-viewport resets.
 */

import {
  createNewWireframeDocument,
  type WireframeDocument,
  type WireframePage,
} from '../model/document';
import {
  createElementId,
  duplicateWireframeElement,
  type WireframeElement,
  type WireframeElementPatch,
} from '../model/elements';
import {
  clampPageDimension,
  clampViewScale,
  fitView,
  type WireframeView,
  type WireframeViewport,
} from '../model/geometry';
import {
  pagePresetDimensions,
  type WireframePagePreset,
} from '../model/pagePresets';

export type { WireframeView } from '../model/geometry';

export const UNDO_DEPTH = 100;

export type WireframeOperationStatus = 'idle' | 'saving' | 'opening' | 'exporting';

export interface WireframeEditorState {
  document: WireframeDocument;
  selectedId: string | null;
  view: WireframeView;
  /**
   * Transient capture override (F-33). While non-null the canvas paints the
   * document through this view instead of `view`, so an export renders the
   * 100 % identity frame no matter where the user has panned/zoomed to.
   *
   * It is a PAINT OVERRIDE ONLY: never persisted, never part of an undo
   * snapshot, never flips `dirty`, never changes the selection and never shows
   * up in the `data-wireframe-*` root attributes. `exportPng()` sets it around
   * the capture and always clears it again.
   */
  captureView: WireframeView | null;
  filePath: string | null;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  panMode: boolean;
  status: WireframeOperationStatus;
  error: string | null;
}

/** Document mutations accepted by `dispatch` (each commits ONE snapshot). */
export type WireframeStoreAction =
  | 'element.add'
  | 'element.update'
  | 'element.duplicate'
  | 'element.delete'
  | 'element.toggleLock'
  | 'page.update';

export interface WireframeStoreActionArgs {
  /** `element.add` payload. */
  element?: WireframeElement;
  /** Target element id for update/duplicate/delete/toggleLock. */
  id?: string;
  /** Property patch for `element.update`. */
  patch?: WireframeElementPatch;
  /** Page patch for `page.update` (named preset sets its exact dimensions). */
  page?: Partial<WireframePage>;
}

type Listener = () => void;

interface CanvasStageLike {
  width: () => number;
  height: () => number;
}

let listeners = new Set<Listener>();
let canvasStage: CanvasStageLike | null = null;

/** Past documents, oldest first; capped at `UNDO_DEPTH`. */
let past: WireframeDocument[] = [];
/** Undone documents, most-recently-undone last. */
let future: WireframeDocument[] = [];

let state: WireframeEditorState = createInitialState();

function createInitialState(): WireframeEditorState {
  return {
    document: createNewWireframeDocument(),
    selectedId: null,
    view: { scale: 1, x: 0, y: 0 },
    captureView: null,
    filePath: null,
    // A brand-new document has never been written to a file (C3 binding).
    dirty: true,
    canUndo: false,
    canRedo: false,
    panMode: false,
    status: 'idle',
    error: null,
  };
}

function notify(): void {
  for (const listener of listeners) listener();
}

function readStageViewport(): WireframeViewport | null {
  if (!canvasStage) return null;
  try {
    const width = canvasStage.width();
    const height = canvasStage.height();
    if (
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width <= 0 ||
      height <= 0
    ) {
      return null;
    }
    return { width, height };
  } catch {
    return null;
  }
}

function fitViewForPage(page: WireframePage): WireframeView {
  const viewport = readStageViewport();
  return viewport ? fitView(page, viewport) : { scale: 1, x: 0, y: 0 };
}

/** Clear a selection that no longer resolves against the document (R-2.7). */
function reconcileSelection(
  document: WireframeDocument,
  selectedId: string | null,
): string | null {
  if (selectedId === null) return null;
  return document.elements.some((element) => element.id === selectedId) ? selectedId : null;
}

function replaceState(patch: Partial<WireframeEditorState>): void {
  state = { ...state, ...patch };
  notify();
}

/**
 * Value equality for the saved unit. Every `WireframeElement` union member
 * carries only primitives (see `model/elements.ts`), so a stable per-key compare
 * is exact — reference identity is not usable because the update path always
 * builds a new document object.
 */
function documentsEqual(left: WireframeDocument, right: WireframeDocument): boolean {
  if (left === right) return true;
  if (
    left.page.preset !== right.page.preset ||
    left.page.width !== right.page.width ||
    left.page.height !== right.page.height
  ) {
    return false;
  }
  if (left.elements.length !== right.elements.length) return false;
  for (let index = 0; index < left.elements.length; index += 1) {
    if (!elementsEqual(left.elements[index], right.elements[index])) return false;
  }
  return true;
}

function elementsEqual(left: WireframeElement, right: WireframeElement): boolean {
  if (left === right) return true;
  const leftFields = left as unknown as Record<string, unknown>;
  const rightFields = right as unknown as Record<string, unknown>;
  const leftKeys = Object.keys(leftFields);
  if (leftKeys.length !== Object.keys(rightFields).length) return false;
  for (const key of leftKeys) {
    if (leftFields[key] !== rightFields[key]) return false;
  }
  return true;
}

/**
 * Commit a document mutation as exactly ONE undo step.
 *
 * A candidate that is value-equal to the current document is not a mutation and
 * is skipped entirely — no snapshot, no `dirty` flip, no notify (E-15: a
 * stepper click focuses the number field and the following blur re-commits the
 * value the store already holds, which must not buy a second history entry).
 * History is the store's invariant, so the guard lives here and every caller
 * benefits. Selection-only changes go through `select()`, never through this
 * function, so skipping a value-equal commit can never lose a selection change.
 */
function commitDocument(next: WireframeDocument, selectedId?: string | null): void {
  if (documentsEqual(state.document, next)) return;
  past.push(state.document);
  if (past.length > UNDO_DEPTH) past.shift();
  future = [];
  const nextSelected =
    selectedId === undefined ? reconcileSelection(next, state.selectedId) : reconcileSelection(next, selectedId);
  state = {
    ...state,
    document: next,
    selectedId: nextSelected,
    dirty: true,
    canUndo: true,
    canRedo: false,
  };
  notify();
}

/** Subscribe to editor-state changes (`useSyncExternalStore`). */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Stable snapshot reference until the next mutation. */
export function getSnapshot(): WireframeEditorState {
  return state;
}

function updateElement(
  document: WireframeDocument,
  id: string,
  patch: WireframeElementPatch,
): WireframeDocument {
  return {
    ...document,
    elements: document.elements.map((element) =>
      element.id === id ? ({ ...element, ...patch } as WireframeElement) : element,
    ),
  };
}

/**
 * Apply one document mutation. Unknown actions and missing targets are safe
 * no-ops (no snapshot, no dirty flip) so a stale UI cannot corrupt the store.
 */
export function dispatch(
  action: WireframeStoreAction,
  args: WireframeStoreActionArgs = {},
): void {
  const { document } = state;

  switch (action) {
    case 'element.add': {
      if (!args.element) return;
      const next: WireframeDocument = {
        ...document,
        elements: [...document.elements, args.element],
      };
      commitDocument(next, args.element.id);
      return;
    }

    case 'element.update': {
      if (!args.id || !args.patch) return;
      if (!document.elements.some((element) => element.id === args.id)) return;
      commitDocument(updateElement(document, args.id, args.patch), state.selectedId);
      return;
    }

    case 'element.duplicate': {
      if (!args.id) return;
      const index = document.elements.findIndex((element) => element.id === args.id);
      if (index === -1) return;
      const copy = duplicateWireframeElement(document.elements[index], document.page);
      const elements = [...document.elements];
      elements.splice(index + 1, 0, copy);
      commitDocument({ ...document, elements }, copy.id);
      return;
    }

    case 'element.delete': {
      if (!args.id) return;
      if (!document.elements.some((element) => element.id === args.id)) return;
      commitDocument(
        {
          ...document,
          elements: document.elements.filter((element) => element.id !== args.id),
        },
        state.selectedId === args.id ? null : state.selectedId,
      );
      return;
    }

    case 'element.toggleLock': {
      if (!args.id) return;
      const target = document.elements.find((element) => element.id === args.id);
      if (!target) return;
      commitDocument(
        updateElement(document, args.id, { locked: !target.locked }),
        state.selectedId,
      );
      return;
    }

    case 'page.update': {
      if (!args.page) return;
      const patch = args.page;
      let preset: WireframePagePreset = patch.preset ?? 'custom';
      let width: number;
      let height: number;

      if (patch.preset && patch.preset !== 'custom') {
        const dimensions = pagePresetDimensions(patch.preset);
        width = dimensions.width;
        height = dimensions.height;
      } else {
        preset = patch.preset ?? 'custom';
        width = clampPageDimension(patch.width ?? document.page.width);
        height = clampPageDimension(patch.height ?? document.page.height);
      }

      commitDocument({
        ...document,
        page: { preset, width, height },
      });
      return;
    }

    default:
      return;
  }
}

/** Reverse the last committed document mutation. */
export function undo(): void {
  if (past.length === 0) return;
  const previous = past.pop() as WireframeDocument;
  future.push(state.document);
  if (future.length > UNDO_DEPTH) future.shift();
  state = {
    ...state,
    document: previous,
    selectedId: reconcileSelection(previous, state.selectedId),
    dirty: true,
    canUndo: past.length > 0,
    canRedo: true,
  };
  notify();
}

/** Re-apply the last undone document mutation. */
export function redo(): void {
  if (future.length === 0) return;
  const next = future.pop() as WireframeDocument;
  past.push(state.document);
  if (past.length > UNDO_DEPTH) past.shift();
  state = {
    ...state,
    document: next,
    selectedId: reconcileSelection(next, state.selectedId),
    dirty: true,
    canUndo: true,
    canRedo: future.length > 0,
  };
  notify();
}

/** Select one element (or clear). Never a document mutation (R-2.1). */
export function select(id: string | null): void {
  const nextId =
    id !== null && state.document.elements.some((element) => element.id === id) ? id : null;
  if (nextId === state.selectedId) return;
  replaceState({ selectedId: nextId });
}

/** Set the view transform (clamped scale). Never a document mutation (R-4.2). */
export function setView(view: WireframeView): void {
  replaceState({
    view: {
      scale: clampViewScale(view.scale),
      x: Number.isFinite(view.x) ? view.x : 0,
      y: Number.isFinite(view.y) ? view.y : 0,
    },
  });
}

/**
 * Paint the document at 100 % identity for one synchronous capture (F-33).
 * Editor state only — the live `view`, the document, the selection, `dirty` and
 * the undo history are untouched.
 */
export function beginCaptureView(): void {
  replaceState({ captureView: { scale: 1, x: 0, y: 0 } });
}

/** Drop the capture override and return to the live view (F-33). */
export function endCaptureView(): void {
  if (state.captureView === null) return;
  replaceState({ captureView: null });
}

/** Fit the current page into the registered canvas stage (or 100% fallback). */
export function fitPageToViewport(): void {
  replaceState({ view: fitViewForPage(state.document.page) });
}

/** Toggle pan mode (view-only). */
export function setPanMode(panMode: boolean): void {
  if (state.panMode === panMode) return;
  replaceState({ panMode });
}

/** Toggle pan mode (view-only convenience for ST-5). */
export function togglePanMode(): void {
  setPanMode(!state.panMode);
}

/** Set the pending file-operation state (ST-6). */
export function setStatus(status: WireframeOperationStatus): void {
  if (state.status === status) return;
  replaceState({ status });
}

/** Set or clear the file-error surface message (ST-6). */
export function setError(error: string | null): void {
  if (state.error === error) return;
  replaceState({ error });
}

/**
 * Start a brand-new document (R-4.12): clear selection + history, fit the view,
 * drop the path and mark it dirty (it has never been written).
 */
export function resetForNewDocument(preset: WireframePagePreset = 'desktop'): void {
  const document = createNewWireframeDocument(preset);
  past = [];
  future = [];
  state = {
    ...state,
    document,
    selectedId: null,
    view: fitViewForPage(document.page),
    captureView: null,
    filePath: null,
    dirty: true,
    canUndo: false,
    canRedo: false,
    panMode: false,
    status: 'idle',
    error: null,
  };
  notify();
}

/**
 * Replace the document from a successfully opened file (R-4.12): clear
 * selection + history, fit the view, remember the path and mark it saved.
 */
export function loadDocument(document: WireframeDocument, path: string): void {
  past = [];
  future = [];
  state = {
    ...state,
    document,
    selectedId: null,
    view: fitViewForPage(document.page),
    captureView: null,
    filePath: path,
    dirty: false,
    canUndo: false,
    canRedo: false,
    panMode: false,
    status: 'idle',
    error: null,
  };
  notify();
}

/** A save succeeded: remember the path and clear the dirty flag. */
export function markSaved(path: string): void {
  state = {
    ...state,
    filePath: path,
    dirty: false,
    status: 'idle',
    error: null,
  };
  notify();
}

/**
 * Register the canvas stage (ST-2) so view resets can fit the measured
 * viewport. Pass `null` on unmount.
 */
export function registerCanvasStage(stage: CanvasStageLike | null): void {
  canvasStage = stage;
}

/** Read the registered canvas stage (ST-6 uses it for page capture). */
export function getCanvasStage(): CanvasStageLike | null {
  return canvasStage;
}

/** Test-only: wipe module state, history, stage and listeners. */
export function resetWireframeStoreForTests(): void {
  listeners = new Set<Listener>();
  canvasStage = null;
  past = [];
  future = [];
  state = createInitialState();
}

/** Test-only: a fresh element id (re-export keeps ST imports in one place). */
export { createElementId };
