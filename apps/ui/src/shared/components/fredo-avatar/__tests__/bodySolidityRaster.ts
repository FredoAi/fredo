/**
 * #2922 ST-5 — pure raster metric for the corrected body-solidity oracle.
 *
 * The round-1 verifier proved the original plan oracle (`open` flood-fill
 * `hole` + `silhouette` leak) non-discriminating: FREDO is authored as a
 * fragmented rect table whose cavities vent to the exterior, so no region is
 * ever topologically "enclosed" and `holeCount ≡ 0`. The corrected oracle
 * (Fix Plan, round 2) is bound to the *intended opaque region*
 * `union(58 base rects) ∪ union(17 interior bands)` and compares two frames
 * that differ only by the backdrop behind the figure:
 *
 *   seeThrough := { p ∈ M : maxChannel |A(p) − D(p)| > T }
 *   leak       := { p ∈ N : maxChannel |A(p) − C(p)| > T }
 *
 * where A is the rendered avatar over backdrop B0, D is the same DOM over a
 * solid probe backdrop B1 inserted *behind* the figure, C hides only the
 * interior fill, M is the intended-region mask, and N is the UI/UX-bound
 * negative space (each box inset 6 viewBox units).
 *
 * Everything here is PURE — no DOM, no canvas, no async, no side effects.
 * It is a harness artifact: it is never imported by product code and
 * `tsconfig` excludes `src/**\/__tests__` from the shipped build.
 *
 * MASK SOURCE IS FROZEN — the 17 intended interior bands are committed
 * constants in THIS file, never imported from the product module. The BEFORE
 * checkout ships only 9 interior bands; importing `FREDO_AVATAR_INTERIOR_RECTS`
 * at runtime would silently shrink the mask on the pre-fix leg and re-break the
 * negative control. The 58 base rects are safe to import (that table is frozen
 * and byte-identical on both sides of the fix).
 */

import {
  expandFredoRects,
  FREDO_AVATAR_SOURCE_RECTS,
  FREDO_AVATAR_SPACE,
  type FredoRect,
} from '../fredoAvatarGeometry';

