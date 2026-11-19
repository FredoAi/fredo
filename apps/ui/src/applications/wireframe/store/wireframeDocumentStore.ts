/**
 * Wireframe document store (Spec #3070, ST-1, C3; extended by Spec #3071, ST-1;
 * app-local history by Spec #3151, ST-3).
 *
 * MODULE-SCOPED — never React refs. Open -> close -> open keeps the document,
 * the undo history and the saved path because they live at module scope (the
 * AGENTS.md persistence rule; shipped precedent: `windowStore.ts`).
 *
 * THE APP-LOCAL HISTORY IS THE ONE UNDO AUTHORITY (Spec #3151, AC4). The shared
 * navigation journal that used to play this role is being removed with the
 * engine, so Wireframe owns a bounded `WireframeHistory`: every document
 * mutation commits exactly ONE entry (a `before`/`after` field-scoped delta
 * pair), and the public `undo()`/`redo()`/`canUndo`/`canRedo` read that SAME
 * instance, so there is no second history container. `dispatch` is the
 * compatibility funnel for the shipped regression suite.
 *
 * Selection, view, pan mode, the snap-to-grid flag, file status and errors are
 * editor state, NOT document history: they never record and never flip `dirty`.
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
  WIREFRAME_APP_TAG,
  WIREFRAME_GROUP_MIN_MEMBERS,
  WIREFRAME_SCHEMA_VERSION,
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
  WIREFRAME_ELEMENT_LABELS,
  createElementId,
  duplicateWireframeElement,
  type WireframeElement,
  type WireframeElementPatch,
} from '../model/elements';
import {
  applyDocumentDelta,
  diffDocument,
  type WireframeDocumentDelta,
} from '../model/documentDelta';
import {
  WIREFRAME_HISTORY_LIMIT,
  createWireframeHistory,
  type WireframeHistory,
} from './wireframeHistory';
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

/** Bounded history depth — the ONE source (`wireframeHistory.ts`). */
export const UNDO_DEPTH = WIREFRAME_HISTORY_LIMIT;

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
  /**
   * History-backed flags (Spec #3151). They are NOT stored independently: the
   * snapshot derives them from the module-scoped `WireframeHistory` on every
   * rebuild, so clearing the history always clears them and no second stack can
   * disagree.
   */
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

/**
 * The document write the apply seam performs (Spec #3151, AC4; scoped by
 * Spec #3120 round 2 / AC6).
 *
 * It is one of two shapes: the whole-document checkpoint
 * (`{document, selection?}` — used by New, which is deliberately NOT undoable)
 * or a FIELD-SCOPED delta (`{delta, selection?}`) that is applied to the
 * CURRENT document and recorded as ONE history entry. A missing `selection`
 * keeps (and re-normalises) the live selection.
 */
export interface WireframeDocumentCheckpointPatch {
  readonly document: WireframeDocument;
  readonly selection?: readonly string[];
  /** Optional attribution for the recorded entry (defaults are derived). */
  readonly verbId?: string;
  readonly label?: string;
}

export interface WireframeDocumentDeltaPatch {
  readonly delta: WireframeDocumentDelta;
  readonly selection?: readonly string[];
  /** Optional attribution for the recorded entry (defaults are derived). */
  readonly verbId?: string;
  readonly label?: string;
}

export type WireframeDocumentPatch =
  | WireframeDocumentCheckpointPatch
  | WireframeDocumentDeltaPatch;

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

/**
 * The ONE module-scoped app-local history (Spec #3151, ST-3). Created once and
 * never replaced: the store shims and the tests all read the SAME instance, so
 * there is exactly one undo stack. New/Open and the test reset clear it IN PLACE
 * (never re-create it) so a held reference stays valid.
 */
const history: WireframeHistory = createWireframeHistory(WIREFRAME_HISTORY_LIMIT);

/** The default place path until the shell registers its read model. */
const DEFAULT_CONTEXT_PLACE = 'wireframe.canvas';

/**
 * The shell's read-model registration seam. It supplies the host-owned
 * `appId`/`placePath`; the store always owns `selection` and `dirty`. The store
 * never imports the host.
 *
 * Structural copies of the retired engine's `ContextSnapshot` /
 * `SelectionSnapshot` — re-declared here so the surviving store keeps no engine
 * import (`shared/navigation` is deleted in ST-6).
 */
export interface WireframeSelectionSnapshot {
  readonly count: number;
  readonly kinds: readonly string[];
  readonly label: string | null;
  readonly ids: readonly string[];
}

