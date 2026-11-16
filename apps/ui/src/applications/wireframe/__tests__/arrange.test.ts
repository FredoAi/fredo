/**
 * Wireframe arrangement geometry (Spec #3071, ST-2).
 *
 * Pure maths shared by the store, the canvas and the tests: union bounds,
 * align, horizontal distribute, grid snap and smart alignment guides.
 */

import { describe, expect, it } from 'vitest';

import {
  ALIGN_GUIDE_THRESHOLD_PX,
  WIREFRAME_GRID_SIZE_PX,
  alignRects,
  canAlign,
  canDistribute,
  computeAlignmentGuides,
  distributeRectsHorizontally,
  selectionBounds,
  snapRectToGrid,
  snapValueToGrid,
  type WireframeGuide,
} from '../model/arrange';
import type { WireframeRect } from '../model/geometry';

function rect(x: number, y: number, width: number, height: number): WireframeRect {
  return { x, y, width, height };
}

describe('constants', () => {
  it('declares the grid step and the guide threshold', () => {
    expect(WIREFRAME_GRID_SIZE_PX).toBe(8);
    expect(ALIGN_GUIDE_THRESHOLD_PX).toBe(6);
  });
});

describe('selectionBounds', () => {
  it('is null for an empty set', () => {
    expect(selectionBounds([])).toBeNull();
  });

  it('is the rect itself for a single rect', () => {
    expect(selectionBounds([rect(10, 20, 30, 40)])).toEqual(rect(10, 20, 30, 40));
  });

  it('is the union of several rects', () => {
    const bounds = selectionBounds([
      rect(0, 0, 10, 10),
      rect(20, 30, 30, 20),
      rect(100, 5, 50, 15),
    ]);
    expect(bounds).toEqual(rect(0, 0, 150, 50));
  });

  it('handles negative coordinates', () => {
    expect(selectionBounds([rect(-20, -10, 10, 10), rect(5, 5, 10, 10)])).toEqual(
      rect(-20, -10, 35, 25),
    );
  });
});

describe('alignRects', () => {
  const rects = [rect(0, 0, 10, 10), rect(20, 30, 30, 20), rect(100, 5, 50, 15)];
  const bounds = selectionBounds(rects) as WireframeRect;

  it('aligns every left edge to the union left', () => {
    const aligned = alignRects(rects, 'left', bounds);
    expect(aligned.map((r) => r.x)).toEqual([0, 0, 0]);
  });

  it('aligns every right edge to the union right', () => {
    const aligned = alignRects(rects, 'right', bounds);
    expect(aligned.map((r) => r.x + r.width)).toEqual([150, 150, 150]);
    expect(aligned.map((r) => r.x)).toEqual([140, 120, 100]);
  });

  it('aligns every horizontal centre to the union centre', () => {
    const aligned = alignRects(rects, 'center', bounds);
    const centres = aligned.map((r) => r.x + r.width / 2);
    expect(centres).toEqual([75, 75, 75]);
    expect(aligned.map((r) => r.x)).toEqual([70, 60, 50]);
  });

  it('preserves each size and y', () => {
    for (const edge of ['left', 'center', 'right'] as const) {
      const aligned = alignRects(rects, edge, bounds);
      aligned.forEach((alignedRect, index) => {
        expect(alignedRect.width).toBe(rects[index].width);
        expect(alignedRect.height).toBe(rects[index].height);
        expect(alignedRect.y).toBe(rects[index].y);
      });
    }
  });

  it('returns a new array and does not mutate the input', () => {
    const aligned = alignRects(rects, 'left', bounds);
    expect(aligned).not.toBe(rects);
    expect(rects.map((r) => r.x)).toEqual([0, 20, 100]);
  });

  it('is a no-op for an empty set', () => {
    expect(alignRects([], 'left', rect(0, 0, 100, 100))).toEqual([]);
  });
});

