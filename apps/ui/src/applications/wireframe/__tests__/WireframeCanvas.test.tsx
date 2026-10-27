/**
 * Wireframe canvas behaviour (Spec #3070, ST-2; extended by Spec #3071, ST-5).
 *
 * Konva is mocked: the shape components render inert divs and the element /
 * Transformer props are exposed through a module-scoped registry, so the tests
 * drive the real React component + the real store and assert:
 *  - the C7 canvas host contract (+ the `data-wireframe-guides` hook),
 *  - single + multi (shift-click) selection / empty-canvas clear,
 *  - ONE Transformer bound to the whole selection,
 *  - primary / member / pinned selection outlines,
 *  - one store step per drag and per resize, group drag + group resize as ONE
 *    `elements.update` applied to the MOVABLE members only,
 *  - snap-to-grid on drop (union-box origin, clamped to the page),
 *  - smart alignment guides painted mid-drag and removed on drop (imperative),
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
  beginCaptureView,
  endCaptureView,
  getSnapshot,
  loadDocument,
  resetWireframeStoreForTests,
  selectMany,
  setPanMode,
  setSnapToGrid,
  setView,
  subscribe,
  undo,
} from '../store/wireframeDocumentStore';

interface MockNode {
  attrs: Record<string, any>;
  getLayer: () => { batchDraw: () => void };
  getStage: () => MockNode;
  forceUpdate: () => void;
  [key: string]: any;
}

const konvaMock = vi.hoisted(() => ({
  groups: new Map<string, { props: Record<string, any>; node: Record<string, any> }>(),
  /** Every guide `Line` node (name `wireframe-guide`), in mount order. */
  lines: [] as Array<Record<string, any>>,
  transformer: null as null | { props: Record<string, any>; api: Record<string, any> },
  transformerNodes: [] as Array<Record<string, any>>,
  /** Every Stage render's committed size, in render order. */
  stageHistory: [] as Array<{ width: number; height: number }>,
}));

