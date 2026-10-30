/**
 * Canvas create operator (Spec #3098, ST-4).
 *
 * The app-side pointer operator: while the ACTIVE command mode declares
 * `operator === WIREFRAME_CREATE_OPERATOR`, the Konva Stage captures
 * pointerdown → pointermove* → pointerup, converts stage → page through the LIVE
 * view transform, normalizes + clamps the dragged rect, enforces
 * `ELEMENT_MIN_SIZE` on both axes and commits exactly ONE `element.add` on
 * release (auto-selected, mode back to Select). Below the minimum it creates
 * nothing and stays in the draw mode.
 *
 * Konva is mocked with the same harness shape as `WireframeCanvas.test.tsx`
 * (inert divs + a module-scoped registry), extended with the Stage's pointer
 * props and `getPointerPosition()`. The REAL React component, the REAL
 * command-surface store and the REAL document store are driven.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { resetHotkeyAnnouncer } from '@/shared/hotkeys/announcer';
import { WireframeCanvasImpl } from '../components/WireframeCanvasImpl';
import { WireframeNavigationProvider } from '../components/WireframeNavigationProvider';
import {
  getSnapshot,
  resetWireframeStoreForTests,
  setPanMode,
  setView,
  subscribe,
  undo,
} from '../store/wireframeDocumentStore';
import {
  beginWireframeShapeCreate,
  clearArmedWireframeShape,
  getArmedWireframeShape,
  resetWireframeSurfaceForTests,
} from '../wireframeSurface';
// Side effect: the application must be registered (exactly as the eager
// `allApplications` barrel does in the app).
import '../index';

const konvaMock = vi.hoisted(() => ({
  /** The Stage props of the LAST render (pointer handlers live here). */
  stageProps: null as null | Record<string, any>,
  /** Konva's stage-relative pointer position driven by the tests. */
  pointer: { x: 0, y: 0 },
}));

interface FakeStage {
  getPointerPosition: () => { x: number; y: number };
  getStage: () => FakeStage;
}

/** The fake `Konva.Stage` the pointer events carry. */
const fakeStage: FakeStage = {
  getPointerPosition: () => ({ x: konvaMock.pointer.x, y: konvaMock.pointer.y }),
  getStage: () => fakeStage,
};

