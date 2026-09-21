import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';

import { FredoAvatar } from '../FredoAvatar';
import { FREDO_AVATAR_STATES, isFredoAvatarState } from '../fredoAvatarStates';
import {
  buildInteriorPathD,
  expandFredoRects,
  FREDO_AVATAR_INTERIOR_RECTS,
  FREDO_AVATAR_SOURCE_RECTS,
  FREDO_AVATAR_SPACE,
  type FredoRect,
} from '../fredoAvatarGeometry';

/**
 * #2917 ST-1 / ST-3 — interior-fill layer + state-vocabulary invariants.
 *
 * ST-1: ONE additive `<path id="fredo-interior">` is present in EVERY state
 * (idle included), never a `<rect>` (the 58-rect pin is untouched), it never
 * bleeds outside the head silhouette beyond the plan's ≤8-unit tolerance, and it
 * covers ≥55 % of the head cavity.
 *
 * ST-3: `FREDO_AVATAR_STATES` is the single frozen 12-member source, the union
 * is derived from it, and `isFredoAvatarState` is the boundary guard.
 */

const BASE: readonly FredoRect[] = expandFredoRects(FREDO_AVATAR_SOURCE_RECTS);
const INTERIOR: readonly FredoRect[] = expandFredoRects(FREDO_AVATAR_INTERIOR_RECTS);

const spansRow = (rect: FredoRect, y: number): boolean => rect.y <= y && y < rect.y + rect.height;

/** Merge a list of [start, end) intervals into a sorted, non-overlapping set. */
const mergeIntervals = (intervals: ReadonlyArray<readonly [number, number]>): Array<[number, number]> => {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
};

describe('#2917 ST-1 interior fill geometry', () => {
  it('builds one non-zero-winding rect subpath per band', () => {
    const d = buildInteriorPathD([
      { x: 1, y: 2, width: 3, height: 4 },
      { x: 5, y: 6, width: 7, height: 8 },
    ]);
    expect(d).toBe('M 1 2 h 3 v 4 h -3 Z M 5 6 h 7 v 8 h -7 Z');
  });

  it('expands to 9 interior bands, all inside the 1014x1264 canvas', () => {
    expect(FREDO_AVATAR_INTERIOR_RECTS).toHaveLength(9);
    expect(INTERIOR).toHaveLength(9);
    for (const rect of INTERIOR) {
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(FREDO_AVATAR_SPACE.width);
      expect(rect.y + rect.height).toBeLessThanOrEqual(FREDO_AVATAR_SPACE.height);
    }
  });

  it('keeps the base 58-rect contract untouched (additive table only)', () => {
    expect(BASE).toHaveLength(58);
    expect(FREDO_AVATAR_SOURCE_RECTS).toHaveLength(31);
  });

  it('never bleeds outside the head silhouette beyond the ≤8-unit / ≤2-unit tolerance', () => {
    const TOLERANCE = 8;
    for (const rect of INTERIOR) {
      let run = 0;
      for (let y = rect.y; y < rect.y + rect.height; y += 1) {
        const rows = BASE.filter((b) => spansRow(b, y));
        if (rows.length === 0) {
          run = 0;
          continue;
        }
        const minX = Math.min(...rows.map((b) => b.x));
        const maxX = Math.max(...rows.map((b) => b.x + b.width));
        const overshoot = Math.max(minX - rect.x, rect.x + rect.width - maxX, 0);
        run = overshoot > TOLERANCE ? run + 1 : 0;
        expect(
          run,
          `band {${rect.x},${rect.y},${rect.width},${rect.height}} bleeds ${overshoot}u at y=${y}`,
        ).toBeLessThanOrEqual(2);
      }
    }
  });

  it('covers at least 55% of the head cavity', () => {
    let cavityArea = 0;
    let filledArea = 0;

    for (let y = 0; y < FREDO_AVATAR_SPACE.height; y += 1) {
      const rows = BASE.filter((b) => spansRow(b, y));
      if (rows.length === 0) continue;

      const minX = Math.min(...rows.map((b) => b.x));
      const maxX = Math.max(...rows.map((b) => b.x + b.width));
      const painted = mergeIntervals(rows.map((b) => [b.x, b.x + b.width] as const));

      // Cavity = the head silhouette span minus the already-painted base rects.
      let cursor = minX;
      const cavities: Array<readonly [number, number]> = [];
      for (const [start, end] of painted) {
        if (start > cursor) cavities.push([cursor, start]);
        cursor = Math.max(cursor, end);
      }
      if (cursor < maxX) cavities.push([cursor, maxX]);

      const bands = INTERIOR.filter((b) => spansRow(b, y)).map(
        (b) => [b.x, b.x + b.width] as const,
      );
      const mergedBands = mergeIntervals(bands);

      for (const [start, end] of cavities) {
        cavityArea += end - start;
        for (const [bandStart, bandEnd] of mergedBands) {
          const is = Math.max(start, bandStart);
          const ie = Math.min(end, bandEnd);
          if (ie > is) filledArea += ie - is;
        }
      }
    }

    expect(cavityArea).toBeGreaterThan(0);
    expect(filledArea / cavityArea).toBeGreaterThanOrEqual(0.55);
  });
});

