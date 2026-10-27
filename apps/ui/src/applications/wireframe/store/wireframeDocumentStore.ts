/**
 * Wireframe document store (Spec #3070, ST-1, C3; extended by Spec #3071, ST-1).
 *
 * MODULE-SCOPED — never React refs. Open -> close -> open keeps the document,
 * the undo history and the saved path because they live at module scope (the
 * AGENTS.md persistence rule; shipped precedent: `windowStore.ts`).
 *
 * Every document mutation commits exactly ONE undo snapshot. Selection, view,
 * pan mode, the snap-to-grid flag, file status and errors are editor state, NOT
 * document history: they never push a snapshot and never flip `dirty`.
 *
 * Spec #3071 turns the selection into a SET (`selectedIds`, document order) and
 * adds groups, stacking order and snap to the shared spine. `selectedId` is no
 * longer stored — it is DERIVED on the public snapshot as `primarySelectedId`
 * so Slice-1 consumers keep working while they migrate to `selectedIds`.
 *
 * The store is the single source of document truth for every sub-task. It has
 * no Konva dependency: the canvas registers its stage through
 * `registerCanvasStage` and the store duck-types `width()`/`height()` for
 * fit-to-viewport resets.
 */

import {
  WIREFRAME_GROUP_MIN_MEMBERS,
  createNewWireframeDocument,
  groupOfElement,
  isElementMovable,
  isWholeGroupSelection,
  reconcileDocumentGroups,
  type WireframeDocument,
  type WireframeGroup,
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
// Group helpers live in the (dependency-free) model; the store re-exports them
// so every consumer has one import site for the group/selection vocabulary.
export {
  WIREFRAME_GROUP_MIN_MEMBERS,
  groupOfElement,
  isElementMovable,
  isWholeGroupSelection,
  reconcileDocumentGroups,
};

export const UNDO_DEPTH = 100;

export type WireframeOperationStatus = 'idle' | 'saving' | 'opening' | 'exporting';

export interface WireframeEditorState {
  document: WireframeDocument;
  /**
   * The selection — element ids in DOCUMENT order (the single source of truth;
   * Spec #3071). An empty array means nothing is selected.
   */
  selectedIds: readonly string[];
  /**
   * Snap-to-grid mode (Spec #3071). EDITOR state, beside `panMode`: module
   * scoped, never in the document, never undoable, never flips `dirty`.
   */
  snapToGrid: boolean;
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

/**
 * The store's public snapshot. `selectedId` is a DERIVED convenience mirror of
 * `primarySelectedId(state)` (the last id in document order) — it is NOT stored
 * and is never a source of truth. It exists so Slice-1 consumers and assertions
 * keep working while they migrate to `selectedIds`.
 */
export interface WireframeEditorSnapshot extends WireframeEditorState {
  selectedId: string | null;
}

/** Document mutations accepted by `dispatch` (each commits ONE snapshot). */
export type WireframeStoreAction =
  | 'element.add'
  | 'element.update'
  | 'element.duplicate'
  | 'element.delete'
  | 'element.toggleLock'
  | 'elements.update'
  | 'elements.delete'
  | 'element.reorder'
  | 'group.create'
  | 'group.ungroup'
  | 'group.toggleLock'
  | 'page.update';

export interface WireframeStoreActionArgs {
  /** `element.add` payload. */
  element?: WireframeElement;
  /** Target element id for update/duplicate/delete/toggleLock. */
  id?: string;
  /** Multi-element targets (`element.toggleLock`, `elements.delete`, reorder/group). */
  ids?: readonly string[];
  /** Target group ids for `group.ungroup` / `group.toggleLock`. */
  groupIds?: readonly string[];
  /** Bulk geometry for `elements.update` (element id -> patch), ONE snapshot. */
  patches?: Readonly<Record<string, WireframeElementPatch>>;
  /** Stacking direction for `element.reorder`. */
  direction?: 'forward' | 'backward';
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
let snapshot: WireframeEditorSnapshot = createSnapshot(state);

function createInitialState(): WireframeEditorState {
  return {
    document: createNewWireframeDocument(),
    selectedIds: [],
    snapToGrid: false,
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

/** The selection source of truth is `selectedIds`; `selectedId` is derived. */
function createSnapshot(next: WireframeEditorState): WireframeEditorSnapshot {
  return { ...next, selectedId: primarySelectedId(next) };
}

function setState(next: WireframeEditorState): void {
  state = next;
  snapshot = createSnapshot(next);
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

/**
 * Normalise a selection against a document: drop ids that do not resolve,
 * drop duplicates, and order the survivors by DOCUMENT order (R-2.7 / the
 * `selectedIds` contract). Never returns a new reference equal in value when
 * the input was already normal.
 */
function documentOrder(ids: readonly string[], document: WireframeDocument): string[] {
  const indexById = new Map(document.elements.map((element, index) => [element.id, index]));
  const seen = new Set<string>();
  const resolved: string[] = [];
  for (const id of ids) {
    if (seen.has(id) || !indexById.has(id)) continue;
    seen.add(id);
    resolved.push(id);
  }
  resolved.sort((left, right) => (indexById.get(left) as number) - (indexById.get(right) as number));
  return resolved;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function replaceState(patch: Partial<WireframeEditorState>): void {
  setState({ ...state, ...patch });
  notify();
}

/**
 * Value equality for the saved unit. Every `WireframeElement` union member
 * carries only primitives (see `model/elements.ts`), so a stable per-key compare
 * is exact — reference identity is not usable because the update path always
 * builds a new document object.
 *
 * `groups` MUST be part of the comparison (Spec #3071): `commitDocument`
 * early-returns on a value-equal candidate, so a groups-only mutation (e.g.
 * group-lock) would otherwise commit nothing — no snapshot, no `dirty`, no
 * notify.
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
  if (left.groups.length !== right.groups.length) return false;
  for (let index = 0; index < left.groups.length; index += 1) {
    if (!groupsEqual(left.groups[index], right.groups[index])) return false;
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

function groupsEqual(left: WireframeGroup, right: WireframeGroup): boolean {
  if (left === right) return true;
  if (left.id !== right.id || left.locked !== right.locked) return false;
  if (left.memberIds.length !== right.memberIds.length) return false;
  for (let index = 0; index < left.memberIds.length; index += 1) {
    if (left.memberIds[index] !== right.memberIds[index]) return false;
  }
  return true;
}

/**
 * Commit a document mutation as exactly ONE undo step. Returns `true` when a
 * snapshot was taken, `false` when the candidate was value-equal (a true no-op:
 * no snapshot, no `dirty` flip, no notify — E-15 / R-2.9).
 *
 * History is the store's invariant, so the guard lives here and every caller
 * benefits. Selection-only changes go through the selection mutators, never
 * through this function, so skipping a value-equal commit can never lose a
 * selection change.
 */
function commitDocument(next: WireframeDocument, selectedIds?: readonly string[]): boolean {
  if (documentsEqual(state.document, next)) return false;
  past.push(state.document);
  if (past.length > UNDO_DEPTH) past.shift();
  future = [];
  setState({
    ...state,
    document: next,
    selectedIds: documentOrder(selectedIds ?? state.selectedIds, next),
    dirty: true,
    canUndo: true,
    canRedo: false,
  });
  notify();
  return true;
}

/** Subscribe to editor-state changes (`useSyncExternalStore`). */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Stable snapshot reference until the next mutation. The returned object also
 * carries the derived `selectedId` (the primary/last selected id).
 */
export function getSnapshot(): WireframeEditorSnapshot {
  return snapshot;
}

/* ------------------------------------------------------------------------- */
/* Derived selectors (never stored)                                            */
/* ------------------------------------------------------------------------- */

/** The last selected id in document order, or `null` when nothing is selected. */
export function primarySelectedId(state: WireframeEditorState): string | null {
  return state.selectedIds.length > 0 ? state.selectedIds[state.selectedIds.length - 1] : null;
}

/** The selected elements, in document order. */
export function selectedElements(state: WireframeEditorState): WireframeElement[] {
  const byId = new Map(state.document.elements.map((element) => [element.id, element]));
  const result: WireframeElement[] = [];
  for (const id of state.selectedIds) {
    const element = byId.get(id);
    if (element) result.push(element);
  }
  return result;
}

/**
 * The ONE group the whole selection belongs to, or `null` (Spec #3071 ST-6 /
 * UI/UX B4). Non-empty **iff** the selection is non-empty AND every selected
 * element resolves to the same group — a PARTIAL membership still reports its
 * group, while an empty selection or a selection spanning two groups is never a
 * group selection. One shared derivation for the root
 * `data-wireframe-selection-group` hook, the panel's Group header and the
 * `ungroup` / `toggleGroupLock` disabled rules.
 */
export function selectionGroup(
  document: WireframeDocument,
  ids: readonly string[],
): WireframeGroup | null {
  if (ids.length === 0) return null;
  const group = groupOfElement(document, ids[0]);
  if (!group) return null;
  for (const id of ids) {
    if (groupOfElement(document, id)?.id !== group.id) return null;
  }
  return group;
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

/** Flip `locked` on every element in `ids` in ONE document object. */
function toggleElementsLocked(
  document: WireframeDocument,
  ids: readonly string[],
): WireframeDocument {
  const targets = new Set(ids);
  return {
    ...document,
    elements: document.elements.map((element) =>
      targets.has(element.id)
        ? ({ ...element, locked: !element.locked } as WireframeElement)
        : element,
    ),
  };
}

/**
 * Move each selected element one position later (`forward`) or earlier
 * (`backward`) in document order (R-2.6 / R-2.9). `forward` walks the selected
 * ids DESCENDING (each swaps with its next); `backward` walks ASCENDING (each
 * swaps with its previous); a swap crossing the array end is skipped. Returns
 * the new element array and whether anything moved.
 */
function reorderElements(
  elements: readonly WireframeElement[],
  ids: readonly string[],
  direction: 'forward' | 'backward',
): { elements: WireframeElement[]; moved: boolean } {
  const next = [...elements];
  const indexById = new Map(next.map((element, index) => [element.id, index]));
  const selected = ids.filter((id) => indexById.has(id));
  const ordered = [...selected].sort(
    (left, right) => (indexById.get(left) as number) - (indexById.get(right) as number),
  );
  let moved = false;

  if (direction === 'forward') {
    for (let index = ordered.length - 1; index >= 0; index -= 1) {
      const current = next.findIndex((element) => element.id === ordered[index]);
      if (current === -1 || current === next.length - 1) continue;
      const swap = next[current];
      next[current] = next[current + 1];
      next[current + 1] = swap;
      moved = true;
    }
  } else {
    for (let index = 0; index < ordered.length; index += 1) {
      const current = next.findIndex((element) => element.id === ordered[index]);
      if (current <= 0) continue;
      const swap = next[current];
      next[current] = next[current - 1];
      next[current - 1] = swap;
      moved = true;
    }
  }

  return { elements: next, moved };
}

/**
 * Apply one document mutation. Unknown actions and missing targets are safe
 * no-ops (no snapshot, no dirty flip) so a stale UI cannot corrupt the store.
 * Returns `true` when a snapshot was committed (R-2.7 / R-2.9).
 */
export function dispatch(
  action: WireframeStoreAction,
  args: WireframeStoreActionArgs = {},
): boolean {
  const { document } = state;

  switch (action) {
    case 'element.add': {
      if (!args.element) return false;
      const next: WireframeDocument = {
        ...document,
        elements: [...document.elements, args.element],
      };
      return commitDocument(next, [args.element.id]);
    }

    case 'element.update': {
      if (!args.id || !args.patch) return false;
      if (!document.elements.some((element) => element.id === args.id)) return false;
      return commitDocument(updateElement(document, args.id, args.patch), state.selectedIds);
    }

    case 'elements.update': {
      if (!args.patches) return false;
      const patches = args.patches;
      let changed = false;
      const elements = document.elements.map((element) => {
        const patch = patches[element.id];
        if (!patch) return element;
        changed = true;
        return { ...element, ...patch } as WireframeElement;
      });
      if (!changed) return false;
      return commitDocument({ ...document, elements }, state.selectedIds);
    }

    case 'element.duplicate': {
      if (!args.id) return false;
      const index = document.elements.findIndex((element) => element.id === args.id);
      if (index === -1) return false;
      const copy = duplicateWireframeElement(document.elements[index], document.page);
      const elements = [...document.elements];
      elements.splice(index + 1, 0, copy);
      return commitDocument({ ...document, elements }, [copy.id]);
    }

    case 'element.delete': {
      if (!args.id) return false;
      if (!document.elements.some((element) => element.id === args.id)) return false;
      const elements = document.elements.filter((element) => element.id !== args.id);
      return commitDocument(
        reconcileDocumentGroups({ ...document, elements }),
        state.selectedIds,
      );
    }

    case 'elements.delete': {
      const ids = args.ids ?? [];
      if (ids.length === 0) return false;
      const remove = new Set(ids);
      const elements = document.elements.filter((element) => !remove.has(element.id));
      if (elements.length === document.elements.length) return false;
      return commitDocument(
        reconcileDocumentGroups({ ...document, elements }),
        state.selectedIds.filter((id) => !remove.has(id)),
      );
    }

    case 'element.toggleLock': {
      const ids = args.ids ?? (args.id ? [args.id] : []);
      if (ids.length === 0) return false;
      if (!document.elements.some((element) => ids.includes(element.id))) return false;
      return commitDocument(toggleElementsLocked(document, ids), state.selectedIds);
    }

    case 'element.reorder': {
      const ids = args.ids ?? [];
      if (!args.direction || ids.length === 0) return false;
      const { elements, moved } = reorderElements(document.elements, ids, args.direction);
      if (!moved) return false;
      return commitDocument({ ...document, elements }, state.selectedIds);
    }

    case 'group.create': {
      const ids = args.ids ?? [];
      // R-2.7: fewer than two elements is not a group; R-1.9: a selection that
      // is exactly one whole group is a no-op.
      if (ids.length < 2) return false;
      if (isWholeGroupSelection(document, ids)) return false;
      const members = documentOrder(ids, document);
      if (members.length < 2) return false;
      const memberSet = new Set(members);
      const pruned = document.groups
        .map((group) => ({
          ...group,
          memberIds: group.memberIds.filter((memberId) => !memberSet.has(memberId)),
        }))
        .filter((group) => group.memberIds.length >= WIREFRAME_GROUP_MIN_MEMBERS);
      const group: WireframeGroup = {
        id: createElementId(),
        memberIds: members,
        locked: false,
      };
      return commitDocument(
        reconcileDocumentGroups({ ...document, groups: [...pruned, group] }),
        members,
      );
    }

    case 'group.ungroup': {
      const groupIds = args.groupIds ?? [];
      if (groupIds.length === 0) return false;
      const remove = new Set(groupIds);
      if (!document.groups.some((group) => remove.has(group.id))) return false;
      // Ungroup is neither a move nor a resize, so a locked group still
      // ungroups (R-1.10). Members keep their geometry and stacking order.
      const groups = document.groups.filter((group) => !remove.has(group.id));
      return commitDocument({ ...document, groups }, state.selectedIds);
    }

    case 'group.toggleLock': {
      const groupIds = args.groupIds ?? [];
      if (groupIds.length === 0) return false;
      const targets = new Set(groupIds);
      if (!document.groups.some((group) => targets.has(group.id))) return false;
      const groups = document.groups.map((group) =>
        targets.has(group.id) ? { ...group, locked: !group.locked } : group,
      );
      return commitDocument({ ...document, groups }, state.selectedIds);
    }

    case 'page.update': {
      if (!args.page) return false;
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

      return commitDocument({
        ...document,
        page: { preset, width, height },
      });
    }

    default:
      return false;
  }
}

/** Reverse the last committed document mutation. */
export function undo(): void {
  if (past.length === 0) return;
  const previous = past.pop() as WireframeDocument;
  future.push(state.document);
  if (future.length > UNDO_DEPTH) future.shift();
  setState({
    ...state,
    document: previous,
    selectedIds: documentOrder(state.selectedIds, previous),
    dirty: true,
    canUndo: past.length > 0,
    canRedo: true,
  });
  notify();
}

/** Re-apply the last undone document mutation. */
export function redo(): void {
  if (future.length === 0) return;
  const next = future.pop() as WireframeDocument;
  past.push(state.document);
  if (past.length > UNDO_DEPTH) past.shift();
  setState({
    ...state,
    document: next,
    selectedIds: documentOrder(state.selectedIds, next),
    dirty: true,
    canUndo: true,
    canRedo: future.length > 0,
  });
  notify();
}

/* ------------------------------------------------------------------------- */
/* Selection mutators (editor state — never a document mutation)               */
/* ------------------------------------------------------------------------- */

/** Replace the selection with one element (or clear it). Never a mutation. */
export function select(id: string | null): void {
  const next = id !== null ? documentOrder([id], state.document) : [];
  if (sameIds(next, state.selectedIds)) return;
  replaceState({ selectedIds: next });
}

/** Replace the selection with several elements (document order). */
export function selectMany(ids: readonly string[]): void {
  const next = documentOrder(ids, state.document);
  if (sameIds(next, state.selectedIds)) return;
  replaceState({ selectedIds: next });
}

/** Shift-click: add an unselected element, or remove a selected one. */
export function toggleSelect(id: string): void {
  if (!state.document.elements.some((element) => element.id === id)) return;
  const has = state.selectedIds.includes(id);
  const raw = has
    ? state.selectedIds.filter((selected) => selected !== id)
    : [...state.selectedIds, id];
  const next = documentOrder(raw, state.document);
  if (sameIds(next, state.selectedIds)) return;
  replaceState({ selectedIds: next });
}

/** Clear the selection. */
export function clearSelection(): void {
  if (state.selectedIds.length === 0) return;
  replaceState({ selectedIds: [] });
}

/** Set the snap-to-grid mode (editor state; never dirty, never undoable). */
export function setSnapToGrid(enabled: boolean): void {
  if (state.snapToGrid === enabled) return;
  replaceState({ snapToGrid: enabled });
}

/** Flip the snap-to-grid mode. */
export function toggleSnapToGrid(): void {
  setSnapToGrid(!state.snapToGrid);
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
 * drop the path and mark it dirty (it has never been written). `snapToGrid` is
 * a module-scoped mode and is left untouched.
 */
export function resetForNewDocument(preset: WireframePagePreset = 'desktop'): void {
  const document = createNewWireframeDocument(preset);
  past = [];
  future = [];
  setState({
    ...state,
    document,
    selectedIds: [],
    view: fitViewForPage(document.page),
    captureView: null,
    filePath: null,
    dirty: true,
    canUndo: false,
    canRedo: false,
    panMode: false,
    status: 'idle',
    error: null,
  });
  notify();
}

/**
 * Replace the document from a successfully opened file (R-4.12): clear
 * selection + history, fit the view, remember the path and mark it saved.
 */
export function loadDocument(document: WireframeDocument, path: string): void {
  past = [];
  future = [];
  setState({
    ...state,
    document,
    selectedIds: [],
    view: fitViewForPage(document.page),
    captureView: null,
    filePath: path,
    dirty: false,
    canUndo: false,
    canRedo: false,
    panMode: false,
    status: 'idle',
    error: null,
  });
  notify();
}

/** A save succeeded: remember the path and clear the dirty flag. */
export function markSaved(path: string): void {
  setState({
    ...state,
    filePath: path,
    dirty: false,
    status: 'idle',
    error: null,
  });
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
  snapshot = createSnapshot(state);
}

/** Test-only: a fresh element id (re-export keeps ST imports in one place). */
export { createElementId };
