/**
 * Spec #3119 (P5), ST-3 — the ONE Wireframe surface declaration.
 *
 * Wireframe becomes an ordinary NavigationEngine consumer: places, keys and the 55
 * verbs are data here, not a Wireframe-specific runtime. The shell (ST-4) mounts the
 * P4 `CommandRail` / `NavigationMap` / `ActivityTrail` over this declaration, the
 * pointer gestures (ST-5) and the details view (ST-6) dispatch the SAME verb ids, and
 * the legacy command surface / hotkey carrier are deleted in ST-4.
 *
 * EXECUTION SEAM (the whole point of ST-2):
 *   A verb NEVER calls the store's `dispatch(action, args)` — that funnel journals its
 *   own entry, and the navigation funnel would journal a second one for the same edit.
 *   Instead every document verb builds ONE `VerbEffect` through the PURE
 *   `reduceDocument(state, action, args)` plan (`mutate` below); the engine applies the
 *   `patch.after` through `applyDocumentPatch` and writes the ONE journal entry.
 *
 * EDITOR-STATE verbs (zoom / fit / pan / snap / selection / place entry) return a
 * `navigation` effect: attributed, non-undoable, never a document patch. Arming a
 * create verb (`wireframe.create.rect` / `.ellipse` with no bounds) returns a
 * `patch:null` mutation — a `noop` with no journal entry that leaves the transient
 * place in place until the pointer commit lands.
 *
 * `wireframe.element.rename` has no document field to write, so it is a NAVIGATION
 * effect that publishes a rename request (element id + which name field to focus); the
 * details view consumes it. It never fabricates a name.
 *
 * `WIREFRAME_ACTIONS` survives as the retained handler/parity registry (its legacy `hotkey`
 * field was removed in ST-4); this module reuses its file-action handler seam for the four
 * non-undoable file verbs.
 *
 * PURE DATA + SYNCHRONOUS RUNS: no polling, no timers, no IPC. The only module state is
 * the armed create kind, the rename request and their listeners (session-scoped, never
 * persisted).
 */

import type {
  ContextSnapshot,
  Intent,
  JournalEntry,
  JsonPatch,
  KeyBinding,
  ObjectRef,
  PlaceNode,
  Risk,
  Surface,
  VerbArg,
  VerbDescriptor,
  VerbEffect,
} from '../../shared/navigation';

import { requestLauncherOpen } from '../../shared/navigation/ui/launcherBridge';
import { runWireframeAction } from './actions/wireframeActions';
import {
  DEFAULT_ICON_ID,
  DEFAULT_SECTION_PRESET,
  DEFAULT_SHAPE_KIND,
  WIREFRAME_COLOR_TOKENS,
  WIREFRAME_ELEMENT_LABELS,
  createDefaultElement,
  createShapeElementAtRect,
  isWireframeColorToken,
  type WireframeBorderWidth,
  type WireframeButtonAppearance,
  type WireframeColorToken,
  type WireframeCreateElementRequest,
  type WireframeElement,
  type WireframeElementPatch,
  type WireframeElementType,
  type WireframeIconId,
  type WireframeRadius,
  type WireframeSectionPreset,
  type WireframeShapeDrawKind,
  type WireframeShapeKind,
  type WireframeTextStyle,
} from './model/elements';
import {
  alignRects,
  canAlign,
  canDistribute,
  distributeRectsHorizontally,
  selectionBounds,
  type WireframeAlignEdge,
} from './model/arrange';
import { ELEMENT_MIN_SIZE, clampRectToPage } from './model/geometry';
import {
  groupOfElement,
  isElementMovable,
  type WireframeDocument,
  type WireframePage,
} from './model/document';
import { diffDocument } from './model/documentDelta';
import type { WireframePagePreset } from './model/pagePresets';
import {
  dispatch,
  getSnapshot,
  primarySelectedId,
  reduceDocument,
  resetForNewDocument,
  select,
  setView,
  toggleSnapToGrid,
  type WireframeStoreAction,
  type WireframeStoreActionArgs,
} from './store/wireframeDocumentStore';
import { fitPage, resetView, togglePan, zoomIn, zoomOut } from './actions/wireframeViewActions';

/* ───────────────────────────── bound names ───────────────────────────── */

/** §1 — the surface app id (`WireframeFeature`'s `id`). */
export const WIREFRAME_SURFACE_APP_ID = 'wireframe';

/** §2.1 — the one root place. */
export const WIREFRAME_ROOT_PLACE_ID = 'wireframe.canvas';

/** §2.1 — the transient create place id. */
export const WIREFRAME_CREATE_PLACE_ID = 'wireframe.create';
export const WIREFRAME_EDIT_PLACE_ID = 'wireframe.edit';
export const WIREFRAME_ARRANGE_PLACE_ID = 'wireframe.arrange';
export const WIREFRAME_STYLE_PLACE_ID = 'wireframe.style';
export const WIREFRAME_VIEW_PLACE_ID = 'wireframe.view';
export const WIREFRAME_FILE_PLACE_ID = 'wireframe.file';

/** Operator / cursor vocabulary the canvas operator reads (opaque to the engine). */
export const WIREFRAME_CREATE_OPERATOR = 'wireframe.create-shape';
export const WIREFRAME_DRAW_CURSOR = 'crosshair';
export const WIREFRAME_PAN_CURSOR = 'grab';

/** §9 — the "just do it" map-click defaults, applied by the shell's `onRunVerb` wrapper. */
export const WIREFRAME_MAP_DEFAULT_ARGS: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  'wireframe.add.icon': { iconId: DEFAULT_ICON_ID },
  'wireframe.add.shape': { shape: DEFAULT_SHAPE_KIND },
  'wireframe.add.section': { preset: DEFAULT_SECTION_PRESET },
};

const APP_MAP_VERB_ID = 'app.map';
const APP_ASK_VERB_ID = 'app.ask';

/* ───────────────────────────── armed create state ───────────────────────────── */

/**
 * Session-scoped armed create kind (§7 flow 2/4). Kept at module scope (never a React
 * ref) so it survives a component remount while the user is mid-gesture; the shell reads
 * it through `getArmedWireframeShape()` to publish `data-wireframe-arm`.
 *
 * A tiny subscriber set lets the shell/canvas re-render when the armed kind flips without
 * subscribing to the journal. It is presentation state only (never persisted).
 */
let armedShape: WireframeShapeDrawKind | null = null;
const armedListeners = new Set<() => void>();

function notifyArmed(): void {
  for (const listener of armedListeners) listener();
}

function setArmed(shape: WireframeShapeDrawKind | null): void {
  if (armedShape === shape) return;
  armedShape = shape;
  notifyArmed();
}

/** Arm the create operator for `shape`; the next pointer commit supplies the bounds. */
export function beginWireframeShapeCreate(shape: WireframeShapeDrawKind): void {
  setArmed(shape);
}

export function getArmedWireframeShape(): WireframeShapeDrawKind | null {
  return armedShape;
}

export function clearArmedWireframeShape(): void {
  setArmed(null);
}

export function setArmedWireframeShape(shape: WireframeShapeDrawKind | null): void {
  setArmed(shape);
}

/** Subscribe to the armed create-kind changes (shell/canvas selector). */
export function subscribeArmedWireframeShape(listener: () => void): () => void {
  armedListeners.add(listener);
  return () => {
    armedListeners.delete(listener);
  };
}

