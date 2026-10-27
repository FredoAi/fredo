/**
 * Wireframe canvas implementation (Spec #3070, ST-2; extended by Spec #3071, ST-5).
 *
 * Loaded lazily by `WireframeCanvas.tsx` so `konva` / `react-konva` stay out of
 * the eager startup chunk (F-56). Renders the document as the visible page,
 * provides multi-selection (shift-click), group drag/resize committed as ONE
 * mutation, snap-to-grid on drop and ephemeral smart alignment guides, and
 * consumes the store's view transform.
 *
 * Performance contract (UI/UX section 9): pointer moves update Konva node
 * attributes imperatively — no React state is written per move — and exactly
 * ONE store step is committed on release. The guide overlay and the
 * `data-wireframe-guides` host attribute are written imperatively too.
 *
 * Colour contract: every painted colour comes from `useCanvasPalette()`; this
 * file contains no colour literal and no `var(--x)NN` alpha-append.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Box, Skeleton, Text, VisuallyHidden } from '@chakra-ui/react';
import {
  Circle,
  Ellipse,
  Group,
  Layer,
  Line,
  Path,
  Rect,
  Shape,
  Stage,
  Text as KonvaText,
  Transformer,
} from 'react-konva';
import type Konva from 'konva';

import {
  ELEMENT_MIN_SIZE,
  clamp,
  roundTo1dp,
  type WireframeRect,
} from '../model/geometry';
import {
  WIREFRAME_GRID_SIZE_PX,
  computeAlignmentGuides,
  selectionBounds,
  snapValueToGrid,
  type WireframeGuide,
} from '../model/arrange';
import type {
  WireframeBorderWidth,
  WireframeElement,
  WireframeElementPatch,
  WireframeRadius,
  WireframeSectionPreset,
  WireframeTextSize,
} from '../model/elements';
import { findWireframeIcon } from '../model/icons';
import {
  clearSelection,
  dispatch,
  fitPageToViewport,
  getSnapshot,
  isElementMovable,
  primarySelectedId,
  registerCanvasStage,
  select,
  setView,
  subscribe,
  toggleSelect,
} from '../store/wireframeDocumentStore';
import {
  CAPTURE_HIDDEN_NAME,
  WIREFRAME_GUIDES_LAYER_NAME,
  WIREFRAME_PAGE_NAME,
  registerWireframeStage,
} from '../canvas/wireframeCanvasRegistry';
import { useCanvasPalette, type CanvasPalette } from '../theme/useCanvasPalette';

/**
 * Pointer modifier that toggles an element in/out of the selection (R-1.1 /
 * R-1.2). The Konva event carries the native mouse event, whose `shiftKey` is
 * the observable.
 */
export const SELECTION_TOGGLE_MODIFIER = 'shift';

/**
 * The number of smart-guide `Line` slots painted on the guides layer. A guide
 * is produced per matched feature per axis (leading edge / centre / trailing
 * edge) so six is the mathematical maximum.
 */
export const GUIDE_POOL_SIZE = 6;

/** The native event a Konva pointer event wraps; only `shiftKey` is read. */
function isSelectionToggle(
  event: Konva.KonvaEventObject<MouseEvent | TouchEvent> | undefined,
): boolean {
  const native = event?.evt as { shiftKey?: boolean } | undefined;
  return SELECTION_TOGGLE_MODIFIER === 'shift' && Boolean(native?.shiftKey);
}

/**
 * One drag GESTURE's immutable start positions, keyed by element id. The
 * session is gesture-scoped, not leader-keyed: a multi-node Transformer
 * proxy-drag fires one `dragstart` per attached node, so the start map covers
 * every movable member and the commit is deferred to the last release.
 */
interface DragSession {
  start: Map<string, { x: number; y: number }>;
}

/** Logical text size per `WireframeTextSize` preset (UI/UX section 1.5). */
export const TEXT_SIZE_PX: Readonly<Record<WireframeTextSize, number>> = {
  s: 12,
  m: 14,
  l: 18,
  xl: 24,
};

/** Heading scale multiplier (UI/UX section 1.5). */
const HEADING_SCALE = 1.25;

const RADIUS_PX: Readonly<Record<WireframeRadius, number>> = {
  none: 0,
  s: 4,
  m: 8,
  l: 12,
};

const BORDER_WIDTH_PX: Readonly<Record<WireframeBorderWidth, number>> = {
  none: 0,
  thin: 1,
  thick: 3,
};

const SECTION_CAPTION: Readonly<Record<WireframeSectionPreset, string>> = {
  header: 'Header',
  navbar: 'Nav bar',
  sidebar: 'Sidebar',
  footer: 'Footer',
};

const TRANSFORMER_ANCHORS = [
  'top-left',
  'top-center',
  'top-right',
  'middle-left',
  'middle-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
] as const;

const EMPTY_HINT =
  'Add an element from the toolbar, or ask the Companion to draft a wireframe.';
const CANVAS_INSTRUCTIONS =
  'Arrow keys select the next or previous element; edits are made with the toolbar, the property panel or their shortcuts.';

interface CanvasSize {
  width: number;
  height: number;
}

/** A single decorative child never receives pointer events (UI/UX section 2.4). */
const DECORATIVE = { listening: false } as const;

