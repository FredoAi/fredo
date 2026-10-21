/**
 * Page-capture seam (Spec #3070, ST-2, R-4.9 / F-33).
 *
 * Pins the 2x logical-page capture geometry, the chrome hide/restore cycle
 * (including on failure), and the base64 prefix strip. The stage is a duck-typed
 * fake — the registry never imports Konva.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PAGE_EXPORT_PIXEL_RATIO,
  captureWireframePagePng,
  getWireframeStage,
  registerWireframeStage,
  stripPngDataUrl,
  type WireframeCaptureConfig,
  type WireframeCaptureNode,
  type WireframeCaptureStage,
} from '../canvas/wireframeCanvasRegistry';
import { createNewWireframeDocument } from '../model/document';
import {
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
  toDataURL: ReturnType<typeof vi.fn>;
  batchDraw: ReturnType<typeof vi.fn>;
}

function createStage(
  toDataURL: (config?: WireframeCaptureConfig) => string = () =>
    'data:image/png;base64,UE5HQllURVM=',
): FakeStage {
  const chrome = [new FakeNode(true), new FakeNode(false)];
  const toDataURLMock = vi.fn(toDataURL);
  const batchDraw = vi.fn();
  const stage = {
    toDataURL: toDataURLMock,
    find: vi.fn(() => chrome),
    batchDraw,
  } as WireframeCaptureStage;

  return { stage, chrome, toDataURL: toDataURLMock, batchDraw };
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

  it('captures the page rect at 2x the logical page size regardless of zoom', () => {
    const fake = createStage();
    registerWireframeStage(fake.stage);
    setView({ scale: 0.5, x: 40, y: 20 });

    expect(captureWireframePagePng()).toBe('UE5HQllURVM=');

    const call = fake.toDataURL.mock.calls[0]?.[0] as WireframeCaptureConfig;
    expect(call).toMatchObject({
      x: 40,
      y: 20,
      width: 640,
      height: 400,
      pixelRatio: 4,
      mimeType: 'image/png',
    });
    // The rendered bitmap is exactly 2x the logical page.
    expect((call.width ?? 0) * (call.pixelRatio ?? 0)).toBe(2 * 1280);
    expect((call.height ?? 0) * (call.pixelRatio ?? 0)).toBe(2 * 800);
  });

  it('tracks the page size and pan offset through the view transform', () => {
    const fake = createStage();
    registerWireframeStage(fake.stage);
    setView({ scale: 2, x: -120, y: -80 });

    captureWireframePagePng();

    expect(fake.toDataURL.mock.calls[0]?.[0]).toMatchObject({
      x: -120,
      y: -80,
      width: 2560,
      height: 1600,
      pixelRatio: 1,
    });
  });

  it('hides selection chrome during capture and restores it afterwards', () => {
    const chrome = [new FakeNode(true), new FakeNode(false)];
    let visibilityDuringCapture: boolean[] = [];
    const stage = {
      toDataURL: vi.fn(() => {
        visibilityDuringCapture = chrome.map((node) => node.isVisible);
        return 'data:image/png;base64,UE5H';
      }),
      find: vi.fn(() => chrome),
      batchDraw: vi.fn(),
    } as WireframeCaptureStage;
    registerWireframeStage(stage);

    expect(captureWireframePagePng()).toBe('UE5H');

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
    const toDataURL = vi.fn(() => 'data:image/png;base64,QkxBTks=');
    const stage = {
      toDataURL,
      find: vi.fn(() => []),
      batchDraw: vi.fn(),
      getChildren: vi.fn(() => []),
    } as WireframeCaptureStage;
    registerWireframeStage(stage);

    expect(captureWireframePagePng()).toBeNull();
    expect(toDataURL).not.toHaveBeenCalled();
  });

  it('captures when the stage holds at least its Layer', () => {
    const toDataURL = vi.fn(() => 'data:image/png;base64,UE5HQllURVM=');
    const stage = {
      toDataURL,
      find: vi.fn(() => []),
      batchDraw: vi.fn(),
      getChildren: vi.fn(() => [{}]),
    } as WireframeCaptureStage;
    registerWireframeStage(stage);

    expect(captureWireframePagePng()).toBe('UE5HQllURVM=');
    expect(toDataURL).toHaveBeenCalledTimes(1);
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
