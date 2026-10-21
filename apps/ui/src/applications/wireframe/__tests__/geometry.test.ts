/**
 * Wireframe geometry primitives (Spec #3070, ST-1).
 *
 * Pins the declared clamps, the 1-dp C7 geometry formatting and the fit-page
 * maths (whole page visible, centred, never clipped).
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_PAGE_SIZE,
  MAX_VIEW_SCALE,
  MIN_PAGE_SIZE,
  MIN_VIEW_SCALE,
  centredRect,
  clampPageDimension,
  clampRectToPage,
  clampViewScale,
  fitView,
  formatGeometry,
  rectsIntersect,
  roundTo1dp,
} from '../model/geometry';

describe('page + view clamps', () => {
  it('clamps page dimensions to 64..4096 and rounds to whole px', () => {
    expect(clampPageDimension(32)).toBe(MIN_PAGE_SIZE);
    expect(clampPageDimension(99999)).toBe(MAX_PAGE_SIZE);
    expect(clampPageDimension(640.4)).toBe(640);
    expect(clampPageDimension(Number.NaN)).toBe(MIN_PAGE_SIZE);
  });

  it('clamps the view scale to 0.1..4', () => {
    expect(clampViewScale(0.05)).toBe(MIN_VIEW_SCALE);
    expect(clampViewScale(8)).toBe(MAX_VIEW_SCALE);
    expect(clampViewScale(1.5)).toBe(1.5);
    expect(clampViewScale(Number.NaN)).toBe(1);
  });
});

describe('geometry formatting', () => {
  it('rounds to one decimal place', () => {
    expect(roundTo1dp(1.04)).toBe(1);
    expect(roundTo1dp(1.06)).toBe(1.1);
    expect(roundTo1dp(-0.04)).toBe(0);
  });

  it('formats the C7 selection geometry as x,y,w,h', () => {
    expect(formatGeometry({ x: 480, y: 376, width: 320, height: 48 })).toBe(
      '480,376,320,48',
    );
    expect(formatGeometry({ x: 1.04, y: 2.06, width: 3.333, height: 4.05 })).toBe(
      '1,2.1,3.3,4.1',
    );
  });
});

describe('rect helpers', () => {
  it('detects overlaps but not touching edges', () => {
    const a = { x: 0, y: 0, width: 10, height: 10 };
    expect(rectsIntersect(a, { x: 5, y: 5, width: 10, height: 10 })).toBe(true);
    expect(rectsIntersect(a, { x: 10, y: 0, width: 10, height: 10 })).toBe(false);
    expect(rectsIntersect(a, { x: 20, y: 20, width: 10, height: 10 })).toBe(false);
  });

  it('clamps an origin onto the page without shrinking the box', () => {
    const page = { width: 1280, height: 800 };
    expect(clampRectToPage({ x: -20, y: 900, width: 100, height: 100 }, page)).toEqual({
      x: 0,
      y: 700,
      width: 100,
      height: 100,
    });
    expect(clampRectToPage({ x: 40, y: 20, width: 2000, height: 50 }, page)).toEqual({
      x: 0,
      y: 20,
      width: 2000,
      height: 50,
    });
  });

  it('centres a box on the page', () => {
    expect(centredRect({ width: 1280, height: 800 }, 320, 48)).toEqual({
      x: 480,
      y: 376,
      width: 320,
      height: 48,
    });
  });
});

describe('fit view', () => {
  it('fits the whole page inside the measured viewport and centres it', () => {
    const view = fitView({ width: 1280, height: 800 }, { width: 1000, height: 800 });
    expect(view.scale).toBeCloseTo(0.73125, 5);
    expect(view.scale * 1280).toBeLessThanOrEqual(1000);
    expect(view.scale * 800).toBeLessThanOrEqual(800);
    expect(view.x).toBeCloseTo(32, 5);
    expect(view.y).toBeCloseTo(107.5, 5);
  });

  it('keeps a phone page fully visible at 100%+ scale', () => {
    const view = fitView({ width: 390, height: 844 }, { width: 1200, height: 900 });
    expect(view.scale).toBeGreaterThan(0.9);
    expect(view.scale * 390).toBeLessThanOrEqual(1200);
    expect(view.scale * 844).toBeLessThanOrEqual(900);
  });

  it('falls back to 100% at the origin for a degenerate viewport', () => {
    expect(fitView({ width: 1280, height: 800 }, { width: 0, height: 0 })).toEqual({
      scale: 1,
      x: 0,
      y: 0,
    });
  });
});