vi.mock('react-konva', async () => {
  const React = await import('react');

  const makeNode = (initial: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    visible?: boolean;
    points?: number[];
  }) => {
    const attrs: Record<string, any> = {
      x: initial.x ?? 0,
      y: initial.y ?? 0,
      width: initial.width ?? 0,
      height: initial.height ?? 0,
      scaleX: 1,
      scaleY: 1,
      visible: initial.visible ?? true,
      points: initial.points ?? [],
    };
    const node: Record<string, any> = {
      attrs,
      getLayer: () => ({ batchDraw: () => undefined }),
      getStage: () => node,
      forceUpdate: () => undefined,
    };
    for (const key of ['x', 'y', 'width', 'height', 'scaleX', 'scaleY', 'visible', 'points']) {
      node[key] = (value?: unknown) => {
        if (value === undefined) return attrs[key];
        attrs[key] = value;
        return node;
      };
    }
    return node;
  };

  const Stage = React.forwardRef(function MockStage(props: any, ref: any) {
    konvaMock.stageProps = props;

    React.useImperativeHandle(ref, () => ({
      toDataURL: () => 'data:image/png;base64,U1RBR0U=',
      find: () => [],
      width: () => props.width,
      height: () => props.height,
      container: () => ({ style: {} }),
      getPointerPosition: () => ({
        x: konvaMock.pointer.x,
        y: konvaMock.pointer.y,
      }),
    }));

    return React.createElement(
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
    React.createElement(
      'div',
      {
        'data-mock-layer': 'true',
        'data-mock-layer-name': props.name ?? '',
        'data-mock-listening': String(props.listening ?? true),
      },
      props.children,
    );

  const Group = React.forwardRef(function MockGroup(props: any, ref: any) {
    const node = React.useMemo(
      () =>
        makeNode({
          x: props.x,
          y: props.y,
          width: props.width,
          height: props.height,
          visible: props.visible,
        }),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [],
    );
    React.useImperativeHandle(ref, () => node, [node]);

    return React.createElement(
      'div',
      {
        'data-mock-group': props.name ?? 'group',
        'data-visible': String(props.visible ?? true),
        'data-draggable': String(props.draggable ?? false),
        'data-mock-x': props.x === undefined ? '' : String(props.x),
        'data-mock-y': props.y === undefined ? '' : String(props.y),
        'data-mock-scale-x': props.scaleX === undefined ? '' : String(props.scaleX),
        'data-mock-scale-y': props.scaleY === undefined ? '' : String(props.scaleY),
      },
      props.children,
    );
  });

  const Transformer = React.forwardRef(function MockTransformer(_props: any, ref: any) {
    const api = {
      nodes: () => [],
      getLayer: () => ({ batchDraw: () => undefined }),
      forceUpdate: () => undefined,
    };
    React.useImperativeHandle(ref, () => api, [api]);
    return React.createElement('div', { 'data-testid': 'mock-transformer' });
  });

  const Line = React.forwardRef(function MockLine(props: any, ref: any) {
    const node = React.useMemo(
      () => makeNode({ points: props.points, visible: props.visible }),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [],
    );
    React.useImperativeHandle(ref, () => node, [node]);
    return React.createElement('div', {
      'data-mock-shape': 'line',
      'data-mock-name': props.name ?? '',
    });
  });

  const Shape = (props: any) =>
    React.createElement('div', { 'data-mock-shape': 'shape', 'data-mock-name': props.name ?? '' });

  const shape = (tag: string) => (props: any) =>
    React.createElement(
      'div',
      {
        'data-mock-shape': tag,
        'data-mock-fill': props.fill ?? '',
        'data-mock-name': props.name ?? '',
        'data-mock-width': props.width === undefined ? '' : String(props.width),
        'data-mock-height': props.height === undefined ? '' : String(props.height),
      },
      typeof props.text === 'string' ? props.text : null,
    );

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

const paletteVariables: Record<string, string> = {
  '--card-bg': 'token-surface',
  '--card-hover-bg': 'token-muted',
  '--border-color': 'token-border',
  '--text-primary': 'token-text',
  '--text-secondary': 'token-text-muted',
  '--accent-primary': 'token-accent',
  '--status-success': 'token-success',
  '--status-warning': 'token-warning',
  '--status-error': 'token-error',
  '--status-info': 'token-info',
  '--accent-contrast': 'token-on-accent',
  '--accent-strong': 'token-focus-ring',
};

function installComputedStyleStub(): void {
  const original = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation(
    ((element: Element, pseudo?: string | null) => {
      const real = original(element, pseudo ?? undefined);
      if (element !== document.documentElement) return real;
      return new Proxy(real, {
        get(target, property, receiver) {
          if (property === 'getPropertyValue') {
            return (name: string) => paletteVariables[name] ?? '';
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as CSSStyleDeclaration;
    }) as typeof window.getComputedStyle,
  );
}

// ── Gesture drivers (Konva's real event shape) ───────────────────────────────

function pointerEvent(button = 0) {
  return {
    type: 'pointerdown',
    evt: { button },
    target: fakeStage,
    currentTarget: fakeStage,
    pointerId: 1,
    cancelBubble: false,
  } as any;
}

function stageProps(): Record<string, any> {
  if (konvaMock.stageProps === null) throw new Error('stage not rendered');
  return konvaMock.stageProps;
}

function pointerDown(x: number, y: number, button = 0): void {
  konvaMock.pointer.x = x;
  konvaMock.pointer.y = y;
  act(() => {
    stageProps().onPointerDown(pointerEvent(button));
  });
}

function pointerMove(x: number, y: number): void {
  konvaMock.pointer.x = x;
  konvaMock.pointer.y = y;
  act(() => {
    stageProps().onPointerMove(pointerEvent());
  });
}

function pointerUp(x: number, y: number): void {
  konvaMock.pointer.x = x;
  konvaMock.pointer.y = y;
  act(() => {
    stageProps().onPointerUp(pointerEvent());
  });
}

/** Konva fires `click` on the Stage right after the release of a plain drag. */
function stageClick(): void {
  act(() => {
    stageProps().onClick({ target: fakeStage, currentTarget: fakeStage });
  });
}

/** Down → move → move → up (+ the Stage click Konva emits on release). */
function dragCreate(
  from: { x: number; y: number },
  to: { x: number; y: number },
  options: { click?: boolean } = {},
): void {
  pointerDown(from.x, from.y);
  pointerMove(from.x + (to.x - from.x) / 2, from.y + (to.y - from.y) / 2);
  pointerMove(to.x, to.y);
  pointerUp(to.x, to.y);
  if (options.click !== false) stageClick();
}

function commitCountDuring(run: () => void): number {
  let commits = 0;
  const unsubscribe = subscribe(() => {
    commits += 1;
  });
  try {
    run();
  } finally {
    unsubscribe();
  }
  return commits;
}

function armedKind(): 'rect' | 'ellipse' | null {
  return getArmedWireframeShape();
}

function artworkLayer(): HTMLElement {
  const layer = document.querySelector<HTMLElement>('[data-mock-layer="true"]');
  if (layer === null) throw new Error('artwork layer not mounted');
  return layer;
}

beforeEach(() => {
  resetWireframeStoreForTests();
  resetWireframeSurfaceForTests();
  resetHotkeyAnnouncer();
  document.body.innerHTML = '';
  konvaMock.stageProps = null;
  konvaMock.pointer = { x: 0, y: 0 };

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

  installComputedStyleStub();
});

afterEach(() => {
  cleanup();
  resetWireframeStoreForTests();
  resetWireframeSurfaceForTests();
  resetHotkeyAnnouncer();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute('style');
});

/** Render the canvas at 100 % / origin so stage coords equal page coords. */
function mountCanvas(): void {
  renderWithChakra(
    <WireframeNavigationProvider>
      <WireframeCanvasImpl />
    </WireframeNavigationProvider>,
  );
  act(() => setView({ scale: 1, x: 0, y: 0 }));
}

describe('create operator — activation', () => {
  it('paints the crosshair and makes the artwork non-interactive only while drawing', () => {
    mountCanvas();
    const host = screen.getByTestId('wireframe-canvas');

    expect(host).toHaveStyle({ cursor: 'default' });
    expect(artworkLayer()).toHaveAttribute('data-mock-listening', 'true');

    act(() => beginWireframeShapeCreate('rect'));

    expect(host).toHaveStyle({ cursor: 'crosshair' });
    expect(artworkLayer()).toHaveAttribute('data-mock-listening', 'false');

    act(() => beginWireframeShapeCreate('ellipse'));
    expect(artworkLayer()).toHaveAttribute('data-mock-listening', 'false');

    act(() => clearArmedWireframeShape());
    expect(armedKind()).toBeNull();
    expect(host).toHaveStyle({ cursor: 'default' });
    expect(artworkLayer()).toHaveAttribute('data-mock-listening', 'true');
  });
});

describe('create operator — commit', () => {
  it('draws a rectangle at the dragged bounds, auto-selects it and disarms', () => {
    mountCanvas();
    act(() => beginWireframeShapeCreate('rect'));
    expect(armedKind()).toBe('rect');

    dragCreate({ x: 100, y: 80 }, { x: 340, y: 240 });

    const state = getSnapshot();
    expect(state.document.elements).toHaveLength(1);
    const element = state.document.elements[0];
    expect(element.type).toBe('shape');
    expect(element).toMatchObject({
      type: 'shape',
      shape: 'rect',
      x: 100,
      y: 80,
      width: 240,
      height: 160,
      fill: 'muted',
    });
    // Auto-selected (primary = the only member) and disarmed.
    expect(state.selectedIds).toEqual([element.id]);
    expect(state.selectedId).toBe(element.id);
    expect(armedKind()).toBeNull();
  });

  it('draws an ellipse through the same path', () => {
    mountCanvas();
    act(() => beginWireframeShapeCreate('ellipse'));

    dragCreate({ x: 200, y: 120 }, { x: 500, y: 320 });

    const state = getSnapshot();
    expect(state.document.elements).toHaveLength(1);
    const element = state.document.elements[0];
    expect(element).toMatchObject({
      type: 'shape',
      shape: 'ellipse',
      x: 200,
      y: 120,
      width: 300,
      height: 200,
    });
    expect(state.selectedIds).toEqual([element.id]);
    expect(armedKind()).toBeNull();
  });

  it('normalizes a reversed drag (right→left, bottom→top) to a min-origin positive rect', () => {
    mountCanvas();
    act(() => beginWireframeShapeCreate('rect'));

    dragCreate({ x: 600, y: 400 }, { x: 400, y: 200 });

    const element = getSnapshot().document.elements[0];
    expect(element).toMatchObject({ x: 400, y: 200, width: 200, height: 200 });
  });

  it('clamps the origin into the page (top-left outside, bottom-right overflow)', () => {
    mountCanvas();
    act(() => beginWireframeShapeCreate('rect'));

    // Start above/left of the page origin: the ORIGIN clamps to 0,0 and the
    // dragged size is preserved.
    dragCreate({ x: -100, y: -60 }, { x: 400, y: 240 });
    expect(getSnapshot().document.elements[0]).toMatchObject({
      x: 0,
      y: 0,
      width: 500,
      height: 300,
    });

    act(() => beginWireframeShapeCreate('rect'));
    // Drag past the bottom-right corner: origin clamps so the box stays on the
    // 1280 x 800 page.
    dragCreate({ x: 1200, y: 700 }, { x: 1400, y: 900 });
    const elements = getSnapshot().document.elements;
    const last = elements[elements.length - 1];
    expect(last).toMatchObject({ x: 1080, y: 600, width: 200, height: 200 });
    expect(last.x + last.width).toBeLessThanOrEqual(1280);
    expect(last.y + last.height).toBeLessThanOrEqual(800);
  });

  it('commits exactly ONE store step per drag and one undo restores the document', () => {
    mountCanvas();
    act(() => beginWireframeShapeCreate('rect'));

    const commits = commitCountDuring(() => {
      dragCreate({ x: 100, y: 100 }, { x: 300, y: 260 });
    });

    expect(commits).toBe(1);
    expect(getSnapshot().document.elements).toHaveLength(1);
    expect(getSnapshot().canUndo).toBe(true);

    act(() => undo());
    expect(getSnapshot().document.elements).toHaveLength(0);
    expect(getSnapshot().canUndo).toBe(false);
  });

  it('writes no state on pointer moves (the store is untouched until release)', () => {
    mountCanvas();
    act(() => beginWireframeShapeCreate('rect'));
    const before = getSnapshot();

    pointerDown(100, 100);
    const moves = commitCountDuring(() => {
      pointerMove(150, 130);
      pointerMove(240, 220);
    });

    expect(moves).toBe(0);
    expect(getSnapshot()).toBe(before);
    expect(getSnapshot().canUndo).toBe(false);

    pointerUp(240, 220);
    expect(getSnapshot().document.elements).toHaveLength(1);
  });
});

describe('create operator — below minimum / no operator', () => {
  it('creates nothing and STAYS in the draw mode below the minimum width', () => {
    mountCanvas();
    act(() => beginWireframeShapeCreate('rect'));

    dragCreate({ x: 100, y: 100 }, { x: 103, y: 120 });

    const state = getSnapshot();
    expect(state.document.elements).toHaveLength(0);
    expect(state.selectedIds).toEqual([]);
    expect(state.canUndo).toBe(false);
    expect(armedKind()).toBe('rect');
  });

  it('creates nothing below the minimum height', () => {
    mountCanvas();
    act(() => beginWireframeShapeCreate('ellipse'));

    dragCreate({ x: 100, y: 100 }, { x: 103, y: 220 });

    const state = getSnapshot();
    expect(state.document.elements).toHaveLength(0);
    expect(state.canUndo).toBe(false);
    expect(armedKind()).toBe('ellipse');
  });

  it('treats a zero-area (same-point) gesture as no creation and stays in the mode', () => {
    mountCanvas();
    act(() => beginWireframeShapeCreate('rect'));

    dragCreate({ x: 300, y: 300 }, { x: 300, y: 300 });

    const state = getSnapshot();
    expect(state.document.elements).toHaveLength(0);
    expect(state.canUndo).toBe(false);
    expect(armedKind()).toBe('rect');
  });

  it('leaves an existing selection untouched for a below-minimum drag', () => {
    mountCanvas();
    act(() => beginWireframeShapeCreate('rect'));
    dragCreate({ x: 100, y: 100 }, { x: 300, y: 260 });
    const created = getSnapshot();
    const selectedBefore = [...created.selectedIds];

    act(() => beginWireframeShapeCreate('rect'));
    dragCreate({ x: 400, y: 400 }, { x: 403, y: 403 });

    const state = getSnapshot();
    expect(state.document.elements).toHaveLength(1);
    expect(state.selectedIds).toEqual(selectedBefore);
    expect(armedKind()).toBe('rect');
  });

  it('never creates from a drag in Select mode', () => {
    mountCanvas();
    expect(armedKind()).toBeNull();

    dragCreate({ x: 100, y: 100 }, { x: 400, y: 300 });

    expect(getSnapshot().document.elements).toHaveLength(0);
    expect(getSnapshot().canUndo).toBe(false);
  });

  it('never creates from a drag in Pan mode', () => {
    mountCanvas();
    act(() => setPanMode(true));
    expect(getSnapshot().panMode).toBe(true);
    expect(artworkLayer()).toHaveAttribute('data-mock-listening', 'true');

    dragCreate({ x: 100, y: 100 }, { x: 400, y: 300 });

    expect(getSnapshot().document.elements).toHaveLength(0);
    expect(artworkLayer()).toHaveAttribute('data-mock-listening', 'true');
  });
});
