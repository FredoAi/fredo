/**
 * Wireframe document model (Spec #3070, ST-1, C1).
 *
 * The document is the saved unit. It carries a version tag, the app tag and
 * the page; document order of `elements` is paint order. Nothing here touches
 * the RTDB row pipeline or telemetry — the wireframe is document state.
 */

import type { WireframeElement } from './elements';
import { WIREFRAME_ELEMENT_TYPES } from './elements';
import type { WireframePagePreset } from './pagePresets';
import { DEFAULT_PAGE_PRESET, createPage } from './pagePresets';

/** Binding app identity (C9). */
export const WIREFRAME_APP_ID = 'wireframe';

export const WIREFRAME_SCHEMA_VERSION = 1;
export const WIREFRAME_APP_TAG = 'fredo.wireframe';
export const WIREFRAME_FILE_EXTENSION = 'wireframe.json';
export const DEFAULT_WIREFRAME_FILE_NAME = 'untitled.wireframe.json';

export interface WireframePage {
  preset: WireframePagePreset;
  width: number;
  height: number;
}

/**
 * A group of elements (Spec #3071, ST-1).
 *
 * Membership lives ONLY in `memberIds` — there is NO `groupId` back-pointer on
 * an element (single source of truth) and groups never nest. The order of
 * `memberIds` is preserved; a group is always non-empty in memory
 * (`WIREFRAME_GROUP_MIN_MEMBERS`).
 */
export interface WireframeGroup {
  /** `crypto.randomUUID()` (mirrors `createElementId`). */
  id: string;
  /** Element ids; every id resolves to an element in `elements`. */
  memberIds: string[];
  /** Group lock — covers position + size only (R-1.10). */
  locked: boolean;
}

export interface WireframeDocument {
  schemaVersion: typeof WIREFRAME_SCHEMA_VERSION;
  app: typeof WIREFRAME_APP_TAG;
  page: WireframePage;
  /** Document order = paint order. */
  elements: WireframeElement[];
  /**
   * Groups (Spec #3071). Additive and optional on the wire: a Slice-1 file with
   * no `groups` key parses to `[]`, and `schemaVersion` stays `1`.
   */
  groups: WireframeGroup[];
}

/** A group with fewer members than this does not exist (R-1.9 / R-3.3). */
export const WIREFRAME_GROUP_MIN_MEMBERS = 1;

/** A rejected document read (R-4.13). The message is user-readable. */
export class WireframeDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WireframeDocumentError';
  }
}

/** A fresh, empty document on the requested page preset. */
export function createNewWireframeDocument(
  preset: WireframePagePreset = DEFAULT_PAGE_PRESET,
): WireframeDocument {
  const namedPreset = preset === 'custom' ? DEFAULT_PAGE_PRESET : preset;
  return {
    schemaVersion: WIREFRAME_SCHEMA_VERSION,
    app: WIREFRAME_APP_TAG,
    page: createPage(namedPreset),
    elements: [],
    groups: [],
  };
}

