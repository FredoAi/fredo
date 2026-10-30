/**
 * Wireframe document store (Spec #3070, ST-1, C3; extended by Spec #3071, ST-1;
 * journal seam added by Spec #3119, ST-2).
 *
 * MODULE-SCOPED — never React refs. Open -> close -> open keeps the document,
 * the undo history and the saved path because they live at module scope (the
 * AGENTS.md persistence rule; shipped precedent: `windowStore.ts`).
 *
 * THE JOURNAL IS THE ONE UNDO AUTHORITY (Spec #3119, R-5). Every document
 * mutation commits exactly ONE entry to the module-scoped `JournalStore`; the
 * public `undo()`/`redo()`/`canUndo`/`canRedo` are journal-backed shims derived
 * from that SAME store, so there is no second history container. `dispatch` is
 * the compatibility funnel for the shipped regression suite; the P5 surface
 * verbs call the PURE `reduceDocument` plan and commit through
 * `applyDocumentPatch` (the host owns their journal entry).
 *
 * Selection, view, pan mode, the snap-to-grid flag, file status and errors are
 * editor state, NOT document history: they never journal and never flip `dirty`.
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
  appendEntry,
  createJournalStore,
  type JournalEntryDraft,
  type JournalStore,
} from '../../../shared/navigation/journal';
import type {
  ContextSnapshot,
  JournalEntry,
  JsonPatch,
  ObjectRef,
  SelectionSnapshot,
} from '../../../shared/navigation/types';
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
  /**
   * Journal-backed flags (Spec #3119). They are NOT stored independently: the
   * snapshot derives them from the module-scoped `JournalStore` on every rebuild
   * (`computeCanUndo` / `computeCanRedo`), so clearing the journal always clears
   * them and no second stack can disagree.
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
 * The whole-document patch the navigation funnel applies (Spec #3119, R-5/R-6).
 *
 * It is the JSON form of a verb effect's `after`/`inverse` checkpoint: the
 * document to install plus the selection the committing verb produced. A missing
 * `selection` keeps (and re-normalises) the live selection — the shape the
 * `inverse` checkpoint uses.
 */
export interface WireframeDocumentPatch {
  readonly document: WireframeDocument;
  readonly selection?: readonly string[];
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

/**
 * The ONE module-scoped navigation journal (Spec #3119, ST-2). Created once and
 * never replaced: the host, the store shims and the tests all read the SAME
 * instance, so there is exactly one undo stack. New/Open and the test reset
 * clear it IN PLACE (never re-create it) so a held reference stays valid.
 */
const navigationJournal: JournalStore = createJournalStore();

/** The default place path until the shell registers its read model. */
const DEFAULT_CONTEXT_PLACE = 'wireframe.canvas';

/**
 * The shell's read-model registration seam. It supplies the host-owned
 * `appId`/`placePath`; the store always owns `selection` and `dirty`. The store
 * never imports the host (Spec #3119, ST-2).
 */
let contextProvider: (() => ContextSnapshot) | null = null;

let state: WireframeEditorState = createInitialState();
/**
 * The journal arrays captured when `snapshot` was last built. The journal
 * replaces BOTH arrays on every commit, so identity is a cheap revision token:
 * a path that appends a journal entry WITHOUT notifying the store (the
 * navigation funnel applies the patch first, then journals) is still observed
 * by the next `getSnapshot()`.
 */
let snapshotJournalEntries: readonly JournalEntry[] = navigationJournal.entries();
let snapshotJournalRedo: readonly number[] = navigationJournal.redo();
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
  snapshotJournalEntries = navigationJournal.entries();
  snapshotJournalRedo = navigationJournal.redo();
  return {
    ...next,
    canUndo: computeCanUndo(),
    canRedo: computeCanRedo(),
    selectedId: primarySelectedId(next),
  };
}

/* ------------------------------------------------------------------------- */
/* Journal-backed history (the ONLY undo authority — Spec #3119, R-5)          */
/* ------------------------------------------------------------------------- */

function journalNow(): string {
  return new Date().toISOString();
}