function renderTextBody(element: Extract<WireframeElement, { type: 'text' }>, palette: CanvasPalette): ReactElement {
  const heading = element.textStyle === 'heading';
  const fontSize = TEXT_SIZE_PX[element.size] * (heading ? HEADING_SCALE : 1);

  return (
    <Group
      clipX={0}
      clipY={0}
      clipWidth={element.width}
      clipHeight={element.height}
      {...DECORATIVE}
    >
      <KonvaText
        text={element.text}
        width={element.width}
        height={element.height}
        fill={palette.text}
        fontSize={fontSize}
        fontStyle={heading ? '600' : 'normal'}
        fontFamily="sans-serif"
        align={element.align}
        verticalAlign="middle"
        wrap="word"
        {...DECORATIVE}
      />
    </Group>
  );
}

function renderButtonBody(
  element: Extract<WireframeElement, { type: 'button' }>,
  palette: CanvasPalette,
): ReactElement {
  const primary = element.appearance === 'primary';
  const secondary = element.appearance === 'secondary';
  const fill = primary ? palette.accent : secondary ? palette.surface : undefined;
  const labelColor = primary ? palette.onAccent : palette.text;

  return (
    <Group {...DECORATIVE}>
      <Rect
        width={element.width}
        height={element.height}
        cornerRadius={RADIUS_PX.m}
        fill={fill}
        stroke={secondary ? palette.border : undefined}
        strokeWidth={secondary ? 1 : 0}
        {...DECORATIVE}
      />
      <KonvaText
        text={element.label}
        width={element.width}
        height={element.height}
        align="center"
        verticalAlign="middle"
        fontSize={14}
        fontStyle="500"
        fontFamily="sans-serif"
        fill={labelColor}
        {...DECORATIVE}
      />
    </Group>
  );
}

function renderInputBody(
  element: Extract<WireframeElement, { type: 'input' }>,
  palette: CanvasPalette,
): ReactElement {
  const padding = 12;
  return (
    <Group {...DECORATIVE}>
      <Rect
        width={element.width}
        height={element.height}
        cornerRadius={RADIUS_PX.s}
        fill={palette.surface}
        stroke={palette.border}
        strokeWidth={1}
        {...DECORATIVE}
      />
      <KonvaText
        text={element.placeholder}
        x={padding}
        y={0}
        width={Math.max(0, element.width - padding * 2)}
        height={element.height}
        verticalAlign="middle"
        fontSize={14}
        fontFamily="sans-serif"
        fill={palette.textMuted}
        {...DECORATIVE}
      />
    </Group>
  );
}

function renderImageBody(
  element: Extract<WireframeElement, { type: 'image' }>,
  palette: CanvasPalette,
): ReactElement {
  return (
    <Group {...DECORATIVE}>
      <Rect
        width={element.width}
        height={element.height}
        fill={palette.surface}
        stroke={palette.border}
        strokeWidth={1}
        {...DECORATIVE}
      />
      <Line
        points={[0, 0, element.width, element.height]}
        stroke={palette.border}
        strokeWidth={1}
        {...DECORATIVE}
      />
      <Line
        points={[element.width, 0, 0, element.height]}
        stroke={palette.border}
        strokeWidth={1}
        {...DECORATIVE}
      />
      <KonvaText
        text="Image"
        width={element.width}
        height={element.height}
        align="center"
        verticalAlign="middle"
        fontSize={12}
        fontFamily="sans-serif"
        fill={palette.textMuted}
        {...DECORATIVE}
      />
    </Group>
  );
}

function renderIconBody(
  element: Extract<WireframeElement, { type: 'icon' }>,
  palette: CanvasPalette,
): ReactElement {
  const icon = findWireframeIcon(element.iconId);
  const scale = (Math.min(element.width, element.height) * 0.8) / 24;

  return (
    <Group {...DECORATIVE}>
      <Path
        data={icon.path}
        x={(element.width - 24 * scale) / 2}
        y={(element.height - 24 * scale) / 2}
        scaleX={scale}
        scaleY={scale}
        fill={palette.text}
        {...DECORATIVE}
      />
    </Group>
  );
}

function renderCardBody(
  element: Extract<WireframeElement, { type: 'card' }>,
  palette: CanvasPalette,
): ReactElement {
  const padding = 12;
  return (
    <Group {...DECORATIVE}>
      <Rect
        width={element.width}
        height={element.height}
        cornerRadius={RADIUS_PX.m}
        fill={palette.surface}
        stroke={palette.border}
        strokeWidth={1}
        {...DECORATIVE}
      />
      <KonvaText
        text={element.label}
        x={padding}
        y={padding}
        width={Math.max(0, element.width - padding * 2)}
        height={Math.max(0, element.height - padding * 2)}
        fontSize={14}
        fontStyle="500"
        fontFamily="sans-serif"
        fill={palette.text}
        {...DECORATIVE}
      />
    </Group>
  );
}

