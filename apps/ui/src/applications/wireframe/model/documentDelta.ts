/**
 * Field-scoped document deltas (Spec #3120 round 2, ST-4-REWORK / AC6).
 *
 * The journal is the ONE undo authority, but an entry's `inverse` MUST revert only
 * what that entry changed — a whole-document snapshot means an older inverse
 * clobbers a later independent edit (R-6.1). This module is the SINGLE diff/apply
 * implementation shared by both producers (`wireframeSurface.mutate` and the
 * legacy `wireframeDocumentStore.commitPlan`), so a verb's field can never
 * silently stop being reverted through a second hand-authored patch path.
 *
 * The delta is an ABSOLUTE field assignment (not an operation list): disjoint
 * deltas compose in any order and overlapping ones compose LIFO, which is exactly
 * the engine's undo/redo order. `applyDocumentDelta` applies against the CURRENT
 * document and never mutates its input.
 */

import type { JsonValue } from '../../../shared/navigation';

import type { WireframeDocument, WireframeGroup, WireframePage } from './document';
import type { WireframeElement } from './elements';

/** A per-object field delta: assign each `set` key, delete each `unset` key. */
export interface WireframeFieldsDelta {
  set?: Record<string, JsonValue>;
  unset?: readonly string[];
}

/**
 * One document mutation expressed as the fields it changed. `selection` is the
 * post-commit selection (never carried by an inverse).
 */
export interface WireframeDocumentDelta {
  page?: WireframeFieldsDelta;
  elements?: Record<string, WireframeFieldsDelta>;
  elementAdds?: readonly WireframeElement[];
  elementRemoves?: readonly string[];
  elementOrder?: readonly string[];
  groups?: Record<string, WireframeFieldsDelta>;
  groupAdds?: readonly WireframeGroup[];
  groupRemoves?: readonly string[];
  groupOrder?: readonly string[];
  selection?: readonly string[];
}

/** The forward and mirror deltas between two documents. */
export interface WireframeDocumentDiff {
  readonly patch: WireframeDocumentDelta;
  readonly inverse: WireframeDocumentDelta;
}

const DELTA_KEYS: readonly (keyof WireframeDocumentDelta)[] = [
  'page',
  'elements',
  'elementAdds',
  'elementRemoves',
  'elementOrder',
  'groups',
  'groupAdds',
  'groupRemoves',
  'groupOrder',
  'selection',
];

/* ───────────────────────────── structural guards ───────────────────────────── */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isFieldsDelta(value: unknown): value is WireframeFieldsDelta {
  if (!isRecord(value)) return false;
  if (value.set !== undefined && !isRecord(value.set)) return false;
  if (value.unset !== undefined && !isStringArray(value.unset)) return false;
  return true;
}

function isFieldsDeltaMap(value: unknown): value is Record<string, WireframeFieldsDelta> {
  if (!isRecord(value)) return false;
  return Object.values(value).every((entry) => isFieldsDelta(entry));
}

function isElementLike(value: unknown): value is WireframeElement {
  return isRecord(value) && typeof value.id === 'string' && typeof value.type === 'string';
}

function isGroupLike(value: unknown): value is WireframeGroup {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    isStringArray(value.memberIds) &&
    typeof value.locked === 'boolean'
  );
}

/**
 * Structural guard for the store decoder. Total and permissive about unknown
 * keys, but an object with NO delta key is not a delta (so a full checkpoint is
 * never mistaken for one).
 */
