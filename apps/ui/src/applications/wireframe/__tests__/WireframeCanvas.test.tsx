/**
 * Wireframe canvas behaviour (Spec #3070, ST-2).
 *
 * Konva is mocked: the shape components render inert divs and the element /
 * Transformer props are exposed through a module-scoped registry, so the tests
 * drive the real React component + the real store and assert:
 *  - the C7 canvas host contract,
 *  - single selection / empty-canvas clear,
 *  - one store step per drag and per resize,
 *  - locked inertness (no Transformer, body drag refused),
 *  - hidden elements paint no ink (group invisible) and show a dashed outline,
 *  - theme-true artboard colours from the palette,
 *  - ZERO-SIZE STAGE GUARD (round 2): the Stage is never committed with a zero
 *    width/height, which is the invariant behind the round-1 crash.
 *
 * Why the guard is pinned here and not by reproducing the throw: jsdom has no
 * canvas and `react-konva` is mocked in this file, so no `Stage`/layer buffer
 * canvas is ever allocated and the real `InvalidStateError` from
 * `drawImage` cannot fire. The unit pin therefore asserts the CAUSE — no Stage
 * render may carry a zero dimension, and the first render must already be the
 * measured size. The live app (real Konva, real canvas) is the fault-level
 * proof that the invariant removes the throw.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { WireframeCanvasImpl } from '../components/WireframeCanvasImpl';
import type { WireframeElement } from '../model/elements';
import type { WireframeDocument } from '../model/document';
import { createNewWireframeDocument } from '../model/document';
import {
  getSnapshot,
  loadDocument,
  resetWireframeStoreForTests,
  select,
  setPanMode,
  setView,
  undo,
} from '../store/wireframeDocumentStore';

const konvaMock = vi.hoisted(() => ({
  groups: new Map<string, { props: Record<string, any>; node: Record<string, any> }>(),
  transformer: null as null | { props: Record<string, any>; api: Record<string, any> },
  transformerNodes: [] as Array<Record<string, any>>,
  /** Every Stage render's committed size, in render order. */
  stageHistory: [] as Array<{ width: number; height: number }>,
}));

