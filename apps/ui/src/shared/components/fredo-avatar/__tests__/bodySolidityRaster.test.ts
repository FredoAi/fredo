/**
 * #2922 ST-5 — synthetic-frame unit suite proving the corrected body-solidity
 * oracle's discriminating power.
 *
 * The round-1 FAIL was an evidence-oracle failure: the plan's flood-fill `hole`
 * metric reported 0 on BOTH the fixed tip and the pre-fix checkout, so it could
 * not certify the AC. This suite pins the replacement metric's power with
 * synthetic frames built from the frozen geometry — a HOLLOW body must register
 * see-through, a FILLED body must not, a fill that bleeds into bound negative
 * space must register as a leak, and a correct fill must not.
 *
 * All fixtures are local and pure; the module-level masks are immutable and the
 * pins never read global/order-dependent state (G-222).
 */

import { describe, expect, it } from 'vitest';

import { FREDO_AVATAR_SPACE, type FredoRect } from '../fredoAvatarGeometry';
import {
  FREDO_BASE_RECTS,
  INTENDED_INTERIOR_BANDS,
  NEGATIVE_SPACE_BOXES,
  SEE_THROUGH_SUB_BANDS,
  countMaskCells,
  intendedMask,
  intendedRegionRects,
  leak,
  maxChannelDiff,
  negativeSpaceMask,
  rasteriseMask,
  rectToPixelRange,
  scale,
  seeThrough,
  viewBoxToFrame,
  type Frame,
  type FrameTransform,
  type Rgb,
} from './bodySolidityRaster';

const VIEW = FREDO_AVATAR_SPACE;

/** The #2917-validated high-scale leg: viewBox units map 1:1 to raster px. */
const TRANSFORM = viewBoxToFrame({
  renderedWidth: VIEW.width,
  renderedHeight: VIEW.height,
  frameWidth: VIEW.width,
  frameHeight: VIEW.height,
});

const B0: Rgb = { r: 12, g: 17, b: 23 }; // dark backdrop
const B1: Rgb = { r: 255, g: 255, b: 255 }; // solid probe backdrop (dark presets)
const ACCENT: Rgb = { r: 90, g: 200, b: 220 }; // frozen base-rect ink
const FILL: Rgb = { r: 40, g: 90, b: 100 }; // interior fill
const T = 8;

// ---- synthetic frame builders (fixtures, not oracle math) ------------------

function createFrame(backdrop: Rgb): Frame {
  const data = new Uint8ClampedArray(VIEW.width * VIEW.height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = backdrop.r;
    data[i + 1] = backdrop.g;
    data[i + 2] = backdrop.b;
    data[i + 3] = 255;
  }
  return { width: VIEW.width, height: VIEW.height, data };
}

function paintRect(frame: Frame, rect: FredoRect, color: Rgb): void {
  const { x0, x1, y0, y1 } = rectToPixelRange(rect, TRANSFORM);
  const cx0 = Math.max(0, x0);
  const cx1 = Math.min(frame.width, x1);
  const cy0 = Math.max(0, y0);
  const cy1 = Math.min(frame.height, y1);
  for (let y = cy0; y < cy1; y += 1) {
    for (let x = cx0; x < cx1; x += 1) {
      const i = (y * frame.width + x) * 4;
      frame.data[i] = color.r;
      frame.data[i + 1] = color.g;
      frame.data[i + 2] = color.b;
      frame.data[i + 3] = 255;
    }
  }
}

function cloneFrame(frame: Frame): Frame {
  return { width: frame.width, height: frame.height, data: new Uint8ClampedArray(frame.data) };
}

/**
 * A faithful synthetic render: the interior fill is drawn FIRST, the 58 base
 * rects paint on top (matching `FredoAvatar.tsx` paint order). With
 * `filled: false` the body cavity stays transparent and shows the backdrop.
 */
function renderFrame(backdrop: Rgb, filled: boolean): Frame {
  const frame = createFrame(backdrop);
  if (filled) {
    for (const rect of intendedRegionRects()) paintRect(frame, rect, FILL);
  }
  for (const rect of FREDO_BASE_RECTS) paintRect(frame, rect, ACCENT);
  return frame;
}

const INTENDED = intendedMask(VIEW.width, VIEW.height, TRANSFORM, 2);
const NEGATIVE = negativeSpaceMask(VIEW.width, VIEW.height, TRANSFORM, 6);

// ---------------------------------------------------------------------------