function renderSectionMotif(
  element: Extract<WireframeElement, { type: 'section' }>,
  palette: CanvasPalette,
): ReactNode {
  const { width, height } = element;

  switch (element.preset) {
    case 'header':
      return (
        <>
          <Line
            points={[0, height - 0.5, width, height - 0.5]}
            stroke={palette.border}
            strokeWidth={1}
            {...DECORATIVE}
          />
          <Rect
            x={16}
            y={Math.max(0, height / 2 - 10)}
            width={20}
            height={20}
            cornerRadius={RADIUS_PX.s}
            fill={palette.accent}
            {...DECORATIVE}
          />
        </>
      );
    case 'navbar':
      return (
        <>
          <Circle
            x={24}
            y={height / 2}
            radius={Math.max(0, Math.min(8, height / 2 - 4))}
            fill={palette.accent}
            {...DECORATIVE}
          />
          <Rect
            x={Math.max(0, width - 64)}
            y={height / 2 - 4}
            width={48}
            height={8}
            cornerRadius={4}
            fill={palette.muted}
            {...DECORATIVE}
          />
          <Rect
            x={Math.max(0, width - 116)}
            y={height / 2 - 4}
            width={36}
            height={8}
            cornerRadius={4}
            fill={palette.muted}
            {...DECORATIVE}
          />
          <Rect
            x={Math.max(0, width - 148)}
            y={height / 2 - 4}
            width={24}
            height={8}
            cornerRadius={4}
            fill={palette.muted}
            {...DECORATIVE}
          />
        </>
      );
    case 'sidebar': {
      const barWidth = Math.max(0, Math.min(width - 32, 160));
      return (
        <>
          {[0, 1, 2, 3].map((index) => (
            <Rect
              key={`sidebar-bar-${index}`}
              x={16}
              y={40 + index * 28}
              width={barWidth}
              height={10}
              cornerRadius={4}
              fill={palette.muted}
              {...DECORATIVE}
            />
          ))}
        </>
      );
    }
    case 'footer':
    default:
      return (
        <>
          <Line
            points={[0, 0.5, width, 0.5]}
            stroke={palette.border}
            strokeWidth={1}
            {...DECORATIVE}
          />
          <Rect
            x={16}
            y={Math.max(0, height - 28)}
            width={72}
            height={10}
            cornerRadius={4}
            fill={palette.muted}
            {...DECORATIVE}
          />
          <Rect
            x={104}
            y={Math.max(0, height - 28)}
            width={56}
            height={10}
            cornerRadius={4}
            fill={palette.muted}
            {...DECORATIVE}
          />
          <Rect
            x={176}
            y={Math.max(0, height - 28)}
            width={40}
            height={10}
            cornerRadius={4}
            fill={palette.muted}
            {...DECORATIVE}
          />
        </>
      );
  }
}

function renderSectionBody(
  element: Extract<WireframeElement, { type: 'section' }>,
  palette: CanvasPalette,
): ReactElement {
  return (
    <Group {...DECORATIVE}>
      <Rect
        width={element.width}
        height={element.height}
        fill={palette.surface}
        stroke={palette.border}
        strokeWidth={1}
        {...DECORATIVE}
      />
      <KonvaText
        text={SECTION_CAPTION[element.preset]}
        x={16}
        y={12}
        width={Math.max(0, element.width - 32)}
        fontSize={12}
        fontFamily="sans-serif"
        fill={palette.textMuted}
        {...DECORATIVE}
      />
      {renderSectionMotif(element, palette)}
    </Group>
  );
}

function renderShapeBody(
  element: Extract<WireframeElement, { type: 'shape' }>,
  palette: CanvasPalette,
): ReactElement {
  const fill = palette[element.fill];
  const strokeWidth = BORDER_WIDTH_PX[element.border];
  const stroke = strokeWidth > 0 ? palette.text : undefined;

  switch (element.shape) {
    case 'ellipse':
      return (
        <Ellipse
          x={element.width / 2}
          y={element.height / 2}
          radiusX={element.width / 2}
          radiusY={element.height / 2}
          fill={fill}
          stroke={stroke}
          strokeWidth={strokeWidth}
          {...DECORATIVE}
        />
      );
    case 'triangle':
      return (
        <Line
          points={[element.width / 2, 0, element.width, element.height, 0, element.height]}
          closed
          fill={fill}
          stroke={stroke}
          strokeWidth={strokeWidth}
          {...DECORATIVE}
        />
      );
    case 'rect':
    default:
      return (
        <Rect
          width={element.width}
          height={element.height}
          cornerRadius={RADIUS_PX[element.radius]}
          fill={fill}
          stroke={stroke}
          strokeWidth={strokeWidth}
          {...DECORATIVE}
        />
      );
  }
}

function renderLineBody(
  element: Extract<WireframeElement, { type: 'line' }>,
  palette: CanvasPalette,
): ReactElement {
  return (
    <Line
      points={[0, element.height / 2, element.width, element.height / 2]}
      stroke={palette.border}
      strokeWidth={2}
      lineCap="round"
      {...DECORATIVE}
    />
  );
}

/** Painted body of one element (UI/UX section 2.8). */
function renderElementBody(element: WireframeElement, palette: CanvasPalette): ReactNode {
  switch (element.type) {
    case 'text':
      return renderTextBody(element, palette);
    case 'button':
      return renderButtonBody(element, palette);
    case 'input':
      return renderInputBody(element, palette);
    case 'image':
      return renderImageBody(element, palette);
    case 'icon':
      return renderIconBody(element, palette);
    case 'card':
      return renderCardBody(element, palette);
    case 'section':
      return renderSectionBody(element, palette);
    case 'shape':
      return renderShapeBody(element, palette);
    case 'line':
      return renderLineBody(element, palette);
    default:
      return null;
  }
}

function roundPositive(value: number): number {
  return Math.max(ELEMENT_MIN_SIZE, roundTo1dp(value));
}