export interface WireframeContextSnapshot {
  readonly appId: string;
  readonly placePath: readonly string[];
  readonly selection: WireframeSelectionSnapshot;
  readonly dirty: boolean;
}

let contextProvider: (() => WireframeContextSnapshot) | null = null;

let state: WireframeEditorState = createInitialState();
/**
 * The history revision the cached `snapshot` was built at. The history bumps its
 * revision on every push/undo/redo/clear, so this is a cheap O(1) change token —
 * a path that records an entry WITHOUT notifying the store (the surface verbs
 * apply the patch first, then push) is still observed by the next `getSnapshot()`.
 */
let snapshotRevision = history.revision();
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
  snapshotRevision = history.revision();
  return {
    ...next,
    canUndo: history.canUndo(),
    canRedo: history.canRedo(),
    selectedId: primarySelectedId(next),
  };
}

/* ------------------------------------------------------------------------- */
/* App-local history (the ONLY undo authority — Spec #3151, AC4)              */
/* ------------------------------------------------------------------------- */

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
 * `groups` MUST be part of the comparison (Spec #3071): `reduceDocument`
 * returns `null` for a value-equal candidate, so a groups-only mutation (e.g.
 * group-lock) would otherwise commit nothing — no history entry, no `dirty`,
 * no notify.
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

/* ------------------------------------------------------------------------- */
/* Pure document reduction (the plan every mutation shares)                     */
/* ------------------------------------------------------------------------- */

/** A computed document change: the next document and its reconciled selection. */
export interface WireframeDocumentPlan {
  readonly document: WireframeDocument;
  readonly selectedIds: readonly string[];
}

/**
 * The PURE plan for one document mutation (Spec #3119, R-5/R-6). It reads the
 * current state, applies exactly one mutation rule and returns the next
 * document + selection — or `null` for an unknown action, a missing target or a
 * value-equal candidate (a true no-op: no journal entry, no `dirty` flip, no
 * notify — E-15 / R-2.9).
 *
 * It never touches module state, the history or listeners: the surface verbs
 * build their `VerbEffect` from this plan, `dispatch` commits it, and the host
 * applies the effect through `applyDocumentPatch`.
 */
export function reduceDocument(
  current: WireframeEditorState,
  action: WireframeStoreAction,
  args: WireframeStoreActionArgs = {},
): WireframeDocumentPlan | null {
  const { document } = current;
  let plan: { document: WireframeDocument; selectedIds: readonly string[] } | null = null;

  switch (action) {
    case 'element.add': {
      if (!args.element) return null;
      plan = {
        document: { ...document, elements: [...document.elements, args.element] },
        selectedIds: [args.element.id],
      };
      break;
    }

    case 'element.update': {
      if (!args.id || !args.patch) return null;
      if (!document.elements.some((element) => element.id === args.id)) return null;
      plan = {
        document: updateElement(document, args.id, args.patch),
        selectedIds: current.selectedIds,
      };
      break;
    }

    case 'elements.update': {
      if (!args.patches) return null;
      const patches = args.patches;
      let changed = false;
      const elements = document.elements.map((element) => {
        const patch = patches[element.id];
        if (!patch) return element;
        changed = true;
        return { ...element, ...patch } as WireframeElement;
      });
      if (!changed) return null;
      plan = { document: { ...document, elements }, selectedIds: current.selectedIds };
      break;
    }

    case 'element.duplicate': {
      if (!args.id) return null;
      const index = document.elements.findIndex((element) => element.id === args.id);
      if (index === -1) return null;
      const copy = duplicateWireframeElement(document.elements[index], document.page);
      const elements = [...document.elements];
      elements.splice(index + 1, 0, copy);
      plan = { document: { ...document, elements }, selectedIds: [copy.id] };
      break;
    }

    case 'element.delete': {
      if (!args.id) return null;
      if (!document.elements.some((element) => element.id === args.id)) return null;
      const elements = document.elements.filter((element) => element.id !== args.id);
      plan = {
        document: reconcileDocumentGroups({ ...document, elements }),
        selectedIds: current.selectedIds,
      };
      break;
    }

    case 'elements.delete': {
      const ids = args.ids ?? [];
      if (ids.length === 0) return null;
      const remove = new Set(ids);
      const elements = document.elements.filter((element) => !remove.has(element.id));
      if (elements.length === document.elements.length) return null;
      plan = {
        document: reconcileDocumentGroups({ ...document, elements }),
        selectedIds: current.selectedIds.filter((id) => !remove.has(id)),
      };
      break;
    }

    case 'element.toggleLock': {
      const ids = args.ids ?? (args.id ? [args.id] : []);
      if (ids.length === 0) return null;
      if (!document.elements.some((element) => ids.includes(element.id))) return null;
      plan = {
        document: toggleElementsLocked(document, ids),
        selectedIds: current.selectedIds,
      };
      break;
    }

    case 'element.reorder': {
      const ids = args.ids ?? [];
      if (!args.direction || ids.length === 0) return null;
      const { elements, moved } = reorderElements(document.elements, ids, args.direction);
      if (!moved) return null;
      plan = { document: { ...document, elements }, selectedIds: current.selectedIds };
      break;
    }

    case 'group.create': {
      const ids = args.ids ?? [];
      // R-2.7: fewer than two elements is not a group; R-1.9: a selection that
      // is exactly one whole group is a no-op.
      if (ids.length < 2) return null;
      if (isWholeGroupSelection(document, ids)) return null;
      const members = documentOrder(ids, document);
      if (members.length < 2) return null;
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
      plan = {
        document: reconcileDocumentGroups({ ...document, groups: [...pruned, group] }),
        selectedIds: members,
      };
      break;
    }

    case 'group.ungroup': {
      const groupIds = args.groupIds ?? [];
      if (groupIds.length === 0) return null;
      const remove = new Set(groupIds);
      if (!document.groups.some((group) => remove.has(group.id))) return null;
      // Ungroup is neither a move nor a resize, so a locked group still
      // ungroups (R-1.10). Members keep their geometry and stacking order.
      const groups = document.groups.filter((group) => !remove.has(group.id));
      plan = { document: { ...document, groups }, selectedIds: current.selectedIds };
      break;
    }

    case 'group.toggleLock': {
      const groupIds = args.groupIds ?? [];
      if (groupIds.length === 0) return null;
      const targets = new Set(groupIds);
      if (!document.groups.some((group) => targets.has(group.id))) return null;
      const groups = document.groups.map((group) =>
        targets.has(group.id) ? { ...group, locked: !group.locked } : group,
      );
      plan = { document: { ...document, groups }, selectedIds: current.selectedIds };
      break;
    }

    case 'page.update': {
      if (!args.page) return null;
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

      plan = {
        document: { ...document, page: { preset, width, height } },
        selectedIds: current.selectedIds,
      };
      break;
    }

    default:
      return null;
  }

  if (plan === null) return null;
  // Value-equal candidates are true no-ops (E-15 / R-2.9).
  if (documentsEqual(document, plan.document)) return null;
  return {
    document: plan.document,
    selectedIds: documentOrder(plan.selectedIds, plan.document),
  };
}

/* ------------------------------------------------------------------------- */
/* History labels (the store's compatibility funnel)                           */
/* ------------------------------------------------------------------------- */

function documentTitle(element: WireframeElement): string {
  switch (element.type) {
    case 'text':
      return element.textStyle === 'heading' ? 'Heading' : 'Text';
    case 'section':
      return element.preset;
    case 'shape':
      return element.shape;
    default:
      return WIREFRAME_ELEMENT_LABELS[element.type];
  }
}

function labelForAction(
  action: WireframeStoreAction,
  args: WireframeStoreActionArgs,
  document: WireframeDocument,
): string {
  const byId = new Map(document.elements.map((element) => [element.id, element]));
  const titleOf = (id?: string): string => {
    const element = id === undefined ? undefined : byId.get(id);
    return element === undefined ? 'Element' : documentTitle(element);
  };
  switch (action) {
    case 'element.add':
      return args.element === undefined ? 'Add element' : `Add ${documentTitle(args.element)}`;
    case 'element.update':
      return `Update ${titleOf(args.id)}`;
    case 'element.duplicate':
      return `Duplicate ${titleOf(args.id)}`;
    case 'element.delete':
      return `Delete ${titleOf(args.id)}`;
    case 'element.toggleLock':
      return 'Toggle lock';
    case 'elements.update':
      return 'Update elements';
    case 'elements.delete':
      return 'Delete elements';
    case 'element.reorder':
      return args.direction === 'forward' ? 'Bring forward' : 'Send backward';
    case 'group.create':
      return 'Group';
    case 'group.ungroup':
      return 'Ungroup';
    case 'group.toggleLock':
      return 'Toggle group lock';
    case 'page.update':
      return 'Update page';
    default:
      return action;
  }
}

/**
 * Commit a pure plan as exactly ONE history entry + ONE state update (the
 * compatibility funnel behind `dispatch`). The entry is recorded BEFORE the
 * snapshot rebuild so `canUndo`/`canRedo` read the new history.
 */
function commitPlan(
  action: WireframeStoreAction,
  args: WireframeStoreActionArgs,
  plan: WireframeDocumentPlan,
): void {
  const before = state.document;
  // Spec #3120 round 2 (ST-4-REWORK / AC6) — the legacy funnel is field-scoped too, so
  // one entry's before-delta can never clobber a later independent human edit.
  const { patch: forward, inverse } = diffDocument(before, plan.document);
  history.push({
    verbId: action,
    label: labelForAction(action, args, before),
    before: inverse,
    after: { ...forward, selection: [...plan.selectedIds] },
  });
  setState({
    ...state,
    document: plan.document,
    selectedIds: [...plan.selectedIds],
    dirty: true,
  });
  notify();
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
 *
 * `canUndo`/`canRedo` are derived from the app-local history on every read
 * (Spec #3151, AC4). The surface verbs apply the document patch BEFORE they
 * record the entry, so a value captured at notify time is one push stale;
 * refreshing the two flags here keeps them truthful after a VERB commit too,
 * while still returning the SAME object when they did not move (the
 * `useSyncExternalStore` stability contract).
 */
export function getSnapshot(): WireframeEditorSnapshot {
  // O(1) revision check (the history bumps its revision on every change).
  if (snapshotRevision !== history.revision()) {
    snapshot = createSnapshot(state);
  }
  return snapshot;
}

/* ------------------------------------------------------------------------- */
/* Context seam                                                                */
/* ------------------------------------------------------------------------- */

/**
 * The ONE module-scoped app-local history (Spec #3151, AC4). Exposed for
 * diagnostics, the shell's own controls (ST-5) and the store's tests — there is
 * no second undo container to read.
 */
export function getWireframeHistory(): WireframeHistory {
  return history;
}

/**
 * Register the shell's read model. The provider supplies the host-owned
 * `appId`/`placePath`; the store always overrides `selection` and `dirty` with
 * its live values. Registration seam only — the store never imports the host.
 */
export function setWireframeContextProvider(fn: () => WireframeContextSnapshot): void {
  contextProvider = fn;
}

/**
 * The context snapshot the shell reads. `selection.kinds` is the primary
 * element's TYPE first (`text|button|shape|…`), so the kind gates in
 * `available(ctx)` work. `ids` stays in document order and `label` is the
 * primary element's title.
 */
export function getWireframeContext(): WireframeContextSnapshot {
  const base = contextProvider === null ? null : contextProvider();
  return {
    appId: base?.appId ?? WIREFRAME_APP_TAG,
    placePath: base?.placePath ?? [DEFAULT_CONTEXT_PLACE],
    selection: publishSelection(state),
    dirty: state.dirty,
  };
}

function publishSelection(current: WireframeEditorState): WireframeSelectionSnapshot {
  const byId = new Map(current.document.elements.map((element) => [element.id, element]));
  const selected = current.selectedIds
    .map((id) => byId.get(id))
    .filter((element): element is WireframeElement => element !== undefined);
  const primary = selected.length > 0 ? selected[selected.length - 1] : null;
  const ordered = primary === null ? selected : [primary, ...selected.slice(0, -1)];
  return {
    count: current.selectedIds.length,
    ids: [...current.selectedIds],
    kinds: ordered.map((element) => element.type),
    label: primary === null ? null : documentTitle(primary),
  };
}

/* ------------------------------------------------------------------------- */
/* Patch application (the host's `applyPatch` target)                          */
/* ------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate a document checkpoint structurally. Total: an invalid value returns
 * `null` (never throws), so a stale/bad patch is a safe no-op.
 */
function asWireframeDocument(value: unknown): WireframeDocument | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== WIREFRAME_SCHEMA_VERSION) return null;
  if (value.app !== WIREFRAME_APP_TAG) return null;
  if (!isRecord(value.page)) return null;
  const page = value.page;
  if (
    typeof page.width !== 'number' ||
    !Number.isFinite(page.width) ||
    typeof page.height !== 'number' ||
    !Number.isFinite(page.height) ||
    (page.preset !== 'desktop' &&
      page.preset !== 'tablet' &&
      page.preset !== 'phone' &&
      page.preset !== 'custom')
  ) {
    return null;
  }
  if (!Array.isArray(value.elements)) return null;
  for (const element of value.elements) {
    if (!isRecord(element) || typeof element.id !== 'string') return null;
  }
  if (!Array.isArray(value.groups)) return null;
  for (const group of value.groups) {
    if (
      !isRecord(group) ||
      typeof group.id !== 'string' ||
      !Array.isArray(group.memberIds) ||
      !group.memberIds.every((memberId) => typeof memberId === 'string') ||
      typeof group.locked !== 'boolean'
    ) {
      return null;
    }
  }
  return value as unknown as WireframeDocument;
}

/**
 * Apply the document write + reconcile the selection (Spec #3151, AC4). A delta
 * applies against the CURRENT document and records exactly ONE app-local
 * history entry (with the field-scoped inverse as `before`); a whole-document
 * checkpoint is a non-undoable reset (New), so it records nothing. The
 * selection re-normalises through `documentOrder`, so ids the new document no
 * longer holds are dropped.
 */
export function applyDocumentPatch(patch: WireframeDocumentPatch): void {
  if (!writeDocumentPatch(patch, true)) return;
  notify();
}

/**
 * Apply a patch to state WITHOUT notifying — used by undo/redo for one notify.
 *
 * `record` distinguishes a caller-visible edit (`true`: push the app-local
 * history entry) from the history's OWN application of `before`/`after`
 * (`false`: never re-record, or undo would push a second entry forever).
 */
function writeDocumentPatch(patch: WireframeDocumentPatch, record: boolean): boolean {
  const document =
    'delta' in patch
      ? applyDocumentDelta(state.document, patch.delta)
      : asWireframeDocument(patch.document);
  if (document === null) return false;
  const selection =
    patch.selection ?? ('delta' in patch ? patch.delta.selection : undefined) ?? state.selectedIds;
  const selectedIds = documentOrder(selection, document);
  if (record && 'delta' in patch) {
    // ONE entry per document write: `before` is the field-scoped inverse of the
    // write that is about to land, `after` re-applies the caller's delta (with
    // the reconciled selection so a redo restores the post-commit selection).
    const { inverse } = diffDocument(state.document, document);
    history.push({
      verbId: patch.verbId ?? 'document.apply',
      label: patch.label ?? 'Edit',
      before: inverse,
      after: { ...patch.delta, selection: [...selectedIds] },
    });
  }
  setState({
    ...state,
    document,
    selectedIds,
    dirty: true,
  });
  return true;
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
 * Apply one document mutation through the compatibility funnel (Spec #3151,
 * ST-3). Unknown actions and missing targets are safe no-ops. Returns `true`
 * when exactly one history entry was recorded (R-2.7 / R-2.9).
 *
 * The surface verbs call `reduceDocument` directly and let the write seam own
 * their history entry; this function is the shipped-regression-suite seam and
 * records through the SAME app-local history, so `dispatch(...)` then `undo()`
 * works without a second stack.
 */
export function dispatch(
  action: WireframeStoreAction,
  args: WireframeStoreActionArgs = {},
): boolean {
  const plan = reduceDocument(state, action, args);
  if (plan === null) return false;
  commitPlan(action, args, plan);
  return true;
}

/**
 * Reverse the newest not-yet-undone mutation through the app-local history
 * (Spec #3151, AC4). Applies the entry's `before` delta through the SAME write
 * seam the host uses; a stale/inapplicable delta steps the cursor back (so the
 * entry is not silently lost) and is a safe no-op.
 */
export function undo(): void {
  const entry = history.undo();
  if (entry === null) return;
  if (!writeDocumentPatch({ delta: entry.before }, false)) {
    // Not applicable against the CURRENT document — restore the cursor so the
    // entry stays undoable (the shipped no-op semantics).
    history.redo();
    return;
  }
  notify();
}

/**
 * Re-apply the oldest undone mutation (one step at a time) through the
 * app-local history. The `after` delta carries the post-commit selection, so a
 * redo restores the selection the edit installed.
 */
export function redo(): void {
  const entry = history.redo();
  if (entry === null) return;
  if (!writeDocumentPatch({ delta: entry.after }, false)) {
    history.undo();
    return;
  }
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
  // History reset is NON-UNDOABLE: clear the ONE app-local history in place.
  history.clear();
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
  // History reset is NON-UNDOABLE: clear the ONE app-local history in place.
  history.clear();
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

/** Test-only: wipe module state, the ONE history, stage, provider and listeners. */
export function resetWireframeStoreForTests(): void {
  listeners = new Set<Listener>();
  canvasStage = null;
  contextProvider = null;
  history.clear();
  state = createInitialState();
  snapshot = createSnapshot(state);
}

/** Test-only: a fresh element id (re-export keeps ST imports in one place). */
export { createElementId };
