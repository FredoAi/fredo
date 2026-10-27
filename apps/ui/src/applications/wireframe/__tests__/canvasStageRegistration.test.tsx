/**
 * Capture-stage registration identity (Spec #3070, round 3, ST-2f / F-33).
 *
 * The registry must hold the LIVE Stage, not the instance react-konva created
 * first and then destroyed. `<React.StrictMode>` (the app's dev root) runs the
 * mount layout effects twice: the first Stage instance is destroyed and a new
 * one is created. An effect keyed on `stageReady` snapshots the first instance
 * and never re-runs (it is an *update* effect, not double-invoked), so the
 * export captured a destroyed stage — a transparent, childless canvas.
 *
 * `bindStage` is a ref callback, so react-konva's `_setRef` re-binds the
 * registry on every create/destroy, exactly like the React ref.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { ChakraProvider, createSystem, defaultBaseConfig } from '@chakra-ui/react';

import { WireframeCanvasImpl } from '../components/WireframeCanvasImpl';
import {
  captureWireframePagePng,
  getWireframeStage,
} from '../canvas/wireframeCanvasRegistry';
import { createNewWireframeDocument } from '../model/document';
import {
  loadDocument,
  resetWireframeStoreForTests,
} from '../store/wireframeDocumentStore';

interface StageInstance {
  id: number;
  toDataURL: (config?: unknown) => string;
  find: () => unknown[];
  /** The page group the export captures (F-33); scoped to THIS instance. */
  findOne: (selector: string) => { toDataURL: () => string } | undefined;
  getChildren: () => unknown[];
  batchDraw: () => void;
  width: () => number;
  height: () => number;
  container: () => { style: Record<string, string> };
  captures: number;
}

const konvaMock = vi.hoisted(() => ({
  instances: [] as StageInstance[],
  nextId: 1,
}));

vi.mock('react-konva', async () => {
  const ReactModule = await import('react');

  const Stage = ReactModule.forwardRef(function MockStage(props: any, ref: any) {
    // A NEW object per attach — exactly what react-konva's `_setRef` does when
    // StrictMode destroys and re-creates the Stage.
    ReactModule.useImperativeHandle(ref, () => {
      const instance: StageInstance = {
        id: konvaMock.nextId++,
        toDataURL: () => 'data:image/png;base64,U1RBR0U=',
        find: () => [],
        findOne: () => undefined,
        // A live Stage always holds at least its Layer (Konva `Stage.add`).
        getChildren: () => [{}],
        batchDraw: () => undefined,
        width: () => props.width,
        height: () => props.height,
        container: () => ({ style: {} }),
        captures: 0,
      };
      instance.toDataURL = () => {
        instance.captures += 1;
        return 'data:image/png;base64,U1RBR0U=';
      };
      // The export captures the page group resolved through this instance.
      const page = {
        toDataURL: () => {
          instance.captures += 1;
          return 'data:image/png;base64,U1RBR0U=';
        },
      };
      instance.findOne = (selector: string) =>
        selector === '.wireframe-page' ? page : undefined;
      konvaMock.instances.push(instance);
      return instance;
    });

    return ReactModule.createElement(
      'div',
      {
        'data-testid': 'mock-stage',
        'data-stage-width': props.width,
        'data-stage-height': props.height,
      },
      props.children,
    );
  });

  const Layer = (props: any) =>
    ReactModule.createElement(
      'div',
      { 'data-mock-layer': 'true', 'data-mock-layer-name': props.name ?? '' },
      props.children,
    );

  const Group = ReactModule.forwardRef(function MockGroup(props: any, _ref: any) {
    return ReactModule.createElement('div', { 'data-mock-group': props.name }, props.children);
  });

  const Transformer = ReactModule.forwardRef(function MockTransformer(_props: any, _ref: any) {
    return ReactModule.createElement('div', { 'data-testid': 'mock-transformer' });
  });

  const Shape = (props: any) =>
    ReactModule.createElement('div', {
      'data-mock-shape': 'shape',
      'data-mock-name': props.name ?? '',
      'data-mock-visible': String(props.visible ?? true),
    });

  // The guide `Line`s are driven imperatively through their refs.
  const Line = ReactModule.forwardRef(function MockLine(props: any, _ref: any) {
    return ReactModule.createElement('div', {
      'data-mock-shape': 'line',
      'data-mock-name': props.name ?? '',
    });
  });

  const shape = (tag: string) => (props: any) =>
    ReactModule.createElement('div', {
      'data-mock-shape': tag,
      'data-mock-name': props.name ?? '',
      'data-mock-listening': String(props.listening ?? true),
    });

  return {
    Stage,
    Layer,
    Group,
    Transformer,
    Shape,
    Line,
    Rect: shape('rect'),
    Text: shape('text'),
    Path: shape('path'),
    Circle: shape('circle'),
    Ellipse: shape('ellipse'),
  };
});

