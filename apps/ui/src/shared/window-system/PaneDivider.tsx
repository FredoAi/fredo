/**
 * PaneDivider — the shared-edge resize handle between two adjacent panes
 * (Spec #2949 ST-3: R4 + the R5 CONTINUOUS-STATE line, G-123).
 *
 * One divider exists per shared pane edge (`computeDividers`); the hosting
 * `WorkspacePane` renders the spec for which it is the `a` (before) pane and
 * passes the workspace-local hit-strip rect + the hosting pane's origin. Drag
 * math is a pure DELTA along the divider axis — `onResize(deltaPx)` is wired by
 * the pane to `resizeViaDivider`, so `applyDividerDelta` keeps the two adjacent
 * panes' combined extent constant and clamps each side to MIN_WIDTH/MIN_HEIGHT.
 *
 * R5 / G-123 — the continuous invariant lives HERE, not only at the call site:
 * a pointer drag is coalesced to ONE update per animation frame (the rAF reads
 * the latest pending delta), and the WHOLE gesture is wrapped in
 * `beginLayoutGesture()`/`endLayoutGesture()` so the live snapshot mutates every
 * frame while persistence stays suppressed until release (exactly one write on
 * end). Escape cancels an in-flight drag and restores the pre-drag geometry;
 * the keyboard resizes by a fixed px step (each step its own begin/end gesture).
 *
 * Token-native: `var(--border-color)` idle, `tint('var(--accent-primary)', …)`
 * hover/drag (color-mix — never a `var(--x)NN` alpha-append). No hardcoded
 * hex/rgba.
 */

import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { Box } from '@chakra-ui/react';

import { tint } from '../utils/colorTint';
import {
  beginLayoutGesture,
  endLayoutGesture,
  getLayoutSnapshot,
  setPaneRect,
} from './workspaceLayoutStore';
import type { PaneDividerSpec, PaneSlot } from './paneLayout';
import type { Geometry } from './windowGeometry';

/** Fixed keyboard resize step along the divider axis (px). */
export const DIVIDER_KEYBOARD_STEP = 16;

export interface PaneDividerProps {
  /** The shared edge this handle resizes (`${axis}:${aWindowId}:${bWindowId}`). */
  divider: PaneDividerSpec;
  /** The hit-strip rect in workspace-local px (spans the shared segment). */
  rect: Geometry;
  /** Workspace-local origin of the pane hosting this handle (the `a` pane). */
  origin: { x: number; y: number };
  /**
   * Apply an incremental delta along the divider axis (positive = toward the
   * `b` pane). Wired by the pane to `resizeViaDivider(divider.dividerId, delta)`.
   */
  onResize: (deltaPx: number) => void;
}

interface DragState {
  start: number;
  lastApplied: number;
  pending: number;
  raf: number | null;
}

/** rAF with a timer fallback for hosts (jsdom) without it. */
function scheduleFrame(callback: () => void): number {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback);
  return setTimeout(callback, 0) as unknown as number;
}

function cancelFrame(handle: number): void {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle);
  else clearTimeout(handle);
}

/** Snapshot the pane rects at gesture start so Escape can restore them. */
function snapshotSlots(): PaneSlot[] {
  return getLayoutSnapshot().activeSlots.map((slot) => ({
    ...slot,
    rect: { ...slot.rect },
  }));
}

