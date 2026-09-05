/**
 * Fredo brand window frame (Spec #2807 ST-3) — the owned surface.
 *
 * Wraps a `WindowEntry` from the kernel store into the brand-guidelines
 * chrome: the `WindowChrome` header + a scrollable content region + 8
 * directional resize grips + floating-drag-by-header. Geometry (position +
 * size) is local component state — the kernel store (ST-1) persists only the
 * window list + control state, so float geometry is not part of the store
 * contract and resets only on window close. The chrome controls dispatch to
 * the store's `closeWindow`/`focusWindow` actions (never breaking the
 * open/close/update/focus/re-entrancy contract).
 *
 * Token-native (AC3): every color is a Chakra semantic token
 * (`bg.surface`, `border.default`, `accent.default`) or a `tint()` color-mix.
 * No hardcoded hex/rgba and no `var(--x)NN` alpha-append — see `chrome.css`
 * for the non-color layout/pointer concerns.
 */

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { Box } from '@chakra-ui/react';
import { closeWindow, focusWindow } from './windowStore';
import { WindowChrome } from './WindowChrome';
import type { WindowEntry } from './windowTypes';
import { tint } from '../utils/colorTint';
import './chrome.css';

const DEFAULT_WIDTH = 480;
const DEFAULT_HEIGHT = 320;
const MIN_WIDTH = 320;
const MIN_HEIGHT = 200;
const CASCADE = 16;
const BASE = 48;
const GESTURE_INSET = 24; // keeps at least 24px of a floating window on screen

type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

interface Geometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface WindowFrameProps {
  window: WindowEntry;
  /** Cascade offset base for the initial float position (render order). */
  stackIndex: number;
}

const GRIP_CLASS: Record<ResizeDir, string> = {
  n: 'fredo-window__grip--n',
  s: 'fredo-window__grip--s',
  e: 'fredo-window__grip--e',
  w: 'fredo-window__grip--w',
  ne: 'fredo-window__grip--ne',
  nw: 'fredo-window__grip--nw',
  se: 'fredo-window__grip--se',
  sw: 'fredo-window__grip--sw',
};

const GRIP_STYLE: Record<ResizeDir, CSSProperties> = {
  n: { top: 0, left: 0, width: '100%', height: '6px' },
  s: { bottom: 0, left: 0, width: '100%', height: '6px' },
  e: { top: '6px', bottom: '6px', right: 0, width: '6px' },
  w: { top: '6px', bottom: '6px', left: 0, width: '6px' },
  ne: { top: 0, right: 0, width: '8px', height: '8px' },
  nw: { top: 0, left: 0, width: '8px', height: '8px' },
  se: { bottom: 0, right: 0, width: '8px', height: '8px' },
  sw: { bottom: 0, left: 0, width: '8px', height: '8px' },
};

