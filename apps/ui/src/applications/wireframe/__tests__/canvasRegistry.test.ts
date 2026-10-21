/**
 * Page-capture seam (Spec #3070, ST-2, R-4.9 / F-33).
 *
 * Pins the page-node capture contract: the export is the PAGE at 100 % with a
 * FIXED 2x ratio, so no live-view value (pan offset or zoom) can reach the
 * capture config. Also pins the chrome hide/restore cycle (including on
 * failure), the base64 prefix strip and the not-ready guards. The stage and page
 * are duck-typed fakes — the registry never imports Konva.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PAGE_EXPORT_PIXEL_RATIO,
  WIREFRAME_PAGE_NAME,
  captureWireframePagePng,
  getWireframeStage,
  registerWireframeStage,
  stripPngDataUrl,
  type WireframeCaptureConfig,
  type WireframeCaptureNode,
  type WireframeCapturePage,
  type WireframeCaptureStage,
} from '../canvas/wireframeCanvasRegistry';
import { createNewWireframeDocument } from '../model/document';
import {
  dispatch,
  loadDocument,
  resetWireframeStoreForTests,
  setView,
} from '../store/wireframeDocumentStore';

class FakeNode implements WireframeCaptureNode {
  private value: boolean;

  constructor(initial: boolean) {
    this.value = initial;
  }

  visible(): boolean;
  visible(value: boolean): unknown;
  visible(value?: boolean): boolean | unknown {
    if (value === undefined) return this.value;
    this.value = value;
    return this;
  }

  get isVisible(): boolean {
    return this.value;
  }
}

interface FakeStage {
  stage: WireframeCaptureStage;
  chrome: FakeNode[];
  pageNode: WireframeCapturePage;
  pageToDataURL: ReturnType<typeof vi.fn>;
  stageToDataURL: ReturnType<typeof vi.fn>;
  batchDraw: ReturnType<typeof vi.fn>;
}

const PNG_BASE64 = 'UE5HQllURVM=';

function createPage(
  toDataURL: (config?: WireframeCaptureConfig) => string = () =>
    `data:image/png;base64,${PNG_BASE64}`,
): { pageNode: WireframeCapturePage; pageToDataURL: ReturnType<typeof vi.fn> } {
  const pageToDataURL = vi.fn(toDataURL);
  return { pageNode: { toDataURL: pageToDataURL }, pageToDataURL };
}

function createStage(toDataURL?: (config?: WireframeCaptureConfig) => string): FakeStage {
  const chrome = [new FakeNode(true), new FakeNode(false)];
  const { pageNode, pageToDataURL } = createPage(toDataURL);
  const stageToDataURL = vi.fn(() => 'data:image/png;base64,U1RBR0U=');
  const batchDraw = vi.fn();
  const stage = {
    toDataURL: stageToDataURL,
    find: vi.fn(() => chrome),
    findOne: vi.fn((selector: string) =>
      selector === `.${WIREFRAME_PAGE_NAME}` ? pageNode : undefined,
    ),
    batchDraw,
    getChildren: vi.fn(() => [{}]),
  } as WireframeCaptureStage;

  return { stage, chrome, pageNode, pageToDataURL, stageToDataURL, batchDraw };
}

beforeEach(() => {
  resetWireframeStoreForTests();
  loadDocument(createNewWireframeDocument('desktop'), 'C:/tmp/doc.wireframe.json');
});

afterEach(() => {
  registerWireframeStage(null);
  resetWireframeStoreForTests();
  vi.restoreAllMocks();
});

describe('captureWireframePagePng', () => {
  it('returns null when no stage is registered', () => {
    expect(captureWireframePagePng()).toBeNull();
  });

  it('exposes the 2x export pixel ratio', () => {
    expect(PAGE_EXPORT_PIXEL_RATIO).toBe(2);
  });

  it('captures the PAGE node at identity + ratio 2, never the stage or the live view', () => {
    const fake = createStage();
    registerWireframeStage(fake.stage);
    // 400 % panned — the configuration that used to crop the export (F-33).
    setView({ scale: 4, x: -300, y: -200 });

    expect(captureWireframePagePng()).toBe(PNG_BASE64);

    expect(fake.stage.findOne).toHaveBeenCalledWith(`.${WIREFRAME_PAGE_NAME}`);
    expect(fake.pageToDataURL).toHaveBeenCalledTimes(1);
    expect(fake.stageToDataURL).not.toHaveBeenCalled();

    const config = fake.pageToDataURL.mock.calls[0]?.[0] as WireframeCaptureConfig;
    // Page-space origin and logical page dimensions: the 100 % rendering.
    expect(config).toEqual({
      x: 0,
      y: 0,
      width: 1280,
      height: 800,
      pixelRatio: PAGE_EXPORT_PIXEL_RATIO,
      mimeType: 'image/png',
    });
    // No live-view value may survive into the capture config.
    expect(config).not.toMatchObject({ x: -300, y: -200 });
    expect(config.width).not.toBe(1280 * 4);
    expect(config.height).not.toBe(800 * 4);
    expect(config.pixelRatio).toBe(2);
  });

  it('captures the current page dimensions at ratio 2 regardless of zoom', () => {
    const fake = createStage();
    registerWireframeStage(fake.stage);
    dispatch('page.update', { page: { preset: 'phone' } });
    setView({ scale: 0.5, x: 40, y: 20 });

    expect(captureWireframePagePng()).toBe(PNG_BASE64);

    expect(fake.pageToDataURL.mock.calls[0]?.[0]).toEqual({
      x: 0,
      y: 0,
      width: 390,
      height: 844,
      pixelRatio: 2,
      mimeType: 'image/png',
    });
  });

  it('returns null when the page group is missing (not-ready banner, never a blank PNG)', () => {
    const stageToDataURL = vi.fn(() => 'data:image/png;base64,U1RBR0U=');
    const stage = {
      toDataURL: stageToDataURL,
      find: vi.fn(() => []),
      findOne: vi.fn(() => undefined),
      batchDraw: vi.fn(),
      getChildren: vi.fn(() => [{}]),
    } as WireframeCaptureStage;
    registerWireframeStage(stage);

    expect(captureWireframePagePng()).toBeNull();
    expect(stageToDataURL).not.toHaveBeenCalled();
  });

  it('returns null for a stage that cannot resolve nodes', () => {
    const stageToDataURL = vi.fn(() => 'data:image/png;base64,U1RBR0U=');
    const stage = {
      toDataURL: stageToDataURL,
      find: vi.fn(() => []),
      batchDraw: vi.fn(),
      getChildren: vi.fn(() => [{}]),
    } as WireframeCaptureStage;
    registerWireframeStage(stage);

    expect(captureWireframePagePng()).toBeNull();
    expect(stageToDataURL).not.toHaveBeenCalled();
  });

  it('hides selection chrome during capture and restores it afterwards', () => {
    const chrome = [new FakeNode(true), new FakeNode(false)];
    let visibilityDuringCapture: boolean[] = [];
    const { pageNode } = createPage(() => {
      visibilityDuringCapture = chrome.map((node) => node.isVisible);
      return `data:image/png;base64,${PNG_BASE64}`;
    });
    const stage = {
      toDataURL: vi.fn(() => 'data:image/png;base64,U1RBR0U='),
      find: vi.fn(() => chrome),
      findOne: vi.fn(() => pageNode),
      batchDraw: vi.fn(),
      getChildren: vi.fn(() => [{}]),
    } as WireframeCaptureStage;
    registerWireframeStage(stage);

    expect(captureWireframePagePng()).toBe(PNG_BASE64);

    expect(stage.find).toHaveBeenCalledWith('.wireframe-capture-hidden');
    expect(visibilityDuringCapture).toEqual([false, false]);
    expect(chrome.map((node) => node.isVisible)).toEqual([true, false]);
    expect(stage.batchDraw).toHaveBeenCalledTimes(1);
  });

  it('restores chrome even when the capture throws', () => {
    const fake = createStage(() => {
      throw new Error('canvas unavailable');
    });
    registerWireframeStage(fake.stage);

    expect(() => captureWireframePagePng()).toThrow('canvas unavailable');
    expect(fake.chrome.map((node) => node.isVisible)).toEqual([true, false]);
    expect(fake.batchDraw).toHaveBeenCalledTimes(1);
  });

  it('refuses to emit a blank capture for a stage with no children', () => {
    // A destroyed (or never-mounted) Stage has no Layer at all: Konva's
    // `_toKonvaCanvas` then returns an untouched canvas — a transparent bitmap
    // at the requested size (F-33). The registry must refuse it.
    const { pageNode, pageToDataURL } = createPage();
    const stage = {
      toDataURL: vi.fn(() => 'data:image/png;base64,QkxBTks='),
      find: vi.fn(() => []),
      findOne: vi.fn(() => pageNode),
      batchDraw: vi.fn(),
      getChildren: vi.fn(() => []),
    } as WireframeCaptureStage;
    registerWireframeStage(stage);

    expect(captureWireframePagePng()).toBeNull();
    expect(pageToDataURL).not.toHaveBeenCalled();
  });

  it('registers and clears the stage', () => {
    const fake = createStage();
    registerWireframeStage(fake.stage);
    expect(getWireframeStage()).toBe(fake.stage);
    registerWireframeStage(null);
    expect(getWireframeStage()).toBeNull();
  });
});

describe('stripPngDataUrl', () => {
  it('strips the base64 prefix', () => {
    expect(stripPngDataUrl('data:image/png;base64,QUJD')).toBe('QUJD');
  });

  it('returns null for a non-data URL', () => {
    expect(stripPngDataUrl('not-a-data-url')).toBeNull();
  });
});
