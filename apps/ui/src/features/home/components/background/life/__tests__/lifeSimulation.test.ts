/**
 * #2915 ST-2 — pure Life domain unit pin.
 *
 * Pins the bounded curated catalogue (exactly `LIFE_PATTERN_COUNT` named Life
 * Lexicon patterns), the deterministic seeded PRNG, the 8 dihedral orientation
 * transform, B3/S23 correctness (blinker period-2, block still, glider
 * translation), simulation determinism, the initial density band and the
 * re-seed policy (generation cap + stagnation).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  LIFE_DENSITY_MAX,
  LIFE_DENSITY_MIN,
  LIFE_PATTERN_COUNT,
  LIFE_RESEED_GENERATIONS,
  LIFE_STAGNATION_GENERATIONS,
} from '../lifeConstants';
import { LIFE_PATTERNS, createLifeRng, orientPattern } from '../lifePatterns';
import { createLifeSimulation, shouldReseedLife, stepLifeGrid } from '../lifeSimulation';

/** Render an ASCII Life grid through `generations` B3/S23 steps. */
function evolve(rows: readonly string[], generations: number): string[] {
  const cols = rows[0].length;
  const height = rows.length;
  let front = new Uint8Array(cols * height);
  let back = new Uint8Array(cols * height);
  rows.forEach((line, row) => {
    for (let col = 0; col < cols; col++) {
      if (line[col] === 'O') front[row * cols + col] = 1;
    }
  });
  for (let generation = 0; generation < generations; generation++) {
    stepLifeGrid(cols, height, front, back);
    const previous = front;
    front = back;
    back = previous;
  }
  const out: string[] = [];
  for (let row = 0; row < height; row++) {
    let line = '';
    for (let col = 0; col < cols; col++) line += front[row * cols + col] === 1 ? 'O' : '.';
    out.push(line);
  }
  return out;
}

describe('#2915 ST-2 — bounded curated catalogue', () => {
  it('holds exactly LIFE_PATTERN_COUNT (10) named patterns', () => {
    expect(LIFE_PATTERN_COUNT).toBe(10);
    expect(LIFE_PATTERNS).toHaveLength(LIFE_PATTERN_COUNT);
    expect(new Set(LIFE_PATTERNS.map((pattern) => pattern.name)).size).toBe(LIFE_PATTERN_COUNT);
  });

  it('ships the ten required Life Lexicon names', () => {
    expect(LIFE_PATTERNS.map((pattern) => pattern.name)).toEqual([
      'glider',
      'LWSS',
      'blinker',
      'toad',
      'block',
      'beehive',
      'pulsar',
      'acorn',
      'R-pentomino',
      'Gosper glider gun',
    ]);
  });

  it('keeps every pattern inside its declared bounding box with unique offsets', () => {
    for (const pattern of LIFE_PATTERNS) {
      expect(pattern.width, `${pattern.name}: width`).toBeGreaterThan(0);
      expect(pattern.height, `${pattern.name}: height`).toBeGreaterThan(0);
      expect(pattern.cells.length, `${pattern.name}: cells`).toBeGreaterThan(0);
      const seen = new Set<string>();
      for (const [col, row] of pattern.cells) {
        expect(col, `${pattern.name}: col >= 0`).toBeGreaterThanOrEqual(0);
        expect(row, `${pattern.name}: row >= 0`).toBeGreaterThanOrEqual(0);
        expect(col, `${pattern.name}: col < width`).toBeLessThan(pattern.width);
        expect(row, `${pattern.name}: row < height`).toBeLessThan(pattern.height);
        const key = `${col},${row}`;
        expect(seen.has(key), `${pattern.name}: duplicate ${key}`).toBe(false);
        seen.add(key);
      }
    }
  });
});