/** An 8-bit RGB colour (screenshots are opaque; alpha is ignored by the metric). */
export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** A lossless crop, RGBA, row-major, 4 bytes per pixel. */
export interface Frame {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

/** viewBox → frame-pixel mapping (independent X/Y — the crop carries a halo). */
export interface FrameTransform {
  readonly scaleX: number;
  readonly scaleY: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

/** A named viewBox rect used for per-region reporting. */
export interface MaskRegion {
  readonly name: string;
  readonly rect: FredoRect;
}

/** A rasterised binary mask plus its transform and reporting regions. */
export interface Mask {
  readonly width: number;
  readonly height: number;
  /** 1 = inside the mask, 0 = outside; length `width * height`. */
  readonly cells: Uint8Array;
  readonly transform: FrameTransform;
  /** Reporting regions (viewBox rects); membership is by pixel-centre viewBox coords. */
  readonly regions: readonly MaskRegion[];
}

/** Result of a mask-scoped frame comparison. */
export interface RegionCounts {
  readonly total: number;
  readonly byRegion: Readonly<Record<string, number>>;
}

/**
 * POST-fix intended interior bands (9 head + 8 body) — FROZEN harness constant.
 *
 * Transcribed from `fredoAvatarGeometry.ts` (#2917 head bands + #2922 body
 * bands). The `fredoAvatarInterior.test.tsx` ST-2 pins independently assert the
 * product table equals this geometry, so a drift on either side is caught —
 * without this harness ever importing the product interior table.
 */
export const INTENDED_INTERIOR_BANDS: readonly FredoRect[] = [
  // #2917 — head interior (bands 1–9), byte-identical
  { x: 364, y: 106, width: 286, height: 43 },
  { x: 270, y: 150, width: 474, height: 44 },
  { x: 210, y: 194, width: 594, height: 76 },
  { x: 161, y: 270, width: 692, height: 47 },
  { x: 122, y: 317, width: 770, height: 268 },
  { x: 160, y: 585, width: 694, height: 58 },
  { x: 209, y: 644, width: 596, height: 41 },
  { x: 270, y: 686, width: 474, height: 42 },
  { x: 337, y: 727, width: 340, height: 34 },
  // #2922 — body interior (bands 10–17)
  { x: 382, y: 824, width: 51, height: 10 },
  { x: 581, y: 824, width: 51, height: 10 },
  { x: 382, y: 834, width: 250, height: 82 },
  { x: 414, y: 916, width: 186, height: 93 },
  { x: 327, y: 1009, width: 360, height: 52 },
  { x: 327, y: 1061, width: 360, height: 24 },
  { x: 355, y: 1085, width: 133, height: 115 },
  { x: 526, y: 1085, width: 133, height: 115 },
];

/** The 58 frozen base rects, mirror-expanded from the unchanged source table. */
export const FREDO_BASE_RECTS: readonly FredoRect[] = expandFredoRects(FREDO_AVATAR_SOURCE_RECTS);

/** Intended opaque region: base rects ∪ interior bands. */
export function intendedRegionRects(): FredoRect[] {
  return [...FREDO_BASE_RECTS, ...INTENDED_INTERIOR_BANDS];
}

/**
 * Body sub-bands (viewBox y-ranges, full figure width) for per-band reporting.
 * Names/edges are the plan's; a pixel is attributed to a band by its centre.
 */
export const SEE_THROUGH_SUB_BANDS: readonly MaskRegion[] = [
  { name: 'bowTie', rect: { x: 0, y: 812, width: FREDO_AVATAR_SPACE.width, height: 56 } },
  { name: 'upperArms', rect: { x: 0, y: 824, width: FREDO_AVATAR_SPACE.width, height: 87 } },
  { name: 'innerArms', rect: { x: 0, y: 856, width: FREDO_AVATAR_SPACE.width, height: 60 } },
  { name: 'buttons', rect: { x: 0, y: 917, width: FREDO_AVATAR_SPACE.width, height: 110 } },
  { name: 'lowerArms', rect: { x: 0, y: 916, width: FREDO_AVATAR_SPACE.width, height: 145 } },
  { name: 'hips', rect: { x: 0, y: 1009, width: FREDO_AVATAR_SPACE.width, height: 76 } },
  { name: 'legs', rect: { x: 0, y: 1085, width: FREDO_AVATAR_SPACE.width, height: 116 } },
  { name: 'feet', rect: { x: 0, y: 1201, width: FREDO_AVATAR_SPACE.width, height: 33 } },
];

/**
 * UI/UX-bound negative space, in viewBox units (Fix Plan round 2). The leak
 * oracle intersects these with the fill-only delta; the intended-region mask
 * MUST exclude them, so a correct fill can never false-positive here.
 */
export const NEGATIVE_SPACE_BOXES: readonly MaskRegion[] = [
  { name: 'interLegSlit', rect: { x: 488, y: 1097, width: 38, height: 104 } },
  { name: 'bowTieNotch', rect: { x: 479, y: 824, width: 56, height: 10 } },
  { name: 'armpitLeft', rect: { x: 333, y: 824, width: 24, height: 87 } },
  { name: 'armpitRight', rect: { x: 657, y: 824, width: 24, height: 87 } },
  { name: 'shoulderNeckLeft', rect: { x: 0, y: 765, width: 343, height: 60 } },
  { name: 'shoulderNeckRight', rect: { x: 671, y: 765, width: 342, height: 60 } },
  { name: 'neckYoke', rect: { x: 344, y: 794, width: 326, height: 30 } },
  { name: 'betweenFeet', rect: { x: 459, y: 1201, width: 97, height: 33 } },
];

/** Maps a viewBox-space value onto rendered px: `value * rendered / viewBox`. */
export function scale(value: number, viewBoxSpan: number, renderedSpan: number): number {
  return (value * renderedSpan) / viewBoxSpan;
}

export interface ViewBoxToFrameOptions {
  /** The SVG's rendered content box (offsetWidth). */
  readonly renderedWidth: number;
  readonly renderedHeight: number;
  /** The captured frame's px size, including any symmetric halo. */
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly viewBoxWidth?: number;
  readonly viewBoxHeight?: number;
}

/**
 * Builds the viewBox → frame mapping. The viewBox maps onto the rendered content
 * box; the frame is that box plus a symmetric halo (the capture's 8 px halo).
 */
export function viewBoxToFrame(options: ViewBoxToFrameOptions): FrameTransform {
  const viewBoxWidth = options.viewBoxWidth ?? FREDO_AVATAR_SPACE.width;
  const viewBoxHeight = options.viewBoxHeight ?? FREDO_AVATAR_SPACE.height;
  return {
    scaleX: options.renderedWidth / viewBoxWidth,
    scaleY: options.renderedHeight / viewBoxHeight,
    offsetX: (options.frameWidth - options.renderedWidth) / 2,
    offsetY: (options.frameHeight - options.renderedHeight) / 2,
  };
}

/** Shrinks a rect by `inset` viewBox units on every edge. */
export function insetRect(rect: FredoRect, inset: number): FredoRect {
  return {
    x: rect.x + inset,
    y: rect.y + inset,
    width: rect.width - 2 * inset,
    height: rect.height - 2 * inset,
  };
}

/**
 * Pixel-index half-open range `[x0, x1) × [y0, y1)` whose pixel CENTRES fall
 * inside the viewBox rect. Exact for fractional scales (sample at centre).
 */
export function rectToPixelRange(
  rect: FredoRect,
  transform: FrameTransform,
): { x0: number; x1: number; y0: number; y1: number } {
  return {
    x0: Math.ceil(rect.x * transform.scaleX + transform.offsetX - 0.5),
    x1: Math.ceil((rect.x + rect.width) * transform.scaleX + transform.offsetX - 0.5),
    y0: Math.ceil(rect.y * transform.scaleY + transform.offsetY - 0.5),
    y1: Math.ceil((rect.y + rect.height) * transform.scaleY + transform.offsetY - 0.5),
  };
}

/** Square (Chebyshev) erosion; pixels within `radius` of the frame edge erode away. */
function erodeChebyshev(cells: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!cells[y * width + x]) continue;
      let keep = 1;
      for (let dy = -radius; dy <= radius && keep; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) {
          keep = 0;
          break;
        }
        for (let dx = -radius; dx <= radius; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= width || !cells[ny * width + nx]) {
            keep = 0;
            break;
          }
        }
      }
      if (keep) out[y * width + x] = 1;
    }
  }
  return out;
}

