/**
 * Wireframe document model (Spec #3070, ST-1, C1 / R-4.13 parsing seam;
 * Spec #3071, ST-1 — groups round-trip + reconciliation R-3.3).
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_WIREFRAME_FILE_NAME,
  WIREFRAME_APP_TAG,
  WIREFRAME_FILE_EXTENSION,
  WIREFRAME_GROUP_MIN_MEMBERS,
  WIREFRAME_SCHEMA_VERSION,
  WireframeDocumentError,
  createNewWireframeDocument,
  documentBasename,
  documentDisplayName,
  groupOfElement,
  isElementMovable,
  isWholeGroupSelection,
  parseWireframeDocument,
  reconcileDocumentGroups,
  serializeWireframeDocument,
  type WireframeDocument,
  type WireframeGroup,
} from '../model/document';
import { createDefaultElement } from '../model/elements';
import { PAGE_PRESETS, matchPagePreset, pagePresetDimensions } from '../model/pagePresets';

/** A minimal text element with the declared id. */
function textElement(id: string) {
  return createDefaultElement('text', {
    page: { preset: 'desktop', width: 1280, height: 800 },
    elements: [],
    id,
  });
}

/** A document with the given element ids and groups (no file I/O). */
function documentWith(ids: readonly string[], groups: WireframeGroup[] = []): WireframeDocument {
  const base = createNewWireframeDocument('desktop');
  return { ...base, elements: ids.map(textElement), groups };
}

describe('constants', () => {
  it('declares the binding schema + file identity', () => {
    expect(WIREFRAME_SCHEMA_VERSION).toBe(1);
    expect(WIREFRAME_APP_TAG).toBe('fredo.wireframe');
    expect(WIREFRAME_FILE_EXTENSION).toBe('wireframe.json');
    expect(DEFAULT_WIREFRAME_FILE_NAME).toBe('untitled.wireframe.json');
  });
});

describe('page presets', () => {
  it('declares desktop 1280x800, tablet 768x1024, phone 390x844', () => {
    expect(pagePresetDimensions('desktop')).toEqual({ width: 1280, height: 800 });
    expect(pagePresetDimensions('tablet')).toEqual({ width: 768, height: 1024 });
    expect(pagePresetDimensions('phone')).toEqual({ width: 390, height: 844 });
    expect(PAGE_PRESETS.phone).toEqual({ width: 390, height: 844 });
  });

  it('matches exact dimensions to a named preset, else null', () => {
    expect(matchPagePreset(1280, 800)).toBe('desktop');
    expect(matchPagePreset(768, 1024)).toBe('tablet');
    expect(matchPagePreset(390, 844)).toBe('phone');
    expect(matchPagePreset(640, 480)).toBeNull();
  });
});

describe('new document', () => {
  it('starts empty on the desktop page', () => {
    const document = createNewWireframeDocument();
    expect(document.schemaVersion).toBe(1);
    expect(document.app).toBe('fredo.wireframe');
    expect(document.page).toEqual({ preset: 'desktop', width: 1280, height: 800 });
    expect(document.elements).toEqual([]);
    expect(document.groups).toEqual([]);
  });

  it('can start on another preset', () => {
    expect(createNewWireframeDocument('phone').page).toEqual({
      preset: 'phone',
      width: 390,
      height: 844,
    });
  });
});

describe('serialize + parse round trip', () => {
  it('restores the identical document', () => {
    const document = createNewWireframeDocument('tablet');
    document.elements.push({
      id: 'element-1',
      type: 'text',
      x: 10,
      y: 20,
      width: 320,
      height: 48,
      visible: true,
      locked: false,
      text: 'Hello',
      textStyle: 'heading',
      size: 'l',
      align: 'center',
    });

    const restored = parseWireframeDocument(serializeWireframeDocument(document));
    expect(restored).toEqual(document);
  });

  it('rejects unreadable JSON', () => {
    expect(() => parseWireframeDocument('{ not json')).toThrow(WireframeDocumentError);
    expect(() => parseWireframeDocument('{ not json')).toThrow(/not readable JSON/);
  });

  it('rejects a foreign app tag', () => {
    const document = createNewWireframeDocument() as unknown as Record<string, unknown>;
    document.app = 'other.app';
    expect(() => parseWireframeDocument(JSON.stringify(document))).toThrow(/app tag "other\.app"/);
  });

  it('rejects an unknown or missing schemaVersion', () => {
    const v2 = { ...createNewWireframeDocument(), schemaVersion: 2 };
    expect(() => parseWireframeDocument(JSON.stringify(v2))).toThrow(/version "2"/);

    const missing = { ...createNewWireframeDocument() } as Record<string, unknown>;
    delete missing.schemaVersion;
    expect(() => parseWireframeDocument(JSON.stringify(missing))).toThrow(
      /version "undefined"/,
    );

    const asString = { ...createNewWireframeDocument(), schemaVersion: '1' };
    expect(() => parseWireframeDocument(JSON.stringify(asString))).toThrow(/version "1"/);
  });

  it('rejects a malformed page or elements list', () => {
    const noPage = { ...createNewWireframeDocument() } as Record<string, unknown>;
    delete noPage.page;
    expect(() => parseWireframeDocument(JSON.stringify(noPage))).toThrow(/missing page/);

    const noElements = { ...createNewWireframeDocument() } as Record<string, unknown>;
    delete noElements.elements;
    expect(() => parseWireframeDocument(JSON.stringify(noElements))).toThrow(
      /missing elements/,
    );
  });
});

