/**
 * lifePatterns — the bounded curated Conway's Game of Life pattern catalogue
 * plus the deterministic seeded PRNG and the 8 dihedral orientation transform
 * (Spec #2915, ST-2).
 *
 * ---------------------------------------------------------------------------
 * ATTRIBUTION + LICENCE (CC BY-SA 3.0)
 * ---------------------------------------------------------------------------
 * The pattern coordinates below are an authored, BOUNDED subset of the
 * **Life Lexicon** by **Stephen A. Silver**
 * (https://conwaylife.com/patterns/ — the canonical Life Lexicon mirror),
 * which is licensed under the **Creative Commons Attribution-ShareAlike 3.0
 * Unported License (CC BY-SA 3.0)**:
 *   https://creativecommons.org/licenses/by-sa/3.0/
 *
 * Exactly `LIFE_PATTERN_COUNT` (10) named patterns are curated here — glider,
 * LWSS, blinker, toad, block, beehive, pulsar, acorn, R-pentomino and the
 * Gosper glider gun. This is a bounded authored subset of well-known Life
 * patterns; the full Life Lexicon dataset is NEVER bundled. If these
 * coordinates are redistributed or adapted, the CC BY-SA 3.0 terms apply.
 * ---------------------------------------------------------------------------
 *
 * Every pattern is stored as explicit `[col, row]` offsets with the origin at
 * the top-left of its bounding box (`width` × `height` cells). The catalogue is
 * DATA ONLY — no DOM, no canvas, no React — so it is unit-testable headlessly.
 */

import { LIFE_PATTERN_COUNT } from './lifeConstants';

/** A named Life pattern: its bounding box plus explicit live-cell offsets. */
export interface LifePattern {
  /** Stable pattern name (e.g. `'glider'`). */
  name: string;
  /** Bounding-box width in cells. */
  width: number;
  /** Bounding-box height in cells. */
  height: number;
  /** Live-cell offsets as `[col, row]`, origin at the bounding-box top-left. */
  cells: readonly (readonly [number, number])[];
}

/** Glider — the smallest spaceship: translates (1,1) every 4 generations. */
const GLIDER: LifePattern = {
  name: 'glider',
  width: 3,
  height: 3,
  cells: [
    [1, 0],
    [2, 1],
    [0, 2],
    [1, 2],
    [2, 2],
  ],
};

/** LWSS — lightweight spaceship (period-4, orthogonal). */
const LWSS: LifePattern = {
  name: 'LWSS',
  width: 5,
  height: 4,
  cells: [
    [1, 0],
    [4, 0],
    [0, 1],
    [0, 2],
    [4, 2],
    [0, 3],
    [1, 3],
    [2, 3],
    [3, 3],
  ],
};

/** Blinker — the period-2 oscillator. */
const BLINKER: LifePattern = {
  name: 'blinker',
  width: 3,
  height: 1,
  cells: [
    [0, 0],
    [1, 0],
    [2, 0],
  ],
};

/** Toad — the smallest period-2 oscillator after the blinker. */
const TOAD: LifePattern = {
  name: 'toad',
  width: 4,
  height: 2,
  cells: [
    [1, 0],
    [2, 0],
    [3, 0],
    [0, 1],
    [1, 1],
    [2, 1],
  ],
};

/** Block — the smallest still life. */
const BLOCK: LifePattern = {
  name: 'block',
  width: 2,
  height: 2,
  cells: [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ],
};

/** Beehive — a common still life. */
const BEEHIVE: LifePattern = {
  name: 'beehive',
  width: 4,
  height: 3,
  cells: [
    [1, 0],
    [2, 0],
    [0, 1],
    [3, 1],
    [1, 2],
    [2, 2],
  ],
};

/** Pulsar — a large symmetrical period-3 oscillator (48 cells). */
const PULSAR: LifePattern = {
  name: 'pulsar',
  width: 13,
  height: 13,
  cells: [
    [2, 0], [3, 0], [4, 0], [8, 0], [9, 0], [10, 0],
    [0, 2], [5, 2], [7, 2], [12, 2],
    [0, 3], [5, 3], [7, 3], [12, 3],
    [0, 4], [5, 4], [7, 4], [12, 4],
    [2, 5], [3, 5], [4, 5], [8, 5], [9, 5], [10, 5],
    [2, 7], [3, 7], [4, 7], [8, 7], [9, 7], [10, 7],
    [0, 8], [5, 8], [7, 8], [12, 8],
    [0, 9], [5, 9], [7, 9], [12, 9],
    [0, 10], [5, 10], [7, 10], [12, 10],
    [2, 12], [3, 12], [4, 12], [8, 12], [9, 12], [10, 12],
  ],
};