export function PaneDivider({ divider, rect, origin, onResize }: PaneDividerProps) {
  const [dragging, setDragging] = useState(false);
  const [hovered, setHovered] = useState(false);
  const dragRef = useRef<DragState | null>(null);
  const preDragRef = useRef<PaneSlot[] | null>(null);
  // Latest onResize without re-binding the rAF closure each frame.
  const resizeRef = useRef(onResize);
  resizeRef.current = onResize;

  /** Apply the pending delta accumulated since the last committed frame. */
  function applyPending(drag: DragState): void {
    const step = drag.pending - drag.lastApplied;
    if (step === 0) return;
    drag.lastApplied = drag.pending;
    resizeRef.current(step);
  }

  function finishDrag(commitPending: boolean): void {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.raf !== null) {
      cancelFrame(drag.raf);
      drag.raf = null;
    }
    if (commitPending) applyPending(drag);
    dragRef.current = null;
    preDragRef.current = null;
    setDragging(false);
    endLayoutGesture();
  }

  function cancelDrag(): void {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.raf !== null) {
      cancelFrame(drag.raf);
      drag.raf = null;
    }
    dragRef.current = null;
    const pre = preDragRef.current;
    preDragRef.current = null;
    if (pre) for (const slot of pre) setPaneRect(slot.windowId, slot.rect);
    setDragging(false);
    endLayoutGesture();
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>): void {
    if (typeof event.button === 'number' && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (dragRef.current) return;
    preDragRef.current = snapshotSlots();
    dragRef.current = {
      start: divider.axis === 'vertical' ? event.clientX : event.clientY,
      lastApplied: 0,
      pending: 0,
      raf: null,
    };
    beginLayoutGesture();
    setDragging(true);
    const target = event.currentTarget;
    try {
      target.setPointerCapture?.(event.pointerId);
    } catch {
      // jsdom / hosts without pointer capture — document-level events still land.
    }
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current;
    if (!drag) return;
    drag.pending = (divider.axis === 'vertical' ? event.clientX : event.clientY) - drag.start;
    if (drag.raf !== null) return; // coalesced — one update per frame
    drag.raf = scheduleFrame(() => {
      const current = dragRef.current;
      if (!current) return;
      current.raf = null;
      applyPending(current);
    });
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      if (dragRef.current) {
        event.preventDefault();
        cancelDrag();
      }
      return;
    }
    const direction =
      divider.axis === 'vertical'
        ? event.key === 'ArrowLeft'
          ? -1
          : event.key === 'ArrowRight'
            ? 1
            : 0
        : event.key === 'ArrowUp'
          ? -1
          : event.key === 'ArrowDown'
            ? 1
            : 0;
    if (direction === 0) return;
    event.preventDefault();
    beginLayoutGesture();
    resizeRef.current(direction * DIVIDER_KEYBOARD_STEP);
    endLayoutGesture();
  }

  // A divider that unmounts mid-drag must not leak a pending frame or leave the
  // gesture active (which would suppress persistence indefinitely).
  useEffect(
    () => () => {
      const drag = dragRef.current;
      if (!drag) return;
      if (drag.raf !== null) cancelFrame(drag.raf);
      dragRef.current = null;
      endLayoutGesture();
    },
    [],
  );

  const lineWidth = dragging ? 3 : hovered ? 2 : 1;
  const lineColor = dragging
    ? tint('var(--accent-primary)', 35)
    : hovered
      ? tint('var(--accent-primary)', 22)
      : 'var(--border-color)';
  const lineStyle: CSSProperties =
    divider.axis === 'vertical'
      ? { top: 0, bottom: 0, right: 0, width: lineWidth }
      : { left: 0, right: 0, bottom: 0, height: lineWidth };

  return (
    <Box
      data-testid={`pane-divider-${divider.dividerId}`}
      data-dragging={dragging ? 'true' : 'false'}
      role="separator"
      aria-orientation={divider.axis}
      aria-label="Resize panes"
      tabIndex={0}
      position="absolute"
      zIndex={5}
      style={{
        left: rect.x - origin.x,
        top: rect.y - origin.y,
        width: rect.width,
        height: rect.height,
        cursor: divider.axis === 'vertical' ? 'col-resize' : 'row-resize',
        touchAction: 'none',
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={(event) => {
        event.stopPropagation();
        finishDrag(true);
      }}
      onPointerCancel={() => finishDrag(true)}
      onLostPointerCapture={() => finishDrag(true)}
      onKeyDown={handleKeyDown}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      _focusVisible={{ outline: '2px solid var(--accent-primary)', outlineOffset: '1px' }}
    >
      <Box
        data-divider-line="true"
        aria-hidden="true"
        position="absolute"
        pointerEvents="none"
        style={lineStyle}
        bg={lineColor}
        transition="background 80ms ease"
      />
    </Box>
  );
}