describe('document names', () => {
  it('reads the last segment of Windows and POSIX paths', () => {
    expect(documentBasename('C:\\docs\\home.wireframe.json')).toBe('home.wireframe.json');
    expect(documentBasename('/home/me/home.wireframe.json')).toBe('home.wireframe.json');
    expect(documentBasename('bare.wireframe.json')).toBe('bare.wireframe.json');
    expect(documentBasename(null)).toBe('');
  });

  it('falls back to the untitled default', () => {
    expect(documentDisplayName(null)).toBe(DEFAULT_WIREFRAME_FILE_NAME);
    expect(documentDisplayName('C:\\docs\\home.wireframe.json')).toBe('home.wireframe.json');
  });
});

describe('groups (Spec #3071, R-3.2 / R-3.3)', () => {
  it('declares the group minimum membership', () => {
    expect(WIREFRAME_GROUP_MIN_MEMBERS).toBe(1);
  });

  it('round-trips groups (id, membership, lock) through save + parse', () => {
    const document = documentWith(['a', 'b', 'c'], [
      { id: 'g1', memberIds: ['a', 'b'], locked: true },
      { id: 'g2', memberIds: ['c'], locked: false },
    ]);

    const restored = parseWireframeDocument(serializeWireframeDocument(document));
    expect(restored.groups).toEqual([
      { id: 'g1', memberIds: ['a', 'b'], locked: true },
      { id: 'g2', memberIds: ['c'], locked: false },
    ]);
    expect(restored).toEqual(document);
  });

  it('parses a Slice-1 file with no groups key to groups: []', () => {
    const legacy = JSON.parse(JSON.stringify(documentWith(['a']))) as Record<string, unknown>;
    delete legacy.groups;

    const restored = parseWireframeDocument(JSON.stringify(legacy));
    expect(restored.groups).toEqual([]);
  });

  it('drops dangling memberIds and removes a group only when it empties', () => {
    const payload = {
      ...documentWith(['a', 'b', 'c']),
      groups: [
        { id: 'g1', memberIds: ['a', 'missing'], locked: false },
        { id: 'g2', memberIds: ['gone'], locked: true },
        { id: 'g3', memberIds: ['b', 'c'], locked: true },
      ],
    };

    const restored = parseWireframeDocument(JSON.stringify(payload));
    expect(restored.groups).toEqual([
      { id: 'g1', memberIds: ['a'], locked: false },
      { id: 'g3', memberIds: ['b', 'c'], locked: true },
    ]);
  });

  it('keeps a duplicated memberId in the FIRST group only', () => {
    const payload = {
      ...documentWith(['a']),
      groups: [
        { id: 'g1', memberIds: ['a'], locked: false },
        { id: 'g2', memberIds: ['a'], locked: false },
      ],
    };

    const restored = parseWireframeDocument(JSON.stringify(payload));
    expect(restored.groups).toEqual([{ id: 'g1', memberIds: ['a'], locked: false }]);
  });

  it('rejects a structurally malformed group entry', () => {
    const base = documentWith(['a']);
    const malformed: unknown[] = [
      { id: 1, memberIds: ['a'], locked: false },
      { id: 'g', memberIds: 'a', locked: false },
      { id: 'g', memberIds: [1], locked: false },
      { id: 'g', memberIds: ['a'], locked: 'yes' },
      null,
      'group',
    ];
    for (const group of malformed) {
      expect(() =>
        parseWireframeDocument(JSON.stringify({ ...base, groups: [group] })),
      ).toThrow(WireframeDocumentError);
    }
  });

  it('rejects groups that are present but not an array', () => {
    expect(() =>
      parseWireframeDocument(JSON.stringify({ ...documentWith(['a']), groups: {} })),
    ).toThrow(/invalid groups/);
  });
});

describe('group helpers', () => {
  const document = documentWith(['a', 'b', 'c', 'd'], [
    { id: 'g1', memberIds: ['a', 'b'], locked: true },
    { id: 'g2', memberIds: ['c'], locked: false },
  ]);

  it('groupOfElement finds the owning group, or null', () => {
    expect(groupOfElement(document, 'a')?.id).toBe('g1');
    expect(groupOfElement(document, 'c')?.id).toBe('g2');
    expect(groupOfElement(document, 'd')).toBeNull();
  });

  it('isElementMovable is false for a locked element or a locked group', () => {
    const [a, b, c, d] = document.elements;
    expect(isElementMovable(document, a)).toBe(false); // group g1 is locked
    expect(isElementMovable(document, b)).toBe(false);
    expect(isElementMovable(document, c)).toBe(true); // group g2 is unlocked
    expect(isElementMovable(document, d)).toBe(true); // ungrouped
    expect(isElementMovable(document, { ...d, locked: true })).toBe(false);
  });

  it('isWholeGroupSelection is true only for a complete single group', () => {
    expect(isWholeGroupSelection(document, [])).toBe(false);
    expect(isWholeGroupSelection(document, ['a'])).toBe(false); // partial
    expect(isWholeGroupSelection(document, ['a', 'b'])).toBe(true);
    expect(isWholeGroupSelection(document, ['b', 'a'])).toBe(true);
    expect(isWholeGroupSelection(document, ['a', 'c'])).toBe(false); // two groups
    expect(isWholeGroupSelection(document, ['a', 'b', 'c'])).toBe(false);
  });

  it('reconcileDocumentGroups is idempotent', () => {
    const once = reconcileDocumentGroups(document);
    expect(reconcileDocumentGroups(once)).toEqual(once);
    expect(once.groups).toEqual(document.groups);
  });
});