/* ───────────────────────────── rename request seam ───────────────────────────── */

/** The name field each element kind exposes in the details panel (UI/UX §8). */
export type WireframeRenameField = 'text' | 'label' | 'placeholder';

export interface WireframeRenameRequest {
  readonly id: string;
  readonly field: WireframeRenameField;
  /** Monotonic token so the panel re-focuses even for the same element twice. */
  readonly nonce: number;
}

let renameRequest: WireframeRenameRequest | null = null;
let renameNonce = 0;
const renameListeners = new Set<() => void>();

/** The pending request without consuming it (a render-safe read). */
export function peekWireframeRenameRequest(): WireframeRenameRequest | null {
  return renameRequest;
}

/** Consume the pending request (the details view focuses + selects the field). */
export function consumeWireframeRenameRequest(): WireframeRenameRequest | null {
  const request = renameRequest;
  renameRequest = null;
  return request;
}

/** Subscribe to rename-request changes (the details view re-reads on notify). */
export function subscribeWireframeRenameRequest(listener: () => void): () => void {
  renameListeners.add(listener);
  return () => {
    renameListeners.delete(listener);
  };
}

function publishRenameRequest(id: string, field: WireframeRenameField): void {
  renameNonce += 1;
  renameRequest = { id, field, nonce: renameNonce };
  for (const listener of renameListeners) listener();
}

/* ───────────────────────────── legacy helper exports ───────────────────────────── */

/**
 * Create + auto-select one shape from a dragged page-space rect (the legacy helper the
 * canvas imports). Returns `null` below `ELEMENT_MIN_SIZE`. Kept for the P5 migration;
 * pointer gestures go through the DECLARED verb (ST-5), never this helper.
 */
export function createWireframeShapeAt(
  request: WireframeCreateElementRequest,
): string | null {
  const { document } = getSnapshot();
  const element = createShapeElementAtRect({
    shape: request.shape,
    rect: request.rect,
    page: document.page,
  });
  if (element === null) return null;
  dispatch('element.add', { element });
  return element.id;
}

/** Apply a fill token to the PRIMARY (last-selected) shape (legacy helper). */
export function applyWireframeFill(fill: WireframeColorToken): boolean {
  const primary = primaryElement();
  if (primary === null || primary.type !== 'shape') return false;
  return dispatch('elements.update', { patches: { [primary.id]: { fill } } });
}

/* ───────────────────────────── effect builders ───────────────────────────── */

function documentCheckpoint(
  document: WireframeDocument,
  selection?: readonly string[],
): JsonPatch {
  return (
    selection === undefined ? { document } : { document, selection: [...selection] }
  ) as unknown as JsonPatch;
}

/** A `patch:null` mutation — the engine reports `noop` and writes no journal entry. */
function noop(label: string): VerbEffect {
  return { effect: 'mutation', label, patch: null, inverse: null, target: [] };
}

/** An attributed, non-undoable editor-state effect. */
function navigation(label: string, target: readonly ObjectRef[] = []): VerbEffect {
  return { effect: 'navigation', label, patch: null, inverse: null, target };
}

/**
 * The ONE mutation seam: read the snapshot, run the PURE plan, and hand the engine a
 * FIELD-SCOPED delta (Spec #3120 round 2, ST-4-REWORK / AC6) — one entry's inverse
 * must never revert a later independent edit. The forward delta keeps the post-commit
 * selection; the inverse never carries one. `null` from `reduceDocument` is a true
 * no-op (no entry).
 */
function mutate(
  action: WireframeStoreAction,
  args: WireframeStoreActionArgs,
  label: string,
  target: readonly ObjectRef[],
): VerbEffect {
  const state = getSnapshot();
  const before = state.document;
  const next = reduceDocument(state, action, args);
  if (next === null) return noop(label);
  const { patch: forward, inverse } = diffDocument(before, next.document);
  return {
    effect: 'mutation',
    label,
    patch: {
      before: { delta: inverse } as unknown as JsonPatch,
      after: {
        delta: { ...forward, selection: [...next.selectedIds] },
      } as unknown as JsonPatch,
    },
    inverse: { delta: inverse } as unknown as JsonPatch,
    target,
  };
}

/* ───────────────────────────── element helpers ───────────────────────────── */

function elementTitle(element: WireframeElement): string {
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
  return { type: element.type, id: element.id, label: elementTitle(element) };
}

function targetsForIds(ids: readonly string[]): ObjectRef[] {
  const byId = new Map(getSnapshot().document.elements.map((element) => [element.id, element]));
  return ids
    .map((id) => byId.get(id))
    .filter((element): element is WireframeElement => element !== undefined)
    .map(elementRef);
}

function selectedElements(): WireframeElement[] {
  const state = getSnapshot();
  const selected = new Set(state.selectedIds);
  return state.document.elements.filter((element) => selected.has(element.id));
}

function primaryElement(): WireframeElement | null {
  const state = getSnapshot();
  const id = primarySelectedId(state);
  if (id === null) return null;
  return state.document.elements.find((element) => element.id === id) ?? null;
}

function selectedGroupIds(): string[] {
  const { document } = getSnapshot();
  const ids = new Set<string>();
  for (const element of selectedElements()) {
    const group = groupOfElement(document, element.id);
    if (group) ids.add(group.id);
  }
  return [...ids];
}

function groupTargets(ids: readonly string[]): ObjectRef[] {
  return ids.map((id) => ({ type: 'group', id, label: 'Group' }));
}

/* ───────────────────────────── argument helpers ───────────────────────────── */

function optionalNumber(name: string): VerbArg {
  return { name, type: 'number', required: false };
}

function optionalString(name: string, validate?: (value: string) => boolean): VerbArg {
  return { name, type: 'string', required: false, ...(validate === undefined ? {} : { validate }) };
}

function isSectionPreset(value: string): value is WireframeSectionPreset {
  return value === 'header' || value === 'navbar' || value === 'sidebar' || value === 'footer';
}

function isShapeKind(value: string): value is WireframeShapeKind {
  return value === 'rect' || value === 'ellipse' || value === 'triangle';
}

function isIconId(value: string): value is WireframeIconId {
  return (
    value === 'user' ||
    value === 'chart' ||
    value === 'settings' ||
    value === 'search' ||
    value === 'home' ||
    value === 'bell' ||
    value === 'calendar' ||
    value === 'folder' ||
    value === 'mail' ||
    value === 'star' ||
    value === 'check' ||
    value === 'arrowRight'
  );
}

function isBorderWidth(value: string): value is WireframeBorderWidth {
  return value === 'none' || value === 'thin' || value === 'thick';
}

function isRadius(value: string): value is WireframeRadius {
  return value === 'none' || value === 's' || value === 'm' || value === 'l';
}

function isAppearance(value: string): value is WireframeButtonAppearance {
  return value === 'primary' || value === 'secondary' || value === 'ghost';
}

function isTextStyle(value: string): value is WireframeTextStyle {
  return value === 'body' || value === 'heading';
}

function isPagePreset(value: string): value is WireframePagePreset {
  return value === 'desktop' || value === 'tablet' || value === 'phone' || value === 'custom';
}

function finiteNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/* ───────────────────────────── selection navigation ───────────────────────────── */