/** Serialise a document for `wireframe_save_as` (ST-6). */
export function serializeWireframeDocument(document: WireframeDocument): string {
  return JSON.stringify(document, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPagePreset(value: unknown): value is WireframePagePreset {
  return value === 'desktop' || value === 'tablet' || value === 'phone' || value === 'custom';
}

/** The group an element belongs to, or `null` when it is ungrouped. */
export function groupOfElement(
  document: WireframeDocument,
  elementId: string,
): WireframeGroup | null {
  return document.groups.find((group) => group.memberIds.includes(elementId)) ?? null;
}

/**
 * True when an element may be moved or resized (R-1.8 / R-2.8): it is not
 * individually locked AND its group (if any) is not locked. Lock covers position
 * and size only — a locked element is still reorderable and still deletable.
 */
export function isElementMovable(
  document: WireframeDocument,
  element: WireframeElement,
): boolean {
  if (element.locked) return false;
  return !(groupOfElement(document, element.id)?.locked ?? false);
}

/**
 * True when `ids` is exactly the complete membership of ONE existing group
 * (R-1.9 / UI/UX B4): non-empty, every id resolves to the same group, and that
 * group's member set equals the id set. Drives the `group` no-op and the
 * group control's disabled rule.
 */
export function isWholeGroupSelection(
  document: WireframeDocument,
  ids: readonly string[],
): boolean {
  if (ids.length === 0) return false;
  const group = groupOfElement(document, ids[0]);
  if (!group) return false;
  if (group.memberIds.length !== new Set(ids).size) return false;
  const selected = new Set(ids);
  for (const memberId of group.memberIds) {
    if (!selected.has(memberId)) return false;
  }
  for (const id of ids) {
    if (groupOfElement(document, id)?.id !== group.id) return false;
  }
  return true;
}

/**
 * The ONE place the group invariant is (re)established (R-3.3): every
 * `memberId` resolves to an element, no group is empty, and no element is in
 * two groups. Dangling ids are dropped; a group that empties is removed
 * (`WIREFRAME_GROUP_MIN_MEMBERS`); on a duplicate membership the FIRST group in
 * document order keeps the id. Every survivor's `id`/order/`locked` is
 * preserved. Called by `parseWireframeDocument` and by the store's group
 * mutations.
 */
export function reconcileDocumentGroups(document: WireframeDocument): WireframeDocument {
  const elementIds = new Set(document.elements.map((element) => element.id));
  const claimed = new Set<string>();
  const groups: WireframeGroup[] = [];
  for (const group of document.groups) {
    const memberIds: string[] = [];
    for (const memberId of group.memberIds) {
      if (!elementIds.has(memberId)) continue;
      if (claimed.has(memberId)) continue;
      claimed.add(memberId);
      memberIds.push(memberId);
    }
    if (memberIds.length < WIREFRAME_GROUP_MIN_MEMBERS) continue;
    groups.push({ id: group.id, memberIds, locked: group.locked });
  }
  return { ...document, groups };
}

/**
 * Parse + validate the saved unit (R-4.13). Rejects unreadable JSON, a foreign
 * `app` tag and an unknown/missing `schemaVersion` with a named problem. The
 * caller (ST-6) surfaces the message; no page is changed on rejection.
 */
export function parseWireframeDocument(contents: string): WireframeDocument {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new WireframeDocumentError(
      'This file is not readable JSON. Nothing changed.',
    );
  }

  if (!isRecord(value)) {
    throw new WireframeDocumentError(
      "This file isn't a Wireframe document. Nothing changed.",
    );
  }

  if (value.app !== WIREFRAME_APP_TAG) {
    throw new WireframeDocumentError(
      `This file isn't a Wireframe document (app tag "${String(value.app)}"). Nothing changed.`,
    );
  }

  if (value.schemaVersion !== WIREFRAME_SCHEMA_VERSION) {
    throw new WireframeDocumentError(
      `Unsupported Wireframe document version "${String(
        value.schemaVersion,
      )}". Nothing changed.`,
    );
  }

  if (!isRecord(value.page)) {
    throw new WireframeDocumentError(
      "This file isn't a Wireframe document (missing page). Nothing changed.",
    );
  }

  const { page } = value;
  if (
    typeof page.width !== 'number' ||
    !Number.isFinite(page.width) ||
    typeof page.height !== 'number' ||
    !Number.isFinite(page.height) ||
    !isPagePreset(page.preset)
  ) {
    throw new WireframeDocumentError(
      "This file isn't a Wireframe document (invalid page). Nothing changed.",
    );
  }

  if (!Array.isArray(value.elements)) {
    throw new WireframeDocumentError(
      "This file isn't a Wireframe document (missing elements). Nothing changed.",
    );
  }

  for (const element of value.elements) {
    if (
      !isRecord(element) ||
      typeof element.id !== 'string' ||
      !WIREFRAME_ELEMENT_TYPES.includes(element.type as (typeof WIREFRAME_ELEMENT_TYPES)[number])
    ) {
      throw new WireframeDocumentError(
        "This file isn't a Wireframe document (invalid element). Nothing changed.",
      );
    }
  }

  // `groups` is optional on the wire (a Slice-1 file parses to `[]`). A
  // structurally malformed entry rejects the document (R-3.3); dangling
  // memberIds are reconciled afterwards.
  const groups: WireframeGroup[] = [];
  if (value.groups !== undefined) {
    if (!Array.isArray(value.groups)) {
      throw new WireframeDocumentError(
        "This file isn't a Wireframe document (invalid groups). Nothing changed.",
      );
    }
    for (const group of value.groups) {
      if (
        !isRecord(group) ||
        typeof group.id !== 'string' ||
        !Array.isArray(group.memberIds) ||
        !group.memberIds.every((memberId) => typeof memberId === 'string') ||
        typeof group.locked !== 'boolean'
      ) {
        throw new WireframeDocumentError(
          "This file isn't a Wireframe document (invalid group). Nothing changed.",
        );
      }
      groups.push({
        id: group.id,
        memberIds: group.memberIds as string[],
        locked: group.locked,
      });
    }
  }

  return reconcileDocumentGroups({
    schemaVersion: WIREFRAME_SCHEMA_VERSION,
    app: WIREFRAME_APP_TAG,
    page: {
      preset: page.preset,
      width: page.width as number,
      height: page.height as number,
    },
    elements: value.elements as WireframeElement[],
    groups,
  });
}

/** Last path segment of a Windows or POSIX path (`''` for a bare name). */
export function documentBasename(path: string | null): string {
  if (!path) return '';
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
}

/** Status-bar document name: the file basename or the untitled default. */
export function documentDisplayName(path: string | null): string {
  return documentBasename(path) || DEFAULT_WIREFRAME_FILE_NAME;
}