vi.mock('react-konva', async () => {
  const React = await import('react');

  const Stage = React.forwardRef(function MockStage(props: any, ref: any) {
    konvaMock.stageHistory.push({ width: props.width, height: props.height });

    React.useImperativeHandle(ref, () => ({
      toDataURL: () => 'data:image/png;base64,U1RBR0U=',
      find: () => [],
      width: () => props.width,
      height: () => props.height,
      container: () => ({ style: {} }),
    }));

    const stageNode = { getStage: () => stageNode };

    return React.createElement(
      'div',
      {
        'data-testid': 'mock-stage',
        'data-stage-width': props.width,
        'data-stage-height': props.height,
        onClick: () => props.onClick?.({ target: stageNode }),
      },
      props.children,
    );
  });

  const Layer = (props: any) =>
    React.createElement('div', { 'data-mock-layer': 'true' }, props.children);

  const Group = React.forwardRef(function MockGroup(props: any, ref: any) {
    const node = {
      x: () => props.x ?? 0,
      y: () => props.y ?? 0,
      width: () => props.width ?? 0,
      height: () => props.height ?? 0,
      scaleX: () => 1,
      scaleY: () => 1,
    };

    if (props.name) konvaMock.groups.set(props.name, { props, node });
    React.useImperativeHandle(ref, () => node);

    return React.createElement(
      'div',
      {
        'data-mock-group': props.name ?? 'group',
        'data-visible': String(props.visible ?? true),
        'data-draggable': String(props.draggable ?? false),
        onClick: props.onClick
          ? (event: any) => {
              event.stopPropagation();
              props.onClick({ cancelBubble: false });
            }
          : undefined,
      },
      props.children,
    );
  });

  const Transformer = React.forwardRef(function MockTransformer(props: any, ref: any) {
    const api = {
      nodes: (nodes?: Array<Record<string, any>>) => {
        if (nodes) konvaMock.transformerNodes = nodes;
        return konvaMock.transformerNodes;
      },
      getLayer: () => ({ batchDraw: () => undefined }),
    };
    konvaMock.transformer = { props, api };
    React.useImperativeHandle(ref, () => api);
    return React.createElement('div', { 'data-testid': 'mock-transformer' });
  });

  const shape = (tag: string) => (props: any) =>
    React.createElement(
      'div',
      {
        'data-mock-shape': tag,
        'data-mock-fill': props.fill ?? '',
        'data-mock-stroke': props.stroke ?? '',
        'data-mock-name': props.name ?? '',
        'data-mock-dash': props.dash ? JSON.stringify(props.dash) : '',
        // Konva listens by default; the hit-surface pins read this explicitly.
        'data-mock-listening': String(props.listening ?? true),
        'data-mock-x': props.x === undefined ? '' : String(props.x),
        'data-mock-y': props.y === undefined ? '' : String(props.y),
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
    Rect: shape('rect'),
    Text: shape('text'),
    Line: shape('line'),
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

function textElement(overrides: Partial<WireframeElement> = {}): WireframeElement {
  return {
    id: 'el-text',
    type: 'text',
    x: 480,
    y: 376,
    width: 320,
    height: 48,
    visible: true,
    locked: false,
    text: 'Hello wireframe',
    textStyle: 'body',
    size: 'm',
    align: 'left',
    ...overrides,
  } as WireframeElement;
}

function seedDocument(elements: WireframeElement[], selectedId?: string): void {
  const document: WireframeDocument = {
    ...createNewWireframeDocument('desktop'),
    elements,
  };
  loadDocument(document, 'C:/tmp/wireframe.wireframe.json');
  if (selectedId) select(selectedId);
}

function elementGroup(): { props: Record<string, any>; node: Record<string, any> } {
  const entry = konvaMock.groups.get('wireframe-element-el-text');
  if (!entry) throw new Error('element group not mounted');
  return entry;
}

function chromeOutlines(): Element[] {
  return Array.from(
    document.querySelectorAll('[data-mock-name="wireframe-capture-hidden"]'),
  );
}

beforeEach(() => {
  resetWireframeStoreForTests();
  konvaMock.groups.clear();
  konvaMock.transformer = null;
  konvaMock.transformerNodes = [];
  konvaMock.stageHistory = [];

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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute('style');
});

describe('canvas host contract', () => {
  it('renders the focusable, labelled canvas host with a measured stage', () => {
    seedDocument([]);
    renderWithChakra(<WireframeCanvasImpl />);

    const host = screen.getByTestId('wireframe-canvas');
    expect(host).toHaveAttribute('role', 'group');
    expect(host).toHaveAttribute('aria-label', 'Wireframe canvas');
    expect(host).toHaveAttribute('tabindex', '0');

    const stage = screen.getByTestId('mock-stage');
    expect(stage).toHaveAttribute('data-stage-width', '900');
    expect(stage).toHaveAttribute('data-stage-height', '640');
  });

  it('paints the artboard from the resolved theme palette', () => {
    seedDocument([]);
    const { container } = renderWithChakra(<WireframeCanvasImpl />);

    expect(
      container.querySelector('[data-mock-shape="rect"][data-mock-fill="token-surface"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-mock-shape="rect"][data-mock-stroke="token-border"]'),
    ).not.toBeNull();
  });

  it('shows the empty-state hint only when the page has no elements', () => {
    seedDocument([]);
    renderWithChakra(<WireframeCanvasImpl />);
    expect(
      screen.getByText(
        'Add an element from the toolbar, or ask the Companion to draft a wireframe.',
      ),
    ).toBeInTheDocument();
  });
});

describe('selection', () => {
  it('selects exactly the clicked element and shows the Transformer', () => {
    seedDocument([textElement()]);
    renderWithChakra(<WireframeCanvasImpl />);

    expect(screen.queryByTestId('mock-transformer')).toBeNull();

    act(() => {
      elementGroup().props.onClick({ cancelBubble: false });
    });

    const state = getSnapshot();
    expect(state.selectedId).toBe('el-text');
    expect(screen.getByTestId('mock-transformer')).toBeInTheDocument();
    expect(konvaMock.transformerNodes).toHaveLength(1);
    expect(konvaMock.transformerNodes[0]).toBe(elementGroup().node);
  });

  it('replaces the previous selection (single selection)', () => {
    seedDocument([
      textElement(),
      {
        ...textElement(),
        id: 'el-other',
        type: 'button',
        label: 'Go',
        appearance: 'primary',
      } as WireframeElement,
    ]);
    renderWithChakra(<WireframeCanvasImpl />);

    act(() => {
      konvaMock.groups.get('wireframe-element-el-text')!.props.onClick({
        cancelBubble: false,
      });
    });
    act(() => {
      konvaMock.groups.get('wireframe-element-el-other')!.props.onClick({
        cancelBubble: false,
      });
    });

    expect(getSnapshot().selectedId).toBe('el-other');
    expect(screen.getAllByTestId('mock-transformer')).toHaveLength(1);
  });

  it('clears the selection on an empty-canvas click', () => {
    seedDocument([textElement()], 'el-text');
    renderWithChakra(<WireframeCanvasImpl />);
    expect(getSnapshot().selectedId).toBe('el-text');

    fireEvent.click(screen.getByTestId('mock-stage'));

    expect(getSnapshot().selectedId).toBeNull();
    expect(screen.queryByTestId('mock-transformer')).toBeNull();
  });
});

describe('drag', () => {
  it('commits exactly ONE store step on drag end and updates the position', () => {
    seedDocument([textElement()]);
    renderWithChakra(<WireframeCanvasImpl />);
    expect(getSnapshot().canUndo).toBe(false);

    act(() => {
      elementGroup().props.onDragStart();
    });
    expect(getSnapshot().selectedId).toBe('el-text');

    act(() => {
      elementGroup().props.onDragEnd({
        target: { x: () => 500, y: () => 400 },
      });
    });

    const afterDrag = getSnapshot();
    expect(afterDrag.document.elements[0]).toMatchObject({ x: 500, y: 400 });
    expect(afterDrag.canUndo).toBe(true);

    act(() => undo());

    const afterUndo = getSnapshot();
    expect(afterUndo.document.elements[0]).toMatchObject({ x: 480, y: 376 });
    expect(afterUndo.canUndo).toBe(false);
  });

  it('does not commit a step for a click without movement', () => {
    seedDocument([textElement()]);
    renderWithChakra(<WireframeCanvasImpl />);

    act(() => {
      elementGroup().props.onDragEnd({
        target: { x: () => 480, y: () => 376 },
      });
    });

    expect(getSnapshot().canUndo).toBe(false);
    expect(getSnapshot().document.elements[0]).toMatchObject({ x: 480, y: 376 });
  });

  it('never writes React state per pointer move (no drag-move handler)', () => {
    seedDocument([textElement()]);
    renderWithChakra(<WireframeCanvasImpl />);
    expect(elementGroup().props.onDragMove).toBeUndefined();
    expect(elementGroup().props.onTransform).toBeUndefined();
  });
});

describe('transformer resize', () => {
  it('commits ONE store step on release and folds scale into width/height', () => {
    seedDocument([textElement()], 'el-text');
    renderWithChakra(<WireframeCanvasImpl />);

    let scaleX = 2;
    let scaleY = 1.5;
    const target = {
      x: () => 480,
      y: () => 376,
      width: () => 320,
      height: () => 48,
      scaleX: (value?: number) => {
        if (value === undefined) return scaleX;
        scaleX = value;
        return target;
      },
      scaleY: (value?: number) => {
        if (value === undefined) return scaleY;
        scaleY = value;
        return target;
      },
    };

    act(() => {
      elementGroup().props.onTransformEnd({ target });
    });

    const afterResize = getSnapshot();
    expect(afterResize.document.elements[0]).toMatchObject({
      x: 480,
      y: 376,
      width: 640,
      height: 72,
    });
    expect(scaleX).toBe(1);
    expect(scaleY).toBe(1);
    expect(afterResize.canUndo).toBe(true);

    act(() => undo());
    expect(getSnapshot().document.elements[0]).toMatchObject({ width: 320, height: 48 });
    expect(getSnapshot().canUndo).toBe(false);
  });
});

describe('locked inertness', () => {
  it('renders no Transformer and refuses a body drag', () => {
    seedDocument([textElement({ locked: true })], 'el-text');
    renderWithChakra(<WireframeCanvasImpl />);

    expect(screen.queryByTestId('mock-transformer')).toBeNull();
    expect(elementGroup().props.draggable).toBe(false);

    act(() => {
      elementGroup().props.onDragEnd({
        target: { x: () => 700, y: () => 500 },
      });
    });

    expect(getSnapshot().document.elements[0]).toMatchObject({ x: 480, y: 376 });
    expect(getSnapshot().canUndo).toBe(false);
  });
});

describe('hidden elements', () => {
  it('paint no ink but keep a dashed textMuted outline while selected', () => {
    seedDocument([textElement({ visible: false })], 'el-text');
    renderWithChakra(<WireframeCanvasImpl />);

    expect(elementGroup().props.visible).toBe(false);
    expect(screen.queryByTestId('mock-transformer')).toBeNull();

    const outlines = chromeOutlines();
    expect(outlines).toHaveLength(1);
    expect(outlines[0]).toHaveAttribute('data-mock-stroke', 'token-text-muted');
    expect(outlines[0].getAttribute('data-mock-dash')).not.toBe('');
  });

  it('shows a solid focusRing outline for a visible selection', () => {
    seedDocument([textElement()], 'el-text');
    renderWithChakra(<WireframeCanvasImpl />);

    const outlines = chromeOutlines();
    expect(outlines).toHaveLength(1);
    expect(outlines[0]).toHaveAttribute('data-mock-stroke', 'token-focus-ring');
    expect(outlines[0]).toHaveAttribute('data-mock-dash', '');
  });
});

describe('pan mode hit surface (F-27)', () => {
  function panSurface(): HTMLElement {
    const element = document.querySelector<HTMLElement>(
      '[data-mock-name="wireframe-pan-surface"]',
    );
    if (!element) throw new Error('pan hit surface not mounted');
    return element;
  }

  function numberAttr(element: Element, name: string): number {
    return Number(element.getAttribute(name));
  }

  it('covers the stage viewport and listens only while pan mode is on', () => {
    seedDocument([]);
    act(() => setPanMode(true));
    renderWithChakra(<WireframeCanvasImpl />);

    // The first commit fits the page; drive the transform under test explicitly.
    act(() => setView({ scale: 2, x: -120, y: -80 }));

    const surface = panSurface();
    const viewGroup = document.querySelector('[data-mock-group="wireframe-view"]');
    expect(viewGroup).not.toBeNull();
    // FIRST child of the pan group, ahead of the clipped artboard.
    expect(viewGroup!.firstElementChild).toBe(surface);

    expect(surface).toHaveAttribute('data-mock-listening', 'true');

    const stage = screen.getByTestId('mock-stage');
    const stageWidth = Number(stage.getAttribute('data-stage-width'));
    const stageHeight = Number(stage.getAttribute('data-stage-height'));

    // Local rect -> stage space through the group transform (view, scale).
    const { scale, x, y } = getSnapshot().view;
    const localX = numberAttr(surface, 'data-mock-x');
    const localY = numberAttr(surface, 'data-mock-y');
    const localWidth = numberAttr(surface, 'data-mock-width');
    const localHeight = numberAttr(surface, 'data-mock-height');

    expect(localX).toBe(60);
    expect(localY).toBe(40);
    expect(localWidth).toBe(stageWidth / scale);
    expect(localHeight).toBe(stageHeight / scale);
    expect(localX * scale + x).toBe(0);
    expect(localY * scale + y).toBe(0);
    expect(localWidth * scale).toBe(stageWidth);
    expect(localHeight * scale).toBe(stageHeight);

    act(() => setPanMode(false));
    expect(panSurface()).toHaveAttribute('data-mock-listening', 'false');
  });

  it('commits ONE view step on a pan release and never touches the document', () => {
    seedDocument([]);
    act(() => setPanMode(true));
    renderWithChakra(<WireframeCanvasImpl />);
    act(() => setView({ scale: 1, x: -120, y: -80 }));

    const before = getSnapshot();
    const documentBefore = before.document;
    const documentJsonBefore = JSON.stringify(before.document);

    const viewGroup = konvaMock.groups.get('wireframe-view');
    expect(viewGroup).toBeDefined();
    act(() => {
      viewGroup!.props.onDragEnd({
        target: { x: () => -80, y: () => -40 },
      });
    });

    const after = getSnapshot();
    expect(after.view).toMatchObject({ x: -80, y: -40 });
    expect(after.document).toBe(documentBefore);
    expect(JSON.stringify(after.document)).toBe(documentJsonBefore);
    expect(after.canUndo).toBe(false);
    expect(after.dirty).toBe(before.dirty);
  });
});

describe('zero-size stage guard', () => {
  let measured: { width: number; height: number };
  let observerCallback: (() => void) | null;

  beforeEach(() => {
    measured = { width: 0, height: 0 };
    observerCallback = null;

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      () =>
        ({
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: measured.width,
          bottom: measured.height,
          width: measured.width,
          height: measured.height,
          toJSON: () => ({}),
        }) as DOMRect,
    );

    // Manual drive: `observe()` must NOT fire, so the test decides when the
    // host gains a size (the first commit stays 0x0 until the assertion
    // drives the observer).
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private readonly callback: () => void) {
          observerCallback = callback;
        }
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
  });

  it('commits no Stage while the host measures 0x0, then mounts it at the measured size', () => {
    seedDocument([]);
    renderWithChakra(<WireframeCanvasImpl />);

    // First commit: host mounted (measurement + empty-state overlay keep their
    // node), no Stage at all, and the loading placeholder owns the viewport.
    expect(screen.getByTestId('wireframe-canvas')).toBeInTheDocument();
    expect(screen.getByTestId('wireframe-canvas-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-stage')).toBeNull();
    expect(konvaMock.stageHistory).toHaveLength(0);

    act(() => {
      measured = { width: 900, height: 640 };
      observerCallback?.();
    });

    const stage = screen.getByTestId('mock-stage');
    expect(stage).toHaveAttribute('data-stage-width', '900');
    expect(stage).toHaveAttribute('data-stage-height', '640');
    expect(screen.queryByTestId('wireframe-canvas-loading')).toBeNull();
  });

  it('commits the Stage first at the measured size and never at a zero dimension', () => {
    seedDocument([]);
    renderWithChakra(<WireframeCanvasImpl />);

    act(() => {
      measured = { width: 900, height: 640 };
      observerCallback?.();
    });

    expect(konvaMock.stageHistory.length).toBeGreaterThan(0);
    expect(konvaMock.stageHistory[0]).toEqual({ width: 900, height: 640 });
    for (const entry of konvaMock.stageHistory) {
      expect(entry.width).toBeGreaterThan(0);
      expect(entry.height).toBeGreaterThan(0);
    }
  });

  it('unmounts the Stage when the host shrinks to zero instead of re-committing at 0x0', () => {
    seedDocument([textElement()]);
    renderWithChakra(<WireframeCanvasImpl />);

    act(() => {
      measured = { width: 900, height: 640 };
      observerCallback?.();
    });
    expect(screen.getByTestId('mock-stage')).toBeInTheDocument();

    act(() => {
      measured = { width: 0, height: 0 };
      observerCallback?.();
    });

    expect(screen.queryByTestId('mock-stage')).toBeNull();
    expect(screen.getByTestId('wireframe-canvas')).toBeInTheDocument();
    expect(screen.getByTestId('wireframe-canvas-loading')).toBeInTheDocument();
    expect(
      konvaMock.stageHistory.every((entry) => entry.width > 0 && entry.height > 0),
    ).toBe(true);
  });
});
