import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box } from '@chakra-ui/react';
import { tint } from '../../../shared/utils/colorTint';

/**
 * ResizableSplitter — the one reusable drag/keyboard handle shared by all four
 * SQL Studio splits (Spec #3049, ST-2; GA-5 live clamp, GA-7 clean pointer
 * capture).
 *
 * Pure presentational/behavioral: it owns NO persistence and NO layout state —
 * it never reads `settingsService`. The committed size is a controlled prop
 * (`value`); the only internal state is the in-flight drag value + transient
 * hover/drag/focus affordances. It reports the final clamped size exactly once
 * through `onChange` (on pointerup / pointercancel / lost capture, or on each
 * keyboard step).
 *
 * Interaction model (mirrors `mission-monitor/components/DetailPanel.tsx`):
 *  - pointer capture on pointerdown so the move/up stream stays on the handle;
 *  - live value = clamp(originSize ± Δ, min, max), never rubber-banded;
 *  - `user-select: none` + a document-level resize cursor during the drag,
 *    restored on release (fail-safe on unmount);
 *  - keyboard: Arrow keys step 16px (Shift+Arrow 64px) along the split axis,
 *    Home → min, End → max, Escape cancels an in-progress drag;
 *  - a DISTINCT `role="separator"` element with an 8px transparent hit band and
 *    a 1px themed line (idle `var(--border-color)`, accent-tinted on hover, full
 *    accent while dragging) — tokens only, never a hardcoded colour and never an
 *    alpha-append onto a `var()`.
 *
 * Token-first: no hex/rgba literal; tints go through the shared `tint()` helper.
 */

/** Arrow-key nudge along the split axis. */
export const RESIZE_KEYBOARD_STEP = 16;
/** Shift+Arrow nudge (larger step). */
export const RESIZE_KEYBOARD_STEP_LARGE = 64;
/** Non-painting interactive band width (the 1px line is centred inside it). */
export const RESIZE_HIT_AREA = '8px';

export interface ResizableSplitterProps {
  /** aria-orientation of the separator. 'vertical' resizes width (ΔX); 'horizontal' resizes height (ΔY). */
  orientation: 'vertical' | 'horizontal';
  /** Which side of the divider the resized pane is on: 'start' grows with +Δ, 'end' with −Δ. */
  direction: 'start' | 'end';
  value: number; // committed px
  min: number;
  max: number;
  onChange: (nextPx: number) => void; // fires once on pointerup/pointercancel or key step, clamped
  ariaLabel: string;
  testId: string; // exposed as data-testid on the handle
  /**
   * Optional live channel for in-flight drag values: fired on every pointermove
   * with the clamped value, but NEVER on commit. A consumer that needs the
   * adjacent pane to reflow live (GA-1…GA-4) wires this to its render state,
   * while `onChange` (fired once on release) remains the single persistence
   * commit — so a drag never triggers a write storm. Omit it for a
   * commit-only handle.
   */
  onDragChange?: (nextPx: number) => void;
}

/** Clamp a possibly-fractional / non-finite size into `[min, max]`, as integer px. */
export function clampSplitSize(next: number, min: number, max: number): number {
  if (!Number.isFinite(next)) return Math.round(min);
  const rounded = Math.round(next);
  return Math.min(max, Math.max(min, rounded));
}

