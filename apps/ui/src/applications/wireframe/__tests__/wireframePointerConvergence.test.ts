/**
 * Pointer ↔ keyboard convergence (Spec #3119, ST-5 / R-6, AC6).
 *
 * Every canvas pointer gesture — create drag, element drag, transformer resize
 * and pan — commits through the DECLARED verb the keyboard path resolves, via
 * `host.runVerb(..., 'pointer', …)`. The canvas keeps the geometry/snap/guide
 * math and commits exactly ONE journal entry per gesture; it reads the cached
 * place slice and never subscribes to the journal.
 *
 * Konva is mocked (the same harness shape as `WireframeCanvas.test.tsx`): shape
 * components render inert divs and the Stage / element-Group / Transformer props
 * are exposed through a module-scoped registry, so the REAL canvas + the REAL
 * navigation host + the REAL store are driven end to end.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { ChakraProvider, createSystem, defaultBaseConfig } from '@chakra-ui/react';
import React from 'react';

import { resetHotkeyAnnouncer } from '@/shared/hotkeys/announcer';
import { resetNavigationAnnouncer } from '@/shared/navigation/ui';
import type { NavigationHost } from '@/shared/navigation/ui';
import { WireframeCanvasImpl } from '../components/WireframeCanvasImpl';
import {
  WireframeNavigationProvider,
  useWireframeNavigation,
  wireframeStrokeTarget,
} from '../components/WireframeNavigationProvider';
import { createNewWireframeDocument, type WireframeDocument } from '../model/document';
import type { WireframeElement } from '../model/elements';
import {
  getNavigationJournal,
  getSnapshot,
  loadDocument,
  resetWireframeStoreForTests,
  selectMany,
  setPanMode,
  setView,
} from '../store/wireframeDocumentStore';
import {
  beginWireframeShapeCreate,
  getArmedWireframeShape,
  resetWireframeSurfaceForTests,
  wireframeSurface,
} from '../wireframeSurface';

/* ───────────────────────────── Konva mock ───────────────────────────── */

interface MockNode {
  attrs: Record<string, any>;
  getLayer: () => { batchDraw: () => void };
  getStage: () => MockNode;
  forceUpdate: () => void;
  [key: string]: any;
}

