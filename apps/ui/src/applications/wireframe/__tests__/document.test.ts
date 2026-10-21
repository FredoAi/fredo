/**
 * Wireframe document model (Spec #3070, ST-1, C1 / R-4.13 parsing seam).
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_WIREFRAME_FILE_NAME,
  WIREFRAME_APP_TAG,
  WIREFRAME_FILE_EXTENSION,
  WIREFRAME_SCHEMA_VERSION,
  WireframeDocumentError,
  createNewWireframeDocument,
  documentBasename,
  documentDisplayName,
  parseWireframeDocument,
  serializeWireframeDocument,
} from '../model/document';
import { PAGE_PRESETS, matchPagePreset, pagePresetDimensions } from '../model/pagePresets';

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
