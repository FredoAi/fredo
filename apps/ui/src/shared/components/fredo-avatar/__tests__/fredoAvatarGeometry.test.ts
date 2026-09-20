import { describe, expect, it } from 'vitest';
import {
  expandFredoRects,
  FREDO_AVATAR_SOURCE_RECTS,
  FREDO_AVATAR_SPACE,
  FREDO_AVATAR_VIEWBOX,
  type FredoAvatarSourceRect,
} from '../fredoAvatarGeometry';

/**
 * #2837 — geometry-table invariants for the fredo-avatar.html transcription.
 *
 * The canonical table is byte-diffed by QA against the html rect calls
 * (fredo-avatar.html:251-653); these unit tests lock the structural invariants
 * that a mistranscription would break: source count 31, rendered count 58,
 * exact mirror math x' = 1014 - x - width, every rect inside the 1014x1264
 * canvas, and the as-authored center rects rendered once (never mirrored).
 */
describe('fredoAvatarGeometry (fredo-avatar.html transcription)', () => {
  it('exports the wireframe coordinate space', () => {
    expect(FREDO_AVATAR_SPACE).toEqual({ width: 1014, height: 1264, centerX: 507 });
    expect(FREDO_AVATAR_VIEWBOX).toBe('0 0 1014 1264');
  });

  it('transcribes 31 source rect groups (27 mirrored pairs + 4 center singles)', () => {
    expect(FREDO_AVATAR_SOURCE_RECTS).toHaveLength(31);
    const mirrored = FREDO_AVATAR_SOURCE_RECTS.filter((r) => r.mirrored);
    const single = FREDO_AVATAR_SOURCE_RECTS.filter((r) => !r.mirrored);
    expect(mirrored).toHaveLength(27);
    expect(single).toHaveLength(4);
  });

  it('expands the canonical table to exactly 58 rendered rects', () => {
    const rects = expandFredoRects(FREDO_AVATAR_SOURCE_RECTS);
    expect(rects).toHaveLength(58);
  });

  it('mirror expansion is exact: x\' = 1014 - x - width for every mirrored source', () => {
    const rects = expandFredoRects(FREDO_AVATAR_SOURCE_RECTS);
    let expandedIndex = 0;
    for (const src of FREDO_AVATAR_SOURCE_RECTS) {
      const original = rects[expandedIndex];
      expect(original).toEqual({ x: src.x, y: src.y, width: src.width, height: src.height });
      expandedIndex += 1;
      if (src.mirrored) {
        const mirror = rects[expandedIndex];
        expect(mirror).toEqual({
          x: FREDO_AVATAR_SPACE.width - src.x - src.width,
          y: src.y,
          width: src.width,
          height: src.height,
        });
        expandedIndex += 1;
      }
    }
    expect(expandedIndex).toBe(58);
  });

  it('keeps every rect inside the 1014x1264 canvas', () => {
    const rects = expandFredoRects(FREDO_AVATAR_SOURCE_RECTS);
    for (const rect of rects) {
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(FREDO_AVATAR_SPACE.width);
      expect(rect.y + rect.height).toBeLessThanOrEqual(FREDO_AVATAR_SPACE.height);
    }
  });

  it('renders the 4 center singles exactly once and the two center buttons as-authored', () => {
    const singles: readonly FredoAvatarSourceRect[] = FREDO_AVATAR_SOURCE_RECTS.filter((r) => !r.mirrored);
    const singleXs = new Set(singles.map((r) => `${r.x},${r.y},${r.width},${r.height}`));
    const rects = expandFredoRects(FREDO_AVATAR_SOURCE_RECTS);
    const rectKeys = rects.map((r) => `${r.x},${r.y},${r.width},${r.height}`);
    for (const key of singleXs) {
      // Each center single appears exactly once in the expanded render list.
      expect(rectKeys.filter((k) => k === key)).toHaveLength(1);
    }
    // As-authored center buttons (no symmetrization of the 0.5-unit offset rect).
    const centerButtons = rects.filter((r) => r.y === 917 || r.y === 991);
    expect(centerButtons).toEqual([
      { x: 492, y: 917, width: 30, height: 32 },
      { x: 491, y: 991, width: 31, height: 36 },
    ]);
  });

  it('guard rejects an out-of-canvas source rect', () => {
    const bad: readonly FredoAvatarSourceRect[] = [
      { x: 1000, y: 1000, width: 100, height: 100, src: 'test', mirrored: true },
    ];
    expect(() => expandFredoRects(bad)).toThrow(/exceeds|non-integer|out-of-canvas/);
  });
});