function isRedoSeq(seq: number): boolean {
  return navigationJournal.redo().includes(seq);
}

/**
 * The newest USER mutation that has not been undone yet. System entries are
 * skipped (an undo of an undo is redo, never a second undo), and a seq already
 * on the redo stack is skipped so repeated undo walks back one step at a time.
 */
function newestUndoableEntry(): JournalEntry | null {
  const entries = navigationJournal.entries();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.inverse === null) continue;
    if (entry.actor === 'system') continue;
    if (isRedoSeq(entry.seq)) continue;
    return entry;
  }
  return null;
}

function computeCanUndo(): boolean {
  return newestUndoableEntry() !== null;
}

function computeCanRedo(): boolean {
  const entries = navigationJournal.entries();
  if (entries.length === 0) return false;
  const bySeq = new Set(entries.map((entry) => entry.seq));
  return navigationJournal.redo().some((seq) => bySeq.has(seq));
}

/** Rebuild the cached snapshot so `canUndo`/`canRedo` read the latest journal. */
function refreshSnapshot(): void {
  snapshot = createSnapshot(state);
}

/** Append one draft to the module-scoped journal (append-only; never mutates). */
function appendJournalEntry(draft: JournalEntryDraft): JournalEntry {
  const outcome = appendEntry(
    { entries: navigationJournal.entries(), redo: navigationJournal.redo() },
    draft,
    journalNow(),
  );
  navigationJournal.commit(outcome.state.entries, outcome.state.redo);
  return outcome.entry;
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
 * `groups` MUST be part of the comparison (Spec #3071): `reduceDocument`
 * returns `null` for a value-equal candidate, so a groups-only mutation (e.g.
 * group-lock) would otherwise commit nothing — no journal entry, no `dirty`,
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
 * It never touches module state, the journal or listeners: the surface verbs
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
/* Journal checkpoints + labels (the store's compatibility funnel)             */
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

function elementRef(element: WireframeElement): ObjectRef {
  return { type: element.type, id: element.id, label: documentTitle(element) };
}

/** Serialise a document (and optional selection) as a journal checkpoint patch. */
function documentCheckpoint(
  document: WireframeDocument,
  selection?: readonly string[],
): JsonPatch {
  // The checkpoint is plain JSON; `JsonPatch` has no structural index signature,
  // so the cast is the documented boundary between the app model and the engine.
  return (
    selection === undefined ? { document } : { document, selection: [...selection] }
  ) as unknown as JsonPatch;
}

/** Element/group refs for the trail — resolved against the pre-mutation document. */
function targetsForAction(
  action: WireframeStoreAction,
  args: WireframeStoreActionArgs,
  document: WireframeDocument,
  next: WireframeDocument,
): ObjectRef[] {
  const groups = args.groupIds ?? [];
  if (groups.length > 0) {
    return groups.map((id) => ({ type: 'group', id, label: 'Group' }));
  }
  if (action === 'element.add') {
    return args.element ? [elementRef(args.element)] : [];
  }
  if (action === 'page.update') {
    return [{ type: 'page', id: 'page', label: 'Page' }];
  }
  const before = new Map(document.elements.map((element) => [element.id, element]));
  const after = new Map(next.elements.map((element) => [element.id, element]));
  const ids = args.ids ?? (args.id ? [args.id] : []);
  return ids
    .map((id) => before.get(id) ?? after.get(id))
    .filter((element): element is WireframeElement => element !== undefined)
    .map(elementRef);
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
 * Commit a pure plan as exactly ONE journal entry + ONE state update (the
 * compatibility funnel behind `dispatch`). The journal append happens BEFORE
 * the snapshot rebuild so `canUndo`/`canRedo` read the new history.
 */
function commitPlan(
  action: WireframeStoreAction,
  args: WireframeStoreActionArgs,
  plan: WireframeDocumentPlan,
): void {
  const before = state.document;
  const beforeSelection = [...state.selectedIds];
  appendJournalEntry({
    verbId: action,
    actor: 'human',
    channel: 'system',
    label: labelForAction(action, args, before),
    effect: 'mutation',
    placePath: getWireframeContext().placePath,
    target: targetsForAction(action, args, before, plan.document),
    patch: {
      before: documentCheckpoint(before, beforeSelection),
      after: documentCheckpoint(plan.document, plan.selectedIds),
    },
    inverse: documentCheckpoint(before),
    external: false,
    consequence: null,
    exitedBy: 'none',
    coalesceKey: null,
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
 * `canUndo`/`canRedo` are derived from the shared journal on every read (Spec
 * #3119, R-5a). The navigation funnel applies the document patch BEFORE it
 * appends the entry, so a value captured at notify time is one append stale;
 * refreshing the two flags here keeps them truthful after a VERB commit too,
 * while still returning the SAME object when they did not move (the
 * `useSyncExternalStore` stability contract).
 */
export function getSnapshot(): WireframeEditorSnapshot {
  // O(1) revision check (the journal replaces its arrays on commit); only a real
  // journal change re-derives the flags.
  if (
    snapshotJournalEntries !== navigationJournal.entries() ||
    snapshotJournalRedo !== navigationJournal.redo()
  ) {
    snapshot = createSnapshot(state);
  }
  return snapshot;
}

/* ------------------------------------------------------------------------- */
/* Navigation seam (Spec #3119, ST-2)                                          */
/* ------------------------------------------------------------------------- */

/**
 * The ONE module-scoped journal. The P5 host is constructed with THIS instance
 * and `applyDocumentPatch` as its `applyPatch`, so `store.undo()` and
 * `host.undoLast()` advance the same stack (no second counter).
 */
export function getNavigationJournal(): JournalStore {
  return navigationJournal;
}

/**
 * Register the shell's read model. The provider supplies the host-owned
 * `appId`/`placePath`; the store always overrides `selection` and `dirty` with
 * its live values. Registration seam only — the store never imports the host.
 */
export function setWireframeContextProvider(fn: () => ContextSnapshot): void {
  contextProvider = fn;
}

/**
 * The `ContextSnapshot` the P5 host reads (Spec #3119, R-4). `selection.kinds`
 * is the primary element's TYPE first (`text|button|shape|…`), never an
 * `ObjectRef` noun, so the kind gates in `available(ctx)` work. `ids` stays in
 * document order and `label` is the primary element's title.
 */
export function getWireframeContext(): ContextSnapshot {
  const base = contextProvider === null ? null : contextProvider();
  return {
    appId: base?.appId ?? WIREFRAME_APP_TAG,
    placePath: base?.placePath ?? [DEFAULT_CONTEXT_PLACE],
    selection: publishSelection(state),
    dirty: state.dirty,
  };
}

function publishSelection(current: WireframeEditorState): SelectionSnapshot {
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

/** Decode a journal checkpoint patch into the app patch shape (or `null`). */
function asDocumentPatch(patch: JsonPatch | null): WireframeDocumentPatch | null {
  if (patch === null || !isRecord(patch)) return null;
  const document = asWireframeDocument(patch.document);
  if (document === null) return null;
  const selection = patch.selection;
  if (selection === undefined) return { document };
  if (!Array.isArray(selection) || !selection.every((id) => typeof id === 'string')) {
    return null;
  }
  return { document, selection: selection as string[] };
}

/**
 * Replace the document + reconcile the selection (Spec #3119, R-5/R-6). The
 * selection re-normalises through `documentOrder`, so ids that the new document
 * no longer contains are dropped. This is the ONLY document write the host
 * performs — it never journaled and never throws (an invalid patch is a no-op).
 */
export function applyDocumentPatch(patch: WireframeDocumentPatch): void {
  if (!writeDocumentPatch(patch)) return;
  notify();
}

/** Apply a patch to state WITHOUT notifying (used by undo/redo for one notify). */
function writeDocumentPatch(patch: WireframeDocumentPatch): boolean {
  const document = asWireframeDocument(patch?.document);
  if (document === null) return false;
  const selection = patch.selection ?? state.selectedIds;
  setState({
    ...state,
    document,
    selectedIds: documentOrder(selection, document),
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
 * Apply one document mutation through the compatibility funnel (Spec #3119,
 * ST-2). Unknown actions and missing targets are safe no-ops. Returns `true`
 * when exactly one journal entry was committed (R-2.7 / R-2.9).
 *
 * The surface verbs (ST-3) call `reduceDocument` directly and let the navigation
 * funnel own their journal entry; this function is the shipped-regression-suite
 * seam and commits through the SAME journal, so `dispatch(...)` then `undo()`
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
 * Reverse the newest not-yet-undone USER mutation through the shared journal
 * (Spec #3119, R-5). Applies the entry's inverse, appends exactly ONE `system`
 * entry (`Undo <label>`, deliberately non-undoable so it is never re-targeted)
 * and records the undone `seq` on the redo stack. The document + selection are
 * re-synced through the same patch seam the host uses.
 */
export function undo(): void {
  const target = newestUndoableEntry();
  if (target === null) return;
  const inverse = asDocumentPatch(target.inverse);
  if (inverse === null) return;
  if (!writeDocumentPatch(inverse)) return;

  // `before` = the state the entry installed; `after` = the restored state.
  const beforeUndo: JsonPatch =
    target.patch !== null ? target.patch.after : (target.inverse as JsonPatch);
  const outcome = appendEntry(
    { entries: navigationJournal.entries(), redo: navigationJournal.redo() },
    {
      verbId: target.verbId,
      actor: 'system',
      channel: 'system',
      label: `Undo ${target.label}`,
      effect: 'mutation',
      placePath: getWireframeContext().placePath,
      target: target.target,
      patch: { before: beforeUndo, after: target.inverse as JsonPatch },
      // A system undo entry is NOT undoable: `redo` restores the mutation, so an
      // undo-of-undo must never become a second stack edge.
      inverse: null,
      consequence: 'An undone action is restored with redo.',
      external: false,
      exitedBy: 'none',
      coalesceKey: null,
    },
    journalNow(),
  );
  navigationJournal.commit(outcome.state.entries, [
    target.seq,
    ...navigationJournal.redo().filter((seq) => seq !== target.seq),
  ]);
  refreshSnapshot();
  notify();
}

/**
 * Re-apply the OLDEST undone mutation (one step at a time) and drop its `seq`
 * from the redo stack. The redo stack is ascending, so the smallest seq is the
 * next chronological step — the retired LIFO redo ordering.
 */
export function redo(): void {
  const redoSeqs = navigationJournal.redo();
  if (redoSeqs.length === 0) return;
  const seq = [...redoSeqs].sort((left, right) => left - right)[0];
  const entries = navigationJournal.entries();
  const target = entries.find((entry) => entry.seq === seq);

  // A stale redo seq (its entry vanished) is dropped without touching state.
  if (target === undefined || target.patch === null) {
    navigationJournal.commit(
      entries,
      redoSeqs.filter((candidate) => candidate !== seq),
    );
    refreshSnapshot();
    notify();
    return;
  }

  const after = asDocumentPatch(target.patch.after);
  if (after === null) return;
  if (!writeDocumentPatch(after)) return;
  navigationJournal.commit(
    entries,
    redoSeqs.filter((candidate) => candidate !== seq),
  );
  refreshSnapshot();
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
  // History reset is NON-UNDOABLE: clear the ONE journal in place.
  navigationJournal.commit([], []);
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
  // History reset is NON-UNDOABLE: clear the ONE journal in place.
  navigationJournal.commit([], []);
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

/** Test-only: wipe module state, the ONE journal, stage, provider and listeners. */
export function resetWireframeStoreForTests(): void {
  listeners = new Set<Listener>();
  canvasStage = null;
  contextProvider = null;
  navigationJournal.commit([], []);
  state = createInitialState();
  snapshot = createSnapshot(state);
}

/** Test-only: a fresh element id (re-export keeps ST imports in one place). */
export { createElementId };