export function WireframeCanvasImpl(): ReactElement {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const { document: wireframe, selectedIds, view, panMode, captureView, snapToGrid } = state;
  const primaryId = primarySelectedId(state);
  const palette = useCanvasPalette();

  const containerRef = useRef<HTMLDivElement>(null);
  // Mutable: the capture registry is bound from the same ref callback the
  // Stage's forwarded ref uses (see `bindStage`).
  const stageRef = useRef<Konva.Stage | null>(null);
  const transformerRef = useRef<Konva.Transformer>(null);
  const elementNodes = useRef<Map<string, Konva.Group>>(new Map());
  // Imperative guide slots on the capture-hidden guides layer (never React state).
  const guideLineRefs = useRef<Array<Konva.Line | null>>([]);
  const dragSessionRef = useRef<DragSession | null>(null);
  // Count of nodes Konva is CURRENTLY dragging in the active gesture. A
  // multi-node Transformer proxy-drag starts (and ends) one drag per attached
  // node, so the session is built once (on the first start) and the single
  // store commit fires when this returns to 0 (R-1.4 / NFR-4).
  const activeDragCountRef = useRef(0);
  const transformStartBoxRef = useRef<WireframeRect | null>(null);
  const measuredRef = useRef<CanvasSize>({ width: 0, height: 0 });
  const didFitRef = useRef(false);

  const [size, setSize] = useState<CanvasSize>({ width: 0, height: 0 });

  // The Konva Stage must never be committed at a zero width/height: its first
  // draw composites the artboard through a 0x0 buffer canvas, and Chromium
  // throws `InvalidStateError` from `drawImage` when the source canvas has a
  // zero dimension (round 1 crash, Spec #3070). The seed state stays `{0,0}`;
  // the stage is only mounted once the host has measured a real size.
  const stageReady = size.width > 0 && size.height > 0;

  const selectedIdSet = new Set(selectedIds);
  const selectedElementList = wireframe.elements.filter((element) =>
    selectedIdSet.has(element.id),
  );
  // A HIDDEN element is never bound to the Transformer: Konva's
  // `Container.getClientRect` returns a 0x0 rect at the origin for a node with
  // no visible shape, which would corrupt the union box of a mixed selection.
  // This keeps the shipped Slice-1 rule (`!visible` ⇒ no handles).
  const transformableElementIds = selectedElementList
    .filter((element) => element.visible)
    .map((element) => element.id);
  const hasMovableSelection = selectedElementList.some(
    (element) => element.visible && isElementMovable(wireframe, element),
  );

  const scale = view.scale > 0 ? view.scale : 1;

  // ── Paint transform (capture override, F-33) ─────────────────────────────
  // While `exportPng()` holds a capture view, the canvas paints the 100 %
  // identity frame so the page-node capture is exact by construction. With no
  // override (`captureView === null`) these are the live-view values, so the
  // rendered props are byte-identical to the normal canvas.
  const paintView = captureView ?? view;
  const paintScale = paintView.scale > 0 ? paintView.scale : 1;

  // ── Measurement + fit-on-open ─────────────────────────────────────────────
  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const measure = (): void => {
      const rect = element.getBoundingClientRect();
      const width = Math.max(0, Math.round(rect.width));
      const height = Math.max(0, Math.round(rect.height));
      const previous = measuredRef.current;
      if (previous.width !== width || previous.height !== height) {
        measuredRef.current = { width, height };
        setSize({ width, height });
      }
      registerCanvasStage({
        width: () => measuredRef.current.width,
        height: () => measuredRef.current.height,
      });
      if (!didFitRef.current && width > 0 && height > 0) {
        didFitRef.current = true;
        fitPageToViewport();
      }
    };

    measure();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => {
        window.removeEventListener('resize', measure);
        registerCanvasStage(null);
      };
    }

    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
      registerCanvasStage(null);
    };
  }, []);

  // ── Stage registry (export capture seam) ─────────────────────────────────
  // Bound as a ref CALLBACK, not by an effect that reads `stageRef`. react-konva
  // re-assigns the forwarded ref on every Stage create/destroy (StrictMode's dev
  // mount → unmount → mount, HMR, shrink-to-zero), so the registry follows the
  // instance the same way the React ref does. An effect keyed on `stageReady`
  // stored the FIRST (already destroyed) StrictMode instance and the export
  // captured a dead stage (round 2, F-33).
  const bindStage = useCallback((node: Konva.Stage | null): void => {
    stageRef.current = node;
    registerWireframeStage(node);
  }, []);

  // ── Stage cursor (pan mode) ──────────────────────────────────────────────
  useEffect(() => {
    const container = stageRef.current?.container();
    if (container) container.style.cursor = panMode ? 'grab' : 'default';
  }, [panMode, size.width, size.height]);

  // ── Transformer attachment (the WHOLE selection) ─────────────────────────
  // ONE Transformer is bound to every VISIBLE selected node; it is shown while
  // the selection is non-empty AND at least one member is movable AND pan mode
  // is off (R-1.4 / R-1.8). A fully locked (or fully hidden) selection detaches
  // it — the shipped Slice-1 "no handles to grab" rule.
  const showTransformer = selectedIds.length > 0 && hasMovableSelection && !panMode;

  useEffect(() => {
    const transformer = transformerRef.current;
    if (!transformer) return;
    const nodes = transformableElementIds
      .map((id) => elementNodes.current.get(id) ?? null)
      .filter((node): node is Konva.Group => node !== null);
    transformer.nodes(nodes);
    transformer.getLayer()?.batchDraw();
    // `transformableElementIds` is derived from `selectedIds` + `wireframe`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds, panMode, wireframe.elements, size.width, size.height]);

  const setStageCursor = useCallback((cursor: string): void => {
    const container = stageRef.current?.container();
    if (container) container.style.cursor = cursor;
  }, []);

  // ── Smart guides + `data-wireframe-guides` (imperative, never React state) ─
  const writeGuidesCount = useCallback((count: number): void => {
    const host = containerRef.current;
    if (host) host.setAttribute('data-wireframe-guides', String(count));
  }, []);

  const clearGuides = useCallback((): void => {
    for (const node of guideLineRefs.current) {
      if (node) node.visible(false);
    }
    guideLineRefs.current[0]?.getLayer()?.batchDraw();
    writeGuidesCount(0);
  }, [writeGuidesCount]);

  const paintGuides = useCallback(
    (guides: readonly WireframeGuide[]): void => {
      const nodes = guideLineRefs.current;
      for (let index = 0; index < nodes.length; index += 1) {
        const node = nodes[index];
        if (!node) continue;
        const guide = guides[index];
        if (!guide) {
          node.visible(false);
          continue;
        }
        // A guide on the x axis is a vertical line spanning the page height.
        node.points(
          guide.axis === 'x'
            ? [guide.position, 0, guide.position, wireframe.page.height]
            : [0, guide.position, wireframe.page.width, guide.position],
        );
        node.visible(true);
      }
      nodes[0]?.getLayer()?.batchDraw();
      writeGuidesCount(guides.length);
    },
    [wireframe.page.width, wireframe.page.height, writeGuidesCount],
  );

  // Guides never survive a gesture: drop, cancel or unmount (R-2.5).
  useEffect(() => () => clearGuides(), [clearGuides]);

  // ── Gestures ─────────────────────────────────────────────────────────────

  const handleElementClick = useCallback(
    (id: string) => (event: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
      if (event && typeof event === 'object') event.cancelBubble = true;
      if (panMode) return;
      if (isSelectionToggle(event)) {
        toggleSelect(id);
        return;
      }
      select(id);
    },
    [panMode],
  );

  const handleStageClick = useCallback(
    (event: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
      if (panMode) return;
      const stage = event.target.getStage();
      if (stage && event.target === stage) clearSelection();
    },
    [panMode],
  );

  /**
   * Reset every node in `ids` back to its committed model geometry. Konva's
   * Transformer applies a proportional transform (and, for a partially locked
   * group, also to the immovable members) — the model is the single source of
   * truth, so the nodes are re-synced after each gesture.
   */
  const resetNodesToModel = useCallback((ids: readonly string[]): void => {
    const snapshot = getSnapshot();
    const byId = new Map(snapshot.document.elements.map((element) => [element.id, element]));
    let layer: Konva.Layer | null = null;
    for (const id of ids) {
      const element = byId.get(id);
      const node = elementNodes.current.get(id);
      if (!element || !node) continue;
      node.x(element.x);
      node.y(element.y);
      node.width(element.width);
      node.height(element.height);
      node.scaleX(1);
      node.scaleY(1);
      layer = node.getLayer() ?? layer;
    }
    layer?.batchDraw();
  }, []);

  const handleDragStart = useCallback(
    (id: string) => (): void => {
      if (panMode) return;
      if (!getSnapshot().selectedIds.includes(id)) select(id);
      // Build the gesture session ONCE — on the first `dragstart`. Konva's
      // multi-node Transformer proxy-drag calls `startDrag()` on EVERY attached
      // node (including locked members, which `startDrag` drags regardless of
      // `draggable`), so a later start in the SAME gesture must not rebuild it.
      if (activeDragCountRef.current === 0) {
        const snapshot = getSnapshot();
        const byId = new Map(snapshot.document.elements.map((element) => [element.id, element]));
        const start = new Map<string, { x: number; y: number }>();
        for (const memberId of snapshot.selectedIds) {
          const element = byId.get(memberId);
          if (!element || !isElementMovable(snapshot.document, element)) continue;
          start.set(memberId, { x: element.x, y: element.y });
        }
        dragSessionRef.current = { start };
      }
      activeDragCountRef.current += 1;
    },
    [panMode],
  );

  // Pointer moves write Konva attributes only — no React state, no commit.
  const handleDragMove = useCallback(
    (id: string) => (): void => {
      if (panMode) return;
      const session = dragSessionRef.current;
      if (!session || !session.start.has(id)) return;
      const leaderNode = elementNodes.current.get(id);
      const leaderStart = session.start.get(id);
      if (!leaderNode || !leaderStart) return;

      const dx = leaderNode.x() - leaderStart.x;
      const dy = leaderNode.y() - leaderStart.y;
      const byId = new Map(wireframe.elements.map((element) => [element.id, element]));
      const movingRects: WireframeRect[] = [];
      for (const [memberId, startPos] of session.start) {
        const node = elementNodes.current.get(memberId);
        if (node && memberId !== id) {
          node.x(startPos.x + dx);
          node.y(startPos.y + dy);
        }
        const element = byId.get(memberId);
        movingRects.push({
          x: startPos.x + dx,
          y: startPos.y + dy,
          width: element?.width ?? 0,
          height: element?.height ?? 0,
        });
      }

      const moving = selectionBounds(movingRects);
      if (!moving) {
        clearGuides();
      } else {
        const others: WireframeRect[] = [];
        for (const element of wireframe.elements) {
          if (session.start.has(element.id)) continue;
          others.push({
            x: element.x,
            y: element.y,
            width: element.width,
            height: element.height,
          });
        }
        paintGuides(computeAlignmentGuides(moving, others));
      }
      leaderNode.getLayer()?.batchDraw();
    },
    [panMode, wireframe.elements, paintGuides, clearGuides],
  );

  const handleDragEnd = useCallback(
    (element: WireframeElement) => (): void => {
      clearGuides();
      if (panMode) return;
      // A gesture ends only when EVERY node Konva started dragging has
      // released: the multi-node Transformer proxy-drag fires one dragstart /
      // dragend pair per attached node, so the single store commit is deferred
      // to the last release (R-1.4 / NFR-4).
      activeDragCountRef.current = Math.max(0, activeDragCountRef.current - 1);
      if (activeDragCountRef.current > 0) return;

      const session = dragSessionRef.current;
      dragSessionRef.current = null;

      const snapshot = getSnapshot();
      const byId = new Map(snapshot.document.elements.map((item) => [item.id, item]));
      // A session already covers every MOVABLE selected member (built at
      // `dragstart`). The defensive no-session branch commits the single
      // dragged element and MUST honour movability — a locked member is never
      // committed, so it can never move (R-1.8).
      const targetIds = session
        ? Array.from(session.start.keys())
        : isElementMovable(snapshot.document, element)
          ? [element.id]
          : [];

      const rects = new Map<string, WireframeRect>();
      for (const id of targetIds) {
        const current = byId.get(id);
        if (!current) continue;
        const node = elementNodes.current.get(id);
        rects.set(id, {
          x: node ? roundTo1dp(node.x()) : current.x,
          y: node ? roundTo1dp(node.y()) : current.y,
          width: current.width,
          height: current.height,
        });
      }

      // Snap the selection's UNION-BOX ORIGIN to the nearest grid multiple
      // (clamped to the page) and apply that delta uniformly (R-2.2 / R-2.9).
      if (snapToGrid) {
        const union = selectionBounds([...rects.values()]);
        if (union) {
          const maxX = Math.max(0, snapshot.document.page.width - union.width);
          const maxY = Math.max(0, snapshot.document.page.height - union.height);
          const dx = clamp(snapValueToGrid(union.x), 0, maxX) - union.x;
          const dy = clamp(snapValueToGrid(union.y), 0, maxY) - union.y;
          if (dx !== 0 || dy !== 0) {
            for (const [id, rect] of rects) {
              rects.set(id, { ...rect, x: rect.x + dx, y: rect.y + dy });
            }
          }
        }
      }

      const patches: Record<string, WireframeElementPatch> = {};
      for (const [id, rect] of rects) {
        const current = byId.get(id);
        if (!current) continue;
        if (rect.x === current.x && rect.y === current.y) continue;
        patches[id] = { x: rect.x, y: rect.y };
      }
      if (Object.keys(patches).length > 0) {
        dispatch('elements.update', { patches });
      }

      // Re-pin EVERY selected node to the committed model — not only the
      // committed members. Konva proxy-drags a locked member VISUALLY during
      // the gesture, so the locked member is snapped back to its model
      // geometry the instant the gesture ends (R-1.8).
      resetNodesToModel(getSnapshot().selectedIds);
    },
    [panMode, snapToGrid, clearGuides, resetNodesToModel],
  );

  const handleTransformStart = useCallback((): void => {
    const snapshot = getSnapshot();
    const rects: WireframeRect[] = [];
    for (const id of snapshot.selectedIds) {
      const element = snapshot.document.elements.find((item) => item.id === id);
      if (!element || !element.visible) continue;
      const node = elementNodes.current.get(id);
      if (!node) continue;
      rects.push({
        x: node.x(),
        y: node.y(),
        width: node.width() * node.scaleX(),
        height: node.height() * node.scaleY(),
      });
    }
    transformStartBoxRef.current = selectionBounds(rects);
  }, []);

  // ONE `elements.update` on release: the union-box delta `(dx, dy, dw, dh)`
  // is applied to every MOVABLE member, the resize delta clamped so no member
  // falls below `ELEMENT_MIN_SIZE` (R-1.4 / R-1.8 / R-2.9).
  const handleTransformEnd = useCallback((): void => {
    const startBox = transformStartBoxRef.current;
    transformStartBoxRef.current = null;
    if (panMode) return;

    const snapshot = getSnapshot();
    const byId = new Map(snapshot.document.elements.map((element) => [element.id, element]));
    const selected = snapshot.selectedIds
      .map((id) => byId.get(id))
      .filter((element): element is WireframeElement => element !== undefined && element.visible);
    const movable = selected.filter((element) =>
      isElementMovable(snapshot.document, element),
    );

    const endRects: WireframeRect[] = [];
    for (const element of selected) {
      const node = elementNodes.current.get(element.id);
      if (!node) continue;
      endRects.push({
        x: node.x(),
        y: node.y(),
        width: node.width() * node.scaleX(),
        height: node.height() * node.scaleY(),
      });
    }
    const endBox = selectionBounds(endRects);

    const patches: Record<string, WireframeElementPatch> = {};
    if (startBox && endBox && movable.length > 0) {
      const minWidth = Math.min(...movable.map((element) => element.width));
      const minHeight = Math.min(...movable.map((element) => element.height));
      const deltaWidth = Math.max(endBox.width - startBox.width, ELEMENT_MIN_SIZE - minWidth);
      const deltaHeight = Math.max(endBox.height - startBox.height, ELEMENT_MIN_SIZE - minHeight);
      const deltaX = endBox.x - startBox.x;
      const deltaY = endBox.y - startBox.y;
      for (const element of movable) {
        const x = roundTo1dp(element.x + deltaX);
        const y = roundTo1dp(element.y + deltaY);
        const width = roundPositive(element.width + deltaWidth);
        const height = roundPositive(element.height + deltaHeight);
        if (
          x === element.x &&
          y === element.y &&
          width === element.width &&
          height === element.height
        ) {
          continue;
        }
        patches[element.id] = { x, y, width, height };
      }
    }
    if (Object.keys(patches).length > 0) {
      dispatch('elements.update', { patches });
    }

    resetNodesToModel(snapshot.selectedIds);
    transformerRef.current?.forceUpdate();
  }, [panMode, resetNodesToModel]);

  const handlePanDragStart = useCallback(
    (event: Konva.KonvaEventObject<DragEvent>) => {
      // Konva bubbles an element's drag events up to this ancestor group. Only
      // the pan group's OWN drag is a pan — a bubbled element dragstart must not
      // touch the cursor (E-16).
      if (event.target !== event.currentTarget) return;
      setStageCursor('grabbing');
    },
    [setStageCursor],
  );

  const handlePanDragEnd = useCallback(
    (event: Konva.KonvaEventObject<DragEvent>) => {
      // An element's `dragend` bubbles here; its target is the element, not the
      // pan group. Committing the element's absolute position as the view made
      // the page jump on every element drag (E-16).
      if (event.target !== event.currentTarget) return;
      const node = event.currentTarget as Konva.Group;
      setStageCursor('grab');
      setView({ scale, x: roundTo1dp(node.x()), y: roundTo1dp(node.y()) });
    },
    [scale, setStageCursor],
  );

  const handlePointerDown = useCallback((): void => {
    const active = document.activeElement;
    if (active && typeof (active as HTMLElement).blur === 'function') {
      (active as HTMLElement).blur();
    }
  }, []);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      if (event.key === 'Escape') {
        clearGuides();
        clearSelection();
        return;
      }
      const isNext = event.key === 'ArrowRight' || event.key === 'ArrowDown';
      const isPrevious = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
      if (!isNext && !isPrevious) return;

      const elements = wireframe.elements;
      if (elements.length === 0) return;
      event.preventDefault();

      const index = primaryId
        ? elements.findIndex((element) => element.id === primaryId)
        : -1;
      const delta = isNext ? 1 : -1;
      const nextIndex =
        index < 0
          ? delta > 0
            ? 0
            : elements.length - 1
          : (index + delta + elements.length) % elements.length;
      select(elements[nextIndex].id);
    },
    [primaryId, wireframe.elements, clearGuides],
  );

  const renderElement = (element: WireframeElement): ReactElement => (
    <Group
      key={element.id}
      name={`wireframe-element-${element.id}`}
      x={element.x}
      y={element.y}
      width={element.width}
      height={element.height}
      visible={element.visible}
      listening={element.visible}
      draggable={isElementMovable(wireframe, element) && !panMode}
      onClick={handleElementClick(element.id)}
      onTap={handleElementClick(element.id)}
      onDragStart={handleDragStart(element.id)}
      onDragMove={handleDragMove(element.id)}
      onDragEnd={handleDragEnd(element)}
      onMouseEnter={() => {
        if (!panMode) setStageCursor('pointer');
      }}
      onMouseLeave={() => setStageCursor(panMode ? 'grab' : 'default')}
      ref={(node) => {
        if (node) elementNodes.current.set(element.id, node);
        else elementNodes.current.delete(element.id);
      }}
    >
      {/* Sole hit surface: every decorative child is listening={false}. */}
      <Rect width={element.width} height={element.height} fill="transparent" />
      {renderElementBody(element, palette)}
    </Group>
  );

  // ── Snap grid overlay (editor-only, ONE Shape with a sceneFunc) ──────────
  const drawSnapGrid = useCallback(
    (context: Konva.Context): void => {
      const { width, height } = wireframe.page;
      const step = WIREFRAME_GRID_SIZE_PX;
      const major = step * 5;
      context.setAttr('lineWidth', 1 / paintScale);

      context.setAttr('strokeStyle', palette.border);
      context.beginPath();
      for (let x = step; x < width; x += step) {
        if (x % major === 0) continue;
        context.moveTo(x, 0);
        context.lineTo(x, height);
      }
      for (let y = step; y < height; y += step) {
        if (y % major === 0) continue;
        context.moveTo(0, y);
        context.lineTo(width, y);
      }
      context.stroke();

      context.setAttr('strokeStyle', palette.textMuted);
      context.beginPath();
      for (let x = major; x < width; x += major) {
        context.moveTo(x, 0);
        context.lineTo(x, height);
      }
      for (let y = major; y < height; y += major) {
        context.moveTo(0, y);
        context.lineTo(width, y);
      }
      context.stroke();
    },
    [palette.border, palette.textMuted, paintScale, wireframe.page.width, wireframe.page.height],
  );

  return (
    <Box
      ref={containerRef}
      data-testid="wireframe-canvas"
      data-wireframe-guides="0"
      tabIndex={0}
      role="group"
      aria-label="Wireframe canvas"
      aria-describedby="wireframe-canvas-instructions"
      position="relative"
      flex="1"
      minW={0}
      minH={0}
      overflow="hidden"
      bg="bg.muted"
      cursor={panMode ? 'grab' : 'default'}
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
    >
      <VisuallyHidden id="wireframe-canvas-instructions">
        {CANVAS_INSTRUCTIONS}
      </VisuallyHidden>

      {stageReady ? (
        <Stage
          ref={bindStage}
          width={size.width}
          height={size.height}
          onClick={handleStageClick}
          onTap={handleStageClick}
        >
          <Layer>
            <Group
              name="wireframe-view"
              x={paintView.x}
              y={paintView.y}
              scaleX={paintScale}
              scaleY={paintScale}
              draggable={panMode}
              onDragStart={handlePanDragStart}
              onDragEnd={handlePanDragEnd}
            >
              {/*
               * Pan hit surface (F-27): Konva only starts a drag from a
               * pointerdown that hits a LISTENING shape, and the empty page has
               * none. The group transform is (view.x, view.y, scale), so this
               * rect's local coordinates cover exactly the stage viewport and it
               * stays under the pointer for the whole gesture. `transparent`
               * paints nothing (the same idiom as the element hit rects), so the
               * export is unaffected. `listening={panMode}` keeps it inert when
               * not panning, so an empty-canvas click still reaches the Stage and
               * clears the selection.
               */}
              <Rect
                name="wireframe-pan-surface"
                x={-paintView.x / paintScale}
                y={-paintView.y / paintScale}
                width={size.width / paintScale}
                height={size.height / paintScale}
                fill="transparent"
                listening={panMode}
              />

              {/* Everything inside the artboard is clipped to it: what you see is
                  what exports (UI/UX section 2.3). */}
              <Group
                name={WIREFRAME_PAGE_NAME}
                clipX={0}
                clipY={0}
                clipWidth={wireframe.page.width}
                clipHeight={wireframe.page.height}
              >
                <Rect
                  width={wireframe.page.width}
                  height={wireframe.page.height}
                  fill={palette.surface}
                  stroke={palette.border}
                  strokeWidth={1 / paintScale}
                  shadowColor={palette.text}
                  shadowOpacity={0.08}
                  shadowBlur={16}
                  shadowOffsetY={2}
                  listening={false}
                />
                {wireframe.elements.map(renderElement)}
              </Group>

              {/* Selection chrome lives above the artboard and outside its clip,
                  so handles at the page edge stay reachable. The PRIMARY (last)
                  member paints 2 px accent, other movable members 1 px accent,
                  and pinned members (individually locked, group-locked or
                  hidden) a 1 px dashed muted outline (R-1.8). */}
              {selectedElementList.map((element) => {
                const primary = element.id === primaryId;
                const pinned = !element.visible || !isElementMovable(wireframe, element);
                return (
                  <Rect
                    key={`wireframe-outline-${element.id}`}
                    name={CAPTURE_HIDDEN_NAME}
                    x={element.x}
                    y={element.y}
                    width={element.width}
                    height={element.height}
                    stroke={pinned ? palette.textMuted : palette.accent}
                    strokeWidth={(pinned ? 1 : primary ? 2 : 1) / paintScale}
                    dash={pinned ? [6 / paintScale, 4 / paintScale] : undefined}
                    listening={false}
                  />
                );
              })}

              {showTransformer ? (
                <Transformer
                  ref={transformerRef}
                  name={CAPTURE_HIDDEN_NAME}
                  rotateEnabled={false}
                  flipEnabled={false}
                  keepRatio={false}
                  ignoreStroke
                  enabledAnchors={[...TRANSFORMER_ANCHORS]}
                  anchorSize={8 / paintScale}
                  anchorStrokeWidth={1 / paintScale}
                  anchorStroke={palette.accent}
                  anchorFill={palette.surface}
                  anchorCornerRadius={0}
                  borderStroke={palette.accent}
                  borderStrokeWidth={1 / paintScale}
                  borderDash={[4 / paintScale, 4 / paintScale]}
                  onTransformStart={handleTransformStart}
                  onTransformEnd={handleTransformEnd}
                  boundBoxFunc={(oldBox, newBox) =>
                    newBox.width < ELEMENT_MIN_SIZE * paintScale ||
                    newBox.height < ELEMENT_MIN_SIZE * paintScale
                      ? oldBox
                      : newBox
                  }
                />
              ) : null}
            </Group>
          </Layer>

          {/*
           * Guides + snap grid layer (R-2.5 / UI/UX 1.3-1.4): editor-only, drawn
           * above the artboard, and capture-hidden so no guide or grid line can
           * ever reach an exported PNG. `listening={false}` keeps it inert. The
           * guide Lines are toggled imperatively — never through React state.
           */}
          <Layer
            name={`${WIREFRAME_GUIDES_LAYER_NAME} ${CAPTURE_HIDDEN_NAME}`}
            listening={false}
          >
            <Group
              x={paintView.x}
              y={paintView.y}
              scaleX={paintScale}
              scaleY={paintScale}
              listening={false}
            >
              <Shape
                name="wireframe-snap-grid"
                visible={snapToGrid}
                listening={false}
                sceneFunc={drawSnapGrid}
              />
              {Array.from({ length: GUIDE_POOL_SIZE }, (_, index) => (
                <Line
                  key={`wireframe-guide-${index}`}
                  name="wireframe-guide"
                  ref={(node) => {
                    guideLineRefs.current[index] = node;
                  }}
                  visible={false}
                  listening={false}
                  stroke={palette.accent}
                  strokeWidth={1 / paintScale}
                  points={[]}
                />
              ))}
            </Group>
          </Layer>
        </Stage>
      ) : (
        /*
         * Not ready: the host has not measured a non-zero size yet (first
         * commit, or a later minimize/collapse). The host itself stays mounted
         * so measurement keeps running and the empty-state overlay below still
         * renders. This is the same backdrop + artboard skeleton + "Loading
         * canvas…" shape as the Suspense fallback; the two are mutually
         * exclusive (the fallback replaces the whole host).
         */
        <Box
          data-testid="wireframe-canvas-loading"
          position="absolute"
          inset={0}
          display="flex"
          flexDirection="column"
          alignItems="center"
          justifyContent="center"
          gap={3}
          pointerEvents="none"
        >
          <Skeleton width="70%" height="70%" maxW="960px" maxH="640px" />
          <Text fontSize="sm" color="fg.muted">
            Loading canvas…
          </Text>
        </Box>
      )}

      {wireframe.elements.length === 0 ? (
        <Box
          position="absolute"
          inset={0}
          display="flex"
          alignItems="center"
          justifyContent="center"
          pointerEvents="none"
          px={6}
        >
          <Text fontSize="sm" color="fg.muted" textAlign="center">
            {EMPTY_HINT}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

export default WireframeCanvasImpl;