/** Acorn — a small methuselah that runs for 5,206 generations. */
const ACORN: LifePattern = {
  name: 'acorn',
  width: 7,
  height: 3,
  cells: [
    [1, 0],
    [3, 1],
    [0, 2],
    [1, 2],
    [4, 2],
    [5, 2],
    [6, 2],
  ],
};

/** R-pentomino — the famous 5-cell methuselah (stabilises after 1,103 gens). */
const R_PENTOMINO: LifePattern = {
  name: 'R-pentomino',
  width: 3,
  height: 3,
  cells: [
    [1, 0],
    [2, 0],
    [0, 1],
    [1, 1],
    [1, 2],
  ],
};

/** Gosper glider gun — the first discovered finite pattern with unbounded growth. */
const GOSPER_GLIDER_GUN: LifePattern = {
  name: 'Gosper glider gun',
  width: 36,
  height: 9,
  cells: [
    [24, 0],
    [22, 1], [24, 1],
    [12, 2], [13, 2], [22, 2], [23, 2], [34, 2], [35, 2],
    [11, 3], [15, 3], [22, 3], [23, 3], [34, 3], [35, 3],
    [0, 4], [1, 4], [10, 4], [16, 4], [22, 4], [23, 4],
    [0, 5], [1, 5], [10, 5], [14, 5], [16, 5], [17, 5], [22, 5], [24, 5],
    [10, 6], [16, 6], [24, 6],
    [11, 7], [15, 7],
    [12, 8], [13, 8],
  ],
};

/**
 * The bounded curated catalogue — exactly `LIFE_PATTERN_COUNT` (10) named Life
 * Lexicon patterns (see the CC BY-SA 3.0 header above). The engine places a
 * random 2–4 of these per populate/reseed, at a random position and one of the
 * 8 dihedral orientations.
 */
export const LIFE_PATTERNS: readonly LifePattern[] = [
  GLIDER,
  LWSS,
  BLINKER,
  TOAD,
  BLOCK,
  BEEHIVE,
  PULSAR,
  ACORN,
  R_PENTOMINO,
  GOSPER_GLIDER_GUN,
];

// Compile-time guard: the catalogue can never drift from the authored count.
if (LIFE_PATTERNS.length !== LIFE_PATTERN_COUNT) {
  throw new Error(
    `LIFE_PATTERNS must hold exactly ${LIFE_PATTERN_COUNT} patterns (got ${LIFE_PATTERNS.length})`,
  );
}

/**
 * Deterministic 32-bit PRNG (mulberry32). The SAME seed always yields the SAME
 * sequence — this is the `data-life-seed` contract: a per-load seed reproduces
 * that load's initial field. Returns floats in `[0, 1)`.
 */
export function createLifeRng(seed: number): () => number {
  let state = seed >>> 0;
  return function next(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One of the 8 dihedral orientations of a pattern, as `[col, row]` offsets
 * normalised back to the origin (min col/row = 0). `orientation` is taken mod 8,
 * so any integer maps onto a valid orientation; a non-finite input falls through
 * to the final (anti-transpose) variant rather than throwing.
 */
export function orientPattern(
  pattern: LifePattern,
  orientation: number,
): readonly (readonly [number, number])[] {
  const variant = ((Math.trunc(orientation) % 8) + 8) % 8;
  const transformed: Array<readonly [number, number]> = pattern.cells.map(([x, y]) => {
    switch (variant) {
      case 0:
        return [x, y] as const;
      case 1:
        return [y, -x] as const;
      case 2:
        return [-x, -y] as const;
      case 3:
        return [-y, x] as const;
      case 4:
        return [-x, y] as const;
      case 5:
        return [x, -y] as const;
      case 6:
        return [y, x] as const;
      default:
        return [-y, -x] as const;
    }
  });

  let minCol = Number.POSITIVE_INFINITY;
  let minRow = Number.POSITIVE_INFINITY;
  for (const [col, row] of transformed) {
    if (col < minCol) minCol = col;
    if (row < minRow) minRow = row;
  }
  return transformed.map(([col, row]) => [col - minCol, row - minRow] as const);
}
