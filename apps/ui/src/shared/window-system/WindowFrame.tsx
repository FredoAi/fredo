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
 * Spec #2924 ST-2: full-bleed is the default-open state (the kernel default in
 * `windowStore`); this frame renders the `100%/100%` rect when maximized and a
 * container-derived CENTERED float (no cascade) when floating. The float math
 * lives in `windowGeometry.ts`; the pre-maximize float is restored via
 * `savedGeomRef` for a window that was floated, and recomputed as the centered
 * default for a window that opened full-bleed (never floated). The content
 * region is FLUSH — features own their interior spacing (REQ-6/REQ-10).
 *
 * Token-native (AC3): every color is a Chakra semantic token
 * (`bg.surface`, `border.default`, `accent.default`) or a `tint()` color-mix.
 * No hardcoded hex/rgba and no `var(--x)NN` alpha-append — see `chrome.css`
 * for the non-color layout/pointer concerns.
 */

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Box } from '@chakra-ui/react';
import { closeWindow, focusWindow } from './windowStore';
import { WindowChrome } from './WindowChrome';
import { useWindowTraversal } from './useWindowActions';
import type { WindowEntry } from './windowTypes';
import {
  clampToWorkspace,
  resolveFloatGeometry,
  MIN_HEIGHT,
  MIN_WIDTH,
  type Geometry,
  type WorkspaceSize,
} from './windowGeometry';
import { tint } from '../utils/colorTint';
import './chrome.css';

type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

interface WindowFrameProps {
  window: WindowEntry;
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

export function WindowFrame({ window: win }: WindowFrameProps) {
  // Spec #2946 ST-10 — arm keyboard window traversal while a window is rendered
  // (idempotent + reference-counted; releases when the last frame unmounts).
  useWindowTraversal();

  // Deterministic seed mirroring `resolveFloatGeometry(null)` (DEFAULT at 0,0)
  // for jsdom / pre-layout; the measured, CENTERED float is resolved in the
  // mount layout effect below (REQ-8 — no cascade offset).
  const [geom, setGeom] = useState<Geometry>(() => resolveFloatGeometry(null));
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

  // Resolve the container-derived CENTERED float once the workspace is
  // measurable (REQ-8) — cascade-free. Guarded so a later drag/resize can never
  // be clobbered; a window that opened full-bleed keeps this as its restore
  // target until it is floated.
  const geometryInitializedRef = useRef(false);
  useLayoutEffect(() => {
    if (geometryInitializedRef.current) return;
    const workspace = measureWorkspace();
    if (!workspace) return;
    geometryInitializedRef.current = true;
    setGeom(resolveFloatGeometry(workspace));
  }, []);

  /** Measured workspace (the WindowManager container) or null when un-laid-out. */
  function measureWorkspace(): WorkspaceSize | null {
    const rect = surfaceRef.current?.parentElement?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    return { width: rect.width, height: rect.height };
  }

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
    const workspace = measureWorkspace();

    const onMove = (ev: PointerEvent) => {
      const next = clampToWorkspace(
        {
          ...orig,
          x: orig.x + (ev.clientX - startX),
          y: orig.y + (ev.clientY - startY),
        },
        workspace,
      );
      scheduleGeom(next);
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
      // Restore: the pre-maximize float when the window was floated, else the
      // container-derived centered default (REQ-8) — never a cascade offset.
      const restored = savedGeomRef.current ?? resolveFloatGeometry(measureWorkspace());
      savedGeomRef.current = null;
      setGeom(restored);
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
      data-testid={`window-frame-${win.id}`}
      data-focused={win.focused ? 'true' : 'false'}
      data-focused-window={win.focused ? 'true' : undefined}
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
        data-testid={`window-content-${win.id}`}
        flex="1"
        minHeight="0"
        overflow="auto"
        bg="bg.surface"
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
