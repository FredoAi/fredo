/**
 * Own window-kernel float geometry tests (Spec #2924 ST-1).
 *
 * Pins the pure geometry rules extracted from `WindowFrame` (REQ-1/REQ-8/REQ-7):
 *  1. `resolveFloatGeometry` derives a container-centered float with NO cascade
 *     (`min(DEFAULT, workspace − 2×GESTURE_INSET)` floored at MIN), and falls
 *     back to DEFAULT at 0,0 when the workspace is unmeasured (jsdom/pre-layout).
 *  2. `clampToWorkspace` keeps >= GESTURE_INSET of the window on screen
 *     horizontally and never lets the top edge leave the top.
 */

import { describe, it, expect } from 'vitest';

import {
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  MIN_WIDTH,
  MIN_HEIGHT,
  GESTURE_INSET,
  resolveFloatGeometry,
  clampToWorkspace,
  type Geometry,
} from '../windowGeometry';

describe('windowGeometry — resolveFloatGeometry (REQ-8, REQ-1)', () => {
  it('falls back to DEFAULT at 0,0 when the workspace is unmeasured', () => {
    expect(resolveFloatGeometry(null)).toEqual({
      x: 0,
      y: 0,
      width: DEFAULT_WIDTH,
      height: DEFAULT_HEIGHT,
    });
  });

  it('falls back to DEFAULT at 0,0 for a degenerate (pre-layout) workspace', () => {
    expect(resolveFloatGeometry({ width: 0, height: 0 })).toEqual({
      x: 0,
      y: 0,
      width: DEFAULT_WIDTH,
      height: DEFAULT_HEIGHT,
    });
  });

  it('centers the default card in a large workspace (no cascade)', () => {
    const workspace = { width: 1920, height: 1017 };
    const geom = resolveFloatGeometry(workspace);
    expect(geom).toEqual({
      x: (1920 - DEFAULT_WIDTH) / 2,
      y: (1017 - DEFAULT_HEIGHT) / 2,
      width: DEFAULT_WIDTH,
      height: DEFAULT_HEIGHT,
    });
    // Cascade fingerprint 48 + idx*16 would put x/y at 48/64/... — the derived
    // float must never land on a cascade offset.
    expect(geom.x).not.toBe(48);
    expect(geom.y).not.toBe(48);
    expect(geom.x).not.toBe(64);
    expect(geom.y).not.toBe(64);
  });

  it('shrinks to the workspace with a GESTURE_INSET margin, floored at MIN', () => {
    // 500 - 48 = 452 (below DEFAULT 480, above MIN 320) → width 452.
    // 400 - 48 = 352 (above DEFAULT 320) → height 320.
    expect(resolveFloatGeometry({ width: 500, height: 400 })).toEqual({
      x: (500 - 452) / 2,
      y: (400 - 320) / 2,
      width: 452,
      height: 320,
    });
  });

  it('floors at MIN (never below 320×200) in a tiny workspace and stays on-screen', () => {
    const geom = resolveFloatGeometry({ width: 300, height: 100 });
    expect(geom.width).toBe(MIN_WIDTH);
    expect(geom.height).toBe(MIN_HEIGHT);
    expect(geom.x).toBe(0);
    expect(geom.y).toBe(0);
  });

  it('is centered (equal slack on both sides) whenever the workspace fits', () => {
    const workspace = { width: 1000, height: 800 };
    const geom = resolveFloatGeometry(workspace);
    expect(workspace.width - (geom.x + geom.width)).toBe(geom.x);
    expect(workspace.height - (geom.y + geom.height)).toBe(geom.y);
  });
});

describe('windowGeometry — clampToWorkspace (REQ-7)', () => {
  const workspace = { width: 1000, height: 800 };
  const base: Geometry = { x: 100, y: 100, width: 480, height: 320 };

  it('leaves an on-screen float unchanged', () => {
    expect(clampToWorkspace(base, workspace)).toEqual(base);
  });

  it('leaves geometry untouched when there is no measured workspace', () => {
    const off: Geometry = { x: -999, y: -5, width: 480, height: 320 };
    expect(clampToWorkspace(off, null)).toEqual(off);
  });

  it('keeps GESTURE_INSET of the window visible when dragged past the left edge', () => {
    const clamped = clampToWorkspace({ ...base, x: -5000 }, workspace);
    // Right edge = x + width must be exactly GESTURE_INSET inside.
    expect(clamped.x + clamped.width).toBe(GESTURE_INSET);
    expect(clamped.x).toBe(GESTURE_INSET - base.width);
  });

  it('keeps GESTURE_INSET of the window visible when dragged past the right edge', () => {
    const clamped = clampToWorkspace({ ...base, x: 5000 }, workspace);
    expect(clamped.x).toBe(workspace.width - GESTURE_INSET);
    // Left edge is exactly the insets from the right side.
    expect(workspace.width - clamped.x).toBe(GESTURE_INSET);
  });

  it('never lets the top edge leave the top and otherwise preserves size', () => {
    const clamped = clampToWorkspace({ ...base, y: -400 }, workspace);
    expect(clamped.y).toBe(0);
    expect(clamped.width).toBe(base.width);
    expect(clamped.height).toBe(base.height);
  });
});