/**
 * Rasterises the union of `fillRects` into a binary mask, then erodes by
 * `erodePx` rendered px. `regions` are attached for per-region reporting.
 */
export function rasteriseMask(
  width: number,
  height: number,
  fillRects: readonly FredoRect[],
  transform: FrameTransform,
  erodePx = 0,
  regions: readonly MaskRegion[] = [],
): Mask {
  const cells = new Uint8Array(width * height);
  for (const rect of fillRects) {
    const { x0, x1, y0, y1 } = rectToPixelRange(rect, transform);
    const cx0 = Math.max(0, x0);
    const cx1 = Math.min(width, x1);
    const cy0 = Math.max(0, y0);
    const cy1 = Math.min(height, y1);
    for (let y = cy0; y < cy1; y += 1) {
      const row = y * width;
      for (let x = cx0; x < cx1; x += 1) cells[row + x] = 1;
    }
  }
  const finalCells = erodePx > 0 ? erodeChebyshev(cells, width, height, erodePx) : cells;
  return { width, height, cells: finalCells, transform, regions };
}

/** The intended opaque region (base rects ∪ interior bands), eroded by `erodePx`. */
export function intendedMask(
  width: number,
  height: number,
  transform: FrameTransform,
  erodePx = 2,
): Mask {
  return rasteriseMask(width, height, intendedRegionRects(), transform, erodePx, SEE_THROUGH_SUB_BANDS);
}