/** Arrow selection: wrap around document order (the retired canvas handler's rule). */
function stepSelection(delta: 1 | -1): void {
  const state = getSnapshot();
  const elements = state.document.elements;
  if (elements.length === 0) return;
  const primary = primarySelectedId(state);
  const index = primary === null ? -1 : elements.findIndex((element) => element.id === primary);
  const nextIndex =
    index < 0
      ? delta > 0
        ? 0
        : elements.length - 1
      : (index + delta + elements.length) % elements.length;
  const next = elements[nextIndex];
  if (next !== undefined) select(next.id);
}

/* ───────────────────────────── create ───────────────────────────── */

function createShapeVerb(
  shape: WireframeShapeDrawKind,
  label: string,
): (intent: Intent) => VerbEffect {
  return (intent) => {
    const x = finiteNumber(intent.args.x);
    const y = finiteNumber(intent.args.y);
    const width = finiteNumber(intent.args.width);
    const height = finiteNumber(intent.args.height);
    if (x === null || y === null || width === null || height === null) {
      // ARMS the operator; a `patch:null` noop writes no entry and does not pop.
      beginWireframeShapeCreate(shape);
      return noop(label);
    }
    const state = getSnapshot();
    const element = createShapeElementAtRect({
      shape,
      rect: { x, y, width, height },
      page: state.document.page,
    });
    if (element === null) return noop(label);
    clearArmedWireframeShape();
    return mutate('element.add', { element }, label, [elementRef(element)]);
  };
}

/* ───────────────────────────── insert ───────────────────────────── */

function addElementVerb(type: WireframeElementType): (intent: Intent) => VerbEffect {
  return (intent) => {
    const state = getSnapshot();
    const sectionPreset =
      intent.args.preset !== undefined && isSectionPreset(intent.args.preset)
        ? intent.args.preset
        : undefined;
    const shapeKind =
      intent.args.shape !== undefined && isShapeKind(intent.args.shape)
        ? intent.args.shape
        : undefined;
    const label = intent.args.text;
    let element = createDefaultElement(type, {
      page: state.document.page,
      elements: state.document.elements,
      ...(sectionPreset === undefined ? {} : { preset: sectionPreset }),
      ...(shapeKind === undefined ? {} : { shape: shapeKind }),
      ...(label === undefined ? {} : { text: label }),
    });
    // `createDefaultElement` has no icon option; the declared `iconId` arg overrides the
    // default after construction (same element object, one extra field).
    if (element.type === 'icon') {
      const iconId = intent.args.iconId;
      if (iconId !== undefined && isIconId(iconId)) {
        element = { ...element, iconId };
      }
    }
    return mutate('element.add', { element }, `Add ${WIREFRAME_ELEMENT_LABELS[type]}`, [
      elementRef(element),
    ]);
  };
}

/* ───────────────────────────── edit ───────────────────────────── */

function duplicateSelection(): VerbEffect {
  const primary = primaryElement();
  if (primary === null) return noop('Duplicate');
  return mutate('element.duplicate', { id: primary.id }, `Duplicate ${elementTitle(primary)}`, [
    elementRef(primary),
  ]);
}

function deleteSelection(): VerbEffect {
  const ids = getSnapshot().selectedIds;
  if (ids.length === 0) return noop('Delete');
  const selected = selectedElements();
  const label =
    selected.length === 1 && selected[0] !== undefined
      ? `Delete ${elementTitle(selected[0])}`
      : 'Delete elements';
  return mutate('elements.delete', { ids }, label, targetsForIds(ids));
}

function toggleLockSelection(): VerbEffect {
  const ids = getSnapshot().selectedIds;
  if (ids.length === 0) return noop('Toggle lock');
  return mutate('element.toggleLock', { ids }, 'Toggle lock', targetsForIds(ids));
}

function toggleVisibleSelection(): VerbEffect {
  const selected = selectedElements();
  if (selected.length === 0) return noop('Toggle visible');
  const patches: Record<string, WireframeElementPatch> = {};
  for (const element of selected) {
    patches[element.id] = { visible: !element.visible };
  }
  return mutate('elements.update', { patches }, 'Toggle visible', selected.map(elementRef));
}

function renameFieldFor(element: WireframeElement): WireframeRenameField | null {
  switch (element.type) {
    case 'text':
      return 'text';
    case 'button':
    case 'card':
      return 'label';
    case 'input':
      return 'placeholder';
    default:
      return null;
  }
}

function renameSelection(): VerbEffect {
  const primary = primaryElement();
  if (primary === null) return noop('Rename');
  const field = renameFieldFor(primary);
  if (field === null) return noop('Rename');
  publishRenameRequest(primary.id, field);
  return navigation(`Rename ${elementTitle(primary)}`, [elementRef(primary)]);
}

