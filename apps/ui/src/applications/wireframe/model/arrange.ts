/**
 * Wireframe arrangement geometry (Spec #3071, ST-2).
 *
 * One dependency-free module for the measuring maths shared by the store
 * (align / distribute / snap), the canvas (guides) and the tests: no React, no
 * Konva, no DOM, no store import — only the `WireframeRect` shape from the
 * model layer.
 *
 * Everything here is pure and deterministic. Page clamping is deliberately NOT
 * done here: clamping is the store's / canvas's concern (R-2.2 / R-2.9).
 *
 * Scope: horizontal alignment + horizontal distribution only. There is no
 * vertical distribution and no page-relative alignment for non-selected
 * elements.
 */

import type { WireframeRect } from './geometry';

/** Snap step in logical px. Divides `CASCADE_STEP_PX` (24) exactly. */
export const WIREFRAME_GRID_SIZE_PX = 8;

/** Smart-guide proximity in logical px. */
export const ALIGN_GUIDE_THRESHOLD_PX = 6;

/** The horizontal feature an alignment targets. */
export type WireframeAlignEdge = 'left' | 'center' | 'right';

/** The axis a smart guide runs along (`x` = a vertical guide line). */
export type WireframeGuideAxis = 'x' | 'y';

export interface WireframeGuide {
  axis: WireframeGuideAxis;
  /** Logical page coordinate of the guide line on its axis. */
  position: number;
}

/** The union bounds of a set of rects, or `null` for an empty set. */
export function selectionBounds(rects: readonly WireframeRect[]): WireframeRect | null {
  if (rects.length === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const rect of rects) {
    if (rect.x < minX) minX = rect.x;
    if (rect.y < minY) minY = rect.y;
    if (rect.x + rect.width > maxX) maxX = rect.x + rect.width;
    if (rect.y + rect.height > maxY) maxY = rect.y + rect.height;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Align each rect's left edge / horizontal centre / right edge to the
 * corresponding edge of `bounds` (the WHOLE selection's union bounds — locked
 * members included anchor the target). Each rect's size and `y` are preserved;
 * a new rect array is returned in the input order.
 */
export function alignRects(
  rects: readonly WireframeRect[],
  edge: WireframeAlignEdge,
  bounds: WireframeRect,
): WireframeRect[] {
  const targetX = (rect: WireframeRect): number => {
    switch (edge) {
      case 'left':
        return bounds.x;
      case 'right':
        return bounds.x + bounds.width - rect.width;
      case 'center':
      default:
        return bounds.x + bounds.width / 2 - rect.width / 2;
    }
  };
  return rects.map((rect) => ({ ...rect, x: targetX(rect) }));
}

/**
 * Make the horizontal GAPS between consecutive rects equal (edge-to-edge space,
 * NOT centre pitch), ordering by left edge. The leftmost and rightmost rects
 * keep their exact geometry; every other rect's `y`/size is preserved. A new
 * rect array is returned in the input order. Needs at least three rects to be
 * meaningful — with fewer the rects are returned unchanged (copied).
 */
export function distributeRectsHorizontally(rects: readonly WireframeRect[]): WireframeRect[] {
  const result = rects.map((rect) => ({ ...rect }));
  if (rects.length < 3) return result;

  // Stable order by left edge so ties keep the caller's order.
  const ordered = rects
    .map((rect, index) => ({ rect, index }))
    .sort((left, right) => left.rect.x - right.rect.x || left.index - right.index);

  const first = ordered[0].rect;
  const last = ordered[ordered.length - 1].rect;
  const span = last.x + last.width - first.x;
  const totalWidth = ordered.reduce((sum, entry) => sum + entry.rect.width, 0);
  const gap = (span - totalWidth) / (ordered.length - 1);

  let cursor = first.x;
  for (const entry of ordered) {
    result[entry.index] = { ...entry.rect, x: cursor };
    cursor += entry.rect.width + gap;
  }
  return result;
}

/** Round a coordinate to the nearest multiple of `grid` (default 8). */
export function snapValueToGrid(
  value: number,
  grid: number = WIREFRAME_GRID_SIZE_PX,
): number {
  if (!Number.isFinite(value) || !Number.isFinite(grid) || grid <= 0) return value;
  const snapped = Math.round(value / grid) * grid;
  return Object.is(snapped, -0) ? 0 : snapped;
}

/**
 * Snap a rect's ORIGIN to the nearest grid intersection on both axes. Size is
 * preserved — the plan snaps the dragged selection's origin, not its extent.
 */
export function snapRectToGrid(
  rect: WireframeRect,
  grid: number = WIREFRAME_GRID_SIZE_PX,
): WireframeRect {
  return {
    ...rect,
    x: snapValueToGrid(rect.x, grid),
    y: snapValueToGrid(rect.y, grid),
  };
}

/**
 * The smart alignment guides for a moving rect (R-2.5). For each axis, a guide
 * is produced when the moving rect's leading edge / centre / trailing edge is
 * within `threshold` (inclusive) of ANOTHER rect's corresponding edge/centre.
 * Returns an empty array when there are no other rects or nothing is near.
 */
export function computeAlignmentGuides(
  moving: WireframeRect,
  others: readonly WireframeRect[],
  threshold: number = ALIGN_GUIDE_THRESHOLD_PX,
): WireframeGuide[] {
  if (others.length === 0) return [];
  const limit = Math.abs(threshold);

  const axes: readonly {
    axis: WireframeGuideAxis;
    moving: readonly number[];
    other: (rect: WireframeRect) => readonly number[];
  }[] = [
    {
      axis: 'x',
      moving: [moving.x, moving.x + moving.width / 2, moving.x + moving.width],
      other: (rect) => [rect.x, rect.x + rect.width / 2, rect.x + rect.width],
    },
    {
      axis: 'y',
      moving: [moving.y, moving.y + moving.height / 2, moving.y + moving.height],
      other: (rect) => [rect.y, rect.y + rect.height / 2, rect.y + rect.height],
    },
  ];

  const guides: WireframeGuide[] = [];
  const seen = new Set<string>();
  for (const { axis, moving: movingFeatures, other } of axes) {
    for (let feature = 0; feature < movingFeatures.length; feature += 1) {
      const position = movingFeatures[feature];
      const matched = others.some(
        (rect) => Math.abs(other(rect)[feature] - position) <= limit,
      );
      if (!matched) continue;
      const key = `${axis}:${position}`;
      if (seen.has(key)) continue;
      seen.add(key);
      guides.push({ axis, position });
    }
  }
  return guides;
}

/** Align needs at least two rects. */
export function canAlign(count: number): boolean {
  return count >= 2;
}

/** Distribute needs at least three rects. */
export function canDistribute(count: number): boolean {
  return count >= 3;
}