describe('#2915 ST-2 — deterministic seeded PRNG', () => {
  it('produces the SAME sequence for the same seed', () => {
    const first = createLifeRng(123456);
    const second = createLifeRng(123456);
    const firstRun = Array.from({ length: 16 }, () => first());
    const secondRun = Array.from({ length: 16 }, () => second());
    expect(firstRun).toEqual(secondRun);
  });

  it('produces a different sequence for a different seed', () => {
    const first = Array.from({ length: 16 }, createLifeRng(1));
    const second = Array.from({ length: 16 }, createLifeRng(2));
    expect(first).not.toEqual(second);
  });

  it('emits floats in [0, 1)', () => {
    const rng = createLifeRng(987654321);
    for (let index = 0; index < 256; index++) {
      const value = rng();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe('#2915 ST-2 — 8 dihedral orientations', () => {
  const glider = LIFE_PATTERNS.find((pattern) => pattern.name === 'glider');

  it('preserves the cell count for all eight orientations', () => {
    expect(glider).toBeDefined();
    const base = glider?.cells.length ?? 0;
    for (let orientation = 0; orientation < 8; orientation++) {
      const cells = orientPattern(glider!, orientation);
      expect(cells.length, `orientation ${orientation}`).toBe(base);
    }
  });

  it('normalises every orientation back to the origin', () => {
    for (const pattern of LIFE_PATTERNS) {
      for (let orientation = 0; orientation < 8; orientation++) {
        const cells = orientPattern(pattern, orientation);
        const minCol = Math.min(...cells.map(([col]) => col));
        const minRow = Math.min(...cells.map(([, row]) => row));
        expect(minCol, `${pattern.name}/${orientation}: min col`).toBe(0);
        expect(minRow, `${pattern.name}/${orientation}: min row`).toBe(0);
      }
    }
  });

  it('wraps orientation modulo 8', () => {
    expect(orientPattern(glider!, 8)).toEqual(orientPattern(glider!, 0));
    expect(orientPattern(glider!, -1)).toEqual(orientPattern(glider!, 7));
  });
});

describe('#2915 ST-2 — B3/S23 correctness', () => {
  it('a blinker oscillates with period 2', () => {
    const start = [
      '.....',
      '.....',
      '.OOO.',
      '.....',
      '.....',
    ];
    const vertical = [
      '.....',
      '..O..',
      '..O..',
      '..O..',
      '.....',
    ];
    expect(evolve(start, 1)).toEqual(vertical);
    expect(evolve(start, 2)).toEqual(start);
    expect(evolve(start, 4)).toEqual(start);
  });

  it('a block is a stable still life', () => {
    const block = [
      '....',
      '.OO.',
      '.OO.',
      '....',
    ];
    expect(evolve(block, 1)).toEqual(block);
    expect(evolve(block, 7)).toEqual(block);
  });

  it('a glider translates by (1,1) every four generations', () => {
    const glider = [
      '.O.......',
      '..O......',
      'OOO......',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
    ];
    const shifted = [
      '.........',
      '..O......',
      '...O.....',
      '.OOO.....',
      '.........',
      '.........',
      '.........',
      '.........',
      '.........',
    ];
    expect(evolve(glider, 4)).toEqual(shifted);
  });
});

describe('#2915 ST-2 — createLifeSimulation', () => {
  it('is deterministic: the same seed reproduces the same grid', () => {
    const first = createLifeSimulation({ cols: 24, rows: 16, seed: 4242 });
    const second = createLifeSimulation({ cols: 24, rows: 16, seed: 4242 });
    expect(Array.from(first.snapshot())).toEqual(Array.from(second.snapshot()));
    expect(first.population).toBe(second.population);
    expect(first.generation).toBe(0);
  });

  it('stays deterministic after stepping', () => {
    const first = createLifeSimulation({ cols: 24, rows: 16, seed: 99 });
    const second = createLifeSimulation({ cols: 24, rows: 16, seed: 99 });
    for (let step = 0; step < 12; step++) {
      first.step();
      second.step();
    }
    expect(Array.from(first.snapshot())).toEqual(Array.from(second.snapshot()));
    expect(first.population).toBe(second.population);
    expect(first.generation).toBe(12);
  });

  it('seeds an initial density inside the authored band (never empty or saturated)', () => {
    for (const seed of [1, 7, 42, 2024, 999999]) {
      const grid = createLifeSimulation({ cols: 160, rows: 100, seed });
      const density = grid.population / (grid.cols * grid.rows);
      expect(density, `seed ${seed}: floor`).toBeGreaterThanOrEqual(LIFE_DENSITY_MIN);
      expect(density, `seed ${seed}: ceiling`).toBeLessThanOrEqual(LIFE_DENSITY_MAX);
      expect(grid.population).toBeGreaterThan(0);
      expect(grid.population).toBeLessThan(grid.cols * grid.rows);
    }
  });

  it('step() advances one generation and is a no-op to the grid identity size', () => {
    const grid = createLifeSimulation({ cols: 20, rows: 20, seed: 3 });
    const before = grid.snapshot();
    grid.step();
    expect(grid.generation).toBe(1);
    expect(grid.snapshot().length).toBe(before.length);
  });

  it('reseed re-randomizes on the same grid and resets the generation counter', () => {
    const grid = createLifeSimulation({ cols: 32, rows: 24, seed: 11 });
    for (let step = 0; step < 5; step++) grid.step();
    const before = Array.from(grid.snapshot());
    grid.reseed(12);
    expect(grid.generation).toBe(0);
    expect(grid.cols).toBe(32);
    expect(grid.rows).toBe(24);
    expect(Array.from(grid.snapshot())).not.toEqual(before);
  });

  it('fires the re-seed policy at the authored generation cap', () => {
    const grid = createLifeSimulation({ cols: 32, rows: 24, seed: 7 });
    expect(grid.shouldReseed()).toBe(false);
    for (let step = 0; step < LIFE_RESEED_GENERATIONS; step++) grid.step();
    expect(grid.generation).toBe(LIFE_RESEED_GENERATIONS);
    expect(grid.shouldReseed()).toBe(true);
    grid.reseed(8);
    expect(grid.shouldReseed()).toBe(false);
  });
});

describe('#2915 ST-2 — re-seed policy (pure)', () => {
  it('fires on the generation cap', () => {
    expect(
      shouldReseedLife({
        generation: LIFE_RESEED_GENERATIONS,
        unchangedGenerations: 0,
        population: 1000,
        cols: 100,
        rows: 100,
      }),
    ).toBe(true);
  });

  it('fires on stagnation: unchanged for N generations at/below the floor', () => {
    expect(
      shouldReseedLife({
        generation: 10,
        unchangedGenerations: LIFE_STAGNATION_GENERATIONS,
        population: 100,
        cols: 100,
        rows: 100,
      }),
    ).toBe(true);
  });

  it('does not fire while the population keeps changing or stays dense', () => {
    expect(
      shouldReseedLife({
        generation: 10,
        unchangedGenerations: LIFE_STAGNATION_GENERATIONS - 1,
        population: 100,
        cols: 100,
        rows: 100,
      }),
    ).toBe(false);
    expect(
      shouldReseedLife({
        generation: 10,
        unchangedGenerations: LIFE_STAGNATION_GENERATIONS,
        population: 1000,
        cols: 100,
        rows: 100,
      }),
    ).toBe(false);
  });
});

describe('#2925 ST-4 — the dim is paint-only (simulation slice untouched)', () => {
  it('keeps the pure simulation/pattern code free of theme, canvas and frame-loop coupling', () => {
    const PURE_PATHS = [
      'src/features/home/components/background/life/lifeSimulation.ts',
      'src/features/home/components/background/life/lifePatterns.ts',
    ];
    for (const path of PURE_PATHS) {
      const code = readFileSync(resolve(process.cwd(), path), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
      expect(code, `${path}: theme token`).not.toMatch(/--life-/);
      expect(code, `${path}: computed style`).not.toMatch(/getComputedStyle/);
      expect(code, `${path}: canvas 2D`).not.toMatch(/getContext/);
      expect(code, `${path}: frame loop`).not.toMatch(/requestAnimationFrame/);
    }
  });
});