/**
 * The negative-space leak mask: the UI/UX boxes, each inset by `insetUnits`
 * viewBox units (the fill's ≤6-unit tuck zone is therefore excluded). Boxes
 * that degenerate under the inset contribute no cells — the plan's bow-tie
 * notch (56×10) is smaller than 2×6, so it is intentionally empty.
 */
export function negativeSpaceMask(
  width: number,
  height: number,
  transform: FrameTransform,
  insetUnits = 6,
): Mask {
  const boxes = NEGATIVE_SPACE_BOXES.map(({ name, rect }) => ({ name, rect: insetRect(rect, insetUnits) })).filter(
    ({ rect }) => rect.width > 0 && rect.height > 0,
  );
  return rasteriseMask(width, height, boxes.map((box) => box.rect), transform, 0, boxes);
}

/** Number of set cells in a mask. */
export function countMaskCells(mask: Mask): number {
  let count = 0;
  for (let i = 0; i < mask.cells.length; i += 1) {
    if (mask.cells[i]) count += 1;
  }
  return count;
}

/** Max absolute per-channel difference (R, G, B) at a pixel index. */
export function maxChannelDiff(a: Frame, b: Frame, pixelIndex: number): number {
  const i = pixelIndex * 4;
  return Math.max(
    Math.abs(a.data[i] - b.data[i]),
    Math.abs(a.data[i + 1] - b.data[i + 1]),
    Math.abs(a.data[i + 2] - b.data[i + 2]),
  );
}

function countDifferences(mask: Mask, a: Frame, b: Frame, threshold: number): RegionCounts {
  if (a.width !== mask.width || a.height !== mask.height || b.width !== mask.width || b.height !== mask.height) {
    throw new Error(
      `bodySolidityRaster: frame size ${a.width}x${a.height}/${b.width}x${b.height} does not match mask ${mask.width}x${mask.height}`,
    );
  }
  const byRegion: Record<string, number> = {};
  for (const region of mask.regions) byRegion[region.name] = 0;

  let total = 0;
  for (let row = 0; row < mask.height; row += 1) {
    const vy = (row + 0.5 - mask.transform.offsetY) / mask.transform.scaleY;
    for (let col = 0; col < mask.width; col += 1) {
      const index = row * mask.width + col;
      if (!mask.cells[index]) continue;
      if (maxChannelDiff(a, b, index) <= threshold) continue;
      total += 1;
      const vx = (col + 0.5 - mask.transform.offsetX) / mask.transform.scaleX;
      for (const region of mask.regions) {
        const r = region.rect;
        if (vx >= r.x && vx < r.x + r.width && vy >= r.y && vy < r.y + r.height) {
          byRegion[region.name] += 1;
        }
      }
    }
  }
  return { total, byRegion };
}

/**
 * Primary body-solidity oracle. `frameA` = rendered over backdrop B0, `frameD`
 * = same DOM over the probe backdrop B1 behind the figure. A pixel inside the
 * intended mask whose backdrop shows through differs by the backdrop contrast.
 */
export function seeThrough(mask: Mask, frameA: Frame, frameD: Frame, threshold = 8): RegionCounts {
  return countDifferences(mask, frameA, frameD, threshold);
}

/**
 * Leak oracle. `frameC` hides only the interior fill, so the frozen base
 * rects/overlays cancel and only the fill's own painted pixels register; a
 * difference inside the negative-space mask means the fill painted into a bound
 * gap (a genuine leak).
 */
export function leak(mask: Mask, frameA: Frame, frameC: Frame, threshold = 8): RegionCounts {
  return countDifferences(mask, frameA, frameC, threshold);
}