describe('#2922 ST-5 frozen mask-source constants', () => {
  it('freezes the 17 intended interior bands (9 head + 8 body) with exact geometry', () => {
    expect(INTENDED_INTERIOR_BANDS).toHaveLength(17);
    expect(INTENDED_INTERIOR_BANDS.slice(0, 9).map((r) => [r.x, r.y, r.width, r.height])).toEqual([
      [364, 106, 286, 43],
      [270, 150, 474, 44],
      [210, 194, 594, 76],
      [161, 270, 692, 47],
      [122, 317, 770, 268],
      [160, 585, 694, 58],
      [209, 644, 596, 41],
      [270, 686, 474, 42],
      [337, 727, 340, 34],
    ]);
    expect(INTENDED_INTERIOR_BANDS.slice(9).map((r) => [r.x, r.y, r.width, r.height])).toEqual([
      [382, 824, 51, 10],
      [581, 824, 51, 10],
      [382, 834, 250, 82],
      [414, 916, 186, 93],
      [327, 1009, 360, 52],
      [327, 1061, 360, 24],
      [355, 1085, 133, 115],
      [526, 1085, 133, 115],
    ]);
    for (const r of INTENDED_INTERIOR_BANDS) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.width).toBeLessThanOrEqual(VIEW.width);
      expect(r.y + r.height).toBeLessThanOrEqual(VIEW.height);
    }
  });

  it('keeps the 58 base rects and the 75-rect intended region', () => {
    expect(FREDO_BASE_RECTS).toHaveLength(58);
    expect(intendedRegionRects()).toHaveLength(58 + 17);
  });

  it('freezes the body sub-bands (names + viewBox y-ranges)', () => {
    expect(SEE_THROUGH_SUB_BANDS.map((b) => b.name)).toEqual([
      'bowTie',
      'upperArms',
      'innerArms',
      'buttons',
      'lowerArms',
      'hips',
      'legs',
      'feet',
    ]);
    expect(SEE_THROUGH_SUB_BANDS.map((b) => [b.rect.y, b.rect.y + b.rect.height])).toEqual([
      [812, 868],
      [824, 911],
      [856, 916],
      [917, 1027],
      [916, 1061],
      [1009, 1085],
      [1085, 1201],
      [1201, 1234],
    ]);
  });

  it('freezes the UI/UX negative-space boxes', () => {
    expect(NEGATIVE_SPACE_BOXES.map((b) => b.name)).toEqual([
      'interLegSlit',
      'bowTieNotch',
      'armpitLeft',
      'armpitRight',
      'shoulderNeckLeft',
      'shoulderNeckRight',
      'neckYoke',
      'betweenFeet',
    ]);
    expect(NEGATIVE_SPACE_BOXES.map((b) => [b.rect.x, b.rect.y, b.rect.width, b.rect.height])).toEqual([
      [488, 1097, 38, 104],
      [479, 824, 56, 10],
      [333, 824, 24, 87],
      [657, 824, 24, 87],
      [0, 765, 343, 60],
      [671, 765, 342, 60],
      [344, 794, 326, 30],
      [459, 1201, 97, 33],
    ]);
  });
});

describe('#2922 ST-5 raster primitives', () => {
  it('scale maps viewBox units onto rendered px', () => {
    expect(scale(1014, 1014, 80)).toBe(80);
    expect(scale(507, 1014, 80)).toBe(40);
    expect(scale(0, 1014, 80)).toBe(0);
  });

  it('viewBoxToFrame maps the native 80x100 crop with its 8 px halo', () => {
    const t = viewBoxToFrame({
      renderedWidth: 80,
      renderedHeight: 100,
      frameWidth: 96,
      frameHeight: 116,
    });
    expect(t.scaleX).toBeCloseTo(80 / 1014, 12);
    expect(t.scaleY).toBeCloseTo(100 / 1264, 12);
    expect(t.offsetX).toBe(8);
    expect(t.offsetY).toBe(8);
  });

  it('rasterises a rect, then erodes it by the requested rendered px', () => {
    const t: FrameTransform = { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 };
    const rect: FredoRect = { x: 2, y: 2, width: 4, height: 4 };
    expect(rectToPixelRange(rect, t)).toEqual({ x0: 2, x1: 6, y0: 2, y1: 6 });
    expect(countMaskCells(rasteriseMask(10, 10, [rect], t, 0))).toBe(16);
    expect(countMaskCells(rasteriseMask(10, 10, [rect], t, 1))).toBe(4);
  });

  it('maxChannelDiff takes the largest per-channel delta', () => {
    const a = createFrame({ r: 10, g: 20, b: 30 });
    const b = createFrame({ r: 11, g: 25, b: 30 });
    expect(maxChannelDiff(a, b, 0)).toBe(5);
  });

  it('rejects frames whose size does not match the mask', () => {
    const small: Frame = { width: 4, height: 4, data: new Uint8ClampedArray(4 * 4 * 4) };
    expect(() => seeThrough(INTENDED, small, small)).toThrow(/does not match/);
  });
});