function parseIds(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

function moveElements(intent: Intent): VerbEffect {
  const ids = parseIds(intent.args.ids);
  const dx = finiteNumber(intent.args.dx);
  const dy = finiteNumber(intent.args.dy);
  if (ids.length === 0 || dx === null || dy === null) return noop('Move');
  const state = getSnapshot();
  const patches: Record<string, WireframeElementPatch> = {};
  for (const element of state.document.elements) {
    if (!ids.includes(element.id)) continue;
    const next = clampRectToPage(
      { ...element, x: element.x + dx, y: element.y + dy },
      state.document.page,
    );
    patches[element.id] = { x: next.x, y: next.y };
  }
  return mutate('elements.update', { patches }, 'Move', targetsForIds(ids));
}

function resizeElements(intent: Intent): VerbEffect {
  const ids = parseIds(intent.args.ids);
  const dx = finiteNumber(intent.args.dx);
  const dy = finiteNumber(intent.args.dy);
  const dw = finiteNumber(intent.args.dw);
  const dh = finiteNumber(intent.args.dh);
  if (ids.length === 0 || dx === null || dy === null || dw === null || dh === null) {
    return noop('Resize');
  }
  const state = getSnapshot();
  const patches: Record<string, WireframeElementPatch> = {};
  for (const element of state.document.elements) {
    if (!ids.includes(element.id)) continue;
    const next = clampRectToPage(
      {
        ...element,
        x: element.x + dx,
        y: element.y + dy,
        width: Math.max(ELEMENT_MIN_SIZE, element.width + dw),
        height: Math.max(ELEMENT_MIN_SIZE, element.height + dh),
      },
      state.document.page,
    );
    patches[element.id] = {
      x: next.x,
      y: next.y,
      width: next.width,
      height: next.height,
    };
  }
  return mutate('elements.update', { patches }, 'Resize', targetsForIds(ids));
}

const NUMBER_FIELDS = new Set(['x', 'y', 'width', 'height']);
const BOOLEAN_FIELDS = new Set(['visible', 'locked']);
const STRING_FIELDS = new Set([
  'text',
  'textStyle',
  'size',
  'align',
  'label',
  'appearance',
  'placeholder',
  'iconId',
  'preset',
  'shape',
  'fill',
  'border',
  'radius',
]);

function fieldPatch(field: string, value: string): WireframeElementPatch | null {
  if (NUMBER_FIELDS.has(field)) {
    const numeric = finiteNumber(value);
    if (numeric === null) return null;
    if (field === 'width' || field === 'height') {
      return { [field]: Math.max(ELEMENT_MIN_SIZE, numeric) } as WireframeElementPatch;
    }
    return { [field]: numeric } as WireframeElementPatch;
  }
  if (BOOLEAN_FIELDS.has(field)) {
    if (value !== 'true' && value !== 'false') return null;
    return { [field]: value === 'true' } as WireframeElementPatch;
  }
  if (STRING_FIELDS.has(field)) {
    return { [field]: value } as WireframeElementPatch;
  }
  return null;
}

function setElementField(intent: Intent): VerbEffect {
  const id = intent.args.id;
  const field = intent.args.field;
  const value = intent.args.value;
  if (id === undefined || field === undefined || value === undefined) return noop('Set field');
  const patch = fieldPatch(field, value);
  if (patch === null) return noop('Set field');
  return mutate('element.update', { id, patch }, `Set ${field}`, targetsForIds([id]));
}

function updatePage(intent: Intent): VerbEffect {
  const presetArg = intent.args.preset ?? intent.args.page;
  const page: Partial<WireframePage> = {};
  if (presetArg !== undefined && intent.args.field === undefined) {
    if (!isPagePreset(presetArg)) return noop('Update page');
    page.preset = presetArg;
  } else if (intent.args.field === 'width' || intent.args.field === 'height') {
    const numeric = finiteNumber(intent.args.value);
    if (numeric === null) return noop('Update page');
    page[intent.args.field] = numeric;
  } else if (intent.args.field === 'preset' && intent.args.value !== undefined) {
    if (!isPagePreset(intent.args.value)) return noop('Update page');
    page.preset = intent.args.value;
  } else if (intent.args.field === undefined && (intent.args.width !== undefined || intent.args.height !== undefined)) {
    const width = finiteNumber(intent.args.width);
    const height = finiteNumber(intent.args.height);
    if (width === null && height === null) return noop('Update page');
    if (width !== null) page.width = width;
    if (height !== null) page.height = height;
  } else {
    return noop('Update page');
  }
  return mutate('page.update', { page }, 'Update page', [
    { type: 'page', id: 'page', label: 'Page' },
  ]);
}

/* ───────────────────────────── arrange ───────────────────────────── */

function alignSelection(edge: WireframeAlignEdge, label: string): VerbEffect {
  const { document } = getSnapshot();
  const selected = selectedElements();
  const movable = selected.filter((element) => isElementMovable(document, element));
  if (!canAlign(movable.length)) return noop(label);
  const bounds = selectionBounds(selected);
  if (bounds === null) return noop(label);
  const aligned = alignRects(movable, edge, bounds);
  const patches: Record<string, WireframeElementPatch> = {};
  movable.forEach((element, index) => {
    patches[element.id] = { x: aligned[index].x };
  });
  return mutate('elements.update', { patches }, label, selected.map(elementRef));
}

function distributeSelection(): VerbEffect {
  const { document } = getSnapshot();
  const movable = selectedElements().filter((element) => isElementMovable(document, element));
  if (!canDistribute(movable.length)) return noop('Distribute');
  const distributed = distributeRectsHorizontally(movable);
  const patches: Record<string, WireframeElementPatch> = {};
  movable.forEach((element, index) => {
    patches[element.id] = { x: distributed[index].x };
  });
  return mutate('elements.update', { patches }, 'Distribute', targetsForIds(
    movable.map((element) => element.id),
  ));
}

function groupSelection(): VerbEffect {
  const ids = getSnapshot().selectedIds;
  if (ids.length < 2) return noop('Group');
  return mutate('group.create', { ids }, 'Group', targetsForIds(ids));
}

function ungroupSelection(): VerbEffect {
  const groupIds = selectedGroupIds();
  if (groupIds.length === 0) return noop('Ungroup');
  return mutate('group.ungroup', { groupIds }, 'Ungroup', groupTargets(groupIds));
}

function toggleGroupLockSelection(): VerbEffect {
  const groupIds = selectedGroupIds();
  if (groupIds.length === 0) return noop('Toggle group lock');
  return mutate('group.toggleLock', { groupIds }, 'Toggle group lock', groupTargets(groupIds));
}

function reorderSelection(direction: 'forward' | 'backward'): VerbEffect {
  const ids = getSnapshot().selectedIds;
  const label = direction === 'forward' ? 'Bring forward' : 'Send backward';
  if (ids.length === 0) return noop(label);
  return mutate('element.reorder', { ids, direction }, label, targetsForIds(ids));
}

/* ───────────────────────────── style cycles ───────────────────────────── */

function cycleValue<T>(current: T | undefined, order: readonly T[], fallback: T): T {
  if (current === undefined) return fallback;
  const index = order.indexOf(current);
  if (index === -1) return fallback;
  return order[(index + 1) % order.length];
}

function applyStylePatch(patch: WireframeElementPatch, label: string): VerbEffect {
  const primary = primaryElement();
  if (primary === null) return noop(label);
  return mutate(
    'elements.update',
    { patches: { [primary.id]: patch } },
    label,
    [elementRef(primary)],
  );
}

const FILL_ORDER = WIREFRAME_COLOR_TOKENS;
const BORDER_ORDER: readonly WireframeBorderWidth[] = ['none', 'thin', 'thick'];
const APPEARANCE_ORDER: readonly WireframeButtonAppearance[] = [
  'primary',
  'secondary',
  'ghost',
];
const RADIUS_ORDER: readonly WireframeRadius[] = ['none', 's', 'm', 'l'];
const TEXT_STYLE_ORDER: readonly WireframeTextStyle[] = ['body', 'heading'];

function styleFill(intent: Intent): VerbEffect {
  const primary = primaryElement();
  if (primary === null || primary.type !== 'shape') return noop('Fill');
  const raw = intent.args.fill;
  const fill: WireframeColorToken =
    raw !== undefined && isWireframeColorToken(raw)
      ? raw
      : cycleValue(primary.fill, FILL_ORDER, 'surface');
  return applyStylePatch({ fill }, 'Fill');
}

function styleBorder(intent: Intent): VerbEffect {
  const primary = primaryElement();
  if (primary === null || primary.type !== 'shape') return noop('Border');
  const raw = intent.args.border;
  const border: WireframeBorderWidth =
    raw !== undefined && isBorderWidth(raw)
      ? raw
      : cycleValue(primary.border, BORDER_ORDER, 'thin');
  return applyStylePatch({ border }, 'Border');
}

function styleRadius(intent: Intent): VerbEffect {
  const primary = primaryElement();
  if (primary === null || primary.type !== 'shape') return noop('Radius');
  const raw = intent.args.radius;
  const radius: WireframeRadius =
    raw !== undefined && isRadius(raw)
      ? raw
      : cycleValue(primary.radius, RADIUS_ORDER, 's');
  return applyStylePatch({ radius }, 'Radius');
}

function styleAppearance(intent: Intent): VerbEffect {
  const primary = primaryElement();
  if (primary === null || primary.type !== 'button') return noop('Appearance');
  const raw = intent.args.appearance;
  const appearance: WireframeButtonAppearance =
    raw !== undefined && isAppearance(raw)
      ? raw
      : cycleValue(primary.appearance, APPEARANCE_ORDER, 'secondary');
  return applyStylePatch({ appearance }, 'Appearance');
}

function styleTextStyle(intent: Intent): VerbEffect {
  const primary = primaryElement();
  if (primary === null || primary.type !== 'text') return noop('Text style');
  const raw = intent.args.textStyle;
  const textStyle: WireframeTextStyle =
    raw !== undefined && isTextStyle(raw)
      ? raw
      : cycleValue(primary.textStyle, TEXT_STYLE_ORDER, 'heading');
  return applyStylePatch({ textStyle }, 'Text style');
}

/* ───────────────────────────── view ───────────────────────────── */

function panByView(intent: Intent): VerbEffect {
  const x = finiteNumber(intent.args.x);
  const y = finiteNumber(intent.args.y);
  if (x === null || y === null) return noop('Pan');
  const { view } = getSnapshot();
  setView({ scale: view.scale, x, y });
  return navigation('Pan');
}

/* ───────────────────────────── file ───────────────────────────── */

function fileActionVerb(actionId: string, label: string): () => VerbEffect {
  return () => {
    // The handler owns its async I/O + status/error surface; the verb stays synchronous.
    runWireframeAction(actionId);
    // A file write leaves Fredo's document + history untouched, so the effect carries
    // `external:true` and NO patch. `patch:null` keeps the funnel from applying anything.
    return {
      effect: 'mutation',
      label,
      patch: null,
      inverse: null,
      external: true,
      target: [],
    };
  };
}

function newDocument(): VerbEffect {
  const before = getSnapshot().document;
  // The shell's dirty guard owns the discard dialog; this run is only reached once the
  // user has committed to discarding. History reset is non-undoable (one cleared journal).
  resetForNewDocument();
  const after = getSnapshot().document;
  return {
    effect: 'mutation',
    label: 'New document',
    patch: {
      before: documentCheckpoint(before),
      after: documentCheckpoint(after, []),
    },
    // Not undoable: the authored consequence comes from `journal.ts` by verb id.
    inverse: null,
    target: [],
  };
}

/* ───────────────────────────── verb descriptor builder ───────────────────────────── */

interface VerbSpec {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly objects: readonly string[];
  readonly places: readonly string[];
  readonly risk: Risk;
  readonly available: (ctx: ContextSnapshot) => boolean;
  readonly run: (intent: Intent) => VerbEffect;
  readonly args?: readonly VerbArg[];
  readonly undo?: (entry: JournalEntry) => VerbEffect;
  readonly publish?: boolean;
  /**
   * Spec #3120 (P6) — the authored consequence of a destructive/external action. The builder
   * previously dropped it, so the confirmation had no honest description (QA Q-3).
   */
  readonly consequence?: string;
  /** Spec #3120 (P6) — where an external action reaches outside Fredo (QA Q-2). */
  readonly externalParty?: string;
}

function defineVerb(spec: VerbSpec): VerbDescriptor {
  return {
    id: spec.id,
    title: spec.title,
    description: spec.description,
    appliesTo: { objects: spec.objects, places: spec.places },
    args: spec.args ?? [],
    available: spec.available,
    risk: spec.risk,
    aliases: [],
    run: spec.run,
    ...(spec.undo === undefined ? {} : { undo: spec.undo }),
    ...(spec.consequence === undefined ? {} : { consequence: spec.consequence }),
    ...(spec.externalParty === undefined ? {} : { externalParty: spec.externalParty }),
    publish: spec.publish ?? true,
  };
}

const always = (): boolean => true;
const hasSelection = (ctx: ContextSnapshot): boolean => ctx.selection.count >= 1;
const hasTwo = (ctx: ContextSnapshot): boolean => ctx.selection.count >= 2;
const hasThree = (ctx: ContextSnapshot): boolean => ctx.selection.count >= 3;
const singleShape = (ctx: ContextSnapshot): boolean =>
  ctx.selection.count === 1 && ctx.selection.kinds[0] === 'shape';
const singleText = (ctx: ContextSnapshot): boolean =>
  ctx.selection.count === 1 && ctx.selection.kinds[0] === 'text';
const singleButton = (ctx: ContextSnapshot): boolean =>
  ctx.selection.count === 1 && ctx.selection.kinds[0] === 'button';
const renamable = (ctx: ContextSnapshot): boolean =>
  ctx.selection.count === 1 &&
  ctx.selection.kinds[0] !== undefined &&
  ['text', 'button', 'input', 'card'].includes(ctx.selection.kinds[0]);

const OBJECT_PAGE = ['page'] as const;
const OBJECT_ELEMENT = ['element'] as const;
const OBJECT_DOCUMENT = ['document'] as const;
const OBJECT_VIEW = ['view'] as const;
const OBJECT_SELECTION = ['selection', 'element'] as const;
const OBJECT_GROUP = ['group', 'element', 'selection'] as const;
const OBJECT_STYLE = ['element', 'selection'] as const;

function entryVerb(placeId: string, title: string): VerbDescriptor {
  return defineVerb({
    id: placeId,
    title,
    description: `Enter the ${title} place.`,
    objects: OBJECT_PAGE,
    places: [placeId],
    risk: 'safe',
    available: always,
    run: () => navigation(`Enter ${title}`),
    publish: false,
  });
}

function deleteUndo(entry: JournalEntry): VerbEffect {
  const inverse = entry.inverse;
  if (inverse === null) return noop(`Undo ${entry.label}`);
  const after = entry.patch !== null ? entry.patch.after : inverse;
  return {
    effect: 'mutation',
    label: `Undo ${entry.label}`,
    patch: { before: after, after: inverse },
    inverse: after,
    target: entry.target,
  };
}

/* ───────────────────────────── the 55 verbs ───────────────────────────── */

const CANVAS = WIREFRAME_ROOT_PLACE_ID;
const CREATE = WIREFRAME_CREATE_PLACE_ID;
const EDIT = WIREFRAME_EDIT_PLACE_ID;
const ARRANGE = WIREFRAME_ARRANGE_PLACE_ID;
const STYLE = WIREFRAME_STYLE_PLACE_ID;
const VIEW = WIREFRAME_VIEW_PLACE_ID;
const FILE = WIREFRAME_FILE_PLACE_ID;

const VERBS: readonly VerbDescriptor[] = [
  /* ── place entry (the id EQUALS the place id — the host enters it) ── */
  entryVerb(CREATE, 'Create'),
  entryVerb(EDIT, 'Edit'),
  entryVerb(ARRANGE, 'Arrange'),
  entryVerb(STYLE, 'Style'),
  entryVerb(VIEW, 'View'),
  entryVerb(FILE, 'File'),

  /* ── root capabilities ── */
  defineVerb({
    id: APP_MAP_VERB_ID,
    title: 'Map',
    description: 'Open the navigation map of every place, verb and key.',
    objects: OBJECT_PAGE,
    places: [CANVAS],
    risk: 'safe',
    available: always,
    run: () => navigation('Map'),
  }),
  defineVerb({
    id: APP_ASK_VERB_ID,
    title: 'Ask',
    description: 'Open the launcher to ask the companion.',
    objects: OBJECT_PAGE,
    places: [CANVAS],
    risk: 'safe',
    // Spec #3120 (P6) — the launcher ships; `/ Ask` is a real affordance (R-7.1).
    available: always,
    run: () => {
      // The navigation effect is the perform; the launcher-open bridge is what makes it visible.
      requestLauncherOpen({ source: 'ask-verb', focus: true });
      return navigation('Ask');
    },
  }),
  defineVerb({
    id: 'wireframe.selection.previous',
    title: 'Previous element',
    description: 'Select the previous element in document order.',
    objects: OBJECT_SELECTION,
    places: [CANVAS],
    risk: 'safe',
    available: hasSelection,
    run: () => {
      stepSelection(-1);
      return navigation('Previous element');
    },
  }),
  defineVerb({
    id: 'wireframe.selection.next',
    title: 'Next element',
    description: 'Select the next element in document order.',
    objects: OBJECT_SELECTION,
    places: [CANVAS],
    risk: 'safe',
    available: hasSelection,
    run: () => {
      stepSelection(1);
      return navigation('Next element');
    },
  }),

  /* ── create (transient place) ── */
  defineVerb({
    id: 'wireframe.create.rect',
    title: 'Rectangle',
    description:
      'Arm the rectangle draw tool, or create one at explicit page bounds when x, y, width and height are supplied.',
    objects: OBJECT_ELEMENT,
    places: [CREATE],
    risk: 'mutating',
    available: always,
    args: [
      optionalNumber('x'),
      optionalNumber('y'),
      optionalNumber('width'),
      optionalNumber('height'),
    ],
    run: createShapeVerb('rect', 'Rectangle'),
  }),
  defineVerb({
    id: 'wireframe.create.ellipse',
    title: 'Ellipse',
    description:
      'Arm the ellipse draw tool, or create one at explicit page bounds when x, y, width and height are supplied.',
    objects: OBJECT_ELEMENT,
    places: [CREATE],
    risk: 'mutating',
    available: always,
    args: [
      optionalNumber('x'),
      optionalNumber('y'),
      optionalNumber('width'),
      optionalNumber('height'),
    ],
    run: createShapeVerb('ellipse', 'Ellipse'),
  }),

  /* ── insert (nine element kinds) ── */
  defineVerb({
    id: 'wireframe.add.text',
    title: 'Text',
    description: 'Add a text element (body or heading style).',
    objects: OBJECT_ELEMENT,
    places: [CREATE],
    risk: 'mutating',
    available: always,
    args: [optionalString('text')],
    run: addElementVerb('text'),
  }),
  defineVerb({
    id: 'wireframe.add.button',
    title: 'Button',
    description: 'Add a button element.',
    objects: OBJECT_ELEMENT,
    places: [CREATE],
    risk: 'mutating',
    available: always,
    run: addElementVerb('button'),
  }),
  defineVerb({
    id: 'wireframe.add.input',
    title: 'Input',
    description: 'Add an input field element.',
    objects: OBJECT_ELEMENT,
    places: [CREATE],
    risk: 'mutating',
    available: always,
    run: addElementVerb('input'),
  }),
  defineVerb({
    id: 'wireframe.add.image',
    title: 'Image',
    description: 'Add an image placeholder frame.',
    objects: OBJECT_ELEMENT,
    places: [CREATE],
    risk: 'mutating',
    available: always,
    run: addElementVerb('image'),
  }),
  defineVerb({
    id: 'wireframe.add.icon',
    title: 'Icon',
    description: 'Add an icon from the curated set.',
    objects: OBJECT_ELEMENT,
    places: [CREATE],
    risk: 'mutating',
    available: always,
    args: [optionalString('iconId', isIconId)],
    run: addElementVerb('icon'),
  }),
  defineVerb({
    id: 'wireframe.add.card',
    title: 'Card',
    description: 'Add a card / container element.',
    objects: OBJECT_ELEMENT,
    places: [CREATE],
    risk: 'mutating',
    available: always,
    run: addElementVerb('card'),
  }),
  defineVerb({
    id: 'wireframe.add.section',
    title: 'Section',
    description: 'Add a site frame section (header, nav bar, sidebar or footer).',
    objects: OBJECT_ELEMENT,
    places: [CREATE],
    risk: 'mutating',
    available: always,
    args: [optionalString('preset', isSectionPreset)],
    run: addElementVerb('section'),
  }),
  defineVerb({
    id: 'wireframe.add.shape',
    title: 'Shape',
    description: 'Add a basic shape.',
    objects: OBJECT_ELEMENT,
    places: [CREATE],
    risk: 'mutating',
    available: always,
    args: [optionalString('shape', isShapeKind)],
    run: addElementVerb('shape'),
  }),
  defineVerb({
    id: 'wireframe.add.line',
    title: 'Line',
    description: 'Add a line.',
    objects: OBJECT_ELEMENT,
    places: [CREATE],
    risk: 'mutating',
    available: always,
    run: addElementVerb('line'),
  }),

  /* ── edit ── */
  defineVerb({
    id: 'wireframe.element.duplicate',
    title: 'Duplicate',
    description: 'Duplicate the selected element.',
    objects: OBJECT_ELEMENT,
    places: [EDIT],
    risk: 'mutating',
    available: hasSelection,
    run: duplicateSelection,
  }),
  defineVerb({
    id: 'wireframe.element.delete',
    title: 'Delete',
    description: 'Delete every selected element.',
    objects: OBJECT_ELEMENT,
    places: [EDIT],
    // Destructive with an undo (the journal checkpoint), so V-10 passes; the keyboard/pointer
    // path keeps the shipped no-confirm behaviour, while launcher/voice/agent confirmation
    // names the authored consequence (QA Q-3).
    risk: 'destructive',
    consequence:
      'Deletes the selected element and its contents. This can be undone from the trail.',
    available: hasSelection,
    run: deleteSelection,
    undo: deleteUndo,
  }),
  defineVerb({
    id: 'wireframe.element.toggleLock',
    title: 'Toggle lock',
    description: 'Lock or unlock every selected element.',
    objects: OBJECT_ELEMENT,
    places: [EDIT],
    risk: 'mutating',
    available: hasSelection,
    run: toggleLockSelection,
  }),
  defineVerb({
    id: 'wireframe.element.toggleVisible',
    title: 'Toggle visible',
    description: 'Show or hide every selected element.',
    objects: OBJECT_ELEMENT,
    places: [EDIT],
    risk: 'mutating',
    available: hasSelection,
    run: toggleVisibleSelection,
  }),
  defineVerb({
    id: 'wireframe.element.rename',
    title: 'Rename',
    description: 'Focus and select the selected element name field in the details view.',
    objects: OBJECT_ELEMENT,
    places: [EDIT],
    // No document field exists: this is a navigation effect, never a fabricated name.
    risk: 'safe',
    available: renamable,
    run: renameSelection,
  }),

  /* ── geometry + fields (details view / pointer callers) ── */
  defineVerb({
    id: 'wireframe.element.move',
    title: 'Move',
    description: 'Move the given element ids by a page-space delta.',
    objects: OBJECT_SELECTION,
    places: [EDIT],
    risk: 'mutating',
    available: hasSelection,
    args: [
      optionalString('ids'),
      optionalNumber('dx'),
      optionalNumber('dy'),
    ],
    run: moveElements,
  }),
  defineVerb({
    id: 'wireframe.element.resize',
    title: 'Resize',
    description: 'Resize the given element ids by a page-space delta.',
    objects: OBJECT_SELECTION,
    places: [EDIT],
    risk: 'mutating',
    available: hasSelection,
    args: [
      optionalString('ids'),
      optionalNumber('dx'),
      optionalNumber('dy'),
      optionalNumber('dw'),
      optionalNumber('dh'),
    ],
    run: resizeElements,
  }),
  defineVerb({
    id: 'wireframe.element.setField',
    title: 'Set field',
    description: 'Write one element field from the details view.',
    objects: OBJECT_ELEMENT,
    places: [EDIT],
    risk: 'mutating',
    available: hasSelection,
    args: [optionalString('id'), optionalString('field'), optionalString('value')],
    run: setElementField,
  }),
  defineVerb({
    id: 'wireframe.page.update',
    title: 'Update page',
    description: 'Change the page preset, width or height.',
    objects: OBJECT_PAGE,
    places: [EDIT],
    risk: 'mutating',
    available: always,
    args: [
      optionalString('field'),
      optionalString('value'),
      optionalString('page'),
      optionalString('preset'),
      optionalNumber('width'),
      optionalNumber('height'),
    ],
    run: updatePage,
  }),

  /* ── arrange ── */
  defineVerb({
    id: 'wireframe.arrange.group',
    title: 'Group',
    description: 'Group the selected elements.',
    objects: OBJECT_GROUP,
    places: [ARRANGE],
    risk: 'mutating',
    available: hasTwo,
    run: groupSelection,
  }),
  defineVerb({
    id: 'wireframe.arrange.ungroup',
    title: 'Ungroup',
    description: 'Ungroup every group the selection touches.',
    objects: OBJECT_GROUP,
    places: [ARRANGE],
    risk: 'mutating',
    available: hasSelection,
    run: ungroupSelection,
  }),
  defineVerb({
    id: 'wireframe.arrange.toggleGroupLock',
    title: 'Lock group',
    description: 'Lock or unlock every group the selection touches.',
    objects: OBJECT_GROUP,
    places: [ARRANGE],
    risk: 'mutating',
    available: hasSelection,
    run: toggleGroupLockSelection,
  }),
  defineVerb({
    id: 'wireframe.arrange.alignLeft',
    title: 'Align left',
    description: 'Align the selected elements to the left of their union bounds.',
    objects: OBJECT_STYLE,
    places: [ARRANGE],
    risk: 'mutating',
    available: hasTwo,
    run: () => alignSelection('left', 'Align left'),
  }),
  defineVerb({
    id: 'wireframe.arrange.alignCenter',
    title: 'Align center',
    description: 'Align the selected elements to the centre of their union bounds.',
    objects: OBJECT_STYLE,
    places: [ARRANGE],
    risk: 'mutating',
    available: hasTwo,
    run: () => alignSelection('center', 'Align center'),
  }),
  defineVerb({
    id: 'wireframe.arrange.alignRight',
    title: 'Align right',
    description: 'Align the selected elements to the right of their union bounds.',
    objects: OBJECT_STYLE,
    places: [ARRANGE],
    risk: 'mutating',
    available: hasTwo,
    run: () => alignSelection('right', 'Align right'),
  }),
  defineVerb({
    id: 'wireframe.arrange.distribute',
    title: 'Distribute',
    description: 'Distribute the selected elements with equal horizontal gaps.',
    objects: OBJECT_STYLE,
    places: [ARRANGE],
    risk: 'mutating',
    available: hasThree,
    run: distributeSelection,
  }),
  defineVerb({
    id: 'wireframe.arrange.bringForward',
    title: 'Bring forward',
    description: 'Move the selected elements one step forward in paint order.',
    objects: OBJECT_STYLE,
    places: [ARRANGE],
    risk: 'mutating',
    available: hasSelection,
    run: () => reorderSelection('forward'),
  }),
  defineVerb({
    id: 'wireframe.arrange.sendBackward',
    title: 'Send backward',
    description: 'Move the selected elements one step backward in paint order.',
    objects: OBJECT_STYLE,
    places: [ARRANGE],
    risk: 'mutating',
    available: hasSelection,
    run: () => reorderSelection('backward'),
  }),
  defineVerb({
    id: 'wireframe.arrange.toggleSnap',
    title: 'Toggle snap',
    description: 'Toggle snap to grid.',
    objects: OBJECT_VIEW,
    places: [ARRANGE],
    risk: 'safe',
    available: always,
    run: () => {
      toggleSnapToGrid();
      return navigation('Toggle snap');
    },
  }),

  /* ── style ── */
  defineVerb({
    id: 'wireframe.style.fill',
    title: 'Fill',
    description: 'Set the fill token, or cycle to the next token when no value is supplied.',
    objects: OBJECT_STYLE,
    places: [STYLE],
    risk: 'mutating',
    available: singleShape,
    args: [optionalString('fill', isWireframeColorToken)],
    run: styleFill,
  }),
  defineVerb({
    id: 'wireframe.style.border',
    title: 'Border',
    description: 'Set the border width, or cycle none → thin → thick when no value is supplied.',
    objects: OBJECT_STYLE,
    places: [STYLE],
    risk: 'mutating',
    available: singleShape,
    args: [optionalString('border', isBorderWidth)],
    run: styleBorder,
  }),
  defineVerb({
    id: 'wireframe.style.appearance',
    title: 'Appearance',
    description: 'Set the button appearance, or cycle primary → secondary → ghost.',
    objects: OBJECT_STYLE,
    places: [STYLE],
    risk: 'mutating',
    available: singleButton,
    args: [optionalString('appearance', isAppearance)],
    run: styleAppearance,
  }),
  defineVerb({
    id: 'wireframe.style.radius',
    title: 'Radius',
    description: 'Set the corner radius, or cycle none → s → m → l.',
    objects: OBJECT_STYLE,
    places: [STYLE],
    risk: 'mutating',
    available: singleShape,
    args: [optionalString('radius', isRadius)],
    run: styleRadius,
  }),
  defineVerb({
    id: 'wireframe.style.textStyle',
    title: 'Text style',
    description: 'Set the text style, or cycle body → heading.',
    objects: OBJECT_STYLE,
    places: [STYLE],
    risk: 'mutating',
    available: singleText,
    args: [optionalString('textStyle', isTextStyle)],
    run: styleTextStyle,
  }),

  /* ── view ── */
  defineVerb({
    id: 'wireframe.zoom.in',
    title: 'Zoom in',
    description: 'Zoom in one step about the viewport centre.',
    objects: OBJECT_VIEW,
    places: [VIEW],
    risk: 'safe',
    available: always,
    run: () => {
      zoomIn();
      return navigation('Zoom in');
    },
  }),
  defineVerb({
    id: 'wireframe.zoom.out',
    title: 'Zoom out',
    description: 'Zoom out one step about the viewport centre.',
    objects: OBJECT_VIEW,
    places: [VIEW],
    risk: 'safe',
    available: always,
    run: () => {
      zoomOut();
      return navigation('Zoom out');
    },
  }),
  defineVerb({
    id: 'wireframe.view.fitPage',
    title: 'Fit page',
    description: 'Fit the whole page to the viewport.',
    objects: OBJECT_VIEW,
    places: [VIEW],
    risk: 'safe',
    available: always,
    run: () => {
      fitPage();
      return navigation('Fit page');
    },
  }),
  defineVerb({
    id: 'wireframe.view.resetView',
    title: 'Reset view',
    description: 'Reset to 100% and centre the page.',
    objects: OBJECT_VIEW,
    places: [VIEW],
    risk: 'safe',
    available: always,
    run: () => {
      resetView();
      return navigation('Reset view');
    },
  }),
  defineVerb({
    id: 'wireframe.view.togglePan',
    title: 'Pan tool',
    description: 'Toggle the pan tool.',
    objects: OBJECT_VIEW,
    places: [VIEW],
    risk: 'safe',
    available: always,
    run: () => {
      togglePan();
      return navigation('Pan tool');
    },
  }),
  defineVerb({
    id: 'wireframe.view.panBy',
    title: 'Pan by',
    description: 'Set the view translation to the given page-space offsets.',
    objects: OBJECT_VIEW,
    places: [VIEW],
    risk: 'safe',
    available: always,
    args: [optionalNumber('x'), optionalNumber('y')],
    run: panByView,
  }),

  /* ── file (non-undoable; the journal's authored consequence copy) ── */
  defineVerb({
    id: 'wireframe.document.new',
    title: 'New document',
    description: 'Start a new empty wireframe.',
    objects: OBJECT_DOCUMENT,
    places: [FILE],
    // The shell's dirty guard owns the discard dialog — no second confirm here.
    risk: 'mutating',
    available: always,
    run: newDocument,
  }),
  defineVerb({
    id: 'place.open',
    title: 'Open',
    description: 'Open a saved wireframe document.',
    objects: OBJECT_DOCUMENT,
    places: [FILE],
    risk: 'mutating',
    available: always,
    run: fileActionVerb('wireframe.file.open', 'Open'),
  }),
  defineVerb({
    id: 'place.saveAs',
    title: 'Save as',
    description: 'Save the document to a new file.',
    objects: OBJECT_DOCUMENT,
    places: [FILE],
    risk: 'mutating',
    available: always,
    run: fileActionVerb('wireframe.file.saveAs', 'Save as'),
  }),
  defineVerb({
    id: 'place.exportPng',
    title: 'Export PNG',
    description: 'Export the page as a PNG.',
    objects: OBJECT_DOCUMENT,
    places: [FILE],
    // Spec #3120 (P6) QA Q-2 — a file write leaves Fredo, so it is the one declared external
    // verb. The other three file verbs stay `mutating` this round.
    risk: 'external',
    consequence:
      "Writes a PNG file outside Fredo's document history. It cannot be undone from the trail.",
    externalParty: 'your file system',
    available: always,
    run: fileActionVerb('wireframe.file.exportPng', 'Export PNG'),
  }),
];

/* ───────────────────────────── places ───────────────────────────── */

const placeBinding = (placeId: string): KeyBinding => ({ kind: 'place', placeId });
const verbBinding = (verbId: string): KeyBinding => ({ kind: 'verb', verbId });

function place(
  id: string,
  label: string,
  parent: string | null,
  keys: PlaceNode['keys'],
  flags: Partial<Pick<PlaceNode, 'transient' | 'sticky' | 'cursor' | 'operator'>> = {},
): PlaceNode {
  return {
    id,
    label,
    parent,
    keys,
    transient: false,
    sticky: false,
    cursor: null,
    operator: null,
    entryHooks: [],
    exitHooks: [],
    ...flags,
  };
}

const PLACES: readonly PlaceNode[] = [
  place(CANVAS, 'Canvas', null, {
    c: placeBinding(CREATE),
    e: placeBinding(EDIT),
    a: placeBinding(ARRANGE),
    s: placeBinding(STYLE),
    v: placeBinding(VIEW),
    f: placeBinding(FILE),
    m: verbBinding(APP_MAP_VERB_ID),
    k: verbBinding(APP_ASK_VERB_ID),
    ArrowLeft: verbBinding('wireframe.selection.previous'),
    ArrowUp: verbBinding('wireframe.selection.previous'),
    ArrowRight: verbBinding('wireframe.selection.next'),
    ArrowDown: verbBinding('wireframe.selection.next'),
  }, { sticky: true }),
  place(CREATE, 'Create', CANVAS, {
    r: verbBinding('wireframe.create.rect'),
    e: verbBinding('wireframe.create.ellipse'),
    t: verbBinding('wireframe.add.text'),
    b: verbBinding('wireframe.add.button'),
    i: verbBinding('wireframe.add.input'),
    m: verbBinding('wireframe.add.image'),
    k: verbBinding('wireframe.add.card'),
    s: verbBinding('wireframe.add.section'),
    l: verbBinding('wireframe.add.line'),
  }, {
    transient: true,
    sticky: false,
    operator: WIREFRAME_CREATE_OPERATOR,
    cursor: WIREFRAME_DRAW_CURSOR,
  }),
  place(EDIT, 'Edit', CANVAS, {
    d: verbBinding('wireframe.element.duplicate'),
    x: verbBinding('wireframe.element.delete'),
    l: verbBinding('wireframe.element.toggleLock'),
    h: verbBinding('wireframe.element.toggleVisible'),
    r: verbBinding('wireframe.element.rename'),
  }, { sticky: true }),
  place(ARRANGE, 'Arrange', CANVAS, {
    g: verbBinding('wireframe.arrange.group'),
    u: verbBinding('wireframe.arrange.ungroup'),
    ArrowLeft: verbBinding('wireframe.arrange.alignLeft'),
    ArrowRight: verbBinding('wireframe.arrange.alignRight'),
    d: verbBinding('wireframe.arrange.distribute'),
    f: verbBinding('wireframe.arrange.bringForward'),
    b: verbBinding('wireframe.arrange.sendBackward'),
    s: verbBinding('wireframe.arrange.toggleSnap'),
  }, { sticky: true }),
  place(STYLE, 'Style', CANVAS, {
    f: verbBinding('wireframe.style.fill'),
    o: verbBinding('wireframe.style.border'),
    p: verbBinding('wireframe.style.appearance'),
    z: verbBinding('wireframe.style.radius'),
    t: verbBinding('wireframe.style.textStyle'),
  }, { sticky: true }),
  place(VIEW, 'View', CANVAS, {
    '+': verbBinding('wireframe.zoom.in'),
    '-': verbBinding('wireframe.zoom.out'),
    f: verbBinding('wireframe.view.fitPage'),
    '0': verbBinding('wireframe.view.resetView'),
    p: verbBinding('wireframe.view.togglePan'),
  }, { sticky: true }),
  place(FILE, 'File', CANVAS, {
    n: verbBinding('wireframe.document.new'),
    o: verbBinding('place.open'),
    w: verbBinding('place.saveAs'),
    x: verbBinding('place.exportPng'),
  }, { sticky: true }),
];

/* ───────────────────────────── the declaration ───────────────────────────── */

/** The ONE Wireframe surface declaration (P5). */
export const wireframeSurface: Surface = {
  tree: {
    appId: WIREFRAME_SURFACE_APP_ID,
    root: CANVAS,
    places: PLACES,
    directAliases: {
      r: 'wireframe.create.rect',
      u: 'journal.undo',
      y: 'journal.redo',
    },
  },
  verbs: VERBS,
  companion: {
    appName: 'Wireframe',
    description: 'Draw and arrange wireframe pages.',
  },
};

/** Test-only: clear the session-scoped armed kind + pending rename request. */
export function resetWireframeSurfaceForTests(): void {
  armedShape = null;
  armedListeners.clear();
  renameRequest = null;
  renameListeners.clear();
}
