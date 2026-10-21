/**
 * Wireframe canvas implementation (Spec #3070, ST-2).
 *
 * Loaded lazily by `WireframeCanvas.tsx` so `konva` / `react-konva` stay out of
 * the eager startup chunk (F-56). Renders the document as the visible page,
 * provides single selection, drag-move and Transformer resize, and consumes the
 * store's view transform.
 *
 * Performance contract (UI/UX section 9): pointer moves update Konva node
 * attributes imperatively — no React state is written per move — and exactly
 * ONE store step is committed on release.
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
  Stage,
  Text as KonvaText,
  Transformer,
} from 'react-konva';
import type Konva from 'konva';

import {
  ELEMENT_MIN_SIZE,
  roundTo1dp,
} from '../model/geometry';
import type {
  WireframeBorderWidth,
  WireframeElement,
  WireframeRadius,
  WireframeSectionPreset,
  WireframeTextSize,
} from '../model/elements';
import { findWireframeIcon } from '../model/icons';
import {
  dispatch,
  fitPageToViewport,
  getSnapshot,
  registerCanvasStage,
  select,
  setView,
  subscribe,
} from '../store/wireframeDocumentStore';
import {
  CAPTURE_HIDDEN_NAME,
  registerWireframeStage,
} from '../canvas/wireframeCanvasRegistry';
import { useCanvasPalette, type CanvasPalette } from '../theme/useCanvasPalette';

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
  const { document: wireframe, selectedId, view, panMode } = state;
  const palette = useCanvasPalette();

  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const transformerRef = useRef<Konva.Transformer>(null);
  const elementNodes = useRef<Map<string, Konva.Group>>(new Map());
  const measuredRef = useRef<CanvasSize>({ width: 0, height: 0 });
  const didFitRef = useRef(false);

  const [size, setSize] = useState<CanvasSize>({ width: 0, height: 0 });

  // The Konva Stage must never be committed at a zero width/height: its first
  // draw composites the artboard through a 0x0 buffer canvas, and Chromium
  // throws `InvalidStateError` from `drawImage` when the source canvas has a
  // zero dimension (round 1 crash, Spec #3070). The seed state stays `{0,0}`;
  // the stage is only mounted once the host has measured a real size.
  const stageReady = size.width > 0 && size.height > 0;

  const selectedElement =
    selectedId === null
      ? null
      : wireframe.elements.find((element) => element.id === selectedId) ?? null;

  const scale = view.scale > 0 ? view.scale : 1;

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
  // Re-keyed on `stageReady`: the ref is only populated in the commit where the
  // Stage actually mounts, so registering on mount alone would store `null`
  // (PNG export would then return `null`). The key also covers a later
  // shrink-to-zero, which unmounts the Stage and re-registers `null`.
  useEffect(() => {
    registerWireframeStage(stageRef.current);
    return () => registerWireframeStage(null);
  }, [stageReady]);

  // ── Stage cursor (pan mode) ──────────────────────────────────────────────
  useEffect(() => {
    const container = stageRef.current?.container();
    if (container) container.style.cursor = panMode ? 'grab' : 'default';
  }, [panMode, size.width, size.height]);

  // ── Transformer attachment (selected + unlocked + visible only) ──────────
  const showTransformer =
    selectedElement !== null &&
    !selectedElement.locked &&
    selectedElement.visible &&
    !panMode;

  useEffect(() => {
    const transformer = transformerRef.current;
    if (!transformer) return;
    const node = selectedElement
      ? elementNodes.current.get(selectedElement.id) ?? null
      : null;
    transformer.nodes(node ? [node] : []);
    transformer.getLayer()?.batchDraw();
  }, [selectedElement, panMode, wireframe.elements, size.width, size.height]);

  const setStageCursor = useCallback((cursor: string): void => {
    const container = stageRef.current?.container();
    if (container) container.style.cursor = cursor;
  }, []);

  // ── Gestures ─────────────────────────────────────────────────────────────

  const handleElementClick = useCallback(
    (id: string) => (event: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
      if (event && typeof event === 'object') event.cancelBubble = true;
      if (panMode) return;
      select(id);
    },
    [panMode],
  );

  const handleStageClick = useCallback(
    (event: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
      if (panMode) return;
      const stage = event.target.getStage();
      if (stage && event.target === stage) select(null);
    },
    [panMode],
  );

  const handleDragStart = useCallback(
    (id: string) => () => {
      if (panMode) return;
      select(id);
    },
    [panMode],
  );

  const handleDragEnd = useCallback(
    (element: WireframeElement) => (event: Konva.KonvaEventObject<DragEvent>) => {
      if (panMode || element.locked) return;
      const node = event.target as Konva.Group;
      const x = roundTo1dp(node.x());
      const y = roundTo1dp(node.y());
      if (x === element.x && y === element.y) return;
      dispatch('element.update', { id: element.id, patch: { x, y } });
    },
    [panMode],
  );

  const handleTransformEnd = useCallback(
    (element: WireframeElement) => (event: Konva.KonvaEventObject<Event>) => {
      if (panMode || element.locked) return;
      const node = event.target as Konva.Group;
      const width = roundPositive(node.width() * node.scaleX());
      const height = roundPositive(node.height() * node.scaleY());
      const x = roundTo1dp(node.x());
      const y = roundTo1dp(node.y());

      // Geometry now lives in the model — the node returns to unit scale.
      node.scaleX(1);
      node.scaleY(1);

      if (
        width === element.width &&
        height === element.height &&
        x === element.x &&
        y === element.y
      ) {
        return;
      }
      dispatch('element.update', { id: element.id, patch: { x, y, width, height } });
    },
    [panMode],
  );

  const handlePanDragEnd = useCallback(
    (event: Konva.KonvaEventObject<DragEvent>) => {
      const node = event.target as Konva.Group;
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
        select(null);
        return;
      }
      const isNext = event.key === 'ArrowRight' || event.key === 'ArrowDown';
      const isPrevious = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
      if (!isNext && !isPrevious) return;

      const elements = wireframe.elements;
      if (elements.length === 0) return;
      event.preventDefault();

      const index = selectedId
        ? elements.findIndex((element) => element.id === selectedId)
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
    [selectedId, wireframe.elements],
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
      draggable={!element.locked && !panMode}
      onClick={handleElementClick(element.id)}
      onTap={handleElementClick(element.id)}
      onDragStart={handleDragStart(element.id)}
      onDragEnd={handleDragEnd(element)}
      onTransformEnd={handleTransformEnd(element)}
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

  return (
    <Box
      ref={containerRef}
      data-testid="wireframe-canvas"
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
          ref={stageRef}
          width={size.width}
          height={size.height}
          onClick={handleStageClick}
          onTap={handleStageClick}
        >
          <Layer>
            <Group
              x={view.x}
              y={view.y}
              scaleX={scale}
              scaleY={scale}
              draggable={panMode}
              onDragStart={() => setStageCursor('grabbing')}
              onDragEnd={handlePanDragEnd}
            >
              {/* Everything inside the artboard is clipped to it: what you see is
                  what exports (UI/UX section 2.3). */}
              <Group
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
                  strokeWidth={1 / scale}
                  shadowColor={palette.text}
                  shadowOpacity={0.08}
                  shadowBlur={16}
                  shadowOffsetY={2}
                  listening={false}
                />
                {wireframe.elements.map(renderElement)}
              </Group>

              {/* Selection chrome lives above the artboard and outside its clip,
                  so handles at the page edge stay reachable. */}
              {selectedElement ? (
                <Rect
                  name={CAPTURE_HIDDEN_NAME}
                  x={selectedElement.x}
                  y={selectedElement.y}
                  width={selectedElement.width}
                  height={selectedElement.height}
                  stroke={
                    selectedElement.locked || !selectedElement.visible
                      ? palette.textMuted
                      : palette.focusRing
                  }
                  strokeWidth={2 / scale}
                  dash={
                    selectedElement.locked || !selectedElement.visible
                      ? [6 / scale, 4 / scale]
                      : undefined
                  }
                  listening={false}
                />
              ) : null}

              {showTransformer ? (
                <Transformer
                  ref={transformerRef}
                  name={CAPTURE_HIDDEN_NAME}
                  rotateEnabled={false}
                  flipEnabled={false}
                  keepRatio={false}
                  ignoreStroke
                  enabledAnchors={[...TRANSFORMER_ANCHORS]}
                  anchorSize={8 / scale}
                  anchorStrokeWidth={1.5 / scale}
                  anchorStroke={palette.focusRing}
                  anchorFill={palette.surface}
                  anchorCornerRadius={0}
                  borderStroke={palette.focusRing}
                  borderStrokeWidth={1.5 / scale}
                  boundBoxFunc={(oldBox, newBox) =>
                    newBox.width < ELEMENT_MIN_SIZE * scale ||
                    newBox.height < ELEMENT_MIN_SIZE * scale
                      ? oldBox
                      : newBox
                  }
                />
              ) : null}
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