describe('distributeRectsHorizontally', () => {
  it('makes the horizontal gaps equal (equal widths)', () => {
    const distributed = distributeRectsHorizontally([
      rect(0, 0, 10, 10),
      rect(30, 0, 10, 10),
      rect(100, 0, 10, 10),
    ]);
    expect(distributed.map((r) => r.x)).toEqual([0, 50, 100]);
    expect(gaps(distributed)).toEqual([40, 40]);
  });

  it('uses edge-to-edge gaps with mixed widths', () => {
    const distributed = distributeRectsHorizontally([
      rect(0, 0, 10, 10),
      rect(20, 0, 40, 10),
      rect(100, 0, 10, 10),
    ]);
    expect(distributed.map((r) => r.x)).toEqual([0, 35, 100]);
    expect(gaps(distributed)).toEqual([25, 25]);
  });

  it('leaves the leftmost and rightmost geometry untouched', () => {
    const input = [rect(5, 7, 10, 10), rect(60, 7, 20, 10), rect(200, 7, 30, 10)];
    const distributed = distributeRectsHorizontally(input);
    expect(distributed[0]).toEqual(input[0]);
    expect(distributed[2]).toEqual(input[2]);
  });

  it('returns the rects in the caller order (left-edge ordering is internal)', () => {
    const distributed = distributeRectsHorizontally([
      rect(100, 0, 10, 10),
      rect(0, 0, 10, 10),
      rect(30, 0, 10, 10),
    ]);
    expect(distributed.map((r) => r.x)).toEqual([100, 0, 50]);
    // Sorted by left edge: [0, 50, 100] -> equal 40px gaps.
    const sorted = [...distributed].sort((a, b) => a.x - b.x);
    expect(gaps(sorted)).toEqual([40, 40]);
  });

  it('returns copies unchanged for fewer than three rects', () => {
    const input = [rect(0, 0, 10, 10), rect(50, 0, 10, 10)];
    const distributed = distributeRectsHorizontally(input);
    expect(distributed).toEqual(input);
    expect(distributed).not.toBe(input);
    expect(distributed[0]).not.toBe(input[0]);
  });

  it('is deterministic for tied left edges', () => {
    const first = distributeRectsHorizontally([
      rect(0, 0, 10, 10),
      rect(0, 40, 10, 10),
      rect(90, 0, 10, 10),
    ]);
    const second = distributeRectsHorizontally([
      rect(0, 0, 10, 10),
      rect(0, 40, 10, 10),
      rect(90, 0, 10, 10),
    ]);
    expect(first).toEqual(second);
  });
});

describe('snapValueToGrid', () => {
  it('rounds to the nearest multiple of the default step', () => {
    expect(snapValueToGrid(8)).toBe(8);
    expect(snapValueToGrid(11)).toBe(8);
    expect(snapValueToGrid(13)).toBe(16);
    expect(snapValueToGrid(5)).toBe(8);
    expect(snapValueToGrid(3)).toBe(0);
    expect(snapValueToGrid(0)).toBe(0);
  });

  it('rounds negative values both directions', () => {
    expect(snapValueToGrid(-5)).toBe(-8);
    expect(snapValueToGrid(-11)).toBe(-8);
    expect(snapValueToGrid(-13)).toBe(-16);
  });

  it('never returns negative zero', () => {
    expect(Object.is(snapValueToGrid(-3), -0)).toBe(false);
    expect(snapValueToGrid(-3)).toBe(0);
  });

  it('honours a custom grid step', () => {
    expect(snapValueToGrid(14, 10)).toBe(10);
    expect(snapValueToGrid(16, 10)).toBe(20);
    expect(snapValueToGrid(21, 25)).toBe(25);
  });

  it('passes the value through for a degenerate grid or a non-finite value', () => {
    expect(snapValueToGrid(13, 0)).toBe(13);
    expect(snapValueToGrid(13, -8)).toBe(13);
    expect(snapValueToGrid(13, Number.NaN)).toBe(13);
    expect(snapValueToGrid(Number.NaN)).toBe(Number.NaN);
  });
});