export const ResizableSplitter: React.FC<ResizableSplitterProps> = ({
  orientation,
  direction,
  value,
  min,
  max,
  onChange,
  ariaLabel,
  testId,
  onDragChange,
}) => {
  const [dragValue, setDragValue] = useState<number | null>(null);
  const [hovered, setHovered] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [focused, setFocused] = useState(false);

  const handleRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ startCoord: number; startSize: number; pointerId: number } | null>(null);
  const dragValueRef = useRef<number>(value);
  const overrideRef = useRef<{ userSelect: string; cursor: string } | null>(null);

  // Latest-prop caches — the pointer/keyboard handlers read props through refs so
  // they never need to re-create mid-drag and never appear as effect deps (which
  // would otherwise re-run an effect on every render).
  const valueRef = useRef(value);
  valueRef.current = value;
  const minRef = useRef(min);
  minRef.current = min;
  const maxRef = useRef(max);
  maxRef.current = max;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onDragChangeRef = useRef(onDragChange);
  onDragChangeRef.current = onDragChange;

  const sign = direction === 'start' ? 1 : -1;
  const cursor = orientation === 'vertical' ? 'col-resize' : 'row-resize';
  const liveValue = dragValue ?? value;

  const applyOverrides = useCallback((nextCursor: string) => {
    const body = document.body;
    overrideRef.current = { userSelect: body.style.userSelect, cursor: body.style.cursor };
    body.style.userSelect = 'none';
    body.style.cursor = nextCursor;
  }, []);

  const clearOverrides = useCallback(() => {
    const body = document.body;
    const prev = overrideRef.current;
    overrideRef.current = null;
    if (prev) {
      body.style.userSelect = prev.userSelect;
      body.style.cursor = prev.cursor;
    } else {
      body.style.userSelect = '';
      body.style.cursor = '';
    }
  }, []);

  /** End an active drag/gesture: clear overrides + capture, then optionally commit ONCE. */
  const endDrag = useCallback(
    (commit: boolean) => {
      const start = dragRef.current;
      if (!start) return; // already ended — a stray lostpointercapture is a no-op
      dragRef.current = null;
      clearOverrides();
      const finalValue = clampSplitSize(dragValueRef.current, minRef.current, maxRef.current);
      setDragValue(null);
      setDragging(false);
      try {
        handleRef.current?.releasePointerCapture(start.pointerId);
      } catch {
        /* jsdom / unsupported */
      }
      if (commit) onChangeRef.current(finalValue);
    },
    [clearOverrides],
  );

  const cancelDrag = useCallback(() => {
    const start = dragRef.current;
    if (!start) return;
    dragRef.current = null;
    clearOverrides();
    setDragValue(null);
    setDragging(false);
    try {
      handleRef.current?.releasePointerCapture(start.pointerId);
    } catch {
      /* jsdom / unsupported */
    }
  }, [clearOverrides]);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const coord = orientation === 'vertical' ? e.clientX : e.clientY;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* jsdom / unsupported */
      }
      dragRef.current = { startCoord: coord, startSize: valueRef.current, pointerId: e.pointerId };
      dragValueRef.current = valueRef.current;
      setDragging(true);
      applyOverrides(cursor);
    },
    [orientation, cursor, applyOverrides],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const start = dragRef.current;
      if (!start) return;
      const coord = orientation === 'vertical' ? e.clientX : e.clientY;
      const delta = coord - start.startCoord;
      const next = clampSplitSize(start.startSize + sign * delta, minRef.current, maxRef.current);
      dragValueRef.current = next;
      setDragValue(next);
      onDragChangeRef.current?.(next);
    },
    [orientation, sign],
  );

  const handlePointerUp = useCallback(() => {
    endDrag(true);
  }, [endDrag]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const step = e.shiftKey ? RESIZE_KEYBOARD_STEP_LARGE : RESIZE_KEYBOARD_STEP;
      let delta: number | null = null;
      if (orientation === 'vertical') {
        if (e.key === 'ArrowRight') delta = step;
        else if (e.key === 'ArrowLeft') delta = -step;
      } else {
        if (e.key === 'ArrowDown') delta = step;
        else if (e.key === 'ArrowUp') delta = -step;
      }
      if (delta !== null) {
        e.preventDefault();
        onChangeRef.current(
          clampSplitSize(valueRef.current + sign * delta, minRef.current, maxRef.current),
        );
        return;
      }
      if (e.key === 'Home') {
        e.preventDefault();
        onChangeRef.current(clampSplitSize(minRef.current, minRef.current, maxRef.current));
        return;
      }
      if (e.key === 'End') {
        e.preventDefault();
        onChangeRef.current(clampSplitSize(maxRef.current, minRef.current, maxRef.current));
      }
    },
    [orientation, sign],
  );

  // Escape cancels an in-progress drag from anywhere (the pointer may have left
  // the handle) — scoped to a live drag so no global listener lingers.
  useEffect(() => {
    if (!dragging) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancelDrag();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dragging, cancelDrag]);

  // Unmount safety: never leave body user-select / cursor overridden mid-drag.
  useEffect(() => () => clearOverrides(), [clearOverrides]);

  const lineColor = dragging
    ? 'var(--accent-primary)'
    : hovered
      ? tint('var(--accent-primary)', 60)
      : 'var(--border-color)';

  return (
    <Box
      ref={handleRef}
      data-testid={testId}
      role="separator"
      aria-orientation={orientation}
      aria-label={ariaLabel}
      aria-valuenow={Math.round(liveValue)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onLostPointerCapture={handlePointerUp}
      onKeyDown={handleKeyDown}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={(e) => {
        let visible = false;
        try {
          visible = e.currentTarget.matches(':focus-visible');
        } catch {
          /* older jsdom */
        }
        setFocused(visible);
      }}
      onBlur={() => setFocused(false)}
      position="relative"
      flexShrink={0}
      width={orientation === 'vertical' ? RESIZE_HIT_AREA : '100%'}
      height={orientation === 'vertical' ? '100%' : RESIZE_HIT_AREA}
      bg="transparent"
      cursor={cursor}
      touchAction="none"
      userSelect="none"
      style={{
        outline: focused ? '2px solid var(--accent-primary)' : 'none',
        outlineOffset: focused ? -2 : 0,
      }}
    >
      {/* The 1px visible line, centred in the transparent 8px hit band. */}
      <Box
        aria-hidden="true"
        position="absolute"
        bg={lineColor}
        transition="background 0.15s ease"
        {...(orientation === 'vertical'
          ? { left: '50%', top: 0, bottom: 0, width: '1px', transform: 'translateX(-50%)' }
          : { top: '50%', left: 0, right: 0, height: '1px', transform: 'translateY(-50%)' })}
      />
    </Box>
  );
};