export function isWireframeDocumentDelta(value: unknown): value is WireframeDocumentDelta {
  if (!isRecord(value)) return false;
  if (!DELTA_KEYS.some((key) => key in value)) return false;
  if (value.page !== undefined && !isFieldsDelta(value.page)) return false;
  if (value.elements !== undefined && !isFieldsDeltaMap(value.elements)) return false;
  if (value.elementAdds !== undefined) {
    if (!Array.isArray(value.elementAdds) || !value.elementAdds.every(isElementLike)) return false;
  }
  if (value.elementRemoves !== undefined && !isStringArray(value.elementRemoves)) return false;
  if (value.elementOrder !== undefined && !isStringArray(value.elementOrder)) return false;
  if (value.groups !== undefined && !isFieldsDeltaMap(value.groups)) return false;
  if (value.groupAdds !== undefined) {
    if (!Array.isArray(value.groupAdds) || !value.groupAdds.every(isGroupLike)) return false;
  }
  if (value.groupRemoves !== undefined && !isStringArray(value.groupRemoves)) return false;
  if (value.groupOrder !== undefined && !isStringArray(value.groupOrder)) return false;
  if (value.selection !== undefined && !isStringArray(value.selection)) return false;
  return true;
}

/* ───────────────────────────── equality + diff ───────────────────────────── */

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== typeof right) return false;
  if (left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    return left.every((item, index) => deepEqual(item, right[index]));
  }
  if (typeof left === 'object' && typeof right === 'object') {
    const leftFields = left as Record<string, unknown>;
    const rightFields = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftFields);
    if (leftKeys.length !== Object.keys(rightFields).length) return false;
    return leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(rightFields, key) &&
        deepEqual(leftFields[key], rightFields[key]),
    );
  }
  return false;
}

/** The plain-field view of a model object (every element/group/page field is JSON). */
function asFields(value: object): Record<string, JsonValue> {
  return value as unknown as Record<string, JsonValue>;
}

function isEmptyFields(delta: WireframeFieldsDelta): boolean {
  return (delta.set === undefined || Object.keys(delta.set).length === 0) &&
    (delta.unset === undefined || delta.unset.length === 0);
}

function diffFields(
  before: Readonly<Record<string, JsonValue>>,
  after: Readonly<Record<string, JsonValue>>,
): WireframeFieldsDelta {
  const delta: WireframeFieldsDelta = {};
  const set: Record<string, JsonValue> = {};
  const unset: string[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const inBefore = Object.prototype.hasOwnProperty.call(before, key);
    const inAfter = Object.prototype.hasOwnProperty.call(after, key);
    if (inAfter && (!inBefore || !deepEqual(before[key], after[key]))) {
      set[key] = after[key] as JsonValue;
    } else if (inBefore && !inAfter) {
      unset.push(key);
    }
  }
  if (Object.keys(set).length > 0) delta.set = set;
  if (unset.length > 0) delta.unset = unset;
  return delta;
}

function indexById<T extends { id: string }>(items: readonly T[]): Map<string, T> {
  return new Map(items.map((item) => [item.id, item]));
}

function sameSequence(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((id, index) => id === right[index]);
}

/**
 * Diff two documents into a scoped forward delta and its mirror inverse. Keys
 * present in both but unequal go in `set` with the AFTER value; keys only in
 * `before` go in `unset`; ids only in `after` are full `*Adds`; ids only in
 * `before` are `*Removes`; an order field is emitted only when the id sequence
 * changed. The inverse never carries `selection`.
 */