describe('#2922 ST-5 mask separates intended body from negative space', () => {
  it('includes a known body-interior point and excludes it from negative space', () => {
    const interior = 950 * VIEW.width + 507; // centre of body band 13
    expect(INTENDED.cells[interior]).toBe(1);
    expect(NEGATIVE.cells[interior]).toBe(0);
  });

  it('excludes the inter-leg slit from the intended mask and includes it in negative space', () => {
    const slit = 1150 * VIEW.width + 507;
    expect(INTENDED.cells[slit]).toBe(0);
    expect(NEGATIVE.cells[slit]).toBe(1);
  });

  it('drops the 56x10 bow-tie notch under the 6-unit inset (degenerate box)', () => {
    expect(NEGATIVE.regions.map((r) => r.name)).not.toContain('bowTieNotch');
    expect(NEGATIVE.regions).toHaveLength(7);
  });
});

describe('#2922 ST-5 seeThrough oracle discriminates hollow vs filled', () => {
  it('HOLLOW body: a differing backdrop behind the figure registers see-through', () => {
    const a = renderFrame(B0, false);
    const d = renderFrame(B1, false);
    const result = seeThrough(INTENDED, a, d, T);

    expect(result.total).toBeGreaterThan(0);
    expect(result.byRegion.buttons).toBeGreaterThan(0);
    expect(result.byRegion.legs).toBeGreaterThan(0);
    // The feet band carries only opaque base-rect ink → never see-through.
    expect(result.byRegion.feet).toBe(0);
    // Opaque base-rect pixels are not counted, so this is not "every mask cell".
    expect(result.total).toBeLessThan(countMaskCells(INTENDED));
  });

  it('FILLED body: identical A/D inside the mask registers zero see-through', () => {
    const a = renderFrame(B0, true);
    const d = renderFrame(B1, true);
    const result = seeThrough(INTENDED, a, d, T);

    expect(result.total).toBe(0);
    expect(countMaskCells(INTENDED)).toBeGreaterThan(0);
    for (const count of Object.values(result.byRegion)) expect(count).toBe(0);
  });

  it('self-control: the fill-hidden frame as "A" detects the absent fill without a second checkout', () => {
    // Control (d) of the Fix Plan — run with frame C in the A slot.
    const c = renderFrame(B0, false);
    const d = renderFrame(B1, false);
    expect(seeThrough(INTENDED, c, d, T).total).toBeGreaterThan(0);
  });

  it('negative space is outside the intended mask: a slit-only difference is invisible', () => {
    const base = renderFrame(B0, false);
    const withSlitDiff = cloneFrame(base);
    paintRect(withSlitDiff, { x: 488, y: 1097, width: 38, height: 104 }, FILL);
    expect(seeThrough(INTENDED, withSlitDiff, base, T).total).toBe(0);
  });

  it('threshold is strict: a delta of exactly T is not counted, T+1 is', () => {
    const a = renderFrame(B0, true);
    const d = renderFrame(B0, true);
    const index = 950 * VIEW.width + 450;
    expect(INTENDED.cells[index]).toBe(1);

    a.data[index * 4] += T;
    expect(seeThrough(INTENDED, a, d, T).total).toBe(0);

    a.data[index * 4] += 1;
    expect(seeThrough(INTENDED, a, d, T).total).toBe(1);
  });
});

describe('#2922 ST-5 leak oracle discriminates fill bleed vs correct negative space', () => {
  it('correct fill: the negative space legitimately shows the backdrop → zero leak', () => {
    const a = renderFrame(B0, true);
    const c = renderFrame(B0, false);
    expect(leak(NEGATIVE, a, c, T).total).toBe(0);
  });

  it('leaking fill: a difference inside a bound negative-space box registers', () => {
    const leaky = renderFrame(B0, true);
    paintRect(leaky, { x: 494, y: 1103, width: 26, height: 92 }, FILL); // inside the inset slit box
    const c = renderFrame(B0, false);
    const result = leak(NEGATIVE, leaky, c, T);

    expect(result.total).toBeGreaterThan(0);
    expect(result.byRegion.interLegSlit).toBeGreaterThan(0);
  });

  it('applies the 6-unit inset: a difference on the pre-inset rim is not a leak', () => {
    const rim = renderFrame(B0, true);
    paintRect(rim, { x: 488, y: 1097, width: 5, height: 104 }, FILL); // x 488–493
    const c = renderFrame(B0, false);
    expect(leak(NEGATIVE, rim, c, T).total).toBe(0);

    const inner = renderFrame(B0, true);
    paintRect(inner, { x: 494, y: 1103, width: 26, height: 92 }, FILL);
    expect(leak(NEGATIVE, inner, c, T).total).toBeGreaterThan(0);
  });

  it('leak and seeThrough are independent: a slit leak is invisible to seeThrough', () => {
    const leaky = renderFrame(B0, true);
    paintRect(leaky, { x: 494, y: 1103, width: 26, height: 92 }, FILL);
    const filledOverB1 = renderFrame(B1, true);

    expect(leak(NEGATIVE, leaky, renderFrame(B0, false), T).total).toBeGreaterThan(0);
    expect(seeThrough(INTENDED, leaky, filledOverB1, T).total).toBe(0);
  });
});