vi.mock('react-konva', async () => {
  const React = await import('react');

  const makeNode = (initial: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    visible?: boolean;
    points?: number[];
  }): MockNode => {
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
    const node: MockNode = {
      attrs,
      getLayer: () => ({ batchDraw: () => undefined }),
      getStage: () => node,
      forceUpdate: () => undefined,
    };
    for (const key of [
      'x',
      'y',
      'width',
      'height',
      'scaleX',
      'scaleY',
      'visible',
      'points',
    ]) {
      node[key] = (value?: unknown) => {
        if (value === undefined) return attrs[key];
        attrs[key] = value;
        return node;
      };
    }
    return node;
  };

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
    React.createElement(
      'div',
      { 'data-mock-layer': 'true', 'data-mock-layer-name': props.name ?? '' },
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
      // A fresh node per mount; imperative updates flow through the api.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [],
    );

    if (props.name) konvaMock.groups.set(props.name, { props, node });
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
      forceUpdate: () => undefined,
    };
    konvaMock.transformer = { props, api };
    React.useImperativeHandle(ref, () => api, [api]);
    return React.createElement('div', { 'data-testid': 'mock-transformer' });
  });

  const Line = React.forwardRef(function MockLine(props: any, ref: any) {
    const node = React.useMemo(
      () => makeNode({ points: props.points, visible: props.visible }),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [],
    );
    React.useImperativeHandle(
      ref,
      () => {
        if (props.name === 'wireframe-guide') konvaMock.lines.push(node);
        return node;
      },
      [node, props.name],
    );
    return React.createElement('div', {
      'data-mock-shape': 'line',
      'data-mock-name': props.name ?? '',
      'data-mock-stroke': props.stroke ?? '',
      'data-mock-dash': props.dash ? JSON.stringify(props.dash) : '',
      'data-mock-listening': String(props.listening ?? true),
      'data-mock-stroke-width':
        props.strokeWidth === undefined ? '' : String(props.strokeWidth),
    });
  });

  const Shape = (props: any) =>
    React.createElement('div', {
      'data-mock-shape': 'shape',
      'data-mock-name': props.name ?? '',
      'data-mock-visible': String(props.visible ?? true),
      'data-mock-listening': String(props.listening ?? true),
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
        'data-mock-stroke-width':
          props.strokeWidth === undefined ? '' : String(props.strokeWidth),
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

function buttonElement(id: string, x: number, y: number): WireframeElement {
  return {
    id,
    type: 'button',
    x,
    y,
    width: 160,
    height: 44,
    visible: true,
    locked: false,
    label: 'Go',
    appearance: 'primary',
  } as WireframeElement;
}

function seedDocument(elements: WireframeElement[], selectedIds?: string[]): void {
  const document: WireframeDocument = {
    ...createNewWireframeDocument('desktop'),
    elements,
  };
  loadDocument(document, 'C:/tmp/wireframe.wireframe.json');
  if (selectedIds && selectedIds.length > 0) selectMany(selectedIds);
}

function elementGroup(id = 'el-text'): { props: Record<string, any>; node: MockNode } {
  const entry = konvaMock.groups.get(`wireframe-element-${id}`);
  if (!entry) throw new Error(`element group ${id} not mounted`);
  return entry as { props: Record<string, any>; node: MockNode };
}

function transformerProps(): Record<string, any> {
  if (!konvaMock.transformer) throw new Error('transformer not mounted');
  return konvaMock.transformer.props;
}

function chromeOutlines(): Element[] {
  return Array.from(
    document.querySelectorAll('[data-mock-name="wireframe-capture-hidden"]'),
  );
}

function clickElement(id: string, shiftKey = false): void {
  act(() => {
    elementGroup(id).props.onClick({
      cancelBubble: false,
      evt: { shiftKey },
    });
  });
}

function dragElementTo(id: string, x: number, y: number): void {
  const node = elementGroup(id).node;
  act(() => {
    elementGroup(id).props.onDragStart();
  });
  act(() => {
    node.x(x);
    node.y(y);
    elementGroup(id).props.onDragMove();
  });
  act(() => {
    elementGroup(id).props.onDragEnd();
  });
}

/**
 * Drive Konva's multi-node Transformer proxy-drag. Konva calls `startDrag()` on
 * EVERY node the Transformer is attached to (regardless of `draggable`), so one
 * gesture emits a `dragstart`/`dragend` pair per attached node — the observed
 * order `start:*, …, end:*, …`. The moves run between the starts and the ends.
 */
function proxyDragGesture(moves: Array<{ id: string; x: number; y: number }>): void {
  for (const move of moves) {
    act(() => {
      elementGroup(move.id).props.onDragStart();
    });
  }
  for (const move of moves) {
    act(() => {
      elementGroup(move.id).node.x(move.x);
      elementGroup(move.id).node.y(move.y);
      elementGroup(move.id).props.onDragMove();
    });
  }
  for (const move of moves) {
    act(() => {
      elementGroup(move.id).props.onDragEnd();
    });
  }
}

/**
 * Count store commits during `run`. The store notifies exactly ONCE per
 * committed snapshot (`commitDocument` → `notify`), so the listener count is a
 * direct oracle for "how many `elements.update` commits did this gesture make".
 */
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

beforeEach(() => {
  resetWireframeStoreForTests();
  konvaMock.groups.clear();
  konvaMock.lines.length = 0;
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

  it('exposes the guides hook at 0 while idle', () => {
    seedDocument([]);
    renderWithChakra(<WireframeCanvasImpl />);
    expect(screen.getByTestId('wireframe-canvas')).toHaveAttribute(
      'data-wireframe-guides',
      '0',
    );
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

    clickElement('el-text');

    const state = getSnapshot();
    expect(state.selectedIds).toEqual(['el-text']);
    expect(state.selectedId).toBe('el-text');
    expect(screen.getByTestId('mock-transformer')).toBeInTheDocument();
    expect(konvaMock.transformerNodes).toHaveLength(1);
    expect(konvaMock.transformerNodes[0]).toBe(elementGroup().node);
  });

  it('replaces the previous selection on a plain click', () => {
    seedDocument([textElement(), buttonElement('el-other', 200, 200)]);
    renderWithChakra(<WireframeCanvasImpl />);

    clickElement('el-text');
    clickElement('el-other');

    expect(getSnapshot().selectedIds).toEqual(['el-other']);
    expect(getSnapshot().selectedId).toBe('el-other');
    expect(screen.getAllByTestId('mock-transformer')).toHaveLength(1);
  });

  it('shift-click ADDS an element and keeps the previous one selected', () => {
    seedDocument([textElement(), buttonElement('el-b', 200, 200), buttonElement('el-c', 400, 400)]);
    renderWithChakra(<WireframeCanvasImpl />);

    clickElement('el-text');
    clickElement('el-b', true);
    clickElement('el-c', true);

    const state = getSnapshot();
    expect(state.selectedIds).toEqual(['el-text', 'el-b', 'el-c']);
    // Primary = the last id (document order).
    expect(state.selectedId).toBe('el-c');
  });

  it('shift-click REMOVES an already-selected element', () => {
    seedDocument([textElement(), buttonElement('el-b', 200, 200)]);
    seedDocument([textElement(), buttonElement('el-b', 200, 200)], ['el-text', 'el-b']);
    renderWithChakra(<WireframeCanvasImpl />);

    clickElement('el-b', true);

    expect(getSnapshot().selectedIds).toEqual(['el-text']);
    expect(getSnapshot().selectedId).toBe('el-text');
  });

  it('shift-click down to empty clears the selection and the Transformer', () => {
    seedDocument([textElement()], ['el-text']);
    renderWithChakra(<WireframeCanvasImpl />);
    expect(screen.getByTestId('mock-transformer')).toBeInTheDocument();

    clickElement('el-text', true);

    expect(getSnapshot().selectedIds).toEqual([]);
    expect(getSnapshot().selectedId).toBeNull();
    expect(screen.queryByTestId('mock-transformer')).toBeNull();
  });

  it('binds ONE Transformer to every selected node', () => {
    seedDocument([textElement(), buttonElement('el-b', 200, 200)], ['el-text', 'el-b']);
    renderWithChakra(<WireframeCanvasImpl />);

    expect(screen.getAllByTestId('mock-transformer')).toHaveLength(1);
    expect(konvaMock.transformerNodes).toHaveLength(2);
    expect(konvaMock.transformerNodes).toContain(elementGroup('el-text').node);
    expect(konvaMock.transformerNodes).toContain(elementGroup('el-b').node);
  });

  it('clears the selection on an empty-canvas click', () => {
    seedDocument([textElement()], ['el-text']);
    renderWithChakra(<WireframeCanvasImpl />);
    expect(getSnapshot().selectedId).toBe('el-text');

    fireEvent.click(screen.getByTestId('mock-stage'));

    expect(getSnapshot().selectedIds).toEqual([]);
    expect(screen.queryByTestId('mock-transformer')).toBeNull();
  });
});

describe('selection outlines', () => {
  it('paints the primary 2 px accent and other members 1 px accent', () => {
    seedDocument([textElement(), buttonElement('el-b', 200, 200)], ['el-text', 'el-b']);
    renderWithChakra(<WireframeCanvasImpl />);
    // 100 % zoom so the chrome stroke is exactly 2 / 1 logical px.
    act(() => setView({ scale: 1, x: 0, y: 0 }));

    const outlines = chromeOutlines();
    expect(outlines).toHaveLength(2);
    for (const outline of outlines) {
      expect(outline).toHaveAttribute('data-mock-stroke', 'token-accent');
      expect(outline).toHaveAttribute('data-mock-dash', '');
    }
    // el-b is the primary (last in document order) ⇒ 2, el-text ⇒ 1.
    const primary = outlines.find(
      (outline) => outline.getAttribute('data-mock-x') === '200',
    );
    expect(primary).toHaveAttribute('data-mock-stroke-width', '2');
    const widths = outlines.map((outline) =>
      Number(outline.getAttribute('data-mock-stroke-width')),
    );
    expect(widths.sort()).toEqual([1, 2]);
  });

  it('paints a locked member 1 px dashed muted', () => {
    const document: WireframeDocument = {
      ...createNewWireframeDocument('desktop'),
      elements: [
        textElement(),
        { ...buttonElement('el-b', 200, 200), locked: true } as WireframeElement,
      ],
    };
    loadDocument(document, 'C:/tmp/wireframe.wireframe.json');
    selectMany(['el-text', 'el-b']);
    renderWithChakra(<WireframeCanvasImpl />);
    act(() => setView({ scale: 1, x: 0, y: 0 }));

    const outlines = chromeOutlines();
    const lockedOutline = outlines.find(
      (outline) => outline.getAttribute('data-mock-x') === '200',
    );
    expect(lockedOutline).toHaveAttribute('data-mock-stroke', 'token-text-muted');
    expect(lockedOutline).toHaveAttribute('data-mock-stroke-width', '1');
    expect(lockedOutline!.getAttribute('data-mock-dash')).not.toBe('');
  });
});

describe('drag', () => {
  it('commits exactly ONE store step on drag end and updates the position', () => {
    seedDocument([textElement()], ['el-text']);
    renderWithChakra(<WireframeCanvasImpl />);
    expect(getSnapshot().canUndo).toBe(false);

    dragElementTo('el-text', 500, 400);

    const afterDrag = getSnapshot();
    expect(afterDrag.document.elements[0]).toMatchObject({ x: 500, y: 400 });
    expect(afterDrag.canUndo).toBe(true);

    act(() => undo());

    const afterUndo = getSnapshot();
    expect(afterUndo.document.elements[0]).toMatchObject({ x: 480, y: 376 });
    expect(afterUndo.canUndo).toBe(false);
  });

  it('does not commit a step for a click without movement', () => {
    seedDocument([textElement()], ['el-text']);
    renderWithChakra(<WireframeCanvasImpl />);

    act(() => {
      elementGroup().props.onDragStart();
      elementGroup().props.onDragEnd();
    });

    expect(getSnapshot().canUndo).toBe(false);
    expect(getSnapshot().document.elements[0]).toMatchObject({ x: 480, y: 376 });
  });

  it('never writes React state per pointer move (drag-move updates Konva attrs only)', () => {
    seedDocument([textElement()], ['el-text']);
    renderWithChakra(<WireframeCanvasImpl />);

    act(() => {
      elementGroup().props.onDragStart();
    });
    const before = getSnapshot();

    act(() => {
      elementGroup().node.x(520);
      elementGroup().node.y(400);
      elementGroup().props.onDragMove();
    });

    // The store snapshot is byte-identical: no notify, no commit.
    expect(getSnapshot()).toBe(before);
    expect(getSnapshot().canUndo).toBe(false);
    // Konva attributes carried the move instead.
    expect(elementGroup().node.x()).toBe(520);
    expect(elementGroup().node.y()).toBe(400);
  });

  it('moves EVERY movable member by the same delta in ONE commit', () => {
    seedDocument(
      [textElement(), buttonElement('el-b', 500, 300)],
      ['el-text', 'el-b'],
    );
    renderWithChakra(<WireframeCanvasImpl />);

    act(() => {
      elementGroup('el-text').props.onDragStart();
    });
    act(() => {
      // The leader moved by (+40, +20).
      elementGroup('el-text').node.x(520);
      elementGroup('el-text').node.y(396);
      elementGroup('el-text').props.onDragMove();
    });

    // The other member followed imperatively.
    expect(elementGroup('el-b').node.x()).toBe(540);
    expect(elementGroup('el-b').node.y()).toBe(320);
    expect(getSnapshot().canUndo).toBe(false);

    act(() => {
      elementGroup('el-text').props.onDragEnd();
    });

    const after = getSnapshot();
    expect(after.document.elements[0]).toMatchObject({ x: 520, y: 396 });
    expect(after.document.elements[1]).toMatchObject({ x: 540, y: 320 });
    expect(after.canUndo).toBe(true);

    act(() => undo());
    const undone = getSnapshot();
    expect(undone.document.elements[0]).toMatchObject({ x: 480, y: 376 });
    expect(undone.document.elements[1]).toMatchObject({ x: 500, y: 300 });
    expect(undone.canUndo).toBe(false);
  });

  it('leaves an individually locked member in place during a group drag', () => {
    const locked = { ...textElement(), id: 'el-locked', x: 700, y: 700, locked: true };
    seedDocument(
      [textElement(), buttonElement('el-b', 500, 300), locked as WireframeElement],
      ['el-text', 'el-b', 'el-locked'],
    );
    renderWithChakra(<WireframeCanvasImpl />);

    // A locked member is not draggable.
    expect(elementGroup('el-locked').props.draggable).toBe(false);

    act(() => {
      elementGroup('el-text').props.onDragStart();
    });
    act(() => {
      elementGroup('el-text').node.x(500);
      elementGroup('el-text').node.y(400);
      elementGroup('el-text').props.onDragMove();
    });
    act(() => {
      elementGroup('el-text').props.onDragEnd();
    });

    const after = getSnapshot();
    expect(after.document.elements[0]).toMatchObject({ x: 500, y: 400 });
    expect(after.document.elements[1]).toMatchObject({ x: 520, y: 324 });
    expect(after.document.elements[2]).toMatchObject({ x: 700, y: 700 });
  });
});

describe('multi-node drag session (FX-1)', () => {
  it('commits exactly ONE elements.update for a multi-node Transformer proxy-drag', () => {
    seedDocument(
      [textElement(), buttonElement('el-b', 500, 300)],
      ['el-text', 'el-b'],
    );
    renderWithChakra(<WireframeCanvasImpl />);
    expect(getSnapshot().canUndo).toBe(false);

    // One gesture: a dragstart + dragmove + dragend for EACH attached node.
    const commits = commitCountDuring(() => {
      proxyDragGesture([
        { id: 'el-text', x: 520, y: 396 },
        { id: 'el-b', x: 540, y: 320 },
      ]);
    });

    // The whole gesture is ONE `elements.update` — not one per member.
    expect(commits).toBe(1);

    const after = getSnapshot();
    expect(after.document.elements[0]).toMatchObject({ x: 520, y: 396 });
    expect(after.document.elements[1]).toMatchObject({ x: 540, y: 320 });

    // ONE undo restores EVERY member and leaves nothing left to undo.
    act(() => undo());
    const undone = getSnapshot();
    expect(undone.document.elements[0]).toMatchObject({ x: 480, y: 376 });
    expect(undone.document.elements[1]).toMatchObject({ x: 500, y: 300 });
    expect(undone.canUndo).toBe(false);
  });

  it('does not move a locked member of a dragged group, and re-pins its node on release', () => {
    const locked = { ...textElement(), id: 'el-locked', x: 700, y: 700, locked: true };
    seedDocument(
      [textElement(), buttonElement('el-b', 500, 300), locked as WireframeElement],
      ['el-text', 'el-b', 'el-locked'],
    );
    renderWithChakra(<WireframeCanvasImpl />);
    expect(getSnapshot().canUndo).toBe(false);

    // Konva proxy-drags the locked node too (`startDrag` ignores `draggable`),
    // so its node is moved VISUALLY during the gesture...
    const commits = commitCountDuring(() => {
      proxyDragGesture([
        { id: 'el-text', x: 520, y: 396 },
        { id: 'el-b', x: 540, y: 320 },
        { id: 'el-locked', x: 740, y: 720 },
      ]);
    });

    expect(commits).toBe(1);

    const after = getSnapshot();
    // ...but its COMMITTED geometry is string-identical (R-1.8).
    expect(after.document.elements[2]).toMatchObject({ x: 700, y: 700 });
    expect(after.document.elements[0]).toMatchObject({ x: 520, y: 396 });
    expect(after.document.elements[1]).toMatchObject({ x: 540, y: 320 });

    // The locked Konva node is re-pinned to the model the instant the gesture ends.
    expect(elementGroup('el-locked').node.x()).toBe(700);
    expect(elementGroup('el-locked').node.y()).toBe(700);

    // ONE undo restores every moved member; the locked member never changed.
    act(() => undo());
    const undone = getSnapshot();
    expect(undone.document.elements[0]).toMatchObject({ x: 480, y: 376 });
    expect(undone.document.elements[1]).toMatchObject({ x: 500, y: 300 });
    expect(undone.document.elements[2]).toMatchObject({ x: 700, y: 700 });
    expect(undone.canUndo).toBe(false);
  });

  it('still commits exactly one step for a plain single-element drag', () => {
    seedDocument([textElement()], ['el-text']);
    renderWithChakra(<WireframeCanvasImpl />);

    const commits = commitCountDuring(() => {
      dragElementTo('el-text', 500, 400);
    });

    expect(commits).toBe(1);
    expect(getSnapshot().document.elements[0]).toMatchObject({ x: 500, y: 400 });
  });
});

describe('snap to grid', () => {
  it('lands the dragged origin on the grid when snap is on', () => {
    seedDocument([textElement()], ['el-text']);
    act(() => setSnapToGrid(true));
    renderWithChakra(<WireframeCanvasImpl />);

    dragElementTo('el-text', 133, 91);

    // 133 → 136, 91 → 88 (nearest multiple of 8).
    expect(getSnapshot().document.elements[0]).toMatchObject({ x: 136, y: 88 });
  });

  it('keeps free coordinates when snap is off', () => {
    seedDocument([textElement()], ['el-text']);
    renderWithChakra(<WireframeCanvasImpl />);

    dragElementTo('el-text', 133, 91);

    expect(getSnapshot().document.elements[0]).toMatchObject({ x: 133, y: 91 });
  });

  it('snaps a multi-selection from its UNION-BOX origin with ONE uniform delta', () => {
    seedDocument(
      [textElement(), buttonElement('el-b', 600, 450)],
      ['el-text', 'el-b'],
    );
    act(() => setSnapToGrid(true));
    renderWithChakra(<WireframeCanvasImpl />);

    act(() => {
      elementGroup('el-text').props.onDragStart();
    });
    act(() => {
      elementGroup('el-text').node.x(485);
      elementGroup('el-text').node.y(379);
      elementGroup('el-text').props.onDragMove();
    });
    act(() => {
      elementGroup('el-text').props.onDragEnd();
    });

    // Union origin (485, 379) snaps to (488, 376) ⇒ delta (+3, −3) applied
    // uniformly; inter-element offsets preserved.
    const after = getSnapshot();
    expect(after.document.elements[0]).toMatchObject({ x: 488, y: 376 });
    expect(after.document.elements[1]).toMatchObject({ x: 608, y: 450 });
    expect(after.canUndo).toBe(true);
  });

  it('clamps the snapped origin inside the page', () => {
    // 1268 → nearest 8 is 1272, but max x is 1280 - 320 = 960.
    seedDocument([textElement({ x: 955, y: 100 })], ['el-text']);
    act(() => setSnapToGrid(true));
    renderWithChakra(<WireframeCanvasImpl />);

    dragElementTo('el-text', 1268, 97);

    expect(getSnapshot().document.elements[0]).toMatchObject({ x: 960, y: 96 });
  });
});

describe('smart alignment guides', () => {
  it('paints guides mid-drag and clears them on drop (imperative hook)', () => {
    seedDocument([textElement(), buttonElement('el-b', 800, 376)], ['el-text']);
    renderWithChakra(<WireframeCanvasImpl />);

    const host = screen.getByTestId('wireframe-canvas');
    expect(host).toHaveAttribute('data-wireframe-guides', '0');

    act(() => {
      elementGroup('el-text').props.onDragStart();
    });
    act(() => {
      // el-text's edges/centre stay within 6 px of el-b's on the y axis.
      elementGroup('el-text').node.x(480);
      elementGroup('el-text').node.y(377);
      elementGroup('el-text').props.onDragMove();
    });

    expect(Number(host.getAttribute('data-wireframe-guides'))).toBeGreaterThan(0);
    expect(konvaMock.lines.some((line) => line.visible() === true)).toBe(true);

    act(() => {
      elementGroup('el-text').props.onDragEnd();
    });

    expect(host).toHaveAttribute('data-wireframe-guides', '0');
    expect(konvaMock.lines.every((line) => line.visible() === false)).toBe(true);
  });

  it('never paints a guide when nothing is near', () => {
    seedDocument([textElement(), buttonElement('el-b', 1200, 700)], ['el-text']);
    renderWithChakra(<WireframeCanvasImpl />);

    act(() => {
      elementGroup('el-text').props.onDragStart();
    });
    act(() => {
      elementGroup('el-text').node.x(480);
      elementGroup('el-text').node.y(377);
      elementGroup('el-text').props.onDragMove();
    });

    expect(screen.getByTestId('wireframe-canvas')).toHaveAttribute(
      'data-wireframe-guides',
      '0',
    );
  });

  it('clears every guide on Escape (drag cancel)', () => {
    seedDocument([textElement(), buttonElement('el-b', 800, 376)], ['el-text']);
    renderWithChakra(<WireframeCanvasImpl />);

    act(() => {
      elementGroup('el-text').props.onDragStart();
    });
    act(() => {
      elementGroup('el-text').node.y(377);
      elementGroup('el-text').props.onDragMove();
    });
    expect(
      Number(screen.getByTestId('wireframe-canvas').getAttribute('data-wireframe-guides')),
    ).toBeGreaterThan(0);

    act(() => {
      fireEvent.keyDown(screen.getByTestId('wireframe-canvas'), { key: 'Escape' });
    });

    expect(screen.getByTestId('wireframe-canvas')).toHaveAttribute(
      'data-wireframe-guides',
      '0',
    );
  });

  it('puts guides + the snap grid on a capture-hidden layer', () => {
    seedDocument([]);
    renderWithChakra(<WireframeCanvasImpl />);

    const layer = document.querySelector(
      '[data-mock-layer-name="wireframe-guides wireframe-capture-hidden"]',
    );
    expect(layer).not.toBeNull();
    // The grid shape lives on that layer and is hidden while snap is off.
    expect(layer!.querySelector('[data-mock-name="wireframe-snap-grid"]')).toHaveAttribute(
      'data-mock-visible',
      'false',
    );
  });

  it('shows the snap grid while snap is on and hides it when off', () => {
    seedDocument([]);
    renderWithChakra(<WireframeCanvasImpl />);

    const grid = () => document.querySelector('[data-mock-name="wireframe-snap-grid"]');
    expect(grid()).toHaveAttribute('data-mock-visible', 'false');

    act(() => setSnapToGrid(true));
    expect(grid()).toHaveAttribute('data-mock-visible', 'true');

    act(() => setSnapToGrid(false));
    expect(grid()).toHaveAttribute('data-mock-visible', 'false');
  });
});

describe('transformer resize', () => {
  it('commits ONE store step on release and folds the delta into width/height', () => {
    seedDocument([textElement()], ['el-text']);
    renderWithChakra(<WireframeCanvasImpl />);

    const node = elementGroup().node;
    act(() => {
      transformerProps().onTransformStart();
    });
    act(() => {
      node.scaleX(2);
      node.scaleY(1.5);
      transformerProps().onTransformEnd();
    });

    const afterResize = getSnapshot();
    expect(afterResize.document.elements[0]).toMatchObject({
      x: 480,
      y: 376,
      width: 640,
      height: 72,
    });
    expect(node.scaleX()).toBe(1);
    expect(node.scaleY()).toBe(1);
    expect(afterResize.canUndo).toBe(true);

    act(() => undo());
    expect(getSnapshot().document.elements[0]).toMatchObject({ width: 320, height: 48 });
    expect(getSnapshot().canUndo).toBe(false);
  });

  it('applies the SAME union-box delta to every movable member in ONE commit', () => {
    seedDocument(
      [textElement(), buttonElement('el-b', 500, 300)],
      ['el-text', 'el-b'],
    );
    renderWithChakra(<WireframeCanvasImpl />);

    act(() => {
      transformerProps().onTransformStart();
    });
    act(() => {
      // Konva scales the nodes; the union box grows by (+160, +88) at the
      // same origin ⇒ dw = +160, dh = +88, dx = dy = 0.
      elementGroup('el-text').node.scaleX(1.5);
      elementGroup('el-b').node.scaleX(2);
      elementGroup('el-b').node.scaleY(3);
      transformerProps().onTransformEnd();
    });

    const after = getSnapshot();
    // delta = endUnion - startUnion. startUnion = (480, 300, 180, 48);
    // endUnion = (480, 300, 320 + 160? , ...) computed from the scaled nodes.
    // Assert the invariant instead: every movable member grew by the SAME
    // (dw, dh) and kept its origin offsets.
    const startWidths = [320, 160];
    const widths = after.document.elements.map((element) => element.width);
    expect(widths[0] - startWidths[0]).toBe(widths[1] - startWidths[1]);
    const heights = after.document.elements.map((element) => element.height);
    expect(heights[0] - 48).toBe(heights[1] - 44);
    // Origins unchanged (dx = dy = 0 for this drag).
    expect(after.document.elements[0]).toMatchObject({ x: 480, y: 376 });
    expect(after.document.elements[1]).toMatchObject({ x: 500, y: 300 });
    expect(after.canUndo).toBe(true);
  });

  it('clamps the resize delta so no movable member falls below ELEMENT_MIN_SIZE', () => {
    seedDocument(
      [
        textElement({ width: 320, height: 48 }),
        buttonElement('el-b', 500, 300),
      ],
      ['el-text', 'el-b'],
    );
    renderWithChakra(<WireframeCanvasImpl />);

    act(() => {
      transformerProps().onTransformStart();
    });
    act(() => {
      // Collapse the union box to almost nothing.
      elementGroup('el-text').node.scaleX(0.0001);
      elementGroup('el-text').node.scaleY(0.0001);
      elementGroup('el-b').node.scaleX(0.0001);
      elementGroup('el-b').node.scaleY(0.0001);
      transformerProps().onTransformEnd();
    });

    const widths = getSnapshot().document.elements.map((element) => element.width);
    expect(Math.min(...widths)).toBeGreaterThanOrEqual(8);
  });
});

describe('locked inertness', () => {
  it('renders no Transformer and refuses a body drag', () => {
    seedDocument([textElement({ locked: true })], ['el-text']);
    renderWithChakra(<WireframeCanvasImpl />);

    expect(screen.queryByTestId('mock-transformer')).toBeNull();
    expect(elementGroup().props.draggable).toBe(false);

    act(() => {
      elementGroup().props.onDragStart();
      elementGroup().node.x(700);
      elementGroup().node.y(500);
      elementGroup().props.onDragEnd();
    });

    expect(getSnapshot().document.elements[0]).toMatchObject({ x: 480, y: 376 });
    expect(getSnapshot().canUndo).toBe(false);
  });
});

describe('hidden elements', () => {
  it('paint no ink but keep a dashed textMuted outline while selected', () => {
    seedDocument([textElement({ visible: false })], ['el-text']);
    renderWithChakra(<WireframeCanvasImpl />);

    expect(elementGroup().props.visible).toBe(false);
    expect(screen.queryByTestId('mock-transformer')).toBeNull();

    const outlines = chromeOutlines();
    expect(outlines).toHaveLength(1);
    expect(outlines[0]).toHaveAttribute('data-mock-stroke', 'token-text-muted');
    expect(outlines[0].getAttribute('data-mock-dash')).not.toBe('');
  });

  it('shows a solid accent outline for a visible selection', () => {
    seedDocument([textElement()], ['el-text']);
    renderWithChakra(<WireframeCanvasImpl />);

    const outlines = chromeOutlines();
    expect(outlines).toHaveLength(1);
    expect(outlines[0]).toHaveAttribute('data-mock-stroke', 'token-accent');
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
    // A real Konva pan sets `currentTarget` to the listener's node.
    const panNode = { x: () => -80, y: () => -40 };
    act(() => {
      viewGroup!.props.onDragEnd({
        target: panNode,
        currentTarget: panNode,
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

describe('capture paint override (F-33)', () => {
  const LIVE_VIEW = { scale: 4, x: -300, y: -200 };

  function viewGroup(): Element {
    const element = document.querySelector('[data-mock-group="wireframe-view"]');
    if (!element) throw new Error('view group not mounted');
    return element;
  }

  function pageRect(): Element {
    const element = document.querySelector(
      '[data-mock-shape="rect"][data-mock-width="1280"]',
    );
    if (!element) throw new Error('page rect not mounted');
    return element;
  }

  function expectLiveFrame(): void {
    const group = viewGroup();
    expect(group).toHaveAttribute('data-mock-x', '-300');
    expect(group).toHaveAttribute('data-mock-y', '-200');
    expect(group).toHaveAttribute('data-mock-scale-x', '4');
    expect(group).toHaveAttribute('data-mock-scale-y', '4');
    // The page border stays 1 device px at the live zoom.
    expect(pageRect()).toHaveAttribute('data-mock-stroke-width', '0.25');
  }

  function expectIdentityFrame(): void {
    const group = viewGroup();
    expect(group).toHaveAttribute('data-mock-x', '0');
    expect(group).toHaveAttribute('data-mock-y', '0');
    expect(group).toHaveAttribute('data-mock-scale-x', '1');
    expect(group).toHaveAttribute('data-mock-scale-y', '1');
    // 100 % rendering: the page border is 1 logical px.
    expect(pageRect()).toHaveAttribute('data-mock-stroke-width', '1');
  }

  it('paints the 100 % identity frame while capturing and returns to the live view after', () => {
    seedDocument([]);
    renderWithChakra(<WireframeCanvasImpl />);
    // The first commit fits the page; drive the live transform under test.
    act(() => setView(LIVE_VIEW));

    expectLiveFrame();

    act(() => beginCaptureView());
    expectIdentityFrame();
    // The live view is untouched: it is a paint override only.
    expect(getSnapshot().view).toEqual(LIVE_VIEW);

    act(() => endCaptureView());
    expectLiveFrame();
    expect(getSnapshot().captureView).toBeNull();
    expect(getSnapshot().view).toEqual(LIVE_VIEW);
  });
});

describe('bubbled element drag (E-16)', () => {
  it('leaves the view untouched and still commits exactly one element move', () => {
    seedDocument([textElement()], ['el-text']);
    renderWithChakra(<WireframeCanvasImpl />);
    act(() => setView({ scale: 1, x: 175, y: 30.5 }));

    const viewGroup = konvaMock.groups.get('wireframe-view');
    expect(viewGroup).toBeDefined();

    const viewBefore = JSON.stringify(getSnapshot().view);
    const elementNode = elementGroup().node;
    const panNode = { x: () => 175, y: () => 30.5 };

    act(() => {
      // The element's own drag commits its geometry...
      elementGroup().props.onDragStart();
      elementNode.x(520);
      elementNode.y(406);
      elementGroup().props.onDragEnd();
      // ...then Konva bubbles dragstart/dragend to the pan group, where the
      // target is the element and the currentTarget is the pan group (E-16).
      viewGroup!.props.onDragStart({ target: elementNode, currentTarget: panNode });
      viewGroup!.props.onDragEnd({ target: elementNode, currentTarget: panNode });
    });

    expect(JSON.stringify(getSnapshot().view)).toBe(viewBefore);
    expect(getSnapshot().document.elements[0]).toMatchObject({ x: 520, y: 406 });
    expect(getSnapshot().canUndo).toBe(true);

    act(() => undo());
    expect(getSnapshot().document.elements[0]).toMatchObject({ x: 480, y: 376 });
    expect(getSnapshot().canUndo).toBe(false);
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