const GRIP_DIRS: ResizeDir[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function WindowFrame({ window: win, stackIndex }: WindowFrameProps) {
  const [geom, setGeom] = useState<Geometry>(() => ({
    x: BASE + stackIndex * CASCADE,
    y: BASE + stackIndex * CASCADE,
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
  }));
  const geomRef = useRef(geom);
  geomRef.current = geom;

  const savedGeomRef = useRef<Geometry | null>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);
  const pendingGeomRef = useRef<Geometry | null>(null);
  const gestureCleanupRef = useRef<(() => void) | null>(null);
  const [gesture, setGesture] = useState<'drag' | 'resize' | null>(null);

  const isMax = win.isMaximized;
  const hidden = win.isMinimized;

  // Cancel any in-flight gesture/rAF when the window unmounts (close).
  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafRef.current);
      gestureCleanupRef.current?.();
    };
  }, []);

  function scheduleGeom(next: Geometry) {
    pendingGeomRef.current = next;
    if (!rafRef.current) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        const pending = pendingGeomRef.current;
        pendingGeomRef.current = null;
        if (pending) setGeom(pending);
      });
    }
  }

  function focusIfNeeded() {
    if (!win.focused) focusWindow(win.id);
  }

  /** Pointer-down anywhere on the surface raises the window to the top. */
  function handleSurfacePointerDown() {
    focusIfNeeded();
  }

  function handleHeaderPointerDown(e: ReactPointerEvent) {
    if (e.button !== 0 || isMax) return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const orig = geomRef.current;
    const container = surfaceRef.current?.parentElement;
    const containerWidth = container?.getBoundingClientRect().width ?? orig.width;
    const minX = GESTURE_INSET - orig.width;
    const maxX = containerWidth - GESTURE_INSET;

    const onMove = (ev: PointerEvent) => {
      const nextX = clamp(orig.x + (ev.clientX - startX), minX, maxX);
      const nextY = Math.max(0, orig.y + (ev.clientY - startY));
      scheduleGeom({ ...orig, x: nextX, y: nextY });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      gestureCleanupRef.current = null;
      setGesture(null);
    };

    setGesture('drag');
    gestureCleanupRef.current = onUp;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  function toggleMaximize() {
    if (win.isMaximized) {
      focusWindow(win.id, { maximize: false });
    } else {
      savedGeomRef.current = geomRef.current;
      focusWindow(win.id, { maximize: true });
    }
  }

  function handleHeaderDoubleClick() {
    if (win.canMaximize) toggleMaximize();
  }

  function startResize(dir: ResizeDir, e: ReactPointerEvent) {
    if (e.button !== 0 || isMax) return;
    e.preventDefault();
    e.stopPropagation();
    focusIfNeeded();
    const startX = e.clientX;
    const startY = e.clientY;
    const orig = geomRef.current;

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      scheduleGeom(applyResize(dir, orig, dx, dy));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      gestureCleanupRef.current = null;
      setGesture(null);
    };

    setGesture('resize');
    gestureCleanupRef.current = onUp;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  function onClose() {
    closeWindow(win.id);
  }

  function onMinimize() {
    focusWindow(win.id, { minimize: true });
  }

  const surfaceStyle: CSSProperties = isMax
    ? { top: 0, left: 0, width: '100%', height: '100%' }
    : { top: geom.y, left: geom.x, width: geom.width, height: geom.height };

  const boxShadow = isMax
    ? 'none'
    : win.focused
      ? `0 0 0 1px ${tint('var(--accent-primary)', 40)}, 0 8px 24px ${tint('var(--accent-primary)', 12)}`
      : `0 4px 12px ${tint('var(--accent-primary)', 10)}`;

  return (
    <Box
      ref={surfaceRef}
      role="group"
      aria-label={win.title}
      position="absolute"
      display={hidden ? 'none' : 'flex'}
      flexDirection="column"
      bg="bg.surface"
      border="1px solid"
      borderColor={win.focused ? 'accent.default' : 'border.default'}
      borderRadius={isMax ? '0px' : '8px'}
      boxShadow={boxShadow}
      overflow="hidden"
      style={surfaceStyle}
      className={gesture ? 'fredo-window__surface--gesture' : 'fredo-window__surface'}
      onPointerDown={handleSurfacePointerDown}
    >
      <WindowChrome
        title={win.title}
        icon={win.icon}
        focused={win.focused}
        canClose={win.canClose}
        canMaximize={win.canMaximize}
        canMinimize={win.canMinimize}
        isMaximized={win.isMaximized}
        onClose={onClose}
        onMinimize={onMinimize}
        onMaximize={toggleMaximize}
        onHeaderPointerDown={handleHeaderPointerDown}
        onHeaderDoubleClick={handleHeaderDoubleClick}
      />

      <Box
        flex="1"
        minHeight="0"
        overflow="auto"
        bg="bg.surface"
        p="4"
        tabIndex={-1}
        color="fg.default"
      >
        {win.component}
      </Box>

      {!isMax && !hidden &&
        GRIP_DIRS.map((dir) => (
          <Box
            key={dir}
            className={GRIP_CLASS[dir]}
            position="absolute"
            zIndex="1"
            style={GRIP_STYLE[dir]}
            _hover={{ bg: tint('var(--accent-primary)', 8) }}
            onPointerDown={(e) => startResize(dir, e)}
          />
        ))}
    </Box>
  );
}

/** Resize math — grows/shrinks the edge/corner a grip drives, clamping min size. */
function applyResize(dir: ResizeDir, orig: Geometry, dx: number, dy: number): Geometry {
  let { x, y, width, height } = orig;
  if (dir.includes('e')) width = Math.max(MIN_WIDTH, orig.width + dx);
  if (dir.includes('s')) height = Math.max(MIN_HEIGHT, orig.height + dy);
  if (dir.includes('w')) {
    const nextWidth = Math.max(MIN_WIDTH, orig.width - dx);
    width = nextWidth;
    x = orig.x + (orig.width - nextWidth);
  }
  if (dir.includes('n')) {
    const nextHeight = Math.max(MIN_HEIGHT, orig.height - dy);
    height = nextHeight;
    y = orig.y + (orig.height - nextHeight);
  }
  return { x, y, width, height };
}
