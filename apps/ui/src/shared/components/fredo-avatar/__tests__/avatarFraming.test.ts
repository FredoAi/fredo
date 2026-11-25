/**
 * #3210 ST-3 — the frozen framing contract (`three/avatarFraming.ts`).
 *
 * The numbers asserted here are the ones the deleted SVG produced: the 58-rect
 * body union spanned 0.8284 of the canvas width and 0.9233 of its height, with the
 * feet 0.0237 above the bottom edge. The reference canvas is 1014x1264 and both
 * shipped display boxes are 0.8 (80x100 / 132x165), so a 0.8 frame at height 100
 * is the fixture: the body must occupy 66.272 x 92.33 of it.
 */

import { describe, expect, it } from 'vitest';
import { Box3, Vector3 } from 'three';

import {
  AVATAR_FRAMING,
  computeOrthoFraming,
  framingCenterX,
} from '../three/avatarFraming';

/** The portrait ratio both shipped avatar boxes use. */
const BOX_ASPECT = 80 / 100;

/** Build a body box from its extents (the camera fit reads only the extents). */
function bodyBox(minX: number, minY: number, width: number, height: number): Box3 {
  return new Box3().setFromPoints([
    new Vector3(minX, minY, 0),
    new Vector3(minX + width, minY + height, 0),
  ]);
}

describe('AVATAR_FRAMING (frozen literals, U-5)', () => {
  it('pins the SVG-derived fractions so art drift cannot silently re-frame', () => {
    expect(AVATAR_FRAMING.contentWidthFraction).toBe(0.8284);
    expect(AVATAR_FRAMING.contentHeightFraction).toBe(0.9233);
    expect(AVATAR_FRAMING.bottomMarginFraction).toBe(0.0237);
    expect(AVATAR_FRAMING.anchorXFraction).toBe(0.5);
  });
});

describe('computeOrthoFraming', () => {
  it('reproduces the reference proportions at the shipped size', () => {
    // The body occupies exactly the frozen fractions of a 80x100 frame.
    const box = bodyBox(-33.136, 5, 66.272, 92.33);
    const framing = computeOrthoFraming(box, BOX_ASPECT);

    expect(framing.right - framing.left).toBeCloseTo(80, 5);
    expect(framing.top - framing.bottom).toBeCloseTo(100, 5);
    expect(framing.left).toBeCloseTo(-40, 5);
    expect(framing.top).toBeCloseTo(50, 5);

    // Feet sit bottomMarginFraction above the frame's bottom edge.
    const frameBottom = framing.centerY + framing.bottom;
    expect(box.min.y - frameBottom).toBeCloseTo(0.0237 * 100, 5);
    expect(framing.centerY).toBeCloseTo(52.63, 5);
  });

  it('fits the WIDTH when the body is wider than the frozen width fraction', () => {
    const box = bodyBox(-60, 0, 120, 10);
    const framing = computeOrthoFraming(box, BOX_ASPECT);

    const frameWidth = framing.right - framing.left;
    expect(120 / frameWidth).toBeCloseTo(0.8284, 4);
    // The frame still matches the canvas aspect, so nothing distorts.
    expect(frameWidth / (framing.top - framing.bottom)).toBeCloseTo(BOX_ASPECT, 6);
  });

  it('fits the HEIGHT when the body is tall and narrow', () => {
    const box = bodyBox(-5, 0, 10, 92.33);
    const framing = computeOrthoFraming(box, BOX_ASPECT);

    expect(framing.top - framing.bottom).toBeCloseTo(100, 5);
    expect(10 / (framing.right - framing.left)).toBeLessThan(
      AVATAR_FRAMING.contentWidthFraction,
    );
  });

  it('never re-fits per state: the same box always yields the same frame', () => {
    const box = bodyBox(-33, 0, 66, 92);
    expect(computeOrthoFraming(box, BOX_ASPECT)).toEqual(
      computeOrthoFraming(box, BOX_ASPECT),
    );
  });

  it('returns a finite centred frame for an empty measurement', () => {
    const framing = computeOrthoFraming(new Box3(), BOX_ASPECT);

    expect(Number.isFinite(framing.left)).toBe(true);
    expect(Number.isFinite(framing.centerY)).toBe(true);
    expect(framing.top).toBe(0.5);
    expect(framing.left).toBeCloseTo(-0.4, 6);
    expect(framing.centerY).toBe(0);
  });

  it('falls back to the shipped portrait aspect for a bad target aspect', () => {
    const box = bodyBox(-33.136, 5, 66.272, 92.33);
    expect(computeOrthoFraming(box, Number.NaN)).toEqual(
      computeOrthoFraming(box, BOX_ASPECT),
    );
    expect(computeOrthoFraming(box, 0)).toEqual(computeOrthoFraming(box, BOX_ASPECT));
  });

  it('centres the camera on the measured body', () => {
    const box = bodyBox(12, 3, 40, 50);
    expect(framingCenterX(box)).toBeCloseTo(32, 6);
    expect(framingCenterX(new Box3())).toBe(0);
  });
});