export function diffDocument(
  before: WireframeDocument,
  after: WireframeDocument,
): WireframeDocumentDiff {
  const patch: WireframeDocumentDelta = {};
  const inverse: WireframeDocumentDelta = {};

  const pagePatch = diffFields(asFields(before.page), asFields(after.page));
  if (!isEmptyFields(pagePatch)) patch.page = pagePatch;
  const pageInverse = diffFields(asFields(after.page), asFields(before.page));
  if (!isEmptyFields(pageInverse)) inverse.page = pageInverse;

  const beforeElements = indexById(before.elements);
  const afterElements = indexById(after.elements);
  const elementFields: Record<string, WireframeFieldsDelta> = {};
  const inverseElementFields: Record<string, WireframeFieldsDelta> = {};
  for (const [id, afterElement] of afterElements) {
    const beforeElement = beforeElements.get(id);
    if (beforeElement === undefined) continue;
    const forward = diffFields(asFields(beforeElement), asFields(afterElement));
    if (!isEmptyFields(forward)) elementFields[id] = forward;
    const backward = diffFields(asFields(afterElement), asFields(beforeElement));
    if (!isEmptyFields(backward)) inverseElementFields[id] = backward;
  }
  if (Object.keys(elementFields).length > 0) patch.elements = elementFields;
  if (Object.keys(inverseElementFields).length > 0) inverse.elements = inverseElementFields;

  const addedElements = [...afterElements.values()].filter(
    (element) => !beforeElements.has(element.id),
  );
  const removedElements = [...beforeElements.values()].filter(
    (element) => !afterElements.has(element.id),
  );
  if (addedElements.length > 0) patch.elementAdds = addedElements;
  if (removedElements.length > 0) patch.elementRemoves = removedElements.map((element) => element.id);
  if (addedElements.length > 0) {
    inverse.elementRemoves = addedElements.map((element) => element.id);
  }
  if (removedElements.length > 0) inverse.elementAdds = removedElements;

  const beforeElementOrder = before.elements.map((element) => element.id);
  const afterElementOrder = after.elements.map((element) => element.id);
  if (!sameSequence(beforeElementOrder, afterElementOrder)) {
    patch.elementOrder = afterElementOrder;
    inverse.elementOrder = beforeElementOrder;
  }

  const beforeGroups = indexById(before.groups);
  const afterGroups = indexById(after.groups);
  const groupFields: Record<string, WireframeFieldsDelta> = {};
  const inverseGroupFields: Record<string, WireframeFieldsDelta> = {};
  for (const [id, afterGroup] of afterGroups) {
    const beforeGroup = beforeGroups.get(id);
    if (beforeGroup === undefined) continue;
    const forward = diffFields(asFields(beforeGroup), asFields(afterGroup));
    if (!isEmptyFields(forward)) groupFields[id] = forward;
    const backward = diffFields(asFields(afterGroup), asFields(beforeGroup));
    if (!isEmptyFields(backward)) inverseGroupFields[id] = backward;
  }
  if (Object.keys(groupFields).length > 0) patch.groups = groupFields;
  if (Object.keys(inverseGroupFields).length > 0) inverse.groups = inverseGroupFields;

  const addedGroups = [...afterGroups.values()].filter((group) => !beforeGroups.has(group.id));
  const removedGroups = [...beforeGroups.values()].filter((group) => !afterGroups.has(group.id));
  if (addedGroups.length > 0) patch.groupAdds = addedGroups;
  if (removedGroups.length > 0) patch.groupRemoves = removedGroups.map((group) => group.id);
  if (addedGroups.length > 0) inverse.groupRemoves = addedGroups.map((group) => group.id);
  if (removedGroups.length > 0) inverse.groupAdds = removedGroups;

  const beforeGroupOrder = before.groups.map((group) => group.id);
  const afterGroupOrder = after.groups.map((group) => group.id);
  if (!sameSequence(beforeGroupOrder, afterGroupOrder)) {
    patch.groupOrder = afterGroupOrder;
    inverse.groupOrder = beforeGroupOrder;
  }

  return { patch, inverse };
}

/* ───────────────────────────── apply ───────────────────────────── */

function applyFields(
  target: Readonly<Record<string, JsonValue>>,
  delta: WireframeFieldsDelta,
): Record<string, JsonValue> | null {
  if (!isFieldsDelta(delta)) return null;
  const next: Record<string, JsonValue> = { ...target };
  if (delta.set !== undefined) {
    for (const [key, value] of Object.entries(delta.set)) next[key] = value;
  }
  if (delta.unset !== undefined) {
    for (const key of delta.unset) delete next[key];
  }
  return next;
}

function asPage(fields: Record<string, JsonValue>): WireframePage | null {
  const { preset, width, height } = fields;
  if (preset !== 'desktop' && preset !== 'tablet' && preset !== 'phone' && preset !== 'custom') {
    return null;
  }
  if (typeof width !== 'number' || !Number.isFinite(width)) return null;
  if (typeof height !== 'number' || !Number.isFinite(height)) return null;
  return { preset, width, height };
}