const konvaMock = vi.hoisted(() => ({
  stageProps: null as null | Record<string, any>,
  pointer: { x: 0, y: 0 },
  groups: new Map<string, { props: Record<string, any>; node: Record<string, any> }>(),
  transformer: null as null | { props: Record<string, any> },
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
      getPointerPosition: () => ({ x: konvaMock.pointer.x, y: konvaMock.pointer.y }),
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
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [],
    );
    if (props.name) konvaMock.groups.set(props.name, { props, node });
    React.useImperativeHandle(ref, () => node, [node]);
    return React.createElement(
      'div',
      {
        'data-mock-group': props.name ?? 'group',
        'data-draggable': String(props.draggable ?? false),
        'data-mock-x': props.x === undefined ? '' : String(props.x),
        'data-mock-y': props.y === undefined ? '' : String(props.y),
      },
      props.children,
    );
  });

  const Transformer = React.forwardRef(function MockTransformer(props: any, ref: any) {
    const api = {
      nodes: () => [],
      getLayer: () => ({ batchDraw: () => undefined }),
      forceUpdate: () => undefined,
    };
    konvaMock.transformer = { props };
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

/* ───────────────────────────── harness ───────────────────────────── */

const testSystem = createSystem({
  ...defaultBaseConfig,
  disableLayers: true,
  preflight: false,
  globalCss: {},
});

let hostRef: NavigationHost | null = null;

/** Captures the provider's ONE host so the test can drive the keyboard path. */
function HostProbe(): null {
  hostRef = useWireframeNavigation().host;
  return null;
}

function renderCanvas(): void {
  render(
    React.createElement(
      ChakraProvider,
      { value: testSystem },
      React.createElement(
        WireframeNavigationProvider,
        null,
        React.createElement(HostProbe),
        React.createElement(WireframeCanvasImpl),
      ),
    ),
  );
  // 100 % / origin so stage coordinates equal page coordinates.
  act(() => setView({ scale: 1, x: 0, y: 0 }));
}

function host(): NavigationHost {
  if (hostRef === null) throw new Error('navigation host not mounted');
  return hostRef;
}

function journalEntries() {
  return getNavigationJournal().entries();
}

function lastEntry() {
  const entries = journalEntries();
  return entries[entries.length - 1];
}

function shapeElement(
  id: string,
  geometry: { x: number; y: number; width: number; height: number },
): WireframeElement {
  return {
    id,
    type: 'shape',
    shape: 'rect',
    ...geometry,
    visible: true,
    locked: false,
    fill: 'muted',
    border: 'thin',
    radius: 'm',
  };
}

function seedDocument(elements: WireframeElement[], selectedIds?: string[]): void {
  const document: WireframeDocument = {
    ...createNewWireframeDocument('desktop'),
    elements,
  };
  loadDocument(document, 'C:/tmp/wireframe.wireframe.json');
  if (selectedIds !== undefined && selectedIds.length > 0) selectMany(selectedIds);
}

function elementGroup(id: string): { props: Record<string, any>; node: Record<string, any> } {
  const entry = konvaMock.groups.get(`wireframe-element-${id}`);
  if (entry === undefined) throw new Error(`element group ${id} not mounted`);
  return entry;
}

function transformerProps(): Record<string, any> {
  if (konvaMock.transformer === null) throw new Error('transformer not mounted');
  return konvaMock.transformer.props;
}

interface FakeStage {
  getPointerPosition: () => { x: number; y: number };
  getStage: () => FakeStage;
}

const fakeStage: FakeStage = {
  getPointerPosition: () => ({ x: konvaMock.pointer.x, y: konvaMock.pointer.y }),
  getStage: () => fakeStage,
};

function stageProps(): Record<string, any> {
  if (konvaMock.stageProps === null) throw new Error('stage not mounted');
  return konvaMock.stageProps;
}

function pointerDown(x: number, y: number): void {
  konvaMock.pointer.x = x;
  konvaMock.pointer.y = y;
  act(() => {
    stageProps().onPointerDown({
      type: 'pointerdown',
      evt: { button: 0 },
      target: fakeStage,
      currentTarget: fakeStage,
      pointerId: 1,
      cancelBubble: false,
    });
  });
}

function pointerMove(x: number, y: number): void {
  konvaMock.pointer.x = x;
  konvaMock.pointer.y = y;
  act(() => {
    stageProps().onPointerMove({ evt: { button: 0 }, target: fakeStage, currentTarget: fakeStage });
  });
}

/** Down → move(s) → up; the host commit lands in the same flush. */
async function dragCreate(
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  pointerDown(from.x, from.y);
  pointerMove((from.x + to.x) / 2, (from.y + to.y) / 2);
  pointerMove(to.x, to.y);
  await act(async () => {
    stageProps().onPointerUp({
      evt: { button: 0 },
      target: fakeStage,
      currentTarget: fakeStage,
    });
  });
}

beforeEach(() => {
  resetWireframeStoreForTests();
  resetWireframeSurfaceForTests();
  resetHotkeyAnnouncer();
  resetNavigationAnnouncer();
  hostRef = null;
  konvaMock.stageProps = null;
  konvaMock.pointer = { x: 0, y: 0 };
  konvaMock.groups.clear();
  konvaMock.transformer = null;

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
});

afterEach(() => {
  cleanup();
  resetWireframeStoreForTests();
  resetWireframeSurfaceForTests();
  resetHotkeyAnnouncer();
  resetNavigationAnnouncer();
  hostRef = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/* ───────────────────────────── create ───────────────────────────── */

describe('pointer convergence (R-6 / AC6)', () => {
  it('create by drag commits the declared create verb once', async () => {
    seedDocument([]);
    renderCanvas();
    act(() => beginWireframeShapeCreate('rect'));
    expect(getArmedWireframeShape()).toBe('rect');

    await dragCreate({ x: 100, y: 80 }, { x: 340, y: 240 });

    const entries = journalEntries();
    expect(entries).toHaveLength(1);
    expect(lastEntry()).toMatchObject({
      verbId: 'wireframe.create.rect',
      actor: 'human',
      channel: 'pointer',
      effect: 'mutation',
    });

    const state = getSnapshot();
    expect(state.document.elements).toHaveLength(1);
    expect(state.document.elements[0]).toMatchObject({
      type: 'shape',
      shape: 'rect',
      x: 100,
      y: 80,
      width: 240,
      height: 160,
    });
    expect(state.selectedIds).toEqual([state.document.elements[0].id]);
    // The verb clears the armed kind; the shell renders `data-wireframe-arm="none"`.
    expect(getArmedWireframeShape()).toBeNull();
  });

  it('element drag commits wireframe.element.move once', async () => {
    seedDocument(
      [
        shapeElement('a', { x: 100, y: 100, width: 80, height: 60 }),
        shapeElement('b', { x: 300, y: 100, width: 80, height: 60 }),
      ],
      ['a', 'b'],
    );
    renderCanvas();

    const leader = elementGroup('a');
    act(() => leader.props.onDragStart());
    act(() => {
      leader.node.x(140);
      leader.node.y(130);
      leader.props.onDragMove();
    });
    await act(async () => {
      leader.props.onDragEnd();
    });

    const entries = journalEntries();
    expect(entries).toHaveLength(1);
    expect(lastEntry()).toMatchObject({
      verbId: 'wireframe.element.move',
      channel: 'pointer',
      effect: 'mutation',
    });

    const byId = new Map(getSnapshot().document.elements.map((element) => [element.id, element]));
    expect(byId.get('a')).toMatchObject({ x: 140, y: 130 });
    expect(byId.get('b')).toMatchObject({ x: 340, y: 130 });
  });

  it('resize commits wireframe.element.resize once', async () => {
    seedDocument([shapeElement('a', { x: 100, y: 100, width: 80, height: 60 })], ['a']);
    renderCanvas();

    act(() => transformerProps().onTransformStart());
    const node = elementGroup('a').node;
    await act(async () => {
      node.scaleX(2);
      node.scaleY(1.5);
      transformerProps().onTransformEnd();
    });

    const entries = journalEntries();
    expect(entries).toHaveLength(1);
    expect(lastEntry()).toMatchObject({
      verbId: 'wireframe.element.resize',
      channel: 'pointer',
      effect: 'mutation',
    });

    expect(getSnapshot().document.elements[0]).toMatchObject({
      x: 100,
      y: 100,
      width: 160,
      height: 90,
    });
    // Konva's transform is folded into the model and the node is re-pinned.
    expect(node.scaleX()).toBe(1);
    expect(node.scaleY()).toBe(1);
  });

  it('pan commits wireframe.view.panBy as one navigation entry', async () => {
    seedDocument([shapeElement('a', { x: 100, y: 100, width: 80, height: 60 })], ['a']);
    act(() => setPanMode(true));
    renderCanvas();

    const documentBefore = getSnapshot().document;
    const documentJsonBefore = JSON.stringify(documentBefore);
    const viewGroup = konvaMock.groups.get('wireframe-view');
    if (viewGroup === undefined) throw new Error('pan group not mounted');
    const panNode = { x: () => -80, y: () => -40 };

    await act(async () => {
      viewGroup.props.onDragStart({ target: panNode, currentTarget: panNode });
      viewGroup.props.onDragEnd({ target: panNode, currentTarget: panNode });
    });

    const entries = journalEntries();
    expect(entries).toHaveLength(1);
    expect(lastEntry()).toMatchObject({
      verbId: 'wireframe.view.panBy',
      channel: 'pointer',
      effect: 'navigation',
      patch: null,
    });

    const after = getSnapshot();
    expect(after.view).toMatchObject({ x: -80, y: -40 });
    // A pan never touches the document or its selection.
    expect(after.document).toBe(documentBefore);
    expect(JSON.stringify(after.document)).toBe(documentJsonBefore);
    expect(after.selectedIds).toEqual(['a']);
    expect(after.canUndo).toBe(false);
  });

  /* ─────────────────────────── equivalence ─────────────────────────── */

  it('a pointer commit and its keyboard equivalent journal the same verb id', async () => {
    seedDocument([]);
    renderCanvas();

    // Keyboard path: `c` enters the Create place; `r` resolves to the declared
    // create verb and arms it (a noop — no journal entry).
    await act(async () => {
      await host().runVerb('wireframe.create', 'keyboard');
    });
    expect(host().getSnapshot().context.placePath).toEqual([
      'wireframe.canvas',
      'wireframe.create',
    ]);
    expect(wireframeStrokeTarget(host(), 'r')).toBe('wireframe.create.rect');
    await act(async () => {
      await host().handleStroke('r', 0);
    });
    expect(getArmedWireframeShape()).toBe('rect');
    expect(journalEntries()).toHaveLength(1); // the create-place entry only

    // Pointer path: the drag commit must journal the SAME verb id.
    await dragCreate({ x: 120, y: 90 }, { x: 300, y: 230 });

    const pointerEntry = lastEntry();
    expect(pointerEntry).toMatchObject({
      verbId: 'wireframe.create.rect',
      channel: 'pointer',
      placePath: ['wireframe.canvas', 'wireframe.create'],
    });
    // The keyboard stroke still resolves to the same id (the direct alias).
    expect(pointerEntry.verbId).toBe(wireframeStrokeTarget(host(), 'r'));
    const descriptor = wireframeSurface.verbs.find((verb) => verb.id === pointerEntry.verbId);
    expect(descriptor).toBeDefined();
    expect(descriptor!.appliesTo.places).toContain(
      pointerEntry.placePath[pointerEntry.placePath.length - 1],
    );
    // The transient place auto-exits exactly once.
    expect(host().getSnapshot().context.placePath).toEqual(['wireframe.canvas']);
  });

  /* ─────────────────────────── no journal read ─────────────────────────── */

  it('the canvas reads a derived place view and never the journal', () => {
    const rawModules = import.meta.glob(
      '/src/applications/wireframe/components/WireframeCanvasImpl.tsx',
      { query: '?raw', import: 'default', eager: true },
    ) as Record<string, string>;
    const source = Object.values(rawModules)[0] ?? '';
    expect(source.length).toBeGreaterThan(0);

    // The cached place slice, not the host/journal snapshot.
    expect(source).toContain('useWireframePlaceView');
    expect(source).not.toContain('useNavigationHostSnapshot');
    expect(source).not.toContain('buildActivityTrailModel');
    expect(source).not.toContain('getNavigationJournal');
    expect(source).not.toContain('JournalStore');
    // No second keydown handler (R-j) and no direct store funnel from the canvas.
    expect(source).not.toContain('onKeyDown');
    expect(source).not.toMatch(/\bdispatch\s*\(/);
  });
});
