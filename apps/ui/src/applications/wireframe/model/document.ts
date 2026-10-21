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

export interface WireframeDocument {
  schemaVersion: typeof WIREFRAME_SCHEMA_VERSION;
  app: typeof WIREFRAME_APP_TAG;
  page: WireframePage;
  /** Document order = paint order. */
  elements: WireframeElement[];
}

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

  return {
    schemaVersion: WIREFRAME_SCHEMA_VERSION,
    app: WIREFRAME_APP_TAG,
    page: {
      preset: page.preset,
      width: page.width as number,
      height: page.height as number,
    },
    elements: value.elements as WireframeElement[],
  };
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