describe('snapRectToGrid', () => {
  it('snaps the origin and preserves the size', () => {
    expect(snapRectToGrid(rect(11, 13, 30, 40))).toEqual(rect(8, 16, 30, 40));
  });

  it('honours a custom grid step', () => {
    expect(snapRectToGrid(rect(11, 13, 30, 40), 10)).toEqual(rect(10, 10, 30, 40));
  });

  it('returns a new rect', () => {
    const input = rect(11, 13, 30, 40);
    expect(snapRectToGrid(input)).not.toBe(input);
  });
});

describe('computeAlignmentGuides', () => {
  it('returns nothing with no other rects', () => {
    expect(computeAlignmentGuides(rect(0, 0, 10, 10), [])).toEqual([]);
  });

  it('guides on the x axis when a corresponding edge/centre is near', () => {
    const guides = computeAlignmentGuides(rect(100, 200, 20, 20), [
      rect(103, 500, 20, 20),
    ]);
    expect(guides).toEqual<WireframeGuide[]>([
      { axis: 'x', position: 100 },
      { axis: 'x', position: 110 },
      { axis: 'x', position: 120 },
    ]);
  });

  it('guides on the y axis when a corresponding edge/centre is near', () => {
    const guides = computeAlignmentGuides(rect(400, 100, 20, 20), [
      rect(900, 103, 20, 20),
    ]);
    expect(guides).toEqual<WireframeGuide[]>([
      { axis: 'y', position: 100 },
      { axis: 'y', position: 110 },
      { axis: 'y', position: 120 },
    ]);
  });

  it('returns nothing when every feature is beyond the threshold', () => {
    expect(computeAlignmentGuides(rect(100, 200, 20, 20), [rect(107, 500, 20, 20)])).toEqual(
      [],
    );
  });

  it('treats the threshold as inclusive', () => {
    const guides = computeAlignmentGuides(rect(100, 200, 20, 20), [rect(106, 500, 20, 20)]);
    expect(guides).toContainEqual({ axis: 'x', position: 100 });
  });

  it('honours a custom threshold', () => {
    expect(
      computeAlignmentGuides(rect(100, 200, 20, 20), [rect(103, 500, 20, 20)], 1),
    ).toEqual([]);
  });

  it('only pairs CORRESPONDING features (no cross edge pairing)', () => {
    // moving.right (10) is 4px from other.left (14) — not a corresponding pair.
    const guides = computeAlignmentGuides(rect(0, 0, 10, 10), [rect(14, 0, 10, 10)]);
    expect(guides.filter((guide) => guide.axis === 'x')).toEqual([]);
  });

  it('deduplicates identical guides across several others', () => {
    const guides = computeAlignmentGuides(rect(100, 0, 20, 20), [
      rect(100, 400, 20, 20),
      rect(100, 800, 20, 20),
    ]);
    expect(guides.filter((guide) => guide.axis === 'x')).toEqual([
      { axis: 'x', position: 100 },
      { axis: 'x', position: 110 },
      { axis: 'x', position: 120 },
    ]);
  });
});

describe('operation gates', () => {
  it('canAlign needs at least two rects', () => {
    expect(canAlign(0)).toBe(false);
    expect(canAlign(1)).toBe(false);
    expect(canAlign(2)).toBe(true);
    expect(canAlign(5)).toBe(true);
  });

  it('canDistribute needs at least three rects', () => {
    expect(canDistribute(0)).toBe(false);
    expect(canDistribute(2)).toBe(false);
    expect(canDistribute(3)).toBe(true);
    expect(canDistribute(7)).toBe(true);
  });
});

/** Horizontal edge-to-edge gaps of rects ordered left to right. */
function gaps(ordered: readonly WireframeRect[]): number[] {
  const result: number[] = [];
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    result.push(ordered[index].x - (previous.x + previous.width));
  }
  return result;
}