describe('#2917 ST-1 interior fill render layer', () => {
  afterEach(cleanup);

  it.each([...FREDO_AVATAR_STATES])('renders the interior path in the %s state', (state) => {
    const { container } = render(<FredoAvatar size="sm" state={state} />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();

    const interior = svg!.querySelector('#fredo-interior');
    expect(interior).not.toBeNull();
    expect(interior!.tagName.toLowerCase()).toBe('path');
    expect(interior!.getAttribute('d')).toBe(buildInteriorPathD(INTERIOR));
    expect(interior!.getAttribute('data-layer')).toBe('interior');
    expect(interior!.getAttribute('fill')).toBe('var(--fredo-avatar-interior)');
    expect(interior!.getAttribute('pointer-events')).toBe('none');

    // The fill is a <path>, never a <rect> → the 58 BASE rects (direct `svg`
    // children, before the overlay <g>) stay byte-identical in every state.
    const baseRects = Array.from(svg!.children).filter(
      (el) => el.tagName.toLowerCase() === 'rect',
    );
    expect(baseRects).toHaveLength(58);
    baseRects.forEach((r, i) => {
      expect(Number(r.getAttribute('x'))).toBe(BASE[i].x);
      expect(Number(r.getAttribute('y'))).toBe(BASE[i].y);
      expect(Number(r.getAttribute('width'))).toBe(BASE[i].width);
      expect(Number(r.getAttribute('height'))).toBe(BASE[i].height);
    });

    if (state === 'idle') {
      expect(svg!.querySelector('#fredo-expression')).toBeNull();
    } else {
      expect(svg!.querySelector('#fredo-expression')?.getAttribute('data-state')).toBe(state);
    }
  });
});

describe('#2917 ST-3 state vocabulary single source', () => {
  it('freezes the 12-member vocabulary in order', () => {
    expect([...FREDO_AVATAR_STATES]).toEqual([
      'idle',
      'talk',
      'teleport-out',
      'teleport-in',
      'thinking',
      'happy',
      'playful',
      'joking',
      'listening',
      'working',
      'error',
      'greeting',
    ]);
    expect(FREDO_AVATAR_STATES).not.toContain('success');
    expect(FREDO_AVATAR_STATES).not.toContain('waiting');
    expect(FREDO_AVATAR_STATES).not.toContain('reasoning');
  });

  it('isFredoAvatarState admits members and drops unknown values', () => {
    for (const state of FREDO_AVATAR_STATES) {
      expect(isFredoAvatarState(state)).toBe(true);
    }
    expect(isFredoAvatarState('success')).toBe(false);
    expect(isFredoAvatarState('waiting')).toBe(false);
    expect(isFredoAvatarState('')).toBe(false);
    expect(isFredoAvatarState('IDLE')).toBe(false);
  });
});