function asElement(fields: Record<string, JsonValue>, id: string): WireframeElement | null {
  if (fields.id !== id || typeof fields.type !== 'string') return null;
  return fields as unknown as WireframeElement;
}

function asGroup(fields: Record<string, JsonValue>, id: string): WireframeGroup | null {
  if (fields.id !== id) return null;
  if (!isStringArray(fields.memberIds)) return null;
  if (typeof fields.locked !== 'boolean') return null;
  return { id, memberIds: [...fields.memberIds], locked: fields.locked };
}

function orderById<T extends { id: string }>(
  items: readonly T[],
  order: readonly string[],
): T[] | null {
  if (order.length !== items.length) return null;
  const byId = new Map(items.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const ordered: T[] = [];
  for (const id of order) {
    const item = byId.get(id);
    if (item === undefined || seen.has(id)) return null;
    seen.add(id);
    ordered.push(item);
  }
  return ordered;
}

/**
 * Apply a scoped delta to the CURRENT document and return a new document. Total:
 * an invalid or inapplicable delta returns `null` (never throws), so a stale/bad
 * patch is a safe no-op.
 */
export function applyDocumentDelta(
  document: WireframeDocument,
  delta: WireframeDocumentDelta,
): WireframeDocument | null {
  if (!isWireframeDocumentDelta(delta)) return null;

  let page: WireframePage = document.page;
  if (delta.page !== undefined) {
    const nextPage = applyFields(asFields(document.page), delta.page);
    if (nextPage === null) return null;
    const validatedPage = asPage(nextPage);
    if (validatedPage === null) return null;
    page = validatedPage;
  }

  const elementsById = new Map<string, WireframeElement>(
    document.elements.map((element) => [element.id, { ...element }]),
  );
  if (delta.elementRemoves !== undefined) {
    for (const id of delta.elementRemoves) {
      if (!elementsById.delete(id)) return null;
    }
  }
  if (delta.elementAdds !== undefined) {
    for (const element of delta.elementAdds) {
      if (!isElementLike(element) || elementsById.has(element.id)) return null;
      elementsById.set(element.id, { ...element });
    }
  }
  if (delta.elements !== undefined) {
    for (const [id, fields] of Object.entries(delta.elements)) {
      const current = elementsById.get(id);
      if (current === undefined) return null;
      const next = applyFields(asFields(current), fields);
      if (next === null) return null;
      const element = asElement(next, id);
      if (element === null) return null;
      elementsById.set(id, element);
    }
  }
  let elements = [...elementsById.values()];
  if (delta.elementOrder !== undefined) {
    const ordered = orderById(elements, delta.elementOrder);
    if (ordered === null) return null;
    elements = ordered;
  }

  const groupsById = new Map<string, WireframeGroup>(
    document.groups.map((group) => [group.id, { ...group, memberIds: [...group.memberIds] }]),
  );
  if (delta.groupRemoves !== undefined) {
    for (const id of delta.groupRemoves) {
      if (!groupsById.delete(id)) return null;
    }
  }
  if (delta.groupAdds !== undefined) {
    for (const group of delta.groupAdds) {
      if (!isGroupLike(group) || groupsById.has(group.id)) return null;
      groupsById.set(group.id, { ...group, memberIds: [...group.memberIds] });
    }
  }
  if (delta.groups !== undefined) {
    for (const [id, fields] of Object.entries(delta.groups)) {
      const current = groupsById.get(id);
      if (current === undefined) return null;
      const next = applyFields(asFields(current), fields);
      if (next === null) return null;
      const group = asGroup(next, id);
      if (group === null) return null;
      groupsById.set(id, group);
    }
  }
  let groups = [...groupsById.values()];
  if (delta.groupOrder !== undefined) {
    const ordered = orderById(groups, delta.groupOrder);
    if (ordered === null) return null;
    groups = ordered;
  }

  return { ...document, page, elements, groups };
}