const testSystem = createSystem({
  ...defaultBaseConfig,
  disableLayers: true,
  preflight: false,
  globalCss: {},
});

function renderCanvas(): ReturnType<typeof render> {
  return render(
    <React.StrictMode>
      <ChakraProvider value={testSystem}>
        <WireframeCanvasImpl />
      </ChakraProvider>
    </React.StrictMode>,
  );
}

beforeEach(() => {
  resetWireframeStoreForTests();
  konvaMock.instances.length = 0;
  konvaMock.nextId = 1;

  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 900,
    bottom: 640,
    width: 900,
    height: 640,
    toJSON: () => ({}),
  } as DOMRect);

  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private readonly callback: () => void) {}
      observe(): void {
        this.callback();
      }
      unobserve(): void {}
      disconnect(): void {}
    },
  );

  loadDocument(createNewWireframeDocument('desktop'), 'C:/tmp/doc.wireframe.json');
});

afterEach(() => {
  cleanup();
  resetWireframeStoreForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('capture stage registration under StrictMode', () => {
  it('registers the LATEST Stage instance, not the one StrictMode destroyed', () => {
    renderCanvas();

    // StrictMode's dev double-invoke of the mount layout effects destroys the
    // first instance and creates a second one.
    expect(konvaMock.instances.length).toBeGreaterThan(1);
    const first = konvaMock.instances[0];
    const latest = konvaMock.instances[konvaMock.instances.length - 1];
    expect(first.id).not.toBe(latest.id);

    expect(getWireframeStage()).not.toBeNull();
    expect(getWireframeStage()).toBe(latest);
  });

  it('captures through the live instance (never the destroyed one)', () => {
    renderCanvas();

    const encoded = captureWireframePagePng();
    expect(encoded).toBe('U1RBR0U=');

    const latest = konvaMock.instances[konvaMock.instances.length - 1];
    expect(latest.captures).toBe(1);
    expect(konvaMock.instances[0].captures).toBe(0);
  });

  it('clears the registry on unmount', () => {
    const { unmount } = renderCanvas();
    expect(getWireframeStage()).not.toBeNull();

    unmount();

    expect(getWireframeStage()).toBeNull();
    expect(captureWireframePagePng()).toBeNull();
  });
});

describe('guides layer is capture-hidden (Spec #3071, ST-5)', () => {
  it('mounts the guides + snap-grid layer under the capture-hidden name', () => {
    renderCanvas();

    const layer = document.querySelector(
      '[data-mock-layer-name="wireframe-guides wireframe-capture-hidden"]',
    );
    expect(layer).not.toBeNull();
    expect(layer!.querySelector('[data-mock-name="wireframe-snap-grid"]')).not.toBeNull();
  });

  it('keeps the page-capture seam intact with the guides layer mounted', () => {
    renderCanvas();
    expect(captureWireframePagePng()).toBe('U1RBR0U=');
  });
});
